// new-test-file: a new surface (boardCard and connectorLayer); split from inventory-board-primitives.test.js to stay under the line cap.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const boardCard = require('../renderer/inventory/board-card');
const connectorLayer = require('../renderer/inventory/connector-layer');

// One DOM per test. The primitives build elements with the global document, as in the app.
function makeEnv() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  globalThis.document = dom.window.document;
  return dom.window;
}


const HOSTILE = ['<img src=x onerror=1>', '</script><script>alert(1)</script>'];

test('boardCard renders hostile text as text and creates no element from it', () => {
  for (const hostile of HOSTILE) {
    makeEnv();
    const card = boardCard({
      id: hostile, kind: 'note', x: 1, y: 2, w: 120, h: 80, title: hostile, text: `${hostile}\nsecond line`, meta: hostile,
    });
    assert.equal(card.querySelector('img'), null);
    assert.equal(card.querySelector('script'), null);
    assert.equal(card.querySelector('[data-card-title]').textContent, hostile);
    assert.equal(card.querySelector('[data-card-body]').textContent, `${hostile}\nsecond line`, 'line breaks are kept');
    assert.equal(card.querySelector('[data-card-meta]').textContent, hostile);
    assert.equal(card.getAttribute('data-card-id'), hostile);
    assert.equal(card.getAttribute('aria-label'), hostile);
  }
});

test('boardCard builds the documented structure and position', () => {
  makeEnv();
  const card = boardCard({ id: 'n1', kind: 'file', x: 40, y: 25.5, w: 200, h: 90, z: 7, title: 'readme.md', text: 'first\nsecond' });
  assert.equal(card.getAttribute('data-card-kind'), 'file');
  assert.equal(card.getAttribute('role'), 'group');
  assert.equal(card.getAttribute('tabindex'), '0');
  assert.equal(card.getAttribute('aria-label'), 'readme.md');
  assert.equal(card.style.left, '40px');
  assert.equal(card.style.top, '25.5px');
  assert.equal(card.style.width, '200px');
  assert.equal(card.style.height, '90px');
  assert.equal(card.style.zIndex, '7');
  assert.ok(card.querySelector('.inv-board-card-glyph'));
  assert.ok(card.querySelector('[data-card-body]'));
  const untitled = boardCard({ id: 'n2', kind: 'note', x: 0, y: 0, w: 10, h: 10, text: '  first line\nsecond' });
  assert.equal(untitled.getAttribute('aria-label'), 'first line');
  const blank = boardCard({ id: 'n3', kind: 'diagram', x: 0, y: 0, w: 10, h: 10 });
  assert.ok(blank.getAttribute('aria-label'), 'a card with no text still has a name');
  assert.equal(boardCard({ id: 'n4', kind: 'nonsense', x: 0, y: 0, w: 1, h: 1 }).getAttribute('data-card-kind'), 'note');
});

test('boardCard sets, changes and clears every state attribute', () => {
  makeEnv();
  const base = { id: 's1', kind: 'note', x: 0, y: 0, w: 100, h: 60, text: 'x' };
  const card = boardCard({ ...base, selected: true, ghost: true, missing: true, locked: true, tone: 'amber' });
  for (const name of ['data-selected', 'data-ghost', 'data-missing', 'data-locked']) {
    assert.ok(card.hasAttribute(name), `${name} is set`);
  }
  assert.equal(card.getAttribute('data-tone'), 'amber');
  assert.equal(card.style.opacity, '', 'a ghost never lowers opacity inline');
  assert.equal(card.querySelector('[data-card-missing]').hidden, false, 'a missing file says so in words');

  boardCard.update(card, { ...base, tone: 'blue' });
  for (const name of ['data-selected', 'data-ghost', 'data-missing', 'data-locked']) {
    assert.equal(card.hasAttribute(name), false, `${name} is cleared`);
  }
  assert.equal(card.getAttribute('data-tone'), 'blue');
  assert.equal(card.querySelector('[data-card-missing]').hidden, true);
  boardCard.update(card, { ...base, tone: 'chartreuse' });
  assert.equal(card.hasAttribute('data-tone'), false, 'an unknown tone is ignored');
  for (const tone of ['amber', 'blue', 'green', 'red']) {
    boardCard.update(card, { ...base, tone });
    assert.equal(card.getAttribute('data-tone'), tone);
  }
});

test('boardCard ghost is the dashed state, not a lowered opacity, in the style sheet', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'inventory', 'inventory-board.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.split('}').map((rule) => rule.trim()).filter(Boolean);
  const ghostRules = rules.filter((rule) => rule.split('{')[0].includes('ghost'));
  assert.ok(ghostRules.length > 0, 'the style sheet styles the ghost state');
  for (const rule of ghostRules) {
    assert.doesNotMatch(rule, /(^|[;{\s])opacity\s*:/, `no opacity in: ${rule.split('{')[0].trim()}`);
  }
  assert.ok(ghostRules.some((rule) => /dashed/.test(rule)), 'a ghost rule draws a dashed outline');
  assert.doesNotMatch(css, /\bborder-(inline|block)?-?(left|right|start|end)\b[^;]*:\s*\d/, 'no side accent bars');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/, 'no literal colour');
});

