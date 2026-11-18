'use strict';

// new-test-file: row 170's client step after an accepted profileSet (services/team/profile-change.js), through the
// real host and service; the label repair's file (team-connection-lifecycle.test.js) is at the line cap.

const assert = require('node:assert/strict');
const test = require('node:test');

const { clientFilePath, loadClientFile } = require('../services/team/client-file');
const { keepProfile } = require('../services/team/profile-change');
const { createTeamClientHost, joinAs } = require('./helpers/team-client-host');
const { watchWrites } = require('./helpers/team-saved');

// The first owner online, with a pending member holding a name.
async function online(t) {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  t.after(() => service.stopAll());
  const me = await joinAs(host, service, { name: 'Olive Owner' });
  await host.waitForState(me.teamId, 'online');
  await host.env.redeemDirect({ actor: me.member_id, name: 'Pia Pending' });
  const call = (payload) => service.handle('profileSet', { team_id: me.teamId, ...payload });
  const saved = () => loadClientFile(host.userData, me.teamId).record;
  const names = (row) => [row.display_name, row.label];
  const row = () => names(service.snapshot().teams.find((team) => team.team_id === me.teamId));
  const pushed = () => names(host.states.at(-1).teams.find((team) => team.team_id === me.teamId));
  return { host, service, me, call, saved, row, pushed, file: clientFilePath(host.userData, me.teamId) };
}

test('an accepted answer rewrites the saved record, the team row and the push; only the sent field changes', async (t) => {
  const s = await online(t);
  assert.deepEqual(await s.call({ display_name: 'Olive Two' }), { ok: true });
  assert.deepEqual([s.saved().display_name, s.saved().label], ['Olive Two', 'Laptop']);
  assert.deepEqual(s.row(), ['Olive Two', 'Laptop']);
  assert.deepEqual(s.pushed(), ['Olive Two', 'Laptop']);
  assert.deepEqual(await s.call({ label: 'Desk' }), { ok: true });
  assert.deepEqual([s.saved().display_name, s.saved().label], ['Olive Two', 'Desk']);
  assert.deepEqual([s.row(), s.pushed()], [['Olive Two', 'Desk'], ['Olive Two', 'Desk']]);
  const host = s.host.env.store.snapshot();
  assert.equal(host.members.find((member) => member.member_id === s.me.member_id).display_name, 'Olive Two');
  assert.equal(host.devices.find((device) => device.device_id === s.me.device_id).label, 'Desk');
  // Unchanged values: the host writes nothing and neither does this Jenny.
  const writes = watchWrites(t, s.file);
  assert.deepEqual(await s.call({ display_name: 'Olive Two', label: 'Desk' }), { ok: true });
  assert.equal(writes.count, 0);
  assert.equal(JSON.stringify(s.host.logs).includes('Olive Two'), false, 'no name in the logs');
});

test('a refusal leaves the saved record and the row; a failed write is logged and the answer stays ok', async (t) => {
  const s = await online(t);
  const pushes = s.host.states.length;
  const refused = await s.call({ display_name: 'pia pending', label: 'Desk' });
  assert.equal(refused.error?.reason, 'team_display_name_taken', JSON.stringify(refused));
  assert.deepEqual([s.saved().display_name, s.saved().label, s.row()], ['Olive Owner', 'Laptop', ['Olive Owner', 'Laptop']]);
  assert.equal(s.host.states.length, pushes, 'nothing pushed');

  const writes = watchWrites(t, s.file);
  writes.fail = true;
  assert.deepEqual(await s.call({ label: 'Desk' }), { ok: true });
  writes.restore();
  assert.deepEqual([s.saved().label, s.row()[1]], ['Laptop', 'Laptop'], 'nothing changed in memory either');
  assert.ok(s.host.logs.some((line) => line.event === 'team.client_file.write_failed' && line.fields.team_id === s.me.teamId));
  assert.equal(JSON.stringify(s.host.logs).includes('Desk'), false, 'no label in the logs');
});

test('keepProfile writes the NFC form of what was sent, and nothing for a refusal, a team no longer held or no record', () => {
  const logs = [];
  const writes = [];
  let pushes = 0;
  const deps = (own, held = true) => ({ own, held, log: (...line) => logs.push(line), push: () => { pushes += 1; },
    save: (record) => { writes.push(record); return { ok: true }; } });
  const own = { team_id: 'team_a', display_name: 'Olive', label: 'Laptop' };
  assert.equal(keepProfile({ ok: false, error: {} }, { display_name: 'Cafe' }, deps(own)), false);
  assert.equal(keepProfile({ ok: true }, { display_name: 'Cafe' }, deps(own, false)), false);
  assert.equal(keepProfile({ ok: true }, { display_name: 'Cafe' }, deps(null)), false);
  assert.deepEqual([writes.length, pushes, logs.map((line) => line[1])], [0, 0, ['team.profile.unsaved']]);
  assert.equal(keepProfile({ ok: true }, { team_id: 'team_a', display_name: 'Café' }, deps(own)), true);
  assert.deepEqual(writes, [{ team_id: 'team_a', display_name: 'Café', label: 'Laptop' }]);
  assert.deepEqual([own.display_name, own.label, pushes], ['Café', 'Laptop', 1]);
});
