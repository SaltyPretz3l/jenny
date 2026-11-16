'use strict';

// The model offer manifest of team model sharing (slice 6-1,
// TEAM_MODEL_SHARING_SPEC "The offer manifest", MN1 to MN5, owner decisions
// E54 to E57). One pure module validates an offer on the sender, on the host
// and on the receiver, so all three refuse the same offers.
//
// Answers `{ ok: true, manifest }` with a frozen copy, or `{ ok: false, reason }`
// with a reason from MODEL_MANIFEST_REASONS. A reason never echoes a name, a
// hash, a URL or any other value from the offer, and nothing here throws on
// input. No file system call: names are carried as data for the receiver.

const path = require('node:path');

const { SHARD_SUFFIX, modelFamily, splitGgufFiles } = require('../../services/llama-server-gguf-files');
const { hasExactKeys, isCleanText, isPlainObject } = require('./member-schema');
const { ID_PATTERNS } = require('./ids');
const { validateSegment } = require('./path-segments');
const { foldKey } = require('./transfer-manifest');

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

// Every number in the spec's Limits table. Later slices (relay, routes,
// receiver, sender) import these; this slice's validator uses the offer ones.
const MODEL_TRANSFER_LIMITS = Object.freeze({
  minFiles: 1,
  maxFiles: 8,
  minFileBytes: 1,
  maxFileBytes: 64 * GIB,
  maxTotalBytes: 256 * GIB,
  partBytes: 4 * MIB,
  segmentBytes: GIB,
  maxSegmentsPerFile: 64,
  maxBodyBytes: 64 * KIB,
  maxRequestIdChars: 64,
  maxDisplayNameChars: 128,
  maxNameUnits: 200,
  maxLicenceChars: 4096,
  maxNoteChars: 1024,
  maxSourceUrlChars: 512,
  maxOffersPerMember: 16,
  maxOffersPerHost: 128,
  maxPendingDirectOffers: 8,
  // Receivers of a team offer the caller may name (the team size), and transfer records the relay
  // holds, live and recently ended (slice 6-2).
  maxReceivers: 8,
  maxTransferRecords: 256,
  // Live transfers one member may receive at once, so one member cannot fill the record table.
  maxLiveTransfersPerMember: 4,
  directOfferLifeMs: 24 * HOUR,
  flowingPerHost: 2,
  maxFlowingPerHost: 4,
  flowingOutgoingPerMember: 1,
  flowingIncomingPerMember: 1,
  windowParts: 4,
  partRequestsPerParty: 2,
  waitingPutsPerTransfer: 1,
  putWaitMs: 20 * SECOND,
  getPollMs: 25 * SECOND,
  pauseIdleMs: 60 * SECOND,
  forgetIdleMs: HOUR,
  senderGraceMs: 120 * SECOND,
  streamsPerTransfer: 3,
  journalEntries: 16,
  stagingIdleMs: 7 * 24 * HOUR,
  freeSpaceMarginBytes: GIB,
  segmentRetries: 2,
  provenanceFileBytes: 16 * KIB,
  // The model hasher's in-memory cache (services/team/model-hash.js; a test pins the two equal).
  hashCacheEntries: 64,
});

const MODEL_MANIFEST_REASONS = Object.freeze([
  'manifest_not_object', 'manifest_keys', 'manifest_too_large', 'request_id_invalid', 'audience_invalid',
  'display_name_invalid', 'files_count', 'file_invalid', 'name_invalid', 'name_collision', 'size_invalid',
  'total_too_large', 'sha256_invalid', 'segments_invalid', 'model_set_invalid', 'provenance_invalid',
  'licence_invalid', 'note_invalid', 'source_url_invalid',
]);

