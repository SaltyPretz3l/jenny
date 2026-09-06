const { test } = require('node:test');
const assert = require('node:assert');

const { installAgentTestHooks } = require('../renderer/shell/renderer-agent-hooks');

function createFakeWindow() {
  const elements = new Map();
  return {
    elements,
    Event: class FakeEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.bubbles = options.bubbles === true;
      }
    },
    document: {
      getElementById: (id) => elements.get(id) || null,
    },
  };
}

function createBaseState(flags) {
  return {
    currentSessionId: 'session-1',
    ui: { activeView: 'chat' },
    backend: { phase: 'ready' },
    auth: { authenticated: true },
    messagesBySession: new Map([['session-1', [{ id: 'm1' }, { id: 'm2' }]]]),
    pendingStreams: new Map(),
    bufferedStreamEventsByStream: new Map(),
    logs: [],
    features: { featureFlags: flags },
  };
}

async function waitForTicks(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('installs window.__jennyAgent only when agent_test_hooks is on', async () => {
  const win = createFakeWindow();
  const state = createBaseState({ agent_test_hooks: true });
  const dispose = installAgentTestHooks({ window: win, state });
  await waitForTicks(400);
  assert.ok(win.__jennyAgent, 'surface installed under the flag');

  const offWin = createFakeWindow();
  const offState = createBaseState({ agent_test_hooks: false });
  const disposeOff = installAgentTestHooks({ window: offWin, state: offState });
  await waitForTicks(400);
  assert.strictEqual(offWin.__jennyAgent, undefined);

  dispose();
  disposeOff();
  assert.strictEqual(win.__jennyAgent, undefined, 'dispose removes the surface');
});

test('getStateSnapshot reports state-derived counts without DOM access', async () => {
  const win = createFakeWindow();
  const state = createBaseState({ agent_test_hooks: true });
  state.pendingStreams.set('stream-9', {});
  state.logs.push({ event: 'one' });
  const dispose = installAgentTestHooks({ window: win, state });
  await waitForTicks(400);
  const snapshot = win.__jennyAgent.getStateSnapshot();
  assert.strictEqual(snapshot.currentSessionId, 'session-1');
  assert.strictEqual(snapshot.messageCount, 2);
  assert.deepStrictEqual(snapshot.pendingStreamIds, ['stream-9']);
  assert.strictEqual(snapshot.backendPhase, 'ready');
  assert.strictEqual(snapshot.rowCount, 0, 'missing timeline element degrades to zero counts');
  dispose();
});

test('started streams remain visible to drivers before the first renderable chunk', async () => {
  const win = createFakeWindow();
  const state = createBaseState({ agent_test_hooks: true });
  let activeStreamId = 'stream-started';
  win.rendererMultiStreamController = {
    getStreamingSessionIds: () => activeStreamId ? ['session-1'] : [],
    getStreamIdForSession: () => activeStreamId,
  };
  const dispose = installAgentTestHooks({ window: win, state });
  await waitForTicks(400);

  assert.deepStrictEqual(
    win.__jennyAgent.getStateSnapshot().pendingStreamIds,
    ['stream-started'],
    'the canonical stream registry covers the started-to-first-chunk window'
  );
  assert.strictEqual(
    await win.__jennyAgent.waitForIdle({ timeoutMs: 150, pollMs: 20 }),
    false,
    'a started stream is not idle merely because no assistant message exists yet'
  );

  activeStreamId = '';
  assert.strictEqual(await win.__jennyAgent.waitForIdle({ timeoutMs: 500, pollMs: 20 }), true);
  dispose();
});

test('getStateSnapshot exposes activeTurn, lastError, and setup defaults for a clean state', async () => {
  const win = createFakeWindow();
  const state = createBaseState({ agent_test_hooks: true });
  const dispose = installAgentTestHooks({ window: win, state });
  await waitForTicks(400);
  const snapshot = win.__jennyAgent.getStateSnapshot();
  assert.deepStrictEqual(snapshot.activeTurn, { phase: 'idle', terminal: '', streaming: false });
  assert.strictEqual(snapshot.lastError, null);
  assert.deepStrictEqual(snapshot.setup, { workspaceRootConfigured: false, complete: false });
  dispose();
});

test('getStateSnapshot projects terminal turn, structured error, and setup readiness', async () => {
  const win = createFakeWindow();
  const state = createBaseState({ agent_test_hooks: true });
  state.pendingStreams.set('stream-1', {});
  state.ui.chatTimelineLiveStateBySession = new Map([['session-1', {
    active_turn_id: 'turn_1',
    turns_by_id: {
      turn_1: {
        turn_id: 'turn_1',
        status: 'completed',
        rows: [{ kind: 'assistant_text', payload: { text: 'done' } }],
      },
    },
  }]]);
  state.messagesBySession = new Map([['session-1', [
    {
      id: 'a1',
      role: 'assistant',
      status: 'error',
      error_code: 'CMP-AI-0002',
      stream_error: 'Engine unavailable',
      recovery_class: 'transport',
      recovery_title: 'Connection issue',
    },
  ]]]);
  state.setup = { toolsWorkspaceRootConfigured: true, setupComplete: true };
  const dispose = installAgentTestHooks({ window: win, state });
  await waitForTicks(400);
  const snapshot = win.__jennyAgent.getStateSnapshot();
  assert.strictEqual(snapshot.activeTurn.phase, 'completed');
  assert.strictEqual(snapshot.activeTurn.terminal, 'completed');
  assert.strictEqual(snapshot.activeTurn.streaming, true, 'streaming derives from in-flight streams');
  assert.deepStrictEqual(snapshot.lastError, {
    code: 'CMP-AI-0002',
    recovery_class: 'transport',
    title: 'Connection issue',
  });
  assert.deepStrictEqual(snapshot.setup, { workspaceRootConfigured: true, complete: true });
  dispose();
});

test('sendPrompt drives the composer input and send button', async () => {
  const win = createFakeWindow();
  const events = [];
  let clicked = false;
  win.elements.set('chatInput', {
    value: '',
    dispatchEvent: (event) => events.push(event.type),
  });
  win.elements.set('sendButton', { click: () => { clicked = true; } });
  const state = createBaseState({ agent_test_hooks: true });
  const dispose = installAgentTestHooks({ window: win, state });
  await waitForTicks(400);
  assert.strictEqual(win.__jennyAgent.sendPrompt('hello there'), true);
  assert.strictEqual(win.elements.get('chatInput').value, 'hello there');
  assert.deepStrictEqual(events, ['input']);
  assert.strictEqual(clicked, true);
  dispose();
});

test('openSession delegates through the late-bound agent action and reports the active session', async () => {
  const win = createFakeWindow();
  const state = createBaseState({ agent_test_hooks: true });
  state.harness = { agentActions: null };
  const dispose = installAgentTestHooks({ window: win, state });
  await waitForTicks(400);

  assert.deepStrictEqual(await win.__jennyAgent.openSession(''), { ok: false, sessionId: '' });
  assert.deepStrictEqual(
    await win.__jennyAgent.openSession('session-2'),
    { ok: false, sessionId: 'session-2' }
  );

  const calls = [];
  state.harness.agentActions = {
    async loadSessions(sessionId, options) { calls.push(['load', sessionId, options]); },
    setActiveView(view) { calls.push(['view', view]); },
    async openSession(sessionId) {
      calls.push(['open', sessionId]);
      state.currentSessionId = sessionId;
      return true;
    },
  };
  assert.deepStrictEqual(
    await win.__jennyAgent.openSession('session-2'),
    { ok: true, sessionId: 'session-2' }
  );
  assert.deepStrictEqual(calls, [
    ['load', 'session-2', { preserveCurrentSession: true, skipOpenCurrent: true }],
    ['view', 'chat'],
    ['open', 'session-2'],
  ]);
  dispose();
});

test('drainClientLogs returns only entries appended since the last drain', async () => {
  const win = createFakeWindow();
  const state = createBaseState({ agent_test_hooks: true });
  const dispose = installAgentTestHooks({ window: win, state });
  await waitForTicks(400);
  const first = { event: 'first' };
  const second = { event: 'second' };
  state.logs.push(first);
  assert.deepStrictEqual(win.__jennyAgent.drainClientLogs(), [first]);
  state.logs.push(second);
  assert.deepStrictEqual(win.__jennyAgent.drainClientLogs(), [second]);
  assert.deepStrictEqual(win.__jennyAgent.drainClientLogs(), []);
  dispose();
});

test('waitForIdle resolves true when streams drain and false on timeout', async () => {
  const win = createFakeWindow();
  const state = createBaseState({ agent_test_hooks: true });
  const dispose = installAgentTestHooks({ window: win, state });
  await waitForTicks(400);

  state.pendingStreams.set('stream-1', {});
  const idlePromise = win.__jennyAgent.waitForIdle({ timeoutMs: 5000, pollMs: 20 });
  setTimeout(() => state.pendingStreams.delete('stream-1'), 80);
  assert.strictEqual(await idlePromise, true);

  state.pendingStreams.set('stream-2', {});
  assert.strictEqual(await win.__jennyAgent.waitForIdle({ timeoutMs: 150, pollMs: 20 }), false);
  dispose();
});
