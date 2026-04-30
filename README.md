# TLMC Helper

TLMC Helper is a small workflow for scanning music tags, reviewing album
metadata in a web app, and writing cleaned tags back to audio files.

## Web App

Open the web app here:

https://pca006132.github.io/tlmc-helper/

## Documentation

- [Folder layout](doc/folder-layout.md)
- [Data files and workflow](doc/data.md)
- [Rule generation](doc/rule-generation.md)
- [Tagging notes](doc/tagging.md)

Use the documentation for detailed file formats, rewrite behavior, and tagging
rules.

## Usage

1. Arrange your music library using the expected TLMC folder layout.
2. Run `scan-albums` in the library root to create `metadata.json`.
3. Open the web app.
4. Import `metadata.json`.
5. Optionally import existing `structured.json` and `rewriting.json`.
6. Review and edit album metadata and rewrite rules.
7. Click `Sync now`.
8. Download `update-metadata.json`.
9. Run `apply-tags` in the library root to write the updates.

The web app stores your imported data and edits locally in your browser, so
closing the tab should not lose your current work. You can still download
`structured.json` and `rewriting.json` when you want backups or files to reuse
later.

If you need to split albums from archive/CUE sources first, run `split-album`
before `scan-albums`.

## Binaries

Windows users can download the latest `split-album.exe`, `scan-albums.exe`, and
`apply-tags.exe` from the GitHub Actions page:

https://github.com/pca006132/tlmc-helper/actions

To build a release version locally:

```bash
cargo build --release
```

The binaries are written to `target/release/`.
