'use strict';

// The member client file (slice 1f-1): <userData>/team/<team_id>/client.json,
// exactly the spec's fields, closed validation on load, atomic write, and an
// unknown or newer version refused with nothing rewritten. Since slice 2a-4b the
// file is schema 2 (drafts and outbox; tests/team-client-file-chat.test.js); the
// membership record the join flow builds is still stamped 1 and saves as 2.
// Member-side saved-team fixes (E47): a saved team that cannot be loaded is a
// `needs_repair` row, never hidden; a leftover directory or key is cleaned.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CLIENT_FIELDS, MAX_BYTES, clientFilePath, listTeamIds, loadChatState, loadClientFile, removeClientFile, saveChatState,
  saveClientFile,
} = require('../services/team/client-file');
const { deriveTeamId, keyPairFromSeed } = require('../server/team/ids');
const { parseInvite } = require('../server/team/invites');
const { createDeviceKeyStore, deviceKeyName } = require('../services/team/device-key-store');
const { createTeamClientHost, tempProfile, waitUntil } = require('./helpers/team-client-host');
const { holdRedeem, queued, recover, savedTeam } = require('./helpers/team-saved');

function hostKey() {
  return keyPairFromSeed(crypto.randomBytes(32)).publicKey;
}

function record(overrides = {}) {
  const host = hostKey();
  return {
    schema_version: 1,
    team_id: deriveTeamId(host),
    host_public_key: host,
    address_hints: ['192.0.2.7:4242'],
    last_addresses: ['192.0.2.7:4242', '[2001:db8::7]:4242'],
    member_id: 'member_abcDEF123',
    device_id: 'device_abcDEF123',
    display_name: 'Mika Member',
    joined_at: '2026-11-10T10:00:00.000Z',
    state_seen: 'pending',
    ...overrides,
  };
}

const profile = (t) => tempProfile(t, 'jenny-team-client-file-');

test('the field list is exactly the spec list plus the schema version', () => {
  assert.deepEqual([...CLIENT_FIELDS].sort(), ['address_hints', 'device_id', 'display_name', 'host_public_key',
    'joined_at', 'last_addresses', 'member_id', 'schema_version', 'state_seen', 'team_id']);
});

test('save then load round-trips, atomically, at the team path', (t) => {
  const dir = profile(t);
  const value = record();
  assert.deepEqual(saveClientFile(dir, value), { ok: true });
  const file = clientFilePath(dir, value.team_id);
  assert.equal(file, path.join(dir, 'team', value.team_id, 'client.json'));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['client.json'], 'no temp file left');
  assert.deepEqual(loadClientFile(dir, value.team_id), { ok: true, record: { ...value, schema_version: 2 } });
  assert.deepEqual(listTeamIds(dir), [value.team_id]);
  const again = loadClientFile(dir, value.team_id).record;
  assert.deepEqual(saveClientFile(dir, again), { ok: true }, 'a loaded schema 2 record saves');
  assert.deepEqual(loadClientFile(dir, value.team_id), { ok: true, record: again });
});

test('a missing file is reported, not invented', (t) => {
  const dir = profile(t);
  const value = record();
  assert.deepEqual(loadClientFile(dir, value.team_id), { ok: false, reason: 'team_client_missing' });
  assert.deepEqual(listTeamIds(dir), []);
});

test('save refuses an invalid record and writes nothing', (t) => {
  const dir = profile(t);
  const cases = [
    record({ extra: 1 }),
    record({ schema_version: 3 }),
    record({ drafts: [] }),
    record({ team_id: 'team_wrong' }),
    record({ host_public_key: 'short' }),
    record({ address_hints: ['not an address'] }),
    record({ address_hints: Array(5).fill('192.0.2.7:4242') }),
    record({ last_addresses: Array(17).fill('192.0.2.7:4242') }),
    record({ member_id: 'device_x' }),
    record({ device_id: 'member_x' }),
    record({ display_name: '' }),
    record({ display_name: 'x'.repeat(65) }),
    record({ joined_at: 'yesterday' }),
    record({ state_seen: 'online' }),
  ];
  for (const value of cases) {
    const result = saveClientFile(dir, value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.reason, 'team_client_invalid');
  }
  const missing = record();
  delete missing.device_id;
  assert.equal(saveClientFile(dir, missing).ok, false);
  assert.equal(fs.existsSync(path.join(dir, 'team')), false);
});

