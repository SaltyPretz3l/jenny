'use strict';

// The model receiver's accept checks and folder rules (row 123 slice 6-4,
// TEAM_MODEL_SHARING_SPEC "The receiver" step 1, MN1, MI5, T13). Pure checks
// on the offer, then the folder rules every write passes: the chosen root is
// one of the member's model roots compared by real path and is itself a real
// directory at its own real path; `.jenny-incoming`, the staging folder and
// the family folder are each a real directory at its own real path, made
// without `recursive` so a planted link is never followed into.
//
// No answer here carries a path, a name, a hash or provenance text.

const fs = require('node:fs');
const path = require('node:path');

const { ownDirectory, removeHolder, samePath } = require('../../server/team/file-checks');
const { ID_PATTERNS } = require('../../server/team/ids');
const { isCleanText, isPlainObject } = require('../../server/team/member-schema');
const { MODEL_TRANSFER_LIMITS, PROVENANCE_SUFFIX, mainModelName, validateModelManifest } = require('../../server/team/model-manifest');
const { validateSegment } = require('../../server/team/path-segments');
const { companionFiles, safeFolderName } = require('../gguf-place');

const OFFER_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const PROVENANCE_SCHEMA = 1;
// The family folder and its siblings `-2` to `-16` (the folder rule below).
const MAX_RECEIVE_FOLDERS = 16;
// A fixed-width stand-in for `received_at`, so the size is known at accept.
const RECEIVED_AT_WIDTH = new Date(0).toISOString();
// A read failure that may pass (the file is not known to be bad): the one rule `server/team/bounded-log.js` draws
// (E46), used as it is (review sweeps X4b-F05).
const { isPassingReadError } = require('../../server/team/bounded-log');

/**
 * Re-checks an offer on this side: the ids, the sender's name, the manifest
 * (MN1 to MN5 again) and the names re-classified by Move and add's family
 * rule, which must give the main model exactly the other files offered (what
 * discovery will pair once they sit in one folder). `{ ok, offer, main }` or
 * `{ ok: false }`. `validate` is the manifest validator (a seam for tests that
 * shrink the segment size; production passes the 6-1 module's).
 */
function checkOffer(offer, validate = validateModelManifest) {
  if (!isPlainObject(offer) || !isPlainObject(offer.sender)) return { ok: false };
  const { offerId, teamId, sender } = offer;
  if (typeof offerId !== 'string' || !OFFER_ID.test(offerId)) return { ok: false };
  if (typeof teamId !== 'string' || !ID_PATTERNS.team.test(teamId)) return { ok: false };
  if (typeof sender.memberId !== 'string' || !ID_PATTERNS.member.test(sender.memberId)) return { ok: false };
  if (!isCleanText(sender.displayName, MODEL_TRANSFER_LIMITS.maxDisplayNameChars)) return { ok: false };
  const checked = validate(offer.manifest);
  if (!checked.ok) return { ok: false };
  const main = mainModelName(checked.manifest);
  const names = checked.manifest.files.map((file) => file.name);
  const others = names.filter((name) => name !== main).sort();
  if (JSON.stringify(companionFiles('', main, names)) !== JSON.stringify(others)) return { ok: false };
  return {
    ok: true,
    main,
    offer: Object.freeze({
      offerId, teamId, sender: Object.freeze({ memberId: sender.memberId, displayName: sender.displayName }),
      manifest: checked.manifest,
    }),
  };
}

/** The family folder from Move and add's rule, or '' when the result fails the segment rules (`CON-Q4_K_M` gives `CON`). */
function familyFolderFor(main) {
  const name = safeFolderName(main);
  return validateSegment(name).ok && !name.startsWith('.') ? name : '';
}

/**
 * The folder rule (review round two, R14-F01): a received set never shares a folder with models it did not arrive
 * with, because discovery pairs a projector or drafter by listing the model's folder. The folders a set may go into,
 * in order: the family folder, then `<family>-2` to `<family>-16`, each passing the segment rules. Empty when the
 * family folder itself fails them.
 */
function receiveFolders(main) {
  const family = familyFolderFor(main);
  if (!family) return [];
  const names = [family];
  for (let n = 2; n <= MAX_RECEIVE_FOLDERS; n += 1) if (validateSegment(`${family}-${n}`).ok) names.push(`${family}-${n}`);
  return names;
}

/** True when `folder` is one of the folders the rule allows for this main model (a journal's folder is checked so). */
const isReceiveFolder = (folder, main) => typeof folder === 'string' && receiveFolders(main).includes(folder);

// An empty regular file with one link at a candidate's name is the holder a Windows `renameNoReplace` makes and a cut
// or a failed removal can leave (review sweeps X4b-F06): it holds nothing, so it is removed while it is still that
// empty file. True when the name is free afterwards.
function removedHolder(folder, fsImpl) {
  let stat;
  try {
    stat = fsImpl.lstatSync(folder, { bigint: true });
  } catch (_error) {
    return false;
  }
  if (!stat.isFile() || stat.size !== 0n || stat.nlink !== 1n) return false;
  return removeHolder({ file: folder, dev: stat.dev, ino: stat.ino }) && !present(folder, fsImpl);
}

