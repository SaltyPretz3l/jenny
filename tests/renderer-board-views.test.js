'use strict';

// new-test-file: a new surface (the board's two views put together on the page, row 150 slice B5's integration);
// renderer-board-page.test.js is at its line cap. The real page, canvas, outline, find box, key map and view switch
// over jsdom, with the in-memory board source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const boardPage = require('../renderer/features/board/board-page');
const boardPalette = require('../renderer/features/board/board-palette');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const later = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)); } };
}

async function harness(t, { storage = memoryStorage(), source = null, switcher = null, prepare = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><section id="boardView"></section></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  if (prepare) prepare(window);
  let seq = 100;
  const boards = source || createMemoryBoardSource({ model, makeId: () => uid(++seq) });
  window.jennyShell = { boards };
  let first = null;
  let second = null;
  if (!source) {
    first = (await boards.create({ projectId: 'project_general', name: 'Plan' })).board;
    second = (await boards.create({ projectId: 'project_general', name: 'Ideas' })).board;
    const added = await boards.apply({ boardId: first.id, batch: { batch_id: uid(1), board_id: first.id, actor: 'owner', ops: [
      { op: 'card.add', card: { id: uid(11), kind: 'note', data: { text: 'Ship the outline', tone: null } } },
      { op: 'card.add', card: { id: uid(12), kind: 'note', data: { text: 'Write the release note', tone: null } } },
    ] } });
    assert.equal(added.ok, true);
  }
  const logs = [];
  const options = {
    container: window.document.getElementById('boardView'), windowRef: window, storage,
    appendClientLog: (...args) => logs.push(args), getProjectSwitcher: async () => switcher,
  };
  const page = boardPage.showBoardPage(options);
  t.after(() => { boardPage.hideBoardPage(); window.close(); });
  await page.started;
  await flush();
  const doc = window.document;
  const q = (selector) => doc.querySelector(selector);
  return {
    window, doc, q, page, boards, storage, logs, first, second, show: () => boardPage.showBoardPage(options),
    choose: (view) => q(`[data-board-view-switch] [data-value="${view}"]`).click(),
    key: (target, init) => {
      const event = new window.KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init));
      target.dispatchEvent(event);
      return event;
    },
  };
}

test('the page starts on the canvas: the outline and the find box are there but hidden, and the switch sits in the toolbar', async (t) => {
  const h = await harness(t);
  assert.deepEqual(h.logs.filter(([level]) => level === 'WARN'), []);
  assert.equal(h.page.getView(), 'canvas');
  assert.equal(h.page.getOpenBoardId(), h.first.id);
  assert.ok(h.q('.wb-stack--editor [data-board-views] > [data-board-centre] .inv-board-canvas'), 'the canvas stands in the centre column');
  assert.equal(h.q('[data-board-centre]').hidden, false);
  assert.equal(h.q('.board-outline').hidden, true);
  assert.equal(h.q('[data-board-find]').hidden, true);
  assert.ok(h.q('[data-board-toolbar-slot] > [data-board-view-switch]'), 'the switch is in the canvas toolbar');
  assert.equal(h.q('[data-board-views]').getAttribute('data-board-view'), 'canvas');
});

test('choosing Outline hides the canvas, draws the board as an outline, moves the switch into its bar and is remembered for the project', async (t) => {
  const h = await harness(t);
  h.choose('outline');
  await flush();
  assert.equal(h.page.getView(), 'outline');
  assert.equal(h.q('[data-board-centre]').hidden, true, 'the canvas is hidden, not only covered');
  const outline = h.q('.board-outline');
  assert.equal(outline.hidden, false);
  assert.match(outline.textContent, /Ship the outline/);
  assert.match(outline.textContent, /Write the release note/);
  assert.ok(h.q('.board-outline__bar > [data-board-view-switch]'), 'the switch is at the end of the outline\'s bar');
  assert.ok(outline.contains(h.doc.activeElement), 'focus went into the outline');
  // Back again.
  h.choose('canvas');
  await flush();
  assert.equal(h.page.getView(), 'canvas');
  assert.equal(h.q('[data-board-centre]').hidden, false);
  assert.equal(outline.hidden, true);
  assert.ok(h.q('[data-board-toolbar-slot] > [data-board-view-switch]'));
  // The next page for the same project comes back in the view it was left in.
  h.choose('outline');
  await flush();
  boardPage.hideBoardPage();
  const again = await harness(t, { storage: h.storage, source: h.boards });
  assert.equal(again.page.getView(), 'outline');
  assert.equal(again.q('[data-board-centre]').hidden, true);
  assert.match(again.q('.board-outline').textContent, /Ship the outline/);
});

test('an edit made on the canvas shows in the outline, and one made from the outline shows on the canvas', async (t) => {
  const h = await harness(t);
  h.choose('outline');
  await flush();
  h.q('[data-outline-add="note"]').click();
  await flush();
  const board = (await h.boards.get({ boardId: h.first.id })).board;
  assert.equal(Object.keys(board.cards).length, 3, 'the outline\'s Add note stored a card');
  h.choose('canvas');
  await flush();
  assert.equal(h.q('[data-board-centre]').querySelectorAll('.inv-board-card').length, 3, 'the canvas draws it');
});

