'use strict';

// new-test-file: slice 3-14's `team-delete` (server/team/team-delete.js) is a new command surface on the headless
// host; the desktop delete keeps its own tests (tests/team-host-delete.test.js) unchanged.
//
// The typed name gates everything; the right name removes the team's data and then the key file and keeps the
// volume roots, the projects root, the profile's lock and owner files and the config; every cut is finished by the
// next run; nothing to delete answers the fixed word; a link refuses with nothing touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { deleteHostedTeam } = require('../../server/team/team-delete');
const { readTerminalLine } = require('../../server/team/tty-input');
const { createMaintenanceFixture, snapshot, ttyInput } = require('./helpers/team-maintenance-fixture');

const WINDOWS = process.platform === 'win32';

async function seeded(t) {
  const fx = createMaintenanceFixture(t);
  const team = await fx.seedTeam();
  fs.mkdirSync(path.join(fx.profile, 'team-chat'));
  fs.writeFileSync(path.join(fx.profile, 'team-chat', 'index.json'), '{"channels":[]}');
  fs.writeFileSync(path.join(fx.profile, 'team-ready.json'), '{}');
  return { fx, team };
}

const typing = (answer) => async () => answer;

function run(fx, answer, extra = {}) {
  return deleteHostedTeam({ ...fx.args(), readLineImpl: typeof answer === 'function' ? answer : typing(answer), ...extra });
}

// What a finished delete leaves: the roots, the empty projects root, the lock and owner files, the config.
function assertDeleted(fx) {
  assert.deepEqual(fs.readdirSync(fx.projects), [], 'projects root kept and empty');
  assert.equal(fs.existsSync(fx.trash), false, 'trash gone');
  assert.deepEqual(fs.readdirSync(fx.profile).sort(), ['.host.lock', 'profile-owner.json']);
  assert.deepEqual(fs.readdirSync(fx.secrets), [], 'key file gone, secrets root kept');
  assert.deepEqual(fs.readdirSync(fx.data), ['projects']);
  assert.equal(fs.existsSync(fx.configPath), true);
}

test('a wrong name, an empty line, Ctrl-C and the end of input delete nothing', async (t) => {
  const { fx } = await seeded(t);
  const before = snapshot(fx.root);
  assert.deepEqual(await run(fx, 'quiet harbor'), { ok: false, reason: 'team_delete_name_mismatch' });
  assert.deepEqual(await run(fx, ''), { ok: false, reason: 'team_delete_name_mismatch' });
  assert.deepEqual(await run(fx, `${fx.teamName} `), { ok: false, reason: 'team_delete_name_mismatch' });
  // The real terminal reader: Ctrl-C and the end of input are refusals, never an answer.
  for (const send of [(input) => input.write('\u0003'), (input) => input.end(), (input) => input.write('\u0004')]) {
    const input = ttyInput();
    const prompt = fx.terminal();
    const pending = run(fx, readTerminalLine, { input, promptOutput: prompt });
    setImmediate(() => send(input));
    assert.deepEqual(await pending, { ok: false, reason: 'team_delete_cancelled' });
    assert.equal(input.isRaw, false, 'raw mode restored');
  }
  assert.deepEqual(snapshot(fx.root), before);
});

test('the typed name read on the terminal deletes exactly the team and keeps what it must', async (t) => {
  const { fx, team } = await seeded(t);
  const input = ttyInput();
  const prompt = fx.terminal();
  const output = fx.terminal();
  const pending = run(fx, readTerminalLine, { input, promptOutput: prompt, output });
  setImmediate(() => input.write(`${fx.teamName}\r`));
  assert.deepEqual(await pending, { ok: true, projects: 1 });
  assertDeleted(fx);
  assert.match(prompt.text(), new RegExp(fx.teamName, 'u'), 'the typed name is echoed on the prompt stream');
  for (const text of [output.text(), fx.logText()]) {
    for (const marker of [fx.teamName, team.projectId, fx.hostKey, fx.root]) assert.equal(text.includes(marker), false, marker);
  }
  assert.equal(fx.lock.released, 1);
});

test('the config\'s name is asked when there is no member store', async (t) => {
  const fx = createMaintenanceFixture(t);
  fs.writeFileSync(fx.configPath, fs.readFileSync(fx.configPath, 'utf8').replace(fx.teamName, 'Config Name'));
  assert.deepEqual(await run(fx, fx.teamName), { ok: false, reason: 'team_delete_name_mismatch' });
  assert.deepEqual(await run(fx, 'Config Name'), { ok: true, projects: 0 });
  assert.equal(fs.existsSync(fx.keyFile), false);
});

