const { test } = require('node:test');
const assert = require('node:assert');

const projection = require('../renderer/shell/renderer-agent-snapshot-projection');
const {
  buildAgentSnapshotProjection,
  projectActiveTurn,
  projectLastError,
  projectSetup,
} = projection;

function liveStateMap(sessionId, turn) {
  return new Map([[sessionId, {
    active_turn_id: turn.turn_id,
    turns_by_id: { [turn.turn_id]: turn },
  }]]);
}

function baseState(overrides = {}) {
  return {
    features: { featureFlags: {} },
    ui: { chatTimelineLiveStateBySession: new Map() },
    messagesBySession: new Map(),
    setup: {},
    ...overrides,
  };
}

test('projectActiveTurn reports tool phase and non-terminal for a streaming turn', () => {
  const state = baseState({
    ui: {
      chatTimelineLiveStateBySession: liveStateMap('s1', {
        turn_id: 'turn_1',
        status: 'streaming',
        rows: [{
          kind: 'tool_step',
          tool_call_id: 'c1',
          payload: { tool_call_id: 'c1', tool_name: 'web_search', state: 'running', summary: 'searching' },
        }],
      }),
    },
  });
  const result = projectActiveTurn(state, 's1', true);
  assert.strictEqual(result.phase, 'tool_use');
  assert.strictEqual(result.terminal, '');
  assert.strictEqual(result.streaming, true);
});

test('projectActiveTurn reports terminal completed/error from reducer truth', () => {
  const completed = baseState({
    ui: {
      chatTimelineLiveStateBySession: liveStateMap('s1', {
        turn_id: 'turn_done',
        status: 'completed',
        rows: [{ kind: 'assistant_text', payload: { text: 'all done' } }],
      }),
    },
  });
  const doneResult = projectActiveTurn(completed, 's1', false);
  assert.strictEqual(doneResult.phase, 'completed');
  assert.strictEqual(doneResult.terminal, 'completed');
  assert.strictEqual(doneResult.streaming, false);

  const errored = baseState({
    ui: {
      chatTimelineLiveStateBySession: liveStateMap('s1', {
        turn_id: 'turn_bad',
        status: 'errored',
        rows: [],
        error: 'engine fell over',
      }),
    },
  });
  const errResult = projectActiveTurn(errored, 's1', false);
  assert.strictEqual(errResult.phase, 'error');
  assert.strictEqual(errResult.terminal, 'errored');
});

test('projectActiveTurn is idle without a live turn and derives with no feature flags set', () => {
  const noLive = projectActiveTurn(baseState(), 's1', false);
  assert.deepStrictEqual(noLive, { phase: 'idle', terminal: '', streaming: false });

  const noFlags = baseState({
    features: { featureFlags: {} },
    ui: {
      chatTimelineLiveStateBySession: liveStateMap('s1', {
        turn_id: 'turn_1', status: 'streaming', rows: [],
      }),
    },
  });
  const result = projectActiveTurn(noFlags, 's1', true);
  assert.strictEqual(result.phase, 'reasoning');
  assert.strictEqual(result.streaming, true, 'streaming flag is reported regardless of feature flags');
});

test('projectLastError returns structured class/code from the newest errored message', () => {
  const state = baseState({
    messagesBySession: new Map([['s1', [
      { id: 'u1', role: 'user' },
      {
        id: 'a1',
        role: 'assistant',
        status: 'error',
        error_code: 'CMP-AI-0002',
        stream_error: 'Engine unavailable',
        recovery_class: 'transport',
        recovery_title: 'Connection issue',
      },
    ]]]),
  });
  assert.deepStrictEqual(projectLastError(state, 's1'), {
    code: 'CMP-AI-0002',
    recovery_class: 'transport',
    title: 'Connection issue',
  });
});

test('projectLastError classifies the code when recovery_class is absent and falls back to stream_error for title', () => {
  const state = baseState({
    messagesBySession: new Map([['s1', [
      { id: 'a1', role: 'assistant', error_code: 'CMP-TOOL-0013', stream_error: 'web tool failed' },
    ]]]),
  });
  assert.deepStrictEqual(projectLastError(state, 's1'), {
    code: 'CMP-TOOL-0013',
    recovery_class: 'tool',
    title: 'web tool failed',
  });
});

test('projectLastError skips later success and surfaces the most recent error; null when clean', () => {
  const withError = baseState({
    messagesBySession: new Map([['s1', [
      { id: 'a1', role: 'assistant', error_code: 'CMP-CTX-0002', stream_error: 'too long' },
      { id: 'a2', role: 'assistant', status: 'completed', content: 'recovered' },
    ]]]),
  });
  assert.strictEqual(projectLastError(withError, 's1').code, 'CMP-CTX-0002');

  const clean = baseState({
    messagesBySession: new Map([['s1', [
      { id: 'a1', role: 'assistant', status: 'completed', content: 'fine' },
    ]]]),
  });
  assert.strictEqual(projectLastError(clean, 's1'), null);
});

test('projectSetup reflects the renderer setup slice', () => {
  assert.deepStrictEqual(
    projectSetup({ setup: { toolsWorkspaceRootConfigured: true, setupComplete: false } }),
    { workspaceRootConfigured: true, complete: false }
  );
  assert.deepStrictEqual(
    projectSetup({ setup: { toolsWorkspaceRootConfigured: true, setupComplete: true } }),
    { workspaceRootConfigured: true, complete: true }
  );
  assert.deepStrictEqual(projectSetup({}), { workspaceRootConfigured: false, complete: false });
});

test('buildAgentSnapshotProjection aggregates the three projected fields', () => {
  const state = baseState({
    ui: {
      chatTimelineLiveStateBySession: liveStateMap('s1', {
        turn_id: 'turn_1',
        status: 'completed',
        rows: [{ kind: 'assistant_text', payload: { text: 'hi' } }],
      }),
    },
    messagesBySession: new Map([['s1', [
      { id: 'a1', role: 'assistant', error_code: 'CMP-AI-0003', recovery_class: 'provider', recovery_title: 'Provider issue' },
    ]]]),
    setup: { toolsWorkspaceRootConfigured: true, setupComplete: true },
  });
  const snapshot = buildAgentSnapshotProjection({ state, sessionId: 's1', streaming: false });
  assert.strictEqual(snapshot.activeTurn.terminal, 'completed');
  assert.strictEqual(snapshot.lastError.recovery_class, 'provider');
  assert.deepStrictEqual(snapshot.setup, { workspaceRootConfigured: true, complete: true });
});

test('buildAgentSnapshotProjection tolerates an empty options object', () => {
  const snapshot = buildAgentSnapshotProjection();
  assert.deepStrictEqual(snapshot.activeTurn, { phase: 'idle', terminal: '', streaming: false });
  assert.strictEqual(snapshot.lastError, null);
  assert.deepStrictEqual(snapshot.setup, { workspaceRootConfigured: false, complete: false });
});
