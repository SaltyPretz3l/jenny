'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PARTIAL_SUFFIX = '.partial';
const OWNED_PARTIAL_NAME = /^([^/\\]+)\.[0-9a-f]{12}\.partial$/;
const STALE_PARTIAL_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SWEPT_PARTIALS = 16;

function isPathInside(rootPath, targetPath) {
  const root = path.resolve(String(rootPath || ''));
  const target = path.resolve(String(targetPath || ''));
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function buildPartialPath(finalPath) {
  return `${finalPath}.${crypto.randomBytes(6).toString('hex')}${PARTIAL_SUFFIX}`;
}

async function removeOwnedPartial(rootPath, partialPath) {
  if (!isPathInside(rootPath, partialPath) || !path.basename(partialPath).endsWith(PARTIAL_SUFFIX)) {
    return false;
  }
  try {
    const stat = await fs.promises.lstat(partialPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  await fs.promises.rm(partialPath, { recursive: true, force: true });
  return true;
}

// Removal is attempted once. The error is marked only when the partial is still
// on disk afterwards, so a failed removal never hides the user's readable copy.
async function removeOrReportPartial(rootPath, partialPath, error) {
  try {
    await removeOwnedPartial(rootPath, partialPath);
  } catch (_removeError) {
    // The original error stays the one reported; retention is checked below.
  }
  const retained = await fs.promises.lstat(partialPath).then((stat) => stat.isDirectory(), () => false);
  if (retained && error && typeof error === 'object') {
    error.partialRetained = true;
    error.partialPath = partialPath;
  }
}

function isOwnedPartialName(name, archiveExtension) {
  const match = OWNED_PARTIAL_NAME.exec(name);
  return Boolean(match) && match[1].endsWith(archiveExtension);
}

async function sweepAbandonedPartials(rootPath, { archiveExtension, now = Date.now() } = {}) {
  let dirents;
  try {
    dirents = await fs.promises.readdir(rootPath, { withFileTypes: true });
  } catch (_error) {
    return 0;
  }
  let removed = 0;
  let attempted = 0;
  for (const dirent of dirents) {
    if (attempted >= MAX_SWEPT_PARTIALS) break;
    if (!dirent.isDirectory() || dirent.isSymbolicLink() || !isOwnedPartialName(dirent.name, archiveExtension)) continue;
    const partialPath = path.join(rootPath, dirent.name);
    try {
      const stat = await fs.promises.lstat(partialPath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < STALE_PARTIAL_AGE_MS) continue;
      attempted += 1;
      if (await removeOwnedPartial(rootPath, partialPath)) removed += 1;
    } catch (_error) {
      // A partial that cannot be removed is retried by the next archive.
    }
  }
  return removed;
}

module.exports = {
  buildPartialPath,
  isPathInside,
  removeOrReportPartial,
  removeOwnedPartial,
  sweepAbandonedPartials,
};
