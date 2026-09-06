const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildResumePayload,
  detectInterruptionState,
  filterHistoryForResume,
  recoverTurnEventJournal,
  repairToolPairing,
} = require('../services/session-recovery-service');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { TurnEventJournal } = require('../services/backend/turn-event-journal');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('session recovery detects mid-turn and mid-prompt interruptions', () => {
  assert.equal(
    detectInterruptionState([
      { role: 'user', content: 'Start a tool run' },
      {
        role: 'tool',
        kind: 'tool_result',
        tool_result: { call_id: 'call_1', tool_name: 'read_file' },
      },
    ]),
    'mid_turn'
  );
  assert.equal(
    detectInterruptionState([
      { role: 'assistant', content: 'Previous response' },
      { role: 'user', content: 'Try that again' },
    ]),
    'mid_prompt'
  );
  assert.equal(
    detectInterruptionState(
      [
        { role: 'assistant', content: 'Previous response' },
        { id: 'user_1', role: 'user', content: 'Continue that work', client_message_id: 'user_1' },
      ],
      {
        request_id: 'req_1',
        stream_id: 'stream_1',
        user_message_id: 'user_1',
        started_at: '2026-04-09T10:00:00.000Z',
        last_event_at: '2026-04-09T10:00:01.000Z',
        status: 'awaiting_assistant',
      }
    ),
    'mid_turn'
  );
  assert.equal(
    detectInterruptionState([
      { role: 'assistant', content: 'All set.' },
    ]),
    'clean'
  );
});

test('session recovery repairs orphaned tool messages and strips whitespace-only assistant rows', () => {
  const filtered = filterHistoryForResume([
    { role: 'assistant', content: '   ' },
    { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'paired', tool_name: 'read_file' } },
    { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'paired', tool_name: 'read_file' } },
    { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'orphan_use', tool_name: 'glob_files' } },
    { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'orphan_result', tool_name: 'glob_files' } },
    { role: 'assistant', content: 'Kept answer.' },
  ]);

  // Whitespace-only assistant is dropped.
  // Paired tool messages are kept.
  // Orphaned tool_use gets a synthetic error result injected.
  // Orphaned tool_result (no matching tool_use) is dropped.
  assert.deepEqual(
    filtered.map((message) => message.tool_call?.call_id || message.tool_result?.call_id || message.content),
    ['paired', 'paired', 'orphan_use', 'orphan_use', 'Kept answer.']
  );
  // Verify the injected synthetic result.
  const synthetic = filtered.find(
    (m) => m.tool_result?.call_id === 'orphan_use' && m.kind === 'tool_result'
  );
  assert.equal(synthetic.tool_result.is_error, true);
  assert.equal(synthetic.tool_result.error_code, 'CMP-LOOP-0013');
});

test('session recovery adds a synthetic resume prompt for interrupted turns', () => {
  const payload = buildResumePayload({
    messages: [
      { role: 'user', content: 'Summarize the repo' },
      { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'call_1', tool_name: 'read_file' } },
      { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'call_1', tool_name: 'read_file' } },
    ],
  });

  assert.equal(payload.interruptionKind, 'mid_turn');
  assert.equal(payload.resumeMessage.role, 'user');
  assert.match(payload.resumeMessage.content, /Resume the interrupted turn/i);
});

test('session recovery removes the trailing prompt body for mid-prompt retries', () => {
  const payload = buildResumePayload({
    messages: [
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Repeat that please' },
    ],
  });

  assert.equal(payload.interruptionKind, 'mid_prompt');
  assert.equal(payload.resumeMessage, null);
  assert.deepEqual(payload.messages, [{ role: 'assistant', content: 'Earlier answer' }]);
});

test('session recovery uses prior active_turn to treat a trailing user message as an interrupted turn', () => {
  const payload = buildResumePayload({
    messages: [
      { role: 'assistant', content: 'Earlier answer' },
      { id: 'user_2', role: 'user', content: 'Continue from there', client_message_id: 'user_2' },
    ],
    active_turn: {
      request_id: 'req_2',
      stream_id: 'stream_2',
      user_message_id: 'user_2',
      started_at: '2026-04-09T10:00:00.000Z',
      last_event_at: '2026-04-09T10:00:05.000Z',
      status: 'streaming',
    },
  });

  assert.equal(payload.interruptionKind, 'mid_turn');
  assert.equal(payload.messages.at(-1).content, 'Continue from there');
  assert.match(payload.resumeMessage.content, /Resume the interrupted turn/i);
});

test('session recovery ignores stale active_turn when the transcript already ends cleanly', () => {
  const payload = buildResumePayload({
    messages: [
      { role: 'user', content: 'Do the work', client_message_id: 'user_3' },
      { role: 'assistant', content: 'Done.' },
    ],
    active_turn: {
      request_id: 'req_stale',
      stream_id: 'stream_stale',
      user_message_id: 'user_3',
      started_at: '2026-04-09T10:00:00.000Z',
      last_event_at: '2026-04-09T10:00:05.000Z',
      status: 'streaming',
    },
  });

  assert.equal(payload.interruptionKind, 'clean');
  assert.equal(payload.resumeMessage, null);
});

