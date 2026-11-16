'use strict';

// new-test-file: renderer/features/board/board-card-diagram-pictures.js is its own module (the queue and the cache of the
// diagram cards' still pictures, row 150 slice B8); renderer-board-card-diagram.test.js reaches it through the card and
// is near its line cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createDiagramPictures, MAX_PICTURES } = require('../renderer/features/board/board-card-diagram-pictures');

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function setup(t, { host = true, timers } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/' });
  const { window } = dom;
  const doc = window.document;
  const listen = window.addEventListener.bind(window);
  const sketch = {
    requests: [], posts: [], listeners: new Set(), serial: 0, listening: false,
    onDrawn(fn) { sketch.listeners.add(fn); return () => sketch.listeners.delete(fn); },
    readPalette: (d) => ({ theme: d.documentElement.getAttribute('data-theme') || 'light' }),
    renderBlock(block) {
      const paper = doc.createElement('div');
      paper.appendChild(doc.createElement('iframe'));
      block.insertBefore(paper, block.firstChild);
      block.setAttribute('data-sketch-rendered', 'pending');
      sketch.serial += 1;
      sketch.requests.push({ scene: block.querySelector('code').textContent, block, requestId: `r${sketch.serial}`, source: paper.firstChild.contentWindow, answered: false });
      if (!sketch.listening) {
        sketch.listening = true;
        listen('message', (event) => {
          const data = event.data || {};
          const request = data.type === 'rendered' ? sketch.requests.find((entry) => entry.requestId === data.requestId) : null;
          if (!request) return;
          request.block.setAttribute('data-sketch-rendered', 'true');
          sketch.listeners.forEach((fn) => fn({ block: request.block }));
        });
      }
    },
    resetBlock(block) { block.querySelectorAll(':scope > div').forEach((node) => node.remove()); block.removeAttribute('data-sketch-rendered'); },
    post(block, message) { sketch.posts.push(message); return block.getAttribute('data-sketch-rendered') === 'true'; },
    current: () => sketch.requests.filter((request) => !request.answered).pop() || null,
    async answer(request = sketch.current()) {
      request.answered = true;
      const say = (data) => window.dispatchEvent(new window.MessageEvent('message', { data, source: request.source }));
      say({ type: 'rendered', requestId: request.requestId, ok: true, height: 10, width: 10 });
      say({ type: 'export', requestId: request.requestId, kind: 'svg', ok: true, text: `<svg>${request.scene}</svg>` });
      await flush();
    },
    async drain() { await flush(); while (sketch.current()) await sketch.answer(); },
  };
  const urls = { next: 1, revoked: [], made: [] };
  let available = host;
  const pictures = createDiagramPictures({
    document: doc, windowRef: window,
    loadHost: async () => (available ? sketch : null),
    makeUrl: (text) => { const url = `blob:p/${urls.next++}`; urls.made.push({ url, text }); return url; },
    revokeUrl: (url) => urls.revoked.push(url),
    setTimer: timers && timers.set, clearTimer: timers && timers.clear,
  });
  t.after(() => { pictures.dispose(); window.close(); });
  return { window, doc, sketch, urls, pictures, setAvailable: (value) => { available = value; } };
}

test('the cache keeps at most 48 pictures; an evicted picture is revoked only once no card shows it', async (t) => {
  const h = setup(t);
  const shown = new Map();
  for (let i = 0; i < MAX_PICTURES + 2; i += 1) {
    const state = h.pictures.hold(`c${i}`, `scene ${i}`, (next) => shown.set(`c${i}`, next.url));
    assert.equal(state.status, 'drawing');
  }
  await h.sketch.drain();
  assert.equal(h.pictures.sizes().cached, MAX_PICTURES);
  assert.equal(shown.size, MAX_PICTURES + 2, 'every card got its picture');
  assert.deepEqual(h.urls.revoked, [], 'the two evicted pictures are still on screen, so nothing is revoked');
  h.pictures.release('c0');
  assert.deepEqual(h.urls.revoked, [shown.get('c0')], 'the evicted picture goes when its card lets go');
  h.pictures.release('c5');
  assert.deepEqual(h.urls.revoked, [shown.get('c0'), shown.get('c5')], 'a cached picture goes when nothing wants its scene');
  assert.equal(h.pictures.sizes().cached, MAX_PICTURES - 1);
  const again = h.pictures.hold('c0', 'scene 0', () => {});
  assert.equal(again.status, 'drawing', 'an evicted scene is drawn again');
  assert.equal(h.pictures.hold('c9', 'scene 9', () => {}).status, 'ready', 'a kept one costs nothing');
});

