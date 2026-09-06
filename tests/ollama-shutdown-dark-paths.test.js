const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTrackedTempDir,
  cleanupTrackedResources,
} = require('./helpers/resource-cleanup');

const {
  clearOwnedOllamaState,
  forceKillAnyRemainingLocalOllamaSync,
  forceKillAnyRemainingLocalOllamaVerifiedSync,
  getOwnedStatePath,
  hasOwnedOllamaState,
  isVmmemWslAliveSync,
  listLocalOllamaProcessesSync,
  readOwnedOllamaState,
  shutdownWslSync,
  shutdownAnyLocalOllamaSync,
} = require('../services/backend/ollama-shutdown');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// A fake spawnSync/execFileSync that explodes if ever called without an
// explicit injected impl. Used as a tripwire: any helper invoked with the
// real default impl would run a destructive subprocess, so we never want
// these defaults to fire. We always pass our own recorder in tests below.
function explodingImpl(label) {
  return () => {
    throw new Error(`REAL SUBPROCESS ATTEMPTED: ${label}`);
  };
}

// ---------------------------------------------------------------------------
// getOwnedStatePath / clearOwnedOllamaState  (lines 23, 31-37, 666-669)
// ---------------------------------------------------------------------------

test('getOwnedStatePath joins userDataPath with the state filename', () => {
  const result = getOwnedStatePath('/var/data/jenny');
  assert.equal(result, path.join('/var/data/jenny', 'ollama-process.json'));
});

test('clearOwnedOllamaState unlinks the owned state file when it exists', () => {
  const dir = createTrackedTempDir('ollama-clear-');
  const statePath = path.join(dir, 'ollama-process.json');
  fs.writeFileSync(statePath, JSON.stringify({ pid: 4242, app_owned: true }));
  assert.equal(fs.existsSync(statePath), true);

  clearOwnedOllamaState(dir);

  assert.equal(
    fs.existsSync(statePath),
    false,
    'expected clearOwnedOllamaState to delete ollama-process.json',
  );
});

test('clearOwnedOllamaState swallows ENOENT when the file is already gone', () => {
  const dir = createTrackedTempDir('ollama-clear-missing-');
  const statePath = path.join(dir, 'ollama-process.json');
  assert.equal(fs.existsSync(statePath), false);

  // Must not throw even though the file does not exist (ENOENT branch).
  assert.doesNotThrow(() => clearOwnedOllamaState(dir));
  assert.equal(fs.existsSync(statePath), false);
});

test('clearOwnedOllamaState returns early (no throw) when userDataPath is empty', () => {
  // Empty userDataPath => getOwnedStatePath returns '' => early return; no fs touch.
  assert.doesNotThrow(() => clearOwnedOllamaState(''));
  assert.doesNotThrow(() => clearOwnedOllamaState(undefined));
  // Pin the concrete mechanism: getOwnedStatePath must return '' for falsy inputs,
  // which is what the early-return guard (if (!statePath) return) checks.
  // If this mapping ever breaks, clearOwnedOllamaState would attempt real fs I/O
  // on an unintended path instead of returning immediately.
  assert.equal(
    getOwnedStatePath(''),
    '',
    'empty userDataPath must yield empty state path (early-return trigger)',
  );
  assert.equal(
    getOwnedStatePath(undefined),
    '',
    'undefined userDataPath must yield empty state path (early-return trigger)',
  );
});

