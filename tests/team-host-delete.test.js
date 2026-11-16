'use strict';

// Delete this team (E61), its inventory, Start a new team after a lost key (E48) and the old teams it leaves
// (slice 5-6): services/team/host/host-lifecycle.js, host-delete.js and host-inventory.js through the controller.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { HOST_KEY_NAME, HOST_RELAY_TOKEN_NAME } = require('../services/team/host/host-key-store');
const { createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, tempProfile } = require('./helpers/team-client-host');
const { LEFTOVER_MARK, sweepLeftovers } = require('../services/team/host/host-sweep');
const {
  DOT, MAYA, NOW, OWNER, TEAM_ID, TEAM_NAME, seedOwnership, seedTeamFiles,
} = require('./helpers/team-host-seed');

const NAMES = Object.freeze({ display_name: 'Olive', label: 'Desk' });

// A seeded, stopped team with this Jenny as its owner, and a team service double that records removeTeam.
function seeded(t, { memberId = OWNER, key = true, running = false } = {}) {
  const userDataPath = tempProfile(t, 'jenny-host-delete-');
  const secureStore = createMemorySecureStore();
  const layout = seedTeamFiles(userDataPath);
  seedOwnership(userDataPath, secureStore, { memberId, key });
  const removed = [];
  const service = { holds: () => true, handle: async (method, payload) => { removed.push([method, payload.team_id]); return { ok: true }; },
    ownerJoin: async () => ({ ok: true, team: { team_id: TEAM_ID } }), ownerRecover: async () => ({ ok: true, team: { team_id: TEAM_ID } }) };
  const picks = { file: null };
  const made = createTestHostController(t, { userDataPath, secureStore, service, now: () => NOW,
    pick: { folder: async () => null, file: async () => picks.file },
    script: healthyHostScript({ teamId: TEAM_ID }), bounds: { stopMs: 300, killWaitMs: 300, startMs: 3_000, pingMs: 1_000, ownerInviteMs: 300, noticeMs: 20 } });
  return { ...made, userDataPath, secureStore, layout, removed, running, picks };
}

test('the inventory equals what is on disk, with the server stopped and running', async (t) => {
  const team = seeded(t);
  const stopped = await team.controller.handle('hostInventory', {});
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  const inv = stopped.inventory;
  assert.equal(inv.team_name, TEAM_NAME);
  assert.deepEqual(inv.members, [{ name: 'Olive', owner: true }, { name: 'Dot', owner: false }, { name: 'Maya', owner: false }]);
  assert.equal(inv.pending, 1);
  assert.equal(inv.invites, 1, 'only the live, unused invite');
  assert.deepEqual(inv.chat, { team: true, project_channels: 2, messages: 5, attachments: 0, dms: 1, dm_messages: 2 });
  assert.deepEqual(inv.projects, [
    { project_id: 'project_site', name: 'jenny-site', files: 2, bytes: 13 + 3000, conversations: 2 },
    { project_id: 'project_tax', name: 'tax-2026', files: 1, bytes: 8, conversations: 1 },
  ]);
  assert.deepEqual(inv.trash, [{ days_ago: 4, bytes: 900 }]);
  assert.deepEqual(inv.busy, [], 'no reply runs while the server is stopped');
  assert.deepEqual(inv.uncounted, []);
  assert.equal((await team.controller.handle('hostDeploy', { name: TEAM_NAME, ...NAMES })).ok, true);
  const running = await team.controller.handle('hostInventory', {});
  assert.deepEqual(running.inventory.busy, [{ project: 'jenny-site', conversation: 'Landing copy' }]);
  assert.deepEqual({ ...running.inventory, busy: [] }, { ...inv, busy: [] }, 'the same numbers while it runs');
  const text = JSON.stringify(running);
  for (const secret of [TEAM_ID, OWNER, DOT, 'device_', 'invite_live', team.userDataPath]) assert.equal(text.includes(secret), false, secret);
});

test('delete: a wrong name changes nothing; the right name removes the team, the key, the token and this Jenny\'s membership', async (t) => {
  const team = seeded(t);
  team.secureStore.values.set(HOST_RELAY_TOKEN_NAME, 'relaytoken_' + 'x'.repeat(32));
  const before = fs.readdirSync(team.userDataPath).sort();
  const wrong = await team.controller.handle('hostDelete', { name: 'studio' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.reason, 'team_delete_name_mismatch');
  assert.equal(fs.existsSync(path.join(team.userDataPath, 'team-host', 'projects', 'project_site', 'index.html')), true);
  const answer = await team.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.team_name, TEAM_NAME);
  assert.equal(fs.existsSync(path.join(team.userDataPath, 'team-host')), false, 'the team-host folder is gone');
  assert.equal(team.secureStore.values.has(HOST_KEY_NAME), false, 'the host key is gone');
  assert.equal(team.secureStore.values.has(HOST_RELAY_TOKEN_NAME), false, 'the host relay token is gone');
  assert.deepEqual(team.removed, [['removeTeam', TEAM_ID]], 'this Jenny\'s own membership is removed');
  assert.deepEqual(fs.readdirSync(team.userDataPath).sort(), before.filter((name) => name !== 'team-host'), 'nothing went to a trash');
  assert.equal(answer.host.deployed, false, 'the page is the first-run page');
  assert.equal(answer.host.key, null);
});

