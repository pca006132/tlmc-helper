# analyze-albums GUI notes

## Goals

- Keep implementation simple and easy to edit.
- Keep behavior close to CLI semantics.

## Import flow

- `metadata.json` is required.
- `structured.json` and `rewriting.json` are optional.
- Initialization runs phase-1 logic so missing files can be derived.

## Structured view

- Circle selector and album selector.
- Changing circle automatically selects the earliest album (lexical order).
- Album fields:
  - album name (editable)
  - album artists (Tagify with suggestions from circle `all album artists`)
- Discs are sortable.
- Tracks are sortable.
- Track fields:
  - `title`
  - `artists` (Tagify with suggestions from circle `all artists`)
  - `track number`
  - `date`
  - `genre`

## Rewriting view

- Circle selector includes `$all`.
- Target selector:
  - `artists rewriting`
  - `album artists rewriting`
  - `genre rewriting`
- Left panel shows names for the selected target type.
- Right panel shows sortable rules.
- Rules can be added and removed.
- Each rule has `from` and `to` Tagify rows.
- `default genre` is intentionally not exposed in UI for now.

## Sync behavior

- Import and sync run in a Web Worker.
- Sync only happens when `Sync now` is pressed.
- `Sync now` rebuilds rewriting from current edited structured data and existing rewriting rules.
- This keeps exported files aligned with CLI behavior when re-run externally.

## Persistence

- Current `metadata`, `structured`, `rewriting`, and audit entries are stored in local storage.
- Session is restored automatically on page reload.

## Audit log panel

- Audit entries are shown below the main editor.
- Filter by audit code with dropdown.
- Clear log button removes current entries.