test('clearOwnedOllamaState rethrows non-ENOENT unlink errors (e.g. EISDIR on a directory)', () => {
  const dir = createTrackedTempDir('ollama-clear-eisdir-');
  // Create a DIRECTORY named ollama-process.json so unlinkSync fails with a
  // non-ENOENT error (EISDIR/EPERM), which must propagate.
  const stateDir = path.join(dir, 'ollama-process.json');
  fs.mkdirSync(stateDir);

  let thrown = null;
  try {
    clearOwnedOllamaState(dir);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'expected a non-ENOENT unlink error to be rethrown');
  assert.notEqual(thrown.code, 'ENOENT', 'rethrown error must not be ENOENT');
  // Pin a positive fact: the rethrow must carry the real fs syscall error,
  // not some unrelated/empty Error. A directory-in-place-of-file unlink yields
  // EISDIR (POSIX) or EPERM (Windows); both are truthy non-ENOENT codes that
  // the source's `error.code !== 'ENOENT'` branch is what lets through. If the
  // condition were inverted to `=== 'ENOENT'`, no error would propagate and
  // `thrown` would be null (caught above), so this also guards the inversion.
  assert.ok(
    thrown.code && thrown.code !== 'ENOENT',
    `expected a real non-ENOENT fs error code, got ${JSON.stringify(thrown.code)}`,
  );
  assert.ok(
    typeof thrown.syscall === 'string' && thrown.syscall.length > 0,
    'expected the rethrown error to be a genuine fs syscall error (has .syscall)',
  );
});

test('shutdownAnyLocalOllamaSync logs a WARN when clearOwnedOllamaState throws', () => {
  const logs = [];
  const dir = createTrackedTempDir('ollama-state-clear-fail-');
  // Directory in place of the state file forces clearOwnedOllamaState to throw
  // inside the finally block, which must be caught and logged (lines 666-669).
  fs.mkdirSync(path.join(dir, 'ollama-process.json'));

  shutdownAnyLocalOllamaSync({
    userDataPath: dir,
    platform: 'linux',
    // No ollama on linux path: which fails => graceful stop is a no-op.
    execFileSyncImpl: (cmd) => {
      if (cmd === 'which') {
        throw new Error('not found');
      }
      // pgrep discovery returns nothing.
      return '';
    },
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => false,
  });

  const warn = logs.find((entry) => entry.event === 'ollama.state_clear_failed');
  assert.ok(warn, 'expected ollama.state_clear_failed WARN log');
  assert.equal(warn.level, 'WARN');
  // Pin the real propagated fs error, not merely "some non-empty string". The
  // unlink of a directory throws EISDIR (POSIX) / EPERM (Windows); the WARN
  // message stringifies that error, so it must mention the state file path and
  // carry a recognizable fs-error signature. A blind `.length > 0` would pass
  // even if the finally-block swallowed the real cause and logged a placeholder.
  assert.ok(
    typeof warn.details.message === 'string',
    'expected a string error message in the WARN details',
  );
  assert.match(
    warn.details.message,
    /(EISDIR|EPERM|illegal operation on a directory|operation not permitted)/i,
    `expected the rethrown fs error to surface in the WARN message, got: ${warn.details.message}`,
  );
});

// ---------------------------------------------------------------------------
// listLocalOllamaProcessesSync — unix branch (lines 143-180, 209-210)
// ---------------------------------------------------------------------------

test('listLocalOllamaProcessesSync discovers processes via pgrep+ps on linux', () => {
  const calls = [];
  const result = listLocalOllamaProcessesSync({
    platform: 'linux',
    execFileSyncImpl: (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      if (cmd === 'pgrep') {
        return '321\n654\n';
      }
      // ps -o pid=,ppid=,comm= -p 321,654
      return '321 1 ollama\n654 321 ollama\n';
    },
  });

  assert.deepEqual(calls[0], { cmd: 'pgrep', args: ['-x', 'ollama'] });
  assert.equal(calls[1].cmd, 'ps');
  // pids are joined into the -p argument.
  assert.ok(calls[1].args.includes('321,654'), 'expected ps to be queried with joined pids');
  assert.equal(result.length, 2);
  assert.equal(result[0].pid, 321);
  assert.equal(result[0].parentPid, 1);
  assert.equal(result[0].name, 'ollama');
  assert.equal(result[1].pid, 654);
  assert.equal(result[1].parentPid, 321);
});

