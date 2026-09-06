'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeInteractiveResponse,
  buildInteractiveQuestionBatchSummary,
  buildInteractiveQuestionBatchTranscript,
  buildInteractiveQuestionBatchVisibleText,
  buildInteractiveRoundRecap,
  buildInteractiveRoundRecapTranscript,
  buildAutomaticSessionTitleCandidate,
  shouldApplyAutomaticSessionTitle,
  isDefaultSessionTitle,
  hasValidInteractiveQuestionCount,
  clipTitle,
} = require('../services/backend/interactive-session-utils');

// ---------------------------------------------------------------------------
// Helpers: batch/response builders
// ---------------------------------------------------------------------------

function makeBatch({ batchId = 'batch-1', roundIndex = 1, introText = '', questions } = {}) {
  return {
    batch_id: batchId,
    round_index: roundIndex,
    intro_text: introText,
    questions: questions || [
      {
        id: 'q1',
        prompt: 'What is your goal?',
        options: [
          { id: 'o1', label: 'Speed' },
          { id: 'o2', label: 'Quality' },
        ],
      },
    ],
  };
}

function makeContinuationToken(overrides = {}) {
  return {
    token_id: 'token-1',
    session_id: 'session-1',
    session_incarnation: 'incarnation-1',
    batch_id: 'batch-1',
    prior_generation: 3,
    consumed: false,
    issued_at: '2026-07-13T10:00:00.000Z',
    ...overrides,
  };
}

function makeResponse({ batchId, batchSnapshot, roundIndex, disposition = 'answered', answers } = {}) {
  const snapshot = batchSnapshot || makeBatch({ batchId: batchId || 'batch-1', roundIndex: roundIndex || 1 });
  return {
    batch_id: snapshot.batch_id,
    batch_snapshot: snapshot,
    round_index: roundIndex || 1,
    disposition,
    answers: answers || [
      { question_id: 'q1', option_id: 'o1', text: '' },
    ],
  };
}

// ---------------------------------------------------------------------------
// normalizeInteractiveResponse
// ---------------------------------------------------------------------------

test('normalizeInteractiveResponse: valid response returns normalized shape', () => {
  const input = makeResponse();
  const result = normalizeInteractiveResponse(input);
  assert.ok(result !== null, 'must return non-null');
  assert.equal(result.batch_id, 'batch-1');
  assert.ok(result.round_index >= 1, 'round_index must be >= 1');
  assert.equal(result.disposition, 'answered');
  assert.ok(Array.isArray(result.answers));
  assert.equal(result.answers.length, 1);
  assert.equal(result.answers[0].question_id, 'q1');
  assert.equal(result.answers[0].option_id, 'o1');
  assert.ok(result.batch_snapshot !== null);
  assert.equal(result.batch_snapshot.batch_id, 'batch-1');
});

test('normalizeInteractiveResponse: missing batch_snapshot returns null', () => {
  const input = { batch_id: 'batch-1', round_index: 1, disposition: 'answered', answers: [] };
  const result = normalizeInteractiveResponse(input);
  assert.equal(result, null);
});

test('normalizeInteractiveResponse: missing batch_id and no batch_snapshot.batch_id returns null', () => {
  const batchWithoutId = {
    round_index: 1,
    questions: [{ id: 'q1', prompt: 'X?', options: [{ id: 'o1', label: 'Yes' }] }],
  };
  const input = { batch_snapshot: batchWithoutId, disposition: 'answered', answers: [] };
  const result = normalizeInteractiveResponse(input);
  assert.equal(result, null, 'missing batch_id must return null');
});

test('normalizeInteractiveResponse: disposition skipped -> skipped', () => {
  const input = makeResponse({ disposition: 'skipped' });
  const result = normalizeInteractiveResponse(input);
  assert.ok(result !== null);
  assert.equal(result.disposition, 'skipped');
});

test('normalizeInteractiveResponse: non-object returns null', () => {
  assert.equal(normalizeInteractiveResponse(null), null);
  assert.equal(normalizeInteractiveResponse('string'), null);
  assert.equal(normalizeInteractiveResponse([]), null);
});

