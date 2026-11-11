'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildReaderCall } = require('../services/browser-use/page-reader-script');

const PAGE_HTML = `<body><button id="go">Add to cart</button><input id="name" aria-label="Name">
<select id="size" aria-label="Size"><option>S</option><option>L</option></select></body>`;
const RING_SELECTOR = 'html > div[aria-hidden="true"]';
const tick = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });

function makePage(html = PAGE_HTML) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.com/' });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 10, y: 40, left: 10, top: 40, right: 110, bottom: 60, width: 100, height: 20 };
  };
  window.document.elementFromPoint = () => null;
  const timers = [];
  window.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  window.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].fn = null; };
  const run = (op, args) => JSON.parse(JSON.stringify(window.eval(buildReaderCall(op, args))));
  const target = (pattern) => {
    const found = run('find', { query: pattern });
    assert.ok(found.total >= 1, `nothing matches ${pattern}`);
    const { ref } = found.matches[0];
    return { ref, fingerprint: run('probe', { ref }).fingerprint };
  };
  const rings = () => [...window.document.querySelectorAll(RING_SELECTOR)];
  const fireTimers = () => timers.splice(0).forEach((timer) => timer.fn?.());
  // For the ops that answer with a promise.
  const call = (op, args) => window.eval(buildReaderCall(op, args));
  return { window, doc: window.document, run, call, target, rings, timers, fireTimers };
}

function spyListeners(window) {
  const added = [];
  const real = window.addEventListener;
  window.addEventListener = function addEventListener(type, handler, capture) {
    // jsdom's selector engine adds its own, with an options object.
    if (capture === true) added.push({ type, handler, capture });
    return real.call(this, type, handler, capture);
  };
  return added;
}

test('a press counts only once a real one arrives, and each verify starts over', () => {
  const page = makePage();
  const added = spyListeners(page.window);
  const button = page.target('Add to cart');
  page.run('verify', { ...button, watchPress: true });
  assert.equal(page.run('pressSeen', {}).seen, false);
  page.window.dispatchEvent(new page.window.MouseEvent('mousedown'));
  assert.equal(page.run('pressSeen', {}).seen, false, 'a press made by a script does not count');
  added.find((entry) => entry.type === 'mousedown').handler({ isTrusted: true });
  assert.equal(page.run('pressSeen', {}).seen, true);
  page.run('verify', { ...button, watchPress: true });
  assert.equal(page.run('pressSeen', {}).seen, false);
  added.find((entry) => entry.type === 'pointerdown').handler({ isTrusted: true });
  assert.equal(page.run('pressSeen', {}).seen, true);
  assert.deepEqual(added.map(({ type, capture }) => [type, capture]), [['pointerdown', true], ['mousedown', true]]);
});

test('a new document has no press to wait for', () => {
  assert.equal(makePage().run('pressSeen', {}).seen, true);
});

test('a plain verify starts no watch', () => {
  const page = makePage();
  const added = spyListeners(page.window);
  page.run('verify', page.target('Add to cart'));
  assert.equal(page.run('pressSeen', {}).seen, true);
  assert.equal(added.length, 0);
});

test('a disabled control sees no press, so none is waited for', () => {
  const page = makePage('<body><button id="go" disabled>Add to cart</button></body>');
  const answer = page.run('verify', { ...page.target('Add to cart'), watchPress: true });
  assert.equal(answer.status, 'ready');
  assert.equal(page.run('pressSeen', {}).seen, true);
});

function withFrames(page) {
  const frames = [];
  page.window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  return frames;
}

test('a page paints only after two frames, and the cap stops counting', async () => {
  const page = makePage();
  const frames = withFrames(page);
  const running = page.call('paints', {});
  assert.equal(page.timers.at(-1).ms, 120);
  frames.shift()();
  assert.equal(frames.length, 1, 'one frame is not proof');
  frames.shift()();
  assert.deepEqual({ ...(await running) }, { status: 'ok', paints: true });
  assert.equal(page.timers.at(-1).fn, null, 'the cap is cleared');
});

test('a page with no frames does not paint', async () => {
  const page = makePage();
  withFrames(page);
  const running = page.call('paints', {});
  page.fireTimers();
  assert.equal((await running).paints, false);
});

