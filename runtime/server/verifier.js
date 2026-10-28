'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const { resolveAgentRunSpawn } = require('./resolve-bin');
const agents = require('./agents');
const acceptance = require('./acceptance');

function buildVerifierPrompt({ task, outDir, workspacePath, acceptanceResult }) {
  const profile = acceptanceResult?.profile || acceptance.resolveAcceptance(task);
  const title = task.title || 'Task';
  const goal = task.inputs?.goal || task.summary || '';
  const criteria = profile.text || task.instructions?.acceptance || 'Deliverables exist and look complete.';
  const evidence = (acceptanceResult?.evidence || [])
    .map((e) => `- ${e.type}: ${e.name || e.command} → ${e.ok ? 'ok' : 'FAIL'}`)
    .join('\n');

  return `# Verifier (read-only judgment)

You are the checker in a maker/checker split. The implementer agent already ran.
Do NOT edit production code. Do NOT expand scope. Inspect the workspace and outputs, then decide.

## Task
${title}

## Goal
${goal}

## Acceptance criteria
${criteria}

## Mechanical gate evidence (already run)
${evidence || '(none)'}

## Paths
- Workspace: ${workspacePath}
- Output directory: ${outDir}

## Required output
Print exactly one of these lines as your final answer (nothing after it matters):
VERDICT: PASS
or
VERDICT: FAIL — <one-line reason>

Default to FAIL unless evidence is strong.
`;
}

function parseVerdict(text) {
  const pass = /VERDICT:\s*PASS\b/i.exec(text || '');
  if (pass) return { ok: true, verdict: 'PASS', detail: 'PASS' };
  const fail = /VERDICT:\s*FAIL\b\s*[—:-]?\s*(.*)/i.exec(text || '');
  if (fail) return { ok: false, verdict: 'FAIL', detail: (fail[1] || 'FAIL').trim().slice(0, 300) };
  return { ok: false, verdict: 'FAIL', detail: 'Verifier did not print VERDICT: PASS|FAIL' };
}

/**
 * Run a short second-agent verification pass. Best-effort; skips if no agent-run.
 */
function runVerifier({ task, outDir, workspacePath, logPath, cfg = loadConfig() }) {
  const profile = acceptance.resolveAcceptance(task, cfg);
  if (!profile.verifier) {
    return { skipped: true, ok: true, reason: 'verifier_disabled' };
  }

  const agentId = agents.pickAgent({
    requestedId: task.inputs?.verifierAgentId || cfg.acceptance?.verifierAgent || null,
    exclude: task.execution?.resolvedAgentId ? [task.execution.resolvedAgentId] : [],
  }) || agents.pickAgent({}) || 'auto';

  fs.mkdirSync(outDir, { recursive: true });
  const promptFile = path.join(outDir, 'verifier-prompt.md');
  const mech = acceptance.checkAcceptance({ task, outDir, workspacePath, cfg });
  fs.writeFileSync(promptFile, buildVerifierPrompt({
    task,
    outDir,
    workspacePath,
    acceptanceResult: mech,
  }));

  const args = [
    'run',
    '--agent', agentId,
    '--workspace', workspacePath || outDir,
    '--prompt-file', promptFile,
    '--out', outDir,
  ];
  if (cfg.agent?.cursorModel) args.push('--model', cfg.agent.cursorModel);

  const inv = resolveAgentRunSpawn(cfg, args);
  const timeoutMs = (cfg.acceptance?.verifierTimeoutSec || 600) * 1000;
  const r = spawnSync(inv.bin, inv.args, {
    cwd: outDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: process.env,
  });

  const combined = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (logPath) {
    try {
      fs.appendFileSync(logPath, `\n=== verifier ${new Date().toISOString()} agent=${agentId} ===\n${combined.slice(-8000)}\n`);
    } catch { /* ignore */ }
  }

  if (r.error || r.status == null) {
    return {
      ok: false,
      verdict: 'FAIL',
      detail: r.error?.message || 'Verifier process failed to start',
      agentId,
    };
  }

  const parsed = parseVerdict(combined);
  // Also look in result files the verifier may have written
  if (!parsed.ok) {
    for (const name of ['verifier-result.md', 'result.md', 'VERDICT.txt']) {
      const p = path.join(outDir, name);
      if (fs.existsSync(p)) {
        const again = parseVerdict(fs.readFileSync(p, 'utf8'));
        if (again.verdict === 'PASS' || again.detail !== parsed.detail) return { ...again, agentId };
      }
    }
  }
  return { ...parsed, agentId, exitCode: r.status };
}

module.exports = {
  runVerifier,
  parseVerdict,
  buildVerifierPrompt,
};
