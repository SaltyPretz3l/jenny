'use strict';

// Projects v2 (2026-09-20): the composer's project pill, beside the run-mode
// and model pills. It names the current chat's project (General included),
// is not gated by the nudge flag, and opens the shared project menu in "move
// this chat" mode (idle-only). It never switches the Workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createWorkspaceRootNudgeController } = require('../renderer/features/renderer-workspace-root-nudge');

function makeDom() {
  return new JSDOM('<!doctype html><html><body><div class="composer-wrap" id="composerWrap"><div class="composer" id="composerRoot"><div class="composer-rail"><div class="composer-project-pill-slot" id="composerProjectPillSlot"></div><div id="composerRunModeSlot"></div></div></div></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function makeHarness(t, { state, switcher } = {}) {
  const dom = makeDom();
  const calls = { list: 0 };
  const api = { async list() { calls.list += 1; return { ok: true, projects: [
    { id: 'project_ascend', name: 'Ascend', root_path: 'D:\\Projects\\Ascend' },
    { id: 'project_loose', name: 'Loose', root_path: null },
  ] }; } };
  const controller = createWorkspaceRootNudgeController({
    state,
    windowRef: dom.window,
    documentRef: dom.window.document,
    appendClientLog: () => {},
    getProjectsApi: () => api,
    getProjectSwitcher: switcher ? async () => switcher : null,
  });
  controller.bind();
  t.after(() => controller.dispose());
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

test('the pill names the chat\'s project with its folder in the title, is a listbox button, and leaves nothing above the composer', async (t) => {
  const { controller, pill, chip } = makeHarness(t, { state: boundState() });
  controller.render();
  await settle();
  const button = pill();
  assert.ok(button, 'the pill renders into the composer rail slot');
  assert.ok(button.classList.contains('inv-chip'), 'same chip primitive as the run-mode and model pills');
  assert.equal(button.querySelector('.inv-chip-label').textContent, 'Ascend');
  assert.equal(button.getAttribute('aria-haspopup'), 'listbox');
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

test('clicking the pill opens the move menu for THIS chat with its idle state; no current chat means no pill', async (t) => {
  const opened = [];
  const switcher = { async openMoveChatMenu(options) { opened.push(options); } };
  const state = boundState();
  const { controller, pill } = makeHarness(t, { state, switcher });
  controller.render();
  await settle();
  pill().click();
  await settle();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].sessionId, 'sess_a');
  assert.equal(opened[0].projectId, 'project_ascend');
  assert.equal(opened[0].idle, true);
  assert.equal(opened[0].anchor, pill());

  state.sessions[0].active_turn = { id: 'turn_1' };
  controller.render();
  pill().click();
  await settle();
  assert.equal(opened[1].idle, false, 'the menu disables its rows while the chat is busy');

  state.currentSessionId = '';
  controller.render();
  assert.equal(pill(), null);
});

test('after a move the pill follows the chat; a rename elsewhere repaints from a fresh list', async (t) => {
  let onMoved = null;
  const switcher = { async openMoveChatMenu(options) { onMoved = options.onMoved; } };
  const state = boundState();
  const { dom, controller, pill, calls } = makeHarness(t, { state, switcher });
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
  const controller = createWorkspaceRootNudgeController({
    state, windowRef: dom.window, documentRef: dom.window.document, appendClientLog: () => {}, getProjectsApi: () => api,
  });
  controller.bind();
  t.after(() => controller.dispose());
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
