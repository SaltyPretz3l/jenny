'use strict';

// new-test-file: a new surface (the diagram card kind of row 150 slice B8: its still picture from the sketch frame,
// Open live, and the by-hand source editor); the seam it plugs into is tested in renderer-board-card-kinds.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardEditor } = require('../renderer/features/board/board-editor');
const { createBoardCanvasView } = require('../renderer/features/board/board-canvas-view');
const interactions = require('../renderer/features/board/board-canvas-interactions');
const toolbar = require('../renderer/features/board/board-canvas-toolbar');
const cardEditing = require('../renderer/features/board/board-card-editing');
const cardKinds = require('../renderer/features/board/board-card-kinds');
const keyboard = require('../renderer/features/board/board-keyboard');
const diagram = require('../renderer/features/board/board-card-diagram');
const actionButton = require('../renderer/inventory/action-button');
const canvasSurface = require('../renderer/inventory/canvas-surface');
const boardCard = require('../renderer/inventory/board-card');
const connectorLayer = require('../renderer/inventory/connector-layer');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [NOTE, ONE, TWIN, OTHER] = [uid(901), uid(911), uid(912), uid(913)];
const SCENE_A = 'title One\na Alpha\nb Beta\na -> b';
const SCENE_B = 'title Two\nc Gamma\nd Delta\nc -> d';
const SCENE_C = 'title Three\ne Epsilon\nf Zeta\ne -> f';
const SVG = (scene) => `<svg xmlns="http://www.w3.org/2000/svg" data-secret-marker="${scene.length}-svg-body"></svg>`;
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const add = (id, kind, data, x) => ({ op: 'card.add', card: { id, kind, data, x, y: 100, w: 240, h: 160 } });
const BASE = () => [
  add(NOTE, 'note', { text: 'alpha', tone: null }, 40),
  add(ONE, 'diagram', { scene: SCENE_A, title: 'Flow' }, 300),
  add(TWIN, 'diagram', { scene: SCENE_A, title: '' }, 600),
  add(OTHER, 'diagram', { scene: SCENE_B, title: 'Second' }, 900),
];

/** A stand-in for the sketch frame host: records what it was asked to draw and lets the test play the frame. */
function fakeSketchHost(window) {
  const doc = window.document;
  const listen = window.addEventListener.bind(window); // the host's own listener is not the card's, so the test's count skips it
  const host = {
    requests: [], posts: [], resets: 0, drawnListeners: new Set(), unavailable: false, serial: 0, listening: false,
    onDrawn(listener) { host.drawnListeners.add(listener); return () => host.drawnListeners.delete(listener); },
    readPalette: (d) => ({ theme: d.documentElement.getAttribute('data-theme') || 'light' }),
    renderBlock(block) {
      const code = block.querySelector('pre > code.language-sketch');
      const paper = doc.createElement('div');
      const iframe = doc.createElement('iframe');
      paper.appendChild(iframe);
      block.insertBefore(paper, block.firstChild);
      block.setAttribute('data-sketch-rendered', 'pending');
      host.serial += 1;
      host.requests.push({ scene: code.textContent, block, requestId: `req-${host.serial}`, source: iframe.contentWindow, answered: false });
      if (!host.listening) {
        host.listening = true;
        listen('message', (event) => {
          const data = event.data || {};
          if (data.type !== 'rendered') return;
          const request = host.requests.find((entry) => entry.requestId === data.requestId);
          if (!request) return;
          request.block.setAttribute('data-sketch-rendered', data.ok === true ? 'true' : 'failed');
          if (data.ok === true) host.drawnListeners.forEach((listener) => listener({ block: request.block }));
        });
      }
    },
    resetBlock(block) {
      host.resets += 1;
      block.querySelectorAll(':scope > div').forEach((node) => node.remove());
      block.removeAttribute('data-sketch-rendered');
    },
    post(block, message) {
      host.posts.push(message);
      return block.getAttribute('data-sketch-rendered') === 'true';
    },
    current() { return host.requests.filter((request) => !request.answered).pop() || null; },
    say(request, data) { window.dispatchEvent(new window.MessageEvent('message', { data, source: request.source })); },
    rendered(request, ok = true) {
      host.say(request, ok ? { type: 'rendered', requestId: request.requestId, ok: true, height: 100, width: 200 } : { type: 'rendered', requestId: request.requestId, ok: false, reason: 'invalid', problems: [] });
    },
    exported(request, text, extra) {
      request.answered = true;
      host.say(request, { type: 'export', requestId: request.requestId, kind: 'svg', ok: true, name: 'sketch', text, ...extra });
    },
  };
  return host;
}

