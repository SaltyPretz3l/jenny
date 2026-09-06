'use strict';

// R2-12 + F16 on the legacy transcript path. Lives beside, not inside,
// renderer-transcript-tool-calls.test.js, which sits at the file-size cap.

const assert = require('node:assert/strict');
const test = require('node:test');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const {
  createTranscriptToolCallRenderer,
} = require('../renderer/chat/renderer-transcript-tool-calls');

function createRenderer() {
  return createTranscriptToolCallRenderer({
    escapeHtml,
    toolCallUtils,
  });
}

test('legacy view model carries the one-line failure summary and the reconciled display name', () => {
  const renderer = createRenderer();
  const toolUseMessage = {
    id: 'tool_use_call_fail',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_fail',
      tool_name: 'run_command',
      tool_display_name: 'Run Command',
      input: { command: 'npm test' },
      input_json: '{"command":"npm test"}',
      status: 'errored',
    },
  };
  const toolResultMessage = {
    id: 'tool_result_call_fail',
    role: 'assistant',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_fail',
      tool_name: 'run_command',
      output_text: 'npm ERR! missing script: test\nnpm ERR! more',
      summary: 'exit 1',
      is_error: true,
      error_code: 'CMP-TOOL-0009',
    },
  };

  const viewModel = renderer.buildToolCallViewModel(toolUseMessage, [toolUseMessage, toolResultMessage]);
  assert.equal(viewModel.isError, true);
  assert.equal(viewModel.failureSummary, 'npm ERR! missing script: test');
  // F16: the renderer alias wins over the catalog name the sidecar sent, so
  // the legacy path labels this row exactly like the row-model path does.
  assert.equal(viewModel.displayToolName, 'Bash');
  const header = renderer.renderToolCallBlock(toolUseMessage, [toolUseMessage, toolResultMessage], {
    sessionId: 'session-a', turnId: 'turn-a', rowId: 'row-a',
  });
  assert.match(header, /class="tool-call-failure-summary">npm ERR! missing script: test<\/span>/);
  assert.match(header, /data-tool-details-materialized="false"/);

  const completed = renderer.buildToolCallViewModel(
    { ...toolUseMessage, tool_call: { ...toolUseMessage.tool_call, status: 'completed' } },
    [{ ...toolUseMessage, tool_call: { ...toolUseMessage.tool_call, status: 'completed' } }]
  );
  assert.equal(completed.failureSummary, '');
});
