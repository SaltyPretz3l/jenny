'use strict';

/**
 * tests/renderer-desktop-notifications.test.js
 *
 * The renderer half of desktop (OS) notifications, pure: which events become
 * a candidate, what the candidate says, the silent seeding that keeps
 * rehydrated waits from firing, the bounded ring and its drain cursor, the
 * toast-click round trip, and that a missing bridge never throws. Main owns
 * every gate (settings, focus, support); nothing here reads them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDesktopNotificationsController,
  normalizeNotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_CATEGORIES,
} = require('../renderer/shell/renderer-desktop-notifications');

function setup(options = {}) {
  const sent = [];
  const opened = [];
  const logs = [];
  const openListeners = [];
  let unsubscribed = 0;
  const bridge = options.bridge !== undefined ? options.bridge : {
    notify: (candidate) => {
      if (options.notifyThrows) throw new Error(options.notifyThrows);
      sent.push(candidate);
    },
    onOpen: (listener) => {
      openListeners.push(listener);
      return () => { unsubscribed += 1; };
    },
  };
  const state = {
    sessions: [{ id: 's1', title: 'Budget review' }, { id: 's2', title: '' }],
    messagesBySession: new Map([['s1', [
      { id: 'user_stream-1', role: 'user', content: 'hi' },
      { id: 'assistant_stream-1', role: 'assistant', content: '\n\n  Here is the summary.\nSecond line' },
      { id: 'tool_stream-1', role: 'assistant', kind: 'tool_use', content: '' },
    ]]]),
    pendingStreams: new Map(),
    ...(options.state || {}),
  };
  const controller = createDesktopNotificationsController({
    state,
    bridge,
    callbacks: {
      activateWorkspaceSession: (sessionId) => { opened.push(sessionId); },
      appendClientLog: (level, event, data) => logs.push({ level, event, data }),
    },
  });
  return {
    controller, state, sent, opened, logs,
    emitOpen: (payload) => openListeners.forEach((listener) => listener(payload)),
    unsubscribedCount: () => unsubscribed,
  };
}

const terminal = (kind, payload, extra = {}) => ({
  kind, payload: { sessionId: 's1', streamId: 'stream-1', ...payload }, result: { buffered: false, terminal: true }, ...extra,
});

test('a completed top-level turn becomes a replies candidate with the first reply line as preview', () => {
  const { controller, sent } = setup();
  const candidate = controller.onTerminal(terminal('complete', {}, { messageId: 'assistant_stream-1' }));
  assert.deepEqual(sent, [{
    category: 'replies', key: 'turn:stream-1', sessionId: 's1',
    title: 'Reply ready', body: 'Budget review', preview: 'Here is the summary.',
  }]);
  assert.deepEqual(candidate, sent[0]);
});

test('the preview comes from the stream message state.pendingStreams names, then the payload, clipped to 240', () => {
  const { controller, sent, state } = setup();
  state.pendingStreams.set('stream-1', 'assistant_stream-1');
  controller.onTerminal(terminal('complete', {}));
  assert.equal(sent[0].preview, 'Here is the summary.');

  const long = 'x'.repeat(300);
  controller.onTerminal(terminal('complete', { streamId: 'stream-9', content: long }));
  assert.equal(sent[1].preview, 'x'.repeat(240) + '…');

  controller.onTerminal(terminal('complete', { streamId: 'stream-10', content: '   \n  ' }));
  assert.equal('preview' in sent[2], false, 'an empty reply sends no preview');
});

test('an errored turn becomes a failures candidate with the message clipped to 120', () => {
  const { controller, sent } = setup();
  controller.onTerminal(terminal('error', { message: 'E'.repeat(200) }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].category, 'failures');
  assert.equal(sent[0].title, 'Run failed');
  assert.equal(sent[0].key, 'turn:stream-1');
  assert.equal(sent[0].body, 'Budget review · ' + 'E'.repeat(120) + '…');
  assert.equal('preview' in sent[0], false);

  // A chained provider error keeps its first clause; a short head keeps the whole text.
  controller.onTerminal(terminal('error', { streamId: 'stream-3',
    message: 'Model "gate-bogus-model:latest" is unavailable: Ollama engine failed to initialize: RuntimeError: pull failed' }));
  assert.equal(sent.at(-1).body, 'Budget review · Model "gate-bogus-model:latest" is unavailable');
  controller.onTerminal(terminal('error', { streamId: 'stream-4', message: 'Timeout: the engine did not answer in 30 s' }));
  assert.equal(sent.at(-1).body, 'Budget review · Timeout: the engine did not answer in 30 s');

  controller.onTerminal(terminal('error', { streamId: 'stream-2', sessionId: 's2', message: '' }));
  assert.equal(sent.at(-1).body, 'Untitled chat', 'an untitled chat says so; no message means the title alone');
});

test('user-intent terminals (Stop, Deny) never notify, in any spelling the timeline accepts', () => {
  const { controller, sent } = setup();
  for (const payload of [
    { terminal_status: 'cancelled' }, { terminalStatus: 'denied' }, { status: 'canceled' },
    { status: 'aborted' }, { terminal_status: 'CANCELLED' },
  ]) {
    assert.equal(controller.onTerminal(terminal('error', payload)), null);
    assert.equal(controller.onTerminal(terminal('complete', payload)), null);
  }
  assert.deepEqual(sent, []);
  controller.onTerminal(terminal('error', { status: 'error', message: 'boom' }));
  assert.equal(sent.length, 1, 'a plain "error" status still notifies');
});

test('a delegate / sub-agent child terminal never notifies', () => {
  const { controller, sent } = setup();
  assert.equal(controller.onTerminal(terminal('complete', { parent_work_id: 'work-1' })), null);
  assert.equal(controller.onTerminal(terminal('complete', { isDelegateChildProgress: true })), null);
  assert.equal(controller.onTerminal(terminal('complete', { child_run: { root_run_id: 'r' } })), null);
  assert.equal(controller.onTerminal(terminal('complete', {}, { messageId: 'tool_stream-1' })), null,
    'a tool row is not the top-level reply');
  assert.equal(controller.onTerminal(terminal('complete', {}, { messageId: 'user_stream-1' })), null,
    'a user row is not the top-level reply');
  assert.deepEqual(sent, []);
});

test('a terminal that did not settle (terminal:false, no result, unknown kind, no session) never notifies', () => {
  const { controller, sent } = setup();
  assert.equal(controller.onTerminal({ ...terminal('complete', {}), result: { terminal: false } }), null);
  assert.equal(controller.onTerminal({ ...terminal('complete', {}), result: undefined }), null);
  assert.equal(controller.onTerminal({ ...terminal('question_batch', {}) }), null);
  assert.equal(controller.onTerminal(terminal('complete', { sessionId: '' })), null);
  assert.equal(controller.onTerminal(null), null);
  assert.deepEqual(sent, []);
});

const approvalRow = (callId, sessionId = 's1') => ({
  key: `approval:${callId}`, kind: 'approval', sessionId, sessionTitle: 'Budget review', toolName: 'write_file',
});
const questionRow = (batchId, introText = 'Pick a format') => ({
  key: `question:s1:${batchId}`, kind: 'question', sessionId: 's1', sessionTitle: 'Budget review', introText,
});
const planRow = (callId) => ({
  key: `plan_review:${callId}`, kind: 'plan_review', sessionId: 's1', sessionTitle: 'Budget review', toolName: 'exit_plan_mode',
});

test('the first inbox pass seeds silently: waits pending at boot were not new', () => {
  const { controller, sent } = setup();
  assert.deepEqual(controller.onInboxRows([approvalRow('c1'), questionRow('b1')]), []);
  assert.deepEqual(sent, []);
  controller.onInboxRows([approvalRow('c1'), questionRow('b1')]);
  assert.deepEqual(sent, [], 'the seeded rows stay quiet on later passes');
});

test('while the app session list is not loaded every pass seeds, and so does the first loaded pass', () => {
  const { controller, sent, state } = setup({ state: { sessionListLoaded: false } });
  controller.onInboxRows([]);
  controller.onInboxRows([approvalRow('c1')]);
  state.sessionListLoaded = true;
  controller.onInboxRows([approvalRow('c1'), questionRow('b1')]);
  assert.deepEqual(sent, [], 'rehydrated rows never fire');
  controller.onInboxRows([approvalRow('c1'), questionRow('b1'), approvalRow('c2')]);
  assert.deepEqual(sent.map((c) => c.key), ['inbox:approval:c2']);
  state.sessionListLoaded = false; // signed out
  controller.onInboxRows([]);
  state.sessionListLoaded = true;
  controller.onInboxRows([approvalRow('c9')]);
  assert.equal(sent.length, 1, 'signing back in re-seeds');
});

test('new inbox rows become permissions / questions candidates with the agreed copy', () => {
  const { controller, sent } = setup();
  controller.onInboxRows([]);
  controller.onInboxRows([approvalRow('c1'), questionRow('b1'), planRow('p1'), questionRow('b2', '')]);
  assert.deepEqual(sent, [
    { category: 'permissions', key: 'inbox:approval:c1', sessionId: 's1', title: 'Needs your permission', body: 'write_file · Budget review' },
    { category: 'questions', key: 'inbox:question:s1:b1', sessionId: 's1', title: 'Jenny has a question', body: 'Budget review · Pick a format' },
    { category: 'questions', key: 'inbox:plan_review:p1', sessionId: 's1', title: 'Plan ready to review', body: 'Budget review' },
    { category: 'questions', key: 'inbox:question:s1:b2', sessionId: 's1', title: 'Jenny has a question', body: 'Budget review' },
  ]);
});

test('the same row on a later pass is never sent again; it re-fires only after leaving the live set', () => {
  const { controller, sent } = setup();
  controller.onInboxRows([]);
  controller.onInboxRows([approvalRow('c1')]);
  controller.onInboxRows([approvalRow('c1')]);
  controller.onInboxRows([approvalRow('c1'), questionRow('b1')]);
  assert.deepEqual(sent.map((c) => c.key), ['inbox:approval:c1', 'inbox:question:s1:b1']);
  controller.onInboxRows([questionRow('b1')]);
  controller.onInboxRows([approvalRow('c1'), questionRow('b1')]);
  assert.deepEqual(sent.map((c) => c.key), ['inbox:approval:c1', 'inbox:question:s1:b1', 'inbox:approval:c1']);
});

test('a delegate-marked question payload never notifies; a runtime child session is left to main', () => {
  const { controller, sent } = setup();
  const question = (extra = {}) => ({
    type: 'user_questions_requested', sessionId: 's1', callId: 'c-child', questionRef: 'q-child',
    questions: [{ prompt: 'Which branch?' }], ...extra,
  });
  assert.equal(controller.onStreamPayload(question({ parent_work_id: 'work-1' })), null);
  assert.equal(controller.onStreamPayload(question({ isDelegateChildProgress: true })), null);
  assert.equal(controller.onStreamPayload(question({ child_run: { root_run_id: 'r' } })), null);
  assert.deepEqual(sent, []);
  // An admission record alone says nothing about lineage: the renderer sends
  // the candidate and main's runtime-store gate decides.
  assert.ok(controller.onTerminal(terminal('complete', { runtimeAdmission: { work_id: 'w', turn_id: 't' } })));
  assert.equal(sent.length, 1);
});

test('an approval or plan review restored on chat open (rehydrated) is not a new wait', () => {
  const { controller, sent, state } = setup();
  state.pendingToolApprovals = new Map([
    ['c1', { callId: 'c1', approvalId: 'c1', sessionId: 's1', toolName: 'write_file', rehydrated: true }],
    ['p1', { callId: 'p1', approvalId: 'a-p1', sessionId: 's1', toolName: 'exit_plan_mode', rehydrated: true }],
    ['c2', { callId: 'c2', approvalId: 'c2', sessionId: 's1', toolName: 'write_file' }],
  ]);
  controller.onInboxRows([]);
  controller.onInboxRows([
    { ...approvalRow('c1'), callId: 'c1', approvalId: 'c1' },
    { ...planRow('p1'), callId: 'p1', approvalId: 'a-p1' },
    { ...approvalRow('c2'), callId: 'c2', approvalId: 'c2' },
  ]);
  assert.deepEqual(sent.map((c) => c.key), ['inbox:approval:c2']);
});

test('a live ask_user request becomes a questions candidate once; a withdrawn request frees its key for the re-ask', () => {
  const { controller, sent } = setup();
  const request = (extra = {}) => ({
    type: 'user_questions_requested', sessionId: 's1', streamId: 'stream-1', callId: 'c-q1', questionRef: 'q-1',
    questions: [{ header: 'Format', prompt: 'Pick a format' }], ...extra,
  });
  const candidate = controller.onStreamPayload(request());
  assert.deepEqual(candidate, {
    category: 'questions', key: 'question:c-q1', sessionId: 's1', title: 'Jenny has a question', body: 'Budget review · Pick a format',
  });
  assert.equal(controller.onStreamPayload(request()), null, 'the same request never re-notifies');
  assert.equal(controller.onStreamPayload(request({ type: 'user_questions_withdrawn' })), null);
  assert.ok(controller.onStreamPayload(request({ questions: [], summary: 'Second try' })), 're-ask after withdrawal notifies');
  assert.equal(sent[1].body, 'Budget review · Second try', 'the summary only stands in when no prompt exists');
  assert.equal(controller.onStreamPayload(request({ callId: 'c-q2', questionRef: 'q-2', summary: 'Ask user 1 question' })).body,
    'Budget review · Pick a format', 'the question beats the generic tool summary');
  // Without a call id the key is the tail of the ref, which is where refs differ.
  assert.equal(controller.onStreamPayload({ type: 'user_questions_requested', sessionId: 's1', questionRef: 'r'.repeat(150) + 'tail-1' }).key,
    'question:' + ('r'.repeat(150) + 'tail-1').slice(-100));
  // Other stream payloads, missing ids and non-objects are ignored.
  assert.equal(controller.onStreamPayload({ type: 'delta', sessionId: 's1' }), null);
  assert.equal(controller.onStreamPayload({ type: 'user_questions_requested', sessionId: 's1' }), null);
  assert.equal(controller.onStreamPayload({ type: 'user_questions_requested', callId: 'x' }), null);
  assert.equal(controller.onStreamPayload(null), null);
  assert.equal(controller.onStreamPayload('user_questions_requested'), null);
  // A question without a ref keys on the call id and falls back to the bare session title.
  assert.deepEqual(controller.onStreamPayload({ type: 'user_questions_requested', session_id: 's2', call_id: 'c-2', questions: ['?'] }), {
    category: 'questions', key: 'question:c-2', sessionId: 's2', title: 'Jenny has a question', body: 'Untitled chat · ?',
  });
  assert.equal(sent.length, 5);
});

test('the noop controller (no state) exposes every method and returns null', () => {
  const noop = createDesktopNotificationsController({});
  assert.equal(noop.onStreamPayload({ type: 'user_questions_requested', sessionId: 's1', callId: 'c' }), null);
  assert.equal(noop.onTerminal(terminal('complete', {})), null);
  assert.deepEqual(noop.onInboxRows([]), []);
  assert.deepEqual(noop.drain(), []);
  noop.dispose();
});

test('every candidate lands in a ring bounded at 32, stamped with its time', () => {
  const { controller, state } = setup();
  for (let index = 0; index < 40; index += 1) {
    controller.onTerminal(terminal('complete', { streamId: `stream-${index}`, content: 'ok' }));
  }
  assert.equal(state.desktopNotificationLog.length, 32);
  assert.equal(state.desktopNotificationLog[0].key, 'turn:stream-8');
  assert.equal(state.desktopNotificationLog[31].key, 'turn:stream-39');
  assert.equal(typeof state.desktopNotificationLog[0].at, 'number');
});

test('drain returns only entries appended since the last drain and survives the ring trim', () => {
  const { controller } = setup();
  assert.deepEqual(controller.drain(), []);
  controller.onTerminal(terminal('complete', { streamId: 'a', content: 'ok' }));
  const first = controller.drain();
  assert.deepEqual(first.map((entry) => entry.key), ['turn:a']);
  assert.deepEqual(controller.drain(), []);
  controller.onTerminal(terminal('error', { streamId: 'b', message: 'no' }));
  assert.deepEqual(controller.drain().map((entry) => entry.key), ['turn:b']);
  for (let index = 0; index < 40; index += 1) {
    controller.onTerminal(terminal('complete', { streamId: `t${index}`, content: 'ok' }));
  }
  const afterTrim = controller.drain();
  assert.equal(afterTrim.length, 32, 'a trimmed-away cursor restarts from the ring head');
  assert.equal(afterTrim[31].key, 'turn:t39');
});

test('a toast click opens its chat; dispose unsubscribes', () => {
  const { controller, opened, emitOpen, unsubscribedCount } = setup();
  emitOpen({ sessionId: 's1', category: 'replies', key: 'turn:stream-1' });
  emitOpen({ sessionId: '' });
  emitOpen(null);
  assert.deepEqual(opened, ['s1']);
  controller.dispose();
  assert.equal(unsubscribedCount(), 1);
  emitOpen({ sessionId: 's2' });
  assert.deepEqual(opened, ['s1'], 'nothing opens after dispose');
});

test('a missing or broken bridge never throws; a failing send is logged once per message', () => {
  const absent = setup({ bridge: null });
  assert.doesNotThrow(() => {
    absent.controller.onTerminal(terminal('complete', { content: 'ok' }));
    absent.controller.onInboxRows([]);
    absent.controller.onInboxRows([approvalRow('c1')]);
    absent.controller.drain();
    absent.controller.dispose();
  });
  assert.equal(absent.state.desktopNotificationLog.length, 2, 'the ring still records would-be toasts');

  const noState = createDesktopNotificationsController({});
  assert.doesNotThrow(() => {
    noState.onTerminal(terminal('complete', {}));
    noState.onInboxRows([approvalRow('c1')]);
    noState.drain();
    noState.dispose();
  });

  const failing = setup({ notifyThrows: 'bridge gone' });
  failing.controller.onTerminal(terminal('complete', { streamId: 'x1', content: 'ok' }));
  failing.controller.onTerminal(terminal('complete', { streamId: 'x2', content: 'ok' }));
  const warnings = failing.logs.filter((entry) => entry.event === 'desktop_notifications.send_failed');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'WARN');
  assert.equal(failing.state.desktopNotificationLog.length, 2);
});

test('normalizeNotificationSettings is total and fills every default', () => {
  assert.deepEqual(NOTIFICATION_CATEGORIES, ['replies', 'failures', 'permissions', 'questions', 'reminders']);
  const defaults = normalizeNotificationSettings(undefined);
  assert.deepEqual(defaults, {
    enabled: true, onlyWhenUnfocused: true, sound: true, replyPreview: false,
    categories: { replies: true, failures: true, permissions: true, questions: true, reminders: true },
  });
  assert.deepEqual(normalizeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS), defaults);
  const partial = normalizeNotificationSettings({ enabled: false, sound: 'yes', categories: { failures: false, bogus: true } });
  assert.equal(partial.enabled, false);
  assert.equal(partial.sound, true, 'a non-boolean falls back to the default');
  assert.equal(partial.categories.failures, false);
  assert.equal('bogus' in partial.categories, false);
  assert.deepEqual(normalizeNotificationSettings(normalizeNotificationSettings(partial)), partial, 'idempotent');
  assert.deepEqual(normalizeNotificationSettings([1, 2]), defaults);
});

test('the terminal-settle wrappers hand onTerminal the pre-finalize message id, after cleanup, with no result when the raw handler threw', async () => {
  const { createTerminalSettleHandlers } = require('../renderer/chat/renderer-stream-handler-terminal-settle');
  const order = [];
  const state = { pendingStreams: new Map([['stream-1', 'assistant_stream-1'], ['stream-2', 'assistant_stream-2']]) };
  const logs = [];
  const { handleComplete, handleError } = createTerminalSettleHandlers({
    state,
    appendClientLog: (level, event) => logs.push([level, event]),
    clearTerminalStreamState: (streamId) => order.push(`cleanup:${streamId}`),
    rawHandleComplete: async (payload) => {
      state.pendingStreams.delete(payload.streamId); // finalizeTerminalStream inside the raw handler
      order.push('raw');
      return { buffered: false, terminal: true };
    },
    rawHandleError: async () => { order.push('raw-error'); throw new Error('raw failed'); },
    onTerminal: (event) => {
      order.push(`notify:${event.kind}:${event.messageId}:${event.result && event.result.terminal}`);
      throw new Error('a notify failure never breaks the terminal');
    },
  });
  const result = await handleComplete({ sessionId: 's1', streamId: 'stream-1' });
  assert.deepEqual(result, { buffered: false, terminal: true });
  await assert.rejects(handleError({ sessionId: 's1', streamId: 'stream-2' }), /raw failed/);
  assert.deepEqual(order, [
    'raw', 'cleanup:stream-1', 'notify:complete:assistant_stream-1:true',
    'raw-error', 'cleanup:stream-2', 'notify:error:assistant_stream-2:undefined',
  ]);
  assert.deepEqual(logs.filter(([, event]) => event === 'stream.terminal_notify_failed').length, 2);
});