test('normalizeInteractiveResponse: round_index is at least 1', () => {
  const input = makeResponse({ roundIndex: 3 });
  const result = normalizeInteractiveResponse(input);
  assert.equal(result.round_index, 3);
});

test('normalizeInteractiveResponse: preserves a canonical top-level continuation token', () => {
  const input = {
    ...makeResponse(),
    continuation_token: makeContinuationToken({
      token_id: ' token-1 ',
      issued_at: '2026-07-13T05:00:00-05:00',
    }),
  };

  const result = normalizeInteractiveResponse(input);

  assert.deepEqual(result.continuation_token, makeContinuationToken());
});

test('normalizeInteractiveResponse: sources the top-level token from the normalized batch snapshot', () => {
  const batchSnapshot = {
    ...makeBatch(),
    continuation_token: makeContinuationToken(),
  };

  const result = normalizeInteractiveResponse(makeResponse({ batchSnapshot }));

  assert.deepEqual(result.continuation_token, makeContinuationToken());
  assert.deepEqual(result.batch_snapshot.continuation_token, makeContinuationToken());
});

test('normalizeInteractiveResponse: omits a continuation token that does not match the response batch', () => {
  const result = normalizeInteractiveResponse({
    ...makeResponse(),
    continuation_token: makeContinuationToken({ batch_id: 'batch-other' }),
  });

  assert.ok(result !== null);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'continuation_token'), false);
});

// ---------------------------------------------------------------------------
// buildInteractiveQuestionBatchSummary
// ---------------------------------------------------------------------------

test('buildInteractiveQuestionBatchSummary: numbered lines with options in parens', () => {
  const batch = makeBatch();
  const result = buildInteractiveQuestionBatchSummary(batch);
  assert.ok(result.includes('1. What is your goal?'), 'must include numbered question');
  assert.ok(result.includes('(Speed / Quality)'), 'must include options in parens');
});

test('buildInteractiveQuestionBatchSummary: includes intro_text when present', () => {
  const batch = makeBatch({ introText: 'Please answer:' });
  const result = buildInteractiveQuestionBatchSummary(batch);
  assert.ok(result.startsWith('Please answer:'), 'intro_text must be first');
  assert.ok(result.includes('1. What is your goal?'));
});

test('buildInteractiveQuestionBatchSummary: no intro_text -> starts with numbered question', () => {
  const batch = makeBatch({ introText: '' });
  const result = buildInteractiveQuestionBatchSummary(batch);
  assert.ok(result.startsWith('1.'), 'must start with numbered question when no intro');
});

test('buildInteractiveQuestionBatchSummary: invalid batch returns empty string', () => {
  assert.equal(buildInteractiveQuestionBatchSummary(null), '');
  assert.equal(buildInteractiveQuestionBatchSummary('not-a-batch'), '');
});

test('buildInteractiveQuestionBatchSummary: multiple questions numbered correctly', () => {
  const batch = makeBatch({
    questions: [
      { id: 'q1', prompt: 'First?', options: [{ id: 'o1', label: 'A' }] },
      { id: 'q2', prompt: 'Second?', options: [{ id: 'o2', label: 'B' }] },
    ],
  });
  const result = buildInteractiveQuestionBatchSummary(batch);
  assert.ok(result.includes('1. First?'));
  assert.ok(result.includes('2. Second?'));
});

// ---------------------------------------------------------------------------
// buildInteractiveQuestionBatchTranscript
// ---------------------------------------------------------------------------

test('buildInteractiveQuestionBatchTranscript: starts with header, contains question and Options:', () => {
  const batch = makeBatch();
  const result = buildInteractiveQuestionBatchTranscript(batch);
  assert.ok(result.startsWith('Jenny asked follow-up questions:'), 'must start with transcript header');
  assert.ok(result.includes('1. What is your goal?'), 'must include numbered question');
  assert.ok(result.includes('Options: Speed / Quality'), 'must include Options: line');
});

test('buildInteractiveQuestionBatchTranscript: includes intro_text', () => {
  const batch = makeBatch({ introText: 'Some context:' });
  const result = buildInteractiveQuestionBatchTranscript(batch);
  assert.ok(result.includes('Some context:'), 'must include intro_text');
});

