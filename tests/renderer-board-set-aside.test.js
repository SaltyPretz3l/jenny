'use strict';

// new-test-file: tests/renderer-board-page.test.js is at its 600-line cap; this is the Board page's read-only board
// actions (slice B11, owner decision D20): "Show file" and "Remove from list" under the sentence that says why.
// The real page over jsdom, with a bridge that is the in-memory source (or a hand-made bridge for the refusals).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardPage } = require('../renderer/features/board/board-page');

const PROJECT = 'project_alpha';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BAD = `board_${uid(901)}`;
const NEWER = `board_${uid(902)}`;
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const unreadable = (id, name, reason) => ({ unreadable: { id, project_id: PROJECT, name, reason } });

// `wrap(name, call, record)` may replace one bridge call (`record` only notes it); `omit` leaves calls off the bridge (a bridge from before them).
function harness(t, { seed = [], wrap = null, omit = [] } = {}) {
  const dom = new JSDOM('<!doctype html><body><section id="boardView"></section></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  let tick = Date.parse('2026-11-14T10:00:00.000Z');
  let seq = 0;
  const source = createMemoryBoardSource({ model, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(++seq), seed });
  const calls = [];
  const bridge = { onChanged: (listener) => source.onChanged(listener) };
  for (const name of Object.keys(source)) {
    if (name === 'onChanged' || omit.includes(name)) continue;
    const record = (request) => { calls.push([name, request]); };
    const call = (request) => { record(request); return source[name](request); };
    bridge[name] = wrap ? wrap(name, call, record) : call;
  }
  window.jennyShell = { boards: bridge };
  const switcher = { currentProject: () => ({ id: PROJECT, name: 'Alpha' }), refresh: async () => [], onProjectsChanged: () => () => {} };
  const toasts = [];
  t.after(() => window.close());
  const doc = window.document;
  const h = {
    window, doc, source, calls, toasts,
    async start() {
      const page = createBoardPage({ container: doc.getElementById('boardView'), windowRef: window, storage: window.localStorage,
        getProjectSwitcher: async () => switcher, showToast: (message, options) => toasts.push({ message, ...options }) });
      t.after(() => page.dispose());
      await page.started;
      await flush();
      return page;
    },
    async board(name) { return (await source.create({ projectId: PROJECT, name })).board; },
    note: () => doc.querySelector('[data-board-note]'),
    action: (id) => doc.querySelector(`[data-board-note-action="${id}"]`),
    names: () => [...doc.querySelectorAll('[data-board-id] .session-row__title-text')].map((el) => el.textContent),
    openName: () => doc.querySelector('[data-board-id].active')?.getAttribute('data-board-name') || '',
    row: (name) => [...doc.querySelectorAll('[data-board-id]')].find((el) => el.getAttribute('data-board-name') === name),
  };
  return h;
}

test('a read-only board shows the sentence and the two buttons; a healthy board shows neither', async (t) => {
  const h = harness(t, { seed: [unreadable(BAD, 'Damaged', 'corrupt'), unreadable(NEWER, 'Future', 'newer_schema')] });
  await h.board('Healthy');
  await h.start();
  assert.equal(h.openName(), 'Damaged');
  assert.match(h.note().textContent, /damaged, so it is left as it is/);
  const reveal = h.action('reveal');
  const remove = h.action('set-aside');
  assert.deepEqual([reveal.textContent, reveal.title, reveal.disabled], ['Show file', "Open the folder that holds this board's file", false]);
  assert.deepEqual([remove.textContent, remove.title, remove.disabled], ['Remove from list', "Move this board's file aside and take it out of the list. Nothing is deleted.", false]);
  assert.equal(reveal.tagName, 'BUTTON');
  h.row('Future').querySelector('[data-board-action="open"]').click();
  await flush();
  assert.match(h.note().textContent, /newer version of Jenny/);
  assert.ok(h.action('reveal') && h.action('set-aside'), 'a newer-schema board offers them too');
  h.row('Healthy').querySelector('[data-board-action="open"]').click();
  await flush();
  assert.equal(h.openName(), 'Healthy');
  assert.equal(h.action('reveal'), null);
  assert.equal(h.action('set-aside'), null);
  assert.equal(h.note().hidden, true);
});

test('Show file asks for the open board\'s file; a refusal shows a warning toast; both buttons wait while it runs', async (t) => {
  let release = null;
  let answer = { ok: true };
  const h = harness(t, {
    seed: [unreadable(BAD, 'Damaged', 'corrupt')],
    wrap: (name, call, record) => (name === 'revealFile' ? (request) => { record(request); return new Promise((resolve) => { release = () => resolve(answer); }); } : call),
  });
  await h.start();
  h.action('reveal').click();
  await flush();
  assert.deepEqual(h.calls.filter(([name]) => name === 'revealFile'), [['revealFile', { boardId: BAD }]]);
  assert.deepEqual([h.action('reveal').disabled, h.action('set-aside').disabled], [true, true], 'both wait while the call runs');
  h.action('set-aside').click();
  await flush();
  assert.equal(h.calls.filter(([name]) => name === 'setAside').length, 0, 'a disabled button does nothing');
  release();
  await flush();
  assert.deepEqual([h.action('reveal').disabled, h.action('set-aside').disabled], [false, false]);
  assert.deepEqual(h.toasts, [], 'success says nothing: the folder opens');
  answer = { ok: false, reason: 'io' };
  h.action('reveal').click();
  await flush();
  release();
  await flush();
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].tone, 'warning');
  assert.equal(typeof h.toasts[0].message, 'string');
  assert.ok(h.toasts[0].message.length > 0);
});

