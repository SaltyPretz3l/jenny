'use strict';
/*
 * Generation-pinned, optimistic-concurrency text-file access for the main
 * process. This service is deliberately standalone: the root coordinator is
 * injected and no renderer, preload, IPC, or sidecar module is imported.
 */
const crypto = require('node:crypto');
const fsPromises = require('node:fs/promises');
const nodePath = require('node:path');

const { WORKSPACE_FS_ERROR_CODES, workspaceFsError } = require('./workspace-ide-errors');
const {
  DEFAULT_MAX_IMAGE_BYTES,
  StableFileReadError,
  buildImageMetadata,
  createFileVersion,
  getMatchingImageDescriptor, hasUnpairedSurrogate, imageBytesMatchDescriptor,
  readStableFileBytes,
  sameFileIdentity, sameReadSnapshot,
} = require('./versioned-workspace-file-bytes');
const { UTF8_BOM, decodeWorkspaceText } = require('./versioned-workspace-file-encoding');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_PENDING_WRITES = 256;
const TEMP_CREATE_ATTEMPTS = 8;
const PARENT_SYNC_UNSUPPORTED = new Set(['EINVAL', 'EISDIR', 'ENOSYS', 'ENOTSUP']);
const WINDOWS_PARENT_SYNC_UNSUPPORTED = new Set(['EACCES', 'EBADF', 'EPERM']);

const VERSIONED_WORKSPACE_FILE_ERROR_CODES = Object.freeze({
  ROOT_TRANSITIONING: WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING,
  ROOT_MISSING: WORKSPACE_FS_ERROR_CODES.ROOT_MISSING,
  STALE_GENERATION: WORKSPACE_FS_ERROR_CODES.STALE_GENERATION,
  PATH_INVALID: WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
  PATH_OUTSIDE_ROOT: WORKSPACE_FS_ERROR_CODES.PATH_OUTSIDE_ROOT,
  NOT_FOUND: WORKSPACE_FS_ERROR_CODES.NOT_FOUND,
  NOT_A_FILE: WORKSPACE_FS_ERROR_CODES.NOT_A_FILE,
  INVALID_UTF8: WORKSPACE_FS_ERROR_CODES.UNSUPPORTED_ENCODING,
  IMAGE_TOO_LARGE: WORKSPACE_FS_ERROR_CODES.IMAGE_TOO_LARGE,
  IMAGE_UNSUPPORTED: WORKSPACE_FS_ERROR_CODES.IMAGE_UNSUPPORTED,
  TOO_LARGE: WORKSPACE_FS_ERROR_CODES.TOO_LARGE,
  WRITE_CONFLICT: WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT,
  ATOMIC_WRITE_FAILED: WORKSPACE_FS_ERROR_CODES.ATOMIC_WRITE_FAILED,
  IO_FAILED: WORKSPACE_FS_ERROR_CODES.IO_FAILED,
  WRITE_QUEUE_FULL: WORKSPACE_FS_ERROR_CODES.WRITE_QUEUE_FULL,
  CONTENT_INVALID: WORKSPACE_FS_ERROR_CODES.UNSUPPORTED_ENCODING,
});

function buildPathHint(relPath) {
  const normalized = String(relPath || '');
  return {
    file_name: normalized.split('/').pop() || '',
    path_hash: crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12),
  };
}

class VersionedWorkspaceFileService {
  constructor({
    rootContext,
    fs = fsPromises,
    path = nodePath,
    platform = process.platform,
    logger = null,
    hooks = null,
    writeObserver = null,
    maxReadBytes = DEFAULT_MAX_BYTES,
    maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
    maxWriteBytes = DEFAULT_MAX_BYTES,
    maxPendingWrites = DEFAULT_MAX_PENDING_WRITES,
  } = {}) {
    if (!rootContext
      || typeof rootContext.captureContext !== 'function'
      || typeof rootContext.acquireOperation !== 'function'
      || typeof rootContext.isCurrent !== 'function') {
      throw new TypeError('VersionedWorkspaceFileService requires a root-context coordinator');
    }
    this._rootContext = rootContext;
    this._fs = fs;
    this._path = path;
    this._platform = String(platform || process.platform);
    this._logger = typeof logger === 'function' ? logger : null;
    this._hooks = hooks && typeof hooks === 'object' ? hooks : {};
    this._writeObserver = writeObserver && typeof writeObserver === 'object' ? writeObserver : null;
    this._maxReadBytes = this._positiveInteger(maxReadBytes, 'maxReadBytes');
    this._maxImageBytes = this._positiveInteger(maxImageBytes, 'maxImageBytes');
    this._maxWriteBytes = this._positiveInteger(maxWriteBytes, 'maxWriteBytes');
    this._maxPendingWrites = this._positiveInteger(maxPendingWrites, 'maxPendingWrites');
    this._pathWriteTails = new Map();
    this._pendingWrites = 0;
  }

