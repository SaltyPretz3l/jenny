'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveSpriteActivity,
  createSpriteActivityTracker,
  gatherSpriteActivityInput,
  SPRITE_ACTIVITIES,
} = require('../renderer/chat/renderer-sprite-activity');
const realToolCallUtils = require('../renderer/chat/tool-call-utils');
const realApprovalBlock = require('../renderer/chat/renderer-approval-block');

function live(overrides) {
  return {
    turnLive: true,
    stoppedWithoutTerminal: false,
    outcome: '',
    admissionWait: null,
    approvalRefs: [],
    questionPending: false,
    typed: null,
    runningTools: [],
    deltaKind: '',
    ...overrides,
  };
}

function settled(overrides) {
  return live({ turnLive: false, ...overrides });
}

function tool(toolName, status, verb) {
  return { toolName, status, verb };
}

test('SPRITE_ACTIVITIES is the frozen vocabulary', () => {
  assert.ok(Object.isFrozen(SPRITE_ACTIVITIES));
  assert.deepEqual([...SPRITE_ACTIVITIES], [
    'think', 'write', 'compose', 'check', 'search', 'tool', 'compact',
    'wait', 'stuck', 'approve', 'done', 'rest', 'stopped', 'error',
  ]);
});

const SETTLED_ROWS = [
  ['admission wait gives wait', settled({ admissionWait: { reason: 'engine_busy' } }), 'wait'],
  ['cleanup_unconfirmed admission wait gives stuck',
    settled({ admissionWait: { reason: 'cleanup_unconfirmed' } }), 'stuck'],
  ['admission wait beats a stop without terminal',
    settled({ admissionWait: { reason: 'x' }, stoppedWithoutTerminal: true }), 'wait'],
  ['admission wait beats an error outcome',
    settled({ admissionWait: { reason: 'x' }, outcome: 'error' }), 'wait'],
  ['stop without a terminal gives stopped', settled({ stoppedWithoutTerminal: true }), 'stopped'],
  ['stop without a terminal beats a complete outcome',
    settled({ stoppedWithoutTerminal: true, outcome: 'complete' }), 'stopped'],
  ['error outcome gives error', settled({ outcome: 'error' }), 'error'],
  ['cancelled outcome gives stopped', settled({ outcome: 'cancelled' }), 'stopped'],
  ['complete outcome gives rest (done is the tracker upgrade)', settled({ outcome: 'complete' }), 'rest'],
  ['no outcome gives rest', settled({ outcome: '' }), 'rest'],
  ['unknown outcome gives rest', settled({ outcome: 'weird' }), 'rest'],
  ['settled ignores live-only inputs',
    settled({ typed: { kind: 'compaction' }, runningTools: [tool('a', 'running', 'bash')] }), 'rest'],
];

for (const [name, input, expected] of SETTLED_ROWS) {
  test(`settled: ${name}`, () => {
    const out = deriveSpriteActivity(input);
    assert.equal(out.activity, expected);
    assert.equal(out.live, false);
  });
}

