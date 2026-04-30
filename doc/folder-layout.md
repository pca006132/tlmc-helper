# Folder Layout

TLMC Helper expects a music library root with circle folders at the first level
and album folders under each circle.

```text
library-root/
├── Circle A/
│   └── 2024.05.03 [ABC-0001] Album Title [Event]/
│       └── 01.flac
└── [Circle B] extra text/
    └── 2023 Album Title/
        └── Disc 1/
            └── 01.mp3
```

Run `scan-albums` and `apply-tags` from `library-root`.

## Overview

Track paths are interpreted as:

```text
circle-folder/album-folder/.../track.ext
```

- The first path component is the circle folder.
- The second path component is the album folder.
- Any deeper folders are kept as part of the track path, but they do not change
  the circle or album identity.

The parser is intentionally lenient for common library naming patterns, but it
does not try to infer arbitrary layouts. Put every album under a circle folder.

## Circle Folders

The circle name normally comes from the full first-level folder name:

```text
Circle Name/
```

Bracketed circle folders are also supported:

```text
[Circle Name]/
[Circle Name] extra text/
```

For bracketed folders, only the text inside the first `[...]` is used as the
circle name. For example, `[Circle Name] extra text` becomes `Circle Name`.

## Album Folders

The second path component is always treated as the album folder. Album folder
names may include optional extra information around the album title:

```text
2024.05.03 [ABC-0001] Album Title [Event]
```

The parser accepts:

- Optional leading date: `YYYY`, `YYYY.MM`, `YYYY.MM.DD`
- Date separators using either `.` or `-`
- Optional leading bracketed catalog or record id, such as `[ABC-0001]`
- Optional trailing bracketed suffix, such as `[Reitaisai]`

From this folder:

```text
2024.05.03 [ABC-0001] Album Title [Event]
```

TLMC Helper infers:

- Date: `2024.05.03`
- Album title: `Album Title`

The album title part must still be present. If the folder does not match the
optional patterns, the folder name itself is used as the album name.

## Track Folders

Folders below the album folder are allowed:

```text
Circle/Album/Disc 1/01.flac
Circle/Album/Scans/cover.jpg
```

Only supported audio files are scanned for metadata. Extra path components do
not create albums or circles; the second component remains the album folder.

## Supported Audio Files

`scan-albums` scans:

- `flac`
- `mp3`
- `m4a`

Other files may exist in the folders, but they are not part of the tag update
workflow.
