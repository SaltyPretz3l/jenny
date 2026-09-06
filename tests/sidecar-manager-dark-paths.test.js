'use strict';

// Dark-path coverage for services/backend/sidecar-manager.js.
//
// Every collaborator that could touch a real OS resource (child_process spawn,
// global.fetch, killProcessTree, getProcessCommandLine) is injected as a
// hand-built recorder. NO test path lets a real subprocess spawn, a real port
// open, or a real fetch fire. Tests target the uncovered error/branch regions
// that tests/sidecar-manager.test.js does not exercise (repo-root/python
// guards, spawn-error handler, pid<=0 state delete, _waitForHealth fetch-retry
// + exit + timeout, removeListener fallbacks, settled guards).

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { SidecarManager } = require('../services/backend/sidecar-manager');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// A spawn recorder that returns a controllable fake child. Records every call
// so tests can assert the launch command/args/options. NEVER spawns anything.
function makeFakeChild({ pid = 4242, exitCode = null } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = exitCode;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

function buildManager(overrides = {}) {
  const spawnCalls = [];
  const child = overrides.child || makeFakeChild();
  const killCalls = [];
  const cmdlineCalls = [];

  const userDataPath = createTrackedTempDir('jenny-sidecar-dark-data-');
  const repoRoot = overrides.repoRoot || createTrackedTempDir('jenny-sidecar-dark-repo-');

  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    // process.execPath always exists, so the python-existence guard passes
    // unless a test overrides pythonExecutable to a missing path.
    pythonExecutable: overrides.pythonExecutable || process.execPath,
    launchCommand: process.execPath,
    launchArgs: ['--fake-sidecar'],
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
    fetchImpl: overrides.fetchImpl || (async () => {
      throw new Error('fetchImpl must be overridden for external-mode tests');
    }),
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
    },
    getProcessCommandLineImpl: async (pid) => {
      cmdlineCalls.push(pid);
      return '';
    },
    ...overrides.ctor,
  });

  return { manager, spawnCalls, child, killCalls, cmdlineCalls, userDataPath, repoRoot };
}

// ---------------------------------------------------------------------------
// _startManagedDev guards (lines 211-212, 266-267, 347-348)
// ---------------------------------------------------------------------------

test('start throws when the managed backend repo root does not exist (211-212)', async () => {
  const missingRepo = path.join(
    createTrackedTempDir('jenny-sidecar-missing-repo-'),
    'does-not-exist-subdir'
  );
  const { manager, spawnCalls } = buildManager({ repoRoot: missingRepo });

  await assert.rejects(
    manager.start(),
    new RegExp(`Managed backend repo was not found at ${missingRepo.replace(/\\/g, '\\\\')}`)
  );
  // The guard fires BEFORE spawn — no child must ever be launched.
  assert.deepEqual(spawnCalls, []);
});

test('start fails with actionable venv guidance when the python executable is missing', async () => {
  const missingPython = path.join(
    createTrackedTempDir('jenny-sidecar-missing-py-'),
    'no-such-python.exe'
  );
  const logCalls = [];
  const statuses = [];
  // No launchCommand override path forces the python-existence guard.
  const { manager, spawnCalls } = buildManager({
    pythonExecutable: missingPython,
    ctor: {
      launchCommand: undefined,
      launchArgs: undefined,
      logger: (level, event, details) => logCalls.push({ level, event, details }),
    },
  });
  manager.on('status', (status) => statuses.push(status));

  // The message is the entire user-visible remediation for a never-created
  // venv, so assert on its load-bearing parts rather than an exact string.
  await assert.rejects(manager.start(), (error) => {
    assert.ok(
      error.message.includes(missingPython),
      'detail must name the interpreter path it looked for'
    );
    assert.match(error.message, /\.venv/);
    assert.match(error.message, /npm run setup|bash \.\/setup\.sh/);
    return true;
  });
  // The guard fires BEFORE spawn — no child must ever be launched.
  assert.deepEqual(spawnCalls, []);

  const missingLog = logCalls.find((entry) => entry.event === 'backend.sidecar_python_missing');
  assert.ok(missingLog, 'expected a backend.sidecar_python_missing log event');
  assert.equal(missingLog.level, 'ERROR');
  assert.equal(missingLog.details.pythonExecutable, missingPython);

  // Without the status patch the renderer only sees a generic startup crash.
  const failedStatus = statuses.filter((status) => status.phase === 'failed').at(-1);
  assert.ok(failedStatus, 'expected a failed status to be emitted before throwing');
  assert.equal(failedStatus.startupStage, 'python_missing');
  assert.match(failedStatus.detail, /\.venv/);
});

