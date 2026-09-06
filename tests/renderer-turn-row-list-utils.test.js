'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTurnRowListUtils } = require('../renderer/chat/renderer-turn-row-list-utils');

test('turn row list pairs a visible tool call with its full-turn result candidate', () => {
  const toolCall = {
    row_id: 'row:call',
    turn_id: 'turn-cross-bucket',
    kind: 'tool_call',
    tool_call_id: 'call-cross-bucket',
    payload: { tool_call_id: 'call-cross-bucket', tool_name: 'mermaid_generate' },
  };
  const toolResult = {
    row_id: 'row:result',
    turn_id: 'turn-cross-bucket',
    kind: 'tool_result',
    tool_call_id: 'call-cross-bucket',
    payload: { tool_call_id: 'call-cross-bucket', tool_name: 'mermaid_generate', output_text: '{}' },
  };
  let pairedResult = null;
  const rowList = createTurnRowListUtils({
    buildRowBodyMarkup(_row, _messages, options) {
      pairedResult = options.pairedToolResultRow;
      return '<div>tool call</div>';
    },
  });

  const html = rowList.buildTurnRowListMarkup([toolCall], [], {
    turnRows: [
      { row_id: 'row:answer', turn_id: 'turn-cross-bucket', kind: 'assistant_text', payload: { text: 'Done.' } },
      toolCall,
      toolResult,
    ],
  });

  assert.strictEqual(pairedResult, toolResult);
  assert.match(html, /tool call/);
});

test('chat-rail reasoning preview markup stays decoupled from transcript disclosure state', () => {
  const rowList = createTurnRowListUtils({
    buildTimelineV2Presentation() {
      return {
        summary: 'Inspecting the reasoning-bearing fixture',
        tone: 'active',
        state: 'streaming',
        target: { kind: 'none' },
      };
    },
    buildRowBodyMarkup() {
      return '<span>Reasoning preview</span>';
    },
  });
  const html = rowList.buildTurnRowListMarkup([{
    row_id: 'row:reasoning',
    turn_id: 'turn:reasoning',
    kind: 'reasoning',
    payload: {
      phase_id: 'phase:reasoning',
      summary: 'Inspecting the reasoning-bearing fixture',
      status: 'streaming',
    },
  }], []);

  assert.match(html, /data-chat-row-v2-summary-kind="reasoning"/);
  assert.doesNotMatch(html, /data-reasoning-status/);
  assert.doesNotMatch(html, /aria-expanded/);
});

function createDividerAwareRowList() {
  return createTurnRowListUtils({
    buildRowBodyMarkup(row) {
      return row.bodyMarkup;
    },
    buildTimeDividerMarkup(divider) {
      return `<div data-divider-id="${divider.beforeMessageId}"></div>`;
    },
  });
}

test('turn row list emits a target divider before its first non-empty row', () => {
  const rowList = createDividerAwareRowList();
  const html = rowList.buildTurnRowListMarkup([
    {
      row_id: 'empty',
      turn_id: 'turn-divider',
      kind: 'assistant_text',
      render_message_id: 'message-target',
      bodyMarkup: '',
    },
    {
      row_id: 'visible',
      turn_id: 'turn-divider',
      kind: 'assistant_text',
      render_message_id: 'message-target',
      bodyMarkup: '<span>Painted content</span>',
    },
  ], [], {
    timelineDividerByMessageId: new Map([[
      'message-target',
      { beforeMessageId: 'message-target' },
    ]]),
  });

  assert.equal(html.indexOf('data-divider-id="message-target"') < html.indexOf('Painted content'), true);
  assert.equal((html.match(/data-divider-id="message-target"/g) || []).length, 1);
});

test('turn row list suppresses a divider owned by the host article message', () => {
  const rowList = createDividerAwareRowList();
  const html = rowList.buildTurnRowListMarkup([{
    row_id: 'host-row',
    turn_id: 'turn-divider',
    kind: 'assistant_text',
    primary_message_id: 'message-host',
    bodyMarkup: '<span>Host content</span>',
  }], [], {
    timelineDividerByMessageId: new Map([[
      'message-host',
      { beforeMessageId: 'message-host' },
    ]]),
    dividerHostMessageId: 'message-host',
  });

  assert.doesNotMatch(html, /data-divider-id=/);
  assert.match(html, /Host content/);
});

test('turn row list emits at most one divider per target across multiple rows', () => {
  const rowList = createDividerAwareRowList();
  const rows = ['first', 'second'].map((rowId) => ({
    row_id: rowId,
    turn_id: 'turn-divider',
    kind: 'assistant_text',
    source_message_ids: ['message-target'],
    bodyMarkup: `<span>${rowId}</span>`,
  }));
  const html = rowList.buildTurnRowListMarkup(rows, [], {
    timelineDividerByMessageId: new Map([[
      'message-target',
      { beforeMessageId: 'message-target' },
    ]]),
  });

  assert.equal((html.match(/data-divider-id="message-target"/g) || []).length, 1);
  assert.equal(html.indexOf('data-divider-id="message-target"') < html.indexOf('first'), true);
});

test('turn row list never emits a divider before an empty-wrapper row', () => {
  const rowList = createDividerAwareRowList();
  const html = rowList.buildTurnRowListMarkup([{
    row_id: 'empty-only',
    turn_id: 'turn-divider',
    kind: 'assistant_text',
    primary_message_id: 'message-empty',
    bodyMarkup: '',
  }], [], {
    timelineDividerByMessageId: new Map([[
      'message-empty',
      { beforeMessageId: 'message-empty' },
    ]]),
  });

  assert.equal(html, '<div class="turn-row-list" data-turn-row-list="true"></div>');
});

test('turn row list output remains byte-identical when no divider map is supplied', () => {
  const rowList = createDividerAwareRowList();
  const html = rowList.buildTurnRowListMarkup([{
    row_id: 'row',
    turn_id: 'turn',
    kind: 'assistant_text',
    primary_message_id: 'message',
    bodyMarkup: '<span>Body</span>',
  }], []);

  assert.equal(
    html,
    '<div class="turn-row-list" data-turn-row-list="true"><div class="chat-row" data-row-id="turn:assistant_text:row" data-row-kind="assistant_text" data-source-message-id="message" data-render-message-id="message" data-source-message-ids="message"><span class="chat-row-node-dot" aria-hidden="true"></span><span>Body</span></div></div>'
  );
});
