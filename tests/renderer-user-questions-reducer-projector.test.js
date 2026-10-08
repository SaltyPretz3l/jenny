const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
  reconcileTurnRows,
} = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { projectPersistedEventsWithReducer } = require('../renderer/chat/renderer-stream-rehydrate');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const { JSDOM } = require('jsdom');

function applyPayload(state, payload, context = {}) {
  const ordinal = Number(state.__testOrdinal || 0);
  const events = buildTurnEventFromStreamPayload(payload, {
    turn_id: 'stream-questions',
    primary_user_message_id: 'user-questions',
    primary_assistant_message_id: 'assistant-questions',
    ordinal,
    ...context,
  });
  state.__testOrdinal = ordinal + 1;
  applyTurnStreamEvent(state, events);
  return state.turns_by_id['stream-questions'];
}

test('user questions keep one tool_call identity from pending input through hydrated settlement', () => {
  const state = createTurnReducerState();
  applyPayload(state, { type: 'started', streamId: 'stream-questions' });
  applyPayload(state, {
    type: 'tool_use', streamId: 'stream-questions', callId: 'call-question', toolName: 'ask_user',
    status: 'running', summary: 'Ask user 1 question', input: { questions: [] },
  }, { primary_tool_message_id: 'tool_use_call-question' });
  const pendingTurn = applyPayload(state, {
    type: 'user_questions_requested', streamId: 'stream-questions', callId: 'call-question',
    toolName: 'ask_user', questionRef: 'question-ref',
    questions: [{ id: 'choice', prompt: 'Choose', options: ['A', 'B'], multi_select: false, allow_other: false }],
  }, { primary_tool_message_id: 'tool_use_call-question' });

  const pendingRow = pendingTurn.rows.find((row) => row.kind === 'tool_call');
  assert.equal(pendingRow.payload.state, 'pending_user_input');
  assert.equal(pendingRow.payload.question_ref, 'question-ref');
  assert.equal(pendingRow.payload.user_questions[0].prompt, 'Choose');
  const pendingRowId = pendingRow.row_id;

  const settledTurn = applyPayload(state, {
    type: 'tool_result', streamId: 'stream-questions', callId: 'call-question', toolName: 'ask_user',
    content: 'Q: Choose\nA: A', summary: 'User answered questions', isError: false,
    metadata: { result_kind: 'user_questions_answered', answers: [{ id: 'choice', value: 'A' }] },
  }, { primary_tool_message_id: 'tool_use_call-question', tool_result_message_id: 'tool_result_call-question' });
  const settledRow = settledTurn.rows.find((row) => row.kind === 'tool_call');
  assert.equal(settledRow.payload.state, 'completed');
  assert.equal(settledRow.row_id, pendingRowId);
  assert.equal(settledTurn.rows.filter((row) => row.kind === 'tool_call').length, 1);

  const reconciliation = reconcileTurnRows(settledTurn.rows, projectTurnRows(settledTurn.events));
  assert.deepEqual(reconciliation.staleRows, []);
  const reconciledRow = reconciliation.finalRows.find((row) => row.kind === 'tool_call');
  assert.equal(reconciledRow.row_id, pendingRowId);
  assert.equal(reconciledRow.payload.user_questions_result_kind, 'user_questions_answered');
  assert.deepEqual(reconciledRow.payload.user_questions_answers, [{ id: 'choice', value: 'A' }]);
});

for (const resultKind of ['user_questions_answered', 'user_questions_declined']) {
  test(`reducer reconciliation preserves the structured question receipt (${resultKind})`, (t) => {
    const state = createTurnReducerState();
    applyPayload(state, { type: 'started', streamId: 'stream-questions' });
    applyPayload(state, {
      type: 'tool_use', callId: 'call-question', toolName: 'ask_user', status: 'running', input: {},
    });
    applyPayload(state, {
      type: 'user_questions_requested', callId: 'call-question', toolName: 'ask_user', questionRef: 'question-ref',
      questions: [
        { id: 'single', prompt: 'Pick one', options: ['Alpha'], multi_select: false },
        { id: 'multi', prompt: 'Pick many', options: ['One', 'Two'], multi_select: true },
      ],
    });
    const answers = [{ id: 'single', value: 'Alpha' }, { id: 'multi', value: ['One', 'Two'], other: 'note' }];
    const turn = applyPayload(state, {
      type: 'tool_result', callId: 'call-question', toolName: 'ask_user', content: 'answered',
      metadata: { result_kind: resultKind, answers },
    });
    const projected = projectPersistedEventsWithReducer(turn.events, { turnId: turn.turn_id });
    const row = projected.rows.find((candidate) => candidate.kind === 'tool_call');
    const live = turn.rows.find((candidate) => candidate.kind === 'tool_call');
    const canonical = projectTurnRows(turn.events).find((candidate) => candidate.kind === 'tool_call');
    for (const candidate of [live, row]) {
      assert.equal(candidate.payload.user_questions_result_kind, resultKind);
      assert.deepEqual(candidate.payload.user_questions_answers, canonical.payload.user_questions_answers);
      assert.deepEqual(candidate.payload.user_questions, canonical.payload.user_questions);
      assert.equal(candidate.payload.question_ref, 'question-ref');
      assert.equal(candidate.payload.state, 'completed');
    }
    const metadataAnswers = turn.events.find((event) => event.kind === 'tool_result').payload.metadata.answers;
    assert.notEqual(row.payload.user_questions_answers, metadataAnswers);
    assert.notEqual(row.payload.user_questions_answers[1], metadataAnswers[1]);
    assert.notEqual(row.payload.user_questions_answers[1].value, metadataAnswers[1].value);
    metadataAnswers[1].value.push('changed');
    assert.deepEqual(row.payload.user_questions_answers, answers);
    const renderer = createTurnRowRenderUtils({
      renderToolCallBlock() { return 'generic tool'; },
      renderMarkdown(value) { return String(value || ''); },
      getFeatureFlags() { return {}; },
      MESSAGE_STATUS: { STREAMING: 'streaming' },
    });
    const dom = new JSDOM(renderer.buildToolCallRowMarkup(row, []));
    t.after(() => dom.window.close());
    const receipt = dom.window.document.querySelector('.user-questions-receipt');
    assert.ok(receipt, 'reconcile renders a structured receipt');
    if (resultKind === 'user_questions_answered') {
      assert.match(receipt.textContent, /Pick one/);
      assert.match(receipt.textContent, /Pick many/);
      assert.match(receipt.textContent, /One, Two/);
    } else {
      assert.match(receipt.textContent, /Questions skipped/);
    }
  });
}
