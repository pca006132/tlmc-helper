# TLMC Current Specification

This document is the single current specification.

## Terms

- Circle (Touhou context): 社團 / group.

## Required Input Layout

The tool assumes TLMC-style directory layout. This is not auto-detected.

- Run binaries in a root directory containing circle folders.
- Circle folder names may be:
  - `[CircleName]`
  - `[CircleName] Extra Text` (only `CircleName` is extracted as circle name)
  - `CircleName`
- Circle folders may contain:
  - album archives (`.rar`)
  - extracted album directories

Users are expected to keep this structure stable.

## Binaries

1. `split-album`
2. `scan-albums`
3. `analyze-albums`
4. `apply-tags`

## Logging

- `verbose.log`: detailed log; also mirrored to stdout.
- `error.log`: hard failures.
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

All logged paths are relative to execution directory.

## `split-album`

### Discovery/extraction

- Process extracted album folders even if there is no `.rar`.
- Extract `.rar` only when target folder does not already exist.
- Skip albums containing any `.flac.old` or `.cue.old`.

### FLAC/CUE pairing

Pairing priority:
1. Single FLAC + single CUE.
2. Exact filename stem match (case-insensitive).
3. Non-ambiguous substring relation.

If ambiguous, write detail to `audit.json.ambiguous_pairing` and skip that ambiguous pair.

### Cue decode/parse/validation

- Decode with `chardetng`.
- Parse with custom parser.
- Treat as corrupt if:
  - parse fails
  - any track duration <= 0
  - last track offset exceeds FLAC duration
- Corrupt entries go to `audit.json.corrupt_cuesheet`.

### Tag fallback behavior

- DATE fallback:
  1. archive filename date
  2. album folder date token
- ALBUMARTIST fallback:
  - circle folder name

If fallback requires invalid directory name, log to `error.log` and skip album.

### Output

- Output track names: `TRACK_ID - TRACK_NAME.flac`
- Multi-pair album outputs to subfolder per FLAC stem.
- Encode in parallel.
- Apply tags before track write (single write per track).
- Rename source FLAC/CUE to `.old` after success.

## `scan-albums`

- Scan `flac`, `mp3`, `m4a` via `audiotags`.
- Parallel scanning.
- Optional `scan-filter.txt` (one circle per line).
- Without filter: scan all circles under current root.
- Log processed album paths to `verbose.log`.
- Corrupted tracks -> `audit.json.corrupted_tracks`.

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

All keys optional per track.
`Artists` / `Album artists` parse `;` as separator.

## `analyze-albums`

### Mode

- If `structured.json` missing: analysis mode.
- Otherwise: update mode.

### Analysis mode (`metadata.json` -> `structured.json`)

#### Path grouping

- Parse track path to get `(circle, album_folder)`.
- Display album name derives from folder by stripping:
  - leading date token
  - leading `[catalog]`
  - trailing `[event]`
- If single-disc album has one consistent non-empty album-title tag and differs from derived name, prefer the tag value.
- If collisions occur, disambiguate with `(<album_folder_name>)`.

#### Disc classification

1. Same album title + no disc numbers -> disc 1.
2. Use explicit disc numbers first.
3. Remaining tracks grouped by album title, assigned new consecutive disc numbers after existing numbers.

If rule 3 is used, log album path to `audit.json.disc_classification`.

#### Aggregation checks

- Aggregate per-circle:
  - all album artists
  - all artists
  - all genres
- Missing track artists -> `audit.json.missing_info`.
- Album artist inconsistency/mismatch -> `audit.json.different_album_artist`.

#### Artist preprocessing (singular field only)

For singular artist/album-artist values:
1. Trim leading `Vo.`
2. Split by: `feat.`, `+`, ` x `, ` & `, `/`, `，`, `、`, `;`, `,`
3. Do not split inside `()` or `（）`
4. Trim non-empty tokens

