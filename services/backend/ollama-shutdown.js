const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { isProcessAlive } = require('./process-utils');

const OLLAMA_STATE_FILENAME = 'ollama-process.json';
const OLLAMA_WINDOWS_IMAGE_NAMES = Object.freeze([
  'ollama.exe',
  'ollama_llama_server.exe',
  'ollama app.exe',
]);

function normalizeLogger(logger) {
  return typeof logger === 'function' ? logger : () => {};
}

function getOwnedStatePath(userDataPath) {
  if (!userDataPath) {
    return '';
  }
  return path.join(userDataPath, OLLAMA_STATE_FILENAME);
}

// True only when THIS install left an owned-state record on disk. The
// machine-wide force-kill sweep below is destructive to other tools' Ollama
// daemons, so it must never run on a host where Jenny never owned one. Mirrors
// OllamaProcessManager.mightHaveLocalOllamaResidue() for the module-level
// (emergency / process-exit) path, which has no manager instance to consult.
function hasOwnedOllamaState(userDataPath, { fsImpl = fs } = {}) {
  const statePath = getOwnedStatePath(userDataPath);
  if (!statePath) {
    return false;
  }
  try {
    return fsImpl.existsSync(statePath);
  } catch (_error) {
    return false;
  }
}

// Best-effort read of the owned-state record. Returns null when absent or
// unreadable; callers treat that as "no owned pid known".
function readOwnedOllamaState(userDataPath, { fsImpl = fs } = {}) {
  const statePath = getOwnedStatePath(userDataPath);
  if (!statePath) {
    return null;
  }
  try {
    const parsed = JSON.parse(String(fsImpl.readFileSync(statePath, 'utf8') || ''));
    const pid = Number(parsed && parsed.pid);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
      command: String((parsed && parsed.command) || '').trim(),
    };
  } catch (_error) {
    return null;
  }
}

