'use strict';

/* Split view W3-2 -- the side panel owner and the per-pane subagent monitor
 * (spec docs/plans/split-view/W3_SPEC_2026-09-26.md §3; the pure owner module
 * is pinned by tests/renderer-side-panel-owner.test.js).
 *
 * These drive the real shell (jsdom harness): two panes mounted from the
 * chord, pane 0 on session-a ("Alpha chat") and pane 1 on session-b ("Beta
 * chat"), each with one generated artifact and one finished subagent report.
 * A lone persisted tool_result renders no row, so each test places the
 * transcript's own "Open in panel" chip (data-inv-artifact-action="panel") or
 * subagent trigger (data-subagent-open) in a pane's timeline and clicks it: the
 * click then runs through that pane's real transcript bindings or monitor.
 * Every click is preceded by the capture-phase pointerdown that focuses the
 * pane, as a real click is.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

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
  return [
    { id: `user_${sessionId}`, role: 'user', content: `Make ${fileName}`, status: 'complete' },
    {
      id: `tool_${sessionId}`,
      role: 'tool',
      kind: 'tool_result',
      status: 'complete',
      tool_result: {
        call_id: `call_${sessionId}`,
        tool_name: 'create_artifact',
        generated_artifacts: [{
          artifact_id: `art_${sessionId}`,
          artifact_kind: 'document',
          file_name: fileName,
          language: 'python',
          editable: true,
          status: 'available',
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
        metadata: { subagent_report: { task_id: `child_${sessionId}`, label: subagentLabel, status: 'completed', summary: 'Done.' } },
      },
    },
    { id: `assistant_${sessionId}`, role: 'assistant', content: `Wrote ${fileName}.`, status: 'complete', finalizedAt: new Date().toISOString() },
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

async function openTwoPanes(t) {
  const app = await loadRendererApp(bootOptions([
    ['session-a', 'Alpha chat', 'alpha.py', 'Alpha subagent'],
    ['session-b', 'Beta chat', 'beta.py', 'Beta subagent'],
  ]));
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
  assert.equal(state.currentSessionId, 'session-a', 'pane 0 keeps focus');
  return { app, window, doc, composition, pane1, state };
}

/* A real click: the capture-phase pointerdown focuses the pane first. */
async function clickInPane(window, element) {
  element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  element.click();
  await waitForUi(window, 80);
}

/* The transcript's "Open in panel" chip for `artifactId`, placed in `timeline`. */
function placeChip(timeline, artifactId) {
  timeline.insertAdjacentHTML('beforeend', `<button type="button" data-inv-artifact-action="panel" data-artifact-id="${artifactId}">Open</button>`);
  return timeline.lastElementChild;
}

function placeSubagentTrigger(timeline, callId) {
  timeline.insertAdjacentHTML('beforeend', `<button type="button" class="subagent-summary-trigger" data-subagent-open="${callId}">Open</button>`);
  return timeline.lastElementChild;
}

function ownerLine(doc) {
  return doc.getElementById('artifactReviewPanel').querySelector(':scope > .side-panel-owner-line');
}

function ownerTitle(doc) {
  return ownerLine(doc)?.querySelector('.side-panel-owner-title')?.textContent;
}