test('listLocalOllamaProcessesSync returns [] on linux when pgrep finds no pids (ps not queried)', () => {
  const calls = [];
  const result = listLocalOllamaProcessesSync({
    platform: 'linux',
    execFileSyncImpl: (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      if (cmd === 'pgrep') {
        return '\n  \n'; // whitespace only -> no valid pids
      }
      throw new Error('ps should not be called when there are no pids');
    },
  });

  assert.deepEqual(result, []);
  assert.equal(calls.length, 1, 'expected only the pgrep call (ps skipped)');
  assert.equal(calls[0].cmd, 'pgrep');
});

test('listLocalOllamaProcessesSync deduplicates pids returned by ps', () => {
  // ps lists the same pid twice; the seen-set must collapse it (lines 194-195).
  const result = listLocalOllamaProcessesSync({
    platform: 'linux',
    execFileSyncImpl: (cmd) => {
      if (cmd === 'pgrep') {
        return '700\n';
      }
      return '700 1 ollama\n700 1 ollama\n';
    },
  });

  assert.equal(result.length, 1, 'expected duplicate pid 700 to be collapsed to one record');
  assert.equal(result[0].pid, 700);
});

test('listLocalOllamaProcessesSync logs discovery failure and returns [] when pgrep throws', () => {
  const logs = [];
  const result = listLocalOllamaProcessesSync({
    platform: 'linux',
    execFileSyncImpl: () => {
      throw new Error('pgrep blew up');
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.deepEqual(result, []);
  const fail = logs.find((entry) => entry.event === 'ollama.process_discovery_failed');
  assert.ok(fail, 'expected ollama.process_discovery_failed log');
  assert.equal(fail.level, 'DEBUG');
  assert.ok(/pgrep blew up/.test(fail.details.message), 'expected the underlying error message');
});

test('listLocalOllamaProcessesSync drops ps rows with invalid pids', () => {
  // A ps row with pid 0 must be discarded by normalizeProcessRecord (lines 46-47).
  const result = listLocalOllamaProcessesSync({
    platform: 'linux',
    execFileSyncImpl: (cmd) => {
      if (cmd === 'pgrep') {
        return '900\n';
      }
      // First row has pid 0 (invalid) and is dropped; second is valid.
      return '0 1 ollama\n900 1 ollama\n';
    },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].pid, 900);
});

// ---------------------------------------------------------------------------
// forceKillByPidSync (via forceKill...) — invalid pid + unix branch
// (lines 222-223, 231-234, 254-261, 263-264, 500-501, 503-510)
// ---------------------------------------------------------------------------

test('forceKillAnyRemainingLocalOllamaSync uses kill -KILL on linux for each live pid', () => {
  const spawnCalls = [];
  const result = forceKillAnyRemainingLocalOllamaSync({
    platform: 'linux',
    execFileSyncImpl: (cmd) => {
      if (cmd === 'pgrep') {
        return '111\n222\n';
      }
      return '111 1 ollama\n222 111 ollama\n';
    },
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0 };
    },
    isProcessAliveImpl: () => true,
  });

  assert.deepEqual(result.discoveredPids, [111, 222]);
  assert.deepEqual(result.killedPids, [111, 222]);

  const pidKills = spawnCalls.filter((c) => c.cmd === 'kill');
  assert.equal(pidKills.length, 2);
  assert.deepEqual(pidKills[0].args, ['-KILL', '111']);
  assert.deepEqual(pidKills[1].args, ['-KILL', '222']);

  // Name-based cleanup uses pkill -x ollama on linux (lines 254-261).
  const nameKills = spawnCalls.filter((c) => c.cmd === 'pkill');
  assert.equal(nameKills.length, 1);
  assert.deepEqual(nameKills[0].args, ['-x', 'ollama']);
});

test('forceKillAllByNameSync swallows pkill errors during name cleanup (linux catch)', () => {
  // pkill throws; the kill loop and name cleanup must be best-effort and not
  // propagate (lines 263-264). Discovery finds nothing so only pkill fires.
  const spawnCalls = [];
  assert.doesNotThrow(() => {
    forceKillAnyRemainingLocalOllamaSync({
      platform: 'linux',
      execFileSyncImpl: (cmd) => {
        if (cmd === 'pgrep') {
          return '';
        }
        return '';
      },
      spawnSyncImpl: (cmd, args) => {
        spawnCalls.push({ cmd, args: [...args] });
        if (cmd === 'pkill') {
          throw new Error('pkill exploded');
        }
        return { status: 0 };
      },
      isProcessAliveImpl: () => false,
    });
  });
  assert.ok(
    spawnCalls.some((c) => c.cmd === 'pkill'),
    'expected pkill name-cleanup to have been attempted',
  );
});

test('forceKillAnyRemainingLocalOllamaSync logs WARN and continues when pid kill returns nonzero status', () => {
  // forceKillByPidSync returns {status: 1} for pid 555 -> WARN log, not pushed
  // into killedPids (lines 502-510).
  const logs = [];
  const result = forceKillAnyRemainingLocalOllamaSync({
    platform: 'linux',
    execFileSyncImpl: (cmd) => {
      if (cmd === 'pgrep') {
        return '555\n666\n';
      }
      return '555 1 ollama\n666 1 ollama\n';
    },
    spawnSyncImpl: (cmd, args) => {
      if (cmd === 'kill' && args[1] === '555') {
        return { status: 1, stderr: 'no such process' };
      }
      return { status: 0 };
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => true,
  });

  const warn = logs.find(
    (entry) => entry.event === 'ollama.force_kill_failed' && entry.details.pid === 555,
  );
  assert.ok(warn, 'expected ollama.force_kill_failed WARN for pid 555');
  assert.equal(warn.level, 'WARN');
  assert.equal(warn.details.status, 1);
  assert.equal(warn.details.stderr, 'no such process');
  // pid 555 excluded, pid 666 succeeded.
  assert.deepEqual(result.killedPids, [666]);
});

test('forceKillAnyRemainingLocalOllamaSync throws-then-logs when pid kill returns an error object', () => {
  // result.error set -> throw inside try -> caught -> WARN with message
  // (lines 500-501 then 512-518).
  const logs = [];
  const result = forceKillAnyRemainingLocalOllamaSync({
    platform: 'linux',
    execFileSyncImpl: (cmd) => {
      if (cmd === 'pgrep') {
        return '777\n';
      }
      return '777 1 ollama\n';
    },
    spawnSyncImpl: (cmd) => {
      if (cmd === 'kill') {
        return { error: new Error('spawn ENOENT kill') };
      }
      return { status: 0 };
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => true,
  });

  const warn = logs.find(
    (entry) => entry.event === 'ollama.force_kill_failed' && entry.details.pid === 777,
  );
  assert.ok(warn, 'expected force_kill_failed WARN for pid 777');
  assert.ok(/spawn ENOENT kill/.test(warn.details.message), 'expected the spawn error message');
  assert.deepEqual(result.killedPids, []);
});

test('forceKillAnyRemainingLocalOllamaSync skips killing pids that are not alive', () => {
  // isProcessAlive false -> forceKillByPidSync never invoked for that pid.
  const spawnCalls = [];
  const result = forceKillAnyRemainingLocalOllamaSync({
    platform: 'linux',
    execFileSyncImpl: (cmd) => {
      if (cmd === 'pgrep') {
        return '888\n';
      }
      return '888 1 ollama\n';
    },
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0 };
    },
    isProcessAliveImpl: () => false,
  });

  assert.deepEqual(result.discoveredPids, [888]);
  assert.deepEqual(result.killedPids, []);
  // No `kill` call for the dead pid; only the pkill name-cleanup runs.
  assert.equal(spawnCalls.filter((c) => c.cmd === 'kill').length, 0);
  assert.ok(spawnCalls.some((c) => c.cmd === 'pkill'));
});

// ---------------------------------------------------------------------------
// shutdownWslSync — non-win32 return + win32 catch (444-445, 454-455)
// ---------------------------------------------------------------------------

test('shutdownWslSync does nothing on non-win32 platforms (no spawn)', () => {
  shutdownWslSync({
    platform: 'linux',
    spawnSyncImpl: explodingImpl('shutdownWslSync wsl'),
  });
  // No assertion needed beyond "explodingImpl never fired"; add a concrete
  // record-based oracle to be non-vacuous.
  const calls = [];
  shutdownWslSync({
    platform: 'darwin',
    spawnSyncImpl: (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [], 'expected no spawn on non-win32');
});

test('shutdownWslSync swallows spawn errors on win32 (best-effort)', () => {
  const calls = [];
  const logs = [];
  assert.doesNotThrow(() => {
    shutdownWslSync({
      platform: 'win32',
      spawnSyncImpl: (cmd, args) => {
        calls.push({ cmd, args: [...args] });
        throw new Error('wsl --shutdown timed out');
      },
      logger: (level, event, details) => logs.push({ level, event, details }),
    });
  });
  // The wsl call was attempted, but the throw was caught so no success log.
  assert.deepEqual(calls, [{ cmd: 'wsl', args: ['--shutdown'] }]);
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.wsl_shutdown'),
    false,
    'expected NO success log because the spawn threw',
  );
});

// ---------------------------------------------------------------------------
// isVmmemWslAliveSync — true/false + catch (465, 467-468)
// ---------------------------------------------------------------------------

test('isVmmemWslAliveSync returns true when tasklist output mentions vmmem', () => {
  const alive = isVmmemWslAliveSync({
    spawnSyncImpl: () => ({ stdout: 'vmmemWSL  1234 Console  0  900,000 K\n' }),
  });
  assert.equal(alive, true);
});

test('isVmmemWslAliveSync returns false when tasklist output omits vmmem', () => {
  const alive = isVmmemWslAliveSync({
    spawnSyncImpl: () => ({ stdout: 'System Idle Process 0\nexplorer.exe 4242\n' }),
  });
  assert.equal(alive, false);
});

test('isVmmemWslAliveSync returns false when tasklist throws', () => {
  const alive = isVmmemWslAliveSync({
    spawnSyncImpl: () => {
      throw new Error('tasklist not found');
    },
  });
  assert.equal(alive, false);
});

// ---------------------------------------------------------------------------
// shutdownAnyLocalOllamaSync — non-win32 WSL skip path (594-595, 609-610, 631-632)
// (the verified-WSL helper is private; we drive it via the public entrypoint)
// ---------------------------------------------------------------------------

test('shutdownAnyLocalOllamaSync runs the name sweep on linux with residue but never touches WSL', () => {
  const dir = createTrackedTempDir('ollama-linux-sweep-');
  fs.writeFileSync(
    path.join(dir, 'ollama-process.json'),
    JSON.stringify({ pid: 0, app_owned: true }),
  );
  const spawnCalls = [];
  shutdownAnyLocalOllamaSync({
    userDataPath: dir,
    platform: 'linux',
    execFileSyncImpl: (cmd) => {
      assert.notEqual(cmd, 'which', 'the ollama CLI must not be resolved on the quit path');
      // pgrep discovery: nothing running.
      return '';
    },
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0 };
    },
    isProcessAliveImpl: () => false,
  });

  // F2b: no wsl/tasklist spawn on ANY platform now — the quit path dropped it.
  assert.equal(
    spawnCalls.some((c) => c.cmd === 'wsl' || c.cmd === 'tasklist'),
    false,
    'expected no WSL-related spawn',
  );
  // The owned record carries no usable pid, so the by-name sweep still runs.
  assert.ok(
    spawnCalls.some((c) => c.cmd === 'pkill'),
    'expected pkill name-cleanup to run on linux',
  );
});

