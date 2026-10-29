'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Distilled "Dev" operating system for unattended agent jobs.
 *
 * Why this exists: a separate global `dev` skill gives agents confidence to
 * finish ambitious work — but scheduled jobs cannot rely on a human attaching
 * it. Folding a compact OS into OmnishPilot (with deeper knowledge on disk)
 * makes that confidence part of the harness.
 *
 * Modes (cfg.agent.devMode):
 *   auto   — inject for code-related agent jobs (default)
 *   always — inject for every agent job
 *   off    — never inject (user can still list skills manually)
 *
 * Per-job override: inputs.devMode = true | false | 'auto'
 */

const CODE_TEMPLATE_IDS = new Set([
  'agent-task',
  'code-task',
  'code-change',
  'feature',
  'bugfix',
  'refactor',
]);

const CODE_GOAL_RE =
  /\b(fix|bug|implement|refactor|build|ship|code|api|ui|test|migrate|deploy|typescript|react|node|python|rust|go|kotlin|android|ios|cli|sdk|pr\b|pull request|repo|codebase|scaffold|prototype|app|feature)\b/i;

const CODE_MARKERS = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  '.git',
];

function skillKnowledgeRoot() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const installed = path.join(home, '.agents', 'skills', 'omnishpilot');
  if (fs.existsSync(path.join(installed, 'SKILL.md'))) return installed;
  // Fallback: packaged skill (dev checkout / before postinstall)
  const packaged = path.join(__dirname, '..', '..', 'skills', 'omnishpilot');
  if (fs.existsSync(path.join(packaged, 'SKILL.md'))) return packaged;
  return installed;
}

function workspaceLooksLikeCode(workspace) {
  if (!workspace || !fs.existsSync(workspace)) return false;
  try {
    return CODE_MARKERS.some((name) => fs.existsSync(path.join(workspace, name)));
  } catch {
    return false;
  }
}

function isCodeRelated(task) {
  const templateId = String(task.templateId || task.inputs?.templateId || '').toLowerCase();
  if (CODE_TEMPLATE_IDS.has(templateId)) {
    // agent-task is the default catch-all — still check goal/workspace signal
    if (templateId !== 'agent-task') return true;
  }
  if (templateId === 'shell-command') return false;

  const skills = [].concat(task.inputs?.skills || task.skills || []).map(String);
  if (skills.some((s) => /^(coding-agent|dev|omnishpilot)$/i.test(s) || /code|engineer|dev/i.test(s))) {
    return true;
  }

  const goal = `${task.inputs?.goal || ''} ${task.summary || ''} ${task.title || ''}`;
  if (CODE_GOAL_RE.test(goal)) return true;

  const workspace = task.inputs?.workspace || '';
  if (workspaceLooksLikeCode(workspace)) return true;

  return templateId === 'agent-task' && Boolean(workspace);
}

function resolveDevMode(task, cfg) {
  const raw =
    task.inputs?.devMode != null
      ? task.inputs.devMode
      : (cfg.agent?.devMode != null ? cfg.agent.devMode : 'auto');

  if (raw === false || raw === 'off' || raw === 0) return 'off';
  if (raw === true || raw === 'always' || raw === 'on' || raw === 1) return 'always';
  return 'auto';
}

function shouldInjectDevOs(task, cfg) {
  if (String(task.templateId || '') === 'shell-command') return false;
  const mode = resolveDevMode(task, cfg);
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return isCodeRelated(task);
}

/** Compact block (~350–500 tokens). Deeper knowledge stays on disk. */
function buildDevOsBlock(task, cfg) {
  const root = skillKnowledgeRoot();
  const osPath = path.join(root, 'references', 'dev-operating-system.md');
  const planPath = path.join(root, 'references', 'single-shot-plan.md');
  const title = task.inputs?.title || task.title || 'Task';

  return `
## Dev operating system (OmnishPilot — unattended)

You are running without a human watching. Finish. Do not pause for mid-run approval.

**Mission:** maximize value, minimize effort. Absorb complexity; deliver outcomes the person can verify in the morning.

**Authority:** refactor, redesign, choose architecture, add tests, fix adjacent bugs that block the goal. Prefer the simplest effective path. Elevate quality — do not merely satisfy the prompt.

**Single-shot loop (required for non-trivial work):**
1. **Research** the workspace (README, package manifests, neighboring code, existing patterns) before writing.
2. **Plan** — write a short \`plan.md\` in the output directory (goals, risks, ordered steps, done-when). Then execute that plan.
3. **Build** with progressive disclosure: ship the vertical slice that proves the outcome first.
4. **Verify** — run the obvious checks; leave proof in \`result.md\` (what changed, how verified, what remains).

**Golden questions** (use when stuck): Can we remove / automate / infer / default this? Can one action unlock more value?

**Deeper knowledge** (read when the task is greenfield, multi-file, or UX-heavy):
- ${osPath}
- ${planPath}

Task: ${title}
`;
}

/**
 * Ensure skills list includes omnishpilot (and optionally listed extras)
 * so agents that honor skill names can load the installed skill.
 */
function enrichSkills(task, cfg, { injectDev }) {
  const skills = [].concat(task.inputs?.skills || task.skills || []).filter(Boolean).map(String);
  const out = [...skills];
  const pushUnique = (name) => {
    if (!out.some((s) => s.toLowerCase() === String(name).toLowerCase())) out.push(name);
  };

  if (injectDev) {
    pushUnique('omnishpilot');
    // Optional: if the user keeps a full local `dev` skill, name it so capable agents load it.
    if (cfg.agent?.attachDevSkill === true) pushUnique('dev');
  }

  const extras = [].concat(cfg.agent?.defaultSkills || []).filter(Boolean);
  for (const s of extras) pushUnique(s);

  return out;
}

function applyDevModeToPrompt(basePrompt, task, cfg) {
  const inject = shouldInjectDevOs(task, cfg);
  if (!inject) {
    return { prompt: basePrompt, injectDev: false, skills: enrichSkills(task, cfg, { injectDev: false }) };
  }
  const block = buildDevOsBlock(task, cfg);
  // Put OS early so it frames the rest of the prompt.
  const prompt = `${block.trim()}\n\n${basePrompt}`;
  return { prompt, injectDev: true, skills: enrichSkills(task, cfg, { injectDev: true }) };
}

module.exports = {
  skillKnowledgeRoot,
  isCodeRelated,
  resolveDevMode,
  shouldInjectDevOs,
  buildDevOsBlock,
  enrichSkills,
  applyDevModeToPrompt,
  CODE_TEMPLATE_IDS,
};
