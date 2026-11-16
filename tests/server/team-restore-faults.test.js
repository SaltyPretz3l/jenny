'use strict';

// new-test-file: the fault cases of slice 3-14's `team-restore` (server/team/team-restore.js). They sit beside
// tests/server/team-export-restore.test.js (the round trips and the first fault set), which would pass the
// 600-line cap with them.
//
// A key file made after a cut is never finished over; a folder listing that fails is a failure, never "nothing to
// move"; every file and folder is synced before the key file; the backup is opened once without following a link;
// a three-chunk file fails whole at any chunk; hostile record names write nothing outside staging; and the other
// refusals and a cut inside a step end clean.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { writeBackup } = require('../../services/team/host/host-backup');
const { exportHostedTeam } = require('../../server/team/team-export');
const { createTeamHostKey } = require('../../server/team/keygen');
const { restoreHostedTeam } = require('../../server/team/team-restore');
const { PASSWORD, createMaintenanceFixture, snapshot } = require('./helpers/team-maintenance-fixture');

const WINDOWS = process.platform === 'win32';
const HEADER = 42;
const SEALED = 64 * 1024 + 16;

// A seeded team with `projects` projects (the first holds a file of `bigBytes` bytes), exported once.
async function exportedTeam(t, { projects = 1, bigBytes = 0 } = {}) {
  const fx = createMaintenanceFixture(t);
  const team = await fx.seedTeam();
  fs.mkdirSync(path.join(fx.profile, 'team-chat'));
  fs.writeFileSync(path.join(fx.profile, 'team-chat', 'index.json'), '{"channels":[]}');
  for (let n = 1; n < projects; n += 1) {
    const made = await team.store.createProject({ actorMemberId: team.owner.member_id });
    fs.mkdirSync(path.join(fx.projects, made.project_id));
    fs.writeFileSync(path.join(fx.projects, made.project_id, `p${n}.txt`), `project ${n}`);
  }
  if (bigBytes) fs.writeFileSync(path.join(fx.projects, team.projectId, 'big.bin'), Buffer.alloc(bigBytes, 7));
  const result = await exportHostedTeam({ ...fx.args(), readPasswordImpl: fx.passwords(PASSWORD, PASSWORD).read });
  assert.equal(result.ok, true, JSON.stringify(result));
  const [name] = fs.readdirSync(fx.exchangeDir);
  return { fx, team, name, file: path.join(fx.exchangeDir, name), want: fx.volumes() };
}

function freshWith(t, file, as = path.basename(file)) {
  const fresh = createMaintenanceFixture(t, { writeKey: false });
  fs.copyFileSync(file, path.join(fresh.exchangeDir, as));
  return fresh;
}

function restore(fx, fileName, extra = {}) {
  return restoreHostedTeam({ ...fx.args(), fileName, readPasswordImpl: fx.passwords(PASSWORD).read, ...extra });
}

function assertSameTeam(got, want) {
  for (const part of ['profile', 'projects', 'trash', 'secrets']) assert.deepEqual(got[part], want[part], part);
}

// Nothing of a restore: the volumes as before, no key file, no staging in the data volume.
function assertUntouched(fresh, before) {
  assert.deepEqual(fresh.volumes(), before);
  assert.equal(fs.existsSync(fresh.keyFile), false);
  assert.deepEqual(fs.readdirSync(fresh.data), ['projects'], 'no staging');
}

function linkOrSkip(t, target, link, dir) {
  try { fs.symlinkSync(target, link, dir ? (WINDOWS ? 'junction' : 'dir') : 'file'); return true; } catch (error) {
    if (error?.code === 'EPERM') { t.skip('links need a privilege here'); return false; }
    throw error;
  }
}