test('boardCard resize grip and connect handles are real buttons, rendered only when asked for', () => {
  makeEnv();
  const base = { id: 'h1', kind: 'note', x: 0, y: 0, w: 100, h: 60, text: 'x' };
  const plain = boardCard(base);
  assert.equal(plain.querySelector('[data-card-resize]'), null);
  assert.equal(plain.querySelector('[data-card-connect]'), null);

  const full = boardCard({ ...base, resizable: true, connectable: true });
  const grip = full.querySelector('[data-card-resize]');
  assert.equal(grip.tagName, 'BUTTON');
  assert.ok(grip.getAttribute('aria-label'));
  const sides = [...full.querySelectorAll('[data-card-connect]')].map((el) => el.getAttribute('data-card-connect'));
  assert.deepEqual(sides.sort(), ['e', 'n', 's', 'w']);
  for (const handle of full.querySelectorAll('[data-card-connect]')) {
    assert.equal(handle.tagName, 'BUTTON');
    assert.ok(handle.getAttribute('aria-label'));
  }
  boardCard.update(full, { ...base, resizable: false, connectable: true });
  assert.equal(full.querySelector('[data-card-resize]'), null);
  assert.equal(full.querySelectorAll('[data-card-connect]').length, 4);
  const kept = full.querySelector('[data-card-connect="n"]');
  boardCard.update(full, { ...base, resizable: true, connectable: true, x: 5 });
  assert.equal(full.querySelector('[data-card-connect="n"]'), kept, 'handles are not rebuilt');
});

test('boardCard update keeps a body node the caller appended and changes only what differs', () => {
  makeEnv();
  const base = { id: 'b1', kind: 'image', x: 0, y: 0, w: 200, h: 120, title: 'Shot' };
  const card = boardCard(base);
  const body = card.querySelector('[data-card-body]');
  const picture = card.ownerDocument.createElement('div');
  picture.className = 'caller-picture';
  body.appendChild(picture);

  boardCard.update(card, { ...base, x: 60, y: 70, w: 220, title: 'Renamed', selected: true, text: 'a caption', meta: '1200 x 800' });
  assert.equal(card.querySelector('[data-card-body]'), body, 'the body element is the same node');
  assert.equal(body.querySelector('.caller-picture'), picture, 'the appended node is still there');
  assert.equal(card.style.left, '60px');
  assert.equal(card.querySelector('[data-card-title]').textContent, 'Renamed');
  assert.equal(card.querySelector('[data-card-meta]').textContent, '1200 x 800');

  const title = card.querySelector('[data-card-title]');
  const mutations = [];
  const observer = new card.ownerDocument.defaultView.MutationObserver((records) => mutations.push(...records));
  observer.observe(card, { attributes: true, childList: true, subtree: true, characterData: true });
  boardCard.update(card, { ...base, x: 60, y: 70, w: 220, title: 'Renamed', selected: true, text: 'a caption', meta: '1200 x 800' });
  assert.equal(card.querySelector('[data-card-title]'), title);
  return Promise.resolve().then(() => {
    assert.equal(mutations.length, 0, 'an identical update touches nothing');
    observer.disconnect();
  });
});

test('boardCard group is a titled region behind other cards with no body', () => {
  makeEnv();
  const group = boardCard({ id: 'g1', kind: 'group', x: 0, y: 0, w: 300, h: 200, z: 9, title: 'Checkout', text: 'ignored' });
  assert.equal(group.getAttribute('data-card-kind'), 'group');
  assert.equal(group.querySelector('[data-card-body]'), null);
  assert.equal(group.querySelector('[data-card-title]').textContent, 'Checkout');
  assert.equal(group.style.zIndex, '0');
  const note = boardCard({ id: 'n1', kind: 'note', x: 0, y: 0, w: 10, h: 10, z: 0, text: 'x' });
  assert.ok(Number(note.style.zIndex) > Number(group.style.zIndex), 'any other card stacks above a group');
});

// ------------------------------------------------------------ connectorLayer

const A = { x: 0, y: 0, w: 100, h: 60 };
const B = { x: 300, y: 40, w: 100, h: 60 };
function connector(id, extra = {}) { return { id, from: A, to: B, label: '', style: 'solid', ends: 'end', ...extra }; }
function allFinite(result) {
  assert.ok(!/NaN|Infinity/.test(result.d), `path has no NaN: ${result.d}`);
  for (const point of [result.start, result.end, result.mid]) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), 'points are finite');
  }
}

