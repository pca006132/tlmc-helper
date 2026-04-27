use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::UTF_8;
use flac_codec::decode::{FlacSampleReader, Metadata};
use flac_codec::encode::{FlacSampleWriter, Options};
use metaflac::Tag;
use unrar::Archive;
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
    let circles = fs::read_dir(exec_dir).map_err(ioe)?;
    for circle_entry in circles {
        let circle_entry = match circle_entry {
            Ok(v) => v,
            Err(err) => {
                logger.error(&format!("read_dir entry error: {err}"))?;
                continue;
            }
        };
        let circle_path = circle_entry.path();
        if !circle_path.is_dir() {
            continue;
        }
        let circle_name = circle_path
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("")
            .to_string();
        if circle_name.starts_with('.') {
            continue;
        }
        let albums = match fs::read_dir(&circle_path) {
            Ok(v) => v,
            Err(err) => {
                logger.error(&format!("read_dir {} error: {err}", rel(exec_dir, &circle_path)))?;
                continue;
            }
        };
        for album_entry in albums {
            let album_entry = match album_entry {
                Ok(v) => v,
                Err(err) => {
                    logger.error(&format!("album entry error in {circle_name}: {err}"))?;
                    continue;
                }
            };
            let rar_path = album_entry.path();
            if rar_path.extension().and_then(OsStr::to_str) != Some("rar") {
                continue;
            }
            if let Err(err) = process_archive(exec_dir, logger, &circle_name, &rar_path) {
                logger.error(&format!(
                    "archive failed {}: {err}",
                    rel(exec_dir, &rar_path)
                ))?;
            }
        }
    }
    Ok(())
}

fn process_archive(
    exec_dir: &Path,
    logger: &mut Logger,
    circle_name: &str,
    rar_path: &Path,
) -> Result<(), String> {
    let album_dir = rar_path.with_extension("");
    logger.verbose(&format!("album: {}", rel(exec_dir, &album_dir)), false)?;
    if !album_dir.exists() {
        fs::create_dir_all(&album_dir).map_err(ioe)?;
        extract_rar(rar_path, &album_dir).map_err(|e| e.to_string())?;
        logger.verbose(
            &format!("extracted from {}", rel(exec_dir, rar_path)),
            true,
        )?;
    } else {
        logger.verbose("album directory already exists, skipping extract", true)?;
    }
    process_album(exec_dir, logger, circle_name, rar_path, &album_dir)
}

fn extract_rar(rar_path: &Path, out_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut archive = Archive::new(rar_path).open_for_processing()?;
    while let Some(header) = archive.read_header()? {
        archive = if header.entry().is_file() {
            header.extract_with_base(out_dir)?
        } else {
            header.skip()?
        };
    }
    Ok(())
}

fn process_album(
    exec_dir: &Path,
    logger: &mut Logger,
    circle_name: &str,
    rar_path: &Path,
    album_dir: &Path,
) -> Result<(), String> {
    let (flacs, cues) = scan_album_files(album_dir);
    if cues.is_empty() {
        logger.verbose(
            &format!("nothing to split in {}", rel(exec_dir, album_dir)),
            true,
        )?;
        return Ok(());
    }
    let pairs = pair_flac_cue(&flacs, &cues);
    for f in &flacs {
        if !pairs.iter().any(|(pf, _)| pf == f) {
            logger.append_line("missing-cue.txt", &rel(exec_dir, f))?;
            logger.verbose(&format!("missing cue: {}", rel(exec_dir, f)), true)?;
        }
    }
    for c in &cues {
        if !pairs.iter().any(|(_, pc)| pc == c) {
            logger.append_line("missing-flac.txt", &rel(exec_dir, c))?;
            logger.verbose(&format!("missing flac: {}", rel(exec_dir, c)), true)?;
        }
    }
    if pairs.len() > 1 {
        logger.append_line("multi-disc.txt", &rel(exec_dir, album_dir))?;
    }
    let fallback_date = parse_archive_date(rar_path);
    let is_multi_disc = pairs.len() > 1;
    for (flac_path, cue_path) in pairs {
        logger.verbose(
            &format!(
                "pair: {} <-> {}",
                rel(exec_dir, &flac_path),
                rel(exec_dir, &cue_path)
            ),
            true,
        )?;
        if let Err(err) = process_pair(
            exec_dir,
            logger,
            circle_name,
            album_dir,
            &flac_path,
            &cue_path,
            fallback_date.as_deref(),
            is_multi_disc,
        ) {
            logger.error(&format!(
                "pair failed {} / {}: {err}",
                rel(exec_dir, &flac_path),
                rel(exec_dir, &cue_path)
            ))?;
        }
    }
    Ok(())
}

