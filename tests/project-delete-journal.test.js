'use strict';

// The project delete journal (review finding DPR-008): an explicit schema, a
// bounded number of records, durable writes only. A damaged file is moved
// aside and kept; a file that cannot be read or that a newer build wrote
// makes the journal read-only. Bytes that were not understood are never
// written over.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_PENDING_PROJECT_DELETES,
  PROJECT_DELETE_JOURNAL_SCHEMA_VERSION,
  ProjectDeleteJournal,
  validateJournalDocument,
} = require('../services/projects/project-delete-journal');
const { GENERAL_PROJECT_ID } = require('../services/projects/project-schema');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function journalPath() {
  return path.join(createTrackedTempDir('jenny-project-delete-journal-'), 'project-delete-operations.json');
}

function readFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('a missing file is an empty writable journal and is not created until a record is', () => {
  const filePath = journalPath();
  const journal = new ProjectDeleteJournal(filePath);
  assert.deepEqual(journal.getStatus(), {
    schema_version: PROJECT_DELETE_JOURNAL_SCHEMA_VERSION, read_only: false, reason: null,
  });
  assert.deepEqual(journal.list(), []);
  assert.deepEqual(journal.clear('project_alpha'), { ok: true, unchanged: true });
  assert.equal(fs.existsSync(filePath), false);
});

test('record, noteAttempt and clear persist the documented shape across instances', () => {
  const filePath = journalPath();
  const journal = new ProjectDeleteJournal(filePath, { now: () => '2026-10-02T09:00:00.000Z' });
  assert.deepEqual(journal.record('project_alpha'), { ok: true });
  assert.deepEqual(readFile(filePath), {
    schema_version: 1,
    operations: {
      project_alpha: {
        project_id: 'project_alpha',
        target_project_id: GENERAL_PROJECT_ID,
        created_at: '2026-10-02T09:00:00.000Z',
        attempts: 0,
        last_attempt_at: null,
        last_reason: null,
      },
    },
  });

  const reopened = new ProjectDeleteJournal(filePath, { now: () => '2026-10-02T09:05:00.000Z' });
  assert.equal(reopened.has('project_alpha'), true);
  assert.deepEqual(reopened.noteAttempt('project_alpha', 'x'.repeat(500)), { ok: true });
  const [operation] = reopened.list();
  assert.equal(operation.attempts, 1);
  assert.equal(operation.last_attempt_at, '2026-10-02T09:05:00.000Z');
  assert.equal(operation.last_reason.length, 120, 'the reason is bounded');
  assert.deepEqual(reopened.noteAttempt('project_missing', 'no_answer'), { ok: true, unchanged: true });

  assert.deepEqual(reopened.clear('project_alpha'), { ok: true });
  assert.deepEqual(new ProjectDeleteJournal(filePath).list(), []);
});

test('list returns copies: a caller cannot edit the journal in memory', () => {
  const journal = new ProjectDeleteJournal(journalPath());
  journal.record('project_alpha');
  journal.list()[0].attempts = 99;
  assert.equal(journal.list()[0].attempts, 0);
});

test('General and malformed ids are refused', () => {
  const journal = new ProjectDeleteJournal(journalPath());
  assert.deepEqual(journal.record(GENERAL_PROJECT_ID), { ok: false, reason: 'invalid_project_id' });
  assert.deepEqual(journal.record('not a project id'), { ok: false, reason: 'invalid_project_id' });
  assert.deepEqual(journal.record(null), { ok: false, reason: 'invalid_project_id' });
  assert.deepEqual(journal.list(), []);
});

test('the journal holds a bounded number of records; re-recording a held project is not growth', () => {
  const journal = new ProjectDeleteJournal(journalPath());
  for (let index = 0; index < MAX_PENDING_PROJECT_DELETES; index += 1) {
    assert.equal(journal.record(`project_bound_${index}`).ok, true);
  }
  assert.deepEqual(journal.record('project_one_too_many'), { ok: false, reason: 'journal_full' });
  assert.equal(journal.record('project_bound_0').ok, true);
  assert.equal(journal.list().length, MAX_PENDING_PROJECT_DELETES);
  assert.equal(journal.clear('project_bound_3').ok, true);
  assert.equal(journal.record('project_one_too_many').ok, true);
});

function preservedCopies(filePath) {
  return fs.readdirSync(path.dirname(filePath))
    .filter((name) => name.startsWith(`${path.basename(filePath)}.corrupt-`));
}

