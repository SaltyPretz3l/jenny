'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  resolveLaunchAcceleration,
  shouldRetryWithoutAcceleration,
} = require('../services/main/llama-server-acceleration-launch');
const {
  createRuntimeShutdownController,
} = require('../services/main/runtime-shutdown');

const PROFILE_ID = 'qwen3.8-27b-ud-iq3-s-128k';
const PROFILE_EXTRA_ARGS = [
  '--parallel',
  '1',
  '--no-mmproj',
  '--gpu-layers',
  'all',
  '--split-mode',
  'none',
  '--flash-attn',
  'on',
  '--cache-type-k',
  'q8_0',
  '--cache-type-v',
  'q8_0',
  '--kv-unified',
  '--batch-size',
  '512',
  '--ubatch-size',
  '128',
  '--fit',
  'off',
];

function offResult(reason) {
  return {
    mode: 'off',
    extraArgs: [],
    vramHeadroomMb: 0,
    reason,
    drafter: '',
  };
}

function createResolutionFakes({
  resolverResult = offResult('fake'),
  ggufResult = { path: path.join('G:', 'models', 'resolved', 'model.gguf') },
} = {}) {
  const calls = {
    probe: [],
    catalog: [],
    resolver: [],
    binary: [],
    gguf: [],
  };
  return {
    calls,
    impls: {
      probeCapabilitiesImpl(options) {
        calls.probe.push(options);
        return {
          ok: true,
          specTypes: ['draft-mtp', 'ngram-cache'],
          supportsMtp: true,
          build: 1,
          commit: 'abc',
          reason: 'probed',
        };
      },
      loadAccelerationCatalogImpl(options) {
        calls.catalog.push(options);
        return { catalog: { schema_version: 1 }, error: '' };
      },
      resolveAccelerationArgsImpl(options) {
        calls.resolver.push(options);
        return resolverResult;
      },
      resolveBinaryPathImpl(options) {
        calls.binary.push(options);
        return path.join('G:', 'bin', 'llama-server.exe');
      },
      resolveGgufPathImpl(options) {
        calls.gguf.push(options);
        return ggufResult;
      },
    },
  };
}

function assertNoResolutionCalls(calls) {
  assert.deepEqual(calls, {
    probe: [],
    catalog: [],
    resolver: [],
    binary: [],
    gguf: [],
  });
}

test('resolveLaunchAcceleration returns flag_off without probing when the feature flag is absent', () => {
  const fakes = createResolutionFakes();

  const result = resolveLaunchAcceleration({
    featureFlags: {},
    shellAcceleration: { mode: 'mtp' },
    ...fakes.impls,
  });

  assert.deepEqual(result, offResult('flag_off'));
  assertNoResolutionCalls(fakes.calls);
});

test('resolveLaunchAcceleration returns disabled without probing when the requested mode is off', () => {
  const fakes = createResolutionFakes();

  const result = resolveLaunchAcceleration({
    featureFlags: { llama_server_acceleration: true },
    profile: { modelTag: 'test-model', extraArgs: ['--parallel', '1'] },
    shellAcceleration: { mode: 'off' },
    ...fakes.impls,
  });

  assert.deepEqual(result, offResult('disabled'));
  assertNoResolutionCalls(fakes.calls);
});

test('resolveLaunchAcceleration prefers profile acceleration and normalizes the resolver result', () => {
  const resolverResult = {
    mode: 'mtp',
    extraArgs: ['--spec-type', 'draft-mtp'],
    vramHeadroomMb: 3072,
    reason: 'mtp',
    drafter: 'draft.gguf',
    ignored: 'not part of the launch contract',
  };
  const fakes = createResolutionFakes({ resolverResult });
  const profileExtraArgs = ['--parallel', '1'];

  const result = resolveLaunchAcceleration({
    featureFlags: { llama_server_acceleration: true },
    profile: {
      modelTag: 'test-model',
      extraArgs: profileExtraArgs,
      acceleration: { mode: 'mtp', draftNMax: 0, allowUnverified: true },
    },
    shellAcceleration: { mode: 'ngram', draftNMax: 6 },
    repoRoot: 'repo-root',
    resourcesPath: 'resources',
    userDataPath: 'user-data',
    ...fakes.impls,
  });

  assert.deepEqual(result, {
    mode: 'mtp',
    extraArgs: ['--spec-type', 'draft-mtp'],
    vramHeadroomMb: 3072,
    reason: 'mtp',
    drafter: 'draft.gguf',
  });
  assert.equal(fakes.calls.resolver.length, 1);
  assert.equal(fakes.calls.resolver[0].mode, 'mtp');
  assert.equal(fakes.calls.resolver[0].draftNMax, undefined);
  assert.equal(fakes.calls.resolver[0].allowUnverified, true);
  assert.strictEqual(fakes.calls.resolver[0].profileExtraArgs, profileExtraArgs);
});

