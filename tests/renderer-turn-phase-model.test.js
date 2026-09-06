const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTerminal,
  collectModelParts,
  deriveReconciledTurnStatus,
  resolvePhaseKey,
  selectActiveTurnFromLiveState,
} = require('../renderer/chat/renderer-turn-phase-model');

function deriveActiveTurn(activeTurn, featureFlags = {}) {
  if (!activeTurn) {
    return { phase: 'idle', terminal: '' };
  }
  const parts = collectModelParts(activeTurn, featureFlags);
  const terminal = buildTerminal(activeTurn, parts.rows);
  return {
    phase: resolvePhaseKey(parts, terminal),
    terminal: terminal.kind,
  };
}

test('no active turn produces the idle phase contract', () => {
  assert.deepEqual(deriveActiveTurn(null), { phase: 'idle', terminal: '' });
  assert.equal(selectActiveTurnFromLiveState(null), null);
});

test('derives reasoning and assistant text phases from realistic rows', () => {
  const reasoning = deriveActiveTurn({
    turn_id: 'turn_reasoning',
    status: 'streaming',
    rows: [{
      kind: 'reasoning',
      payload: {
        phase_id: 'phase_reasoning',
        phase_kind: 'reasoning',
        summary: 'Inspecting the workspace map',
      },
    }],
  });
  assert.equal(reasoning.phase, 'reasoning');

  const text = deriveActiveTurn({
    turn_id: 'turn_text',
    status: 'streaming',
    rows: [{ kind: 'assistant_text', payload: { text: 'Here is the answer.' } }],
  });
  assert.equal(text.phase, 'text');
});

test('running tools and pending approvals take their lifecycle phases', () => {
  const tool = deriveActiveTurn({
    turn_id: 'turn_tool',
    status: 'streaming',
    rows: [{
      kind: 'tool_step',
      payload: {
        tool_call_id: 'call_read',
        tool_name: 'read_file',
        state: 'running',
        summary: 'Reading INVENTORY.md',
      },
    }],
  });
  assert.equal(tool.phase, 'tool_use');

  const approval = deriveActiveTurn({
    turn_id: 'turn_approval',
    status: 'streaming',
    rows: [{
      kind: 'approval_gap',
      payload: {
        tool_call_id: 'call_write',
        tool_name: 'write_file',
        state: 'awaiting_approval',
        prompt: 'Allow writing the file?',
      },
    }],
  });
  assert.equal(approval.phase, 'approval_wait');
});

test('buildTerminal produces every canonical terminal kind', () => {
  const cases = [
    ['complete', 'completed'],
    ['error', 'errored'],
    ['cancelled', 'cancelled'],
    ['denied', 'denied'],
    ['timeout', 'timed_out'],
    ['interrupted', 'interrupted'],
    ['preempted', 'preempted'],
    ['unknown', 'unknown'],
  ];
  for (const [status, expectedKind] of cases) {
    const terminal = buildTerminal({ status, message: `${status} summary` }, []);
    assert.equal(terminal.kind, expectedKind, status);
  }
  assert.deepEqual(buildTerminal({ status: 'streaming' }, []), { kind: '', summary: '' });
});

test('stream_envelope_v2 controls whether reasoning events reconcile row phases', () => {
  const activeTurn = {
    turn_id: 'turn_phase_source',
    status: 'streaming',
    rows: [{
      kind: 'reasoning',
      payload: {
        phase_id: 'phase_shared',
        phase_kind: 'reasoning',
        summary: 'Planning',
      },
    }],
    events: [{
      kind: 'reasoning_phase',
      status: 'completed',
      payload: {
        phase_id: 'phase_shared',
        phase_kind: 'tool_result',
        summary: 'Read the result',
      },
    }],
  };

  const envelopeParts = collectModelParts(activeTurn, { stream_envelope_v2: true });
  assert.deepEqual(envelopeParts.phases, [{
    phaseId: 'phase_shared',
    kind: 'reasoning',
    summary: 'Planning',
    completed: false,
  }]);

  const legacyParts = collectModelParts(activeTurn, { stream_envelope_v2: false });
  assert.deepEqual(legacyParts.phases, [{
    phaseId: 'phase_shared',
    kind: 'tool_result',
    summary: 'Read the result',
    completed: true,
  }]);
  assert.equal(Object.hasOwn(legacyParts, 'todoProjection'), false);
});

test('selectActiveTurnFromLiveState uses the explicit active turn', () => {
  const first = { turn_id: 'turn_first', status: 'streaming', rows: [] };
  const active = { turn_id: 'turn_active', status: 'streaming', rows: [] };
  const selected = selectActiveTurnFromLiveState({
    active_turn_id: 'turn_active',
    turns_by_id: { turn_first: first, turn_active: active },
  });
  assert.strictEqual(selected, active);
});

test('selectActiveTurnFromLiveState falls back to the newest live turn', () => {
  const first = { turn_id: 'turn_first', status: 'streaming', rows: [] };
  const newest = { turn_id: 'turn_newest', status: 'streaming', rows: [] };
  const selected = selectActiveTurnFromLiveState({
    active_turn_id: 'missing',
    turns_by_id: { turn_first: first, turn_newest: newest },
  });
  assert.strictEqual(selected, newest);
});

test('selectActiveTurnFromLiveState falls back to reconciled rows', () => {
  const rows = [{ kind: 'assistant_text', payload: { text: 'Hydrated answer.' } }];
  const selected = selectActiveTurnFromLiveState({
    turns_by_id: {},
    reconciled_rows_by_turn_id: {
      turn_reconciled: {
        turn: { turn_id: 'turn_reconciled', status: 'streaming' },
        rows,
      },
    },
  });
  assert.equal(selected.turn_id, 'turn_reconciled');
  assert.strictEqual(selected.rows, rows);
  assert.equal(selected.status, 'unknown');
  assert.match(selected.error, /status is unavailable/i);
});

test('deriveReconciledTurnStatus completes reconciled rows without a terminal hint', () => {
  assert.deepEqual(
    deriveReconciledTurnStatus([{ kind: 'assistant_text', payload: { text: 'Done.' } }]),
    { status: 'completed', error: '' }
  );
});

test('deriveReconciledTurnStatus preserves every persisted terminal outcome', () => {
  const cases = [
    ['error', 'errored'], ['cancelled', 'cancelled'], ['denied', 'denied'],
    ['timeout', 'timed_out'], ['interrupted', 'interrupted'], ['preempted', 'preempted'],
    ['malformed', 'unknown'],
  ];
  for (const [terminalStatus, expected] of cases) {
    const result = deriveReconciledTurnStatus([{
      kind: 'system_notice',
      payload: { subkind: 'assistant_error', terminal_status: terminalStatus },
    }]);
    assert.equal(result.status, expected);
  }
});

test('deriveReconciledTurnStatus preserves a live unknown hint when hydrated rows have no error notice', () => {
  const result = deriveReconciledTurnStatus([
    { kind: 'assistant_text', payload: { text: 'Partial answer.' } },
  ], 'unknown');
  assert.equal(result.status, 'unknown');
  assert.match(result.error, /status is unavailable/i);
});
