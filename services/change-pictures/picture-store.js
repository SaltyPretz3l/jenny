'use strict';

/* On-disk store for the before and after pictures of a chat turn. Layout:
 * <rootDir>/<workspaceId>/<turnKey>/meta.json plus the PNG files it names.
 * The store lives under the app's own data folder, never in the workspace.
 * Everything read back from meta.json is untrusted: a name from it only ever
 * becomes a URL after it matches the exact shape this store writes. */

const crypto = require('crypto');
const nodeFs = require('fs');
const nodePath = require('path');
const { pathToFileURL } = require('url');

const { removeTree } = require('../fs-remove-no-follow');

const PICTURE_STATES = Object.freeze(['ready', 'same', 'after_failed', 'new', 'deleted']);
const META_VERSION = 1;
const MAX_PAGES = 3;
const MAX_ID_LENGTH = 200;
const MAX_SIGNATURE_LENGTH = 200;
const MAX_PATH_LENGTH = 500;
const MAX_META_BYTES = 256 * 1024;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TURN_DIRECTORY = /^[0-9a-f]{32}$/;
const PICTURE_NAME = /^p\d+-(?:before|after)-[0-9a-f]{12}\.png$/;
const STRAY_TEMP_NAME = /^meta\.json\.tmp-[0-9a-f]+$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function turnKey(sessionId, turnId) {
  return crypto.createHash('sha256').update(`${sessionId}\n${turnId}`).digest('hex').slice(0, 32);
}

function invalidInput(message) {
  return Object.assign(new Error(message), { code: 'ERR_CHANGE_PICTURES_INPUT' });
}

