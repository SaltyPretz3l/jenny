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
