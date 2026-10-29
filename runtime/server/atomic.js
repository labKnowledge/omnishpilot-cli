'use strict';

// Temp file, fsync, rename: rename(2) is atomic on one filesystem, so a reader sees the whole old file or the whole new
// one, never half of each. The fsync is what keeps a power cut from leaving an empty file behind.

const fs = require('fs');
const { randomUUID } = require('crypto');

// Windows refuses a rename onto a file that a virus scanner or the indexer holds open for a moment (EPERM, EACCES,
// EBUSY); the same rename succeeds a few milliseconds later.
const RENAME_RETRY_MS = [5, 10, 20, 40, 80];
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from, to, rename = fs.renameSync) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      if (!RETRYABLE_RENAME.has(e.code) || attempt >= RENAME_RETRY_MS.length) throw e;
      sleepSync(RENAME_RETRY_MS[attempt]);
    }
  }
}

function writeFileAtomic(file, data, { mode } = {}) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    renameWithRetry(tmp, file);
  } catch (e) {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already failing */ }
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

/** `backup` keeps the previous good copy at `<file>.bak`, which readJsonSafe falls back to. */
function writeJsonAtomic(file, value, { backup = false } = {}) {
  if (backup && fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* a missing backup never blocks a save */ }
  }
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function parseFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Reads JSON without ever turning a damaged file into an empty one: a file that won't parse is moved aside to
 * `<file>.corrupt-<time>` and the last good `.bak` is used instead. Returning the fallback for a damaged file would let
 * the next write replace every job with nothing.
 */
function readJsonSafe(file, fallback) {
  const empty = () => (typeof fallback === 'function' ? fallback() : fallback);
  if (!fs.existsSync(file)) return empty();
  try {
    return parseFile(file);
  } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
      console.error(`[omnishpilot] ${file} could not be read (${e.message}); kept it as ${aside}`);
    } catch { /* another reader already moved it */ }
    try {
      const restored = parseFile(`${file}.bak`);
      writeJsonAtomic(file, restored);
      console.error(`[omnishpilot] restored ${file} from its last good copy`);
      return restored;
    } catch {
      return empty();
    }
  }
}

module.exports = { writeFileAtomic, writeJsonAtomic, readJsonSafe, renameWithRetry };
