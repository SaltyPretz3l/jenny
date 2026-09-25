'use strict';

// Per-model llama-server builds inside the manager: the build is resolved once
// per launch and feeds both the spawn and the acceleration probe; a missing
// saved build fails loudly; a build change relaunches the model it belongs to;
// a restart without a spec relaunches with the model's CURRENT saved settings.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLlamaServerManager, normalizeSpec } = require('../services/main/llama-server-manager');
const { resolveLlamaServerSettings } = require('../services/backend/backend-config');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const TAG = 'ternary-bonsai-2-27b-pq2_0';
const KEY = 'ternary-bonsai-2-27b-pq2-0';
const BUNDLED = path.join(os.tmpdir(), 'jenny-bundled-never-created', EXE);

function makeRuntimes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-manager-runtime-'));
  trackDirectory(root);
  const make = (folder) => {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
    const file = path.join(root, folder, EXE);
    fs.writeFileSync(file, '');
    return file;
  };
  return {
    fork: make('llama-prism-b10683-cuda13.3'),
    other: make('llama-b10800'),
    missing: path.join(root, 'llama-renamed-away', EXE),
    model: path.join(root, 'models', 'Ternary-Bonsai-2-27B-PQ2_0.gguf'),
    model2: path.join(root, 'models2', 'Ternary-Bonsai-2-27B-PQ2_0.gguf'),
  };
}

const MTP_ACCEL = { mode: 'mtp', reason: 'mtp', extraArgs: ['--spec-type', 'draft-mtp'], drafter: '', vramHeadroomMb: 0 };

function makeHarness({
  managed = { enabled: true, perModel: {} },
  settings = {},
  // The real env/persisted-config resolution instead of the fixed fake below.
  realSettings = false,
  env = {},
  accel = null,
  acceleration = null,
  // Called before each spawn with (options, callIndex); may throw to fail it.
  onStart = null,
} = {}) {
  const launches = [];
  const logs = [];
  const resolverCalls = [];
  let nextPid = 500;
  const state = { managed };
  const lifecycle = {
    reuseNext: false,
    lastHandle: null,
    async startLlamaServer(options) {
      launches.push(options);
      if (onStart) onStart(options, launches.length - 1);
      const pid = nextPid++;
      const reused = lifecycle.reuseNext;
      lifecycle.reuseNext = false;
      lifecycle.lastHandle = {
        pid: reused ? 0 : pid,
        baseUrl: `http://127.0.0.1:${options.port}/v1`,
        reused,
        mmproj: '',
        apiKey: reused ? '' : `key-${pid}`,
        onExit: options.onExit,
        async stop() { return { confirmed: true }; },
        stopSync() {},
      };
      return lifecycle.lastHandle;
    },
    resolveBinaryPath: () => BUNDLED,
    resolveGgufPath: () => ({ path: '', projectorPath: '' }),
    resolveProjectorPath: () => '',
    sweepStaleApiKeyFiles() {},
  };
  const manager = createLlamaServerManager({
    processRef: { env: { ...env }, resourcesPath: '' },
    rootDir: os.tmpdir(),
    userDataPath: os.tmpdir(),
    getShellConfigService: () => ({
      getLocalEngines: () => ({ openaiCompatible: { port: 8033, apiUrl: '', acceleration, managed: state.managed } }),
      getState: () => ({ featureOverrides: {} }),
    }),
    log: (level, event, details) => logs.push({ level, event, details }),
    lifecycle,
    resolveLaunchAccelerationImpl: (options) => {
      resolverCalls.push(options);
      return accel || { mode: 'off', reason: 'disabled', extraArgs: [], drafter: '', vramHeadroomMb: 0 };
    },
    resolveSettingsImpl: realSettings
      ? (args) => resolveLlamaServerSettings({ ...args, repoRoot: path.resolve(__dirname, '..') })
      : () => ({
        autostart: true, binaryOverride: '', host: '127.0.0.1', port: 8033, profileId: '', profile: null,
        profileError: '', modelPathOverride: '', modelTagOverride: '', readinessTimeoutMs: 1000, ...settings,
      }),
    buildFeatureFlagsImpl: () => ({ llama_server_acceleration: true }),
  });
  return { manager, launches, logs, resolverCalls, lifecycle, state };
}

