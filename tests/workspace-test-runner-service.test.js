'use strict';
// SPEC: Workspace Test Runner P0 — the orchestrator (the only module IPC calls).
//   S1 (Behavior/Architecture) — run() returns the structured run record.
//   S2 (Behavior) — an 'error' run record (process never started) is surfaced + recorded.
//   S9 (Architecture) — listConfigs/run carry a CMP error envelope (ROOT_MISSING / CONFIG_NOT_FOUND).
//   S10 (Reliability) — single-run lock: a second concurrent run is rejected ALREADY_RUNNING.
//   S5b (Reliability) — the service reconciles orphaned 'running' records on construction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWorkspaceTestRunnerService } = require('../services/workspace-test-runner-service');
const {
  MAX_CONFIG_ID_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_COMMAND_LENGTH,
  MAX_CWD_LENGTH,
  MAX_ENV_ENTRIES,
  MAX_ENV_KEY_LENGTH,
  MAX_ENV_VALUE_LENGTH,
  MAX_SUMMARY_REGEX_LENGTH,
} = require('../services/workspace-test-runner-config');
const { createTestRunnerHistory } = require('../services/workspace-test-runner-history');
const { parseSummary } = require('../services/workspace-test-runner-summary');
const { WORKSPACE_TEST_RUNNER_ERROR_CODES } = require('../services/backend/error-codes');

function makeStore(initial) {
  let value = initial;
  return { read: (def) => (value === undefined ? def : value), write: (v) => { value = v; }, peek: () => value };
}

function passingRunner() {
  const calls = [];
  return {
    calls,
    runTestCommand: (opts) => {
      calls.push(opts);
      return Promise.resolve({
        status: 'passed', exitCode: 0, durationMs: 1500,
        startedAt: 'S', finishedAt: 'F', signal: null, stdoutTail: '', stderrTail: '',
      });
    },
  };
}

function makeService(overrides = {}) {
  return createWorkspaceTestRunnerService({
    runner: overrides.runner || passingRunner(),
    history: overrides.history || createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) }),
    rootProvider: overrides.rootProvider || (() => '/root'),
    configProvider: overrides.configProvider || (() => [{ id: 'unit', label: 'Unit', command: 'npm test', cwd: 'api' }]),
    now: overrides.now || (() => new Date(1000)),
    makeRunId: overrides.makeRunId || (() => 'run-1'),
    defaultTimeoutMs: overrides.defaultTimeoutMs || 600000,
    // S13: optional live-state callback (undefined when a test does not care).
    onStateChange: overrides.onStateChange,
    // S18: optional config writer (undefined when a test does not exercise saveConfigs).
    configWriter: overrides.configWriter,
    summaryParser: overrides.summaryParser,
  });
}

test('s9: listConfigs returns normalized configs when a root is set', () => {
  // RED-BECAUSE: listConfigs throws NotImplementedError (no body yet).
  const result = makeService().listConfigs();
  assert.equal(result.error, undefined);
  assert.equal(result.configs.length, 1);
  assert.equal(result.configs[0].command, 'npm test');
  assert.equal(result.configs[0].label, 'Unit');
});

test('s9: listConfigs surfaces ROOT_MISSING when no workspace root is set', () => {
  // RED-BECAUSE: listConfigs throws (no body yet).
  const result = makeService({ rootProvider: () => '' }).listConfigs();
  assert.equal(result.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.ROOT_MISSING);
  assert.equal(result.configs, undefined);
});

test('s1: run() returns the structured run record composed from the runner result', async () => {
  // RED-BECAUSE: run() rejects with NotImplementedError (no body yet).
  const runner = passingRunner();
  const result = await makeService({ runner }).run({ configId: 'unit' });
  assert.deepEqual(result, {
    configId: 'unit',
    runId: 'run-1',
    status: 'passed',
    exitCode: 0,
    durationMs: 1500,
    startedAt: 'S',
    finishedAt: 'F',
  });
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].command, 'npm test', 'the config command is wired into the runner');
  // S16: the runner now receives the VALIDATED ABSOLUTE cwd (root-resolved), not
  // the raw relative config value.
  assert.equal(runner.calls[0].cwd, path.resolve('/root', 'api'), 'the validated absolute cwd reaches the runner');
  // S11: a config without its own timeout inherits the default-timeout floor, so
  // a hung run can never hold the single-run lock forever.
  assert.equal(runner.calls[0].timeoutMs, 600000, 'the default-timeout floor is wired through');
});

test('s1: a completed run is appended to history as a terminal record', async () => {
  // RED-BECAUSE: run() rejects (no body yet).
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  await makeService({ history }).run({ configId: 'unit' });
  const records = history.getHistory('unit');
  assert.equal(records.length, 1);
  // Full record: the running placeholder is patched to the terminal record with
  // the runner's authoritative timing — not left as a phantom 'running'.
  assert.deepEqual(records[0], {
    runId: 'run-1', configId: 'unit', status: 'passed',
    startedAt: 'S', exitCode: 0, durationMs: 1500, finishedAt: 'F',
  });
});

