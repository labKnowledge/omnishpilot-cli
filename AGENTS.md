# OmnishPilot — notes for coding agents

This package is a **CLI autonomy harness**. Prefer the binary over reading source
when helping a user schedule work.

## Discover without skills

```bash
omnishpilot guide --json    # machine-readable contract
omnishpilot guide           # short playbook
omnishpilot help
omnishpilot doctor --json
```

## Default workflow

1. `omnishpilot doctor` — fix sandbox / agents if needed  
2. `omnishpilot start -d` (API commands also auto-start the daemon)  
3. Create work with explicit schedule flags (CLI does **not** NLP-parse times):

```bash
omnishpilot add --now --follow --workspace /path/to/repo "goal text"
omnishpilot add --daily 09:00 --workspace /path/to/repo "goal text"
omnishpilot add --command --hourly "curl -fsS https://example.com/health >/dev/null"
```

4. Track: `progress <id> --json`, `follow <id>`, `tasks --json`

## Skill (optional enrichment)

On `npm install -g omnishpilot`, a usage skill is copied to
`~/.agents/skills/omnishpilot` and symlinked for Cursor / Claude / Codex.

```bash
omnishpilot skill install
omnishpilot skill status
```

Skip: `OMNISHPILOT_SKIP_SKILL_INSTALL=1`.

## Hard rules

- Map user intent to **exact flags**; do not invent options.
- Use `--json` when parsing.
- Unattended agent jobs need a healthy sandbox (`sandbox check`).
- Never echo UI passwords, webhook tokens, or session secrets.
