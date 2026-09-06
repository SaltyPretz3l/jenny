'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { AttachmentAssetStore } = require('../attachment-asset-store');
const { DATA_ERROR_CODES } = require('../backend/error-codes');
const { ElectronSessionStore } = require('../backend/electron-session-store');
const { importSession } = require('../backend/session-export-import');
const {
  ARCHIVE_EXTENSION,
  COMPLETE_MARKER,
  extractArchive,
  readBoundedFile,
  readEnvelope,
  verifyArchive,
} = require('./archive-service');
const { archiveError, validateLogicalPath } = require('./archive-format');
const { projectRestoredPreference, readBoundedJson } = require('./restore-preferences');
const restoreDurability = require('./workspace-restore-durability');
const { WORKSPACE_RESTORE_JOURNAL, WORKSPACE_RESTORE_ROOT, createWorkspaceRestoreStage } = restoreDurability;
const { fsyncFile, listWorkspaceRestoreStages } = restoreDurability;
const { removeWorkspaceRestoreStage, writeJsonDurable } = restoreDurability;

const RESTORE_SCHEMA_VERSION = 1;
const RESTORE_SCAN_LIMIT = 50;
const MAX_WORKSPACE_RESTORE_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const PENDING_SUFFIX = '.jenny-restore-pending.json';
const ACTIVE_RESTORE_RELATIVE_PATH = path.join('data-lifecycle', 'restore-active.json');
const ALLOWED_ROOTS = Object.freeze(['sessions', 'preferences', 'personality', 'calendar', 'memory', 'workspace']);
function restorePointerPath(userDataPath) {
  const root = path.resolve(String(userDataPath || ''));
  return path.join(path.dirname(root), `.${path.basename(root)}${PENDING_SUFFIX}`);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function listDirectoryEntries(targetPath) {
  try {
    return fs.readdirSync(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function isPathWithin(ownerRoot, targetPath) {
  const relative = path.relative(path.resolve(ownerRoot), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isMeaningfullyFresh({ userDataPath, sessionStore = null } = {}) {
  if (!String(userDataPath || '').trim()) return false;
  if (sessionStore && typeof sessionStore.listSessions === 'function') {
    if ((sessionStore.listSessions() || []).length > 0) return false;
  } else if (listDirectoryEntries(path.join(userDataPath, 'sessions')).length > 0) {
    return false;
  }
  const meaningfulPaths = [
    path.join(userDataPath, 'sessions.json'),
    path.join(userDataPath, 'attachments'),
    path.join(userDataPath, 'personality', 'default-workspace'),
    path.join(userDataPath, 'home-calendar.json'),
    path.join(userDataPath, 'sidecar-memory.db'),
  ];
  return meaningfulPaths.every((targetPath) => {
    try {
      const stat = fs.lstatSync(targetPath);
      return stat.isDirectory() ? listDirectoryEntries(targetPath).length === 0 : stat.size === 0;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  });
}

function archiveFingerprint(archivePath) {
  const root = path.resolve(archivePath);
  readEnvelope(root);
  const hash = crypto.createHash('sha256');
  hash.update(readBoundedFile(path.join(root, 'archive.json'), 64 * 1024));
  hash.update(readBoundedFile(path.join(root, COMPLETE_MARKER), 256));
  return hash.digest('hex');
}

function findRestoreCandidates(defaultArchiveRoot, { limit = RESTORE_SCAN_LIMIT } = {}) {
  if (!defaultArchiveRoot || !fs.existsSync(defaultArchiveRoot)) return [];
  const rootStat = fs.lstatSync(defaultArchiveRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  const scanLimit = Math.max(0, Math.min(
    RESTORE_SCAN_LIMIT,
    Number.isSafeInteger(limit) ? limit : RESTORE_SCAN_LIMIT
  ));
  const candidates = [];
  const archiveDirectories = fs.readdirSync(defaultArchiveRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory() && !dirent.isSymbolicLink() && dirent.name.endsWith(ARCHIVE_EXTENSION))
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, scanLimit);
  for (const dirent of archiveDirectories) {
    const archivePath = path.join(defaultArchiveRoot, dirent.name);
    try {
      const { envelope } = readEnvelope(archivePath);
      candidates.push({
        archivePath,
        fingerprint: archiveFingerprint(archivePath),
        createdAt: String(envelope.created_at || ''),
        encrypted: Boolean(envelope.encrypted),
        counts: { entries: Number(envelope.entry_count || 0), bytes: Number(envelope.total_bytes || 0) },
      });
    } catch (_error) {
      // Incomplete, corrupt, and unsupported directories are not restore offers.
    }
  }
  return candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function describeRestoreCandidate(archivePath) {
  const root = path.resolve(String(archivePath || ''));
  if (!path.basename(root).endsWith(ARCHIVE_EXTENSION)) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Selected folder is not a Jenny archive.');
  }
  const { envelope } = readEnvelope(root);
  return {
    archivePath: root,
    fingerprint: archiveFingerprint(root),
    createdAt: String(envelope.created_at || ''),
    encrypted: Boolean(envelope.encrypted),
    counts: { entries: Number(envelope.entry_count || 0), bytes: Number(envelope.total_bytes || 0) },
  };
}

function validateRestorableManifest(manifest) {
  const sessionIds = new Set();
  for (const entry of manifest.entries) {
    const logicalPath = validateLogicalPath(entry.logical_path);
    const root = logicalPath.split('/')[0];
    if (!ALLOWED_ROOTS.includes(root)) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_entry_disallowed', 'Archive contains data that cannot be restored here.');
    }
    if (root === 'sessions' && !entry.restore_metadata?.session_id) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_identity_missing', 'Archive session identity is missing.');
    }
    if (root === 'sessions') {
      const sessionId = entry.restore_metadata.session_id.toLocaleLowerCase('en-US');
      if (sessionIds.has(sessionId)) {
        throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_identity_collision', 'Archive session identities collide.');
      }
      sessionIds.add(sessionId);
    }
  }
}

function workspaceRootIdentity(workspaceRoot) {
  const configured = path.resolve(String(workspaceRoot || ''));
  if (!String(workspaceRoot || '').trim() || !fs.existsSync(configured)) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Current workspace is unavailable or unsafe.');
  }
  const lexicalStat = fs.lstatSync(configured);
  const realPath = fs.realpathSync.native(configured);
  const realStat = fs.statSync(realPath);
  if (!lexicalStat.isDirectory() || lexicalStat.isSymbolicLink() || !realStat.isDirectory()) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Current workspace is unavailable or unsafe.');
  }
  return {
    configured,
    realPath,
    dev: String(realStat.dev),
    ino: String(realStat.ino),
  };
}

function assertWorkspaceRootIdentity(identity) {
  const current = workspaceRootIdentity(identity.configured);
  if (current.realPath !== identity.realPath || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'workspace_identity_changed', 'The selected workspace changed after review.');
  }
  return current;
}

function assertWorkspaceDestination(identity, targetPath) {
  assertWorkspaceRootIdentity(identity);
  const target = ensureSafeDestination(identity.realPath, targetPath);
  let existingParent = path.dirname(target);
  while (!fs.existsSync(existingParent)) {
    const parent = path.dirname(existingParent);
    if (parent === existingParent) {
      throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'A workspace restore target is unsafe.');
    }
    existingParent = parent;
  }
  const parentStat = fs.lstatSync(existingParent);
  const realParent = fs.realpathSync.native(existingParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !isPathWithin(identity.realPath, realParent)) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'A workspace restore target is unsafe.');
  }
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'A workspace restore target is unsafe.');
    }
  }
  return target;
}

