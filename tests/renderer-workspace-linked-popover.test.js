const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createWorkspaceChromeController } = require('../renderer/shell/renderer-workspace-chrome-utils');

function openPopover(t, sessions, links, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="rail"></div></body></html>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  t.after(async () => {
    delete global.window;
    delete global.document;
    await dom.window.close();
  });
  const doc = dom.window.document;
  const changes = [];
  const controller = createWorkspaceChromeController({ containerEl: doc.getElementById('rail'), onLinkSessionsRequested() {} });
  controller.renderRail([sessions[0].id], sessions[0].id, [sessions[0]], [], []);
  options.beforeOpen?.(dom);
  controller.showLinkedSessionPopover(sessions[0].id, sessions, links, (ids) => changes.push(ids.slice()), options.anchor);
  const popover = doc.querySelector('.workspace-linked-popover');
  const rowIds = () => [...popover.querySelectorAll('.workspace-linked-row input')].map((input) => input.dataset.linkedSessionId);
  const key = (target, name) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true }));
  return { dom, doc, popover, changes, rowIds, key, search: popover.querySelector('input[type="search"]') };
}

const SESSIONS = [
  { id: 'a', title: 'Anchor' },
  { id: 'b', title: 'Book club discussion prompts' },
  { id: 'c', title: 'Python refactor of parser' },
  { id: 'd', title: 'Travel itinerary for Lisbon' },
];

test('the link popover is a labelled dialog with a title, purpose line and footer count', (t) => {
  const { popover, search } = openPopover(t, SESSIONS, ['c']);
  assert.equal(popover.getAttribute('role'), 'dialog');
  assert.equal(popover.getAttribute('aria-label'), 'Link sessions');
  assert.equal(popover.querySelector('.workspace-linked-title').textContent, 'Link sessions');
  assert.match(popover.querySelector('.workspace-linked-subtitle').textContent, /3 newest linked chats/);
  assert.equal(popover.querySelector('.workspace-linked-footer').textContent, 'Linked: 1 · In recall: 1');
  assert.equal(popover.querySelector('.workspace-linked-row-title').title, 'Python refactor of parser', 'full title rides the tooltip');
  assert.equal(popover.ownerDocument.activeElement, search, 'search takes focus on open');
  assert.equal(popover.querySelector('.approved-memory-input, .composer-popover-row, .composer-popover-copy'), null, 'no borrowed settings/attachments classes');
});

test('linked sessions lead at open and the order holds while toggling', async (t) => {
  const { dom, popover, rowIds, changes } = openPopover(t, SESSIONS, ['d']);
  assert.deepEqual(rowIds(), ['d', 'b', 'c']);
  const box = popover.querySelector('input[data-linked-session-id="c"]');
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await Promise.resolve();
  assert.deepEqual(rowIds(), ['d', 'b', 'c'], 'a toggle never reorders rows under the pointer');
  assert.deepEqual(changes.at(-1), ['d', 'c']);
});

test('an unmatched search and a lone session both say so instead of going blank', (t) => {
  const { dom, popover, search } = openPopover(t, SESSIONS, []);
  search.value = 'zzz';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(popover.querySelector('.workspace-linked-empty').textContent, 'No sessions match.');
  assert.equal(popover.ownerDocument.activeElement, search, 'filtering keeps focus in search');

  const lone = openPopover(t, [{ id: 'a', title: 'Anchor' }], []);
  assert.equal(lone.popover.querySelector('.workspace-linked-empty').textContent, 'No other sessions yet.');
});

test('arrow keys walk search and rows; Enter toggles a lone match', async (t) => {
  const { dom, doc, popover, search, key, changes } = openPopover(t, SESSIONS, []);
  key(search, 'ArrowDown');
  assert.equal(doc.activeElement.dataset.linkedSessionId, 'b');
  key(doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement.dataset.linkedSessionId, 'c');
  key(doc.activeElement, 'ArrowUp');
  key(doc.activeElement, 'ArrowUp');
  assert.equal(doc.activeElement, search, 'ArrowUp off the first row returns to search');

  key(search, 'Enter');
  assert.deepEqual(changes, [], 'Enter with several matches does nothing');
  search.value = 'lisbon';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  assert.deepEqual(changes, [], 'Enter that confirms an IME composition never toggles a link');
  search.value = 'lisbon';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  key(search, 'Enter');
  await Promise.resolve();
  assert.deepEqual(changes, [['d']]);
  assert.equal(popover.querySelector('input[data-linked-session-id="d"]').checked, true);
});

test('placement uses the filled height: flips above a low anchor and clamps to the viewport', (t) => {
  const stubHeight = (dom, size = {}) => {
    if (size.innerHeight) Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: size.innerHeight });
    if (size.innerWidth) Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: size.innerWidth });
    const original = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function stubbed() {
      if (!this.classList.contains('workspace-linked-popover')) return original.call(this);
      // Height only exists once the rows are in: an empty list measured 0.
      const height = this.querySelectorAll('.workspace-linked-row').length ? 300 : 0;
      return { left: 0, top: 0, right: 320, bottom: height, width: 320, height };
    };
  };
  const low = openPopover(t, SESSIONS, [], { anchor: { x: 40, y: 700 }, beforeOpen: stubHeight });
  assert.equal(low.popover.style.top, '392px', 'no room below 700 in a 768 viewport, so it opens above');
  const high = openPopover(t, SESSIONS, [], { anchor: { x: 40, y: 40 }, beforeOpen: stubHeight });
  assert.equal(high.popover.style.top, '48px', 'room below keeps it under the anchor');
  const short = openPopover(t, SESSIONS, [], { anchor: { x: 40, y: 40 }, beforeOpen: (dom) => stubHeight(dom, { innerHeight: 300 }) });
  assert.equal(short.popover.style.top, '16px', 'no room either way pins it to the top margin (CSS caps its height)');
  const edge = openPopover(t, SESSIONS, [], { anchor: { x: 900, y: 40 }, beforeOpen: (dom) => stubHeight(dom, { innerWidth: 1024 }) });
  assert.equal(edge.popover.style.left, '688px', 'a right-edge anchor keeps the full width on screen');
});
