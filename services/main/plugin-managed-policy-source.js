'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const WINDOWS_REG_SYSTEM_ALIAS = '\\\\?\\GLOBALROOT\\SystemRoot\\System32\\reg.exe';
const WINDOWS_KEY = 'HKLM\\SOFTWARE\\Policies\\Jenny';
const WINDOWS_VALUE = 'ManagedPolicyBundle';
const MACOS_DOMAIN = '/Library/Managed Preferences/com.jenny.shell';
const MACOS_KEY = 'ManagedPolicyBundle';
const LINUX_FILE = '/etc/jenny/managed-policy.json';

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function boundedPresent(text, sourceKind, sourceId) {
  const bytes = Buffer.from(String(text || '').trim(), 'utf8');
  if (bytes.length < 2) return { status: 'invalid', reason: 'managed_policy_source_empty' };
  if (bytes.length > DEFAULT_MAX_BYTES) {
    return { status: 'invalid', reason: 'managed_policy_source_oversize' };
  }
  return {
    status: 'present',
    bytes,
    source_kind: sourceKind,
    source_fingerprint: digest(sourceId),
  };
}

function defaultExecute(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBytes || DEFAULT_MAX_BYTES,
      encoding: 'utf8',
      shell: false,
    }, (error, stdout, stderr) => {
      const failureText = `${stdout || ''}\n${stderr || ''}`.slice(0, DEFAULT_MAX_BYTES);
      const missing = /unable to find|cannot find|does not exist|could not find|domain\/default pair .* does not exist/i
        .test(failureText);
      resolve({
        ok: !error,
        exit_code: Number.isInteger(error?.code) ? error.code : (error ? 1 : 0),
        stdout: typeof stdout === 'string' ? stdout : '',
        reason: error?.killed ? 'managed_policy_source_timeout'
          : (error ? (missing ? 'managed_policy_source_missing'
            : 'managed_policy_source_unavailable') : null),
      });
    });
  });
}

async function resolveWindowsRegExe({
  windowsRoot = process.env.SystemRoot,
  realpath = fs.promises.realpath,
} = {}) {
  if (typeof windowsRoot !== 'string' || !path.win32.isAbsolute(windowsRoot)) {
    return { ok: false, reason: 'managed_policy_source_unavailable' };
  }
  try {
    const candidate = path.win32.join(windowsRoot, 'System32', 'reg.exe');
    const [resolvedCandidate, resolvedSystem] = await Promise.all([
      realpath(candidate), realpath(WINDOWS_REG_SYSTEM_ALIAS),
    ]);
    if (resolvedCandidate.toLowerCase() !== resolvedSystem.toLowerCase()) {
      return { ok: false, reason: 'managed_policy_source_unavailable' };
    }
    return { ok: true, file: resolvedSystem };
  } catch (_error) {
    return { ok: false, reason: 'managed_policy_source_unavailable' };
  }
}

function parseWindows(stdout, valueName = WINDOWS_VALUE) {
  const lines = String(stdout || '').split(/\r?\n/);
  const escapedName = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = new RegExp(`^\\s*${escapedName}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)$`, 'i');
  for (const line of lines) {
    const match = line.match(row);
    if (match) return match[1].trim();
  }
  return null;
}

function parseMacos(stdout) {
  const value = String(stdout || '').trim();
  if (!value) return null;
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch (_error) { return null; }
  }
  return value;
}

async function readCommandSource({ execute, file, args, parse, sourceKind, sourceId }) {
  const result = await execute(file, args, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!result?.ok) {
    if (result?.reason === 'managed_policy_source_timeout') {
      return { status: 'invalid', reason: result.reason };
    }
    return result?.reason === 'managed_policy_source_unavailable'
      ? { status: 'invalid', reason: result.reason }
      : { status: 'missing' };
  }
  const parsed = parse(result.stdout);
  return parsed === null
    ? { status: 'invalid', reason: 'managed_policy_source_malformed' }
    : boundedPresent(parsed, sourceKind, sourceId);
}

function sameSnapshot(before, after) {
  const hasIdentity = Number.isSafeInteger(before.ino) && before.ino !== 0
    && Number.isSafeInteger(after.ino) && after.ino !== 0;
  return before.size === after.size && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && (!hasIdentity || (before.dev === after.dev && before.ino === after.ino));
}

async function readLinuxSource({ openFile, filePath = LINUX_FILE }) {
  let handle;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    handle = await openFile(filePath, flags);
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) !== 0) {
      return { status: 'invalid', reason: 'managed_policy_source_permissions_invalid' };
    }
    if (!Number.isSafeInteger(before.size) || before.size < 2 || before.size > DEFAULT_MAX_BYTES) {
      return { status: 'invalid', reason: 'managed_policy_source_size_invalid' };
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read || read.bytesRead < 1) {
        return { status: 'invalid', reason: 'managed_policy_source_partial' };
      }
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (!sameSnapshot(before, after)) {
      return { status: 'invalid', reason: 'managed_policy_source_changed' };
    }
    return {
      status: 'present',
      bytes,
      source_kind: 'linux_root_file',
      source_fingerprint: digest('linux:/etc/jenny/managed-policy.json'),
    };
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'invalid', reason: 'managed_policy_source_unavailable' };
  } finally {
    try { await handle?.close(); } catch (_error) { /* best effort */ }
  }
}

function createPluginManagedPolicySource({
  platform = process.platform,
  execute = defaultExecute,
  openFile = fs.promises.open,
  linuxFile = LINUX_FILE,
  windowsKey = WINDOWS_KEY,
  windowsValue = WINDOWS_VALUE,
  resolveWindowsExecutable = resolveWindowsRegExe,
  macosDomain = MACOS_DOMAIN,
  macosKey = MACOS_KEY,
} = {}) {
  return Object.freeze({
    async read() {
      if (platform === 'win32') {
        const executable = await resolveWindowsExecutable();
        if (!executable?.ok) {
          return { status: 'invalid', reason: executable?.reason
            || 'managed_policy_source_unavailable' };
        }
        return readCommandSource({
          execute,
          file: executable.file,
          args: ['query', windowsKey, '/v', windowsValue],
          parse: (stdout) => parseWindows(stdout, windowsValue),
          sourceKind: 'windows_machine_policy',
          sourceId: `windows:${windowsKey}:${windowsValue}`,
        });
      }
      if (platform === 'darwin') {
        return readCommandSource({
          execute,
          file: '/usr/bin/defaults',
          args: ['read', macosDomain, macosKey],
          parse: parseMacos,
          sourceKind: 'macos_managed_preferences',
          sourceId: `macos:${macosDomain}:${macosKey}`,
        });
      }
      if (platform === 'linux') return readLinuxSource({ openFile, filePath: linuxFile });
      return { status: 'missing' };
    },
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  WINDOWS_REG_SYSTEM_ALIAS,
  WINDOWS_KEY,
  WINDOWS_VALUE,
  MACOS_DOMAIN,
  MACOS_KEY,
  LINUX_FILE,
  parseWindows,
  parseMacos,
  sameSnapshot,
  resolveWindowsRegExe,
  readLinuxSource,
  createPluginManagedPolicySource,
};
