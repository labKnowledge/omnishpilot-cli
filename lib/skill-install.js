'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_NAME = 'omnishpilot';

function packageSkillRoot() {
  return path.join(__dirname, '..', 'skills', SKILL_NAME);
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function agentsSkillsDir() {
  return path.join(homeDir(), '.agents', 'skills');
}

function canonicalSkillDir() {
  return path.join(agentsSkillsDir(), SKILL_NAME);
}

/** Consumer tool dirs that should see the same skill via symlink. */
function mirrorLinkTargets() {
  const home = homeDir();
  return [
    path.join(home, '.cursor', 'skills', SKILL_NAME),
    path.join(home, '.claude', 'skills', SKILL_NAME),
    path.join(home, '.codex', 'skills', SKILL_NAME),
  ];
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === '.git' || name === 'node_modules') continue;
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function ensureSymlink(linkPath, targetPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    const existing = fs.lstatSync(linkPath);
    if (existing.isSymbolicLink()) {
      const cur = fs.readlinkSync(linkPath);
      const resolved = path.resolve(path.dirname(linkPath), cur);
      if (resolved === path.resolve(targetPath)) return { ok: true, existed: true };
      fs.unlinkSync(linkPath);
    } else {
      // Real directory/file from an older install — replace with symlink to canonical
      rmrf(linkPath);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // Relative symlink when both under $HOME keeps moves nicer; fall back to absolute.
  let linkValue = targetPath;
  try {
    linkValue = path.relative(path.dirname(linkPath), targetPath) || targetPath;
  } catch {
    linkValue = targetPath;
  }
  fs.symlinkSync(linkValue, linkPath);
  return { ok: true, existed: false };
}

/**
 * Install skill files into ~/.agents/skills/omnishpilot and mirror links.
 * @returns {{ canonical: string, links: string[], error?: string }}
 */
function installSkill(opts = {}) {
  const src = packageSkillRoot();
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    return { canonical: '', links: [], error: `skill source missing: ${src}` };
  }

  const dest = canonicalSkillDir();
  try {
    fs.mkdirSync(agentsSkillsDir(), { recursive: true });
    // Replace previous copy in place (idempotent upgrade on npm update -g)
    rmrf(dest);
    copyRecursive(src, dest);

    const links = [];
    for (const linkPath of mirrorLinkTargets()) {
      try {
        ensureSymlink(linkPath, dest);
        links.push(linkPath);
      } catch (err) {
        // Mirror failure is non-fatal (e.g. no permission for one tool dir)
        if (!opts.quiet) {
          console.error(`[omnishpilot] could not link ${linkPath}: ${err.message}`);
        }
      }
    }
    return { canonical: dest, links };
  } catch (err) {
    return { canonical: '', links: [], error: err.message || String(err) };
  }
}

function skillStatus() {
  const canonical = canonicalSkillDir();
  const skillMd = path.join(canonical, 'SKILL.md');
  const installed = fs.existsSync(skillMd);
  const links = mirrorLinkTargets().map((p) => {
    let kind = 'missing';
    let pointsTo = null;
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        kind = 'symlink';
        pointsTo = path.resolve(path.dirname(p), fs.readlinkSync(p));
      } else if (st.isDirectory()) {
        kind = 'directory';
      } else {
        kind = 'other';
      }
    } catch {
      kind = 'missing';
    }
    return { path: p, kind, pointsTo };
  });
  return {
    name: SKILL_NAME,
    installed,
    canonical,
    source: packageSkillRoot(),
    skillMd: installed ? skillMd : null,
    links,
  };
}

function uninstallSkill() {
  const removed = [];
  try {
    for (const linkPath of mirrorLinkTargets()) {
      try {
        if (fs.lstatSync(linkPath)) {
          rmrf(linkPath);
          removed.push(linkPath);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    const canonical = canonicalSkillDir();
    if (fs.existsSync(canonical)) {
      rmrf(canonical);
      removed.push(canonical);
    }
    return { removed };
  } catch (err) {
    return { removed, error: err.message || String(err) };
  }
}

module.exports = {
  SKILL_NAME,
  packageSkillRoot,
  canonicalSkillDir,
  installSkill,
  skillStatus,
  uninstallSkill,
};
