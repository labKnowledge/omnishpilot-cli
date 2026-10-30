---
name: omnishpilot
description: >-
  Schedule and run unattended agent or shell jobs with OmnishPilot (omnishpilot /
  agentboard CLI): sandboxed YOLO runs, cron-like schedules, follow/progress,
  acceptance gates, budget caps, login service. Use when the user wants overnight
  agent work, recurring automation, agent-run scheduling, cron for coding agents,
  or OmnishPilot setup/doctor/sandbox.
metadata:
  version: 0.0.6
  cli: omnishpilot
  homepage: https://github.com/labKnowledge/omnishpilot-cli
---

# OmnishPilot — schedule agents that finish alone

OmnishPilot is a **local autonomy harness**. It queues jobs, runs any agent CLI
on PATH (or a plain shell command) **unattended inside a sandbox**, tracks
progress, and can notify when work is done.

Binaries after `npm i -g omnishpilot`: `omnishpilot`, short alias **`omnip`**,
`agentboard` (legacy alias), `agent-run` (bundled). Prefer `omnip` in examples.

Prefer the CLI itself over guessing. Out of the box (no skill required):

```bash
omnishpilot guide          # human + agent playbook
omnishpilot guide --json   # machine-readable contract
omnishpilot help
omnishpilot doctor
```

## First 60 seconds

```bash
omnishpilot doctor
omnishpilot sandbox deny-test   # Linux: prove outside writes fail
omnishpilot start -d
omnishpilot service install     # optional: start on login
omnishpilot add --now --follow "write result.md summarizing this repo"
```

Data/config live in `~/.omnishpilot` (`OMNISHPILOT_HOME` to override).

## Dev operating system (subtle, built-in)

Unattended **code** jobs need more than a schedule — they need confidence to
research, plan, finish, and prove. OmnishPilot embeds a distilled Dev OS inside
this skill (not a separate product):

| File | When |
|------|------|
| [references/dev-operating-system.md](references/dev-operating-system.md) | Authority, value/effort, architecture lens |
| [references/single-shot-plan.md](references/single-shot-plan.md) | Research → plan.md → build → result.md |

**Harness injection** (so humans do not babysit skill attachment):

| Mode | Behavior |
|------|----------|
| `auto` (default) | Inject compact Dev OS for code-related agent jobs |
| `always` | Inject for every agent job |
| `off` | Never inject |

```bash
omnishpilot dev-mode              # show
omnishpilot dev-mode always       # compel for all agent jobs
omnishpilot add --dev "…"         # force on one job
omnishpilot add --no-dev "…"      # suppress one job
omnishpilot add --skills lean-venture-analyst "…"
```

Optional: set `"attachDevSkill": true` in config to also *name* a global `dev`
skill if the user keeps the full deep skill installed. Knowledge for success
still ships here so automation works without oversight.

## Agent decision tree

| User intent | Command shape |
|-------------|----------------|
| Do this once, soon | `omnishpilot add --now --follow "…"` |
| Do this once in N minutes | `omnishpilot add --in 30 "…"` |
| Every day / hour / week | `omnishpilot add --daily 09:00 "…"` / `--hourly` / `--weekly mon 09:30` |
| Pure script, no LLM | `omnishpilot add --command --daily 02:00 --workspace ~/data "./backup.sh"` |
| Full feature / greenfield unattended | `omnishpilot add --dev --now --follow --workspace ~/proj "…"` |
| Track a job you created | `omnishpilot progress <id> --json` then `follow <id>` |
| Is the machine ready? | `omnishpilot doctor --json` |
| Cap spend / time | `omnishpilot budget --minutes 180 --usd 20` |

**Rules for agents**

