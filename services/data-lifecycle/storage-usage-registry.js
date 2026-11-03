'use strict';

// Closed category registry for the "Your data" page (row 95). Every profile
// child under userData belongs to exactly one category:
//   chats      sessions, shadow store, turn journal, attachments, todo lists,
//              the conversation index, and background-memory/ipc-payloads
//   artifacts  <workspace>/.jenny/{artifacts,tool-results,quarantine}
//   logs       logs, diagnostics (and ~/.companion/logs, ~/.companion/sidecar.log)
//   caches     Chromium caches, compile-cache, image-engine-scratch
//   leftovers  exports (reset/export copies) and the owned derived files
//   engines    engines/*, image-models.json (+ .part): removed per model, never here
//   personal   everything else: config, personality, notes, calendar, secure
//              state, memory databases, session-runtime work records, Chromium
//              state (Cookies, Local Storage, ...), pid/process files, and any
//              profile child this registry does not know (size only, never cleared)
// A child a later feature adds therefore defaults to the one category that can
// never be cleared. `categoryForUserDataChild` is the mapping the guard test pins.

const path = require('node:path');
const { DERIVED_INDEX_CHILDREN } = require('./derived-indexes');
const { KNOWN_USER_DATA_CHILDREN, KNOWN_RUNTIME_CHILDREN } = require('./cleanup-service');

const CATEGORY_IDS = Object.freeze(['chats', 'artifacts', 'logs', 'caches', 'leftovers', 'engines', 'personal']);
const CLEARABLE_IDS = Object.freeze(['chats', 'artifacts', 'logs', 'caches', 'leftovers']);

const CONVERSATION_INDEX_CHILDREN = Object.freeze(DERIVED_INDEX_CHILDREN.filter((name) => name.startsWith('conversation-index.db')));

const CHATS_CHILDREN = Object.freeze([
  'sessions', 'sessions.json', 'session-shadow', 'session-shadow.json',
  'turn-event-journal.json', 'turn-event-journal.json.journal',
  'attachments', 'todo-lists', ...CONVERSATION_INDEX_CHILDREN,
]);
const LOGS_CHILDREN = Object.freeze(['logs', 'diagnostics']);
// Chromium-owned directories are cleared through the session API, never removed.
const BROWSER_CACHE_CHILDREN = Object.freeze([
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache',
]);
const COMPILE_CACHE_CHILD = 'compile-cache';
const IMAGE_SCRATCH_CHILD = 'image-engine-scratch';
const CACHES_CHILDREN = Object.freeze([...BROWSER_CACHE_CHILDREN, COMPILE_CACHE_CHILD, IMAGE_SCRATCH_CHILD]);
const LEFTOVERS_CHILDREN = Object.freeze(['exports']);
const ENGINES_CHILDREN = Object.freeze(['engines', 'image-models.json', 'image-models.json.part']);

const USER_DATA_CLAIMS = Object.freeze({
  chats: CHATS_CHILDREN,
  logs: LOGS_CHILDREN,
  caches: CACHES_CHILDREN,
  leftovers: LEFTOVERS_CHILDREN,
  engines: ENGINES_CHILDREN,
});

// A subtree of a personal child (background-memory) that the chats category counts.
const BACKGROUND_MEMORY_CHILD = 'background-memory';
const IPC_PAYLOADS_CHILD = 'ipc-payloads';

const CLAIMED_BY_NAME = new Map();
for (const [categoryId, names] of Object.entries(USER_DATA_CLAIMS)) {
  for (const name of names) CLAIMED_BY_NAME.set(name.toLowerCase(), categoryId);
}

function categoryForUserDataChild(name) {
  return CLAIMED_BY_NAME.get(String(name || '').toLowerCase()) || 'personal';
}

// The Chromium cache directories under the profile, as measure roots.
function browserCacheRoots(userDataPath) {
  return BROWSER_CACHE_CHILDREN.map((name) => ({ path: path.join(userDataPath, name) }));
}

function isCategoryId(value) {
  return typeof value === 'string' && CATEGORY_IDS.includes(value);
}

function isClearableCategory(value) {
  return CLEARABLE_IDS.includes(value);
}

