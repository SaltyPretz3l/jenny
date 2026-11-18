'use strict';

// The member's node agent (row 123 slice 4c agent; spec "Node side (N9)" and "4c agent
// as built"): it registers this PC with the team host, runs one claim loop per slot
// and runs each claimed job on the PC's own engine (engine-forward.js). Every effect is
// injected: the team calls (`link`, see node-link.js), the engine URL and client, the
// member's own-work check, the clocks, the timers and the logger. Slice 4e builds it
// from the "Share this PC's GPU" setting (team-sharing.js), which passes `seqFloor`, the
// saved high-water mark of claim numbers, and reads `seq` and `models` from status().
//
// The member's own work wins: no claim is made while `isBusy()` holds, polled every
// second; a running job finishes. The host is told with a pause, repeated each heartbeat
// while the work lasts and lifted after it (R16-F02). A claimed job is never retried or sent again.

const {
  FINAL_REASONS, checkEngineUrl, createEngineClient, jobLimits, readModels, reasonWord, startJob,
} = require('./engine-forward');
const { JOB_ID } = require('./node-link');
const { isNodeId } = require('../../../server/team/scheduler/state');

// Must equal server/team/node-commands.js NODE_PROTOCOL_VERSION (the team protocol
// version in team-session.js is shared the same way); a test pins it.
const NODE_PROTOCOL_VERSION = 1;
const MAX_SLOTS = 4;
const DEFAULT_ENGINE = Object.freeze({ kind: 'openai-compatible', version: 'unknown' });
const ENGINE_TEXT = /^[\x21-\x7e][\x20-\x7e]{0,63}$/u;

// The host holds a claim up to 25 s; the call waits 10 s longer for its answer.
const CLAIM_WAIT_MS = 25_000;
const CLAIM_TIMEOUT_MS = CLAIM_WAIT_MS + 10_000;
const COMMAND_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
const BUSY_POLL_MS = 1_000;
const BUSY_RETRY_MS = 5_000; // between tries of a pause the host did not take
const PAUSED_SLEEP_MS = 60_000;
// Pacing under the host's 60 claims and reads a minute a slot, by construction: the
// arithmetic is in the spec, "4c agent as built", Claims.
const PACE_WINDOW_MS = 60_000;
const PACE_PER_SLOT = 50;
const MIN_CLAIM_GAP_MS = 1_000;
const CLAIM_RATE_WAIT_MS = 10_000;
// Backoff for a lost answer or a refusal that may pass: 1 s doubling to 30 s (claims) or
// 60 s (register), until stop().
const BACKOFF_START_MS = 1_000;
const CLAIM_BACKOFF_MAX_MS = 30_000;
const REGISTER_BACKOFF_MAX_MS = 60_000;
const HEARTBEAT_MIN_MS = 1_000;
const HEARTBEAT_MAX_MS = 60_000;

// The agent's states; every move not listed is refused and changes nothing.
const STATE_TRANSITIONS = Object.freeze({
  off: Object.freeze({ start: 'starting' }),
  starting: Object.freeze({ registered: 'idle', final: 'off', stop: 'stopping' }),
  idle: Object.freeze({ busy: 'busy_own', pause: 'paused', stop: 'stopping', final: 'stopping' }),
  busy_own: Object.freeze({ free: 'idle', pause: 'paused', stop: 'stopping', final: 'stopping' }),
  paused: Object.freeze({ pause: 'paused', resume: 'idle', stop: 'stopping', final: 'stopping' }),
  stopping: Object.freeze({ stopped: 'off' }),
});
const nextState = (state, event) => (Object.hasOwn(STATE_TRANSITIONS, state) ? STATE_TRANSITIONS[state][event] ?? null : null);
const refusedCall = () => ({ ok: false, reason: 'node_agent_state' });
const CAPABILITIES_TIMEOUT_MS = 3_000;

// The engine's rows with what the member's Jenny says each model can do: `capabilities` maps a model name to
// `{ vision, thinking }`; only a literal `true` turns one on, and a model it does not name keeps the engine's row.
function withCapabilities(models, capabilities) {
  if (!(capabilities instanceof Map) || capabilities.size === 0) return models;
  return models.map((entry) => {
    const known = capabilities.get(entry.name);
    if (!known || typeof known !== 'object') return entry;
    return { ...entry, vision: known.vision === true, thinking: known.thinking === true };
  });
}