test('delete of a running team tells the server first, then stops it, then deletes', async (t) => {
  const team = seeded(t);
  assert.equal((await team.controller.handle('hostDeploy', { name: TEAM_NAME, ...NAMES })).ok, true);
  const child = team.fake.last();
  const answer = await team.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const types = child.posted.map((message) => message.type);
  assert.ok(types.indexOf('team_deleting') >= 0 && types.indexOf('team_deleting') < types.indexOf('stop'), types.join(','));
  assert.deepEqual(Object.keys(child.posted.find((m) => m.type === 'team_deleting')), ['type'], 'it carries nothing');
});

test('a delete that fails part way leaves the config, the key and the token; the team starts; a second delete finishes', async (t) => {
  const team = seeded(t);
  team.secureStore.values.set(HOST_RELAY_TOKEN_NAME, 'relaytoken_' + 'y'.repeat(32));
  const realRename = fs.renameSync;
  let held = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (held && String(from).endsWith(path.join('projects', 'project_tax'))) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realRename(from, to);
  });
  const failed = await team.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.reason, 'team_delete_file_held');
  assert.equal(failed.project_id, 'project_tax');
  for (const rel of ['host-config.json', 'projects/project_site/index.html', 'projects/project_tax/receipts.csv', 'profile/team-members.json']) {
    assert.equal(fs.existsSync(path.join(team.userDataPath, 'team-host', rel)), true, `${rel} is back in place`);
  }
  assert.equal(team.secureStore.values.has(HOST_KEY_NAME), true);
  assert.equal(team.secureStore.values.has(HOST_RELAY_TOKEN_NAME), true);
  assert.deepEqual(team.removed, [], 'the membership stays');
  const started = await team.controller.handle('hostDeploy', { name: TEAM_NAME, ...NAMES });
  assert.equal(started.ok, true, 'the team starts again');
  held = false;
  const again = await team.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(fs.existsSync(path.join(team.userDataPath, 'team-host')), false);
});

test('a junction inside a project folder pointing outside is not deleted through: delete, start-new and an old team\'s delete', async (t) => {
  const team = seeded(t, { key: false });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
  fs.symlinkSync(outside, path.join(team.userDataPath, 'team-host', 'projects', 'project_site', 'linked'), 'junction');
  const refused = await team.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.reason, 'team_delete_link');
  assert.equal(refused.project_id, 'project_site');
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
  assert.equal(fs.existsSync(path.join(team.userDataPath, 'team-host', 'host-config.json')), true, 'nothing touched');
  // Start a new team only sets the folder aside; then the old team's delete meets the same refusal.
  const fresh = await team.controller.handle('hostStartNew', { name: 'Second', ...NAMES });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
  const old = (await team.controller.handle('hostStatus', {})).host.old_teams[0];
  const oldDelete = await team.controller.handle('hostOldDelete', { set_aside_id: old.id, name: TEAM_NAME });
  assert.equal(oldDelete.ok, false);
  assert.equal(oldDelete.error.reason, 'team_delete_link');
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
});

test('a member, a project admin and a read-only member cannot delete, start a new team, export or restore', async (t) => {
  for (const memberId of [DOT, MAYA]) {
    const team = seeded(t, { memberId });
    team.picks.file = path.join(team.userDataPath, 'any.jennyteam');
    // A backup's header (version 1, scrypt 2^17, r 8, p 1): enough for the pick.
    fs.writeFileSync(team.picks.file, Buffer.concat([Buffer.from('JENNYTEAMBAK'), Buffer.from([0, 1, 1, 17, 8, 1]), Buffer.alloc(24, 7)]));
    assert.equal((await team.controller.handle('hostRestorePick', {})).ok, true);
    const calls = [['hostDelete', { name: TEAM_NAME }, 'team_owner_only'], ['hostInventory', {}, 'team_owner_only'],
      ['hostExport', { password: 'a long password' }, 'team_owner_only'],
      ['hostStartNew', { name: 'Mine now', ...NAMES }, 'team_host_key_present'],
      ['hostRestore', { password: 'a long password', ...NAMES, name: TEAM_NAME }, 'team_owner_only']];
    for (const [method, payload, reason] of calls) {
      const answer = await team.controller.handle(method, payload);
      assert.deepEqual([answer.ok, answer.error?.reason], [false, reason], `${memberId} ${method}`);
    }
    assert.equal(fs.existsSync(path.join(team.userDataPath, 'team-host', 'host-config.json')), true);
    assert.equal(team.secureStore.values.has(HOST_KEY_NAME), true);
    // A forged payload with extra fields is refused before anything runs.
    assert.equal((await team.controller.handle('hostDelete', { name: TEAM_NAME, force: true })).error.code, 'invalid_request');
  }
});

