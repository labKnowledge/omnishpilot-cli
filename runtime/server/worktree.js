'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');

function git(cwd, args, timeout = 60000) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
  });
}

function isGitRepo(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const r = git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.status === 0 && String(r.stdout).trim() === 'true';
}

function repoRoot(dir) {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) return null;
  return String(r.stdout).trim();
}

function worktreeRoot(cfg = loadConfig()) {
  const custom = cfg.worktree?.root;
  if (custom) return path.resolve(custom);
  return path.join(cfg.dataDir, 'worktrees');
}

function branchName(taskId) {
  const short = String(taskId || 'job').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
  return `omnishpilot/${short}-${Date.now().toString(36)}`;
}

/**
 * Create an isolated git worktree for a run. No-ops when disabled or not a git repo.
 * @returns {{ path: string, worktree: boolean, branch?: string, basePath?: string, error?: string }}
 */
function prepareWorktree({ workspacePath, taskId, cfg = loadConfig() }) {
  const enabled = cfg.worktree?.enabled !== false;
  if (!enabled) {
    return { path: workspacePath, worktree: false, skipped: true, reason: 'disabled' };
  }
  if (!workspacePath || !fs.existsSync(workspacePath)) {
    return { path: workspacePath, worktree: false, skipped: true, reason: 'missing_workspace' };
  }
  if (!isGitRepo(workspacePath)) {
    return { path: workspacePath, worktree: false, skipped: true, reason: 'not_git' };
  }

  const root = repoRoot(workspacePath) || workspacePath;
  const base = worktreeRoot(cfg);
  fs.mkdirSync(base, { recursive: true });
  const dest = path.join(base, String(taskId));
  if (fs.existsSync(dest)) {
    // Reuse existing worktree directory if left from a crashed run.
    return { path: dest, worktree: true, branch: null, basePath: root, reused: true };
  }

  const branch = branchName(taskId);
  const baseRef = cfg.worktree?.baseRef || 'HEAD';
  const add = git(root, ['worktree', 'add', '-b', branch, dest, baseRef], 120000);
  if (add.status !== 0) {
    const err = (add.stderr || add.stdout || 'git worktree add failed').trim().slice(0, 400);
    return {
      path: workspacePath,
      worktree: false,
      skipped: true,
      reason: 'git_failed',
      error: err,
      basePath: root,
    };
  }
  return { path: dest, worktree: true, branch, basePath: root };
}

function cleanupWorktree(meta, { success, cfg = loadConfig() } = {}) {
  if (!meta?.worktree || !meta.path || !meta.basePath) return { skipped: true };
  const keep = success
    ? (cfg.worktree?.keepOnSuccess === true)
    : (cfg.worktree?.keepOnFailure !== false);
  if (keep) return { kept: true, path: meta.path };

  const remove = git(meta.basePath, ['worktree', 'remove', '--force', meta.path], 120000);
  if (meta.branch) {
    git(meta.basePath, ['branch', '-D', meta.branch], 30000);
  }
  return {
    removed: remove.status === 0,
    path: meta.path,
    error: remove.status === 0 ? null : String(remove.stderr || '').trim().slice(0, 200),
  };
}

function diffStat(meta) {
  if (!meta?.worktree || !meta.path) return null;
  const r = git(meta.path, ['diff', '--stat', 'HEAD'], 30000);
  if (r.status !== 0) return null;
  return String(r.stdout || '').trim().slice(0, 1500) || '(no unstaged diff)';
}

function diffNameOnly(meta) {
  if (!meta?.worktree || !meta.path) return [];
  const r = git(meta.path, ['diff', '--name-only', 'HEAD'], 30000);
  if (r.status !== 0) return [];
  return String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  isGitRepo,
  prepareWorktree,
  cleanupWorktree,
  diffStat,
  diffNameOnly,
  worktreeRoot,
};
