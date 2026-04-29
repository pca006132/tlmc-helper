use std::collections::BTreeSet;
use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use audiotags::Tag;
use serde_json::{Map, Value};
use tlmc::logger::{Logger, rel};
use walkdir::WalkDir;

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
    let circles = collect_circles(exec_dir)?;
    let albums = collect_album_dirs(exec_dir, &circles)?;
    let mut metadata = Map::new();
    for album in albums {
        let result = scan_album(exec_dir, logger, &album)?;
        for (path, value) in result.metadata {
            metadata.insert(path, value);
        }
        for bad in result.corrupted {
            logger.append_audit("corrupted_tracks", &bad)?;
        }
    }
    let file = fs::File::create(exec_dir.join("metadata.json")).map_err(|e| e.to_string())?;
    let writer = BufWriter::new(file);
    serde_json::to_writer_pretty(writer, &Value::Object(metadata)).map_err(|e| e.to_string())
}

fn collect_circles(exec_dir: &Path) -> Result<Vec<String>, String> {
    let filter_path = exec_dir.join("scan-filter.txt");
    if filter_path.exists() {
        let data = fs::read_to_string(filter_path).map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for line in data.lines() {
            let line = line.trim();
            if !line.is_empty() {
                v.push(line.to_string());
            }
        }
        return Ok(v);
    }
    let mut circles = Vec::new();
    for entry in fs::read_dir(exec_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_dir()
            && let Some(name) = p.file_name().and_then(|s| s.to_str())
            && !name.starts_with('.')
        {
            circles.push(name.to_string());
        }
    }
    Ok(circles)
}

fn collect_album_dirs(exec_dir: &Path, circles: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut albums = BTreeSet::new();
    for circle in circles {
        let circle_dir = exec_dir.join(circle);
        if !circle_dir.is_dir() {
            continue;
        }
        for entry in fs::read_dir(circle_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path();
            if p.is_dir() {
                albums.insert(p);
            } else if p.extension().and_then(|s| s.to_str()) == Some("rar") {
                albums.insert(p.with_extension(""));
            }
        }
    }
    Ok(albums.into_iter().collect())
}

fn scan_album(exec_dir: &Path, logger: &mut Logger, album: &Path) -> Result<ScanResult, String> {
    let mut out = ScanResult::default();
    if !album.exists() {
        return Ok(out);
    }
    logger.verbose(&format!("album: {}", rel(exec_dir, album)), false)?;
    for entry in WalkDir::new(album).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
            continue;
        };
        if !(ext.eq_ignore_ascii_case("flac")
            || ext.eq_ignore_ascii_case("mp3")
            || ext.eq_ignore_ascii_case("m4a"))
        {
            continue;
        }
        match scan_track(path) {
            Ok(v) => {
                out.metadata.insert(rel(exec_dir, path), v);
            }
            Err(_) => out.corrupted.push(rel(exec_dir, path)),
        }
    }
    Ok(out)
}

fn scan_track(path: &Path) -> Result<Value, String> {
    let tag = Tag::new().read_from_path(path).map_err(|e| e.to_string())?;
    let mut m = Map::new();
    insert_str(&mut m, "Title", tag.title());

    insert_str_list(&mut m, "Artists", tag.artists().map(split_names));
    insert_str_list(
        &mut m,
        "Album artists",
        tag.album_artists().map(split_names),
    );
    insert_str(&mut m, "Disc subtitle", tag.disc_subtitle());

    insert_str(&mut m, "Date", tag.date().map(|v| v.to_string()));
    insert_str(&mut m, "Year", tag.year().map(|y| y.to_string()));
    insert_str(&mut m, "Album title", tag.album_title());
    insert_num(&mut m, "Track number", tag.track_number().map(u64::from));
    insert_num(&mut m, "Total tracks", tag.total_tracks().map(u64::from));
    insert_num(&mut m, "Disc number", tag.disc_number().map(u64::from));
    insert_num(&mut m, "Total discs", tag.total_discs().map(u64::from));
    insert_str(&mut m, "Genre", tag.genre());
    insert_str(&mut m, "Comment", tag.comment());
    Ok(Value::Object(m))
}

fn split_names(v: Vec<String>) -> Vec<String> {
    if v.len() == 1 {
        v[0].split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .collect()
    } else {
        v
    }
}

fn insert_str(m: &mut Map<String, Value>, key: &str, value: Option<impl Into<String>>) {
    if let Some(v) = value {
        m.insert(key.to_string(), Value::String(v.into()));
    }
}

fn insert_num(m: &mut Map<String, Value>, key: &str, value: Option<u64>) {
    if let Some(v) = value {
        m.insert(key.to_string(), Value::Number(v.into()));
    }
}

fn insert_str_list(m: &mut Map<String, Value>, key: &str, value: Option<Vec<String>>) {
    if let Some(v) = value {
        m.insert(
            key.to_string(),
            Value::Array(v.into_iter().map(Value::String).collect()),
        );
    }
}

#[derive(Default)]
struct ScanResult {
    metadata: Map<String, Value>,
    corrupted: Vec<String>,
}