If preprocessing changes singular value, add rewriting rule:
- `from`: original singular value
- `to`: processed token list

#### Normalization-based rule generation

Normalization used only for candidate grouping:
- lowercase
- `'` `“` `”` -> `"`
- `＊` -> `*`

If multiple names normalize equal in a circle:
- generate rewriting rule to lexicographically smallest original variant
- this chosen value may still be non-canonical; user edits later

Rules are deduplicated before output.

### Rewriting semantics (one-pass)

For each name token:
- match rules from top to bottom
- first matched `from` replaces token with rule `to`
- replaced outputs are not rewritten again
- deduplicate final output list

This is intentionally one-pass (not chain recursion).

### Rewrite chain warning

When reading `structured.json`, detect if one rule output can match another rule input in same rule set.
Log such potentially incomplete rule chains to `audit.json.rewrite_chain_warning` (deduplicated entries).

### Complex rewrite example

```json
[
  { "from": ["Aky"], "to": ["Aki"] },
  { "from": ["Aki", "AKI"], "to": ["Akiha"] },
  { "from": ["Akiha x S"], "to": ["Akiha", "S"] }
]
```

Behavior:
- Input `["Aky"]` -> `["Aki"]` (stops; does not continue to `Akiha`)
- Input `["Aki"]` -> `["Akiha"]`
- Input `["Akiha x S"]` -> `["Akiha", "S"]`

Because rewriting is one-pass, a chain like `Aky -> Aki -> Akiha` should be flattened manually if desired.

### Update mode (`structured.json` -> `structured-new.json` + `update-metadata.json`)

1. Validate rewrite chains and emit warnings.
2. Apply rewrite rules + default genre to metadata snapshot.
3. Rebuild structure preserving:
   - deduplicated rewriting rules
   - default genre
   - track edits from old `structured.json` (overlay)
4. Write `structured-new.json`.
5. Materialize desired metadata from `structured-new.json`.
6. Diff desired vs original `metadata.json` and write changed tracks to `update-metadata.json`.

Single-disc suppression:
- If target has `Total discs == 1`, do not emit `Disc number` / `Total discs`-only updates.

## `apply-tags`

- Read `update-metadata.json`.
- Apply updates in parallel.
- Log processed album paths to `verbose.log`.
- Update fields:
  - `Title`
  - `Artists` (join by `;`)
  - `Date`
  - `Year`
  - `Album title`
  - `Album artists` (join by `;`)
  - `Track number`
  - `Total tracks`
  - `Disc number`
  - `Total discs`
  - `Genre`
  - `Comment`

## JSON formatting

These outputs must be pretty JSON:
- `metadata.json`
- `structured.json`
- `structured-new.json`
- `update-metadata.json`
- `audit.json`
# TLMC Current Specification

This file is the **current source-of-truth spec** for implementation behavior.

## Binaries

1. `split-album`
   - Extract/split/tag workflow for album archives/folders.
2. `scan-albums`
   - Scan existing tags into `metadata.json`.
3. `analyze-albums`
   - Analysis mode: `metadata.json` -> `structured.json` (if `structured.json` missing).
   - Update mode: edited `structured.json` -> `structured-new.json` + `update-metadata.json`.
4. `apply-tags`
   - Apply `update-metadata.json` back to audio tags.

## Shared Logging and Audit

- `verbose.log`: human-readable processing log; also echoed to stdout.
- `error.log`: hard errors.
- `audit.json`: structured audit output (pretty JSON), grouped by category arrays.
- All logged paths are relative to execution directory.

Current audit categories:
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

## Directory Expectations

- Executable runs in a root directory containing circle folders.
- Circle folder names may be:
  - bracketed (`[Circle]`)
  - bracketed with suffix (`[Circle] Extra Text`) and only `Circle` is extracted
  - plain (`Circle`)
- Circle folders may contain:
  - album `.rar` files (`YYYY.MM.DD [CAT] Album [Event].rar`)
  - already-extracted album directories

