'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildChangesHistory, writerKind } = require('../renderer/features/renderer-changes-history-model');
const { createChangesViewRender } = require('../renderer/features/renderer-changes-view-render');
const { createChangesView } = require('../renderer/features/renderer-changes-view');

function change(overrides = {}) {
  return {
    changeId: overrides.changeId || `c-${overrides.path || 'a.js'}`,
    turnId: 't1',
    toolCallId: 'call_1',
    toolName: 'edit_file',
    path: 'a.js',
    fileKey: `ws:${overrides.path || 'a.js'}`,
    status: 'modified',
    callOutcome: 'succeeded',
    scripted: false,
    sensitive: false,
    afterHash: 'sha256:aa',
    hashKind: 'diff_input_text',
    hunks: [],
    ...overrides,
  };
}

function turnModel(turnId, content, changeSetId) {
  const toolCalls = changeSetId
    ? [{ resultMetadata: { workspace_change_set: { change_set_id: changeSetId } } }]
    : [];
  return { turnId, user: { content }, toolCalls };
}

const TIME = { getTurnTime: (_model, turnId) => ({ t1: 1000, t2: 2000 })[turnId] };

test('history groups by turn, newest first, one line per file', () => {
  const ledger = {
    changes: [
      change({ path: 'a.js' }),
      change({ path: 'a.js', changeId: 'c-a2' }),
      change({ path: 'b.js', status: 'created' }),
      change({ turnId: 't2', path: 'c.py', toolName: 'python_execute', scripted: true, callOutcome: 'failed' }),
    ],
    notices: [],
  };
  const history = buildChangesHistory(ledger, [turnModel('t1', 'Fix the cap\nmore', 'cs-1'), turnModel('t2', 'Migrate')], TIME);
  assert.deepEqual(history.turns.map((turn) => turn.turnId), ['t2', 't1']);
  const [newer, older] = history.turns;
  assert.equal(older.title, 'Fix the cap');
  assert.deepEqual(older.changeSetIds, ['cs-1']);
  assert.deepEqual(older.files.map((file) => file.path), ['a.js', 'b.js']);
  assert.deepEqual(older.files[0].changeIds, ['c-a.js', 'c-a2']);
  assert.equal(older.files[1].created, true);
  assert.equal(newer.files[0].failedAfter, true);
  assert.deepEqual(newer.files[0].writers, ['script']);
});

test('history keeps honest notices and over-cap counts', () => {
  const ledger = {
    changes: [change()],
    notices: [
      { turnId: 't1', state: 'partial', omittedCount: 41 },
      { turnId: 't2', state: 'unsupported', reason: 'not_git', omittedCount: 0 },
      { turnId: 't3', state: 'unavailable', reason: 'background', omittedCount: 0 },
    ],
  };
  const history = buildChangesHistory(ledger, [], TIME);
  const byId = Object.fromEntries(history.turns.map((turn) => [turn.turnId, turn]));
  assert.equal(byId.t1.omittedCount, 41);
  assert.deepEqual(byId.t2.notices, ['unsupported']);
  assert.equal(byId.t3, undefined, 'a background start says nothing in History');
});

test('writer kinds name scripts and commands', () => {
  assert.equal(writerKind('run_command'), 'command');
  assert.equal(writerKind('run_temp_script'), 'script');
  assert.equal(writerKind('python_execute'), 'script');
  assert.equal(writerKind('edit_file'), 'edit');
});

test('dot rows carry each state and the second line only when it says something', () => {
  const render = createChangesViewRender({ actionButton: () => '' });
  for (const state of ['review', 'current', 'working', 'done', 'rejected', 'later']) {
    const html = render.buildRowHtml({ id: 'r1', state, title: 'Round prices', file: 'pricing.py' });
    assert.match(html, new RegExp(`data-changes-row-state="${state}"`));
  }
  const fallback = render.buildRowHtml({ id: 'r1', state: 'bogus', title: 'x', file: 'f.py' });
  assert.match(fallback, /data-changes-row-state="review"/);
  const second = render.buildRowHtml({
    id: 'r1', state: 'working', title: 'x', file: 'f.py',
    secondLine: { text: 'Jenny is revising this one', tone: 'active' },
  });
  assert.match(second, /changes-row-second--active">Jenny is revising this one/);
  assert.doesNotMatch(second, /f\.py/);
});

test('footer priority is activity, then comments, then History', () => {
  const render = createChangesViewRender({ actionButton: (o) => `<button>${o.label}</button>` });
  assert.equal(render.footerKind({ activity: { label: 'Revising 1 change' }, comments: 2, historyLink: true }), 'activity');
  assert.equal(render.footerKind({ comments: 2, historyLink: true }), 'comments');
  assert.equal(render.footerKind({ historyLink: true }), 'history');
  assert.equal(render.footerKind(null), '');
  assert.match(render.buildFooterHtml({ comments: 1 }), /1 comment for Jenny/);
  assert.match(render.buildFooterHtml({ activity: { label: 'Revising 2 changes', elapsedMs: 21000 } }), /0:21/);
});

function setup(host, overrides = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>');
  const mountEl = dom.window.document.getElementById('mount');
  const opened = [];
  const ledger = overrides.ledger || {
    changes: [
      change({ path: 'a.js' }),
      change({ path: 'b.js' }),
      change({ turnId: 't2', path: 'c.js', toolName: 'run_command', scripted: true }),
    ],
    notices: [],
  };
  const view = createChangesView({
    host,
    getSessionId: () => 's1',
    getTurnViewModels: () => [turnModel('t1', 'First'), turnModel('t2', 'Second')],
    buildLedger: () => ledger,
    getTurnTime: TIME.getTurnTime,
    formatTime: () => '2:41 PM',
    actionButton: (o) => `<button data-${Object.keys(o.dataset || {})[0] || 'x'}="${Object.values(o.dataset || {})[0] || ''}">${o.label}</button>`,
    renderDiffBody: () => '<div class="diff-line diff-line-add">+x</div>',
    openChangeDiff: (c) => { opened.push(c.path); return true; },
    undoController: overrides.undoController || null,
  });
  view.mount(mountEl);
  return { dom, mountEl, view, opened };
}

function key(dom, target, keyName) {
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, bubbles: true }));
}