test('resolveLaunchAcceleration falls back to shell acceleration when the profile has none', () => {
  const fakes = createResolutionFakes({
    resolverResult: {
      mode: 'mtp',
      extraArgs: ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '3'],
      vramHeadroomMb: 2048,
      reason: 'mtp',
      drafter: '',
    },
  });

  resolveLaunchAcceleration({
    featureFlags: { llama_server_acceleration: true },
    profile: { modelTag: 'test-model', extraArgs: [] },
    shellAcceleration: { mode: 'mtp', draftNMax: 3 },
    ...fakes.impls,
  });

  assert.equal(fakes.calls.resolver.length, 1);
  assert.equal(fakes.calls.resolver[0].mode, 'mtp');
  assert.equal(fakes.calls.resolver[0].draftNMax, 3);
});

test('resolveLaunchAcceleration derives modelDir from the override, resolved GGUF, or empty path', () => {
  const modelOverride = String.raw`G:\models\x\model.gguf`;
  const overrideFakes = createResolutionFakes();
  resolveLaunchAcceleration({
    settings: { modelPathOverride: modelOverride },
    featureFlags: { llama_server_acceleration: true },
    shellAcceleration: { mode: 'mtp' },
    ...overrideFakes.impls,
  });
  assert.equal(overrideFakes.calls.resolver[0].modelDir, path.dirname(modelOverride));
  assert.equal(overrideFakes.calls.gguf.length, 0);

  const resolvedPath = String.raw`G:\models\resolved\model.gguf`;
  const resolvedFakes = createResolutionFakes({ ggufResult: { path: resolvedPath } });
  resolveLaunchAcceleration({
    featureFlags: { llama_server_acceleration: true },
    shellAcceleration: { mode: 'mtp' },
    ...resolvedFakes.impls,
  });
  assert.equal(resolvedFakes.calls.resolver[0].modelDir, path.dirname(resolvedPath));
  assert.equal(resolvedFakes.calls.gguf.length, 1);

  const emptyFakes = createResolutionFakes({ ggufResult: { path: '' } });
  resolveLaunchAcceleration({
    featureFlags: { llama_server_acceleration: true },
    shellAcceleration: { mode: 'mtp' },
    ...emptyFakes.impls,
  });
  assert.equal(emptyFakes.calls.resolver[0].modelDir, '');
});

test('resolveLaunchAcceleration degrades a capability-probe exception to resolve_error', () => {
  const fakes = createResolutionFakes();
  fakes.impls.probeCapabilitiesImpl = (options) => {
    fakes.calls.probe.push(options);
    throw new Error('probe exploded');
  };

  const result = resolveLaunchAcceleration({
    featureFlags: { llama_server_acceleration: true },
    shellAcceleration: { mode: 'mtp' },
    ...fakes.impls,
  });

  assert.deepEqual(result, offResult('resolve_error'));
  assert.equal(fakes.calls.binary.length, 1);
  assert.equal(fakes.calls.probe.length, 1);
  assert.equal(fakes.calls.catalog.length, 0);
  assert.equal(fakes.calls.resolver.length, 0);
  assert.equal(fakes.calls.gguf.length, 0);
});

