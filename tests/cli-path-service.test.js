'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  MAX_USER_PATH_LENGTH,
  REGISTRY_HELPER_SCRIPT,
  appendPathEntry,
  createCliPathService,
  createRegistryHelperRunner,
  createRegistryIo,
  normalizePathEntry,
  pathContains,
  posixExportLine,
  removePathEntry,
  resolveCliBinDir,
} = require('../services/cli-path-service');
const { CLI_PATH_ERROR_CODES } = require('../services/backend/error-codes');

const RESOURCES = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\jenny\\resources';
const BIN = `${RESOURCES}\\bin`;
const ENV = { LocalAppData: 'C:\\Users\\Ana\\AppData\\Local', USERPROFILE: 'C:\\Users\\Ana' };

function fakeRegistry(initial) {
  const registry = { exists: initial !== null, value: initial === null ? '' : initial, reads: 0, writes: [] };
  registry.readUserPath = async () => {
    registry.reads += 1;
    return { exists: registry.exists, value: registry.value };
  };
  registry.writeUserPath = async ({ expected, value }) => {
    registry.writes.push({ expected, value });
    registry.exists = value !== '';
    registry.value = value;
    return { exists: registry.exists, value, broadcast: true };
  };
  return registry;
}

function windowsService(registry, overrides = {}) {
  return createCliPathService({
    platform: 'win32',
    isPackaged: true,
    resourcesPath: RESOURCES,
    env: ENV,
    existsSync: () => true,
    readUserPath: registry.readUserPath,
    writeUserPath: registry.writeUserPath,
    ...overrides,
  });
}

test('entries compare case-insensitively, with or without a trailing backslash, quotes or %VAR% forms', () => {
  assert.equal(normalizePathEntry(`${BIN}\\`, ENV), BIN.toLowerCase());
  assert.equal(normalizePathEntry(`  "${BIN.toUpperCase()}"  `, ENV), BIN.toLowerCase());
  assert.equal(normalizePathEntry('%LOCALAPPDATA%\\Programs\\jenny\\resources\\bin', ENV), BIN.toLowerCase());
  assert.equal(normalizePathEntry('C:/Users/Ana/AppData/Local/Programs/jenny/resources/bin/', ENV), BIN.toLowerCase());
  assert.equal(normalizePathEntry('C:\\', ENV), 'c:\\', 'a drive root keeps its backslash');
  assert.equal(normalizePathEntry('', ENV), '');
  assert.equal(normalizePathEntry('%UNSET_VAR%\\bin', ENV), '%unset_var%\\bin', 'an unknown variable stays literal');

  assert.equal(pathContains(`%USERPROFILE%\\bin;${BIN.toUpperCase()}\\;D:\\tools`, BIN, ENV), true);
  assert.equal(pathContains('%LocalAppData%\\Programs\\jenny\\resources\\bin', BIN, ENV), true);
  assert.equal(pathContains(`${BIN}x;${RESOURCES}`, BIN, ENV), false, 'no prefix or parent match');
  assert.equal(pathContains('', BIN, ENV), false);
});

test('append keeps every other entry and adds the directory once', () => {
  assert.equal(appendPathEntry('', BIN, ENV), BIN);
  assert.equal(appendPathEntry('%USERPROFILE%\\bin', BIN, ENV), `%USERPROFILE%\\bin;${BIN}`);
  assert.equal(appendPathEntry('%USERPROFILE%\\bin;;', BIN, ENV), `%USERPROFILE%\\bin;${BIN}`);
  const present = `a;${BIN.toLowerCase()}\\;b`;
  assert.equal(appendPathEntry(present, BIN, ENV), present, 'an existing entry in any form is left as it is');
});

test('remove drops every duplicate and keeps the remaining text verbatim', () => {
  const raw = `%USERPROFILE%\\bin;${BIN};D:\\Tools;;${BIN.toUpperCase()}\\;%LOCALAPPDATA%\\Programs\\jenny\\resources\\bin;E:\\x`;
  assert.equal(removePathEntry(raw, BIN, ENV), '%USERPROFILE%\\bin;D:\\Tools;;E:\\x');
  assert.equal(removePathEntry(BIN, BIN, ENV), '');
  assert.equal(removePathEntry('a;b', BIN, ENV), 'a;b');
});

