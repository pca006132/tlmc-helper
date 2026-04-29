use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tlmc::logger::Logger;

fn main() {
    let exec_dir = match std::env::current_dir() {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut logger = match Logger::new(&exec_dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    let result = run_analyze_albums(&exec_dir, &mut logger);
    if let Err(err) = result {
        let _ = logger.error(&format!("fatal: {err}"));
    }
}

fn run_analyze_albums(exec_dir: &Path, logger: &mut Logger) -> Result<(), String> {
    let metadata = read_metadata(exec_dir.join("metadata.json"))?;
    let structured_path = exec_dir.join("structured.json");
    let rewriting_path = exec_dir.join("rewriting.json");
    let structured_data = load_or_build_structured(exec_dir, &structured_path, &metadata, logger)?;
    let rewriting_existing = read_rewriting_if_exists(&rewriting_path)?;
    let rewriting_data = build_rewriting_from_structured(
        &structured_data,
        rewriting_existing.as_ref(),
        rewriting_existing.is_some(),
    );
    let rewriting_json =
        serde_json::to_string_pretty(&rewriting_data).map_err(|e| e.to_string())?;
    fs::write(&rewriting_path, rewriting_json).map_err(|e| e.to_string())?;
    validate_rewrite_chains(&rewriting_data, logger)?;
    let mut updated_metadata = metadata.clone();
    let all_rewriting = rewriting_data.get("$all");

    for (track_path, orig) in &metadata {
        let (circle, _) = parse_track_path(track_path)?;
        let Some(circle_cfg) = rewriting_data.get(&circle) else {
            continue;
        };
        let artist_rules = chain_rules_with_global(
            &circle_cfg.artists_rewriting,
            all_rewriting.map(|v| &v.artists_rewriting),
        );
        let album_artist_rules = chain_rules_with_global(
            &circle_cfg.album_artists_rewriting,
            all_rewriting.map(|v| &v.album_artists_rewriting),
        );
        let genre_rules = chain_rules_with_global(
            &circle_cfg.genre_rewriting,
            all_rewriting.map(|v| &v.genre_rewriting),
        );
        let artists = rewrite_names(get_list(orig, "Artists"), &artist_rules);
        let album_artists = rewrite_names(get_list(orig, "Album artists"), &album_artist_rules);
        let genre = rewrite_genre(
            get_s(orig, "Genre"),
            &genre_rules,
            circle_cfg
                .default_genre
                .clone()
                .or_else(|| all_rewriting.and_then(|v| v.default_genre.clone())),
        );
        let mut patch = Map::new();
        if artists != get_list(orig, "Artists") {
            patch.insert(
                "Artists".to_string(),
                Value::Array(artists.into_iter().map(Value::String).collect()),
            );
        }
        if album_artists != get_list(orig, "Album artists") {
            patch.insert(
                "Album artists".to_string(),
                Value::Array(album_artists.into_iter().map(Value::String).collect()),
            );
        }
        if genre != get_s(orig, "Genre")
            && let Some(g) = genre
        {
            patch.insert("Genre".to_string(), Value::String(g));
        }
        if !patch.is_empty()
            && let Some(entry) = updated_metadata.get_mut(track_path)
        {
            for (k, v) in &patch {
                entry.insert(k.clone(), v.clone());
            }
        }
    }
    let (mut structured_new, _) = build_structured_from_metadata(updated_metadata)?;
    overlay_track_data_from_old(&mut structured_new, &structured_data);
    apply_rewrites_to_structured_new(&mut structured_new, &rewriting_data);

    // Final update output should compare desired metadata from structured-new
    // against original metadata.json, so manual track edits in structured data are included.
    let desired = materialize_metadata_from_structured(&structured_new);
    let mut updates = Map::new();
    for (track_path, desired_fields) in desired {
        let Some(orig_fields) = metadata.get(&track_path) else {
            continue;
        };
        let patch = diff_track_metadata(orig_fields, &desired_fields);
        if !patch.is_empty() {
            updates.insert(track_path, Value::Object(patch));
        }
    }
    let update_json =
        serde_json::to_string_pretty(&Value::Object(updates)).map_err(|e| e.to_string())?;
    fs::write(exec_dir.join("update-metadata.json"), update_json).map_err(|e| e.to_string())
}

fn load_or_build_structured(
    exec_dir: &Path,
    structured_path: &Path,
    metadata: &BTreeMap<String, Map<String, Value>>,
    logger: &mut Logger,
) -> Result<BTreeMap<String, CircleStructured>, String> {
    if structured_path.exists() {
        return serde_json::from_str(
            &fs::read_to_string(structured_path).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string());
    }

    let (structured, audits) = build_structured_from_metadata(metadata.clone())?;
    for p in audits.disc_classification {
        logger.append_audit("disc_classification", &p)?;
    }
    for p in audits.different_album_artist {
        logger.append_audit("different_album_artist", &p)?;
    }
    for p in audits.missing_info {
        logger.append_audit("missing_info", &p)?;
    }
    let json = serde_json::to_string_pretty(&structured).map_err(|e| e.to_string())?;
    fs::write(exec_dir.join("structured.json"), json).map_err(|e| e.to_string())?;
    Ok(structured)
}

fn validate_rewrite_chains(
    rewriting: &BTreeMap<String, CircleRewriting>,
    logger: &mut Logger,
) -> Result<(), String> {
    for (circle, data) in rewriting {
        check_rule_chain(circle, "artists_rewriting", &data.artists_rewriting, logger)?;
        check_rule_chain(
            circle,
            "album_artists_rewriting",
            &data.album_artists_rewriting,
            logger,
        )?;
        check_rule_chain(circle, "genre_rewriting", &data.genre_rewriting, logger)?;
    }
    Ok(())
}

fn check_rule_chain(
    circle: &str,
    rule_set: &str,
    rules: &[RewriteRule],
    logger: &mut Logger,
) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for (i, r1) in rules.iter().enumerate() {
        for (j, r2) in rules.iter().enumerate() {
            if i == j {
                continue;
            }
            let overlaps = r1
                .to
                .iter()
                .filter(|v| r2.from.iter().any(|f| f == *v))
                // Exemption: output explicitly keeps one of its own inputs.
                .filter(|v| !r1.from.iter().any(|f| f == *v))
                .collect::<Vec<_>>();
            if !overlaps.is_empty() {
                let left = serde_json::to_string(r1).map_err(|e| e.to_string())?;
                let right = serde_json::to_string(r2).map_err(|e| e.to_string())?;
                let line = format!("circle={circle} set={rule_set} rule_a={left} rule_b={right}");
                if seen.insert(line.clone()) {
                    logger.append_audit("rewrite_chain_warning", &line)?;
                }
            }
        }
    }
    Ok(())
}

fn build_structured_from_metadata(
    metadata: BTreeMap<String, Map<String, Value>>,
) -> Result<(BTreeMap<String, CircleStructured>, AnalysisAudits), String> {
    let mut circles: BTreeMap<String, CircleData> = BTreeMap::new();
    let mut disc_classification = BTreeSet::new();
    let mut diff_album_artist = BTreeSet::new();
    let mut missing_info = BTreeSet::new();

    for (track_path, fields) in metadata {
        let (circle, album) = parse_track_path(&track_path)?;
        let circle_data = circles.entry(circle.clone()).or_default();
        let album_data = circle_data.albums.entry(album.clone()).or_default();
        album_data.tracks.push(TrackLite {
            path: track_path.clone(),
            title: get_s(&fields, "Title"),
            date: get_s(&fields, "Date").or_else(|| get_s(&fields, "Year")),
            disc_subtitle: get_s(&fields, "Disc subtitle"),
            track_number: get_n(&fields, "Track number"),
            artists: get_list(&fields, "Artists"),
            album_artists: get_list(&fields, "Album artists"),
            album_title: get_s(&fields, "Album title"),
            disc_number: get_n(&fields, "Disc number"),
            genre: get_s(&fields, "Genre"),
        });
    }

    let mut structured: BTreeMap<String, CircleStructured> = BTreeMap::new();
    for (circle_name, circle_data) in circles {
        let mut out_circle = CircleStructured::default();

        for (album_folder_name, album_data) in circle_data.albums {
            let album_path = format!("{circle_name}/{album_folder_name}");
            let mut album_name = derive_album_name_for_output(&album_folder_name);
            let (discs, used_rule3) = classify_discs(&album_data.tracks);
            if used_rule3 {
                disc_classification.insert(album_path.clone());
            }
            if discs.len() == 1 {
                let tagged_album_titles = album_data
                    .tracks
                    .iter()
                    .filter_map(|t| t.album_title.clone())
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect::<BTreeSet<_>>();
                if tagged_album_titles.len() == 1 {
                    let tagged = tagged_album_titles
                        .iter()
                        .next()
                        .cloned()
                        .unwrap_or_default();
                    if !tagged.is_empty() && tagged != album_name {
                        album_name = tagged;
                    }
                }
            }

            let mut album_artist_sets = HashSet::new();
            let mut album_album_artists = BTreeSet::new();
            let mut album_out = AlbumStructured::default();
            let disc_count = discs.len();
            for disc in discs {
                let explicit_disc_subtitle = derive_explicit_disc_subtitle_in_disc(&disc);
                let derived_disc_subtitle = if explicit_disc_subtitle.is_none() && disc_count > 1 {
                    derive_disc_subtitle_from_album_title_in_disc(&disc)
                } else {
                    None
                };
                let mut disc_tracks = BTreeMap::new();
                for t in disc {
                    if t.artists.is_empty() {
                        missing_info.insert(album_path.clone());
                    }
                    let aa_pre = aggregate_names_for_track(&t.album_artists);
                    let a_pre = aggregate_names_for_track(&t.artists);
                    let aa = aa_pre.names;
                    let a = a_pre.names;
                    for x in &aa {
                        album_album_artists.insert(x.clone());
                    }
                    album_artist_sets.insert(aa.join("|"));
                    disc_tracks.insert(
                        t.path.clone(),
                        TrackStructured {
                            title: t.title.clone().unwrap_or_default(),
                            date: t.date.clone().unwrap_or_default(),
                            track_number: t.track_number.unwrap_or(0),
                            artists: a,
                            genre: t.genre.clone().unwrap_or_default(),
                        },
                    );
                }
                let disc_subtitle = if explicit_disc_subtitle.is_some() {
                    explicit_disc_subtitle
                } else if disc_count > 1 {
                    derived_disc_subtitle
                } else {
                    None
                };
                album_out.discs.push(DiscStructured {
                    subtitle: disc_subtitle,
                    tracks: disc_tracks,
                });
            }
            album_out.album_artists = album_album_artists.into_iter().collect();
            if album_artist_sets.len() > 1
                || (album_out.album_artists.iter().all(|x| x != &circle_name)
                    && !album_out.album_artists.is_empty())
            {
                diff_album_artist.insert(album_path.clone());
            }
            let mut final_album_name = album_name.clone();
            if out_circle.albums.contains_key(&final_album_name) {
                final_album_name = format!("{album_name} ({album_folder_name})");
            }
            out_circle.albums.insert(final_album_name, album_out);
        }
        structured.insert(circle_name, out_circle);
    }

    Ok((
        structured,
        AnalysisAudits {
            disc_classification,
            different_album_artist: diff_album_artist,
            missing_info,
        },
    ))
}

fn classify_discs(tracks: &[TrackLite]) -> (Vec<Vec<TrackLite>>, bool) {
    let mut by_disc: BTreeMap<u64, Vec<TrackLite>> = BTreeMap::new();
    let mut remaining = Vec::new();
    let mut titles: HashSet<String> = HashSet::new();
    let mut all_no_disc = true;
    for t in tracks {
        if let Some(title) = &t.album_title {
            titles.insert(title.clone());
        }
        if let Some(d) = t.disc_number {
            all_no_disc = false;
            by_disc.entry(d).or_default().push(t.clone());
        } else {
            remaining.push(t.clone());
        }
    }
    if titles.len() == 1 && all_no_disc {
        return (vec![tracks.to_vec()], false);
    }
    let mut used_rule3 = false;
    if !remaining.is_empty() {
        used_rule3 = true;
        let mut next = by_disc.keys().max().copied().unwrap_or(0) + 1;
        let mut by_title: BTreeMap<String, Vec<TrackLite>> = BTreeMap::new();
        for t in remaining {
            by_title
                .entry(
                    t.album_title
                        .clone()
                        .unwrap_or_else(|| "__missing__".to_string()),
                )
                .or_default()
                .push(t);
        }
        for (_, group) in by_title {
            by_disc.insert(next, group);
            next += 1;
        }
    }
    (by_disc.into_values().collect(), used_rule3)
}

fn rewrite_names(input: Vec<String>, rules: &[RewriteRule]) -> Vec<String> {
    if input.is_empty() {
        return input;
    }
    let mut out = Vec::new();
    for name in input {
        let mut replaced = false;
        for r in rules {
            if r.from.iter().any(|f| f == &name) {
                out.extend(r.to.clone());
                replaced = true;
                break;
            }
        }
        if !replaced {
            out.push(name);
        }
    }
    dedup_preserve(out)
}

fn rewrite_genre(
    input: Option<String>,
    rules: &[RewriteRule],
    default_genre: Option<String>,
) -> Option<String> {
    let value = input.or(default_genre)?;
    for r in rules {
        if r.from.iter().any(|f| f == &value) {
            return r.to.first().cloned();
        }
    }
    Some(value)
}

fn aggregate_names_for_track(values: &[String]) -> NameAggregation {
    if values.len() == 1 {
        let split = dedup_preserve(
            split_candidates(&values[0])
                .into_iter()
                .map(|v| trim_leading_vo(&v).to_string())
                .filter(|v| !v.is_empty())
                .collect(),
        );
        let mut split_rules = Vec::new();
        let source = values[0].trim().to_string();
        if !source.is_empty() && split != vec![source.clone()] {
            split_rules.push(RewriteRule {
                from: vec![source],
                to: split.clone(),
            });
        }
        return NameAggregation {
            names: split,
            split_rules: dedup_rewrite_rules(split_rules),
        };
    }
    NameAggregation {
        names: dedup_preserve(
            values
                .iter()
                .map(|v| v.trim().to_string())
                .map(|v| trim_leading_vo(&v).to_string())
                .filter(|v| !v.is_empty())
                .collect(),
        ),
        split_rules: Vec::new(),
    }
}

fn build_normalize_rules(values: &[String], counts: &BTreeMap<String, u64>) -> Vec<RewriteRule> {
    let mut by_norm: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for v in values {
        by_norm
            .entry(normalize_name(v))
            .or_default()
            .insert(v.trim().to_string());
    }
    let mut out = Vec::new();
    for (_, set) in by_norm {
        if set.len() <= 1 {
            continue;
        }
        let mut variants = set.into_iter().collect::<Vec<_>>();
        variants.sort();
        let target = variants
            .iter()
            .max_by(|a, b| {
                let ac = counts.get(*a).copied().unwrap_or(0);
                let bc = counts.get(*b).copied().unwrap_or(0);
                ac.cmp(&bc).then_with(|| b.cmp(a))
            })
            .cloned()
            .unwrap_or_default();
        let from = variants
            .into_iter()
            .filter(|v| v != &target)
            .collect::<Vec<_>>();
        if from.is_empty() {
            continue;
        }
        let to = vec![target];
        out.push(RewriteRule { from, to });
    }
    out
}

fn build_low_confidence_parenthetical_rules(values: &[String]) -> Vec<RewriteRule> {
    let mut out = Vec::new();
    for value in values {
        let source = value.trim();
        if source.is_empty() {
            continue;
        }
        if let Some(cv_artist) = extract_cv_artist_from_parenthetical(source)
            && cv_artist != source
        {
            out.push(RewriteRule {
                from: vec![source.to_string()],
                to: vec![cv_artist],
            });
            continue;
        }
        if let Some(base_name) = strip_trailing_parenthetical(source)
            && base_name != source
        {
            out.push(RewriteRule {
                from: vec![source.to_string()],
                to: vec![base_name],
            });
        }
    }
    out
}

fn strip_trailing_parenthetical(input: &str) -> Option<String> {
    let (base, inside) = split_parenthetical_suffix(input)?;
    if base.is_empty() || inside.is_empty() {
        return None;
    }
    Some(base.to_string())
}

fn extract_cv_artist_from_parenthetical(input: &str) -> Option<String> {
    let (_base, inside) = split_parenthetical_suffix(input)?;
    let inside_folded = fold_fullwidth_ascii(inside);
    let inside_trimmed = inside_folded.trim();
    let inside_lower = inside_trimmed.to_ascii_lowercase();
    let rest = if let Some(v) = inside_trimmed.strip_prefix("CV:") {
        v
    } else {
        let idx = inside_lower.find("cv:")?;
        if idx != 0 {
            return None;
        }
        inside_trimmed.get(3..)?
    };
    let artist = rest.trim();
    if artist.is_empty() {
        return None;
    }
    Some(artist.to_string())
}

fn split_parenthetical_suffix(input: &str) -> Option<(&str, &str)> {
    let s = input.trim();
    if !(s.ends_with(')') || s.ends_with('）')) {
        return None;
    }
    let (open_ch, close_ch) = if s.ends_with(')') {
        ('(', ')')
    } else {
        ('（', '）')
    };
    let close_idx = s.char_indices().last()?.0;
    let mut depth = 0_i32;
    let mut open_idx = None;
    for (idx, ch) in s.char_indices().rev() {
        if ch == close_ch {
            depth += 1;
        } else if ch == open_ch {
            depth -= 1;
            if depth == 0 {
                open_idx = Some(idx);
                break;
            }
        }
    }
    let open_idx = open_idx?;
    if open_idx >= close_idx {
        return None;
    }
    let base = s[..open_idx].trim();
    let inside_start = open_idx + open_ch.len_utf8();
    let inside = s[inside_start..close_idx].trim();
    if base.is_empty() || inside.is_empty() {
        return None;
    }
    Some((base, inside))
}

fn split_candidates(value: &str) -> Vec<String> {
    let separators = normal_split_separators();
    let mut chunks = vec![value.to_string()];
    loop {
        let mut changed = false;
        for sep in separators.iter().copied() {
            let mut next = Vec::new();
            for c in chunks {
                let parts = split_outside_parens_many(&c, &[sep]);
                if parts.len() > 1 {
                    changed = true;
                }
                next.extend(parts);
            }
            chunks = next;
        }
        if !changed {
            break;
        }
    }
    chunks
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect()
}

fn trim_leading_vo(input: &str) -> &str {
    let s = input.trim();
    if s.get(..3)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("vo."))
    {
        s.get(3..).unwrap_or("").trim_start()
    } else {
        s
    }
}

