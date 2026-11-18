'use strict';

// The file IO of a team project folder for upload and download (slice 3-8b), and the primitives
// project-folders.js shares with it. project-folders.js builds it with its root and gate; every function takes
// a project id, and a relative path passes the segment rules before it is joined. A link is never entered or
// read through, and nothing that exists is written into or over.
//
// An install builds the new folder as `<projects root>/.jenny-install-<upload id>` and renames it to its final
// name last. That name lies outside every project folder, so no listing, measure or typed tool bound to a
// project folder ever sees it; it fails PROJECT_ID_PATTERN (a leading dot), so the project list never takes it
// for a project, and the trash sweep reads only the trash root. Slice 3-8c dropped 3-8b's trailing dot: Node
// keeps one (it writes through \\?\ paths), but Win32 tools cannot remove such a folder. `sweepInstalls`
// removes leftovers under either name at start and before a measure, both on the chain an install runs on.
//
// Windows (slice 3-8c): every open, create and the final rename go through file-checks.js; the roots and the install
// folder are checked by its `ownDirectory` (a real directory at its own real path), and every call that makes, links
// or unlinks a name checks the folder it lands in just before it runs, and the name just after.

const fs = require('node:fs');
const path = require('node:path');

const { removeTree } = require('../../services/fs-remove-no-follow');
const {
  WINDOWS, nameHolds, openNoFollow, ownDirectory, removeHolder, renameNoReplace,
} = require('./file-checks');
const { sensitiveSegment, validateRelativePath, validateSegment } = require('./path-segments');
const { UPLOAD_ID_PATTERN } = require('./transfer-core');

const fsp = fs.promises;
// Plain strings until the project reasons have one shared definition (see TEAM_PROJECTS_SPEC, 3-4f).
const PATH_INVALID = 'team_project_path_invalid';
const ROOT_UNAVAILABLE = 'team_project_root_unavailable';
const TARGET_EXISTS = 'team_upload_target_exists';
const INSTALL_FAILED = 'team_upload_install_failed';
const DOWNLOAD_CHANGED = 'team_download_changed';
// openNoFollow adds O_NOFOLLOW off Windows and its checks before and after on Windows.
const READ_FLAGS = fs.constants.O_RDONLY;
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
const COPY_CHUNK_BYTES = 1024 * 1024;
// Row 175 round 2: the prefix a read's `limitFor` sees (enough for every picture signature the reader view knows).
const HEAD_BYTES = 16;
// The walk yields to the event loop after this many entries.
const WALK_BATCH = 256;
const LIST_LIMIT = 4096;
// A walk or count stops at either cap (regular files taken, or entries read, so a tree of empty folders is
// bounded too).
const FILE_COUNT_CAP = 10_000;
const ENTRY_COUNT_CAP = 50_000;
// 3-8b's name had a trailing dot: a leftover under it on a POSIX host is still swept. `.jenny-probe-` is the
// volume probe's scratch folder (file-checks.js PROBE_PREFIX).
const INSTALL_TEMP = /^\.jenny-(?:install|probe)-(upload_[A-Za-z0-9_-]{22})\.?$/u;
// An install yields to the event loop, and re-identifies its folder, every this many files.
const INSTALL_BATCH = 64;
// Holders the final rename could not remove, kept for the next sweep.
const HOLDER_LIMIT = 64;

const refuse = (reason) => ({ ok: false, reason });
const absentCode = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
const installTempName = (uploadId) => `.jenny-install-${uploadId}`;

/**
 * 'present' (a directory by `lstat`, so never a link), 'absent' (ENOENT or ENOTDIR only) or 'unknown'. It reads no
 * real path (3-8c review): a project folder is checked directly under a root `ownDirectory` proved, a mount point
 * there fails its `lstat` (EISDIR); a folder on a listed file's way is proved by the file's own name check; the
 * install folder and the project folder at the install by `identity`; the final name by `renameNoReplace`.
 */
