'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const calendarBlock = require('../renderer/chat/renderer-calendar-chat-block');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');

const TURN_RENDERER_PATH = require.resolve('../renderer/chat/renderer-turn-row-tool-render-utils');
const TRANSCRIPT_RENDERER_PATH = require.resolve('../renderer/chat/renderer-transcript-tool-calls');
const RENDERER_PATHS = new Set([TURN_RENDERER_PATH, TRANSCRIPT_RENDERER_PATH]);
const previousActionButton = globalThis.inventoryActionButton;

globalThis.inventoryActionButton = actionButton;
test.after(() => {
  if (previousActionButton === undefined) delete globalThis.inventoryActionButton;
  else globalThis.inventoryActionButton = previousActionButton;
});

function withFreshRendererModules(calendarModule, callback) {
  const previousCalendarBlock = globalThis.rendererCalendarChatBlock;
  const originalLoad = Module._load;
  globalThis.rendererCalendarChatBlock = calendarModule;
  Module._load = function load(request, parent, isMain) {
    if (calendarModule === null && request === './renderer-calendar-chat-block'
      && RENDERER_PATHS.has(parent?.filename)) return null;
    return originalLoad.call(this, request, parent, isMain);
  };
  for (const modulePath of RENDERER_PATHS) delete require.cache[modulePath];
  try {
    return callback({
      turn: require(TURN_RENDERER_PATH),
      transcript: require(TRANSCRIPT_RENDERER_PATH),
    });
  } finally {
    Module._load = originalLoad;
    if (previousCalendarBlock === undefined) delete globalThis.rendererCalendarChatBlock;
    else globalThis.rendererCalendarChatBlock = previousCalendarBlock;
    for (const modulePath of RENDERER_PATHS) delete require.cache[modulePath];
  }
}

function createRenderers(modules) {
  return {
    turn: modules.turn.createTurnRowToolRenderUtils({
      escapeHtml,
      normalizeId: (value) => String(value || '').trim(),
      formatDurationMs: () => '',
      renderArtifactTeaser: () => '',
      buildToolMarkerBannerMarkup: () => '',
    }),
    transcript: modules.transcript.createTranscriptToolCallRenderer({
      escapeHtml,
      toolCallUtils,
    }),
  };
}

function calendarMetadata() {
  return {
    result_kind: 'home',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07T00:00',
      range_end: '2026-09-13T00:00',
      generated_at: '2026-09-07T11:00',
      instance_count: 1,
      omitted_count: 0,
      instances: [{
        instance_id: 'instance-1',
        event_id: 'event-1',
        title: 'Design review',
        start: '2026-09-08T13:00',
        end: '2026-09-08T14:00',
        category: 'work',
        source: 'local',
        source_kind: 'user',
        kind: 'event',
      }],
    },
  };
}

function receiptMetadata() {
  return {
    result_kind: 'home',
    calendar_receipt: {
      schema_version: 1,
      kind: 'event',
      op: 'create',
      id: 'event-new',
      title: 'Design review',
      start: '2026-09-09T15:00',
      end: '2026-09-09T16:00',
      category: 'meeting',
    },
  };
}

function renderBoth(modules, options = {}) {
  const renderers = createRenderers(modules);
  const toolName = options.toolName || 'home';
  const callId = options.callId || `call-${toolName}`;
  const toolUseMessage = {
    id: `tool-use-${callId}`,
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: callId,
      tool_name: toolName,
      status: options.withResult === false ? 'running' : 'completed',
      input: { action: options.action || 'calendar_list' },
    },
  };
  const resultMessage = options.withResult === false ? null : {
    id: `tool-result-${callId}`,
    role: 'tool',
    kind: 'tool_result',
    tool_result: {
      call_id: callId,
      tool_name: toolName,
      output_text: '{}',
      summary: 'Done',
      is_error: false,
      generated_artifacts: [],
      metadata: options.metadata || {},
    },
  };
  const pairedToolResultRow = resultMessage && {
    primary_message_id: resultMessage.id,
    payload: {
      tool_call_id: callId,
      tool_name: toolName,
      output_text: '{}',
      result_summary: 'Done',
      is_error: false,
      generated_artifacts: [],
      metadata: options.metadata || {},
    },
  };
  const messages = resultMessage ? [toolUseMessage, resultMessage] : [toolUseMessage];
  return {
    turn: renderers.turn.buildToolCallRowMarkup({
      turn_id: `turn-${callId}`,
      row_id: `row-${callId}`,
      primary_message_id: toolUseMessage.id,
      payload: {
        tool_call_id: callId,
        tool_name: toolName,
        state: options.withResult === false ? 'running' : 'completed',
        input: toolUseMessage.tool_call.input,
      },
    }, messages, {
      pairedToolResultRow,
      forceMaterializeToolDetails: options.forceMaterialize === true,
    }),
    transcript: renderers.transcript.renderToolCallBlock(toolUseMessage, messages, {
      forceMaterializeToolDetails: options.forceMaterialize === true,
    }),
  };
}

