'use strict';

// The member's record of one team: <userData>/team/<team_id>/client.json,
// schema 1 (TEAM_MEMBERSHIP_SPEC "Desktop client (M15)"). Exactly the spec's
// fields plus the schema version; closed validation on load and on save; an
// atomic write through the host's durable JSON helper; an unknown or newer
// version is refused and nothing is rewritten. It holds the host's public key
// and addresses (main-process facts the renderer never sees) and no key or
// secret of the member's. Chat slice 2a-4 adds drafts as one schema step.

const fs = require('node:fs');
const path = require('node:path');

const { removeTreeSync } = require('../fs-remove-no-follow');
const { readJson, writeJson } = require('../host/durable-json');
const { deriveTeamId, isId, isPublicKey } = require('../../server/team/ids');
const { isCleanText } = require('../../server/team/member-schema');
const { isAddressHint } = require('../../server/team/invites');
const { MAX_ADDRESSES, isSocketAddress } = require('../../server/team/transport/control-channel');

const CLIENT_SCHEMA_VERSION = 1;
const CLIENT_FIELDS = Object.freeze(['schema_version', 'team_id', 'host_public_key', 'address_hints',
  'last_addresses', 'member_id', 'device_id', 'display_name', 'joined_at', 'state_seen']);
const STATES_SEEN = Object.freeze(['pending', 'active', 'revoked']);
const MAX_HINTS = 4;
const MAX_BYTES = 16 * 1024;

function teamRootPath(userDataPath) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new TypeError('The team root needs an absolute user data path.');
  }
  return path.join(userDataPath, 'team');
}

function clientFilePath(userDataPath, teamId) {
  if (!isId('team', teamId)) throw new TypeError('A client file needs a valid team id.');
  return path.join(teamRootPath(userDataPath), teamId, 'client.json');
}

function isIsoTime(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function isList(value, max, check) {
  return Array.isArray(value) && value.length <= max && value.every(check);
}

/** True when `record` is a complete schema 1 record with nothing else in it. */
function isValidRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const keys = Object.keys(record);
  if (keys.length !== CLIENT_FIELDS.length || !CLIENT_FIELDS.every((field) => Object.hasOwn(record, field))) return false;
  if (record.schema_version !== CLIENT_SCHEMA_VERSION) return false;
  if (!isId('team', record.team_id) || !isPublicKey(record.host_public_key)) return false;
  if (deriveTeamId(record.host_public_key) !== record.team_id) return false;
  return isList(record.address_hints, MAX_HINTS, isAddressHint)
    && isList(record.last_addresses, MAX_ADDRESSES, isSocketAddress)
    && isId('member', record.member_id) && isId('device', record.device_id)
    && isCleanText(record.display_name) && isIsoTime(record.joined_at) && STATES_SEEN.includes(record.state_seen);
}

function loadClientFile(userDataPath, teamId) {
  const file = clientFilePath(userDataPath, teamId);
  let value;
  try {
    value = readJson(file, { maxBytes: MAX_BYTES });
  } catch {
    return { ok: false, reason: 'team_client_invalid' };
  }
  if (value === null) return { ok: false, reason: 'team_client_missing' };
  if (Object.hasOwn(value, 'schema_version') && value.schema_version !== CLIENT_SCHEMA_VERSION) {
    return { ok: false, reason: 'team_client_schema_unsupported' };
  }
  if (!isValidRecord(value) || value.team_id !== teamId) return { ok: false, reason: 'team_client_invalid' };
  return { ok: true, record: value };
}

function saveClientFile(userDataPath, record) {
  if (!isValidRecord(record)) return { ok: false, reason: 'team_client_invalid' };
  const value = {};
  for (const field of CLIENT_FIELDS) value[field] = record[field];
  try {
    writeJson(clientFilePath(userDataPath, record.team_id), value);
  } catch {
    return { ok: false, reason: 'team_client_write_failed' };
  }
  return { ok: true };
}

function removeClientFile(userDataPath, teamId) {
  const file = clientFilePath(userDataPath, teamId);
  removeTreeSync(path.dirname(file));
}

/** True when <userData>/team/<team_id> exists in any form (a file, a link, a directory). */
function teamDirExists(userDataPath, teamId) {
  const dir = path.dirname(clientFilePath(userDataPath, teamId));
  try {
    fs.lstatSync(dir);
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

/**
 * Removes a membership's device key and/or its client file. A failure is logged and
 * reported, never thrown: { key, file } is true for each part that is gone or was not asked for.
 */
function removeMembership({ userDataPath, deviceKeys, teamId, key = true, file = true, log = () => {} }) {
  const result = { key: true, file: true };
  if (key) {
    try { deviceKeys.remove(teamId); } catch { result.key = false; log('WARN', 'team.key_cleanup_failed', { team_id: teamId }); }
  }
  if (file) {
    try { removeClientFile(userDataPath, teamId); } catch { result.file = false; log('WARN', 'team.file_cleanup_failed', { team_id: teamId }); }
  }
  return result;
}

/** Team ids that have a directory under <userData>/team; reads directory names only. */
function listTeamIds(userDataPath) {
  let entries;
  try {
    entries = fs.readdirSync(teamRootPath(userDataPath), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory() && isId('team', entry.name)).map((entry) => entry.name).sort();
}

module.exports = {
  CLIENT_FIELDS, STATES_SEEN, clientFilePath, listTeamIds, loadClientFile, removeClientFile, removeMembership,
  saveClientFile, teamDirExists,
};