fn materialize_metadata_from_structured(
    structured: &BTreeMap<String, CircleStructured>,
) -> BTreeMap<String, Map<String, Value>> {
    let mut out = BTreeMap::new();
    for circle_data in structured.values() {
        for (album_title, album_data) in &circle_data.albums {
            let total_discs = album_data.discs.len() as u64;
            for (disc_idx, disc) in album_data.discs.iter().enumerate() {
                let disc_no = (disc_idx as u64) + 1;
                for (track_path, track) in &disc.tracks {
                    let mut m = Map::new();
                    m.insert("Title".to_string(), Value::String(track.title.clone()));
                    m.insert("Date".to_string(), Value::String(track.date.clone()));
                    if let Some(subtitle) = &disc.subtitle {
                        m.insert("Disc subtitle".to_string(), Value::String(subtitle.clone()));
                    }
                    m.insert(
                        "Track number".to_string(),
                        Value::Number(track.track_number.into()),
                    );
                    m.insert(
                        "Artists".to_string(),
                        Value::Array(track.artists.iter().cloned().map(Value::String).collect()),
                    );
                    m.insert("Genre".to_string(), Value::String(track.genre.clone()));
                    m.insert(
                        "Album title".to_string(),
                        Value::String(album_title.clone()),
                    );
                    m.insert(
                        "Album artists".to_string(),
                        Value::Array(
                            album_data
                                .album_artists
                                .iter()
                                .cloned()
                                .map(Value::String)
                                .collect(),
                        ),
                    );
                    m.insert("Disc number".to_string(), Value::Number(disc_no.into()));
                    m.insert("Total discs".to_string(), Value::Number(total_discs.into()));
                    out.insert(track_path.clone(), m);
                }
            }
        }
    }
    out
}