test('a key file made after a cut is never finished over; team-keygen refuses while a marker is there', async (t) => {
  const { name, file, want } = await exportedTeam(t);
  await t.test('cut after the profile moved, then a foreign key file', async (st) => {
    const fresh = freshWith(st, file);
    const cut = (at) => { if (at === 'profile') throw new Error('power cut'); };
    assert.deepEqual(await restore(fresh, name, { cut }), { ok: false, reason: 'team_unavailable' });
    assert.deepEqual(await createTeamHostKey({ configPath: fresh.configPath, output: fresh.terminal() }),
      { ok: false, reason: 'team_restore_unfinished' });
    assert.equal(fs.existsSync(fresh.keyFile), false, 'team-keygen wrote nothing');
    fresh.writeKeyFile(crypto.randomBytes(32).toString('base64url')); // another team's key, as a hand-made file would be
    const planted = fs.readFileSync(fresh.keyFile);
    assert.deepEqual(await restore(fresh, name), { ok: false, reason: 'team_restore_key_foreign' });
    assert.equal(fs.existsSync(path.join(fresh.profile, '.jenny-team-restoring')), true, 'the marker stays');
    assert.deepEqual(fs.readFileSync(fresh.keyFile), planted, 'the key file is not touched');
  });
  await t.test('cut after the key file: still finished by the next run', async (st) => {
    const fresh = freshWith(st, file);
    const cut = (at) => { if (at === 'key') throw new Error('power cut'); };
    assert.deepEqual(await restore(fresh, name, { cut }), { ok: false, reason: 'team_unavailable' });
    const pw = fresh.passwords();
    assert.deepEqual(await restoreHostedTeam({ ...fresh.args(), fileName: name, readPasswordImpl: pw.read }), { ok: true });
    assert.deepEqual(pw.asked, []);
    assertSameTeam(fresh.volumes(), want);
  });
  await t.test('team-keygen refuses on a delete marker too', async (st) => {
    const fresh = createMaintenanceFixture(st, { writeKey: false });
    fs.writeFileSync(path.join(fresh.profile, '.jenny-team-deleting'), '');
    assert.deepEqual(await createTeamHostKey({ configPath: fresh.configPath, output: fresh.terminal() }),
      { ok: false, reason: 'team_delete_unfinished' });
  });
});

