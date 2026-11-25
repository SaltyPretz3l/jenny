'use strict';

// new-test-file: how the team service tears teams down (stopAll with a failing stop, Remove team on a row with no manager) is a
// different lane from tests/team-connection-lifecycle.test.js (at its 600-line cap) and tests/team-client-removal.test.js (real
// host); it runs the real service over the fake managers of tests/helpers/team-force-local-world.js, which need no network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { clientFilePath, saveClientFile } = require('../services/team/client-file');
const { createTeamService } = require('../services/team/team-service');
const { createMemorySecureStore, tempProfile } = require('./helpers/team-client-host');
const { fakeManagers, savedRecord } = require('./helpers/team-force-local-world');

const keyName = (teamId) => `team_device_key:${teamId}`;
const S1 = `sess_${'1'.padStart(32, '0')}`;

function serviceOver(t, records) {
  const userDataPath = tempProfile(t, 'jenny-team-teardown-');
  const secureStore = createMemorySecureStore();
  for (const record of records) {
    assert.equal(saveClientFile(userDataPath, record).ok, true);
    secureStore.values.set(keyName(record.team_id), 'seed-of-' + record.team_id);
  }
  const managers = fakeManagers();
  const service = createTeamService({ userDataPath, getSecureStore: () => secureStore, createManager: managers.createManager,
    spawnChild: () => { throw new Error('no child expected'); }, now: () => 1_000_000 });
  t.after(() => service.stopAll().catch(() => {}));
  return { userDataPath, secureStore, managers, service };
}

test('stopAll waits for every stop to end even when one of them fails, then tells the first failure', async (t) => {
  const records = [savedRecord(), savedRecord()];
  const w = serviceOver(t, records);
  await w.service.startExisting();
  assert.equal(w.managers.made.length, 2);
  const [failing, slow] = w.managers.made;
  failing.stopWith = async () => { throw new Error('bridge would not stop'); };
  slow.stopWith = () => new Promise((resolve) => { setTimeout(resolve, 60); });
  await assert.rejects(w.service.stopAll(), /bridge would not stop/);
  assert.equal(slow.stopped, true, 'the other stop had ended when stopAll answered: nothing is orphaned');
});

// A saved team whose file no longer loads is a needs_repair row; Remove team clears it.
async function repairRow(t) {
  const record = savedRecord();
  const w = serviceOver(t, [record]);
  fs.writeFileSync(clientFilePath(w.userDataPath, record.team_id), '{broken');
  await w.service.startExisting();
  const row = w.service.snapshot().teams.find((entry) => entry.team_id === record.team_id);
  assert.equal(row.state, 'needs_repair');
  return { ...w, record, teamId: record.team_id };
}

test('Remove team on a needs_repair row whose directory cannot be removed answers the failure and keeps the key', async (t) => {
  const w = await repairRow(t);
  const dir = path.resolve(path.dirname(clientFilePath(w.userDataPath, w.teamId)));
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (target, ...rest) => {
    if (path.resolve(String(target)).startsWith(dir)) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return unlink(target, ...rest);
  });
  const answer = await w.service.handle('removeTeam', { team_id: w.teamId });
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.equal(w.secureStore.values.has(keyName(w.teamId)), true, 'the key stays: the directory is removed before the key');
  assert.equal(w.service.snapshot().teams.some((row) => row.team_id === w.teamId), true, 'the row stays removable');
  t.mock.restoreAll();
  assert.deepEqual(await w.service.handle('removeTeam', { team_id: w.teamId }), { ok: true }, 'Remove works again');
  assert.equal(w.secureStore.values.has(keyName(w.teamId)), false);
  assert.deepEqual(w.service.snapshot().teams, []);
});

test('Remove team on a repair row drops the team\'s unsent drafts: a rejoin never gets the box text back', async (t) => {
  const record = savedRecord();
  const w = serviceOver(t, [record]);
  assert.deepEqual(await w.service.handle('projectDraftSet', { team_id: record.team_id, session_id: S1, text: 'unsent words' }), { ok: true });
  fs.writeFileSync(clientFilePath(w.userDataPath, record.team_id), '{broken');
  await w.service.startExisting();
  assert.deepEqual(await w.service.handle('removeTeam', { team_id: record.team_id }), { ok: true });
  assert.equal(saveClientFile(w.userDataPath, record).ok, true, 'the same team joined again');
  assert.deepEqual(await w.service.handle('projectDraftGet', { team_id: record.team_id, session_id: S1 }), { ok: true, text: '' });
});
