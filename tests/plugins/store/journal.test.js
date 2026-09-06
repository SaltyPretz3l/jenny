'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  JOURNAL_FILE,
  appendJournalEntry,
  readJournal,
} = require('../../../services/plugins/store/journal');

const NOW = '2026-07-31T00:00:00Z';

test('appendJournalEntry requires a kind and recorded_at, and readJournal returns entries in append order', async () => {
  const facade = createMemoryFsFacade();
  await appendJournalEntry(facade, 'plugins', { kind: 'pointer_commit', recorded_at: NOW, commit_epoch: 0 });
  await appendJournalEntry(facade, 'plugins', { kind: 'recovery_epoch', recorded_at: NOW, commit_epoch: 1 });
  const { entries, malformedCount } = await readJournal(facade, 'plugins');
  assert.deepEqual(entries.map((e) => e.kind), ['pointer_commit', 'recovery_epoch']);
  assert.equal(malformedCount, 0);
});

test('appendJournalEntry rejects an entry missing kind/recorded_at', async () => {
  const facade = createMemoryFsFacade();
  await assert.rejects(() => appendJournalEntry(facade, 'plugins', { commit_epoch: 0 }), /kind.*recorded_at/);
});

test('readJournal is bounded by maxEntries and drops the oldest entries first (ring buffer)', async () => {
  const facade = createMemoryFsFacade();
  for (let i = 0; i < 5; i += 1) {
    await appendJournalEntry(facade, 'plugins', { kind: 'evt', recorded_at: NOW, seq: i }, { maxEntries: 3 });
  }
  const { entries } = await readJournal(facade, 'plugins');
  assert.deepEqual(entries.map((e) => e.seq), [2, 3, 4]);
});

test('readJournal tolerates a torn trailing line by skipping it and reporting malformedCount', async () => {
  const facade = createMemoryFsFacade();
  await appendJournalEntry(facade, 'plugins', { kind: 'evt', recorded_at: NOW, seq: 1 });
  const existing = await facade.readFile(`plugins/${JOURNAL_FILE}`);
  await facade.writeFile(`plugins/${JOURNAL_FILE}`, `${existing}{not valid json\n`);
  const { entries, malformedCount } = await readJournal(facade, 'plugins');
  assert.deepEqual(entries.map((e) => e.seq), [1]);
  assert.equal(malformedCount, 1);
});

test('readJournal treats a structurally-parseable-but-shapeless line as malformed, not a valid entry', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('plugins');
  await facade.writeFile(`plugins/${JOURNAL_FILE}`, '{"not_kind_or_recorded_at":true}\n');
  const { entries, malformedCount } = await readJournal(facade, 'plugins');
  assert.deepEqual(entries, []);
  assert.equal(malformedCount, 1);
});

test('readJournal entries can be filtered to a requested kind', async () => {
  const facade = createMemoryFsFacade();
  await appendJournalEntry(facade, 'plugins', { kind: 'pointer_commit', recorded_at: NOW, commit_epoch: 0 });
  await appendJournalEntry(facade, 'plugins', { kind: 'recovery_epoch', recorded_at: NOW, commit_epoch: 1 });
  await appendJournalEntry(facade, 'plugins', { kind: 'pointer_commit', recorded_at: NOW, commit_epoch: 2 });
  const { entries } = await readJournal(facade, 'plugins');
  assert.deepEqual(entries.filter((entry) => entry.kind === 'pointer_commit').map((e) => e.commit_epoch), [0, 2]);
});
