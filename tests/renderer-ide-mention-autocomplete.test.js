'use strict';

// Coverage for renderer/features/renderer-ide-mention-autocomplete.js — the
// @file composer autocomplete. Direct JSDOM, injected deps; no IDE harness.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createMentionAutocomplete,
  forwardClientLog,
} = require('../renderer/features/renderer-ide-mention-autocomplete');

const FILES = ['src/app.js', 'src/deep/util.js', 'README.md'];

const PALETTE = {
  scoreMatch(path, query) {
    const i = path.toLowerCase().indexOf(query.toLowerCase());
    return i === -1 ? null : { score: 1000 - i, ranges: [[i, i + query.length]] };
  },
  highlightRanges(path, _ranges, escape) {
    return escape(path);
  },
};

function flush() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

function buildDom() {
  return new JSDOM(
    '<!doctype html><html><body><textarea id="chatInput"></textarea></body></html>',
    { url: 'https://jenny.local/' }
  );
}

function makeController(dom, { enabled = true, readFile, now, files, listMeta, listAllFiles } = {}) {
  const win = dom.window;
  const doc = win.document;
  const calls = { readFile: [], listAllFiles: 0 };
  const fsApi = {
    listAllFiles: async () => {
      calls.listAllFiles += 1;
      if (typeof listAllFiles === 'function') {
        return listAllFiles();
      }
      return {
        files: typeof files === 'function' ? files() : [...FILES],
        truncated: false,
        // JCA-001: the real service pins every listing to a root lease and
        // returns { rootId, generation }; tests opt in via listMeta().
        ...(typeof listMeta === 'function' ? listMeta() : {}),
      };
    },
    readFile: async ({ path }) => {
      calls.readFile.push(path);
      if (typeof readFile === 'function') {
        return readFile(path);
      }
      return { path, content: `BODY OF ${path}`, eol: 'lf' };
    },
  };
  const controller = createMentionAutocomplete({
    document: doc,
    window: win,
    getInput: () => doc.getElementById('chatInput'),
    getMountEl: () => doc.body,
    getWorkspaceFs: () => fsApi,
    paletteUtils: PALETTE,
    isEnabled: () => enabled,
    now: typeof now === 'function' ? now : undefined,
  });
  return { controller, win, doc, calls };
}

function typeTrigger(win, doc, text) {
  const input = doc.getElementById('chatInput');
  input.value = text;
  input.selectionStart = text.length;
  input.selectionEnd = text.length;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  return input;
}

function popover(doc) {
  return doc.querySelector('.ide-mention-popover');
}

function rowPaths(doc) {
  return [...doc.querySelectorAll('[data-ide-mention-path]')].map((r) => r.getAttribute('data-ide-mention-path'));
}

test('typing @partial opens a popover of scored workspace files', async () => {
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom);
  controller.attach();

  typeTrigger(win, doc, '@app');
  await flush();

  assert.ok(popover(doc), 'popover mounted');
  assert.equal(popover(doc).classList.contains('hidden'), false);
  assert.ok(rowPaths(doc).includes('src/app.js'), 'app.js matched');
  assert.ok(!rowPaths(doc).includes('README.md'), 'non-matches excluded');
});

test('Enter accepts the selected file, rewrites the token, and records the mention', async () => {
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom);
  controller.attach();

  const input = typeTrigger(win, doc, 'see @app');
  await flush();

  const ev = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'Enter is claimed by the popover (not the send handler)');
  assert.match(input.value, /^see @src\/app\.js /);
  assert.deepEqual(controller.collectMentionPaths(), ['src/app.js']);
  assert.equal(popover(doc).classList.contains('hidden'), true, 'popover closed after accept');
});

test('clicking a row accepts that file', async () => {
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom);
  controller.attach();
  const input = typeTrigger(win, doc, '@util');
  await flush();

  doc.querySelector('[data-ide-mention-path="src/deep/util.js"]').click();
  assert.match(input.value, /@src\/deep\/util\.js /);
  assert.deepEqual(controller.collectMentionPaths(), ['src/deep/util.js']);
});

