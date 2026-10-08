// Runner processes Jenny's own `ollama serve` left behind. A process is only
// ours when it is proven to descend from the owned root: it was a direct child
// in a listing taken before the root was stopped, or it is a direct child now.
// "Parent is dead" and "parent is pid 1" prove nothing about a foreign process.
const { execFileSync } = require('child_process');

// Ollama's runner images on Windows: `ollama.exe runner`, the older
// ollama_llama_server.exe, and the bundled lib\ollama\llama-server.exe. Jenny's
// managed llama-server is the same image name elsewhere, so the path pins it.
const WINDOWS_RUNNER_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  "$procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'ollama.exe' OR Name = 'ollama_llama_server.exe' OR Name = 'llama-server.exe'\" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath)",
  "if ($procs.Count -eq 0) { '[]' } else { $procs | ConvertTo-Json -Compress }",
].join('; ');

function isWindowsOllamaRunner(entry) {
  const name = entry.name.toLowerCase();
  if (name === 'ollama.exe' || name === 'ollama_llama_server.exe') return true;
  return name === 'llama-server.exe' && /[\\/]lib[\\/]ollama[\\/]llama-server\.exe$/i.test(entry.executablePath);
}

function listWindowsOllamaRunnersSync({ execFileSyncImpl = execFileSync, logger } = {}) {
  try {
    const raw = execFileSyncImpl('powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_RUNNER_QUERY], {
      encoding: 'utf-8', timeout: 5000, windowsHide: true,
    });
    const parsed = JSON.parse(String(raw || '[]').trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map((record) => ({
      pid: Number(record?.ProcessId),
      parentPid: Number(record?.ParentProcessId) || 0,
      name: String(record?.Name || ''),
      executablePath: String(record?.ExecutablePath || ''),
    })).filter((entry) => isValidPid(entry.pid) && isWindowsOllamaRunner(entry));
  } catch (error) {
    if (typeof logger === 'function') logger('DEBUG', 'ollama.runner_discovery_failed', { message: String(error?.message || error) });
    return [];
  }
}

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
// reused. On Windows the listing itself pins the runner identity
// (listWindowsOllamaRunnersSync).
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

module.exports = { killOwnedChildRunners, listWindowsOllamaRunnersSync, snapshotOwnedChildPids };
