const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTurnRowToolRenderUtils,
  getToolStatusLabel,
  getToolStatusSeverity,
} = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const {
  createProjectionContextPipeline,
} = require('../renderer/chat/renderer-render-pipeline-projection-context');

const utils = createTurnRowToolRenderUtils({});

test('retry target resolves only to the exact latest response in the owning turn', () => {
  const pipeline = createProjectionContextPipeline();
  const messages = [
    { id: 'assistant-old', role: 'assistant', content: 'old response' },
    { id: 'assistant-latest', role: 'assistant', content: 'latest response' },
  ];
  const turnIdByMessageId = new Map([
    ['assistant-old', 'turn-old'],
    ['assistant-latest', 'turn-latest'],
  ]);
  assert.equal(pipeline.resolveRetryMessageIdForToolRow(
    { turn_id: 'turn-latest' }, messages, { turnIdByMessageId }
  ), 'assistant-latest');
  assert.equal(pipeline.resolveRetryMessageIdForToolRow(
    { turn_id: 'turn-old' }, messages, { turnIdByMessageId }
  ), '', 'historical failure cannot target a newer response');
  const ineligibleLatest = [
    { id: 'assistant-old', role: 'assistant', status: 'complete', content: 'old response' },
    { id: 'question-latest', role: 'assistant', status: 'complete', kind: 'question_batch' },
    { id: 'streaming-latest', role: 'assistant', status: 'streaming', content: 'partial' },
  ];
  const ineligibleTurns = new Map([
    ['assistant-old', 'turn-old'], ['question-latest', 'turn-latest'], ['streaming-latest', 'turn-latest'],
  ]);
  assert.equal(pipeline.resolveRetryMessageIdForToolRow(
    { turn_id: 'turn-latest' }, ineligibleLatest, { turnIdByMessageId: ineligibleTurns }
  ), '', 'non-reply and streaming messages are never retry targets');
});

function buildCallRow(state, payloadOverrides = {}) {
  return {
    kind: 'tool_call',
    payload: {
      tool_call_id: 'call-1',
      tool_name: 'read_file',
      state,
      input_json: '{"path":"a.txt"}',
      ...payloadOverrides,
    },
  };
}

function buildResultRow(payloadOverrides = {}) {
  return {
    kind: 'tool_result',
    payload: {
      tool_call_id: 'call-1',
      tool_name: 'read_file',
      state: 'completed',
      output_text: '',
      ...payloadOverrides,
    },
  };
}

test('tool status labels delegate to the canonical tool-call-utils set', () => {
  // One label vocabulary across both tool-row families (quiet-timeline
  // overhaul): 'Error'/'Success'/'No result', never 'Errored'/'Completed'.
  assert.equal(getToolStatusLabel('interrupted'), 'Interrupted');
  assert.equal(getToolStatusLabel('abandoned'), 'No result');
  assert.equal(getToolStatusLabel('errored'), 'Error');
  assert.equal(getToolStatusLabel('completed'), 'Success');
  assert.equal(getToolStatusLabel('blocked'), 'Blocked');
  assert.equal(getToolStatusLabel('timed_out'), 'Timed out');
});

test('tool status severity splits danger, caution, and calm states', () => {
  for (const status of ['errored', 'error']) {
    assert.equal(getToolStatusSeverity(status), 'danger');
  }
  for (const status of ['timed_out', 'interrupted', 'abandoned']) {
    assert.equal(getToolStatusSeverity(status), 'caution');
  }
  for (const status of ['denied', 'cancelled', 'blocked']) {
    assert.equal(getToolStatusSeverity(status), 'calm');
  }
  for (const status of ['completed', 'running', 'awaiting_approval', 'requested', '']) {
    assert.equal(getToolStatusSeverity(status), '');
  }
});

test('cancelled tool call row carries calm severity (user stop, not a crash)', () => {
  const markup = utils.buildToolCallRowMarkup(buildCallRow('cancelled'), [], {});

  assert.match(markup, /data-tool-status="cancelled"/);
  assert.match(markup, /data-tool-severity="calm"/);
  assert.match(markup, />Cancelled</);
});

test('running tool call row carries no severity attribute', () => {
  const markup = utils.buildToolCallRowMarkup(buildCallRow('running'), [], {});

  assert.match(markup, /data-tool-status="running"/);
  assert.doesNotMatch(markup, /data-tool-severity/);
});

