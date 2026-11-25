'use strict';

// Restoring a hosted team from its backup (slice 5-6, decision E63). No Electron.
//
// The version is checked from the header and the password from the first chunk before anything is written
// (host-backup.js). The records are written into a new folder `<userData>/team-host-restoring-<hex>/`, made only
// once the first chunk opened, every path checked to stay inside it; nothing is moved into place until the last
// chunk's tag is read. Then, in this order: the keyless team is set aside (from the lost-key page only, as Start a
// new team does), the folder is renamed to `team-host`, the config is written from the backup's setting and this
// PC's real paths with internet joining off, and last the key goes into the secure store. A failure at any step
// undoes the earlier ones: the leftover mark is written into `team-host`, the config goes, then the folder is renamed
// back and removed, then the keyless team comes back from aside. A part that cannot be undone is left for the sweep
// (host-sweep.js: a restoring folder, or a marked `team-host` with no config and no key) and the answer says so
// (`leftover`).
//
// Review sweeps, second run (X4b-F03): each restored file is synced before it is closed, and every folder of the
// restoring tree, then the profile folder after the rename, is synced (best effort: Windows refuses a folder's
// fsync and NTFS logs the names itself), all before the config and the key commit the restore.
//
// Internet joining comes back off (review item 7): the backup's public address and relay URL are checked as
// `hostInternet` checks them and kept as a draft beside the config (`internet-draft.json`) that fills the setting's
// form, so the owner turns joining on through the page's own confirmation and saves them with the save bar (the
// draft goes once a save names an address or a relay). The backup's relay token is not stored: the
// setting's token rule removes a stored token when joining is turned on from off without one, so the owner enters
// it again with the relay. The relay token stored on this PC before the restore is never touched.
// There is room for the team in the profile first (`team_disk_full`). Nothing here logs a path, a name, the
// password or the key.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { writeJson } = require('../../host/durable-json');
const { BackupError, readBackup } = require('./host-backup');
const { setAsideTeam, unsetAside } = require('./host-delete');
const { realParentInside, removeFileInside, removeTreeInsideAsync, renameInside } = require('./host-files');
const { internetFromPayload } = require('./host-internet-setting');
const { buildHostConfig, prepareHostLayout, writeHostConfig } = require('./host-layout');
const { HOST_DIR_NAME, RESTORING_PREFIX, markLeftover } = require('./host-sweep');
const { PUBLIC_KEY_BYTES, decodeBase64url } = require('../../../server/team/ids');
const { isCleanText } = require('../../../server/team/member-schema');
const { isRelayToken } = require('../../../server/team/invites');
const { DIR_MODE, FILE_MODE, dropNotMoved, hostKeyMatches, rewriteProjectRoots } = require('../../../server/team/restore-core');