async function workspaceTargetSignature(identity, targetPath) {
  const target = assertWorkspaceDestination(identity, targetPath);
  if (!fs.existsSync(target)) return 'missing';
  const stat = await fs.promises.lstat(target);
  if (stat.size > MAX_WORKSPACE_RESTORE_FILE_BYTES) {
    throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'workspace_target_too_large', 'A workspace restore conflict is too large to review safely.');
  }
  const hash = crypto.createHash('sha256');
  let totalBytes = 0;
  for await (const chunk of fs.createReadStream(target)) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_WORKSPACE_RESTORE_FILE_BYTES) {
      throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'workspace_target_too_large', 'A workspace restore conflict is too large to review safely.');
    }
    hash.update(chunk);
  }
  assertWorkspaceDestination(identity, target);
  const after = await fs.promises.lstat(target);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
    || after.dev !== stat.dev || after.ino !== stat.ino) {
    throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_review_stale', 'Workspace contents changed during review. Review conflicts again.');
  }
  return `${after.size}:${hash.digest('hex')}`;
}

async function inspectWorkspaceTargets({ archivePath, identity, entries }) {
  const conflicts = [];
  const signatures = new Map();
  const signatureRows = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const targetPath = assertWorkspaceDestination(identity, destinationForEntry(entry, {
      userDataPath: '', runtimePath: '', workspaceRoot: identity.realPath, includeWorkspace: true,
    }));
    const targetSignature = await workspaceTargetSignature(identity, targetPath);
    if (targetSignature !== 'missing') conflicts.push(entry.logical_path.slice('workspace/'.length));
    totalBytes += Number(entry.size || 0);
    signatures.set(entry.logical_path, targetSignature);
    signatureRows.push(`${entry.logical_path}:${entry.sha256}:${entry.size}:${targetSignature}`);
  }
  const fingerprint = archiveFingerprint(archivePath);
  return {
    fingerprint,
    digest: crypto.createHash('sha256')
      .update([fingerprint, identity.realPath, identity.dev, identity.ino, ...signatureRows].join('\n'))
      .digest('hex'),
    signatures,
    totalBytes,
    conflicts,
  };
}

async function inspectWorkspaceRestore({ archivePath, passphrase = '', workspaceRoot = '', onProgress = null } = {}) {
  const identity = workspaceRootIdentity(workspaceRoot);
  const verified = await verifyArchive(archivePath, { passphrase, onProgress });
  validateRestorableManifest(verified.manifest);
  const entries = verified.manifest.entries.filter((entry) => entry.logical_path.startsWith('workspace/'));
  if (!entries.length) {
    throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'workspace_data_missing', 'This archive has no workspace data.');
  }
  const targets = await inspectWorkspaceTargets({ archivePath, identity, entries });
  return {
    archivePath: path.resolve(archivePath),
    fingerprint: targets.fingerprint,
    digest: targets.digest,
    identity,
    entries,
    signatures: targets.signatures,
    itemCount: entries.length,
    totalBytes: targets.totalBytes,
    conflictCount: targets.conflicts.length,
    conflicts: targets.conflicts.slice(0, 20),
  };
}

