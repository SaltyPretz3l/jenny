'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { JSDOM } = require('jsdom');

const {
  CHANGES_VIEW_SCRIPTS,
  WORKING_TREE_SCRIPTS,
  createCodeReviewRail,
  loadChangesViewModules,
} = require('../renderer/features/renderer-code-review-rail');
const changesViewModule = require('../renderer/features/renderer-changes-view');
const workingTreeModule = require('../renderer/features/renderer-changes-working-tree');

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
    openArtifactRail: options.openArtifactRail || null,
    ...(options.railDeps || {}),
    renderArtifactReviewPanel: renderRail,
    appendClientLog: (level, code, payload) => log.push({ level, code, payload }),
    showComposerActionError: (error, title) => errors.push({ message: error.message, title }),
  });
  rail.bind();
  return { dom, document, rail, artifactReviewPanel, detailPanel, state, log, errors, opened, renderRail };
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
    const entry = [...CHANGES_VIEW_SCRIPTS, ...WORKING_TREE_SCRIPTS].find(([path]) => path === src);
    windowRef[entry[1]] = entry[1] === 'rendererChangesView' ? changesViewModule : {};
    return true;
  };
  assert.equal(await loadChangesViewModules({ ensureScript, windowRef }), changesViewModule);
  assert.deepEqual(loaded, [...CHANGES_VIEW_SCRIPTS, ...WORKING_TREE_SCRIPTS].map(([src]) => src), 'the Working tree page loads after the view');
  loaded.length = 0;
  assert.equal(await loadChangesViewModules({ ensureScript, windowRef }), changesViewModule);
  assert.deepEqual(loaded, [], 'already-loaded modules are not fetched again');
  assert.equal(await loadChangesViewModules({ ensureScript: async () => false, windowRef: {} }), null);
  // The Working tree page is best effort: a failure there still returns the view.
  const partial = {};
  const failWorkingTree = async ({ src }) => {
    const entry = CHANGES_VIEW_SCRIPTS.find(([path]) => path === src);
    if (!entry) return false;
    partial[entry[1]] = entry[1] === 'rendererChangesView' ? changesViewModule : {};
    return true;
  };
  assert.equal(await loadChangesViewModules({ ensureScript: failWorkingTree, windowRef: partial }), changesViewModule);
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

test('a review from a closed side panel opens the panel through the shared rail open', async () => {
  // Chat's Review buttons only changed the rail mode, so with the panel closed
  // nothing showed (row 35 live gate 2026-10-14).
  const opens = [];
  let h = null;
  h = buildHarness({
    openArtifactRail: (mode) => {
      opens.push(mode);
      h.state.ui.artifactReview.mode = mode;
      h.state.ui.artifactReview.enabled = true;
    },
  });
  assert.equal(h.rail.openCodeReviewTarget({ scope: 'suggested', turnId: 't1', toolCallId: 'call_1' }), true);
  assert.deepEqual(opens, ['code_review']);
  assert.equal(h.state.ui.artifactReview.enabled, true);
  await settle();
  assert.ok(h.detailPanel.querySelector('.changes-view-host .changes-view'));
});

/* ── Working tree page (row 59 checkpoint 2) ── */

function wtListing(files) {
  return { schema_version: 1, ok: true, state: 'available', reason: null, sampled_at: null, data: { workspace_id: 'w', scope: 'working_tree', ref: 'main', head: 'abc', branch: 'main', files, file_count: files.length, additions: 1, deletions: 0, truncated: false } };
}

function wtHarness(options = {}) {
  const calls = { claim: [], list: [], diff: [], git: 0, workspace: [] };
  // The panel's session, as the shell bridge's sidePanel.getSessionId() gives it: the claimed owner (split view).
  const panel = { sessionId: null };
  const bridge = {
    listChanges: async (request) => { calls.list.push(request); return wtListing([{ path: 'src/a.js', change: 'modified', binary: false, additions: 1, deletions: 0 }]); },
    getChangeDiff: async (request) => { calls.diff.push(request); return { ok: true, binary: false, diff: '@@ -1 +1 @@\n-a\n+b\n' }; },
    onChanged: () => () => {},
  };
  const h = buildHarness({
    ...options,
    railDeps: {
      claimOwner: (id) => { calls.claim.push(id); panel.sessionId = id; },
      getActiveSessionId: () => panel.sessionId || 'sess_1',
      getChatWorkspace: () => bridge,
      getWorkingTreeModule: () => (options.noModule ? null : workingTreeModule),
      openWorkingTreeFile: (path) => calls.workspace.push(path),
      openInGit: () => { calls.git += 1; },
    },
  });
  return { ...h, calls, bridge, panel };
}

test('the session rail opens the Working tree page for its explicit owner, not the active session', async () => {
  const h = wtHarness();
  const opener = h.document.getElementById('opener');
  assert.equal(h.rail.openWorkingTree({ ownerSessionId: 'sess_pane_b', opener }), true);
  assert.deepEqual(h.calls.claim, ['sess_pane_b']);
  assert.equal(h.state.ui.artifactReview.mode, 'code_review');
  await settle();
  await settle();
  assert.equal(h.calls.list[0].session_id, 'sess_pane_b', 'the active session in this harness is sess_1');
  const page = h.detailPanel.querySelector('.changes-detail-page');
  assert.equal(page.dataset.changesScope, 'working_tree');
  assert.ok(page.querySelector('.changes-wt .file-diff'));
  assert.equal(page.querySelector('.changes-view-host').hidden, true);
  assert.equal(h.calls.diff[0].session_id, 'sess_pane_b');
  assert.equal(h.document.activeElement.getAttribute('data-value'), 'working_tree', 'focus lands on the page switch');
});

