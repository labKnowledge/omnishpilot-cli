# OmnishPilot CLI contract (for agents)

Source of truth when the skill and `omnishpilot help` disagree: run
`omnishpilot guide --json` on the installed binary.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (`follow` / `add --follow`: job completed) |
| 1 | Failure (job failed, doctor issues, bad args, autonomous gate) |

## Stable commands

| Command | Purpose | Prefer `--json` |
|---------|---------|-----------------|
| `doctor` | Health of node, agents, sandbox, daemon | yes |
| `guide` | Embedded playbook + ADD schema | yes |
| `help` | Full human help text | — |
| `version` | Semver string | — |
| `start -d` | Daemonize control plane | — |
| `stop` / `restart` / `status` | Daemon lifecycle | status: yes |
| `service install\|uninstall\|status\|logs` | Login persistence | — |
| `add <goal…>` | Create scheduled job | yes |
| `tasks [status]` | List jobs | yes |
| `task <id>` | One job | yes |
| `progress <id>` | Status + logs + gates | yes |
| `follow <id>` | Block until terminal state | optional |
| `run <id>` | Trigger now | — |
| `sandbox status\|check\|deny-test` | Isolation | yes |
| `capabilities` | Feature flags | yes |
| `budget` | Daily minutes / monthly USD caps | yes |
| `skill install\|status\|uninstall` | Agent skill on disk | yes |
| `config show\|path\|init` | Config | show prints JSON |
| `password set\|status\|change` | UI auth | — |

## ADD flags (1:1 with job record)

No natural-language schedule parsing on the CLI. Map intent → flags.

### Timing (pick one family)

- One-shot: `--now` | `--in <minutes>` | `--at <when>`
- Recurring: `--interval <minutes>` | `--hourly [MM]` | `--daily HH:MM` | `--weekly DAY HH:MM`

Default if none: once at **now + 5 minutes**.

### Job kind

- Agent (default): template `agent-task`, goal = remaining args
- Shell: `--command` / `-c` / `--cmd` → template `shell-command`

### Context

- `--workspace|-w <path>` — cwd / repo
- `--template|-t <id>` — override template
- `--title <text>`
- `--agent <id>` — agent jobs only
- `--acceptance <text>` — done-when

### Output / control

- `--json`
- `--follow|-f` — after create, wait for completion
- `--dry-run|-n`

## Example JSON mental model after `add --json`

Expect fields similar to: `id`, `title`, `status`, `schedule`, `templateId`,
`workspace` / inputs, `runMode`. Always use the real JSON from the CLI.

## Env

| Variable | Effect |
|----------|--------|
| `OMNISHPILOT_HOME` | Config + data dir |
| `OMNISHPILOT_HOST` / `OMNISHPILOT_PORT` | Client target |
| `OMNISHPILOT_NO_AUTOSTART` | Do not spawn daemon |
| `OMNISHPILOT_SKIP_SKILL_INSTALL` | Skip postinstall skill copy |
| `OMNISHPILOT_INSTALL_SKILL=1` | Force skill install on local npm install |