test('load refuses unknown fields, garbage and a mismatched team id, leaving the file as it was', (t) => {
  const dir = profile(t);
  const value = record();
  saveClientFile(dir, value);
  const file = clientFilePath(dir, value.team_id);
  for (const [text, reason] of [
    [JSON.stringify({ ...value, secret_key: 'x' }), 'team_client_invalid'],
    ['{not json', 'team_client_invalid'],
    [JSON.stringify([]), 'team_client_invalid'],
    [JSON.stringify({ ...value, team_id: deriveTeamId(hostKey()) }), 'team_client_invalid'],
    [JSON.stringify({ ...value, schema_version: 4, drafts: [], outbox: [] }), 'team_client_schema_unsupported'],
    // Schema 3 (slice 5-3) needs both of its fields.
    [JSON.stringify({ ...value, schema_version: 3, drafts: [], outbox: [] }), 'team_client_invalid'],
    [JSON.stringify({ ...value, schema_version: 0 }), 'team_client_schema_unsupported'],
  ]) {
    fs.writeFileSync(file, text);
    assert.deepEqual(loadClientFile(dir, value.team_id), { ok: false, reason });
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'nothing rewritten');
  }
  // The membership decides: a schema 2 file with no chat lists loads, as an empty chat part.
  fs.writeFileSync(file, JSON.stringify({ ...value, schema_version: 2 }));
  assert.equal(loadClientFile(dir, value.team_id).ok, true);
});

test('an oversized file is refused', (t) => {
  const dir = profile(t);
  const value = record();
  saveClientFile(dir, value);
  const file = clientFilePath(dir, value.team_id);
  fs.writeFileSync(file, JSON.stringify({ ...value, pad: 'x'.repeat(MAX_BYTES) }));
  assert.equal(loadClientFile(dir, value.team_id).ok, false);
});

test('listTeamIds reads directory names only and skips names that are not team ids', (t) => {
  const dir = profile(t);
  const value = record();
  saveClientFile(dir, value);
  fs.mkdirSync(path.join(dir, 'team', 'not-a-team'));
  fs.writeFileSync(path.join(dir, 'team', 'stray.txt'), 'x');
  assert.deepEqual(listTeamIds(dir), [value.team_id]);
});

test('remove deletes only that team directory', (t) => {
  const dir = profile(t);
  const a = record();
  const b = record();
  saveClientFile(dir, a);
  saveClientFile(dir, b);
  removeClientFile(dir, a.team_id);
  assert.deepEqual(listTeamIds(dir), [b.team_id]);
  assert.throws(() => removeClientFile(dir, '..'), TypeError);
  assert.throws(() => clientFilePath(dir, 'team_a/../../x'), TypeError);
});

test('the file holds no key and no secret field', () => {
  for (const field of CLIENT_FIELDS) assert.equal(/secret|seed|private|launch/.test(field), false, field);
});

// ---------------------------------------------------------------- schema 3 (slice 5-3)

const NAMED = { name: 'team.example.net', port: 4242 };
const DRAFT = { channel_id: 'chan_team', thread_root_id: null, text: 'half a thought', updated_at: '2026-11-10T10:00:00.000Z' };
const QUEUED = { entry_id: `out_entry${'1'.padStart(16, '0')}`, request_id: 'req_1', operation: 'team.chat.post',
  params: { channel_id: 'chan_team', text: 'queued 1' }, created_at: '2026-11-10T10:00:00.000Z', attempted: false,
  failed: null };

