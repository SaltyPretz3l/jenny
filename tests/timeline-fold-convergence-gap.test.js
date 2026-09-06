'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const {
  applyTurnStreamEvent,
  createTurnReducerState,
  sealTurnRows,
} = require('../renderer/chat/renderer-turn-reducer');
const {
  projectPersistedEventsWithReducer,
} = require('../renderer/chat/renderer-stream-rehydrate');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'timeline-replay');
const SCENARIOS = fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

// The timeline has two folds: the live reducer (incremental, one event at a
// time) and the hydrated projector (whole-array, with lookahead from a tool_use
// to its approval and result). The consolidation program collapses them onto the
// reducer, which means the reducer must first learn every row kind the projector
// produces.
//
// This is the measured gap, per turn: row kinds the PROJECTOR produces that
// replaying the same canonical turn events through the REDUCER does not. It is
// asserted exactly, so each kind the fold learns must delete its entries here in
// the same commit -- the ledger shrinks to empty when the folds converge.
//
// Note what this does NOT say: it compares row KIND multisets, not identity or
// payload. Row identity diverges too (the reducer mints
// row:tool_call:<turn>:<call_id> from canonical events where the projector mints
// row:<turn>:tool_use:0) and is a separate step of the convergence.
const FOLD_GAP_LEDGER = [
  // CLOSED. Every turn in the corpus now folds to the projector's row-kind
  // sequence, in both directions. The list stays as the ratchet it always was:
  // a regression repopulates it and fails the assertion below.
];

// The row kinds the fold learned from the projector in Wave 3a, and which the
// corpus actually exercises. The mirrored table in the reducer also carries
// attachment / plan_object / suggestion / source_citations; no fixture produces
// those events, so they are unexercised mirrors of the projector's builders and
// are deliberately NOT claimed here.
const FOLDED_ROW_KINDS = [
  'user_bubble',
  'system_notice',
  'agent_progress',
  'batch',
  'recap',
  'slash_output',
  'plan_proposal',
];

// chat_timeline_deterministic_row_id is DEFAULT-ON in the shipped app
// (services/feature-flags.js), and projectTurnRows only stamps identity when it is
// asked to. Omitting it makes the projector return raw row:<event_id> ids and any
// identity comparison against the fold reads as a total divergence that is not
// real -- measured that way once during this program before the flag was noticed.
const PROJECTOR_OPTIONS = Object.freeze({ deterministicRowId: true });

// The delegation shape Wave 3c is closing toward, and the shape
// projectPersistedEventsWithReducer already uses in production behind
// canonical_renderer_projection: replay the WHOLE persisted log through the fold,
// then seal it. Sealing is what turns a tool left running into `interrupted` -- a
// verdict only a complete log can support, which is why the fold has to be told
// rather than deriving it per event.
function foldCanonicalTurn(turn) {
  const state = createTurnReducerState({ deterministicRowId: true });
  for (const event of turn.events) {
    applyTurnStreamEvent(state, event);
  }
  const folded = state.turns_by_id[turn.turn_id];
  sealTurnRows(folded);
  return (folded && folded.rows) || [];
}

function replayCanonicalEventsThroughReducer(turn) {
  return foldCanonicalTurn(turn).map((row) => row.kind);
}

function missingKinds(expectedKinds, actualKinds) {
  const remaining = new Map();
  for (const kind of actualKinds) {
    remaining.set(kind, (remaining.get(kind) || 0) + 1);
  }
  const missing = [];
  for (const kind of expectedKinds) {
    const available = remaining.get(kind) || 0;
    if (available > 0) {
      remaining.set(kind, available - 1);
    } else {
      missing.push(kind);
    }
  }
  return missing.sort();
}

