'use strict';

// The model receiver's journal (row 123 slice 6-4, TEAM_MODEL_SHARING_SPEC
// "The receiver" and "6-4 as built"). One journal per transfer, in its staging
// folder `<root>/.jenny-incoming/<transfer id>/journal.json`, written
// atomically through `services/host/durable-json.js` and bounded in bytes. It
// records the offer (team, sender, manifest), the family folder name, the
// segment size, per file the count of verified segments and whether the whole
// file passed, and once placement starts where each item stands (see
// model-receive-place.js). The bytes that count are only those up to the last
// verified segment. A journal that does not parse, breaks a rule or does not
// match the offer is refused whole; nothing in it is trusted part way. One
// that cannot be read right now, or is newer, is kept, not refused.
//
// The transfer id is derived from the team, the sender and the files' digests,
// so a fresh offer of the same files from the same sender finds its staging
// folder again after any restart. Staging files are named by index.

const crypto = require('node:crypto');
const path = require('node:path');

const { readJson, writeJson } = require('../host/durable-json');
const { MODEL_TRANSFER_LIMITS, mainModelName, validateModelManifest } = require('../../server/team/model-manifest');
const { ID_PATTERNS } = require('../../server/team/ids');
const { hasExactKeys, isCleanText, isPlainObject } = require('../../server/team/member-schema');
const { OFFER_ID, isPassingReadError, isReceiveFolder } = require('./model-receive-checks');

const INCOMING_DIR = '.jenny-incoming';
const JOURNAL_NAME = 'journal.json';
const JOURNAL_UNAVAILABLE = 'model_journal_unavailable';
const PROVENANCE_STAGED = 'source.json';
const SCHEMA = 1;
const PHASES = Object.freeze(['pulling', 'placing', 'rollback']);
// The reasons a placement rolls back for.
const ROLLBACK_REASONS = Object.freeze(['model_exists', 'model_journal_invalid', 'model_destination_invalid']);
// A set is always placed into a folder of its own (the folder rule, model-receive-checks.js).
const PLACEMENT_MODES = Object.freeze(['new']);
const TRANSFER_ID = /^t[0-9a-f]{32}$/u;
const JOURNAL_KEYS = Object.freeze([
  'schema', 'id', 'team_id', 'offer_id', 'sender', 'manifest', 'folder', 'segment_bytes', 'phase', 'files',
  'placement', 'rollback_reason', 'updated_at',
]);
const FILE_KEYS = Object.freeze(['verified_segments', 'whole']);
const SENDER_KEYS = Object.freeze(['member_id', 'display_name']);
const PLACEMENT_KEYS = Object.freeze(['mode', 'stages']);

const stagingFileName = (index) => `${index}.part`;

/** The transfer id: `t` plus 32 hex of SHA-256 over the team, the sender and each file's name, size and digest. */
function transferIdFor({ teamId, senderId, manifest }) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify([teamId, senderId, manifest.files.map((file) => [file.name, file.size, file.sha256])]));
  return `t${hash.digest('hex').slice(0, 32)}`;
}

const sameFiles = (left, right) => JSON.stringify(left.files) === JSON.stringify(right.files);

function newJournal({ id, offer, folder, segmentBytes, now }) {
  return {
    schema: SCHEMA,
    id,
    team_id: offer.teamId,
    offer_id: offer.offerId,
    sender: { member_id: offer.sender.memberId, display_name: offer.sender.displayName },
    manifest: offer.manifest,
    folder,
    segment_bytes: segmentBytes,
    phase: 'pulling',
    files: offer.manifest.files.map(() => ({ verified_segments: 0, whole: false })),
    placement: null,
    rollback_reason: null,
    updated_at: now,
  };
}

const segmentsOf = (size, segmentBytes) => Math.ceil(size / segmentBytes);
/** Bytes of a file that count: up to its last verified segment. */
const verifiedOffset = (file, entry, segmentBytes) => Math.min(file.size, entry.verified_segments * segmentBytes);

// The placement record: a mode and one stage (0 staged, 1 moved, 2 final) per file plus the provenance file.
function placementHolds(value, phase, items) {
  if (phase === 'pulling') return value === null;
  // Placing, not yet started: no record until the mode is chosen.
  if (value === null) return phase === 'placing';
  if (!isPlainObject(value) || !hasExactKeys(value, PLACEMENT_KEYS) || !PLACEMENT_MODES.includes(value.mode)) return false;
  if (!Array.isArray(value.stages) || value.stages.length !== items) return false;
  if (!value.stages.every((stage) => stage === 0 || stage === 1 || stage === 2)) return false;
  // The folder is renamed into place whole: every item final, or none.
  return value.stages.every((stage) => stage === 2) || !value.stages.includes(2);
}

