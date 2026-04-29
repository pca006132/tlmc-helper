use std::collections::BTreeMap;

use super::models::{CircleRewriting, CircleStructured};
use super::name_utils::dedup_sorted;

pub(super) fn build_rewriting_from_structured(
    structured: &BTreeMap<String, CircleStructured>,
    existing: Option<&BTreeMap<String, CircleRewriting>>,
) -> BTreeMap<String, CircleRewriting> {
    let mut effective_structured = structured.clone();
    if let Some(existing_rules) = existing {
        super::pipeline_rewriting::apply_rewrites_to_structured_new(
            &mut effective_structured,
            existing_rules,
        );
    }

    let mut out = BTreeMap::new();
    for (circle, circle_data) in &effective_structured {
        let mut genres = Vec::new();
        for album in circle_data.albums.values() {
            for disc in &album.discs {
                for track in disc.tracks.values() {
                    if let Some(genre) = &track.genre
                        && !genre.trim().is_empty()
                    {
                        genres.push(genre.clone());
                    }
                }
            }
        }
        let all_genres = dedup_sorted(genres);
        let (final_artist_rules, final_album_artist_rules, final_genre_rules, final_default_genre) =
            if let Some(existing_all) = existing {
                if let Some(existing_circle) = existing_all.get(circle) {
                    (
                        super::rule_generation::dedup_rewrite_rules(
                            existing_circle.artists_rewriting.clone(),
                        ),
                        super::rule_generation::dedup_rewrite_rules(
                            existing_circle.album_artists_rewriting.clone(),
                        ),
                        super::rule_generation::dedup_rewrite_rules(
                            existing_circle.genre_rewriting.clone(),
                        ),
                        existing_circle.default_genre.clone(),
                    )
                } else {
                    // rewriting.json exists: never auto-generate new rules for new circles.
                    (Vec::new(), Vec::new(), Vec::new(), None)
                }
            } else {
                let Some(raw_circle_data) = structured.get(circle) else {
                    continue;
                };
                let mut normal_split_rules_artists = Vec::new();
                let mut normal_split_rules_album_artists = Vec::new();
                let mut raw_artist_names = Vec::new();
                let mut raw_album_artist_names = Vec::new();
                for album in raw_circle_data.albums.values() {
                    for aa in &album.album_artists {
                        raw_album_artist_names.push(aa.clone());
                    }
                    let aa_aggr =
                        super::rule_generation::aggregate_names_for_track(&album.album_artists);
                    normal_split_rules_album_artists.extend(aa_aggr.split_rules);
                    for disc in &album.discs {
                        for track in disc.tracks.values() {
                            raw_artist_names.extend(track.artists.iter().cloned());
                            let a_aggr =
                                super::rule_generation::aggregate_names_for_track(&track.artists);
                            normal_split_rules_artists.extend(a_aggr.split_rules);
                        }
                    }
                }
                let known_names = super::rule_generation::known_circle_names(
                    &raw_artist_names,
                    &raw_album_artist_names,
                );
                let (artist_stage1, album_artist_stage1) = (
                    super::rule_generation::generate_split_stage_output(
                        &raw_artist_names,
                        super::rule_generation::dedup_rewrite_rules(normal_split_rules_artists),
                        &known_names,
                    ),
                    super::rule_generation::generate_split_stage_output(
                        &raw_album_artist_names,
                        super::rule_generation::dedup_rewrite_rules(
                            normal_split_rules_album_artists,
                        ),
                        &known_names,
                    ),
                );
                let split_name_counts = super::rule_generation::count_name_occurrences(
                    artist_stage1.1.iter().chain(album_artist_stage1.1.iter()),
                );
                (
                    super::rule_generation::generate_compiled_name_rules(
                        &raw_artist_names,
                        artist_stage1.0,
                        &artist_stage1.1,
                        &split_name_counts,
                        5,
                    ),
                    super::rule_generation::generate_compiled_name_rules(
                        &raw_album_artist_names,
                        album_artist_stage1.0,
                        &album_artist_stage1.1,
                        &split_name_counts,
                        5,
                    ),
                    Vec::new(),
                    None,
                )
            };

        let count_artist_rules = final_artist_rules.clone();
        let count_album_artist_rules = final_album_artist_rules.clone();
        let mut count_track_fields: Vec<(Vec<String>, Vec<String>)> = Vec::new();
        for album in circle_data.albums.values() {
            let album_aa = super::pipeline_rewriting::rewrite_names(
                album.album_artists.clone(),
                &count_album_artist_rules,
            );
            for disc in &album.discs {
                for track in disc.tracks.values() {
                    let track_a = super::pipeline_rewriting::rewrite_names(
                        track.artists.clone(),
                        &count_artist_rules,
                    );
                    count_track_fields.push((track_a, album_aa.clone()));
                }
            }
        }
        let (rewritten_artist_names, rewritten_album_artist_names) =
            super::rule_generation::dedup_names_from_circle(
                circle_data,
                &count_artist_rules,
                &count_album_artist_rules,
            );

        let rewriting = CircleRewriting {
            all_album_artists: super::pipeline_rewriting::count_substring_hits(
                &rewritten_album_artist_names,
                &count_track_fields,
            ),
            album_artists_rewriting: final_album_artist_rules,
            all_artists: super::pipeline_rewriting::count_substring_hits(
                &rewritten_artist_names,
                &count_track_fields,
            ),
            artists_rewriting: final_artist_rules,
            all_genres,
            genre_rewriting: final_genre_rules,
            default_genre: final_default_genre,
        };
        out.insert(circle.clone(), rewriting);
    }
    let all_entry = build_global_rewriting_entry(&effective_structured, &out, existing);
    out.insert("$all".to_string(), all_entry);
    out
}