test('run() withholds the output tails unless includeOutput is set', async () => {
  // The renderer's own run path reads the record wholesale on every panel render,
  // so the bounded tails are opt-in. Only the model-facing `verify` tool asks for
  // them, because only it needs the actual failing lines.
  const runner = {
    calls: [],
    runTestCommand: (opts) => {
      runner.calls.push(opts);
      return Promise.resolve({
        status: 'failed', exitCode: 1, durationMs: 40,
        startedAt: 'S', finishedAt: 'F', signal: null,
        stdoutTail: 'FAIL some.test.js', stderrTail: 'stack line',
      });
    },
  };

  const lean = await makeService({ runner }).run({ configId: 'unit' });
  assert.equal('stdoutTail' in lean, false, 'the default record carries no output');
  assert.equal('stderrTail' in lean, false, 'the default record carries no output');

  const withOutput = await makeService({ runner }).run({ configId: 'unit', includeOutput: true });
  assert.equal(withOutput.stdoutTail, 'FAIL some.test.js');
  assert.equal(withOutput.stderrTail, 'stack line');
  // Opting in changes nothing else about the record.
  assert.equal(withOutput.status, 'failed');
  assert.equal(withOutput.exitCode, 1);
});

test('s9: run() on an unknown config id returns CONFIG_NOT_FOUND (no spawn)', async () => {
  // RED-BECAUSE: run() rejects (no body yet).
  const runner = passingRunner();
  const result = await makeService({ runner }).run({ configId: 'ghost' });
  assert.equal(result.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_NOT_FOUND);
  assert.equal(runner.calls.length, 0, 'an unknown config never spawns');
});

test('s9: run() with no workspace root returns ROOT_MISSING', async () => {
  // RED-BECAUSE: run() rejects (no body yet).
  const result = await makeService({ rootProvider: () => '' }).run({ configId: 'unit' });
  assert.equal(result.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.ROOT_MISSING);
});

test('s2: an error run record (process never started) is surfaced and recorded', async () => {
  // RED-BECAUSE: run() rejects (no body yet).
  const runner = {
    calls: [],
    runTestCommand: (opts) => {
      runner.calls.push(opts);
      return Promise.resolve({
        status: 'error', exitCode: null, durationMs: 0,
        startedAt: 'S', finishedAt: 'F', errorCode: WORKSPACE_TEST_RUNNER_ERROR_CODES.SPAWN_FAILED,
        stdoutTail: '', stderrTail: '',
      });
    },
  };
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  const result = await makeService({ runner, history }).run({ configId: 'unit' });
  assert.equal(result.status, 'error');
  // S2: the CMP-TESTRUNNER-* code MUST be surfaced (on the result AND in history)
  // so trend math can separate "couldn't run it" from "ran and failed".
  assert.equal(result.errorCode, WORKSPACE_TEST_RUNNER_ERROR_CODES.SPAWN_FAILED, 'errorCode is surfaced on the result');
  const record = history.getHistory('unit')[0];
  assert.equal(record.status, 'error', 'the error run is recorded for trend math');
  assert.equal(record.errorCode, WORKSPACE_TEST_RUNNER_ERROR_CODES.SPAWN_FAILED, 'errorCode is persisted to history');
});

test('s10: a second concurrent run is rejected with ALREADY_RUNNING and never spawns twice', async () => {
  // RED-BECAUSE: run() rejects (no lock yet).
  let resolveRunner;
  let calls = 0;
  const runner = {
    runTestCommand: () => {
      calls += 1;
      // Only the FIRST run is held open (to keep the lock asserted); later runs
      // resolve immediately so the lock-release path can be exercised.
      if (calls === 1) {
        return new Promise((resolve) => { resolveRunner = resolve; });
      }
      return Promise.resolve({ status: 'passed', exitCode: 0, durationMs: 1, startedAt: 'S', finishedAt: 'F' });
    },
  };
  const service = makeService({ runner });
  const first = service.run({ configId: 'unit' });          // takes the lock, awaits the runner
  const second = await service.run({ configId: 'unit' });    // lock held
  assert.equal(second.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING);
  assert.equal(calls, 1, 'the second run never spawns');

  resolveRunner({ status: 'passed', exitCode: 0, durationMs: 1, startedAt: 'S', finishedAt: 'F' });
  await first;
  // The lock releases so a later run proceeds.
  const third = await service.run({ configId: 'unit' });
  assert.equal(third.status, 'passed');
  assert.equal(calls, 2);
});

test('wide-016: dispose permanently refuses later runs and remains idempotent', async () => {
  const runner = passingRunner();
  const service = makeService({ runner });

  assert.deepEqual(await service.dispose(), {
    disposed: true,
    terminationConfirmed: true,
  });
  const refused = await service.run({ configId: 'unit' });
  assert.equal(refused.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING);
  assert.match(refused.error.message, /shutting down|disposed/i);
  assert.equal(runner.calls.length, 0, 'a disposed service can never reacquire process ownership');
  assert.deepEqual(await service.dispose(), {
    disposed: true,
    terminationConfirmed: true,
  });
});

test('wide-016: abortAndWait holds ownership until the runner confirms settlement', async () => {
  let finishRun;
  let seenSignal = null;
  const runner = {
    runTestCommand: ({ abortSignal }) => {
      seenSignal = abortSignal;
      return new Promise((resolve) => { finishRun = resolve; });
    },
  };
  const service = makeService({ runner });
  const runPromise = service.run({ configId: 'unit' });
  const abortPromise = service.abortAndWait();
  let abortSettled = false;
  abortPromise.then(() => { abortSettled = true; });
  await Promise.resolve();
  assert.equal(seenSignal.aborted, true, 'abort is requested immediately');
  assert.equal(abortSettled, false, 'abortAndWait remains pending until the owned tree settles');
  assert.equal(service.getState().activeRun, 'run-1', 'the single-run lock stays held');

  finishRun({
    status: 'aborted', exitCode: null, durationMs: 1,
    startedAt: 'S', finishedAt: 'F', stdoutTail: '', stderrTail: '',
    terminationConfirmed: true,
  });
  await runPromise;
  const result = await abortPromise;
  assert.equal(result.aborted, true);
  assert.equal(result.terminationConfirmed, true);
  assert.equal(service.getState().activeRun, null);
});

