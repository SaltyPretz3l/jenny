'use strict';

// Managed Strata runtime wiring (row 200 S2): flag-off and non-Windows build
// nothing, the background pack check on discovery (owner pick D6/D2 A), a plan
// that caps the context and builds a clean config, typed refusals, the vision
// pack dropped when it fails its check, and Re-verify forcing the hash.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createStrataRuntime } = require('../services/main/strata-runtime-wiring');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { makeUserDataDir } = require('./helpers/llama-server-lifecycle-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function tree() {
  const base = makeUserDataDir('strata-rt-');
  const root = path.join(base, 'Strata');
  const terminalDir = path.join(root, 'terminal', '0.1.67');
  const engineDir = path.join(root, 'components', 'shapes', 'inkling2', 'engine', '0.1.67-windows-x86_64-cuda-cuda13');
  const models = path.join(root, 'Strata-data', 'models', 'inkling-2-mini');
  const tokenizer = path.join(root, 'Strata-data', 'packs', 'inkling-2-mini-sq-20', 'tokenizer');
  for (const dir of [terminalDir, engineDir, models, tokenizer, path.join(root, 'install')]) fs.mkdirSync(dir, { recursive: true });
  for (const name of ['vocab.json', 'merges.txt', 'chat_template.jinja']) fs.writeFileSync(path.join(tokenizer, name), '{}');
  const native = path.join(models, 'Inkling-2-Mini-SQ-20.strata');
  const vision = path.join(models, 'Inkling-2-Mini-Vision.strata');
  fs.writeFileSync(native, 'native-pack');
  fs.writeFileSync(vision, 'vision');
  const exe = path.join(engineDir, 'strata-inkling.exe');
  fs.writeFileSync(exe, 'exe');
  fs.writeFileSync(path.join(root, 'install', 'strata-inkling-2-mini-sq-20.json'), JSON.stringify({
    exe: 'component:strata-inkling', args: ['--native', native, '--max-context', '32768', '--vision', vision, '--vram-experts-gb', '14.66'],
    cwd: terminalDir, tokenizer, model_name: 'inkling-2-mini-sq-20', api_key: 'secret', port: 8080,
  }));
  const install = {
    ok: true, root: fs.realpathSync(root), terminalDir, pythonExe: path.join(terminalDir, 'python', 'python.exe'), version: '0.1.67',
    componentsDir: path.join(root, 'components'), engine: { exe, dir: engineDir, version: '0.1.67', backend: 'cuda' }, warnings: [],
  };
  const family = {
    id: 'inkling-2-mini', model_name: 'inkling-2-mini-sq-20', aliases: ['inkling-2-mini'], params_b: 26.4,
    setup_config: 'strata-inkling-2-mini-sq-20.json',
    packs: {
      native: { file: 'Inkling-2-Mini-SQ-20.strata', size_bytes: 11, sha256: 'a'.repeat(64) },
      vision: { file: 'Inkling-2-Mini-Vision.strata', size_bytes: 6, sha256: 'b'.repeat(64) },
    },
    fit_table: [{ gpu_match: 'RTX 5090', min_vram_mb: 32000, windows: { '4:k8v8': 114432, '1:auto': 228352 } }],
  };
  return { base, install, family };
}

function runtimeFor(t, { verifyResult = () => ({ ok: true, sha256: 'x', fromReceipt: false }), install = t.install, gpu = { name: 'NVIDIA GeForce RTX 5090', vram_total_mb: 32607 }, learnedFits = {} } = {}) {
  const verified = [];
  const events = [];
  const runtime = createStrataRuntime({
    userDataPath: t.base,
    flags: {},
    platform: 'win32',
    getShellConfigService: () => ({ getLocalEngines: () => ({ strata: { learnedFits } }) }),
    getGpu: async () => gpu,
    deps: {
      discoverStrataInstall: async () => install,
      loadPackManifest: async () => ({ families: [t.family] }),
      verifyPack: async (pack, options) => { verified.push({ file: path.basename(pack.path), force: options.force }); return verifyResult(pack); },
    },
  });
  runtime.on('changed', (state) => events.push(state));
  return { runtime, verified, events };
}

