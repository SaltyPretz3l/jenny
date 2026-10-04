const test = require('node:test');
const assert = require('node:assert/strict');

const turnPhase = require('../renderer/chat/renderer-turn-phase');

const {
  TURN_PHASES,
  TERMINAL_SUBSTATUS,
  PHASE_HINT_MAP,
  deriveTurnPhase,
  normalizeTerminalStatus,
  normalizeSendLifecycle,
} = turnPhase;

const LOCKED_PHASE_VALUES = [
  'sending',
  'thinking',
  'needs_approval',
  'running_tool',
  'review_artifact',
  'done',
];

const LOCKED_TERMINAL_VALUES = [
  'completed',
  'cancelled',
  'timed_out',
  'preempted',
  'interrupted',
];

test('TURN_PHASES exposes only the locked six phases with canonical string values', () => {
  assert.deepEqual(
    Object.values(TURN_PHASES).slice().sort(),
    LOCKED_PHASE_VALUES.slice().sort()
  );
  assert.ok(Object.isFrozen(TURN_PHASES));
});

test('TERMINAL_SUBSTATUS exposes only the locked five terminal substatuses', () => {
  assert.deepEqual(
    Object.values(TERMINAL_SUBSTATUS).slice().sort(),
    LOCKED_TERMINAL_VALUES.slice().sort()
  );
  assert.ok(Object.isFrozen(TERMINAL_SUBSTATUS));
});

test('deriveTurnPhase collapses every Phase 2 phaseHint into the locked grammar', () => {
  const expected = {
    idle: 'done',
    awaiting_assistant: 'sending',
    reasoning: 'thinking',
    streaming_assistant: 'thinking',
    final_answer: 'done',
    awaiting_approval: 'needs_approval',
    tool_running: 'running_tool',
    denied: 'done',
    cancelled: 'done',
    errored: 'done',
    tool_settled: 'done',
  };
  for (const [hint, phase] of Object.entries(expected)) {
    assert.equal(
      deriveTurnPhase({ phaseHint: hint }),
      phase,
      `phaseHint "${hint}" should derive to "${phase}"`
    );
    assert.equal(
      PHASE_HINT_MAP[hint],
      phase,
      `PHASE_HINT_MAP entry for "${hint}" should match deriveTurnPhase output`
    );
  }
});

test('deriveTurnPhase falls back to done for missing/invalid inputs', () => {
  assert.equal(deriveTurnPhase(null), 'done');
  assert.equal(deriveTurnPhase(undefined), 'done');
  assert.equal(deriveTurnPhase({}), 'done');
  assert.equal(deriveTurnPhase({ phaseHint: '' }), 'done');
  assert.equal(deriveTurnPhase({ phaseHint: null }), 'done');
  assert.equal(deriveTurnPhase({ phaseHint: 'totally_unknown_hint' }), 'done');
});

test('deriveTurnPhase is case-insensitive on the phaseHint value', () => {
  assert.equal(deriveTurnPhase({ phaseHint: 'TOOL_RUNNING' }), 'running_tool');
  assert.equal(deriveTurnPhase({ phaseHint: 'Awaiting_Approval' }), 'needs_approval');
});

test('deriveTurnPhase accepts a realistic Phase 2 view-model shape without re-walking events', () => {
  // The helper must not care about events; only phaseHint matters. Provide a
  // view-model with rich other fields to prove that.
  const vm = {
    turnId: 't1',
    rootMessageIds: { user: 'u1', assistant: 'a1' },
    user: { messageId: 'u1', content: 'hi', attachments: [], sourceMessageIds: ['u1'] },
    assistant: { messageId: 'a1', segments: [{ text: 'thinking out loud' }] },
    toolCalls: [{ toolCallId: 'c1', state: 'awaiting_approval', toolName: 'Read' }],
    reasoning: [],
    notices: [],
    attachments: [],
    interactive: null,
    suggestions: [],
    slashOutput: null,
    artifacts: [],
    phaseHint: 'awaiting_approval',
  };
  assert.equal(deriveTurnPhase(vm), 'needs_approval');
});

test('the removed comet presence mapping is no longer exported', () => {
  assert.equal(Object.hasOwn(turnPhase, 'phaseToPresenceState'), false);
  assert.equal(Object.hasOwn(turnPhase, 'phaseKindToPresenceState'), false);
  assert.equal(Object.hasOwn(turnPhase, 'phaseToComposerCopy'), false);
});

test('normalizeTerminalStatus maps raw backend timeout into canonical timed_out', () => {
  assert.equal(normalizeTerminalStatus('timeout'), 'timed_out');
  assert.equal(normalizeTerminalStatus('TIMEOUT'), 'timed_out');
  assert.equal(normalizeTerminalStatus('timed_out'), 'timed_out');
  assert.equal(normalizeTerminalStatus('cancelled'), 'cancelled');
  assert.equal(normalizeTerminalStatus('preempted'), 'preempted');
  assert.equal(normalizeTerminalStatus('completed'), 'completed');
  assert.equal(normalizeTerminalStatus('interrupted'), 'interrupted');
  assert.equal(normalizeTerminalStatus(''), '');
  assert.equal(normalizeTerminalStatus('banana'), '');
});

test('normalizeSendLifecycle accepts the three owned states and normalizes the rest', () => {
  assert.equal(normalizeSendLifecycle('preflight'), 'preflight');
  assert.equal(normalizeSendLifecycle('streaming'), 'streaming');
  assert.equal(normalizeSendLifecycle('settling'), 'settling');
  assert.equal(normalizeSendLifecycle('idle'), 'idle');
  assert.equal(normalizeSendLifecycle(''), 'idle');
  assert.equal(normalizeSendLifecycle('nonsense'), 'idle');
});

test('helpers never mutate inputs', () => {
  const vm = { phaseHint: 'tool_running' };
  const vmSnapshot = JSON.stringify(vm);
  deriveTurnPhase(vm);
  assert.equal(JSON.stringify(vm), vmSnapshot);
});