## `split-album` Behavior

### Discovery and extraction

- Process album directories even without associated `.rar`.
- Extract `.rar` only when same-name folder does not already exist.
- Skip album if any `.flac.old` or `.cue.old` exists in album tree.

### Pairing FLAC and CUE

Order:
1. Single FLAC + single CUE -> pair.
2. Exact stem match (case-insensitive).
3. Non-ambiguous substring relation.

If ambiguous substring relation exists, record to `audit.json.ambiguous_pairing` and do not auto-pair.

### Cue handling

- Decode cue with `chardetng`.
- Parse cue with custom parser (REM GENRE/DATE/COMMENT, top-level TITLE/PERFORMER, TRACK TITLE/PERFORMER, INDEX 01).
- Corrupt cue conditions:
  - parse failure
  - any track duration <= 0
  - last track start offset > FLAC duration
- Corrupt cues logged to `audit.json.corrupt_cuesheet`; pair skipped.

### Metadata fallback

- DATE fallback:
  - archive filename date token first
  - else album folder date token
- ALBUMARTIST fallback:
  - circle folder name
- If fallback is required but corresponding directory naming is invalid, skip album and log to `error.log`.

### Output

- Track output name: `TRACK_ID - TRACK_NAME.flac`
- For multi-pair albums, output subdir per FLAC stem.
- Tag at encode time; parallel per-track encoding.
- Rename processed source FLAC/CUE to `.old`.

## `scan-albums` Behavior

- Scan file types: `flac`, `mp3`, `m4a`.
- Use `audiotags`.
- Optional `scan-filter.txt` limits circles (one circle per line).
- Without filter, scan all circle directories in root.
- Album directories logged to `verbose.log`.
- Corrupted/unreadable tracks logged to `audit.json.corrupted_tracks`.
- Run scanning in parallel.

### `metadata.json` format

```json
{
  "TRACK_PATH": {
    "Title": "...",
    "Artists": ["..."],
    "Date": "...",
    "Year": "...",
    "Album artists": ["..."],
    "Album title": "...",
    "Track number": 1,
    "Total tracks": 10,
    "Disc number": 1,
    "Total discs": 1,
    "Genre": "...",
    "Comment": "..."
  }
}
```

All fields optional per track.

For `Artists` and `Album artists`, `scan-albums` treats `;` as multi-value separator.

## `analyze-albums` Behavior

## Mode selection

- If `structured.json` missing: analysis mode.
- Else: update mode.

### Analysis mode (`metadata.json` -> `structured.json`)

#### Path grouping

- Parse track path to determine `(circle, album_folder)`.
- Album display key (`ALBUM_NAME`) is derived from folder name by stripping:
  - leading date token
  - leading bracket token (catalog)
  - trailing bracket token (event)
- For single-disc albums, if all tracks share one non-empty album-title tag and it differs from derived folder name, use tag name as `ALBUM_NAME`.
- If display key collides, disambiguate with `(<album_folder_name>)`.

#### Disc classification

Rules:
1. If all tracks have same album title and no disc number -> disc 1.
2. Otherwise, explicit disc numbers are used first.
3. Remaining tracks grouped by album title and assigned consecutive disc numbers after existing explicit numbers.

If rule 3 used, log album path to `audit.json.disc_classification`.

#### Aggregation

- Aggregate:
  - all album artists
  - all artists
  - all genres
- Missing artists in track -> `audit.json.missing_info`.
- Album artist inconsistency or mismatch vs circle name -> `audit.json.different_album_artist`.

#### Preprocessing for artist/album-artist aggregation

For singular value:
1. Trim leading `Vo.`.
2. Split by: `feat.`, `+`, ` x `, ` & `, `/`, `，`, `、`, `;`, `,`.
3. Do not split inside `()` / `（）`.
4. Trim tokens.

