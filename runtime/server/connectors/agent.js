const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig, ROOT } = require('../config');
const { GENERIC_AGENT } = require('./ids');
const agents = require('../agents');
const store = require('../store');
const sandbox = require('../sandbox');
const acceptance = require('../acceptance');
const recovery = require('../recovery');
const { resolveAgentRunSpawn } = require('../resolve-bin');
const devMode = require('../dev-mode');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

function buildAgentEnv(cfg) {
  const env = { ...process.env };
  const envFile = cfg.agent?.envFile;
  if (envFile && fs.existsSync(envFile)) {
    const parsed = parseEnvFile(envFile);
    if (parsed.PATH) env.PATH = parsed.PATH;
    if (parsed.CURSOR_AGENT) env.CURSOR_AGENT = parsed.CURSOR_AGENT;
    if (parsed.CURSOR_MODEL) env.CURSOR_MODEL = parsed.CURSOR_MODEL;
  }
  return env;
}

function agentPromptPath(task, opts = {}) {
  const ins = task.instructions?.agentPrompt || '';
  const goal = task.inputs?.goal || task.summary || '';
  const title = task.inputs?.title || task.title;
  const workspace = task.inputs?.workspace || '';
  const deliverables = task.instructions?.deliverables || task.instructions?.outline || '';
  const constraints = task.instructions?.constraints || task.instructions?.acceptance || '';
  const skills = [].concat(
    opts.skills || task.inputs?.skills || task.skills || []
  ).filter(Boolean);

  const skillsBlock = skills.length
    ? `\n## Skills to use\n${skills.map(s => `- ${s}`).join('\n')}\n\nIf a named skill is installed globally (e.g. ~/.agents/skills/<name>), load it. Scan the workspace before writing copy or code.\n`
    : '';

  // Custom agentPrompt still gets skills + structure appended when empty sections dominate;
  // if the user supplied a full prompt, honor it but prepend skills when we have them.
  if (ins.trim()) {
    if (!skills.length) return ins;
    return `${skillsBlock.trim()}\n\n${ins}`;
  }

  return `# ${title}
${skillsBlock}
## Goal
${goal}

## Workspace
${workspace || '(agent default)'}

## Deliverables
${deliverables || 'Write results to the output directory.'}

## Constraints
${constraints || 'Be thorough. Verify your work.'}

## When done
Write a summary of what you did and where outputs are saved.
`;
}

function resolveWorkspace(task, cfg, logStream) {
  const raw = (task.inputs?.workspace || '').trim();
  const fallback = cfg.agent?.defaultWorkspace || ROOT;
  if (raw && fs.existsSync(raw)) return { path: path.resolve(raw), warned: false };
  if (raw) {
    logStream.write(`WARN: workspace folder not found: ${raw}\n`);
    logStream.write(`      Using default: ${fallback}\n`);
  }
  const use = fs.existsSync(fallback) ? path.resolve(fallback) : ROOT;
  return { path: use, warned: !!raw };
}

