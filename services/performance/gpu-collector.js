'use strict';
const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { systemPowerShellPath } = require('../artifact-open-with');
const { sanitizeSpawnEnv } = require('../backend/sanitize-spawn-env');
const CAP = 256 * 1024;
const bytes = value => value == null ? null : Number.isSafeInteger(value) && value >= 0 ? value : NaN;
const creation = value => {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return value.replace(/^0+(?=\d)/, '');
  // Match process-utils' CIM CreationDate UTC .NET ticks (not FILETIME ticks).
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return String(BigInt(Date.parse(value)) * 10000n + 621355968000000000n);
  return null;
};
// CIM CreationDate (main's identity) has microsecond precision; GetProcessTimes has 100 ns.
const sameCreation = (a, b) => {
  const x = creation(a); const y = creation(b);
  if (x === null || y === null) return false;
  const delta = BigInt(x) - BigInt(y);
  return delta >= -10n && delta <= 10n;
};
function pci(value) {
  const m = /^([0-9a-f]{4,8}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])$/i.exec(value || '');
  return m ? `${parseInt(m[1], 16)}:${parseInt(m[2], 16)}:${parseInt(m[3], 16)}:${m[4]}` : null;
}
function devicesFromCsv(output) {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('invalid_framebuffer');
  const devices = lines.slice(0, 16).map(line => {
    const [gpu_uuid, pci_bus_id, ...memory] = line.split(',').map(x => x.trim());
    const values = memory.map(x => /^(?:\d+)(?:\.\d+)?$/.test(x) ? bytes(Number(x) * 1024 ** 2) : /^(?:N\/A|\[N\/A\])$/.test(x) ? null : NaN);
    const [total, used, free] = values;
    if (!/^GPU-[a-z0-9-]+$/i.test(gpu_uuid) || !pci(pci_bus_id) || values.length !== 3 || values.some(Number.isNaN)
      || (total !== null && (total === 0 || (used !== null && used > total) || (free !== null && free > total)
        || (used !== null && free !== null && used + free > total)))) throw new Error('invalid_framebuffer');
    return { gpu_uuid, pci_bus_id, dedicated_total_bytes: total, dedicated_used_bytes: used, dedicated_free_bytes: free };
  });
  devices.truncated = lines.length > 16;
  return devices;
}
function processRow(row) {
  if (!Number.isSafeInteger(row.pid) || row.pid <= 0) throw new Error('invalid_process');
  const dedicated_bytes = bytes(row.dedicated_bytes); const shared_bytes = bytes(row.shared_bytes);
  if ([dedicated_bytes, shared_bytes].some(Number.isNaN)) throw new Error('invalid_process_bytes');
  return { pid: row.pid, created_at: creation(row.created_at),
    basename: typeof row.basename === 'string' ? [...path.win32.basename(row.basename)].filter(c => c.charCodeAt(0) >= 32).join('').slice(0, 260) : null,
    dedicated_bytes, shared_bytes };
}
function project(raw, devices, identity) {
  if (raw?.ok !== true || !Array.isArray(raw.adapters) || !Array.isArray(raw.processes)) throw new Error('helper_unavailable');
  const truncated = raw.truncated === true || devices.truncated === true || raw.adapters.length > 16 || raw.processes.length > 256 || raw.scanned_instances > 4096;
  const adapters = raw.adapters.slice(0, 16); const rows = raw.processes.slice(0, 256);
  const samePid = rows.filter(row => row.pid === identity?.pid);
  const matches = samePid.filter(row => sameCreation(row.created_at, identity?.createdAt));
  // Unknown creation times cannot prove attribution.
  if (!matches.length || samePid.some(row => creation(row.created_at) === null)) throw new Error('ambiguous_identity');
  const mapAdapter = row => {
    const found = adapters.filter(a => a.luid === row.luid && a.physical_index === row.physical_index);
    const candidate = found.length === 1 ? found[0] : null;
    if (!candidate || !pci(candidate.pci_bus_id) || !/^[a-z0-9_x-]{1,80}$/i.test(candidate.luid)
      || !Number.isSafeInteger(candidate.physical_index) || candidate.physical_index < 0) return null;
    const device = devices.filter(d => pci(d.pci_bus_id) === pci(candidate.pci_bus_id));
    return device.length === 1 ? { row, adapter: candidate, device: device[0] } : null;
  };
  // A process has one counter row per adapter it touches; only a row on exactly one NVIDIA device attributes it.
  const mappedRows = matches.map(mapAdapter).filter(Boolean);
  if (mappedRows.length !== 1) throw new Error(mappedRows.length ? 'ambiguous_identity' : 'adapter_mapping_unavailable');
  const { row: managed, adapter } = mappedRows[0];
  const deviceMatches = [mappedRows[0].device];
  const shared_used_bytes = bytes(adapter.shared_used_bytes);
  if (Number.isNaN(shared_used_bytes)) throw new Error('invalid_adapter_bytes');
  const external = rows.filter(row => row !== managed && row.luid === adapter.luid && row.physical_index === adapter.physical_index).map(processRow)
    .sort((a, b) => (b.dedicated_bytes ?? -1) - (a.dedicated_bytes ?? -1));
  // An external row without a creation time stays visible; it only cannot join a contention streak.
  const partial = truncated || raw.partial === true || shared_used_bytes === null
    || Object.entries(deviceMatches[0]).some(([key, value]) => key.endsWith('_bytes') && value === null)
    || managed.shared_bytes == null || managed.dedicated_bytes == null;
  return { state: partial ? 'partial' : 'fresh', reason: truncated ? 'coverage_truncated' : partial ? 'coverage_partial' : null,
    adapter: { ...deviceMatches[0], luid: adapter.luid, physical_index: adapter.physical_index, shared_used_bytes },
    managed_process: processRow(managed), external_processes: external.slice(0, 8),
    other_process_count: Math.max(0, external.length - 8), truncated: truncated || external.length > 8 };
}

