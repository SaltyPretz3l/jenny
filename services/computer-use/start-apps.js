'use strict';

/* services/computer-use/start-apps.js: the installed apps Windows lists in the Start menu (row 196).
 *
 * One PowerShell run lists them (`Get-StartApps`) and, for Store apps, works out the program file from the
 * app's manifest, all in one process. The script is a fixed string that takes no input: nothing from a
 * query, a name or an AUMID ever reaches a command line. What comes back is untrusted data and is checked
 * here: an AUMID must match a strict pattern, a name is cleaned, a program must be an absolute `.exe` path.
 * PowerShell is injected (`runPowerShell`), so tests never start it. */

const { cleanProgramName, validProgramPath } = require('./owner-programs');

// `PackageFamilyName!ApplicationId`. Desktop apps list a path or a GUID instead and are skipped: their
// Start menu shortcuts cover them.
const AUMID_PATTERN = /^[A-Za-z0-9._-]{1,200}![A-Za-z0-9._-]{1,100}$/;
const RUN_TIMEOUT_MS = 10000;
const MAX_STDOUT_CHARS = 2 * 1024 * 1024;
const MAX_APPS = 3000;
const FAILURE_TTL_MS = 30000;

// Output is a JSON array of { n: name, a: AUMID, p: program file or null }. `@(...)` and `-InputObject`
// keep a one-app machine an array; the parser also accepts a single object. Everything that can fail is
// swallowed so that the worst case is an empty list.
const LIST_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$families = @{}',
  'foreach ($pkg in @(Get-AppxPackage)) {',
  '  if ($pkg.PackageFamilyName -and $pkg.InstallLocation) { $families[[string]$pkg.PackageFamilyName] = [string]$pkg.InstallLocation }',
  '}',
  '$rows = @()',
  'foreach ($app in @(Get-StartApps)) {',
  '  $id = [string]$app.AppID',
  '  $program = $null',
  "  $m = [regex]::Match($id, '^([A-Za-z0-9._-]{1,200})!([A-Za-z0-9._-]{1,100})$')",
  '  if ($m.Success -and $families.ContainsKey($m.Groups[1].Value)) {',
  '    $root = $families[$m.Groups[1].Value]',
  '    try {',
  "      [xml]$manifest = Get-Content -LiteralPath (Join-Path $root 'AppxManifest.xml') -Raw",
  '      foreach ($entry in @($manifest.Package.Applications.Application)) {',
  '        if ($entry.Id -eq $m.Groups[2].Value -and $entry.Executable) { $program = Join-Path $root ([string]$entry.Executable) }',
  '      }',
  '    } catch { $program = $null }',
  '  }',
  '  $rows += [pscustomobject]@{ n = [string]$app.Name; a = $id; p = $program }',
  '}',
  'ConvertTo-Json -InputObject @($rows) -Compress',
].join('\n');

function parseApps(stdout) {
  if (typeof stdout !== 'string' || stdout.length > MAX_STDOUT_CHARS) return null;
  let data;
  try { data = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); } catch (_error) { return null; }
  if (data && typeof data === 'object' && !Array.isArray(data)) data = [data];
  if (!Array.isArray(data)) return null;
  const apps = [];
  const seen = new Set();
  for (const row of data) {
    if (apps.length >= MAX_APPS) break;
    if (!row || typeof row !== 'object') continue;
    const name = cleanProgramName(row.n);
    const aumid = typeof row.a === 'string' ? row.a : '';
    if (!name || !AUMID_PATTERN.test(aumid) || seen.has(aumid)) continue;
    seen.add(aumid);
    apps.push({ name, aumid, program: validProgramPath(row.p) || null });
  }
  return apps;
}

/**
 * @param {object} options
 * @param {(script: string, options: { timeoutMs: number }) => Promise<string>} options.runPowerShell
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs] how long a good listing is kept
 * @param {number} [options.timeoutMs] the run's limit (default 10 s)
 */
function createStartApps({ runPowerShell, now = Date.now, ttlMs = 300000, timeoutMs = RUN_TIMEOUT_MS } = {}) {
  let cached = null; // { apps, expires }
  let inflight = null;

  async function run() {
    let timer;
    try {
      const limit = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('start_apps_timeout')), timeoutMs);
      });
      const stdout = await Promise.race([(async () => runPowerShell(LIST_SCRIPT, { timeoutMs }))(), limit]);
      return parseApps(stdout);
    } catch (_error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function list() {
    if (cached && now() < cached.expires) return Promise.resolve(cached.apps.map((app) => ({ ...app })));
    if (!inflight) {
      inflight = run().then((apps) => {
        const ok = Array.isArray(apps);
        cached = { apps: ok ? apps : [], expires: now() + (ok ? ttlMs : Math.min(ttlMs, FAILURE_TTL_MS)) };
        return cached.apps;
      }).finally(() => { inflight = null; });
    }
    return inflight.then((apps) => apps.map((app) => ({ ...app })));
  }

  // Drops the cache. A run already in flight still answers its own callers.
  function clear() { cached = null; }

  return { list, clear };
}

/** The real PowerShell run: the fixed Windows PowerShell path, no window, UTF-16 encoded command. */
function defaultRunPowerShell(script, { timeoutMs = RUN_TIMEOUT_MS } = {}) {
  const { execFile } = require('node:child_process');
  const path = require('node:path');
  const root = /^[a-z]:\\/i.test(process.env.SystemRoot || '') ? process.env.SystemRoot : 'C:\\Windows';
  const exe = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(String(script), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = execFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_STDOUT_CHARS,
      encoding: 'utf8',
    }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
    child.stdin?.end();
  });
}

module.exports = {
  AUMID_PATTERN,
  FAILURE_TTL_MS,
  LIST_SCRIPT,
  MAX_STDOUT_CHARS,
  createStartApps,
  defaultRunPowerShell,
  parseApps,
};
