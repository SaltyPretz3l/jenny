'use strict';

// Builds the managed Strata runtime (row 200 S2) for backend-service-wiring.js:
// discovery of the owner's install, the pinned pack check and the engine config,
// bundled as `backendService.strataRuntime` so the manager
// (services/main/strata-manager.js), the IPC surface and the load path read one
// object. Flag-off (JENNY_ENABLE_STRATA=0) builds nothing that could probe the
// GPU or touch disk; the stub refuses every launch.
//
// Owner pick D6/D2 A (2026-11-24): the packs are checked in the background as
// soon as Strata is found, so the first Load is not slowed; the check is one
// streamed hash per pack in a worker thread, then a receipt (strata-config.js).

const { EventEmitter } = require('events');
const { execFile } = require('child_process');

const { discoverStrataInstall } = require('../strata-install');
const {
  buildStrataConfig, checkTokenizerDir, findPacks, loadPackManifest, readSetupConfig, resolveMaxContext, verifyPack,
} = require('../strata-config');
const { STRATA_KV_FORMATS, STRATA_SLOTS } = require('../strata-settings');

const PACK_STATES = Object.freeze(['unknown', 'checking', 'verified', 'failed', 'missing']);
// A pack check's byte progress reaches renderers at most this often.
const PROGRESS_EMIT_MS = 1_000;

function planError(error) {
  return { error };
}

// The first NVIDIA GPU's name and total memory, once per process.
function createGpuProbe({ platform = process.platform, execFileImpl = execFile } = {}) {
  let pending = null;
  return () => {
    if (!pending) {
      pending = new Promise((resolve) => {
        if (platform !== 'win32') { resolve(null); return; }
        execFileImpl('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
          windowsHide: true, timeout: 5_000, encoding: 'utf8',
        }, (error, stdout) => {
          if (error) { resolve(null); return; }
          const [name, total] = String(stdout || '').split(/\r?\n/)[0].split(',').map((part) => part.trim());
          const vram = Number(total);
          resolve(name && Number.isFinite(vram) ? { name, vram_total_mb: vram } : null);
        });
      });
      // A failed read (a timeout at a busy boot) is asked again next time rather than kept for the process.
      pending.then((gpu) => { if (!gpu) pending = null; });
    }
    return pending;
  };
}

function setupMaxContextOf(setupConfig) {
  const args = Array.isArray(setupConfig?.args) ? setupConfig.args : [];
  const at = args.indexOf('--max-context');
  const value = at >= 0 ? Number(args[at + 1]) : NaN;
  return Number.isInteger(value) && value >= 1024 ? value : null;
}

function disabledRuntime(runtime) {
  return Object.assign(runtime, {
    start: () => {},
    plan: async () => planError('strata_flag_off'),
    reverify: async () => ({ ok: false, reason: 'strata_flag_off' }),
    uiFacts: async () => ({ pins: null, fits: {} }),
    getState: () => ({ enabled: false }),
    dispose: () => {},
  });
}

