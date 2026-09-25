'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeRootService,
} = require('../renderer/shell/renderer-shell-ide-root-service');

test('IDE root service threads workspace session activation into the IDE controller', async () => {
  const calls = [];
  let ideDeps = null;
  const service = createIdeRootService({
    state: { ui: { ide: { openTabs: [] } } },
    callbacks: {
      activateWorkspaceSession: async (sessionId) => { calls.push(sessionId); },
    },
    ideControllerUtils: {
      createIdeController: (deps) => { ideDeps = deps; return {}; },
    },
  });

  service.ensureIdeController();
  await ideDeps.callbacks.activateWorkspaceSession('session-2');
  assert.deepEqual(calls, ['session-2']);
});

test('the shell subscribes to trusted external-transition requests and responds after renderer settlement', async () => {
  const calls = [];
  const responses = [];
  const cleanups = [];
  let listener = null;
  let unsubscribed = 0;
  let transitionDeps = null;
  const confirmations = [];
  const bridge = {
    onExternalTransitionRequested(callback) {
      listener = callback;
      return () => { unsubscribed += 1; listener = null; };
    },
    async respondExternalTransition(payload) {
      responses.push(payload);
      return { accepted: true };
    },
  };
  const transitionController = {
    async external(payload) {
      calls.push(payload);
      return {
        committed: true,
        changed: true,
        canceled: false,
        blocked: false,
        rolledBack: false,
        degraded: false,
        code: '',
        transitionId: 'transition-8',
        context: { rootPath: 'G:/root-b', rootId: 'root-b', generation: 8, phase: 'ready' },
      };
    },
  };
  createIdeRootService({
    state: { ui: { ide: { openTabs: [] } } },
    windowRef: { jennyShell: { workspaceRoot: bridge } },
    registerCleanup: (cleanup) => cleanups.push(cleanup),
    ideControllerUtils: {
      createIdeController: () => ({
        getCloseOrchestrator: () => ({}),
        getConfirmDialog: () => ({
          confirm: async (payload) => { confirmations.push(payload); return true; },
        }),
      }),
    },
    transitionUtils: {
      createWorkspaceRootTransitionController: (deps) => {
        transitionDeps = deps;
        return transitionController;
      },
    },
  });

  assert.equal(typeof listener, 'function', 'subscription is installed before the IDE view is opened');
  const request = {
    request_id: 'external-8',
    transition_id: 'transition-8',
    deadline_ms: 10_000,
    previous: { root_path: 'G:/root-a', root_id: 'root-a', generation: 7, phase: 'ready' },
    candidate: { root_path: 'G:/root-b', root_id: 'root-b', generation: 8, phase: 'transitioning' },
  };
  await listener(request);

  assert.deepEqual(calls, [request]);
  assert.equal(await transitionDeps.confirmProcessTermination(), true);
  assert.deepEqual(confirmations, [{
    title: 'Stop active workspace processes?',
    message: 'Active terminals and test runs belong to the current workspace and must stop before switching workspaces.',
    confirmLabel: 'Stop and Switch',
    cancelLabel: 'Cancel',
    variant: 'danger',
  }]);
  assert.deepEqual(responses, [{
    request_id: 'external-8',
    transition_id: 'transition-8',
    outcome: {
      committed: true,
      changed: true,
      canceled: false,
      blocked: false,
      rolled_back: false,
      degraded: false,
      code: '',
      context: { root_path: 'G:/root-b', root_id: 'root-b', generation: 8, phase: 'ready' },
    },
  }]);

  // Two cleanups: the lazy project-switcher disposal fence (registered at
  // creation, Projects v2) and the external-request unsubscribe.
  assert.equal(cleanups.length, 2);
  cleanups.forEach((cleanup) => cleanup());
  assert.equal(unsubscribed, 1);
});

test('root service reports blocked and degraded transition outcomes through distinct feedback', async () => {
  const toasts = [];
  const logs = [];
  let transitionDeps = null;
  const controller = {
    async choose() {
      const outcome = { committed: false, blocked: true, canceled: false, code: 'participants_active' };
      transitionDeps.onFailure(outcome);
      return outcome;
    },
    async clear() {
      return { committed: true, changed: true, degraded: true, mode: 'clear', code: 'ui_commit_failed' };
    },
  };
  const service = createIdeRootService({
    state: { ui: { ide: { openTabs: [] } } },
    windowRef: { jennyShell: { workspaceRoot: {} } },
    callbacks: {
      appendClientLog: (...args) => logs.push(args),
      showShellErrorToast: (...args) => toasts.push(args),
    },
    ideControllerUtils: {
      createIdeController: () => ({ getCloseOrchestrator: () => ({}) }),
    },
    transitionUtils: {
      createWorkspaceRootTransitionController: (deps) => { transitionDeps = deps; return controller; },
    },
  }).workspaceRootService;

  assert.equal((await service.choose()).code, 'participants_active');
  assert.equal((await service.clear()).degraded, true);
  assert.match(toasts[0][0], /switch blocked/i);
  assert.equal(toasts[0][1].dedupeKey, 'workspace-root:transition-blocked');
  assert.match(toasts[1][0], /views may be stale/i);
  assert.equal(toasts[1][1].title, 'Workspace Refresh Incomplete');
  assert.equal(logs.some((entry) => entry[1] === 'workspace.root_transition_degraded'), true);
});

