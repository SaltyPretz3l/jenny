'use strict';

/* Decides which HTML pages in a workspace a set of changed files affects.
 * A changed page is affected by definition. Any other changed file (a
 * stylesheet, script or image) affects the pages that use it, directly or
 * through one stylesheet or script. The walk is bounded in pages, bytes,
 * depth and time because it runs on the main process after every turn. */

const PAGE_FINDER_LIMITS = Object.freeze({
  maxHtmlFiles: 300,
  maxFileBytes: 512 * 1024,
  maxDepth: 6,
  timeBudgetMs: 250,
  maxLinkedFiles: 40,
});

const STATUSES = new Set(['created', 'modified', 'deleted']);
const PAGE_EXTENSION = /\.html?$/i;
const LINKED_EXTENSION = /\.(?:css|js|mjs)$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// A bounded count keeps a hostile file full of references from costing more
// than its size already allows.
const MAX_REFERENCES_PER_FILE = 2000;

const ATTRIBUTE_REFERENCE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const URL_REFERENCE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;
const IMPORT_REFERENCE = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function resolveLimits(overrides) {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  const limits = {};
  for (const key of Object.keys(PAGE_FINDER_LIMITS)) {
    limits[key] = key === 'maxDepth' && Number.isFinite(source[key]) && source[key] >= 0
      ? Math.floor(source[key])
      : positiveInteger(source[key], PAGE_FINDER_LIMITS[key]);
  }
  return limits;
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.includes('\\') || value.includes('\0')) return false;
  if (value.startsWith('/') || /^[a-z]:/i.test(value)) return false;
  return !value.split('/').includes('..');
}

function normalizeChangedPath(value) {
  return value.split('/').filter((segment) => segment && segment !== '.').join('/');
}

function isPagePath(relativePath) {
  return PAGE_EXTENSION.test(relativePath);
}

function baseName(relativePath) {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}

function depthOf(relativePath) {
  return relativePath.split('/').length - 1;
}

function comparePages(a, b) {
  const aIndex = /^index\.html?$/i.test(baseName(a.path));
  const bIndex = /^index\.html?$/i.test(baseName(b.path));
  if (aIndex !== bIndex) return aIndex ? -1 : 1;
  const depthDelta = depthOf(a.path) - depthOf(b.path);
  if (depthDelta) return depthDelta;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

function extractReferences(text) {
  const found = [];
  for (const pattern of [ATTRIBUTE_REFERENCE, URL_REFERENCE, IMPORT_REFERENCE]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match && found.length < MAX_REFERENCES_PER_FILE) {
      const value = match[1] ?? match[2] ?? match[3];
      if (value) found.push(value);
      match = pattern.exec(text);
    }
  }
  return found;
}

