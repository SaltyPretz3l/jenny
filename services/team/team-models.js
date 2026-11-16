'use strict';

// The member's model sharing across its teams (row 123 slice 6-5, decision 1; TEAM_MODEL_SHARING_SPEC "6-5 as built"),
// wired into team-service.js like team-projects.js, and itself required by team-service.js only on the first model
// call: nothing loads, reads disk or starts a timer or worker before that call (tests/team-off.test.js). One entry per
// team (model-team.js) is built on the first model call for that team, then told of every connection change;
// `drop(teamId)` (revoked, removed, left, stopped, and Force local through the service's stop of a held team),
// `stopAll()` (app stop) and the injected `isHeld()` gate (E64) end its reads, pushes and receives with no timer,
// worker, socket or listener left (staging kept); an entry being stopped is still counted by `resources()` until its
// stop has ended. One model hasher (one worker at a time) is shared by every sender and receiver of this PC, made on
// first use; a busy answer from it is waited out with a back-off (250 ms doubling to 5 s) until the caller's abort.
//
// The `team_model_sharing` feature flag (decision 8; default on, JENNY_ENABLE_TEAM_MODEL_SHARING=0 off) is read
// through `enabled()`: while off every model method answers `team_model_sharing_off` here and nothing is built or
// sent; the first call still sweeps expired staging under the model roots (R14-F04). Discovery (the late-bound `listLocalGgufs`) and the model roots come from `sources` ({ list(), roots() }),
// read at the moment of each call; one scan runs at a time for all teams and an answer younger than 2 s is reused
// (a received model's lookup asks for a fresh one). A scan that throws, or answers no list, is a failed scan. Pushes go
// out on `team.onModel` (kinds `state`, `progress`, `received`).

const { createModelHasher } = require('./model-hash');
const { createModelReceiver } = require('./model-receive');
const { modelRefusal } = require('./model-reasons');
const { createModelTeam } = require('./model-team');
const { forceLocalFailure } = require('./force-local-hold');

const EMPTY_STATE = Object.freeze({ sharing: 'unknown', sharing_reason: null, online: false, rate_mb_per_second: 0, outgoing: [], incoming: [] });
const SCAN_REUSE_MS = 2000;
const BUSY_MS = 250;
const BUSY_MAX_MS = 5000;
// The start sweep's receiver hashes nothing.
const NO_HASHER = Object.freeze({ hash: async () => { throw Object.assign(new Error('unused'), { code: 'model_hash_failed' }); } });

const abortedError = () => Object.assign(new Error('model_hash_aborted'), { code: 'model_hash_aborted' });

/**
 * A hasher whose `model_hash_busy` answer is retried after a back-off until it is taken or the caller's signal
 * aborts; every other answer passes through. `sleep(ms, signal)` waits (and rejects on the abort).
 */
function busyRetrying(hashOf, { sleep }) {
  return Object.freeze({
    async hash(file, options = {}) {
      for (let tries = 0; ; tries += 1) {
        try {
          return await hashOf().hash(file, options);
        } catch (error) {
          if (options.signal?.aborted) throw abortedError();
          if (error?.code !== 'model_hash_busy') throw error;
        }
        try { await sleep(Math.min(BUSY_MS * (2 ** Math.min(tries, 8)), BUSY_MAX_MS), options.signal); } catch { throw abortedError(); }
      }
    },
  });
}

/**
 * deps: `userDataPath`, `managerOf(teamId)` (the team's live connection manager or null), `sources` ({ list(), roots() }),
 * `enabled()`, `isHeld()`, `push(payload)`, `log`, `timers`, `clock`, `options` (test seams: part size, receive limits).
 */