function entry(extra = {}) {
  return { engine: 'llama-server', tag: TAG, modelPath: '', mtp: { mode: 'off', draftNMax: 4 }, ...extra };
}

test('a saved build feeds both the spawn and the acceleration probe and labels the status', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({ managed: { enabled: true, perModel: { [KEY]: entry({ runtimePath: runtimes.fork, runtimeBuild: 10683 }) } } });
  const status = await h.manager.ensureRunning({ modelTag: TAG, modelPath: runtimes.model });
  assert.equal(status.state, 'ready');
  assert.equal(h.launches[0].binaryPath, runtimes.fork);
  assert.equal(h.resolverCalls[0].binaryPath, runtimes.fork, 'one resolution for spawn and probe');
  assert.equal(h.launches[0].runtimeLabel, 'build 10683');
  assert.equal(h.launches[0].runtimeSource, 'saved');
  assert.equal(status.runtimeLabel, 'build 10683');
  assert.equal('binaryPath' in status, false, 'the executable path never crosses IPC in the status');
});

test('a model without a saved build runs the bundled one, resolved once', async () => {
  const h = makeHarness({ managed: { enabled: true, perModel: { [KEY]: entry() } } });
  const status = await h.manager.ensureRunning({ modelTag: TAG });
  assert.equal(h.launches[0].binaryPath, BUNDLED);
  assert.equal(h.resolverCalls[0].binaryPath, BUNDLED);
  assert.equal(h.launches[0].runtimeSource, 'bundled');
  assert.equal(status.runtimeLabel, 'bundled');
});

test('the env override shadows a saved build and says so without a path', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({
    managed: { enabled: true, perModel: { [KEY]: entry({ runtimePath: runtimes.fork, runtimeBuild: 10683 }) } },
    settings: { binaryOverride: runtimes.other },
  });
  const status = await h.manager.ensureRunning({ modelTag: TAG });
  assert.equal(h.launches[0].binaryPath, runtimes.other);
  assert.equal(status.runtimeLabel, 'env');
  const shadowed = h.logs.find((line) => line.event === 'llama.server.runtime_env_shadowed');
  assert.deepEqual(shadowed?.details, { model: KEY });
});

test('a missing saved build spawns nothing, probes nothing and never falls back to bundled', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({ managed: { enabled: true, perModel: { [KEY]: entry({ runtimePath: runtimes.missing, runtimeBuild: 10683 }) } } });
  const status = await h.manager.ensureRunning({ modelTag: TAG });
  assert.equal(h.launches.length, 0);
  assert.equal(h.resolverCalls.length, 0);
  assert.equal(status.state, 'stopped');
  assert.equal(status.lastError, 'llama_server_runtime_missing:runtime');
  assert.equal(status.alias, TAG, 'the health line can name the model that failed');
  const warned = h.logs.find((line) => line.event === 'llama.server.runtime_missing');
  assert.deepEqual(warned?.details, { runtime: 'runtime' });
  assert.equal(JSON.stringify(h.logs).includes(runtimes.missing), false);
});

test('a build change relaunches the model it belongs to; an unchanged build does not', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({ managed: { enabled: true, perModel: { [KEY]: entry() } } });
  const spec = { modelTag: TAG };
  await h.manager.ensureRunning(spec);
  await h.manager.ensureRunning(spec);
  assert.equal(h.launches.length, 1, 'bundled, unchanged');
  h.state.managed = { enabled: true, perModel: { [KEY]: entry({ runtimePath: runtimes.fork, runtimeBuild: 10683 }) } };
  await h.manager.ensureRunning(spec);
  assert.equal(h.launches.length, 2);
  assert.equal(h.launches[1].binaryPath, runtimes.fork, 'set');
  await h.manager.ensureRunning(spec);
  assert.equal(h.launches.length, 2, 'unchanged');
  h.state.managed = { enabled: true, perModel: { [KEY]: entry({ runtimePath: runtimes.other, runtimeBuild: 10800 }) } };
  await h.manager.ensureRunning(spec);
  assert.equal(h.launches[2].binaryPath, runtimes.other, 'changed');
  h.state.managed = { enabled: true, perModel: { [KEY]: entry() } };
  await h.manager.ensureRunning(spec);
  assert.equal(h.launches[3].binaryPath, BUNDLED, 'cleared');
  assert.equal(h.manager.getStatus().runtimeLabel, 'bundled');
});