test('the Working tree / This chat switch swaps the page for the existing ledger view in place', async () => {
  const h = wtHarness();
  h.rail.openWorkingTree({ ownerSessionId: 'sess_a', opener: h.document.getElementById('opener') });
  await settle();
  await settle();
  const click = (value) => h.detailPanel.querySelector(`.inv-segmented-option[data-value="${value}"]`)
    .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  click('this_chat');
  const host = h.detailPanel.querySelector('.changes-view-host');
  assert.equal(host.hidden, false);
  assert.equal(h.detailPanel.querySelector('.changes-wt-scroll').hidden, true);
  assert.equal(host.querySelector('.changes-view').getAttribute('data-changes-mode'), 'history', 'This chat is the unchanged ledger');
  click('working_tree');
  assert.equal(host.hidden, true);
  assert.equal(h.detailPanel.querySelector('.changes-wt-scroll').hidden, false);
  assert.equal(h.detailPanel.querySelector('.inv-segmented-option[aria-checked="true"]').getAttribute('data-value'), 'working_tree');
});

test('a transcript Review changes keeps the ledger as its scope and clears the rail owner', async () => {
  const h = wtHarness();
  h.rail.openWorkingTree({ ownerSessionId: 'sess_a', opener: h.document.getElementById('opener') });
  await settle();
  await settle();
  h.rail.openCodeReviewTarget({ scope: 'session' });
  await settle();
  await settle();
  assert.equal(h.detailPanel.querySelector('.changes-detail-page').dataset.changesScope, 'this_chat');
  assert.equal(h.detailPanel.querySelector('.changes-view-host').hidden, false);
  assert.ok(h.detailPanel.querySelector('.changes-view-host .changes-view'));
  const checked = h.detailPanel.querySelector('.inv-segmented-option[aria-checked="true"]');
  assert.equal(checked.getAttribute('data-value'), 'this_chat');
});

test('Escape closes the Working tree page and returns focus to the row that opened it', async () => {
  const h = wtHarness();
  const opener = h.document.getElementById('opener');
  h.rail.openWorkingTree({ ownerSessionId: 'sess_a', opener });
  await settle();
  await settle();
  assert.notEqual(h.document.activeElement, opener);
  keydown(h, h.document.activeElement, 'Escape');
  assert.equal(h.state.ui.artifactReview.mode, 'artifact');
  assert.equal(h.document.activeElement, opener);
});

test('re-rendering the panel never lists the working tree again', async () => {
  const h = wtHarness();
  h.rail.openWorkingTree({ ownerSessionId: 'sess_a', opener: h.document.getElementById('opener') });
  await settle();
  await settle();
  const listed = h.calls.list.length;
  for (let i = 0; i < 4; i += 1) h.renderRail();
  await settle();
  assert.equal(h.calls.list.length, listed);
});

test('Open in Workspace and Open in Git go to the injected hand-offs', async () => {
  const h = wtHarness();
  h.rail.openWorkingTree({ ownerSessionId: 'sess_a', opener: h.document.getElementById('opener') });
  await settle();
  await settle();
  const click = (selector) => h.detailPanel.querySelector(selector).dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  click('[data-changes-wt-open]');
  click('[data-changes-wt-open-git]');
  assert.deepEqual(h.calls.workspace, ['src/a.js']);
  assert.equal(h.calls.git, 1);
});

test('without the Working tree modules the rail entry still opens Changes and falls back to the ledger', async () => {
  const h = wtHarness({ noModule: true });
  assert.equal(h.rail.openWorkingTree({ ownerSessionId: '', opener: null }), false, 'no owner, no panel');
  assert.equal(h.state.ui.artifactReview.mode, 'artifact');
  // The page module loads lazily with the Changes view; it is not a precondition of the open.
  assert.equal(h.rail.openWorkingTree({ ownerSessionId: 'sess_a', opener: null }), true);
  assert.equal(h.state.ui.artifactReview.mode, 'code_review');
  await settle();
  await settle();
  assert.ok(h.detailPanel.querySelector('.changes-view-host .changes-view'));
  assert.equal(h.detailPanel.querySelector('.changes-detail-page').dataset.changesScope, 'this_chat');
  assert.equal(h.detailPanel.querySelector('.inv-segmented'), null, 'no switch without the page');
});

test('the Working tree page follows the panel session, the one the owner line names', async () => {
  const h = wtHarness();
  h.rail.openWorkingTree({ ownerSessionId: 'sess_b', opener: h.document.getElementById('opener') });
  await settle();
  await settle();
  assert.equal(h.calls.list.at(-1).session_id, 'sess_b');
  h.panel.sessionId = 'sess_c'; // the pane that owned the panel switched chats
  h.renderRail();
  await settle();
  await settle();
  assert.equal(h.calls.list.at(-1).session_id, 'sess_c', 'the page never lists one chat under another chat\'s name');
});

test('dispose stops the Working tree page too', async () => {
  const h = wtHarness();
  h.rail.openWorkingTree({ ownerSessionId: 'sess_a', opener: h.document.getElementById('opener') });
  await settle();
  await settle();
  assert.ok(h.rail.getWorkingTree());
  h.rail.dispose();
  assert.equal(h.rail.getWorkingTree(), null);
  assert.equal(h.detailPanel.querySelector('.changes-wt .file-diff'), null);
});
