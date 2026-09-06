const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TURN_PHASES,
  TERMINAL_SUBSTATUS,
  PHASE_HINT_MAP,
  deriveTurnPhase,
  phaseKindToPresenceState,
  phaseToComposerCopy,
  phaseToPresenceState,
  normalizeTerminalStatus,
  normalizeSendLifecycle,
} = require('../renderer/chat/renderer-turn-phase');

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

const COMET_STATE_ALLOWLIST = new Set([
  'idle',
  'listening',
  'thinking',
  'responding',
  'tool-use',
  'alert',
  'happy',
  'concerned',
]);

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

test('phaseToComposerCopy: sending echoes the Phase 3 umbrella over preflight/streaming/settling', () => {
  const preflight = phaseToComposerCopy('sending', { sendLifecycle: 'preflight' });
  assert.equal(preflight.phase, 'sending');
  assert.equal(preflight.tone, 'pending');
  assert.equal(preflight.spinner, true);
  assert.ok(preflight.message.length > 0);

  const streaming = phaseToComposerCopy('sending', { sendLifecycle: 'streaming' });
  assert.equal(streaming.tone, 'pending');
  assert.equal(streaming.spinner, true);

  const settling = phaseToComposerCopy('sending', { sendLifecycle: 'settling' });
  assert.equal(settling.tone, 'pending');
  assert.equal(settling.spinner, true);
});

test('phaseToComposerCopy: thinking differentiates reasoning vs assistant-streaming copy', () => {
  const thinking = phaseToComposerCopy('thinking', {});
  assert.equal(thinking.phase, 'thinking');
  assert.equal(thinking.spinner, true);
  assert.ok(/Thinking/i.test(thinking.message));

  const responding = phaseToComposerCopy('thinking', { assistantStreaming: true });
  assert.equal(responding.phase, 'thinking');
  assert.equal(responding.spinner, true);
  assert.ok(/Respond/i.test(responding.message));
});

test('phaseToComposerCopy: needs_approval uses approval label when provided', () => {
  const withTool = phaseToComposerCopy('needs_approval', { approvalToolName: 'Bash' });
  assert.equal(withTool.phase, 'needs_approval');
  assert.ok(withTool.message.includes('Bash'));
  assert.equal(withTool.spinner, false);

  const fallback = phaseToComposerCopy('needs_approval', {});
  assert.equal(fallback.phase, 'needs_approval');
  assert.ok(fallback.message.length > 0);

  const withDisplay = phaseToComposerCopy('needs_approval', {
    approvalToolName: 'Bash',
    approvalToolDisplayName: 'Terminal',
  });
  assert.ok(withDisplay.message.includes('Terminal'));
});

test('phaseToComposerCopy: running_tool interpolates the tool label with a fallback', () => {
  const withTool = phaseToComposerCopy('running_tool', { toolName: 'Read' });
  assert.ok(withTool.message.includes('Read'));
  assert.equal(withTool.spinner, true);
  assert.equal(withTool.tone, 'pending');

  const withoutTool = phaseToComposerCopy('running_tool', {});
  assert.ok(withoutTool.message.length > 0);
  assert.equal(withoutTool.spinner, true);
});

test('phaseToComposerCopy: review_artifact only surfaces copy when artifactReviewActive', () => {
  const active = phaseToComposerCopy('review_artifact', { artifactReviewActive: true });
  assert.ok(active.message.length > 0);

  const inactive = phaseToComposerCopy('review_artifact', {});
  assert.equal(inactive.message, '');
  assert.equal(inactive.spinner, false);
});

test('phaseToComposerCopy: done branches on terminal substatus', () => {
  const cancelled = phaseToComposerCopy('done', { terminalStatus: 'cancelled' });
  assert.equal(cancelled.message, 'Cancelled');
  assert.equal(cancelled.spinner, false);

  const preempted = phaseToComposerCopy('done', { terminalStatus: 'preempted' });
  assert.equal(preempted.message, 'Cancelled');

  const timedOut = phaseToComposerCopy('done', { terminalStatus: 'timed_out' });
  assert.equal(timedOut.message, 'Timed out');
  assert.equal(timedOut.tone, 'danger');

  // Backend-native 'timeout' must normalize to 'timed_out'.
  const timeoutRaw = phaseToComposerCopy('done', { terminalStatus: 'timeout' });
  assert.equal(timeoutRaw.message, 'Timed out');

  const interrupted = phaseToComposerCopy('done', { terminalStatus: 'interrupted' });
  assert.equal(interrupted.message, 'Interrupted');

  const completed = phaseToComposerCopy('done', { terminalStatus: 'completed' });
  assert.equal(completed.message, '');
  assert.equal(completed.spinner, false);

  const idle = phaseToComposerCopy('done', {});
  assert.equal(idle.message, '');
});

