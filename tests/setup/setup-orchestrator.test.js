'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { EXIT, parseArgs, npmCommand, runSetup } = require('../../scripts/setup/setup');

function makeUi() {
  const log = [];
  const rec = (kind) => (text) => log.push([kind, text]);
  return {
    log,
    heading: rec('heading'),
    step: rec('step'),
    ok: rec('ok'),
    skip: rec('skip'),
    warn: rec('warn'),
    fail: rec('fail'),
    info: rec('info'),
    progress: (label, percent) => log.push(['progress', label, percent]),
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
function autoCloseSpawn(code) {
  return () => {
    const child = fakeChild();
    process.nextTick(() => child.emit('close', code));
    return child;
  };
}

function isVenvCommand(command) {
  return String(command || '').replaceAll('\\', '/').includes('/.venv/');
}

// A capture-run that satisfies prereqs on macOS and lets per-test overrides
// tweak the model-show / pip results.
function makeRunCapture({ modelShowStatus = 0, pipStatus = 0, pythonFound = true } = {}) {
  return (cmd, args = []) => {
    const joined = args.join(' ');
    if (joined.includes('--version')) {
      if (isVenvCommand(cmd)) {
        return joined.includes('-m pip')
          ? { status: 0, stdout: 'pip 24.3.1' }
          : { status: 0, stdout: 'Python 3.11.9' };
      }
      if (cmd === 'npm') return { status: 0, stdout: '10.9.2' };
      if (cmd === 'git') return { status: 0, stdout: 'git version 2.45.0' };
      if ((cmd === 'python3.11' || cmd === 'python3') && pythonFound) {
        return { status: 0, stdout: 'Python 3.11.9' };
      }
      return { status: 127, stdout: '', stderr: '' };
    }
    if (cmd === 'ollama' && args[0] === 'show') return { status: modelShowStatus };
    if (cmd === 'which' || cmd === 'where') return { status: 0, stdout: 'ollama\n' };
    if (joined.includes('pip install -e')) return { status: pipStatus, stderr: pipStatus ? 'pip boom' : '' };
    return { status: 0, stdout: '' };
  };
}

function baseDeps(overrides = {}) {
  return {
    runCapture: makeRunCapture(),
    runStreaming: async () => ({ status: 0 }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.30.10' }) }),
    spawnImpl: autoCloseSpawn(0),
    fileExists: () => true,
    sleepImpl: async () => {},
    promptYesNo: async () => true,
    rename: () => {},
    ...overrides,
  };
}

test('parseArgs reads every flag', () => {
  const opts = parseArgs(['--yes', '--skip-model', '--no-launch', '--no-precommit', '--dev', '--model', 'foo:bar', '--force']);
  assert.equal(opts.yes, true);
  assert.equal(opts.skipModel, true);
  assert.equal(opts.noLaunch, true);
  assert.equal(opts.noPrecommit, true);
  assert.equal(opts.dev, true);
  assert.equal(opts.force, true);
  assert.equal(opts.model, 'foo:bar');
});

test('parseArgs supports --model=tag', () => {
  assert.equal(parseArgs(['--model=qwen3:8b']).model, 'qwen3:8b');
});

test('parseArgs rejects unknown flags, missing model values, and option-shaped tags', () => {
  assert.ok(parseArgs(['--wat']).errors.length);
  assert.ok(parseArgs(['--model']).errors.length);
  assert.ok(parseArgs(['--model', '--force']).errors.length);
  assert.ok(parseArgs(['--model=']).errors.length);
  assert.ok(parseArgs(['--model=--force']).errors.length);
});

test('npmCommand is .cmd on Windows only', () => {
  assert.equal(npmCommand('win32'), 'npm.cmd');
  assert.equal(npmCommand('darwin'), 'npm');
});

test('--help returns OK without running phases', async () => {
  const code = await runSetup({ argv: ['--help'], ui: makeUi(), platform: 'darwin', deps: baseDeps() });
  assert.equal(code, EXIT.OK);
});

test('--help does not mask an unknown option', async () => {
  const ui = makeUi();
  const code = await runSetup({
    argv: ['--help', '--unknown'],
    ui,
    platform: 'darwin',
    deps: baseDeps(),
  });

  assert.equal(code, EXIT.PREREQ);
  assert.ok(ui.log.some(([kind, text]) => kind === 'fail' && /Unknown option/.test(text)));
});

test('happy path (everything present, model cached, no launch) returns OK', async () => {
  const ui = makeUi();
  const code = await runSetup({
    argv: ['--no-launch'],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui,
    deps: baseDeps(),
  });
  assert.equal(code, EXIT.OK);
  // model already present -> the pull is skipped, not attempted.
  assert.ok(ui.log.some(([kind, text]) => kind === 'skip' && /already downloaded/.test(text)));
});

test('Node below the minimum fails fast with the prereq exit code', async () => {
  const code = await runSetup({
    argv: ['--no-launch'],
    platform: 'darwin',
    nodeVersion: '22.11.0',
    ui: makeUi(),
    deps: baseDeps(),
  });
  assert.equal(code, EXIT.PREREQ);
});

test('missing Python fails with the prereq exit code', async () => {
  const code = await runSetup({
    argv: ['--no-launch'],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({ runCapture: makeRunCapture({ pythonFound: false }) }),
  });
  assert.equal(code, EXIT.PREREQ);
});

test('a pip install failure maps to the python exit code', async () => {
  const code = await runSetup({
    argv: ['--no-launch'],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({ runCapture: makeRunCapture({ pipStatus: 1 }) }),
  });
  assert.equal(code, EXIT.PYTHON);
});

test('Ollama absent + install declined + not --skip-model returns the ollama exit code', async () => {
  const code = await runSetup({
    argv: ['--no-launch'],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({
      fetchImpl: async () => ({ ok: false }),
      runCapture: (cmd, args = []) => {
        const joined = args.join(' ');
        if (joined.includes('--version')) {
          if (isVenvCommand(cmd)) {
            return joined.includes('-m pip')
              ? { status: 0, stdout: 'pip 24.3.1' }
              : { status: 0, stdout: 'Python 3.11.9' };
          }
          if (cmd === 'npm') return { status: 0, stdout: '10.9.2' };
          if (cmd === 'python3.11' || cmd === 'python3') return { status: 0, stdout: 'Python 3.11.9' };
          if (cmd === 'git') return { status: 0, stdout: 'git version 2.45.0' };
          return { status: 127 };
        }
        if (cmd === 'which' || cmd === 'where') return { status: 1, stdout: '' }; // not on PATH
        return { status: 0 };
      },
      promptYesNo: async () => false, // decline the winget/brew install
    }),
  });
  assert.equal(code, EXIT.OLLAMA);
});

test('Ollama installed via winget mid-run self-heals without a fresh shell (stale PATH)', async () => {
  // First detect: not on PATH and not yet at the known install dir (not installed
  // yet). After the winget "install" streams, the binary now exists at the known
  // install dir — simulating winget writing the registry PATH that this already-
  // running Node process never picks up. The in-process PATH prepend + re-detect
  // (via the absolute-path fallback) must resolve Ollama as installed without
  // requiring a new terminal, so Phase D must NOT bail out with EXIT.OLLAMA.
  const ollamaDir = 'C:\\Users\\x\\AppData\\Local\\Programs\\Ollama';
  const injectedEnv = { PATH: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };
  let installed = false;
  const fileExists = (candidate) => {
    if (String(candidate).includes('Ollama')) {
      return installed;
    }
    return true; // node_modules / .git / other fileExists checks stay happy
  };
  const ui = makeUi();
  const code = await runSetup({
    argv: ['--no-launch'],
    platform: 'win32',
    nodeVersion: '22.23.2',
    env: injectedEnv,
    ui,
    deps: baseDeps({
      // Daemon is down until Ollama is "installed"; once installed, ensureServing's
      // spawn('ollama', ['serve']) (stubbed below as an immediate no-op) plus this
      // re-probe reports it serving, matching the neighboring ensureServing tests.
      fetchImpl: async () => ({ ok: installed, json: async () => ({ version: '0.30.10' }) }),
      runCapture: (cmd, args = []) => {
        const joined = args.join(' ');
        if (joined.includes('--version')) {
          if (isVenvCommand(cmd)) {
            return joined.includes('-m pip')
              ? { status: 0, stdout: 'pip 24.3.1' }
              : { status: 0, stdout: 'Python 3.11.9' };
          }
          if (cmd === 'npm') return { status: 0, stdout: '10.9.2' };
          if (cmd === 'python3.11' || cmd === 'python3') return { status: 0, stdout: 'Python 3.11.9' };
          if (cmd === 'git') return { status: 0, stdout: 'git version 2.45.0' };
          return { status: 127 };
        }
        // `where ollama` never resolves in this test — PATH only gets the
        // fallback dir prepended, and this fake runCapture doesn't consult
        // process.env.PATH — so detection must go through the absolute-path
        // fallback (fileExists), which is exactly what's under test.
        if (cmd === 'where' || cmd === 'which') return { status: 1, stdout: '' };
        return { status: 0 };
      },
      fileExists,
      promptYesNo: async () => true, // consent to the winget install
      runStreaming: async (cmd, cmdArgs) => {
        if (cmd === 'winget') {
          // Simulate the install landing the binary at the known install dir.
          installed = true;
        }
        return { status: 0 };
      },
    }),
  });
  assert.notEqual(code, EXIT.OLLAMA, 'self-heal via absolute-path fallback must avoid the ollama exit code');
  assert.ok(!ui.log.some(([kind, text]) => kind === 'warn' && /not on this terminal.?s PATH/i.test(text)));
  assert.ok(String(injectedEnv.PATH || '').includes(ollamaDir), 'the known install dir must be prepended to the injected PATH');
});

test('an outdated running Ollama is upgraded, restarted, and re-probed before setup continues', async () => {
  let activeVersion = '0.20.4';
  let restartCalls = 0;
  const commands = [];
  const code = await runSetup({
    argv: ['--no-launch'],
    platform: 'win32',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ version: activeVersion }),
      }),
      runStreaming: async (cmd, args) => {
        commands.push([cmd, args]);
        return { status: 0 };
      },
      restartOllamaAfterUpgrade: async () => {
        restartCalls += 1;
        activeVersion = '0.30.10';
        return { ok: true };
      },
    }),
  });

  assert.equal(code, EXIT.OK);
  assert.equal(restartCalls, 1);
  assert.equal(
    commands.some(([cmd, args]) => cmd === 'winget' && args[0] === 'upgrade'),
    true
  );
});

