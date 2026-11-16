'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const { makeHarness, pictureText } = require('./helpers/change-pictures-harness');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { VIEWPORTS, WORKING_TREE_TURN_ID } = require('../services/change-pictures/change-pictures-service');
const { changeShowsThroughMotion, measureChange } = require('../services/change-pictures/picture-compare');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const PAGE = '<link rel="stylesheet" href="site.css"><h1>Prices</h1>';

test('a stylesheet edit gives the page that uses it a Before and an After picture', async () => {
  const h = makeHarness();
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'h1{color:red}', 'h1{color:blue}');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.deepEqual(Object.keys(result.record).sort(), ['capturedAt', 'pages', 'sessionId', 'turnId', 'viewport']);
  assert.equal(result.record.viewport, 'desktop');
  assert.equal(result.record.pages.length, 1);
  const page = result.record.pages[0];
  assert.deepEqual(
    { path: page.path, state: page.state, width: page.width, height: page.height },
    { path: 'index.html', state: 'ready', ...VIEWPORTS.desktop }
  );
  assert.match(pictureText(page.beforeUrl), /color:red/);
  assert.match(pictureText(page.afterUrl), /color:blue/);
  assert.ok(fileURLToPath(page.beforeUrl).startsWith(h.storeRoot));
  // The workspace itself was never rewritten.
  assert.equal(fs.readFileSync(path.join(h.root, 'site.css'), 'utf8'), 'h1{color:blue}');
});

test('every render is a strict workspace-only session that is closed afterwards', async () => {
  const h = makeHarness();
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'h1{color:red}', 'h1{color:blue}');

  await h.service.capture({ sessionId: 's1', turnId: 't1', viewport: 'phone', files: [change] });

  assert.equal(h.browser.opened.length, 2);
  for (const options of h.browser.opened) {
    assert.equal(options.strictWorkspaceOnly, true);
    assert.deepEqual(options.allowedFileRoots, [h.root]);
    // The page's own size, with no scrollbar in the picture.
    assert.deepEqual(options.bounds, { ...VIEWPORTS.phone, contentSize: true });
    assert.equal(options.hideScrollbars, true);
    assert.match(options.sessionId, /^change_pic_[0-9a-f]{16}$/);
  }
  const [after, before] = h.browser.opened;
  assert.equal(after.fileOverrides, null);
  assert.deepEqual(before.fileOverrides, [
    { id: 'site.css', filePath: path.join(h.root, 'site.css'), content: 'h1{color:red}' },
  ]);
  assert.deepEqual(h.browser.closed.sort(), h.browser.opened.map((options) => options.sessionId).sort());
});

test('a second request for the same turn is answered from the store; force retakes it', async () => {
  const h = makeHarness();
  h.write('index.html', PAGE);
  const payload = { sessionId: 's1', turnId: 't1', files: [h.edit('site.css', 'a{}', 'b{}')] };

  const first = await h.service.capture(payload);
  const second = await h.service.capture(payload);
  assert.equal(h.browser.opened.length, 2);
  assert.deepEqual(second.record, first.record);

  await h.service.capture({ ...payload, viewport: 'phone' });
  assert.equal(h.browser.opened.length, 4);
  await h.service.capture({ ...payload, viewport: 'phone', force: true });
  assert.equal(h.browser.opened.length, 6);
});

