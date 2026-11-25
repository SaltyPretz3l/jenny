'use strict';

// What a hosted team's whole-team operations leave when they stop part way (slice 5-6), and the one sweep that
// removes it. No Electron. The sweep runs when the host controller starts and before every deploy, delete, start
// of a new team and restore; it removes, each through the no-follow remover and each checked by real path to be
// inside its parent first:
// - `<userData>/team-host-restoring-<12 hex>/`: decrypted team data a restore wrote before a crash or a locked file;
// - `<userData>/team-host/.deleting-<12 hex>/`: what a delete moved aside and could not finish removing;
// - `<userData>/team-host/` itself when it holds no saved config, the secure store holds no host key, and it is
//   empty or carries the leftover mark: a delete that could not finish once committed (host-delete.js marks it
//   before it removes anything), or a restore whose move back failed (host-restore.js marks it before it undoes
//   anything). A folder with team data and no mark is a team whose key and config were lost, kept for the
//   lost-key page, never a leftover;
// - the export folder named in `<userData>/team-export-pending.json` (an export that stopped before it finished,
//   with the backup's temporary file inside it), checked to be inside the folder the owner picked.
// A committed delete writes `delete` into the mark (review round two, R09-F01): such a `team-host` is a delete
// that stopped after its point of no return (a quit, a crash, or a secure store that refused the key once). The
// sweep finishes it in the delete's own order, whatever else is there: this Jenny's membership of the team (its id
// derived from the stored key), the saved config, the host key and the relay token, and last the folder with its
// mark, which goes only once the key and the token are gone, so the mark stays the record of what is still owed.
// A link is never entered: a leftover that holds one stays, and so does a `team-host` that is itself a link or
// resolves outside the profile (every whole-team operation refuses that one: `teamHostRoot`). Nothing here logs.

const fs = require('node:fs');
const path = require('node:path');

const { writeJson } = require('../../host/durable-json');
const { deriveTeamId, keyPairFromSeed } = require('../../../server/team/ids');
const { isLinkPath, realInside, removeFileInside, removeTreeInsideAsync } = require('./host-files');

const HOST_DIR_NAME = 'team-host';
const RESTORING_PREFIX = 'team-host-restoring-';
const RESTORING = /^team-host-restoring-[a-f0-9]{12}$/u;
const STAGING = /^\.deleting-[a-f0-9]{12}$/u;
const CONFIG_FILE = 'host-config.json';
const PENDING_EXPORT = 'team-export-pending.json';
// Written into `team-host` by a committed delete and by a restore undoing itself: what is left is not a team.
const LEFTOVER_MARK = '.jenny-leftover';
// The mark's content when a delete wrote it (a restore's undo writes it empty).
const DELETE_WORD = 'delete';

/** `<userData>/team-host`: 'absent', 'link' (a link itself, or a real path outside the profile) or 'ok'. */
function teamHostRoot(userDataPath) {
  const root = path.join(userDataPath, HOST_DIR_NAME);
  try { fs.lstatSync(root); } catch (error) { return error?.code === 'ENOENT' ? 'absent' : 'link'; }
  if (isLinkPath(root) || !realInside(userDataPath, root)) return 'link';
  return 'ok';
}

const namesIn = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

// True when the secure store holds no host key (a store that cannot say counts as holding one: kept).
function noKey(keys) {
  let seed = null;
  try { seed = keys.load(); return seed === null; } catch { return false; } finally { seed?.fill(0); }
}

/** Marks `root` (a real `team-host`) as a leftover for the sweep. Answers whether the mark is there. */
function markLeftover(root) {
  try { fs.writeFileSync(path.join(root, LEFTOVER_MARK), '', { flag: 'wx' }); return true; } catch (error) {
    return error?.code === 'EEXIST';
  }
}

/**
 * Marks `root` (a real `team-host`) as a committed delete, over any earlier mark, synced to disk before it answers.
 * Answers whether it is written.
 */
function markDeleted(root) {
  const mark = path.join(root, LEFTOVER_MARK);
  if (isLinkPath(mark)) return false;
  let fd = null;
  let written = false;
  try {
    fd = fs.openSync(mark, 'w');
    fs.writeSync(fd, DELETE_WORD);
    fs.fsyncSync(fd);
    written = true;
  } catch { /* answered below */ }
  if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  // A mark half written must not stay: the caller puts the team back, and a start must not finish a delete of it.
  if (!written) { try { fs.unlinkSync(mark); } catch { /* none there, or held: the caller refuses the delete */ } }
  return written;
}

/** True when `root` carries a committed delete's mark (a plain file of at most 64 bytes holding the word). */
function deleteMarked(root) {
  const mark = path.join(root, LEFTOVER_MARK);
  try {
    const stat = fs.lstatSync(mark);
    return stat.isFile() && stat.size <= 64 && fs.readFileSync(mark, 'utf8').trim() === DELETE_WORD;
  } catch {
    return false;
  }
}

