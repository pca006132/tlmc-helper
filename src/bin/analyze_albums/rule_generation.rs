use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::OnceLock;

use super::models::{CircleStructured, NameAggregation, RewriteRule, ScoredRewriteRule};
use super::name_utils::{dedup_preserve, dedup_sorted, normalize_name};
use regex::Regex;

static PAREN_MAP: [(char, i32); 8] = [
    ('(', 1),
    (')', -1),
    ('[', 1),
    (']', -1),
    ('【', 1),
    ('】', -1),
    ('〔', 1),
    ('〕', -1),
];

fn normal_split_separators() -> &'static [&'static str] {
    &[
        "ft.", "Ft.", "feat.", "Feat.", " + ", " ＋ ", " x ", "×", " & ", " ＆ ", " / ", " ／ ",
        " vs. ", " vs ", "，", "、", "；", ",", " | ",
    ]
}

fn aggressive_symbol_separators() -> &'static [&'static str] {
    &["&", "＆", "/", "／", "+", "＋"]
}

fn high_confidence_regex_rules() -> &'static [Regex] {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    RES.get_or_init(|| {
        vec![Regex::new(r"(?i)^\s*vo\.\s*(.+?)\s*$").expect("valid leading vo regex")]
    })
}

fn low_confidence_regex_rules() -> &'static [Regex] {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    RES.get_or_init(|| {
        vec![
            Regex::new(r"(?i)^\s*.+?\s*[\(（]\s*cv\s*[:：]\s*(.+?)\s*[\)）]\s*$")
                .expect("valid cv parenthetical regex"),
            Regex::new(r"^\s*(.+?)\s*[\(（\[【〔]\s*.+?\s*[\)）\]】〕]\s*$")
                .expect("valid trailing parenthetical regex"),
        ]
    })
}

pub(super) fn generate_split_stage_output(
    raw_names: &[String],
    normal_split_rules: Vec<RewriteRule>,
    known_names: &HashSet<String>,
) -> (Vec<RewriteRule>, Vec<String>) {
    let split_rules = stage1_generate_split_rules(raw_names, normal_split_rules, known_names);
    let split_rewritten_names = rewrite_name_values(raw_names, &split_rules);
    (split_rules, split_rewritten_names)
}

pub(super) fn generate_compiled_name_rules(
    raw_names: &[String],
    split_rules: Vec<RewriteRule>,
    split_rewritten_names: &[String],
    split_name_counts: &BTreeMap<String, u64>,
    max_iter: usize,
) -> Vec<RewriteRule> {
    let normalize_rules = stage2_generate_normalize_rules(split_rewritten_names, split_name_counts);
    stage3_compile_one_pass_rules(normalize_rules, split_rules, raw_names, max_iter)
}

pub(super) fn count_name_occurrences<'a>(
    values: impl Iterator<Item = &'a String>,
) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    for v in values {
        let key = v.trim();
        if key.is_empty() {
            continue;
        }
        *out.entry(key.to_string()).or_insert(0) += 1;
    }
    out
}

pub(super) fn known_circle_names(artists: &[String], album_artists: &[String]) -> HashSet<String> {
    artists
        .iter()
        .chain(album_artists.iter())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect()
}

pub(super) fn dedup_names_from_circle(
    circle_data: &CircleStructured,
    artist_rules: &[RewriteRule],
    album_artist_rules: &[RewriteRule],
) -> (Vec<String>, Vec<String>) {
    let mut artist_names = Vec::new();
    let mut album_artist_names = Vec::new();
    for album in circle_data.albums.values() {
        let album_aa = super::pipeline_rewriting::rewrite_names(
            album.album_artists.clone(),
            album_artist_rules,
        );
        for disc in &album.discs {
            for track in disc.tracks.values() {
                let track_a =
                    super::pipeline_rewriting::rewrite_names(track.artists.clone(), artist_rules);
                artist_names.extend(track_a);
                album_artist_names.extend(album_aa.iter().cloned());
            }
        }
    }
    (dedup_sorted(artist_names), dedup_sorted(album_artist_names))
}

