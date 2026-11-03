'use strict';

// The artifacts and chats clear plans (row 95), split from storage-usage-plans.js.
//
// Artifacts: only what no persisted chat references. The reference scan reads
// every chat the way the retention service does (generated_artifacts on tool
// results, plus the persisted turn events) and FAILS CLOSED: a chat that cannot
// be read in full empties the unreferenced set, because under-counting
// references would delete a file a chat still shows. Files used in the last few
// minutes are kept (a turn may be writing them), as are job outputs a chat
// still lists in the rail.

const path = require('node:path');
const { BACKGROUND_JOB_ID_PATTERN } = require('../backend/chat-stream-background-jobs');
const { readSessionRecordForReferenceScan } = require('../backend/session-reference-scan');
const { isPrimaryRole } = require('../backend/primary-session');
const { isRetentionQuarantineEntry } = require('../artifact-retention-service');
const { yieldToEventLoop } = require('../time-sliced-steps');
const {
  keptLabel, listPlain, markUnmeasured, measureUnit,
} = require('./storage-usage-plans');
const { lstatOrNull } = require('./storage-usage-walk');

const REDACTED_PATH_TOKEN = '[redacted:path]';
const SCAN_YIELD_EVERY = 8;

function referencedDirName(entry, workspaceRoot, artifactsRoot) {
  const stored = String(entry?.absolute_path || '').trim();
  const display = String(entry?.display_path || '').trim();
  const usable = stored && stored !== REDACTED_PATH_TOKEN
    ? stored
    : (display ? path.join(workspaceRoot, display) : '');
  if (!usable) return '';
  const relative = path.relative(artifactsRoot, path.resolve(usable));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.split(/[\\/]/)[0] || '';
}

function* generatedArtifactEntries({ messages, turnEvents }) {
  for (const message of messages) {
    const list = message?.tool_result?.generated_artifacts;
    if (Array.isArray(list)) yield* list;
  }
  for (const event of turnEvents) {
    const list = event?.kind === 'tool_result' ? event.payload?.generated_artifacts : null;
    if (Array.isArray(list)) yield* list;
  }
}

// { dirs: Set<string>, complete: boolean }
async function scanReferencedArtifactDirs(sessionStore, workspaceRoot) {
  const dirs = new Set();
  const artifactsRoot = path.join(workspaceRoot, '.jenny', 'artifacts');
  let sessions;
  try {
    sessions = sessionStore.listSessions();
    if (!Array.isArray(sessions)) throw new Error('unreadable');
  } catch (_error) {
    return { dirs, complete: false };
  }
  for (const [index, summary] of sessions.entries()) {
    if (index > 0 && index % SCAN_YIELD_EVERY === 0) await yieldToEventLoop();
    let record;
    try {
      record = readSessionRecordForReferenceScan(sessionStore, summary);
    } catch (_error) {
      return { dirs, complete: false };
    }
    for (const entry of generatedArtifactEntries(record)) {
      const name = referencedDirName(entry, workspaceRoot, artifactsRoot);
      if (name) dirs.add(name);
    }
  }
  return { dirs, complete: true };
}

async function childDirectories(workspaceRoot, segments) {
  const result = [];
  for (const name of await listPlain(workspaceRoot, segments)) {
    const stat = await lstatOrNull(path.join(workspaceRoot, ...segments, name));
    if (stat?.isDirectory() && !stat.isSymbolicLink()) result.push(name);
  }
  return result;
}

async function planArtifacts(ctx) {
  const plan = { units: [], kept: [], partial: false };
  const workspaceRoot = ctx.workspaceRoot;
  const scan = ctx.sessionStore
    ? await scanReferencedArtifactDirs(ctx.sessionStore, workspaceRoot)
    : { dirs: new Set(), complete: false };
  const flags = { referenced: false, recent: false, other: false, tracked: false };
  const base = { op: 'remove', baseKey: 'workspace', base: workspaceRoot };
  const tryAdd = async (unit) => {
    const measured = await measureUnit(unit, ctx);
    if (!measured) return;
    if (measured.partial) {
      markUnmeasured(plan);
      return;
    }
    if (ctx.now() - measured.latestMtimeMs < ctx.recentFloorMs) {
      flags.recent = true;
      return;
    }
    plan.units.push({ ...unit, files: measured.files, bytes: measured.bytes });
  };
  if (!scan.complete) {
    plan.kept.push(keptLabel('unreadableChats'));
  } else {
    for (const name of await childDirectories(workspaceRoot, ['.jenny', 'artifacts'])) {
      if (scan.dirs.has(name)) flags.referenced = true;
      else await tryAdd({ ...base, group: 'unusedArtifacts', segments: ['.jenny', 'artifacts', name] });
    }
    for (const name of await childDirectories(workspaceRoot, ['.jenny', 'quarantine'])) {
      if (isRetentionQuarantineEntry(name)) await tryAdd({ ...base, group: 'quarantine', segments: ['.jenny', 'quarantine', name] });
      else flags.other = true;
    }
  }
  // No tracker answer means no job output is touched (a running job's output is never guessed at).
  const trackedIds = ctx.getTrackedJobIds ? ctx.getTrackedJobIds() : null;
  const tracked = Array.isArray(trackedIds) ? new Set(trackedIds) : null;
  if (tracked) {
    for (const name of await childDirectories(workspaceRoot, ['.jenny', 'tool-results'])) {
      if (!BACKGROUND_JOB_ID_PATTERN.test(name)) continue;
      if (tracked.has(name)) flags.tracked = true;
      else await tryAdd({ ...base, group: 'jobOutputs', segments: ['.jenny', 'tool-results', name] });
    }
  }
  if (flags.referenced) plan.kept.push(keptLabel('referencedArtifacts'));
  if (flags.tracked) plan.kept.push(keptLabel('trackedJobs'));
  if (flags.recent) plan.kept.push(keptLabel('recentFiles'));
  if (flags.other) plan.kept.push(keptLabel('otherQuarantine'));
  plan.partial = ctx.planBudget.partial;
  return plan;
}

// Every chat except the primary one. Bytes are the category's own size (the
// stores a delete empties are not separable per chat).
async function planChats(ctx) {
  const summaries = ctx.listChatSummaries();
  const ids = [];
  let hasPrimary = false;
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (typeof summary?.id !== 'string' || !summary.id) continue;
    if (isPrimaryRole(summary)) hasPrimary = true;
    else ids.push(summary.id);
  }
  ids.sort();
  const plan = {
    units: ids.map((id) => ({
      op: 'chat', group: 'chats', baseKey: 'chats', base: '', segments: [id], files: 0, bytes: 0,
    })),
    kept: hasPrimary ? [keptLabel('primaryChat')] : [],
    partial: false,
    confirmCount: ids.length,
  };
  if (ids.length) {
    const totals = await ctx.measureCategory('chats');
    plan.groupTotals = { chats: { bytes: totals.bytes, files: totals.files } };
    plan.partial = totals.partial;
  }
  return plan;
}

module.exports = { planArtifacts, planChats };
