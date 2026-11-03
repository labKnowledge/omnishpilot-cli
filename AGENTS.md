# OmnishPilot — notes for coding agents

This package is a **CLI autonomy harness**. Prefer the binary over reading source
when helping a user schedule work.

## Version bumps (mandatory)

Do **not** invent semver. Read [VERSIONING.md](./VERSIONING.md) / `.cursor/rules/versioning.mdc`.

- Cycle: `0.0.1 → 0.0.99 → 0.1.0 → … → 0.99.99 → 1.0.0`
- Only: **`+0.0.1`** (normal) or **`+0.0.5`** (major/large capability), then carry after 99
- Example from `0.0.6`: normal → `0.0.7`; major → `0.0.11` — never jump to `0.1.0` / `0.5.0`

## Discover without skills

```bash
omnip guide --json    # or: omnishpilot (same binary)
omnip guide
omnip help
omnip doctor --json
```

## Default workflow

1. `omnishpilot doctor` — fix sandbox / agents if needed  
2. `omnishpilot start -d` (API commands also auto-start the daemon)  
3. Create work with explicit schedule flags (CLI does **not** NLP-parse times):

```bash
omnishpilot add --now --follow --workspace /path/to/repo "goal text"
omnishpilot add --daily 09:00 --workspace /path/to/repo "goal text"
omnishpilot add --command --hourly "curl -fsS https://example.com/health >/dev/null"
omnishpilot concurrency 8          # parallel overnight work (default 4)
omnishpilot add --now --queue "…"  # this job waits until idle
```

4. Track: `progress <id> --json`, `follow <id>`, `tasks --json`

Jobs run **in parallel by default** (not a single serial queue). Use
`concurrency serial` or per-job `--queue` when order matters.

## Skill (optional enrichment)

On `npm install -g omnishpilot`, a usage skill is copied to
`~/.agents/skills/omnishpilot` and symlinked for Cursor / Claude / Codex.

```bash
omnishpilot skill install
omnishpilot skill status
```

Skip: `OMNISHPILOT_SKIP_SKILL_INSTALL=1`.

## Dev OS (unattended coding confidence)

Code-related agent jobs get a distilled Dev operating system injected by default
(`agent.devMode: auto`). Knowledge lives in the OmnishPilot skill references —
subtle, no separate attach required for success.

```bash
omnishpilot dev-mode always   # compel for every agent job
omnishpilot add --dev --workspace ~/proj "scaffold …"
```

## Hard rules

- Map user intent to **exact flags**; do not invent options.
- Use `--json` when parsing.
- Unattended agent jobs need a healthy sandbox (`sandbox check`).
- Never echo UI passwords, webhook tokens, or session secrets.
