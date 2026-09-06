'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const DIST_NODE_TESTS = Object.freeze([
  'tests/electron-session-store.test.js',
  'tests/release-compat/test_session_store_compat.js',
  'tests/release-compat/test_terminal_repair_store_compat.js',
  // The safe runner discovers *.test.js only, so every tests/release-compat/
  // test_*.js file runs HERE or nowhere. Four were added after this list was
  // written and went unrun; test_session_store_v18_stability.js had been red
  // since the store schema moved off 18. check_release_compat_registered.py
  // now fails the policy gate if this list drifts from the directory again.
  'tests/release-compat/test_archive_compat.js',
  'tests/release-compat/test_mcp_config_compat.js',
  'tests/release-compat/test_plugin_store_compat.js',
  'tests/release-compat/test_session_store_v18_stability.js',
  'tests/release-compat/test_shell_config_v49_run_mode.js',
  'tests/release-compat/test_shell_config_v50_tool_retirement.js',
]);

const DIST_PYTHON_TESTS = Object.freeze([
  'tests/release-compat/test_memory_store_compat.py',
  'tests/sidecar/test_protocol.py',
  'tests/sidecar/runtime/test_capabilities.py',
  'tests/sidecar/test_phase2_release_checks.py',
]);

function resolvePythonExecutable({
  root = ROOT,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const candidates = platform === 'win32'
    ? [path.join(root, '.venv', 'Scripts', 'python.exe')]
    : [path.join(root, '.venv', 'bin', 'python')];
  return candidates.find((candidate) => existsSync(candidate))
    || (platform === 'win32' ? 'python' : 'python3');
}

function parseArgs(argv = process.argv.slice(2)) {
  let python = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--python') {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error('--python requires an executable path');
    }
    python = value;
    index += 1;
  }
  return { python };
}

// The dev extras (pytest + friends) are opt-in at install time (see
// scripts/setup/setup.js `pipTarget`) so a friend's run-only setup does not
// pull in test/lint/type tooling it will never use. That means the pytest
// lane below can legitimately hit a venv that has never had pytest
// installed. Rather than fail-red on a correct runtime-only install, detect
// that and self-heal by installing the `dev` extra into the SAME resolved
// interpreter before running the tests. This must never *skip* the lane —
// only make it possible to run.
const DEV_EXTRA_TARGET = '.[dev]';

function probePytest({ python, root, spawn }) {
  const result = spawn(python, ['-B', '-m', 'pytest', '--version'], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
  return !result.error && result.status === 0;
}

function ensurePytestAvailable({
  python,
  root = ROOT,
  spawn = spawnSync,
  log = console.log,
} = {}) {
  if (probePytest({ python, root, spawn })) {
    return { ok: true };
  }

  log(`[test:dist] pytest not found in ${python}; this is expected on a runtime-only `
    + `install (pip install -e .). Installing the dev extra so the deterministic Python `
    + `compatibility tests can run: ${python} -m pip install -e "${DEV_EXTRA_TARGET}"`);
  const install = spawn(python, ['-m', 'pip', 'install', '-e', DEV_EXTRA_TARGET], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  if (install.error || install.status !== 0) {
    return {
      ok: false,
      message: 'Automatic install of the dev test extras failed (likely offline). '
        + `Run this yourself, then re-run "npm run test:dist": ${python} -m pip install -e "${DEV_EXTRA_TARGET}"`,
    };
  }

  if (!probePytest({ python, root, spawn })) {
    return {
      ok: false,
      message: 'The dev extra installed without error, but pytest is still unavailable. '
        + `Run this yourself, then re-run "npm run test:dist": ${python} -m pip install -e "${DEV_EXTRA_TARGET}"`,
    };
  }
  return { ok: true };
}

function buildDistTestCommands({
  node = process.execPath,
  python = resolvePythonExecutable(),
} = {}) {
  return [
    {
      label: 'release version policy',
      executable: python,
      args: ['-B', 'scripts/checks/check_release_version_policy.py'],
    },
    {
      label: 'release manifest policy',
      executable: python,
      args: ['-B', 'scripts/checks/check_release_manifest_block.py'],
    },
    {
      label: 'deterministic Node integration tests',
      executable: node,
      args: [
        'scripts/run-node-tests-safe.js',
        '--no-lock',
        ...DIST_NODE_TESTS,
        '--timeout-ms=600000',
      ],
    },
    {
      label: 'deterministic Python compatibility tests',
      executable: python,
      args: [
        '-B',
        '-m',
        'pytest',
        ...DIST_PYTHON_TESTS,
        '-q',
        '-p',
        'no:cacheprovider',
      ],
      // Signals to runDistTests that pytest availability must be verified
      // (and self-healed if missing) before this command runs.
      requiresPytest: true,
    },
  ];
}

function runDistTests({
  commands,
  root = ROOT,
  spawn = spawnSync,
  log = console.log,
  error = console.error,
} = {}) {
  for (const command of commands) {
    if (command.requiresPytest) {
      const readiness = ensurePytestAvailable({ python: command.executable, root, spawn, log });
      if (!readiness.ok) {
        error(`[test:dist] ${readiness.message}`);
        return 1;
      }
    }
    log(`[test:dist] ${command.label}`);
    const result = spawn(command.executable, command.args, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
    });
    if (result.error) {
      error(`[test:dist] failed to start ${command.label}: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) {
      error(`[test:dist] ${command.label} failed with exit code ${result.status}`);
      return result.status || 1;
    }
  }
  log('[test:dist] PASS: supported distribution verification');
  return 0;
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const python = args.python || resolvePythonExecutable();
    return runDistTests({ commands: buildDistTestCommands({ python }) });
  } catch (caught) {
    console.error(`[test:dist] ${caught.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DIST_NODE_TESTS,
  DIST_PYTHON_TESTS,
  buildDistTestCommands,
  ensurePytestAvailable,
  main,
  parseArgs,
  resolvePythonExecutable,
  runDistTests,
};
