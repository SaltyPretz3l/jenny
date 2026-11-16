'use strict';

// new-test-file: slice 3-14's `team-export` and `team-restore` (server/team/team-export.js, team-restore.js) are new
// command surfaces on the headless host; the desktop's own tests (tests/team-host-*.test.js) stay unchanged.
//
// Export then restore on a fresh host gives the same team; a desktop backup restores headless and a headless
// export passes the desktop restore; the file is 0600 and no partial stays; a restore writes nothing on any bad
// file, refuses a host with a team and a key that does not match, writes the key file last, and every cut ends
// clean or finished by the next run.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { writeBackup } = require('../../services/team/host/host-backup');
const { exportTeam } = require('../../services/team/host/host-export');
const { restoreTeam } = require('../../services/team/host/host-restore');
const { ProjectStore } = require('../../services/projects/project-store');
const { PROJECT_STORE_SCHEMA_VERSION, createGeneralProject } = require('../../services/projects/project-schema');
const { exportHostedTeam } = require('../../server/team/team-export');
const { restoreHostedTeam } = require('../../server/team/team-restore');
const { PASSWORD, createMaintenanceFixture, snapshot } = require('./helpers/team-maintenance-fixture');

const POSIX = process.platform !== 'win32';
const NAME = /^jenny-team-\d{8}-\d{6}\.jennyteam$/u;

async function seeded(t) {
  const fx = createMaintenanceFixture(t);
  const team = await fx.seedTeam();
  fs.mkdirSync(path.join(fx.profile, 'team-chat'));
  fs.writeFileSync(path.join(fx.profile, 'team-chat', 'index.json'), '{"channels":[]}');
  fs.writeFileSync(path.join(fx.profile, 'team-project-audit.json'), '{"schema_version":1}');
  return { fx, team };
}

async function exported(fx, extra = {}) {
  const pw = fx.passwords(PASSWORD, PASSWORD);
  const output = fx.terminal();
  const result = await exportHostedTeam({ ...fx.args({ output }), readPasswordImpl: pw.read, ...extra });
  const [name] = fs.readdirSync(fx.exchangeDir);
  return { result, output, name, file: name ? path.join(fx.exchangeDir, name) : null };
}

function restore(fx, fileName, extra = {}) {
  const pw = fx.passwords(...(extra.answers ?? [PASSWORD]));
  return restoreHostedTeam({ ...fx.args(), fileName, readPasswordImpl: pw.read, ...extra });
}

// A fresh host with the backup file in its exchange folder.
function freshWith(t, file) {
  const fx = createMaintenanceFixture(t, { writeKey: false });
  fs.copyFileSync(file, path.join(fx.exchangeDir, path.basename(file)));
  return fx;
}

// Nothing of a restore: no key file, no staging, the volumes as `before`.
function assertUntouched(fx, before) {
  assert.deepEqual(fx.volumes(), before);
  assert.equal(fs.existsSync(fx.keyFile), false, 'no key file');
}

test('export then restore on a fresh host gives the same team and the same key', async (t) => {
  const { fx } = await seeded(t);
  const out = await exported(fx);
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  assert.match(out.name, NAME);
  assert.deepEqual(fs.readdirSync(fx.exchangeDir), [out.name], 'one file, no partial');
  if (POSIX) assert.equal(fs.statSync(out.file).mode & 0o777, 0o600);
  for (const marker of [out.name, PASSWORD, fx.hostKey, fx.root, fx.exchangeDir]) {
    assert.equal(out.output.text().includes(marker), false, 'terminal');
    assert.equal(fx.logText().includes(marker), false, 'log');
  }
  const fresh = freshWith(t, out.file);
  const output = fresh.terminal();
  const restored = await restore(fresh, out.name, { output });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  const want = fx.volumes();
  const got = fresh.volumes();
  for (const part of ['profile', 'projects', 'trash', 'secrets']) assert.deepEqual(got[part], want[part], part);
  assert.equal(fs.readFileSync(fresh.keyFile, 'utf8'), `${fx.hostKey}\n`);
  if (POSIX) assert.equal(fs.statSync(fresh.keyFile).mode & 0o777, 0o600);
  assert.match(output.text(), /team-recover/u);
  for (const marker of [out.name, PASSWORD, fx.hostKey, fresh.root]) {
    assert.equal(output.text().includes(marker), false);
    assert.equal(fresh.logText().includes(marker), false);
  }
  assert.deepEqual(fs.readdirSync(fresh.profile).filter((name) => name.startsWith('.jenny')), [], 'no marker or staging');
  assert.deepEqual(fs.readdirSync(fresh.data).sort(), ['projects', 'trash']);
});