// Fault: a schema 2 file rewritten on load, or migrated so an older Jenny can no longer read it.
test('a schema 2 file with drafts and an outbox loads unchanged and is not rewritten', (t) => {
  const dir = profile(t);
  const value = record({ schema_version: 2 });
  assert.equal(saveClientFile(dir, value).ok, true);
  assert.equal(saveChatState(dir, value.team_id, { drafts: [DRAFT], outbox: [QUEUED] }).ok, true);
  const file = clientFilePath(dir, value.team_id);
  const bytes = fs.readFileSync(file);
  assert.deepEqual(loadClientFile(dir, value.team_id), { ok: true, record: value });
  assert.deepEqual(loadChatState(dir, value.team_id).drafts, [DRAFT]);
  assert.deepEqual(loadChatState(dir, value.team_id).outbox, [QUEUED]);
  assert.deepEqual(fs.readFileSync(file), bytes, 'loading changed nothing on disk');
  // A LAN record saves as schema 2 again: the same bytes as before.
  assert.equal(saveClientFile(dir, loadClientFile(dir, value.team_id).record).ok, true);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

// Fault: schema 3 refused, its two fields dropped, or the chat part lost on the step up.
test('schema 3 loads with its name and relay, keeps the chat part, and steps back to 2 when both are cleared', (t) => {
  const dir = profile(t);
  const lan = record({ schema_version: 2 });
  assert.equal(saveClientFile(dir, lan).ok, true);
  assert.equal(saveChatState(dir, lan.team_id, { drafts: [DRAFT], outbox: [] }).ok, true);
  const internet = { ...lan, schema_version: 3, host_name: NAMED, relay_url: 'https://relay.example.net' };
  assert.equal(saveClientFile(dir, internet).ok, true);
  const file = clientFilePath(dir, lan.team_id);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.schema_version, 3);
  assert.deepEqual(onDisk.drafts, [DRAFT], 'the chat part is kept');
  assert.deepEqual(loadClientFile(dir, lan.team_id), { ok: true, record: internet });
  const relayOnly = { ...lan, schema_version: 3, host_name: null, relay_url: 'https://relay.example.net:8443' };
  assert.equal(saveClientFile(dir, relayOnly).ok, true);
  assert.deepEqual(loadClientFile(dir, lan.team_id).record, relayOnly);
  assert.equal(saveClientFile(dir, { ...lan, schema_version: 3, host_name: null, relay_url: null }).ok, true);
  assert.deepEqual(loadClientFile(dir, lan.team_id).record, lan, 'nothing internet left: schema 2 again');
});

// Fault: a schema 3 record accepted with a bad name, a non-canonical relay, a token, or one field missing.
test('schema 3 refuses a bad name, a bad relay, a missing field and a token; a newer schema is left byte for byte', (t) => {
  const dir = profile(t);
  const value = record({ schema_version: 2 });
  saveClientFile(dir, value);
  const file = clientFilePath(dir, value.team_id);
  for (const bad of [
    { schema_version: 3, host_name: { name: 'Team.Example.net', port: 1 }, relay_url: null },
    { schema_version: 3, host_name: { name: 'team.example.net', port: 0 }, relay_url: null },
    { schema_version: 3, host_name: 'team.example.net', relay_url: null },
    { schema_version: 3, host_name: null, relay_url: 'http://relay.example.net' },
    { schema_version: 3, host_name: null, relay_url: 'https://relay.example.net/' },
    { schema_version: 3, host_name: NAMED },
    { schema_version: 3, host_name: NAMED, relay_url: null, relay_token: 'tok' },
    { schema_version: 2, host_name: NAMED, relay_url: null },
  ]) {
    assert.deepEqual(saveClientFile(dir, { ...value, ...bad }), { ok: false, reason: 'team_client_invalid' }, JSON.stringify(bad));
    const text = JSON.stringify({ ...value, ...bad, drafts: [], outbox: [] });
    fs.writeFileSync(file, text);
    assert.equal(loadClientFile(dir, value.team_id).reason, 'team_client_invalid', JSON.stringify(bad));
  }
  const newer = JSON.stringify({ ...value, schema_version: 4, host_name: NAMED, relay_url: null, drafts: [], outbox: [] });
  fs.writeFileSync(file, newer);
  assert.deepEqual(loadClientFile(dir, value.team_id), { ok: false, reason: 'team_client_schema_unsupported' });
  assert.deepEqual(saveClientFile(dir, { ...value, schema_version: 3, host_name: NAMED, relay_url: null }),
    { ok: false, reason: 'team_client_schema_unsupported' });
  assert.equal(fs.readFileSync(file, 'utf8'), newer, 'nothing rewritten');
});

// Fault: this PC's name left out of the record (Settings asks for it after every restart), or a malformed one
// making the team unloadable instead of being left out alone.
test('label: kept with the record in schema 2 and 3; a bad one is refused on save and left out on load', (t) => {
  const dir = profile(t);
  const value = record({ schema_version: 2, label: 'Work laptop' });
  assert.deepEqual(saveClientFile(dir, value), { ok: true });
  const file = clientFilePath(dir, value.team_id);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).label, 'Work laptop');
  assert.deepEqual(loadClientFile(dir, value.team_id), { ok: true, record: value });
  const internet = { ...value, schema_version: 3, host_name: NAMED, relay_url: null };
  assert.equal(saveClientFile(dir, internet).ok, true);
  assert.deepEqual(loadClientFile(dir, value.team_id).record, internet);
  const { label: _label, ...plain } = value;
  // Fault: an own `label: undefined` refused, which would lose a join the host already redeemed.
  assert.deepEqual(saveClientFile(dir, { ...plain, label: undefined }), { ok: true }, 'an undefined label is absent');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'label'), false);
  for (const bad of ['', ' padded ', 'x'.repeat(41), 'a\nb', 7, null, { name: 'x' }]) {
    assert.deepEqual(saveClientFile(dir, { ...value, label: bad }), { ok: false, reason: 'team_client_invalid' }, JSON.stringify(bad));
    const text = JSON.stringify({ ...plain, label: bad, drafts: [DRAFT], outbox: [] });
    fs.writeFileSync(file, text);
    assert.deepEqual(loadClientFile(dir, value.team_id), { ok: true, record: plain }, `left out: ${JSON.stringify(bad)}`);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'not rewritten on load');
  }
});

