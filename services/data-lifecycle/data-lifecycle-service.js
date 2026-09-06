'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const { DATA_ERROR_CODES } = require('../backend/error-codes');
const { createArchive, buildDefaultArchiveRoot } = require('./archive-service');
const { KNOWN_RUNTIME_CHILDREN } = require('./cleanup-service');
const { collectDataInventory, countSessionAttachments } = require('./data-inventory');
const { PortablePreferencesStore, projectPortableShellConfig } = require('./portable-preferences-store');
const { boundedDataError, dataLifecycleFailure, dataLifecycleResult } = require('./data-lifecycle-result');
const {
  findRestoreCandidates,
  isMeaningfullyFresh,
  inspectWorkspaceRestore,
  recoverWorkspaceRestoreStages,
  restoreWorkspace,
  stageRestore,
  workspaceRootIdentity,
} = require('./restore-service');

const REVIEW_TTL_MS = 10 * 60 * 1000;

async function hashInventoryEntry(entry) {
  if (entry.data) return crypto.createHash('sha256').update(entry.data).digest('hex');
  const before = await fs.promises.lstat(entry.sourcePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== Number(entry.size || 0)) {
    throw Object.assign(new Error('Workspace archive contents changed during review.'), {
      code: DATA_ERROR_CODES.RESTORE_CONFLICT,
      reason: 'workspace_review_stale',
    });
  }
  const hash = crypto.createHash('sha256');
  let totalBytes = 0;
  for await (const chunk of fs.createReadStream(entry.sourcePath)) {
    totalBytes += chunk.length;
    if (totalBytes > before.size) {
      throw Object.assign(new Error('Workspace archive contents changed during review.'), {
        code: DATA_ERROR_CODES.RESTORE_CONFLICT,
        reason: 'workspace_review_stale',
      });
    }
    hash.update(chunk);
  }
  const after = await fs.promises.lstat(entry.sourcePath);
  if (totalBytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || after.ctimeMs !== before.ctimeMs || after.dev !== before.dev || after.ino !== before.ino) {
    throw Object.assign(new Error('Workspace archive contents changed during review.'), {
      code: DATA_ERROR_CODES.RESTORE_CONFLICT,
      reason: 'workspace_review_stale',
    });
  }
  return hash.digest('hex');
}

async function workspaceInventorySummary(inventory, workspaceRoot) {
  const entries = inventory.entries
    .filter((entry) => entry.logicalPath.startsWith('workspace/'))
    .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  const totalBytes = entries.reduce((total, entry) => total + Number(entry.data?.length || entry.size || 0), 0);
  const identity = workspaceRootIdentity(workspaceRoot);
  const hashes = new Map();
  for (const entry of entries) hashes.set(entry.logicalPath, await hashInventoryEntry(entry));
  const digest = crypto.createHash('sha256')
    .update([identity.realPath, identity.dev, identity.ino, ...entries.map((entry) => (
      `${entry.logicalPath}:${entry.data?.length || entry.size || 0}:${hashes.get(entry.logicalPath)}`
    ))].join('\n'))
    .digest('hex');
  return {
    digest,
    hashes,
    itemCount: entries.length,
    totalBytes,
    workspace: {
      name: path.basename(identity.realPath).slice(0, 120),
      id: crypto.createHash('sha256').update(`${identity.realPath}:${identity.dev}:${identity.ino}`).digest('hex').slice(0, 16),
    },
    scope: '.jenny portable data only',
  };
}

const REMOVAL_CHOICES = Object.freeze({
  APP_ONLY: 'app_only',
  ARCHIVE_AND_REMOVE: 'archive_and_remove',
  PERMANENT: 'permanent',
});

function countFiles(rootPath, limit = 10_000) {
  if (!rootPath || !fs.existsSync(rootPath)) return 0;
  let count = 0;
  const queue = [rootPath];
  while (queue.length && count < limit) {
    const current = queue.shift();
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) queue.push(path.join(current, dirent.name));
      else if (dirent.isFile()) count += 1;
      if (count >= limit) break;
    }
  }
  return count;
}