test('a hidden outline is not redrawn by board changes, and is current when it is shown again', async (t) => {
  const h = await harness(t);
  const outline = h.q('.board-outline');
  let touched = 0;
  const watch = new h.window.MutationObserver((records) => { touched += records.length; });
  watch.observe(outline, { subtree: true, childList: true, attributes: true, characterData: true });
  const added = await h.boards.apply({ boardId: h.first.id, batch: { batch_id: uid(2), board_id: h.first.id, actor: 'owner', ops: [
    { op: 'card.add', card: { id: uid(13), kind: 'note', data: { text: 'Added while the outline was hidden', tone: null } } },
  ] } });
  assert.equal(added.ok, true);
  await flush();
  assert.equal(h.q('[data-board-centre]').querySelectorAll('.inv-board-card').length, 3, 'the canvas drew the new card');
  assert.equal(touched, 0, 'the hidden outline was not touched');
  assert.doesNotMatch(outline.textContent, /Added while/);
  h.choose('outline');
  await flush();
  assert.match(outline.textContent, /Added while the outline was hidden/);
  assert.match(outline.textContent, /Ship the outline/);
  // While it shows it follows the board again.
  const more = await h.boards.apply({ boardId: h.first.id, batch: { batch_id: uid(3), board_id: h.first.id, actor: 'owner', ops: [
    { op: 'card.add', card: { id: uid(14), kind: 'note', data: { text: 'Added while it showed', tone: null } } },
  ] } });
  assert.equal(more.ok, true);
  await flush();
  assert.match(outline.textContent, /Added while it showed/);
  watch.disconnect();
});

test('Ctrl+F opens the one find box from the canvas and from the outline; Escape in the outline is the outline\'s own', async (t) => {
  const h = await harness(t);
  const box = h.q('[data-board-find]');
  const fromCanvas = h.key(h.q('[data-board-centre] .inv-board-canvas'), { key: 'f', ctrlKey: true });
  assert.equal(fromCanvas.defaultPrevented, true);
  assert.equal(box.hidden, false);
  const input = box.querySelector('[data-board-find-input]');
  input.value = 'release';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.match(box.querySelector('[data-board-find-count]').textContent, /1/);
  box.querySelector('[data-board-find-close]').click();
  assert.equal(box.hidden, true);
  h.choose('outline');
  await flush();
  const row = h.q('.board-outline [role="treeitem"]');
  const fromOutline = h.key(row, { key: 'f', ctrlKey: true });
  assert.equal(fromOutline.defaultPrevented, true);
  assert.equal(box.hidden, false, 'the same box, opened from the outline');
  assert.equal(h.doc.querySelectorAll('[data-board-find]').length, 1);
  // A plain f in the outline is not find.
  box.querySelector('[data-board-find-close]').click();
  assert.equal(h.key(row, { key: 'f' }).defaultPrevented, false);
  assert.equal(box.hidden, true);
});

test('openBoard opens another board of the project on the live page, ignores an unknown id, and the palette\'s row uses it', async (t) => {
  const h = await harness(t);
  await h.page.openBoard('board_unknown');
  assert.equal(h.page.getOpenBoardId(), h.first.id, 'an id that is not in the list changes nothing');
  await boardPage.openBoard(h.second.id);
  await flush();
  assert.equal(h.page.getOpenBoardId(), h.second.id);
  // The palette: its row remembers the board and tells the page that is up.
  h.window.rendererBoardPage = boardPage;
  h.window.rendererBoardLayoutStore = require('../renderer/features/board/board-layout-store');
  Object.defineProperty(h.window, 'localStorage', { value: h.storage, configurable: true });
  boardPalette.reset();
  await boardPalette.refresh({ windowRef: h.window, getProjectSwitcher: async () => null });
  let navigated = 0;
  const rows = boardPalette.paletteItems({ navigate: () => { navigated += 1; }, windowRef: h.window, getProjectSwitcher: async () => null });
  assert.deepEqual(rows.map((row) => row.label).sort(), ['Ideas', 'Plan']);
  rows.find((row) => row.label === 'Plan').run();
  await flush();
  assert.equal(navigated, 1);
  assert.equal(h.page.getOpenBoardId(), h.first.id, 'the page that was up opened the chosen board');
  boardPalette.reset();
});

test('hiding the page takes the outline, the find box, the switch and the key map away, and a late openBoard does nothing', async (t) => {
  const h = await harness(t);
  const canvas = h.q('[data-board-centre] .inv-board-canvas');
  boardPage.hideBoardPage();
  assert.equal(h.doc.getElementById('boardView').children.length, 0);
  assert.equal(h.doc.querySelector('.board-outline, [data-board-find], [data-board-view-switch], [data-board-views]'), null);
  assert.equal(h.key(canvas, { key: 'f', ctrlKey: true }).defaultPrevented, false, 'the detached canvas answers no key');
  await boardPage.openBoard(h.second.id);
  assert.equal(h.page.getOpenBoardId(), h.first.id);
});

