const test = require('node:test');
const assert = require('node:assert/strict');
const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const { buildManagedChatRequest, createManagedChatServiceStub } = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const { cleanupTrackedResources, createTrackedTempDir, trackCloseable } = require('./helpers/resource-cleanup');
const path = require('node:path');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { TurnEventJournal } = require('../services/backend/turn-event-journal');

test.afterEach(async () => cleanupTrackedResources());

const {
  DEFAULT_RECEIPTS_CAP,
  acknowledgeInterruptedTurnReceipts,
  computeInterruptedTurnReceipts,
  summarizeInterruptedTurnEvents,
} = require('../services/backend/interrupted-turn-receipts');

// ---- fabricated journal-event helpers (persisted turn-event kind shape) ----

function toolUse(callId, toolName) {
  return {
    event_id: `${callId}:use`,
    kind: 'tool_use',
    tool_call_id: callId,
    payload: { tool_call: { call_id: callId, tool_name: toolName } },
  };
}

function toolExecuting(callId, toolName) {
  return {
    event_id: `${callId}:exec`,
    kind: 'tool_executing',
    tool_call_id: callId,
    payload: { tool_call: { call_id: callId, tool_name: toolName } },
  };
}

function toolResult(callId, toolName, { isError = false, summary = '' } = {}) {
  return {
    event_id: `${callId}:res`,
    kind: 'tool_result',
    tool_call_id: callId,
    payload: { tool_result: { call_id: callId, tool_name: toolName, is_error: isError, summary } },
  };
}

function approvalRequested(callId) {
  return { event_id: `${callId}:appreq`, kind: 'approval_requested', tool_call_id: callId, payload: {} };
}

function approvalResolved(callId) {
  return { event_id: `${callId}:appres`, kind: 'approval_resolved', tool_call_id: callId, payload: {} };
}

function fakeJournal(sessions) {
  return { listSession: (sessionId) => (sessions && sessions[sessionId]) || {} };
}

test('managed failed and cancelled sends retain receipts for the next send', async () => {
  for (const outcome of ['failed_response', 'failed', 'cancelled', 'initialization_failed']) {
    const service = createManagedChatServiceStub();
    const sessionId = `receipts_${outcome}`;
    service.sessionStore._backend = durableStore()._backend;
    let prior = [toolUse('c1', 'read_file')];
    service.turnEventJournal = {
      listSession: () => ({ turns: { prior } }),
      clear: (_sessionId, turnId) => {
        if (turnId === 'prior') prior = [];
        return { ok: true, durable: true };
      },
    };
    service.sidecarClient = {
      async chatSend(_params, options) {
        if (outcome === 'failed_response') return { status: 'runtime_error', error: 'Send failed' };
        if (outcome === 'failed') throw new Error('Send failed');
        service.activeStreams.values().next().value.abort();
        options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
        return { status: 'completed' };
      },
    };
    if (outcome === 'initialization_failed') {
      const failed = Promise.reject(new Error('Initialization failed'));
      failed.catch(() => {});
      service._managedInitializeFlight = { promise: failed };
    }
    const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({ sessionId }));
    await service.activeStreams.get(stream.streamId)._pendingPromise;
    assert.equal(prior.length, 1, `${outcome} must retain recovery evidence`);
    assert.equal(computeInterruptedTurnReceipts({ journal: service.turnEventJournal, sessionId }).turn_id, 'prior');
  }
});

test('a send whose terminal fails to settle keeps its receipts', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'receipts_terminal_failed';
  service.sessionStore._backend = durableStore()._backend;
  let prior = [toolUse('c1', 'read_file')];
  service.turnEventJournal = {
    listSession: () => ({ turns: { prior } }),
    clear: () => { prior = []; return { ok: true, durable: true }; },
  };
  service.sidecarClient = {
    async chatSend(_params, options) {
      // No visible text: the terminal settle rejects the turn after the send.
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({ sessionId }));
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  assert.equal(prior.length, 1, 'a turn that did not commit must not consume the receipts');
});

test('computing receipts leaves recovery evidence intact until acknowledgement', () => {
  let clearCalls = 0;
  const journal = fakeJournal({ s1: { turns: { prior: [toolUse('c1', 'read_file')] } } });
  journal.clear = () => { clearCalls += 1; return { ok: true, durable: true }; };
  assert.ok(computeInterruptedTurnReceipts({ journal, sessionId: 's1' }));
  assert.equal(clearCalls, 0, 'computing is not delivery');
});

// ===========================================================================
// summarizeInterruptedTurnEvents (pure core)
// ===========================================================================