test('the bin directory comes only from a packaged resources path', () => {
  assert.equal(resolveCliBinDir({ isPackaged: true, resourcesPath: RESOURCES, platform: 'win32' }), BIN);
  assert.equal(resolveCliBinDir({ isPackaged: true, resourcesPath: '/opt/Jenny/resources', platform: 'linux' }), '/opt/Jenny/resources/bin');
  assert.equal(resolveCliBinDir({ isPackaged: false, resourcesPath: RESOURCES }), '');
  assert.equal(resolveCliBinDir({ isPackaged: true, resourcesPath: '' }), '');
});

test('a source checkout, Linux, macOS and an AppImage never touch the registry', async () => {
  const registry = fakeRegistry('a');
  const source = createCliPathService({ platform: 'win32', isPackaged: false, resourcesPath: RESOURCES, ...registry });
  assert.deepEqual(await source.getState(), {
    ok: true, platform: 'win32', supported: false, reason: 'source_checkout', binDir: '', manualCommand: '', onPath: null,
  });
  const install = await source.install();
  assert.equal(install.ok, false);
  assert.equal(install.code, CLI_PATH_ERROR_CODES.UNSUPPORTED);

  const linux = createCliPathService({ platform: 'linux', isPackaged: true, resourcesPath: '/opt/Jenny/resources', env: {}, ...registry });
  const linuxState = await linux.getState();
  assert.equal(linuxState.supported, false);
  assert.equal(linuxState.reason, 'manual');
  assert.equal(linuxState.manualCommand, 'export PATH="/opt/Jenny/resources/bin:$PATH"');
  assert.equal((await linux.remove()).code, CLI_PATH_ERROR_CODES.UNSUPPORTED);

  const mac = createCliPathService({ platform: 'darwin', isPackaged: true, resourcesPath: '/Applications/Jenny.app/Contents/Resources', env: {}, ...registry });
  assert.equal((await mac.getState()).manualCommand, 'export PATH="/Applications/Jenny.app/Contents/Resources/bin:$PATH"');

  const appImage = createCliPathService({ platform: 'linux', isPackaged: true, resourcesPath: '/tmp/.mount_JennyX/resources', env: { APPIMAGE: '/home/a/Jenny.AppImage' }, ...registry });
  const appImageState = await appImage.getState();
  assert.equal(appImageState.reason, 'appimage');
  assert.equal(appImageState.manualCommand, '');

  assert.equal(registry.reads, 0);
  assert.equal(registry.writes.length, 0);
});

test('the manual export line quotes an unusual directory safely', () => {
  assert.equal(posixExportLine("/opt/Jen ny's/bin"), "export PATH='/opt/Jen ny'\\''s/bin':\"$PATH\"");
  assert.equal(posixExportLine('/opt/$HOME/bin'), "export PATH='/opt/$HOME/bin':\"$PATH\"");
});

test('Windows state reads the user Path and reports membership', async () => {
  const registry = fakeRegistry(`%USERPROFILE%\\bin;${BIN.toUpperCase()}\\`);
  const state = await windowsService(registry).getState();
  assert.deepEqual(state, {
    ok: true, platform: 'win32', supported: true, reason: '', binDir: BIN, manualCommand: '', onPath: true,
  });
  registry.value = 'D:\\tools';
  assert.equal((await windowsService(registry).getState()).onPath, false);

  const failing = windowsService({
    readUserPath: async () => { throw new Error('boom'); },
    writeUserPath: async () => { throw new Error('unused'); },
  });
  const failed = await failing.getState();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, CLI_PATH_ERROR_CODES.REGISTRY_FAILED);
  assert.equal(failed.supported, true);
  assert.equal(failed.binDir, BIN);
});

