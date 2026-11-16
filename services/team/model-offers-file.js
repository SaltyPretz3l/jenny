'use strict';

// The member's open model offers for one team, kept across a restart (row 123 slice 6-5, decision 5): its own file
// `model-offers.json` beside the team's client file, never inside it (client-file.js and its closed key check stay
// as they are). Written atomically through services/host/durable-json.js; schema 1; at most 16 entries, each holding
// only what a re-offer needs: the request id, the offer id the host gave (or null), the audience, the model's
// discovery tag, the chosen file names and the manifest. A file that does not parse, breaks a rule or is over its
// bound is set aside (renamed `model-offers.json.bad-<time>`, one kept) and read as empty. One that cannot be read now
// (a read failure that may pass) or is newer is kept, read as empty, and not written over: `save` refuses with
// `team_unavailable` until a load reads it. Nothing is written before the first offer; the last entry removed removes
// the file. No answer or log carries a path, name or hash.

const fs = require('node:fs');
const path = require('node:path');

const { readJson, writeJson } = require('../host/durable-json');
const { removeFileSync } = require('../fs-remove-no-follow');
const { isId } = require('../../server/team/ids');
const { isPlainObject } = require('../../server/team/member-schema');
const { MODEL_TRANSFER_LIMITS, validateModelManifest } = require('../../server/team/model-manifest');
const { MODEL_RELAY_ID_PATTERNS } = require('../../server/team/model-relay-core');
const { clientFilePath } = require('./client-file');
const { isPassingReadError } = require('./model-receive-checks');

const SCHEMA = 1;
const FILE_NAME = 'model-offers.json';
const MAX_ENTRIES = MODEL_TRANSFER_LIMITS.maxOffersPerMember;
// Sixteen manifests at the 64 KiB body cap, with room for the other fields.
const MAX_BYTES = MAX_ENTRIES * (MODEL_TRANSFER_LIMITS.maxBodyBytes + 4096) + 1024;
const ENTRY_KEYS = Object.freeze(['request_id', 'offer_id', 'audience', 'tag', 'files', 'manifest']);
const TAG = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/\p{Cc}/u.test(value);

// A refusal the caller maps to its own answer (a reason word, never a sentence).
const refused = (reason) => ({ ok: false, reason });

const offersFilePath = (userDataPath, teamId) => path.join(path.dirname(clientFilePath(userDataPath, teamId)), FILE_NAME);

/** One entry checked against its rules (the manifest through 6-1's validator), or null. */
function checkedEntry(value) {
  if (!isPlainObject(value) || Object.keys(value).sort().join() !== [...ENTRY_KEYS].sort().join()) return null;
  const checked = validateModelManifest(value.manifest);
  if (!checked.ok) return null;
  const { manifest } = checked;
  if (value.request_id !== manifest.request_id) return null;
  if (value.offer_id !== null && !(typeof value.offer_id === 'string' && MODEL_RELAY_ID_PATTERNS.offer.test(value.offer_id))) return null;
  const audience = value.audience;
  const direct = isPlainObject(audience) && audience.kind === 'member' && isId('member', audience.member_id)
    && Object.keys(audience).length === 2;
  const team = isPlainObject(audience) && audience.kind === 'team' && Object.keys(audience).length === 1;
  if (!(direct || team) || JSON.stringify(audience) !== JSON.stringify(manifest.audience)) return null;
  if (!TAG(value.tag) || !Array.isArray(value.files)) return null;
  const names = manifest.files.map((file) => file.name);
  if (JSON.stringify(value.files) !== JSON.stringify(names)) return null;
  return { request_id: value.request_id, offer_id: value.offer_id, audience: { ...audience }, tag: value.tag,
    files: [...names], manifest };
}

/**
 * The offers file of one team. `load()` answers the entries (an empty list for a missing, unreadable or broken file,
 * which is set aside first, or for one held as it is); `save(entries)` writes them, or removes the file for none.
 */