/** Plays a whole drawing: the frame says `rendered`, then answers the export with an SVG for the scene. */
async function finish(h, request = h.sketch.current()) {
  assert.ok(request, 'something is waiting to be drawn');
  h.sketch.rendered(request);
  h.sketch.exported(request, SVG(request.scene));
  await flush();
}

async function env(t, { ops = BASE(), readOnly = false, withHost = true, openLarge } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const docListeners = new Set();
  const winListeners = new Set();
  const track = (target, set) => {
    const realAdd = target.addEventListener.bind(target);
    const realRemove = target.removeEventListener.bind(target);
    target.addEventListener = (type, fn, capture) => { set.add(`${type}:${String(fn)}`); return realAdd(type, fn, capture); };
    target.removeEventListener = (type, fn, capture) => { set.delete(`${type}:${String(fn)}`); return realRemove(type, fn, capture); };
  };
  track(doc, docListeners);
  let tick = Date.parse('2026-11-13T10:00:00.000Z');
  let ids = 5000;
  let mine = 0;
  const source = createMemoryBoardSource({ model, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(ids++) });
  const created = (await source.create({ projectId: 'project_alpha', name: 'Plan' })).board;
  const seeded = await source.apply({ boardId: created.id, batch: { batch_id: 'seed1', board_id: created.id, actor: 'owner', ops } });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  const sent = [];
  const realApply = source.apply;
  source.apply = (request) => { sent.push(request); return realApply(request); };
  const notices = [];
  const logs = [];
  const editor = createBoardEditor({ model, source, notify: () => {}, log: () => {}, makeId: () => uid(++mine), now: () => '2026-11-13T12:00:00.000Z' });
  const sketch = fakeSketchHost(window);
  const timers = { next: 1, live: new Map(), set(fn, ms) { const id = timers.next++; timers.live.set(id, { fn, ms }); return id; }, clear(id) { timers.live.delete(id); }, fireAll() { Array.from(timers.live.values()).forEach((entry) => entry.fn()); } };
  const urls = { next: 1, made: [], revoked: [], make(text) { const url = `blob:fake/${urls.next++}`; urls.made.push({ url, text }); return url; }, revoke(url) { urls.revoked.push(url); }, live: () => urls.made.filter((entry) => !urls.revoked.includes(entry.url)).map((entry) => entry.url) };
  const opened = [];
  const loads = { count: 0 };
  const factories = new Map([['diagram', (ctx) => diagram.createDiagramPart(ctx, {
    loadHost: async () => { loads.count += 1; return withHost ? sketch : null; },
    setTimer: (fn, ms) => timers.set(fn, ms), clearTimer: (id) => timers.clear(id),
    makeUrl: urls.make, revokeUrl: urls.revoke,
    getOpen: () => (openLarge === null ? null : { openLarge: (options) => { opened.push(options); return openLarge ? openLarge(options) : true; } }),
  })]]);
  const canvas = createBoardCanvasView({ document: doc, actionButton, canvasSurface, boardCard, connectorLayer });
  doc.body.appendChild(canvas.element);
  canvas.surface.element.getBoundingClientRect = () => ({ left: 0, top: 0, x: 0, y: 0, width: 800, height: 600, right: 800, bottom: 600 });
  canvas.setEditor(editor, {
    source, notify: (message, extra) => notices.push({ message, ...extra }), log: (level, event, data) => logs.push({ level, event, ...data }),
    context: { state: {}, getProjectId: () => 'project_alpha' },
    modules: { interactions, toolbar, cardEditing, cardKinds: { createBoardCardKinds: (ctx) => cardKinds.createBoardCardKinds({ ...ctx, factories }) } },
  });
  canvas.show(seeded.board, { canUndo: true, canRedo: false, readOnly });
  track(window, winListeners);
  const keys = keyboard.createBoardKeyboard({ editor, view: { focusItem: canvas.focusItem, startEdit: canvas.startEdit, zoomBy: canvas.zoomBy, fit: canvas.fit, actualSize: canvas.actualSize }, platform: 'Win32' });
  keys.attach(canvas.element);
  t.after(() => { keys.dispose(); canvas.dispose(); window.close(); });
  await flush();
  const h = {
    window, doc, source, sent, editor, canvas, sketch, timers, urls, opened, notices, logs, loads, docListeners, winListeners, id: created.id,
    el: (id) => doc.querySelector(`[data-card-id="${id}"]`),
    media: (id) => doc.querySelector(`[data-card-id="${id}"] [data-card-media]`),
    picture: (id) => doc.querySelector(`[data-card-id="${id}"] [data-card-media] > img`),
    note: (id) => (doc.querySelector(`[data-card-id="${id}"] .board-diagram__note`) || { textContent: '' }).textContent,
    server: async () => (await source.get({ boardId: created.id })).board,
    key(target, init) { target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); },
    async dbl(target) { target.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); await flush(); },
  };
  return h;
}