  _positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
    return value;
  }

  _log(level, event, details = {}) {
    if (!this._logger) return;
    try {
      this._logger(level, event, details);
    } catch (_error) {
      /* diagnostics never break file integrity */
    }
  }

  _structured(error) {
    return Boolean(error && (
      String(error.error_code || '').startsWith('CMP-')
      || String(error.code || '').startsWith('CMP-')
    ));
  }

  _ioError(operation, relPath, error, code = VERSIONED_WORKSPACE_FILE_ERROR_CODES.IO_FAILED) {
    return workspaceFsError(
      code,
      code === VERSIONED_WORKSPACE_FILE_ERROR_CODES.ATOMIC_WRITE_FAILED
        ? 'The file could not be replaced atomically; the original was left intact.'
        : 'The workspace file operation failed safely.',
      {
        ...buildPathHint(relPath),
        operation,
        os_code: String(error?.code || ''),
      }
    );
  }

  _rootError(reason = 'root_transitioning') {
    return workspaceFsError(
      VERSIONED_WORKSPACE_FILE_ERROR_CODES.ROOT_TRANSITIONING,
      'The workspace root is changing; retry after the transition completes.',
      { reason: String(reason || 'root_transitioning') }
    );
  }

  _captureContext(expectedGeneration = null) {
    let context;
    try {
      context = this._rootContext.captureContext();
    } catch (_error) {
      throw this._rootError('context_unavailable');
    }
    if (context?.phase !== 'ready') throw this._rootError('root_transitioning');
    if (context?.rootId === null && !String(context.rootPath || '')) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.ROOT_MISSING,
        'No workspace root is configured; choose a workspace folder first.'
      );
    }
    if (!context
      || !this._path.isAbsolute(String(context.rootPath || ''))
      || !String(context.rootId || '')
      || !Number.isSafeInteger(context.generation)) {
      throw this._rootError('context_invalid');
    }
    if (expectedGeneration !== null && context.generation !== expectedGeneration) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.STALE_GENERATION,
        'The editor belongs to an older workspace generation; reload the file before saving.',
        { expected_generation: expectedGeneration, current_generation: context.generation }
      );
    }
    return context;
  }

  _sameContext(left, right) {
    return Boolean(left && right
      && left.rootId === right.rootId
      && left.generation === right.generation
      && left.phase === 'ready'
      && right.phase === 'ready');
  }

  async _acquireLease(kind, capturedContext) {
    let lease;
    try {
      lease = await this._rootContext.acquireOperation({
        kind,
        cancellable: kind === 'read',
      });
    } catch (_error) {
      throw this._rootError('lease_unavailable');
    }
    if (!lease || lease.acquired !== true) {
      throw this._rootError(lease?.code || 'root_transitioning');
    }
    if (typeof lease.release !== 'function'
      || typeof lease.isCurrent !== 'function'
      || !this._sameContext(capturedContext, lease.context)) {
      try { lease.release?.(); } catch (_error) { /* best effort */ }
      throw this._rootError('lease_invalid');
    }
    try {
      this._assertCurrent(lease);
    } catch (error) {
      try { lease.release(); } catch (_error) { /* best effort */ }
      throw error;
    }
    return lease;
  }

  _assertCurrent(lease) {
    let current;
    try {
      current = lease?.acquired === true
        && lease.signal?.aborted !== true
        && lease.isCurrent() === true;
    } catch (_error) {
      current = false;
    }
    if (!current) throw this._rootError(lease?.signal?.aborted ? 'operation_cancelled' : 'root_changed');
  }

  async _step(lease, operation) {
    this._assertCurrent(lease);
    const result = await operation();
    this._assertCurrent(lease);
    return result;
  }

  async _openCancellableHandle(lease, operation) {
    this._assertCurrent(lease);
    const handle = await operation();
    try {
      this._assertCurrent(lease);
      return handle;
    } catch (error) {
      try {
        await handle.close();
      } catch (closeError) {
        this._log('WARN', 'workspace_file.cancelled_handle_close_failed', {
          os_code: String(closeError?.code || ''),
        });
      }
      throw error;
    }
  }

  async _runHook(name, payload, lease) {
    const hook = this._hooks[name];
    if (typeof hook !== 'function') return;
    this._assertCurrent(lease);
    await hook(payload);
    this._assertCurrent(lease);
  }

  _normalizeRelPath(value) {
    if (typeof value !== 'string') {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_INVALID,
        'Path must be a workspace-relative string.'
      );
    }
    const raw = value.trim().replace(/\\/g, '/');
    if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.startsWith('//')) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_INVALID,
        'Path must be a workspace-relative path.'
      );
    }
    const segments = raw.split('/').filter((segment) => segment && segment !== '.');
    if (!segments.length || segments.some((segment) => segment === '..')) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_INVALID,
        'Path must stay inside the workspace.'
      );
    }
    return segments.join('/');
  }

  _pathComparable(value) {
    const resolved = this._path.resolve(value);
    return this._platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  _samePath(left, right) {
    return this._pathComparable(left) === this._pathComparable(right);
  }

  _isInside(rootPath, targetPath) {
    const relative = this._path.relative(rootPath, targetPath);
    if (!relative) return true;
    return !relative.startsWith(`..${this._path.sep}`)
      && relative !== '..'
      && !this._path.isAbsolute(relative);
  }

  _displayPath(rootPath, targetPath) {
    const relative = this._path.relative(rootPath, targetPath).replace(/\\/g, '/');
    if (!relative || relative === '..' || relative.startsWith('../')) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_OUTSIDE_ROOT,
        'Path resolves outside the workspace root.'
      );
    }
    return relative;
  }

  _pathKey(displayPath) {
    return this._platform === 'win32' ? displayPath.toLowerCase() : displayPath;
  }

  async _prepareRoot(lease) {
    const configuredPath = String(lease.context.rootPath);
    let realPath;
    let stats;
    try {
      realPath = await this._step(lease, () => this._fs.realpath(configuredPath));
      stats = await this._step(lease, () => this._fs.stat(realPath));
    } catch (error) {
      if (this._structured(error)) throw error;
      throw this._rootError('root_unavailable');
    }
    if (!stats.isDirectory()) throw this._rootError('root_not_directory');
    return { configuredPath, realPath, stats };
  }

  async _revalidateRoot(root, lease) {
    let currentRealPath;
    let currentStats;
    try {
      currentRealPath = await this._step(lease, () => this._fs.realpath(root.configuredPath));
      currentStats = await this._step(lease, () => this._fs.stat(currentRealPath));
    } catch (error) {
      if (this._structured(error)) throw error;
      throw this._rootError('root_unavailable');
    }
    if (!this._samePath(currentRealPath, root.realPath)
      || !currentStats.isDirectory()
      || !sameFileIdentity(root.stats, currentStats)) {
      throw this._rootError('root_identity_changed');
    }
  }

  async _resolveTarget(root, relPath, lease) {
    const candidatePath = this._path.resolve(root.configuredPath, ...relPath.split('/'));
    if (!this._isInside(root.configuredPath, candidatePath)) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_OUTSIDE_ROOT,
        'Path resolves outside the workspace root.',
        buildPathHint(relPath)
      );
    }
    let realPath;
    try {
      realPath = await this._step(lease, () => this._fs.realpath(candidatePath));
    } catch (error) {
      if (this._structured(error)) throw error;
      if (error?.code === 'ENOENT') {
        throw workspaceFsError(
          VERSIONED_WORKSPACE_FILE_ERROR_CODES.NOT_FOUND,
          'File not found in the workspace.',
          buildPathHint(relPath)
        );
      }
      throw this._ioError('resolve', relPath, error);
    }
    if (!this._isInside(root.realPath, realPath)) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_OUTSIDE_ROOT,
        'Path resolves outside the workspace root.',
        buildPathHint(relPath)
      );
    }
    const displayPath = this._displayPath(root.realPath, realPath);
    return {
      requestedPath: relPath,
      candidatePath,
      realPath,
      displayPath,
      pathKey: this._pathKey(displayPath),
    };
  }

  async _revalidateTarget(root, target, handleStats, lease) {
    await this._revalidateRoot(root, lease);
    let currentRealPath;
    let currentStats;
    try {
      currentRealPath = await this._step(lease, () => this._fs.realpath(target.candidatePath));
      if (!this._isInside(root.realPath, currentRealPath)) {
        throw workspaceFsError(
          VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_OUTSIDE_ROOT,
          'Path resolves outside the workspace root.',
          buildPathHint(target.requestedPath)
        );
      }
      currentStats = await this._step(lease, () => this._fs.stat(currentRealPath));
    } catch (error) {
      if (this._structured(error)) throw error;
      if (error?.code === 'ENOENT') {
        throw workspaceFsError(
          VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT,
          'The file identity changed while it was open.',
          buildPathHint(target.requestedPath)
        );
      }
      throw this._ioError('revalidate', target.requestedPath, error);
    }
    if (!this._samePath(currentRealPath, target.realPath) || !sameFileIdentity(handleStats, currentStats)) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT,
        'The file identity changed while it was open.',
        buildPathHint(target.requestedPath)
      );
    }
  }

  async _readHandleBounded(handle, initialStats, relPath, lease, {
    maxBytes = this._maxReadBytes,
    tooLargeCode = VERSIONED_WORKSPACE_FILE_ERROR_CODES.TOO_LARGE,
    tooLargeMessage = 'File is too large to open in the editor.',
  } = {}) {
    try {
      return await readStableFileBytes({
        initialStats,
        maxBytes,
        readAt: (chunk, offset) => this._step(
          lease,
          () => handle.read(chunk, 0, chunk.length, offset)
        ),
        statAfter: () => this._step(lease, () => handle.stat()),
      });
    } catch (error) {
      if (!(error instanceof StableFileReadError)) throw error;
      if (error.reason === 'not_regular_file') {
        throw workspaceFsError(
          VERSIONED_WORKSPACE_FILE_ERROR_CODES.NOT_A_FILE,
          'Path is not a regular file.',
          buildPathHint(relPath)
        );
      }
      if (error.reason === 'too_large') {
        throw workspaceFsError(
          tooLargeCode,
          tooLargeMessage,
          {
            ...buildPathHint(relPath),
            size: error.details.size,
            max_bytes: error.details.maxBytes,
          }
        );
      }
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT,
        'The file changed while it was being read.',
        buildPathHint(relPath)
      );
    }
  }

  async _openStableBytes(root, target, lease, stage, readOptions = {}) {
    let handle = null;
    let state = null;
    let operationError = null;
    try {
      handle = await this._openCancellableHandle(lease, () => this._fs.open(target.realPath, 'r'));
      await this._runHook('afterTargetOpen', {
        operationId: lease.operationId,
        stage,
        path: target.displayPath,
      }, lease);
      const initialStats = await this._step(lease, () => handle.stat());
      await this._revalidateTarget(root, target, initialStats, lease);
      const read = readOptions.statsOnly === true
        ? { stats: initialStats }
        : await this._readHandleBounded(
          handle, initialStats, target.requestedPath, lease, readOptions
        );
      await this._revalidateTarget(root, target, read.stats, lease);
      state = readOptions.statsOnly === true
        ? { ...target, stats: read.stats }
        : { ...target, ...read, fileVersion: createFileVersion(read.stats, read.bytes) };
    } catch (error) {
      if (this._structured(error)) {
        operationError = error;
      } else if (error?.code === 'ENOENT') {
        operationError = workspaceFsError(
          VERSIONED_WORKSPACE_FILE_ERROR_CODES.NOT_FOUND,
          'File not found in the workspace.',
          buildPathHint(target.requestedPath)
        );
      } else {
        operationError = this._ioError('read', target.requestedPath, error);
      }
    }
    let closeError = null;
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        closeError = error;
      }
    }
    if (operationError) throw operationError;
    if (closeError) throw this._ioError('close', target.requestedPath, closeError);
    this._assertCurrent(lease);
    return state;
  }

  async _openStableText(root, target, lease, stage, intent = 'edit', maxBytes = this._maxReadBytes) {
    const state = await this._openStableBytes(root, target, lease, stage, { maxBytes });
    return {
      ...state,
      ...decodeWorkspaceText(state.bytes, {
        intent,
        details: buildPathHint(target.requestedPath),
      }),
    };
  }

  _metadata(state, context, includeContent = false) {
    const metadata = {
      path: state.displayPath,
      pathKey: state.pathKey,
      requestedPath: state.requestedPath,
      requestedPathKey: this._pathKey(state.requestedPath),
      size: state.bytes.length,
      mtimeMs: state.stats.mtimeMs,
      eol: state.eol,
      rootId: context.rootId,
      generation: context.generation,
      fileVersion: state.fileVersion,
      encoding: state.encoding,
      editable: state.editable,
      truncated: state.truncated === true,
    };
    if (includeContent) metadata.content = state.content;
    return metadata;
  }

  _imageDescriptor(relPath, canonicalPath = null) {
    const descriptor = getMatchingImageDescriptor(relPath, canonicalPath ?? relPath);
    if (!descriptor) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.IMAGE_UNSUPPORTED,
        'Only supported workspace image files can be opened as images.',
        buildPathHint(relPath)
      );
    }
    return descriptor;
  }

  _previewReadLimit(payload, intent) {
    if (intent !== 'preview' || payload.maxBytes === undefined) return this._maxReadBytes;
    if (!Number.isSafeInteger(payload.maxBytes) || payload.maxBytes <= 0) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_INVALID,
        'Preview byte limit must be a positive safe integer.'
      );
    }
    return Math.min(payload.maxBytes, this._maxReadBytes);
  }

  _validateWritePayload(payload) {
    const relPath = this._normalizeRelPath(payload?.path);
    if (typeof payload?.content !== 'string'
      || hasUnpairedSurrogate(payload.content)
      || payload.content.startsWith('\ufeff')) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.CONTENT_INVALID,
        'Editor content must be well-formed Unicode without an embedded leading BOM.',
        buildPathHint(relPath)
      );
    }
    if (!Number.isSafeInteger(payload.expectedGeneration) || payload.expectedGeneration < 0) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.STALE_GENERATION,
        'A valid workspace generation is required before saving.'
      );
    }
    if (typeof payload.expectedFileVersion !== 'string'
      || !payload.expectedFileVersion
      || payload.expectedFileVersion.length > 256) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT,
        'A valid file version is required before saving.',
        buildPathHint(relPath)
      );
    }
    const bodyBytes = Buffer.from(payload.content, 'utf8');
    if (bodyBytes.length > this._maxWriteBytes) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.TOO_LARGE,
        'Editor content exceeds the write limit.',
        { ...buildPathHint(relPath), size: bodyBytes.length, max_bytes: this._maxWriteBytes }
      );
    }
    return { relPath, bodyBytes };
  }

  async _withPathLock(key, lease, hookPayload, operation) {
    if (this._pendingWrites >= this._maxPendingWrites) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_QUEUE_FULL,
        'Too many workspace file writes are pending; retry shortly.'
      );
    }
    const previous = this._pathWriteTails.get(key) || Promise.resolve();
    let releaseTail;
    const tail = new Promise((resolve) => { releaseTail = resolve; });
    this._pathWriteTails.set(key, tail);
    this._pendingWrites += 1;
    try {
      await this._runHook('afterWriteQueued', hookPayload, lease);
      await previous;
      this._assertCurrent(lease);
      return await operation();
    } finally {
      releaseTail();
      this._pendingWrites -= 1;
      if (this._pathWriteTails.get(key) === tail) this._pathWriteTails.delete(key);
    }
  }

  async _openParent(root, target, lease) {
    const parentPath = this._path.dirname(target.realPath);
    let realPath;
    let handle = null;
    try {
      realPath = await this._step(lease, () => this._fs.realpath(parentPath));
      if (!this._isInside(root.realPath, realPath)) {
        throw workspaceFsError(
          VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_OUTSIDE_ROOT,
          'The target directory resolves outside the workspace root.',
          buildPathHint(target.requestedPath)
        );
      }
      handle = await this._step(lease, () => this._fs.open(realPath, 'r'));
      const stats = await this._step(lease, () => handle.stat());
      if (!stats.isDirectory()) throw this._rootError('parent_not_directory');
      await this._revalidateParent(root, { realPath, handle, stats }, lease);
      return { realPath, handle, stats };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (this._structured(error)) throw error;
      throw this._ioError('open_parent', target.requestedPath, error);
    }
  }

  async _revalidateParent(root, parent, lease) {
    await this._revalidateRoot(root, lease);
    let currentRealPath;
    let currentStats;
    try {
      currentRealPath = await this._step(lease, () => this._fs.realpath(parent.realPath));
      currentStats = await this._step(lease, () => this._fs.stat(currentRealPath));
    } catch (error) {
      if (this._structured(error)) throw error;
      throw this._ioError('revalidate_parent', '', error);
    }
    if (!this._samePath(currentRealPath, parent.realPath)
      || !currentStats.isDirectory()
      || !sameFileIdentity(parent.stats, currentStats)) {
      throw this._rootError('parent_identity_changed');
    }
  }

  async _cleanupTemp(tempPath, relPath) {
    if (!tempPath) return;
    try {
      await this._fs.unlink(tempPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      this._log('WARN', 'workspace_file.temp_cleanup_failed', {
        ...buildPathHint(relPath),
        os_code: String(error?.code || ''),
      });
    }
  }

  async _createTemp(root, parent, target, mode, lease) {
    for (let attempt = 0; attempt < TEMP_CREATE_ATTEMPTS; attempt += 1) {
      const suffix = crypto.randomBytes(8).toString('hex');
      const tempPath = this._path.join(
        parent.realPath,
        `.${this._path.basename(target.realPath)}.jenny-vfs-${process.pid}-${suffix}`
      );
      let handle = null;
      try {
        await this._revalidateParent(root, parent, lease);
        handle = await this._step(lease, () => this._fs.open(tempPath, 'wx', mode));
        const stats = await this._step(lease, () => handle.stat());
        const currentRealPath = await this._step(lease, () => this._fs.realpath(tempPath));
        const currentStats = await this._step(lease, () => this._fs.stat(currentRealPath));
        if (!this._isInside(root.realPath, currentRealPath)
          || !this._samePath(currentRealPath, tempPath)
          || !sameFileIdentity(stats, currentStats)) {
          throw workspaceFsError(
            VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_OUTSIDE_ROOT,
            'Temporary file identity escaped the workspace.',
            buildPathHint(target.requestedPath)
          );
        }
        await this._revalidateParent(root, parent, lease);
        return { path: tempPath, handle, stats };
      } catch (error) {
        const ownsTemp = Boolean(handle);
        if (handle) await handle.close().catch(() => {});
        // `wx` can fail because another process already owns this random name.
        // Never unlink a path unless this attempt successfully created it.
        if (ownsTemp) await this._cleanupTemp(tempPath, target.requestedPath);
        if (!ownsTemp && error?.code === 'EEXIST') continue;
        if (this._structured(error)) throw error;
        throw this._ioError('create_temp', target.requestedPath, error);
      }
    }
    throw this._ioError('create_temp', target.requestedPath, { code: 'EEXIST' });
  }

  async _writeAndCloseTemp(temp, bytes, mode, target, lease) {
    let operationError = null;
    try {
      await this._step(lease, () => temp.handle.writeFile(bytes));
      await this._step(lease, () => temp.handle.chmod(mode));
      await this._step(lease, () => temp.handle.sync());
      const stats = await this._step(lease, () => temp.handle.stat());
      if (stats.size !== bytes.length) {
        throw this._ioError('write_temp', target.requestedPath, { code: 'SHORT_WRITE' });
      }
      temp.stats = stats;
    } catch (error) {
      operationError = this._structured(error)
        ? error
        : this._ioError('write_temp', target.requestedPath, error);
    }
    let closeError = null;
    try {
      await temp.handle.close();
    } catch (error) {
      closeError = error;
    }
    temp.handle = null;
    if (operationError) throw operationError;
    if (closeError) throw this._ioError('close_temp', target.requestedPath, closeError);
    this._assertCurrent(lease);
  }

  async _revalidateTemp(root, temp, target, lease) {
    let currentRealPath;
    let currentStats;
    try {
      currentRealPath = await this._step(lease, () => this._fs.realpath(temp.path));
      currentStats = await this._step(lease, () => this._fs.stat(currentRealPath));
    } catch (error) {
      if (this._structured(error)) throw error;
      throw this._ioError('revalidate_temp', target.requestedPath, error);
    }
    if (!this._isInside(root.realPath, currentRealPath)
      || !this._samePath(currentRealPath, temp.path)
      || !sameFileIdentity(temp.stats, currentStats)) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_OUTSIDE_ROOT,
        'Temporary file identity changed before replacement.',
        buildPathHint(target.requestedPath)
      );
    }
  }

  async _syncParent(parent, target, lease) {
    try {
      await this._step(lease, () => parent.handle.sync());
    } catch (error) {
      if (this._structured(error)) throw error;
      this._assertCurrent(lease);
      const osCode = String(error?.code || '');
      if (PARENT_SYNC_UNSUPPORTED.has(osCode)
        || (this._platform === 'win32' && WINDOWS_PARENT_SYNC_UNSUPPORTED.has(osCode))) {
        this._log('DEBUG', 'workspace_file.parent_sync_unsupported', {
          ...buildPathHint(target.requestedPath),
          os_code: osCode,
        });
        return;
      }
      this._log('WARN', 'workspace_file.parent_sync_failed', {
        ...buildPathHint(target.requestedPath),
        os_code: osCode,
        bytes_replaced: true,
      });
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.IO_FAILED,
        'File contents were replaced, but durable storage could not be confirmed.',
        {
          ...buildPathHint(target.requestedPath),
          operation: 'sync_parent',
          os_code: osCode,
          bytes_replaced: true,
          durability_uncertain: true,
        }
      );
    }
  }

  _observeWrite(method, ...args) {
    try {
      return typeof this._writeObserver?.[method] === 'function'
        ? this._writeObserver[method](...args)
        : null;
    } catch (error) {
      this._log('WARN', 'workspace_file.write_observer_failed', {
        method: String(method || '').slice(0, 32),
        code: String(error?.code || '').slice(0, 64),
      });
      return null;
    }
  }

  async readText(payload = {}) {
    const relPath = this._normalizeRelPath(payload.path);
    const intent = payload.intent === 'preview' ? 'preview' : 'edit';
    const maxBytes = this._previewReadLimit(payload, intent);
    const capturedContext = this._captureContext();
    let lease = null;
    try {
      lease = await this._acquireLease('read', capturedContext);
      const root = await this._prepareRoot(lease);
      const target = await this._resolveTarget(root, relPath, lease);
      const state = await this._openStableText(root, target, lease, 'read', intent, maxBytes);
      this._assertCurrent(lease);
      return this._metadata(state, lease.context, true);
    } catch (error) {
      if (this._structured(error)) throw error;
      throw this._ioError('read_text', relPath, error);
    } finally {
      try { lease?.release(); } catch (_error) { /* idempotent coordinator seam */ }
    }
  }

  async readImage(payload = {}) {
    const relPath = this._normalizeRelPath(payload.path);
    this._imageDescriptor(relPath);
    const capturedContext = this._captureContext();
    let lease = null;
    try {
      lease = await this._acquireLease('read', capturedContext);
      const root = await this._prepareRoot(lease);
      const target = await this._resolveTarget(root, relPath, lease);
      const descriptor = this._imageDescriptor(relPath, target.displayPath);
      const state = await this._openStableBytes(root, target, lease, 'read-image', {
        maxBytes: this._maxImageBytes,
        tooLargeCode: VERSIONED_WORKSPACE_FILE_ERROR_CODES.IMAGE_TOO_LARGE,
        tooLargeMessage: 'Image is too large to preview.',
      });
      if (!imageBytesMatchDescriptor(state.bytes, descriptor)) {
        throw workspaceFsError(
          VERSIONED_WORKSPACE_FILE_ERROR_CODES.IMAGE_UNSUPPORTED,
          'Only supported workspace image files can be opened as images.',
          buildPathHint(relPath));
      }
      this._assertCurrent(lease);
      return buildImageMetadata(
        state,
        lease.context,
        this._pathKey(state.requestedPath),
        descriptor
      );
    } catch (error) {
      if (this._structured(error)) throw error;
      throw this._ioError('read_image', relPath, error);
    } finally {
      try { lease?.release(); } catch (_error) { /* idempotent coordinator seam */ }
    }
  }

  async writeText(payload = {}) {
    const { relPath, bodyBytes } = this._validateWritePayload(payload);
    const capturedContext = this._captureContext(payload.expectedGeneration);
    let lease = null;
    try {
      lease = await this._acquireLease('mutation', capturedContext);
      const root = await this._prepareRoot(lease);
      const initialTarget = await this._resolveTarget(root, relPath, lease);
      const lockKey = `${lease.context.rootId}:${lease.context.generation}:${initialTarget.pathKey}`;
      return await this._withPathLock(lockKey, lease, {
        operationId: lease.operationId,
        path: initialTarget.displayPath,
      }, async () => {
        const target = await this._resolveTarget(root, relPath, lease);
        if (target.pathKey !== initialTarget.pathKey) {
          throw workspaceFsError(
            VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT,
            'The file path identity changed before saving.',
            buildPathHint(relPath)
          );
        }
        const current = await this._openStableText(root, target, lease, 'write-current');
        if (current.fileVersion !== payload.expectedFileVersion) {
          throw workspaceFsError(
            VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT,
            'File changed on disk since it was loaded.',
            {
              ...buildPathHint(relPath),
              current_file_version: current.fileVersion,
            }
          );
        }
        const bytes = current.encoding === 'utf-8-bom'
          ? Buffer.concat([UTF8_BOM, bodyBytes])
          : bodyBytes;
        if (bytes.length > this._maxWriteBytes) {
          throw workspaceFsError(
            VERSIONED_WORKSPACE_FILE_ERROR_CODES.TOO_LARGE,
            'Editor content exceeds the write limit.',
            { ...buildPathHint(relPath), size: bytes.length, max_bytes: this._maxWriteBytes }
          );
        }
        if (bytes.equals(current.bytes)) return this._metadata(current, lease.context);

        const parent = await this._openParent(root, target, lease);
        let temp = null;
        let replaced = false;
        let writeTicket = null;
        let writeObserved = false;
        try {
          const mode = current.stats.mode & 0o7777;
          temp = await this._createTemp(root, parent, target, mode, lease);
          await this._writeAndCloseTemp(temp, bytes, mode, target, lease);
          await this._runHook('beforeReplace', {
            operationId: lease.operationId,
            path: target.displayPath,
            mode,
          }, lease);

          const beforeReplaceTarget = await this._resolveTarget(root, relPath, lease);
          if (beforeReplaceTarget.pathKey !== target.pathKey) {
            throw workspaceFsError(
              VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT,
              'The file path identity changed before replacement.',
              buildPathHint(relPath)
            );
          }
          const beforeReplace = await this._openStableBytes(
            root, beforeReplaceTarget, lease, 'pre-replace', { statsOnly: true }
          );
          if (!sameReadSnapshot(current.stats, beforeReplace.stats)) {
            throw workspaceFsError(
              VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT,
              'File changed on disk before replacement.',
              buildPathHint(relPath)
            );
          }
          await this._revalidateParent(root, parent, lease);
          await this._revalidateTemp(root, temp, target, lease);
          writeTicket = this._observeWrite('begin', {
            path: target.displayPath,
            pathKey: target.pathKey,
            rootId: lease.context.rootId,
            generation: lease.context.generation,
          });
          try {
            await this._step(lease, () => this._fs.rename(temp.path, target.realPath));
          } catch (error) {
            if (this._structured(error)) throw error;
            throw this._ioError(
              'atomic_replace',
              relPath,
              error,
              VERSIONED_WORKSPACE_FILE_ERROR_CODES.ATOMIC_WRITE_FAILED
            );
          }
          replaced = true;
          await this._syncParent(parent, target, lease);

          const landedTarget = await this._resolveTarget(root, relPath, lease);
          const landedSnapshot = await this._openStableBytes(
            root, landedTarget, lease, 'write-result', { statsOnly: true }
          );
          if (!sameFileIdentity(temp.stats, landedSnapshot.stats)
            || Number(landedSnapshot.stats.size) !== bytes.length) {
            throw this._ioError('verify_replace', relPath, { code: 'IDENTITY_CHANGED' });
          }
          const landed = {
            ...landedSnapshot, bytes,
            fileVersion: createFileVersion(landedSnapshot.stats, bytes),
            ...decodeWorkspaceText(bytes, { details: buildPathHint(relPath) }),
          };
          this._assertCurrent(lease);
          if (writeTicket) writeObserved = this._observeWrite('commit', writeTicket, landed.stats) === true;
          this._log('INFO', 'workspace_file.write', {
            ...buildPathHint(relPath),
            size: landed.bytes.length,
            root_id: lease.context.rootId,
            generation: lease.context.generation,
          });
          this._assertCurrent(lease);
          return this._metadata(landed, lease.context);
        } finally {
          if (writeTicket && !writeObserved) this._observeWrite('abort', writeTicket);
          if (temp?.handle) await temp.handle.close().catch(() => {});
          if (temp && !replaced) await this._cleanupTemp(temp.path, relPath);
          try {
            await parent.handle.close();
          } catch (error) {
            this._log('WARN', 'workspace_file.parent_close_failed', {
              ...buildPathHint(relPath),
              os_code: String(error?.code || ''),
            });
          }
        }
      });
    } catch (error) {
      if (this._structured(error)) throw error;
      throw this._ioError('write_text', relPath, error);
    } finally {
      try { lease?.release(); } catch (_error) { /* idempotent coordinator seam */ }
    }
  }
}

module.exports = {
  DEFAULT_MAX_IMAGE_BYTES,
  VERSIONED_WORKSPACE_FILE_ERROR_CODES,
  VersionedWorkspaceFileService,
};
