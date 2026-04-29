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
- `inconsistent_date`

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
    "Disc subtitle": "VALUE",
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
`scan-albums` is responsible for this tokenization; downstream binaries use the parsed list values as-is.

## `analyze-albums`

### Execution flow

- Always run a single flow that generates:
  - `rewriting.json`
  - `update-metadata.json`
- Optional positional CLI args: circle names (`analyze-albums <circle...>`).
  - When provided, `update-metadata.json` is filtered to tracks under the specified circles only.
- If `structured.json` does not exist, build and write it first from `metadata.json` (and emit related audits), then continue.

### `structured.json` scope

`structured.json` contains structure/editable track data only:
- albums/discs/tracks
- album artists per album
- track fields (`title`, `track number`, `artists`)
- optional track fields (`date`, `genre`)
- each disc entry is a dictionary with:
  - `$subtitle` (optional): disc subtitle string for that disc
  - track-path keys mapping to track objects

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
- plus a special top-level `$all` entry with the same shape, aggregated across all circles

Count rules:
- case-sensitive substring match
- check artist + album-artist fields together
- each track contributes at most +1 per name

Auto-generation rules:
- Three-stage generation pipeline for artists/album-artists:
  1. split-candidate rule generation
  2. normalization rule generation from split-rewritten names
  3. compile for one-pass execution (saturate + prune unreachable rules)
- Stage 1 split-candidate generation:
  - normal split rules from detected single-field joined names
  - gated aggressive split rules for highly plausible separators:
    - `&`, `＆`, `/`, `／`, `+`, `＋`, ` x `, ` vs. `, ` vs `
    - for symbolic separators (`+`, `＋`, `x`, `&`, `＆`), surrounding spaces are required in normal split logic to avoid over-splitting
    - aggressive mode may additionally split no-space `&` / `＆` / `/` / `／` / `+` / `＋` when gated as plausible
- Aggressive split gating:
  - use greedy splitting over aggressive separators with offset scanning (outside parentheses only)
  - for each candidate split, accept only when at least one side matches a known normalized name in the same circle
  - on success, unresolved sides that still contain aggressive separators are pushed to a worklist for further splitting
  - each generated split rule is marked with confidence by this heuristic:
    - confident: gate condition satisfied
    - less confident: otherwise
  - when materializing JSON rewriting rules, less-confident generated rules are ordered first for manual review
- Stage 2 normalization behavior (no NFKC / punctuation normalization):
  - low-confidence regex normalization rules:
    - `NAME(AFFILIATION)` / `NAME (AFFILIATION)` / full-width paren variants -> `NAME`
    - `ROLE (CV:ARTIST)` / full-width variants (including `CV：`) -> `ARTIST`
  - high-confidence regex normalization rules:
    - leading `vo.` / `VO.` prefix -> strip prefix (capture group 1)
  - simple normalize rules:
    - fold full-width ASCII to half-width ASCII
    - lowercase
    - remove whitespace
    - unify quotes (`'`, `“`, `”` -> `"`)
    - choose canonical target variant by highest occurrence count (tie-break deterministic)
  - ordering: low-confidence regex -> high-confidence regex -> simple normalize
- Stage 3 one-pass compilation:
  - generated rules are saturated so one-pass rewriting reaches stable outputs (max 5 iterations)
  - remove auto-generated rules whose `from` side cannot match any reachable source name
- Separator behavior:
  - tokenization is not performed in `analyze-albums`; it consumes already-tokenized artist/album-artist arrays from `metadata.json`
  - normal split candidates are applied outside parentheses only
  - separators include: `feat.`, `Feat.`, ` + `, ` ＋ `, ` x `, ` & `, ` ＆ `, ` / `, ` ／ `, ` vs. `, ` vs `, `×`, `，`, `、`, `；`, `,`
  - symbolic separators with surrounding spaces are treated as safer defaults

### Behavior

Inputs: `metadata.json`, optional `structured.json`, optional `rewriting.json`  
CLI args: optional circle-name list (`analyze-albums <circle...>`)  
Outputs: `rewriting.json`, `update-metadata.json` (and `structured.json` if missing)

Steps:
1. If `structured.json` is missing:
   - build it from metadata/path parsing
   - path parsing uses fixed structure `circle/album/...` (album is always second-level directory)
   - album folder parsing (regex-based):
     - optional date token at start: `YYYY` / `YYYY.MM` / `YYYY.MM.DD`
     - `-` is accepted as date separator input and normalized internally
     - optional leading record-id bracket token (e.g. `[ABCD-1234]`)
     - extract album name from the remaining album-folder component
   - date inference/selection:
     - infer date from album folder token when available (precision preserved; do not invent month/day)
     - compare metadata date/year and inferred date using timestamp semantics
     - if consistent and metadata is less precise, use inferred date
     - if inconsistent, keep metadata value and emit `audit.json.inconsistent_date`
   - emit audits:
     - disc classification fallback -> `audit.json.disc_classification`
     - missing artists -> `audit.json.missing_info`
     - album artist inconsistency/mismatch -> `audit.json.different_album_artist`
     - metadata/path date inconsistency -> `audit.json.inconsistent_date`
   - disc subtitle behavior:
     - single-disc albums usually omit `$subtitle`
     - if a disc already has an explicit `Disc subtitle` and it is unique within the disc, use it as `$subtitle`
     - otherwise, for multi-disc albums, if any track in a disc has `Album title`, choose the track with smallest `Track number` (tie-break by lexicographically smallest track path) and use that `Album title` as `$subtitle`
2. If `rewriting.json` is missing, auto-generate rewriting rules from `structured.json`.
3. If `rewriting.json` exists, preserve rewriting rules + default genre.
4. Refresh `all artists` / `all album artists` / `all genres` from `structured.json` after applying current rewriting rules. Use rewritten artist/album-artist fields for per-track counting.
   - `$all` counts across all circles
   - `$all` rewriting rules are never auto-generated; only preserved from existing file (or empty)
5. Validate rewrite chains from `rewriting.json`; emit deduped `rewrite_chain_warning`.
6. Apply rewriting/default genre to `metadata.json` snapshot.
7. Rebuild + overlay track edits from existing `structured.json`.
8. Materialize desired metadata and diff vs original `metadata.json`.
9. Write `update-metadata.json` (changed tracks only).
   - If circle args are present, include only tracks whose path resolves to those circles.

Single-disc suppression:
- If target `Total discs == 1`, do not emit `Disc number` / `Total discs` updates.

### Rewriting semantics

- One-pass, top-to-bottom match.
- First match applies; outputs do not continue rewriting.
- Results deduplicated.
- Name tokenization/splitting should be handled explicitly in generation/application flow, not implicitly inside generic rewrite matching logic.
- Rule priority is: circle-specific rules first, then `$all` rules.

## `apply-tags`

- Read `update-metadata.json`.
- Sequential apply.
- Log album when first track of that album starts applying.
- Update fields:
  - `Title`
  - `Artists` (write as multi-value tags; reader side may display `;`-joined)
  - `Disc subtitle`
  - `Album title`
  - `Album artists` (write as multi-value tags; reader side may display `;`-joined)
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
