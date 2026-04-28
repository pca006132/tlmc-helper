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
    let structured = exec_dir.join("structured.json");
    let result = if structured.exists() {
        generate_update_mode(&exec_dir, &mut logger)
    } else {
        analysis_mode(&exec_dir, &mut logger)
    };
    if let Err(err) = result {
        let _ = logger.error(&format!("fatal: {err}"));
    }
}

fn analysis_mode(exec_dir: &Path, logger: &mut Logger) -> Result<(), String> {
    let metadata = read_metadata(exec_dir.join("metadata.json"))?;
    let (structured, audits) = build_structured_from_metadata(metadata)?;

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
    fs::write(exec_dir.join("structured.json"), json).map_err(|e| e.to_string())
}

fn generate_update_mode(exec_dir: &Path, logger: &mut Logger) -> Result<(), String> {
    let metadata = read_metadata(exec_dir.join("metadata.json"))?;
    let structured_data: BTreeMap<String, CircleStructured> =
        serde_json::from_str(&fs::read_to_string(exec_dir.join("structured.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    validate_rewrite_chains(&structured_data, logger)?;
    let mut updated_metadata = metadata.clone();

    for (track_path, orig) in &metadata {
        let (circle, _) = parse_track_path(&track_path)?;
        let Some(circle_cfg) = structured_data.get(&circle) else {
            continue;
        };
        let artists = rewrite_names(
            get_list(orig, "Artists"),
            &circle_cfg.artists_rewriting,
        );
        let album_artists = rewrite_names(
            get_list(orig, "Album artists"),
            &circle_cfg.album_artists_rewriting,
        );
        let genre = rewrite_genre(
            get_s(orig, "Genre"),
            &circle_cfg.genre_rewriting,
            circle_cfg.default_genre.clone(),
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
        if genre != get_s(orig, "Genre") {
            if let Some(g) = genre {
                patch.insert("Genre".to_string(), Value::String(g));
            }
        }
        if !patch.is_empty() {
            if let Some(entry) = updated_metadata.get_mut(track_path) {
                for (k, v) in &patch {
                    entry.insert(k.clone(), v.clone());
                }
            }
        }
    }
    let (mut structured_new, _) = build_structured_from_metadata(updated_metadata)?;
    for (circle, new_circle) in &mut structured_new {
        if let Some(old_circle) = structured_data.get(circle) {
            new_circle.album_artists_rewriting =
                dedup_rewrite_rules(old_circle.album_artists_rewriting.clone());
            new_circle.artists_rewriting = dedup_rewrite_rules(old_circle.artists_rewriting.clone());
            new_circle.genre_rewriting = dedup_rewrite_rules(old_circle.genre_rewriting.clone());
            new_circle.default_genre = old_circle.default_genre.clone();
        }
    }
    overlay_track_data_from_old(&mut structured_new, &structured_data);
    apply_rewrites_to_structured_new(&mut structured_new);
    let structured_json = serde_json::to_string_pretty(&structured_new).map_err(|e| e.to_string())?;
    fs::write(exec_dir.join("structured-new.json"), structured_json).map_err(|e| e.to_string())?;

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

fn validate_rewrite_chains(
    structured: &BTreeMap<String, CircleStructured>,
    logger: &mut Logger,
) -> Result<(), String> {
    for (circle, data) in structured {
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
            if r1.to.iter().any(|v| r2.from.iter().any(|f| f == v)) {
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
        let mut all_album_artists_raw = Vec::new();
        let mut all_artists_raw = Vec::new();
        let mut all_genres = BTreeSet::new();
        let mut split_rules_album_artists = Vec::new();
        let mut split_rules_artists = Vec::new();

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
                    let tagged = tagged_album_titles.iter().next().cloned().unwrap_or_default();
                    if !tagged.is_empty() && tagged != album_name {
                        album_name = tagged;
                    }
                }
            }

            let mut album_artist_sets = HashSet::new();
            let mut album_album_artists = BTreeSet::new();
            let mut album_out = AlbumStructured::default();
            for disc in discs {
                let mut disc_map = BTreeMap::new();
                for t in disc {
                    if t.artists.is_empty() {
                        missing_info.insert(album_path.clone());
                    }
                    let aa_pre = aggregate_names_for_track(&t.album_artists);
                    let a_pre = aggregate_names_for_track(&t.artists);
                    for rule in aa_pre.split_rules.clone() {
                        split_rules_album_artists.push(rule);
                    }
                    for rule in a_pre.split_rules.clone() {
                        split_rules_artists.push(rule);
                    }
                    let aa = aa_pre.names;
                    let a = a_pre.names;
                    for x in &aa {
                        all_album_artists_raw.push(x.clone());
                        album_album_artists.insert(x.clone());
                    }
                    for x in &a {
                        all_artists_raw.push(x.clone());
                    }
                    if let Some(g) = t.genre.clone() {
                        all_genres.insert(g);
                    }
                    album_artist_sets.insert(aa.join("|"));
                    disc_map.insert(
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
                album_out.discs.push(disc_map);
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

        out_circle.all_album_artists = dedup_sorted(all_album_artists_raw.clone());
        out_circle.all_artists = dedup_sorted(all_artists_raw.clone());
        out_circle.all_genres = all_genres.into_iter().collect();
        out_circle.album_artists_rewriting = dedup_rewrite_rules(merge_rules(
            split_rules_album_artists,
            build_normalize_rules(&all_album_artists_raw),
        ));
        out_circle.artists_rewriting = dedup_rewrite_rules(merge_rules(
            split_rules_artists,
            build_normalize_rules(&all_artists_raw),
        ));
        out_circle.genre_rewriting = dedup_rewrite_rules(out_circle.genre_rewriting);
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
                .entry(t.album_title.clone().unwrap_or_else(|| "__missing__".to_string()))
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
    let source = if input.len() == 1 {
        split_candidates(&input[0])
    } else {
        input
    };
    let mut out = Vec::new();
    for name in source {
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

fn rewrite_genre(input: Option<String>, rules: &[RewriteRule], default_genre: Option<String>) -> Option<String> {
    let Some(value) = input.or(default_genre) else {
        return None;
    };
    for r in rules {
        if r.from.iter().any(|f| f == &value) {
            return r.to.first().cloned();
        }
    }
    Some(value)
}

fn build_normalize_rules(values: &[String]) -> Vec<RewriteRule> {
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
        // Use normalization only for grouping; keep output in original variants.
        // The generated target is the lexicographically smallest original variant.
        let to = vec![set.iter().next().cloned().unwrap_or_default()];
        let from = set.into_iter().collect::<Vec<_>>();
        out.push(RewriteRule {
            from,
            to,
        });
    }
    out
}

fn aggregate_names_for_track(values: &[String]) -> NameAggregation {
    if values.len() == 1 {
        let raw_original = values[0].trim().to_string();
        let raw_trimmed = trim_leading_vo(&raw_original).to_string();
        let split = split_candidates(&raw_trimmed);
        let mut split_rules = Vec::new();
        if (raw_original != raw_trimmed || split.len() > 1) && !raw_original.is_empty() {
            split_rules.push(RewriteRule {
                from: vec![raw_original.clone()],
                to: split.clone(),
            });
        }
        return NameAggregation {
            names: split,
            split_rules,
        };
    }
    NameAggregation {
        names: values
            .iter()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect(),
        split_rules: Vec::new(),
    }
}

fn split_candidates(value: &str) -> Vec<String> {
    let mut chunks = vec![value.to_string()];
    for sep in ["feat.", " + ", " x ", " & ", "/", "，", "、", ";", ","] {
        let mut next = Vec::new();
        for c in chunks {
            next.extend(split_outside_parens(&c, sep));
        }
        chunks = next;
    }
    chunks
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect()
}

fn split_outside_parens(input: &str, sep: &str) -> Vec<String> {
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
        if depth == 0 && input[i..].starts_with(sep) {
            out.push(buf.trim().to_string());
            buf.clear();
            i += sep.len();
            continue;
        }
        buf.push(ch);
        i += ch_len;
    }
    out.push(buf.trim().to_string());
    out
}

fn trim_leading_vo(input: &str) -> &str {
    let s = input.trim();
    if s
        .get(..3)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("vo."))
    {
        s.get(3..).unwrap_or("").trim_start()
    } else {
        s
    }
}

fn merge_rules(primary: Vec<RewriteRule>, secondary: Vec<RewriteRule>) -> Vec<RewriteRule> {
    let mut out = Vec::new();
    for r in primary.into_iter().chain(secondary.into_iter()) {
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

fn materialize_metadata_from_structured(
    structured: &BTreeMap<String, CircleStructured>,
) -> BTreeMap<String, Map<String, Value>> {
    let mut out = BTreeMap::new();
    for (_circle, circle_data) in structured {
        for (album_title, album_data) in &circle_data.albums {
            let total_discs = album_data.discs.len() as u64;
            for (disc_idx, disc) in album_data.discs.iter().enumerate() {
                let disc_no = (disc_idx as u64) + 1;
                for (track_path, track) in disc {
                    let mut m = Map::new();
                    m.insert("Title".to_string(), Value::String(track.title.clone()));
                    m.insert("Date".to_string(), Value::String(track.date.clone()));
                    m.insert(
                        "Track number".to_string(),
                        Value::Number(track.track_number.into()),
                    );
                    m.insert(
                        "Artists".to_string(),
                        Value::Array(track.artists.iter().cloned().map(Value::String).collect()),
                    );
                    m.insert("Genre".to_string(), Value::String(track.genre.clone()));
                    m.insert("Album title".to_string(), Value::String(album_title.clone()));
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

fn diff_track_metadata(orig: &Map<String, Value>, desired: &Map<String, Value>) -> Map<String, Value> {
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
        let total_discs_is_one = desired
            .get("Total discs")
            .and_then(|v| v.as_u64())
            == Some(1);
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
                for (track_path, old_track) in old_disc {
                    for new_disc in &mut new_album.discs {
                        if let Some(new_track) = new_disc.get_mut(track_path) {
                            *new_track = old_track.clone();
                            break;
                        }
                    }
                }
            }
        }
    }
}

fn apply_rewrites_to_structured_new(structured: &mut BTreeMap<String, CircleStructured>) {
    for (_circle_name, circle) in structured {
        for (_album_name, album) in &mut circle.albums {
            album.album_artists = rewrite_names(
                album.album_artists.clone(),
                &circle.album_artists_rewriting,
            );
            for disc in &mut album.discs {
                for (_track_path, track) in disc {
                    track.artists = rewrite_names(track.artists.clone(), &circle.artists_rewriting);
                }
            }
        }
    }
}

fn dedup_rewrite_rules(rules: Vec<RewriteRule>) -> Vec<RewriteRule> {
    let mut out = Vec::new();
    for mut r in rules {
        r.from = dedup_preserve(r.from);
        r.to = dedup_preserve(r.to);
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

fn normalize_name(v: &str) -> String {
    v.to_lowercase()
        .replace('\'', "\"")
        .replace('“', "\"")
        .replace('”', "\"")
        .replace('＊', "*")
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
    track_number: Option<u64>,
    artists: Vec<String>,
    album_artists: Vec<String>,
    album_title: Option<String>,
    disc_number: Option<u64>,
    genre: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct CircleStructured {
    #[serde(rename = "all album artists")]
    all_album_artists: Vec<String>,
    #[serde(rename = "album artists rewriting")]
    album_artists_rewriting: Vec<RewriteRule>,
    #[serde(rename = "all artists")]
    all_artists: Vec<String>,
    #[serde(rename = "artists rewriting")]
    artists_rewriting: Vec<RewriteRule>,
    #[serde(rename = "all genres")]
    all_genres: Vec<String>,
    #[serde(rename = "genre rewriting")]
    genre_rewriting: Vec<RewriteRule>,
    #[serde(rename = "default genre", skip_serializing_if = "Option::is_none")]
    default_genre: Option<String>,
    albums: BTreeMap<String, AlbumStructured>,
}

#[derive(Serialize, Deserialize, Default)]
struct AlbumStructured {
    #[serde(rename = "album artists")]
    album_artists: Vec<String>,
    discs: Vec<BTreeMap<String, TrackStructured>>,
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

struct AnalysisAudits {
    disc_classification: BTreeSet<String>,
    different_album_artist: BTreeSet<String>,
    missing_info: BTreeSet<String>,
}
