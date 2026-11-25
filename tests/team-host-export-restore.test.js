'use strict';

// Export and restore of a hosted team (slice 5-6, E63): services/team/host/host-export.js and host-restore.js
// through the controller, with the pickers as test doubles.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { HOST_KEY_NAME, HOST_RELAY_TOKEN_NAME } = require('../services/team/host/host-key-store');
const { createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, tempProfile } = require('./helpers/team-client-host');
const { NOW, TEAM_ID, TEAM_NAME, seedOwnership, seedTeamFiles, treeBytes } = require('./helpers/team-host-seed');

const PASSWORD = 'a long backup password';
const TOKEN = `relaytoken_${'z'.repeat(32)}`;
const NAMES = Object.freeze({ display_name: 'Olive', label: 'Desk' });
// The store files a backup carries (no lock, ready marker or temporary file).
const STORES = (rel) => /^(?:profile|projects|trash)\//u.test(rel) && !/(?:\.host\.lock|team-ready\.json)$/u.test(rel);

function team(t, { key = true, holds = true } = {}) {
  const userDataPath = tempProfile(t, 'jenny-host-backup-');
  const secureStore = createMemorySecureStore();
  seedTeamFiles(userDataPath, { internet: { map_port: true, public_address: null, relay_url: 'https://relay.example.org' } });
  seedOwnership(userDataPath, secureStore, { key });
  secureStore.values.set(HOST_RELAY_TOKEN_NAME, TOKEN);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-export-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const picks = { folder: outside, file: null };
  const calls = [];
  const service = { holds: () => holds, handle: async (method, payload) => { calls.push([method, payload.team_id]); return { ok: true }; },
    ownerJoin: async () => ({ ok: true, team: { team_id: TEAM_ID } }), ownerRecover: async () => ({ ok: true, team: { team_id: TEAM_ID } }) };
  const made = createTestHostController(t, { userDataPath, secureStore, service, now: () => NOW,
    pick: { folder: async () => picks.folder, file: async () => picks.file }, script: healthyHostScript({ teamId: TEAM_ID }) });
  return { ...made, userDataPath, secureStore, outside, picks, calls };
}

async function exported(host) {
  const answer = await host.controller.handle('hostExport', { password: PASSWORD });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return answer;
}

test('the export writes a readable copy of what the owner can read, and a password-locked backup', async (t) => {
  const host = team(t);
  const answer = await exported(host);
  assert.equal(answer.folder, path.join(fs.realpathSync.native(host.outside), `${TEAM_NAME} 2026-11-12`));
  const files = fs.readdirSync(answer.folder).sort();
  assert.deepEqual(files, [`${TEAM_NAME}.jennyteam`, 'messages', 'projects']);
  assert.deepEqual(fs.readdirSync(path.join(answer.folder, 'projects')), ['jenny-site'], 'only the projects the owner joined (E30)');
  assert.equal(fs.readFileSync(path.join(answer.folder, 'projects', 'jenny-site', 'index.html'), 'utf8'), '<h1>site</h1>');
  assert.deepEqual(fs.readdirSync(path.join(answer.folder, 'messages')).sort(), ['#jenny-site.md', '#team.md', 'Dot.md']);
  const teamText = fs.readFileSync(path.join(answer.folder, 'messages', '#team.md'), 'utf8');
  assert.match(teamText, /\*\*Olive\*\* · 2026-11-1\d 10:01\nHello all/u);
  assert.equal(teamText.includes('gone'), false, 'a deleted message is not written');
  // Nothing the owner cannot read, and no secret or id, in the readable copy.
  const readable = Object.entries(treeBytes(answer.folder)).filter(([rel]) => !rel.endsWith('.jennyteam'))
    .map(([, hex]) => Buffer.from(hex, 'hex').toString('utf8')).join('\n');
  for (const absent of ['Secret tax talk', 'receipts', TOKEN, TEAM_ID, 'member_', 'device_', 'invite_']) assert.equal(readable.includes(absent), false, absent);
  // The backup holds neither the token nor the key in clear; the password is nowhere.
  const backup = fs.readFileSync(path.join(answer.folder, `${TEAM_NAME}.jennyteam`));
  const seed = host.secureStore.values.get(HOST_KEY_NAME);
  for (const absent of [TOKEN, seed, PASSWORD, 'Hello all']) assert.equal(backup.includes(Buffer.from(absent)), false, absent);
  const everywhere = JSON.stringify([answer, host.logs, host.pushed]);
  for (const absent of [PASSWORD, TOKEN, seed]) assert.equal(everywhere.includes(absent), false);
});

