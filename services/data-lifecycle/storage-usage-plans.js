'use strict';

// Clear plans for the "Your data" page (row 95): the exact set of units a clear
// of one category would act on, built from fixed registry names (never from the
// renderer), plus the grouped human-readable items the confirm lists. A unit is
// { op, group, baseKey, base, segments, files, bytes, volatile }:
//   op 'remove' deletes one contained file or tree, 'truncate' empties a live
//   log, 'browser' clears the Chromium caches through the session API,
//   'chat' deletes one chat through the backend (artifact/chat plans live in
//   storage-usage-artifact-plan.js).
// The preview hashes the unit identities; clear recomputes and compares.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { t } = require('../i18n-main');
const { validateCleanupTarget, listOwnedDerivedFiles } = require('./cleanup-service');
const { resolveContained } = require('../fs-contained');
const { COMPILE_CACHE_CHILD, IMAGE_SCRATCH_CHILD, browserCacheRoots } = require('./storage-usage-registry');
const { lstatOrNull, measureRoots } = require('./storage-usage-walk');

const ROTATED_LOG = /^[^\\/]+\.log\.\d{1,4}$/;
const ACTIVE_LOG = /^[^\\/]+\.log$/;
const DIAGNOSTIC_DAY = /^\d{4}-\d{2}-\d{2}$/;

const GROUP_ORDER = Object.freeze([
  'chats', 'unusedArtifacts', 'quarantine', 'jobOutputs', 'appLogs', 'engineLogs', 'diagnostics', 'activeLogs',
  'browserCaches', 'compileCache', 'imageScratch', 'exports', 'derived',
]);

function groupLabel(group, count) {
  switch (group) {
    case 'chats': return count === 1
      ? t('main.dataUsage.label.chatsOne', '1 chat and its attachments')
      : t('main.dataUsage.label.chats', '{count} chats and their attachments', { count });
    case 'unusedArtifacts': return t('main.dataUsage.label.unusedArtifacts', 'Generated files no chat uses');
    case 'quarantine': return t('main.dataUsage.label.quarantine', 'Generated files already set aside');
    case 'jobOutputs': return t('main.dataUsage.label.jobOutputs', 'Output of finished background jobs');
    case 'appLogs': return t('main.dataUsage.label.appLogs', 'Old app logs');
    case 'engineLogs': return t('main.dataUsage.label.engineLogs', 'Old engine logs');
    case 'diagnostics': return count === 1
      ? t('main.dataUsage.label.diagnosticsOne', 'Turn diagnostics, 1 day')
      : t('main.dataUsage.label.diagnostics', 'Turn diagnostics, {count} days', { count });
    case 'activeLogs': return t('main.dataUsage.label.activeLogs', 'Current log files (emptied, not deleted)');
    case 'browserCaches': return t('main.dataUsage.label.browserCaches', 'Browser caches');
    case 'compileCache': return t('main.dataUsage.label.compileCache', 'Startup compile cache');
    case 'imageScratch': return t('main.dataUsage.label.imageScratch', 'Image engine scratch files');
    case 'exports': return t('main.dataUsage.label.exports', 'Reset and export copies');
    case 'derived': return t('main.dataUsage.label.derived', 'Old backups and damaged-file copies');
    default: return group;
  }
}

function keptLabel(key) {
  switch (key) {
    case 'primaryChat': return t('main.dataUsage.kept.primaryChat', 'Your Jenny chat');
    case 'referencedArtifacts': return t('main.dataUsage.kept.referencedArtifacts', 'Generated files a chat still uses');
    case 'recentFiles': return t('main.dataUsage.kept.recentFiles', 'Files used in the last few minutes');
    case 'otherQuarantine': return t('main.dataUsage.kept.otherQuarantine', 'Other items set aside by Jenny');
    case 'trackedJobs': return t('main.dataUsage.kept.trackedJobs', 'Output of background jobs a chat still lists');
    case 'unreadableChats': return t('main.dataUsage.kept.unreadableChats', 'Generated files (a chat could not be read)');
    case 'unmeasured': return t('main.dataUsage.kept.unmeasured', 'Folders too large to check this time');
    default: return key;
  }
}

