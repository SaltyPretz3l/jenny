'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { boundedReason, removeContained, resolveContained } = require('../fs-contained');
const { createBudget, measureRoots } = require('../data-lifecycle/storage-usage-walk');
const { BACKGROUND_JOB_ID_PATTERN } = require('./chat-stream-background-jobs');
const { todoListFileName } = require('./session-todo-list-purge');

// What a deleted chat leaves behind outside the session stores, plus the
// "freed" tally cleanupDeletedSession reports. Every step is best effort and
// follows the delete-cleanup contract: a failure throws so the caller records
// the step as degraded; counting never throws.

const EMPTY = Object.freeze({ files: 0, bytes: 0 });
// Mirrors sidecar/runtime/runtime_ids.py parse_session_id ([A-Za-z0-9._-]{1,128},
// not '.' or '..'). A trailing dot is also refused: Windows resolves `x.` to `x`.
const RUNTIME_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const DIAGNOSTIC_DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
// The dump writes session_id within the first few fields; a header read finds it.
const DIAGNOSTIC_HEADER_BYTES = 4096;
// Matches the diagnostics retention cap (turn-diagnostic-dump.js).
const MAX_DIAGNOSTIC_FILES_SCANNED = 5000;
const DIAGNOSTIC_SWEEP_DELAY_MS = 2000;
const DIAGNOSTIC_SWEEP_CONCURRENCY = 8;
const MAX_PENDING_DIAGNOSTIC_SESSIONS = 10_000;
const MEASURE_BUDGET = Object.freeze({ maxFiles: 20_000, maxMs: 1500 });
const MAX_WATCHED_FILES = 2000;
const WATCH_BATCH = 32;

function isRuntimeSessionId(value) {
  return typeof value === 'string' && RUNTIME_SESSION_ID.test(value)
    && value !== '.' && value !== '..' && !value.endsWith('.');
}