test('a picked folder that resolves inside team-host is refused; a short password and a cancelled picker change nothing', async (t) => {
  const host = team(t);
  host.picks.folder = path.join(host.userDataPath, 'team-host', 'projects');
  assert.equal((await host.controller.handle('hostExport', { password: PASSWORD })).error.reason, 'team_export_folder_invalid');
  const link = path.join(host.outside, 'sneaky');
  fs.symlinkSync(path.join(host.userDataPath, 'team-host'), link, 'junction');
  host.picks.folder = link;
  assert.equal((await host.controller.handle('hostExport', { password: PASSWORD })).error.reason, 'team_export_folder_invalid');
  assert.equal((await host.controller.handle('hostExport', { password: 'too short' })).error.reason, 'team_backup_password_short');
  host.picks.folder = null;
  assert.equal((await host.controller.handle('hostExport', { password: PASSWORD })).error.reason, 'team_export_cancelled');
  assert.deepEqual(fs.readdirSync(host.outside), ['sneaky']);
});

test('export, delete, restore: the same stores byte for byte, the same key, and the team starts', async (t) => {
  const host = team(t, { holds: false });
  const before = treeBytes(path.join(host.userDataPath, 'team-host'), (rel) => !STORES(rel));
  const key = host.secureStore.values.get(HOST_KEY_NAME);
  const answer = await exported(host);
  assert.equal((await host.controller.handle('hostDelete', { name: TEAM_NAME })).ok, true);
  assert.equal(host.secureStore.values.has(HOST_KEY_NAME), false);
  host.picks.file = path.join(answer.folder, `${TEAM_NAME}.jennyteam`);
  const picked = await host.controller.handle('hostRestorePick', {});
  assert.deepEqual(picked, { ok: true, file_name: `${TEAM_NAME}.jennyteam`, size: fs.statSync(host.picks.file).size });
  const wrong = await host.controller.handle('hostRestore', { password: 'not the password', ...NAMES });
  assert.equal(wrong.error.reason, 'team_backup_password_wrong');
  assert.equal(fs.existsSync(path.join(host.userDataPath, 'team-host')), false, 'a wrong password changes nothing on disk');
  assert.equal(host.secureStore.values.has(HOST_KEY_NAME), false, 'nor in the secure store');
  assert.deepEqual(fs.readdirSync(host.userDataPath).filter((name) => name.startsWith('team-host')), []);
  const restored = await host.controller.handle('hostRestore', { password: PASSWORD, ...NAMES });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.team_name, TEAM_NAME);
  assert.equal(restored.exported_at, NOW);
  assert.deepEqual(treeBytes(path.join(host.userDataPath, 'team-host'), (rel) => !STORES(rel)), before);
  assert.equal(host.secureStore.values.get(HOST_KEY_NAME), key, 'the same key');
  assert.equal(host.secureStore.values.has(HOST_RELAY_TOKEN_NAME), false, 'internet joining comes back off; the token is entered again with it');
  assert.equal(restored.host.team_name, TEAM_NAME);
  assert.equal(restored.host.key, 'ok');
  assert.ok(host.fake.calls.at(-1).args.includes('--team-recover'), 'with no membership left, the owner gets back in through Recover');
  assert.equal(restored.host.state, 'running');
});

test('R09-F04: after a rename the backup is named and labelled with the current name, and a restore writes it back', async (t) => {
  const host = team(t, { holds: false });
  const file = path.join(host.userDataPath, 'team-host', 'profile', 'team-members.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...doc, team: { ...doc.team, name: 'Studio North' } })); // team.rename
  const answer = await exported(host);
  assert.equal(path.basename(answer.folder), 'Studio North 2026-11-12');
  host.picks.file = path.join(answer.folder, 'Studio North.jennyteam');
  assert.equal(fs.existsSync(host.picks.file), true);
  assert.equal((await host.controller.handle('hostDelete', { name: 'Studio North' })).ok, true);
  assert.equal((await host.controller.handle('hostRestorePick', {})).ok, true);
  const restored = await host.controller.handle('hostRestore', { password: PASSWORD, ...NAMES });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.team_name, 'Studio North');
  const config = JSON.parse(fs.readFileSync(path.join(host.userDataPath, 'team-host', 'host-config.json'), 'utf8'));
  assert.equal(config.team.name, 'Studio North', 'the restored config carries the current name');
});

