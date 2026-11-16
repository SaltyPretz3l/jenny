'use strict';

// `team-restore --file <name>` (slice 3-14): brings a team back from a backup file (desktop or headless, the one
// format of host-backup.js) onto a stopped headless host that holds no team. It never overwrites a team and never
// sets one aside.
//
// Order, and what a cut at each step leaves:
//  1. The terminal, the file name (one segment), the config and the profile lock, the exchange folder, and the
//     profile, data volume and projects root each a real directory at its own real path (`rootsReason`). A delete
//     marker refuses (`team_delete_unfinished`). A restore marker with a key file is finished only when that key
//     belongs to the restored member store (its public key equals the store's host key): then only the marker's
//     removal was cut, the marker goes and the restore is done. Any other key file (one made after the cut, or a
//     store that does not read) refuses `team_restore_key_foreign` with the marker and the key file kept. A restore
//     marker with no key file is a partial team from a cut restore: it is cleared (the delete's removal) and the
//     restore starts again; a root that cannot be listed refuses (`team_restore_failed`) with the marker and the
//     partial team kept, never cleared as empty. Staging folders a cut left are removed.
//  2. Refused unless the host holds no team at all: no key file, no member store, an empty projects root and an
//     empty or absent trash (`team_host_exists`).
//  3. The file, opened once without following a link (file-checks.js `openNoFollow`) directly in the exchange
//     folder: the handle must be a regular file with one link, at its own real path, and every later read goes
//     through that handle. Its header (a newer version refuses before any password work), the room on the profile
//     and data volumes, then the password once, no echo.
//  4. Every record is written into a staging folder inside its own volume (`.jenny-restoring-<hex>` in the
//     profile and in the data volume), files 0600 (each synced before it is closed) and folders 0700; the reader
//     checks every chunk before its bytes are used, and nothing leaves staging until the last chunk's tag was
//     read. Any failure removes the staging. A cut here leaves staging only: the next run removes it (no team),
//     or `team-delete` does; `team-keygen`, `team-init` and `team-recover` refuse beside it
//     (`team_restore_unfinished`).
//  5. Checks on the staged team: the public key derived from the backup's key must equal the staged member store's
//     host public key (`team_host_key_mismatch`); a staged profile entry that already exists in the profile refuses
//     (`team_host_exists`), apart from names never moved in (the profile's lock and owner marker, the two markers,
//     the ready marker, staging-shaped names) and empty folders. `projects.json` roots that name another host's
//     projects folder are rewritten to this host's (below); a `projects.json` of a newer schema than this build's
//     refuses (`team_backup_too_new`) with the staging removed.
//  6. Every staged folder is synced, the restore marker is written, then the staged trees move into place by
//     rename (projects, trash, the profile with the member store last) and the profile, the data volume, the
//     projects root and the trash are synced. A folder that cannot be listed fails the move (`team_restore_failed`),
//     never reads as empty. A cut from here until the key file is written leaves a partial team with the marker
//     and no key: the next run clears it and restores again.
//  7. The key file is written LAST, after every sync above, by keygen.js's writer (exclusive create, no link
//     followed, 0600, synced). Syncs per restore: one per restored file, one per restored folder, four volume
//     folders, then the key file and the secrets folder. The key goes nowhere else: no log, temporary file,
//     profile file or output. Then the marker goes; a cut between the two is finished by the next run (step 1).
//
// Root paths: a desktop backup's `projects.json` records each team project's absolute folder on that PC. The host
// keeps a project record's non-null root as it is at start (team-project-reconcile.js binds only a null root), and
// on Linux a Windows path is not absolute, so the project store would refuse the whole file as invalid and turn
// read only. Each team project whose stored root ends in its own id is pointed at `<projects root>/<id>` here.
//
// The backup's relay token and internet setting are checked and dropped: the headless config decides internet
// joining and a headless host holds no relay token. Output: counts and the next step; never a path, a name, the key
// or the password.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { writeJson } = require('../../services/host/durable-json');
const { BackupError, peekBackup, readBackup } = require('../../services/team/host/host-backup');
const { readJsonFile, renameInside } = require('../../services/team/host/host-files');
const { checkedManifest, checkedRel } = require('../../services/team/host/host-restore');
const { PROJECT_STORE_SCHEMA_VERSION, normalizeProjectRecord } = require('../../services/projects/project-schema');
const { atOwnRealPath, openNoFollow, ownDirectory } = require('./file-checks');
const { keyPairFromSeed } = require('./ids');
const { syncDirectory, writeKeyFile } = require('./keygen');
const { GENERAL_PROJECT_ID } = require('./member-schema');
const { MEMBERS_FILE } = require('./member-store');
const { validateSegment } = require('./path-segments');
const { removeReadyMarker } = require('./ready-marker');
const { isTerminalPair, readPassword } = require('./tty-input');
const {
  KEPT_IN_PROFILE, RESTORE_MARKER, STAGING, STAGING_PREFIX, findLinks, hasTeam, mountRoot, namesIn, readHostSeed,
  refusal, removeMarker, removeStaging, removeTeamData, rootsReason, teamRoots, teamState, withTeamProfile, writeMarker,
} = require('./team-maintenance');

