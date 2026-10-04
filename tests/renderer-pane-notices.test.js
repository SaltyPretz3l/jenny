'use strict';

/* Split view W3-1 -- the composer notices, the pending-skill chip and the drop
 * highlight belong to the pane that shows their session.
 *
 * Before W3-1 four composer surfaces were pane 0's alone: the status notice (a
 * paste into pane 1 set it, pane 0 painted it or nobody did), the attachment
 * preview pill, the failed-send notice (it read the FOCUSED session) and the
 * pending-skill chip; and pane 0's drop highlight sat on #chatView, lighting
 * pane 1's composer too. These drive the real shell (jsdom harness) with two
 * panes: pane 0 on session-a, pane 1 on session-b.
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

function transcript(sessionId, text, { failed = false } = {}) {
  return [
    {
      id: `user_${sessionId}`, role: 'user', content: `Question for ${text}`, status: 'complete',
      ...(failed ? { send_failure: { state: 'failed', payload_id: `payload_${sessionId}`, reason: 'network' } } : {}),
    },
    { id: `assistant_${sessionId}`, role: 'assistant', content: `Answer from ${text}.`, status: 'complete', finalizedAt: new Date().toISOString() },
  ];
}

async function openTwoPanes(t, { failedInB = false, withC = false, shell = {} } = {}) {
  const app = await loadRendererApp({ shell: {
    sessions: [buildSummary('session-a', 'Alpha'), buildSummary('session-b', 'Beta')]
      .concat(withC ? [buildSummary('session-c', 'Gamma')] : []),
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ['session-a', 'session-b'].concat(withC ? ['session-c'] : []) },
    sessionMessagePayloads: {
      'session-a': { data: transcript('session-a', 'pane zero') },
      'session-b': { data: transcript('session-b', 'pane one', { failed: failedInB }) },
      ...(withC ? { 'session-c': { data: transcript('session-c', 'pane one later') } } : {}),
    },
    ...shell,
  } });
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
  return { window, doc, composition, pane1, state };
}

const paneNode = (pane1, name) => pane1.root.querySelector(`[data-chat-node="${name}"]`);
const isShown = (node) => Boolean(node) && !node.classList.contains('hidden');

function pasteText(window, input, text) {
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [], types: ['text/plain'], files: [], getData: (type) => (type === 'text/plain' ? text : '') },
  });
  input.dispatchEvent(event);
  return event;
}

function pasteImage(window, input, name) {
  const blob = new window.Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
  blob.name = name;
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [{ type: 'image/png', getAsFile() { return blob; } }], types: ['Files'], files: [blob], getData: () => '' },
  });
  input.dispatchEvent(event);
  return event;
}

function dragEvent(window, type) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [], types: ['Files'] } });
  return event;
}

test('a paste over 1 MB into pane 1 shows the size notice under pane 1\'s composer, never pane 0\'s', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  const paneOneNotice = paneNode(pane1, 'composerStatusNotice');
  const paneZeroNotice = doc.getElementById('composerStatusNotice');
  assert.ok(paneOneNotice && paneOneNotice !== paneZeroNotice, 'precondition: pane 1 carries its own notice host');
  const event = pasteText(window, pane1.dom.chatInput, 'x'.repeat(1024 * 1024 + 8));
  await waitForUi(window, 40);
  assert.equal(event.defaultPrevented, true, 'precondition: the oversized paste was rejected (no input event follows)');
  assert.equal(state.ui.composerStatusNoticeSessionId, 'session-b', 'the notice is keyed to the pasting pane\'s session');
  assert.equal(isShown(paneOneNotice), true, 'pane 1 paints the notice without any further render');
  assert.match(paneOneNotice.textContent, /Paste is too large/);
  assert.equal(isShown(paneZeroNotice), false);

  state.harness.agentActions.setActiveView('chat'); // a full pane-0 repaint
  await waitForUi(window, 60);
  assert.equal(isShown(paneZeroNotice), false, 'pane 0\'s repaint leaves pane 1\'s notice alone');
  assert.equal(paneZeroNotice.textContent.includes('Paste is too large'), false);
});

test('a large (accepted) paste into pane 1 warns under pane 1 only', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  const event = pasteText(window, pane1.dom.chatInput, 'y'.repeat(200 * 1024));
  await waitForUi(window, 40);
  assert.equal(event.defaultPrevented, false, 'precondition: a warned paste is accepted');
  assert.match(paneNode(pane1, 'composerStatusNotice').textContent, /Large paste added/);
  assert.equal(isShown(doc.getElementById('composerStatusNotice')), false);
});

test('pane 1\'s preview pill counts pane 1\'s tray; pane 0\'s stays hidden', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  const paneZeroPill = doc.getElementById('composerAttachmentPreviewPill');
  const paneOnePill = paneNode(pane1, 'composerAttachmentPreviewPill');
  assert.equal(paneZeroPill.dataset.composerV2, 'on', 'precondition: pane 0 mounted its pill');
  assert.equal(paneOnePill.dataset.composerV2, 'on', 'pane 1 mirrors it');
  pasteImage(window, pane1.dom.chatInput, 'side.png');
  await waitForUi(window, 80);
  assert.equal(isShown(paneOnePill), true);
  assert.match(paneOnePill.textContent, /1/);
  assert.equal(isShown(paneZeroPill), false, 'pane 0\'s queue is empty, so is its pill');
});

test('a failed send in pane 1\'s session shows its notice under pane 1; dismiss clears it there', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t, { failedInB: true });
  const paneOneFailed = paneNode(pane1, 'composerV2FailedSendNotice');
  const paneZeroFailed = doc.getElementById('composerV2FailedSendNotice');
  await waitForUi(window, 60);
  assert.equal(paneOneFailed.dataset.composerV2, 'on');
  assert.equal(isShown(paneOneFailed), true, 'pane 1 scans session-b and finds the failure');
  assert.equal(isShown(paneZeroFailed), false, 'pane 0 scans session-a');

  pane1.dom.chatInput.dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true })); // focus pane 1
  await waitForUi(window, 60);
  assert.equal(state.currentSessionId, 'session-b', 'precondition: pane 1 is focused');
  state.harness.agentActions.setActiveView('chat'); // a full pane-0 repaint while pane 1 is focused
  await waitForUi(window, 60);
  assert.equal(isShown(paneZeroFailed), false, 'focusing pane 1 does not move its failure into pane 0');

  paneOneFailed.querySelector('[data-action="dismiss"]').click();
  await waitForUi(window, 80);
  assert.equal(isShown(paneOneFailed), false, 'dismissed in pane 1');
  const failed = state.messagesBySession.get('session-b').find((message) => message.id === 'user_session-b');
  assert.equal(failed.send_failure.dismissed, true);
});

test('a pending skill for pane 1\'s session chips pane 1\'s tray only, and pane 0\'s tray render keeps it', async (t) => {
  const { window, doc, composition, pane1, state } = await openTwoPanes(t);
  const skillState = window.rendererComposerV2State;
  skillState.setPendingSkillInvocation(state, { id: 'skill-1', name: 'Research', command: 'research' }, { getSessionId: () => 'session-b' });
  composition.renderSessionPane('session-b', 'composer');
  const chip = paneNode(pane1, 'attachmentTray').querySelector('[data-inv-chip="attached-skill"]');
  assert.ok(chip, 'pane 1\'s tray carries the chip');
  assert.equal(paneNode(pane1, 'attachmentTray').classList.contains('hidden'), false);

  pasteImage(window, doc.getElementById('chatInput'), 'zero.png'); // renders pane 0's tray
  await waitForUi(window, 80);
  assert.equal(doc.getElementById('composerSkillChip'), null, 'pane 0 shows no chip for pane 1\'s skill');
  assert.equal(skillState.peekPendingSkillInvocation(state, 'session-b').id, 'skill-1', 'painting pane 0 did not drop it');

  chip.click();
  await waitForUi(window, 40);
  assert.equal(skillState.peekPendingSkillInvocation(state, 'session-b'), null, 'the chip removes the skill');
  assert.equal(paneNode(pane1, 'attachmentTray').querySelector('[data-inv-chip="attached-skill"]'), null);
});

test('a drag over pane 0 lights #chatPane0 only: not the view, not pane 1', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  const chatView = doc.getElementById('chatView');
  const paneZero = doc.getElementById('chatPane0');
  doc.getElementById('chatInput').dispatchEvent(dragEvent(window, 'dragenter'));
  await waitForUi(window, 20);
  assert.equal(paneZero.classList.contains('chat-drop-active'), true, 'pane 0 lights its own root');
  assert.equal(chatView.classList.contains('chat-drop-active'), false, 'the view carries no highlight');
  assert.equal(pane1.root.classList.contains('chat-drop-active'), false, 'pane 1\'s composer stays dark');
  doc.getElementById('chatInput').dispatchEvent(dragEvent(window, 'dragleave'));
  await waitForUi(window, 20);
  assert.equal(paneZero.classList.contains('chat-drop-active'), false);
});

// Gate D11 (2026-09-26): pane 0's drag listeners sit on #chatView, which also holds pane 1, so a
// drag moving from pane 0 into pane 1 must clear pane 0's highlight (containment is pane 0's root).
test('a drag moving from pane 0 into pane 1 clears pane 0\'s highlight', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  const paneZero = doc.getElementById('chatPane0');
  doc.getElementById('chatInput').dispatchEvent(dragEvent(window, 'dragenter'));
  await waitForUi(window, 20);
  assert.equal(paneZero.classList.contains('chat-drop-active'), true, 'precondition: pane 0 lit');
  const leave = dragEvent(window, 'dragleave');
  Object.defineProperty(leave, 'relatedTarget', { value: pane1.root.querySelector('textarea') });
  doc.getElementById('chatInput').dispatchEvent(leave);
  await waitForUi(window, 20);
  assert.equal(paneZero.classList.contains('chat-drop-active'), false, 'pane 0 went dark when the drag entered pane 1');
});

/* Gate §D follow-ups (2026-09-26). The one notice slot is keyed to a session, and a keyed notice
 * belongs to the pane showing that session: never to pane 0 just because no other pane shows it. */