test('the key file goes last and a cut at each step is finished by the next run', async (t) => {
  for (const step of ['marker', 'projects', 'trash', 'profile', 'key']) {
    await t.test(step, async (st) => {
      const { fx } = await seeded(st);
      const cut = (at) => { if (at === step) throw new Error('power cut'); };
      assert.deepEqual(await run(fx, fx.teamName, { cut }), { ok: false, reason: 'team_unavailable' });
      assert.equal(fs.existsSync(path.join(fx.profile, '.jenny-team-deleting')), true, 'the marker stays');
      if (step !== 'key') assert.equal(fs.existsSync(fx.keyFile), true, 'the key file is still there');
      const again = await run(fx, fx.teamName);
      assert.equal(again.ok, true, JSON.stringify(again));
      assertDeleted(fx);
    });
  }
});

test('nothing to delete answers team_not_deployed before the question', async (t) => {
  const fx = createMaintenanceFixture(t, { writeKey: false });
  let asked = false;
  assert.deepEqual(await run(fx, () => { asked = true; return ''; }), { ok: false, reason: 'team_not_deployed' });
  assert.equal(asked, false);
});

test('a link anywhere in the team refuses with nothing touched', async (t) => {
  const { fx, team } = await seeded(t);
  const outside = path.join(fx.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(fx.projects, team.projectId, 'notes', 'away'), WINDOWS ? 'junction' : 'dir');
  const before = snapshot(fx.root, { skip: (rel) => rel.endsWith('notes/away') });
  assert.deepEqual(await run(fx, fx.teamName), { ok: false, reason: 'team_delete_link' });
  assert.deepEqual(snapshot(fx.root, { skip: (rel) => rel.endsWith('notes/away') }), before);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('no terminal and a held lock refuse before anything is read', async (t) => {
  const { fx } = await seeded(t);
  const before = snapshot(fx.root);
  assert.deepEqual(await run(fx, fx.teamName, { input: { isTTY: false } }), { ok: false, reason: 'team_tty_required' });
  assert.deepEqual(await run(fx, fx.teamName, { promptOutput: { isTTY: false, write() {} } }), { ok: false, reason: 'team_tty_required' });
  assert.equal(fx.lock.acquired, 0);
  const { HOST_ERROR_CODES } = require('../../services/backend/error-codes');
  const held = () => { throw Object.assign(new Error('locked'), { code: HOST_ERROR_CODES.CONFLICT, reason: 'profile_locked' }); };
  assert.deepEqual(await run(fx, fx.teamName, { acquireProfileImpl: held }), { ok: false, reason: 'team_profile_locked' });
  assert.deepEqual(snapshot(fx.root), before);
});

test('a re-run after a cut asks for the name the marker holds, not the config\'s', async (t) => {
  const { fx } = await seeded(t);
  // The store's name differs from the config's (a renamed team).
  fs.writeFileSync(fx.configPath, fs.readFileSync(fx.configPath, 'utf8').replace(fx.teamName, 'Config Name'));
  const cut = (at) => { if (at === 'profile') throw new Error('power cut'); };
  assert.deepEqual(await run(fx, fx.teamName, { cut }), { ok: false, reason: 'team_unavailable' });
  assert.equal(fs.existsSync(path.join(fx.profile, 'team-members.json')), false, 'the store is gone');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.profile, '.jenny-team-deleting'), 'utf8')), { team_name: fx.teamName });
  assert.deepEqual(await run(fx, 'Config Name'), { ok: false, reason: 'team_delete_name_mismatch' });
  assert.equal((await run(fx, fx.teamName)).ok, true);
  assertDeleted(fx);
});

// Makes the plain listing of each of `dirs` fail (EACCES) while `when()` holds; a walk with file types still runs.
function failListing(t, dirs, when = () => true) {
  const targets = new Set(dirs.flatMap((dir) => [dir, fs.realpathSync.native(dir), fs.realpathSync(dir)]));
  const realReaddir = fs.readdirSync;
  return t.mock.method(fs, 'readdirSync', function readdirSync(dir, ...rest) {
    if (rest.length === 0 && targets.has(String(dir)) && when()) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return realReaddir.call(this, dir, ...rest);
  });
}