test('wide-016: dispose is idempotent and awaits an active run', async () => {
  let finishRun;
  const runner = {
    runTestCommand: () => new Promise((resolve) => { finishRun = resolve; }),
  };
  const service = makeService({ runner });
  const runPromise = service.run({ configId: 'unit' });
  const firstDispose = service.dispose();
  const secondDispose = service.dispose();
  assert.equal(firstDispose, secondDispose, 'repeated shutdown callers share one teardown promise');
  finishRun({
    status: 'aborted', exitCode: null, durationMs: 1,
    startedAt: 'S', finishedAt: 'F', stdoutTail: '', stderrTail: '',
    terminationConfirmed: true,
  });
  await runPromise;
  assert.deepEqual(await firstDispose, { disposed: true, terminationConfirmed: true });
});

test('wide-016: unconfirmed termination keeps the run lock until a retry confirms death', async () => {
  let confirmRetry;
  const retryGate = new Promise((resolve) => { confirmRetry = resolve; });
  const runner = {
    runTestCommand: async () => ({
      status: 'timeout', exitCode: null, durationMs: 1,
      startedAt: 'S', finishedAt: 'F', stdoutTail: '', stderrTail: '',
      terminationConfirmed: false,
      terminationWarning: 'kill_failed',
      retryTermination: () => retryGate,
    }),
  };
  const service = makeService({ runner });
  const first = await service.run({ configId: 'unit' });
  assert.equal(first.terminationConfirmed, false);
  assert.equal(service.getState().activeRun, 'run-1', 'unconfirmed process ownership remains locked');
  const second = await service.run({ configId: 'unit' });
  assert.equal(second.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING);

  const teardown = service.abortAndWait();
  let settled = false;
  teardown.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'retry confirmation is awaited');
  confirmRetry({ confirmed: true });
  assert.equal((await teardown).terminationConfirmed, true);
  assert.equal(service.getState().activeRun, null);
});

test('wide-016: unconfirmed termination without a retry fails closed and keeps ownership', async () => {
  const service = makeService({
    runner: {
      runTestCommand: async () => ({
        status: 'timeout', exitCode: null, durationMs: 1,
        startedAt: 'S', finishedAt: 'F', stdoutTail: '', stderrTail: '',
        terminationConfirmed: false,
      }),
    },
  });
  await service.run({ configId: 'unit' });
  const result = await service.abortAndWait();
  assert.equal(result.terminationConfirmed, false);
  assert.equal(result.reason, 'kill_unconfirmed');
  assert.equal(service.getState().activeRun, 'run-1');
});

test('s10: the single-run lock releases even when the runner rejects', async () => {
  // The lock lives in a `finally`, so a rejected/thrown runner still frees it. A
  // mutation that released the lock only on the success path would strand it
  // forever — the second run below would then wrongly see ALREADY_RUNNING.
  let calls = 0;
  const runner = {
    runTestCommand: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error('runner blew up'));
      }
      return Promise.resolve({ status: 'passed', exitCode: 0, durationMs: 1, startedAt: 'S', finishedAt: 'F' });
    },
  };
  const service = makeService({ runner });
  await assert.rejects(service.run({ configId: 'unit' }), /runner blew up/, 'the runner rejection propagates');
  const next = await service.run({ configId: 'unit' });
  assert.equal(next.status, 'passed', 'the lock released after the rejection, so the next run proceeds');
  assert.equal(calls, 2);
});

test('s5b: constructing the service reconciles a pre-existing orphaned running record', () => {
  // RED-BECAUSE: getState throws (no body yet) AND no reconcile wiring exists.
  const store = makeStore({
    byConfig: {
      unit: [{ runId: 'orphan', configId: 'unit', status: 'running', startedAt: 'A', exitCode: null, durationMs: null, finishedAt: null }],
    },
  });
  const history = createTestRunnerHistory({ store, now: () => new Date(7000) });
  const service = makeService({ history });
  const state = service.getState();
  assert.equal(state.history.byConfig.unit[0].status, 'interrupted', 'a crash-orphaned run is reconciled on start');
});

test('s6/s9: getState exposes configs, history, and the active run for the widget', () => {
  // RED-BECAUSE: getState throws (no body yet).
  const state = makeService().getState();
  // Full config shape (the widget consumes label/command/cwd), not just the id.
  assert.deepEqual(state.configs, [
    {
      id: 'unit', label: 'Unit', command: 'npm test', cwd: 'api', env: {}, timeoutMs: null,
      summaryRegex: '', gate: false, gateOnFailure: '',
    },
  ]);
  assert.deepEqual(state.history, { byConfig: {} });
  assert.equal(state.activeRun, null);
});

// ---------------------------------------------------------------------------
// S16 (Reliability) — realpath cwd containment. The effective cwd MUST resolve
// inside the workspace root; an escape is rejected BEFORE any spawn or history
// write. Real temp dirs give the realpath check genuine teeth.
// ---------------------------------------------------------------------------

