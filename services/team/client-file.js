'use strict';

// The member's record of one team: <userData>/team/<team_id>/client.json
// (TEAM_MEMBERSHIP_SPEC "Desktop client (M15)"). Closed validation on load and
// on save; an atomic write through the host's durable JSON helper; an unknown or
// newer version is refused and nothing is rewritten. It holds the host's public
// key and addresses (main-process facts the renderer never sees) and no key or
// secret of the member's.
//
// Schema 2 (chat slice 2a-4b) adds the member's chat drafts and unsent outbox:
// text the user wrote on this PC, never anything of the team's history (owner
// decision C6). A schema 1 file is migrated explicitly on load (empty drafts and
// outbox) and rewritten as schema 2. The membership and the chat part are
// checked apart: a valid membership loads whatever the chat part holds, and
// each draft or outbox entry that fails its check (or repeats an earlier one,
// or passes a list bound) is dropped alone and counted (`dropped`), so one bad
// entry never makes a team unloadable. Two writers share the file, each owning
// its part: `saveClientFile` writes the membership fields and keeps the
// readable chat entries on disk (never an empty part over a readable one);
// `saveChatState` writes the chat part and keeps the membership fields, and
// never creates a file (a removed team stays removed).
//
// Schema 3 (slice 5-3, TEAM_INTERNET_SPEC) adds `host_name` (null or
// { name, port }, a DNS name the member resolves on every dial) and `relay_url`
// (null or a canonical https URL). A schema 2 file loads unchanged and is not
// rewritten on load. A record is written as schema 3 only when one of the two is
// set; a LAN team keeps writing schema 2, so its file stays exactly as before and
// an older Jenny can still read it. A relay token is never in this file (it is in
// the secure store, relay-token-store.js). A newer schema is refused and nothing
// is rewritten.
//
// `label` (this PC's name) is optional, checked by `isCleanText`, left out on load when malformed, refused on save.

const fs = require('node:fs');
const path = require('node:path');

const { removeTreeSync } = require('../fs-remove-no-follow');
const { readJson, writeJson } = require('../host/durable-json');
const { deriveTeamId, isId, isPublicKey } = require('../../server/team/ids');
const { hasExactKeys, isCleanText, isPlainObject } = require('../../server/team/member-schema');
const { isAddressHint, isHostNameValue } = require('../../server/team/invites');
const { MAX_ADDRESSES, isSocketAddress } = require('../../server/team/transport/control-channel');
const { isCanonicalRelayUrl } = require('../../server/team/transport/relay-url');
const {
  DRAFTS_MAX, DRAFT_MAX_BYTES, OUTBOX_ENTRY_MAX_BYTES, OUTBOX_MAX, draftKey, isDraftEntry, isDraftList, isOutboxEntry,
  isOutboxList,
} = require('./chat-shapes');
const { invalidRequest } = require('./team-errors');

const CLIENT_SCHEMA_VERSION = 2;
const INTERNET_SCHEMA_VERSION = 3;
// The join flow builds a LAN membership record stamped 1 (the same fields as 2) and an internet one stamped 3.
const RECORD_VERSIONS = Object.freeze([1, 2, 3]);
const FILE_VERSIONS = Object.freeze([CLIENT_SCHEMA_VERSION, INTERNET_SCHEMA_VERSION]);
const INTERNET_FIELDS = Object.freeze(['host_name', 'relay_url']);
const LABEL = 'label';
const CLIENT_FIELDS = Object.freeze(['schema_version', 'team_id', 'host_public_key', 'address_hints',
  'last_addresses', 'member_id', 'device_id', 'display_name', 'joined_at', 'state_seen']);
const CHAT_FIELDS = Object.freeze(['drafts', 'outbox']);
const STATES_SEEN = Object.freeze(['pending', 'active', 'revoked']);
const MAX_HINTS = 4;
const MEMBERSHIP_MAX_BYTES = 16 * 1024;
// Every bounded part at its largest, plus room for keys and separators.
const MAX_BYTES = MEMBERSHIP_MAX_BYTES + DRAFTS_MAX * (DRAFT_MAX_BYTES + 1024)
  + OUTBOX_MAX * (OUTBOX_ENTRY_MAX_BYTES + 64) + 1024;
const EMPTY_CHAT = Object.freeze({ drafts: Object.freeze([]), outbox: Object.freeze([]) });
// The failure an outbox entry gets when the device that sent it was replaced: it may or may not have committed.
const UNCONFIRMED = Object.freeze(invalidRequest('team_chat_outbox_unconfirmed').error);
const NONE_DROPPED = Object.freeze({ drafts: 0, outbox: 0 });

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

function isMembership(record) {
  if (!isId('team', record.team_id) || !isPublicKey(record.host_public_key)) return false;
  if (deriveTeamId(record.host_public_key) !== record.team_id) return false;
  return isList(record.address_hints, MAX_HINTS, isAddressHint)
    && isList(record.last_addresses, MAX_ADDRESSES, isSocketAddress)
    && isId('member', record.member_id) && isId('device', record.device_id)
    && isCleanText(record.display_name) && isIsoTime(record.joined_at) && STATES_SEEN.includes(record.state_seen);
}