fn process_pair(
    exec_dir: &Path,
    logger: &mut Logger,
    circle_name: &str,
    album_dir: &Path,
    flac_path: &Path,
    cue_path: &Path,
    fallback_date: Option<&str>,
    use_disc_subdir: bool,
) -> Result<(), String> {
    let cue_text = decode_cue(exec_dir, logger, cue_path)?;
    let cue = match parse_cue(&cue_text, fallback_date, circle_name) {
        Ok(v) => v,
        Err(err) => {
            logger.append_line("corrupt-cuesheet.txt", &rel(exec_dir, cue_path))?;
            return Err(err);
        }
    };
    let out_dir = if use_disc_subdir {
        album_dir.join(
            flac_path
                .file_stem()
                .and_then(OsStr::to_str)
                .unwrap_or("disc"),
        )
    } else {
        album_dir.to_path_buf()
    };
    fs::create_dir_all(&out_dir).map_err(ioe)?;

    split_and_tag(exec_dir, logger, flac_path, &out_dir, &cue)?;
    rename_old(flac_path).map_err(ioe)?;
    rename_old(cue_path).map_err(ioe)?;
    Ok(())
}

fn split_and_tag(
    exec_dir: &Path,
    logger: &mut Logger,
    flac_path: &Path,
    out_dir: &Path,
    cue: &CueData,
) -> Result<(), String> {
    let source_data = fs::read(flac_path).map_err(ioe)?;
    let mut reader =
        FlacSampleReader::new_seekable(Cursor::new(source_data.as_slice())).map_err(fe)?;
    let sample_rate = u64::from(reader.sample_rate());
    if cue.tracks.is_empty() {
        return Ok(());
    }

    let total_samples = reader
        .total_samples()
        .ok_or_else(|| "missing total samples in streaminfo".to_string())?;
    let mut starts = Vec::with_capacity(cue.tracks.len());
    for t in &cue.tracks {
        starts.push(cue_index_to_sample(&t.index01, sample_rate));
    }

    for (i, track) in cue.tracks.iter().enumerate() {
        let start = starts[i];
        let end = if i + 1 < starts.len() {
            starts[i + 1]
        } else {
            total_samples
        };
        if end <= start {
            continue;
        }
        let track_name = sanitize_file_part(track.title.as_deref().unwrap_or(""));
        let filename = format!("{:02} - {}.flac", track.id, track_name);
        let out_path = out_dir.join(filename);
        extract_track(flac_path, &mut reader, start, end, &out_path)?;
        write_tags(&out_path, cue, track).map_err(|e| e.to_string())?;
        logger.verbose(&format!("wrote {}", rel(exec_dir, &out_path)), true)?;

        if cue.album_title.is_none() || track.title.is_none() || track.performer.is_none() {
            logger.append_line(
                "missing-info.txt",
                &format!("{} track {:02}", rel(exec_dir, flac_path), track.id),
            )?;
            logger.verbose(
                &format!("missing tag info: {} track {:02}", rel(exec_dir, flac_path), track.id),
                true,
            )?;
        }
    }
    Ok(())
}

fn extract_track(
    source: &Path,
    reader: &mut FlacSampleReader<Cursor<&[u8]>>,
    start: u64,
    end: u64,
    out_path: &Path,
) -> Result<(), String> {
    let channels = u64::from(reader.channel_count());
    let total_interleaved_samples = (end - start) * channels;
    reader.seek(start).map_err(fe)?;
    let mut writer = FlacSampleWriter::create(
        out_path,
        Options::default(),
        reader.sample_rate(),
        reader.bits_per_sample(),
        reader.channel_count(),
        Some(total_interleaved_samples),
    )
    .map_err(fe)?;
    copy_samples(reader, &mut writer, total_interleaved_samples).map_err(fe)?;
    writer.finalize().map_err(fe)?;
    if !source.exists() {
        return Err("source vanished".to_string());
    }
    Ok(())
}

fn copy_samples<R, W>(
    reader: &mut FlacSampleReader<R>,
    writer: &mut FlacSampleWriter<W>,
    mut samples: u64,
) -> Result<(), flac_codec::Error>
where
    R: std::io::Read,
    W: std::io::Write + std::io::Seek,
{
    while samples > 0 {
        match reader.fill_buf()? {
            [] => return Ok(()),
            buf => {
                let to_write = usize::try_from(samples)
                    .map(|s| s.min(buf.len()))
                    .unwrap_or(buf.len());
                writer.write(&buf[..to_write])?;
                reader.consume(to_write);
                samples -= to_write as u64;
            }
        }
    }
    Ok(())
}

