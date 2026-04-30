# Data Files

This document describes the JSON files produced by the current TLMC workflow:
`metadata.json`, `structured.json`, `rewriting.json`, and
`update-metadata.json`.

## Workflow

The data flow is intentionally staged:

1. Run `scan-albums` in the music library root.
2. `scan-albums` scans existing audio tags and writes `metadata.json`.
3. The Web App or `analyze-albums` reads `metadata.json`.
4. If `structured.json` is missing, it is built from `metadata.json` and the
   TLMC path layout.
5. If `structured.json` already exists, newly scanned tracks from
   `metadata.json` are merged into it while preserving existing manual edits.
6. `rewriting.json` is built or refreshed from `structured.json`.
7. Rewriting rules are applied to a cloned copy of `structured.json`; the saved
   `structured.json` is not modified by rewriting.
8. The desired metadata is compared with the original `metadata.json`.
9. Changed fields only are written to `update-metadata.json`.
10. `apply-tags` reads `update-metadata.json` and writes those changes back to
   the audio files.

Intuitively, the files have different responsibilities:

- `metadata.json` is the raw snapshot: what the audio files currently say.
- `structured.json` is the editable album model: albums, discs, tracks, titles,
  dates, artists, genres, and ordering.
- `rewriting.json` is the normalization workspace: rules, name statistics,
  genres, and default genres.
- `update-metadata.json` is the patch: the minimum set of tag changes that will
  be applied to files.

`rewriting.json` is expected to change often while you clean up names. The Web
interface and CLI can generate some rewriting rules automatically, and they
refresh the count/list fields on sync. Rule generation details belong in a
separate document; this document focuses on the file format and how existing
rules are applied.

For folder naming and path parsing details, see
[Folder Layout](folder-layout.md).

## Paths And Names

Track paths are relative to the execution/library root and use this shape:

```text
circle-folder/album-folder/.../track.ext
```

The first component becomes the circle name. Bracketed circle directories such
as `[RD-Sounds] Extra` are parsed as `RD-Sounds`.

The second component is always treated as the album folder. The parser accepts
an optional leading date, an optional leading record id in brackets, and an
optional trailing bracket suffix:

```text
2024.05.03 [RDS-0001] Example Album [Reitaisai]
```

From that example, the inferred date is `2024.05.03` and the structured album
name is `Example Album`.

Dates preserve their precision. A path date of `2024`, `2024.05`, or
`2024.05.03` stays at that precision; missing month/day values are not invented.

## `metadata.json`

`metadata.json` is written by `scan-albums`. It is a map from relative track path
to the tags read from that file.

```json
{
  "Circle/2024.05.03 [ABC-0001] Album/01.flac": {
    "Title": "Track title",
    "Artists": ["Artist A", "Artist B"],
    "Date": "2024.05.03",
    "Year": "2024",
    "Album artists": ["Circle"],
    "Disc subtitle": "Disc 1",
    "Album title": "Album",
    "Track number": 1,
    "Total tracks": 10,
    "Disc number": 1,
    "Total discs": 1,
    "Genre": "Touhou",
    "Comment": "source comment"
  }
}
```

All fields are optional per track. Field names use the tag-facing capitalization
shown above.

`Artists` and `Album artists` are arrays. During scan, if the tag reader returns
a single artist string containing `;`, `scan-albums` splits it on `;`, trims each
piece, and drops empty pieces. Downstream code consumes these arrays as already
tokenized names.

Supported scanned audio extensions are `flac`, `mp3`, and `m4a`.

## `structured.json`

`structured.json` is the main human-editable structure. It is organized by
circle, then album, then disc, then track path.

```json
{
  "Circle": {
    "albums": {
      "Album": {
        "album artists": ["Circle"],
        "discs": [
          {
            "$subtitle": "Disc 1",
            "$track numbers from order": false,
            "tracks": {
              "Circle/2024.05.03 [ABC-0001] Album/01.flac": {
                "title": "Track title",
                "date": "2024.05.03",
                "track number": 1,
                "artists": ["Artist A"],
                "genre": "Touhou"
              }
            }
          }
        ]
      }
    }
  }
}
```

Schema:

- Top level: object keyed by circle name.
- Circle object:
  - `albums`: object keyed by album title.
- Album object:
  - `album artists`: string array.
  - `discs`: ordered array of disc objects. The array order is the disc order.
- Disc object:
  - `$subtitle`: optional disc subtitle.
  - `$track numbers from order`: optional boolean. When true, output track
    numbers are assigned from the order of keys in `tracks`.
  - `tracks`: object keyed by relative track path.
- Track object:
  - `title`: string.
  - `artists`: string array.
  - `date`: optional string.
  - `track number`: optional number.
  - `genre`: optional string.

When `structured.json` is first built, the code groups tracks into discs using
existing disc numbers where possible. Missing disc numbers may trigger
album-title based grouping and audit entries because that classification may
need review.

On later syncs, `metadata.json` may contain track paths that are not yet present
in an existing `structured.json`. Those newly scanned tracks are built with the
same initial-structure logic and merged into `structured.json`. Existing
structured tracks, album names, disc order, subtitles, edited titles, artists,
dates, genres, and track-order settings are preserved. When a new track appears
under the same parsed circle and album-folder identity as an existing album, it
is added to that existing album even if the album has been renamed in
`structured.json`; otherwise a new circle/album entry is created.