test('a failed Ollama package-manager upgrade does not restart or continue to model pulls', async () => {
  let restartCalls = 0;
  const code = await runSetup({
    argv: ['--no-launch'],
    platform: 'win32',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ version: '0.20.4' }),
      }),
      runStreaming: async (cmd) => ({ status: cmd === 'winget' ? 7 : 0 }),
      restartOllamaAfterUpgrade: async () => {
        restartCalls += 1;
        return { ok: true };
      },
    }),
  });

  assert.equal(code, EXIT.OLLAMA);
  assert.equal(restartCalls, 0);
});

test('--skip-model tolerates a missing Ollama and still completes', async () => {
  const code = await runSetup({
    argv: ['--no-launch', '--skip-model'],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({
      fetchImpl: async () => ({ ok: false }),
      runCapture: (cmd, args = []) => {
        const joined = args.join(' ');
        if (joined.includes('--version')) {
          if (isVenvCommand(cmd)) {
            return joined.includes('-m pip')
              ? { status: 0, stdout: 'pip 24.3.1' }
              : { status: 0, stdout: 'Python 3.11.9' };
          }
          if (cmd === 'npm') return { status: 0, stdout: '10.9.2' };
          if (cmd === 'python3.11' || cmd === 'python3') return { status: 0, stdout: 'Python 3.11.9' };
          if (cmd === 'git') return { status: 0, stdout: 'git version 2.45.0' };
          return { status: 127 };
        }
        if (cmd === 'which' || cmd === 'where') return { status: 1, stdout: '' };
        return { status: 0 };
      },
      promptYesNo: async () => false,
    }),
  });
  assert.equal(code, EXIT.OK);
});