test('the key\'s state is known without pressing Start; Start a new team sets the old team aside and makes a new key', async (t) => {
  const team = seeded(t, { key: false });
  const status = await team.controller.handle('hostStatus', {});
  assert.equal(status.host.key, 'missing');
  assert.equal(status.host.deployed, true);
  const refusedWithKey = seeded(t);
  assert.equal((await refusedWithKey.controller.handle('hostStartNew', { name: 'Second', ...NAMES })).error.reason, 'team_host_key_present');
  const answer = await team.controller.handle('hostStartNew', { name: 'Second', ...NAMES });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(team.removed, [['removeTeam', TEAM_ID]], 'the old membership is removed');
  assert.equal(team.secureStore.values.has(HOST_KEY_NAME), true, 'a new key');
  const host = (await team.controller.handle('hostStatus', {})).host;
  assert.equal(host.team_name, 'Second');
  assert.equal(host.key, 'ok');
  assert.equal(host.old_teams.length, 1);
  const old = host.old_teams[0];
  assert.deepEqual({ ...old, id: 'x' }, { id: 'x', team_name: TEAM_NAME, set_aside_at: NOW, projects: 2, bytes: 3021 });
  const oldFolder = path.join(team.userDataPath, `team-host-old-${old.id}`);
  assert.equal(fs.readFileSync(path.join(oldFolder, 'projects', 'project_site', 'index.html'), 'utf8'), '<h1>site</h1>', 'set aside, not deleted');
  const counted = await team.controller.handle('hostInventory', { set_aside_id: old.id });
  assert.deepEqual([counted.inventory.team_name, counted.inventory.projects.map((x) => x.name)], [TEAM_NAME, ['jenny-site', 'tax-2026']], 'the old team is counted from its own folder');
  assert.equal((await team.controller.handle('hostInventory', { set_aside_id: '00000000000000000' })).error.reason, 'team_old_not_found');
  assert.equal((await team.controller.handle('hostOldDelete', { set_aside_id: old.id, name: 'Wrong' })).error.reason, 'team_delete_name_mismatch');
  const removed = await team.controller.handle('hostOldDelete', { set_aside_id: old.id, name: TEAM_NAME });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(fs.existsSync(oldFolder), false);
  assert.deepEqual(removed.host.old_teams, []);
});

test('Show files opens only an old team\'s own projects folder', async (t) => {
  const team = seeded(t, { key: false });
  const opened = [];
  const made = createTestHostController(t, { userDataPath: team.userDataPath, secureStore: team.secureStore, now: () => NOW,
    pick: { open: async (folder) => { opened.push(folder); return true; } }, script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.equal((await made.controller.handle('hostStartNew', { name: 'Second', ...NAMES })).ok, true);
  const old = (await made.controller.handle('hostStatus', {})).host.old_teams[0];
  assert.equal((await made.controller.handle('hostOldShow', { set_aside_id: old.id })).ok, true);
  assert.deepEqual(opened, [fs.realpathSync.native(path.join(team.userDataPath, `team-host-old-${old.id}`, 'projects'))]);
  assert.equal((await made.controller.handle('hostOldShow', { set_aside_id: '00000000000000000' })).ok, false);
});

// ------------------------------------------------------------------ review of 5-6 (fix list items 1-4, 6, 8, 11, 20)

const { EventEmitter } = require('node:events');
const { validatePayload } = require('../services/team/ipc-methods');
const { createFakeFork } = require('./helpers/team-host-fakes');

const HEADER_ONLY = Buffer.concat([Buffer.from('JENNYTEAMBAK'), Buffer.from([0, 1, 1, 17, 8, 1]), Buffer.alloc(24, 7)]);
const hostPath = (team, ...parts) => path.join(team.userDataPath, 'team-host', ...parts);
const outsideDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-outside-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'precious.txt'), 'keep me');
  return dir;
};
const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => { setTimeout(resolve, 20); })) if (check()) return true;
  return check();
};
const FAST = Object.freeze({ stopMs: 300, killWaitMs: 300, startMs: 3_000, pingMs: 1_000, ownerInviteMs: 300, noticeMs: 10 });