If singular preprocessing changed value, generate rewrite rule:
- `from`: original singular value
- `to`: split/preprocessed values

#### Normalization-driven rewrite generation

- Normalize with:
  - lowercase
  - `'`/`“`/`”` -> `"`
  - `＊` -> `*`
- If multiple variants normalize equal, generate rewrite rule mapping variants to lexicographically smallest original variant.
- Rules deduplicated before output.

### Update mode (`structured.json` -> `structured-new.json` + `update-metadata.json`)

1. Validate rewrite chains:
   - if any rule `to` matches another rule `from` within same rule-set, log to `audit.json.rewrite_chain_warning` (deduplicated).
2. Apply rewrite rules + default genre to metadata snapshot.
3. Rebuild structure and preserve:
   - deduplicated rewriting rules
   - default genre
   - track-level edits from original `structured.json` (overlay)
4. Apply rewrites to `structured-new` artists/album-artists.
5. Write `structured-new.json`.
6. Materialize desired metadata from `structured-new`.
7. Diff against original `metadata.json` to produce `update-metadata.json`.

### Update diff filtering

- Single-disc albums (`Total discs == 1`) never emit `Disc number` / `Total discs` updates.

## `apply-tags` Behavior

- Read `update-metadata.json`.
- Apply in parallel.
- Log processed album paths to `verbose.log`.
- Supports updating:
  - Title
  - Artists (joined by `;`)
  - Date / Year
  - Album title
  - Album artists (joined by `;`)
  - Track number / total tracks
  - Disc number / total discs
  - Genre
  - Comment

## JSON Output Formatting

These files must be pretty-printed JSON:
- `metadata.json`
- `structured.json`
- `structured-new.json`
- `update-metadata.json`
- `audit.json`
A simple one-click executable for extracting tracks from TLMC.
Need to work on Windows for dummies, so this should be one-click with no command line arguments for now.

In the following, ALL_CAPS means variables and should not be used literally.

# Tasks

1. Unrar the album files using the unrar library. Example in doc/extract-example.rs.
  The album file content should be extracted to a new directory with the same name (without the rar extension) in the same location.
2. Within the album directory, search for the album flac file and its associated cuesheet file. Details in the latter section.
3. Read the cuesheet track offsets and split the flac file into tracks using the flac-codec library. Example in doc/split-flac.rs, but note that the flac file is not embedded and need another parse operation. 
4. Read the cuesheet using custom parser and tag the tracks. Specifics about cuesheet and tags are explained in the latter section. After tagging, the track file should be named `TRACK_ID - TRACK_NAME.flac` and exported to the album folder (may need another level of directory, see the section about flac and cuesheet association). The cuesheet and flac file should be renamed by adding a `.old` suffix to each of them.

In particular, we should not panic. We should write errors to an `error.log` file in the execution directory and terminate gracefully, because users do not understand stderr and crashes.
We should also log every album we worked on, as well as other information to `verbose.log` file.
Log for tasks for one album should be indented by 2 spaces, so it can be differentiated easily.

Whenever we log things or output to files for further auditing, we should write paths relative to the execution directory, i.e., prefix is `[circle]/ALBUM_DIRECTORY_NAME/`.
All audit log should be logged to `verbose.log` as well, and `verbose.log` should also be logged to stdout.

For performance reason, we should tag before writing the track to disc, and we should encode them in parallel.

# Directory structures

We assume the executable is in a directory with a list of folders with the name `[CIRCLE_NAME]`, where `CIRCLE_NAME` is the name of the circle (typically the album artist, unless there are collaborations).
Within each `[CIRCLE_NAME]` folder, there are a list of rar files, where the names are in the following format: `YYYY.MM.DD [CATALOG_NUM] ALBUM_NAME [EVENT].rar`.
For example, it can be `2026.04.28 [ABCD-0123] foo bar [c123].rar`, where the date is 2026.04.28, `CATALOG_NUM` is `ABCD-0123`, `ALBUM_NAME` is `foo bar`, and `EVENT` is `c123`.
Note that `[EVENT]` is optional.
`[CIRCLE_NAME]` does not need square brackets. We support circle directory names both with and without `[]`.

