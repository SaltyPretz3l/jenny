// Runner processes Jenny's own `ollama serve` left behind. A process is only
// ours when it is proven to descend from the owned root: it was a direct child
// in a listing taken before the root was stopped, or it is a direct child now.
// "Parent is dead" and "parent is pid 1" prove nothing about a foreign process.

function isValidPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

// Pids of the direct children of `ownedPid`. Call before the root is stopped,
// while the parent links are still intact.
function snapshotOwnedChildPids({ ownedPid, platform, logger, listProcesses }) {
  try {
    return listProcesses({ platform, logger })
      .filter((entry) => isValidPid(entry.pid) && entry.parentPid === ownedPid)
      .map((entry) => entry.pid);
  } catch (_error) {
    return [];
  }
}

// Kill the owned root's remaining children, best effort. Confirm the live
// command line on POSIX before signalling because a listed pid may have been
// reused. Older ollama_llama_server binaries are not listed here and are out
// of scope.
async function killOwnedChildRunners({
  ownedPid,
  preStopChildPids = [],
  platform,
  logger,
  listProcesses,
  killProcessTree,
  getProcessCommandLineSync,
}) {
  const log = typeof logger === 'function' ? logger : () => {};
  try {
    const snapshot = new Set(preStopChildPids);
    const entries = listProcesses({ platform, logger });
    for (const entry of entries) {
      const pid = entry.pid;
      if (!isValidPid(pid) || pid === ownedPid
        || !(snapshot.has(pid) || entry.parentPid === ownedPid)) continue;
      if (platform !== 'win32') {
        let commandLine;
        try {
          commandLine = getProcessCommandLineSync(pid, { platform });
        } catch (_error) {
          commandLine = '';
        }
        if (!/\brunner\b/.test(commandLine)) {
          log('DEBUG', 'ollama.orphan_runner_identity_unconfirmed', { pid, parentPid: ownedPid });
          continue;
        }
      }
      log('INFO', 'ollama.killing_orphaned_runner', { pid, parentPid: ownedPid });
      await killProcessTree(pid, { force: true }).catch(() => null);
    }
  } catch (_error) {
    // best effort only
  }
}

module.exports = { killOwnedChildRunners, snapshotOwnedChildPids };
