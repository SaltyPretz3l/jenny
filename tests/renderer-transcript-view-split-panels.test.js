// new-test-file: split view is its own surface (two panes, one set of real panel buttons); renderer-transcript-view-utils.test.js is at 588 lines.
/* Split view: the real Artifacts, Tasks and Notes buttons are hidden in the first pane; since row 195 the stack's own tabs
   (Artifacts, Project) carry them, so neither pane's More menu lists them or reads their buttons. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const REAL_BUTTONS = '<button data-chat-node="artifactSplitViewToggle" id="artifacts" aria-pressed="true"></button>'
  + '<button id="chatTimelineTasksToggle" aria-pressed="false"></button>'
  + '<button id="chatTimelineNotesToggle" aria-pressed="false"></button>';

function markup({ paneCount }) {
  const second = paneCount === 2
    ? '<div class="chat-pane" id="pane1" data-pane-id="1"><div class="cluster" id="cluster1"></div></div>' : '';
  return `<div class="chat-view" id="chatView"${paneCount === 2 ? ' data-pane-count="2"' : ''}>`
    + `<div class="chat-pane" id="pane0" data-pane-id="0"><div class="cluster" id="cluster0">${REAL_BUTTONS}</div></div>${second}</div>`;
}

// The pane-placement module focuses a pane on pointerdown or focusin inside it; this stands in for it.
function mountSplit(t, { paneCount = 2 } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${markup({ paneCount })}</body></html>`, { url: 'https://jenny.test/' });
  const { window } = dom;
  const doc = window.document;
  const chatView = doc.getElementById('chatView');
  const state = { focusedPane: 0 };
  chatView.addEventListener('focusin', (event) => {
    const paneRoot = event.target.closest('.chat-pane');
    if (paneRoot) state.focusedPane = Number(paneRoot.dataset.paneId);
  });
  doc.querySelectorAll('.chat-pane').forEach((pane) => { pane.getBoundingClientRect = () => ({ width: 900 }); });
  const saved = { build: globalThis.inventoryActionButton, menu: globalThis.inventoryContextMenu, controller: globalThis.rendererTranscriptViewController };
  globalThis.inventoryActionButton = require('../renderer/inventory/action-button.js');
  globalThis.inventoryContextMenu = require('../renderer/inventory/context-menu.js');
  globalThis.rendererTranscriptViewController = { getView: () => 'thinking', setView() {} };
  t.after(() => {
    globalThis.inventoryContextMenu.hide({ restoreFocus: false });
    globalThis.inventoryActionButton = saved.build;
    globalThis.inventoryContextMenu = saved.menu;
    globalThis.rendererTranscriptViewController = saved.controller;
    window.close();
  });
  const { mountTranscriptViewControl } = require('../renderer/chat/renderer-transcript-view-utils.js');
  const mount = (id) => mountTranscriptViewControl({
    cluster: doc.getElementById(id), getSessionId: () => `s-${id}`,
    registerListener: (target, name, handler, options) => target.addEventListener(name, handler, options),
  });
  const controls = [mount('cluster0'), ...(paneCount === 2 ? [mount('cluster1')] : [])];
  const rows = () => [...doc.querySelectorAll('.inv-context-menu > *')].map((row) => (row.getAttribute('role') === 'separator' ? '---'
    : (row.querySelector('.inv-context-menu-text > span') || row.querySelector('span')).textContent));
  return { doc, controls, state, rows };
}

test('split view: neither pane More menu lists Artifacts, Tasks or Notes, shown or hidden buttons alike', (t) => {
  const { controls, doc, rows, state } = mountSplit(t);
  for (const control of controls) {
    control.button.click();
    assert.deepEqual(rows(), ['Answers', 'Thinking', 'Everything', '---', 'Wide transcript']);
    control.button.click();
  }
  doc.getElementById('chatTimelineNotesToggle').hidden = true;
  controls[1].button.click();
  assert.deepEqual(rows(), ['Answers', 'Thinking', 'Everything', '---', 'Wide transcript']);
  assert.equal(state.focusedPane, 0, 'opening a menu does not move pane focus');
});

test('one pane with room: the three stay on the bar and are not listed', (t) => {
  const { controls, rows } = mountSplit(t, { paneCount: 1 });
  controls[0].button.click();
  assert.deepEqual(rows(), ['Answers', 'Thinking', 'Everything', '---', 'Wide transcript']);
});