test('a diagram card gets a picture from the frame\'s svg answer, shown as an image from a blob URL and nowhere in the markup', async (t) => {
  const h = await env(t);
  assert.equal(h.note(ONE), 'Drawing…', 'a quiet line until the picture is ready');
  assert.equal(h.sketch.requests.length, 1);
  assert.equal(h.sketch.requests[0].scene, SCENE_A);
  assert.deepEqual(h.sketch.current().block.parentElement.getAttribute('aria-hidden'), 'true', 'the block is off-screen and hidden from assistive technology');
  await finish(h);
  const img = h.picture(ONE);
  assert.ok(img, 'the card has an image');
  assert.equal(img.getAttribute('src'), 'blob:fake/1');
  assert.equal(img.getAttribute('alt'), 'Flow');
  assert.equal(h.picture(TWIN).getAttribute('alt'), 'Diagram', 'an untitled card says Diagram');
  assert.equal(h.urls.made[0].text, SVG(SCENE_A));
  assert.ok(!h.doc.documentElement.outerHTML.includes('data-secret-marker'), 'the SVG text is in no markup');
  assert.deepEqual(h.sketch.posts, [{ type: 'export', kind: 'svg' }]);
});

test('the same scene on two cards is one draw, a third scene waits its turn, a changed scene is drawn again, and the old picture goes when nothing shows it', async (t) => {
  const h = await env(t);
  assert.equal(h.sketch.requests.length, 1, 'one scene at a time');
  assert.equal(h.note(OTHER), 'Drawing…');
  await finish(h);
  assert.equal(h.picture(ONE).getAttribute('src'), h.picture(TWIN).getAttribute('src'), 'two cards, one picture');
  assert.equal(h.sketch.requests.length, 2, 'the waiting scene starts when the first is done');
  assert.equal(h.sketch.requests[1].scene, SCENE_B);
  await finish(h);
  assert.equal(h.urls.made.length, 2);

  await h.editor.editCard(ONE, { scene: SCENE_C });
  await flush();
  assert.equal(h.note(ONE), 'Drawing…');
  assert.equal(h.sketch.requests.length, 3);
  await finish(h);
  assert.equal(h.picture(ONE).getAttribute('src'), 'blob:fake/3');
  assert.deepEqual(h.urls.revoked, [], 'the old picture is still shown by the other card');
  await h.editor.editCard(TWIN, { scene: SCENE_C });
  await flush();
  assert.equal(h.sketch.requests.length, 3, 'a scene already drawn costs nothing');
  assert.equal(h.picture(TWIN).getAttribute('src'), 'blob:fake/3');
  assert.deepEqual(h.urls.revoked, ['blob:fake/1'], 'revoked once nothing shows it');
});

test('a card released or changed while it waits is dropped from the queue; a draw nobody wants any more is given up', async (t) => {
  const h = await env(t);
  assert.equal(h.sketch.requests.length, 1);
  h.editor.select([OTHER]);
  await h.editor.removeSelected();
  await flush();
  await finish(h);
  assert.equal(h.sketch.requests.length, 1, 'the removed card\'s scene was never drawn');

  const g = await env(t);
  await g.editor.editCard(OTHER, { scene: SCENE_C });
  await g.editor.editCard(ONE, { scene: SCENE_C });
  await g.editor.editCard(TWIN, { scene: SCENE_C });
  await flush();
  assert.equal(g.sketch.requests[0].scene, SCENE_A, 'it began before the edits');
  assert.equal(g.sketch.requests.length, 2, 'the draw nobody wanted any more was given up and the new scene took its place');
  assert.equal(g.sketch.requests[1].scene, SCENE_C);
  await finish(g);
  assert.ok(g.picture(ONE) && g.picture(TWIN) && g.picture(OTHER));
  assert.equal(g.sketch.requests.length, 2, 'three cards, one scene, one draw');
});

