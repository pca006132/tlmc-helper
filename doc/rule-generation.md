# Rule Generation

This document describes how TLMC currently generates initial artist and album
artist rewriting rules. It does not describe how manual rules are applied in
full; see `data.md` for the `rewriting.json` format and rewrite semantics.

Rule generation is a helper, not an authority. Its job is to produce useful
first-pass suggestions for common messy tags: joined artist fields, full-width
variants, case/spacing variants, role prefixes, parenthetical affiliations, and
`CV:` notations. The output is still meant to be reviewed.

## When It Runs

Rules are generated per circle when `rewriting.json` has no entry for that
circle. This happens on first import/sync, and can also happen later when a new
circle appears in `structured.json`.

Existing circle rules are preserved. `$all` rules are not generated
automatically; they are only preserved from an existing `rewriting.json`.

Generation runs separately for:

- `artists rewriting`
- `album artists rewriting`

Genre rules are not generated automatically.

## Inputs

Generation starts from `structured.json`. Initial `structured.json` should mirror
the artist arrays from `metadata.json`; artist splitting belongs in generated
rewriting rules, not in the structured source.

For a circle, the generator collects:

- current track artist names from every track's `artists`;
- current album artist names from every album's `album artists`;
- split rules found by re-running the split heuristics on those current names.

The Web/CLI generation code does not split on `;`. That tokenization happens
earlier in `scan-albums`, which emits `Artists` and `Album artists` arrays in
`metadata.json`.

The generator also builds a global set of known names from current artist and
album artist values across all circles. Aggressive split rules and
low-confidence capture ordering use this set. Generated rules are still scoped
to the current circle unless they are manually moved to `$all`.

## Pipeline

The pipeline has three stages:

1. Generate split rules.
2. Generate normalization rules from the split names.
3. Saturate and prune generated rules.

The main intuition is: split obvious joined names first, normalize the pieces,
make generated rule outputs look complete, then keep only suggestions that can
actually affect the current source names.

## Stage 1: Split Rules

Split rules turn one source name into several names:

```json
{ "from": ["Alice + Bob"], "to": ["Alice", "Bob"] }
```

### Normal Splits

Normal split candidates are made only when the current artist list contains
exactly one value. If a track or album already has multiple artist values, those
values are treated as already tokenized.

Normal splitting scans outside parentheses/brackets and uses these separators:

- `ft.`, `Ft.`
- `feat.`, `Feat.`
- ` + `, ` ＋ `
- ` x `
- `×`
- ` & `, ` ＆ `
- ` / `, ` ／ `
- ` vs. `, ` vs `
- `，`, `、`, `；`, `,`
- ` | `

The spaced symbolic separators are intentionally conservative. For example,
`A + B` is split normally, but `A+B` is left for aggressive splitting.

Parentheses and several bracket forms protect their contents from splitting:

- `(...)`
- `[...]`
- `【...】`
- `〔...〕`

### Aggressive Splits

Aggressive splitting tries no-space symbolic separators:

- `&`, `＆`
- `/`, `／`
- `+`, `＋`

This is gated by known names. For each candidate split, at least one side must
match a known name after simple normalization. If neither side is known, the
split is rejected.

When a split is accepted, unresolved sides that still contain aggressive
separators are pushed back onto a worklist and may be split again. This allows
names like `Alice/Bob+Carol` to be broken down incrementally when enough pieces
are recognized.

### Split Rule Ordering

Split rules are scored by confidence. A split is considered confident if at
least one `to` value is already a known name after normalization and is not just
the original `from` value.

Less-confident split rules are placed earlier in the JSON output. This makes the
more suspicious suggestions easier to review first in the UI/file.

## Stage 2: Normalization Rules

After split rules are generated, they are applied to the current names to produce
a set of split names. Normalization rules are generated from those split names.

There are three normalization groups, emitted in this order:

1. Low-confidence regex rules.
2. High-confidence regex rules.
3. Simple normalization rules.

### Low-Confidence Regex Rules

