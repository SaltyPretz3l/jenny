const test = require('node:test');
const assert = require('node:assert/strict');

const { createRowModelStateUtils } = require('../renderer/chat/renderer-stream-handler-row-model');

function makeReducerState() {
  return {
    active_turn_id: '',
    turns_by_id: Object.create(null),
    reconciled_rows_by_turn_id: Object.create(null),
    pending_reconciliation_by_turn_id: Object.create(null),
  };
}

function createHarness(overrides = {}) {
  const state = { ui: {}, backend: { mode: 'managed-dev' }, ...(overrides.state || {}) };
  const normalizeId = overrides.normalizeId
    || ((value) => (value === null || value === undefined ? '' : String(value)));
  const createTurnReducerState = overrides.createTurnReducerState || makeReducerState;
  const utils = createRowModelStateUtils({
    state,
    normalizeId,
    getChatTimelineRowModelEnabled: overrides.getChatTimelineRowModelEnabled,
    createTurnReducerState,
  });
  return { state, utils };
}

test('throws if state, normalizeId, or createTurnReducerState are missing', () => {
  assert.throws(() => createRowModelStateUtils({}), /state/);
  assert.throws(
    () => createRowModelStateUtils({ state: {} }),
    /normalizeId/,
  );
  assert.throws(
    () => createRowModelStateUtils({ state: {}, normalizeId: () => '' }),
    /createTurnReducerState/,
  );
});

test('getLiveStateStore lazily instantiates a Map on state.ui', () => {
  const { state, utils } = createHarness();
  assert.equal(state.ui.chatTimelineLiveStateBySession, undefined);
  const store = utils.getLiveStateStore();
  assert.ok(store instanceof Map);
  assert.equal(state.ui.chatTimelineLiveStateBySession, store, 'cached on state.ui');
  assert.equal(utils.getLiveStateStore(), store, 'returns same instance');
});

test('getLiveStateStore repairs state.ui when it is missing or a non-object', () => {
  const state = {};
  const utils = createRowModelStateUtils({
    state,
    normalizeId: (v) => String(v || ''),
    createTurnReducerState: makeReducerState,
  });
  const store = utils.getLiveStateStore();
  assert.ok(state.ui && typeof state.ui === 'object');
  assert.ok(store instanceof Map);
});

test('buildRolloutRowKey composes a pipe-delimited key over row + payload fields', () => {
  const { utils } = createHarness();
  const key = utils.buildRolloutRowKey({
    kind: 'tool_step',
    row_id: 'r1',
    primary_message_id: 'm1',
    tool_call_id: 'c1',
    phase_id: 'p1',
    payload: { subkind: 'preparing' },
  });
  assert.equal(key, 'tool_step|r1|m1|c1|p1|preparing');
});

test('buildRolloutRowKey falls back to payload.tool_call_id/phase_id when top-level missing', () => {
  const { utils } = createHarness();
  const key = utils.buildRolloutRowKey({
    kind: 'tool_step',
    row_id: 'r1',
    primary_message_id: 'm1',
    payload: { tool_call_id: 'cfp', phase_id: 'pfp', subkind: 'done' },
  });
  assert.equal(key, 'tool_step|r1|m1|cfp|pfp|done');
});

test('buildRolloutRowKey tolerates missing/invalid input', () => {
  const { utils } = createHarness();
  assert.equal(utils.buildRolloutRowKey(null), '|||||');
  assert.equal(utils.buildRolloutRowKey({}), '|||||');
  assert.equal(utils.buildRolloutRowKey({ kind: 'x', payload: null }), 'x|||||');
});

test('isRowModelEnabled returns false for empty session ids', () => {
  const { utils } = createHarness();
  assert.equal(utils.isRowModelEnabled(''), false);
  assert.equal(utils.isRowModelEnabled(null), false);
  assert.equal(utils.isRowModelEnabled(undefined), false);
});

test('isRowModelEnabled delegates to getChatTimelineRowModelEnabled when provided', () => {
  const calls = [];
  const { utils } = createHarness({
    getChatTimelineRowModelEnabled(sessionId) {
      calls.push(sessionId);
      return sessionId === 'enabled-session';
    },
  });
  assert.equal(utils.isRowModelEnabled('enabled-session'), true);
  assert.equal(utils.isRowModelEnabled('other-session'), false);
  assert.deepEqual(calls, ['enabled-session', 'other-session']);
});

