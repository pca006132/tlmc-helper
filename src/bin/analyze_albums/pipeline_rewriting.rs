use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use tlmc::logger::Logger;

use super::models::{CircleRewriting, CircleStructured, RewriteRule};
use super::name_utils::dedup_preserve;

pub(super) fn run_rewriting_stage(
    exec_dir: &Path,
    structured_data: &BTreeMap<String, CircleStructured>,
    logger: &mut Logger,
) -> Result<BTreeMap<String, CircleRewriting>, String> {
    let rewriting_path = exec_dir.join("rewriting.json");
    let rewriting_existing = read_rewriting_if_exists(&rewriting_path)?;
    let rewriting_data = super::rewriting::build_rewriting_from_structured(
        structured_data,
        rewriting_existing.as_ref(),
    );
    let rewriting_json =
        serde_json::to_string_pretty(&rewriting_data).map_err(|e| e.to_string())?;
    fs::write(&rewriting_path, rewriting_json).map_err(|e| e.to_string())?;
    validate_rewrite_chains(&rewriting_data, logger)?;
    Ok(rewriting_data)
}

pub(super) fn rewrite_names(input: Vec<String>, rules: &[RewriteRule]) -> Vec<String> {
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

pub(super) fn rewrite_genre(
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

pub(super) fn chain_rules_with_global(
    primary: &[RewriteRule],
    global: Option<&Vec<RewriteRule>>,
) -> Vec<RewriteRule> {
    let mut out = primary.to_vec();
    if let Some(global) = global {
        out.extend(global.iter().cloned());
    }
    out
}

pub(super) fn apply_rewrites_to_structured_new(
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

pub(super) fn count_substring_hits(
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

fn read_rewriting_if_exists(path: &Path) -> Result<Option<BTreeMap<String, CircleRewriting>>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let parsed = serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(Some(parsed))
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
