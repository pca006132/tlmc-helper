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
        generate_update_mode(&exec_dir)
    } else {
        analysis_mode(&exec_dir, &mut logger)
    };
    if let Err(err) = result {
        let _ = logger.error(&format!("fatal: {err}"));
    }
}

fn analysis_mode(exec_dir: &Path, logger: &mut Logger) -> Result<(), String> {
    let metadata = read_metadata(exec_dir.join("metadata.json"))?;
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

        for (album_name, album_data) in circle_data.albums {
            let album_path = format!("{circle_name}/{album_name}");
            let (discs, used_rule3) = classify_discs(&album_data.tracks);
            if used_rule3 {
                disc_classification.insert(album_path.clone());
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
                    let aa = aggregate_names_for_track(&t.album_artists);
                    let a = aggregate_names_for_track(&t.artists);
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
            out_circle.albums.insert(album_name, album_out);
        }

        out_circle.all_album_artists = dedup_sorted(all_album_artists_raw.clone());
        out_circle.all_artists = dedup_sorted(all_artists_raw.clone());
        out_circle.all_genres = all_genres.into_iter().collect();
        out_circle.album_artists_rewriting = build_normalize_rules(&all_album_artists_raw);
        out_circle.artists_rewriting = build_normalize_rules(&all_artists_raw);
        structured.insert(circle_name, out_circle);
    }

    for p in disc_classification {
        logger.append_audit("disc_classification", &p)?;
    }
    for p in diff_album_artist {
        logger.append_audit("different_album_artist", &p)?;
    }
    for p in missing_info {
        logger.append_audit("missing_info", &p)?;
    }

    let json = serde_json::to_string_pretty(&structured).map_err(|e| e.to_string())?;
    fs::write(exec_dir.join("structured.json"), json).map_err(|e| e.to_string())
}

fn generate_update_mode(exec_dir: &Path) -> Result<(), String> {
    let metadata = read_metadata(exec_dir.join("metadata.json"))?;
    let structured_data: BTreeMap<String, CircleStructured> =
        serde_json::from_str(&fs::read_to_string(exec_dir.join("structured.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let mut updates = Map::new();

    for (track_path, orig) in metadata {
        let (circle, _) = parse_track_path(&track_path)?;
        let Some(circle_cfg) = structured_data.get(&circle) else {
            continue;
        };
        let artists = rewrite_names(
            get_list(&orig, "Artists"),
            &circle_cfg.artists_rewriting,
        );
        let album_artists = rewrite_names(
            get_list(&orig, "Album artists"),
            &circle_cfg.album_artists_rewriting,
        );
        let genre = rewrite_genre(
            get_s(&orig, "Genre"),
            &circle_cfg.genre_rewriting,
            circle_cfg.default_genre.clone(),
        );
        let mut patch = Map::new();
        if artists != get_list(&orig, "Artists") {
            patch.insert(
                "Artists".to_string(),
                Value::Array(artists.into_iter().map(Value::String).collect()),
            );
        }
        if album_artists != get_list(&orig, "Album artists") {
            patch.insert(
                "Album artists".to_string(),
                Value::Array(album_artists.into_iter().map(Value::String).collect()),
            );
        }
        if genre != get_s(&orig, "Genre") {
            if let Some(g) = genre {
                patch.insert("Genre".to_string(), Value::String(g));
            }
        }
        if !patch.is_empty() {
            updates.insert(track_path, Value::Object(patch));
        }
    }
    let json = serde_json::to_string_pretty(&Value::Object(updates)).map_err(|e| e.to_string())?;
    fs::write(exec_dir.join("update-metadata.json"), json).map_err(|e| e.to_string())
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

fn aggregate_names_for_track(values: &[String]) -> Vec<String> {
    if values.len() == 1 {
        return split_candidates(&values[0]);
    }
    values.iter().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect()
}

fn split_candidates(value: &str) -> Vec<String> {
    value
        .split(['，', '、', ';', ','])
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .collect()
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
    let mut parts = track.split('/');
    let Some(circle) = parts.next() else {
        return Err("invalid track path".to_string());
    };
    let Some(album) = parts.next() else {
        return Err("invalid track path".to_string());
    };
    Ok((circle.to_string(), album.to_string()))
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

#[derive(Serialize, Deserialize)]
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