test('a one-byte change, a truncated file and a newer version each change nothing on disk or in the secure store', async (t) => {
  const host = team(t);
  const answer = await exported(host);
  assert.equal((await host.controller.handle('hostDelete', { name: TEAM_NAME })).ok, true);
  const original = fs.readFileSync(path.join(answer.folder, `${TEAM_NAME}.jennyteam`));
  const bad = path.join(host.outside, 'bad.jennyteam');
  const variants = [['team_backup_password_wrong', (b) => { b[b.length - 40] ^= 1; return b; }],
    ['team_backup_password_wrong', (b) => b.subarray(0, b.length - 100)],
    ['team_backup_too_new', (b) => { b.writeUInt16BE(9, 12); return b; }]];
  for (const [reason, change] of variants) {
    fs.writeFileSync(bad, change(Buffer.from(original)));
    host.picks.file = bad;
    const picked = await host.controller.handle('hostRestorePick', {});
    const answerRestore = picked.ok ? await host.controller.handle('hostRestore', { password: PASSWORD, ...NAMES }) : picked;
    assert.equal(answerRestore.error.reason, reason);
    assert.deepEqual(fs.readdirSync(host.userDataPath).filter((name) => name.startsWith('team-host')), []);
    assert.equal(host.secureStore.values.has(HOST_KEY_NAME), false);
  }
});

test('restore from the lost-key page sets the keyless team aside first, and the restored team starts', async (t) => {
  const host = team(t);
  const answer = await exported(host);
  host.secureStore.values.delete(HOST_KEY_NAME);
  fs.writeFileSync(path.join(host.userDataPath, 'team-host', 'projects', 'project_site', 'after-export.txt'), 'later');
  host.picks.file = path.join(answer.folder, `${TEAM_NAME}.jennyteam`);
  assert.equal((await host.controller.handle('hostRestorePick', {})).ok, true);
  assert.equal((await host.controller.handle('hostRestore', { password: PASSWORD, ...NAMES })).error.reason, 'team_delete_name_mismatch');
  const restored = await host.controller.handle('hostRestore', { password: PASSWORD, ...NAMES, name: TEAM_NAME });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  const old = restored.host.old_teams;
  assert.equal(old.length, 1, 'the keyless team is set aside, not deleted');
  assert.equal(fs.readFileSync(path.join(host.userDataPath, `team-host-old-${old[0].id}`, 'projects', 'project_site', 'after-export.txt'), 'utf8'), 'later');
  assert.equal(fs.existsSync(path.join(host.userDataPath, 'team-host', 'projects', 'project_site', 'after-export.txt')), false);
  assert.equal(restored.host.key, 'ok');
  assert.equal(restored.host.state, 'running');
});

test('restore is refused on a PC that hosts a team with its key', async (t) => {
  const host = team(t);
  const answer = await exported(host);
  host.picks.file = path.join(answer.folder, `${TEAM_NAME}.jennyteam`);
  assert.equal((await host.controller.handle('hostRestorePick', {})).ok, true);
  const refused = await host.controller.handle('hostRestore', { password: PASSWORD, ...NAMES, name: TEAM_NAME });
  assert.equal(refused.error.reason, 'team_host_exists');
});

// ------------------------------------------------------------------ review of 5-6 (fix list items 5, 7, 9, 10, 12, 16, 20)

const { writeBackup } = require('../services/team/host/host-backup');
const { exportTeam } = require('../services/team/host/host-export');
const { restoreTeam } = require('../services/team/host/host-restore');
const { PUBLIC_KEY_BYTES, encodeBase64url } = require('../server/team/ids');

// Every answer, log line and pushed state of `host` (and `extra`) as one text, for the secret scans.
const seen = (host, ...extra) => JSON.stringify([host.logs, host.pushed, ...extra]);
const tiny = async () => ({ bavail: 1, bsize: 4096 });

test('a failed restore leaves the relay token this PC had before exactly as it was', async (t) => {
  const host = team(t);
  const answer = await exported(host);
  host.secureStore.values.delete(HOST_KEY_NAME);
  const mine = `relaytoken_${'m'.repeat(32)}`;
  host.secureStore.values.set(HOST_RELAY_TOKEN_NAME, mine);
  const realSet = host.secureStore.set;
  host.secureStore.set = (key, value) => { if (key === HOST_KEY_NAME) throw new Error('SecureStore: refusing to store.'); return realSet(key, value); };
  host.picks.file = path.join(answer.folder, `${TEAM_NAME}.jennyteam`);
  assert.equal((await host.controller.handle('hostRestorePick', {})).ok, true);
  const failed = await host.controller.handle('hostRestore', { password: PASSWORD, ...NAMES, name: TEAM_NAME });
  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.equal(host.secureStore.values.get(HOST_RELAY_TOKEN_NAME), mine, 'the token that was there is still there');
  assert.equal(fs.existsSync(path.join(host.userDataPath, 'team-host', 'host-config.json')), true, 'the keyless team is back from aside');
  assert.deepEqual(fs.readdirSync(host.userDataPath).filter((name) => /^team-host-(?:old|restoring)-/u.test(name)), []);
  for (const secret of [PASSWORD, TOKEN, mine]) assert.equal(seen(host, failed).includes(secret), false, 'no secret in a failed restore');
});

