'use strict';

// Cold reopen is the ONE timeline path the consolidation has not taken over.
// canonical_renderer_projection (default-ON) routes a LIVE turn's hydrated rows
// through the fold at reconcileLiveTurnWithHydratedRows; a cold session reopen
// renders through buildHydratedTurnProjection in
// renderer-render-pipeline-hydration.js, which calls projectTurn directly and
// never reads that flag.
//
// This file measures what routing cold reopen through the fold would cost, and
// records the one thing that measurement proved is NOT mechanical.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows, projectTurn } = require('../renderer/chat/renderer-turn-row-projector');
const {
  applyTurnStreamEvent,
  createTurnReducerState,
  sealTurnRows,
} = require('../renderer/chat/renderer-turn-reducer');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'timeline-replay');
const SCENARIOS = fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const TOOL_ROW_KINDS = new Set(['tool_call', 'tool_step', 'tool_result']);

// Terminal event kinds. A log that carries none of these ended without saying so.
const TERMINAL_EVENT_KINDS = new Set(['complete', 'error', 'assistant_error']);

// chat_timeline_deterministic_row_id is DEFAULT-ON in the shipped app, and
// projectTurnRows/projectTurn only stamp identity when asked. Measuring without
// it reads as a total divergence that is not real (this program did exactly that
// once, in Wave 3b).
const PROJECTOR_OPTIONS = Object.freeze({ deterministicRowId: true });

function loadTurns(scenarioName) {
  const messages = normalizeChatMessages(
    JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, scenarioName, 'session.json'), 'utf8'))
  );
  const messageById = new Map();
  for (const message of messages) {
    const id = String((message && message.id) || '').trim();
    if (id && !messageById.has(id)) {
      messageById.set(id, message);
    }
  }
  return { turns: projectTurnTree({ messages }).turns, messageById };
}

// What cold reopen ACTUALLY renders: projectTurn, not projectTurnRows. The
// difference is applyViewModelEnrichments, which overwrites payload.state for
// tool rows from the canonical view-model and calls itself the single authority.
function projectColdReopenRows(turn, messageById) {
  return projectTurn(turn, {
    deterministicRowId: true,
    messageById,
    toolMessageIdsByCallId: null,
  }).rows;
}

function foldTurn(turn, { seal }) {
  const state = createTurnReducerState({ deterministicRowId: true });
  for (const event of turn.events) {
    applyTurnStreamEvent(state, event);
  }
  const folded = state.turns_by_id[turn.turn_id];
  if (!folded) {
    return [];
  }
  if (seal) {
    sealTurnRows(folded);
  }
  return folded.rows || [];
}

function toolStateByRowId(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (row && row.row_id && TOOL_ROW_KINDS.has(row.kind) && row.payload) {
      byId.set(row.row_id, String(row.payload.state || ''));
    }
  }
  return byId;
}

// The view-model's authority over payload.state is not theoretical: it changes a
// real corpus turn. Recorded exactly so that if the enrichment pass stops firing
// -- or starts firing somewhere new -- this says which turn moved.
const ENRICHMENT_OVERRIDE_LEDGER = [
  '23-approval-pending-status-mismatch/stream_23 tool_call: projectTurnRows=awaiting_approval viewModel=interrupted',
];

function collectEnrichmentOverrides() {
  const entries = [];
  for (const scenarioName of SCENARIOS) {
    const { turns, messageById } = loadTurns(scenarioName);
    for (const turn of turns) {
      const enriched = projectColdReopenRows(turn, messageById);
      const bare = projectTurnRows(turn.events, PROJECTOR_OPTIONS);
      const bareById = toolStateByRowId(bare);
      for (const row of enriched) {
        if (!TOOL_ROW_KINDS.has(row.kind) || !row.payload) {
          continue;
        }
        const before = bareById.get(row.row_id);
        const after = String(row.payload.state || '');
        if (before !== undefined && before !== after) {
          entries.push(`${scenarioName}/${turn.turn_id} ${row.kind}: projectTurnRows=${before} viewModel=${after}`);
        }
      }
    }
  }
  return entries.sort();
}

test('the cold-reopen row source is projectTurn, and its view-model overrides the row builder', () => {
  assert.deepEqual(
    collectEnrichmentOverrides(),
    ENRICHMENT_OVERRIDE_LEDGER,
    'view-model state overrides changed: cold reopen renders projectTurn output, not projectTurnRows'
  );
});

// The gap an UNSEALED fold leaves against what cold reopen renders today. Both
// entries are the same verdict -- `interrupted` -- reached because the tool was
// executing and no result ever arrived.
const COLD_REOPEN_GAP_LEDGER = [
  '16-reload-mid-running-tool/stream_16 row:tool_call:stream_16:call_16: coldReopen=interrupted fold=running',
  '23-approval-pending-status-mismatch/stream_23 row:tool_call:stream_23:call_23: coldReopen=interrupted fold=awaiting_approval',
];

