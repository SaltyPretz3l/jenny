'use strict';

// Pure Git-output parsers and ref-name validation for WorktreeService.
// No process spawning or registry IO lives here.

const path = require('path');
const { normalizeString } = require('./shared/normalize');

const MAX_ERROR_CHARS = 800;
const MAX_BRANCH_NAME_CHARS = 200;
const MAX_BASE_REF_CHARS = 200;
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_BASE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;

function clipText(value, limit = MAX_ERROR_CHARS) {
  const text = normalizeString(value).replace(/[\r\n]+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit - 3).trim()}...` : text;
}

function slugify(value, fallback = 'worktree') {
  const slug = normalizeString(value)
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop();
  const normalized = normalizeString(slug || value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return normalized || fallback;
}

function normalizeBranchName({ branch, name }) {
  const explicit = normalizeString(branch);
  if (explicit) {
    return explicit;
  }
  return `jenny/${slugify(name, `worktree-${Date.now().toString(36)}`)}`;
}

function refNameHasSafeShape(value, { maxLength, pattern }) {
  const refName = normalizeString(value);
  if (!refName || refName.length > maxLength) {
    return false;
  }
  if (
    refName.includes('\0')
    || refName.startsWith('-')
    || refName.startsWith('/')
    || refName.endsWith('/')
    || refName.includes('\\')
    || refName.includes('..')
    || refName.includes('//')
    || refName.includes('@{')
    || refName.endsWith('.')
    || refName.endsWith('.lock')
  ) {
    return false;
  }
  if (!pattern.test(refName)) {
    return false;
  }
  return refName.split('/').every((part) => (
    part
    && part !== '.'
    && part !== '..'
    && !part.endsWith('.lock')
  ));
}

function branchNameIsSafe(value) {
  return refNameHasSafeShape(value, {
    maxLength: MAX_BRANCH_NAME_CHARS,
    pattern: SAFE_BRANCH_PATTERN,
  });
}

function baseRefIsSafe(value) {
  return refNameHasSafeShape(value, {
    maxLength: MAX_BASE_REF_CHARS,
    pattern: SAFE_BASE_REF_PATTERN,
  });
}

function normalizeBaseRef(value) {
  return normalizeString(value) || 'HEAD';
}

function parsePorcelainWorktreeList(output) {
  const entries = [];
  let current = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ').trim();
    if (key === 'worktree') {
      if (current) {
        entries.push(current);
      }
      current = {
        path: path.resolve(value),
        head: '',
        branch: '',
        detached: false,
        bare: false,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (key === 'HEAD') {
      current.head = value;
    } else if (key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '');
    } else if (key === 'detached') {
      current.detached = true;
    } else if (key === 'bare') {
      current.bare = true;
    } else if (key === 'prunable') {
      // Git still lists a worktree whose directory is gone until it is pruned.
      current.prunable = true;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

function parseGitStatusPorcelainSummary(output) {
  const summary = {
    modified_count: 0,
    staged_count: 0,
    untracked_count: 0,
    ignored_count: 0,
  };
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    if (!rawLine) continue;
    const x = rawLine[0] || ' ';
    const y = rawLine[1] || ' ';
    if (x === '?' && y === '?') {
      summary.untracked_count += 1;
      continue;
    }
    if (x === '!' && y === '!') {
      summary.ignored_count += 1;
      continue;
    }
    if (x && x !== ' ') {
      summary.staged_count += 1;
    }
    if (y && y !== ' ') {
      summary.modified_count += 1;
    }
  }
  return summary;
}

function canonicalRepositoryRootFromWorktreeList(output, fallbackRoot) {
  const entries = parsePorcelainWorktreeList(output);
  const primary = entries.find((entry) => entry.path && !entry.bare) || entries[0] || null;
  return primary?.path ? path.resolve(primary.path) : path.resolve(fallbackRoot);
}

function dirtySummaryHasChanges(summary) {
  return Boolean(
    summary
    && (
      summary.modified_count > 0
      || summary.staged_count > 0
      || summary.untracked_count > 0
      || summary.ignored_count > 0
    )
  );
}

module.exports = {
  baseRefIsSafe,
  branchNameIsSafe,
  canonicalRepositoryRootFromWorktreeList,
  clipText,
  dirtySummaryHasChanges,
  normalizeBaseRef,
  normalizeBranchName,
  parseGitStatusPorcelainSummary,
  parsePorcelainWorktreeList,
  slugify,
};
