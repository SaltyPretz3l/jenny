'use strict';

// Which processes hold GPU memory, for the model-load VRAM check
// (services/backend/vram-load-preflight.js). Called only when a load does not
// fit, so its cost (a PowerShell start, ~2.5 s on Windows) is never paid on a
// load that fits.
//
//   Windows: nvidia-smi reports per-process memory as N/A under WDDM, so the
//            `GPU Process Memory` performance counters are read instead (their
//            names are English-only: on a localized Windows the list comes
//            back empty and the refusal names no process).
//   Linux:   nvidia-smi --query-compute-apps, with /proc for names and parents.
//
// Each holder carries its parent chain so the caller can tell Jenny's own
// engines (and an Ollama daemon's runners) from other programs. Never throws:
// every failure resolves an empty list.

const fs = require('fs');
const { execFile: nodeExecFile } = require('child_process');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');

const MIN_HOLDER_MB = 256;
const MAX_CHAIN = 12;
const HOLDERS_TIMEOUT_MS = 8000;

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$samples = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage').CounterSamples
$byPid = @{}
foreach ($s in $samples) { if ($s.InstanceName -match '^pid_(\\d+)_') { $id = [int]$Matches[1]; $byPid[$id] = $byPid[$id] + $s.CookedValue } }
$procs = @{}
foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name) { $procs[[int]$p.ProcessId] = $p }
$out = foreach ($id in $byPid.Keys) {
  if ($byPid[$id] -ge ${MIN_HOLDER_MB * 1024 * 1024}) {
    $chain = @(); $cur = $procs[$id]; $n = 0
    while ($cur -and $n -lt ${MAX_CHAIN}) { $chain += [pscustomobject]@{ pid = [int]$cur.ProcessId; name = [string]$cur.Name }; $cur = $procs[[int]$cur.ParentProcessId]; $n++ }
    [pscustomobject]@{ pid = $id; mb = [math]::Round($byPid[$id] / 1MB); chain = $chain }
  }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 4
`;

function run(execFile, file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: sanitizeSpawnEnv(process.env),
    }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
  });
}

function toHolder(raw) {
  const pid = Number(raw?.pid);
  const mb = Number(raw?.mb);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(mb) || mb < MIN_HOLDER_MB) return null;
  const chain = (Array.isArray(raw.chain) ? raw.chain : [])
    .map((link) => ({ pid: Number(link?.pid) || 0, name: String(link?.name || '').slice(0, 120) }))
    .filter((link) => link.pid > 0)
    .slice(0, MAX_CHAIN);
  const name = chain[0]?.pid === pid ? chain[0].name : '';
  return { pid, mb: Math.round(mb), name, chain };
}

function parseWindowsHolders(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(toHolder).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

// `/proc/<pid>/stat`: "pid (comm) state ppid ...". comm may hold spaces or parens.
function readProcStat(pid, fsImpl) {
  try {
    const text = fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close < open) return null;
    const ppid = Number(text.slice(close + 2).split(' ')[1]);
    return { name: text.slice(open + 1, close), ppid: Number.isInteger(ppid) ? ppid : 0 };
  } catch (_error) {
    return null;
  }
}

function parseLinuxHolders(stdout, fsImpl) {
  const byPid = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const [pidText, mbText] = line.split(',').map((part) => part.trim());
    const pid = Number(pidText);
    const mb = Number(mbText);
    if (Number.isInteger(pid) && pid > 0 && Number.isFinite(mb)) byPid.set(pid, (byPid.get(pid) || 0) + mb);
  }
  const holders = [];
  for (const [pid, mb] of byPid) {
    const chain = [];
    let current = pid;
    while (current > 0 && chain.length < MAX_CHAIN) {
      const stat = readProcStat(current, fsImpl);
      if (!stat) break;
      chain.push({ pid: current, name: stat.name });
      current = stat.ppid;
    }
    const holder = toHolder({ pid, mb, chain });
    if (holder) holders.push(holder);
  }
  return holders;
}

async function listGpuMemoryHolders({
  platform = process.platform,
  execFile = nodeExecFile,
  fsImpl = fs,
  timeoutMs = HOLDERS_TIMEOUT_MS,
} = {}) {
  try {
    if (platform === 'win32') {
      const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
      const stdout = await run(execFile, 'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], timeoutMs);
      return parseWindowsHolders(stdout);
    }
    if (platform === 'linux') {
      const stdout = await run(execFile, 'nvidia-smi',
        ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], timeoutMs);
      return parseLinuxHolders(stdout, fsImpl);
    }
  } catch (_error) { /* an unanswered lookup names nobody */ }
  return [];
}

module.exports = {
  listGpuMemoryHolders,
  parseLinuxHolders,
  parseWindowsHolders,
};