test('errored paired result flips the row to danger with a coded notice + retry', () => {
  const markup = utils.buildToolCallRowMarkup(buildCallRow('running'), [], {
    pairedToolResultRow: buildResultRow({
      state: 'errored',
      is_error: true,
      error_code: 'CMP-ARGS-0001',
      result_summary: 'Invalid arguments',
    }),
    retryMessageId: 'assistant-latest',
    // A failed row renders collapsed, so its detail body is not materialized
    // until the reader opens it. These assertions are about the body's
    // content, so materialize it the way expanding the row does.
    forceMaterializeToolDetails: true,
  });

  assert.match(markup, /data-tool-status="errored"/);
  assert.match(markup, /data-tool-severity="danger"/);
  assert.match(markup, /data-tool-detail-section="true" data-tool-result-outcome="failure"/);
  assert.match(markup, /Invalid arguments/);
  assert.match(markup, /CMP-ARGS-0001/);
  assert.match(markup, /data-inv-error-action="retry"/);
  assert.match(markup, /Regenerate response/);
  assert.match(markup, /data-message-id="assistant-latest"/);
  assert.doesNotMatch(markup, /Error CMP-ARGS-0001:/);
  assert.doesNotMatch(markup, /role="alert"/);
});

test('a collapsed errored row states its failure in the header without materializing the body', () => {
  const markup = utils.buildToolCallRowMarkup(buildCallRow('running'), [], {
    pairedToolResultRow: buildResultRow({
      state: 'errored', is_error: true, error_code: 'CMP-ARGS-0001', result_summary: 'Invalid arguments',
    }),
    retryMessageId: 'assistant-latest',
  });

  assert.match(markup, /data-tool-details-materialized="false"/);
  assert.match(markup, /class="tool-call-failure-summary">Invalid arguments<\/span>/);
  assert.doesNotMatch(markup, /data-tool-detail-section/);
  assert.doesNotMatch(markup, /CMP-ARGS-0001/, 'the error code chip belongs to the body');
});

test('historical failed tool rows do not offer regeneration for another response', () => {
  const markup = utils.buildToolCallRowMarkup(buildCallRow('running'), [], {
    pairedToolResultRow: buildResultRow({
      state: 'errored', is_error: true, error_code: 'CMP-ARGS-0001', result_summary: 'Invalid arguments',
    }),
    // Materialized deliberately: without it a collapsed row renders no body at
    // all and both assertions below would hold for the wrong reason.
    forceMaterializeToolDetails: true,
  });
  assert.doesNotMatch(markup, /data-inv-error-action="retry"/);
  assert.doesNotMatch(markup, /Regenerate response/);
});

test('error notice without a code drops the prefix and renders no chip', () => {
  const markup = utils.buildToolCallRowMarkup(buildCallRow('running'), [], {
    pairedToolResultRow: buildResultRow({
      state: 'errored',
      is_error: true,
      result_summary: 'Tool blew up',
    }),
    forceMaterializeToolDetails: true,
  });

  assert.match(markup, /tool-call-section--error/);
  assert.match(markup, /Tool blew up/);
  assert.doesNotMatch(markup, /unknown/i);
  assert.doesNotMatch(markup, /tool-result-notice-code/);
});

test('error notice without code or summary falls back to Tool failed', () => {
  const markup = utils.buildToolCallRowMarkup(buildCallRow('running'), [], {
    pairedToolResultRow: buildResultRow({ state: 'errored', is_error: true }),
    forceMaterializeToolDetails: true,
  });

  assert.match(markup, /tool-call-section--error/);
  assert.match(markup, />Tool failed<\/code>/);
});

test('orphan failure result row carries danger severity and ERR icon', () => {
  const markup = utils.buildToolResultRowMarkup(
    buildResultRow({ is_error: true, error_code: 'CMP-TOOL-0008', result_summary: 'Failed' }),
    [],
    {}
  );

  assert.match(markup, /data-is-error="true"/);
  assert.match(markup, /data-tool-severity="danger"/);
  assert.match(markup, />ERR</);
});

test('orphan denied result row reads calm (user stop), not a danger crash', () => {
  const markup = utils.buildToolResultRowMarkup(
    buildResultRow({ is_error: true, error_code: 'CMP-TOOL-0001', result_summary: 'Denied by policy' }),
    [],
    {}
  );

  assert.match(markup, /data-tool-severity="calm"/);
  assert.match(markup, /data-tool-result-outcome="stopped"/);
  assert.match(markup, />OFF</);
  assert.doesNotMatch(markup, /role="alert"/);
  assert.doesNotMatch(markup, /data-inv-error-action="retry-tool"/);
});

test('orphan success result row carries no severity attribute', () => {
  const markup = utils.buildToolResultRowMarkup(buildResultRow({ output_text: 'ok' }), [], {});

  assert.match(markup, /data-is-error="false"/);
  assert.doesNotMatch(markup, /data-tool-severity/);
  assert.match(markup, />OK</);
});


