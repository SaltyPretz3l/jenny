'use strict';

// Python gate for scripts/run-node-tests-safe.js. The suites listed in
// tests/.needs-python.json start the real sidecar from <repo>/.venv, so in a
// tree without that venv (a worktree made without -WithVenv) they cannot run:
//  - found by directory discovery: left out and counted, the run can still be
//    green;
//  - named on the command line, or selected by --last-failed/--changed: not
//    run, and the run fails with the reason, because a targeted run that
//    silently skipped its target would read as a pass;
//  - JENNY_REQUIRE_PYTHON_TESTS=1 (the full gate): every listed file is such a
//    failure, so a gate can never go green without them.
//
// The gate stands down when JENNY_TEST_PYTHON names an interpreter (some
// suites accept it in place of the venv) and for --no-default-test-flags runs.
// A sidecar-backed suite that is missing from the list fails without a venv
// like any other test, so a stale list can only cost a red run.

const fs = require('fs');
const path = require('path');
const { normalizeRepoPath, normalizeChildArgPath } = require('./run-node-tests-safe-support');

const NEEDS_PYTHON_PATH = path.join('tests', '.needs-python.json');
const REQUIRE_ENV_VAR = 'JENNY_REQUIRE_PYTHON_TESTS';
const NO_VENV_REASON =
  'needs the repo Python venv and this tree has no .venv ' +
  '(create the worktree with scripts/worktree-agent.ps1 new <name> -WithVenv, or run from the main checkout)';

function venvPythonPath(cwd) {
  return process.platform === 'win32'
    ? path.join(cwd, '.venv', 'Scripts', 'python.exe')
    : path.join(cwd, '.venv', 'bin', 'python');
}

function loadNeedsPython(cwd) {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(cwd, NEEDS_PYTHON_PATH), 'utf8'));
    if (!payload || !Array.isArray(payload.files)) return new Set();
    return new Set(payload.files.filter((entry) => typeof entry === 'string' && entry).map(normalizeRepoPath));
  } catch {
    return new Set();
  }
}

// Splits childArgs into the files to run, the listed files left out (skipped)
// and the listed files whose absence fails the run (failed). `explicit` is the
// set of files named on the command line; `targeted` says a --last-failed or
// --changed filter chose childArgs. A no-op when the venv exists, so a normal
// run in the main checkout is unchanged.
function applyPythonGate(childArgs, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const gate = { childArgs, skipped: [], failed: [] };
  if (options.managed === false || env.JENNY_TEST_PYTHON || fs.existsSync(venvPythonPath(cwd))) return gate;
  const listed = loadNeedsPython(cwd);
  if (listed.size === 0) return gate;
  const failEvery = env[REQUIRE_ENV_VAR] === '1' || Boolean(options.targeted);
  const explicit = options.explicit || new Set();
  const skipped = new Set();
  const failed = new Set();
  gate.childArgs = childArgs.filter((childArg) => {
    const key = normalizeChildArgPath(childArg, cwd);
    if (!listed.has(key)) return true;
    (failEvery || explicit.has(key) ? failed : skipped).add(key);
    return false;
  });
  gate.skipped = [...skipped];
  gate.failed = [...failed];
  return gate;
}

// Summary lines. The runner reports the failed files as not run, which fails
// the run and puts them in the JUnit report, the history and --last-failed.
function describePythonGate(gate) {
  const lines = [];
  if (gate.skipped.length > 0) {
    lines.push(
      `[run-node-tests-safe] SKIPPED: ${gate.skipped.length} file(s) that need the repo Python venv ` +
        `(no .venv in this tree; the full gate sets ${REQUIRE_ENV_VAR}=1 and fails without them)`
    );
  }
  if (gate.failed.length > 0) {
    lines.push(
      `[run-node-tests-safe] NO PYTHON VENV: ${gate.failed.length} file(s) not run, which fails this run: ${NO_VENV_REASON}`
    );
  }
  return lines;
}

module.exports = { NEEDS_PYTHON_PATH, venvPythonPath, applyPythonGate, describePythonGate };
