# TLMC User Guide (English)

中文说明: [README.md](README.md)

## Required input layout (important)

This tool expects TLMC-style directories. It does not try to auto-infer arbitrary layouts.

- Run in a root directory that contains circle folders:
  - `[Circle]`
  - `[Circle] Extra Text`
  - `Circle`
  - for `[XXX] YYY`, only `XXX` is extracted as the circle name
- Each circle folder may contain:
  - album `.rar` files
  - extracted album directories

If the layout is not TLMC-style, grouping/parsing results may be wrong.

Example layout:

```text
MusicLibraryRoot/
├── [RD-Sounds]/
│   ├── 2024.05.03 [RDS-0001] Example Album [Reitaisai].rar
│   └── 2024.05.03 [RDS-0002] Another Album [M3]/
│       ├── disc.flac
│       └── disc.cue
├── [ALiCE'S EMOTiON] Team A/
│   └── 2025.08.16 [AECD-0001] Sample Album/
│       ├── album.flac
│       └── album.cue
└── Shining Symphony/
    └── 2023.12.30 [SS-1234] Winter Works/
        ├── CD1.flac
        └── CD1.cue
```

Key points:
- Run binaries from `MusicLibraryRoot`.
- First-level folders must be circle folders.
- Second-level entries are albums (`.rar` files or extracted folders).
- Second-level album folder names are now parsed with a relaxed rule (`analyze-albums`):
  - optional date prefix: `YYYY` / `YYYY.MM` / `YYYY.MM.DD` (separator `-` also accepted)
  - optional first record-id bracket token, e.g. `[ABCD-1234]`
  - both date and bracket are optional; album-name component is still required

## What each binary does

- `split-album`: extract, pair FLAC/CUE, split, initial tagging
- `scan-albums`: scan existing tags -> `metadata.json`
- `analyze-albums`: unified flow that generates/updates `structured.json` and `rewriting.json`, and always generates `update-metadata.json`
- `apply-tags`: write `update-metadata.json` back to tracks

## Windows users: which `.exe` to click?

In build output (usually `target/release`):

1. `split-album.exe` (optional; only if you need splitting)
2. `scan-albums.exe`
3. `analyze-albums.exe` (first run auto-generates `structured.json` / `rewriting.json` / `update-metadata.json`)
4. edit `structured.json` and/or `rewriting.json`
5. `analyze-albums.exe` (refreshes aggregations and recomputes `update-metadata.json`)
6. `apply-tags.exe`

`.exe` files are directly clickable. `.bat` wrappers are not required. Outputs are persisted to files (`verbose.log`, `audit.json`), and `error.log` is created only when errors occur.

## CLI commands (optional)

```bash
cargo run --bin scan-albums
cargo run --bin analyze-albums
# edit structured.json / rewriting.json
cargo run --bin analyze-albums
cargo run --bin apply-tags
```

## Main files you will use

- `metadata.json`: raw scanned snapshot
- `structured.json`: album/disc/track structure edits
- `rewriting.json`: rewriting rules, default genre, and name counts
- `update-metadata.json`: patch that `apply-tags` consumes (generated on every `analyze-albums` run)
- `audit.json`: all review-needed findings
- `verbose.log`: processing details
- `error.log`: hard errors (exists only if errors occur)

## `structured.json` vs `rewriting.json`

- `structured.json`: structure and track-level editable fields only.
- `rewriting.json`: rewriting and aggregation fields:
  - `all artists` / `all album artists` as `{name: count}`
  - rewriting rules
  - `all genres` / `default genre`
  - special top-level `$all` (same shape): aggregated across all circles; rules are not auto-generated there and are preserved as user-maintained rules

### `structured.json` shape at a glance

Edit `structured.json` and `rewriting.json` together: the former controls structure/track fields, the latter controls name/genre normalization.

`structured.json` hierarchy:

- top level: `circle -> albums`
- `albums`: `album_name -> { "album artists", "discs" }`
- `discs`: array; each disc entry is a dictionary:
  - optional `"$subtitle"`: disc subtitle
  - other keys are `track_path` entries mapping to track objects
- track object fields:
  - required: `title`, `track number`, `artists`
  - optional: `date`, `genre`

## Core rewriting workflow

For each circle:

1. Inspect `all album artists` and `all artists` in `rewriting.json`.
2. Identify variants of the same person/group name (typos, aliases, formatting).
3. Add rewriting rules in `rewriting.json`.
4. Run `analyze-albums` again.
5. Re-check refreshed counts/lists in `rewriting.json` and confirm unwanted variants are gone.

Repeat until the aggregated lists look clean.

## Rewriting rules (one-pass)

Format:

```json
{ "from": ["Old Variant"], "to": ["Target A", "Target B"] }
```

Rules are one-pass per token (not recursive chains).  
Rules with the same `to` target are auto-combined by `to` set equality (order-insensitive), e.g. `A -> C` and `B -> C` become `["A", "B"] -> ["C"]`.

Why we do not rewrite until saturation:

- Some names are genuinely ambiguous; automatic multi-pass rewriting can over-merge into wrong targets.
- One-pass + ordered early-match gives you precise control: place a "keep as-is" or preferred mapping rule earlier to stop later rules from touching that token.
- This lets users intentionally skip downstream matches when needed.

More complex example (aligned with `task.md`):

```json
[
  { "from": ["Aky"], "to": ["Aki"] },
  { "from": ["Aki", "AKI"], "to": ["Akiha"] },
  { "from": ["Akiha x S"], "to": ["Akiha", "S"] }
]
```

- `["Aky"]` -> `["Aki"]` (does not continue to `Akiha`)
- `["Aki"]` -> `["Akiha"]`
- `["Akiha x S"]` -> `["Akiha", "S"]`