test('a host that was missing is asked again for the next card, and a scene a card shows twice is drawn once', async (t) => {
  const h = setup(t, { host: false });
  assert.equal(h.pictures.hold('a', 'one', () => {}).status, 'drawing');
  await flush();
  const states = [];
  h.pictures.release('a');
  h.setAvailable(true);
  h.pictures.hold('b', 'one', (state) => states.push(state.status));
  h.pictures.hold('c', 'one', (state) => states.push(state.status));
  await flush();
  assert.equal(h.sketch.requests.length, 1);
  await h.sketch.drain();
  assert.deepEqual(states, ['ready', 'ready']);
});

test('a theme change in the middle of a draw gives the draw up and draws the scene again', async (t) => {
  const h = setup(t);
  const seen = [];
  h.pictures.hold('a', 'one', (state) => seen.push(state.status));
  await flush();
  assert.equal(h.sketch.requests.length, 1);
  h.doc.documentElement.setAttribute('data-theme', 'dark');
  await flush();
  assert.equal(h.sketch.requests.length, 2, 'the first draw was given up');
  await h.sketch.answer(h.sketch.requests[0]);
  assert.deepEqual(seen, [], 'a late answer to the old draw is not taken');
  await h.sketch.answer(h.sketch.requests[1]);
  assert.deepEqual(seen, ['ready']);
});

test('with the real frame host: one frame draws the scene, its export answer becomes the picture, and the frame is given back', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null; // jsdom has no canvas and says so loudly
  const hostPath = require.resolve('../renderer/features/renderer-sketch-frame-host');
  delete require.cache[hostPath];
  const host = require(hostPath);
  const doc = dom.window.document;
  const made = [];
  const pictures = createDiagramPictures({ document: doc, windowRef: dom.window, loadHost: async () => host,
    makeUrl: (text) => { made.push(text); return 'blob:real/1'; }, revokeUrl: () => {} });
  t.after(() => { pictures.dispose(); host.dispose(); dom.window.close(); });
  const states = [];
  const scene = 'a Alpha\nb Beta\na -> b';
  pictures.hold('a', scene, (state) => states.push(state));
  await flush();
  const iframe = doc.querySelector('.board-diagram-offscreen iframe');
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  // The test plays the frame: jsdom gives a frame with an unknown scheme no window of its own.
  const posted = [];
  const frameWindow = { postMessage: (payload) => posted.push(payload) };
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: frameWindow });
  const say = (data) => {
    const event = new dom.window.Event('message');
    Object.defineProperty(event, 'source', { value: frameWindow });
    Object.defineProperty(event, 'data', { value: data });
    dom.window.dispatchEvent(event);
  };
  say({ type: 'sketch-frame-ready' });
  const request = posted.find((payload) => payload.type === 'render');
  assert.equal(request.source, scene);
  say({ type: 'export', requestId: request.requestId, kind: 'svg', ok: true, text: '<svg>early</svg>' });
  assert.deepEqual(made, [], 'an answer before the drawing is up is not taken');
  say({ type: 'rendered', requestId: request.requestId, ok: true, height: 200, width: 300, problems: [], positions: null });
  assert.deepEqual(posted.filter((payload) => payload.type === 'export'), [{ type: 'export', kind: 'svg', requestId: request.requestId }]);
  say({ type: 'export', requestId: 'sketch-forged', kind: 'svg', ok: true, text: '<svg>forged</svg>' });
  say({ type: 'export', requestId: request.requestId, kind: 'svg', ok: true, name: 'sketch', text: '<svg>real</svg>' });
  await flush();
  assert.deepEqual(made, ['<svg>real</svg>']);
  assert.deepEqual(states, [{ status: 'ready', url: 'blob:real/1' }]);
  assert.equal(doc.querySelector('.board-diagram-offscreen iframe'), null, 'the frame is given back once the picture is made');
  assert.equal(doc.querySelector('.board-diagram-offscreen [data-sketch-rendered]'), null);
});

