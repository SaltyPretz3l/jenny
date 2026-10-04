'use strict';

/* Split view: the per-pane subagent inspector and the side panel's jump stay
 * inside the pane they belong to (docs/plans/split-view/W1_OWNER_GATE.md §D,
 * the four inspector P3s):
 *   1. the monitor is the shared artifact panel's `subagents` mode: no pane
 *      root or view carries an open mark, and one pane's open replaces the
 *      other's;
 *   2. pane 1's monitor markup carries no id that collides with pane 0's,
 *      and its aria references resolve inside the monitor;
 *   3. a path chip in pane 1 (its transcript or the monitor's evidence) opens
 *      like one in pane 0, with pane 1 focused;
 *   4. "Jump to chat" scrolls and highlights the pane that shows the panel's
 *      chat.
 *
 * Driven through the real shell (jsdom harness), two panes from the chord:
 * pane 0 on session-a, pane 1 on session-b. Both subagent reports use the
 * same task id, as reports without one do (`child-1`), so their per-child
 * ids would collide.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { installSmoothScrollModel, stubRect } = require('./helpers/smooth-scroll-model');

function buildSummary(id, title) {
  return {
    id,
    title,
    session_type: 'chat',
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    plan_mode: false,
    pinned: false,
    archived_at: null,
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    linked_session_ids: [],
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
  };
}

function transcript(sessionId, fileName, subagentLabel) {
  const stream = `stream_${sessionId}`;
  return [
    { id: `user_${sessionId}`, role: 'user', content: `Make ${fileName}`, status: 'complete' },
    {
      id: `assistant_${sessionId}`, role: 'assistant', content: 'Writing it.', status: 'complete',
      streamId: stream, finalizedAt: '2026-09-26T10:00:00.000Z',
    },
    {
      id: `tool_use_${sessionId}`,
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      finalizedAt: '2026-09-26T10:00:01.000Z',
      tool_call: { call_id: `call_${sessionId}`, tool_name: 'create_artifact', parent_stream_id: stream, summary: `Create ${fileName}`, input: {} },
    },
    {
      id: `tool_${sessionId}`,
      role: 'assistant',
      kind: 'tool_result',
      status: 'complete',
      finalizedAt: '2026-09-26T10:00:02.000Z',
      tool_result: {
        call_id: `call_${sessionId}`,
        tool_name: 'create_artifact',
        parent_stream_id: stream,
        summary: `Create ${fileName}`,
        output_text: 'ok',
        is_error: false,
        generated_artifacts: [{
          artifact_id: `art_${sessionId}`,
          artifact_kind: 'document',
          file_name: fileName,
          language: 'python',
          editable: true,
          status: 'available',
          session_id: sessionId,
        }],
      },
    },
    {
      id: `subagent_${sessionId}`,
      role: 'tool',
      kind: 'tool_result',
      status: 'complete',
      tool_result: {
        call_id: `sub_${sessionId}`,
        tool_name: 'delegate_research',
        metadata: { subagent_report: {
          label: subagentLabel,
          status: 'failed',
          terminal_reason: 'deadline_exceeded',
          summary: 'Done.',
          evidence: [{ relative_path: `src/${fileName}`, summary: 'The file.' }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          error: { code: 'CMP-AGENT-0001', message: 'Timed out', retryable: true },
        } },
      },
    },
    {
      id: `assistant_end_${sessionId}`, role: 'assistant', content: `Wrote ${fileName}.`, status: 'complete',
      streamId: stream, finalizedAt: '2026-09-26T10:00:03.000Z',
    },
  ];
}

function bootOptions(sessions) {
  return {
    artifactReviewPreferences: { enabled: false, collapsed: false, width: 420 },
    shell: {
      sessions: sessions.map(([id, title]) => buildSummary(id, title)),
      workspaceState: { activeSessionId: sessions[0][0], openSessionIds: sessions.map(([id]) => id) },
      sessionMessagePayloads: Object.fromEntries(sessions.map(([id, , file, label]) => [id, { data: transcript(id, file, label) }])),
      artifacts: { read: async () => ({ artifact: { editable: true, status: 'available' }, content: 'print(1)' }) },
    },
  };
}

const TWO_SESSIONS = [
  ['session-a', 'Alpha chat', 'alpha.py', 'Alpha subagent'],
  ['session-b', 'Beta chat', 'beta.py', 'Beta subagent'],
];

async function openTwoPanes(t) {
  const app = await loadRendererApp(bootOptions(TWO_SESSIONS));
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const composition = window.rendererAppPaneComposition.getPaneComposition();
  assert.equal(composition.toggleSplit(), true, 'precondition: the chord opens session-b beside');
  await waitForUi(window, 150);
  const pane1 = composition.getPane(1);
  assert.ok(pane1, 'pane 1 is mounted');
  const state = window.__rendererState;
  assert.equal(state.panes.panes[1].sessionId, 'session-b');
  return { window, doc, pane1, state };
}

/* A real click: the capture-phase pointerdown focuses the pane first. */
async function clickInPane(window, element) {
  element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  element.click();
  await waitForUi(window, 80);
}

