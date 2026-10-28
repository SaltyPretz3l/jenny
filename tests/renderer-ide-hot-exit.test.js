'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeHotExit } = require('../renderer/features/renderer-ide-hot-exit');

// Manual timer host: setInterval/clearInterval driven by advance(ms). Microtasks are
// flushed after each fire so async bridge calls settle between ticks.
function createTimers() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map();
  return {
    setInterval(fn, ms) { const id = nextId++; intervals.set(id, { fn, ms, next: now + ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout() { throw new Error('hot exit must not use setTimeout'); },
    clearTimeout() {},
    get active() { return intervals.size; },
    now: () => now,
    async advance(total) {
      const end = now + total;
      for (;;) {
        let due = null;
        for (const entry of intervals.values()) {
          if (entry.next <= end && (due === null || entry.next < due.next)) due = entry;
        }
        if (!due) break;
        now = due.next;
        due.next += due.ms;
        due.fn();
        await flush();
      }
      now = end;
    },
  };
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function createModel(doc) {
  return {
    ops: [],
    getFullModelRange: () => ({ full: true }),
    pushEditOperations(sel, ops) {
      this.ops.push(ops);
      doc.value = ops[0].text;
      // `saved` = the text on disk when given (a restore can match it); else any edit dirties.
      doc.dirty = doc.saved === undefined || doc.value !== doc.saved;
      doc.alt += 1;
      return null;
    },
  };
}

function createHarness(options = {}) {
  const timers = createTimers();
  const docs = new Map();
  const ide = { openTabs: [], activeTabPath: '', staleByPath: {} };
  const backupCalls = { write: [], remove: [], list: 0, read: [] };
  const store = new Map(options.stored || []);
  const results = { write: null, remove: null, list: null, read: null };
  const backupApi = options.noApi ? null : {
    async write(arg) {
      backupCalls.write.push(arg);
      if (typeof results.write === 'function') return results.write(arg);
      return results.write || { ok: true };
    },
    async remove(arg) {
      backupCalls.remove.push(arg);
      if (typeof results.remove === 'function') return results.remove(arg);
      return results.remove || { ok: true };
    },
    // H2: list answers ids (stat only); read takes an id and answers the parsed record.
    async list() {
      backupCalls.list += 1;
      if (results.list) return results.list;
      return { ok: true, entries: [...store.values()].map((entry) => ({ id: `id:${entry.path}`, updatedAt: entry.updatedAt, bytes: entry.content.length })) };
    },
    async read(arg) {
      backupCalls.read.push(arg);
      if (results.read) return results.read;
      return { ok: true, entry: store.get(String(arg.id || '').slice(3)) || null };
    },
  };
  // H1: main's root context, captured by the module per epoch and sent with every mutation.
  const rootContext = { rootPath: 'C:/ws', rootId: 'root_a', generation: 1, phase: 'ready' };
  const rootApi = { captures: 0, async captureContext() { rootApi.captures += 1; return { ...rootContext }; } };
  const flags = { ide_hot_exit: options.flagOn !== false };
  const opened = [];
  const activated = [];
  const toasts = [];
  const logs = [];
  const stale = [];
  const pinned = [];
  const editorHost = {
    hasDocument: (p) => docs.has(p),
    isDirty: (p) => docs.get(p)?.dirty === true,
    getDocumentKind: (p) => docs.get(p)?.kind || '',
    getAltVersionId: (p) => docs.get(p)?.alt ?? 0,
    getValue: (p) => docs.get(p)?.value ?? '',
    getMtime: (p) => docs.get(p)?.mtime ?? 0,
    getModel: (p) => docs.get(p)?.model || null,
    isLargeFile: (p) => docs.get(p)?.large === true,
  };
  function addDoc(path, extra = {}) {
    const { noModel, ...rest } = extra;
    const doc = { kind: 'file', dirty: false, alt: 1, value: 'disk text', mtime: 100, large: false, ...rest };
    if (!noModel) doc.model = createModel(doc);
    docs.set(path, doc);
    if (!ide.openTabs.some((t) => t.path === path)) ide.openTabs.push({ path, kind: 'file' });
    return doc;
  }
  const hot = createIdeHotExit({
    getIde: () => ide,
    editorHost,
    ideStateUtils: { setTabStale: (target, path, value) => { stale.push([path, value]); target.staleByPath[path] = value; } },
    getFileOperations: () => ({ pinConflict: (path) => { pinned.push(path); return true; } }),
    getBackupApi: () => backupApi,
    getRootApi: () => (options.noRootApi ? null : rootApi),
    getFeatureFlags: () => flags,
    onOpenFile: async (path) => {
      opened.push(path);
      if (options.openFails?.includes(path)) throw Object.assign(new Error('x'), { code: 'CMP-IDE-0001' });
      if (!docs.has(path)) addDoc(path, options.openedDoc?.[path] || {});
      ide.activeTabPath = path;
    },
    activateTab: (path) => { activated.push(path); ide.activeTabPath = path; },
    showToastMessage: options.noToast ? undefined : (message) => toasts.push(message),
    appendClientLog: (level, code, detail) => logs.push([level, code, detail]),
    timers,
    windowRef: {},
  });
  return { hot, timers, docs, ide, backupCalls, store, results, flags, opened, activated, toasts, logs, stale, pinned, addDoc, rootContext, rootApi };
}

const SCOPE_A = { expectedRootId: 'root_a', expectedGeneration: 1 };

function edit(doc, value, mtime) {
  doc.dirty = true;
  doc.alt += 1;
  doc.value = value;
  if (mtime !== undefined) doc.mtime = mtime;
}

test('a dirty buffer unchanged for 1.5 s is written once to workspaceBackup', async () => {
  const h = createHarness();
  const doc = h.addDoc('src/a.js');
  h.hot.bind();
  edit(doc, 'edited', 555);
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, 1);
  assert.deepEqual(h.backupCalls.write[0], { path: 'src/a.js', content: 'edited', diskMtimeMs: 555, ...SCOPE_A });
  h.hot.dispose();
});

test('discardBackups ("Close without saving" at a window exit) removes the backups and never re-backs-up that buffer', async () => {
  const h = createHarness();
  const doc = h.addDoc('src/a.js');
  h.hot.bind();
  edit(doc, 'edited');
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, 1);
  assert.equal(await h.hot.discardBackups(['src/a.js']), true);
  assert.deepEqual(h.backupCalls.remove, [{ path: 'src/a.js', ...SCOPE_A }]);
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, 1, 'the discarded buffer (still dirty while the window goes) is not written again');
  edit(doc, 'kept typing'); // the exit did not happen after all
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, 2, 'a later edit is backed up again');
  h.hot.dispose();
});

