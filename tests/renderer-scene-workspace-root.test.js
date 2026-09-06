'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createScene,
  projectWorkspaceRootPayload,
} = require('../renderer/features/setup-scenes/scene-workspace-root');

test('workspace scene projects the committed transition context over stale cached state', () => {
  const projection = projectWorkspaceRootPayload({
    workspaceRoot: {
      path: 'C:\\dev\\old',
      status: { state: 'ready', message: 'Old root.' },
    },
    transition: {
      committed: true,
      context: { rootPath: 'C:\\dev\\new', phase: 'ready' },
    },
  }, '');

  assert.deepEqual(projection, {
    path: 'C:\\dev\\new',
    status: { state: 'ready', message: 'Workspace root is configured.' },
  });
});

test('workspace scene clear action clears the field and returns the setup step to pending', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const marks = [];
  const toasts = [];
  const state = {
    toolsWorkspaceRoot: 'C:\\dev\\demo',
    toolsWorkspaceRootConfigured: true,
    workspaceRootStatus: { state: 'ready', message: 'Ready.' },
  };
  const scene = createScene({
    state,
    workspaceRootService: {
      getState: async () => ({
        workspaceRoot: 'C:\\dev\\demo',
        workspaceRootStatus: { state: 'ready', message: 'Ready.' },
      }),
      clear: async () => ({
        workspaceRoot: { path: 'C:\\dev\\demo', status: { state: 'ready' } },
        transition: {
          committed: true,
          changed: true,
          context: { rootPath: '', rootId: null, phase: 'ready' },
        },
      }),
    },
    markStep: async (name, status) => { marks.push([name, status]); },
    showToastMessage: (message) => { toasts.push(message); },
  });
  t.after(() => {
    scene.dispose();
    dom.window.close();
  });

  scene.mount(rootEl);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const clearButton = rootEl.querySelector('[data-step-modal-action="clear"]');
  assert.ok(clearButton, 'configured roots expose an explicit clear action');
  clearButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(state.toolsWorkspaceRoot, '');
  assert.equal(state.toolsWorkspaceRootConfigured, false);
  assert.equal(rootEl.querySelector('#setup-workspace-root-path').value, '');
  assert.equal(rootEl.querySelector('[data-step-modal-action="clear"]'), null);
  assert.deepEqual(marks, [['workspaceRoot', 'pending']]);
  assert.deepEqual(toasts, ['Workspace root cleared.']);
});

test('workspace scene ignores a stale mount refresh after a newer picker commit', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  let resolveInitialState;
  const initialState = new Promise((resolve) => { resolveInitialState = resolve; });
  const state = {
    toolsWorkspaceRoot: '',
    toolsWorkspaceRootConfigured: false,
    workspaceRootStatus: { state: 'missing', message: 'Missing.' },
  };
  const scene = createScene({
    state,
    workspaceRootService: {
      getState: async () => initialState,
      choose: async () => ({
        committed: true,
        changed: true,
        context: { rootPath: 'C:\\dev\\new', phase: 'ready' },
      }),
    },
    markStep: async () => {},
  });
  t.after(() => {
    scene.dispose();
    dom.window.close();
  });

  scene.mount(rootEl);
  rootEl.querySelector('[data-step-modal-action="browse"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolveInitialState({
    workspaceRoot: 'C:\\dev\\old',
    workspaceRootStatus: { state: 'ready', message: 'Old root.' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(state.toolsWorkspaceRoot, 'C:\\dev\\new');
  assert.equal(state.workspaceRootStatus.state, 'ready');
});

test('workspace scene serializes picker transitions and renders failures inside the modal', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  let resolvePicker;
  let chooseCalls = 0;
  const picker = new Promise((resolve) => { resolvePicker = resolve; });
  const scene = createScene({
    state: {
      toolsWorkspaceRoot: '',
      toolsWorkspaceRootConfigured: false,
      workspaceRootStatus: { state: 'missing', message: 'Missing.' },
    },
    chooseWorkspaceRoot: async () => {
      chooseCalls += 1;
      return picker;
    },
    markStep: async () => {},
  });
  t.after(() => {
    scene.dispose();
    dom.window.close();
  });

  scene.mount(rootEl);
  rootEl.querySelector('[data-step-modal-action="browse"]').click();
  assert.equal(rootEl.querySelector('[data-step-modal-action="browse"]').disabled, true);
  rootEl.querySelector('[data-step-modal-action="browse"]').click();
  assert.equal(chooseCalls, 1, 'a second click cannot begin another transition');

  resolvePicker({
    transition: {
      committed: false,
      noop: false,
      error: 'The selected folder is inside the Jenny installation.',
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const alert = rootEl.querySelector('[role="alert"]');
  assert.ok(alert, 'the failure is rendered within the modal');
  assert.match(alert.textContent, /inside the Jenny installation/i);
  assert.equal(rootEl.querySelector('[data-step-modal-action="browse"]').disabled, false);
});

test('workspace scene does not advance when disposed during an in-flight skip', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  let resolveMark;
  const pendingMark = new Promise((resolve) => { resolveMark = resolve; });
  let closeCalls = 0;
  const scene = createScene({
    state: {
      toolsWorkspaceRoot: '',
      toolsWorkspaceRootConfigured: false,
      workspaceRootStatus: { state: 'missing', message: 'Missing.' },
    },
    markStep: async () => pendingMark,
    closeModal: () => { closeCalls += 1; },
  });
  t.after(() => dom.window.close());

  scene.mount(rootEl);
  rootEl.querySelector('[data-step-modal-action="skip"]').click();
  scene.dispose();
  resolveMark();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(closeCalls, 0);
});