function entryState(file) {
  try {
    return fs.lstatSync(file).isDirectory() ? 'present' : 'unknown';
  } catch (error) {
    return absentCode(error) ? 'absent' : 'unknown';
  }
}

// At most `limit` names, and whether more were there; null when the folder cannot be read.
function readNames(root, limit) {
  let dir;
  try {
    dir = fs.opendirSync(root);
  } catch {
    return null;
  }
  const names = [];
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (names.length === limit) return { names, truncated: true };
      names.push(entry.name);
    }
    return { names, truncated: false };
  } catch {
    return null;
  } finally {
    try { dir.closeSync(); } catch { /* already closed */ }
  }
}

/**
 * Every entry under `top`, depth first: `{ full, name, entry }` with `name` the slash-joined relative path. It
 * descends into a directory by its entry type, which never names a link (on Windows any reparse point) a
 * directory, so no link is entered; a folder swapped for a link after it was listed throws before it is opened.
 * Throws when a folder cannot be read. One traversal for `countFiles` and the walk.
 */
function* treeEntries(top) {
  const pending = [[top, '']];
  while (pending.length > 0) {
    const [current, relative] = pending.pop();
    if (relative && entryState(current) !== 'present') throw new Error('folder_changed');
    const dir = fs.opendirSync(current);
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        const full = path.join(current, entry.name);
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) pending.push([full, name]);
        yield { full, name, entry };
      }
    } finally {
      try { dir.closeSync(); } catch { /* already closed */ }
    }
  }
}

function identity(folder) {
  const stat = ownDirectory(folder);
  return stat ? { dev: stat.dev, ino: stat.ino } : null;
}

// Windows: a folder this install made is still that directory, by `lstat` alone (a junction or another folder swapped
// in fails it), checked just before each call that makes or links a name in it. POSIX: O_NOFOLLOW and the
// re-identify of the install folder cover it, as in 3-8b.
function intact(folder, made) {
  if (!WINDOWS) return true;
  try {
    const stat = fs.lstatSync(folder, { bigint: true });
    return stat.isDirectory() && stat.dev === made.dev && stat.ino === made.ino;
  } catch {
    return false;
  }
}

// Windows: the staged file's folder is still a directory (not a link) just before the staged name is unlinked.
function stagedParent(file) {
  if (!WINDOWS) return true;
  try {
    return fs.lstatSync(path.dirname(file)).isDirectory();
  } catch {
    return false;
  }
}

// The folder is still the directory this install made, at its own real path.
function sameFolder(folder, made) {
  const now = identity(folder);
  return now !== null && now.dev === made.dev && now.ino === made.ino;
}

// One fsync of a directory, so the names in it last; best effort. Windows opens a directory but refuses its fsync
// (EPERM), so there it does nothing: NTFS logs the names itself, and the start-up sweeps take what a crash leaves.
async function syncDirectory(folder) {
  let handle = null;
  try {
    handle = await fsp.open(folder, fs.constants.O_RDONLY);
    await handle.sync();
  } catch { /* best effort */ } finally {
    await handle?.close().catch(() => {});
  }
}

async function copyInto(source, destination, size) {
  const input = await openNoFollow(source, READ_FLAGS);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size !== size) throw new Error('staged_changed');
    const output = await openNoFollow(destination, CREATE_FLAGS, 0o644);
    try {
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(COPY_CHUNK_BYTES, size)));
      let done = 0;
      while (done < size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - done), done);
        if (bytesRead <= 0) throw new Error('staged_short');
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, done + written);
          if (result.bytesWritten <= 0) throw new Error('write_short');
          written += result.bytesWritten;
        }
        done += bytesRead;
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

// Every file of one install, linked or copied, synced in one pass once every file is in place (3-8b review item 15;
// review sweeps, second run, X4b-F01: a linked file's bytes were only ever written to the page cache by the upload).
const SYNC_POOL = 8;
async function syncFiles(files) {
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const handle = await openNoFollow(files[next++], fs.constants.O_WRONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SYNC_POOL, files.length) }, worker));
}

