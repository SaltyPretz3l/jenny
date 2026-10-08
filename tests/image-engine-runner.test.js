'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { parseSdCliProgressLine, classifyPhaseLine, createLineSplitter, runImageGeneration } = require('../services/image-engine-runner');
const pidfile = require('../services/image-engine-pidfile');
const processTools = require('../services/backend/process-tree-tools');
const { isProcessAlive } = require('../services/backend/process-utils');

const fakeCli = path.join(__dirname, 'fixtures', 'sdcpp', 'fake-sd-cli.js');
const fakeSpawner = path.join(__dirname, 'fixtures', 'sdcpp', 'fake-child-spawner.js');
const children = new Set();
function spawnTracked(exe, args, opts) {
  const child = spawn(exe, args, opts);
  children.add(child);
  return child;
}
test.afterEach(async () => {
  for (const child of children) {
    if (isProcessAlive(child.pid)) child.kill('SIGKILL');
    await processTools.confirmAllGone([child.pid], { timeoutMs: 1000 });
  }
  children.clear();
  await cleanupTrackedResources();
});

function setup(extra = []) {
  const userDataPath = createTrackedTempDir('jenny-image-run-');
  const scratchDir = path.join(userDataPath, 'scratch');
  fs.mkdirSync(scratchDir);
  const outputPath = path.join(scratchDir, 'image.png');
  return { exePath: process.execPath, argv: [fakeCli, '-o', outputPath, '--width', '2', '--height', '3', ...extra],
    scratchDir, outputPath, opId: 'render_123', userDataPath, deadlineMs: 10000,
    expectedWidth: 2, expectedHeight: 3,
    spawnImpl: spawnTracked,
    processTools: { ...processTools, enumerateDescendants: async () => ({ ok: true, pids: [] }),
      listProcessRows: async () => ({ ok: true, rows: [] }) } };
}

function fakeChild(pid = 42001) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function fakeOptions(options, child) {
  return { ...options, spawnImpl: () => child,
    processTools: { enumerateDescendants: async () => ({ ok: true, pids: [] }),
      listProcessRows: async () => ({ ok: true, rows: [] }),
      selectRootSurvivors: processTools.selectRootSurvivors, terminatePids: async () => {},
      confirmAllGone: async () => ({ confirmed: true, survivors: [] }),
      killTreeWithProof: async () => ({ confirmed: true, pids: [child.pid], survivors: [] }) } };
}

// The sandbox denies WMI. Fixture-owned PIDs provide a bounded process table
// without creation times (the ps shape); termination and liveness checks still
// operate on the real spawned processes.
function fixtureTreeTools(childPidPath, onEnumerated = () => {}) {
  const fixturePids = () => (childPidPath && fs.existsSync(childPidPath)
    ? [Number(fs.readFileSync(childPidPath, 'utf8'))] : []);
  const enumerateDescendants = async () => {
    const pids = fixturePids();
    assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
    onEnumerated(pids);
    return { ok: true, pids };
  };
  const listProcessRows = async () => ({ ok: true,
    rows: fixturePids().filter(isProcessAlive).map((pid) => ({ pid, ppid: 1, createdMs: null })) });
  return { ...processTools, enumerateDescendants, listProcessRows,
    killTreeWithProof: (pid) => processTools.killTreeWithProof(pid, {
      enumerateImpl: enumerateDescendants,
      killImpl: async (target) => {
        const known = await enumerateDescendants();
        const targets = target === pid && process.platform === 'win32' ? [target, ...known.pids] : [target];
        for (const owned of targets) if (isProcessAlive(owned)) process.kill(owned, 'SIGKILL');
      },
    }) };
}

test('documented progress formats convert reciprocal rates and ignore unknown lines', () => {
  assert.deepEqual(parseSdCliProgressLine('  |==================>    | 8/20 - 2.35s/it'), {
    step: 8, steps: 20, secondsPerIt: 2.35,
  });
  assert.deepEqual(parseSdCliProgressLine('|=> | 8/20 - 1.4it/s'), {
    step: 8, steps: 20, secondsPerIt: 1 / 1.4,
  });
  for (const line of ['unknown', '8/20 - 2.35s/it', '|x| 1/0 - 2s/it', '|x| 21/20 - 2s/it', '  |####>  | 47/128 - 275.53MB/s\x1b[K']) {
    assert.equal(parseSdCliProgressLine(line), null);
  }
});