test('a desktop backup restores headless with its project folders pointed at this host', async (t) => {
  const { fx, team } = await seeded(t);
  const desktop = path.join(fx.root, 'desktop');
  const hostRoot = path.join(desktop, 'team-host');
  fs.cpSync(fx.profile, path.join(hostRoot, 'profile'), { recursive: true });
  fs.cpSync(fx.projects, path.join(hostRoot, 'projects'), { recursive: true });
  fs.cpSync(fx.trash, path.join(hostRoot, 'trash'), { recursive: true });
  const old = `C:\\Users\\someone\\AppData\\Roaming\\jenny\\team-host\\projects\\${team.projectId}`;
  const general = createGeneralProject('2026-11-01T00:00:00.000Z');
  fs.writeFileSync(path.join(hostRoot, 'profile', 'projects.json'), JSON.stringify({ schema_version: 1, projects: {
    [general.id]: general,
    [team.projectId]: { id: team.projectId, name: 'Shared', root_path: old, root_id: 'stale', root_revision: 1,
      runtime_preferences: {}, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' },
  } }));
  const picked = path.join(desktop, 'picked');
  fs.mkdirSync(picked);
  const made = await exportTeam({ root: hostRoot, picked, userDataPath: desktop, ownerId: team.owner.member_id,
    setting: { name: fx.teamName, direct_port: null, internet: null },
    secrets: { seed: Buffer.from(fx.hostKey, 'base64url'), relayToken: null }, password: PASSWORD });
  assert.equal(made.ok, true, JSON.stringify(made));
  const [folder] = fs.readdirSync(picked);
  const backup = fs.readdirSync(path.join(picked, folder)).find((name) => name.endsWith('.jennyteam'));
  const fresh = createMaintenanceFixture(t, { writeKey: false });
  fs.copyFileSync(path.join(picked, folder, backup), path.join(fresh.exchangeDir, 'desktop.jennyteam'));
  const restored = await restore(fresh, 'desktop.jennyteam');
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.roots_rewritten, 1);
  const store = new ProjectStore(path.join(fresh.profile, 'projects.json'));
  assert.deepEqual(store.getStatus(), { schema_version: 1, read_only: false, reason: null }, 'the store reads the rewritten file');
  assert.equal(store.getProject(team.projectId)?.root_path, path.join(fresh.projects, team.projectId));
  const doc = JSON.parse(fs.readFileSync(path.join(fresh.profile, 'projects.json'), 'utf8'));
  assert.equal(doc.projects[team.projectId].root_path, path.join(fresh.projects, team.projectId));
  assert.deepEqual(fresh.volumes().projects, fx.volumes().projects);
});

test('a headless export passes the desktop restore and carries the same key', async (t) => {
  const { fx } = await seeded(t);
  const out = await exported(fx);
  assert.equal(out.result.ok, true);
  const desktop = path.join(fx.root, 'desktop-restore');
  fs.mkdirSync(desktop);
  let restoredKey = null;
  const keys = { restore(seed) { restoredKey = Buffer.from(seed).toString('base64url'); } };
  const answer = await restoreTeam({ userDataPath: desktop, file: out.file, password: PASSWORD, keys });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(restoredKey, fx.hostKey);
  assert.equal(answer.team_name, fx.teamName);
});