test('X4c-F01: clearing a cut restore\'s partial team over a projects root it cannot list refuses, marker and data kept', async (t) => {
  const { name, file, want } = await exportedTeam(t);
  const fresh = freshWith(t, file);
  const marker = path.join(fresh.profile, '.jenny-team-restoring');
  fs.writeFileSync(marker, '');
  fs.mkdirSync(path.join(fresh.projects, 'project_half'));
  fs.writeFileSync(path.join(fresh.projects, 'project_half', 'part.txt'), 'half');
  const listed = new Set([fresh.projects, fs.realpathSync.native(fresh.projects), fs.realpathSync(fresh.projects)]);
  const realReaddir = fs.readdirSync;
  const mock = t.mock.method(fs, 'readdirSync', function readdirSync(dir, ...rest) {
    if (rest.length === 0 && listed.has(String(dir))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return realReaddir.call(this, dir, ...rest);
  });
  assert.deepEqual(await restore(fresh, name), { ok: false, reason: 'team_restore_failed' });
  mock.mock.restore();
  assert.equal(fs.existsSync(marker), true, 'the marker stays: the start still says team_restore_unfinished');
  assert.equal(fs.existsSync(path.join(fresh.projects, 'project_half', 'part.txt')), true, 'nothing removed');
  assert.equal((await restore(fresh, name)).ok, true, 'the next run clears it and restores');
  assertSameTeam(fresh.volumes(), want);
});

test('X4c-F03: team-keygen and team-init refuse beside a cut restore\'s staging; marker words come first', async (t) => {
  const { runCli } = require('../../server/cli');
  const staged = (st) => {
    const fresh = createMaintenanceFixture(st, { writeKey: false });
    for (const root of [fresh.profile, fresh.data]) {
      fs.mkdirSync(path.join(root, '.jenny-restoring-aaaaaaaaaaaa'));
      fs.writeFileSync(path.join(root, '.jenny-restoring-aaaaaaaaaaaa', 'team-members.json'), '{"decrypted":"team data"}');
    }
    return fresh;
  };
  const cli = (fresh, command) => runCli([command, '--config', fresh.configPath], { confirmOutput: fresh.terminal(),
    errorOutput: fresh.terminal(), acquireProfileImpl: fresh.acquireProfileImpl, logger: fresh.logger,
    networkInterfaces: () => ({}) });
  await t.test('team-keygen', async (st) => {
    const fresh = staged(st);
    assert.deepEqual(await cli(fresh, 'team-keygen'), { ok: false, reason: 'team_restore_unfinished' });
    assert.equal(fs.existsSync(fresh.keyFile), false, 'no key beside the staging');
  });
  await t.test('staging in the data volume only', async (st) => {
    const fresh = staged(st);
    fs.rmSync(path.join(fresh.profile, '.jenny-restoring-aaaaaaaaaaaa'), { recursive: true });
    assert.deepEqual(await cli(fresh, 'team-keygen'), { ok: false, reason: 'team_restore_unfinished' });
  });
  await t.test('team-init', async (st) => {
    const fresh = staged(st);
    fresh.writeKeyFile(fresh.hostKey);
    assert.deepEqual(await cli(fresh, 'team-init'), { ok: false, reason: 'team_restore_unfinished' });
    assert.equal(fs.existsSync(path.join(fresh.profile, 'team-members.json')), false, 'no store written');
  });
  await t.test('a delete marker beside staging still answers the delete word', async (st) => {
    const fresh = staged(st);
    fs.writeFileSync(path.join(fresh.profile, '.jenny-team-deleting'), '');
    assert.deepEqual(await cli(fresh, 'team-keygen'), { ok: false, reason: 'team_delete_unfinished' });
  });
});

test('a staged folder that cannot be listed fails the move, never reads as empty', async (t) => {
  const { name, file, want } = await exportedTeam(t);
  const fresh = freshWith(t, file);
  const realReaddir = fs.readdirSync;
  const mock = t.mock.method(fs, 'readdirSync', function readdirSync(dir, ...rest) {
    // Only the plain listing of a staged projects folder fails; the walk with file types still runs.
    if (rest.length === 0 && /\.jenny-restoring-[a-f0-9]{12}[\\/]projects$/u.test(String(dir))) {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return realReaddir.call(this, dir, ...rest);
  });
  assert.deepEqual(await restore(fresh, name), { ok: false, reason: 'team_restore_failed' });
  assert.equal(fs.existsSync(fresh.keyFile), false, 'no key after a failed move');
  mock.mock.restore();
  assert.equal((await restore(fresh, name)).ok, true, 'the next run restores');
  assertSameTeam(fresh.volumes(), want);
});

test('every restored file and folder is synced before the key file is written', async (t) => {
  const { name, file } = await exportedTeam(t, { projects: 2 });
  const fresh = freshWith(t, file);
  const log = [];
  const realSync = fs.fsyncSync;
  const realOpen = fs.openSync;
  t.mock.method(fs, 'fsyncSync', function fsyncSync(fd) { log.push('file'); return realSync.call(this, fd); });
  t.mock.method(fs, 'openSync', function openSync(target, ...rest) {
    if (String(target) === fresh.keyFile) log.push('key');
    return realOpen.call(this, target, ...rest);
  });
  const syncFolder = (dir) => log.push(`dir:${dir}`);
  assert.equal((await restore(fresh, name, { syncFolder })).ok, true);
  const key = log.indexOf('key');
  assert.ok(key > 0, 'the key file was written');
  const before = log.slice(0, key);
  const restoredFiles = Object.values({ ...snapshot(fresh.profile), ...snapshot(fresh.projects), ...snapshot(fresh.trash) })
    .filter((value) => Buffer.isBuffer(value)).length;
  // One per restored file; a rewritten projects.json adds its own durable write.
  assert.ok(before.filter((entry) => entry === 'file').length >= restoredFiles, 'every restored file synced');
  for (const dir of [fresh.profile, fresh.data, fresh.projects, fresh.trash]) {
    assert.ok(before.includes(`dir:${dir}`), `synced before the key: ${path.basename(dir)}`);
  }
  assert.ok(before.some((entry) => entry.startsWith('dir:') && entry.includes('.jenny-restoring-')), 'staged folders synced');
  assert.deepEqual(log.slice(key + 1).filter((entry) => entry.startsWith('dir:')), [], 'no folder sync after the key');
});

test('the backup is opened once without following a link and must have one link', async (t) => {
  const { name, file } = await exportedTeam(t);
  await t.test('a symlink named as the backup', async (st) => {
    const fresh = createMaintenanceFixture(st, { writeKey: false });
    const away = path.join(fresh.root, 'away.jennyteam');
    fs.copyFileSync(file, away);
    if (!linkOrSkip(st, away, path.join(fresh.exchangeDir, name), false)) return;
    const before = fresh.volumes();
    assert.deepEqual(await restore(fresh, name), { ok: false, reason: 'team_restore_file_invalid' });
    assertUntouched(fresh, before);
  });
  await t.test('a file with a second hard link', async (st) => {
    const fresh = freshWith(st, file);
    fs.linkSync(path.join(fresh.exchangeDir, name), path.join(fresh.root, 'second-link'));
    const before = fresh.volumes();
    assert.deepEqual(await restore(fresh, name), { ok: false, reason: 'team_restore_file_invalid' });
    assertUntouched(fresh, before);
  });
  await t.test('one open of the file for the header and the body', async (st) => {
    const fresh = freshWith(st, file);
    const target = path.join(fresh.exchangeDir, name);
    let opens = 0;
    const realOpen = fs.promises.open;
    st.mock.method(fs.promises, 'open', function open(where, ...rest) {
      if (String(where) === target) opens += 1;
      return realOpen.call(this, where, ...rest);
    });
    assert.equal((await restore(fresh, name)).ok, true);
    assert.equal(opens, 1);
  });
});

test('a three-chunk file fails whole at any chunk and at a chunk boundary', async (t) => {
  const { name, file } = await exportedTeam(t, { bigBytes: 150 * 1024 });
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > HEADER + 2 * SEALED, 'three chunks');
  const variants = {
    last_chunk: (b) => { b[HEADER + 2 * SEALED + 10] ^= 1; return b; },
    middle_chunk: (b) => { b[HEADER + SEALED + 10] ^= 1; return b; },
    boundary: (b) => b.subarray(0, HEADER + 2 * SEALED),
    magic: (b) => { b[0] ^= 1; return b; },
    kdf_bytes: (b) => { b[15] = 16; return b; },
    short_header: (b) => b.subarray(0, 20),
  };
  for (const [label, change] of Object.entries(variants)) {
    await t.test(label, async (st) => {
      const fresh = createMaintenanceFixture(st, { writeKey: false });
      fs.writeFileSync(path.join(fresh.exchangeDir, name), change(Buffer.from(bytes)));
      const before = fresh.volumes();
      assert.deepEqual(await restore(fresh, name), { ok: false, reason: 'team_backup_password_wrong' });
      assertUntouched(fresh, before);
      assert.deepEqual(fs.readdirSync(fresh.profile).filter((entry) => entry.startsWith('.jenny')), [], 'no staging');
    });
  }
});

test('hostile record names write nothing outside staging; names never moved in are skipped', async (t) => {
  const fx = createMaintenanceFixture(t);
  await fx.seedTeam();
  const src = path.join(fx.root, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'x'), 'HOSTILE');
  const manifest = { schema: 1, team_name: fx.teamName, team_id: null, exported_at: 1, relay_token: null, key: fx.hostKey,
    setting: { name: fx.teamName, direct_port: null, internet: null } };
  const members = { rel: 'profile/team-members.json', abs: path.join(fx.profile, 'team-members.json') };
  const write = async (target, extra) => writeBackup({ target, password: PASSWORD, manifest,
    entries: [{ rel: 'profile', dir: true }, members, ...extra] });
  const outside = (fresh) => snapshot(fresh.root, { skip: (rel) => ['profile', 'data', 'secrets', 'exchange'].includes(rel.split('/')[0]) });
  for (const rel of ['../x', '/x', 'profile/../projects/x', 'projects\\x', 'profile/..\\x']) {
    await t.test(rel, async (st) => {
      const fresh = createMaintenanceFixture(st, { writeKey: false });
      await write(path.join(fresh.exchangeDir, 'bad.jennyteam'), [{ rel, abs: path.join(src, 'x') }]);
      const before = fresh.volumes();
      const around = outside(fresh);
      assert.deepEqual(await restore(fresh, 'bad.jennyteam'), { ok: false, reason: 'team_backup_password_wrong' });
      assertUntouched(fresh, before);
      assert.deepEqual(outside(fresh), around);
    });
  }
  await t.test('the profile\'s own files, the ready marker, a marker and a staging-shaped folder', async (st) => {
    const fresh = createMaintenanceFixture(st, { writeKey: false });
    fs.writeFileSync(path.join(fresh.profile, '.host.lock'), 'MINE');
    const extra = ['profile/.host.lock', 'profile/profile-owner.json', 'profile/team-ready.json',
      'profile/.jenny-team-deleting', 'profile/.jenny-restoring-aaaaaaaaaaaa/x'].map((rel) => ({ rel, abs: path.join(src, 'x') }));
    await write(path.join(fresh.exchangeDir, 'odd.jennyteam'), extra);
    const around = outside(fresh);
    const result = await restore(fresh, 'odd.jennyteam');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(fresh.profile, '.host.lock'), 'utf8'), 'MINE');
    assert.deepEqual(fs.readdirSync(fresh.profile).sort(), ['.host.lock', 'team-members.json']);
    assert.deepEqual(outside(fresh), around);
  });
});

