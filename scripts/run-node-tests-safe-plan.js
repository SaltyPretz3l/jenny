'use strict';

// Lane scheduling for scripts/run-node-tests-safe.js: the parallel pool, the
// one-at-a-time chains that may overlap it, and the strict *.load.test.js tail.
// Split out of the runner (2026-10-04) so the scheduling has room to grow.

const {
  selectRunGroups,
  laneOverlapEnabled,
  splitLoadTail,
  splitSequentialChains,
  normalizeChildArgPath,
} = require('./run-node-tests-safe-support');
const { retryInfrastructureFailures } = require('./run-node-tests-safe-reporting');
const { readHistoryFile, resolveHistoryPath } = require('./run-node-tests-safe-history');

// Orders files by their most recent recorded duration, longest first. Files
// with no history keep their relative order and go first (an unknown file may
// be long). Ordering is advisory: any history problem leaves the order as is.
function orderLongestFirst(files, { cwd = process.cwd(), history } = {}) {
  let runs;
  try {
    runs = (history || readHistoryFile(resolveHistoryPath(cwd))).runs || [];
  } catch {
    return files;
  }
  const lastDuration = new Map();
  for (const run of runs) {
    for (const record of (run && Array.isArray(run.files) ? run.files : [])) {
      if (record && !record.timedOut && Number.isFinite(record.durationMs) && !lastDuration.has(record.file)) {
        lastDuration.set(record.file, record.durationMs);
      }
    }
  }
  if (lastDuration.size === 0) return files;
  const weight = (file) => lastDuration.get(normalizeChildArgPath(file, cwd)) ?? Infinity;
  return files
    .map((file, index) => ({ file, index, weight: weight(file) }))
    .sort((a, b) => (b.weight === a.weight ? a.index - b.index : (b.weight > a.weight ? 1 : -1)))
    .map((entry) => entry.file);
}

async function runManagedPlan(parsed, state, { runManagedFile, runCapturedChild, killActiveChildren }) {
  const { parallelArgs, sequentialArgs: allSequentialArgs } = selectRunGroups(parsed);
  // Only the load files need the post-parallel quiet machine (see splitLoadTail).
  const { sequentialArgs, loadArgs } = splitLoadTail(allSequentialArgs);

  let aborted = false;

  const abortRemaining = async (failedFile, reason = '--fail-fast') => {
    aborted = true;
    console.error(
      `[run-node-tests-safe] ${reason}: aborting remaining files after ${failedFile} failed`
    );
    await killActiveChildren(state.activeChildren);
  };

  const retryInfrastructureFailuresOrAbort = async () => {
    // After an abort (fail-fast or an unconfirmed kill) nothing new may start.
    if (aborted) return;
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

  // One cursor per lane; each drain() call is one worker pulling the next file.
  const createLane = (files) => {
    let index = 0;
    return {
      files,
      async drain() {
        while (index < files.length && !aborted) {
          const file = files[index];
          index += 1;
          const record = await runManagedFile(file, parsed, state);
          if (record.terminationFailed && !aborted) {
            await abortRemaining(record.file, 'unconfirmed process tree termination');
          } else if (
            record.code !== 0 && parsed.failFast && !record.infrastructureFailure && !aborted
          ) {
            await abortRemaining(record.file);
          }
        }
      },
      remaining: () => files.slice(index),
    };
  };
  // Longest known files first, so the pool's tail is short files that pack
  // tightly instead of one late-started long file running alone.
  const parallelLane = createLane(parsed.shard ? parallelArgs : orderLongestFirst(parallelArgs));
  const loadLane = createLane(loadArgs);
  let chainLanes;

  if (laneOverlapEnabled(parsed, { parallelArgs, sequentialArgs })) {
    // Each chain stays one-at-a-time relative to ITSELF and takes one reserved
    // worker slot, so total child concurrency stays at parsed.parallelWorkers.
    // The resource chain (real sidecars, Electron, packaging) and the heavy
    // jsdom chain share nothing, so they run beside each other: as one chain
    // they were the lane's critical path (~330 s, 2026-10-04).
    const { resourceArgs, jsdomArgs } = splitSequentialChains(sequentialArgs);
    const twoChains = resourceArgs.length > 0 && jsdomArgs.length > 0 && parsed.parallelWorkers >= 3;
    chainLanes = (twoChains ? [resourceArgs, jsdomArgs] : [sequentialArgs]).map(createLane);
    const poolWidth = Math.min(parsed.parallelWorkers - chainLanes.length, parallelArgs.length);
    await Promise.all([
      ...Array.from({ length: poolWidth }, () => parallelLane.drain()),
      // A finished chain hands its reserved slot back to the pool.
      ...chainLanes.map((lane) => lane.drain().then(() => parallelLane.drain())),
    ]);
    await retryInfrastructureFailuresOrAbort();
  } else {
    chainLanes = [createLane(sequentialArgs)];
    const workerCount = Math.min(parsed.parallelWorkers, parallelArgs.length);
    if (workerCount > 0) {
      await Promise.all(Array.from({ length: workerCount }, () => parallelLane.drain()));
    }
    await retryInfrastructureFailuresOrAbort();
    if (!aborted) {
      await chainLanes[0].drain();
      await retryInfrastructureFailuresOrAbort();
    }
  }

  if (!aborted && loadArgs.length > 0) {
    await loadLane.drain();
    await retryInfrastructureFailuresOrAbort();
  }

  if (aborted) {
    for (const lane of [parallelLane, ...chainLanes, loadLane]) {
      state.notRun.push(...lane.remaining().map((file) => normalizeChildArgPath(file)));
    }
  }
}

module.exports = { runManagedPlan, orderLongestFirst };