function tmpRoot(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-svc-'));
  t.after(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch (_error) {
      /* best-effort cleanup */
    }
  });
  return base;
}

test('s16: an inside relative cwd is resolved to an absolute path under the root', async (t) => {
  // RED-BECAUSE: the service passes the raw config.cwd, not a root-resolved abs path.
  const root = tmpRoot(t);
  fs.mkdirSync(path.join(root, 'packages', 'api'), { recursive: true });
  const runner = passingRunner();
  const service = makeService({
    runner,
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'npm test', cwd: 'packages/api' }],
  });
  const ran = await service.run({ configId: 'unit' });
  assert.equal(ran.status, 'passed');
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].cwd, path.resolve(root, 'packages/api'), 'relative cwd joined to the root');
});

test('s16: an empty cwd defaults to the root itself (allowed though isChildPath(root,root) is false)', async (t) => {
  // RED-BECAUSE: the gate / root-default does not exist yet.
  const root = tmpRoot(t);
  const runner = passingRunner();
  const service = makeService({
    runner,
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'npm test' }],
  });
  const ran = await service.run({ configId: 'unit' });
  assert.equal(ran.status, 'passed', 'cwd === root must be allowed, not rejected as an escape');
  assert.equal(runner.calls[0].cwd, path.resolve(root), 'empty cwd -> the root');
});

test('s16: an absolute cwd inside the root is used as-is', async (t) => {
  // RED-BECAUSE: the gate does not exist yet.
  const root = tmpRoot(t);
  const inside = path.join(root, 'sub');
  fs.mkdirSync(inside, { recursive: true });
  const runner = passingRunner();
  const service = makeService({
    runner,
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'npm test', cwd: inside }],
  });
  const ran = await service.run({ configId: 'unit' });
  // Pin that the gate ALLOWED this inside-root absolute cwd (a positive-path teeth
  // the escape tests can't give): a mutation that rejects everything would set
  // ran.error and never reach the runner.
  assert.equal(ran.error, undefined, 'an inside-root absolute cwd must not be rejected by the gate');
  assert.equal(ran.status, 'passed');
  assert.equal(runner.calls[0].cwd, path.resolve(inside), 'an absolute cwd is used as-is (resolve, not join)');
});

test('s16: a relative cwd escaping the root is rejected CWD_OUTSIDE_ROOT (no spawn, no history)', async (t) => {
  // RED-BECAUSE: no containment gate -> the run spawns + records instead of rejecting.
  const root = tmpRoot(t);
  const runner = passingRunner();
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  const service = makeService({
    runner,
    history,
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'echo escaped', cwd: '../..' }],
  });
  const res = await service.run({ configId: 'unit' });
  assert.equal(res.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.CWD_OUTSIDE_ROOT);
  assert.equal(runner.calls.length, 0, 'an escaping cwd never spawns');
  assert.deepEqual(history.read().byConfig, {}, 'an escaping cwd records nothing');
});

test('s16: an absolute cwd outside the root is rejected CWD_OUTSIDE_ROOT', async (t) => {
  // RED-BECAUSE: no containment gate yet.
  const root = tmpRoot(t);
  const outside = tmpRoot(t); // a sibling temp dir, never under root
  const runner = passingRunner();
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  const service = makeService({
    runner,
    history,
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'npm test', cwd: outside }],
  });
  const res = await service.run({ configId: 'unit' });
  assert.equal(res.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.CWD_OUTSIDE_ROOT);
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(history.read().byConfig, {}, 'a rejected run leaves history untouched');
});

// ---------------------------------------------------------------------------
// S17 (Behavior) — optional summaryRegex -> {passedCount,failedCount} on the
// returned run record AND in history; status is ALWAYS exit-code authoritative.
// ---------------------------------------------------------------------------

test('s17: summaryRegex counts are attached to the run record and persisted to history', async (t) => {
  // RED-BECAUSE: the service does not parse summaryRegex yet.
  const root = tmpRoot(t);
  const runner = {
    calls: [],
    runTestCommand: (opts) => {
      runner.calls.push(opts);
      return Promise.resolve({
        status: 'passed', exitCode: 0, durationMs: 5, startedAt: 'S', finishedAt: 'F',
        stdoutTail: 'Tests: 12 passed, 3 failed',
      });
    },
  };
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  const service = makeService({
    runner,
    history,
    // Count propagation is the service contract under test. Use the pure
    // evaluator here so hosted worker-startup contention cannot consume the
    // bounded parser's advisory 250ms deadline; that worker seam has dedicated
    // coverage in workspace-test-runner-summary.test.js.
    summaryParser: parseSummary,
    rootProvider: () => root,
    configProvider: () => [{
      id: 'unit', command: 'npm test',
      summaryRegex: '(?<passed>\\d+) passed, (?<failed>\\d+) failed',
    }],
  });
  const ran = await service.run({ configId: 'unit' });
  assert.equal(ran.passedCount, 12, 'counts surface on the returned run object');
  assert.equal(ran.failedCount, 3);
  const record = history.getHistory('unit')[0];
  assert.equal(record.passedCount, 12, 'counts persist to history (FINISH_KEYS carries them)');
  assert.equal(record.failedCount, 3);
  assert.equal(record.status, 'passed', 'status stays exit-code authoritative, not from parsing');
});

