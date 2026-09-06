#!/usr/bin/env node
'use strict';

// Leaf support module for scripts/run-node-tests-safe.js. Holds the opt-in
// runner extensions (flaky-test retry/quarantine list loading, last-run
// persistence for --last-failed, changed-test discovery for --changed, JUnit
// report generation, --shard slicing) plus the shared path-normalization
// helpers. Extracted from the runner so it stays under the 1015-line file
// ceiling and so this logic is unit-testable without spawning child processes.
// This module depends on nothing in the runner (one-directional import).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const QUARANTINE_PATH = path.join('tests', '.quarantine.json');
const LAST_RUN_PATH = path.join('tests', '.last-test-run.json');
// Defensive clamp: a quarantine entry can never request unbounded retries.
const MAX_QUARANTINE_RETRIES = 5;
const GIT_STATUS_TIMEOUT_MS = 15_000;

function normalizeRepoPath(rawPath) {
  return String(rawPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeChildArgPath(childArg, cwd = process.cwd()) {
  return normalizeRepoPath(path.isAbsolute(childArg) ? path.relative(cwd, childArg) : childArg);
}

// ---------------------------------------------------------------------------
// Lane selection: sequential-risk partition, hosted stable-lane exclusion, the
// parallel/sequential run groups (incl. --shard slicing), and lane overlap.
// ---------------------------------------------------------------------------
const SEQUENTIAL_BASENAME_PATTERNS = [
  /^managed-sidecar-/,
  /^backend-service-inject\.test\.js$/,
  /^backend-service-lifecycle\.test\.js$/,
  /^electron-shell-smoke\.test\.js$/,
  /^main-lifecycle\.test\.js$/,
  /^main-window-startup-lifecycle\.test\.js$/,
  /^main-packaged-smoke\.test\.js$/,
  /^packaged-plugin-stage8-smoke\.test\.js$/,
  /^packaging-/,
  // Real-store crash injection is disk-intensive: 37.5s on a quiet machine
  // versus 302s in the parallel pool. Keep it in the one-at-a-time tail so
  // its 300s watchdog remains a hang detector.
  /^real-store-e2e\.test\.js$/,
  // These renderer shell suites stay sequential for SPEED, not correctness:
  // every renderer-*shell* suite is a self-contained VM/jsdom harness in its
  // own child process -- no fs writes, no servers, no subprocesses, no shared
  // temp paths -- so cross-file isolation is not a correctness need. What is
  // real is contention: a 12-worker smoke showed the tail below slows 2-4x
  // under load (104-259s contended vs 30-100s quiet), and
  // renderer-lifecycle-shell genuinely fails under heavy contention (internal
  // timing waits). Those stay sequential; the other 29 shell files passed
  // twice under worst-case contention at <=81s and ride the parallel lane.
  /^renderer-chat-layout-shell\.test\.js$/,
  /^renderer-guidance-shell\.test\.js$/,
  /^renderer-lifecycle-shell\.test\.js$/,
  /^renderer-send-handoff-shell\.test\.js$/,
  /^renderer-shell\.test\.js$/,
  /^renderer-shell-behavior-regressions\.test\.js$/,
  /^renderer-shell-settings\.test\.js$/,
  /^renderer-shell-settings-appearance\.test\.js$/,
  /^renderer-top-nav-shell\.test\.js$/,
  /^renderer-incremental-dom\.test\.js$/,
  /^renderer-controller-dispose\.test\.js$/,
  /^workspace-ipc\.test\.js$/,
  /^renderer-workspace-shell\.test\.js$/,
  /^overlay-window\.test\.js$/,
];

// Heavy full-renderer VM harnesses and suites that depend on Windows
// path/process/native-watch behavior or exceed reliable hosted-runner timing
// under parallel c8 load are excluded from hosted --parallel-only. They remain
// in every plain local run and in ci-heavy. Keep this list evidence-driven and
// covered by the runner contract: entries earn their place by a measured
// hosted-lane failure, not by suspicion.
const STABLE_LANE_EXCLUDED_BASENAME_PATTERNS = [
  /^renderer-.*shell.*\.test\.js$/,
  /^real-store-e2e\.test\.js$/,
  /^attachment-asset-store\.test\.js$/,
  /^background-job-tracker\.test\.js$/,
  /^chatgpt-auth-service\.test\.js$/,
  /^codex-cli-runtime-service\.test\.js$/,
  /^desktop-shortcut\.test\.js$/,
  /^electron-session-store-migration\.test\.js$/,
  /^gui-smoke-harness-launch-failure\.test\.js$/,
  /^managed-model-acquisition\.test\.js$/,
  /^process-utils\.test\.js$/,
  /^renderer-chat-segment-text-blanking\.test\.js$/,
  /^renderer-chat-stream-repaint\.test\.js$/,
  /^renderer-home-followups\.test\.js$/,
  /^renderer-ide-editor\.test\.js$/,
  /^renderer-ide-map-atlas-layout\.test\.js$/,
  /^renderer-proactive\.test\.js$/,
  /^renderer-stream-handler-buffering\.test\.js$/,
  /^renderer-stream-reveal\.test\.js$/,
  /^run-node-tests-safe\.test\.js$/,
  /^setup-orchestrator\.test\.js$/,
  /^sidecar-manager\.test\.js$/,
  /^uninstall-script\.test\.js$/,
  /^update-service\.test\.js$/,
  /^vllm-process-manager-dark-paths\.test\.js$/,
  /^weather-service\.test\.js$/,
  /^workspace-ide-gitdir\.test\.js$/,
  /^workspace-pty-spawn\.test\.js$/,
  /^workspace-test-runner-runner\.test\.js$/,
];

// Perf/load tests (basename ends `.load.test.js`) genuinely measure wall-clock
// performance (O(N^2) ratios, elapsed budgets) and are flaky under the parallel
// stable lane, so directory discovery DROPS them by default -- they ride only
// the heavy lane (`check:all` passes --include-load). Explicit file args
// always run.
const LOAD_TEST_PATTERN = /\.load\.test\.(c|m)?js$/;

function testBasename(childArg) {
  return path.basename(normalizeRepoPath(childArg));
}

function isElectronBackedTestSource(source, platform = process.platform) {
  if (platform !== 'win32') return false;
  const text = String(source || '');
  return (
    /require\s*\(\s*['"]electron['"]\s*\)/.test(text) ||
    /from\s+['"]electron['"]/.test(text) ||
    /\b_electron\b/.test(text)
  );
}

function isSequentialTestPath(childArg, options = {}) {
  const basename = testBasename(childArg);
  // Perf/load tests, when included, run in the sequential lane so their timing
  // is measured in isolation (parallel-worker contention is what makes them
  // flaky).
  if (LOAD_TEST_PATTERN.test(basename)) return true;
  if (SEQUENTIAL_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))) return true;
  if ((options.platform || process.platform) !== 'win32') return false;
  try {
    const cwd = options.cwd || process.cwd();
    const resolved = path.isAbsolute(childArg) ? childArg : path.join(cwd, childArg);
    return isElectronBackedTestSource(fs.readFileSync(resolved, 'utf8'), 'win32');
  } catch {
    return false;
  }
}

function isStableLaneExcludedPath(childArg) {
  const basename = testBasename(childArg);
  return STABLE_LANE_EXCLUDED_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

function partitionChildArgs(childArgs) {
  const sequentialArgs = [];
  const parallelArgs = [];
  for (const childArg of childArgs) {
    if (isSequentialTestPath(childArg)) {
      sequentialArgs.push(childArg);
    } else {
      parallelArgs.push(childArg);
    }
  }
  return { parallelArgs, sequentialArgs };
}

// --sequential-only forces every file through the sequential lane (run the
// whole suite one-at-a-time). --parallel-only is the inverse fast-gate lane:
// run only the hosted-stable partition and DROP both the sequential-risk
// Electron/managed suites AND the stable-lane-excluded heavy harnesses (they
// live in the heavy gate). Plain mode partitions and runs both lanes.
function selectRunGroups(parsed) {
  let groups;
  if (parsed.sequentialOnly) {
    groups = { parallelArgs: [], sequentialArgs: parsed.childArgs };
  } else {
    const partitioned = partitionChildArgs(parsed.childArgs);
    groups = parsed.parallelOnly
      ? {
        parallelArgs: partitioned.parallelArgs.filter((file) => !isStableLaneExcludedPath(file)),
        sequentialArgs: [],
      }
      : partitioned;
  }
  // --shard=K/N slices the parallel lane into N stable shards (heavy sequential
  // suites only on shard 1). Inert when no shard is set -> byte-identical.
  return parsed.shard ? applyShard(groups, parsed.shard) : groups;
}

// The sequential lane may run concurrently with the parallel pool on ONE
// reserved worker slot (audited 2026-07-20: sequential suites use mkdtemp'd
// state and fake-sidecar child processes -- no ports or paths shared with the
// parallel lane). Overlap is skipped when:
//  - the run carries *.load.test.js perf files: their wall-clock oracles need
//    the post-parallel quiet machine (the reason the isolated lane exists);
//  - fewer than 2 workers (no slot to reserve);
//  - either lane is empty (overlap would only shrink the pool);
//  - --no-lane-overlap / JENNY_TEST_LANE_OVERLAP=0 (rollback to strict order).
function laneOverlapEnabled(parsed, groups) {
  if (parsed.laneOverlap === false) return false;
  if (!(Number(parsed.parallelWorkers) >= 2)) return false;
  if (groups.parallelArgs.length === 0 || groups.sequentialArgs.length === 0) return false;
  if (groups.sequentialArgs.some((file) => LOAD_TEST_PATTERN.test(testBasename(file)))) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Quarantine list (tests/.quarantine.json) -> { [repoPath]: { retries, reason } }
// ---------------------------------------------------------------------------
function loadQuarantineOverrides(cwd = process.cwd()) {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(cwd, QUARANTINE_PATH), 'utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {};
    }
    const normalized = {};
    for (const [rawPath, rawEntry] of Object.entries(payload)) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const retries = Number(rawEntry.retries);
      if (!Number.isInteger(retries) || retries < 1) continue;
      normalized[normalizeRepoPath(rawPath)] = {
        retries: Math.min(retries, MAX_QUARANTINE_RETRIES),
        reason: typeof rawEntry.reason === 'string' ? rawEntry.reason : '',
      };
    }
    return normalized;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Last-run persistence (tests/.last-test-run.json, gitignored) for --last-failed
// ---------------------------------------------------------------------------
function loadLastFailed(cwd = process.cwd()) {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(cwd, LAST_RUN_PATH), 'utf8'));
    const failed = Array.isArray(payload && payload.failed) ? payload.failed : [];
    return new Set(
      failed.filter((item) => typeof item === 'string').map((item) => normalizeRepoPath(item))
    );
  } catch {
    return new Set();
  }
}

function writeLastRun(cwd, failedFiles) {
  try {
    fs.writeFileSync(
      path.join(cwd, LAST_RUN_PATH),
      `${JSON.stringify({ failed: failedFiles, updatedAt: new Date().toISOString() }, null, 2)}\n`
    );
  } catch {
    // best-effort: --last-failed simply falls back to running everything next time
  }
}

// Repo-relative *.test.js files git reports as changed in the working tree
// (staged + unstaged + untracked). Returns null when git is unavailable so the
// caller can fall back to running everything (the manifest check's posture).
function loadChangedTestFiles(cwd = process.cwd()) {
  let out;
  try {
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: GIT_STATUS_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const changed = new Set();
  for (const rawLine of out.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length < 4) continue;
    let pathText = line.slice(3).trim();
    if (pathText.includes(' -> ')) pathText = pathText.split(' -> ')[1];
    if (pathText.startsWith('"') && pathText.endsWith('"')) pathText = pathText.slice(1, -1);
    const normalized = normalizeRepoPath(pathText);
    if (/\.test\.(c|m)?js$/.test(normalized)) changed.add(normalized);
  }
  return changed;
}

// Narrow childArgs to the --last-failed / --changed intersection. With neither
// flag this is a no-op passthrough (keeps default `npm test` byte-identical).
function applyChildArgFilters(childArgs, options = {}) {
  const { lastFailed = false, changed = false, cwd = process.cwd() } = options;
  if (!lastFailed && !changed) {
    return { childArgs, filtered: false, note: null };
  }
  const notes = [];
  let allowed = null;
  const intersect = (set) => {
    allowed = allowed === null ? new Set(set) : new Set([...allowed].filter((item) => set.has(item)));
  };
  if (lastFailed) {
    const set = options.lastFailedSet || loadLastFailed(cwd);
    if (set.size === 0) {
      notes.push('--last-failed: no recorded failures in tests/.last-test-run.json; running every matched file');
    } else {
      intersect(set);
    }
  }
  if (changed) {
    const set = options.changedSet !== undefined ? options.changedSet : loadChangedTestFiles(cwd);
    if (set == null) {
      notes.push('--changed: git is unavailable; running every matched file');
    } else {
      intersect(set);
    }
  }
  const note = notes.length ? notes.join('\n') : null;
  if (allowed === null) {
    return { childArgs, filtered: false, note };
  }
  const kept = childArgs.filter((arg) => allowed.has(normalizeChildArgPath(arg, cwd)));
  return { childArgs: kept, filtered: true, note };
}

// Files that did not cleanly pass, recorded so --last-failed can re-run them.
function collectRerunTargets(state) {
  const targets = [];
  for (const record of state.results) {
    if (record.code !== 0 || record.timedOut) targets.push(record.file);
  }
  for (const file of state.notRun) targets.push(file);
  return [...new Set(targets)];
}

// ---------------------------------------------------------------------------
// --shard=K/N (1-based K of N). Slices the parallel partition into N stable,
// non-overlapping shards; heavy sequential suites run only on shard 1.
// ---------------------------------------------------------------------------
function parseShardSpec(raw) {
  const match = /^(\d+)\/(\d+)$/.exec(String(raw).trim());
  if (!match) return null;
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(count)) return null;
  if (count < 1 || index < 1 || index > count) return null;
  return { index, count };
}

