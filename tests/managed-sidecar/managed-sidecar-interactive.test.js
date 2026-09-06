const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const {
  waitForChatStreamEvent,
  createManagedService,
} = require('../helpers/managed-sidecar-runtime-helpers');
const {
  collectServiceLogs,
  buildInteractiveAnswer,
  buildInteractiveAnswers,
} = require('../helpers/backend-service-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar runtime emits interactive question batches and persists pending batch state', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-interactive-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const questionBatch = waitForChatStreamEvent(service, (event) => event.type === 'question_batch');
  const stream = await service.startChatStream({
    prompt: 'Help me think this through; ask me what you need',
  });

  const batchEvent = await questionBatch;
  assert.equal(batchEvent.streamId, stream.streamId);
  assert.equal(batchEvent.sessionId, stream.sessionId);
  assert.equal(batchEvent.batch.batch_id, 'ib_1');
  assert.equal(batchEvent.batch.questions.length, 1);

  const session = (await service.listSessions()).data.find((entry) => entry.id === stream.sessionId);
  assert.ok(session);
  assert.equal(session.conversation_mode, 'chat');
  assert.equal(session.pending_question_batch.batch_id, 'ib_1');
  assert.equal(session.interactive_sequence_state, 'structured_active');
  assert.equal(session.interactive_round_count, 1);

  const messages = await service.getSessionMessages(stream.sessionId);
  assert.equal(messages.data.at(-1).kind, 'question_batch');
  assert.equal(messages.data.at(-1).interactive_batch.batch_id, 'ib_1');
  assert.equal(
    messages.data.at(-1).content,
    [
      'Jenny asked follow-up questions:',
      'A couple quick questions so I can help better.',
      '',
      '1. What kind of pace feels right?',
      'Options: Steady / Fast',
    ].join('\n')
  );

  await service.stop();
});

test('managed sidecar runtime accepts a question batch appended after a completed text answer', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-interactive-post-answer-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  const serviceLogs = collectServiceLogs(service);
  const chatStreamEvents = [];
  service.on('chat-stream', (event) => chatStreamEvents.push(event));
  await service.start();

  const completion = waitForChatStreamEvent(service, (event) => event.type === 'complete');
  const stream = await service.startChatStream({
    prompt: 'Post-answer question batch; ask me what you need',
  });
  const controller = service.activeStreams.get(stream.streamId);
  const completed = await completion;
  if (controller) {
    await controller._pendingPromise;
  }

  assert.equal(completed.content, 'Here is a direct answer before follow-up questions.');
  assert.equal(
    JSON.stringify(serviceLogs).includes('CMP-INTERACTIVE-0001'),
    false,
    'CMP-INTERACTIVE-0001 must not reject a post-answer question batch'
  );

  const batchEvent = chatStreamEvents.find(
    (event) => event.type === 'question_batch' && event.streamId === stream.streamId
  );
  assert.ok(batchEvent);

  const session = (await service.listSessions()).data.find((entry) => entry.id === stream.sessionId);
  assert.ok(session);
  assert.equal(session.pending_question_batch.batch_id, batchEvent.batch.batch_id);

  const messages = await service.getSessionMessages(stream.sessionId);
  assert.ok(
    messages.data.some(
      (message) => message.role === 'assistant'
        && message.content === 'Here is a direct answer before follow-up questions.'
    )
  );
  assert.ok(
    chatStreamEvents.some(
      (event) => event.type === 'question_batch'
        && event.streamId === stream.streamId
        && event.batch.batch_id === batchEvent.batch.batch_id
    )
  );

  await service.stop();
});

test('managed sidecar runtime does not retitle existing sessions from question batches', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-interactive-title-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const session = await service.createSession({
    title: 'Existing Title',
  });
  const questionBatch = waitForChatStreamEvent(service, (event) => event.type === 'question_batch');

  await service.startChatStream({
    sessionId: session.data.id,
    prompt: 'Do not title from this prompt; ask me what you need',
  });
  await questionBatch;

  const merged = (await service.listSessions()).data.find((entry) => entry.id === session.data.id);
  assert.ok(merged);
  assert.equal(merged.title, 'Existing Title');

  await service.stop();
});

