use std::collections::BTreeMap;
use std::fs;
use std::io::BufReader;
use std::path::Path;
use std::str::FromStr;

use audiotags::Tag;
use id3::Timestamp;
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
    if let Err(err) = run(&exec_dir, &mut logger) {
        let _ = logger.error(&format!("fatal: {err}"));
    }
}

fn run(exec_dir: &Path, logger: &mut Logger) -> Result<(), String> {
    let file = fs::File::open(exec_dir.join("update-metadata.json")).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let updates: BTreeMap<String, Value> =
        serde_json::from_reader(reader).map_err(|e| e.to_string())?;
    let mut logged_albums = std::collections::BTreeSet::new();
    for (track_rel, patch) in updates {
        let path = exec_dir.join(&track_rel);
        let Value::Object(patch_obj) = patch else {
            continue;
        };
        let mut parts = track_rel.split('/');
        let album_key = if let (Some(circle), Some(album)) = (parts.next(), parts.next()) {
            Some(format!("{circle}/{album}"))
        } else {
            None
        };
        if let Some(album) = album_key
            && logged_albums.insert(album.clone())
        {
            logger.verbose(&format!("album: {album}"), false)?;
        }
        if let Err(err) = apply_patch(&path, &patch_obj) {
            let line = format!("{}: {err}", path.to_string_lossy());
            logger.append_audit("apply_tags_failed", &line)?;
            continue;
        }
    }
    Ok(())
}

fn apply_patch(path: &Path, patch: &Map<String, Value>) -> Result<(), String> {
    let mut tag = Tag::new().read_from_path(path).map_err(|e| e.to_string())?;
    if let Some(v) = get_s(patch, "Title") {
        tag.set_title(&v);
    }
    if let Some(v) = get_list(patch, "Artists") {
        let v: Vec<&str> = v.iter().map(|s| s.as_str()).collect();
        tag.set_artists(&v);
    }
    if let Some(v) = get_s(patch, "Album title") {
        tag.set_album_title(&v);
    }
    if let Some(v) = get_list(patch, "Album artists") {
        let v: Vec<&str> = v.iter().map(|s| s.as_str()).collect();
        tag.set_album_artists(&v);
    }
    if let Some(v) = get_s(patch, "Disc subtitle") {
        tag.set_disc_subtitle(&v);
    }
    if let Some(v) = get_u16(patch, "Track number") {
        tag.set_track_number(v);
    }
    if let Some(v) = get_u16(patch, "Total tracks") {
        tag.set_total_tracks(v);
    }
    if let Some(v) = get_u16(patch, "Disc number") {
        tag.set_disc_number(v);
    }
    if let Some(v) = get_u16(patch, "Total discs") {
        tag.set_total_discs(v);
    }
    if let Some(v) = get_s(patch, "Date").or_else(|| get_s(patch, "Year"))
        && let Some(ts) = parse_timestamp_like(&v)
    {
        // Keep YEAR in sync when DATE is updated (e.g. YYYY.MM.DD -> YYYY).
        tag.set_year(ts.year);
        tag.set_date(ts);
    }
    if let Some(v) = get_i32(patch, "Year") {
        tag.set_year(v);
    }
    if let Some(v) = get_s(patch, "Genre") {
        tag.set_genre(&v);
    }
    if let Some(v) = get_s(patch, "Comment") {
        tag.set_comment(v);
    }
    tag.write_to_path(path.to_string_lossy().as_ref())
        .map_err(|e| e.to_string())
}

fn get_s(m: &Map<String, Value>, key: &str) -> Option<String> {
    m.get(key).and_then(|v| v.as_str()).map(ToString::to_string)
}

fn get_list(m: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    match m.get(key) {
        Some(Value::Array(v)) => Some(
            v.iter()
                .filter_map(|x| x.as_str())
                .map(ToString::to_string)
                .collect(),
        ),
        Some(Value::String(v)) => Some(vec![v.to_string()]),
        _ => None,
    }
}

fn get_u16(m: &Map<String, Value>, key: &str) -> Option<u16> {
    m.get(key)
        .and_then(|v| v.as_u64())
        .and_then(|v| u16::try_from(v).ok())
}

fn get_i32(m: &Map<String, Value>, key: &str) -> Option<i32> {
    m.get(key)
        .and_then(|v| v.as_i64())
        .and_then(|v| i32::try_from(v).ok())
}

fn parse_timestamp_like(v: &str) -> Option<Timestamp> {
    let normalized = v.replace('.', "-");
    Timestamp::from_str(&normalized).ok()
}
