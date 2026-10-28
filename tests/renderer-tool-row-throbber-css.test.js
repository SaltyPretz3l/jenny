const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');

// Every running tool row breathes its leading dot (the row throbber), not only
// the file rows that also breathe their icon. jsdom runs no author cascade, so
// the rule's own selector list is matched against the real row markup.
const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-machinery.css'), 'utf8');
const ROW_THROBBER_SELECTOR = (() => {
  const rule = css.match(/\/\* Row throbber:[\s\S]*?\*\/\s*([^{]+)\{\s*animation:\s*tool-call-running-breathe/);
  assert.ok(rule, 'the row-throbber rule should exist in styles/chat-machinery.css');
  return rule[1].trim();
})();

function firstDot(markup) {
  const dom = new JSDOM(`<!doctype html><body>${markup}</body>`);
  return dom.window.document.querySelector('.status-dot');
}

function minimalRow(toolName, input, state) {
  return createTurnRowToolRenderUtils({ escapeHtml, getNow: () => 10_000 }).buildToolCallRowMarkup({
    row_id: `row-${toolName}`,
    turn_id: 'turn-throbber',
    primary_message_id: `message-${toolName}`,
    payload: { tool_call_id: `call-${toolName}`, tool_name: toolName, input, state, running_started_at_ms: 5_000 },
  }, [], { sessionId: 'session-throbber' });
}

for (const [toolName, input] of [
  ['create_artifact', { title: 'Fib helper', content: 'print(1)' }],
  ['run_temp_script', { language: 'python', script: 'print(1)' }],
  ['run_command', { command: 'npm test' }],
  ['write_file', { path: 'notes.md', content: '# Notes' }],
]) {
  test(`a running ${toolName} row breathes its dot; a settled one does not`, () => {
    assert.equal(firstDot(minimalRow(toolName, input, 'running')).matches(ROW_THROBBER_SELECTOR), true);
    assert.equal(firstDot(minimalRow(toolName, input, 'completed')).matches(ROW_THROBBER_SELECTOR), false);
  });
}

test('a running classic tool block breathes its header dot', () => {
  const message = {
    id: 'tool-use-script', role: 'assistant', kind: 'tool_use',
    tool_call: { call_id: 'call-script', tool_name: 'run_temp_script', input: { script: 'print(1)' }, status: 'running' },
  };
  const markup = createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils }).renderToolCallBlock(message, [message], {});
  assert.equal(firstDot(markup).matches(ROW_THROBBER_SELECTOR), true);
});

test('a live Answers tool run breathes its summary dot; a finished run does not', () => {
  const runMarkup = (state) => `<div class="tool-run-row" data-tool-run-state="${toolCallUtils.toolRunState({ live: state === 'live' })}">`
    + `<div class="tool-run-toggle">${toolCallUtils.buildToolRunToggleInner({ live: state === 'live', liveLabel: 'Running a script', sentence: 'Ran a script' })}</div></div>`;
  assert.equal(firstDot(runMarkup('live')).matches(ROW_THROBBER_SELECTOR), true);
  assert.equal(firstDot(runMarkup('ok')).matches(ROW_THROBBER_SELECTOR), false);
});

test('reduced motion stills every row-throbber dot', () => {
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]).join('\n');
  for (const selector of ROW_THROBBER_SELECTOR.split(/,\s*\n/)) {
    assert.ok(reduced.includes(selector.trim()), `reduced motion should list ${selector.trim()}`);
  }
});