test('the panel stays with the chat that opened it: focusing the other pane keeps its artifact and names it', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  await clickInPane(window, placeChip(doc.getElementById('chatTimeline'), 'art_session-a'));
  const panel = doc.getElementById('artifactReviewPanel');
  assert.equal(panel.classList.contains('hidden'), false, 'the panel opened');
  assert.equal(state.ui.sidePanelOwnerSessionId, 'session-a');
  assert.equal(state.artifacts.selectedSessionId, 'session-a');
  assert.equal(state.artifacts.selectedArtifactId, 'art_session-a');

  const line = ownerLine(doc);
  assert.ok(line, 'two panes: the From line sits in the panel');
  assert.equal(line.tagName, 'P');
  assert.equal(panel.firstElementChild, line, 'above the panel header');
  assert.equal(ownerTitle(doc), 'Alpha chat');
  assert.equal(line.firstChild.nodeType, window.Node.TEXT_NODE, 'the template words sit outside the title span');
  assert.equal(line.firstChild.textContent, 'From');
  assert.equal(line.childNodes.length, 2, 'English: "From" then the title');

  // Focus pane 1 (a pointerdown in its composer) and let the full render run.
  pane1.dom.chatInput.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  await waitForUi(window, 120);
  assert.equal(state.currentSessionId, 'session-b', 'pane 1 has focus now');
  assert.equal(state.ui.sidePanelOwnerSessionId, 'session-a', 'focus alone never moves the owner');
  assert.equal(state.artifacts.selectedSessionId, 'session-a', 'the panel still shows pane 0\'s artifact');
  assert.equal(ownerLine(doc), line, 'the same line node: nothing it names changed, so it was not rebuilt');
  assert.equal(ownerTitle(doc), 'Alpha chat', 'and it still names pane 0\'s chat');
  assert.equal(doc.getElementById('chatContextPanel').querySelector('.orbit-card'), null, 'the context panel no longer lists artifacts');
  const contextPanel = doc.getElementById('chatContextPanel');
  const contextLine = contextPanel.querySelector(':scope > .side-panel-owner-line');
  assert.ok(contextLine, 'and carries its own From line');
  assert.equal(contextPanel.firstElementChild, contextLine, 'above its header');
  assert.equal(contextLine.querySelector('.side-panel-owner-title').textContent, 'Alpha chat');
  assert.equal(contextLine.querySelector('.side-panel-owner-title').getAttribute('dir'), 'auto',
    'the title keeps its own direction inside RTL chrome (live re-check NF5)');
});

test('opening an artifact from pane 1 switches the panel to pane 1\'s chat', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  await clickInPane(window, placeChip(doc.getElementById('chatTimeline'), 'art_session-a'));
  assert.equal(state.ui.sidePanelOwnerSessionId, 'session-a');
  await clickInPane(window, placeChip(pane1.dom.chatTimeline, 'art_session-b'));
  assert.equal(state.currentSessionId, 'session-b', 'the pointerdown focused pane 1 first');
  assert.equal(state.ui.sidePanelOwnerSessionId, 'session-b', 'the explicit open claimed the panel');
  assert.equal(state.artifacts.selectedSessionId, 'session-b', 'the panel shows pane 1\'s artifact');
  assert.equal(state.artifacts.selectedArtifactId, 'art_session-b');
  assert.equal(ownerTitle(doc), 'Beta chat');
});

test('swapping the panes (the kicker drag) keeps the owner on the same chat', async (t) => {
  const { window, doc, state } = await openTwoPanes(t);
  await clickInPane(window, placeChip(doc.getElementById('chatTimeline'), 'art_session-a'));
  assert.equal(state.ui.sidePanelOwnerSessionId, 'session-a');
  const kicker0 = doc.getElementById('chatPaneKicker');
  kicker0.setPointerCapture = () => {};
  kicker0.releasePointerCapture = () => {};
  doc.querySelector('.chat-pane[data-pane-id="1"]').getBoundingClientRect = () => ({ left: 410, right: 800, top: 0, bottom: 600, width: 390, height: 600 });
  const pointer = (target, type, init) => target.dispatchEvent(new window.PointerEvent(type, { button: 0, pointerId: 7, bubbles: true, ...init }));
  pointer(kicker0.querySelector('.chat-pane-kicker-title'), 'pointerdown', { clientX: 50, clientY: 10 });
  pointer(kicker0, 'pointermove', { clientX: 60, clientY: 10 });
  pointer(kicker0, 'pointermove', { clientX: 600, clientY: 100 });
  pointer(kicker0, 'pointerup', { clientX: 600, clientY: 100 });
  await waitForUi(window, 120);
  assert.deepEqual(Array.from(state.panes.panes, (pane) => pane.sessionId), ['session-b', 'session-a'], 'the sessions traded sides');
  assert.equal(state.ui.sidePanelOwnerSessionId, 'session-a', 'the owner followed its chat, not its side');
  assert.equal(state.artifacts.selectedSessionId, 'session-a');
  assert.equal(ownerTitle(doc), 'Alpha chat');
});