test('a reused server reads unknown and a build change never loops relaunching it', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({ managed: { enabled: true, perModel: { [KEY]: entry() } } });
  h.lifecycle.reuseNext = true;
  const status = await h.manager.ensureRunning({ modelTag: TAG });
  assert.equal(status.reused, true);
  assert.equal(status.runtimeLabel, 'unknown');
  h.state.managed = { enabled: true, perModel: { [KEY]: entry({ runtimePath: runtimes.fork, runtimeBuild: 10683 }) } };
  await h.manager.ensureRunning({ modelTag: TAG });
  await h.manager.ensureRunning({ modelTag: TAG });
  assert.equal(h.launches.length, 1);
});

test('restart() without a spec relaunches with the model\'s current saved MTP, file and build', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({ managed: { enabled: true, profileId: '', perModel: {
    [KEY]: entry({ modelPath: runtimes.model, mtp: { mode: 'mtp', draftNMax: 4 } }),
  } } });
  await h.manager.ensureRunning({ modelTag: TAG, modelPath: runtimes.model, mtp: { mode: 'mtp', draftNMax: 4 } });
  assert.equal(h.resolverCalls[0].shellAcceleration.mode, 'mtp');
  h.state.managed = { enabled: true, profileId: '', perModel: {
    [KEY]: entry({ modelPath: runtimes.model2, mtp: { mode: 'off', draftNMax: 4 }, runtimePath: runtimes.fork, runtimeBuild: 10683 }),
  } };
  const status = await h.manager.restart();
  assert.equal(status.state, 'ready');
  assert.equal(h.resolverCalls[1].shellAcceleration.mode, 'off', 'the Apply turned MTP off');
  assert.equal(h.launches[1].modelPath, runtimes.model2, 'the Apply chose another file');
  assert.equal(h.launches[1].binaryPath, runtimes.fork, 'the Apply chose a build');
  assert.equal(status.runtimeLabel, 'build 10683');
});

test('restart() without a saved entry relaunches the last spec unchanged', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({ managed: { enabled: true, perModel: {} } });
  await h.manager.ensureRunning({ modelTag: TAG, modelPath: runtimes.model, mtp: { mode: 'mtp', draftNMax: 3 } });
  await h.manager.restart();
  assert.equal(h.launches[1].modelPath, runtimes.model);
  assert.deepEqual(h.resolverCalls[1].shellAcceleration, { mode: 'mtp', draftNMax: 3 });
});

test('the boot autostart resolves the saved build of the model it starts', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({
    managed: { enabled: true, lastUsedTag: KEY, perModel: { [KEY]: entry({ runtimePath: runtimes.fork, runtimeBuild: 10683 }) } },
    settings: { modelTagOverride: TAG },
  });
  const status = await h.manager.startFromSettings();
  assert.equal(h.launches[0].binaryPath, runtimes.fork);
  assert.equal(status.runtimeLabel, 'build 10683');
});

test('a crash clears the build label', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({ managed: { enabled: true, perModel: { [KEY]: entry({ runtimePath: runtimes.fork, runtimeBuild: 10683 }) } } });
  await h.manager.ensureRunning({ modelTag: TAG });
  h.lifecycle.lastHandle.onExit({ pid: h.lifecycle.lastHandle.pid, code: 1, signal: '' });
  assert.equal(h.manager.getStatus().state, 'crashed');
  assert.equal(h.manager.getStatus().runtimeLabel, '');
});

test('a launch spec can never name an executable', () => {
  const runtimes = makeRuntimes();
  assert.deepEqual(normalizeSpec({ modelTag: TAG, runtimePath: runtimes.fork, binaryPath: runtimes.fork, runtimeBuild: 1 }),
    { modelTag: TAG });
  const h = makeHarness();
  assert.equal(typeof h.manager.runtimePicks?.record, 'function', 'the manager owns the pick registry');
});

// Review round 1 (W3 lifecycle review, 2026-09-18): each test below failed
// before its fix.