test('start deletes stale state when the spawned child reports pid 0 (347-348)', async () => {
  const child = makeFakeChild({ pid: 0 });
  const { manager, spawnCalls } = buildManager({ child });

  // Pre-seed a state file so we can prove the pid<=0 branch DELETES it instead
  // of writing the launch record.
  manager.stateStore.write({ pid: 111, baseUrl: 'stdio://stale' });
  assert.equal(manager.stateStore.read(null) !== null, true);

  const status = await manager.start();

  assert.equal(spawnCalls.length, 1);
  assert.equal(status.phase, 'ready');
  // pid<=0 means status.pid stays 0 and the state file was deleted, not written.
  assert.equal(status.pid, 0);
  assert.equal(manager.stateStore.read(null), null);
});

test('managed sidecar spawns with JENNY_PARENT_PID so the sidecar can guard against orphaning', async () => {
  const { manager, spawnCalls } = buildManager();

  const status = await manager.start();

  assert.equal(status.phase, 'ready');
  assert.equal(spawnCalls.length, 1);
  const env = spawnCalls[0].options.env;
  // The sidecar's parent-death watchdog reads JENNY_PARENT_PID and self-exits
  // if this process dies (esp. SIGKILL on Windows). It must be the live pid.
  assert.equal(env.JENNY_PARENT_PID, String(process.pid));
  assert.equal(env.PYTHONUNBUFFERED, '1');
});

// ---------------------------------------------------------------------------
// F8: the managed sidecar is a model-adjacent child. It re-spawns Python
// workers and, with the opt-in codex-cli engine, a vendor CLI. `{...process.env}`
// handed every one of those descendants the developer/CI shell's credentials.
// ---------------------------------------------------------------------------

const SENTINEL_PARENT_SECRETS = {
  OPENAI_API_KEY: 'sk-proj-SENTINEL0123456789abcdef',
  ANTHROPIC_API_KEY: 'sk-ant-SENTINEL01234',
  GITHUB_TOKEN: 'ghp_SENTINEL01234567',
  GH_TOKEN: 'gho_SENTINEL01234567',
  AWS_SECRET_ACCESS_KEY: 'SENTINELawsSecret0123456789abcdef',
  AWS_SESSION_TOKEN: 'SENTINELawsSession0123456789',
  HF_TOKEN: 'hf_SENTINELabcdefghijklmnopqrstuvwx',
  HUGGINGFACE_HUB_TOKEN: 'hf_SENTINELabcdefghijklmnopqrstuvwx',
  HTTPS_PROXY: 'https://user:SENTINELproxyPass@proxy.internal:8080',
  NPM_TOKEN: 'npm_SENTINELabcdefghijklmnop',
  SLACK_BOT_TOKEN: 'xoxb-SENTINEL-1234567890-abcdefghij',
};