test('install appends once, passes the value it read, and is a no-op when already present', async () => {
  const registry = fakeRegistry('%USERPROFILE%\\bin');
  const service = windowsService(registry);
  const result = await service.install();
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.onPath, true);
  assert.equal(result.broadcast, true);
  assert.deepEqual(registry.writes, [{ expected: '%USERPROFILE%\\bin', value: `%USERPROFILE%\\bin;${BIN}` }]);

  const again = await service.install();
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.onPath, true);
  assert.equal(registry.writes.length, 1);
});

test('install on a user without a Path value creates it and expects no value', async () => {
  const registry = fakeRegistry(null);
  const result = await windowsService(registry).install();
  assert.equal(result.ok, true);
  assert.deepEqual(registry.writes, [{ expected: null, value: BIN }]);
});

test('install refuses a missing shim, an over-long Path and an unusable directory', async () => {
  const registry = fakeRegistry('a');
  const missing = await windowsService(registry, { existsSync: () => false }).install();
  assert.equal(missing.code, CLI_PATH_ERROR_CODES.SHIM_MISSING);
  assert.equal(missing.reason, 'shim_missing');

  registry.value = `C:\\${'x'.repeat(MAX_USER_PATH_LENGTH - 5)}`;
  const tooLong = await windowsService(registry).install();
  assert.equal(tooLong.code, CLI_PATH_ERROR_CODES.PATH_INVALID);
  assert.equal(tooLong.reason, 'path_too_long');

  const semicolon = await windowsService(fakeRegistry('a'), { resourcesPath: 'C:\\odd;dir\\resources' }).install();
  assert.equal(semicolon.code, CLI_PATH_ERROR_CODES.PATH_INVALID);
  assert.equal(semicolon.reason, 'bin_dir_invalid');
  assert.equal(registry.writes.length, 0);
});

test('remove strips every form of the entry and deletes an emptied value', async () => {
  const registry = fakeRegistry(`${BIN};D:\\tools;%LOCALAPPDATA%\\Programs\\jenny\\resources\\bin\\`);
  const service = windowsService(registry);
  const result = await service.remove();
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.onPath, false);
  assert.equal(registry.value, 'D:\\tools');

  registry.value = BIN;
  await service.remove();
  assert.deepEqual(registry.writes.at(-1), { expected: BIN, value: '' });

  const nothing = await service.remove();
  assert.equal(nothing.changed, false);
  assert.equal(nothing.onPath, false);
});

test('a concurrent change, a second action in flight and an unverified write are reported, not hidden', async () => {
  const changed = windowsService({
    readUserPath: async () => ({ exists: true, value: 'a' }),
    writeUserPath: createRegistryIo(async () => ({ ok: false, reason: 'changed' })).writeUserPath,
  });
  const conflict = await changed.install();
  assert.equal(conflict.code, CLI_PATH_ERROR_CODES.PATH_CHANGED);
  assert.equal(conflict.reason, 'path_changed');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = windowsService({
    readUserPath: async () => { await gate; return { exists: true, value: 'a' }; },
    writeUserPath: async ({ value }) => ({ exists: true, value, broadcast: true }),
  });
  const first = slow.install();
  const second = await slow.remove();
  assert.equal(second.code, CLI_PATH_ERROR_CODES.BUSY);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await slow.remove()).ok, true, 'the guard clears after the first action settles');

  const lying = windowsService({
    readUserPath: async () => ({ exists: true, value: 'a' }),
    writeUserPath: async () => ({ exists: true, value: 'a', broadcast: true }),
  });
  const unverified = await lying.install();
  assert.equal(unverified.code, CLI_PATH_ERROR_CODES.REGISTRY_FAILED);
  assert.equal(unverified.reason, 'verify_failed');
});

