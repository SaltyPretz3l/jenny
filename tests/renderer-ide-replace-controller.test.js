'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeReplaceController,
} = require('../renderer/features/renderer-ide-replace-controller');

test('undoLastReplace skips without reading or writing while a save is active', async () => {
  const calls = { reads: 0, writes: 0 };
  const search = {
    query: 'before',
    results: [],
    canUndo: true,
    lastReplace: {
      records: [{ path: 'same.txt', beforeContent: 'before', afterContent: 'after' }],
    },
  };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getWorkspaceFsApi: () => ({
      readFile: async () => { calls.reads += 1; return { content: 'after', mtimeMs: 1 }; },
      writeFile: async () => { calls.writes += 1; return { mtimeMs: 2 }; },
    }),
    callbacks: { isSaving: () => true },
  });

  const result = await controller.undoLastReplace();

  assert.deepEqual(result, { skipped: true });
  assert.deepEqual(calls, { reads: 0, writes: 0 });
  assert.ok(search.lastReplace, 'the undo record remains available after the save completes');
});

test('replaceAll fails closed without versioned file operations and reports every skipped file', async () => {
  const writes = [];
  const toasts = [];
  const logs = [];
  const ide = {
    search: {
      query: 'before',
      results: [{ path: 'one.txt' }, { path: 'two.txt' }],
      busy: false,
    },
  };
  const controller = createIdeReplaceController({
    getIde: () => ide,
    getFileOperations: () => null,
    getWorkspaceFsApi: () => ({
      readFile: async ({ path }) => ({ content: `before ${path}`, mtimeMs: 1 }),
      writeFile: async (payload) => { writes.push(payload); return { mtimeMs: 2 }; },
    }),
    callbacks: {
      appendClientLog: (level, event, meta) => logs.push({ level, event, meta }),
      showShellErrorToast: (message, meta) => toasts.push({ message, meta }),
    },
  });

  const result = await controller.replaceAll({ query: 'before', replaceText: 'after' });

  assert.deepEqual(writes, [], 'legacy writeFile is never used');
  assert.deepEqual(result.failures, ['one.txt', 'two.txt']);
  assert.match(ide.search.replaceSummary, /2 skipped \(unavailable\)/);
  assert.equal(toasts.length, 1, 'the operation emits one deduped refusal toast');
  assert.equal(toasts[0].meta?.dedupeKey, 'ide:replace:no-bridge');
  assert.equal(toasts[0].meta?.title, 'Save Failed');
  assert.equal(toasts[0].meta?.sticky, undefined);
  assert.deepEqual(
    logs.map(({ level, event, meta }) => ({ level, event, path: meta.path, reason: meta.reason })),
    [
      { level: 'WARN', event: 'ide.replace_write_failed', path: 'one.txt', reason: 'no_bridge' },
      { level: 'WARN', event: 'ide.replace_write_failed', path: 'two.txt', reason: 'no_bridge' },
    ]
  );
});

// IDE-007: undo compares exact bytes. An external CRLF<->LF-only rewrite after the
// replace must read as "changed since" and never be overwritten.
function makeUndoHarness(diskContent) {
  const writes = [];
  const search = {
    query: 'x',
    results: [],
    canUndo: true,
    lastReplace: {
      records: [{ path: 'eol.txt', beforeContent: 'a\r\nb\r\n', afterContent: 'A\r\nb\r\n' }],
    },
  };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getFileOperations: () => ({
      readForMutation: async () => ({ content: diskContent, mtimeMs: 1 }),
      writeMutation: async (snapshot, content) => { writes.push(content); return { mtimeMs: 2 }; },
    }),
  });
  return { controller, writes };
}

test('undoLastReplace reports an EOL-only external rewrite as a conflict and does not write it', async () => {
  const { controller, writes } = makeUndoHarness('A\nb\n');

  const result = await controller.undoLastReplace();

  assert.equal(result.restored, 0);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(writes, []);
});

test('undoLastReplace still restores a file that holds exactly what the replace wrote', async () => {
  const { controller, writes } = makeUndoHarness('A\r\nb\r\n');

  const result = await controller.undoLastReplace();

  assert.equal(result.restored, 1);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(writes, ['a\r\nb\r\n']);
});

