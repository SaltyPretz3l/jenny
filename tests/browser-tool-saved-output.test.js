'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { handleToolNotification } = require('../services/backend/chat-stream-tool-handling');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const { savedToolOutput } = require('../services/backend/chat-stream-tool-payload-utils');

const MARKER = 'PAGETEXT-7f3a9c';
const PAGE_TEXT = `Page: Shop\nURL: https://shop.example/\n\n[r1] link "${MARKER} account number 1234"\n${`${MARKER} line of the page. `.repeat(400)}`;
const STEP = 'Opened shop.example. Now on Shop (https://shop.example/)';

function run({ toolName = 'browser', output = PAGE_TEXT, metadata = { result_kind: 'browser', status: 'ok', step_summary: STEP }, success = true } = {}) {
  const messages = [{ id: 'user_1', role: 'user', content: 'open shop.example' }];
  const emitted = [];
  const service = {
    sessionStore: {
      getSessionMessages: () => messages,
      appendMessage(_sessionId, message) { messages.push(message); },
      updateMessage(_sessionId, messageId, patch) {
        const index = messages.findIndex(message => message.id === messageId);
        if (index >= 0) messages[index] = { ...messages[index], ...patch };
      },
    },
    emit(_channel, payload) { emitted.push(payload); },
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
  };
  const collector = new CanonicalTurnEventCollector({ turnId: 'stream', sessionId: 'chat' });
  handleToolNotification(service, {
    seenToolCalls: new Set(), toolSummaries: new Map(), model: 'mock-model', resolvedSessionId: 'chat', streamId: 'stream',
    eventBase: { sessionId: 'chat', streamId: 'stream', model: 'mock-model' }, turnEventCollector: collector,
  }, { method: 'tool.result', params: {
    request_id: 'stream', tool_call_id: 'call-1', tool_name: toolName, success, output, metadata,
    tool_input: { action: 'navigate', url: 'https://shop.example/' },
  } });
  return { messages, emitted, collector, events: collector.capturedEvents };
}

test('page text appears in no stored message, no turn event and no emitted chat-stream event', () => {
  const { messages, emitted, events } = run();
  for (const [label, value] of [['messages', messages], ['events', events], ['emitted', emitted]]) {
    assert.ok(!JSON.stringify(value).includes(MARKER), `${label} hold no page text`);
  }
  const stored = messages.find(message => message.kind === 'tool_result');
  assert.equal(stored.tool_result.output_text, STEP);
  assert.equal(events.find(event => event.kind === 'tool_result').payload.output_text, STEP);
  assert.equal(emitted.find(event => event.type === 'tool_result').content, STEP);
});

test('a result with no step summary keeps a fixed line, not the page', () => {
  for (const metadata of [{ result_kind: 'browser', status: 'ok' }, { step_summary: '' }, { step_summary: 7 }, { step_summary: '   ' }, null]) {
    const { messages, emitted, events } = run({ metadata });
    assert.ok(!JSON.stringify([messages, emitted, events]).includes(MARKER));
    assert.equal(messages.find(message => message.kind === 'tool_result').tool_result.output_text, 'Browser step finished.');
    assert.equal(emitted.find(event => event.type === 'tool_result').content, 'Browser step finished.');
  }
});

test('an error result from the browser is also saved as its summary', () => {
  const { messages } = run({ success: false, output: PAGE_TEXT, metadata: { step_summary: 'The user did not allow opening evil.example.' } });
  assert.equal(messages.find(message => message.kind === 'tool_result').tool_result.output_text, 'The user did not allow opening evil.example.');
});

test('another tool keeps its full output, even with a step_summary key', () => {
  const { messages, emitted, events } = run({ toolName: 'web_search', output: PAGE_TEXT, metadata: { step_summary: STEP } });
  assert.equal(messages.find(message => message.kind === 'tool_result').tool_result.output_text, PAGE_TEXT);
  assert.equal(events.find(event => event.kind === 'tool_result').payload.output_text, PAGE_TEXT);
  assert.equal(emitted.find(event => event.type === 'tool_result').content, PAGE_TEXT);
});

test('savedToolOutput is the summary for browser and the plain string for the rest', () => {
  assert.equal(savedToolOutput('browser', PAGE_TEXT, { step_summary: STEP }), STEP);
  assert.equal(savedToolOutput('browser', PAGE_TEXT, null), 'Browser step finished.');
  assert.equal(savedToolOutput('browser', PAGE_TEXT, 'text'), 'Browser step finished.');
  assert.equal(savedToolOutput('browser', PAGE_TEXT, { step_summary: ['x'] }), 'Browser step finished.');
  assert.equal(savedToolOutput('read_file', 'abc', { step_summary: STEP }), 'abc');
  assert.equal(savedToolOutput('read_file', undefined, {}), '');
  assert.equal(savedToolOutput('read_file', null, {}), '');
});

test('a failed browser step with no summary is saved as failed, not finished (row 129, B12)', () => {
  assert.equal(savedToolOutput('browser', PAGE_TEXT, {}), 'Browser step finished.');
  assert.equal(savedToolOutput('browser', PAGE_TEXT, { failure_class: 'denied' }), 'Browser step failed.');
  assert.equal(savedToolOutput('browser', PAGE_TEXT, { failure_class: 'denied', step_summary: STEP }), STEP);
});