function collectFoldGap() {
  const entries = [];
  for (const scenarioName of SCENARIOS) {
    const messages = normalizeChatMessages(
      JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, scenarioName, 'session.json'), 'utf8'))
    );
    for (const turn of projectTurnTree({ messages }).turns) {
      const missing = missingKinds(
        projectTurnRows(turn.events, PROJECTOR_OPTIONS).map((row) => row.kind),
        replayCanonicalEventsThroughReducer(turn)
      );
      if (missing.length) {
        entries.push(`${scenarioName}/${turn.turn_id}: ${missing.join(', ')}`);
      }
    }
  }
  return entries;
}

test('the live fold and the hydrated fold differ by exactly the recorded gap', () => {
  assert.deepEqual(
    collectFoldGap(),
    FOLD_GAP_LEDGER,
    'fold gap changed: update FOLD_GAP_LEDGER in the same commit that changes the fold',
  );
});

test('every turn the projector opens with a user bubble folds one too', () => {
  // Wave 3a, guarded directly against the folds rather than against the ledger
  // above -- deleting a ledger entry cannot make this vacuous. Before the fold
  // learned user_prompt this was 27 of the ledger's 28 entries, the single
  // largest slice of the divergence.
  let bubbleTurns = 0;
  for (const scenarioName of SCENARIOS) {
    const messages = normalizeChatMessages(
      JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, scenarioName, 'session.json'), 'utf8'))
    );
    for (const turn of projectTurnTree({ messages }).turns) {
      const countBubbles = (kinds) => kinds.filter((kind) => kind === 'user_bubble').length;
      const expected = countBubbles(projectTurnRows(turn.events, PROJECTOR_OPTIONS).map((row) => row.kind));
      if (!expected) {
        continue;
      }
      bubbleTurns += 1;
      assert.equal(
        countBubbles(replayCanonicalEventsThroughReducer(turn)),
        expected,
        `${scenarioName}/${turn.turn_id} lost its user bubble in the live fold`,
      );
    }
  }
  assert.ok(bubbleTurns >= 27, `expected the corpus to still exercise user bubbles, saw ${bubbleTurns}`);
});

test('the two folds mint the same row identity from the same canonical events', () => {
  // The DOM morph is keyed on data-row-id, so identity is not cosmetic: a live row
  // and its hydrated twin that disagree here cannot be matched, and the row is
  // rebuilt instead of reused across the live -> hydrated handoff. Both sides
  // already share the minting function (deriveDeterministicRowId); what diverged
  // was the tuple fed to it.
  const mismatches = [];
  // A `#N` suffix is the collision escape hatch in stampDeterministicRowIds --
  // legitimate for a genuinely repeated identity tuple, but the corpus has none
  // under canonical replay. A suffix here means two rows collapsed onto ONE
  // identity and were papered over rather than distinguished, which is exactly how
  // the assistant-segment-index bug stayed invisible: both rows derived
  // row:assistant_text:<turn>:0 and the second silently became ...:0#1.
  const collided = [];
  let compared = 0;
  for (const scenarioName of SCENARIOS) {
    const messages = normalizeChatMessages(
      JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, scenarioName, 'session.json'), 'utf8'))
    );
    for (const turn of projectTurnTree({ messages }).turns) {
      const foldedRows = foldCanonicalTurn(turn);
      const projectedRows = projectTurnRows(turn.events, PROJECTOR_OPTIONS);
      for (let index = 0; index < Math.max(foldedRows.length, projectedRows.length); index += 1) {
        compared += 1;
        const projected = projectedRows[index];
        const folded = foldedRows[index];
        if (folded && String(folded.row_id).includes('#')) {
          collided.push(`${scenarioName}/${turn.turn_id} fold ${folded.row_id}`);
        }
        if (projected && String(projected.row_id).includes('#')) {
          collided.push(`${scenarioName}/${turn.turn_id} projector ${projected.row_id}`);
        }
        if (!projected || !folded || projected.row_id !== folded.row_id) {
          mismatches.push(
            `${scenarioName}/${turn.turn_id} [${index}] projector=${projected && projected.row_id} fold=${folded && folded.row_id}`
          );
        }
      }
    }
  }

  assert.deepEqual(mismatches, [], 'row identity diverged between the folds');
  assert.deepEqual(collided, [], 'two rows collapsed onto one identity and were suffixed apart');
  assert.ok(compared >= 90, `expected the corpus to still compare rows, saw ${compared}`);
});

