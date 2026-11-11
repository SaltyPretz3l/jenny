'use strict';

// Slice 1h: `team-keygen` writes <secrets_dir>/team-host-key once, and the
// team host reads it back through the same file store and decode it starts with.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { FileSecretStore, TEAM_HOST_SECRET_FILES } = require('../../server/file-secret-store');
const { PUBLIC_KEY_BYTES, decodeBase64url, deriveTeamId, keyPairFromSeed } = require('../../server/team/ids');
const { createOutputStream: sink, createTeamHostFixture, writeSingleOwnerConfig } = require('./helpers/team-host-fixture');

function keygen(options) {
  return require('../../server/team/keygen').createTeamHostKey(options);
}

test('the written key is read back by the file store, decodes to 32 bytes and starts the host', async (t) => {
  const fx = createTeamHostFixture(t, { writeKey: false });
  const output = sink();
  const logs = [];
  const result = await keygen({ configPath: fx.configPath, output, logger: (...entry) => logs.push(entry) });
  assert.equal(result.ok, true);

  const value = new FileSecretStore({ directory: fx.secrets, files: TEAM_HOST_SECRET_FILES }).get('team_host_key');
  const seed = decodeBase64url(value, PUBLIC_KEY_BYTES);
  assert.ok(seed, 'base64url of exactly 32 bytes');
  const { publicKey } = keyPairFromSeed(seed);
  const teamId = deriveTeamId(publicKey);
  assert.equal(result.team_id, teamId);
  assert.match(output.text(), new RegExp(teamId, 'u'));

  // Nothing that carries the key: no output, no log, no result field.
  for (const text of [output.text(), JSON.stringify(logs), JSON.stringify(result)]) {
    assert.equal(text.includes(value), false);
    assert.equal(text.includes(seed.toString('hex')), false);
    assert.equal(text.includes(publicKey), false, 'only the team id is printed');
  }

  // The host started from this file has the key's identity.
  const host = await fx.start(fx.newParent());
  assert.equal(host.publicKey, publicKey);
});

test('an existing key file is refused and left byte-identical', async (t) => {
  const fx = createTeamHostFixture(t);
  const before = fs.readFileSync(fx.keyFile);
  const output = sink();
  const result = await keygen({ configPath: fx.configPath, output });
  assert.deepEqual(result, { ok: false, reason: 'team_host_key_exists' });
  assert.deepEqual(fs.readFileSync(fx.keyFile), before);
  assert.equal(output.text().includes(before.toString('utf8').trim()), false);
});

test('the random buffer is zeroed after the write', async (t) => {
  const fx = createTeamHostFixture(t, { writeKey: false });
  let handed = null;
  const randomBytes = (size) => { handed = crypto.randomBytes(size); return handed; };
  const result = await keygen({ configPath: fx.configPath, output: sink(), randomBytes });
  assert.equal(result.ok, true);
  assert.equal(handed.length, 32);
  assert.equal(handed.every((byte) => byte === 0), true);
  assert.equal(fs.readFileSync(fx.keyFile, 'utf8').trim().length, 43);
});

test('the key file is mode 0600', { skip: process.platform === 'win32' && 'POSIX modes only' }, async (t) => {
  const fx = createTeamHostFixture(t, { writeKey: false });
  const previous = process.umask(0);
  try {
    assert.equal((await keygen({ configPath: fx.configPath, output: sink() })).ok, true);
  } finally { process.umask(previous); }
  assert.equal(fs.statSync(fx.keyFile).mode & 0o777, 0o600);
});

test('a link at the target is refused and not followed', async (t) => {
  const fx = createTeamHostFixture(t, { writeKey: false });
  const elsewhere = path.join(fx.root, 'elsewhere');
  for (const dangling of [true, false]) {
    if (!dangling) fs.writeFileSync(elsewhere, 'decoy');
    try {
      fs.symlinkSync(elsewhere, fx.keyFile, 'file');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('creating a symlink needs elevation here'); return; }
      throw error;
    }
    const result = await keygen({ configPath: fx.configPath, output: sink() });
    assert.deepEqual(result, { ok: false, reason: 'team_host_key_exists' });
    assert.equal(fs.lstatSync(fx.keyFile).isSymbolicLink(), true);
    if (dangling) assert.equal(fs.existsSync(elsewhere), false, 'the link target was not created');
    else assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'decoy');
    fs.unlinkSync(fx.keyFile);
  }
});

test('a failed write leaves no partial file', async (t) => {
  const fx = createTeamHostFixture(t, { writeKey: false });
  const failing = { ...fs, writeSync: (fd, buffer) => { fs.writeSync(fd, buffer, 0, 5); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  const result = await keygen({ configPath: fx.configPath, output: sink(), fsImpl: failing });
  assert.deepEqual(result, { ok: false, reason: 'team_host_key_write_failed' });
  assert.equal(fs.existsSync(fx.keyFile), false);

  const failingSync = { ...fs, fsyncSync: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } };
  const again = await keygen({ configPath: fx.configPath, output: sink(), fsImpl: failingSync });
  assert.equal(again.ok, false);
  assert.equal(fs.existsSync(fx.keyFile), false);
});

test('only a team config with a secret file key source is accepted', async (t) => {
  const fx = createTeamHostFixture(t, { writeKey: false });
  fx.writeConfig({ source: 'parent_channel' });
  assert.deepEqual(await keygen({ configPath: fx.configPath, output: sink() }),
    { ok: false, reason: 'team_key_source_invalid' });
  assert.equal(fs.existsSync(fx.keyFile), false);

  const single = writeSingleOwnerConfig(fx.root);
  assert.deepEqual(await keygen({ configPath: single, output: sink() }), { ok: false, reason: 'team_config_required' });
  assert.deepEqual(fs.readdirSync(path.join(fx.root, 'single-secrets')), []);

  const missing = await keygen({ configPath: path.join(fx.root, 'nope.json'), output: sink() });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /^[a-z_]+$/u);
});

test('an output that throws after the key is written still answers ok and logs no key', async (t) => {
  const fx = createTeamHostFixture(t, { writeKey: false });
  const logs = [];
  const result = await keygen({ configPath: fx.configPath, output: sink({ failWrites: true }),
    logger: (...entry) => logs.push(entry) });
  const key = fs.readFileSync(fx.keyFile, 'utf8').trim();
  const seed = decodeBase64url(key, PUBLIC_KEY_BYTES);
  assert.deepEqual(result, { ok: true, team_id: deriveTeamId(keyPairFromSeed(seed).publicKey) });
  assert.equal(logs.filter(([, event]) => event === 'team.keygen.print_failed').length, 1);
  assert.equal(JSON.stringify(logs).includes(key), false);
});

test('a file planted between the check and the exclusive create is refused and kept', async (t) => {
  const fx = createTeamHostFixture(t, { writeKey: false });
  const racing = { ...fs, lstatSync: (target, options) => {
    const seen = fs.lstatSync(target, options);
    if (target === fx.keyFile) fs.writeFileSync(fx.keyFile, 'planted');
    return seen;
  } };
  const result = await keygen({ configPath: fx.configPath, output: sink(), fsImpl: racing });
  assert.deepEqual(result, { ok: false, reason: 'team_host_key_exists' });
  assert.equal(fs.readFileSync(fx.keyFile, 'utf8'), 'planted');
});