function runtimeChildCategory(name) {
  return name === 'logs' || name === 'sidecar.log' ? 'logs' : 'personal';
}

// A name this registry has never listed still resolves (personal), but the
// guard test also needs to know the claimed set is a subset of the known one.
function listClaimedNames() {
  return [...CLAIMED_BY_NAME.keys()];
}

function userDataRootsFor(categoryId, ctx) {
  const { userDataPath } = ctx;
  const join = (name) => path.join(userDataPath, name);
  if (categoryId === 'personal') {
    const derived = new Set(ctx.derivedNames || []);
    const names = new Set([...KNOWN_USER_DATA_CHILDREN, ...(ctx.userDataEntries || [])]);
    return [...names]
      .filter((name) => categoryForUserDataChild(name) === 'personal' && !derived.has(name))
      .map((name) => ({
        path: join(name),
        exclude: name === BACKGROUND_MEMORY_CHILD ? [path.join(join(name), IPC_PAYLOADS_CHILD)] : [],
      }));
  }
  const roots = (USER_DATA_CLAIMS[categoryId] || []).map((name) => ({ path: join(name), exclude: [] }));
  if (categoryId === 'chats') roots.push({ path: path.join(userDataPath, BACKGROUND_MEMORY_CHILD, IPC_PAYLOADS_CHILD), exclude: [] });
  if (categoryId === 'leftovers') {
    for (const name of ctx.derivedNames || []) roots.push({ path: join(name), exclude: [] });
  }
  return roots;
}

// Roots whose size the category reports. `ctx`: { userDataPath, runtimePath,
// workspaceRoot, userDataEntries (top-level names present), derivedNames }.
function categoryRoots(categoryId, ctx) {
  const { runtimePath = '', workspaceRoot = '' } = ctx;
  if (categoryId === 'artifacts') {
    if (!workspaceRoot) return [];
    return ['artifacts', 'tool-results', 'quarantine']
      .map((name) => ({ path: path.join(workspaceRoot, '.jenny', name), exclude: [] }));
  }
  const roots = userDataRootsFor(categoryId, ctx);
  if (runtimePath && (categoryId === 'logs' || categoryId === 'personal')) {
    for (const name of KNOWN_RUNTIME_CHILDREN) {
      if (runtimeChildCategory(name) === categoryId) roots.push({ path: path.join(runtimePath, name), exclude: [] });
    }
  }
  return roots;
}

// Where Open folder goes, most specific first: { base, segments } below a base
// the service owns. The last candidate is the profile root (the fallback).
function primaryFolderCandidates(categoryId, ctx) {
  const { userDataPath, workspaceRoot = '' } = ctx;
  if (categoryId === 'artifacts') {
    return workspaceRoot
      ? [{ base: workspaceRoot, segments: ['.jenny', 'artifacts'] }, { base: workspaceRoot, segments: ['.jenny'] }]
      : [];
  }
  const specific = {
    chats: 'sessions',
    logs: 'logs',
    leftovers: 'exports',
    engines: 'engines',
  }[categoryId];
  return [
    ...(specific ? [{ base: userDataPath, segments: [specific] }] : []),
    { base: userDataPath, segments: [] },
  ];
}

// `%APPDATA%\jenny` on win32 when that is the real prefix, otherwise the real path.
function displayLocation(targetPath, { platform = process.platform, env = process.env } = {}) {
  const real = String(targetPath || '');
  if (!real) return '';
  const appData = String(env?.APPDATA || '').trim();
  if (platform !== 'win32' || !appData) return real;
  const prefix = path.win32.join(appData, 'jenny');
  const resolved = path.win32.resolve(real);
  const relative = path.win32.relative(prefix, resolved);
  if (relative.startsWith('..') || path.win32.isAbsolute(relative)) return real;
  return relative ? `%APPDATA%\\jenny\\${relative}` : '%APPDATA%\\jenny';
}

module.exports = {
  CATEGORY_IDS,
  COMPILE_CACHE_CHILD,
  IMAGE_SCRATCH_CHILD,
  browserCacheRoots,
  categoryForUserDataChild,
  categoryRoots,
  displayLocation,
  isCategoryId,
  isClearableCategory,
  listClaimedNames,
  primaryFolderCandidates,
};