test('an unanswered approval outranks a tool_executing notice', () => {
  // The last divergence the ledger held. The backend cannot emit this order --
  // both emitters of tool_executing either never requested approval, or send
  // approval_resolved first and execute only on an approved answer -- so this
  // pins the fail-safe reading of a stream that LOST its resolution: keep the
  // tool awaiting approval, which keeps the Allow/Deny block on screen, rather
  // than drop to running and strand the turn with no way to answer the tool it
  // is still blocked on.
  const events = (kinds) => kinds.map(([kind, status], index) => ({
    event_id: `e${index}`,
    turn_id: 'turn_1',
    kind,
    tool_call_id: 'call_1',
    primary_message_id: 'tool_use_call_1',
    status,
    payload: { tool_name: 'edit_file', ...(kind === 'tool_use' ? { input: {} } : {}) },
  }));
  const fold = (list) => {
    const state = createTurnReducerState({ deterministicRowId: true });
    for (const event of list) {
      applyTurnStreamEvent(state, event);
    }
    return state.turns_by_id.turn_1.rows;
  };

  const stranded = fold(events([
    ['tool_use', 'pending_approval'],
    ['approval_requested', 'pending_approval'],
    ['tool_executing', 'running'],
  ]));
  assert.equal(stranded.find((row) => row.kind === 'tool_call').payload.state, 'awaiting_approval');
  assert.ok(
    stranded.some((row) => row.kind === 'approval_gap'),
    'the Allow/Deny block must survive an execution notice the user never approved',
  );

  // The other half, and the reason the guard counts resolutions rather than
  // simply ignoring tool_executing: once the approval IS answered, execution
  // proceeds normally and the block is retracted.
  const answered = fold(events([
    ['tool_use', 'pending_approval'],
    ['approval_requested', 'pending_approval'],
    ['approval_resolved', 'approved'],
    ['tool_executing', 'running'],
  ]));
  assert.equal(answered.find((row) => row.kind === 'tool_call').payload.state, 'running');
  assert.ok(!answered.some((row) => row.kind === 'approval_gap'));
});

// Wave 3c's target. Kinds, identities and row order have converged; the payloads
// on the five kinds that BOTH folds build independently have not. Recorded as the
// set of (row kind, field) pairs that differ somewhere in the corpus, so closing a
// class deletes its entry and the ledger shrinks to empty when the projector can
// finally delegate to the fold.
//
// Occurrence counts are deliberately not asserted. These divergences are
// systematic -- a field is merged, or timestamped, or absent, for every row of its
// kind -- so the count only measures how many fixtures happen to exercise it, and
// asserting it would turn an unrelated fixture edit into a failure here.
//
// Every other entry left is the fold carrying MORE than the projector, never less
// -- which is the state that matters, and which the delegation gate below asserts
// directly. The fold's payload is what the LIVE renderer already consumes on every
// streaming turn, so a superset field is not a risk; a missing one would be.
// `tool_call payload.state` is different: the sealed fold carries the verdict
// `interrupted` where the bare projector says `awaiting_approval`, because
// foldCanonicalTurn knows the log is complete and projectTurnRows is never told.
//
// The three that WERE losses are closed: chunk_count (the projector's
// "Thinking... (N chunks)" placeholder), input_summary (read by the search index
// and the timeline's tool label), and source_message_ids (the fold merged the
// tool_use and tool_result ids onto one row, making the
// [data-source-message-ids~=<id>] lookup in renderer-turn-shell.js ambiguous while
// streaming -- the divergence the Wave 2 render ledger resolved in the projector's
// favour).
//
// approval_requests is a FORK, not a defect: both sides record the request and
// disagree about which row OWNS it. The projector partitions the event onto the
// standalone approval_gap row, withholds it from the tool_call row, and passes a
// compensating `awaitingApproval` flag so that row can still derive its state; the
// fold records it on both and needs no flag. One producer must eventually pick.
const PAYLOAD_GAP_LEDGER = [
  'approval_gap payload.prompt',
  'assistant_text payload.truncated',
  'reasoning payload.phase',
  'reasoning payload.phase_kind',
  'reasoning payload.summary',
  'reasoning payload.truncated',
  'tool_call payload.approval_requested_at_ms',
  'tool_call payload.approval_requests',
  'tool_call payload.duplicate_tool_use_count',
  'tool_call payload.error_code',
  'tool_call payload.generated_artifacts',
  'tool_call payload.output_text',
  'tool_call payload.result_is_error',
  'tool_call payload.result_summary',
  'tool_call payload.running_started_at_ms',
  'tool_call payload.state',
  'tool_result payload.generated_artifacts',
];

