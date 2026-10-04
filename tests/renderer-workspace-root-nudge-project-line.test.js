'use strict';

// Projects v2 (2026-09-20): the composer's project pill, beside the run-mode
// and model pills. It names the current chat's project (General included),
// is not gated by the nudge flag, and opens the shared "Move this chat to"
// menu (the switcher's move engine, idle-only). It never switches the
// Workspace. Names come from the switcher's one project cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createWorkspaceRootNudgeController } = require('../renderer/features/renderer-workspace-root-nudge');
const { createProjectSwitcher } = require('../renderer/features/renderer-project-switcher');

const stubMenu = { isOpen: () => false, close() {}, show() { return null; }, dispose() {} };

function makeDom() {
  return new JSDOM('<!doctype html><html><body><div class="composer-wrap" id="composerWrap"><div class="composer" id="composerRoot"><div class="composer-rail"><div class="composer-project-pill-slot" id="composerProjectPillSlot"></div><div id="composerRunModeSlot"></div></div></div></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// A real switcher (the one project cache) with an optional openMoveMenu stub.
function makeHarness(t, { state, openMoveMenu } = {}) {
  const dom = makeDom();
  const calls = { list: 0 };
  const api = { async list() { calls.list += 1; return { ok: true, projects: [
    { id: 'project_ascend', name: 'Ascend', root_path: 'D:\\Projects\\Ascend' },
    { id: 'project_loose', name: 'Loose', root_path: null },
  ] }; } };
  const switcher = createProjectSwitcher({ state, windowRef: dom.window, documentRef: dom.window.document, menu: stubMenu, getProjectsApi: () => api });
  if (openMoveMenu) switcher.openMoveMenu = openMoveMenu;
  switcher.bind();
  const controller = createWorkspaceRootNudgeController({
    state,
    windowRef: dom.window,
    documentRef: dom.window.document,
    appendClientLog: () => {},
    getProjectsApi: () => api,
    getProjectSwitcher: async () => switcher,
  });
  controller.bind();
  t.after(() => { controller.dispose(); switcher.dispose(); });
  return { dom, controller, calls, pill: () => dom.window.document.getElementById('composerProjectPill'), chip: () => dom.window.document.getElementById('workspaceRootNudge') };
}

function boundState(extra) {
  return {
    features: { featureFlags: { workspace_root_nudge: true } },
    workspaceRoot: { path: 'D:\\Projects\\Ascend', status: { state: 'ready', message: '' } },
    currentSessionId: 'sess_a',
    sessions: [{ id: 'sess_a', title: 'Intake', project_id: 'project_ascend' }],
    ...extra,
  };
}

test('the pill names the chat\'s project with its folder in the title, is a menu button, and leaves nothing above the composer', async (t) => {
  const { controller, pill, chip } = makeHarness(t, { state: boundState() });
  controller.render();
  await settle();
  const button = pill();
  assert.ok(button, 'the pill renders into the composer rail slot');
  assert.ok(button.classList.contains('inv-chip'), 'same chip primitive as the run-mode and model pills');
  assert.equal(button.querySelector('.inv-chip-label').textContent, 'Ascend');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.match(button.getAttribute('aria-label'), /Project: Ascend/);
  assert.match(button.title, /D:\\Projects\\Ascend/);
  assert.equal(chip(), null, 'a bound chat shows no hint above the composer');
});

test('a General chat gets a muted "General" pill (and, under a folder, still the amber "Use <folder>" hint); the pill survives the nudge flag being off', async (t) => {
  const state = boundState({ sessions: [{ id: 'sess_a', title: 'Intake', project_id: 'project_general' }] });
  const { controller, pill, chip } = makeHarness(t, { state });
  controller.render();
  await settle();
  assert.equal(pill().querySelector('.inv-chip-label').textContent, 'General');
  assert.ok(pill().classList.contains('composer-project-pill--general'));
  assert.match(pill().title, /no folder/);
  assert.equal(chip().getAttribute('data-nudge-variant'), 'use-folder');

  const off = makeHarness(t, { state: boundState({ features: { featureFlags: { workspace_root_nudge: false } } }) });
  off.controller.render();
  await settle();
  assert.equal(off.pill().querySelector('.inv-chip-label').textContent, 'Ascend', 'the pill is not a nudge');
  assert.equal(off.chip(), null);
});

test('clicking the pill opens the move menu for THIS chat through the one move engine; no current chat means no pill', async (t) => {
  const opened = [];
  const openMoveMenu = async (anchor, sessionIds, options) => { opened.push({ anchor, sessionIds, options }); };
  const state = boundState();
  const { controller, pill } = makeHarness(t, { state, openMoveMenu });
  controller.render();
  await settle();
  pill().click();
  await settle();
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].sessionIds, ['sess_a']);
  assert.equal(opened[0].options.source, 'composer');
  assert.equal(opened[0].anchor, pill());

  state.currentSessionId = '';
  controller.render();
  assert.equal(pill(), null);
});

test('after a move the pill follows the chat; a rename elsewhere repaints from a fresh list', async (t) => {
  let onMoved = null;
  const openMoveMenu = async (_anchor, _ids, options) => { onMoved = options.onMoved; };
  const state = boundState();
  const { dom, controller, pill, calls } = makeHarness(t, { state, openMoveMenu });
  controller.render();
  await settle();
  pill().click();
  await settle();
  state.sessions[0].project_id = 'project_loose';
  onMoved({ ok: true });
  await settle();
  assert.equal(pill().querySelector('.inv-chip-label').textContent, 'Loose');
  const listed = calls.list;
  dom.window.dispatchEvent(new dom.window.CustomEvent('jenny:projects-changed'));
  await settle();
  assert.ok(calls.list > listed, 'a projects-changed event re-reads the list');
});

test('a rename elsewhere reaches the pill even with the nudge flag off (freshness is judged for every known project)', async (t) => {
  const dom = makeDom();
  let name = 'Before';
  let listed = 0;
  const api = { async list() { listed += 1; return { ok: true, projects: [{ id: 'project_ascend', name, root_path: 'D:\\Projects\\Ascend' }] }; } };
  const state = boundState({ features: { featureFlags: { workspace_root_nudge: false } } });
  const switcher = createProjectSwitcher({ state, windowRef: dom.window, documentRef: dom.window.document, menu: stubMenu, getProjectsApi: () => api });
  switcher.bind();
  const controller = createWorkspaceRootNudgeController({
    state, windowRef: dom.window, documentRef: dom.window.document, appendClientLog: () => {}, getProjectsApi: () => api,
    getProjectSwitcher: async () => switcher,
  });
  controller.bind();
  t.after(() => { controller.dispose(); switcher.dispose(); });
  controller.render();
  await settle();
  const pill = () => dom.window.document.getElementById('composerProjectPill');
  assert.equal(pill().querySelector('.inv-chip-label').textContent, 'Before');
  name = 'After';
  dom.window.dispatchEvent(new dom.window.CustomEvent('jenny:projects-changed', { detail: { source: 'settings' } }));
  await settle();
  await settle();
  assert.ok(listed >= 2, 'the list is re-read');
  assert.equal(pill().querySelector('.inv-chip-label').textContent, 'After');
});
