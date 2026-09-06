const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
  reconcileTurnRows,
} = require('../renderer/chat/renderer-turn-reducer');
const { normalizeTurnEvent } = require('../services/backend/message-normalization');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'timeline-replay');
const DETERMINISTIC_ROW_OPTIONS = Object.freeze({ deterministicRowId: true });
const REQUIRED_SCENARIOS = Object.freeze([
  '01-simple-turn',
  '02-one-tool-pre-post-reasoning',
  '03-approval-approved',
  '04-interleaved-tools',
  '05-approval-denied',
  '06-inline-artifacts',
  '07-tool-use-error-invalid-args',
  '08-stream-reset-after-text',
  '09-agent-progress',
  '11-branched-retry',
  '12-legacy-no-phases',
  '13-slash-output',
  '14-attachment-cluster',
  '15-interactive-batch-recap',
  '16-reload-mid-running-tool',
  '17-system-notice-subkinds',
  '18-stream-events-tool-call-trace',
  '19-normal-turn-question-batch',
  '20-plan-proposal',
  '21-jenny-write-edit-diff-metadata',
  '22-approval-pending',
  '23-approval-pending-status-mismatch',
  // Ht-E (chat_tool_trace_rows_fix): the f34016f non-coalescing shape — a
  // settled tool call in a turn with no assistant text. Pins the
  // projector/reducer contract the render-layer per-call partition relies on.
  '24-settled-tool-no-assistant-text',
  '25-stream-error',
  '26-tool-timed-out',
  '27-long-reasoning-summary',
  '28-reasoning-replay-after-text',
  '29-plan-approval-document',
]);

// SHA bump #1 (Ht-E, 2026-07-01): deliberate — adds the 24-settled-tool-no-
// assistant-text scenario only; every pre-existing fixture is byte-identical.
// Rationale recorded in HARDENING_HISTORY.md.
// SHA bump #2 (cohesiveness QoL W1-3, 2026-07-19): deliberate — the approval
// card now quotes the exact command being approved, so approval_gap row
// payloads carry the call's `input_json` (projector + live reducer in
// lockstep). Refresh limited to expected-rows.json in 22-approval-pending and
// 23-approval-pending-status-mismatch; the only delta is the added input_json
// field. Every other fixture is byte-identical.
// SHA bump #3 (P5-0 runtime matrix, 2026-08-10): deliberate — adds persisted
// stream-error, timed-out tool, and long collapsed-reasoning boundary fixtures.
// SHA bump #4 (reasoning-row-dupe fix, 2026-08-29): deliberate — adds the
// persisted-only 28-reasoning-replay-after-text scenario only; every
// pre-existing fixture is byte-identical. Rationale in HARDENING_HISTORY.md.
// SHA bump #5 (W7a-S4 merge, 2026-08-29): approval fixtures in scenarios 22/23
// use edit_file after apply_patch retired from the model-facing tool surface;
// recomputed over the merged corpus (bump #4's scenario 28 included).
// SHA bump #6 (deterministic replay row ids, 2026-08-29): enables the
// production-default DC1 identity anchors across expected-rows fixtures and
// adds scenario 28's live reasoning/text replay trace. Non-row-id fields in
// pre-existing expected rows are byte-equivalent after JSON normalization.
// SHA bump #7 (plan-card live/hydrated parity, 2026-08-31): deliberate — adds
// the 29-plan-approval-document scenario only (fixture + its notes.md
// harness-artifact documentation); every pre-existing fixture is
// byte-identical. Rationale in HARDENING_HISTORY.md.
const EXPECTED_CORPUS_SHA256 = '29d6a38f35db5d08d18a088b19ecf87aa1aef4feccb9c1ff1e1002021778ebb2';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function replayStreamEvents(streamEvents) {
  const reducerState = createTurnReducerState(DETERMINISTIC_ROW_OPTIONS);
  const events = Array.isArray(streamEvents) ? streamEvents : [];
  for (let index = 0; index < events.length; index += 1) {
    const entry = events[index] && typeof events[index] === 'object' ? events[index] : {};
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
    const context = entry.context && typeof entry.context === 'object' ? entry.context : {};
    const reducerEvents = buildTurnEventFromStreamPayload(payload, context);
    applyTurnStreamEvent(reducerState, reducerEvents);
  }
  return reducerState;
}

function buildPersistedTurnEvents(projectedTurns) {
  let nextSeq = 0;
  const turns = Array.isArray(projectedTurns?.turns) ? projectedTurns.turns : [];
  return turns.flatMap((turn) => (
    Array.isArray(turn?.events) ? turn.events.map((event) => ({
      event_id: event.event_id,
      event_seq: nextSeq++,
      turn_id: event.turn_id,
      kind: event.kind,
      status: event.status || '',
      primary_message_id: event.primary_message_id || '',
      source_message_ids: Array.isArray(event.source_message_ids) ? event.source_message_ids.slice() : [],
      target_message_id: '',
      tool_call_id: event.tool_call_id || '',
      segment_group_index: event.segment_group_index ?? null,
      phase_id: event.phase_id || '',
      started_at: event.payload?.started_at || '',
      completed_at: event.payload?.completed_at || '',
      payload: JSON.parse(JSON.stringify(event.payload || {})),
    })) : []
  ));
}