const SPARE_BYTES = 256 * 1024 * 1024;
// Profile entries a backup may carry that are never moved in: the ready marker (never exported) and the profile's
// own ownership files and markers, which this profile already has or must not get from a file.
const NOT_MOVED = new Set([...KEPT_IN_PROFILE, 'team-ready.json']);
const PROJECTS_FILE = 'projects.json';

// The backup file in the exchange folder opened once, link not followed: { file, handle, size } for a regular file
// with one link at its own real path, else null. The caller closes the handle.
async function openBackup(exchange, name) {
  const file = path.join(exchange, name);
  let handle;
  try { handle = await openNoFollow(file, fs.constants.O_RDONLY); } catch { return null; }
  try {
    const stat = await handle.stat();
    if (stat.isFile() && stat.nlink === 1 && atOwnRealPath(file)) return { file, handle, size: stat.size };
  } catch { /* refused below */ }
  await handle.close().catch(() => {});
  return null;
}

// True when each volume holds the file's size and the spare, or the system cannot say.
async function roomOn(dirs, size, statfs) {
  for (const dir of dirs) {
    try {
      const free = await statfs(dir);
      if (Number(free.bavail) * Number(free.bsize) < size + SPARE_BYTES) return false;
    } catch { /* cannot say */ }
  }
  return true;
}

// Writes the backup's records into the two staging folders. Answers the checked manifest; throws a BackupError.
async function stageBackup({ picked, password, stage }) {
  let restored = null;
  let out = null;
  const where = (parts) => (parts[0] === 'profile' ? path.join(stage.profile, ...parts.slice(1))
    : path.join(stage.data, ...parts));
  try {
    await readBackup({ file: picked.file, handle: picked.handle, password, handlers: {
      onManifest: (manifest) => {
        restored = checkedManifest(manifest);
        fs.mkdirSync(stage.profile, { mode: 0o700 });
        fs.mkdirSync(stage.data, { mode: 0o700 });
      },
      onDir: (rel) => {
        const parts = checkedRel(rel);
        if (!parts) throw new BackupError('team_backup_password_wrong');
        fs.mkdirSync(where(parts), { recursive: true, mode: 0o700 });
      },
      onFileStart: (rel) => {
        const parts = checkedRel(rel);
        if (!parts || parts.length < 2) throw new BackupError('team_backup_password_wrong');
        fs.mkdirSync(path.dirname(where(parts)), { recursive: true, mode: 0o700 });
        out = fs.openSync(where(parts), 'wx', 0o600);
      },
      onFileData: (data) => { fs.writeSync(out, data); },
      onFileEnd: () => { fs.fsyncSync(out); fs.closeSync(out); out = null; },
    } });
    return restored;
  } catch (error) {
    if (out !== null) { try { fs.closeSync(out); } catch { /* closed */ } }
    restored?.seed.fill(0);
    throw error instanceof BackupError ? error : new BackupError('team_restore_failed');
  }
}

// Points each team project whose stored root ends in its own id at this host's folder for it. Answers the count, or
// null for a file of a newer schema than this build's project store (review sweep X4c-F04: never rewritten, the
// restore refuses). A file of any other schema is left byte for byte (the store judges it at start).
function rewriteRoots(profileStage, projectsRoot) {
  const file = path.join(profileStage, PROJECTS_FILE);
  let doc;
  try { doc = readJsonFile(file); } catch { return 0; }
  const schema = doc?.schema_version;
  if (Number.isSafeInteger(schema) && schema > PROJECT_STORE_SCHEMA_VERSION) return null;
  if (schema !== PROJECT_STORE_SCHEMA_VERSION) return 0;
  let changed = 0;
  for (const [id, record] of Object.entries(doc?.projects ?? {})) {
    if (id === GENERAL_PROJECT_ID || typeof record?.root_path !== 'string') continue;
    const own = path.join(projectsRoot, id);
    if (record.root_path.split(/[\\/]/u).filter(Boolean).at(-1) !== id || record.root_path === own) continue;
    // The record again through the project store's own normalizer: its root id is derived from the root.
    const moved = normalizeProjectRecord({ ...record, root_path: own }, { projectId: id });
    if (!moved) continue;
    doc.projects[id] = moved;
    changed += 1;
  }
  if (changed) writeJson(file, doc);
  return changed;
}