test('a phone capture is stored beside the desktop pictures, never in their place', async () => {
  const h = makeHarness();
  h.write('index.html', PAGE);
  const payload = { sessionId: 's1', turnId: 't1', files: [h.edit('site.css', 'a{}', 'b{}')] };

  const desktop = await h.service.capture(payload);
  const phone = await h.service.capture({ ...payload, viewport: 'phone' });
  assert.equal(phone.record.turnId, 't1');
  assert.equal(phone.record.viewport, 'phone');

  const listed = (await h.service.list({ sessionId: 's1' })).records;
  assert.deepEqual(listed.map((record) => `${record.turnId} ${record.viewport}`).sort(), ['t1 desktop', 't1 phone']);
  assert.deepEqual(listed.find((record) => record.viewport === 'desktop'), desktop.record);
  for (const page of desktop.record.pages) assert.equal(fs.existsSync(fileURLToPath(page.beforeUrl)), true);

  // Going back to desktop size is answered from the store.
  const opened = h.browser.opened.length;
  assert.deepEqual((await h.service.capture(payload)).record, desktop.record);
  assert.equal(h.browser.opened.length, opened);

  assert.deepEqual(await h.service.capture({ ...payload, turnId: 't1@phone' }), { ok: false, reason: 'invalid' });
});

test('two requests for the same turn at once share one capture', async () => {
  const h = makeHarness();
  h.write('index.html', PAGE);
  const payload = { sessionId: 's1', turnId: 't1', files: [h.edit('site.css', 'a{}', 'b{}')] };

  const [one, two] = await Promise.all([h.service.capture(payload), h.service.capture(payload)]);
  assert.equal(h.browser.opened.length, 2);
  assert.deepEqual(one, two);
});

test('a turn whose files have changed again since gets no pictures', async () => {
  const h = makeHarness();
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'a{}', 'b{}');
  h.write('site.css', 'c{}');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  assert.deepEqual(result, { ok: true, enabled: true, record: null });
  assert.equal(h.browser.opened.length, 0);
  assert.deepEqual((await h.service.list({ sessionId: 's1' })).records, []);
});

test('line endings and a byte-order mark on disk do not hide a match', async () => {
  const h = makeHarness();
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'a{}', 'b{}\nc{}\n');
  h.write('site.css', '\uFEFFb{}\r\nc{}\r\n');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  assert.equal(result.record.pages[0].state, 'ready');
});

test('a new page has only an After picture and a deleted page only a Before', async () => {
  const h = makeHarness();
  const created = h.edit('new.html', null, '<p>hello</p>');
  h.write('old.html', '<p>bye</p>');
  const deleted = h.edit('old.html', '<p>bye</p>', null);

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [created, deleted] });
  const byPath = Object.fromEntries(result.record.pages.map((page) => [page.path, page]));
  assert.equal(byPath['new.html'].state, 'new');
  assert.equal(byPath['new.html'].beforeUrl, null);
  assert.match(pictureText(byPath['new.html'].afterUrl), /hello/);
  assert.equal(byPath['old.html'].state, 'deleted');
  assert.equal(byPath['old.html'].afterUrl, null);
  assert.match(pictureText(byPath['old.html'].beforeUrl), /bye/);
});

test('a file created in the turn is absent from the Before picture', async () => {
  const h = makeHarness();
  h.write('index.html', '<link href="site.css"><link href="extra.css">');
  h.write('site.css', 'a{}');
  const created = h.edit('extra.css', null, 'extra{}');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [created] });
  const page = result.record.pages[0];
  assert.equal(page.state, 'ready');
  assert.doesNotMatch(pictureText(page.beforeUrl), /extra\{\}/);
  assert.match(pictureText(page.afterUrl), /extra\{\}/);
});

test('a page whose external files were blocked carries the hosts, in the record and in list', async () => {
  const h = makeHarness({
    browserOptions: { blockedHosts: (options) => (options.fileOverrides ? ['cdn.jsdelivr.net'] : ['cdn.jsdelivr.net', 'fonts.example']) },
  });
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'h1{color:red}', 'h1{color:blue}');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  assert.deepEqual(result.record.pages[0].blockedHosts, ['cdn.jsdelivr.net', 'fonts.example']);

  const listed = await h.service.list({ sessionId: 's1' });
  assert.deepEqual(listed.records[0].pages[0].blockedHosts, ['cdn.jsdelivr.net', 'fonts.example']);
});

