'use strict';

// The steps heading (row 192) in the Thinking and Everything views, and its
// notes-between-steps amendment (C15, docs/plans/CHAT_TURN_SPEC_2026-11-23.md):
// mid-turn text stays in place and the steps between two notes fold into one
// run line, in the render lane, the toggles and the live patch lane.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { createTurnRowListUtils } = require('../renderer/chat/renderer-turn-row-list-utils');
const toolRenderUtils = require('../renderer/chat/renderer-turn-row-tool-render-utils');

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
      if (row.kind === 'system_notice') return '<div class="error-card">Failed</div>';
      if (row.kind === 'approval_gap') {
        const resolved = row.payload.state === 'resolved';
        return `<div class="approval-gap-row" data-approval-status="${resolved ? 'resolved' : 'pending'}">${resolved ? '<span class="sr-only">Allowed once</span>' : 'Allow?'}</div>`;
      }
      const status = row.payload.state;
      const own = row.payload.own_content ? ' data-run-foldable="false"' : '';
      return `<div class="tool-call-row tool-call-row--minimal" data-tool-status="${status}" data-is-error="${status === 'errored'}"${own}>${row.payload.tool_name}</div>`;
    },
  });
}

const RUN_ROWS = [
  { row_id: 'row:intro', turn_id: 'turn-1', kind: 'assistant_text', payload: { text: 'Let me look.' } },
  toolRow('c1', 'grep_search', { input: { pattern: 'x' } }),
  { row_id: 'row:think', turn_id: 'turn-1', kind: 'reasoning', payload: {} },
  toolRow('c2', 'read_file', { input: { path: 'a.js' } }),
  toolRow('c3', 'run_command', { input: { command: 'npm test' }, payload: { state: 'errored' } }),
  { row_id: 'row:answer', turn_id: 'turn-1', kind: 'assistant_text', payload: { text: 'Found it.' } },
];

function ledgerDom(rows, options = {}) {
  const html = createList().buildTurnRowListMarkup(rows, [], {
    transcriptView: 'thinking', sessionId: 's1', turnId: 'turn-1', projectionContext: {}, ...options,
  });
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const document = dom.window.document;
  const heading = document.querySelector('.chat-row[data-row-kind="work_ledger"]');
  const row = (id) => document.querySelector(`.chat-row[data-row-id="${id}"]`);
  const shown = (id) => row(id).getAttribute('data-ledger-show') === 'true';
  const member = (id) => row(id).hasAttribute('data-ledger-member');
  const text = (selector) => heading?.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim();
  const runText = (id) => row(`turn-1:tool_run:${id}`).querySelector('.tool-run-toggle').textContent.replace(/\s+/g, ' ').trim();
  return { dom, document, html, heading, row, shown, member, text, runText };
}

const reads = (count, state = 'completed', from = 1) => Array.from({ length: count }, (_, index) => toolRow(`r${from + index}`, 'read_file', { input: { path: `f${from + index}.js` }, payload: { state } }));
const say = (id, phase = 'intermediate') => ({ row_id: `row:${id}`, turn_id: 'turn-1', kind: 'assistant_text', assistant_phase: phase, payload: { text: id } });
const ids = (prefix, list) => list.map((id) => `turn-1:${prefix}:${id}`);

function withToolGlobals(fn) {
  const previous = globalThis.rendererTurnRowToolRenderUtils;
  const previousUtils = globalThis.toolCallUtils;
  globalThis.rendererTurnRowToolRenderUtils = toolRenderUtils;
  globalThis.toolCallUtils = toolCallUtils;
  try {
    return fn();
  } finally {
    toolRenderUtils.clearToolRowExpansionOverrides();
    globalThis.rendererTurnRowToolRenderUtils = previous;
    globalThis.toolCallUtils = previousUtils;
  }
}

test('a turn with steps gets one heading row first; a turn without steps or in Answers gets none', () => {
  for (const transcriptView of ['thinking', 'everything']) {
    const { dom, document, heading } = ledgerDom(RUN_ROWS, { transcriptView });
    const list = document.querySelector('.turn-row-list');
    assert.equal(document.querySelectorAll('.chat-row[data-row-kind="work_ledger"]').length, 1, transcriptView);
    assert.equal(list.firstElementChild, heading, 'the heading is the first row of the list');
    assert.equal(heading.getAttribute('data-row-id'), 'turn-1:work_ledger');
    assert.ok(heading.querySelector('.tool-run-row > .tool-run-toggle[data-tool-run-toggle="true"][role="button"][tabindex="0"]'));
    assert.equal(list.querySelectorAll('.chat-row').length, list.children.length, 'steps stay flat siblings');
    dom.window.close();
  }
  const none = ledgerDom([{ row_id: 'row:a', turn_id: 'turn-1', kind: 'assistant_text', payload: { text: 'Hi.' } }]);
  assert.equal(none.heading, null, 'no steps: no heading');
  assert.doesNotMatch(none.html, /data-ledger-/);
  none.dom.window.close();
  assert.doesNotMatch(createList().buildTurnRowListMarkup(RUN_ROWS, [], { transcriptView: 'answers', sessionId: 's1', turnId: 'turn-1', projectionContext: {} }), /work_ledger|data-ledger-/);
});

