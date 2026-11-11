'use strict';
// Row 106 sync-in: the host side of the synced-workspace sandbox. Commands run in a Docker volume that
// mirrors the folder; this module walks the folder with lstat only, compares it with the index of what
// the mirror last received, and stages a delta (changed files, deletions, resync paths) into a read-only
// staging directory the worker applies before the command. Links, junctions and special files are
// skipped and never followed; git, venv and Jenny folders never enter the mirror. The state digest the
// approval binds to is content-based (path, size, sha256), and admission re-walks the folder to refuse
// any drift with the copy mode's `snapshot_changed`.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { mapWithConcurrency } = require('../bounded-concurrency');
const { sandboxError, digest } = require('./sandbox-errors');
const { removeSnapshot, inside } = require('./desktop-workspace-snapshot');
const { removeFile } = require('../fs-remove-no-follow');
const { PROTECTED_NAMES, foldName, isSyncExcluded, discoverProtectionPolicy, gitDirFromGitfile,
  protectionPolicy } = require('./sandbox-protected-paths');

const SYNCED_LIMITS = Object.freeze({ bytes: 4 * 1024 ** 3, entries: 200000, depth: 64, pathBytes: 4096 });
const INDEX_SCHEMA = 1;
const COPY_CONCURRENCY = 8;
const CHUNK = 1024 * 1024;
const GITFILE_LIMIT = 4096;

function mirrorIdFor(rootIdentity) {
  return digest(['mirror', rootIdentity]).slice(0, 16);
}

async function assertRealDirectory(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw sandboxError('snapshot_directory_invalid');
  if (path.resolve(await fs.realpath(directory)) !== path.resolve(directory)) throw sandboxError('snapshot_reparse_point');
  return info;
}

function sameFile(entry, info) {
  return entry.size === Number(info.size) && entry.mtimeNs === String(info.mtimeNs) && entry.ino === String(info.ino);
}

function checkSignal(signal) {
  if (signal?.aborted) throw sandboxError('sandbox_cancelled');
}

// Phase 1: lstat-only walk. Returns path -> {dir:true} | {size, mtimeNs, ino}, plus skipped links and
// special files and any gitfiles met (their in-root gitdirs join the policy).
async function scanFolder({ root, policy, limits, signal }) {
  const entries = new Map();
  const skipped = [];
  const gitfiles = [];
  let count = 0;
  let bytes = 0;
  async function visit(directory, prefix, depth) {
    checkSignal(signal);
    const handle = await fs.opendir(directory);
    for await (const dirent of handle) {
      checkSignal(signal);
      count += 1;
      const name = dirent.name;
      const relative = prefix ? prefix + '/' + name : name;
      if (count > limits.entries || depth > limits.depth || Buffer.byteLength(relative) > limits.pathBytes
        || name.includes('\0')) throw sandboxError('snapshot_limit');
      const full = path.join(directory, name);
      let info;
      try { info = await fs.lstat(full, { bigint: true }); }
      catch { skipped.push({ path: relative, reason: 'unreadable' }); continue; }
      if (foldName(name) === '.git' && info.isFile() && !info.isSymbolicLink() && info.size <= GITFILE_LIMIT) gitfiles.push(relative);
      if (isSyncExcluded(relative, policy)) continue;
      if (info.isSymbolicLink()) { skipped.push({ path: relative, reason: 'link' }); continue; }
      if (info.isDirectory()) {
        // A mount point or other directory reparse point resolves somewhere else: never entered.
        let real;
        try { real = path.resolve(await fs.realpath(full)); } catch { real = null; }
        if (real !== path.resolve(full)) { skipped.push({ path: relative, reason: 'link' }); continue; }
        entries.set(relative, { dir: true });
        await visit(full, relative, depth + 1);
      } else if (info.isFile()) {
        bytes += Number(info.size);
        if (bytes > limits.bytes) throw sandboxError('snapshot_limit');
        entries.set(relative, { size: Number(info.size), mtimeNs: String(info.mtimeNs), ino: String(info.ino) });
      } else skipped.push({ path: relative, reason: 'special' });
    }
  }
  await visit(root, '', 1);
  return { entries, skipped, gitfiles, bytes };
}

async function scanWithPolicy({ root, policy, limits, signal }) {
  const scan = await scanFolder({ root, policy, limits, signal });
  const gitDirs = new Set(policy.gitDirs);
  for (const gitfile of scan.gitfiles) {
    let text = '';
    try { text = await fs.readFile(path.join(root, ...gitfile.split('/')), 'utf8'); } catch { /* unreadable gitfile names nothing */ }
    const gitDir = gitDirFromGitfile(root, gitfile, text);
    if (gitDir) gitDirs.add(gitDir);
  }
  const finalPolicy = protectionPolicy({ ...policy, gitDirs: [...gitDirs] });
  if (finalPolicy.gitDirs.length !== policy.gitDirs.length) {
    for (const relative of [...scan.entries.keys()]) {
      if (isSyncExcluded(relative, finalPolicy)) scan.entries.delete(relative);
    }
  }
  return { ...scan, policy: finalPolicy };
}