test('a scene the frame refuses says so, keeps its source editable and lets the queue move on', async (t) => {
  const h = await env(t);
  h.sketch.rendered(h.sketch.current(), false);
  await flush();
  assert.equal(h.note(ONE), 'This drawing has a problem');
  assert.equal(h.note(TWIN), 'This drawing has a problem');
  assert.ok(h.el(ONE).querySelector('[data-board-diagram-edit]'), 'the source can still be edited');
  assert.equal(h.sketch.requests.length, 2, 'the next scene started');
  assert.equal(h.winListeners.size, 1, 'one listener, for the scene being drawn');
  await finish(h);
  assert.ok(h.picture(OTHER));
  assert.equal(h.winListeners.size, 0);
});

test('no answer in ten seconds says "Could not draw this" and the queue moves on', async (t) => {
  const h = await env(t);
  assert.deepEqual(Array.from(h.timers.live.values()).map((entry) => entry.ms), [10000]);
  h.sketch.rendered(h.sketch.current());
  h.timers.fireAll();
  await flush();
  assert.equal(h.note(ONE), 'Could not draw this');
  assert.equal(h.sketch.requests.length, 2);
  await finish(h);
  assert.ok(h.picture(OTHER));
  assert.equal(h.winListeners.size, 0);
});

test('answers that do not match the pending request are ignored: another frame, another request id, another kind', async (t) => {
  const h = await env(t);
  const request = h.sketch.current();
  h.sketch.say(request, { type: 'export', requestId: request.requestId, kind: 'svg', ok: true, text: SVG('early') });
  h.window.dispatchEvent(new h.window.MessageEvent('message', { data: { type: 'rendered', requestId: 'forged', ok: true }, source: null }));
  h.sketch.rendered(request);
  h.sketch.say(request, { type: 'export', requestId: 'someone-else', kind: 'svg', ok: true, text: SVG('wrong id') });
  h.sketch.say(request, { type: 'export', requestId: request.requestId, kind: 'png', ok: true, base64: 'AAAA' });
  h.window.dispatchEvent(new h.window.MessageEvent('message', { data: { type: 'export', requestId: request.requestId, kind: 'svg', ok: true, text: SVG('stranger') }, source: h.window }));
  await flush();
  assert.equal(h.urls.made.length, 0, 'nothing was taken');
  assert.equal(h.note(ONE), 'Drawing…');
  h.sketch.exported(request, SVG(SCENE_A));
  await flush();
  assert.equal(h.urls.made.length, 1);
  assert.equal(h.urls.made[0].text, SVG(SCENE_A));
});

test('an answer over 2 MB and an export that fails are failures, not pictures', async (t) => {
  const h = await env(t);
  const request = h.sketch.current();
  h.sketch.rendered(request);
  h.sketch.exported(request, 'x'.repeat(2 * 1024 * 1024 + 1));
  await flush();
  assert.equal(h.note(ONE), 'Could not draw this');
  assert.equal(h.urls.made.length, 0, 'no URL was made for it');
  assert.equal(h.sketch.requests.length, 2, 'the queue works');
  const next = h.sketch.current();
  h.sketch.rendered(next);
  h.sketch.say(next, { type: 'export', requestId: next.requestId, kind: 'svg', ok: false });
  await flush();
  assert.equal(h.note(OTHER), 'Could not draw this');
});

test('a sketch host that cannot be loaded gives every diagram card the same line and throws nothing', async (t) => {
  const h = await env(t, { withHost: false });
  assert.equal(h.note(ONE), 'Drawings are not available');
  assert.equal(h.note(TWIN), 'Drawings are not available');
  assert.equal(h.note(OTHER), 'Drawings are not available');
  assert.equal(h.sketch.requests.length, 0);
  assert.equal(h.doc.querySelector('.board-diagram-offscreen'), null, 'no block was made');
  assert.equal(h.timers.live.size, 0, 'no timer is left running');
  assert.ok(h.el(ONE).querySelector('[data-board-diagram-edit]'), 'the source stays editable');
});

