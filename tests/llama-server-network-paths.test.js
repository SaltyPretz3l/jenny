'use strict';

// Network and device paths in llama-server settings. On Windows a stat,
// readdir or open of \\host\share\... connects to that host and sends the
// user's credentials, so main never touches such a path on the renderer's
// word: saved settings (lastPickDir, libraryRoots, a model's modelPath), the
// IPC launch spec, the GGUF listing and the three pickers take drive paths
// only, and a saved runtime's shape is checked before its launch-time stat. A
// share mapped to a drive letter is a drive path. The fs double checks every
// argument of the calls main makes and refuses a network path without running
// it (the real call would contact the host); any other fs member it records as
// unchecked.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { getBridgeChannel } = require('../services/ipc-contract');
const {
  isLocalAbsolutePath,
  isManagedModelPath,
  normalizeManagedLlamaServer,
} = require('../services/shell-config-engines');
const { registerLlamaServerIpcHandlers } = require('../services/main/llama-server-ipc-handlers');
const { createRuntimePickRegistry, resolveLaunchRuntime } = require('../services/main/llama-server-runtime');
const { ShellConfigService } = require('../services/shell-config-service');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const engineUtils = require('../renderer/shell/renderer-model-tuning-engine-utils');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const WIN32 = process.platform === 'win32';
const HOST = 'attacker.example';
// Every Windows spelling of another machine (or of a device) a renderer can send.
const NETWORK_DIRS = Object.freeze([
  '\\\\attacker.example\\share\\models',
  '//attacker.example/share/models',
  '\\/attacker.example/share/models',
  '/\\attacker.example\\share\\models',
  '\\\\attacker.example@SSL@443\\DavWWWRoot\\models',
  '\\\\?\\UNC\\attacker.example\\share\\models',
  '\\\\.\\UNC\\attacker.example\\share\\models',
  '\\\\?\\GLOBALROOT\\Device\\Mup\\attacker.example\\share\\models',
  '\\\\.\\pipe\\attacker.example',
  '\\\\?\\C:\\models',
  '\\attacker.example\\models',
]);
const BLOB = `sha256-${'a'.repeat(64)}`;
const NETWORK_BLOB = `\\\\attacker.example\\share\\ollama\\blobs\\${BLOB}`;
const NETWORK_TEXT = "Jenny can't use network locations here. Map the share to a drive letter, then choose it from that drive.";
const LOCAL_DIR = WIN32 ? 'G:\\llmmodels\\gguf' : '/models/gguf';
const gguf = (dir) => `${dir}\\Bonsai.gguf`;
// What this host's normalizer must drop: every spelling on Windows. On Linux
// and macOS a leading slash is the local root (a leading // is just /), and a
// leading backslash is a relative path.
const droppedHere = (value) => WIN32 || !value.startsWith('/');

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(dir);
  return dir;
}

// The only fs calls main makes on these paths. Reading any other member
// (fs.promises included) is recorded, so a new call cannot slip past the check.
const CHECKED_FS_CALLS = new Set(['lstatSync', 'readdirSync', 'statSync']);

function networkFsSpy() {
  const touched = [];
  const pathText = (arg) => {
    if (typeof arg === 'string') return arg;
    // A file: URL with a host names that host whatever the fixture calls it.
    if (arg instanceof URL) return arg.hostname ? `//${arg.hostname}${arg.pathname}` : arg.pathname;
    return ArrayBuffer.isView(arg) ? Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength).toString('utf8') : '';
  };
  const isNetwork = (target) => /^[\\/]{2}/.test(target) || /^\\(?![\\/])/.test(target) || target.includes(HOST);
  const fsImpl = new Proxy({}, {
    get(_target, name) {
      if (typeof name === 'symbol') return undefined;
      if (!CHECKED_FS_CALLS.has(name)) {
        touched.push(`unchecked fs.${name}`);
        throw new Error(`fs.${name} is not checked by this double`);
      }
      return (...args) => {
        const network = args.map(pathText).find(isNetwork);
        if (network !== undefined) {
          touched.push(`${name} ${network}`);
          throw Object.assign(new Error('a network path reached the fs'), { code: 'ENOENT' });
        }
        return fs[name](...args);
      };
    },
  });
  return { fsImpl, touched };
}

function register(options = {}) {
  const handlers = new Map();
  registerLlamaServerIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    getManager: () => ({ runtimePicks: createRuntimePickRegistry() }),
    getMainWindow: () => 'main-window',
    dialogImpl: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    authorization: { authorize: () => true, unauthorizedResult: () => ({ ok: false, authorized: false }) },
    platform: 'win32',
    ...options,
  });
  return (name, payload) => handlers.get(getBridgeChannel(name, 'invoke'))({}, payload);
}