const LIVE_ROWS = [
  // 2a approval / question
  ['live approval gives approve', live({ approvalRefs: [{ state: 'live' }] }), 'approve'],
  ['approval beats a running tool',
    live({ approvalRefs: [{ state: 'live' }], runningTools: [tool('a', 'running', 'bash')] }), 'approve'],
  ['approval beats compaction',
    live({ approvalRefs: [{ state: 'live' }], typed: { kind: 'compaction' } }), 'approve'],
  ['a question gives approve', live({ questionPending: true }), 'approve'],
  ['a question beats a waiting typed state',
    live({ questionPending: true, typed: { kind: 'waiting' } }), 'approve'],
  ['paused approval gives wait', live({ approvalRefs: [{ state: 'paused' }] }), 'wait'],
  ['live approval beats a paused one',
    live({ approvalRefs: [{ state: 'paused' }, { state: 'live' }] }), 'approve'],
  ['paused approval beats a running tool',
    live({ approvalRefs: [{ state: 'paused' }], runningTools: [tool('a', 'running', 'bash')] }), 'wait'],
  ['inactive approval is ignored (falls to think)', live({ approvalRefs: [{ state: 'inactive' }] }), 'think'],
  ['inactive approval is ignored (next rule decides)',
    live({ approvalRefs: [{ state: 'inactive' }], deltaKind: 'prose' }), 'write'],
  ['inactive approval does not hide a running tool',
    live({ approvalRefs: [{ state: 'inactive' }], runningTools: [tool('a', 'running', 'bash')] }), 'tool'],
  // 2b waiting
  ['waiting typed state gives wait', live({ typed: { kind: 'waiting', waitState: 'waiting' } }), 'wait'],
  ['waiting without a state gives wait', live({ typed: { kind: 'waiting' } }), 'wait'],
  ['stuck wait state gives stuck', live({ typed: { kind: 'waiting', waitState: 'stuck' } }), 'stuck'],
  ['waiting beats a running tool',
    live({ typed: { kind: 'waiting' }, runningTools: [tool('a', 'running', 'read')] }), 'wait'],
  // 2c compaction
  ['compaction gives compact', live({ typed: { kind: 'compaction' } }), 'compact'],
  ['compaction beats a running tool',
    live({ typed: { kind: 'compaction' }, runningTools: [tool('a', 'running', 'read')] }), 'compact'],
  // 2d running tools
  ['running read gives search', live({ runningTools: [tool('a', 'running', 'read')] }), 'search'],
  ['executing list gives search', live({ runningTools: [tool('a', 'executing', 'list')] }), 'search'],
  ['running search gives search', live({ runningTools: [tool('a', 'running', 'search')] }), 'search'],
  ['running web gives search', live({ runningTools: [tool('a', 'running', 'web')] }), 'search'],
  ['running fetch gives search', live({ runningTools: [tool('a', 'running', 'fetch')] }), 'search'],
  ['a verb outside the list gives tool', live({ runningTools: [tool('a', 'running', 'bash')] }), 'tool'],
  ['an empty verb gives tool', live({ runningTools: [tool('a', 'running', '')] }), 'tool'],
  ['the last running tool wins (tool then search)',
    live({ runningTools: [tool('a', 'running', 'bash'), tool('b', 'executing', 'read')] }), 'search'],
  ['the last running tool wins (search then tool)',
    live({ runningTools: [tool('a', 'running', 'read'), tool('b', 'running', 'bash')] }), 'tool'],
  ['non-running tools after a running one are skipped',
    live({ runningTools: [tool('a', 'running', 'read'), tool('b', 'queued', 'bash')] }), 'search'],
  ['running tool beats tool_input',
    live({ runningTools: [tool('a', 'running', 'bash')], typed: { kind: 'tool_input' } }), 'tool'],
  ['running tool beats prose',
    live({ runningTools: [tool('a', 'running', 'bash')], deltaKind: 'prose' }), 'tool'],
  ['requested tool falls through to compose',
    live({ runningTools: [tool('a', 'requested', 'read')], typed: { kind: 'tool_input' } }), 'compose'],
  ['requested tool falls through to think', live({ runningTools: [tool('a', 'requested', 'read')] }), 'think'],
  ['approved tool falls through to think', live({ runningTools: [tool('a', 'approved', 'bash')] }), 'think'],
  ['queued tool falls through to write',
    live({ runningTools: [tool('a', 'queued', 'bash')], deltaKind: 'prose' }), 'write'],
  ['pending tool falls through to think', live({ runningTools: [tool('a', 'pending', 'bash')] }), 'think'],
  // 2e tool_input
  ['tool_input gives compose', live({ typed: { kind: 'tool_input', toolName: 'write_file' } }), 'compose'],
  ['checklist tool_input gives check',
    live({ typed: { kind: 'tool_input', toolName: 'todo', checklist: true } }), 'check'],
  ['tool_input beats prose', live({ typed: { kind: 'tool_input' }, deltaKind: 'prose' }), 'compose'],
  // 2f delta kind
  ['prose delta gives write', live({ deltaKind: 'prose' }), 'write'],
  ['reasoning delta gives think', live({ deltaKind: 'reasoning' }), 'think'],
  // 2g default
  ['no signals gives think', live({}), 'think'],
  ['unknown delta kind gives think', live({ deltaKind: 'mystery' }), 'think'],
  ['unknown typed kind falls through', live({ typed: { kind: 'mystery' }, deltaKind: 'prose' }), 'write'],
  // a live turn never settles
  ['a live turn ignores the outcome', live({ outcome: 'complete' }), 'think'],
  ['a live turn ignores an error outcome', live({ outcome: 'error' }), 'think'],
  ['a live turn ignores stoppedWithoutTerminal', live({ stoppedWithoutTerminal: true }), 'think'],
  ['a live turn ignores admissionWait', live({ admissionWait: { reason: 'cleanup_unconfirmed' } }), 'think'],
];

