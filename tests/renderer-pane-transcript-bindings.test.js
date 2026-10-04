'use strict';

/* Split view W2-3 -- pane 1 is a full conversation.
 *
 * Wave 1 gave pane 1 a minimal chat-event facade (Send, Stop, Enter, input):
 * its transcript was inert. W2-3 hands pane 1's shell the SAME
 * createChatEventBindings pane 0 uses, bound to pane 1's dom, sub-controllers
 * and session context; a second pane registers only the pane-scoped listener
 * set (tests/renderer-chat-event-utils-pane-bindings.test.js pins the sets).
 *
 * These drive the real shell (jsdom harness), two panes mounted from the tab
 * menu, pane 0 focused on session-a, pane 1 showing session-b. Clicks are
 * dispatched WITHOUT the pointerdown that would move focus to pane 1, so each
 * assertion proves the action resolved through pane 1's own context, not
 * through a focus change.
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

function transcript(sessionId, text) {
  return [
    { id: `user_${sessionId}`, role: 'user', content: `Question for ${text}`, status: 'complete' },
    { id: `assistant_${sessionId}`, role: 'assistant', content: `Answer from ${text}.`, status: 'complete', finalizedAt: new Date().toISOString() },
  ];
}

/* Records every addEventListener/removeEventListener in the app window from
   the moment it is installed, so a test can name what pane 1 registered. */
function trackListeners(t, window) {
  const proto = window.EventTarget.prototype;
  const originalAdd = proto.addEventListener;
  const originalRemove = proto.removeEventListener;
  const entries = [];
  proto.addEventListener = function add(type, handler, options) {
    entries.push({ target: this, type, handler, signal: options && typeof options === 'object' ? options.signal : null, removed: false });
    return originalAdd.call(this, type, handler, options);
  };
  proto.removeEventListener = function remove(type, handler, options) {
    entries.filter((entry) => entry.target === this && entry.type === type && entry.handler === handler)
      .forEach((entry) => { entry.removed = true; });
    return originalRemove.call(this, type, handler, options);
  };
  const restore = () => { proto.addEventListener = originalAdd; proto.removeEventListener = originalRemove; };
  t.after(restore);
  return { entries, restore };
}

async function openTwoPanes(t, extraShell = {}, { beforeOpen } = {}) {
  const app = await loadRendererApp({ shell: {
    sessions: [buildSummary('session-a', 'Alpha'), buildSummary('session-b', 'Beta')],
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ['session-a', 'session-b'] },
    sessionMessagePayloads: {
      'session-a': { data: transcript('session-a', 'pane zero') },
      'session-b': { data: transcript('session-b', 'pane one') },
    },
    ...extraShell,
  } });
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const before = typeof beforeOpen === 'function' ? beforeOpen(window) : null;
  const composition = window.rendererAppPaneComposition.getPaneComposition();
  assert.equal(composition.toggleSplit(), true, 'precondition: the chord opens session-b beside');
  await waitForUi(window, 150);
  const pane1 = composition.getPane(1);
  assert.ok(pane1, 'pane 1 is mounted');
  assert.equal(window.__rendererState.panes.panes[1].sessionId, 'session-b');
  assert.equal(window.__rendererState.currentSessionId, 'session-a', 'pane 0 keeps focus');
  return { app, window, doc, composition, pane1, before };
}

async function sendFromPaneOne(window, pane1, text) {
  pane1.dom.chatInput.value = text;
  pane1.dom.chatInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  pane1.sendButton.click();
  await waitForUi(window, 60);
}

const streamIntoB = {
  chat: {
    async startStream(payload) {
      return { sessionId: payload.sessionId, streamId: 'stream-b' };
    },
  },
};

test('copy in pane 1 copies pane 1\'s message, not the focused pane\'s', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  const writes = [];
  window.jennyShell.clipboard.writeText = async (text) => { writes.push(text); return { ok: true }; };
  const copy = pane1.dom.chatTimeline.querySelector('[data-message-action="copy"][data-message-id="assistant_session-b"]');
  assert.ok(copy, 'precondition: pane 1 renders a copy action for its assistant reply');
  copy.click();
  await waitForUi(window, 40);
  assert.equal(writes.length, 1, 'exactly one clipboard write');
  assert.match(writes[0], /Answer from pane one\./);
  assert.equal(window.__rendererState.currentSessionId, 'session-a', 'the copy never moved focus');
  assert.equal(doc.getElementById('chatTimeline').querySelector('[data-message-id="assistant_session-b"]'), null);
});