// ---------------------------------------------------------------- saved teams that do not load (E47)

// Fault: a directory whose name is not a team id (markup, a quote, a space) listed, so a needs-repair
// row could draw it.
test('only directories named as team ids are listed, so no markup can reach a row', (t) => {
  const dir = profile(t);
  const value = record({ schema_version: 2 });
  assert.equal(saveClientFile(dir, value).ok, true);
  const root = path.dirname(path.dirname(clientFilePath(dir, value.team_id)));
  for (const name of ["team_a'b", 'team_a b', 'team_&amp;x', 'team_a;b', 'not_a_team', 'team_']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, deriveTeamId(hostKey())), 'a file, not a directory');
  assert.deepEqual(listTeamIds(dir), [value.team_id]);
});

const UNLOADABLE = [
  ['team_client_invalid', () => '{broken'],
  ['team_client_schema_unsupported', (good) => JSON.stringify({ ...JSON.parse(good), schema_version: 9 })],
];

// Fault: a directory left without its file kept (it blocks the next join with team_already_joined
// and no row offers to remove it), or its key left in the store.
test('a team directory without its file is cleaned at start: key and directory gone, not listed', async (t) => {
  const { host, me, file } = await savedTeam(t);
  fs.rmSync(file);
  const service = host.createService();
  await service.startExisting();
  assert.equal(fs.existsSync(path.dirname(file)), false, 'the directory is gone');
  assert.equal(host.secureStore.values.has(deviceKeyName(me.teamId)), false, 'the key is gone');
  assert.deepEqual((await service.handle('status')).teams, []);
  assert.deepEqual(host.logs.filter((line) => line.event === 'team.half_saved.cleaned').map((line) => line.fields),
    [{ team_id: me.teamId }]);
});

