'use strict';

// Fault injection for the smaller JSON stores: the Home AI journal (rows J1-J6),
// per-project notes (N1, N3, N4) and tool settings inside a shell config (K1);
// see docs/plans/PERSISTENCE_FAULTS_2026-10-26.md. Crash rows run a child that
// SIGKILLs itself around a real rename; fixtures at the current schema are
// written by the real stores and only the damage or re-stamp is applied by hand.
// No sleeps.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ShellConfigService } = require('../services/shell-config-service');
const { TOOL_SETTING_KEYS, getToolConfigDefaults } = require('../services/tool-config-schema');
const {
  FIXED_NOW,
  JOURNAL_FILE,
  NOTE_FILE,
  PROJECT_ID,
  journalEntryFor,
  noteTextFor,
  openJournal,
  openNotes,
} = require('./helpers/home-journal-notes-fault-child');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
  trackProcess,
} = require('./helpers/resource-cleanup');

const CHILD = path.join(__dirname, 'helpers', 'home-journal-notes-fault-child.js');

function tmpOrphanPattern(name) {
  return new RegExp(`^${name.replace(/\./g, '\\.')}\\.\\d{10,16}\\.[0-9a-f]{12}\\.tmp$`);
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function newProfile() {
  return createTrackedTempDir('jenny-journal-notes-faults-');
}

function collector() {
  const events = [];
  return { events, logger: (level, event, data) => events.push({ level, event, data }) };
}

function listDir(dir) {
  return fs.readdirSync(dir).sort();
}

function journalPath(dir) {
  return path.join(dir, JOURNAL_FILE);
}

function notesDir(dir) {
  return path.join(dir, 'project-notes');
}

function notePath(dir) {
  return path.join(notesDir(dir), NOTE_FILE);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function replaceOnce(text, from, to) {
  const index = text.indexOf(from);
  assert.notEqual(index, -1, `fixture text not found: ${from}`);
  assert.equal(text.indexOf(from, index + 1), -1, `fixture text not unique: ${from}`);
  return text.slice(0, index) + to + text.slice(index + from.length);
}

function restamp(file, version) {
  const parsed = readJson(file);
  parsed.version = version;
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
}

function runCrashChild(kind, dir, mode, killAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, kind, dir, mode, String(killAt)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackProcess(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stderr, acks: stdout.split('\n').filter(Boolean).map(Number) });
    });
  });
}

function assertChildKilled(run, killAt) {
  assert.notEqual(run.code, 0, `child must not exit cleanly (signal=${run.signal}, stderr=${run.stderr})`);
  assert.deepEqual(run.acks, Array.from({ length: killAt - 1 }, (_, index) => index + 1));
}