for (const [name, input, expected] of LIVE_ROWS) {
  test(`live: ${name}`, () => {
    const out = deriveSpriteActivity(input);
    assert.equal(out.activity, expected);
    assert.equal(out.live, true);
  });
}

test('derive returns only vocabulary members', () => {
  for (const [, input] of [...SETTLED_ROWS, ...LIVE_ROWS]) {
    assert.ok(SPRITE_ACTIVITIES.includes(deriveSpriteActivity(input).activity));
  }
});

test('derive does not mutate its input', () => {
  const input = live({ runningTools: [tool('a', 'running', 'bash')], approvalRefs: [{ state: 'paused' }] });
  const snapshot = JSON.stringify(input);
  deriveSpriteActivity(input);
  assert.equal(JSON.stringify(input), snapshot);
});

const MALFORMED = [
  undefined,
  null,
  0,
  'x',
  [],
  {},
  { turnLive: true },
  { turnLive: false },
  { turnLive: true, approvalRefs: 'nope', runningTools: 7, typed: 'x', deltaKind: 4 },
  { turnLive: true, approvalRefs: [null, 3, 'x', {}], runningTools: [null, 1, 'x', {}] },
  { turnLive: true, typed: { kind: ['waiting'] }, deltaKind: {} },
  { turnLive: false, admissionWait: 'x', outcome: 9 },
  { turnLive: false, admissionWait: { reason: 5 } },
];

test('malformed input never throws and still returns a vocabulary member', () => {
  for (const input of MALFORMED) {
    const out = deriveSpriteActivity(input);
    assert.ok(SPRITE_ACTIVITIES.includes(out.activity), JSON.stringify(input));
    assert.equal(typeof out.live, 'boolean');
  }
});

test('malformed fields fall through to the documented defaults', () => {
  assert.equal(deriveSpriteActivity(undefined).activity, 'rest');
  assert.equal(deriveSpriteActivity({ turnLive: true }).activity, 'think');
  assert.equal(deriveSpriteActivity({ turnLive: true, runningTools: 'x' }).activity, 'think');
  assert.equal(deriveSpriteActivity({ turnLive: false, admissionWait: { reason: 5 } }).activity, 'wait');
});

// ---- tracker ----

const VISIBLE = (turnKey) => ({ turnKey, visible: true });
const HIDDEN = (turnKey) => ({ turnKey, visible: false });
const COMPLETE = () => settled({ outcome: 'complete' });

test('tracker: live (visible) then complete gives done, then rest', () => {
  const tracker = createSpriteActivityTracker();
  assert.equal(tracker.derive(live({ deltaKind: 'prose' }), VISIBLE('A')).activity, 'write');
  assert.deepEqual(tracker.peek(), { turnKey: 'A' });
  const first = tracker.derive(COMPLETE(), VISIBLE('A'));
  assert.deepEqual(first, { activity: 'done', live: false });
  assert.equal(tracker.peek(), null);
  assert.equal(tracker.derive(COMPLETE(), VISIBLE('A')).activity, 'rest');
  assert.equal(tracker.derive(COMPLETE(), VISIBLE('A')).activity, 'rest');
});

test('tracker: live while not visible then complete gives rest', () => {
  const tracker = createSpriteActivityTracker();
  assert.equal(tracker.derive(live({}), HIDDEN('A')).activity, 'think');
  assert.equal(tracker.peek(), null);
  assert.equal(tracker.derive(COMPLETE(), VISIBLE('A')).activity, 'rest');
});