test('a Use of a model with no saved file never inherits the last-used model\'s file (L1)', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({
    realSettings: true,
    managed: { enabled: true, profileId: '', lastUsedTag: KEY, perModel: {
      [KEY]: entry({ modelPath: runtimes.model, runtimePath: runtimes.fork, runtimeBuild: 10683 }),
      'gemma4-12b': entry({ tag: 'gemma4:12b', modelPath: '' }),
    } },
  });
  await h.manager.ensureRunning({ modelTag: 'gemma4:12b', modelPath: '', profileId: '', mtp: { mode: 'off', draftNMax: 4 } });
  assert.equal(h.launches[0].modelPath, '', 'gemma resolves its own weights by tag');
  await h.manager.restart();
  assert.equal(h.launches[1].modelPath, '');
  await h.manager.stop();
  await h.manager.startFromSettings();
  assert.equal(h.launches[2].modelPath, runtimes.model, 'the boot launch still uses the last-used model\'s file');
});

test('a :latest model is not relaunched for an unchanged spec (L3)', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({ managed: { enabled: true, perModel: {
    'qwen3-latest': entry({ tag: 'qwen3:latest', modelPath: runtimes.model, runtimePath: runtimes.fork, runtimeBuild: 10683 }),
  } } });
  const use = { modelTag: 'qwen3:latest', modelPath: runtimes.model, mtp: { mode: 'off', draftNMax: 4 } };
  await h.manager.ensureRunning(use);
  await h.manager.ensureRunning(use);
  await h.manager.ensureRunning({ contextSize: 32768 });
  await h.manager.ensureRunning({});
  assert.equal(h.launches.length, 1, h.launches.map((launch) => launch.binaryPath).join(', '));
});

test('a saved build that vanishes during the launch reports it missing and is not spawned again (L4)', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({
    accel: MTP_ACCEL,
    managed: { enabled: true, perModel: { [KEY]: entry({ runtimePath: runtimes.fork, runtimeBuild: 10683 }) } },
    onStart: () => {
      fs.rmSync(runtimes.fork);
      throw new Error('child_exited_before_ready');
    },
  });
  const status = await h.manager.ensureRunning({ modelTag: TAG, mtp: { mode: 'mtp', draftNMax: 4 } });
  assert.equal(h.launches.length, 1, 'no unaccelerated retry of a missing file');
  assert.equal(status.state, 'stopped');
  assert.equal(status.lastError, 'llama_server_runtime_missing:b10683');
});

test('a spec-less restart after the boot autostart applies the model\'s saved MTP (L5)', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({
    realSettings: true,
    acceleration: { mode: 'off', draftNMax: 0 },
    managed: { enabled: true, profileId: '', lastUsedTag: KEY, perModel: {
      [KEY]: entry({ modelPath: runtimes.model, mtp: { mode: 'mtp', draftNMax: 4 }, runtimePath: runtimes.fork, runtimeBuild: 10683 }),
    } },
  });
  await h.manager.startFromSettings();
  await h.manager.restart();
  assert.equal(h.launches[1].modelTag, TAG);
  assert.equal(h.launches[1].modelPath, runtimes.model);
  assert.equal(h.launches[1].binaryPath, runtimes.fork);
  assert.deepEqual(h.resolverCalls[1].shellAcceleration, { mode: 'mtp', draftNMax: 4 });
});

test('the boot autostart launches the last-used model with its saved MTP, as a Use does (L5b)', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({
    realSettings: true,
    acceleration: { mode: 'off', draftNMax: 0 },
    managed: { enabled: true, profileId: '', lastUsedTag: KEY, perModel: {
      [KEY]: entry({ modelPath: runtimes.model, mtp: { mode: 'mtp', draftNMax: 4 }, runtimePath: runtimes.fork, runtimeBuild: 10683 }),
    } },
  });
  await h.manager.startFromSettings();
  assert.equal(h.launches[0].modelTag, TAG);
  assert.equal(h.launches[0].modelPath, runtimes.model);
  assert.equal(h.launches[0].binaryPath, runtimes.fork);
  assert.deepEqual(h.resolverCalls[0].shellAcceleration, { mode: 'mtp', draftNMax: 4 });
});

