# Web Implementation

The `web/` directory contains the TypeScript implementation used by the browser
app and the parity test CLI. It mirrors the Rust workflow in three phases:

1. Build or merge `structured.json`, then build or refresh `rewriting.json`.
2. Apply interactive rewrite edits while preserving the same rewrite semantics.
3. Generate `update-metadata.json` from edited structured data and audited
   rewrite state.

## Commands

Run these from `web/`:

- `npm install`
- `npm run check`
- `npm run check:gui`
- `npm test`
- `npm run gui:dev`
- `npm run gui:build`
- `npm run gui:preview`

## Core API

The phase entry points are exposed from `web/src/core/api.ts`:

- `runPhase1(input, logger)`: builds or merges structured data and refreshes
  rewriting data.
- `refreshRewriting(input, logger)`: refreshes rewriting from current structured
  data and existing rewrite rules.
- `createInteractivePhase2(phase1Result, logger)`: creates the interactive
  rewrite session used by parity tests and older flows.
- `runPhase3(input, logger)`: computes `update-metadata.json`.

The logger contract is `AnalyzeLogger` from `web/src/core/logger.ts`.

## Browser GUI

The browser GUI lives in `web/src/gui`. It edits `structured.json` and
`rewriting.json` in memory using the same domain model as the TypeScript CLI.

Import accepts `metadata.json` as required input, plus optional `structured.json`
and `rewriting.json`. Import and automatic sync run in a Web Worker so the UI
remains responsive.

The workspace selector has two views:

- `Album Metadata`: edit albums, discs, track titles, dates, track numbers,
  artists, album artists, and genres.
- `Rewrite Rules`: inspect effective artist, album-artist, and genre names;
  edit per-circle and `$all` rewrite rules; mark circles as audited.

When switching between workspace views, the UI keeps the same circle when that
circle exists in the destination view. `$all` remains manually selectable in the
Rewrite Rules view.

## Rewrite Rules View

The Rewrite Rules view has a circle selector and a rewrite target selector:

- `artists rewriting`
- `album artists rewriting`
- `genre rewriting`

The names panel title changes with the selected target: `All Artists`,
`All Album Artists`, or `All Genres`. Double-clicking a name jumps to the first
matching Album Metadata field after rewriting and highlights that field briefly.
This is useful when a strange name points to bad source metadata rather than a
normalization rule.

The rules panel contains sortable rule cards. Each rule has two chip lists:
`from` first, then `to`. Names can be dragged between those lists. The `Add rule`
button lives below the rule list.

The `Audited` checkbox is available for normal circles, not `$all`. Toggling it
queues an automatic sync. Only audited circles are included when generating
`update-metadata.json`.

## Album Metadata View

Artist, album-artist, and genre fields show editable source metadata beside a
read-only `(after rewriting)` value. The read-only value is computed from the
current circle rules followed by `$all` rules. Genre also uses the circle or
global default genre fallback, matching update generation.

Discs and tracks are sortable. Reordering tracks updates track numbers by order
and enables `$track numbers from order` for that disc.

## Sync And Persistence

Local edits update the in-memory session immediately and queue an automatic
sync. Sync rebuilds generated aggregate rewrite data from current edited
structured data and existing rules so exported files match CLI behavior. The UI
does not block while sync is running; if another edit happens during a sync, the
next sync is deferred until the worker finishes the current one. Download
actions wait for the sync queue to settle before exporting.

Rewrite rule cards whose `from` or `to` side is empty are considered invalid
drafts. They remain visible for editing, but sync and update generation ignore
them until both sides contain at least one value.

Current `metadata`, `structured`, `rewriting`, and audit entries are persisted
in IndexedDB and restored on reload. Sync merges new audit entries into the
existing audit log. The log is replaced by a fresh import and cleared only by
the `Clear log` button.

Download actions export:

- `structured.json`
- `rewriting.json`
- computed `update-metadata.json`

## TypeScript CLI

`web/src/cli/analyze-albums.ts` is kept for parity testing and internal checks.
It:

- reads `metadata.json`
- uses existing `structured.json` and `rewriting.json` when present
- writes `structured.json` when a rebuild happens
- always writes refreshed `rewriting.json`
- writes `update-metadata.json`
- accepts optional circle arguments to filter `update-metadata.json` by parsed
  circle name
