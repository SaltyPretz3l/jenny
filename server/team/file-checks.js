'use strict';

// The containment checks team project file transfer shares (slice 3-8c, TEAM_PROJECTS_SPEC "3-8c as built"):
// project-folders.js, project-folder-io.js and transfer-core.js use them for every real-path comparison, every
// open and create, and the final rename. The platform is always the real one (`process.platform`).
//
// - `ownDirectory` is the one rule for "a real directory at its own real path", on every platform.
// - POSIX opens add O_NOFOLLOW (with O_EXCL for a create) and the final rename is one rename: as before 3-8c.
// - Windows has no O_NOFOLLOW, so each open is checked before and after. An existing file: `lstat` a regular file
//   with one link whose native real path is the asked path with the final name spelled exactly (which proves every
//   folder on the way and refuses an 8.3 alias), then the opened handle the same volume and file id. A create: the
//   parent a real directory at its own real path and the name absent by `lstat` (a dangling junction is not absent:
//   an exclusive create through one makes a directory at its target), then the created file checked the same way.
// - Windows rename puts a directory over an existing file, so the final rename holds the name first with an empty
//   file made exclusively (after the same absent check) and replaces only that file, while it is still the one made.
// - Real paths compare exactly, except that on Windows an ASCII letter may differ in case (a drive letter, a folder
//   typed in another case). Every other character compares exactly: NTFS folds more pairs than ASCII but not the
//   pairs JavaScript folds, so a root that differs from its real path by a non-ASCII case is refused (fail closed).
// - `probeVolumes` proves once at start, on a Windows host, what these checks need from both volumes.
//
// Known limit (owner, 2026-11-12): a program already running on the host PC as the host's own user can swap a link
// in between a check and the call it guards. A member cannot: a member reaches a folder only through upload and the
// typed tools.

const fs = require('node:fs');
const path = require('node:path');

const { removeFileSync, removeTree } = require('../../services/fs-remove-no-follow');

const fsp = fs.promises;
const WINDOWS = process.platform === 'win32';
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
// The projects-root scratch folder of the volume probe; project-folder-io.js's install sweep takes this prefix too.
const PROBE_PREFIX = '.jenny-probe-';

const failure = (message, code) => Object.assign(new Error(message), { code });
const changed = () => failure('file_changed', 'file_changed');
const refuse = (reason) => ({ ok: false, reason });
const asciiLower = (code) => (code >= 0x41 && code <= 0x5a ? code + 0x20 : code);

/** Two spellings of one path: equal, or on Windows equal but for the case of ASCII letters. */
function samePath(left, right, platform = process.platform) {
  if (left === right) return true;
  if (platform !== 'win32' || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (asciiLower(left.charCodeAt(index)) !== asciiLower(right.charCodeAt(index))) return false;
  }
  return true;
}

/** The path is its own native real path: no link, junction, mount point, substituted drive or 8.3 alias on the way. */
function atOwnRealPath(file) {
  try {
    return samePath(fs.realpathSync.native(file), file);
  } catch {
    return false;
  }
}

// atOwnRealPath, and the final segment's on-disk name exactly the one asked for.
function exactName(file) {
  try {
    const real = fs.realpathSync.native(file);
    return samePath(real, file) && path.basename(real) === path.basename(file);
  } catch {
    return false;
  }
}

/** POSIX: true (O_NOFOLLOW and the callers' own checks cover it). Windows: the native real path, name exact. */
const nameHolds = (file) => !WINDOWS || exactName(file);

/** The one rule for a real directory at its own real path: its bigint `lstat`, or null on any doubt. */
function ownDirectory(folder) {
  try {
    const stat = fs.lstatSync(folder, { bigint: true });
    return stat.isDirectory() && atOwnRealPath(folder) ? stat : null;
  } catch {
    return null;
  }
}

