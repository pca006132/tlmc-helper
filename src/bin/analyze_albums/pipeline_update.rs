use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::models::{CircleRewriting, CircleStructured};

pub(super) fn run_update_stage(
    metadata: &BTreeMap<String, Map<String, Value>>,
    structured_data: &BTreeMap<String, CircleStructured>,
    rewriting_data: &BTreeMap<String, CircleRewriting>,
) -> Result<Map<String, Value>, String> {
    let mut updated_metadata = metadata.clone();
    let all_rewriting = rewriting_data.get("$all");

    for (track_path, orig) in metadata {
        let (circle, _, _) = super::pipeline_structured::parse_track_path(track_path)?;
        let Some(circle_cfg) = rewriting_data.get(&circle) else {
            continue;
        };
        let artist_rules = super::pipeline_rewriting::chain_rules_with_global(
            &circle_cfg.artists_rewriting,
            all_rewriting.map(|v| &v.artists_rewriting),
        );
        let album_artist_rules = super::pipeline_rewriting::chain_rules_with_global(
            &circle_cfg.album_artists_rewriting,
            all_rewriting.map(|v| &v.album_artists_rewriting),
        );
        let genre_rules = super::pipeline_rewriting::chain_rules_with_global(
            &circle_cfg.genre_rewriting,
            all_rewriting.map(|v| &v.genre_rewriting),
        );
        let artists =
            super::pipeline_rewriting::rewrite_names(super::pipeline_structured::get_list(orig, "Artists"), &artist_rules);
        let album_artists = super::pipeline_rewriting::rewrite_names(
            super::pipeline_structured::get_list(orig, "Album artists"),
            &album_artist_rules,
        );
        let genre = super::pipeline_rewriting::rewrite_genre(
            super::pipeline_structured::get_s(orig, "Genre"),
            &genre_rules,
            circle_cfg
                .default_genre
                .clone()
                .or_else(|| all_rewriting.and_then(|v| v.default_genre.clone())),
        );
        let mut patch = Map::new();
        if artists != super::pipeline_structured::get_list(orig, "Artists") {
            patch.insert(
                "Artists".to_string(),
                Value::Array(artists.into_iter().map(Value::String).collect()),
            );
        }
        if album_artists != super::pipeline_structured::get_list(orig, "Album artists") {
            patch.insert(
                "Album artists".to_string(),
                Value::Array(album_artists.into_iter().map(Value::String).collect()),
            );
        }
        if genre != super::pipeline_structured::get_s(orig, "Genre")
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
    let (mut structured_new, _) =
        super::pipeline_structured::build_structured_from_metadata(updated_metadata)?;
    overlay_track_data_from_old(&mut structured_new, structured_data);
    super::pipeline_rewriting::apply_rewrites_to_structured_new(&mut structured_new, rewriting_data);

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
    Ok(updates)
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
                    if let Some(date) = &track.date {
                        m.insert("Date".to_string(), Value::String(date.clone()));
                    }
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
                    if let Some(genre) = &track.genre {
                        m.insert("Genre".to_string(), Value::String(genre.clone()));
                    }
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