test('the line splitter ends a line at an erase-line escape, so a glued log line is separate (also across chunks)', () => {
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line), () => {});
  const glued = Buffer.from('\r  |==>  | 1/20 - 6.47s/it\x1b[K[INFO   ] ggml_graph_cut.cpp:1034 - plan done\n');
  splitter.push(glued.subarray(0, 27));
  splitter.push(glued.subarray(27, 28));
  splitter.push(glued.subarray(28));
  assert.deepEqual(lines, ['  |==>  | 1/20 - 6.47s/it\x1b[K', '[INFO   ] ggml_graph_cut.cpp:1034 - plan done']);
  assert.deepEqual(parseSdCliProgressLine(lines[0]), { step: 1, steps: 20, secondsPerIt: 6.47 });
  lines.length = 0;
  splitter.push(Buffer.from('plain K letters [K stay\n'));
  assert.deepEqual(lines, ['plain K letters [K stay']);
});

test('the Step 0 fixture of the pinned build parses: 20 steps behind erase-line escapes and the three phases', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures/sdcpp/progress-master-929-3f8527a.txt'));
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line), () => {});
  // Feed the raw bytes in small chunks so erase-line escapes straddle chunk edges.
  for (let offset = 0; offset < raw.length; offset += 7) splitter.push(raw.subarray(offset, offset + 7));
  splitter.flush();
  const steps = lines.map(parseSdCliProgressLine).filter(Boolean);
  assert.equal(steps.length, 20);
  assert.deepEqual(steps.at(-1), { step: 20, steps: 20, secondsPerIt: steps.at(-1).secondsPerIt });
  assert.ok(steps.every((s, i) => s.step === i + 1 && s.steps === 20 && s.secondsPerIt > 0));
  const phases = lines.map(classifyPhaseLine).filter(Boolean);
  assert.deepEqual(phases.map((p) => p.phase), ['load', 'load', 'load', 'sample', 'sampled']);
  assert.equal(phases.at(-1).seconds, 52.01);
  assert.equal(classifyPhaseLine('[INFO   ] image.cpp:866  - generating image: 1/1 - seed 42\x1b[K').phase, 'sample');
  assert.equal(classifyPhaseLine('[VERBOSE] conditioner.hpp:3140 - computing condition graph completed, taking 286 ms'), null);
});

