use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::{self};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::UTF_8;
use flac_codec::decode::{FlacSampleReader, Metadata};
use flac_codec::encode::{FlacSampleWriter, Options};
use tlmc::logger::{Logger, ioe, rel};
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
        let circle_dir_name = circle_path
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("")
            .to_string();
        if circle_dir_name.starts_with('.') {
            continue;
        }
        let circle_name = extract_circle_name(&circle_dir_name).unwrap_or_default();
        let circle_valid = !circle_name.is_empty();
        if !circle_valid {
            logger.append_audit("invalid_names", &rel(exec_dir, &circle_path))?;
        }
        let circle_entries = match fs::read_dir(&circle_path) {
            Ok(v) => v,
            Err(err) => {
                logger.error(&format!(
                    "read_dir {} error: {err}",
                    rel(exec_dir, &circle_path)
                ))?;
                continue;
            }
        };
        let mut rar_by_album_dir: BTreeMap<PathBuf, PathBuf> = BTreeMap::new();
        let mut album_dirs: BTreeMap<PathBuf, Option<PathBuf>> = BTreeMap::new();
        for entry in circle_entries {
            let entry = match entry {
                Ok(v) => v,
                Err(err) => {
                    logger.error(&format!("album entry error in {circle_dir_name}: {err}"))?;
                    continue;
                }
            };
            let path = entry.path();
            if path.is_dir() {
                album_dirs.entry(path).or_insert(None);
                continue;
            }
            if path.extension().and_then(OsStr::to_str) == Some("rar") {
                let album_dir = path.with_extension("");
                rar_by_album_dir.insert(album_dir, path);
            }
        }
        for (album_dir, rar_path) in rar_by_album_dir {
            album_dirs.insert(album_dir, Some(rar_path));
        }
        for (album_dir, rar_path) in album_dirs {
            let ctx = AlbumContext {
                circle_name: circle_name.clone(),
                circle_valid,
                album_dir: album_dir.clone(),
                album_valid: album_dir
                    .file_name()
                    .and_then(OsStr::to_str)
                    .map(is_valid_album_name)
                    .unwrap_or(false),
                rar_path: rar_path.clone(),
            };
            if !ctx.album_valid {
                logger.append_audit("invalid_names", &rel(exec_dir, &ctx.album_dir))?;
            }
            if let Err(err) = process_album_target(exec_dir, logger, &ctx) {
                let target = ctx
                    .rar_path
                    .clone()
                    .unwrap_or_else(|| ctx.album_dir.clone());
                logger.error(&format!(
                    "album target failed {}: {err}",
                    rel(exec_dir, &target)
                ))?;
            }
        }
    }
    Ok(())
}