We do not assume anything about the internals of the album.

# Cuesheet Pairing 

1. If there is a single flac file and a single cuesheet, this is trivial.
2. If there are multiple flac files and cuesheets, and flac filenames correspond to cuesheet filenames, this is also trivial.
3. Otherwise, consider flac and cuesheet to be related if one's name is a substring of another. If such association is non-ambiguous, use that association.
4. If association is ambiguous, write details to `ambiguous-pairing.txt` and skip such ambiguous pairing.

Exceptions:
1. If there is no cuesheet in the album, just write to `verbose.log` saying that there is nothing to split in this path.
2. If point 2 or 3 above applies but some flac files do not have associated cuesheets, append the path of the flac file as a new line to the file `missing-cue.txt`. For example, if `[circle]/2026.04.28 [ABCD-0123] foo bar [c123]/foo.flac` has no associated cuesheet, output `[circle]/2026.04.28 [ABCD-0123] foo bar [c123]/foo.flac` to `missing-cue.txt`. Different entries have different lines. Also log to `verbose.log` about this.
3. Similarly, if there is a cuesheet with no associated flac file, output it to `missing-flac.txt`. Also log to `verbose.log` about this.

In `verbose.log`, log the flac and cuesheet associations.

If there are multiple flac and cuesheet association pairs, write the album path to `multi-disc.txt` as a new line, since users have to set the new album name and disc id.
Also, the track files should be put into a subdirectory named `FLAC_NAME_WITHOUT_SUFFIX` in the album directory, so tracks belonging to different flac files (and hence discs) are separated.

# Reading Cuesheet

Use chardetng for decoding, since the file may be in some CJK encoding or UTF-8/16 with BOM.
If the cuesheet is not in standard encoding (ASCII/UTF-8), log the path and encoding to `verbose.log`.
If failed to parse the cuesheet using custom parser, write the cuesheet path to `corrupt-cuesheet.txt`, and skip processing such flac-cuesheet pair.
Also validate the calculated track durations from INDEX points. If any track duration is 0 or negative, treat cuesheet as corrupted, write to `corrupt-cuesheet.txt`, and skip that pair.

# Cuesheet Parsing for Tagging

We need to parse cuesheet for tagging. An example is

```
REM GENRE Electronica
REM DATE 1998
PERFORMER "Faithless"
TITLE "Live in Berlin"
FILE "Faithless - Live in Berlin.mp3" MP3
  TRACK 01 AUDIO
    TITLE "Reverence"
    PERFORMER "Faithless"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "She's My Baby"
    PERFORMER "Faithless"
    INDEX 01 06:42:00
```

This should be simple enough where a simple handwritten line-by-line parser could work.

In particular, what we want are:
1. Top level REM tags, we only care about GENRE, DATE and COMMENT. These tags are mapped directly. If the date is missing, use the one from the album archive name; if archive is unavailable, use the album directory name date token (`YYYY.MM.DD ...`) as fallback. If genre or comment is missing, ignore them. 
2. Top level PERFORMER tag, this maps to the ALBUMARTIST tag in the track file. If this is missing, use the circle name from the folder path.
3. Top level TITLE tag, this maps to the ALBUM tag in the track file.
4. Track ID, this maps to the TRACKNUMBER tag in the track file.
5. Track TITLE and PERFORMER tag. These are mapped directly.

Other lines can basically be thrown away.
Also, note that we are working with with unicode, and for quoted values we may need to unescape \".

If album title, track title or track performer are missing, treat that as an empty string and continue. Write to both `verbose.log` and `missing-info.txt` about this (including the flac file path and track id).

