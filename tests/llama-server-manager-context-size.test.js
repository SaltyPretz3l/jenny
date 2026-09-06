'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH,
  DEFAULT_MANAGED_SHELL_MODEL,
} = require('../services/backend/backend-config');
const {
  createLlamaServerManager,
  normalizeSpec,
} = require('../services/main/llama-server-manager');

const PROFILE = Object.freeze({
  id: 'context-test',
  modelTag: 'context-test:9b',
  contextSize: 49_152,
  extraArgs: [],
  acceleration: null,
});

function makeSettings(profile = PROFILE) {
  return {
    autostart: true,
    binaryOverride: '',
    host: '127.0.0.1',
    port: 8033,
    profileId: profile?.id || '',
    profile,
    profileError: '',
    modelPathOverride: '',
    modelTagOverride: '',
    readinessTimeoutMs: 1000,
  };
}

function makeHarness({ profile = PROFILE, shellState = {}, getState = null, reused = false } = {}) {
  const launches = [];
  const stops = [];
  let nextPid = 100;
  const lifecycle = {
    async startLlamaServer(options) {
      launches.push(options);
      const pid = nextPid++;
      const handle = {
        pid,
        baseUrl: `http://127.0.0.1:${options.port}`,
        reused,
        mmproj: '',
        apiKey: reused ? '' : `key-${pid}`,
        onExit: options.onExit,
        async stop() {
          stops.push(pid);
          return { confirmed: true };
        },
        stopSync() {},
      };
      lifecycle.lastHandle = handle;
      return handle;
    },
    resolveGgufPath: () => ({ path: '', projectorPath: '' }),
    resolveProjectorPath: () => '',
    lastHandle: null,
  };
  const shellConfigService = {
    getLocalEngines: () => ({ openaiCompatible: {} }),
    getState: getState || (() => shellState),
  };
  const manager = createLlamaServerManager({
    processRef: { env: {}, resourcesPath: '' },
    rootDir: 'G:/repo',
    userDataPath: 'G:/userData',
    getShellConfigService: () => shellConfigService,
    lifecycle,
    resolveSettingsImpl: () => makeSettings(profile),
    resolveLaunchAccelerationImpl: () => ({
      mode: 'off', reason: 'flag_off', extraArgs: [], drafter: '', vramHeadroomMb: 0,
    }),
    buildFeatureFlagsImpl: () => ({ llama_server_acceleration: false }),
  });
  return { manager, launches, stops, lifecycle };
}

test('normalizeSpec keeps only an in-range integer contextSize', () => {
  assert.deepEqual(normalizeSpec({ contextSize: 1024 }), { contextSize: 1024 });
  assert.deepEqual(normalizeSpec({ contextSize: 1_048_576 }), { contextSize: 1_048_576 });
  assert.equal(normalizeSpec({ contextSize: 32_768.5 }), null);
  assert.equal(normalizeSpec({ contextSize: 1023 }), null);
  assert.equal(normalizeSpec({ contextSize: 1_048_577 }), null);
});

test('launch context size precedence is spec, per-model override, profile, then default', async () => {
  const overrideState = {
    compactionTuning: { contextLengthByModel: { [PROFILE.modelTag]: 65_536 } },
  };

  const explicit = makeHarness({ shellState: overrideState });
  await explicit.manager.start({ modelTag: PROFILE.modelTag, contextSize: 131_072 });
  assert.equal(explicit.launches[0].contextSize, 131_072);

  const configured = makeHarness({ shellState: overrideState });
  await configured.manager.start();
  assert.equal(configured.launches[0].contextSize, 65_536);

  const profiled = makeHarness();
  await profiled.manager.start();
  assert.equal(profiled.launches[0].contextSize, PROFILE.contextSize);

  const defaults = makeHarness({ profile: null });
  await defaults.manager.start();
  assert.equal(defaults.launches[0].modelTag, DEFAULT_MANAGED_SHELL_MODEL);
  assert.equal(defaults.launches[0].contextSize, DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH);
});

test('a :latest launch uses the stripped context key unless the raw tag is configured', async () => {
  const stripped = makeHarness({
    shellState: { compactionTuning: { contextLengthByModel: { 'foo': 65_536 } } },
  });
  await stripped.manager.start({ modelTag: 'foo:latest' });
  assert.equal(stripped.launches[0].contextSize, 65_536);

  const raw = makeHarness({
    shellState: {
      compactionTuning: { contextLengthByModel: { 'foo': 65_536, 'foo:latest': 131_072 } },
    },
  });
  await raw.manager.start({ modelTag: 'foo:latest' });
  assert.equal(raw.launches[0].contextSize, 131_072);
});

test('a throwing shell-config accessor falls through to the profile context size', async () => {
  const h = makeHarness({
    getState: () => { throw new Error('config unavailable'); },
  });

  const status = await h.manager.start();

  assert.equal(status.state, 'ready');
  assert.equal(h.launches[0].contextSize, PROFILE.contextSize);
});

test('ensureRunning makes a real relaunch only when contextSize changes', async () => {
  const h = makeHarness();
  const first = await h.manager.ensureRunning({
    modelTag: PROFILE.modelTag,
    contextSize: 65_536,
  });
  assert.equal(first.contextSize, 65_536);
  assert.equal(h.launches.length, 1);

  const same = await h.manager.ensureRunning({
    modelTag: PROFILE.modelTag,
    contextSize: 65_536,
  });
  assert.equal(same.contextSize, 65_536);
  assert.equal(h.launches.length, 1, 'matching contextSize keeps the running process');
  assert.deepEqual(h.stops, []);

  const changed = await h.manager.ensureRunning({
    modelTag: PROFILE.modelTag,
    contextSize: 131_072,
  });
  assert.equal(changed.contextSize, 131_072);
  assert.equal(h.launches.length, 2, 'changed contextSize replaces the running process');
  assert.deepEqual(h.stops, [100]);

  h.lifecycle.lastHandle.onExit({ pid: changed.pid, code: 1 });
  assert.equal(h.manager.getStatus().contextSize, 0);
});

test('a reused server reports an unknown context size as zero', async () => {
  const h = makeHarness({ reused: true });

  const status = await h.manager.start({ contextSize: 65_536 });

  assert.equal(h.launches[0].contextSize, 65_536);
  assert.equal(status.reused, true);
  assert.equal(status.contextSize, 0);
});

// stopCurrent() cannot kill a handle this process never spawned, so relaunching
// on a reused server's unknown context size would restart on every preflight.
test('a reused server is not relaunched over its unknown context size', async () => {
  const h = makeHarness({ reused: true });

  await h.manager.ensureRunning({ modelTag: PROFILE.modelTag, contextSize: 65_536 });
  assert.equal(h.launches.length, 1);

  await h.manager.ensureRunning({ modelTag: PROFILE.modelTag, contextSize: 131_072 });

  assert.equal(h.launches.length, 1, 'an unknown reused context size never forces a relaunch');
  assert.deepEqual(h.stops, []);
});
