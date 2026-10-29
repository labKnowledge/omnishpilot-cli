'use strict';

/**
 * Embedded agent + human playbook so OmnishPilot is usable without the skill.
 * Keep in sync with skills/omnishpilot/SKILL.md and HELP in index.js.
 */

const VERSION = require('../package.json').version;

const GUIDE_TEXT = `OmnishPilot guide v${VERSION}
Schedule agent or shell jobs unattended, sandboxed, with progress tracking.

Quick start:
  omnishpilot doctor
  omnishpilot start -d
  omnishpilot add --now --follow "write result.md summarizing this repo"

For agents (deterministic — no LLM interprets flags):
  omnishpilot add --now --follow --workspace <path> "<goal>"
  omnishpilot add --daily 09:00 --workspace <path> "<goal>"
  omnishpilot add --command --hourly "curl -fsS https://example.com/health >/dev/null"
  omnishpilot progress <id> --json
  omnishpilot follow <id>

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

Machine-readable: omnishpilot guide --json
Full help:        omnishpilot help
Skill (optional): omnishpilot skill install  →  ~/.agents/skills/omnishpilot
`;

const GUIDE_JSON = {
  name: 'omnishpilot',
  version: VERSION,
  summary:
    'Local autonomy harness: schedule sandboxed unattended agent/shell jobs, track progress, notify when done.',
  binaries: ['omnishpilot', 'agentboard', 'agent-run'],
  discovery: {
    withoutSkill: ['omnishpilot guide', 'omnishpilot guide --json', 'omnishpilot help', 'omnishpilot doctor'],
    withSkill: '~/.agents/skills/omnishpilot (symlinked into ~/.cursor/skills and ~/.claude/skills)',
  },
  firstRun: [
    'omnishpilot doctor',
    'omnishpilot sandbox deny-test',
    'omnishpilot start -d',
    'omnishpilot add --now --follow "…"',
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
  agentRules: [
    'CLI is deterministic; map intent to exact flags.',
    'Prefer --json when parsing.',
    'Pass --workspace for coding jobs.',
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