test('a tool row toggle in pane 1 expands pane 1\'s row and leaves pane 0\'s timeline byte-identical', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t, streamIntoB);
  const shell = window.jennyShell;
  await sendFromPaneOne(window, pane1, 'run a command');
  const emit = async (payload) => {
    await shell.__emitChat({ sessionId: 'session-b', streamId: 'stream-b', ...payload });
    await waitForUi(window, 70);
  };
  await emit({ type: 'started' });
  await emit({ type: 'tool_use', callId: 'call-b', toolName: 'run_command', summary: 'run_command node -v', input: { command: 'node -v' }, status: 'running' });
  await emit({ type: 'tool_result', callId: 'call-b', toolName: 'run_command', input: { command: 'node -v' }, summary: 'run_command node -v',
    content: 'v22.0.0', isError: false, approvalState: 'auto', durationMs: 5, metadata: { exitCode: 0 } });
  const rowSelector = '[data-tool-call-id="call-b"].tool-call-row, [data-call-id="call-b"]';
  const row = pane1.dom.chatTimeline.querySelector(rowSelector);
  assert.ok(row, 'precondition: pane 1 renders the tool row');
  const toggle = row.querySelector('.tool-call-header, [data-tool-row-toggle]');
  assert.ok(toggle, 'precondition: the row has a disclosure');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');

  const pane0Timeline = doc.getElementById('chatTimeline');
  const before = pane0Timeline.innerHTML;
  toggle.click();
  await waitForUi(window, 60);
  const after = pane1.dom.chatTimeline.querySelector(rowSelector).querySelector('.tool-call-header, [data-tool-row-toggle]');
  assert.equal(after.getAttribute('aria-expanded'), 'true', 'pane 1\'s row expanded');
  assert.equal(pane0Timeline.innerHTML, before, 'pane 0\'s timeline is byte-identical');
});

test('an inline approval in pane 1 resolves pane 1\'s approval', async (t) => {
  const approveCalls = [];
  const { window, doc, pane1 } = await openTwoPanes(t, {
    ...streamIntoB,
    tools: { approve: (ref) => { approveCalls.push(ref); return { ok: true }; } },
  });
  const shell = window.jennyShell;
  await sendFromPaneOne(window, pane1, 'write a file');
  await shell.__emitChat({ type: 'started', sessionId: 'session-b', streamId: 'stream-b' });
  await shell.__emitChat({ type: 'tool_approval_needed', sessionId: 'session-b', streamId: 'stream-b',
    callId: 'call-write-b', approvalId: 'approval-b', toolName: 'write_file', input: { path: 'b.txt', content: 'x' } });
  await waitForUi(window, 80);
  assert.equal(doc.getElementById('chatTimeline').querySelector('.tool-approve-btn'), null, 'pane 0 shows no approval card');
  const allow = pane1.dom.chatTimeline.querySelector('.tool-approve-btn:not(.tool-approve-always-btn)');
  assert.ok(allow, 'precondition: pane 1 renders the approval card');
  allow.click();
  await waitForUi(window, 80);
  assert.deepEqual(approveCalls, ['approval-b']);
  assert.equal(window.__rendererState.currentSessionId, 'session-a', 'the approval never moved focus');
});

test('Enter in pane 1\'s composer sends to pane 1\'s session', async (t) => {
  const { window, pane1 } = await openTwoPanes(t, streamIntoB);
  pane1.dom.chatInput.value = 'enter from the side pane';
  pane1.dom.chatInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  pane1.dom.chatInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitForUi(window, 60);
  const chatCalls = window.jennyShell.__state.chatCalls;
  assert.equal(chatCalls.length, 1);
  assert.equal(chatCalls[0].sessionId, 'session-b');
});

