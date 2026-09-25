'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_PATH_CHARS = 32 * 1024;
const physicalIdentities = new WeakSet();

function positiveIntegerToken(value) {
  if (typeof value === 'bigint') {
    const token = value > 0n ? String(value) : '';
    return token.length <= 128 ? token : null;
  }
  if (Number.isSafeInteger(value)) return value > 0 ? String(value) : null;
  if (typeof value === 'string' && value.length <= 128 && /^[1-9]\d*$/u.test(value)) return value;
  return null;
}

function missingPathError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function normalizeComparisonPath(value, { pathImpl, platform }) {
  let normalized = pathImpl.normalize(value).replaceAll('\\', '/');
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/u, '');
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

class PhysicalPathResolver {
  constructor({ fsImpl = fs, pathImpl = null, platform = process.platform } = {}) {
    this._fs = fsImpl;
    this._platform = platform === 'win32' ? 'win32' : 'posix';
    this._path = pathImpl || (this._platform === 'win32' ? path.win32 : path.posix);
    if (typeof this._fs.realpathSync !== 'function' || typeof this._fs.statSync !== 'function'
      || typeof this._fs.lstatSync !== 'function' || typeof this._fs.readlinkSync !== 'function') {
      throw new TypeError('PhysicalPathResolver requires realpath, stat, lstat, and readlink support.');
    }
  }

  _realpath(value) {
    const resolver = typeof this._fs.realpathSync.native === 'function'
      ? this._fs.realpathSync.native.bind(this._fs.realpathSync)
      : this._fs.realpathSync.bind(this._fs);
    return this._path.resolve(String(resolver(value)));
  }

  _resolveMissing(absolutePath, seenLinks = new Set()) {
    const suffix = [];
    let ancestor = absolutePath;
    while (true) {
      try {
        const lexical = this._fs.lstatSync(ancestor);
        if (typeof lexical.isSymbolicLink !== 'function' || !lexical.isSymbolicLink()) {
          throw new Error('Existing unresolved filesystem resource is not a supported link.');
        }
        const linkKey = normalizeComparisonPath(ancestor, {
          pathImpl: this._path, platform: this._platform,
        });
        if (seenLinks.has(linkKey)) throw new Error('Filesystem resource link cycle detected.');
        seenLinks.add(linkKey);
        const linkTarget = String(this._fs.readlinkSync(ancestor));
        if (!linkTarget) throw new Error('Filesystem resource link target is invalid.');
        const resolvedTarget = this._path.isAbsolute(linkTarget)
          ? this._path.resolve(linkTarget)
          : this._path.resolve(this._path.dirname(ancestor), linkTarget);
        const targetWithSuffix = this._path.resolve(resolvedTarget, ...suffix);
        try {
          return this._realpath(targetWithSuffix);
        } catch (error) {
          if (!missingPathError(error)) throw error;
          return this._resolveMissing(targetWithSuffix, seenLinks);
        }
      } catch (error) {
        if (!missingPathError(error)) throw error;
      }
      const parent = this._path.dirname(ancestor);
      if (parent === ancestor) throw new Error('No existing parent is available for the target path.');
      suffix.unshift(this._path.basename(ancestor));
      ancestor = parent;
      try {
        const resolvedParent = this._realpath(ancestor);
        return this._path.resolve(resolvedParent, ...suffix);
      } catch (error) {
        if (!missingPathError(error)) throw error;
      }
    }
  }

  resolve(targetPath, { allowMissing = true } = {}) {
    const requested = typeof targetPath === 'string' ? targetPath.trim() : '';
    if (!requested || requested.length > MAX_PATH_CHARS) {
      throw new Error('Filesystem resource path is invalid.');
    }
    const absolutePath = this._path.resolve(requested);
    let resolvedPath;
    let exists = true;
    try {
      resolvedPath = this._realpath(absolutePath);
    } catch (error) {
      if (!allowMissing || !missingPathError(error)) throw error;
      exists = false;
      resolvedPath = this._resolveMissing(absolutePath);
    }
    if (!resolvedPath || resolvedPath.length > MAX_PATH_CHARS) {
      throw new Error('Resolved filesystem resource path is invalid.');
    }
    let deviceId = null;
    let inode = null;
    let isDirectory = false;
    if (exists) {
      const stat = this._fs.statSync(resolvedPath, { bigint: true });
      deviceId = positiveIntegerToken(stat.dev);
      inode = positiveIntegerToken(stat.ino);
      if (!deviceId || !inode) {
        deviceId = null;
        inode = null;
      }
      isDirectory = typeof stat.isDirectory === 'function' && stat.isDirectory();
    }
    const comparisonPath = normalizeComparisonPath(resolvedPath, {
      pathImpl: this._path,
      platform: this._platform,
    });
    const identityKey = deviceId && inode
      ? `filesystem:${comparisonPath}:inode:${deviceId}:${inode}`
      : `filesystem:${comparisonPath}:path-only`;
    const identity = Object.freeze({
      type: 'filesystem',
      requested_path: absolutePath,
      resolved_path: resolvedPath,
      comparison_path: comparisonPath,
      device_id: deviceId,
      inode,
      exists,
      is_directory: isDirectory,
      identity_key: identityKey,
      identity_complete: Boolean(deviceId && inode),
    });
    physicalIdentities.add(identity);
    return identity;
  }

  resolveMany(paths, options = {}) {
    if (!Array.isArray(paths)) throw new TypeError('Filesystem resource paths must be an array.');
    return paths.map((value) => this.resolve(value, options));
  }
}

function physicalPathsConflict(left, right) {
  if (!left || !right || left.type !== 'filesystem' || right.type !== 'filesystem') return false;
  if (left.device_id && left.inode && right.device_id && right.inode
    && left.device_id === right.device_id && left.inode === right.inode) {
    return true;
  }
  const leftPath = String(left.comparison_path || '');
  const rightPath = String(right.comparison_path || '');
  if (!leftPath || !rightPath) return true;
  const within = (parent, child) => child.startsWith(
    parent.endsWith('/') ? parent : `${parent}/`
  );
  return leftPath === rightPath || within(leftPath, rightPath) || within(rightPath, leftPath);
}

function isPhysicalPathIdentity(value) {
  return physicalIdentities.has(value);
}

function createPhysicalPathResolver(options) {
  return new PhysicalPathResolver(options);
}

module.exports = {
  MAX_PATH_CHARS,
  PhysicalPathResolver,
  createPhysicalPathResolver,
  isPhysicalPathIdentity,
  normalizeComparisonPath,
  physicalPathsConflict,
  positiveIntegerToken,
};
