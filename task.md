# TLMC Current Specification

Single source of truth for current behavior.

## Terms

- Circle (Touhou context): 社團 / group.

## Required Input Layout

- Run binaries in a root directory containing circle folders.
- Circle folder names supported:
  - `[CircleName]`
  - `[CircleName] Extra Text` (extract `CircleName` only)
  - `CircleName`
- Circle folders may contain:
  - album archives (`.rar`)
  - extracted album directories

This layout is required and not auto-inferred.

## Binaries

1. `split-album`
2. `scan-albums`
3. `analyze-albums`
4. `apply-tags`

## Logging / Audit

- `verbose.log`: detailed log, mirrored to stdout.
- `error.log`: created only when errors happen.
- `audit.json`: pretty JSON audit arrays.

Audit fields:
- `missing_cue`
- `missing_flac`
- `multi_disc`
- `corrupt_cuesheet`
- `missing_info`
- `invalid_names`
- `ambiguous_pairing`
- `corrupted_tracks`
- `disc_classification`
- `different_album_artist`
- `rewrite_chain_warning`

All paths in logs/audit are relative to execution directory.

## `split-album`

### Discovery / extraction

- Process extracted album folders even without `.rar`.
- Extract `.rar` only if same-name target folder does not exist.
- Skip album if any `.flac.old` or `.cue.old` exists under it.

### FLAC/CUE pairing

Priority:
1. Single FLAC + single CUE.
2. Exact stem match (case-insensitive).
3. Non-ambiguous substring relation.

Ambiguous relation -> `audit.json.ambiguous_pairing`, do not auto-pair.

### Cue handling

- Decode with `chardetng`.
- Parse with custom parser.
- Treat cue as corrupt if:
  - parse failure
  - any track duration <= 0
  - last track offset exceeds FLAC duration
- Corrupt cue -> `audit.json.corrupt_cuesheet`.

### Tag fallback

- DATE fallback:
  1. archive filename date token
  2. album folder date token
- ALBUMARTIST fallback:
  - extracted circle name

If fallback requires invalid directory naming, skip album and log to `error.log`.

### Output

- Output file: `TRACK_ID - TRACK_NAME.flac`
- Multi-pair albums: subdir per FLAC stem
- Rename source FLAC/CUE to `.old` after success
- Track encode is sequential (no parallel splitting)

## `scan-albums`

- Scan `flac`, `mp3`, `m4a` via `audiotags`.
- Sequential scanning.
- Optional `scan-filter.txt` (one circle per line).
- Without filter, scan all circles.
- Log album only when actual album scan starts.
- Corrupted/unreadable track -> `audit.json.corrupted_tracks`.

### `metadata.json` format

```json
{
  "TRACK_PATH": {
    "Title": "VALUE",
    "Artists": ["VALUE"],
    "Date": "VALUE",
    "Year": "VALUE",
    "Album artists": ["VALUE"],
    "Album title": "VALUE",
    "Track number": 1,
    "Total tracks": 10,
    "Disc number": 1,
    "Total discs": 1,
    "Genre": "VALUE",
    "Comment": "VALUE"
  }
}
```

All fields optional per track.  
`Artists` / `Album artists` parse `;` as separator.

## `analyze-albums`

### Mode switch

- If `structured.json` does not exist -> analysis mode.
- Otherwise -> update mode.

### `structured.json` scope

`structured.json` contains structure/editable track data only:
- albums/discs/tracks
- album artists per album
- track fields (`title`, `date`, `track number`, `artists`, `genre`)

No rewriting/default-genre/all-* aggregation data in `structured.json`.

### `rewriting.json` scope

`rewriting.json` stores rewriting/aggregation data per circle:
- `all album artists`: `{ "name": count }`
- `album artists rewriting`
- `all artists`: `{ "name": count }`
- `artists rewriting`
- `all genres`: list
- `genre rewriting`
- `default genre` (optional)

Count rules:
- case-sensitive substring match
- check artist + album-artist fields together
- each track contributes at most +1 per name

Auto-generation rules:
- First-pass generation order for artists/album-artists:
  1. normalization rules
  2. normal split rules
  3. gated aggressive split rules
- Aggressive split currently targets `&` / `＆` (including no-space forms) and is gated:
  - aggressively split exhaustively (max 5 iterations), then apply normal split behavior
  - emit aggressive rule only if at least one resulting component normalized-form matches another known name in the same circle
- Generated rules are saturated to support one-pass rewriting:
  - saturate rule outputs with max 5 iterations
- Remove auto-generated rules whose `from` side cannot match any source name.

### Analysis mode behavior

Input: `metadata.json`  
Outputs: `structured.json`, `rewriting.json`

Steps:
1. Build `structured.json` from metadata/path parsing.
2. Disc classification:
   - same album title + no disc number -> disc 1
   - explicit disc numbers first
   - remaining grouped by album title with new consecutive disc numbers
   - fallback usage -> `audit.json.disc_classification`
3. Missing artists -> `audit.json.missing_info`
4. Album artist inconsistency/mismatch -> `audit.json.different_album_artist`
5. Generate `rewriting.json` from generated `structured.json`.

### Update mode behavior

Inputs: `metadata.json`, `structured.json`, optional `rewriting.json`  
Outputs: `rewriting.json`, `update-metadata.json`

Steps:
1. If `rewriting.json` missing, generate it from existing `structured.json`.
2. If present, preserve rewriting rules + default genre.
3. Refresh `all artists` / `all album artists` / `all genres` with counting source depending on rewriting existence:
   - if `rewriting.json` missing (fresh generation):
     - derive deduplicated names by applying generated rules to raw names
     - exclude auto-generated normalization rules from counting rewrite application
     - include split + aggressive split rules for counting rewrite application
     - count per-track matches against raw artist/album-artist fields (pre-rewrite)
   - if `rewriting.json` exists:
     - use existing rules as-is (no normalization-vs-other distinction)
     - count per-track matches against rewritten artist/album-artist fields
4. Validate rewrite chains from `rewriting.json`; emit deduped `rewrite_chain_warning`.
5. Apply rewriting/default genre to `metadata.json` snapshot.
6. Rebuild + overlay track edits from existing `structured.json`.
7. Materialize desired metadata and diff vs original `metadata.json`.
8. Write `update-metadata.json` (changed tracks only).

Single-disc suppression:
- If target `Total discs == 1`, do not emit `Disc number` / `Total discs` updates.

### Rewriting semantics

- One-pass, top-to-bottom match.
- First match applies; outputs do not continue rewriting.
- Results deduplicated.

## `apply-tags`

- Read `update-metadata.json`.
- Sequential apply.
- Log album when first track of that album starts applying.
- Update fields:
  - `Title`
  - `Artists` (`;` joined)
  - `Album title`
  - `Album artists` (`;` joined)
  - `Track number`
  - `Total tracks`
  - `Disc number`
  - `Total discs`
  - `Date`
  - `Year`
  - `Genre`
  - `Comment`

## Pretty JSON outputs

- `metadata.json`
- `structured.json`
- `rewriting.json`
- `update-metadata.json`
- `audit.json`