test('a restored team comes back with internet joining off and the backup\'s values kept for the form; a bad value is refused', async (t) => {
  const host = team(t, { holds: false });
  // Team host file tools I11: a team exported with file tools on is restored with them off.
  const configPath = path.join(host.userDataPath, 'team-host', 'host-config.json');
  const live = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.writeFileSync(configPath, JSON.stringify({ ...live, team: { ...live.team, file_tools: true } }));
  const answer = await exported(host);
  assert.equal((await host.controller.handle('hostDelete', { name: TEAM_NAME })).ok, true);
  host.picks.file = path.join(answer.folder, `${TEAM_NAME}.jennyteam`);
  assert.equal((await host.controller.handle('hostRestorePick', {})).ok, true);
  const restored = await host.controller.handle('hostRestore', { password: PASSWORD, ...NAMES });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.host.internet, null, 'off until the owner turns it on through the page');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(configPath, 'utf8')).team, 'file_tools'), false,
    'I11: file tools come back off');
  assert.deepEqual(restored.host.internet_draft, { public_address: null, relay_url: 'https://relay.example.org' });
  assert.equal(host.secureStore.values.has(HOST_RELAY_TOKEN_NAME), false, 'the backup\'s token is not stored: the owner enters it with the relay');
  assert.equal((await host.controller.handle('hostInternet', { enabled: true })).ok, true, 'turning it on keeps the draft for the form');
  assert.notEqual((await host.controller.handle('hostStatus', {})).host.internet_draft, null);
  const saved = await host.controller.handle('hostInternet', { enabled: true, relay_url: 'https://relay.example.org', token: TOKEN });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal((await host.controller.handle('hostStatus', {})).host.internet_draft, null, 'a save that names the values ends the draft');
  // A backup whose internet setting `hostInternet` would refuse is refused whole.
  const userDataPath = tempProfile(t, 'jenny-restore-bad-');
  const file = path.join(host.outside, 'bad-internet.jennyteam');
  await writeBackup({ target: file, password: PASSWORD, entries: [], manifest: { schema: 1, team_name: 'Bad', exported_at: NOW, relay_token: null,
    key: encodeBase64url(Buffer.alloc(PUBLIC_KEY_BYTES, 3)), setting: { name: 'Bad', direct_port: 51820, internet: { map_port: true, public_address: 'not an address!!', relay_url: 'ftp://x' } } } });
  const keys = { restore: () => { throw new Error('must not be reached'); }, load: () => null };
  const bad = await restoreTeam({ userDataPath, file, password: PASSWORD, keys });
  assert.deepEqual(bad, { ok: false, reason: 'team_backup_password_wrong' });
  assert.deepEqual(fs.readdirSync(userDataPath).filter((name) => name.startsWith('team-host')), []);
});

test('an export that cannot read the whole team fails with a count before any password work', async (t) => {
  const host = team(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-link-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(host.userDataPath, 'team-host', 'profile', 'linked'), 'junction');
  const crypto = require('node:crypto');
  const derive = t.mock.method(crypto, 'scrypt');
  const links = await host.controller.handle('hostExport', { password: PASSWORD });
  assert.deepEqual([links.error?.reason, links.error?.count], ['team_export_links', 1], JSON.stringify(links));
  fs.rmSync(path.join(host.userDataPath, 'team-host', 'profile', 'linked'));
  const unreadable = path.join(host.userDataPath, 'team-host', 'projects', 'project_site', 'index.html');
  const realLstat = fs.promises.lstat;
  t.mock.method(fs.promises, 'lstat', (target, ...rest) => (String(target) === unreadable
    ? Promise.reject(Object.assign(new Error('locked'), { code: 'EBUSY' })) : realLstat(target, ...rest)));
  const locked = await host.controller.handle('hostExport', { password: PASSWORD });
  assert.deepEqual([locked.error?.reason, locked.error?.count], ['team_export_unreadable_files', 1], JSON.stringify(locked));
  assert.equal(derive.mock.callCount(), 0, 'no key was derived');
  assert.deepEqual(fs.readdirSync(host.outside), [], 'nothing was written');
  const real = fs.realpathSync.native(path.join(host.userDataPath, 'team-host'));
  const many = await exportTeam({ root: real, picked: host.outside, userDataPath: host.userDataPath, ownerId: 'member_ownerAAAA1111', password: PASSWORD,
    setting: { name: TEAM_NAME, direct_port: null, internet: null }, secrets: { seed: Buffer.alloc(32, 1), relayToken: null }, limit: 3 });
  assert.deepEqual([many.reason, many.count], ['team_export_too_many', 3]);
  assert.deepEqual(fs.readdirSync(host.outside), []);
});

