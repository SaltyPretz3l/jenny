'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_ERROR_CODES } = require('../backend/error-codes');
const { exportSession } = require('../backend/session-export-import');

const MAX_INVENTORY_FILES = 10_000;
const MAX_INVENTORY_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const WORKSPACE_PORTABLE_NAMES = Object.freeze([
  'artifacts',
  'backups',
  'tool-results',
  'omissions.db',
  'artifact-manifest.json',
]);

function inventoryError(reason, message) {
  return Object.assign(new Error(message), { code: DATA_ERROR_CODES.SOURCE_UNREADABLE, reason });
}

function isContainedRealPath(rootPath, candidatePath) {
  const root = fs.realpathSync.native(path.resolve(rootPath));
  const candidate = fs.realpathSync.native(path.resolve(candidatePath));
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function collectDirectoryFiles(rootPath, logicalPrefix, category, output, limits) {
  if (!fs.existsSync(rootPath)) return;
  const rootStat = fs.lstatSync(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw inventoryError('source_unreadable', 'An archive source directory is unsafe.');
  }
  const queue = [rootPath];
  while (queue.length) {
    const current = queue.shift();
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, dirent.name);
      const stat = fs.lstatSync(candidate);
      if (dirent.isSymbolicLink() || stat.isSymbolicLink()) {
        throw inventoryError('source_unreadable', 'An archive source contains an unsafe link.');
      }
      if (!isContainedRealPath(rootPath, candidate)) {
        throw inventoryError('source_unreadable', 'An archive source escapes its owner root.');
      }
      if (stat.isDirectory()) {
        queue.push(candidate);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > limits.maxFileBytes) {
        throw inventoryError('source_too_large', 'An archive source exceeds the supported per-file size.');
      }
      if (output.length >= limits.maxFiles) {
        throw new Error('Jenny data inventory exceeds the supported file count.');
      }
      const relative = path.relative(rootPath, candidate).split(path.sep).join('/');
      output.push({
        logicalPath: `${logicalPrefix}/${relative}`,
        category,
        sourcePath: candidate,
        size: stat.size,
      });
    }
  }
}

function addFileIfPresent(output, sourcePath, logicalPath, category, limits) {
  if (!fs.existsSync(sourcePath)) return;
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw inventoryError('source_unreadable', 'An archive source file is unsafe.');
  }
  if (stat.size > limits.maxFileBytes) {
    throw inventoryError('source_too_large', 'An archive source exceeds the supported per-file size.');
  }
  output.push({ logicalPath, category, sourcePath, size: stat.size });
}

function assertInventoryCapacity(output, size, limits) {
  if (output.length >= limits.maxFiles) {
    throw new Error('Jenny data inventory exceeds the supported file count.');
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
    throw new Error('A Jenny data item exceeds the supported archive size.');
  }
}

function collectSessionEntries(sessionStore, attachmentStore, output, limits) {
  if (!sessionStore || typeof sessionStore.listSessions !== 'function') return;
  const summaries = sessionStore.listSessions();
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    const sessionId = String(summary?.id || '').trim();
    if (!sessionId) continue;
    let payload;
    try {
      payload = exportSession(sessionStore, sessionId, attachmentStore, { requireManagedMedia: true });
    } catch (error) {
      throw inventoryError('source_unreadable', 'Managed session media could not be archived.', error);
    }
    if (!payload) continue;
    const data = Buffer.from(payload, 'utf8');
    assertInventoryCapacity(output, data.length, limits);
    const token = crypto.createHash('sha256').update(sessionId).digest('hex');
    output.push({
      logicalPath: `sessions/${token}.json`,
      category: 'chats',
      data,
      restoreMetadata: { session_id: sessionId.slice(0, 160) },
    });
  }
}