function workspaceRestoreStagingRoot(identity) {
  const stagingRoot = ensureSafeDestination(
    identity.realPath,
    path.join(identity.realPath, WORKSPACE_RESTORE_ROOT)
  );
  if (fs.existsSync(stagingRoot)) {
    const stat = fs.lstatSync(stagingRoot);
    const realPath = fs.realpathSync.native(stagingRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realPath !== stagingRoot) {
      throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'workspace_restore_recovery_incomplete', 'Workspace restore recovery requires attention.');
    }
  }
  return stagingRoot;
}

function workspaceBackupPath(stagePath, entry) {
  return ensureSafeDestination(
    stagePath,
    path.join(stagePath, 'rollback', ...validateLogicalPath(entry.logical_path).split('/'))
  );
}

function writeWorkspaceRestoreJournal(stagePath, journal) {
  writeJsonDurable(path.join(stagePath, WORKSPACE_RESTORE_JOURNAL), journal);
}

async function replaceWorkspaceFile(sourcePath, targetPath) {
  try {
    await fs.promises.rename(sourcePath, targetPath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code) || !fs.existsSync(targetPath)) throw error;
    await fs.promises.rm(targetPath, { force: true });
    await fs.promises.rename(sourcePath, targetPath);
  }
}

async function rollbackWorkspaceActions(actions, rollbackRoot) {
  for (const action of actions.slice().reverse()) {
    assertWorkspaceDestination(action.identity, action.targetPath);
    if (action.hadBackup && fs.existsSync(action.backupPath)) {
      const capturedSignature = await workspaceTargetSignature(action.identity, action.backupPath);
      if (capturedSignature !== action.approvedSignature) {
        throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_rollback_incomplete', 'Workspace restore recovery requires attention.');
      }
      const currentSignature = await workspaceTargetSignature(action.identity, action.targetPath);
      if (currentSignature === action.restoredSignature || currentSignature === 'missing') {
        await fs.promises.mkdir(path.dirname(action.targetPath), { recursive: true });
        await replaceWorkspaceFile(action.backupPath, action.targetPath);
      } else if (currentSignature !== action.approvedSignature) {
        throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_rollback_incomplete', 'Workspace restore recovery requires attention.');
      }
    } else if (action.hadBackup) {
      const currentSignature = await workspaceTargetSignature(action.identity, action.targetPath);
      if (currentSignature !== action.approvedSignature) {
        throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_rollback_incomplete', 'Workspace restore recovery requires attention.');
      }
    } else if (action.replacementCreated) {
      const currentSignature = await workspaceTargetSignature(action.identity, action.targetPath);
      if (currentSignature === action.restoredSignature) await fs.promises.rm(action.targetPath, { force: true });
      else if (currentSignature !== 'missing') {
        throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_rollback_incomplete', 'Workspace restore recovery requires attention.');
      }
    }
  }
  await fs.promises.rm(rollbackRoot, { recursive: true, force: true });
}

function parseWorkspaceRestoreJournal(stagePath, identity) {
  const stageStat = fs.lstatSync(stagePath);
  const realStagePath = fs.realpathSync.native(stagePath);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()
    || path.dirname(path.resolve(stagePath)) !== workspaceRestoreStagingRoot(identity)
    || realStagePath !== path.resolve(stagePath)) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'workspace_restore_recovery_incomplete', 'Workspace restore recovery requires attention.');
  }
  const journal = readBoundedJson(path.join(stagePath, WORKSPACE_RESTORE_JOURNAL), 2 * 1024 * 1024);
  const journalIdentity = journal?.workspace || {};
  const entries = Array.isArray(journal?.entries) ? journal.entries : [];
  const completedPaths = Array.isArray(journal?.completed_paths) ? journal.completed_paths : [];
  const validStatus = ['staging', 'ready', 'mutating', 'committed'].includes(journal?.status);
  if (journal?.schema_version !== RESTORE_SCHEMA_VERSION
    || path.resolve(String(journal?.stage_path || '')) !== path.resolve(stagePath)
    || journalIdentity.real_path !== identity.realPath
    || String(journalIdentity.dev) !== identity.dev
    || String(journalIdentity.ino) !== identity.ino
    || !validStatus || entries.length > 10_000) {
    throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_recovery_incomplete', 'Workspace restore recovery requires attention.');
  }
  const seen = new Set();
  for (const entry of entries) {
    const logicalPath = validateLogicalPath(entry?.logical_path);
    const validApprovedSignature = entry?.approved_signature === 'missing'
      || /^\d+:[a-f0-9]{64}$/.test(String(entry?.approved_signature || ''));
    if (!logicalPath.startsWith('workspace/') || seen.has(logicalPath)
      || !/^[a-f0-9]{64}$/.test(String(entry?.sha256 || ''))
      || !Number.isSafeInteger(entry?.size) || entry.size < 0
      || !validApprovedSignature) {
      throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_recovery_incomplete', 'Workspace restore recovery requires attention.');
    }
    seen.add(logicalPath);
  }
  if (completedPaths.length > entries.length
    || completedPaths.some((logicalPath) => !seen.has(logicalPath))) {
    throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_recovery_incomplete', 'Workspace restore recovery requires attention.');
  }
  return journal;
}