test('a damaged file is moved aside with its bytes intact and the journal starts empty and writable', () => {
  const cases = [
    '{ not json',
    JSON.stringify({ schema_version: 1, operations: {}, extra: true }),
    JSON.stringify({ schema_version: 1, operations: { project_alpha: { project_id: 'project_beta' } } }),
    JSON.stringify([]),
  ];
  for (const content of cases) {
    const filePath = journalPath();
    fs.writeFileSync(filePath, content);
    const journal = new ProjectDeleteJournal(filePath);
    assert.equal(journal.getStatus().read_only, false, content);
    assert.deepEqual(journal.list(), []);
    const copies = preservedCopies(filePath);
    assert.equal(copies.length, 1, content);
    assert.equal(fs.readFileSync(path.join(path.dirname(filePath), copies[0]), 'utf8'), content);
    assert.equal(fs.existsSync(filePath), false, 'nothing is written until a record is');
    assert.deepEqual(journal.record('project_alpha'), { ok: true });
  }
});

test('a newer-schema file, an unreadable file and a damaged file that cannot be moved leave the journal read-only', () => {
  const future = journalPath();
  const futureContent = JSON.stringify({ schema_version: 2, operations: {} });
  fs.writeFileSync(future, futureContent);
  const fromFuture = new ProjectDeleteJournal(future);
  assert.deepEqual(fromFuture.record('project_alpha'), { ok: false, reason: 'future_schema', read_only: true });
  assert.equal(fs.readFileSync(future, 'utf8'), futureContent);
  assert.deepEqual(preservedCopies(future), [], 'a newer build\'s file is not treated as damage');

  // A directory where the file belongs: every read fails with an error code.
  const unreadable = journalPath();
  fs.mkdirSync(unreadable);
  const fromUnreadable = new ProjectDeleteJournal(unreadable);
  assert.deepEqual(fromUnreadable.getStatus().reason, 'unreadable_store');
  assert.deepEqual(fromUnreadable.record('project_alpha'), { ok: false, reason: 'unreadable_store', read_only: true });
  assert.equal(fs.statSync(unreadable).isDirectory(), true);

  // Damaged bytes behind a store whose file is not where the journal thinks it is: nothing to move.
  const unmovable = new ProjectDeleteJournal(journalPath(), {
    store: { readWithStatus: () => ({ value: null, missing: false, corrupted: true, errorCode: null }) },
  });
  assert.deepEqual(unmovable.record('project_alpha'), { ok: false, reason: 'corrupt_store', read_only: true });
});

test('a write that fails or is not durable is refused and leaves the journal unchanged', () => {
  const throwing = new ProjectDeleteJournal(journalPath(), {
    store: {
      readWithStatus: () => ({ value: null, missing: true, corrupted: false }),
      write: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
    },
  });
  assert.deepEqual(throwing.record('project_alpha'), { ok: false, reason: 'write_failed' });
  assert.deepEqual(throwing.list(), []);

  const deferred = new ProjectDeleteJournal(journalPath(), {
    store: {
      readWithStatus: () => ({ value: null, missing: true, corrupted: false }),
      write: () => ({ durable: false }),
    },
  });
  assert.deepEqual(deferred.record('project_alpha'), { ok: false, reason: 'durability_deferred' });
  assert.equal(deferred.has('project_alpha'), false);
});

test('validateJournalDocument rejects records outside the schema', () => {
  const operation = {
    project_id: 'project_alpha', target_project_id: GENERAL_PROJECT_ID,
    created_at: '2026-10-02T09:00:00.000Z', attempts: 0, last_attempt_at: null, last_reason: null,
  };
  const valid = { schema_version: 1, operations: { project_alpha: operation } };
  assert.equal(validateJournalDocument(valid).ok, true);
  const bad = [
    { ...operation, target_project_id: 'project_beta' },
    { ...operation, attempts: -1 },
    { ...operation, attempts: 1.5 },
    { ...operation, created_at: '' },
    { ...operation, last_reason: 'x'.repeat(121) },
    { ...operation, state: 'pending' },
  ];
  for (const candidate of bad) {
    assert.equal(
      validateJournalDocument({ schema_version: 1, operations: { project_alpha: candidate } }).ok, false,
      JSON.stringify(candidate),
    );
  }
  const tooMany = Object.fromEntries(Array.from({ length: MAX_PENDING_PROJECT_DELETES + 1 }, (_unused, index) => [
    `project_many_${index}`, { ...operation, project_id: `project_many_${index}` },
  ]));
  assert.equal(validateJournalDocument({ schema_version: 1, operations: tooMany }).ok, false);
});
