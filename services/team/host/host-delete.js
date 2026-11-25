'use strict';

// Deleting a hosted team (slice 5-6, decision E61) and setting one aside after a lost key (E48's "Start a new
// team"), from the files under `<userData>/team-host/`. No Electron, so a command line can call it later (the
// headless commands are slice 3-11's).
//
// Delete, in this order (the picks file's step 14, as fixed after review): before the caller tells anyone,
// `checkDeletable` refuses a `team-host` that is a link or resolves outside the profile and walks the whole tree
// once, refusing a link anywhere with nothing touched. After the server has stopped (row 201, OD-6: nothing is broadcast while
// a file lock could still roll the delete back; members see the team go offline), `removeTeamFiles` moves the project folders, the trash, the profile (stores and audit logs), the
// runtime, the logs and the secrets into one staging folder inside `team-host`. A move that fails puts every
// earlier one back: nothing is removed and the team still starts (`team_delete_file_held`). Once every move has
// succeeded the delete is committed and `team-host` carries the delete's mark: the staging folder is removed
// (asynchronously; a part that cannot be removed is left for the next sweep, host-sweep.js, and reported), then the
// caller finishes the delete (host-sweep.js `finishDelete`: this Jenny's own membership, the saved config, the host
// key and the host relay token, each reported if it could not be removed, and last the marked folder). A delete
// that stops anywhere after the mark is finished by the next sweep (review round two, R09-F01).
//
// Set aside: `team-host` is renamed, whole, to `team-host-old-<17 UTC digits>` beside it, after writing
// `set-aside.json` into it (the team's name and id, the time, its project count and bytes, so the old team's row
// needs no walk). An old team is deleted by removing that folder (the same link refusal), and shown by opening
// its `projects` folder. Nothing here logs a path or a name.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { writeJson } = require('../../host/durable-json');
const {
  isLinkPath, realInside, removeFileInside, removeTreeInside, removeTreeInsideAsync, renameInside, walkTreeAsync,
} = require('./host-files');
const { HOST_DIR_NAME, markDeleted, teamHostRoot } = require('./host-sweep');

const OLD_PREFIX = 'team-host-old-';
const OLD_NAME = /^team-host-old-(\d{17})$/u;
const SET_ASIDE_FILE = 'set-aside.json';
const MOVED_DIRS = ['trash', 'profile', 'runtime', 'logs', 'secrets'];
const PROJECT_ID = /^project_[A-Za-z0-9_-]{1,64}$/u;

const stampOf = (ms) => new Date(ms).toISOString().replace(/\D/gu, '').slice(0, 17);

const projectOfPath = (rel) => {
  const parts = String(rel).split(/[\\/]/u);
  return parts[0] === 'projects' && PROJECT_ID.test(parts[1] || '') ? parts[1] : null;
};

/**
 * Everything that can refuse a delete, before anyone is told: { ok: true } or { ok: false, reason, project_id? }.
 * `team_delete_link`: `team-host` is a link or resolves outside the profile, or a link is anywhere inside it.
 */
async function checkDeletable(userDataPath) {
  const state = teamHostRoot(userDataPath);
  if (state === 'absent') return { ok: true };
  if (state === 'link') return { ok: false, reason: 'team_delete_link', project_id: null };
  const walked = await walkTreeAsync(path.join(userDataPath, HOST_DIR_NAME));
  if (walked.links) return { ok: false, reason: 'team_delete_link', project_id: projectOfPath(walked.linkPaths[0] || '') };
  return { ok: true };
}

// The parts of the team to move, relative to `team-host`: each project folder, then MOVED_DIRS.
function partsOf(root) {
  const parts = [];
  try {
    for (const id of fs.readdirSync(path.join(root, 'projects'))) parts.push(path.join('projects', id));
  } catch { /* no projects folder */ }
  return [...parts, ...MOVED_DIRS];
}

/**
 * Moves every part of the team into a staging folder and removes it; the caller ran checkDeletable first.
 * Answers { ok: true, leftover } (committed; `leftover` when the staging folder could not be fully removed) or
 * { ok: false, reason, project_id? } with nothing removed: `team_delete_link` (`team-host` became a link),
 * `team_delete_file_held` (a move failed; what moved was put back). `ops`: the fs calls (a test seam).
 */
async function removeTeamFiles(userDataPath, { ops = fs, randomBytes = crypto.randomBytes } = {}) {
  const state = teamHostRoot(userDataPath);
  if (state === 'absent') return { ok: true, leftover: false };
  if (state === 'link') return { ok: false, reason: 'team_delete_link', project_id: null };
  const root = path.join(userDataPath, HOST_DIR_NAME);
  const staging = path.join(root, `.deleting-${randomBytes(6).toString('hex')}`);
  try { fs.mkdirSync(staging); } catch { return { ok: false, reason: 'team_delete_file_held', project_id: null }; }
  const moved = [];
  let index = 0;
  for (const rel of partsOf(root)) {
    const from = path.join(root, rel);
    try { fs.lstatSync(from); } catch { continue; }
    const to = path.join(staging, String(index));
    index += 1;
    if (!renameInside(root, from, to, { ops })) {
      // Not committed yet: nothing has been removed, so everything goes back and the team still starts.
      for (const [back, there] of moved.reverse()) renameInside(root, there, back, { ops });
      removeTreeInside(root, staging, { ops });
      return { ok: false, reason: 'team_delete_file_held', project_id: projectOfPath(rel) };
    }
    moved.push([from, to]);
  }
  // Committed: from here the delete goes on to the end, and what cannot be removed now is swept later (the mark
  // tells the sweep that what stays in `team-host` is a delete to finish, not a team whose key was lost).
  if (!markDeleted(root)) {
    // No mark, no commit: a delete that stopped later could not be told from a team whose key was lost.
    for (const [back, there] of moved.reverse()) renameInside(root, there, back, { ops });
    removeTreeInside(root, staging, { ops });
    return { ok: false, reason: 'team_delete_file_held', project_id: null };
  }
  const removed = await removeTreeInsideAsync(root, staging, { ops, scanned: true });
  return { ok: true, leftover: !removed.ok };
}