test('H1: mutations carry the root id and generation captured for the epoch; a root switch captures again', async () => {
  const h = createHarness();
  const doc = h.addDoc('a.js');
  h.hot.bind();
  edit(doc, 'one');
  await h.timers.advance(4500);
  assert.deepEqual(h.backupCalls.write.map((call) => [call.expectedRootId, call.expectedGeneration]), [['root_a', 1]]);
  assert.equal(h.rootApi.captures, 1, 'captured once per epoch, not per write');
  // Main commits root B; the module hears the commit and captures the new context.
  Object.assign(h.rootContext, { rootId: 'root_b', generation: 2 });
  h.hot.handleWorkspaceRootCommitted();
  edit(doc, 'two');
  await h.timers.advance(4500);
  assert.deepEqual(h.backupCalls.write.at(-1), { path: 'a.js', content: 'two', diskMtimeMs: 100, expectedRootId: 'root_b', expectedGeneration: 2 });
  doc.dirty = false;
  await h.timers.advance(1500);
  assert.deepEqual(h.backupCalls.remove.at(-1), { path: 'a.js', expectedRootId: 'root_b', expectedGeneration: 2 });
  h.hot.dispose();
});

test('H1: a scope refusal (a rolled-back switch moved the generation) recaptures and resends', async () => {
  const h = createHarness();
  h.results.write = (arg) => (arg.expectedGeneration === h.rootContext.generation
    ? { ok: true }
    : { ok: false, code: 'CMP-WSBACKUP-0002' });
  const doc = h.addDoc('a.js');
  h.hot.bind();
  edit(doc, 'one');
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, 1);
  // The switch rolled back: main is on root_a again with generation 2, and no commit event.
  h.rootContext.generation = 2;
  edit(doc, 'two');
  await h.timers.advance(4500);
  assert.deepEqual(h.backupCalls.write.map((call) => call.expectedGeneration), [1, 1, 2], 'the stale scope is refused once, then resent');
  assert.equal(h.rootApi.captures, 2, 'the refusal drops the cached scope');
  assert.deepEqual(h.backupCalls.write.at(-1), { path: 'a.js', content: 'two', diskMtimeMs: 100, expectedRootId: 'root_a', expectedGeneration: 2 });
  h.hot.dispose();
});