function placeSubagentTrigger(timeline, callId) {
  timeline.insertAdjacentHTML('beforeend', `<button type="button" class="subagent-summary-trigger" data-subagent-open="${callId}" aria-controls="subagentInspector">Open</button>`);
  return timeline.lastElementChild;
}

function placeChip(timeline, artifactId) {
  timeline.insertAdjacentHTML('beforeend', `<button type="button" data-inv-artifact-action="panel" data-artifact-id="${artifactId}">Open</button>`);
  return timeline.lastElementChild;
}

function placePathChip(timeline, relPath) {
  timeline.insertAdjacentHTML('beforeend', `<span class="tool-path-chip" role="link" tabindex="0" data-chat-path-open="${relPath}">${relPath}</span>`);
  return timeline.lastElementChild;
}

function recordOpenFileEvents(window, state) {
  const opened = [];
  window.addEventListener('ide:open-file-at-line', (event) => {
    opened.push({ path: event.detail.path, focusedSessionId: state.currentSessionId });
  }, true);
  return opened;
}

const panelMonitor = (doc) => doc.getElementById('artifactReviewPanel').querySelector('.subagent-monitor-shell');

test('an open monitor is the artifact panel\'s mode: no pane root, view or stage carries an open mark, and one pane\'s open replaces the other\'s', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  const chatView = doc.getElementById('chatView');
  const pane0Root = doc.getElementById('chatPane0');
  await clickInPane(window, placeSubagentTrigger(doc.getElementById('chatTimeline'), 'sub_session-a'));
  assert.equal(doc.getElementById('artifactReviewPanel').dataset.artifactReviewMode, 'subagents', 'precondition: pane 0\'s trigger opened the panel\'s monitor');
  assert.equal(state.ui.subagentMonitor.sessionId, 'session-a');
  assert.match(panelMonitor(doc).textContent, /Alpha subagent/);
  for (const node of [chatView, pane0Root, pane1.root, doc.getElementById('chatThreadStage')]) {
    assert.equal(/subagent-monitor-(open|compact|stage)/.test(node.className), false, 'no host mark on the pane roots, the view or the stage');
  }
  assert.equal(doc.getElementById('subagentInspector').hidden, true, 'the in-stage aside stays out of Chat');

  await clickInPane(window, placeSubagentTrigger(pane1.dom.chatTimeline, 'sub_session-b'));
  assert.equal(state.ui.subagentMonitor.sessionId, 'session-b', 'pane 1\'s open replaces the record');
  assert.match(panelMonitor(doc).textContent, /Beta subagent/);
  assert.equal(doc.querySelectorAll('.subagent-monitor-shell').length, 1, 'one monitor exists at a time');
  panelMonitor(doc).querySelector('[data-subagent-close]').click();
  await waitForUi(window, 40);
  assert.equal(state.ui.subagentMonitor, null);
  assert.equal(doc.getElementById('artifactReviewPanel').dataset.artifactReviewMode, 'artifact', 'closing leaves the mode');
  assert.equal(panelMonitor(doc), null);
});