test('collectMentionContents resolves each present mention via workspaceFs.readFile', async () => {
  const dom = buildDom();
  const { controller, win, doc, calls } = makeController(dom);
  controller.attach();
  const input = typeTrigger(win, doc, '@app');
  await flush();
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  const contents = await controller.collectMentionContents();
  assert.deepEqual(calls.readFile, ['src/app.js']);
  assert.equal(contents.length, 1);
  assert.equal(contents[0].path, 'src/app.js');
  assert.match(contents[0].content, /BODY OF src\/app\.js/);
});

test('a mention removed from the text is no longer collected', async () => {
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom);
  controller.attach();
  const input = typeTrigger(win, doc, '@app');
  await flush();
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(controller.collectMentionPaths(), ['src/app.js']);

  // User deletes the mention text.
  input.value = 'never mind';
  input.selectionStart = input.value.length;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.deepEqual(controller.collectMentionPaths(), []);
});

test('a readFile failure is skipped, not thrown', async () => {
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom, {
    readFile: () => { throw new Error('CMP-WORKSPACEFS-0012 too large'); },
  });
  controller.attach();
  const input = typeTrigger(win, doc, '@app');
  await flush();
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  const contents = await controller.collectMentionContents();
  assert.deepEqual(contents, []);
});

test('a hung readFile times out and is degraded to a skip (never blocks the send)', async () => {
  // Regression for the send-path hang: a workspace read that never settles must
  // not leave collectMentionContents (and thus the awaiting send) pending forever.
  const dom = buildDom();
  const { controller, win, doc, calls } = makeController(dom, {
    readFile: () => new Promise(() => {}), // never settles
  });
  controller.attach();
  const input = typeTrigger(win, doc, '@app');
  await flush();
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  // Inject a short timeout so the test is fast; production default is 5s.
  const contents = await controller.collectMentionContents({ readTimeoutMs: 20 });
  assert.deepEqual(calls.readFile, ['src/app.js'], 'the read was attempted');
  assert.deepEqual(contents, [], 'a hung mention is excluded, and the promise still resolves');
});

test('a hung mention is skipped while a healthy one in the same batch still resolves', async () => {
  // Per-item isolation: one stalled read must not suppress the other reads.
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom, {
    readFile: (path) => (path === 'src/app.js'
      ? new Promise(() => {}) // src/app.js hangs
      : { path, content: `BODY OF ${path}`, eol: 'lf' }),
  });
  controller.attach();

  const input = typeTrigger(win, doc, '@app');
  await flush();
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  // Append and accept a second, healthy mention.
  input.value = `${input.value}@util`;
  input.selectionStart = input.value.length;
  input.selectionEnd = input.value.length;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await flush();
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(controller.collectMentionPaths(), ['src/app.js', 'src/deep/util.js']);

  const contents = await controller.collectMentionContents({ readTimeoutMs: 20 });
  assert.deepEqual(contents.map((c) => c.path), ['src/deep/util.js'], 'only the healthy read survives');
  assert.match(contents[0].content, /BODY OF src\/deep\/util\.js/);
});

test('collectMentionContents snapshots paths at call time (survives the composer clear)', async () => {
  // Regression for the send-path bug where #chatInput is cleared BEFORE the
  // mention contents are resolved. collectMentionContents must read the paths
  // synchronously at call time, so a clear before the promise settles is safe.
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom);
  controller.attach();
  const input = typeTrigger(win, doc, '@app');
  await flush();
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(controller.collectMentionPaths(), ['src/app.js']);

  const contentsPromise = controller.collectMentionContents();
  // The real composer clears the textarea right after kicking off resolution.
  input.value = '';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  const contents = await contentsPromise;
  assert.equal(contents.length, 1, 'mention content survives the composer clear');
  assert.equal(contents[0].path, 'src/app.js');
});