const HUGE_PASTE = 'x'.repeat(1024 * 1024 + 8);

test('pane 1 closing with its session\'s notice up never hands the notice to pane 0', async (t) => {
  const { window, doc, composition, pane1, state } = await openTwoPanes(t);
  pasteText(window, pane1.dom.chatInput, HUGE_PASTE);
  await waitForUi(window, 40);
  assert.equal(state.ui.composerStatusNoticeSessionId, 'session-b', 'precondition: the notice is session-b\'s');
  assert.equal(composition.toggleSplit(), true, 'precondition: the chord closes pane 1');
  await waitForUi(window, 80);
  state.harness.agentActions.setActiveView('chat'); // a full pane-0 repaint
  await waitForUi(window, 60);
  const paneZeroNotice = doc.getElementById('composerStatusNotice');
  assert.equal(isShown(paneZeroNotice), false, 'session-a\'s pane shows no notice of session-b\'s');
  assert.equal(paneZeroNotice.textContent.includes('Paste is too large'), false);
});

test('pane 1 switching to another chat drops its old session\'s notice from both panes', async (t) => {
  const { window, doc, composition, pane1, state } = await openTwoPanes(t, { withC: true });
  pasteText(window, pane1.dom.chatInput, HUGE_PASTE);
  await waitForUi(window, 40);
  assert.equal(isShown(paneNode(pane1, 'composerStatusNotice')), true, 'precondition: pane 1 shows it');
  assert.equal(composition.getDropTarget().onDrop('session-c', 'right'), true, 'a tab dropped on pane 1 replaces session-b');
  await waitForUi(window, 80);
  assert.equal(state.panes.panes[1].sessionId, 'session-c');
  state.harness.agentActions.setActiveView('chat');
  await waitForUi(window, 60);
  assert.equal(isShown(doc.getElementById('composerStatusNotice')), false, 'pane 0 (session-a) never paints it');
  assert.equal(isShown(paneNode(composition.getPane(1), 'composerStatusNotice')), false, 'pane 1 (session-c) does not either');
});

