// OS-level process helpers. Not connector-specific — every connector spawns its child with
// `detached: true` so a Stop/kill from the board can terminate the whole process group
// (not just orphan whatever the direct child spawned), and that applies regardless of which
// connector started it.
function killProcessGroup(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

module.exports = { killProcessGroup };
