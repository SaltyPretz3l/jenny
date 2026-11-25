'use strict';

// new-test-file: renderer-tool-runs.test.js sits at the 600-line cap; these cases drive the real tool-row renderer and row list together.
// Row 199 C6: a validation slip (CMP-LOOP-0016) the model fixed by calling the same tool again in the
// same turn (same path or command, never a parallel sibling) is not shown as a failure. Pure helper, row markup, and the Answers run count.

const test = require('node:test');
const assert = require('node:assert/strict');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { createTurnRowToolRenderUtils, isRetriedValidationSlip } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { createTurnRowListUtils } = require('../renderer/chat/renderer-turn-row-list-utils');

const SLIP = 'CMP-LOOP-0016';

function call(id, tool, { turn = 'turn-1', path = 'x.js' } = {}) {
  return {
    row_id: `call:${id}`, turn_id: turn, kind: 'tool_call', tool_call_id: id,
    payload: { tool_call_id: id, tool_name: tool, state: 'completed', input: path ? { path } : {} },
  };
}

function result(id, tool, { error = '', turn = 'turn-1' } = {}) {
  const isError = Boolean(error);
  return {
    row_id: `result:${id}`, turn_id: turn, kind: 'tool_result', tool_call_id: id,
    payload: {
      tool_call_id: id, tool_name: tool, is_error: isError, result_is_error: isError, error_code: error,
      state: isError ? 'errored' : 'completed', output_text: isError ? `${id} failed: missing required argument 'title'` : 'ok',
    },
  };
}

// rows ordered like a turn: each call followed by its result.
const turn = (...pairs) => pairs.flatMap(([id, tool, opts]) => [call(id, tool, opts), result(id, tool, opts)]);
const resultRow = (rows, id) => rows.find((row) => row.kind === 'tool_result' && row.tool_call_id === id);

test('isRetriedValidationSlip: only a CMP-LOOP-0016 slip followed by a later same-tool success in the same turn', () => {
  const retried = turn(['a', 'exit_plan_mode', { error: SLIP }], ['b', 'exit_plan_mode']);
  assert.equal(isRetriedValidationSlip(retried, resultRow(retried, 'a')), true);

  const retryFailed = turn(['a', 'exit_plan_mode', { error: SLIP }], ['b', 'exit_plan_mode', { error: 'CMP-TOOL-0100' }]);
  assert.equal(isRetriedValidationSlip(retryFailed, resultRow(retryFailed, 'a')), false, 'a later failure is no retry');

  const otherCode = turn(['a', 'exit_plan_mode', { error: 'CMP-TOOL-0100' }], ['b', 'exit_plan_mode']);
  assert.equal(isRetriedValidationSlip(otherCode, resultRow(otherCode, 'a')), false, 'only the validation code');

  const otherTool = turn(['a', 'exit_plan_mode', { error: SLIP }], ['b', 'read_file']);
  assert.equal(isRetriedValidationSlip(otherTool, resultRow(otherTool, 'a')), false, 'a different tool is no retry');

  const laterTurn = turn(['a', 'exit_plan_mode', { error: SLIP }], ['b', 'exit_plan_mode', { turn: 'turn-2' }]);
  assert.equal(isRetriedValidationSlip(laterTurn, resultRow(laterTurn, 'a')), false, 'a later turn is no retry');

  const earlierSuccess = turn(['b', 'exit_plan_mode'], ['a', 'exit_plan_mode', { error: SLIP }]);
  assert.equal(isRetriedValidationSlip(earlierSuccess, resultRow(earlierSuccess, 'a')), false, 'an earlier success is no retry');

  // A parallel sibling (called before the slip's result) is no retry, even when it succeeded.
  const parallel = [call('a', 'write_file', { path: 'a.js' }), call('b', 'write_file', { path: 'b.js' }),
    result('a', 'write_file', { error: SLIP }), result('b', 'write_file')];
  assert.equal(isRetriedValidationSlip(parallel, resultRow(parallel, 'a')), false, 'a parallel sibling is no retry');

  const otherPath = turn(['a', 'edit_file', { error: SLIP, path: 'a.js' }], ['r', 'read_file'], ['b', 'edit_file', { path: 'docs/other.md' }]);
  assert.equal(isRetriedValidationSlip(otherPath, resultRow(otherPath, 'a')), false, 'a later call on another path is no retry');

  const missingPath = turn(['a', 'edit_file', { error: SLIP, path: '' }], ['b', 'edit_file', { path: 'a.js' }]);
  assert.equal(isRetriedValidationSlip(missingPath, resultRow(missingPath, 'a')), true, 'a slip that named no path matches the next call');

  const jsonInput = turn(['a', 'edit_file', { error: SLIP, path: '' }], ['b', 'edit_file', { path: '' }]);
  Object.assign(jsonInput[0].payload, { input: undefined, input_json: '{"path":"a.js"}' });
  Object.assign(jsonInput[2].payload, { input: undefined, input_json: '{"path":"b.js"}' });
  assert.equal(isRetriedValidationSlip(jsonInput, resultRow(jsonInput, 'a')), false, 'targets are read from input_json too');

  assert.equal(isRetriedValidationSlip(retried, retried[0]), false, 'a call row is not a result');
  assert.equal(isRetriedValidationSlip(retried, { ...resultRow(retried, 'a') }), false, 'a row outside the list');
  assert.equal(isRetriedValidationSlip(null, resultRow(retried, 'a')), false);
});

function renderList(rows, transcriptView) {
  const tools = createTurnRowToolRenderUtils({ toolCallUtils });
  const list = createTurnRowListUtils({
    buildRowBodyMarkup: (row, messages, options) => tools.buildToolCallRowMarkup(row, messages, { ...options, forceMaterializeToolDetails: true }),
  });
  return list.buildTurnRowListMarkup(rows, [], { transcriptView, sessionId: 's1', turnRows: rows });
}

const toolRowTag = (html, id) => new RegExp(`<div class="tool-call-row[^>]*data-tool-call-id="${id}"[^>]*>`).exec(html)[0];

test('a retried slip row is not red and keeps its error text; an unretried one stays red', () => {
  const retried = renderList(turn(['a', 'exit_plan_mode', { error: SLIP }], ['b', 'exit_plan_mode']));
  const slipTag = toolRowTag(retried, 'a');
  assert.doesNotMatch(slipTag, /data-tool-status="errored"/);
  assert.doesNotMatch(slipTag, /data-tool-severity="danger"/);
  assert.match(slipTag, /data-tool-severity="caution"/);
  assert.match(retried, /a failed: missing required argument/, 'the error text stays in the details');
  assert.doesNotMatch(toolRowTag(retried, 'b'), /data-tool-severity/);

  const unretried = renderList(turn(['a', 'exit_plan_mode', { error: SLIP }]));
  assert.match(toolRowTag(unretried, 'a'), /data-tool-status="errored"[^>]*data-tool-severity="danger"/);
});

test('an Answers run counts a real failure but not a retried slip', () => {
  const failedText = (html) => (/tool-run-failed">(\d+) failed</.exec(html) || [])[1];
  const rows = turn(['a', 'read_file', { error: SLIP }], ['b', 'read_file', { error: 'CMP-TOOL-0100', path: 'y.js' }], ['c', 'read_file']);
  assert.equal(failedText(renderList(rows, 'answers')), '1');
  const noRetry = turn(['a', 'read_file', { error: SLIP }], ['b', 'read_file', { error: 'CMP-TOOL-0100', path: 'y.js' }], ['c', 'grep_search']);
  assert.equal(failedText(renderList(noRetry, 'answers')), '2');
});
