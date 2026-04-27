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

We do not assume anything about the internals of the album.

# Cuesheet Pairing 

1. If there is a single flac file and a single cuesheet, this is trivial.
2. If there are multiple flac files and cuesheets, and flac filenames correspond to cuesheet filenames, this is also trivial.
3. Otherwise, consider flac and cuesheet to be related if one's name is a substring of another. If such association is non-ambiguous, use that association.

Exceptions:
1. If there is no cuesheet in the album, just write to `verbose.log` saying that there is nothing to split in this path.
2. If point 2 or 3 above applies but some flac files do not have associated cuesheets, append the path of the flac file as a new line to the file `missing-cue.txt`. For example, if `[circle]/2026.04.28 [ABCD-0123] foo bar [c123]/foo.flac` has no associated cuesheet, output `[circle]/2026.04.28 [ABCD-0123] foo bar [c123]/foo.flac` to `missing-cue.txt`. Different entries have different lines. Also log to `verbose.log` about this.
3. Similarly, if there is a cuesheet with no associated flac file, output it to `missing-flac.txt`. Also log to `verbose.log` about this.

In `verbose.log`, log the flac and cuesheet associations.

If there are multiple flac and cuesheet association pairs, write the album path to `multi-disc.txt` as a new line, since users have to set the new album name and disc id.
Also, the track files should be put into a subdirectory named `FLAC_NAME_WITHOUT_SUFFIX` in the album directory, so tracks belonging to different flac files (and hence discs) are separated.

# Reading Cuesheet

Use chardetng for decoding, since the file may be in some CJK encoding or UTF-8/16 with BOM.
If the cuesheet is not in standard encoding (ASCII/UTF-8 without BOM), log the path and encoding to `verbose.log`.
If failed to parse the cuesheet using flac-codec, write the cuesheet path to `corrupt-cuesheet.txt`, and skip processing such flac-cuesheet pair.

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
1. Top level REM tags, we only care about GENRE, DATE and COMMENT. These tags are mapped directly. If the date is missing, use the one from the album archive name. If genre or comment is missing, ignore them. 
2. Top level PERFORMER tag, this maps to the ALBUMARTIST tag in the track file. If this is missing, use the circle name from the folder path.
3. Top level TITLE tag, this maps to the ALBUM tag in the track file.
4. Track ID, this maps to the TRACKNUMBER tag in the track file.
5. Track TITLE and PERFORMER tag. These are mapped directly.

Other lines can basically be thrown away.
Also, note that we are working with with unicode, and for quoted values we may need to unescape \".

If album title, track title or track performer are missing, treat that as an empty string and continue. Write to both `verbose.log` and `missing-info.txt` about this (including the flac file path and track id).

