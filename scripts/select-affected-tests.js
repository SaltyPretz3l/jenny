#!/usr/bin/env node
'use strict';

// Agent inner-loop fast test lane.
//
// Maps changed production source files (via mutation-smoke's git discovery and
// stem/coarse test-resolution helpers) to the smallest test set that covers
// them, and runs ONLY those tests -- *.py through `pytest -q`, everything else
// through run-node-tests-safe.js, failing if either lane fails. This is a
// convenience/speed lane, not a correctness gate: any ambiguity (an unmapped
// source, no changed sources, or git being unavailable) falls back to the full
// stable lane (`tests/` under --parallel-only) so a narrow selection NEVER
// silently under-runs coverage. Adds no dependency; does not modify the
// working tree.
//
// Usage:
//   node scripts/select-affected-tests.js              # run the affected lane (or fall back)
//   node scripts/select-affected-tests.js --dry-run    # print the plan only, spawn nothing

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  resolveTestsForSource,
  collectChangedSources,
  isProductionSource,
  loadCoarseMap,
  targetSelectorMatches,
} = require('./mutation-smoke');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_PATH = path.join('scripts', 'run-node-tests-safe.js');
const STABLE_TIMEOUT_MS = 600000;
// scripts/ is excluded from isProductionSource wholesale, but the
// changed-target map is the repo's own statement that a handful of scripts
// DO have required tests. Read it through mutation-smoke so all three
// readers of this file share one definition of what a selector matches.
const MAPPED_SCRIPT_SELECTORS = loadCoarseMap(ROOT)
  .flatMap((rule) => (Array.isArray(rule.target_prefixes) ? rule.target_prefixes : []))
  .filter((selector) => String(selector).startsWith('scripts/'));

// mutation-smoke's isProductionSource is JS-only (it feeds the JS mutation
// catalog). The affected lane additionally covers sidecar Python sources so
// the coarse map's sidecar/** rules can route changes to their pytest files.
function isAffectedSource(relPath) {
  const rel = String(relPath).split('\\').join('/');
  if (isProductionSource(rel)) return true;
  if (MAPPED_SCRIPT_SELECTORS.some((selector) => targetSelectorMatches(rel, selector))) return true;
  return rel.startsWith('sidecar/') && rel.endsWith('.py');
}