async function recoverWorkspaceRestoreStage(stagePath, stagingRoot, identity) {
  const journal = parseWorkspaceRestoreJournal(stagePath, identity);
  if (journal.status === 'committed') {
    await removeWorkspaceRestoreStage(stagePath, stagingRoot);
    return true;
  }
  if (journal.status === 'staging' || journal.status === 'ready') {
    await removeWorkspaceRestoreStage(stagePath, stagingRoot);
    return true;
  }
  const completedPaths = new Set(journal.completed_paths);
  for (const entry of journal.entries.slice().reverse()) {
    const targetPath = assertWorkspaceDestination(identity, destinationForEntry(entry, {
      userDataPath: '', runtimePath: '', workspaceRoot: identity.realPath, includeWorkspace: true,
    }));
    const backupPath = workspaceBackupPath(stagePath, entry);
    const restoredSignature = `${entry.size}:${entry.sha256}`;
    if (entry.approved_signature !== 'missing') {
      if (fs.existsSync(backupPath)) {
        if (await workspaceTargetSignature(identity, backupPath) !== entry.approved_signature) {
          throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_recovery_incomplete', 'Workspace restore recovery requires attention.');
        }
        const currentSignature = await workspaceTargetSignature(identity, targetPath);
        if (currentSignature === restoredSignature || currentSignature === 'missing') {
          await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
          await replaceWorkspaceFile(backupPath, targetPath);
        } else if (currentSignature !== entry.approved_signature) {
          throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_recovery_incomplete', 'Workspace restore recovery requires attention.');
        }
      } else if (await workspaceTargetSignature(identity, targetPath) !== entry.approved_signature) {
        throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_recovery_incomplete', 'Workspace restore recovery requires attention.');
      }
    } else if (fs.existsSync(targetPath)) {
      const currentSignature = await workspaceTargetSignature(identity, targetPath);
      if (currentSignature === restoredSignature) {
        await fs.promises.rm(targetPath, { force: true });
      } else if (completedPaths.has(entry.logical_path)) {
        throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_recovery_incomplete', 'Workspace restore recovery requires attention.');
      }
    }
  }
  await removeWorkspaceRestoreStage(stagePath, stagingRoot);
  return true;
}

async function recoverWorkspaceRestoreStages({ workspaceRoot = '', logger = null } = {}) {
  if (!String(workspaceRoot || '').trim()) return { ok: true, recoveredCount: 0 };
  const identity = workspaceRootIdentity(workspaceRoot);
  const stagingRoot = workspaceRestoreStagingRoot(identity);
  const stages = await listWorkspaceRestoreStages(stagingRoot);
  let recoveredCount = 0;
  for (const stagePath of stages) {
    try {
      if (!fs.existsSync(path.join(stagePath, WORKSPACE_RESTORE_JOURNAL))) {
        const names = await fs.promises.readdir(stagePath);
        const onlyPreJournalState = names.length <= 2 && names.every((name) => (
          name.startsWith(`${WORKSPACE_RESTORE_JOURNAL}.`) && name.endsWith('.tmp')
        ));
        if (!onlyPreJournalState) {
          throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_recovery_incomplete', 'Workspace restore recovery requires attention.');
        }
        await removeWorkspaceRestoreStage(stagePath, stagingRoot);
      } else {
        await recoverWorkspaceRestoreStage(stagePath, stagingRoot, identity);
      }
      recoveredCount += 1;
    } catch (error) {
      logger?.('WARN', 'data_lifecycle.workspace_restore_recovery_failed', {
        reason: String(error?.reason || 'workspace_restore_recovery_incomplete').slice(0, 80),
      });
      throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_restore_recovery_incomplete', 'Workspace restore recovery requires attention.');
    }
  }
  return { ok: true, recoveredCount };
}