test('after both panes mount, New chat, Home and the window keydown keep exactly pane 0\'s handler', async (t) => {
  let tracker = null;
  const { window, doc } = await openTwoPanes(t, {}, {
    beforeOpen: (win) => {
      tracker = trackListeners(t, win);
      return true;
    },
  });
  tracker.restore();
  const on = (target, type) => tracker.entries.filter((entry) => entry.target === target && entry.type === type).length;
  assert.equal(on(doc.getElementById('newChatButton'), 'click'), 0, 'pane 1 added no New chat handler');
  assert.equal(on(doc.getElementById('homeNavButton'), 'click'), 0, 'pane 1 added no Home handler');
  const viewToggles = [...doc.querySelectorAll('[data-transcript-view-toggle]')];
  assert.equal(viewToggles.length, 2, 'each pane cluster carries its own transcript view control');
  assert.equal(on(viewToggles[0], 'click'), 0, "pane 1 did not touch pane 0's view control");
  assert.equal(on(viewToggles[1], 'click'), 1, 'pane 1 bound exactly its own view control');
  // One window keydown is pane 1's scroll coordinator (W1: it marks scroll-key
  // intent for its own thread); the zoom-reset keydown stays pane 0's.
  assert.equal(on(window, 'keydown'), 1, 'pane 1 added no zoom-reset window keydown');
  assert.equal(on(doc.getElementById('composerCommandPopover'), 'click'), 0, 'pane 1 left the command popover to pane 0');
  assert.ok(tracker.entries.some((entry) => entry.type === 'click' && entry.target.closest?.('.chat-pane[data-pane-id="1"]')), 'pane 1 did bind its own timeline');

  const creates = [];
  const create = window.jennyShell.sessions.create;
  window.jennyShell.sessions.create = (...args) => { creates.push(args); return create(...args); };
  doc.getElementById('newChatButton').click();
  await waitForUi(window, 80);
  assert.equal(creates.length, 1, 'one click, one session');
});

test('unmounting pane 1 releases every listener it registered on a node that outlives it', async (t) => {
  let tracker = null;
  const { window, doc, composition, pane1 } = await openTwoPanes(t, {}, {
    beforeOpen: (win) => { tracker = trackListeners(t, win); return null; },
  });
  const paneRoot = pane1.root;
  const registered = tracker.entries.slice();
  assert.ok(registered.length > 0);
  const layoutClose = doc.querySelector('.chat-pane[data-pane-id="1"] .chat-pane-close');
  assert.ok(layoutClose, 'precondition: pane 1 carries its close glyph');
  layoutClose.click();
  await waitForUi(window, 80);
  tracker.restore();
  assert.equal(composition.getPane(1), null, 'pane 1 is gone');
  const outlives = (entry) => entry.target === window || entry.target === doc
    || (typeof entry.target.isConnected === 'boolean' && entry.target.isConnected);
  const leaked = registered
    .filter((entry) => !entry.removed && !(entry.signal && entry.signal.aborted))
    .filter((entry) => !paneRoot.contains(entry.target))
    .filter(outlives)
    .map((entry) => `${entry.target === window ? 'window' : entry.target === doc ? 'document' : (entry.target.id || entry.target.className || entry.target.nodeName)}:${entry.type}`);
  assert.deepEqual(leaked, [], 'nothing pane 1 bound on the document, the window or pane 0 survives it');
});

test('closing pane 1 leaves pane 0\'s file-diff registry (expansion overrides) intact', async (t) => {
  const { window, doc, composition } = await openTwoPanes(t);
  const fileDiff = window.rendererFileDiffBindings;
  assert.ok(fileDiff && typeof fileDiff.registerFileDiffContext === 'function', 'precondition: the registry module is loaded');
  assert.equal(fileDiff.registerFileDiffContext({ diffId: 'diff-a', sessionId: 'session-a', materialize: () => {}, expanded: true }), true);
  assert.equal(fileDiff.getFileDiffExpanded('diff-a'), true, 'precondition: pane 0 holds an expanded override');
  doc.querySelector('.chat-pane[data-pane-id="1"] .chat-pane-close').click();
  await waitForUi(window, 80);
  assert.equal(composition.getPane(1), null, 'pane 1 is gone');
  assert.equal(fileDiff.getFileDiffExpanded('diff-a'), true, 'pane 1\'s teardown did not clear the shared registry');
});