fn process_album_target(
    exec_dir: &Path,
    logger: &mut Logger,
    ctx: &AlbumContext,
) -> Result<(), String> {
    let album_dir = &ctx.album_dir;
    if let Some(rar_path) = ctx.rar_path.as_deref() {
        if !album_dir.exists() {
            fs::create_dir_all(album_dir).map_err(ioe)?;
            extract_rar(rar_path, album_dir).map_err(|e| e.to_string())?;
            logger.verbose(&format!("extracted from {}", rel(exec_dir, rar_path)), true)?;
        } else {
            logger.verbose("album directory already exists, skipping extract", true)?;
        }
    } else if !album_dir.exists() {
        return Ok(());
    }
    if has_processed_marker(album_dir) {
        logger.verbose(
            &format!(
                "skip processed album (found .flac.old/.cue.old): {}",
                rel(exec_dir, album_dir)
            ),
            true,
        )?;
        return Ok(());
    }
    process_album(exec_dir, logger, ctx)
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

fn process_album(exec_dir: &Path, logger: &mut Logger, ctx: &AlbumContext) -> Result<(), String> {
    let album_dir = &ctx.album_dir;
    logger.verbose(&format!("album: {}", rel(exec_dir, album_dir)), false)?;
    let (flacs, cues) = scan_album_files(album_dir);
    if cues.is_empty() {
        logger.verbose(
            &format!("nothing to split in {}", rel(exec_dir, album_dir)),
            true,
        )?;
        return Ok(());
    }
    let pairing = pair_flac_cue(&flacs, &cues);
    let pairs = pairing.pairs;
    for info in pairing.ambiguous {
        logger.append_audit(
            "ambiguous_pairing",
            &format!(
                "{} | flac={} | cues={}",
                rel(exec_dir, album_dir),
                rel(exec_dir, &info.flac),
                info.cues
                    .iter()
                    .map(|c| rel(exec_dir, c))
                    .collect::<Vec<_>>()
                    .join(" , ")
            ),
        )?;
    }
    for f in &flacs {
        if !pairs.iter().any(|(pf, _)| pf == f) {
            logger.append_audit("missing_cue", &rel(exec_dir, f))?;
            logger.verbose(&format!("missing cue: {}", rel(exec_dir, f)), true)?;
        }
    }
    for c in &cues {
        if !pairs.iter().any(|(_, pc)| pc == c) {
            logger.append_audit("missing_flac", &rel(exec_dir, c))?;
            logger.verbose(&format!("missing flac: {}", rel(exec_dir, c)), true)?;
        }
    }
    if pairs.len() > 1 {
        logger.append_audit("multi_disc", &rel(exec_dir, album_dir))?;
    }
    let fallback_date = ctx
        .rar_path
        .as_deref()
        .and_then(parse_archive_date)
        .or_else(|| {
            album_dir
                .file_name()
                .and_then(OsStr::to_str)
                .and_then(parse_album_date)
        });
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
        match process_pair(
            exec_dir,
            logger,
            ctx,
            &flac_path,
            &cue_path,
            fallback_date.as_deref(),
            is_multi_disc,
        ) {
            Ok(()) => {}
            Err(PairError::Pair(err)) => {
                logger.error(&format!(
                    "pair failed {} / {}: {err}",
                    rel(exec_dir, &flac_path),
                    rel(exec_dir, &cue_path)
                ))?;
            }
            Err(PairError::SkipAlbum(err)) => {
                logger.error(&format!(
                    "album skipped {}: {err}",
                    rel(exec_dir, album_dir)
                ))?;
                return Ok(());
            }
        }
    }
    Ok(())
}

fn has_processed_marker(album_dir: &Path) -> bool {
    WalkDir::new(album_dir)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .any(|e| {
            let path = e.path();
            path.extension().and_then(OsStr::to_str) == Some("old")
                && path
                    .file_stem()
                    .and_then(OsStr::to_str)
                    .map(|v| v.ends_with(".flac") || v.ends_with(".cue"))
                    .unwrap_or(false)
        })
}

fn process_pair(
    exec_dir: &Path,
    logger: &mut Logger,
    ctx: &AlbumContext,
    flac_path: &Path,
    cue_path: &Path,
    fallback_date: Option<&str>,
    use_disc_subdir: bool,
) -> Result<(), PairError> {
    let cue_text = decode_cue(exec_dir, logger, cue_path).map_err(PairError::Pair)?;
    let mut cue = match parse_cue(&cue_text) {
        Ok(v) => v,
        Err(err) => {
            logger
                .append_audit("corrupt_cuesheet", &rel(exec_dir, cue_path))
                .map_err(PairError::Pair)?;
            return Err(PairError::Pair(err));
        }
    };
    resolve_album_metadata(ctx, &mut cue, fallback_date)?;
    let out_dir = if use_disc_subdir {
        ctx.album_dir.join(
            flac_path
                .file_stem()
                .and_then(OsStr::to_str)
                .unwrap_or("disc"),
        )
    } else {
        ctx.album_dir.to_path_buf()
    };
    fs::create_dir_all(&out_dir).map_err(|e| PairError::Pair(ioe(e)))?;

    split_and_tag(exec_dir, logger, flac_path, &out_dir, &cue).map_err(|e| {
        let _ = logger.append_audit("corrupt_cuesheet", &rel(exec_dir, cue_path));
        PairError::Pair(format!("corrupt cuesheet timing: {e}"))
    })?;
    rename_old(flac_path).map_err(|e| PairError::Pair(ioe(e)))?;
    rename_old(cue_path).map_err(|e| PairError::Pair(ioe(e)))?;
    Ok(())
}