function applyShard(groups, shard) {
  return {
    parallelArgs: groups.parallelArgs.filter((_, index) => index % shard.count === shard.index - 1),
    sequentialArgs: shard.index === 1 ? groups.sequentialArgs : [],
  };
}

// ---------------------------------------------------------------------------
// JUnit XML report (--junit=<path>). No new dependency; the runner's per-file
// record already carries every field a CI annotator needs.
// ---------------------------------------------------------------------------
function isXmlIllegalControl(code) {
  // XML 1.0 forbids C0 control chars except tab (9), LF (10), CR (13).
  if (code === 9 || code === 10 || code === 13) return false;
  return code < 32;
}

function escapeXml(value) {
  const text = String(value == null ? '' : value);
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (isXmlIllegalControl(text.charCodeAt(i))) continue;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&apos;';
    else out += ch;
  }
  return out;
}

function buildJunitXml({ results = [], notRun = [], elapsedMs = 0 }) {
  const failures = results.filter((r) => r.code !== 0 && !r.timedOut && !r.collateralKilled).length;
  const errors = results.filter((r) => r.timedOut).length;
  const skipped = results.filter((r) => r.collateralKilled && !r.timedOut).length + notRun.length;
  const total = results.length + notRun.length;
  const suiteTime = (elapsedMs / 1000).toFixed(3);
  const cases = [];
  for (const record of results) {
    const file = escapeXml(record.file);
    const time = (record.durationMs / 1000).toFixed(3);
    const attrs = `name="${file}" classname="${file}" time="${time}"`;
    if (record.timedOut) {
      cases.push(
        `    <testcase ${attrs}><error message="timed out after ${record.perFileTimeoutMs}ms">` +
          `${escapeXml(record.output)}</error></testcase>`
      );
    } else if (record.collateralKilled) {
      cases.push(
        `    <testcase ${attrs}><skipped message="aborted (fail-fast/shutdown collateral)"></skipped></testcase>`
      );
    } else if (record.code !== 0) {
      cases.push(
        `    <testcase ${attrs}><failure message="exit ${record.code}">${escapeXml(record.output)}</failure></testcase>`
      );
    } else {
      cases.push(`    <testcase ${attrs}></testcase>`);
    }
  }
  for (const file of notRun) {
    const escaped = escapeXml(file);
    cases.push(
      `    <testcase name="${escaped}" classname="${escaped}" time="0.000">` +
        '<skipped message="not run"></skipped></testcase>'
    );
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="run-node-tests-safe" tests="${total}" failures="${failures}" ` +
      `errors="${errors}" skipped="${skipped}" time="${suiteTime}">`,
    `  <testsuite name="run-node-tests-safe" tests="${total}" failures="${failures}" ` +
      `errors="${errors}" skipped="${skipped}" time="${suiteTime}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

function writeJunitReport(junitPath, summary) {
  try {
    const resolved = path.isAbsolute(junitPath) ? junitPath : path.join(process.cwd(), junitPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, buildJunitXml(summary));
  } catch (error) {
    console.error(`[run-node-tests-safe] failed to write JUnit report to ${junitPath}: ${error.message}`);
  }
}

module.exports = {
  QUARANTINE_PATH,
  LAST_RUN_PATH,
  MAX_QUARANTINE_RETRIES,
  LOAD_TEST_PATTERN,
  normalizeRepoPath,
  normalizeChildArgPath,
  isSequentialTestPath,
  isElectronBackedTestSource,
  isStableLaneExcludedPath,
  partitionChildArgs,
  selectRunGroups,
  laneOverlapEnabled,
  loadQuarantineOverrides,
  loadLastFailed,
  writeLastRun,
  loadChangedTestFiles,
  applyChildArgFilters,
  collectRerunTargets,
  parseShardSpec,
  applyShard,
  escapeXml,
  buildJunitXml,
  writeJunitReport,
};
