'use strict';

// Owner recovery from the desktop (slice 1f-2): `team.hostRecover` restarts the
// host with --team-recover, takes the one owner_invite and redeems it with a
// fresh device key. The old key and client file stay byte-identical until the
// redeem is confirmed; a failed redeem and `team_member_state_invalid` leave
// them exactly as they were; an ordinary join for that team is still refused.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { HOST_KEY_NAME } = require('../services/team/host/host-key-store');
const { deviceKeyName } = require('../services/team/device-key-store');
const { clientFilePath } = require('../services/team/client-file');
const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { keyPairFromSeed } = require('../server/team/ids');
const { parseInvite } = require('../server/team/invites');
const { parseReconnectCode } = require('../services/team/reconnect-code');
const { HOST_SEED } = require('./server/helpers/team-host-fixture');
const { BOUNDS, createFakeFork, createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, createTeamClientHost, tempProfile } = require('./helpers/team-client-host');


// A fake host child: on start, ready; then the invite the test chose for this start (or an error).
function scriptedHost(teamId, plan) {
  return (child, message) => {
    if (message.type === 'start') {
      const step = plan(child.args);
      setImmediate(() => {
        child.reply({ type: 'ready', boot_epoch: 'e', team_id: teamId, public_key: 'pk', addresses: ['192.0.2.7:4242'] });
        setImmediate(() => {
          if (step?.invite) child.reply({ type: 'owner_invite', invite: step.invite });
          if (step?.error) child.reply({ type: 'error', reason: step.error });
        });
      });
    }
    if (message.type === 'stop') setImmediate(() => { child.reply({ type: 'stopped' }); setImmediate(() => child.exit(0)); });
  };
}