async function restoreWorkspace({ archivePath, userDataPath, passphrase = '', workspaceRoot = '', expectedDigest = '', onProgress = null, logger = null } = {}) {
  const inspection = await inspectWorkspaceRestore({ archivePath, passphrase, workspaceRoot, onProgress });
  if (!expectedDigest || inspection.digest !== expectedDigest) {
    throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_review_stale', 'Workspace contents changed after review. Review conflicts again.');
  }
  const stagingRoot = workspaceRestoreStagingRoot(inspection.identity);
  fs.mkdirSync(stagingRoot, { recursive: true });
  workspaceRestoreStagingRoot(inspection.identity);
  const stagePath = createWorkspaceRestoreStage(stagingRoot);
  workspaceRestoreStagingRoot(inspection.identity);
  const rollbackRoot = path.join(stagePath, 'rollback');
  const actions = [];
  const journal = {
    schema_version: RESTORE_SCHEMA_VERSION,
    status: 'staging',
    stage_path: stagePath,
    workspace: {
      real_path: inspection.identity.realPath,
      dev: inspection.identity.dev,
      ino: inspection.identity.ino,
    },
    entries: inspection.entries.map((entry) => ({
      logical_path: entry.logical_path,
      sha256: entry.sha256,
      size: entry.size,
      approved_signature: inspection.signatures.get(entry.logical_path),
    })),
    completed_paths: [],
  };
  try {
    writeWorkspaceRestoreJournal(stagePath, journal);
    await extractArchive(archivePath, path.join(stagePath, 'data'), { passphrase });
    assertWorkspaceRootIdentity(inspection.identity);
    for (const entry of inspection.entries) await verifyStagedEntry(stagePath, entry);
    journal.status = 'ready';
    writeWorkspaceRestoreJournal(stagePath, journal);
    const currentTargets = await inspectWorkspaceTargets({
      archivePath,
      identity: inspection.identity,
      entries: inspection.entries,
    });
    if (currentTargets.digest !== expectedDigest) {
      throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_review_stale', 'Workspace contents changed after review. Review conflicts again.');
    }
    for (const entry of journal.entries) {
      entry.approved_signature = currentTargets.signatures.get(entry.logical_path);
    }
    journal.status = 'mutating';
    writeWorkspaceRestoreJournal(stagePath, journal);
    for (const entry of inspection.entries) {
      assertWorkspaceRootIdentity(inspection.identity);
      const sourcePath = await verifyStagedEntry(stagePath, entry);
      const targetPath = assertWorkspaceDestination(inspection.identity, destinationForEntry(entry, {
        userDataPath: '', runtimePath: '', workspaceRoot: inspection.identity.realPath, includeWorkspace: true,
      }));
      const approvedSignature = currentTargets.signatures.get(entry.logical_path);
      if (await workspaceTargetSignature(inspection.identity, targetPath) !== approvedSignature) {
        throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_review_stale', 'Workspace contents changed after review. Review conflicts again.');
      }
      const action = {
        targetPath,
        ownerRoot: inspection.identity.realPath,
        ownerKey: 'workspace',
        identity: inspection.identity,
        backupPath: '',
        hadBackup: false,
        replacementCreated: false,
        approvedSignature,
        restoredSignature: `${entry.size}:${entry.sha256}`,
      };
      action.hadBackup = approvedSignature !== 'missing';
      action.backupPath = action.hadBackup ? workspaceBackupPath(stagePath, entry) : '';
      if (action.hadBackup) {
        await fs.promises.mkdir(path.dirname(action.backupPath), { recursive: true });
        await fs.promises.copyFile(targetPath, action.backupPath, fs.constants.COPYFILE_EXCL);
      }
      const capturedSignature = action.hadBackup
        ? await workspaceTargetSignature(inspection.identity, action.backupPath)
        : 'missing';
      if (capturedSignature !== approvedSignature) {
        throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_review_stale', 'Workspace contents changed after review. Review conflicts again.');
      }
      if (action.hadBackup) fsyncFile(action.backupPath, stagePath);
      if (await workspaceTargetSignature(inspection.identity, targetPath) !== approvedSignature) {
        throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'workspace_review_stale', 'Workspace contents changed after review. Review conflicts again.');
      }
      actions.push(action);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      assertWorkspaceDestination(inspection.identity, targetPath);
      await replaceWorkspaceFile(sourcePath, targetPath);
      action.replacementCreated = true;
      fsyncFile(targetPath, inspection.identity.realPath);
      journal.completed_paths.push(entry.logical_path);
      writeWorkspaceRestoreJournal(stagePath, journal);
    }
    journal.status = 'committed';
    writeWorkspaceRestoreJournal(stagePath, journal);
    await removeWorkspaceRestoreStage(stagePath, stagingRoot).catch((error) => {
      logger?.('WARN', 'data_lifecycle.workspace_restore_cleanup_deferred', {
        reason: String(error?.code || 'cleanup_failed').slice(0, 40),
      });
    });
    return { ok: true, status: 'workspace_restored', restoredCount: actions.length };
  } catch (error) {
    try {
      await rollbackWorkspaceActions(actions, rollbackRoot);
      await removeWorkspaceRestoreStage(stagePath, stagingRoot);
    } catch (_rollbackError) {
      error.reason = 'workspace_restore_rollback_incomplete';
    }
    throw error;
  }
}

function assertSiblingStage(userDataPath, stagePath, { mustExist = true, operationId = '' } = {}) {
  const userRoot = path.resolve(userDataPath);
  const stageRoot = path.resolve(stagePath);
  const expectedParent = path.dirname(userRoot);
  const relative = path.relative(expectedParent, stageRoot);
  const expectedName = operationId
    ? `${path.basename(userRoot)}.jenny-restore-${operationId}.staging`
    : '';
  const validName = expectedName
    ? path.basename(stageRoot) === expectedName
    : path.basename(stageRoot).startsWith(`${path.basename(userRoot)}.jenny-restore-`)
      && path.basename(stageRoot).endsWith('.staging');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !validName) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Restore staging path is unsafe.');
  }
  if (mustExist) {
    const stat = fs.lstatSync(stageRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Restore staging path is unsafe.');
    }
  }
  return stageRoot;
}