test('the backup writer creates its file 0600 for the desktop export too', async (t) => {
  const { fx, team } = await seeded(t);
  const hostRoot = path.join(fx.root, 'desk', 'team-host');
  fs.cpSync(fx.profile, path.join(hostRoot, 'profile'), { recursive: true });
  const picked = path.join(fx.root, 'desk', 'picked');
  fs.mkdirSync(picked);
  const modes = [];
  const realOpen = fs.promises.open;
  fs.promises.open = function open(file, flags, mode) {
    if (String(file).endsWith('.tmp') && flags === 'wx') modes.push(mode);
    return realOpen.call(this, file, flags, mode);
  };
  t.after(() => { fs.promises.open = realOpen; });
  const made = await exportTeam({ root: hostRoot, picked, userDataPath: path.join(fx.root, 'desk'), ownerId: team.owner.member_id,
    setting: { name: fx.teamName, direct_port: null, internet: null },
    secrets: { seed: Buffer.from(fx.hostKey, 'base64url'), relayToken: null }, password: PASSWORD });
  fs.promises.open = realOpen;
  assert.equal(made.ok, true);
  assert.deepEqual(modes, [0o600]);
  if (POSIX) {
    const [folder] = fs.readdirSync(picked);
    const backup = fs.readdirSync(path.join(picked, folder)).find((name) => name.endsWith('.jennyteam'));
    assert.equal(fs.statSync(path.join(picked, folder, backup)).mode & 0o777, 0o600);
  }
});

test('export refusals write nothing and leave no partial', async (t) => {
  const { fx } = await seeded(t);
  const run = (answers, extra = {}) => exportHostedTeam({ ...fx.args(), readPasswordImpl: fx.passwords(...answers).read,
    ...extra });
  assert.deepEqual(await run([PASSWORD, `${PASSWORD}x`]), { ok: false, reason: 'team_export_password_mismatch' });
  assert.deepEqual(await run(['short']), { ok: false, reason: 'team_backup_password_short' });
  assert.deepEqual(await run([]), { ok: false, reason: 'team_input_cancelled' });
  assert.deepEqual(fs.readdirSync(fx.exchangeDir), []);
  // A file already at the name: the export fails rather than replace it, and its partial goes.
  const now = Date.UTC(2026, 10, 13, 9, 8, 7);
  fs.writeFileSync(path.join(fx.exchangeDir, 'jenny-team-20261113-090807.jennyteam'), 'keep me');
  assert.deepEqual(await run([PASSWORD, PASSWORD], { clock: () => now }), { ok: false, reason: 'team_export_exists' });
  assert.deepEqual(fs.readdirSync(fx.exchangeDir), ['jenny-team-20261113-090807.jennyteam']);
  assert.equal(fs.readFileSync(path.join(fx.exchangeDir, 'jenny-team-20261113-090807.jennyteam'), 'utf8'), 'keep me');
  assert.deepEqual(await run([PASSWORD, PASSWORD], { statfs: async () => ({ bavail: 1, bsize: 1 }) }),
    { ok: false, reason: 'team_disk_full' });
  fs.rmSync(fx.exchangeDir, { recursive: true });
  assert.deepEqual(await run([PASSWORD, PASSWORD]), { ok: false, reason: 'team_exchange_unavailable' });
  const none = createMaintenanceFixture(t, { writeKey: false });
  assert.deepEqual(await exportHostedTeam({ ...none.args(), readPasswordImpl: none.passwords(PASSWORD, PASSWORD).read }),
    { ok: false, reason: 'team_not_deployed' });
});

