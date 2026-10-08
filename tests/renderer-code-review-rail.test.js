'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { JSDOM } = require('jsdom');

const {
  CHANGES_VIEW_SCRIPTS,
  createCodeReviewRail,
  loadChangesViewModules,
} = require('../renderer/features/renderer-code-review-rail');
const changesViewModule = require('../renderer/features/renderer-changes-view');

function change(overrides = {}) {
  return {
    changeId: `c-${overrides.path || 'a.js'}`,
    turnId: 't1',
    toolCallId: 'call_1',
    toolName: 'edit_file',
    path: 'a.js',
    fileKey: `default:${overrides.path || 'a.js'}`,
    status: 'modified',
    callOutcome: 'succeeded',
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' x', '+y'] }],
    ...overrides,
  };
}

const TURNS = [
  { turnId: 't1', rootMessageIds: { user: 'u1' }, user: { content: 'Fix the cap' }, toolCalls: [] },
  { turnId: 't2', rootMessageIds: { user: 'u2' }, user: { content: 'Round prices' }, toolCalls: [] },
];

function buildHarness(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<button id="opener">Review changes</button>'
    + '<div id="chatPane"><article class="chat-entry" tabindex="0">Row 1</article></div>'
    + '<aside id="artifactReviewPanel"><div class="artifact-review-detail-panel"></div><div class="context-empty-state"></div></aside>'
    + '</body></html>');
  const { document } = dom.window;
  const artifactReviewPanel = document.getElementById('artifactReviewPanel');
  const detailPanel = artifactReviewPanel.querySelector('.artifact-review-detail-panel');
  const detailEmpty = artifactReviewPanel.querySelector('.context-empty-state');
  const state = { ui: { artifactReview: { mode: 'artifact' } } };
  const log = [];
  const errors = [];
  const opened = [];
  const changes = options.changes || [change(), change({ path: 'b.js' }), change({ turnId: 't2', path: 'c.js' })];

  function renderRail() {
    if (state.ui.artifactReview.mode !== 'code_review') {
      detailPanel.innerHTML = '';
      return;
    }
    rail.renderRailContent({ key: 'split', detailPanel, detailEmpty });
  }

  const rail = createCodeReviewRail({
    state,
    dom: { artifactReviewPanel },
    loadChangesView: options.loadChangesView || (async () => changesViewModule),
    buildJennyChangeLedgerFromTurnViewModels: () => ({ changes, notices: [] }),
    renderDiffBody: (item) => `<div class="diff-line diff-line-add">${item.path}</div>`,
    getTurnViewModelsForActiveSession: () => TURNS,
    getActiveSessionId: () => 'sess_1',
    getWorkspaceId: () => 'default',
    getSessionMessages: () => options.messages || [],
    openInWorkspace: (changeId) => opened.push(changeId),
    setArtifactRailMode: (mode) => {
      state.ui.artifactReview.mode = mode === 'code_review' ? 'code_review' : 'artifact';
    },
    renderArtifactReviewPanel: renderRail,
    appendClientLog: (level, code, payload) => log.push({ level, code, payload }),
    showComposerActionError: (error, title) => errors.push({ message: error.message, title }),
  });
  rail.bind();
  return { dom, document, rail, artifactReviewPanel, detailPanel, state, log, errors, opened };
}

// openCodeReviewTarget loads the view asynchronously; let the chain settle.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function keydown(h, target, key) {
  const event = new h.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test('CHANGES_VIEW_SCRIPTS loads in order and stops at the first failure', async () => {
  const windowRef = {};
  const loaded = [];
  const ensureScript = async ({ src }) => {
    loaded.push(src);
    const entry = CHANGES_VIEW_SCRIPTS.find(([path]) => path === src);
    windowRef[entry[1]] = entry[1] === 'rendererChangesView' ? changesViewModule : {};
    return true;
  };
  assert.equal(await loadChangesViewModules({ ensureScript, windowRef }), changesViewModule);
  assert.deepEqual(loaded, CHANGES_VIEW_SCRIPTS.map(([src]) => src));
  loaded.length = 0;
  assert.equal(await loadChangesViewModules({ ensureScript, windowRef }), changesViewModule);
  assert.deepEqual(loaded, [], 'already-loaded modules are not fetched again');
  assert.equal(await loadChangesViewModules({ ensureScript: async () => false, windowRef: {} }), null);
});