function createNodeAgent({
  link, resolveEngineUrl, engine = createEngineClient(), isBusy, slots = 1, engineInfo = DEFAULT_ENGINE,
  timers = { setTimeout, clearTimeout }, now = Date.now, clock = () => performance.now(), logger = null,
  protocolVersion = NODE_PROTOCOL_VERSION, seqFloor = 0, readCapabilities = null,
} = {}) {
  if (!link || !['command', 'fetchRequest', 'postChunk'].every((name) => typeof link[name] === 'function')) {
    throw new TypeError('The node agent needs a team link.');
  }
  if (typeof resolveEngineUrl !== 'function') throw new TypeError('The node agent needs an engine URL resolver.');
  if (typeof isBusy !== 'function') throw new TypeError('The node agent needs the member\'s own-work check.');
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > MAX_SLOTS) throw new RangeError(`slots must be from 1 to ${MAX_SLOTS}.`);
  if (!ENGINE_TEXT.test(String(engineInfo?.kind)) || !ENGINE_TEXT.test(String(engineInfo?.version))) {
    throw new TypeError('engineInfo needs a printable kind and version.');
  }
  const log = (level, event, fields) => {
    if (typeof logger !== 'function') return;
    try { logger(level, event, fields); } catch (_error) { /* a logger never breaks the agent */ }
  };
  let state = 'off';
  let reason = null;
  let gen = 0;
  let target = null;
  let nodeId = null;
  let heartbeatMs = 10_000;
  let loopAbort = null; // register and claim calls of this run
  let stopAbort = null; // the fail and unregister calls of stop()
  let reRegistering = null;
  let teamCalls = 0;
  let seqNext = 0;
  let offered = []; // the model names the last register sent
  let busyTold = false; // the host holds this PC paused for the member's own work (R16-F02)
  const live = new Set();
  const sleepers = new Set();
  const jobs = new Map();
  const paced = [];

  const tracked = {
    setTimeout(fn, ms) {
      const handle = timers.setTimeout(() => { live.delete(handle); fn(); }, ms);
      handle?.unref?.();
      live.add(handle);
      return handle;
    },
    clearTimeout(handle) { if (handle !== null && handle !== undefined) { timers.clearTimeout(handle); live.delete(handle); } },
  };
  const counted = (fn) => async (...args) => { teamCalls += 1; try { return await fn(...args); } finally { teamCalls -= 1; } };
  const team = { command: counted(link.command), fetchRequest: counted(link.fetchRequest), postChunk: counted(link.postChunk) };

  function move(event) {
    const to = nextState(state, event);
    if (!to) return false;
    state = to;
    log('INFO', 'team.node.state', { state });
    return true;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const sleeper = { resolve, timer: null };
      sleeper.timer = tracked.setTimeout(() => { sleepers.delete(sleeper); resolve(); }, ms);
      sleepers.add(sleeper);
    });
  }
  function wakeAll() {
    for (const sleeper of [...sleepers]) { sleepers.delete(sleeper); tracked.clearTimeout(sleeper.timer); sleeper.resolve(); }
  }

  const command = (operation, params, timeoutMs = COMMAND_TIMEOUT_MS, signal = loopAbort?.signal) => team.command(operation,
    params, { timeoutMs, signal });
  // The member's own work: a check that throws counts as busy.
  function busyNow() {
    try { return isBusy() !== false; } catch (_error) { return true; }
  }

  // ----------------------------------------------------------------- register

  // The member's own Jenny knows what each local model can do (Ollama reports vision and thinking); the engine's
  // `/v1/models` does not say. A read that fails, answers nothing usable or takes longer than the bound leaves every
  // model at no vision and no thinking, as before: the host drops what a model does not claim.
  async function capabilitiesNow() {
    if (typeof readCapabilities !== 'function') return null;
    let bound = null;
    try {
      return await Promise.race([Promise.resolve(readCapabilities()).catch(() => null),
        new Promise((resolve) => { bound = tracked.setTimeout(() => resolve(null), CAPABILITIES_TIMEOUT_MS); })]);
    } catch (_error) {
      return null;
    } finally {
      tracked.clearTimeout(bound);
    }
  }

  // A run that ended (stop, then start at once) writes nothing into the next run.
  async function registerOnce(run) {
    const { signal } = loopAbort;
    const gone = { ok: false, reason: 'node_agent_stopped' };
    const read = await readModels({ engine, target, timers: tracked, signal });
    if (run !== gen) return gone;
    if (!read.ok) return { ok: false, reason: read.reason };
    if (read.models.length === 0) return { ok: false, reason: 'engine_no_models' };
    const models = withCapabilities(read.models, await capabilitiesNow());
    if (run !== gen) return gone;
    let answer;
    try {
      answer = await command('team.node.register', { protocol_version: protocolVersion,
        engine: { kind: engineInfo.kind, version: engineInfo.version }, slots, models },
      COMMAND_TIMEOUT_MS, signal);
    } catch (_error) {
      return run === gen ? { ok: false, reason: 'team_unreachable' } : gone;
    }
    if (run !== gen) return gone;
    if (answer?.ok === true && isNodeId(answer.node_id)) {
      nodeId = answer.node_id;
      offered = read.models.map((entry) => entry.name);
      const beat = Number.isSafeInteger(answer.heartbeat_ms) ? answer.heartbeat_ms : 10_000;
      heartbeatMs = Math.min(HEARTBEAT_MAX_MS, Math.max(HEARTBEAT_MIN_MS, beat));
      log('INFO', 'team.node.registered', { slots, models: models.length,
        thinking: models.filter((entry) => entry.thinking).length, vision: models.filter((entry) => entry.vision).length });
      return { ok: true };
    }
    const word = reasonWord(answer, 'team_refused');
    return { ok: false, reason: word, final: word === 'node_version_mismatch' || FINAL_REASONS.has(word) };
  }

  async function registerUntilDone(run) {
    let delay = BACKOFF_START_MS;
    while (run === gen && state !== 'stopping' && state !== 'off') {
      const result = await registerOnce(run);
      if (run !== gen) return { ok: false };
      if (result.ok) return result;
      // One line for a streak of the same refusal: a host with no pool yet answers every minute.
      if (result.reason !== reason) log('INFO', 'team.node.register_retry', { reason: result.reason, wait_ms: delay });
      reason = result.reason;
      if (result.final) { endSharing(result.reason); return result; }
      await sleep(delay);
      delay = Math.min(delay * 2, REGISTER_BACKOFF_MAX_MS);
    }
    return { ok: false };
  }

  // The host forgot the node: one register for every slot, then claims carry on.
  function reRegister(run) {
    if (!reRegistering) {
      nodeId = null;
      reRegistering = registerUntilDone(run).finally(() => { reRegistering = null; });
    }
    return reRegistering;
  }

  // ----------------------------------------------------------------- claims

  function paceWait() {
    const at = clock();
    while (paced.length > 0 && at - paced[0] >= PACE_WINDOW_MS) paced.shift();
    return paced.length < PACE_PER_SLOT * slots ? 0 : Math.max(1, paced[0] + PACE_WINDOW_MS - at);
  }
  function nextSeq() {
    const seq = seqNext;
    seqNext += 1;
    return seq;
  }

  async function runJob(descriptor) {
    const limits = jobLimits(descriptor);
    if (!limits) {
      log('WARN', 'team.node.job_refused', {});
      if (JOB_ID.test(String(descriptor?.job_id))) {
        await command('team.node.fail', { job_id: descriptor.job_id, reason: 'engine_error' }).catch(() => {});
      }
      return;
    }
    // R16-F01: only a model this PC offered at its last register; nothing is read for any other.
    if (!offered.includes(descriptor.model)) {
      log('WARN', 'team.node.job_refused', { reason: 'model_not_offered' });
      await command('team.node.fail', { job_id: descriptor.job_id, reason: 'model_not_loaded' }).catch(() => {});
      return;
    }
    const handle = startJob({ descriptor, limits, link: team, engine, target, timers: tracked, clock, heartbeatMs, log,
      onRequestRead: () => paced.push(clock()), onFinal: (word) => endSharing(word) });
    jobs.set(handle.jobId, handle);
    await handle.done;
    jobs.delete(handle.jobId);
  }

  // A job a waiting claim brought back after the member became busy, paused or stopped is
  // not run: no request read, no engine byte, one fail (the protocol has no give-back).
  // After stop() it goes out only while stop() still talks to the host; dispose() sends nothing.
  // R16-F02: for the member's own work the word is node_busy, which excludes this PC from nothing.
  async function giveBack(descriptor, run, word = 'user_stopped_sharing') {
    log('INFO', 'team.node.job_given_back', { reason: word });
    if (!JOB_ID.test(String(descriptor?.job_id))) return;
    const signal = run === gen ? loopAbort?.signal : (state === 'stopping' ? stopAbort?.signal : null);
    if (!signal || signal.aborted) return;
    await command('team.node.fail', { job_id: descriptor.job_id, reason: word }, STOP_TIMEOUT_MS, signal)
      .catch(() => {});
  }

  // R16-F02: the member's own work, told to the host. Polled every second for the run: on the move to
  // busy_own the host is sent a pause at once (no new job is leased to this PC) and again each heartbeat
  // while it lasts, which keeps the node in contact; once the work ends the pause is lifted. A send that
  // fails is tried again after BUSY_RETRY_MS. A pause the member set (`paused`) is left to pause().
  // E76: this pause names no `stop_running`, and the host reads that as "in use by its owner"; pause() always names it.
  async function busyWatch(run) {
    let toldAt = null;
    while (run === gen && ['idle', 'busy_own', 'paused'].includes(state)) {
      if (state === 'idle' && busyNow()) { move('busy'); toldAt = null; } else if (state === 'busy_own' && !busyNow()) move('free');
      if (state === 'busy_own' && (toldAt === null || clock() - toldAt >= (busyTold ? heartbeatMs : Math.min(heartbeatMs, BUSY_RETRY_MS)))) {
        toldAt = clock();
        busyTold = (await sendQuietly('team.node.pause', { on: true })) || busyTold;
      } else if (state === 'idle' && busyTold && await sendQuietly('team.node.pause', { on: false })) busyTold = false;
      if (run !== gen) return;
      await sleep(BUSY_POLL_MS);
    }
  }

  async function slotLoop(run) {
    let delay = BACKOFF_START_MS;
    let pending = null; // the number of a claim whose answer was lost: asked again as it is
    while (run === gen) {
      if (state === 'paused') { await sleep(PAUSED_SLEEP_MS); continue; }
      if (state !== 'idle' && state !== 'busy_own') return;
      if (reRegistering) { await reRegistering; continue; }
      // busyWatch() moves between idle and busy_own and tells the host; a slot claims only when idle and free.
      if (state === 'busy_own' || busyNow()) { await sleep(BUSY_POLL_MS); continue; }
      const wait = paceWait();
      if (wait > 0) { await sleep(wait); continue; }
      const seq = pending ?? nextSeq();
      paced.push(clock());
      const startedAt = clock();
      let answer;
      try {
        answer = await command('team.node.claim', { claim_seq: seq, wait_ms: CLAIM_WAIT_MS }, CLAIM_TIMEOUT_MS);
      } catch (_error) {
        if (run !== gen) return;
        pending = seq;
        await sleep(delay);
        delay = Math.min(delay * 2, CLAIM_BACKOFF_MAX_MS);
        continue;
      }
      if (run !== gen) { if (answer?.job) await giveBack(answer.job, run); return; }
      pending = null;
      if (answer?.ok !== true) {
        const word = reasonWord(answer, 'claim_refused');
        if (FINAL_REASONS.has(word)) { endSharing(word); return; }
        reason = word;
        await sleep(word === 'node_rate_limit' ? CLAIM_RATE_WAIT_MS : delay);
        delay = Math.min(delay * 2, CLAIM_BACKOFF_MAX_MS);
        if (word === 'node_not_found' && run === gen) await reRegister(run);
        continue;
      }
      delay = BACKOFF_START_MS;
      if (answer.job) {
        // Checked again: the claim may have waited 25 s at the host.
        const ownWork = state === 'busy_own' || (state === 'idle' && busyNow());
        if (state !== 'idle' || busyNow()) await giveBack(answer.job, run, ownWork ? 'node_busy' : undefined);
        else await runJob(answer.job);
        continue;
      }
      const gap = MIN_CLAIM_GAP_MS - (clock() - startedAt);
      if (gap > 0) await sleep(gap);
    }
  }

  // ----------------------------------------------------------------- ending

  function cleanup() {
    loopAbort?.abort();
    wakeAll();
    for (const handle of live) timers.clearTimeout(handle);
    live.clear();
    jobs.clear();
    paced.length = 0;
    nodeId = null;
    target = null;
    busyTold = false;
  }

  // The member may no longer share (or the host speaks another version): running jobs are
  // cut without a word to the host, nothing more is sent, and the agent ends `off`.
  function endSharing(word) {
    reason = word;
    log('INFO', 'team.node.sharing_ended', { reason: word });
    if (state === 'starting') { move('final'); gen += 1; cleanup(); return; }
    if (!move('final')) return;
    gen += 1;
    for (const handle of [...jobs.values()]) handle.stop({ quiet: true });
    move('stopped');
    cleanup();
  }

  // Ends every running job with user_stopped_sharing, the `fail` calls bounded in time.
  async function stopJobs() {
    const handles = [...jobs.values()];
    if (handles.length === 0) return;
    let bound = null;
    await Promise.race([Promise.all(handles.map((handle) => handle.stop())),
      new Promise((resolve) => { bound = tracked.setTimeout(resolve, STOP_TIMEOUT_MS); })]);
    tracked.clearTimeout(bound);
    for (const handle of handles) handle.abortFail();
  }

  // ----------------------------------------------------------------- the surface

  async function start() {
    if (state !== 'off') return { ok: false, reason: 'node_agent_running' };
    move('start');
    reason = null;
    gen += 1;
    const run = gen;
    loopAbort = new AbortController();
    let url;
    try { url = resolveEngineUrl(); } catch (_error) { url = null; }
    const checked = checkEngineUrl(url);
    if (!checked.ok) { endSharing(checked.reason); return { ok: false, reason: checked.reason }; }
    target = checked;
    // Past every number an earlier run of this process used, and past the wall clock: a
    // restarted agent never repeats a claim_seq the host may still hold for this node.
    seqNext = Math.max(Math.trunc(Number(now()) || 0), seqNext, Number.isSafeInteger(seqFloor) && seqFloor > 0 ? seqFloor : 0);
    const outcome = await registerUntilDone(run);
    if (!outcome.ok || run !== gen || !move('registered')) return { ok: false, reason: reason || 'node_agent_stopped' };
    for (let slot = 0; slot < slots; slot += 1) slotLoop(run).catch(() => log('WARN', 'team.node.loop_failed', {}));
    busyWatch(run).catch(() => log('WARN', 'team.node.loop_failed', {}));
    return { ok: true };
  }

  async function pause({ on, stopRunning = false } = {}) {
    if (on === true) {
      if (!move('pause')) return refusedCall();
      if (stopRunning === true) await stopJobs();
      await sendQuietly('team.node.pause', { on: true, stop_running: stopRunning === true });
      return { ok: true };
    }
    if (on !== false || !move('resume')) return refusedCall();
    busyTold = false; // this lifts any pause at the host; busyWatch() tells it again if the member is busy
    wakeAll();
    await sendQuietly('team.node.pause', { on: false });
    return { ok: true };
  }

  // True when the host answered ok.
  async function sendQuietly(operation, params) {
    let answer;
    try { answer = await command(operation, params); } catch (_error) { return false; }
    const word = reasonWord(answer, '');
    if (answer?.ok !== true && FINAL_REASONS.has(word)) endSharing(word);
    return answer?.ok === true;
  }

  async function stop() {
    if (!move('stop')) return refusedCall();
    gen += 1;
    loopAbort?.abort();
    wakeAll();
    stopAbort = new AbortController();
    const { signal } = stopAbort;
    await stopJobs();
    if (nodeId && !signal.aborted) {
      await team.command('team.node.unregister', {}, { timeoutMs: STOP_TIMEOUT_MS, signal }).catch(() => {});
    }
    if (state === 'stopping') { reason = 'stopped'; move('stopped'); cleanup(); }
    stopAbort = null;
    return { ok: true };
  }

  // stop() without waiting on the host: nothing more is sent, everything ends now.
  function dispose() {
    if (state !== 'off') {
      if (state !== 'stopping') move('stop');
      gen += 1;
      stopAbort?.abort();
      for (const handle of [...jobs.values()]) handle.stop({ quiet: true });
      reason = 'disposed';
      move('stopped');
    }
    cleanup();
  }

  return Object.freeze({
    start,
    pause,
    stop,
    dispose,
    // The state, the slots, the running jobs (a count), the last reason word, the next claim number
    // and the model names the last register offered (names only).
    status: () => ({ state, slots, jobs: jobs.size, reason, seq: seqNext, models: [...offered], node_id: nodeId }),
    resources: () => ({ timers: live.size, sleepers: sleepers.size, teamCalls, engineRequests: engine.openRequests() }),
  });
}

module.exports = { NODE_PROTOCOL_VERSION, STATE_TRANSITIONS, createNodeAgent, nextState };
