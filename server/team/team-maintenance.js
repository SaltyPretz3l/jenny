'use strict';

// What the four headless maintenance commands share (slices 3-13 and 3-14): `team-copy-in`, `team-export`,
// `team-restore` and `team-delete`, each run in the setup container with the team server stopped. Shell access
// to the stopped host is the owner, as for `team-init` and `team-recover`: no authorization function runs.
//
// - The config is a team block with `key_source: 'secret_file'`, loaded before and again after the profile lock
//   (`lockProfile`, host-core.js `acquireConfiguredProfile`'s steps). A running team server holds the lock: `team_profile_locked`.
// - The team lives on three volumes whose roots are mount points, never renamed or removed: the profile
//   (`user_data_path`), the data volume (the parent of `team.projects_root`, holding `projects/` and `trash/`)
//   and the secrets (`secrets_dir`, holding `team-host-key`). The two setup-only mounts are `team.import_dir`
//   (read only, copy-in's source) and `team.exchange_dir` (export and restore files), each a real directory at
//   its own real path or the command refuses.
// - `removeTeamData` removes the team's data from the three volumes and keeps the volume roots, the projects
//   root itself, the profile's lock file and owner marker (`profile-owner.json`, `.host.lock`) and the two
//   markers below; the caller removes the key file and the marker last. A link anywhere refuses the whole
//   removal before anything goes (`findLinks`).
// - `rootsReason`: before anything is read or a marker written, the profile, the data volume and the projects
//   root are each a real directory at its own real path; a missing one refuses (`team_projects_root_missing`) and
//   a link refuses with the command's own link word, so nothing is listed or removed through a link.
// - Markers in the profile (maintenance-markers.js): `.jenny-team-deleting` (a delete committed and not yet
//   finished; it holds the name the next delete asks for) and `.jenny-team-restoring` (a restore began moving
//   data into place; the next restore clears the partial team and starts again). `team-keygen` refuses on either,
//   and `team-keygen`, `team-init` and `team-recover` refuse beside a cut restore's staging (`unfinishedWork`).
// - A root that cannot be listed is never read as empty: a command that would remove refuses before anything goes.
// Results are `{ ok }` or `{ ok: false, reason }` with a closed word; nothing here prints or logs a path, a name,
// a key or a password.

const fs = require('node:fs');
const path = require('node:path');

const { loadHostConfig } = require('../config');
const { FileSecretStore, TEAM_HOST_SECRET_FILES } = require('../file-secret-store');
const { HOST_ERROR_CODES } = require('../../services/backend/error-codes');
const { acquireProfileAsync } = require('../../services/host/profile-ownership');
const { removeTreeInsideAsync, walkTreeAsync } = require('../../services/team/host/host-files');
const { ownDirectory } = require('./file-checks');
const { PUBLIC_KEY_BYTES, decodeBase64url } = require('./ids');
const { loadSecretFileTeamConfig, syncDirectory } = require('./keygen');
const { DELETE_MARKER, RESTORE_MARKER, unfinishedReason } = require('./maintenance-markers');
const { MEMBERS_FILE } = require('./member-store');
const { safeLogger } = require('./safe-logger');

const DEFAULT_IMPORT_DIR = '/mnt/jenny-import';
const DEFAULT_EXCHANGE_DIR = '/mnt/jenny-exchange';
const STAGING_PREFIX = '.jenny-restoring-';
const STAGING = /^\.jenny-restoring-[a-f0-9]{12}$/u;
// The profile's own ownership files: the lock is held while this runs and the marker says whose profile it is.
const KEPT_IN_PROFILE = new Set(['.host.lock', 'profile-owner.json', DELETE_MARKER, RESTORE_MARKER]);
const OWNER_TEMP = /^\.profile-owner-[a-f0-9]{32}\.tmp$/u;
// host-core.js's default interpreter for the Linux profile lock (the image's venv).
const DEFAULT_PYTHON = '/opt/jenny-venv/bin/python';

function refusal(reason) {
  return { ok: false, reason };
}

// Only a busy lock reads as locked; an ownership refusal or any other failure is unavailable.
function lockReason(error) {
  return error?.code === HOST_ERROR_CODES.CONFLICT && error.reason === 'profile_locked'
    ? 'team_profile_locked' : 'team_unavailable';
}

