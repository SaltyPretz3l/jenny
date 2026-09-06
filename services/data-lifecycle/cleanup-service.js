'use strict';

const fs = require('fs');
const path = require('path');

const KNOWN_RUNTIME_CHILDREN = Object.freeze([
  'background-memory',
  'logs',
  'jenny_memory.db',
  'memory.db',
  'sidecar.log',
]);

const KNOWN_USER_DATA_CHILDREN = Object.freeze([
  '.jenny',
  'attachments',
  'backend-sidecar',
  'background-memory',
  'blob_storage',
  'Cache',
  'Code Cache',
  'Cookies',
  'Cookies-journal',
  'cost-tracker.json',
  'Crashpad',
  'data-lifecycle',
  'databases',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'diagnostics',
  'Dictionary',
  'disabled-startup-shortcuts',
  'GPUCache',
  'GrShaderCache',
  'home-calendar.json',
  'IndexedDB',
  'knowledge.json',
  'llama-server.pid',
  'Local State',
  'Local Storage',
  'logs',
  'mcp-servers.json',
  'model-recommendation-catalog.json',
  'model-recommendation-catalog.json.meta.json',
  'Network',
  'Network Persistent State',
  'ollama-process.json',
  'personality',
  'plugins',
  'Preferences',
  'QuotaManager',
  'QuotaManager-journal',
  'secure-state.json',
  'session-shadow.json',
  'Session Storage',
  'sessions',
  'sessions.json',
  'Shared Dictionary',
  'SharedStorage',
  'SharedStorage-wal',
  'shell-config.json',
  'sidecar-memory.db',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'terminal-repairs.json',
  'tool-permissions.json',
  'TransportSecurity',
  'Trust Tokens',
  'Trust Tokens-journal',
  'turn-event-journal.json',
  'update-state.json',
  'usage-history.json',
  'VideoDecodeStats',
  'vllm-process.json',
  'WebStorage',
  'window-state.json',
  'workspace-snapshots',
]);

function safeLstat(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function boundedFsReason(error, fallback = 'inspection_failed') {
  return String(error?.code || fallback).slice(0, 64);
}

function cleanupResult(target, status, reason = '') {
  return {
    kind: String(target?.kind || '').slice(0, 48),
    name: String(target?.name || (target?.kind === 'workspace_metadata' ? '.jenny' : '')).slice(0, 160),
    status,
    ...(reason ? { reason } : {}),
  };
}

function buildCleanupTargets({ userDataPath, runtimePath = '', workspaceRoot = '', removeWorkspaceData = false, includeUserData = true } = {}) {
  if (includeUserData && !String(userDataPath || '').trim()) {
    throw new TypeError('buildCleanupTargets requires userDataPath.');
  }
  const targets = [];
  if (includeUserData) {
    const root = path.resolve(userDataPath);
    if (root === path.parse(root).root) {
      throw new TypeError('Jenny user data cannot be a filesystem root.');
    }
    for (const name of KNOWN_USER_DATA_CHILDREN) {
      const targetPath = path.join(root, name);
      if (fs.existsSync(targetPath)) {
        targets.push({ kind: 'user_data_child', root, name, path: targetPath });
      }
    }
  }
  if (runtimePath) {
    const root = path.resolve(runtimePath);
    for (const name of KNOWN_RUNTIME_CHILDREN) {
      targets.push({ kind: 'runtime_child', root, name, path: path.join(root, name) });
    }
  }
  if (removeWorkspaceData && workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    targets.push({ kind: 'workspace_metadata', root, path: path.join(root, '.jenny') });
  }
  return targets;
}

function validateCleanupTarget(target) {
  const resolved = path.resolve(String(target?.path || ''));
  if (!resolved || resolved === path.parse(resolved).root) return false;
  const root = path.resolve(String(target.root || ''));
  if (!root || root === path.parse(root).root) return false;
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  if (target.kind === 'runtime_child') {
    return KNOWN_RUNTIME_CHILDREN.includes(target.name) && relative === target.name;
  }
  if (target.kind === 'user_data_child') {
    return KNOWN_USER_DATA_CHILDREN.includes(target.name) && relative === target.name;
  }
  return target.kind === 'workspace_metadata' && relative === '.jenny';
}

function hasUnsafeDescendant(rootPath, limit = 100_000) {
  const queue = [rootPath];
  let visited = 0;
  while (queue.length) {
    const current = queue.shift();
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      visited += 1;
      if (visited > limit || dirent.isSymbolicLink()) return true;
      if (dirent.isDirectory()) queue.push(path.join(current, dirent.name));
    }
  }
  return false;
}