function documentFor(markup) {
  return new JSDOM(`<main>${markup}</main>`).window.document;
}

function assertCalendarOutsideTurnBody(markup, expectedKind) {
  const document = documentFor(markup);
  const row = document.querySelector('.tool-call-row');
  const header = row.querySelector('.tool-call-row-header');
  const body = row.querySelector('.tool-call-row-body');
  const calendar = row.querySelector('.cal-chat');
  assert.equal(row.getAttribute('data-expanded'), 'false');
  assert.equal(calendar.getAttribute('data-cal-chat'), expectedKind);
  assert.equal(body.contains(calendar), false);
  assert.equal(header.nextElementSibling, calendar);
  assert.equal(calendar.nextElementSibling, body);
}

function assertCalendarOutsideTranscriptDetails(markup, expectedKind, materialized) {
  const document = documentFor(markup);
  const block = document.querySelector('.tool-call-block');
  const header = block.querySelector('.tool-call-header');
  const details = block.querySelector('.tool-call-details');
  const calendar = block.querySelector('.cal-chat');
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.equal(block.getAttribute('data-tool-details-materialized'), String(materialized));
  assert.equal(calendar.getAttribute('data-cal-chat'), expectedKind);
  assert.equal(details.contains(calendar), false);
  assert.equal(details.nextElementSibling, calendar);
}

test('calendar_list renders outside collapsed detail bodies in both tool render paths', () => {
  withFreshRendererModules(calendarBlock, (modules) => {
    const markup = renderBoth(modules, { metadata: calendarMetadata() });
    assertCalendarOutsideTurnBody(markup.turn, 'list');
    assertCalendarOutsideTranscriptDetails(markup.transcript, 'list', false);

    const materialized = renderBoth(modules, {
      metadata: calendarMetadata(),
      forceMaterialize: true,
      callId: 'call-home-materialized',
    });
    assertCalendarOutsideTranscriptDetails(materialized.transcript, 'list', true);
  });
});

test('calendar receipts render outside detail bodies in both tool render paths', () => {
  withFreshRendererModules(calendarBlock, (modules) => {
    const markup = renderBoth(modules, { metadata: receiptMetadata(), forceMaterialize: true });
    assertCalendarOutsideTurnBody(markup.turn, 'receipt');
    assertCalendarOutsideTranscriptDetails(markup.transcript, 'receipt', true);
  });
});

test('scratchpad, malformed calendar, and resultless home calls render no calendar block', () => {
  withFreshRendererModules(calendarBlock, (modules) => {
    const cases = [
      { action: 'scratchpad_read', metadata: { result_kind: 'home', action: 'scratchpad_read' } },
      {
        metadata: {
          result_kind: 'home',
          calendar: { schema_version: 1, range_start: 'bad', range_end: null, instances: {} },
        },
      },
      { withResult: false },
    ];
    for (const options of cases) {
      let markup;
      assert.doesNotThrow(() => { markup = renderBoth(modules, options); });
      assert.doesNotMatch(markup.turn, /class="cal-chat/);
      assert.doesNotMatch(markup.transcript, /class="cal-chat/);
    }
  });
});

test('non-home tool markup is byte-identical with and without the calendar module', () => {
  const withModule = withFreshRendererModules(calendarBlock, (modules) => renderBoth(modules, {
    toolName: 'read_file',
    action: 'read',
    metadata: { result_kind: 'file', path: 'README.md' },
  }));
  const withoutModule = withFreshRendererModules(null, (modules) => renderBoth(modules, {
    toolName: 'read_file',
    action: 'read',
    metadata: { result_kind: 'file', path: 'README.md' },
  }));

  assert.equal(withModule.turn, withoutModule.turn);
  assert.equal(withModule.transcript, withoutModule.transcript);
});
