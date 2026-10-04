'use strict';

// Answers tool runs (NEXT_STEPS row 21): pure run grouping and the summary
// sentence in tool-call-utils, and the flat run markup the row-list builder
// emits in the Answers view only.

const test = require('node:test');
const assert = require('node:assert/strict');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { createTurnRowListUtils } = require('../renderer/chat/renderer-turn-row-list-utils');
const toolRenderUtils = require('../renderer/chat/renderer-turn-row-tool-render-utils');

test('search tools resolve to their Glob and Grep kinds', () => {
  assert.equal(toolCallUtils.normalizeToolKind('glob_files'), 'Glob');
  assert.equal(toolCallUtils.normalizeToolKind('grep_search'), 'Grep');
  assert.equal(toolCallUtils.formatToolCallSummary('grep_search', { pattern: 'approval_resolved' }), 'Search for approval_resolved');
  assert.equal(toolCallUtils.formatToolCallSummary('glob_files', { pattern: '**/*.css' }), 'Scan **/*.css');
});

test('groupToolRuns folds two or more members and keeps interior transparent rows', () => {
  const runs = toolCallUtils.groupToolRuns([
    { role: 'break' },
    { role: 'transparent' },
    { role: 'member' },
    { role: 'transparent' },
    { role: 'member' },
    { role: 'member' },
    { role: 'transparent' },
    { role: 'break' },
    { role: 'member' },
  ]);
  assert.deepEqual(runs, [{ members: [2, 4, 5], interior: [3] }]);
});

test('groupToolRuns never folds a single member and a time divider breaks a run', () => {
  assert.deepEqual(toolCallUtils.groupToolRuns([{ role: 'member' }, { role: 'break' }, { role: 'member' }]), []);
  assert.deepEqual(toolCallUtils.groupToolRuns([
    { role: 'member' }, { role: 'member', breakBefore: true }, { role: 'member' },
  ]), [{ members: [1, 2], interior: [] }]);
});

test('isToolRunFoldable keeps approvals, questions and content rows out of runs', () => {
  assert.equal(toolCallUtils.isToolRunFoldable({ toolName: 'read_file', status: 'completed' }), true);
  assert.equal(toolCallUtils.isToolRunFoldable({ toolName: 'run_command', status: 'awaiting_approval' }), false);
  assert.equal(toolCallUtils.isToolRunFoldable({ toolName: 'run_command', status: 'completed', approvalRequested: true }), false);
  assert.equal(toolCallUtils.isToolRunFoldable({ toolName: 'ask_user', status: 'completed' }), false);
  assert.equal(toolCallUtils.isToolRunFoldable({ toolName: 'image_generate', status: 'completed' }), false);
  assert.equal(toolCallUtils.isToolRunFoldable({ toolName: 'read_file', status: 'completed', hasOwnContent: true }), false);
});

test('summarizeToolRun writes one sentence in first-appearance order with plurals', () => {
  const summary = toolCallUtils.summarizeToolRun([
    { tool: 'grep_search', status: 'completed', durationMs: 400 },
    { tool: 'read_file', status: 'completed', durationMs: 100 },
    { tool: 'read_file', status: 'completed', durationMs: 100 },
    { tool: 'glob_files', status: 'completed', durationMs: 300 },
    { tool: 'run_command', status: 'completed', durationMs: 11200 },
    { tool: 'lsp', toolLabel: 'Lsp', status: 'completed' },
    { tool: 'lsp', toolLabel: 'Lsp', status: 'completed' },
  ]);
  assert.equal(summary.sentence, 'Searched 2 times, read 2 files, ran a command, used Lsp 2 times');
  assert.equal(summary.failedCount, 0);
  assert.equal(summary.live, false);
  assert.equal(summary.durationMs, 12100);
  assert.equal(toolCallUtils.formatToolRunDuration(summary.durationMs), '12s');
  assert.equal(toolCallUtils.toolRunState(summary), 'ok');
});

