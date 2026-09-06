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
