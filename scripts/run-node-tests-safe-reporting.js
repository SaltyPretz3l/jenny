'use strict';

const { isSequentialTestPath } = require('./run-node-tests-safe-support');

const SLOWEST_FILES_REPORTED = 5;
const SLOWEST_FILE_FLOOR_MS = 10_000;

function emitCapturedOutput(record) {
  if (!record.output) return;
  const trailing = record.output.endsWith('\n') ? '' : '\n';
  process.stdout.write(
    `----- output: ${record.file} -----\n${record.output}${trailing}----- end output: ${record.file} -----\n`
  );
}

function reportFileResult(record, verbose) {
  const seconds = (record.durationMs / 1000).toFixed(1);
  if (record.timedOut) {
    const terminationStatus = record.terminationFailed
      ? 'process tree termination NOT confirmed; remaining files aborted'
      : 'process tree killed';
    console.error(
      `[run-node-tests-safe] TIMEOUT ${record.file} after ${record.perFileTimeoutMs}ms (likely hung); ${terminationStatus}`
    );
    emitCapturedOutput(record);
    return;
  }
  if (record.collateralKilled) {
    console.error(
      `[run-node-tests-safe] ABORTED ${record.file} (killed mid-run by --fail-fast/shutdown, ${seconds}s)`
    );
    return;
  }
  if (record.code !== 0) {
    if (record.infrastructureFailure) {
      console.error(
        `[run-node-tests-safe] INFRASTRUCTURE_FAILURE ${record.file} ` +
          `(exit ${record.code}, ${seconds}s; Electron/Chromium startup did not produce test events)`
      );
      emitCapturedOutput(record);
      return;
    }
    console.error(`[run-node-tests-safe] FAIL ${record.file} (exit ${record.code}, ${seconds}s)`);
    emitCapturedOutput(record);
    return;
  }
  console.log(`[run-node-tests-safe] ok ${record.file} (${seconds}s)`);
  if (record.recovered) {
    console.log(
      `[run-node-tests-safe] RECOVERED ${record.file} after ${record.attempts} attempt(s) ` +
        '(quarantined flake passed on retry)'
    );
  }
  if (verbose) emitCapturedOutput(record);
}