test('shutdownAnyLocalOllamaSync early-returns when the owned-state file is absent', () => {
  const dir = createTrackedTempDir('ollama-no-residue-');
  const spawnCalls = [];
  const result = shutdownAnyLocalOllamaSync({
    userDataPath: dir,
    platform: 'linux',
    execFileSyncImpl: explodingImpl('discovery without residue'),
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0 };
    },
    isProcessAliveImpl: () => false,
  });

  assert.deepEqual(result, { discoveredPids: [], killedPids: [], skipped: 'no_owned_state' });
  assert.deepEqual(spawnCalls, [], 'no subprocess may run without owned residue');
});

test('hasOwnedOllamaState reports false for an empty userDataPath and true for a real record', () => {
  const dir = createTrackedTempDir('ollama-has-state-');
  assert.equal(hasOwnedOllamaState(''), false);
  assert.equal(hasOwnedOllamaState(dir), false);
  fs.writeFileSync(path.join(dir, 'ollama-process.json'), JSON.stringify({ pid: 5, app_owned: true }));
  assert.equal(hasOwnedOllamaState(dir), true);
});

test('readOwnedOllamaState returns the pid+command, and null for unreadable records', () => {
  const dir = createTrackedTempDir('ollama-read-state-');
  assert.equal(readOwnedOllamaState(''), null);
  assert.equal(readOwnedOllamaState(dir), null, 'missing file yields null');
  const statePath = path.join(dir, 'ollama-process.json');
  fs.writeFileSync(statePath, 'not json');
  assert.equal(readOwnedOllamaState(dir), null, 'unparseable file yields null');
  fs.writeFileSync(statePath, JSON.stringify({ pid: 4242, command: 'C:\\O\\ollama.exe', app_owned: true }));
  assert.deepEqual(readOwnedOllamaState(dir), { pid: 4242, command: 'C:\\O\\ollama.exe' });
  fs.writeFileSync(statePath, JSON.stringify({ pid: -1 }));
  assert.deepEqual(readOwnedOllamaState(dir), { pid: 0, command: '' });
});

