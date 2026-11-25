'use strict';

// File-tree helpers for deleting, setting aside, exporting and restoring a hosted team (slice 5-6). No Electron.
//
// Containment: every path a caller removes, renames, writes or restores is resolved to its real path
// (`fs.realpathSync.native`) and checked to be inside a root it names (`<userData>/team-host/`, or the folder
// the owner picked) before the operation, so a symlink, junction, 8.3 name or `subst` drive cannot point an
// operation outside it. A link met inside a tree is never followed: walking counts it as a link, removing
// refuses the whole tree before anything is removed. services/fs-contained.js is not used: it resolves fixed
// segments below a base one step at a time, and these callers need a whole tree walked, a rename between two
// contained paths, a not-yet-existing target's parent, and a folder the owner picked outside the profile.
// Nothing here logs.
//
// The walks take each entry's kind from the directory listing (no `lstat` per entry; a file's size needs
// one). The asynchronous forms yield to the event loop every YIELD_EVERY entries and size a batch's files with
// the asynchronous `lstat`, SIZE_CONCURRENCY at a time, so main keeps answering and the host child's watchdog
// keeps its pings while a large team is exported, counted or removed.

const fs = require('node:fs');
const path = require('node:path');

const { removeTree, removeTreeSync } = require('../../fs-remove-no-follow');

const WINDOWS = process.platform === 'win32';
const fold = (value) => (WINDOWS ? value.toLowerCase() : value);
const DEFAULT_LIMIT = 2_000_000;
const YIELD_EVERY = 64;
const SIZE_CONCURRENCY = 16;
// The stores' JSON files, as the inventory and the export read them (a segment, an index, the member store).
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const SEGMENT = /^seg-([1-9][0-9]{0,8})\.json$/u;

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);

/** One store JSON file, refused when it is not a regular file or larger than MAX_JSON_BYTES. */
function readJsonFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error('unreadable');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** True when `child` is `parent` or under it (both already real, absolute paths). */
function isWithin(parent, child) {
  const base = fold(path.resolve(parent));
  const target = fold(path.resolve(child));
  if (target === base) return true;
  return target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/** The real path of an existing `target` when it lies inside the real `root`, else null; never throws. */
function realInside(root, target) {
  try {
    const realRoot = fs.realpathSync.native(root);
    const real = fs.realpathSync.native(target);
    return isWithin(realRoot, real) ? real : null;
  } catch {
    return null;
  }
}

/** The real path of a not-yet-existing `target` whose parent lies inside `root`, else null. */
function realParentInside(root, target) {
  const parent = realInside(root, path.dirname(target));
  return parent ? path.join(parent, path.basename(target)) : null;
}

// One listed entry: 'link', 'dir', 'file' or 'other', from the listing alone.
const kindOf = (entry) => {
  if (entry.isSymbolicLink()) return 'link';
  if (entry.isDirectory()) return 'dir';
  return entry.isFile() ? 'file' : 'other';
};

function newTotals() {
  return { files: 0, bytes: 0, dirs: 0, links: 0, unreadable: 0, truncated: false, linkPaths: [] };
}

// Counts one listed entry into `totals`; answers the kind and, for a file, its size (or null when unreadable).
function countEntry(totals, entry, childRel, abs, statSize) {
  const kind = kindOf(entry);
  if (kind === 'link') {
    totals.links += 1;
    if (totals.linkPaths.length < 8) totals.linkPaths.push(childRel);
  } else if (kind === 'dir') {
    totals.dirs += 1;
  } else if (kind === 'file') {
    const size = statSize(abs);
    if (size === null) { totals.unreadable += 1; return { kind: 'other' }; }
    totals.files += 1;
    totals.bytes += size;
    return { kind, size };
  } else {
    totals.unreadable += 1;
  }
  return { kind };
}

const sizeSync = (abs) => { try { return fs.lstatSync(abs).size; } catch { return null; } };
const sizeAsync = async (abs) => { try { return (await fs.promises.lstat(abs)).size; } catch { return null; } };

// The sizes of the listed files in `batch` (null for any other entry or an unreadable file), SIZE_CONCURRENCY at a time.
async function sizesOf(dir, rel, batch) {
  const sizes = new Array(batch.length).fill(null);
  const wanted = batch.flatMap((entry, at) => (kindOf(entry) === 'file' ? [at] : []));
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const at = wanted[next]; next += 1;
      sizes[at] = await sizeAsync(path.join(dir, rel, batch[at].name));
    }
  };
  await Promise.all(Array.from({ length: Math.min(SIZE_CONCURRENCY, wanted.length) }, worker));
  return sizes;
}

// The entries under `dir`, depth first, never following a link: { files, bytes, dirs, links, unreadable,
// truncated, linkPaths }. `onFile(rel, abs, size)` for each regular file, `onDir(rel, abs)` for each folder;
// `limit` (entries) bounds the walk and sets `truncated`.
function walkTree(dir, { onFile = null, onDir = null, limit = DEFAULT_LIMIT } = {}) {
  const totals = newTotals();
  let seen = 0;
  const pending = [''];
  while (pending.length) {
    const rel = pending.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { totals.unreadable += 1; continue; }
    for (const entry of entries) {
      seen += 1;
      if (seen > limit) { totals.truncated = true; return totals; }
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const abs = path.join(dir, childRel);
      const { kind, size } = countEntry(totals, entry, childRel, abs, sizeSync);
      if (kind === 'dir') { if (onDir) onDir(childRel, abs); pending.push(childRel); }
      else if (kind === 'file' && onFile) onFile(childRel, abs, size);
    }
  }
  return totals;
}