test('summarize classifies completed, failed, and started-unfinished tools', () => {
  const receipts = summarizeInterruptedTurnEvents([
    toolUse('c1', 'read_file'),
    toolResult('c1', 'read_file', { summary: 'read 40 lines' }),
    toolUse('c2', 'run_command'),
    toolResult('c2', 'run_command', { isError: true, summary: 'exit 1' }),
    toolUse('c3', 'write_file'),
    toolExecuting('c3', 'write_file'),
  ]);
  assert.ok(receipts, 'expected receipts for an interrupted turn');
  assert.deepEqual(receipts.completed, [{ tool_name: 'read_file', summary: 'read 40 lines' }]);
  assert.deepEqual(receipts.failed, [{ tool_name: 'run_command', summary: 'exit 1' }]);
  assert.deepEqual(receipts.unfinished, [{ tool_name: 'write_file' }]);
  assert.equal(receipts.truncated, false);
  assert.equal(receipts.total, 3);
});

test('summarize detects a failed tool via error_code when is_error is absent', () => {
  const receipts = summarizeInterruptedTurnEvents([
    toolUse('c1', 'run_command'),
    {
      event_id: 'c1:res',
      kind: 'tool_result',
      tool_call_id: 'c1',
      status: 'error',
      payload: { tool_result: { call_id: 'c1', tool_name: 'run_command', error_code: 'CMP-TOOL-0001' } },
    },
  ]);
  assert.equal(receipts.failed.length, 1);
  assert.equal(receipts.completed.length, 0);
});

test('summarize returns null for a clean turn with a terminal marker', () => {
  // assistant_error is the reduced turn_failed/turn_cancelled marker.
  const receipts = summarizeInterruptedTurnEvents([
    toolUse('c1', 'read_file'),
    toolResult('c1', 'read_file'),
    { event_id: 't:err', kind: 'assistant_error', payload: {} },
  ]);
  assert.equal(receipts, null);
});

test('summarize returns null when there was no tool activity', () => {
  assert.equal(summarizeInterruptedTurnEvents([]), null);
  assert.equal(
    summarizeInterruptedTurnEvents([{ event_id: 'x', kind: 'reasoning_phase', payload: {} }]),
    null
  );
});

test('summarize returns null for an approval-pause (pending approval)', () => {
  const receipts = summarizeInterruptedTurnEvents([
    toolUse('c1', 'run_command'),
    approvalRequested('c1'),
  ]);
  assert.equal(receipts, null);
});

test('summarize still reports when an approval was resolved before interruption', () => {
  const receipts = summarizeInterruptedTurnEvents([
    toolUse('c1', 'run_command'),
    approvalRequested('c1'),
    approvalResolved('c1'),
    toolExecuting('c1', 'run_command'),
  ]);
  assert.ok(receipts);
  assert.deepEqual(receipts.unfinished, [{ tool_name: 'run_command' }]);
});

test('summarize caps to the most recent N tool calls and flags truncation', () => {
  const events = [];
  for (let index = 0; index < DEFAULT_RECEIPTS_CAP + 5; index += 1) {
    events.push(toolUse(`c${index}`, `tool_${index}`));
    events.push(toolResult(`c${index}`, `tool_${index}`, { summary: `ok ${index}` }));
  }
  const receipts = summarizeInterruptedTurnEvents(events);
  const totalRendered = receipts.completed.length + receipts.failed.length + receipts.unfinished.length;
  assert.equal(totalRendered, DEFAULT_RECEIPTS_CAP);
  assert.equal(receipts.truncated, true);
  assert.equal(receipts.total, DEFAULT_RECEIPTS_CAP + 5);
  // Most recent kept: the last tool must be present, the first dropped.
  assert.ok(receipts.completed.some((entry) => entry.tool_name === `tool_${DEFAULT_RECEIPTS_CAP + 4}`));
  assert.ok(!receipts.completed.some((entry) => entry.tool_name === 'tool_0'));
});

test('summarize tolerates malformed rows without throwing', () => {
  const receipts = summarizeInterruptedTurnEvents([
    null,
    'not-an-object',
    [1, 2, 3],
    toolUse('c1', 'read_file'),
    toolResult('c1', 'read_file'),
  ]);
  assert.equal(receipts.completed.length, 1);
});

test('summarize flattens newline-injected tool_name and summary before capping', () => {
  const receipts = summarizeInterruptedTurnEvents([
    toolUse('c1', 'read_file\n## Fake Heading\ninjected'),
    // Empty tool_name on the result so it does not overwrite the tool_use name above.
    toolResult('c1', '', { summary: 'line1\n## Fake Heading\nline3' }),
  ]);
  assert.ok(receipts);
  const entry = receipts.completed[0];
  assert.equal(entry.tool_name.includes('\n'), false);
  assert.equal(entry.summary.includes('\n'), false);
  assert.equal(entry.tool_name, 'read_file ## Fake Heading injected');
  assert.equal(entry.summary, 'line1 ## Fake Heading line3');
});