function hasTapTestEvents(output) {
  return /^(?:# Subtest:|(?:ok|not ok)\s+\d+)/m.test(String(output || ''));
}

function isInfrastructureFailure(file, result, platform = process.platform) {
  if (!result || result.timedOut || result.collateralKilled || result.code === 0) return false;
  const output = String(result.output || '');
  const crashpad = /crashpad|0xffffffff|crashpad[^\n]*not connected/i.test(output);
  const minusOne = result.code === -1 || result.code === 0xFFFFFFFF;
  const electronBacked = isSequentialTestPath(file, { platform });
  return minusOne || crashpad || (electronBacked && !hasTapTestEvents(output));
}

async function retryInfrastructureFailures(parsed, state, runCapturedChild) {
  const candidates = state.results.filter(
    (record) => record.infrastructureFailure && !record.timedOut && !record.infrastructureRetryAttempted
  );
  for (const record of candidates) {
    console.error(
      `[run-node-tests-safe] RETRY ${record.file} after parallel infrastructure failure ` +
        '(one worker, first-attempt output retained)'
    );
    const firstAttemptOutput = record.output || '';
    record.infrastructureRetryAttempted = true;
    const retry = await runCapturedChild(['--test', record.file], {
      activeChildren: state.activeChildren,
      timeoutMs: record.perFileTimeoutMs,
    });
    record.attempts += 1;
    record.code = retry.code;
    record.timedOut = retry.timedOut;
    record.terminationFailed = retry.terminationFailed === true;
    record.collateralKilled = retry.collateralKilled === true;
    record.infrastructureFailure = isInfrastructureFailure(record.file, retry);
    record.output = retry.code === 0
      ? firstAttemptOutput
      : `${firstAttemptOutput}\n----- serial infrastructure retry -----\n${retry.output || ''}`;
    reportFileResult(record, parsed.verbose);
    if (record.terminationFailed) {
      return { file: record.file, terminationFailed: true };
    }
    if (retry.code === 0 && !parsed.verbose) record.output = null;
  }
  return null;
}

function formatRunSummary({ results = [], notRun = [], inFlight = [], elapsedMs = 0 }) {
  const passed = results.filter((record) => record.code === 0 && !record.timedOut);
  const timedOut = results.filter((record) => record.timedOut);
  const aborted = results.filter((record) => record.collateralKilled && !record.timedOut);
  const infrastructure = results.filter(
    (record) => record.infrastructureFailure && !record.timedOut && !record.collateralKilled
  );
  const failed = results.filter(
    (record) => record.code !== 0 && !record.timedOut && !record.collateralKilled && !record.infrastructureFailure
  );
  const recovered = results.filter((record) => record.recovered);
  const totalFiles = results.length + notRun.length + inFlight.length;
  const lines = [
    `[run-node-tests-safe] summary: ${passed.length} passed, ${failed.length} failed, ` +
      `${infrastructure.length} infrastructure failed, ` +
      `${timedOut.length} timed out, ${aborted.length} aborted, ${notRun.length} not run ` +
      `(${results.length} of ${totalFiles} file(s) completed, ${(elapsedMs / 1000).toFixed(1)}s)`,
  ];
  const slowest = results
    .filter((record) => !record.timedOut && record.durationMs >= SLOWEST_FILE_FLOOR_MS)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, SLOWEST_FILES_REPORTED);
  if (slowest.length > 0) {
    const listed = slowest
      .map((record) => `${record.file} (${(record.durationMs / 1000).toFixed(1)}s)`)
      .join(', ');
    lines.push(`[run-node-tests-safe] slowest files (>=${SLOWEST_FILE_FLOOR_MS / 1000}s): ${listed}`);
  }
  if (recovered.length > 0) {
    const preview = recovered
      .map((record) => `${record.file} (${record.attempts} attempts)`)
      .slice(0, 5)
      .join(', ');
    const suffix = recovered.length > 5 ? `, ... (${recovered.length - 5} more)` : '';
    lines.push(
      `[run-node-tests-safe] RECOVERED (quarantined flakes passed on retry): ` +
        `${recovered.length} file(s): ${preview}${suffix}`
    );
  }
  for (const record of failed) lines.push(`[run-node-tests-safe] FAILED: ${record.file} (exit ${record.code})`);
  for (const record of infrastructure) {
    lines.push(`[run-node-tests-safe] INFRASTRUCTURE_FAILURE: ${record.file} (exit ${record.code})`);
  }
  for (const record of timedOut) {
    lines.push(`[run-node-tests-safe] TIMED OUT: ${record.file} (after ${record.perFileTimeoutMs}ms)`);
  }
  if (aborted.length > 0) {
    const preview = aborted.map((record) => record.file).slice(0, 5).join(', ');
    const suffix = aborted.length > 5 ? `, ... (${aborted.length - 5} more)` : '';
    lines.push(
      `[run-node-tests-safe] ABORTED (fail-fast/shutdown collateral): ${aborted.length} file(s): ${preview}${suffix}`
    );
  }
  if (inFlight.length > 0) lines.push(`[run-node-tests-safe] IN-FLIGHT AT SHUTDOWN: ${inFlight.join(', ')}`);
  if (notRun.length > 0) {
    const preview = notRun.slice(0, 5).join(', ');
    const suffix = notRun.length > 5 ? `, ... (${notRun.length - 5} more)` : '';
    lines.push(`[run-node-tests-safe] NOT RUN: ${notRun.length} file(s): ${preview}${suffix}`);
  }
  return lines.join('\n');
}

module.exports = {
  formatRunSummary,
  hasTapTestEvents,
  isInfrastructureFailure,
  reportFileResult,
  retryInfrastructureFailures,
};
