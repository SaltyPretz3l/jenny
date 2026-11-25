'use strict';

// new-test-file: the presence lane of the team half of the Board (renderer/features/board/board-team-presence.js): how other members' pointers are
// drawn (transform, a colour each, counter-scaled at any zoom) and what happens to this member's own pointer on leaving the canvas. The cases
// that were in renderer-board-team-chat.test.js stay there (that file is near the 600-line cap), over the page kit of tests/helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const K = require('./helpers/board-team-page-kit');

const { DOT, MAYA, teamBoard, note, opened, tick } = K;
const ZED = 'member_zed0000000000000000';
const AMY = 'member_amy0000000000000000';
const BEN = 'member_ben0000000000000000';
const ROSTER = K.members([[DOT, 'Dot'], [MAYA, 'Maya'], [ZED, 'Zed'], [AMY, 'Amy'], [BEN, 'Ben']]);
const spot = (member_id, x, y) => ({ member_id, x, y, selected: [] });
const CROWD = { viewers: [DOT, MAYA, ZED, AMY, BEN], cursors: [spot(MAYA, 120, 80), spot(ZED, 10, 20), spot(AMY, 30, 40), spot(BEN, 50, 60), spot(DOT, 5, 5)], locks: [] };

async function crowd(t, state = CROWD) {
  const board = teamBoard(1, 'Plan', note(1, 'hello'));
  const m = await K.mount(t, { boards: [board], answers: { members: ROSTER, boardOpen: opened(board, state) } });
  await K.pickTeam(m);
  await m.flush();
  return m;
}
const cursors = (m) => m.qa('.inv-board-layer .board-team-cursor');
const byName = (m, name) => cursors(m).find((el) => el.textContent === name);
const surfaceOf = (m) => m.captured.ctx.canvas.surface;

test('presence: a pointer moves with transform, never left or top, and the same node moves on a push', async (t) => {
  const m = await crowd(t);
  const maya = byName(m, 'Maya');
  assert.deepEqual([cursors(m).length, maya.style.transform, maya.style.left, maya.style.top], [4, 'translate(120px, 80px) scale(1)', '', ''], 'this member own pointer is not drawn');
  K.pushPresence(m, { ...CROWD, cursors: [spot(MAYA, 200, 90)] });
  assert.deepEqual([cursors(m).length, byName(m, 'Maya') === maya, maya.style.transform, maya.style.left], [1, true, 'translate(200px, 90px) scale(1)', '']);
});

test('presence: every teammate has a colour of their own, the same one on every draw and on another page, and a hue the stylesheet defines from theme tokens', async (t) => {
  const m = await crowd(t);
  const hues = cursors(m).map((el) => [el.textContent, el.getAttribute('data-hue')]);
  assert.equal(new Set(hues.map(([, hue]) => hue)).size, 4, `four teammates, four hues: ${JSON.stringify(hues)}`);
  K.pushPresence(m, { ...CROWD, cursors: [spot(BEN, 51, 61), spot(MAYA, 121, 81)] });
  const now = Object.fromEntries(cursors(m).map((el) => [el.textContent, el.getAttribute('data-hue')]));
  assert.deepEqual(now, Object.fromEntries(hues.filter(([name]) => name in now)), 'a member keeps their hue through a redraw');
  const other = await crowd(t);
  assert.deepEqual(cursors(other).map((el) => [el.textContent, el.getAttribute('data-hue')]), hues, 'the same members get the same hues on another page');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'board-team.css'), 'utf8');
  const { window } = new JSDOM(`<!doctype html><style>${css}</style>`);
  const seen = new Map();
  [...window.document.styleSheets[0].cssRules].forEach((rule) => { const hit = /\.board-team-cursor\[data-hue="(\d)"\]/.exec(rule.selectorText || ''); if (hit) seen.set(hit[1], rule.style.getPropertyValue('--board-team-hue')); });
  assert.deepEqual([...seen.keys()].sort(), ['0', '1', '2', '3', '4', '5', '6', '7'], 'one rule for each of the eight members a team has');
  assert.equal([...seen.values()].every((value) => /var\(--[a-z-]+\)|color-mix\(in srgb, var\(--[a-z-]+\) \d+%, var\(--[a-z-]+\)\)/.test(value)), true, 'only theme tokens');
});

test('presence: a pointer is counter-scaled so it stays the same size at any zoom of the canvas, and a pointer drawn later starts at the zoom there is', async (t) => {
  const m = await crowd(t);
  const surface = surfaceOf(m);
  surface.setView({ x: 0, y: 0, zoom: 2 });
  await tick();
  assert.equal(byName(m, 'Maya').style.transform, 'translate(120px, 80px) scale(0.5)');
  surface.setView({ x: 40, y: 10, zoom: 0.5 });
  await tick();
  assert.equal(byName(m, 'Maya').style.transform, 'translate(120px, 80px) scale(2)');
  surface.setView({ x: 90, y: 10, zoom: 0.5 });
  await tick();
  assert.equal(byName(m, 'Maya').style.transform, 'translate(120px, 80px) scale(2)', 'a pan alone changes nothing');
  K.pushPresence(m, { ...CROWD, cursors: [spot(MAYA, 120, 80), spot(ZED, 1, 2)] });
  assert.equal(byName(m, 'Zed').style.transform, 'translate(1px, 2px) scale(2)');
  surface.setView({ x: 0, y: 0, zoom: 1 });
  await tick();
  assert.deepEqual(cursors(m).map((el) => el.style.transform), ['translate(120px, 80px) scale(1)', 'translate(1px, 2px) scale(1)']);
});

test('presence: a pointer goes when its member leaves, and every node and the observer of the zoom go with the board', async (t) => {
  const m = await crowd(t);
  K.pushPresence(m, { viewers: [DOT, ZED], cursors: [spot(ZED, 10, 20)], locks: [] });
  assert.deepEqual(cursors(m).map((el) => el.textContent), ['Zed']);
  K.pushPresence(m, { viewers: [DOT], cursors: [], locks: [] });
  assert.deepEqual([cursors(m).length, m.q('[data-board-team-presence]')], [0, null]);
  K.pushPresence(m, CROWD);
  await K.openMenu(m);
  await K.choose(m, 'General');
  assert.equal(m.qa('.board-team-cursor, [data-board-team-presence]').length, 0);
  surfaceOf(m).setView({ zoom: 3 });
  await tick(); // an observer left behind would throw here on the torn-down part; nothing is left
});

test('presence: this member pointer leaving the canvas stops what was about to be sent, and a move after coming back is sent again', async (t) => {
  const m = await crowd(t);
  const queue = [];
  m.window.requestAnimationFrame = (fn) => queue.push(fn);
  m.window.cancelAnimationFrame = (id) => { queue[id - 1] = null; };
  const surface = surfaceOf(m);
  const fire = (type, x = 0, y = 0) => surface.element.dispatchEvent(new m.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  const run = () => queue.splice(0).forEach((fn) => fn && fn(0));
  const sent = () => m.bridge.of('boardCursor').length;
  fire('pointermove', 10, 20);
  fire('pointerleave');
  run();
  assert.equal(sent(), 0, 'the position of a pointer that has left is not sent');
  fire('pointermove', 30, 40);
  run();
  assert.equal(sent(), 1, 'back on the canvas it is sent as before');
});
