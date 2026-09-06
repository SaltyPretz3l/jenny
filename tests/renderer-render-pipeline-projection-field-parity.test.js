'use strict';

// Field-list parity between the two twin message field lists (2026-07-31).
//
//   list 1  buildSourceStructureSignature (renderer-render-pipeline-message-
//           renderer.js) — gates the canonical-transcript + thread-tree rebuild
//   list 2  buildSettledFingerprintState (renderer-message-index-utils.js) —
//           feeds the projection CONTENT token, which keys the per-turn
//           turnRowCache and every row.projection_fingerprint, and through that
//           computeTurnTailFingerprint, half of patchActiveTurnRoot's no-op gate
//
// A field that reaches list 1 but not list 2 is a stale-row bug: the rebuild
// fires, but the per-turn cache (deliberately built to survive whole-projection
// misses) serves the old rows, and the active turn's fast path returns `true`
// for a patch it never performed. That is the defect class already fixed for
// image_operation (ff5e0ceb) and send_failure (b9248167); these are the last two
// fields where the lists diverged. Both were confirmed live before the fix —
// buildMessageProjectionFingerprint returned the SAME token either side of the
// change — so each assertion below goes red against the unfixed module.

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeChatMessage } = require('../renderer/chat/chat-message-utils');
const {
  buildMessageProjectionFingerprint,
  computeTurnTailFingerprint,
} = require('../renderer/chat/renderer-message-index-utils');

const TS = '2026-07-31T12:00:00.000Z';

/* ── interactive_round_recap ───────────────────────────────────────────────
 * The recap object IS the whole rendered row: emitAssistantEvents carries it
 * verbatim into the interactive_recap payload and buildRecapRowMarkup renders
 * from that alone, while message.content is only the kicker line. So a recap
 * replaced under a stable message id moves no other sampled field. list 1 folds
 * JSON.stringify(recap) kind-gated; list 2 folds its bounded signature. */

function recapMessage(id, recap) {
  return {
    id,
    role: 'assistant',
    kind: 'interactive_round_recap',
    status: 'complete',
    content: 'Answers recorded',
    timestamp: TS,
    updatedAt: TS,
    finalizedAt: TS,
    attachments: [],
    visible_segments: [],
    tool_steps: [],
    reasoning: { entries: [] },
    reasoning_phases: [],
    interactive_round_recap: recap,
  };
}

function recap(overrides) {
  return {
    round_index: 1,
    answer_count: 2,
    items: [
      { question_id: 'q1', prompt: 'Which stack?', answer_label: 'Node' },
      { question_id: 'q2', prompt: 'Which store?', answer_label: 'sqlite' },
    ],
    collapsed: true,
    ...(overrides || {}),
  };
}

test('attaching an interactive_round_recap mints a fresh projection fingerprint', () => {
  const id = 'recap_attach_probe';
  const before = buildMessageProjectionFingerprint(recapMessage(id, null));
  const after = buildMessageProjectionFingerprint(recapMessage(id, recap()));
  assert.notEqual(after, before, 'a recap attached under a stable id must invalidate the projection');
});

test('re-recording recap answers mints a fresh projection fingerprint', () => {
  const id = 'recap_answers_probe';
  const first = buildMessageProjectionFingerprint(recapMessage(id, recap()));
  const second = buildMessageProjectionFingerprint(recapMessage(id, recap({
    items: [
      { question_id: 'q1', prompt: 'Which stack?', answer_label: 'Deno' },
      { question_id: 'q2', prompt: 'Which store?', answer_label: 'postgres' },
    ],
  })));
  assert.notEqual(second, first, 'replaced recap items must invalidate the projection');
});

test('flipping the recap collapsed flag mints a fresh projection fingerprint', () => {
  const id = 'recap_collapsed_probe';
  const collapsed = buildMessageProjectionFingerprint(recapMessage(id, recap({ collapsed: true })));
  const expanded = buildMessageProjectionFingerprint(recapMessage(id, recap({ collapsed: false })));
  assert.notEqual(expanded, collapsed, 'a persisted collapse toggle must invalidate the projection');
});

test('the active-turn tail fingerprint sees a recap replacement', () => {
  const id = 'recap_tail_probe';
  const turn = { turn_id: 't1', primary_assistant_message_id: id, source_message_ids: [id] };
  // Mirrors buildProjectedRowContentFingerprint: a single-source row's
  // projection_fingerprint IS the source message's content token. The recap row
  // carries no payload.state and its row_id is content-free, so
  // computeTurnStructureHash cannot see this transition at all — the tail
  // fingerprint is the only gate through which patchActiveTurnRoot can.
  const rowsFor = (value) => ([{
    kind: 'recap',
    row_id: `t1:recap:${id}`,
    primary_message_id: id,
    source_message_ids: [id],
    payload: { content: 'Answers recorded', interactive_round_recap: value },
    projection_fingerprint: buildMessageProjectionFingerprint(recapMessage(id, value)),
  }]);
  const before = computeTurnTailFingerprint(turn, rowsFor(recap()));
  const after = computeTurnTailFingerprint(turn, rowsFor(recap({ collapsed: false })));
  assert.notEqual(after, before, 'patchActiveTurnRoot no-ops unless the tail fingerprint moves');
});

