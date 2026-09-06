'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_WORKSPACE_RESTORE_STAGES = 20;
const WORKSPACE_RESTORE_JOURNAL = 'workspace-restore-journal.json';
const WORKSPACE_RESTORE_ROOT = path.join('.jenny', '.restore-staging');
const WORKSPACE_RESTORE_STAGE_PREFIX = 'stage-';

function fsyncDirectory(directoryPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'win32' || !['EISDIR', 'EINVAL', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncFile(filePath, throughDirectory = '') {
  const descriptor = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  let directoryPath = path.dirname(path.resolve(filePath));
  const stopPath = throughDirectory ? path.resolve(throughDirectory) : directoryPath;
  while (true) {
    fsyncDirectory(directoryPath);
    if (directoryPath === stopPath) break;
    const parentPath = path.dirname(directoryPath);
    if (parentPath === directoryPath) break;
    directoryPath = parentPath;
  }
}

function writeJsonDurable(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, filePath);
    fsyncFile(filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function createWorkspaceRestoreStage(stagingRoot) {
  fs.mkdirSync(stagingRoot, { recursive: true });
  fsyncDirectory(path.dirname(stagingRoot));
  fsyncDirectory(path.dirname(path.dirname(stagingRoot)));
  const stagePath = fs.mkdtempSync(path.join(stagingRoot, WORKSPACE_RESTORE_STAGE_PREFIX));
  fsyncDirectory(stagingRoot);
  return stagePath;
}

async function listWorkspaceRestoreStages(stagingRoot) {
  if (!fs.existsSync(stagingRoot)) return [];
  const stages = [];
  const directory = await fs.promises.opendir(stagingRoot);
  for await (const dirent of directory) {
    if (stages.length >= MAX_WORKSPACE_RESTORE_STAGES) {
      throw Object.assign(new Error('Too many workspace restore stages.'), { reason: 'workspace_restore_recovery_incomplete' });
    }
    if (!dirent.isDirectory() || dirent.isSymbolicLink()
      || !dirent.name.startsWith(WORKSPACE_RESTORE_STAGE_PREFIX) || dirent.name.length > 80) {
      throw Object.assign(new Error('Workspace restore staging is invalid.'), { reason: 'workspace_restore_recovery_incomplete' });
    }
    stages.push(path.join(stagingRoot, dirent.name));
  }
  return stages.sort((left, right) => left.localeCompare(right));
}

async function removeWorkspaceRestoreStage(stagePath, stagingRoot) {
  await fs.promises.rm(stagePath, { recursive: true, force: true });
  await fs.promises.rmdir(stagingRoot).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
  });
}

module.exports = {
  WORKSPACE_RESTORE_JOURNAL,
  WORKSPACE_RESTORE_ROOT,
  createWorkspaceRestoreStage,
  fsyncFile,
  listWorkspaceRestoreStages,
  removeWorkspaceRestoreStage,
  writeJsonDurable,
};