test('an env model at boot keeps the global launch settings (L5b)', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({
    realSettings: true,
    env: { JENNY_LLAMA_SERVER_MODEL_PATH: runtimes.model2 },
    acceleration: { mode: 'off', draftNMax: 0 },
    managed: { enabled: true, profileId: '', lastUsedTag: KEY, perModel: {
      [KEY]: entry({ modelPath: runtimes.model, mtp: { mode: 'mtp', draftNMax: 4 }, runtimePath: runtimes.fork, runtimeBuild: 10683 }),
    } },
  });
  await h.manager.startFromSettings();
  assert.equal(h.launches[0].modelPath, runtimes.model2);
  assert.deepEqual(h.resolverCalls[0].shellAcceleration, { mode: 'off', draftNMax: 0 });
});

test('the env-shadow warning is logged only when a launch happens (L7)', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({
    managed: { enabled: true, lastUsedTag: KEY, perModel: { [KEY]: entry({ runtimePath: runtimes.fork }) } },
    settings: { autostart: false, binaryOverride: runtimes.other, modelTagOverride: TAG },
  });
  await h.manager.startFromSettings();
  const shadowWarnings = () => h.logs.filter((line) => line.event === 'llama.server.runtime_env_shadowed').length;
  assert.equal(shadowWarnings(), 0, 'autostart is off, nothing launched');
  await h.manager.ensureRunning({ modelTag: TAG });
  assert.equal(shadowWarnings(), 1);
});

// Review round 2 (W3 lifecycle review, 2026-09-18): each test below failed
// before its fix.

function bootManaged(runtimes) {
  return { enabled: true, profileId: '', lastUsedTag: KEY, perModel: {
    [KEY]: entry({ modelPath: runtimes.model, mtp: { mode: 'mtp', draftNMax: 4 }, runtimePath: runtimes.fork, runtimeBuild: 10683 }),
  } };
}

test('the first identical Use after the boot autostart keeps the running server (L9)', async () => {
  const runtimes = makeRuntimes();
  const managed = bootManaged(runtimes);
  const h = makeHarness({ realSettings: true, accel: MTP_ACCEL, managed });
  await h.manager.startFromSettings();
  const saved = managed.perModel[KEY];
  await h.manager.ensureRunning({ modelTag: TAG, modelPath: saved.modelPath, profileId: '', mtp: saved.mtp });
  assert.equal(h.launches.length, 1, 'the Use builds the spec the boot launched');
  // The running model stays the restart target once its entry is gone.
  h.state.managed = { ...managed, lastUsedTag: '', perModel: {} };
  await h.manager.restart();
  assert.equal(h.launches[1].modelTag, TAG);
});

test('with autostart off the boot resolves no launch plan, so the saved build is never probed (L10)', async () => {
  const runtimes = makeRuntimes();
  const h = makeHarness({
    realSettings: true,
    env: { JENNY_LLAMA_SERVER_AUTOSTART: '0' },
    accel: MTP_ACCEL,
    managed: bootManaged(runtimes),
  });
  const status = await h.manager.startFromSettings();
  assert.equal(status.state, 'stopped');
  assert.equal(h.launches.length, 0);
  assert.equal(h.resolverCalls.length, 0, 'the acceleration resolver, and its probe, never ran');
  assert.ok(h.logs.some((line) => line.event === 'llama.server.autostart_disabled'));
});

test('a stat refused on a present saved build is not reported missing; the usual retry runs (L12)', async () => {
  const runtimes = makeRuntimes();
  const realStat = fs.statSync;
  const h = makeHarness({
    accel: MTP_ACCEL,
    managed: { enabled: true, perModel: { [KEY]: entry({ runtimePath: runtimes.fork, runtimeBuild: 10683 }) } },
    onStart: (_options, index) => {
      if (index !== 0) return;
      fs.statSync = function refused(target, ...rest) {
        if (String(target) === runtimes.fork) {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        return realStat.call(this, target, ...rest);
      };
      throw new Error('child_exited_before_ready');
    },
  });
  let status;
  try {
    status = await h.manager.ensureRunning({ modelTag: TAG, mtp: { mode: 'mtp', draftNMax: 4 } });
  } finally {
    fs.statSync = realStat;
  }
  assert.equal(h.launches.length, 2, 'the unaccelerated retry ran');
  assert.equal(status.state, 'ready');
});
