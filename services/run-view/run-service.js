'use strict';

/*
 * run-service.js — the live run view's run service (row 197, R1-service).
 *
 * One run per project. The state table (run-state.js) decides what may happen;
 * this service carries out its effects: the build process, the program through
 * the helper host, the no-window and close timers, and the pushes to the
 * renderer. It never throws to a caller; every public method answers with a
 * plain { ok, ... } object.
 *
 * Containment: a relative program, and the working folder, must realpath-resolve
 * inside the project root. They are checked before a generation starts (so a
 * refusal never leaves a half-started run) and again at spawn time.
 */

const crypto = require('node:crypto');
const { BUILD_TIMEOUT_MS, buildEnvBlock, resolveLaunch, startBuild } = require('./build-step');
const { createCropRefresh } = require('./crop-refresh');
const { pidOk, pidsOf, validCapture } = require('./helper-replies');
const {
  initialRunState, isLive, isResting, transition,
} = require('./run-state');

const STATE_CHANNEL = 'run-view:state';
const KEEP_FRAME_CHANNEL = 'run-view:keep-last-frame';
const FORCE_CLOSE_TIMEOUT_MS = 2_000;
const STOP_WAIT_MS = 12_000;
const OUTPUT_MAX_LINES = 200;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOOK_LONG_EDGE = 1568;
const LOOK_MAX_BYTES = 2_000_000;
const RESTART_SETTLE_MS = 500;
const RESTART_WAIT_MARGIN_MS = 30_000;
const RESTART_OUTPUT_LINES = 40;
const RESTART_LINE_CHARS = 400;

// A start the helper host refused (no helper binary): whether a source build can fix it rides with the reason.
const HELPER_MISSING = 'helper_unavailable';

function snapshot(projectId, r, packaged = false) {
  const s = r?.state || initialRunState();
  return {
    projectId,
    state: s.state,
    generation: s.generation,
    chatId: s.chatId,
    sourceId: s.sourceId,
    hwnd: s.hwnd,
    exitCode: s.exitCode,
    buildTail: s.buildTail,
    reason: s.reason,
    ...(s.reason === HELPER_MISSING ? { helperBuildHint: !packaged } : {}),
    crop: r?.crop ?? null,
  };
}

function newRecord() {
  return {
    state: initialRunState(), plan: null, nextPlan: null, runId: null, build: null,
    timers: { noWindow: null, close: null }, waiters: [], closing: false, lastShown: '',
    lastSignature: null, listeners: [],
    crop: null, cropBusy: false, cropAgain: false, jobPids: [],
  };
}