/** The team's places on this host. `data` and `trash` are null on a host with no projects root. */
function teamRoots(config) {
  const projects = config.team?.projectsRoot ?? null;
  const data = projects ? path.dirname(projects) : null;
  return {
    profile: config.userDataPath, projects, data, trash: data ? path.join(data, 'trash') : null,
    secrets: config.secretsDir, keyFile: path.join(config.secretsDir, TEAM_HOST_SECRET_FILES.team_host_key),
  };
}

/** A setup-only mount when it is a real directory at its own real path, else null. */
function mountRoot(config, which) {
  const named = which === 'import' ? config.team?.importDir ?? DEFAULT_IMPORT_DIR
    : config.team?.exchangeDir ?? DEFAULT_EXCHANGE_DIR;
  return ownDirectory(named) ? named : null;
}

const exists = (file) => {
  try { fs.lstatSync(file); return true; } catch (error) { return error?.code !== 'ENOENT'; }
};
/** The names in `dir`: [] when it is absent (or not given), null when it cannot be listed. */
const namesIn = (dir) => {
  if (!dir) return [];
  try { return fs.readdirSync(dir); } catch (error) { return error?.code === 'ENOENT' ? [] : null; }
};

/** The host key as the team host reads it (32 bytes), or null. The caller zeroes it. */
function readHostSeed(config) {
  try {
    return decodeBase64url(new FileSecretStore({ directory: config.secretsDir, files: TEAM_HOST_SECRET_FILES })
      .get('team_host_key'), PUBLIC_KEY_BYTES);
  } catch {
    return null;
  }
}

// The restore staging folders in `dir`: [] when it is absent, null when it cannot be listed.
const stagingIn = (dir) => namesIn(dir)?.filter((name) => STAGING.test(name)) ?? null;

/**
 * What of a team this host holds; `unreadable` when a listing failed (counts as a team: fail closed; a command
 * that would remove refuses on it, review sweep X4c-F01); `staging` when a cut restore left its staging folders.
 */
function teamState(roots) {
  const projects = namesIn(roots.projects);
  const trash = namesIn(roots.trash);
  const profile = namesIn(roots.profile);
  const staged = [profile?.filter((name) => STAGING.test(name)) ?? null, stagingIn(roots.data)];
  return {
    key: exists(roots.keyFile),
    store: exists(path.join(roots.profile, MEMBERS_FILE)),
    projects: projects?.length ?? 0,
    trash: trash?.length ?? 0,
    deleting: exists(path.join(roots.profile, DELETE_MARKER)),
    restoring: exists(path.join(roots.profile, RESTORE_MARKER)),
    staging: staged.some((names) => names?.length > 0),
    unreadable: projects === null || trash === null || profile === null || staged.includes(null),
  };
}

/**
 * Why `team-init`, `team-recover` and `team-keygen` must not go on (review sweep X4c-F03, F05): the start's word
 * for a delete or restore marker, then `team_restore_unfinished` while a cut restore's staging (decrypted team
 * data) is in the profile or the data volume (`team-restore` clears it, `team-delete` removes it), or
 * `team_unavailable` when either cannot be listed. null when nothing is half done. Staging beside a member store
 * is a leftover of a restore that placed its team (a folder that would not go), not a cut one: it never blocks
 * the owner's `team-recover` (review pass, 2026-11-14); the next `team-restore` run still clears it.
 */
function unfinishedWork(config) {
  const marked = unfinishedReason(config.userDataPath);
  if (marked) return marked;
  const roots = teamRoots(config);
  if (exists(path.join(roots.profile, MEMBERS_FILE))) return null;
  const staged = [stagingIn(roots.profile), stagingIn(roots.data)];
  if (staged.includes(null)) return 'team_unavailable';
  return staged.some((names) => names.length > 0) ? 'team_restore_unfinished' : null;
}

/** `unfinishedWork` for `team-keygen` before it runs: null when the config does not load (keygen refuses it). */
function keygenRefusal(configPath) {
  const loaded = loadSecretFileTeamConfig(configPath);
  const reason = loaded.ok ? unfinishedWork(loaded.config) : null;
  return reason ? refusal(reason) : null;
}