fn split_and_tag(
    exec_dir: &Path,
    logger: &mut Logger,
    flac_path: &Path,
    out_dir: &Path,
    cue: &CueData,
) -> Result<(), String> {
    let source_data = Arc::new(fs::read(flac_path).map_err(ioe)?);
    let reader = FlacSampleReader::new_seekable(Cursor::new(source_data.as_slice())).map_err(fe)?;
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
    if let Some(last_start) = starts.last()
        && *last_start > total_samples
    {
        let track_id = cue.tracks.last().map(|t| t.id).unwrap_or(0);
        return Err(format!(
            "track {:02} offset exceeds flac duration (offset={}, total_samples={})",
            track_id, last_start, total_samples
        ));
    }

    let mut jobs = Vec::new();
    for (i, track) in cue.tracks.iter().cloned().enumerate() {
        let start = starts[i];
        let end = if i + 1 < starts.len() {
            starts[i + 1]
        } else {
            total_samples
        };
        if end <= start {
            return Err(format!(
                "track {:02} has non-positive duration (start={start}, end={end})",
                track.id
            ));
        }
        let track_name = sanitize_file_part(track.title.as_deref().unwrap_or(""));
        let filename = format!("{:02} - {}.flac", track.id, track_name);
        let out_path = out_dir.join(filename);
        jobs.push(TrackJob {
            track,
            start,
            end,
            out_path,
        });
    }

    let cue = Arc::new(cue.clone());
    let mut results = Vec::new();
    for job in jobs {
        let source_data = Arc::clone(&source_data);
        let cue = Arc::clone(&cue);
        results.push(process_track_job(source_data, cue, job)?);
    }

    for result in results {
        logger.verbose(&format!("wrote {}", rel(exec_dir, &result.out_path)), true)?;
        if result.missing_info {
            let line = format!("{} track {:02}", rel(exec_dir, flac_path), result.track_id);
            logger.append_audit("missing_info", &line)?;
            logger.verbose(&format!("missing tag info: {line}"), true)?;
        }
    }
    Ok(())
}

