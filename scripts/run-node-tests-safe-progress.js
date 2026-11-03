'use strict';

// Live progress lines for scripts/run-node-tests-safe.js. The runner buffers each
// child's output and prints a summary at the end, so a long run looks frozen.
// These two stdout lines are a contract with the sidecar parser that draws the
// per-file progress grid:
//   [run-node-tests-safe] files <N>
//   [run-node-tests-safe] progress <done>/<N> <pass|fail> <file> (<tests> tests)
// The ` (<tests> tests)` suffix is omitted when the child reported no count.

const PREFIX = '[run-node-tests-safe]';
// Node's TAP reporter prints `# tests N`; the spec reporter prints `<U+2139> tests N`.
const TESTS_SUMMARY = /^(?:# |ℹ )tests (\d+)\r?$/gm;

function parseReportedTestCount(output) {
  let count = null;
  for (const match of String(output || '').matchAll(TESTS_SUMMARY)) {
    count = Number(match[1]);
  }
  return count;
}

function formatProgressLine({ done, total, passed, file, tests }) {
  const suffix = Number.isInteger(tests) ? ` (${tests} tests)` : '';
  return `${PREFIX} progress ${done}/${total} ${passed ? 'pass' : 'fail'} ${file}${suffix}`;
}

function createProgressTracker(total, log = console.log) {
  const settled = new Set();
  return {
    announce() {
      log(`${PREFIX} files ${total}`);
    },
    // Emits at most one line per file; a record settled twice (an infrastructure
    // retry re-reports it) keeps its first line. `output` is the child output to
    // read the test count from, since a passing record drops its own.
    settle(record, output = record.output) {
      if (settled.has(record.file)) return;
      settled.add(record.file);
      log(formatProgressLine({
        done: settled.size,
        total,
        passed: record.code === 0 && !record.timedOut,
        file: record.file,
        tests: parseReportedTestCount(output),
      }));
    },
    // Infrastructure failures wait for their serial retry before settling; if the
    // run aborts first, they settle here with their first-attempt result.
    flush(results) {
      for (const record of results) this.settle(record);
    },
  };
}

module.exports = { createProgressTracker, formatProgressLine, parseReportedTestCount };