fn write_tags(path: &Path, cue: &CueData, track: &TrackData) -> Result<(), String> {
    let mut tag = Tag::read_from_path(path).unwrap_or_else(|_| Tag::new());
    tag.set_vorbis("ARTIST", vec![track.performer.clone().unwrap_or_default()]);
    tag.set_vorbis("TITLE", vec![track.title.clone().unwrap_or_default()]);
    tag.set_vorbis("ALBUM", vec![cue.album_title.clone().unwrap_or_default()]);
    tag.set_vorbis("TRACKNUMBER", vec![format!("{:02}", track.id)]);
    tag.set_vorbis(
        "ALBUMARTIST",
        vec![cue.album_artist.clone().unwrap_or_default()],
    );
    if let Some(v) = cue.genre.as_ref() {
        tag.set_vorbis("GENRE", vec![v.clone()]);
    }
    if let Some(v) = cue.date.as_ref() {
        tag.set_vorbis("DATE", vec![v.clone()]);
    }
    if let Some(v) = cue.comment.as_ref() {
        tag.set_vorbis("COMMENT", vec![v.clone()]);
    }
    tag.write_to_path(path).map_err(|e| e.to_string())
}

fn decode_cue(exec_dir: &Path, logger: &mut Logger, cue_path: &Path) -> Result<String, String> {
    let data = fs::read(cue_path).map_err(ioe)?;
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
    detector.feed(&data, true);
    let encoding = detector.guess(None, Utf8Detection::Allow);
    if encoding != UTF_8 || has_bom(&data) {
        logger.verbose(
            &format!(
                "non-standard cue encoding {}: {}",
                rel(exec_dir, cue_path),
                encoding.name()
            ),
            true,
        )?;
    }
    let (text, _, _) = encoding.decode(&data);
    Ok(text.into_owned())
}

fn has_bom(data: &[u8]) -> bool {
    data.starts_with(&[0xEF, 0xBB, 0xBF])
        || data.starts_with(&[0xFF, 0xFE])
        || data.starts_with(&[0xFE, 0xFF])
}

fn scan_album_files(album_dir: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut flacs = Vec::new();
    let mut cues = Vec::new();
    for entry in WalkDir::new(album_dir).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.into_path();
        match p.extension().and_then(OsStr::to_str).map(|v| v.to_ascii_lowercase()) {
            Some(ext) if ext == "flac" => flacs.push(p),
            Some(ext) if ext == "cue" => cues.push(p),
            _ => {}
        }
    }
    flacs.sort();
    cues.sort();
    (flacs, cues)
}

fn pair_flac_cue(flacs: &[PathBuf], cues: &[PathBuf]) -> Vec<(PathBuf, PathBuf)> {
    if flacs.len() == 1 && cues.len() == 1 {
        return vec![(flacs[0].clone(), cues[0].clone())];
    }
    let mut result = Vec::new();
    let mut used_cue = vec![false; cues.len()];

    for flac in flacs {
        let flac_stem = flac.file_stem().and_then(OsStr::to_str).unwrap_or("");
        let mut exact = None;
        for (i, cue) in cues.iter().enumerate() {
            let cue_stem = cue.file_stem().and_then(OsStr::to_str).unwrap_or("");
            if flac_stem.eq_ignore_ascii_case(cue_stem) {
                exact = Some(i);
                break;
            }
        }
        if let Some(i) = exact {
            if !used_cue[i] {
                used_cue[i] = true;
                result.push((flac.clone(), cues[i].clone()));
            }
            continue;
        }
        let mut candidates = Vec::new();
        for (i, cue) in cues.iter().enumerate() {
            if used_cue[i] {
                continue;
            }
            let cue_stem = cue.file_stem().and_then(OsStr::to_str).unwrap_or("");
            if flac_stem.contains(cue_stem) || cue_stem.contains(flac_stem) {
                candidates.push(i);
            }
        }
        if candidates.len() == 1 {
            let i = candidates[0];
            used_cue[i] = true;
            result.push((flac.clone(), cues[i].clone()));
        }
    }
    result
}

