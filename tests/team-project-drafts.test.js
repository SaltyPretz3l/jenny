'use strict';

// new-test-file: row 175 F6, a new surface: the main-process file that keeps a member's unsent project conversation
// text on this PC (services/team/project-drafts.js), its payload checks and its route through the team service.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MAX_CHARS, MAX_CONVERSATIONS, createProjectDrafts } = require('../services/team/project-drafts');
const { validatePayload } = require('../services/team/ipc-methods');
const { createTeamService } = require('../services/team/team-service');

const TEAM = 'team_BBBBBBBBBBBBBBBBBBBBBB';
const OTHER_TEAM = 'team_CCCCCCCCCCCCCCCCCCCCCC';
const sess = (n) => 'sess_' + String(n).padStart(32, '0');
const S1 = sess(1);

function world(t, { team = TEAM } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-drafts-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  fs.mkdirSync(path.join(userData, 'team', team), { recursive: true });
  const waiting = new Map();
  let next = 1;
  const timers = { setTimeout: (fn, ms) => { const id = next++; waiting.set(id, { fn, ms }); return id; }, clearTimeout: (id) => waiting.delete(id) };
  const logs = [];
  const make = () => createProjectDrafts({ userDataPath: userData, timers, log: (...args) => logs.push(args) });
  const file = (id = TEAM) => path.join(userData, 'team', id, 'project-drafts.json');
  const fire = () => { for (const [id, one] of [...waiting]) { waiting.delete(id); one.fn(); } };
  return { userData, make, file, fire, waiting, logs };
}
const set = (store, text, session = S1, team = TEAM) => store.call('projectDraftSet', { team_id: team, session_id: session, text });
const get = (store, session = S1, team = TEAM) => store.call('projectDraftGet', { team_id: team, session_id: session });
const onDisk = (w) => JSON.parse(fs.readFileSync(w.file(), 'utf8'));

test('a draft is kept in memory at once and written to this PC once, after the pause', (t) => {
  const w = world(t);
  const store = w.make();
  assert.deepEqual(set(store, 'half'), { ok: true });
  assert.deepEqual(set(store, 'half a prompt'), { ok: true });
  assert.deepEqual(get(store), { ok: true, text: 'half a prompt' });
  assert.equal(fs.existsSync(w.file()), false, 'nothing is written before the pause');
  assert.equal(w.waiting.size, 1, 'one timer for both changes');
  assert.equal([...w.waiting.values()][0].ms, 1000);
  w.fire();
  assert.deepEqual(onDisk(w), { schema_version: 1, drafts: [{ session_id: S1, text: 'half a prompt' }] });
});

test('draft restored after reopen: a new store reads the file, and an unknown conversation reads empty', (t) => {
  const w = world(t);
  const first = w.make();
  set(first, 'half a prompt');
  first.flush();
  const second = w.make();
  assert.deepEqual(get(second), { ok: true, text: 'half a prompt' });
  assert.deepEqual(get(second, sess(2)), { ok: true, text: '' });
});

test('an empty text clears the draft and the file goes with the last one; a clear of nothing writes nothing', (t) => {
  const w = world(t);
  const store = w.make();
  set(store, 'one');
  set(store, 'two', sess(2));
  store.flush();
  set(store, '');
  store.flush();
  assert.deepEqual(onDisk(w).drafts.map((d) => d.session_id), [sess(2)]);
  set(store, '', sess(2));
  store.flush();
  assert.equal(fs.existsSync(w.file()), false, 'no file is left holding nothing');
  assert.equal(set(store, '', sess(9)).ok, true);
  assert.equal(w.waiting.size, 0, 'no write is scheduled for a clear of nothing');
});

test('bounded: 64 conversations, the oldest dropped, and a text kept to 32,000 characters without cutting a pair', (t) => {
  const w = world(t);
  const store = w.make();
  for (let n = 1; n <= MAX_CONVERSATIONS + 1; n += 1) set(store, 'draft ' + n, sess(n));
  assert.deepEqual(get(store, sess(1)), { ok: true, text: '' }, 'the oldest went');
  assert.equal(get(store, sess(2)).text, 'draft 2');
  assert.equal(get(store, sess(MAX_CONVERSATIONS + 1)).text, 'draft 65');
  set(store, 'draft 2 again', sess(2));
  set(store, 'draft 66', sess(66));
  assert.equal(get(store, sess(3)).text, '', 'writing a draft again makes it the newest, so the next oldest goes');
  assert.equal(get(store, sess(2)).text, 'draft 2 again');
  set(store, 'x'.repeat(40_000), sess(70));
  assert.equal(get(store, sess(70)).text.length, MAX_CHARS);
  set(store, 'y'.repeat(MAX_CHARS - 1) + '\u{1F600}', sess(71));
  assert.equal(get(store, sess(71)).text, 'y'.repeat(MAX_CHARS - 1), 'a pair that would be cut is left out whole');
  store.flush();
  assert.ok(onDisk(w).drafts.length <= MAX_CONVERSATIONS);
  assert.ok(fs.statSync(w.file()).size < 8 * 1024 * 1024);
});