test('one pane: the monitor takes the artifact panel column and leaves the chat column and the context panel alone', async (t) => {
  // The first artifact in a chat opens the panel expanded unless the user
  // closed it in that chat (D1); this chat's Close keeps the start closed.
  const app = await loadRendererApp({
    ...bootOptions([TWO_SESSIONS[0]]),
    artifactReviewPreferences: { enabled: false, width: 420, dismissedForSession: { 'session-a': true } },
  });
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const chatView = doc.getElementById('chatView');
  const panel = doc.getElementById('artifactReviewPanel');
  assert.equal(panel.classList.contains('hidden'), true, 'precondition: the panel starts closed');
  await clickInPane(window, placeSubagentTrigger(doc.getElementById('chatTimeline'), 'sub_session-a'));
  assert.equal(panel.classList.contains('hidden'), false, 'the panel shows');
  assert.equal(panel.dataset.artifactReviewMode, 'subagents');
  assert.equal(chatView.classList.contains('artifact-review-mode'), true, 'the shared panel layout classes apply');
  assert.equal(panel.getAttribute('aria-label'), 'Subagent monitor');
  assert.ok(panelMonitor(doc).querySelector('.subagent-monitor-header'), 'a header');
  assert.ok(panelMonitor(doc).querySelector('.subagent-monitor-body'), 'one scrolling body');
  assert.ok(panelMonitor(doc).querySelector('.subagent-monitor-footer'), 'and a footer');
  panelMonitor(doc).querySelector('[data-subagent-close]').click();
  await waitForUi(window, 40);
  assert.equal(panel.classList.contains('hidden'), true, 'closing restores the closed panel');
  assert.equal(panel.getAttribute('aria-label'), 'Artifact review');
});

test('the monitor CSS carries no stage-grid classes, no view or pane-root column overrides and no fixed-height body', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-subagent-monitor.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/subagent-monitor-(stage|open|compact)/.test(css), false, 'no stage or pane-root open marks');
  assert.equal(/\.chat-view\b/.test(css), false, 'no #chatView column override');
  assert.equal(/calc\(100% - 52px\)/.test(css), false, 'no fixed-height body');
  assert.equal(/subagent-monitor-(master|detail)\b/.test(css), false, 'no two-column body');
  assert.equal(/(?:border-inline-start|border-left)[^;]*(?:accent|state-)/.test(css), false, 'no highlight bar');
  assert.ok(css.includes('#artifactReviewPanel[data-artifact-review-mode="subagents"] .artifact-panel-header'), 'the V3 header is hidden in this mode');
});

test('the monitor in the panel carries no duplicate id; pane 1\'s trigger controls the panel and its disclosures resolve inside the monitor', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  const trigger0 = placeSubagentTrigger(doc.getElementById('chatTimeline'), 'sub_session-a');
  const trigger1 = placeSubagentTrigger(pane1.dom.chatTimeline, 'sub_session-b');
  await clickInPane(window, trigger0);
  await clickInPane(window, trigger1);
  const monitor = panelMonitor(doc);
  assert.match(monitor.textContent, /Beta subagent/, 'precondition: pane 1\'s report is showing');

  const ids = Array.from(doc.querySelectorAll('[id]'), (node) => node.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], 'the document holds no duplicate id');
  assert.ok(monitor.querySelectorAll('[id]').length > 0, 'the monitor names its title and disclosures');
  assert.ok(monitor.querySelectorAll('[id]').length > 0 && [...monitor.querySelectorAll('[id]')].every((node) => node.id.endsWith('-pane1')), 'pane 1\'s ids carry its suffix');
  assert.equal(doc.getElementById(trigger1.getAttribute('aria-controls')), doc.getElementById('artifactReviewPanel'), 'the trigger controls the panel that hosts the monitor');
  for (const disclosure of monitor.querySelectorAll('[aria-controls]')) {
    assert.ok(monitor.contains(doc.getElementById(disclosure.getAttribute('aria-controls'))), 'each disclosure controls a region inside the monitor');
  }

  // The footer's Details disclosure opens the usage grid inside the monitor.
  const usage = monitor.querySelector('.subagent-usage-trigger');
  assert.ok(usage, 'precondition: the drill-in footer offers the usage details');
  usage.click();
  await waitForUi(window, 40);
  assert.equal(monitor.querySelector('.subagent-usage-detail').hidden, false, 'the usage grid opened');
});