const SETTINGS = { slots: 4, kv: 'k8v8', context: null, vision: true, drafting: 'off' };

test('flag off or a non-Windows platform builds a stub that refuses every launch', async () => {
  for (const options of [{ flags: { strata: false }, platform: 'win32' }, { flags: {}, platform: 'linux' }]) {
    const runtime = createStrataRuntime({ userDataPath: 'C:\\u', ...options });
    assert.equal(runtime.enabled, false);
    assert.deepEqual(runtime.getState(), { enabled: false });
    assert.deepEqual(await runtime.plan({ settings: SETTINGS }), { error: 'strata_flag_off' });
  }
});

test('a plan caps the context at the measured fit and builds a clean config', async () => {
  const t = tree();
  const { runtime } = runtimeFor(t);
  const phases = [];
  const plan = await runtime.plan({ settings: SETTINGS, onPhase: (phase) => phases.push(phase) });
  assert.equal(plan.error, undefined);
  assert.equal(plan.maxContext, 114432);
  assert.equal(plan.fitSource, 'measured');
  assert.equal(plan.vision, true);
  assert.equal(plan.paramsB, 26.4);
  assert.equal(plan.config.exe, t.install.engine.exe);
  assert.equal(plan.config.cwd, t.install.terminalDir);
  assert.deepEqual(Object.keys(plan.config).sort(), ['aliases', 'args', 'cwd', 'drafting', 'exe', 'log', 'model_name', 'tokenizer']);
  assert.ok(!JSON.stringify(plan.config).includes('secret'));
  assert.deepEqual(phases, ['verifying']);
  assert.deepEqual(runtime.getState().packs, { native: 'verified', vision: 'verified' });
});

test('an unmeasured GPU uses a learned fit, else Setup\'s window capped at 32k', async () => {
  const t = tree();
  const learned = await runtimeFor(t, { gpu: { name: 'RTX 4090', vram_total_mb: 24564 }, learnedFits: { '4:k8v8': 40960 } }).runtime.plan({ settings: SETTINGS });
  assert.equal(learned.maxContext, 40960);
  assert.equal(learned.fitSource, 'learned');
  const fallback = await runtimeFor(t, { gpu: null }).runtime.plan({ settings: SETTINGS });
  assert.equal(fallback.maxContext, 32768);
  assert.equal(fallback.fitSource, 'default');
});

test('a failed native pack refuses; a failed vision pack drops vision only', async () => {
  const t = tree();
  const bad = await runtimeFor(t, { verifyResult: (pack) => (pack.path.endsWith('SQ-20.strata') ? { ok: false, reason: 'sha256_mismatch' } : { ok: true }) }).runtime.plan({ settings: SETTINGS });
  assert.deepEqual(bad, { error: 'strata_pack:sha256_mismatch' });
  const { runtime } = runtimeFor(t, { verifyResult: (pack) => (pack.path.endsWith('Vision.strata') ? { ok: false, reason: 'sha256_mismatch' } : { ok: true }) });
  const noVision = await runtime.plan({ settings: SETTINGS });
  assert.equal(noVision.vision, false);
  assert.equal(noVision.config.args.includes('--vision'), false);
  assert.deepEqual(runtime.getState().packs, { native: 'verified', vision: 'failed' });
});

