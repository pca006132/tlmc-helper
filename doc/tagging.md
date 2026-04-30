# Audio File Tagging

Supported formats: mp3, m4a, flac.

For mp3, we require id3v2.4 multivalued tags, which are separated using `\0`.
On unsupported media players, they may only read the first value.
E.g., we may write `TPE1=AAA\0BBB`, which means we have `AAA` and `BBB` as artists, but unsupported media player may read this as `AAA` only.
We use `TSST` for disc subtitle.

For m4a, we use `----:com.apple.iTunes:DISCSUBTITLE` for disc subtitle, which is recognized by Picard, Kodi, navidrome, etc.

For flac, we write `ARTISTS` and `ALBUMARTISTS` for artists and album artists. 
We support reading from `ARTIST` and `ALBUMARTIST` as well, but we do not write them.
We use `DISCSUBTITLE` for disc subtitle.