test('buildInteractiveQuestionBatchTranscript: invalid batch -> empty string', () => {
  assert.equal(buildInteractiveQuestionBatchTranscript(null), '');
});

// ---------------------------------------------------------------------------
// buildInteractiveQuestionBatchVisibleText (delegates to Transcript)
// ---------------------------------------------------------------------------

test('buildInteractiveQuestionBatchVisibleText: output equals Transcript output', () => {
  const batch = makeBatch({ introText: 'Intro text here' });
  const transcript = buildInteractiveQuestionBatchTranscript(batch);
  const visible = buildInteractiveQuestionBatchVisibleText(batch);
  assert.equal(visible, transcript, 'VisibleText must delegate to Transcript exactly');
});

// ---------------------------------------------------------------------------
// buildInteractiveRoundRecap
// ---------------------------------------------------------------------------

test('buildInteractiveRoundRecap: answered with resolvable answer -> valid recap shape', () => {
  const input = makeResponse({
    roundIndex: 2,
    answers: [{ question_id: 'q1', option_id: 'o1', text: '' }],
  });
  const result = buildInteractiveRoundRecap(input);
  assert.ok(result !== null, 'must return non-null');
  assert.equal(result.round_index, 2);
  assert.equal(result.answer_count, 1);
  assert.equal(result.collapsed, false);
  assert.ok(Array.isArray(result.items));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].question_id, 'q1');
  assert.equal(result.items[0].prompt, 'What is your goal?');
  assert.equal(result.items[0].answer_label, 'Speed');
});

test('buildInteractiveRoundRecap: disposition skipped -> null', () => {
  const input = makeResponse({ disposition: 'skipped' });
  const result = buildInteractiveRoundRecap(input);
  assert.equal(result, null);
});

test('buildInteractiveRoundRecap: no resolvable items -> null', () => {
  const input = makeResponse({
    answers: [{ question_id: 'q1', option_id: 'nonexistent', text: '' }],
  });
  const result = buildInteractiveRoundRecap(input);
  assert.equal(result, null);
});

test('buildInteractiveRoundRecap: invalid response -> null', () => {
  assert.equal(buildInteractiveRoundRecap(null), null);
});

// ---------------------------------------------------------------------------
// buildInteractiveRoundRecapTranscript
// ---------------------------------------------------------------------------

test('buildInteractiveRoundRecapTranscript: valid recap produces transcript', () => {
  const recap = {
    round_index: 1,
    answer_count: 1,
    items: [{ question_id: 'q1', prompt: 'What is your goal?', answer_label: 'Speed' }],
    collapsed: false,
  };
  const result = buildInteractiveRoundRecapTranscript(recap);
  assert.ok(result.startsWith("User answered Jenny's follow-up questions:"), 'must start with recap header');
  assert.ok(result.includes('- What is your goal?: Speed'), 'must include the qa pair');
});

test('buildInteractiveRoundRecapTranscript: invalid recap -> empty string', () => {
  const result = buildInteractiveRoundRecapTranscript(null);
  assert.equal(result, '');
});

test('buildInteractiveRoundRecapTranscript: recap from buildInteractiveRoundRecap round-trip', () => {
  const input = makeResponse({
    roundIndex: 1,
    answers: [{ question_id: 'q1', option_id: 'o2', text: '' }],
  });
  const recap = buildInteractiveRoundRecap(input);
  assert.ok(recap !== null);
  const transcript = buildInteractiveRoundRecapTranscript(recap);
  assert.ok(transcript.includes('- What is your goal?: Quality'), 'must resolve to o2 label Quality');
});

// ---------------------------------------------------------------------------
// buildAutomaticSessionTitleCandidate
// ---------------------------------------------------------------------------

test('buildAutomaticSessionTitleCandidate: no interactiveResponse + prompt -> clipTitle(prompt)', () => {
  const result = buildAutomaticSessionTitleCandidate('Tell me about cats', null);
  assert.equal(result, 'Tell me about cats');
});

test('buildAutomaticSessionTitleCandidate: with interactiveResponse -> empty string', () => {
  const response = makeResponse();
  const normalized = normalizeInteractiveResponse(response);
  const result = buildAutomaticSessionTitleCandidate('Some prompt', normalized);
  assert.equal(result, '');
});