test('a file that holds more or worse than the bounds is cut on load: bad entries dropped, 64 newest kept', (t) => {
  const w = world(t);
  const drafts = [];
  for (let n = 1; n <= 70; n += 1) drafts.push({ session_id: sess(n), text: 't' + n });
  drafts.push({ session_id: 'not-an-id', text: 'x' }, { session_id: sess(80), text: '' }, { session_id: sess(81), text: 'y'.repeat(MAX_CHARS + 1) },
    { session_id: sess(82), text: 'z', extra: 1 }, { session_id: sess(83), text: '\uD800' });
  fs.writeFileSync(w.file(), JSON.stringify({ schema_version: 1, drafts }));
  const store = w.make();
  assert.equal(get(store, sess(6)).text, '', '70 entries: the 6 oldest are past the bound');
  assert.equal(get(store, sess(7)).text, 't7');
  for (const n of [80, 81, 82, 83]) assert.equal(get(store, sess(n)).text, '', 'entry ' + n);
});

test('a damaged file reads as empty and is replaced; a file of another schema is left alone and refuses writes', (t) => {
  const w = world(t);
  fs.writeFileSync(w.file(), '{ not json');
  const damaged = w.make();
  assert.deepEqual(get(damaged), { ok: true, text: '' });
  set(damaged, 'fresh');
  damaged.flush();
  assert.equal(onDisk(w).drafts[0].text, 'fresh');
  const newer = JSON.stringify({ schema_version: 2, drafts: [{ session_id: S1, text: 'from the future' }] });
  fs.writeFileSync(w.file(), newer);
  const store = w.make();
  assert.equal(set(store, 'mine').ok, false);
  assert.equal(get(store).text, '');
  store.flush();
  assert.equal(fs.readFileSync(w.file(), 'utf8'), newer, 'not rewritten');
});

test('a team with no directory on this PC keeps nothing, makes no directory, and a removed team is not brought back by a late write', (t) => {
  const w = world(t);
  const store = w.make();
  const gone = set(store, 'x', S1, OTHER_TEAM);
  assert.equal(gone.ok, false);
  assert.equal(gone.error.reason, 'team_not_found');
  assert.equal(get(store, S1, OTHER_TEAM).ok, false);
  assert.equal(fs.existsSync(path.join(w.userData, 'team', OTHER_TEAM)), false);
  set(store, 'half');
  fs.rmSync(path.join(w.userData, 'team', TEAM), { recursive: true });
  store.flush();
  assert.equal(fs.existsSync(path.join(w.userData, 'team', TEAM)), false, 'the removed team stays removed');
  fs.mkdirSync(path.join(w.userData, 'team', TEAM));
  assert.deepEqual(get(store), { ok: true, text: '' }, 'and the same team joined again starts with no drafts');
});

test('a write that fails is logged without the text and tried again with the next change', (t) => {
  const w = world(t);
  fs.mkdirSync(w.file()); // a folder where the file belongs: the write cannot land
  const store = w.make();
  set(store, 'a private sentence');
  store.flush();
  assert.ok(w.logs.some(([, event]) => event === 'team.project_drafts.write_failed'), 'said once');
  assert.ok(w.logs.length >= 1);
  for (const entry of w.logs) assert.ok(!JSON.stringify(entry).includes('private'), 'the text is never logged');
  fs.rmSync(w.file(), { recursive: true });
  set(store, 'a private sentence, again');
  store.flush();
  assert.equal(onDisk(w).drafts[0].text, 'a private sentence, again');
});

test('payloads are closed: a team id, a conversation id and a well-formed text of at most 100,000 characters', () => {
  const ok = { team_id: TEAM, session_id: S1 };
  assert.equal(validatePayload('projectDraftGet', ok).ok, true);
  assert.equal(validatePayload('projectDraftSet', { ...ok, text: '' }).ok, true);
  assert.equal(validatePayload('projectDraftSet', { ...ok, text: 'x'.repeat(100_000) }).ok, true);
  const bad = [['projectDraftGet', { ...ok, session_id: '../x' }], ['projectDraftGet', { ...ok, team_id: '..' }], ['projectDraftGet', { ...ok, text: 'x' }],
    ['projectDraftSet', ok], ['projectDraftSet', { ...ok, text: 'x'.repeat(100_001) }], ['projectDraftSet', { ...ok, text: '\uD800' }],
    ['projectDraftSet', { ...ok, text: 7 }], ['projectDraftSet', { ...ok, text: 'x', path: 'C:\\x' }], ['projectDraftSet', null]];
  for (const [method, payload] of bad) assert.equal(validatePayload(method, payload).ok, false, JSON.stringify(payload).slice(0, 60));
});

test('through the team service: set and get work with no connection to the team, nothing is logged but the method, and stopping writes what waits', async (t) => {
  const w = world(t);
  const logs = [];
  const service = createTeamService({ userDataPath: w.userData, getSecureStore: () => null, log: (...args) => logs.push(args) });
  t.after(() => service.stopAll());
  assert.deepEqual(await service.handle('projectDraftSet', { team_id: TEAM, session_id: S1, text: 'a private sentence' }), { ok: true });
  assert.deepEqual(await service.handle('projectDraftGet', { team_id: TEAM, session_id: S1 }), { ok: true, text: 'a private sentence' });
  assert.equal((await service.handle('projectDraftGet', { team_id: TEAM, session_id: 'nope' })).ok, false);
  for (const entry of logs) assert.ok(!JSON.stringify(entry).includes('private'), 'the text is never logged');
  assert.equal(fs.existsSync(w.file()), false, 'still waiting behind the pause');
  await service.stopAll();
  assert.equal(onDisk(w).drafts[0].text, 'a private sentence', 'stopping the service flushed it');
  assert.equal((await service.handle('projectDraftGet', { team_id: TEAM, session_id: S1 })).ok, false, 'a stopped service answers nothing');
});