async function lstatOrNull(target) {
  try {
    return await fs.promises.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// Removes the plain directory `<base>/<segments>` through the shared
// containment (no link followed, real-path checked at every step). Returns what
// the removal freed; a missing target frees nothing. The size is measured
// before, asynchronously and within a budget, and counted only if the directory
// is gone afterwards.
async function removeContainedDir(base, segments) {
  const resolved = resolveContained(base, segments);
  if (!resolved) return EMPTY;
  if (!resolved.stat.isDirectory()) throw new Error('purge target is not a plain directory');
  const measured = await measureRoots([{ path: resolved.path }], { budget: createBudget(MEASURE_BUDGET) });
  await removeContained(base, segments);
  return (await lstatOrNull(resolved.path)) ? EMPTY : { files: measured.files, bytes: measured.bytes };
}

function backgroundRuntimeRoot(service) {
  if (typeof service.getBackgroundRuntimeRoot === 'function') return service.getBackgroundRuntimeRoot();
  const userDataPath = service.options?.userDataPath;
  return userDataPath ? path.join(userDataPath, 'background-memory') : '';
}

// `<background_runtime_root>/repo-anchors/<sessionId>/anchor.json` is written
// by the sidecar (repo_delta/service.py) under the root Electron passes it.
async function purgeRepoAnchors(service, sessionId, tally) {
  const root = backgroundRuntimeRoot(service);
  if (!root || !isRuntimeSessionId(sessionId)) return;
  tally.add(await removeContainedDir(root, ['repo-anchors', sessionId]));
}

// A finished background job's `<workspace>/.jenny/tool-results/<job>` output.
// The tracker is the only session-to-job map; jobs it no longer holds (evicted
// or from before a restart) and still-running jobs are left alone.
async function purgeJobOutputs(service, sessionId, tally) {
  const roots = service.backgroundJobTracker?.getSessionJobRoots?.(sessionId);
  if (!Array.isArray(roots)) return;
  let failed = 0;
  for (const { jobId, workspaceRoot } of roots) {
    if (!BACKGROUND_JOB_ID_PATTERN.test(String(jobId)) || typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) continue;
    try {
      tally.add(await removeContainedDir(workspaceRoot, ['.jenny', 'tool-results', jobId]));
    } catch (_error) {
      failed += 1;
    }
  }
  if (failed) throw new Error('some job output could not be removed');
}

async function sessionIdOfDiagnostic(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(DIAGNOSTIC_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const match = /"session_id"\s*:\s*("(?:[^"\\]|\\.)*"|null)/.exec(buffer.toString('utf8', 0, bytesRead));
    return match && match[1] !== 'null' ? JSON.parse(match[1]) : null;
  } finally {
    await handle.close();
  }
}

// Turn diagnostics: `diagnostics/<date>/<streamId>.json` names the chat only
// inside the file, and persisted chats do not reliably carry the stream ids of
// their failed turns (a truncated or edited chat drops them), so the files are
// found by header. That is one bounded scan, so deletes only queue the chat id;
// ONE background pass, debounced after the last delete, serves every chat queued
// meanwhile (a "Delete all" is a single scan, not one per chat). It never blocks
// or degrades a delete: failures are logged by code only.
const pendingDiagnostics = new Map(); // userDataPath -> { ids: Set, timer }
const runningSweeps = new Map(); // userDataPath -> Promise

function logSweep(service, level, event, details) {
  try {
    service._emitServiceLog?.(level, event, details);
  } catch (_error) { /* diagnostics listeners cannot affect a purge */ }
}

function countReason(reasons, error) {
  const reason = boundedReason(error, 'failed');
  reasons.set(reason, (reasons.get(reason) || 0) + 1);
}

// Newest day first; at most MAX_DIAGNOSTIC_FILES_SCANNED files, as the dump's own retention cap.
async function listDiagnosticFiles(userDataPath, reasons) {
  const files = [];
  const root = resolveContained(userDataPath, ['diagnostics']);
  if (!root?.stat.isDirectory()) return files;
  const days = (await fs.promises.readdir(root.path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && DIAGNOSTIC_DATE_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const day of days) {
    if (files.length >= MAX_DIAGNOSTIC_FILES_SCANNED) break;
    try {
      const dir = resolveContained(userDataPath, ['diagnostics', day]);
      if (!dir?.stat.isDirectory()) continue;
      for (const entry of await fs.promises.readdir(dir.path, { withFileTypes: true })) {
        if (files.length >= MAX_DIAGNOSTIC_FILES_SCANNED) break;
        if (entry.isFile() && entry.name.endsWith('.json')) files.push({ day, name: entry.name });
      }
    } catch (error) {
      countReason(reasons, error);
    }
  }
  return files;
}

async function sweepTurnDiagnostics(service, userDataPath, sessionIds) {
  const reasons = new Map();
  let removed = 0;
  let files = [];
  try {
    files = await listDiagnosticFiles(userDataPath, reasons);
  } catch (error) {
    countReason(reasons, error);
  }
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const { day, name } = files[next];
      next += 1;
      try {
        const owner = await sessionIdOfDiagnostic(path.join(userDataPath, 'diagnostics', day, name));
        if (owner === null || !sessionIds.has(owner)) continue;
        const result = await removeContained(userDataPath, ['diagnostics', day, name]);
        if (result.removed) removed += 1;
      } catch (error) {
        countReason(reasons, error);
      }
    }
  };
  await Promise.all(Array.from({ length: DIAGNOSTIC_SWEEP_CONCURRENCY }, worker));
  logSweep(service, reasons.size ? 'WARN' : 'INFO', 'session.turn_diagnostics_swept', {
    sessions: sessionIds.size,
    scanned: files.length,
    removed,
    failed: Object.fromEntries(reasons),
  });
}

function startDiagnosticSweep(service, userDataPath) {
  const entry = pendingDiagnostics.get(userDataPath);
  if (!entry) return runningSweeps.get(userDataPath) || Promise.resolve();
  clearTimeout(entry.timer);
  pendingDiagnostics.delete(userDataPath);
  const previous = runningSweeps.get(userDataPath) || Promise.resolve();
  const sweep = previous
    .then(() => sweepTurnDiagnostics(service, userDataPath, entry.ids))
    .catch((error) => logSweep(service, 'WARN', 'session.turn_diagnostics_sweep_failed', { code: boundedReason(error, 'failed') }))
    .finally(() => {
      if (runningSweeps.get(userDataPath) === sweep) runningSweeps.delete(userDataPath);
    });
  runningSweeps.set(userDataPath, sweep);
  return sweep;
}

