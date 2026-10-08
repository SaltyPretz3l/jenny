'use strict';

/* Suggested changes in the Changes view (row 35 Plan Plus W2; UI spec §3.2-3.3):
 * the suggested state in both hosts, the side panel detail page and finish
 * summary, the Changes {n} tab count, the editor's suggestion tab and the
 * transcript's Review suggestion entry point. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSuggestionBarController } = require('../renderer/features/renderer-suggestion-bar-controller');
const { createChangesView } = require('../renderer/features/renderer-changes-view');
const { click, entry, makeClient, settle, withRunMode } = require('./helpers/suggested-changes-fixtures');

/* ── Changes view: suggested state ── */

function viewSetup(host, entries, overrides = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>');
  const mountEl = dom.window.document.getElementById('mount');
  const made = makeClient(entries);
  const opened = [];
  const back = [];
  const view = createChangesView({
    host,
    getSessionId: () => 's1',
    getTurnViewModels: () => [],
    buildLedger: () => ({ changes: [], notices: [] }),
    renderDiffBody: (change) => `<div class="diff-line diff-line-add">${change.hunks.length} hunk</div>`,
    getSuggestedClient: () => made.client,
    createBarController: (options) => createSuggestionBarController({ ...options, storage: null }),
    openSuggestionDiff: (sessionId, id) => { opened.push([sessionId, id]); },
    onBackToChat: () => back.push(true),
    setInterval: () => 1,
    clearInterval: () => {},
    ...overrides,
  });
  return { dom, mountEl, view, opened, back, ...made };
}

const modeOf = (f) => f.mountEl.querySelector('.changes-view').getAttribute('data-changes-mode');

test('view: the dock shows the suggested state and opens a change in the editor', async () => {
  const f = viewSetup('dock', [entry('a'), entry('b')]);
  await f.client.refresh('s1');
  f.view.mount(f.mountEl);
  assert.equal(modeOf(f), 'suggested');
  assert.equal(f.mountEl.querySelector('.changes-view-title').textContent, 'Suggested changes');
  assert.match(f.mountEl.textContent, /Nothing in your files changes until you accept\./);
  assert.match(f.mountEl.querySelector('.inv-progress').getAttribute('aria-label'), /0 of 2 done/);
  const rows = f.mountEl.querySelectorAll('[data-changes-item]');
  assert.deepEqual(Array.from(rows).map((row) => row.getAttribute('data-changes-row-state')), ['current', 'review']);
  click(f.dom, rows[1]);
  assert.deepEqual(f.opened, [['s1', 'b']]);
  assert.equal(f.client.getCurrent('s1'), 'b');
  click(f.dom, f.mountEl.querySelector('[data-changes-show-history]'));
  assert.equal(modeOf(f), 'history');
  click(f.dom, f.mountEl.querySelector('[data-changes-show-suggested]'));
  assert.equal(modeOf(f), 'suggested');
  f.view.dispose();
});

test('view: the side panel decides on the detail page, then shows the finish summary', async () => {
  const f = viewSetup('panel', [entry('a'), entry('b')]);
  await f.client.refresh('s1');
  f.view.mount(f.mountEl);
  click(f.dom, f.mountEl.querySelectorAll('[data-changes-item]')[0]);
  assert.equal(modeOf(f), 'suggestion');
  assert.ok(f.mountEl.querySelector('[data-changes-bar-host] .suggestion-bar'));
  assert.match(f.mountEl.querySelector('.changes-detail-diff').textContent, /1 hunk/);
  click(f.dom, f.mountEl.querySelector('[data-suggestion-action="accept"]'));
  for (let i = 0; i < 4; i += 1) await settle();
  assert.deepEqual(f.bridge.calls[0], ['accept', 's1', 'a', 1]);
  assert.equal(modeOf(f), 'suggestion');
  assert.equal(f.mountEl.querySelector('[data-suggestion-bar]').getAttribute('data-suggestion-bar'), 'b', 'moved on to the next change');
  click(f.dom, f.mountEl.querySelector('[data-suggestion-action="reject"]'));
  click(f.dom, f.mountEl.querySelector('[data-suggestion-note-save]'));
  for (let i = 0; i < 4; i += 1) await settle();
  assert.equal(modeOf(f), 'finish');
  assert.match(f.mountEl.textContent, /Review finished/);
  assert.match(f.mountEl.textContent, /1 applied · 1 rejected · 0 later/);
  assert.match(f.mountEl.textContent, /Applied to 1 file\. Nothing has been tested yet\./);
  click(f.dom, f.mountEl.querySelector('[data-changes-back-to-chat]'));
  assert.deepEqual(f.back, [true]);
  assert.equal(modeOf(f), 'history');
  f.view.dispose();
});