const isEmptyDir = (dir) => ownDirectory(dir) !== null && namesIn(dir)?.length === 0;

// The staged profile entries to move, member store last; or a refusal word: `team_host_exists` when one would land
// on something, `team_restore_failed` when the staging cannot be listed.
function profileMoves(stage, roots) {
  const staged = namesIn(stage.profile);
  if (staged === null) return 'team_restore_failed';
  const names = staged.filter((name) => !NOT_MOVED.has(name) && !STAGING.test(name))
    .sort((a, b) => (a === MEMBERS_FILE) - (b === MEMBERS_FILE));
  for (const name of names) {
    const there = path.join(roots.profile, name);
    try { fs.lstatSync(there); } catch { continue; }
    if (!isEmptyDir(there)) return 'team_host_exists';
  }
  return names;
}

// Every folder of the two staging trees, so the names in them last before they move.
function stagedFolders(stage) {
  const found = [];
  const pending = [stage.profile, stage.data];
  while (pending.length) {
    const dir = pending.pop();
    found.push(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
    }
  }
  return found;
}

// Step 6: moves the staged trees into place; false when a move or a listing failed (the marker stays for the next
// run). `cut('project')` runs after each project folder, `cut(step)` after each step.
function moveIntoPlace(stage, roots, names, cut) {
  const projects = namesIn(path.join(stage.data, 'projects'));
  if (projects === null) return false;
  for (const name of projects) {
    if (!renameInside(roots.data, path.join(stage.data, 'projects', name), path.join(roots.projects, name))) return false;
    cut('project');
  }
  cut('projects');
  const stagedTrash = path.join(stage.data, 'trash');
  const trash = namesIn(stagedTrash);
  if (trash === null) return false;
  if (trash.length) {
    if (isEmptyDir(roots.trash)) fs.rmdirSync(roots.trash);
    if (!renameInside(roots.data, stagedTrash, roots.trash)) return false;
  }
  cut('trash');
  for (const name of names) {
    const there = path.join(roots.profile, name);
    if (isEmptyDir(there)) fs.rmdirSync(there);
    if (!renameInside(roots.profile, path.join(stage.profile, name), there)) return false;
  }
  cut('profile');
  return true;
}

// True when the key file's public key is the member store's host key (the key this restore wrote).
function keyOfStore(config, roots) {
  const seed = readHostSeed(config);
  if (!seed) return false;
  try {
    return readJsonFile(path.join(roots.profile, MEMBERS_FILE))?.team?.host_public_key === keyPairFromSeed(seed).publicKey;
  } catch {
    return false;
  } finally {
    seed.fill(0);
  }
}

// Step 1: a marker from an earlier run. Answers a result to return now, or null to go on.
async function settleEarlier(config, roots, output) {
  const state = teamState(roots);
  if (state.deleting) return refusal('team_delete_unfinished');
  if (state.restoring && state.key) {
    // A key file this restore did not write is never finished over, and never removed here.
    if (!keyOfStore(config, roots)) return refusal('team_restore_key_foreign');
    if (!removeMarker(roots, RESTORE_MARKER)) return refusal('team_restore_failed');
    output.write('Finished the restore an earlier run began. Start the team server.\n');
    return { ok: true };
  }
  if (state.restoring) {
    // A root that cannot be listed is never cleared as empty (review sweep X4c-F01): the marker and the data stay.
    if (state.unreadable) return refusal('team_restore_failed');
    const links = await findLinks(roots);
    if (links === null) return refusal('team_restore_failed');
    if (links) return refusal('team_restore_link');
    if (!(await removeTeamData(roots)).ok || !removeMarker(roots, RESTORE_MARKER)) return refusal('team_restore_failed');
  }
  if (!(await removeStaging(roots))) return refusal('team_restore_failed');
  return hasTeam(teamState(roots)) ? refusal('team_host_exists') : null;
}