const TOP_KEYS = Object.freeze(['request_id', 'audience', 'display_name', 'files', 'provenance']);
const FILE_KEYS = Object.freeze(['name', 'size', 'sha256', 'segments']);
const PROVENANCE_KEYS = Object.freeze(['licence', 'source_url', 'note']);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GGUF = /\.gguf$/iu;
// The provenance file the receiver writes beside the main model.
const PROVENANCE_SUFFIX = '.jenny-source.json';
// The name a placement move sets a file aside under (services/gguf-place.js `placeFile`, the receiver's suffix).
const MOVING_SUFFIX = '.jenny-moving';
// The longest name a receive builds from a received name (review round two, R14-F05): the main model's provenance
// file set aside by a move, `<name>.jenny-source.json.jenny-moving`. Every name must leave room for it.
const LONGEST_RECEIVE_SUFFIX = `${PROVENANCE_SUFFIX}${MOVING_SUFFIX}`;
// Printable ASCII with no space: a parsed https URL never needs more.
const URL_TEXT = /^[\x21-\x7e]+$/u;

const L = MODEL_TRANSFER_LIMITS;
const refuse = (reason) => ({ ok: false, reason });
const isObjectWith = (value, keys) => isPlainObject(value) && isPlainPrototype(value) && hasExactKeys(value, keys);

function isPlainPrototype(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function bodyBytes(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : Infinity;
  } catch (_error) {
    return Infinity;
  }
}

// Licence and note text: empty, or the clean-text rule with line feeds and
// tabs also allowed (each is checked as a visible stand-in) and something
// other than white space present.
function isProseText(value, maxChars) {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return true;
  if (!/\S/u.test(value) || !value.isWellFormed()) return false;
  return isCleanText(value.replace(/[\n\t]/gu, 'x'), maxChars);
}

function isSourceUrl(value) {
  if (value === null || value === '') return true;
  if (typeof value !== 'string' || value.length > L.maxSourceUrlChars || !URL_TEXT.test(value)) return false;
  // The text is what is stored and shown, so it must read as https:// itself, not only parse as https.
  if (!value.startsWith('https://') || value.includes('\\')) return false;
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    return false;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname !== '';
}

function nameReason(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > L.maxNameUnits) return 'name_invalid';
  if (!GGUF.test(name) || name.startsWith('.')) return 'name_invalid';
  if (!validateSegment(name).ok || !validateSegment(`${name}${LONGEST_RECEIVE_SUFFIX}`).ok) return 'name_invalid';
  return '';
}

function fileReason(entry) {
  if (!isObjectWith(entry, FILE_KEYS)) return 'file_invalid';
  const reason = nameReason(entry.name);
  if (reason) return reason;
  const { size, sha256, segments } = entry;
  if (!Number.isSafeInteger(size) || size < L.minFileBytes || size > L.maxFileBytes) return 'size_invalid';
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return 'sha256_invalid';
  if (!Array.isArray(segments) || segments.length !== Math.ceil(size / L.segmentBytes)) return 'segments_invalid';
  // Every index, holes included (`every` skips the holes of a sparse array).
  for (let index = 0; index < segments.length; index += 1) {
    if (typeof segments[index] !== 'string' || !SHA256.test(segments[index])) return 'segments_invalid';
  }
  return '';
}

function parseShard(name) {
  const base = path.basename(name, path.extname(name));
  const suffix = SHARD_SUFFIX.exec(base);
  if (!suffix) return null;
  // The match is a separator, five digits, `-of-` in any case and five digits.
  const text = suffix[0];
  return { stem: base.slice(0, suffix.index).toLowerCase(), part: Number(text.slice(1, 6)), total: Number(text.slice(-5)) };
}

// MN1: one main model, or every shard of one split model numbered 1..N with
// N files; at most one projector; drafters only of the main model's family.
// The main model is the unsplit file or shard 1.
function modelSetMain(names) {
  const { main, drafters, projectors } = splitGgufFiles(names);
  if (main.length === 0 || projectors.length > 1) return '';
  let mainName = main[0];
  if (main.length > 1 || parseShard(main[0])) {
    const shards = main.map(parseShard);
    if (shards.some((shard) => shard === null)) return '';
    const { stem, total } = shards[0];
    if (total !== main.length || shards.some((shard) => shard.stem !== stem || shard.total !== total)) return '';
    const parts = new Set(shards.map((shard) => shard.part));
    for (let part = 1; part <= total; part += 1) if (!parts.has(part)) return '';
    mainName = main[shards.findIndex((shard) => shard.part === 1)];
  }
  const family = modelFamily(mainName);
  if (!drafters.every((drafter) => modelFamily(drafter.replace(/^mtp-/iu, '')) === family)) return '';
  return mainName;
}