/** Nothing at the name, not even a link: `lstat` answers ENOENT. */
function absent(file) {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

const regularFile = (stat) => stat.isFile() && stat.nlink === 1n;

/**
 * Opens a file without following a link. POSIX adds O_NOFOLLOW. Windows checks before (an existing file: its
 * `lstat` and name; a create: the parent and the name absent) and after (the handle against the `lstat`; for a
 * create, an `lstat` and name taken after it). Answers the FileHandle; a failed check closes it and throws.
 */
async function openNoFollow(file, flags, mode) {
  if (!WINDOWS) return fsp.open(file, flags | NOFOLLOW, mode);
  const create = (flags & fs.constants.O_EXCL) !== 0;
  let before = null;
  if (create) {
    if (!ownDirectory(path.dirname(file))) throw changed();
    if (!absent(file)) throw failure('exists', 'EEXIST');
  } else {
    before = fs.lstatSync(file, { bigint: true });
    if (!regularFile(before) || !exactName(file)) throw changed();
  }
  const handle = await fsp.open(file, flags, mode);
  try {
    const opened = await handle.stat({ bigint: true });
    const entry = before ?? fs.lstatSync(file, { bigint: true });
    if (regularFile(opened) && regularFile(entry) && opened.dev === entry.dev && opened.ino === entry.ino
      && (before !== null || exactName(file))) return handle;
  } catch { /* refused below */ }
  await handle.close().catch(() => {});
  throw changed();
}

/**
 * The final rename of a new folder, which must not land on anything. POSIX: one rename (it fails on a non-empty
 * directory or a file there). Windows: with the name absent by `lstat`, it is held by an empty file made exclusively,
 * checked to be that file again, then replaced by the rename. On any failure the holder is removed only while it is
 * still the one made; a removal that fails calls `onLeft({ file, dev, ino })` so the caller can retry it later. A
 * directory raced in after the holder was removed fails the rename (EPERM).
 */
async function renameNoReplace(from, to, { onLeft = () => {} } = {}) {
  if (!WINDOWS) {
    fs.renameSync(from, to);
    return;
  }
  if (!absent(to)) throw failure('exists', 'EEXIST');
  let held = null;
  const holds = () => {
    try {
      const stat = fs.lstatSync(to, { bigint: true });
      return regularFile(stat) && stat.size === 0n && stat.dev === held.dev && stat.ino === held.ino;
    } catch {
      return false;
    }
  };
  try {
    const holder = await fsp.open(to, 'wx');
    try {
      held = await holder.stat({ bigint: true });
    } finally {
      await holder.close();
    }
    if (!holds() || !exactName(to)) throw failure('hold_lost', 'EEXIST');
    fs.renameSync(from, to);
  } catch (error) {
    if (held !== null && holds()) {
      try { removeFileSync(to); } catch { onLeft({ file: to, dev: held.dev, ino: held.ino }); }
    }
    throw error;
  }
}

/** Removes a holder `renameNoReplace` left, while it is still that empty file; true when nothing of it is left. */
function removeHolder({ file, dev, ino }) {
  let stat;
  try {
    stat = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  if (!regularFile(stat) || stat.size !== 0n || stat.dev !== dev || stat.ino !== ino) return true;
  try {
    removeFileSync(file);
    return true;
  } catch {
    return false;
  }
}

const IO = Object.freeze({
  handleStat: (handle) => handle.stat({ bigint: true }),
  lstat: (file) => fs.lstatSync(file, { bigint: true }),
  readdir: (folder) => fs.readdirSync(folder, { withFileTypes: true }),
});

// Ids and junctions in one scratch folder: `{ ok, file, dev }` or a refusal.
async function probeIn(scratch, io) {
  const file = path.join(scratch, 'f');
  const handle = await fsp.open(file, 'wx');
  let opened;
  try {
    opened = await io.handleStat(handle);
  } finally {
    await handle.close();
  }
  const seen = io.lstat(file);
  if (opened.ino === 0n || opened.ino !== seen.ino || opened.dev !== seen.dev) return refuse('volume_ids');
  const target = path.join(scratch, 'd');
  const junction = path.join(scratch, 'j');
  fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, junction, 'junction');
  } catch {
    return refuse('volume_junctions');
  }
  const listed = io.readdir(scratch).find((entry) => entry.name === 'j');
  if (!io.lstat(junction).isSymbolicLink() || !listed?.isSymbolicLink() || listed.isDirectory()
    || atOwnRealPath(junction)) return refuse('volume_junctions');
  return { ok: true, file, dev: seen.dev };
}

// A hard link from `file` to `link`, and the file's link count then 2.
function linksCount(file, link, io) {
  try {
    fs.linkSync(file, link);
    return io.lstat(file).nlink === 2n;
  } catch {
    return false;
  }
}

/**
 * What the Windows checks need from both volumes, proven in scratch folders `<staging>/upload_<id>` and
 * `<projects>/.jenny-probe-upload_<id>` (names the core's open and the install sweep remove if this stops part way):
 * file ids that are not zero and that a handle and an `lstat` agree on, and a junction that `lstat` and a listing
 * both name a link and a real path does not hide, on each volume; hard-link counting on the projects volume, which
 * the download listing's one-link rule relies on; and a link from staging into the projects root when the two share a
 * volume (the install links there). `io` replaces the handle stat, `lstat` and `readdir` (a test seam). `{ ok: true, shared }` or
 * `{ ok: false, reason }`; never a path.
 */
async function probeVolumes(stagingRoot, projectsRoot, id, io = IO) {
  const seams = { ...IO, ...io };
  if (!ownDirectory(stagingRoot) || !ownDirectory(projectsRoot)) return refuse('volume_root');
  const made = [];
  try {
    for (const scratch of [path.join(stagingRoot, `upload_${id}`), path.join(projectsRoot, `${PROBE_PREFIX}upload_${id}`)]) {
      fs.mkdirSync(scratch);
      made.push(scratch);
    }
    const staged = await probeIn(made[0], seams);
    if (!staged.ok) return staged;
    const projects = await probeIn(made[1], seams);
    if (!projects.ok) return projects;
    if (!linksCount(projects.file, path.join(made[1], 'h'), seams)) return refuse('volume_links');
    const shared = staged.dev === projects.dev;
    if (shared && !linksCount(staged.file, path.join(made[1], 's'), seams)) return refuse('volume_links');
    return { ok: true, shared };
  } catch {
    return refuse('volume_probe_failed');
  } finally {
    for (const scratch of made) await removeTree(scratch).catch(() => {});
  }
}

module.exports = {
  PROBE_PREFIX, WINDOWS, atOwnRealPath, nameHolds, openNoFollow, ownDirectory, probeVolumes, removeHolder,
  renameNoReplace, samePath,
};
