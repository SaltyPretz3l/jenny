/* services/workspace-ide-service.js - root-scoped filesystem access for the
 * Workspace IDE page. Every renderer-supplied path is workspace-root-relative
 * (POSIX separators); absolute paths, drive letters, UNC shares, `..`
 * segments, and NUL bytes are rejected lexically before any fs call, then the
 * resolved target is realpath-contained inside toolsWorkspaceRoot (symlink /
 * junction escapes rejected) via ToolPathPolicy. */

const crypto = require('crypto');
const fsPromises = require('fs/promises');
const nodePath = require('path');

const { ToolPathPolicy } = require('./tools/tool-path-policy');
const { WORKSPACE_FS_ERROR_CODES, workspaceFsError } = require('./workspace-ide-errors');
const {
  buildPathLogHint,
  existsError,
  normalizeWorkspaceRelPath,
} = require('./workspace-ide-path-guard');
const {
  buildEnumerationMeta,
  cancellationReason,
  iterateDirectoryEntries,
  normalizePositiveInteger,
  walkWorkspaceFiles,
} = require('./workspace-ide-enumerator');
const { resolveWalkIgnorePolicy } = require('./workspace-ide-ignore-policy');
const { searchWorkspaceFiles } = require('./workspace-ide-search');
const { readCappedFile } = require('./workspace-ide-file-reads');
const { IMAGE_READ_MAX_BYTES, imageMimeTypeForExtension } = require('./workspace-ide-image-reads');
const {
  isAmbiguousGeneratedDirectoryName, isBuildManifestFileName,
  isGeneratedDirectoryName, pruneAmbiguousGeneratedEntries,
} = require('./workspace-ide-generated-directories');
const { WorkspaceRootOperationManager, sameFileIdentity } = require('./workspace-root-operation');

const READ_MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
const BINARY_SCAN_LENGTH = 8192;
// Saves recorded here let the (later-wave) watcher drop self-echo events.
const RECENT_WRITE_CAP = 256;
// WIDE-028 (c): a suppression token the watcher never consumed must expire -
// without a TTL, a lost/unstarted watch left the record alive indefinitely
// and a later external edit with the same fingerprint could be swallowed.
const RECENT_WRITE_TTL_MS = 30_000;
const LIST_MAX_ENTRIES = 2000;
const LIST_MAX_SCANNED_ENTRIES = 10000;
const LIST_MAX_DURATION_MS = 2000;
// Skipped at every level of the explorer tree (renderer can opt in later).
const LIST_SKIP_NAMES = new Set(['.git']);
const LIST_ALL_MAX_FILES = 20000;

function recentWriteFingerprint(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const result = {};
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
    const value = stats[key];
    result[key] = typeof value === 'bigint' ? value.toString() : Number.isFinite(value) ? String(value) : '';
  }
  return result;
}

function sameRecentWrite(left, right) {
  return Boolean(left && right
    && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => left[key] === right[key]));
}

class WorkspaceIdeService {
  constructor({
    configService,
    fs = fsPromises,
    path = nodePath,
    logger = null,
    trashItemImpl = null,
    showItemInFolderImpl = null,
    openPathImpl = null,
    snapshotStore = null,
    rootContextProvider = null,
    gitServiceProvider = null,
    platform = process.platform,
    hooks = null,
    now = Date.now,
  } = {}) {
    if (!configService) {
      throw new TypeError('WorkspaceIdeService requires configService');
    }
    this._configService = configService;
    this._fs = fs;
    this._path = path;
    this._platform = platform;
    this._logger = typeof logger === 'function' ? logger : null;
    this._pathPolicy = new ToolPathPolicy({ fs, path, logger });
    this._recentWrites = new Map();
    // Electron shell.trashItem injected at construction (artifact-workspace
    // pattern); delete NEVER falls back to a hard unlink when it is absent.
    this._trashItemImpl = typeof trashItemImpl === 'function' ? trashItemImpl : null;
    // Electron shell.showItemInFolder / shell.openPath, same injection
    // pattern; reveal/open degrade to typed errors when absent (test shells).
    this._showItemInFolderImpl = typeof showItemInFolderImpl === 'function' ? showItemInFolderImpl : null;
    this._openPathImpl = typeof openPathImpl === 'function' ? openPathImpl : null;
    // Pre-change snapshot store (workspace-ide-snapshot-store.js); readable
    // even when absent - readPreChange degrades to a found:false miss.
    this._snapshotStore = snapshotStore || null;
    this._gitServiceProvider = gitServiceProvider;
    this._now = typeof now === 'function' ? now : Date.now;
    this._activeSearchController = null;
    this._rootOperations = new WorkspaceRootOperationManager({
      rootContextProvider,
      fs,
      path,
      platform,
      hooks,
    });
  }