test('s17: no summaryRegex -> counts omitted; status still from the exit code', async (t) => {
  // RED-BECAUSE: the service does not parse summaryRegex yet (counts would be undefined anyway,
  // but this pins the "never invents counts" contract for the green impl).
  const root = tmpRoot(t);
  const runner = {
    runTestCommand: () => Promise.resolve({
      status: 'failed', exitCode: 1, durationMs: 5, startedAt: 'S', finishedAt: 'F',
      stdoutTail: '7 passed', // parseable-looking, but there is no configured regex
    }),
  };
  const service = makeService({
    runner,
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'npm test' }],
  });
  const ran = await service.run({ configId: 'unit' });
  assert.equal(ran.status, 'failed');
  assert.equal('passedCount' in ran, false, 'no regex -> no counts invented');
  assert.equal('failedCount' in ran, false);
});

test('s17: a non-matching summaryRegex omits counts but never changes status', async (t) => {
  // RED-BECAUSE: the service does not parse summaryRegex yet.
  const root = tmpRoot(t);
  const runner = {
    runTestCommand: () => Promise.resolve({
      status: 'passed', exitCode: 0, durationMs: 5, startedAt: 'S', finishedAt: 'F',
      stdoutTail: 'no summary line here',
    }),
  };
  const service = makeService({
    runner,
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'npm test', summaryRegex: '(?<passed>\\d+) passed' }],
  });
  const ran = await service.run({ configId: 'unit' });
  assert.equal(ran.status, 'passed');
  assert.equal('passedCount' in ran, false, 'a non-match invents no counts');
});

// ---------------------------------------------------------------------------
// S14 (Reliability) — abort cancels the in-flight run via an AbortController whose
// signal the service threads into the runner; the run records 'aborted' and the
// single-run lock releases. abort() with no active run is a clean no-op.
// ---------------------------------------------------------------------------

function abortAwareRunner() {
  const calls = [];
  return {
    calls,
    runTestCommand: (opts) => {
      calls.push(opts);
      return new Promise((resolve) => {
        const settle = () => resolve({
          status: 'aborted', exitCode: null, durationMs: 1, startedAt: 'S', finishedAt: 'F',
        });
        if (opts.abortSignal && opts.abortSignal.aborted) {
          settle();
          return;
        }
        opts.abortSignal.addEventListener('abort', settle, { once: true });
      });
    },
  };
}

test('s14: abort() fires the runner signal, records aborted, and releases the lock', async (t) => {
  // RED-BECAUSE: service.abort is not a function yet (no AbortController wiring).
  const root = tmpRoot(t);
  const runner = abortAwareRunner();
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  const service = makeService({
    runner,
    history,
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'sleep 999' }],
  });
  const p = service.run({ configId: 'unit' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runner.calls.length, 1, 'the run is in flight');
  assert.ok(runner.calls[0].abortSignal, 'an AbortSignal is threaded into the runner');
  assert.equal(runner.calls[0].abortSignal.aborted, false, 'the signal has not fired yet');

  const res = service.abort();
  assert.equal(res.aborted, true);
  assert.equal(res.runId, 'run-1', 'abort reports which run it cancelled');
  // Direct mutation guard: a no-op abort() leaves this false (RED) without hanging.
  assert.equal(runner.calls[0].abortSignal.aborted, true, 'abort() fired the runner signal');

  const ran = await p;
  assert.equal(ran.status, 'aborted');
  assert.equal(service.getState().activeRun, null, 'the single-run lock released after abort');
  assert.equal(history.getHistory('unit')[0].status, 'aborted', 'the aborted status flows into history');
});

test('s14: abort() with no active run is a clean structured no-op', () => {
  // RED-BECAUSE: service.abort is not a function yet.
  assert.deepEqual(makeService().abort(), { aborted: false });
});

// ---------------------------------------------------------------------------
// S13 (Experience/Architecture) — live state push: the service notifies an
// injected onStateChange callback at run START, run FINISH, and on ABORT, and
// getState exposes the active run's configId so the widget can badge the right
// row as 'running' (the wiring turns these into a workspaceTestRunner.onStateChanged
// bridge push; the renderer mirrors them into ctx.state.testRunner).
// ---------------------------------------------------------------------------

test('s13: onStateChange fires started then finished around a completed run', async (t) => {
  // RED-BECAUSE: the service does not accept/notify onStateChange yet.
  const root = tmpRoot(t);
  const events = [];
  const service = makeService({
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'npm test' }],
    onStateChange: (payload) => events.push(payload),
  });
  await service.run({ configId: 'unit' });
  assert.deepEqual(events.map((e) => e.phase), ['started', 'finished'], 'started precedes finished');
  assert.equal(events[0].configId, 'unit');
  assert.equal(events[0].runId, 'run-1');
  assert.equal(events[1].configId, 'unit');
  assert.equal(events[1].runId, 'run-1');
});