/**
 * Renames `team-host` to `team-host-old-<stamp>` beside it, with `set-aside.json` written first.
 * `facts`: { team_name, team_id, projects, bytes }. Answers { ok, id } or { ok: false, reason }.
 */
function setAsideTeam(userDataPath, facts, { now = Date.now(), ops = fs } = {}) {
  const root = path.join(userDataPath, HOST_DIR_NAME);
  if (teamHostRoot(userDataPath) !== 'ok') return { ok: false, reason: 'team_set_aside_failed' };
  let stamp = stampOf(now);
  while (fs.existsSync(path.join(userDataPath, OLD_PREFIX + stamp))) stamp = String(BigInt(stamp) + 1n).padStart(17, '0');
  const record = path.join(root, SET_ASIDE_FILE);
  try {
    writeJson(record, { schema_version: 1, team_name: facts.team_name ?? null, team_id: facts.team_id ?? null,
      set_aside_at: now, projects: facts.projects ?? 0, bytes: facts.bytes ?? 0 });
  } catch {
    return { ok: false, reason: 'team_set_aside_failed' };
  }
  if (!renameInside(userDataPath, root, path.join(userDataPath, OLD_PREFIX + stamp), { ops })) {
    removeFileInside(root, record, { ops });
    return { ok: false, reason: 'team_set_aside_failed' };
  }
  return { ok: true, id: stamp };
}

/** Puts a team set aside a moment ago back as `team-host` (a restore that failed after setting it aside). */
function unsetAside(userDataPath, id) {
  const from = path.join(userDataPath, OLD_PREFIX + id);
  const root = path.join(userDataPath, HOST_DIR_NAME);
  if (!renameInside(userDataPath, from, root)) return false;
  removeFileInside(root, path.join(root, SET_ASIDE_FILE));
  return true;
}

// The folder of old team `id`, checked: a real folder inside userData, not a link; else null.
function oldFolder(userDataPath, id) {
  if (typeof id !== 'string' || !/^\d{17}$/u.test(id)) return null;
  const folder = path.join(userDataPath, OLD_PREFIX + id);
  if (isLinkPath(folder)) return null;
  return realInside(userDataPath, folder);
}

/** The teams set aside on this PC, newest first: [{ id, team_name, set_aside_at, projects, bytes }]. */
function listOldTeams(userDataPath) {
  let names;
  try { names = fs.readdirSync(userDataPath); } catch { return []; }
  const teams = [];
  for (const name of names) {
    const match = OLD_NAME.exec(name);
    if (!match || !oldFolder(userDataPath, match[1])) continue;
    let facts = {};
    try {
      const raw = fs.readFileSync(path.join(userDataPath, name, SET_ASIDE_FILE), 'utf8');
      facts = raw.length <= 4096 ? JSON.parse(raw) : {};
    } catch { /* an old team whose record is missing still shows, by its date */ }
    teams.push({ id: match[1], team_name: typeof facts.team_name === 'string' ? facts.team_name : null,
      set_aside_at: Number.isSafeInteger(facts.set_aside_at) ? facts.set_aside_at : null,
      projects: Number.isSafeInteger(facts.projects) ? facts.projects : null,
      bytes: Number.isSafeInteger(facts.bytes) ? facts.bytes : null });
  }
  return teams.sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** Removes old team `id`: { ok: true } or { ok: false, reason }. A link inside refuses with nothing removed. */
async function removeOldTeam(userDataPath, id, { ops = fs } = {}) {
  const folder = oldFolder(userDataPath, id);
  if (!folder) return { ok: false, reason: 'team_old_not_found' };
  const removed = await removeTreeInsideAsync(userDataPath, folder, { ops });
  if (removed.ok) return { ok: true };
  return { ok: false, reason: removed.reason === 'link' ? 'team_delete_link' : 'team_delete_file_held' };
}

/** The `projects` folder of old team `id` to open in the file manager, or null. */
function oldProjectsFolder(userDataPath, id) {
  const folder = oldFolder(userDataPath, id);
  return folder ? realInside(folder, path.join(folder, 'projects')) : null;
}

module.exports = {
  HOST_DIR_NAME, checkDeletable, listOldTeams, oldFolder, oldProjectsFolder, removeOldTeam, removeTeamFiles, setAsideTeam,
  unsetAside,
};
