'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { escapeHtml } = require('../renderer/shared/string-utils');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const taskSpawnChip = require('../renderer/chat/renderer-task-spawn-chip');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');

function metadata(overrides = {}) {
  return {
    result_kind: 'task_board',
    status: 'ok',
    action: 'add',
    task_id: 'task-1',
    task_title: 'Ship the slice',
    ...overrides,
  };
}

function buildBlockLane(metadataValue) {
  const renderer = createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils });
  const toolUse = {
    id: 'use-1',
    kind: 'tool_use',
    tool_call: { call_id: 'call-1', tool_name: 'task_board', input: { action: 'add' }, status: 'completed' },
  };
  const toolResult = {
    id: 'result-1',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call-1',
      tool_name: 'task_board',
      output_text: 'Added task.',
      is_error: metadataValue?.status === 'failed',
      metadata: metadataValue,
    },
  };
  return renderer.renderToolCallBlock(toolUse, [toolUse, toolResult]);
}

function buildActivityLane(metadataValue) {
  const renderer = createTurnRowToolRenderUtils({ escapeHtml });
  return renderer.buildToolCallRowMarkup({
    row_id: 'row-1',
    turn_id: 'turn-1',
    tool_call_id: 'call-1',
    payload: {
      tool_call_id: 'call-1',
      tool_name: 'task_board',
      state: 'completed',
      input: { action: 'add' },
    },
  }, [], {
    pairedToolResultRow: {
      primary_message_id: 'result-1',
      payload: {
        tool_call_id: 'call-1',
        tool_name: 'task_board',
        output_text: 'Added task.',
        result_is_error: metadataValue?.status === 'failed',
        metadata: metadataValue,
      },
    },
  });
}

test('task_board add renders the spawn strip in both transcript lanes', (t) => {
  const previousRail = globalThis.rendererTaskRailActions;
  t.after(() => { globalThis.rendererTaskRailActions = previousRail; });
  globalThis.rendererTaskRailActions = { open() {} };

  for (const html of [buildBlockLane(metadata()), buildActivityLane(metadata())]) {
    assert.match(html, /jenny-task-spawn-strip/);
    assert.match(html, /Ship the slice/);
    assert.match(html, /Start a session/);
    assert.match(html, /Show in Tasks/);
  }
});

test('spawn strip is limited to successful task_board add results', () => {
  const rejected = [
    metadata({ action: 'update' }),
    metadata({ action: 'complete' }),
    metadata({ action: 'list' }),
    metadata({ status: 'failed' }),
    metadata({ result_kind: 'verify' }),
    undefined,
  ];
  for (const value of rejected) {
    assert.doesNotMatch(buildBlockLane(value), /jenny-task-spawn-strip/);
    assert.doesNotMatch(buildActivityLane(value), /jenny-task-spawn-strip/);
  }
});

test('linked task renders the used state and task titles are escaped', () => {
  const used = taskSpawnChip.renderTaskSpawnChipStrip({ metadata: metadata() }, {
    escapeHtml,
    getLinkedSessionId: () => 'session-1',
  });
  assert.match(used, /jenny-task-spawn-strip--used/);
  assert.match(used, /Session drafted/);
  assert.match(used, /Open session/);
  assert.match(used, /Mark done/);
  assert.doesNotMatch(used, /Start a session/);

  const unsafe = taskSpawnChip.renderTaskSpawnChipStrip({
    metadata: metadata({ task_title: '<img src=x onerror=1>' }),
  }, { escapeHtml });
  assert.match(unsafe, /&lt;img src=x onerror=1&gt;/);
  assert.doesNotMatch(unsafe, /<img/);
});