fn diff_track_metadata(
    orig: &Map<String, Value>,
    desired: &Map<String, Value>,
) -> Map<String, Value> {
    let mut patch = Map::new();
    for (k, desired_v) in desired {
        let changed = match (orig.get(k), desired_v) {
            (Some(Value::String(a)), Value::String(b)) => a != b,
            (Some(Value::Number(a)), Value::Number(b)) => a != b,
            (Some(Value::Array(a)), Value::Array(b)) => a != b,
            (Some(_), _) => true,
            (None, _) => true,
        };
        if changed {
            patch.insert(k.clone(), desired_v.clone());
        }
    }
    // For single-disc targets, never emit disc-number updates.
    if !patch.is_empty() {
        let total_discs_is_one = desired.get("Total discs").and_then(|v| v.as_u64()) == Some(1);
        if total_discs_is_one {
            patch.remove("Disc number");
            patch.remove("Total discs");
        }
    }
    patch
}

fn overlay_track_data_from_old(
    structured_new: &mut BTreeMap<String, CircleStructured>,
    structured_old: &BTreeMap<String, CircleStructured>,
) {
    for (circle_name, old_circle) in structured_old {
        let Some(new_circle) = structured_new.get_mut(circle_name) else {
            continue;
        };
        for (album_name, old_album) in &old_circle.albums {
            let Some(new_album) = new_circle.albums.get_mut(album_name) else {
                continue;
            };
            for old_disc in &old_album.discs {
                for (track_path, old_track) in &old_disc.tracks {
                    for new_disc in &mut new_album.discs {
                        if let Some(new_track) = new_disc.tracks.get_mut(track_path) {
                            *new_track = old_track.clone();
                            if old_disc.subtitle.is_some() {
                                new_disc.subtitle = old_disc.subtitle.clone();
                            }
                            break;
                        }
                    }
                }
            }
        }
    }
}

