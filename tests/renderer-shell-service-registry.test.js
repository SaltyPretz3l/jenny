const test = require('node:test');
const assert = require('node:assert/strict');

const { createShellServiceRegistry } = require('../renderer/shell/renderer-shell-service-registry.js');

test('shell service registry forwards workspace session activation to the IDE controller', async () => {
  const calls = [];
  let ideDeps = null;
  const registry = createShellServiceRegistry({
    state: { ui: { ide: { openTabs: [] } } },
    modules: {
      ideControllerUtils: {
        createIdeController: (deps) => { ideDeps = deps; return {}; },
      },
    },
    callbacks: {
      activateWorkspaceSession: async (sessionId) => { calls.push(sessionId); },
    },
  });

  registry.ensureIdeController();
  await ideDeps.callbacks.activateWorkspaceSession('session-3');
  assert.deepEqual(calls, ['session-3']);
});

test('shell service registry exposes idempotent safe binders for lazy shell controllers', () => {
  const state = {
    skills: { featureEnabled: false },
    tips: { featureEnabled: false },
  };
  const createCalls = { skills: 0, tips: 0, offline: 0 };
  const bindCalls = { skills: 0, tips: 0, offline: 0 };
  const sectionDomCalls = { skills: 0, tips: 0 };

  const registry = createShellServiceRegistry({
    state,
    documentRef: {
      getElementById() {
        return null;
      },
    },
    surfaceDom: {
      settings: {
        getSectionDom(sectionId) {
          if (Object.prototype.hasOwnProperty.call(sectionDomCalls, sectionId)) {
            sectionDomCalls[sectionId] += 1;
          }
          return {};
        },
      },
    },
    modules: {
      skillsUtils: {
        createSkillsManager() {
          createCalls.skills += 1;
          return {
            bindShellEvents() {
              bindCalls.skills += 1;
              return function disposeSkillsBindings() {};
            },
          };
        },
      },
      tipsUtils: {
        createTipsManager() {
          createCalls.tips += 1;
          return {
            bindShellEvents() {
              bindCalls.tips += 1;
              return function disposeTipsBindings() {};
            },
          };
        },
      },
      offlineUtils: {
        createOfflineManager() {
          createCalls.offline += 1;
          return {
            bindShellEvents() {
              bindCalls.offline += 1;
              return function disposeOfflineBindings() {};
            },
          };
        },
      },
    },
  });

  registry.bindSkillsShellEventsSafe(false);
  registry.bindTipsShellEventsSafe(false);
  registry.bindOfflineShellEventsSafe();
  registry.bindSkillsShellEventsSafe(false);
  registry.bindTipsShellEventsSafe(false);
  registry.bindOfflineShellEventsSafe();

  assert.deepEqual(createCalls, {
    skills: 1,
    tips: 1,
    offline: 1,
  });
  assert.deepEqual(bindCalls, {
    skills: 0,
    tips: 0,
    offline: 1,
  });

  state.skills.featureEnabled = true;
  state.tips.featureEnabled = true;

  registry.bindSkillsShellEventsSafe(false);
  registry.bindTipsShellEventsSafe(false);
  registry.bindOfflineShellEventsSafe();
  registry.bindSkillsShellEventsSafe(false);
  registry.bindTipsShellEventsSafe(false);
  registry.bindOfflineShellEventsSafe();

  assert.deepEqual(createCalls, {
    skills: 1,
    tips: 1,
    offline: 1,
  });
  assert.deepEqual(bindCalls, {
    skills: 1,
    tips: 1,
    offline: 1,
  });
  assert.deepEqual(sectionDomCalls, {
    skills: 1,
    tips: 0,
  });
});

