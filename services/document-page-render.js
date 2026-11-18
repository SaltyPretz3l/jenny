'use strict';

// Row 181: the DOCX pane's Pages view. Converts a .docx (bytes from the
// renderer, the same bytes the pane would save) to PDF with an installed
// Microsoft Word (Windows, COM automation) or LibreOffice (headless), Word
// first. Desktop only; read-only; nothing is written outside a private temp
// directory that is removed after every conversion (and swept if a crash
// left one behind).
//
// Processes are stopped only by PID: the converter we spawned, and for Word
// the WINWORD process the script reports it started. The script touches and
// quits only a Word instance it started itself; if COM handed it a Word the
// owner already had open, it lets go without changing anything.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { removeFile, removeTree } = require('./fs-remove-no-follow');

const MAX_DOCX_BYTES = 32 * 1024 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;
const DETECT_TTL_MS = 5 * 60_000;
const WORK_DIR_PREFIX = 'jenny-docx-pages-';
const STALE_WORK_DIR_MS = 60 * 60_000;

// Paths arrive through the environment, never interpolated into the script.
// Exit 3: COM did not give us a Word of our own, so nothing was touched.
const WORD_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$before = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })',
  '$word = New-Object -ComObject Word.Application',
  '$after = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })',
  '$started = @($after | Where-Object { $before -notcontains $_ })',
  'if ($started.Count -ne 1) {',
  '  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)',
  '  exit 3',
  '}',
  "[Console]::Out.WriteLine('JENNY_WORD_PID=' + $started[0]); [Console]::Out.Flush()",
  'try {',
  '  $word.Visible = $false',
  '  $word.DisplayAlerts = 0',
  '  $word.AutomationSecurity = 3',
  '  $doc = $word.Documents.Open($env:JENNY_DOCX_IN, $false, $true, $false)',
  '  try { $doc.ExportAsFixedFormat($env:JENNY_DOCX_OUT, 17) } finally { $doc.Close(0) }',
  '} finally {',
  '  $word.Quit(0)',
  '  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)',
  '}',
].join('\n');

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// System tools by absolute path: a bare name would let libuv find a planted
// binary in the current directory first.
function systemTool(env, ...parts) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', ...parts);
}