function attempt(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

const CRASH_POINTS = [['kill-before', 1], ['kill-before', 3], ['kill-after', 1], ['kill-after', 3]];

// ------------------------------------------------------------------- J1

for (const [mode, killAt] of CRASH_POINTS) {
  test(`J1 ${mode} at append ${killAt}: every acknowledged entry loads, the in-flight one is whole or absent`, { timeout: 60000 }, async () => {
    const dir = newProfile();
    const run = await runCrashChild('journal', dir, mode, killAt);
    assertChildKilled(run, killAt);
    const survivingSeq = mode === 'kill-before' ? killAt - 1 : killAt;

    if (survivingSeq > 0) {
      const parsed = readJson(journalPath(dir));
      assert.equal(parsed.version, 1);
      assert.equal(parsed.entries.length, survivingSeq, 'the file on disk is parseable and not torn');
    } else {
      assert.equal(fs.existsSync(journalPath(dir)), false, 'no append completed, so no journal file');
    }
    const orphans = listDir(dir).filter((name) => name.endsWith('.tmp'));
    if (mode === 'kill-before') {
      assert.equal(orphans.length, 1, `exactly the in-flight temp file is left: ${orphans}`);
      assert.match(orphans[0], tmpOrphanPattern(JOURNAL_FILE));
    } else {
      assert.deepEqual(orphans, [], 'the rename consumed the temp file');
    }

    const store = openJournal(dir);
    const expected = Array.from({ length: survivingSeq }, (_, index) => `jnl_${index + 1}`);
    assert.deepEqual(store.list().map((entry) => entry.id), expected);
    assert.deepEqual(
      store.list().map((entry) => entry.label),
      expected.map((_id, index) => `reminder ${index + 1}`)
    );

    store.append(journalEntryFor(99), FIXED_NOW);
    assert.deepEqual(openJournal(dir).list().map((entry) => entry.id), [...expected, 'jnl_99'], 'writable after the crash');
  });
}

// ------------------------------------------------------------- J2 / J3 / J4 / J5 / J6

function seedJournal(count = 3) {
  const dir = newProfile();
  const store = openJournal(dir);
  for (let seq = 1; seq <= count; seq += 1) store.append(journalEntryFor(seq), FIXED_NOW);
  return { dir, bytes: fs.readFileSync(journalPath(dir)) };
}

function preservedJournalCopies(dir) {
  return listDir(dir).filter((name) => name.startsWith(`${JOURNAL_FILE}.corrupt-`));
}

function assertJournalDamageHandled(dir, damagedBytes) {
  fs.writeFileSync(journalPath(dir), damagedBytes);
  const { events, logger } = collector();
  const store = openJournal(dir, logger);
  assert.deepEqual(store.list(), [], 'a damaged journal serves an empty history');

  store.append(journalEntryFor(50), FIXED_NOW);

  const copies = preservedJournalCopies(dir);
  assert.equal(copies.length, 1, `the damaged bytes must be moved aside, found: ${listDir(dir)}`);
  assert.match(copies[0], /^home-ai-journal\.json\.corrupt-\d{10,16}$/);
  assert.ok(Buffer.from(damagedBytes).equals(fs.readFileSync(path.join(dir, copies[0]))), 'preserved bytes intact');
  const fresh = readJson(journalPath(dir));
  assert.deepEqual(fresh.entries.map((entry) => entry.id), ['jnl_50']);
  const preserved = events.filter((entry) => entry.event === 'store.corrupt_file_preserved');
  assert.equal(preserved.length, 1, `one typed preserve event, got: ${events.map((e) => e.event)}`);
  assert.equal(preserved[0].data.preservedName, copies[0]);
}

test('J2 a truncated journal is preserved before an append writes a fresh file', () => {
  const { dir, bytes } = seedJournal();
  assertJournalDamageHandled(dir, bytes.subarray(0, Math.floor(bytes.length / 2)));
});

test('J2 a flipped structural byte in the journal is preserved before an append', () => {
  const { dir, bytes } = seedJournal();
  assertJournalDamageHandled(dir, Buffer.from(replaceOnce(bytes.toString('utf8'), '"entries":', '"entries";'), 'utf8'));
});

for (const [label, text] of [
  ['a top-level array', '[1,2]'],
  ['entries that is not an array', '{"version":1,"entries":"x"}'],
]) {
  test(`J3 valid JSON of the wrong shape (${label}) is preserved before an append`, () => {
    assertJournalDamageHandled(seedJournal().dir, Buffer.from(text, 'utf8'));
  });
}

test('J4 an unreadable journal serves nothing and refuses appends, bytes untouched', (t) => {
  const { dir, bytes } = seedJournal();
  const target = journalPath(dir);
  const realRead = fs.readFileSync;
  fs.readFileSync = function busyRead(file, ...rest) {
    if (typeof file === 'string' && path.resolve(file) === path.resolve(target)) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return realRead.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });

  const store = openJournal(dir);
  assert.deepEqual(store.list(), [], 'nothing is served from a file that could not be read');
  fs.readFileSync = realRead;

  const threw = attempt(() => store.append(journalEntryFor(50), FIXED_NOW));
  assert.ok(bytes.equals(realRead(target)), 'the unreadable journal bytes must not be replaced');
  assert.ok(threw, 'append must be refused while the journal could not be read');
});