// An open (possibly dirty) editor buffer plus versioned file operations.
function makeOpenDocHarness(buffer, { current = true } = {}) {
  const writes = [];
  const opened = [];
  const search = { query: 'foo', results: [], busy: false };
  const editorHost = {
    hasDocument: () => true,
    getDocumentKind: () => 'file',
    getValue: () => buffer,
    getAltVersionId: () => 1,
    getMtime: () => 1,
    openDocument: async (payload) => { opened.push(payload); return true; },
  };
  const operations = {
    captureSave: (path, { content }) => ({ documentId: 'doc-1', editVersion: 1, content }),
    write: async (snapshot) => { writes.push(snapshot.content); return { mtimeMs: 2 }; },
    acceptWrite: () => ({ current, exactEdit: current }),
    canApplyWrite: () => current,
    noteDirty: () => {},
  };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getFileOperations: () => operations,
    editorHost,
  });
  return { controller, search, writes, opened };
}

test('replace-this-occurrence refuses when the dirty buffer no longer holds the previewed match', async () => {
  const expectedPreview = { text: 'foo bar foo', matchStart: 8, matchEnd: 11 };
  const opts = { query: 'foo', replaceText: 'X', useRegex: false, caseSensitive: false, expectedPreview };

  const shifted = makeOpenDocHarness('foo foo foo');
  assert.deepEqual(await shifted.controller.replaceMatch('a.txt', 1, 9, opts), { occurrences: 0 });
  assert.deepEqual(shifted.writes, [], 'another occurrence at the same coordinates is never replaced');
  assert.equal(shifted.search.replaceSummary, 'Match position changed; not replaced.');

  const intact = makeOpenDocHarness('foo bar foo');
  assert.deepEqual(await intact.controller.replaceMatch('a.txt', 1, 9, opts), { filesChanged: 1, occurrences: 1 });
  assert.deepEqual(intact.writes, ['foo bar X']);
});

test('a write that landed after its tab closed is recorded as applied, not as a conflict', async () => {
  const harness = makeOpenDocHarness('foo bar', { current: false });

  const result = await harness.controller.replaceMatch('a.txt', 1, 1, { query: 'foo', replaceText: 'X' });

  assert.deepEqual(result, { filesChanged: 1, occurrences: 1 });
  assert.deepEqual(harness.writes, ['X bar']);
  assert.deepEqual(harness.opened, [], 'the closed document is not refreshed');
  assert.equal(harness.search.canUndo, true);
  assert.deepEqual(harness.search.lastReplace.records, [{ path: 'a.txt', beforeContent: 'foo bar', afterContent: 'X bar' }]);

  const all = makeOpenDocHarness('foo foo', { current: false });
  all.search.results = [{ path: 'b.txt' }];
  const summary = await all.controller.replaceAll({ query: 'foo', replaceText: 'X' });
  assert.equal(summary.filesChanged, 1);
  assert.equal(summary.conflicts, 0);
  assert.equal(all.search.lastReplace.records.length, 1);
});

// ---- row 82 slice X2: whole word + include/exclude on the regex/replace paths ----

const { evaluateRegexTask } = require('../renderer/features/renderer-ide-regex-worker');

const inlineEvaluator = { async evaluate(task) { return evaluateRegexTask(task); } };

function makeWholeWordHarness(content, extra = {}) {
  const writes = [];
  const search = { query: 'test', results: [], busy: false };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getFileOperations: () => ({
      readForMutation: async () => ({ content, mtimeMs: 1 }),
      writeMutation: async (snapshot, next) => { writes.push(next); return { mtimeMs: 2 }; },
    }),
    regexReplaceEvaluator: inlineEvaluator,
    ...extra,
  });
  return { controller, search, writes };
}

test('literal whole-word replace only hits whole-word occurrences and keeps the replacement literal', async () => {
  const harness = makeWholeWordHarness('test testing retest test_x test');
  harness.search.results = [{ path: 'a.txt' }];

  const result = await harness.controller.replaceAll({ query: 'test', replaceText: 'X$&', wholeWord: true });

  assert.equal(result.filesChanged, 1);
  assert.equal(result.occurrences, 2);
  assert.deepEqual(harness.writes, ['X$& testing retest test_x X$&']);
  assert.equal(harness.search.replaceError, '');
});

test('literal whole-word replace escapes regex metacharacters in the query', async () => {
  const harness = makeWholeWordHarness('a.b axb a.b');
  harness.search.results = [{ path: 'a.txt' }];
  await harness.controller.replaceAll({ query: 'a.b', replaceText: 'Z', wholeWord: true });
  assert.deepEqual(harness.writes, ['Z axb Z']);
});