test('a blocked-host list is bounded to four hostnames and a page without blocks has no field', async () => {
  const many = ['x'.repeat(300), 'a.example', 'b.example', 'c.example', 'd.example', 'e.example'];
  const blocked = makeHarness({ browserOptions: { blockedHosts: () => many } });
  blocked.write('index.html', PAGE);
  const first = await blocked.service.capture({ sessionId: 's1', turnId: 't1', files: [blocked.edit('site.css', 'a{}', 'b{}')] });
  assert.deepEqual(first.record.pages[0].blockedHosts, ['a.example', 'b.example', 'c.example', 'd.example']);

  const clean = makeHarness();
  clean.write('index.html', PAGE);
  const second = await clean.service.capture({ sessionId: 's1', turnId: 't1', files: [clean.edit('site.css', 'a{}', 'b{}')] });
  assert.equal('blockedHosts' in second.record.pages[0], false);
});

test('a page that looks the same keeps one picture and says so', async () => {
  const h = makeHarness();
  h.write('index.html', PAGE);
  // The fake paints the same bytes for both versions of this file.
  const change = h.edit('site.css', 'a{}', 'a{}');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  const page = result.record.pages[0];
  assert.equal(page.state, 'same');
  assert.equal(page.beforeUrl, null);
  assert.ok(page.afterUrl);
});

// A six-pixel bitmap with the listed pixels lit, as the browser session's small picture.
const thumb = (...lit) => ({ width: 6, height: 1, bitmap: Buffer.from([0, 1, 2, 3, 4, 5].flatMap((i) => (lit.includes(i) ? [255, 255, 255, 255] : [0, 0, 0, 255]))) });

test('a page that waits on a script from the internet has no pictures', async () => {
  // The picture session is offline, so such a page is still on its loading screen.
  const h = makeHarness({ browserOptions: { blockedHosts: () => ['unpkg.com'], waitsOnBlocked: () => true } });
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'a{color:red}', 'a{color:blue}');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  assert.deepEqual(result.record.pages, []);
  assert.equal(h.browser.opened.length, 1, 'the Before render is not attempted');
  await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  assert.equal(h.browser.opened.length, 1, 'the answer is remembered');
});

test('a page whose only blocked file is one it does not wait on keeps its pictures and names the host', async () => {
  const h = makeHarness({ browserOptions: { blockedHosts: () => ['stats.example'], waitsOnBlocked: () => false } });
  h.write('index.html', PAGE);

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [h.edit('site.css', 'a{color:red}', 'a{color:blue}')] });
  assert.equal(result.record.pages[0].state, 'ready');
  assert.deepEqual(result.record.pages[0].blockedHosts, ['stats.example']);
});

test('an entrance animation is over before the picture is taken', async () => {
  const h = makeHarness({ browserOptions: { frame: (_options, shot) => (shot === 1 ? { mark: ' (fading in)' } : null) } });
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'a{color:red}', 'a{color:blue}');

  const page = (await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] })).record.pages[0];
  assert.equal(page.state, 'ready');
  assert.equal(pictureText(page.afterUrl).includes('fading in'), false);
  assert.equal(pictureText(page.beforeUrl).includes('fading in'), false);
});

test('a page that only moves on its own has no pictures; a change that stands out from the motion keeps them', async () => {
  // Pixel 0 or 1 is the spinner. With `restyle`, the After page also lights pixels 2 to 5.
  const run = async (restyle) => {
    const h = makeHarness({
      browserOptions: {
        frame: (options, shot) => ({
          mark: ` frame ${shot}`,
          thumbnail: thumb(shot % 2, ...(restyle && options.fileOverrides === null ? [2, 3, 4, 5] : [])),
        }),
      },
    });
    h.write('index.html', PAGE);
    const change = h.edit('site.css', 'a{color:red}', 'a{color:blue}');
    return (await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] })).record.pages;
  };

  assert.deepEqual(await run(false), []);
  assert.deepEqual((await run(true)).map((page) => page.state), ['ready']);
});