const TERMINAL_STARTUP_FAILURES = new Set(['unsupported_language_mode', 'pdh_unavailable', 'helper_missing']);
const HELPER_REASONS = new Set(['unsupported_language_mode', 'pdh_unavailable', 'helper_unavailable']);
function createGpuCollector({ platform = process.platform, spawn = childProcess.spawn, execFile = childProcess.execFile,
  helperPath = path.join(__dirname, 'gpu-memory-win32.ps1'), now = Date.now } = {}) {
  const helper = helperPath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  let child = null; let ready = null; let readyResolve; let pending; let timer; let flight; let disposed = false; let sequence = 0;
  let buffer = Buffer.alloc(0); let failure = 'helper_unavailable';
  // A helper that cannot start is not respawned every sample: environment failures latch for the process
  // lifetime, other startup failures back off 30 s doubling to 10 min (reset by a successful start).
  let retryAt = 0; let backoffMs = 0;
  const unavailable = reason => ({ schema_version: 1, sequence: ++sequence, sampled_at: now(), cadence_ms: null,
    state: 'unavailable', reason, adapter: null, managed_process: null, external_processes: [], other_process_count: 0, truncated: false });
  function stop(reason) {
    if (readyResolve && reason !== 'disposed' && reason !== 'released') {
      if (TERMINAL_STARTUP_FAILURES.has(reason)) retryAt = Infinity;
      else { backoffMs = Math.min(Math.max(30000, backoffMs * 2), 600000); retryAt = now() + backoffMs; }
    }
    failure = reason; clearTimeout(timer); const owned = child; child = null; ready = null;
    readyResolve?.(false); readyResolve = null; pending?.(null); pending = null;
    process.removeListener('exit', dispose);
    try { owned?.kill(); } catch (_error) { /* Only our helper is owned. */ }
  }
  function onLine(line) {
    let result; try { result = JSON.parse(line); } catch (_error) { stop('invalid_helper_response'); return; }
    if (!result || typeof result !== 'object' || Array.isArray(result)) { stop('invalid_helper_response'); return; }
    if (readyResolve && result.ok === false) { stop(HELPER_REASONS.has(result.reason) ? result.reason : 'helper_unavailable'); return; }
    if (result.event === 'ready' && readyResolve) { clearTimeout(timer); backoffMs = 0; readyResolve(true); readyResolve = null; }
    else if (pending) { const resolve = pending; pending = null; resolve(result); }
    else stop('invalid_helper_response');
  }
  function ensureReady() {
    if (ready) return ready;
    if (now() < retryAt) return Promise.resolve(false);
    if (!fs.existsSync(helper)) { failure = 'helper_missing'; return Promise.resolve(false); }
    ready = new Promise(resolve => { readyResolve = resolve; }); const startup = ready;
    try {
      child = spawn(systemPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper],
        { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: sanitizeSpawnEnv(process.env) });
      const owned = child; buffer = Buffer.alloc(0);
      timer = setTimeout(() => stop('helper_startup_timeout'), 5000);
      child.stdout.on('data', chunk => {
        if (child !== owned) return;
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        let end;
        while ((end = buffer.indexOf(10)) >= 0) {
          if (end > CAP) { stop('helper_line_limit'); return; }
          const line = buffer.subarray(0, end).toString('utf8'); buffer = buffer.subarray(end + 1);
          onLine(line); if (child !== owned) return;
        }
        if (buffer.length > CAP) stop('helper_line_limit');
      });
      child.stderr.on('data', () => {});
      for (const event of ['error', 'close']) child.on(event, () => { if (child === owned) stop('helper_unavailable'); });
      child.stdin.on('error', () => { if (child === owned) stop('helper_unavailable'); });
      process.once('exit', dispose);
    } catch (_error) { stop('helper_spawn_failed'); }
    return startup;
  }
  function framebuffer() {
    return new Promise((resolve, reject) => {
      try {
        execFile('nvidia-smi', ['--query-gpu=uuid,pci.bus_id,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'],
          { windowsHide: true, shell: false, timeout: 1000, maxBuffer: CAP, env: sanitizeSpawnEnv(process.env) }, (error, stdout) => {
            if (error) { reject(new Error('framebuffer_unavailable')); return; }
            try { resolve(devicesFromCsv(stdout)); } catch (e) { reject(e); }
          });
      } catch (_error) { reject(new Error('framebuffer_unavailable')); }
    });
  }
  async function collect(identity) {
    if (disposed) return unavailable('disposed');
    if (platform !== 'win32') {
      try {
        const devices = await framebuffer();
        return { ...unavailable('process_classification_unavailable'), adapter: devices.length === 1
          ? { ...devices[0], luid: null, physical_index: null, shared_used_bytes: null } : null };
      } catch (_error) { return unavailable('framebuffer_unavailable'); }
    }
    if (!await ensureReady()) return unavailable(failure);
    let timeout;
    const deadline = new Promise(resolve => { timeout = setTimeout(() => { stop('sample_timeout'); resolve(unavailable('sample_timeout')); }, 1500); });
    const work = (async () => {
      try {
        const response = new Promise(resolve => { pending = resolve; });
        child.stdin.write(JSON.stringify({ pid: identity?.pid ?? null, createdAt: creation(identity?.createdAt) }) + '\n');
        const [raw, devices] = await Promise.all([response, framebuffer()]);
        if (!raw) return unavailable(failure);
        return { schema_version: 1, sequence: ++sequence, sampled_at: now(), cadence_ms: null, ...project(raw, devices, identity) };
      } catch (error) {
        if (pending) stop('helper_unavailable');
        const allowed = ['invalid_framebuffer', 'framebuffer_unavailable', 'ambiguous_identity', 'adapter_mapping_unavailable', 'invalid_adapter_bytes', 'invalid_process', 'invalid_process_bytes', 'helper_unavailable'];
        return unavailable(allowed.includes(error.message) ? error.message : 'collection_unavailable');
      }
    })();
    try { return await Promise.race([work, deadline]); } finally { clearTimeout(timeout); }
  }
  function sample(identity) {
    if (!flight) flight = collect(identity).finally(() => { flight = null; });
    return flight;
  }
  // No demand: end an idle helper (and its PDH query); the next sample respawns it.
  function release() { if (!flight && child) stop('released'); }
  function dispose() { disposed = true; stop('disposed'); }
  return { sample, release, dispose };
}
module.exports = { createGpuCollector };