// null when the profile, the data volume and the projects root (each when configured) are real directories at
// their own real paths; else `team_projects_root_missing` for a missing one or `linkReason` for anything else.
function rootsReason(roots, linkReason) {
  for (const dir of [roots.profile, roots.data, roots.projects]) {
    if (!dir || ownDirectory(dir)) continue;
    let stat = null;
    try { stat = fs.lstatSync(dir); } catch { /* missing */ }
    return stat === null ? 'team_projects_root_missing' : linkReason;
  }
  return null;
}

const hasTeam = (state) => state.key || state.store || state.projects > 0 || state.trash > 0 || state.unreadable;

// The profile entries that are team data (everything but the kept names and owner temp files); null when the
// profile cannot be listed (never "no stores": X4c-F01).
const profileParts = (roots) => namesIn(roots.profile)
  ?.filter((name) => !KEPT_IN_PROFILE.has(name) && !OWNER_TEMP.test(name)) ?? null;

// The entries `findLinks` and `removeTeamData` go through, or null when a root cannot be listed.
function teamEntries(roots) {
  const lists = { profile: profileParts(roots), projects: namesIn(roots.projects), staging: stagingIn(roots.data) };
  return Object.values(lists).includes(null) ? null : lists;
}

/**
 * The count of links (a symlink, a junction) anywhere in the team's data and at the key file; null when a root
 * cannot be listed (the caller refuses: what it holds was not checked).
 */
async function findLinks(roots) {
  const lists = teamEntries(roots);
  if (!lists) return null;
  let links = 0;
  const scan = async (dir) => {
    let stat;
    try { stat = fs.lstatSync(dir); } catch { return; }
    if (stat.isSymbolicLink()) { links += 1; return; }
    if (stat.isDirectory()) links += (await walkTreeAsync(dir)).links;
  };
  for (const name of lists.profile) await scan(path.join(roots.profile, name));
  for (const name of lists.projects) await scan(path.join(roots.projects, name));
  for (const name of lists.staging) await scan(path.join(roots.data, name));
  if (roots.trash) await scan(roots.trash);
  try { if (fs.lstatSync(roots.keyFile).isSymbolicLink()) links += 1; } catch { /* absent */ }
  return links;
}

// Each removal is checked by real path to stay inside its volume root (removeTreeInsideAsync); a link anywhere
// in the data was refused before (findLinks) and the roots themselves are checked by `rootsReason`.
async function removeInside(root, target) {
  return (await removeTreeInsideAsync(root, target, { scanned: true })).ok;
}

/**
 * Removes restore staging folders a cut restore left in the profile and the data volume; true when all went
 * (false when either cannot be listed).
 */
async function removeStaging(roots) {
  const data = stagingIn(roots.data);
  const profile = stagingIn(roots.profile);
  if (data === null || profile === null) return false;
  let ok = true;
  for (const name of data) ok = (await removeInside(roots.data, path.join(roots.data, name))) && ok;
  for (const name of profile) ok = (await removeInside(roots.profile, path.join(roots.profile, name))) && ok;
  return ok;
}

/**
 * Removes the team's data: every project folder (the projects root stays), the trash, restore staging folders,
 * and the profile's stores (the lock, the owner marker and the two markers stay). Not the key file. Answers
 * `{ ok }` or `{ ok: false, reason: 'team_delete_failed' }` (what could not go stays for a re-run); a root that
 * cannot be listed refuses before anything goes. `cut(step)`: a test seam called after each step ('projects',
 * 'trash', 'profile').
 */
async function removeTeamData(roots, { cut = () => {} } = {}) {
  const lists = teamEntries(roots);
  if (!lists) return refusal('team_delete_failed');
  let ok = true;
  for (const name of lists.projects) ok = (await removeInside(roots.projects, path.join(roots.projects, name))) && ok;
  cut('projects');
  if (roots.trash) ok = (await removeInside(roots.data, roots.trash)) && ok;
  ok = (await removeStaging(roots)) && ok;
  cut('trash');
  const parts = profileParts(roots);
  if (parts === null) return refusal('team_delete_failed');
  for (const name of parts) ok = (await removeInside(roots.profile, path.join(roots.profile, name))) && ok;
  cut('profile');
  return ok ? { ok: true } : refusal('team_delete_failed');
}

