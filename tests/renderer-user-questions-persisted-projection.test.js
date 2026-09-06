'use strict';

// Non-vacuous end-to-end pins for the ask_user settled receipt: the metadata
// travels through the REAL persistence/projection normalizers instead of being
// hand-stamped onto payloads (the vacuous-green shape that hid the original
// "receipt never renders in production" defect), plus name-parity pins for the
// browser-global fallback the Node test runner can never exercise via require.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { normalizePersistedToolResultMetadata } = require('../services/backend/tool-result-diff-metadata');
const messageUtils = require('../renderer/chat/renderer-turn-tree-projector-message-utils');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');

const REAL_TOOL_METADATA = Object.freeze({
  result_kind: 'user_questions_answered',
  answers: [
    { id: 'single', value: 'Alpha' },
    { id: 'multi', value: ['One', 'Two'], other: 'custom note' },
  ],
});

function makeRenderUtils() {
  return createTurnRowRenderUtils({
    renderToolCallBlock() { return '<div class="settled-tool-row"></div>'; },
    renderMarkdown(value) { return String(value || ''); },
    getFeatureFlags() { return {}; },
    MESSAGE_STATUS: { STREAMING: 'streaming' },
  });
}

test('persisted tool_result metadata keeps ask_user result_kind and bounded answers', () => {
  const persisted = normalizePersistedToolResultMetadata(REAL_TOOL_METADATA);
  assert.ok(persisted, 'whitelist must not drop ask_user result metadata');
  assert.equal(persisted.result_kind, 'user_questions_answered');
  assert.deepEqual(persisted.answers, REAL_TOOL_METADATA.answers);

  const declined = normalizePersistedToolResultMetadata({ result_kind: 'user_questions_declined' });
  assert.equal(declined.result_kind, 'user_questions_declined');

  const hostile = normalizePersistedToolResultMetadata({
    result_kind: 'user_questions_answered',
    answers: [{ id: 'x'.repeat(500), value: 'y'.repeat(2000) }, 'garbage', null],
  });
  assert.equal(hostile.answers.length, 1);
  assert.equal(hostile.answers[0].id.length, 120);
  assert.equal(hostile.answers[0].value.length, 500);
});

test('message-derived projection metadata keeps ask_user result_kind and answers', () => {
  const cloned = messageUtils.cloneSubagentReportMetadata(REAL_TOOL_METADATA);
  assert.ok(cloned, 'message-derived clone must not drop ask_user result metadata');
  assert.equal(cloned.result_kind, 'user_questions_answered');
  assert.deepEqual(cloned.answers, REAL_TOOL_METADATA.answers);
  assert.notEqual(cloned.answers, REAL_TOOL_METADATA.answers);
  assert.equal(messageUtils.cloneSubagentReportMetadata({ result_kind: 'something_else' }), null);
});

test('hydration-shaped events render the settled receipt end-to-end through the real whitelist', () => {
  const metadata = normalizePersistedToolResultMetadata(REAL_TOOL_METADATA);
  const rows = projectTurnRows([
    {
      event_id: 't:tool_use:0', turn_id: 't', kind: 'tool_use',
      primary_message_id: 'tool_use_c1', source_message_ids: ['tool_use_c1'],
      sort_key: [0, 0, 40], tool_call_id: 'c1', status: 'running',
      payload: { tool_name: 'ask_user', input: { questions: [] }, summary: 'Ask user' },
    },
    {
      event_id: 't:user_questions_requested:0', turn_id: 't', kind: 'user_questions_requested',
      primary_message_id: 'tool_use_c1', source_message_ids: ['tool_use_c1'],
      sort_key: [0, 1, 45], tool_call_id: 'c1', status: 'pending_user_input',
      payload: {
        tool_name: 'ask_user', question_ref: 'ref-1',
        questions: [
          { id: 'single', prompt: 'Pick one', options: ['Alpha'], multi_select: false, allow_other: false },
          { id: 'multi', prompt: 'Pick many', options: ['One', 'Two'], multi_select: true, allow_other: true },
        ],
      },
    },
    {
      event_id: 't:tool_result:0', turn_id: 't', kind: 'tool_result',
      primary_message_id: 'tool_use_c1', tool_result_message_id: 'tool_result_c1',
      source_message_ids: ['tool_use_c1', 'tool_result_c1'],
      sort_key: [1, 0, 50], tool_call_id: 'c1', status: 'completed',
      payload: { tool_name: 'ask_user', output_text: 'Q: ...', is_error: false, metadata },
    },
  ]);
  const row = rows.find((candidate) => candidate.kind === 'tool_call');
  assert.equal(row.payload.user_questions_result_kind, 'user_questions_answered');

  const message = {
    id: 'tool_use_c1', role: 'assistant', kind: 'tool_use', status: 'complete',
    tool_call: { call_id: 'c1', tool_name: 'ask_user', status: 'completed' },
  };
  const html = makeRenderUtils().buildToolCallRowMarkup(row, [message], { messageById: new Map([[message.id, message]]) });
  assert.match(html, /user-questions-receipt/);
  assert.match(html, /Alpha/);
  assert.match(html, /One, Two, Other: custom note/);
  assert.doesNotMatch(html, /user-questions-block|tool-call-row/);
});