Potential chain issues are reported as `rewrite_chain_warning` in `audit.json`.

### Auto-generated rules (`analyze-albums`)

When `rewriting.json` is missing, `analyze-albums` auto-generates initial rules with this flow:

1. Split names first:
   - preprocessing tokenization by `;` and `\u0000`;
   - then split by common joiners/separators (for example ` + `, ` ＋ `, ` x `, ` & `, ` ＆ `, ` / `, ` ／ `, `vs.` / `vs`, `×`, `，`, `、`, `,`; outside parentheses).
2. Normalize name variants:
   - full-width ASCII folding, lowercase, whitespace removal, quote unification;
   - within a normalized variant group, choose the most frequent observed form as canonical target.
3. Low-confidence parenthesis normalization:
   - `NAME (AFFILIATION)` -> `NAME`
   - `ROLE (CV:ARTIST)` -> `ARTIST`
   - these low-confidence rules are placed earlier in output for easier manual review.

## Other important behavior

- `scan-albums` treats `;` as a multi-artist separator.
- `scan-albums` and `apply-tags` support true multi-valued tags for `Artists` / `Album artists`:
  - scanning parses multi-values into arrays;
  - writing applies them back as multi-valued tags (not a single joined string).
- Disc numbering is inferred from `structured.json` disc order (first disc map = Disc 1, etc.).
- `analyze-albums` path parsing is fixed to `circle/album/...` (second-level folder is always the album folder).
- Album folder parsing (regex-based) supports:
  - optional date prefix: `YYYY` / `YYYY.MM` / `YYYY.MM.DD`
  - both `.` and `-` date separators (internally handled with timestamp semantics)
  - optional first record-id bracket token (for example `[ABC-1234]`)
  - extracting the album-name component from the remaining folder text
- Date handling:
  - when metadata date is missing and folder date exists, folder date is used (without inventing month/day)
  - when metadata date is consistent but less precise than folder date, folder date is preferred
  - when inconsistent, metadata is kept and `audit.json.inconsistent_date` is emitted
- `analyze-albums` now runs as a single flow:
  - if `structured.json` is missing, it is built first;
  - if `rewriting.json` is missing, rewriting rules are auto-generated first;
  - if `rewriting.json` exists, rules and `default genre` are preserved, then `all artists` / `all album artists` / `all genres` are refreshed.
- Rewriting priority is: circle-specific rules first, then `$all` rules (lowest priority).

## Recommended checks after each run

- `audit.json`
- `error.log`
- `rewriting.json` (especially after rewriting edits)

## `audit.json` field reference

- `missing_cue`: FLAC exists but matching CUE is missing.  
  Action: fix naming/pairing first, then rerun `split-album`. It can also be a false positive (see "Common false-positive scenario" below).
- `missing_flac`: CUE exists but matching FLAC is missing.  
  Action: check missing files or naming mismatch, then rerun `split-album`. It can also be a false positive (see "Common false-positive scenario" below).
- `multi_disc`: multiple FLAC/CUE pairs detected in one album folder.  
  Action: review disc separation and album naming manually.
- `corrupt_cuesheet`: CUE parse failed, non-positive track duration, or last offset exceeds FLAC duration.  
  Action: fix naming or CUE content, then rerun `split-album`. It can also be a false positive (see "Common false-positive scenario" below).
- `missing_info`: missing metadata fields (commonly artists).  
  Action: complete metadata in `structured.json` or source tags.
- `invalid_names`: directory names do not match expected parseable format.  
  Action: rename directories to TLMC-style format and rerun `split-album` (and then downstream steps).
- `ambiguous_pairing`: FLAC/CUE matching is ambiguous.  
  Action: rename files so pairing is unique, then rerun `split-album`.
- `corrupted_tracks`: unreadable/corrupted audio during scanning.  
  Action: if this comes from split outputs, fix source/naming and rerun `split-album`; if it is scan-only corruption, replace/repair files and rerun `scan-albums`.
- `disc_classification`: fallback disc-classification rule was used.  
  Action: verify `discs` grouping in `structured.json`.
- `different_album_artist`: inconsistent album artists inside album, or mismatch against circle expectation.  
  Action: unify names via rewriting rules or manual edits.
- `rewrite_chain_warning`: potential incomplete chain in one-pass rewriting rules.  
  Action: flatten chain rules so one step maps directly to desired output.
- `inconsistent_date`: metadata date conflicts with date inferred from the album folder.  
  Action: verify the correct source of truth; if folder date is authoritative, fix metadata/structured values and rerun `analyze-albums`.

  Example (why this is bad):
  ```json
  [
    { "from": ["Aky"], "to": ["Aki"] },
    { "from": ["Aki"], "to": ["Akiha"] }
  ]
  ```
  With one-pass rewriting, `Aky` becomes only `Aki` and does not continue to `Akiha`, so intermediate names remain in aggregated lists.  
  Fix: flatten into one-step mapping, for example:
  ```json
  [
    { "from": ["Aky", "Aki"], "to": ["Akiha"] }
  ]
  ```

### Common false-positive scenario (important)

`missing_cue` / `missing_flac` / `corrupt_cuesheet` are not always real data issues.

Typical case: an album folder already contains split tracks, and one split track name is similar to the album name. The program may incorrectly pair an album-level CUE with that short split track. Then:

- that track may be reported as `corrupt_cuesheet` (because the CUE expects a much longer full-album audio file),
- and other tracks in the same album may appear as `missing_cue` or `missing_flac`.

In this situation, if the folder is already split-track output, removing (or moving out) the mismatched album-level CUE is usually enough, because no further splitting is needed there.  
Then rerun `split-album` to clear the false positives.

## Safety

1. Back up first.
2. Validate on a small subset before full library runs.
3. Spot-check `update-metadata.json` before `apply-tags`.