test('both hosts render the same History markup', () => {
  const dock = setup('dock');
  const panel = setup('panel');
  const strip = (html) => html.replace(/data-changes-view="(dock|panel)"/, '');
  assert.equal(strip(dock.mountEl.innerHTML), strip(panel.mountEl.innerHTML));
  assert.equal(dock.mountEl.querySelectorAll('[data-changes-turn-block]').length, 2);
  assert.equal(dock.mountEl.querySelector('.changes-view-title').textContent, 'History');
});

test('keyboard: arrows, Home and End move focus; Enter opens the diff in the dock', () => {
  const { dom, mountEl, opened } = setup('dock');
  const items = () => Array.from(mountEl.querySelectorAll('[data-changes-item]'));
  items()[0].focus();
  key(dom, items()[0], 'ArrowDown');
  assert.equal(dom.window.document.activeElement, items()[1]);
  key(dom, items()[1], 'End');
  assert.equal(dom.window.document.activeElement, items()[2]);
  key(dom, items()[2], 'Home');
  assert.equal(dom.window.document.activeElement, items()[0]);
  assert.deepEqual(items().map((el) => el.getAttribute('tabindex')), ['0', '-1', '-1']);
  key(dom, items()[0], 'Enter');
  assert.deepEqual(opened, ['c.js'], 'newest turn first, so the first line is c.js');
});

test('keyboard: ? toggles the writer popover; typing never triggers shortcuts', () => {
  const { dom, mountEl } = setup('dock');
  const first = mountEl.querySelector('[data-changes-item]');
  first.focus();
  key(dom, first, '?');
  const popover = mountEl.querySelector('.changes-popover');
  assert.ok(popover);
  assert.equal(popover.textContent, 'Changed by a command');
  key(dom, first, 'Escape');
  assert.equal(mountEl.querySelector('.changes-popover'), null);
  const input = dom.window.document.createElement('input');
  mountEl.appendChild(input);
  key(dom, input, '?');
  assert.equal(mountEl.querySelector('.changes-popover'), null);
});

test('side panel opens a detail page with All changes and the unified diff', () => {
  const { dom, mountEl, opened } = setup('panel');
  const second = mountEl.querySelectorAll('[data-changes-item]')[1];
  second.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(opened, []);
  assert.equal(mountEl.querySelector('.changes-view').getAttribute('data-changes-mode'), 'detail');
  assert.match(mountEl.querySelector('.changes-detail-position').textContent, /Change 2 of 3/);
  assert.ok(mountEl.querySelector('.changes-detail-diff .diff-line-add'));
  mountEl.querySelector('[data-changes-back]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(mountEl.querySelector('.changes-view').getAttribute('data-changes-mode'), 'history');
});

test('Undo… shows only for undoable turns and an undone turn offers Redo', () => {
  const undone = { t1: { status: 'undone', undoneAt: 5000, canRedo: true, files: { 'a.js': 'undone', 'b.js': 'kept' } } };
  const calls = [];
  const { dom, mountEl } = setup('dock', {
    undoController: {
      canUndoTurn: (turn) => turn.turnId === 't2',
      getUndoStates: () => undone,
      openUndo: (turn) => calls.push(['undo', turn.turnId]),
      redo: (turn) => calls.push(['redo', turn.turnId]),
    },
  });
  assert.equal(mountEl.querySelectorAll('[data-changes-undo]').length, 1);
  const t1 = mountEl.querySelector('[data-changes-turn-block="t1"]');
  assert.ok(t1.classList.contains('changes-history-turn--undone'));
  assert.deepEqual(Array.from(t1.querySelectorAll('.changes-history-note')).map((el) => el.textContent), ['undone', 'kept']);
  mountEl.querySelector('[data-changes-undo]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  mountEl.querySelector('[data-changes-redo]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(calls, [['undo', 't2'], ['redo', 't1']]);
});

test('a running preflight reads Checking…, never a result', () => {
  const { mountEl } = setup('dock', {
    undoController: {
      canUndoTurn: () => true,
      getUndoStates: () => ({ t2: { status: 'applied', busy: true, checking: true, files: {} } }),
    },
  });
  assert.equal(mountEl.querySelector('[data-changes-undo="t2"]').textContent.trim(), 'Checking…');
  // The real action button (setup's stub drops attributes) is disabled while busy.
  const html = createChangesViewRender({}).buildViewHtml({
    host: 'dock', mode: 'history', selectedKey: '', focusKey: '', detail: null, footer: null,
    history: { turns: [{ turnId: 't2', title: 'x', timeMs: 1, files: [], notices: [], omittedCount: 0, canUndo: true }] },
    undoStates: { t2: { status: 'applied', busy: true, checking: true, files: {} } },
  });
  assert.match(html, /<button[^>]* disabled [^>]*data-changes-undo="t2"/);
});

test('empty history says so instead of an empty list', () => {
  const { mountEl } = setup('dock', { ledger: { changes: [], notices: [] } });
  assert.match(mountEl.textContent, /hasn’t changed any files/);
});

test('dispose detaches listeners', () => {
  const { dom, mountEl, view, opened } = setup('dock');
  view.dispose();
  mountEl.querySelector('[data-changes-item]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(opened, []);
});
