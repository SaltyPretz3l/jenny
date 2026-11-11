'use strict';
// Row 106 write-back: the only code that writes a synced-workspace command's changes into the folder.
// Security boundary. Everything in the outbox is untrusted (the command controlled the mirror it came
// from). Each entry must be a safe relative POSIX path, outside the protected set (case-insensitively,
// with Windows aliases refused), under a parent chain of real directories inside the root, and the folder
// entry must still be what sync-in indexed (size, mtime, ino and hash), otherwise it is a conflict the user
// made during the run. Outbox files are lstat-checked single regular files of the declared size and hash;
// anything lstat cannot read (a WSL symlink, EACCES) is refused, never followed. Writes go through a temp
// file in the same directory plus rename. Refused and conflicting paths go to the resync lists so the
// mirror is replaced from the folder on the next run.
const nodeFs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { sandboxError } = require('./sandbox-errors');
const { removeFile } = require('../fs-remove-no-follow');
const { validateRelativePath, isProtected } = require('./sandbox-protected-paths');
const { sameFile } = require('./sandbox-mirror-sync');

const WRITE_BACK_LIMITS = Object.freeze({ bytes: 256 * 1024 * 1024, entries: 10000, manifestBytes: 16 * 1024 * 1024,
  reviewFileBytes: 512 * 1024, reviewTotalBytes: 8 * 1024 * 1024 });
const CHANGES = new Set(['added', 'modified', 'deleted']);
const KINDS = new Set(['file', 'directory']);
const WORKER_REFUSALS = new Set(['symlink', 'special', 'hardlink', 'protected', 'unreadable']);
const ENTRY_KEYS = new Set(['path', 'change', 'kind', 'file', 'size', 'sha256', 'refused']);
const SHA256 = /^[a-f0-9]{64}$/u;

function outboxInvalid() {
  return sandboxError('write_back_outbox_invalid');
}

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))) return false;
  if (typeof entry.path !== 'string' || !CHANGES.has(entry.change) || !KINDS.has(entry.kind)) return false;
  if (entry.size !== undefined && !(Number.isSafeInteger(entry.size) && entry.size >= 0)) return false;
  if (entry.refused !== undefined) return WORKER_REFUSALS.has(entry.refused);
  if (entry.kind === 'directory' || entry.change === 'deleted') return entry.file === undefined;
  return typeof entry.file === 'string' && /^[0-9a-z]{1,12}$/u.test(entry.file)
    && Number.isSafeInteger(entry.size) && entry.size >= 0 && SHA256.test(entry.sha256 || '');
}

async function readOutbox(outbox, { jobId, fsImpl = nodeFs, limits = WRITE_BACK_LIMITS }) {
  const file = path.join(outbox, 'changes.json');
  let parsed;
  try {
    const info = await fsImpl.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limits.manifestBytes) throw outboxInvalid();
    parsed = JSON.parse(await fsImpl.readFile(file, 'utf8'));
  } catch { throw outboxInvalid(); }
  if (!parsed || parsed.schema_version !== 1 || parsed.job_id !== jobId || !['ok', 'write_back_too_large'].includes(parsed.status)
    || !Array.isArray(parsed.entries) || parsed.entries.length > limits.entries || !parsed.entries.every(validEntry)) throw outboxInvalid();
  return parsed;
}

