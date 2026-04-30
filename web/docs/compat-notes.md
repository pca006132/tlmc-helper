# Compatibility Notes

The TypeScript implementation targets Rust parity first, with approved fixes:

1. **New-circle rule generation**  
   If `rewriting.json` exists and a new circle appears, rules are auto-generated for that circle.

2. **Structured rebuild audits**  
   When structured data is rebuilt from metadata, audits are emitted for that rebuild.

3. **Update coverage**  
   Update generation includes `Year` and `Total tracks` where applicable.

4. **Track title normalization during structured build (TS-only for now)**  
   When a track resolves to track number `1`, titles like `1 Name`, `01. Name`, `(01) Name`, or `[01]-Name` are normalized to `Name`.
   The containing album path is logged to `audit.track_title_rewrite`.

## Remaining assumptions

- `Comment` is preserved from source metadata when present.
- Rewriting semantics remain one-pass first-match with dedupe.
- `$all` rules are preserved and never auto-generated.