/**
 * The folder a new set goes into under `realRoot`: `{ folder }`, the first one with nothing at its name (or only a
 * holder left there, removed first), or `{ refused }`. A candidate that is there but is not a real directory at its
 * own real path (a link, a junction, a file with bytes) is `model_destination_invalid`; sixteen taken folders are
 * `model_exists`.
 */
function pickReceiveFolder(realRoot, main, fsImpl = fs) {
  const names = receiveFolders(main);
  if (names.length === 0) return { refused: 'model_destination_invalid' };
  for (const name of names) {
    const folder = path.join(realRoot, name);
    if (!present(folder, fsImpl) || removedHolder(folder, fsImpl)) return { folder: name };
    if (!ownFolder(folder)) return { refused: 'model_destination_invalid' };
  }
  return { refused: 'model_exists' };
}

/** True when a folder the rule allows already holds one of the names this set places (the same model is there). */
const placedAnywhere = (realRoot, manifest, main, fsImpl = fs) => receiveFolders(main)
  .some((name) => placedNames(manifest, main).some((file) => present(path.join(realRoot, name, file), fsImpl)));

const realOf = (folder) => {
  try {
    return fs.realpathSync.native(folder);
  } catch (_error) {
    return '';
  }
};

/** The chosen root's real path when it is one of `roots` by real path and a real directory at its own path; else ''. */
function resolveRoot(chosen, roots) {
  if (typeof chosen !== 'string' || !path.isAbsolute(chosen) || !ownDirectory(chosen)) return '';
  const real = realOf(chosen);
  if (!real) return '';
  let listed = [];
  try {
    listed = roots() || [];
  } catch (_error) { /* no roots: nothing is allowed */ }
  const known = (Array.isArray(listed) ? listed : []).filter((root) => typeof root === 'string' && path.isAbsolute(root));
  return known.some((root) => samePath(realOf(root), real)) ? real : '';
}

/**
 * A folder that must be a real directory at its own real path. `create` makes
 * it when absent with a plain (never recursive) `mkdir`. Answers true when it
 * holds, false on a link, a junction, a file or any doubt.
 */
function ownFolder(folder, { create = false, fsImpl = fs } = {}) {
  if (ownDirectory(folder)) return true;
  if (!create) return false;
  try {
    fsImpl.lstatSync(folder);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  try {
    fsImpl.mkdirSync(folder);
  } catch (_error) {
    return false;
  }
  return Boolean(ownDirectory(folder));
}

/** Free bytes on the volume of `folder`, or null when the platform cannot say. */
function freeBytesOf(folder, fsImpl = fs) {
  try {
    const space = fsImpl.statfsSync(folder);
    return Number(space.bavail) * Number(space.bsize);
  } catch (_error) {
    return null;
  }
}

/**
 * The `lstat` of a regular file with one link (and `size` when given), else
 * null. A staged or placed file must pass this before it is moved or trusted.
 */
function regularFile(file, { size = null, fsImpl = fs } = {}) {
  try {
    const stat = fsImpl.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (size !== null && stat.size !== BigInt(size))) return null;
    return stat;
  } catch (_error) {
    return null;
  }
}

/** True when something (anything, a link included) sits at the name. */
function present(file, fsImpl = fs) {
  try {
    fsImpl.lstatSync(file);
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

/** The names a placement writes into the family folder: every file and the provenance file. */
const placedNames = (manifest, main) => [...manifest.files.map((file) => file.name), `${main}${PROVENANCE_SUFFIX}`];

/** The provenance file, exact keys: who sent it, when, the team, the folder it went into, the sender's words, the digests. */
function provenanceDoc({ offer, receivedAt, folder }) {
  const { manifest } = offer;
  return {
    schema: PROVENANCE_SCHEMA,
    display_name: manifest.display_name,
    sender: { member_id: offer.sender.memberId, display_name: offer.sender.displayName },
    team_id: offer.teamId,
    folder,
    received_at: receivedAt,
    provenance: {
      licence: manifest.provenance.licence,
      source_url: manifest.provenance.source_url,
      note: manifest.provenance.note,
      checked: false,
    },
    files: manifest.files.map((file) => ({ name: file.name, size: file.size, sha256: file.sha256 })),
  };
}

// The size is known at accept: a fixed-width time and the longest folder the rule allows.
const provenanceBytes = (offer, receivedAt = RECEIVED_AT_WIDTH) => Buffer.byteLength(
  JSON.stringify(provenanceDoc({ offer, receivedAt, folder: receiveFolders(mainModelName(offer.manifest)).at(-1) || '' })), 'utf8',
);

module.exports = {
  OFFER_ID, checkOffer, familyFolderFor, freeBytesOf, isPassingReadError, isReceiveFolder, ownFolder, pickReceiveFolder,
  placedAnywhere, placedNames, present, provenanceBytes, provenanceDoc, regularFile, resolveRoot,
};