test('motion is measured apart from change, and pictures that cannot be compared never count as a change', () => {
  const still = (lit) => ({ thumb: thumb(...lit), earlierThumb: null });
  // The Before spinner sits on pixel 2; the After spinner went from 0 to 1.
  assert.deepEqual(measureChange(still([2]), { thumb: thumb(1), earlierThumb: thumb(0) }), { moving: 2, changed: 1 });
  assert.equal(changeShowsThroughMotion(still([2]), { thumb: thumb(1), earlierThumb: thumb(0) }), false);
  assert.equal(changeShowsThroughMotion(still([]), still([0, 1])), true);
  assert.equal(measureChange(still([0]), { thumb: null, earlierThumb: null }), null);
  assert.equal(changeShowsThroughMotion(still([0]), { thumb: thumb(1), earlierThumb: {} }), false);
  assert.equal(changeShowsThroughMotion(still([0]), { thumb: { width: 2, height: 1, bitmap: Buffer.alloc(8) }, earlierThumb: null }), false);
});

test('a page whose After render fails keeps its Before picture', async () => {
  const h = makeHarness({ browserOptions: { failOpen: (options) => options.fileOverrides === null } });
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'a{}', 'b{}');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  const page = result.record.pages[0];
  assert.equal(page.state, 'after_failed');
  assert.equal(page.afterUrl, null);
  assert.match(pictureText(page.beforeUrl), /a\{\}/);
});

test('a page is dropped when its Before needs text nobody saved', async () => {
  const h = makeHarness();
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'a{}', 'b{}');
  h.snapshots.clear();

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  assert.deepEqual(result.record.pages, []);
  // The empty answer is remembered: asking again opens no window.
  const opened = h.browser.opened.length;
  await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  assert.equal(h.browser.opened.length, opened);
});

test('a page that only mentions a changed file name, and never loads it, is dropped', async () => {
  const h = makeHarness();
  h.write('about.html', '<link href="notes.js">');
  h.write('notes.js', '// see css/site.css');
  const change = h.edit('css/site.css', 'a{}', 'b{}');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  assert.deepEqual(result.record.pages, []);
});

test('no free hidden window answers busy and stores nothing', async () => {
  const h = makeHarness({ browserOptions: { busy: () => true } });
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'a{}', 'b{}');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  assert.deepEqual(result, { ok: false, reason: 'busy' });
  assert.deepEqual((await h.service.list({ sessionId: 's1' })).records, []);
});

test('at most three pages are pictured', async () => {
  const h = makeHarness();
  for (const name of ['a', 'b', 'c', 'd', 'e']) h.write(`${name}.html`, PAGE);
  const change = h.edit('site.css', 'a{}', 'b{}');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  assert.deepEqual(result.record.pages.map((page) => page.path), ['a.html', 'b.html', 'c.html']);
});

test('bad requests, files that are not web files, and unsafe paths are refused quietly', async () => {
  const h = makeHarness();
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'a{}', 'b{}');

  assert.deepEqual(await h.service.capture({ turnId: 't1', files: [change] }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await h.service.capture({ sessionId: 's1', files: [change] }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await h.service.capture({ sessionId: 's\n1', turnId: 't1', files: [change] }), { ok: false, reason: 'invalid' });
  assert.deepEqual(
    await h.service.capture({ sessionId: 's1', turnId: WORKING_TREE_TURN_ID, files: [change] }),
    { ok: false, reason: 'invalid' }
  );
  const quiet = { ok: true, enabled: true, record: null };
  assert.deepEqual(await h.service.capture({ sessionId: 's1', turnId: 't1', files: 'site.css' }), quiet);
  assert.deepEqual(await h.service.capture({
    sessionId: 's1',
    turnId: 't1',
    files: [
      { path: 'src/app.py', status: 'modified' },
      { path: '../outside/site.css', status: 'modified' },
      { path: 'C:\\Windows\\win.css', status: 'modified' },
      null,
    ],
  }), quiet);
  assert.deepEqual(await h.service.capture({ sessionId: 'no-workspace', turnId: 't1', files: [change] }), quiet);
  assert.equal(h.browser.opened.length, 0);
});

test('switched off, nothing is captured or listed', async () => {
  const h = makeHarness({ enabled: () => false });
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'a{}', 'b{}');

  assert.deepEqual(
    await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] }),
    { ok: true, enabled: false, record: null }
  );
  assert.deepEqual(await h.service.captureWorkingTree({ sessionId: 's1' }), { ok: true, enabled: false, record: null });
  assert.deepEqual(await h.service.list({ sessionId: 's1' }), { ok: true, enabled: false, records: [] });
  assert.equal(h.browser.opened.length, 0);
});