const COMPARED_ROW_FIELDS = [
  'primary_message_id',
  'source_message_ids',
  'assistant_phase',
  'phase_id',
  'tool_call_id',
  'segment_group_index',
];

function differs(left, right) {
  try {
    assert.deepEqual(left, right);
    return false;
  } catch (_error) {
    return true;
  }
}

test('a tool that arrives already denied still records how it resolved', () => {
  // The defect this measurement found. updateToolRowState treats `denied` as a
  // terminal state and returns early, which was suppressing the approval history
  // as well as the state change -- so a row that had been denied could not say
  // what denied it. History is recorded before the guard now; the guard still
  // protects the state.
  const state = createTurnReducerState({ deterministicRowId: true });
  const base = { turn_id: 'turn_1', tool_call_id: 'call_1', primary_message_id: 'tool_use_call_1' };
  applyTurnStreamEvent(state, {
    ...base, event_id: 'e0', kind: 'tool_use', status: 'denied',
    payload: { tool_name: 'edit_file', input: {} },
  });
  applyTurnStreamEvent(state, {
    ...base, event_id: 'e1', kind: 'approval_resolved', status: 'denied',
    payload: { approval_state: 'denied' },
  });
  const row = state.turns_by_id.turn_1.rows.find((candidate) => candidate.kind === 'tool_call');

  assert.deepEqual(row.payload.approval_resolutions, [{ status: 'denied', approval_state: 'denied' }]);
  assert.equal(row.payload.state, 'denied', 'the terminal state must still be protected from the late event');
});

test('sealing a complete log interrupts a tool that never got a result', () => {
  // `interrupted` is a verdict about the WHOLE log, not about any single event, so
  // the fold is told rather than deriving it -- which is the point. The hydrated
  // projector infers it from the absence of a result and is therefore wrong for
  // every turn still in flight, and two mechanisms exist to undo that guess:
  // guardLiveTurnRows (renderer-render-pipeline-hydration.js) patches the state
  // back to running for live turns, and pickBetterRow
  // (renderer-render-message-index-utils.js) carries a special matchup rule so a
  // live row beats a canonical interrupted one. Neither is needed by a fold that
  // only seals when the log is complete.
  const build = (extraEvents) => {
    const state = createTurnReducerState({ deterministicRowId: true });
    const base = { turn_id: 'turn_1', tool_call_id: 'call_1', primary_message_id: 'tool_use_call_1' };
    applyTurnStreamEvent(state, {
      ...base, event_id: 'e0', kind: 'tool_use', status: 'running',
      payload: { tool_name: 'read_file', input: {} },
    });
    applyTurnStreamEvent(state, {
      ...base, event_id: 'e1', kind: 'tool_executing', status: 'running',
      payload: { tool_name: 'read_file' },
    });
    for (const event of extraEvents) {
      applyTurnStreamEvent(state, event);
    }
    return state.turns_by_id.turn_1;
  };
  const toolState = (turn) => turn.rows.find((row) => row.kind === 'tool_call').payload.state;

  const stillStreaming = build([]);
  assert.equal(toolState(stillStreaming), 'running', 'an unsealed turn must never claim interrupted');
  sealTurnRows(stillStreaming);
  assert.equal(toolState(stillStreaming), 'interrupted');

  // A tool that DID report back is settled, and sealing must leave it alone --
  // otherwise the seal would be indistinguishable from "mark every tool
  // interrupted", which the assertion above cannot catch on its own.
  const settled = build([{
    turn_id: 'turn_1', tool_call_id: 'call_1', primary_message_id: 'tool_result_call_1',
    event_id: 'e2', kind: 'tool_result', status: 'completed',
    payload: { output_text: 'contents' },
  }]);
  assert.equal(toolState(settled), 'completed');
  sealTurnRows(settled);
  assert.equal(toolState(settled), 'completed');
});