test('tracker: a missing visible flag does not record', () => {
  const tracker = createSpriteActivityTracker();
  tracker.derive(live({}), { turnKey: 'A' });
  tracker.derive(live({}), undefined);
  assert.equal(tracker.peek(), null);
  assert.equal(tracker.derive(COMPLETE(), { turnKey: 'A' }).activity, 'rest');
});

test('tracker: invalidate between live and complete gives rest', () => {
  const tracker = createSpriteActivityTracker();
  tracker.derive(live({}), VISIBLE('A'));
  tracker.invalidate();
  assert.equal(tracker.peek(), null);
  assert.equal(tracker.derive(COMPLETE(), VISIBLE('A')).activity, 'rest');
});

test('tracker: a different turnKey at completion gives rest and keeps the record', () => {
  const tracker = createSpriteActivityTracker();
  tracker.derive(live({}), VISIBLE('A'));
  assert.equal(tracker.derive(COMPLETE(), VISIBLE('B')).activity, 'rest');
  assert.deepEqual(tracker.peek(), { turnKey: 'A' });
  assert.equal(tracker.derive(COMPLETE(), VISIBLE('A')).activity, 'done');
});

test('tracker: turn A live, turn B live, then A complete gives rest', () => {
  const tracker = createSpriteActivityTracker();
  tracker.derive(live({}), VISIBLE('A'));
  tracker.derive(live({}), VISIBLE('B'));
  assert.deepEqual(tracker.peek(), { turnKey: 'B' });
  assert.equal(tracker.derive(COMPLETE(), VISIBLE('A')).activity, 'rest');
  assert.equal(tracker.derive(COMPLETE(), VISIBLE('B')).activity, 'done');
});

test('tracker: holds at most one record', () => {
  const tracker = createSpriteActivityTracker();
  tracker.derive(live({}), VISIBLE('A'));
  tracker.derive(live({}), VISIBLE('B'));
  tracker.derive(live({}), VISIBLE('C'));
  assert.deepEqual(tracker.peek(), { turnKey: 'C' });
});

test('tracker: a hidden live derive does not clear an existing record', () => {
  const tracker = createSpriteActivityTracker();
  tracker.derive(live({}), VISIBLE('A'));
  tracker.derive(live({}), HIDDEN('A'));
  assert.deepEqual(tracker.peek(), { turnKey: 'A' });
});

test('tracker: a missing turn key never records and never yields done', () => {
  const tracker = createSpriteActivityTracker();
  tracker.derive(live({}), { visible: true });
  assert.equal(tracker.peek(), null);
  assert.equal(tracker.derive(COMPLETE(), { visible: true }).activity, 'rest');
});

test('tracker: a wait or a blank outcome keeps the record; a stop or error ends the turn', () => {
  const tracker = createSpriteActivityTracker();
  tracker.derive(live({}), VISIBLE('A'));
  assert.equal(tracker.derive(settled({ admissionWait: { reason: 'x' } }), VISIBLE('A')).activity, 'wait');
  assert.equal(tracker.derive(settled({ outcome: '' }), VISIBLE('A')).activity, 'rest');
  assert.deepEqual(tracker.peek(), { turnKey: 'A' });
  for (const input of [settled({ outcome: 'error' }), settled({ outcome: 'cancelled' }), settled({ stoppedWithoutTerminal: true })]) {
    tracker.derive(live({}), VISIBLE('A'));
    assert.notEqual(tracker.derive(input, VISIBLE('A')).activity, 'rest');
    assert.equal(tracker.peek(), null);
    assert.equal(tracker.derive(settled({ outcome: 'complete' }), VISIBLE('A')).activity, 'rest',
      'a late reconciled complete after a stop or error never plays done');
  }
});

test('tracker: results have the same shape as derive for live and settled input', () => {
  const tracker = createSpriteActivityTracker();
  assert.deepEqual(tracker.derive(live({ typed: { kind: 'compaction' } }), VISIBLE('A')),
    { activity: 'compact', live: true });
  assert.deepEqual(tracker.derive(settled({ outcome: 'error' }), VISIBLE('A')),
    { activity: 'error', live: false });
});

