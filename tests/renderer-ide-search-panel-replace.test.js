'use strict';

/* Workspace IDE find-AND-replace integration tests: drives the search panel +
 * its panel-owned replace controller through the shared jsdom harness (real
 * controller, fake workspaceFs bridge). Covers literal + regex replace, the
 * per-match / per-file / Replace-All actions, open-buffer routing, renderer-side
 * undo, EOL preservation, and the toggle/preview UI behaviour. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness,
  dispatchInput,
  pressKey,
  settle,
} = require('./helpers/renderer-ide-harness');

const SEARCH_PERSISTED = {
  openTabs: [],
  activeTabPath: '',
  expandedDirs: [],
  railPanel: 'search',
  railSide: 'right',
  railWidth: 300,
};

function makeHarness(t, files) {
  const harness = createHarness({ bridgeOptions: { files, persisted: SEARCH_PERSISTED } });
  t.after(() => harness.dispose());
  return harness;
}

function panelOf(harness) {
  return harness.getDom().ideRailPanel;
}

function queryInput(harness) {
  return panelOf(harness).querySelector('[data-ide-search-input]');
}

function replaceInput(harness) {
  return panelOf(harness).querySelector('[data-ide-replace-input]');
}

function toolbarBtn(harness, action) {
  return panelOf(harness).querySelector(`[data-ide-replace-action="${action}"]`);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function versionedFileOperations(api) {
  return {
    async readForMutation(path) {
      return { ...(await api.readFile({ path })), path };
    },
    async writeMutation(snapshot, content) {
      return api.writeFile({ path: snapshot.path, content });
    },
  };
}

test('activation reports and clears a persisted interrupted replace journal', async (t) => {
  const logs = [];
  const harness = createHarness({
    bridgeOptions: {
      files: {},
      persisted: {
        ...SEARCH_PERSISTED,
        replaceJournal: {
          startedAt: 1,
          query: 'needle',
          total: 3,
          applied: ['one.txt', 'two.txt'],
          truncated: false,
        },
      },
    },
    extraCallbacks: {
      appendClientLog: (level, event, meta) => logs.push({ level, event, meta }),
    },
  });
  t.after(() => harness.dispose());

  await harness.controller.activateIde();
  await settle(550);

  assert.equal(harness.state.ui.ide.replaceJournal, null);
  assert.equal(harness.toasts.filter((toast) => toast.meta?.dedupeKey === 'ide:replace:journal-recovery').length, 1);
  assert.ok(logs.some(({ level, event, meta }) => (
    level === 'WARN'
      && event === 'ide.replace_journal_recovered'
      && meta.applied === 2
      && meta.total === 3
  )));
  assert.equal(harness.bridge.calls.updateState.at(-1)?.rootState?.replaceJournal, null);
});

async function runFind(harness, query) {
  dispatchInput(harness, queryInput(harness), query);
  pressKey(harness, queryInput(harness), 'Enter');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await settle(5);
    const search = harness.state.ui.ide.search || {};
    if (search.busy !== true && (search.ranQuery === query || search.error)) return;
  }
  throw new Error(`search did not settle for ${query}`);
}

async function setReplace(harness, value) {
  dispatchInput(harness, replaceInput(harness), value);
  await settle(5);
}

async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await settle(5);
  }
  throw new Error(`${label} did not settle`);
}

test('literal Replace All rewrites every occurrence and reports a summary', async (t) => {
  const harness = makeHarness(t, {
    'src/app.js': 'const alpha = 1;\nconst beta = alpha + 1;\n',
  });
  await harness.controller.activateIde();
  await settle();

  await runFind(harness, 'alpha');
  await setReplace(harness, 'omega');
  toolbarBtn(harness, 'replace-all').click();
  await settle(60);

  assert.equal(harness.bridge.state.files['src/app.js'], 'const omega = 1;\nconst beta = omega + 1;\n');
  const write = harness.bridge.calls.writeFile.at(-1);
  assert.equal(write.path, 'src/app.js');
  assert.equal(write.content, 'const omega = 1;\nconst beta = omega + 1;\n');
  assert.match(panelOf(harness).querySelector('.ide-search-status').textContent, /Replaced 2 occurrences in 1 file/);
});

test('fast multi-file Replace All flushes a non-null journal during the write loop', async (t) => {
  const harness = makeHarness(t, {
    'one.txt': 'tok one\n',
    'two.txt': 'tok two\n',
    'three.txt': 'tok three\n',
  });
  await harness.controller.activateIde();
  await settle();
  await runFind(harness, 'tok');
  await setReplace(harness, 'TOK');
  const thirdWrite = deferred();
  const releaseThirdWrite = deferred();
  const workspaceFs = harness.bridge.jennyShell.workspaceFs;
  const originalWriteText = workspaceFs.writeText.bind(workspaceFs);
  let writeCount = 0;
  workspaceFs.writeText = async (payload) => {
    writeCount += 1;
    if (writeCount === 3) {
      thirdWrite.resolve();
      await releaseThirdWrite.promise;
    }
    return originalWriteText(payload);
  };

  toolbarBtn(harness, 'replace-all').click();
  await thirdWrite.promise;
  const persistedDuringLoop = harness.bridge.calls.updateState.some(
    (call) => call.rootState?.replaceJournal != null
  );
  releaseThirdWrite.resolve();
  await waitUntil(() => harness.state.ui.ide.search.replacing !== true, 'replace-all');

  assert.equal(persistedDuringLoop, true);
  assert.equal(writeCount, 3);
});

test('Replace All on an OPEN buffer routes through the editor host (live buffer, no re-read, clean tab)', async (t) => {
  const harness = makeHarness(t, {
    'src/app.js': 'const alpha = 1;\nconst beta = alpha + 1;\n',
  });
  await harness.controller.activateIde();
  await settle();

  await runFind(harness, 'alpha');
  // Open the file by clicking its first match row (no replace value yet, so no
  // per-match button intercepts the click).
  panelOf(harness).querySelector('[data-ide-search-path]').click();
  await settle(20);
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="src/app.js"]'), 'file opened');
  const readsAfterOpen = harness.bridge.calls.readFile.length;

  await setReplace(harness, 'omega');
  toolbarBtn(harness, 'replace-all').click();
  await settle(60);

  const write = harness.bridge.calls.writeFile.at(-1);
  assert.equal(write.content, 'const omega = 1;\nconst beta = omega + 1;\n');
  assert.equal(write.expectedGeneration, 1, 'used the open document generation for concurrency');
  assert.match(write.expectedFileVersion, /^vf2_/, 'used the open document opaque file version');
  // The live buffer (getValue) was the source — no extra readFile during replace.
  assert.equal(harness.bridge.calls.readFile.length, readsAfterOpen, 'replace did not re-read disk for an open file');
  assert.equal(harness.getDom().ideTabStrip.querySelector('.ide-tab--dirty'), null, 'open tab is clean after the refreshing write');
});

test('a late editor change survives replace and makes undo refuse the newer buffer', async (t) => {
  const harness = makeHarness(t, { 'src/app.js': 'const alpha = 1;\n' });
  await harness.controller.activateIde();
  await settle();
  await harness.controller.openFile('src/app.js');
  await runFind(harness, 'alpha');
  await setReplace(harness, 'omega');

  const writeCalled = deferred();
  const allowWrite = deferred();
  const realWrite = harness.bridge.jennyShell.workspaceFs.writeText;
  harness.bridge.jennyShell.workspaceFs.writeText = async (payload) => {
    writeCalled.resolve();
    await allowWrite.promise;
    return realWrite(payload);
  };
  toolbarBtn(harness, 'replace-all').click();
  await writeCalled.promise;
  dispatchInput(harness, harness.getDom().ideEditorFallback, 'const user_late_edit = 2;\n');
  allowWrite.resolve();
  await settle(40);

  assert.equal(harness.bridge.state.files['src/app.js'], 'const omega = 1;\n');
  assert.equal(harness.getDom().ideEditorFallback.value, 'const user_late_edit = 2;\n');
  assert.ok(harness.getDom().ideTabStrip.querySelector('.ide-tab--dirty'));
  assert.ok(harness.getDom().ideTabStrip.querySelector('.ide-tab--stale'));

  toolbarBtn(harness, 'undo').click();
  await settle(40);
  assert.equal(harness.bridge.state.files['src/app.js'], 'const omega = 1;\n', 'undo does not overwrite after a newer edit');
  assert.equal(harness.getDom().ideEditorFallback.value, 'const user_late_edit = 2;\n');
});

test('regex Replace All applies capture groups, and the preview shows the after text', async (t) => {
  const harness = makeHarness(t, {
    'a.txt': 'foo123bar\nfoo9bar\n',
  });
  await harness.controller.activateIde();
  await settle();

  toolbarBtn(harness, 'toggle-regex').click();
  await settle(10);
  await runFind(harness, 'foo(\\d+)bar');
  await setReplace(harness, 'num=$1');

  // Inline before/after preview proves computeReplacementForMatch with $1.
  assert.equal(panelOf(harness).querySelector('.ide-search-replace-after').textContent, 'num=123');

  toolbarBtn(harness, 'replace-all').click();
  await waitUntil(
    () => harness.bridge.state.files['a.txt'] === 'num=123\nnum=9\n',
    'regex replacement'
  );

  assert.equal(harness.bridge.state.files['a.txt'], 'num=123\nnum=9\n');
});

test('per-match Replace touches only the chosen occurrence', async (t) => {
  const harness = makeHarness(t, {
    'b.txt': 'foo one\nmid\nfoo two\n',
  });
  await harness.controller.activateIde();
  await settle();

  await runFind(harness, 'foo');
  await setReplace(harness, 'Z');
  const matchButtons = panelOf(harness).querySelectorAll('[data-ide-replace-match]');
  assert.equal(matchButtons.length, 2, 'two match rows expose a replace button');
  matchButtons[1].click(); // the second match (line 3)
  await settle(60);

  assert.equal(harness.bridge.state.files['b.txt'], 'foo one\nmid\nZ two\n');
});

test('per-file Replace rewrites one file and leaves the others alone', async (t) => {
  const harness = makeHarness(t, {
    'one.txt': 'tok here\n',
    'two.txt': 'tok again\ntok twice\n',
  });
  await harness.controller.activateIde();
  await settle();

  await runFind(harness, 'tok');
  await setReplace(harness, 'TOK');
  panelOf(harness).querySelector('[data-ide-replace-file="two.txt"]').click();
  await settle(60);

  assert.equal(harness.bridge.state.files['two.txt'], 'TOK again\nTOK twice\n');
  assert.equal(harness.bridge.state.files['one.txt'], 'tok here\n', 'untargeted file untouched');
});

test('an empty replacement exposes per-match and per-file delete actions with previews', async (t) => {
  const harness = makeHarness(t, {
    'one.txt': 'foo\nfoo\n',
    'two.txt': 'foo\n',
  });
  await harness.controller.activateIde();
  await settle();
  await runFind(harness, 'foo');

  const panel = panelOf(harness);
  assert.equal(panel.querySelectorAll('[data-ide-replace-match]').length, 3);
  assert.equal(panel.querySelectorAll('[data-ide-replace-file]').length, 2);
  assert.equal(panel.querySelector('.ide-search-replace-after').textContent, '');

  panel.querySelector('[data-ide-replace-match][data-ide-replace-path="one.txt"]').click();
  await waitUntil(() => harness.bridge.state.files['one.txt'] === '\nfoo\n', 'single deletion');
  panelOf(harness).querySelector('[data-ide-replace-file="two.txt"]').click();
  await waitUntil(() => harness.bridge.state.files['two.txt'] === '\n', 'file deletion');

  assert.equal(harness.bridge.state.files['one.txt'], '\nfoo\n');
  assert.equal(harness.bridge.state.files['two.txt'], '\n');
});

test('Replace All is blocked immediately when the visible query is awaiting debounce', async (t) => {
  const harness = makeHarness(t, { 'a.txt': 'foo bar\n' });
  await harness.controller.activateIde();
  await settle();
  await runFind(harness, 'foo');
  await setReplace(harness, 'X');
  const writesBefore = harness.bridge.calls.writeFile.length;

  dispatchInput(harness, queryInput(harness), 'bar');
  toolbarBtn(harness, 'replace-all').click();
  await settle(60);

  assert.equal(harness.bridge.calls.writeFile.length, writesBefore, 'stale foo results produce zero writes');
  assert.equal(harness.bridge.state.files['a.txt'], 'foo bar\n');
});

test('Replace All then Undo restores every file byte-for-byte', async (t) => {
  const harness = makeHarness(t, {
    'one.txt': 'tok here\n',
    'two.txt': 'tok again\ntok twice\n',
  });
  await harness.controller.activateIde();
  await settle();

  await runFind(harness, 'tok');
  await setReplace(harness, 'TOK');
  toolbarBtn(harness, 'replace-all').click();
  await settle(60);
  assert.equal(harness.bridge.state.files['one.txt'], 'TOK here\n');
  assert.equal(harness.bridge.state.files['two.txt'], 'TOK again\nTOK twice\n');

  const undoBtn = toolbarBtn(harness, 'undo');
  assert.ok(undoBtn, 'an Undo button appears after a replace');
  undoBtn.click();
  await settle(60);

  assert.equal(harness.bridge.state.files['one.txt'], 'tok here\n');
  assert.equal(harness.bridge.state.files['two.txt'], 'tok again\ntok twice\n');
  assert.equal(toolbarBtn(harness, 'undo'), null, 'Undo button clears after undoing');
});

test('CRLF files keep CRLF endings through a replace', async (t) => {
  const harness = makeHarness(t, {
    'crlf.txt': 'tok one\r\ntok two\r\n',
  });
  await harness.controller.activateIde();
  await settle();

  await runFind(harness, 'tok');
  await setReplace(harness, 'TOK');
  toolbarBtn(harness, 'replace-all').click();
  await settle(60);

  assert.equal(harness.bridge.state.files['crlf.txt'], 'TOK one\r\nTOK two\r\n');
});

test('invalid regex surfaces an error and disables Replace All', async (t) => {
  const harness = makeHarness(t, {
    'c.txt': 'alpha beta\n',
  });
  await harness.controller.activateIde();
  await settle();

  toolbarBtn(harness, 'toggle-regex').click();
  await settle(10);
  await runFind(harness, '(a'); // unbalanced group, length >= MIN_QUERY_LENGTH

  assert.ok(panelOf(harness).querySelector('.ide-search-status--error'), 'error status shown');
  assert.equal(harness.bridge.calls.writeFile.length, 0, 'nothing was written');
  assert.equal(toolbarBtn(harness, 'replace-all').disabled, true, 'Replace All disabled with no results');
});

test('toggling case re-runs the find; editing replace only refreshes previews', async (t) => {
  const harness = makeHarness(t, {
    'd.txt': 'Alpha\nalpha\n',
  });
  await harness.controller.activateIde();
  await settle();

  await runFind(harness, 'alpha');
  const searchesAfterFind = harness.bridge.calls.searchInFiles.length;

  // Toggling case re-runs the (literal) find.
  toolbarBtn(harness, 'toggle-case').click();
  await settle(40);
  assert.equal(harness.state.ui.ide.search.caseSensitive, true);
  assert.ok(harness.bridge.calls.searchInFiles.length > searchesAfterFind, 'case toggle triggered a new find');

  // Editing the replace field refreshes previews WITHOUT a new search.
  const searchesBeforeReplaceEdit = harness.bridge.calls.searchInFiles.length;
  await setReplace(harness, 'beta');
  assert.equal(harness.bridge.calls.searchInFiles.length, searchesBeforeReplaceEdit, 'editing replace did not re-search');
  assert.ok(panelOf(harness).querySelector('.ide-search-replace-after'), 'before/after preview rendered');
});

test('replaceAll cancelled mid-loop via dispose() stops writing further files (F3)', async (t) => {
  // Direct construction (bypassing the full harness): the write handler for the
  // 2nd file calls controller.dispose() before returning, giving a deterministic
  // cancel point between file 2's write and file 3's read.
  const { createIdeReplaceController } = require('../renderer/features/renderer-ide-replace-controller');

  const files = {
    'one.txt': 'tok one\n',
    'two.txt': 'tok two\n',
    'three.txt': 'tok three\n',
  };
  const writes = [];
  const infoLogs = [];
  let controller; // assigned after creation; referenced from the write handler below

  const fakeApi = {
    async readFile({ path }) {
      return { content: files[path], mtimeMs: 1 };
    },
    async writeFile({ path, content }) {
      writes.push(path);
      files[path] = content;
      if (path === 'two.txt') {
        // Deterministic cancel point: dispose fires between file 2's write and
        // file 3's read, while replaceAll's for-loop is still in flight.
        controller.dispose();
      }
      return { mtimeMs: 2 };
    },
  };

  const search = {
    query: 'tok', results: [{ path: 'one.txt' }, { path: 'two.txt' }, { path: 'three.txt' }],
  };
  const ide = { search };

  controller = createIdeReplaceController({
    getIde: () => ide,
    getWorkspaceFsApi: () => fakeApi,
    getFileOperations: () => versionedFileOperations(fakeApi),
    callbacks: {
      appendClientLog: (level, event, meta) => infoLogs.push({ level, event, meta }),
      renderSearchPanel: () => {},
      requestFindRefresh: () => {},
      renderTabs: () => {},
      isSaving: () => false,
    },
  });

  const result = await controller.replaceAll({ query: 'tok', replaceText: 'TOK', useRegex: false, caseSensitive: false });

  assert.deepEqual(writes, ['one.txt', 'two.txt'], 'file 3 was never written after dispose cancelled the loop');
  assert.equal(files['three.txt'], 'tok three\n', 'file 3 content is untouched');
  assert.equal(result.filesChanged, 2, 'only the two files written before cancellation are counted');
  // file 3's iteration never starts (the disposed check breaks before its
  // replaceWholeFile call), so recordUndo only ever sees files 1 and 2 — both
  // already fully written by the time dispose() fired mid-file-2's write.
  assert.equal(search.lastReplace.records.length, 2, 'recordUndo captured files 1 and 2 (both committed disk writes)');
  const cancelLog = infoLogs.find((entry) => entry.event === 'ide.replace_all_cancelled');
  assert.ok(cancelLog, 'the INFO ide.replace_all_cancelled diagnostic fired');
});

test('undoLastReplace cancelled mid-loop via dispose() preserves the undo record (fix B)', async (t) => {
  // Mirrors the replaceAll dispose-cancellation test above: direct construction,
  // seed s.lastReplace with 3 records, and have the write handler for the 1st
  // restore call controller.dispose() so the loop cancels between record 1 and
  // record 2. Pre-fix, the post-loop code unconditionally wiped s.lastReplace to
  // null even on a disposed break, permanently discarding the undo record for
  // records 2 and 3 (which were never restored) with no retry path.
  const { createIdeReplaceController } = require('../renderer/features/renderer-ide-replace-controller');

  const files = {
    'one.txt': 'TOK one\n',
    'two.txt': 'TOK two\n',
    'three.txt': 'TOK three\n',
  };
  const writes = [];
  const infoLogs = [];
  let controller; // assigned after creation; referenced from the write handler below

  const lastReplaceRecords = [
    { path: 'one.txt', beforeContent: 'tok one\n', afterContent: 'TOK one\n' },
    { path: 'two.txt', beforeContent: 'tok two\n', afterContent: 'TOK two\n' },
    { path: 'three.txt', beforeContent: 'tok three\n', afterContent: 'TOK three\n' },
  ];

  const fakeApi = {
    async readFile({ path }) {
      return { content: files[path], mtimeMs: 2 };
    },
    async writeFile({ path, content }) {
      writes.push(path);
      files[path] = content;
      if (path === 'one.txt') {
        // Deterministic cancel point: dispose fires between record 1's write and
        // record 2's read, while undoLastReplace's for-loop is still in flight.
        controller.dispose();
      }
      return { mtimeMs: 3 };
    },
  };

  const search = {
    query: 'tok', results: [],
    lastReplace: { records: lastReplaceRecords },
    canUndo: true,
  };
  const ide = { search };

  controller = createIdeReplaceController({
    getIde: () => ide,
    getWorkspaceFsApi: () => fakeApi,
    getFileOperations: () => versionedFileOperations(fakeApi),
    callbacks: {
      appendClientLog: (level, event, meta) => infoLogs.push({ level, event, meta }),
      renderSearchPanel: () => {},
      requestFindRefresh: () => {},
      renderTabs: () => {},
      isSaving: () => false,
    },
  });

  const result = await controller.undoLastReplace();

  assert.deepEqual(writes, ['one.txt'], 'record 2 was never restored after dispose cancelled the loop');
  assert.equal(files['two.txt'], 'TOK two\n', 'file 2 content is untouched (not yet undone)');
  assert.equal(files['three.txt'], 'TOK three\n', 'file 3 content is untouched (not yet undone)');
  assert.equal(result.restored, 1, 'only the one record restored before cancellation is counted');
  assert.equal(result.cancelled, true, 'result reports the cancellation');
  assert.ok(search.lastReplace, 's.lastReplace was preserved (not wiped to null) after a disposed break');
  assert.equal(search.lastReplace.records.length, 3, 'the undo record for all 3 files is still intact for a later re-run');
  const cancelLog = infoLogs.find((entry) => entry.event === 'ide.undo_replace_cancelled');
  assert.ok(cancelLog, 'the INFO ide.undo_replace_cancelled diagnostic fired');
});

test('root reset clears an old-root undo record before the same path exists in a new root', async () => {
  const { createIdeReplaceController } = require('../renderer/features/renderer-ide-replace-controller');
  const search = {
    query: 'old',
    results: [{ path: 'same.txt' }],
    busy: false,
    canUndo: true,
    lastReplace: { records: [{ path: 'same.txt', beforeContent: 'A', afterContent: 'B' }] },
  };
  const writes = [];
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getWorkspaceFsApi: () => ({
      readFile: async () => ({ content: 'B', mtimeMs: 1 }),
      writeFile: async (payload) => writes.push(payload),
    }),
  });

  controller.resetForRoot();

  assert.equal(search.lastReplace, null);
  assert.equal(search.canUndo, false);
  assert.deepEqual(search.results, []);
  assert.deepEqual(await controller.undoLastReplace(), { note: 'nothing' });
  assert.deepEqual(writes, []);
});

test('root reset during Replace All stops before the next file and cannot refresh new-root search state', async () => {
  const { createIdeReplaceController } = require('../renderer/features/renderer-ide-replace-controller');
  const writeStarted = deferred();
  const releaseWrite = deferred();
  const writes = [];
  let refreshes = 0;
  const ide = {
    search: { query: 'tok', results: [{ path: 'one.txt' }, { path: 'two.txt' }], busy: false },
  };
  const fakeApi = {
      readFile: async ({ path }) => ({ content: `tok ${path}`, mtimeMs: 1 }),
      async writeFile(payload) {
        writes.push(payload.path);
        writeStarted.resolve();
        await releaseWrite.promise;
        return { mtimeMs: 2 };
      },
    };
  const controller = createIdeReplaceController({
    getIde: () => ide,
    getWorkspaceFsApi: () => fakeApi,
    getFileOperations: () => versionedFileOperations(fakeApi),
    callbacks: { requestFindRefresh: () => { refreshes += 1; } },
  });

  const pending = controller.replaceAll({ query: 'tok', replaceText: 'TOK' });
  await writeStarted.promise;
  controller.resetForRoot();
  releaseWrite.resolve();
  const result = await pending;

  assert.deepEqual(writes, ['one.txt']);
  assert.equal(result.cancelled, true);
  assert.equal(result.filesChanged, 1);
  assert.equal(refreshes, 0);
  assert.equal(ide.search.lastReplace, null);
});

test('regex find honors a Find-in-Folder scope via a client-side path filter', async (t) => {
  const harness = makeHarness(t, {
    'src/app.js': 'needleX\n',
    'src/inner/deep.js': 'needleY\n',
    'lib/util.js': 'needleZ\n',
  });
  await harness.controller.activateIde();
  await settle();

  // Seed a folder scope on the runtime search slice (as Find in Folder would).
  const search = harness.state.ui.ide.search || (harness.state.ui.ide.search = {});
  search.scope = 'src';

  // Regex mode scans files client-side via listAllFiles; the scope is applied as
  // a path-prefix filter, so only files under src/ are searched (lib/ is excluded)
  // and the backend literal searchInFiles is never called.
  toolbarBtn(harness, 'toggle-regex').click();
  await settle(10);
  await runFind(harness, 'needle.');
  const files = [...panelOf(harness).querySelectorAll('[data-ide-search-file]')]
    .map((el) => el.dataset.ideSearchFile).sort();
  assert.deepEqual(files, ['src/app.js', 'src/inner/deep.js']);
  assert.equal(harness.bridge.calls.searchInFiles.length, 0, 'regex find does not call the backend');
});

test('regex find tolerates a trailing slash on the Find-in-Folder scope', async (t) => {
  const harness = makeHarness(t, {
    'src/app.js': 'needleX\n',
    'lib/util.js': 'needleZ\n',
  });
  await harness.controller.activateIde();
  await settle();

  // A scope with a trailing slash must scope identically to one without: the
  // renderer strips it to match the backend's literal filter (without the strip,
  // 'src/' became startsWith('src//') and silently matched nothing).
  const search = harness.state.ui.ide.search || (harness.state.ui.ide.search = {});
  search.scope = 'src/';

  toolbarBtn(harness, 'toggle-regex').click();
  await settle(10);
  await runFind(harness, 'needle.');
  const files = [...panelOf(harness).querySelectorAll('[data-ide-search-file]')]
    .map((el) => el.dataset.ideSearchFile).sort();
  assert.deepEqual(files, ['src/app.js'], 'trailing-slash scope still scopes to src/ and excludes lib/');
});