test('a failed model pull defers to the model exit code but does not abort setup', async () => {
  const ui = makeUi();
  const code = await runSetup({
    argv: ['--no-launch'],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui,
    deps: baseDeps({
      runCapture: makeRunCapture({ modelShowStatus: 1 }), // model NOT present -> pull
      spawnImpl: autoCloseSpawn(1), // pull exits non-zero
    }),
  });
  assert.equal(code, EXIT.MODEL);
  assert.ok(ui.log.some(([kind, text]) => kind === 'warn' && /pull failed/i.test(text)));
});

test('a clean launch still reports incomplete setup when the model pull failed', async () => {
  const code = await runSetup({
    argv: [], // launch path (no --no-launch)
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({
      runCapture: makeRunCapture({ modelShowStatus: 1 }), // model NOT present -> pull
      spawnImpl: autoCloseSpawn(1), // pull fails -> deferredCode = EXIT.MODEL
      runStreaming: async () => ({ status: 0 }), // npm run dev launches + exits clean
      promptYesNo: async () => true, // consent to launch
    }),
  });
  assert.equal(code, EXIT.MODEL);
});

test('a launch that cannot spawn npm surfaces a non-zero setup exit', async () => {
  const code = await runSetup({
    argv: [],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({
      // npm run dev fails to start (spawn error -> 127); pre-commit (-m ...) is fine.
      runStreaming: async (cmd, args) => (args && args[0] === 'run' ? { status: 127 } : { status: 0 }),
      promptYesNo: async () => true,
    }),
  });
  assert.equal(code, EXIT.UNKNOWN);
});