test('tracker: peek returns a frozen copy', () => {
  const tracker = createSpriteActivityTracker();
  tracker.derive(live({}), VISIBLE('A'));
  const snapshot = tracker.peek();
  assert.ok(Object.isFrozen(snapshot));
  assert.throws(() => {
    snapshot.turnKey = 'Z';
  }, TypeError);
  assert.deepEqual(tracker.peek(), { turnKey: 'A' });
  assert.notEqual(tracker.peek(), snapshot);
});

test('tracker: instances do not share state', () => {
  const one = createSpriteActivityTracker();
  const two = createSpriteActivityTracker();
  one.derive(live({}), VISIBLE('A'));
  assert.equal(two.peek(), null);
  assert.equal(two.derive(COMPLETE(), VISIBLE('A')).activity, 'rest');
  assert.equal(one.derive(COMPLETE(), VISIBLE('A')).activity, 'done');
});

test('tracker: malformed input and options never throw', () => {
  const tracker = createSpriteActivityTracker();
  const optionSets = [undefined, null, {}, 'x', { turnKey: null, visible: true }, { turnKey: 'A', visible: 'yes' }];
  for (const input of MALFORMED) {
    for (const options of optionSets) {
      const out = tracker.derive(input, options);
      assert.ok(SPRITE_ACTIVITIES.includes(out.activity));
    }
  }
  assert.doesNotThrow(() => tracker.invalidate());
  assert.doesNotThrow(() => tracker.invalidate());
  assert.equal(tracker.peek(), null);
});

const SESSION = 'session-1';
const USER = { id: 'u1', role: 'user', content: 'Hi', turn_id: 'turn-1' };

function gatherState(extra) {
  return {
    ui: { chatSendLifecycleBySession: new Map() },
    toolCallsByStream: new Map(),
    streamDeltaKindByStream: new Map(),
    pendingToolApprovals: new Map(),
    ...extra,
  };
}

function streamStub(overrides) {
  return {
    getStreamIdForSession: () => '',
    isStreamFinalized: () => false,
    isStreamTerminalSettled: () => false,
    ...overrides,
  };
}

function gather({ state = gatherState(), streams = streamStub(), anchor = {}, verbs = {} } = {}) {
  const toolCallUtils = { ...realToolCallUtils, toolRunVerb: (name) => verbs[name] || '' };
  return gatherSpriteActivityInput(
    { state, multiStreamController: streams, toolCallUtils, approvalBlock: realApprovalBlock },
    SESSION,
    { messages: [USER], streamId: 'stream-1', status: 'complete', outcome: 'complete', ...anchor },
  );
}

function toolUse(callId, status, extra) {
  return {
    id: `tool-${callId}`,
    role: 'assistant',
    kind: 'tool_use',
    turn_id: 'turn-1',
    tool_call: { call_id: callId, tool_name: 'bash', status, ...extra },
  };
}

test('gather: turnLive follows the pane send lifecycle', () => {
  for (const [phase, expected] of [['preflight', true], ['streaming', true], ['settling', false], ['failed', false], ['', false]]) {
    const state = gatherState();
    if (phase) state.ui.chatSendLifecycleBySession.set(SESSION, phase);
    assert.equal(gather({ state }).turnLive, expected, phase);
  }
  const other = gatherState();
  other.ui.chatSendLifecycleBySession.set('session-2', 'streaming');
  assert.equal(gather({ state: other }).turnLive, false, 'another pane lifecycle never counts');
});

test('gather: turnLive also holds for a registered stream that is not finalized', () => {
  const live = streamStub({ getStreamIdForSession: (id) => (id === SESSION ? 'stream-1' : '') });
  assert.equal(gather({ streams: live }).turnLive, true);
  const done = streamStub({ getStreamIdForSession: () => 'stream-1', isStreamFinalized: () => true });
  assert.equal(gather({ streams: done }).turnLive, false);
});

test('gather: stoppedWithoutTerminal needs a finalized, unsettled stream and a streaming bubble', () => {
  const finalized = (settled) => streamStub({
    isStreamFinalized: (id) => id === 'stream-1',
    isStreamTerminalSettled: () => settled,
  });
  const anchor = { status: 'streaming' };
  assert.equal(gather({ streams: finalized(false), anchor }).stoppedWithoutTerminal, true);
  assert.equal(gather({ streams: finalized(true), anchor }).stoppedWithoutTerminal, false);
  assert.equal(gather({ streams: finalized(false), anchor: { status: 'complete' } }).stoppedWithoutTerminal, false);
  assert.equal(gather({ streams: streamStub(), anchor }).stoppedWithoutTerminal, false, 'not finalized');
  assert.equal(gather({ streams: finalized(false), anchor: { status: 'streaming', streamId: '' } })
    .stoppedWithoutTerminal, false, 'no stream id');
});