function libreOfficeCandidates(platform, env) {
  if (platform === 'win32') {
    return [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]
      .filter(Boolean)
      .map((base) => path.win32.join(base, 'LibreOffice', 'program', 'soffice.exe'));
  }
  if (platform === 'darwin') {
    return ['/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  }
  return ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice', '/opt/libreoffice/program/soffice'];
}

// Buffer.from skips non-base64 characters, so a garbled string decodes to
// bytes that fail the ZIP signature check; no full-string regex on 40+ MB.
function decodeDocx(base64) {
  if (typeof base64 !== 'string' || !base64) return { error: 'invalid' };
  if (base64.length > Math.ceil(MAX_DOCX_BYTES / 3) * 4 + 4) return { error: 'too_large' };
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_DOCX_BYTES) return { error: 'too_large' };
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return { error: 'invalid' };
  return { bytes };
}

function createDocumentPageRenderer({
  isEnabled = () => true,
  platform = process.platform,
  env = process.env,
  spawnImpl = childProcess.spawn,
  fsImpl = fs.promises,
  removeTreeImpl = removeTree,
  tmpRoot = os.tmpdir(),
  killPid = null,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = null,
} = {}) {
  let detected = null; // { at, engines, sofficePath }
  let detecting = null;
  let running = false;
  let swept = false;

  const log = (level, event, data) => {
    try { logger?.[level]?.(event, data); } catch (_error) { /* logging never fails a conversion */ }
  };

  // Resolves once the process tree is gone (or the kill could not be sent).
  const stopPid = killPid || ((pid) => new Promise((resolve) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return resolve();
    if (platform !== 'win32') {
      try { process.kill(pid, 'SIGKILL'); } catch (_error) { /* already gone */ }
      return resolve();
    }
    try {
      const killer = spawnImpl(systemTool(env, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => resolve());
      killer.on('close', () => resolve());
    } catch (_error) {
      resolve();
    }
  }));

  // Runs a process to completion. Resolves { code, stdout, timedOut, pid }.
  function run(command, args, { extraEnv = {}, limitMs = timeoutMs } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(command, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...env, ...extraEnv },
        });
      } catch (_error) {
        resolve({ code: -1, stdout: '', timedOut: false, pid: 0 });
        return;
      }
      let stdout = '';
      let settled = false;
      const finish = (code, timedOut) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, timedOut, pid: child.pid });
      };
      const timer = setTimeout(() => finish(-1, true), limitMs);
      child.stdout?.on('data', (chunk) => {
        if (stdout.length < 8192) stdout += String(chunk);
      });
      child.stderr?.on('data', () => {});
      child.on('error', () => finish(-1, false));
      child.on('close', (code) => finish(Number.isInteger(code) ? code : -1, false));
    });
  }

  async function exists(filePath) {
    try {
      await fsImpl.access(filePath);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function detect() {
    const engines = [];
    let sofficePath = '';
    if (platform === 'win32') {
      const reg = await run(systemTool(env, 'reg.exe'), ['query', 'HKCR\\Word.Application\\CLSID'], { limitMs: 5000 });
      if (reg.code === 0) engines.push('word');
    }
    for (const candidate of libreOfficeCandidates(platform, env)) {
      if (await exists(candidate)) {
        sofficePath = candidate;
        engines.push('libreoffice');
        break;
      }
    }
    return { at: now(), engines, sofficePath };
  }

  async function getDetected() {
    if (detected && now() - detected.at < DETECT_TTL_MS) return detected;
    if (!detecting) {
      detecting = detect()
        .then((result) => { detected = result; return result; })
        .finally(() => { detecting = null; });
    }
    return detecting;
  }

  async function getEngines() {
    if (!isEnabled()) return { enabled: false, engines: [] };
    const { engines } = await getDetected();
    return { enabled: true, engines: [...engines] };
  }

  async function removeWorkDir(workDir) {
    try {
      await removeTreeImpl(workDir, { retries: 20, retryDelayMs: 250 });
    } catch (error) {
      log('warn', 'docx_pages.cleanup_failed', { code: error?.code || 'unknown' });
    }
  }

  // Once per process: a crash mid-conversion leaves a work dir holding a copy
  // of the owner's document; anything older than an hour is removed.
  async function sweepStaleWorkDirs() {
    if (swept) return;
    swept = true;
    try {
      for (const name of await fsImpl.readdir(tmpRoot)) {
        if (!name.startsWith(WORK_DIR_PREFIX)) continue;
        const dir = path.join(tmpRoot, name);
        const stats = await fsImpl.lstat(dir).catch(() => null);
        if (stats?.isDirectory() && now() - stats.mtimeMs > STALE_WORK_DIR_MS) await removeWorkDir(dir);
      }
    } catch (_error) { /* best effort */ }
  }

  async function convert(engine, sofficePath, workDir, inPath, outPath) {
    if (engine === 'word') {
      const result = await run(systemTool(env, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodePowerShell(WORD_SCRIPT),
      ], { extraEnv: { JENNY_DOCX_IN: inPath, JENNY_DOCX_OUT: outPath } });
      if (result.timedOut) {
        // DCOM launched Word, so it outlives PowerShell: stop the instance the
        // script reported starting, by PID, before the directory is removed.
        const wordPid = Number(/JENNY_WORD_PID=(\d+)/.exec(result.stdout)?.[1] || 0);
        await stopPid(result.pid);
        if (wordPid) await stopPid(wordPid);
      }
      return result;
    }
    const result = await run(sofficePath, [
      '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
      `-env:UserInstallation=${pathToFileURL(path.join(workDir, 'lo-profile')).href}`,
      '--convert-to', 'pdf', '--outdir', workDir, inPath,
    ]);
    if (result.timedOut) await stopPid(result.pid);
    return result;
  }

  async function readPdf(outPath) {
    let stats;
    try {
      stats = await fsImpl.stat(outPath);
    } catch (_error) {
      return null;
    }
    if (!stats.isFile() || stats.size < 5 || stats.size > MAX_PDF_BYTES) return null;
    const bytes = await fsImpl.readFile(outPath);
    return bytes.subarray(0, 5).toString('ascii') === '%PDF-' ? bytes : null;
  }

  async function render(payload) {
    if (!isEnabled()) return { ok: false, reason: 'disabled' };
    const decoded = decodeDocx(payload?.base64);
    if (decoded.error) return { ok: false, reason: decoded.error };
    if (running) return { ok: false, reason: 'busy' };
    running = true;
    let workDir = '';
    try {
      const { engines, sofficePath } = await getDetected();
      if (!engines.length) return { ok: false, reason: 'no_engine' };
      await sweepStaleWorkDirs();
      workDir = await fsImpl.mkdtemp(path.join(tmpRoot, WORK_DIR_PREFIX));
      const inPath = path.join(workDir, 'document.docx');
      const outPath = path.join(workDir, 'document.pdf');
      await fsImpl.writeFile(inPath, decoded.bytes, { mode: 0o600 });
      let timedOut = false;
      for (const engine of engines) {
        // A partial PDF a failed engine left behind must not pass as the next one's.
        await removeFile(outPath).catch(() => {});
        const result = await convert(engine, sofficePath, workDir, inPath, outPath);
        if (result.timedOut) {
          timedOut = true;
          log('warn', 'docx_pages.timeout', { engine });
          continue;
        }
        const pdf = result.code === 0 ? await readPdf(outPath) : null;
        if (pdf) return { ok: true, engine, base64: pdf.toString('base64') };
        log('warn', 'docx_pages.engine_failed', { engine, code: result.code });
      }
      return { ok: false, reason: timedOut ? 'timeout' : 'failed' };
    } catch (error) {
      log('warn', 'docx_pages.failed', { code: error?.code || 'unknown' });
      return { ok: false, reason: 'failed' };
    } finally {
      if (workDir) await removeWorkDir(workDir);
      running = false;
    }
  }

  return { getEngines, render };
}

module.exports = { MAX_DOCX_BYTES, createDocumentPageRenderer };