fn apply_rewrites_to_structured_new(
    structured: &mut BTreeMap<String, CircleStructured>,
    rewriting: &BTreeMap<String, CircleRewriting>,
) {
    let all_rewriting = rewriting.get("$all");
    for (circle_name, circle) in structured {
        let Some(circle_rewriting) = rewriting.get(circle_name) else {
            continue;
        };
        let artist_rules = chain_rules_with_global(
            &circle_rewriting.artists_rewriting,
            all_rewriting.map(|v| &v.artists_rewriting),
        );
        let album_artist_rules = chain_rules_with_global(
            &circle_rewriting.album_artists_rewriting,
            all_rewriting.map(|v| &v.album_artists_rewriting),
        );
        for album in circle.albums.values_mut() {
            album.album_artists = rewrite_names(album.album_artists.clone(), &album_artist_rules);
            for disc in &mut album.discs {
                for track in disc.tracks.values_mut() {
                    track.artists = rewrite_names(track.artists.clone(), &artist_rules);
                }
            }
        }
    }
}

fn count_substring_hits(
    names: &[String],
    track_name_fields: &[(Vec<String>, Vec<String>)],
) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    for name in names {
        let mut count = 0_u64;
        for (artists, album_artists) in track_name_fields {
            let matched = artists
                .iter()
                .chain(album_artists.iter())
                .any(|v| v.contains(name));
            if matched {
                count += 1;
            }
        }
        out.insert(name.clone(), count);
    }
    out
}

fn read_rewriting_if_exists(
    path: &Path,
) -> Result<Option<BTreeMap<String, CircleRewriting>>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let parsed = serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(Some(parsed))
}