test('buildAutomaticSessionTitleCandidate: empty prompt + no response -> empty string (not New Chat)', () => {
  // The function returns '' when promptText is empty, even without interactiveResponse
  const result = buildAutomaticSessionTitleCandidate('', null);
  assert.equal(result, '');
});

test('buildAutomaticSessionTitleCandidate: long prompt gets clipped to 80 chars', () => {
  const longPrompt = 'A'.repeat(100);
  const result = buildAutomaticSessionTitleCandidate(longPrompt, null);
  assert.equal(result.length, 80);
  assert.equal(result, 'A'.repeat(80));
});

// ---------------------------------------------------------------------------
// shouldApplyAutomaticSessionTitle
// ---------------------------------------------------------------------------

test('shouldApplyAutomaticSessionTitle: true when candidate, default title, empty session', () => {
  const session = { title: 'New Chat', message_count: 0 };
  assert.equal(shouldApplyAutomaticSessionTitle(session, 'My title'), true);
});

test('shouldApplyAutomaticSessionTitle: false when title is non-default', () => {
  const session = { title: 'Real Title', message_count: 0 };
  assert.equal(shouldApplyAutomaticSessionTitle(session, 'My title'), false);
});

test('shouldApplyAutomaticSessionTitle: false when candidate is empty', () => {
  const session = { title: 'New Chat', message_count: 0 };
  assert.equal(shouldApplyAutomaticSessionTitle(session, ''), false);
});

test('shouldApplyAutomaticSessionTitle: false when message_count > 0', () => {
  const session = { title: 'New Chat', message_count: 3 };
  assert.equal(shouldApplyAutomaticSessionTitle(session, 'My title'), false);
});

test('shouldApplyAutomaticSessionTitle: true when title is empty string (default)', () => {
  const session = { title: '', message_count: 0 };
  assert.equal(shouldApplyAutomaticSessionTitle(session, 'Some title'), true);
});

// ---------------------------------------------------------------------------
// isDefaultSessionTitle
// ---------------------------------------------------------------------------

test('isDefaultSessionTitle: empty string -> true', () => {
  assert.equal(isDefaultSessionTitle(''), true);
});

test('isDefaultSessionTitle: "New Chat" -> true', () => {
  assert.equal(isDefaultSessionTitle('New Chat'), true);
});

test('isDefaultSessionTitle: real title -> false', () => {
  assert.equal(isDefaultSessionTitle('My Conversation'), false);
});

test('isDefaultSessionTitle: null -> true (falsy coerces to empty)', () => {
  assert.equal(isDefaultSessionTitle(null), true);
});

test('isDefaultSessionTitle: whitespace only -> true (trims to empty)', () => {
  assert.equal(isDefaultSessionTitle('   '), true);
});

// ---------------------------------------------------------------------------
// isEmptySessionSummary (not exported; tested via shouldApplyAutomaticSessionTitle)
// shouldApplyAutomaticSessionTitle returns true iff: candidate truthy,
// isDefaultSessionTitle(title), isEmptySessionSummary(session).
// So fixing candidate='X' and title='New Chat' isolates isEmptySessionSummary.
// ---------------------------------------------------------------------------

test('isEmptySessionSummary indirectly: message_count 0 -> session treated as empty (should apply)', () => {
  const session = { title: 'New Chat', message_count: 0 };
  assert.equal(shouldApplyAutomaticSessionTitle(session, 'X'), true);
});

test('isEmptySessionSummary indirectly: message_count > 0 -> session not empty (should not apply)', () => {
  const session1 = { title: 'New Chat', message_count: 1 };
  assert.equal(shouldApplyAutomaticSessionTitle(session1, 'X'), false);
  const session5 = { title: 'New Chat', message_count: 5 };
  assert.equal(shouldApplyAutomaticSessionTitle(session5, 'X'), false);
});

test('isEmptySessionSummary indirectly: null session -> treated as non-empty (should not apply)', () => {
  assert.equal(shouldApplyAutomaticSessionTitle(null, 'X'), false);
});

