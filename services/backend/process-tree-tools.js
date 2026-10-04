'use strict';

const { execFile } = require('child_process');
const { isProcessAlive, killProcessTree } = require('./process-utils');
const { sanitizeSpawnEnv } = require('./sanitize-spawn-env');

async function enumerateDescendants(pid, {
  platform = process.platform, execFileImpl = execFile, timeoutMs = 5000, maxPids = 64,
} = {}) {
  const failed = { ok: false, pids: [] };
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(maxPids) || maxPids < 0) return failed;
  try {
    const windows = platform === 'win32';
    const output = await new Promise((resolve, reject) => {
      execFileImpl(windows ? 'powershell' : 'ps', windows ? [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
      ] : ['-eo', 'pid=,ppid='], {
        windowsHide: true, env: sanitizeSpawnEnv(process.env),
        timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
      }, (error, stdout) => error ? reject(error) : resolve(String(stdout || '')));
    });
    let rows;
    if (windows) {
      const parsed = JSON.parse(output);
      rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => [row.ProcessId, row.ParentProcessId]);
    } else {
      rows = output.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) throw new Error('invalid_process_row');
        return [Number(match[1]), Number(match[2])];
      });
    }
    const children = new Map();
    for (const [child, parent] of rows) {
      if (!Number.isSafeInteger(child) || child < 0 || !Number.isSafeInteger(parent) || parent < 0) return failed;
      // Windows lists the System Idle Process as pid 0; it parents nothing we can kill.
      if (child === 0) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(child);
    }
    const seen = new Set([pid]);
    const queue = [pid];
    const pids = [];
    for (let index = 0; index < queue.length; index += 1) {
      for (const child of children.get(queue[index]) || []) {
        if (seen.has(child)) continue;
        if (pids.length === maxPids) return { ok: false, pids };
        seen.add(child);
        pids.push(child);
        queue.push(child);
      }
    }
    return { ok: true, pids };
  } catch (_error) {
    return failed;
  }
}

async function confirmAllGone(pids, {
  isProcessAliveImpl = isProcessAlive, timeoutMs = 4000, pollMs = 100,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + Math.max(0, timeoutMs);
  let survivors = [...new Set(pids)];
  for (;;) {
    survivors = survivors.filter((pid) => {
      try { return isProcessAliveImpl(pid); } catch (_error) { return true; }
    });
    if (!survivors.length) return { confirmed: true, survivors: [] };
    const remaining = deadline - now();
    if (remaining <= 0) return { confirmed: false, survivors };
    await sleep(Math.min(Math.max(1, pollMs), remaining));
  }
}

async function killTreeWithProof(pid, {
  platform = process.platform, enumerateImpl = enumerateDescendants,
  killImpl = killProcessTree, confirmImpl = confirmAllGone, timeoutMs = 8000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let enumeration = { ok: false, pids: [] };
  try { enumeration = await enumerateImpl(pid, { platform, timeoutMs: Math.min(5000, timeoutMs) }); }
  catch (_error) { /* An unknown tree still needs a root kill. */ }
  const pids = [...new Set([pid, ...enumeration.pids])];
  const killOptions = { force: true, confirmExit: false, platform,
    timeoutMs: Math.max(1, deadline - Date.now()) };
  try { await killImpl(pid, killOptions); } catch (_error) { /* Proof below owns the verdict. */ }
  // The shared POSIX helper kills only the root without a detached process group.
  if (platform !== 'win32') {
    for (const child of enumeration.pids.slice().reverse()) {
      try { await killImpl(child, killOptions); } catch (_error) { /* Confirm every known pid below. */ }
    }
  }
  let proof = { confirmed: false, survivors: pids };
  try { proof = await confirmImpl(pids, { timeoutMs: Math.max(0, deadline - Date.now()) }); }
  catch (_error) { /* Unavailable proof is never clean. */ }
  return { confirmed: enumeration.ok === true && proof.confirmed === true,
    enumerated: enumeration.ok === true, pids, survivors: proof.survivors };
}

module.exports = { enumerateDescendants, confirmAllGone, killTreeWithProof };