test('with the sketch kill switch off a diagram card says so and nothing is loaded', async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>', { url: 'https://jenny.invalid/' });
  t.after(() => dom.window.close());
  const { createDiagramPart } = require('../renderer/features/board/board-card-diagram');
  let loads = 0;
  dom.window.rendererMermaidRuntimeLoader = { ensureSketchHost: async () => { loads += 1; return null; } };
  const slot = dom.window.document.getElementById('slot');
  const flags = { sketch_blocks: false };
  const part = createDiagramPart({ document: dom.window.document, windowRef: dom.window, boardCard: { media: () => slot },
    context: { state: { features: { featureFlags: flags } } } });
  t.after(() => part.dispose());
  part.decorate(slot, { id: 'c1', kind: 'diagram', data: { scene: 'a Alpha', title: '' } }, { editable: false });
  await flush();
  assert.equal(loads, 0);
  assert.equal(slot.textContent, 'Drawings are not available');
  flags.sketch_blocks = true;
  part.release('c1');
  part.decorate(slot, { id: 'c2', kind: 'diagram', data: { scene: 'b Beta', title: '' } }, { editable: false });
  await flush();
  assert.equal(loads, 1, 'with the switch on the loader is asked');
});

test('after dispose nothing is drawn, nothing is kept and every URL is revoked', async (t) => {
  const h = setup(t);
  h.pictures.hold('a', 'one', () => {});
  await h.sketch.drain();
  h.pictures.dispose();
  assert.deepEqual(h.urls.revoked, ['blob:p/1']);
  assert.equal(h.pictures.hold('b', 'two', () => {}).status, 'unavailable');
  assert.equal(await h.pictures.ensureHost(), null);
  assert.equal(h.doc.querySelector('.board-diagram-offscreen'), null);
  h.pictures.dispose();
});

/* ---------------------------------------------------------------- outline (row 150 slice B9) */

const OUTLINE = { nodes: [{ id: 'a', label: 'Alpha', group: '' }, { id: 'b', label: 'Beta', group: 'g' }], groups: [{ id: 'g', label: 'Core', parent: '' }], edges: [{ from: 'a', to: 'b', label: 'x', dashed: true }] };
const POSITIONS = { direction: 'right', positions: { a: { x: 0, y: 0 }, b: { x: 160, y: 20 }, ignored: { x: 'no', y: 1 } } };
const fakeTimers = () => { const t = { next: 1, live: new Map(), set(fn) { const id = t.next++; t.live.set(id, fn); return id; }, clear(id) { t.live.delete(id); } }; return t; };
/** Plays the frame for an outline request: it says `rendered`, then answers the outline message with `data`. */
async function answerOutline(h, request, data = { ok: true, ...OUTLINE }) {
  request.answered = true;
  const say = (payload) => h.window.dispatchEvent(new h.window.MessageEvent('message', { data: payload, source: request.source }));
  say({ type: 'rendered', requestId: request.requestId, ok: true, height: 10, width: 10 });
  say({ type: 'outline', requestId: request.requestId, ...data });
  await flush();
}

