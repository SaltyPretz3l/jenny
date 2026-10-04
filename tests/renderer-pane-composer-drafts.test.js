'use strict';

/* Astra pane findings P1 (drafts) and P2 (selection): a pane shows, and
 * sends, the draft of the session it displays; a pane whose session changed
 * drops the selection mode it owned.
 *
 * Part A drives the pane composition rig (tests/helpers/pane-composition-rig.js)
 * with the REAL session-keyed composer store over a pane-0 #chatInput: swaps,
 * closes, replacements, a rekey and a focus change. Part B is the reported
 * repro through the real shell (jsdom harness): type in pane 1 on B, switch
 * pane 1 to C from the rail, press Send.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRig, paneRoot } = require('./helpers/pane-composition-rig');

function paneInput(rig) {
  return paneRoot(rig.chatView, 1).querySelector('textarea');
}

/* Pane 0 types through the live composer (the input handler's capture). */
function typeInPane0(rig, text) {
  rig.drafts.input.value = text;
  rig.drafts.controller.captureActive(rig.layoutController.createSessionContext(0).getSessionId(), 'input');
}

function draftRig(t) {
  const rig = createRig(t, {
    drafts: true,
    sessions: [
      { id: 'a', title: 'Alpha', project_id: '' },
      { id: 'b', title: 'Beta', project_id: '' },
      { id: 'c', title: 'Gamma', project_id: '', composer_draft: 'persisted C' },
    ],
  });
  rig.layoutController.openBeside('b');
  return rig;
}

test('P1: pane 1 switched to another chat shows THAT chat\'s draft, and the switched-away draft comes back with its chat', (t) => {
  const rig = draftRig(t);
  paneInput(rig).value = 'DRAFT FOR B';
  rig.layoutController.setFocusedPane(1);
  rig.layoutController.setPaneSession(1, 'c');
  assert.equal(paneInput(rig).value, 'persisted C', 'C shows its own (persisted) draft, never B\'s');
  paneInput(rig).value = '';
  rig.layoutController.setPaneSession(1, 'b');
  assert.equal(paneInput(rig).value, 'DRAFT FOR B', 'B\'s draft was kept for its return');
  rig.layoutController.setPaneSession(1, 'c');
  assert.equal(paneInput(rig).value, '', 'the cleared C draft stays cleared (the record wins over the persisted one)');
});

test('P1: a swap trades the drafts with the sessions (and pane 0\'s live queue goes with its session)', (t) => {
  const rig = draftRig(t);
  typeInPane0(rig, 'draft for A');
  rig.state.attachments = { queued: [{ id: 'att-a', assetPath: 'asset-a' }] };
  typeInPane0(rig, 'draft for A');
  paneInput(rig).value = 'draft for B';
  rig.layoutController.swapPanes();
  assert.deepEqual(rig.state.panes.panes.map((pane) => pane.sessionId), ['b', 'a']);
  assert.equal(rig.drafts.input.value, 'draft for B', 'pane 0 now shows B and B\'s draft');
  assert.equal(paneInput(rig).value, 'draft for A', 'pane 1 now shows A and A\'s draft');
  assert.deepEqual(rig.drafts.controller.getQueuedAttachments('a').map((entry) => entry.id), ['att-a'], 'A\'s queue is its record now (pane 1)');
  assert.deepEqual(rig.state.attachments.queued, [], 'the live queue is B\'s');
});

test('P1: closing pane 0 hands it pane 1\'s chat and draft; closing pane 1 keeps its draft for a reopen', (t) => {
  const rig = draftRig(t);
  typeInPane0(rig, 'draft for A');
  paneInput(rig).value = 'draft for B';
  rig.layoutController.closePane(0);
  assert.equal(rig.state.currentSessionId, 'b');
  assert.equal(rig.drafts.input.value, 'draft for B', 'pane 0 shows B\'s draft, not A\'s');
  rig.layoutController.openBeside('a');
  assert.equal(paneInput(rig).value, 'draft for A', 'A reopens beside with its draft');
  paneInput(rig).value = 'draft for A, edited';
  rig.layoutController.closePane(1);
  rig.layoutController.openBeside('a');
  assert.equal(paneInput(rig).value, 'draft for A, edited', 'closing pane 1 captured its text first');
});