test('a path chip in pane 1\'s transcript or the monitor\'s evidence opens the file like one in pane 0, with pane 1 focused', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  const opened = recordOpenFileEvents(window, state);

  await clickInPane(window, placePathChip(doc.getElementById('chatTimeline'), 'src/zero.py'));
  assert.deepEqual(opened, [{ path: 'src/zero.py', focusedSessionId: 'session-a' }], 'precondition: pane 0\'s chip opens');

  await clickInPane(window, placePathChip(pane1.dom.chatTimeline, 'src/one.py'));
  assert.deepEqual(opened[1], { path: 'src/one.py', focusedSessionId: 'session-b' }, 'pane 1\'s transcript chip opens for pane 1');

  await clickInPane(window, placeSubagentTrigger(pane1.dom.chatTimeline, 'sub_session-b'));
  const evidence = panelMonitor(doc).querySelector('[data-chat-path-open="src/beta.py"]');
  assert.ok(evidence, 'precondition: the monitor shows pane 1\'s evidence path');
  await clickInPane(window, evidence);
  assert.deepEqual(opened[2], { path: 'src/beta.py', focusedSessionId: 'session-b' }, 'the monitor\'s evidence link opens for pane 1');
  assert.equal(opened.length, 3, 'each click opened once');
});

test('"Jump to chat" scrolls and highlights the pane that shows the panel\'s chat', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  const source1 = pane1.dom.chatTimeline.querySelector('[data-message-id="tool_use_session-b"]');
  assert.ok(source1, 'precondition: pane 1 renders the artifact\'s source row');
  await clickInPane(window, placeChip(pane1.dom.chatTimeline, 'art_session-b'));
  assert.equal(state.artifacts.selectedArtifactId, 'art_session-b', 'precondition: the panel shows pane 1\'s artifact');
  const jumpButton = doc.getElementById('artifactReviewJumpButton');
  assert.equal(jumpButton.getAttribute('data-artifact-jump'), 'tool_use_session-b');
  // Both transcripts scrolled to the top of a long history, reader detached
  // (2026-09-27 gate F5: the highlight landed but nothing scrolled).
  // Real geometry for each pane's composer layout pass (zero height skips it).
  for (const root of [doc.getElementById('chatPane0'), pane1.root]) {
    stubRect(root, { top: 0, bottom: 900, height: 900 });
    stubRect(root.querySelector('[data-chat-node="chatThreadStage"]'), { top: 0, bottom: 700, height: 700 });
    stubRect(root.querySelector('[data-chat-node="composerWrap"]'), { top: 720, bottom: 880, height: 160 });
  }
  stubRect(doc.getElementById('chatView'), { top: 0, bottom: 900, height: 900 });
  const scroll0 = installSmoothScrollModel(window, doc.getElementById('chatThreadScroll'));
  const scroll1 = installSmoothScrollModel(window, pane1.root.querySelector('[data-chat-node="chatThreadScroll"]'));
  state.ui.followLatest = false;

  jumpButton.click();
  // One frame into the reveal, pane 1 takes a layout pass (in the app, its
  // composer's ResizeObserver as focus lands there; jsdom has none).
  await waitForUi(window, 40);
  assert.ok(scroll1.top < 1000, 'precondition: the reveal is still animating');
  pane1.surface.viewportApi.updateComposerSafeOffset({ force: true, syncViewport: true });
  await scroll1.waitForIdle();
  await waitForUi(window, 40);
  const highlighted = Array.from(doc.querySelectorAll('.artifact-source-highlight'));
  assert.equal(highlighted.length, 1, 'one row is highlighted');
  assert.ok(pane1.dom.chatTimeline.contains(highlighted[0]), 'in pane 1\'s timeline');
  assert.equal(highlighted[0].getAttribute('data-message-id'), 'tool_use_session-b');
  assert.equal(doc.getElementById('chatTimeline').querySelector('.artifact-source-highlight'), null, 'pane 0 is untouched');
  assert.equal(scroll1.calls.length, 1, 'pane 1\'s transcript reveals the row');
  assert.equal(scroll1.calls[0].element, highlighted[0]);
  assert.deepEqual(scroll1.abortedBy, [], 'nothing cancels pane 1\'s smooth reveal');
  assert.equal(scroll1.top, 1000, 'pane 1 scrolled to the source row');
  assert.equal(scroll0.calls.length, 0, 'pane 0 is not revealed into');
  assert.equal(scroll0.top, 0, 'pane 0 did not scroll');
});