test('H1: without a ready root context nothing is written or removed', async () => {
  const h = createHarness({ noRootApi: true });
  edit(h.addDoc('a.js'), 'x');
  h.hot.bind();
  await h.timers.advance(6000);
  assert.equal(h.backupCalls.write.length, 0, 'fails closed without a root to scope the write');
  const switching = createHarness();
  switching.rootContext.phase = 'switching';
  edit(switching.addDoc('a.js'), 'x');
  switching.hot.bind();
  await switching.timers.advance(3000);
  assert.equal(switching.backupCalls.write.length, 0);
  switching.rootContext.phase = 'ready';
  await switching.timers.advance(3000);
  assert.equal(switching.backupCalls.write.length, 1, 'a later tick captures the settled root');
  h.hot.dispose();
  switching.hot.dispose();
});

test('H3: two refused writes for a full store toast once', async () => {
  const h = createHarness();
  h.results.write = { ok: false, code: 'CMP-WSBACKUP-0006' };
  const a = h.addDoc('a.js');
  const b = h.addDoc('b.js');
  h.hot.bind();
  edit(a, 'x');
  edit(b, 'y');
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, 2);
  edit(a, 'xx');
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, 3);
  assert.equal(h.toasts.length, 1, 'one toast per session');
  assert.match(h.toasts[0], /full/);
  h.hot.handleWorkspaceRootCommitted();
  edit(b, 'yy');
  await h.timers.advance(4500);
  assert.equal(h.toasts.length, 1, 'a root switch does not repeat it');
  // Other refusals stay silent.
  const quiet = createHarness();
  quiet.results.write = { ok: false, code: 'CMP-WSBACKUP-0005' };
  edit(quiet.addDoc('a.js'), 'x');
  quiet.hot.bind();
  await quiet.timers.advance(4500);
  assert.equal(quiet.toasts.length, 0);
  h.hot.dispose();
  quiet.hot.dispose();
});

test('typing keeps postponing the write until the buffer settles for 1.5 s', async () => {
  const h = createHarness();
  const doc = h.addDoc('a.js');
  h.hot.bind();
  for (let i = 0; i < 6; i += 1) {
    edit(doc, `v${i}`);
    await h.timers.advance(750);
  }
  assert.equal(h.backupCalls.write.length, 0, 'edits every tick never settle');
  await h.timers.advance(3000);
  assert.equal(h.backupCalls.write.length, 1);
  assert.equal(h.backupCalls.write[0].content, 'v5');
  h.hot.dispose();
});

test('an unchanged version is written once, a new version is written again', async () => {
  const h = createHarness();
  const doc = h.addDoc('a.js');
  h.hot.bind();
  edit(doc, 'one');
  await h.timers.advance(6000);
  assert.equal(h.backupCalls.write.length, 1);
  edit(doc, 'two');
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, 2);
  assert.equal(h.backupCalls.write[1].content, 'two');
  h.hot.dispose();
});

test('large files, non-file kinds and clean documents are never backed up', async () => {
  const h = createHarness();
  edit(h.addDoc('big.txt', { large: true }), 'x');
  edit(h.addDoc('diff.txt', { kind: 'diff' }), 'x');
  h.addDoc('clean.txt');
  h.hot.bind();
  await h.timers.advance(6000);
  assert.equal(h.backupCalls.write.length, 0);
  h.hot.dispose();
});