pub(super) fn dedup_rewrite_rules(rules: Vec<RewriteRule>) -> Vec<RewriteRule> {
    let mut out = Vec::new();
    for mut r in rules {
        r.from = dedup_preserve(r.from);
        r.to = dedup_preserve(r.to);
        if r.from.is_empty() || r.to.is_empty() {
            continue;
        }
        if let Some(existing) = out
            .iter_mut()
            .find(|x: &&mut RewriteRule| same_name_set(&x.to, &r.to))
        {
            existing.from.extend(r.from);
            let merged_from = std::mem::take(&mut existing.from);
            existing.from = dedup_preserve(merged_from);
            continue;
        }
        if out
            .iter()
            .any(|x: &RewriteRule| x.from == r.from && x.to == r.to)
        {
            continue;
        }
        out.push(r);
    }
    out
}

pub(super) fn aggregate_names_for_track(values: &[String]) -> NameAggregation {
    if values.len() == 1 {
        let split = dedup_preserve(
            split_candidates(&values[0])
                .into_iter()
                .filter(|v| !v.is_empty())
                .collect(),
        );
        let mut split_rules = Vec::new();
        let source = values[0].trim().to_string();
        if !source.is_empty() && split != vec![source.clone()] {
            split_rules.push(RewriteRule {
                from: vec![source],
                to: split.clone(),
            });
        }
        return NameAggregation {
            names: split,
            split_rules,
        };
    }
    NameAggregation {
        names: dedup_preserve(
            values
                .iter()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect(),
        ),
        split_rules: Vec::new(),
    }
}

fn stage1_generate_split_rules(
    raw_names: &[String],
    normal_split_rules: Vec<RewriteRule>,
    known_names: &HashSet<String>,
) -> Vec<RewriteRule> {
    let aggressive_rules = build_aggressive_split_rules(raw_names, known_names);
    let merged_split_rules =
        dedup_rewrite_rules(normal_split_rules.into_iter().chain(aggressive_rules).collect());
    let scored_split_rules = score_split_rule_confidence(merged_split_rules, known_names);
    order_split_rules_by_confidence(scored_split_rules)
}

fn stage2_generate_normalize_rules(
    split_rewritten_names: &[String],
    split_name_counts: &BTreeMap<String, u64>,
) -> Vec<RewriteRule> {
    let low_confidence_regex_rules = build_low_confidence_regex_rules(split_rewritten_names);
    let high_confidence_regex_rules = build_high_confidence_regex_rules(split_rewritten_names);
    let simple_normalize_rules =
        build_simple_normalize_rules(split_rewritten_names, split_name_counts);
    dedup_rewrite_rules(
        low_confidence_regex_rules
            .into_iter()
            .chain(high_confidence_regex_rules)
            .chain(simple_normalize_rules)
            .collect(),
    )
}

fn stage3_compile_one_pass_rules(
    normalize_rules: Vec<RewriteRule>,
    split_rules: Vec<RewriteRule>,
    raw_names: &[String],
    max_iter: usize,
) -> Vec<RewriteRule> {
    let merged_rules =
        dedup_rewrite_rules(normalize_rules.into_iter().chain(split_rules).collect());
    let compiled = saturate_generated_rules(merged_rules, max_iter);
    retain_generated_rules_with_reachable_matches(compiled, raw_names, max_iter)
}

fn saturate_generated_rules(rules: Vec<RewriteRule>, max_iter: usize) -> Vec<RewriteRule> {
    let mut out = dedup_rewrite_rules(rules);
    for _ in 0..max_iter {
        let snapshot = out.clone();
        let mut changed = false;
        for rule in &mut out {
            let mut current = rule.to.clone();
            let mut seen = HashSet::new();
            seen.insert(current.clone());
            for _ in 0..max_iter {
                let next = rewrite_tokens_and_split(current.clone(), &snapshot);
                if next == current || !seen.insert(next.clone()) {
                    break;
                }
                current = next;
            }
            if current != rule.to {
                rule.to = current;
                changed = true;
            }
        }
        out = dedup_rewrite_rules(out);
        if !changed {
            break;
        }
    }
    out
}