test('a finished turn keeps its text in view and folds the steps between notes into one run line', () => {
  const { dom, heading, shown, member, text, runText } = ledgerDom(RUN_ROWS);
  assert.equal(text('.tool-run-summary'), '3 steps · Searched once, read a file, ran a command');
  assert.equal(text('.tool-run-failed'), '1 failed');
  assert.ok(heading.querySelector('.status-dot--ok'));
  assert.equal(heading.querySelector('[data-tool-run-toggle]').getAttribute('aria-expanded'), 'false');
  assert.ok(member('turn-1:assistant_text:row:intro') && shown('turn-1:assistant_text:row:intro'), 'the text before the steps stays in view');
  assert.ok(shown('turn-1:tool_run:c1'), 'the steps after it read as one run line');
  assert.equal(runText('c1'), 'Searched once, read a file, ran a command1 failed');
  for (const id of ['turn-1:tool_call:c1', 'turn-1:reasoning:row:think', 'turn-1:tool_call:c2', 'turn-1:tool_call:c3']) {
    assert.ok(member(id) && !shown(id), `${id} is folded into the run line`);
  }
  assert.equal(member('turn-1:assistant_text:row:answer'), false, 'the answer is not part of the steps');
  dom.window.close();
});

test('a finished turn with no text folds whole under the heading, as before', () => {
  const many = ledgerDom(reads(3));
  assert.equal(many.text('.work-ledger-lead'), '3 steps');
  assert.ok([...ids('tool_call', ['r1', 'r2', 'r3']), 'turn-1:tool_run:r1'].every((id) => !many.shown(id)));
  many.dom.window.close();
  const one = ledgerDom(reads(1));
  assert.equal(one.text('.work-ledger-lead'), '1 step');
  assert.equal(one.heading.querySelector('.tool-run-failed'), null);
  assert.equal(one.shown('turn-1:tool_call:r1'), false);
  one.dom.window.close();
});

test('notes stay where they were written, live and settled; each stretch of steps is one line, a lone step its own row', () => {
  const rows = [say('n1', 'commentary'), ...reads(2), say('n2'), ...reads(2, 'completed', 3), say('n3'), ...reads(1, 'completed', 5), say('ans', 'final_answer')];
  for (const turnLive of [false, true]) {
    const { dom, document, shown, member, runText } = ledgerDom(rows, { turnLive });
    assert.ok(ids('assistant_text', ['row:n1', 'row:n2', 'row:n3']).every((id) => member(id) && shown(id)), `notes in view (live ${turnLive})`);
    assert.deepEqual([...document.querySelectorAll('.chat-row[data-row-kind="tool_run"]')].map((node) => node.getAttribute('data-run-id')), ['r1', 'r3']);
    assert.ok(shown('turn-1:tool_run:r1') && shown('turn-1:tool_run:r3'));
    assert.equal(runText('r3'), 'Read 2 files');
    assert.ok(ids('tool_call', ['r1', 'r2', 'r3', 'r4']).every((id) => !shown(id)), 'run members fold');
    assert.ok(shown('turn-1:tool_call:r5'), 'a one-step stretch is its own row');
    assert.equal(member('turn-1:assistant_text:row:ans'), false);
    dom.window.close();
  }
});