async function deployedOwner(t, controllerOptions = {}) {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const first = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(first.invite).team_id;
  host.secureStore.values.set(HOST_KEY_NAME, Buffer.from(HOST_SEED).toString('base64url'));
  // A team deployed here before (a saved config), so Deploy keeps that key (E75: with none, it would make a fresh one).
  fs.mkdirSync(path.join(host.userData, 'team-host'), { recursive: true });
  fs.writeFileSync(path.join(host.userData, 'team-host', 'host-config.json'), JSON.stringify({ schema_version: 3, team: { name: 'Studio' } }));
  const plans = { next: { invite: first.invite } };
  const fake = createFakeFork({ script: scriptedHost(teamId, () => plans.next) });
  const { controller, logs } = createTestHostController(t, { userDataPath: host.userData, secureStore: host.secureStore,
    service, fork: fake.fork, ...controllerOptions });
  const deployed = await controller.handle('hostDeploy', { name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
  assert.equal(deployed.owner.state, 'joined', JSON.stringify(deployed));
  await host.waitForState(teamId, 'online');
  const snapshotOld = () => ({
    key: host.secureStore.values.get(deviceKeyName(teamId)),
    file: fs.readFileSync(clientFilePath(host.userData, teamId)),
  });
  return { host, service, controller, fake, plans, teamId, logs, old: snapshotOld(), snapshotOld };
}

test('recovery: the new key and file replace the old ones only after the redeem is confirmed', async (t) => {
  const { host, controller, fake, plans, teamId, old, snapshotOld } = await deployedOwner(t);
  const recovery = await host.invite({ kind: 'recovery' });
  plans.next = { invite: recovery.invite };
  const realRedeem = host.env.context.invites.redeem;
  let checkedBeforeRedeem = false;
  host.env.context.invites.redeem = async (input) => {
    const now = snapshotOld();
    assert.equal(now.key, old.key, 'old key untouched while the redeem is in flight');
    assert.deepEqual(now.file, old.file, 'old client file untouched while the redeem is in flight');
    checkedBeforeRedeem = true;
    return realRedeem(input);
  };
  const answer = await controller.handle('hostRecover', { display_name: 'Olive Owner', label: 'New desk' });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.owner, { state: 'recovered', team_id: teamId });
  assert.equal(checkedBeforeRedeem, true);
  assert.deepEqual(fake.last().args.slice(2), ['--team-recover']);
  const now = snapshotOld();
  assert.notEqual(now.key, old.key, 'a fresh device key');
  const oldRecord = JSON.parse(old.file.toString('utf8'));
  const newRecord = JSON.parse(now.file.toString('utf8'));
  assert.notEqual(newRecord.device_id, oldRecord.device_id);
  assert.equal(newRecord.member_id, oldRecord.member_id, 'the same owner member');
  const team = await host.waitForState(teamId, 'online');
  assert.equal(team.role, 'owner');
  assert.equal(team.device_id, newRecord.device_id);
});

test('recovery: a failed redeem leaves the old key and file byte-identical', async (t) => {
  const { host, controller, plans, teamId, old, snapshotOld } = await deployedOwner(t);
  const recovery = await host.invite({ kind: 'recovery' });
  plans.next = { invite: recovery.invite };
  host.env.context.invites.redeem = async () => ({ ok: false, error: { code: 'CMP-HOST-0004', kind: 'denied', reason: 'invite_not_valid' } });
  const answer = await controller.handle('hostRecover', { display_name: 'Olive Owner', label: 'New desk' });
  assert.equal(answer.ok, true, 'the host restarted');
  assert.equal(answer.owner.state, 'failed');
  assert.equal(answer.owner.error.reason, 'invite_not_valid');
  const now = snapshotOld();
  assert.equal(now.key, old.key);
  assert.deepEqual(now.file, old.file);
  await host.waitForState(teamId, 'online');
});

// The host accepted the recovery (it revoked every other device of the owner), then this device failed to save it.
async function recoverWithLocalFault(t, fault) {
  const ctx = await deployedOwner(t);
  const recovery = await ctx.host.invite({ kind: 'recovery' });
  ctx.plans.next = { invite: recovery.invite };
  const realRedeem = ctx.host.env.context.invites.redeem;
  ctx.host.env.context.invites.redeem = async (input) => {
    const answer = await realRedeem(input);
    fault(ctx);
    return answer;
  };
  const answer = await ctx.controller.handle('hostRecover', { display_name: 'Olive Owner', label: 'New desk' });
  return { ...ctx, answer };
}

test('recovery: a device key save that fails after the redeem answers team_recover_local_save_failed', async (t) => {
  const { answer } = await recoverWithLocalFault(t, ({ host }) => {
    const set = host.secureStore.set.bind(host.secureStore);
    host.secureStore.set = (name, value) => {
      if (name.startsWith('team_device_key:')) throw new Error('store gone');
      return set(name, value);
    };
  });
  assert.equal(answer.ok, true, 'the host restarted');
  assert.equal(answer.owner.state, 'failed');
  assert.equal(answer.owner.error.reason, 'team_recover_local_save_failed');
});

test('recovery: a client file write that fails after the redeem keeps the new key and says so', async (t) => {
  const { answer, old, host, teamId } = await recoverWithLocalFault(t, (ctx) => {
    const file = clientFilePath(ctx.host.userData, ctx.teamId);
    fs.rmSync(file);
    fs.mkdirSync(path.join(file, 'blocker'), { recursive: true });
  });
  assert.equal(answer.owner.state, 'failed');
  assert.equal(answer.owner.error.reason, 'team_recover_local_save_failed');
  const key = host.secureStore.values.get(deviceKeyName(teamId));
  assert.ok(key, 'a key is still stored');
  assert.notEqual(key, old.key, 'the new key the host accepted is kept; the revoked one is not put back');
});

test('recovery: team_member_state_invalid is reported, not retried, and changes nothing', async (t) => {
  const { controller, fake, plans, old, snapshotOld } = await deployedOwner(t);
  plans.next = { error: 'team_member_state_invalid' };
  const callsBefore = fake.calls.length;
  const answer = await controller.handle('hostRecover', { display_name: 'Olive Owner', label: 'New desk' });
  assert.deepEqual(answer, { ok: false, error: { code: TEAM_ERROR_CODES.HOST_UNAVAILABLE, reason: 'team_member_state_invalid' } });
  await new Promise((resolve) => { setTimeout(resolve, BOUNDS.stopMs + 100); });
  assert.equal(fake.calls.length, callsBefore + 1, 'one recovery start, no retry');
  const now = snapshotOld();
  assert.equal(now.key, old.key);
  assert.deepEqual(now.file, old.file);
});

test('an ordinary join for the team is still refused', async (t) => {
  const { host, service, old, snapshotOld } = await deployedOwner(t);
  const recovery = await host.invite({ kind: 'recovery' });
  const answer = await service.handle('join', { invite: recovery.invite, display_name: 'Olive Owner', label: 'Other' });
  assert.deepEqual(answer, { ok: false, error: { code: 'invalid_request', reason: 'team_already_joined' } });
  const now = snapshotOld();
  assert.equal(now.key, old.key);
  assert.deepEqual(now.file, old.file);
});

test('recovery needs a deployed host: no stored key is refused before anything is spawned', async (t) => {
  const host = await createTeamClientHost(t, { startBridge: false });
  const fake = createFakeFork({});
  const { controller } = createTestHostController(t, { userDataPath: host.userData, secureStore: host.secureStore,
    service: host.createService(), fork: fake.fork });
  const answer = await controller.handle('hostRecover', { display_name: 'Olive Owner', label: 'Desk' });
  assert.deepEqual(answer, { ok: false, error: { code: TEAM_ERROR_CODES.HOST_UNAVAILABLE, reason: 'team_host_not_deployed' } });
  assert.equal(fake.calls.length, 0);
});

// Slice 5-3 fence extension (written red first). Fault: a host method with no branch of its own in
// `handle` falling through to Recover (a restart with --team-recover), or the owner's code reaching
// a log line, writing a file or taking the Deploy and Recover lock.
test('hostReconnectCode never runs Recover: it answers the running host\'s code and changes nothing', async (t) => {
  const { controller, fake, teamId, logs, old, snapshotOld } = await deployedOwner(t);
  const starts = fake.calls.length;
  const answer = await controller.handle('hostReconnectCode');
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(fake.calls.length, starts, 'no host restarted');
  const parsed = parseReconnectCode(answer.code);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.team_id, teamId);
  assert.equal(parsed.host_public_key, keyPairFromSeed(Buffer.from(HOST_SEED)).publicKey);
  assert.deepEqual(parsed.hints, ['192.0.2.7:4242']);
  assert.deepEqual(snapshotOld(), old, 'device key and client file unchanged');
  const lines = JSON.stringify(logs);
  assert.equal(lines.includes(answer.code) || lines.includes('192.0.2.7'), false, 'no code or address in a log line');
  assert.equal((await controller.handle('hostStatus')).host.state, 'running');
  await controller.handle('hostStop');
  assert.equal((await controller.handle('hostReconnectCode')).error?.reason, 'team_host_stopped');
  assert.equal(fake.calls.length, starts, 'still no host started');
});