test('an empty scene says so and asks the frame for nothing', async (t) => {
  const h = await env(t, { ops: [add(ONE, 'diagram', { scene: '', title: '' }, 300)] });
  assert.equal(h.note(ONE), 'Empty diagram');
  assert.equal(h.sketch.requests.length, 0);
});

test('a theme change drops the cache and draws the cards on screen again with the new palette', async (t) => {
  const h = await env(t);
  await finish(h);
  await finish(h);
  const before = h.picture(ONE).getAttribute('src');
  assert.equal(h.sketch.requests.length, 2);
  h.doc.documentElement.setAttribute('data-theme', 'dark');
  await flush();
  assert.equal(h.sketch.requests.length, 3, 'drawn again');
  assert.equal(h.picture(ONE).getAttribute('src'), before, 'the old picture stays until the new one is ready');
  await finish(h);
  await finish(h);
  assert.equal(h.sketch.requests.length, 4);
  assert.notEqual(h.picture(ONE).getAttribute('src'), before);
  assert.notEqual(h.picture(OTHER).getAttribute('src'), h.picture(ONE).getAttribute('src'));
  assert.equal(h.urls.live().length, 2, 'the old pictures were revoked once the new ones were shown');
  h.doc.documentElement.setAttribute('lang', 'en');
  await flush();
  assert.equal(h.sketch.requests.length, 4, 'a change that is not the palette draws nothing');
});

test('Enter and a double-click open the drawing live, on a read-only board too; the outline sends no card to return to', async (t) => {
  const h = await env(t);
  await h.dbl(h.el(ONE));
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].source, SCENE_A);
  assert.equal(h.opened[0].title, 'Flow');
  assert.equal(h.opened[0].returnFocus, h.el(ONE));
  h.editor.select([OTHER]);
  h.key(h.el(OTHER), { key: 'Enter' });
  await flush();
  assert.deepEqual([h.opened[1].source, h.opened[1].title], [SCENE_B, 'Second']);
  assert.equal(h.canvas.activate(ONE, 'outline'), true);
  assert.equal(h.opened[2].returnFocus, null);
  assert.equal(h.doc.querySelector('[data-board-editor]'), null, 'opening it live starts no editor');

  const ro = await env(t, { readOnly: true });
  await ro.dbl(ro.el(TWIN));
  assert.equal(ro.opened.length, 1);
  assert.equal(ro.opened[0].source, SCENE_A);
  assert.equal(ro.el(ONE).querySelector('[data-board-diagram-edit]'), null, 'no Edit source on a board that cannot be changed');
});

test('when the viewer is not there the person is told, and the double-click is still handled', async (t) => {
  const h = await env(t, { openLarge: null });
  await h.dbl(h.el(ONE));
  await flush();
  assert.deepEqual(h.notices.map((notice) => notice.message), ['The live drawing is not available right now.']);
  const refused = await env(t, { openLarge: () => false });
  await refused.dbl(refused.el(ONE));
  assert.equal(refused.notices.length, 1);
  assert.equal(refused.doc.querySelector('[data-board-editor]'), null);
});

const editButton = (h, id) => h.el(id).querySelector('[data-board-diagram-edit]');
const editorOf = (h) => h.doc.querySelector('[data-board-editor]');
const fieldOf = (h, name) => h.doc.querySelector(`[data-board-editor] [data-board-field="${name}"]`);
const type = (field, value) => { field.value = value; field.dispatchEvent(new field.ownerDocument.defaultView.Event('input', { bubbles: true })); };
const editedOps = (h) => h.sent.flatMap((request) => request.batch.ops).filter((op) => op.op === 'card.edit');

test('"Edit source" opens the source by hand; a press on the button neither selects nor drags the card', async (t) => {
  const h = await env(t);
  const button = editButton(h, ONE);
  assert.ok(button, 'offered while the board can be edited');
  assert.equal(button.textContent.trim(), 'Edit source');
  assert.ok(button.title, 'it has a tooltip');
  button.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 }));
  assert.deepEqual(h.editor.getSelection(), [], 'the press did not reach the canvas');
  button.click();
  assert.ok(editorOf(h));
  assert.equal(fieldOf(h, 'scene').value, SCENE_A);
  assert.equal(fieldOf(h, 'title').value, 'Flow');
  assert.equal(fieldOf(h, 'scene').getAttribute('spellcheck'), 'false');
  assert.equal(fieldOf(h, 'scene').maxLength, 16384);
  assert.equal(h.doc.activeElement, fieldOf(h, 'scene'));
  assert.equal(editorOf(h).querySelector('[role="status"]').hidden, true);
  assert.equal(h.el(ONE).contains(editorOf(h)), true, 'the editor lies on the card');
});

