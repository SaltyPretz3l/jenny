'use strict';

/**
 * Opt-in "Install command-line tool" for the desktop app (row 9, decision 13).
 *
 * An installed Jenny ships the `jenny` CLI shim in `<resources>/bin`. On a
 * packaged Windows install this service reports whether that directory is on
 * the current user's `Path` (HKCU\Environment) and adds or removes it there.
 * The machine `Path` is never read or written. Linux and macOS installs get the
 * manual `export` line instead, and a source checkout reports `unsupported`.
 *
 * Membership and the new value are computed here (pure, tested); the registry
 * IO runs in a fixed PowerShell script that receives its request as base64 JSON
 * on stdin, so no value is ever spliced into a command line. A write carries
 * the value it was computed from and the helper refuses it when the registry no
 * longer holds exactly that value (`PATH_CHANGED`).
 */

const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { CLI_PATH_ERROR_CODES } = require('./backend/error-codes');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');
const { systemPowerShellPath } = require('./artifact-open-with');

// Windows caps one environment variable at 32,767 characters including the
// terminating NUL; a longer user Path would not reach new processes intact.
const MAX_USER_PATH_LENGTH = 32766;
const HELPER_TIMEOUT_MS = 20000;
const HELPER_OUTPUT_CAP = 256 * 1024;
const WINDOWS_SHIM = 'jenny.cmd';

// The registry helper. Single-quoted PowerShell only: no double quotes or
// backticks, so the script survives the Windows command line unchanged. It
// reads the raw value (DoNotExpandEnvironmentNames keeps %VAR% entries), keeps
// the value's kind on write (REG_EXPAND_SZ unless it was REG_SZ), deletes the
// value when the new text is empty, and re-reads it so the caller can confirm.
// .NET Framework's SetEnvironmentVariable(User) broadcasts WM_SETTINGCHANGE
// after its registry step; deleting a name that never exists uses that
// broadcast without letting it rewrite Path as REG_SZ.
const REGISTRY_HELPER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'function Send-Result($r) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($r | ConvertTo-Json -Compress)))) }',
  'try {',
  ' $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json',
  " $write = $req.op -eq 'write'",
  " if ($write) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') } else { $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment') }",
  " $current = $null; $kind = 'None'",
  " if ($null -ne $key) { $current = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames'); if ($null -ne $current) { $kind = $key.GetValueKind('Path').ToString() } }",
  ' if (-not $write) { Send-Result @{ ok = $true; exists = ($null -ne $current); kind = $kind; value = [string]$current }; return }',
  " if ($kind -ne 'None' -and $kind -ne 'String' -and $kind -ne 'ExpandString') { Send-Result @{ ok = $false; reason = 'unsupported_kind' }; return }",
  ' $expected = $req.expected',
  ' $same = (($null -eq $current) -and ($null -eq $expected)) -or (($null -ne $current) -and ($null -ne $expected) -and ([string]$current -ceq [string]$expected))',
  " if (-not $same) { Send-Result @{ ok = $false; reason = 'changed' }; return }",
  ' $target = [string]$req.value',
  " if ($target.Length -eq 0) { $key.DeleteValue('Path', $false) } elseif ($kind -eq 'String') { $key.SetValue('Path', $target, [Microsoft.Win32.RegistryValueKind]::String) } else { $key.SetValue('Path', $target, [Microsoft.Win32.RegistryValueKind]::ExpandString) }",
  " $after = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')",
  ' $key.Close()',
  ' $broadcast = $true',
  " try { [Environment]::SetEnvironmentVariable('JENNY_CLI_PATH_BROADCAST', $null, 'User') } catch { $broadcast = $false }",
  ' Send-Result @{ ok = $true; exists = ($null -ne $after); value = [string]$after; broadcast = $broadcast }',
  "} catch { Send-Result @{ ok = $false; reason = 'registry_error' } }",
].join('\n');

class CliPathError extends Error {
  constructor(code, reason) {
    super(reason);
    this.code = code;
    this.reason = reason;
  }
}

function lookupEnv(env, name) {
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(env || {})) {
    if (key.toLowerCase() === wanted && typeof env[key] === 'string') return env[key];
  }
  return undefined;
}

function expandEnvRefs(text, env) {
  return String(text).replace(/%([^%;]+)%/g, (match, name) => {
    const value = lookupEnv(env, name);
    return value === undefined ? match : value;
  });
}