test('P1: a focus change moves no text; a rekey keeps the text under the promoted id', (t) => {
  const rig = draftRig(t);
  typeInPane0(rig, 'draft for A');
  paneInput(rig).value = 'draft for B';
  rig.layoutController.setFocusedPane(1);
  rig.layoutController.setFocusedPane(0);
  assert.equal(rig.drafts.input.value, 'draft for A');
  assert.equal(paneInput(rig).value, 'draft for B');
  rig.drafts.controller.rekeySession('b', 'b-server');
  rig.layoutController.rekey('b', 'b-server');
  assert.equal(paneInput(rig).value, 'draft for B', 'the same chat keeps its text');
  assert.equal(rig.composition.getPane(1).draftSessionId, 'b-server');
  rig.layoutController.setPaneSession(1, 'c');
  rig.layoutController.setPaneSession(1, 'b-server');
  assert.equal(paneInput(rig).value, 'draft for B', 'and it is captured under the promoted id');
});

test('P1: openSession restoring pane 0 ahead of the layout keeps the incoming text; a capture in the gap cannot overwrite the outgoing draft', (t) => {
  const rig = draftRig(t);
  const { controller, input } = rig.drafts;
  typeInPane0(rig, 'draft for A');
  // openSession('c') with pane 0 focused: capture the outgoing, flip, restore the incoming.
  controller.captureActive('a', 'session_switch');
  rig.state.currentSessionId = 'c';
  controller.restoreForSession('c');
  assert.equal(input.value, 'persisted C');
  input.value = 'persisted C, typed in the gap';
  typeInPane0(rig, input.value); // the input handler still resolves pane 0 to 'a'
  assert.equal(controller.getQueuedAttachments('a').length, 0);
  rig.layoutController.syncFocusedPaneFromState(); // the layout catches up: pane 0 -> c
  assert.equal(rig.state.panes.panes[0].sessionId, 'c');
  assert.equal(input.value, 'persisted C, typed in the gap', 'the restore that ran ahead is kept');
  rig.layoutController.setPaneSession(0, 'a');
  assert.equal(input.value, 'draft for A', 'A\'s draft was never overwritten by C\'s text');
  rig.layoutController.setPaneSession(0, 'c');
  assert.equal(input.value, 'persisted C, typed in the gap', 'C\'s text was captured under C');
});

test('P2: a pane whose session changed tells its shell (replace, swap, close); focus, a rekey and a fresh mount do not', (t) => {
  const rig = draftRig(t);
  const changes = () => rig.events.filter(([kind]) => kind === 'session-changed').map(([, paneId, id]) => [paneId, id]);
  rig.layoutController.setFocusedPane(1);
  rig.layoutController.setFocusedPane(0);
  assert.deepEqual(changes(), [], 'a focus change keeps the selection');
  rig.layoutController.setPaneSession(1, 'c');
  assert.deepEqual(changes(), [[1, 'c']]);
  rig.layoutController.swapPanes();
  assert.deepEqual(changes().slice(1), [[0, 'c'], [1, 'a']]);
  rig.layoutController.rekey('a', 'a-server');
  assert.equal(changes().length, 3, 'a rekey is the same chat');
  rig.layoutController.closePane(0);
  assert.deepEqual(changes().slice(3), [[0, 'a-server']], 'pane 0 took pane 1\'s chat');
  rig.state.currentSessionId = 'b'; // one pane: a legacy writer, seen by the next render
  rig.composition.syncPaneLayout('all');
  assert.deepEqual(changes().slice(4), [[0, 'b']]);
});

test('P4: an unchanged composer sync writes nothing to pane 1\'s DOM', (t) => {
  const rig = createRig(t, { streaming: ['b'] });
  rig.layoutController.openBeside('b');
  const root = paneRoot(rig.chatView, 1);
  root.querySelector('textarea').value = 'hello';
  rig.composition.renderSessionPane('b', 'composer');
  const mutations = [];
  const observer = new rig.dom.window.MutationObserver((records) => mutations.push(...records));
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  t.after(() => observer.disconnect());
  for (let index = 0; index < 100; index += 1) rig.composition.renderSessionPane('b', 'composer');
  observer.takeRecords().forEach((record) => mutations.push(record));
  assert.deepEqual(mutations.map((record) => `${record.type}:${record.attributeName || record.target.className}`), []);
  assert.equal(root.querySelector('.composer-send').textContent, 'Queue', 'the streaming label still renders');
});

/* ── Astra review round 2: the openSession loading window. openSession
 * restores pane 0's composer for the incoming chat BEFORE the layout names it
 * (two panes, pane 0 focused, messages still loading). ── */
function openAheadOfLayout(rig, sessionId, typed) {
  const { controller, input } = rig.drafts;
  controller.captureActive(rig.state.panes.panes[0].sessionId, 'session_switch');
  rig.state.currentSessionId = sessionId;
  controller.restoreForSession(sessionId);
  if (typed !== undefined) input.value = typed;
}