test('the other refusals, and a cut inside the project step ends clean', async (t) => {
  const { name, file, want } = await exportedTeam(t, { projects: 2 });
  await t.test('a link in a partial team left by a cut restore', async (st) => {
    const fresh = freshWith(st, file);
    fs.writeFileSync(path.join(fresh.profile, '.jenny-team-restoring'), '');
    fs.mkdirSync(path.join(fresh.projects, 'project_half'));
    if (!linkOrSkip(st, fresh.root, path.join(fresh.projects, 'project_half', 'away'), true)) return;
    assert.deepEqual(await restore(fresh, name), { ok: false, reason: 'team_restore_link' });
  });
  await t.test('a delete marker', async (st) => {
    const fresh = freshWith(st, file);
    fs.writeFileSync(path.join(fresh.profile, '.jenny-team-deleting'), '');
    assert.deepEqual(await restore(fresh, name), { ok: false, reason: 'team_delete_unfinished' });
  });
  await t.test('a missing projects root', async (st) => {
    const fresh = freshWith(st, file);
    fs.rmSync(fresh.projects, { recursive: true });
    assert.deepEqual(await restore(fresh, name), { ok: false, reason: 'team_projects_root_missing' });
  });
  await t.test('no room', async (st) => {
    const fresh = freshWith(st, file);
    const before = fresh.volumes();
    assert.deepEqual(await restore(fresh, name, { statfs: async () => ({ bavail: 1, bsize: 1 }) }),
      { ok: false, reason: 'team_disk_full' });
    assertUntouched(fresh, before);
  });
  await t.test('a non-empty profile entry the backup also holds', async (st) => {
    const fresh = freshWith(st, file);
    fs.mkdirSync(path.join(fresh.profile, 'team-chat'));
    fs.writeFileSync(path.join(fresh.profile, 'team-chat', 'local.json'), '{}');
    const before = fresh.volumes();
    assert.deepEqual(await restore(fresh, name), { ok: false, reason: 'team_host_exists' });
    assertUntouched(fresh, before);
  });
  await t.test('a cut after the first project folder moved', async (st) => {
    const fresh = freshWith(st, file);
    let moved = 0;
    const cut = (at) => { if (at === 'project' && (moved += 1) === 1) throw new Error('power cut'); };
    assert.deepEqual(await restore(fresh, name, { cut }), { ok: false, reason: 'team_unavailable' });
    assert.equal(fs.readdirSync(fresh.projects).length, 1, 'one of two moved');
    assert.equal((await restore(fresh, name)).ok, true);
    assertSameTeam(fresh.volumes(), want);
    assert.deepEqual(fs.readdirSync(fresh.data).sort(), ['projects', 'trash']);
  });
});