test('Ctrl+Enter saves only what changed through the editor and returns focus to the card; Esc changes nothing', async (t) => {
  const h = await env(t);
  editButton(h, ONE).click();
  type(fieldOf(h, 'scene'), `${SCENE_A}\nc Gamma`);
  h.key(fieldOf(h, 'scene'), { key: 'Enter', ctrlKey: true });
  await flush();
  assert.equal(editorOf(h), null, 'closed after a save');
  assert.equal(h.doc.activeElement, h.el(ONE));
  assert.deepEqual(editedOps(h).map((op) => op.data), [{ scene: `${SCENE_A}\nc Gamma` }], 'the title was not sent');
  assert.equal((await h.server()).cards[ONE].data.scene, `${SCENE_A}\nc Gamma`);
  assert.equal((await h.server()).cards[ONE].data.title, 'Flow');

  editButton(h, ONE).click();
  type(fieldOf(h, 'title'), 'Renamed');
  h.key(fieldOf(h, 'title'), { key: 'Enter' });
  await flush();
  assert.deepEqual(editedOps(h).map((op) => op.data).pop(), { title: 'Renamed' }, 'Enter in the title line saves too');
  assert.equal(h.el(ONE).querySelector('[data-card-title]').textContent, 'Renamed');

  const sentBefore = editedOps(h).length;
  editButton(h, ONE).click();
  type(fieldOf(h, 'scene'), 'x X');
  type(fieldOf(h, 'title'), 'Never saved');
  h.key(fieldOf(h, 'scene'), { key: 'Escape' });
  await flush();
  assert.equal(editorOf(h), null);
  assert.equal(h.doc.activeElement, h.el(ONE));
  assert.equal(editedOps(h).length, sentBefore, 'nothing was sent');
  assert.equal((await h.server()).cards[ONE].data.title, 'Renamed');

  editButton(h, ONE).click();
  h.key(fieldOf(h, 'scene'), { key: 'Enter', ctrlKey: true });
  await flush();
  assert.equal(editorOf(h), null, 'an unchanged source just closes');
  assert.equal(editedOps(h).length, sentBefore);
});