async function stageRestore({
  archivePath,
  userDataPath,
  runtimePath = '',
  sessionStore = null,
  passphrase = '',
  includeWorkspace = false,
  workspaceRoot = '',
  onProgress = null,
} = {}) {
  if (!isMeaningfullyFresh({ userDataPath, sessionStore })) {
    throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'profile_not_fresh', 'Full archive restore requires a fresh Jenny profile.');
  }
  const verified = await verifyArchive(archivePath, { passphrase, onProgress });
  validateRestorableManifest(verified.manifest);
  if (includeWorkspace) {
    const workspaceStat = workspaceRoot && fs.existsSync(workspaceRoot) ? fs.lstatSync(workspaceRoot) : null;
    if (!workspaceStat?.isDirectory() || workspaceStat.isSymbolicLink()) {
      throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Current workspace is unavailable or unsafe.');
    }
  }
  const userRoot = path.resolve(userDataPath);
  buildPromotionActions(verified.manifest, {
    userDataPath: userRoot,
    runtimePath,
    workspaceRoot,
    includeWorkspace,
  });
  const operationId = crypto.randomUUID();
  const stagePath = path.join(path.dirname(userRoot), `${path.basename(userRoot)}.jenny-restore-${operationId}.staging`);
  const dataPath = path.join(stagePath, 'data');
  try {
    await fs.promises.mkdir(stagePath, { recursive: false });
    const extracted = await extractArchive(archivePath, dataPath, { passphrase });
    const journal = {
      schema_version: RESTORE_SCHEMA_VERSION,
      operation_id: operationId,
      status: 'staged',
      created_at: new Date().toISOString(),
      user_data_path: userRoot,
      stage_path: stagePath,
      fingerprint: archiveFingerprint(archivePath),
      include_workspace: Boolean(includeWorkspace && workspaceRoot),
      workspace_root: includeWorkspace && workspaceRoot ? path.resolve(workspaceRoot) : '',
      manifest: extracted.manifest,
    };
    writeJsonAtomic(path.join(stagePath, 'restore-journal.json'), journal);
    writeJsonAtomic(restorePointerPath(userRoot), {
      schema_version: RESTORE_SCHEMA_VERSION,
      operation_id: operationId,
      user_data_path: userRoot,
      stage_path: stagePath,
    });
    return { ok: true, status: 'restart_required', operationId, fingerprint: journal.fingerprint };
  } catch (error) {
    await fs.promises.rm(stagePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function ensureSafeDestination(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Restore destination escapes its owner root.');
  }
  if (fs.existsSync(root)) {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Restore owner root is unsafe.');
    }
  }
  let current = root;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Restore destination contains an unsafe link.');
    }
  }
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink()) {
      throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Restore destination is an unsafe link.');
    }
  }
  return target;
}

function assertSafeStagedSource(stagePath, sourcePath) {
  const dataRoot = path.join(stagePath, 'data');
  const safePath = ensureSafeDestination(dataRoot, sourcePath);
  const realRoot = fs.realpathSync.native(dataRoot);
  const realSource = fs.realpathSync.native(safePath);
  const relative = path.relative(realRoot, realSource);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Staged restore entry escapes its owner root.');
  }
  return safePath;
}

async function verifyStagedEntry(stagePath, entry) {
  const sourcePath = assertSafeStagedSource(
    stagePath,
    path.join(stagePath, 'data', ...entry.logical_path.split('/'))
  );
  const sourceStat = fs.lstatSync(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== entry.size) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_state_invalid', 'Staged restore entry is unsafe.');
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(sourcePath)) hash.update(chunk);
  if (hash.digest('hex') !== entry.sha256) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_checksum_failed', 'Staged restore entry failed verification.');
  }
  return sourcePath;
}

function destinationForEntry(entry, { userDataPath, runtimePath, workspaceRoot, includeWorkspace }) {
  const logicalPath = validateLogicalPath(entry.logical_path);
  const [root, ...rest] = logicalPath.split('/');
  if (root === 'sessions') return null;
  if (root === 'preferences') {
    if (rest.length === 1 && rest[0] === 'shell-config.json') {
      return ensureSafeDestination(userDataPath, path.join(userDataPath, 'shell-config.json'));
    }
    return ensureSafeDestination(userDataPath, path.join(userDataPath, 'data-lifecycle', ...rest));
  }
  if (root === 'personality') {
    return ensureSafeDestination(userDataPath, path.join(userDataPath, 'personality', 'default-workspace', ...rest));
  }
  if (root === 'calendar') {
    return ensureSafeDestination(userDataPath, path.join(userDataPath, ...rest));
  }
  if (root === 'memory') {
    const fileName = rest.at(-1);
    if (fileName === 'sidecar-memory.db') {
      return ensureSafeDestination(userDataPath, path.join(userDataPath, fileName));
    }
    if (!runtimePath || !['jenny_memory.db', 'legacy-memory.db'].includes(fileName)) return null;
    const targetName = fileName === 'legacy-memory.db' ? 'memory.db' : fileName;
    return ensureSafeDestination(runtimePath, path.join(runtimePath, targetName));
  }
  if (root === 'workspace' && includeWorkspace && workspaceRoot) {
    return ensureSafeDestination(workspaceRoot, path.join(workspaceRoot, '.jenny', ...rest));
  }
  return null;
}

function backupExisting(targetPath, rollbackRoot, ownerRoot, ownerKey) {
  ensureSafeDestination(ownerRoot, targetPath);
  if (!fs.existsSync(targetPath)) return null;
  const relative = path.relative(path.resolve(ownerRoot), path.resolve(targetPath));
  const backupPath = ensureSafeDestination(rollbackRoot, path.join(rollbackRoot, ownerKey, relative));
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.renameSync(targetPath, backupPath);
  return backupPath;
}