test('connectorLayer keeps the same <g> for an unchanged connector across two renders', () => {
  makeEnv();
  const layer = connectorLayer();
  assert.equal(layer.element.tagName.toLowerCase(), 'svg');
  layer.render([connector('a'), connector('b', { to: { x: 0, y: 300, w: 100, h: 60 } })]);
  const first = layer.element.querySelector('[data-connector-id="a"]');
  const second = layer.element.querySelector('[data-connector-id="b"]');
  assert.ok(first && second);
  const mutations = [];
  const observer = new first.ownerDocument.defaultView.MutationObserver((records) => mutations.push(...records));
  observer.observe(first, { attributes: true, childList: true, subtree: true, characterData: true });
  layer.render([connector('a'), connector('b', { to: { x: 0, y: 300, w: 100, h: 60 } })]);
  assert.equal(layer.element.querySelector('[data-connector-id="a"]'), first);
  assert.equal(layer.element.querySelector('[data-connector-id="b"]'), second);
  return Promise.resolve().then(() => {
    assert.equal(mutations.length, 0, 'an unchanged connector is not touched');
    observer.disconnect();
  });
});

test('connectorLayer removes a dropped connector and updates a changed one in place', () => {
  makeEnv();
  const layer = connectorLayer();
  layer.render([connector('a'), connector('b')]);
  const first = layer.element.querySelector('[data-connector-id="a"]');
  const pathBefore = first.querySelector('path').getAttribute('d');
  layer.render([connector('a', { to: { x: 500, y: 500, w: 100, h: 60 }, label: 'blocks', ends: 'both', style: 'dashed', selected: true, ghost: true })]);
  assert.equal(layer.element.querySelector('[data-connector-id="b"]'), null, 'the dropped connector is gone');
  assert.equal(layer.element.querySelectorAll('[data-connector-id]').length, 1);
  assert.equal(layer.element.querySelector('[data-connector-id="a"]'), first, 'a changed connector keeps its node');
  assert.notEqual(first.querySelector('path').getAttribute('d'), pathBefore);
  assert.equal(first.querySelector('text').textContent, 'blocks');
  assert.equal(first.querySelectorAll('[data-connector-arrow]').length, 2);
  assert.equal(first.getAttribute('data-style'), 'dashed');
  assert.ok(first.hasAttribute('data-selected'));
  assert.ok(first.hasAttribute('data-ghost'));
  layer.render([connector('a')]);
  assert.equal(first.querySelectorAll('[data-connector-arrow]').length, 1);
  assert.equal(first.querySelector('text'), null, 'an empty label draws no text');
  layer.render([connector('a', { ends: 'none' })]);
  assert.equal(first.querySelectorAll('[data-connector-arrow]').length, 0);
  layer.dispose();
});

test('connectorLayer writes a hostile label and id as text and attributes only', () => {
  makeEnv();
  const layer = connectorLayer();
  layer.render([connector(HOSTILE[0], { label: HOSTILE[1] })]);
  assert.equal(layer.element.querySelector('script'), null);
  assert.equal(layer.element.querySelector('img'), null);
  assert.equal(layer.element.querySelector('text').textContent, HOSTILE[1]);
  assert.equal(layer.element.querySelector('g').getAttribute('data-connector-id'), HOSTILE[0]);
});

test('connectorPath never returns NaN for overlapping or identical rectangles', () => {
  const { connectorPath } = connectorLayer;
  assert.equal(typeof connectorPath, 'function');
  allFinite(connectorPath(A, B));
  allFinite(connectorPath(A, A));
  allFinite(connectorPath(A, { x: 50, y: 30, w: 100, h: 60 }));
  allFinite(connectorPath({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 }));
  allFinite(connectorPath({ x: Number.NaN, y: 0, w: 10, h: 10 }, undefined));
  const apart = connectorPath(A, B);
  assert.equal(apart.start.x, 100, 'leaves the near side of the first rectangle');
  assert.equal(apart.end.x, 300, 'meets the near side of the second rectangle');
  assert.ok(apart.mid.x > apart.start.x && apart.mid.x < apart.end.x);
  const stacked = connectorPath(A, { x: 0, y: 300, w: 100, h: 60 });
  assert.equal(stacked.start.y, 60);
  assert.equal(stacked.end.y, 300);
});

test('connectorLayer hitTest returns the nearest connector inside the tolerance, else null', () => {
  makeEnv();
  const layer = connectorLayer();
  const first = connector('near');
  const second = connector('far', { from: { x: 0, y: 400, w: 100, h: 60 }, to: { x: 300, y: 440, w: 100, h: 60 } });
  layer.render([first, second]);
  const onPath = connectorLayer.connectorPath(first.from, first.to).mid;
  assert.equal(layer.hitTest(onPath.x, onPath.y, 4), 'near');
  assert.equal(layer.hitTest(onPath.x, onPath.y + 3, 6), 'near');
  assert.equal(layer.hitTest(onPath.x, onPath.y - 150, 6), null, 'too far away');
  const farMid = connectorLayer.connectorPath(second.from, second.to).mid;
  assert.equal(layer.hitTest(farMid.x + 2, farMid.y + 2, 10), 'far');
  assert.equal(layer.hitTest(-500, -500, 10), null);
  layer.render([second]);
  assert.equal(layer.hitTest(onPath.x, onPath.y, 4), null, 'a removed connector can no longer be hit');
});