// Re-checked right before a unit is acted on (the derived set has its own name contract).
function validateUnit(unit) {
  if (unit.group !== 'derived') return true;
  return validateCleanupTarget({
    kind: 'user_data_derived_child', root: path.resolve(unit.base), name: unit.segments[0], path: unitPath(unit),
  });
}

function unitPath(unit) {
  return path.join(unit.base, ...unit.segments);
}

// The real path of a unit's base joins the identity, so a preview taken in one
// workspace cannot clear same-named folders in another after a workspace switch.
function realBaseOf(base, cache) {
  if (!base) return '';
  if (!cache.has(base)) {
    let real;
    try {
      real = fs.realpathSync.native(base);
    } catch (_error) {
      real = path.resolve(base);
    }
    cache.set(base, real);
  }
  return cache.get(base);
}

function unitIdentity(unit, realBases) {
  if (unit.op === 'chat') return `chat|${unit.segments[0]}`;
  const where = `${unit.baseKey}|${realBaseOf(unit.base, realBases)}|${unit.segments.join('/')}`;
  return unit.volatile ? `${unit.op}|${where}` : `${unit.op}|${where}|${unit.files}|${unit.bytes}`;
}

function hashUnits(categoryId, units) {
  const realBases = new Map();
  const lines = units.map((unit) => unitIdentity(unit, realBases)).sort();
  return crypto.createHash('sha256').update(`${categoryId}\n${lines.join('\n')}`).digest('hex');
}

// Grouped items for the confirm: one entry per group, in a fixed display order.
// `groupTotals` overrides a group's bytes/files (the chats group has no per-chat size).
function buildItems(units, groupTotals = {}) {
  const byGroup = new Map();
  for (const unit of units) {
    const entry = byGroup.get(unit.group) || { count: 0, bytes: 0, files: 0 };
    entry.count += 1;
    entry.bytes += unit.bytes;
    entry.files += unit.files;
    byGroup.set(unit.group, entry);
  }
  return GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => {
    const entry = byGroup.get(group);
    const total = groupTotals[group];
    return { label: groupLabel(group, entry.count), bytes: total?.bytes ?? entry.bytes, files: total?.files ?? entry.files };
  });
}

// Resolves null when the unit is gone or a link. `partial` means the plan budget
// ran out before or during this unit, so its totals are a floor.
async function measureUnit(unit, ctx) {
  const stat = await lstatOrNull(unitPath(unit));
  if (!stat || stat.isSymbolicLink()) return null;
  const measured = await measureRoots([{ path: unitPath(unit) }], { budget: ctx.planBudget });
  // An empty directory has no file times to judge by: its own mtime says how new it is.
  const latestMtimeMs = measured.files === 0 ? Math.max(measured.latestMtimeMs, stat.mtimeMs) : measured.latestMtimeMs;
  return { ...measured, latestMtimeMs, isFile: stat.isFile() };
}

// A unit that was not fully measured is kept, never targeted: its size and
// recency are unknown, so it must not reach the clear as a zero-byte unit.
function markUnmeasured(plan) {
  const label = keptLabel('unmeasured');
  if (!plan.kept.includes(label)) plan.kept.push(label);
}

// Names inside `base/segments`, only when every step down to that directory is a
// plain directory (a link anywhere on the way lists nothing).
async function listPlain(base, segments) {
  try {
    const resolved = resolveContained(base, segments);
    if (!resolved?.stat.isDirectory()) return [];
    // Sorted so a budget that runs out cuts the same units on the clear as on the preview.
    return (await fs.promises.readdir(resolved.path)).sort();
  } catch (_error) {
    return [];
  }
}

function emptyPlan() {
  return { units: [], kept: [], partial: false };
}

// Measures and adds a unit; resolves the added unit, or null when it is gone or a link.
async function addUnit(plan, ctx, unit) {
  const measured = await measureUnit(unit, ctx);
  if (!measured) return null;
  if (measured.partial) {
    markUnmeasured(plan);
    return null;
  }
  const added = { ...unit, files: measured.files, bytes: measured.bytes, latestMtimeMs: measured.latestMtimeMs };
  plan.units.push(added);
  return added;
}