fn build_rewriting_from_structured(
    structured: &BTreeMap<String, CircleStructured>,
    existing: Option<&BTreeMap<String, CircleRewriting>>,
    apply_existing_rules: bool,
) -> BTreeMap<String, CircleRewriting> {
    let mut effective_structured = structured.clone();
    if apply_existing_rules && let Some(existing_rules) = existing {
        apply_rewrites_to_structured_new(&mut effective_structured, existing_rules);
    }

    let mut out = BTreeMap::new();
    for (circle, circle_data) in &effective_structured {
        let Some(raw_circle_data) = structured.get(circle) else {
            continue;
        };
        let mut genres = Vec::new();
        let mut normal_split_rules_artists = Vec::new();
        let mut normal_split_rules_album_artists = Vec::new();
        let mut raw_artist_names = Vec::new();
        let mut raw_album_artist_names = Vec::new();
        for album in circle_data.albums.values() {
            for disc in &album.discs {
                for track in disc.tracks.values() {
                    if !track.genre.trim().is_empty() {
                        genres.push(track.genre.clone());
                    }
                }
            }
        }
        for album in raw_circle_data.albums.values() {
            for aa in &album.album_artists {
                raw_album_artist_names.push(aa.clone());
            }
            let aa_aggr = aggregate_names_for_track(&album.album_artists);
            normal_split_rules_album_artists.extend(aa_aggr.split_rules);
            for disc in &album.discs {
                for track in disc.tracks.values() {
                    raw_artist_names.extend(track.artists.iter().cloned());
                    let a_aggr = aggregate_names_for_track(&track.artists);
                    normal_split_rules_artists.extend(a_aggr.split_rules);
                }
            }
        }
        let known_names = known_circle_names(&raw_artist_names, &raw_album_artist_names);
        let (artist_stage1, album_artist_stage1) = (
            generate_split_stage_output(
                &raw_artist_names,
                dedup_rewrite_rules(normal_split_rules_artists),
                &known_names,
                5,
            ),
            generate_split_stage_output(
                &raw_album_artist_names,
                dedup_rewrite_rules(normal_split_rules_album_artists),
                &known_names,
                5,
            ),
        );
        let split_name_counts =
            count_name_occurrences(artist_stage1.1.iter().chain(album_artist_stage1.1.iter()));
        let (generated_artist_rules, generated_album_artist_rules) = (
            generate_compiled_name_rules(
                &raw_artist_names,
                artist_stage1.0,
                &artist_stage1.1,
                &split_name_counts,
                5,
            ),
            generate_compiled_name_rules(
                &raw_album_artist_names,
                album_artist_stage1.0,
                &album_artist_stage1.1,
                &split_name_counts,
                5,
            ),
        );
        let all_genres = dedup_sorted(genres);
        let (final_artist_rules, final_album_artist_rules, final_genre_rules, final_default_genre) =
            if let Some(existing_all) = existing
                && let Some(existing_circle) = existing_all.get(circle)
            {
                (
                    dedup_rewrite_rules(existing_circle.artists_rewriting.clone()),
                    dedup_rewrite_rules(existing_circle.album_artists_rewriting.clone()),
                    dedup_rewrite_rules(existing_circle.genre_rewriting.clone()),
                    existing_circle.default_genre.clone(),
                )
            } else {
                (
                    generated_artist_rules,
                    generated_album_artist_rules,
                    Vec::new(),
                    None,
                )
            };

        // Aggregations in rewriting.json should always reflect rewritten names/counting fields.
        let count_artist_rules = final_artist_rules.clone();
        let count_album_artist_rules = final_album_artist_rules.clone();
        let mut count_track_fields: Vec<(Vec<String>, Vec<String>)> = Vec::new();
        for album in circle_data.albums.values() {
            let album_aa = rewrite_names(album.album_artists.clone(), &count_album_artist_rules);
            for disc in &album.discs {
                for track in disc.tracks.values() {
                    let track_a = rewrite_names(track.artists.clone(), &count_artist_rules);
                    count_track_fields.push((track_a, album_aa.clone()));
                }
            }
        }
        let (rewritten_artist_names, rewritten_album_artist_names) =
            dedup_names_from_circle(circle_data, &count_artist_rules, &count_album_artist_rules);

        let rewriting = CircleRewriting {
            all_album_artists: count_substring_hits(
                &rewritten_album_artist_names,
                &count_track_fields,
            ),
            album_artists_rewriting: final_album_artist_rules,
            all_artists: count_substring_hits(&rewritten_artist_names, &count_track_fields),
            artists_rewriting: final_artist_rules,
            all_genres,
            genre_rewriting: final_genre_rules,
            default_genre: final_default_genre,
        };
        out.insert(circle.clone(), rewriting);
    }
    let all_entry = build_global_rewriting_entry(&effective_structured, &out, existing);
    out.insert("$all".to_string(), all_entry);
    out
}

fn build_global_rewriting_entry(
    structured: &BTreeMap<String, CircleStructured>,
    per_circle: &BTreeMap<String, CircleRewriting>,
    existing: Option<&BTreeMap<String, CircleRewriting>>,
) -> CircleRewriting {
    let existing_all = existing.and_then(|v| v.get("$all"));
    let global_artist_rules = existing_all
        .map(|v| dedup_rewrite_rules(v.artists_rewriting.clone()))
        .unwrap_or_default();
    let global_album_artist_rules = existing_all
        .map(|v| dedup_rewrite_rules(v.album_artists_rewriting.clone()))
        .unwrap_or_default();
    let global_genre_rules = existing_all
        .map(|v| dedup_rewrite_rules(v.genre_rewriting.clone()))
        .unwrap_or_default();
    let global_default_genre = existing_all.and_then(|v| v.default_genre.clone());

    let mut all_genres = Vec::new();
    let mut track_fields: Vec<(Vec<String>, Vec<String>)> = Vec::new();
    let mut rewritten_artist_values = Vec::new();
    let mut rewritten_album_artist_values = Vec::new();

    for (circle_name, circle_data) in structured {
        let Some(circle_rules) = per_circle.get(circle_name) else {
            continue;
        };
        let artist_rules =
            chain_rules_with_global(&circle_rules.artists_rewriting, Some(&global_artist_rules));
        let album_artist_rules = chain_rules_with_global(
            &circle_rules.album_artists_rewriting,
            Some(&global_album_artist_rules),
        );
        let genre_rules =
            chain_rules_with_global(&circle_rules.genre_rewriting, Some(&global_genre_rules));

        for album in circle_data.albums.values() {
            let album_aa = rewrite_names(album.album_artists.clone(), &album_artist_rules);
            rewritten_album_artist_values.extend(album_aa.iter().cloned());
            for disc in &album.discs {
                for track in disc.tracks.values() {
                    let track_a = rewrite_names(track.artists.clone(), &artist_rules);
                    rewritten_artist_values.extend(track_a.iter().cloned());
                    track_fields.push((track_a, album_aa.clone()));
                    let genre = rewrite_genre(
                        Some(track.genre.clone()),
                        &genre_rules,
                        circle_rules
                            .default_genre
                            .clone()
                            .or_else(|| global_default_genre.clone()),
                    );
                    if let Some(g) = genre
                        && !g.trim().is_empty()
                    {
                        all_genres.push(g);
                    }
                }
            }
        }
    }

    let all_artists = dedup_sorted(rewritten_artist_values);
    let all_album_artists = dedup_sorted(rewritten_album_artist_values);
    CircleRewriting {
        all_album_artists: count_substring_hits(&all_album_artists, &track_fields),
        album_artists_rewriting: global_album_artist_rules,
        all_artists: count_substring_hits(&all_artists, &track_fields),
        artists_rewriting: global_artist_rules,
        all_genres: dedup_sorted(all_genres),
        genre_rewriting: global_genre_rules,
        default_genre: global_default_genre,
    }
}

fn generate_split_stage_output(
    raw_names: &[String],
    normal_split_rules: Vec<RewriteRule>,
    known_names: &HashSet<String>,
    max_iter: usize,
) -> (Vec<RewriteRule>, Vec<String>) {
    let split_rules =
        stage1_generate_split_rules(raw_names, normal_split_rules, known_names, max_iter);
    let split_rewritten_names = rewrite_name_values(raw_names, &split_rules);
    (split_rules, split_rewritten_names)
}