// Schema 3's two fields, both present, each null or valid.
function isInternetPart(value) {
  return INTERNET_FIELDS.every((field) => Object.hasOwn(value, field)) && isHostNameValue(value.host_name)
    && (value.relay_url === null || isCanonicalRelayUrl(value.relay_url));
}

/** True when `record` is a complete membership record (schema 1 or 2, or 3 with its two fields), a valid `label` or none. */
function isValidRecord(value) {
  // An own `label` that is undefined is absent: JSON never writes it.
  const { label: _unset, ...rest } = value || {};
  const record = isPlainObject(value) && Object.hasOwn(value, LABEL) && value.label === undefined ? rest : value;
  if (!isPlainObject(record) || !RECORD_VERSIONS.includes(record.schema_version) || !isMembership(record)) return false;
  const labelled = Object.hasOwn(record, LABEL);
  if (labelled && !isCleanText(record.label)) return false;
  const fields = labelled ? [...CLIENT_FIELDS, LABEL] : CLIENT_FIELDS;
  if (record.schema_version !== INTERNET_SCHEMA_VERSION) return hasExactKeys(record, fields);
  return hasExactKeys(record, [...fields, ...INTERNET_FIELDS]) && isInternetPart(record);
}

/**
 * `record` with a route as the schema has it: schema 3 with both internet fields when `host_name` or
 * `relay_url` is set, else `lanVersion` with neither. The one place that rule is written.
 */
function withRoute(record, { host_name: hostName = null, relay_url: relayUrl = null } = {}, lanVersion = CLIENT_SCHEMA_VERSION) {
  const next = { ...record };
  for (const field of INTERNET_FIELDS) delete next[field];
  if (hostName === null && relayUrl === null) return { ...next, schema_version: lanVersion };
  return { ...next, schema_version: INTERNET_SCHEMA_VERSION, host_name: hostName, relay_url: relayUrl };
}

// The membership fields as written (schema 2, or 3 with a route).
function membershipOf(value) {
  const record = {};
  for (const field of CLIENT_FIELDS) record[field] = value[field];
  if (isCleanText(value.label)) record.label = value.label;
  return withRoute(record, value);
}

const membershipBytes = (value) => Buffer.byteLength(JSON.stringify(membershipOf(value)), 'utf8');

