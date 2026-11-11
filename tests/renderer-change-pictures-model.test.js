'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/features/renderer-change-pictures-model');

const { turnFiles, firstPagePath, filesSignature, createPictureCache, WORKING_TREE_TURN_ID } = model;

function change(overrides) {
  return Object.assign({
    turnId: 't1', path: 'index.html', oldPath: '', status: 'modified', beforeHash: 'b0', afterHash: 'a0', sensitive: false,
  }, overrides);
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setImmediate(r));

function record(turnId, extra) {
  return Object.assign({
    sessionId: 's1', turnId, capturedAt: 1000, viewport: 'desktop',
    pages: [{ path: 'index.html', state: 'ready', beforeUrl: 'file:///b.png', afterUrl: 'file:///a.png', width: 100, height: 80 }],
  }, extra);
}

/** A fake bridge that records every call; each method answers from a queue or a default. */
function fakeBridge(answers = {}) {
  const calls = { capture: [], captureWorkingTree: [], list: [] };
  const bridge = {};
  for (const name of Object.keys(calls)) {
    bridge[name] = (payload) => {
      calls[name].push(payload);
      const handler = answers[name];
      if (typeof handler === 'function') return handler(payload, calls[name].length);
      return Promise.resolve(handler || { ok: true, enabled: true, record: null, records: [] });
    };
  }
  return { bridge, calls };
}

function makeCache(bridge, extra) {
  const clock = { t: 100000 };
  const cache = createPictureCache(Object.assign({ getBridge: () => bridge, now: () => clock.t }, extra));
  return { cache, clock };
}

const FILES = [{ path: 'index.html', status: 'modified', beforeHash: 'b0', afterHash: 'a0' }];

/* ── constants ── */

test('extension sets and the working tree id are exact', () => {
  assert.deepEqual([...model.WEB_EXTENSIONS].sort(), [
    '.avif', '.css', '.gif', '.htm', '.html', '.ico', '.jpeg', '.jpg', '.js', '.json', '.mjs',
    '.otf', '.png', '.svg', '.ttf', '.webp', '.woff', '.woff2',
  ]);
  assert.deepEqual([...model.PAGE_EXTENSIONS].sort(), ['.htm', '.html']);
  assert.equal(WORKING_TREE_TURN_ID, '@working-tree');
});

/* ── turnFiles ── */

test('turnFiles keeps only this turn and only web files, case-insensitively', () => {
  const files = turnFiles([
    change({ path: 'a.html' }),
    change({ path: 'notes.txt' }),
    change({ path: 'other.css', turnId: 't2' }),
    change({ path: 'B.CSS' }),
    change({ path: 'dir.d/readme' }),
  ], 't1');
  assert.deepEqual(files.map((f) => f.path), ['a.html', 'B.CSS']);
});

test('turnFiles merges a path into one entry in first-seen order', () => {
  const files = turnFiles([
    change({ path: 'b.css', beforeHash: 'b1', afterHash: 'a1' }),
    change({ path: 'a.html', beforeHash: 'x1', afterHash: 'x2' }),
    change({ path: 'b.css', beforeHash: 'a1', afterHash: 'a2' }),
  ], 't1');
  assert.deepEqual(files, [
    { path: 'b.css', status: 'modified', beforeHash: 'b1', afterHash: 'a2' },
    { path: 'a.html', status: 'modified', beforeHash: 'x1', afterHash: 'x2' },
  ]);
});

test('turnFiles counts an unknown status as modified', () => {
  const [file] = turnFiles([change({ status: 'unknown' }), change({ status: 'weird' })], 't1');
  assert.equal(file.status, 'modified');
});

test('turnFiles drops a path created and deleted in the same turn', () => {
  const files = turnFiles([
    change({ path: 'tmp.html', status: 'created', beforeHash: null }),
    change({ path: 'tmp.html', status: 'deleted', afterHash: null }),
  ], 't1');
  assert.deepEqual(files, []);
});

test('turnFiles reads a first created change as created with no before hash', () => {
  const [file] = turnFiles([
    change({ path: 'new.html', status: 'created', beforeHash: null, afterHash: 'a1' }),
    change({ path: 'new.html', status: 'modified', beforeHash: 'a1', afterHash: 'a2' }),
  ], 't1');
  assert.deepEqual(file, { path: 'new.html', status: 'created', beforeHash: null, afterHash: 'a2' });
});