test('J5 a journal stamped with a future version is not served, not rewritten', () => {
  const { dir } = seedJournal();
  restamp(journalPath(dir), 2);
  const stamped = fs.readFileSync(journalPath(dir));

  const store = openJournal(dir);
  assert.deepEqual(store.list(), [], 'nothing is served from a format this build does not know');
  const threw = attempt(() => store.append(journalEntryFor(50), FIXED_NOW));
  assert.ok(stamped.equals(fs.readFileSync(journalPath(dir))), 'a v2 journal must not be rewritten as v1');
  assert.ok(threw, 'append must be refused for a future-version journal');
});

test('J6 constructing a store over a valid journal writes nothing and lists the same entries', () => {
  const { dir, bytes } = seedJournal();
  const before = openJournal(dir).list();
  const listing = listDir(dir);
  const second = openJournal(dir);
  assert.ok(bytes.equals(fs.readFileSync(journalPath(dir))), 'construction does not rewrite the file');
  assert.deepEqual(listDir(dir), listing);
  assert.deepEqual(second.list(), before);
  assert.equal(second.list().length, 3);
});

// ------------------------------------------------------------------- N1

for (const [mode, killAt] of CRASH_POINTS) {
  test(`N1 ${mode} at note write ${killAt}: the last acknowledged text loads whole`, { timeout: 60000 }, async () => {
    const dir = newProfile();
    const run = await runCrashChild('notes', dir, mode, killAt);
    assertChildKilled(run, killAt);
    const survivingSeq = mode === 'kill-before' ? killAt - 1 : killAt;

    if (survivingSeq > 0) {
      const parsed = readJson(notePath(dir));
      assert.equal(parsed.text, noteTextFor(survivingSeq), 'the note file is parseable and not torn');
      assert.equal(parsed.revision, survivingSeq);
    } else {
      assert.equal(fs.existsSync(notePath(dir)), false, 'no write completed, so no note file');
    }
    const orphans = listDir(notesDir(dir)).filter((name) => name.endsWith('.tmp'));
    if (mode === 'kill-before') {
      assert.equal(orphans.length, 1, `exactly the in-flight temp file is left: ${orphans}`);
      assert.match(orphans[0], tmpOrphanPattern(NOTE_FILE));
    } else {
      assert.deepEqual(orphans, [], 'the rename consumed the temp file');
    }

    const store = openNotes(dir);
    const status = store.readStatus(PROJECT_ID);
    assert.equal(status.unavailable, false);
    assert.equal(status.record.text, survivingSeq ? noteTextFor(survivingSeq) : '');
    store.write(PROJECT_ID, { text: 'after crash', updatedBy: 'user' });
    assert.equal(openNotes(dir).read(PROJECT_ID).text, 'after crash', 'writable after the crash');
  });
}

// ------------------------------------------------------------------- N3 / N4

function seedNote() {
  const dir = newProfile();
  const store = openNotes(dir);
  store.write(PROJECT_ID, { text: 'first', updatedBy: 'user' });
  const record = store.write(PROJECT_ID, {
    text: 'second',
    updatedBy: 'assistant',
    journalEntry: { op: 'replace', summary: 'rewrote the note', lines: { added: 1, removed: 1, start: 0 } },
  });
  return { dir, record };
}

