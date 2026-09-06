'use strict';

const crypto = require('node:crypto');
const { constants: fsConstants } = require('node:fs');
const fsPromises = require('node:fs/promises');
const nodePath = require('node:path');

const { WORKSPACE_FS_ERROR_CODES, workspaceFsError } = require('./workspace-ide-errors');
const {
  buildPathLogHint,
  existsError,
  normalizeWorkspaceRelPath,
} = require('./workspace-ide-path-guard');
const { cancellationReason } = require('./workspace-ide-enumerator');
const {
  assertImportScanAllowed, normalizeExternalSources, normalizeLimit,
  previewExternalSources, scanExternalSources,
} = require('./workspace-import-scan');
const { WorkspaceRootOperationManager } = require('./workspace-root-operation');

const COPY_ERROR_CODES = Object.freeze({
  FEATURE_DISABLED: 'feature_disabled',
  NAME_EXHAUSTED: 'name_exhausted',
  SYMLINK_SKIPPED: 'symlink_skipped',
  SYMLINK_UNSUPPORTED: 'symlink_unsupported',
  UNSUPPORTED_ENTRY: 'unsupported_entry',
});
const IMPORT_ERROR_CODES = Object.freeze({
  FEATURE_DISABLED: 'feature_disabled',
  IMPORT_IN_PROGRESS: 'import_in_progress',
  IMPORT_TOO_LARGE: 'import_too_large',
  INSIDE_WORKSPACE: 'inside_workspace',
  SENSITIVE_SOURCE: 'sensitive_source',
  SOURCE_CHANGED: 'source_changed',
  UNSUPPORTED_SOURCE: 'unsupported_source',
});
const IMPORT_LIMIT_DEFAULTS = Object.freeze({ largeTreeFiles: 5000, largeTreeBytes: 512 * 1024 * 1024 });
const PROGRESS_INTERVAL_MS = 100, PROGRESS_ITEM_INTERVAL = 64;
const MAX_COPY_NUMBER = 999;
const COLLISION_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM']);
const LINK_FALLBACK_CODES = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EXDEV']);
const FATAL_OPERATION_CODES = new Set([
  WORKSPACE_FS_ERROR_CODES.PATH_OUTSIDE_ROOT,
  WORKSPACE_FS_ERROR_CODES.ROOT_INVALID,
  WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING,
  WORKSPACE_FS_ERROR_CODES.STALE_GENERATION,
  IMPORT_ERROR_CODES.SOURCE_CHANGED,
]);