// Prefer the repo venv (same resolution as scripts/tests/run-dist-tests.js) so
// the pytest lane sees the sidecar's installed dependencies.
function resolvePythonExecutable(root = ROOT) {
  const venvPython = process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

// Pure decision logic: maps changed sources -> a test plan. Accepts injectable
// collectChangedSources/resolveTestsForSource so unit tests can stub git and
// mapping behavior without touching the real repo state.
function computeAffectedPlan({ root = ROOT } = {}, overrides = {}) {
  const collect = overrides.collectChangedSources
    || ((collectRoot) => collectChangedSources(collectRoot, { sourceFilter: isAffectedSource }));
  const resolve = overrides.resolveTestsForSource || resolveTestsForSource;

  const { sources, reason } = collect(root);

  if (reason) {
    const bannerLine = '[affected] git unavailable -> falling back to stable lane';
    return {
      mode: 'fallback',
      tests: [],
      mappedCount: 0,
      stemCount: 0,
      coarseCount: 0,
      combinedCount: 0,
      unmappedSources: [],
      bannerLine,
      fallbackReason: `git unavailable (${reason}) -- falling back to the stable lane`,
    };
  }

  if (sources.length === 0) {
    const bannerLine = '[affected] 0 sources -> falling back to stable lane';
    return {
      mode: 'fallback',
      tests: [],
      mappedCount: 0,
      stemCount: 0,
      coarseCount: 0,
      combinedCount: 0,
      unmappedSources: [],
      bannerLine,
      fallbackReason: 'no changed sources detected -- falling back to the stable lane',
    };
  }

  const testsInOrder = [];
  const seenTests = new Set();
  let stemCount = 0;
  let coarseCount = 0;
  let combinedCount = 0;
  const unmappedSources = [];

  for (const relSource of sources) {
    const { tests, source: mapSource } = resolve(relSource, { root });
    if (mapSource === 'stem-match') stemCount += 1;
    else if (mapSource === 'coarse-map') coarseCount += 1;
    else if (mapSource === 'stem+coarse-map') combinedCount += 1;
    else unmappedSources.push(relSource);

    for (const test of tests) {
      if (!seenTests.has(test)) {
        seenTests.add(test);
        testsInOrder.push(test);
      }
    }
  }

  const mappedCount = sources.length - unmappedSources.length;
  const countsSuffix = `(stem:${stemCount} coarse:${coarseCount} combined:${combinedCount})`;

  if (unmappedSources.length > 0) {
    const bannerLine =
      `[affected] ${sources.length} sources -> ${testsInOrder.length} tests ${countsSuffix}; ` +
      `${unmappedSources.length} unmapped -> falling back to stable lane`;
    return {
      mode: 'fallback',
      tests: testsInOrder,
      mappedCount,
      stemCount,
      coarseCount,
      combinedCount,
      unmappedSources,
      bannerLine,
      fallbackReason:
        `${unmappedSources.length} changed source${unmappedSources.length === 1 ? '' : 's'} unmapped ` +
        `(${unmappedSources.join(', ')}) -- falling back to the stable lane`,
    };
  }

  const bannerLine = `[affected] ${sources.length} sources -> ${testsInOrder.length} tests ${countsSuffix}`;
  return {
    mode: 'affected',
    tests: testsInOrder,
    mappedCount,
    stemCount,
    coarseCount,
    combinedCount,
    unmappedSources: [],
    bannerLine,
    fallbackReason: null,
  };
}

// The coarse map mixes Node tests (tests/*.test.js) and sidecar pytest files
// (tests/sidecar/**/*.py). node --test cannot execute a .py file, so the run
// must be partitioned per lane rather than handed wholesale to the Node runner.
function partitionTests(tests) {
  const nodeTests = [];
  const pyTests = [];
  for (const test of tests) {
    (test.endsWith('.py') ? pyTests : nodeTests).push(test);
  }
  return { nodeTests, pyTests };
}

// Pure arg construction so tests can assert lane routing without spawning.
// Either lane is null when it has nothing to run.
function buildLanePlan(plan) {
  if (plan.mode === 'fallback') {
    return {
      nodeArgs: ['tests/', '--parallel-only', `--timeout-ms=${STABLE_TIMEOUT_MS}`],
      pytestArgs: null,
    };
  }
  const { nodeTests, pyTests } = partitionTests(plan.tests);
  return {
    nodeArgs: nodeTests.length > 0 ? [...nodeTests, `--timeout-ms=${STABLE_TIMEOUT_MS}`] : null,
    pytestArgs: pyTests.length > 0 ? ['-m', 'pytest', '-q', ...pyTests] : null,
  };
}

function runLane(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.status === null) {
    // Killed by signal (or failed to spawn) -- treat as a failure, never a silent pass.
    return 1;
  }
  return result.status;
}

function runChild(plan) {
  const { nodeArgs, pytestArgs } = buildLanePlan(plan);
  const { nodeTests, pyTests } = partitionTests(plan.mode === 'affected' ? plan.tests : []);
  let nodeExit = 0;
  let pyExit = 0;
  if (nodeArgs) {
    const laneLabel = plan.mode === 'affected'
      ? `${nodeTests.length} test file(s)`
      : 'stable lane (tests/ --parallel-only)';
    console.log(`[affected] node lane: ${laneLabel} -> run-node-tests-safe.js`);
    nodeExit = runLane(process.execPath, [path.join(ROOT, RUNNER_PATH), ...nodeArgs]);
  }
  if (pytestArgs) {
    console.log(`[affected] python lane: ${pyTests.length} test file(s) -> pytest -q`);
    pyExit = runLane(resolvePythonExecutable(), pytestArgs);
  }
  // Both lanes always run; a failure in either fails the whole selection.
  return nodeExit !== 0 ? nodeExit : pyExit;
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');

  const plan = computeAffectedPlan({ root: ROOT });
  console.log(plan.bannerLine);
  if (plan.fallbackReason) {
    console.log(`NOTE: ${plan.fallbackReason}`);
  }

  if (dryRun) {
    if (plan.mode === 'affected') {
      const { nodeTests, pyTests } = partitionTests(plan.tests);
      console.log(
        `[affected] dry-run: would run ${plan.tests.length} test file(s) ` +
        `(node:${nodeTests.length} python:${pyTests.length}):`
      );
      for (const test of nodeTests) console.log(`  [node]   ${test}`);
      for (const test of pyTests) console.log(`  [python] ${test}`);
    } else {
      console.log('[affected] dry-run: would run the stable lane (tests/ --parallel-only)');
    }
    process.exitCode = 0;
    return;
  }

  process.exitCode = runChild(plan);
}

if (require.main === module) {
  main();
}

module.exports = {
  computeAffectedPlan,
  partitionTests,
  buildLanePlan,
  isAffectedSource,
  resolvePythonExecutable,
};