test('list returns a session\'s records without the cache signature', async () => {
  const h = makeHarness();
  h.write('index.html', PAGE);
  await h.service.capture({ sessionId: 's1', turnId: 't1', files: [h.edit('site.css', 'a{}', 'b{}')] });
  await h.service.capture({ sessionId: 's2', turnId: 't1', files: [h.edit('site.css', 'b{}', 'c{}')] });

  const listed = await h.service.list({ sessionId: 's2' });
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0].sessionId, 's2');
  assert.equal('signature' in listed.records[0], false);
  assert.deepEqual(await h.service.list({}), { ok: false, reason: 'invalid' });
});

test('the working tree is pictured against the last commit and retaken after an edit', async () => {
  const head = new Map([['site.css', 'h1{color:red}']]);
  const h = makeHarness({
    loadWorkingTree: async () => ({
      files: [{ path: 'site.css', status: 'modified' }, { path: 'README.md', status: 'modified' }],
      readHead: async (relPath) => head.get(relPath) ?? null,
    }),
  });
  h.write('index.html', PAGE);
  h.write('site.css', 'h1{color:blue}');

  const first = await h.service.captureWorkingTree({ sessionId: 's1' });
  assert.equal(first.record.turnId, WORKING_TREE_TURN_ID);
  const page = first.record.pages[0];
  assert.equal(page.state, 'ready');
  assert.match(pictureText(page.beforeUrl), /color:red/);
  assert.match(pictureText(page.afterUrl), /color:blue/);

  await h.service.captureWorkingTree({ sessionId: 's1' });
  assert.equal(h.browser.opened.length, 2);

  h.write('site.css', 'h1{color:green}');
  const retaken = await h.service.captureWorkingTree({ sessionId: 's1' });
  assert.equal(h.browser.opened.length, 4);
  assert.match(pictureText(retaken.record.pages[0].afterUrl), /color:green/);
});

test('the working tree has no pictures without git, and none for a file git cannot read back', async () => {
  const none = makeHarness();
  none.write('index.html', PAGE);
  assert.deepEqual(await none.service.captureWorkingTree({ sessionId: 's1' }), { ok: true, enabled: true, record: null });

  const unreadable = makeHarness({
    loadWorkingTree: async () => ({
      files: [{ path: 'site.css', status: 'modified' }],
      readHead: async () => { throw new Error('git failed'); },
    }),
  });
  unreadable.write('index.html', PAGE);
  unreadable.write('site.css', 'a{}');
  const result = await unreadable.service.captureWorkingTree({ sessionId: 's1' });
  assert.deepEqual(result.record.pages, []);
});

test('a save while the pictures are being taken leaves the turn without pictures', async () => {
  let root = '';
  const h = makeHarness({
    browserOptions: {
      // The Before render is the second one: by then a later turn has written the file again.
      failOpen: (options) => {
        if (options.fileOverrides) fs.writeFileSync(path.join(root, 'site.css'), 'c{}');
        return false;
      },
    },
  });
  root = h.root;
  h.write('index.html', PAGE);
  const change = h.edit('site.css', 'a{}', 'b{}');

  const result = await h.service.capture({ sessionId: 's1', turnId: 't1', files: [change] });
  assert.deepEqual(result, { ok: true, enabled: true, record: null });
  assert.deepEqual((await h.service.list({ sessionId: 's1' })).records, []);
});