test('Start creates one linked session while the strip is busy', async (t) => {
  const dom = new JSDOM('<div id="timeline"></div>');
  const container = dom.window.document.getElementById('timeline');
  const calls = [];
  let finishStart;
  const previousActions = globalThis.rendererTaskSessionActions;
  t.after(() => {
    globalThis.rendererTaskSessionActions = previousActions;
    dom.window.close();
  });
  globalThis.rendererTaskSessionActions = {
    start(options) {
      calls.push(options);
      return new Promise((resolve) => { finishStart = resolve; });
    },
  };
  container.innerHTML = taskSpawnChip.renderTaskSpawnChipStrip({ metadata: metadata() }, { escapeHtml });
  taskSpawnChip.bindTaskSpawnChip(container, {});
  const button = container.querySelector('[data-jenny-task-spawn="start"]');
  button.click();
  button.click();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].linkedTaskId, 'task-1');
  assert.match(calls[0].initialPrompt, /Jenny task id: task-1/);
  finishStart();
  await new Promise((resolve) => setImmediate(resolve));
});

test('chat-shell task notes flow into chip briefs without an empty notes block', async (t) => {
  const app = await loadRendererApp({ persistedActiveView: 'chat' });
  t.after(() => app.dispose());
  await waitForUi(app.window, 20);
  const calls = [];
  app.window.rendererTaskSessionActions = { start: (options) => calls.push(options) };
  app.window.__rendererState.companion = {
    openLoopsBoard: {
      active: [{ followUpId: 'task-1', body: 'Do it carefully' }],
      deferred: [], recentResolved: [], archived: [],
    },
  };
  const timeline = app.window.document.getElementById('chatTimeline');
  timeline.innerHTML = app.window.rendererTaskSpawnChip.renderTaskSpawnChipStrip({ metadata: metadata() });
  timeline.querySelector('[data-jenny-task-spawn="start"]').click();
  assert.match(calls[0].initialPrompt, /Do it carefully/);

  app.window.__rendererState.companion = { openLoopsBoard: { active: [], deferred: [], recentResolved: [], archived: [] } };
  timeline.innerHTML = app.window.rendererTaskSpawnChip.renderTaskSpawnChipStrip({ metadata: metadata() });
  timeline.querySelector('[data-jenny-task-spawn="start"]').click();
  assert.match(calls[1].initialPrompt, /^Ship the slice\n\n---\nJenny task id: task-1/);
});

test('Mark done resolves the task and notifies the board', async (t) => {
  const dom = new JSDOM('<div id="timeline"></div>');
  const container = dom.window.document.getElementById('timeline');
  const resolved = [];
  let mutations = 0;
  const previousWindow = globalThis.window;
  const previousBoard = globalThis.rendererTaskBoard;
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.rendererTaskBoard = previousBoard;
    dom.window.close();
  });
  globalThis.window = dom.window;
  dom.window.jennyShell = { companion: { resolveFollowUp: async (id) => resolved.push(id) } };
  globalThis.rendererTaskBoard = { notifyMutation: () => { mutations += 1; } };
  container.innerHTML = taskSpawnChip.renderTaskSpawnChipStrip({ metadata: metadata() }, {
    escapeHtml,
    getLinkedSessionId: () => 'session-1',
  });
  taskSpawnChip.bindTaskSpawnChip(container, {});
  container.querySelector('[data-jenny-task-spawn="done"]').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resolved, ['task-1']);
  assert.equal(mutations, 1);
});

test('missing Tasks rail omits Show in Tasks without affecting other actions', async (t) => {
  const dom = new JSDOM('<div id="timeline"></div>');
  const container = dom.window.document.getElementById('timeline');
  const calls = [];
  const previousRail = globalThis.rendererTaskRailActions;
  const previousActions = globalThis.rendererTaskSessionActions;
  t.after(() => {
    globalThis.rendererTaskRailActions = previousRail;
    globalThis.rendererTaskSessionActions = previousActions;
    dom.window.close();
  });
  delete globalThis.rendererTaskRailActions;
  globalThis.rendererTaskSessionActions = { start: async (options) => calls.push(options) };
  const html = taskSpawnChip.renderTaskSpawnChipStrip({ metadata: metadata() }, { escapeHtml });
  assert.doesNotMatch(html, /Show in Tasks/);
  container.innerHTML = html;
  taskSpawnChip.bindTaskSpawnChip(container, {});
  container.querySelector('[data-jenny-task-spawn="start"]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
});

test('task_board add result formats a compact header meta label', () => {
  assert.equal(toolCallUtils.formatToolResultMeta('task_board', metadata()), 'task added');
});
