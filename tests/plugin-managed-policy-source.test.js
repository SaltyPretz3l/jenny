'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_BYTES,
  WINDOWS_REG_SYSTEM_ALIAS,
  WINDOWS_KEY,
  WINDOWS_VALUE,
  MACOS_DOMAIN,
  MACOS_KEY,
  parseWindows,
  parseMacos,
  resolveWindowsRegExe,
  createPluginManagedPolicySource,
} = require('../services/main/plugin-managed-policy-source');

const TEST_WINDOWS_REG_EXE = 'C:\\Windows\\System32\\reg.exe';
function windowsSource(options = {}) {
  return createPluginManagedPolicySource({ platform: 'win32',
    resolveWindowsExecutable: async () => ({ ok: true, file: TEST_WINDOWS_REG_EXE }),
    ...options });
}

test('Windows provider uses the identity-validated system binary and returns pathless bytes', async () => {
  const calls = [];
  const source = windowsSource({ execute: async (...args) => {
    calls.push(args);
    return { ok: true, stdout: '    ManagedPolicyBundle    REG_SZ    {"x":1}\r\n' };
  } });
  const result = await source.read();
  assert.equal(calls[0][0], TEST_WINDOWS_REG_EXE);
  assert.deepEqual(calls[0][1], ['query', WINDOWS_KEY, '/v', WINDOWS_VALUE]);
  assert.equal(calls[0][2].maxBytes, DEFAULT_MAX_BYTES);
  assert.equal(result.status, 'present');
  assert.equal(result.bytes.toString('utf8'), '{"x":1}');
  assert.match(result.source_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes('HKLM'), false);
});

test('Windows executable resolution compares the candidate to the kernel SystemRoot alias', async () => {
  const calls = [];
  const resolved = await resolveWindowsRegExe({ windowsRoot: 'D:\\Windows', realpath: async (value) => {
    calls.push(value);
    return 'D:\\Windows\\System32\\reg.exe';
  } });
  assert.deepEqual(resolved, { ok: true, file: 'D:\\Windows\\System32\\reg.exe' });
  assert.deepEqual(calls, ['D:\\Windows\\System32\\reg.exe', WINDOWS_REG_SYSTEM_ALIAS]);
  const spoofed = await resolveWindowsRegExe({ windowsRoot: 'E:\\Fake', realpath: async (value) => (
    value === WINDOWS_REG_SYSTEM_ALIAS ? 'D:\\Windows\\System32\\reg.exe'
      : 'E:\\Fake\\System32\\reg.exe'
  ) });
  assert.equal(spoofed.ok, false);
});

test('macOS provider reads only the fixed Managed Preferences key', async () => {
  const calls = [];
  const source = createPluginManagedPolicySource({ platform: 'darwin', execute: async (...args) => {
    calls.push(args);
    return { ok: true, stdout: '"{\\"x\\":1}"\n' };
  } });
  const result = await source.read();
  assert.deepEqual(calls[0][1], ['read', MACOS_DOMAIN, MACOS_KEY]);
  assert.equal(result.status, 'present');
  assert.equal(result.bytes.toString('utf8'), '{"x":1}');
});

test('command source absence is unmanaged while malformed and oversize output are invalid', async () => {
  const missing = windowsSource({ execute: async () => ({ ok: false }) });
  assert.deepEqual(await missing.read(), { status: 'missing' });
  const unreadable = windowsSource({ execute: async () => ({
    ok: false, reason: 'managed_policy_source_unavailable',
  }) });
  assert.deepEqual(await unreadable.read(), {
    status: 'invalid', reason: 'managed_policy_source_unavailable',
  });
  const malformed = windowsSource({ execute: async () => ({ ok: true, stdout: 'unexpected' }) });
  assert.deepEqual(await malformed.read(), { status: 'invalid', reason: 'managed_policy_source_malformed' });
  const oversized = parseWindows(`ManagedPolicyBundle REG_SZ ${'x'.repeat(DEFAULT_MAX_BYTES + 1)}`);
  assert.equal(oversized.length, DEFAULT_MAX_BYTES + 1);
  const tooLarge = windowsSource({ execute: async () => ({ ok: true, stdout: `ManagedPolicyBundle REG_SZ ${oversized}` }) });
  assert.deepEqual(await tooLarge.read(), { status: 'invalid', reason: 'managed_policy_source_oversize' });
  assert.equal(parseMacos('"unterminated'), null);
});

test('Linux provider rejects non-root, writable, partial, and changing files', async () => {
  function handle({ uid = 0, mode = 0o100600, size = 2, reads = [{ bytesRead: 2 }], changed = false } = {}) {
    let statCalls = 0;
    return {
      stat: async () => ({ isFile: () => true, uid, mode, size, ino: 2, dev: 1,
        mtimeMs: changed && statCalls++ ? 2 : 1, ctimeMs: 1 }),
      read: async (buffer) => { const next = reads.shift() || { bytesRead: 0 }; buffer.fill(0x7b); return next; },
      close: async () => {},
    };
  }
  const wrongOwner = createPluginManagedPolicySource({ platform: 'linux', openFile: async () => handle({ uid: 1000 }) });
  assert.equal((await wrongOwner.read()).reason, 'managed_policy_source_permissions_invalid');
  const writable = createPluginManagedPolicySource({ platform: 'linux', openFile: async () => handle({ mode: 0o100622 }) });
  assert.equal((await writable.read()).reason, 'managed_policy_source_permissions_invalid');
  const partial = createPluginManagedPolicySource({ platform: 'linux', openFile: async () => handle({ reads: [{ bytesRead: 1 }, { bytesRead: 0 }] }) });
  assert.equal((await partial.read()).reason, 'managed_policy_source_partial');
  const changing = createPluginManagedPolicySource({ platform: 'linux', openFile: async () => handle({ changed: true }) });
  assert.equal((await changing.read()).reason, 'managed_policy_source_changed');
});