test('X4c-F01: a projects root or profile that cannot be listed is never empty: refused, nothing removed, the key kept', async (t) => {
  for (const which of ['projects', 'profile']) {
    await t.test(`${which}, before the question`, async (st) => {
      const { fx, team } = await seeded(st);
      const before = snapshot(fx.root);
      let asked = false;
      const mock = failListing(st, [fx[which]]);
      const answer = await run(fx, () => { asked = true; return fx.teamName; });
      mock.mock.restore();
      assert.deepEqual(answer, { ok: false, reason: 'team_delete_failed' });
      assert.equal(asked, false, 'no "0 project folders" question');
      assert.deepEqual(snapshot(fx.root), before, 'nothing removed, no marker');
      assert.equal(fs.existsSync(path.join(fx.projects, team.projectId, 'notes', 'a.txt')), true);
      assert.equal(fs.existsSync(fx.keyFile), true);
    });
  }
  await t.test('the projects root, after the question', async (st) => {
    const { fx } = await seeded(st);
    const before = snapshot(fx.root);
    let asked = false;
    const mock = failListing(st, [fx.projects], () => asked);
    const answer = await run(fx, () => { asked = true; return fx.teamName; });
    mock.mock.restore();
    assert.deepEqual(answer, { ok: false, reason: 'team_delete_failed' });
    assert.deepEqual(snapshot(fx.root), before, 'refused before the marker: nothing removed');
  });
  await t.test('removeTeamData itself refuses before it removes anything', async (st) => {
    const { fx } = await seeded(st);
    const { removeTeamData, teamRoots } = require('../../server/team/team-maintenance');
    const { loadHostConfig } = require('../../server/config');
    const roots = teamRoots(loadHostConfig(fx.configPath));
    for (const dir of [fx.projects, fx.profile]) {
      const before = snapshot(fx.root);
      const mock = failListing(st, [dir]);
      const removed = await removeTeamData(roots);
      mock.mock.restore();
      assert.deepEqual(removed, { ok: false, reason: 'team_delete_failed' }, path.basename(dir));
      assert.deepEqual(snapshot(fx.root), before, path.basename(dir));
    }
  });
});

// What a full disk (ENOSPC) does to the marker's write: the exclusive create lands, the write fails. Both write
// paths are covered (writeFileSync, and an fd opened for the marker).
function failMarkerWrite(t, marker) {
  const realWriteFile = fs.writeFileSync;
  const realOpen = fs.openSync;
  const realWrite = fs.writeSync;
  const fds = new Set();
  const full = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  t.mock.method(fs, 'writeFileSync', function writeFileSync(file, ...rest) {
    if (String(file) === marker) { fs.closeSync(realOpen.call(fs, file, 'wx', 0o600)); throw full(); }
    return realWriteFile.call(this, file, ...rest);
  });
  t.mock.method(fs, 'openSync', function openSync(file, ...rest) {
    const fd = realOpen.call(this, file, ...rest);
    if (String(file) === marker) fds.add(fd);
    return fd;
  });
  t.mock.method(fs, 'writeSync', function writeSync(fd, ...rest) {
    if (fds.has(fd)) throw full();
    return realWrite.call(this, fd, ...rest);
  });
}

test('X4c-F02: a delete marker whose write fails is removed again, so the team still starts', async (t) => {
  const { assertStartable } = require('../../server/team/maintenance-markers');
  const startReason = (profile) => { try { assertStartable(profile); return null; } catch (error) { return error.reason ?? 'threw'; } };
  await t.test('the half-written marker is removed and nothing of the team goes', async (st) => {
    const { fx, team } = await seeded(st);
    const marker = path.join(fx.profile, '.jenny-team-deleting');
    const before = snapshot(fx.root);
    failMarkerWrite(st, marker);
    const answer = await run(fx, fx.teamName);
    st.mock.restoreAll();
    assert.deepEqual(answer, { ok: false, reason: 'team_delete_failed' });
    assert.equal(fs.existsSync(marker), false, 'no marker left');
    assert.equal(startReason(fx.profile), null, 'the team still starts');
    assert.deepEqual(snapshot(fx.root), before);
    assert.equal(fs.existsSync(path.join(fx.projects, team.projectId, 'notes', 'a.txt')), true);
  });
  await t.test('a half-written marker that cannot be removed either is said in the answer', async (st) => {
    const { fx } = await seeded(st);
    const marker = path.join(fx.profile, '.jenny-team-deleting');
    failMarkerWrite(st, marker);
    const realUnlink = fs.unlinkSync;
    st.mock.method(fs, 'unlinkSync', function unlinkSync(file, ...rest) {
      if (String(file) === marker) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return realUnlink.call(this, file, ...rest);
    });
    const answer = await run(fx, fx.teamName);
    st.mock.restoreAll();
    assert.deepEqual(answer, { ok: false, reason: 'team_delete_marker_left' });
    assert.equal(fs.existsSync(fx.keyFile), true, 'nothing removed');
  });
  await t.test('the marker is written whole and synced before the first removal', async (st) => {
    const { fx } = await seeded(st);
    const marker = path.join(fx.profile, '.jenny-team-deleting');
    const realOpen = fs.openSync;
    const realSync = fs.fsyncSync;
    const fds = new Set();
    let synced = false;
    st.mock.method(fs, 'openSync', function openSync(file, ...rest) {
      const fd = realOpen.call(this, file, ...rest);
      if (String(file) === marker) fds.add(fd);
      return fd;
    });
    st.mock.method(fs, 'fsyncSync', function fsyncSync(fd) { if (fds.has(fd)) synced = true; return realSync.call(this, fd); });
    let atMarker = null;
    const cut = (at) => {
      if (at !== 'marker') return;
      atMarker = { synced, text: fs.readFileSync(marker, 'utf8'), projectsKept: fs.readdirSync(fx.projects).length };
    };
    assert.equal((await run(fx, fx.teamName, { cut })).ok, true);
    st.mock.restoreAll();
    assert.deepEqual(atMarker, { synced: true, text: JSON.stringify({ team_name: fx.teamName }), projectsKept: 1 });
  });
});