function isIdText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function toDimension(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function createChangePictureStore({
  rootDir,
  fsImpl = nodeFs,
  pathImpl = nodePath,
  now = () => new Date(),
  maxTurnsPerWorkspace = 40,
  maxBytesPerWorkspace = 200 * 1024 * 1024,
  maxPictureBytes = 8 * 1024 * 1024,
  maxWorkspaces = 24,
  logger = () => {},
} = {}) {
  const fsp = fsImpl.promises;
  const root = typeof rootDir === 'string' && rootDir.trim() && pathImpl.isAbsolute(rootDir) ? rootDir : '';
  // Writes, removals and pruning share one queue so a prune never deletes a
  // folder another write is still filling.
  let queue = Promise.resolve();

  function log(level, event, details = {}) {
    try {
      logger(level, event, details);
    } catch (_error) {
      /* logging must never break a capture */
    }
  }

  function serialized(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function validIds({ workspaceId, sessionId, turnId } = {}) {
    return Boolean(root) && WORKSPACE_ID.test(String(workspaceId)) && isIdText(sessionId) && isIdText(turnId);
  }

  function workspaceDir(workspaceId) {
    return pathImpl.join(root, workspaceId);
  }

  function turnDirFor(workspaceId, sessionId, turnId) {
    return pathImpl.join(workspaceDir(workspaceId), turnKey(sessionId, turnId));
  }

  function acceptedPicture(buffer) {
    return Buffer.isBuffer(buffer)
      && buffer.length > PNG_SIGNATURE.length
      && buffer.length <= maxPictureBytes
      && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  }

  function pictureUrl(directory, name) {
    if (typeof name !== 'string' || !PICTURE_NAME.test(name)) return null;
    return pathToFileURL(pathImpl.join(directory, name)).href;
  }

  // Builds the public record from a parsed meta, or null when the meta does
  // not belong to the turn it was found under.
  function recordFromMeta(meta, directory) {
    if (!meta || typeof meta !== 'object' || meta.version !== META_VERSION) return null;
    if (!isIdText(meta.sessionId) || !isIdText(meta.turnId)) return null;
    if (pathImpl.basename(directory) !== turnKey(meta.sessionId, meta.turnId)) return null;
    const pages = [];
    for (const page of Array.isArray(meta.pages) ? meta.pages.slice(0, MAX_PAGES) : []) {
      if (!page || typeof page.path !== 'string' || !PICTURE_STATES.includes(page.state)) continue;
      pages.push({
        path: page.path.slice(0, MAX_PATH_LENGTH),
        state: page.state,
        beforeUrl: pictureUrl(directory, page.before),
        afterUrl: pictureUrl(directory, page.after),
        width: toDimension(page.width),
        height: toDimension(page.height),
      });
    }
    return {
      sessionId: meta.sessionId,
      turnId: meta.turnId,
      capturedAt: typeof meta.capturedAt === 'string' ? meta.capturedAt : '',
      viewport: meta.viewport === 'phone' ? 'phone' : 'desktop',
      signature: typeof meta.signature === 'string' ? meta.signature.slice(0, MAX_SIGNATURE_LENGTH) : '',
      pages,
    };
  }

  async function readMeta(directory) {
    try {
      const metaPath = pathImpl.join(directory, 'meta.json');
      const stats = await fsp.lstat(metaPath);
      if (!stats.isFile() || stats.size > MAX_META_BYTES) return null;
      return JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  async function readRecord(directory) {
    return recordFromMeta(await readMeta(directory), directory);
  }

  async function removeStrays(directory, keepNames) {
    let names;
    try {
      names = await fsp.readdir(directory);
    } catch (_error) {
      return;
    }
    for (const name of names) {
      const stray = (name.endsWith('.png') || STRAY_TEMP_NAME.test(name)) && !keepNames.has(name);
      if (stray) await fsp.unlink(pathImpl.join(directory, name)).catch(() => {});
    }
  }

  async function turnFolderInfo(workspacePath, name) {
    const directory = pathImpl.join(workspacePath, name);
    const meta = await readMeta(directory);
    let bytes = 0;
    try {
      for (const file of await fsp.readdir(directory)) {
        if (!file.endsWith('.png')) continue;
        const stats = await fsp.lstat(pathImpl.join(directory, file)).catch(() => null);
        if (stats && stats.isFile()) bytes += stats.size;
      }
    } catch (_error) {
      /* an unreadable folder counts as empty */
    }
    let capturedMs = Date.parse(meta && meta.capturedAt);
    if (!Number.isFinite(capturedMs)) {
      capturedMs = (await fsp.stat(directory).catch(() => null))?.mtimeMs ?? 0;
    }
    return { name, bytes, hasMeta: Boolean(meta), capturedMs };
  }

  // Oldest first: a folder without a readable meta, then by capture time.
  async function prune(workspaceId, keepName) {
    const workspacePath = workspaceDir(workspaceId);
    const dirents = await fsp.readdir(workspacePath, { withFileTypes: true });
    const others = [];
    let keptBytes = 0;
    let count = 0;
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !TURN_DIRECTORY.test(dirent.name)) continue;
      const info = await turnFolderInfo(workspacePath, dirent.name);
      count += 1;
      keptBytes += info.bytes;
      if (dirent.name !== keepName) others.push(info);
    }
    others.sort((a, b) => (a.hasMeta - b.hasMeta) || (a.capturedMs - b.capturedMs) || (a.name < b.name ? -1 : 1));
    let evicted = 0;
    for (const info of others) {
      if (count <= maxTurnsPerWorkspace && keptBytes <= maxBytesPerWorkspace) break;
      try {
        await removeTree(pathImpl.join(workspacePath, info.name), { fsImpl });
        count -= 1;
        keptBytes -= info.bytes;
        evicted += 1;
      } catch (error) {
        log('WARN', 'change_pictures.prune_delete_failed', { error: String(error?.message || error) });
      }
    }
    if (evicted) log('INFO', 'change_pictures.pruned', { evicted, kept: count });
  }

  // Whole workspaces go too, least recently added to first, so the store is
  // bounded however many folders the user has worked in.
  async function pruneWorkspaces(keepWorkspaceId) {
    const others = [];
    for (const dirent of await fsp.readdir(root, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !WORKSPACE_ID.test(dirent.name) || dirent.name === keepWorkspaceId) continue;
      const stats = await fsp.stat(pathImpl.join(root, dirent.name)).catch(() => null);
      others.push({ name: dirent.name, changedMs: stats?.mtimeMs ?? 0 });
    }
    others.sort((a, b) => (a.changedMs - b.changedMs) || (a.name < b.name ? -1 : 1));
    for (const info of others.slice(0, Math.max(0, others.length + 1 - maxWorkspaces))) {
      await removeTree(pathImpl.join(root, info.name), { fsImpl });
    }
  }

  async function writeTurn(args) {
    const { workspaceId, sessionId, turnId } = args;
    const directory = turnDirFor(workspaceId, sessionId, turnId);
    await fsp.mkdir(directory, { recursive: true });
    const written = [];
    const writePicture = async (index, side, buffer) => {
      if (!acceptedPicture(buffer)) return null;
      const name = `p${index}-${side}-${crypto.randomBytes(6).toString('hex')}.png`;
      await fsp.writeFile(pathImpl.join(directory, name), buffer, { flag: 'wx' });
      written.push(name);
      return name;
    };
    const metaPath = pathImpl.join(directory, 'meta.json');
    const tempPath = `${metaPath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    try {
      const pages = [];
      // Pages that cannot be kept are dropped before the cap, so they do not
      // use up one of the three places.
      const incoming = (Array.isArray(args.pages) ? args.pages : [])
        .filter((page) => page && typeof page.path === 'string' && PICTURE_STATES.includes(page.state));
      for (const page of incoming.slice(0, MAX_PAGES)) {
        const index = pages.length;
        pages.push({
          path: page.path.slice(0, MAX_PATH_LENGTH),
          state: page.state,
          before: await writePicture(index, 'before', page.before),
          after: await writePicture(index, 'after', page.after),
          width: toDimension(page.width),
          height: toDimension(page.height),
        });
      }
      const meta = {
        version: META_VERSION,
        sessionId,
        turnId,
        capturedAt: new Date(now()).toISOString(),
        viewport: args.viewport === 'phone' ? 'phone' : 'desktop',
        signature: typeof args.signature === 'string' ? args.signature.slice(0, MAX_SIGNATURE_LENGTH) : '',
        pages,
      };
      await fsp.writeFile(tempPath, JSON.stringify(meta), 'utf8');
      await fsp.rename(tempPath, metaPath);
      await removeStrays(directory, new Set([...written, 'meta.json']));
      try {
        await prune(workspaceId, pathImpl.basename(directory));
        await pruneWorkspaces(workspaceId);
      } catch (error) {
        log('WARN', 'change_pictures.prune_failed', { error: String(error?.message || error) });
      }
      return recordFromMeta(meta, directory);
    } catch (error) {
      await fsp.unlink(tempPath).catch(() => {});
      for (const name of written) await fsp.unlink(pathImpl.join(directory, name)).catch(() => {});
      throw error;
    }
  }

  async function write(args = {}) {
    if (!args || !validIds(args)) {
      throw invalidInput('Change pictures need a workspace id, a session id and a turn id.');
    }
    return serialized(() => writeTurn(args));
  }

  async function read(args = {}) {
    if (!args || !validIds(args)) return null;
    return readRecord(turnDirFor(args.workspaceId, args.sessionId, args.turnId));
  }

  async function list(args = {}) {
    if (!args || !root || !WORKSPACE_ID.test(String(args.workspaceId)) || !isIdText(args.sessionId)) {
      return [];
    }
    const workspacePath = workspaceDir(args.workspaceId);
    let dirents;
    try {
      dirents = await fsp.readdir(workspacePath, { withFileTypes: true });
    } catch (_error) {
      return [];
    }
    const records = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !TURN_DIRECTORY.test(dirent.name)) continue;
      const record = await readRecord(pathImpl.join(workspacePath, dirent.name));
      if (record && record.sessionId === args.sessionId) records.push(record);
    }
    records.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
    return records;
  }

  async function remove(args = {}) {
    if (!args || !validIds(args)) return false;
    return serialized(async () => {
      const directory = turnDirFor(args.workspaceId, args.sessionId, args.turnId);
      const stats = await fsp.lstat(directory).catch(() => null);
      if (!stats || !stats.isDirectory()) return false;
      await removeTree(directory, { fsImpl });
      return true;
    });
  }

  return { write, read, list, remove, getRootDir: () => root };
}

module.exports = { createChangePictureStore, turnKey, PICTURE_STATES };