function recordText(rig, sessionId) {
  const record = rig.state.composerSessionState.get(sessionId);
  return record ? record.text : undefined;
}

test('R2-1: a swap while openSession is loading keeps every draft with its own chat', (t) => {
  const rig = draftRig(t);
  typeInPane0(rig, 'draft for A');
  paneInput(rig).value = 'draft for B';
  openAheadOfLayout(rig, 'c', 'C typed while loading');
  rig.layoutController.swapPanes(); // the layout still named A for pane 0
  assert.equal(recordText(rig, 'a'), 'draft for A', 'A\'s draft is not overwritten by C\'s text');
  assert.equal(recordText(rig, 'c'), 'C typed while loading', 'the text typed for C stays C\'s');
  assert.equal(paneInput(rig).value, 'draft for A', 'pane 1 now shows A with A\'s draft');
  assert.equal(rig.drafts.input.value, 'draft for B', 'pane 0 shows B with B\'s draft');
});

test('R2-1: closing pane 0 while openSession is loading keeps A\'s draft for its return', (t) => {
  const rig = draftRig(t);
  typeInPane0(rig, 'draft for A');
  paneInput(rig).value = 'draft for B';
  openAheadOfLayout(rig, 'c', 'C typed while loading');
  rig.layoutController.closePane(0);
  assert.equal(rig.drafts.input.value, 'draft for B');
  rig.layoutController.openBeside('a');
  assert.equal(paneInput(rig).value, 'draft for A', 'reopening A shows A\'s draft, not C\'s');
  assert.equal(recordText(rig, 'c'), 'C typed while loading');
});

// The app's active merge (renderer-attachment-queue-utils.js mergePreparedAttachments) writes the session-keyed queue.
function commit(rig, token, entry) {
  const { controller } = rig.drafts;
  return controller.commitAttachmentResult(token, { accepted: [entry] }, {
    mergeActive: (payload, sessionId) => controller.appendQueuedAttachments(sessionId, payload.accepted),
  });
}
const ids = (list) => (list || []).map((entry) => entry.id);

test('R2-2: an attachment started in A that finishes while C loads lands in A, never in C\'s live queue', (t) => {
  const rig = draftRig(t);
  const { controller } = rig.drafts;
  const token = controller.beginAttachmentOp('a');
  openAheadOfLayout(rig, 'c');
  assert.equal(commit(rig, token, { id: 'a-file', assetPath: 'asset-a' }).target, 'origin');
  assert.deepEqual(ids(rig.state.attachments.queued), [], 'C\'s live queue stays clean');
  rig.layoutController.syncFocusedPaneFromState(); // the layout catches up: pane 0 -> c
  assert.deepEqual(ids(rig.state.attachments.queued), []);
  assert.deepEqual(ids(controller.getQueuedAttachments('a')), ['a-file'], 'A keeps its file');
});

test('R2-3: a late (stale) upload merges into the session\'s CURRENT queue and never drops a newer one', (t) => {
  const rig = draftRig(t);
  const { controller } = rig.drafts;
  const first = controller.beginAttachmentOp('a');
  rig.layoutController.swapPanes();
  rig.layoutController.swapPanes(); // A is back in pane 0: its restore moved the generation
  const second = controller.beginAttachmentOp('a');
  assert.equal(commit(rig, second, { id: 'file-2', assetPath: 'asset-2' }).target, 'active');
  assert.equal(commit(rig, first, { id: 'file-1', assetPath: 'asset-1' }).target, 'origin');
  assert.deepEqual(ids(rig.state.attachments.queued), ['file-2', 'file-1'], 'both uploads are queued');
  rig.layoutController.swapPanes();
  assert.deepEqual(ids(controller.getQueuedAttachments('a')), ['file-2', 'file-1'], 'and they travel with A');
});

test('R2-4: an attachment-only pane 1 composer: Send enabled, an unchanged sync writes nothing', (t) => {
  const rig = createRig(t, { queuedAttachments: { b: [{ id: 'att-b', name: 'b.txt' }] } });
  rig.layoutController.openBeside('b');
  const root = paneRoot(rig.chatView, 1);
  rig.composition.renderSessionPane('b', 'composer');
  const send = root.querySelector('.composer-send');
  assert.equal(send.disabled, false, 'a queued attachment alone makes Send available');
  const observer = new rig.dom.window.MutationObserver(() => {});
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  t.after(() => observer.disconnect());
  for (let index = 0; index < 100; index += 1) rig.composition.renderSessionPane('b', 'composer');
  assert.deepEqual(observer.takeRecords().map((record) => `${record.type}:${record.attributeName || ''}:${record.target.className}`), []);
  assert.equal(send.disabled, false);
});