function scenarioFiles(scenarioDir) {
  const files = [
    'session.json',
    'expected-turns.json',
    'expected-rows.json',
    'notes.md',
  ];
  const optionalStreamEvents = path.join(scenarioDir, 'stream-events.json');
  if (fs.existsSync(optionalStreamEvents)) {
    files.push('stream-events.json');
  }
  return files.map((name) => path.join(scenarioDir, name));
}

function computeCorpusDigest(rootDir) {
  const hash = crypto.createHash('sha256');
  const scenarioNames = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const scenarioName of scenarioNames) {
    for (const filePath of scenarioFiles(path.join(rootDir, scenarioName))) {
      hash.update(path.relative(rootDir, filePath).replace(/\\/g, '/'));
      hash.update('\n');
      // Normalize CRLF→LF so the locked digest is stable on Windows checkouts.
      hash.update(fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n'));
      hash.update('\n');
    }
  }

  return hash.digest('hex');
}

test('timeline replay corpus contains the required Batch 1 scenarios', () => {
  const scenarioNames = fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(scenarioNames, REQUIRED_SCENARIOS);
});

test('timeline replay corpus checksum matches the locked fixture set', () => {
  assert.equal(computeCorpusDigest(FIXTURE_ROOT), EXPECTED_CORPUS_SHA256);
});

// The action_target_message_id → target_message_id rename is complete; only
// the canonical spelling is read or emitted at runtime. The schema v9
// migration shim in `electron-session-store.js` (`repairSessionForV9`) remains
// in place permanently as the upgrade path for any v8 payload that surfaces.
test('normalizeTurnEvent reads target_message_id and emits it as target_message_id', () => {
  const normalized = normalizeTurnEvent({
    turn_id: 'turn-1',
    kind: 'tool_executing',
    target_message_id: 'msg-canonical',
  }, 0);
  assert.equal(normalized.target_message_id, 'msg-canonical');
  assert.ok(
    !('action_target_message_id' in normalized),
    'legacy action_target_message_id field must not be emitted',
  );
});

test('normalizeTurnEvent emits empty target_message_id when none is provided', () => {
  const normalized = normalizeTurnEvent({
    turn_id: 'turn-1',
    kind: 'tool_executing',
  }, 0);
  assert.equal(normalized.target_message_id, '');
});

test('timeline replay corpus checksum includes optional stream-events fixtures', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-replay-digest-'));
  t.after(() => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_e) { /* ignore */ } });
  const scenarioDir = path.join(tempRoot, '01-temp-scenario');
  fs.mkdirSync(scenarioDir, { recursive: true });

  for (const [name, content] of Object.entries({
    'session.json': '{}',
    'expected-turns.json': '{}',
    'expected-rows.json': '{}',
    'notes.md': 'temporary fixture',
  })) {
    fs.writeFileSync(path.join(scenarioDir, name), content);
  }

  const digestWithoutStreamEvents = computeCorpusDigest(tempRoot);
  fs.writeFileSync(path.join(scenarioDir, 'stream-events.json'), '[]');
  const digestWithStreamEvents = computeCorpusDigest(tempRoot);

  assert.notEqual(digestWithoutStreamEvents, digestWithStreamEvents);
});

test('timeline replay fixture 21 settles and rehydrates the same in-row file diffs', () => {
  const scenarioDir = path.join(FIXTURE_ROOT, '21-jenny-write-edit-diff-metadata');
  const messages = normalizeChatMessages(readJson(path.join(scenarioDir, 'session.json')));
  const projected = projectTurnTree({ messages });
  const hydrated = projectTurnTree({
    messages,
    turn_event_log_version: 1,
    turn_events: buildPersistedTurnEvents(projected),
  });
  const renderer = createTurnRowToolRenderUtils({
    escapeHtml: (value) => String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  });
  function renderDiffRows(turnTree) {
    const rows = turnTree.turns.flatMap((turn) => projectTurnRows(turn.events, DETERMINISTIC_ROW_OPTIONS));
    return rows.filter((row) => row.kind === 'tool_call').map((row) => renderer.buildToolCallRowMarkup(row, messages, {
      sessionId: 'fixture-21',
      forceMaterializeToolDetails: true,
      pairedToolResultRow: rows.find((candidate) => candidate.kind === 'tool_result' && candidate.tool_call_id === row.tool_call_id),
    }));
  }
  const settledMarkup = renderDiffRows(projected);
  const hydratedMarkup = renderDiffRows(hydrated);
  assert.deepEqual(hydratedMarkup, settledMarkup);
  assert.equal(settledMarkup.length, 2);
  for (const markup of settledMarkup) {
    assert.match(markup, /class="file-diff"/);
    assert.match(markup, /README\.md/);
    assert.match(markup, /data-file-diff-pending/);
    assert.doesNotMatch(markup, /class="diff-line|tool-call-section-kicker">Output/);
  }
});