// Slice 5-3 review items 5 and 15. Fault: an internet setting that throws, or a getter with no return,
// read as "off" (a code with no name), or the setting's name not reaching the code.
test('hostReconnectCode: an unreadable or undefined setting is team_internet_invalid; a valid one carries its name', async (t) => {
  let setting = () => null;
  const { controller, logs } = await deployedOwner(t, { internet: () => setting() });
  for (const next of [() => { throw new Error('203.0.113.9'); }, () => undefined, () => ({ direct_port: 1 })]) {
    setting = next;
    const answer = await controller.handle('hostReconnectCode');
    assert.deepEqual([answer.ok, answer.error?.reason, answer.code], [false, 'team_internet_invalid', undefined]);
  }
  setting = () => ({ direct_port: 4242, mapped: null, public_address: 'team.example.net', relay_url: null, relay_token: null });
  const parsed = parseReconnectCode((await controller.handle('hostReconnectCode')).code);
  assert.deepEqual([parsed.host_name, parsed.hints], [{ name: 'team.example.net', port: 4242 }, ['192.0.2.7:4242']]);
  assert.equal(JSON.stringify(logs).includes('team.example.net') || JSON.stringify(logs).includes('203.0.113.9'), false);
});

// Every name under a folder with its size, so "nothing was written" covers the whole user data folder.
function folderListing(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      out.push(entry.isDirectory() ? `${full}/` : `${full} ${fs.statSync(full).size}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

test('a lost host key: Recover with a saved config and no stored key is refused team_host_key_missing or team_host_key_set_aside', async (t) => {
  for (const [corrupt, reason] of [[false, 'team_host_key_missing'], [true, 'team_host_key_set_aside']]) {
    const host = await createTeamClientHost(t, { startBridge: false });
    const root = path.join(host.userData, 'team-host');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'host-config.json'), JSON.stringify({ schema_version: 3, team: { name: 'Studio', direct_port: 45123 } }));
    if (corrupt) fs.writeFileSync(path.join(host.userData, 'secure-state.json.corrupt-1731300000000'), '{');
    const fake = createFakeFork({});
    const { controller, logs } = createTestHostController(t, { userDataPath: host.userData, secureStore: host.secureStore,
      service: host.createService(), fork: fake.fork });
    const before = folderListing(host.userData);
    const answer = await controller.handle('hostRecover', { display_name: 'Olive Owner', label: 'Desk' });
    assert.deepEqual(answer, { ok: false, error: { code: TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE, reason } });
    assert.deepEqual(folderListing(host.userData), before, 'nothing in the user data folder was created or changed');
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(host.secureStore.sets, [], 'no key was made');
    assert.equal(JSON.stringify(logs).includes(host.userData), false, 'no path in a log line');
  }
});

test('a lost host key: a Recover refused while a host runs leaves that host running and its snapshot unchanged', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-lost-');
  const secureStore = createMemorySecureStore();
  const { controller, fake } = createTestHostController(t, { userDataPath, secureStore,
    script: healthyHostScript({ teamId: 'team_x' }) });
  assert.equal((await controller.handle('hostDeploy', { name: 'Studio', display_name: 'Olive Owner', label: 'Desk' })).ok, true);
  const running = controller.snapshot();
  assert.equal(running.state, 'running');
  secureStore.values.delete(HOST_KEY_NAME);
  const answer = await controller.handle('hostRecover', { display_name: 'Olive Owner', label: 'Desk' });
  assert.equal(answer.error.reason, 'team_host_key_missing');
  assert.deepEqual(controller.snapshot(), running, 'the running host and its snapshot are untouched');
  assert.equal(fake.calls.length, 1, 'no second host started');
  assert.equal(fake.calls[0].child.posted.some((message) => message.type === 'stop'), false, 'the host was not asked to stop');
});
