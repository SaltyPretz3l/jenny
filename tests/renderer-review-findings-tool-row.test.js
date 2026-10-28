'use strict';

// Row 64: a report_findings result shows its findings list beside the row header in both tool
// render paths (the turn-row projector and the transcript tool block), never inside the folded body.

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const reviewFindings = require('../renderer/chat/renderer-review-findings');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');

const previousActionButton = globalThis.inventoryActionButton;
globalThis.inventoryActionButton = actionButton;
test.after(() => {
  if (previousActionButton === undefined) delete globalThis.inventoryActionButton;
  else globalThis.inventoryActionButton = previousActionButton;
});
test.beforeEach(() => reviewFindings.resetForTests());

const OUTPUT = JSON.stringify({
  kind: 'review_findings', version: 1, scope: 'working tree vs HEAD', summary: '',
  counts: { high: 1, medium: 0, low: 1 },
  findings: [
    { index: 1, severity: 'high', title: 'subtotal skips the first item', body: 'Starts at 1.', file: 'src/cart.js', line: 7, end_line: 7, excerpt: null },
    { index: 2, severity: 'low', title: 'Unknown currency', body: '', file: 'src/cart.js', line: 23, end_line: 23, excerpt: null },
  ],
  dropped: 0, note: '',
});

function render({ toolName = 'report_findings', isError = false, output = OUTPUT } = {}) {
  const callId = 'call-review';
  const toolUse = {
    id: 'tool-use-review', role: 'assistant', kind: 'tool_use',
    tool_call: { call_id: callId, tool_name: toolName, status: 'completed', input: { findings: [] } },
  };
  const result = {
    id: 'tool-result-review', role: 'tool', kind: 'tool_result',
    tool_result: { call_id: callId, tool_name: toolName, output_text: output, summary: '', is_error: isError, generated_artifacts: [], metadata: {} },
  };
  const messages = [toolUse, result];
  const turn = createTurnRowToolRenderUtils({
    escapeHtml,
    normalizeId: (value) => String(value || '').trim(),
    formatDurationMs: () => '',
    renderArtifactTeaser: () => '',
    buildToolMarkerBannerMarkup: () => '',
  }).buildToolCallRowMarkup({
    turn_id: 'turn-review', row_id: 'row-review', primary_message_id: toolUse.id,
    payload: { tool_call_id: callId, tool_name: toolName, state: 'completed', input: toolUse.tool_call.input },
  }, messages, {
    sessionId: 'sess-1',
    pairedToolResultRow: {
      primary_message_id: result.id,
      payload: { tool_call_id: callId, tool_name: toolName, output_text: output, result_summary: '', is_error: isError, generated_artifacts: [], metadata: {} },
    },
  });
  const transcript = createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils }).renderToolCallBlock(toolUse, messages, {});
  return { turn, transcript };
}

const doc = (markup) => new JSDOM(`<main>${markup}</main>`).window.document;

test('the turn row shows the findings list between the header and the folded body', () => {
  const page = doc(render().turn);
  const row = page.querySelector('.tool-call-row');
  const block = row.querySelector('section[data-review-findings]');
  assert.ok(block, 'the findings list renders');
  assert.equal(row.querySelector('.tool-call-row-body').contains(block), false);
  assert.equal(block.getAttribute('data-tool-call-id'), 'call-review');
  assert.equal(block.getAttribute('data-session-id'), 'sess-1');
  assert.equal(block.querySelectorAll('[data-review-finding]').length, 2);
  assert.match(row.querySelector('.tool-call-row-header').textContent, /Code review/);
});

test('the transcript tool block shows the same list outside its details', () => {
  const page = doc(render().transcript);
  const block = page.querySelector('section[data-review-findings]');
  assert.ok(block);
  assert.equal(page.querySelector('.tool-call-details').contains(block), false);
});

test('a failed call, another tool, or output that is not findings renders no list', () => {
  for (const options of [{ isError: true }, { toolName: 'git_diff' }, { output: 'plain text' }]) {
    const markup = render(options);
    assert.equal(doc(markup.turn).querySelector('[data-review-findings]'), null, JSON.stringify(options));
    assert.equal(doc(markup.transcript).querySelector('[data-review-findings]'), null, JSON.stringify(options));
  }
});

test('report_findings rows read as Code review and never fold into an Answers run', () => {
  assert.equal(toolCallUtils.getToolDisplayName('report_findings', 'Review Findings'), 'Code review');
  assert.equal(toolCallUtils.isToolRunFoldable({ toolName: 'report_findings', status: 'completed' }), false);
  assert.equal(toolCallUtils.isToolRunFoldable({ toolName: 'git_diff', status: 'completed' }), true);
});