test('distribution build launches detached (no console) and returns OK', async () => {
  const calls = { detached: 0, streaming: 0 };
  const code = await runSetup({
    argv: [],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({
      isDistribution: () => true,
      launchDetached: async (cmd, args) => {
        if (args && args[0] === 'run') calls.detached += 1;
        return { status: 0 };
      },
      runStreaming: async (cmd, args) => {
        if (args && args[0] === 'run') calls.streaming += 1;
        return { status: 0 };
      },
      promptYesNo: async () => true,
    }),
  });
  assert.equal(code, EXIT.OK);
  assert.equal(calls.detached, 1); // launched via the detached, console-free path
  assert.equal(calls.streaming, 0); // never used the attached npm run dev console
});

test('distribution build surfaces a non-zero exit when the detached launch fails', async () => {
  const code = await runSetup({
    argv: [],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({
      isDistribution: () => true,
      launchDetached: async () => ({ status: 127 }),
      promptYesNo: async () => true,
    }),
  });
  assert.equal(code, EXIT.UNKNOWN);
});

test('distribution build rejects an immediate detached exit even with code zero', async () => {
  const code = await runSetup({
    argv: [],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({
      isDistribution: () => true,
      launchDetached: async () => ({ status: 0, earlyExit: true }),
      promptYesNo: async () => true,
    }),
  });
  assert.equal(code, EXIT.UNKNOWN);
});

test('dev repo keeps the attached npm run dev console (no detached launch)', async () => {
  const calls = { detached: 0, streaming: 0 };
  const code = await runSetup({
    argv: [],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui: makeUi(),
    deps: baseDeps({
      isDistribution: () => false,
      launchDetached: async () => {
        calls.detached += 1;
        return { status: 0 };
      },
      runStreaming: async (cmd, args) => {
        if (args && args[0] === 'run') calls.streaming += 1;
        return { status: 0 };
      },
      promptYesNo: async () => true,
    }),
  });
  assert.equal(code, EXIT.OK);
  assert.equal(calls.detached, 0);
  assert.equal(calls.streaming, 1);
});