test('a keyed notice moving from pane 0 to pane 1 takes pane 0\'s copy down at once', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  const paneZeroNotice = doc.getElementById('composerStatusNotice');
  pasteText(window, doc.getElementById('chatInput'), HUGE_PASTE);
  await waitForUi(window, 40);
  assert.equal(state.ui.composerStatusNoticeSessionId, 'session-a');
  assert.equal(isShown(paneZeroNotice), true, 'precondition: pane 0 shows its own paste notice');
  pasteText(window, pane1.dom.chatInput, HUGE_PASTE);
  await waitForUi(window, 40);
  assert.equal(state.ui.composerStatusNoticeSessionId, 'session-b');
  assert.equal(isShown(paneNode(pane1, 'composerStatusNotice')), true);
  assert.equal(isShown(paneZeroNotice), false, 'pane 0 repaints when the slot leaves it, with no composer render of its own');
});

test('compaction progress for pane 1\'s session shows under pane 1\'s composer, not pane 0\'s', async (t) => {
  let settle = null;
  const compactNow = () => new Promise((resolve) => {
    settle = () => resolve({ status: 'ok', compacted: true, snapshot_persisted: true, tokens_before: 4000, tokens_after: 1200 });
  });
  const { window, doc, pane1, state } = await openTwoPanes(t, { shell: { chat: { compactNow } } });
  const paneOneNotice = paneNode(pane1, 'composerStatusNotice');
  const paneZeroNotice = doc.getElementById('composerStatusNotice');
  const run = state.compactionCoordinator.invoke('session-b', { source: 'test' });
  await waitForUi(window, 40);
  assert.ok(settle, 'precondition: the compaction is in flight');
  assert.equal(isShown(paneOneNotice), true, 'pane 1 shows its session compacting');
  assert.match(paneOneNotice.textContent, /Compacting context/);
  assert.equal(paneOneNotice.getAttribute('aria-busy'), 'true');
  assert.equal(isShown(paneZeroNotice), false, 'pane 0 (session-a) is not compacting');
  settle();
  await run;
  await waitForUi(window, 40);
  assert.match(paneOneNotice.textContent, /Compacted: 4000 -> 1200 tokens/, 'the settled result follows in pane 1');
  assert.notEqual(paneOneNotice.getAttribute('aria-busy'), 'true');
  assert.equal(isShown(paneZeroNotice), false);
});