fn process_track_job(
    source_data: Arc<Vec<u8>>,
    cue: Arc<CueData>,
    job: TrackJob,
) -> Result<TrackResult, String> {
    let mut reader =
        FlacSampleReader::new_seekable(Cursor::new(source_data.as_slice())).map_err(fe)?;
    let start = job.start;
    let end = job.end;
    let channels = u64::from(reader.channel_count());
    let total_interleaved_samples = (end - start) * channels;
    reader.seek(start).map_err(fe)?;
    let options = build_writer_options(&cue, &job.track);
    let mut writer = FlacSampleWriter::create(
        &job.out_path,
        options,
        reader.sample_rate(),
        reader.bits_per_sample(),
        reader.channel_count(),
        Some(total_interleaved_samples),
    )
    .map_err(fe)?;
    copy_samples(&mut reader, &mut writer, total_interleaved_samples).map_err(fe)?;
    writer.finalize().map_err(fe)?;
    Ok(TrackResult {
        out_path: job.out_path,
        track_id: job.track.id,
        missing_info: cue.album_title.is_none()
            || job.track.title.is_none()
            || job.track.performer.is_none(),
    })
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

fn build_writer_options(cue: &CueData, track: &TrackData) -> Options {
    let mut options = Options::default()
        .tag("ARTIST", track.performer.clone().unwrap_or_default())
        .tag("TITLE", track.title.clone().unwrap_or_default())
        .tag("ALBUM", cue.album_title.clone().unwrap_or_default())
        .tag("TRACKNUMBER", format!("{:02}", track.id))
        .tag("ALBUMARTIST", cue.album_artist.clone().unwrap_or_default());
    if let Some(v) = cue.genre.as_ref() {
        options = options.tag("GENRE", v);
    }
    if let Some(v) = cue.date.as_ref() {
        options = options.tag("DATE", v);
    }
    if let Some(v) = cue.comment.as_ref() {
        options = options.tag("COMMENT", v);
    }
    options
}

fn decode_cue(exec_dir: &Path, logger: &mut Logger, cue_path: &Path) -> Result<String, String> {
    let data = fs::read(cue_path).map_err(ioe)?;
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
    detector.feed(&data, true);
    let encoding = detector.guess(None, Utf8Detection::Allow);
    if encoding != UTF_8 {
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

fn scan_album_files(album_dir: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut flacs = Vec::new();
    let mut cues = Vec::new();
    for entry in WalkDir::new(album_dir).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.into_path();
        match p
            .extension()
            .and_then(OsStr::to_str)
            .map(|v| v.to_ascii_lowercase())
        {
            Some(ext) if ext == "flac" => flacs.push(p),
            Some(ext) if ext == "cue" => cues.push(p),
            _ => {}
        }
    }
    flacs.sort();
    cues.sort();
    (flacs, cues)
}

fn pair_flac_cue(flacs: &[PathBuf], cues: &[PathBuf]) -> PairingResult {
    if flacs.len() == 1 && cues.len() == 1 {
        return PairingResult {
            pairs: vec![(flacs[0].clone(), cues[0].clone())],
            ambiguous: Vec::new(),
        };
    }
    let mut result = Vec::new();
    let mut ambiguous = Vec::new();
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
        } else if candidates.len() > 1 {
            ambiguous.push(AmbiguousMatch {
                flac: flac.clone(),
                cues: candidates.into_iter().map(|i| cues[i].clone()).collect(),
            });
        }
    }
    PairingResult {
        pairs: result,
        ambiguous,
    }
}

fn parse_cue(input: &str) -> Result<CueData, String> {
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
        if let Some(v) = line.strip_prefix("INDEX 01 ")
            && let Some(t) = current_track.as_mut()
        {
            t.index01 = v.trim().to_string();
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
        date: top_rem.get("DATE").cloned(),
        comment: top_rem.get("COMMENT").cloned(),
        album_title,
        album_artist,
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
    parse_album_date(stem)
}

fn resolve_album_metadata(
    ctx: &AlbumContext,
    cue: &mut CueData,
    fallback_date: Option<&str>,
) -> Result<(), PairError> {
    if cue.date.is_none() {
        if let Some(v) = fallback_date {
            cue.date = Some(v.to_string());
        } else if !ctx.album_valid {
            return Err(PairError::SkipAlbum(
                "missing DATE tag and invalid album directory name".to_string(),
            ));
        }
    }
    if cue.album_artist.is_none() {
        if ctx.circle_valid {
            cue.album_artist = Some(ctx.circle_name.clone());
        } else {
            return Err(PairError::SkipAlbum(
                "missing PERFORMER tag and invalid circle directory name".to_string(),
            ));
        }
    }
    Ok(())
}

fn parse_album_date(name: &str) -> Option<String> {
    let token = name.split_whitespace().next()?;
    let mut p = token.split('.');
    let y = p.next()?;
    let m = p.next()?;
    let d = p.next()?;
    if y.len() == 4
        && m.len() == 2
        && d.len() == 2
        && y.chars().all(|c| c.is_ascii_digit())
        && m.chars().all(|c| c.is_ascii_digit())
        && d.chars().all(|c| c.is_ascii_digit())
    {
        Some(format!("{y}-{m}-{d}"))
    } else {
        None
    }
}

fn extract_circle_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix('[') {
        let end = rest.find(']')?;
        let core = rest[..end].trim();
        if core.is_empty() {
            None
        } else {
            Some(core.to_string())
        }
    } else {
        Some(trimmed.to_string())
    }
}