test('a drive without room refuses the export and the restore before anything is written', async (t) => {
  const host = team(t);
  const real = fs.realpathSync.native(path.join(host.userDataPath, 'team-host'));
  const full = await exportTeam({ root: real, picked: host.outside, userDataPath: host.userDataPath, ownerId: 'member_ownerAAAA1111', password: PASSWORD,
    setting: { name: TEAM_NAME, direct_port: null, internet: null }, secrets: { seed: Buffer.alloc(32, 1), relayToken: null }, statfs: tiny });
  assert.deepEqual(full, { ok: false, reason: 'team_disk_full' });
  assert.deepEqual(fs.readdirSync(host.outside), []);
  const answer = await exported(host);
  const userDataPath = tempProfile(t, 'jenny-restore-full-');
  const restoreFull = await restoreTeam({ userDataPath, file: path.join(answer.folder, `${TEAM_NAME}.jennyteam`), password: PASSWORD,
    keys: { restore: () => { throw new Error('must not be reached'); } }, statfs: tiny });
  assert.deepEqual(restoreFull, { ok: false, reason: 'team_disk_full' });
  assert.deepEqual(fs.readdirSync(userDataPath), []);
});

test('the readable copy is written a step at a time: main keeps answering while a large project is copied', async (t) => {
  const host = team(t);
  const big = path.join(host.userDataPath, 'team-host', 'projects', 'project_site', 'many');
  fs.mkdirSync(big);
  for (let i = 0; i < 1500; i += 1) fs.writeFileSync(path.join(big, `f${i}.txt`), String(i));
  const exporting = host.controller.handle('hostExport', { password: PASSWORD });
  const counts = new Set();
  let done = false;
  exporting.then(() => { done = true; });
  const copied = path.join(fs.realpathSync.native(host.outside), `${TEAM_NAME} 2026-11-12`, 'projects', 'jenny-site', 'many');
  while (!done) {
    await new Promise((resolve) => { setImmediate(resolve); });
    try { counts.add(fs.readdirSync(copied).length); } catch { /* not there yet */ }
  }
  assert.equal((await exporting).ok, true);
  assert.ok([...counts].some((n) => n > 0 && n < 1500), `seen part way: ${[...counts].slice(0, 8)}`);
});

test('no password, key or relay token in any log, push or answer of a wrong password, a tampered file or a failed delete', async (t) => {
  const host = team(t);
  const answer = await exported(host);
  const seed = host.secureStore.values.get(HOST_KEY_NAME);
  const answers = [];
  assert.equal((await host.controller.handle('hostDelete', { name: TEAM_NAME })).ok, true);
  host.picks.file = path.join(answer.folder, `${TEAM_NAME}.jennyteam`);
  answers.push(await host.controller.handle('hostRestorePick', {}));
  answers.push(await host.controller.handle('hostRestore', { password: `${PASSWORD} but wrong`, ...NAMES }));
  const tampered = path.join(host.outside, 'tampered.jennyteam');
  const bytes = fs.readFileSync(host.picks.file);
  bytes[bytes.length - 30] ^= 1;
  fs.writeFileSync(tampered, bytes);
  host.picks.file = tampered;
  answers.push(await host.controller.handle('hostRestorePick', {}));
  answers.push(await host.controller.handle('hostRestore', { password: PASSWORD, ...NAMES }));
  const other = team(t);
  fs.symlinkSync(other.outside, path.join(other.userDataPath, 'team-host', 'projects', 'project_site', 'linked'), 'junction');
  answers.push(await other.controller.handle('hostDelete', { name: TEAM_NAME }));
  assert.equal(answers.at(-1).ok, false);
  const otherSeed = other.secureStore.values.get(HOST_KEY_NAME);
  const text = seen(host, answers) + seen(other);
  for (const secret of [PASSWORD, TOKEN, seed, otherSeed]) assert.equal(text.includes(secret), false, 'a secret leaked');
});