test('X4c-F03: a cut restore\'s decrypted staging is removed by team-delete (the config\'s name asked)', async (t) => {
  const fx = createMaintenanceFixture(t, { writeKey: false });
  const stages = [fx.profile, fx.data].map((root) => path.join(root, '.jenny-restoring-aaaaaaaaaaaa'));
  for (const stage of stages) {
    fs.mkdirSync(path.join(stage, 'projects'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stage, 'team-members.json'), '{"decrypted":"team data"}');
  }
  let asked = false;
  const answer = await run(fx, () => { asked = true; return fx.teamName; });
  assert.deepEqual({ answer, asked, left: stages.map((stage) => fs.existsSync(stage)) },
    { answer: { ok: true, projects: 0 }, asked: true, left: [false, false] });
  assert.deepEqual(fs.readdirSync(fx.data), ['projects']);
});

test('a linked projects root refuses with nothing removed; a linked ancestor is resolved by the config loader', async (t) => {
  const relink = (st, link) => {
    const real = `${link}-real`;
    fs.renameSync(link, real);
    try { fs.symlinkSync(real, link, WINDOWS ? 'junction' : 'dir'); } catch (error) {
      if (error?.code === 'EPERM') { st.skip('links need a privilege here'); return null; }
      throw error;
    }
    return real;
  };
  await t.test('the projects root is a link', async (st) => {
    const { fx } = await seeded(st);
    const real = relink(st, fx.projects);
    if (!real) return;
    const before = snapshot(real);
    assert.deepEqual(await run(fx, fx.teamName), { ok: false, reason: 'team_projects_root_symlink_invalid' });
    assert.deepEqual(snapshot(real), before, 'nothing removed behind the link');
    assert.equal(fs.existsSync(fx.keyFile), true);
  });
  await t.test('the data volume is a link: the loader resolves the projects root to its real path', async (st) => {
    const { fx } = await seeded(st);
    const real = relink(st, fx.data);
    if (!real) return;
    const outside = snapshot(fx.root, { skip: (rel) => ['data', 'data-real', 'profile', 'secrets'].includes(rel.split('/')[0]) });
    assert.equal((await run(fx, fx.teamName)).ok, true);
    assert.deepEqual(fs.readdirSync(path.join(real, 'projects')), [], 'the real volume emptied');
    assert.deepEqual(snapshot(fx.root, { skip: (rel) => ['data', 'data-real', 'profile', 'secrets'].includes(rel.split('/')[0]) }), outside);
    assert.equal(fs.lstatSync(fx.data).isSymbolicLink(), true, 'the link itself kept');
  });
});

test('row 151 T1: a profile with a team project\'s board folder has none after the team delete', async (t) => {
  const { fx, team } = await seeded(t);
  const boardId = await fx.seedBoard(team.projectId);
  const folder = path.join(fx.profile, 'team-boards', team.projectId);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['assets', `${boardId}.journal.json`, `${boardId}.json`,
    `${boardId}.proposals.json`, 'index.json'].sort());
  assert.deepEqual(await run(fx, fx.teamName), { ok: true, projects: 1 });
  assertDeleted(fx);
  assert.equal(fs.existsSync(path.join(fx.profile, 'team-boards')), false);
});