test('a save while the working tree is pictured answers busy and the next request retakes it', async () => {
  let root = '';
  let saves = 0;
  const h = makeHarness({
    loadWorkingTree: async () => ({
      files: [{ path: 'site.css', status: 'modified' }],
      readHead: async () => 'h1{color:red}',
    }),
    browserOptions: {
      failOpen: (options) => {
        if (options.fileOverrides && saves === 0) {
          saves += 1;
          fs.writeFileSync(path.join(root, 'site.css'), 'h1{color:darkgreen}');
        }
        return false;
      },
    },
  });
  root = h.root;
  h.write('index.html', PAGE);
  h.write('site.css', 'h1{color:blue}');

  assert.deepEqual(await h.service.captureWorkingTree({ sessionId: 's1' }), { ok: false, reason: 'busy' });
  assert.deepEqual((await h.service.list({ sessionId: 's1' })).records, []);
  const retaken = await h.service.captureWorkingTree({ sessionId: 's1' });
  assert.match(pictureText(retaken.record.pages[0].afterUrl), /darkgreen/);
});

test('a Before render that breaks is answered failed, not remembered as no pictures', async () => {
  let broken = true;
  const h = makeHarness({ browserOptions: { failOpen: (options) => broken && options.fileOverrides !== null } });
  h.write('index.html', PAGE);
  const payload = { sessionId: 's1', turnId: 't1', files: [h.edit('site.css', 'a{}', 'b{}')] };

  assert.deepEqual(await h.service.capture(payload), { ok: false, reason: 'failed' });
  assert.deepEqual((await h.service.list({ sessionId: 's1' })).records, []);
  broken = false;
  assert.equal((await h.service.capture(payload)).record.pages[0].state, 'ready');
});

test('a changed picture file is never read back as text: the page that shows it has no pictures', async () => {
  const asked = [];
  const h = makeHarness({
    loadWorkingTree: async () => ({
      files: [{ path: 'logo.png', status: 'modified' }, { path: 'site.css', status: 'modified' }],
      readHead: async (relPath) => { asked.push(relPath); return 'a{}'; },
    }),
  });
  h.write('index.html', '<link href="site.css"><link href="logo.png">');
  h.write('site.css', 'b{}');
  h.write('logo.png', 'new bytes');

  const result = await h.service.captureWorkingTree({ sessionId: 's1' });
  assert.deepEqual(asked, ['site.css']);
  const before = h.browser.opened.find((options) => options.fileOverrides);
  assert.deepEqual(before.fileOverrides.find((entry) => entry.id === 'logo.png'), {
    id: 'logo.png', filePath: path.join(h.root, 'logo.png'), poison: true,
  });
  assert.deepEqual(result.record.pages, []);
});

test('a retake asked for while a capture runs is its own run, not that run\'s answer', async () => {
  let payload = null;
  let retaking = null;
  const h = makeHarness({
    browserOptions: {
      // Asked from inside the first run's first render, so that run is certainly in flight.
      failOpen: () => {
        if (!retaking) retaking = h.service.capture({ ...payload, force: true });
        return false;
      },
    },
  });
  h.write('index.html', PAGE);
  payload = { sessionId: 's1', turnId: 't1', files: [h.edit('site.css', 'a{}', 'b{}')] };

  const first = await h.service.capture(payload);
  const retake = await retaking;
  assert.equal(h.browser.opened.length, 4);
  assert.equal(first.record.pages[0].state, 'ready');
  assert.equal(retake.record.pages[0].state, 'ready');
});
