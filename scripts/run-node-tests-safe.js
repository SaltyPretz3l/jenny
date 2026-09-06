#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { killProcessTree, waitForProcessExit } = require('../services/backend/process-utils');
const { createRunMonitor } = require('./run-node-tests-monitor');
const {
  formatRunSummary,
  hasTapTestEvents,
  isInfrastructureFailure,
  reportFileResult,
  retryInfrastructureFailures,
} = require('./run-node-tests-safe-reporting');
const { startRunHistory, finishRunHistory } = require('./run-node-tests-safe-history');

const PER_FILE_TERMINATION_GRACE_MS = 5_000;
const RUN_TERMINATION_EXIT_GRACE_MS = 5_000;
const {
  LOAD_TEST_PATTERN,
  normalizeRepoPath,
  normalizeChildArgPath,
  isSequentialTestPath,
  isStableLaneExcludedPath,
  partitionChildArgs,
  selectRunGroups,
  laneOverlapEnabled,
  loadQuarantineOverrides,
  applyChildArgFilters,
  collectRerunTargets,
  parseShardSpec,
  writeLastRun,
  writeJunitReport,
} = require('./run-node-tests-safe-support');

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PER_FILE_TIMEOUT_MS = 120_000;
// Clamp ceiling for --parallel-workers=N / JENNY_TEST_WORKERS.
const MAX_PARALLEL_WORKERS = 16;
// JENNY_TEST_WORKERS overrides the default of 12; --parallel-workers=N wins
// over both. Sequential-risk suites remain one-at-a-time.
const DEFAULT_PARALLEL_WORKERS = resolveDefaultParallelWorkers();

function resolveDefaultParallelWorkers() {
  const raw = process.env.JENNY_TEST_WORKERS;
  if (raw !== undefined && raw !== '') {
    const candidate = Number(raw);
    if (Number.isFinite(candidate) && candidate > 0) {
      return Math.min(MAX_PARALLEL_WORKERS, Math.max(1, Math.floor(candidate)));
    }
  }
  return 12;
}
const DEFAULT_LOCK_WAIT_MS = 900_000;
const LOCK_POLL_MS = 5_000;
const LOCK_WAIT_LOG_INTERVAL_MS = 15_000;
const LOCK_STALE_MS = 60 * 60_000;
const LOCK_BASENAME = '.test-run.lock';
const LOCK_ENV_VAR = 'JENNY_TEST_RUN_LOCK';
const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;
const EXIT_STREAM_FLUSH_GRACE_MS = 2_000;
const TIMEOUTS_PATH = path.join('tests', '.timeouts.json');
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
]);
// SEQUENTIAL_BASENAME_PATTERNS, the stable-lane exclusion list, and
// LOAD_TEST_PATTERN live in ./run-node-tests-safe-support.js (lane-selection
// section) so this file stays under the 1015-line ceiling.

function loadTimeoutOverrides(cwd = process.cwd()) {
  const timeoutPath = path.join(cwd, TIMEOUTS_PATH);
  try {
    const payload = JSON.parse(fs.readFileSync(timeoutPath, 'utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {};
    }
    const normalized = {};
    for (const [rawPath, rawTimeout] of Object.entries(payload)) {
      const timeoutMs = Number(rawTimeout);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        continue;
      }
      normalized[normalizeRepoPath(rawPath)] = Math.floor(timeoutMs);
    }
    return normalized;
  } catch {
    return {};
  }
}

function expandDirectoryArg(arg, options = {}) {
  const { includeLoad = false, excluded = null } = options;
  let stat;
  try {
    stat = fs.statSync(arg);
  } catch {
    return [arg];
  }
  if (!stat.isDirectory()) return [arg];
  const matches = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (entry.isFile() && /\.test\.(c|m)?js$/.test(entry.name)) {
        if (!includeLoad && LOAD_TEST_PATTERN.test(entry.name)) {
          if (excluded) excluded.push(full);
          continue;
        }
        matches.push(full);
      }
    }
  };
  walk(arg);
  return matches;
}

function resolveTimeoutMs(childArgs, explicitTimeoutMs, cwd = process.cwd()) {
  if (Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0) {
    return Math.floor(explicitTimeoutMs);
  }
  const overrides = loadTimeoutOverrides(cwd);
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (const childArg of childArgs) {
    const normalized = normalizeChildArgPath(childArg, cwd);
    if (Number.isFinite(overrides[normalized]) && overrides[normalized] > timeoutMs) {
      timeoutMs = overrides[normalized];
    }
  }
  return timeoutMs;
}

