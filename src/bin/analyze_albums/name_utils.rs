use std::collections::HashSet;

pub(super) fn normalize_name(v: &str) -> String {
    fold_fullwidth_ascii(v)
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .replace(['\'', '“', '”'], "\"")
}

pub(super) fn fold_fullwidth_ascii(input: &str) -> String {
    input
        .chars()
        .map(|c| match c {
            '\u{3000}' => ' ',
            '\u{FF01}'..='\u{FF5E}' => char::from_u32((c as u32) - 0xFEE0).unwrap_or(c),
            _ => c,
        })
        .collect()
}

pub(super) fn dedup_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

pub(super) fn dedup_preserve(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for v in values {
        if seen.insert(v.clone()) {
            out.push(v);
        }
    }
    out
}
