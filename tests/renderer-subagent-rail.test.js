'use strict';

/* The Subagent Monitor as the `subagents` rail mode of the artifact review
 * panel (docs/plans/SUBAGENT_MONITOR_V2.md section 3): the record, the pull,
 * the prior snapshot and restore, the two-pane arbitration, the Escape and
 * collapse routing, and the dock host. Driven through the REAL shell bridge
 * (surface controller, panel V3 chrome, rail) and REAL pane monitor
 * controllers in jsdom, so renderSplitDetail's pull branch is what paints.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const artifactsUtils = require('../renderer/features/renderer-artifacts-utils');
const reviewPrefs = require('../renderer/features/renderer-artifact-review-prefs');
const sidePanelOwner = require('../renderer/chat/renderer-side-panel-owner');
const { createShellArtifactBridge } = require('../renderer/shell/renderer-shell-artifact-bridge');
const { createSubagentMonitorController } = require('../renderer/chat/renderer-subagent-monitor-controller');

const STORAGE_KEY = 'jenny.artifactReview.v1';

const PAGE_HTML = '<div id="workspace"><div id="chatView">'
  + '<div class="chat-pane" id="chatPane0" data-pane-id="0"><div class="chat-thread-stage" id="stage0">'
  + '<div class="chat-thread-shell"><button id="cardA" data-subagent-open="call-a" aria-expanded="false" aria-controls="subagentInspector">Open A</button></div>'
  + '<aside id="subagentInspector" data-chat-node="subagentInspector" hidden aria-hidden="true"></aside></div></div>'
  + '<div class="chat-pane" id="chatPane1" data-pane-id="1"><div class="chat-thread-stage" id="stage1">'
  + '<div class="chat-thread-shell"><button id="cardB" data-subagent-open="call-b" aria-expanded="false">Open B</button></div>'
  + '<aside id="subagentInspector-pane1" data-chat-node="subagentInspector" hidden aria-hidden="true"></aside></div></div>'
  + '<aside class="artifact-review-panel" id="artifactReviewPanel" aria-label="Artifact review">'
  + '<button id="artifactReviewCollapseButton" type="button">Collapse</button>'
  + '<div class="artifact-review-scroll">'
  + '<div id="artifactReviewDetailEmpty"></div>'
  + '<div class="artifact-review-detail-panel hidden" id="artifactReviewDetailPanel">'
  + '<span id="artifactReviewDetailKicker"></span><span id="artifactReviewDetailTitle"></span>'
  + '<span id="artifactReviewDetailPath"></span><span id="artifactReviewDetailStatus"></span>'
  + '<div id="artifactReviewDetailMeta"></div><div id="artifactReviewProvenanceTimeline"></div>'
  + '<div class="artifact-preview-content hidden" id="artifactReviewPreviewContent"></div>'
  + '<div id="artifactReviewEditorShell"></div><span id="artifactReviewDirtyBadge"></span>'
  + '</div></div></aside>'
  + '</div>'
  + '<div id="ideChatDock"></div></div>';

const TASKS = [
  { task_id: 'task-1', label: 'Survey renderer', status: 'completed', summary: 'Renderer summary.', answer: '## Renderer\n\n<script>alert(1)</script>', budget: { elapsed_ms: 41_000, tool_results_used: 3 }, usage: { total_tokens: 900 } },
  { task_id: 'task-2', label: 'Survey sidecar', status: 'completed', summary: 'Sidecar summary.', budget: { elapsed_ms: 12_000 } },
];

function batchMessages(callId, tasks = TASKS) {
  return [{ tool_result: { call_id: callId, metadata: { subagent_batch_report: { status: 'completed', tasks } } } }];
}

function rig(t, { prefs = null, sessions = ['session-a'], focus = 'session-a', messages = {}, eager = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body>' + PAGE_HTML + '</body></html>', { url: 'https://jenny.local/chat', pretendToBeVisual: true });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  });
  const doc = dom.window.document;
  if (prefs) dom.window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  const state = {
    ui: { activeView: 'chat', artifactReview: {} },
    artifacts: {
      filter: 'all', selectedArtifactId: '', selectedSessionId: '', loadedArtifactId: '',
      loadedArtifactContent: '', dirtyContent: '', lastError: '', loading: false,
      savePending: false, mermaidViewMode: 'preview', viewModeByKind: {},
      autoOpenedSessionIds: [], deletedArtifactIds: [],
    },
    messagesBySession: new Map(Object.entries(messages)),
    sessions: sessions.map((id) => ({ id, title: `Chat ${id}` })),
    currentSessionId: focus,
    panes: { panes: sessions.map((sessionId, paneId) => ({ paneId, sessionId })) },
    features: { featureFlags: {} },
  };
  const byId = (id) => doc.getElementById(id);
  const bridge = createShellArtifactBridge({
    state,
    windowRef: dom.window,
    dom: { artifactReviewPanel: byId('artifactReviewPanel'), chatView: byId('chatView'), workspace: byId('workspace') },
    lazyDom: {
      getArtifactsDom: () => ({
        artifactReviewPanel: byId('artifactReviewPanel'),
        artifactReviewCollapseButton: byId('artifactReviewCollapseButton'),
        artifactReviewDetailEmpty: byId('artifactReviewDetailEmpty'),
        artifactReviewDetailPanel: byId('artifactReviewDetailPanel'),
        artifactReviewPreviewContent: byId('artifactReviewPreviewContent'),
        artifactReviewEditorShell: byId('artifactReviewEditorShell'),
      }),
    },
    artifactsUtils,
    sidePanelOwner,
    registerCleanup: (fn) => t.after(fn),
    constants: { ARTIFACT_REVIEW_STORAGE_KEY: STORAGE_KEY },
    callbacks: {
      getActiveSession: () => ({ id: state.currentSessionId }),
      setActiveView: (view) => { state.ui.activeView = view; },
    },
  });
  // eager: false leaves the surface unbuilt, as at boot before any panel open.
  const surface = eager ? bridge.ensureArtifactSurface() : null;
  if (eager) assert.ok(surface, 'precondition: the artifact surface builds');
  const panel = byId('artifactReviewPanel');
  const rail = dom.window.rendererSubagentRailHost;
  if (eager) assert.ok(rail, 'precondition: the bridge published the subagent rail');
  const controllers = [];
  const makeController = (paneId, sessionId, extra = {}) => {
    const controller = createSubagentMonitorController({
      state,
      windowRef: dom.window,
      documentRef: doc,
      inspector: byId(paneId === 0 ? 'subagentInspector' : 'subagentInspector-pane1'),
      idSuffix: paneId === 0 ? '' : `-pane${paneId}`,
      getSessionId: () => sessionId,
      ownsTrigger: (trigger) => Number(trigger.closest('.chat-pane')?.dataset.paneId ?? 0) === paneId, // docked in the IDE: pane 0's
      getMessages: (id) => state.messagesBySession.get(id) || [],
      ...extra,
    });
    controller.bind();
    controllers.push(controller);
    t.after(() => controller.dispose());
    return controller;
  };
  const shell = () => panel.querySelector('.subagent-monitor-shell');
  const review = () => state.ui.artifactReview;
  return { dom, doc, state, bridge, surface, panel, rail, makeController, shell, review, byId, controllers };
}

const key = (window, name, init = {}) => new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });

describe('the subagents rail mode: the pull, the record and the restore', () => {
  test('the first Open with no artifact surface built yet still lands in the panel, not the aside', (t) => {
    const r = rig(t, { eager: false, messages: { 'session-a': batchMessages('call-a') } });
    assert.equal(r.rail, undefined, 'precondition: nothing built the rail');
    r.makeController(0, 'session-a');
    r.byId('cardA').click();
    assert.equal(r.review().mode, 'subagents');
    assert.ok(r.shell(), 'the shared panel hosts the monitor');
    assert.equal(r.byId('subagentInspector').hidden, true, 'the in-stage aside stays closed in Chat');
    assert.equal(r.byId('cardA').getAttribute('aria-controls'), 'artifactReviewPanel');
  });

  test('opening a two-child delegation lands on the tree inside the artifact panel', (t) => {
    const r = rig(t, { messages: { 'session-a': batchMessages('call-a') } });
    const controller = r.makeController(0, 'session-a');
    r.byId('cardA').click();
    assert.equal(r.review().mode, 'subagents');
    assert.equal(r.panel.dataset.artifactReviewMode, 'subagents');
    assert.equal(r.panel.classList.contains('hidden'), false, 'the panel shows');
    assert.equal(r.panel.getAttribute('aria-label'), 'Subagent monitor');
    const record = r.state.ui.subagentMonitor;
    assert.deepEqual({ sessionId: record.sessionId, key: record.key, page: record.page }, { sessionId: 'session-a', key: 'call-a', page: 'tree' });
    assert.deepEqual(Object.keys(record.prior).sort(), ['enabled', 'mode', 'sessionId'], 'no retired collapsed/userDismissed prefs');
    assert.ok(r.shell(), 'painted by the pull');
    assert.equal(r.shell().closest('#artifactReviewPreviewContent') !== null, true);
    assert.equal(r.panel.querySelectorAll('[role="treeitem"][data-subagent-select]').length, 2);
    assert.equal(r.byId('cardA').getAttribute('aria-expanded'), 'true');
    assert.equal(r.byId('cardA').getAttribute('aria-controls'), 'artifactReviewPanel');
    assert.equal(r.byId('subagentInspector').hidden, true, 'the in-stage aside stays out of Chat');
    assert.equal(r.doc.activeElement, r.panel.querySelector('[data-subagent-select][tabindex="0"]'), 'focus lands on the selected row');
    controller.close();
  });

  test('one child lands on the drill-in; Back returns to the tree at any width and focuses that row', (t) => {
    const r = rig(t, { messages: { 'session-a': batchMessages('call-a', [TASKS[0]]) } });
    r.makeController(0, 'session-a');
    r.byId('cardA').click();
    assert.equal(r.state.ui.subagentMonitor.page, 'detail');
    assert.ok(r.panel.querySelector('[data-subagent-page="detail"]'));
    assert.equal(r.doc.activeElement, r.panel.querySelector('[data-subagent-back]'), 'focus lands on Back');
    r.panel.querySelector('[data-subagent-back]').click();
    assert.equal(r.state.ui.subagentMonitor.page, 'tree');
    assert.ok(r.panel.querySelector('[data-subagent-page="tree"]'));
    assert.equal(r.doc.activeElement, r.panel.querySelector('[data-subagent-select="task-1"]'), 'Back focuses the child\'s row');
    r.panel.querySelector('[data-subagent-select="task-1"]').click();
    assert.equal(r.state.ui.subagentMonitor.page, 'detail');
    assert.match(r.shell().textContent, /Renderer summary|Renderer/, 'the drill-in shows the answer');
    assert.doesNotMatch(r.shell().innerHTML, /<script/i, 'a script in the answer never lands');
  });

  test('keyboard: Enter opens a row, Backspace / ArrowLeft / Alt+ArrowLeft go back, Home and End move', (t) => {
    const r = rig(t, { messages: { 'session-a': batchMessages('call-a') } });
    r.makeController(0, 'session-a');
    r.byId('cardA').click();
    const rows = () => [...r.panel.querySelectorAll('[data-subagent-select]')];
    rows()[0].dispatchEvent(key(r.dom.window, 'End'));
    assert.equal(r.doc.activeElement, rows()[1]);
    rows()[1].dispatchEvent(key(r.dom.window, 'Home'));
    assert.equal(r.doc.activeElement, rows()[0]);
    rows()[0].dispatchEvent(key(r.dom.window, 'Enter'));
    assert.equal(r.state.ui.subagentMonitor.page, 'detail');
    for (const init of [{ key: 'Backspace' }, { key: 'ArrowLeft' }, { key: 'ArrowLeft', altKey: true }]) {
      r.panel.querySelector('[data-subagent-back]').dispatchEvent(key(r.dom.window, init.key, init));
      assert.equal(r.state.ui.subagentMonitor.page, 'tree', `${init.key} goes back`);
      rows()[0].dispatchEvent(key(r.dom.window, 'ArrowRight'));
      assert.equal(r.state.ui.subagentMonitor.page, 'detail');
    }
  });

  test('pull only: nothing is written unless the mode is subagents and the record\'s session is the controller\'s own', (t) => {
    const r = rig(t, { messages: { 'session-a': batchMessages('call-a') } });
    const controller = r.makeController(0, 'session-a');
    r.byId('cardA').click();
    const surface = r.surface;
    r.surface.openArtifactRail('tasks'); // another mode takes the panel
    assert.equal(r.state.ui.subagentMonitor, null, 'a mode change clears the record');
    assert.equal(r.byId('cardA').getAttribute('aria-expanded'), 'false', 'and resets the inline card');
    const host = r.byId('artifactReviewPreviewContent');
    host.innerHTML = '<p id="other-mode">other</p>';
    controller.reconcile();
    controller.render({ force: true });
    assert.equal(r.shell(), null, 'a controller never writes into a panel in another mode');
    assert.ok(r.byId('other-mode'));
    // A record for another session is not painted by this pane's controller.
    r.byId('cardA').click();
    assert.ok(r.shell());
    r.state.ui.subagentMonitor.sessionId = 'session-z';
    assert.equal(r.rail.renderSubagentsSurface({ previewContent: host }), false, 'a foreign session\'s record is refused');
    assert.ok(surface);
  });

  test('a mode change away (artifact open, file preview, tasks) clears the record and stops ticking', (t) => {
    const r = rig(t, { messages: { 'session-a': batchMessages('call-a') } });
    r.makeController(0, 'session-a');
    for (const leave of [() => r.surface.openArtifactRail('file_preview'), () => r.surface.openArtifactRail('tasks'), () => { void r.surface.openArtifactTarget('', { source: 'test' }); }]) {
      r.byId('cardA').click();
      assert.equal(r.review().mode, 'subagents');
      leave();
      assert.equal(r.state.ui.subagentMonitor, null);
      assert.equal(r.byId('cardA').getAttribute('aria-expanded'), 'false');
      assert.equal(r.panel.getAttribute('aria-label'), 'Artifact review', 'the panel label is restored on leave');
    }
  });

  test('safety net: mode subagents without a live record resets to artifact', (t) => {
    const r = rig(t);
    r.surface.setArtifactRailMode('subagents');
    r.review().enabled = true;
    r.surface.renderArtifactReviewPanel();
    assert.equal(r.review().mode, 'artifact');
  });

  test('close restores the displaced prefs; a file_preview prior falls back to artifact when the session changed', (t) => {
    // A legacy collapsed/userDismissed seed loads as the one closed state.
    const r = rig(t, { prefs: { enabled: false, collapsed: true, userDismissed: true, width: 420 }, messages: { 'session-a': batchMessages('call-a') } });
    const controller = r.makeController(0, 'session-a');
    r.review().mode = 'file_preview';
    r.byId('cardA').click();
    assert.equal(r.review().enabled, true, 'the open displaced the prefs');
    assert.deepEqual(
      { mode: r.state.ui.subagentMonitor.prior.mode, enabled: r.state.ui.subagentMonitor.prior.enabled, sessionId: r.state.ui.subagentMonitor.prior.sessionId },
      { mode: 'file_preview', enabled: false, sessionId: 'session-a' },
    );
    controller.close();
    assert.deepEqual(
      { mode: r.review().mode, enabled: r.review().enabled },
      { mode: 'file_preview', enabled: false },
      'close puts back mode and the closed state',
    );
    assert.equal(r.panel.classList.contains('hidden'), true);
    assert.equal(r.state.ui.subagentMonitor, null);

    r.review().mode = 'file_preview';
    r.byId('cardA').click();
    r.state.currentSessionId = 'session-other'; // the chat changed under the monitor
    controller.close();
    assert.equal(r.review().mode, 'artifact', 'a preview of another chat is not restored');
  });

  test('prefs never restore the subagents mode across a reload', (t) => {
    const r = rig(t, { messages: { 'session-a': batchMessages('call-a') } });
    r.makeController(0, 'session-a');
    r.byId('cardA').click();
    const stored = r.dom.window.localStorage.getItem(STORAGE_KEY) || '';
    assert.doesNotMatch(stored, /subagents|"mode"/, 'the mode is renderer-local');
    assert.equal(reviewPrefs.normalizeArtifactReviewMode('subagents'), 'subagents');
    r.dom.window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: true, mode: 'subagents' }));
    assert.equal(reviewPrefs.loadArtifactReviewPreferences(r.dom.window, STORAGE_KEY).mode, 'artifact');
  });

  test('Escape closes the monitor, is defaultPrevented, and does not also dismiss the overlay panel', (t) => {
    const r = rig(t, { prefs: { enabled: true, collapsed: false, userDismissed: false, width: 420 }, messages: { 'session-a': batchMessages('call-a') } });
    r.makeController(0, 'session-a');
    r.byId('cardA').focus();
    r.byId('cardA').click();
    assert.equal(r.panel.classList.contains('artifact-review-overlay'), true, 'jsdom lays out no width, so the panel is the overlay drawer');
    const event = key(r.dom.window, 'Escape');
    r.panel.querySelector('[data-subagent-select]').dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(r.state.ui.subagentMonitor, null);
    assert.equal(r.review().dismissedForSession, undefined, 'no per-chat dismissal');
    assert.equal(r.review().enabled, true, 'the panel is not also closed');
    assert.equal(r.doc.activeElement, r.byId('cardA'), 'focus returns to the inline card');
  });

  test('the artifact collapse button closes the monitor instead of the sticky collapse', (t) => {
    const r = rig(t, { prefs: { enabled: false, collapsed: false, userDismissed: false, width: 420 }, messages: { 'session-a': batchMessages('call-a') } });
    r.makeController(0, 'session-a');
    r.byId('cardA').click();
    r.byId('artifactReviewCollapseButton').click();
    assert.equal(r.state.ui.subagentMonitor, null);
    assert.equal(r.review().dismissedForSession, undefined, 'not the artifact Close dismissal');
    assert.equal(r.review().enabled, false, 'the panel goes back to how it was');
  });

  test('evidence links open through the shared open-file event', (t) => {
    const r = rig(t, { messages: { 'session-a': batchMessages('call-a', [{ ...TASKS[0], evidence: [{ relative_path: 'services/store.js', line_start: 12, line_end: 12 }] }]) } });
    r.makeController(0, 'session-a');
    r.byId('cardA').click();
    const opened = [];
    r.dom.window.addEventListener('ide:open-file-at-line', (event) => { opened.push(event.detail); event.preventDefault(); });
    r.panel.querySelector('[data-chat-path-open]').click();
    assert.deepEqual(opened, [{ path: 'services/store.js', line: 12, column: null }]);
  });

  test('a session switch restores the prior prefs after the sync, unless a newer selection took the panel', async (t) => {
    const prefs = { enabled: false, collapsed: false, userDismissed: false, width: 420 };
    const plain = rig(t, { prefs, messages: { 'session-a': batchMessages('call-a') } });
    plain.makeController(0, 'session-a');
    plain.byId('cardA').click();
    plain.state.currentSessionId = 'session-other';
    plain.rail.handleLayoutSync('subagents', true);
    assert.equal(plain.state.ui.subagentMonitor, null, 'the record ends at once');
    await Promise.resolve();
    assert.equal(plain.review().enabled, false, 'the deferred restore puts the prior back');

    const newer = rig(t, { prefs, messages: { 'session-a': batchMessages('call-a') } });
    newer.makeController(0, 'session-a');
    newer.byId('cardA').click();
    newer.state.currentSessionId = 'session-other';
    newer.rail.handleLayoutSync('subagents', true);
    newer.surface.openArtifactRail('tasks'); // the new chat picks a rail in the same tick
    await Promise.resolve();
    assert.equal(newer.review().mode, 'tasks', 'the newer selection wins');
    assert.equal(newer.review().enabled, true);

    const reopened = rig(t, { prefs, messages: { 'session-a': batchMessages('call-a') } });
    reopened.makeController(0, 'session-a');
    reopened.byId('cardA').click();
    reopened.state.currentSessionId = 'session-other';
    reopened.rail.handleLayoutSync('subagents', true);
    reopened.state.currentSessionId = 'session-a';
    reopened.byId('cardA').click(); // a fresh open before the microtask
    await Promise.resolve();
    assert.equal(reopened.review().mode, 'subagents');
    assert.ok(reopened.state.ui.subagentMonitor, 'the fresh record is not undone');
  });

  test('Escape in a maximized non-overlay panel closes the monitor and keeps the panel maximized', (t) => {
    const r = rig(t, { prefs: { enabled: true, collapsed: false, userDismissed: false, width: 420 }, messages: { 'session-a': batchMessages('call-a') } });
    r.byId('workspace').getBoundingClientRect = () => ({ width: 2000 });
    r.makeController(0, 'session-a');
    r.byId('cardA').click();
    r.surface.toggleArtifactReviewMaximized(true);
    assert.equal(r.surface.isArtifactReviewMaximized(), true);
    assert.equal(r.panel.classList.contains('artifact-review-overlay'), false, 'precondition: not the overlay drawer');
    r.panel.querySelector('[data-subagent-select]').dispatchEvent(key(r.dom.window, 'Escape'));
    assert.equal(r.state.ui.subagentMonitor, null, 'the monitor closed');
    assert.equal(r.surface.isArtifactReviewMaximized(), true, 'the panel did not also un-maximize');
  });

  test('a session switch, then open and close in one tick: the stale deferred restore stands down', async (t) => {
    const r = rig(t, { prefs: { enabled: false, collapsed: false, userDismissed: false, width: 420 }, messages: { 'session-a': batchMessages('call-a') } });
    const controller = r.makeController(0, 'session-a');
    r.byId('cardA').click(); // the first prior: enabled false
    r.state.currentSessionId = 'session-other';
    r.rail.handleLayoutSync('subagents', true);
    r.state.currentSessionId = 'session-a';
    r.byId('cardA').click(); // the second prior: enabled true (the panel is up)
    controller.close();
    assert.equal(r.review().enabled, true, 'the newer close restored its own prior');
    await Promise.resolve();
    assert.equal(r.review().enabled, true, 'the stale deferred restore must not overwrite it');
  });

  test('a hidden panel keeps the record: a view round trip repaints the monitor and a later close still restores', (t) => {
    const r = rig(t, { prefs: { enabled: false, collapsed: false, userDismissed: false, width: 420 }, messages: { 'session-a': batchMessages('call-a') } });
    const controller = r.makeController(0, 'session-a');
    r.byId('cardA').click();
    r.rail.handleLayoutSync('subagents', false); // the panel hid: Settings, Home, the IDE without its dock
    assert.ok(r.state.ui.subagentMonitor, 'the record survives a hidden panel');
    assert.equal(r.byId('cardA').getAttribute('aria-expanded'), 'true');
    r.surface.renderArtifactReviewPanel(); // back in Chat
    assert.equal(r.review().mode, 'subagents');
    assert.ok(r.shell(), 'the pull repainted the monitor');
    controller.close();
    assert.equal(r.review().enabled, false, 'the close put the prior back');
    assert.equal(r.review().mode, 'artifact');
  });

  test('an unchanged state repaints nothing: the shell node and the body scroll survive a panel render', (t) => {
    const r = rig(t, { messages: { 'session-a': batchMessages('call-a') } });
    r.makeController(0, 'session-a');
    r.byId('cardA').click();
    const first = r.shell();
    r.panel.querySelector('.subagent-monitor-body').scrollTop = 40;
    r.surface.renderArtifactReviewPanel();
    r.surface.renderArtifactReviewPanel();
    assert.equal(r.shell(), first, 'the same node');
  });
});

describe('two panes share one panel', () => {
  const messages = {
    'session-a': batchMessages('call-a'),
    'session-b': batchMessages('call-b', [{ ...TASKS[1], task_id: 'b-1', label: 'Beta task' }, { ...TASKS[1], task_id: 'b-2', label: 'Beta task two' }]),
  };

  test('opening from pane B replaces pane A\'s record; the owner line names pane B; closing restores the panel', (t) => {
    const r = rig(t, { sessions: ['session-a', 'session-b'], focus: 'session-a', messages, prefs: { enabled: false, collapsed: false, userDismissed: false, width: 420 } });
    const paneA = r.makeController(0, 'session-a');
    r.makeController(1, 'session-b');
    r.byId('cardA').click();
    assert.equal(r.state.ui.subagentMonitor.sessionId, 'session-a');
    const originalPrior = { ...r.state.ui.subagentMonitor.prior };
    assert.equal(originalPrior.enabled, false);

    r.state.currentSessionId = 'session-b'; // a click in pane B focuses it first
    r.byId('cardB').click();
    assert.equal(r.state.ui.subagentMonitor.sessionId, 'session-b');
    assert.equal(r.state.ui.subagentMonitor.key, 'call-b');
    assert.deepEqual({ ...r.state.ui.subagentMonitor.prior }, originalPrior, 'the ORIGINAL prior survives the takeover');
    assert.equal(r.byId('cardA').getAttribute('aria-expanded'), 'false', 'pane A\'s card resets');
    assert.equal(r.byId('cardB').getAttribute('aria-expanded'), 'true');
    assert.match(r.shell().textContent, /Beta task/);
    assert.match(r.panel.querySelector(':scope > .side-panel-owner-line')?.textContent || '', /Chat session-b/, 'the owner line shows pane B\'s chat');

    // Pane A closing (disposed) must not touch pane B's record.
    paneA.dispose();
    assert.equal(r.state.ui.subagentMonitor.sessionId, 'session-b');
    assert.ok(r.shell());
  });

  test('a takeover never restores pane A\'s file preview into pane B\'s chat', (t) => {
    const r = rig(t, { sessions: ['session-a', 'session-b'], focus: 'session-a', messages, prefs: { enabled: true, collapsed: false, userDismissed: false, width: 420 } });
    r.makeController(0, 'session-a');
    const paneB = r.makeController(1, 'session-b');
    r.review().mode = 'file_preview'; // pane A's chat was previewing a file
    r.byId('cardA').click();
    assert.equal(r.state.ui.subagentMonitor.prior.sessionId, 'session-a');
    r.state.currentSessionId = 'session-b';
    r.byId('cardB').click();
    assert.equal(r.state.ui.subagentMonitor.sessionId, 'session-b');
    paneB.close();
    assert.equal(r.review().mode, 'artifact', 'session A\'s preview is not restored under session B');
  });

  test('disposing the owning pane restores the panel', (t) => {
    const r = rig(t, { sessions: ['session-a', 'session-b'], focus: 'session-b', messages, prefs: { enabled: false, collapsed: false, userDismissed: false, width: 420 } });
    r.makeController(0, 'session-a');
    const paneB = r.makeController(1, 'session-b');
    r.byId('cardB').click();
    assert.equal(r.review().enabled, true);
    paneB.dispose();
    assert.equal(r.state.ui.subagentMonitor, null);
    assert.equal(r.review().enabled, false, 'the prior enabled state is back');
    assert.equal(r.panel.classList.contains('hidden'), true);
  });
});

describe('the Workspace dock host', () => {
  test('in the dock the in-stage aside hosts the monitor and the artifact panel is untouched', (t) => {
    const r = rig(t, { messages: { 'session-a': batchMessages('call-a') } });
    r.byId('ideChatDock').appendChild(r.byId('stage0'));
    const controller = r.makeController(0, 'session-a');
    r.byId('cardA').click();
    const aside = r.byId('subagentInspector');
    assert.equal(aside.hidden, false);
    assert.ok(aside.querySelector('.subagent-monitor-shell'));
    assert.equal(r.state.ui.subagentMonitor ?? null, null, 'no panel record in the dock');
    assert.equal(r.review().mode !== 'subagents', true);
    assert.equal(r.byId('cardA').getAttribute('aria-controls'), 'subagentInspector');
    assert.equal(r.byId('cardA').getAttribute('aria-expanded'), 'true');
    aside.querySelector('[data-subagent-select]').click();
    assert.ok(aside.querySelector('[data-subagent-page="detail"]'));
    aside.querySelector('[data-subagent-back]').click();
    assert.ok(aside.querySelector('[data-subagent-page="tree"]'));
    const escape = key(r.dom.window, 'Escape');
    aside.querySelector('[data-subagent-select]').dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(aside.hidden, true);
    controller.close();
  });

  test('closing the dock while the IDE view is up closes the monitor instead of forcing the Chat view', (t) => {
    const r = rig(t, { prefs: { enabled: false, collapsed: false, userDismissed: false, width: 420 }, messages: { 'session-a': batchMessages('call-a') } });
    r.state.ui.activeView = 'ide';
    r.byId('ideChatDock').appendChild(r.byId('stage0'));
    const controller = r.makeController(0, 'session-a');
    r.byId('cardA').click();
    assert.ok(r.byId('subagentInspector').querySelector('.subagent-monitor-shell'), 'precondition: the dock aside hosts it');
    r.byId('chatPane0').appendChild(r.byId('stage0')); // the dock closed; the IDE view is still up
    r.dom.window.dispatchEvent(new r.dom.window.Event('subagent-monitor:rehost'));
    assert.equal(r.state.ui.activeView, 'ide', 'no forced view switch');
    assert.equal(r.state.ui.subagentMonitor ?? null, null, 'no panel record was opened');
    assert.equal(r.byId('subagentInspector').hidden, true);
    assert.equal(r.review().enabled, false, 'the panel prefs are untouched');
    assert.equal(r.byId('cardA').getAttribute('aria-expanded'), 'false');
    controller.close();
  });

  test('rehost() moves an open monitor between the dock aside and the panel', (t) => {
    const r = rig(t, { messages: { 'session-a': batchMessages('call-a') } });
    r.byId('ideChatDock').appendChild(r.byId('stage0'));
    const controller = r.makeController(0, 'session-a');
    r.byId('cardA').click();
    assert.ok(r.byId('subagentInspector').querySelector('.subagent-monitor-shell'));
    // The stage leaves the dock (back to Chat): the explicit hook moves the monitor into the panel.
    r.byId('chatPane0').appendChild(r.byId('stage0'));
    controller.rehost();
    assert.equal(r.byId('subagentInspector').hidden, true);
    assert.equal(r.state.ui.subagentMonitor.key, 'call-a');
    assert.ok(r.panel.querySelector('.subagent-monitor-shell'));
    assert.equal(r.byId('cardA').getAttribute('aria-controls'), 'artifactReviewPanel');
    // And into the dock again, through the window event the dock move can dispatch.
    r.byId('ideChatDock').appendChild(r.byId('stage0'));
    r.dom.window.dispatchEvent(new r.dom.window.Event('subagent-monitor:rehost'));
    assert.equal(r.state.ui.subagentMonitor, null, 'the panel record ended');
    assert.equal(r.byId('subagentInspector').hidden, false);
    assert.ok(r.byId('subagentInspector').querySelector('.subagent-monitor-shell'));
    assert.equal(r.byId('cardA').getAttribute('aria-controls'), 'subagentInspector');
  });
});