test('closing the pane that owns the panel closes it without the per-chat dismissal', async (t) => {
  const { window, doc, composition, pane1, state } = await openTwoPanes(t);
  await clickInPane(window, placeChip(pane1.dom.chatTimeline, 'art_session-b'));
  assert.equal(state.ui.sidePanelOwnerSessionId, 'session-b');
  const panel = doc.getElementById('artifactReviewPanel');
  assert.equal(panel.classList.contains('hidden'), false, 'precondition: the panel shows pane 1\'s artifact');

  doc.querySelector('.chat-pane[data-pane-id="1"] .chat-pane-close').click();
  await waitForUi(window, 120);
  assert.equal(composition.getPane(1), null, 'pane 1 is gone');
  assert.equal(panel.classList.contains('hidden'), true, 'the panel closed');
  assert.equal(state.ui.artifactReview.enabled, false);
  assert.equal(state.ui.artifactReview.dismissedForSession, undefined, 'auto-open still works later');
  const stored = JSON.parse(window.localStorage.getItem('jenny.artifactReview.v1'));
  assert.equal(stored.enabled, false, 'the close is saved');
  assert.equal(stored.dismissedForSession, undefined);
  assert.equal(state.ui.sidePanelOwnerSessionId, '', 'one pane keeps no owner');
  assert.equal(doc.querySelector('.side-panel-owner-line'), null, 'one pane: no From line anywhere');
});

test('closing the pane that does not own the panel leaves it open and drops the From line', async (t) => {
  const { window, doc, composition, state } = await openTwoPanes(t);
  await clickInPane(window, placeChip(doc.getElementById('chatTimeline'), 'art_session-a'));
  assert.ok(ownerLine(doc), 'precondition: two panes show the From line');
  assert.equal(composition.toggleSplit(), true, 'pane 0 focused: the chord closes pane 1');
  await waitForUi(window, 120);
  assert.equal(composition.getPane(1), null);
  const panel = doc.getElementById('artifactReviewPanel');
  assert.equal(panel.classList.contains('hidden'), false, 'the panel stays open on the remaining chat');
  assert.equal(state.ui.artifactReview.enabled, true);
  assert.equal(state.artifacts.selectedSessionId, 'session-a');
  assert.equal(doc.querySelector('.side-panel-owner-line'), null, 'the From line leaves with the second pane');
});

test('one pane: an open carries no From line and never writes an owner', async (t) => {
  const app = await loadRendererApp(bootOptions([['session-a', 'Alpha chat', 'alpha.py', 'Alpha subagent']]));
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  await clickInPane(window, placeChip(doc.getElementById('chatTimeline'), 'art_session-a'));
  assert.equal(doc.getElementById('artifactReviewPanel').classList.contains('hidden'), false);
  assert.equal(window.__rendererState.artifacts.selectedSessionId, 'session-a');
  assert.equal(doc.querySelector('.side-panel-owner-line'), null);
  assert.equal(window.__rendererState.ui.sidePanelOwnerSessionId, undefined, 'the owner slot is never written with one pane');
});

test('each pane\'s monitor renders its own session in the shared panel, whichever pane has focus', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  const panel = doc.getElementById('artifactReviewPanel');
  const monitor = () => panel.querySelector('.subagent-monitor-shell');
  const inspector0 = doc.getElementById('subagentInspector');
  const inspector1 = pane1.root.querySelector('[data-chat-node="subagentInspector"]');
  assert.ok(inspector1 && inspector1 !== inspector0, 'precondition: pane 1 still carries its own aside (the IDE dock host)');

  const trigger0 = placeSubagentTrigger(doc.getElementById('chatTimeline'), 'sub_session-a');
  await clickInPane(window, trigger0);
  assert.equal(panel.dataset.artifactReviewMode, 'subagents', 'pane 0\'s monitor opened in the shared panel');
  assert.match(monitor().textContent, /Alpha subagent/);
  assert.equal(inspector0.hidden, true, 'the asides stay closed in Chat');
  assert.equal(inspector1.hidden, true);
  assert.match(panel.querySelector(':scope > .side-panel-owner-line').textContent, /Alpha chat/, 'the owner line names pane 0\'s chat');

  // Focus pane 1: the panel stays with pane 0's chat through the full render
  // that follows (the monitor must never read the focused session).
  pane1.dom.chatInput.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  await waitForUi(window, 120);
  assert.equal(state.currentSessionId, 'session-b');
  assert.equal(state.ui.subagentMonitor.sessionId, 'session-a');
  assert.match(monitor().textContent, /Alpha subagent/, 'the panel still shows pane 0\'s subagent');
  assert.doesNotMatch(monitor().textContent, /Beta subagent/);

  const trigger1 = placeSubagentTrigger(pane1.dom.chatTimeline, 'sub_session-b');
  await clickInPane(window, trigger1);
  assert.equal(state.ui.subagentMonitor.sessionId, 'session-b', 'pane 1\'s open takes the panel over');
  assert.match(monitor().textContent, /Beta subagent/, 'with pane 1\'s subagent');
  assert.match(panel.querySelector(':scope > .side-panel-owner-line').textContent, /Beta chat/, 'the owner line follows');
  assert.equal(trigger0.getAttribute('aria-expanded'), 'false', 'pane 0\'s card resets when its record is replaced');
  assert.equal(trigger1.getAttribute('aria-expanded'), 'true');
});