// Fault: a stored key with nothing else of the team blocking every later join (team_already_joined).
test('a stored key with no directory is removed by the next join, which then reaches the host', async (t) => {
  const host = await createTeamClientHost(t);
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  createDeviceKeyStore({ getSecureStore: () => host.secureStore }).save(teamId, crypto.randomBytes(32));
  const service = host.createService();
  const joined = await service.handle('join', { invite, display_name: 'Olive Owner', label: 'Desk' });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(host.env.redeemCalls.length, 1, 'the join reached the host');
  assert.equal(loadClientFile(host.userData, teamId).ok, true);
});

for (const [reason, text] of UNLOADABLE) {
  // Fault: a saved team whose file does not load hidden (skipped), started, sent
  // anything, read for more than its directory name, not counted toward the limit, or removable by leave.
  test(`a saved file that does not load (${reason}) is a needs_repair row with no manager or chat`, async (t) => {
    const { host, me, file, good } = await savedTeam(t);
    fs.writeFileSync(file, text(good));
    const spawns = host.memberSpawner.spawns.length;
    const service = host.createService();
    await service.startExisting();
    const row = { team_id: me.teamId, state: 'needs_repair', reason };
    assert.deepEqual((await service.handle('status')).teams, [row]);
    assert.deepEqual(host.states.at(-1).teams, [row], 'the pushed snapshot lists it too');
    assert.equal(service.resources().managers, 0);
    assert.equal(host.memberSpawner.spawns.length, spawns, 'nothing connects');
    assert.equal((await service.handle('chatOverview', { team_id: me.teamId })).error.reason, 'team_not_found');
    assert.equal((await service.handle('leave', { team_id: me.teamId })).error.reason, 'team_not_found');
    assert.equal((await service.handle('members', { team_id: me.teamId })).error.reason, 'team_not_found');
    const again = (await host.invite({ actor: me.member_id })).invite;
    assert.equal((await service.handle('join', { invite: again, display_name: 'Olive', label: 'Desk' })).error.reason,
      'team_already_joined');
    assert.equal(fs.readFileSync(file, 'utf8'), text(good), 'nothing rewritten');
    assert.ok(host.secureStore.values.has(deviceKeyName(me.teamId)), 'the key is kept');

    // Fault: a recovery that redeems first and only then finds the file it cannot save over.
    const redeems = host.env.redeemCalls.length;
    const key = host.secureStore.values.get(deviceKeyName(me.teamId));
    const recovered = await service.ownerRecover({ invite: (await host.invite({ kind: 'recovery' })).invite,
      display_name: 'Olive Owner', label: 'New desk' });
    assert.equal(recovered.error?.reason, reason, JSON.stringify(recovered));
    assert.equal(host.env.redeemCalls.length, redeems, 'no redeem sent');
    assert.equal(host.secureStore.values.get(deviceKeyName(me.teamId)), key, 'no key changed');
    assert.equal(fs.readFileSync(file, 'utf8'), text(good), 'no file changed');

    // Heals: the next status after the file loads again starts its manager.
    fs.writeFileSync(file, good);
    const healed = (await service.handle('status')).teams;
    assert.deepEqual(healed.map((team) => [team.team_id, team.state === 'needs_repair']), [[me.teamId, false]]);
    await host.waitForState(me.teamId, 'online');
  });
}

// Fault: removeTeam refusing a row with no manager (team_not_found), or removing a team whose file
// loads again at that moment.
test('removeTeam removes a still-unloadable team and refuses without removing when its file loads now', async (t) => {
  const { host, me, file, good } = await savedTeam(t);
  fs.writeFileSync(file, '{broken');
  const service = host.createService();
  await service.startExisting();
  fs.writeFileSync(file, good);
  assert.equal((await service.handle('removeTeam', { team_id: me.teamId })).error?.reason, 'team_join_in_progress');
  assert.equal(fs.readFileSync(file, 'utf8'), good, 'nothing removed');
  assert.ok(host.secureStore.values.has(deviceKeyName(me.teamId)));
  await host.waitForState(me.teamId, 'online');
  await service.stopAll();

  fs.writeFileSync(file, '{broken');
  const second = host.createService();
  await second.startExisting();
  assert.deepEqual(await second.handle('removeTeam', { team_id: me.teamId }), { ok: true });
  assert.equal(fs.existsSync(path.dirname(file)), false, 'the directory is gone');
  assert.equal(host.secureStore.values.has(deviceKeyName(me.teamId)), false, 'the key is gone');
  assert.deepEqual((await second.handle('status')).teams, []);
});