function fakeChild({ respond, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin = {
    written: '',
    on() {},
    end(data) {
      this.written = String(data);
      if (hang) return;
      setImmediate(() => {
        const request = JSON.parse(Buffer.from(this.written, 'base64').toString('utf8'));
        const output = respond(request);
        if (output !== undefined) child.stdout.emit('data', output);
        child.emit('close', 0);
      });
    },
  };
  return child;
}

const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

test('the helper runner spawns the fixed script without a shell and frames IO as base64 JSON', async () => {
  const calls = [];
  let child;
  const run = createRegistryHelperRunner({
    powershellPath: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    env: { PATH: 'x', OPENAI_API_KEY: 'secret' },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      child = fakeChild({ respond: (request) => encode({ ok: true, exists: true, kind: 'ExpandString', value: `C:\\Users\\Jos\u00e9;${request.op}` }) });
      return child;
    },
  });
  const result = await run({ op: 'read' });
  assert.deepEqual(result, { ok: true, exists: true, kind: 'ExpandString', value: 'C:\\Users\\Jos\u00e9;read' });
  assert.equal(calls.length, 1);
  const [{ command, args, options }] = calls;
  assert.match(command, /powershell\.exe$/);
  assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  assert.equal(args.at(-1), REGISTRY_HELPER_SCRIPT, 'the script is a constant, never built from a value');
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.OPENAI_API_KEY, undefined, 'the spawn env is sanitized');
  assert.deepEqual(JSON.parse(Buffer.from(child.stdin.written, 'base64').toString('utf8')), { op: 'read' });
});

test('the helper script is single-quoted, HKCU only, kind-preserving and verifies the expected value', () => {
  assert.doesNotMatch(REGISTRY_HELPER_SCRIPT, /["`]/, 'no double quotes or backticks to mangle on the command line');
  assert.doesNotMatch(REGISTRY_HELPER_SCRIPT, /LocalMachine|HKLM|'Machine'/);
  assert.match(REGISTRY_HELPER_SCRIPT, /CurrentUser\.CreateSubKey\('Environment'\)/);
  assert.match(REGISTRY_HELPER_SCRIPT, /DoNotExpandEnvironmentNames/);
  assert.match(REGISTRY_HELPER_SCRIPT, /RegistryValueKind\]::ExpandString/);
  assert.match(REGISTRY_HELPER_SCRIPT, /-ceq \[string\]\$expected/);
  assert.match(REGISTRY_HELPER_SCRIPT, /SetEnvironmentVariable\('JENNY_CLI_PATH_BROADCAST', \$null, 'User'\)/);
});

test('the helper runner fails closed on garbage, a spawn error and a timeout', async () => {
  const garbage = createRegistryHelperRunner({ powershellPath: () => 'ps', spawnImpl: () => fakeChild({ respond: () => 'not base64 json' }) });
  await assert.rejects(garbage({ op: 'read' }), (error) => error.code === CLI_PATH_ERROR_CODES.REGISTRY_FAILED && error.reason === 'helper_invalid_response');

  const throwing = createRegistryHelperRunner({ powershellPath: () => 'ps', spawnImpl: () => { throw new Error('ENOENT'); } });
  await assert.rejects(throwing({ op: 'read' }), (error) => error.reason === 'helper_spawn_failed');

  let hung;
  const slow = createRegistryHelperRunner({
    powershellPath: () => 'ps',
    timeoutMs: 20,
    spawnImpl: () => { hung = fakeChild({ hang: true }); return hung; },
  });
  await assert.rejects(slow({ op: 'read' }), (error) => error.reason === 'helper_timeout');
  assert.equal(hung.killed, true);
});

test('registry IO maps helper results to bounded reasons', async () => {
  const io = createRegistryIo(async (request) => (request.op === 'read'
    ? { ok: true, exists: false, value: '' }
    : { ok: false, reason: 'unsupported_kind' }));
  assert.deepEqual(await io.readUserPath(), { exists: false, value: '' });
  await assert.rejects(io.writeUserPath({ expected: null, value: 'a' }), (error) => error.reason === 'unsupported_kind');
  const unreadable = createRegistryIo(async () => ({ ok: false, reason: 'registry_error' }));
  await assert.rejects(unreadable.readUserPath(), (error) => error.code === CLI_PATH_ERROR_CODES.REGISTRY_FAILED && error.reason === 'read_failed');
});