test('settled receipt renders when questions survive only on the persisted tool_call', () => {
  const message = {
    id: 'tool_use_c1', role: 'assistant', kind: 'tool_use', status: 'complete',
    tool_call: {
      call_id: 'c1', tool_name: 'ask_user', status: 'completed',
      user_questions: [{ id: 'single', prompt: 'Pick one', options: ['Alpha'], multi_select: false, allow_other: false }],
    },
  };
  const row = {
    row_id: 'r1', turn_id: 't', kind: 'tool_call', primary_message_id: message.id, tool_call_id: 'c1',
    payload: {
      tool_call_id: 'c1', tool_name: 'ask_user', state: 'completed',
      user_questions_result_kind: 'user_questions_answered',
      user_questions_answers: [{ id: 'single', value: 'Alpha' }],
    },
  };
  const html = makeRenderUtils().buildToolCallRowMarkup(row, [message], { messageById: new Map([[message.id, message]]) });
  assert.match(html, /user-questions-receipt/);
  assert.match(html, /Pick one/);
});

test('a persisted stale demotion outranks the projector pending state on full re-render', () => {
  // Client-side liveness demotion never produces a tool_result event, so the
  // projector keeps deriving state='pending_user_input' from the unsettled
  // events. The persisted stale mark must still win, or a scroll recycle /
  // resize re-render resurrects the interactive dead card.
  const message = {
    id: 'tool_use_c1', role: 'assistant', kind: 'tool_use', status: 'complete',
    user_questions_result_kind: 'user_questions_stale',
    user_questions_stale: true,
    tool_call: {
      call_id: 'c1', tool_name: 'ask_user', status: 'completed',
      question_ref: 'ref-1',
      user_questions: [{ id: 'single', prompt: 'Pick one', options: ['Alpha'], multi_select: false, allow_other: false }],
      user_questions_result_kind: 'user_questions_stale',
      user_questions_stale: true,
    },
  };
  const row = {
    row_id: 'r1', turn_id: 't', kind: 'tool_call', primary_message_id: message.id, tool_call_id: 'c1',
    payload: {
      tool_call_id: 'c1', tool_name: 'ask_user', state: 'pending_user_input', question_ref: 'ref-1',
      user_questions: [{ id: 'single', prompt: 'Pick one', options: ['Alpha'], multi_select: false, allow_other: false }],
    },
  };
  const html = makeRenderUtils().buildToolCallRowMarkup(row, [message], { messageById: new Map([[message.id, message]]) });
  assert.match(html, /user-questions-receipt/);
  assert.match(html, /Questions no longer active/);
  assert.doesNotMatch(html, /user-questions-submit-btn|user-questions-block"/);
});

test('production wiring forwards session-message accessors to the transcript bindings', () => {
  const eventUtilsSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat', 'renderer-chat-event-utils.js'), 'utf8');
  const callBlock = eventUtilsSource.slice(eventUtilsSource.indexOf('createTranscriptEventBindings({'));
  assert.notEqual(callBlock.indexOf('getSessionMessages,'), -1, 'transcript bindings must receive getSessionMessages');
  assert.notEqual(callBlock.indexOf('setSessionMessages,'), -1, 'transcript bindings must receive setSessionMessages');
  const compositionSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app', 'renderer-app-controller-composition.js'), 'utf8');
  assert.match(compositionSource, /getSessionMessages: \(\.\.\.a\) => getSessionMessages\(\.\.\.a\)/);
  assert.match(compositionSource, /setSessionMessages: \(\.\.\.a\) => setSessionMessages\(\.\.\.a\)/);
});

test('stream tool handlers register the browser global name the bindings fall back to', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat', 'renderer-stream-handler-tools.js'), 'utf8');
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  assert.equal(typeof sandbox.rendererStreamHandlerTools, 'object');
  assert.equal(typeof sandbox.rendererStreamHandlerTools.markUserQuestionsStale, 'function');

  const bindingsSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat', 'renderer-chat-event-transcript-bindings.js'), 'utf8');
  assert.match(bindingsSource, /globalThis\.rendererStreamHandlerTools/);
  assert.doesNotMatch(bindingsSource, /rendererStreamToolHandlers/);
});
