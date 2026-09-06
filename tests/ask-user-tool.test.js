'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tool = require('../services/tools/builtin/ask-user-tool');
const { answerUserQuestions, declineUserQuestions } = require('../services/backend/backend-chat-stream');

function buildContext(overrides = {}) {
  const events = [];
  const backendService = {
    currentModel: 'test-model',
    pendingUserQuestions: new Map(),
    emit(name, payload) {
      events.push({ name, payload });
    },
  };
  return {
    context: {
      sessionId: 'session_1',
      streamId: 'stream_1',
      callId: 'call_1',
      backendService,
      ...overrides,
    },
    backendService,
    events,
  };
}

test('normalizeQuestions clamps counts, lengths, options, and duplicate ids', () => {
  const questions = tool.normalizeQuestions({
    questions: Array.from({ length: 6 }, (_, index) => ({
      id: index < 2 ? 'duplicate' : `question_${index}`,
      prompt: `Prompt ${index} ${'p'.repeat(600)}`,
      options: Array.from({ length: 10 }, (__, optionIndex) => (
        `Option ${optionIndex} ${'o'.repeat(150)}`
      )),
      allow_other: index === 0,
      multi_select: index === 1,
    })),
  });

  assert.equal(questions.length, 4);
  assert.equal(questions[0].id, 'duplicate');
  assert.notEqual(questions[1].id, 'duplicate');
  assert.equal(new Set(questions.map((question) => question.id)).size, questions.length);
  assert.ok(questions.every((question) => question.id.length <= tool.LIMITS.id));
  assert.ok(questions.every((question) => question.prompt.length <= tool.LIMITS.prompt));
  assert.ok(questions.every((question) => question.options.length <= tool.LIMITS.options));
  assert.ok(questions.every((question) => (
    question.options.every((option) => option.length <= tool.LIMITS.option)
  )));
  assert.equal(questions[0].allow_other, true);
  assert.equal(questions[1].multi_select, true);
});

test('normalizeQuestions supplies bounded fallback ids and skips unusable questions', () => {
  const questions = tool.normalizeQuestions({
    questions: [
      { id: '', prompt: 'First question' },
      { prompt: 'Second question' },
      { id: 'ignored', prompt: '   ' },
      null,
    ],
  });

  assert.deepEqual(questions.map((question) => question.id), ['q1', 'q2']);
});

test('execute returns a structured failure for a structurally empty payload', async () => {
  const { context } = buildContext();
  const result = await tool.execute({ questions: [{ id: 'empty', prompt: ' ' }] }, context);

  assert.equal(result.isError, true);
  assert.equal(result.metadata.result_kind, 'user_questions');
  assert.match(result.content, /usable question/i);
});

test('execute blocks until answerUserQuestions resolves it and returns clamped answers', async () => {
  const { context, backendService, events } = buildContext();
  let settled = false;
  const pendingResult = tool.execute({
    questions: [{ id: 'choice', prompt: 'Which direction?', options: ['A', 'B'] }],
  }, context).then((result) => {
    settled = true;
    return result;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the tool result must wait for the user response');
  assert.equal(backendService.pendingUserQuestions.size, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'chat-stream');
  assert.equal(events[0].payload.type, 'user_questions_requested');
  assert.equal(events[0].payload.resultKind, 'user_questions');
  assert.equal(events[0].payload.status, 'pending_user_input');
  assert.deepEqual(events[0].payload.input.questions, events[0].payload.questions);

  const [questionRef] = backendService.pendingUserQuestions.keys();
  assert.equal(answerUserQuestions(backendService, questionRef, {
    answers: [{ id: 'choice', value: 'A'.repeat(700) }],
  }), true);

  const result = await pendingResult;
  assert.equal(result.isError, false);
  assert.equal(result.metadata.result_kind, 'user_questions_answered');
  assert.equal(result.metadata.answers[0].value.length, tool.LIMITS.answer);
  assert.match(result.content, /Which direction\?/);
  assert.equal(backendService.pendingUserQuestions.size, 0);
});

test('execute returns a non-error declined result', async () => {
  const { context, backendService } = buildContext();
  const pendingResult = tool.execute({
    questions: [{ id: 'choice', prompt: 'Choose?' }],
  }, context);

  await new Promise((resolve) => setImmediate(resolve));
  const [questionRef] = backendService.pendingUserQuestions.keys();
  assert.equal(declineUserQuestions(backendService, questionRef), true);

  const result = await pendingResult;
  assert.equal(result.isError, false);
  assert.equal(result.content, 'The user declined to answer.');
  assert.deepEqual(result.metadata, { result_kind: 'user_questions_declined' });
});

test('an already-aborted turn declines without emitting a stale question card', async () => {
  const controller = new AbortController();
  controller.abort();
  const { context, backendService, events } = buildContext({ abortSignal: controller.signal });

  const result = await tool.execute({
    questions: [{ id: 'choice', prompt: 'Choose?' }],
  }, context);

  assert.equal(result.isError, false);
  assert.equal(result.metadata.result_kind, 'user_questions_declined');
  assert.equal(backendService.pendingUserQuestions.size, 0);
  assert.deepEqual(events, []);
});

test('multi_select answers remain arrays while single-select arrays collapse', async () => {
  const { context, backendService } = buildContext();
  const pendingResult = tool.execute({
    questions: [
      { id: 'many', prompt: 'Pick several', multi_select: true },
      { id: 'one', prompt: 'Pick one', multi_select: false },
    ],
  }, context);

  await new Promise((resolve) => setImmediate(resolve));
  const [questionRef] = backendService.pendingUserQuestions.keys();
  answerUserQuestions(backendService, questionRef, {
    answers: [
      { id: 'many', value: ['alpha', 'beta'] },
      { id: 'one', value: ['first', 'second'] },
    ],
  });

  const result = await pendingResult;
  assert.deepEqual(result.metadata.answers, [
    { id: 'many', value: ['alpha', 'beta'] },
    { id: 'one', value: 'first' },
  ]);
});

test('unanswered questions render as (no answer) without changing normalized metadata', async () => {
  const { context, backendService } = buildContext();
  const pendingResult = tool.execute({
    questions: [
      { id: 'missing', prompt: 'Missing entry?' },
      { id: 'empty', prompt: 'Empty string?' },
      { id: 'many', prompt: 'Empty multi-select?', multi_select: true },
    ],
  }, context);

  await new Promise((resolve) => setImmediate(resolve));
  const [questionRef] = backendService.pendingUserQuestions.keys();
  answerUserQuestions(backendService, questionRef, {
    answers: [
      { id: 'empty', value: '' },
      { id: 'many', value: [] },
    ],
  });

  const result = await pendingResult;
  assert.equal(result.content, [
    'Q: Missing entry?\nA: (no answer)',
    'Q: Empty string?\nA: (no answer)',
    'Q: Empty multi-select?\nA: (no answer)',
  ].join('\n\n'));
  assert.deepEqual(result.metadata.answers, [
    { id: 'empty', value: '' },
    { id: 'many', value: [] },
  ]);
});