test('turnFiles reads a last deleted change as deleted with no after hash', () => {
  const [file] = turnFiles([
    change({ path: 'old.html', status: 'modified', beforeHash: 'b1', afterHash: 'a1' }),
    change({ path: 'old.html', status: 'deleted', beforeHash: 'a1', afterHash: 'zzz' }),
  ], 't1');
  assert.deepEqual(file, { path: 'old.html', status: 'deleted', beforeHash: 'b1', afterHash: null });
});

test('turnFiles hides the before hash of a sensitive path', () => {
  const [file] = turnFiles([
    change({ path: 'secret.json', beforeHash: 'b1', afterHash: 'a1' }),
    change({ path: 'secret.json', beforeHash: 'a1', afterHash: 'a2', sensitive: true }),
  ], 't1');
  assert.equal(file.beforeHash, null);
  assert.equal(file.afterHash, 'a2');
});

test('turnFiles turns a rename into a created path plus a deleted old path', () => {
  const files = turnFiles([
    change({ path: 'new.html', oldPath: 'old.html', status: 'modified', beforeHash: 'b9', afterHash: 'a9' }),
  ], 't1');
  assert.deepEqual(files, [
    { path: 'new.html', status: 'created', beforeHash: null, afterHash: 'a9' },
    { path: 'old.html', status: 'deleted', beforeHash: 'b9', afterHash: null },
  ]);
});

test('turnFiles ignores an unchanged oldPath and a rename from a non-web file', () => {
  const same = turnFiles([change({ path: 'a.html', oldPath: 'a.html' })], 't1');
  assert.deepEqual(same.map((f) => [f.path, f.status]), [['a.html', 'modified']]);
  const fromText = turnFiles([change({ path: 'a.html', oldPath: 'a.txt' })], 't1');
  assert.deepEqual(fromText.map((f) => [f.path, f.status]), [['a.html', 'created']]);
});

test('turnFiles survives junk input', () => {
  assert.deepEqual(turnFiles(null, 't1'), []);
  assert.deepEqual(turnFiles([null, 3, { turnId: 't1' }], 't1'), []);
});

/* ── firstPagePath and filesSignature ── */

test('firstPagePath returns the first page file or an empty string', () => {
  assert.equal(firstPagePath([{ path: 'a.css' }, { path: 'p.HTM' }, { path: 'q.html' }]), 'p.HTM');
  assert.equal(firstPagePath([{ path: 'a.css' }]), '');
  assert.equal(firstPagePath(null), '');
});

test('filesSignature is stable, order-independent and sees path, status and after hash', () => {
  const a = { path: 'a.html', status: 'modified', beforeHash: 'x', afterHash: 'h1' };
  const b = { path: 'b.css', status: 'created', beforeHash: null, afterHash: 'h2' };
  assert.equal(filesSignature([a, b]), filesSignature([b, a]));
  assert.notEqual(filesSignature([a, b]), filesSignature([{ ...a, afterHash: 'h9' }, b]));
  assert.notEqual(filesSignature([a, b]), filesSignature([a, { ...b, status: 'modified' }]));
  assert.equal(filesSignature([a]), filesSignature([{ ...a, beforeHash: 'other' }]));
});

/* ── picture cache: requests ── */

test('request stores a record and peek reports it', async () => {
  const { bridge, calls } = fakeBridge({ capture: { ok: true, enabled: true, record: record('t1') } });
  const { cache } = makeCache(bridge);
  assert.deepEqual(cache.peek('s1', 't1'), { record: null, pending: false, answered: false, retakeFailed: false });
  const promise = cache.request('s1', 't1', FILES, { viewport: 'phone' });
  assert.equal(cache.peek('s1', 't1').pending, true);
  const view = await promise;
  assert.equal(view.record.turnId, 't1');
  assert.equal(view.pending, false);
  assert.equal(view.answered, true);
  assert.deepEqual(calls.capture, [{ sessionId: 's1', turnId: 't1', files: FILES, viewport: 'phone', force: false }]);
});

test('request with no files makes no call and marks the turn answered', async () => {
  const { bridge, calls } = fakeBridge();
  const { cache } = makeCache(bridge);
  const view = await cache.request('s1', 't1', []);
  assert.equal(view.answered, true);
  assert.equal(view.record, null);
  assert.equal(calls.capture.length, 0);
});