test('selection in pane 1 mounts the action bar in pane 1\'s own host; an Esc exit unmounts it', async (t) => {
  const { window, doc, composition, pane1 } = await openTwoPanes(t);
  const paneHost = pane1.root.querySelector('[data-chat-node="chatSelectionOverlayHost"]');
  assert.ok(paneHost && paneHost !== doc.getElementById('chatSelectionOverlayHost'), 'precondition: pane 1 carries its own host');
  window.__rendererState.ui.selectionModePaneId = 1; // the handles render only in the pane that owns selection mode
  composition.renderSessionPane('session-b', 'messages');
  const handle = pane1.dom.chatTimeline.querySelector('[data-select-message-id="assistant_session-b"]');
  assert.ok(handle, 'precondition: pane 1 renders the selection handle');
  handle.click();
  await waitForUi(window, 40);
  assert.deepEqual(window.__rendererState.ui.selectedMessageIdsBySession.get('session-b') && [...window.__rendererState.ui.selectedMessageIdsBySession.get('session-b')], ['assistant_session-b'], 'pane 1 selected in its own session');
  assert.ok(paneHost.querySelector('.selection-action-bar, [role="toolbar"]'), 'the bar mounted in pane 1\'s host');
  assert.equal(paneHost.hidden, false);
  assert.equal(doc.getElementById('chatSelectionOverlayHost').children.length, 0, 'pane 0\'s host stays empty');

  doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.selectionModePaneId, null);
  assert.equal(paneHost.children.length, 0, 'pane 1\'s bar unmounted with its mode');
  assert.equal(paneHost.hidden, true);
});

/* Split view W3-1: selection mode has one owner (state.ui.selectionModePaneId). */
async function selectInPaneOne(window, composition, pane1) {
  window.__rendererState.ui.selectionModePaneId = 1;
  composition.renderSessionPane('session-b', 'messages');
  const handle = pane1.dom.chatTimeline.querySelector('[data-select-message-id="assistant_session-b"]');
  assert.ok(handle, 'precondition: pane 1 renders the selection handle');
  handle.click();
  await waitForUi(window, 40);
}

test('pane 1 selecting leaves pane 0\'s articles without selection markup', async (t) => {
  const { window, doc, composition, pane1 } = await openTwoPanes(t);
  await selectInPaneOne(window, composition, pane1);
  // Even a selection set recorded for pane 0's session renders nothing there.
  window.__rendererState.ui.selectedMessageIdsBySession.set('session-a', new Set(['assistant_session-a']));
  composition.renderSessionPane('session-a', 'messages');
  await waitForUi(window, 60);
  const paneZeroTimeline = doc.getElementById('chatTimeline');
  assert.ok(paneZeroTimeline.querySelector('[data-message-id="assistant_session-a"]'), 'precondition: pane 0 renders its transcript');
  assert.equal(paneZeroTimeline.querySelector('[data-select-message-id], [data-selected]'), null, 'no checkbox or data-selected in pane 0');
  assert.ok(pane1.dom.chatTimeline.querySelector('[data-selected="true"]'), 'pane 1 still shows its selected chrome');
  assert.equal(doc.getElementById('chatSelectionOverlayHost').children.length, 0, 'pane 0 mounts no bar');
});

test('a send in pane 0 leaves pane 1 selecting', async (t) => {
  const started = [];
  const { window, doc, composition, pane1 } = await openTwoPanes(t, { chat: {
    async startStream(payload) { started.push(payload.sessionId); return { sessionId: payload.sessionId, streamId: 'stream-a' }; },
  } });
  await selectInPaneOne(window, composition, pane1);
  const paneHost = pane1.root.querySelector('[data-chat-node="chatSelectionOverlayHost"]');
  assert.ok(paneHost.children.length > 0, 'precondition: pane 1\'s bar is mounted');
  const input = doc.getElementById('chatInput');
  input.value = 'hello from pane zero';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 80);
  assert.ok(started.includes('session-a'), 'precondition: pane 0 sent into session-a');
  assert.equal(window.__rendererState.ui.selectionModePaneId, 1, 'pane 0\'s stream start does not exit pane 1\'s mode');
  assert.deepEqual([...(window.__rendererState.ui.selectedMessageIdsBySession.get('session-b') || [])], ['assistant_session-b']);
  assert.ok(paneHost.children.length > 0, 'pane 1\'s bar stays mounted');
});