test('a bad file writes nothing: wrong password, truncation, a flipped byte in each region, an unknown version', async (t) => {
  const { fx } = await seeded(t);
  const out = await exported(fx);
  const bytes = fs.readFileSync(out.file);
  const variants = {
    wrong: { file: bytes, answers: ['not the password'], reason: 'team_backup_password_wrong' },
    truncated: { file: bytes.subarray(0, bytes.length - 5), reason: 'team_backup_password_wrong' },
    salt: { flip: 20, reason: 'team_backup_password_wrong' },
    nonce: { flip: 36, reason: 'team_backup_password_wrong' },
    first_chunk: { flip: 60, reason: 'team_backup_password_wrong' },
    last_tag: { flip: bytes.length - 1, reason: 'team_backup_password_wrong' },
    newer: { version: 2, reason: 'team_backup_too_new' },
    older: { version: 0, reason: 'team_backup_password_wrong' },
  };
  for (const [label, variant] of Object.entries(variants)) {
    await t.test(label, async (st) => {
      const fresh = createMaintenanceFixture(st, { writeKey: false });
      const file = Buffer.from(variant.file ?? bytes);
      if (variant.flip !== undefined) file[variant.flip] ^= 0x01;
      if (variant.version !== undefined) file.writeUInt16BE(variant.version, 12);
      fs.writeFileSync(path.join(fresh.exchangeDir, 'bad.jennyteam'), file);
      const before = fresh.volumes();
      const pw = fresh.passwords(...(variant.answers ?? [PASSWORD]));
      assert.deepEqual(await restoreHostedTeam({ ...fresh.args(), fileName: 'bad.jennyteam', readPasswordImpl: pw.read }),
        { ok: false, reason: variant.reason });
      assertUntouched(fresh, before);
      if (variant.reason === 'team_backup_too_new') assert.deepEqual(pw.asked, [], 'refused before the password');
      assert.deepEqual(fs.readdirSync(fresh.data), ['projects'], 'no staging in the data volume');
    });
  }
});

test('a host with any part of a team refuses the restore', async (t) => {
  const { fx } = await seeded(t);
  const out = await exported(fx);
  const plants = {
    key: (f) => f.writeKeyFile(),
    store: (f) => fs.writeFileSync(path.join(f.profile, 'team-members.json'), '{}'),
    project: (f) => fs.mkdirSync(path.join(f.projects, 'project_other')),
    trash: (f) => fs.mkdirSync(path.join(f.trash, 'project_x-20261101000000000'), { recursive: true }),
  };
  for (const [label, plant] of Object.entries(plants)) {
    await t.test(label, async (st) => {
      const fresh = freshWith(st, out.file);
      plant(fresh);
      const before = fresh.volumes();
      assert.deepEqual(await restore(fresh, out.name), { ok: false, reason: 'team_host_exists' });
      assert.deepEqual(fresh.volumes(), before);
    });
  }
});

test('a key that does not match the backup\'s member store refuses and leaves no key file', async (t) => {
  const { fx } = await seeded(t);
  const fresh = createMaintenanceFixture(t, { writeKey: false });
  const entries = [{ rel: 'profile', dir: true },
    { rel: 'profile/team-members.json', abs: path.join(fx.profile, 'team-members.json') }];
  const manifest = { schema: 1, team_name: fx.teamName, team_id: null, exported_at: 1, relay_token: null,
    key: crypto.randomBytes(32).toString('base64url'), setting: { name: fx.teamName, direct_port: null, internet: null } };
  await writeBackup({ target: path.join(fresh.exchangeDir, 'odd.jennyteam'), password: PASSWORD, manifest, entries });
  const before = fresh.volumes();
  assert.deepEqual(await restore(fresh, 'odd.jennyteam'), { ok: false, reason: 'team_host_key_mismatch' });
  assertUntouched(fresh, before);
});