fn parse_cue(input: &str, fallback_date: Option<&str>, circle_name: &str) -> Result<CueData, String> {
    let mut top_rem: BTreeMap<String, String> = BTreeMap::new();
    let mut album_title = None;
    let mut album_artist = None;
    let mut tracks: Vec<TrackData> = Vec::new();
    let mut current_track: Option<TrackData> = None;

    for raw in input.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("REM ") {
            let mut parts = rest.splitn(2, ' ');
            let key = parts.next().unwrap_or("").trim().to_ascii_uppercase();
            let value = unquote(parts.next().unwrap_or("").trim());
            if matches!(key.as_str(), "GENRE" | "DATE" | "COMMENT") {
                top_rem.insert(key, value);
            }
            continue;
        }
        if line.starts_with("TRACK ") {
            if let Some(t) = current_track.take() {
                tracks.push(t);
            }
            let id = line
                .split_whitespace()
                .nth(1)
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0);
            current_track = Some(TrackData {
                id,
                title: None,
                performer: None,
                index01: "00:00:00".to_string(),
            });
            continue;
        }
        if let Some(v) = line.strip_prefix("TITLE ") {
            if let Some(t) = current_track.as_mut() {
                t.title = Some(unquote(v.trim()));
            } else {
                album_title = Some(unquote(v.trim()));
            }
            continue;
        }
        if let Some(v) = line.strip_prefix("PERFORMER ") {
            if let Some(t) = current_track.as_mut() {
                t.performer = Some(unquote(v.trim()));
            } else {
                album_artist = Some(unquote(v.trim()));
            }
            continue;
        }
        if let Some(v) = line.strip_prefix("INDEX 01 ") {
            if let Some(t) = current_track.as_mut() {
                t.index01 = v.trim().to_string();
            }
        }
    }
    if let Some(t) = current_track.take() {
        tracks.push(t);
    }
    if tracks.is_empty() {
        return Err("no TRACK entries in cue".to_string());
    }
    Ok(CueData {
        genre: top_rem.get("GENRE").cloned(),
        date: top_rem
            .get("DATE")
            .cloned()
            .or_else(|| fallback_date.map(ToString::to_string)),
        comment: top_rem.get("COMMENT").cloned(),
        album_title,
        album_artist: Some(album_artist.unwrap_or_else(|| circle_name.to_string())),
        tracks,
    })
}

fn cue_index_to_sample(index: &str, sample_rate: u64) -> u64 {
    let mut it = index.split(':');
    let mm = it.next().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let ss = it.next().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let ff = it.next().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    ((mm * 60) + ss) * sample_rate + (ff * sample_rate / 75)
}

fn rename_old(path: &Path) -> Result<(), std::io::Error> {
    let mut target = path.to_path_buf();
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .map(|v| format!("{v}.old"))
        .unwrap_or_else(|| "renamed.old".to_string());
    target.set_file_name(name);
    fs::rename(path, target)
}

fn unquote(s: &str) -> String {
    let trimmed = s.trim();
    let core = if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    core.replace("\\\"", "\"")
}

fn sanitize_file_part(v: &str) -> String {
    let s = if v.is_empty() { "Unknown" } else { v };
    s.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect()
}

fn parse_archive_date(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let token = stem.split_whitespace().next()?;
    let mut p = token.split('.');
    let y = p.next()?;
    let m = p.next()?;
    let d = p.next()?;
    if y.len() == 4 && m.len() == 2 && d.len() == 2 {
        Some(format!("{y}-{m}-{d}"))
    } else {
        None
    }
}

fn rel(exec_dir: &Path, p: &Path) -> String {
    p.strip_prefix(exec_dir)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

fn fe(err: flac_codec::Error) -> String {
    err.to_string()
}

fn ioe(err: std::io::Error) -> String {
    err.to_string()
}

struct Logger {
    exec_dir: PathBuf,
    verbose: File,
    error: File,
}

impl Logger {
    fn new(exec_dir: &Path) -> Result<Self, std::io::Error> {
        Ok(Self {
            exec_dir: exec_dir.to_path_buf(),
            verbose: open_append(exec_dir.join("verbose.log"))?,
            error: open_append(exec_dir.join("error.log"))?,
        })
    }

    fn verbose(&mut self, msg: &str, indent: bool) -> Result<(), String> {
        let line = if indent {
            format!("  {msg}\n")
        } else {
            format!("{msg}\n")
        };
        self.verbose.write_all(line.as_bytes()).map_err(ioe)
    }

    fn error(&mut self, msg: &str) -> Result<(), String> {
        self.error
            .write_all(format!("{msg}\n").as_bytes())
            .map_err(ioe)
    }

    fn append_line(&mut self, file: &str, line: &str) -> Result<(), String> {
        let mut f = open_append(self.exec_dir.join(file)).map_err(ioe)?;
        f.write_all(format!("{line}\n").as_bytes()).map_err(ioe)
    }
}

fn open_append(path: PathBuf) -> Result<File, std::io::Error> {
    OpenOptions::new().create(true).append(true).open(path)
}

#[derive(Debug)]
struct CueData {
    genre: Option<String>,
    date: Option<String>,
    comment: Option<String>,
    album_title: Option<String>,
    album_artist: Option<String>,
    tracks: Vec<TrackData>,
}

#[derive(Debug)]
struct TrackData {
    id: u32,
    title: Option<String>,
    performer: Option<String>,
    index01: String,
}