fn generate_compiled_name_rules(
    raw_names: &[String],
    split_rules: Vec<RewriteRule>,
    split_rewritten_names: &[String],
    split_name_counts: &BTreeMap<String, u64>,
    max_iter: usize,
) -> Vec<RewriteRule> {
    let normalize_rules = stage2_generate_normalize_rules(split_rewritten_names, split_name_counts);
    stage3_compile_one_pass_rules(normalize_rules, split_rules, raw_names, max_iter)
}

fn stage1_generate_split_rules(
    raw_names: &[String],
    normal_split_rules: Vec<RewriteRule>,
    known_names: &HashSet<String>,
    max_iter: usize,
) -> Vec<RewriteRule> {
    let aggressive_rules = dedup_rewrite_rules(build_aggressive_split_rules(
        raw_names,
        known_names,
        &normal_split_rules,
        max_iter,
    ));
    let merged_split_rules = dedup_rewrite_rules(merge_rules(normal_split_rules, aggressive_rules));
    let scored_split_rules = score_split_rule_confidence(merged_split_rules, known_names);
    order_split_rules_by_confidence(scored_split_rules)
}

fn stage2_generate_normalize_rules(
    split_rewritten_names: &[String],
    split_name_counts: &BTreeMap<String, u64>,
) -> Vec<RewriteRule> {
    let low_confidence_rules = dedup_rewrite_rules(build_low_confidence_parenthetical_rules(
        split_rewritten_names,
    ));
    let high_confidence_rules = dedup_rewrite_rules(build_normalize_rules(
        split_rewritten_names,
        split_name_counts,
    ));
    dedup_rewrite_rules(merge_rules(low_confidence_rules, high_confidence_rules))
}

fn stage3_compile_one_pass_rules(
    normalize_rules: Vec<RewriteRule>,
    split_rules: Vec<RewriteRule>,
    raw_names: &[String],
    max_iter: usize,
) -> Vec<RewriteRule> {
    let compiled = saturate_generated_rules(
        dedup_rewrite_rules(merge_rules(normalize_rules, split_rules)),
        max_iter,
    );
    retain_generated_rules_with_reachable_matches(compiled, raw_names, max_iter)
}

fn merge_rules(primary: Vec<RewriteRule>, secondary: Vec<RewriteRule>) -> Vec<RewriteRule> {
    let mut out = Vec::new();
    for r in primary.into_iter().chain(secondary) {
        if out
            .iter()
            .any(|x: &RewriteRule| x.from == r.from && x.to == r.to)
        {
            continue;
        }
        out.push(r);
    }
    out
}

fn chain_rules_with_global(
    primary: &[RewriteRule],
    global: Option<&Vec<RewriteRule>>,
) -> Vec<RewriteRule> {
    let mut out = primary.to_vec();
    if let Some(global) = global {
        out.extend(global.iter().cloned());
    }
    out
}

fn saturate_generated_rules(rules: Vec<RewriteRule>, max_iter: usize) -> Vec<RewriteRule> {
    let mut out = dedup_rewrite_rules(rules);
    for _ in 0..max_iter {
        let snapshot = out.clone();
        let mut changed = false;
        for rule in &mut out {
            let mut current = rule.to.clone();
            let mut seen = HashSet::new();
            seen.insert(current.clone());
            for _ in 0..max_iter {
                let next = rewrite_tokens_and_split(current.clone(), &snapshot);
                if next == current || !seen.insert(next.clone()) {
                    break;
                }
                current = next;
            }
            if current != rule.to {
                rule.to = current;
                changed = true;
            }
        }
        out = dedup_rewrite_rules(out);
        if !changed {
            break;
        }
    }
    out
}

fn rewrite_tokens_and_split(input: Vec<String>, rules: &[RewriteRule]) -> Vec<String> {
    let mut out = Vec::new();
    for name in input {
        for token in split_candidates(&name) {
            let mut replaced = false;
            for r in rules {
                if r.from.iter().any(|f| f == &token) {
                    out.extend(r.to.clone());
                    replaced = true;
                    break;
                }
            }
            if !replaced {
                out.push(token);
            }
        }
    }
    dedup_preserve(out)
}

fn count_name_occurrences<'a>(values: impl Iterator<Item = &'a String>) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    for v in values {
        let key = v.trim();
        if key.is_empty() {
            continue;
        }
        *out.entry(key.to_string()).or_insert(0) += 1;
    }
    out
}

fn known_circle_names(artists: &[String], album_artists: &[String]) -> HashSet<String> {
    artists
        .iter()
        .chain(album_artists.iter())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect()
}

fn score_split_rule_confidence(
    rules: Vec<RewriteRule>,
    known_names: &HashSet<String>,
) -> Vec<ScoredRewriteRule> {
    let known_norm = known_names
        .iter()
        .map(|v| normalize_name(v))
        .collect::<HashSet<_>>();
    rules
        .into_iter()
        .map(|rule| {
            let from_norm = rule
                .from
                .iter()
                .map(|v| normalize_name(v))
                .collect::<HashSet<_>>();
            let confident = rule.to.iter().any(|to| {
                let to_norm = normalize_name(to);
                known_norm.contains(&to_norm) && !from_norm.contains(&to_norm)
            });
            ScoredRewriteRule { rule, confident }
        })
        .collect()
}

fn order_split_rules_by_confidence(scored_rules: Vec<ScoredRewriteRule>) -> Vec<RewriteRule> {
    let mut scored_rules = scored_rules;
    // Less confident rules first for easier manual review.
    scored_rules.sort_by_key(|r| r.confident);
    scored_rules.into_iter().map(|r| r.rule).collect()
}

fn build_aggressive_split_rules(
    values: &[String],
    known: &HashSet<String>,
    normal_rules: &[RewriteRule],
    max_iter: usize,
) -> Vec<RewriteRule> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let known_norm = known
        .iter()
        .map(|v| normalize_name(v))
        .collect::<HashSet<_>>();
    let mut queue = values
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    while let Some(current) = queue.pop() {
        if !seen.insert(current.clone()) {
            continue;
        }
        let parts_with_normal_split =
            exhaustive_aggressive_split_with_normal_rules(&current, normal_rules, max_iter);
        if parts_with_normal_split.len() <= 1 {
            continue;
        }
        let current_norm = normalize_name(&current);
        if parts_with_normal_split.iter().any(|p| {
            let p_norm = normalize_name(p);
            p_norm != current_norm && known_norm.contains(&p_norm)
        }) {
            out.push(RewriteRule {
                from: vec![current.clone()],
                to: dedup_preserve(parts_with_normal_split.clone()),
            });
        }
        for p in parts_with_normal_split {
            if contains_aggressive_separator(&p) && !seen.contains(&p) {
                queue.push(p);
            }
        }
    }
    out
}