test('view: comments waiting show Send, which sends the digest', async () => {
  await withRunMode('propose', async () => {
    const f = viewSetup('dock', [entry('a', { comments: [{ id: 'c1', text: 'Shorter', sent_at: null }] })]);
    await f.client.refresh('s1');
    f.view.mount(f.mountEl);
    assert.match(f.mountEl.querySelector('.changes-view-foot').textContent, /1 comment for Jenny/);
    click(f.dom, f.mountEl.querySelector('[data-changes-send]'));
    for (let i = 0; i < 4; i += 1) await settle();
    assert.deepEqual(f.sent.map((item) => item[0]), ['DIGEST']);
    f.view.dispose();
  });
});

test('view: a new revision replaces the side panel diff and the bar together', async () => {
  const f = viewSetup('panel', [entry('a'), entry('b')]);
  await f.client.refresh('s1');
  f.view.mount(f.mountEl);
  click(f.dom, f.mountEl.querySelectorAll('[data-changes-item]')[0]);
  assert.match(f.mountEl.querySelector('.changes-detail-diff').textContent, /1 hunk/);
  const a = f.bridge.entries[0];
  a.revision = 2;
  a.diff = { hunks: [a.diff.hunks[0], a.diff.hunks[0]] };
  await f.client.refresh('s1');
  assert.match(f.mountEl.querySelector('.changes-detail-diff').textContent, /2 hunk/);
  assert.equal(f.mountEl.querySelector('[data-suggestion-bar]').getAttribute('data-suggestion-revision'), '2');
  click(f.dom, f.mountEl.querySelector('[data-suggestion-action="accept"]'));
  for (let i = 0; i < 4; i += 1) await settle();
  assert.deepEqual(f.bridge.calls[0], ['accept', 's1', 'a', 2]);
  f.view.dispose();
});

test('editor: a new revision reopens its tab once, and the dirty check is registered with the editor', async () => {
  const { createIdeSuggestionDiff } = require('../renderer/features/renderer-ide-suggestion-diff');
  const made = makeClient([entry('a')]);
  await made.client.refresh('s1');
  const opened = [];
  const ide = { openTabs: [], activeTabPath: '' };
  const editorHost = {
    isDirty: (path) => path === 'src/a.py',
    openDiffDocument: async (doc) => { opened.push(doc); },
    activateDocument: (id) => { ide.activeTabPath = id; },
  };
  const diff = createIdeSuggestionDiff({
    getIde: () => ide,
    editorHost,
    getFileOperations: () => ({ readForMutation: async () => ({ content: 'x a y' }) }),
    ideStateUtils: { DIFF_TAB_PREFIX: 'diff://', openDiffTab: (state, tab) => state.openTabs.push({ path: tab.id }) },
    getClient: () => made.client,
    createBarController: (options) => createSuggestionBarController({ ...options, storage: null }),
  });
  assert.equal(made.client.isDirty('s1', 'a'), true, 'registered before any suggestion tab opened');
  assert.equal(await diff.openSuggestion('s1', 'a'), true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].modified, 'x b y');
  made.bridge.entries[0].revision = 2;
  await made.client.refresh('s1');
  for (let i = 0; i < 4; i += 1) await settle();
  assert.equal(opened.length, 2, 'one reopen for the new revision');
  diff.dispose();
  assert.equal(made.client.isDirty('s1', 'a'), false);
});

test('view: a transcript Review suggestion opens that change, even before the list loaded', async () => {
  const f = viewSetup('panel', [entry('a'), entry('b')]);
  f.view.mount(f.mountEl);
  assert.equal(f.view.revealSuggested({ toolCallId: 'call_b' }), true);
  for (let i = 0; i < 3; i += 1) await settle();
  assert.equal(modeOf(f), 'suggestion');
  assert.equal(f.mountEl.querySelector('[data-suggestion-bar]').getAttribute('data-suggestion-bar'), 'b');
  f.view.dispose();
});

/* ── Chat | Changes {n} ── */

