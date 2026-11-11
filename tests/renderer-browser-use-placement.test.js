'use strict';

// The native browser view (row 114): it follows its spot in the panel, never covers something the
// app opened over the panel, and costs nothing while no page is on screen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createBrowserUsePlacement } = require('../renderer/chat/renderer-browser-use-placement');

const SHOT = 'data:image/png;base64,AAAA';
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup({ capture = { ok: true, data_url: SHOT, width: 400, height: 660 }, target = { sessionId: 's1' } } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="toastViewport"></div><div id="stage"><img id="frozen" class="hidden" alt=""></div><div id="menu"></div></body>');
  const doc = dom.window.document;
  const stage = doc.getElementById('stage');
  const image = doc.getElementById('frozen');
  const menu = doc.getElementById('menu');
  const ctx = {
    rect: { left: 600.4, top: 40.2, right: 1000.4, bottom: 700.2 }, target, calls: [], answers: {}, covered: () => null, hits: 0,
    frames: [], timers: new Map(), stage, image, menu, doc, listeners: [],
  };
  stage.getBoundingClientRect = () => ({ ...ctx.rect, width: ctx.rect.right - ctx.rect.left, height: ctx.rect.bottom - ctx.rect.top });
  doc.elementFromPoint = (x, y) => {
    ctx.hits += 1;
    ctx.points = [...(ctx.points || []), [x, y]];
    return ctx.covered(x, y) || stage;
  };
  const answer = (method, payload) => {
    ctx.calls.push([method, payload]);
    return Promise.resolve(ctx.answers[method] ?? (method === 'capture' ? capture : { ok: true }));
  };
  const api = Object.fromEntries(['show', 'setBounds', 'hide', 'capture'].map((name) => [name, (payload) => answer(name, payload)]));
  let timerId = 0;
  const addTimer = (fn, kind) => { timerId += 1; ctx.timers.set(timerId, { fn, kind }); return timerId; };
  const windowRef = {
    document: doc, innerWidth: 1400, innerHeight: 900,
    MutationObserver: dom.window.MutationObserver,
    addEventListener: (type, fn) => ctx.listeners.push([type, fn]),
    removeEventListener: (type, fn) => { ctx.listeners = ctx.listeners.filter((entry) => entry[0] !== type || entry[1] !== fn); },
    requestAnimationFrame: (fn) => { ctx.frames.push(fn); return ctx.frames.length; },
    cancelAnimationFrame: () => { ctx.frames = []; },
    setTimeout: (fn) => addTimer(fn, 'timeout'), clearTimeout: (id) => ctx.timers.delete(id),
    setInterval: (fn) => addTimer(fn, 'interval'), clearInterval: (id) => ctx.timers.delete(id),
  };
  ctx.placement = createBrowserUsePlacement({
    windowRef, getApi: () => api, getTarget: () => ctx.target, getStage: () => stage, getFrozenImage: () => image,
  });
  ctx.flush = async (rounds = 12) => {
    for (let index = 0; index < rounds; index += 1) {
      const frames = ctx.frames.splice(0);
      for (const frame of frames) frame(0);
      await settle();
    }
  };
  ctx.named = (method) => ctx.calls.filter((call) => call[0] === method);
  ctx.interval = () => [...ctx.timers.values()].find((timer) => timer.kind === 'interval');
  return ctx;
}

async function placed(options) {
  const ctx = setup(options);
  ctx.placement.request();
  await ctx.flush();
  return ctx;
}

test('the view goes over its spot in whole CSS pixels', async () => {
  const ctx = await placed();
  assert.deepEqual(ctx.named('show'), [['show', { session_id: 's1', bounds: { x: 600, y: 40, width: 400, height: 660 } }]]);
  assert.equal(ctx.named('setBounds').length, 0);
});