function clearOwnedOllamaState(userDataPath) {
  const statePath = getOwnedStatePath(userDataPath);
  if (!statePath) {
    return;
  }
  try {
    fs.unlinkSync(statePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function normalizeProcessRecord(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const pid = Number(record.ProcessId ?? record.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const parentPid = Number(record.ParentProcessId ?? record.parentPid) || 0;
  return {
    pid,
    parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0,
    name: String(record.Name ?? record.name ?? '').trim(),
    executablePath: String(record.ExecutablePath ?? record.executablePath ?? '').trim(),
    commandLine: String(record.CommandLine ?? record.commandLine ?? '').trim(),
  };
}

function normalizeWindowsProcessName(value) {
  return String(value || '').trim().toLowerCase();
}

function isKnownWindowsOllamaName(name) {
  const normalized = normalizeWindowsProcessName(name);
  if (!normalized) {
    return false;
  }
  if (OLLAMA_WINDOWS_IMAGE_NAMES.includes(normalized)) {
    return true;
  }
  return normalized.startsWith('ollama app') && normalized.endsWith('.exe');
}

function isOllamaWindowsProcessRecord(record) {
  if (!record || typeof record !== 'object') {
    return false;
  }
  if (isKnownWindowsOllamaName(record.Name ?? record.name)) {
    return true;
  }
  const executableName = path.win32.basename(
    String(record.ExecutablePath ?? record.executablePath ?? '').trim()
  );
  return isKnownWindowsOllamaName(executableName);
}

// Shared between the sync lister below and the async tray-check lister in
// ollama-tray-conflict.js, so the two can never drift on the query or parsing.
const WINDOWS_OLLAMA_PROCESS_QUERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'ollama.exe' OR Name = 'ollama_llama_server.exe' OR Name = 'ollama app.exe' OR Name LIKE 'Ollama App%.exe'\" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine)",
  "if ($procs.Count -eq 0) { '[]' } else { $procs | ConvertTo-Json -Compress }",
].join('; ');

function parseWindowsProcessQueryOutput(raw) {
  const parsed = JSON.parse(String(raw || '[]').trim() || '[]');
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items
    .filter(isOllamaWindowsProcessRecord)
    .map(normalizeProcessRecord)
    .filter(Boolean);
}

function listWindowsProcessesViaPowerShell(execFileSyncImpl) {
  const raw = execFileSyncImpl(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_OLLAMA_PROCESS_QUERY_SCRIPT],
    {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    },
  );
  return parseWindowsProcessQueryOutput(raw);
}

function listWindowsProcessesViaWmic(execFileSyncImpl) {
  const csv = execFileSyncImpl(
    'wmic',
    ['process', 'get', 'Node,Name,ParentProcessId,ProcessId', '/format:csv'],
    {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    },
  );
  const records = [];
  for (const line of String(csv || '').split(/\r?\n/)) {
    const parts = line.trim().split(',');
    if (parts.length < 4) {
      continue;
    }
    const name = String(parts[1] || '').trim();
    const parentPid = Number(parts[2]);
    const pid = Number(parts[3]);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const candidate = {
      ProcessId: pid,
      ParentProcessId: parentPid,
      Name: name,
    };
    if (isOllamaWindowsProcessRecord(candidate)) {
      records.push(normalizeProcessRecord(candidate));
    }
  }
  return records.filter(Boolean);
}

function listUnixProcesses(execFileSyncImpl) {
  const pidOutput = execFileSyncImpl('pgrep', ['-x', 'ollama'], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  const pids = String(pidOutput || '')
    .split(/\r?\n/)
    .map((value) => Number(value.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  if (!pids.length) {
    return [];
  }
  const psOutput = execFileSyncImpl(
    'ps',
    ['-o', 'pid=,ppid=,comm=', '-p', pids.join(',')],
    {
      encoding: 'utf-8',
      timeout: 5000,
    },
  );
  const records = [];
  for (const line of String(psOutput || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    records.push(normalizeProcessRecord({
      ProcessId: Number(match[1]),
      ParentProcessId: Number(match[2]),
      Name: String(match[3] || '').trim(),
    }));
  }
  return records.filter(Boolean);
}

function listLocalOllamaProcessesSync({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  logger,
} = {}) {
  const log = normalizeLogger(logger);
  const seen = new Set();
  const records = [];

  const appendRecords = (items) => {
    for (const item of items) {
      if (!item || seen.has(item.pid)) {
        continue;
      }
      seen.add(item.pid);
      records.push(item);
    }
  };

  try {
    if (platform === 'win32') {
      try {
        appendRecords(listWindowsProcessesViaPowerShell(execFileSyncImpl));
      } catch (_error) {
        appendRecords(listWindowsProcessesViaWmic(execFileSyncImpl));
      }
    } else {
      appendRecords(listUnixProcesses(execFileSyncImpl));
    }
  } catch (error) {
    log('DEBUG', 'ollama.process_discovery_failed', {
      message: String(error && error.message || error),
    });
  }

  return records;
}

function forceKillByPidSync(pid, { platform, spawnSyncImpl }) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: 0 };
  }
  if (platform === 'win32') {
    return spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000,
    });
  }
  return spawnSyncImpl('kill', ['-KILL', String(pid)], {
    stdio: 'ignore',
    timeout: 5000,
  });
}

function forceKillAllByNameSync({ platform, spawnSyncImpl, logger }) {
  const log = normalizeLogger(logger);
  const targets = platform === 'win32'
    ? OLLAMA_WINDOWS_IMAGE_NAMES
    : ['ollama'];
  for (const image of targets) {
    try {
      if (platform === 'win32') {
        const result = spawnSyncImpl('taskkill', ['/IM', image, '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5000,
        });
        if (typeof result.status === 'number' && result.status === 0) {
          log('INFO', 'ollama.force_kill_by_name', { image });
        }
      } else {
        const result = spawnSyncImpl('pkill', ['-x', image.replace(/\.exe$/, '')], {
          stdio: 'ignore',
          timeout: 5000,
        });
        if (typeof result.status === 'number' && result.status === 0) {
          log('INFO', 'ollama.force_kill_by_name', { image });
        }
      }
    } catch (_error) {
      // best effort only
    }
  }
}

function syncSleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function shutdownWslSync({ platform = process.platform, spawnSyncImpl = spawnSync, logger } = {}) {
  const log = normalizeLogger(logger);
  if (platform !== 'win32') {
    return;
  }
  try {
    spawnSyncImpl('wsl', ['--shutdown'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15000,
    });
    log('INFO', 'ollama.wsl_shutdown');
  } catch (_error) {
    // best effort only
  }
}

function isVmmemWslAliveSync({ spawnSyncImpl = spawnSync } = {}) {
  try {
    const result = spawnSyncImpl('tasklist', [], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000,
    });
    return /vmmem/i.test(String(result.stdout || ''));
  } catch (_error) {
    return false;
  }
}

function normalizeOwnedPidSet(ownedPids) {
  const source = Array.isArray(ownedPids)
    ? ownedPids
    : (ownedPids && typeof ownedPids[Symbol.iterator] === 'function' ? [...ownedPids] : []);
  return new Set(
    source
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  );
}