// A value that carries no information. Used only by the delegation gate: a
// projector field that is absent, blank, or an empty container cannot be LOST by
// handing production to the fold.
function isEmptyValue(value) {
  if (value === undefined || value === null || value === '') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return typeof value === 'object' && Object.keys(value).length === 0;
}

test('the production replay adapter feeds the fold everything the fold can build', () => {
  // The gap a real regression exposed, and the reason this test exists. Every
  // other test in this file hands the fold CANONICAL events directly. Production
  // does not: it goes through shapePersistedEventForReducer, whose REPLAYABLE_KINDS
  // allow-list returns null for any kind it does not list, silently.
  //
  // That was harmless while the turn-row projector built the hydrated rows -- those
  // kinds simply were not the fold's business -- and became row DELETION the moment
  // canonical_renderer_projection made the fold the producer. It removed the
  // terminal error card (caught by renderer-chat-terminal-error-card.test.js) and,
  // before the list was opened, every user bubble, system notice, batch, recap,
  // slash output, plan proposal and agent-progress row in the corpus: 28 of 28
  // turns diverged.
  //
  // Measuring the fold is not measuring the path into it.
  const divergent = [];
  for (const scenarioName of SCENARIOS) {
    const messages = normalizeChatMessages(
      JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, scenarioName, 'session.json'), 'utf8'))
    );
    for (const turn of projectTurnTree({ messages }).turns) {
      const direct = foldCanonicalTurn(turn);
      const projection = projectPersistedEventsWithReducer(turn.events, {
        turnId: turn.turn_id,
        deterministicRowId: true,
      });
      const adapted = (projection && projection.rows) || [];
      const describe = (rows) => rows.map((row) => `${row.kind}:${row.row_id}`);
      if (differs(describe(adapted), describe(direct))) {
        divergent.push(
          `${scenarioName}/${turn.turn_id}
    direct : ${describe(direct).join(', ')}`
          + `
    adapter: ${describe(adapted).join(', ')}`
        );
      }
    }
  }

  assert.deepEqual(divergent, [], 'the replay adapter dropped rows the fold builds');
});

test('delegating hydration to the fold would lose no populated projector field', () => {
  // THE gate for canonical_renderer_projection. That flag (default-off) already
  // routes hydrated rows through projectPersistedEventsWithReducer -- the fold --
  // instead of the projector, so Wave 3c is not a rewrite: it is making this
  // assertion true and then flipping the flag behind owner telemetry.
  //
  // Deliberately one-directional. Byte-equality between the folds was never the
  // goal and would force churn that serves nobody; what must never happen is the
  // fold shipping a row that dropped something the projector was rendering.
  const losses = [];
  for (const scenarioName of SCENARIOS) {
    const messages = normalizeChatMessages(
      JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, scenarioName, 'session.json'), 'utf8'))
    );
    for (const turn of projectTurnTree({ messages }).turns) {
      const foldedRows = foldCanonicalTurn(turn);
      const projectedRows = projectTurnRows(turn.events, PROJECTOR_OPTIONS);
      for (let index = 0; index < Math.max(foldedRows.length, projectedRows.length); index += 1) {
        const projected = projectedRows[index] || {};
        const folded = foldedRows[index] || {};
        const check = (label, projectedValue, foldedValue) => {
          if (!differs(foldedValue, projectedValue)) {
            return;
          }
          if (isEmptyValue(projectedValue) || !isEmptyValue(foldedValue)) {
            return;
          }
          losses.push(
            `${scenarioName}/${turn.turn_id} ${projected.kind || folded.kind} ${label}: `
            + `projector=${JSON.stringify(projectedValue)} fold=${JSON.stringify(foldedValue)}`
          );
        };
        for (const field of Object.keys(projected.payload || {})) {
          check(`payload.${field}`, projected.payload[field], (folded.payload || {})[field]);
        }
        for (const field of COMPARED_ROW_FIELDS) {
          check(field, projected[field], folded[field]);
        }
      }
    }
  }

  assert.deepEqual(losses, [], 'the fold would drop a field the projector renders');
});

