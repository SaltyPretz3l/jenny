'use strict';
/**
 * Dedicated behavioral tests for services/backend/message-normalization.js.
 * Targets uncovered guard/edge branches. One behavior per test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeQuestionBatchContinuationToken,
  normalizePendingQuestionBatch,
  normalizePendingPlanProposal,
  normalizeInteractiveRoundRecap,
  normalizeToolCallMetadata,
  normalizeToolResultMetadata,
  normalizeTranscriptPhase,
  normalizeVisibleSegment,
  normalizeToolStep,
  normalizeProactiveSuggestionMetadata,
  normalizeSkillInvocationMetadata,
  normalizeMessageFields,
  normalizeTurnEvent,
  flattenReasoningEntriesFromPhases,
} = require('../services/backend/message-normalization');

test('skill invocation metadata round-trips only its four string fields', () => {
  const source = {
    id: 'bundled/humanizer', name: 'Humanizer', scope: 'bundled',
    command: 'humanize', body: 'must not persist',
  };
  const expected = {
    id: 'bundled/humanizer', name: 'Humanizer', scope: 'bundled', command: 'humanize',
  };
  assert.deepEqual(normalizeSkillInvocationMetadata(source), expected);
  assert.deepEqual(normalizeMessageFields({ role: 'user', skill_invocation: source }).skill_invocation, expected);
});

test('skill invocation metadata drops malformed shapes', () => {
  for (const value of [null, [], { id: 'bundled/x' }, {
    id: 'bundled/x', name: 'X', scope: 'bundled', command: 42,
  }]) {
    assert.equal(normalizeSkillInvocationMetadata(value), null);
    assert.equal(normalizeMessageFields({ role: 'user', skill_invocation: value }).skill_invocation, null);
  }
});

function makeContinuationToken(overrides = {}) {
  return {
    token_id: 'token-1',
    session_id: 'session-1',
    session_incarnation: 'incarnation-1',
    batch_id: 'batch-token',
    prior_generation: 2,
    consumed: false,
    issued_at: '2026-07-13T10:00:00.000Z',
    ...overrides,
  };
}

/* ---- normalizePendingQuestionBatch ---- */

