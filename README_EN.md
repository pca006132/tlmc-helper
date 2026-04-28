# TLMC One-Click Track Splitter (English)

中文版（Chinese main README）: [README.md](README.md)

> Note: this README is mostly vibed from `task.md`, adapted into user-facing instructions.

## What this tool does

This is a one-click tool for Touhou album conversion:

- scan circle folders in the current directory
- extract album `.rar` files
- find and pair `.flac` + `.cue`
- split full FLAC into per-track FLAC files
- write common tags

## Folder layout before running

Put the executable in a root directory that contains circle folders:

```text
root/
  CircleA/
    2026.04.28 [ABCD-0123] foo bar [c123].rar
  CircleB/
    2025.10.01 [WXYZ-0001] album name.rar
  tlmc.exe
```

Circle folder names can be bracketed (`[CircleName]`) or plain (`CircleName`).

## How to use

### One-click splitting (`split-album`)

1. Run `split-album` (double-click exe on Windows).
2. Wait until processing is done.
3. Review `verbose.log`, `error.log`, and `audit.json` for manual follow-up.

### Metadata workflow (new binaries)

1. Scan current tags:
   - `scan-albums`
   - output: `metadata.json`
2. Build editable structure:
   - `analyze-albums`
   - if `structured.json` is missing, it generates `structured.json`
3. Edit `structured.json` (rewrite rules, default genre, etc.).
4. Generate update plan:
   - run `analyze-albums` again
   - if `structured.json` exists, it generates `update-metadata.json` and `structured-new.json`
5. Apply updates:
   - `apply-tags`
   - applies `update-metadata.json` in parallel

Command example (from project root):
```bash
cargo run --bin scan-albums
cargo run --bin analyze-albums
# edit structured.json
cargo run --bin analyze-albums
cargo run --bin apply-tags
```

## `structured.json` explained (manual edit file)

`structured.json` is the intermediate file that combines:

- analysis output from `metadata.json`
- user-editable rewrite/default rules

Flow:

1. First `analyze-albums` run creates `structured.json`.
2. You edit it.
3. Second `analyze-albums` run reads it and creates `update-metadata.json`, plus `structured-new.json` (post-update structure snapshot).

Main fields (per circle):

- `all album artists` / `all artists` / `all genres`
  - aggregated, deduplicated, sorted candidates
- `album artists rewriting` / `artists rewriting` / `genre rewriting`
  - rewrite rules in form:
  - `{ "from": ["A", "B"], "to": ["C"] }`
  - for singular artist/album-artist tags, preprocessing split is used to generate extra rules:
    - trim leading `Vo.`
    - split by `feat.`, `+`, ` x `, ` & `, `/`, `，`, `、`, `;`, `,`
    - do not split inside parentheses (`()` / `（）`)
- `default genre`
  - optional fallback genre for tracks missing genre
- `albums`
  - album-level data
  - `album artists`: album-level artist list
  - `discs`: track grouping by disc (`TRACK_PATH` -> track fields)

Minimal example:

```json
{
  "CircleName": {
    "all album artists": ["AAA", "Aaa"],
    "album artists rewriting": [
      { "from": ["AAA", "Aaa"], "to": ["AAA"] }
    ],
    "all artists": ["X", "Y"],
    "artists rewriting": [],
    "all genres": ["Trance", "Electronic"],
    "genre rewriting": [],
    "default genre": "Electronic",
    "albums": {}
  }
}
```

Editing tips:

1. Start with rewrite rules (`* rewriting`) first.
2. Set `default genre` only if you want missing genres auto-filled.
3. Review `albums -> ... -> discs` if disc grouping looks suspicious.
4. Re-run `analyze-albums` after edits to produce `update-metadata.json` and `structured-new.json`.

Behavior:

- no command-line arguments required
- verbose messages go to both stdout and `verbose.log`
- errors are recorded in `error.log` and processing continues when possible

## What happens after conversion

- `.rar` is extracted to a same-name folder (without `.rar`) only when that folder does not already exist
- album folders are processed even if there is no matching `.rar` file
- FLAC/CUE are paired and processed
- output files are named `TRACK_ID - TRACK_NAME.flac`
- original processed `.flac` and `.cue` are renamed to `*.old`
- folders containing `.flac.old` or `.cue.old` are treated as already processed and skipped
- for multi-disc albums, split tracks are placed in subfolders by FLAC name

## Audit outputs and JSON structure

Outputs are generated in the execution directory. Audit paths are relative for easier triage.

- `verbose.log`
  - detailed process log (also printed to stdout)
  - includes pairings and audit events
- `error.log`
  - hard errors (failed album/pair processing)
  - check this first
- `audit.json`
  - unified audit output (pretty JSON)
  - shape example:
```json
{
  "missing_cue": ["circle/album/foo.flac"],
  "missing_flac": ["circle/album/foo.cue"],
  "multi_disc": ["circle/album"],
  "corrupt_cuesheet": ["circle/album/foo.cue"],
  "missing_info": ["circle/album/foo.flac track 01"],
  "invalid_names": ["circle_or_album_path"],
  "ambiguous_pairing": ["circle/album | flac=... | cues=..."],
  "corrupted_tracks": ["circle/album/foo.mp3"],
  "disc_classification": ["circle/album"],
  "different_album_artist": ["circle/album"]
}
```
  - field meanings:
    - `missing_cue`: flac without cue
    - `missing_flac`: cue without flac
    - `multi_disc`: album has multiple pair groups
    - `corrupt_cuesheet`: cue invalid (including zero/negative duration)
    - `missing_info`: missing key tag fields
    - `invalid_names`: invalid circle/album directory names
    - `ambiguous_pairing`: non-unique cue/flac association
    - `corrupted_tracks`: unreadable audio during scan
    - `disc_classification`: disc grouping fallback triggered
    - `different_album_artist`: inconsistent album-artist signals

## After the tool finishes

Recommended checklist:

1. Check `error.log`.
2. Fix entries under `corrupt_cuesheet` in `audit.json`.
3. Resolve `missing_cue` / `missing_flac` in `audit.json`.
4. Review `multi_disc` / `ambiguous_pairing` in `audit.json`.
5. Fill metadata for entries under `missing_info` in `audit.json`.
6. Spot-check playback/cut points on several albums.
7. Delete `*.old` originals only after verification.

If you fix cuesheets and want to rerun, note that folders with `.flac.old` / `.cue.old` are skipped. Move or rename those `.old` files first, then run again.
If cue is missing `DATE` or top-level `PERFORMER`, the tool may need directory names as fallback metadata; if those names are invalid, it logs to `error.log` and skips that album.
If cue timing yields zero/negative track duration, it is treated as corrupt and logged under `corrupt_cuesheet` in `audit.json`.
`metadata.json`, `structured.json`, `update-metadata.json`, and `audit.json` are all pretty-printed JSON.
