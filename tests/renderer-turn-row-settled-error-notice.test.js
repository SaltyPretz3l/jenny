'use strict';

// Row 27 gate sitting (2026-10-07): a plugin chat settled on read (the retired
// image plugin's interrupted operation) carries its interruption sentence as the
// assistant body with status runtime_error and no stream error. The projector
// emits the body row and a trailing assistant_error notice whose payload repeats
// the same content, so the transcript showed the sentence twice.

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectRows } = require('./helpers/renderer-turn-row-projector-helpers');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const { createTranscriptThinkingRenderer } = require('../renderer/chat/renderer-transcript-thinking');
const { escapeHtml } = require('../renderer/shared/string-utils');

test('settled plugin interruption text renders in exactly one projected row', () => {
  const content = 'The plugin operation was interrupted before it finished.';
  const messages = normalizeChatMessages([
    { id: 'user_1', role: 'user', content: 'Draw a fox', status: 'complete' },
    { id: 'assistant_working', role: 'assistant', content, status: 'runtime_error' },
  ]);
  assert.equal(messages[1].status, 'error');
  const { rows } = projectRows(messages);
  const renderer = createTurnRowRenderUtils(createTranscriptThinkingRenderer({ escapeHtml }));
  const markup = rows.map((row) => renderer.buildRowBodyMarkup(row, messages, { siblingRows: rows }));
  assert.equal(markup.filter((html) => html.includes(content)).length, 1);
  // The row set and its order are unchanged: the notice row still exists, with an empty body.
  assert.deepEqual(rows.map((row) => row.kind), ['user_bubble', 'assistant_text', 'system_notice']);
  assert.equal(rows[2].payload.subkind, 'assistant_error');
  assert.equal(markup[2], '');
});

// Astra batch review (2026-10-07): with a reasoning phase and no visible segment the
// projector emits no body row, so the notice is the only row that can show the text.
test('a failed reply with a reasoning phase and no body row keeps its text in the notice', () => {
  const content = 'The reply stopped before any text arrived.';
  const messages = normalizeChatMessages([
    { id: 'user_1', role: 'user', content: 'Draw a fox', status: 'complete' },
    { id: 'a1', role: 'assistant', content, status: 'runtime_error',
      phases: [{ phase_id: 'p1', phase_kind: 'reasoning', entries: [{ text: 'thinking' }] }] },
  ]);
  const { rows } = projectRows(messages);
  assert.deepEqual(rows.map((row) => row.kind), ['user_bubble', 'reasoning', 'system_notice']);
  const renderer = createTurnRowRenderUtils(createTranscriptThinkingRenderer({ escapeHtml }));
  const notice = renderer.buildRowBodyMarkup(rows[2], messages, { siblingRows: rows });
  assert.ok(notice.includes(escapeHtml(content)), 'the notice carries the text');
});

// The dedupe contract on the notice row alone (moved from the render-utils test file at its size cap).
test('assistant error fallback suppresses only a body repeated without independent failure information', () => {
  const renderer = createTurnRowRenderUtils(createTranscriptThinkingRenderer({ escapeHtml }));
  const payload = { subkind: 'assistant_error', content: 'Partial reply' };
  const row = { kind: 'system_notice', primary_message_id: 'assistant', payload };
  const messages = [{ id: 'assistant', role: 'assistant', status: 'error', content: 'Partial reply' }];
  // The sentence is suppressed only while a sibling body row of the same message shows it.
  const body = { kind: 'assistant_text', primary_message_id: 'assistant', payload: { text: 'Partial reply' } };
  const options = { siblingRows: [body, row] };
  const preserved = [
    { stream_error: 'Connection lost' },
    { error_code: 'CMP-SIDECAR-0003' },
    { recovery_hint: 'Retry this turn' },
    { message: 'Connection lost' },
    { content: '' },
  ];
  assert.equal(renderer.buildSystemNoticeRowMarkup(row, messages, options), '');
  assert.ok(renderer.buildSystemNoticeRowMarkup(row, messages, { siblingRows: [row] }), 'no body row: the notice keeps the text');
  assert.ok(renderer.buildSystemNoticeRowMarkup(row, messages), 'unknown siblings: the notice keeps the text');
  for (const fields of preserved) {
    const notice = { ...row, payload: { ...payload, ...fields } };
    assert.ok(renderer.buildSystemNoticeRowMarkup(notice, messages, options), JSON.stringify(fields));
  }
  assert.equal(renderer.buildSystemNoticeRowMarkup({
    ...row, payload: { ...payload, message: 'Partial reply' },
  }, messages, options), '');
  assert.ok(renderer.buildSystemNoticeRowMarkup({
    ...row, payload: { subkind: 'assistant_error', content: '' },
  }, [{ ...messages[0], content: '' }]));
});