test('session recovery replays journaled turn events for interrupted active turns', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-turn-event-journal-'));
  trackDirectory(userDataPath);
  const sessionStore = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const journal = new TurnEventJournal(path.join(userDataPath, 'turn-event-journal.json'));
  const created = sessionStore.createSession({ title: 'Interrupted' });
  sessionStore.appendMessage(created.id, {
    id: 'user_stream_1',
    role: 'user',
    content: 'Run a tool',
    client_message_id: 'user_stream_1',
  });
  sessionStore.setActiveTurn(created.id, {
    request_id: 'stream_1',
    stream_id: 'stream_1',
    user_message_id: 'user_stream_1',
    started_at: '2026-04-26T10:00:00.000Z',
    last_event_at: '2026-04-26T10:00:01.000Z',
    status: 'streaming',
  });
  journal.append(created.id, 'stream_1', [{
    event_id: 'stream_1:tool_use:0',
    turn_id: 'stream_1',
    kind: 'tool_use',
    tool_call_id: 'call_1',
    payload: { tool_name: 'read_file' },
  }]);

  const result = recoverTurnEventJournal({ sessionStore, journal });

  assert.equal(result.replayed, 1);
  assert.equal(sessionStore.getSessionTurnEvents(created.id)[0].event_id, 'stream_1:tool_use:0');
  assert.deepEqual(journal.list(created.id, 'stream_1'), []);
});

test('session recovery RETAINS the journal when the turn-event append fails to persist', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-turn-event-journal-fail-'));
  trackDirectory(userDataPath);
  const sessionStore = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const journal = new TurnEventJournal(path.join(userDataPath, 'turn-event-journal.json'));
  const created = sessionStore.createSession({ title: 'Interrupted' });
  sessionStore.setActiveTurn(created.id, {
    request_id: 'stream_fail',
    stream_id: 'stream_fail',
    user_message_id: 'user_fail',
    started_at: '2026-04-26T10:00:00.000Z',
    last_event_at: '2026-04-26T10:00:01.000Z',
    status: 'streaming',
  });
  journal.append(created.id, 'stream_fail', [{
    event_id: 'stream_fail:tool_use:0',
    turn_id: 'stream_fail',
    kind: 'tool_use',
    tool_call_id: 'call_1',
    payload: { tool_name: 'read_file' },
  }]);

  const warnEvents = [];
  // Force the durable append to report a persistence failure so the recovery
  // loop must keep the journal entry instead of assuming success.
  sessionStore.appendTurnEvents = () => ({ ok: false, appended: 0, duplicateCount: 0, reason: 'write_failed' });

  const result = recoverTurnEventJournal({
    sessionStore,
    journal,
    logger: (level, event, data) => warnEvents.push({ level, event, data }),
  });

  assert.equal(result.replayed, 0, 'a failed append replays nothing');
  assert.equal(result.turns, 0, 'no turn is counted as recovered when the append fails');
  assert.equal(
    journal.list(created.id, 'stream_fail').length,
    1,
    'the journal entry must be RETAINED after a failed persist so a later pass can retry'
  );
  const retained = warnEvents.filter((e) => e.event === 'turn_journal.retained_after_persist_failure');
  assert.equal(retained.length, 1, 'a retained-after-failure WARN must be emitted');
  assert.equal(retained[0].data.reason, 'write_failed', 'the WARN carries the failure reason');
});

// --- repairToolPairing unit tests ---

test('repairToolPairing preserves correctly paired tool messages', () => {
  const messages = [
    { role: 'user', content: 'Do something' },
    { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'c1', tool_name: 'read_file' } },
    { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'c1', tool_name: 'read_file', is_error: false } },
    { role: 'assistant', content: 'Done.' },
  ];
  const repaired = repairToolPairing(messages);
  assert.deepEqual(repaired, messages);
});

test('repairToolPairing injects synthetic error for orphaned tool_use', () => {
  const messages = [
    { role: 'user', content: 'Run a tool' },
    { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'c1', tool_name: 'exec_cmd' } },
    // No tool_result for c1 -- sidecar crashed before completing.
  ];
  const repaired = repairToolPairing(messages);
  assert.equal(repaired.length, 3);
  const synthetic = repaired[2];
  assert.equal(synthetic.role, 'tool');
  assert.equal(synthetic.kind, 'tool_result');
  assert.equal(synthetic.tool_result.call_id, 'c1');
  assert.equal(synthetic.tool_result.tool_name, 'exec_cmd');
  assert.equal(synthetic.tool_result.is_error, true);
  assert.equal(synthetic.tool_result.error_code, 'CMP-LOOP-0013');
  assert.match(synthetic.content, /tool execution interrupted/i);
});

test('repairToolPairing drops orphaned tool_result with no matching tool_use', () => {
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'ghost', tool_name: 'read_file' } },
    { role: 'assistant', content: 'Reply.' },
  ];
  const repaired = repairToolPairing(messages);
  assert.deepEqual(
    repaired.map((m) => m.content),
    ['Hello', 'Reply.']
  );
});

