'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createAdBlocker } = require('../services/browser-use/ad-block');

const adblocker = require('@ghostery/adblocker');

const FILTERS = [
  '||ads.example^',
  '@@||ads.example/allowed^',
  'news.example##.banner',
].join('\n');

function tinyBytes() {
  return adblocker.FiltersEngine.parse(FILTERS, {
    enableCompression: true,
    loadCosmeticFilters: true,
    loadNetworkFilters: true,
    loadGenericCosmeticsFilters: false,
    loadExtendedSelectors: false,
  }).serialize();
}

function tinyBlocker(extra = {}) {
  return createAdBlocker({
    loadBytes: () => tinyBytes(),
    loadEngineModule: () => adblocker,
    ...extra,
  });
}

const sub = (url, sourceUrl = 'https://site.example/') => ({ url, sourceUrl, type: 'script' });

test('inert before ready', () => {
  const blocker = tinyBlocker();
  assert.equal(blocker.shouldBlock(sub('https://ads.example/x.js')), false);
  assert.equal(blocker.stylesFor('https://news.example/'), '');
});

test('blocks a matching subresource once ready', async () => {
  const blocker = tinyBlocker();
  assert.equal(await blocker.ready(), true);
  assert.equal(blocker.shouldBlock(sub('https://ads.example/x.js')), true);
  assert.equal(blocker.shouldBlock(sub('https://other.example/x.js')), false);
});

test('never blocks a main frame', async () => {
  const blocker = tinyBlocker();
  await blocker.ready();
  assert.equal(blocker.shouldBlock({ url: 'https://ads.example/', sourceUrl: '', type: 'mainFrame' }), false);
});

test('never blocks a non-http request', async () => {
  const blocker = tinyBlocker();
  await blocker.ready();
  for (const url of ['file:///ads.example/x.js', 'data:text/plain,ads.example', 'about:blank', 'ws://ads.example/x', '']) {
    assert.equal(blocker.shouldBlock(sub(url)), false, url);
  }
});

test('an exception filter lets the request through', async () => {
  const blocker = tinyBlocker();
  await blocker.ready();
  assert.equal(blocker.shouldBlock(sub('https://ads.example/allowed/x.js')), false);
});

test('a throwing engine answers false', async () => {
  const throwing = {
    FiltersEngine: { deserialize: () => ({ match: () => { throw new Error('boom'); } }) },
    Request: adblocker.Request,
  };
  const blocker = createAdBlocker({ loadBytes: () => new Uint8Array(1), loadEngineModule: () => throwing });
  assert.equal(await blocker.ready(), true);
  assert.equal(blocker.shouldBlock(sub('https://ads.example/x.js')), false);
});

test('a failed load leaves it inert and ready resolves false', async () => {
  const warnings = [];
  const blocker = createAdBlocker({
    loadBytes: () => { throw new Error('missing file at /secret/path'); },
    loadEngineModule: () => adblocker,
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(await blocker.ready(), false);
  assert.equal(blocker.shouldBlock(sub('https://ads.example/x.js')), false);
  assert.equal(blocker.stylesFor('https://news.example/'), '');
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /secret|path/);
});

test('garbage bytes fail the load without throwing', async () => {
  const blocker = createAdBlocker({ loadBytes: () => new Uint8Array([1, 2, 3]), loadEngineModule: () => adblocker });
  assert.equal(await blocker.ready(), false);
});

test('ready loads only once', async () => {
  let bytesCalls = 0;
  let moduleCalls = 0;
  const blocker = createAdBlocker({
    loadBytes: () => { bytesCalls += 1; return tinyBytes(); },
    loadEngineModule: () => { moduleCalls += 1; return adblocker; },
  });
  await Promise.all([blocker.ready(), blocker.ready()]);
  await blocker.ready();
  assert.deepEqual([bytesCalls, moduleCalls], [1, 1]);
});

test('stylesFor returns hiding rules for a matching host only', async () => {
  const blocker = tinyBlocker();
  await blocker.ready();
  assert.match(blocker.stylesFor('https://news.example/story'), /\.banner/);
  assert.equal(blocker.stylesFor('https://other.example/story'), '');
  assert.equal(blocker.stylesFor('file:///news.example/'), '');
  assert.equal(blocker.stylesFor('about:blank'), '');
});

test('the shipped filters.bin loads with the installed engine and blocks real ad hosts', async () => {
  const blocker = createAdBlocker();
  assert.equal(await blocker.ready(), true, 'filters.bin must match the installed engine version; rebuild with build-ad-filters.js');
  assert.equal(
    blocker.shouldBlock({ url: 'https://googleads.g.doubleclick.net/pagead/id', sourceUrl: 'https://www.youtube.com/watch?v=x', type: 'xhr' }),
    true,
  );
  assert.equal(blocker.shouldBlock({ url: 'https://example.com/app.js', sourceUrl: 'https://www.youtube.com/watch?v=x', type: 'script' }), false);
});

test('shipped filters.json records both lists with versions and a license', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'ad-filters', 'filters.json'), 'utf8'));
  assert.equal(meta.lists.length, 2);
  for (const list of meta.lists) {
    assert.match(list.version, /^\d+$/);
    assert.match(list.license, /GPL-3\.0/);
  }
});

test('requiring the module does not load the engine library', () => {
  const script = [
    "require('./services/browser-use/ad-block');",
    "const loaded = Object.keys(require.cache).some((key) => key.includes('@ghostery'));",
    'process.exit(loaded ? 1 : 0);',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') });
  assert.equal(result.status, 0, String(result.stderr));
});