test('the key file is written last and every cut ends clean or is finished by the next run', async (t) => {
  const { fx } = await seeded(t);
  const out = await exported(fx);
  const want = fx.volumes();
  for (const step of ['marker', 'projects', 'trash', 'profile', 'key']) {
    await t.test(step, async (st) => {
      const fresh = freshWith(st, out.file);
      const cut = (at) => { if (at === step) throw new Error('power cut'); };
      assert.deepEqual(await restore(fresh, out.name, { cut }), { ok: false, reason: 'team_unavailable' });
      if (step !== 'key') {
        // Before the key file: the key is nowhere on the three volumes.
        assert.equal(fs.existsSync(fresh.keyFile), false);
        for (const root of [fresh.profile, fresh.data, fresh.secrets]) {
          for (const [rel, bytes] of Object.entries(snapshot(root))) {
            if (Buffer.isBuffer(bytes)) assert.equal(bytes.includes(fx.hostKey), false, rel);
          }
        }
      }
      const pw = fresh.passwords(PASSWORD);
      const again = await restoreHostedTeam({ ...fresh.args(), fileName: out.name, readPasswordImpl: pw.read });
      assert.equal(again.ok, true, JSON.stringify(again));
      if (step === 'key') assert.deepEqual(pw.asked, [], 'only the marker was left: no password needed');
      const got = fresh.volumes();
      for (const part of ['profile', 'projects', 'trash', 'secrets']) assert.deepEqual(got[part], want[part], `${step} ${part}`);
      assert.deepEqual(fs.readdirSync(fresh.profile).filter((name) => name.startsWith('.jenny')), []);
    });
  }
  await t.test('a cut while staging leaves staging the next run removes', async (st) => {
    const fresh = freshWith(st, out.file);
    for (const root of [fresh.profile, fresh.data]) {
      fs.mkdirSync(path.join(root, '.jenny-restoring-aaaaaaaaaaaa', 'projects'), { recursive: true });
      fs.writeFileSync(path.join(root, '.jenny-restoring-aaaaaaaaaaaa', 'part'), 'half');
    }
    const again = await restore(fresh, out.name);
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(fs.readdirSync(fresh.data).sort(), ['projects', 'trash']);
    assert.deepEqual(fresh.volumes().profile, want.profile);
  });
});

test('X4c-F04: a projects.json of a newer schema is never rewritten: the restore refuses and writes nothing', async (t) => {
  const fx = createMaintenanceFixture(t);
  const team = await fx.seedTeam();
  const newer = JSON.stringify({ schema_version: PROJECT_STORE_SCHEMA_VERSION + 1, projects: { [team.projectId]: { id: team.projectId, name: 'Shared',
    root_path: `C:\\Users\\someone\\AppData\\Roaming\\jenny\\team-host\\projects\\${team.projectId}`, root_id: 'x',
    root_revision: 3, runtime_preferences: {}, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
    later_field: { kept: true } } } });
  const newerFile = path.join(fx.root, 'projects-newer.json');
  fs.writeFileSync(newerFile, newer);
  const manifest = { schema: 1, team_name: fx.teamName, team_id: null, exported_at: 1, relay_token: null, key: fx.hostKey,
    setting: { name: fx.teamName, direct_port: null, internet: null } };
  const fresh = createMaintenanceFixture(t, { writeKey: false });
  await writeBackup({ target: path.join(fresh.exchangeDir, 'newer.jennyteam'), password: PASSWORD, manifest, entries: [
    { rel: 'profile', dir: true }, { rel: 'profile/team-members.json', abs: path.join(fx.profile, 'team-members.json') },
    { rel: 'profile/projects.json', abs: newerFile }] });
  const before = fresh.volumes();
  assert.deepEqual(await restore(fresh, 'newer.jennyteam'), { ok: false, reason: 'team_backup_too_new' });
  assertUntouched(fresh, before);
  assert.deepEqual(fs.readdirSync(fresh.data), ['projects'], 'no staging left');
  assert.equal(fs.readFileSync(newerFile, 'utf8'), newer, 'the source file byte for byte');
});

test('nothing is written outside the three volumes and the exchange folder', async (t) => {
  const { fx } = await seeded(t);
  const out = await exported(fx);
  const fresh = freshWith(t, out.file);
  const outside = () => snapshot(fresh.root, { skip: (rel) => ['profile', 'data', 'secrets', 'exchange'].includes(rel.split('/')[0]) });
  const before = outside();
  assert.equal((await restore(fresh, out.name)).ok, true);
  assert.deepEqual(outside(), before);
});

