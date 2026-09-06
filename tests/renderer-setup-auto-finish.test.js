/**
 * Owner feedback wave 2: setup lingered at 6/6 reviewed without ever persisting
 * setup_complete, because nothing had clicked the Home card's "Finish setup".
 *
 * The card itself has since been removed (it could never retire itself on a
 * cloud engine), so the auto-finish now hangs off applySnapshot: whenever a
 * snapshot lands fully reviewed with the gate open, setup persists itself
 * through the same completeSetup() the button used to call.
 *
 * These tests pin the trigger, the three refusals, the once-per-episode latch,
 * and that Settings' re-entry points still open the flow afterwards.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { normalizeSetupPayload } = require('../renderer/services/renderer-setup-service');
const { createSetupController } = require('../renderer/features/renderer-setup-controller');
const { createSetupHub } = require('../renderer/features/renderer-setup-hub');

const READY_READINESS = {
  workspace_root: { ready: true, configured: true, status: 'ready' },
  local_model: { ready: true, source: 'model_catalog', model_count: 1 },
  endpoint: { ready: true, source: 'model_catalog' },
};

const ALL_DONE_STEPS = {
  workspace_root: 'done',
  local_model: 'done',
  endpoint: 'done',
  personality: 'done',
  skills: 'done',
  capabilities: 'done',
};

function backendPayload({ steps = ALL_DONE_STEPS, readiness = READY_READINESS, setupComplete = false } = {}) {
  return {
    setup_complete: setupComplete,
    setup_state: {
      seen: true,
      dismissed: false,
      setup_complete: setupComplete,
      first_run_completed: true,
      completed_at: '',
      updated_at: '2026-08-20T12:00:00.000Z',
      steps,
      readiness,
      tools_workspace_root_configured: true,
      mcp_tools_discovered: true,
      assistant_identity: { agentName: 'Jenny', profile: 'balanced', customText: '', updatedAt: '' },
    },
  };
}

/**
 * Boots the controller against a fake service whose complete() echoes a
 * setup_complete:true snapshot, exactly like the real bridge does.
 */
function harness(t, { steps, readiness, setupComplete = false, scenes = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { document } = dom.window;

  const calls = [];
  // Stateful, like the real bridge: once complete() lands, every later read
  // reports setup_complete true.
  let completed = setupComplete;
  const setupService = {
    async getState() {
      return normalizeSetupPayload(backendPayload({ steps, readiness, setupComplete: completed }));
    },
    async updateState(patch) {
      calls.push({ method: 'updateState', patch });
      return null;
    },
    async complete() {
      calls.push({ method: 'complete' });
      completed = true;
      return normalizeSetupPayload(backendPayload({ steps, readiness, setupComplete: true }));
    },
    async reset() { return normalizeSetupPayload(backendPayload()); },
    subscribePullProgress() { return () => {}; },
  };

  const views = [];
  const state = {};
  const controller = createSetupController({
    state,
    documentRef: document,
    setupService,
    dom: { homeSetupModalRoot: null },
    modules: {
      setupHub: { createSetupHub },
      scenes,
    },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: (view) => views.push(view),
    },
  });
  t.after(() => {
    controller.dispose();
    dom.window.close();
  });
  return {
    controller, state, calls, views, setupService, document,
  };
}

// The auto-finish is deferred by a microtask and completeSetup() awaits the
// bridge, so two macrotask turns settle both the call and its echo render.
function settle() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

const completeCalls = (calls) => calls.filter((entry) => entry.method === 'complete');

test('all steps reviewed with the gate open finishes setup exactly once', async (t) => {
  const { controller, state, calls } = harness(t);

  controller.bind();
  await controller.init();
  await settle();

  assert.deepEqual(completeCalls(calls).length, 1, 'the Finish path ran exactly once');
  assert.equal(state.setup.setupComplete, true, 'the persist echo landed');
});

test('the auto-finish is latched: a re-applied snapshot never calls complete again', async (t) => {
  const { controller, calls } = harness(t);

  controller.bind();
  await controller.init();
  await settle();
  assert.equal(completeCalls(calls).length, 1);

  // Everything that can re-enter applySnapshot: a refresh that re-reads the
  // now-complete state, and a direct re-apply of the same payload.
  await controller.refresh();
  controller.applySnapshot(normalizeSetupPayload(backendPayload({ setupComplete: true })));
  await controller.refresh();
  await settle();

  assert.equal(completeCalls(calls).length, 1, 'still exactly one complete() across every re-apply');
});

/* The spin the latch actually exists for -- and it is the ONLY guard now that
 * the card's render-key skip is gone: every applySnapshot re-enters the
 * eligibility check unconditionally. This backend acknowledges the finish
 * WITHOUT flipping setup_complete and hands back a snapshot whose step map
 * differs (done <-> skipped on an optional step), so the state stays
 * every-step-reviewed and gate-open, i.e. still eligible. Without the
 * once-latch this is an unbounded completeSetup -> applySnapshot ->
 * completeSetup loop. */