/* ── Part B: the reported repro through the real shell ── */

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function buildSummary(id, title) {
  return {
    id, title, session_type: 'chat', conversation_mode: 'chat', preferred_model: 'gpt-test',
    reasoning_effort: 'default', plan_mode: false, pinned: false, archived_at: null,
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    linked_session_ids: [], interactive_round_count: 0, interactive_sequence_state: 'idle',
    pending_question_batch: null, updated_at: new Date().toISOString(),
  };
}

function transcript(sessionId) {
  return [
    { id: `user_${sessionId}`, role: 'user', content: `Question in ${sessionId}`, status: 'complete' },
    { id: `assistant_${sessionId}`, role: 'assistant', content: `Answer in ${sessionId}.`, status: 'complete', finalizedAt: new Date().toISOString() },
  ];
}

async function openThreeTabsTwoPanes(t) {
  const ids = ['session-a', 'session-b', 'session-c'];
  const app = await loadRendererApp({ shell: {
    sessions: ids.map((id) => buildSummary(id, id.slice(-1).toUpperCase())),
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ids },
    sessionMessagePayloads: Object.fromEntries(ids.map((id) => [id, { data: transcript(id) }])),
    chat: { async startStream(payload) { return { sessionId: payload.sessionId, streamId: `stream-${payload.sessionId}` }; } },
  } });
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const tab = doc.querySelector('.workspace-rail-tab[data-session-id="session-b"]');
  tab.dispatchEvent(new window.MouseEvent('contextmenu', { clientX: 5, clientY: 5, bubbles: true }));
  [...doc.querySelectorAll('.workspace-tab-context-menu-item')].find((item) => item.textContent === 'Open beside').click();
  await waitForUi(window, 150);
  const composition = window.rendererAppPaneComposition.getPaneComposition();
  const pane1 = composition.getPane(1);
  assert.ok(pane1, 'pane 1 is mounted');
  const state = window.__rendererState;
  const railClick = async (sessionId) => {
    doc.querySelector(`.workspace-rail-tab-button[data-workspace-activate="${sessionId}"]`).click();
    await waitForUi(window, 150);
  };
  return { window, doc, composition, pane1, state, railClick, shell: window.jennyShell };
}

test('P1 repro: type in pane 1 on B, switch pane 1 to C from the rail, Send: nothing of B\'s reaches C', async (t) => {
  const { window, pane1, state, railClick, shell } = await openThreeTabsTwoPanes(t);
  pane1.dom.chatInput.value = 'DRAFT FOR B';
  pane1.dom.chatInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  pane1.dom.chatInput.focus();
  assert.equal(state.panes.focusedPaneId, 1, 'precondition: pane 1 is focused');
  await railClick('session-c');
  assert.equal(state.panes.panes[1].sessionId, 'session-c', 'pane 1 now shows C');
  assert.equal(pane1.dom.chatInput.value, '', 'C has no draft');
  pane1.sendButton.click();
  await waitForUi(window, 60);
  assert.deepEqual(shell.__state.chatCalls.filter((call) => /DRAFT FOR B/.test(String(call.prompt || ''))), [], 'B\'s draft was not sent to C');
  await railClick('session-b');
  assert.equal(state.panes.panes[1].sessionId, 'session-b');
  assert.equal(pane1.dom.chatInput.value, 'DRAFT FOR B', 'B\'s draft is back with B');
});

test('P2 repro: a Shift+Click selection in pane 1 survives a focus change and ends when pane 1 switches chats', async (t) => {
  const { window, doc, pane1, state, railClick } = await openThreeTabsTwoPanes(t);
  const article = pane1.dom.chatTimeline.querySelector('article[data-message-id]');
  assert.ok(article, 'precondition: pane 1 renders B\'s transcript');
  article.dispatchEvent(new window.MouseEvent('click', { button: 0, shiftKey: true, bubbles: true, cancelable: true }));
  await waitForUi(window, 60);
  assert.equal(state.ui.selectionModePaneId, 1, 'pane 1 owns the selection mode');
  doc.getElementById('chatInput').focus();
  await waitForUi(window, 30);
  assert.equal(state.panes.focusedPaneId, 0);
  assert.equal(state.ui.selectionModePaneId, 1, 'moving focus to pane 0 keeps pane 1\'s selection');
  pane1.dom.chatInput.focus();
  await railClick('session-c');
  assert.equal(state.panes.panes[1].sessionId, 'session-c');
  assert.equal(state.ui.selectionModePaneId, null, 'the switch ended pane 1\'s selection');
  assert.equal(pane1.dom.chatTimeline.querySelectorAll('[data-select-message-id]').length, 0, 'C renders no selection handles');
});