test('happy real invocation validates PNG, writes/clears pidfile, and preserves shell characters verbatim', async () => {
  const options = setup();
  const echoPath = path.join(options.scratchDir, 'argv.json');
  const prompt = '" & | < > ^ %';
  options.argv.push('--echo', echoPath, '--prompt', prompt);
  const progress = [];
  let recorded;
  const result = await runImageGeneration({ ...options, onProgress: (event) => progress.push(event),
    pidfile: { ...pidfile, writeRenderRecord: (file, record, deps) => {
      pidfile.writeRenderRecord(file, record, deps);
      recorded = pidfile.readRenderRecord(file);
    } },
    spawnImpl: (exe, args, opts) => {
      assert.equal(opts.shell, false);
      assert.equal(opts.detached, false);
      assert.equal(opts.windowsHide, true);
      assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(opts.cwd, path.dirname(exe));
      return spawnTracked(exe, args, opts);
    },
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual({ width: result.png.width, height: result.png.height }, { width: 2, height: 3 });
  assert.ok(result.png.bytes > 45);
  assert.equal(result.seconds.sample, 0.25);
  assert.ok(result.seconds.load >= 0);
  assert.ok(result.seconds.total >= 0);
  assert.equal(progress.at(-1).fraction, 1);
  assert.equal(recorded.output, options.outputPath);
  assert.equal(recorded.opId, options.opId);
  assert.equal(pidfile.readRenderRecord(pidfile.getImageEnginePidPath(options.userDataPath)), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(echoPath, 'utf8')), options.argv.slice(1));
});

test('unknown lines are indeterminate and progress is throttled with a fake clock', async () => {
  const options = setup();
  const child = fakeChild();
  const events = [];
  let time = 0;
  const pending = runImageGeneration({ ...fakeOptions(options, child), now: () => time,
    onProgress: (event) => events.push(event) });
  child.stdout.emit('data', 'unknown\n');
  assert.equal(events.length, 0);
  child.stdout.emit('data', '[INFO ] loading model from <path>\n');
  time = 100;
  child.stdout.emit('data', '[INFO ] generating image\n');
  assert.equal(events.length, 0);
  time = 200;
  child.stdout.emit('data', '|=>| 1/20 - 1s/it\r');
  time = 300;
  child.stdout.emit('data', '|=>| 2/20 - 1s/it\n');
  time = 450;
  child.stderr.emit('data', '|=>| 3/20 - 1s/it\r\n');
  assert.deepEqual(events.map((event) => event.step), [1, 3]);
  child.stdout.emit('data', '[INFO ] sampling completed, taking 0.25s\n');
  assert.equal(events.length, 2);
  child.emit('exit', 0, null);
  const result = await pending;
  assert.equal(result.seconds.load, 0.1);
  assert.equal(result.seconds.sample, 0.25);
  assert.equal(events.at(-1).fraction, 1);
});

test('invalid inputs and redirected output fail without spawning', async () => {
  const options = setup();
  for (const change of [
    { argv: ['-o', path.join(options.userDataPath, 'outside.png')] },
    { outputPath: path.join(options.userDataPath, 'outside.png') },
    { argv: ['-o', options.outputPath, '--output', path.join(options.userDataPath, 'outside.png')] },
    { argv: ['-o', options.outputPath, '\0'] }, { argv: ['x'.repeat(4097)] },
    { exePath: 'relative.exe' }, { scratchDir: 'relative' }, { opId: 'bad' }, { opId: undefined }, { deadlineMs: 0 },
  ]) {
    const result = await runImageGeneration({ ...options, ...change,
      spawnImpl: () => { assert.fail('must not spawn'); } });
    assert.equal(result.reason, 'image_invalid_params');
    assert.equal(result.status, 'failed');
  }
});

test('Windows output containment accepts equivalent directory casing', { skip: process.platform !== 'win32' }, async () => {
  const options = setup();
  options.outputPath = path.join(options.scratchDir.toUpperCase(), 'image.png');
  options.argv[options.argv.indexOf('-o') + 1] = options.outputPath;
  assert.equal((await runImageGeneration(options)).status, 'ok');
});

test('real output failures: exit code, missing, wrong size, malformed, and oversized PNG', async () => {
  for (const [args, reason, exitCode] of [
    [['--exit-code', '7'], 'image_engine_failed', 7],
    [['--mode', 'missing'], 'image_output_missing', 0],
    [['--width', '4'], 'image_output_mismatch', 0],
    [['--mode', 'invalid'], 'image_output_invalid', 0],
    [['--mode', 'oversize'], 'image_output_invalid', 0],
  ]) {
    const options = setup(args);
    const result = await runImageGeneration(options);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, reason);
    assert.equal(result.exitCode, exitCode);
  }
});

test('symlink output is rejected using injected filesystem metadata', async () => {
  const options = setup();
  const result = await runImageGeneration({ ...options,
    fsImpl: { ...fs, lstatSync: (file) => file === options.outputPath
      ? { isSymbolicLink: () => true, isFile: () => true } : fs.lstatSync(file) } });
  assert.equal(result.reason, 'image_output_invalid');
});

test('output descriptor identity must match the path checked before reading', async () => {
  const options = setup();
  const result = await runImageGeneration({ ...options, fsImpl: { ...fs,
    fstatSync: (fd) => {
      const snapshot = Object.create(fs.fstatSync(fd));
      snapshot.ino = snapshot.ino === 1 ? 2 : 1;
      return snapshot;
    },
  } });
  assert.equal(result.reason, 'image_output_invalid');
});

test('spawn errors settle without rejection', async () => {
  const options = setup();
  assert.equal((await runImageGeneration({ ...options, spawnImpl: () => { throw new Error('spawn'); } })).reason,
    'image_engine_spawn_failed');
  const child = fakeChild(undefined);
  child.pid = undefined;
  const pending = runImageGeneration({ ...options, spawnImpl: () => child });
  child.emit('error', new Error('spawn'));
  assert.equal((await pending).reason, 'image_engine_spawn_failed');
});

test('pidfile write failure kills child and returns launch_unrecorded; unproven kill overrides it', async () => {
  for (const confirmed of [true, false]) {
    const options = setup();
    const child = fakeChild();
    let killed = 0;
    const result = await runImageGeneration({ ...fakeOptions(options, child),
      pidfile: { ...pidfile, writeRenderRecord: () => { throw new Error('disk'); } },
      processTools: { killTreeWithProof: async (pid) => { killed = pid; return { confirmed }; } },
    });
    assert.equal(killed, child.pid);
    assert.equal(result.status, confirmed ? 'launch_unrecorded' : 'unconfirmed');
  }
});