// Fault: needs-repair rows not counted, so a fifth team is joined past MAX_TEAMS.
test('needs-repair rows count toward the limit of four teams', async (t) => {
  const host = await createTeamClientHost(t);
  for (let n = 0; n < 4; n += 1) {
    const teamId = deriveTeamId(hostKey());
    fs.mkdirSync(path.dirname(clientFilePath(host.userData, teamId)), { recursive: true });
    fs.writeFileSync(clientFilePath(host.userData, teamId), '{broken');
  }
  const service = host.createService();
  const { invite } = await host.invite({ kind: 'owner_first' });
  const answer = await service.handle('join', { invite, display_name: 'Olive Owner', label: 'Desk' });
  assert.equal(answer.error?.reason, 'team_limit_reached', JSON.stringify(answer));
  assert.equal(host.env.redeemCalls.length, 0);
  assert.equal((await service.handle('status')).teams.length, 4);
});

// Fault: a status during a recovery's redeem heals the needs_repair row onto the old record; the redeem then
// revokes that device, its outbox is purged, and the recovery keeps the stale manager instead of the new one.
test('a status while a needs_repair team is recovered starts nothing; the recovery starts the new device', async (t) => {
  const { host, me, file } = await savedTeam(t, { chat: true });
  assert.equal(saveChatState(host.userData, me.teamId, { drafts: [], outbox: [queued(1, true), queued(2)] }).ok, true);
  const withOutbox = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{broken');
  const service = host.createService();
  await service.startExisting();
  fs.writeFileSync(file, withOutbox);
  const held = holdRedeem(t, host);
  const recovering = recover(host, service);
  await held.reached;
  const during = (await service.handle('status')).teams;
  assert.equal(service.resources().managers, 0, 'no manager while the recovery runs');
  assert.deepEqual(during, [{ team_id: me.teamId, state: 'needs_repair', reason: 'team_client_invalid' }]);
  held.release();
  const answer = await recovering;
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const device = loadClientFile(host.userData, me.teamId).record.device_id;
  assert.notEqual(device, me.device_id);
  assert.equal(service.resources().managers, 1);
  await host.waitForState(me.teamId, 'online');
  assert.equal(host.lastState(me.teamId).device_id, device, 'the manager runs on the new device');
  const outbox = () => loadChatState(host.userData, me.teamId).outbox;
  assert.ok(await waitUntil(() => outbox().map((item) => item.request_id).join() === 'req_1'), JSON.stringify(outbox()));
  assert.equal(outbox()[0].failed?.reason, 'team_chat_outbox_unconfirmed', 'the entry the old device sent is kept, marked');
});

// Fault: one status that reads a needs_repair row's file as missing deletes its key and directory; that
// cleanup belongs to the start only. The row stays (team_client_missing) until Remove or the next start.
test('a needs_repair row whose file goes missing stays listed with its key and directory until Remove', async (t) => {
  const { host, me, file } = await savedTeam(t);
  fs.writeFileSync(file, '{broken');
  const service = host.createService();
  await service.startExisting();
  fs.rmSync(file);
  assert.deepEqual((await service.handle('status')).teams,
    [{ team_id: me.teamId, state: 'needs_repair', reason: 'team_client_missing' }]);
  assert.equal(fs.existsSync(path.dirname(file)), true, 'the directory is kept');
  assert.ok(host.secureStore.values.has(deviceKeyName(me.teamId)), 'the key is kept');
  assert.deepEqual(await service.handle('removeTeam', { team_id: me.teamId }), { ok: true });
  assert.equal(fs.existsSync(path.dirname(file)), false);
  assert.equal(host.secureStore.values.has(deviceKeyName(me.teamId)), false);
  assert.deepEqual((await service.handle('status')).teams, []);
});
