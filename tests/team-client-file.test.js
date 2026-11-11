'use strict';

// The member client file (slice 1f-1): <userData>/team/<team_id>/client.json,
// schema 1, exactly the spec's fields, closed validation on load, atomic write,
// and an unknown or newer version refused with nothing rewritten.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CLIENT_FIELDS, clientFilePath, listTeamIds, loadClientFile, removeClientFile, saveClientFile,
} = require('../services/team/client-file');
const { deriveTeamId, keyPairFromSeed } = require('../server/team/ids');
const { tempProfile } = require('./helpers/team-client-host');

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
  assert.deepEqual(loadClientFile(dir, value.team_id), { ok: true, record: value });
  assert.deepEqual(listTeamIds(dir), [value.team_id]);
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
    record({ schema_version: 2 }),
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
    [JSON.stringify({ ...value, schema_version: 2 }), 'team_client_schema_unsupported'],
    [JSON.stringify({ ...value, schema_version: 0 }), 'team_client_schema_unsupported'],
  ]) {
    fs.writeFileSync(file, text);
    assert.deepEqual(loadClientFile(dir, value.team_id), { ok: false, reason });
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'nothing rewritten');
  }
});

test('an oversized file is refused', (t) => {
  const dir = profile(t);
  const value = record();
  saveClientFile(dir, value);
  const file = clientFilePath(dir, value.team_id);
  fs.writeFileSync(file, JSON.stringify({ ...value, pad: 'x'.repeat(70_000) }));
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