// ---------------------------------------------------------------------------
// forceKillByPidSync invalid-pid guard, reached via a 0/negative discovered pid
// (lines 222-223). We drive it indirectly: a ps row with a valid pid that the
// verified helper retries, plus a direct check that pid<=0 short-circuits.
// Easiest deterministic route: use the verified loop with a record whose pid is
// valid, then assert no negative-pid kill ever spawns — but the cleanest direct
// coverage is the unit below using forceKillAnyRemaining with a pid that is
// alive yet 0 is impossible (normalize drops it). So we cover 222-223 through
// forceKillByPidSync being called with pid 0 is unreachable from discovery.
// Instead we verify the verified-retry survivor-WARN path here.
// ---------------------------------------------------------------------------

test('forceKillAnyRemainingLocalOllamaVerifiedSync logs survivor WARN when a killed pid stays alive', () => {
  const logs = [];
  let discovery = 0;
  let aliveChecks = 0;
  forceKillAnyRemainingLocalOllamaVerifiedSync({
    platform: 'linux',
    execFileSyncImpl: (cmd) => {
      if (cmd === 'pgrep') {
        discovery += 1;
        // Always discover one pid so the loop keeps retrying.
        return '1313\n';
      }
      return '1313 1 ollama\n';
    },
    spawnSyncImpl: () => ({ status: 0 }),
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => {
      aliveChecks += 1;
      // Always alive => the killed pid "survives" => survivor WARN path.
      return true;
    },
    maxRetries: 1,
    retryDelayMs: 0,
  });

  assert.ok(discovery >= 2, `expected >= 2 discovery passes, got ${discovery}`);
  const survived = logs.find((entry) => entry.event === 'ollama.processes_survived_kill');
  assert.ok(survived, 'expected ollama.processes_survived_kill WARN');
  assert.deepEqual(survived.details.survivingPids, [1313]);
});
