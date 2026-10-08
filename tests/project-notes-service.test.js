'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LEASE_TTL_MS, ProjectNotesService } = require('../services/project-notes-service');
const { MAX_NOTE_CHARS } = require('../services/project-notes-store');

const PROJECT = 'project_alpha';

function withService(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-project-notes-svc-'));
  const clock = { ms: Date.UTC(2026, 9, 6, 12, 0, 0) };
  const logs = [];
  const events = [];
  try {
    const service = new ProjectNotesService({
      userDataPath: root,
      logger: (level, event, details) => logs.push({ level, event, details }),
      now: () => new Date(clock.ms),
    });
    service.on('changed', (payload) => events.push(payload));
    return run({ service, root, clock, logs, events });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function seed(service, text) {
  const result = service.save(PROJECT, text, service.get(PROJECT).note.revision);
  assert.equal(result.ok, true);
  return result.note;
}

describe('ProjectNotesService get/save', () => {
  it('returns the empty note and never exposes previousText or postHash', () => withService(({ service }) => {
    const empty = service.get(PROJECT);
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.note, {
      projectId: PROJECT, text: '', revision: 0, updatedAt: '', updatedBy: 'user', journal: [],
    });

    service.append(PROJECT, { text: 'hello' }, { summary: 'added hello' });
    const note = service.get(PROJECT).note;
    assert.equal(note.journal.length, 1);
    assert.deepEqual(Object.keys(note.journal[0]).sort(), ['at', 'id', 'lines', 'op', 'summary', 'undoable', 'undone']);
    assert.deepEqual(note.journal[0].lines, { added: 1, removed: 0, start: 0 });
    // A newline-terminated note: the appended line is an addition, not an edit of the trailing newline.
    service.save(PROJECT, 'hello\n', note.revision);
    service.append(PROJECT, { text: 'world' }, { summary: 'added world' });
    assert.deepEqual(service.get(PROJECT).note.journal.at(-1).lines, { added: 1, removed: 0, start: 1 });
    assert.equal(note.journal[0].undone, false);
    assert.equal(note.journal[0].undoable, true);
    assert.equal(JSON.stringify(note).includes('previousText'), false);
    assert.equal(JSON.stringify(note).includes('postHash'), false);
  }));

  it('save writes as the user without a journal entry and keeps older entries (now non-undoable)', () => withService(({ service, events }) => {
    service.append(PROJECT, { text: 'jenny line' }, { summary: 's' });
    const before = service.get(PROJECT).note;
    const saved = service.save(PROJECT, 'user rewrite', before.revision);
    assert.equal(saved.ok, true);
    assert.equal(saved.note.text, 'user rewrite');
    assert.equal(saved.note.updatedBy, 'user');
    assert.equal(saved.note.revision, before.revision + 1);
    assert.equal(saved.note.journal.length, 1);
    assert.equal(saved.note.journal[0].undoable, false);
    assert.deepEqual(events.at(-1), {
      projectId: PROJECT, revision: saved.note.revision, updatedBy: 'user', journalEntryId: '', reason: 'save',
    });
  }));

  it('save with a stale baseRevision returns stale + current and writes nothing', () => withService(({ service, events }) => {
    const first = seed(service, 'v1');
    service.append(PROJECT, { text: 'jenny' }, { summary: 's' });
    const eventCount = events.length;
    const stale = service.save(PROJECT, 'overwrite', first.revision);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'stale');
    assert.equal(stale.current.text, 'v1\njenny');
    assert.equal(service.get(PROJECT).note.text, 'v1\njenny');
    assert.equal(events.length, eventCount);
    assert.equal(service.save(PROJECT, 'x', 'nope').reason, 'stale');
  }));

  it('save validates type, strips NUL and enforces the cap', () => withService(({ service }) => {
    assert.equal(service.save(PROJECT, 42, 0).ok, false);
    assert.equal(service.save(PROJECT, 'x'.repeat(MAX_NOTE_CHARS + 1), 0).reason, 'note_full');
    assert.equal(service.get(PROJECT).note.revision, 0);
    assert.equal(service.save(PROJECT, 'a\u0000b', 0).note.text, 'ab');
  }));

  it('invalid project ids return invalid_project_id from every method and log a WARN', () => withService(({ service, logs }) => {
    for (const bad of ['../x', '', 'plain', null, undefined, 7]) {
      assert.deepEqual(service.get(bad), { ok: false, reason: 'invalid_project_id' });
      assert.deepEqual(service.save(bad, 'x', 0), { ok: false, reason: 'invalid_project_id' });
      assert.deepEqual(service.append(bad, { text: 'x' }, {}), { ok: false, reason: 'invalid_project_id' });
      assert.deepEqual(service.replace(bad, { oldText: 'a', newText: 'b' }, {}), { ok: false, reason: 'invalid_project_id' });
      assert.deepEqual(service.undo(bad, 'e'), { ok: false, reason: 'invalid_project_id' });
      assert.deepEqual(service.lease(bad, true), { ok: false, reason: 'invalid_project_id' });
      assert.deepEqual(service.deleteProjectNotes(bad), { ok: false, reason: 'invalid_project_id' });
    }
    assert.equal(service.isLeased('../x'), false);
    assert.equal(logs.length > 0 && logs.every((entry) => entry.level === 'WARN'), true);
    assert.equal(JSON.stringify(logs).includes('../x'), false);
  }));
});