// Every rule a journal must keep; any break refuses it whole.
function journalHolds(value, { id, segmentBytes, validate }) {
  if (!isPlainObject(value) || !hasExactKeys(value, JOURNAL_KEYS)) return false;
  if (value.schema !== SCHEMA || value.id !== id || value.segment_bytes !== segmentBytes) return false;
  if (typeof value.team_id !== 'string' || !ID_PATTERNS.team.test(value.team_id)) return false;
  if (typeof value.offer_id !== 'string' || !OFFER_ID.test(value.offer_id)) return false;
  if (!isPlainObject(value.sender) || !hasExactKeys(value.sender, SENDER_KEYS)) return false;
  if (typeof value.sender.member_id !== 'string' || !ID_PATTERNS.member.test(value.sender.member_id)) return false;
  if (!isCleanText(value.sender.display_name, MODEL_TRANSFER_LIMITS.maxDisplayNameChars)) return false;
  const checked = validate(value.manifest);
  if (!checked.ok) return false;
  // The folder rule, so a folder is never joined to a root unchecked (review round two, R14-F07).
  if (!isReceiveFolder(value.folder, mainModelName(checked.manifest)) || !PHASES.includes(value.phase)) return false;
  if (!Number.isSafeInteger(value.updated_at) || value.updated_at < 0) return false;
  const files = checked.manifest.files;
  if (!Array.isArray(value.files) || value.files.length !== files.length) return false;
  for (let index = 0; index < files.length; index += 1) {
    const entry = value.files[index];
    if (!isPlainObject(entry) || !hasExactKeys(entry, FILE_KEYS) || typeof entry.whole !== 'boolean') return false;
    const total = segmentsOf(files[index].size, segmentBytes);
    if (!Number.isSafeInteger(entry.verified_segments) || entry.verified_segments < 0
      || entry.verified_segments > total || (entry.whole && entry.verified_segments !== total)) return false;
  }
  if (value.phase !== 'pulling' && !value.files.every((entry) => entry.whole)) return false;
  if (!placementHolds(value.placement, value.phase, files.length + 1)) return false;
  return value.phase === 'rollback' ? ROLLBACK_REASONS.includes(value.rollback_reason) : value.rollback_reason === null;
}

const unavailable = () => Object.assign(new Error(JOURNAL_UNAVAILABLE), { code: JOURNAL_UNAVAILABLE });

/**
 * `{ ok: true, journal }`, `{ ok: true, journal: null }` when there is none, or `{ ok: false }` for a journal that
 * read and breaks a rule. A journal that cannot be judged now (a read failure that may pass, as
 * `server/team/bounded-log.js` draws the line, or a newer schema) throws `model_journal_unavailable`: its staging
 * folder is kept (review sweeps X4b-F05). The sweep skips it; the accept and discard catch-alls in
 * `model-receive.js` answer `model_staging_failed` with nothing removed.
 */
function readJournal(stagingDir, { id, segmentBytes, maxBytes, validate = validateModelManifest }) {
  let value;
  try {
    value = readJson(path.join(stagingDir, JOURNAL_NAME), { maxBytes });
  } catch (error) {
    if (isPassingReadError(error)) throw unavailable();
    return { ok: false };
  }
  if (value === null) return { ok: true, journal: null };
  if (Number.isSafeInteger(value.schema) && value.schema > SCHEMA) throw unavailable();
  return journalHolds(value, { id, segmentBytes, validate }) ? { ok: true, journal: value } : { ok: false };
}

/** Writes atomically; a journal past `maxBytes` throws `journal_too_large` and is not written. */
function writeJournal(stagingDir, journal, { maxBytes }) {
  if (Buffer.byteLength(JSON.stringify(journal), 'utf8') > maxBytes) {
    throw Object.assign(new Error('journal_too_large'), { code: 'journal_too_large' });
  }
  writeJson(path.join(stagingDir, JOURNAL_NAME), journal);
}

module.exports = {
  INCOMING_DIR, JOURNAL_NAME, PROVENANCE_STAGED, ROLLBACK_REASONS, TRANSFER_ID, newJournal, readJournal, sameFiles, segmentsOf,
  stagingFileName, transferIdFor, verifiedOffset, writeJournal,
};
