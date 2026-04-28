use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use audiotags::Tag;
use rayon::prelude::*;
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
    let text = fs::read_to_string(exec_dir.join("update-metadata.json")).map_err(|e| e.to_string())?;
    let updates: BTreeMap<String, Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut albums = std::collections::BTreeSet::new();
    let mut jobs = Vec::new();
    for (track_rel, patch) in &updates {
        let path = exec_dir.join(track_rel);
        if !path.exists() {
            continue;
        }
        let Value::Object(m) = patch else {
            continue;
        };
        let mut parts = track_rel.split('/');
        if let (Some(circle), Some(album)) = (parts.next(), parts.next()) {
            albums.insert(format!("{circle}/{album}"));
        }
        jobs.push((path, m.clone()));
    }
    for album in albums {
        logger.verbose(&format!("album: {album}"), false)?;
    }
    let results: Vec<Result<(), String>> = jobs
        .into_par_iter()
        .map(|(path, patch)| apply_patch(&path, &patch))
        .collect();
    for r in results {
        r?;
    }
    Ok(())
}

fn apply_patch(path: &Path, patch: &Map<String, Value>) -> Result<(), String> {
    let mut tag = Tag::new().read_from_path(path).map_err(|e| e.to_string())?;
    if let Some(v) = get_list(patch, "Artists")
        && let Some(first) = v.first()
    {
        tag.set_artist(first);
    }
    if let Some(v) = get_list(patch, "Album artists")
        && let Some(first) = v.first()
    {
        tag.set_album_artist(first);
    }
    if let Some(v) = get_s(patch, "Genre") {
        tag.set_genre(&v);
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