test('a saved buffer removes its backup once; a refusal keeps state and retries', async () => {
  const h = createHarness();
  const doc = h.addDoc('a.js');
  h.hot.bind();
  edit(doc, 'x');
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, 1);
  doc.dirty = false; // saved
  h.results.remove = { ok: false, code: 'CMP-WSBACKUP-0001' };
  await h.timers.advance(1500);
  assert.equal(h.backupCalls.remove.length, 2, 'retried on the next tick after a refusal');
  h.results.remove = { ok: true };
  await h.timers.advance(1500);
  const afterOk = h.backupCalls.remove.length;
  assert.equal(afterOk, 3);
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.remove.length, afterOk, 'forgotten after a successful remove');
  assert.deepEqual(h.backupCalls.remove[0], { path: 'a.js', ...SCOPE_A });
  h.hot.dispose();
});

test('closing a dirty tab removes its backup', async () => {
  const h = createHarness();
  const doc = h.addDoc('a.js');
  h.hot.bind();
  edit(doc, 'x');
  await h.timers.advance(4500);
  h.ide.openTabs.length = 0;
  h.docs.delete('a.js');
  await h.timers.advance(1500);
  assert.equal(h.backupCalls.remove.length, 1);
  assert.equal(h.backupCalls.remove[0].path, 'a.js');
  h.hot.dispose();
});

test('a refused write is not resent until the buffer changes, and is never recorded as backed', async () => {
  const h = createHarness();
  const doc = h.addDoc('a.js');
  h.results.write = { ok: false, code: 'CMP-WSBACKUP-0005' };
  h.hot.bind();
  edit(doc, 'x');
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, 1, 'the same buffer is not retried every tick');
  h.results.write = { ok: true };
  const before = h.backupCalls.write.length;
  edit(doc, 'xy');
  await h.timers.advance(3000);
  assert.ok(h.backupCalls.write.length > before, 'a changed buffer is written again');
  const settled = h.backupCalls.write.length;
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, settled, 'no more writes once recorded');
  h.hot.dispose();
});

test('at most one write is in flight per path and four per tick', async () => {
  const h = createHarness();
  let release;
  h.results.write = () => new Promise((resolve) => { release = () => resolve({ ok: true }); });
  const doc = h.addDoc('a.js');
  h.hot.bind();
  edit(doc, 'x');
  await h.timers.advance(6000);
  assert.equal(h.backupCalls.write.length, 1, 'second tick does not start a duplicate');
  release();
  await flush();
  h.hot.dispose();

  const many = createHarness();
  for (let i = 0; i < 6; i += 1) edit(many.addDoc(`f${i}.js`), 'x');
  many.hot.bind();
  await many.timers.advance(1500); // two ticks: version noted, then settled? settled needs >= 1500ms
  await many.timers.advance(750);
  assert.equal(many.backupCalls.write.length, 4);
  await many.timers.advance(750);
  assert.equal(many.backupCalls.write.length, 6);
  many.hot.dispose();
});

test('a root switch keeps backups, forgets state and drops late results', async () => {
  const h = createHarness();
  let release;
  h.results.write = () => new Promise((resolve) => { release = () => resolve({ ok: true }); });
  const doc = h.addDoc('a.js');
  h.hot.bind();
  edit(doc, 'x');
  await h.timers.advance(4500);
  assert.equal(h.backupCalls.write.length, 1);
  h.hot.handleWorkspaceRootCommitted();
  release();
  await flush();
  assert.equal(h.backupCalls.remove.length, 0, 'the old root backups survive');
  // Late result was ignored: new epoch state has no record, so a clean doc triggers no removal.
  doc.dirty = false;
  await h.timers.advance(3000);
  assert.equal(h.backupCalls.remove.length, 0);
  h.hot.dispose();
});

test('a late remove result after a root switch is ignored', async () => {
  const h = createHarness();
  const doc = h.addDoc('a.js');
  h.hot.bind();
  edit(doc, 'x');
  await h.timers.advance(4500);
  let release;
  h.results.remove = () => new Promise((resolve) => { release = () => resolve({ ok: true }); });
  doc.dirty = false;
  await h.timers.advance(750);
  assert.equal(h.backupCalls.remove.length, 1);
  h.hot.handleWorkspaceRootCommitted();
  release();
  await flush();
  await h.timers.advance(3000);
  assert.equal(h.backupCalls.remove.length, 1);
  h.hot.dispose();
});

