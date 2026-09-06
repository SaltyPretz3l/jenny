const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeString } = require('../../renderer/shared/string-utils');

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function buildSandboxLayout(rootPath) {
  const basePath = rootPath || path.join(os.tmpdir(), 'jenny-shell-backend');

  return {
    rootPath: basePath,
    installPath: path.join(basePath, 'install'),
    localAppDataPath: path.join(basePath, 'localappdata'),
    runtimePath: path.join(basePath, 'runtime'),
    logsPath: path.join(basePath, 'logs'),
    stateFilePath: path.join(basePath, 'sidecar-state.json'),
  };
}

function ensureSandboxLayout(layout) {
  ensureDir(layout.rootPath);
  ensureDir(layout.installPath);
  ensureDir(layout.localAppDataPath);
  ensureDir(layout.runtimePath);
  ensureDir(layout.logsPath);
  return layout;
}

function resolveExistingRealPath(targetPath) {
  const normalized = String(targetPath || '').trim();
  if (!normalized) {
    return '';
  }
  if (fs.realpathSync.native) {
    return fs.realpathSync.native(normalized);
  }
  return fs.realpathSync(normalized);
}

function resolveRealPathSafe(targetPath) {
  const normalized = String(targetPath || '').trim();
  if (!normalized) {
    return '';
  }
  try {
    return resolveExistingRealPath(normalized);
  } catch (_error) {
    return path.resolve(normalized);
  }
}

function resolveRealPathForNewPath(targetPath) {
  const normalized = String(targetPath || '').trim();
  if (!normalized) {
    return '';
  }

  let current = path.resolve(normalized);
  const trailing = [];
  while (current !== path.dirname(current)) {
    try {
      const real = resolveExistingRealPath(current);
      if (real) {
        let rebuilt = real;
        for (let index = trailing.length - 1; index >= 0; index -= 1) {
          rebuilt = path.join(rebuilt, trailing[index]);
        }
        return rebuilt;
      }
    } catch (_error) {
      // Fall through to parent traversal.
    }
    trailing.push(path.basename(current));
    current = path.dirname(current);
  }

  return path.resolve(normalized);
}

function isChildPath(root, filePath) {
  const resolvedRoot = resolveRealPathSafe(root);
  const resolved = resolveRealPathForNewPath(filePath);
  const rel = path.relative(resolvedRoot, resolved);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function clipText(value, maxLength = 180) {
  const normalized = normalizeString(value).replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trim()}...`
    : normalized;
}

module.exports = {
  buildSandboxLayout,
  clipText,
  ensureDir,
  ensureSandboxLayout,
  isChildPath,
  normalizeString,
  resolveRealPathSafe,
};