/**
 * Comparable form of one PATH entry: trimmed, unquoted, %VAR% expanded,
 * normalized separators and `..`, no trailing backslash (a drive root keeps
 * its own), lower case. Empty for an empty entry.
 */
function normalizePathEntry(entry, env = {}) {
  let value = String(entry == null ? '' : entry).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).trim();
  if (!value) return '';
  value = path.win32.normalize(expandEnvRefs(value, env).replace(/\//g, '\\'));
  while (value.length > 3 && value.endsWith('\\')) value = value.slice(0, -1);
  return value.toLowerCase();
}

function splitPathValue(raw) {
  return String(raw == null ? '' : raw).split(';');
}

function pathContains(raw, binDir, env = {}) {
  const target = normalizePathEntry(binDir, env);
  if (!target) return false;
  return splitPathValue(raw).some((entry) => normalizePathEntry(entry, env) === target);
}

function appendPathEntry(raw, binDir, env = {}) {
  const text = String(raw == null ? '' : raw);
  if (pathContains(text, binDir, env)) return text;
  const base = text.replace(/;+$/, '');
  return base ? `${base};${binDir}` : binDir;
}

/** Drops every entry equal to binDir (all duplicates); keeps the rest verbatim. */
function removePathEntry(raw, binDir, env = {}) {
  const target = normalizePathEntry(binDir, env);
  return splitPathValue(raw)
    .filter((entry) => !(target && normalizePathEntry(entry, env) === target))
    .join(';');
}

function isUsableWindowsBinDir(binDir) {
  return typeof binDir === 'string'
    && path.win32.isAbsolute(binDir)
    && /^(?:[a-z]:\\|\\\\)/i.test(binDir)
    && !/[;"%\0\r\n]/.test(binDir);
}

function posixExportLine(binDir) {
  const dir = /^[A-Za-z0-9_./+-]+$/.test(binDir) ? binDir : null;
  if (dir) return `export PATH="${dir}:$PATH"`;
  return `export PATH='${binDir.replace(/'/g, "'\\''")}':"$PATH"`;
}

function resolveCliBinDir({ isPackaged, resourcesPath, platform = process.platform } = {}) {
  if (isPackaged !== true || typeof resourcesPath !== 'string' || !resourcesPath) return '';
  return (platform === 'win32' ? path.win32 : path.posix).join(resourcesPath, 'bin');
}

/** Spawns the fixed helper and resolves with its decoded JSON result. */
function createRegistryHelperRunner({
  spawnImpl = childProcess.spawn,
  powershellPath = () => systemPowerShellPath(),
  env = process.env,
  timeoutMs = HELPER_TIMEOUT_MS,
} = {}) {
  return function runRegistryHelper(request) {
    return new Promise((resolve, reject) => {
      const fail = (reason) => reject(new CliPathError(CLI_PATH_ERROR_CODES.REGISTRY_FAILED, reason));
      let child;
      try {
        child = spawnImpl(powershellPath(), [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', REGISTRY_HELPER_SCRIPT,
        ], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: sanitizeSpawnEnv(env) });
      } catch (_error) {
        fail('helper_spawn_failed');
        return;
      }
      let settled = false;
      let output = '';
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => finish(() => {
        try { child.kill(); } catch (_error) { /* only our helper is owned */ }
        fail('helper_timeout');
      }), timeoutMs);
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.length > HELPER_OUTPUT_CAP) {
          finish(() => {
            try { child.kill(); } catch (_error) { /* only our helper is owned */ }
            fail('helper_output_limit');
          });
        }
      });
      child.on('error', () => finish(() => fail('helper_spawn_failed')));
      child.on('close', () => finish(() => {
        let result;
        try {
          result = JSON.parse(Buffer.from(output.trim(), 'base64').toString('utf8'));
        } catch (_error) {
          result = null;
        }
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          fail('helper_invalid_response');
          return;
        }
        resolve(result);
      }));
      child.stdin.on('error', () => { /* a dead helper reports through close */ });
      child.stdin.end(Buffer.from(JSON.stringify(request), 'utf8').toString('base64'));
    });
  };
}