test('request shares the in-flight promise for the same turn, viewport and signature', async () => {
  const gate = deferred();
  const { bridge, calls } = fakeBridge({ capture: () => gate.promise });
  const { cache } = makeCache(bridge);
  const first = cache.request('s1', 't1', FILES);
  const second = cache.request('s1', 't1', FILES.map((f) => ({ ...f })));
  assert.equal(first, second);
  cache.request('s1', 't1', FILES, { viewport: 'phone' });
  assert.equal(calls.capture.length, 2);
  gate.resolve({ ok: true, enabled: true, record: record('t1') });
  await first;
});

test('request does not ask again for an answered signature unless forced', async () => {
  const { bridge, calls } = fakeBridge({ capture: { ok: true, enabled: true, record: record('t1') } });
  const { cache } = makeCache(bridge);
  await cache.request('s1', 't1', FILES);
  await cache.request('s1', 't1', FILES);
  assert.equal(calls.capture.length, 1);
  await cache.request('s1', 't1', FILES, { force: true });
  assert.equal(calls.capture.length, 2);
  assert.equal(calls.capture[1].force, true);
  const changed = [{ ...FILES[0], afterHash: 'other' }];
  await cache.request('s1', 't1', changed);
  assert.equal(calls.capture.length, 3);
});

test('request asks again when the viewport changes and when it changes back', async () => {
  const { bridge, calls } = fakeBridge({ capture: { ok: true, enabled: true, record: record('t1') } });
  const { cache } = makeCache(bridge);
  await cache.request('s1', 't1', FILES);
  await cache.request('s1', 't1', FILES, { viewport: 'phone' });
  await cache.request('s1', 't1', FILES, { viewport: 'desktop' });
  assert.deepEqual(calls.capture.map((c) => c.viewport), ['desktop', 'phone', 'desktop']);
});

test('a null answer keeps the stored record and flags the failed retake', async () => {
  let n = 0;
  const { bridge } = fakeBridge({
    capture: () => Promise.resolve({ ok: true, enabled: true, record: (n += 1) === 1 ? record('t1') : null }),
  });
  const { cache } = makeCache(bridge);
  await cache.request('s1', 't1', FILES);
  assert.equal(cache.peek('s1', 't1').retakeFailed, false);
  const view = await cache.request('s1', 't1', FILES, { force: true });
  assert.ok(view.record);
  assert.equal(view.retakeFailed, true);
  assert.equal(view.answered, true);
});

test('a null answer with nothing stored is just answered', async () => {
  const { bridge } = fakeBridge({ capture: { ok: true, enabled: true, record: null } });
  const { cache } = makeCache(bridge);
  const view = await cache.request('s1', 't1', FILES);
  assert.deepEqual(view, { record: null, pending: false, answered: true, retakeFailed: false });
});

test('a busy answer leaves the turn unanswered and allows a retry after busyRetryMs', async () => {
  const { bridge, calls } = fakeBridge({ capture: { ok: false, reason: 'busy' } });
  const { cache, clock } = makeCache(bridge, { busyRetryMs: 5000 });
  const view = await cache.request('s1', 't1', FILES);
  assert.equal(view.answered, false);
  clock.t += 4000;
  await cache.request('s1', 't1', FILES);
  assert.equal(calls.capture.length, 1);
  clock.t += 1500;
  await cache.request('s1', 't1', FILES);
  assert.equal(calls.capture.length, 2);
});

test('failed, invalid and rejected bridge calls are answered, never thrown', async () => {
  const { bridge, calls } = fakeBridge({
    capture: (payload) => (payload.turnId === 't1' ? Promise.reject(new Error('boom')) : { ok: false, reason: 'failed' }),
  });
  const { cache } = makeCache(bridge);
  const one = await cache.request('s1', 't1', FILES);
  const two = await cache.request('s1', 't2', FILES);
  assert.equal(one.answered, true);
  assert.equal(two.answered, true);
  await cache.request('s1', 't1', FILES);
  assert.equal(calls.capture.length, 2);
});

test('a bridge method that throws synchronously is answered, not thrown', async () => {
  const cache = createPictureCache({ getBridge: () => ({ capture() { throw new Error('sync'); } }) });
  const view = await cache.request('s1', 't1', FILES);
  assert.equal(view.answered, true);
});