/* ── message.phases ────────────────────────────────────────────────────────
 * The durable phase structure. reasoning_phases is a DERIVED projection of it
 * filtered to reasoning kind, so buildReasoningPhaseSignature covers only that
 * slice; the projector reads message.phases directly to bucket visible_segments
 * into phase order and to gate the legacy whole-content fallback. list 1 folds
 * phases.length; list 2 folds the ordered id/kind pairs, which is everything the
 * projector reads off a non-reasoning phase. */

function textPhase(phaseId) {
  return { phaseId, phaseKind: 'text', iteration: 0, startedAt: TS, completedAt: TS, entries: [] };
}

function phasesMessage(id, phases) {
  return {
    id,
    role: 'assistant',
    kind: '',
    status: 'complete',
    content: 'one two',
    timestamp: TS,
    updatedAt: TS,
    finalizedAt: TS,
    attachments: [],
    phases,
    visible_segments: [
      { segment_id: 's1', phase_id: 'phase_a', text: 'one' },
      { segment_id: 's2', phase_id: 'phase_b', text: 'two' },
    ],
    tool_steps: [],
    reasoning: { entries: [] },
    reasoning_phases: [],
  };
}

test('a persisted phase structure arriving mints a fresh projection fingerprint', () => {
  const id = 'phases_length_probe';
  // Same content, same segments — only the phase grouping that orders them.
  const ungrouped = buildMessageProjectionFingerprint(phasesMessage(id, [textPhase('phase_a')]));
  const grouped = buildMessageProjectionFingerprint(
    phasesMessage(id, [textPhase('phase_a'), textPhase('phase_b')])
  );
  assert.notEqual(grouped, ungrouped, 'a phases length change must invalidate the projection');
});

test('a same-length phase regroup mints a fresh projection fingerprint', () => {
  const id = 'phases_regroup_probe';
  // Segments bucket by phase_id, so re-pointing the phase relocates rendered
  // text between the phase-ordered rows and the unmatched-segment tail without
  // changing the phase COUNT that list 1 samples.
  const first = buildMessageProjectionFingerprint(phasesMessage(id, [textPhase('phase_a')]));
  const second = buildMessageProjectionFingerprint(phasesMessage(id, [textPhase('phase_b')]));
  assert.notEqual(second, first, 'a same-length phase regroup must invalidate the projection');
});

test('reasoning-phase lifecycle stays covered by the derived reasoning_phases', () => {
  // Pins the id/kind-only fold as deliberate rather than an oversight: every
  // reasoning-phase lifecycle field is already hashed via reasoning_phases
  // (normalizeChatMessage derives it from phases), so re-hashing them in the
  // phase-structure signature would only cost work per frame.
  const build = (id, completedAt) => normalizeChatMessage({
    id,
    role: 'assistant',
    status: 'complete',
    content: 'thought through it',
    timestamp: TS,
    phases: [{
      phaseId: 'r1',
      phaseKind: 'reasoning',
      iteration: 0,
      startedAt: TS,
      completedAt,
      entries: [{ id: 'e1', text: 'a thought', timestamp: TS }],
    }],
    visible_segments: [{ segment_id: 's1', phase_id: 'r1', text: 'thought through it' }],
  });
  const id = 'phases_reasoning_lifecycle_probe';
  const open = buildMessageProjectionFingerprint(build(id, ''));
  const completed = buildMessageProjectionFingerprint(build(id, TS));
  assert.notEqual(completed, open, 'a reasoning phase completing must invalidate the projection');
});

/* ── inertness ─────────────────────────────────────────────────────────────
 * Both fields are absent from the overwhelming majority of messages. The
 * id-keyed equal-state reuse in resolveMessageFingerprint is what lets a
 * rehydrate keep its projection caches, so a field that is not byte-inert when
 * unset would silently disable that reuse for every plain message. */

test('messages carrying neither field still share their projection fingerprint', () => {
  const id = 'parity_inert_probe';
  const plain = () => ({
    id,
    role: 'assistant',
    kind: '',
    status: 'complete',
    content: 'a settled reply',
    timestamp: TS,
    updatedAt: TS,
    finalizedAt: TS,
    attachments: [],
    visible_segments: [{ segment_id: 's1', text: 'a settled reply' }],
    tool_steps: [],
    reasoning: { entries: [] },
    reasoning_phases: [],
  });
  assert.equal(
    buildMessageProjectionFingerprint(plain()),
    buildMessageProjectionFingerprint(plain()),
    'an equal-state replacement with no recap and no phases must still reuse its token'
  );
});