test('only a drive path is local on Windows, and a mapped share keeps working through its letter', () => {
  for (const value of ['C:\\models', 'c:/models/Bonsai.gguf', 'Z:\\', 'Z:\\nas-share\\Bonsai.gguf']) {
    assert.equal(isLocalAbsolutePath(value, { platform: 'win32' }), true, value);
  }
  for (const value of [...NETWORK_DIRS, '/models', 'C:models', 'models\\x', '', null, 42, 'C:\\models\nD:\\', 'C:\\m\0']) {
    assert.equal(isLocalAbsolutePath(value, { platform: 'win32' }), false, String(value));
  }
  for (const value of ['/models', '//attacker.example/share/models']) {
    assert.equal(isLocalAbsolutePath(value, { platform: 'linux' }), true, value);
  }
  for (const value of ['models/x', 'C:\\models', '\\\\attacker.example\\share', '', '/models\n', undefined]) {
    assert.equal(isLocalAbsolutePath(value, { platform: 'linux' }), false, String(value));
  }
  assert.equal(isManagedModelPath('C:\\gguf\\Bonsai.gguf', { platform: 'win32' }), true);
  assert.equal(isManagedModelPath(`C:\\ollama\\blobs\\${BLOB}`, { platform: 'win32' }), true);
  for (const dir of NETWORK_DIRS) {
    assert.equal(isManagedModelPath(gguf(dir), { platform: 'win32' }), false, dir);
    assert.equal(isManagedModelPath(`${dir}\\${BLOB}`, { platform: 'win32' }), false, dir);
  }
});

test('saved settings drop every network path in lastPickDir, libraryRoots and modelPath', () => {
  const network = NETWORK_DIRS.filter(droppedHere);
  for (const lastPickDir of network) {
    assert.equal(normalizeManagedLlamaServer({ lastPickDir }).lastPickDir, '', lastPickDir);
  }
  assert.equal(normalizeManagedLlamaServer({ lastPickDir: LOCAL_DIR }).lastPickDir, LOCAL_DIR);
  const managed = normalizeManagedLlamaServer({
    libraryRoots: [...network, LOCAL_DIR],
    perModel: Object.fromEntries(network.map((dir, index) => [`net-${index}`, {
      engine: 'llama-server', tag: `net-${index}`, modelPath: gguf(dir),
    }]).concat([['net-blob', { engine: 'llama-server', tag: 'net-blob', modelPath: NETWORK_BLOB }]])),
  });
  assert.deepEqual(managed.libraryRoots, [LOCAL_DIR]);
  assert.equal(Object.keys(managed.perModel).length, network.length + 1);
  for (const [key, entry] of Object.entries(managed.perModel)) assert.equal(entry.modelPath, '', key);
});

test('engines.updateSettings saves no network path, and a config saved earlier loses them on load', () => {
  const network = NETWORK_DIRS.filter(droppedHere);
  const patch = {
    enabled: true,
    lastPickDir: network[0],
    libraryRoots: [...network, LOCAL_DIR],
    perModel: { bonsai: { engine: 'llama-server', tag: 'bonsai', modelPath: gguf(network[0]) } },
  };
  const userDataPath = tempDir('jenny-network-settings-');
  const service = new ShellConfigService({ userDataPath, env: {} });
  const handlers = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle(channel, handler) { handlers.set(channel, handler); } },
    backendService: { options: { getLlamaServerManager: () => ({ runtimePicks: createRuntimePickRegistry() }) } },
    shellConfigService: service,
    processRef: { env: { JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '1' } },
    log: () => {},
  });
  handlers.get('engines:update-settings')({}, { managed: patch });
  const written = service.getLocalEngines().openaiCompatible.managed;
  assert.equal(written.lastPickDir, '');
  assert.deepEqual(written.libraryRoots, [LOCAL_DIR]);
  assert.equal(written.perModel.bonsai.modelPath, '');
  assert.equal(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8').includes(HOST), false);

  const seededPath = tempDir('jenny-network-seeded-');
  fs.writeFileSync(path.join(seededPath, 'shell-config.json'),
    JSON.stringify({ localEngines: { openaiCompatible: { managed: patch } } }));
  const seeded = new ShellConfigService({ userDataPath: seededPath, env: {} }).getLocalEngines().openaiCompatible.managed;
  assert.equal(seeded.lastPickDir, '');
  assert.deepEqual(seeded.libraryRoots, [LOCAL_DIR]);
  assert.equal(seeded.perModel.bonsai.modelPath, '');
});

