'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

// Use the operating system's absolute executable, never a PATH-resolved shell.
function systemPowerShellPath(systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  if (!/^[a-z]:[\\/]/i.test(systemRoot) || /[\r\n\0]/.test(systemRoot)) throw new Error('invalid_system_root');
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function fixedHelperPath(moduleDirectory = __dirname) {
  // PowerShell cannot read Electron's virtual archive filesystem.
  return path.join(moduleDirectory, 'artifact-open-with-win32.ps1')
    .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function createArtifactOpenWith({ platform = process.platform, spawnImpl = spawn, fsImpl = require('node:fs'),
  startupTimeoutMs = 30000, interactionTimeoutMs = 600000, systemRoot, processRef = process } = {}) {
  let child = null; let ready = null; let pending = null; let opening = false; let disposed = false;
  let timer; let resolveReady; let output = ''; let outputBytes = 0;
  function stop(reason = 'open_with_failed') {
    processRef.removeListener?.('exit', dispose);
    clearTimeout(timer); const old = child; child = null; ready = null;
    resolveReady?.(false); resolveReady = null;
    pending?.({ ok: false, reason }); pending = null;
    try { old?.kill(); } catch (_error) { /* already exited */ }
  }
  function deadline(ms) { clearTimeout(timer); timer = setTimeout(() => stop('open_with_timeout'), ms); timer.unref?.(); }
  function ensureReady() {
    if (disposed || platform !== 'win32') return Promise.resolve(false);
    if (ready) return ready;
    let executable;
    try {
      executable = systemPowerShellPath(systemRoot);
      if (!fsImpl.existsSync(executable) || !fsImpl.existsSync(fixedHelperPath())) return Promise.resolve(false);
    } catch (_error) { return Promise.resolve(false); }
    ready = new Promise(resolve => { resolveReady = resolve; });
    const startup = ready;
    try {
      child = spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fixedHelperPath()],
        { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const owned = child; output = ''; outputBytes = 0;
      deadline(startupTimeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (child !== owned) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 8192) { stop(); return; }
        output += chunk;
        const lines = output.split(/\r?\n/); output = lines.pop();
        for (const line of lines) {
          let result; try { result = JSON.parse(line); } catch (_error) { continue; }
          if (result.event === 'ready') { clearTimeout(timer); resolveReady?.(true); resolveReady = null; }
          else if (pending) {
            clearTimeout(timer); const resolve = pending; pending = null; outputBytes = 0;
            resolve(result.ok === true ? { ok: true } : result.canceled ? { ok: false, canceled: true } : { ok: false, reason: 'open_with_failed' });
          }
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', () => { if (child === owned) stop(); });
      child.on('close', () => { if (child === owned) stop(); });
      child.stdin.on('error', () => { if (child === owned) stop(); });
      processRef.once?.('exit', dispose);
    } catch (_error) { stop(); }
    return startup;
  }
  async function capabilities() { return { openWith: await ensureReady() }; }
  async function openWith(absolutePath, parentHandle = '0') {
    if (platform !== 'win32') return { ok: false, reason: 'unsupported' };
    if (opening) return { ok: false, reason: 'open_with_busy' };
    if (typeof absolutePath !== 'string' || !path.win32.isAbsolute(absolutePath) || /[\0\r\n]/.test(absolutePath)
      || !/^\d{1,20}$/.test(parentHandle)) return { ok: false, reason: 'open_with_failed' };
    opening = true;
    try {
      if (!await ensureReady()) return { ok: false, reason: 'unsupported' };
      return await new Promise(resolve => {
        pending = resolve; deadline(interactionTimeoutMs);
        child.stdin.write(JSON.stringify({ path: absolutePath, parent: parentHandle }) + '\n', 'utf8');
      });
    } finally { opening = false; }
  }
  function dispose() { disposed = true; stop(); processRef.removeListener?.('exit', dispose); }
  return { capabilities, openWith, dispose };
}

module.exports = { createArtifactOpenWith, systemPowerShellPath, fixedHelperPath };