test('N3 a note stamped with a future version is unavailable, write and undo are refused, bytes intact', () => {
  const { dir, record } = seedNote();
  restamp(notePath(dir), 2);
  const stamped = fs.readFileSync(notePath(dir));

  const store = openNotes(dir);
  const status = store.readStatus(PROJECT_ID);
  assert.equal(status.unavailable, true);
  assert.equal(status.record.text, '', 'reads see the empty note');
  assert.throws(
    () => store.write(PROJECT_ID, { text: 'overwrite', updatedBy: 'user' }),
    (error) => error.code === 'note_unavailable'
  );
  assert.deepEqual(store.undo(PROJECT_ID, record.journal[0].id), { ok: false, reason: 'note_unavailable' });
  assert.ok(stamped.equals(fs.readFileSync(notePath(dir))), 'bytes identical');
  assert.deepEqual(listDir(notesDir(dir)), [NOTE_FILE], 'nothing else was written');
});

test('N4 a new store instance reads a deep-equal record and writes nothing', () => {
  const { dir, record } = seedNote();
  const bytes = fs.readFileSync(notePath(dir));
  const listing = listDir(notesDir(dir));

  const reopened = openNotes(dir);
  assert.deepEqual(reopened.read(PROJECT_ID), record);
  assert.equal(reopened.readStatus(PROJECT_ID).unavailable, false);
  assert.deepEqual(reopened.listProjects(), [PROJECT_ID]);
  assert.ok(bytes.equals(fs.readFileSync(notePath(dir))), 'reads do not rewrite the file');
  assert.deepEqual(listDir(notesDir(dir)), listing);
});

// ------------------------------------------------------------------- K1

function openShellConfig(dir, events = []) {
  return new ShellConfigService({
    userDataPath: dir,
    env: {},
    nowProvider: () => FIXED_NOW,
    logger: (level, event, data) => events.push({ level, event, data }),
  });
}

function seedToolSettings() {
  const dir = newProfile();
  const service = openShellConfig(dir);
  service.updateFeatureSettings({ tools: { worktree: true, imageRead: true } });
  const file = path.join(dir, 'shell-config.json');
  const stored = readJson(file);
  assert.equal(stored.tools.worktree, true, 'fixture: the user setting is saved');
  assert.equal(stored.tools.imageRead, true, 'fixture: the user setting is saved');
  return { dir, file, stored };
}

// Every tool setting is a boolean toggle, so "wrong type" is the whole fault
// space (a number or NaN has no meaning for any key). Contract (K1, adjusted):
// a present key that is not exactly `true` reads as off, whatever the default,
// so a damaged toggle fails closed; only an absent key takes the default.
const WRONG_TYPES = [
  ['web', 'yes'],
  ['lsp', 7],
  ['fileTools', 'false'],
  ['bash', { enabled: false }],
  ['subagents', -1],
  ['richFiles', null],
];

for (const [key, wrong] of WRONG_TYPES) {
  test(`K1 tool setting ${key} stored as ${JSON.stringify(wrong)} loads as off and keeps the valid user settings`, () => {
    assert.ok(TOOL_SETTING_KEYS.includes(key), `${key} is a real tool setting`);
    const { dir, file, stored } = seedToolSettings();
    stored.tools[key] = wrong;
    fs.writeFileSync(file, JSON.stringify(stored, null, 2), 'utf8');

    const events = [];
    let service = null;
    assert.doesNotThrow(() => { service = openShellConfig(dir, events); });
    const { tools } = service.getState();
    assert.equal(tools[key], false, `${key} fails closed to off`);
    assert.equal(tools.worktree, true, 'valid user setting kept');
    assert.equal(tools.imageRead, true, 'valid user setting kept');
    assert.equal(events.filter((entry) => entry.event === 'shell_config.corrupt_state_detected').length, 0);
  });
}

test('K1 an absent tool setting takes its default', () => {
  const { dir, file, stored } = seedToolSettings();
  const defaults = getToolConfigDefaults();
  const key = TOOL_SETTING_KEYS.find((name) => defaults[name] === true);
  assert.ok(key, 'fixture: at least one tool defaults on');
  delete stored.tools[key];
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), 'utf8');
  assert.equal(openShellConfig(dir).getState().tools[key], true, `${key} takes its default`);
});
