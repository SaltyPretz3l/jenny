'use strict';

// Projects v2 (2026-09-20): switching the Workspace to a project by ID. The
// transition's 'project' mode asks main to resolve the folder
// (workspaceRoot.prepareProject({ project_id })) and then runs the same
// preflight/commit path as choose/clear. The facade exposes switchToProject,
// names the two refusal codes in its toast, and lazily loads the shared
// project switcher once per window.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createWorkspaceRootTransitionController } = require('../renderer/shell/renderer-workspace-root-transition');
const { createIdeRootService } = require('../renderer/shell/renderer-shell-ide-root-service');

const OLD_CONTEXT = Object.freeze({ rootPath: 'G:/root-a', rootId: 'root-a', generation: 7, phase: 'ready' });
const CANDIDATE_CONTEXT = Object.freeze({ rootPath: 'G:/projects/ascend', rootId: 'root-b', generation: 8, phase: 'transitioning' });
const NEW_CONTEXT = Object.freeze({ ...CANDIDATE_CONTEXT, phase: 'ready' });

test("mode 'project' prepares through bridge.prepareProject with the project id only, then preflights and commits like choose", async () => {
  const events = [];
  let context = OLD_CONTEXT;
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => context,
      prepareChoose: async () => { throw new Error('unexpected choose'); },
      prepareProject: async (payload) => {
        events.push(['prepareProject', payload]);
        return { prepared: true, transitionId: 'transition-p', canceled: false, changed: true, candidate: CANDIDATE_CONTEXT, previous: OLD_CONTEXT };
      },
      commit: async (payload) => {
        events.push(['commit', payload]);
        context = NEW_CONTEXT;
        return { committed: true, changed: true, context: NEW_CONTEXT };
      },
    },
    closeOrchestrator: {
      preflight: async (paths) => { events.push(['preflight', paths]); return { ready: true, decision: 'discard', paths }; },
      commit: (plan) => ({ committed: true, closedPaths: plan.paths }),
      cancel: () => {},
    },
    getOpenPaths: () => ['old.js'],
    onCommitted: async () => { events.push('uiCommit'); },
  });

  const result = await controller.project({ projectId: 'project_ascend' });

  assert.equal(result.committed, true);
  assert.equal(result.mode, 'project');
  assert.deepEqual(events[0], ['prepareProject', { project_id: 'project_ascend' }]);
  assert.deepEqual(events[1], ['preflight', ['old.js']]);
  assert.deepEqual(events[2], ['commit', { transitionId: 'transition-p', terminateProcesses: false }]);
  assert.equal(events[3], 'uiCommit');
});

test('a refused project switch keeps the coordinator code and blocks without touching preflight', async () => {
  const events = [];
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareProject: async () => ({ prepared: false, blocked: true, changed: false, code: 'project_root_unavailable' }),
    },
    closeOrchestrator: { preflight: async () => { events.push('preflight'); return { ready: true }; }, commit: () => ({}), cancel: () => {} },
  });
  const result = await controller.project({ projectId: 'project_loose' });
  assert.equal(result.committed, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'project_root_unavailable');
  assert.deepEqual(events, []);
});

function makeService({ transitionController, windowRef, callbacks = {} } = {}) {
  return createIdeRootService({
    state: { ui: { ide: { openTabs: [] } }, workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [] },
    windowRef: windowRef || {},
    callbacks,
    ideControllerUtils: { createIdeController: () => ({ getCloseOrchestrator: () => ({ preflight() {}, commit() {}, cancel() {} }) }) },
    transitionUtils: { createWorkspaceRootTransitionController: () => transitionController },
  });
}

test('the facade routes switchToProject to the project transition and names the refusals', async () => {
  const calls = [];
  const toasts = [];
  let outcome = { committed: true, changed: true, mode: 'project' };
  const service = makeService({
    transitionController: { async project(request) { calls.push(request); return outcome; } },
    callbacks: { showShellErrorToast: (message, meta) => toasts.push({ message, meta }) },
  });
  const result = await service.workspaceRootService.switchToProject('project_ascend');
  assert.equal(result.committed, true);
  assert.deepEqual(calls, [{ projectId: 'project_ascend' }]);
  assert.deepEqual(toasts, []);

  outcome = { committed: false, blocked: true, mode: 'project', code: 'project_not_found' };
  // The transition controller's own onFailure is what toasts in production;
  // the facade supplies the copy. Drive it directly the way the controller does.
  const transitionDeps = [];
  const probe = createIdeRootService({
    state: { ui: { ide: { openTabs: [] } } },
    callbacks: { showShellErrorToast: (message, meta) => toasts.push({ message, meta }) },
    ideControllerUtils: { createIdeController: () => ({ getCloseOrchestrator: () => ({}) }) },
    transitionUtils: { createWorkspaceRootTransitionController: (deps) => { transitionDeps.push(deps); return { project: async () => outcome }; } },
  });
  await probe.workspaceRootService.switchToProject('project_gone');
  transitionDeps[0].onFailure({ code: 'project_not_found', blocked: true });
  transitionDeps[0].onFailure({ code: 'project_root_unavailable', blocked: true });
  assert.deepEqual(toasts.map((toast) => toast.message), [
    'That project no longer exists.',
    'That project has no folder to open.',
  ]);
});

test('the facade loads the project menu + switcher lazily through scriptLoaderUtils, once per window, and hands every surface the same instance', async () => {
  const loads = [];
  const windowRef = {
    scriptLoaderUtils: {
      async ensureScript({ src }) {
        loads.push(src);
        if (src.endsWith('renderer-project-menu.js')) windowRef.rendererProjectMenu = require('../renderer/features/renderer-project-menu');
        else windowRef.rendererProjectSwitcher = require('../renderer/features/renderer-project-switcher');
        return true;
      },
    },
    jennyShell: { projects: { async list() { return { projects: [{ id: 'project_ascend', name: 'Ascend', root_path: 'D:\\Projects\\Ascend', authority_key: 'x:1' }] }; } } },
  };
  const service = makeService({ transitionController: {}, windowRef });
  assert.equal(service.workspaceRootService.peekProjectSwitcher(), null);
  const [a, b] = await Promise.all([service.workspaceRootService.getProjectSwitcher(), service.workspaceRootService.getProjectSwitcher()]);
  assert.ok(a);
  assert.equal(a, b, 'one instance per window');
  assert.deepEqual(loads, ['renderer/features/renderer-project-menu.js', 'renderer/features/renderer-project-switcher.js']);
  assert.equal(service.workspaceRootService.peekProjectSwitcher(), a);
  await a.refresh();
  assert.equal(a.title(), 'Ascend', 'the switcher reads the same state and shell bridge as the facade');
});