function collectColdReopenGap({ seal }) {
  const entries = [];
  for (const scenarioName of SCENARIOS) {
    const { turns, messageById } = loadTurns(scenarioName);
    for (const turn of turns) {
      const coldRows = toolStateByRowId(projectColdReopenRows(turn, messageById));
      const foldRows = toolStateByRowId(foldTurn(turn, { seal }));
      for (const [rowId, coldState] of coldRows) {
        const foldState = foldRows.get(rowId);
        if (foldState === undefined) {
          entries.push(`${scenarioName}/${turn.turn_id} ${rowId}: MISSING from the fold`);
          continue;
        }
        if (foldState !== coldState) {
          entries.push(`${scenarioName}/${turn.turn_id} ${rowId}: coldReopen=${coldState} fold=${foldState}`);
        }
      }
    }
  }
  return entries.sort();
}

test('an unsealed fold differs from cold reopen by exactly the recorded gap', () => {
  assert.deepEqual(
    collectColdReopenGap({ seal: false }),
    COLD_REOPEN_GAP_LEDGER,
    'cold-reopen gap changed: update COLD_REOPEN_GAP_LEDGER in the same commit'
  );
});

// Sealing the approval state closes the scenario-23 gap. The one survivor points
// the OTHER way: scenario 22's fold knows the log is complete and renders
// `interrupted`, while cold reopen must stay conservative because it cannot tell a
// dead turn from one genuinely blocked on a live approval. That fixture is the
// "Awaiting approval" soft-lock guard, and this ledger remains the tripwire for
// any change to that deliberate asymmetry.
const SEALED_COLD_REOPEN_GAP_LEDGER = [
  '22-approval-pending/stream_22 row:tool_call:stream_22:call_22: coldReopen=awaiting_approval fold=interrupted',
];

test('sealing leaves exactly the conservative cold-reopen approval gap', () => {
  assert.deepEqual(
    collectColdReopenGap({ seal: true }),
    SEALED_COLD_REOPEN_GAP_LEDGER,
    'the post-seal gap changed: update SEALED_COLD_REOPEN_GAP_LEDGER in the same commit'
  );
});

test('only terminal sealing retires unresolved approval prompts', () => {
  const cases = [
    ['23-approval-pending-status-mismatch', 'row:tool_call:stream_23:call_23'],
    ['22-approval-pending', 'row:tool_call:stream_22:call_22'],
  ];
  for (const [scenarioName, rowId] of cases) {
    const { turns } = loadTurns(scenarioName);
    const turn = turns[0];
    assert.equal(
      toolStateByRowId(foldTurn(turn, { seal: false })).get(rowId),
      'awaiting_approval',
      `${scenarioName}: a live approval lost its prompt before terminal sealing`
    );
    assert.equal(
      toolStateByRowId(foldTurn(turn, { seal: true })).get(rowId),
      'interrupted',
      `${scenarioName}: a dead turn kept an approval prompt after terminal sealing`
    );
  }
});

// THE FINDING, and the reason Wave 5 cannot simply delete the liveness check.
//
// Both divergent turns end on tool_executing and carry NO terminal event. Their
// event logs are therefore identical in the only respect that matters here: they
// do not say whether more events are coming.
//
// After a cold reopen `interrupted` is the CORRECT answer for those logs -- the
// app died, nothing more is coming. During a live turn the SAME log must render
// `running` / `awaiting_approval`. Same bytes, two different correct answers.
//
// So the completeness signal is not a property of the log, and no fold over the
// log can derive it. isTurnStreamLive (renderer-render-pipeline-hydration.js) is
// not compensating for a bad guess -- it is supplying information the log does
// not contain. What consolidation can change is WHERE the verdict is reached:
// today the projector guesses per row and guardLiveTurnRows patches it back, and
// the fold instead defers to one explicit sealTurnRows call by whoever knows the
// log is complete. That is one decision instead of two, but the liveness input
// survives either way.
test('the completeness signal that decides `interrupted` is absent from the event log', () => {
  const divergentTurnIds = new Set(
    COLD_REOPEN_GAP_LEDGER.map((entry) => entry.split(' ')[0])
  );
  assert.ok(divergentTurnIds.size > 0, 'expected the gap ledger to name at least one turn');

  let checked = 0;
  for (const scenarioName of SCENARIOS) {
    const { turns } = loadTurns(scenarioName);
    for (const turn of turns) {
      if (!divergentTurnIds.has(`${scenarioName}/${turn.turn_id}`)) {
        continue;
      }
      checked += 1;
      const kinds = turn.events.map((event) => event.kind);
      const terminal = kinds.filter((kind) => TERMINAL_EVENT_KINDS.has(kind));
      assert.deepEqual(
        terminal,
        [],
        `${scenarioName}/${turn.turn_id} carries a terminal event, so the log DOES say it ended `
        + '— re-derive whether liveness still has to come from the runtime'
      );
      assert.equal(
        kinds[kinds.length - 1],
        'tool_executing',
        `${scenarioName}/${turn.turn_id} no longer ends mid-execution`
      );
    }
  }
  assert.equal(checked, divergentTurnIds.size, 'did not find every turn named in the gap ledger');
});