test('restore refuses a file name that is not one plain name, a link, and no terminal', async (t) => {
  const { fx } = await seeded(t);
  const out = await exported(fx);
  const fresh = freshWith(t, out.file);
  for (const name of ['../x', 'a/b', 'nul', 'x.', 'a:b', 'x'.repeat(256)]) {
    assert.deepEqual(await restore(fresh, name), { ok: false, reason: 'team_restore_file_invalid' }, name);
  }
  assert.deepEqual(await restore(fresh, 'absent.jennyteam'), { ok: false, reason: 'team_restore_file_invalid' });
  fs.mkdirSync(path.join(fresh.exchangeDir, 'folder.jennyteam'));
  assert.deepEqual(await restore(fresh, 'folder.jennyteam'), { ok: false, reason: 'team_restore_file_invalid' });
  const pipe = { ...fresh.args(), input: { isTTY: false } };
  assert.deepEqual(await restoreHostedTeam({ ...pipe, fileName: out.name }), { ok: false, reason: 'team_tty_required' });
  assert.equal(fresh.lock.acquired, 2, 'a bad name and no terminal are refused before the lock');
});

test('export failure paths leave no partial and each refuses with its word', async (t) => {
  const run = (fx, extra = {}) => exportHostedTeam({ ...fx.args(), readPasswordImpl: fx.passwords(PASSWORD, PASSWORD).read,
    ...extra });
  await t.test('a file that vanishes while the backup is written', async (st) => {
    const { fx } = await seeded(st);
    const victim = path.join(fx.profile, 'team-chat', 'index.json');
    const answers = [PASSWORD, PASSWORD];
    const readPasswordImpl = async () => { if (answers.length === 1) fs.rmSync(victim); return answers.shift(); };
    const result = await exportHostedTeam({ ...fx.args(), readPasswordImpl });
    assert.equal(result.ok, false);
    assert.match(result.reason, /^team_backup_(write_failed|source_changed)$/u);
    assert.deepEqual(fs.readdirSync(fx.exchangeDir), [], 'no partial, no temporary file');
  });
  await t.test('a link in the profile', async (st) => {
    const { fx } = await seeded(st);
    fs.symlinkSync(fx.root, path.join(fx.profile, 'team-chat', 'away'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(await run(fx), { ok: false, reason: 'team_export_links', count: 1 });
    assert.deepEqual(fs.readdirSync(fx.exchangeDir), []);
  });
  await t.test('too many entries', async (st) => {
    const { fx } = await seeded(st);
    assert.deepEqual(await run(fx, { walkLimit: 3 }), { ok: false, reason: 'team_export_too_many', count: 3 });
  });
  await t.test('an unreadable file (POSIX, not as root)', async (st) => {
    if (!POSIX || process.getuid?.() === 0) { st.skip('needs a POSIX user that a mode can refuse'); return; }
    const { fx } = await seeded(st);
    const dir = path.join(fx.profile, 'team-chat');
    fs.chmodSync(dir, 0o000);
    st.after(() => fs.chmodSync(dir, 0o700));
    const result = await run(fx);
    assert.equal(result.reason, 'team_export_unreadable_files');
  });
  for (const [marker, reason] of [['.jenny-team-deleting', 'team_delete_unfinished'], ['.jenny-team-restoring', 'team_restore_unfinished']]) {
    await t.test(marker, async (st) => {
      const { fx } = await seeded(st);
      fs.writeFileSync(path.join(fx.profile, marker), '');
      assert.deepEqual(await run(fx), { ok: false, reason });
    });
  }
  await t.test('a key file that is not the team\'s', async (st) => {
    const { fx } = await seeded(st);
    fs.writeFileSync(fx.keyFile, `${crypto.randomBytes(32).toString('base64url')}\n`);
    assert.deepEqual(await run(fx), { ok: false, reason: 'team_host_key_mismatch' });
  });
  await t.test('a missing projects root, and a linked one', async (st) => {
    const { fx } = await seeded(st);
    const real = path.join(fx.root, 'projects-real');
    fs.renameSync(fx.projects, real);
    assert.deepEqual(await run(fx), { ok: false, reason: 'team_projects_root_missing' });
    try { fs.symlinkSync(real, fx.projects, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
      if (error?.code === 'EPERM') { st.skip('links need a privilege here'); return; }
      throw error;
    }
    assert.deepEqual(await run(fx), { ok: false, reason: 'team_projects_root_symlink_invalid' });
    assert.deepEqual(fs.readdirSync(fx.exchangeDir), []);
  });
});

test('an existing name refuses before the walk and the password; leftovers of a killed export are swept', async (t) => {
  const { fx } = await seeded(t);
  const now = Date.UTC(2026, 10, 13, 9, 8, 7);
  const taken = 'jenny-team-20261113-090807.jennyteam';
  fs.writeFileSync(path.join(fx.exchangeDir, taken), 'keep me');
  const pw = fx.passwords(PASSWORD, PASSWORD);
  assert.deepEqual(await exportHostedTeam({ ...fx.args(), readPasswordImpl: pw.read, clock: () => now }),
    { ok: false, reason: 'team_export_exists' });
  assert.deepEqual(pw.asked, [], 'refused before the password');
  assert.equal(fs.readFileSync(path.join(fx.exchangeDir, taken), 'utf8'), 'keep me', 'never replaced');
  const leftovers = ['.jenny-team-20261101-000000.jennyteam.partial',
    '..jenny-team-20261101-000000.jennyteam.partial.0123456789ab.tmp'];
  const nearMisses = ['.jenny-team-20261101-000000.jennyteam.partial.bak', 'jenny-team-x.partial',
    '.jenny-team-20261101-000000.jennyteam.partial.0123456789ab.tmp'];
  for (const name of [...leftovers, ...nearMisses]) fs.writeFileSync(path.join(fx.exchangeDir, name), 'old');
  const out = await exportHostedTeam({ ...fx.args(), readPasswordImpl: fx.passwords(PASSWORD, PASSWORD).read,
    clock: () => now + 1000 });
  assert.equal(out.ok, true, JSON.stringify(out));
  const left = fs.readdirSync(fx.exchangeDir);
  for (const name of leftovers) assert.equal(left.includes(name), false, `swept ${name}`);
  for (const name of nearMisses) assert.equal(left.includes(name), true, `kept ${name}`);
});

test('the manifest carries the member store\'s team name, not a stale config name', async (t) => {
  const { fx } = await seeded(t);
  fs.writeFileSync(fx.configPath, fs.readFileSync(fx.configPath, 'utf8').replace(fx.teamName, 'Old Config Name'));
  const out = await exported(fx);
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  const desktop = path.join(fx.root, 'desk-name');
  fs.mkdirSync(desktop);
  const answer = await restoreTeam({ userDataPath: desktop, file: out.file, password: PASSWORD, keys: { restore() {} } });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.team_name, fx.teamName);
});

test('row 151 T1: an exported and restored team has the same board files byte for byte', async (t) => {
  const { fx, team } = await seeded(t);
  const boardId = await fx.seedBoard(team.projectId);
  const boards = snapshot(path.join(fx.profile, 'team-boards'));
  assert.equal(Object.keys(boards).includes(`${team.projectId}/${boardId}.journal.json`), true);
  assert.equal(Object.keys(boards).includes(`${team.projectId}/assets/seed.png`), true);
  const out = await exported(fx);
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  const fresh = freshWith(t, out.file);
  const restored = await restore(fresh, out.name);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.deepEqual(snapshot(path.join(fresh.profile, 'team-boards')), boards);
});