test('managed sidecar runtime submits interactive answers and clears pending batch state', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-interactive-answer-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const firstBatch = waitForChatStreamEvent(service, (event) => event.type === 'question_batch');
  const firstStream = await service.startChatStream({
    prompt: 'Coach me through this; ask me what you need',
  });
  const batchEvent = await firstBatch;

  const completion = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete' && event.sessionId === firstStream.sessionId
  );
  const secondStream = await service.startChatStream({
    sessionId: firstStream.sessionId,
    prompt: 'Steady',
    interactiveResponse: buildInteractiveAnswer(batchEvent.batch, 'steady'),
    interactiveRoundCount: batchEvent.batch.round_index,
  });
  const controller = service.activeStreams.get(secondStream.streamId);
  const completed = await completion;
  if (controller) {
    await controller._pendingPromise;
  }

  assert.match(completed.content, /Thanks for clarifying/i);

  const session = (await service.listSessions()).data.find((entry) => entry.id === firstStream.sessionId);
  assert.ok(session);
  assert.equal(session.pending_question_batch, null);
  assert.equal(session.interactive_sequence_state, 'idle');
  assert.equal(session.interactive_round_count, 0);

  const messages = await service.getSessionMessages(firstStream.sessionId);
  assert.equal(messages.data.at(-1).kind, 'interactive_round_recap');
  assert.equal(messages.data.at(-1).interactive_round_recap.answer_count, 1);
  assert.equal(messages.data.at(-1).interactive_round_recap.items[0].answer_label, 'Steady');

  await service.stop();
});

test('managed sidecar runtime preserves multi-question interactive answers in the recap', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-interactive-multi-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const questionBatch = waitForChatStreamEvent(service, (event) => event.type === 'question_batch');
  const firstStream = await service.startChatStream({
    prompt: 'Need a multi step plan; ask me what you need',
  });
  const batchEvent = await questionBatch;

  assert.equal(batchEvent.batch.questions.length, 3);

  const completion = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete' && event.sessionId === firstStream.sessionId
  );
  const secondStream = await service.startChatStream({
    sessionId: firstStream.sessionId,
    prompt: 'Steady\nStakeholder alignment\nCollaborative',
    interactiveResponse: buildInteractiveAnswers(batchEvent.batch, {
      q1: 'steady',
      q2: { option_id: '', text: 'Stakeholder alignment' },
      q3: 'collaborative',
    }),
    interactiveRoundCount: batchEvent.batch.round_index,
  });
  const controller = service.activeStreams.get(secondStream.streamId);
  await completion;
  if (controller) {
    await controller._pendingPromise;
  }

  const messages = await service.getSessionMessages(firstStream.sessionId);
  assert.equal(messages.data.at(-1).kind, 'interactive_round_recap');
  assert.equal(messages.data.at(-1).interactive_round_recap.answer_count, 3);
  const questionBatchMessage = messages.data.find((message) => message.kind === 'question_batch');
  assert.match(questionBatchMessage.content, /What should I optimize for first\?/);
  assert.match(questionBatchMessage.content, /Options: Clarity \/ Speed \/ Other/);
  assert.deepEqual(messages.data.at(-1).interactive_round_recap.items.map((item) => item.answer_label), [
    'Steady',
    'Stakeholder alignment',
    'Collaborative',
  ]);

  await service.stop();
});

test('managed sidecar runtime completes plain-text follow-up questions without retired drift flags', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-interactive-drift-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const completion = waitForChatStreamEvent(service, (event) => event.type === 'complete');
  await service.startChatStream({
    prompt: 'Trigger drift; ask me anything',
  });
  const completed = await completion;

  assert.equal(completed.interactiveProtocolDrift, undefined, 'drift detection retired with unified conversation mode');
  assert.match(completed.content, /\?$/);

  await service.stop();
});

test('managed sidecar runtime marks fallback_requested when a batch exceeds the round cap', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-interactive-guardrail-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const questionBatch = waitForChatStreamEvent(service, (event) => event.type === 'question_batch');
  const stream = await service.startChatStream({
    prompt: 'Help me think this through; ask me what you need',
    interactiveRoundCount: 3,
  });
  const batchEvent = await questionBatch;

  assert.equal(batchEvent.streamId, stream.streamId);
  assert.equal(batchEvent.batch.round_index, 4);

  const session = (await service.listSessions()).data.find((entry) => entry.id === stream.sessionId);
  assert.ok(session);
  assert.equal(session.conversation_mode, 'chat');
  assert.equal(session.pending_question_batch.batch_id, batchEvent.batch.batch_id);
  assert.equal(
    session.pending_question_batch.continuation_token.token_id,
    batchEvent.batch.continuation_token.token_id
  );
  assert.equal(session.interactive_sequence_state, 'fallback_requested');
  assert.equal(session.interactive_round_count, 4);

  await service.stop();
});

test('managed sidecar runtime resets interactive state on planner fallback to completed', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-interactive-fallback-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const completion = waitForChatStreamEvent(service, (event) => event.type === 'complete');
  const stream = await service.startChatStream({
    prompt: 'Trigger planner fallback; ask me anything',
  });
  const completed = await completion;

  assert.equal(completed.sessionId, stream.sessionId);
  assert.match(completed.content, /planner fallback/i);

  const session = (await service.listSessions()).data.find((entry) => entry.id === stream.sessionId);
  assert.ok(session);
  assert.equal(session.conversation_mode, 'chat');
  assert.equal(session.pending_question_batch, null);
  assert.equal(session.interactive_sequence_state, 'idle');
  assert.equal(session.interactive_round_count, 0);

  await service.stop();
});