function resolvePerFileTimeoutMs(childArg, options = {}) {
  if (Number.isFinite(options.explicitMs) && options.explicitMs > 0) {
    return Math.floor(options.explicitMs);
  }
  const overrides = options.overrides || {};
  const normalized = normalizeChildArgPath(childArg, options.cwd || process.cwd());
  let timeoutMs = DEFAULT_PER_FILE_TIMEOUT_MS;
  if (Number.isFinite(overrides[normalized]) && overrides[normalized] > timeoutMs) {
    timeoutMs = overrides[normalized];
  }
  return timeoutMs;
}

function normalizeParallelWorkers(rawWorkers) {
  const candidate = Number(rawWorkers);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_PARALLEL_WORKERS;
  }
  return Math.min(MAX_PARALLEL_WORKERS, Math.max(1, Math.floor(candidate)));
}

function parseArgs(argv, options = {}) {
  const childArgs = [];
  let explicitTimeoutMs = null;
  let explicitPerFileTimeoutMs = null;
  let useDefaultTestFlags = true;
  let sequentialOnly = false;
  let parallelOnly = false;
  let failFast = false;
  // Lane overlap default-ON; JENNY_TEST_LANE_OVERLAP=0 is the env rollback and
  // --no-lane-overlap the per-run rollback to strict parallel-then-sequential.
  let laneOverlap = process.env.JENNY_TEST_LANE_OVERLAP !== '0';
  let verbose = false;
  let noLock = false;
  let lockWaitMs = DEFAULT_LOCK_WAIT_MS;
  let parallelWorkers = DEFAULT_PARALLEL_WORKERS;
  let junitPath = null;
  let lastFailed = false;
  let changed = false;
  let shard = null;
  const cwd = options.cwd || process.cwd();
  // Detected before the loop so directory expansion honors it regardless of arg
  // order. When false, *.load.test.js files are dropped from directory discovery.
  const includeLoad = argv.includes('--include-load');
  const excludedLoadFiles = [];

  for (const arg of argv) {
    if (arg === '--no-default-test-flags') {
      useDefaultTestFlags = false;
      continue;
    }
    if (arg === '--include-load') {
      continue;
    }
    if (arg === '--sequential-only') {
      sequentialOnly = true;
      continue;
    }
    if (arg === '--parallel-only') {
      parallelOnly = true;
      continue;
    }
    if (arg === '--fail-fast') {
      failFast = true;
      continue;
    }
    if (arg === '--no-lane-overlap') {
      laneOverlap = false;
      continue;
    }
    if (arg === '--verbose') {
      verbose = true;
      continue;
    }
    if (arg === '--no-lock') {
      noLock = true;
      continue;
    }
    if (arg.startsWith('--lock-wait-ms=')) {
      const candidate = Number(arg.slice('--lock-wait-ms='.length));
      if (Number.isFinite(candidate) && candidate >= 0) {
        lockWaitMs = Math.floor(candidate);
      }
      continue;
    }
    if (arg.startsWith('--parallel-workers=')) {
      parallelWorkers = normalizeParallelWorkers(arg.slice('--parallel-workers='.length));
      continue;
    }
    if (arg.startsWith('--junit=')) {
      const value = arg.slice('--junit='.length).trim();
      if (value) junitPath = value;
      continue;
    }
    if (arg === '--last-failed') {
      lastFailed = true;
      continue;
    }
    if (arg === '--changed') {
      changed = true;
      continue;
    }
    if (arg.startsWith('--shard=')) {
      shard = parseShardSpec(arg.slice('--shard='.length));
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      const candidate = Number(arg.slice('--timeout-ms='.length));
      if (Number.isFinite(candidate) && candidate > 0) {
        explicitTimeoutMs = Math.floor(candidate);
      }
      continue;
    }
    if (arg.startsWith('--per-file-timeout-ms=')) {
      const candidate = Number(arg.slice('--per-file-timeout-ms='.length));
      if (Number.isFinite(candidate) && candidate > 0) {
        explicitPerFileTimeoutMs = Math.floor(candidate);
      }
      continue;
    }
    // Expand directory arguments to *.test.js files so `tests/` works
    // alongside explicit file paths. Non-directory args pass through.
    for (const expanded of expandDirectoryArg(arg, { includeLoad, excluded: excludedLoadFiles })) {
      childArgs.push(expanded);
    }
  }

  // --last-failed / --changed narrow the matched set post-expansion. Injectable
  // sets (options.lastFailedSet/changedSet) keep this unit-testable; with neither
  // flag this is a no-op passthrough so default `npm test` is byte-identical.
  const filterResult = applyChildArgFilters(childArgs, {
    lastFailed,
    changed,
    cwd,
    lastFailedSet: options.lastFailedSet,
    changedSet: options.changedSet,
  });
  const effectiveChildArgs = filterResult.childArgs;

  const timeoutMs = resolveTimeoutMs(effectiveChildArgs, explicitTimeoutMs, cwd);
  const timeoutOverrides = loadTimeoutOverrides(cwd);
  const quarantineOverrides = loadQuarantineOverrides(cwd);
  return {
    childArgs: effectiveChildArgs,
    parallelWorkers,
    sequentialOnly,
    parallelOnly,
    failFast,
    laneOverlap,
    verbose,
    noLock,
    lockWaitMs,
    timeoutMs,
    perFileTimeoutMs: explicitPerFileTimeoutMs,
    timeoutOverrides,
    quarantineOverrides,
    useDefaultTestFlags,
    includeLoad,
    excludedLoadFiles,
    junitPath,
    lastFailed,
    changed,
    shard,
    filterApplied: filterResult.filtered,
    filterNote: filterResult.note,
  };
}

