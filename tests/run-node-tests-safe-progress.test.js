'use strict';

// Live progress lines for scripts/run-node-tests-safe.js: `files <N>` once
// before the first file starts, then one `progress <done>/<N> <pass|fail> <file>
// (<tests> tests)` line per file as it settles. A sidecar parser reads them to
// draw the per-file grid, so the text is a contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  createProgressTracker,
  formatProgressLine,
  parseReportedTestCount,
} = require('../scripts/run-node-tests-safe-progress');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_PATH = path.join(ROOT, 'scripts', 'run-node-tests-safe.js');
const SPEC_INFO = String.fromCodePoint(0x2139);

function runRunner(args) {
  const result = spawnSync(process.execPath, [RUNNER_PATH, '--no-lock', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
  });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

test('the child test count is read from the spec or TAP summary, last one wins', () => {
  assert.equal(parseReportedTestCount(`${SPEC_INFO} tests 7\n${SPEC_INFO} pass 7`), 7);
  assert.equal(parseReportedTestCount('TAP version 13\n# tests 12\n# pass 12'), 12);
  assert.equal(parseReportedTestCount('# tests 2\nnoise\n# tests 5'), 5);
  assert.equal(parseReportedTestCount('crashed before any summary'), null);
  assert.equal(parseReportedTestCount(null), null);
});

test('the progress line carries the tests suffix only when a count is known', () => {
  assert.equal(
    formatProgressLine({ done: 1, total: 3, passed: true, file: 'tests/a.test.js', tests: 4 }),
    '[run-node-tests-safe] progress 1/3 pass tests/a.test.js (4 tests)'
  );
  assert.equal(
    formatProgressLine({ done: 2, total: 3, passed: false, file: 'tests/b.test.js', tests: null }),
    '[run-node-tests-safe] progress 2/3 fail tests/b.test.js'
  );
});

test('the tracker counts settles in finish order, once per file, pass only for a clean exit', () => {
  const lines = [];
  const tracker = createProgressTracker(3, (line) => lines.push(line));
  tracker.announce();
  tracker.settle({ file: 'tests/slow.test.js', code: 0, timedOut: false }, `${SPEC_INFO} tests 2`);
  tracker.settle({ file: 'tests/hung.test.js', code: 124, timedOut: true }, '');
  tracker.settle({ file: 'tests/slow.test.js', code: 0, timedOut: false }, `${SPEC_INFO} tests 2`);
  tracker.settle({ file: 'tests/bad.test.js', code: 1, timedOut: false }, `${SPEC_INFO} tests 1`);
  assert.deepEqual(lines, [
    '[run-node-tests-safe] files 3',
    '[run-node-tests-safe] progress 1/3 pass tests/slow.test.js (2 tests)',
    '[run-node-tests-safe] progress 2/3 fail tests/hung.test.js',
    '[run-node-tests-safe] progress 3/3 fail tests/bad.test.js (1 tests)',
  ]);
});

test('the runner prints files N before any progress line and one progress line per file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = {
    'a-pass.test.js': "const test = require('node:test');\ntest('one', () => {});\ntest('two', () => {});\n",
    'b-fail.test.js': "const test = require('node:test');\ntest('boom', () => { throw new Error('boom'); });\n",
    'c-pass.test.js': "require('node:test')('only', () => {});\n",
  };
  const paths = Object.entries(files).map(([name, body]) => {
    const full = path.join(dir, name);
    fs.writeFileSync(full, body);
    return full;
  });

  const { status, stdout } = runRunner([...paths, '--timeout-ms=60000', '--parallel-workers=2']);
  assert.equal(status, 1, 'the failing fixture still fails the run');

  const lines = stdout.split(/\r?\n/);
  const filesAt = lines.flatMap((line, index) => (line.startsWith('[run-node-tests-safe] files ') ? [index] : []));
  assert.equal(filesAt.length, 1, 'files line is printed exactly once');
  assert.equal(lines[filesAt[0]], '[run-node-tests-safe] files 3');
  const progress = lines.filter((line) => line.startsWith('[run-node-tests-safe] progress '));
  assert.equal(progress.length, 3);
  const firstProgressAt = lines.findIndex((line) => line.startsWith('[run-node-tests-safe] progress '));
  assert.ok(filesAt[0] < firstProgressAt, 'files precedes the first progress line');
  assert.ok(
    firstProgressAt < lines.findIndex((line) => line.startsWith('[run-node-tests-safe] summary:')),
    'progress precedes the summary'
  );

  const parsed = progress.map((line) => {
    const match = /^\[run-node-tests-safe\] progress (\d+)\/3 (pass|fail) (\S.*?)(?: \((\d+) tests\))?$/.exec(line);
    assert.ok(match, `progress line shape: ${line}`);
    return { done: Number(match[1]), verdict: match[2], file: path.basename(match[3]), tests: match[4] };
  });
  assert.deepEqual(parsed.map((entry) => entry.done), [1, 2, 3]);
  const byFile = Object.fromEntries(parsed.map((entry) => [entry.file, entry]));
  assert.equal(byFile['a-pass.test.js'].verdict, 'pass');
  assert.equal(byFile['a-pass.test.js'].tests, '2');
  assert.equal(byFile['b-fail.test.js'].verdict, 'fail');
  assert.equal(byFile['c-pass.test.js'].verdict, 'pass');
  assert.equal(byFile['c-pass.test.js'].tests, '1');
});