test('root service surfaces a specific .jenny-state-directory explanation instead of the generic blocked toast', async () => {
  const toasts = [];
  let transitionDeps = null;
  const controller = {
    async choose() {
      const outcome = {
        committed: false, blocked: true, canceled: false, code: 'workspace_root_is_state_dir',
      };
      transitionDeps.onFailure(outcome);
      return outcome;
    },
  };
  const service = createIdeRootService({
    state: { ui: { ide: { openTabs: [] } } },
    windowRef: { jennyShell: { workspaceRoot: {} } },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: (...args) => toasts.push(args),
    },
    ideControllerUtils: {
      createIdeController: () => ({ getCloseOrchestrator: () => ({}) }),
    },
    transitionUtils: {
      createWorkspaceRootTransitionController: (deps) => { transitionDeps = deps; return controller; },
    },
  }).workspaceRootService;

  assert.equal((await service.choose()).code, 'workspace_root_is_state_dir');
  assert.equal(toasts.length, 1, 'the state-dir explanation replaces the generic blocked toast');
  assert.match(toasts[0][0], /internal state directory/i);
  assert.equal(toasts[0][1].dedupeKey, 'workspace-root:state-dir-rejected');
});

// F33: a folder picked on a surface other than the switcher (welcome page,
// Settings > Tools, the composer nudge) syncs the lazy switcher after the
// commit. The "is it new?" baseline must be read before the dialog opens.
function createFacadeWithSwitcher(t, { listed, choose }) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const win = dom.window;
  win.rendererProjectMenu = require('../renderer/features/renderer-project-menu');
  win.rendererProjectSwitcher = require('../renderer/features/renderer-project-switcher');
  win.jennyShell = { workspaceRoot: {}, projects: { async list() { return { ok: true, projects: listed.slice() }; } } };
  const toasts = [];
  const cleanups = [];
  const state = { ui: { ide: { openTabs: [] } }, workspaceRoot: { path: 'D:\\Projects\\Sandbox' }, sessions: [] };
  const root = createIdeRootService({
    state,
    windowRef: win,
    registerCleanup: (cleanup) => cleanups.push(cleanup),
    callbacks: { showToastMessage: (message) => toasts.push(message), appendClientLog: () => {} },
    ideControllerUtils: { createIdeController: () => ({ getCloseOrchestrator: () => ({}) }) },
    transitionUtils: { createWorkspaceRootTransitionController: () => ({ choose: () => choose({ state, root }) }) },
  });
  t.after(() => cleanups.forEach((cleanup) => cleanup()));
  return { root, toasts, state };
}

const SANDBOX = { id: 'project_sandbox', name: 'Sandbox', root_path: 'D:\\Projects\\Sandbox', authority_key: 's:1' };
const FIXTURE = { id: 'project_fixture', name: 'a2-fixture-project', root_path: 'D:\\Projects\\a2-fixture-project', authority_key: 'f:1' };
const GENERAL = { id: 'project_general', name: 'General', root_path: null, authority_key: 'g:0' };

test('F33: a folder picked elsewhere provisions a project that the switcher lists and announces once, even when the switcher first loads during the commit', async (t) => {
  const listed = [GENERAL, SANDBOX];
  const { root, toasts } = createFacadeWithSwitcher(t, {
    listed,
    async choose({ state, root: facade }) {
      listed.push(FIXTURE); // main provisions the folder's project inside the commit
      state.workspaceRoot.path = FIXTURE.root_path;
      // The commit's UI work paints the Explorer header, whose first paint
      // kicks the lazy switcher load plus a list read (renderer-ide-explorer-wiring.js).
      const switcher = await facade.workspaceRootService.getProjectSwitcher();
      await switcher.refresh();
      return { committed: true, changed: true, mode: 'choose' };
    },
  });
  const outcome = await root.workspaceRootService.choose();
  assert.equal(outcome.committed, true);
  const switcher = root.workspaceRootService.peekProjectSwitcher();
  assert.equal(switcher.currentProject().id, 'project_fixture');
  assert.ok(switcher.switcherRows().some((row) => row.id === 'project_fixture'), 'the switcher lists the new project');
  assert.deepEqual(toasts, ['New project "a2-fixture-project" from D:\\Projects\\a2-fixture-project. New chats start here.']);
});

test('F33: a folder picked elsewhere whose project already exists is not announced as new, even when the switcher was never loaded', async (t) => {
  const listed = [GENERAL, SANDBOX, FIXTURE];
  const { root, toasts } = createFacadeWithSwitcher(t, {
    listed,
    async choose({ state }) {
      state.workspaceRoot.path = FIXTURE.root_path;
      return { committed: true, changed: true, mode: 'choose' };
    },
  });
  await root.workspaceRootService.choose();
  assert.equal(root.workspaceRootService.peekProjectSwitcher().currentProject().id, 'project_fixture');
  assert.deepEqual(toasts, []);
});

test('root service fails closed and reports controller initialization errors', async () => {
  const toasts = [];
  const logs = [];
  const service = createIdeRootService({
    state: { ui: { ide: { openTabs: [] } } },
    windowRef: { jennyShell: { workspaceRoot: {} } },
    callbacks: {
      appendClientLog: (...args) => logs.push(args),
      showShellErrorToast: (...args) => toasts.push(args),
    },
    ideControllerUtils: {
      createIdeController: () => ({ getCloseOrchestrator: () => ({}) }),
    },
    transitionUtils: {
      createWorkspaceRootTransitionController: () => {
        const error = new Error('construction failed');
        error.code = 'controller_fixture_failed';
        throw error;
      },
    },
  }).workspaceRootService;

  const result = await service.choose();

  assert.equal(result.committed, false);
  assert.equal(result.code, 'transition_controller_init_failed');
  assert.equal(result.error.code, 'controller_fixture_failed');
  assert.match(toasts[0][0], /switch blocked/i);
  assert.equal(logs.some((entry) => entry[1] === 'workspace.root_transition_init_failed'), true);
});
