'use strict';

const fsPromises = require('node:fs/promises');
const nodePath = require('node:path');

const { WORKSPACE_FS_ERROR_CODES, workspaceFsError } = require('./workspace-ide-errors');

function statValue(stats, key) {
  const value = stats?.[key];
  return typeof value === 'bigint' ? value.toString() : String(value ?? '');
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  return statValue(left, 'dev') === statValue(right, 'dev')
    && statValue(left, 'ino') === statValue(right, 'ino')
    && Boolean(left.isFile?.()) === Boolean(right.isFile?.())
    && Boolean(left.isDirectory?.()) === Boolean(right.isDirectory?.())
    && Boolean(left.isSymbolicLink?.()) === Boolean(right.isSymbolicLink?.());
}

class WorkspaceRootOperationManager {
  constructor({
    rootContextProvider = null,
    fs = fsPromises,
    path = nodePath,
    platform = process.platform,
    hooks = null,
  } = {}) {
    this._rootContextProvider = typeof rootContextProvider === 'function'
      ? rootContextProvider
      : () => null;
    this._fs = fs;
    this._path = path;
    this._platform = String(platform || process.platform);
    this._hooks = hooks && typeof hooks === 'object' ? hooks : {};
    this._owned = new WeakSet();
  }

  _rootTransitionError(reason) {
    return workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING,
      'The workspace root is changing; retry after the transition completes.',
      { reason: String(reason || 'root_transitioning') }
    );
  }

  _rootInvalidError(reason) {
    return workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.ROOT_INVALID,
      'The configured workspace folder is no longer safe to use; choose it again.',
      { reason: String(reason || 'root_unavailable') }
    );
  }

  _rootMissingError() {
    return workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.ROOT_MISSING,
      'No workspace root is configured; choose a workspace folder first.'
    );
  }

  _staleGenerationError(expectedGeneration, currentGeneration) {
    return workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.STALE_GENERATION,
      'The operation belongs to an older workspace generation; retry from the current workspace.',
      {
        expected_generation: expectedGeneration,
        current_generation: currentGeneration,
      }
    );
  }

  _outsideError(reason) {
    return workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.PATH_OUTSIDE_ROOT,
      'Path resolves outside the workspace root.',
      { reason: String(reason || 'path_outside_root') }
    );
  }

  _notFoundError(reason) {
    return workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.NOT_FOUND,
      'File or folder not found in the workspace.',
      { reason: String(reason || 'not_found') }
    );
  }

  _pathComparable(value) {
    const resolved = this._path.resolve(String(value || ''));
    return this._platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  _samePath(left, right) {
    return this._pathComparable(left) === this._pathComparable(right);
  }

  _isInside(rootPath, targetPath) {
    const relative = this._path.relative(rootPath, targetPath);
    if (!relative) return true;
    return relative !== '..'
      && !relative.startsWith(`..${this._path.sep}`)
      && !this._path.isAbsolute(relative);
  }

  owns(operation) {
    return Boolean(operation && this._owned.has(operation));
  }

  acquire({ kind = 'read', expectedGeneration = null } = {}) {
    let coordinator;
    try {
      coordinator = this._rootContextProvider();
    } catch (_error) {
      throw this._rootTransitionError('root_context_unavailable');
    }
    if (!coordinator || typeof coordinator.acquireOperation !== 'function') {
      throw this._rootTransitionError('root_context_unavailable');
    }

    let lease;
    try {
      lease = coordinator.acquireOperation({
        kind: kind === 'mutation' ? 'mutation' : 'read',
        cancellable: kind !== 'mutation',
      });
    } catch (_error) {
      throw this._rootTransitionError('lease_unavailable');
    }
    if (!lease || lease.acquired !== true) {
      throw this._rootTransitionError(lease?.code || 'root_transitioning');
    }

    let released = false;
    const release = () => {
      if (released) return false;
      released = true;
      try {
        lease.release?.();
      } catch (_error) {
        // The manager still considers the local lease released. Coordinator
        // release is specified as idempotent and must not escape this boundary.
      }
      return true;
    };
    const context = lease.context;
    const failAfterAcquire = (error) => {
      release();
      throw error;
    };
    if (context && !String(context.rootPath || '') && context.rootId == null) {
      return failAfterAcquire(this._rootMissingError());
    }
    if (!context || context.phase !== 'ready'
      || !this._path.isAbsolute(String(context.rootPath || ''))
      || !String(context.rootId || '')
      || !Number.isSafeInteger(context.generation)) {
      return failAfterAcquire(this._rootTransitionError('root_context_invalid'));
    }
    if (expectedGeneration !== null && expectedGeneration !== undefined) {
      if (!Number.isSafeInteger(expectedGeneration)
        || expectedGeneration < 0
        || context.generation !== expectedGeneration) {
        return failAfterAcquire(this._staleGenerationError(expectedGeneration, context.generation));
      }
    }
    const operation = {
      acquired: true,
      context,
      signal: lease.signal || null,
      root: null,
      isCurrent: () => {
        if (released || operation.signal?.aborted === true) return false;
        try {
          return lease.isCurrent?.() === true;
        } catch (_error) {
          return false;
        }
      },
      release,
    };
    this._owned.add(operation);
    return operation;
  }

  assertCurrent(operation) {
    if (!this.owns(operation)) throw this._rootTransitionError('operation_invalid');
    let current;
    try {
      current = operation.isCurrent() === true;
    } catch (_error) {
      current = false;
    }
    if (!current) {
      throw this._rootTransitionError(
        operation.signal?.aborted ? 'operation_cancelled' : 'root_changed'
      );
    }
  }

  async _step(operation, callback) {
    this.assertCurrent(operation);
    const result = await callback();
    this.assertCurrent(operation);
    return result;
  }

  async runHook(name, payload, operation) {
    const hook = this._hooks[name];
    if (typeof hook !== 'function') return;
    this.assertCurrent(operation);
    await hook(payload);
    this.assertCurrent(operation);
  }

  async prepareRoot(operation) {
    const configuredPath = String(operation?.context?.rootPath || '');
    let realPath;
    let lexicalStats;
    let stats;
    try {
      lexicalStats = await this._step(operation, () => this._fs.lstat(configuredPath));
      realPath = await this._step(operation, () => this._fs.realpath(configuredPath));
      stats = await this._step(operation, () => this._fs.stat(realPath));
    } catch (error) {
      if (String(error?.code || '').startsWith('CMP-')) throw error;
      throw this._rootInvalidError('root_unavailable');
    }
    if (!stats.isDirectory()) throw this._rootInvalidError('root_not_directory');
    const root = { configuredPath, realPath, lexicalStats, stats };
    operation.root = root;
    return root;
  }

  async revalidateRoot(root, operation) {
    let currentRealPath;
    let currentLexicalStats;
    let currentStats;
    try {
      currentLexicalStats = await this._step(operation, () => this._fs.lstat(root.configuredPath));
      currentRealPath = await this._step(operation, () => this._fs.realpath(root.configuredPath));
      currentStats = await this._step(operation, () => this._fs.stat(currentRealPath));
    } catch (error) {
      if (String(error?.code || '').startsWith('CMP-')) throw error;
      throw this._rootInvalidError('root_unavailable');
    }
    if (!this._samePath(currentRealPath, root.realPath)
      || !sameFileIdentity(root.lexicalStats, currentLexicalStats)
      || !currentStats.isDirectory()
      || !sameFileIdentity(root.stats, currentStats)) {
      throw this._rootInvalidError('root_identity_changed');
    }
  }

  async _lstatOrNull(targetPath, operation) {
    try {
      return await this._step(operation, () => this._fs.lstat(targetPath));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async _inspectDirectory(root, lexicalPath, operation) {
    const lexicalStats = await this._lstatOrNull(lexicalPath, operation);
    if (!lexicalStats) return null;
    let realPath;
    let stats;
    try {
      realPath = await this._step(operation, () => this._fs.realpath(lexicalPath));
      stats = await this._step(operation, () => this._fs.stat(realPath));
    } catch (error) {
      if (String(error?.code || '').startsWith('CMP-')) throw error;
      throw this._rootInvalidError('parent_unavailable');
    }
    if (!this._isInside(root.realPath, realPath)) throw this._outsideError('parent_outside_root');
    if (!stats.isDirectory()) throw this._rootInvalidError('parent_not_directory');
    return { lexicalPath, realPath, lexicalStats, stats };
  }

  async revalidateParent(root, parent, operation) {
    await this.revalidateRoot(root, operation);
    const current = await this._inspectDirectory(root, parent.lexicalPath, operation);
    if (!current
      || !this._samePath(current.realPath, parent.realPath)
      || !sameFileIdentity(current.lexicalStats, parent.lexicalStats)
      || !sameFileIdentity(current.stats, parent.stats)) {
      throw this._rootInvalidError('parent_identity_changed');
    }
  }

  async ensureParent(root, relPath, operation, { createMissing = false } = {}) {
    const segments = String(relPath || '').split('/');
    const parentSegments = segments.slice(0, -1);
    let parent = {
      lexicalPath: root.configuredPath,
      realPath: root.realPath,
      lexicalStats: root.lexicalStats,
      stats: root.stats,
    };
    for (const segment of parentSegments) {
      await this.revalidateParent(root, parent, operation);
      const candidate = this._path.join(parent.realPath, segment);
      let next = await this._inspectDirectory(root, candidate, operation);
      if (!next && createMissing) {
        await this.runHook('beforeParentCreate', {
          operation,
          root,
          parent,
          path: candidate,
          segment,
        }, operation);
        await this.revalidateParent(root, parent, operation);
        try {
          await this._step(operation, () => this._fs.mkdir(candidate));
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
        next = await this._inspectDirectory(root, candidate, operation);
      }
      if (!next) throw this._notFoundError('parent_missing');
      await this.revalidateParent(root, next, operation);
      parent = next;
    }
    return parent;
  }

  async resolveLeaf(root, relPath, operation, {
    createParents = false,
    allowMissing = false,
    preserveLeaf = false,
  } = {}) {
    const segments = String(relPath || '').split('/');
    const leafName = segments[segments.length - 1];
    const parent = await this.ensureParent(root, relPath, operation, { createMissing: createParents });
    const lexicalPath = this._path.join(parent.realPath, leafName);
    const lexicalStats = await this._lstatOrNull(lexicalPath, operation);
    if (!lexicalStats) {
      if (!allowMissing) throw this._notFoundError('leaf_missing');
      const containmentPath = /^[A-Za-z]:[\\/]/.test(leafName)
        ? this._path.join(parent.realPath, leafName.replace(':', '_')) : lexicalPath;
      if (!this._isInside(root.realPath, containmentPath)) {
        throw this._outsideError('leaf_outside_root');
      }
      return {
        relPath,
        parent,
        lexicalPath,
        operationPath: lexicalPath,
        realPath: lexicalPath,
        lexicalStats: null,
        stats: null,
        preserveLeaf,
      };
    }
    if (preserveLeaf && lexicalStats.isSymbolicLink?.()) {
      return {
        relPath,
        parent,
        lexicalPath,
        operationPath: lexicalPath,
        realPath: lexicalPath,
        lexicalStats,
        stats: lexicalStats,
        preserveLeaf: true,
      };
    }
    let realPath;
    let stats;
    try {
      realPath = await this._step(operation, () => this._fs.realpath(lexicalPath));
      stats = await this._step(operation, () => this._fs.stat(realPath));
    } catch (error) {
      if (String(error?.code || '').startsWith('CMP-')) throw error;
      throw this._notFoundError('leaf_unavailable');
    }
    if (!this._isInside(root.realPath, realPath)) throw this._outsideError('leaf_outside_root');
    return {
      relPath,
      parent,
      lexicalPath,
      operationPath: realPath,
      realPath,
      lexicalStats,
      stats,
      preserveLeaf: false,
    };
  }

  async revalidateLeaf(root, leaf, operation) {
    await this.revalidateParent(root, leaf.parent, operation);
    const currentLexicalStats = await this._lstatOrNull(leaf.lexicalPath, operation);
    if (!leaf.lexicalStats) {
      if (currentLexicalStats) return { exists: true, currentLexicalStats };
      return { exists: false, currentLexicalStats: null };
    }
    if (!currentLexicalStats || !sameFileIdentity(leaf.lexicalStats, currentLexicalStats)) {
      throw this._rootInvalidError('leaf_identity_changed');
    }
    if (leaf.preserveLeaf) return { exists: true, currentLexicalStats };
    let currentRealPath;
    let currentStats;
    try {
      currentRealPath = await this._step(operation, () => this._fs.realpath(leaf.lexicalPath));
      currentStats = await this._step(operation, () => this._fs.stat(currentRealPath));
    } catch (error) {
      if (String(error?.code || '').startsWith('CMP-')) throw error;
      throw this._rootInvalidError('leaf_identity_changed');
    }
    if (!this._isInside(root.realPath, currentRealPath)
      || !this._samePath(currentRealPath, leaf.realPath)
      || !sameFileIdentity(leaf.stats, currentStats)) {
      throw this._rootInvalidError('leaf_identity_changed');
    }
    return { exists: true, currentLexicalStats, currentRealPath, currentStats };
  }
}

module.exports = {
  WorkspaceRootOperationManager,
  sameFileIdentity,
};