test('a recovered failure counts without turning the run red; a final failure does', () => {
  const recovered = toolCallUtils.summarizeToolRun([
    { tool: 'run_command', status: 'errored', isError: true },
    { tool: 'edit_file', status: 'completed' },
    { tool: 'run_command', status: 'completed' },
  ]);
  assert.equal(recovered.failedCount, 1);
  assert.equal(recovered.lastFailed, false);
  assert.equal(toolCallUtils.toolRunState(recovered), 'ok');

  const ended = toolCallUtils.summarizeToolRun([
    { tool: 'read_file', status: 'completed' },
    { tool: 'run_command', status: 'error' },
  ]);
  assert.equal(ended.failedCount, 1);
  assert.equal(ended.lastFailed, true);
  assert.equal(toolCallUtils.toolRunState(ended), 'failed');
  assert.match(toolCallUtils.buildToolRunToggleInner(ended), /status-dot--error[\s\S]*tool-run-failed">1 failed</);

  // Failure follows the one-liner's error tone: a timeout (amber), a stop or
  // a denial (muted) is not reported as failed and never turns the run red.
  for (const status of ['timeout', 'timed_out', 'interrupted', 'denied', 'cancelled']) {
    const stopped = toolCallUtils.summarizeToolRun([{ tool: 'read_file', status: 'completed' }, { tool: 'run_command', status }]);
    assert.equal(stopped.failedCount, 0, status);
    assert.equal(toolCallUtils.toolRunState(stopped), 'ok', status);
  }
});

// F16: real rows mark every non-success result data-is-error="true"; a call the
// approval window dropped (CMP-TOOL-0042) never ran and must not read "1 failed".
test('a call the approval window dropped reads Cancelled and is not counted as failed', () => {
  const status = toolCallUtils.statusForToolResult({ error_code: 'CMP-TOOL-0042', is_error: true });
  assert.equal(status, 'cancelled');
  const run = toolCallUtils.summarizeToolRun([
    { tool: 'run_command', status: 'completed' },
    { tool: 'read_file', status, isError: true },
    { tool: 'read_file', status: 'completed' },
  ]);
  assert.equal(run.failedCount, 0);
  assert.equal(toolCallUtils.toolRunState(run), 'ok');
  assert.doesNotMatch(toolCallUtils.buildToolRunToggleInner(run), /tool-run-failed/);
  // A real failure, and an error with no status word, still count.
  assert.equal(toolCallUtils.summarizeToolRun([{ tool: 'read_file', status: 'errored', isError: true }]).failedCount, 1);
  assert.equal(toolCallUtils.summarizeToolRun([{ tool: 'read_file', status: '', isError: true }]).failedCount, 1);
});

test('a live run shows the running step with a ticking elapsed node and a done count', () => {
  const summary = toolCallUtils.summarizeToolRun([
    { tool: 'read_file', status: 'completed' },
    { tool: 'run_command', status: 'running', label: 'Run npm test', startedAtMs: 1000 },
  ]);
  assert.equal(summary.live, true);
  assert.equal(summary.liveLabel, 'Run npm test');
  assert.equal(summary.doneCount, 1);
  const inner = toolCallUtils.buildToolRunToggleInner(summary, { now: () => 10000 });
  assert.match(inner, /status-dot--active/);
  assert.match(inner, /class="tool-run-summary shimmer-active">Run npm test</);
  assert.match(inner, />1 done</);
  assert.match(inner, /data-turn-elapsed="true" data-elapsed-started-at="1000" data-elapsed-running="true">0:09</);
});

function toolRow(callId, toolName, extra = {}) {
  return {
    row_id: `row:${callId}`,
    turn_id: 'turn-1',
    kind: 'tool_call',
    tool_call_id: callId,
    payload: { tool_call_id: callId, tool_name: toolName, state: 'completed', input: extra.input || {}, ...(extra.payload || {}) },
  };
}

function createList() {
  return createTurnRowListUtils({
    buildRowId: (row) => `${row.turn_id}:${row.kind}:${row.tool_call_id || row.row_id}`,
    buildRowBodyMarkup(row) {
      if (row.kind === 'assistant_text') return `<p>${row.payload.text}</p>`;
      if (row.kind === 'reasoning') return '<div class="reasoning-row-stack">Thinking</div>';
      const status = row.payload.state;
      const own = row.payload.own_content ? ' data-run-foldable="false"' : '';
      return `<div class="tool-call-row tool-call-row--minimal" data-tool-status="${status}" data-is-error="${status === 'errored'}"${own}>${row.payload.tool_name}</div>`;
    },
  });
}

function rowOpenTag(html, id) {
  return new RegExp(`<div class="chat-row" [^>]*data-row-id="${id}"[^>]*>`).exec(html)[0];
}

const RUN_ROWS = [
  { row_id: 'row:intro', turn_id: 'turn-1', kind: 'assistant_text', payload: { text: 'Let me look.' } },
  toolRow('c1', 'grep_search', { input: { pattern: 'x' } }),
  { row_id: 'row:think', turn_id: 'turn-1', kind: 'reasoning', payload: {} },
  toolRow('c2', 'read_file', { input: { path: 'a.js' } }),
  toolRow('c3', 'run_command', { input: { command: 'npm test' }, payload: { state: 'errored' } }),
  { row_id: 'row:answer', turn_id: 'turn-1', kind: 'assistant_text', payload: { text: 'Found it.' } },
];

test('Thinking and Everything markup carries no run rows or run attributes', () => {
  const list = createList();
  for (const transcriptView of ['thinking', 'everything', undefined]) {
    const html = list.buildTurnRowListMarkup(RUN_ROWS, [], { transcriptView, sessionId: 's1' });
    assert.doesNotMatch(html, /tool_run|data-run-/);
  }
});

test('Answers emits one flat summary row before the run and stamps its members', () => {
  const html = createList().buildTurnRowListMarkup(RUN_ROWS, [], { transcriptView: 'answers', sessionId: 's1' });
  const rowIds = Array.from(html.matchAll(/data-row-id="([^"]+)"/g), (match) => match[1]);
  assert.deepEqual(rowIds, [
    'turn-1:assistant_text:row:intro',
    'turn-1:tool_run:c1',
    'turn-1:tool_call:c1',
    'turn-1:reasoning:row:think',
    'turn-1:tool_call:c2',
    'turn-1:tool_call:c3',
    'turn-1:assistant_text:row:answer',
  ]);
  const openTag = (id) => rowOpenTag(html, id);
  assert.match(openTag('turn-1:tool_call:c1'), /data-run-id="c1"[^>]*data-run-member="step"[^>]*data-run-tool="grep_search"/);
  assert.match(openTag('turn-1:reasoning:row:think'), /data-run-id="c1"[^>]*data-run-member="interior"/);
  assert.match(openTag('turn-1:tool_call:c3'), /data-run-label="Run npm test"/);
  assert.doesNotMatch(openTag('turn-1:assistant_text:row:answer'), /data-run-/);
  assert.match(html, /class="tool-run-summary">Searched once, read a file, ran a command</);
  assert.match(html, /tool-run-failed">1 failed</);
  assert.match(html, /data-tool-run-state="failed"/);
  assert.match(html, /data-tool-run-toggle="true" data-tool-run-key="session=s1\|turn=turn-1\|row=tool_run\|call=c1" aria-expanded="false"/);
  // All rows stay direct children of the list: no wrapper element.
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const list = dom.window.document.querySelector('.turn-row-list');
  assert.equal(list.querySelectorAll('.chat-row').length, list.children.length, 'every row is a direct child of the list');
  dom.window.close();
});

test('run markup escapes tool names and labels', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const rows = [
    toolRow('c1', 'custom_tool', { payload: { tool_display_name: hostile } }),
    toolRow('c2', 'custom_tool', { payload: { tool_display_name: hostile } }),
  ];
  const html = createList().buildTurnRowListMarkup(rows, [], { transcriptView: 'answers', sessionId: 's1' });
  const runMarkup = html.replace(/<div class="tool-call-row[\s\S]*?<\/div>/g, '');
  assert.doesNotMatch(runMarkup, /<img/);
  assert.match(runMarkup, /Used &lt;img src=x onerror=alert\(1\)&gt; 2 times/);
});

test('a patched member and a full render give the same summary for every settled status', () => {
  const { JSDOM } = require('jsdom');
  const { refreshToolRunSummary } = require('../renderer/chat/renderer-stream-tool-patch-utils');
  const render = (state) => createList().buildTurnRowListMarkup(
    [toolRow('c1', 'read_file', { payload: { state: 'errored' } }), toolRow('c2', 'run_command', { input: { command: 'npm test' }, payload: { state } })],
    [], { transcriptView: 'answers', sessionId: 's1' },
  );
  const summaryOf = (document) => {
    const row = document.querySelector('.chat-row[data-row-kind="tool_run"] .tool-run-row');
    return { state: row.getAttribute('data-tool-run-state'), inner: row.querySelector('[data-tool-run-toggle]').innerHTML };
  };
  for (const status of ['completed', 'errored', 'error', 'timeout', 'timed_out', 'interrupted', 'denied']) {
    const full = new JSDOM(`<!doctype html><body>${render(status)}</body>`);
    const patched = new JSDOM(`<!doctype html><body>${render('running')}</body>`);
    try {
      const member = patched.window.document.querySelector('.chat-row[data-tool-call-id="c2"]');
      const toolRowNode = member.querySelector('[data-tool-status]');
      // The patch lane writes the normalized status (resolvePatchStatus):
      // raw 'timeout' arrives as 'timed_out', raw 'error' as 'errored'.
      const patchedStatus = toolCallUtils.normalizeToolStatus(status);
      toolRowNode.setAttribute('data-tool-status', patchedStatus);
      toolRowNode.setAttribute('data-is-error', String(patchedStatus === 'errored'));
      refreshToolRunSummary(member);
      assert.deepEqual(summaryOf(patched.window.document), summaryOf(full.window.document), status);
    } finally {
      full.window.close();
      patched.window.close();
    }
  }
});

test('a member patched into an approval wait is not counted as done', () => {
  const summary = toolCallUtils.summarizeToolRun([
    { tool: 'read_file', status: 'completed' },
    { tool: 'run_command', status: 'pending_approval', label: 'Run npm test' },
  ]);
  assert.equal(summary.doneCount, 1);
  assert.equal(toolCallUtils.toolRunState(summary), 'live');
});

test('approval-gated and content rows split runs instead of folding', () => {
  const rows = [
    toolRow('c1', 'read_file'),
    toolRow('c2', 'read_file'),
    toolRow('c3', 'run_command', { payload: { approval_requests: [{ status: 'pending_approval' }] } }),
    toolRow('c4', 'read_file'),
    toolRow('c5', 'read_file', { payload: { own_content: true } }),
    toolRow('c6', 'read_file'),
  ];
  const html = createList().buildTurnRowListMarkup(rows, [], { transcriptView: 'answers', sessionId: 's1' });
  assert.deepEqual(Array.from(html.matchAll(/data-row-kind="tool_run"[^>]*data-run-id="([^"]+)"/g), (m) => m[1]), ['c1']);
  assert.doesNotMatch(rowOpenTag(html, 'turn-1:tool_call:c3'), /data-run-id/);
});

test('an expanded run renders expanded from the per-session override and resets with the session', () => {
  const key = toolCallUtils.buildToolRowKey({ sessionId: 's1', turnId: 'turn-1', rowId: 'tool_run', callId: 'c1' });
  const previous = globalThis.rendererTurnRowToolRenderUtils;
  globalThis.rendererTurnRowToolRenderUtils = toolRenderUtils;
  try {
    toolRenderUtils.setToolRowExpansion(key, true);
    let html = createList().buildTurnRowListMarkup(RUN_ROWS, [], { transcriptView: 'answers', sessionId: 's1' });
    assert.match(html, /data-row-kind="tool_run" data-run-id="c1" data-run-expanded="true"/);
    assert.match(html, /aria-expanded="true"/);
    assert.match(rowOpenTag(html, 'turn-1:tool_call:c2'), /data-run-expanded="true"/);
    toolRenderUtils.clearToolRowExpansionOverridesForSession('s1');
    html = createList().buildTurnRowListMarkup(RUN_ROWS, [], { transcriptView: 'answers', sessionId: 's1' });
    assert.match(html, /data-row-kind="tool_run" data-run-id="c1" data-run-expanded="false"/);
  } finally {
    toolRenderUtils.clearToolRowExpansionOverrides();
    globalThis.rendererTurnRowToolRenderUtils = previous;
  }
});

test('a status patch on a member refreshes its run summary in place (patch lane, no render)', () => {
  const { JSDOM } = require('jsdom');
  const { refreshToolRunSummary } = require('../renderer/chat/renderer-stream-tool-patch-utils');
  const rows = [
    toolRow('c1', 'read_file', { input: { path: 'a.js' } }),
    toolRow('c2', 'run_command', { input: { command: 'npm test' }, payload: { state: 'running' } }),
  ];
  const html = createList().buildTurnRowListMarkup(rows, [], { transcriptView: 'answers', sessionId: 's1' });
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  try {
    const document = dom.window.document;
    const summaryRow = document.querySelector('.chat-row[data-row-kind="tool_run"]');
    assert.equal(summaryRow.querySelector('.tool-run-row').getAttribute('data-tool-run-state'), 'live');
    assert.equal(summaryRow.querySelector('.tool-run-summary').textContent, 'Run npm test');

    const member = document.querySelector('.chat-row[data-tool-call-id="c2"]');
    member.querySelector('[data-tool-status]').setAttribute('data-tool-status', 'completed');
    refreshToolRunSummary(member, 4200);

    assert.equal(document.querySelector('.chat-row[data-row-kind="tool_run"]'), summaryRow, 'the summary row node is kept');
    assert.equal(summaryRow.querySelector('.tool-run-row').getAttribute('data-tool-run-state'), 'ok');
    assert.equal(summaryRow.querySelector('.tool-run-summary').textContent, 'Read a file, ran a command');
    assert.equal(summaryRow.querySelector('.tool-result-duration').textContent, '4.2s');
    assert.equal(member.getAttribute('data-run-duration-ms'), '4200');

    const outside = document.createElement('div');
    outside.className = 'chat-row';
    refreshToolRunSummary(outside, 10);
    refreshToolRunSummary(null, 10);
  } finally {
    dom.window.close();
  }
});

test('the rail stylesheet hides a collapsed run in Answers, shows it expanded, and never shows runs elsewhere', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { JSDOM } = require('jsdom');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-thread-rail.css'), 'utf8');
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({ selector: match[1].trim().replace(/\s+/g, ' '), body: match[2].replace(/\s+/g, ' ').trim() }));
  const ruleFor = (needle, declaration) => {
    const hits = rules.filter((rule) => rule.selector.includes(needle) && rule.body.includes(declaration));
    assert.equal(hits.length, 1, `exactly one rule for ${needle} { ${declaration} }`);
    return hits[0].selector;
  };
  const hideMembers = ruleFor('[data-run-member]:not([data-run-expanded="true"])', 'display: none');
  const hideSummaryOutside = ruleFor('.chat-row[data-row-kind="tool_run"]', 'display: none');
  const indentExpanded = ruleFor('[data-run-member][data-run-expanded="true"]', 'padding-inline-start');
  const hideMemberDots = ruleFor('[data-run-member] .chat-row-node-dot', 'display: none');

  const render = (expanded) => {
    const html = createList().buildTurnRowListMarkup(RUN_ROWS, [], { transcriptView: 'answers', sessionId: 's1' });
    return expanded ? html.replace(/data-run-expanded="false"/g, 'data-run-expanded="true"') : html;
  };
  for (const [view, expanded] of [['answers', false], ['answers', true], ['thinking', false]]) {
    const dom = new JSDOM(`<!doctype html><div class="chat-timeline" data-transcript-view="${view}">${render(expanded)}</div>`);
    const document = dom.window.document;
    const ids = (selector) => [...document.querySelectorAll(selector)].map((node) => node.getAttribute('data-row-id'));
    const members = ['turn-1:tool_call:c1', 'turn-1:reasoning:row:think', 'turn-1:tool_call:c2', 'turn-1:tool_call:c3'];
    if (view === 'answers' && !expanded) {
      assert.deepEqual(ids(hideMembers), members, 'a collapsed run hides its steps and the reasoning between them');
      assert.deepEqual(ids(hideSummaryOutside), [], 'the summary shows in Answers');
    } else if (view === 'answers') {
      assert.deepEqual(ids(hideMembers), [], 'an expanded run hides nothing');
      assert.deepEqual(ids(indentExpanded), members, 'expanded steps are indented');
    } else {
      assert.deepEqual(ids(hideSummaryOutside), ['turn-1:tool_run:c1'], 'outside Answers a stale summary stays hidden');
      assert.deepEqual(ids(hideMembers), [], 'outside Answers nothing is hidden by the run rules');
    }
    assert.equal(document.querySelectorAll(hideMemberDots).length, view === 'answers' ? members.length : 0,
      'run steps drop their own rail dots in Answers only');
    dom.window.close();
  }
});

test('a pending step is still live: the run is not reported as finished', () => {
  const summary = toolCallUtils.summarizeToolRun([
    { tool: 'read_file', status: 'completed' },
    { tool: 'read_file', status: 'pending', label: 'Read b.js' },
  ]);
  assert.equal(summary.live, true);
  assert.equal(summary.doneCount, 1);
  assert.equal(toolCallUtils.toolRunState(summary), 'live');
});

test('a step that turns running through a patch still gives the summary a ticking timer', () => {
  const { JSDOM } = require('jsdom');
  const { refreshToolRunSummary } = require('../renderer/chat/renderer-stream-tool-patch-utils');
  const rows = [toolRow('c1', 'read_file'), toolRow('c2', 'run_command', { input: { command: 'npm test' }, payload: { state: 'pending' } })];
  const html = createList().buildTurnRowListMarkup(rows, [], { transcriptView: 'answers', sessionId: 's1' });
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  try {
    const document = dom.window.document;
    const member = document.querySelector('.chat-row[data-tool-call-id="c2"]');
    assert.equal(document.querySelector('.tool-run-toggle [data-turn-elapsed]'), null, 'pending: no timer yet');
    member.querySelector('[data-tool-status]').setAttribute('data-tool-status', 'running');
    refreshToolRunSummary(member);
    const elapsed = document.querySelector('.tool-run-toggle [data-turn-elapsed][data-elapsed-started-at]');
    assert.ok(elapsed, 'the summary gains an elapsed node the turn clock ticks');
    assert.ok(Number(elapsed.getAttribute('data-elapsed-started-at')) > 0);
    // The turn clock ticks the label; a later patch must not rebuild the row
    // (that would restart the shimmer) or restart the timer.
    elapsed.textContent = '7s';
    const summaryText = document.querySelector('.tool-run-toggle .tool-run-summary');
    refreshToolRunSummary(member);
    assert.equal(document.querySelector('.tool-run-toggle .tool-run-summary'), summaryText, 'the live row is not rebuilt');
    assert.equal(document.querySelector('.tool-run-toggle [data-elapsed-started-at]').getAttribute('data-elapsed-started-at'),
      elapsed.getAttribute('data-elapsed-started-at'), 'a later patch keeps the same start');
  } finally {
    dom.window.close();
  }
});

test('the content-row fold stamp is Answers-only markup', () => {
  const src = toolRenderUtils.createTurnRowToolRenderUtils({ escapeHtml: (v) => String(v), normalizeId: (v) => String(v || '').trim() });
  const row = { row_id: 'r', turn_id: 't', kind: 'tool_call', tool_call_id: 'c', payload: { tool_call_id: 'c', tool_name: 'read_file', state: 'completed', input: { path: 'a.pdf' } } };
  const result = { row_id: 'rr', turn_id: 't', kind: 'tool_result', tool_call_id: 'c', payload: { tool_call_id: 'c', is_error: true, error_code: 'CMP-TOOL-0047', output_text: 'x' } };
  const answers = src.buildToolCallRowMarkup(row, [], { transcriptView: 'answers', pairedToolResultRow: result, sessionId: 's' });
  const thinking = src.buildToolCallRowMarkup(row, [], { transcriptView: 'thinking', pairedToolResultRow: result, sessionId: 's' });
  assert.match(answers, /data-run-foldable="false"/);
  assert.doesNotMatch(thinking, /data-run-foldable/);
});