function forceKillAnyRemainingLocalOllamaSync({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  spawnSyncImpl = spawnSync,
  logger,
  isProcessAliveImpl = isProcessAlive,
  ownedPids = null,
} = {}) {
  const log = normalizeLogger(logger);
  const ownedPidSet = normalizeOwnedPidSet(ownedPids);
  const processes = listLocalOllamaProcessesSync({
    platform,
    execFileSyncImpl,
    logger: log,
  });
  let targetProcesses = processes;
  if (ownedPidSet.size > 0) {
    const ownedTreePids = new Set(ownedPidSet);
    let addedDescendant = true;
    while (addedDescendant) {
      addedDescendant = false;
      for (const processInfo of processes) {
        if (!ownedTreePids.has(processInfo.pid) && ownedTreePids.has(processInfo.parentPid)) {
          ownedTreePids.add(processInfo.pid);
          addedDescendant = true;
        }
      }
    }
    targetProcesses = processes.filter((processInfo) => ownedTreePids.has(processInfo.pid));
  }
  const killedPids = [];

  for (const processInfo of targetProcesses) {
    if (!isProcessAliveImpl(processInfo.pid)) {
      continue;
    }
    log('INFO', 'ollama.force_kill', {
      pid: processInfo.pid,
      parentPid: processInfo.parentPid,
    });
    try {
      const result = forceKillByPidSync(processInfo.pid, {
        platform,
        spawnSyncImpl,
      });
      if (result && result.error) {
        throw result.error;
      }
      if (typeof result?.status === 'number' && result.status !== 0) {
        log('WARN', 'ollama.force_kill_failed', {
          pid: processInfo.pid,
          parentPid: processInfo.parentPid,
          status: result.status,
          stderr: String(result.stderr || '').trim(),
        });
        continue;
      }
      killedPids.push(processInfo.pid);
    } catch (error) {
      log('WARN', 'ollama.force_kill_failed', {
        pid: processInfo.pid,
        parentPid: processInfo.parentPid,
        message: String(error && error.message || error),
      });
    }
  }

  // F2: the by-name sweep is a blanket `taskkill /IM ollama.exe /T /F` across
  // EVERY ollama image on the machine — it cannot tell our daemon from another
  // tool's. Once the caller knows which pids are ours, the scoped per-pid loop
  // above covers only those roots and their verified descendant chains, so the
  // blanket pass is skipped.
  if (ownedPidSet.size > 0) {
    log('INFO', 'ollama.force_kill_by_name_skipped', {
      reason: 'owned_pids_known',
      ownedPids: [...ownedPidSet],
    });
  } else {
    forceKillAllByNameSync({
      platform,
      spawnSyncImpl,
      logger: log,
    });
  }

  return {
    discoveredPids: targetProcesses.map((entry) => entry.pid),
    killedPids,
  };
}

function forceKillAnyRemainingLocalOllamaVerifiedSync({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  spawnSyncImpl = spawnSync,
  logger,
  isProcessAliveImpl = isProcessAlive,
  ownedPids = null,
  maxRetries = 3,
  retryDelayMs = 500,
} = {}) {
  const log = normalizeLogger(logger);
  let lastResult = { discoveredPids: [], killedPids: [] };
  let verifiedAllKilled = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = forceKillAnyRemainingLocalOllamaSync({
      platform, execFileSyncImpl, spawnSyncImpl, logger, isProcessAliveImpl, ownedPids,
    });

    if (lastResult.discoveredPids.length === 0 && attempt > 0) {
      verifiedAllKilled = true;
      log('INFO', 'ollama.verified_all_killed', { attempts: attempt + 1 });
      break;
    }

    if (lastResult.discoveredPids.length === 0 && attempt === 0) {
      verifiedAllKilled = true;
      break;
    }

    const survivingPids = lastResult.discoveredPids.filter(
      (pid) => isProcessAliveImpl(pid),
    );

    if (attempt < maxRetries) {
      if (survivingPids.length > 0) {
        log('WARN', 'ollama.processes_survived_kill', {
          survivingPids,
          attempt: attempt + 1,
          maxRetries,
        });
      }
      syncSleepMs(retryDelayMs);
    }
  }

  return { ...lastResult, verifiedAllKilled };
}