If album tags require fallback from directory names (e.g., DATE from album directory name, ALBUMARTIST from circle directory name), and the required directory name is invalid, write to `error.log` and skip that album.

---

Do the following modification:

1. Only extract the archive file if there is no existing folder with the same name.
2. Do the processing for folders even if there is no associated rar file.
3. Skip processing the folder if there are .flac.old or .cue.old files, as these indicates the folder is processed.

These allow users to add/modify albums without the need to create an rar file.

Mention these in the README files, in particular tell the users they can fix cuesheets and rerun the program.

---

I added a small flac file (duration: 1:53) in the `testdata` directory with correct folder structure.
Generate a simple cuesheet for testing, write a test to check if the split result is correct (tags, duration), and revert the changes after testing.
Also add the test to CI.

In the code, log invalid directory names (e.g., invalid circle directory name or album directory name) to `invalid-names.txt`.
If the album tags require using info from directory names but the directory name is invalid, log to `error.log` and skip the album processing.
Also write these to READMEs.

---

# Multi-binary Architecture (Current)

This project now has multiple binaries:

1. `split-album`
   - The original split workflow (extract -> pair -> split -> tag).
   - This was previously in `src/main.rs` and is now explicitly the `split-album` binary target.
   - Logger is shared and moved out of split implementation.
2. `scan-albums`
   - Scans audio files and writes `metadata.json`.
3. `analyze-albums`
   - Mode A (analysis): generate `structured.json` when it does not exist.
   - Mode B (generate update): read edited `structured.json` and emit `update-metadata.json`.
4. `apply-tags`
   - Applies updates from `update-metadata.json` back to files.

Shared logger:
- `Logger` is a shared module, not embedded in one binary.
- Audit output should still be mirrored to `verbose.log`.

# Additional/Updated Rules

## Pairing

- Ambiguous FLAC/CUE matches must be logged to `ambiguous-pairing.txt`.
- Ambiguous matches are not auto-resolved.

## Circle naming

- Circle directory names with and without `[]` are supported.

## Cuesheet timing validation

- Validate computed track durations from INDEX points.
- Any track with duration `<= 0` is treated as corrupted cuesheet.
- Log such cue to `corrupt-cuesheet.txt` and skip pair processing.

# `scan-albums` specification

Output file: `metadata.json`

Format:
```json
{
  "TRACK_PATH": {
    "METADATA": "VALUE",
    "METADATA2": ["VALUE"]
  }
}
```

Metadata keys of interest (all optional):
- `Title`
- `Artists` (string list)
- `Date`
- `Year` (`YYYY.MM.DD` style when available)
- `Album artists` (string list)
- `Album title`
- `Track number`
- `Total tracks`
- `Disc number`
- `Total discs`
- `Genre`
- `Comment`

Implementation rules:
- Use `audiotags`.
- Scan file types: `flac`, `mp3`, `m4a`.
- Support `scan-filter.txt` (one circle folder name per line).
  - If missing: scan all circles in current directory.
- Log each album directory to `verbose.log`.
- Corrupted/unreadable audio files go to `corrupted.txt`.
- Scanning should be parallel.

# `analyze-albums` specification

## Mode selection

- If `structured.json` does not exist -> analysis mode.
- Else -> generate update mode.

## Analysis mode

1. Determine circle and album from track path.
2. Disc grouping:
   - If all tracks have same album title and no disc number -> all in disc 1.
   - Else, prioritize explicit disc numbers.
   - Remaining tracks grouped by album title and assigned new consecutive disc numbers.
   - If fallback grouping is used, log album path to `disc-classification.txt`.
3. Album-artist checks:
   - Aggregate album artists in circle.
   - If album has inconsistent album-artist sets across tracks, or album artists do not match circle naming expectation, log to `different-album-artist.txt`.
4. Artist checks:
   - Aggregate artists in circle.
   - Missing artist tags -> `missing-info.txt`.
5. Genre aggregation:
   - Aggregate all genres in circle.