function buildPromotionActions(manifest, context) {
  const actions = [
    { targetPath: path.join(context.userDataPath, 'sessions'), ownerRoot: context.userDataPath, ownerKey: 'user' },
    { targetPath: path.join(context.userDataPath, 'sessions.json'), ownerRoot: context.userDataPath, ownerKey: 'user' },
    { targetPath: path.join(context.userDataPath, 'attachments'), ownerRoot: context.userDataPath, ownerKey: 'user' },
  ];
  for (const entry of manifest.entries) {
    const targetPath = destinationForEntry(entry, context);
    if (!targetPath) continue;
    const workspaceEntry = entry.logical_path.startsWith('workspace/');
    const runtimeEntry = entry.logical_path.startsWith('memory/') && !isPathWithin(context.userDataPath, targetPath);
    actions.push({
      targetPath,
      ownerRoot: workspaceEntry ? context.workspaceRoot : runtimeEntry ? context.runtimePath : context.userDataPath,
      ownerKey: workspaceEntry ? 'workspace' : runtimeEntry ? 'runtime' : 'user',
    });
  }
  const seen = new Set();
  for (const action of actions) {
    const key = path.resolve(action.targetPath).toLocaleLowerCase('en-US');
    if (seen.has(key)) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_path_collision', 'Archive entries map to the same restore destination.');
    }
    seen.add(key);
  }
  return actions;
}

function backupPathForAction(action, rollbackRoot) {
  const relative = path.relative(path.resolve(action.ownerRoot), path.resolve(action.targetPath));
  return ensureSafeDestination(rollbackRoot, path.join(rollbackRoot, action.ownerKey, relative));
}

function rollbackPromotion(actions, rollbackRoot, removeTargets) {
  for (const action of actions.slice().reverse()) {
    ensureSafeDestination(action.ownerRoot, action.targetPath);
    const backupPath = backupPathForAction(action, rollbackRoot);
    if (removeTargets || fs.existsSync(backupPath)) {
      fs.rmSync(action.targetPath, { recursive: true, force: true });
    }
    if (fs.existsSync(backupPath)) {
      fs.mkdirSync(path.dirname(action.targetPath), { recursive: true });
      fs.renameSync(backupPath, action.targetPath);
    }
  }
  fs.rmSync(rollbackRoot, { recursive: true, force: true });
}

function createRestoreStores(userDataPath, nativeImage) {
  return {
    sessionStore: new ElectronSessionStore(path.join(userDataPath, 'sessions.json')),
    attachmentStore: new AttachmentAssetStore({ rootDir: path.join(userDataPath, 'attachments'), nativeImage }),
  };
}