function appendCapturedChunk(captured, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  captured.chunks.push(buffer);
  captured.bytes += buffer.length;
  while (captured.bytes > MAX_CAPTURED_OUTPUT_BYTES && captured.chunks.length > 1) {
    const dropped = captured.chunks.shift();
    captured.bytes -= dropped.length;
    captured.truncated = true;
  }
}

function capturedText(captured) {
  const text = Buffer.concat(captured.chunks).toString('utf8');
  return captured.truncated
    ? `[run-node-tests-safe] (output truncated to last ${MAX_CAPTURED_OUTPUT_BYTES} bytes)\n${text}`
    : text;
}

// Children must start as fresh top-level test runs. When this runner is
// itself invoked from inside a node:test worker (pre-commit hooks, nested
// tooling), the worker's NODE_TEST_CONTEXT leaks into process.env and makes
// `node --test` children silently run zero tests and exit 0.
function buildChildEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runCapturedChild(runnerArgs, {
  activeChildren,
  timeoutMs,
  spawnImpl = spawn,
  killProcessTreeImpl = killProcessTree,
  waitForProcessExitImpl = waitForProcessExit,
  terminationGraceMs = PER_FILE_TERMINATION_GRACE_MS,
}) {
  return new Promise((resolve) => {
    const child = spawnImpl(process.execPath, runnerArgs, {
      cwd: process.cwd(),
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeChildren.add(child);
    const captured = { chunks: [], bytes: 0, truncated: false };
    child.stdout.on('data', (chunk) => appendCapturedChunk(captured, chunk));
    child.stderr.on('data', (chunk) => appendCapturedChunk(captured, chunk));

    let settled = false;
    let timedOut = false;
    let terminationFailed = false;
    let watchdog = null;
    let flushGrace = null;

    const terminateTimedOutChild = async () => {
      let terminated = !child.pid;
      if (child.pid) {
        const outcome = await killProcessTreeImpl(child.pid, {
          force: true,
          confirmExit: true,
          timeoutMs: terminationGraceMs,
        }).catch(() => ({ terminated: false }));
        terminated = outcome?.terminated === true;
        if (!terminated) {
          try {
            child.kill?.('SIGKILL');
          } catch (_error) {
            // The tree kill above remains the authoritative termination path.
          }
          terminated = await waitForProcessExitImpl(child.pid, terminationGraceMs).catch(() => false);
        }
      }
      terminationFailed = !terminated;
      if (terminationFailed) {
        appendCapturedChunk(
          captured,
          '[run-node-tests-safe] timed-out child process tree termination was not confirmed\n'
        );
      }
      // A leaked descendant can retain the inherited pipe handles even after
      // the test process exits. Do not let those handles prevent the watchdog
      // result from settling once process-tree termination has been attempted.
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      if (terminationFailed) child.unref?.();
      finish(124);
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      watchdog = setTimeout(() => {
        timedOut = true;
        void terminateTimedOutChild();
      }, timeoutMs);
      if (typeof watchdog.unref === 'function') watchdog.unref();
    }

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      if (flushGrace) clearTimeout(flushGrace);
      if (!terminationFailed) activeChildren.delete(child);
      resolve({
        code,
        timedOut,
        terminationFailed,
        // killActiveChildren tags children it force-kills (fail-fast abort or
        // shutdown); such a kill is collateral, not a genuine test failure.
        // Tag-based (not signal-based) deliberately: Windows taskkill /F yields a
        // non-zero exit code with NO POSIX signal, so keying off `signal` would
        // misclassify every real Windows kill. Best-effort: a sibling that
        // genuinely fails in the tiny window between tag and kill is labeled
        // aborted, but the run still exits non-zero via resolveOverallExitCode
        // (which ignores this flag), so correctness is unaffected.
        collateralKilled: child.__externallyKilled === true && !timedOut,
        output: capturedText(captured),
      });
    };

    child.once('error', (error) => {
      appendCapturedChunk(captured, `[run-node-tests-safe] failed to start child process: ${error.message}\n`);
      finish(1);
    });
    // 'close' guarantees the stdio pipes drained; a leaked grandchild can hold
    // the pipes open after exit, so a short grace timer forces settlement.
    child.once('close', (code, signal) => {
      if (timedOut) return;
      finish(resolveChildExitCode(code, signal, timedOut, captured));
    });
    child.once('exit', (code, signal) => {
      if (timedOut) return;
      activeChildren.delete(child);
      flushGrace = setTimeout(() => {
        finish(resolveChildExitCode(code, signal, timedOut, captured));
      }, EXIT_STREAM_FLUSH_GRACE_MS);
      if (typeof flushGrace.unref === 'function') flushGrace.unref();
    });
  });
}

function resolveChildExitCode(code, signal, timedOut, captured) {
  if (timedOut) return 124;
  if (signal) {
    appendCapturedChunk(captured, `[run-node-tests-safe] child exited from signal ${signal}\n`);
    return 1;
  }
  return Number.isInteger(code) ? code : 1;
}

async function runManagedFile(file, parsed, state) {
  const perFileTimeoutMs = resolvePerFileTimeoutMs(file, {
    explicitMs: parsed.perFileTimeoutMs,
    overrides: parsed.timeoutOverrides,
  });
  const display = normalizeChildArgPath(file);
  const quarantine = parsed.quarantineOverrides ? parsed.quarantineOverrides[display] : null;
  const maxAttempts = quarantine ? quarantine.retries + 1 : 1;
  const startedAt = Date.now();
  state.inFlight.add(display);
  state.monitor.fileStarted(display, perFileTimeoutMs, startedAt);
  let result;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    result = await runCapturedChild(['--test', file], {
      activeChildren: state.activeChildren,
      timeoutMs: perFileTimeoutMs,
    });
    if (result.code === 0) break;
    // Quarantine retry only re-runs an honest non-zero exit (the flaky-failure
    // signature). A timeout (hang) is never retried -- it only burns the global
    // budget -- and a collateral fail-fast/shutdown kill means the whole run is
    // already tearing down.
    if (result.timedOut || result.collateralKilled || attempt >= maxAttempts) break;
    console.error(
      `[run-node-tests-safe] RETRY ${display} (quarantined flake, attempt ${attempt}/${maxAttempts}, ` +
        `exit ${result.code}); ${quarantine.reason || 'see tests/.quarantine.json'}`
    );
  }
  state.inFlight.delete(display);
  state.monitor.fileFinished(display);
  const record = {
    file: display,
    code: result.code,
    timedOut: result.timedOut,
    terminationFailed: result.terminationFailed === true,
    collateralKilled: result.collateralKilled === true,
    durationMs: Date.now() - startedAt,
    perFileTimeoutMs,
    output: result.output,
    attempts,
    recovered: Boolean(quarantine) && result.code === 0 && attempts > 1,
    infrastructureFailure: isInfrastructureFailure(file, result),
  };
  state.results.push(record);
  reportFileResult(record, parsed.verbose);
  if (record.code === 0 && !record.timedOut) {
    record.output = null;
  }
  return record;
}

