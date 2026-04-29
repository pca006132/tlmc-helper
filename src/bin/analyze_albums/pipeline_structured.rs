use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::Path;

use serde_json::{Map, Value};
use tlmc::logger::Logger;

use super::models::{
    AlbumStructured, AnalysisAudits, CircleData, CircleStructured, DiscStructured, TrackLite,
    TrackStructured,
};

pub(super) fn run_structured_stage(
    exec_dir: &Path,
    metadata: &BTreeMap<String, Map<String, Value>>,
    logger: &mut Logger,
) -> Result<BTreeMap<String, CircleStructured>, String> {
    let structured_path = exec_dir.join("structured.json");
    load_or_build_structured(exec_dir, &structured_path, metadata, logger)
}

pub(super) fn read_metadata(
    path: impl AsRef<Path>,
) -> Result<BTreeMap<String, Map<String, Value>>, String> {
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

pub(super) fn build_structured_from_metadata(
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
                    let aa_pre = super::rule_generation::aggregate_names_for_track(&t.album_artists);
                    let a_pre = super::rule_generation::aggregate_names_for_track(&t.artists);
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

pub(super) fn parse_track_path(track: &str) -> Result<(String, String), String> {
    let parts = track.split('/').collect::<Vec<_>>();
    if parts.len() < 3 {
        return Err("invalid track path".to_string());
    }

    for i in 1..parts.len() {
        if is_album_dir_name(parts[i]) {
            return Ok((extract_circle_name(parts[i - 1])?, parts[i].to_string()));
        }
    }
    Ok((extract_circle_name(parts[0])?, parts[1].to_string()))
}

pub(super) fn get_s(m: &Map<String, Value>, key: &str) -> Option<String> {
    m.get(key).and_then(|v| v.as_str()).map(ToString::to_string)
}

pub(super) fn get_list(m: &Map<String, Value>, key: &str) -> Vec<String> {
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

fn load_or_build_structured(
    exec_dir: &Path,
    structured_path: &Path,
    metadata: &BTreeMap<String, Map<String, Value>>,
    logger: &mut Logger,
) -> Result<BTreeMap<String, CircleStructured>, String> {
    if structured_path.exists() {
        return serde_json::from_str(&fs::read_to_string(structured_path).map_err(|e| e.to_string())?)
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

fn get_n(m: &Map<String, Value>, key: &str) -> Option<u64> {
    m.get(key).and_then(|v| v.as_u64())
}