test('closing the pane whose monitor holds the panel restores what the monitor displaced, not a collapse', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  await clickInPane(window, placeChip(doc.getElementById('chatTimeline'), 'art_session-a'));
  const panel = doc.getElementById('artifactReviewPanel');
  assert.equal(panel.classList.contains('hidden'), false, 'precondition: pane 0\'s artifact shows');
  await clickInPane(window, placeSubagentTrigger(pane1.dom.chatTimeline, 'sub_session-b'));
  assert.equal(state.ui.subagentMonitor.sessionId, 'session-b', 'precondition: pane 1\'s monitor took the panel');

  doc.querySelector('.chat-pane[data-pane-id="1"] .chat-pane-close').click();
  await waitForUi(window, 120);
  assert.equal(state.ui.subagentMonitor ?? null, null, 'the monitor closed with its pane');
  assert.equal(state.ui.artifactReview.mode, 'artifact');
  assert.equal(state.ui.artifactReview.enabled, true, 'the generic owner-closed close did not run over the restore');
  assert.equal(panel.classList.contains('hidden'), false, 'the artifact panel is back as it was');
  const stored = JSON.parse(window.localStorage.getItem('jenny.artifactReview.v1'));
  assert.equal(stored.enabled, true, 'no close was saved');
});

// W3 open item, row 115 slice 2a: the context panel hosts only Activity now, and the owner closing collapses it.
test('closing the pane that owns an open Activity panel collapses it', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  const contextPanel = doc.getElementById('chatContextPanel');
  assert.equal(contextPanel.classList.contains('collapsed'), true, 'collapsed unless Activity is open');
  assert.equal(doc.getElementById('contextPanelOpenToggle'), null, 'no bar button opens the context panel any more');
  state.features = { ...(state.features || {}), featureFlags: { ...(state.features?.featureFlags || {}), activity_monitor: true } };
  pane1.dom.chatInput.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  await waitForUi(window, 80);
  const open = doc.querySelector('[data-activity-open]');
  assert.ok(open, 'Activity keeps its node in the bar even though CSS hides it');
  open.hidden = false;
  open.click();
  await waitForUi(window, 80);
  assert.equal(contextPanel.classList.contains('collapsed'), false, 'precondition: Activity opened the panel');
  assert.equal(state.ui.sidePanelOwnerSessionId, 'session-b', 'the explicit open claimed the panel for the focused chat');
  doc.querySelector('.chat-pane[data-pane-id="1"] .chat-pane-close').click();
  await waitForUi(window, 120);
  assert.equal(contextPanel.classList.contains('collapsed'), true, 'the panel collapsed with its owner');
});

// Gate side finding: with pane 1 focused, collapsing the review panel kept focus off pane 0.
test('collapsing the review panel with pane 1 focused keeps focus (and the focused pane) on pane 1', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  await clickInPane(window, placeChip(pane1.dom.chatTimeline, 'art_session-b'));
  assert.equal(state.currentSessionId, 'session-b');
  doc.getElementById('artifactReviewCollapseButton').click();
  await waitForUi(window, 120);
  assert.equal(state.currentSessionId, 'session-b', 'pane 1 stays the focused pane');
  assert.equal(doc.activeElement?.closest('.chat-pane')?.dataset.paneId, '1', 'focus stays inside pane 1');
});