function countSessionAttachments(sessionStore) {
  if (!sessionStore || typeof sessionStore.listSessions !== 'function') return 0;
  let count = 0;
  for (const summary of sessionStore.listSessions() || []) {
    const session = sessionStore.getSession?.(summary?.id);
    for (const message of session?.messages || []) count += Array.isArray(message?.attachments) ? message.attachments.length : 0;
  }
  return count;
}

function collectDataInventory({
  userDataPath,
  runtimePath = '',
  workspaceRoot = '',
  includeWorkspace = false,
  sessionStore = null,
  attachmentStore = null,
  portablePreferences = null,
  portableShellConfig = null,
  maxFiles = MAX_INVENTORY_FILES,
  maxFileBytes = MAX_INVENTORY_FILE_BYTES,
} = {}) {
  const userRoot = path.resolve(String(userDataPath || ''));
  if (!String(userDataPath || '').trim()) {
    throw new TypeError('collectDataInventory requires userDataPath.');
  }
  const limits = { maxFiles, maxFileBytes };
  const entries = [];
  collectSessionEntries(sessionStore, attachmentStore, entries, limits);
  if (portablePreferences) {
    const data = Buffer.from(JSON.stringify(portablePreferences, null, 2), 'utf8');
    assertInventoryCapacity(entries, data.length, limits);
    entries.push({
      logicalPath: 'preferences/portable-preferences.json',
      category: 'preferences',
      data,
    });
  }
  if (portableShellConfig) {
    const data = Buffer.from(JSON.stringify(portableShellConfig, null, 2), 'utf8');
    assertInventoryCapacity(entries, data.length, limits);
    entries.push({
      logicalPath: 'preferences/shell-config.json',
      category: 'preferences',
      data,
    });
  }
  collectDirectoryFiles(
    path.join(userRoot, 'personality', 'default-workspace'),
    'personality',
    'personality',
    entries,
    limits
  );
  addFileIfPresent(entries, path.join(userRoot, 'home-calendar.json'), 'calendar/home-calendar.json', 'memory', limits);
  addFileIfPresent(entries, path.join(userRoot, 'sidecar-memory.db'), 'memory/sidecar-memory.db', 'memory', limits);
  if (runtimePath) {
    addFileIfPresent(entries, path.join(runtimePath, 'jenny_memory.db'), 'memory/jenny_memory.db', 'memory', limits);
    addFileIfPresent(entries, path.join(runtimePath, 'memory.db'), 'memory/legacy-memory.db', 'memory', limits);
  }
  if (includeWorkspace && workspaceRoot) {
    const metadataRoot = path.join(path.resolve(workspaceRoot), '.jenny');
    if (fs.existsSync(metadataRoot)) {
      const metadataStat = fs.lstatSync(metadataRoot);
      if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink()) {
        throw inventoryError('source_unreadable', 'Workspace archive metadata is unsafe.');
      }
      for (const name of WORKSPACE_PORTABLE_NAMES) {
        const candidate = path.join(metadataRoot, name);
        if (!fs.existsSync(candidate)) continue;
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          collectDirectoryFiles(candidate, `workspace/${name}`, 'workspace', entries, limits);
        } else {
          addFileIfPresent(entries, candidate, `workspace/${name}`, 'workspace', limits);
        }
      }
    }
  }
  if (entries.length > maxFiles) {
    throw new Error('Jenny data inventory exceeds the supported file count.');
  }
  const counts = { chats: 0, attachments: 0, memory: 0, workspace: 0, preferences: 0, totalBytes: 0 };
  for (const entry of entries) {
    counts.totalBytes += entry.data ? entry.data.length : Number(entry.size || 0);
    if (entry.category === 'chats') counts.chats += 1;
    if (entry.category === 'memory' || entry.category === 'personality') counts.memory += 1;
    if (entry.category === 'workspace') counts.workspace += 1;
    if (entry.category === 'preferences') counts.preferences += 1;
  }
  counts.attachments = countSessionAttachments(sessionStore);
  return { entries, counts };
}

module.exports = {
  collectDataInventory,
  countSessionAttachments,
};