async function planLogs(ctx) {
  const plan = emptyPlan();
  const places = [
    { baseKey: 'userData', base: ctx.userDataPath, dir: 'logs', rotated: 'appLogs' },
    { baseKey: 'runtime', base: ctx.runtimePath, dir: 'logs', rotated: 'engineLogs' },
  ];
  for (const place of places) {
    if (!place.base) continue;
    for (const name of await listPlain(place.base, [place.dir])) {
      const isRotated = ROTATED_LOG.test(name);
      if (!isRotated && !ACTIVE_LOG.test(name)) continue;
      const unit = {
        op: isRotated ? 'remove' : 'truncate',
        group: isRotated ? place.rotated : 'activeLogs',
        baseKey: place.baseKey,
        base: place.base,
        segments: [place.dir, name],
        volatile: !isRotated,
      };
      const stat = await lstatOrNull(unitPath(unit));
      if (!stat?.isFile() || stat.isSymbolicLink() || (!isRotated && stat.size === 0)) continue;
      plan.units.push({ ...unit, files: 1, bytes: stat.size });
    }
  }
  if (ctx.runtimePath) {
    const unit = { op: 'truncate', group: 'activeLogs', baseKey: 'runtime', base: ctx.runtimePath, segments: ['sidecar.log'], volatile: true };
    const stat = await lstatOrNull(unitPath(unit));
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.size > 0) plan.units.push({ ...unit, files: 1, bytes: stat.size });
  }
  for (const name of await listPlain(ctx.userDataPath, ['diagnostics'])) {
    if (!DIAGNOSTIC_DAY.test(name)) continue;
    const stat = await lstatOrNull(path.join(ctx.userDataPath, 'diagnostics', name));
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    await addUnit(plan, ctx, {
      op: 'remove', group: 'diagnostics', baseKey: 'userData', base: ctx.userDataPath, segments: ['diagnostics', name],
    });
  }
  plan.partial = ctx.planBudget.partial;
  return plan;
}

async function planCaches(ctx) {
  const plan = emptyPlan();
  if (typeof ctx.clearBrowserCaches === 'function') {
    const measured = await measureRoots(browserCacheRoots(ctx.userDataPath), { budget: ctx.planBudget });
    plan.units.push({
      op: 'browser', group: 'browserCaches', baseKey: 'userData', base: ctx.userDataPath,
      segments: ['browser-caches'], files: measured.files, bytes: measured.bytes, volatile: true,
    });
  }
  let sawRecent = false;
  for (const [dir, group, floor] of [[COMPILE_CACHE_CHILD, 'compileCache', false], [IMAGE_SCRATCH_CHILD, 'imageScratch', true]]) {
    for (const name of await listPlain(ctx.userDataPath, [dir])) {
      const unit = { op: 'remove', group, baseKey: 'userData', base: ctx.userDataPath, segments: [dir, name] };
      const added = await addUnit(plan, ctx, unit);
      if (floor && added && ctx.now() - added.latestMtimeMs < ctx.recentFloorMs) {
        plan.units.pop();
        sawRecent = true;
      }
    }
  }
  if (sawRecent) plan.kept.push(keptLabel('recentFiles'));
  plan.partial = ctx.planBudget.partial;
  return plan;
}

async function planLeftovers(ctx) {
  const plan = emptyPlan();
  for (const name of await listPlain(ctx.userDataPath, ['exports'])) {
    await addUnit(plan, ctx, {
      op: 'remove', group: 'exports', baseKey: 'userData', base: ctx.userDataPath, segments: ['exports', name],
    });
  }
  for (const name of listOwnedDerivedFiles(ctx.userDataPath)) {
    const target = { kind: 'user_data_derived_child', root: path.resolve(ctx.userDataPath), name, path: path.join(ctx.userDataPath, name) };
    if (!validateCleanupTarget(target)) continue;
    const stat = await lstatOrNull(target.path);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    plan.units.push({
      op: 'remove', group: 'derived', baseKey: 'userData', base: ctx.userDataPath, segments: [name], files: 1, bytes: stat.size,
    });
  }
  plan.partial = ctx.planBudget.partial;
  return plan;
}

module.exports = {
  buildItems,
  groupLabel,
  hashUnits,
  keptLabel,
  listPlain,
  markUnmeasured,
  measureUnit,
  planCaches,
  planLeftovers,
  planLogs,
  unitPath,
  validateUnit,
};