function resolvePotentialRealPath(targetPath) {
  let current = path.resolve(targetPath);
  const missingSegments = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
  const realAncestor = fs.existsSync(current) ? fs.realpathSync.native(current) : current;
  return path.resolve(realAncestor, ...missingSegments);
}

function isSameOrWithin(rootPath, targetPath) {
  const relative = path.relative(resolvePotentialRealPath(rootPath), resolvePotentialRealPath(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

class DataLifecycleService extends EventEmitter {
  constructor({
    userDataPath,
    documentsPath,
    runtimePath = '',
    appVersion = '0.0.0',
    sessionStore = null,
    attachmentStore = null,
    shellConfigService = null,
    workspaceRootCoordinator = null,
    prepareForRemoval = async () => {},
    logger = null,
    nowProvider = () => Date.now(),
  } = {}) {
    super();
    if (!String(userDataPath || '').trim() || !String(documentsPath || '').trim()) {
      throw new TypeError('DataLifecycleService requires userDataPath and documentsPath.');
    }
    this.userDataPath = path.resolve(userDataPath);
    this.documentsPath = path.resolve(documentsPath);
    this.runtimePath = runtimePath ? path.resolve(runtimePath) : '';
    this.appVersion = String(appVersion || '0.0.0');
    this.sessionStore = sessionStore;
    this.attachmentStore = attachmentStore;
    this.shellConfigService = shellConfigService;
    this.workspaceRootCoordinator = workspaceRootCoordinator;
    this.prepareForRemoval = prepareForRemoval;
    this.logger = typeof logger === 'function' ? logger : null;
    this.preferencesStore = new PortablePreferencesStore(this.userDataPath, { logger });
    this.activeOperation = null;
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => Date.now();
    this.workspaceArchiveReview = null;
    this.workspaceRestoreReview = null;
    this.workspaceRecoveryRoot = '';
    this.workspaceRecoveryPromise = null;
    void this._ensureWorkspaceRecovery().catch((error) => {
      this.logger?.('WARN', 'data_lifecycle.workspace_restore_recovery_deferred', {
        reason: String(error?.reason || 'workspace_restore_recovery_incomplete').slice(0, 80),
      });
    });
  }

  _workspaceRoot() {
    const value = this.shellConfigService?.getState?.()?.toolsWorkspaceRoot;
    if (!value || !path.isAbsolute(value) || !fs.existsSync(value)) return '';
    try {
      const stat = fs.lstatSync(value);
      return stat.isDirectory() && !stat.isSymbolicLink() ? path.resolve(value) : '';
    } catch (_error) {
      return '';
    }
  }

  _result(operationId, status, fields = {}) {
    return dataLifecycleResult(status, fields, operationId);
  }

  _failure(operationId, error) {
    const safeError = boundedDataError(error);
    this.logger?.('WARN', 'data_lifecycle.operation_failed', {
      operationId,
      code: safeError.code,
      reason: safeError.reason,
    });
    return dataLifecycleFailure(safeError, operationId);
  }

  async _run(type, task) {
    if (this.activeOperation) {
      return this._failure('', { code: DATA_ERROR_CODES.BUSY, reason: 'operation_busy' });
    }
    const operation = {
      id: crypto.randomUUID(),
      type,
      cancelRequested: false,
      committed: false,
    };
    this.activeOperation = operation;
    try {
      return await task(operation);
    } catch (error) {
      return this._failure(operation.id, error);
    } finally {
      if (this.activeOperation === operation) this.activeOperation = null;
    }
  }

  _progress(operation, payload) {
    const progress = {
      operationId: operation.id,
      phase: String(payload?.phase || 'working').slice(0, 48),
      percent: Math.max(0, Math.min(100, Math.round(Number(payload?.percent) || 0))),
      completedBytes: Math.max(0, Number(payload?.completedBytes) || 0),
      totalBytes: Math.max(0, Number(payload?.totalBytes) || 0),
      label: String(payload?.label || '').slice(0, 120),
    };
    this.emit('progress', progress);
  }

  async getOverview() {
    await this._ensureWorkspaceRecovery();
    const workspaceRoot = this._workspaceRoot();
    const summaries = this.sessionStore?.listSessions?.() || [];
    const portablePreferences = this.preferencesStore.read();
    return this._result('', 'ready', {
      counts: {
        chats: Array.isArray(summaries) ? summaries.length : 0,
        attachments: countSessionAttachments(this.sessionStore),
        memory: [
          path.join(this.userDataPath, 'sidecar-memory.db'),
          this.runtimePath && path.join(this.runtimePath, 'jenny_memory.db'),
        ].filter((candidate) => candidate && fs.existsSync(candidate)).length,
        workspace: workspaceRoot ? countFiles(path.join(workspaceRoot, '.jenny')) : 0,
      },
      workspace: { available: Boolean(workspaceRoot), name: workspaceRoot ? path.basename(workspaceRoot) : '' },
      freshProfile: isMeaningfullyFresh({ userDataPath: this.userDataPath, sessionStore: this.sessionStore }),
      defaultArchiveRoot: buildDefaultArchiveRoot(this.documentsPath),
      appearance: portablePreferences?.appearance || { paletteId: 'obsidian' },
    });
  }

  async _flushCanonicalStores() {
    if (typeof this.sessionStore?.flushAsync === 'function') await this.sessionStore.flushAsync();
  }

  _collectInventory(options, workspaceRootOverride = '') {
    const workspaceRoot = workspaceRootOverride || this._workspaceRoot();
    return collectDataInventory({
      userDataPath: this.userDataPath,
      runtimePath: this.runtimePath,
      workspaceRoot,
      includeWorkspace: options.includeWorkspace === true && Boolean(workspaceRoot),
      sessionStore: this.sessionStore,
      attachmentStore: this.attachmentStore,
      portablePreferences: this.preferencesStore.read(),
      portableShellConfig: projectPortableShellConfig(this.shellConfigService?.getState?.()),
    });
  }

  _assertArchiveDestinationRetained(destinationRoot, removeWorkspaceData) {
    const archiveRoot = destinationRoot || buildDefaultArchiveRoot(this.documentsPath);
    const cleanupRoots = [this.userDataPath];
    if (this.runtimePath) {
      cleanupRoots.push(...KNOWN_RUNTIME_CHILDREN.map((name) => path.join(this.runtimePath, name)));
    }
    const workspaceRoot = this._workspaceRoot();
    if (removeWorkspaceData && workspaceRoot) cleanupRoots.push(path.join(workspaceRoot, '.jenny'));
    if (cleanupRoots.some((cleanupRoot) => isSameOrWithin(cleanupRoot, archiveRoot))) {
      throw Object.assign(new Error('Archive destination would be removed during cleanup.'), {
        code: DATA_ERROR_CODES.UNSAFE_PATH,
        reason: 'archive_destination_removed_by_cleanup',
      });
    }
  }

  async _createArchive(operation, options = {}) {
    if (options.encrypted !== false && options.passphrase !== options.passphraseConfirmation) {
      throw Object.assign(new Error('Archive passphrases do not match.'), {
        code: DATA_ERROR_CODES.INVALID_REQUEST,
        reason: 'passphrase_mismatch',
      });
    }
    if (options.includeWorkspace === true) await this._ensureWorkspaceRecovery();
    const lease = options.includeWorkspace === true ? this._acquireWorkspaceLease() : null;
    try {
      this._progress(operation, { phase: 'preparing', percent: 0, label: 'Preparing archive inventory' });
      await this._flushCanonicalStores();
      const workspaceRoot = String(lease?.context?.rootPath || this._workspaceRoot());
      const inventory = this._collectInventory(options, workspaceRoot);
      if (options.includeWorkspace === true) {
        const review = this.workspaceArchiveReview;
        this.workspaceArchiveReview = null;
        if (!review || review.id !== String(options.workspaceReviewId || '')
          || review.expiresAt < this.nowProvider()) {
          throw Object.assign(new Error('Workspace archive scope must be reviewed again.'), {
            code: DATA_ERROR_CODES.INVALID_REQUEST,
            reason: 'workspace_review_required',
          });
        }
        const summary = workspaceRoot ? await workspaceInventorySummary(inventory, workspaceRoot) : null;
        if (!summary || review.digest !== summary.digest) {
          throw Object.assign(new Error('Workspace archive scope must be reviewed again.'), {
            code: DATA_ERROR_CODES.INVALID_REQUEST,
            reason: 'workspace_review_required',
          });
        }
        for (const entry of inventory.entries) {
          if (entry.logicalPath.startsWith('workspace/')) entry.expectedSha256 = review.hashes.get(entry.logicalPath) || '';
        }
      }
      const result = await createArchive({
        destinationRoot: options.destinationRoot || buildDefaultArchiveRoot(this.documentsPath),
        entries: inventory.entries,
        encrypted: options.encrypted !== false,
        passphrase: options.encrypted === false ? '' : options.passphrase,
        appVersion: this.appVersion,
        onProgress: (payload) => this._progress(operation, payload),
        shouldCancel: () => operation.cancelRequested && !operation.committed,
        onCommit: () => { operation.committed = true; },
      });
      if (lease && lease.isCurrent?.() !== true) {
        throw Object.assign(new Error('The workspace changed during archive creation.'), {
          code: DATA_ERROR_CODES.RESTORE_CONFLICT,
          reason: 'workspace_identity_changed',
        });
      }
      return this._result(operation.id, 'archive_verified', {
        archivePath: result.archivePath,
        counts: result.counts,
        warnings: result.warnings,
      });
    } finally {
      lease?.release?.();
    }
  }

  createArchive(options = {}) {
    return this._run('archive', (operation) => this._createArchive(operation, options));
  }

  previewWorkspaceArchive() {
    return this._run('archive_preview', async (operation) => {
      await this._ensureWorkspaceRecovery();
      const lease = this._acquireWorkspaceLease();
      try {
        await this._flushCanonicalStores();
        const workspaceRoot = String(lease?.context?.rootPath || this._workspaceRoot());
        if (!workspaceRoot) {
          throw Object.assign(new Error('No safe workspace is available.'), {
            code: DATA_ERROR_CODES.INVALID_REQUEST,
            reason: 'workspace_unavailable',
          });
        }
        const inventory = this._collectInventory({ includeWorkspace: true }, workspaceRoot);
        const summary = await workspaceInventorySummary(inventory, workspaceRoot);
        const reviewId = crypto.randomUUID();
        this.workspaceArchiveReview = {
          id: reviewId,
          digest: summary.digest,
          hashes: summary.hashes,
          expiresAt: this.nowProvider() + REVIEW_TTL_MS,
        };
        operation.committed = true;
        return this._result(operation.id, 'workspace_review_ready', {
          reviewId,
          workspace: summary.workspace,
          scope: summary.scope,
          itemCount: summary.itemCount,
          totalBytes: summary.totalBytes,
        });
      } finally {
        lease?.release?.();
      }
    });
  }

  _acquireWorkspaceLease() {
    if (!this.workspaceRootCoordinator) return null;
    const lease = this.workspaceRootCoordinator.acquireOperation?.({ kind: 'mutation', cancellable: false }) || null;
    if (lease?.acquired !== true) {
      throw Object.assign(new Error('The workspace is changing or unavailable.'), {
        code: DATA_ERROR_CODES.BUSY,
        reason: 'workspace_transitioning',
      });
    }
    return lease;
  }

  _ensureWorkspaceRecovery() {
    const workspaceRoot = this._workspaceRoot();
    if (!workspaceRoot) return Promise.resolve({ ok: true, recoveredCount: 0 });
    if (this.workspaceRecoveryRoot === workspaceRoot && this.workspaceRecoveryPromise) {
      return this.workspaceRecoveryPromise;
    }
    const promise = (async () => {
      const lease = this._acquireWorkspaceLease();
      try {
        const leasedRoot = String(lease?.context?.rootPath || workspaceRoot);
        if (path.resolve(leasedRoot) !== workspaceRoot) {
          throw Object.assign(new Error('The workspace changed during recovery.'), {
            code: DATA_ERROR_CODES.BUSY,
            reason: 'workspace_transitioning',
          });
        }
        return await recoverWorkspaceRestoreStages({ workspaceRoot, logger: this.logger });
      } finally {
        lease?.release?.();
      }
    })();
    this.workspaceRecoveryRoot = workspaceRoot;
    this.workspaceRecoveryPromise = promise;
    const clearSettledRecovery = () => {
      if (this.workspaceRecoveryPromise === promise) this.workspaceRecoveryPromise = null;
    };
    void promise.then(clearSettledRecovery, clearSettledRecovery);
    return promise;
  }

  findRestoreCandidates() {
    return this._result('', 'ready', {
      candidates: findRestoreCandidates(buildDefaultArchiveRoot(this.documentsPath)),
      freshProfile: isMeaningfullyFresh({ userDataPath: this.userDataPath, sessionStore: this.sessionStore }),
    });
  }

  stageRestore(options = {}) {
    return this._run('restore', async (operation) => {
      const result = await stageRestore({
        archivePath: options.archivePath,
        userDataPath: this.userDataPath,
        runtimePath: this.runtimePath,
        sessionStore: this.sessionStore,
        passphrase: options.passphrase || '',
        includeWorkspace: false,
        workspaceRoot: '',
        onProgress: (payload) => this._progress(operation, payload),
      });
      operation.committed = true;
      return this._result(operation.id, result.status, {
        fingerprint: result.fingerprint,
        restartRequired: true,
      });
    });
  }

  previewWorkspaceRestore(options = {}) {
    return this._run('workspace_restore_preview', async (operation) => {
      await this._ensureWorkspaceRecovery();
      const inspection = await inspectWorkspaceRestore({
        archivePath: options.archivePath,
        passphrase: options.passphrase || '',
        workspaceRoot: this._workspaceRoot(),
        onProgress: (payload) => this._progress(operation, payload),
      });
      const reviewId = crypto.randomUUID();
      this.workspaceRestoreReview = {
        id: reviewId,
        digest: inspection.digest,
        archivePath: inspection.archivePath,
        expiresAt: this.nowProvider() + REVIEW_TTL_MS,
      };
      operation.committed = true;
      return this._result(operation.id, 'workspace_restore_review_ready', {
        reviewId,
        workspace: {
          name: path.basename(inspection.identity.realPath).slice(0, 120),
          id: crypto.createHash('sha256').update(inspection.identity.realPath).digest('hex').slice(0, 16),
        },
        scope: '.jenny portable data only',
        itemCount: inspection.itemCount,
        totalBytes: inspection.totalBytes,
        conflictCount: inspection.conflictCount,
        conflicts: inspection.conflicts,
      });
    });
  }

  restoreWorkspace(options = {}) {
    return this._run('workspace_restore', async (operation) => {
      await this._ensureWorkspaceRecovery();
      const review = this.workspaceRestoreReview;
      this.workspaceRestoreReview = null;
      if (!review || review.id !== String(options.reviewId || '')
        || review.archivePath !== path.resolve(options.archivePath)
        || review.expiresAt < this.nowProvider()) {
        throw Object.assign(new Error('Workspace restore must be reviewed again.'), {
          code: DATA_ERROR_CODES.INVALID_REQUEST,
          reason: 'workspace_review_required',
        });
      }
      const lease = this.workspaceRootCoordinator?.acquireOperation?.({
        kind: 'mutation',
        cancellable: false,
      }) || null;
      if (this.workspaceRootCoordinator && lease?.acquired !== true) {
        throw Object.assign(new Error('The workspace is changing or unavailable.'), {
          code: DATA_ERROR_CODES.BUSY,
          reason: 'workspace_transitioning',
        });
      }
      const workspaceRoot = String(lease?.context?.rootPath || this._workspaceRoot());
      try {
        const result = await restoreWorkspace({
          archivePath: options.archivePath,
          userDataPath: this.userDataPath,
          passphrase: options.passphrase || '',
          workspaceRoot,
          expectedDigest: review.digest,
          onProgress: (payload) => this._progress(operation, payload),
          logger: this.logger,
        });
        if (lease && lease.isCurrent?.() !== true) {
          throw Object.assign(new Error('The workspace changed during restore.'), {
            code: DATA_ERROR_CODES.RESTORE_CONFLICT,
            reason: 'workspace_identity_changed',
          });
        }
        operation.committed = true;
        return this._result(operation.id, result.status, {
          restoredCount: result.restoredCount,
        });
      } finally {
        lease?.release?.();
      }
    });
  }

  syncPortablePreferences(preferences) {
    try {
      return this._result('', 'saved', { preferences: this.preferencesStore.sync(preferences) });
    } catch (error) {
      return this._failure('', error);
    }
  }

  prepareRemoval(options = {}) {
    return this._run('removal', async (operation) => {
      const choice = String(options.choice || '');
      if (!Object.values(REMOVAL_CHOICES).includes(choice)) {
        throw Object.assign(new Error('Removal choice is invalid.'), {
          code: DATA_ERROR_CODES.INVALID_REQUEST,
          reason: 'invalid_removal_choice',
        });
      }
      const requestedWorkspaceRemoval = options.removeWorkspaceData === true;
      const removeWorkspaceData = choice === REMOVAL_CHOICES.PERMANENT
        ? requestedWorkspaceRemoval
        : choice === REMOVAL_CHOICES.ARCHIVE_AND_REMOVE
          && options.archive?.includeWorkspace === true
          && requestedWorkspaceRemoval;
      let archiveResult = null;
      if (choice === REMOVAL_CHOICES.ARCHIVE_AND_REMOVE) {
        this._assertArchiveDestinationRetained(options.archive?.destinationRoot, removeWorkspaceData);
        archiveResult = await this._createArchive(operation, options.archive || {});
      }
      if (choice === REMOVAL_CHOICES.PERMANENT && options.confirmation !== 'REMOVE JENNY') {
        throw Object.assign(new Error('Permanent removal confirmation is invalid.'), {
          code: DATA_ERROR_CODES.INVALID_REQUEST,
          reason: 'confirmation_required',
        });
      }
      operation.committed = true;
      this._progress(operation, { phase: 'handoff', percent: 100, label: 'Preparing safe removal' });
      const preparation = await this.prepareForRemoval({
        choice,
        operationId: operation.id,
        removeWorkspaceData,
        workspaceRoot: this._workspaceRoot(),
      });
      const cleanupResults = Array.isArray(preparation?.results)
        ? preparation.results.map((item) => {
            const name = String(item?.name || '').slice(0, 160);
            return {
              kind: String(item?.kind || '').slice(0, 48),
              ...(name ? { name } : {}),
              status: String(item?.status || '').slice(0, 48),
              reason: String(item?.reason || '').slice(0, 64),
            };
          })
        : [];
      const preparationWarnings = Array.isArray(preparation?.warnings)
        ? preparation.warnings.map((warning) => String(warning || '').slice(0, 160)).slice(0, 20)
        : [];
      if (preparation?.ok === false) {
        return {
          ...this._failure(operation.id, {
            code: DATA_ERROR_CODES.CLEANUP_INCOMPLETE,
            reason: 'incomplete_cleanup',
          }),
          cleanupResults,
          warnings: preparationWarnings,
        };
      }
      return this._result(operation.id, 'cleanup_authorized', {
        removalMode: choice,
        archivePath: archiveResult?.archivePath || '',
        removeWorkspaceData,
        cleanupResults,
        warnings: preparationWarnings,
      });
    });
  }

  cancel(operationId) {
    const operation = this.activeOperation;
    if (!operation || operation.id !== String(operationId || '')) {
      return this._failure(String(operationId || ''), {
        code: DATA_ERROR_CODES.INVALID_REQUEST,
        reason: 'operation_not_found',
      });
    }
    if (operation.committed) {
      return this._failure(operation.id, {
        code: DATA_ERROR_CODES.INVALID_REQUEST,
        reason: 'operation_committed',
      });
    }
    operation.cancelRequested = true;
    return this._result(operation.id, 'cancel_requested');
  }
}

module.exports = {
  DataLifecycleService,
  REMOVAL_CHOICES,
};
