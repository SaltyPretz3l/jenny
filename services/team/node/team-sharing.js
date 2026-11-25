'use strict';

// "Share this PC's GPU" for this Jenny (row 123 slice 4e; spec "4e as built"). At most one
// team shares at a time: this module builds that team's node agent (node-agent.js) with the
// team's own connection as its link (team-link.js), this PC's local engine (local-engine.js,
// read once per look) and the member's own-work check, and turns the agent's state into the
// one state the Settings page draws:
//   off (null), starting, host_not_ready (the host has no shared GPUs yet: retried at the
//   agent's pace), team_offline (with the team's connection state), idle (sharing, nobody's
//   request), serving (since when), busy_own (the member's own chat runs), paused, no_model
//   (no local model runs: the agent is not running).
//
// What is saved (sharing-file.js, its own file beside the client file, one atomic write each):
// whether sharing is on for the team and the claim number mark. Before the agent starts the mark
// moves `markBlock` past max(now, the saved mark) and must be on disk: claims start at the old
// floor, so a restart starts above every number used before even when the clock stepped back.
// While sharing, the mark moves `markBlock` past the next claim number once that number comes
// within `markMargin` of it. The agent has one slot and makes at most 50 claims a minute, so a
// move comes every 8,000 claims: at most one write per 160 minutes at full rate and about one per
// 55 hours idle (a waiting claim lasts 25 s). A save that fails is tried again after 1 s,
// doubling to a minute, logged once per failure streak; meanwhile no agent starts, and a running
// one stops before its claim numbers come within a quarter margin of the mark on disk.
// A saved mark of 0 means the sharer's notice was never confirmed for the team, so the first switch
// on asks for it (`team_share_confirm_needed`); confirming saves a mark of at least 1.
// Nothing else is saved: no prompt, reply, job, URL or key; and, once the sharer chose them, the names of the
// Ollama models this PC shares (`ollama_models`; absent means the default share set, share-set.js).
//
// The engine (row 201): it is the configured local engine whatever the owner's chat runs on (local-engine.js), so a
// cloud or team chat leaves an idle local GPU registered; busy_own shows only while a chat that can use the local
// engine runs. While idle the agent's offer is read again every REFRESH_MS (`/v1/models` and the capabilities) and the
// agent restarts, through stop and a new register, only when the offer changed. A switch or stop of the local engine
// while requests run pauses the agent (no new claim) until they end, then it registers against the new engine.
//
// Lifecycle: sharing starts when its team is online and active, resumes at the next launch when
// it was on, and ends when the team is left, removed or revoked, when its connection ends for
// good (revoked, update_required), and at app stop (stopAll gives the agent's own stop 3 s, then
// disposes it). A second team's switch while one shares answers `node_agent_running`; a second
// team found saved as on (after a crash) is turned off when it comes online. A final refusal from
// the host (member_revoked, role_forbidden, member_pending, team_connection_stopped,
// node_version_mismatch) turns the setting off. Logs carry team ids, states and reason words only.

const http = require('node:http');

const { FINAL_REASONS, checkEngineUrl, createEngineClient, readModels } = require('./engine-forward');
const { createNodeAgent } = require('./node-agent');
const { createTeamLink } = require('./team-link');
const { ownInferenceUsesLocalEngine, readModelCapabilities, resolveLocalEngine } = require('./local-engine');
const { createOllamaShareSet, createShareClient, modelSignature } = require('./share-set');
const { cleanShareSet, loadSharing, saveSharing } = require('./sharing-file');

const LOOK_MS = 1000;
const STOP_BOUND_MS = 12_000; // the agent's own stop: running jobs' fails (5 s), then unregister (5 s)
const QUIT_BOUND_MS = 3_000; // at app stop: the connections close next
const SAVE_RETRY_START_MS = 1000;
const SAVE_RETRY_MAX_MS = 60_000;
const MARK_BLOCK = 10_000;
const MARK_MARGIN = 2_000;
const REFRESH_MS = 45_000; // how often an idle offer is read again (30 to 60 s)
const CAPABILITIES_BOUND_MS = 3_000;
const ENDED = new Set(['revoked', 'update_required']);
const ENGINE_REASONS = new Set(['engine_unreachable', 'engine_error', 'engine_no_models', 'node_engine_not_local']);

