'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, writeText } = require('./durable-json');
const { loadHostConfig, normalizeHostConfig, SETUP_PENDING_FILE } = require('../../server/config');
const { FileSecretStore } = require('../../server/file-secret-store');

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readSetup(configPath) {
  const marker = readJson(path.join(path.dirname(configPath), SETUP_PENDING_FILE), { maxBytes: 1024 });
  if (marker && (marker.schema_version !== 1 || marker.state !== 'pending'
    || Object.keys(marker).some((key) => !['schema_version', 'state'].includes(key)))) {
    throw new Error('unsupported_setup_marker');
  }
  const pending = marker !== null;
  if (!fs.existsSync(configPath)) return { source: null, pending, apiKey: null };
  const config = loadHostConfig(configPath, { allowPendingSetup: true });
  return { source: readJson(configPath, { maxBytes: 128 * 1024 }), pending,
    // Never reuse a key from an interrupted endpoint/key update.
    apiKey: pending || config.modelEndpoint.engine !== 'openai-compatible' ? null : new FileSecretStore({ directory: config.secretsDir }).get('openai_compatible_api_key') };
}

// Caller holds the existing profile lock. Normal startup refuses the pending
// marker, including when rename/fsync reports an ambiguous commit outcome.
function saveSetup(configPath, source, apiKey, {
  writeJsonImpl = writeJson, writeTextImpl = writeText, syncDirectoryImpl = syncDirectory,
} = {}) {
  const config = normalizeHostConfig(source);
  if (apiKey !== null && (typeof apiKey !== 'string' || !apiKey.trim()
    || Buffer.byteLength(apiKey, 'utf8') > 1024 || /\p{Cc}/u.test(apiKey))) {
    throw new Error('invalid_model_key');
  }
  const directory = path.dirname(configPath);
  const pendingPath = path.join(directory, SETUP_PENDING_FILE);
  fs.mkdirSync(config.secretsDir, { recursive: true, mode: 0o700 });
  const secretStat = fs.lstatSync(config.secretsDir);
  if (!secretStat.isDirectory() || secretStat.isSymbolicLink()) throw new Error('invalid_secret_directory');
  writeJsonImpl(pendingPath, { schema_version: 1, state: 'pending' });
  const secretPath = path.join(config.secretsDir, 'model-api-key');
  if (apiKey !== null) writeTextImpl(secretPath, apiKey.trim());
  else {
    try { fs.unlinkSync(secretPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    syncDirectoryImpl(config.secretsDir);
  }
  writeJsonImpl(configPath, source);
  fs.unlinkSync(pendingPath);
  syncDirectoryImpl(directory);
  return config;
}

// Called under the profile lock before publishing a changed security origin.
async function revokeBrowserSessionsForAccessChange(previous, next) {
  if (!previous) return;
  const priorMode = previous.browser_access_mode || 'private_https';
  if (priorMode === next.browser_access_mode && previous.canonical_origin === next.canonical_origin) return;
  const { AuthStore } = require('../../server/auth-store');
  const auth = new AuthStore({ filePath: path.join(previous.user_data_path, 'auth.json') });
  await auth.mutate((state) => ({ ...state, sessions: [] }));
}

module.exports = { readSetup, saveSetup, revokeBrowserSessionsForAccessChange };