// Every job automatically asks the agent to self-report at milestones over Omnish — the
// person waiting on a long job shouldn't have to guess whether it's still alive. This is a
// best-effort nudge (the agent has to actually run the shell command), backed up by a
// guaranteed elapsed-time heartbeat from the supervisor (server/supervisor.js) that fires
// regardless of whether the agent cooperates.
function progressUpdatesBlock(cfg, task) {
  if (!cfg.omnish?.enabled) return '';
  const bin = cfg.omnish?.bin || 'omnish';
  const peer = cfg.omnish?.peer || '*';
  const title = (task.inputs?.title || task.title || 'Task').replace(/"/g, '\\"');
  return `
## Progress updates (required for longer work)
This task may take a while, and the person who queued it can't see your reasoning — only what you send. After each major milestone (roughly every 20-30% of the way, or after finishing a distinct phase like research, drafting, building, or verifying), run this exact shell command with a short one-line status in place of <status>:
${bin} i -c "/sendto ${peer} -t \\"${title}\\" -- <status>"
Send your first update within the first couple of minutes if the task will take more than ~5 minutes total. Keep each status under 160 characters and specific (what you just finished, what's next) — not generic ("working on it").
`;
}

function runGenericAgent(task, logPath) {
  const cfg = loadConfig();
  const outDir = path.join(cfg.dataDir, 'outputs', task.id);
  fs.mkdirSync(outDir, { recursive: true });

  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n=== ${new Date().toISOString()} ${GENERIC_AGENT} ===\n`);

  const { path: workspacePath, warned } = resolveWorkspace(task, cfg, logStream);
  const promptFile = path.join(outDir, 'agent-prompt.md');
  const profile = acceptance.resolveAcceptance(task, cfg);
  const acceptanceBlock = profile.enabled
    ? `
## Acceptance gates (enforced after you exit)
Your run is NOT done until these pass — the harness will re-queue you on failure:
${profile.requiredArtifacts.map((a) => `- Required artifact: ${a} (prefer under the output directory)`).join('\n')}
${profile.testCommand ? `- Test command (must exit 0): \`${profile.testCommand}\`` : ''}
${profile.text ? `\nCriteria:\n${profile.text}\n` : ''}
Always write \`result.md\` in the output directory summarizing what changed and how you verified it.
`
    : `
## When finishing
Write \`result.md\` in the output directory summarizing what you did and where outputs are.
`;
  const enrichedSkills = devMode.enrichSkills(task, cfg, {
    injectDev: devMode.shouldInjectDevOs(task, cfg),
  });
  // Persist resolved skills so the UI / follow-up runs see what the harness attached.
  if (enrichedSkills.length) {
    store.updateTask(task.id, { inputs: { ...(task.inputs || {}), skills: enrichedSkills } });
    task = { ...task, inputs: { ...(task.inputs || {}), skills: enrichedSkills } };
  }

  let body = `${agentPromptPath(task, { skills: enrichedSkills })}
${recovery.retryNote(task.execution?.retryOf)}
## Output directory
Save all deliverables here: ${outDir}

## Agent tools
Use available tools (GenerateImage, file write, shell) as needed to complete the goal.
For images: save PNG files into the output directory and write a brief result.md summary.
${acceptanceBlock}${progressUpdatesBlock(cfg, task)}`;

  const applied = devMode.applyDevModeToPrompt(body, task, cfg);
  const fullPrompt = applied.prompt;
  fs.writeFileSync(promptFile, fullPrompt);
  logStream.write(`workspace: ${workspacePath}${warned ? ' (fallback)' : ''}\n`);
  logStream.write(`output: ${outDir}\n`);
  logStream.write(`prompt: ${promptFile}\n`);
  logStream.write(`devMode: ${devMode.resolveDevMode(task, cfg)} inject=${applied.injectDev ? 'yes' : 'no'}\n`);
  if (enrichedSkills.length) logStream.write(`skills: ${enrichedSkills.join(', ')}\n`);

  const env = buildAgentEnv(cfg);
  try {
    const { augmentedPath } = require('../resolve-bin');
    env.PATH = augmentedPath(env.PATH || process.env.PATH || '');
  } catch { /* ignore */ }
  const requestedAgentId = task.inputs?.agentId || task.execution?.agentId;
  const agentId = agents.pickAgent({ requestedId: requestedAgentId }) || requestedAgentId || 'auto';
  if (requestedAgentId && requestedAgentId !== 'auto' && agentId !== requestedAgentId) {
    logStream.write(`NOTE: requested agent "${requestedAgentId}" is unavailable or cooling down — using "${agentId}" instead\n`);
  }
  store.updateTask(task.id, { execution: { resolvedAgentId: agentId } });
  const model = cfg.agent?.cursorModel || env.CURSOR_MODEL;

  const runArgs = ['run', '--agent', agentId, '--workspace', workspacePath, '--prompt-file', promptFile, '--out', outDir];
  if (model) runArgs.push('--model', model);
  if (task.inputs?.commandTemplate) runArgs.push('--command-template', task.inputs.commandTemplate);
  if (task.inputs?.flattenPrompt === true) runArgs.push('--flatten');
  else if (task.inputs?.flattenPrompt === false) runArgs.push('--no-flatten');

  const inv = resolveAgentRunSpawn(cfg, runArgs);
  logStream.write(`agent-run: ${inv.script}\n`);

  // cwd = output dir (always exists). --workspace = project the agent edits.
  // detached: true so a Stop/kill from the board can terminate the whole process
  // group (agent-run + the agent CLI it spawns), not just orphan the agent behind it.
  // Unattended agent-run is wrapped in the sandbox (bwrap/docker) when enabled —
  // autonomy without isolation is refused when sandbox.requireForAutonomous is true.
  let spawnBin = inv.bin;
  let spawnArgs = inv.args;
  let sandboxMeta = { backend: 'none', skipped: true };
  try {
    const wrapped = sandbox.wrapCommand(cfg, {
      command: inv.bin,
      args: inv.args,
      cwd: outDir,
      rwPaths: [workspacePath, outDir, cfg.dataDir],
      env,
      mode: 'agent',
    });
    spawnBin = wrapped.bin;
    spawnArgs = wrapped.args;
    sandboxMeta = {
      backend: wrapped.backend,
      skipped: Boolean(wrapped.skipped),
      warning: wrapped.warning || null,
    };
    logStream.write(`sandbox: ${sandboxMeta.backend}${sandboxMeta.skipped ? ' (skipped)' : ''}\n`);
    if (sandboxMeta.warning) logStream.write(`sandbox warning: ${sandboxMeta.warning}\n`);
  } catch (err) {
    logStream.write(`\nSANDBOX ERROR: ${err.message}\n`);
    logStream.write('Hint: install bubblewrap (`apt install bubblewrap`) or set sandbox.enabled=false (unsafe).\n');
    logStream.end();
    const fake = {
      pid: null,
      stdout: { on() {} },
      stderr: { on() {} },
      on(ev, cb) {
        if (ev === 'close') setImmediate(() => cb(1));
      },
      kill() {},
    };
    store.updateTask(task.id, {
      execution: {
        resolvedAgentId: agentId,
        sandbox: { error: err.message, code: err.code || 'SANDBOX_ERROR' },
      },
    });
    return { child: fake, logStream, outDir, promptFile, sandboxError: err };
  }
  store.updateTask(task.id, {
    execution: { resolvedAgentId: agentId, sandbox: sandboxMeta },
  });

  const child = spawn(spawnBin, spawnArgs, {
    cwd: outDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  child.stdout.on('data', (d) => logStream.write(d));
  child.stderr.on('data', (d) => logStream.write(d));
  child.on('error', (err) => {
    logStream.write(`\nSPAWN ERROR: ${err.message}\n`);
    if (err.code === 'ENOENT') {
      logStream.write('Hint: bundled agent-run missing or sandbox backend not found. Reinstall omnishpilot / install bubblewrap.\n');
    }
  });

  return { child, logStream, outDir, promptFile, sandbox: sandboxMeta };
}

function listOutputArtifacts(outDir) {
  if (!outDir || !fs.existsSync(outDir)) return [];
  return fs.readdirSync(outDir)
    .map((name) => {
      const p = path.join(outDir, name);
      if (!fs.statSync(p).isFile()) return null;
      return { name, path: p };
    })
    .filter(Boolean);
}

module.exports = { runGenericAgent, agentPromptPath, listOutputArtifacts, resolveWorkspace };
