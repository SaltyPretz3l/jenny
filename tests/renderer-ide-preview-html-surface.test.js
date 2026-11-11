'use strict';

/* Preview HTML surface (renderer-ide-preview-html-surface.js): builds the
 * linked-asset note and readers, and swaps frames only once the new page is
 * ready. Frame factory and assets module are injected fakes. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createPreviewHtmlSurface } = require('../renderer/features/renderer-ide-preview-html-surface');

const NOT_FOUND = 'CMP-WORKSPACEFS-0004';

function emptyResult(over) {
  return { html: '<p>built</p>', loaded: [], notLoaded: [], webLinks: 0, dependencies: [], ...over };
}

function makeSurface(opts = {}) {
  const dom = new JSDOM('<div id="body"></div>');
  const body = dom.window.document.getElementById('body');
  const frames = [];
  const captured = { options: null, calls: [] };
  const frameUtils = {
    createHtmlArtifactFrame(host, html, options) {
      const frame = { host, html, options, disposed: false };
      frames.push(frame);
      if (opts.syncFail) options.onFailure({ error: 'sync' });
      return { dispose: () => { frame.disposed = true; } };
    },
  };
  const assetsUtils = opts.assetsUtils || {
    inlineLinkedAssets: async (o) => {
      captured.options = o;
      captured.calls.push(o);
      return typeof opts.result === 'function' ? opts.result(o) : (opts.result || emptyResult());
    },
  };
  const fsCalls = { readText: [], readImage: [] };
  const api = opts.api === null ? null : {
    readText: async (payload) => { fsCalls.readText.push(payload); return opts.readText ? opts.readText(payload) : { ok: true, content: 'css', truncated: false, editable: true }; },
    readImage: async (payload) => { fsCalls.readImage.push(payload); return opts.readImage ? opts.readImage(payload) : { ok: true, base64: 'AAAA', mime: 'image/png', size: 3 }; },
  };
  const surface = createPreviewHtmlSurface({
    getBodyEl: () => body,
    windowRef: dom.window,
    frameUtils,
    assetsUtils,
    editorHost: { hasDocument: (p) => !!(opts.buffers && p in opts.buffers), getValue: (p) => opts.buffers[p] },
    getWorkspaceFsApi: () => api,
  });
  const events = [];
  const cb = {
    onSuccess: () => events.push('success'),
    onFailure: (payload) => events.push(['failure', payload]),
    onLinkBlocked: () => events.push('blocked'),
    onNavigatedAway: () => events.push('away'),
  };
  return { surface, body, frames, captured, fsCalls, events, cb, window: dom.window };
}

const hosts = (h) => [...h.body.querySelectorAll('[data-preview-frame-host]')];

// ---- build: note and noteTitle ----

async function noteFor(result) {
  const h = makeSurface({ result: emptyResult(result) });
  return h.surface.build('site/index.html', '<p>src</p>');
}

test('build: no linked files gives an empty note and title', async () => {
  const built = await noteFor({});
  assert.equal(built.note, '');
  assert.equal(built.noteTitle, '');
  assert.equal(built.html, '<p>built</p>');
});

test('build: loaded only, singular and plural', async () => {
  const one = await noteFor({ loaded: ['a.css'] });
  assert.equal(one.note, '1 linked file loaded');
  assert.equal(one.noteTitle, 'Loaded: a.css');
  const many = await noteFor({ loaded: ['a.css', 'b.js'] });
  assert.equal(many.note, '2 linked files loaded');
  assert.equal(many.noteTitle, 'Loaded: a.css, b.js');
});

test('build: not loaded only, singular and plural; web links count as not loaded', async () => {
  const one = await noteFor({ notLoaded: [{ ref: 'x.css', reason: 'not_found' }] });
  assert.equal(one.note, '1 linked file not loaded');
  const many = await noteFor({ notLoaded: [{ ref: 'x.css', reason: 'not_found' }], webLinks: 2 });
  assert.equal(many.note, '3 linked files not loaded');
  const web = await noteFor({ webLinks: 1 });
  assert.equal(web.note, '1 linked file not loaded');
  assert.equal(web.noteTitle, '1 web address not loaded');
  const webs = await noteFor({ webLinks: 3 });
  assert.equal(webs.noteTitle, '3 web addresses not loaded');
});

test('build: both loaded and not loaded', async () => {
  const built = await noteFor({ loaded: ['a.css'], notLoaded: [{ ref: 'b.js', reason: 'unsupported' }], webLinks: 1 });
  assert.equal(built.note, '1 loaded, 2 not loaded');
});

test('build: failures are grouped by reason in the title', async () => {
  const built = await noteFor({
    loaded: ['ok.css'],
    notLoaded: [
      { ref: 'a.png', reason: 'not_found' },
      { ref: 'big.js', reason: 'too_large' },
      { ref: 'b.png', reason: 'not_found' },
      { ref: 'c.js', reason: 'limit' },
      { ref: 'f.woff', reason: 'binary' },
      { ref: '/abs.css', reason: 'root_relative' },
    ],
    webLinks: 2,
  });
  assert.equal(built.noteTitle.split('\n').join(' | '), [
    'Loaded: ok.css',
    'Not loaded: a.png, b.png (file not found)',
    'Not loaded: big.js, c.js (too large)',
    'Not loaded: f.woff, /abs.css (not supported in the preview)',
    '2 web addresses not loaded',
  ].join(' | '));
});

test('build: a long list is capped at 20 names with a count of the rest', async () => {
  const loaded = Array.from({ length: 23 }, (_v, i) => `f${i}.css`);
  const built = await noteFor({ loaded });
  const line = built.noteTitle;
  assert.ok(line.startsWith('Loaded: f0.css, f1.css'));
  assert.ok(line.includes('f19.css'));
  assert.equal(line.includes('f20.css'), false);
  assert.ok(line.endsWith(', +3 more'));
});

test('build: passes html, path and DOMParser; a rejection or missing module returns the original', async () => {
  const h = makeSurface();
  await h.surface.build('site/index.html', '<p>src</p>');
  assert.equal(h.captured.options.html, '<p>src</p>');
  assert.equal(h.captured.options.path, 'site/index.html');
  assert.equal(h.captured.options.DOMParser, h.window.DOMParser);

  const bad = makeSurface({ assetsUtils: { inlineLinkedAssets: async () => { throw new Error('boom'); } } });
  assert.deepEqual(await bad.surface.build('a.html', '<i>t</i>'), { html: '<i>t</i>', note: '', noteTitle: '' });
  const missing = makeSurface({ assetsUtils: {} });
  assert.equal((await missing.surface.build('a.html', '<i>t</i>')).html, '<i>t</i>');
});

test('isDependency tracks the latest build only', async () => {
  const h = makeSurface({ result: (o) => emptyResult({ dependencies: o.html === 'one' ? ['a.css'] : ['b.css'] }) });
  assert.equal(h.surface.isDependency('a.css'), false);
  await h.surface.build('p.html', 'one');
  assert.equal(h.surface.isDependency('a.css'), true);
  assert.equal(h.surface.isDependency('b.css'), false);
  await h.surface.build('p.html', 'two');
  assert.equal(h.surface.isDependency('a.css'), false);
  assert.equal(h.surface.isDependency('b.css'), true);
  const failing = makeSurface({ assetsUtils: { inlineLinkedAssets: async () => { throw new Error('x'); } } });
  await failing.surface.build('p.html', 'x');
  assert.equal(failing.surface.isDependency('a.css'), false);
});

// ---- readers ----

test('readText prefers an open buffer', async () => {
  const h = makeSurface({ buffers: { 'a.css': 'BUFFER' } });
  await h.surface.build('p.html', 'x');
  assert.deepEqual(await h.captured.options.readText('a.css', 100), { ok: true, text: 'BUFFER' });
  assert.equal(h.fsCalls.readText.length, 0);
});

test('readText reads through the fs api with intent preview and the byte cap', async () => {
  const h = makeSurface();
  await h.surface.build('p.html', 'x');
  const r = await h.captured.options.readText('a.css', 1234);
  assert.deepEqual(r, { ok: true, text: 'css' });
  assert.deepEqual(h.fsCalls.readText, [{ path: 'a.css', intent: 'preview', maxBytes: 1234 }]);
});

test('concurrent asset reads are each a direct api read, never a shared preview intent', async () => {
  const h = makeSurface();
  await h.surface.build('p.html', 'x');
  const both = await Promise.all([h.captured.options.readText('a.css', 10), h.captured.options.readText('b.css', 10)]);
  assert.deepEqual(both.map((r) => r.ok), [true, true], 'the second read does not make the first stale');
  assert.deepEqual(h.fsCalls.readText.map((c) => [c.path, c.intent]), [['a.css', 'preview'], ['b.css', 'preview']]);
});

test('readText maps NOT_FOUND from a result code and from a thrown error', async () => {
  const fromResult = makeSurface({ readText: () => ({ ok: false, code: NOT_FOUND }) });
  await fromResult.surface.build('p.html', 'x');
  assert.deepEqual(await fromResult.captured.options.readText('a.css', 1), { ok: false, reason: 'not_found' });

  const fromThrow = makeSurface({ readText: () => { const e = new Error('nf'); e.code = NOT_FOUND; throw e; } });
  await fromThrow.surface.build('p.html', 'x');
  assert.deepEqual(await fromThrow.captured.options.readText('a.css', 1), { ok: false, reason: 'not_found' });

  const other = makeSurface({ readText: () => ({ ok: false, code: 'CMP-OTHER-1' }) });
  await other.surface.build('p.html', 'x');
  assert.deepEqual(await other.captured.options.readText('a.css', 1), { ok: false, reason: 'unavailable' });
  const plainThrow = makeSurface({ readText: () => { throw new Error('x'); } });
  await plainThrow.surface.build('p.html', 'x');
  assert.deepEqual(await plainThrow.captured.options.readText('a.css', 1), { ok: false, reason: 'unavailable' });
  const noApi = makeSurface({ api: null });
  await noApi.surface.build('p.html', 'x');
  assert.deepEqual(await noApi.captured.options.readText('a.css', 1), { ok: false, reason: 'unavailable' });
});

test('readText maps truncated to too_large and non-editable or NUL content to binary', async () => {
  const cases = [
    [{ ok: true, content: 'x', truncated: true, editable: true }, 'too_large'],
    [{ ok: true, content: 'x', truncated: false, editable: false }, 'binary'],
    [{ ok: true, content: 'a\0b', truncated: false, editable: true }, 'binary'],
  ];
  for (const [payload, reason] of cases) {
    const h = makeSurface({ readText: () => payload });
    await h.surface.build('p.html', 'x');
    assert.deepEqual(await h.captured.options.readText('a.css', 1), { ok: false, reason });
  }
});

test('readDataUrl skips fonts without calling the api and builds image data urls', async () => {
  const h = makeSurface();
  await h.surface.build('p.html', 'x');
  assert.deepEqual(await h.captured.options.readDataUrl('fonts/a.woff2'), { ok: false, reason: 'binary' });
  assert.deepEqual(await h.captured.options.readDataUrl('noext'), { ok: false, reason: 'binary' });
  assert.equal(h.fsCalls.readImage.length, 0);
  const r = await h.captured.options.readDataUrl('img/Logo.PNG');
  assert.deepEqual(r, { ok: true, dataUrl: 'data:image/png;base64,AAAA', bytes: 3 });
  assert.deepEqual(h.fsCalls.readImage, [{ path: 'img/Logo.PNG' }]);
});

test('readDataUrl rejects a bad mime or payload and maps failures without throwing', async () => {
  const badMime = makeSurface({ readImage: () => ({ ok: true, base64: 'AAAA', mime: 'text/html', size: 3 }) });
  await badMime.surface.build('p.html', 'x');
  assert.equal((await badMime.captured.options.readDataUrl('a.png')).ok, false);
  const badBase = makeSurface({ readImage: () => ({ ok: true, base64: 5, mime: 'image/png', size: 3 }) });
  await badBase.surface.build('p.html', 'x');
  assert.equal((await badBase.captured.options.readDataUrl('a.png')).ok, false);
  const notFound = makeSurface({ readImage: () => ({ ok: false, code: NOT_FOUND }) });
  await notFound.surface.build('p.html', 'x');
  assert.deepEqual(await notFound.captured.options.readDataUrl('a.png'), { ok: false, reason: 'not_found' });
  const thrown = makeSurface({ readImage: () => { throw new Error('x'); } });
  await thrown.surface.build('p.html', 'x');
  assert.deepEqual(await thrown.captured.options.readDataUrl('a.png'), { ok: false, reason: 'unavailable' });
  const noApi = makeSurface({ api: null });
  await noApi.surface.build('p.html', 'x');
  assert.deepEqual(await noApi.captured.options.readDataUrl('a.png'), { ok: false, reason: 'unavailable' });
});

// ---- mount: swap when ready ----

test('first mount in an empty body uses a plain host and promotes on success', () => {
  const h = makeSurface();
  h.surface.mount('a.html', '<p>1</p>', h.cb);
  assert.equal(hosts(h).length, 1);
  assert.equal(hosts(h)[0].className, 'ide-preview-frame-host');
  assert.equal(h.frames[0].options.requestKey, 'a.html');
  assert.equal(h.frames[0].options.sizing, 'fill');
  h.frames[0].options.onSuccess();
  assert.deepEqual(h.events, ['success']);
  assert.equal(h.frames[0].disposed, false);
});

test('a same-path remount keeps the old page up until the new one succeeds', () => {
  const h = makeSurface();
  h.surface.mount('a.html', '1', h.cb);
  h.frames[0].options.onSuccess();
  h.events.length = 0;
  h.surface.mount('a.html', '2', h.cb);
  assert.equal(hosts(h).length, 2);
  assert.equal(hosts(h)[0].className, 'ide-preview-frame-host');
  assert.equal(hosts(h)[1].className, 'ide-preview-frame-host ide-preview-frame-host--pending');
  assert.equal(h.frames[0].disposed, false, 'old page is still up');
  h.frames[1].options.onSuccess();
  assert.equal(h.frames[0].disposed, true);
  assert.equal(hosts(h).length, 1);
  assert.equal(hosts(h)[0], h.frames[1].host);
  assert.equal(hosts(h)[0].className, 'ide-preview-frame-host');
  assert.deepEqual(h.events, ['success']);
});

test('a different path replaces the old page at once', () => {
  const h = makeSurface();
  h.surface.mount('a.html', '1', h.cb);
  h.frames[0].options.onSuccess();
  h.surface.mount('b.html', '2', h.cb);
  assert.equal(h.frames[0].disposed, true);
  assert.equal(hosts(h).length, 1);
  assert.equal(hosts(h)[0].className, 'ide-preview-frame-host');
});

test('failure of the pending frame disposes both and reports', () => {
  const h = makeSurface();
  h.surface.mount('a.html', '1', h.cb);
  h.frames[0].options.onSuccess();
  h.events.length = 0;
  h.surface.mount('a.html', '2', h.cb);
  h.frames[1].options.onFailure({ error: 'bad' });
  assert.equal(h.frames[0].disposed, true);
  assert.equal(h.frames[1].disposed, true);
  assert.equal(hosts(h).length, 0);
  assert.deepEqual(h.events, [['failure', { error: 'bad' }]]);
});

test('a newer mount discards an older pending frame and ignores its late callbacks', () => {
  const h = makeSurface();
  h.surface.mount('a.html', '1', h.cb);
  h.frames[0].options.onSuccess();
  h.events.length = 0;
  h.surface.mount('a.html', '2', h.cb);
  h.surface.mount('a.html', '3', h.cb);
  assert.equal(h.frames[1].disposed, true, 'the older pending is disposed');
  assert.equal(hosts(h).length, 2);
  h.frames[1].options.onSuccess();
  h.frames[1].options.onFailure({ error: 'late' });
  h.frames[1].options.onNavigatedAway();
  assert.deepEqual(h.events, [], 'late callbacks from the discarded frame do nothing');
  assert.equal(h.frames[0].disposed, false, 'the old page still shows');
  h.frames[2].options.onSuccess();
  assert.equal(h.frames[0].disposed, true);
  assert.deepEqual(h.events, ['success']);
});

test('scroll is remembered from the current frame only and restored for the same path', () => {
  const h = makeSurface();
  h.surface.mount('a.html', '1', h.cb);
  assert.equal(h.frames[0].options.restoreScrollY, undefined);
  h.frames[0].options.onScroll(50);
  h.frames[0].options.onSuccess();
  h.frames[0].options.onScroll(120);
  h.surface.mount('a.html', '2', h.cb);
  assert.equal(h.frames[1].options.restoreScrollY, 120);
  h.frames[1].options.onScroll(900);
  assert.equal(h.frames[2], undefined);
  h.surface.mount('a.html', '3', h.cb);
  assert.equal(h.frames[2].options.restoreScrollY, 120, 'a hidden frame cannot overwrite the visible position');
  h.surface.mount('b.html', '4', h.cb);
  assert.equal(h.frames[3].options.restoreScrollY, undefined, 'another path starts at the top');
});

test('resetScroll forgets the remembered position', () => {
  const h = makeSurface();
  h.surface.mount('a.html', '1', h.cb);
  h.frames[0].options.onSuccess();
  h.frames[0].options.onScroll(77);
  h.surface.resetScroll();
  h.surface.mount('a.html', '2', h.cb);
  assert.equal(h.frames[1].options.restoreScrollY, undefined);
});

test('onLinkBlocked only counts for the current frame; onNavigatedAway for current or pending, never a dead one', () => {
  const h = makeSurface();
  h.surface.mount('a.html', '1', h.cb);
  h.frames[0].options.onSuccess();
  h.events.length = 0;
  h.surface.mount('a.html', '2', h.cb);
  h.frames[1].options.onLinkBlocked();
  assert.deepEqual(h.events, [], 'a hidden frame cannot flash the note');
  h.frames[0].options.onLinkBlocked();
  assert.deepEqual(h.events, ['blocked']);
  h.frames[1].options.onNavigatedAway();
  assert.deepEqual(h.events, ['blocked', 'away']);
  h.surface.disposeFrames();
  h.frames[1].options.onNavigatedAway();
  assert.deepEqual(h.events, ['blocked', 'away']);
});

test('a synchronous failure while the frame is created is safe', () => {
  const h = makeSurface({ syncFail: true });
  assert.doesNotThrow(() => h.surface.mount('a.html', '1', h.cb));
  assert.deepEqual(h.events, [['failure', { error: 'sync' }]]);
  assert.equal(h.frames[0].disposed, true, 'the frame handle is disposed once it is returned');
  assert.equal(hosts(h).length, 0);
  assert.doesNotThrow(() => h.surface.mount('a.html', '2', h.cb));
});

test('disposeFrames removes both hosts', () => {
  const h = makeSurface();
  h.surface.mount('a.html', '1', h.cb);
  h.frames[0].options.onSuccess();
  h.surface.mount('a.html', '2', h.cb);
  h.surface.disposeFrames();
  assert.equal(hosts(h).length, 0);
  assert.equal(h.frames[0].disposed, true);
  assert.equal(h.frames[1].disposed, true);
  h.surface.disposeFrames();
});

test('countExternalResources counts scripts and stylesheets that stayed external', () => {
  const h = makeSurface();
  const counts = h.surface.countExternalResources('<link rel="stylesheet" href="a.css"><script src="b.js"></script><script src="c.js"></script>');
  assert.deepEqual(counts, { external_scripts: 2, external_stylesheets: 1 });
});

test('a slower, superseded build does not replace the dependency list', async () => {
  let releaseOld;
  const gate = new Promise((resolve) => { releaseOld = resolve; });
  const h = makeSurface({
    assetsUtils: {
      inlineLinkedAssets: async (o) => {
        if (o.html === 'old') await gate;
        return emptyResult({ dependencies: [`${o.html}.css`] });
      },
    },
  });
  const older = h.surface.build('p.html', 'old');
  await h.surface.build('p.html', 'new');
  releaseOld();
  await older;
  assert.equal(h.surface.isDependency('new.css'), true);
  assert.equal(h.surface.isDependency('old.css'), false);
});