test('a moved panel moves the view, and an unmoved one sends nothing', async () => {
  const ctx = await placed();
  ctx.calls.length = 0;
  ctx.placement.request();
  await ctx.flush();
  assert.deepEqual(ctx.calls, []);
  ctx.rect = { left: 500, top: 40, right: 1000, bottom: 700 };
  ctx.placement.request();
  await ctx.flush();
  assert.deepEqual(ctx.calls, [['setBounds', { session_id: 's1', bounds: { x: 500, y: 40, width: 500, height: 660 } }]]);
});

test('the view keeps following while the column is still moving', async () => {
  const ctx = await placed();
  ctx.calls.length = 0;
  ctx.placement.request(1);
  ctx.rect = { left: 590, top: 40, right: 1000, bottom: 700 };
  ctx.frames.splice(0).forEach((frame) => frame(0));
  await settle();
  assert.equal(ctx.frames.length, 1, 'a change asks for another frame');
  ctx.rect = { left: 560, top: 40, right: 1000, bottom: 700 };
  ctx.frames.splice(0).forEach((frame) => frame(0));
  await settle();
  assert.deepEqual(ctx.named('setBounds').map((call) => call[1].bounds.x), [590, 560]);
});

test('with nothing to show the view leaves and nothing keeps listening', async () => {
  const ctx = await placed();
  ctx.calls.length = 0;
  ctx.target = null;
  ctx.placement.request();
  await ctx.flush();
  assert.deepEqual(ctx.calls, [['hide', { session_id: 's1' }]]);
  assert.deepEqual(ctx.listeners, []);
  ctx.calls.length = 0;
  ctx.doc.dispatchEvent(new ctx.doc.defaultView.Event('click'));
  await ctx.flush();
  assert.deepEqual(ctx.calls, []);
});

test('a page that closed is not hidden again, and the next page is shown fresh', async () => {
  const ctx = await placed();
  ctx.placement.forget('s1');
  ctx.calls.length = 0;
  ctx.target = null;
  ctx.placement.request();
  await ctx.flush();
  assert.deepEqual(ctx.calls, []);
  ctx.target = { sessionId: 's1' };
  ctx.placement.request();
  await ctx.flush();
  assert.equal(ctx.named('show').length, 1);
});

test('another chat swaps the view', async () => {
  const ctx = await placed();
  ctx.calls.length = 0;
  ctx.target = { sessionId: 's2' };
  ctx.placement.request();
  await ctx.flush();
  assert.deepEqual(ctx.calls.map((call) => [call[0], call[1].session_id]), [['hide', 's1'], ['show', 's2']]);
});

test('a page the main process no longer has is shown fresh next time', async () => {
  const ctx = await placed();
  ctx.answers.setBounds = { ok: false, reason: 'not_shown' };
  ctx.rect = { left: 500, top: 40, right: 1000, bottom: 700 };
  ctx.placement.request();
  await ctx.flush(1);
  ctx.answers.setBounds = undefined;
  ctx.calls.length = 0;
  ctx.placement.request();
  await ctx.flush();
  assert.equal(ctx.named('show').length, 1);
});

test('a menu over the panel swaps the view for its picture, and the view returns when it closes', async () => {
  const ctx = await placed();
  ctx.calls.length = 0;
  ctx.covered = () => ctx.menu;
  ctx.placement.request();
  await ctx.flush();
  assert.deepEqual(ctx.calls.map((call) => call[0]), ['capture', 'hide']);
  assert.equal(ctx.image.getAttribute('src'), SHOT);
  assert.equal(ctx.image.classList.contains('hidden'), false);
  assert.ok(ctx.interval(), 'watches for the menu closing');

  ctx.calls.length = 0;
  ctx.covered = () => null;
  ctx.interval().fn();
  await ctx.flush(1);
  assert.equal(ctx.named('show').length, 1);
  assert.equal(ctx.image.hasAttribute('src'), false, 'the picture goes once the view is back');
  assert.equal(ctx.image.classList.contains('hidden'), true);
  assert.equal(ctx.interval(), undefined);
});