1. CLI is **deterministic** — no LLM interprets flags. Pass exact schedule flags.
2. Always prefer `--json` when parsing output.
3. After `add`, capture the returned job `id`; use `follow` / `progress` / `tasks`.
4. For coding work, pass `--workspace` to the repo root (Dev OS auto-attaches in `auto` mode).
5. Unattended agent jobs need a healthy sandbox (`doctor` + `sandbox check`).
6. Do not invent flags. Run `omnishpilot guide --json` or `help` if unsure.

## ADD contract (summary)

Default bare text:

```bash
omnishpilot add "do xyz"
# → template=agent-task, schedule=once at now+5m, runMode=auto
```

| Flag | Meaning |
|------|---------|
| `--now` | Run immediately |
| `--in <min>` | One-shot delay |
| `--at <ISO\|local>` | Absolute one-shot |
| `--interval <min>` | Every N minutes (min 5) |
| `--hourly [MM]` | Every hour |
| `--daily HH:MM` | Daily |
| `--weekly DAY HH:MM` | Weekly |
| `-w / --workspace` | Working directory |
| `-c / --command` | Shell job, no agent |
| `--agent <id>` | cursor-agent \| claude \| agy \| auto |
| `--acceptance <text>` | Done-when gates |
| `-f / --follow` | Block until done (exit 0/1) |
| `--json` | Machine output |
| `-n / --dry-run` | Print spec only |

Full detail: [references/cli-contract.md](references/cli-contract.md)  
Recipes: [references/recipes.md](references/recipes.md)

## Lifecycle agents should know

```bash
omnishpilot tasks [--json]              # list
omnishpilot task <id> [--json]          # full record
omnishpilot progress <id> [--json]      # status + log snippet + gates
omnishpilot follow <id> [--timeout SEC] # stream until done
omnishpilot run <id>                    # run now
omnishpilot mute|unmute|rm <id>
omnishpilot log <id>
omnishpilot watch                       # live dashboard
```

API-ish commands **auto-start** the daemon. Disable with `--no-autostart` or
`OMNISHPILOT_NO_AUTOSTART=1`.

## Sandbox (required for safe autonomy)

Skip-permissions / YOLO only runs when isolation is healthy (Linux **bwrap**
preferred; docker / firejail fallbacks).

```bash
omnishpilot sandbox status
omnishpilot sandbox check      # exit 1 if autonomous gate fails
omnishpilot sandbox deny-test
```

## Skill install / repair

Shipped with the npm package. Global install copies this skill to
`~/.agents/skills/omnishpilot` and symlinks into Cursor / Claude skill dirs.

```bash
omnishpilot skill install
omnishpilot skill status
omnishpilot skill uninstall
```

Skip on npm install: `OMNISHPILOT_SKIP_SKILL_INSTALL=1`.

## Helping humans (non-developers)

Speak in outcomes, not jargon:

1. Install: `npm install -g omnishpilot`
2. Check: `omnishpilot doctor`
3. Start: `omnishpilot start -d`
4. Schedule in plain language via `add`, or open the UI: `omnishpilot open`
5. Optional phone notify: install Omnish separately; then `omnishpilot notify-test`

One-liners that feel magical:

```bash
omnishpilot add --daily 09:00 "triage overnight CI and write result.md"
omnishpilot add --command --hourly "curl -fsS https://example.com/health >/dev/null"
omnishpilot add --now --follow --workspace ~/proj "fix the login bug; leave a patch"
```

## Checklist

```
- [ ] npm i -g omnishpilot  (or npx)
- [ ] omnishpilot doctor clean
- [ ] Linux: bubblewrap + sandbox deny-test
- [ ] omnishpilot start -d  (or service install)
- [ ] At least one agent CLI on PATH for agent jobs (cursor-agent / claude / …)
- [ ] First job: add --now --follow "…"
- [ ] skill installed: omnishpilot skill status
```

## Docs in the package

- README — install and ops
- `omnishpilot capabilities` — feature map
- `docs/capabilities.md` — deeper capability notes

Never print UI passwords, webhook tokens, or `auth.sessionSecret` into chat.