test('shouldRetryWithoutAcceleration retries only eligible accelerated launch failures', () => {
  const genericError = new Error('spawn failed');

  assert.equal(shouldRetryWithoutAcceleration({
    error: genericError,
    accelExtraArgs: ['--spec-type', 'draft-mtp'],
  }), true);
  assert.equal(shouldRetryWithoutAcceleration({
    error: genericError,
    accelExtraArgs: [],
  }), false);
  assert.equal(shouldRetryWithoutAcceleration({
    error: genericError,
    accelExtraArgs: ['--spec-type', 'draft-mtp'],
    aborted: true,
  }), false);
  assert.equal(shouldRetryWithoutAcceleration({
    error: new Error('readiness_aborted'),
    accelExtraArgs: ['--spec-type', 'draft-mtp'],
  }), false);
  // Deterministic pre-spawn failures cannot be caused by accel args — no retry.
  assert.equal(shouldRetryWithoutAcceleration({
    error: new Error('llama_server_binary_not_found'),
    accelExtraArgs: ['--spec-type', 'draft-mtp'],
  }), false);
  assert.equal(shouldRetryWithoutAcceleration({
    error: new Error('llama_server_model_not_found:model_dir_missing'),
    accelExtraArgs: ['--spec-type', 'draft-mtp'],
  }), false);
  // Child-exit / readiness-timeout failures stay retryable.
  assert.equal(shouldRetryWithoutAcceleration({
    error: new Error('llama_server_exited:1'),
    accelExtraArgs: ['--spec-type', 'draft-mtp'],
  }), true);
});

function createStartupHarness({ acceleration, startImpl }) {
  const lifecycleCalls = [];
  const resolverCalls = [];
  const logs = [];
  const audits = [];
  const rootDir = path.resolve(__dirname, '..');
  const lifecycle = {
    async startLlamaServer(options) {
      lifecycleCalls.push(options);
      if (startImpl) {
        return startImpl(options, lifecycleCalls.length);
      }
      return { reused: false, baseUrl: 'http://127.0.0.1:8033', pid: 42 };
    },
  };
  const controller = createRuntimeShutdownController({
    app: { getPath: () => path.join(rootDir, '.test-user-data') },
    processRef: {
      env: {
        JENNY_LLAMA_SERVER_AUTOSTART: 'true',
        JENNY_LLAMA_SERVER_PROFILE: PROFILE_ID,
      },
      resourcesPath: '',
    },
    rootDir,
    clearSuggestionCache: () => {},
    suggestionCache: null,
    getShellConfigService: () => ({
      getState: () => ({ featureOverrides: { llama_server_acceleration: true } }),
      getLocalEngines: () => ({
        openaiCompatible: { acceleration: { mode: 'mtp', draftNMax: 4 } },
      }),
    }),
    emitStartupAuditMark: (event, fields) => audits.push({ event, fields }),
    log: (level, event, fields) => logs.push({ level, event, fields }),
    llamaServerLifecycleImpl: lifecycle,
    resolveLaunchAccelerationImpl: (options) => {
      resolverCalls.push(options);
      return acceleration;
    },
    shutdownLlamaServerSyncImpl: () => ({ hadState: false, killed: false, pid: 0 }),
    shutdownManagedSidecarSyncImpl: () => ({ hadState: false, killed: false, pid: 0 }),
    shutdownAnyLocalOllamaSyncImpl: () => ({ discoveredPids: [], killedPids: [] }),
  });

  return { controller, lifecycleCalls, resolverCalls, logs, audits };
}

function mtpAcceleration() {
  return {
    mode: 'mtp',
    extraArgs: ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '4'],
    vramHeadroomMb: 2048,
    reason: 'mtp',
    drafter: '',
  };
}

test('controller starts once with profile-only args when acceleration is flag-off', async () => {
  const harness = createStartupHarness({ acceleration: offResult('flag_off') });

  await harness.controller.startLlamaServerBeforeBackend();

  assert.equal(harness.resolverCalls.length, 1);
  assert.equal(harness.lifecycleCalls.length, 1);
  assert.deepEqual(harness.lifecycleCalls[0].extraArgs, PROFILE_EXTRA_ARGS);
  assert.equal(
    harness.logs.filter((entry) => entry.event === 'llama.server.acceleration_resolved').length,
    0
  );
  assert.equal(
    harness.logs.filter((entry) => entry.event === 'llama.server.acceleration_fallback').length,
    0
  );
  // Flag-off audit payload is byte-identical to the pre-feature build.
  const readyMark = harness.audits.find((entry) => entry.event === 'llama-server-ready');
  assert.ok(readyMark);
  assert.equal('accelerationMode' in readyMark.fields, false);
});