test('Remove from list moves the board aside, says where, opens the next board, and with none left asks for a new one', async (t) => {
  const h = harness(t, { seed: [unreadable(BAD, 'Damaged', 'corrupt'), unreadable(NEWER, 'Future', 'newer_schema')] });
  await h.board('Healthy');
  await h.start();
  assert.deepEqual(h.names(), ['Damaged', 'Future', 'Healthy']);
  h.action('set-aside').focus();
  h.action('set-aside').click();
  await flush();
  assert.deepEqual(h.calls.filter(([name]) => name === 'setAside'), [['setAside', { boardId: BAD }]]);
  assert.match(h.toasts[0].message, new RegExp(`^Moved aside as ${BAD}\\.json\\.aside-\\d+\\. The file is still in Jenny's boards folder\\.$`));
  assert.notEqual(h.toasts[0].tone, 'warning');
  assert.deepEqual(h.names(), ['Future', 'Healthy']);
  assert.equal(h.openName(), 'Future', 'the next board opens');
  const focused = h.doc.activeElement;
  assert.ok(focused && focused !== h.doc.body && h.doc.contains(focused), 'focus is on an element that is still on the page');
  h.action('set-aside').click();
  await flush();
  assert.equal(h.openName(), 'Healthy');
  assert.equal(h.action('set-aside'), null, 'a healthy board offers no Remove from list');
  // The last board of the project, damaged: removing it leaves the empty state.
  const last = harness(t, { seed: [unreadable(BAD, 'Damaged', 'corrupt')] });
  await last.start();
  last.action('set-aside').focus();
  last.action('set-aside').click();
  await flush();
  assert.deepEqual(last.names(), []);
  assert.match(last.note().textContent, /Create a board to start\./);
  assert.equal(last.action('reveal'), null);
  const after = last.doc.activeElement;
  assert.ok(after && after !== last.doc.body && last.doc.contains(after), 'focus moved to the board list');
});

test('a refused Remove from list shows a warning toast and keeps the board', async (t) => {
  const h = harness(t, { seed: [unreadable(BAD, 'Damaged', 'corrupt')], wrap: (name, call, record) => (name === 'setAside' ? (request) => { record(request); return { ok: false, reason: 'io' }; } : call) });
  await h.start();
  h.action('set-aside').click();
  await flush();
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].tone, 'warning');
  assert.deepEqual(h.names(), ['Damaged']);
  assert.equal(h.action('set-aside').disabled, false);
});

test('a bridge without the two calls draws both buttons disabled with the reason', async (t) => {
  const h = harness(t, { seed: [unreadable(BAD, 'Damaged', 'corrupt')], omit: ['revealFile', 'setAside'] });
  await h.start();
  for (const id of ['reveal', 'set-aside']) {
    const button = h.action(id);
    assert.ok(button, `${id} is drawn, not hidden`);
    assert.equal(button.disabled, true);
    assert.equal(button.title, 'Not available in this version');
  }
  h.action('reveal').click();
  await flush();
  assert.deepEqual(h.calls.filter(([name]) => name === 'revealFile' || name === 'setAside'), []);
});

test('the moved file name from the main process reaches the page as text, never as markup', async (t) => {
  const hostile = '<img src=x onerror="globalThis.__pwned=1">.json.aside-1';
  const h = harness(t, { seed: [unreadable(BAD, 'Damaged', 'corrupt')], wrap: (name, call) => (name === 'setAside' ? (request) => { call(request); return { ok: true, movedTo: hostile }; } : call) });
  await h.start();
  h.action('set-aside').click();
  await flush();
  assert.equal(h.toasts[0].message, `Moved aside as ${hostile}. The file is still in Jenny's boards folder.`);
  assert.equal(h.doc.querySelector('img'), null);
  assert.equal(h.window.__pwned, undefined);
});