async function runManagedPlan(parsed, state) {
  const groups = selectRunGroups(parsed);
  const { parallelArgs, sequentialArgs } = groups;

  let aborted = false;
  let nextIndex = 0;
  let seqIndex = 0;

  const abortRemaining = async (failedFile, reason = '--fail-fast') => {
    aborted = true;
    console.error(
      `[run-node-tests-safe] ${reason}: aborting remaining files after ${failedFile} failed`
    );
    await killActiveChildren(state.activeChildren);
  };

  const retryInfrastructureFailuresOrAbort = async () => {
    const unconfirmedTermination = await retryInfrastructureFailures(
      parsed,
      state,
      runCapturedChild
    );
    if (unconfirmedTermination) {
      await abortRemaining(
        unconfirmedTermination.file,
        'unconfirmed infrastructure retry termination'
      );
    }
  };

  async function worker() {
    while (nextIndex < parallelArgs.length && !aborted) {
      const file = parallelArgs[nextIndex];
      nextIndex += 1;
      const record = await runManagedFile(file, parsed, state);
      if (record.terminationFailed && !aborted) {
        await abortRemaining(record.file, 'unconfirmed timeout termination');
      } else if (
        record.code !== 0 && parsed.failFast && !record.infrastructureFailure && !aborted
      ) {
        await abortRemaining(record.file);
      }
    }
  }

  // The sequential lane stays one-at-a-time relative to ITSELF; overlap only
  // changes when it starts (alongside the pool instead of after it).
  async function sequentialWorker() {
    while (seqIndex < sequentialArgs.length && !aborted) {
      const file = sequentialArgs[seqIndex];
      seqIndex += 1;
      const record = await runManagedFile(file, parsed, state);
      if (record.terminationFailed && !aborted) {
        await abortRemaining(record.file, 'unconfirmed timeout termination');
      } else if (
        record.code !== 0 && parsed.failFast && !record.infrastructureFailure && !aborted
      ) {
        await abortRemaining(record.file);
      }
    }
  }

  if (laneOverlapEnabled(parsed, groups)) {
    // Reserve one worker slot for the sequential chain so total child
    // concurrency stays at parsed.parallelWorkers.
    const poolWidth = Math.min(parsed.parallelWorkers - 1, parallelArgs.length);
    await Promise.all([
      ...Array.from({ length: poolWidth }, () => worker()),
      sequentialWorker(),
    ]);
    await retryInfrastructureFailuresOrAbort();
  } else {
    const workerCount = Math.min(parsed.parallelWorkers, parallelArgs.length);
    if (workerCount > 0) {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }
    await retryInfrastructureFailuresOrAbort();
    if (!aborted) {
      await sequentialWorker();
      await retryInfrastructureFailuresOrAbort();
    }
  }

  if (aborted) {
    for (const file of [...parallelArgs.slice(nextIndex), ...sequentialArgs.slice(seqIndex)]) {
      state.notRun.push(normalizeChildArgPath(file));
    }
  }
}

