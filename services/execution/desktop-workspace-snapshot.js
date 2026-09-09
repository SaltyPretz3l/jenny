'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sandboxError, digest } = require('./sandbox-errors');
const LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, entries: 2048, depth: 32, pathBytes: 4096 });
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
}
async function assertDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw sandboxError('snapshot_directory_invalid');
  if (path.resolve(await fs.realpath(directory)) !== path.resolve(directory)) throw sandboxError('snapshot_reparse_point');
  return stat;
}
async function createWorkspaceSnapshot({ root, stagingRoot, forbiddenRoots = [], signal, limits = LIMITS }) {
  root = path.resolve(root);
  const rootInfo = await assertDirectory(root);
  const rootIdentity = digest([root, rootInfo.dev, rootInfo.ino]);
  for (const forbidden of forbiddenRoots) {
    if (inside(root, path.resolve(forbidden)) || inside(path.resolve(forbidden), root)) {
      throw sandboxError('snapshot_profile_overlap');
    }
  }
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await assertDirectory(stagingRoot);
  if (inside(root, stagingRoot)) throw sandboxError('snapshot_stage_inside_workspace');
  const id = randomUUID();
  const directory = path.join(stagingRoot, id);
  await fs.mkdir(directory, { mode: 0o755 });
  let entries = 0;
  let bytes = 0;
  const manifest = [];
  const observed = [];
  const check = () => { if (signal?.aborted) throw sandboxError('sandbox_cancelled'); };
  async function visit(source, destination, prefix, depth) {
    check();
    const before = await assertDirectory(source);
    observed.push([source, before]);
    const handle = await fs.opendir(source);
    for await (const entry of handle) {
      check();
      entries += 1;
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entries > limits.entries || depth > limits.depth
        || Buffer.byteLength(relative) > limits.pathBytes || /[\\:]/u.test(entry.name) || entry.name.includes(String.fromCharCode(0))) {
        throw sandboxError('snapshot_limit');
      }
      const input = path.join(source, entry.name);
      const output = path.join(destination, entry.name);
      const initial = await fs.lstat(input);
      observed.push([input, initial]);
      if (initial.isSymbolicLink() || !inside(root, await fs.realpath(input))) throw sandboxError('snapshot_link_rejected');
      if (initial.isDirectory()) {
        await fs.mkdir(output, { mode: 0o755 });
        manifest.push([relative, 'directory']);
        await visit(input, output, relative, depth + 1);
      } else if (initial.isFile() && initial.nlink === 1) {
        bytes += initial.size;
        if (bytes > limits.bytes) throw sandboxError('snapshot_limit');
        const inputHandle = await fs.open(input, 'r');
        try {
          const opened = await inputHandle.stat();
          if (!same(initial, opened) || !inside(root, await fs.realpath(input))) throw sandboxError('snapshot_changed');
          const data = Buffer.alloc(initial.size);
          let offset = 0;
          while (offset < data.length) {
            check();
            const read = await inputHandle.read(data, offset, Math.min(65536, data.length - offset), offset);
            if (!read.bytesRead) throw sandboxError('snapshot_changed');
            offset += read.bytesRead;
          }
          if (!same(initial, await inputHandle.stat()) || !same(initial, await fs.lstat(input))
            || !inside(root, await fs.realpath(input))) throw sandboxError('snapshot_changed');
          // Preserve POSIX executable bits; never preserve setuid/setgid or group/world writes.
          const mode = initial.mode & 0o111 ? 0o555 : 0o444;
          const target = await fs.open(output, 'wx', mode);
          try { await target.writeFile(data); await target.sync(); } finally { await target.close(); }
          manifest.push([relative, initial.size, digest(data), mode]);
        } finally { await inputHandle.close(); }
      } else throw sandboxError('snapshot_special_file_rejected');
    }
    if (!same(before, await fs.lstat(source))) throw sandboxError('snapshot_changed');
    await fs.chmod(destination, 0o555);
  }
  try {
    await visit(root, directory, '', 1);
    for (const [source, initial] of observed) {
      check();
      if (!same(initial, await fs.lstat(source)) || !inside(root, await fs.realpath(source))) throw sandboxError('snapshot_changed');
    }
    manifest.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return { id, directory, root, rootIdentity, digest: digest(manifest), entries, bytes };
  } catch (error) {
    await removeSnapshot({ directory, stagingRoot });
    throw error;
  }
}
async function verifyWorkspaceSnapshot(snapshot) {
  if (snapshot.rootIdentity) {
    const current = await assertDirectory(snapshot.root);
    if (digest([snapshot.root, current.dev, current.ino]) !== snapshot.rootIdentity) throw sandboxError('snapshot_changed');
  }
  const manifest = [];
  let bytes = 0;
  async function visit(directory, prefix = '', depth = 1) {
    const before = await assertDirectory(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (manifest.length >= LIMITS.entries || depth > LIMITS.depth || Buffer.byteLength(relative) > LIMITS.pathBytes) throw sandboxError('snapshot_limit');
      const file = path.join(directory, entry.name);
      const info = await fs.lstat(file);
      if (info.isSymbolicLink() || !inside(snapshot.directory, await fs.realpath(file))) throw sandboxError('snapshot_changed');
      if (info.isDirectory()) {
        manifest.push([relative, 'directory']); await visit(file, relative, depth + 1);
      } else if (info.isFile() && info.nlink === 1) {
        bytes += info.size;
        if (bytes > LIMITS.bytes) throw sandboxError('snapshot_limit');
        const content = await fs.readFile(file);
        if (content.length !== info.size || !same(info, await fs.lstat(file))) throw sandboxError('snapshot_changed');
        manifest.push([relative, info.size, digest(content), info.mode & 0o111 ? 0o555 : 0o444]);
      } else throw sandboxError('snapshot_changed');
    }
    if (!same(before, await fs.lstat(directory))) throw sandboxError('snapshot_changed');
  }
  await visit(snapshot.directory);
  manifest.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (digest(manifest) !== snapshot.digest) throw sandboxError('snapshot_changed');
}
async function removeSnapshot({ directory, stagingRoot }) {
  const resolved = path.resolve(directory);
  const parent = path.resolve(stagingRoot);
  if (path.dirname(resolved) !== parent || !/^[a-f0-9-]{36}$/u.test(path.basename(resolved))) {
    throw sandboxError('snapshot_cleanup_path_invalid');
  }
  await assertDirectory(parent);
  const stat = await fs.lstat(resolved).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw sandboxError('snapshot_cleanup_path_invalid');
  // POSIX immutable staging directories need owner write permission for removal.
  async function writable(directory) {
    await fs.chmod(directory, 0o755);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await writable(path.join(directory, entry.name));
    }
  }
  if (process.platform !== 'win32') await writable(resolved);
  await fs.rm(resolved, { recursive: true, force: true });
}
module.exports = { createWorkspaceSnapshot, verifyWorkspaceSnapshot, removeSnapshot, LIMITS, inside };