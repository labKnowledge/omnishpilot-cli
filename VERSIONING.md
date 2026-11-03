# Versioning

**Global rule (canonical):** `~/.cursor/rules/versioning-start-0-0-1.mdc`

Applies to OmnishPilot and every other eligapris project the same way.

## Cycle

```
0.0.1 → 0.0.99 → 0.1.0 → … → 0.99.99 → 1.0.0
```

## Only two bumps

- **`+0.0.1`** — tiny / docs / chore / normal feature
- **`+0.0.5`** — major / breaking / large capability

Carry when a segment would pass 99. Never jump early to `0.1.0`, `0.5.0`, or `1.0.0`.

| From | Delta | To |
|------|-------|-----|
| `0.0.6` | +0.0.1 | `0.0.7` |
| `0.0.6` | +0.0.5 | `0.0.11` |
| `0.0.99` | +0.0.1 | `0.1.0` |
| `0.99.99` | +0.0.1 | `1.0.0` |
