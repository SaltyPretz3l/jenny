'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_JOURNAL_ENTRIES,
  MAX_NOTE_CHARS,
  ProjectNotesStore,
  sha256,
} = require('../services/project-notes-store');

const PROJECT = 'project_alpha';

function withStore(run, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-project-notes-'));
  const logs = [];
  let tick = 0;
  try {
    const store = new ProjectNotesStore({
      userDataPath: root,
      logger: (level, event, details) => logs.push({ level, event, details }),
      now: () => new Date(Date.UTC(2026, 9, 6, 12, 0, tick++)),
      ...options,
    });
    return run({ store, root, logs });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function journalWrite(store, text, summary = 'wrote') {
  return store.write(PROJECT, {
    text,
    updatedBy: 'assistant',
    journalEntry: { op: 'append', summary },
  });
}

describe('ProjectNotesStore persistence', () => {
  it('reads a missing file as the empty note, then round-trips a write', () => withStore(({ store, root }) => {
    const empty = store.read(PROJECT);
    assert.equal(empty.text, '');
    assert.equal(empty.revision, 0);
    assert.deepEqual(empty.journal, []);

    const written = store.write(PROJECT, { text: 'hello', updatedBy: 'user' });
    assert.equal(written.revision, 1);
    assert.equal(written.updatedBy, 'user');
    assert.match(written.updatedAt, /^2026-10-06T/u);
    assert.equal(fs.existsSync(path.join(root, 'project-notes', `${PROJECT}.json`)), true);

    const reread = store.read(PROJECT);
    assert.deepEqual(reread, written);
    assert.equal(store.write(PROJECT, { text: 'hello 2', updatedBy: 'user' }).revision, 2);
    assert.deepEqual(store.listProjects(), [PROJECT]);
  }));

  it('strips NUL, keeps whitespace, and enforces the character cap', () => withStore(({ store }) => {
    const written = store.write(PROJECT, { text: '  a\u0000b  \n', updatedBy: 'user' });
    assert.equal(written.text, '  ab  \n');

    store.write(PROJECT, { text: 'x'.repeat(MAX_NOTE_CHARS), updatedBy: 'user' });
    assert.throws(
      () => store.write(PROJECT, { text: 'x'.repeat(MAX_NOTE_CHARS + 1), updatedBy: 'user' }),
      (error) => error.code === 'note_full'
    );
    assert.equal(store.read(PROJECT).text.length, MAX_NOTE_CHARS);
  }));

  it('reads a malformed file as the empty note and logs a WARN', () => withStore(({ store, root, logs }) => {
    const dir = path.join(root, 'project-notes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${PROJECT}.json`), '{ not json');
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const record = store.read(PROJECT);
      assert.equal(record.text, '');
      assert.equal(record.revision, 0);
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(logs.some((entry) => entry.level === 'WARN' && entry.event === 'project_notes.store_unreadable'), true);

    fs.writeFileSync(path.join(dir, `${PROJECT}.json`), JSON.stringify({ version: 99, text: 'x' }));
    assert.equal(store.read(PROJECT).text, '');
  }));

  it('refuses every write while the file on disk cannot be used, leaving its bytes alone', () => withStore(({ store, root }) => {
    const dir = path.join(root, 'project-notes');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${PROJECT}.json`);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      for (const bytes of ['{ not json', JSON.stringify({ version: 99, text: 'future note' })]) {
        fs.writeFileSync(file, bytes);
        assert.equal(store.readStatus(PROJECT).unavailable, true);
        assert.throws(
          () => store.write(PROJECT, { text: 'clobber', updatedBy: 'assistant', journalEntry: { op: 'append', summary: 'x' } }),
          (error) => error.code === 'note_unavailable'
        );
        assert.deepEqual(store.undo(PROJECT, 'pnj_any'), { ok: false, reason: 'note_unavailable' });
        assert.equal(fs.readFileSync(file, 'utf8'), bytes);
      }
    } finally {
      console.error = originalConsoleError;
    }
    // A missing file is simply the empty note and stays writable.
    fs.rmSync(file);
    assert.equal(store.readStatus(PROJECT).unavailable, false);
    assert.equal(store.write(PROJECT, { text: 'fresh', updatedBy: 'user' }).text, 'fresh');
  }));

  it('rejects ids that could escape the notes directory before touching the filesystem', () => withStore(({ store, root }) => {
    for (const bad of ['../x', 'project_general/..', 'project_a/../../b', '', 'plain', 'project_', null, 42]) {
      assert.throws(() => store.read(bad), TypeError, String(bad));
      assert.throws(() => store.write(bad, { text: 'x', updatedBy: 'user' }), TypeError);
      assert.throws(() => store.undo(bad, 'e'), TypeError);
      assert.throws(() => store.deleteProject(bad), TypeError);
    }
    assert.equal(fs.existsSync(path.join(root, 'project-notes')), false);
  }));

  it('persists before adopting: a throwing disk leaves the stored note unchanged', () => {
    let failWrites = false;
    withStore(({ store }) => {
      journalWrite(store, 'first');
      failWrites = true;
      assert.throws(() => journalWrite(store, 'second'), /disk full/u);
      failWrites = false;
      const record = store.read(PROJECT);
      assert.equal(record.text, 'first');
      assert.equal(record.revision, 1);
      assert.equal(record.journal.length, 1);
    }, {
      fileStoreFactory: (filePath, options) => {
        const { FileJsonStore } = require('../services/backend/file-json-store');
        const inner = new FileJsonStore(filePath, options);
        const originalWrite = inner.writeImmediate.bind(inner);
        inner.writeImmediate = (value) => {
          if (failWrites) throw new Error('disk full');
          return originalWrite(value);
        };
        return inner;
      },
    });
  });

  it('deleteProject removes the file and is idempotent', () => withStore(({ store }) => {
    store.write(PROJECT, { text: 'x', updatedBy: 'user' });
    store.deleteProject(PROJECT);
    store.deleteProject(PROJECT);
    assert.deepEqual(store.listProjects(), []);
    assert.equal(store.read(PROJECT).revision, 0);
  }));
});

describe('ProjectNotesStore journal and undo', () => {
  it('records previousText and a postHash, and undo restores previousText exactly', () => withStore(({ store }) => {
    store.write(PROJECT, { text: '  keep\n', updatedBy: 'user' });
    const after = journalWrite(store, '  keep\nnew line', 'added a line');
    const entry = after.journal[0];
    assert.equal(entry.op, 'append');
    assert.equal(entry.summary, 'added a line');
    assert.equal(entry.previousText, '  keep\n');
    assert.equal(entry.postHash, sha256('  keep\nnew line'));
    assert.equal(entry.undoneAt, '');
    assert.equal(store.isUndoable(after, entry.id), true);

    const undone = store.undo(PROJECT, entry.id);
    assert.equal(undone.ok, true);
    assert.equal(undone.record.text, '  keep\n');
    assert.equal(undone.record.updatedBy, 'user');
    assert.equal(undone.record.revision, after.revision + 1);
    assert.equal(undone.record.journal.length, 1);
    assert.notEqual(undone.record.journal[0].undoneAt, '');
    assert.equal(store.read(PROJECT).text, '  keep\n');
  }));

  it('supports stack undo newest-first and refuses out-of-order undo', () => withStore(({ store }) => {
    const one = journalWrite(store, 'a');
    const two = journalWrite(store, 'a\nb');
    const firstId = one.journal[0].id;
    const secondId = two.journal[1].id;

    assert.deepEqual(store.undo(PROJECT, firstId), { ok: false, reason: 'changed_since' });
    assert.equal(store.undo(PROJECT, secondId).record.text, 'a');
    assert.equal(store.undo(PROJECT, firstId).record.text, '');
    assert.equal(store.read(PROJECT).journal.length, 2);
  }));

  it('refuses undo after any user edit, and when undone twice or unknown', () => withStore(({ store }) => {
    const first = journalWrite(store, 'a');
    const second = journalWrite(store, 'a\nb');
    const secondId = second.journal[1].id;
    const firstId = first.journal[0].id;

    const edited = store.write(PROJECT, { text: 'a\nb!', updatedBy: 'user' });
    assert.equal(store.isUndoable(edited, secondId), false);
    assert.equal(store.isUndoable(edited, firstId), false);
    assert.deepEqual(store.undo(PROJECT, secondId), { ok: false, reason: 'changed_since' });
    assert.deepEqual(store.undo(PROJECT, firstId), { ok: false, reason: 'changed_since' });
    assert.deepEqual(store.undo(PROJECT, 'pnj_missing'), { ok: false, reason: 'entry_not_found' });

    // Typing the identical text back is not a change the hash can see.
    const restored = store.write(PROJECT, { text: 'a\nb', updatedBy: 'user' });
    assert.equal(store.isUndoable(restored, secondId), true);
    assert.equal(store.undo(PROJECT, secondId).ok, true);
    assert.deepEqual(store.undo(PROJECT, secondId), { ok: false, reason: 'already_undone' });
  }));

  it('keeps only the last ten Jenny writes', () => withStore(({ store }) => {
    let record = null;
    for (let index = 0; index < MAX_JOURNAL_ENTRIES + 3; index += 1) {
      record = journalWrite(store, `line ${index}`, `write ${index}`);
    }
    assert.equal(record.journal.length, MAX_JOURNAL_ENTRIES);
    assert.equal(record.journal[0].summary, 'write 3');
    assert.equal(record.journal.at(-1).summary, `write ${MAX_JOURNAL_ENTRIES + 2}`);
    assert.equal(store.read(PROJECT).journal.length, MAX_JOURNAL_ENTRIES);
  }));

  it('bounds the stored summary and leaves user writes out of the journal', () => withStore(({ store }) => {
    const record = journalWrite(store, 'x', 's'.repeat(500));
    assert.equal(record.journal[0].summary.length, 200);
    const userWrite = store.write(PROJECT, { text: 'y', updatedBy: 'user' });
    assert.equal(userWrite.journal.length, 1);
  }));
});
