'use strict';

// Row 103 (security review item 2): the JS half of the command-prefix
// derivation. The fixture is shared with
// tests/sidecar/ai/tools/test_command_prefix.py so both languages agree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  commandMatchesExact,
  commandMatchesPrefix,
  deriveCommandScope,
  MAX_COMMAND_CHARS,
  normalizeCommandMatchKeys,
  RUNNER_SUBCOMMANDS,
  WRAPPER_PROGRAMS,
} = require('../services/tools/command-prefix');

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'command-prefix-cases.json'), 'utf8'
));

test('the shared fixture carries at least 40 derivation cases', () => {
  assert.ok(FIXTURE.cases.length >= 40, `only ${FIXTURE.cases.length} cases`);
  for (const scope of ['prefix', 'exact', 'none']) {
    assert.ok(FIXTURE.cases.some((entry) => entry.expected.scope === scope), scope);
  }
});

for (const entry of FIXTURE.cases) {
  test(`derive ${JSON.stringify(entry.command)} -> ${entry.expected.scope}`, () => {
    const result = deriveCommandScope(entry.command);
    assert.equal(result.scope, entry.expected.scope);
    if (entry.expected.scope === 'prefix') assert.equal(result.prefix, entry.expected.prefix);
    if (entry.expected.scope === 'exact') assert.equal(result.command, entry.expected.command);
  });
}

for (const entry of FIXTURE.prefix_matches) {
  test(`prefix ${JSON.stringify(entry.prefix)} vs ${JSON.stringify(entry.command)}`, () => {
    assert.equal(commandMatchesPrefix(entry.command, entry.prefix), entry.matches);
  });
}

for (const entry of FIXTURE.exact_matches) {
  test(`exact ${JSON.stringify(entry.exact)} vs ${JSON.stringify(entry.command)}`, () => {
    assert.equal(commandMatchesExact(entry.command, entry.exact), entry.matches);
  });
}

test('the wrapper list and runner subcommands are frozen', () => {
  assert.ok(Object.isFrozen(WRAPPER_PROGRAMS));
  assert.ok(Object.isFrozen(RUNNER_SUBCOMMANDS));
  for (const name of ['cmd', 'powershell', 'bash', 'sudo', 'python', 'node', 'java']) {
    assert.ok(WRAPPER_PROGRAMS.includes(name), name);
  }
  assert.equal(WRAPPER_PROGRAMS.includes('dotnet'), false);
  assert.deepEqual([...RUNNER_SUBCOMMANDS].sort(), ['dlx', 'exec', 'run', 'tool', 'x']);
});

test('a command longer than the match-text cap has no Always allow', () => {
  const longArgs = 'a'.repeat(MAX_COMMAND_CHARS);
  assert.equal(deriveCommandScope(`npm test ${longArgs}`).scope, 'none');
  assert.equal(commandMatchesPrefix(`npm test ${longArgs}`, 'npm test'), false);
  assert.equal(deriveCommandScope(`npm test ${'a'.repeat(MAX_COMMAND_CHARS - 9)}`).scope, 'prefix');
});

test('non-string commands never derive or match', () => {
  for (const value of [null, undefined, 42, ['npm', 'test'], { command: 'npm test' }]) {
    assert.equal(deriveCommandScope(value).scope, 'none');
    assert.equal(commandMatchesPrefix(value, 'npm test'), false);
    assert.equal(commandMatchesExact(value, 'npm test'), false);
  }
});

test('normalizeCommandMatchKeys validates the rule keys', () => {
  const runCommand = { toolId: 'run_command' };
  assert.deepEqual(normalizeCommandMatchKeys({}, runCommand), {});
  assert.deepEqual(normalizeCommandMatchKeys({ command_prefix: null }, runCommand), {});
  assert.deepEqual(
    normalizeCommandMatchKeys({ command_prefix: 'npm test' }, runCommand),
    { command_prefix: 'npm test' }
  );
  assert.deepEqual(
    normalizeCommandMatchKeys({ command_exact: 'python build.py' }, runCommand),
    { command_exact: 'python build.py' }
  );
  for (const [match, context] of [
    [{ command_prefix: 'npm test', command_exact: 'npm test' }, runCommand],
    [{ command_prefix: 'npm test' }, { toolId: 'write_file' }],
    [{ command_prefix: 'npm test' }, { toolId: '' }],
    [{ command_prefix: 'npm test' }, { toolId: 'run_command', action: 'x' }],
    [{ command_prefix: 'npm test' }, { toolId: 'run_command', pathPrefix: 'src' }],
    [{ command_prefix: 'npm test -x' }, runCommand],
    [{ command_prefix: 'bash -c' }, runCommand],
    [{ command_prefix: 42 }, runCommand],
    [{ command_exact: 'npm test && x' }, runCommand],
    [{ command_exact: ' ls' }, runCommand],
    [{ command_exact: '' }, runCommand],
  ]) {
    assert.equal(normalizeCommandMatchKeys(match, context), null, JSON.stringify(match));
  }
});
