'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const manifest = require('../services/tools/tool-manifest.json');
const projectNotesTool = require('../services/tools/builtin/project-notes-tool');
const { createDefaultRegistry } = require('../services/tools');
const { ProjectNotesService } = require('../services/project-notes-service');
const { MAX_NOTE_CHARS } = require('../services/project-notes-store');

const AUTHORITY = Object.freeze({ project_id: 'project_a' });

function createStub(overrides = {}) {
  const calls = [];
  const note = { projectId: 'project_a', text: '', revision: 3, updatedAt: '', updatedBy: 'user', journal: [] };
  const write = (name) => (...args) => {
    calls.push({ name, args });
    return {
      ok: true,
      note: { ...note, revision: 4 },
      journalEntryId: 'entry_1',
      lines: { added: 2, removed: 0, changed: 0 },
      headings: ['Conventions'],
    };
  };
  return {
    calls,
    note,
    get: (...args) => { calls.push({ name: 'get', args }); return { ok: true, note }; },
    append: write('append'),
    replace: write('replace'),
    ...overrides,
  };
}

function ctx(service, projectAuthority = AUTHORITY) {
  return { projectNotesService: service, projectAuthority, logger() {}, projectNotesLeaseWaitMs: 0 };
}

test('a write that meets the editor lease waits for the pause and lands in the same call (row 21 gate)', async () => {
  let leased = 3; // the user pauses: the lease clears after three polls
  const service = createStub({
    append: (...args) => (leased-- > 0 ? { ok: false, reason: 'note_being_edited' } : createStub().append(...args)),
  });
  const slept = [];
  const result = await projectNotesTool.execute(
    { action: 'append', text: 'after the pause' },
    { ...ctx(service), projectNotesLeaseWaitMs: 6000, sleep: async (ms) => { slept.push(ms); } },
  );
  assert.equal(result.isError, false, 'the write lands once the lease is free');
  assert.equal(slept.length, 3);
});

test('a write under a lease that never clears reports note_being_edited after the bounded wait', async () => {
  const service = createStub({ append: () => ({ ok: false, reason: 'note_being_edited' }) });
  const slept = [];
  const result = await projectNotesTool.execute(
    { action: 'append', text: 'still typing' },
    { ...ctx(service), projectNotesLeaseWaitMs: 1000, sleep: async (ms) => { slept.push(ms); } },
  );
  assert.equal(result.metadata.reason, 'note_being_edited');
  assert.equal(slept.reduce((a, b) => a + b, 0), 1000, 'waits the bound, no longer');
});

test('read returns the note text with revision and size metadata', async () => {
  const service = createStub();
  service.note.text = '# Notes\nUse pnpm.\n';
  const result = await projectNotesTool.execute({ action: 'read' }, ctx(service));

  assert.equal(result.isError, false);
  assert.equal(result.content, '# Notes\nUse pnpm.\n');
  assert.deepEqual(result.metadata, {
    result_kind: 'project_notes',
    action: 'read',
    status: 'ok',
    project_id: 'project_a',
    revision: 3,
    chars: 18,
    updated_at: '',
    updated_by: 'user',
  });
  assert.deepEqual(service.calls, [{ name: 'get', args: ['project_a'] }]);
});

test('read of a blank note says so in plain English', async () => {
  const result = await projectNotesTool.execute({ action: 'read' }, ctx(createStub()));

  assert.equal(result.isError, false);
  assert.equal(result.content, 'Project notes are empty.');
  assert.equal(result.metadata.chars, 0);
});

test('append forwards text, heading and summary and reports the line count and undo', async () => {
  const service = createStub();
  const result = await projectNotesTool.execute(
    { action: 'append', text: 'Run lint first.\nThen tests.', heading: 'Conventions', summary: 'Added lint rule' },
    ctx(service)
  );

  assert.equal(result.isError, false);
  assert.equal(
    result.content,
    'Added 2 lines to the project notes.\nUndo: available in the chat and the Notes rail.'
  );
  assert.deepEqual(service.calls, [{
    name: 'append',
    args: ['project_a', { text: 'Run lint first.\nThen tests.', heading: 'Conventions' }, { summary: 'Added lint rule' }],
  }]);
  assert.deepEqual(result.metadata, {
    result_kind: 'project_notes',
    action: 'append',
    status: 'ok',
    project_id: 'project_a',
    revision: 4,
    journal_entry_id: 'entry_1',
    summary: 'Added lint rule',
    lines: { added: 2, removed: 0, changed: 0 },
    headings: ['Conventions'],
  });
});

