'use strict';

// Force local means no team networking (row 123, owner decision E64, 2026-11-12). While Force local inference is
// on this PC hosts no team, keeps no connection to a team it joined, shares no GPU and uses no relay; turning it
// off starts again what was running in this app run. Lockdown is per chat and is not this.
//
// This module owns the gate. `held()` is a live read of the mode, asked by every start path: from the moment the
// mode reads on, starts are refused, without waiting for the teardown. Fail closed: a read that throws, a word
// other than `disabled`, or no reader at all is on. The hold and the release run serialized, one pass at a time;
// the settle loop reads the mode before each pass, so on, off, on in quick succession ends in the state the last
// mode asks for. A mode change read while a pass runs moves an epoch, and a pass the epoch moved under is run again
// for the mode now (what started in an off gap is met by another hold). The mode reading on while a pass runs
// interrupts every part at once (a start in flight, a release's own included, ends before the queued hold runs).
// Each pass first asks every part to `announce` its state, so the page learns at the start as well as the end.
// Hold runs every part's `hold` together (the host controller stops its child, the team service stops every
// connection); release runs the host first, then the members. Each step is bounded (a hold HOLD_MS, a release the
// host supervisor's start bound); a hold step that failed or timed out is run again, HOLD_TRIES times in all. What
// to bring back is kept in memory only, by each part (the held teams below; the host's "it was running"): nothing
// about a hold is written.

const { teamFailure } = require('./team-errors');

const OFF = 'disabled';
const REASON = 'team_force_local';
const ORDER = Object.freeze(['host', 'service']);
const HOLD_MS = 15_000;
const RELEASE_MS = 120_000; // host-supervisor.js DEFAULT_BOUNDS.startMs
const HOLD_TRIES = 3;

/** True unless `readMode()` answers exactly `disabled`. */
function forceLocalOn(readMode) {
  if (typeof readMode !== 'function') return true;
  try { return readMode() !== OFF; } catch { return true; }
}

/** The answer a refused call gets while held; the renderer says the owner's state line for its reason. */
function forceLocalFailure() {
  return teamFailure('HOST_STOPPED', REASON);
}

function createForceLocalHold({
  readMode = null, log = () => {}, holdMs = HOLD_MS, releaseMs = RELEASE_MS, timers = { setTimeout, clearTimeout },
} = {}) {
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const parts = new Map();
  // What the parts were last told: nothing runs before the gate exists, so it starts as the mode reads now.
  let applied = forceLocalOn(readMode);
  let lastRead = applied;
  let epoch = 0;
  let running = null;

  const held = () => forceLocalOn(readMode);

  // Reads the mode; a reading unlike the last one moves the epoch.
  function read() {
    const want = held();
    if (want !== lastRead) { lastRead = want; epoch += 1; }
    return want;
  }

  // Calls `name` on every part that has it, synchronously; a throw is logged and the others still run.
  function tellAll(name) {
    for (const [partName, part] of parts) {
      try { part[name]?.(); } catch { say('WARN', 'team.force_local.notify_failed', { part: partName }); }
    }
  }

  // One part's hold or release within its bound; true when it finished.
  async function step(name, want) {
    const part = parts.get(name);
    const run = part && (want ? part.hold : part.release);
    if (typeof run !== 'function') return true;
    let timer = null;
    const limit = new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve('timeout'), want ? holdMs : releaseMs);
      timer?.unref?.();
    });
    let work;
    try { work = Promise.resolve(run()); } catch (error) { work = Promise.reject(error); }
    const outcome = await Promise.race([work.then(() => 'ok', () => 'failed'), limit]);
    timers.clearTimeout(timer);
    if (outcome !== 'ok') say('WARN', outcome === 'timeout' ? 'team.force_local.step_timeout' : 'team.force_local.step_failed', { part: name, hold: want });
    return outcome === 'ok';
  }

  async function holdPart(name) {
    for (let tries = 1; tries <= HOLD_TRIES; tries += 1) {
      if (await step(name, true) || !held()) return;
    }
    say('ERROR', 'team.force_local.hold_failed', { part: name });
  }

  async function settle() {
    let again = false;
    for (;;) {
      const want = read();
      if (want === applied && !again) return;
      applied = want;
      const at = epoch;
      say('INFO', want ? 'team.force_local.hold' : 'team.force_local.release');
      tellAll('announce');
      if (want) await Promise.all(ORDER.map(holdPart));
      else for (const name of ORDER) await step(name, false);
      again = epoch !== at;
    }
  }

  /** The mode may have changed: brings the parts to it (serialized); resolves once they are there. */
  function changed() {
    const want = read();
    if (running) {
      if (want) tellAll('interrupt');
      return running;
    }
    if (want === applied) return Promise.resolve();
    running = settle().finally(() => {
      running = null;
      // A change read between the last check and here is not lost.
      if (read() !== applied) void changed();
    });
    return running;
  }

  return {
    held,
    changed,
    /** `name` is 'host' or 'service'; `part` is { hold, release, interrupt?, announce? }. */
    attach(name, part) { if (ORDER.includes(name)) parts.set(name, part); },
    idle: () => running || Promise.resolve(),
  };
}

/** The teams a hold stopped (or a held launch listed), by id with the name the host gave, in memory only. */
function createHeldTeams() {
  const rows = new Map();
  return {
    note(teamId, name) { rows.set(teamId, typeof name === 'string' ? name : rows.get(teamId) ?? null); },
    has: (teamId) => rows.has(teamId),
    forget: (teamId) => rows.delete(teamId),
    size: () => rows.size,
    take() { const ids = [...rows.keys()]; rows.clear(); return ids; },
    // While held each row says so; during a release that has not reached it yet it is connecting.
    rows: (held) => [...rows].map(([teamId, name]) => ({ team_id: teamId, team_name: name,
      state: held ? 'force_local' : 'connecting', reason: held ? REASON : null })),
  };
}

module.exports = { REASON, createForceLocalHold, createHeldTeams, forceLocalFailure, forceLocalOn };
