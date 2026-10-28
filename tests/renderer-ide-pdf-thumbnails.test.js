'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createPdfThumbnailRenderer } = require('../renderer/features/renderer-ide-pdf-thumbnails');

const flush = () => new Promise(resolve => setImmediate(resolve));

function cancelledError() {
  const error = new Error('Rendering cancelled, page 1');
  error.name = 'RenderingCancelledException';
  return error;
}

function createHarness(options = {}) {
  const renders = [];
  const getPageCalls = [];
  const canvases = [];
  const created = [];
  const revoked = [];
  const logs = [];
  const observers = [];
  const pdfDocument = {
    numPages: 20,
    async getPage(pageNumber) {
      getPageCalls.push(pageNumber);
      if (options.failGetPage === pageNumber) throw new Error('page unavailable');
      return {
        getViewport: ({ scale }) => ({ width: 200 * scale, height: 300 * scale }),
        render(params) {
          let resolve;
          let reject;
          const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
          const task = {
            promise,
            cancelled: false,
            cancel() { task.cancelled = true; reject(cancelledError()); },
          };
          renders.push({ page: pageNumber, params, task, resolve, reject });
          return task;
        },
      };
    },
  };
  const documentRef = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        encodedSize: null,
        getContext: () => ({}),
        toBlob(callback) {
          canvas.encodedSize = [canvas.width, canvas.height];
          setImmediate(() => callback({ type: 'image/png' }));
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  class FakeIntersectionObserver {
    constructor(callback, init) {
      this.callback = callback;
      this.init = init;
      this.targets = new Set();
      this.disconnected = false;
      observers.push(this);
    }
    observe(element) { this.targets.add(element); }
    unobserve(element) { this.targets.delete(element); }
    disconnect() { this.disconnected = true; this.targets.clear(); }
  }
  const thumbs = createPdfThumbnailRenderer({
    pdfDocument,
    documentRef,
    devicePixelRatio: 3,
    IntersectionObserver: FakeIntersectionObserver,
    createObjectURL: () => { const url = `blob:thumb-${created.length + 1}`; created.push(url); return url; },
    revokeObjectURL: url => revoked.push(url),
    log: (level, event, fields) => logs.push({ level, event, fields }),
    ...options.config,
  });
  const observer = observers[0];
  const intersect = (element, isIntersecting = true) => observer.callback([{ target: element, isIntersecting }]);
  // Completes the oldest unfinished render of a page and lets encode settle.
  const finish = async (pageNumber) => {
    const entry = renders.find(item => item.page === pageNumber && !item.done);
    entry.done = true;
    entry.resolve();
    await flush();
    await flush();
  };
  return { thumbs, renders, getPageCalls, canvases, created, revoked, logs, observer, intersect, finish };
}

test('observed slots render lazily on intersection with the pdf.js 6 canvas parameter', async () => {
  const h = createHarness({ config: { scrollRoot: 'rail' } });
  assert.equal(h.observer.init.root, 'rail');
  assert.match(h.observer.init.rootMargin, /200px/);
  const element = {};
  const ready = [];
  h.thumbs.observe(element, 4, value => ready.push(value));
  await flush();
  assert.deepEqual(h.getPageCalls, [], 'nothing renders before the slot is near the viewport');
  h.intersect(element);
  await flush();
  assert.equal(h.renders.length, 1);
  const { params } = h.renders[0];
  assert.equal(params.canvas, h.canvases[0]);
  assert.equal('canvasContext' in params, false);
  // 104 / 200 CSS scale at a device ratio capped to 2.
  assert.equal(params.viewport.width, 208);
  assert.deepEqual([h.canvases[0].width, h.canvases[0].height], [208, 312]);
  await h.finish(4);
  assert.deepEqual(ready, [{ url: 'blob:thumb-1', width: 104, height: 156 }]);
  h.intersect(element, false);
  h.intersect(element);
  assert.equal(ready.length, 1, 'a re-intersection with the same image does not re-notify');
  assert.equal(h.getPageCalls.length, 1);
});

test('requests for the same page share one promise and one render', async () => {
  const h = createHarness();
  const first = h.thumbs.render(3);
  assert.equal(h.thumbs.render(3), first);
  await flush();
  assert.deepEqual(h.getPageCalls, [3]);
  await h.finish(3);
  const result = await first;
  assert.equal(result.url, 'blob:thumb-1');
  assert.deepEqual(await h.thumbs.render(3), result);
  assert.deepEqual(h.getPageCalls, [3], 'a cache hit does not render again');
  assert.equal(await h.thumbs.render(0), null);
  assert.equal(await h.thumbs.render(21), null);
});

test('at most `concurrency` renders are in flight', async () => {
  const h = createHarness();
  for (let page = 1; page <= 5; page += 1) h.thumbs.render(page);
  await flush();
  assert.equal(h.renders.length, 2);
  await h.finish(h.renders[0].page);
  assert.equal(h.renders.length, 3);
  assert.equal(h.renders.filter(item => !item.done).length, 2);
});

test('the queue serves the most recently requested page first', async () => {
  const h = createHarness({ config: { concurrency: 1 } });
  h.thumbs.render(1);
  h.thumbs.render(2);
  h.thumbs.render(3);
  h.thumbs.render(4);
  h.thumbs.render(2);
  await flush();
  await h.finish(1);
  await h.finish(2);
  await h.finish(4);
  await h.finish(3);
  assert.deepEqual(h.getPageCalls, [1, 2, 4, 3]);
});

test('a queued slot that scrolls away before it starts is dropped', async () => {
  const h = createHarness({ config: { concurrency: 1 } });
  const first = {};
  const passed = {};
  h.thumbs.observe(first, 1, () => {});
  h.thumbs.observe(passed, 2, () => {});
  h.intersect(first);
  h.intersect(passed);
  h.intersect(passed, false);
  await flush();
  await h.finish(1);
  assert.deepEqual(h.getPageCalls, [1]);
});

test('LRU eviction revokes the oldest URL, clears its slot and re-renders on re-intersection', async () => {
  const h = createHarness({ config: { maxLive: 2 } });
  const elements = [{}, {}, {}];
  const ready = [[], [], []];
  elements.forEach((element, index) => h.thumbs.observe(element, index + 1, value => ready[index].push(value)));
  h.intersect(elements[0]);
  h.intersect(elements[1]);
  await flush();
  await h.finish(1);
  await h.finish(2);
  await h.thumbs.render(1); // touch page 1 so page 2 is now least recent
  h.intersect(elements[2]);
  await flush();
  await h.finish(3);
  assert.deepEqual(h.revoked, ['blob:thumb-2']);
  assert.deepEqual(ready[1], [{ url: 'blob:thumb-2', width: 104, height: 156 }, null]);
  assert.equal(ready[0].length, 1);
  h.intersect(elements[1], false);
  h.intersect(elements[1]);
  await flush();
  await h.finish(2);
  assert.equal(ready[1].at(-1).url, 'blob:thumb-4');
  assert.deepEqual(h.revoked, ['blob:thumb-2', 'blob:thumb-1']);
  assert.equal(ready[0].at(-1), null);
});

test('cancelPending cancels queued and in-flight renders to null without a warning and keeps cached images', async () => {
  const h = createHarness();
  h.thumbs.render(9);
  await flush();
  await h.finish(9);
  const pending = [1, 2, 3].map(page => h.thumbs.render(page));
  await flush();
  assert.equal(h.renders.filter(item => !item.done).length, 2);
  h.thumbs.cancelPending();
  assert.deepEqual(await Promise.all(pending), [null, null, null]);
  assert.equal(h.renders.filter(item => item.task.cancelled).length, 2);
  await flush();
  assert.deepEqual(h.logs, []);
  assert.deepEqual(h.created, ['blob:thumb-1']);
  assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.equal((await h.thumbs.render(9)).url, 'blob:thumb-1');
  h.thumbs.render(5);
  await flush();
  assert.equal(h.renders.at(-1).page, 5, 'the freed slots accept new work');
});

test('a render failure logs a warning and resolves null', async () => {
  const h = createHarness({ failGetPage: 7 });
  assert.equal(await h.thumbs.render(7), null);
  const broken = h.thumbs.render(8);
  await flush();
  h.renders[0].reject(new Error('bad stream'));
  assert.equal(await broken, null);
  assert.deepEqual(h.logs, [
    { level: 'warn', event: 'ide.pdf.thumbnail_failed', fields: { page: 7, message: 'page unavailable' } },
    { level: 'warn', event: 'ide.pdf.thumbnail_failed', fields: { page: 8, message: 'bad stream' } },
  ]);
  assert.ok(h.canvases.every(canvas => canvas.width === 0));
});

test('the canvas is released after the image is encoded', async () => {
  const h = createHarness();
  const result = h.thumbs.render(2);
  await flush();
  await h.finish(2);
  await result;
  assert.deepEqual(h.canvases[0].encodedSize, [208, 312]);
  assert.deepEqual([h.canvases[0].width, h.canvases[0].height], [0, 0]);
});

test('dispose revokes every URL, disconnects the observer and turns later calls into no-ops', async () => {
  const h = createHarness();
  h.thumbs.render(1);
  h.thumbs.render(2);
  await flush();
  await h.finish(1);
  await h.finish(2);
  const inFlight = h.thumbs.render(3);
  await flush();
  h.thumbs.dispose();
  assert.equal(await inFlight, null);
  assert.equal(h.renders.at(-1).task.cancelled, true);
  assert.deepEqual(h.revoked.sort(), ['blob:thumb-1', 'blob:thumb-2']);
  assert.equal(h.observer.disconnected, true);
  assert.equal(await h.thumbs.render(1), null);
  h.thumbs.observe({}, 1, () => assert.fail('disposed renderer must not notify'));
  assert.equal(h.observer.targets.size, 0);
  h.thumbs.unobserve({});
  h.thumbs.cancelPending();
  h.thumbs.dispose();
  await flush();
  assert.deepEqual(h.created, ['blob:thumb-1', 'blob:thumb-2']);
  assert.deepEqual(h.logs, []);
});