test('a picked folder that holds team-host is refused; an export that never finished is swept at the next start', async (t) => {
  const host = team(t);
  host.picks.file = null;
  host.picks.folder = host.userDataPath;
  assert.equal((await host.controller.handle('hostExport', { password: PASSWORD })).error?.reason, 'team_export_folder_invalid');
  const half = path.join(fs.realpathSync.native(host.outside), 'Studio 2026-11-12');
  fs.mkdirSync(path.join(half, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(half, '.Studio.jennyteam.0123456789ab.tmp'), 'partial');
  fs.writeFileSync(path.join(host.userDataPath, 'team-export-pending.json'), JSON.stringify({ schema_version: 1, parent: path.dirname(half), folder: half }));
  createTestHostController(t, { userDataPath: host.userDataPath, secureStore: host.secureStore, now: () => NOW, script: healthyHostScript({ teamId: TEAM_ID }) });
  for (let i = 0; i < 100 && fs.existsSync(half); i += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(fs.existsSync(half), false, 'the partial export and its temporary file are gone');
  assert.equal(fs.existsSync(path.join(host.userDataPath, 'team-export-pending.json')), false);
});

// Review sweeps, second run (X4b-F04): with the key here and a member store that does not read, Restore names the
// unreadable store (the way out is Delete, then Restore), and Export is no longer `team_owner_only`: it passes the
// owner check (what it then writes is owner decision E73, below).
test('X4b-F04: a member store that does not read: Restore says so, and Export is not refused as owner only', async (t) => {
  const host = team(t);
  const answer = await exported(host);
  fs.writeFileSync(path.join(host.userDataPath, 'team-host', 'profile', 'team-members.json'), Buffer.alloc(4096));
  host.picks.file = path.join(answer.folder, `${TEAM_NAME}.jennyteam`);
  assert.equal((await host.controller.handle('hostRestorePick', {})).ok, true);
  for (const extra of [{}, { name: TEAM_NAME }]) {
    const refused = await host.controller.handle('hostRestore', { password: PASSWORD, ...NAMES, ...extra });
    assert.equal(refused.error?.reason, 'team_members_unreadable', JSON.stringify(refused));
  }
  const again = await host.controller.handle('hostExport', { password: PASSWORD });
  assert.deepEqual([again.ok, again.backup_left_out], [true, true], JSON.stringify(again));
});

// Owner decision E73 (2026-11-14): with the key here and a member store that does not read, Export writes the readable
// copy only, with no backup file, and its ok answer says the backup was left out. Without the member list nobody's
// projects or direct conversations are known, so only #team is written and every author is "Someone". A member store
// that is not there at all still refuses as before.
test('E73: Export over a member list that does not read writes the readable copy only and says the backup was left out', async (t) => {
  const host = team(t);
  fs.writeFileSync(path.join(host.userDataPath, 'team-host', 'profile', 'team-members.json'), Buffer.alloc(4096));
  const answer = await host.controller.handle('hostExport', { password: PASSWORD });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.backup_left_out, true);
  assert.deepEqual(fs.readdirSync(answer.folder).sort(), ['messages', 'projects'], 'no .jennyteam file');
  assert.deepEqual(fs.readdirSync(path.join(answer.folder, 'messages')), ['#team.md']);
  assert.deepEqual(fs.readdirSync(path.join(answer.folder, 'projects')), []);
  const teamText = fs.readFileSync(path.join(answer.folder, 'messages', '#team.md'), 'utf8');
  assert.match(teamText, /\*\*Someone\*\* · 2026-11-1\d 10:01\nHello all/u);
  const seed = host.secureStore.values.get(HOST_KEY_NAME);
  const readable = Object.values(treeBytes(answer.folder)).map((hex) => Buffer.from(hex, 'hex').toString('utf8')).join('\n');
  for (const absent of [PASSWORD, TOKEN, seed, TEAM_ID, 'member_', 'Private hello', 'Secret tax talk']) assert.equal(readable.includes(absent), false, absent);
  const said = JSON.stringify([answer, host.logs, host.pushed]);
  for (const absent of [PASSWORD, TOKEN, seed]) assert.equal(said.includes(absent), false, 'no secret answered or logged');
  assert.equal(fs.existsSync(path.join(host.userDataPath, 'team-export-pending.json')), false, 'the pending record is cleared');
  // A member store that is not there is refused as before (the export never reaches the readable copy).
  const gone = team(t);
  fs.rmSync(path.join(gone.userDataPath, 'team-host', 'profile', 'team-members.json'));
  const refused = await exportTeam({ root: fs.realpathSync.native(path.join(gone.userDataPath, 'team-host')), picked: gone.outside,
    userDataPath: gone.userDataPath, ownerId: null, setting: { name: TEAM_NAME }, secrets: { seed: Buffer.alloc(32), relayToken: null },
    password: PASSWORD, now: NOW });
  assert.deepEqual(refused, { ok: false, reason: 'team_export_unreadable' });
  assert.deepEqual(fs.readdirSync(gone.outside), []);
});

// Review sweeps, pass two (X3d-F01): a window that picks a backup again and again is watched for its close once.
test('X3d-F01: twelve Restore picks in one window leave one destroyed listener, and closing it drops the pick', async (t) => {
  const host = team(t, { holds: false });
  const answer = await exported(host);
  assert.equal((await host.controller.handle('hostDelete', { name: TEAM_NAME })).ok, true);
  host.picks.file = path.join(answer.folder, `${TEAM_NAME}.jennyteam`);
  const sender = Object.assign(new EventEmitter(), { id: 7 });
  for (let i = 0; i < 12; i += 1) assert.equal((await host.controller.handle('hostRestorePick', {}, { sender })).ok, true);
  assert.equal(sender.listenerCount('destroyed'), 1);
  sender.emit('destroyed');
  const after = await host.controller.handle('hostRestore', { password: PASSWORD, ...NAMES }, { sender });
  assert.equal(after.ok, false, 'the pick of the closed window is gone');
});

// Review sweeps, second run (X4b-F03): every restored file is synced (and each folder holding one is asked to be) before
// the config and the key commit the restore, so a power loss after the ok cannot leave a keyed team of torn stores.
test('X4b-F03: a restore syncs every restored file and its folder before the key is stored', async (t) => {
  const host = team(t, { holds: false });
  const answer = await exported(host);
  assert.equal((await host.controller.handle('hostDelete', { name: TEAM_NAME })).ok, true);
  const opened = new Map();
  const synced = { files: new Set(), dirs: new Set() };
  const realOpen = fs.openSync;
  const realFsync = fs.fsyncSync;
  const realFsyncAsync = fs.fsync;
  const unpatch = () => { fs.openSync = realOpen; fs.fsyncSync = realFsync; fs.fsync = realFsyncAsync; };
  t.after(unpatch);
  fs.openSync = (file, ...rest) => { const fd = realOpen(file, ...rest); opened.set(fd, String(file)); return fd; };
  const note = (fd) => { if (opened.has(fd)) (fs.fstatSync(fd).isDirectory() ? synced.dirs : synced.files).add(opened.get(fd)); };
  fs.fsyncSync = (fd) => { note(fd); return realFsync(fd); };
  fs.fsync = (fd, done) => { note(fd); return realFsyncAsync(fd, done); }; // a restored file's sync is awaited
  let atRestore = null;
  const keys = { restore: () => { atRestore = { files: [...synced.files], dirs: [...synced.dirs] }; }, load: () => null };
  const restored = await restoreTeam({ userDataPath: host.userDataPath, file: path.join(answer.folder, `${TEAM_NAME}.jennyteam`),
    password: PASSWORD, keys });
  unpatch();
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.notEqual(atRestore, null, 'the key was stored');
  // The names inside the restoring folder, `/`-separated ('' for the folder itself).
  const inside = (names) => names.map((name) => /team-host-restoring-[0-9a-f]+(?:[\\/](.*))?$/u.exec(name))
    .filter(Boolean).map((match) => (match[1] ?? '').split(path.sep).join('/')).sort();
  const files = Object.keys(treeBytes(path.join(host.userDataPath, 'team-host'), (rel) => !/^(?:profile|projects|trash)(?:\/|$)/u.test(rel))).sort();
  assert.ok(files.length > 3, 'the seeded team has stores to restore');
  assert.deepEqual(inside(atRestore.files), files, 'one sync per restored file before the key');
  const folders = [...new Set(files.map((rel) => path.posix.dirname(rel)))];
  const dirs = inside(atRestore.dirs);
  assert.deepEqual(folders.filter((folder) => !dirs.includes(folder)), [], 'each folder holding a restored file');
});

// ------------------------------------------------------------------ review fixes (C4, H8, performance)

const { walkTree, walkTreeAsync } = require('../services/team/host/host-files');

test('walkTreeAsync sizes files with the asynchronous lstat, gives walkTree\'s totals, and counts a file it cannot size', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-walk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let d = 0; d < 3; d += 1) {
    fs.mkdirSync(path.join(root, `d${d}`, 'deep'), { recursive: true });
    for (let i = 0; i < 90; i += 1) fs.writeFileSync(path.join(root, `d${d}`, i % 2 ? 'deep' : '', `f${i}.bin`), Buffer.alloc(i + 1, 1));
  }
  const sync = walkTree(root);
  const sizes = [];
  const realLstatSync = fs.lstatSync;
  const inTree = (target) => String(target).startsWith(root);
  let syncCalls = 0;
  t.mock.method(fs, 'lstatSync', (target, ...rest) => { if (inTree(target)) syncCalls += 1; return realLstatSync(target, ...rest); });
  const async = await walkTreeAsync(root, { onFile: (rel, abs, size) => { sizes.push(size); } });
  assert.deepEqual(async, sync, 'the same totals');
  assert.equal(sizes.length, 270);
  assert.equal(sizes.reduce((a, b) => a + b, 0), sync.bytes);
  assert.equal(syncCalls, 0, 'no synchronous lstat on the calling thread');
  const target = path.join(root, 'd0', 'f0.bin');
  const realLstat = fs.promises.lstat;
  t.mock.method(fs.promises, 'lstat', (file, ...rest) => (String(file) === target
    ? Promise.reject(Object.assign(new Error('locked'), { code: 'EBUSY' })) : realLstat(file, ...rest)));
  const locked = await walkTreeAsync(root);
  assert.equal(locked.unreadable, 1);
  assert.equal(locked.files, 269);
  const capped = await walkTreeAsync(root, { limit: 100 });
  assert.equal(capped.truncated, true);
});