test('closing pane 1 while it selects exits the mode and leaves no bar', async (t) => {
  const { window, doc, composition, pane1 } = await openTwoPanes(t);
  await selectInPaneOne(window, composition, pane1);
  doc.querySelector('.chat-pane[data-pane-id="1"] .chat-pane-close').click();
  await waitForUi(window, 80);
  assert.equal(composition.getPane(1), null, 'pane 1 is gone');
  assert.equal(window.__rendererState.ui.selectionModePaneId, null, 'the owner\'s dispose exited the mode');
  assert.equal(doc.getElementById('chatSelectionOverlayHost').children.length, 0, 'pane 0 mounts no bar');
  assert.equal(doc.querySelectorAll('[role="toolbar"].selection-action-bar, .selection-action-bar').length, 0, 'no bar anywhere');
  assert.equal(doc.getElementById('chatTimeline').querySelector('[data-select-message-id], [data-selected]'), null);
});

/* W3-1: the Shift+Click entry the help overlay promises, per pane. */
function shiftClickIn(window, node, { shiftKey = true } = {}) {
  const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey, button: 0 });
  node.dispatchEvent(down);
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey, button: 0 }));
  return down;
}
function messageBody(timeline, messageId) {
  const article = timeline.querySelector(`article[data-message-id="${messageId}"]`);
  assert.ok(article, `precondition: ${messageId} is rendered`);
  return article.querySelector('.chat-bubble, .chat-message-content') || article;
}

test('Shift+Click on a pane 1 message enters select mode in pane 1 only; a second one extends; Esc exits', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  const ui = window.__rendererState.ui;
  const down = shiftClickIn(window, messageBody(pane1.dom.chatTimeline, 'user_session-b'));
  await waitForUi(window, 60);
  assert.equal(down.defaultPrevented, true, 'no native text selection starts');
  assert.equal(ui.selectionModePaneId, 1, 'pane 1 owns the mode');
  assert.deepEqual([...ui.selectedMessageIdsBySession.get('session-b')], ['user_session-b']);
  assert.equal(window.__rendererState.currentSessionId, 'session-a', 'no focus change was needed');
  assert.ok(pane1.dom.chatTimeline.querySelector('[data-select-message-id]'), 'pane 1 grows its checkboxes');
  assert.equal(doc.getElementById('chatTimeline').querySelector('[data-select-message-id], [data-selected]'), null, 'pane 0 does not');
  assert.ok(pane1.root.querySelector('[data-chat-node="chatSelectionOverlayHost"] .selection-action-bar'), 'pane 1 mounts its bar');

  shiftClickIn(window, messageBody(pane1.dom.chatTimeline, 'assistant_session-b'));
  await waitForUi(window, 60);
  assert.deepEqual([...ui.selectedMessageIdsBySession.get('session-b')].sort(), ['assistant_session-b', 'user_session-b'], 'the range extends');

  doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await waitForUi(window, 40);
  assert.equal(ui.selectionModePaneId, null, 'Esc exits');
  assert.equal(pane1.dom.chatTimeline.querySelector('[data-select-message-id]'), null);
});

test('Shift+Click on a message action button or link does not enter select mode', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  window.jennyShell.clipboard.writeText = async () => ({ ok: true });
  const copy = pane1.dom.chatTimeline.querySelector('[data-message-action="copy"][data-message-id="assistant_session-b"]');
  assert.ok(copy, 'precondition: a message action button');
  const down = shiftClickIn(window, copy);
  const link = doc.createElement('a');
  link.href = '#nowhere';
  link.textContent = 'a link';
  messageBody(pane1.dom.chatTimeline, 'assistant_session-b').appendChild(link);
  const linkDown = shiftClickIn(window, link);
  await waitForUi(window, 40);
  assert.equal(down.defaultPrevented, false);
  assert.equal(linkDown.defaultPrevented, false);
  assert.equal(window.__rendererState.ui.selectionModePaneId, null);
  shiftClickIn(window, messageBody(pane1.dom.chatTimeline, 'user_session-b'), { shiftKey: false });
  assert.equal(window.__rendererState.ui.selectionModePaneId, null, 'a plain click does not enter');
});