/**
 * Writes a marker file into the profile, whole and synced, then syncs the profile folder (review sweep X4c-F02,
 * the desktop `markDeleted`'s steps): exclusive, and one already there is fine. Answers null when it is there;
 * `failed` when it is not (a marker this call created and could not write is removed again, so a refused command
 * leaves no marker the start would honour); `left` when that half-written marker could not be removed either.
 */
function writeMarker(roots, name, text = '') {
  const file = path.join(roots.profile, name);
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); } catch (error) { return error?.code === 'EEXIST' ? null : 'failed'; }
  let written = false;
  try {
    const bytes = Buffer.from(text, 'utf8');
    for (let at = 0; at < bytes.length;) at += fs.writeSync(fd, bytes, at, bytes.length - at);
    fs.fsyncSync(fd);
    written = true;
  } catch { /* removed below */ }
  try { fs.closeSync(fd); } catch { written = false; }
  if (written) {
    syncDirectory(fs, roots.profile);
    return null;
  }
  // This call created the file (exclusive create), so removing it removes only its own partial write.
  try { fs.unlinkSync(file); return 'failed'; } catch (error) { return error?.code === 'ENOENT' ? 'failed' : 'left'; }
}

function removeMarker(roots, name) {
  try { fs.unlinkSync(path.join(roots.profile, name)); return true; } catch (error) { return error?.code === 'ENOENT'; }
}

// host-core.js `acquireConfiguredProfile` + `assertProfileMode` for a team config, kept here because requiring
// host-core loads the hosted composition and with it the secure store module, which these setup commands must not
// load. Same steps: the config, the profile lock, the config again (a changed profile refuses), and a team
// profile refuses a single-owner profile's `auth.json`. The one difference: no `onLost` (a one-shot command
// holds the lock for its run and releases it in `withTeamProfile`). A test pins the two to the same answers.
async function lockProfile(configPath, acquireProfileImpl = acquireProfileAsync) {
  const before = loadHostConfig(configPath);
  const lock = await acquireProfileImpl({ userDataPath: before.userDataPath,
    pythonExecutable: before.pythonExecutable || DEFAULT_PYTHON });
  try {
    const config = loadHostConfig(configPath);
    if (config.userDataPath !== before.userDataPath) throw new Error('host_profile_changed_during_start');
    if (fs.existsSync(path.join(config.userDataPath, 'auth.json'))) {
      throw Object.assign(new Error('invalid_host_profile'), { code: HOST_ERROR_CODES.CONFLICT, reason: 'invalid_host_profile' });
    }
    return { config, lock };
  } catch (error) {
    await Promise.resolve(lock.release()).catch(() => {});
    throw error;
  }
}

/**
 * Runs `body(config, say)` under the profile lock after the config preflight; the lock is released on every
 * path. A throw inside `body` is `team_unavailable` (logged by event name only).
 */
async function withTeamProfile({ configPath, acquireProfileImpl, logger, event }, body) {
  const preflight = loadSecretFileTeamConfig(configPath);
  if (!preflight.ok) return preflight;
  const say = safeLogger(logger);
  let lock = null;
  try {
    let acquired;
    try {
      acquired = await lockProfile(configPath, acquireProfileImpl);
    } catch (error) {
      return refusal(lockReason(error));
    }
    lock = acquired.lock;
    const { config } = acquired;
    if (!config.team) return refusal('team_config_required');
    if (config.team.keySource !== 'secret_file') return refusal('team_key_source_invalid');
    return await body(config, say);
  } catch {
    say('ERROR', `${event}.failed`, {});
    return refusal('team_unavailable');
  } finally {
    if (lock) {
      try { await lock.release(); } catch { say('ERROR', `${event}.lock_release_failed`, {}); }
    }
  }
}

module.exports = {
  DELETE_MARKER, RESTORE_MARKER, STAGING, STAGING_PREFIX, findLinks, hasTeam, KEPT_IN_PROFILE, keygenRefusal, lockProfile,
  mountRoot, namesIn, readHostSeed, refusal, removeMarker, removeStaging, removeTeamData, rootsReason, teamRoots, teamState,
  unfinishedWork, withTeamProfile, writeMarker,
};