// ===========================================================================
// computeInterruptedTurnReceipts (orchestration)
// ===========================================================================

test('compute returns null when the session has no journal partitions', () => {
  const journal = fakeJournal({});
  assert.equal(
    computeInterruptedTurnReceipts({ journal, sessionId: 's1', currentTurnId: 't-current' }),
    null
  );
});

test('compute excludes the current turn partition', () => {
  const journal = fakeJournal({
    s1: { turns: { 't-current': [toolUse('c1', 'read_file'), toolExecuting('c1', 'read_file')] } },
  });
  assert.equal(
    computeInterruptedTurnReceipts({ journal, sessionId: 's1', currentTurnId: 't-current' }),
    null
  );
});

test('compute returns the interrupted prior turn ledger with its turn_id', () => {
  const journal = fakeJournal({
    s1: {
      turns: {
        't-prior': [
          toolUse('c1', 'read_file'),
          toolResult('c1', 'read_file', { summary: 'read' }),
          toolUse('c2', 'write_file'),
          toolExecuting('c2', 'write_file'),
        ],
      },
    },
  });
  const receipts = computeInterruptedTurnReceipts({ journal, sessionId: 's1', currentTurnId: 't-current' });
  assert.ok(receipts);
  assert.equal(receipts.turn_id, 't-prior');
  assert.equal(receipts.completed.length, 1);
  assert.equal(receipts.unfinished.length, 1);
});

test('compute picks the richest interrupted partition when several linger', () => {
  const journal = fakeJournal({
    s1: {
      turns: {
        't-small': [toolUse('c1', 'read_file'), toolExecuting('c1', 'read_file')],
        't-big': [
          toolUse('c1', 'read_file'),
          toolResult('c1', 'read_file'),
          toolUse('c2', 'run_command'),
          toolResult('c2', 'run_command'),
          toolUse('c3', 'write_file'),
        ],
      },
    },
  });
  const receipts = computeInterruptedTurnReceipts({ journal, sessionId: 's1', currentTurnId: 't-current' });
  assert.equal(receipts.turn_id, 't-big');
});

