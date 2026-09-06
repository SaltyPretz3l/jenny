'use strict';

// Developer-suite twin of services/workspace-test-runner-history.js. This
// intentionally copies that module's bounded read/write/getHistory,
// recordStart/recordFinish, and reconcileRunning shape without importing the
// app layer into scripts. Records are newest-first and never contain stdout.
// Whole-file read/modify/write updates can race across concurrent runner
// processes and lose telemetry; that is accepted because history is best-effort.
// Reconciliation is conservative so a live concurrent sibling is never marked
// interrupted merely because another runner observed its `running` record.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_MAX_RUNS = 100;
const HISTORY_PATH = path.join('tests', '.run-node-tests-safe-history.json');
const HISTORY_VERSION = 1;
const TREND_WINDOW = 10;
const SLOWEST_FILES_REPORTED = 5;
const RUNNING_STALE_MS = 6 * 60 * 60_000;
const FINISH_KEYS = [
  'status',
  'exitCode',
  'timestamp',
  'startedAt',
  'finishedAt',
  'elapsedMs',
  'durationMs',
  'files',
  'counts',
  'watchdogHits',
  'termination',
];

function emptyHistory() {
  return { version: HISTORY_VERSION, runs: [] };
}

function resolveHistoryPath(cwd = process.cwd()) {
  return path.join(cwd, HISTORY_PATH);
}

function readHistoryFile(historyPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.runs)) return emptyHistory();
    return { version: HISTORY_VERSION, runs: raw.runs };
  } catch {
    return emptyHistory();
  }
}

