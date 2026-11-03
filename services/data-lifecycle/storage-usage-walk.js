'use strict';

// Size walks for the "Your data" page (row 95). Async and time-sliced, lstat on
// every entry, and a link (symlink or junction) is never entered, never counted
// and never reported as data: the walk only measures what sits inside the root.
// Caps (files visited, wall time) end a walk early and the result says so.

const fs = require('node:fs');
const path = require('node:path');
const { yieldToEventLoop } = require('../time-sliced-steps');

const SLICE_BUDGET_MS = 8;
const LSTAT_BATCH = 32;
const DEFAULT_MAX_FILES = 150_000;
const DEFAULT_MAX_MS = 4000;

function createBudget({
  maxFiles = DEFAULT_MAX_FILES,
  maxMs = DEFAULT_MAX_MS,
  now = Date.now,
  yieldImpl = yieldToEventLoop,
} = {}) {
  const start = now();
  return { maxFiles, maxMs, now, yieldImpl, started: start, sliceStart: start, visited: 0, partial: false };
}

function exhausted(budget) {
  if (budget.visited >= budget.maxFiles || budget.now() - budget.started >= budget.maxMs) {
    budget.partial = true;
    return true;
  }
  return false;
}

async function sliceYield(budget) {
  if (budget.now() - budget.sliceStart < SLICE_BUDGET_MS) return;
  await budget.yieldImpl();
  budget.sliceStart = budget.now();
}

// An entry that cannot be inspected counts as nothing (a walk never fails the page).
async function lstatOrNull(target) {
  try {
    return await fs.promises.lstat(target);
  } catch (_error) {
    return null;
  }
}

function sameLocation(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Adds one tree to `acc` ({ bytes, files, latestMtimeMs }). `exclude` lists
// absolute paths whose subtrees are another category's.
async function walkTree(rootPath, budget, acc, exclude = []) {
  const rootStat = await lstatOrNull(rootPath);
  if (!rootStat || rootStat.isSymbolicLink()) return;
  if (rootStat.isFile()) {
    acc.bytes += rootStat.size;
    acc.files += 1;
    acc.latestMtimeMs = Math.max(acc.latestMtimeMs, rootStat.mtimeMs);
    return;
  }
  if (!rootStat.isDirectory()) return;
  const stack = [rootPath];
  while (stack.length) {
    const current = stack.pop();
    let names;
    try {
      names = await fs.promises.readdir(current);
    } catch (_error) {
      continue;
    }
    for (let index = 0; index < names.length; index += LSTAT_BATCH) {
      if (exhausted(budget)) return;
      const batch = names.slice(index, index + LSTAT_BATCH);
      const stats = await Promise.all(batch.map((name) => lstatOrNull(path.join(current, name))));
      for (let offset = 0; offset < batch.length; offset += 1) {
        const stat = stats[offset];
        budget.visited += 1;
        if (!stat || stat.isSymbolicLink()) continue;
        const entryPath = path.join(current, batch[offset]);
        if (stat.isDirectory()) {
          if (!exclude.some((skipped) => sameLocation(skipped, entryPath))) stack.push(entryPath);
        } else if (stat.isFile()) {
          acc.bytes += stat.size;
          acc.files += 1;
          acc.latestMtimeMs = Math.max(acc.latestMtimeMs, stat.mtimeMs);
        }
      }
      await sliceYield(budget);
    }
  }
}

function emptyTally() {
  return { bytes: 0, files: 0, latestMtimeMs: 0 };
}

// roots: [{ path, exclude? }]. Returns { bytes, files, latestMtimeMs, partial }.
async function measureRoots(roots, options = {}) {
  const budget = options.budget || createBudget(options);
  const acc = emptyTally();
  for (const root of roots) {
    if (budget.partial) break;
    await walkTree(root.path, budget, acc, root.exclude || []);
  }
  // `partial` is the shared budget's state after this call: true means this
  // measure was cut short (or never started), so its numbers are a floor, not a total.
  return { ...acc, partial: budget.partial };
}

module.exports = {
  createBudget,
  lstatOrNull,
  measureRoots,
};
