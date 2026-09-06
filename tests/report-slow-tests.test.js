'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  parseJunitXml,
  annotateLane,
  formatTopSlowest,
} = require('../scripts/report-slow-tests.js');
const { HISTORY_PATH } = require('../scripts/run-node-tests-safe-history');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'report-slow-tests.js');

// Fixture mirrors the real shape emitted by buildJunitXml in
// scripts/run-node-tests-safe-support.js: one <testsuites><testsuite>
// containing one <testcase name=... classname=... time=...> per file.
const FIXTURE_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuites name="run-node-tests-safe" tests="5" failures="0" errors="0" skipped="0" time="20.000">',
  '  <testsuite name="run-node-tests-safe" tests="5" failures="0" errors="0" skipped="0" time="20.000">',
  '    <testcase name="tests/a.test.js" classname="tests/a.test.js" time="5.000"></testcase>',
  '    <testcase name="tests/managed-sidecar-foo.test.js" classname="tests/managed-sidecar-foo.test.js" time="1.000"></testcase>',
  '    <testcase name="tests/perf.load.test.js" classname="tests/perf.load.test.js" time="9.000"></testcase>',
  '    <testcase name="tests/b.test.js" classname="tests/b.test.js" time="2.500"></testcase>',
  '    <testcase name="tests/c.test.js" classname="tests/c.test.js" time="2.500"></testcase>',
  '  </testsuite>',
  '</testsuites>',
  '',
].join('\n');

function makeCliRoot(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'report-slow-tests-cli-'));
  fs.mkdirSync(path.join(tempRoot, 'tests'), { recursive: true });
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

function writeHistory(tempRoot, durationMs = 42_000) {
  fs.writeFileSync(path.join(tempRoot, HISTORY_PATH), JSON.stringify({
    version: 1,
    runs: [{
      runId: 'history-run',
      status: 'passed',
      files: [{ file: 'tests/from-history.test.js', status: 'passed', durationMs, timedOut: false }],
    }],
  }));
}

test('parseJunitXml extracts count, durations, and file names in document order', () => {
  const records = parseJunitXml(FIXTURE_XML);
  assert.equal(records.length, 5);
  assert.deepEqual(
    records.map((r) => r.file),
    [
      'tests/a.test.js',
      'tests/managed-sidecar-foo.test.js',
      'tests/perf.load.test.js',
      'tests/b.test.js',
      'tests/c.test.js',
    ]
  );
  assert.deepEqual(
    records.map((r) => r.durationSec),
    [5, 1, 9, 2.5, 2.5]
  );
});

test('annotateLane tags sequential, load, and parallel files correctly', () => {
  assert.equal(annotateLane('tests/managed-sidecar-foo.test.js'), 'sequential');
  assert.equal(annotateLane('tests/perf.load.test.js'), 'load');
  assert.equal(annotateLane('tests/a.test.js'), 'parallel');
  assert.equal(annotateLane('tests/b.test.js'), 'parallel');
});

test('formatTopSlowest sorts descending by duration with stable ties', () => {
  const records = parseJunitXml(FIXTURE_XML);
  const lines = formatTopSlowest(records, { top: 20 });
  assert.equal(lines.length, 5);
  // Expected order: perf.load (9), a (5), b (2.5), c (2.5, tie preserves doc order), managed-sidecar (1)
  assert.match(lines[0], /^9\.000s\s+tests\/perf\.load\.test\.js\s+\[load\]$/);
  assert.match(lines[1], /^5\.000s\s+tests\/a\.test\.js\s+\[parallel\]$/);
  assert.match(lines[2], /^2\.500s\s+tests\/b\.test\.js\s+\[parallel\]$/);
  assert.match(lines[3], /^2\.500s\s+tests\/c\.test\.js\s+\[parallel\]$/);
  assert.match(lines[4], /^1\.000s\s+tests\/managed-sidecar-foo\.test\.js\s+\[sequential\]$/);
});

test('formatTopSlowest --top=N truncates to the N slowest', () => {
  const records = parseJunitXml(FIXTURE_XML);
  const lines = formatTopSlowest(records, { top: 2 });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /perf\.load\.test\.js/);
  assert.match(lines[1], /tests\/a\.test\.js/);
});

test('CLI with no history and no args prints usage and exits 0', (t) => {
  const tempRoot = makeCliRoot(t);
  const result = spawnSync(process.execPath, [SCRIPT_PATH], { cwd: tempRoot, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /run-node-tests-safe\.js tests\/ --junit=test-report\.xml/);
  assert.match(result.stdout, /npm run test:slowest -- --junit=test-report\.xml/);
});

test('CLI with history and no args prints history output', (t) => {
  const tempRoot = makeCliRoot(t);
  writeHistory(tempRoot);
  const result = spawnSync(process.execPath, [SCRIPT_PATH], { cwd: tempRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(
    result.stdout,
    /^42\.000s median \(1 run\) tests\/from-history\.test\.js\s{2}\[parallel\]\r?\n$/
  );
});

test('explicit --junit wins when history exists', (t) => {
  const tempRoot = makeCliRoot(t);
  writeHistory(tempRoot, 99_000);
  const junitPath = path.join(tempRoot, 'test-report.xml');
  fs.writeFileSync(junitPath, FIXTURE_XML);
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, `--junit=${junitPath}`, '--top=1'],
    { cwd: tempRoot, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^9\.000s\s+tests\/perf\.load\.test\.js\s+\[load\]\r?\n$/);
  assert.doesNotMatch(result.stdout, /from-history/);
});

test('explicit --history conflicts with --junit', (t) => {
  const tempRoot = makeCliRoot(t);
  writeHistory(tempRoot);
  const junitPath = path.join(tempRoot, 'test-report.xml');
  fs.writeFileSync(junitPath, FIXTURE_XML);
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--history', `--junit=${junitPath}`],
    { cwd: tempRoot, encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^\[report-slow-tests\] --history and --junit cannot be used together\r?\n$/);
});

test('CLI with missing --junit path exits 1 with a clear error', () => {
  const missingPath = path.join(os.tmpdir(), `report-slow-tests-missing-${Date.now()}.xml`);
  const result = spawnSync(process.execPath, [SCRIPT_PATH, `--junit=${missingPath}`], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed to read JUnit report/);
});

test('CLI with a real --junit fixture file prints top lines and exits 0', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-slow-tests-'));
  const fixturePath = path.join(tmpDir, 'test-report.xml');
  fs.writeFileSync(fixturePath, FIXTURE_XML);
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, `--junit=${fixturePath}`, '--top=3'],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^9\.000s\s+tests\/perf\.load\.test\.js\s+\[load\]$/);
  assert.match(lines[1], /^5\.000s\s+tests\/a\.test\.js\s+\[parallel\]$/);
  assert.match(lines[2], /^2\.500s\s+tests\/b\.test\.js\s+\[parallel\]$/);
});