test('dock: the workbench Changes tab counts the changes waiting for a decision', async () => {
  const { createIdeChatDock } = require('../renderer/features/renderer-ide-chat-dock');
  const changesViewModule = require('../renderer/features/renderer-changes-view');
  const dom = new JSDOM(`<!doctype html><body>
    <section id="chatView"><div id="chatThreadStage"><div id="chatThreadScroll"><div id="chatTimeline"></div></div></div>
      <div id="composerWrap"><textarea id="chatInput"></textarea></div><div id="artifactReviewResizer"></div></section>
    <div id="ideShell"><div id="ideMain"><div id="ideEditorHost" tabindex="0"></div></div>
      <aside id="ideChatDock" class="hidden"><header id="ideChatDockHeader"></header><div id="ideChatDockBody"></div></aside>
      <div id="changesHost"></div></div></body>`);
  const byId = (id) => dom.window.document.getElementById(id);
  let pending = 3;
  const listeners = [];
  const client = {
    get: () => ({ pending_count: pending, entries: [] }),
    getCurrent: () => '',
    activity: () => ({ generating: false }),
    subscribe: (cb) => { listeners.push(cb); return () => {}; },
  };
  const state = {
    ui: { activeView: 'ide' },
    features: { featureFlags: { ide_chat_dock: true } },
    sessions: [{ id: 's1', title: 'One', session_type: 'chat' }],
    currentSessionId: 's1',
  };
  let repaints = 0;
  const dock = createIdeChatDock({
    state,
    getDom: () => ({ ideShell: byId('ideShell'), ideChatDock: byId('ideChatDock'), ideChatDockHeader: byId('ideChatDockHeader'), ideChatDockBody: byId('ideChatDockBody') }),
    getIde: () => ({ chatDockOpen: true }),
    windowRef: dom.window,
    workbench: {
      setOpen: () => {}, reveal: () => {}, isVisible: (id) => id === 'chat',
      getChangesHost: () => byId('changesHost'), onCountChange: () => { repaints += 1; },
    },
    changesView: {
      loadChangesView: async () => changesViewModule,
      getSuggestedClient: () => client,
      viewDeps: { getTurnViewModels: () => [], buildLedger: () => ({ changes: [], notices: [] }), getSessionId: () => 's1' },
    },
  });
  dock.reconcile();
  assert.equal(dock.getChangesWaitingCount(), 3, 'the count the workbench Changes tab shows');
  pending = 0;
  const before = repaints;
  listeners.forEach((cb) => cb('s1'));
  assert.ok(repaints > before, 'a client change repaints the workbench chrome');
  assert.equal(dock.getChangesWaitingCount(), 0);
  dock.dispose?.();
});

/* ── Transcript entry point ── */

test('transcript: a recorded propose_change offers Review suggestion; a refused one offers nothing', () => {
  const toolCallUtils = require('../renderer/chat/tool-call-utils');
  const { escapeHtml } = require('../renderer/shared/string-utils');
  const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');
  const { renderReviewChangesAffordance } = require('../renderer/chat/renderer-code-review-affordance');
  const renderer = createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils });
  const metadata = { suggested_change: { schema_version: 1, kind: 'replace', path: 'src/a.js' } };
  const build = (isError) => {
    const toolUse = {
      id: 'tu_1', role: 'assistant', kind: 'tool_use',
      tool_call: { call_id: 'call_1', tool_name: 'propose_change', input: { path: 'src/a.js' }, input_json: '{}', summary: '', status: 'completed' },
    };
    const toolResult = {
      id: 'tr_1', role: 'assistant', kind: 'tool_result',
      tool_result: { call_id: 'call_1', tool_name: 'propose_change', output_text: '', summary: '', is_error: isError, duration_ms: 1, generated_artifacts: [], metadata },
    };
    const projectedToolRow = {
      kind: 'tool_step', tool_call_id: 'call_1', turn_id: 'turn_1', primary_message_id: 'tu_1', source_message_ids: ['tu_1', 'tr_1'],
      payload: {
        tool_call_id: 'call_1', tool_name: 'propose_change', input: { path: 'src/a.js' }, input_json: '{}', summary: '', state: 'completed',
        output_text: '', result_summary: '', result_is_error: isError, error_code: '', metadata,
      },
    };
    return renderer.buildToolCallViewModel(toolUse, [toolUse, toolResult], {
      projectedToolRow, messageById: new Map([['tu_1', toolUse], ['tr_1', toolResult]]),
    }).reviewableChange;
  };
  assert.deepEqual(build(false), { scope: 'suggested', turnId: 'turn_1', toolCallId: 'call_1' });
  assert.equal(build(true), null);
  const html = renderReviewChangesAffordance(build(false), { escapeHtml });
  assert.match(html, /Review suggestion/);
  assert.match(html, /data-tool-call-id="call_1"/);
});