async function promotePendingRestore({ userDataPath, runtimePath = '', nativeImage = null } = {}) {
  const userRoot = path.resolve(String(userDataPath || ''));
  const pointerPath = restorePointerPath(userRoot);
  if (!fs.existsSync(pointerPath)) return { ok: true, status: 'none' };
  const pointer = readBoundedJson(pointerPath);
  if (
    pointer.schema_version !== RESTORE_SCHEMA_VERSION
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pointer.operation_id || '')
    || path.resolve(pointer.user_data_path || '') !== userRoot
  ) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_state_invalid', 'Restore pointer is invalid.');
  }
  const stagePath = assertSiblingStage(userRoot, pointer.stage_path, { operationId: pointer.operation_id });
  const journalPath = path.join(stagePath, 'restore-journal.json');
  const journal = readBoundedJson(journalPath, 4 * 1024 * 1024);
  if (
    journal.schema_version !== RESTORE_SCHEMA_VERSION
    || journal.operation_id !== pointer.operation_id
    || path.resolve(journal.user_data_path || '') !== userRoot
    || path.resolve(journal.stage_path || '') !== stagePath
  ) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_state_invalid', 'Restore journal is invalid.');
  }
  const manifest = journal.manifest;
  validateRestorableManifest(manifest);
  const rollbackRoot = path.join(path.dirname(userRoot), `${path.basename(userRoot)}.jenny-restore-rollback-${journal.operation_id}`);
  const context = {
    userDataPath: userRoot,
    runtimePath,
    workspaceRoot: journal.workspace_root,
    includeWorkspace: journal.include_workspace,
  };
  const actions = buildPromotionActions(manifest, context);
  const activeMarkerPath = path.join(userRoot, ACTIVE_RESTORE_RELATIVE_PATH);
  if (fs.existsSync(activeMarkerPath)) {
    const active = readBoundedJson(activeMarkerPath);
    if (active.operation_id === journal.operation_id && active.status === 'promoted') {
      fs.rmSync(pointerPath, { force: true });
      return { ok: true, status: 'promoted', operationId: journal.operation_id };
    }
  }
  if (journal.status === 'promoting' || journal.status === 'copying') {
    rollbackPromotion(actions, rollbackRoot, journal.status === 'copying');
    journal.status = 'staged';
    writeJsonAtomic(journalPath, journal);
  }
  if (!isMeaningfullyFresh({ userDataPath: userRoot })) {
    throw archiveError(DATA_ERROR_CODES.RESTORE_CONFLICT, 'profile_not_fresh', 'Jenny data appeared before restore promotion.');
  }
  const projectedPreferences = new Map();
  for (const entry of manifest.entries) {
    const sourcePath = await verifyStagedEntry(stagePath, entry);
    const projected = projectRestoredPreference(entry, sourcePath);
    if (projected) projectedPreferences.set(entry.logical_path, projected);
  }
  try {
    fs.mkdirSync(userRoot, { recursive: true });
    journal.status = 'promoting';
    writeJsonAtomic(journalPath, journal);
    fs.mkdirSync(rollbackRoot, { recursive: false });
    for (const action of actions) {
      backupExisting(action.targetPath, rollbackRoot, action.ownerRoot, action.ownerKey);
    }
    journal.status = 'copying';
    writeJsonAtomic(journalPath, journal);
    ensureSafeDestination(userRoot, path.join(userRoot, 'sessions'));
    ensureSafeDestination(userRoot, path.join(userRoot, 'sessions.json'));
    ensureSafeDestination(userRoot, path.join(userRoot, 'attachments'));
    const stores = createRestoreStores(userRoot, nativeImage);
    for (const entry of manifest.entries) {
      const sourcePath = assertSafeStagedSource(
        stagePath,
        path.join(stagePath, 'data', ...entry.logical_path.split('/'))
      );
      if (entry.logical_path.startsWith('sessions/')) {
        ensureSafeDestination(userRoot, path.join(userRoot, 'sessions'));
        ensureSafeDestination(userRoot, path.join(userRoot, 'sessions.json'));
        ensureSafeDestination(userRoot, path.join(userRoot, 'attachments'));
        const sessionBytes = fs.readFileSync(sourcePath);
        if (
          sessionBytes.length !== entry.size
          || crypto.createHash('sha256').update(sessionBytes).digest('hex') !== entry.sha256
        ) {
          throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_checksum_failed', 'Staged restore entry failed verification.');
        }
        importSession(stores.sessionStore, sessionBytes.toString('utf8'), stores.attachmentStore, {
          trustedArchive: true,
          restoredSessionId: entry.restore_metadata?.session_id,
        });
        continue;
      }
      const targetPath = destinationForEntry(entry, {
        ...context,
      });
      if (!targetPath) continue;
      const ownerRoot = entry.logical_path.startsWith('workspace/')
        ? journal.workspace_root
        : entry.logical_path.startsWith('memory/') && !isPathWithin(userRoot, targetPath)
          ? runtimePath
          : userRoot;
      ensureSafeDestination(ownerRoot, targetPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      ensureSafeDestination(ownerRoot, targetPath);
      const projected = projectedPreferences.get(entry.logical_path);
      if (projected) fs.writeFileSync(targetPath, projected, { flag: 'wx' });
      else fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      const copiedHash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(targetPath)) copiedHash.update(chunk);
      const expectedHash = projected
        ? crypto.createHash('sha256').update(projected).digest('hex')
        : entry.sha256;
      if (copiedHash.digest('hex') !== expectedHash) {
        throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_checksum_failed', 'Restored entry failed verification.');
      }
    }
    writeJsonAtomic(activeMarkerPath, {
      schema_version: RESTORE_SCHEMA_VERSION,
      operation_id: journal.operation_id,
      rollback_path: rollbackRoot,
      stage_path: stagePath,
      status: 'promoted',
    });
    fs.rmSync(pointerPath, { force: true });
    return { ok: true, status: 'promoted', operationId: journal.operation_id };
  } catch (error) {
    rollbackPromotion(actions, rollbackRoot, journal.status === 'copying');
    journal.status = 'staged';
    writeJsonAtomic(journalPath, journal);
    throw error;
  }
}

async function attemptPendingRestore(options = {}) {
  try {
    return await promotePendingRestore(options);
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      error: {
        code: String(error?.code || DATA_ERROR_CODES.ARCHIVE_CORRUPT),
        reason: String(error?.reason || 'restore_promotion_failed'),
      },
    };
  }
}

async function finalizeRestoredBoot(userDataPath) {
  const markerPath = path.join(path.resolve(userDataPath), ACTIVE_RESTORE_RELATIVE_PATH);
  if (!fs.existsSync(markerPath)) return false;
  const marker = readBoundedJson(markerPath);
  const rollbackRoot = path.resolve(String(marker.rollback_path || ''));
  const stagePath = path.resolve(String(marker.stage_path || ''));
  assertSiblingStage(userDataPath, stagePath, { mustExist: false, operationId: marker.operation_id });
  const parent = path.dirname(path.resolve(userDataPath));
  const expectedRollbackName = `${path.basename(path.resolve(userDataPath))}.jenny-restore-rollback-${marker.operation_id}`;
  if (path.dirname(rollbackRoot) !== parent || path.basename(rollbackRoot) !== expectedRollbackName) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Restore rollback path is unsafe.');
  }
  for (const ownedPath of [rollbackRoot, stagePath]) {
    if (!fs.existsSync(ownedPath)) continue;
    const stat = fs.lstatSync(ownedPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path', 'Restore cleanup path is unsafe.');
    }
  }
  await fs.promises.rm(rollbackRoot, { recursive: true, force: true });
  await fs.promises.rm(stagePath, { recursive: true, force: true });
  await fs.promises.rm(markerPath, { force: true });
  return true;
}

module.exports = {
  attemptPendingRestore,
  describeRestoreCandidate,
  finalizeRestoredBoot,
  findRestoreCandidates,
  isMeaningfullyFresh,
  promotePendingRestore,
  recoverWorkspaceRestoreStages,
  restorePointerPath,
  stageRestore,
  inspectWorkspaceRestore,
  restoreWorkspace,
  workspaceRootIdentity,
};