test('a cover over one corner is enough', async () => {
  const ctx = await placed();
  ctx.calls.length = 0;
  ctx.covered = (x, y) => (x > 980 && y > 680 ? ctx.menu : null);
  ctx.placement.request();
  await ctx.flush();
  assert.deepEqual(ctx.calls.map((call) => call[0]), ['capture', 'hide']);
});

test('what sits inside the stage is not a cover', async () => {
  const ctx = await placed();
  ctx.calls.length = 0;
  ctx.covered = () => ctx.image;
  ctx.placement.request();
  await ctx.flush();
  assert.deepEqual(ctx.calls, []);
});

test('a failed picture still moves the view out of the menu\'s way', async () => {
  const ctx = await placed({ capture: { ok: false, reason: 'no_page' } });
  ctx.calls.length = 0;
  ctx.covered = () => ctx.menu;
  ctx.placement.request();
  await ctx.flush();
  assert.deepEqual(ctx.calls.map((call) => call[0]), ['capture', 'hide']);
  assert.equal(ctx.image.classList.contains('hidden'), true);
});

test('a menu that closes before its picture arrives leaves no picture behind', async () => {
  const ctx = await placed();
  ctx.calls.length = 0;
  let release;
  ctx.answers.capture = new Promise((resolve) => { release = resolve; });
  ctx.covered = () => ctx.menu;
  ctx.placement.request();
  ctx.frames.splice(0).forEach((frame) => frame(0));
  ctx.covered = () => null;
  ctx.placement.request();
  ctx.frames.splice(0).forEach((frame) => frame(0));
  release({ ok: true, data_url: SHOT, width: 1, height: 1 });
  await ctx.flush();
  assert.equal(ctx.image.hasAttribute('src'), false);
  assert.equal(ctx.named('hide').length, 0, 'the view never left');
});

test('a clicked menu is caught, including one that opens a moment later', async () => {
  const ctx = await placed();
  ctx.calls.length = 0;
  ctx.doc.dispatchEvent(new ctx.doc.defaultView.Event('click'));
  await ctx.flush();
  assert.deepEqual(ctx.calls, []);
  ctx.covered = () => ctx.menu;
  [...ctx.timers.values()].find((timer) => timer.kind === 'timeout').fn();
  await ctx.flush();
  assert.deepEqual(ctx.calls.map((call) => call[0]), ['capture', 'hide']);
});

test('the grid stays bounded on a huge panel and inside the window', async () => {
  const ctx = setup();
  ctx.rect = { left: -40, top: 0, right: 6000, bottom: 3000 };
  ctx.placement.request();
  ctx.frames.splice(0).forEach((frame) => frame(0));
  await settle();
  assert.ok(ctx.hits <= 14 * 14, `${ctx.hits} hit tests`);
  assert.ok(ctx.points.every(([x, y]) => x >= 0 && x <= 1400 && y >= 0 && y <= 900));
});

test('dispose hides the view and stops everything', async () => {
  const ctx = await placed();
  ctx.calls.length = 0;
  ctx.placement.request();
  ctx.placement.dispose();
  await settle();
  assert.deepEqual(ctx.calls, [['hide', { session_id: 's1' }]]);
  assert.deepEqual(ctx.listeners, []);
  assert.deepEqual(ctx.frames, []);
  ctx.placement.request();
  assert.deepEqual(ctx.frames, []);
});

test('typing costs no hit tests, and a key that can open something does', async () => {
  const ctx = await placed();
  const press = (init) => ctx.doc.dispatchEvent(new ctx.doc.defaultView.KeyboardEvent('keydown', init));
  ctx.hits = 0;
  for (const key of ['a', 'Z', '1', '/', 'Backspace', 'Shift', 'ArrowDown']) press({ key });
  await ctx.flush();
  assert.equal(ctx.hits, 0);
  for (const init of [{ key: 'Escape' }, { key: 'Enter' }, { key: 'F1' }, { key: 'k', ctrlKey: true }, { key: 'p', metaKey: true }, { key: 'f', altKey: true }]) {
    ctx.hits = 0;
    press(init);
    await ctx.flush();
    assert.ok(ctx.hits > 0, init.key);
  }
});