function createOffersFile({ userDataPath, teamId, log = () => {}, now = Date.now }) {
  const file = offersFilePath(userDataPath, teamId);
  const say = (level, event, fields) => { try { log(level, event, { team_id: teamId, ...fields }); } catch { /* best effort */ } };

  function setAside(reason) {
    say('WARN', 'team.model.offers_file_set_aside', { reason });
    const dir = path.dirname(file);
    try {
      for (const name of fs.readdirSync(dir)) if (name.startsWith(`${FILE_NAME}.bad-`)) removeFileSync(path.join(dir, name));
      fs.renameSync(file, path.join(dir, `${FILE_NAME}.bad-${now()}`));
    } catch {
      try { removeFileSync(file); } catch { /* left for the next write */ }
    }
  }

  // A file that could not be judged (a read failure that may pass, or a newer schema) is kept as it is and never
  // written over by this object (review sweeps X4b-F05); a later load that reads it lifts the hold.
  let held = false;
  const hold = (fields) => {
    held = true;
    say('WARN', 'team.model.offers_file_kept', fields);
    return [];
  };

  function load() {
    let value;
    try {
      value = readJson(file, { maxBytes: MAX_BYTES });
    } catch (error) {
      if (isPassingReadError(error)) return hold({ code: typeof error.code === 'string' ? error.code : 'none' });
      setAside('unreadable');
      return [];
    }
    held = false;
    if (value === null) return [];
    if (Number.isSafeInteger(value.schema) && value.schema > SCHEMA) return hold({ reason: 'newer' });
    if (value.schema !== SCHEMA || !Array.isArray(value.offers) || value.offers.length > MAX_ENTRIES
      || Object.keys(value).length !== 2) {
      setAside('invalid');
      return [];
    }
    const entries = value.offers.map((entry) => checkedEntry(entry));
    const ids = new Set(entries.map((entry) => entry?.request_id));
    if (entries.some((entry) => entry === null) || ids.size !== entries.length) {
      setAside('invalid');
      return [];
    }
    return entries;
  }

  /** Writes `entries` (at most 16, each checked) or removes the file for none; `{ ok }` or `{ ok: false, reason }`. */
  function save(entries) {
    if (held) return refused('team_unavailable');
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) return refused('team_model_offer_limit');
    const checked = entries.map((entry) => checkedEntry(entry));
    if (checked.some((entry) => entry === null)) return refused('model_manifest_invalid');
    try {
      if (checked.length === 0) {
        if (fs.existsSync(file)) removeFileSync(file);
      } else writeJson(file, { schema: SCHEMA, offers: checked });
      return { ok: true };
    } catch (error) {
      say('WARN', 'team.model.offers_file_write_failed', { code: typeof error?.code === 'string' ? error.code : 'none' });
      return refused('team_unavailable');
    }
  }

  return Object.freeze({ load, save });
}

// The member's outgoing model rate limit for one team, in whole MB/s (0 is none): its own small file beside the offers
// file, `model-sending.json` { schema: 1, mb_per_second }, written atomically; missing or broken reads as 0 (off).
const RATE_FILE_NAME = 'model-sending.json';

function createRateFile({ userDataPath, teamId, maxMb, log = () => {} }) {
  const file = path.join(path.dirname(clientFilePath(userDataPath, teamId)), RATE_FILE_NAME);
  return Object.freeze({
    load() {
      try {
        const value = readJson(file, { maxBytes: 256 });
        const mb = value?.mb_per_second;
        return value?.schema === SCHEMA && Number.isSafeInteger(mb) && mb >= 0 && mb <= maxMb ? mb : 0;
      } catch {
        return 0;
      }
    },
    save(mb) {
      try {
        if (mb === 0) { if (fs.existsSync(file)) removeFileSync(file); } else writeJson(file, { schema: SCHEMA, mb_per_second: mb });
        return true;
      } catch (error) {
        try { log('WARN', 'team.model.rate_file_write_failed', { team_id: teamId, code: typeof error?.code === 'string' ? error.code : 'none' }); } catch { /* best effort */ }
        return false;
      }
    },
  });
}

module.exports = { MAX_ENTRIES, OFFERS_FILE_NAME: FILE_NAME, createOffersFile, createRateFile, offersFilePath };