test('gather: outcome is the anchor outcome', () => {
  assert.equal(gather({ anchor: { outcome: 'error' } }).outcome, 'error');
  assert.equal(gather({ anchor: { outcome: 'cancelled' } }).outcome, 'cancelled');
});

test('gather: approval refs come from the turn rows and carry the real ref shape', () => {
  const messages = [
    { id: 'u0', role: 'user', content: 'old' },
    toolUse('old-call', 'pending_approval'),
    USER,
    toolUse('c1', 'pending_approval'),
    toolUse('c2', 'running'),
    { id: 'plan1', role: 'assistant', kind: 'plan_document', turn_id: 'turn-1',
      plan_document: { state: 'pending', tool_call_id: 'c3' } },
    { id: 'plan2', role: 'assistant', kind: 'plan_document', turn_id: 'turn-1',
      plan_document: { state: 'approved', tool_call_id: 'c4' } },
  ];
  const seen = [];
  const approvalBlock = {
    resolveApprovalCardState: (_state, ref) => {
      seen.push(ref);
      return { state: ref.callId === 'c3' ? 'paused' : 'live' };
    },
  };
  const input = gatherSpriteActivityInput(
    { state: gatherState(), multiStreamController: streamStub(), toolCallUtils: realToolCallUtils, approvalBlock },
    SESSION,
    { messages, streamId: 'stream-1' },
  );
  assert.deepEqual(seen, [
    { callId: 'c1', sessionId: SESSION, turnId: 'turn-1', rowState: '' },
    { callId: 'c3', sessionId: SESSION, turnId: 'turn-1', rowState: '' },
  ]);
  assert.deepEqual(input.approvalRefs, [{ state: 'live' }, { state: 'paused' }]);
});

test('gather: classification uses the real resolver, so a held approval is paused', () => {
  const state = gatherState({
    runtimeSendController: { listPending: () => [{ turnId: 'turn-1', status: 'paused', key: 'k1' }] },
  });
  const input = gather({ state, anchor: { messages: [USER, toolUse('c1', 'pending_approval')] } });
  assert.deepEqual(input.approvalRefs, [{ state: 'paused' }]);
});

test('gather: pending approvals of this session are always live; other sessions are ignored', () => {
  const state = gatherState();
  state.pendingToolApprovals.set('ap1', { approvalId: 'ap1', callId: 'c1', sessionId: SESSION });
  state.pendingToolApprovals.set('ap2', { approvalId: 'ap2', callId: 'c2', sessionId: 'session-2' });
  assert.deepEqual(gather({ state }).approvalRefs, [{ state: 'live' }]);
  const none = gatherState();
  none.pendingToolApprovals.set('ap2', { approvalId: 'ap2', callId: 'c2', sessionId: 'session-2' });
  assert.deepEqual(gather({ state: none }).approvalRefs, []);
});

test('gather: a pending user question marks questionPending; withdrawn or older ones do not', () => {
  const asked = (extra) => gather({ anchor: { messages: [USER, toolUse('q1', 'pending_user_input', extra)] } });
  assert.equal(asked({}).questionPending, true);
  assert.equal(asked({ user_questions_withdrawn: true }).questionPending, false);
  assert.equal(gather({ anchor: { messages: [toolUse('q0', 'pending_user_input'), USER] } }).questionPending, false,
    'a question before the latest user message belongs to an earlier turn');
  assert.deepEqual(asked({}).approvalRefs, []);
});