function filesReason(files) {
  if (!Array.isArray(files) || files.length < L.minFiles || files.length > L.maxFiles) return 'files_count';
  let total = 0;
  const keys = new Set();
  for (const entry of files) {
    const reason = fileReason(entry);
    if (reason) return reason;
    total += entry.size;
    if (total > L.maxTotalBytes) return 'total_too_large';
    const key = foldKey(entry.name);
    if (keys.has(key)) return 'name_collision';
    keys.add(key);
  }
  return modelSetMain(files.map((entry) => entry.name)) ? '' : 'model_set_invalid';
}

function audienceReason(audience) {
  if (isObjectWith(audience, ['kind']) && audience.kind === 'team') return '';
  if (isObjectWith(audience, ['kind', 'member_id']) && audience.kind === 'member'
    && typeof audience.member_id === 'string' && ID_PATTERNS.member.test(audience.member_id)) return '';
  return 'audience_invalid';
}

function provenanceReason(provenance) {
  if (!isObjectWith(provenance, PROVENANCE_KEYS)) return 'provenance_invalid';
  if (!isProseText(provenance.licence, L.maxLicenceChars)) return 'licence_invalid';
  if (!isProseText(provenance.note, L.maxNoteChars)) return 'note_invalid';
  if (!isSourceUrl(provenance.source_url)) return 'source_url_invalid';
  return '';
}

function freezeManifest(value) {
  return Object.freeze({
    request_id: value.request_id,
    audience: Object.freeze({ ...value.audience }),
    display_name: value.display_name,
    files: Object.freeze(value.files.map((entry) => Object.freeze({
      name: entry.name, size: entry.size, sha256: entry.sha256, segments: Object.freeze([...entry.segments]),
    }))),
    provenance: Object.freeze({ ...value.provenance }),
  });
}

/** Validate an offer manifest (MN1 to MN5). Never throws on input: a getter or proxy that throws is refused. */
function validateModelManifest(value) {
  try {
    return checkManifest(value);
  } catch (_error) {
    return refuse('manifest_not_object');
  }
}

function checkManifest(value) {
  if (!isPlainObject(value) || !isPlainPrototype(value)) return refuse('manifest_not_object');
  // Cheap shape checks first, so an oversized object is refused before it is serialized whole.
  if (!hasExactKeys(value, TOP_KEYS)) return refuse('manifest_keys');
  if (!Array.isArray(value.files) || value.files.length < L.minFiles || value.files.length > L.maxFiles) {
    return refuse('files_count');
  }
  if (bodyBytes(value) > L.maxBodyBytes) return refuse('manifest_too_large');
  if (typeof value.request_id !== 'string' || !REQUEST_ID.test(value.request_id)) return refuse('request_id_invalid');
  const audience = audienceReason(value.audience);
  if (audience) return refuse(audience);
  if (!isCleanText(value.display_name, L.maxDisplayNameChars) || !value.display_name.isWellFormed()) {
    return refuse('display_name_invalid');
  }
  const files = filesReason(value.files);
  if (files) return refuse(files);
  const provenance = provenanceReason(value.provenance);
  if (provenance) return refuse(provenance);
  return { ok: true, manifest: freezeManifest(value) };
}

/** The main model's name in an already validated manifest (the unsplit file or shard 1). */
function mainModelName(manifest) {
  return modelSetMain(manifest.files.map((entry) => entry.name));
}

module.exports = {
  MODEL_MANIFEST_REASONS,
  MODEL_TRANSFER_LIMITS,
  MOVING_SUFFIX,
  PROVENANCE_SUFFIX,
  mainModelName,
  validateModelManifest,
};