test('shell service registry refreshes and resets phase percentiles through diagnostics bridge', async () => {
  const payload = {
    generated_at: '2026-04-19T00:00:00.000Z',
    retention: { samples_per_phase: 256 },
    targets: { provider_request_start_to_first_chunk: { p50: 150, p95: 400 } },
    phases: { provider_request_start_to_first_chunk: { count: 1, p50: 100, p95: 100, p99: 100, min: 100, max: 100, last_N: 1 } },
  };
  const resetPayload = {
    ...payload,
    phases: {},
  };
  const calls = { get: 0, reset: 0, render: 0 };
  const state = {};

  const registry = createShellServiceRegistry({
    state,
    windowRef: {
      jennyShell: {
        diagnostics: {
          phasePercentiles: {
            async get() {
              calls.get += 1;
              return payload;
            },
            async reset() {
              calls.reset += 1;
              return resetPayload;
            },
          },
        },
      },
    },
    callbacks: {
      renderSettings() {
        calls.render += 1;
      },
    },
  });

  const refreshed = await registry.refreshPhasePercentiles();
  assert.equal(refreshed, payload);
  assert.equal(state.phasePercentiles.payload, payload);
  assert.equal(state.phasePercentiles.loading, false);

  const reset = await registry.resetPhasePercentiles();
  assert.equal(reset, resetPayload);
  assert.equal(state.phasePercentiles.payload, resetPayload);
  assert.deepEqual(calls, { get: 1, reset: 1, render: 4 });
});

test('shell service registry ignores stale phase percentile refresh after reset', async () => {
  let resolveRefresh;
  const refreshPayload = {
    generated_at: '2026-04-19T00:00:00.000Z',
    retention: { samples_per_phase: 256 },
    targets: {},
    phases: { provider_request_start_to_first_chunk: { count: 1, p50: 250, p95: 250, p99: 250, min: 250, max: 250, last_N: 1 } },
  };
  const resetPayload = {
    generated_at: '2026-04-19T00:00:01.000Z',
    retention: { samples_per_phase: 256 },
    targets: {},
    phases: {},
  };
  const state = {};

  const registry = createShellServiceRegistry({
    state,
    windowRef: {
      jennyShell: {
        diagnostics: {
          phasePercentiles: {
            get() {
              return new Promise((resolve) => {
                resolveRefresh = resolve;
              });
            },
            async reset() {
              return resetPayload;
            },
          },
        },
      },
    },
    callbacks: {
      renderSettings() {},
    },
  });

  const refreshPromise = registry.refreshPhasePercentiles();
  const reset = await registry.resetPhasePercentiles();
  assert.equal(reset, resetPayload);
  assert.equal(state.phasePercentiles.payload, resetPayload);

  resolveRefresh(refreshPayload);
  await refreshPromise;

  assert.equal(state.phasePercentiles.payload, resetPayload);
  assert.deepEqual(state.phasePercentiles.payload.phases, {});
  assert.equal(state.phasePercentiles.loading, false);
});

test('safeInvoke logs a diagnostic and isolates a throwing lazy-controller constructor', () => {
  const logs = [];
  const registry = createShellServiceRegistry({
    state: { skills: { featureEnabled: true } },
    documentRef: { getElementById() { return null; } },
    modules: {
      skillsUtils: {
        createSkillsManager() { throw new Error('boom-skills-init'); },
      },
    },
    callbacks: {
      appendClientLog(level, event, details) { logs.push({ level, event, details }); },
    },
  });

  let result = 'sentinel';
  assert.doesNotThrow(() => { result = registry.renderSkillsManagerSafe(); },
    'a throwing controller constructor must not propagate out of the safe wrapper');
  assert.equal(result, undefined, 'the safe wrapper returns undefined when construction fails');

  const initFailure = logs.find((entry) => entry.event === 'shell.controller_init_failed');
  assert.ok(initFailure, 'expected a shell.controller_init_failed diagnostic to be logged');
  assert.equal(initFailure.level, 'ERROR');
  assert.equal(initFailure.details.ensure, 'ensureSkillsController');
  assert.match(String(initFailure.details.message), /boom-skills-init/);
});
