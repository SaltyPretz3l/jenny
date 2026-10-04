'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { pythonCandidates } = require('../../scripts/setup/prereqs');

// setup.ps1 cannot be executed from a test, so this compares its Test-Python311
// candidate commands with the JS prerequisite detector as text.
const SETUP_PS1 = path.join(__dirname, '..', '..', 'setup.ps1');

function wrapperPythonCandidates() {
  const source = fs.readFileSync(SETUP_PS1, 'utf8');
  const start = source.indexOf('function Test-Python311');
  assert.ok(start >= 0, 'setup.ps1 must define Test-Python311');
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, 'Test-Python311 must close with a brace at column 0');
  const body = source.slice(start, end);
  const candidates = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*&\s+(\S+)((?:\s+-[\w.]+)*)\s+-c\s/);
    if (match) {
      candidates.push({ cmd: match[1], args: match[2].trim().split(/\s+/).filter(Boolean) });
    }
  }
  return { body, candidates };
}

test('setup.ps1 Test-Python311 tries the same interpreters, in order, as pythonCandidates(win32)', () => {
  const { candidates } = wrapperPythonCandidates();
  assert.deepEqual(candidates, pythonCandidates('win32'));
});

test('setup.ps1 guards every interpreter command with Test-Have', () => {
  const { body, candidates } = wrapperPythonCandidates();
  for (const cmd of new Set(candidates.map((candidate) => candidate.cmd))) {
    assert.ok(body.includes(`Test-Have '${cmd}'`), `Test-Python311 must check Test-Have '${cmd}'`);
  }
});
