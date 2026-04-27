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

## How to use

1. Double-click the executable (Windows).
2. Wait until processing is done.
3. Review `verbose.log` and audit files for any manual follow-up.

Behavior:

- no command-line arguments required
- verbose messages go to both stdout and `verbose.log`
- errors are recorded in `error.log` and processing continues when possible

## What happens after conversion

- each `.rar` is extracted to a same-name folder (without `.rar`)
- FLAC/CUE are paired and processed
- output files are named `TRACK_ID - TRACK_NAME.flac`
- original processed `.flac` and `.cue` are renamed to `*.old`
- for multi-disc albums, split tracks are placed in subfolders by FLAC name

## Audit files and what they mean

All files are generated in the execution directory. Paths are relative for easier auditing.

- `verbose.log`
  - detailed process log (also printed to stdout)
  - includes pairings and audit events
- `error.log`
  - hard errors (failed album/pair processing)
  - check this first
- `corrupt-cuesheet.txt`
  - cue files that failed parsing
  - usually requires fixing/replacing cue manually
- `multi-disc.txt`
  - albums with multiple flac-cue pairs
  - review naming/disc organization manually
- `missing-cue.txt`
  - flac files with no matched cue
- `missing-flac.txt`
  - cue files with no matched flac
- `missing-info.txt`
  - missing important tags (album/track title/performer)
  - fill metadata manually later

## After the tool finishes

Recommended checklist:

1. Check `error.log`.
2. Fix entries in `corrupt-cuesheet.txt`.
3. Resolve `missing-cue.txt` / `missing-flac.txt`.
4. Review `multi-disc.txt` output structure and naming.
5. Fill metadata listed in `missing-info.txt`.
6. Spot-check playback/cut points on several albums.
7. Delete `*.old` originals only after verification.