// Returns the workspace-relative path a reference points at, or '' when it is
// remote, empty or climbs out of the root.
function resolveReference(rawValue, pageDirectory) {
  let value = String(rawValue).trim();
  if (!value || SCHEME.test(value) || value.startsWith('//')) return '';
  const cut = value.search(/[?#]/);
  if (cut >= 0) value = value.slice(0, cut);
  if (!value) return '';
  try {
    value = decodeURIComponent(value);
  } catch (_error) {
    /* keep the raw value */
  }
  if (value.includes('\0')) return '';
  value = value.replace(/\\/g, '/');
  const stack = value.startsWith('/') || !pageDirectory ? [] : pageDirectory.split('/');
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!stack.length) return '';
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack.join('/');
}

function isInsideRoot(rootPath, candidate, pathImpl, caseFold) {
  const root = caseFold ? rootPath.toLowerCase() : rootPath;
  const target = caseFold ? candidate.toLowerCase() : candidate;
  const relative = pathImpl.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !pathImpl.isAbsolute(relative);
}

async function findAffectedPages(input = {}) {
  const {
    realRoot,
    files,
    maxPages = 3,
    fsImpl = require('fs'),
    pathImpl = require('path'),
    now = Date.now,
    limits: limitOverrides = {},
    platform = process.platform,
  } = input || {};
  const empty = { pages: [], scanned: 0, truncated: false };
  if (typeof realRoot !== 'string' || !realRoot || !Array.isArray(files)) return empty;

  const limits = resolveLimits(limitOverrides);
  const pageCap = positiveInteger(maxPages, 3);
  const caseFold = platform === 'win32';
  const fold = (value) => (caseFold ? value.toLowerCase() : value);
  const fsp = fsImpl.promises;

  const changedPages = [];
  const changedOthers = new Set();
  const changedBaseNames = new Set();
  const seen = new Set();
  for (const entry of files) {
    if (!entry || !isSafeRelativePath(entry.path)) continue;
    const relativePath = normalizeChangedPath(entry.path);
    if (!relativePath) continue;
    const key = fold(relativePath);
    if (isPagePath(relativePath)) {
      if (seen.has(key)) continue;
      seen.add(key);
      changedPages.push({
        path: relativePath,
        status: STATUSES.has(entry.status) ? entry.status : 'modified',
      });
    } else {
      changedOthers.add(key);
      changedBaseNames.add(fold(baseName(relativePath)));
    }
  }

  let scanned = 0;
  let truncated = false;
  const referencing = [];
  if (changedOthers.size) {
    const walked = await walkWorkspace();
    scanned = walked.scanned;
    truncated = walked.truncated;
    for (const page of walked.pages) {
      if (!seen.has(fold(page.path))) {
        seen.add(fold(page.path));
        referencing.push(page);
      }
    }
  }

  changedPages.sort(comparePages);
  referencing.sort(comparePages);
  const ordered = [...changedPages, ...referencing];
  if (ordered.length > pageCap) truncated = true;
  return { pages: ordered.slice(0, pageCap), scanned, truncated };

  async function walkWorkspace() {
    const startedAt = now();
    const outOfTime = () => now() - startedAt >= limits.timeBudgetMs;
    const linkedTexts = new Map();
    let linkedReads = 0;
    const result = { pages: [], scanned: 0, truncated: false };
    let pagesSeen = 0;
    // Breadth first, names sorted, so the pages nearest the root are
    // examined before any limit stops the walk.
    let level = [''];
    for (let depth = 0; level.length; depth += 1) {
      const nextLevel = [];
      for (const directory of level) {
        if (outOfTime()) {
          result.truncated = true;
          return result;
        }
        let entries;
        try {
          entries = await fsp.readdir(directory ? pathImpl.join(realRoot, ...directory.split('/')) : realRoot, { withFileTypes: true });
        } catch (_error) {
          continue;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            if (depth + 1 > limits.maxDepth) {
              result.truncated = true;
            } else {
              nextLevel.push(relativePath);
            }
            continue;
          }
          if (!entry.isFile() || !isPagePath(entry.name)) continue;
          if (seen.has(fold(relativePath))) continue;
          if (pagesSeen >= limits.maxHtmlFiles || outOfTime()) {
            result.truncated = true;
            return result;
          }
          pagesSeen += 1;
          const text = await readBounded(relativePath);
          if (text === null) continue;
          result.scanned += 1;
          if (await pageUsesChange(relativePath, text)) {
            result.pages.push({ path: relativePath, status: 'unchanged' });
          }
        }
      }
      level = nextLevel;
    }
    return result;

    async function readBounded(relativePath) {
      try {
        const absolute = pathImpl.join(realRoot, ...relativePath.split('/'));
        const stats = await fsp.lstat(absolute);
        if (!stats.isFile() || stats.size > limits.maxFileBytes) return null;
        const text = await fsp.readFile(absolute, 'utf8');
        return text.length > limits.maxFileBytes ? null : text;
      } catch (_error) {
        return null;
      }
    }

    // A linked file is read only when its real location is still inside the
    // root, so a link swapped in after the walk cannot lead outside.
    async function readLinked(relativePath) {
      const key = fold(relativePath);
      if (linkedTexts.has(key)) return linkedTexts.get(key);
      if (linkedReads >= limits.maxLinkedFiles) return null;
      linkedReads += 1;
      let text = null;
      try {
        const absolute = pathImpl.join(realRoot, ...relativePath.split('/'));
        const real = await fsp.realpath(absolute);
        if (isInsideRoot(realRoot, real, pathImpl, caseFold)) text = await readBounded(relativePath);
      } catch (_error) {
        text = null;
      }
      linkedTexts.set(key, text);
      return text;
    }

    async function pageUsesChange(pagePath, text) {
      const pageDirectory = pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/')) : '';
      const resolved = [];
      for (const raw of extractReferences(text)) {
        const target = resolveReference(raw, pageDirectory);
        if (target) resolved.push(target);
      }
      if (resolved.some((target) => changedOthers.has(fold(target)))) return true;
      for (const target of resolved) {
        if (!LINKED_EXTENSION.test(target) || changedOthers.has(fold(target))) continue;
        const linkedText = await readLinked(target);
        if (linkedText === null) continue;
        const haystack = fold(linkedText);
        for (const name of changedBaseNames) {
          if (haystack.includes(name)) return true;
        }
      }
      return false;
    }
  }
}

module.exports = { findAffectedPages, PAGE_FINDER_LIMITS };
