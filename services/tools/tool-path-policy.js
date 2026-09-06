'use strict';

const { TOOL_ERROR_CODES } = require('../backend/error-codes');

const TOOL_DISABLED_CODE = TOOL_ERROR_CODES.DISABLED;

class ToolPathPolicyError extends Error {
  constructor(message, { code = TOOL_DISABLED_CODE, retryable = false } = {}) {
    super(message);
    this.name = 'ToolPathPolicyError';
    this.code = code;
    this.retryable = retryable;
  }
}

function normalizeWorkingDirectory(context) {
  const raw = context && typeof context === 'object' ? context.workingDirectory : undefined;
  const normalized = typeof raw === 'string' ? raw.trim() : raw;
  return normalized || null;
}

function requireWorkingDirectory(context) {
  const normalized = normalizeWorkingDirectory(context);
  if (!normalized) {
    throw new ToolPathPolicyError(
      'tools workspace root is not configured; filesystem tools are blocked'
    );
  }
  return normalized;
}

class ToolPathPolicy {
  constructor({ fs, path }) {
    this._fs = fs;
    this._path = path;
  }

  resolvePath(requestedPath, context) {
    const workingDirectory = requireWorkingDirectory(context);
    if (!requestedPath) {
      throw new Error('Path is required');
    }
    const p = this._path;
    const resolved = p.isAbsolute(requestedPath)
      ? p.resolve(requestedPath)
      : p.resolve(workingDirectory, requestedPath);
    return resolved;
  }

  async assertInsideRoot(resolvedPath, context) {
    const workingDirectory = requireWorkingDirectory(context);
    const fs = this._fs;
    const p = this._path;
    const rootReal = await this._realpathSafe(workingDirectory);

    let targetReal;
    try {
      targetReal = await fs.realpath(resolvedPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        targetReal = await this._realpathForNewPath(resolvedPath);
      } else {
        throw error;
      }
    }

    const rootNorm = this._normalizeForComparison(rootReal);
    const targetNorm = this._normalizeForComparison(targetReal);
    const sepLower = p.sep.toLowerCase();
    const prefix = rootNorm.endsWith(sepLower) ? rootNorm : rootNorm + sepLower;

    if (targetNorm !== rootNorm && !targetNorm.startsWith(prefix)) {
      throw new Error(
        `Path "${resolvedPath}" resolves outside the working directory "${workingDirectory}"`
      );
    }

    return targetReal;
  }

  async _realpathSafe(targetPath) {
    try {
      return await this._fs.realpath(targetPath);
    } catch {
      return this._path.resolve(targetPath);
    }
  }

  async _realpathForNewPath(targetPath) {
    const p = this._path;
    const fs = this._fs;
    let current = targetPath;
    const trailing = [];

    while (current !== p.dirname(current)) {
      try {
        const real = await fs.realpath(current);
        let result = real;
        for (let i = trailing.length - 1; i >= 0; i--) {
          result = p.join(result, trailing[i]);
        }
        return result;
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          trailing.push(p.basename(current));
          current = p.dirname(current);
          continue;
        }
        throw error;
      }
    }

    return targetPath;
  }

  _normalizeForComparison(filePath) {
    const normalized = this._path.resolve(filePath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }
}

module.exports = {
  ToolPathPolicy,
  TOOL_DISABLED_CODE,
  normalizeWorkingDirectory,
};