test('everything that can refuse a delete comes before the members are told (a link in profile/, a project folder that is a link)', async (t) => {
  const plants = [(team, out) => fs.symlinkSync(out, hostPath(team, 'profile', 'linked'), 'junction'),
    (team, out) => { fs.rmSync(hostPath(team, 'projects', 'project_tax'), { recursive: true }); fs.symlinkSync(out, hostPath(team, 'projects', 'project_tax'), 'junction'); }];
  for (const plant of plants) {
    const team = seeded(t);
    const out = outsideDir(t);
    assert.equal((await team.controller.handle('hostDeploy', { name: TEAM_NAME, ...NAMES })).ok, true);
    plant(team, out);
    const refused = await team.controller.handle('hostDelete', { name: TEAM_NAME });
    assert.equal(refused.error?.reason, 'team_delete_link', JSON.stringify(refused));
    assert.equal(team.fake.last().posted.some((m) => m.type === 'team_deleting'), false, 'no member was told');
    assert.equal((await team.controller.handle('hostStatus', {})).host.state, 'running', 'the server still runs');
    assert.equal(fs.readFileSync(path.join(out, 'precious.txt'), 'utf8'), 'keep me');
    assert.equal(fs.existsSync(hostPath(team, 'host-config.json')), true);
  }
  const team = seeded(t);
  fs.rmSync(hostPath(team, 'projects', 'project_tax'), { recursive: true });
  fs.symlinkSync(outsideDir(t), hostPath(team, 'projects', 'project_tax'), 'junction');
  assert.equal((await team.controller.handle('hostDelete', { name: TEAM_NAME })).project_id, 'project_tax', 'the project folder itself is named');
});

test('files are touched only once the server is known to have stopped', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-delete-');
  const secureStore = createMemorySecureStore();
  seedTeamFiles(userDataPath);
  seedOwnership(userDataPath, secureStore);
  const healthy = healthyHostScript({ teamId: TEAM_ID });
  // A child that answers start but never exits: the supervisor answers `team_host_exit_unconfirmed`.
  const fake = createFakeFork({ script: (child, message) => { child.exitOnKill = false; if (message.type === 'start') healthy(child, message); } });
  const made = createTestHostController(t, { userDataPath, secureStore, fork: fake.fork, now: () => NOW,
    service: { holds: () => true, handle: async () => ({ ok: true }), ownerJoin: async () => ({ ok: true, team: { team_id: TEAM_ID } }) },
    bounds: { ...FAST, stopMs: 100, killWaitMs: 100 } });
  assert.equal((await made.controller.handle('hostDeploy', { name: TEAM_NAME, ...NAMES })).ok, true);
  const answer = await made.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.deepEqual([answer.ok, answer.error?.reason], [false, 'team_host_busy'], JSON.stringify(answer));
  assert.equal(fs.existsSync(path.join(userDataPath, 'team-host', 'projects', 'project_site', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(userDataPath, 'team-host', 'host-config.json')), true);
  assert.equal(secureStore.values.has(HOST_KEY_NAME), true);
  fake.last().exit(0);
});

test('once every move succeeded the delete is committed: a staging folder that cannot be removed is reported and swept later', async (t) => {
  const team = seeded(t);
  team.secureStore.values.set(HOST_RELAY_TOKEN_NAME, 'relaytoken_' + 'q'.repeat(32));
  let held = true;
  const isHeld = (target) => held && String(target).endsWith('receipts.csv');
  const busy = () => Object.assign(new Error('busy'), { code: 'EPERM' });
  const realUnlinkSync = fs.unlinkSync;
  const realUnlink = fs.promises.unlink;
  t.mock.method(fs, 'unlinkSync', (target) => { if (isHeld(target)) throw busy(); return realUnlinkSync(target); });
  t.mock.method(fs.promises, 'unlink', async (target) => { if (isHeld(target)) throw busy(); return realUnlink(target); });
  const answer = await team.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.left, ['files']);
  assert.equal(fs.existsSync(hostPath(team, 'host-config.json')), false, 'the config is gone: the team does not start half there');
  assert.equal(team.secureStore.values.has(HOST_KEY_NAME), false);
  assert.equal(team.secureStore.values.has(HOST_RELAY_TOKEN_NAME), false);
  assert.deepEqual(team.removed, [['removeTeam', TEAM_ID]]);
  assert.equal(answer.host.deployed, false);
  assert.equal(fs.readdirSync(hostPath(team)).filter((name) => name.startsWith('.deleting-')).length, 1, 'the leftover waits');
  held = false;
  // The next start of Jenny sweeps it.
  createTestHostController(t, { userDataPath: team.userDataPath, secureStore: team.secureStore, now: () => NOW, script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.ok(await until(() => !fs.existsSync(hostPath(team))), 'swept');
});

test('a membership that cannot be removed after the files are gone still finishes the delete and says so', async (t) => {
  const team = seeded(t);
  const made = createTestHostController(t, { userDataPath: team.userDataPath, secureStore: team.secureStore, now: () => NOW, bounds: FAST,
    service: { holds: () => true, handle: async () => ({ ok: false, error: { code: 'x', reason: 'team_client_write_failed' } }) },
    script: healthyHostScript({ teamId: TEAM_ID }) });
  const answer = await made.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.left, ['membership']);
  assert.equal(team.secureStore.values.has(HOST_KEY_NAME), false, 'no keyed, empty team is left to start');
  assert.equal(fs.existsSync(hostPath(team)), false);
});