fn exhaustive_aggressive_split_with_normal_rules(
    input: &str,
    normal_rules: &[RewriteRule],
    max_iter: usize,
) -> Vec<String> {
    let mut current = vec![input.trim().to_string()];
    let mut seen = HashSet::new();
    seen.insert(current.clone());
    for _ in 0..max_iter {
        let mut next = Vec::new();
        for part in current {
            let aggressive = split_outside_parens_many(&part, aggressive_symbol_separators());
            for token in aggressive {
                next.extend(rewrite_tokens_and_split(vec![token], normal_rules));
            }
        }
        let next = dedup_preserve(next);
        if next.len() <= 1 || !seen.insert(next.clone()) {
            return next;
        }
        current = next;
    }
    current
}

fn dedup_names_from_circle(
    circle_data: &CircleStructured,
    artist_rules: &[RewriteRule],
    album_artist_rules: &[RewriteRule],
) -> (Vec<String>, Vec<String>) {
    let mut artist_names = Vec::new();
    let mut album_artist_names = Vec::new();
    for album in circle_data.albums.values() {
        let album_aa = rewrite_names(album.album_artists.clone(), album_artist_rules);
        for disc in &album.discs {
            for track in disc.tracks.values() {
                let track_a = rewrite_names(track.artists.clone(), artist_rules);
                artist_names.extend(track_a);
                album_artist_names.extend(album_aa.iter().cloned());
            }
        }
    }
    (dedup_sorted(artist_names), dedup_sorted(album_artist_names))
}

fn derive_explicit_disc_subtitle_in_disc(disc_tracks: &[TrackLite]) -> Option<String> {
    let subtitles = disc_tracks
        .iter()
        .filter_map(|track| track.disc_subtitle.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .collect::<BTreeSet<_>>();
    if subtitles.len() == 1 {
        subtitles.into_iter().next()
    } else {
        None
    }
}

fn derive_disc_subtitle_from_album_title_in_disc(disc_tracks: &[TrackLite]) -> Option<String> {
    disc_tracks
        .iter()
        .filter_map(|track| {
            let candidate = track.album_title.as_deref()?.trim();
            if candidate.is_empty() {
                return None;
            }
            Some((
                track.track_number.unwrap_or(u64::MAX),
                track.path.as_str(),
                candidate.to_string(),
            ))
        })
        .min_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)))
        .map(|(_, _, subtitle)| subtitle)
}

fn rewrite_name_values(values: &[String], rules: &[RewriteRule]) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        out.extend(rewrite_names(vec![value.clone()], rules));
    }
    dedup_sorted(out)
}

fn retain_generated_rules_with_reachable_matches(
    rules: Vec<RewriteRule>,
    values: &[String],
    max_iter: usize,
) -> Vec<RewriteRule> {
    let mut reachable = values
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect::<HashSet<_>>();
    let mut frontier = reachable.iter().cloned().collect::<Vec<_>>();
    for _ in 0..max_iter {
        let mut next_frontier = Vec::new();
        for name in frontier {
            let rewritten = rewrite_tokens_and_split(vec![name], &rules);
            for token in rewritten {
                if reachable.insert(token.clone()) {
                    next_frontier.push(token);
                }
            }
        }
        if next_frontier.is_empty() {
            break;
        }
        frontier = next_frontier;
    }
    dedup_rewrite_rules(
        rules
            .into_iter()
            .filter(|r| r.from.iter().any(|from| reachable.contains(from)))
            .collect(),
    )
}

fn split_outside_parens_many(input: &str, seps: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0_i32;
    let mut buf = String::new();
    let mut i = 0;
    while i < input.len() {
        let ch = input[i..].chars().next().unwrap_or('\0');
        let ch_len = ch.len_utf8();
        if ch == '(' || ch == '（' {
            depth += 1;
            buf.push(ch);
            i += ch_len;
            continue;
        }
        if ch == ')' || ch == '）' {
            depth = (depth - 1).max(0);
            buf.push(ch);
            i += ch_len;
            continue;
        }
        let mut matched = None;
        if depth == 0 {
            for sep in seps {
                if input[i..].starts_with(sep) {
                    matched = Some(*sep);
                    break;
                }
            }
        }
        if let Some(sep) = matched {
            let part = buf.trim().to_string();
            if !part.is_empty() {
                out.push(part);
            }
            buf.clear();
            i += sep.len();
            continue;
        }
        buf.push(ch);
        i += ch_len;
    }
    let tail = buf.trim().to_string();
    if !tail.is_empty() {
        out.push(tail);
    }
    if out.is_empty() {
        vec![input.trim().to_string()]
    } else {
        out
    }
}

fn normal_split_separators() -> &'static [&'static str] {
    &[
        "ft.", "Ft.", "feat.", "Feat.", " + ", " ＋ ", " x ", "×", " & ", " ＆ ", " / ", " ／ ",
        " vs. ", " vs ", "，", "、", "；", ",",
    ]
}

fn aggressive_symbol_separators() -> &'static [&'static str] {
    &["&", "＆", "/", "／", "+", "＋"]
}

fn contains_aggressive_separator(value: &str) -> bool {
    aggressive_symbol_separators()
        .iter()
        .any(|sep| value.contains(sep))
}

fn dedup_rewrite_rules(rules: Vec<RewriteRule>) -> Vec<RewriteRule> {
    let mut out = Vec::new();
    for mut r in rules {
        r.from = dedup_preserve(r.from);
        r.to = dedup_preserve(r.to);
        if r.from.is_empty() || r.to.is_empty() {
            continue;
        }
        if let Some(existing) = out
            .iter_mut()
            .find(|x: &&mut RewriteRule| same_name_set(&x.to, &r.to))
        {
            existing.from.extend(r.from);
            existing.from = dedup_preserve(existing.from.clone());
            continue;
        }
        if out
            .iter()
            .any(|x: &RewriteRule| x.from == r.from && x.to == r.to)
        {
            continue;
        }
        out.push(r);
    }
    out
}

fn same_name_set(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let sa = a.iter().cloned().collect::<BTreeSet<_>>();
    let sb = b.iter().cloned().collect::<BTreeSet<_>>();
    sa == sb
}