test('real child is dead after a pidfile write failure', async () => {
  const options = setup(['--mode', 'hang']);
  let child;
  const result = await runImageGeneration({ ...options, processTools: fixtureTreeTools(),
    spawnImpl: (exe, args, opts) => { child = spawnTracked(exe, args, opts); return child; },
    pidfile: { writeRenderRecord: () => { throw new Error('disk'); } },
  });
  assert.equal(result.status, 'launch_unrecorded');
  assert.equal(isProcessAlive(child.pid), false);
});

test('failed record acquisition preserves the live record even with the same opId', async () => {
  const options = setup(['--mode', 'hang']);
  const pidPath = pidfile.getImageEnginePidPath(options.userDataPath);
  const existing = { version: 1, pid: process.pid, exePath: process.execPath,
    opId: options.opId, output: options.outputPath, startedAt: Date.now() };
  pidfile.writeRenderRecord(pidPath, existing);
  const result = await runImageGeneration({ ...options, processTools: fixtureTreeTools() });
  assert.equal(result.status, 'launch_unrecorded');
  assert.deepEqual(pidfile.readRenderRecord(pidPath), existing);
});

test('pre-aborted invocation spawns nothing and callback exceptions do not reject', async () => {
  const options = setup();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runImageGeneration({ ...options, abortSignal: controller.signal,
    spawnImpl: () => { assert.fail('pre-abort must not spawn'); } })).status, 'cancelled');
  const result = await runImageGeneration({ ...options,
    onProgress: () => { throw new Error('consumer'); }, log: () => { throw new Error('logger'); } });
  assert.equal(result.status, 'ok');
});