function createTeamModels({
  userDataPath, managerOf, sources, enabled = () => true, isHeld = () => false, push = () => {}, log = () => {},
  timers, clock = Date.now, options = {},
}) {
  const teams = new Map(); // team id -> model team
  const stopping = new Set(); // entries whose stop has not ended yet
  const sleeps = new Set(); // busy back-offs waiting
  let hasher = null;
  let stopped = false;
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const send = (payload) => { if (!stopped) { try { push(payload); } catch { say('WARN', 'team.model.push_failed'); } } };
  const setTimer = timers?.setTimeout ?? setTimeout;
  const clearTimer = timers?.clearTimeout ?? clearTimeout;

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (stopped || signal?.aborted) { reject(abortedError()); return; }
      const entry = { done: null };
      const finish = (error) => { sleeps.delete(entry); clearTimer(entry.handle); signal?.removeEventListener('abort', onAbort); if (error) reject(error); else resolve(); };
      const onAbort = () => finish(abortedError());
      entry.done = () => finish(abortedError());
      entry.handle = setTimer(() => finish(null), ms);
      entry.handle?.unref?.();
      sleeps.add(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // The hasher is made when a file is first read, not when a team is built.
  const lazyHasher = busyRetrying(() => {
    hasher ??= createModelHasher({ logger: say });
    return hasher;
  }, { sleep });

  // Discovery and roots are late-bound: the engine handlers register after the team service. One scan at a time.
  let scan = null;
  let scanned = null; // { at, list }
  function discovery({ fresh = false } = {}) {
    if (!fresh && scanned && clock() - scanned.at < SCAN_REUSE_MS && clock() >= scanned.at) return Promise.resolve(scanned.list);
    scan ??= Promise.resolve().then(() => sources?.list?.()).then((list) => {
      if (!Array.isArray(list)) throw new Error('scan_failed');
      scanned = { at: clock(), list };
      return list;
    }).finally(() => { scan = null; });
    return scan;
  }
  const roots = () => {
    let listed;
    try { listed = sources?.roots?.(); } catch { listed = null; }
    return Array.isArray(listed) ? listed.filter((root) => typeof root?.path === 'string' && typeof root.display === 'string') : [];
  };

  function build(teamId, manager) {
    const team = createModelTeam({
      teamId, manager, userDataPath, discovery, roots, hasher: lazyHasher, isHeld, push: send, log: say, clock,
      ...(timers ? { timers } : {}), options,
    });
    teams.set(teamId, team);
    team.start();
    return team;
  }
  async function end(teamId, team) {
    if (teams.get(teamId) === team) teams.delete(teamId);
    stopping.add(team);
    try { await team.stop(); } finally { stopping.delete(team); }
    send({ kind: 'state', team_id: teamId, ...EMPTY_STATE });
  }

  /** A team's connection changed: an entry follows its manager; a new manager or a revoked team ends it. */
  function connectionChanged(teamId, manager) {
    const team = teams.get(teamId);
    if (!team || stopped) return;
    let state;
    try { state = manager?.snapshot().state; } catch { state = null; }
    if (team.manager !== manager || state === 'revoked') { void end(teamId, team); return; }
    team.connectionChanged();
  }

  function drop(teamId) {
    const team = teams.get(teamId);
    if (team) void end(teamId, team);
  }

  // The 7-day sweep of every configured root's staging belongs to the roots, not to a team entry (R14-F04): once per
  // app run, on the first model call of any kind, before the switch and team checks, so staging of a team left,
  // revoked or turned off still goes. A receiver with no transfer in hand runs it; stopAll waits for it.
  let swept = null;
  function sweepOnce() {
    swept ??= Promise.resolve().then(() => createModelReceiver({
      roots: () => roots().map((root) => root.path), transport: {}, hasher: NO_HASHER, clock, logger: say,
    }).sweep(clock())).catch(() => say('WARN', 'team.model.sweep_failed'));
  }

  async function call(method, value) {
    if (!stopped) sweepOnce();
    if (!enabled()) return modelRefusal('team_model_sharing_off');
    if (isHeld()) return forceLocalFailure();
    if (stopped) return modelRefusal('team_disposed');
    const manager = managerOf(value.team_id);
    if (!manager) return modelRefusal('team_not_found');
    let team = teams.get(value.team_id);
    if (team && team.manager !== manager) { await end(value.team_id, team); team = null; }
    team ??= build(value.team_id, manager);
    return team.call(method, value);
  }

  async function stopAll() {
    stopped = true;
    const all = [...teams.values()];
    teams.clear();
    for (const entry of [...sleeps]) entry.done();
    await Promise.allSettled([...all.map((team) => team.stop()), ...[...stopping].map((team) => team.stop()), swept]);
    if (hasher) { await Promise.resolve(hasher.dispose()).catch(() => {}); }
  }

  return Object.freeze({
    call, connectionChanged, drop, stopAll,
    resources() {
      const totals = { teams: teams.size, stopping: stopping.size, pushes: 0, reads: 0, handles: 0, receiving: 0, timers: sleeps.size,
        waits: 0, listeners: 0, connecting: 0 };
      for (const team of [...teams.values(), ...stopping]) {
        for (const [key, value] of Object.entries(team.resources())) totals[key] += value;
      }
      const hashing = hasher?.resources() || { running: 0, queued: 0, worker: false };
      return { ...totals, hashing: hashing.running + hashing.queued, workers: hashing.worker ? 1 : 0 };
    },
  });
}

module.exports = { busyRetrying, createTeamModels };