test('a longer wait can be asked for, within a limit', () => {
  const page = makePage();
  withFrames(page);
  page.call('paints', { capMs: 500 });
  assert.equal(page.timers.at(-1).ms, 500);
  page.call('paints', { capMs: 99999 });
  assert.equal(page.timers.at(-1).ms, 1000);
});

test('a page with no frame callback at all does not paint', async () => {
  assert.equal((await makePage().call('paints', {})).paints, false);
});

test('the element about to be clicked gets one ring that cannot be clicked or read', () => {
  const page = makePage();
  const button = page.target('Add to cart');
  assert.equal(page.run('verify', button).status, 'ready');
  page.run('verify', button);
  const [ring, ...others] = page.rings();
  assert.ok(ring, 'the ring was drawn');
  assert.equal(others.length, 0);
  assert.equal(ring.style.position, 'fixed');
  assert.equal(ring.style.pointerEvents, 'none');
  assert.deepEqual([ring.style.left, ring.style.top, ring.style.width, ring.style.height], ['10px', '40px', '100px', '20px']);
  assert.ok(ring.style.outlineWidth === '2px' || /2px/.test(ring.style.outline));
  assert.equal(page.run('read', { scope: 'full' }).text.includes('aria-hidden'), false);
});

test('the ring removes itself after about 600 ms', () => {
  const page = makePage();
  page.run('verify', page.target('Add to cart'));
  assert.ok(page.timers.some((timer) => timer.ms >= 400 && timer.ms <= 800));
  page.fireTimers();
  assert.equal(page.rings().length, 0);
});

test('typing and choosing an option are marked too', () => {
  const page = makePage();
  assert.equal(page.run('focusForTyping', { ...page.target('Name'), clear: true }).status, 'ready');
  assert.equal(page.rings().length, 1);
  page.fireTimers();
  assert.equal(page.run('select', { ...page.target('Size'), value: 'L' }).status, 'selected');
  assert.equal(page.rings().length, 1);
});

test('nothing is marked when the action will not happen', () => {
  const page = makePage();
  const button = page.target('Add to cart');
  assert.equal(page.run('verify', { ref: button.ref, fingerprint: 'not-the-same' }).status, 'changed');
  assert.equal(page.run('select', { ...page.target('Size'), value: 'XXL' }).status, 'no_such_option');
  assert.equal(page.rings().length, 0);
});

test('a screenshot never includes the ring', () => {
  const page = makePage();
  page.run('verify', page.target('Add to cart'));
  assert.equal(page.run('secretMask', { on: true }).status, 'ok');
  assert.equal(page.rings().length, 0);
  page.fireTimers();
  page.run('secretMask', { on: false });
  assert.equal(page.rings().length, 0);
});

test('drawing and removing the ring does not make the page look busy', async () => {
  const page = makePage();
  page.run('status', {});
  const button = page.target('Add to cart');
  await tick(40);
  page.run('verify', button);
  await tick();
  assert.ok(page.run('status', {}).msSinceMutation >= 35, 'drawing the ring reset the quiet clock');
  page.fireTimers();
  await tick();
  assert.ok(page.run('status', {}).msSinceMutation >= 35, 'removing the ring reset the quiet clock');
});

test('a change the page made just before the ring still counts as page activity', async () => {
  const page = makePage();
  page.run('status', {});
  const button = page.target('Add to cart');
  await tick(40);
  page.doc.body.appendChild(page.doc.createElement('span'));
  page.run('verify', button);
  await tick();
  assert.ok(page.run('status', {}).msSinceMutation < 30);
});

test('a page that passes the focus on stops the typing, and focusIs says where the focus is', () => {
  const page = makePage('<body><input id="i" aria-label="Name"><input id="s" type="password" aria-label="Pass"></body>');
  const name = page.target('Name');
  const input = page.doc.getElementById('i');
  const secret = page.doc.getElementById('s');
  const steal = () => secret.focus();
  input.addEventListener('focus', steal);
  assert.equal(page.run('focusForTyping', { ...name, clear: true }).status, 'changed');
  assert.equal(page.doc.activeElement, secret);
  assert.equal(page.run('focusIs', { ref: name.ref }).status, 'changed');
  input.removeEventListener('focus', steal);
  secret.blur();
  assert.equal(page.run('focusForTyping', { ...name, clear: true }).status, 'ready');
  assert.equal(page.run('focusIs', { ref: name.ref }).status, 'ready');
  input.remove();
  assert.equal(page.run('focusIs', { ref: name.ref }).status, 'stale');
});