fn is_valid_album_name(name: &str) -> bool {
    parse_album_date(name).is_some()
}

fn fe(err: flac_codec::Error) -> String {
    err.to_string()
}

#[derive(Debug, Clone)]
struct CueData {
    genre: Option<String>,
    date: Option<String>,
    comment: Option<String>,
    album_title: Option<String>,
    album_artist: Option<String>,
    tracks: Vec<TrackData>,
}

#[derive(Debug, Clone)]
struct TrackData {
    id: u32,
    title: Option<String>,
    performer: Option<String>,
    index01: String,
}

#[derive(Debug, Clone)]
struct TrackJob {
    track: TrackData,
    start: u64,
    end: u64,
    out_path: PathBuf,
}

#[derive(Debug)]
struct TrackResult {
    out_path: PathBuf,
    track_id: u32,
    missing_info: bool,
}

struct AlbumContext {
    circle_name: String,
    circle_valid: bool,
    album_dir: PathBuf,
    album_valid: bool,
    rar_path: Option<PathBuf>,
}

struct PairingResult {
    pairs: Vec<(PathBuf, PathBuf)>,
    ambiguous: Vec<AmbiguousMatch>,
}

struct AmbiguousMatch {
    flac: PathBuf,
    cues: Vec<PathBuf>,
}

enum PairError {
    Pair(String),
    SkipAlbum(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use flac_codec::metadata::{self, VorbisComment, fields};
    use tempfile::TempDir;

    #[test]
    fn split_tracks_have_expected_tags_and_duration() {
        let temp = TempDir::new().expect("tempdir");
        copy_dir_all(Path::new("testdata"), temp.path()).expect("copy testdata");
        let exec = temp.path().to_path_buf();

        let mut logger = Logger::new(&exec).expect("logger");
        run(&exec, &mut logger).expect("run");

        let album = exec.join("[circle]/2026.01.01 [ABCD-0123] foo bar [c123]");
        let t1 = album.join("01 - Track One.flac");
        let t2 = album.join("02 - Track Two.flac");
        assert!(t1.exists(), "track 1 should exist");
        assert!(t2.exists(), "track 2 should exist");

        assert_track(&t1, "Track One", "Test Performer", "2026-01-01", 60, 3);
        assert_track(&t2, "Track Two", "Test Performer", "2026-01-01", 53, 3);
    }

    fn assert_track(
        path: &Path,
        title: &str,
        artist: &str,
        date: &str,
        expected_secs: u64,
        tolerance_secs: u64,
    ) {
        let vc = metadata::block::<_, VorbisComment>(path)
            .expect("read vorbis block")
            .expect("vorbis block present");
        assert_eq!(vc.get(fields::TITLE).unwrap_or(""), title);
        assert_eq!(vc.get(fields::ARTIST).unwrap_or(""), artist);
        assert_eq!(vc.get(fields::DATE).unwrap_or(""), date);

        let reader = FlacSampleReader::open(path).expect("read flac");
        let total_samples = reader.total_samples().expect("total samples");
        let sample_rate = u64::from(reader.sample_rate());
        let secs = total_samples / sample_rate;
        let lower = expected_secs.saturating_sub(tolerance_secs);
        let upper = expected_secs + tolerance_secs;
        assert!(
            (lower..=upper).contains(&secs),
            "duration {secs}s should be in [{lower}, {upper}]"
        );
    }

    fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), std::io::Error> {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let to = dst.join(entry.file_name());
            if file_type.is_dir() {
                copy_dir_all(&entry.path(), &to)?;
            } else {
                fs::copy(entry.path(), to)?;
            }
        }
        Ok(())
    }
}
