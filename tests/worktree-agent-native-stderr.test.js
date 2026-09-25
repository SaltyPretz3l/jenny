'use strict';

// worktree-agent.ps1 runs with $ErrorActionPreference = 'Stop'. Windows
// PowerShell 5.1 wraps a native command's stderr line in an ErrorRecord when
// its output is redirected (agent shells, CI), so a warning on a successful
// git/npm/pip call used to abort the script. These tests run a copy of the
// script against shim executables, so no real worktree or install happens.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'worktree-agent.ps1');
const skip = process.platform !== 'win32' ? 'worktree-agent.ps1 is Windows-only' : false;

function makeSandbox(t, { gitExit = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-wt-agent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'worktree-agent.ps1'));
  const log = path.join(root, 'calls.log');
  // Each shim records its call, writes progress to stderr, and prints one stdout
  // line, like `git worktree add` ("Preparing worktree ...") and `npm ci` warnings.
  const shim = (name, exitCode) =>
    fs.writeFileSync(
      path.join(bin, `${name}.cmd`),
      `@echo ${name} %*>>"${log}"\r\n` +
        (name === 'git' ? '@if "%3 %4"=="worktree add" mkdir "%~5"\r\n' : '') +
        `@echo ${name} progress on stderr 1>&2\r\n` +
        `@echo ${name} stdout line\r\n` +
        `@exit /b ${exitCode}\r\n`
    );
  shim('git', gitExit);
  shim('npm', 0);
  return { root, repo, bin, log };
}

// Invoked the way agent shells do: `& script ... 2>&1 | ...`. The caller's
// redirect is what makes 5.1 turn native stderr into ErrorRecords inside it.
function runAgent(sandbox, args) {
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  const script = path.join(sandbox.repo, 'scripts', 'worktree-agent.ps1');
  const invocation = [script, ...args, '-WorktreeRoot', path.join(sandbox.root, 'trees')]
    .map((value) => (value.startsWith('-') ? value : quote(value)))
    .join(' ');
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `& ${invocation} 2>&1 | ForEach-Object { "$_" }; exit $LASTEXITCODE`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${sandbox.bin};${process.env.PATH}` },
      timeout: 60_000,
      windowsHide: true,
    }
  );
}

function readCalls(sandbox) {
  return fs.existsSync(sandbox.log) ? fs.readFileSync(sandbox.log, 'utf8') : '';
}

test('new survives stderr output from successful git and npm calls', { skip }, (t) => {
  const sandbox = makeSandbox(t);

  const result = runAgent(sandbox, ['new', 'demo-task']);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Worktree ready:/);
  assert.match(`${result.stdout}${result.stderr}`, /git progress on stderr/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /NativeCommandError/);
  const calls = readCalls(sandbox);
  assert.match(calls, /^git -C .* worktree add .*demo-task -b wt\/demo-task main/m);
  assert.match(calls, /^npm ci/m);
});

test('new still fails on a nonzero git exit code', { skip }, (t) => {
  const sandbox = makeSandbox(t, { gitExit: 3 });

  const result = runAgent(sandbox, ['new', 'demo-task', '-NoInstall']);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /failed with exit code 3/);
  assert.doesNotMatch(readCalls(sandbox), /^npm/m);
});