test('inert without the bridge or with the flag off', async () => {
  const noApi = createHarness({ noApi: true });
  edit(noApi.addDoc('a.js'), 'x');
  noApi.hot.bind();
  assert.equal(noApi.timers.active, 0, 'no tick without the bridge');
  await noApi.hot.restore();
  assert.equal(noApi.opened.length, 0);

  const off = createHarness({ flagOn: false, stored: [['a.js', { path: 'a.js', content: 'x', diskMtimeMs: 100, updatedAt: 1 }]] });
  edit(off.addDoc('a.js'), 'x');
  off.hot.bind();
  assert.equal(off.timers.active, 0, 'no tick with the flag off');
  await off.hot.restore();
  assert.equal(off.backupCalls.list, 0);
  await off.timers.advance(6000);
  assert.equal(off.backupCalls.write.length, 0);

  const partial = createHarness();
  const half = createIdeHotExit({
    getIde: () => partial.ide,
    editorHost: {},
    getBackupApi: () => ({ write() {}, remove() {} }),
    getFeatureFlags: () => ({}),
    timers: partial.timers,
  });
  half.bind();
  assert.equal(partial.timers.active, 0, 'a bridge missing list/read stays inert');
});

test('the flag is read live: turning it off stops the tick work', async () => {
  const h = createHarness();
  const doc = h.addDoc('a.js');
  h.hot.bind();
  edit(doc, 'x');
  h.flags.ide_hot_exit = false;
  await h.timers.advance(6000);
  assert.equal(h.backupCalls.write.length, 0);
  h.hot.dispose();
});

test('dispose stops the tick', async () => {
  const h = createHarness();
  edit(h.addDoc('a.js'), 'x');
  h.hot.bind();
  assert.equal(h.timers.active, 1);
  h.hot.dispose();
  assert.equal(h.timers.active, 0);
  await h.timers.advance(6000);
  assert.equal(h.backupCalls.write.length, 0);
  h.hot.bind();
  h.hot.bind();
  assert.equal(h.timers.active, 1, 'bind is idempotent');
  h.hot.dispose();
});

test('restore opens a missing tab, replaces text as one undoable edit and marks it dirty', async () => {
  const h = createHarness({
    stored: [['b.js', { path: 'b.js', content: 'restored text', diskMtimeMs: 100, updatedAt: 5 }]],
    openedDoc: { 'b.js': { mtime: 100 } },
  });
  h.addDoc('active.js');
  h.ide.activeTabPath = 'active.js';
  await h.hot.restore();
  assert.deepEqual(h.opened, ['b.js']);
  const doc = h.docs.get('b.js');
  assert.equal(doc.model.ops.length, 1, 'one edit operation batch');
  assert.deepEqual(doc.model.ops[0], [{ range: { full: true }, text: 'restored text' }]);
  assert.equal(doc.dirty, true);
  assert.deepEqual(h.stale, [], 'mtime matches: not stale');
  assert.deepEqual(h.pinned, [], 'and its next save is not forced to conflict');
  assert.deepEqual(h.activated, ['active.js'], 'the previously active tab is re-activated');
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0], /1/);
  // The restored version is recorded as backed up, so it is not rewritten at once.
  h.hot.bind();
  await h.timers.advance(6000);
  assert.equal(h.backupCalls.write.length, 0);
  h.hot.dispose();
});