// The outbox bytes for one entry, or null when the file is not exactly what the entry declares.
async function readOutboxFile(outbox, entry, fsImpl) {
  const file = path.join(outbox, 'files', entry.file);
  try {
    const info = await fsImpl.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== entry.size) return null;
    const handle = await fsImpl.open(file, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.size !== entry.size) return null;
      const data = Buffer.alloc(entry.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
        if (!bytesRead) return null;
        offset += bytesRead;
      }
      return createHash('sha256').update(data).digest('hex') === entry.sha256 ? data : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

async function lstatOrNull(target) {
  try { return await nodeFs.lstat(target, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function hashFile(target, keepLimit) {
  const handle = await nodeFs.open(target, 'r');
  try {
    const hash = createHash('sha256');
    const chunks = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      total += chunk.length;
      if (total <= keepLimit) chunks.push(chunk);
    }
    return { sha256: hash.digest('hex'), content: total <= keepLimit ? Buffer.concat(chunks) : null };
  } finally { await handle.close(); }
}

function linuxSafe(component) {
  return Boolean(component) && component !== '.' && component !== '..' && !component.includes('/') && !component.includes('\0');
}

// The shortest prefix of `relative` the policy protects (the subtree the mirror gets back from the folder).
// The protected root (what the review lists) and the subtree to resync: one level below the root,
// so a cache write under node_modules restages that subtree only.
function protectedRoot(components, policy) {
  for (let length = 1; length <= components.length; length += 1) {
    const prefix = components.slice(0, length).join('/');
    if (isProtected(prefix, policy)) return { root: prefix, tree: components.slice(0, length + 1).join('/') };
  }
  const whole = components.join('/');
  return { root: whole, tree: whole };
}

async function applyWriteBack({ root, outbox, jobId, stage, signal = null, fsImpl = nodeFs, limits = WRITE_BACK_LIMITS }) {
  root = path.resolve(root);
  const changes = await readOutbox(outbox, { jobId, fsImpl, limits });
  const index = new Map(stage.index);
  const applied = [];
  const refused = [];
  const resync = new Set();
  const trees = new Set();
  if (changes.status === 'write_back_too_large'
    || changes.entries.reduce((sum, entry) => sum + (entry.refused ? 0 : entry.size || 0), 0) > limits.bytes) {
    return { status: 'too_large', applied, refused, index: stage.index, resync, trees, full: true };
  }
  const verified = new Set();
  let reviewBytes = 0;
  const keep = (buffer) => {
    if (!buffer || buffer.length > limits.reviewFileBytes || reviewBytes + buffer.length > limits.reviewTotalBytes) return null;
    reviewBytes += buffer.length;
    return buffer;
  };
  const listedProtected = new Set();
  const refuse = (relative, reason, tree = null) => {
    if (reason !== 'protected' || !listedProtected.has(relative)) refused.push({ path: relative, reason });
    if (reason === 'protected') listedProtected.add(relative);
    if (tree) trees.add(tree); else resync.add(relative);
  };
  // Every level below the root must be a real directory whose real path is itself (no junction,
  // symlink, mount point or case alias). Missing levels are created only when `create` is set.
  const parentChain = async (components, create) => {
    let current = root;
    for (const component of components) {
      const next = path.join(current, component);
      if (!verified.has(next)) {
        let info = await nodeFs.lstat(next).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!info) {
          if (!create) throw sandboxError('parent_invalid');
          await nodeFs.mkdir(next);
          info = await nodeFs.lstat(next);
        }
        if (!info.isDirectory() || info.isSymbolicLink()
          || path.resolve(await nodeFs.realpath(next)) !== path.resolve(next)) throw sandboxError('parent_invalid');
        verified.add(next);
      }
      current = next;
    }
    return current;
  };
  // The folder entry still matches what sync-in indexed; returns its bytes for the review.
  const unchanged = async (target, expected) => {
    const current = await lstatOrNull(target);
    if (!expected) return current === null ? { ok: true, current, before: null } : { ok: false, reason: 'conflict' };
    if (expected.dir) return current?.isDirectory() && !current.isSymbolicLink() ? { ok: true, current } : { ok: false, reason: 'conflict' };
    if (!current?.isFile() || current.isSymbolicLink() || !sameFile(expected, current)) {
      return { ok: false, reason: current?.isDirectory() ? 'type_changed' : 'conflict' };
    }
    const read = await hashFile(target, limits.reviewFileBytes);
    return read.sha256 === expected.sha256 ? { ok: true, current, before: read.content } : { ok: false, reason: 'conflict' };
  };
  const ordered = [
    ...changes.entries.filter((entry) => entry.kind === 'directory' && entry.change !== 'deleted')
      .sort((a, b) => a.path.length - b.path.length),
    ...changes.entries.filter((entry) => entry.kind === 'file'),
    ...changes.entries.filter((entry) => entry.kind === 'directory' && entry.change === 'deleted')
      .sort((a, b) => b.path.length - a.path.length),
  ];
  for (const entry of ordered) {
    if (signal?.aborted) throw sandboxError('sandbox_cancelled');
    const relative = entry.path;
    const checked = validateRelativePath(relative);
    if (!checked.ok) {
      const parts = relative.split('/');
      const bad = parts.findIndex((part) => !validateRelativePath(part).ok);
      const prefix = parts.slice(0, bad + 1);
      refuse(relative, checked.reason, bad >= 0 && prefix.every(linuxSafe) && !relative.startsWith('/') ? prefix.join('/') : null);
      continue;
    }
    if (isProtected(relative, stage.policy)) {
      const { root: listed, tree } = protectedRoot(checked.components, stage.policy);
      refuse(listed, 'protected', tree); continue;
    }
    if (entry.refused) { refuse(relative, entry.refused); continue; }
    const target = path.join(root, ...checked.components);
    const expected = stage.index.get(relative);
    try {
      if (entry.kind === 'file' && expected?.dir) { refuse(relative, 'type_changed'); continue; }
      if (entry.kind === 'directory' && expected && !expected.dir) { refuse(relative, 'type_changed'); continue; }
      if (entry.kind === 'directory' && entry.change !== 'deleted') {
        const state = await unchanged(target, expected);
        if (!state.ok && !(state.reason === 'conflict' && !expected && (await lstatOrNull(target))?.isDirectory())) {
          refuse(relative, state.reason); continue;
        }
        await parentChain(checked.components, true);
        index.set(relative, { dir: true });
        if (!expected) applied.push({ path: relative, change: 'added', kind: 'directory' });
        continue;
      }
      if (entry.kind === 'directory') {
        if (!expected) continue;
        const parent = await parentChain(checked.components.slice(0, -1), false);
        const state = await unchanged(path.join(parent, checked.components.at(-1)), expected);
        if (!state.ok) { refuse(relative, state.reason); continue; }
        try { await nodeFs.rmdir(target); }
        catch (error) {
          if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
          refuse(relative, 'not_empty', relative); continue;
        }
        index.delete(relative);
        applied.push({ path: relative, change: 'deleted', kind: 'directory' });
        continue;
      }
      if (entry.change === 'deleted') {
        if (!expected) { if (await lstatOrNull(target)) refuse(relative, 'conflict'); continue; }
        await parentChain(checked.components.slice(0, -1), false);
        const state = await unchanged(target, expected);
        if (!state.ok) { refuse(relative, state.reason); continue; }
        await removeFile(target);
        index.delete(relative);
        applied.push({ path: relative, change: 'deleted', kind: 'file', before: keep(state.before), beforeSize: expected.size });
        continue;
      }
      const data = await readOutboxFile(outbox, entry, fsImpl);
      if (!data) { refuse(relative, 'outbox_invalid'); continue; }
      const state = await unchanged(target, expected);
      if (!state.ok) { refuse(relative, state.reason); continue; }
      const parent = await parentChain(checked.components.slice(0, -1), true);
      const temp = path.join(parent, '.jenny-wb-' + randomUUID() + '.tmp');
      try {
        const handle = await nodeFs.open(temp, 'wx', expected ? Number(state.current.mode) & 0o777 : 0o644);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        // The narrowest re-check before the rename: the entry is still what the check saw.
        const latest = await lstatOrNull(target);
        if (expected ? !(latest?.isFile() && sameFile(expected, latest)) : latest !== null) { refuse(relative, 'conflict'); continue; }
        await nodeFs.rename(temp, target);
      } finally { await removeFile(temp).catch(() => {}); }
      const after = await nodeFs.lstat(target, { bigint: true });
      index.set(relative, { size: Number(after.size), mtimeNs: String(after.mtimeNs), ino: String(after.ino), sha256: entry.sha256 });
      for (let length = 1; length < checked.components.length; length += 1) {
        index.set(checked.components.slice(0, length).join('/'), { dir: true });
      }
      applied.push({ path: relative, change: expected ? 'modified' : 'added', kind: 'file', before: keep(state.before),
        after: keep(data), beforeSize: expected?.size ?? null, afterSize: data.length });
    } catch (error) {
      refuse(relative, error.reason === 'parent_invalid' ? 'parent_invalid' : 'write_failed');
    }
  }
  return { status: 'applied', applied, refused, index, resync, trees, full: false };
}

module.exports = { WRITE_BACK_LIMITS, readOutbox, applyWriteBack };