test('an IPC launch spec never hands the manager a network model path', async () => {
  const specs = [];
  const manager = {
    getStatus: () => ({ state: 'ready' }),
    start: async (spec) => { specs.push(['start', spec]); return { state: 'ready' }; },
    restart: async (spec) => { specs.push(['restart', spec]); return { state: 'ready' }; },
  };
  const invoke = register({ getManager: () => manager });
  const modelPaths = NETWORK_DIRS.map(gguf).concat([NETWORK_BLOB]);
  for (const modelPath of modelPaths) {
    await invoke('llamaServer.start', { modelTag: 'bonsai', modelPath });
    await invoke('llamaServer.restart', { modelTag: 'bonsai', modelPath });
  }
  assert.deepEqual(specs, modelPaths.flatMap(() => [['start', { modelTag: 'bonsai' }], ['restart', { modelTag: 'bonsai' }]]));
  await invoke('llamaServer.start', { modelTag: 'bonsai', modelPath: 'G:\\gguf\\Bonsai.gguf' });
  assert.deepEqual(specs.at(-1), ['start', { modelTag: 'bonsai', modelPath: 'G:\\gguf\\Bonsai.gguf' }]);
});

test('listLocalGgufs never reads a network library root, persisted model or Ollama blob', async () => {
  const userDataPath = tempDir('jenny-network-list-');
  fs.mkdirSync(path.join(userDataPath, 'models', 'local-model'), { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'models', 'local-model', 'local-model-Q4_K_M.gguf'), 'gguf');
  const { fsImpl, touched } = networkFsSpy();
  const invoke = register({
    fsImpl,
    userDataPath,
    repoRoot: userDataPath,
    getLibraryRoots: () => NETWORK_DIRS,
    getPersistedModels: () => NETWORK_DIRS.map((dir, index) => ({ tag: `net-${index}`, modelPath: gguf(dir) }))
      .concat([{ tag: 'net-blob', modelPath: NETWORK_BLOB }]),
    getOllamaTags: async () => ['net-ollama:latest'],
    getOllamaBlob: async () => ({ blobPath: NETWORK_BLOB, mmprojPath: '' }),
  });
  const result = await invoke('llamaServer.listLocalGgufs');
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(touched, []);
  assert.deepEqual(result.entries.map((entry) => entry.tag), ['local-model']);
});

test('the three pickers refuse a network pick before any fs call or probe', async () => {
  const { fsImpl, touched } = networkFsSpy();
  const manager = { runtimePicks: createRuntimePickRegistry() };
  const validated = [];
  let pick = '';
  const invoke = register({
    fsImpl,
    getManager: () => manager,
    dialogImpl: { showOpenDialog: async () => ({ canceled: false, filePaths: [pick] }) },
    validateRuntimeExecutableImpl: async (candidate) => {
      validated.push(candidate);
      return { ok: true, build: 10683, supportsMtp: false };
    },
  });
  for (const dir of NETWORK_DIRS) {
    pick = gguf(dir);
    assert.deepEqual(await invoke('llamaServer.chooseGguf', {}), { ok: false, reason: 'network_path' }, pick);
    pick = dir;
    assert.deepEqual(await invoke('llamaServer.chooseLibraryFolder'), { ok: false, reason: 'network_path' }, pick);
    pick = `${dir}\\llama-server.exe`;
    assert.deepEqual(await invoke('llamaServer.chooseRuntime', {}), { ok: false, reason: 'network_path' }, pick);
  }
  assert.deepEqual(touched, []);
  assert.deepEqual(validated, []);
  assert.equal(manager.runtimePicks.size(), 0);
  pick = 'Z:\\nas-share\\gguf';
  assert.deepEqual(await invoke('llamaServer.chooseLibraryFolder'), { ok: true, picked: true, path: pick });
});

test('a saved runtime on a network path fails the launch without a stat', () => {
  const { fsImpl, touched } = networkFsSpy();
  for (const dir of NETWORK_DIRS) {
    const runtime = resolveLaunchRuntime({ runtimePath: `${dir}\\llama-server.exe`, fsImpl, platform: 'win32' });
    assert.equal(runtime.binaryPath, '', dir);
    assert.match(runtime.error, /^llama_server_runtime_missing:/, dir);
  }
  assert.deepEqual(touched, []);
});

test('the Tune drawer and Add GGUF model… say how to use a network location', () => {
  assert.equal(engineUtils.pickerFailureText({ ok: false, reason: 'network_path' }), NETWORK_TEXT);
  assert.equal(engineUtils.runtimePickerFailureText({ ok: false, reason: 'network_path' }), NETWORK_TEXT);
});