test('isRowModelEnabled defaults to managed-dev → true when no callback is wired', () => {
  const { utils, state } = createHarness({ state: { ui: {}, backend: { mode: 'managed-dev' } } });
  assert.equal(utils.isRowModelEnabled('session-1'), true);
  assert.equal(state.ui.chatTimelineRowModelBySession.get('session-1'), true);
});

test('isRowModelEnabled falls back to false for non-managed-dev backend mode', () => {
  // Override the userAgent flow to avoid the jsdom auto-enable branch
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  try {
    globalThis.navigator = { userAgent: 'plainstring' };
    delete globalThis.window;
    const { utils } = createHarness({ state: { ui: {}, backend: { mode: 'production' } } });
    assert.equal(utils.isRowModelEnabled('session-1'), false);
  } finally {
    if (originalNavigator === undefined) delete globalThis.navigator;
    else globalThis.navigator = originalNavigator;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('getSessionLiveTurnState returns null without create flag if no entry exists', () => {
  const { utils } = createHarness();
  assert.equal(utils.getSessionLiveTurnState('absent-session'), null);
  assert.equal(utils.getSessionLiveTurnState(''), null);
});

test('getSessionLiveTurnState({ create: true }) instantiates via createTurnReducerState exactly once per session', () => {
  let createCount = 0;
  const { utils } = createHarness({
    createTurnReducerState() {
      createCount += 1;
      return makeReducerState();
    },
  });
  const first = utils.getSessionLiveTurnState('s1', { create: true });
  const second = utils.getSessionLiveTurnState('s1', { create: true });
  assert.equal(createCount, 1);
  assert.equal(first, second, 'subsequent calls return cached state');
});

test('clearSessionLiveTurnState removes the entry and returns the Map.delete result', () => {
  const { utils } = createHarness();
  utils.getSessionLiveTurnState('s1', { create: true });
  assert.equal(utils.clearSessionLiveTurnState('s1'), true);
  assert.equal(utils.clearSessionLiveTurnState('s1'), false);
  assert.equal(utils.clearSessionLiveTurnState(''), false);
});

test('pruneEmptySessionLiveState clears a session whose reducer state has no live work', () => {
  const { utils, state } = createHarness();
  const live = utils.getSessionLiveTurnState('s1', { create: true });
  assert.ok(state.ui.chatTimelineLiveStateBySession.has('s1'));
  assert.equal(utils.pruneEmptySessionLiveState('s1', live), true);
  assert.equal(state.ui.chatTimelineLiveStateBySession.has('s1'), false);
});

test('pruneEmptySessionLiveState leaves a session with active turns alone', () => {
  const { utils, state } = createHarness();
  const live = utils.getSessionLiveTurnState('s1', { create: true });
  live.turns_by_id.turn_a = { rows: [{ row_id: 'r1' }] };
  assert.equal(utils.pruneEmptySessionLiveState('s1', live), false);
  assert.ok(state.ui.chatTimelineLiveStateBySession.has('s1'), 'session retained');
});

test('pruneEmptySessionLiveState resolves liveState from the store if caller passes nothing', () => {
  const { utils } = createHarness();
  utils.getSessionLiveTurnState('s1', { create: true });
  assert.equal(utils.pruneEmptySessionLiveState('s1'), true);
  assert.equal(utils.pruneEmptySessionLiveState('s1'), false, 'second call no-op');
});

test('pruneEmptySessionLiveState returns false for empty or unknown session id', () => {
  const { utils } = createHarness();
  assert.equal(utils.pruneEmptySessionLiveState(''), false);
  assert.equal(utils.pruneEmptySessionLiveState('never-created'), false);
});

test('factory only exposes the documented surface (no private helpers leak)', () => {
  const { utils } = createHarness();
  assert.deepEqual(Object.keys(utils).sort(), [
    'buildRolloutRowKey',
    'clearSessionLiveTurnState',
    'getLiveStateStore',
    'getSessionLiveTurnState',
    'isDeterministicRowIdEnabled',
    'isRowModelEnabled',
    'pruneEmptySessionLiveState',
  ]);
});
