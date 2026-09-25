'use strict';

const fs = require('fs');
const path = require('path');
const { archiveError } = require('./archive-format');
const { DATA_ERROR_CODES } = require('../backend/error-codes');

function invalid() {
  return archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path',
    'Restore runtime recovery owner is unavailable or changed.');
}

function pathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function originalIdentity(target) {
  try {
    const stat = fs.lstatSync(target, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw invalid();
    return { device: String(stat.dev), inode: String(stat.ino) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameOriginal(left, right) {
  return left === right || Boolean(left && right
    && left.device === right.device && left.inode === right.inode);
}

function assignPromotionOriginals(journal, actions) {
  if (journal.rollback_originals === undefined) return; // Legacy recovery layout.
  const originals = journal.rollback_originals;
  if (!Array.isArray(originals) || originals.length !== actions.length
      || originals.some((value) => value !== null && (!value || typeof value !== 'object'
        || Object.keys(value).sort().join(',') !== 'device,inode'
        || typeof value.device !== 'string' || typeof value.inode !== 'string'
        || !/^\d+$/.test(value.device) || !/^\d+$/.test(value.inode)))) throw invalid();
  actions.forEach((action, index) => { action.originalIdentity = originals[index]; });
}

function capturePromotionOriginals(journal, actions, ensureSafeDestination) {
  journal.rollback_originals = actions.map((action) => originalIdentity(
    ensureSafeDestination(action.ownerRoot, action.targetPath)));
  assignPromotionOriginals(journal, actions);
}

function runtimeBackupRoot(record, runtimePath) {
  if (!record.rollback_runtime_path) return null; // Existing journals retain their layout.
  if (!runtimePath || path.resolve(runtimePath) !== record.rollback_runtime_path
      || !/^[0-9a-f-]{36}$/i.test(record.operation_id || '')) throw invalid();
  const root = path.resolve(runtimePath);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || pathKey(fs.realpathSync.native(root)) !== pathKey(root)
      || String(stat.dev) !== record.rollback_runtime_device
      || String(stat.ino) !== record.rollback_runtime_inode) throw invalid();
  const backupRoot = path.join(root, `.jenny-restore-rollback-${record.operation_id}`);
  try {
    const backupStat = fs.lstatSync(backupRoot);
    if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) throw invalid();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return backupRoot;
}

function captureRuntimeBackupOwner(journal, actions, runtimePath) {
  if (!actions.some((action) => action.ownerKey === 'runtime')) return;
  // Capture before the write-ahead promotion transition; never change owners
  // when recovering an interrupted attempt.
  const root = path.resolve(runtimePath);
  let parent = root;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (pathKey(fs.realpathSync.native(parent)) !== pathKey(parent)) throw invalid();
  fs.mkdirSync(root, { recursive: true });
  const stat = fs.lstatSync(root);
  Object.assign(journal, {
    rollback_runtime_path: root,
    rollback_runtime_device: String(stat.dev),
    rollback_runtime_inode: String(stat.ino),
  });
  const backupRoot = runtimeBackupRoot(journal, runtimePath);
  if (fs.existsSync(backupRoot)) throw invalid();
}

function assignRuntimeBackups(actions, journal, runtimePath) {
  const root = runtimeBackupRoot(journal, runtimePath);
  for (const action of actions) {
    if (root && action.ownerKey === 'runtime') action.rollbackRoot = root;
  }
  return root;
}

function backupExisting({ targetPath, ownerRoot, ownerKey, rollbackRoot: localRoot }, rollbackRoot, ensureSafeDestination) {
  rollbackRoot = localRoot || rollbackRoot;
  ensureSafeDestination(ownerRoot, targetPath);
  if (!fs.existsSync(targetPath)) return null;
  const relative = path.relative(path.resolve(ownerRoot), path.resolve(targetPath));
  const backupPath = ensureSafeDestination(rollbackRoot, path.join(rollbackRoot, ownerKey, relative));
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.renameSync(targetPath, backupPath);
  return backupPath;
}

function backupPathForAction(action, rollbackRoot, ensureSafeDestination) {
  rollbackRoot = action.rollbackRoot || rollbackRoot;
  const relative = path.relative(path.resolve(action.ownerRoot), path.resolve(action.targetPath));
  return ensureSafeDestination(rollbackRoot, path.join(rollbackRoot, action.ownerKey, relative));
}

function rollbackPromotion(actions, rollbackRoot, ensureSafeDestination, removeTargets) {
  for (const action of actions.slice().reverse()) {
    ensureSafeDestination(action.ownerRoot, action.targetPath);
    const backupPath = backupPathForAction(action, rollbackRoot, ensureSafeDestination);
    if (action.originalIdentity !== undefined) {
      const backupIdentity = originalIdentity(backupPath);
      if (backupIdentity && !sameOriginal(backupIdentity, action.originalIdentity)) throw invalid();
      // Rename may have succeeded immediately before recovery was interrupted.
      // Its original inode now at the destination proves that action is done;
      // replay must never remove it merely because the backup is already gone.
      if (!backupIdentity && action.originalIdentity !== null) {
        if (!sameOriginal(originalIdentity(action.targetPath), action.originalIdentity)) throw invalid();
        continue;
      }
    }
    if (removeTargets || fs.existsSync(backupPath)) {
      fs.rmSync(action.targetPath, { recursive: true, force: true });
    }
    if (fs.existsSync(backupPath)) {
      fs.mkdirSync(path.dirname(action.targetPath), { recursive: true });
      fs.renameSync(backupPath, action.targetPath);
    }
  }
  for (const root of new Set([rollbackRoot, ...actions.map((action) => action.rollbackRoot).filter(Boolean)])) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { assignPromotionOriginals, assignRuntimeBackups, backupExisting,
  capturePromotionOriginals, captureRuntimeBackupOwner, rollbackPromotion, runtimeBackupRoot };