test('collectMentionPaths requires a token boundary (no prefix false-positive)', async () => {
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom);
  controller.attach();
  const input = typeTrigger(win, doc, '@app');
  await flush();
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  // The recorded token appears only as a non-boundary prefix of a longer path.
  input.value = 'see @src/app.js.map for the sourcemap';
  input.selectionStart = input.value.length;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.deepEqual(controller.collectMentionPaths(), [], 'prefix-only occurrence is not a mention');

  // A real boundary occurrence IS collected.
  input.value = 'see @src/app.js please';
  input.selectionStart = input.value.length;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.deepEqual(controller.collectMentionPaths(), ['src/app.js']);
});

test('the workspace file list is re-indexed after the TTL so new files appear', async () => {
  const dom = buildDom();
  let clock = 1000;
  let listing = [...FILES];
  const { controller, win, doc, calls } = makeController(dom, {
    now: () => clock,
    files: () => [...listing],
  });
  controller.attach();

  typeTrigger(win, doc, '@app');
  await flush();
  assert.equal(calls.listAllFiles, 1, 'first open indexes once');

  // Re-open within the TTL window: the cached list is reused (no refetch).
  typeTrigger(win, doc, '');
  typeTrigger(win, doc, '@app');
  await flush();
  assert.equal(calls.listAllFiles, 1, 'within TTL the cached list is reused');

  // A new file is created and the TTL elapses; the next open re-indexes and shows it.
  listing = [...FILES, 'src/brand-new.js'];
  clock += 5000;
  typeTrigger(win, doc, '@brand');
  await flush();
  assert.equal(calls.listAllFiles, 2, 'after the TTL the list is refetched');
  assert.ok(rowPaths(doc).includes('src/brand-new.js'), 'the newly created file autocompletes');
});

test('JCA-001: a committed root transition clears cache, popover, and accepted mentions within the TTL', async () => {
  // Accept `@src/app.js` under root A, then commit root B BEFORE the file-list
  // TTL elapses. The retained draft still contains the mention token, but the
  // record belongs to root A: nothing may be collected or read under root B.
  const dom = buildDom();
  const { controller, win, doc, calls } = makeController(dom, {
    listMeta: () => ({ rootId: 'root-a', generation: 1 }),
  });
  controller.attach();
  const input = typeTrigger(win, doc, '@app');
  await flush();
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(controller.collectMentionPaths(), ['src/app.js']);

  win.dispatchEvent(new win.CustomEvent('ide:workspace-root-committed', {
    detail: { context: { root_path: 'G:/root-b', root_id: 'root-b', generation: 2 } },
  }));

  assert.equal(controller.isOpen(), false, 'popover closed by the root commit');
  assert.deepEqual(controller.collectMentionPaths(), [], 'root-A mention does not survive the transition');
  const contents = await controller.collectMentionContents();
  assert.deepEqual(contents, [], 'nothing is resolved under root B');
  assert.deepEqual(calls.readFile, [], 'no readFile ever reaches root B for the stale mention');

  // Reopening re-indexes immediately even though the TTL has not elapsed.
  typeTrigger(win, doc, '@app');
  await flush();
  assert.equal(calls.listAllFiles, 2, 'the cached root-A list is not reused after the commit');
});

test('an in-flight old-root listing cannot repopulate the cache after a root transition', async () => {
  const dom = buildDom();
  let resolveRootA;
  const rootAListing = new Promise((resolve) => { resolveRootA = resolve; });
  const listings = [
    () => rootAListing,
    () => Promise.resolve({ files: ['new-only.js'], rootId: 'root-b', generation: 2 }),
  ];
  const { controller, win, doc, calls } = makeController(dom, {
    listAllFiles: () => listings.shift()(),
  });
  controller.attach();

  typeTrigger(win, doc, '@old');
  await flush();
  win.dispatchEvent(new win.CustomEvent('ide:workspace-root-committed'));
  typeTrigger(win, doc, '@new');
  await flush();

  assert.equal(calls.listAllFiles, 2, 'root B starts its own listing while root A is still pending');
  assert.deepEqual(rowPaths(doc), ['new-only.js']);

  resolveRootA({ files: ['old-only.js'], rootId: 'root-a', generation: 1 });
  await flush();
  assert.deepEqual(rowPaths(doc), ['new-only.js'], 'the late root-A result is discarded');
});

