'use strict';

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

function buildMonitorMessages(state = 'running') {
  const toolUseMessage = {
    id: 'tool_use_monitor',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_monitor',
      tool_name: 'monitor',
      input: {
        description: 'Watch yt-dlp progress',
        timeout_ms: 180000,
        persistent: false,
      },
      input_json: '{"description":"Watch yt-dlp progress","timeout_ms":180000,"persistent":false}',
      summary: 'Watch yt-dlp progress',
      status: state === 'running' ? 'running' : 'completed',
    },
  };
  const toolResultMessage = {
    id: 'tool_result_monitor',
    role: 'tool',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_monitor',
      tool_name: 'monitor',
      output_text: 'Monitor started.',
      summary: 'Watch yt-dlp progress',
      is_error: false,
      duration_ms: 0,
      generated_artifacts: [],
      metadata: {
        monitor: {
          version: 1,
          monitor_id: 'mon_1',
          description: 'Watch yt-dlp progress',
          state,
          persistent: false,
          timeout_ms: 180000,
          event_count: 2,
          dropped_event_count: 0,
          events: [
            {
              sequence: 1,
              stream: 'stdout',
              text: 'Downloading item 1 of 20',
              timestamp: '2026-05-16T00:00:00.000Z',
              elapsed_ms: 100,
            },
            {
              sequence: 2,
              stream: 'stdout',
              text: 'Destination: track.mp3',
              timestamp: '2026-05-16T00:00:04.000Z',
              elapsed_ms: 4100,
            },
          ],
        },
      },
    },
  };
  return { toolUseMessage, toolResultMessage };
}

test('monitor tool renders a dedicated compact event row', () => {
  const renderer = createRenderer();
  const { toolUseMessage, toolResultMessage } = buildMonitorMessages('running');

  const html = renderer.renderToolCallBlock(
    toolUseMessage,
    [toolUseMessage, toolResultMessage],
    { forceMaterializeToolDetails: true }
  );

  assert.match(html, /tool-monitor-panel/);
  assert.match(html, /Watch yt-dlp progress/);
  assert.match(html, /Downloading item 1 of 20/);
  assert.match(html, /Destination: track\.mp3/);
  assert.match(html, /data-monitor-state="running"/);
});

test('monitor view model exposes monitor metadata for message_updated refreshes', () => {
  const renderer = createRenderer();
  const { toolUseMessage, toolResultMessage } = buildMonitorMessages('completed');

  const viewModel = renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage, toolResultMessage]
  );

  assert.equal(viewModel.toolKind, 'monitor');
  assert.equal(viewModel.metadata.monitor.state, 'completed');
  assert.equal(viewModel.metadata.monitor.events.length, 2);
});