## Rewriting and normalization rules

Aggregation preprocessing for artists / album artists:
- If a track has singular value:
  - Trim leading `Vo.` from the raw singular name.
  - Then split by separators: `feat.`, `+`, ` x `, ` & `, `/`, `，`, `、`, `;`, `,`.
  - Do not split inside parentheses (`()` / `（）`).
- Trim names.
- Normalize for rule generation:
  - lower-case
  - replace `'` `“` `”` with `"`
  - replace `＊` with `*`
- If multiple names normalize to same value in one circle, generate rewriting entry mapping all variants to the lexicographically smallest original variant (not canonicalized). Users can later edit and choose canonical forms manually.
- If singular-name splitting happened, also generate a rewriting entry:
  - `from` = raw singular name (after leading `Vo.` trimming)
  - `to` = split results

Genre aggregation:
- No split/implicit normalization required.

Rewriting semantics:
- Each entry:
```json
{
  "from": ["NAME1", "NAME2"],
  "to": ["NAME1", "NAME2"]
}
```
- For genre rewriting, `to` must have exactly one element.
- Apply from first rule to last.
- Match exact names from `from`.
- For singular artist/album-artist value, split first, then rewrite each piece.
- Rewritten outputs are exempt from further rewrites.
- Deduplicate final results.

## `structured.json` shape

```json
{
  "CIRCLE_NAME": {
    "all album artists": [],
    "album artists rewriting": [],
    "all artists": [],
    "artists rewriting": [],
    "all genres": [],
    "genre rewriting": [],
    "default genre": "",
    "albums": {
      "ALBUM_NAME": {
        "album artists": [],
        "discs": [
          {
            "TRACK_PATH": {
              "title": "",
              "date": "",
              "track number": 0,
              "artists": [],
              "genre": ""
            }
          }
        ]
      }
    }
  }
}
```

Rules:
- `"all ***"` lists must be sorted and deduplicated.
- `"default genre"` is optional.

## Generate update mode

- Read edited `structured.json`.
- Apply artist/album-artist rewriting and genre rewriting.
- If `default genre` is set, use it for missing genre.
- Write only changed tracks to `update-metadata.json` in metadata.json-compatible structure.
- Also generate `structured-new.json` from metadata after applying the updates, so users can compare old/new structures.

# `apply-tags` specification

- Read `update-metadata.json`.
- Apply updates to track files.
- Intended for retagging only (no audio re-encode).

---

1. Refactor src/main.rs to move the logger out.
2. Make the current src/main.rs a separate binary named `split-album`. Rename the file as needed.
3. Add the following binaries.

# Scan

Binary name: `scan-albums`

Purpose: scan tracks and output a `metadata.json` containing their metadata.

Format:
```
{
  "TRACK_PATH": {
    "METADATA": "VALUE",
    "METADATA2": ["VALUE"],
  }
}
```

Metadata of interest:
- Title
- Artists (list of strings)
- Date
- Year ("YYYY.MM.DD")
- Album artists (list of strings)
- Album title
- Track number
- Total tracks
- Disc number
- Total discs
- Genre
- Comment

All are optional.

Should use audiotags to scan tracks.
Should scan flac, mp3, m4a files.

Should check for a `scan-filter.txt` for a list of folders to scan (each line is the name of one folder).
If there is no such file, scan every circle in the current directory, assuming the same directory structure as the directory structure section.
Log to `verbose.log` the current album directory.
If the audio file is corrupted, write to `corrupted.txt` the path of the file and continue.

The scan should be done in parallel.

# Analyze

Binary name: `analyze-albums`

Purpose: There are two modes.
1. Analysis mode: If `structured.json` does not exist, analyze `metadata.json`, generate `structured.json` for user to edit.
2. Generate update mode: Read modified `structured.json`, generate `update-metadata.json` for retagging.

## Analysis mode