test('s13: getState exposes activeConfigId while a run is in flight, null when idle', async (t) => {
  // RED-BECAUSE: getState does not expose activeConfigId yet.
  const root = tmpRoot(t);
  let release;
  const runner = {
    calls: [],
    runTestCommand: (opts) => {
      runner.calls.push(opts);
      return new Promise((resolve) => {
        release = () => resolve({ status: 'passed', exitCode: 0, durationMs: 1, startedAt: 'S', finishedAt: 'F' });
      });
    },
  };
  const service = makeService({
    runner,
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'npm test' }],
  });
  assert.equal(service.getState().activeConfigId, null, 'idle -> no active config');
  const p = service.run({ configId: 'unit' });
  await Promise.resolve();
  await Promise.resolve();
  const mid = service.getState();
  assert.equal(mid.activeRun, 'run-1');
  assert.equal(mid.activeConfigId, 'unit', 'the running config id is exposed for the widget badge');
  release();
  await p;
  assert.equal(service.getState().activeConfigId, null, 'cleared after the run completes');
});

// ---------------------------------------------------------------------------
// S18 (Experience) — the config write path. saveConfigs normalizes via
// normalizeConfigs, caps the stored count, persists through the injected
// configWriter, and returns the normalized set. ROOT_MISSING when no root.
// ---------------------------------------------------------------------------

test('s18: saveConfigs normalizes, persists via the injected writer, and returns the normalized set', () => {
  // RED-BECAUSE: service.saveConfigs does not exist yet.
  const written = [];
  const service = makeService({ configWriter: (configs) => written.push(configs) });
  const result = service.saveConfigs([
    { id: 'unit', label: 'Unit', command: 'npm test', cwd: 'api' },
    { id: 'bad' }, // no command -> normalize-dropped
    { id: 'unit', command: 'dup' }, // duplicate id -> dropped (first wins)
  ]);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.configs.map((c) => c.id), ['unit'], 'invalid/duplicate entries are normalize-dropped');
  assert.equal(written.length, 1, 'the writer persisted exactly once');
  assert.deepEqual(written[0].map((c) => c.id), ['unit'], 'the normalized set is what gets written');
  // Full normalized shape persisted, so a reload reads an identical record shape.
  assert.deepEqual(written[0][0], {
    id: 'unit', label: 'Unit', command: 'npm test', cwd: 'api', env: {}, timeoutMs: null,
    summaryRegex: '', gate: false, gateOnFailure: '',
  });
});

test('s18: saveConfigs bounds persisted strings and env payloads before writing', () => {
  const written = [];
  const service = makeService({ configWriter: (configs) => written.push(configs) });
  const env = {
    'BAD=KEY': 'drop',
    [`${'K'.repeat(MAX_ENV_KEY_LENGTH + 1)}`]: 'drop',
    NUL_VALUE: 'drop\0me',
    TOO_LONG_VALUE: 'x'.repeat(MAX_ENV_VALUE_LENGTH + 1),
  };
  for (let i = 0; i < MAX_ENV_ENTRIES + 5; i += 1) {
    env[`KEY_${i}`] = `value-${i}`;
  }
  const result = service.saveConfigs([
    {
      id: 'unit',
      label: 'L'.repeat(MAX_LABEL_LENGTH + 20),
      command: 'npm test',
      cwd: 'api',
      env,
      summaryRegex: 'x'.repeat(MAX_SUMMARY_REGEX_LENGTH + 1),
    },
    { id: 'a'.repeat(MAX_CONFIG_ID_LENGTH + 1), command: 'npm test' },
    { id: 'longCommand', command: 'x'.repeat(MAX_COMMAND_LENGTH + 1) },
    { id: 'longCwd', command: 'npm test', cwd: 'x'.repeat(MAX_CWD_LENGTH + 1) },
  ]);

  assert.deepEqual(result.configs.map((c) => c.id), ['unit']);
  const normalized = result.configs[0];
  assert.equal(normalized.label.length, MAX_LABEL_LENGTH, 'labels are truncated before persistence');
  assert.equal(normalized.summaryRegex, '', 'oversized summary regex source is dropped');
  assert.equal(Object.keys(normalized.env).length, MAX_ENV_ENTRIES, 'env entries are capped');
  assert.equal(normalized.env.KEY_0, 'value-0');
  assert.equal(normalized.env[`KEY_${MAX_ENV_ENTRIES - 1}`], `value-${MAX_ENV_ENTRIES - 1}`);
  assert.equal(normalized.env[`KEY_${MAX_ENV_ENTRIES}`], undefined);
  assert.equal(normalized.env['BAD=KEY'], undefined);
  assert.equal(normalized.env.NUL_VALUE, undefined);
  assert.deepEqual(written[0], result.configs, 'the bounded set is what is written');
});

test('s18: saveConfigs with no workspace root returns ROOT_MISSING and writes nothing', () => {
  // RED-BECAUSE: service.saveConfigs does not exist yet.
  const written = [];
  const service = makeService({ rootProvider: () => '', configWriter: (c) => written.push(c) });
  const result = service.saveConfigs([{ id: 'unit', command: 'npm test' }]);
  assert.equal(result.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.ROOT_MISSING);
  assert.equal(written.length, 0, 'no root -> nothing persisted');
});

test('s18: saveConfigs caps the number of stored configurations', () => {
  // RED-BECAUSE: service.saveConfigs does not exist yet.
  const written = [];
  const service = makeService({ configWriter: (c) => written.push(c) });
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `c${i}`, command: 'echo hi' }));
  const result = service.saveConfigs(many);
  // === 50 (not <= 50) pins the cap value: a mutation to e.g. 30 would still
  // satisfy <= 50, so the loose assertion left the cap unguarded.
  assert.equal(result.configs.length, 50, 'the stored set is capped at exactly 50');
  assert.deepEqual(result.configs.map((c) => c.id), many.slice(0, 50).map((c) => c.id), 'the first 50 are kept');
  assert.equal(written[0].length, result.configs.length, 'the capped set is what is written');
});