fn build_global_rewriting_entry(
    structured: &BTreeMap<String, CircleStructured>,
    per_circle: &BTreeMap<String, CircleRewriting>,
    existing: Option<&BTreeMap<String, CircleRewriting>>,
) -> CircleRewriting {
    let existing_all = existing.and_then(|v| v.get("$all"));
    let global_artist_rules = existing_all
        .map(|v| super::rule_generation::dedup_rewrite_rules(v.artists_rewriting.clone()))
        .unwrap_or_default();
    let global_album_artist_rules = existing_all
        .map(|v| super::rule_generation::dedup_rewrite_rules(v.album_artists_rewriting.clone()))
        .unwrap_or_default();
    let global_genre_rules = existing_all
        .map(|v| super::rule_generation::dedup_rewrite_rules(v.genre_rewriting.clone()))
        .unwrap_or_default();
    let global_default_genre = existing_all.and_then(|v| v.default_genre.clone());

    let mut all_genres = Vec::new();
    let mut track_fields: Vec<(Vec<String>, Vec<String>)> = Vec::new();
    let mut rewritten_artist_values = Vec::new();
    let mut rewritten_album_artist_values = Vec::new();

    for (circle_name, circle_data) in structured {
        let Some(circle_rules) = per_circle.get(circle_name) else {
            continue;
        };
        let artist_rules = super::pipeline_rewriting::chain_rules_with_global(
            &circle_rules.artists_rewriting,
            Some(&global_artist_rules),
        );
        let album_artist_rules = super::pipeline_rewriting::chain_rules_with_global(
            &circle_rules.album_artists_rewriting,
            Some(&global_album_artist_rules),
        );
        let genre_rules = super::pipeline_rewriting::chain_rules_with_global(
            &circle_rules.genre_rewriting,
            Some(&global_genre_rules),
        );

        for album in circle_data.albums.values() {
            let album_aa = super::pipeline_rewriting::rewrite_names(
                album.album_artists.clone(),
                &album_artist_rules,
            );
            rewritten_album_artist_values.extend(album_aa.iter().cloned());
            for disc in &album.discs {
                for track in disc.tracks.values() {
                    let track_a = super::pipeline_rewriting::rewrite_names(
                        track.artists.clone(),
                        &artist_rules,
                    );
                    rewritten_artist_values.extend(track_a.iter().cloned());
                    track_fields.push((track_a, album_aa.clone()));
                    let genre = super::pipeline_rewriting::rewrite_genre(
                        track.genre.clone(),
                        &genre_rules,
                        circle_rules
                            .default_genre
                            .clone()
                            .or_else(|| global_default_genre.clone()),
                    );
                    if let Some(g) = genre
                        && !g.trim().is_empty()
                    {
                        all_genres.push(g);
                    }
                }
            }
        }
    }

    let all_artists = dedup_sorted(rewritten_artist_values);
    let all_album_artists = dedup_sorted(rewritten_album_artist_values);
    CircleRewriting {
        all_album_artists: super::pipeline_rewriting::count_substring_hits(
            &all_album_artists,
            &track_fields,
        ),
        album_artists_rewriting: global_album_artist_rules,
        all_artists: super::pipeline_rewriting::count_substring_hits(&all_artists, &track_fields),
        artists_rewriting: global_artist_rules,
        all_genres: dedup_sorted(all_genres),
        genre_rewriting: global_genre_rules,
        default_genre: global_default_genre,
    }
}