fn rewrite_tokens_and_split(input: Vec<String>, rules: &[RewriteRule]) -> Vec<String> {
    let mut out = Vec::new();
    for name in input {
        for token in split_candidates(&name) {
            let mut replaced = false;
            for r in rules {
                if r.from.iter().any(|f| f == &token) {
                    out.extend(r.to.clone());
                    replaced = true;
                    break;
                }
            }
            if !replaced {
                out.push(token);
            }
        }
    }
    dedup_preserve(out)
}

fn score_split_rule_confidence(
    rules: Vec<RewriteRule>,
    known_names: &HashSet<String>,
) -> Vec<ScoredRewriteRule> {
    let known_norm = known_names
        .iter()
        .map(|v| normalize_name(v))
        .collect::<HashSet<_>>();
    rules
        .into_iter()
        .map(|rule| {
            let from_norm = rule
                .from
                .iter()
                .map(|v| normalize_name(v))
                .collect::<HashSet<_>>();
            let confident = rule.to.iter().any(|to| {
                let to_norm = normalize_name(to);
                known_norm.contains(&to_norm) && !from_norm.contains(&to_norm)
            });
            ScoredRewriteRule { rule, confident }
        })
        .collect()
}

fn order_split_rules_by_confidence(scored_rules: Vec<ScoredRewriteRule>) -> Vec<RewriteRule> {
    let mut scored_rules = scored_rules;
    scored_rules.sort_by_key(|r| r.confident);
    scored_rules.into_iter().map(|r| r.rule).collect()
}

fn build_aggressive_split_rules(
    values: &[String],
    known: &HashSet<String>,
) -> Vec<RewriteRule> {
    let mut out = Vec::new();
    let known_norm = known
        .iter()
        .map(|v| normalize_name(v))
        .collect::<HashSet<_>>();
    for current in values
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        let mut worklist = vec![current.clone()];
        let mut final_parts = Vec::new();
        while let Some(name) = worklist.pop() {
            let mut done = false;
            for sep in aggressive_symbol_separators() {
                if done {
                    break;
                }
                let mut offset = 0usize;
                while let Some((left, right, next_offset)) =
                    split_once_outside_parens(&name, sep, offset)
                {
                    let left_seen = known_norm.contains(&normalize_name(&left));
                    let right_seen = known_norm.contains(&normalize_name(&right));
                    if left_seen || right_seen {
                        done = true;
                        for part in [left.clone(), right.clone()] {
                            let part_seen = known_norm.contains(&normalize_name(&part));
                            if !part_seen && contains_aggressive_separator(&part) {
                                worklist.push(part);
                            } else {
                                final_parts.push(part);
                            }
                        }
                        break;
                    }
                    offset = next_offset;
                }
            }
            if !done {
                final_parts.push(name);
            }
        }
        let parts = dedup_preserve(final_parts);
        if parts.len() > 1 {
            out.push(RewriteRule {
                from: vec![current],
                to: parts,
            });
        }
    }
    out
}

fn split_once_outside_parens(
    input: &str,
    sep: &str,
    offset: usize,
) -> Option<(String, String, usize)> {
    let mut depth = 0_i32;
    let mut i = 0;
    while i < input.len() {
        let ch = input[i..].chars().next().unwrap_or('\0');
        let ch_len = ch.len_utf8();
        if let Some(delta) = PAREN_MAP.iter().find(|(p, _)| ch == *p).map(|(_, d)| d) {
            depth = (depth + delta).max(0);
            i += ch_len;
            continue;
        }
        if i >= offset && depth == 0 && input[i..].starts_with(sep) {
            let left = input[..i].trim().to_string();
            let right = input[i + sep.len()..].trim().to_string();
            if !left.is_empty() && !right.is_empty() {
                return Some((left, right, i + sep.len()));
            }
        }
        i += ch_len;
    }
    None
}

fn build_simple_normalize_rules(
    values: &[String],
    counts: &BTreeMap<String, u64>,
) -> Vec<RewriteRule> {
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
        let mut variants = set.into_iter().collect::<Vec<_>>();
        variants.sort();
        let target = variants
            .iter()
            .max_by(|a, b| {
                let ac = counts.get(*a).copied().unwrap_or(0);
                let bc = counts.get(*b).copied().unwrap_or(0);
                ac.cmp(&bc).then_with(|| b.cmp(a))
            })
            .cloned()
            .unwrap_or_default();
        let from = variants
            .into_iter()
            .filter(|v| v != &target)
            .collect::<Vec<_>>();
        if from.is_empty() {
            continue;
        }
        out.push(RewriteRule {
            from,
            to: vec![target],
        });
    }
    out
}

