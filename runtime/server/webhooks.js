'use strict';

const crypto = require('crypto');
const store = require('./store');
const { loadConfig } = require('./config');
const templates = require('./templates');
const ids = require('./connectors/ids');

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function extractToken(req) {
  const q = req.query?.token || req.query?.secret;
  if (q) return String(q);
  const h = req.get('x-omnishpilot-token') || req.get('x-webhook-token');
  if (h) return String(h);
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function tokenOk(req, cfg) {
  const expected = cfg.webhooks?.token || process.env.OMNISHPILOT_WEBHOOK_TOKEN || '';
  if (!expected) return { ok: false, error: 'webhooks_token_unset' };
  const got = extractToken(req);
  if (!got || !timingSafeEqual(got, expected)) return { ok: false, error: 'unauthorized' };
  return { ok: true };
}

function defaultWorkspaceId(cfg) {
  return cfg.webhooks?.defaultWorkspaceId
    || cfg.workspaces?.find((w) => w.enabled && w.connector === ids.GENERIC_AGENT)?.id
    || cfg.workspaces?.find((w) => w.enabled)?.id
    || 'generic';
}

function ensureGenericWorkspace(cfg) {
  // Tasks need a workspaceId; generic agent jobs often use a synthetic id.
  const id = defaultWorkspaceId(cfg);
  return id;
}

function summarizeGithub(payload) {
  const action = payload.action || '';
  const repo = payload.repository?.full_name || 'repo';
  const pr = payload.pull_request;
  const issue = payload.issue;
  if (pr) {
    return {
      title: `GitHub PR #${pr.number}: ${pr.title}`.slice(0, 80),
      goal: `Respond to GitHub pull request event (${action}) on ${repo}.\n\nPR: ${pr.html_url}\nBody:\n${(pr.body || '').slice(0, 2000)}`,
      ref: `github:pr:${repo}:${pr.number}:${action}`,
    };
  }
  if (issue) {
    return {
      title: `GitHub issue #${issue.number}: ${issue.title}`.slice(0, 80),
      goal: `Respond to GitHub issue event (${action}) on ${repo}.\n\nIssue: ${issue.html_url}\nBody:\n${(issue.body || '').slice(0, 2000)}`,
      ref: `github:issue:${repo}:${issue.number}:${action}`,
    };
  }
  const ref = payload.ref || '';
  const after = payload.after || '';
  if (payload.commits) {
    return {
      title: `GitHub push ${repo} ${ref}`.slice(0, 80),
      goal: `Respond to GitHub push on ${repo} (${ref}, ${after}).\nCommits:\n${(payload.commits || []).slice(0, 5).map((c) => `- ${c.message}`).join('\n')}`,
      ref: `github:push:${repo}:${after || ref}`,
    };
  }
  return {
    title: `GitHub event ${repo}`.slice(0, 80),
    goal: `Handle GitHub webhook on ${repo}:\n${JSON.stringify(payload).slice(0, 2500)}`,
    ref: `github:event:${repo}:${Date.now()}`,
  };
}

function summarizeLinear(payload) {
  const data = payload.data || payload;
  const action = payload.action || payload.type || 'update';
  const title = data.title || data.name || 'Linear item';
  const id = data.id || data.identifier || 'unknown';
  const url = data.url || '';
  const desc = data.description || '';
  return {
    title: `Linear ${action}: ${title}`.slice(0, 80),
    goal: `Respond to Linear ${action} for ${id}.\n${url}\n\n${String(desc).slice(0, 2000)}`,
    ref: `linear:${id}:${action}`,
  };
}

function summarizeGeneric(body) {
  const title = body.title || body.summary || 'Webhook job';
  const goal = body.goal || body.prompt || body.message || JSON.stringify(body).slice(0, 2500);
  return {
    title: String(title).slice(0, 80),
    goal: String(goal),
    ref: body.ref || `webhook:${Date.now()}`,
  };
}

function createWebhookJob({ source, summary, body, cfg }) {
  const templateId = body.templateId || cfg.webhooks?.defaultTemplateId || 'agent-task';
  const tpl = templates.getTemplate(templateId) || templates.getTemplate('agent-task');
  const workspaceId = body.workspaceId || ensureGenericWorkspace(cfg);
  const workspace = body.workspace || cfg.webhooks?.defaultWorkspace || cfg.agent?.defaultWorkspace || '';

  // Deduplicate recent identical source refs within 10 minutes
  const recent = store.listTasks().filter((t) => t.sourceRef === summary.ref && t.source === source);
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const dup = recent.find((t) => new Date(t.createdAt).getTime() > tenMinAgo);
  if (dup) {
    return { deduped: true, task: dup };
  }

  const acceptanceText = body.acceptance || cfg.webhooks?.defaultAcceptance || 'Write result.md summarizing what you did. Verify your work.';
  const task = store.createTask({
    workspaceId,
    templateId: tpl.id,
    title: summary.title,
    summary: summary.goal.slice(0, 200),
    status: 'scheduled',
    runMode: body.runMode || cfg.webhooks?.defaultRunMode || 'auto',
    schedule: { type: 'now', priority: body.priority || 90 },
    instructions: {
      agentPrompt: body.agentPrompt || '',
      acceptance: acceptanceText,
      deliverables: body.deliverables || 'Save outputs under the job output directory and write result.md.',
    },
    inputs: {
      title: summary.title,
      goal: summary.goal,
      workspace,
      agentId: body.agentId || 'auto',
    },
    acceptance: body.acceptanceProfile || {
      requiredArtifacts: body.requiredArtifacts || ['result.md'],
      testCommand: body.testCommand || null,
      verifier: body.verifier != null ? body.verifier : Boolean(cfg.webhooks?.verifier),
    },
    connector: tpl.connector,
    source,
    sourceRef: summary.ref,
    maxAttempts: body.maxAttempts || 3,
  });
  return { deduped: false, task };
}

function mountWebhooks(app) {
  const handler = (source) => (req, res) => {
    const cfg = loadConfig();
    if (cfg.webhooks?.enabled === false) {
      return res.status(503).json({ error: 'webhooks_disabled' });
    }
    const auth = tokenOk(req, cfg);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const body = req.body || {};
    let summary;
    if (source === 'github') summary = summarizeGithub(body);
    else if (source === 'linear') summary = summarizeLinear(body);
    else summary = summarizeGeneric(body);

    try {
      const result = createWebhookJob({ source: `webhook:${source}`, summary, body, cfg });
      return res.status(result.deduped ? 200 : 201).json({
        ok: true,
        deduped: result.deduped,
        taskId: result.task.id,
        title: result.task.title,
        status: result.task.status,
      });
    } catch (e) {
      console.error('[webhooks]', e.message);
      return res.status(500).json({ error: e.message });
    }
  };

  app.post('/hooks/github', handler('github'));
  app.post('/hooks/linear', handler('linear'));
  app.post('/hooks/generic', handler('generic'));
  app.post('/api/hooks/github', handler('github'));
  app.post('/api/hooks/linear', handler('linear'));
  app.post('/api/hooks/generic', handler('generic'));
}

module.exports = {
  mountWebhooks,
  summarizeGithub,
  summarizeLinear,
  createWebhookJob,
  tokenOk,
};