test('repairToolPairing deduplicates tool_result keeping only the first', () => {
  const messages = [
    { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'c1', tool_name: 'read_file' } },
    { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'c1', tool_name: 'read_file', output_text: 'first' } },
    { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'c1', tool_name: 'read_file', output_text: 'duplicate' } },
  ];
  const repaired = repairToolPairing(messages);
  assert.equal(repaired.length, 2);
  assert.equal(repaired[1].tool_result.output_text, 'first');
});

test('repairToolPairing handles multiple orphaned tool_use in sequence (crash mid-batch)', () => {
  const messages = [
    { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'c1', tool_name: 'read_file' } },
    { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'c1', tool_name: 'read_file' } },
    { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'c2', tool_name: 'glob_files' } },
    { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'c3', tool_name: 'exec_cmd' } },
    // c2 and c3 both orphaned -- crash killed both executions.
  ];
  const repaired = repairToolPairing(messages);
  // c1 pair + c2 + synthetic for c2 + c3 + synthetic for c3 = 6 messages
  assert.equal(repaired.length, 6);
  assert.equal(repaired[3].tool_result.call_id, 'c2');
  assert.equal(repaired[3].tool_result.error_code, 'CMP-LOOP-0013');
  assert.equal(repaired[5].tool_result.call_id, 'c3');
  assert.equal(repaired[5].tool_result.error_code, 'CMP-LOOP-0013');
});

test('repairToolPairing handles mixed valid pairs, orphans, and duplicates together', () => {
  const messages = [
    // Valid pair.
    { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'ok', tool_name: 'read_file' } },
    { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'ok', tool_name: 'read_file' } },
    // Orphaned tool_result (no tool_use).
    { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'no_use', tool_name: 'exec_cmd' } },
    // Orphaned tool_use (no result).
    { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'no_result', tool_name: 'glob_files' } },
    // Duplicate result for the valid pair.
    { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'ok', tool_name: 'read_file', output_text: 'dup' } },
    { role: 'assistant', content: 'Summary.' },
  ];
  const repaired = repairToolPairing(messages);
  const ids = repaired.map((m) => m.tool_call?.call_id || m.tool_result?.call_id || m.content);
  // ok pair kept, orphan result dropped, orphan use + synthetic, dup dropped, text kept
  assert.deepEqual(ids, ['ok', 'ok', 'no_result', 'no_result', 'Summary.']);
  // The second 'no_result' is the synthetic.
  const synth = repaired[3];
  assert.equal(synth.tool_result.is_error, true);
  assert.equal(synth.tool_result.error_code, 'CMP-LOOP-0013');
});

// --- Crash-resume integration test (end-to-end through buildResumePayload) ---

test('crash-resume: buildResumePayload repairs pairing after sidecar crash mid-loop', () => {
  // Simulate a session where the sidecar crashed after completing 2 of 3 tool
  // calls.  Messages are what Electron persisted via inline notifications.
  const payload = buildResumePayload({
    messages: [
      { role: 'user', content: 'Refactor the auth module' },
      // Iteration 1: completed.
      { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'iter1', tool_name: 'read_file', input: { path: 'auth.js' } } },
      { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'iter1', tool_name: 'read_file', output_text: 'file contents', is_error: false } },
      // Iteration 2: completed.
      { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'iter2', tool_name: 'edit_file', input: { path: 'auth.js' } } },
      { role: 'tool', kind: 'tool_result', tool_result: { call_id: 'iter2', tool_name: 'edit_file', output_text: 'ok', is_error: false } },
      // Iteration 3: sidecar crashed -- tool_use persisted but no result.
      { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'iter3', tool_name: 'exec_cmd', input: { cmd: 'npm test' } } },
    ],
  });

  // Should detect mid_turn (last message is tool_use).
  assert.equal(payload.interruptionKind, 'mid_turn');
  assert.ok(payload.resumeMessage, 'should have a resume prompt');
  assert.match(payload.resumeMessage.content, /Resume the interrupted turn/i);

  // All 3 iterations should be present: 2 real pairs + 1 repaired pair.
  const toolUses = payload.messages.filter((m) => m.kind === 'tool_use');
  const toolResults = payload.messages.filter((m) => m.kind === 'tool_result');
  assert.equal(toolUses.length, 3, 'all 3 tool_use messages preserved');
  assert.equal(toolResults.length, 3, 'all 3 tool_result messages present (2 real + 1 synthetic)');

  // The synthetic result for iter3 should be an error.
  const iter3Result = toolResults.find((m) => m.tool_result.call_id === 'iter3');
  assert.ok(iter3Result, 'synthetic result for iter3 exists');
  assert.equal(iter3Result.tool_result.is_error, true);
  assert.equal(iter3Result.tool_result.error_code, 'CMP-LOOP-0013');
  assert.equal(iter3Result.tool_result.tool_name, 'exec_cmd');

  // Real results are untouched.
  const iter1Result = toolResults.find((m) => m.tool_result.call_id === 'iter1');
  assert.equal(iter1Result.tool_result.is_error, false);
  assert.equal(iter1Result.tool_result.output_text, 'file contents');
});