test('an enabled false answer starts the disabled window', async () => {
  const { bridge, calls } = fakeBridge({ capture: { ok: true, enabled: false, record: null } });
  const { cache, clock } = makeCache(bridge, { disabledRetryMs: 30000 });
  assert.equal(cache.isDisabled(), false);
  await cache.request('s1', 't1', FILES);
  assert.equal(cache.isDisabled(), true);
  await cache.request('s1', 't2', FILES);
  await cache.requestWorkingTree('s1');
  assert.equal(calls.capture.length, 1);
  assert.equal(calls.captureWorkingTree.length, 0);
  clock.t += 30001;
  assert.equal(cache.isDisabled(), false);
  await cache.request('s1', 't2', FILES);
  assert.equal(calls.capture.length, 2);
});

/* ── picture cache: working tree ── */

test('requestWorkingTree stores under the working tree id and replaces or clears the record', async () => {
  let n = 0;
  const { bridge, calls } = fakeBridge({
    captureWorkingTree: () => Promise.resolve({
      ok: true, enabled: true, record: (n += 1) === 2 ? null : record(WORKING_TREE_TURN_ID),
    }),
  });
  const { cache } = makeCache(bridge);
  const first = await cache.requestWorkingTree('s1', { viewport: 'phone' });
  assert.equal(first.record.turnId, WORKING_TREE_TURN_ID);
  assert.deepEqual(calls.captureWorkingTree[0], { sessionId: 's1', viewport: 'phone', force: false });
  const second = await cache.requestWorkingTree('s1', { force: true });
  assert.equal(second.record, null);
  assert.equal(cache.peek('s1', WORKING_TREE_TURN_ID).record, null);
});

test('requestWorkingTree makes at most one unforced call per interval and session', async () => {
  const { bridge, calls } = fakeBridge({ captureWorkingTree: { ok: true, enabled: true, record: null } });
  const { cache, clock } = makeCache(bridge, { workingTreeMinIntervalMs: 3000 });
  await cache.requestWorkingTree('s1');
  await cache.requestWorkingTree('s1');
  await cache.requestWorkingTree('s2');
  assert.equal(calls.captureWorkingTree.length, 2);
  clock.t += 3001;
  await cache.requestWorkingTree('s1');
  assert.equal(calls.captureWorkingTree.length, 3);
  await cache.requestWorkingTree('s1', { force: true });
  assert.equal(calls.captureWorkingTree.length, 4);
});