1. Use the path to determine the circle and album.
2. For tracks in the same album, group them by disc. There are several cases:
  1. The album title metadata are the same, and all has no disc number. All are in disc 1.
  2. The album title metadata are the same and has disc number. Use that.
  3. The album title metadata are different, group by that and randomly assign disc number (consecutive starting from 1) 
  Rule 2 is applied first. If there are tracks that remain, e.g., with different album title or missing disc number, apply rule 3, and disc number should be different from disc numbers applied in rule 2.
  If rule 3 is triggered, log the album path to `disc-classification.txt` so users will check that.
3. Aggregate all album artists for albums in the same circle. For albums where none of the album artists match the circle name (from the path) or contains tracks with different sets of album artists, log the album path to `different-album-artist.txt`.   
4. Aggregate all artists for albums in the same circle. For tracks with missing artists tag, log the album path to `missing-info.txt`.
5. Aggregate all genres for albums in the same circle.

## Generate update mode:

1. Apply rewriting rules to album artists and artists of albums and tracks.
2. Apply rewriting rules for genres. If there is a `default genre`, use this for the genre field for tracks without genre info.
3. Generate `update-metadata.json`, which has the same format with `metadata.json` but only contain tracks that need to be updated.

## Aggregation and Rewriting

For aggregation, do the following processing:
- If the tag is singular, i.e., only one artist/album artist for the track, try to split the name by separators `，`, `、`, `;`, `,`.
- Trim the names.
- Normalize the names by converting it to lower case and substitute `'` `“` and `”` by `"`, `＊` by `*`. If multiple names in the same circle normalize to the same string, add a rewriting rule that maps these names to the lexicographically smallest original variant. This chosen value may still be non-canonical; users should decide the final canonical form by editing `structured.json`.

Note that we don't need to do splitting and normalization for genre, since each track can only have one genre.

For rewriting, each entry is in the form of
```json
{
  "from": ["NAME1", "NAME2"],
  "to": ["NAME1", "NAME2"]
}
```

For genre rewriting, the `to` field can only contain one element.
The rewriting rules work in the following way:
1. Before splitting, check if the name matches any of the names in the `from` field. If yes, the name is replaced with all names in the `to` field. Replaced names are exempted from rewriting.
2. If the artists/album artists tag of the track has only one name, split that name and apply rule 1 for each of them.
3. Entries are matched from the first one to the last one. And note that normalization is expressed as rewriting rules, we do not perform implicit normalization here.
4. Results are deduplicated.

Example:
```json
[
  {
    "from": ["AA", "BB"],
    "to": ["CC", "DD"],
  },
  {
    "from": ["CC", "DD"],
    "to": ["EE"],
  },
]
```

If we have `["AA", "EE"]`, this is rewritten into `["CC", "DD", "EE"]`.
If we have `["CC", "DD"]`, this is rewritten into `["EE"]`.

## Format of `structured.json`:

```json
{
  "CIRCLE_NAME": {
    "all album artists": [
      "NAME1",
      "NAME2"
    ],
    "album artists rewriting": [],
    "all artists": [
      "NAME1",
      "NAME2"
    ],
    "artists rewriting": [],
    "all genres": [ "GENRE1", "GENRE2" ],
    "genre rewriting": [],
    "default genre": "",
    "albums": {
      "ALBUM_NAME": {
        "album artists": [ "NAME1", "NAME2" ],
        "discs": [
          {
            "TRACK_PATH": {
              "title": "TITLE",
              "date": "YYYY.MM.DD",
              "track number": TRACK_NUMBER,
              "artists": [ "NAME1", "NAME2" ],
              "genre": "GENRE",
            }   
          }
        ]
      }
    }
  }
}
```

In particular, the list of "all ***" should be sorted in alphabetical order and deduplicated.
`default genre` is optional.

# Apply tags

Binary name: `apply-tags`

Purpose: Update tracks according to `update-metadata.json`.