test('a missing install or Setup config is a typed refusal with no hashing', async () => {
  const t = tree();
  const missing = runtimeFor(t, { install: { ok: false, reason: 'not_installed' } });
  assert.deepEqual(await missing.runtime.plan({ settings: SETTINGS }), { error: 'strata_not_installed:not_installed' });
  assert.equal(missing.runtime.getState().install.reason, 'not_installed');
  assert.deepEqual(missing.verified, []);
  fs.rmSync(path.join(t.install.root, 'install', 'strata-inkling-2-mini-sq-20.json'));
  const noSetup = runtimeFor(t);
  assert.deepEqual(await noSetup.runtime.plan({ settings: SETTINGS }), { error: 'strata_setup_config:no_setup_config' });
  assert.equal(noSetup.runtime.getState().setup.reason, 'no_setup_config');
  assert.deepEqual(noSetup.verified, []);
});

test('start() checks both packs in the background as soon as Strata is found (D2 A)', async () => {
  const t = tree();
  const { runtime, verified, events } = runtimeFor(t);
  runtime.start();
  for (let i = 0; i < 50 && runtime.getState().packs.native !== 'verified'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(verified.map((entry) => entry.file).sort(), ['Inkling-2-Mini-SQ-20.strata', 'Inkling-2-Mini-Vision.strata']);
  assert.ok(events.some((state) => state.packs.native === 'checking'));
  assert.equal(events.at(-1).packs.native, 'verified');
  assert.equal(JSON.stringify(events).includes(t.install.root), false, 'the state carries no paths');
  assert.deepEqual(events.at(-1).model, { id: 'inkling-2-mini-sq-20', displayName: 'Inkling 2 Mini', aliases: ['inkling-2-mini'], paramsB: 26.4 });
});

test('reverify forces the hash past the receipts', async () => {
  const t = tree();
  const { runtime, verified } = runtimeFor(t);
  assert.deepEqual(await runtime.reverify(), { ok: true, reason: '' });
  assert.ok(verified.length === 2 && verified.every((entry) => entry.force === true));
});

test('attachStrataRuntime sets the runtime, forwards changes to the bridge, and defers the background check', () => {
  const { attachStrataRuntime } = require('../services/main/strata-runtime-wiring');
  const events = [];
  const timers = [];
  const backend = {};
  const runtime = attachStrataRuntime(backend, {
    userDataPath: 'C:\\u', flags: {}, platform: 'win32',
    sendBridgeEvent: (channel, payload) => events.push({ channel, payload }),
    setTimeoutImpl: (fn, ms) => { timers.push(ms); return { unref() {} }; },
  });
  assert.equal(backend.strataRuntime, runtime);
  assert.deepEqual(timers, [15_000]);
  runtime.emit('changed', { enabled: true, packs: { native: 'checking' } });
  assert.deepEqual(events, [{ channel: 'strata.onChanged', payload: { source: 'runtime', enabled: true, packs: { native: 'checking' } } }]);
  // A progress tick still reaches renderers but leaves the model-list cache alone; a pack state change clears it.
  backend._modelListLastResult = 'cached';
  runtime.emit('changed', { enabled: true, packs: { native: 'checking' }, progress: { native: { done: 5, total: 11 } } });
  assert.equal(backend._modelListLastResult, 'cached');
  assert.equal(events.length, 2);
  runtime.emit('changed', { enabled: true, packs: { native: 'verified' } });
  assert.equal(backend._modelListLastResult, null);
  const off = attachStrataRuntime({}, { flags: { strata: false }, platform: 'win32', setTimeoutImpl: (fn, ms) => { timers.push(ms); return {}; } });
  assert.equal(off.enabled, false);
  assert.deepEqual(timers, [15_000], 'flag off starts nothing');
});

test('every strata.* event main emits resolves to a subscribe channel (the real sendBridgeEvent throws on an unknown path)', () => {
  const { getBridgeChannel } = require('../services/ipc-contract');
  const emitters = ['services/main/strata-runtime-wiring.js', 'services/main/runtime-shutdown.js'];
  const paths = new Set();
  for (const rel of emitters) {
    const source = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const match of source.matchAll(/sendBridgeEvent\('(strata\.[A-Za-z]+)'/g)) paths.add(match[1]);
  }
  assert.ok(paths.has('strata.onChanged'), JSON.stringify([...paths]));
  for (const methodPath of paths) assert.equal(typeof getBridgeChannel(methodPath, 'subscribe'), 'string', methodPath);
});

test('an unusable tokenizer reads as an incomplete setup, never as a pack check, and hashes nothing', async () => {
  const t = tree();
  const setupFile = path.join(t.install.root, 'install', 'strata-inkling-2-mini-sq-20.json');
  const setup = JSON.parse(fs.readFileSync(setupFile, 'utf8'));
  fs.writeFileSync(setupFile, JSON.stringify({ ...setup, tokenizer: path.join(t.install.root, 'Strata-data', 'no-tokenizer') }));
  const { runtime, verified } = runtimeFor(t);
  const plan = await runtime.plan({ settings: SETTINGS });
  assert.match(plan.error, /^strata_tokenizer:/);
  assert.deepEqual(runtime.getState().setup, { found: false, reason: 'tokenizer_unusable' });
  assert.deepEqual(verified, []);
});

test('the manifest is read once per process; a failed GPU probe is asked again', async () => {
  const t = tree();
  let manifests = 0;
  const runtime = createStrataRuntime({
    userDataPath: t.base, platform: 'win32', getGpu: async () => null,
    deps: { discoverStrataInstall: async () => t.install, loadPackManifest: async () => { manifests += 1; return { families: [t.family] }; }, verifyPack: async () => ({ ok: true }) },
  });
  await runtime.plan({ settings: SETTINGS });
  await runtime.uiFacts();
  await runtime.plan({ settings: SETTINGS });
  assert.equal(manifests, 1);
  const { createGpuProbe } = require('../services/main/strata-runtime-wiring');
  let spawns = 0;
  const probe = createGpuProbe({ platform: 'win32', execFileImpl: (cmd, args, opts, done) => { spawns += 1; done(spawns === 1 ? new Error('timeout') : null, 'NVIDIA GeForce RTX 5090, 32607'); } });
  assert.equal(await probe(), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await probe(), { name: 'NVIDIA GeForce RTX 5090', vram_total_mb: 32607 });
  assert.equal(spawns, 2);
  await probe();
  assert.equal(spawns, 2, 'a good answer is kept');
});

test('a pack check exposes throttled byte progress and clears it when done', async () => {
  const t = tree();
  let clock = 0;
  const events = [];
  const runtime = createStrataRuntime({
    userDataPath: t.base, flags: {}, platform: 'win32', now: () => clock, getGpu: async () => null,
    getShellConfigService: () => ({ getLocalEngines: () => ({ strata: {} }) }),
    deps: {
      discoverStrataInstall: async () => t.install,
      loadPackManifest: async () => ({ families: [t.family] }),
      verifyPack: async (pack, options) => {
        if (pack.size_bytes === 11) {
          options.onProgress(3); // inside the throttle window: no event
          clock += 1000;
          options.onProgress(7); // emitted
          clock += 10;
          options.onProgress(99); // clamped to the size, not emitted
          assert.deepEqual(runtime.getState().progress.native, { done: 11, total: 11 });
        }
        return { ok: true, sha256: 'x', fromReceipt: false };
      },
    },
  });
  runtime.on('changed', (state) => events.push(state));
  assert.deepEqual((await runtime.reverify()).ok, true);
  const progressed = events.filter((state) => state.progress.native && state.progress.native.done > 0);
  // The throttle drops the update inside its window; later events (the vision check's own) carry the latest count.
  assert.deepEqual(progressed[0].progress.native, { done: 7, total: 11 });
  assert.equal(progressed.some((state) => state.progress.native.done === 3), false);
  assert.ok(events.some((state) => state.packs.native === 'checking' && state.progress.native?.done === 0));
  assert.deepEqual(runtime.getState().progress, { native: null, vision: null });
  assert.equal(runtime.getState().packs.native, 'verified');
});
