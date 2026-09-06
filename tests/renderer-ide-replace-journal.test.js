'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeWorkspaceIde } = require('../services/workspace-ide-config-schema');

function createJournalHarness(initial = null) {
  const ide = { replaceJournal: initial };
  const persists = [];
  const flushes = [];
  const logs = [];
  const toasts = [];
  const { createIdeReplaceJournal } = require('../renderer/features/renderer-ide-replace-journal');
  const journal = createIdeReplaceJournal({
    getIde: () => ide,
    schedulePersist: () => persists.push(ide.replaceJournal),
    flushPersist: async () => flushes.push(ide.replaceJournal),
    appendClientLog: (level, event, meta) => logs.push({ level, event, meta }),
    showToast: (message, meta) => toasts.push({ message, meta }),
  });
  return { ide, persists, flushes, logs, toasts, journal };
}

test('replace journal open/mark/close persists the completion lifecycle', async () => {
  const { ide, persists, flushes, journal } = createJournalHarness();

  const token = await journal.open({ query: 'needle', total: 2 });
  assert.equal(ide.replaceJournal.query, 'needle');
  assert.equal(ide.replaceJournal.total, 2);
  assert.ok(Number.isFinite(ide.replaceJournal.startedAt));
  await journal.markApplied(token, 'src/one.js');
  await journal.markApplied(token, 'src/two.js');
  assert.deepEqual(ide.replaceJournal.applied, ['src/one.js', 'src/two.js']);
  journal.close(token);

  assert.equal(ide.replaceJournal, null);
  assert.equal(persists.length, 4);
  assert.equal(flushes.length, 1);
});

test('replace journal caps applied paths at 200 and marks the record truncated', async () => {
  const { ide, flushes, journal } = createJournalHarness();

  const token = await journal.open({ query: 'needle', total: 225 });
  for (let index = 0; index < 225; index += 1) await journal.markApplied(token, `src/${index}.js`);

  assert.equal(ide.replaceJournal.applied.length, 200);
  assert.equal(ide.replaceJournal.truncated, true);
  assert.equal(flushes.length, 10, 'open plus every 25th mark through 225 flush exactly once each');
});

test('malformed persisted replace journals normalize to null', () => {
  for (const replaceJournal of [
    {},
    [],
    { startedAt: Infinity, query: 'x', total: 1, applied: [] },
    { startedAt: 1, query: null, total: 1, applied: [] },
    { startedAt: 1, query: 'x', total: -1, applied: [] },
    { startedAt: 1, query: 'x', total: 1, applied: null },
  ]) {
    assert.equal(normalizeWorkspaceIde({ replaceJournal }).replaceJournal, null);
  }
});

test('checkRecovery emits one warning and toast, reports paths, then clears the journal', () => {
  const initial = {
    startedAt: 1,
    query: 'needle',
    total: 3,
    applied: ['one.js', 'two.js'],
    truncated: false,
  };
  const { ide, persists, logs, toasts, journal } = createJournalHarness(initial);

  journal.checkRecovery();
  journal.checkRecovery();

  assert.equal(ide.replaceJournal, null);
  assert.equal(persists.length, 1);
  assert.deepEqual(logs, [{
    level: 'WARN',
    event: 'ide.replace_journal_recovered',
    meta: { applied: 2, total: 3, truncated: false, paths: ['one.js', 'two.js'] },
  }]);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /interrupted after at least 2 of 3 files/);
  assert.equal(toasts[0].meta?.dedupeKey, 'ide:replace:journal-recovery');
  assert.equal(toasts[0].meta?.sticky, undefined);
});

test('checkRecovery is silent when no journal exists', () => {
  const { persists, logs, toasts, journal } = createJournalHarness();

  journal.checkRecovery();

  assert.deepEqual(persists, []);
  assert.deepEqual(logs, []);
  assert.deepEqual(toasts, []);
});

test('a stale invocation cannot mark or close a newer journal', async () => {
  const { ide, journal } = createJournalHarness();
  const staleToken = await journal.open({ query: 'old', total: 1 });
  const currentToken = await journal.open({ query: 'new', total: 2 });

  await journal.markApplied(staleToken, 'old.txt');
  journal.close(staleToken);
  await journal.markApplied(currentToken, 'new.txt');

  assert.equal(ide.replaceJournal.query, 'new');
  assert.deepEqual(ide.replaceJournal.applied, ['new.txt']);
});

test('close without a prior open leaves a hydrated journal intact', () => {
  const initial = { startedAt: 2, query: 'hydrated', total: 1, applied: [], truncated: false };
  const { ide, persists, journal } = createJournalHarness(initial);

  journal.close();

  assert.equal(ide.replaceJournal, initial);
  assert.deepEqual(persists, []);
});

test('open reports a hydrated journal before installing the new invocation', async () => {
  const initial = { startedAt: 2, query: 'hydrated', total: 3, applied: ['old.txt'], truncated: false };
  const { ide, logs, toasts, journal } = createJournalHarness(initial);

  const token = await journal.open({ query: 'new', total: 2 });
  await journal.markApplied(token, 'new.txt');

  assert.equal(logs.length, 1);
  assert.equal(toasts.length, 1);
  assert.equal(ide.replaceJournal.query, 'new');
  assert.deepEqual(ide.replaceJournal.applied, ['new.txt']);
});