test('append without a summary stores a bounded default summary', async () => {
  const service = createStub();
  const plain = await projectNotesTool.execute({ action: 'append', text: 'x' }, ctx(service));
  const headed = await projectNotesTool.execute(
    { action: 'append', text: 'x', heading: 'Open questions' },
    ctx(service)
  );

  assert.equal(plain.metadata.summary, 'Added to the notes');
  assert.equal(headed.metadata.summary, 'Added under "Open questions"');
  assert.equal(service.calls[0].args[2].summary, 'Added to the notes');
  assert.equal(service.calls[1].args[1].heading, 'Open questions');
});

test('replace forwards both passages, allows an empty new_text and renders the line delta', async () => {
  const service = createStub();
  service.replace = (...args) => {
    service.calls.push({ name: 'replace', args });
    return {
      ok: true,
      note: { ...service.note, revision: 9 },
      journalEntryId: 'entry_9',
      lines: { added: 1, removed: 3, changed: 0 },
      headings: [],
    };
  };
  const result = await projectNotesTool.execute(
    { action: 'replace', old_text: 'old passage', new_text: '' },
    ctx(service)
  );

  assert.equal(result.isError, false);
  assert.equal(
    result.content,
    'Replaced a passage in the project notes (+1 −3).\nUndo: available in the chat and the Notes rail.'
  );
  assert.deepEqual(service.calls[0].args.slice(0, 2), ['project_a', { oldText: 'old passage', newText: '' }]);
  assert.equal(result.metadata.action, 'replace');
  assert.equal(result.metadata.revision, 9);
  assert.equal(result.metadata.journal_entry_id, 'entry_9');
  assert.deepEqual(result.metadata.lines, { added: 1, removed: 3, changed: 0 });
});

test('service refusals map to specific failure reasons and plain-English guidance', async () => {
  const expectations = {
    note_being_edited: /editing the project notes right now/,
    no_match: /old_text was not found/,
    ambiguous_match: /more than once/,
    note_full: /20,000-character limit/,
    invalid_text: /text/i,
    write_failed: /could not be saved/i,
    invalid_project_id: /no project/,
  };
  for (const [reason, pattern] of Object.entries(expectations)) {
    const service = createStub({
      append: () => ({ ok: false, reason }),
      replace: () => ({ ok: false, reason }),
    });
    for (const input of [
      { action: 'append', text: 'x' },
      { action: 'replace', old_text: 'a', new_text: 'b' },
    ]) {
      const result = await projectNotesTool.execute(input, ctx(service));
      assert.equal(result.isError, true, `${reason}/${input.action}`);
      assert.equal(result.metadata.status, 'failed');
      assert.equal(result.metadata.result_kind, 'project_notes');
      assert.equal(result.metadata.reason, reason === 'invalid_project_id' ? 'project_unavailable' : reason);
      assert.match(result.content, pattern, `${reason}/${input.action}`);
    }
  }
});

test('a failed read from the service is a clean tool error', async () => {
  const service = createStub({ get: () => ({ ok: false, reason: 'write_failed' }) });
  const result = await projectNotesTool.execute({ action: 'read' }, ctx(service));

  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'write_failed');
});

test('a chat with no project fails every action and never calls the service', async () => {
  const service = createStub();
  for (const authority of [undefined, null, {}, { project_id: '' }, { project_id: '../x' }]) {
    for (const input of [
      { action: 'read' },
      { action: 'append', text: 'x' },
      { action: 'replace', old_text: 'a', new_text: 'b' },
    ]) {
      const result = await projectNotesTool.execute(input, { projectNotesService: service, projectAuthority: authority });
      assert.equal(result.isError, true);
      assert.equal(result.metadata.reason, 'project_unavailable');
      assert.equal(result.content, 'The chat has no project; project notes are unavailable.');
    }
  }
  assert.deepEqual(service.calls, []);
});

test('the project comes from the trusted authority, never from model arguments', async () => {
  const service = createStub();
  await projectNotesTool.execute(
    { action: 'append', text: 'x', project_id: 'project_evil', projectId: 'project_evil' },
    ctx(service)
  );

  assert.equal(service.calls[0].args[0], 'project_a');
  assert.equal(JSON.stringify(service.calls[0].args).includes('project_evil'), false);
});

test('a missing service is service_unavailable and a throwing service is write_failed', async () => {
  const missing = await projectNotesTool.execute({ action: 'read' }, { projectAuthority: AUTHORITY });
  assert.equal(missing.isError, true);
  assert.equal(missing.metadata.reason, 'service_unavailable');

  const logged = [];
  const throwing = createStub({ get: () => { throw new Error('secret note text'); } });
  const result = await projectNotesTool.execute(
    { action: 'read' },
    { ...ctx(throwing), logger: (...args) => logged.push(args) }
  );
  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'write_failed');
  assert.equal(JSON.stringify(logged).includes('secret note text'), false);
});

