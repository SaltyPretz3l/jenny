'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TESTS_ROOT = path.join(ROOT, 'tests');
const TIMELINE_REPLAY_ROOT = path.join(TESTS_ROOT, 'fixtures', 'timeline-replay');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function coverageScenarioRowPattern(scenarioName) {
  return new RegExp(`\\|\\s*\`${escapeRegExp(scenarioName)}\`\\s*\\|`);
}

function listTimelineReplayScenarios() {
  return fs.readdirSync(TIMELINE_REPLAY_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listRootTestFiles(suffix) {
  return fs.readdirSync(TESTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => path.join(TESTS_ROOT, entry.name))
    .sort();
}

test('timeline replay coverage matrix lists every scenario directory', () => {
  const coveragePath = path.join(TIMELINE_REPLAY_ROOT, 'COVERAGE.md');
  assert.equal(fs.existsSync(coveragePath), true, 'timeline replay coverage matrix must exist');

  const coverage = fs.readFileSync(coveragePath, 'utf8');
  for (const scenarioName of listTimelineReplayScenarios()) {
    assert.match(
      coverage,
      coverageScenarioRowPattern(scenarioName),
      `COVERAGE.md must list ${scenarioName}`
    );
  }
});

test('renderer shell tests use the renderer shell harness', () => {
  const shellTestFiles = listRootTestFiles('-shell.test.js');
  assert.ok(shellTestFiles.length > 0, 'expected renderer shell tests to exist');

  const missingHarnessImports = shellTestFiles
    .filter((filePath) => path.basename(filePath).startsWith('renderer-'))
    .filter((filePath) => !fs.readFileSync(filePath, 'utf8').includes("require('./helpers/renderer-shell-harness')"))
    .map((filePath) => path.relative(ROOT, filePath).replace(/\\/g, '/'));

  assert.deepEqual(missingHarnessImports, []);
});

test('renderer utility tests stay independent from the renderer shell harness', () => {
  const utilityTestFiles = listRootTestFiles('-utils.test.js')
    .filter((filePath) => path.basename(filePath).startsWith('renderer-'));
  assert.ok(utilityTestFiles.length > 0, 'expected renderer utility tests to exist');

  const harnessBackedUtilityTests = utilityTestFiles
    .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes('renderer-shell-harness'))
    .map((filePath) => path.relative(ROOT, filePath).replace(/\\/g, '/'));

  assert.deepEqual(harnessBackedUtilityTests, []);
});