function shutdownWslVerifiedSync({
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  logger,
  wslTimeoutMs = 15000,
  maxRetries = 2,
  retryDelayMs = 1000,
  isVmmemWslAliveSyncImpl,
} = {}) {
  const log = normalizeLogger(logger);
  if (platform !== 'win32') {
    return;
  }
  const checkVmmem = typeof isVmmemWslAliveSyncImpl === 'function'
    ? isVmmemWslAliveSyncImpl
    : (options) => isVmmemWslAliveSync(options);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      spawnSyncImpl('wsl', ['--shutdown'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: wslTimeoutMs,
      });
      log('INFO', 'ollama.wsl_shutdown', { attempt: attempt + 1 });
    } catch (_error) {
      log('WARN', 'ollama.wsl_shutdown_timeout', { attempt: attempt + 1 });
    }

    syncSleepMs(retryDelayMs);
    if (!checkVmmem({ spawnSyncImpl })) {
      log('INFO', 'ollama.vmmemwsl_verified_dead', { attempts: attempt + 1 });
      return;
    }

    if (attempt < maxRetries) {
      log('WARN', 'ollama.vmmemwsl_survived_shutdown', { attempt: attempt + 1 });
    }
  }

  try {
    spawnSyncImpl('taskkill', ['/IM', 'vmmemwsl', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000,
    });
    log('INFO', 'ollama.vmmemwsl_force_killed');
  } catch (_error) {
    // best effort only
  }
}

function shutdownAnyLocalOllamaSync({
  userDataPath,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  spawnSyncImpl = spawnSync,
  logger,
  isProcessAliveImpl = isProcessAlive,
  fsImpl = fs,
} = {}) {
  const log = normalizeLogger(logger);
  // F2/F2a residue gate: an ordinary quit must not force-kill every ollama.exe
  // on the machine. Only run the sweep when this install actually left an
  // owned-state record behind.
  if (!hasOwnedOllamaState(userDataPath, { fsImpl })) {
    log('INFO', 'ollama.any_local_sweep_skipped', {
      reason: 'no_owned_state',
      userDataPathConfigured: Boolean(userDataPath),
    });
    return { discoveredPids: [], killedPids: [], skipped: 'no_owned_state' };
  }
  const ownedState = readOwnedOllamaState(userDataPath, { fsImpl });
  let result;
  if (ownedState === null) {
    // Unreadable/malformed record: fail closed. Only a VALID record with no
    // usable pid (pid 0) may widen the quit path to the by-name sweep; garbage
    // on disk must not authorize killing every local ollama.
    log('WARN', 'ollama.owned_state_malformed', { reason: 'unreadable_or_malformed' });
    result = { discoveredPids: [], killedPids: [], skipped: 'malformed_owned_state' };
  } else {
    const ownedPid = ownedState.pid || 0;
    // `ollama stop <model>` is deliberately not on this path because it unloads
    // every model the daemon has resident, including one another tool put in VRAM.
    // F2b: `wsl --shutdown` is likewise gone from quit — it terminates every
    // WSL2 distribution and the shared VM (Docker Desktop, dev containers).
    result = forceKillAnyRemainingLocalOllamaVerifiedSync({
      platform,
      execFileSyncImpl,
      spawnSyncImpl,
      logger,
      isProcessAliveImpl,
      ownedPids: ownedPid ? [ownedPid] : null,
    });
    if (ownedPid && !result.verifiedAllKilled) {
      log('WARN', 'ollama.state_retained', {
        pid: ownedPid,
        reason: 'owned_pid_not_verified_dead',
      });
      return result;
    }
  }

  try {
    clearOwnedOllamaState(userDataPath);
  } catch (error) {
    log('WARN', 'ollama.state_clear_failed', {
      message: String(error && error.message || error),
    });
  }
  return result;
}

module.exports = {
  OLLAMA_STATE_FILENAME,
  WINDOWS_OLLAMA_PROCESS_QUERY_SCRIPT,
  clearOwnedOllamaState,
  parseWindowsProcessQueryOutput,
  forceKillAnyRemainingLocalOllamaSync,
  forceKillByPidSync,
  forceKillAnyRemainingLocalOllamaVerifiedSync,
  getOwnedStatePath,
  hasOwnedOllamaState,
  isVmmemWslAliveSync,
  listLocalOllamaProcessesSync,
  readOwnedOllamaState,
  shutdownAnyLocalOllamaSync,
  // F2b: shutdownWslSync / shutdownWslVerifiedSync stay exported for an
  // explicit, user-triggered "reset local engine" remediation. They are NO
  // LONGER reachable from the quit path — `wsl --shutdown` kills every WSL2
  // distribution and the shared VM, which an ordinary app quit must not do.
  shutdownWslSync,
  shutdownWslVerifiedSync,
  syncSleepMs,
};