/** The team id of the stored host key, or null (no key, or a store that cannot say). The seed is zeroed. */
function teamIdOfKey(keys) {
  let seed = null;
  try {
    seed = keys.load();
    return seed ? deriveTeamId(keyPairFromSeed(seed).publicKey) : null;
  } catch {
    return null;
  } finally {
    seed?.fill(0);
  }
}

/**
 * The rest of a committed delete, after its point of no return (the delete's own steps, and the sweep's for one
 * that stopped, R09-F01): this Jenny's membership of `teamId` (else the stored key's team), the saved config, the
 * host key, the relay token, and last `team-host` with its mark, only once the key and the token are gone.
 * Answers the parts still there: `membership`, `config`, `key`, `token`, `files`.
 */
async function finishDelete(userDataPath, { keys, tokens = null, forgetMembership = null, teamId = null }) {
  const root = path.join(userDataPath, HOST_DIR_NAME);
  const left = [];
  const id = teamId || teamIdOfKey(keys);
  if (id && typeof forgetMembership === 'function') {
    try {
      const forgotten = await forgetMembership(id);
      if (forgotten && forgotten.ok === false && forgotten.error?.reason !== 'team_not_found') left.push('membership');
    } catch { left.push('membership'); }
  }
  if (!removeFileInside(root, path.join(root, CONFIG_FILE))) left.push('config');
  for (const [part, store] of [['key', keys], ['token', tokens]]) {
    try { store?.remove(); } catch { left.push(part); }
  }
  if (!left.includes('key') && !left.includes('token') && !(await removeTreeInsideAsync(userDataPath, root)).ok) left.push('files');
  return left;
}

/** Records the export folder being written, so a sweep can remove it if the export never finishes. */
function notePendingExport(userDataPath, { parent, folder }) {
  writeJson(path.join(userDataPath, PENDING_EXPORT), { schema_version: 1, parent, folder });
}

/** The export finished, or its folder was removed: the record goes. */
function clearPendingExport(userDataPath) {
  removeFileInside(userDataPath, path.join(userDataPath, PENDING_EXPORT));
}

async function sweepPendingExport(userDataPath) {
  const file = path.join(userDataPath, PENDING_EXPORT);
  let record;
  try {
    if (fs.lstatSync(file).size > 64 * 1024) return false;
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  const { parent, folder } = record || {};
  // `folder === parent` is a drive root or `/` (its own dirname): never a folder an export made, and never removed.
  if (typeof parent !== 'string' || typeof folder !== 'string' || folder === parent || path.dirname(folder) !== parent) {
    clearPendingExport(userDataPath);
    return true;
  }
  const removed = await removeTreeInsideAsync(parent, folder);
  if (removed.ok || removed.reason === 'outside') clearPendingExport(userDataPath);
  return removed.ok;
}

/**
 * Removes every leftover named above. `keys`: the host key store (`load()`, `remove()`), to tell a leftover
 * `team-host` from a keyless team; `tokens`: the relay token store and `forgetMembership(teamId)`, for a committed
 * delete. Answers { left }: how many leftovers are still there (a link inside, a held file, a store that refused).
 */
async function sweepLeftovers(userDataPath, { keys, tokens = null, forgetMembership = null }) {
  let left = 0;
  const gone = async (parent, target) => {
    if (!(await removeTreeInsideAsync(parent, target)).ok) left += 1;
  };
  for (const name of namesIn(userDataPath)) {
    if (RESTORING.test(name)) await gone(userDataPath, path.join(userDataPath, name));
  }
  if (teamHostRoot(userDataPath) === 'ok') {
    const root = path.join(userDataPath, HOST_DIR_NAME);
    for (const name of namesIn(root)) {
      if (STAGING.test(name)) await gone(root, path.join(root, name));
    }
    const configThere = (() => { try { fs.lstatSync(path.join(root, CONFIG_FILE)); return true; } catch { return false; } })();
    const rest = namesIn(root).filter((name) => !STAGING.test(name));
    const leftover = rest.length === 0 || rest.includes(LEFTOVER_MARK);
    if (deleteMarked(root)) left += (await finishDelete(userDataPath, { keys, tokens, forgetMembership })).length;
    else if (!configThere && leftover && noKey(keys)) await gone(userDataPath, root);
  }
  if (!(await sweepPendingExport(userDataPath))) left += 1;
  return { left };
}

module.exports = {
  HOST_DIR_NAME, LEFTOVER_MARK, RESTORING_PREFIX, STAGING, clearPendingExport, deleteMarked, finishDelete, markDeleted, markLeftover,
  notePendingExport, sweepLeftovers, teamHostRoot, teamIdOfKey,
};