test('while the turn runs the newest stretch is a live run line naming the step in flight; live thinking stays in view', () => {
  const rows = [{ row_id: 'row:think', turn_id: 'turn-1', kind: 'reasoning', payload: {} }, ...reads(5), ...reads(1, 'running', 6)];
  const live = ledgerDom(rows, { turnLive: true });
  assert.equal(live.text('.work-ledger-lead'), 'Step 6');
  assert.ok(live.heading.querySelector('.status-dot--active'));
  assert.ok(live.shown('turn-1:tool_run:r1'), 'the run line is in view');
  assert.equal(live.row('turn-1:tool_run:r1').querySelector('.tool-run-row').getAttribute('data-tool-run-state'), 'live');
  assert.match(live.runText('r1'), /^Read f6\.js5 done/);
  assert.ok(ids('tool_call', ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']).every((id) => !live.shown(id)), 'no last-three list');
  assert.equal(live.shown('turn-1:reasoning:row:think'), false, 'thinking before the steps stays inside the fold');
  live.dom.window.close();

  const thinkingNow = { row_id: 'row:now', turn_id: 'turn-1', kind: 'reasoning', payload: {} };
  const streaming = ledgerDom([...reads(2), thinkingNow], { turnLive: true });
  assert.equal(streaming.shown('turn-1:reasoning:row:now'), true, 'live thinking after the last step is in view');
  streaming.dom.window.close();
  const nextStep = ledgerDom([...reads(2), thinkingNow, ...reads(1, 'running', 3)], { turnLive: true });
  assert.equal(nextStep.shown('turn-1:reasoning:row:now'), false, 'it folds into the run once the next step lands');
  nextStep.dom.window.close();
  const settled = ledgerDom([...reads(2), thinkingNow]);
  assert.equal(settled.shown('turn-1:reasoning:row:now'), false, 'a settled turn folds it');
  settled.dom.window.close();

  const gap = (callId) => ({ row_id: `gap:${callId}`, turn_id: 'turn-1', kind: 'approval_gap', tool_call_id: callId, payload: { tool_call_id: callId, state: 'awaiting_approval' } });
  const waiting = ledgerDom([...reads(2), gap('c3'), toolRow('c3', 'run_command', { input: { command: 'npm test' }, payload: { state: 'awaiting_approval', approval_requests: [{}] } })], { turnLive: true });
  assert.equal(waiting.text('.work-ledger-lead'), 'Step 3 is waiting for you');
  assert.ok(waiting.heading.querySelector('.status-dot--pending'));
  assert.ok(waiting.shown('turn-1:approval_gap:c3') && waiting.shown('turn-1:tool_call:c3'), 'the card and its step are in view');
  assert.ok(waiting.shown('turn-1:tool_run:r1'), 'the steps before it read as one line');
  waiting.dom.window.close();

  const first = ledgerDom([gap('c1'), toolRow('c1', 'run_command', { payload: { state: 'awaiting_approval' } })], { turnLive: true });
  assert.equal(first.text('.work-ledger-lead'), 'Step 1 is waiting for you');
  first.dom.window.close();
});

test('text leading into a question or a plan stays outside the fold at full emphasis; other mid-turn text is a note in view', () => {
  const plan = { row_id: 'row:plan', turn_id: 'turn-1', kind: 'plan_document', payload: { plan_id: 'p1', state: 'superseded' } };
  const think = { row_id: 'row:t', turn_id: 'turn-1', kind: 'reasoning', payload: {} };
  const rows = [say('narrate'), ...reads(1), say('mock'), think, toolRow('q', 'ask_user'), say('why'), toolRow('x', 'exit_plan_mode'), say('mock2'), plan, ...reads(1, 'completed', 2)];
  for (const turnLive of [false, true]) {
    const { dom, document, member, shown } = ledgerDom(rows, { turnLive });
    const leadIn = (id) => document.querySelector(`.chat-row[data-row-id="turn-1:assistant_text:row:${id}"]`).getAttribute('data-assistant-lead-in');
    for (const id of ['mock', 'why', 'mock2']) assert.ok(leadIn(id) === 'true' && !member(`turn-1:assistant_text:row:${id}`), `${id} is outside the fold`);
    assert.ok(member('turn-1:assistant_text:row:narrate') && shown('turn-1:assistant_text:row:narrate') && leadIn('narrate') === null, 'narration is a note in view');
    dom.window.close();
  }
  assert.doesNotMatch(createList().buildTurnRowListMarkup([say('done', 'final_answer'), toolRow('q', 'ask_user')], [], {}), /data-assistant-lead-in/);
});

test('review fixes: a blank text row is not text; a hidden orphan result does not split a run', () => {
  // A preempted turn can leave a blank text row: it must not keep a no-text turn from folding whole.
  const blank = { row_id: 'row:blank', turn_id: 'turn-1', kind: 'assistant_text', assistant_phase: 'commentary', payload: { text: '<span class="sr-only">Commentary</span>' } };
  const folded = ledgerDom([...reads(1), blank, ...reads(2, 'completed', 2), say('ans', 'final_answer')]);
  assert.ok(folded.row('turn-1:assistant_text:row:blank').hasAttribute('data-row-visually-empty'));
  assert.ok(['turn-1:tool_run:r1', 'turn-1:assistant_text:row:blank'].every((id) => !folded.shown(id)), 'the turn folds whole');
  folded.dom.window.close();
  const orphan = { row_id: 'res:x', turn_id: 'turn-1', kind: 'tool_result', tool_call_id: 'x', payload: { tool_call_id: 'x' } };
  const split = ledgerDom([say('n1'), ...reads(2), orphan, ...reads(2, 'completed', 3)]);
  assert.deepEqual([...split.document.querySelectorAll('.chat-row[data-row-kind="tool_run"]')].map((node) => node.getAttribute('data-run-id')), ['r1'], 'one run line');
  assert.equal(split.shown('turn-1:tool_result:x'), false);
  split.dom.window.close();
});

test('review fix: Everything does not open every run; closing its heading shows folded run lines', () => {
  const { createMinimalToolRowToggles } = require('../renderer/chat/renderer-chat-tool-row-toggles');
  withToolGlobals(() => {
    const { dom, document, heading, row, shown } = ledgerDom([say('n1'), ...reads(3)], { transcriptView: 'everything' });
    try {
      assert.equal(row('turn-1:tool_run:r1').getAttribute('data-run-expanded'), 'false', 'auto-expanded steps do not seed the run');
      createMinimalToolRowToggles({ chatTimeline: document.body, doc: document }).toggleToolRun(heading.querySelector('[data-tool-run-toggle]'));
      assert.ok(shown('turn-1:tool_run:r1') && ids('tool_call', ['r1', 'r2', 'r3']).every((id) => !shown(id)));
    } finally {
      dom.window.close();
    }
  });
});

test('a turn that fails before any answer: muted dot, folded steps, the error card outside the fold', () => {
  const notice = { row_id: 'row:err', turn_id: 'turn-1', kind: 'system_notice', payload: { subkind: 'assistant_error' } };
  const { dom, heading, shown, member, text } = ledgerDom([...reads(1), toolRow('c2', 'run_command', { payload: { state: 'errored' } }), notice]);
  assert.ok(heading.querySelector('.status-dot--muted'));
  assert.equal(text('.work-ledger-lead'), '2 steps');
  assert.equal(text('.tool-run-failed'), '1 failed');
  assert.equal(shown('turn-1:tool_call:c2'), false);
  assert.equal(member('turn-1:system_notice:row:err'), false, 'the error card is not part of the steps');
  dom.window.close();
});

test('Everything opens the heading flat; an opened heading stays open when a new step arrives', () => {
  const everything = ledgerDom(RUN_ROWS, { transcriptView: 'everything' });
  assert.equal(everything.heading.querySelector('[data-tool-run-toggle]').getAttribute('aria-expanded'), 'true');
  assert.ok(everything.shown('turn-1:tool_call:c1') && everything.shown('turn-1:reasoning:row:think'));
  assert.equal(everything.shown('turn-1:tool_run:c1'), false, 'an open heading lists the steps, not the run line');
  everything.dom.window.close();

  const key = toolCallUtils.buildToolRowKey({ sessionId: 's1', turnId: 'turn-1', rowId: 'work_ledger' });
  withToolGlobals(() => {
    const before = ledgerDom([...reads(4), ...reads(1, 'running', 5)], { turnLive: true });
    assert.equal(before.heading.querySelector('[data-tool-run-toggle]').getAttribute('data-tool-run-key'), key);
    before.dom.window.close();
    toolRenderUtils.setToolRowExpansion(key, true);
    const after = ledgerDom([...reads(5), ...reads(1, 'running', 6)], { turnLive: true });
    assert.equal(after.heading.getAttribute('data-ledger-expanded'), 'true');
    assert.ok(['r1', 'r2', 'r6'].every((id) => after.shown(`turn-1:tool_call:${id}`)), 'every step stays in view');
    after.dom.window.close();
  });
});

test('the heading toggles the whole list on click and keyboard, aria-expanded follows and the choice is kept', () => {
  const { createMinimalToolRowToggles } = require('../renderer/chat/renderer-chat-tool-row-toggles');
  withToolGlobals(() => {
    const { dom, document, heading, shown } = ledgerDom([...reads(5), ...reads(1, 'running', 6)], { turnLive: true });
    try {
      const { toggleToolRun } = createMinimalToolRowToggles({ chatTimeline: document.body, doc: document });
      const toggle = heading.querySelector('[data-tool-run-toggle]');
      toggleToolRun(toggle);
      assert.equal(toggle.getAttribute('aria-expanded'), 'true');
      assert.ok(['r1', 'r2', 'r6'].every((id) => shown(`turn-1:tool_call:${id}`)), 'open: every step');
      assert.equal(shown('turn-1:tool_run:r1'), false, 'open: no run line');
      assert.equal(toolRenderUtils.getToolRowExpansion(toggle.getAttribute('data-tool-run-key')), true, 'remembered for the turn');
      toggleToolRun(toggle);
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.deepEqual(['r1', 'r3', 'r6'].map((id) => shown(`turn-1:tool_call:${id}`)), [false, false, false], 'closed: back to the run line');
      assert.equal(shown('turn-1:tool_run:r1'), true);
    } finally {
      dom.window.close();
    }
  });
});

test('a run line under the heading opens on its own, one indent in; an open heading lists it flat', () => {
  const { createMinimalToolRowToggles } = require('../renderer/chat/renderer-chat-tool-row-toggles');
  withToolGlobals(() => {
    const { dom, document, heading, row, shown } = ledgerDom([say('n1'), ...reads(2), say('n2'), ...reads(1, 'completed', 3)]);
    try {
      const { toggleToolRun } = createMinimalToolRowToggles({ chatTimeline: document.body, doc: document });
      const runToggle = row('turn-1:tool_run:r1').querySelector('[data-tool-run-toggle]');
      toggleToolRun(runToggle);
      assert.equal(runToggle.getAttribute('aria-expanded'), 'true');
      assert.ok(ids('tool_call', ['r1', 'r2']).every((id) => shown(id) && row(id).getAttribute('data-ledger-nested') === 'true'), 'its steps, nested');
      toggleToolRun(heading.querySelector('[data-tool-run-toggle]'));
      assert.ok(ids('tool_call', ['r1', 'r2']).every((id) => shown(id) && !row(id).hasAttribute('data-ledger-nested')), 'flat under an open heading');
      assert.equal(shown('turn-1:tool_run:r1'), false);
      toggleToolRun(heading.querySelector('[data-tool-run-toggle]'));
      assert.ok(ids('tool_call', ['r1', 'r2']).every((id) => shown(id) && row(id).getAttribute('data-ledger-nested') === 'true'), 'the run is still open');
      toggleToolRun(runToggle);
      assert.ok(ids('tool_call', ['r1', 'r2']).every((id) => !shown(id)), 'closing the run folds its steps');
      assert.ok(shown('turn-1:assistant_text:row:n1') && shown('turn-1:assistant_text:row:n2'), 'the notes never move');
    } finally {
      dom.window.close();
    }
  });
});

test('the live patch updates the heading and the live run line in place, and a note keeps its place', () => {
  const { refreshToolRunSummary } = require('../renderer/chat/renderer-stream-tool-patch-utils');
  const { dom, document, heading, row, shown, text, runText } = ledgerDom([say('n1'), ...reads(3), toolRow('c4', 'run_command', { input: { command: 'npm test' }, payload: { state: 'running', running_started_at_ms: 1000 } })], { turnLive: true });
  try {
    assert.equal(text('.tool-run-summary'), 'Step 4 · Read 3 files, ran a command');
    assert.match(runText('r1'), /^Run npm test3 done/);
    const member = document.querySelector('.chat-row[data-tool-call-id="c4"]');
    member.querySelector('[data-tool-status]').setAttribute('data-tool-status', 'completed');
    refreshToolRunSummary(member, 2000);
    assert.equal(document.querySelector('.chat-row[data-row-kind="work_ledger"]'), heading, 'the heading node is kept');
    assert.equal(text('.work-ledger-lead'), 'Step 5');
    assert.equal(runText('r1'), 'Read 3 files, ran a command2.0s');
    assert.equal(row('turn-1:tool_run:r1').querySelector('.tool-run-row').getAttribute('data-tool-run-state'), 'ok');
    assert.ok(ids('tool_call', ['r1', 'r2', 'r3', 'c4']).every((id) => !shown(id)), 'the steps stay folded');
    assert.ok(shown('turn-1:assistant_text:row:n1') && shown('turn-1:tool_run:r1'), 'the note and the run line stay in view');
  } finally {
    dom.window.close();
  }
});

test('the stylesheet shows a run line under a closed heading and nests an opened run', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-thread-rail.css'), 'utf8');
  assert.match(css, /\.chat-timeline:not\(\[data-transcript-view="answers"\]\) \.chat-row\[data-row-kind="tool_run"\]\[data-ledger-show="true"\]\s*\{\s*display:\s*flex;/);
  assert.match(css, /\.chat-row\[data-ledger-show="true"\]\[data-ledger-nested="true"\]\s*\{\s*padding-inline-start:\s*calc\(var\(--space-5\) \* 2\);/);
});
