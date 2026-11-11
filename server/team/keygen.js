'use strict';

// `team-keygen`: creates the team host key for a headless team host whose
// config names `key_source: 'secret_file'`. The file is
// <secrets_dir>/team-host-key, holding base64url of 32 random bytes and a
// newline: exactly what `FileSecretStore` with `TEAM_HOST_SECRET_FILES` reads
// and `team-main.js` decodes at start.
//
// Never overwrite: anything already at the target, a link included, is refused
// and left as it is; the create itself is exclusive and does not follow a link,
// so a file planted between the check and the open is refused too. The file is
// created 0600 (POSIX), synced, and removed again if any step of the write
// fails. The key goes nowhere but the file: not to an output, a log line, an
// argument or the result. The command prints the team id only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadHostConfig } = require('../config');
const { TEAM_HOST_SECRET_FILES } = require('../file-secret-store');
const { PUBLIC_KEY_BYTES, deriveTeamId, keyPairFromSeed } = require('./ids');
const { safeLogger } = require('./safe-logger');

const REASON = /^[a-z][a-z0-9_]{0,79}$/u;

function refusal(reason) {
  return { ok: false, reason };
}

// A config the local team commands accept: a team block whose key comes from
// the mounted secret file. A config that does not load keeps the loader's own
// team reason when it has one.
function loadSecretFileTeamConfig(configPath) {
  let config;
  try {
    config = loadHostConfig(configPath);
  } catch (error) {
    const reason = typeof error?.reason === 'string' && error.reason.startsWith('team_') && REASON.test(error.reason)
      ? error.reason : 'team_config_required';
    return refusal(reason);
  }
  if (!config.team) return refusal('team_config_required');
  if (config.team.keySource !== 'secret_file') return refusal('team_key_source_invalid');
  return { ok: true, config };
}

// Best effort on POSIX; Windows cannot open a directory for fsync.
function syncDirectory(fsImpl, directory) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fsImpl.openSync(directory, fsImpl.constants.O_RDONLY);
    fsImpl.fsyncSync(fd);
  } catch { /* the file itself is synced */ } finally {
    if (fd !== undefined) try { fsImpl.closeSync(fd); } catch { /* already closed */ }
  }
}

function writeKeyFile(fsImpl, target, text) {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fsImpl.constants;
  let fd;
  try {
    fd = fsImpl.openSync(target, O_WRONLY | O_CREAT | O_EXCL | (O_NOFOLLOW || 0), 0o600);
  } catch (error) {
    return error?.code === 'EEXIST' || error?.code === 'ELOOP' ? 'team_host_key_exists' : 'team_host_key_write_failed';
  }
  try {
    if (process.platform !== 'win32') fsImpl.fchmodSync(fd, 0o600);
    let written = 0;
    while (written < text.length) written += fsImpl.writeSync(fd, text, written, text.length - written, null);
    fsImpl.fsyncSync(fd);
    const closing = fd;
    fd = undefined;
    fsImpl.closeSync(closing);
    return null;
  } catch {
    if (fd !== undefined) try { fsImpl.closeSync(fd); } catch { /* the unlink below still runs */ }
    // This call created the file (exclusive create), so removing it removes only our partial write.
    try { fsImpl.unlinkSync(target); } catch { /* nothing left to remove */ }
    return 'team_host_key_write_failed';
  }
}

async function createTeamHostKey({
  configPath, output = process.stdout, randomBytes = crypto.randomBytes, fsImpl = fs, logger = null,
} = {}) {
  const say = safeLogger(logger);
  const loaded = loadSecretFileTeamConfig(configPath);
  if (!loaded.ok) return loaded;
  const directory = loaded.config.secretsDir;
  const target = path.join(directory, TEAM_HOST_SECRET_FILES.team_host_key);
  // lstat: a dangling link "does not exist" to existsSync and must still be refused.
  let existing;
  try { existing = fsImpl.lstatSync(target, { throwIfNoEntry: false }); } catch { return refusal('team_host_key_write_failed'); }
  if (existing) return refusal('team_host_key_exists');

  let seed = null;
  let text = null;
  let teamId;
  try {
    seed = randomBytes(PUBLIC_KEY_BYTES);
    if (!Buffer.isBuffer(seed) || seed.length !== PUBLIC_KEY_BYTES) return refusal('team_host_key_write_failed');
    text = Buffer.from(`${seed.toString('base64url')}\n`, 'utf8');
    teamId = deriveTeamId(keyPairFromSeed(seed).publicKey);
    const failed = writeKeyFile(fsImpl, target, text);
    if (failed) {
      say('ERROR', 'team.keygen.refused', { reason: failed });
      return refusal(failed);
    }
  } catch {
    return refusal('team_host_key_write_failed');
  } finally {
    seed?.fill(0);
    text?.fill(0);
  }
  syncDirectory(fsImpl, directory);
  say('INFO', 'team.keygen.written', {});
  // The key is durable by now: a failed print must not turn that into an error.
  try {
    output.write(`Wrote the team host key to team-host-key in the secrets directory.\nTeam id: ${teamId}\n`);
  } catch {
    say('WARN', 'team.keygen.print_failed', {});
  }
  return { ok: true, team_id: teamId };
}

module.exports = { createTeamHostKey, loadSecretFileTeamConfig };