test('phaseToComposerCopy: unknown or missing phase inputs fall through to done', () => {
  const missing = phaseToComposerCopy(undefined, {});
  assert.equal(missing.phase, 'done');
  assert.equal(missing.message, '');

  const bogus = phaseToComposerCopy('NOT_A_PHASE', {});
  assert.equal(bogus.phase, 'done');
});

test('phaseToComposerCopy: outputs are deterministic for the same inputs', () => {
  const ctx = { sendLifecycle: 'preflight', toolName: 'Read' };
  const first = phaseToComposerCopy('sending', ctx);
  const second = phaseToComposerCopy('sending', ctx);
  assert.deepEqual(first, second);

  const doneCtx = { terminalStatus: 'timed_out' };
  assert.deepEqual(
    phaseToComposerCopy('done', doneCtx),
    phaseToComposerCopy('done', doneCtx)
  );
});

test('phaseToPresenceState: every phase maps into the existing comet vocabulary', () => {
  for (const phase of LOCKED_PHASE_VALUES) {
    const presence = phaseToPresenceState(phase, {});
    assert.ok(
      COMET_STATE_ALLOWLIST.has(presence),
      `phase ${phase} mapped to "${presence}" which is not in the comet vocabulary`
    );
  }
});

test('phaseToPresenceState: thinking branches on assistantStreaming context', () => {
  assert.equal(phaseToPresenceState('thinking', {}), 'thinking');
  assert.equal(phaseToPresenceState('thinking', { assistantStreaming: true }), 'responding');
  assert.equal(phaseToPresenceState('thinking', { assistantStreaming: false }), 'thinking');
});

test('phaseKindToPresenceState: maps protocol phase kinds through canonical comet presence', () => {
  assert.equal(phaseKindToPresenceState('reasoning'), 'thinking');
  assert.equal(phaseKindToPresenceState('text'), 'responding');
  assert.equal(phaseKindToPresenceState('tool_use'), 'tool-use');
  assert.equal(phaseKindToPresenceState('tool_result'), 'tool-use');
  assert.equal(phaseKindToPresenceState('approval_wait'), 'alert');
  assert.equal(phaseKindToPresenceState('unknown'), '');
});

test('phaseToPresenceState: core phase → comet presence mapping', () => {
  assert.equal(phaseToPresenceState('sending', {}), 'listening');
  assert.equal(phaseToPresenceState('needs_approval', {}), 'alert');
  assert.equal(phaseToPresenceState('running_tool', {}), 'tool-use');
  assert.equal(phaseToPresenceState('review_artifact', {}), 'alert');
});

test('phaseToPresenceState: done branches on terminal substatus matching renderer/app.js precedent', () => {
  assert.equal(phaseToPresenceState('done', { terminalStatus: 'cancelled' }), 'idle');
  assert.equal(phaseToPresenceState('done', { terminalStatus: 'preempted' }), 'idle');
  assert.equal(phaseToPresenceState('done', { terminalStatus: 'timed_out' }), 'concerned');
  assert.equal(phaseToPresenceState('done', { terminalStatus: 'interrupted' }), 'concerned');
  assert.equal(phaseToPresenceState('done', { terminalStatus: 'completed' }), 'happy');
  assert.equal(phaseToPresenceState('done', {}), 'idle');
});

test('phaseToPresenceState: unknown phase falls through to done semantics', () => {
  assert.equal(phaseToPresenceState('NOT_A_PHASE', {}), 'idle');
  assert.equal(phaseToPresenceState(undefined, { terminalStatus: 'completed' }), 'happy');
});

test('phaseToPresenceState: determinism check', () => {
  const ctx = { terminalStatus: 'completed', assistantStreaming: true };
  assert.equal(phaseToPresenceState('thinking', ctx), phaseToPresenceState('thinking', ctx));
  assert.equal(phaseToPresenceState('done', ctx), phaseToPresenceState('done', ctx));
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

  const ctx = { sendLifecycle: 'preflight', toolName: 'Read' };
  const ctxSnapshot = JSON.stringify(ctx);
  phaseToComposerCopy('running_tool', ctx);
  phaseToPresenceState('running_tool', ctx);
  assert.equal(JSON.stringify(ctx), ctxSnapshot);
});