for (const scenarioName of REQUIRED_SCENARIOS) {
  test(`timeline replay scenario ${scenarioName} matches the expected turn and row projections`, () => {
    const scenarioDir = path.join(FIXTURE_ROOT, scenarioName);
    const session = readJson(path.join(scenarioDir, 'session.json'));
    const expectedTurns = readJson(path.join(scenarioDir, 'expected-turns.json'));
    const expectedRows = readJson(path.join(scenarioDir, 'expected-rows.json'));
    const notes = fs.readFileSync(path.join(scenarioDir, 'notes.md'), 'utf8').trim();
    const streamEventsPath = path.join(scenarioDir, 'stream-events.json');
    const streamEvents = fs.existsSync(streamEventsPath) ? readJson(streamEventsPath) : null;

    assert.ok(notes.length > 0, 'notes.md should explain scenario intent');

    const normalizedSession = normalizeChatMessages(session);
    assert.deepEqual(normalizeChatMessages(normalizedSession), normalizedSession);

    const projectedTurns = projectTurnTree({ messages: normalizedSession });
    const projectedRows = projectedTurns.turns.map((turn) => ({
      turn_id: turn.turn_id,
      rows: projectTurnRows(turn.events, DETERMINISTIC_ROW_OPTIONS),
    }));
    const persistedTurnEvents = buildPersistedTurnEvents(projectedTurns);
    const hydratedFromTurnEvents = projectTurnTree({
      messages: normalizedSession,
      turn_event_log_version: 1,
      turn_events: persistedTurnEvents,
    });
    const hydratedRowsFromTurnEvents = hydratedFromTurnEvents.turns.map((turn) => ({
      turn_id: turn.turn_id,
      rows: projectTurnRows(turn.events, DETERMINISTIC_ROW_OPTIONS),
    }));

    assert.deepEqual(toPlainJson(projectedTurns), expectedTurns);
    assert.deepEqual(toPlainJson(projectedRows), expectedRows);
    assert.deepEqual(toPlainJson(hydratedRowsFromTurnEvents), expectedRows);

    for (const turn of projectedTurns.turns) {
      const flattenedSourceEvents = projectTurnRows(turn.events, DETERMINISTIC_ROW_OPTIONS)
        .flatMap((row) => row.source_events);
      assert.deepEqual(
        flattenedSourceEvents.slice().sort(),
        turn.events.map((event) => event.event_id).slice().sort()
      );
    }

    if (Array.isArray(streamEvents) && streamEvents.length > 0) {
      const replayState = replayStreamEvents(streamEvents);
      const firstEntry = streamEvents.find((entry) => entry && typeof entry === 'object') || {};
      const turnId = String(
        firstEntry?.context?.turn_id
        || firstEntry?.payload?.streamId
        || firstEntry?.payload?.requestId
        || firstEntry?.payload?.request_id
        || ''
      ).trim();
      assert.ok(turnId, 'stream-events fixtures should identify the replay turn');
      const provisionalRows = replayState.turns_by_id[turnId]?.rows || [];
      const hydratedRowSet = projectedRows.find((entry) => entry.turn_id === turnId);
      assert.ok(hydratedRowSet, `expected hydrated rows for turn ${turnId}`);
      const reconciliation = reconcileTurnRows(
        provisionalRows,
        hydratedRowSet.rows,
        DETERMINISTIC_ROW_OPTIONS,
      );
      assert.deepEqual(toPlainJson(reconciliation.finalRows), hydratedRowSet.rows);
      // D1 trace-parity reflow witness: every live provisional row must match a
      // hydrated trace row by identity key (kind|turn|tool_call_id), so nothing
      // is stranded as stale. Without this, a tool_step-vs-tool_call mismatch
      // would pass silently (finalRows always equals the full hydrated set).
      assert.deepEqual(reconciliation.staleRows, []);
      // Approval-gap parity (soft-lock regression): the streaming reducer must
      // surface the standalone approval_gap row whenever the hydrated projection
      // does — otherwise the live timeline shows "Awaiting approval" with no
      // Allow/Deny buttons. The finalRows/staleRows checks above can't catch a
      // missing gap row (it's a hydrated-side row, not a stale provisional one),
      // so assert the provisional side directly. Inert for scenarios with no gap.
      if (hydratedRowSet.rows.some((row) => row.kind === 'approval_gap')) {
        assert.ok(
          provisionalRows.some((row) => row.kind === 'approval_gap'),
          'live reducer must emit an approval_gap row for an unresolved approval'
        );
      }
      const hydratedPlanRow = hydratedRowSet.rows.find((row) => row.kind === 'plan_document');
      if (hydratedPlanRow) {
        const livePlanRow = provisionalRows.find((row) => row.kind === 'plan_document');
        assert.ok(
          livePlanRow,
          'live reducer must emit a plan_document row when hydration does'
        );
        // State parity pins the live tool_result -> plan_document transition
        // branch: without it the live card stays pending after the decision.
        assert.equal(livePlanRow.payload.state, hydratedPlanRow.payload.state);
        assert.deepEqual(livePlanRow.payload.transitions, hydratedPlanRow.payload.transitions);
      }
    }
  });
}