test('s18: exactly 50 valid configurations are retained in full (cap does not truncate a valid set)', () => {
  const written = [];
  const service = makeService({ configWriter: (c) => written.push(c) });
  const fifty = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, command: 'echo hi' }));
  const result = service.saveConfigs(fifty);
  assert.equal(result.configs.length, 50, 'a valid 50-config set is kept whole');
  assert.equal(written[0].length, 50, 'all 50 are written');
});

// ---------------------------------------------------------------------------
// WIDE-032: saveConfigs refuses to persist a set that drops the configuration
// with an active run, so its Stop control can never go stale/unreachable.
// ---------------------------------------------------------------------------

test('wide-032: saveConfigs refuses to remove the actively-running configuration', async () => {
  let resolveRunner;
  const runner = {
    runTestCommand: () => new Promise((resolve) => { resolveRunner = resolve; }),
  };
  const written = [];
  const service = makeService({
    runner,
    configProvider: () => [
      { id: 'unit', label: 'Unit', command: 'npm test' },
      { id: 'lint', label: 'Lint', command: 'npm run lint' },
    ],
    configWriter: (configs) => written.push(configs),
  });
  const runPromise = service.run({ configId: 'unit' }); // takes the lock, stays running

  const result = service.saveConfigs([{ id: 'lint', label: 'Lint', command: 'npm run lint' }]);
  assert.equal(result.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_ACTIVE_RUN);
  assert.equal(written.length, 0, 'a refused save writes nothing - the active config is never dropped on disk');

  resolveRunner({ status: 'passed', exitCode: 0, durationMs: 1, startedAt: 'S', finishedAt: 'F' });
  await runPromise;
});

test('wide-032: saveConfigs still allows editing other configs while one is running, as long as it stays', async () => {
  let resolveRunner;
  const runner = {
    runTestCommand: () => new Promise((resolve) => { resolveRunner = resolve; }),
  };
  const written = [];
  const service = makeService({
    runner,
    configProvider: () => [
      { id: 'unit', label: 'Unit', command: 'npm test' },
      { id: 'lint', label: 'Lint', command: 'npm run lint' },
    ],
    configWriter: (configs) => written.push(configs),
  });
  const runPromise = service.run({ configId: 'unit' });

  const result = service.saveConfigs([
    { id: 'unit', label: 'Unit', command: 'npm test' }, // the active run's row stays present
    { id: 'e2e', label: 'E2E', command: 'npm run e2e' }, // a new config is added alongside it
  ]);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.configs.map((c) => c.id), ['unit', 'e2e']);
  assert.equal(written.length, 1, 'a save that keeps the active config present is persisted normally');

  resolveRunner({ status: 'passed', exitCode: 0, durationMs: 1, startedAt: 'S', finishedAt: 'F' });
  await runPromise;
});

test('wide-032: once the run finishes, saveConfigs can remove the (now idle) configuration again', async () => {
  let resolveRunner;
  const runner = {
    runTestCommand: () => new Promise((resolve) => { resolveRunner = resolve; }),
  };
  const written = [];
  const service = makeService({
    runner,
    configProvider: () => [{ id: 'unit', label: 'Unit', command: 'npm test' }],
    configWriter: (configs) => written.push(configs),
  });
  const runPromise = service.run({ configId: 'unit' });

  const refused = service.saveConfigs([]);
  assert.equal(refused.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_ACTIVE_RUN);

  resolveRunner({ status: 'passed', exitCode: 0, durationMs: 1, startedAt: 'S', finishedAt: 'F' });
  await runPromise;

  const removed = service.saveConfigs([]);
  assert.equal(removed.error, undefined);
  assert.deepEqual(removed.configs, [], 'the config can be removed once its run has settled');
  assert.deepEqual(written[written.length - 1], [], 'the empty set persisted after the run settled');
});

test('s13: a runner REJECTION still emits a settle event and finalizes history (no phantom running)', async (t) => {
  // RED-BECAUSE: 'finished' is emitted only after the await, so a rejecting runner
  // skips it -> the renderer's running badge sticks AND history keeps 'running'.
  const root = tmpRoot(t);
  const events = [];
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  const runner = { runTestCommand: () => Promise.reject(new Error('runner blew up')) };
  const service = makeService({
    runner,
    history,
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'npm test' }],
    onStateChange: (payload) => events.push(payload),
  });
  await assert.rejects(service.run({ configId: 'unit' }), /runner blew up/, 'the rejection still propagates');
  // The renderer MUST still receive a settle event so the running badge clears.
  assert.deepEqual(events.map((e) => e.phase), ['started', 'finished'], 'a settle event fires even on rejection');
  assert.equal(events[1].activeRun, null, 'the finished payload carries the post-transition (null) activeRun');
  // History must not be left with a phantom 'running' record.
  const rec = history.getHistory('unit')[0];
  assert.equal(rec.status, 'error', 'the run is finalized to error, not left running');
  assert.equal(service.getState().activeRun, null, 'the lock released');
});