// Lines 100-102: a question entry that is null is filtered out
test('normalizePendingQuestionBatch: null question entry is filtered, valid ones pass', () => {
  const result = normalizePendingQuestionBatch({
    batch_id: 'batch-example-1',
    questions: [
      null,
      {
        id: 'q1',
        prompt: 'Pick one',
        options: [{ id: 'opt1', label: 'Alpha' }],
      },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].id, 'q1');
});

// Lines 100-102: a question entry that is an array is filtered out
test('normalizePendingQuestionBatch: array question entry is filtered out', () => {
  const result = normalizePendingQuestionBatch({
    batch_id: 'batch-example-2',
    questions: [
      // Carries every field a question needs, so only its array-ness can reject it.
      Object.assign(['not', 'a', 'question'], {
        id: 'array-q', prompt: 'Array-shaped question', options: [{ id: 'array-opt', label: 'Array option' }],
      }),
      {
        id: 'q2',
        prompt: 'Valid?',
        options: [{ id: 'opt2', label: 'Beta' }],
      },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].id, 'q2');
});

// Lines 105-107: question with empty id returns null for that entry
test('normalizePendingQuestionBatch: question with empty id is filtered', () => {
  const result = normalizePendingQuestionBatch({
    batch_id: 'batch-example-3',
    questions: [
      // id is blank -> filtered
      { id: '', prompt: 'Some prompt', options: [{ id: 'opt3', label: 'Gamma' }] },
      // valid question keeps batch alive
      { id: 'q-good', prompt: 'Keep me', options: [{ id: 'opt4', label: 'Delta' }] },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].id, 'q-good');
});

// Lines 105-107: question with empty prompt returns null for that entry
test('normalizePendingQuestionBatch: question with empty prompt is filtered', () => {
  const result = normalizePendingQuestionBatch({
    batch_id: 'batch-example-4',
    questions: [
      { id: 'q-no-prompt', prompt: '', options: [{ id: 'opt5', label: 'Epsilon' }] },
      { id: 'q-ok', prompt: 'Valid prompt', options: [{ id: 'opt6', label: 'Zeta' }] },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].id, 'q-ok');
});

// Lines 112-114: option that is null is skipped (continue branch)
test('normalizePendingQuestionBatch: null option entry is skipped', () => {
  const result = normalizePendingQuestionBatch({
    batch_id: 'batch-example-5',
    questions: [
      {
        id: 'q-null-opt',
        prompt: 'Pick',
        options: [null, { id: 'opt7', label: 'Eta' }],
      },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.questions[0].options.length, 1);
  assert.equal(result.questions[0].options[0].id, 'opt7');
});

// Lines 112-114: option that is an array is skipped (continue branch)
test('normalizePendingQuestionBatch: array option entry is skipped', () => {
  const result = normalizePendingQuestionBatch({
    batch_id: 'batch-example-6',
    questions: [
      {
        id: 'q-arr-opt',
        prompt: 'Pick',
        options: [
          Object.assign(['not', 'valid'], { id: 'array-option', label: 'Array option' }),
          { id: 'opt8', label: 'Theta' },
        ],
      },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.questions[0].options.length, 1);
  assert.equal(result.questions[0].options[0].id, 'opt8');
});

// Lines 126-128: question whose every option is invalid → question returns null
test('normalizePendingQuestionBatch: question with no valid options is filtered', () => {
  // All options are null/invalid, so the question is dropped
  const result = normalizePendingQuestionBatch({
    batch_id: 'batch-example-7',
    questions: [
      { id: 'q-no-opts', prompt: 'No options', options: [null, null] },
      { id: 'q-good2', prompt: 'Has options', options: [{ id: 'opt9', label: 'Iota' }] },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].id, 'q-good2');
});

test('normalizePendingQuestionBatch: preserves a canonical continuation token', () => {
  const result = normalizePendingQuestionBatch({
    batch_id: 'batch-token',
    questions: [{
      id: 'q-token',
      prompt: 'Continue?',
      options: [{ id: 'yes', label: 'Yes' }],
    }],
    continuation_token: makeContinuationToken({
      token_id: ' token-1 ',
      session_id: ' session-1 ',
      session_incarnation: ' incarnation-1 ',
      batch_id: ' batch-token ',
      issued_at: '2026-07-13T05:00:00-05:00',
      ignored: 'not persisted',
    }),
  });

  assert.deepEqual(result.continuation_token, makeContinuationToken());
});

test('normalizeQuestionBatchContinuationToken: rejects malformed identity, generation, state, and timestamp fields', () => {
  const malformedTokens = [
    null,
    // Malformed only by TYPE: an empty array would be rejected for its missing
    // fields too, which proves nothing about the Array.isArray guard.
    Object.assign([], makeContinuationToken()),
    makeContinuationToken({ token_id: 42 }),
    makeContinuationToken({ session_id: '   ' }),
    makeContinuationToken({ session_incarnation: {} }),
    makeContinuationToken({ batch_id: '' }),
    makeContinuationToken({ prior_generation: 0 }),
    makeContinuationToken({ prior_generation: 1.5 }),
    makeContinuationToken({ prior_generation: '2' }),
    makeContinuationToken({ consumed: 0 }),
    makeContinuationToken({ issued_at: 'not-a-timestamp' }),
  ];

  malformedTokens.forEach((token, index) => {
    assert.equal(normalizeQuestionBatchContinuationToken(token), null, `case ${index}`);
  });
});

test('normalizePendingQuestionBatch: drops a continuation token for a different batch', () => {
  const result = normalizePendingQuestionBatch({
    batch_id: 'batch-current',
    questions: [{
      id: 'q-token',
      prompt: 'Continue?',
      options: [{ id: 'yes', label: 'Yes' }],
    }],
    continuation_token: makeContinuationToken({ batch_id: 'batch-other' }),
  });

  assert.equal(result.batch_id, 'batch-current');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'continuation_token'), false);
});

/* ---- normalizePendingPlanProposal ---- */

// Lines 165-167: a step entry that is null is filtered out
test('normalizePendingPlanProposal: null step entry is filtered', () => {
  const result = normalizePendingPlanProposal({
    proposal_id: 'proposal-sample-1',
    title: 'Sample plan',
    steps: [
      null,
      { id: 'step1', label: 'Do thing' },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].id, 'step1');
});

// Lines 165-167: a step entry that is an array is filtered out
test('normalizePendingPlanProposal: array step entry is filtered', () => {
  const result = normalizePendingPlanProposal({
    proposal_id: 'proposal-sample-2',
    title: 'Sample plan 2',
    steps: [
      Object.assign(['not', 'a', 'step'], { id: 'array-step', label: 'Array step' }),
      { id: 'step2', label: 'Valid step' },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].id, 'step2');
});

// Lines 170-172: step with empty label is filtered
test('normalizePendingPlanProposal: step with empty label is filtered', () => {
  const result = normalizePendingPlanProposal({
    proposal_id: 'proposal-sample-3',
    title: 'Sample plan 3',
    steps: [
      { id: 's-no-label', label: '' },
      { id: 's-ok', label: 'Has a label' },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].id, 's-ok');
});

/* ---- normalizeInteractiveRoundRecap ---- */

// Lines 205-207: null item entry is filtered (returns null from map)
test('normalizeInteractiveRoundRecap: null item is filtered out', () => {
  const result = normalizeInteractiveRoundRecap({
    round_index: 1,
    items: [
      null,
      { question_id: 'q1', prompt: 'A question', answer_label: 'Answer A' },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].question_id, 'q1');
});

// Lines 205-207: array item entry is filtered
test('normalizeInteractiveRoundRecap: array item is filtered out', () => {
  const result = normalizeInteractiveRoundRecap({
    round_index: 1,
    items: [
      Object.assign(['arr'], { question_id: 'array-q', prompt: 'Array prompt', answer_label: 'Array answer' }),
      { question_id: 'q2', prompt: 'B question', answer_label: 'Answer B' },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].question_id, 'q2');
});

// Lines 211-213: item missing question_id is filtered
test('normalizeInteractiveRoundRecap: item without question_id is filtered', () => {
  const result = normalizeInteractiveRoundRecap({
    round_index: 1,
    items: [
      { question_id: '', prompt: 'Missing id', answer_label: 'X' },
      { question_id: 'q3', prompt: 'Good item', answer_label: 'Y' },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].question_id, 'q3');
});

// Lines 211-213: item missing answer_label is filtered
test('normalizeInteractiveRoundRecap: item without answer_label is filtered', () => {
  const result = normalizeInteractiveRoundRecap({
    round_index: 1,
    items: [
      { question_id: 'q4', prompt: 'No label', answer_label: '' },
      { question_id: 'q5', prompt: 'OK label', answer_label: 'Z' },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].question_id, 'q5');
});

// Lines 224-225: recap with zero valid items returns null
test('normalizeInteractiveRoundRecap: no valid items returns null', () => {
  const result = normalizeInteractiveRoundRecap({
    round_index: 1,
    items: [
      { question_id: '', prompt: 'Missing id', answer_label: 'X' },
    ],
  });
  assert.equal(result, null);
});

/* ---- normalizeToolCallMetadata ---- */

// Lines 241-243: missing call_id → null
test('normalizeToolCallMetadata: missing call_id returns null', () => {
  const result = normalizeToolCallMetadata({
    call_id: '',
    tool_name: 'SomeTool',
  });
  assert.equal(result, null);
});

// Lines 241-243: missing tool_name → null
test('normalizeToolCallMetadata: missing tool_name returns null', () => {
  const result = normalizeToolCallMetadata({
    call_id: 'call-dummy-1',
    tool_name: '',
  });
  assert.equal(result, null);
});

/* ---- normalizeToolResultMetadata ---- */

// Lines 274-276: missing call_id → null
test('normalizeToolResultMetadata: missing call_id returns null', () => {
  const result = normalizeToolResultMetadata({
    call_id: '',
    tool_name: 'ResultTool',
  });
  assert.equal(result, null);
});

// Lines 274-276: missing tool_name → null
test('normalizeToolResultMetadata: missing tool_name returns null', () => {
  const result = normalizeToolResultMetadata({
    call_id: 'call-dummy-2',
    tool_name: '',
  });
  assert.equal(result, null);
});

/* ---- normalizeIsoTimestamp (via normalizeToolResultMetadata or standalone path) ---- */
// Lines 310-311: invalid date string returns ''
// normalizeIsoTimestamp is not exported directly — reach it via normalizeMessageReactions
// which calls it, OR via normalizeToolResultMetadata which doesn't.
// The simplest path: import the full module and use normalizeMessageReactions.
// Actually normalizeIsoTimestamp is reachable via normalizeMessageReactions — if reaction
// has an invalid updated_at.
{
  const { normalizeMessageReactions } = require('../services/backend/message-normalization');

  // Lines 310-311: invalid date string in reaction updated_at returns ''
  test('normalizeMessageReactions: invalid updated_at date is preserved as empty string', () => {
    const result = normalizeMessageReactions({
      thumbs_up: { selected: true, updated_at: 'not-a-date' },
    });
    assert.equal(result.thumbs_up.selected, true);
    assert.equal(result.thumbs_up.updated_at, '');
  });

  // Lines 310-311: valid ISO date passes through normalizeIsoTimestamp
  test('normalizeMessageReactions: valid ISO updated_at is preserved', () => {
    const result = normalizeMessageReactions({
      saved: { selected: true, updated_at: '2024-01-15T12:00:00.000Z' },
    });
    assert.equal(result.saved.updated_at, '2024-01-15T12:00:00.000Z');
  });
}

/* ---- normalizeExternalPayloadPath (lines 339-340) ---- */
// Reached via normalizeToolCallMetadata with external_payloads
// Lines 339-340: path longer than 512 chars → '' → entry skipped
test('normalizeToolCallMetadata: external payload with overlong path is excluded', () => {
  const longPath = 'a/'.repeat(260); // 520 chars > 512 limit
  const result = normalizeToolCallMetadata({
    call_id: 'call-dummy-3',
    tool_name: 'FileTool',
    external_payloads: {
      output: { path: longPath, root_kind: 'artifact', bytes: 100 },
    },
  });
  assert.ok(result !== null);
  assert.equal(result.external_payloads, undefined);
});

/* ---- normalizeExternalPayloadReferences (lines 360-361) ---- */
// Lines 360-361: entry that is not an object (e.g. null value) is skipped
test('normalizeToolCallMetadata: external payload entry that is null is skipped', () => {
  const result = normalizeToolCallMetadata({
    call_id: 'call-dummy-4',
    tool_name: 'FileTool2',
    external_payloads: {
      output: null,
    },
  });
  assert.ok(result !== null);
  assert.equal(result.external_payloads, undefined);
});

// Lines 360-361: entry that is an array is skipped
test('normalizeToolCallMetadata: external payload entry that is array is skipped', () => {
  const result = normalizeToolCallMetadata({
    call_id: 'call-dummy-5',
    tool_name: 'FileTool3',
    external_payloads: {
      output: Object.assign(['not', 'an', 'object'], { path: 'artifact.json', byte_length: 12 }),
    },
  });
  assert.ok(result !== null);
  assert.equal(result.external_payloads, undefined);
});

/* ---- normalizeStoredReasoningEntry (reached via flattenReasoningEntriesFromPhases) ---- */

// Lines 380-381: null entry in phase.entries is dropped (normalizeStoredReasoningEntry returns null)
test('normalizeStoredReasoningEntry (via flatten): null entry in phase entries is dropped', () => {
  const phases = [
    {
      phase_kind: 'reasoning',
      entries: [null, { id: 'r-valid', text: 'Valid reasoning', timestamp: '' }],
    },
  ];
  const result = flattenReasoningEntriesFromPhases(phases, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'r-valid');
  assert.equal(result[0].text, 'Valid reasoning');
});

// Lines 380-381: array entry in phase.entries is dropped
test('normalizeStoredReasoningEntry (via flatten): array entry in phase entries is dropped', () => {
  const phases = [
    {
      phase_kind: 'reasoning',
      entries: [
        Object.assign(['not', 'valid'], { id: 'array-reasoning', text: 'Array reasoning', timestamp: '' }),
        { id: 'r-valid2', text: 'Real reasoning', timestamp: '' },
      ],
    },
  ];
  const result = flattenReasoningEntriesFromPhases(phases, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'r-valid2');
});

// Lines 384-385: entry with no text fields is dropped
test('normalizeStoredReasoningEntry (via flatten): entry with no text is dropped', () => {
  const phases = [
    {
      phase_kind: 'reasoning',
      entries: [
        { id: 'r-no-text', timestamp: '2024-01-01' },
        { id: 'r-with-text', text: 'Has content', timestamp: '' },
      ],
    },
  ];
  const result = flattenReasoningEntriesFromPhases(phases, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'r-with-text');
});

/* ---- mergeStoredReasoningEntries (reached via flattenReasoningEntriesFromPhases) ---- */

// Lines 407-408: invalid entry (null) in combined array is skipped
test('mergeStoredReasoningEntries (via flatten): null fallback entry is skipped', () => {
  // Pass a reasoning phase with a valid entry so we have a non-null phase base
  // Then use two phases: both reasoning, one with null entries
  const phases = [
    { phase_kind: 'reasoning', entries: [null] },
  ];
  const fallback = [null, { id: 'r-fallback2', text: 'Fallback valid', timestamp: '' }];
  // No valid entries from phases, so falls back to fallback
  const result = flattenReasoningEntriesFromPhases(phases, fallback);
  // The null in phases and null in fallback should both be skipped
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'r-fallback2');
  assert.equal(result[0].text, 'Fallback valid');
});

// Lines 411-413: entry with duplicate id replaces in place (via normalizeTranscriptPhase entries)
test('mergeStoredReasoningEntries (via flatten): duplicate id entry replaces earlier', () => {
  // Two reasoning phases: first has 'r-dup' with 'Original', second overwrites with 'Updated'
  const phases = [
    {
      phase_kind: 'reasoning',
      entries: [{ id: 'r-dup', text: 'Original', timestamp: '' }],
    },
    {
      phase_kind: 'reasoning',
      entries: [{ id: 'r-dup', text: 'Updated', timestamp: '' }],
    },
  ];
  const result = flattenReasoningEntriesFromPhases(phases, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'r-dup');
  assert.equal(result[0].text, 'Updated');
});

// Lines 421-422: entry with duplicate text+timestamp is dropped (de-dup)
test('mergeStoredReasoningEntries (via flatten): identical text+timestamp duplicate is dropped', () => {
  // Two reasoning phases with same text+timestamp but different ids
  const phases = [
    {
      phase_kind: 'reasoning',
      entries: [{ id: 'r-x1', text: 'Same text', timestamp: '2024-01-01' }],
    },
    {
      phase_kind: 'reasoning',
      entries: [{ id: 'r-x2', text: 'Same text', timestamp: '2024-01-01' }],
    },
  ];
  const result = flattenReasoningEntriesFromPhases(phases, []);
  // r-x2 should be dropped as a content-duplicate of r-x1
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'r-x1');
});

/* ---- normalizeTranscriptPhase ---- */

// Lines 431-432: null input → null
test('normalizeTranscriptPhase: null input returns null', () => {
  const { normalizeTranscriptPhase: normalize } = require('../services/backend/message-normalization');
  const result = normalize(null);
  assert.equal(result, null);
});

// Lines 431-432: array input → null
test('normalizeTranscriptPhase: array input returns null', () => {
  const { normalizeTranscriptPhase: normalize } = require('../services/backend/message-normalization');
  const result = normalize(Object.assign([{ phase_id: 'p1', phase_kind: 'text' }], {
    phase_id: 'array-phase', phase_kind: 'text',
  }));
  assert.equal(result, null);
});

// Lines 435-437: phase with empty phaseKind → null
test('normalizeTranscriptPhase: phase without phase_kind returns null', () => {
  const { normalizeTranscriptPhase: normalize } = require('../services/backend/message-normalization');
  const result = normalize({ phase_id: 'p-sample-1', phase_kind: '' });
  assert.equal(result, null);
});

/* ---- normalizeVisibleSegment ---- */

// Lines 453-455: null input → null
test('normalizeVisibleSegment: null input returns null', () => {
  const result = normalizeVisibleSegment(null);
  assert.equal(result, null);
});

// Lines 453-455: array input → null
test('normalizeVisibleSegment: array input returns null', () => {
  const result = normalizeVisibleSegment(['not', 'a', 'segment']);
  assert.equal(result, null);
});

/* ---- normalizeToolStep ---- */

// Lines 477-479: null input → null
test('normalizeToolStep: null input returns null', () => {
  const result = normalizeToolStep(null);
  assert.equal(result, null);
});

// Lines 477-479: array input → null
test('normalizeToolStep: array input returns null', () => {
  const result = normalizeToolStep(Object.assign([{ call_id: 'c1', tool_name: 'T' }], {
    call_id: 'array-call', tool_name: 'array-tool',
  }));
  assert.equal(result, null);
});

// Lines 483-484: missing call_id → null
test('normalizeToolStep: missing call_id returns null', () => {
  const result = normalizeToolStep({ call_id: '', tool_name: 'SomeTool' });
  assert.equal(result, null);
});

// Lines 483-484: missing tool_name → null
test('normalizeToolStep: missing tool_name returns null', () => {
  const result = normalizeToolStep({ call_id: 'call-sample-1', tool_name: '' });
  assert.equal(result, null);
});

/* ---- normalizeProactiveSuggestionMetadata ---- */

// Lines 527-529 (null/array guard)
test('normalizeProactiveSuggestionMetadata: null input returns null', () => {
  const result = normalizeProactiveSuggestionMetadata(null);
  assert.equal(result, null);
});

// Lines 527-529 (array guard)
test('normalizeProactiveSuggestionMetadata: array input returns null', () => {
  const result = normalizeProactiveSuggestionMetadata(
    Object.assign([{ kind: 'k', title: 't', body: 'b' }], { kind: 'array-kind', title: 'Array title', body: 'Array body' })
  );
  assert.equal(result, null);
});

// Lines 555-556: missing kind → null
test('normalizeProactiveSuggestionMetadata: missing kind returns null', () => {
  const result = normalizeProactiveSuggestionMetadata({
    kind: '',
    title: 'Some title',
    body: 'Some body text',
  });
  assert.equal(result, null);
});

// Lines 555-556: missing title → null
test('normalizeProactiveSuggestionMetadata: missing title returns null', () => {
  const result = normalizeProactiveSuggestionMetadata({
    kind: 'suggestion',
    title: '',
    body: 'Some body text',
  });
  assert.equal(result, null);
});

// Lines 555-556: missing body → null
test('normalizeProactiveSuggestionMetadata: missing body returns null', () => {
  const result = normalizeProactiveSuggestionMetadata({
    kind: 'suggestion',
    title: 'A title',
    body: '',
  });
  assert.equal(result, null);
});

// Positive case: all fields present returns full object
test('normalizeProactiveSuggestionMetadata: valid input returns full object', () => {
  const result = normalizeProactiveSuggestionMetadata({
    id: 'sugg-example-1',
    kind: 'tip',
    title: 'Try this',
    body: 'You can do X',
    promptSuggestion: 'Do X now',
    dedupeKey: 'x-tip',
  });
  assert.ok(result !== null);
  assert.equal(result.kind, 'tip');
  assert.equal(result.title, 'Try this');
  assert.equal(result.body, 'You can do X');
  assert.equal(result.promptSuggestion, 'Do X now');
  assert.equal(result.dedupeKey, 'x-tip');
});

/* ---- normalizeTurnEvent ---- */

// Lines 575-577: null input → null
test('normalizeTurnEvent: null input returns null', () => {
  const result = normalizeTurnEvent(null);
  assert.equal(result, null);
});

// Lines 575-577: array input → null
test('normalizeTurnEvent: array input returns null', () => {
  const result = normalizeTurnEvent(Object.assign([{ turn_id: 't1', kind: 'text' }], {
    turn_id: 'array-turn', kind: 'text',
  }));
  assert.equal(result, null);
});

// Lines 575-577: missing turn_id → null
test('normalizeTurnEvent: missing turn_id returns null', () => {
  const result = normalizeTurnEvent({ turn_id: '', kind: 'text' });
  assert.equal(result, null);
});

// Lines 575-577: missing kind → null
test('normalizeTurnEvent: missing kind returns null', () => {
  const result = normalizeTurnEvent({ turn_id: 'turn-sample-1', kind: '' });
  assert.equal(result, null);
});

// Positive: valid turn event returns normalized object with expected shape
test('normalizeTurnEvent: valid input returns structured event object', () => {
  const result = normalizeTurnEvent({
    turn_id: 'turn-abc-1',
    kind: 'TextChunk',
    event_id: 'evt-abc-1',
    status: 'completed',
    event_seq: 0,
  });
  assert.ok(result !== null);
  assert.equal(result.turn_id, 'turn-abc-1');
  assert.equal(result.kind, 'textchunk');
  assert.equal(result.event_id, 'evt-abc-1');
  assert.equal(result.event_seq, 0);
  assert.equal(result.status, 'completed');
});

/* ---- flattenReasoningEntriesFromPhases (secondary coverage) ---- */

// Phases with non-reasoning kind are skipped; only reasoning phases contribute entries
test('flattenReasoningEntriesFromPhases: only reasoning phase entries are used', () => {
  const phases = [
    {
      phase_kind: 'text',
      entries: [{ id: 'r-text', text: 'Text phase entry', timestamp: '' }],
    },
    {
      phase_kind: 'reasoning',
      entries: [{ id: 'r-reason', text: 'Reasoning entry', timestamp: '' }],
    },
  ];
  const result = flattenReasoningEntriesFromPhases(phases, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'r-reason');
  assert.equal(result[0].text, 'Reasoning entry');
});

// When no reasoning phases have entries, fallback entries are used
test('flattenReasoningEntriesFromPhases: falls back to fallback entries when no reasoning phases', () => {
  const phases = [
    { phase_kind: 'text', entries: [{ id: 'r-txt2', text: 'Text only', timestamp: '' }] },
  ];
  const fallback = [{ id: 'r-fallback', text: 'Fallback entry', timestamp: '' }];
  const result = flattenReasoningEntriesFromPhases(phases, fallback);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'r-fallback');
  assert.equal(result[0].text, 'Fallback entry');
});