/* Verification gate Wave 3: the verdict for a `verify` result renders on the
 * timeline row header from the result metadata alone (spec §3). */
test('verify result rows carry the gate verdict in the header meta slot', () => {
  const markup = utils.buildToolCallRowMarkup(
    buildCallRow('completed', { tool_name: 'verify', input_json: '{"action":"gate"}' }),
    [],
    {
      pairedToolResultRow: buildResultRow({
        tool_name: 'verify',
        state: 'completed',
        result_summary: 'Verification failed: unit (failed)',
        metadata: {
          result_kind: 'verify', status: 'failed', action: 'gate', config_id: 'unit',
          passed_count: 138, failed_count: 4, duration_ms: 21400, attempt: 2, gate_on_failure: 'retry',
        },
      }),
    }
  );
  assert.match(markup, /class="tool-call-meta">Gate · Failed · 4 of 142 · 21\.4s · attempt 2</);
});

test('non-verify result rows keep an empty meta slot', () => {
  const markup = utils.buildToolCallRowMarkup(buildCallRow('completed'), [], {
    pairedToolResultRow: buildResultRow({ metadata: { result_kind: 'verify', status: 'failed' } }),
  });
  assert.doesNotMatch(markup, /tool-call-meta/);
});

test('a settled propose_change row offers Review suggestion; a refused one does not', () => {
  // Row 35: settled suggestion rows render through this trace row, not the tool
  // shell, so without the affordance a suggestion was unreachable from Chat.
  const suggested = { suggested_change: { schema_version: 1, kind: 'replace', path: 'a.py' } };
  const call = { ...buildCallRow('completed', { tool_name: 'propose_change', input_json: '{"path":"a.py"}' }), turn_id: 'turn-1' };
  const ok = utils.buildToolCallRowMarkup(call, [], {
    pairedToolResultRow: buildResultRow({ tool_name: 'propose_change', metadata: suggested }),
  });
  assert.match(ok, /data-jenny-code-review/);
  assert.match(ok, /data-scope="suggested"/);
  assert.match(ok, /data-tool-call-id="call-1"/);
  const refused = utils.buildToolCallRowMarkup(call, [], {
    pairedToolResultRow: buildResultRow({ tool_name: 'propose_change', is_error: true, metadata: suggested }),
  });
  assert.doesNotMatch(refused, /data-jenny-code-review/);
  const plain = utils.buildToolCallRowMarkup({ ...buildCallRow('completed'), turn_id: 'turn-1' }, [], {
    pairedToolResultRow: buildResultRow(),
  });
  assert.doesNotMatch(plain, /data-jenny-code-review/);
});

test('a settled scripted or move row keeps Review changes in the trace row', () => {
  // Gate 2026-10-14: run_temp_script and move_file settle into this trace row,
  // which only offered the affordance for propose_change.
  const diff = (index, file) => ({
    diff_id: `scripted:call-1:${index}`, operation_index: index, path: file, status: 'modified', review_state: 'full',
    body_kind: 'inline_hunks', additions: 1, deletions: 1, truncated: false, truncation_reason: null,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
  });
  const scripted = utils.buildToolCallRowMarkup(
    { ...buildCallRow('completed', { tool_name: 'run_temp_script', input_json: '{"code":"x"}' }), turn_id: 'turn-1' }, [], {
      pairedToolResultRow: buildResultRow({ tool_name: 'run_temp_script', metadata: {
        diffs: [diff(0, 'a.txt'), diff(1, 'b.txt')],
        scripted_change_review: { schema_version: 1, state: 'observed', certainty: 'observed_during_call', call_outcome: 'succeeded',
          changed_paths: ['a.txt', 'b.txt'], changed_path_count: 2, diff_count: 2, summary_only_count: 0, omitted_count: 0,
          coverage: 'git_status_paths' },
      } }),
    });
  assert.match(scripted, /data-jenny-code-review/);
  assert.match(scripted, /data-scope="turn"/);
  const moved = utils.buildToolCallRowMarkup(
    { ...buildCallRow('completed', { tool_name: 'move_file', input_json: '{"source":"a.txt","destination":"b.txt"}' }), turn_id: 'turn-1' }, [], {
      pairedToolResultRow: buildResultRow({ tool_name: 'move_file', metadata: { diffs: [diff(0, 'b.txt')] } }),
    });
  assert.match(moved, /data-jenny-code-review/);
  const noTurn = utils.buildToolCallRowMarkup(buildCallRow('completed', { tool_name: 'move_file' }), [], {
    pairedToolResultRow: buildResultRow({ tool_name: 'move_file', metadata: { diffs: [diff(0, 'b.txt')] } }),
  });
  assert.doesNotMatch(noTurn, /data-jenny-code-review/);
});