test('isEmptySessionSummary indirectly: missing message_count -> defaults to 0 (empty, should apply)', () => {
  const session = { title: 'New Chat' };
  assert.equal(shouldApplyAutomaticSessionTitle(session, 'X'), true);
});

// ---------------------------------------------------------------------------
// hasValidInteractiveQuestionCount
// ---------------------------------------------------------------------------

test('hasValidInteractiveQuestionCount: 1 question -> true', () => {
  const batch = makeBatch({
    questions: [
      { id: 'q1', prompt: 'One?', options: [{ id: 'o1', label: 'Yes' }] },
    ],
  });
  assert.equal(hasValidInteractiveQuestionCount(batch), true);
});

test('hasValidInteractiveQuestionCount: 5 questions -> true (at MAX)', () => {
  const questions = Array.from({ length: 5 }, (_, i) => ({
    id: `q${i + 1}`,
    prompt: `Question ${i + 1}?`,
    options: [{ id: `o${i + 1}`, label: `Option ${i + 1}` }],
  }));
  const batch = makeBatch({ questions });
  assert.equal(hasValidInteractiveQuestionCount(batch), true);
});

test('hasValidInteractiveQuestionCount: 0 questions -> false', () => {
  // A batch with no valid questions: normalizePendingQuestionBatch returns null
  assert.equal(hasValidInteractiveQuestionCount(null), false);
});

test('hasValidInteractiveQuestionCount: 6 questions -> false (exceeds MAX_INTERACTIVE_QUESTIONS=5)', () => {
  const questions = Array.from({ length: 6 }, (_, i) => ({
    id: `q${i + 1}`,
    prompt: `Question ${i + 1}?`,
    options: [{ id: `o${i + 1}`, label: `Option ${i + 1}` }],
  }));
  const batch = makeBatch({ questions });
  // normalizePendingQuestionBatch keeps all 6 questions; but the count check: <= 5
  // Actually normalizePendingQuestionBatch doesn't cap questions, so 6 passes normalize
  // and then hasValidInteractiveQuestionCount returns false because 6 > 5.
  assert.equal(hasValidInteractiveQuestionCount(batch), false);
});

// ---------------------------------------------------------------------------
// clipTitle
// ---------------------------------------------------------------------------

test('clipTitle: > 80 chars gets truncated to exactly 80', () => {
  const input = 'B'.repeat(100);
  const result = clipTitle(input);
  assert.equal(result.length, 80);
  assert.equal(result, 'B'.repeat(80));
});

test('clipTitle: empty string -> "New Chat"', () => {
  assert.equal(clipTitle(''), 'New Chat');
  assert.equal(clipTitle(null), 'New Chat');
});

test('clipTitle: normal title returned as-is', () => {
  assert.equal(clipTitle('Hello World'), 'Hello World');
});

test('clipTitle: exactly 80 chars -> returned unchanged', () => {
  const input = 'C'.repeat(80);
  assert.equal(clipTitle(input), input);
});

// ---------------------------------------------------------------------------
// Edge cases for normalizeInteractiveResponse: batch_id fallback from snapshot
// ---------------------------------------------------------------------------

test('normalizeInteractiveResponse: batch_id taken from batch_snapshot when not provided directly', () => {
  const batchSnapshot = makeBatch({ batchId: 'snapshot-batch' });
  const input = {
    batch_snapshot: batchSnapshot,
    // no top-level batch_id
    round_index: 1,
    disposition: 'answered',
    answers: [{ question_id: 'q1', option_id: 'o1', text: '' }],
  };
  const result = normalizeInteractiveResponse(input);
  assert.ok(result !== null);
  assert.equal(result.batch_id, 'snapshot-batch');
});

test('normalizeInteractiveResponse: answers array is normalized (filters invalid entries)', () => {
  const input = makeResponse({
    answers: [
      { question_id: 'q1', option_id: 'o1', text: '' },
      null,
      'bad',
      { question_id: '', option_id: '', text: '' }, // missing questionId => filtered
    ],
  });
  const result = normalizeInteractiveResponse(input);
  assert.ok(result !== null);
  assert.equal(result.answers.length, 1);
});