test('real abort and deadline kill and prove all enumerated pids; cancelled PNG removed', { timeout: 12000 }, async () => {
  for (const trigger of ['abort', 'deadline']) {
    const options = setup();
    const childPidPath = path.join(options.scratchDir, 'grandchild.pid');
    options.argv = [fakeSpawner, '-o', options.outputPath, '--pid-file', childPidPath];
    const ownedTools = fixtureTreeTools(childPidPath);
    const controller = new AbortController();
    let proof;
    let grandchildGone = false;
    const timer = trigger === 'abort' ? setTimeout(() => controller.abort(), 900) : null;
    try {
      const result = await runImageGeneration({ ...options, abortSignal: controller.signal,
        deadlineMs: trigger === 'deadline' ? 900 : 10000,
        processTools: { ...ownedTools, killTreeWithProof: async (pid) => {
          proof = await ownedTools.killTreeWithProof(pid); return proof;
        } },
      });
      assert.equal(result.status, trigger === 'abort' ? 'cancelled' : 'timeout');
      assert.equal(proof.confirmed, true);
      assert.equal(proof.pids.length, 2);
      assert.ok(proof.pids.every((pid) => !isProcessAlive(pid)));
      grandchildGone = true;
      assert.equal(fs.existsSync(options.outputPath), false);
      assert.equal(pidfile.readRenderRecord(pidfile.getImageEnginePidPath(options.userDataPath)), null);
    } finally {
      clearTimeout(timer);
      // A pid proven gone may already belong to a sibling test's process.
      if (!grandchildGone && fs.existsSync(childPidPath)) {
        const pid = Number(fs.readFileSync(childPidPath, 'utf8'));
        if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  }
});

test('unconfirmed cancellation retains pidfile and late exit cannot settle twice', async () => {
  const options = setup();
  const child = fakeChild();
  const controller = new AbortController();
  const pending = runImageGeneration({ ...fakeOptions(options, child), abortSignal: controller.signal,
    processTools: { ...fakeOptions(options, child).processTools,
      killTreeWithProof: async () => ({ confirmed: false }) } });
  controller.abort();
  const result = await pending;
  child.emit('exit', 0, null);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.reason, 'image_engine_cleanup_pending');
  assert.ok(pidfile.readRenderRecord(pidfile.getImageEnginePidPath(options.userDataPath)));
});

test('real surviving grandchild is killed with proof after a normal exit and the pidfile is cleared', { timeout: 8000 }, async () => {
  const options = setup();
  const childPidPath = path.join(options.scratchDir, 'grandchild.pid');
  options.argv = [fakeSpawner, '-o', options.outputPath, '--pid-file', childPidPath];
  let grandchildPid;
  let grandchildGone = false;
  let enumerated = [];
  try {
    const result = await runImageGeneration({ ...options, processTools: {
      ...fixtureTreeTools(childPidPath, (pids) => { enumerated = pids; }),
      confirmAllGone: (pids) => processTools.confirmAllGone(pids, { timeoutMs: 300 }) },
      spawnImpl: spawnTracked,
    });
    grandchildPid = Number(fs.readFileSync(childPidPath, 'utf8'));
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, JSON.stringify(result));
    assert.notEqual(result.status, 'unconfirmed', JSON.stringify(result));
    assert.ok(enumerated.includes(grandchildPid));
    assert.equal(isProcessAlive(grandchildPid), false, 'the late worker does not outlive the render');
    grandchildGone = true;
    assert.equal(pidfile.readRenderRecord(pidfile.getImageEnginePidPath(options.userDataPath)), null);
  } finally {
    if (!grandchildPid && fs.existsSync(childPidPath)) grandchildPid = Number(fs.readFileSync(childPidPath, 'utf8'));
    // A pid proven gone may already belong to a sibling test's process.
    if (grandchildPid && !grandchildGone && isProcessAlive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
    if (grandchildPid && !grandchildGone) await processTools.confirmAllGone([grandchildPid], { timeoutMs: 1000 });
  }
});

// Windows frees a pid once its exit is observed and hands it out again within
// seconds under load; the dead root's pid then names an unrelated process whose
// children list it as their parent.
test('after a normal exit, children of a process that reused the root pid are never killed', async () => {
  const options = setup();
  const child = fakeChild();
  const killed = [];
  let exitWallMs = 0;
  const fakeCim = (_exe, _args, _opts, cb) => cb(null, JSON.stringify([
    { ProcessId: child.pid, ParentProcessId: 7, CreatedMs: exitWallMs + 5000 },
    { ProcessId: 42002, ParentProcessId: child.pid, CreatedMs: exitWallMs + 5001 },
    { ProcessId: 42003, ParentProcessId: child.pid, CreatedMs: exitWallMs - 20 },
    { ProcessId: 42004, ParentProcessId: 42003, CreatedMs: exitWallMs + 100 },
  ]));
  const pending = runImageGeneration({ ...fakeOptions(options, child), processTools: {
    enumerateDescendants: (pid) => processTools.enumerateDescendants(pid, { platform: 'win32', execFileImpl: fakeCim }),
    listProcessRows: () => processTools.listProcessRows({ platform: 'win32', execFileImpl: fakeCim }),
    killTreeWithProof: async (pid) => { killed.push(pid); return { confirmed: true, pids: [pid], survivors: [] }; },
    terminatePids: async (pids) => { killed.push(...pids); },
    confirmAllGone: async () => ({ confirmed: true, survivors: [] }),
  } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  exitWallMs = Date.now();
  child.emit('exit', 0, null);
  const result = await pending;
  assert.notEqual(result.reason, 'image_engine_cleanup_pending', JSON.stringify(result));
  assert.equal(killed.includes(42002), false, 'the reuser\'s child is not ours');
  assert.equal(killed.includes(child.pid), false, 'the reused root pid is not ours');
  assert.deepEqual(killed.sort(), [42003, 42004], 'our orphan and its worker are reaped');
});

test('stderr tail is bounded, paths and controls removed; oversized split lines flag once', async () => {
  const options = setup();
  const child = fakeChild();
  const logs = [];
  const pending = runImageGeneration({ ...fakeOptions(options, child),
    log: (...args) => logs.push(args) });
  child.stderr.emit('data', Buffer.from('x'.repeat(5000)));
  child.stderr.emit('data', Buffer.from('y'.repeat(5000) + '\r'));
  for (let i = 0; i < 30; i += 1) child.stderr.emit('data', `\x01C:\\private\\file /private/file [/private/file] ${i} ${'z'.repeat(500)}\n`);
  child.emit('exit', 7, null);
  const result = await pending;
  assert.ok(result.stderrTail.length <= 20);
  assert.ok(Buffer.byteLength(result.stderrTail.join('\n')) <= 4096);
  assert.ok(result.stderrTail.every((line) => !line.includes('private') && !line.includes('\x01') && line.length <= 512));
  assert.equal(logs.filter((entry) => entry[1] === 'image_engine.line_truncated').length, 1);
});

test('stdio drains after exit and an unterminated final line is retained', async () => {
  const options = setup();
  const child = fakeChild();
  child.stderr.readable = true;
  const pending = runImageGeneration({ ...fakeOptions(options, child), sleep: async () => {} });
  child.emit('exit', 7, null);
  setTimeout(() => {
    child.stderr.emit('data', 'last diagnostic');
    child.emit('close', 7, null);
  }, 20);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.stderrTail, ['last diagnostic']);
});
