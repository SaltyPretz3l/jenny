const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');

const metadata = { diff: { additions: 24, deletions: 8, review_state: 'full' } };

test('counts accept only successful Edit/Write operations with trustworthy integer totals', () => {
  for (const name of ['Edit', 'edit_file', 'Write', 'write_file']) {
    assert.deepEqual(toolCallUtils.getToolLineCounts(name, metadata, 'completed', false), { additions: 24, deletions: 8 });
  }
  for (const name of ['move_file', 'delete_file', 'read_file', 'run_command']) {
    assert.equal(toolCallUtils.getToolLineCounts(name, metadata, 'completed', false), null);
  }
  for (const status of ['running', 'awaiting_approval', 'errored', 'cancelled', 'timeout']) {
    assert.equal(toolCallUtils.getToolLineCounts('Edit', metadata, status, false), null);
  }
  for (const diff of [null, {}, { additions: 1 }, { additions: '2', deletions: 1 },
    { additions: -1, deletions: 2 }, { additions: 1.5, deletions: 2 },
    { additions: Infinity, deletions: 2 }, { additions: Number.MAX_SAFE_INTEGER + 1, deletions: 0 },
    { additions: 0, deletions: 0, review_state: 'failed' }]) {
    assert.equal(toolCallUtils.getToolLineCounts('Edit', { diff }, 'completed', false), null);
  }
  assert.equal(toolCallUtils.getToolLineCounts('Edit', metadata, 'completed', true), null);
  assert.equal(toolCallUtils.getToolLineCounts('Edit', null, 'completed', false), null);
  assert.deepEqual(toolCallUtils.getToolLineCounts('Edit', { diff: { additions: 0, deletions: 0, truncated: true, review_state: 'summary_only' } }, 'completed', false), { additions: 0, deletions: 0 });
});

function renderRows(toolName, meta, isError = false) {
  const input = { path: 'renderer/chat/a-very-long-file-name.js', old_string: 'a', new_string: 'b' };
  const result = { call_id: 'call-counts', tool_name: toolName, metadata: meta, is_error: isError, duration_ms: 300 };
  const use = { id: 'use-counts', role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'call-counts', tool_name: toolName, input, status: 'running' } };
  const message = { id: 'result-counts', role: 'tool', kind: 'tool_result', tool_result: result };
  const transcript = createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils });
  const timeline = createTurnRowToolRenderUtils({ escapeHtml });
  return [
    transcript.renderToolCallBlock(use, [use, message], {}),
    timeline.buildToolCallRowMarkup({ row_id: 'row-counts', payload: { tool_call_id: 'call-counts', tool_name: toolName, input, state: 'running' } }, [message], {
      pairedToolResultRow: { primary_message_id: message.id, payload: result },
    }),
  ];
}

test('both render paths display one accessible trailing count group for Edit and Write', () => {
  for (const name of ['edit_file', 'write_file']) {
    for (const markup of renderRows(name, metadata)) {
      const dom = new JSDOM(markup);
      try {
        const doc = dom.window.document;
        assert.equal(doc.querySelectorAll('.tool-call-line-counts').length, 1);
        assert.equal(doc.querySelector('.tool-call-line-add').textContent, '+24');
        assert.equal(doc.querySelector('.tool-call-line-remove').textContent, '−8');
        assert.equal(doc.querySelector('.tool-call-line-counts .sr-only').textContent, '24 lines added, 8 lines removed');
        assert.ok(doc.querySelector('.tool-call-status-cluster > .tool-call-line-counts'));
        assert.doesNotMatch(doc.querySelector('.tool-call-summary').textContent, /\+24/);
      } finally { dom.window.close(); }
    }
  }
});

test('renderers omit unknown/error totals but preserve confirmed zero and truncated totals', () => {
  for (const markup of [...renderRows('edit_file', {}), ...renderRows('edit_file', metadata, true), ...renderRows('move_file', metadata)]) {
    assert.doesNotMatch(markup, /class="tool-call-line-counts"/);
  }
  for (const markup of renderRows('write_file', { diff: { additions: 0, deletions: 0, truncated: true, review_state: 'summary_only' } })) {
    assert.match(markup, /tool-call-line-add tool-call-line-zero/);
    assert.match(markup, /tool-call-line-remove tool-call-line-zero/);
  }
});
