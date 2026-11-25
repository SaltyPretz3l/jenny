const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PINNED_TERMINAL_VERSION,
  discoverStrataInstall,
  realPathInside,
  samePath,
} = require('../services/strata-install');

const ENGINE_REL = path.join('components', 'shapes', 'inkling2', 'engine');

function makeTmp(t) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'strata-install-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

function put(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A junction needs no admin rights on Windows; fall back to a dir symlink elsewhere.
function link(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  for (const type of ['junction', 'dir']) {
    try {
      fs.symlinkSync(target, linkPath, type);
      return true;
    } catch (_error) {
      void _error;
    }
  }
  return false;
}

function addTerminal(root, version, { python = true, server = true, versionFile = version } = {}) {
  const dir = path.join(root, 'terminal', version);
  fs.mkdirSync(dir, { recursive: true });
  if (python) put(path.join(dir, 'python', 'python.exe'));
  if (server) put(path.join(dir, 'serve', 'server.py'));
  if (versionFile !== null) put(path.join(dir, 'VERSION'), `${versionFile}\n`);
  return dir;
}

function addEngine(root, folder, manifest = {}, { exe = true } = {}) {
  const dir = path.join(root, ENGINE_REL, folder);
  const body = {
    schema_version: 2,
    id: 'strata-inkling',
    version: '0.1.67',
    platform: 'windows-x86_64',
    backend: 'cuda',
    entrypoint: 'strata-inkling.exe',
    ...manifest,
  };
  put(path.join(dir, 'engine-component.json'), JSON.stringify(body));
  if (exe && typeof body.entrypoint === 'string') put(path.join(dir, 'strata-inkling.exe'));
  return dir;
}

function makeInstall(t, { terminal = ['0.1.67'], engine = true } = {}) {
  const tmp = makeTmp(t);
  const localAppData = path.join(tmp, 'LocalAppData');
  const root = path.join(localAppData, 'Strata');
  fs.mkdirSync(root, { recursive: true });
  for (const version of terminal) addTerminal(root, version);
  if (engine) addEngine(root, '0.1.67-windows-x86_64-cuda-cuda13');
  return { tmp, localAppData, root };
}

test('discovers the real layout and reads the terminal current junction', async (t) => {
  const { tmp, localAppData, root } = makeInstall(t, { terminal: ['0.1.67', '0.1.100'] });
  if (!link(path.join(root, 'terminal', '0.1.67'), path.join(root, 'terminal', 'current'))) return t.skip('no link support');
  const found = await discoverStrataInstall({ localAppData });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.equal(found.root, root);
  assert.equal(found.terminalDir, path.join(root, 'terminal', '0.1.67'), 'the accepted current wins over the higher folder');
  assert.equal(found.version, '0.1.67');
  assert.equal(found.pythonExe, path.join(found.terminalDir, 'python', 'python.exe'));
  assert.equal(found.serverPy, path.join(found.terminalDir, 'serve', 'server.py'));
  assert.equal(found.componentsDir, path.join(root, 'components'));
  assert.equal(found.engine.exe, path.join(root, ENGINE_REL, '0.1.67-windows-x86_64-cuda-cuda13', 'strata-inkling.exe'));
  assert.equal(found.engine.dir, path.dirname(found.engine.exe));
  assert.equal(found.engine.version, '0.1.67');
  assert.equal(found.engine.backend, 'cuda');
  assert.deepEqual(found.warnings, []);
  assert.equal(PINNED_TERMINAL_VERSION, '0.1.67');
  assert.ok(tmp);
});

test('a current junction pointing outside terminal is ignored and the highest real version is used', async (t) => {
  const { tmp, localAppData, root } = makeInstall(t, { terminal: ['0.1.67', '0.1.100'] });
  const outside = path.join(tmp, 'elsewhere');
  fs.mkdirSync(path.join(outside, 'serve'), { recursive: true });
  put(path.join(outside, 'serve', 'server.py'));
  put(path.join(outside, 'python', 'python.exe'));
  if (!link(outside, path.join(root, 'terminal', 'current'))) return t.skip('no link support');
  const found = await discoverStrataInstall({ localAppData });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.equal(found.terminalDir, path.join(root, 'terminal', '0.1.100'));
  assert.ok(found.warnings.some((w) => w.code === 'terminal_current_ignored'));
});

test('a current link to a nested or non-terminal folder is ignored too', async (t) => {
  const { localAppData, root } = makeInstall(t, { terminal: ['0.1.67'] });
  if (!link(path.join(root, 'components'), path.join(root, 'terminal', 'current'))) return t.skip('no link support');
  const found = await discoverStrataInstall({ localAppData });
  assert.equal(found.ok, true);
  assert.equal(found.terminalDir, path.join(root, 'terminal', '0.1.67'));
  assert.ok(found.warnings.some((w) => w.code === 'terminal_current_ignored'));
});

test('versions compare numerically, so 0.1.100 beats 0.1.67 and a folder without server.py is ineligible', async (t) => {
  const { localAppData, root } = makeInstall(t, { terminal: ['0.1.67', '0.1.100'] });
  addTerminal(root, '0.1.200', { server: false });
  fs.mkdirSync(path.join(root, 'terminal', 'not-a-version'), { recursive: true });
  const found = await discoverStrataInstall({ localAppData });
  assert.equal(found.ok, true);
  assert.equal(found.version, '0.1.100');
  assert.equal(found.terminalDir, path.join(root, 'terminal', '0.1.100'));
});

test('a different version warns and still succeeds, for the terminal and the engine', async (t) => {
  const { localAppData, root } = makeInstall(t, { terminal: ['0.2.0'], engine: false });
  addEngine(root, '0.2.0-windows-x86_64-cuda-cuda13', { version: '0.2.0' });
  const found = await discoverStrataInstall({ localAppData });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.deepEqual(found.warnings.map((w) => w.code).sort(), ['engine_version_unpinned', 'version_unpinned']);
  const warning = found.warnings.find((w) => w.code === 'version_unpinned');
  assert.equal(warning.found, '0.2.0');
  assert.equal(warning.pinned, '0.1.67');
});

test('the VERSION file is bounded and untrusted: junk falls back to the folder name', async (t) => {
  const { localAppData, root } = makeInstall(t, { terminal: ['0.1.67'] });
  put(path.join(root, 'terminal', '0.1.67', 'VERSION'), `${'9'.repeat(5000)}\n`);
  assert.equal((await discoverStrataInstall({ localAppData })).version, '0.1.67');
  put(path.join(root, 'terminal', '0.1.67', 'VERSION'), 'not a version');
  assert.equal((await discoverStrataInstall({ localAppData })).version, '0.1.67');
  fs.rmSync(path.join(root, 'terminal', '0.1.67', 'VERSION'));
  assert.equal((await discoverStrataInstall({ localAppData })).version, '0.1.67');
});

test('no Strata folder gives not_installed, no LOCALAPPDATA gives no_localappdata', async (t) => {
  const tmp = makeTmp(t);
  const missing = await discoverStrataInstall({ localAppData: tmp });
  assert.deepEqual({ ok: missing.ok, reason: missing.reason }, { ok: false, reason: 'not_installed' });
  const none = await discoverStrataInstall({ localAppData: '' });
  assert.equal(none.reason, 'no_localappdata');
});

test('a Strata folder that is itself a link is refused', async (t) => {
  const tmp = makeTmp(t);
  const real = path.join(tmp, 'real-strata');
  fs.mkdirSync(real, { recursive: true });
  const localAppData = path.join(tmp, 'LocalAppData');
  fs.mkdirSync(localAppData, { recursive: true });
  if (!link(real, path.join(localAppData, 'Strata'))) return t.skip('no link support');
  assert.equal((await discoverStrataInstall({ localAppData })).reason, 'link_refused');
});

test('an engine version folder that is a junction to a folder outside the root is refused', async (t) => {
  const { tmp, localAppData, root } = makeInstall(t, { engine: false });
  const outside = path.join(tmp, 'outside-engine');
  put(path.join(outside, 'engine-component.json'), JSON.stringify({ id: 'strata-inkling', version: '0.1.67', platform: 'windows-x86_64', entrypoint: 'strata-inkling.exe' }));
  put(path.join(outside, 'strata-inkling.exe'));
  if (!link(outside, path.join(root, ENGINE_REL, '0.1.67-windows-x86_64-cuda-cuda13'))) return t.skip('no link support');
  const found = await discoverStrataInstall({ localAppData });
  assert.deepEqual({ ok: found.ok, reason: found.reason }, { ok: false, reason: 'no_engine' });
});

test('python reached through a junction is refused as link_refused', async (t) => {
  const { tmp, localAppData, root } = makeInstall(t, { terminal: [] });
  const dir = addTerminal(root, '0.1.67', { python: false });
  const outside = path.join(tmp, 'outside-python');
  put(path.join(outside, 'python.exe'));
  if (!link(outside, path.join(dir, 'python'))) return t.skip('no link support');
  const found = await discoverStrataInstall({ localAppData });
  assert.deepEqual({ ok: found.ok, reason: found.reason }, { ok: false, reason: 'link_refused' });
});

test('typed reasons for a missing terminal, python and engine', async (t) => {
  const noTerminal = makeInstall(t, { terminal: [] });
  assert.equal((await discoverStrataInstall({ localAppData: noTerminal.localAppData })).reason, 'no_terminal');
  const noPython = makeInstall(t, { terminal: [] });
  addTerminal(noPython.root, '0.1.67', { python: false });
  assert.equal((await discoverStrataInstall({ localAppData: noPython.localAppData })).reason, 'no_python');
  const noEngine = makeInstall(t, { engine: false });
  assert.equal((await discoverStrataInstall({ localAppData: noEngine.localAppData })).reason, 'no_engine');
});

test('the engine scan picks the highest qualifying version and skips bad manifests', async (t) => {
  const { localAppData, root } = makeInstall(t, { engine: false });
  addEngine(root, '0.1.66-windows-x86_64-cuda-cuda13', { version: '0.1.66' });
  addEngine(root, '0.1.100-windows-x86_64-cuda-cuda13', { version: '0.1.100' });
  addEngine(root, '9.9.9-wrong-id', { version: '9.9.9', id: 'other-engine' });
  addEngine(root, '8.8.8-bad-entry', { version: '8.8.8', entrypoint: '..\\evil.exe' }, { exe: false });
  addEngine(root, '7.7.7-no-exe', { version: '7.7.7' }, { exe: false });
  put(path.join(root, ENGINE_REL, '6.6.6-big', 'engine-component.json'), `{"id":"strata-inkling","pad":"${'x'.repeat(70 * 1024)}"}`);
  put(path.join(root, ENGINE_REL, '5.5.5-junk', 'engine-component.json'), '{not json');
  const found = await discoverStrataInstall({ localAppData });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.equal(found.engine.version, '0.1.100');
  assert.equal(path.basename(found.engine.dir), '0.1.100-windows-x86_64-cuda-cuda13');
});

test('realPathInside accepts the root and children, refuses outside, links and missing paths', async (t) => {
  const tmp = makeTmp(t);
  const root = path.join(tmp, 'root');
  put(path.join(root, 'a', 'file.txt'));
  put(path.join(tmp, 'outside', 'file.txt'));
  assert.deepEqual(await realPathInside(root, root), { ok: true, path: root });
  assert.equal((await realPathInside(root, path.join(root, 'a', 'file.txt'))).ok, true);
  assert.equal((await realPathInside(root, path.join(root, 'a', '..', '..', 'outside', 'file.txt'))).reason, 'outside_root');
  assert.equal((await realPathInside(root, path.join(tmp, 'rootkin'))).reason, 'outside_root');
  const missing = await realPathInside(root, path.join(root, 'a', 'nope.txt'));
  assert.deepEqual({ ok: missing.ok, reason: missing.reason }, { ok: false, reason: 'missing' });
  assert.equal((await realPathInside(root, path.join(root, 'a', 'file.txt', 'deeper'))).reason, 'missing');
  if (!link(path.join(tmp, 'outside'), path.join(root, 'jump'))) return t.skip('no link support');
  assert.equal((await realPathInside(root, path.join(root, 'jump', 'file.txt'))).reason, 'link_refused');
});

test('samePath is case-insensitive only on Windows and ignores a trailing separator', () => {
  assert.equal(samePath('C:\\Strata\\terminal', 'c:\\strata\\TERMINAL\\', 'win32'), true);
  assert.equal(samePath('/a/Strata', '/a/strata', 'linux'), false);
  assert.equal(samePath('/a/strata/', '/a/strata', 'linux'), true);
  assert.equal(samePath('/a/strata', '', 'linux'), false);
});