These are useful but riskier, so they are placed first for review. Each
low-confidence heuristic is defined as a regex plus an ordered list of named
capture groups. Non-empty captures are ordered with known names first, then
remaining captures follow the configured group order. Only the first ordered
capture is emitted as the rule's `to` value.

`CV:` extraction:

```text
Role (CV: Alice) -> Alice
Role（CV：Alice） -> Alice
```

Parenthetical affiliation stripping:

```text
Alice (Circle) -> Alice
Alice【Circle】 -> Alice
```

The affiliation rule keeps the text before the first parenthetical/bracketed
suffix. This is helpful for names like `Alice (Example Circle)`, but it can be
wrong when the parenthetical text is part of the real artist name.

Role-prefix suggestions:

```text
arr. Alice -> Alice
guitar: Alice -> Alice
lyrics Alice -> Alice
```

These are low-confidence because role labels can be ambiguous and the label
itself is not always separable from the name.

### High-Confidence Regex Rules

Vocal prefixes are stripped as high-confidence rules, case-insensitively:

```text
vo. Alice -> Alice
VO. Alice -> Alice
vocal: Alice -> Alice
vocals Alice -> Alice
```

### Simple Normalization Rules

Simple normalization groups names that become identical after:

- folding full-width ASCII to half-width ASCII;
- applying Unicode `NFKC` normalization;
- converting CJK variants toward Simplified Chinese with `opencc-js`;
- lowercasing;
- removing whitespace;
- normalizing curly single and double quotes to straight quotes.

For each normalized group, the canonical target is the most frequent original
spelling. Ties are broken deterministically by string order. Other variants are
mapped to that target.

The expensive OpenCC/NFKC conversion and the cheaper comparison-key steps are
cached separately. OpenCC conversion is preloaded for known/current names before
split rule generation; split gating and later normalization then reuse that
converted text and run only the cheaper remaining key steps when possible. The
normalization key does not need repeated normalization passes.

Example:

```json
{ "from": ["ＡＬＩＣＥ", "alice"], "to": ["Alice"] }
```

## Stage 3: Saturate And Prune

Generated split and normalization rules can imply multiple steps. Runtime
rewriting compiles rules into a saturated lookup table, and generated JSON is
also saturated so the `to` side of each generated rule looks complete on its
own.

For example, if generation finds both:

```text
Alice + ＢＯＢ -> Alice, ＢＯＢ
ＢＯＢ -> Bob
```

the emitted split rule becomes:

```text
Alice + ＢＯＢ -> Alice, Bob
```

After saturation, unreachable generated rules are pruned. A generated rule is
kept only if at least one `from` value can be reached from the current source
names through the generated split/rewrite process. There is no fixed iteration
limit; cycles are treated as errors instead.

## Deduplication

Generated rules are cleaned up before output:

- empty `from` or `to` rules are dropped;
- duplicate names inside `from` and `to` are removed while preserving order;
- rules with the same `to` set are merged by combining their `from` lists.

This is an output cleanup detail. Users should care about the resulting rewrite
behavior, not the exact internal merge order.

## Outsider Review

The overall pipeline is understandable: split first, normalize second, then
saturate and prune generated rules. The strongest part is that aggressive
splitting is gated by known names from the library, which avoids many bad
no-space splits.

The parts that feel weird or overly complicated and are worth revisiting:

- Aggressive splitting uses a worklist and accepts a split if either side is a
  known name. This is clever, but hard to reason about for ambiguous names with
  multiple separators.
- Confidence currently affects output order only. It does not annotate rules,
  block low-confidence rules, or expose confidence directly in JSON.
- Parenthetical stripping is broad. It handles many affiliation tags, but may
  produce wrong suggestions for real names that include parentheses.
- Role-prefix handling is still policy-heavy. `vocal` variants are high
  confidence, while arranger/instrument/lyrics/mix/design prefixes are
  low-confidence suggestions.
- CJK comparison normalization is useful, but choosing the emitted canonical
  spelling still depends on occurrence counts and deterministic tie-breaking.