test('s13: abort() emits an aborted state event for the in-flight run', async (t) => {
  // RED-BECAUSE: abort() does not emit a state event yet.
  const root = tmpRoot(t);
  const events = [];
  const runner = abortAwareRunner();
  const service = makeService({
    runner,
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'sleep 999' }],
    onStateChange: (payload) => events.push(payload),
  });
  const p = service.run({ configId: 'unit' });
  await Promise.resolve();
  await Promise.resolve();
  service.abort();
  const ran = await p;
  assert.equal(ran.status, 'aborted');
  assert.deepEqual(events.map((e) => e.phase), ['started', 'aborted', 'finished'], 'abort emits between started and finished');
  const abortedEvent = events.find((e) => e.phase === 'aborted');
  assert.equal(abortedEvent.configId, 'unit');
  assert.equal(abortedEvent.runId, 'run-1');
});

// ---------------------------------------------------------------------------
// Verification gate Wave 3: who started a run, a Jenny run refused by the
// lock, and every dropped configuration named on save.
// ---------------------------------------------------------------------------

test('gate: a jenny-initiated run is attributed on the returned record and in history', async () => {
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  const result = await makeService({ history }).run({ configId: 'unit', initiator: 'jenny', gateAttempt: 2 });
  assert.equal(result.initiator, 'jenny');
  assert.equal(result.gateAttempt, 2);
  const [record] = history.getHistory('unit');
  assert.equal(record.initiator, 'jenny');
  assert.equal(record.gateAttempt, 2);
  assert.equal(record.status, 'passed');
});

test('gate: the renderer run path is byte-identical -- no attribution keys appear', async () => {
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  const result = await makeService({ history }).run({ configId: 'unit' });
  assert.equal('initiator' in result, false);
  assert.equal('gateAttempt' in result, false);
  assert.equal('initiator' in history.getHistory('unit')[0], false);
});

test('gate: an unknown initiator or an absurd attempt is dropped, never recorded', async () => {
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  const result = await makeService({ history }).run({ configId: 'unit', initiator: 'mallory', gateAttempt: 10000 });
  assert.equal('initiator' in result, false);
  assert.equal('gateAttempt' in result, false);
});

test('gate: a Jenny run refused by the single-run lock leaves a skipped record; a user refusal does not', async () => {
  let resolveRunner;
  const runner = {
    runTestCommand: () => new Promise((resolve) => { resolveRunner = resolve; }),
  };
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  let counter = 0;
  const service = makeService({ runner, history, makeRunId: () => `run-${(counter += 1)}` });
  const first = service.run({ configId: 'unit' });
  const userRefusal = await service.run({ configId: 'unit' });
  assert.equal(userRefusal.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING);
  assert.equal(history.getHistory('unit').length, 1, 'the user double-click records nothing');
  const jennyRefusal = await service.run({ configId: 'unit', initiator: 'jenny', gateAttempt: 1 });
  assert.equal(jennyRefusal.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING, 'still refused');
  const records = history.getHistory('unit');
  assert.equal(records.length, 2);
  assert.equal(records[1].status, 'skipped');
  assert.equal(records[1].skipReason, 'already_running');
  assert.equal(records[1].initiator, 'jenny');
  assert.equal(records[1].gateAttempt, 1);
  assert.notEqual(records[1].runId, records[0].runId, 'the skip has its own id');
  resolveRunner({ status: 'passed', exitCode: 0, durationMs: 1, startedAt: 'S', finishedAt: 'F' });
  await first;
  assert.equal(history.getHistory('unit')[0].status, 'passed', 'the real run finished normally');
});

test('gate: a history that cannot record a skip does not turn the refusal into a throw', async () => {
  let resolveRunner;
  const runner = { runTestCommand: () => new Promise((resolve) => { resolveRunner = resolve; }) };
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) });
  history.recordSkip = () => { throw new Error('disk full'); };
  const service = makeService({ runner, history });
  const first = service.run({ configId: 'unit' });
  const refusal = await service.run({ configId: 'unit', initiator: 'jenny' });
  assert.equal(refusal.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING);
  resolveRunner({ status: 'passed', exitCode: 0, durationMs: 1, startedAt: 'S', finishedAt: 'F' });
  await first;
});

test('finding 1: saveConfigs names every dropped entry and why', () => {
  const service = makeService({ configWriter: () => {} });
  const result = service.saveConfigs([
    { id: 'unit', command: 'npm test' },
    { id: 'bad id', command: 'npm test' },
    { id: 'unit', command: 'again' },
    { id: 'nocmd' },
    'junk',
  ]);
  assert.deepEqual(result.configs.map((c) => c.id), ['unit']);
  assert.deepEqual(result.rejected, [
    { id: 'bad id', reason: 'invalid_id' },
    { id: 'unit', reason: 'duplicate_id' },
    { id: 'nocmd', reason: 'invalid_command' },
    { id: '', reason: 'malformed' },
  ]);
});

test('finding 1: entries past the cap are reported as over_cap, not silently cut', () => {
  const service = makeService({ configWriter: () => {} });
  const result = service.saveConfigs(Array.from({ length: 52 }, (_, i) => ({ id: `c${i}`, command: 'x' })));
  assert.equal(result.configs.length, 50);
  assert.deepEqual(result.rejected, [{ id: 'c50', reason: 'over_cap' }, { id: 'c51', reason: 'over_cap' }]);
});

test('finding 1: a clean save reports an empty rejected list', () => {
  const service = makeService({ configWriter: () => {} });
  assert.deepEqual(service.saveConfigs([{ id: 'unit', command: 'npm test' }]).rejected, []);
});
