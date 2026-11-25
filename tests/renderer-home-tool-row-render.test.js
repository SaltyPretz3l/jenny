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
      sessionId: options.sessionId,
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

function notesMetadata(overrides = {}) {
  return {
    result_kind: 'project_notes',
    action: 'append',
    status: 'ok',
    project_id: 'proj-1',
    revision: 3,
    journal_entry_id: 'entry-3',
    summary: 'Added the release checklist',
    lines: { added: 2, removed: 0, changed: 0 },
    ...overrides,
  };
}

test('project notes writes render the notes row outside detail bodies in both tool render paths', () => {
  withFreshRendererModules(calendarBlock, (modules) => {
    const markup = renderBoth(modules, {
      toolName: 'project_notes', action: 'append', metadata: notesMetadata(), forceMaterialize: true,
    });
    const turn = documentFor(markup.turn);
    const turnRow = turn.querySelector('.tool-call-row');
    const turnNotes = turnRow.querySelector('.notes-chat__row');
    assert.equal(turnNotes.dataset.notesProject, 'proj-1');
    assert.equal(turnRow.querySelector('.tool-call-row-body').contains(turnNotes), false);
    assert.ok(turnNotes.querySelector('[data-notes-undo="entry-3"]'));
    // Row 192: an own-content row never folds under the steps heading either, so it is stamped in every view.
    assert.equal(turnRow.getAttribute('data-run-foldable'), 'false');

    const transcript = documentFor(markup.transcript);
    const block = transcript.querySelector('.tool-call-block');
    const transcriptNotes = block.querySelector('.notes-chat__row');
    assert.equal(transcriptNotes.querySelector('.notes-chat__meta').textContent, '+2 lines \u00b7 Added the release checklist');
    assert.equal(block.querySelector('.tool-call-details').contains(transcriptNotes), false);
  });
});

test('project notes reads and failures render no notes row in either path', () => {
  withFreshRendererModules(calendarBlock, (modules) => {
    for (const metadata of [notesMetadata({ action: 'read' }), notesMetadata({ status: 'failed' })]) {
      const markup = renderBoth(modules, { toolName: 'project_notes', action: 'read', metadata });
      assert.doesNotMatch(markup.turn, /notes-chat__row/);
      assert.doesNotMatch(markup.transcript, /notes-chat__row/);
    }
  });
});

// Row 178 (owner pick D4): a finished terminal_run row links to the chat's Terminal panel, only while the panel API exists.
const cardsModule = require('../renderer/chat/renderer-approval-block-cards');

function withTerminalPanel(panel, callback) {
  const previous = {
    panel: globalThis.rendererChatTerminalPanel, cards: globalThis.rendererApprovalBlockCards,
  };
  if (panel) globalThis.rendererChatTerminalPanel = panel; else delete globalThis.rendererChatTerminalPanel;
  globalThis.rendererApprovalBlockCards = cardsModule;
  try {
    return callback();
  } finally {
    for (const [name, value] of [['rendererChatTerminalPanel', previous.panel], ['rendererApprovalBlockCards', previous.cards]]) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
}

const terminalRow = (modules, terminal, metadata = {}) => renderBoth(modules, {
  toolName: 'terminal_run', action: 'run', sessionId: 'chat-7', metadata: { result_kind: 'terminal_run', status: 'ok', terminal, ...metadata },
}).turn;

test('a finished terminal_run row offers Open in terminal for its own terminal while the panel exists', () => {
  withFreshRendererModules(calendarBlock, (modules) => withTerminalPanel({ open: () => Promise.resolve(true) }, () => {
    const link = documentFor(terminalRow(modules, 2)).querySelector('[data-terminal-open-slot]');
    assert.ok(link, 'the link is drawn');
    assert.equal(link.getAttribute('data-terminal-open-slot'), '2');
    assert.equal(link.getAttribute('data-terminal-open-session'), 'chat-7');
    assert.equal(link.textContent.trim(), 'Open in terminal');
    assert.equal(link.tagName, 'BUTTON');
  }));
});

test('the Open in terminal link is absent without the panel, without an integer terminal, and on other tools', () => {
  withFreshRendererModules(calendarBlock, (modules) => {
    withTerminalPanel(null, () => assert.doesNotMatch(terminalRow(modules, 2), /data-terminal-open-slot/));
    withTerminalPanel({ open: () => Promise.resolve(true) }, () => {
      for (const terminal of [null, undefined, '2', 0, -1, 1.5, 100]) {
        assert.doesNotMatch(terminalRow(modules, terminal), /data-terminal-open-slot/, String(terminal));
      }
      assert.doesNotMatch(renderBoth(modules, { toolName: 'terminal_read', metadata: { result_kind: 'terminal_read', terminal: 2 } }).turn, /data-terminal-open-slot/);
    });
  });
});

test('a click on the link opens that chat\'s terminal tab; a click elsewhere, or with no panel, does nothing', async () => {
  const dom = new JSDOM('<main><button data-terminal-open-slot="3" data-terminal-open-session="chat-7"><span id="inner">Open</span></button><p id="other">x</p></main>');
  const { document } = dom.window;
  const calls = [];
  const windowRef = { rendererChatTerminalPanel: { open: (options) => { calls.push(options); return Promise.resolve(true); } } };
  const click = (target) => cardsModule.handleTerminalOpenClick({ target, preventDefault() {} }, windowRef);
  assert.equal(click(document.getElementById('inner')), true);
  assert.equal(click(document.getElementById('other')), false);
  assert.deepEqual(calls, [{ slot: 3, sessionId: 'chat-7' }]);
  assert.equal(cardsModule.handleTerminalOpenClick({ target: document.getElementById('inner'), preventDefault() {} }, {}), false);
  const rejecting = { rendererChatTerminalPanel: { open: () => Promise.reject(new Error('boom')) } };
  assert.equal(cardsModule.handleTerminalOpenClick({ target: document.getElementById('inner'), preventDefault() {} }, rejecting), true, 'a failing open never throws');
  await new Promise((resolve) => setImmediate(resolve));
  const bound = new JSDOM('<main><button data-terminal-open-slot="1">Open</button></main>');
  const live = [];
  assert.equal(cardsModule.bindTerminalOpenLinks(bound.window.document, { rendererChatTerminalPanel: { open: (options) => { live.push(options); return true; } } }), true);
  assert.equal(cardsModule.bindTerminalOpenLinks(bound.window.document, {}), false, 'bound once per document');
  bound.window.document.querySelector('button').click();
  assert.deepEqual(live, [{ slot: 1 }]);
});