// Queues the chat for the next diagnostics sweep; never throws, never waits.
function scheduleTurnDiagnosticsPurge(service, sessionId) {
  const userDataPath = service.options?.userDataPath;
  if (!userDataPath || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) return;
  const entry = pendingDiagnostics.get(userDataPath) || { ids: new Set(), timer: null };
  if (entry.ids.size < MAX_PENDING_DIAGNOSTIC_SESSIONS) entry.ids.add(sessionId);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { startDiagnosticSweep(service, userDataPath); }, DIAGNOSTIC_SWEEP_DELAY_MS);
  entry.timer.unref?.();
  pendingDiagnostics.set(userDataPath, entry);
}

// Runs whatever is queued for this profile now and resolves when it is done
// (shutdown flush and tests).
function drainTurnDiagnosticsPurges(service) {
  const userDataPath = service.options?.userDataPath;
  return userDataPath ? startDiagnosticSweep(service, userDataPath) : Promise.resolve();
}

async function statBatches(paths, visit) {
  for (let index = 0; index < paths.length; index += WATCH_BATCH) {
    const batch = paths.slice(index, index + WATCH_BATCH);
    const stats = await Promise.all(batch.map((filePath) => lstatOrNull(filePath).then((stat) => ({ stat }), () => ({ unreadable: true }))));
    stats.forEach((result, offset) => visit(batch[offset], result));
  }
}

// Candidate files whose disappearance after the delete is counted as freed.
// Taken before any step runs; a file another chat still references stays and is
// not counted. Steps that remove trees report their own counts through add().
// Statting is asynchronous and batched, so up to 2000 candidates never hold
// the main thread.
async function beginFreedTally(service, sessionId, { assetPaths = [], payloadPaths = [] } = {}) {
  const candidates = new Set();
  const consider = (filePath) => {
    if (candidates.size < MAX_WATCHED_FILES && typeof filePath === 'string' && filePath) candidates.add(filePath);
  };
  try {
    for (const assetPath of assetPaths) consider(assetPath);
    const payloadRoot = service.ipcPayloadStore?.rootDir;
    if (payloadRoot) for (const key of payloadPaths) consider(path.join(payloadRoot, String(key)));
    const todoFile = todoListFileName(sessionId);
    if (todoFile && service.options?.userDataPath) consider(path.join(service.options.userDataPath, 'todo-lists', todoFile));
  } catch (_error) { /* counting is best effort */ }
  const watched = new Map();
  await statBatches([...candidates], (filePath, { stat }) => {
    if (stat?.isFile()) watched.set(filePath, stat.size);
  });
  let files = 0;
  let bytes = 0;
  const add = (freed) => {
    files += Number(freed?.files) || 0;
    bytes += Number(freed?.bytes) || 0;
  };
  return {
    add,
    async settle() {
      const sizes = new Map(watched);
      watched.clear();
      await statBatches([...sizes.keys()], (filePath, result) => {
        if (!result.unreadable && result.stat === null) add({ files: 1, bytes: sizes.get(filePath) });
      });
      return { files, bytes };
    },
  };
}

// `runStep` is cleanupDeletedSession's runDeleteCleanupStep (passed in so this
// module does not import backend-sessions).
async function runSessionPurges(service, sessionId, cleanupErrors, runStep, tally) {
  const steps = [
    ['repo_anchors', purgeRepoAnchors],
    ['job_outputs', purgeJobOutputs],
  ];
  for (const [step, purge] of steps) {
    await runStep(service, sessionId, cleanupErrors, step, () => purge(service, sessionId, tally));
  }
  scheduleTurnDiagnosticsPurge(service, sessionId);
}

module.exports = {
  beginFreedTally,
  drainTurnDiagnosticsPurges,
  isRuntimeSessionId,
  purgeJobOutputs,
  purgeRepoAnchors,
  runSessionPurges,
  scheduleTurnDiagnosticsPurge,
};