describe('ProjectNotesService append', () => {
  it('appends at the end with exactly one newline separator', () => withService(({ service, events }) => {
    const first = service.append(PROJECT, { text: 'one' }, { summary: 'added one' });
    assert.equal(first.ok, true);
    assert.equal(first.note.text, 'one');
    assert.deepEqual(first.lines, { added: 1, removed: 0, changed: 0 });

    const second = service.append(PROJECT, { text: 'two' }, { summary: 'added two' });
    assert.equal(second.note.text, 'one\ntwo');
    assert.equal(second.note.updatedBy, 'assistant');
    assert.equal(typeof second.journalEntryId, 'string');
    assert.equal(second.note.journal.at(-1).id, second.journalEntryId);
    assert.equal(second.note.journal.at(-1).summary, 'added two');
    assert.deepEqual(events.at(-1), {
      projectId: PROJECT, revision: second.note.revision, updatedBy: 'assistant',
      journalEntryId: second.journalEntryId, reason: 'append',
    });

    seed(service, 'ends with newline\n');
    assert.equal(service.append(PROJECT, { text: 'next' }, {}).note.text, 'ends with newline\nnext');
  }));

  it('inserts at the end of an existing section, before the next heading and trailing blank lines', () => withService(({ service }) => {
    seed(service, '# Notes\n## Status\nrunning\n\n## Todo\n- a\n');
    const result = service.append(PROJECT, { text: 'blocked on review', heading: 'Status' }, { summary: 's' });
    assert.equal(result.note.text, '# Notes\n## Status\nrunning\nblocked on review\n\n## Todo\n- a\n');
    assert.deepEqual(result.headings, ['Status']);
    assert.deepEqual(result.lines, { added: 1, removed: 0, changed: 0 });

    const last = service.append(PROJECT, { text: '- b', heading: 'Todo' }, { summary: 's' });
    assert.equal(last.note.text, '# Notes\n## Status\nrunning\nblocked on review\n\n## Todo\n- a\n- b\n');
    assert.deepEqual(last.headings, ['Todo']);
  }));

  it('creates a missing section at the end and matches headings exactly (case-sensitive)', () => withService(({ service }) => {
    const created = service.append(PROJECT, { text: 'x', heading: 'Ideas' }, { summary: 's' });
    assert.equal(created.note.text, '## Ideas\nx');

    seed(service, 'intro\n## status  \nok');
    const wrongCase = service.append(PROJECT, { text: 'y', heading: 'Status' }, { summary: 's' });
    assert.equal(wrongCase.note.text, 'intro\n## status  \nok\n\n## Status\ny');
    const trailingSpaces = service.append(PROJECT, { text: 'z', heading: 'status' }, { summary: 's' });
    assert.equal(trailingSpaces.note.text, 'intro\n## status  \nok\nz\n\n## Status\ny');
  }));

  it('enforces the cap with note_full and writes nothing', () => withService(({ service, events }) => {
    seed(service, 'x'.repeat(MAX_NOTE_CHARS - 2));
    const eventCount = events.length;
    const result = service.append(PROJECT, { text: 'toolong' }, { summary: 's' });
    assert.deepEqual(result, { ok: false, reason: 'note_full' });
    assert.equal(service.get(PROJECT).note.text.length, MAX_NOTE_CHARS - 2);
    assert.equal(events.length, eventCount);
  }));

  it('rejects empty or non-string text', () => withService(({ service }) => {
    assert.equal(service.append(PROJECT, { text: '' }, {}).reason, 'invalid_text');
    assert.equal(service.append(PROJECT, { text: 5 }, {}).reason, 'invalid_text');
    assert.equal(service.append(PROJECT, null, {}).reason, 'invalid_text');
    assert.equal(service.get(PROJECT).note.revision, 0);
  }));
});

