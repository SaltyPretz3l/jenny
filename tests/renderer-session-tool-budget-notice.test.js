'use strict';

// TR-008 (owner 2026-09-28): when the per-chat tool budget blocks a tool call,
// the failed tool row says what happened and that a new chat keeps working,
// and the turn's first blocked row offers "Start new session" (the existing
// start_new_session recovery action).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { escapeHtml } = require('../renderer/shared/string-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');

const NOTICE = 'This chat used its tool budget. Start a new chat to keep working.';
const BLOCKED_TEXT = "Tool 'read_file' was not run: this chat's tool budget (2000 tool calls) is used up, so no more tools can run in this chat.";

function rowMarkup({ errorCode = 'CMP-TOOL-0013', outputText = BLOCKED_TEXT, metadata } = {}) {
  const renderer = createTurnRowToolRenderUtils({ escapeHtml, toolCallUtils });
  return renderer.buildToolCallRowMarkup({
    row_id: 'row-1',
    turn_id: 'turn-1',
    tool_call_id: 'call-1',
    payload: { tool_call_id: 'call-1', tool_name: 'read_file', state: 'completed', input: { path: 'notes.md' } },
  }, [], {
    pairedToolResultRow: {
      primary_message_id: 'result-1',
      payload: {
        tool_call_id: 'call-1',
        tool_name: 'read_file',
        output_text: outputText,
        result_is_error: true,
        is_error: true,
        error_code: errorCode,
        ...(metadata ? { metadata } : {}),
      },
    },
  });
}

function summary(fields) {
  return toolCallUtils.summarizeToolFailure({ isError: true, status: 'errored', errorCode: 'CMP-TOOL-0013', ...fields });
}

test('a per-chat budget block reads as the budget notice, by metadata or by its text', () => {
  assert.equal(summary({ outputText: 'anything', metadata: { quota_scope: 'session_tool_budget' } }), NOTICE);
  assert.equal(summary({ outputText: BLOCKED_TEXT }), NOTICE);
  // Rows persisted before TR-008 carry the older wording.
  assert.equal(summary({ outputText: "Tool 'x' was not run: this session's tool budget (200 calls) is used up." }), NOTICE);
});

test('other tool-cap blocks keep their own failure text', () => {
  const perTurn = "Tool 'read_file' was not run: cumulative tool invocation limit (20) reached for this turn.";
  assert.equal(summary({ outputText: perTurn }), perTurn);
  assert.equal(summary({ outputText: 'web', metadata: { quota_scope: 'web_per_turn' } }), 'web');
  assert.equal(toolCallUtils.isSessionToolBudgetBlock({ errorCode: 'CMP-TOOL-0008', outputText: BLOCKED_TEXT }), false);
});

test("the turn's first budget block offers Start new session outside the header toggle", () => {
  const dom = new JSDOM(`<!doctype html><body>${rowMarkup({
    metadata: { quota_scope: 'session_tool_budget', session_budget_notice: true },
  })}</body>`);
  const document = dom.window.document;
  const link = document.querySelector('[data-inv-error-action="start_new_session"]');
  assert.ok(link, 'the notice row carries the start_new_session action');
  assert.equal(link.textContent, 'Start new session');
  assert.equal(link.getAttribute('role'), 'link');
  assert.equal(link.closest('.tool-call-row-toggle'), null);
  assert.match(document.querySelector('.tool-call-row-toggle').textContent, /This chat used its tool budget\./);
  dom.window.close();
});

test('later budget blocks in the turn show the notice text without repeating the action', () => {
  const later = new JSDOM(`<!doctype html><body>${rowMarkup({
    metadata: { quota_scope: 'session_tool_budget' },
  })}</body>`);
  assert.equal(later.window.document.querySelector('[data-inv-error-action="start_new_session"]'), null);
  assert.match(later.window.document.querySelector('.tool-call-row-toggle').textContent, /This chat used its tool budget\./);
  later.window.close();

  const other = new JSDOM(`<!doctype html><body>${rowMarkup({
    outputText: 'cumulative tool invocation limit (20) reached for this turn.',
    metadata: { quota_scope: 'turn', session_budget_notice: true },
  })}</body>`);
  assert.equal(other.window.document.querySelector('[data-inv-error-action="start_new_session"]'), null);
  other.window.close();
});