/** walkTree's asynchronous form: the callbacks may be async, and the walk yields every YIELD_EVERY entries. */
async function walkTreeAsync(dir, { onFile = null, onDir = null, limit = DEFAULT_LIMIT } = {}) {
  const totals = newTotals();
  let seen = 0;
  const pending = [''];
  while (pending.length) {
    const rel = pending.pop();
    let entries;
    try { entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { totals.unreadable += 1; continue; }
    for (let from = 0; from < entries.length; from += YIELD_EVERY) {
      const batch = entries.slice(from, from + YIELD_EVERY);
      const sizes = await sizesOf(dir, rel, batch);
      for (const [at, entry] of batch.entries()) {
        seen += 1;
        if (seen > limit) { totals.truncated = true; return totals; }
        const childRel = rel ? path.join(rel, entry.name) : entry.name;
        const abs = path.join(dir, childRel);
        const { kind, size } = countEntry(totals, entry, childRel, abs, () => sizes[at]);
        if (kind === 'dir') { if (onDir) await onDir(childRel, abs); pending.push(childRel); }
        else if (kind === 'file' && onFile) await onFile(childRel, abs, size);
      }
      if (batch.length === YIELD_EVERY) await tick();
    }
  }
  return totals;
}

// True when `target` itself is a link (a junction on Windows reads as one through lstat).
function isLinkPath(target) {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

// The checks before a removal: absent (ok), a link or outside (refused), else the target to remove.
function removable(root, target, scanned) {
  try { fs.lstatSync(target); } catch (error) { if (error?.code === 'ENOENT') return { ok: true, gone: true }; }
  if (isLinkPath(target)) return { ok: false, reason: 'link' };
  if (!realInside(root, target)) return { ok: false, reason: 'outside' };
  if (!scanned && walkTree(target).links > 0) return { ok: false, reason: 'link' };
  return { ok: true, gone: false };
}

/**
 * Removes the tree at `target` inside `root`. Refuses (nothing removed) when `target` is not inside `root`,
 * is itself a link, or holds a link anywhere: { ok: false, reason: 'outside' | 'link' }. A removal that fails
 * part way answers { ok: false, reason: 'held' }. An absent target is { ok: true }.
 */
function removeTreeInside(root, target, { ops = fs } = {}) {
  const checked = removable(root, target, false);
  if (!checked.ok || checked.gone) return checked.ok ? { ok: true } : checked;
  try { removeTreeSync(target, { fsImpl: ops, retries: 0 }); } catch { return { ok: false, reason: 'held' }; }
  return { ok: true };
}

/**
 * removeTreeInside's asynchronous form, for the large trees (a staging folder, an old team, a leftover).
 * `scanned`: the caller already walked the tree and found no link, so it is not walked again.
 */
async function removeTreeInsideAsync(root, target, { ops = fs, scanned = false } = {}) {
  const checked = removable(root, target, true);
  if (!checked.ok || checked.gone) return checked.ok ? { ok: true } : checked;
  if (!scanned && (await walkTreeAsync(target)).links > 0) return { ok: false, reason: 'link' };
  try { await removeTree(target, { fsImpl: ops, retries: 1 }); } catch { return { ok: false, reason: 'held' }; }
  return { ok: true };
}

/** Removes one file inside `root` (absent is fine); true when it is gone. */
function removeFileInside(root, target, { ops = fs } = {}) {
  try { fs.lstatSync(target); } catch (error) { if (error?.code === 'ENOENT') return true; }
  if (isLinkPath(target) || !realInside(root, target)) return false;
  try { ops.unlinkSync(target); return true; } catch { return false; }
}

/** Renames `from` to `to`, both inside `root` (`to` must not exist); true when it moved. */
function renameInside(root, from, to, { ops = fs } = {}) {
  if (isLinkPath(from) || !realInside(root, from) || !realParentInside(root, to)) return false;
  try { fs.lstatSync(to); return false; } catch { /* free, as it must be */ }
  try { ops.renameSync(from, to); return true; } catch { return false; }
}

/**
 * Copies the tree `from` to `to` (which must not exist), asynchronously, file by file. A link or an entry that
 * cannot be read is counted, not copied: the caller decides from the totals whether the copy stands.
 */
async function copyTreeAsync(from, to, { limit = DEFAULT_LIMIT } = {}) {
  await fs.promises.mkdir(to, { recursive: false });
  return walkTreeAsync(from, {
    limit,
    onDir: (rel) => fs.promises.mkdir(path.join(to, rel), { recursive: true }),
    onFile: (rel, abs) => fs.promises.copyFile(abs, path.join(to, rel), fs.constants.COPYFILE_EXCL),
  });
}

module.exports = {
  MAX_JSON_BYTES, SEGMENT, copyTreeAsync, isLinkPath, isRecord, isWithin, list, readJsonFile, realInside, realParentInside,
  removeFileInside, removeTreeInside, removeTreeInsideAsync, renameInside, tick, walkTree, walkTreeAsync,
};