test('input validation refuses before any service call', async () => {
  const service = createStub();
  const cases = [
    [{ action: 'append' }, 'invalid_text'],
    [{ action: 'append', text: '' }, 'invalid_text'],
    [{ action: 'append', text: '   ' }, 'invalid_text'],
    [{ action: 'append', text: 42 }, 'invalid_text'],
    [{ action: 'append', text: 'x'.repeat(4001) }, 'invalid_input'],
    [{ action: 'append', text: 'x', heading: 'h'.repeat(121) }, 'invalid_input'],
    [{ action: 'append', text: 'x', heading: 7 }, 'invalid_input'],
    [{ action: 'append', text: 'x', summary: 's'.repeat(141) }, 'invalid_input'],
    [{ action: 'replace', new_text: 'b' }, 'invalid_text'],
    [{ action: 'replace', old_text: '', new_text: 'b' }, 'invalid_text'],
    [{ action: 'replace', old_text: 'a' }, 'invalid_text'],
    [{ action: 'replace', old_text: 'a', new_text: 5 }, 'invalid_text'],
    [{ action: 'replace', old_text: 'a'.repeat(MAX_NOTE_CHARS + 1), new_text: 'b' }, 'invalid_input'],
    [{ action: 'frobnicate' }, 'unsupported_action'],
    [{}, 'unsupported_action'],
  ];
  for (const [input, reason] of cases) {
    const label = JSON.stringify(input).slice(0, 60);
    const result = await projectNotesTool.execute(input, ctx(service));
    assert.equal(result.isError, true, label);
    assert.equal(result.metadata.reason, reason, label);
  }
  assert.deepEqual(service.calls, []);
});

test('append at exactly the field limits is accepted', async () => {
  const service = createStub();
  const result = await projectNotesTool.execute(
    { action: 'append', text: 'x'.repeat(4000), heading: 'h'.repeat(120), summary: 's'.repeat(140) },
    ctx(service)
  );
  assert.equal(result.isError, false);
  assert.equal(result.metadata.summary.length, 140);
});

test('summarize names the action without echoing note text', () => {
  assert.equal(projectNotesTool.summarize({ action: 'append', text: 'private' }), 'Project notes: append');
  assert.equal(projectNotesTool.summarize({}), 'Project notes: action');
  assert.equal(projectNotesTool.summarize(null), 'Project notes: action');
});

test('manifest and builtin descriptions are identical and the tool registers behind its flag', () => {
  const entry = manifest.tools.find((tool) => tool.name === 'project_notes');
  assert.ok(entry);
  assert.equal(projectNotesTool.description, entry.description);
  assert.equal(
    createDefaultRegistry({}).getAllTools().some((tool) => tool.name === 'project_notes'),
    false
  );
  assert.equal(
    createDefaultRegistry({ toolsProjectNotesEnabled: true })
      .getAllTools()
      .some((tool) => tool.name === 'project_notes'),
    true
  );
});

test('append and replace round trip through the real service and the lease and cap hold', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-notes-tool-'));
  try {
    const service = new ProjectNotesService({ userDataPath: dir, logger() {} });
    const added = await projectNotesTool.execute({ action: 'append', text: 'First line.' }, ctx(service));
    assert.equal(added.isError, false);
    assert.equal(added.content.startsWith('Added 1 line to the project notes.'), true);
    const replaced = await projectNotesTool.execute(
      { action: 'replace', old_text: 'First', new_text: 'Second' },
      ctx(service)
    );
    assert.equal(replaced.isError, false);
    const read = await projectNotesTool.execute({ action: 'read' }, ctx(service));
    assert.equal(read.content, 'Second line.');
    assert.equal(read.metadata.revision, 2);

    service.lease('project_a', true);
    const blocked = await projectNotesTool.execute({ action: 'append', text: 'nope' }, ctx(service));
    assert.equal(blocked.metadata.reason, 'note_being_edited');
    // Retry unchanged once the user pauses, not "never" (row 21 gate).
    assert.equal(blocked.metadata.failure_class, 'transient');
    assert.equal(blocked.metadata.effects, 'none');
    service.lease('project_a', false);

    const fill = await projectNotesTool.execute(
      { action: 'replace', old_text: 'Second line.', new_text: 'x'.repeat(MAX_NOTE_CHARS - 10) },
      ctx(service)
    );
    assert.equal(fill.isError, false);
    const full = await projectNotesTool.execute({ action: 'append', text: 'y'.repeat(50) }, ctx(service));
    assert.equal(full.metadata.reason, 'note_full');
    assert.equal(full.metadata.failure_class, undefined, 'other failures keep their error code class');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