const { keyPairFromSeed } = require('../server/team/ids');
const { createGeneralProject } = require('../services/projects/project-schema');

const POSIX = process.platform !== 'win32';
const BAREBONES_SEED = Buffer.alloc(PUBLIC_KEY_BYTES, 9);

// A backup of a team made on another PC (the project's folder recorded under that PC's path), with the profile's own
// ownership files and a ready marker a file must never bring along. `hostKey` is the host key the member store names.
async function foreignBackup(t, { hostKey = keyPairFromSeed(BAREBONES_SEED).publicKey } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-foreign-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = {
    'profile/team-members.json': JSON.stringify({ schema_version: 3, rev: 1, team: { team_id: 'team_x', host_public_key: hostKey, name: 'Away' }, members: [] }),
    'profile/projects.json': JSON.stringify({ schema_version: 1, projects: {
      project_general: createGeneralProject('2026-11-01T00:00:00.000Z'),
      project_site: { id: 'project_site', name: 'Site', root_path: 'C:\\Users\\someone\\AppData\\Roaming\\jenny\\team-host\\projects\\project_site',
        root_id: 'stale', root_revision: 1, runtime_preferences: {}, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' } } }),
    'profile/profile-owner.json': '{"owner":"someone else"}',
    'profile/team-ready.json': '{"ready":true}',
    'profile/.jenny-team-restoring': '',
    'projects/project_site/index.html': '<h1>away</h1>',
  };
  const entries = [{ rel: 'profile', dir: true }, { rel: 'projects', dir: true }, { rel: 'projects/project_site', dir: true }];
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel.replace(/\//gu, '_'));
    fs.writeFileSync(abs, text);
    entries.push({ rel, abs });
  }
  const file = path.join(dir, 'away.jennyteam');
  await writeBackup({ target: file, password: PASSWORD, entries, manifest: { schema: 1, team_name: 'Away', exported_at: NOW, relay_token: null,
    key: encodeBase64url(BAREBONES_SEED), setting: { name: 'Away', direct_port: null, internet: null } } });
  return file;
}

test('H8: a desktop restore points each project folder at this PC, drops the profile\'s own files, and makes the tree private', async (t) => {
  const file = await foreignBackup(t);
  const userDataPath = tempProfile(t, 'jenny-restore-roots-');
  const keys = { restore() {} };
  const answer = await restoreTeam({ userDataPath, file, password: PASSWORD, keys });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const root = path.join(fs.realpathSync.native(userDataPath), 'team-host');
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'projects.json'), 'utf8'));
  assert.equal(doc.projects.project_site.root_path, path.join(root, 'projects', 'project_site'), 'a folder on this PC, not the other one');
  assert.equal(fs.readFileSync(path.join(root, 'projects', 'project_site', 'index.html'), 'utf8'), '<h1>away</h1>');
  for (const name of ['profile-owner.json', 'team-ready.json', '.jenny-team-restoring']) {
    assert.equal(fs.existsSync(path.join(root, 'profile', name)), false, `${name} is never brought in from a file`);
  }
  assert.equal(fs.existsSync(path.join(root, 'profile', 'team-members.json')), true);
  if (POSIX) {
    assert.equal(fs.statSync(path.join(root, 'profile')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, 'projects', 'project_site')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, 'projects', 'project_site', 'index.html')).mode & 0o777, 0o600);
  }
});

test('H8: a desktop restore refuses a backup whose key is not the member store\'s host key, and changes nothing', async (t) => {
  const file = await foreignBackup(t, { hostKey: keyPairFromSeed(Buffer.alloc(PUBLIC_KEY_BYTES, 4)).publicKey });
  const userDataPath = tempProfile(t, 'jenny-restore-mismatch-');
  const keys = { restore: () => { throw new Error('must not be reached'); } };
  assert.deepEqual(await restoreTeam({ userDataPath, file, password: PASSWORD, keys }), { ok: false, reason: 'team_host_key_mismatch' });
  assert.deepEqual(fs.readdirSync(userDataPath), [], 'no team-host and no restoring folder');
});