test('restore marks the tab stale when the disk mtime changed and says so in the toast', async () => {
  const h = createHarness({
    stored: [['a.js', { path: 'a.js', content: 'mine', diskMtimeMs: 50, updatedAt: 5 }]],
  });
  h.addDoc('a.js', { mtime: 100 });
  await h.hot.restore();
  assert.deepEqual(h.stale, [['a.js', true]]);
  assert.deepEqual(h.pinned, ['a.js'], 'the next save conflicts instead of overwriting the newer disk copy');
  assert.equal(h.opened.length, 0, 'an already loaded document is not reopened');
  // A backup equal to the newer disk text (a checkout that only touched the mtime) restores
  // clean: no conflict pin, or the next real edit could never be saved.
  const same = createHarness({ stored: [['c.js', { path: 'c.js', content: 'disk text', diskMtimeMs: 50, updatedAt: 5 }]] });
  same.addDoc('c.js', { mtime: 100, saved: 'disk text' });
  await same.hot.restore();
  assert.equal(same.docs.get('c.js').dirty, false);
  assert.deepEqual(same.pinned, []);
  assert.match(h.toasts[0], /changed on disk/);
});

test('restore skips already-dirty documents and the textarea fallback, keeping their backups', async () => {
  const h = createHarness({
    stored: [
      ['dirty.js', { path: 'dirty.js', content: 'old backup', diskMtimeMs: 100, updatedAt: 9 }],
      ['plain.js', { path: 'plain.js', content: 'fallback', diskMtimeMs: 100, updatedAt: 8 }],
    ],
  });
  edit(h.addDoc('dirty.js'), 'live edit');
  h.addDoc('plain.js', { noModel: true });
  await h.hot.restore();
  assert.equal(h.docs.get('dirty.js').value, 'live edit');
  assert.equal(h.docs.get('plain.js').value, 'disk text');
  assert.equal(h.backupCalls.remove.length, 0, 'restore never removes backups');
  assert.equal(h.toasts.length, 0, 'nothing restored, no toast');
});

test('restore keeps the backup and logs a code when the open fails', async () => {
  const h = createHarness({
    stored: [['gone.js', { path: 'gone.js', content: 'secret body', diskMtimeMs: 1, updatedAt: 1 }]],
    openFails: ['gone.js'],
  });
  await h.hot.restore();
  assert.equal(h.backupCalls.remove.length, 0);
  assert.equal(h.toasts.length, 0);
  const serialized = JSON.stringify(h.logs);
  assert.ok(h.logs.some(([level]) => level === 'WARN'));
  assert.ok(!serialized.includes('secret body'), 'content is never logged');
});

test('restore is idempotent per epoch and runs again after a root switch', async () => {
  const h = createHarness({ stored: [['a.js', { path: 'a.js', content: 'x', diskMtimeMs: 100, updatedAt: 1 }]] });
  h.addDoc('a.js');
  await h.hot.restore();
  await h.hot.restore();
  assert.equal(h.backupCalls.list, 1);
  h.hot.handleWorkspaceRootCommitted();
  await h.hot.restore();
  assert.equal(h.backupCalls.list, 2);
});

test('restore handles newest first, caps at 50 and uses a plural toast', async () => {
  const stored = [];
  for (let i = 0; i < 60; i += 1) {
    stored.push([`f${i}.js`, { path: `f${i}.js`, content: `c${i}`, diskMtimeMs: 100, updatedAt: i }]);
  }
  const h = createHarness({ stored });
  await h.hot.restore();
  assert.equal(h.backupCalls.read.length, 50);
  assert.deepEqual(h.backupCalls.read[0], { id: 'id:f59.js' }, 'newest first, read by id');
  assert.match(h.toasts[0], /50/);
});

test('a refused list keeps restore retryable and shows nothing', async () => {
  const h = createHarness({ stored: [['a.js', { path: 'a.js', content: 'x', diskMtimeMs: 100, updatedAt: 1 }]] });
  h.addDoc('a.js');
  h.results.list = { ok: false, code: 'CMP-WSBACKUP-0003' };
  await h.hot.restore();
  assert.equal(h.toasts.length, 0);
  h.results.list = null;
  await h.hot.restore();
  assert.equal(h.toasts.length, 1);
});

test('a root switch during restore ignores the late results', async () => {
  const h = createHarness({ stored: [['a.js', { path: 'a.js', content: 'x', diskMtimeMs: 100, updatedAt: 1 }]] });
  const doc = h.addDoc('a.js');
  const pending = h.hot.restore();
  h.hot.handleWorkspaceRootCommitted();
  await pending;
  assert.equal(doc.dirty, false);
  assert.equal(h.toasts.length, 0);
});