function readLockPayload(lockPath) {
  try {
    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Serializes test runs across concurrent agent sessions sharing this working
// tree. Reentrant via LOCK_ENV_VAR so nested runner invocations (pre-commit
// hooks, diagnostics) do not deadlock against their parent run.
async function acquireRunLock(options = {}) {
  const cwd = options.cwd || process.cwd();
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : DEFAULT_LOCK_WAIT_MS;
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : LOCK_POLL_MS;
  const staleMs = Number.isFinite(options.staleMs) && options.staleMs > 0 ? options.staleMs : LOCK_STALE_MS;
  const log = typeof options.log === 'function' ? options.log : (message) => console.error(message);
  const lockPath = path.join(cwd, LOCK_BASENAME);
  const waitStartedAt = Date.now();
  let lastWaitLogAt = 0;

  for (;;) {
    try {
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          argv: process.argv.slice(2),
        }),
        { flag: 'wx' }
      );
      return {
        lockPath,
        release() {
          try {
            const payload = readLockPayload(lockPath);
            if (payload && payload.pid === process.pid) {
              fs.unlinkSync(lockPath);
            }
          } catch {
            // best-effort release; stale-lock detection covers leftovers
          }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const payload = readLockPayload(lockPath);
    const holderPid = Number(payload?.pid);
    const heldSinceMs = Date.parse(payload?.startedAt ?? '');
    const stale = !isPidAlive(holderPid)
      || (Number.isFinite(heldSinceMs) && Date.now() - heldSinceMs > staleMs);
    if (stale) {
      log(`[run-node-tests-safe] removing stale test-run lock (pid ${Number.isInteger(holderPid) ? holderPid : 'unknown'})`);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // another waiter may have removed it first
      }
      continue;
    }

    const elapsedWaitMs = Date.now() - waitStartedAt;
    if (elapsedWaitMs >= waitMs) {
      return null;
    }
    if (Date.now() - lastWaitLogAt >= LOCK_WAIT_LOG_INTERVAL_MS) {
      lastWaitLogAt = Date.now();
      log(
        `[run-node-tests-safe] waiting for test-run lock held by pid ${holderPid} ` +
          `since ${payload?.startedAt ?? 'unknown'} (another test run is active in this tree; --no-lock bypasses)`
      );
    }
    await sleep(Math.min(pollMs, Math.max(1, waitMs - elapsedWaitMs)));
  }
}

function spawnLegacyChild(runnerArgs, activeChildren) {
  const child = spawn(process.execPath, runnerArgs, {
    cwd: process.cwd(),
    env: buildChildEnv(),
    stdio: 'inherit',
    windowsHide: true,
  });
  activeChildren.add(child);
  child.once('exit', () => {
    activeChildren.delete(child);
  });
  child.once('error', () => {
    activeChildren.delete(child);
  });
  return new Promise((resolve) => {
    child.once('error', (error) => {
      console.error(`[run-node-tests-safe] failed to start child process: ${error.message}`);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(`[run-node-tests-safe] child exited from signal ${signal}`);
        resolve(1);
        return;
      }
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

async function killActiveChildren(activeChildren) {
  const children = [...activeChildren];
  await Promise.all(children.map(async (child) => {
    if (!child.pid) {
      return;
    }
    // Tag before killing so the child's settle records this as a collateral
    // (fail-fast / shutdown) kill rather than a genuine test failure.
    child.__externallyKilled = true;
    await killProcessTree(child.pid, { force: true }).catch(() => null);
    await waitForProcessExit(child.pid, 5000).catch(() => null);
  }));
}

function resolveOverallExitCode(state) {
  for (const record of state.results) {
    if (record.code !== 0) {
      return record.code === 124 ? 1 : record.code;
    }
  }
  return state.notRun.length > 0 ? 1 : 0;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const { timeoutMs } = parsed;
  if (parsed.excludedLoadFiles && parsed.excludedLoadFiles.length > 0) {
    console.log(
      `[run-node-tests-safe] excluded ${parsed.excludedLoadFiles.length} *.load.test.js perf file(s) ` +
        'from directory discovery (pass --include-load to run them; they ride the heavy lane / check:all)'
    );
  }
  if (parsed.filterNote) {
    console.log(`[run-node-tests-safe] ${parsed.filterNote}`);
  }
  const startedAt = Date.now();
  const managed = parsed.useDefaultTestFlags;
  const monitor = createRunMonitor({ startedAt, enabled: managed });
  const state = { activeChildren: new Set(), inFlight: new Set(), monitor, results: [], notRun: [] };

  if (managed && parsed.childArgs.length === 0) {
    if (parsed.filterApplied) {
      // A --last-failed/--changed filter matched nothing: there is genuinely
      // nothing to re-run, which is success, not a "no files matched" error.
      console.log('[run-node-tests-safe] no files matched the --last-failed/--changed filter; nothing to run');
      return;
    }
    console.error('[run-node-tests-safe] no test files matched the provided arguments');
    process.exitCode = 1;
    return;
  }

  let lock = null;
  if (!parsed.noLock && !process.env[LOCK_ENV_VAR]) {
    const effectiveLockWaitMs = Math.min(parsed.lockWaitMs, timeoutMs);
    lock = await acquireRunLock({ waitMs: effectiveLockWaitMs });
    if (lock === null) {
      console.error(
        `[run-node-tests-safe] gave up waiting for ${LOCK_BASENAME} after ${effectiveLockWaitMs}ms; ` +
          'another test run appears active in this tree. Re-run later or pass --no-lock to bypass.'
      );
      process.exitCode = 125;
      return;
    }
    process.env[LOCK_ENV_VAR] = String(process.pid);
  }

  const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
  if (remainingTimeoutMs <= 0) {
    if (lock) lock.release();
    console.error(
      `[run-node-tests-safe] timed out after ${timeoutMs}ms while waiting for the test-run lock`
    );
    process.exitCode = 124;
    return;
  }

  let settled = false;
  let timeoutTriggered = false;
  let terminationSnapshot = null;
  let historyRunId = null;
  if (managed) {
    try {
      historyRunId = startRunHistory({ cwd: process.cwd(), startedAt }).runId;
    } catch {
      // Developer telemetry must never fail or change the result of a test run.
    }
  }

  const printSummary = () => {
    if (!managed) return;
    const elapsedMs = Date.now() - startedAt;
    if (parsed.junitPath) {
      writeJunitReport(parsed.junitPath, {
        results: state.results,
        notRun: state.notRun,
        elapsedMs,
      });
    }
    if (historyRunId) {
      const runId = historyRunId;
      historyRunId = null;
      try {
        finishRunHistory({
          cwd: process.cwd(),
          runId,
          startedAt,
          elapsedMs,
          results: state.results,
          notRun: state.notRun,
          termination: terminationSnapshot,
          exitCode: terminationSnapshot?.exitCode ?? resolveOverallExitCode(state),
        });
      } catch {
        // Developer telemetry must never fail or change the result of a test run.
      }
    }
    console.log(formatRunSummary({
      results: state.results,
      notRun: state.notRun,
      inFlight: [...state.inFlight],
      elapsedMs,
    }));
  };

  const finish = async (code) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeoutHandle);
    monitor.dispose();
    if (lock) lock.release();
    process.exitCode = code;
  };

  const terminateRun = async (code, reason) => {
    if (settled) {
      return;
    }
    const inFlight = [...state.inFlight];
    timeoutTriggered = true;
    terminationSnapshot = {
      inFlight,
      reason,
      exitCode: code,
      ...(code === 124 ? { timeoutMs } : {}),
    };
    console.error(`[run-node-tests-safe] ${reason}`);
    if (inFlight.length > 0) {
      console.error(`[run-node-tests-safe] in-flight when terminated: ${inFlight.join(', ')}`);
    }
    await killActiveChildren(state.activeChildren);
    printSummary();
    await finish(code);
    // A killed test can leave an inherited handle or a platform-specific child
    // process handle referenced even after the tree-termination attempt. The
    // global budget is a hard contract: allow a short output-flush grace, then
    // exit with the already-recorded timeout/signal code instead of hanging.
    const forcedExit = setTimeout(() => process.exit(code), RUN_TERMINATION_EXIT_GRACE_MS);
    forcedExit.unref?.();
  };

  const timeoutHandle = setTimeout(() => {
    void terminateRun(124, `timed out after ${timeoutMs}ms (global run budget)`);
  }, remainingTimeoutMs);
  if (typeof timeoutHandle.unref === 'function') {
    timeoutHandle.unref();
  }

  const forwardSignal = (signal, code) => {
    process.once(signal, () => {
      void terminateRun(code, `received ${signal}`);
    });
  };
  forwardSignal('SIGINT', 130);
  forwardSignal('SIGTERM', 143);
  if (process.platform === 'win32') {
    forwardSignal('SIGBREAK', 149);
  }

  if (!managed) {
    const code = await spawnLegacyChild(parsed.childArgs, state.activeChildren);
    if (!timeoutTriggered) {
      await finish(code);
    }
    return;
  }

  await runManagedPlan(parsed, state);
  if (timeoutTriggered) {
    return;
  }
  printSummary();
  // Persist the non-passing set (gitignored) so a later `--last-failed` run can
  // re-run only what failed/timed-out/was-skipped this time.
  writeLastRun(process.cwd(), collectRerunTargets(state));
  await finish(resolveOverallExitCode(state));
}

if (require.main === module) {
  void main();
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PER_FILE_TIMEOUT_MS,
  DEFAULT_PARALLEL_WORKERS,
  DEFAULT_LOCK_WAIT_MS,
  PER_FILE_TERMINATION_GRACE_MS,
  RUN_TERMINATION_EXIT_GRACE_MS,
  LOCK_BASENAME,
  LOCK_ENV_VAR,
  SKIPPED_DIRECTORIES,
  acquireRunLock,
  expandDirectoryArg,
  formatRunSummary,
  isSequentialTestPath,
  isStableLaneExcludedPath,
  laneOverlapEnabled,
  loadTimeoutOverrides,
  partitionChildArgs,
  parseArgs,
  resolvePerFileTimeoutMs,
  resolveTimeoutMs,
  runCapturedChild,
  hasTapTestEvents,
  isInfrastructureFailure,
  selectRunGroups,
};
