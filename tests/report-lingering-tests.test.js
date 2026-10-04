'use strict';

// scripts/report-lingering-tests.js + scripts/tests/linger-probe.js: the
// diagnostic that finds test files whose process outlives its tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_PATH = path.join(ROOT, 'scripts', 'run-node-tests-safe.js');
const {
  PROBE_PATH,
  formatLingerReport,
  readLingerReport,
} = require('../scripts/report-lingering-tests');

test('the probe reports a file that leaves a referenced timer armed, and not a clean one', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linger-probe-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const leaky = path.join(tempRoot, 'leaky.test.js');
  const clean = path.join(tempRoot, 'clean.test.js');
  const reportPath = path.join(tempRoot, 'lingering.jsonl');
  fs.writeFileSync(leaky, "require('node:test')('leaves a timer', () => { setTimeout(() => {}, 2500); });\n");
  fs.writeFileSync(clean, "require('node:test')('leaves nothing', () => {});\n");

  const result = spawnSync(process.execPath, [RUNNER_PATH, '--no-lock', leaky, clean, '--timeout-ms=60000'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
    env: {
      ...process.env,
      JENNY_LINGER_REPORT: reportPath,
      NODE_OPTIONS: `--require=${PROBE_PATH.replace(/\\/g, '/')}`,
    },
  });
  assert.equal(result.status, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);

  const rows = readLingerReport(reportPath, tempRoot);
  assert.deepEqual(rows.map((row) => row.file), ['leaky.test.js']);
  assert.ok(rows[0].lingerMs >= 1000, `lingered ${rows[0].lingerMs} ms`);
  assert.ok(rows[0].resources.includes('Timeout'));
});

test('the report lists lingering files longest first with what held them open', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linger-report-'));
  try {
    const reportPath = path.join(tempRoot, 'lingering.jsonl');
    fs.writeFileSync(reportPath, [
      JSON.stringify({ file: path.join(tempRoot, 'a.test.js'), lingerMs: 5000, resources: ['Timeout'] }),
      '{"torn line',
      JSON.stringify({ file: path.join(tempRoot, 'b.test.js'), lingerMs: 30000, resources: ['Timeout', 'Timeout', 'ProcessWrap'] }),
      '',
    ].join('\n'));
    const rows = readLingerReport(reportPath, tempRoot);
    assert.deepEqual(rows.map((row) => row.file), ['b.test.js', 'a.test.js']);
    assert.equal(
      formatLingerReport(rows),
      [
        '[lingering-tests] 2 file(s) lingered, 35.0s in total:',
        '[lingering-tests]   30.0s b.test.js (Timeout x2, ProcessWrap)',
        '[lingering-tests]   5.0s a.test.js (Timeout)',
      ].join('\n')
    );
    assert.match(formatLingerReport([]), /no test file lingered/);
    assert.deepEqual(readLingerReport(path.join(tempRoot, 'missing.jsonl'), tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