function validateExistingCleanupTarget(target, stat) {
  if (stat.isSymbolicLink()) return false;
  if (target.root) {
    const rootStat = safeLstat(target.root);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return false;
    const realRoot = fs.realpathSync.native(target.root);
    const realTarget = fs.realpathSync.native(target.path);
    const relative = path.relative(realRoot, realTarget);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  }
  return !stat.isDirectory() || !hasUnsafeDescendant(target.path);
}

function listUnknownRuntimeChildren(runtimePath) {
  if (!runtimePath || !fs.existsSync(runtimePath)) return [];
  const rootStat = safeLstat(runtimePath);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return [];
  const known = new Set(KNOWN_RUNTIME_CHILDREN.map((name) => name.toLocaleLowerCase('en-US')));
  return fs.readdirSync(runtimePath)
    .filter((name) => !known.has(name.toLocaleLowerCase('en-US')))
    .sort();
}

function listUnknownUserDataChildren(userDataPath) {
  if (!userDataPath || !fs.existsSync(userDataPath)) return [];
  const rootStat = safeLstat(userDataPath);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return [];
  const known = new Set(KNOWN_USER_DATA_CHILDREN.map((name) => name.toLocaleLowerCase('en-US')));
  return fs.readdirSync(userDataPath)
    .filter((name) => !known.has(name.toLocaleLowerCase('en-US')))
    .sort();
}

async function cleanupJennyData(options = {}) {
  const targets = buildCleanupTargets(options);
  const results = [];
  for (const target of targets) {
    if (!validateCleanupTarget(target)) {
      results.push(cleanupResult(target, 'retained', 'unsafe_target'));
      continue;
    }
    try {
      const stat = safeLstat(target.path);
      if (!stat) {
        results.push(cleanupResult(target, 'absent'));
        continue;
      }
      if (!validateExistingCleanupTarget(target, stat)) {
        results.push(cleanupResult(target, 'retained', 'reparse_or_symlink'));
        continue;
      }
      await fs.promises.rm(target.path, { recursive: stat.isDirectory(), force: true });
      results.push(cleanupResult(target, 'removed'));
    } catch (error) {
      results.push(cleanupResult(target, 'retained', boundedFsReason(error, 'remove_failed')));
    }
  }
  let unknownRuntimeChildren = [];
  let unknownUserDataChildren = [];
  try {
    unknownRuntimeChildren = listUnknownRuntimeChildren(options.runtimePath);
  } catch (error) {
    results.push(cleanupResult({ kind: 'runtime_inventory', name: '.companion' }, 'retained', boundedFsReason(error)));
  }
  try {
    unknownUserDataChildren = listUnknownUserDataChildren(options.userDataPath);
  } catch (error) {
    results.push(cleanupResult({ kind: 'profile_inventory', name: 'Jenny profile' }, 'retained', boundedFsReason(error)));
  }
  if (
    !results.some((entry) => entry.status === 'retained')
    && unknownUserDataChildren.length === 0
    && options.includeUserData !== false
  ) {
    try {
      await fs.promises.rmdir(path.resolve(options.userDataPath));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        results.push(cleanupResult({ kind: 'profile_root', name: 'Jenny profile' }, 'retained', boundedFsReason(error)));
      }
    }
  }
  const incomplete = results.some((entry) => entry.status === 'retained');
  const warnings = [];
  if (unknownRuntimeChildren.length) warnings.push(`Retained ${unknownRuntimeChildren.length} unknown runtime item(s).`);
  if (unknownUserDataChildren.length) warnings.push(`Retained ${unknownUserDataChildren.length} unknown profile item(s).`);
  return {
    ok: !incomplete,
    status: incomplete ? 'incomplete' : 'complete',
    results,
    warnings,
    unknownRuntimeChildren,
    unknownUserDataChildren,
  };
}

module.exports = {
  KNOWN_USER_DATA_CHILDREN,
  KNOWN_RUNTIME_CHILDREN,
  buildCleanupTargets,
  cleanupJennyData,
  validateCleanupTarget,
};
