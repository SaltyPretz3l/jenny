'use strict';

const fs = require('fs');
const path = require('path');

const { parsePreservedCorruptName } = require('../backend/corrupt-file-preserve');
const { WORKSPACE_PORTABLE_NAMES } = require('./data-inventory');

const MAX_RETAINED_WORKSPACE_CHILDREN = 50;
const KNOWN_RUNTIME_CHILDREN = Object.freeze([
  'background-memory',
  'logs',
  'jenny_memory.db',
  'memory.db',
  'ollama-catalog.json',
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
  'engines',
  'GPUCache',
  'GrShaderCache',
  'home-ai-journal.json',
  'home-calendar.json',
  'image-engine-scratch',
  'image-engine.pid',
  'image-engine.pid.tmp',
  'image-models.json',
  'image-models.json.part',
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
  'ollama-catalog.json',
  'ollama-process.json',
  'personality',
  'plugins',
  'Preferences',
  'project-delete-operations.json',
  'project-notes',
  'projects.json',
  'QuotaManager',
  'QuotaManager-journal',
  'secure-state.json',
  'session-runtime',
  'session-runtime-budgets',
  'session-runtime-lineage',
  'session-runtime-checkpoints',
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
  'todo-lists',
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

const SESSION_MIGRATION_BACKUP_NAME = /^sessions\.json\.migrated-\d{10,16}$/;
const ATOMIC_WRITE_TEMP_NAME = /^(.+)\.\d{10,16}\.[0-9a-f]{12}\.tmp$/;

// Leftovers Jenny's own writers create beside a known profile file: the
// preserved damaged copy of a store (`<known>.corrupt-<ms>`), the pre-split
// session backup, and an atomic-write temp orphaned by a crash. Exact name
// contracts only; the caller also requires a regular file.
function isOwnedDerivedName(name) {
  const text = String(name || '');
  const corruptBase = parsePreservedCorruptName(text)?.baseName;
  if (corruptBase && KNOWN_USER_DATA_CHILDREN.includes(corruptBase)) return true;
  if (SESSION_MIGRATION_BACKUP_NAME.test(text)) return true;
  const tempBase = ATOMIC_WRITE_TEMP_NAME.exec(text)?.[1];
  return Boolean(tempBase) && KNOWN_USER_DATA_CHILDREN.includes(tempBase);
}

function listOwnedDerivedFiles(userDataPath) {
  if (!fs.existsSync(userDataPath)) return [];
  return fs.readdirSync(userDataPath, { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && isOwnedDerivedName(dirent.name))
    .map((dirent) => dirent.name)
    .sort();
}

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

// Workspace caches that go when the archived workspace data goes but are never
// part of the archive: the omission store (`.jenny/omissions/`), redacted tool
// output with its own expiry.
const WORKSPACE_PURGE_ONLY_NAMES = Object.freeze(['omissions']);
const WORKSPACE_CHILD_KINDS = Object.freeze({
  workspace_archived_child: WORKSPACE_PORTABLE_NAMES,
  workspace_cache_child: WORKSPACE_PURGE_ONLY_NAMES,
});

// Only the exact string 'all' selects whole-.jenny removal. Anything else,
// including a missing value, removes just the children the workspace archive
// carries (WORKSPACE_PORTABLE_NAMES) and the purge-only caches.
function buildCleanupTargets({
  userDataPath,
  runtimePath = '',
  workspaceRoot = '',
  removeWorkspaceData = false,
  workspaceRemovalScope = 'archived',
  includeUserData = true,
} = {}) {
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
    for (const name of listOwnedDerivedFiles(root)) {
      targets.push({ kind: 'user_data_derived_child', root, name, path: path.join(root, name) });
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
    if (workspaceRemovalScope === 'all') {
      targets.push({ kind: 'workspace_metadata', root, path: path.join(root, '.jenny') });
    } else {
      const metadataRoot = path.join(root, '.jenny');
      for (const [kind, names] of Object.entries(WORKSPACE_CHILD_KINDS)) {
        for (const name of names) {
          const targetPath = path.join(metadataRoot, name);
          if (fs.existsSync(targetPath)) {
            targets.push({ kind, root: metadataRoot, name, path: targetPath });
          }
        }
      }
    }
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
  if (target.kind === 'user_data_derived_child') {
    return isOwnedDerivedName(target.name) && relative === target.name;
  }
  if (Object.hasOwn(WORKSPACE_CHILD_KINDS, target.kind)) {
    return WORKSPACE_CHILD_KINDS[target.kind].includes(target.name)
      && relative === target.name
      && path.basename(root) === '.jenny';
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
  if (target.kind === 'user_data_derived_child' && !stat.isFile()) return false;
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
  const owned = new Set(listOwnedDerivedFiles(userDataPath));
  return fs.readdirSync(userDataPath)
    .filter((name) => !known.has(name.toLocaleLowerCase('en-US')) && !owned.has(name))
    .sort();
}

// After an archived-scope removal, drop .jenny only when nothing else is in it.
// Returns the names that were deliberately kept (never reported as retained
// results: they were not part of the archive, so keeping them is not a failure).
async function finishArchivedWorkspaceRemoval(workspaceRoot, results) {
  const metadataRoot = path.join(path.resolve(workspaceRoot), '.jenny');
  const stat = safeLstat(metadataRoot);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return [];
  const failed = new Set(results
    .filter((entry) => Object.hasOwn(WORKSPACE_CHILD_KINDS, entry.kind) && entry.status === 'retained')
    .map((entry) => entry.name));
  const remaining = fs.readdirSync(metadataRoot);
  if (remaining.length === 0) {
    try {
      await fs.promises.rmdir(metadataRoot);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        results.push(cleanupResult({ kind: 'workspace_metadata', name: '.jenny' }, 'retained', boundedFsReason(error)));
      }
    }
    return [];
  }
  return remaining.filter((name) => !failed.has(name)).sort();
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
  let keptWorkspaceChildren = [];
  if (options.removeWorkspaceData && options.workspaceRoot && options.workspaceRemovalScope !== 'all') {
    try {
      keptWorkspaceChildren = await finishArchivedWorkspaceRemoval(options.workspaceRoot, results);
    } catch (error) {
      results.push(cleanupResult({ kind: 'workspace_metadata', name: '.jenny' }, 'retained', boundedFsReason(error)));
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
  if (keptWorkspaceChildren.length) {
    warnings.push(`Kept ${keptWorkspaceChildren.length} workspace .jenny item(s) that are not part of the archive.`);
  }
  return {
    ok: !incomplete,
    status: incomplete ? 'incomplete' : 'complete',
    results,
    warnings,
    unknownRuntimeChildren,
    unknownUserDataChildren,
    retainedWorkspaceChildren: keptWorkspaceChildren
      .slice(0, MAX_RETAINED_WORKSPACE_CHILDREN)
      .map((name) => name.slice(0, 160)),
  };
}

module.exports = {
  KNOWN_USER_DATA_CHILDREN,
  KNOWN_RUNTIME_CHILDREN,
  WORKSPACE_PURGE_ONLY_NAMES,
  buildCleanupTargets,
  cleanupJennyData,
  validateCleanupTarget,
};