test('JCA-001: a mention accepted under root A never resolves the same relative path under root B', async () => {
  // Backstop without the root-commit event: the next listAllFiles reports a
  // different { rootId, generation }, so records bound to root A are pruned
  // even though root B has an identical relative path.
  const dom = buildDom();
  let clock = 1000;
  let root = { rootId: 'root-a', generation: 1 };
  const { controller, win, doc, calls } = makeController(dom, {
    now: () => clock,
    listMeta: () => ({ ...root }),
  });
  controller.attach();
  const input = typeTrigger(win, doc, '@app');
  await flush();
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(controller.collectMentionPaths(), ['src/app.js']);

  // Root B (same file list, same relative paths) becomes current; the TTL
  // elapses and a reopen fetches B's listing.
  root = { rootId: 'root-b', generation: 2 };
  clock += 5000;
  input.value = `${input.value}@util`;
  input.selectionStart = input.value.length;
  input.selectionEnd = input.value.length;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await flush();

  assert.deepEqual(controller.collectMentionPaths(), [], 'the root-A record is pruned by the root-B listing');
  const contents = await controller.collectMentionContents();
  assert.deepEqual(contents, []);
  assert.deepEqual(calls.readFile, [], 'root B content is never attached under the root-A mention');
});

test('with the flag off the module is inert: no popover, no mentions', async () => {
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom, { enabled: false });
  controller.attach();
  typeTrigger(win, doc, '@app');
  await flush();
  assert.equal(popover(doc), null, 'no popover when disabled');
  assert.deepEqual(controller.collectMentionPaths(), []);
});

test('installed appendClientLog forwards to logs.clientAppend, not the dead logs.append', () => {
  // The self-install closure logged via root.jennyShell.logs.append, a bridge
  // method that never existed — 100% of this feature's telemetry was silently
  // dropped. It must route through logs.clientAppend as a { entries,
  // dropped_count } batch instead.
  const clientBatches = [];
  const appendCalls = [];
  const root = {
    jennyShell: {
      logs: {
        append: (...args) => appendCalls.push(args),
        clientAppend: (batch) => clientBatches.push(batch),
      },
    },
  };

  forwardClientLog(root, 'INFO', 'chat.mention_read_failed', { path: 'src/x.js', reason: 'timeout' });

  assert.equal(appendCalls.length, 0, 'the nonexistent logs.append path is never used');
  assert.equal(clientBatches.length, 1);
  const batch = clientBatches[0];
  assert.equal(batch.dropped_count, 0);
  assert.equal(batch.entries.length, 1);
  const entry = batch.entries[0];
  assert.equal(entry.event, 'chat.mention_read_failed');
  assert.equal(entry.level, 'INFO');
  assert.equal(entry.source, 'renderer');
  assert.equal(entry.layer, 'renderer');
  assert.equal(entry.component, 'renderer.ide.mention');
  assert.deepEqual(entry.data, { path: 'src/x.js', reason: 'timeout' });
});

test('appendClientLog forwarding never resurrects logs.append and is a safe no-op without clientAppend', () => {
  const appendCalls = [];
  const root = { jennyShell: { logs: { append: (...args) => appendCalls.push(args) } } };
  assert.doesNotThrow(() => forwardClientLog(root, 'WARN', 'chat.mention_list_failed', { message: 'boom' }));
  assert.equal(appendCalls.length, 0, 'must not fall back to the dead logs.append path');
  assert.doesNotThrow(() => forwardClientLog(null, 'INFO', 'x', {}));
});
