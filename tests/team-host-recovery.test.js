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
const { parseInvite } = require('../server/team/invites');
const { HOST_SEED } = require('./server/helpers/team-host-fixture');
const { BOUNDS, createFakeFork, createTestHostController } = require('./helpers/team-host-fakes');
const { createTeamClientHost } = require('./helpers/team-client-host');


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

async function deployedOwner(t) {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const first = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(first.invite).team_id;
  host.secureStore.values.set(HOST_KEY_NAME, Buffer.from(HOST_SEED).toString('base64url'));
  const plans = { next: { invite: first.invite } };
  const fake = createFakeFork({ script: scriptedHost(teamId, () => plans.next) });
  const { controller, logs } = createTestHostController(t, { userDataPath: host.userData, secureStore: host.secureStore,
    service, fork: fake.fork });
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