function createStrataRuntime({
  userDataPath,
  flags = {},
  platform = process.platform,
  getShellConfigService = () => null,
  log = () => {},
  getGpu = null,
  deps = {},
  now = Date.now,
} = {}) {
  const runtime = new EventEmitter();
  runtime.enabled = flags?.strata !== false && platform === 'win32';
  if (!runtime.enabled) return disabledRuntime(runtime);
  const discover = deps.discoverStrataInstall || discoverStrataInstall;
  const readManifest = deps.loadPackManifest || loadPackManifest;
  // The pinned manifest never changes within a process: read it once (a failed read is retried next time).
  let manifestPromise = null;
  const loadManifest = () => {
    if (!manifestPromise) manifestPromise = Promise.resolve().then(readManifest).catch((error) => { manifestPromise = null; throw error; });
    return manifestPromise;
  };
  const verify = deps.verifyPack || verifyPack;
  const gpuProbe = getGpu || createGpuProbe({ platform });
  const resolveUserData = () => String((typeof userDataPath === 'function' ? userDataPath() : userDataPath) || '');
  const state = {
    install: { found: false, reason: 'unknown', version: '', warnings: [] },
    setup: { found: false, reason: 'unknown' },
    packs: { native: 'unknown', vision: 'unknown' },
    // { done, total } bytes while a pack is hashed; null otherwise.
    progress: { native: null, vision: null },
    model: null,
  };
  let disposed = false;

  function getState() {
    return {
      enabled: true, install: { ...state.install, warnings: [...state.install.warnings] }, setup: { ...state.setup }, packs: { ...state.packs },
      progress: { native: state.progress.native && { ...state.progress.native }, vision: state.progress.vision && { ...state.progress.vision } },
      model: state.model ? { ...state.model, aliases: [...state.model.aliases] } : null,
    };
  }

  function changed() {
    if (!disposed) runtime.emit('changed', getState());
  }

  function setPack(name, value) {
    if (!PACK_STATES.includes(value) || state.packs[name] === value) return;
    state.packs[name] = value;
    changed();
  }

  function learnedFits() {
    try {
      const fits = getShellConfigService()?.getLocalEngines?.()?.strata?.learnedFits;
      return fits && typeof fits === 'object' && !Array.isArray(fits) ? fits : {};
    } catch (_error) {
      return {};
    }
  }

  // Install, manifest, Setup's config, packs and tokenizer; no hashing.
  async function locate() {
    const install = await discover();
    state.install = install.ok
      ? { found: true, reason: '', version: install.version, warnings: install.warnings.map((warning) => warning.code) }
      : { found: false, reason: install.reason, version: '', warnings: [] };
    if (!install.ok) {
      state.packs = { native: 'unknown', vision: 'unknown' };
      return planError(`strata_not_installed:${install.reason}`);
    }
    const manifest = await loadManifest();
    const family = manifest.families[0];
    state.model = {
      id: String(family.model_name || ''), displayName: 'Inkling 2 Mini',
      aliases: Array.isArray(family.aliases) ? family.aliases.map(String) : [], paramsB: Number(family.params_b) || 0,
    };
    const setup = await readSetupConfig(install, family);
    state.setup = setup.ok ? { found: true, reason: '' } : { found: false, reason: setup.reason };
    if (!setup.ok) return planError(`strata_setup_config:${setup.reason}`);
    const packs = await findPacks(install, family, setup.config);
    if (!packs.ok) {
      state.packs.native = 'missing';
      return planError(`strata_pack:${packs.reason}`);
    }
    if (!packs.vision) state.packs.vision = 'missing';
    const tokenizer = await checkTokenizerDir(install, setup.config.tokenizer);
    if (!tokenizer.ok) {
      // The tokenizer belongs to Setup's files: the Models page then reads an incomplete setup, never "checking".
      state.setup = { found: false, reason: 'tokenizer_unusable' };
      return planError(`strata_tokenizer:${tokenizer.reason}`);
    }
    return { install, family, setupConfig: setup.config, packs, tokenizer: tokenizer.path };
  }

  async function verifyOne(name, pack, force) {
    if (!pack) return null;
    const total = Number(pack.size_bytes) || 0;
    state.progress[name] = { done: 0, total };
    setPack(name, 'checking');
    let emittedAt = now();
    const onProgress = (done) => {
      state.progress[name] = { done: Math.min(Math.max(Number(done) || 0, 0), total), total };
      if (now() - emittedAt >= PROGRESS_EMIT_MS) { emittedAt = now(); changed(); }
    };
    const result = await verify(pack, { userDataPath: resolveUserData(), force, onProgress });
    state.progress[name] = null;
    setPack(name, result.ok ? 'verified' : 'failed');
    if (!result.ok) log('WARN', 'strata.runtime.pack_check_failed', { pack: name, reason: result.reason });
    return result;
  }

  async function verifyPacks(located, force = false) {
    // One after the other, native first: two 20 GB and 0.6 GB reads interleaved would slow both on one disk.
    const native = await verifyOne('native', located.packs.native, force);
    const vision = await verifyOne('vision', located.packs.vision, force);
    return { native, vision };
  }

  // D2 A: discovery and the pack check at startup, in the background.
  function start() {
    void (async () => {
      try {
        const located = await locate();
        changed();
        if (!located.error) await verifyPacks(located);
      } catch (error) {
        log('WARN', 'strata.runtime.background_check_failed', { message: String(error?.message || error).slice(0, 200) });
      }
    })();
  }

  async function plan({ settings, abortSignal = null, onPhase = () => {} } = {}) {
    try {
      const located = await locate();
      changed();
      if (located.error) return located;
      if (abortSignal && abortSignal.aborted) return planError('readiness_aborted');
      onPhase('verifying');
      const checked = await verifyPacks(located);
      if (!checked.native || !checked.native.ok) return planError(`strata_pack:${checked.native?.reason || 'hash_failed'}`);
      const packs = { ...located.packs, vision: checked.vision && checked.vision.ok ? located.packs.vision : null };
      if (abortSignal && abortSignal.aborted) return planError('readiness_aborted');
      const fit = resolveMaxContext({
        family: located.family, settings, gpu: await gpuProbe(), learnedFits: learnedFits(), setupMaxContext: setupMaxContextOf(located.setupConfig),
      });
      const built = buildStrataConfig({
        install: located.install, family: located.family, setupConfig: located.setupConfig, packs, settings,
        maxContext: fit.maxContext, userDataPath: resolveUserData(), tokenizer: located.tokenizer,
      });
      if (!built.ok) return planError(`strata_config:${built.reason}`);
      for (const warning of built.warnings) log('INFO', 'strata.runtime.config_warning', { code: warning.code });
      return {
        install: located.install,
        config: built.config,
        slots: settings.slots,
        kv: settings.kv,
        vision: built.config.args.includes('--vision'),
        drafting: built.config.drafting,
        maxContext: fit.maxContext,
        fit: fit.fit,
        fitSource: fit.source,
        modelId: located.family.model_name,
        displayName: 'Inkling 2 Mini',
        version: located.install.version,
        paramsB: located.family.params_b,
      };
    } catch (error) {
      log('WARN', 'strata.runtime.plan_failed', { message: String(error?.message || error).slice(0, 200) });
      return planError(String(error?.code || 'strata_plan_failed'));
    }
  }

  // The "Re-verify" action: hash both packs again, ignoring the receipts.
  async function reverify() {
    const located = await locate();
    changed();
    if (located.error) return { ok: false, reason: located.error };
    const checked = await verifyPacks(located, true);
    return { ok: Boolean(checked.native && checked.native.ok), reason: checked.native?.ok ? '' : `strata_pack:${checked.native?.reason || 'hash_failed'}` };
  }

  // What the Models page and Tune drawer show before a start (D6): the pinned versions, and the window each
  // slots x KV pairing gives on this card. Main computes fits; the renderer never does. tokens null: not
  // measured or learned here yet (the first start at that pairing keeps what Strata reports).
  async function uiFacts() {
    const manifest = await loadManifest();
    const family = manifest.families[0];
    const pins = { release: String(manifest.strata_release).replace(/^v/u, ''), terminal: manifest.terminal_version, engine: manifest.engine_version };
    // No install found yet: no fits, and no nvidia-smi spawn for a user without Strata.
    if (state.install.found !== true) return { pins, fits: {} };
    const gpu = await gpuProbe();
    const learned = learnedFits();
    const fits = {};
    for (const slots of STRATA_SLOTS) {
      for (const kv of STRATA_KV_FORMATS) {
        const fit = resolveMaxContext({ family, settings: { slots, kv, context: null }, gpu, learnedFits: learned });
        fits[`${slots}:${kv}`] = { tokens: fit.source === 'default' ? null : fit.fit, source: fit.source };
      }
    }
    return { pins, fits };
  }

  return Object.assign(runtime, {
    start,
    plan,
    reverify,
    uiFacts,
    getState,
    dispose: () => {
      disposed = true;
      runtime.removeAllListeners();
    },
  });
}

// Attaches `backendService.strataRuntime` for backend-service-wiring.js:
// renderers refetch strata.getState() on any change (it also changes the model
// list), and (owner pick D6/D2 A) the background pack check starts once boot
// settles, so it never competes with startup.
const BACKGROUND_CHECK_DELAY_MS = 15_000;

function attachStrataRuntime(backendService, { sendBridgeEvent = () => {}, setTimeoutImpl = setTimeout, ...options } = {}) {
  const runtime = createStrataRuntime(options);
  backendService.strataRuntime = runtime;
  let listedKey = '';
  runtime.on('changed', (state) => {
    // The model list reads install, setup, packs and model only: a progress tick leaves its cache alone.
    const key = JSON.stringify([state.install, state.setup, state.packs, state.model]);
    if (key !== listedKey) {
      listedKey = key;
      require('../backend/backend-model-list').clearModelListCaches(backendService);
    }
    sendBridgeEvent('strata.onChanged', { source: 'runtime', ...state });
  });
  if (runtime.enabled) setTimeoutImpl(() => runtime.start(), BACKGROUND_CHECK_DELAY_MS).unref?.();
  return runtime;
}

module.exports = { attachStrataRuntime, createGpuProbe, createStrataRuntime };