describe('ProjectNotesService replace', () => {
  it('replaces a unique match and reports line counts and headings', () => withService(({ service, events }) => {
    seed(service, '## Status\nold status\n## Todo\n- a');
    const result = service.replace(PROJECT, { oldText: 'old status', newText: 'new status' }, { summary: 'updated status' });
    assert.equal(result.ok, true);
    assert.equal(result.note.text, '## Status\nnew status\n## Todo\n- a');
    assert.deepEqual(result.lines, { added: 0, removed: 0, changed: 1 });
    assert.deepEqual(result.headings, ['Status']);
    assert.equal(events.at(-1).reason, 'replace');
    assert.equal(events.at(-1).journalEntryId, result.journalEntryId);
    assert.equal(result.note.journal.at(-1).op, 'replace');
  }));

  it('treats replacement text literally (no $ pattern expansion) and allows deletion', () => withService(({ service }) => {
    seed(service, 'cost: X\nkeep');
    assert.equal(service.replace(PROJECT, { oldText: 'X', newText: '$& $1' }, {}).note.text, 'cost: $& $1\nkeep');
    const deleted = service.replace(PROJECT, { oldText: 'cost: $& $1\n', newText: '' }, {});
    assert.equal(deleted.note.text, 'keep');
    assert.deepEqual(deleted.lines, { added: 0, removed: 1, changed: 0 });
  }));

  it('reports no_match and ambiguous_match without writing', () => withService(({ service, events }) => {
    seed(service, 'dup\ndup\nuniq');
    const revision = service.get(PROJECT).note.revision;
    const eventCount = events.length;
    assert.deepEqual(service.replace(PROJECT, { oldText: 'missing', newText: 'x' }, {}), { ok: false, reason: 'no_match' });
    assert.deepEqual(service.replace(PROJECT, { oldText: 'dup', newText: 'x' }, {}), { ok: false, reason: 'ambiguous_match' });
    assert.equal(service.replace(PROJECT, { oldText: '', newText: 'x' }, {}).reason, 'invalid_text');
    assert.equal(service.replace(PROJECT, { oldText: 'uniq', newText: 3 }, {}).reason, 'invalid_text');
    assert.equal(service.get(PROJECT).note.revision, revision);
    assert.equal(events.length, eventCount);
  }));

  it('enforces the cap on the resulting note', () => withService(({ service }) => {
    seed(service, `a${'x'.repeat(MAX_NOTE_CHARS - 1)}`);
    assert.deepEqual(service.replace(PROJECT, { oldText: 'a', newText: 'abc' }, {}), { ok: false, reason: 'note_full' });
  }));
});

describe('ProjectNotesService undo', () => {
  it('undoes Jenny writes newest-first, emits an undo event and refuses after a user edit', () => withService(({ service, events }) => {
    const one = service.append(PROJECT, { text: 'a' }, { summary: 'one' });
    const two = service.append(PROJECT, { text: 'b' }, { summary: 'two' });

    const undoneTwo = service.undo(PROJECT, two.journalEntryId);
    assert.equal(undoneTwo.ok, true);
    assert.equal(undoneTwo.note.text, 'a');
    assert.equal(undoneTwo.note.journal.find((entry) => entry.id === two.journalEntryId).undoable, false);
    assert.deepEqual(events.at(-1), {
      projectId: PROJECT, revision: undoneTwo.note.revision, updatedBy: 'user',
      journalEntryId: two.journalEntryId, reason: 'undo',
    });
    assert.deepEqual(service.undo(PROJECT, two.journalEntryId), { ok: false, reason: 'already_undone' });

    service.save(PROJECT, 'a edited', service.get(PROJECT).note.revision);
    assert.deepEqual(service.undo(PROJECT, one.journalEntryId), { ok: false, reason: 'changed_since' });
    assert.deepEqual(service.undo(PROJECT, 'nope'), { ok: false, reason: 'entry_not_found' });
  }));
});