function sortedEntries(entries) {
  return [...entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function stateDigest(entries) {
  return digest(sortedEntries(entries).map(([relative, entry]) => (entry.dir ? [relative, 'd'] : [relative, entry.size, entry.sha256])));
}

function emptyIndex() {
  return { entries: new Map(), resync: new Set(), trees: new Set(), full: true };
}

async function readMirrorIndex(indexFile, { root, rootIdentity }) {
  let raw;
  try {
    const info = await fs.lstat(indexFile);
    if (!info.isFile() || info.isSymbolicLink()) return emptyIndex();
    raw = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  } catch { return emptyIndex(); }
  if (!raw || raw.schema_version !== INDEX_SCHEMA || raw.root !== path.resolve(root) || raw.root_identity !== rootIdentity
    || raw.full !== false || !Array.isArray(raw.entries) || !Array.isArray(raw.resync) || !Array.isArray(raw.trees)) return emptyIndex();
  const entries = new Map();
  for (const item of raw.entries) {
    if (!Array.isArray(item) || typeof item[0] !== 'string') return emptyIndex();
    if (item.length === 2 && item[1] === 'd') entries.set(item[0], { dir: true });
    else if (item.length === 5 && Number.isSafeInteger(item[1]) && typeof item[2] === 'string' && typeof item[3] === 'string'
      && /^[a-f0-9]{64}$/u.test(item[4])) entries.set(item[0], { size: item[1], mtimeNs: item[2], ino: item[3], sha256: item[4] });
    else return emptyIndex();
  }
  const strings = (list) => new Set(list.filter((value) => typeof value === 'string' && value));
  return { entries, resync: strings(raw.resync), trees: strings(raw.trees), full: false };
}

async function writeAtomically(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } catch (error) {
    await removeFile(temp).catch(() => {});
    throw error;
  }
}

// outcome: {index: Map of the folder state the mirror now matches, resync: paths, trees: subtrees, full}.
async function commitMirrorIndex(indexFile, stage, { index, resync = new Set(), trees = new Set(), full = false }) {
  if (full) return invalidateMirrorIndex(indexFile);
  const entries = sortedEntries(index).map(([relative, entry]) => (entry.dir ? [relative, 'd']
    : [relative, entry.size, entry.mtimeNs, entry.ino, entry.sha256]));
  await writeAtomically(indexFile, JSON.stringify({ schema_version: INDEX_SCHEMA, root: path.resolve(stage.root),
    root_identity: stage.rootIdentity, mirror_id: stage.mirrorId, full: false, entries,
    resync: [...resync].sort(), trees: [...trees].sort(), updated_at: new Date().toISOString() }));
}

async function invalidateMirrorIndex(indexFile) {
  await removeFile(indexFile);
}

// Exact-case on purpose: the mirror is case-sensitive, so a `NODE_MODULES` tree is not `node_modules`.
function underAny(relative, prefixes) {
  return prefixes.some((prefix) => relative === prefix || relative.startsWith(prefix + '/'));
}

// The paths no other listed path contains: O(depth) per path, so a mass delete stays linear.
function topmost(paths) {
  const unique = new Set(paths);
  return [...unique].sort().filter((relative) => {
    for (let at = relative.indexOf('/'); at !== -1; at = relative.indexOf('/', at + 1)) {
      if (unique.has(relative.slice(0, at))) return false;
    }
    return true;
  });
}

// Phase 2 helper: copy one folder file into staging while hashing it; the source must not change.
async function copyAndHash(source, target, entry, signal) {
  const input = await fs.open(source, 'r');
  try {
    if (!sameFile(entry, await input.stat({ bigint: true }))) throw sandboxError('snapshot_changed');
    const output = await fs.open(target, 'wx', 0o444);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, entry.size)));
    let offset = 0;
    try {
      for (;;) {
        checkSignal(signal);
        const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        await output.write(buffer, 0, bytesRead);
        offset += bytesRead;
        if (offset > entry.size) throw sandboxError('snapshot_changed');
      }
    } finally { await output.close(); }
    if (offset !== entry.size || !sameFile(entry, await input.stat({ bigint: true }))
      || !sameFile(entry, await fs.lstat(source, { bigint: true }))) throw sandboxError('snapshot_changed');
    return hash.digest('hex');
  } finally { await input.close(); }
}

function protectedForWorker(policy) {
  return { names: [...PROTECTED_NAMES], paths: [...policy.hooks, ...policy.includes, ...policy.gitDirs] };
}