test('managed sidecar spawn does not inherit ambient parent credentials', async (t) => {
  const restore = [];
  for (const [key, value] of Object.entries(SENTINEL_PARENT_SECRETS)) {
    restore.push([key, process.env[key]]);
    process.env[key] = value;
  }
  // Vars the sidecar genuinely reads must still arrive.
  restore.push(['JENNY_COLD_START_AUDIT', process.env.JENNY_COLD_START_AUDIT]);
  restore.push(['PYTHONPATH', process.env.PYTHONPATH]);
  process.env.JENNY_COLD_START_AUDIT = '1';
  process.env.PYTHONPATH = 'sentinel-pythonpath';
  t.after(() => {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { manager, spawnCalls } = buildManager();
  await manager.start();

  assert.equal(spawnCalls.length, 1);
  const env = spawnCalls[0].options.env;
  const serialized = JSON.stringify(env);

  for (const [key, value] of Object.entries(SENTINEL_PARENT_SECRETS)) {
    assert.equal(env[key], undefined, `${key} must not reach the sidecar`);
    assert.equal(serialized.includes(value), false, `${key}'s value must not reach the sidecar`);
  }

  // Allowlisted discovery/runtime vars survive, or the sidecar cannot start.
  assert.equal(env.JENNY_COLD_START_AUDIT, '1');
  assert.equal(env.PYTHONPATH, 'sentinel-pythonpath');
  assert.equal(env.PYTHONUNBUFFERED, '1');
  assert.equal(env.JENNY_PARENT_PID, String(process.pid));
  assert.ok(env.PATH || env.Path, 'PATH must survive or nothing can be launched');
});

test('SIDECAR_ALLOWED_ENV covers exactly the sidecar-read prefixes', () => {
  const { SIDECAR_ALLOWED_ENV } = require('../services/backend/sidecar-manager');
  const matches = (key) => SIDECAR_ALLOWED_ENV.some((pattern) => pattern.test(key));
  for (const key of [
    'JENNY_PARENT_PID',
    'JENNY_COLD_START_AUDIT',
    'JENNY_COLD_START_AUDIT_RUN_ID',
    'JENNY_IMAGE_MODEL_DIR',
    'JENNY_IMAGE_MODEL_DEBLOCK',
    'JENNY_IMAGE_MODEL_STEP_SWEEP',
    'JENNY_PYTHON_RUNTIME',
    'PYTHONPATH',
    'PYTHONHOME',
    'VIRTUAL_ENV',
    'CUDA_VISIBLE_DEVICES',
  ]) {
    assert.equal(matches(key), true, `${key} must be allowed`);
  }
  for (const key of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'HF_TOKEN', 'AWS_SESSION_TOKEN']) {
    assert.equal(matches(key), false, `${key} must not be allowed through`);
  }
});

// ---------------------------------------------------------------------------
// spawn 'error' handler (lines 299-312) + lastSpawnError throw (360-361)
// ---------------------------------------------------------------------------

test('spawn error handler records failure and start rejects with the spawn error (299-312, 360-361)', async () => {
  const child = makeFakeChild({ pid: 1234 });
  const { manager } = buildManager({ child });

  const statuses = [];
  manager.on('status', (s) => statuses.push(s));

  // Emit the spawn error on the next tick so the start() promise is already
  // awaiting _waitForSpawnSettle (grace window) when it lands.
  setImmediate(() => child.emit('error', new Error('spawn ENOENT for fake binary')));

  await assert.rejects(manager.start(), /spawn ENOENT for fake binary/);

  assert.notEqual(manager.lastSpawnError, null);
  assert.equal(manager.lastSpawnError.message, 'spawn ENOENT for fake binary');
  assert.equal(manager.process, null);
  const finalStatus = manager.getStatus();
  assert.equal(finalStatus.phase, 'failed');
  assert.equal(finalStatus.startupStage, 'spawn_error');
  assert.match(finalStatus.detail, /Backend failed to start \(spawn ENOENT for fake binary\)/);
  // The 'failed' status was actually emitted through the status event.
  assert.equal(statuses.some((s) => s.startupStage === 'spawn_error'), true);
});

test('spawn error handler coerces a non-Error value into an Error (299)', async () => {
  const child = makeFakeChild({ pid: 1234 });
  const { manager } = buildManager({ child });

  setImmediate(() => child.emit('error', 'plain-string-spawn-failure'));

  await assert.rejects(manager.start(), /plain-string-spawn-failure/);
  assert.ok(manager.lastSpawnError instanceof Error);
  assert.equal(manager.lastSpawnError.message, 'plain-string-spawn-failure');
});

// ---------------------------------------------------------------------------
// exitCode-already-set throw (lines 368-369)
// ---------------------------------------------------------------------------

test('start rejects when the child already has a non-null exitCode after settle (368-369)', async () => {
  // The child survives the spawn-settle grace (no error/exit event) but its
  // exitCode is already set — start must reject with the exitCode message.
  // We must avoid the 314 'exit' listener firing lastExitInfo (which would take
  // the 362-365 branch first), so emit no events; just set exitCode.
  const child = makeFakeChild({ pid: 5555 });
  const { manager } = buildManager({ child });

  // After spawn-settle resolves (it resolves false because no event fires and
  // the grace timer pops), set exitCode so the 367 guard sees it. We hook the
  // settle by flipping exitCode just before the grace timer would resolve.
  const realSettle = manager._waitForSpawnSettle.bind(manager);
  manager._waitForSpawnSettle = async (ms) => {
    const result = await realSettle(ms);
    child.exitCode = 13;
    return result;
  };

  await assert.rejects(manager.start(), /Backend exited with code 13\./);
  const status = manager.getStatus();
  // start threw before the 'ready' setStatus, so phase is still 'starting'.
  assert.notEqual(status.phase, 'ready');
});

// ---------------------------------------------------------------------------
// cleanupStaleState: non-finite / non-positive pid (lines 393-395)
// ---------------------------------------------------------------------------

test('cleanupStaleState deletes state and returns false for a non-positive stored pid (393-395)', async () => {
  const { manager, killCalls } = buildManager();
  manager.stateStore.write({ pid: -7, command: 'whatever' });

  const result = await manager.cleanupStaleState();

  assert.equal(result, false);
  assert.equal(manager.stateStore.read(null), null);
  // A bogus pid must NEVER trigger a kill.
  assert.deepEqual(killCalls, []);
});

test('cleanupStaleState deletes state and returns false for a NaN stored pid (393-395)', async () => {
  const { manager, killCalls } = buildManager();
  manager.stateStore.write({ pid: 'not-a-number', command: 'whatever' });

  const result = await manager.cleanupStaleState();

  assert.equal(result, false);
  assert.equal(manager.stateStore.read(null), null);
  assert.deepEqual(killCalls, []);
});

// ---------------------------------------------------------------------------
// _verifyStoredSidecarIdentity: empty stored command (423-425), cmdline throws (430-431)
// ---------------------------------------------------------------------------

test('cleanupStaleState skips kill when the stored command is empty (423-425)', async () => {
  const cmdlineCalls = [];
  const { manager, killCalls } = buildManager({
    ctor: {
      // process.kill(pid, 0) on our own pid succeeds, so liveness passes; the
      // missing command makes identity unverifiable.
      getProcessCommandLineImpl: async (pid) => {
        cmdlineCalls.push(pid);
        return 'something';
      },
    },
  });
  manager.stateStore.write({ pid: process.pid });
  const logEvents = [];
  manager.on('log', (line) => logEvents.push(line));

  const result = await manager.cleanupStaleState();

  assert.equal(result, false);
  // Empty stored command short-circuits BEFORE calling getProcessCommandLine.
  assert.deepEqual(cmdlineCalls, []);
  assert.deepEqual(killCalls, []);
  assert.equal(logEvents.some((line) => /skipped stale-state kill/i.test(line)), true);
});

test('cleanupStaleState skips kill when getProcessCommandLine throws (430-431)', async () => {
  const cmdlineCalls = [];
  const { manager, killCalls } = buildManager({
    ctor: {
      getProcessCommandLineImpl: async (pid) => {
        cmdlineCalls.push(pid);
        throw new Error('OpenProcess denied');
      },
    },
  });
  manager.stateStore.write({
    pid: process.pid,
    command: `${process.execPath} -m sidecar`,
  });

  const result = await manager.cleanupStaleState();

  assert.equal(result, false);
  // The impl WAS consulted with our pid, then its throw forced the skip.
  assert.deepEqual(cmdlineCalls, [process.pid]);
  assert.deepEqual(killCalls, []);
  assert.equal(manager.stateStore.read(null), null);
});

// ---------------------------------------------------------------------------
// _getStartupElapsedMs early return (lines 496-497)
// ---------------------------------------------------------------------------

test('_getStartupElapsedMs returns 0 before any start has begun (496-497)', () => {
  const { manager } = buildManager();
  // Fresh manager: startupStartedAt is 0 (falsy) → early return 0.
  assert.equal(manager.startupStartedAt, 0);
  assert.equal(manager._getStartupElapsedMs(), 0);
});

// ---------------------------------------------------------------------------
// _appendLog: empty text early return (504-505)
// ---------------------------------------------------------------------------

test('_appendLog ignores whitespace-only chunks without bumping the counter (504-505)', () => {
  const { manager } = buildManager();
  const logEvents = [];
  manager.on('log', (line) => logEvents.push(line));

  manager._appendLog(Buffer.from('   \n\t  '));

  assert.equal(manager.progressLogCount, 0);
  // No 'log' event for an empty chunk.
  assert.deepEqual(logEvents, []);
});

test('_appendLog reports the exact number of oversized records discarded in one chunk', () => {
  const { manager } = buildManager();
  manager.logDecoder.maxLineBytes = 8;
  const logEvents = [];
  manager.on('log', (line) => logEvents.push(JSON.parse(line)));
  manager._appendLog(Buffer.from('oversized-one\noversized-two\n'));
  assert.equal(logEvents.length, 1);
  assert.equal(logEvents[0].event, 'sidecar.diagnostics.oversized_record');
  assert.equal(logEvents[0].data.dropped_count, 2);
});

// ---------------------------------------------------------------------------
// _waitForProcessExit: !process (546-547), exitCode!=null (549-550),
// removeListener fallback (563-564), settled guard (568-569)
// ---------------------------------------------------------------------------

test('_waitForProcessExit returns true immediately when there is no process (546-547)', async () => {
  const { manager } = buildManager();
  manager.process = null;
  assert.equal(await manager._waitForProcessExit(5000), true);
});

test('_waitForProcessExit returns true immediately when exitCode is already set (549-550)', async () => {
  const { manager } = buildManager();
  manager.process = { exitCode: 0, once: () => {} };
  assert.equal(await manager._waitForProcessExit(5000), true);
});

test('_waitForProcessExit returns false when the process lacks once() (551-552)', async () => {
  const { manager } = buildManager();
  manager.process = { exitCode: null };
  assert.equal(await manager._waitForProcessExit(5000), false);
});

test('_waitForProcessExit uses removeListener when off() is unavailable (563-564, 568-569)', async () => {
  const { manager } = buildManager();
  const removeCalls = [];
  const onceCalls = [];
  // A process-like object that exposes once+removeListener but NOT off, so the
  // 562-564 fallback branch runs during cleanup.
  let exitHandler = null;
  manager.process = {
    exitCode: null,
    once: (event, handler) => {
      onceCalls.push(event);
      if (event === 'exit') {
        exitHandler = handler;
      }
    },
    removeListener: (event, handler) => {
      removeCalls.push({ event, handler });
    },
  };

  const promise = manager._waitForProcessExit(5000);
  // Fire exit twice: the second must hit the settled guard (568-569) as a no-op.
  exitHandler();
  exitHandler();

  assert.equal(await promise, true);
  assert.deepEqual(onceCalls, ['exit']);
  // Cleanup used removeListener (off was absent) exactly once.
  assert.equal(removeCalls.length, 1);
  assert.equal(removeCalls[0].event, 'exit');
});

// ---------------------------------------------------------------------------
// _waitForSpawnSettle: !process (590-591), exitCode!=null (593-594),
// no once() (596-597), removeListener fallbacks (607-608, 613-614),
// settled guard (618-619)
// ---------------------------------------------------------------------------

test('_waitForSpawnSettle returns true immediately when there is no process (590-591)', async () => {
  const { manager } = buildManager();
  manager.process = null;
  assert.equal(await manager._waitForSpawnSettle(5000), true);
});

test('_waitForSpawnSettle returns true immediately when exitCode is already set (593-594)', async () => {
  const { manager } = buildManager();
  manager.process = { exitCode: 2, once: () => {} };
  assert.equal(await manager._waitForSpawnSettle(5000), true);
});

test('_waitForSpawnSettle returns false when the process lacks once() (596-597)', async () => {
  const { manager } = buildManager();
  manager.process = { exitCode: null };
  assert.equal(await manager._waitForSpawnSettle(5000), false);
});

test('_waitForSpawnSettle uses removeListener fallbacks for both exit and stderr (607-608, 613-614, 618-619)', async () => {
  const { manager } = buildManager();
  const exitRemoveCalls = [];
  const stderrRemoveCalls = [];

  let exitHandler = null;
  const stderr = {
    on: () => {},
    // No off(): forces the 612-614 stderr removeListener fallback.
    removeListener: (event, handler) => {
      stderrRemoveCalls.push({ event, handler });
    },
  };
  manager.process = {
    exitCode: null,
    stderr,
    once: (event, handler) => {
      if (event === 'exit') {
        exitHandler = handler;
      }
    },
    // No off(): forces the 606-608 exit removeListener fallback.
    removeListener: (event, handler) => {
      exitRemoveCalls.push({ event, handler });
    },
  };

  const promise = manager._waitForSpawnSettle(5000);
  // Fire exit twice: second is the settled-guard no-op (618-619).
  exitHandler();
  exitHandler();

  // Exit wins, so the wait reports the process exited.
  assert.equal(await promise, true);
  // Cleanup removed BOTH listeners via removeListener (off absent on both).
  assert.equal(exitRemoveCalls.length, 1);
  assert.equal(exitRemoveCalls[0].event, 'exit');
  assert.equal(stderrRemoveCalls.length, 1);
  assert.equal(stderrRemoveCalls[0].event, 'data');
});

test('_waitForSpawnSettle resolves false on the timeout when neither exit nor stderr fires', async () => {
  const { manager } = buildManager();
  const stderrOnCalls = [];
  manager.process = {
    exitCode: null,
    stderr: {
      on: (event) => stderrOnCalls.push(event),
      off: () => {},
    },
    once: () => {},
    off: () => {},
  };

  // Tiny timeout so this resolves promptly with false (survived the grace).
  const exited = await manager._waitForSpawnSettle(5);
  assert.equal(exited, false);
  // stderr 'data' listener was registered (early-resolve seam wired up).
  assert.deepEqual(stderrOnCalls, ['data']);
});
