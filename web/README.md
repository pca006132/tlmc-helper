# tlmc web logic (phase-first)

This directory contains the TypeScript implementation used by the web app, split into three phases:

1. structured generation + rewriting generation
2. interactive rewriting application (per circle)
3. update generation

## Commands

- `npm install`
- `npm run check`
- `npm run check:gui`
- `npm test`
- `npm run gui:dev`
- `npm run gui:build`
- `npm run gui:preview`

## CLI behavior

The CLI in `src/cli/analyze-albums.ts` is kept for parity testing and internal checks:

- reads `metadata.json`
- uses existing `structured.json` / `rewriting.json` when present
- always writes `rewriting.json` and `update-metadata.json`
- writes `structured.json` when a rebuild happens
- optional circle args filter `update-metadata.json` by parsed circle name

## Public API

Top-level APIs are exposed in `src/core/api.ts`:

- `runPhase1(input, logger)`
- `createInteractivePhase2(phase1Result, logger)`
- `runPhase3(input, logger)`

The logger contract is `AnalyzeLogger` from `src/core/logger.ts`.

## GUI editor

The browser GUI lives in `src/gui` and edits `structured.json` and `rewriting.json` with
the same domain model used by the CLI.

Behavior:

- Import `metadata.json` (required), and optional `structured.json` / `rewriting.json`.
- Workspace sections:
  - `Workspace` (view selector, sync, grouped download actions)
  - `Album Metadata` (structured editing)
  - `Rewrite Rules` (rewriting editing)
- Rewriting editor includes special `$all` circle for global rules.
- Import and sync run in a Web Worker to keep UI responsive.
- Edits are local-only until `Sync now` is pressed.
- `Sync now` recomputes rewriting using current in-memory `structured.json` so exports match CLI behavior.
- Audit logs are shown in a dedicated panel with filter and clear actions.
- Session state (`metadata`, `structured`, `rewriting`, and audit log) is persisted in IndexedDB.
- Download actions are grouped in one `Download` card and export:
  - `structured.json`
  - `rewriting.json`
  - computed `update-metadata.json`
- Rewrite rule editing is drag-oriented:
  - rule cards are sortable
  - each rule has two chip lists (`from` first, `to` second)
  - `Add name` appends to `to`, then users can drag chips between lists
  - `Names` and `Rules` panes are independently scrollable (`80vh` cap)