Album titles can come from the parsed folder name or, for simple single-disc
albums, from a consistent existing `Album title` tag. Disc subtitles come from a
consistent `Disc subtitle` tag when available; for multi-disc albums they may
fall back to the first track's `Album title` for that disc.

When a title starts with its matching track number, prefixes like `02. Title`,
`(02) Title`, or `[02]-Title` may be normalized to `Title` during initial
structure building and reported in audit.

## `rewriting.json`

`rewriting.json` stores name and genre normalization data per circle, plus a
special `$all` entry for global rules and global aggregate lists.

```json
{
  "Circle": {
    "audited": false,
    "all album artists": {
      "Circle": 10
    },
    "album artists rewriting": [
      {
        "from": ["Old Circle Name"],
        "to": ["Circle"]
      }
    ],
    "all artists": {
      "Artist A": 3
    },
    "artists rewriting": [
      {
        "from": ["A. Artist"],
        "to": ["Artist A"]
      }
    ],
    "all genres": ["Touhou"],
    "genre rewriting": [
      {
        "from": ["Soundtrack"],
        "to": ["Touhou"]
      }
    ],
    "default genre": "Touhou"
  },
  "$all": {
    "all album artists": {},
    "album artists rewriting": [],
    "all artists": {},
    "artists rewriting": [],
    "all genres": [],
    "genre rewriting": []
  }
}
```

Schema:

- Top level: object keyed by circle name, plus optional/special `$all`.
- Circle rewriting object:
  - `audited`: boolean. Only audited circles are included when generating
    `update-metadata.json`.
  - `all album artists`: object mapping displayed album-artist name to count.
  - `album artists rewriting`: rewrite rules for album artists.
  - `all artists`: object mapping displayed track-artist name to count.
  - `artists rewriting`: rewrite rules for track artists.
  - `all genres`: sorted list of genres seen for that scope.
  - `genre rewriting`: rewrite rules for genres.
  - `default genre`: optional genre used when a track has no genre.
- Rewrite rule:
  - `from`: string array.
  - `to`: string array.

Rules are compiled into an internal lookup table before use. For each `from`
value, the first rule that mentions it wins. Chained rules are saturated in that
lookup, so each input name only needs one lookup at application time. Results
are deduplicated while preserving order.

For example, if we have rule
```json
{
  "from": ["AAA", "BBB"],
  "to": ["CCC", "DDD"]
}
```

Artists field `["BBB", "EEE"]` will be rewritten to `["CCC", "DDD", "EEE"]`.
The idea is that the `from` array can match multiple variants of the same name,
and the `to` array can map a composite name to multiple artists.

Chained rules are applied. If `A -> B` and `B -> C` both exist, input `A`
becomes `C`. Cyclic rules are rejected during sync/analyze instead of producing
updates.

Rule priority is:

1. Circle-specific rules.
2. `$all` rules.

So `$all` is useful for broad shared cleanup, but a circle rule has the earlier
chance to match.

Genre rewriting is similar and also uses the saturated lookup, except a genre
rule maps to the first value in `to`. If a track has no genre, `default genre`
is used before matching rules. Circle `default genre` takes priority over
`$all.default genre`.

### What Sync Does To Rewriting

When sync runs with an existing `rewriting.json`, it preserves the rules and
`default genre` values, and refreshes:

- `all artists`
- `all album artists`
- `all genres`
- `$all`

When a circle appears in `structured.json` but has no rewriting entry yet, rules
for that new circle may be generated automatically.

The saved `structured.json` is not modified by rewriting sync. Rewrites are
applied to cloned data when calculating name lists and when producing
`update-metadata.json`.

### Name Counts

The name count fields are review aids. They are computed from a cloned
`structured.json` after current rewriting is applied.

Each track contributes its rewritten track artists and its rewritten album
artists. Album artists are counted per track, not once per album, because album
artist tags are written to every track. Displayed counts use a case-sensitive
substring check over the combined artist and album-artist counts. This helps
joined names such as `Alice + Bob` still show up while you are deciding whether
another split/rewrite rule is needed.

`$all` counts use the same idea across all circles.

## `update-metadata.json`

`update-metadata.json` is the output patch consumed by `apply-tags`. It has the
same top-level shape as `metadata.json`, but it only contains tracks and fields
whose desired value differs from the original scan.

```json
{
  "Circle/2024.05.03 [ABC-0001] Album/01.flac": {
    "Title": "Corrected title",
    "Artists": ["Artist A"],
    "Album title": "Album",
    "Album artists": ["Circle"],
    "Track number": 1,
    "Total tracks": 10,
    "Date": "2024.05.03",
    "Year": "2024",
    "Genre": "Touhou"
  }
}
```

Possible patch fields are:

- `Title`
- `Artists`
- `Disc subtitle`
- `Album title`
- `Album artists`
- `Track number`
- `Total tracks`
- `Disc number`
- `Total discs`
- `Date`
- `Year`
- `Genre`
- `Comment`

`Comment` is preserved from the original metadata when materializing desired
metadata, so it is only patched if the desired preserved value differs from the
current scanned value.

For single-disc output (`Total discs == 1`), `Disc number` and `Total discs` are
suppressed from the patch even if the materialized desired metadata contains
them.

`apply-tags` writes array artists as multi-value tags. Date-like values accept
the same precision style used elsewhere; when `Date` is written, `Year` is kept
in sync from the date's year.