function joinRel(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

function numberedLeafName(name, kind, number) {
  if (kind === 'directory') return `${name} (${number})`;
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return `${name} (${number})`;
  return `${name.slice(0, lastDot)} (${number})${name.slice(lastDot)}`;
}

function importCancelledError() {
  const error = new Error('Workspace import cancelled.');
  error.code = 'import_cancelled';
  return error;
}

class WorkspaceImportService {
  constructor({
    rootContextProvider = null,
    fs = fsPromises,
    path = nodePath,
    platform = process.platform,
    logger = null,
    isQolEnabled = () => false,
    isImportEnabled = () => false,
    sendProgress = () => {},
    limits = null,
    now = Date.now,
    hooks = null,
  } = {}) {
    this._fs = fs;
    this._path = path;
    this._platform = String(platform || process.platform);
    this._logger = typeof logger === 'function' ? logger : null;
    this._isQolEnabled = typeof isQolEnabled === 'function' ? isQolEnabled : () => false;
    this._isImportEnabled = typeof isImportEnabled === 'function'
      ? isImportEnabled
      : () => false;
    this._sendProgress = typeof sendProgress === 'function' ? sendProgress : () => {};
    this._now = typeof now === 'function' ? now : Date.now;
    this._limits = {
      largeTreeFiles: normalizeLimit(limits?.largeTreeFiles, IMPORT_LIMIT_DEFAULTS.largeTreeFiles),
      largeTreeBytes: normalizeLimit(limits?.largeTreeBytes, IMPORT_LIMIT_DEFAULTS.largeTreeBytes),
    };
    this._activeImports = new Map();
    this._rootOperations = new WorkspaceRootOperationManager({
      rootContextProvider,
      fs,
      path,
      platform,
      hooks,
    });
  }

  _log(level, event, details = {}) {
    if (!this._logger) return;
    try {
      this._logger(level, event, details);
    } catch (_error) {
      /* logging must never break a copy */
    }
  }

  _featureDisabledError() {
    return workspaceFsError(
      COPY_ERROR_CODES.FEATURE_DISABLED,
      'Workspace Explorer copy operations are disabled.'
    );
  }

  _importFeatureDisabledError() {
    return workspaceFsError(
      IMPORT_ERROR_CODES.FEATURE_DISABLED,
      'Workspace external import operations are disabled.'
    );
  }

  _importError(code, message, details = {}) {
    return workspaceFsError(code, message, details);
  }

  _nameExhaustedError(relPath) {
    return workspaceFsError(
      COPY_ERROR_CODES.NAME_EXHAUSTED,
      'No available numbered name remains for this copy.',
      buildPathLogHint(relPath)
    );
  }

  async _withMutation(payload, callback) {
    const operation = this._rootOperations.acquire({
      kind: 'mutation',
      expectedGeneration: payload?.expectedGeneration,
    });
    try {
      await this._rootOperations.prepareRoot(operation);
      this._rootOperations.assertCurrent(operation);
      const result = await callback(operation);
      this._rootOperations.assertCurrent(operation);
      return result;
    } finally {
      operation.release();
    }
  }

  async _withRead(callback) {
    const operation = this._rootOperations.acquire({ kind: 'read' });
    try {
      await this._rootOperations.prepareRoot(operation);
      this._rootOperations.assertCurrent(operation);
      const result = await callback(operation);
      this._rootOperations.assertCurrent(operation);
      return result;
    } finally {
      operation.release();
    }
  }

  _validateCollisionPolicy(value) {
    if (value === 'fail' || value === 'auto-rename') return value;
    throw workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
      'Collision policy must be "fail" or "auto-rename".',
      { reason: 'collision_policy_invalid' }
    );
  }

  _normalizeExternalSources(value) {
    const sources = normalizeExternalSources(this._path, value);
    if (sources.some((source) => !this._path.basename(source))) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
        'External import sources must name a file or folder.',
        { reason: 'source_name_empty' }
      );
    }
    return sources;
  }

  _isDescendant(sourcePath, targetPath) {
    const relative = this._path.relative(sourcePath, targetPath);
    return Boolean(relative)
      && relative !== '..'
      && !relative.startsWith(`..${this._path.sep}`)
      && !this._path.isAbsolute(relative);
  }

  _windowsLeafKey(name) {
    return String(name || '').replace(/[. ]+$/g, '').toLowerCase();
  }

  async _hasWindowsLeafAlias(root, target, operation) {
    if (this._platform !== 'win32') return false;
    await this._rootOperations.revalidateParent(root, target.parent, operation);
    const requestedKey = this._windowsLeafKey(this._path.basename(target.lexicalPath));
    const names = await this._fs.readdir(target.parent.realPath);
    this._rootOperations.assertCurrent(operation);
    return names.some((name) => this._windowsLeafKey(name) === requestedKey);
  }

  _assertDirectoryTargetSafe(root, source, from, to, collisionPolicy) {
    if (from === to && collisionPolicy === 'auto-rename') return;
    const requestedPath = this._path.resolve(root.realPath, ...to.split('/'));
    if (this._isDescendant(source.realPath, requestedPath)) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
        'A folder cannot be copied inside itself.',
        { ...buildPathLogHint(to), reason: 'destination_inside_source' }
      );
    }
  }

  async _resolveNumberedTarget(root, requestedRel, kind, operation, startNumber = 2) {
    const parentRel = requestedRel.includes('/')
      ? requestedRel.slice(0, requestedRel.lastIndexOf('/'))
      : '';
    const requestedName = requestedRel.split('/').pop();
    for (let number = Math.max(2, startNumber); number <= MAX_COPY_NUMBER; number += 1) {
      const relPath = joinRel(parentRel, numberedLeafName(requestedName, kind, number));
      const target = await this._rootOperations.resolveLeaf(root, relPath, operation, {
        allowMissing: true,
        preserveLeaf: true,
      });
      if (!target.stats && !await this._hasWindowsLeafAlias(root, target, operation)) {
        return { relPath, target, number };
      }
    }
    throw this._nameExhaustedError(requestedRel);
  }

  async _resolveTarget(root, requestedRel, kind, collisionPolicy, operation) {
    const target = await this._rootOperations.resolveLeaf(root, requestedRel, operation, {
      createParents: true,
      allowMissing: true,
      preserveLeaf: true,
    });
    if (!target.stats && !await this._hasWindowsLeafAlias(root, target, operation)) {
      return { relPath: requestedRel, target, number: 1 };
    }
    if (collisionPolicy === 'fail') throw existsError(requestedRel);
    return this._resolveNumberedTarget(root, requestedRel, kind, operation);
  }

  async _nextTarget(root, requestedRel, kind, collisionPolicy, operation, candidate) {
    if (collisionPolicy === 'fail') throw existsError(candidate.relPath);
    return this._resolveNumberedTarget(
      root,
      requestedRel,
      kind,
      operation,
      candidate.number + 1
    );
  }

  async _fsyncFile(targetPath) {
    const handle = await this._fs.open(targetPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async _landTempFile(tempPath, targetPath) {
    try {
      await this._fs.link(tempPath, targetPath);
    } catch (error) {
      if (!LINK_FALLBACK_CODES.has(error?.code)) throw error;
      // Volumes without hard links retain rename's narrow replacement race.
      await this._fs.rename(tempPath, targetPath);
      return;
    }
    await this._fs.rm(tempPath, { force: true });
  }

  async _copyFile(
    sourcePath,
    root,
    requestedRel,
    collisionPolicy,
    operation,
    candidate,
    checkCancellation = null
  ) {
    const tempPath = this._path.join(
      candidate.target.parent.realPath,
      `.${this._path.basename(candidate.target.lexicalPath).slice(0, 180)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
    );
    try {
      checkCancellation?.();
      await this._fs.copyFile(sourcePath, tempPath, fsConstants.COPYFILE_EXCL);
      checkCancellation?.();
      this._rootOperations.assertCurrent(operation);
      await this._fsyncFile(tempPath);
      checkCancellation?.();
      this._rootOperations.assertCurrent(operation);

      while (true) {
        checkCancellation?.();
        await this._rootOperations.revalidateParent(root, candidate.target.parent, operation);
        const current = await this._rootOperations.revalidateLeaf(root, candidate.target, operation);
        if (current.exists || await this._hasWindowsLeafAlias(root, candidate.target, operation)) {
          candidate = await this._nextTarget(
            root, requestedRel, 'file', collisionPolicy, operation, candidate
          );
          continue;
        }
        try {
          await this._landTempFile(tempPath, candidate.target.operationPath);
          this._rootOperations.assertCurrent(operation);
          break;
        } catch (error) {
          if (!COLLISION_CODES.has(error?.code)) throw error;
          candidate = await this._nextTarget(
            root, requestedRel, 'file', collisionPolicy, operation, candidate
          );
        }
      }
    } catch (error) {
      await this._fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    await this._rootOperations.revalidateRoot(root, operation);
    await this._rootOperations.revalidateParent(root, candidate.target.parent, operation);
    await this._fs.stat(candidate.target.operationPath);
    this._rootOperations.assertCurrent(operation);
    return candidate;
  }

  async _createDirectory(root, requestedRel, collisionPolicy, operation, candidate) {
    while (true) {
      await this._rootOperations.revalidateParent(root, candidate.target.parent, operation);
      const current = await this._rootOperations.revalidateLeaf(root, candidate.target, operation);
      if (current.exists || await this._hasWindowsLeafAlias(root, candidate.target, operation)) {
        candidate = await this._nextTarget(
          root, requestedRel, 'directory', collisionPolicy, operation, candidate
        );
        continue;
      }
      try {
        await this._fs.mkdir(candidate.target.operationPath);
        this._rootOperations.assertCurrent(operation);
        break;
      } catch (error) {
        if (!COLLISION_CODES.has(error?.code)) throw error;
        candidate = await this._nextTarget(
          root, requestedRel, 'directory', collisionPolicy, operation, candidate
        );
      }
    }
    await this._rootOperations.revalidateRoot(root, operation);
    await this._rootOperations.revalidateParent(root, candidate.target.parent, operation);
    return candidate;
  }

  _skip(skipped, relPath, code) {
    const entry = { path: relPath, code: String(code || 'copy_failed') };
    skipped.push(entry);
    this._log('WARN', 'workspace_fs.copy_entry_skipped', {
      ...buildPathLogHint(relPath),
      code: entry.code,
    });
  }

  _isFatalOperationError(error) {
    return FATAL_OPERATION_CODES.has(error?.code);
  }

  async _createChildDirectory(root, relPath, operation) {
    const target = await this._rootOperations.resolveLeaf(root, relPath, operation, {
      allowMissing: true,
      preserveLeaf: true,
    });
    if (target.stats || await this._hasWindowsLeafAlias(root, target, operation)) {
      throw existsError(relPath);
    }
    await this._rootOperations.revalidateParent(root, target.parent, operation);
    const current = await this._rootOperations.revalidateLeaf(root, target, operation);
    if (current.exists || await this._hasWindowsLeafAlias(root, target, operation)) {
      throw existsError(relPath);
    }
    try {
      await this._fs.mkdir(target.operationPath);
    } catch (error) {
      if (COLLISION_CODES.has(error?.code)) throw existsError(relPath);
      throw error;
    }
    this._rootOperations.assertCurrent(operation);
    await this._rootOperations.revalidateParent(root, target.parent, operation);
  }

  async _copyDirectoryContents({ sourcePath, sourceRel, targetRel, root, operation, skipped }) {
    this._rootOperations.assertCurrent(operation);
    const names = await this._fs.readdir(sourcePath);
    this._rootOperations.assertCurrent(operation);
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const childSourcePath = this._path.join(sourcePath, name);
      const childSourceRel = joinRel(sourceRel, name);
      const childTargetRel = joinRel(targetRel, name);
      try {
        const stats = await this._fs.lstat(childSourcePath);
        this._rootOperations.assertCurrent(operation);
        if (stats.isSymbolicLink()) {
          this._skip(skipped, childSourceRel, COPY_ERROR_CODES.SYMLINK_SKIPPED);
          continue;
        }
        if (stats.isDirectory()) {
          await this._createChildDirectory(root, childTargetRel, operation);
          await this._copyDirectoryContents({
            sourcePath: childSourcePath,
            sourceRel: childSourceRel,
            targetRel: childTargetRel,
            root,
            operation,
            skipped,
          });
          continue;
        }
        if (!stats.isFile()) {
          this._skip(skipped, childSourceRel, COPY_ERROR_CODES.UNSUPPORTED_ENTRY);
          continue;
        }
        const candidate = await this._resolveTarget(
          root, childTargetRel, 'file', 'fail', operation
        );
        await this._copyFile(
          childSourcePath, root, childTargetRel, 'fail', operation, candidate
        );
      } catch (error) {
        if (this._isFatalOperationError(error)) throw error;
        this._skip(skipped, childSourceRel, error?.code);
      }
    }
  }

  _validateImportId(value) {
    if (typeof value !== 'string' || !value.trim()) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
        'External imports require a caller-minted importId.'
      );
    }
    return value.trim();
  }

  _validateDestination(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
        'Import destination must be a workspace-relative directory.'
      );
    }
    const trimmed = value.trim();
    return trimmed ? normalizeWorkspaceRelPath(trimmed) : '';
  }

  _checkImportBoundary(controller, operation) {
    const reason = cancellationReason({
      signal: controller.signal,
      assertCurrent: () => this._rootOperations.assertCurrent(operation),
    });
    if (reason) throw importCancelledError();
  }

  _createProgressState(importId) {
    return {
      importId,
      completedFiles: 0,
      completedDirectories: 0,
      completedBytes: 0,
      totalFiles: 0,
      totalDirectories: 0,
      totalBytes: 0,
      processedItems: 0,
      totalItems: 0,
      maxCopiedFiles: Number.POSITIVE_INFINITY,
      lastPhase: '',
      lastSentAt: Number.NEGATIVE_INFINITY,
      lastSentItems: 0,
    };
  }

  _progressPercent(progress, phase) {
    if (phase === 'done') return 100;
    if (phase === 'scanning') return 0;
    if (progress.totalBytes > 0) {
      return Math.min(100, Math.floor((progress.completedBytes / progress.totalBytes) * 100));
    }
    if (progress.totalFiles > 0) {
      return Math.min(100, Math.floor((progress.completedFiles / progress.totalFiles) * 100));
    }
    if (progress.totalItems > 0) {
      return Math.min(100, Math.floor((progress.processedItems / progress.totalItems) * 100));
    }
    return 0;
  }

  _emitImportProgress(progress, phase, {
    currentName = '',
    force = false,
    terminal = false,
  } = {}) {
    const now = this._now();
    const phaseChanged = progress.lastPhase !== phase;
    const enoughTime = now - progress.lastSentAt >= PROGRESS_INTERVAL_MS;
    const enoughItems = progress.processedItems - progress.lastSentItems >= PROGRESS_ITEM_INTERVAL;
    if (!force && !terminal && !phaseChanged && !enoughTime && !enoughItems) return;
    const payload = {
      import_id: progress.importId,
      phase,
      completed_files: progress.completedFiles,
      total_files: progress.totalFiles,
      completed_bytes: progress.completedBytes,
      total_bytes: progress.totalBytes,
      current_name: currentName ? this._path.basename(String(currentName)) : '',
      percent: this._progressPercent(progress, phase),
      terminal: terminal === true,
    };
    progress.lastPhase = phase;
    progress.lastSentAt = now;
    progress.lastSentItems = progress.processedItems;
    try {
      const pending = this._sendProgress(payload);
      Promise.resolve(pending).catch(() => {
        this._log('WARN', 'workspace_fs.import_progress_failed', {
          import_id: progress.importId,
          phase,
        });
      });
    } catch (_error) {
      this._log('WARN', 'workspace_fs.import_progress_failed', {
        import_id: progress.importId,
        phase,
      });
    }
  }

  async previewImport(payload = {}) {
    if (!this._isImportEnabled()) throw this._importFeatureDisabledError();
    const sources = this._normalizeExternalSources(payload?.sources);
    return this._withRead(async (operation) => {
      return previewExternalSources({
        fs: this._fs,
        path: this._path,
        platform: this._platform,
        now: this._now,
        payload: payload || {},
        sources,
        root: operation.root,
        largeTreeFiles: this._limits.largeTreeFiles,
        largeTreeBytes: this._limits.largeTreeBytes,
        isFatalError: (error) => this._isFatalOperationError(error),
        checkBoundary: () => {
          cancellationReason({
            signal: operation.signal,
            assertCurrent: () => this._rootOperations.assertCurrent(operation),
          });
        },
      });
    });
  }

  _externalSkip(skipped, source, code, message) {
    const entry = {
      source,
      code: String(code || 'import_failed'),
      message: String(message || 'This item could not be imported.').slice(0, 200),
    };
    skipped.push(entry);
    this._log('WARN', 'workspace_fs.import_entry_skipped', {
      ...buildPathLogHint(this._path.basename(source)),
      code: entry.code,
    });
  }

  _recordCopiedFile(progress, sourcePath, bytes) {
    progress.completedFiles += 1;
    if (progress.completedFiles > progress.maxCopiedFiles) {
      throw this._importError(
        IMPORT_ERROR_CODES.SOURCE_CHANGED,
        'The import source changed after it was scanned.'
      );
    }
    progress.completedBytes += Number(bytes) || 0;
    progress.processedItems += 1;
    this._emitImportProgress(progress, 'copying', { currentName: sourcePath });
  }

  _recordCopiedDirectory(progress, sourcePath) {
    progress.completedDirectories += 1;
    progress.processedItems += 1;
    this._emitImportProgress(progress, 'copying', { currentName: sourcePath });
  }

  async _copyExternalDirectoryContents({
    sourcePath,
    targetRel,
    root,
    operation,
    skipped,
    progress,
    checkBoundary,
  }) {
    checkBoundary();
    let names;
    try {
      let stats = await this._fs.lstat(sourcePath);
      checkBoundary();
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('source_changed');
      names = await this._fs.readdir(sourcePath);
      checkBoundary();
      stats = await this._fs.lstat(sourcePath);
      checkBoundary();
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('source_changed');
    } catch (error) {
      if (error?.code === 'import_cancelled' || this._isFatalOperationError(error)) throw error;
      this._externalSkip(
        skipped, sourcePath, IMPORT_ERROR_CODES.SOURCE_CHANGED,
        'This source changed after it was scanned.'
      );
      return;
    }
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      checkBoundary();
      const childSourcePath = this._path.join(sourcePath, name);
      const childTargetRel = joinRel(targetRel, name);
      try {
        const stats = await this._fs.lstat(childSourcePath);
        checkBoundary();
        if (stats.isSymbolicLink()) {
          this._externalSkip(
            skipped,
            childSourcePath,
            COPY_ERROR_CODES.SYMLINK_SKIPPED,
            'Symbolic links are skipped during import.'
          );
          progress.processedItems += 1;
          continue;
        }
        if (stats.isDirectory()) {
          await this._createChildDirectory(root, childTargetRel, operation);
          this._recordCopiedDirectory(progress, childSourcePath);
          await this._copyExternalDirectoryContents({
            sourcePath: childSourcePath,
            targetRel: childTargetRel,
            root,
            operation,
            skipped,
            progress,
            checkBoundary,
          });
          continue;
        }
        if (!stats.isFile()) {
          this._externalSkip(
            skipped,
            childSourcePath,
            COPY_ERROR_CODES.UNSUPPORTED_ENTRY,
            'Only regular files and folders can be imported.'
          );
          progress.processedItems += 1;
          continue;
        }
        const candidate = await this._resolveTarget(
          root,
          childTargetRel,
          'file',
          'fail',
          operation
        );
        await this._copyFile(
          childSourcePath,
          root,
          childTargetRel,
          'fail',
          operation,
          candidate,
          checkBoundary
        );
        this._recordCopiedFile(progress, childSourcePath, stats.size);
      } catch (error) {
        if (error?.code === 'import_cancelled' || this._isFatalOperationError(error)) throw error;
        this._externalSkip(
          skipped,
          childSourcePath,
          error?.code,
          'This item could not be imported.'
        );
      }
    }
  }

  _importResult(importId, cancelled, imported, skipped, progress) {
    return {
      ok: true,
      importId,
      cancelled,
      imported,
      skipped,
      totals: {
        files: progress.completedFiles,
        directories: progress.completedDirectories,
        bytes: progress.completedBytes,
      },
    };
  }

  async _runExternalImport({
    payload,
    importId,
    sources,
    destination,
    collisionPolicy,
    controller,
    progress,
  }) {
    const imported = [];
    const skipped = [];
    return this._withMutation(payload, async (operation) => {
      const checkBoundary = () => this._checkImportBoundary(controller, operation);
      try {
        this._emitImportProgress(progress, 'scanning', { force: true });
        const scan = await scanExternalSources({
          fs: this._fs,
          path: this._path,
          platform: this._platform,
          now: this._now,
          sources,
          root: operation.root,
          largeTreeFiles: this._limits.largeTreeFiles,
          largeTreeBytes: this._limits.largeTreeBytes,
          checkBoundary,
          isFatalError: (error) => this._isFatalOperationError(error),
          onEntry: ({ kind, name, stats }) => {
            if (kind === 'file') {
              progress.completedFiles += 1;
              progress.completedBytes += Number(stats.size) || 0;
            }
            progress.processedItems += 1;
            this._emitImportProgress(progress, 'scanning', { currentName: name });
          },
        });
        assertImportScanAllowed({
          scan,
          path: this._path,
          rootPath: operation.root.realPath,
          allowLargeTree: payload.allowLargeTree === true,
          allowSensitive: payload.allowSensitive === true,
          largeTreeFiles: this._limits.largeTreeFiles,
          largeTreeBytes: this._limits.largeTreeBytes,
          errorCodes: IMPORT_ERROR_CODES,
        });
        progress.totalFiles = scan.totals.files;
        progress.totalDirectories = scan.totals.directories;
        progress.totalBytes = scan.totals.bytes;
        progress.totalItems = scan.entries;
        progress.maxCopiedFiles = scan.totals.files + 256;
        progress.completedFiles = 0;
        progress.completedDirectories = 0;
        progress.completedBytes = 0;
        progress.processedItems = 0;
        this._emitImportProgress(progress, 'copying', { force: true });

        for (const source of scan.inspected) {
          checkBoundary();
          if (source.kind === 'error') {
            this._externalSkip(
              skipped,
              source.source,
              source.error?.code,
              'This source could not be inspected.'
            );
            continue;
          }
          if (source.kind === 'symlink') {
            this._externalSkip(
              skipped,
              source.source,
              COPY_ERROR_CODES.SYMLINK_SKIPPED,
              'Symbolic links are skipped during import.'
            );
            progress.processedItems += 1;
            continue;
          }
          try {
            const currentStats = await this._fs.lstat(source.source);
            checkBoundary();
            const stillSameKind = source.kind === 'file'
              ? currentStats.isFile() && !currentStats.isSymbolicLink()
              : source.kind === 'directory'
                ? currentStats.isDirectory() && !currentStats.isSymbolicLink()
                : false;
            if (!stillSameKind) {
              this._externalSkip(
                skipped,
                source.source,
                'source_changed',
                'This source changed after it was scanned.'
              );
              continue;
            }
            const requestedRel = normalizeWorkspaceRelPath(joinRel(destination, source.name), { strictName: true, relocationFrom: source.name });
            let candidate = await this._resolveTarget(
              operation.root,
              requestedRel,
              source.kind,
              collisionPolicy,
              operation
            );
            if (source.kind === 'file') {
              candidate = await this._copyFile(
                source.source,
                operation.root,
                requestedRel,
                collisionPolicy,
                operation,
                candidate,
                checkBoundary
              );
              this._recordCopiedFile(progress, source.source, currentStats.size);
            } else {
              candidate = await this._createDirectory(
                operation.root,
                requestedRel,
                collisionPolicy,
                operation,
                candidate
              );
              this._recordCopiedDirectory(progress, source.source);
            }
            imported.push({
              source: source.source,
              path: candidate.relPath,
              kind: source.kind,
              ...(candidate.relPath !== requestedRel ? { renamedFrom: source.name } : {}),
            });
            if (source.kind === 'directory') {
              await this._copyExternalDirectoryContents({
                sourcePath: source.source,
                targetRel: candidate.relPath,
                root: operation.root,
                operation,
                skipped,
                progress,
                checkBoundary,
              });
            }
          } catch (error) {
            if (error?.code === 'import_cancelled' || this._isFatalOperationError(error)) throw error;
            this._externalSkip(
              skipped,
              source.source,
              error?.code,
              'This source could not be imported.'
            );
          }
        }
        checkBoundary();
        return this._importResult(importId, false, imported, skipped, progress);
      } catch (error) {
        if (error?.code !== 'import_cancelled') throw error;
        if (progress.lastPhase === 'scanning') Object.assign(progress, {
          completedFiles: 0, completedDirectories: 0, completedBytes: 0 });
        return this._importResult(importId, true, imported, skipped, progress);
      }
    });
  }

  async importExternal(payload = {}) {
    if (!this._isImportEnabled()) throw this._importFeatureDisabledError();
    const importId = this._validateImportId(payload?.importId);
    const sources = this._normalizeExternalSources(payload?.sources);
    const destination = this._validateDestination(payload?.destination);
    const collisionPolicy = this._validateCollisionPolicy(payload?.onCollision ?? 'auto-rename');
    if (this._activeImports.has(importId)) {
      throw this._importError(
        IMPORT_ERROR_CODES.IMPORT_IN_PROGRESS,
        'An import with this importId is already running.'
      );
    }
    const controller = new AbortController();
    const progress = this._createProgressState(importId);
    this._activeImports.set(importId, controller);
    try {
      const result = await this._runExternalImport({
        payload,
        importId,
        sources,
        destination,
        collisionPolicy,
        controller,
        progress,
      });
      const phase = result.cancelled ? 'cancelled' : 'done';
      this._emitImportProgress(progress, phase, { force: true, terminal: true });
      return result;
    } catch (error) {
      this._emitImportProgress(progress, 'failed', { force: true, terminal: true });
      throw error;
    } finally {
      this._activeImports.delete(importId);
    }
  }

  async cancelImport(payload = {}) {
    if (!this._isImportEnabled()) throw this._importFeatureDisabledError();
    const importId = this._validateImportId(payload?.importId);
    const controller = this._activeImports.get(importId);
    if (!controller) return { ok: true, cancelled: false };
    controller.abort();
    return { ok: true, cancelled: true };
  }

  async copyEntry(payload = {}) {
    if (!this._isQolEnabled()) throw this._featureDisabledError();
    const from = normalizeWorkspaceRelPath(payload.from);
    const to = normalizeWorkspaceRelPath(payload.to, { strictName: true, relocationFrom: from });
    const collisionPolicy = this._validateCollisionPolicy(payload.onCollision ?? 'fail');
    if (from === to && collisionPolicy !== 'auto-rename') throw existsError(to);

    return this._withMutation(payload, async (operation) => {
      const root = operation.root;
      const source = await this._rootOperations.resolveLeaf(root, from, operation, {
        preserveLeaf: true,
      });
      if (source.stats.isSymbolicLink()) {
        throw workspaceFsError(
          COPY_ERROR_CODES.SYMLINK_UNSUPPORTED,
          'Symbolic links cannot be copied directly.',
          buildPathLogHint(from)
        );
      }
      const kind = source.stats.isDirectory() ? 'directory' : 'file';
      if (kind === 'file' && !source.stats.isFile()) {
        throw workspaceFsError(
          COPY_ERROR_CODES.UNSUPPORTED_ENTRY,
          'Only files and folders can be copied.',
          buildPathLogHint(from)
        );
      }
      if (kind === 'directory') {
        this._assertDirectoryTargetSafe(root, source, from, to, collisionPolicy);
      }

      let candidate = await this._resolveTarget(root, to, kind, collisionPolicy, operation);
      await this._rootOperations.runHook('beforeLeafMutation', {
        kind: 'copyEntry', operation, root, source, target: candidate.target,
      }, operation);
      const skipped = [];
      if (kind === 'file') {
        candidate = await this._copyFile(
          source.operationPath, root, to, collisionPolicy, operation, candidate
        );
      } else {
        candidate = await this._createDirectory(
          root, to, collisionPolicy, operation, candidate
        );
        await this._copyDirectoryContents({
          sourcePath: source.operationPath,
          sourceRel: from,
          targetRel: candidate.relPath,
          root,
          operation,
          skipped,
        });
      }
      this._log('INFO', 'workspace_fs.copy_entry', {
        from: buildPathLogHint(from),
        to: buildPathLogHint(candidate.relPath),
        kind,
        renamed: candidate.relPath !== to,
        skipped_count: skipped.length,
      });
      return {
        from,
        to: candidate.relPath,
        kind,
        renamed: candidate.relPath !== to,
        skipped,
      };
    });
  }
}

module.exports = {
  COPY_ERROR_CODES, IMPORT_ERROR_CODES,
  WorkspaceImportService,
};