test('controller appends acceleration args, logs resolution, and audits the active mode', async () => {
  const acceleration = mtpAcceleration();
  const harness = createStartupHarness({ acceleration });

  await harness.controller.startLlamaServerBeforeBackend();

  assert.equal(harness.lifecycleCalls.length, 1);
  assert.deepEqual(
    harness.lifecycleCalls[0].extraArgs,
    [...PROFILE_EXTRA_ARGS, ...acceleration.extraArgs]
  );
  const resolvedLogs = harness.logs.filter((entry) => (
    entry.level === 'INFO' && entry.event === 'llama.server.acceleration_resolved'
  ));
  assert.equal(resolvedLogs.length, 1);
  assert.equal(resolvedLogs[0].fields.mode, 'mtp');
  assert.deepEqual(resolvedLogs[0].fields.extraArgs, acceleration.extraArgs);
  const readyMark = harness.audits.find((entry) => entry.event === 'llama-server-ready');
  assert.ok(readyMark);
  assert.equal(readyMark.fields.accelerationMode, 'mtp');
});

test('a reused server never lets the audit mark claim an acceleration mode', async () => {
  const harness = createStartupHarness({
    acceleration: mtpAcceleration(),
    startImpl: () => ({ reused: true, baseUrl: 'http://127.0.0.1:8033', pid: 0 }),
  });

  await harness.controller.startLlamaServerBeforeBackend();

  const readyMark = harness.audits.find((entry) => entry.event === 'llama-server-ready');
  assert.ok(readyMark);
  assert.equal(readyMark.fields.reused, true);
  assert.equal(readyMark.fields.accelerationMode, 'unknown');
});

test('controller retries once without acceleration using a fresh abort signal', async () => {
  const acceleration = mtpAcceleration();
  const harness = createStartupHarness({
    acceleration,
    startImpl: (_options, callNumber) => {
      if (callNumber === 1) {
        throw new Error('accelerated spawn failed');
      }
      return { reused: false, baseUrl: 'http://127.0.0.1:8033', pid: 84 };
    },
  });

  await harness.controller.startLlamaServerBeforeBackend();

  assert.equal(harness.lifecycleCalls.length, 2);
  assert.deepEqual(
    harness.lifecycleCalls[0].extraArgs,
    [...PROFILE_EXTRA_ARGS, ...acceleration.extraArgs]
  );
  assert.deepEqual(harness.lifecycleCalls[1].extraArgs, PROFILE_EXTRA_ARGS);
  assert.notStrictEqual(
    harness.lifecycleCalls[0].abortSignal,
    harness.lifecycleCalls[1].abortSignal
  );
  const fallbackLogs = harness.logs.filter((entry) => (
    entry.level === 'WARN' && entry.event === 'llama.server.acceleration_fallback'
  ));
  assert.equal(fallbackLogs.length, 1);
  const readyMark = harness.audits.find((entry) => entry.event === 'llama-server-ready');
  assert.ok(readyMark);
  assert.equal(readyMark.fields.accelerationMode, 'off');
});

test('controller does not retry readiness_aborted failures and records startup failure', async () => {
  const harness = createStartupHarness({
    acceleration: mtpAcceleration(),
    startImpl: () => {
      throw new Error('readiness_aborted');
    },
  });

  await harness.controller.startLlamaServerBeforeBackend();

  assert.equal(harness.lifecycleCalls.length, 1);
  assert.equal(
    harness.logs.filter((entry) => entry.event === 'llama.server.acceleration_fallback').length,
    0
  );
  const failedLogs = harness.logs.filter((entry) => (
    entry.level === 'WARN' && entry.event === 'llama.server.start_failed'
  ));
  assert.equal(failedLogs.length, 1);
  assert.equal(failedLogs[0].fields.message, 'readiness_aborted');
  const failedMark = harness.audits.find((entry) => entry.event === 'llama-server-failed');
  assert.ok(failedMark);
  assert.equal(failedMark.fields.message, 'readiness_aborted');
});
