'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { BrowserSessionService } = require('../services/browser-session-service');
const {
  MAX_OVERRIDE_ENTRIES,
  MAX_OVERRIDE_ENTRY_BYTES,
} = require('../services/browser-session-file-overrides');
const { createFakeBrowserWindowFactory } = require('./helpers/fake-browser-window');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// The shared fake has no protocol module; a session that takes overrides needs
// `protocol.handle` and `fetch` on its own browser session.
function createOverrideCapableFactory({ withProtocol = true } = {}) {
  const base = createFakeBrowserWindowFactory();
  const factory = (options) => {
    const window = base(options);
    const browserSession = window.browserSession;
    browserSession.fetchCalls = [];
    browserSession.fetch = async (url, init) => {
      browserSession.fetchCalls.push({ url, init });
      return new Response('from disk', { status: 200 });
    };
    if (withProtocol) {
      browserSession.protocol = {
        handlers: new Map(),
        unhandled: [],
        handle(scheme, handler) { this.handlers.set(scheme, handler); },
        unhandle(scheme) { this.unhandled.push(scheme); this.handlers.delete(scheme); },
      };
    }
    return window;
  };
  factory.windows = base.windows;
  return factory;
}

function makeWorkspace() {
  const base = fs.realpathSync(createTrackedTempDir('jenny-file-overrides-'));
  const root = path.join(base, 'site');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'index.html'), '<link rel="stylesheet" href="site.css">after');
  fs.writeFileSync(path.join(root, 'site.css'), 'body{color:blue}');
  fs.writeFileSync(path.join(root, 'new.css'), 'body{margin:0}');
  fs.writeFileSync(path.join(root, 'untouched.css'), 'p{margin:0}');
  fs.writeFileSync(path.join(outside, 'secret.css'), 'secret');
  return { root, outside };
}

async function openWithOverrides(overrides, { root, strict = true, page = 'index.html', factory = createOverrideCapableFactory() } = {}) {
  const service = new BrowserSessionService({ browserWindowFactory: factory });
  await service.open({
    sessionId: 'before_1',
    streamId: 'stream_1',
    url: pathToFileURL(path.join(root, page)).toString(),
    allowedFileRoots: [root],
    strictWorkspaceOnly: strict,
    fileOverrides: overrides,
  });
  const window = factory.windows[factory.windows.length - 1];
  const handler = window.browserSession.protocol.handlers.get('file');
  const request = (filePath, suffix = '') => handler({ url: pathToFileURL(filePath).toString() + suffix });
  return { service, window, handler, request };
}

function filterDecision(window, url) {
  let decision = null;
  window.browserSession.webRequest.beforeRequestListener({ url, resourceType: 'stylesheet' }, (value) => { decision = value; });
  return decision;
}