function createFileStore(historyPath) {
  return {
    read(defaultValue) {
      const state = readHistoryFile(historyPath);
      return state.runs.length > 0 || fs.existsSync(historyPath) ? state : defaultValue;
    },
    write(value) {
      fs.mkdirSync(path.dirname(historyPath), { recursive: true });
      const tempPath = `${historyPath}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
        fs.renameSync(tempPath, historyPath);
      } finally {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // The successful rename already removed the temporary path.
        }
      }
    },
  };
}

function createSafeRunnerHistory(deps = {}) {
  const historyPath = deps.historyPath || resolveHistoryPath(deps.cwd);
  const store = deps.store || createFileStore(historyPath);
  const maxRuns = Number.isInteger(deps.maxRuns) && deps.maxRuns > 0
    ? deps.maxRuns
    : DEFAULT_MAX_RUNS;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const runningStaleMs = Number.isFinite(deps.runningStaleMs) && deps.runningStaleMs > 0
    ? deps.runningStaleMs
    : RUNNING_STALE_MS;
  const pidIsAlive = typeof deps.pidIsAlive === 'function' ? deps.pidIsAlive : isPidAlive;

  function read() {
    const raw = store.read(emptyHistory());
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.runs)) return emptyHistory();
    return { version: HISTORY_VERSION, runs: raw.runs };
  }

  function write(state) {
    store.write({ version: HISTORY_VERSION, runs: state.runs });
  }

  function getHistory() {
    return read().runs;
  }

  function recordStart(record) {
    const state = read();
    const pid = Number(record && record.pid);
    state.runs.unshift({
      runId: String(record && record.runId || ''),
      status: 'running',
      timestamp: record && record.timestamp || null,
      startedAt: record && record.startedAt || null,
      finishedAt: null,
      exitCode: null,
      elapsedMs: null,
      durationMs: null,
      files: [],
      counts: emptyCounts(),
      watchdogHits: [],
      ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    });
    state.runs = state.runs.slice(0, maxRuns);
    write(state);
  }

  function recordFinish(runId, patch) {
    const state = read();
    const applied = {};
    for (const key of FINISH_KEYS) {
      if (patch && patch[key] !== undefined) applied[key] = patch[key];
    }
    const index = state.runs.findIndex((entry) => entry && entry.runId === runId);
    if (index >= 0) {
      state.runs[index] = { ...state.runs[index], ...applied };
    } else {
      state.runs.unshift({
        runId: String(runId || ''),
        status: 'error',
        timestamp: null,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        elapsedMs: null,
        durationMs: null,
        files: [],
        counts: emptyCounts(),
        watchdogHits: [],
        ...applied,
      });
      state.runs = state.runs.slice(0, maxRuns);
    }
    write(state);
  }

  function reconcileRunning() {
    const state = read();
    const stampDate = now();
    const stamp = stampDate.toISOString();
    const nowMs = stampDate.getTime();
    let changed = 0;
    state.runs = state.runs.map((entry) => {
      if (!entry || entry.status !== 'running') return entry;
      const startedMs = Date.parse(entry.startedAt || entry.timestamp || '');
      const staleByAge = Number.isFinite(startedMs) && nowMs - startedMs >= runningStaleMs;
      const pid = Number(entry.pid);
      const deadPid = Number.isInteger(pid) && pid > 0 && !pidIsAlive(pid);
      if (!staleByAge && !deadPid) return entry;
      changed += 1;
      return { ...entry, status: 'interrupted', finishedAt: entry.finishedAt || stamp };
    });
    if (changed > 0) write(state);
    return changed;
  }

  return { read, getHistory, recordStart, recordFinish, reconcileRunning, historyPath };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function emptyCounts() {
  return { passed: 0, failed: 0, infra: 0, timeout: 0, aborted: 0, notRun: 0 };
}

function statusOf(record) {
  if (record && record.timedOut) return 'timeout';
  if (record && record.collateralKilled) return 'aborted';
  if (record && record.infrastructureFailure) return 'infra';
  return record && record.code === 0 ? 'passed' : 'failed';
}

function normalizeDuration(value) {
  const durationMs = Number(value);
  return Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0;
}

function normalizeTermination(value) {
  if (!value || typeof value !== 'object') return null;
  const inFlight = Array.isArray(value.inFlight)
    ? [...new Set(value.inFlight.map((file) => String(file || '')).filter(Boolean))]
    : [];
  const exitCode = Number.isInteger(value.exitCode) ? value.exitCode : null;
  const reason = typeof value.reason === 'string' ? value.reason : '';
  const timeoutMs = normalizeDuration(value.timeoutMs);
  return {
    inFlight,
    reason,
    exitCode,
    ...(timeoutMs > 0 ? { timeoutMs } : {}),
  };
}

function buildRunRecord(options = {}) {
  const startedAt = options.startedAt instanceof Date
    ? options.startedAt.toISOString()
    : new Date(options.startedAt || Date.now()).toISOString();
  const finishedAt = options.finishedAt instanceof Date
    ? options.finishedAt.toISOString()
    : new Date(options.finishedAt || Date.now()).toISOString();
  const elapsedMs = normalizeDuration(options.elapsedMs);
  const counts = emptyCounts();
  const files = [];
  const watchdogHits = [];
  const termination = normalizeTermination(options.termination);
  const terminationFiles = new Set(termination ? termination.inFlight : []);
  const globalWatchdogHit = termination && termination.exitCode === 124;
  const recordedFiles = new Set();

  for (const result of Array.isArray(options.results) ? options.results : []) {
    const file = String(result && result.file || '');
    const terminatedInFlight = terminationFiles.has(file);
    const timedOut = Boolean(result && result.timedOut) || Boolean(globalWatchdogHit && terminatedInFlight);
    const status = timedOut ? 'timeout' : (terminatedInFlight ? 'aborted' : statusOf(result));
    counts[status] += 1;
    recordedFiles.add(file);
    files.push({
      file,
      status,
      durationMs: normalizeDuration(result && result.durationMs),
      timedOut,
    });
    if (timedOut) {
      watchdogHits.push({
        file,
        timeoutMs: terminatedInFlight && globalWatchdogHit
          ? normalizeDuration(termination.timeoutMs)
          : normalizeDuration(result && result.perFileTimeoutMs),
      });
    }
  }

  for (const file of Array.isArray(options.notRun) ? options.notRun : []) {
    counts.notRun += 1;
    files.push({ file: String(file || ''), status: 'notRun', durationMs: 0, timedOut: false });
  }

  for (const file of terminationFiles) {
    if (recordedFiles.has(file)) continue;
    const status = globalWatchdogHit ? 'timeout' : 'aborted';
    counts[status] += 1;
    files.push({ file, status, durationMs: 0, timedOut: Boolean(globalWatchdogHit) });
    if (globalWatchdogHit) {
      watchdogHits.push({ file, timeoutMs: normalizeDuration(termination.timeoutMs) });
    }
  }

  const status = counts.timeout > 0
    ? 'timeout'
    : (counts.failed + counts.infra + counts.aborted + counts.notRun > 0 ? 'failed' : 'passed');
  return {
    runId: String(options.runId || randomUUID()),
    status,
    exitCode: termination && Number.isInteger(termination.exitCode)
      ? termination.exitCode
      : (Number.isInteger(options.exitCode) ? options.exitCode : (status === 'passed' ? 0 : 1)),
    timestamp: startedAt,
    startedAt,
    finishedAt,
    elapsedMs,
    durationMs: elapsedMs,
    files,
    counts,
    watchdogHits,
    ...(termination ? { termination } : {}),
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function comparableDuration(fileRecord) {
  if (!fileRecord || fileRecord.timedOut) return null;
  if (!['passed', 'failed', 'infra'].includes(fileRecord.status)) return null;
  const durationMs = Number(fileRecord.durationMs);
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}

function priorMedianForFile(file, previousRuns, windowSize = TREND_WINDOW) {
  const durations = [];
  for (const run of previousRuns) {
    const records = run && Array.isArray(run.files) ? run.files : [];
    const match = records.find((entry) => entry && entry.file === file);
    const durationMs = comparableDuration(match);
    if (durationMs !== null) durations.push(durationMs);
    if (durations.length >= windowSize) break;
  }
  return median(durations);
}

function trendForDuration(durationMs, priorMedian) {
  if (priorMedian === null) return 'flat';
  const ratio = priorMedian === 0 ? (durationMs === 0 ? 1 : Infinity) : durationMs / priorMedian;
  return ratio > 1.1 ? 'slower' : (ratio < 0.9 ? 'faster' : 'flat');
}

function formatDuration(durationMs) {
  return `${(normalizeDuration(durationMs) / 1000).toFixed(1)}s`;
}

function formatRunTrendBlock(run, previousRuns = []) {
  const slowest = run.files
    .filter((record) => comparableDuration(record) !== null)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, SLOWEST_FILES_REPORTED);
  const lines = ['[run-node-tests-safe] trends: slowest 5 files this run (vs median of prior 10 runs)'];
  if (slowest.length === 0) {
    lines.push('[run-node-tests-safe]   none');
  } else {
    for (const record of slowest) {
      const priorMedian = priorMedianForFile(record.file, previousRuns);
      const trend = trendForDuration(record.durationMs, priorMedian);
      const baseline = priorMedian === null ? 'no prior samples' : `median ${formatDuration(priorMedian)}`;
      lines.push(
        `[run-node-tests-safe]   ${record.file} (${formatDuration(record.durationMs)}): ${trend} (${baseline})`
      );
    }
  }
  lines.push(`[run-node-tests-safe] hangs: ${run.watchdogHits.length}`);
  return lines.join('\n');
}

function startRunHistory(options = {}) {
  const history = createSafeRunnerHistory({ cwd: options.cwd, historyPath: options.historyPath });
  history.reconcileRunning();
  const startedAt = options.startedAt instanceof Date
    ? options.startedAt.toISOString()
    : new Date(options.startedAt || Date.now()).toISOString();
  const runId = String(options.runId || randomUUID());
  history.recordStart({
    runId,
    timestamp: startedAt,
    startedAt,
    pid: Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid,
  });
  return { historyPath: history.historyPath, runId };
}

function finishRunHistory(options = {}) {
  const history = createSafeRunnerHistory({ cwd: options.cwd, historyPath: options.historyPath });
  const previousRuns = history.getHistory().filter((entry) => entry && entry.runId !== options.runId);
  const run = buildRunRecord(options);
  history.recordFinish(run.runId, run);
  const trendBlock = formatRunTrendBlock(run, previousRuns);
  console.log(trendBlock);
  return { historyPath: history.historyPath, run, trendBlock };
}

module.exports = {
  DEFAULT_MAX_RUNS,
  HISTORY_PATH,
  RUNNING_STALE_MS,
  TREND_WINDOW,
  resolveHistoryPath,
  readHistoryFile,
  createSafeRunnerHistory,
  buildRunRecord,
  priorMedianForFile,
  trendForDuration,
  formatRunTrendBlock,
  startRunHistory,
  finishRunHistory,
};