fn normalize_name(v: &str) -> String {
    fold_fullwidth_ascii(v)
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .replace(['\'', '“', '”'], "\"")
}

fn fold_fullwidth_ascii(input: &str) -> String {
    input
        .chars()
        .map(|c| match c {
            '\u{3000}' => ' ',
            '\u{FF01}'..='\u{FF5E}' => char::from_u32((c as u32) - 0xFEE0).unwrap_or(c),
            _ => c,
        })
        .collect()
}

fn dedup_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn dedup_preserve(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for v in values {
        if seen.insert(v.clone()) {
            out.push(v);
        }
    }
    out
}

fn read_metadata(path: impl AsRef<Path>) -> Result<BTreeMap<String, Map<String, Value>>, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let raw: BTreeMap<String, Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut out = BTreeMap::new();
    for (k, v) in raw {
        if let Value::Object(m) = v {
            out.insert(k, m);
        }
    }
    Ok(out)
}

fn parse_track_path(track: &str) -> Result<(String, String), String> {
    let parts = track.split('/').collect::<Vec<_>>();
    if parts.len() < 3 {
        return Err("invalid track path".to_string());
    }

    // Prefer full album folder name detected by album naming pattern.
    for i in 1..parts.len() {
        if is_album_dir_name(parts[i]) {
            return Ok((extract_circle_name(parts[i - 1])?, parts[i].to_string()));
        }
    }

    // Fallback: original behavior
    Ok((extract_circle_name(parts[0])?, parts[1].to_string()))
}

fn extract_circle_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("invalid empty circle name in track path".to_string());
    }
    if let Some(rest) = trimmed.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err(format!("invalid bracketed circle name: {raw}"));
        };
        let core = rest[..end].trim();
        if core.is_empty() {
            return Err(format!("invalid bracketed circle name: {raw}"));
        }
        Ok(core.to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

fn is_album_dir_name(name: &str) -> bool {
    let token = name.split_whitespace().next().unwrap_or_default();
    let mut p = token.split('.');
    let y = p.next().unwrap_or_default();
    let m = p.next().unwrap_or_default();
    let d = p.next().unwrap_or_default();
    y.len() == 4
        && m.len() == 2
        && d.len() == 2
        && y.chars().all(|c| c.is_ascii_digit())
        && m.chars().all(|c| c.is_ascii_digit())
        && d.chars().all(|c| c.is_ascii_digit())
}

fn derive_album_name_for_output(folder: &str) -> String {
    let parts = folder.split_whitespace().collect::<Vec<_>>();
    if parts.is_empty() {
        return folder.to_string();
    }
    let mut i = 0usize;
    if is_date_token(parts[0]) {
        i += 1;
    }
    if i < parts.len() && is_bracket_token(parts[i]) {
        i += 1;
    }
    let mut j = parts.len();
    if j > i && is_bracket_token(parts[j - 1]) {
        j -= 1;
    }
    let candidate = parts[i..j].join(" ").trim().to_string();
    if candidate.is_empty() {
        folder.to_string()
    } else {
        candidate
    }
}

fn is_date_token(token: &str) -> bool {
    let mut p = token.split('.');
    let y = p.next().unwrap_or_default();
    let m = p.next().unwrap_or_default();
    let d = p.next().unwrap_or_default();
    y.len() == 4
        && m.len() == 2
        && d.len() == 2
        && y.chars().all(|c| c.is_ascii_digit())
        && m.chars().all(|c| c.is_ascii_digit())
        && d.chars().all(|c| c.is_ascii_digit())
}

fn is_bracket_token(token: &str) -> bool {
    token.len() >= 2 && token.starts_with('[') && token.ends_with(']')
}

fn get_s(m: &Map<String, Value>, key: &str) -> Option<String> {
    m.get(key).and_then(|v| v.as_str()).map(ToString::to_string)
}

fn get_n(m: &Map<String, Value>, key: &str) -> Option<u64> {
    m.get(key).and_then(|v| v.as_u64())
}

fn get_list(m: &Map<String, Value>, key: &str) -> Vec<String> {
    match m.get(key) {
        Some(Value::Array(v)) => v
            .iter()
            .filter_map(|x| x.as_str())
            .map(ToString::to_string)
            .collect(),
        Some(Value::String(v)) => vec![v.to_string()],
        _ => Vec::new(),
    }
}

#[derive(Default)]
struct CircleData {
    albums: BTreeMap<String, AlbumData>,
}

#[derive(Default)]
struct AlbumData {
    tracks: Vec<TrackLite>,
}

#[derive(Clone)]
struct TrackLite {
    path: String,
    title: Option<String>,
    date: Option<String>,
    disc_subtitle: Option<String>,
    track_number: Option<u64>,
    artists: Vec<String>,
    album_artists: Vec<String>,
    album_title: Option<String>,
    disc_number: Option<u64>,
    genre: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct CircleStructured {
    albums: BTreeMap<String, AlbumStructured>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct CircleRewriting {
    #[serde(rename = "all album artists")]
    all_album_artists: BTreeMap<String, u64>,
    #[serde(rename = "album artists rewriting")]
    album_artists_rewriting: Vec<RewriteRule>,
    #[serde(rename = "all artists")]
    all_artists: BTreeMap<String, u64>,
    #[serde(rename = "artists rewriting")]
    artists_rewriting: Vec<RewriteRule>,
    #[serde(rename = "all genres")]
    all_genres: Vec<String>,
    #[serde(rename = "genre rewriting")]
    genre_rewriting: Vec<RewriteRule>,
    #[serde(rename = "default genre", skip_serializing_if = "Option::is_none")]
    default_genre: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct AlbumStructured {
    #[serde(rename = "album artists")]
    album_artists: Vec<String>,
    discs: Vec<DiscStructured>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct DiscStructured {
    #[serde(rename = "$subtitle", default, skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    #[serde(flatten)]
    tracks: BTreeMap<String, TrackStructured>,
}

#[derive(Serialize, Deserialize, Clone)]
struct TrackStructured {
    title: String,
    date: String,
    #[serde(rename = "track number")]
    track_number: u64,
    artists: Vec<String>,
    genre: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct RewriteRule {
    from: Vec<String>,
    to: Vec<String>,
}

struct NameAggregation {
    names: Vec<String>,
    split_rules: Vec<RewriteRule>,
}

struct ScoredRewriteRule {
    rule: RewriteRule,
    confident: bool,
}

struct AnalysisAudits {
    disc_classification: BTreeSet<String>,
    different_album_artist: BTreeSet<String>,
    missing_info: BTreeSet<String>,
}