describe('ProjectNotesService edit lease', () => {
  it('blocks append and replace while leased and writes nothing', () => withService(({ service, events }) => {
    seed(service, 'text');
    const eventCount = events.length;
    const lease = service.lease(PROJECT, true);
    assert.equal(lease.ok, true);
    assert.equal(lease.held, true);
    assert.equal(service.isLeased(PROJECT), true);

    assert.deepEqual(service.append(PROJECT, { text: 'x' }, {}), { ok: false, reason: 'note_being_edited' });
    assert.deepEqual(service.replace(PROJECT, { oldText: 'text', newText: 'y' }, {}), { ok: false, reason: 'note_being_edited' });
    assert.equal(service.get(PROJECT).note.text, 'text');
    assert.equal(events.length, eventCount);

    // The renderer's own save is never blocked by its own lease.
    assert.equal(service.save(PROJECT, 'typed', service.get(PROJECT).note.revision).ok, true);

    const released = service.lease(PROJECT, false);
    assert.equal(released.held, false);
    assert.equal(service.append(PROJECT, { text: 'x' }, {}).ok, true);
  }));

  it('expires 30 seconds after the last held call unless renewed', () => withService(({ service, clock }) => {
    const first = service.lease(PROJECT, true);
    assert.equal(first.expiresAt, new Date(clock.ms + LEASE_TTL_MS).toISOString());
    clock.ms += LEASE_TTL_MS - 1;
    assert.equal(service.isLeased(PROJECT), true);
    service.lease(PROJECT, true);
    clock.ms += LEASE_TTL_MS - 1;
    assert.equal(service.isLeased(PROJECT), true);
    clock.ms += 1;
    assert.equal(service.isLeased(PROJECT), false);
    assert.equal(service.append(PROJECT, { text: 'x' }, {}).ok, true);
  }));

  it('keeps one lease per project', () => withService(({ service }) => {
    service.lease(PROJECT, true);
    assert.equal(service.isLeased('project_beta'), false);
    assert.equal(service.append('project_beta', { text: 'x' }, {}).ok, true);
  }));
});

describe('ProjectNotesService deleteProjectNotes', () => {
  it('removes the note and any lease, idempotently', () => withService(({ service, root }) => {
    seed(service, 'text');
    service.lease(PROJECT, true);
    assert.deepEqual(service.deleteProjectNotes(PROJECT), { ok: true });
    assert.deepEqual(service.deleteProjectNotes(PROJECT), { ok: true });
    assert.equal(service.isLeased(PROJECT), false);
    assert.equal(service.get(PROJECT).note.revision, 0);
    assert.equal(fs.existsSync(path.join(root, 'project-notes', `${PROJECT}.json`)), false);
  }));
});

describe('ProjectNotesService fail-closed paths', () => {
  it('reports note_unavailable for a corrupt file and never writes over it', () => withService(({ service, root, logs }) => {
    const dir = path.join(root, 'project-notes');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${PROJECT}.json`);
    fs.writeFileSync(file, '{ not json');
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(service.get(PROJECT), { ok: false, reason: 'note_unavailable' });
      assert.deepEqual(service.append(PROJECT, { text: 'x' }), { ok: false, reason: 'note_unavailable' });
      assert.deepEqual(service.replace(PROJECT, { oldText: 'a', newText: 'b' }), { ok: false, reason: 'note_unavailable' });
      // baseRevision 5: an unusable file must not read as a stale conflict against the empty stand-in (revision 0).
      assert.deepEqual(service.save(PROJECT, 'mine', 5), { ok: false, reason: 'note_unavailable' });
      assert.deepEqual(service.save(PROJECT, 'mine', 0), { ok: false, reason: 'note_unavailable' });
      assert.deepEqual(service.undo(PROJECT, 'pnj_x'), { ok: false, reason: 'note_unavailable' });
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
    assert.ok(logs.every((entry) => !JSON.stringify(entry.details || {}).includes('not json')));
  }));

  it('refuses writes and leases for a project that no longer exists, except General', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-project-notes-svc-exists-'));
    try {
      const live = new Set(['project_live']);
      const service = new ProjectNotesService({ userDataPath: root, projectExists: (id) => live.has(id) });
      assert.equal(service.append('project_live', { text: 'ok' }).ok, true);
      assert.equal(service.append('project_general', { text: 'ok' }).ok, true);
      live.delete('project_live');
      assert.deepEqual(service.append('project_live', { text: 'late' }), { ok: false, reason: 'project_unavailable' });
      assert.deepEqual(service.replace('project_live', { oldText: 'ok', newText: 'x' }), { ok: false, reason: 'project_unavailable' });
      assert.deepEqual(service.save('project_live', 'late autosave', 1), { ok: false, reason: 'project_unavailable' });
      assert.deepEqual(service.lease('project_live', true), { ok: false, reason: 'project_unavailable' });
      assert.equal(service.lease('project_live', false).ok, true);
      // Reads still work (the renderer may be looking at a note the user is about to lose).
      assert.equal(service.get('project_live').note.text, 'ok');
      // A throwing existence check fails open rather than losing a save.
      const flaky = new ProjectNotesService({ userDataPath: root, projectExists: () => { throw new Error('boom'); } });
      assert.equal(flaky.append('project_other', { text: 'ok' }).ok, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