test('the IDE script manifest lists the same Changes view files', () => {
  const manifest = require('../renderer/shell/renderer-ide-script-manifest');
  const srcs = manifest.map(([src]) => src);
  const positions = CHANGES_VIEW_SCRIPTS.map(([src]) => srcs.indexOf(src));
  assert.ok(positions.every((index) => index >= 0), 'each Changes view file is in the IDE manifest');
  assert.deepEqual(positions.slice().sort((a, b) => a - b), positions, 'in load order');
});

test('opening a turn mounts the Changes view in the side panel and reveals that turn', async () => {
  const h = buildHarness();
  assert.equal(h.rail.openCodeReviewTarget({ scope: 'turn', turnId: 't1' }), true);
  assert.equal(h.state.ui.artifactReview.mode, 'code_review');
  await settle();
  const view = h.detailPanel.querySelector('.changes-view-host .changes-view');
  assert.ok(view);
  assert.equal(view.getAttribute('data-changes-view'), 'panel');
  assert.equal(view.getAttribute('data-changes-mode'), 'history');
  assert.equal(h.document.activeElement.getAttribute('data-changes-item'), 't1::default:a.js');
});

test('opening a file goes straight to its detail page; Open in Workspace passes the change id', async () => {
  const h = buildHarness();
  h.rail.openCodeReviewTarget({ scope: 'file', turnId: 't1', fileKey: 'default:b.js' });
  await settle();
  const view = h.detailPanel.querySelector('.changes-view');
  assert.equal(view.getAttribute('data-changes-mode'), 'detail');
  assert.match(h.detailPanel.querySelector('.changes-detail-diff').textContent, /b\.js/);
  h.detailPanel.querySelector('[data-changes-open-workspace]')
    .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(h.opened, ['c-b.js']);
});

test('turn times come from the session messages', async () => {
  const h = buildHarness({ messages: [{ id: 'u1', timestamp: '2026-10-05T14:41:00Z' }] });
  h.rail.openCodeReviewTarget({ scope: 'session' });
  await settle();
  const t1 = h.detailPanel.querySelector('[data-changes-turn-block="t1"] .changes-history-time');
  const t2 = h.detailPanel.querySelector('[data-changes-turn-block="t2"] .changes-history-time');
  assert.ok(t1 && t1.textContent.trim(), 't1 shows its time');
  assert.ok(!t2 || !t2.textContent.trim(), 't2 has no message time');
});

test('an invalid scope is refused and logged', () => {
  const h = buildHarness();
  assert.equal(h.rail.openCodeReviewTarget({ scope: 'bogus' }), false);
  assert.equal(h.state.ui.artifactReview.mode, 'artifact');
  assert.equal(h.log[0].code, 'code_review.open_invalid_scope');
});

test('a load failure shows an error instead of a blank panel', async () => {
  const h = buildHarness({ loadChangesView: async () => null });
  h.rail.openCodeReviewTarget({ scope: 'session' });
  await settle();
  assert.equal(h.errors.length, 1);
  assert.equal(h.detailPanel.querySelector('.changes-view'), null);
});

test('Escape leaves the detail page first, then closes and restores the opener', async () => {
  const h = buildHarness();
  const opener = h.document.getElementById('opener');
  opener.focus();
  h.rail.openCodeReviewTarget({ scope: 'file', turnId: 't1', fileKey: 'default:a.js' });
  await settle();
  const first = keydown(h, h.document.activeElement, 'Escape');
  assert.equal(first.defaultPrevented, true);
  assert.equal(h.state.ui.artifactReview.mode, 'code_review', 'the view handled Escape');
  assert.equal(h.detailPanel.querySelector('.changes-view').getAttribute('data-changes-mode'), 'history');
  keydown(h, h.document.activeElement, 'Escape');
  assert.equal(h.state.ui.artifactReview.mode, 'artifact');
  assert.equal(h.document.activeElement, opener);
});

test('Escape is ignored outside code_review mode', () => {
  const h = buildHarness();
  const event = keydown(h, h.artifactReviewPanel, 'Escape');
  assert.equal(event.defaultPrevented, false);
});

test('close falls back to the first chat entry when the opener detached', async () => {
  const h = buildHarness();
  const opener = h.document.getElementById('opener');
  opener.focus();
  h.rail.openCodeReviewTarget({ scope: 'session' });
  await settle();
  opener.remove();
  h.rail.closeCodeReview();
  assert.equal(h.document.activeElement, h.document.querySelector('.chat-entry'));
});

test('dispose tears the view down and stops a pending load from mounting', async () => {
  const h = buildHarness();
  h.rail.openCodeReviewTarget({ scope: 'session' });
  h.rail.dispose();
  await settle();
  assert.equal(h.rail.getView(), null);
  assert.equal(h.detailPanel.querySelector('.changes-view'), null);
});
