# tlmc web logic (phase-first)

This directory contains a TypeScript port of `analyze-albums` logic, split into three phases:

1. structured generation + rewriting generation
2. interactive rewriting application (per circle)
3. update generation

## Commands

- `npm install`
- `npm run check`
- `npm test`
- `npm run analyze-albums -- [circle ...]`

## CLI behavior

The CLI in `src/cli/analyze-albums.ts` mirrors the Rust binary behavior:

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