function createRegistryIo(runHelper) {
  return {
    async readUserPath() {
      const result = await runHelper({ op: 'read' });
      if (result.ok !== true) throw new CliPathError(CLI_PATH_ERROR_CODES.REGISTRY_FAILED, 'read_failed');
      return { exists: result.exists === true, value: typeof result.value === 'string' ? result.value : '' };
    },
    async writeUserPath({ expected, value }) {
      const result = await runHelper({ op: 'write', expected, value });
      if (result.ok === true) {
        return {
          exists: result.exists === true,
          value: typeof result.value === 'string' ? result.value : '',
          broadcast: result.broadcast === true,
        };
      }
      if (result.reason === 'changed') throw new CliPathError(CLI_PATH_ERROR_CODES.PATH_CHANGED, 'path_changed');
      throw new CliPathError(CLI_PATH_ERROR_CODES.REGISTRY_FAILED,
        result.reason === 'unsupported_kind' ? 'unsupported_kind' : 'write_failed');
    },
  };
}

function failure(error) {
  if (error instanceof CliPathError) return { ok: false, code: error.code, reason: error.reason };
  return { ok: false, code: CLI_PATH_ERROR_CODES.REGISTRY_FAILED, reason: 'unexpected' };
}

function createCliPathService({
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  env = process.env,
  existsSync = fs.existsSync,
  spawnImpl,
  readUserPath,
  writeUserPath,
} = {}) {
  const binDir = resolveCliBinDir({ isPackaged, resourcesPath, platform });
  const io = (readUserPath && writeUserPath)
    ? { readUserPath, writeUserPath }
    : createRegistryIo(createRegistryHelperRunner({ spawnImpl, env }));
  let pending = null;

  function baseState() {
    if (!binDir) {
      return { platform, supported: false, reason: 'source_checkout', binDir: '', manualCommand: '', onPath: null };
    }
    if (platform === 'win32') {
      return { platform, supported: true, reason: '', binDir, manualCommand: '', onPath: null };
    }
    if (platform === 'linux' && lookupEnv(env, 'APPIMAGE')) {
      return { platform, supported: false, reason: 'appimage', binDir, manualCommand: '', onPath: null };
    }
    return { platform, supported: false, reason: 'manual', binDir, manualCommand: posixExportLine(binDir), onPath: null };
  }

  function assertWritable(state) {
    if (!state.supported) throw new CliPathError(CLI_PATH_ERROR_CODES.UNSUPPORTED, state.reason || 'unsupported');
    if (!isUsableWindowsBinDir(binDir)) throw new CliPathError(CLI_PATH_ERROR_CODES.PATH_INVALID, 'bin_dir_invalid');
  }

  async function getState() {
    const state = baseState();
    if (!state.supported) return { ok: true, ...state };
    try {
      const current = await io.readUserPath();
      return { ok: true, ...state, onPath: pathContains(current.value, binDir, env) };
    } catch (error) {
      return { ...failure(error), ...state };
    }
  }

  async function change(kind) {
    const state = baseState();
    assertWritable(state);
    if (kind === 'install' && !existsSync(path.win32.join(binDir, WINDOWS_SHIM))) {
      throw new CliPathError(CLI_PATH_ERROR_CODES.SHIM_MISSING, 'shim_missing');
    }
    const current = await io.readUserPath();
    const expected = current.exists ? current.value : null;
    const next = kind === 'install'
      ? appendPathEntry(current.value, binDir, env)
      : removePathEntry(current.value, binDir, env);
    if (next === current.value) {
      return { ok: true, changed: false, broadcast: false, ...state, onPath: kind === 'install' };
    }
    if (next.length > MAX_USER_PATH_LENGTH) throw new CliPathError(CLI_PATH_ERROR_CODES.PATH_INVALID, 'path_too_long');
    const written = await io.writeUserPath({ expected, value: next });
    const onPath = pathContains(written.value, binDir, env);
    if (onPath !== (kind === 'install')) {
      throw new CliPathError(CLI_PATH_ERROR_CODES.REGISTRY_FAILED, 'verify_failed');
    }
    return { ok: true, changed: true, broadcast: written.broadcast === true, ...state, onPath };
  }

  function run(kind) {
    if (pending) return Promise.resolve({ ok: false, code: CLI_PATH_ERROR_CODES.BUSY, reason: 'busy' });
    pending = change(kind).catch(failure).finally(() => { pending = null; });
    return pending;
  }

  return {
    binDir,
    getState,
    install: () => run('install'),
    remove: () => run('remove'),
  };
}

module.exports = {
  MAX_USER_PATH_LENGTH,
  REGISTRY_HELPER_SCRIPT,
  WINDOWS_SHIM,
  appendPathEntry,
  createCliPathService,
  createRegistryHelperRunner,
  createRegistryIo,
  normalizePathEntry,
  pathContains,
  posixExportLine,
  removePathEntry,
  resolveCliBinDir,
};