test('gather: runningTools keep insertion order with normalized status and the verb', () => {
  const state = gatherState();
  state.toolCallsByStream.set('stream-1', [
    { callId: 'a', toolName: 'read_file', status: 'running' },
    { callId: 'b', toolName: 'bash', status: 'pending_approval' },
    { callId: 'c', toolName: 'mystery', status: 'executing' },
  ]);
  state.toolCallsByStream.set('stream-2', [{ callId: 'z', toolName: 'bash', status: 'running' }]);
  assert.deepEqual(gather({ state, verbs: { read_file: 'read', bash: 'run' } }).runningTools, [
    { status: 'running', verb: 'read' },
    { status: 'awaiting_approval', verb: 'run' },
    { status: 'executing', verb: '' },
  ]);
  assert.deepEqual(gather({ state, anchor: { streamId: 'none' } }).runningTools, []);
});

test('gather: typed activity and delta kind come from the active stream', () => {
  const state = gatherState({
    streamWaits: { getTypedActivity: (id) => (id === 'stream-1' ? { kind: 'compaction' } : null) },
  });
  state.streamDeltaKindByStream.set('stream-1', 'prose');
  const input = gather({ state });
  assert.deepEqual(input.typed, { kind: 'compaction' });
  assert.equal(input.deltaKind, 'prose');
  const bare = gather({ state: gatherState(), anchor: { streamId: 'stream-9' } });
  assert.equal(bare.typed, null);
  assert.equal(bare.deltaKind, '');
});

test('gather: an admission wait counts for the latest user turn only while no stream is live', () => {
  const wait = Object.freeze({ reason: 'engine_busy', blockingSessionId: 'session-2' });
  const rows = [
    { key: 'durable_a', turnId: 'turn-0', wait: { reason: 'other_turn' } },
    { key: 'durable_b', turnId: 'turn-1', userId: 'user_b', wait },
  ];
  const state = gatherState({ runtimeSendController: { listPending: (id) => (id === SESSION ? rows : []) } });
  assert.deepEqual(gather({ state }).admissionWait, wait, 'matched by the user message turn id');
  const optimistic = { id: 'user_b', role: 'user', content: 'Hi' };
  assert.deepEqual(gather({ state, anchor: { messages: [optimistic] } }).admissionWait, wait,
    'an optimistic user message matches the entry user id');
  assert.equal(gather({ state, anchor: { messages: [{ id: 'user_c', role: 'user' }] } }).admissionWait, null);
  const live = streamStub({ getStreamIdForSession: () => 'stream-1' });
  assert.equal(gather({ state, streams: live }).admissionWait, null, 'a live stream wins');
  const noWait = gatherState({
    runtimeSendController: { listPending: () => [{ key: 'durable_b', turnId: 'turn-1', wait: null }] },
  });
  assert.equal(gather({ state: noWait }).admissionWait, null);
  assert.equal(gather({ state: gatherState() }).admissionWait, null, 'no controller');
});

test('gather: malformed deps never throw and give neutral input', () => {
  const input = gatherSpriteActivityInput({}, '', null);
  assert.equal(input.turnLive, false);
  assert.deepEqual(input.approvalRefs, []);
  assert.deepEqual(input.runningTools, []);
  assert.equal(input.typed, null);
  assert.equal(input.admissionWait, null);
  assert.equal(input.deltaKind, '');
});

test('gather: a send queued behind the live stream is not the turn; the pane send controller wins', () => {
  const live = streamStub({ getStreamIdForSession: () => 'stream-1' });
  const queued = { id: 'user_q', role: 'user', content: 'Next' };
  const messages = [USER, toolUse('q1', 'pending_user_input'), queued];
  const paneRows = [{ key: 'durable_q', userId: 'user_q', admitted: false, wait: null }];
  const withRows = (rows) => ({ listPending: () => rows });
  const read = (deps) => gatherSpriteActivityInput(
    { state: gatherState(), multiStreamController: live, toolCallUtils: realToolCallUtils, approvalBlock: realApprovalBlock, ...deps },
    SESSION, { messages, streamId: 'stream-1' });
  assert.equal(read({ runtimeSendController: withRows(paneRows) }).questionPending, true, 'the live turn keeps its question');
  assert.equal(read({ runtimeSendController: withRows([]) }).questionPending, false, 'an admitted latest user row is the turn');
  const state = gatherState({ runtimeSendController: withRows([]) });
  assert.equal(read({ state, runtimeSendController: withRows(paneRows) }).questionPending, true, 'the pane controller, not the state slot');
});
