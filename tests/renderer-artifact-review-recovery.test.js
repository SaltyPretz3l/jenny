'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createArtifactManager } = require('../renderer/features/renderer-artifacts-utils');
const { createArtifactPanelV2 } = require('../renderer/features/renderer-artifact-panel-v2-render');

function setup(t, { failRead = false, empty = false, v3 = true } = {}) {
  const dom = new JSDOM('<body><button id="opener">Open</button><div id="workspace"><div id="chatView"><aside id="artifactReviewPanel"></aside></div></div>', { url: 'https://jenny.test' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const doc = dom.window.document;
  const file = { artifact_id: 'a', artifact_kind: 'document', file_name: 'a.py', language: 'python', editable: true, status: 'available' };
  const message = { id: 'm', role: 'tool', kind: 'tool_result', tool_result: { call_id: 'c', tool_name: 'create_artifact', generated_artifacts: [file] } };
  const state = { currentSessionId: 's', ui: { activeView: 'chat', artifactReview: {} }, artifacts: { autoOpenedSessionIds: [], deletedArtifactIds: [] }, messagesBySession: new Map([['s', empty ? [] : [message]]]), features: { featureFlags: { artifact_panel_v2: true, artifact_panel_v3: v3 } } };
  dom.window.localStorage.setItem('jenny.artifactReview.v1', JSON.stringify({ enabled: true, collapsed: false, width: 420 }));
  let reads = 0;
  let fail = failRead;
  dom.window.jennyShell = { artifacts: { read: async () => {
    reads++;
    if (fail) throw new Error('Read denied');
    return { artifact: { editable: true, status: 'available' }, content: 'print(1)' };
  } } };
  dom.window.rendererMonacoEditorUtils = { createArtifactEditor: () => ({ setDocument: async () => {}, onDidChange: () => () => {}, dispose: () => {} }) };
  const panelEl = doc.getElementById('artifactReviewPanel');
  const chrome = createArtifactPanelV2({ panelEl, state, windowRef: dom.window });
  chrome.installed();
  const nodes = Object.fromEntries([...doc.querySelectorAll('[id]')].map(node => [node.id, node]));
  nodes.workspace.getBoundingClientRect = () => ({ width: 800 });
  const manager = createArtifactManager({ state, dom: nodes, callbacks: {
    getActiveSession: () => ({ id: 's' }), escapeHtml: value => String(value || '').replaceAll('<', '&lt;'), appendClientLog: () => {},
    panelV2: chrome,
  } });
  chrome.connect({ getArtifacts: () => manager.getArtifactsForSession('s'), getSelectedArtifactSource: () => manager.getSelectedArtifactSource() });
  manager.bind(); chrome.bind();
  t.after(() => { manager.dispose(); chrome.dispose(); dom.window.close(); globalThis.window = previousWindow; globalThis.document = previousDocument; });
  return { doc, dom, manager, state, panelEl, reads: () => reads, recover: () => { fail = false; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const v3 of [true, false]) {
  test(`real manager settles a failed read, exposes Retry, and recovers (V3=${v3})`, async t => {
    const h = setup(t, { failRead: true, v3 });
    h.manager.renderArtifactReviewPanel();
    await settle();
    assert.equal(h.reads(), 1);
    h.manager.renderArtifactReviewPanel();
    h.manager.renderArtifactReviewPanel();
    await settle();
    assert.equal(h.reads(), 1, 'incidental renders must not retry');
    const retry = h.doc.getElementById('artifactReviewRevertButton');
    assert.equal(retry.textContent, 'Retry');
    assert.equal(retry.classList.contains('hidden'), false);
    assert.equal(retry.disabled, false);
    assert.equal(h.doc.getElementById('artifactReviewDetailNote').classList.contains('hidden'), false);
    assert.equal(h.panelEl.querySelector('[data-artifact-panel-v2-copy]').disabled, true);
    h.recover(); retry.click();
    await settle();
    assert.equal(h.reads(), 2);
    assert.equal(h.manager.getSelectedArtifactSource(), 'print(1)');
    assert.equal(retry.classList.contains('hidden'), true);
    assert.equal(h.panelEl.querySelector('[data-artifact-panel-v2-copy]').disabled, false);
  });
}

test('explicit drawer open focuses its close control; Escape restores the opener without stealing child Escape', async t => {
  const h = setup(t, { empty: true });
  const opener = h.doc.getElementById('opener');
  opener.focus();
  await h.manager.openArtifactTarget('');
  assert.equal(h.doc.activeElement.id, 'artifactReviewCollapseButton');
  const handled = new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  handled.preventDefault(); h.panelEl.dispatchEvent(handled);
  assert.equal(h.manager.isArtifactReviewVisible(), true);
  h.manager.toggleArtifactReviewMaximized(true); // persisted wide-layout preference must not consume drawer Escape
  h.panelEl.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(h.manager.isArtifactReviewVisible(), false);
  assert.equal(h.doc.activeElement, opener);
});

test('copying a loaded empty draft clears the clipboard instead of silently doing nothing', async t => {
  const h = setup(t);
  h.manager.renderArtifactReviewPanel();
  await settle();
  h.state.artifacts.dirtyContent = '';
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { copied.push(text); } } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; });
  await h.manager.copySelectedArtifactSource();
  assert.deepEqual(copied, ['']);
});

test('empty conversation retains an honest empty state with no export controls enabled', t => {
  const h = setup(t, { empty: true });
  h.manager.renderArtifactReviewPanel();
  assert.match(h.doc.getElementById('artifactReviewDetailEmpty').textContent, /No artifacts in this conversation/);
  assert.equal(h.panelEl.querySelector('[data-artifact-panel-download]').disabled, true);
  assert.equal(h.panelEl.querySelector('[data-artifact-panel-v2-copy]').disabled, true);
});