describe('BrowserSessionService / file overrides', () => {
  test('serves earlier text from memory with a content type, and reports what was asked for', async () => {
    const { root } = makeWorkspace();
    const { service, window, request } = await openWithOverrides([
      { id: 'site.css', filePath: path.join(root, 'site.css'), content: 'body{color:red}' },
      { id: 'index.html', filePath: path.join(root, 'index.html'), content: Buffer.from('<p>before</p>') },
    ], { root });

    const css = await request(path.join(root, 'site.css'), '?v=2#top');
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(await css.text(), 'body{color:red}');
    const html = await request(path.join(root, 'index.html'));
    assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await html.text(), '<p>before</p>');

    assert.equal(window.browserSession.fetchCalls.length, 0);
    assert.deepEqual(service.fileOverrideReport('before_1'), { requested: ['site.css', 'index.html'], poisoned: false });
  });

  test('a file that did not exist before answers 404 and never reads disk', async () => {
    const { root } = makeWorkspace();
    const { window, request } = await openWithOverrides([
      { id: 'new.css', filePath: path.join(root, 'new.css'), content: null },
    ], { root });

    assert.equal((await request(path.join(root, 'new.css'))).status, 404);
    assert.equal(window.browserSession.fetchCalls.length, 0);
  });

  test('a poison entry answers 404 and marks the render', async () => {
    const { root } = makeWorkspace();
    const { service, request } = await openWithOverrides([
      { id: 'site.css', filePath: path.join(root, 'site.css'), poison: true, content: 'ignored' },
    ], { root });

    assert.deepEqual(service.fileOverrideReport('before_1'), { requested: [], poisoned: false });
    assert.equal((await request(path.join(root, 'site.css'))).status, 404);
    assert.deepEqual(service.fileOverrideReport('before_1'), { requested: ['site.css'], poisoned: true });
  });

  test('a file with no override is read through the session fetch, past its own handler', async () => {
    const { root } = makeWorkspace();
    const { window, request } = await openWithOverrides([
      { id: 'site.css', filePath: path.join(root, 'site.css'), content: 'x' },
    ], { root });

    const url = pathToFileURL(path.join(root, 'untouched.css')).toString();
    const response = await request(path.join(root, 'untouched.css'));
    assert.equal(await response.text(), 'from disk');
    assert.deepEqual(window.browserSession.fetchCalls, [{ url, init: { bypassCustomProtocolHandlers: true } }]);
  });

  test('refuses a request outside the root, a missing file, and a URL that is not a file', async () => {
    const { root, outside } = makeWorkspace();
    const { window, handler, request } = await openWithOverrides([], { root });

    assert.equal((await request(path.join(outside, 'secret.css'))).status, 403);
    assert.equal((await request(path.join(root, '..', 'outside', 'secret.css'))).status, 403);
    assert.equal((await request(path.join(root, 'nope.css'))).status, 404);
    assert.equal((await handler({ url: 'https://example.com/x.css' })).status, 400);
    assert.equal((await handler({})).status, 400);
    assert.equal(window.browserSession.fetchCalls.length, 0);
  });

  test('a deleted file is served from memory and the request filter lets only that one through', async () => {
    const { root } = makeWorkspace();
    const { window, request } = await openWithOverrides([
      { id: 'gone.css', filePath: path.join(root, 'css', 'gone.css'), content: 'h1{color:red}' },
    ], { root });

    const goneUrl = pathToFileURL(path.join(root, 'css', 'gone.css')).toString();
    assert.deepEqual(filterDecision(window, goneUrl), {});
    assert.equal(await (await request(path.join(root, 'css', 'gone.css'))).text(), 'h1{color:red}');
    // A missing file that is not in the table stays blocked, as before.
    assert.deepEqual(filterDecision(window, pathToFileURL(path.join(root, 'css', 'other.css')).toString()), { cancel: true });
    // So does anything outside the root, listed or not.
    assert.deepEqual(filterDecision(window, pathToFileURL(path.join(root, '..', 'outside', 'gone.css')).toString()), { cancel: true });
  });

  test('a deleted page can be opened as the document of a strict session', async () => {
    const { root } = makeWorkspace();
    const { window } = await openWithOverrides([
      { id: 'old.html', filePath: path.join(root, 'old.html'), content: '<p>old</p>' },
    ], { root, page: 'old.html' });

    assert.equal(window.loadedUrl, pathToFileURL(path.join(root, 'old.html')).toString());
  });

  test('a strict session still refuses a missing page that has no override', async () => {
    const { root } = makeWorkspace();
    await assert.rejects(
      openWithOverrides([], { root, page: 'old.html' }),
      /contained workspace file URL/
    );
  });

  test('an override outside the root refuses the whole session', async () => {
    const { root, outside } = makeWorkspace();
    const factory = createOverrideCapableFactory();
    await assert.rejects(
      openWithOverrides([{ id: 'x', filePath: path.join(outside, 'secret.css'), content: 'x' }], { root, factory }),
      /outside the allowed roots/
    );
    assert.equal(factory.windows[0].destroyed, true);
    assert.equal(factory.windows[0].loadedUrl, '');
  });

  test('an override reached through a link that leaves the root is refused', async (t) => {
    const { root, outside } = makeWorkspace();
    try {
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
    } catch (_) {
      t.skip('this platform refused to create the link');
      return;
    }
    await assert.rejects(
      openWithOverrides([{ id: 'x', filePath: path.join(root, 'linked', 'secret.css'), content: 'x' }], { root }),
      /outside the allowed roots/
    );
    await assert.rejects(
      openWithOverrides([{ id: 'x', filePath: path.join(root, 'linked', 'not-there.css'), content: 'x' }], { root }),
      /outside the allowed roots/
    );
  });

  test('overrides need a strict session and a session that can take a handler', async () => {
    const { root } = makeWorkspace();
    await assert.rejects(
      openWithOverrides([], { root, strict: false }),
      /require a strict browser session/
    );
    const bare = createOverrideCapableFactory({ withProtocol: false });
    await assert.rejects(
      openWithOverrides([], { root, factory: bare }),
      /unavailable in this browser session/
    );
    assert.equal(bare.windows[0].destroyed, true);
    assert.equal(bare.windows[0].loadedUrl, '');
  });

  test('the table is bounded', async () => {
    const { root } = makeWorkspace();
    const many = Array.from({ length: MAX_OVERRIDE_ENTRIES + 1 }, (_, index) => ({
      id: String(index), filePath: path.join(root, `f${index}.css`), content: '',
    }));
    await assert.rejects(openWithOverrides(many, { root }), /Too many file overrides/);
    await assert.rejects(
      openWithOverrides([{ id: 'big', filePath: path.join(root, 'site.css'), content: Buffer.alloc(MAX_OVERRIDE_ENTRY_BYTES + 1) }], { root }),
      /too large/
    );
    await assert.rejects(openWithOverrides('site.css', { root }), /must be a list/);
    await assert.rejects(
      openWithOverrides([{ id: 'n', filePath: path.join(root, 'site.css'), content: 42 }], { root }),
      /text, bytes or null/
    );
  });

  test('closing the session removes the handler', async () => {
    const { root } = makeWorkspace();
    const { service, window } = await openWithOverrides([], { root });
    await service.close('before_1');
    assert.deepEqual(window.browserSession.protocol.unhandled, ['file']);
    assert.equal(service.fileOverrideReport('before_1'), null);
  });

  test('a session opened without overrides installs no handler and reports nothing', async () => {
    const { root } = makeWorkspace();
    const factory = createOverrideCapableFactory();
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({
      sessionId: 'after_1',
      url: pathToFileURL(path.join(root, 'index.html')).toString(),
      allowedFileRoots: [root],
      strictWorkspaceOnly: true,
    });
    assert.equal(factory.windows[0].browserSession.protocol.handlers.size, 0);
    assert.equal(service.fileOverrideReport('after_1'), null);
    assert.deepEqual(
      filterDecision(factory.windows[0], pathToFileURL(path.join(root, 'missing.css')).toString()),
      { cancel: true }
    );
  });

  test('file names match without regard to case on Windows', { skip: process.platform !== 'win32' }, async () => {
    const { root } = makeWorkspace();
    const { request } = await openWithOverrides([
      { id: 'site.css', filePath: path.join(root, 'SITE.CSS'), content: 'body{color:red}' },
    ], { root });
    assert.equal(await (await request(path.join(root, 'site.css'))).text(), 'body{color:red}');
  });
});