// Steps 5 to 7 on the staged team. Answers the command's result.
async function placeStaged({ roots, stage, restored, output, say, cut, syncFolder }) {
  let doc;
  try { doc = readJsonFile(path.join(stage.profile, MEMBERS_FILE)); } catch { doc = null; }
  const names = profileMoves(stage, roots);
  const refused = doc?.team?.host_public_key !== keyPairFromSeed(restored.seed).publicKey ? 'team_host_key_mismatch'
    : typeof names === 'string' ? names : null;
  if (refused) {
    await removeStaging(roots);
    return refusal(refused);
  }
  const rewritten = rewriteRoots(stage.profile, roots.projects);
  if (rewritten === null) {
    await removeStaging(roots);
    return refusal('team_backup_too_new');
  }
  const projects = namesIn(path.join(stage.data, 'projects'))?.length ?? 0;
  for (const dir of stagedFolders(stage)) syncFolder(dir);
  if (writeMarker(roots, RESTORE_MARKER)) {
    await removeStaging(roots);
    return refusal('team_restore_failed');
  }
  cut('marker');
  if (!moveIntoPlace(stage, roots, names, cut)) return refusal('team_restore_failed');
  await removeStaging(roots);
  removeReadyMarker({ userDataPath: roots.profile });
  for (const dir of [roots.profile, roots.data, roots.projects, roots.trash]) syncFolder(dir);
  const text = Buffer.from(`${restored.seed.toString('base64url')}\n`, 'utf8');
  try {
    const failed = writeKeyFile(fs, roots.keyFile, text);
    if (failed) return refusal(failed);
  } finally {
    text.fill(0);
  }
  syncDirectory(fs, roots.secrets);
  cut('key');
  removeMarker(roots, RESTORE_MARKER);
  say('INFO', 'team.restore.done', { projects, roots_rewritten: rewritten });
  output.write(`Restored the team: ${projects} projects${rewritten ? `, ${rewritten} project folders pointed at this host` : ''}.\n`
    + 'Internet joining and any relay come from team-host.json, not from the backup.\n'
    + 'Next: if the owner\'s Jenny is on a new device, run team-recover now (server stopped); then start the team server.\n');
  return { ok: true, projects, roots_rewritten: rewritten };
}

// Steps 3 to 7 for the opened backup file.
async function restorePicked({ roots, picked, output, input, promptOutput, say, readPasswordImpl, statfs, randomBytes,
  cut, syncFolder }) {
  try { await peekBackup(picked.file, { handle: picked.handle }); } catch (error) {
    return refusal(error?.reason ?? 'team_backup_unreadable');
  }
  if (!(await roomOn([roots.profile, roots.data], picked.size, statfs))) return refusal('team_disk_full');
  let password;
  try {
    password = await readPasswordImpl({ input, output: promptOutput, prompt: 'Backup password: ' });
  } catch {
    return refusal('team_input_cancelled');
  }
  const hex = randomBytes(6).toString('hex');
  const stage = { profile: path.join(roots.profile, `${STAGING_PREFIX}${hex}`), data: path.join(roots.data, `${STAGING_PREFIX}${hex}`) };
  let restored;
  try {
    restored = await stageBackup({ picked, password, stage });
  } catch (error) {
    await removeStaging(roots);
    return refusal(error.reason);
  }
  try {
    return await placeStaged({ roots, stage, restored, output, say, cut, syncFolder });
  } finally {
    restored.seed.fill(0);
  }
}

/**
 * Restores `<exchange folder>/<fileName>`. Answers { ok, projects, roots_rewritten } or { ok: false, reason }.
 * `cut(step)`: a test seam called after each step of 6 and 7; `syncFolder(dir)`: the folder sync (keygen.js's).
 */
async function restoreHostedTeam({
  configPath, fileName, output = process.stdout, input = process.stdin, promptOutput = process.stderr, logger = null,
  acquireProfileImpl, readPasswordImpl = readPassword, statfs = fs.promises.statfs, randomBytes = crypto.randomBytes,
  cut = () => {}, syncFolder = (dir) => syncDirectory(fs, dir),
} = {}) {
  if (!validateSegment(fileName).ok) return refusal('team_restore_file_invalid');
  if (!isTerminalPair(input, promptOutput)) return refusal('team_tty_required');
  return withTeamProfile({ configPath, acquireProfileImpl, logger, event: 'team.restore' }, async (config, say) => {
    const exchange = mountRoot(config, 'exchange');
    if (!exchange) return refusal('team_exchange_unavailable');
    const roots = teamRoots(config);
    if (!roots.projects) return refusal('team_projects_root_missing');
    const badRoot = rootsReason(roots, 'team_restore_link');
    if (badRoot) return refusal(badRoot);
    const earlier = await settleEarlier(config, roots, output);
    if (earlier) return earlier;
    const picked = await openBackup(exchange, fileName);
    if (!picked) return refusal('team_restore_file_invalid');
    try {
      return await restorePicked({ roots, picked, output, input, promptOutput, say, readPasswordImpl, statfs, randomBytes,
        cut, syncFolder });
    } finally {
      await picked.handle.close().catch(() => {});
    }
  });
}

module.exports = { restoreHostedTeam };