test('the sweep removes leftovers at start; a keyless team with its config is kept and offered the lost-key page', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-delete-');
  const secureStore = createMemorySecureStore();
  seedTeamFiles(userDataPath);
  seedOwnership(userDataPath, secureStore, { key: false });
  const restoring = path.join(userDataPath, 'team-host-restoring-0123456789ab');
  fs.mkdirSync(path.join(restoring, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(restoring, 'profile', 'secret.json'), '{}');
  fs.mkdirSync(path.join(userDataPath, 'team-host', '.deleting-0123456789ab', '0'), { recursive: true });
  const made = createTestHostController(t, { userDataPath, secureStore, now: () => NOW, script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.ok(await until(() => !fs.existsSync(restoring) && !fs.existsSync(path.join(userDataPath, 'team-host', '.deleting-0123456789ab'))),
    'decrypted data and a staging folder do not stay');
  const status = (await made.controller.handle('hostStatus', {})).host;
  assert.deepEqual([status.deployed, status.key], [true, 'missing'], 'a quit before the key was stored: the lost-key page is the way out');
  assert.equal(fs.existsSync(path.join(userDataPath, 'team-host', 'host-config.json')), true, 'a keyless team with its config is a team, not a leftover');
  // A team-host with no config and no key but team data is a team whose key was lost: kept.
  const bare = seeded(t, { key: false });
  fs.rmSync(hostPath(bare, 'host-config.json'));
  assert.deepEqual(await sweepLeftovers(bare.userDataPath, { keys: { load: () => null } }), { left: 0 });
  assert.equal(fs.existsSync(hostPath(bare, 'projects')), true, 'team data with no mark is never swept');
  // With the leftover mark it is a restore's leftover: restore is not refused as if a team were there.
  fs.writeFileSync(hostPath(bare, LEFTOVER_MARK), '');
  bare.picks.file = path.join(bare.userDataPath, 'x.jennyteam');
  fs.writeFileSync(bare.picks.file, HEADER_ONLY);
  assert.equal((await bare.controller.handle('hostRestorePick', {})).ok, true);
  const restored = await bare.controller.handle('hostRestore', { password: 'a long password', ...NAMES });
  assert.notEqual(restored.error?.reason, 'team_owner_only', JSON.stringify(restored));
  assert.equal(fs.existsSync(hostPath(bare)), false, 'the leftover was swept');
});

test('a team-host that is itself a link refuses delete, start-new, export and restore with nothing touched', async (t) => {
  const team = seeded(t, { key: false });
  const out = outsideDir(t);
  fs.cpSync(hostPath(team), path.join(out, 'th'), { recursive: true });
  fs.rmSync(hostPath(team), { recursive: true });
  fs.symlinkSync(path.join(out, 'th'), hostPath(team), 'junction');
  const calls = [['hostDelete', { name: TEAM_NAME }, 'team_delete_link'], ['hostStartNew', { name: 'Second', ...NAMES }, 'team_host_link'],
    ['hostExport', { password: 'a long password' }, 'team_host_link']];
  for (const [method, payload, reason] of calls) {
    const answer = await team.controller.handle(method, payload);
    assert.equal(answer.error?.reason, reason, `${method}: ${JSON.stringify(answer)}`);
  }
  team.picks.file = path.join(out, 'x.jennyteam');
  fs.writeFileSync(team.picks.file, HEADER_ONLY);
  assert.equal((await team.controller.handle('hostRestorePick', {})).ok, true);
  assert.equal((await team.controller.handle('hostRestore', { password: 'a long password', ...NAMES, name: TEAM_NAME })).error?.reason, 'team_host_link');
  assert.equal(fs.existsSync(path.join(out, 'th', 'host-config.json')), true, 'the config behind the link is untouched');
  assert.equal(fs.existsSync(path.join(out, 'th', 'projects', 'project_site', 'index.html')), true);
  assert.equal(fs.readdirSync(team.userDataPath).some((name) => name.startsWith('team-host-old-')), false, 'nothing set aside');
});

test('an old team whose name cannot be read is deleted only with the word typed', async (t) => {
  const team = seeded(t, { key: false });
  assert.equal((await team.controller.handle('hostStartNew', { name: 'Second', ...NAMES })).ok, true);
  const old = (await team.controller.handle('hostStatus', {})).host.old_teams[0];
  fs.writeFileSync(path.join(team.userDataPath, `team-host-old-${old.id}`, 'set-aside.json'), 'not json');
  const made = createTestHostController(t, { userDataPath: team.userDataPath, secureStore: team.secureStore, now: () => NOW, script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.equal((await made.controller.handle('hostStatus', {})).host.old_teams[0].team_name, null);
  assert.equal((await made.controller.handle('hostOldDelete', { set_aside_id: old.id })).error?.reason, 'team_delete_name_mismatch');
  assert.equal((await made.controller.handle('hostOldDelete', { set_aside_id: old.id, name: 'Studio' })).error?.reason, 'team_delete_name_mismatch');
  assert.equal(fs.existsSync(path.join(team.userDataPath, `team-host-old-${old.id}`)), true);
  assert.equal((await made.controller.handle('hostOldDelete', { set_aside_id: old.id, name: 'delete' })).ok, true);
  assert.equal(fs.existsSync(path.join(team.userDataPath, `team-host-old-${old.id}`)), false);
});

test('a picker never holds the lock, and a picked backup belongs to the window that picked it', async (t) => {
  const team = seeded(t);
  let release = null;
  team.picks.file = path.join(team.userDataPath, 'x.jennyteam');
  fs.writeFileSync(team.picks.file, HEADER_ONLY);
  const made = createTestHostController(t, { userDataPath: team.userDataPath, secureStore: team.secureStore, now: () => NOW, script: healthyHostScript({ teamId: TEAM_ID }),
    pick: { folder: () => new Promise((resolve) => { release = resolve; }), file: async () => team.picks.file } });
  const exporting = made.controller.handle('hostExport', { password: 'a long password' });
  assert.ok(await until(() => typeof release === 'function'));
  const deployed = await made.controller.handle('hostDeploy', { name: TEAM_NAME, ...NAMES });
  assert.equal(deployed.ok, true, `Start answers while the folder picker is open: ${JSON.stringify(deployed)}`);
  assert.equal((await made.controller.handle('hostInternet', { enabled: false })).ok, true, 'and so does the internet setting');
  release(null);
  assert.equal((await exporting).error?.reason, 'team_export_cancelled');
  const a = Object.assign(new EventEmitter(), { id: 1 });
  const b = Object.assign(new EventEmitter(), { id: 2 });
  assert.equal((await made.controller.handle('hostRestorePick', {}, { sender: a })).ok, true);
  const body = { password: 'a long password', ...NAMES };
  assert.equal((await made.controller.handle('hostRestore', body, { sender: b })).error?.reason, 'team_restore_no_file', 'another window has no file');
  a.emit('destroyed');
  assert.equal((await made.controller.handle('hostRestore', body, { sender: a })).error?.reason, 'team_restore_no_file', 'the window went, so did its file');
});

test('the IPC validators refuse forged lifecycle payloads before the controller sees them', () => {
  const forged = [['hostOldDelete', { set_aside_id: '../team-host', name: 'x' }], ['hostOldDelete', { set_aside_id: '20261112120000000', name: 'x', force: true }],
    ['hostOldShow', { set_aside_id: '..\\..\\Windows' }], ['hostOldShow', { set_aside_id: '20261112120000000', path: 'C:\\' }],
    ['hostInventory', { set_aside_id: 7 }], ['hostInventory', { set_aside_id: '2026111212000000x' }],
    ['hostDelete', { name: TEAM_NAME, force: true }], ['hostRestore', { password: 'a long password', file: 'C:\\x.jennyteam' }]];
  for (const [method, payload] of forged) assert.equal(validatePayload(method, payload).ok, false, `${method} ${JSON.stringify(payload)}`);
  const fine = [['hostOldDelete', { set_aside_id: '20261112120000000', name: 'delete' }], ['hostOldShow', { set_aside_id: '20261112120000000' }],
    ['hostInventory', { set_aside_id: '20261112120000000' }], ['hostInventory', {}]];
  for (const [method, payload] of fine) assert.equal(validatePayload(method, payload).ok, true, `${method} ${JSON.stringify(payload)}`);
});

// ------------------------------------------------------------------ review round two (R09-F01, F03, F04)

const { removeTeamFiles } = require('../services/team/host/host-delete');

// The next start of Jenny on the same profile: a new controller (its sweep runs at once) and a service double.
function nextStart(t, team, removed = []) {
  const service = { holds: () => true, handle: async (method, payload) => { removed.push([method, payload.team_id]); return { ok: true }; },
    ownerJoin: async () => ({ ok: true, team: { team_id: TEAM_ID } }), ownerRecover: async () => ({ ok: true, team: { team_id: TEAM_ID } }) };
  return createTestHostController(t, { userDataPath: team.userDataPath, secureStore: team.secureStore, service, now: () => NOW, bounds: FAST,
    pick: { folder: async () => null, file: async () => null }, script: healthyHostScript({ teamId: TEAM_ID }) });
}

const renameStore = (team, name) => {
  const file = hostPath(team, 'profile', 'team-members.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...doc, team: { ...doc.team, name } }));
};

test('R09-F01a: a quit right after a delete is committed is finished by the next start; no key or token outlives the team', async (t) => {
  const team = seeded(t);
  team.secureStore.values.set(HOST_RELAY_TOKEN_NAME, 'relaytoken_' + 'r'.repeat(32));
  // hostDelete's commit step and nothing more: the quit comes before the membership, the config and the key go.
  assert.deepEqual(await removeTeamFiles(team.userDataPath), { ok: true, leftover: false });
  assert.equal(fs.existsSync(hostPath(team, 'profile')), false, 'the stores are gone');
  const removed = [];
  const next = nextStart(t, team, removed);
  const again = await next.controller.handle('hostDelete', { name: TEAM_NAME });
  const state = (await next.controller.handle('hostStatus', {})).host;
  assert.deepEqual({ retry: again.error?.reason, deployed: state.deployed, key: team.secureStore.values.has(HOST_KEY_NAME),
    token: team.secureStore.values.has(HOST_RELAY_TOKEN_NAME), folder: fs.existsSync(hostPath(team)) },
  { retry: 'team_host_not_deployed', deployed: false, key: false, token: false, folder: false });
  assert.deepEqual(removed, [['removeTeam', TEAM_ID]], 'this Jenny\'s membership goes with the team');
});

test('R09-F01b: a delete whose key removal failed is finished by the next start, and a new team gets a new key', async (t) => {
  const team = seeded(t);
  const oldKey = team.secureStore.values.get(HOST_KEY_NAME);
  const realDelete = team.secureStore.delete;
  let failing = true;
  team.secureStore.delete = (key) => { if (failing && key === HOST_KEY_NAME) throw new Error('store busy'); return realDelete(key); };
  const answer = await team.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.left, ['key'], 'the answer says the key could not be removed');
  assert.equal(answer.host.deployed, false, 'the team reads as deleted');
  failing = false; // the store works again from here
  const next = nextStart(t, team);
  assert.ok(await until(() => !team.secureStore.values.has(HOST_KEY_NAME)), 'the next start removes the deleted team\'s key');
  assert.equal(fs.existsSync(hostPath(team)), false, 'and the marked folder');
  const deployed = await next.controller.handle('hostDeploy', { name: 'Fresh', ...NAMES });
  assert.equal(deployed.ok, true, JSON.stringify(deployed));
  assert.notEqual(team.secureStore.values.get(HOST_KEY_NAME), oldKey, 'a new team must not carry the deleted team\'s host key');
});

test('R09-F01: a half-deleted team cannot be exported or restored over; the refusal names the unfinished delete', async (t) => {
  const team = seeded(t);
  assert.deepEqual(await removeTeamFiles(team.userDataPath), { ok: true, leftover: false });
  // The store keeps refusing the key, so no sweep can finish the delete yet.
  team.secureStore.delete = () => { throw new Error('store busy'); };
  const next = nextStart(t, team);
  const exported = await next.controller.handle('hostExport', { password: 'a long password' });
  assert.equal(exported.error?.reason, 'team_delete_unfinished', JSON.stringify(exported));
  const deployed = await next.controller.handle('hostDeploy', { name: 'Fresh', ...NAMES });
  assert.equal(deployed.ok, false, 'no new team is written into a half-deleted folder');
  assert.equal(fs.existsSync(hostPath(team, 'host-config.json')), false);
});

test('R09-F03: a team whose first owner never joined can be deleted by the PC that holds its key', async (t) => {
  const team = seeded(t);
  // The store as --team-init leaves it before anyone redeemed the owner invite; this Jenny holds no membership.
  const file = hostPath(team, 'profile', 'team-members.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...doc, members: [], devices: [], projects: [] }));
  fs.rmSync(path.join(team.userDataPath, 'team'), { recursive: true, force: true });
  const state = (await team.controller.handle('hostStatus', {})).host;
  assert.deepEqual([state.deployed, state.key, state.owner], [true, 'ok', true], 'the page offers the delete');
  const answer = await team.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.equal(answer.ok, true, `delete refused: ${answer.error?.reason}`);
  assert.equal(team.secureStore.values.has(HOST_KEY_NAME), false);
  // Without the key the same store is not this PC's to delete.
  const keyless = seeded(t);
  fs.writeFileSync(hostPath(keyless, 'profile', 'team-members.json'), JSON.stringify({ ...doc, members: [], devices: [], projects: [] }));
  fs.rmSync(path.join(keyless.userDataPath, 'team'), { recursive: true, force: true });
  keyless.secureStore.values.set(HOST_KEY_NAME, Buffer.alloc(32, 9).toString('base64url'));
  assert.equal((await keyless.controller.handle('hostDelete', { name: TEAM_NAME })).error?.reason, 'team_owner_only', 'another team\'s key');
});

test('R09-F04: after a rename the page, the delete and its answer use the current name', async (t) => {
  const team = seeded(t);
  assert.equal((await team.controller.handle('hostDeploy', { name: TEAM_NAME, ...NAMES })).ok, true);
  renameStore(team, 'Studio North'); // team.rename writes the member store only
  assert.equal((await team.controller.handle('hostStatus', {})).host.team_name, 'Studio North', 'while it runs');
  assert.equal((await team.controller.handle('hostDelete', { name: TEAM_NAME })).error?.reason, 'team_delete_name_mismatch');
  const answer = await team.controller.handle('hostDelete', { name: 'Studio North' });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.team_name, 'Studio North');
});

// X6b-F06: no mark, no commit (host-delete.js). A directory where the mark goes makes the mark's write fail.
test('R09-F01: a delete whose mark cannot be written puts every folder back, removes nothing and the team still starts', async (t) => {
  const team = seeded(t);
  fs.mkdirSync(hostPath(team, LEFTOVER_MARK));
  const failed = await team.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.equal(failed.error?.reason, 'team_delete_file_held', JSON.stringify(failed));
  for (const rel of ['host-config.json', 'projects/project_site/index.html', 'projects/project_tax/receipts.csv', 'profile/team-members.json']) {
    assert.equal(fs.existsSync(hostPath(team, rel)), true, `${rel} is back in place`);
  }
  assert.deepEqual(fs.readdirSync(hostPath(team)).filter((name) => name.startsWith('.deleting-')), [], 'no staging folder left');
  assert.equal(team.secureStore.values.has(HOST_KEY_NAME), true);
  assert.deepEqual(team.removed, [], 'the membership stays');
  assert.equal((await team.controller.handle('hostDeploy', { name: TEAM_NAME, ...NAMES })).ok, true, 'the team starts again');
});

// Review sweeps, second run (X4b-F04): a member store that is there and does not read (the zero-filled file a power
// loss leaves on NTFS) leaves the PC holding the team's key a way out: the page offers the delete, the inventory and
// the delete run; Start a new team names the unreadable store instead of `team_host_key_present`.
test('X4b-F04: with the key here and a member store that does not read, the owner can still delete the team', async (t) => {
  const team = seeded(t);
  fs.writeFileSync(hostPath(team, 'profile', 'team-members.json'), Buffer.alloc(4096));
  const state = (await team.controller.handle('hostStatus', {})).host;
  assert.deepEqual([state.deployed, state.key, state.owner], [true, 'ok', true], 'the page offers the delete');
  const inventory = await team.controller.handle('hostInventory', {});
  assert.equal(inventory.ok, true, JSON.stringify(inventory));
  assert.equal(inventory.inventory.uncounted.includes('members'), true);
  const startNew = await team.controller.handle('hostStartNew', { name: 'Fresh', ...NAMES });
  assert.equal(startNew.error?.reason, 'team_members_unreadable', JSON.stringify(startNew));
  assert.equal((await team.controller.handle('hostDelete', { name: 'studio' })).error?.reason, 'team_delete_name_mismatch');
  const answer = await team.controller.handle('hostDelete', { name: TEAM_NAME });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(fs.existsSync(path.join(team.userDataPath, 'team-host')), false);
  assert.equal(team.secureStore.values.has(HOST_KEY_NAME), false);
  assert.deepEqual(team.removed, [['removeTeam', TEAM_ID]], 'the stored key\'s team is forgotten');
});
