'use strict';

/**
 * Embedded agent + human playbook so OmnishPilot is usable without the skill.
 * Keep in sync with skills/omnishpilot/SKILL.md and HELP in index.js.
 */

const VERSION = require('../package.json').version;

const GUIDE_TEXT = `OmnishPilot guide v${VERSION}
Schedule agent or shell jobs unattended, sandboxed, with progress tracking.

Short alias: omnip  (same as omnishpilot)

Quick start:
  omnip doctor
  omnip start -d
  omnip add --now --follow "write result.md summarizing this repo"

For agents (deterministic — no LLM interprets flags):
  omnip add --now --follow --workspace <path> "<goal>"
  omnip add --daily 09:00 --workspace <path> "<goal>"
  omnip add --command --hourly "curl -fsS https://example.com/health >/dev/null"
  omnip progress <id> --json
  omnip follow <id>

ADD timing (pick one):
  --now | --in <min> | --at <when>
  --interval <min> | --hourly [MM] | --daily HH:MM | --weekly DAY HH:MM
  (default: once at now+5 minutes)

Common flags:
  -w|--workspace <path>   --agent <id>   --acceptance <text>
  -c|--command            --title <text> --json  -f|--follow  -n|--dry-run

Lifecycle:
  tasks | task <id> | progress <id> | follow <id> | run <id> | rm <id>
  sandbox check | deny-test | capabilities | budget | skill status

Dev OS (code jobs, default auto):
  omnip dev-mode always|auto|off
  omnip add --dev|--no-dev --workspace <path> "<goal>"

Machine-readable: omnip guide --json
Full help:        omnip help
Skill (optional): omnip skill install  →  ~/.agents/skills/omnishpilot
`;

const GUIDE_JSON = {
  name: 'omnishpilot',
  version: VERSION,
  summary:
    'Local autonomy harness: schedule sandboxed unattended agent/shell jobs, track progress, notify when done.',
  binaries: ['omnishpilot', 'omnip', 'agentboard', 'agent-run'],
  discovery: {
    withoutSkill: ['omnip guide', 'omnip guide --json', 'omnip help', 'omnip doctor'],
    withSkill: '~/.agents/skills/omnishpilot (symlinked into ~/.cursor/skills and ~/.claude/skills)',
  },
  firstRun: [
    'omnip doctor',
    'omnip sandbox deny-test',
    'omnip start -d',
    'omnip add --now --follow "…"',
  ],
  add: {
    default: {
      template: 'agent-task',
      schedule: 'once at now+5m',
      runMode: 'auto',
    },
    timing: {
      once: ['--now', '--in <minutes>', '--at <ISO|local>'],
      recurring: ['--interval <minutes>', '--hourly [MM]', '--daily HH:MM', '--weekly DAY HH:MM'],
    },
    flags: [
      { name: '--workspace|-w', meaning: 'Working folder / repo' },
      { name: '--command|-c', meaning: 'Pure shell job (no agent)' },
      { name: '--agent', meaning: 'cursor-agent | claude | agy | auto' },
      { name: '--acceptance', meaning: 'Done-when gates' },
      { name: '--follow|-f', meaning: 'Block until completed/failed' },
      { name: '--json', meaning: 'Machine-readable output' },
      { name: '--dry-run|-n', meaning: 'Print spec only' },
    ],
  },
  track: ['tasks --json', 'task <id> --json', 'progress <id> --json', 'follow <id>'],
  safety: ['sandbox check', 'sandbox deny-test', 'budget --minutes N --usd N'],
  env: {
    OMNISHPILOT_HOME: 'Config + data directory',
    OMNISHPILOT_NO_AUTOSTART: 'Disable auto daemon start',
    OMNISHPILOT_SKIP_SKILL_INSTALL: 'Skip skill copy on npm postinstall',
  },
  devMode: {
    config: 'agent.devMode = auto | always | off',
    cli: ['omnip dev-mode', 'omnip add --dev', 'omnip add --no-dev', 'omnip add --skills a,b'],
    knowledge: [
      '~/.agents/skills/omnishpilot/references/dev-operating-system.md',
      '~/.agents/skills/omnishpilot/references/single-shot-plan.md',
    ],
    note: 'Distilled Dev OS injects into code-related agent prompts so unattended jobs finish without a human attaching skills.',
  },
  agentRules: [
    'CLI is deterministic; map intent to exact flags.',
    'Prefer --json when parsing.',
    'Pass --workspace for coding jobs (Dev OS auto-attaches in auto mode).',
    'Confirm sandbox before unattended agent (YOLO) jobs.',
    'Do not invent flags; use guide --json or help.',
  ],
};

function printGuide(flags = {}) {
  const wantJson = Boolean(flags.json);
  if (wantJson) {
    process.stdout.write(`${JSON.stringify(GUIDE_JSON, null, 2)}\n`);
    return;
  }
  process.stdout.write(GUIDE_TEXT);
}

module.exports = { GUIDE_TEXT, GUIDE_JSON, printGuide };