test('a complete() that echoes back still-incomplete does not spin the render loop', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  t.after(() => dom.window.close());
  const { document } = dom.window;

  let completes = 0;
  const state = {};
  const controller = createSetupController({
    state,
    documentRef: document,
    setupService: {
      async getState() { return normalizeSetupPayload(backendPayload()); },
      async updateState() { return null; },
      async complete() {
        completes += 1;
        if (completes > 20) throw new Error('auto-finish spun the render loop');
        // Acknowledged, flag not flipped, and the step map moved (skills flips
        // between two TERMINAL values, so health and canFinish are unchanged).
        // The echo is therefore still eligible, and only the latch stops the
        // next attempt.
        return normalizeSetupPayload(backendPayload({
          setupComplete: false,
          steps: { ...ALL_DONE_STEPS, skills: completes % 2 ? 'skipped' : 'done' },
        }));
      },
      async reset() { return normalizeSetupPayload(backendPayload()); },
      subscribePullProgress() { return () => {}; },
    },
    dom: { homeSetupModalRoot: null },
    modules: { scenes: {} },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      showToastMessage: () => {},
      setActiveView: () => {},
    },
  });
  t.after(() => controller.dispose());

  controller.bind();
  await controller.init();
  await settle();
  await settle();

  assert.equal(completes, 1, 'one attempt, then the latch holds despite the unchanged state');
  assert.equal(state.setup.setupComplete, false, 'and nothing was persisted, correctly');
});

test('a still-pending step refuses the auto-finish', async (t) => {
  const { controller, state, calls } = harness(t, {
    steps: { ...ALL_DONE_STEPS, capabilities: 'pending' },
  });

  controller.bind();
  await controller.init();
  await settle();

  assert.equal(completeCalls(calls).length, 0, 'a step still under review blocks the auto-finish');
  assert.equal(state.setup.setupComplete, false);
});

test('every step reviewed but the gate closed refuses the auto-finish', async (t) => {
  // Reviewed does not mean ready: skipping workspace root leaves health short of
  // 'complete', which is exactly the state a disabled Finish button describes.
  const { controller, state, calls } = harness(t, {
    steps: { ...ALL_DONE_STEPS, workspace_root: 'skipped' },
    readiness: {
      workspace_root: { ready: false, configured: false, status: 'missing' },
      local_model: { ready: true, source: 'model_catalog', model_count: 1 },
    },
  });

  controller.bind();
  await controller.init();
  await settle();

  assert.equal(completeCalls(calls).length, 0, 'canFinish false must never auto-finish');
  assert.equal(state.setup.setupComplete, false);
});

test('an already-complete setup calls nothing', async (t) => {
  const { controller, state, calls } = harness(t, { setupComplete: true });

  controller.bind();
  await controller.init();
  await settle();

  assert.equal(completeCalls(calls).length, 0, 'no redundant complete() for a finished setup');
  assert.equal(state.setup.setupComplete, true);
});

/* Settings' "Run setup again" (renderer-shell-state-runtime-utils.js
 * handleRunSetupAgain) persists setupComplete:false, applies the snapshot --
 * landing a fully-reviewed, gate-open, incomplete state -- and calls
 * resumeSetup() in the SAME synchronous run. The auto-finish defers
 * its decision to a microtask precisely so the flow wins that race; otherwise it
 * would undo the reset the user just asked for. */
test('Run-setup-again re-opens the flow instead of being auto-finished out from under it', async (t) => {
  const mounted = [];
  const scene = (deps) => { mounted.push(deps); return { mount() {}, dispose() {} }; };
  const {
    controller, state, calls,
  } = harness(t, {
    setupComplete: true,
    scenes: { setupHub: scene },
  });

  controller.bind();
  await controller.init();
  await settle();
  assert.equal(completeCalls(calls).length, 0, 'nothing to finish: it was already complete');

  // Replays handleRunSetupAgain's ordering exactly.
  controller.applySnapshot(normalizeSetupPayload(backendPayload({ setupComplete: false })));
  controller.resumeSetup();
  await settle();

  assert.ok(mounted.length > 0, 'the guided flow re-opened');
  assert.equal(completeCalls(calls).length, 0, 'the auto-finish stood down for the flow');
  assert.equal(state.setup.setupComplete, false, 'the reset the user asked for survives');
});

test('an active flow stands the auto-finish down, and Settings can still re-open setup', async (t) => {
  const mounted = [];
  function mockScene(deps) {
    mounted.push(deps);
    return { mount() {}, dispose() {} };
  }
  const {
    controller, state, calls, views,
  } = harness(t, {
    scenes: { setupHub: mockScene },
  });

  controller.bind();
  await controller.init();
  await settle();
  assert.equal(state.setup.setupComplete, true, 'setup persisted itself first');

  // The Settings entry point: showFromSettings routes back to Home...
  controller.showFromSettings();
  assert.equal(views.at(-1), 'home');

  // ...and "Run setup again" still mounts the guided flow even though setup now
  // reports complete -- resumeSetup gates on the STEPS, never on setupComplete.
  const before = mounted.length;
  const flow = controller.resumeSetup();
  assert.ok(flow, 'a flow was constructed');
  assert.ok(mounted.length > before, 'the flow mounted a scene');

  // And the auto-finish does not fire again behind the open flow.
  const completesBefore = completeCalls(calls).length;
  controller.applySnapshot(normalizeSetupPayload(backendPayload({ setupComplete: false })));
  await settle();
  assert.equal(completeCalls(calls).length, completesBefore);
});