const DRAFT_FILE = 'internet-draft.json';
// Room left over in the profile beyond the backup's size.
const SPARE_BYTES = 256 * 1024 * 1024;
// A record's path: `profile`, `projects` or `trash`, then names with no separator, dot-only or reserved character.
const SEGMENT = /^(?!\.{1,2}$)[^<>:"/\\|?*\p{Cc}]{1,255}$/u;
const TOPS = new Set(['profile', 'projects', 'trash']);

function checkedRel(rel) {
  const parts = String(rel).split('/');
  if (!TOPS.has(parts[0]) || parts.length > 64 || !parts.every((part) => SEGMENT.test(part))) return null;
  return parts;
}

// The backup's internet setting as the form's draft ({ public_address, relay_url }), null while it was off, or
// undefined when `hostInternet`'s own checks refuse it.
function draftOf(internet, port) {
  if (internet === null) return null;
  if (typeof internet !== 'object' || Array.isArray(internet)) return undefined;
  const checked = internetFromPayload({ enabled: true, public_address: internet.public_address ?? null,
    relay_url: internet.relay_url ?? null }, port);
  return checked.ok ? { public_address: checked.internet.public_address, relay_url: checked.internet.relay_url } : undefined;
}

// The backup's manifest as restore uses it, or a refusal (a manifest this format did not write).
function checkedManifest(manifest) {
  const seed = typeof manifest?.key === 'string' ? decodeBase64url(manifest.key, PUBLIC_KEY_BYTES) : null;
  const setting = manifest?.setting;
  const port = setting?.direct_port ?? null;
  const portOk = port === null || (Number.isSafeInteger(port) && port >= 1 && port <= 65535);
  const draft = portOk ? draftOf(setting?.internet ?? null, port) : undefined;
  if (manifest?.schema !== 1 || !seed || !isCleanText(setting?.name) || !portOk || draft === undefined
    || (manifest.relay_token !== null && manifest.relay_token !== undefined && !isRelayToken(manifest.relay_token))) {
    seed?.fill(0);
    throw new BackupError('team_backup_password_wrong');
  }
  return { seed, name: setting.name, directPort: port, draft,
    exportedAt: Number.isSafeInteger(manifest.exported_at) ? manifest.exported_at : null };
}

/** The internet draft a restore kept for the setting's form, or null (until a save of the setting names values). */
function readInternetDraft(userDataPath) {
  try {
    const file = path.join(userDataPath, HOST_DIR_NAME, DRAFT_FILE);
    if (fs.lstatSync(file).size > 4096) return null;
    const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
    const checked = draftOf({ public_address: draft?.public_address ?? null, relay_url: draft?.relay_url ?? null }, null);
    return checked && (checked.public_address || checked.relay_url) ? checked : null;
  } catch {
    return null;
  }
}

/** A save of the setting named its own values: the draft goes. */
function removeInternetDraft(userDataPath) {
  const root = path.join(userDataPath, HOST_DIR_NAME);
  removeFileInside(root, path.join(root, DRAFT_FILE));
}

// One restored file's sync, awaited so the main process turns between files (thousands of small files otherwise
// stall it). A filesystem with no fsync at all does not fail the restore; any other failure does.
const NO_FSYNC = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS']);
function syncFd(fd) {
  return new Promise((resolve, reject) => {
    fs.fsync(fd, (error) => (error && !NO_FSYNC.has(error.code) ? reject(error) : resolve()));
  });
}

// One fsync of a folder, so the names in it last; best effort.
function syncFolder(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* best effort */ } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

// True when the profile's drive has room for a restore of `file`, or the system cannot say.
async function roomFor(userDataPath, file, statfs) {
  try {
    const [stat, free] = await Promise.all([fs.promises.stat(file), statfs(userDataPath)]);
    return Number(free.bavail) * Number(free.bsize) >= stat.size + SPARE_BYTES;
  } catch {
    return true;
  }
}

// The steps the headless restore shares (server/team/restore-core.js), on the restored tree before it is moved: the
// profile's own files a backup never brings in are dropped; the backup's key must be the member store's host key
// (`team_host_key_mismatch`); and each project's folder is pointed at this PC's `team-host/projects` (a backup from
// another PC or OS names that PC's paths; a project store of a newer schema refuses with `team_backup_too_new`).
function checkRestored(userDataPath, temp, seed) {
  const profile = path.join(temp, 'profile');
  dropNotMoved(profile);
  if (!hostKeyMatches(profile, seed)) throw new BackupError('team_host_key_mismatch');
  const projects = path.join(fs.realpathSync.native(userDataPath), HOST_DIR_NAME, 'projects');
  if (rewriteProjectRoots(profile, projects) === null) throw new BackupError('team_backup_too_new');
}

/**
 * Restores `file` with `password`. `keys`: the host key store; `setAside`: the facts of the keyless team to set
 * aside first (lost-key page), or null. Answers { ok: true, team_name, exported_at, set_aside } or
 * { ok: false, reason, leftover? } (`leftover`: a part could not be undone and waits for the sweep).
 */
async function restoreTeam({ userDataPath, file, password, keys, setAside = null, lockPython = null,
  randomBytes = crypto.randomBytes, now = Date.now(), statfs = fs.promises.statfs }) {
  if (!(await roomFor(userDataPath, file, statfs))) return { ok: false, reason: 'team_disk_full' };
  const temp = path.join(userDataPath, `${RESTORING_PREFIX}${randomBytes(6).toString('hex')}`);
  let restored = null;
  let made = false;
  let out = null;
  // Every folder of the restoring tree, for the sync before the commit (bounded by the backup's own entries).
  const folders = new Set();
  const noteFolders = (parts) => { for (let i = 0; i <= parts.length; i += 1) folders.add(path.join(temp, ...parts.slice(0, i))); };
  const cleanTemp = async () => !made || (await removeTreeInsideAsync(userDataPath, temp)).ok;
  try {
    await readBackup({ file, password, handlers: {
      onManifest: (manifest) => {
        restored = checkedManifest(manifest);
        if (!realParentInside(userDataPath, temp)) throw new BackupError('team_restore_failed');
        fs.mkdirSync(temp, { mode: DIR_MODE });
        made = true;
      },
      onDir: (rel) => {
        const parts = checkedRel(rel);
        if (!parts) throw new BackupError('team_backup_password_wrong');
        fs.mkdirSync(path.join(temp, ...parts), { recursive: true, mode: DIR_MODE });
        noteFolders(parts);
      },
      onFileStart: (rel) => {
        const parts = checkedRel(rel);
        if (!parts || parts.length < 2) throw new BackupError('team_backup_password_wrong');
        fs.mkdirSync(path.join(temp, ...parts.slice(0, -1)), { recursive: true, mode: DIR_MODE });
        noteFolders(parts.slice(0, -1));
        out = fs.openSync(path.join(temp, ...parts), 'wx', FILE_MODE);
      },
      onFileData: (data) => { fs.writeSync(out, data); },
      onFileEnd: async () => { await syncFd(out); fs.closeSync(out); out = null; },
    } });
    checkRestored(userDataPath, temp, restored.seed);
    for (const folder of folders) syncFolder(folder);
  } catch (error) {
    if (out !== null) { try { fs.closeSync(out); } catch { /* closed */ } }
    restored?.seed.fill(0);
    const cleaned = await cleanTemp();
    return { ok: false, reason: error instanceof BackupError ? error.reason : 'team_restore_failed', ...(cleaned ? {} : { leftover: true }) };
  }
  const root = path.join(userDataPath, HOST_DIR_NAME);
  let asideId = null;
  let moved = false;
  const undo = async (reason) => {
    let left = false;
    if (moved) {
      // The mark first, then the config: a marked `team-host` with no config and no key is a leftover the sweep
      // removes. Without the mark it would be kept as a team whose key was lost.
      markLeftover(root);
      if (!removeFileInside(root, path.join(root, 'host-config.json'))) left = true;
      if (!renameInside(userDataPath, root, temp)) left = true;
    }
    if (!(await cleanTemp())) left = true;
    if (asideId && !unsetAside(userDataPath, asideId)) left = true;
    restored.seed.fill(0);
    return { ok: false, reason, ...(left ? { leftover: true } : {}) };
  };
  try {
    if (setAside) {
      const aside = setAsideTeam(userDataPath, setAside, { now });
      if (!aside.ok) return undo(aside.reason);
      asideId = aside.id;
    }
    if (!renameInside(userDataPath, temp, root)) return undo('team_restore_failed');
    moved = true;
    syncFolder(userDataPath);
    const layout = prepareHostLayout(userDataPath);
    writeHostConfig(layout, buildHostConfig({ layout, name: restored.name, directPort: restored.directPort, lockPython,
      internet: null }));
    if (restored.draft) {
      try { writeJson(path.join(root, DRAFT_FILE), { schema_version: 1, ...restored.draft }); } catch { /* the owner types them again */ }
    }
    keys.restore(restored.seed);
  } catch (error) {
    return undo(error?.reason === 'team_host_key_exists' ? 'team_host_key_exists' : 'team_restore_failed');
  }
  restored.seed.fill(0);
  return { ok: true, team_name: restored.name, exported_at: restored.exportedAt, set_aside: asideId };
}

// The headless restore (server/team/team-restore.js) shares the record and manifest checks.
module.exports = { checkedManifest, checkedRel, readInternetDraft, removeInternetDraft, restoreTeam };