fn build_high_confidence_regex_rules(values: &[String]) -> Vec<RewriteRule> {
    build_regex_capture_rules(values, high_confidence_regex_rules())
}

fn build_low_confidence_regex_rules(values: &[String]) -> Vec<RewriteRule> {
    build_regex_capture_rules(values, low_confidence_regex_rules())
}

fn build_regex_capture_rules(values: &[String], regexes: &[Regex]) -> Vec<RewriteRule> {
    let mut out = Vec::new();
    for value in values {
        let source = value.trim();
        if source.is_empty() {
            continue;
        }
        for re in regexes {
            if let Some(caps) = re.captures(source) {
                let target = caps.get(1).map(|m| m.as_str()).unwrap_or("").trim();
                if target.is_empty() || target == source {
                    break;
                }
                out.push(RewriteRule {
                    from: vec![source.to_string()],
                    to: vec![target.to_string()],
                });
                break;
            }
        }
    }
    out
}

pub(super) fn split_candidates(value: &str) -> Vec<String> {
    let separators = normal_split_separators();
    let mut chunks = vec![value.to_string()];
    for sep in separators.iter().copied() {
        let mut next = Vec::new();
        for c in chunks {
            next.extend(split_outside_parens_many(&c, &[sep]));
        }
        chunks = next;
    }
    chunks
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect()
}

fn split_outside_parens_many(input: &str, seps: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0_i32;
    let mut buf = String::new();
    let mut i = 0;
    while i < input.len() {
        let ch = input[i..].chars().next().unwrap_or('\0');
        let ch_len = ch.len_utf8();
        if let Some(delta) = PAREN_MAP.iter().find(|(p, _)| ch == *p).map(|(_, d)| d) {
            depth = (depth + delta).max(0);
            buf.push(ch);
            i += ch_len;
            continue;
        }
        let mut matched = None;
        if depth == 0 {
            for sep in seps {
                if input[i..].starts_with(sep) {
                    matched = Some(*sep);
                    break;
                }
            }
        }
        if let Some(sep) = matched {
            let part = buf.trim().to_string();
            if !part.is_empty() {
                out.push(part);
            }
            buf.clear();
            i += sep.len();
            continue;
        }
        buf.push(ch);
        i += ch_len;
    }
    let tail = buf.trim().to_string();
    if !tail.is_empty() {
        out.push(tail);
    }
    if out.is_empty() {
        vec![input.trim().to_string()]
    } else {
        out
    }
}

fn contains_aggressive_separator(value: &str) -> bool {
    aggressive_symbol_separators()
        .iter()
        .any(|sep| value.contains(sep))
}

fn rewrite_name_values(values: &[String], rules: &[RewriteRule]) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        out.extend(super::pipeline_rewriting::rewrite_names(
            vec![value.clone()],
            rules,
        ));
    }
    dedup_sorted(out)
}

fn retain_generated_rules_with_reachable_matches(
    rules: Vec<RewriteRule>,
    values: &[String],
    max_iter: usize,
) -> Vec<RewriteRule> {
    let mut reachable = values
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect::<HashSet<_>>();
    let mut frontier = reachable.iter().cloned().collect::<Vec<_>>();
    for _ in 0..max_iter {
        let mut next_frontier = Vec::new();
        for name in frontier {
            let rewritten = rewrite_tokens_and_split(vec![name], &rules);
            for token in rewritten {
                if reachable.insert(token.clone()) {
                    next_frontier.push(token);
                }
            }
        }
        if next_frontier.is_empty() {
            break;
        }
        frontier = next_frontier;
    }
    dedup_rewrite_rules(
        rules
            .into_iter()
            .filter(|r| r.from.iter().any(|from| reachable.contains(from)))
            .collect(),
    )
}

fn same_name_set(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let sa = a.iter().cloned().collect::<BTreeSet<_>>();
    let sb = b.iter().cloned().collect::<BTreeSet<_>>();
    sa == sb
}