function createRunService(options = {}) {
  const { host, commandStore, getProjectBinding, armWindowCapture, emit } = options;
  for (const [name, value] of Object.entries({ host, commandStore, getProjectBinding, armWindowCapture, emit })) {
    if (!value) throw new TypeError(`${name} is required`);
  }
  const env = options.env || process.env;
  const packaged = options.isPackaged === true;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const randomId = options.randomId || (() => crypto.randomBytes(6).toString('hex'));
  const logger = options.logger || null;
  const records = new Map();
  let disposed = false; // set by dispose(): nothing new starts after shutdown

  const warn = (message, error) => {
    try { logger?.warn?.(`[run-view] ${message}${error ? `: ${error.code || error.message}` : ''}`); } catch { /* logging never throws */ }
  };
  const push = (channel, payload) => {
    try { emit(channel, payload); } catch (error) { warn('emit failed', error); }
  };
  const recordOf = (projectId) => {
    if (!records.has(projectId)) records.set(projectId, newRecord());
    return records.get(projectId);
  };

  // ---- transitions and effects ----------------------------------------

  function dispatch(r, projectId, event, plan = null) {
    const prev = r.state;
    const result = transition(prev, event);
    if (!result.ok) return result;
    if (plan) r.nextPlan = plan;
    r.state = result.state;
    if (r.state.hwnd !== prev.hwnd) r.crop = null; // another window or none: the crop no longer applies
    if (isResting(r.state)) r.jobPids = [];
    if (r.state.generation !== prev.generation) beginGeneration(r, prev);
    if (result.effects.some((e) => e.kind === 'keep_last_frame')) {
      push(KEEP_FRAME_CHANNEL, { projectId, generation: r.state.generation });
    }
    showState(r, projectId);
    for (const effect of result.effects) runEffect(r, projectId, effect, prev.state);
    if (isResting(r.state)) releaseWaiters(r);
    for (const listener of [...r.listeners]) {
      try { listener(); } catch (error) { warn('state listener failed', error); }
    }
    return result;
  }

  function showState(r, projectId) {
    const current = snapshot(projectId, r, packaged);
    const shown = JSON.stringify(current);
    if (shown === r.lastShown) return;
    r.lastShown = shown;
    push(STATE_CHANNEL, current);
  }

  // Never throws: used by timers, host events and request replies.
  function deliver(r, projectId, event) {
    try { dispatch(r, projectId, event); } catch (error) { warn('transition failed', error); }
  }

  function beginGeneration(r, prev) {
    const old = r.runId;
    r.plan = r.nextPlan;
    r.nextPlan = null;
    r.runId = null;
    r.lastSignature = null;
    r.jobPids = [];
    // A run that ended by itself keeps its record in the helper until now.
    if (old && isResting(prev)) {
      host.request('run.stop', { run_id: old, close_timeout_ms: 0 }).catch(() => {});
    }
  }

  function releaseWaiters(r) {
    const waiting = r.waiters;
    r.waiters = [];
    // Cleared on every rest, so a stopProject that timed out cannot block later builds.
    r.closing = false;
    for (const finish of waiting) finish();
  }

  function arm(r, projectId, slot, ms, type) {
    if (r.timers[slot] !== null) clearTimer(r.timers[slot]);
    const generation = r.state.generation;
    r.timers[slot] = setTimer(() => {
      r.timers[slot] = null;
      deliver(r, projectId, { type, generation });
    }, ms);
  }

  function clearTimers(r) {
    for (const slot of Object.keys(r.timers)) {
      if (r.timers[slot] !== null) clearTimer(r.timers[slot]);
      r.timers[slot] = null;
    }
  }

  function runEffect(r, projectId, effect, prevName) {
    switch (effect.kind) {
      case 'run_build': return runBuild(r, projectId, effect.generation);
      case 'spawn':
        return void spawnRun(r, projectId, effect.generation).catch((error) => warn('spawn failed', error));
      case 'cancel_build': return r.build?.cancel();
      case 'close_window': return closeWindow(r);
      case 'force_stop': return forceStop(r, projectId, prevName === 'close_refused' ? 0 : FORCE_CLOSE_TIMEOUT_MS);
      case 'arm_close_timer': return arm(r, projectId, 'close', effect.ms, 'close_timeout');
      case 'arm_no_window_timer': return arm(r, projectId, 'noWindow', effect.ms, 'no_window_timeout');
      case 'clear_timers': return clearTimers(r);
      default: return undefined;
    }
  }

  function runBuild(r, projectId, generation) {
    const { plan } = r;
    const failed = (tail) => deliver(r, projectId, { type: 'build_failed', generation, exitCode: null, tail });
    if (r.closing) return failed('');
    const moved = resolveLaunch(plan.command, plan.rootPath, { requireProgram: false }).reason;
    if (moved) {
      return failed(moved === 'cwd_outside_root' ? 'the working folder is no longer inside the project'
        : 'the program is no longer a path this run can start');
    }
    const build = startBuild({
      command: plan.command.build, cwd: plan.cwd, env: plan.env, spawnBuild: options.spawnBuild,
      killTree: options.killTree, setTimeout: setTimer, clearTimeout: clearTimer,
    });
    r.build = build;
    return void build.done.then((result) => {
      if (r.build === build) r.build = null;
      const ok = result.exitCode === 0 && !result.cancelled && !result.timedOut;
      deliver(r, projectId, ok
        ? { type: 'build_ok', generation }
        : { type: 'build_failed', generation, exitCode: result.exitCode, tail: result.tail });
    });
  }

  async function spawnRun(r, projectId, generation) {
    const { plan } = r;
    const fail = (reason) => deliver(r, projectId, { type: 'spawn_failed', generation, reason });
    if (r.closing) return fail('shutting_down');
    const check = resolveLaunch(plan.command, plan.rootPath, { requireProgram: true });
    if (check.reason) return fail(check.reason);
    const runId = `r-${generation}-${randomId()}`;
    if (!RUN_ID_RE.test(runId)) return fail('bad_run_id');
    r.runId = runId;
    let reply;
    try {
      reply = await host.request('run.start', {
        run_id: runId, program: check.launch.program, args: plan.command.args, cwd: check.launch.cwd, env: plan.env,
      });
    } catch (error) {
      if (r.runId === runId) r.runId = null;
      return fail(error?.code || 'start_failed');
    }
    if (r.runId !== runId) {
      // A newer generation replaced this one: nothing else will stop this run. A record still ours stays, so a
      // program that exited keeps its output until the next generation (our own stop already sent run.stop).
      host.request('run.stop', { run_id: runId, close_timeout_ms: 0 }).catch(() => {});
      return undefined;
    }
    return deliver(r, projectId, { type: 'spawned', generation, pid: reply?.pid ?? null });
  }

  function closeWindow(r) {
    if (!r.runId) return;
    host.request('run.close', { run_id: r.runId }).catch((error) => warn('run.close failed', error));
  }

  function forceStop(r, projectId, closeTimeoutMs) {
    const generation = r.state.generation;
    const stopped = (exitCode) => deliver(r, projectId, { type: 'stopped', generation, exitCode });
    if (!r.runId) return stopped(null);
    host.request('run.stop', { run_id: r.runId, close_timeout_ms: closeTimeoutMs }).then(
      (reply) => stopped(Number.isInteger(reply?.exit_code) ? reply.exit_code : null),
      (error) => {
        if (error?.code !== 'no_such_run') warn('run.stop failed', error);
        stopped(null);
      },
    );
    return undefined;
  }

  // ---- host events ------------------------------------------------------

  function onRunEvent(runId, make, after = null) {
    for (const [projectId, r] of records) {
      if (!runId || r.runId !== runId) continue;
      deliver(r, projectId, { generation: r.state.generation, ...make() });
      after?.(r, projectId);
    }
  }

  // The window's client area as a crop of its drawn bounds (crop-refresh.js).
  const refreshCrop = createCropRefresh({ request: (op, args) => host.request(op, args), warn, onCrop: showState });
  // Helper events are untrusted: a window needs a real handle and a bounded source id; an exit code is an integer or null.
  const hwndOf = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
  const sourceOf = (value) => (typeof value === 'string' && value.length <= 200 ? value : null);
  const hostEvents = {
    'run.window': (f) => {
      if (hwndOf(f?.hwnd) === null) return;
      onRunEvent(f.run_id, () => ({ type: 'window', hwnd: f.hwnd, sourceId: sourceOf(f.source_id) }), refreshCrop);
    },
    'run.window_state': (f) => onRunEvent(f?.run_id, () => ({ type: 'window_state', state: f.state }),
      f?.state === 'moved' || f?.state === 'restored' ? refreshCrop : null),
    'run.exited': (f) => onRunEvent(f?.run_id, () => ({ type: 'exited', exitCode: Number.isSafeInteger(f.exit_code) ? f.exit_code : null })),
    helper_exited: (f) => {
      for (const runId of Array.isArray(f?.runIds) ? f.runIds : []) onRunEvent(runId, () => ({ type: 'exited', exitCode: null }));
    },
  };
  for (const [name, listener] of Object.entries(hostEvents)) host.on(name, listener);

  // ---- public methods ---------------------------------------------------

  async function bindingOf(projectId, worktree) {
    const binding = await getProjectBinding(projectId, worktree ?? null);
    return binding && typeof binding.rootPath === 'string' ? binding : null;
  }

  const storeKey = (projectId, binding, worktree) => ({
    projectId, rootId: binding.rootId, rootRevision: binding.rootRevision, worktree: worktree ?? null,
  });

  // The command, checked against the root; { plan } or a refusal.
  async function prepare(projectId, worktree) {
    const binding = await bindingOf(projectId, worktree);
    if (!binding) return { ok: false, reason: 'no_project' };
    const got = commandStore.get(storeKey(projectId, binding, worktree));
    if (got.status === 'none') return { ok: false, reason: 'no_command' };
    if (got.status !== 'confirmed') return { ok: false, reason: 'needs_confirmation', confirmReason: got.reason };
    const { command } = got;
    // A build may be what makes the program, so it is only required to exist at spawn time.
    const check = resolveLaunch(command, binding.rootPath, { requireProgram: command.build.trim() === '' });
    if (check.reason) return { ok: false, reason: check.reason };
    return {
      ok: true,
      hasBuild: command.build.trim() !== '',
      plan: { command, rootPath: binding.rootPath, cwd: check.launch.cwd, env: buildEnvBlock(env, command.env) },
    };
  }

  const view = (projectId) => snapshot(projectId, records.get(projectId), packaged);

  async function begin(type, { projectId, chatId, worktree, signal = null }) {
    if (disposed) return { ok: false, reason: 'shutting_down' };
    const probe = transition(records.get(projectId)?.state || initialRunState(), { type });
    if (type === 'start' && !probe.ok) return { ok: false, reason: probe.reason, startedBy: probe.startedBy };
    const prepared = await prepare(projectId, worktree);
    if (!prepared.ok) return prepared;
    if (disposed) return { ok: false, reason: 'shutting_down' };
    // Aborted while the command was checked: nothing is stopped yet, so a run that is up stays up.
    if (type === 'restart' && signal?.aborted) return { ok: false, outcome: 'cancelled', run: view(projectId) };
    // A Run or Restart someone asked for is a fresh try at a helper that failed to start earlier.
    if (host.state?.() === 'unavailable') host.reset?.();
    const result = dispatch(recordOf(projectId), projectId,
      { type, chatId, hasBuild: prepared.hasBuild }, prepared.plan);
    if (!result.ok) return { ok: false, reason: result.reason, startedBy: result.startedBy };
    return { ok: true, run: view(projectId) };
  }

  async function getStatus({ projectId, worktree }) {
    const binding = await bindingOf(projectId, worktree);
    if (!binding) return { ok: false, reason: 'no_project' };
    return { ok: true, command: commandStore.get(storeKey(projectId, binding, worktree)), run: view(projectId) };
  }

  async function confirmCommand({ projectId, worktree, command }) {
    const r = records.get(projectId);
    if (r && !isResting(r.state)) return { ok: false, reason: 'run_active' };
    const binding = await bindingOf(projectId, worktree);
    if (!binding) return { ok: false, reason: 'no_project' };
    const saved = commandStore.confirm({ ...storeKey(projectId, binding, worktree), command });
    return saved.ok ? getStatus({ projectId, worktree }) : saved;
  }

  async function stop({ projectId, mode }) {
    const r = records.get(projectId);
    if (!r) return { ok: false, reason: 'not_running' };
    const result = dispatch(r, projectId, { type: 'stop', mode });
    return result.ok ? { ok: true, run: view(projectId) } : { ok: false, reason: result.reason };
  }

  async function showWindow({ projectId, place }) {
    const hwnd = records.get(projectId)?.state.hwnd ?? null;
    if (hwnd === null) return { ok: false, reason: 'not_running' };
    try {
      await host.request('window.show', { hwnd, mode: place });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error?.code || 'show_failed' };
    }
  }

  async function armCapture({ projectId }) {
    const s = records.get(projectId)?.state;
    if (!s || !isLive(s) || !s.sourceId) return { ok: false, reason: 'not_running' };
    const armed = await armWindowCapture(s.sourceId);
    return armed?.ok === true ? { ok: true, sourceId: s.sourceId } : { ok: false, reason: armed?.reason || 'arm_refused' };
  }

  async function output({ projectId }) {
    const runId = records.get(projectId)?.runId;
    if (!runId) return { ok: false, reason: 'not_running' };
    try {
      const reply = await host.request('run.output', { run_id: runId, max_lines: OUTPUT_MAX_LINES });
      return { ok: true, lines: reply?.lines ?? [], droppedBytes: reply?.dropped_bytes ?? 0 };
    } catch (error) {
      return { ok: false, reason: error?.code || 'output_failed' };
    }
  }

  // One picture of the running program's window; `changed` compares its frame signature with the last look.
  async function look({ projectId }) {
    const r = records.get(projectId);
    if (r?.state.state === 'minimized') return { ok: false, reason: 'minimized' };
    if (r?.state.state !== 'running' || r.state.hwnd === null) return { ok: false, reason: 'not_running' };
    const { generation, hwnd } = r.state;
    let reply;
    try {
      reply = await host.request('capture', {
        hwnd, max_long_edge: LOOK_LONG_EDGE, max_bytes: LOOK_MAX_BYTES, area: 'client',
      });
    } catch (error) {
      return { ok: false, reason: error?.code || 'capture_failed' };
    }
    if (r.state.generation !== generation || isResting(r.state)) return { ok: false, reason: 'not_running' };
    const picture = validCapture(reply);
    if (!picture) return { ok: false, reason: 'bad_capture' };
    const changed = r.lastSignature === null ? null : picture.signature !== r.lastSignature;
    r.lastSignature = picture.signature;
    return { ok: true, ...picture, generation, changed };
  }

  // The last lines the ended run printed; [] when the helper no longer has them.
  async function endedLines(runId) {
    if (!runId) return [];
    try {
      const reply = await host.request('run.output', { run_id: runId, max_lines: RESTART_OUTPUT_LINES });
      const lines = Array.isArray(reply?.lines) ? reply.lines.filter((line) => typeof line === 'string') : [];
      return lines.slice(-RESTART_OUTPUT_LINES).map((line) => line.slice(0, RESTART_LINE_CHARS));
    } catch { return []; }
  }

  // Resolves once with the outcome of the first generation after `before`. It is state-driven: the
  // listener re-reads the record after every dispatch, so nothing is missed between the restart and
  // the wait, and every exit path removes the listener, the timers and the abort handler.
  function waitForOutcome(r, { before, settleMs, timeoutMs, signal }) {
    return new Promise((resolve) => {
      let done = false;
      let settling = false;
      let settleTimer = null;
      let timeoutTimer = null;
      const finish = (outcome) => {
        if (done) return;
        done = true;
        r.listeners = r.listeners.filter((fn) => fn !== check);
        if (settleTimer !== null) clearTimer(settleTimer);
        if (timeoutTimer !== null) clearTimer(timeoutTimer);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish('cancelled');
      const onSettled = () => {
        settleTimer = null;
        settling = false;
        const s = r.state;
        if (s.generation > before && (s.state === 'running' || s.state === 'minimized')) finish('running');
        else check();
      };
      function check() {
        if (done) return;
        const s = r.state;
        if (s.generation <= before) {
          // Still the old run stopping, unless a stop cancelled the restart and it came to rest.
          if (isResting(s)) finish('stopped');
          return;
        }
        if (s.state === 'build_failed' || s.state === 'ended_early' || s.state === 'no_window') finish(s.state);
        // Someone stopped the new run (it may be waiting on the program's own question): the restart is over.
        else if (s.state === 'stopping' || s.state === 'close_refused') finish('stopped');
        else if (s.state === 'closed') finish(settling ? 'ended_early' : 'stopped');
        else if (s.state === 'idle') finish('stopped');
        else if ((s.state === 'running' || s.state === 'minimized') && !settling) {
          settling = true;
          settleTimer = setTimer(onSettled, settleMs);
        }
      }
      timeoutTimer = setTimer(() => finish('timeout'), timeoutMs);
      r.listeners.push(check);
      if (signal?.aborted) finish('cancelled');
      else signal?.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  // restart, then wait for the new generation to build, start and show (or fail to show) its window.
  async function restartAndWait({
    projectId, chatId, worktree = null, signal = null, settleMs = RESTART_SETTLE_MS,
    timeoutMs = BUILD_TIMEOUT_MS + RESTART_WAIT_MARGIN_MS,
  }) {
    // Aborted before anything started: nothing to cancel, and a run the owner has up stays up.
    if (signal?.aborted) return { ok: false, outcome: 'cancelled', run: view(projectId) };
    const began = await begin('restart', { projectId, chatId, worktree, signal });
    if (!began.ok) return began;
    // Read from begin's own answer, so another restart during its await is not taken for ours: a live
    // run is still stopping its old generation; a resting one has already begun the new generation.
    const stillStopping = began.run.state === 'stopping' || began.run.state === 'close_refused';
    const before = stillStopping ? began.run.generation : began.run.generation - 1;
    const r = recordOf(projectId);
    const outcome = await waitForOutcome(r, { before, settleMs, timeoutMs, signal });
    if (outcome === 'cancelled') deliver(r, projectId, { type: 'stop', mode: 'force' });
    const run = view(projectId);
    if (outcome === 'running' || outcome === 'no_window') return { ok: true, outcome, run };
    if (outcome === 'build_failed') return { ok: false, outcome, exitCode: run.exitCode, buildTail: run.buildTail, run };
    if (outcome === 'ended_early') {
      return { ok: false, outcome, exitCode: run.exitCode, lines: await endedLines(r.runId), run };
    }
    return { ok: false, outcome, run };
  }

  // The process ids of the project's program and what it started (the helper's run list), kept for livePids().
  // A list that cannot be read falls back to the program's own id; a run that is gone answers nothing.
  async function jobPids(projectId) {
    const r = records.get(projectId);
    const runId = r?.runId;
    if (!runId || isResting(r.state)) return [];
    let pids = pidOk(r.state.pid) ? [r.state.pid] : [];
    try {
      const reply = await host.request('run.list');
      pids = pidsOf(Array.isArray(reply?.runs) ? reply.runs.find((entry) => entry?.run_id === runId) : null, pids);
    } catch (error) {
      warn('run.list failed', error);
    }
    if (r.runId !== runId || isResting(r.state)) return [];
    r.jobPids = pids;
    return pids;
  }

  function stopProject(projectId) {
    const r = records.get(projectId);
    if (!r || isResting(r.state)) return Promise.resolve({ ok: true });
    r.closing = true;
    return new Promise((resolve) => {
      const timer = setTimer(() => {
        r.waiters = r.waiters.filter((w) => w !== finish);
        resolve({ ok: false, reason: 'timeout' });
      }, STOP_WAIT_MS);
      const finish = () => { clearTimer(timer); resolve({ ok: true }); };
      r.waiters.push(finish);
      deliver(r, projectId, { type: 'stop', mode: 'force' });
    });
  }

  async function onProjectDeleted(projectId) {
    await stopProject(projectId);
    const r = records.get(projectId);
    if (r && isResting(r.state)) {
      // A program that ended by itself still has its record (and output) in the helper: release it with the project.
      if (r.runId) host.request('run.stop', { run_id: r.runId, close_timeout_ms: 0 }).catch(() => {});
      records.delete(projectId);
    }
    return commandStore.deleteProject(projectId);
  }

  async function stopAll() {
    await Promise.all([...records.keys()].map((projectId) => stopProject(projectId)));
    return { ok: true };
  }

  function dispose() {
    disposed = true;
    for (const [name, listener] of Object.entries(hostEvents)) host.off(name, listener);
    for (const r of records.values()) clearTimers(r);
  }

  // Public methods answer with { ok: false, reason } instead of throwing.
  const guard = (fn) => async (args) => {
    const input = args && typeof args === 'object' ? args : {};
    if (typeof input.projectId !== 'string' || input.projectId === '') return { ok: false, reason: 'bad_request' };
    try { return await fn(input); } catch (error) {
      warn('request failed', error);
      return { ok: false, reason: 'internal_error' };
    }
  };
  const guardId = (fn) => async (projectId) => {
    try { return await fn(projectId); } catch (error) {
      warn('request failed', error);
      return { ok: false, reason: 'internal_error' };
    }
  };

  return {
    getStatus: guard(getStatus),
    confirmCommand: guard(confirmCommand),
    start: guard((args) => begin('start', args)),
    restart: guard((args) => begin('restart', args)),
    stop: guard(stop),
    showWindow: guard(showWindow),
    armCapture: guard(armCapture),
    output: guard(output),
    look: guard(look),
    restartAndWait: guard(restartAndWait),
    stopProject: guardId(stopProject),
    onProjectDeleted: guardId(onProjectDeleted),
    stopAll: guardId(stopAll),
    // The project's run state name, or null with no record. Synchronous; never starts anything.
    peekState: (projectId) => records.get(projectId)?.state.state ?? null,
    // The process ids of programs running now, for the GPU load check to name them.
    livePids: () => [...new Set([...records.values()].flatMap((r) => [r.state.pid, ...r.jobPids]).filter(pidOk))],
    jobPids, // the program and what it started, read from the helper now (the graphics-memory sample names them)
    // The process id of the project's program now, or null (the graphics-memory sample names it).
    pidOf: (projectId) => {
      const pid = records.get(projectId)?.state.pid;
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    },
    // The project whose live program has this process id, or '' (the GPU refusal's "stop it" offer).
    projectForPid: (pid) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return '';
      for (const [projectId, r] of records) if (r.state.pid === pid || r.jobPids.includes(pid)) return projectId;
      return '';
    },
    dispose,
  };
}

module.exports = { createRunService };