test('a draft over 1 MB is refused at send in either pane: the size notice shows there, nothing sends', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  const chatCalls = window.jennyShell.__state.chatCalls;
  const enter = (input) => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const typeInto = (input, value) => { input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); };

  typeInto(pane1.dom.chatInput, HUGE_PASTE); // typed, or pasted in pieces: the paste guard never saw it
  await waitForUi(window, 20);
  enter(pane1.dom.chatInput);
  await waitForUi(window, 60);
  assert.equal(chatCalls.length, 0, 'pane 1 sent nothing');
  assert.equal(pane1.dom.chatInput.value.length, HUGE_PASTE.length, 'the draft stays for the user to trim');
  assert.match(paneNode(pane1, 'composerStatusNotice').textContent, /too large to send/);
  assert.equal(state.ui.composerStatusNoticeSessionId, 'session-b');

  const input = doc.getElementById('chatInput');
  typeInto(input, HUGE_PASTE);
  await waitForUi(window, 20);
  enter(input);
  await waitForUi(window, 60);
  assert.equal(chatCalls.length, 0, 'pane 0 sent nothing');
  assert.match(doc.getElementById('composerStatusNotice').textContent, /too large to send/);
  assert.equal(isShown(paneNode(pane1, 'composerStatusNotice')), false, 'the slot moved to pane 0');

  typeInto(input, 'a short follow-up');
  await waitForUi(window, 20);
  enter(input);
  await waitForUi(window, 80);
  assert.equal(chatCalls.length, 1, 'a draft under the cap still sends');
});