// indexFile, or indexDirectory holding one `<mirrorId>.json` per folder.
async function stageMirrorSync({ root, stagingRoot, indexFile = null, indexDirectory = null, forbiddenRoots = [], signal,
  limits = SYNCED_LIMITS, id: requestedId = null }) {
  root = path.resolve(root);
  checkSignal(signal);
  const rootInfo = await assertRealDirectory(root);
  const rootIdentity = digest([root, rootInfo.dev, rootInfo.ino]);
  const mirrorId = mirrorIdFor(rootIdentity);
  if (!indexFile) indexFile = path.join(indexDirectory, mirrorId + '.json');
  for (const forbidden of forbiddenRoots) {
    if (inside(root, path.resolve(forbidden)) || inside(path.resolve(forbidden), root)) throw sandboxError('snapshot_profile_overlap');
  }
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await assertRealDirectory(stagingRoot);
  if (inside(root, stagingRoot)) throw sandboxError('snapshot_stage_inside_workspace');
  const id = requestedId === null ? randomUUID() : String(requestedId);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)) throw sandboxError('snapshot_id_invalid');
  const directory = path.join(stagingRoot, id);
  await fs.mkdir(directory, { mode: 0o755 });
  try {
    const previous = await readMirrorIndex(indexFile, { root, rootIdentity });
    const discovered = await discoverProtectionPolicy(root);
    const scan = await scanWithPolicy({ root, policy: discovered, limits, signal });
    const trees = [...previous.trees];
    const toStage = [];
    const directories = [];
    for (const [relative, entry] of scan.entries) {
      const old = previous.entries.get(relative);
      const refreshed = previous.full || previous.resync.has(relative) || underAny(relative, trees);
      if (entry.dir) {
        if (refreshed || !old?.dir) directories.push(relative);
        continue;
      }
      if (!refreshed && old && !old.dir && sameFile(old, entry)) entry.sha256 = old.sha256;
      else toStage.push(relative);
    }
    const deletes = [];
    if (!previous.full) {
      for (const relative of previous.entries.keys()) if (!scan.entries.has(relative)) deletes.push(relative);
      for (const relative of previous.resync) if (!scan.entries.has(relative)) deletes.push(relative);
    }
    const filesDirectory = path.join(directory, 'files');
    await fs.mkdir(filesDirectory, { mode: 0o755 });
    let stagedBytes = 0;
    const files = [];
    await mapWithConcurrency(toStage, COPY_CONCURRENCY, async (relative, index) => {
      const entry = scan.entries.get(relative);
      const name = String(index);
      entry.sha256 = await copyAndHash(path.join(root, ...relative.split('/')), path.join(filesDirectory, name), entry, signal);
      stagedBytes += entry.size;
      files[index] = [relative, name, entry.size, entry.sha256];
    });
    const sync = { schema_version: 1, full: previous.full, directories: directories.sort(), files,
      deletes: topmost(deletes), trees: trees.sort(), protected: protectedForWorker(scan.policy) };
    const syncText = JSON.stringify(sync);
    await fs.writeFile(path.join(directory, 'sync.json'), syncText, { flag: 'wx', mode: 0o444 });
    await fs.chmod(filesDirectory, 0o555);
    await fs.chmod(directory, 0o555);
    return { id, directory, root, rootIdentity, mirrorId, indexFile, digest: stateDigest(scan.entries),
      syncDigest: digest(syncText), policy: scan.policy, index: scan.entries, delta: sync, limits,
      entries: scan.entries.size, bytes: scan.bytes, stagedBytes, skipped: scan.skipped };
  } catch (error) {
    await removeSnapshot({ directory, stagingRoot });
    throw error;
  }
}

// Admission: the folder still matches the walk the approval saw, and the staged delta is untouched.
async function verifyMirrorSync(stage) {
  const current = await assertRealDirectory(stage.root);
  if (digest([stage.root, current.dev, current.ino]) !== stage.rootIdentity) throw sandboxError('snapshot_changed');
  let scan;
  try { scan = await scanFolder({ root: stage.root, policy: stage.policy, limits: stage.limits || SYNCED_LIMITS }); }
  catch (error) { throw error.reason === 'snapshot_limit' ? error : sandboxError('snapshot_changed'); }
  if (scan.entries.size !== stage.index.size) throw sandboxError('snapshot_changed');
  for (const [relative, entry] of scan.entries) {
    const expected = stage.index.get(relative);
    if (!expected || Boolean(expected.dir) !== Boolean(entry.dir) || (!entry.dir && !sameFile(expected, {
      size: entry.size, mtimeNs: entry.mtimeNs, ino: entry.ino }))) throw sandboxError('snapshot_changed');
  }
  const syncText = await fs.readFile(path.join(stage.directory, 'sync.json'), 'utf8').catch(() => '');
  if (digest(syncText) !== stage.syncDigest) throw sandboxError('snapshot_changed');
  for (const [, name, size, sha256] of stage.delta.files) {
    const file = path.join(stage.directory, 'files', name);
    const info = await fs.lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== size) throw sandboxError('snapshot_changed');
    const hash = createHash('sha256');
    const handle = await fs.open(file, 'r');
    try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); }
    finally { await handle.close(); }
    if (hash.digest('hex') !== sha256) throw sandboxError('snapshot_changed');
  }
}

module.exports = { SYNCED_LIMITS, mirrorIdFor, stageMirrorSync, verifyMirrorSync, readMirrorIndex, commitMirrorIndex,
  invalidateMirrorIndex, stateDigest, scanFolder, sameFile, assertRealDirectory, writeAtomically };