test('replace without wholeWord still replaces substrings (literal path unchanged)', async () => {
  const harness = makeWholeWordHarness('test testing');
  harness.search.results = [{ path: 'a.txt' }];
  await harness.controller.replaceAll({ query: 'test', replaceText: 'X' });
  assert.deepEqual(harness.writes, ['X Xing']);
});

test('whole word reads from the slice when opts omit it, and an empty query is still refused', async () => {
  const harness = makeWholeWordHarness('test testing');
  harness.search.results = [{ path: 'a.txt' }];
  harness.search.wholeWord = true;
  await harness.controller.replaceAll({ query: 'test', replaceText: 'X' });
  assert.deepEqual(harness.writes, ['X testing']);
  const refused = await harness.controller.replaceAll({ query: '', replaceText: 'X', wholeWord: true });
  assert.equal(refused.error, 'Enter a search term');
});

test('computeReplacementForMatch honours wholeWord for the before/after preview', () => {
  const harness = makeWholeWordHarness('');
  const match = { preview: { text: 'a test. testing', matchStart: 2, matchEnd: 6 } };
  assert.equal(harness.controller.computeReplacementForMatch(match, {
    query: 'test', replaceText: 'X$1', useRegex: false, caseSensitive: false, wholeWord: true,
  }), 'X$1');
  assert.equal(harness.controller.computeReplacementForMatch(match, {
    query: 'te(s)t', replaceText: '<$1>', useRegex: true, caseSensitive: false, wholeWord: true,
  }), '<s>');
});

test('regex find with wholeWord evaluates the wrapped source but keeps ranQuery as the raw query', async () => {
  const tasks = [];
  const search = { query: 'te.t', results: [], busy: false };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getWorkspaceFsApi: () => ({
      listAllFiles: async () => ({ files: ['a.txt'], truncated: false }),
      readFile: async () => ({ content: 'test testing' }),
    }),
    regexFindEvaluator: { async evaluate(task) { tasks.push(task); return evaluateRegexTask(task); } },
    callbacks: { renderSearchPanel: () => {} },
  });

  await controller.runRegexFind({ query: 'te.t', caseSensitive: false, wholeWord: true });

  assert.equal(search.ranQuery, 'te.t', 'ranQuery stays the user text (replaceBlocked compares it)');
  assert.equal(tasks[0].query, '(?<![A-Za-z0-9_])(?:te.t)(?![A-Za-z0-9_])');
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].column, 1);
});

test('regex find validates the raw query so the whole-word wrapper cannot mask a syntax error', async () => {
  const search = { query: 'a)(b', results: [], busy: false };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getWorkspaceFsApi: () => ({ listAllFiles: async () => ({ files: [] }), readFile: async () => ({ content: '' }) }),
    regexFindEvaluator: inlineEvaluator,
    callbacks: { renderSearchPanel: () => {} },
  });
  await controller.runRegexFind({ query: 'a)(b', wholeWord: true });
  assert.equal(search.error, 'Invalid regular expression');
});

test('regex find applies include/exclude globs to the listAllFiles result', async () => {
  const read = [];
  const search = { query: 'x+', results: [], busy: false };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getWorkspaceFsApi: () => ({
      listAllFiles: async () => ({
        files: ['src/a.js', 'src/a.test.js', 'lib/b.js', 'docs/c.md', 'node_modules/p/i.js'],
        truncated: false,
      }),
      readFile: async ({ path }) => { read.push(path); return { content: 'xx' }; },
    }),
    regexFindEvaluator: inlineEvaluator,
    callbacks: { renderSearchPanel: () => {} },
  });

  await controller.runRegexFind({ query: 'x+', include: ['src', 'lib'], exclude: ['*.test.js', 'node_modules'] });
  assert.deepEqual(read.sort(), ['lib/b.js', 'src/a.js']);
  assert.deepEqual(search.results.map((r) => r.path).sort(), ['lib/b.js', 'src/a.js']);
  assert.equal(search.fileCount, 2);

  read.length = 0;
  await controller.runRegexFind({ query: 'x+', scope: 'src', include: ['*.js'] });
  assert.deepEqual(read.sort(), ['src/a.js', 'src/a.test.js'], 'scope and include compose; patterns see root-relative paths');
});