function refusal(reason) {
  return { ok: false, error: { code: 'invalid_request', reason } };
}

// Sends the managed server's key with every engine request, to the agent's own target only.
function keyedRequest(key) {
  return (options, ...rest) => http.request({ ...options, headers: { ...options.headers, Authorization: `Bearer ${key}` } }, ...rest);
}

// The capabilities of the engine that is shared: Ollama's list or the openai-compatible one (a cloud chat's own engine is not it).
const defaultReadCapabilities = (backend, forEngine) => readModelCapabilities(backend, undefined, forEngine);
const capabilitiesEngine = (engine) => (engine.kind === 'Ollama' ? 'ollama' : 'openai-compatible');

function createTeamSharing({
  userDataPath, getBackend = () => null, isBusy = () => false, log = () => {}, now = Date.now,
  timers = { setTimeout, clearTimeout }, createAgent = createNodeAgent, resolveEngine = resolveLocalEngine,
  readCapabilities = defaultReadCapabilities, load = loadSharing, save = saveSharing, markBlock = MARK_BLOCK, markMargin = MARK_MARGIN,
} = {}) {
  const managers = new Map(); // team id -> connection manager
  let wanted = null; // the team whose setting is on: { teamId, mark (the mark on disk), ollamaModels (the chosen share set or null) }
  // { teamId, agent, engine: { url, kind, key }, since, after, client, draining, probing, probedAt, baseline, probeAbort }
  let active = null;
  let failedUrl = null; // an engine URL the agent refused as not local: not tried again until it changes
  let seenEngine = null; // the engine the last look resolved
  let lookTimer = null;
  let onChange = () => {};
  let lastShown = 'null';
  let stopped = false;
  let lookFailing = false;
  const saves = { timer: null, delay: SAVE_RETRY_START_MS, failing: false }; // the save backoff
  const checked = new Set(); // teams whose saved setting was read this run
  const refusedFiles = new Set(); // teams whose sharing file failed a rule (logged once)
  const ending = new Set();
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };

  function loaded(teamId) {
    let saved;
    try { saved = load(userDataPath, teamId); } catch { saved = { ok: false, reason: 'team_sharing_invalid' }; }
    if (saved?.ok && saved.bad && !refusedFiles.has(teamId)) {
      refusedFiles.add(teamId);
      say('WARN', 'team.sharing.file_refused', { team_id: teamId });
    }
    return saved;
  }

  // One write. A failure starts (or lengthens) the backoff; no save is tried again before it ends.
  function persist(teamId, on, mark) {
    let saved;
    try { saved = save(userDataPath, teamId, { on, claim_seq: mark }); } catch { saved = null; }
    if (saved?.ok === true) {
      saves.failing = false;
      saves.delay = SAVE_RETRY_START_MS;
      return true;
    }
    if (!saves.failing) say('WARN', 'team.sharing.save_failed', { team_id: teamId, reason: saved?.reason || 'none' });
    saves.failing = true;
    if (saves.timer === null) {
      saves.timer = timers.setTimeout(() => { saves.timer = null; look(); }, saves.delay);
      saves.timer?.unref?.();
    }
    saves.delay = Math.min(saves.delay * 2, SAVE_RETRY_MAX_MS);
    return false;
  }
  const mayPersist = () => saves.timer === null;

  function engineNow() {
    let engine;
    try { engine = resolveEngine(getBackend()); } catch { engine = null; }
    return engine && typeof engine.url === 'string' && engine.url ? engine : null;
  }

  // The owner's own work for the agent: a chat stream that cannot be using this PC's engine (cloud, a team model) is not it.
  function ownBusy() {
    const streaming = isBusy();
    return streaming === false ? false : ownInferenceUsesLocalEngine(getBackend());
  }

  // The Ollama share set (share-set.js): the sharer's choice, else the owner's current Ollama model, else the loaded ones.
  function engineClientFor(engine) {
    const base = createEngineClient({ request: engine.key ? keyedRequest(engine.key) : http.request });
    if (engine.kind !== 'Ollama') return base;
    const current = () => {
      const backend = getBackend();
      return backend && String(backend.currentEngineType || '').trim().toLowerCase() === 'ollama' ? String(backend.currentModel || '') : '';
    };
    return createShareClient({ base, allowed: createOllamaShareSet({ base, chosen: () => wanted?.ollamaModels ?? null, current }) });
  }

  function rowOf(teamId) {
    try { return managers.get(teamId)?.snapshot() || null; } catch { return null; }
  }
  const isReady = (row) => row?.state === 'online' && row.member_state === 'active';

  // ------------------------------------------------------------ the state

  function stateOf() {
    if (!wanted) return null;
    const base = { team_id: wanted.teamId, serving_since: null, models: [], engine: null, node_id: null };
    const row = rowOf(wanted.teamId);
    if (!isReady(row)) return { ...base, state: 'team_offline', connection: typeof row?.state === 'string' ? row.state : 'offline' };
    if (!active || active.after) {
      return { ...base, state: !seenEngine || seenEngine.url === failedUrl ? 'no_model' : 'starting' };
    }
    const status = active.agent.status();
    const shown = { ...base, models: Array.isArray(status.models) ? status.models.slice(0, 64) : [], engine: active.engine.kind,
      node_id: typeof status.node_id === 'string' ? status.node_id : null };
    if (status.state === 'starting') {
      if (ENGINE_REASONS.has(status.reason)) return { ...base, state: 'no_model' };
      return { ...base, state: status.reason === 'team_pool_unavailable' ? 'host_not_ready' : 'starting' };
    }
    if (status.state === 'paused') return { ...shown, state: 'paused' };
    // The one place the serving clock is set: the first look at a running request starts it.
    active.since = status.jobs > 0 ? active.since ?? now() : null;
    if (status.jobs > 0) return { ...shown, state: 'serving', serving_since: active.since };
    if (status.state === 'busy_own' || status.state === 'idle') return { ...shown, state: status.state };
    return { ...base, state: 'starting' };
  }

  function tell() {
    const shown = JSON.stringify(stateOf());
    if (shown === lastShown) return;
    lastShown = shown;
    try { onChange(); } catch { say('WARN', 'team.sharing.notify_failed'); }
  }

  // ------------------------------------------------------------ the agent

  function begin(engine) {
    if (stopped || !wanted || active || ending.size > 0 || !isReady(rowOf(wanted.teamId))) return;
    if (!engine || engine.url === failedUrl || !mayPersist()) return;
    const teamId = wanted.teamId;
    // Claims start at the floor; the mark past it must be on disk before the first one.
    const floor = Math.max(Math.trunc(Number(now()) || 0), wanted.mark);
    if (!persist(teamId, true, floor + markBlock)) return;
    wanted.mark = floor + markBlock;
    const client = engineClientFor(engine);
    const agent = createAgent({
      link: createTeamLink(managers.get(teamId)), resolveEngineUrl: () => engine.url, isBusy: ownBusy, seqFloor: floor,
      engine: client,
      engineInfo: { kind: engine.kind === 'local' ? 'openai-compatible' : engine.kind, version: 'unknown' },
      logger: (level, event, fields) => say(level, event, { team_id: teamId, ...fields }),
      readCapabilities: () => readCapabilities(getBackend(), capabilitiesEngine(engine)),
    });
    active = { teamId, agent, engine, since: null, after: false, client, draining: false, probing: false, probedAt: 0,
      baseline: null, probeAbort: new AbortController() };
    say('INFO', 'team.sharing.started', { team_id: teamId, engine: engine.kind === 'local' ? 'local' : engine.kind });
    void Promise.resolve(agent.start()).then((answer) => {
      if (active?.agent === agent && answer?.reason === 'node_engine_not_local') failedUrl = engine.url;
      look();
    }, () => look());
  }

  // Ends the active agent: `stop()` talks to the host (bounded), `dispose()` does not.
  function end(how, boundMs = STOP_BOUND_MS) {
    const current = active;
    if (!current) return Promise.resolve();
    active = null;
    current.probeAbort.abort();
    let done;
    if (how === 'dispose') {
      current.agent.dispose();
      done = Promise.resolve();
    } else {
      let bound = null;
      done = Promise.race([Promise.resolve(current.agent.stop()).catch(() => {}),
        new Promise((resolve) => { bound = timers.setTimeout(resolve, boundMs); bound?.unref?.(); })])
        .then(() => { timers.clearTimeout(bound); current.agent.dispose(); });
    }
    ending.add(done);
    // The next agent starts only after this one let go: a late unregister would remove the new registration.
    void done.finally(() => { ending.delete(done); look(); });
    say('INFO', 'team.sharing.ended', { team_id: current.teamId, how });
    return done;
  }

  // Turns the setting off for the wanted team (saved), keeping the mark.
  function turnOff() {
    if (!wanted) return;
    persist(wanted.teamId, false, wanted.mark);
    wanted = null;
    failedUrl = null;
  }

  // ------------------------------------------------------------ the look

  // One look a second while anything is wanted or running; nothing left: no timer either.
  function schedule() {
    if (!wanted && !active && lookTimer !== null) { timers.clearTimeout(lookTimer); lookTimer = null; }
    if (lookTimer !== null || stopped || (!wanted && !active)) return;
    lookTimer = timers.setTimeout(() => { lookTimer = null; look(); }, LOOK_MS);
    lookTimer?.unref?.();
  }

  // The running agent: ended on its own, stopping after the request, or still sharing.
  function lookAtAgent(engine) {
    const status = active.agent.status();
    const mine = wanted?.teamId === active.teamId;
    if (status.state === 'off') {
      // The agent ended on its own: a final refusal turns the setting off; anything else starts again later.
      const finalWord = FINAL_REASONS.has(status.reason) || status.reason === 'node_version_mismatch';
      void end('dispose');
      if (finalWord && mine) turnOff();
      return;
    }
    if (!mine || active.after) {
      // Stop after it: the setting is already off; the agent stops once the running request ended.
      if (status.jobs === 0) void end('stop');
      return;
    }
    if (Number.isSafeInteger(status.seq) && status.seq + markMargin > wanted.mark) {
      const next = status.seq + markBlock;
      if (mayPersist() && persist(wanted.teamId, true, next)) wanted.mark = next;
      else if (status.seq + Math.ceil(markMargin / 4) >= wanted.mark) { void end('stop'); return; }
    }
    const moved = !engine || engine.url !== active.engine.url || engine.key !== active.engine.key;
    if (moved && status.jobs === 0) void end('stop');
    else if (moved) drain();
    else if (status.state === 'idle' && status.jobs === 0) refresh();
  }

  // H14: the engine this agent forwards to is gone or another one while requests run: nothing new is claimed (a claim made
  // at the end of the last request would run against the old engine) until they end; then the agent stops and a new one registers.
  function drain() {
    if (active.draining) return;
    active.draining = true;
    say('INFO', 'team.sharing.draining', { team_id: active.teamId });
    void Promise.resolve(active.agent.pause({ on: true })).catch(() => {});
  }

  // What the engine offers now: the names, and a text that changes when a name, a context length or a capability does.
  async function survey(current) {
    const target = checkEngineUrl(current.engine.url);
    if (!target.ok) return null;
    const read = await readModels({ engine: current.client, target, timers, signal: current.probeAbort.signal });
    if (!read.ok) return null;
    let bound = null;
    const capabilities = await Promise.race([
      Promise.resolve().then(() => readCapabilities(getBackend(), capabilitiesEngine(current.engine))).catch(() => null),
      new Promise((resolve) => { bound = timers.setTimeout(() => resolve(null), CAPABILITIES_BOUND_MS); bound?.unref?.(); })]);
    timers.clearTimeout(bound);
    return { names: read.models.map((entry) => entry.name).sort(), signature: modelSignature(read.models, capabilities) };
  }

  // OD-4: while idle, the offer is read again every REFRESH_MS. The first read after a register is the baseline (its names
  // are checked against what the register sent); a later read that differs ends the agent, and the next one registers the new offer.
  function refresh() {
    const current = active;
    if (current.probing || now() - current.probedAt < REFRESH_MS) return;
    current.probing = true;
    current.probedAt = now();
    void survey(current).then((found) => {
      current.probing = false;
      if (active !== current || !found) return;
      const status = current.agent.status();
      if (status.state !== 'idle' || status.jobs > 0) { current.probedAt = 0; return; }
      const offered = [...status.models].sort();
      const changed = JSON.stringify(offered) !== JSON.stringify(found.names)
        || (current.baseline !== null && current.baseline !== found.signature);
      current.baseline = found.signature;
      if (changed) {
        say('INFO', 'team.sharing.offer_changed', { team_id: current.teamId, models: found.names.length });
        void end('stop');
      }
    }, () => { current.probing = false; });
  }

  function look() {
    if (stopped) return;
    try {
      const engine = engineNow();
      seenEngine = engine;
      if (active) lookAtAgent(engine);
      if (!active) begin(engine);
      tell();
      lookFailing = false;
    } catch {
      if (!lookFailing) say('WARN', 'team.sharing.look_failed', {});
      lookFailing = true;
    } finally {
      schedule();
    }
  }

  // ------------------------------------------------------------ the surface

  // A team came online: its saved setting is read once a run. A second team saved as on is turned off.
  function ensureWanted(teamId) {
    if (stopped || checked.has(teamId) || wanted?.teamId === teamId) return;
    checked.add(teamId);
    const saved = loaded(teamId);
    if (!saved?.ok || !saved.on) return;
    if (!wanted) { wanted = { teamId, mark: saved.claim_seq, ollamaModels: saved.ollama_models ?? null }; return; }
    persist(teamId, false, saved.claim_seq);
    say('INFO', 'team.sharing.second_team_off', { team_id: teamId });
  }

  // A team's connection changed (team-service.js calls this on every manager change).
  function connectionChanged(teamId, manager) {
    if (stopped || !manager) return;
    try {
      managers.set(teamId, manager);
      const row = rowOf(teamId);
      if (row && ENDED.has(row.state)) {
        if (active?.teamId === teamId) void end('dispose');
        if (wanted?.teamId === teamId) turnOff();
        tell();
        return;
      }
      if (isReady(row)) ensureWanted(teamId);
    } catch {
      say('WARN', 'team.sharing.change_failed', { team_id: teamId });
    }
    look();
  }

  // Off now: the agent stops (a running request ends) and the setting is saved off. The tail of a
  // switch-off while idle and of the switch-off question's "Stop now", in or out of the stop-after window.
  async function stopSharing(teamId) {
    const done = active?.teamId === teamId ? end('stop') : Promise.resolve();
    if (wanted?.teamId === teamId) turnOff();
    tell();
    await done;
    return { ok: true, sharing: stateOf() };
  }

  // The first time a team is shared on this PC (no mark saved yet) the page shows the sharer's notice
  // first: without `confirmed` that turn-on answers `team_share_confirm_needed` and changes nothing.
  async function set(teamId, on, { confirmed = false } = {}) {
    if (stopped) return refusal('team_connection_stopped');
    if (!managers.has(teamId)) return refusal('team_not_found');
    if (on) {
      if (wanted && wanted.teamId !== teamId) return refusal('node_agent_running');
      if (active && active.teamId !== teamId) return refusal('node_agent_running');
      if (active?.after) { active.after = false; await active.agent.pause({ on: false }); }
      if (!wanted) {
        const saved = loaded(teamId);
        if (!saved?.ok) return refusal(saved?.reason || 'team_sharing_invalid');
        if (saved.claim_seq === 0 && confirmed !== true) return refusal('team_share_confirm_needed');
        // A mark of at least 1 records that the notice was confirmed (it is only ever a floor for claim numbers).
        const mark = Math.max(saved.claim_seq, 1);
        if (!persist(teamId, true, mark)) return refusal('team_client_write_failed');
        wanted = { teamId, mark, ollamaModels: saved.ollama_models ?? null };
        checked.add(teamId);
      }
      look();
      return { ok: true, sharing: stateOf() };
    }
    if (!wanted || wanted.teamId !== teamId) return { ok: true, sharing: stateOf() };
    // Stop after it: the setting goes off now, nothing new is taken (pause) and the agent stops once the
    // running request ends.
    if (active && active.agent.status().jobs > 0) {
      active.after = true;
      turnOff();
      await active.agent.pause({ on: true });
      look();
      return { ok: true, sharing: stateOf() };
    }
    return stopSharing(teamId);
  }

  // Pause keeps the hardware registered (the team sees it paused) and lets a running request finish;
  // with `stopRunning` (the page's "Stop now" beside Pause, the spec's "Stop sharing now") it ends it at once.
  async function pause(teamId, on, stopRunning = false) {
    if (!active || active.teamId !== teamId || active.after || active.draining) return refusal('node_agent_state');
    const answer = await active.agent.pause(on && stopRunning ? { on: true, stopRunning: true } : { on });
    tell();
    return answer?.ok ? { ok: true, sharing: stateOf() } : refusal(answer?.reason || 'node_agent_state');
  }

  // OD-4: the Ollama models this PC shares for the team (a list of names; null returns to the default share set), saved and
  // applied at the next read of the offer (within the refresh interval at the latest; a running request is never cut).
  function setOllamaModels(teamId, names) {
    if (stopped) return refusal('team_connection_stopped');
    if (!managers.has(teamId)) return refusal('team_not_found');
    const next = names === null ? null : cleanShareSet(names);
    if (names !== null && next === null) return refusal('team_sharing_invalid');
    const saved = wanted?.teamId === teamId ? { ok: true, on: true, claim_seq: wanted.mark } : loaded(teamId);
    if (!saved?.ok) return refusal(saved?.reason || 'team_sharing_invalid');
    let answer;
    try { answer = save(userDataPath, teamId, { on: saved.on, claim_seq: saved.claim_seq, ollama_models: next }); } catch { answer = null; }
    if (answer?.ok !== true) return refusal(answer?.reason || 'team_client_write_failed');
    if (wanted?.teamId === teamId) wanted.ollamaModels = next;
    if (active?.teamId === teamId) active.probedAt = 0;
    look();
    return { ok: true, ollama_models: next };
  }

  // The chosen Ollama share set of a team, or null (the default).
  function ollamaModels(teamId) {
    if (wanted?.teamId === teamId) return wanted.ollamaModels;
    const saved = managers.has(teamId) ? loaded(teamId) : null;
    return saved?.ok && Array.isArray(saved.ollama_models) ? saved.ollama_models : null;
  }

  // The team is forgotten (left or removed) or its manager stopped: sharing ends without a word to the host.
  function drop(teamId) {
    managers.delete(teamId);
    checked.delete(teamId);
    if (active?.teamId === teamId) void end('dispose');
    if (wanted?.teamId === teamId) { wanted = null; failedUrl = null; }
    tell();
  }

  // App stop: the agent's own stop (its unregister rides the connection), at most QUIT_BOUND_MS, then disposed.
  async function stopAll() {
    if (stopped) return;
    const done = end('stop', QUIT_BOUND_MS);
    stopped = true;
    for (const timer of [lookTimer, saves.timer]) if (timer !== null) timers.clearTimeout(timer);
    lookTimer = null;
    saves.timer = null;
    let bound = null;
    await Promise.race([Promise.all([done, ...ending]),
      new Promise((resolve) => { bound = timers.setTimeout(resolve, QUIT_BOUND_MS); bound?.unref?.(); })]);
    timers.clearTimeout(bound);
  }

  return {
    attach({ onChange: next }) { if (typeof next === 'function') onChange = next; },
    connectionChanged, drop, set, pause, stopNow: stopSharing, stopAll, setOllamaModels, ollamaModels,
    snapshot() { try { return stateOf(); } catch { return null; } },
    resources: () => ({ agents: active ? 1 : 0, timers: (lookTimer === null ? 0 : 1) + (saves.timer === null ? 0 : 1),
      ending: ending.size, agent: active ? active.agent.resources() : null }),
  };
}

module.exports = { MARK_BLOCK, createTeamSharing };