test('the folds differ by exactly the recorded payload gap', () => {
  const divergentKeys = new Set();
  for (const scenarioName of SCENARIOS) {
    const messages = normalizeChatMessages(
      JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, scenarioName, 'session.json'), 'utf8'))
    );
    for (const turn of projectTurnTree({ messages }).turns) {
      const foldedRows = foldCanonicalTurn(turn);
      const projectedRows = projectTurnRows(turn.events, PROJECTOR_OPTIONS);
      for (let index = 0; index < Math.max(foldedRows.length, projectedRows.length); index += 1) {
        const projected = projectedRows[index] || {};
        const folded = foldedRows[index] || {};
        const kind = projected.kind || folded.kind;
        const payloadFields = new Set([
          ...Object.keys(projected.payload || {}),
          ...Object.keys(folded.payload || {}),
        ]);
        for (const field of payloadFields) {
          if (differs((folded.payload || {})[field], (projected.payload || {})[field])) {
            divergentKeys.add(`${kind} payload.${field}`);
          }
        }
        for (const field of COMPARED_ROW_FIELDS) {
          if (differs(folded[field], projected[field])) {
            divergentKeys.add(`${kind} ${field}`);
          }
        }
      }
    }
  }

  assert.deepEqual(
    [...divergentKeys].sort(),
    PAYLOAD_GAP_LEDGER,
    'payload gap changed: update PAYLOAD_GAP_LEDGER in the same commit that changes a fold',
  );
});

test('the folded rows carry the same payloads the projector builds', () => {
  // Kind parity alone would pass on empty rows. Row IDENTITY still diverges
  // between the folds (that is Wave 3b), so rows are matched by position within
  // their kind rather than by row_id.
  const comparisonsByKind = new Map(FOLDED_ROW_KINDS.map((kind) => [kind, 0]));
  for (const scenarioName of SCENARIOS) {
    const messages = normalizeChatMessages(
      JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, scenarioName, 'session.json'), 'utf8'))
    );
    for (const turn of projectTurnTree({ messages }).turns) {
      const foldedRows = foldCanonicalTurn(turn);
      const projectedRows = projectTurnRows(turn.events, PROJECTOR_OPTIONS);
      for (const kind of FOLDED_ROW_KINDS) {
        const projected = projectedRows.filter((row) => row.kind === kind);
        const folded = foldedRows.filter((row) => row.kind === kind);
        for (let index = 0; index < Math.max(projected.length, folded.length); index += 1) {
          comparisonsByKind.set(kind, comparisonsByKind.get(kind) + 1);
          assert.deepEqual(
            folded[index] && folded[index].payload,
            projected[index] && projected[index].payload,
            `${scenarioName}/${turn.turn_id} ${kind}[${index}] payload diverged`,
          );
        }
      }
    }
  }

  // Without this the loop above proves nothing for a kind the corpus stopped
  // exercising -- it would simply compare zero rows and pass.
  for (const [kind, count] of comparisonsByKind) {
    assert.ok(count > 0, `no fixture exercises ${kind}; its payload parity is unproven`);
  }
});