// Keeps the entries of `list` that pass `check`, are not repeats by `keysOf` and fit `max`: { kept, dropped }.
function keepValid(list, max, check, keysOf) {
  if (list === undefined) return { kept: [], dropped: 0 };
  if (!Array.isArray(list)) return { kept: [], dropped: 1 };
  const seen = new Set();
  const kept = [];
  for (const item of list) {
    const keys = check(item) ? keysOf(item) : null;
    if (!keys || kept.length >= max || keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    kept.push(item);
  }
  return { kept, dropped: list.length - kept.length };
}

// The chat part of a parsed schema 2 file, entry by entry: { chat, dropped: { drafts, outbox } }.
function chatPartOf(value) {
  const drafts = keepValid(value.drafts, DRAFTS_MAX, isDraftEntry,
    (item) => [draftKey(item.channel_id, item.thread_root_id)]);
  const outbox = keepValid(value.outbox, OUTBOX_MAX, isOutboxEntry,
    (item) => [`entry:${item.entry_id}`, `request:${item.request_id}`]);
  return { chat: { drafts: drafts.kept, outbox: outbox.kept }, dropped: { drafts: drafts.dropped, outbox: outbox.dropped } };
}

// The membership part of a schema 2 or 3 file: every membership field (and schema 3's two), nothing
// unknown, valid and within its bound.
function isMembershipPart(value, teamId) {
  const keys = Object.keys(value);
  const internet = value.schema_version === INTERNET_SCHEMA_VERSION;
  return keys.every((key) => CLIENT_FIELDS.includes(key) || CHAT_FIELDS.includes(key) || key === LABEL
    || (internet && INTERNET_FIELDS.includes(key)))
    && CLIENT_FIELDS.every((key) => Object.hasOwn(value, key)) && (!internet || isInternetPart(value))
    && isMembership(value) && value.team_id === teamId && membershipBytes(value) <= MEMBERSHIP_MAX_BYTES;
}

// Reads the file: { ok, record, chat, dropped, migrated }, or { ok: false, reason } (with the readable `chat`
// part when only the membership failed, so a membership save keeps it).
function readClientFile(userDataPath, teamId) {
  const file = clientFilePath(userDataPath, teamId);
  let value;
  try {
    value = readJson(file, { maxBytes: MAX_BYTES });
  } catch {
    return { ok: false, reason: 'team_client_invalid' };
  }
  if (value === null) return { ok: false, reason: 'team_client_missing' };
  if (!isPlainObject(value)) return { ok: false, reason: 'team_client_invalid' };
  if (value.schema_version === 1) {
    // Schema 1 to 2: the same membership fields, no drafts, an empty outbox.
    if (!hasExactKeys(value, CLIENT_FIELDS) || !isMembership(value) || value.team_id !== teamId) {
      return { ok: false, reason: 'team_client_invalid' };
    }
    return { ok: true, record: membershipOf(value), chat: { ...EMPTY_CHAT }, dropped: NONE_DROPPED, migrated: true };
  }
  if (Object.hasOwn(value, 'schema_version') && !FILE_VERSIONS.includes(value.schema_version)) {
    return { ok: false, reason: 'team_client_schema_unsupported' };
  }
  const { chat, dropped } = chatPartOf(value);
  if (!isMembershipPart(value, teamId)) return { ok: false, reason: 'team_client_invalid', chat };
  return { ok: true, record: membershipOf(value), chat, dropped, migrated: false };
}

function writeClientFile(userDataPath, record, chat) {
  writeJson(clientFilePath(userDataPath, record.team_id), { ...membershipOf(record), drafts: chat.drafts,
    outbox: chat.outbox });
}

/** { ok, record } with the membership fields (schema 2, or 3 with a name or relay); a schema 1 file is rewritten as schema 2. */
function loadClientFile(userDataPath, teamId) {
  const read = readClientFile(userDataPath, teamId);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (read.migrated) {
    // Best effort: a failed rewrite leaves schema 1 on disk, which loads the same way next time.
    try { writeClientFile(userDataPath, read.record, read.chat); } catch { /* migrated again on the next load */ }
  }
  return { ok: true, record: read.record };
}

// The file a membership save reads first: { read } when it may be replaced (it loaded, it is missing, or only
// its membership part failed and its chat part was read), else { refused } with the read's reason.
function readForSave(userDataPath, record) {
  if (!isValidRecord(record)) return { refused: { ok: false, reason: 'team_client_invalid' } };
  let read;
  try {
    read = readClientFile(userDataPath, record.team_id);
  } catch {
    return { refused: { ok: false, reason: 'team_client_invalid' } };
  }
  const writable = read.ok || read.reason === 'team_client_missing' || (read.reason === 'team_client_invalid' && read.chat);
  return writable ? { read } : { refused: { ok: false, reason: read.reason } };
}

function writeMembership(userDataPath, record, chat) {
  try {
    writeClientFile(userDataPath, record, chat);
  } catch {
    return { ok: false, reason: 'team_client_write_failed' };
  }
  return { ok: true };
}

/** Writes the membership fields; the readable chat entries on disk are kept. A file it could not read is never rewritten. */
function saveClientFile(userDataPath, record) {
  const { read, refused } = readForSave(userDataPath, record);
  return refused || writeMembership(userDataPath, record, read.chat || EMPTY_CHAT);
}

/**
 * A new device for a saved team: the record and the outbox marks in one write. Every entry the old device
 * sent at least once that has no failure gets UNCONFIRMED; entries never sent still go. { ok, count }, or
 * saveClientFile's refusals. The caller lets the team's chat store go of its copy first.
 */
function saveDeviceRecord(userDataPath, record) {
  const { read, refused } = readForSave(userDataPath, record);
  if (refused) return refused;
  const chat = read.chat || EMPTY_CHAT;
  let count = 0;
  const outbox = chat.outbox.map((item) => {
    if (!item.attempted || item.failed !== null) return item;
    count += 1;
    return { ...item, failed: { ...UNCONFIRMED } };
  });
  const written = writeMembership(userDataPath, record, { drafts: chat.drafts, outbox });
  return written.ok ? { ok: true, count } : written;
}

/** Null when the team's file is missing or loads; otherwise the reason it does not load (nothing else is read). */
function clientFileProblem(userDataPath, teamId) {
  const read = readClientFile(userDataPath, teamId);
  return read.ok || read.reason === 'team_client_missing' ? null : read.reason;
}

/** { ok, drafts, outbox, dropped } for a team whose membership loads (`dropped` counts the entries left out). */
function loadChatState(userDataPath, teamId) {
  const read = readClientFile(userDataPath, teamId);
  if (!read.ok) return { ok: false, reason: read.reason };
  return { ok: true, drafts: read.chat.drafts, outbox: read.chat.outbox, dropped: read.dropped };
}

/** Writes the chat part only when the team's file exists and loads; the membership fields are kept. */
function saveChatState(userDataPath, teamId, { drafts, outbox }) {
  if (!isDraftList(drafts) || !isOutboxList(outbox)) return { ok: false, reason: 'team_client_invalid' };
  const read = readClientFile(userDataPath, teamId);
  if (!read.ok) return { ok: false, reason: read.reason };
  try {
    writeClientFile(userDataPath, read.record, { drafts, outbox });
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
  CLIENT_FIELDS, MAX_BYTES, STATES_SEEN, clientFileProblem, clientFilePath, listTeamIds, loadChatState, loadClientFile,
  removeClientFile, removeMembership, saveChatState, saveClientFile, saveDeviceRecord, teamDirExists, withRoute,
};