test('moving focus out of the editor saves it; focus inside it does not', async (t) => {
  const h = await env(t);
  editButton(h, ONE).click();
  type(fieldOf(h, 'scene'), `${SCENE_A}\nc Gamma`);
  fieldOf(h, 'scene').dispatchEvent(new h.window.FocusEvent('focusout', { bubbles: true, relatedTarget: fieldOf(h, 'title') }));
  await flush();
  assert.ok(editorOf(h), 'still open: focus moved inside it');
  fieldOf(h, 'scene').dispatchEvent(new h.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  await flush();
  assert.equal(editorOf(h), null);
  assert.equal((await h.server()).cards[ONE].data.scene, `${SCENE_A}\nc Gamma`);
});

test('opening a second editor saves the first', async (t) => {
  const h = await env(t);
  editButton(h, ONE).click();
  type(fieldOf(h, 'scene'), 'p P\nq Q\np -> q');
  editButton(h, OTHER).click();
  await flush();
  assert.equal((await h.server()).cards[ONE].data.scene, 'p P\nq Q\np -> q');
  assert.equal(h.doc.querySelectorAll('[data-board-editor]').length, 1);
  assert.equal(h.doc.querySelector('[data-board-editor]').getAttribute('data-editing'), OTHER);
});

test('a scene over a limit keeps the editor open and names the limit; a refused title says why', async (t) => {
  const h = await env(t);
  editButton(h, ONE).click();
  const status = () => editorOf(h).querySelector('[role="status"]');
  const save = async () => { h.key(fieldOf(h, 'scene'), { key: 'Enter', ctrlKey: true }); await flush(); };
  type(fieldOf(h, 'scene'), `a A${'\n#'.repeat(400)}`);
  await save();
  assert.ok(editorOf(h), 'kept open');
  assert.equal(status().hidden, false);
  assert.equal(status().textContent, 'This drawing has too many lines: at most 400.');
  assert.equal(fieldOf(h, 'scene').value.startsWith('a A'), true, 'what was typed is kept');
  type(fieldOf(h, 'scene'), `a A${'#'.repeat(16384)}`);
  await save();
  assert.equal(status().textContent, 'This drawing is too long: it can hold at most 16,384 characters.');
  type(fieldOf(h, 'scene'), Array.from({ length: 121 }, (_, i) => `n${i} N${i}`).join('\n'));
  await save();
  assert.equal(status().textContent, 'This drawing has too many shapes: at most 120.');
  type(fieldOf(h, 'scene'), SCENE_A);
  assert.equal(status().hidden, true, 'typing clears the reason');
  type(fieldOf(h, 'title'), 'T'.repeat(201));
  await save();
  assert.equal(status().textContent, 'A title is one line of up to 200 characters.', 'the editor\'s own sentence');
  assert.equal((await h.server()).cards[ONE].data.title, 'Flow', 'nothing was saved');
});

test('keys typed in the editor stay in the editor: Delete does not remove the card, and the canvas does not zoom or pan', async (t) => {
  const h = await env(t);
  h.editor.select([ONE]);
  editButton(h, ONE).click();
  const reached = [];
  h.canvas.element.addEventListener('keydown', (event) => reached.push(event.key));
  h.canvas.element.addEventListener('wheel', () => reached.push('wheel'));
  h.canvas.element.addEventListener('pointerdown', () => reached.push('pointerdown'));
  h.canvas.element.addEventListener('dblclick', () => reached.push('dblclick'));
  for (const key of ['Delete', 'Backspace', 'a', '+', '0']) h.key(fieldOf(h, 'scene'), { key });
  fieldOf(h, 'scene').dispatchEvent(new h.window.WheelEvent('wheel', { bubbles: true, deltaY: 10 }));
  fieldOf(h, 'scene').dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  await h.dbl(fieldOf(h, 'scene'));
  await flush();
  assert.deepEqual(reached, [], 'nothing left the editor');
  assert.ok(h.el(ONE), 'the card is still there');
  assert.equal(h.opened.length, 0, 'a double-click in the editor does not open the viewer');
  assert.equal((await h.server()).cards[ONE].kind, 'diagram');
});

test('the toolbar tool adds a diagram card with a starter scene and opens its editor', async (t) => {
  const h = await env(t);
  const tool = h.doc.querySelector('[data-board-tool="kind-diagram"]');
  assert.equal(tool.textContent.trim(), 'Diagram');
  assert.equal(tool.title, 'Add a diagram');
  assert.equal(h.doc.querySelector('[data-board-tool="link"]').nextElementSibling, tool);
  tool.click();
  await flush();
  const board = await h.server();
  const made = Object.values(board.cards).filter((card) => card.kind === 'diagram' && ![ONE, TWIN, OTHER].includes(card.id));
  assert.equal(made.length, 1);
  assert.equal(made[0].data.scene, diagram.STARTER_SCENE);
  assert.equal(made[0].data.scene.split('\n').length, 3, 'three lines');
  assert.deepEqual(h.editor.getSelection(), [made[0].id], 'selected');
  assert.equal(editorOf(h).getAttribute('data-editing'), made[0].id, 'its editor is open');
  assert.equal(fieldOf(h, 'scene').value, diagram.STARTER_SCENE);
  assert.equal(h.doc.activeElement, fieldOf(h, 'scene'));
  while (h.sketch.current()) await finish(h);
  assert.ok(h.sketch.requests.some((request) => request.scene === diagram.STARTER_SCENE), 'the starter scene is drawn like any other');
  assert.ok(h.picture(made[0].id), 'and the new card shows its picture');
});

test('release revokes the picture of a card that left; dispose revokes every URL, removes the block and leaves no listener', async (t) => {
  const h = await env(t);
  await finish(h);
  await finish(h);
  assert.equal(h.urls.live().length, 2);
  assert.ok(h.doc.querySelector('.board-diagram-offscreen'), 'the block is in the page, unseen');
  assert.deepEqual([h.doc.querySelector('.board-diagram-offscreen').style.opacity, h.doc.querySelector('.board-diagram-offscreen').style.height], ['0', '1px']);
  h.editor.select([OTHER]);
  await h.editor.removeSelected();
  await flush();
  assert.equal(h.urls.live().length, 1, 'the removed card\'s picture was revoked');
  editButton(h, ONE).click();
  assert.ok(editorOf(h));
  h.canvas.dispose();
  assert.deepEqual(h.urls.live(), [], 'every URL was revoked');
  assert.equal(h.doc.querySelector('.board-diagram-offscreen'), null, 'the block is gone');
  assert.equal(editorOf(h), null);
  assert.deepEqual([...h.docListeners], [], 'no document listener is left');
  assert.deepEqual([...h.winListeners], [], 'no window listener is left');
  assert.equal(h.timers.live.size, 0);
  const requests = h.sketch.requests.length;
  h.doc.documentElement.setAttribute('data-theme', 'dark');
  await flush();
  assert.equal(h.sketch.requests.length, requests, 'a theme change after dispose draws nothing');
});
const breakButton = (h, id) => h.doc.querySelector(`[data-card-id="${id}"] [data-board-diagram-break]`);
const OUTLINE = { nodes: [{ id: 'a', label: 'Alpha', group: '' }, { id: 'b', label: 'Beta', group: '' }], groups: [], edges: [{ from: 'a', to: 'b', label: '', dashed: false }] };
async function outlineAnswer(h, data) {
  const request = h.sketch.current();
  request.answered = true;
  h.sketch.rendered(request);
  h.sketch.say(request, { type: 'outline', requestId: request.requestId, ...data });
  await flush();
}
test('"Break apart" turns the drawing into notes and an arrow in one batch, selects the notes, and one Undo brings the card back', async (t) => {
  const h = await env(t);
  h.sketch.getPositions = () => ({ direction: 'right', positions: { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } } });
  while (h.sketch.current()) await finish(h);
  const button = breakButton(h, ONE);
  assert.deepEqual([button.textContent.trim(), button.title, button.disabled], ['Break apart', 'Turn this drawing into separate notes and arrows', false]);
  const before = h.sent.length;
  button.click();
  await flush();
  assert.deepEqual([button.disabled, button.textContent.trim(), h.sketch.current().scene], [true, 'Breaking apart…', SCENE_A], 'busy while it works');
  await outlineAnswer(h, { ok: true, ...OUTLINE });
  assert.equal(h.sent.length, before + 1, 'one batch');
  const board = await h.server();
  const notes = Object.values(board.cards).filter((card) => card.kind === 'note' && ['Alpha', 'Beta'].includes(card.data.text));
  assert.deepEqual([board.cards[ONE], notes.length, Object.keys(board.connectors).length], [undefined, 2, 1]);
  assert.deepEqual(h.editor.getSelection().sort(), notes.map((card) => card.id).sort());
  assert.equal((await h.editor.undo()).ok, true);
  const back = Object.values((await h.server()).cards);
  assert.deepEqual([back.some((card) => card.id === ONE), back.some((card) => card.data.text === 'Alpha')], [true, false], 'the card is back and the parts are gone');
});