class InstallStop extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// The first `length` bytes of an open file by positioned reads (fewer when it ends sooner).
async function readPrefix(handle, length) {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(bytes, done, length - done, done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return bytes.subarray(0, done);
}

/**
 * projects: the projects root. gate(projectId): null or the refusal (the id, then the root). rootReady(): the
 * root is usable. entryCap, fileCap: the walk caps. hardLinks: false forces the copy (a test seam).
 */
function createFolderTransfer({ projects, gate, rootReady, log, entryCap, fileCap, hardLinks = true }) {
  /** 'absent', 'present' or 'unknown' for one top-level name in a project folder; a bad name is refused. */
  function childState(projectId, name) {
    const refused = gate(projectId);
    if (refused) return refused;
    if (!validateSegment(name).ok) return refuse(PATH_INVALID);
    const top = path.join(projects, projectId);
    if (entryState(top) !== 'present') return refuse(ROOT_UNAVAILABLE);
    return { ok: true, state: entryState(path.join(top, name)) };
  }

  // Every entry under a present project folder, nothing followed: `onFile(relative, stat)` for each regular file
  // (by lstat) answers true (taken) or false (skipped); a link, a junction or anything not a regular file or
  // directory is skipped and counted. It yields every WALK_BATCH entries and checks the root again after each
  // yield. Stops at the entry cap or `maxFiles` taken files (`capped: true`).
  async function walk(projectId, onFile, maxFiles = Infinity) {
    const refused = gate(projectId);
    if (refused) return refused;
    const top = path.join(projects, projectId);
    const state = entryState(top);
    if (state === 'absent') return { ok: true, skipped: 0, capped: false };
    if (state !== 'present') return refuse(ROOT_UNAVAILABLE);
    let entries = 0;
    let taken = 0;
    let skipped = 0;
    try {
      for (const { full, name, entry } of treeEntries(top)) {
        entries += 1;
        if (entries > entryCap || taken >= maxFiles) return { ok: true, skipped, capped: true };
        if (entries % WALK_BATCH === 0) {
          await new Promise((resolve) => { setImmediate(resolve); });
          if (gate(projectId) || entryState(top) !== 'present') return refuse(ROOT_UNAVAILABLE);
        }
        if (entry.isDirectory()) continue;
        const stat = entry.isFile() ? fs.lstatSync(full, { bigint: true }) : null;
        if (stat?.isFile() && onFile(name, stat)) taken += 1;
        else skipped += 1;
      }
    } catch {
      return refuse(ROOT_UNAVAILABLE);
    }
    return { ok: true, skipped, capped: false };
  }

  /**
   * The byte measure: regular files summed by lstat size, nothing followed, what is skipped counted. `capped:
   * true` when it stopped at the entry cap (the caller counts that project as full).
   */
  async function measure(projectId) {
    let bytes = 0;
    let files = 0;
    const walked = await walk(projectId, (_name, stat) => { bytes += Number(stat.size); files += 1; return true; });
    return walked.ok ? { ok: true, bytes, files, skipped: walked.skipped, capped: walked.capped } : walked;
  }

  /**
   * The download listing: `{ path, size, dev, ino, mtimeNs }` per regular file with one link whose relative path
   * passes the segment rules; a link, a junction, a hard-linked file, a name the rules refuse, a path with a segment
   * on the sensitive list (E69: .git, .github, .vscode, .env, .jenny, case folded; the file stays on disk) and
   * anything not a regular file are skipped and counted. At most `fileCap` files (then `capped: true`).
   */
  async function listFiles(projectId) {
    const files = [];
    const walked = await walk(projectId, (name, stat) => {
      if (stat.nlink !== 1n || !validateRelativePath(name).ok || sensitiveSegment(name) !== null) return false;
      files.push(Object.freeze({ path: name, size: Number(stat.size), dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs }));
      return true;
    }, fileCap);
    return walked.ok ? { ok: true, files, skipped: walked.skipped, capped: walked.capped } : walked;
  }

  /**
   * Opens a listed file to read it: every folder on the way a directory by `lstat`, then openNoFollow (POSIX: the
   * file a regular file by `lstat`, opened O_NOFOLLOW; Windows: its checks before and after, whose name check proves
   * every folder on the way), and the opened file a regular file with one link whose device, inode, size and
   * modification time equal `expect`'s. `{ ok, handle }` (the caller closes it) or a refusal.
   */
  async function openListed(projectId, relative, expect) {
    const refused = gate(projectId);
    if (refused) return refused;
    if (!validateRelativePath(relative).ok) return refuse(PATH_INVALID);
    const segments = relative.split('/');
    let current = path.join(projects, projectId);
    if (entryState(current) !== 'present') return refuse(DOWNLOAD_CHANGED);
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      if (entryState(current) !== 'present') return refuse(DOWNLOAD_CHANGED);
    }
    const file = path.join(current, segments[segments.length - 1]);
    let handle = null;
    try {
      if (!WINDOWS && !fs.lstatSync(file).isFile()) return refuse(DOWNLOAD_CHANGED);
      handle = await openNoFollow(file, READ_FLAGS);
      const stat = await handle.stat({ bigint: true });
      if (stat.isFile() && stat.nlink === 1n && stat.dev === expect.dev && stat.ino === expect.ino
        && stat.size === BigInt(expect.size) && stat.mtimeNs === expect.mtimeNs) return { ok: true, handle };
    } catch { /* refused below */ }
    if (handle) await handle.close().catch(() => {});
    return refuse(DOWNLOAD_CHANGED);
  }

  /**
   * Row 175 wave 5: the first `maxBytes` of one file the download listing would offer, read through `openListed`
   * (every folder on the way a directory by `lstat`, the file opened without following a link, then re-identified
   * by device, inode, size and modification time). PATH_INVALID for a path the rules or the sensitive list refuse;
   * DOWNLOAD_CHANGED for anything else that is not a regular file with one link (missing, a folder, a link, a
   * junction on the way, a hard-linked file). `{ ok, size, bytes }`.
   * Row 175 round 2 (D13): `limitFor(head, size)`, when given, sees the file's first HEAD_BYTES (fewer for a shorter
   * file) through the same open handle and answers how many bytes to read instead of `maxBytes` (0 for none); the
   * answer then carries `head` too.
   */
  async function readListed(projectId, relative, maxBytes, { limitFor = null } = {}) {
    const refused = gate(projectId);
    if (refused) return refused;
    if (!validateRelativePath(relative).ok || sensitiveSegment(relative) !== null) return refuse(PATH_INVALID);
    let stat;
    try {
      stat = fs.lstatSync(path.join(projects, projectId, ...relative.split('/')), { bigint: true });
    } catch {
      return refuse(DOWNLOAD_CHANGED);
    }
    if (!stat.isFile() || stat.nlink !== 1n) return refuse(DOWNLOAD_CHANGED);
    const size = Number(stat.size);
    const opened = await openListed(projectId, relative, { dev: stat.dev, ino: stat.ino, size, mtimeNs: stat.mtimeNs });
    if (!opened.ok) return opened;
    try {
      if (typeof limitFor !== 'function') return { ok: true, size, bytes: await readPrefix(opened.handle, Math.min(size, maxBytes)) };
      const head = await readPrefix(opened.handle, Math.min(size, HEAD_BYTES));
      const limit = limitFor(head, size);
      return { ok: true, size, head, bytes: await readPrefix(opened.handle, Math.min(size, limit)) };
    } catch {
      return refuse(DOWNLOAD_CHANGED);
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }

  // Holders of a final name the install could not remove (a lock); the sweep tries them again.
  const leftHolders = [];
  function keepHolder(projectId, holder) {
    if (leftHolders.length < HOLDER_LIMIT) leftHolders.push(holder);
    log('WARN', 'team.project_files.holder_left', { project_id: projectId });
  }

  /**
   * Removes every install and probe folder a stopped install or start left under the projects root, and every
   * holder this process could not remove (while it is still that empty file); the count of folders removed.
   */
  async function sweepInstalls() {
    if (!rootReady()) return 0;
    for (const holder of leftHolders.splice(0)) {
      if (!removeHolder(holder)) leftHolders.push(holder);
    }
    const read = readNames(projects, LIST_LIMIT);
    let removed = 0;
    for (const name of read?.names ?? []) {
      const match = INSTALL_TEMP.exec(name);
      if (!match || !UPLOAD_ID_PATTERN.test(match[1]) || !rootReady()) continue;
      try {
        await removeTree(path.join(projects, name));
        removed += 1;
      } catch {
        log('WARN', 'team.project_files.install_sweep_failed', {});
      }
    }
    if (removed > 0) log('INFO', 'team.project_files.install_swept', { count: removed });
    return removed;
  }

  // Same device as the new folder: an exclusive hard link to the staged file (it fails on anything already at
  // the name and never follows a link there), checked, then the staged name unlinked so the file keeps one
  // link. Another device, or `hardLinks: false`: an exclusive no-follow copy. Either way the caller syncs the file
  // before the install answers. True when linked. On Windows the staged name is checked at its own real path first,
  // the folder it lands in just before the link, the linked name after it, and the staged folder just before the
  // unlink.
  async function placeFile(entry, destination, folderDev, folder) {
    const staged = fs.lstatSync(entry.stagedPath, { bigint: true });
    if (!staged.isFile() || staged.size !== BigInt(entry.size) || staged.nlink !== 1n) throw new Error('staged_changed');
    if (!nameHolds(entry.stagedPath)) throw new Error('staged_changed');
    if (hardLinks && staged.dev === folderDev) {
      if (!intact(path.dirname(destination), folder)) throw new Error('folder_moved');
      fs.linkSync(entry.stagedPath, destination);
      const placed = fs.lstatSync(destination, { bigint: true });
      if (!placed.isFile() || placed.ino !== staged.ino || placed.size !== staged.size || !nameHolds(destination)) {
        throw new Error('link_changed');
      }
      if (!stagedParent(entry.stagedPath)) throw new Error('staged_changed');
      fs.unlinkSync(entry.stagedPath);
      return true;
    }
    await copyInto(entry.stagedPath, destination, entry.size);
    return false;
  }

  // Every file into the install folder. It yields and re-identifies the install folder every INSTALL_BATCH files and
  // before each folder it makes; each folder made is checked by name after its mkdir and by `intact` before use.
  async function buildInto(temp, made, files) {
    const folders = new Map([[temp, made]]);
    const placed = [];
    let bytes = 0;
    let linked = 0;
    for (const [index, entry] of files.entries()) {
      if (index % INSTALL_BATCH === 0) {
        if (index > 0) await new Promise((resolve) => { setImmediate(resolve); });
        if (!sameFolder(temp, made)) throw new Error('folder_moved');
      }
      const segments = entry.path.split('/');
      let current = temp;
      for (const segment of segments.slice(0, -1)) {
        const parent = current;
        current = path.join(current, segment);
        if (folders.has(current)) continue;
        if (!sameFolder(temp, made) || !intact(parent, folders.get(parent))) throw new Error('folder_moved');
        fs.mkdirSync(current);
        const stat = fs.lstatSync(current, { bigint: true });
        if (!stat.isDirectory() || !nameHolds(current)) throw new Error('folder_moved');
        folders.set(current, { dev: stat.dev, ino: stat.ino });
      }
      const destination = path.join(current, segments[segments.length - 1]);
      if (await placeFile(entry, destination, made.dev, folders.get(current))) linked += 1;
      placed.push(destination);
      bytes += entry.size;
    }
    await syncFiles(placed);
    return { bytes, linked };
  }

  /**
   * Installs a verified upload as one new top-level folder of the project. The files go into the install folder
   * (`.jenny-install-<upload id>` under the projects root, made exclusively right after `childState` checked the
   * root, with nothing awaited between), re-identified every INSTALL_BATCH files and before each folder it makes;
   * then, with `folderName` absent and the project folder still a real directory at its own path, one rename
   * gives it its final name. POSIX rename replaces only an empty directory: an empty folder made at that name
   * between the check and the rename is replaced, which loses nothing; anything else there fails the rename.
   * Windows rename would put the folder over a file, so file-checks.js `renameNoReplace` holds the name first:
   * anything there answers target exists, and a directory raced in after the hold fails the install.
   * `files`: `[{ path, size, stagedPath }]`. A failure removes the install folder (only while it is still the one
   * this call made, or by its name when its identity could not be read right after the mkdir) and answers
   * `team_upload_target_exists` or `team_upload_install_failed`. `ready()` runs last before the rename, with nothing
   * awaited between them on POSIX: a reason it answers stops the install with that reason (review round two,
   * R15-F03: a turn that started during the build).
   */
  async function install(projectId, folderName, uploadId, files, { ready = () => null } = {}) {
    const state = childState(projectId, folderName);
    if (!state.ok) return state;
    if (state.state !== 'absent') return refuse(TARGET_EXISTS);
    if (typeof uploadId !== 'string' || !UPLOAD_ID_PATTERN.test(uploadId)
      || !files.every((entry) => validateRelativePath(entry.path).ok)) return refuse(PATH_INVALID);
    const project = path.join(projects, projectId);
    const temp = path.join(projects, installTempName(uploadId));
    const target = path.join(project, folderName);
    try {
      fs.mkdirSync(temp);
    } catch {
      log('WARN', 'team.project_files.install_failed', { project_id: projectId, reason: INSTALL_FAILED });
      return refuse(INSTALL_FAILED);
    }
    const made = identity(temp);
    try {
      if (made === null) throw new Error('folder_moved');
      const built = await buildInto(temp, made, files);
      await syncDirectory(temp);
      if (!sameFolder(temp, made) || identity(project) === null || gate(projectId)) throw new Error('folder_moved');
      if (entryState(target) !== 'absent') throw new InstallStop(TARGET_EXISTS);
      const stop = ready();
      if (stop) throw new InstallStop(stop);
      try {
        await renameNoReplace(temp, target, { onLeft: (holder) => keepHolder(projectId, holder) });
      } catch (error) {
        throw new InstallStop(['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(error?.code) ? TARGET_EXISTS : INSTALL_FAILED);
      }
      await syncDirectory(project);
      return { ok: true, files: files.length, bytes: built.bytes, linked: built.linked };
    } catch (error) {
      // Only the folder this call made: while it is still that folder, or by the name it was made under when its
      // identity could not be read at once (the remover unlinks a link there and never enters it).
      if (made === null || sameFolder(temp, made)) {
        try { await removeTree(temp); } catch { log('WARN', 'team.project_files.install_cleanup_failed', { project_id: projectId }); }
      }
      const reason = error instanceof InstallStop ? error.reason : INSTALL_FAILED;
      log('WARN', 'team.project_files.install_failed', { project_id: projectId, reason });
      return refuse(reason);
    }
  }

  return { childState, measure, listFiles, openListed, readListed, sweepInstalls, install };
}

module.exports = {
  DOWNLOAD_CHANGED, ENTRY_COUNT_CAP, FILE_COUNT_CAP, INSTALL_FAILED, PATH_INVALID, ROOT_UNAVAILABLE, TARGET_EXISTS,
  absentCode, createFolderTransfer, entryState, installTempName, readNames, refuse, treeEntries,
};