test('outline waits behind the picture being drawn, draws before pictures that wait, and returns the checked structure with the positions', async (t) => {
  const h = setup(t);
  h.sketch.getPositions = () => POSITIONS;
  h.pictures.hold('c1', 'one', () => {});
  await flush();
  const asked = h.pictures.outline('a Alpha\nb Beta');
  h.pictures.hold('c2', 'two', () => {});
  await flush();
  assert.equal(h.sketch.requests.length, 1, 'the outline waits its turn');
  await h.sketch.answer();
  assert.equal(h.sketch.requests.length, 2);
  assert.equal(h.sketch.requests[1].scene, 'a Alpha\nb Beta', 'before the picture that was queued after it');
  await answerOutline(h, h.sketch.requests[1]);
  assert.deepEqual(h.sketch.posts.at(-1), { type: 'outline' });
  const result = await asked;
  assert.deepEqual(result, { ok: true, ...OUTLINE, positions: { a: { x: 0, y: 0 }, b: { x: 160, y: 20 } } });
  await flush();
  assert.equal(h.sketch.requests.length, 3, 'then the waiting picture');
  assert.equal(h.sketch.requests[2].scene, 'two');
});

test('outline ignores an answer from another frame or request id, and checks what a frame says again', async (t) => {
  const h = setup(t);
  const asked = h.pictures.outline('a Alpha');
  await flush();
  const request = h.sketch.requests[0];
  const say = (data, source = request.source) => h.window.dispatchEvent(new h.window.MessageEvent('message', { data, source }));
  say({ type: 'rendered', requestId: request.requestId, ok: true });
  say({ type: 'outline', requestId: 'forged', ok: true, ...OUTLINE });
  say({ type: 'outline', requestId: request.requestId, ok: true, ...OUTLINE }, h.window);
  const hostile = { type: 'outline', requestId: request.requestId, ok: true, nodes: Array.from({ length: 121 }, (_, i) => ({ id: `n${i}`, label: 'x', group: '' })), groups: [], edges: [] };
  say(hostile);
  assert.deepEqual(await asked, { ok: false, reason: 'failed' }, 'over the caps is a failure');
  for (const bad of [{ nodes: [{ id: 5, label: 'x', group: '' }] }, { nodes: [{ id: 'a', label: 'x', group: '' }], edges: [{ from: 'a', to: 'a', label: 1, dashed: 'yes' }] }, { nodes: 'x' }]) {
    const next = h.pictures.outline('b Beta');
    await flush();
    await answerOutline(h, h.sketch.requests.at(-1), { ok: true, groups: [], edges: [], ...bad });
    assert.deepEqual(await next, { ok: false, reason: 'failed' });
  }
});

test('outline times out cleanly, the queue moves on, and a refused scene, a missing host and dispose each say why', async (t) => {
  const timers = fakeTimers();
  const h = setup(t, { timers });
  const slow = h.pictures.outline('a Alpha');
  const next = h.pictures.hold('c1', 'one', () => {});
  await flush();
  assert.equal(h.sketch.requests.length, 1);
  Array.from(timers.live.values()).forEach((fn) => fn());
  assert.deepEqual(await slow, { ok: false, reason: 'timeout' });
  await flush();
  assert.equal(next.status, 'drawing');
  assert.equal(h.sketch.requests.length, 2, 'the picture is drawn after the timeout');
  await h.sketch.drain();
  const realRender = h.sketch.renderBlock;
  h.sketch.renderBlock = (block) => { realRender(block); if (block.querySelector('code').textContent === 'bad') block.setAttribute('data-sketch-rendered', 'failed'); };
  assert.deepEqual(await h.pictures.outline('bad'), { ok: false, reason: 'problem' });
  assert.deepEqual(await setup(t, { host: false }).pictures.outline('x'), { ok: false, reason: 'unavailable' });
  const pending = h.pictures.outline('y');
  await flush();
  h.pictures.dispose();
  assert.deepEqual(await pending, { ok: false, reason: 'unavailable' });
  assert.deepEqual(await h.pictures.outline('z'), { ok: false, reason: 'unavailable' });
});