test('"Break apart" removes nothing when the drawing cannot be read, is too large, or has no host, and says why; a read-only board disables it', async (t) => {
  const h = await env(t);
  while (h.sketch.current()) await finish(h);
  const before = h.sent.length;
  const told = () => h.notices.at(-1).message;
  breakButton(h, ONE).click();
  await flush();
  h.sketch.rendered(h.sketch.current(), false);
  await flush();
  assert.deepEqual([told(), breakButton(h, ONE).disabled], ['This drawing could not be read, so it was not broken apart.', false], 'ready to try again');
  breakButton(h, ONE).click();
  await flush();
  const nodes = Array.from({ length: 120 }, (_, i) => ({ id: `n${i}`, label: 'x', group: '' }));
  await outlineAnswer(h, { ok: true, nodes, groups: [], edges: nodes.slice(1).map((n, i) => ({ from: `n${i}`, to: n.id, label: '', dashed: false })) });
  assert.equal(told(), 'This drawing is too large to break apart on this board.');
  assert.deepEqual([h.sent.length, Boolean((await h.server()).cards[ONE])], [before, true], 'nothing was sent');
  const none = await env(t, { withHost: false });
  breakButton(none, ONE).click();
  await flush();
  const locked = (await env(t, { readOnly: true })).doc;
  assert.deepEqual([none.notices.at(-1).message, locked.querySelector('[data-board-diagram-break]').disabled, locked.querySelector('[data-board-diagram-break]').title],
    ['Drawings are not available', true, 'This board cannot be changed.']);
});