// A rule left open swallows every rule after it without any error (slices B7 to B9 shipped that way).
test('the board stylesheets close every rule they open', () => {
  for (const name of ['styles/board.css', 'styles/board-outline.css', 'styles/board-proposals.css', 'renderer/inventory/inventory-board.css']) {
    const css = fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      assert.ok(depth >= 0 && depth <= 2, `${name}: brace depth ${depth}`);
    }
    assert.equal(depth, 0, `${name} ends inside a rule`);
  }
});

test('a new board opens on the canvas when its created event arrives before the answer to create, as over the real bridge', async (t) => {
  let seq = 900;
  const source = createMemoryBoardSource({ model, makeId: () => uid(++seq) });
  const list = source.list;
  source.list = async (request) => { const answer = await list(request); await later(); return answer; }; // a list answer is never first
  const h = await harness(t, { source });
  assert.equal(h.q('[data-board-toolbar]').getClientRects !== undefined && h.q('[data-board-tool="note"]').disabled, true, 'no board yet');
  h.q('[data-board-action="new"]').click();
  await flush();
  assert.equal(h.doc.querySelectorAll('[data-board-id]').length, 1);
  assert.equal(h.q('[data-board-tool="note"]').disabled, false, 'the new board is open on the canvas, not only in the list');
});

test('a note added from the toolbar is shown clear of the toolbar, which floats over the top of the canvas', async (t) => {
  const h = await harness(t);
  const box = (top, height) => () => ({ left: 0, top, right: 800, bottom: top + height, width: 800, height, x: 0, y: top });
  h.q('.inv-board-canvas').getBoundingClientRect = box(0, 600);
  h.q('.board-chrome').getBoundingClientRect = box(16, 90);
  h.q('[data-board-tool="note"]').click();
  await flush();
  const card = h.q('.inv-board-card:has([data-board-field])') || [...h.doc.querySelectorAll('.inv-board-card')].pop();
  const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(card.parentElement.style.transform).map(Number);
  const top = parseFloat(card.style.top) + y;
  assert.ok(top >= 106, `the new card starts below the toolbar (top ${top})`);
  assert.ok(parseFloat(card.style.left) + x >= 0);
});

test('a page that started before the Workspace folder was known follows its project when the tab is shown again', async (t) => {
  let current = null; // at launch the switcher has the list but not yet the folder, and says nothing when it learns it
  const switcher = { currentProject: () => current, onProjectsChanged: () => () => {}, refresh: async () => {} };
  const h = await harness(t, { switcher });
  assert.equal(h.page.getProjectId(), 'project_general');
  assert.equal(h.doc.querySelectorAll('[data-board-id]').length, 2);
  current = { id: 'project_site', name: 'Site' };
  assert.equal(h.show(), h.page, 'the same page: showing the tab again builds nothing');
  await flush();
  assert.equal(h.page.getProjectId(), 'project_site');
  assert.equal(h.q('.board-list__project').textContent, 'Site');
  assert.equal(h.doc.querySelectorAll('[data-board-id]').length, 0, 'the boards listed are that project\'s');
});

test('with tools overflowing into the More menu the page re-measures on resize and the view switch still moves between the slot and the outline bar', async (t) => {
  const observers = [];
  const room = { toolbar: 420, page: 800 };
  const prepare = (window) => {
    // jsdom has no layout: every element is 90px wide and the toolbar has 420px of room.
    window.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} };
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 90, bottom: 20, width: 90, height: 20, x: 0, y: 0 });
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('board-toolbar') ? room.toolbar : room.page; } });
  };
  const h = await harness(t, { prepare });
  const resize = async (page) => { room.page = page; observers.forEach((observer) => observer.callback([])); await new Promise((resolve) => setTimeout(resolve, 80)); };
  const all = () => [...h.doc.querySelectorAll('[data-board-tool]')];
  await resize(801);
  assert.equal(h.q('[data-board-more]').hidden, false, 'the bar is narrower than its tools');
  assert.ok(all().some((el) => el.hidden) && all().some((el) => !el.hidden));
  assert.ok(h.q('[data-board-toolbar-slot] > [data-board-view-switch]'), 'the switch is in the slot');
  h.choose('outline');
  await flush();
  assert.ok(h.q('.board-outline__bar > [data-board-view-switch]'), 'the switch moved to the outline bar');
  assert.equal(h.q('[data-board-toolbar-slot]').childNodes.length, 0);
  room.toolbar = 2000;
  h.choose('canvas');
  await flush();
  assert.ok(h.q('[data-board-toolbar-slot] > [data-board-view-switch]'), 'and back into the slot');
  assert.equal(h.q('[data-board-more]').hidden, true, 'moving the switch back re-measured the bar: there is room now');
  assert.ok(all().every((el) => !el.hidden));
});