  _log(level, event, details = {}) {
    if (this._logger) {
      try {
        this._logger(level, event, details);
      } catch (_error) {
        /* logging must never break file access */
      }
    }
  }

  _requireRoot() {
    const root = String(this._configService.getToolsWorkspaceRoot?.() || '').trim();
    if (!root) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.ROOT_MISSING,
        'No workspace root is configured; choose a workspace folder first.'
      );
    }
    return root;
  }

  async acquireRootOperation({ kind = 'read', expectedGeneration = null } = {}) {
    const operation = this._rootOperations.acquire({ kind, expectedGeneration });
    try {
      await this._rootOperations.prepareRoot(operation);
      return operation;
    } catch (error) {
      operation.release();
      throw error;
    }
  }

  async _withRootOperation(kind, payload, existingOperation, callback) {
    let operation = existingOperation;
    let release = false;
    if (operation) {
      if (!this._rootOperations.owns(operation)) {
        throw workspaceFsError(
          WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING,
          'The workspace root operation is invalid.',
          { reason: 'operation_invalid' }
        );
      }
    } else {
      operation = await this.acquireRootOperation({
        kind,
        expectedGeneration: payload?.expectedGeneration,
      });
      release = true;
    }
    try {
      this._rootOperations.assertCurrent(operation);
      const result = await callback(operation);
      this._rootOperations.assertCurrent(operation);
      return result;
    } finally {
      if (release) operation.release();
    }
  }

  // Lexical gate: returns the normalized POSIX relative path or throws.
  _normalizeRelPath(value, options) {
    return normalizeWorkspaceRelPath(value, options);
  }

  async _resolveInsideRoot(relPath) {
    const root = this._requireRoot();
    const normalizedRel = this._normalizeRelPath(relPath);
    const resolved = this._path.resolve(root, normalizedRel);
    let realPath;
    try {
      realPath = await this._pathPolicy.assertInsideRoot(resolved, { workingDirectory: root });
    } catch (error) {
      if (error?.code && String(error.code).startsWith('CMP-')) {
        throw error;
      }
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.PATH_OUTSIDE_ROOT,
        'Path resolves outside the workspace root.',
        buildPathLogHint(normalizedRel)
      );
    }
    return { root, relPath: normalizedRel, resolved, realPath };
  }

  getRootState() {
    return {
      workspaceRoot: this._configService.getToolsWorkspaceRoot?.() || '',
      workspaceRootStatus: this._configService.getWorkspaceRootStatus(),
    };
  }

  async stat(payload = {}, existingOperation = null) {
    return this._withRootOperation('read', payload, existingOperation, async (operation) => {
      const relPath = this._normalizeRelPath(payload.path);
      let target;
      try {
        target = await this._rootOperations.resolveLeaf(operation.root, relPath, operation, {
          allowMissing: true,
        });
      } catch (error) {
        if (error?.code === WORKSPACE_FS_ERROR_CODES.NOT_FOUND) {
          return { path: relPath, exists: false, kind: 'missing', size: 0, mtimeMs: 0, ctimeMs: 0 };
        }
        throw error;
      }
      if (!target.stats) {
        return { path: relPath, exists: false, kind: 'missing', size: 0, mtimeMs: 0, ctimeMs: 0 };
      }
      const stats = target.stats;
      return {
        path: relPath,
        exists: true,
        kind: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
        dev: String(stats.dev ?? ''),
        ino: String(stats.ino ?? ''),
      };
    });
  }

  async readFile(payload = {}) {
    const { relPath, realPath } = await this._resolveInsideRoot(payload.path);
    const maxBytesRaw = Number(payload.maxBytes);
    const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
      ? Math.min(maxBytesRaw, READ_MAX_BYTES_DEFAULT)
      : READ_MAX_BYTES_DEFAULT;

    let stats;
    try {
      stats = await this._fs.stat(realPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw workspaceFsError(
          WORKSPACE_FS_ERROR_CODES.NOT_FOUND,
          'File not found in the workspace.',
          buildPathLogHint(relPath)
        );
      }
      throw error;
    }
    if (!stats.isFile()) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.NOT_A_FILE,
        'Path is not a regular file.',
        buildPathLogHint(relPath)
      );
    }
    // A declared-over-cap file is rejected without being read at all; otherwise
    // the cap is enforced against what the read actually produced.
    const buffer = stats.size > maxBytes
      ? null
      : await readCappedFile(this._fs, realPath, maxBytes);
    const observedSize = Math.max(stats.size, buffer?.length || 0);
    if (observedSize > maxBytes) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.TOO_LARGE,
        `File is too large to open in the editor (${observedSize} bytes > ${maxBytes} bytes).`,
        { ...buildPathLogHint(relPath), size: observedSize, max_bytes: maxBytes }
      );
    }
    const scanLength = Math.min(buffer.length, BINARY_SCAN_LENGTH);
    for (let index = 0; index < scanLength; index += 1) {
      if (buffer[index] === 0) {
        throw workspaceFsError(
          WORKSPACE_FS_ERROR_CODES.BINARY,
          'File appears to be binary and cannot be opened as text.',
          buildPathLogHint(relPath)
        );
      }
    }
    const content = buffer.toString('utf8');
    return {
      path: relPath,
      content,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      eol: content.includes('\r\n') ? 'crlf' : 'lf',
    };
  }

  // Base64 read for the image preview surface: same containment as readFile,
  // no binary scan (images ARE binary), its own 10 MB cap, extension-derived
  // MIME. Unknown extensions still read - the renderer routed by extension.
  async readFileBase64(payload = {}) {
    const { relPath, realPath } = await this._resolveInsideRoot(payload.path);
    let stats;
    try {
      stats = await this._fs.stat(realPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw workspaceFsError(
          WORKSPACE_FS_ERROR_CODES.NOT_FOUND,
          'File not found in the workspace.',
          buildPathLogHint(relPath)
        );
      }
      throw error;
    }
    if (!stats.isFile()) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.NOT_A_FILE,
        'Path is not a regular file.',
        buildPathLogHint(relPath)
      );
    }
    const buffer = stats.size > IMAGE_READ_MAX_BYTES
      ? null
      : await readCappedFile(this._fs, realPath, IMAGE_READ_MAX_BYTES);
    const observedSize = Math.max(stats.size, buffer?.length || 0);
    if (observedSize > IMAGE_READ_MAX_BYTES) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.IMAGE_TOO_LARGE,
        `Image is too large to preview (${observedSize} bytes > ${IMAGE_READ_MAX_BYTES} bytes).`,
        { ...buildPathLogHint(relPath), size: observedSize, max_bytes: IMAGE_READ_MAX_BYTES }
      );
    }
    const extension = (relPath.split('/').pop() || '').split('.').pop().toLowerCase();
    return {
      path: relPath,
      base64: buffer.toString('base64'),
      mime: imageMimeTypeForExtension(extension),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  async writeFile(payload = {}) {
    return this._withRootOperation('mutation', payload, null, async (operation) => {
      const relPath = this._normalizeRelPath(payload.path); const root = operation.root;
      const target = await this._rootOperations.resolveLeaf(root, relPath, operation, {
        createParents: true,
        allowMissing: true,
      }); // Creating (not saving-over) validates strictly: legacy names stay savable.
      if (!target.stats) this._normalizeRelPath(payload.path, { strictName: true });
      const content = String(payload.content ?? '');
      const expectedMtimeMs = Number(payload.expectedMtimeMs);
      const assertExpectedMtime = (stats) => {
        if (Number.isFinite(expectedMtimeMs)
          && expectedMtimeMs > 0
          && stats
          && stats.mtimeMs !== expectedMtimeMs) {
          throw workspaceFsError(
            WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT,
            'File changed on disk since it was last loaded.',
            { ...buildPathLogHint(relPath), currentMtimeMs: stats.mtimeMs }
          );
        }
      };
      assertExpectedMtime(target.stats);
      await this._rootOperations.runHook('beforeLeafMutation', {
        kind: 'writeFile', operation, root, target,
      }, operation);
      const current = await this._rootOperations.revalidateLeaf(root, target, operation);
      if (!target.lexicalStats && current.exists) {
        throw workspaceFsError(
          WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT,
          'A file appeared at the target path before it could be saved.',
          buildPathLogHint(relPath)
        );
      }
      assertExpectedMtime(current.currentStats || target.stats);

      const tempPath = this._path.join(
        target.parent.realPath,
        `.${this._path.basename(target.operationPath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
      );
      let tempCreated = false;
      try {
        await this._fs.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
        tempCreated = true;
        await this._rootOperations.revalidateParent(root, target.parent, operation);
        const beforeReplace = await this._rootOperations.revalidateLeaf(root, target, operation);
        if (!target.lexicalStats && beforeReplace.exists) {
          throw workspaceFsError(
            WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT,
            'A file appeared at the target path before it could be saved.',
            buildPathLogHint(relPath)
          );
        }
        assertExpectedMtime(beforeReplace.currentStats || target.stats);
        await this._fs.rename(tempPath, target.operationPath);
        tempCreated = false;
      } catch (error) {
        if (tempCreated) await this._fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
      await this._rootOperations.revalidateRoot(root, operation);
      await this._rootOperations.revalidateParent(root, target.parent, operation);
      const stats = await this._fs.stat(target.operationPath);
      this._rootOperations.assertCurrent(operation);
      this._recordRecentWrite(target.operationPath, stats);
      this._log('INFO', 'workspace_fs.write', {
        ...buildPathLogHint(relPath),
        size: stats.size,
      });
      return { path: relPath, size: stats.size, mtimeMs: stats.mtimeMs };
    });
  }

  // Resolves a directory payload path against the operation's pinned root.
  async _resolveDirectoryForList(value, operation) {
    const raw = String(value ?? '').trim().replace(/\\/g, '/');
    if (!raw || raw === '.') {
      await this._rootOperations.revalidateRoot(operation.root, operation);
      return { relPath: '', realPath: operation.root.realPath, token: null };
    }
    const relPath = this._normalizeRelPath(raw);
    const directory = await this._rootOperations.resolveLeaf(
      operation.root,
      relPath,
      operation
    );
    if (!directory.stats?.isDirectory?.()) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.NOT_A_DIRECTORY,
        'Path is not a directory.',
        buildPathLogHint(relPath)
      );
    }
    return { relPath, realPath: directory.realPath, token: directory };
  }

  async _revalidateDirectoryForList(resolved, operation) {
    if (resolved.token) {
      await this._rootOperations.revalidateLeaf(operation.root, resolved.token, operation);
      return;
    }
    await this._rootOperations.revalidateRoot(operation.root, operation);
  }

  // Complete listings retain directory-first/name ordering. Once a budget is
  // hit, the result is explicitly a locally sorted streamed subset; finding a
  // globally alphabetic prefix would require the unbounded full enumeration
  // this API is designed to avoid.
  async listDirectory(payload = {}, existingOperation = null) {
    return this._withRootOperation('read', payload, existingOperation, async (operation) => {
      const resolved = await this._resolveDirectoryForList(payload.path, operation);
      const { relPath, realPath } = resolved;
      const maxEntries = normalizePositiveInteger(payload.maxEntries, LIST_MAX_ENTRIES, LIST_MAX_ENTRIES);
      const maxScannedEntries = normalizePositiveInteger(
        payload.maxScannedEntries,
        LIST_MAX_SCANNED_ENTRIES,
        LIST_MAX_SCANNED_ENTRIES
      );
      const maxDurationMs = normalizePositiveInteger(
        payload.maxDurationMs,
        LIST_MAX_DURATION_MS,
        LIST_MAX_DURATION_MS * 5
      );
      const state = {
        now: this._now,
        startedAt: this._now(),
        filesScanned: 0,
        directoriesScanned: 1,
        entriesScanned: 0,
      };
      const classified = [];
      const hideGenerated = payload.showGenerated !== true;
      let hasBuildManifest = false; // ambiguous generated names prune post-loop (sibling module)
      let stopReason = null;
      const checkLifecycle = () => {
        const cancelled = cancellationReason({
          signal: operation.signal,
          assertCurrent: () => this._rootOperations.assertCurrent(operation),
        });
        if (cancelled) return cancelled;
        if (this._now() - state.startedAt >= maxDurationMs) return 'time_limit';
        return null;
      };
      const checkStop = () => {
        const lifecycleStop = checkLifecycle();
        if (lifecycleStop) return lifecycleStop;
        if (state.entriesScanned >= maxScannedEntries) return 'entry_limit';
        return null;
      };
      try {
        for await (const dirent of iterateDirectoryEntries(this._fs, realPath, {
          onCleanupError: () => this._log('WARN', 'workspace_fs.directory_close_degraded', {
            operation: 'list_directory',
          }),
        })) {
          stopReason = checkStop();
          if (stopReason) break;
          state.entriesScanned += 1;
          if (LIST_SKIP_NAMES.has(dirent.name)) continue;
          const kind = dirent.isSymbolicLink()
            ? 'symlink'
            : dirent.isDirectory()
              ? 'directory'
              : dirent.isFile()
                ? 'file'
                : '';
          if (!kind) continue;
          if (kind === 'directory' && hideGenerated
            && isGeneratedDirectoryName(dirent.name, { platform: this._platform })
            && !isAmbiguousGeneratedDirectoryName(dirent.name, { platform: this._platform })) continue;
          if (classified.length >= maxEntries) {
            stopReason = 'item_limit';
            break;
          }
          if (kind === 'file') {
            state.filesScanned += 1;
            if (isBuildManifestFileName(dirent.name, { platform: this._platform })) hasBuildManifest = true;
          }
          classified.push({ name: dirent.name, kind });
        }
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw workspaceFsError(
            WORKSPACE_FS_ERROR_CODES.NOT_FOUND,
            'Directory not found in the workspace.',
            buildPathLogHint(relPath)
          );
        }
        if (error?.code === 'ENOTDIR') {
          throw workspaceFsError(
            WORKSPACE_FS_ERROR_CODES.NOT_A_DIRECTORY,
            'Path is not a directory.',
            buildPathLogHint(relPath)
          );
        }
        throw error;
      }
      await this._revalidateDirectoryForList(resolved, operation);
      const visible = hideGenerated && hasBuildManifest
        ? pruneAmbiguousGeneratedEntries(classified, { platform: this._platform })
        : classified;
      visible.sort((a, b) => {
        const kindOrder = Number(a.kind !== 'directory') - Number(b.kind !== 'directory');
        return kindOrder || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });

      const entries = [];
      for (const entry of visible) {
        const lifecycleStop = checkLifecycle();
        stopReason = stopReason || lifecycleStop;
        if (lifecycleStop) break;
        const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
        let size = 0;
        let mtimeMs = 0;
        try {
          const stats = await this._fs.lstat(this._path.join(realPath, entry.name));
          this._rootOperations.assertCurrent(operation);
          size = stats.size;
          mtimeMs = stats.mtimeMs;
        } catch (error) {
          if (String(error?.code || '').startsWith('CMP-')) throw error;
          /* entry vanished or became unreadable; keep zeroed metadata */
        }
        entries.push({ name: entry.name, relPath: entryRelPath, kind: entry.kind, size, mtimeMs });
      }
      stopReason = stopReason || checkLifecycle();
      await this._revalidateDirectoryForList(resolved, operation);
      const metadata = buildEnumerationMeta(state, stopReason);
      if (metadata.truncated) {
        this._log('WARN', 'workspace_fs.list_directory_truncated', {
          reason: metadata.truncationReason,
          entries_scanned: metadata.entriesScanned,
          result_count: entries.length,
        });
      }
      return {
        path: relPath,
        entries,
        ...metadata,
        ordering: metadata.truncated ? 'streamed_subset' : 'directory_first_name',
        rootId: operation.context.rootId,
        generation: operation.context.generation,
      };
    });
  }

  // Streamed breadth-first file walk for Quick Open. Every result is pinned to
  // one root lease; the shared enumerator applies file/directory/entry/time
  // budgets while producing paths and closes the active directory on cancel.
  async listAllFiles(payload = {}, existingOperation = null) {
    return this._withRootOperation('read', payload, existingOperation, async (operation) => {
      const root = operation.root;
      const files = [];
      const ignorePolicy = await resolveWalkIgnorePolicy({
        gitService: this._gitServiceProvider?.(), signal: operation.signal,
        platform: this._platform, extraSkipNames: ['node_modules'],
      });
      const metadata = await walkWorkspaceFiles({
        fs: this._fs,
        resolveDirectory: async (relPath) => {
          await this._rootOperations.revalidateRoot(root, operation);
          if (!relPath) return root.realPath;
          const directory = await this._rootOperations.resolveLeaf(root, relPath, operation);
          return directory.stats?.isDirectory?.() ? directory.realPath : null;
        },
        onFile: async (relPath) => {
          files.push(relPath);
          return true;
        },
        shouldSkipDirectory: ignorePolicy.shouldSkipDirectory,
        shouldSkipError: (error) => (
          error?.code === WORKSPACE_FS_ERROR_CODES.NOT_FOUND
          || error?.code === 'ENOENT'
          || error?.code === 'EACCES'
        ),
        maxFiles: normalizePositiveInteger(payload.maxFiles, LIST_ALL_MAX_FILES, LIST_ALL_MAX_FILES),
        maxDirectories: payload.maxDirectories,
        maxEntries: payload.maxEntries,
        maxDurationMs: payload.maxDurationMs,
        signal: operation.signal,
        assertCurrent: () => this._rootOperations.assertCurrent(operation),
        now: this._now,
        onCleanupError: () => this._log('WARN', 'workspace_fs.directory_close_degraded', {
          operation: 'list_all',
        }),
      });
      if (metadata.truncated) {
        this._log('WARN', 'workspace_fs.list_all_truncated', {
          root_id: operation.context.rootId,
          root_generation: operation.context.generation,
          reason: metadata.truncationReason,
          totals_known: metadata.totalsKnown,
          files_scanned: metadata.filesScanned,
          directories_scanned: metadata.directoriesScanned,
          entries_scanned: metadata.entriesScanned,
          elapsed_ms: metadata.elapsedMs,
        });
      }
      return {
        files,
        ...metadata,
        ignoreSource: ignorePolicy.describe().source,
        rootId: operation.context.rootId,
        generation: operation.context.generation,
      };
    });
  }

  async _statIfExists(realPath) {
    try {
      return await this._fs.lstat(realPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  _existsError(relPath) {
    return existsError(relPath);
  }

  async _createLeaf(payload, { kind, create }) {
    return this._withRootOperation('mutation', payload, null, async (operation) => {
      const relPath = this._normalizeRelPath(payload.path, { strictName: true });
      const root = operation.root;
      const target = await this._rootOperations.resolveLeaf(root, relPath, operation, {
        createParents: true,
        allowMissing: true,
      });
      if (target.stats) throw this._existsError(relPath);
      await this._rootOperations.runHook('beforeLeafMutation', {
        kind: kind === 'file' ? 'createFile' : 'createDirectory', operation, root, target,
      }, operation);
      const current = await this._rootOperations.revalidateLeaf(root, target, operation);
      if (current.exists) throw this._existsError(relPath);
      try {
        await create(target.operationPath);
      } catch (error) {
        if (error?.code === 'EEXIST') throw this._existsError(relPath);
        throw error;
      }
      this._rootOperations.assertCurrent(operation);
      await this._rootOperations.revalidateRoot(root, operation);
      await this._rootOperations.revalidateParent(root, target.parent, operation);
      let stats = null;
      if (kind === 'file') {
        stats = await this._fs.stat(target.operationPath);
        this._rootOperations.assertCurrent(operation);
        this._recordRecentWrite(target.operationPath, stats);
      }
      this._log('INFO', `workspace_fs.create_${kind}`, buildPathLogHint(relPath));
      return kind === 'file'
        ? { path: relPath, kind, size: stats.size, mtimeMs: stats.mtimeMs }
        : { path: relPath, kind };
    });
  }

  async createFile(payload = {}) {
    return this._createLeaf(payload, {
      kind: 'file',
      create: (targetPath) => this._fs.writeFile(targetPath, '', { encoding: 'utf8', flag: 'wx' }),
    });
  }

  async createDirectory(payload = {}) {
    return this._createLeaf(payload, {
      kind: 'directory',
      create: (targetPath) => this._fs.mkdir(targetPath),
    });
  }

  async rename(payload = {}) {
    return this._withRootOperation('mutation', payload, null, async (operation) => {
      const from = this._normalizeRelPath(payload.from);
      const to = this._normalizeRelPath(payload.to, { strictName: true, relocationFrom: from });
      const root = operation.root;
      const source = await this._rootOperations.resolveLeaf(root, from, operation, {
        preserveLeaf: true,
      });
      const target = await this._rootOperations.resolveLeaf(root, to, operation, {
        createParents: true,
        allowMissing: true,
      });
      const sameIdentity = from !== to
        && from.toLowerCase() === to.toLowerCase()
        && Boolean(source.lexicalStats?.dev)
        && Boolean(source.lexicalStats?.ino)
        && sameFileIdentity(source.lexicalStats, target.lexicalStats);
      if (target.stats && !sameIdentity) throw this._existsError(to);
      await this._rootOperations.runHook('beforeLeafMutation', {
        kind: 'rename', operation, root, source, target,
      }, operation);
      await this._rootOperations.revalidateLeaf(root, source, operation);
      const targetCurrent = await this._rootOperations.revalidateLeaf(root, target, operation);
      if (targetCurrent.exists && !sameIdentity) throw this._existsError(to);
      if (sameIdentity) {
        let tempPath;
        while (!tempPath) {
          const candidate = this._path.join(target.parent.realPath,
            `.${this._path.basename(target.lexicalPath).slice(0, 180)}.tmp-rename-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
          try {
            await this._fs.lstat(candidate);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            tempPath = candidate;
          }
        }
        await this._fs.rename(source.operationPath, tempPath);
        try {
          await this._rootOperations.revalidateParent(root, target.parent, operation);
          await this._fs.rename(tempPath, target.lexicalPath);
        } catch (error) {
          await this._fs.rename(tempPath, source.operationPath).catch(() => {});
          throw error;
        }
      } else {
        await this._fs.rename(source.operationPath, target.operationPath);
      }
      this._rootOperations.assertCurrent(operation);
      await this._rootOperations.revalidateRoot(root, operation);
      await this._rootOperations.revalidateParent(root, target.parent, operation);
      this._log('INFO', 'workspace_fs.rename', {
        from: buildPathLogHint(from),
        to: buildPathLogHint(to),
      });
      return {
        from,
        to,
        kind: source.stats.isDirectory() ? 'directory' : 'file',
      };
    });
  }

  async delete(payload = {}) {
    return this._withRootOperation('mutation', payload, null, async (operation) => {
      const relPath = this._normalizeRelPath(payload.path);
      const root = operation.root;
      const target = await this._rootOperations.resolveLeaf(root, relPath, operation, {
        preserveLeaf: true,
      });
      const stats = target.stats;
      if (!this._trashItemImpl) {
        throw workspaceFsError(
          WORKSPACE_FS_ERROR_CODES.TRASH_FAILED,
          "Delete is unavailable in this shell mode — the OS recycle bin isn't reachable. Delete the item from your file manager instead.",
          buildPathLogHint(relPath)
        );
      }
      await this._rootOperations.runHook('beforeLeafMutation', {
        kind: 'delete', operation, root, target,
      }, operation);
      await this._rootOperations.revalidateLeaf(root, target, operation);
      try {
        await this._trashItemImpl(target.operationPath);
      } catch (error) {
        throw workspaceFsError(
          WORKSPACE_FS_ERROR_CODES.TRASH_FAILED,
          "The item couldn't be moved to the recycle bin. Delete it from your file manager instead.",
          { ...buildPathLogHint(relPath), message: String(error?.message || error || '') }
        );
      }
      this._rootOperations.assertCurrent(operation);
      this._log('INFO', 'workspace_fs.delete', {
        ...buildPathLogHint(relPath),
        kind: stats.isDirectory() ? 'directory' : 'file',
      });
      return { path: relPath, trashed: true, kind: stats.isDirectory() ? 'directory' : 'file' };
    });
  }

  // Opens the OS file manager with the item selected. Same lexical +
  // realpath containment as every other renderer-supplied path; the resolved
  // real path (not the renderer string) is what reaches the shell.
  async revealInFolder(payload = {}) {
    const { relPath, realPath } = await this._resolveInsideRoot(payload.path);
    if (!(await this._statIfExists(realPath))) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.NOT_FOUND,
        'File or folder not found in the workspace.',
        buildPathLogHint(relPath)
      );
    }
    if (!this._showItemInFolderImpl) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.REVEAL_UNAVAILABLE,
        'Reveal in File Explorer is unavailable in this shell mode.',
        buildPathLogHint(relPath)
      );
    }
    this._showItemInFolderImpl(realPath);
    this._log('INFO', 'workspace_fs.reveal_in_folder', buildPathLogHint(relPath));
    return { path: relPath, revealed: true };
  }

  // Opens the item with the OS default application (shell.openPath).
  // openPath resolves to '' on success or a human-readable error string.
  async openInDefaultApp(payload = {}) {
    const { relPath, realPath } = await this._resolveInsideRoot(payload.path);
    if (!(await this._statIfExists(realPath))) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.NOT_FOUND,
        'File or folder not found in the workspace.',
        buildPathLogHint(relPath)
      );
    }
    if (!this._openPathImpl) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.OPEN_UNAVAILABLE,
        'Open in Default App is unavailable in this shell mode.',
        buildPathLogHint(relPath)
      );
    }
    const failure = String((await this._openPathImpl(realPath)) || '');
    if (failure) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.OPEN_FAILED,
        'The OS could not open the item.',
        { ...buildPathLogHint(relPath), message: failure }
      );
    }
    this._log('INFO', 'workspace_fs.open_in_default_app', buildPathLogHint(relPath));
    return { path: relPath, opened: true };
  }

  // Returns the pre-change snapshot for a ledger before_hash, or a
  // found:false miss (evicted / never captured / store absent) the renderer
  // renders as the hunks-summary placeholder - misses are data, not errors.
  // The path rides along for the same lexical+containment validation every
  // renderer-supplied path gets; the lookup itself is hash-addressed.
  async readPreChange(payload = {}) {
    const { relPath } = await this._resolveInsideRoot(payload.path);
    const beforeHash = String(payload.beforeHash || '').trim();
    let result = { found: false, reason: 'unavailable' };
    if (this._snapshotStore && typeof this._snapshotStore.read === 'function') {
      result = await this._snapshotStore.read(beforeHash);
    }
    this._log('INFO', 'workspace_fs.read_pre_change', {
      ...buildPathLogHint(relPath),
      found: result.found === true,
      ...(result.found === true ? {} : { reason: String(result.reason || 'missing') }),
    });
    if (result.found !== true) {
      return { path: relPath, found: false, reason: String(result.reason || 'missing') };
    }
    return { path: relPath, found: true, content: String(result.content ?? '') };
  }

  // Streamed find-in-files over the pinned workspace root; enumeration, byte,
  // result, and deadline budgets live in workspace-ide-search.js.
  async searchInFiles(payload = {}, existingOperation = null) {
    this._activeSearchController?.abort();
    const searchController = new AbortController();
    this._activeSearchController = searchController;
    const query = String(payload.query ?? '');
    try {
      return await this._withRootOperation('read', payload, existingOperation, async (operation) => {
        let scope = '';
        let scopeInvalid = false;
        if (typeof payload.scope === 'string' && payload.scope.trim()) {
          try {
            scope = this._normalizeRelPath(payload.scope);
          } catch (_error) {
            scopeInvalid = true;
          }
        }
        const root = operation.root;
        const ignorePolicy = await resolveWalkIgnorePolicy({
          gitService: this._gitServiceProvider?.(), signal: operation.signal,
          platform: this._platform, extraSkipNames: ['node_modules'],
        });
        const result = await searchWorkspaceFiles({
          root: scopeInvalid ? '' : root.realPath,
          query,
          caseSensitive: payload.caseSensitive === true,
          maxResults: payload.maxResults,
          maxFileBytes: payload.maxFileBytes,
          maxTotalBytes: payload.maxTotalBytes,
          maxFiles: payload.maxFiles,
          maxDirectories: payload.maxDirectories,
          maxEntries: payload.maxEntries,
          maxDurationMs: payload.maxDurationMs,
          scope,
          fs: this._fs,
          path: this._path,
          ignorePolicy,
          resolveDirectory: async (relPath) => {
            await this._rootOperations.revalidateRoot(root, operation);
            if (!relPath) return root.realPath;
            const directory = await this._rootOperations.resolveLeaf(root, relPath, operation);
            return directory.stats?.isDirectory?.() ? directory.realPath : null;
          },
          resolveFile: async (relPath) => {
            const file = await this._rootOperations.resolveLeaf(root, relPath, operation);
            if (!file.stats?.isFile?.()) return null;
            return { filePath: file.operationPath, stats: file.stats, token: file };
          },
          revalidateFile: async (target) => {
            await this._rootOperations.revalidateLeaf(root, target.token, operation);
            return true;
          },
          signal: searchController.signal,
          assertCurrent: () => this._rootOperations.assertCurrent(operation),
          now: this._now,
          onWarning: (reason) => this._log('WARN', 'workspace_fs.search_cleanup_degraded', {
            reason,
          }),
        });
        this._log(result.truncated ? 'WARN' : 'INFO', 'workspace_fs.search', {
          query_length: query.length,
          scoped: Boolean(scope),
          result_count: result.results.length,
          files_scanned: result.filesScanned,
          directories_scanned: result.directoriesScanned,
          entries_scanned: result.entriesScanned,
          limit_hit: result.limitHit,
          ...(result.truncationReason ? { truncation_reason: result.truncationReason } : {}),
        });
        return {
          ...result,
          rootId: operation.context.rootId,
          generation: operation.context.generation,
        };
      });
    } finally {
      if (this._activeSearchController === searchController) {
        this._activeSearchController = null;
      }
    }
  }

  // WIDE-028 (c): suppression records are short-lived one-shot tokens - full
  // stat fingerprint (dev/ino/size/mtime/ctime), consumed on first match
  // attempt, and TTL-expired so a record the watcher never observed (watch
  // stopped, event lost) cannot suppress a genuinely external edit that lands
  // minutes later with the same coarse timestamp.
  _recordRecentWrite(realPath, stats) {
    const now = this._now();
    for (const [existingKey, existing] of this._recentWrites) {
      if (existing.expiresAt <= now) this._recentWrites.delete(existingKey);
    }
    const key = process.platform === 'win32' ? String(realPath).toLowerCase() : String(realPath);
    this._recentWrites.delete(key);
    this._recentWrites.set(key, {
      fingerprint: recentWriteFingerprint(stats),
      expiresAt: now + RECENT_WRITE_TTL_MS,
    });
    while (this._recentWrites.size > RECENT_WRITE_CAP) {
      const oldestKey = this._recentWrites.keys().next().value;
      this._recentWrites.delete(oldestKey);
    }
  }

  consumeRecentWrite(realPath, stats) {
    const key = process.platform === 'win32' ? String(realPath).toLowerCase() : String(realPath);
    const record = this._recentWrites.get(key);
    if (!record) return false;
    this._recentWrites.delete(key);
    if (record.expiresAt <= this._now()) return false;
    return sameRecentWrite(record.fingerprint, recentWriteFingerprint(stats));
  }

  clearRecentWrites() {
    this._recentWrites.clear();
  }
}

module.exports = {
  WorkspaceIdeService,
};