test('an unforced call inside the interval is held back and made once when the interval ends', async () => {
  const { bridge, calls } = fakeBridge({ captureWorkingTree: { ok: true, enabled: true, record: null } });
  const timers = [];
  const { cache, clock } = makeCache(bridge, { workingTreeMinIntervalMs: 3000, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  await cache.requestWorkingTree('s1');
  clock.t += 1000;
  await cache.requestWorkingTree('s1', { viewport: 'phone' });
  await cache.requestWorkingTree('s1', { viewport: 'phone' });
  assert.equal(calls.captureWorkingTree.length, 1);
  assert.deepEqual(timers.map((timer) => timer.ms), [2000], 'one timer, for the rest of the interval');
  clock.t += 2000;
  timers[0].fn();
  await Promise.resolve();
  assert.equal(calls.captureWorkingTree.length, 2);
  assert.equal(calls.captureWorkingTree[1].viewport, 'phone');
});

test('requestWorkingTree shares an in-flight call', async () => {
  const gate = deferred();
  const { bridge, calls } = fakeBridge({ captureWorkingTree: () => gate.promise });
  const { cache } = makeCache(bridge);
  const first = cache.requestWorkingTree('s1');
  const second = cache.requestWorkingTree('s1', { force: true });
  assert.equal(first, second);
  assert.equal(cache.peek('s1', WORKING_TREE_TURN_ID).pending, true);
  gate.resolve({ ok: true, enabled: true, record: record(WORKING_TREE_TURN_ID) });
  await first;
  assert.equal(calls.captureWorkingTree.length, 1);
});

/* ── picture cache: list ── */

test('ensureListed calls list once per session, stores records and marks them answered', async () => {
  const { bridge, calls } = fakeBridge({
    list: { ok: true, enabled: true, records: [record('t1'), record('t2', { capturedAt: 5 }), { bogus: true }] },
  });
  const { cache } = makeCache(bridge);
  const [a, b] = await Promise.all([cache.ensureListed('s1'), cache.ensureListed('s1')]);
  await cache.ensureListed('s1');
  assert.equal(calls.list.length, 1);
  assert.deepEqual(calls.list[0], { sessionId: 's1' });
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(cache.peek('s1', 't1').record.turnId, 't1');
  assert.equal(cache.peek('s1', 't2').answered, true);
  assert.equal(cache.peek('s1', 't3').answered, false);
});

test('ensureListed retries after a failed or not-ok list', async () => {
  let n = 0;
  const { bridge, calls } = fakeBridge({
    list: () => {
      n += 1;
      if (n === 1) return Promise.reject(new Error('down'));
      if (n === 2) return { ok: false, reason: 'failed' };
      return { ok: true, enabled: true, records: [record('t1')] };
    },
  });
  const { cache } = makeCache(bridge);
  assert.equal(await cache.ensureListed('s1'), false);
  assert.equal(await cache.ensureListed('s1'), false);
  assert.equal(await cache.ensureListed('s1'), true);
  assert.equal(calls.list.length, 3);
  assert.ok(cache.peek('s1', 't1').record);
});

test('a list that answers enabled false starts the disabled window', async () => {
  const { bridge } = fakeBridge({ list: { ok: true, enabled: false, records: [] } });
  const { cache } = makeCache(bridge);
  await cache.ensureListed('s1');
  assert.equal(cache.isDisabled(), true);
});

test('a list record does not replace a newer captured record', async () => {
  const gate = deferred();
  const { bridge } = fakeBridge({
    list: () => gate.promise,
    capture: { ok: true, enabled: true, record: record('t1', { capturedAt: '2026-11-09T10:00:05.000Z' }) },
  });
  const { cache } = makeCache(bridge);
  const listed = cache.ensureListed('s1');
  await cache.request('s1', 't1', FILES);
  gate.resolve({ ok: true, enabled: true, records: [record('t1', { capturedAt: '2026-11-09T10:00:00.000Z' })] });
  await listed;
  assert.equal(cache.peek('s1', 't1').record.capturedAt, '2026-11-09T10:00:05.000Z');
});

test('a list record that is newer than the captured one replaces it (dates as the store writes them)', async () => {
  const gate = deferred();
  const { bridge } = fakeBridge({
    list: () => gate.promise,
    capture: { ok: true, enabled: true, record: record('t1', { capturedAt: '2026-11-09T10:00:00.000Z' }) },
  });
  const { cache } = makeCache(bridge);
  const listed = cache.ensureListed('s1');
  await cache.request('s1', 't1', FILES);
  gate.resolve({ ok: true, enabled: true, records: [record('t1', { capturedAt: '2026-11-09T10:00:05.000Z' })] });
  await listed;
  assert.equal(cache.peek('s1', 't1').record.capturedAt, '2026-11-09T10:00:05.000Z');
});

test('a phone pair is kept beside the desktop pair: the panel reads the size last asked for, the chat reads desktop', async () => {
  const { bridge, calls } = fakeBridge({
    capture: (payload) => Promise.resolve({ ok: true, enabled: true, record: record('t1', { viewport: payload.viewport }) }),
  });
  const { cache } = makeCache(bridge);
  await cache.request('s1', 't1', FILES);
  await cache.request('s1', 't1', FILES, { viewport: 'phone' });
  assert.equal(cache.peek('s1', 't1').record.viewport, 'phone');
  assert.equal(cache.peek('s1', 't1', 'desktop').record.viewport, 'desktop');
  assert.equal(cache.peek('s1', 't1', 'phone').record.viewport, 'phone');

  await cache.request('s1', 't1', FILES, { viewport: 'desktop' });
  assert.equal(cache.peek('s1', 't1').record.viewport, 'desktop');
  assert.equal(cache.peek('s1', 't1', 'phone').record.viewport, 'phone');
  assert.deepEqual(calls.capture.map((payload) => payload.viewport), ['desktop', 'phone', 'desktop']);
});

test('listed phone and desktop pairs of one turn are both kept; a phone pair alone leaves desktop unanswered', async () => {
  const { bridge } = fakeBridge({
    list: { ok: true, enabled: true, records: [record('t1', { viewport: 'phone', capturedAt: 2000 }), record('t1'), record('t2', { viewport: 'phone' })] },
  });
  const { cache } = makeCache(bridge);
  await cache.ensureListed('s1');
  assert.equal(cache.peek('s1', 't1').record.viewport, 'desktop');
  assert.equal(cache.peek('s1', 't1', 'phone').record.viewport, 'phone');
  assert.equal(cache.peek('s1', 't1', 'desktop').answered, true);
  // Only a phone pair is stored: the panel shows it, and the chat may still ask for desktop.
  assert.equal(cache.peek('s1', 't2').record.viewport, 'phone');
  assert.equal(cache.peek('s1', 't2', 'desktop').record, null);
  assert.equal(cache.peek('s1', 't2', 'desktop').answered, false);
});

/* ── picture cache: subscribe, eviction, missing bridge ── */

test('subscribe hears pending, answers and unsubscribes cleanly', async () => {
  const { bridge } = fakeBridge({ capture: { ok: true, enabled: true, record: record('t1') } });
  const { cache } = makeCache(bridge);
  const heard = [];
  const off = cache.subscribe((event) => heard.push(event));
  await cache.request('s1', 't1', FILES);
  assert.ok(heard.length >= 2);
  assert.ok(heard.every((e) => e.sessionId === 's1' && e.turnId === 't1'));
  off();
  const count = heard.length;
  await cache.request('s1', 't1', FILES, { force: true });
  assert.equal(heard.length, count);
});

test('a listener that throws does not break the cache', async () => {
  const { bridge } = fakeBridge({ capture: { ok: true, enabled: true, record: record('t1') } });
  const { cache } = makeCache(bridge);
  const heard = [];
  cache.subscribe(() => { throw new Error('listener'); });
  cache.subscribe((event) => heard.push(event.turnId));
  const view = await cache.request('s1', 't1', FILES);
  assert.equal(view.record.turnId, 't1');
  assert.equal(view.pending, false);
  assert.deepEqual(heard, ['t1', 't1'], 'the listener after the throwing one still hears the start and the answer');
});

test('the least recently used session is dropped with all its state', async () => {
  const { bridge, calls } = fakeBridge({
    list: { ok: true, enabled: true, records: [record('t1')] },
    capture: { ok: true, enabled: true, record: record('t1') },
  });
  const { cache } = makeCache(bridge, { maxSessions: 2 });
  await cache.ensureListed('s1');
  await cache.ensureListed('s2');
  cache.peek('s1', 't1'); // s1 is now more recent than s2
  await cache.ensureListed('s3');
  assert.ok(cache.peek('s1', 't1').record);
  assert.equal(cache.peek('s2', 't1').record, null);
  assert.equal(calls.list.length, 3);
  await cache.ensureListed('s2');
  assert.equal(calls.list.length, 4);
});

test('an answer for an evicted session is not stored again', async () => {
  const gate = deferred();
  const { bridge } = fakeBridge({ capture: () => gate.promise });
  const { cache } = makeCache(bridge, { maxSessions: 1 });
  const pending = cache.request('s1', 't1', FILES);
  await cache.ensureListed('s2');
  gate.resolve({ ok: true, enabled: true, record: record('t1') });
  await pending;
  assert.equal(cache.peek('s1', 't1').record, null);
});

test('a missing bridge or a missing method means nothing to show and never throws', async () => {
  const none = createPictureCache({ getBridge: () => undefined });
  assert.equal(await none.ensureListed('s1'), false);
  const view = await none.request('s1', 't1', FILES);
  assert.equal(view.record, null);
  assert.equal(view.answered, true);
  assert.equal((await none.requestWorkingTree('s1')).record, null);

  const partial = createPictureCache({ getBridge: () => ({ list: () => ({ ok: true, enabled: true, records: [] }) }) });
  assert.equal(await partial.ensureListed('s1'), true);
  assert.equal((await partial.request('s1', 't1', FILES)).record, null);

  const throwing = createPictureCache({ getBridge: () => { throw new Error('no bridge'); } });
  assert.equal((await throwing.request('s1', 't1', FILES)).record, null);
  await flush();
});

test('requests without a session or turn id are ignored', async () => {
  const { bridge, calls } = fakeBridge();
  const { cache } = makeCache(bridge);
  assert.equal((await cache.request('', 't1', FILES)).record, null);
  assert.equal((await cache.request('s1', '', FILES)).record, null);
  assert.equal(await cache.ensureListed(''), false);
  assert.equal(calls.capture.length + calls.list.length, 0);
});