test('compute is fail-closed and logs counts-only when the journal throws', () => {
  const logs = [];
  const journal = { listSession: () => { throw new Error('boom'); } };
  const receipts = computeInterruptedTurnReceipts({
    journal,
    sessionId: 's1',
    currentTurnId: 't-current',
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  assert.equal(receipts, null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'chat.interrupted_turn_receipts_failed');
  assert.equal(logs[0].details.errorType, 'Error');
});

test('compute returns null when a missing journal is supplied', () => {
  assert.equal(computeInterruptedTurnReceipts({ sessionId: 's1', currentTurnId: 't' }), null);
  assert.equal(computeInterruptedTurnReceipts({ journal: {}, sessionId: 's1' }), null);
});

// ===========================================================================
// Journal partition clearing (fix packet: receipts must not repeat forever)
// ===========================================================================

test('acknowledgement clears the partition with actual store durability epochs', () => {
  const clearCalls = [];
  const journal = fakeJournal({
    s1: {
      turns: {
        't-prior': [toolUse('c1', 'read_file'), toolResult('c1', 'read_file', { summary: 'read' })],
      },
    },
  });
  journal.clear = (sessionId, turnId, options) => {
    clearCalls.push({ sessionId, turnId, options });
    return { ok: true, cleared: true, durable: true, reason: null };
  };

  const receipts = computeInterruptedTurnReceipts({ journal, sessionId: 's1', currentTurnId: 't-current' });

  assert.ok(receipts);
  assert.equal(clearCalls.length, 0);
  acknowledgeInterruptedTurnReceipts({ journal, result: { status: 'completed' }, store: durableStore(), sessionId: 's1', receipts });
  assert.equal(clearCalls.length, 1);
  assert.equal(clearCalls[0].sessionId, 's1');
  assert.equal(clearCalls[0].turnId, 't-prior');
  assert.equal(clearCalls[0].turnId, receipts.turn_id);
  assert.equal(clearCalls[0].options.commitResult.ok, true);
  assert.equal(clearCalls[0].options.commitResult.durable, true);
  assert.equal(clearCalls[0].options.commitResult.commitEpoch, 7);
});

test('compute does not call clear when there is no interrupted partition to report', () => {
  let clearCalled = false;
  const journal = fakeJournal({});
  journal.clear = () => { clearCalled = true; return { ok: true, cleared: false, durable: true, reason: null }; };

  const receipts = computeInterruptedTurnReceipts({ journal, sessionId: 's1', currentTurnId: 't-current' });

  assert.equal(receipts, null);
  assert.equal(clearCalled, false);
});

test('acknowledgement is fail-soft when the journal clear throws: summary still returned + WARN logged', () => {
  const logs = [];
  const journal = fakeJournal({
    s1: {
      turns: {
        't-prior': [toolUse('c1', 'read_file'), toolResult('c1', 'read_file', { summary: 'read' })],
      },
    },
  });
  journal.clear = () => { throw new Error('disk boom'); };

  const receipts = computeInterruptedTurnReceipts({
    journal,
    sessionId: 's1',
    currentTurnId: 't-current',
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.ok(receipts);
  assert.equal(receipts.turn_id, 't-prior');
  acknowledgeInterruptedTurnReceipts({ journal, result: { status: 'completed' }, store: durableStore(), sessionId: 's1', receipts,
    logger: (level, event, details) => logs.push({ level, event, details }) });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'chat.interrupted_turn_receipts_clear_failed');
  assert.equal(logs[0].details.errorType, 'Error');
});

test('acknowledgement is fail-soft when the journal clear reports non-durable: summary still returned + WARN logged', () => {
  const logs = [];
  const journal = fakeJournal({
    s1: {
      turns: {
        't-prior': [toolUse('c1', 'read_file'), toolResult('c1', 'read_file', { summary: 'read' })],
      },
    },
  });
  journal.clear = () => ({ ok: false, cleared: false, durable: false, reason: 'journal_write_failed' });

  const receipts = computeInterruptedTurnReceipts({
    journal,
    sessionId: 's1',
    currentTurnId: 't-current',
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.ok(receipts);
  acknowledgeInterruptedTurnReceipts({ journal, result: { status: 'completed' }, store: durableStore(), sessionId: 's1', receipts,
    logger: (level, event, details) => logs.push({ level, event, details }) });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'chat.interrupted_turn_receipts_clear_failed');
  assert.equal(logs[0].details.reason, 'journal_write_failed');
});

test('compute does not call clear when the journal has no clear method', () => {
  // fakeJournal() has no `clear` -- must not throw when the collaborator is
  // a minimal stand-in (matches every pre-existing test in this file).
  const journal = fakeJournal({
    s1: {
      turns: {
        't-prior': [toolUse('c1', 'read_file'), toolResult('c1', 'read_file', { summary: 'read' })],
      },
    },
  });

  const receipts = computeInterruptedTurnReceipts({ journal, sessionId: 's1', currentTurnId: 't-current' });

  assert.equal(receipts.turn_id, 't-prior');
  assert.deepEqual(receipts.completed, [{ tool_name: 'read_file', summary: 'read' }]);
});

function durableStore() {
  return { getSession: () => ({}),
    _backend: { getSessionDurability: () => ({ dirtyEpoch: 7, durableEpoch: 7 }) } };
}

test('acknowledgement retains receipts when canonical durability cannot be proven', () => {
  let clearCalls = 0;
  acknowledgeInterruptedTurnReceipts({
    result: { status: 'completed' },
    journal: { clear: () => { clearCalls += 1; } },
    store: { getSession: () => ({}), flushSession: () => false },
    sessionId: 's1', receipts: { turn_id: 'prior' },
  });
  assert.equal(clearCalls, 0);
});

test('managed successful send clears persisted receipts only after its response', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'receipts_success';
  const dir = createTrackedTempDir('jenny-receipts-');
  service.sessionStore = trackCloseable(new ElectronSessionStore(path.join(dir, 'sessions.json')));
  service.sessionStore.createSessionWithId(sessionId, { title: 'Receipt recovery' });
  const journalPath = path.join(dir, 'journal.json');
  service.turnEventJournal = trackCloseable(new TurnEventJournal(journalPath));
  service.turnEventJournal.append(sessionId, 'prior', [toolUse('c1', 'read_file')]);
  service.sidecarClient = {
    async chatSend(params, options) {
      assert.equal(service.turnEventJournal.list(sessionId, 'prior').length, 1,
        'evidence survives until the request succeeds');
      assert.equal(params.interrupted_turn_receipts.turn_id, 'prior');
      options.onNotification({ method: 'chat.token', params: { delta: 'Recovered.' } });
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({ sessionId }));
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  assert.deepEqual(service.turnEventJournal.list(sessionId, 'prior'), []);
  const reopened = trackCloseable(new TurnEventJournal(journalPath));
  assert.deepEqual(reopened.list(sessionId, 'prior'), [], 'delivery consumption survives restart');
});
