'use strict';

// "Deleted by its owner" on a member's Jenny (slice 5-6, E61): the host's `team_deleted` notice
// (server/team/team-deleted-notice.js) reaches a connected member through the real event stream, the team stays as
// a kept `deleted` row with Remove this team, and one probe at each start brings it back if it was restored.
// Through the real team service and connection manager against the in-process team host.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadClientFile } = require('../services/team/client-file');
const { MARK_FILE } = require('../services/team/team-deleted');
const { announceTeamDeleted } = require('../server/team/team-deleted-notice');
const { createTeamClientHost, joinAs, waitUntil } = require('./helpers/team-client-host');

const AT = Date.parse('2026-11-12T09:30:00.000Z');

async function connectedMember(t) {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const service = host.createService();
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  return { host, service, me };
}

const rowOf = (service, teamId) => service.snapshot().teams.find((team) => team.team_id === teamId);
const deletedNow = (service, teamId) => waitUntil(() => rowOf(service, teamId)?.state === 'deleted');

function announce(host) {
  return announceTeamDeleted({ store: host.env.context.store, now: () => AT,
    publish: (type, payload, options) => host.env.core.events.publish(type, payload, options) });
}

test('a connected member sees the team deleted by its owner; the membership stays until Remove this team', async (t) => {
  const { host, service, me } = await connectedMember(t);
  assert.equal(announce(host), true);
  assert.ok(await deletedNow(service, me.teamId), JSON.stringify(rowOf(service, me.teamId)));
  const row = rowOf(service, me.teamId);
  assert.deepEqual({ state: row.state, by: row.deleted_by, at: row.deleted_at }, { state: 'deleted', by: 'Olive Owner', at: AT });
  assert.equal(service.snapshot().teams.filter((team) => team.team_id === me.teamId).length, 1, 'one row for the team');
  assert.ok(await waitUntil(() => service.resources().managers === 0), 'its connection stopped');
  assert.equal(loadClientFile(host.userData, me.teamId).ok, true, 'the saved membership is not removed by the notice');
  assert.equal(fs.existsSync(path.join(host.userData, 'team', me.teamId, MARK_FILE)), true);
  const removed = await service.handle('removeTeam', { team_id: me.teamId });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(rowOf(service, me.teamId), undefined);
  assert.equal(fs.existsSync(path.join(host.userData, 'team', me.teamId)), false);
});

test('at the next start a marked team is probed once: unreachable, it is the deleted row again; reachable, it is back', async (t) => {
  const { host, service, me } = await connectedMember(t);
  announce(host);
  assert.ok(await deletedNow(service, me.teamId));
  await service.stopAll();
  host.setReachable([]);
  const next = host.createService();
  await next.startExisting();
  assert.ok(await deletedNow(next, me.teamId), 'the probe failed: deleted again, with its facts');
  assert.equal(rowOf(next, me.teamId).deleted_by, 'Olive Owner');
  assert.ok(await waitUntil(() => next.resources().managers === 0), 'no connection keeps trying');
  await next.stopAll();
  host.setReachable(null);
  const restored = host.createService();
  await restored.startExisting();
  await host.waitForState(me.teamId, 'online');
  assert.ok(await waitUntil(() => rowOf(restored, me.teamId)?.state === 'online'), 'the restored team is back');
  assert.equal(fs.existsSync(path.join(host.userData, 'team', me.teamId, MARK_FILE)), false, 'the mark is gone');
  await restored.stopAll();
});

test('a notice that is not well formed changes nothing', async (t) => {
  const { host, service, me } = await connectedMember(t);
  host.env.core.events.publish('team_deleted', { owner_name: 'x'.repeat(41), deleted_at: 'yesterday' });
  host.env.core.events.publish('team_deleted_not', { owner_name: 'Olive Owner', deleted_at: AT });
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  assert.equal(rowOf(service, me.teamId).state, 'online');
  assert.equal(fs.existsSync(path.join(host.userData, 'team', me.teamId, MARK_FILE)), false);
});

test('a delete that failed after its notice clears itself: the row is dialled again on status, at most every 10 minutes', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  let skew = 0;
  const service = host.createService({ now: () => Date.now() + skew });
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  announce(host);
  assert.ok(await deletedNow(service, me.teamId));
  assert.ok(await waitUntil(() => service.resources().managers === 0));
  // The server still answers (its delete stopped at a held file), but within 10 minutes of the notice nothing dials it.
  skew = 9 * 60_000;
  await service.handle('status', {});
  await new Promise((resolve) => { setTimeout(resolve, 150); });
  assert.equal(rowOf(service, me.teamId).state, 'deleted');
  assert.equal(service.resources().managers, 0, 'no probe yet');
  skew = 11 * 60_000;
  await service.handle('status', {});
  assert.equal(rowOf(service, me.teamId).state, 'deleted', 'the row stays deleted while the probe runs');
  assert.ok(await waitUntil(() => rowOf(service, me.teamId)?.state === 'online'), JSON.stringify(rowOf(service, me.teamId)));
  assert.equal(fs.existsSync(path.join(host.userData, 'team', me.teamId, MARK_FILE)), false, 'the mark is gone');
  assert.equal(service.snapshot().teams.filter((team) => team.team_id === me.teamId).length, 1);
});
