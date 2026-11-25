'use strict';

// One team engine port per team this Jenny is in (row 123, slice 4b member wiring;
// TEAM_NODE_PROTOCOL_SPEC "4b member wiring as built"). A team's port starts the
// first time its connection is online and is kept across reconnects, so its key is
// stable; it stops when the team is dropped (forgotten or its manager stopped), when
// the connection ends for good (revoked, update required) and at stop-all. A start
// that fails is tried again on the next change or list read, at most START_TRIES
// times, no sooner than `startRetryMs` apart. The port's `forward` is the team's
// connection manager (`engine`, whose body is `engineCall` below), so every request
// rides that team's own authenticated connection and nothing else.
//
// The team's models are read through the same call (GET models, a JSON body of at
// most 256 KiB, the whole read within 3 s), cached per team: read when the team
// comes online, when the member turns from pending to active while online, when the host
// pushes `team_pool_nodes` (a GPU came or went) and at most every 15 s when the list is read.
// A failed read keeps the last good list and marks it stale (row 201): the list is cleared only
// after STALE_LIMIT failed reads in a row. Each model carries its context length and its vision and
// thinking flags when the host names them. A manager once dropped is never taken back. Logs carry team ids,
// counts and reasons only: never a key, a token, a body or a model list.

const { TeamError } = require('./team-errors');
const { isProfileContextLength, isTeamEngineModelName } = require('../backend/team-engine-models');

const LIST_TTL_MS = 15_000;
const LIST_TIMEOUT_MS = 3000;
const START_RETRY_MS = 5000;
const START_TRIES = 5;
const STALE_LIMIT = 3; // failed reads in a row before the held list is cleared
const POOL_EVENT = 'team_pool_nodes';
const MAX_LIST_BYTES = 256 * 1024;
// The host scheduler's models-per-node bound (server/team/scheduler/limits.js `maxModelsPerNode`).
const MAX_MODELS = 64;
const MAX_NAME = 120;
const ENDED = new Set(['revoked', 'update_required']);

// The body of the connection manager's `engine` call: `state` is that manager's live link, its client
// registration and whether it is online. Throws a TeamError when the team is not reachable now.
async function engineCall({ link, ensureClient, online }, route, body, options = {}) {
  if (!online || !link) throw new TeamError('CONNECTION_FAILED', 'team_not_connected');
  const blocked = await ensureClient(link);
  if (blocked) throw new TeamError('CONNECTION_FAILED', blocked.error?.reason || 'team_not_connected');
  return route === 'chat'
    ? link.session.engineChat(link.client, body, options)
    : link.session.engineModels(link.client, options);
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().slice(0, MAX_NAME);
  return [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ? '' : text;
}

// The model ids of an OpenAI-shaped models answer (distinct, well formed, at most MAX_MODELS) and,
// beside them, each kept id's `context_length` when the host named one inside the bounds (slice 4f)
// and its `vision` / `thinking` flags when the host named one as true. A bad length is dropped and its id kept.
function modelsOf(text) {
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed?.data) ? parsed.data : [];
  const ids = [];
  const contextLengths = {};
  const capabilities = {};
  for (const row of rows) {
    const id = row?.id;
    if (isTeamEngineModelName(id) && !ids.includes(id)) {
      ids.push(id);
      const length = row.context_length;
      if (isProfileContextLength(length)) contextLengths[id] = length;
      if (row.vision === true || row.thinking === true) capabilities[id] = { vision: row.vision === true, thinking: row.thinking === true };
    }
    if (ids.length >= MAX_MODELS) break;
  }
  return { ids, contextLengths, capabilities };
}

// `promise`, or a rejection as soon as `signal` aborts; a late answer is closed.
function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('team_engine_models_timeout'), { reason: 'team_engine_models_timeout' }));
    if (signal.aborted) { onAbort(); } else signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) value?.close?.(); else resolve(value);
    }, (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

// Reads one bounded JSON answer; rejects past the byte cap, on a bad status or when `signal` aborts.
function readAnswer(upstream, signal) {
  return new Promise((resolve, reject) => {
    const fail = (reason) => { upstream?.close?.(); reject(Object.assign(new Error(reason), { reason })); };
    if (upstream?.status !== 200 || !upstream.body) { fail('team_engine_models_refused'); return; }
    const chunks = [];
    let total = 0;
    signal.addEventListener('abort', () => fail('team_engine_models_timeout'), { once: true });
    upstream.body.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_LIST_BYTES) { fail('team_engine_models_too_large'); return; }
      chunks.push(chunk);
    });
    upstream.body.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    upstream.body.on('error', () => fail('team_engine_models_cut'));
  });
}

function defaultCreatePort(options) {
  return require('./engine-port').createTeamEnginePort(options);
}

function createTeamEngine({
  createPort = defaultCreatePort, onPortChange = () => {}, onListChange = () => {}, onTeamGone = () => {},
  log = () => {}, now = Date.now, timers = { setTimeout, clearTimeout }, listTtlMs = LIST_TTL_MS,
  listTimeoutMs = LIST_TIMEOUT_MS, startRetryMs = START_RETRY_MS,
} = {}) {
  // team id -> { manager, port, name, online, active, models, contextLengths, capabilities, stale, failures, readAt, reading,
  //              again, unsubscribe, starts, retryAt }
  const teams = new Map();
  const dropped = new WeakSet(); // managers whose team was dropped: a late change from one is ignored
  const stops = new Set();
  let stopped = false;
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const tell = (fn, ...args) => { try { fn(...args); } catch { say('WARN', 'team.engine.notify_failed'); } };

  // `quiet` (a Force local hold, E64): the port change is told as a list change only, so the selection stays.
  function stopPort(teamId, entry, { quiet = false } = {}) {
    const port = entry.port;
    if (!port) return Promise.resolve();
    entry.port = null;
    const stopping = Promise.resolve(port.stop()).catch(() => say('WARN', 'team.engine.port_stop_failed', { team_id: teamId }))
      .then(() => tell(quiet ? onListChange : onPortChange, teamId));
    stops.add(stopping);
    void stopping.finally(() => stops.delete(stopping));
    return stopping;
  }

  function startPort(teamId, entry) {
    if (stopped || entry.port || !entry.online || entry.starts >= START_TRIES || now() < entry.retryAt) return;
    entry.starts += 1;
    const port = createPort({
      forward: ({ route, body, engineKey, signal }) => entry.manager.engine(route, body, { engineKey, signal }),
      logger: (level, event, fields) => say(String(level).toUpperCase(), event, { team_id: teamId, ...fields }),
    });
    entry.port = port;
    Promise.resolve(port.start()).then(() => {
      if (entry.port !== port) return;
      entry.starts = 0;
      if (!stopped) tell(onPortChange, teamId);
    }, () => {
      if (entry.port === port) entry.port = null;
      entry.retryAt = now() + startRetryMs;
      say('WARN', 'team.engine.port_start_failed', { team_id: teamId, tries: entry.starts });
    });
  }

  async function readModels(teamId, entry) {
    const controller = new AbortController();
    const timer = timers.setTimeout(() => controller.abort(), listTimeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
    let models = null; // null: this read failed
    try {
      // The whole read is bounded, the connection's own client registration included.
      const upstream = await untilAborted(
        entry.manager.engine('models', null, { signal: controller.signal, headTimeoutMs: listTimeoutMs }), controller.signal);
      models = modelsOf(await readAnswer(upstream, controller.signal));
    } catch (error) {
      say('INFO', 'team.engine.models_unavailable', { team_id: teamId, reason: String(error?.reason || 'read_failed') });
    } finally {
      timers.clearTimeout(timer);
    }
    return models;
  }

  function refreshModels(teamId, entry) {
    if (stopped) return null;
    if (entry.reading) return entry.reading;
    entry.readAt = now();
    entry.reading = readModels(teamId, entry).then((read) => {
      entry.reading = null;
      if (teams.get(teamId) !== entry || stopped) return;
      entry.readAt = now();
      // One failed read keeps the last good list, marked stale; STALE_LIMIT in a row clear it.
      entry.failures = read ? 0 : entry.failures + 1;
      const held = { ids: entry.models, contextLengths: entry.contextLengths, capabilities: entry.capabilities };
      const models = read || (entry.failures >= STALE_LIMIT ? { ids: [], contextLengths: {}, capabilities: {} } : held);
      const stale = !read && models.ids.length > 0;
      const changed = JSON.stringify(models) !== JSON.stringify(held) || stale !== entry.stale;
      entry.models = models.ids;
      entry.contextLengths = models.contextLengths;
      entry.capabilities = models.capabilities;
      entry.stale = stale;
      if (read) say('INFO', 'team.engine.models_read', { team_id: teamId, count: models.ids.length });
      if (changed) tell(onListChange);
      if (entry.again) { entry.again = false; void refreshModels(teamId, entry); }
    });
    return entry.reading;
  }

  // The host says a GPU came, went or changed: read the list again now (once more if a read is on its way).
  function onPoolEvent(teamId, entry, event) {
    if (event?.event_type !== POOL_EVENT || stopped || teams.get(teamId) !== entry || !entry.online || !entry.active) return;
    // Only what changes the pool's model list: a job starting or ending (busy slots) reads nothing (row 201 review).
    const nodes = Array.isArray(event.nodes) ? event.nodes : [];
    const sig = JSON.stringify(nodes.map((node) => [node?.node_id, node?.online, node?.paused, node?.models]));
    if (sig === entry.poolSig) return;
    entry.poolSig = sig;
    if (entry.reading) entry.again = true; else void refreshModels(teamId, entry);
  }

  // A team's connection changed (team-service.js calls this on every manager change).
  function connectionChanged(teamId, manager) {
    if (stopped || !manager || dropped.has(manager)) return;
    const snapshot = manager.snapshot();
    let entry = teams.get(teamId);
    if (!entry || entry.manager !== manager) {
      if (entry) { dropped.add(entry.manager); entry.unsubscribe(); void stopPort(teamId, entry); }
      entry = { manager, port: null, name: '', online: false, active: false, models: [], contextLengths: {}, capabilities: {},
        stale: false, failures: 0, readAt: 0, reading: null, again: false, poolSig: null, unsubscribe: () => {}, starts: 0, retryAt: 0 };
      teams.set(teamId, entry);
      const created = entry;
      if (typeof manager.onEvent === 'function') {
        try {
          created.unsubscribe = manager.onEvent((event) => onPoolEvent(teamId, created, event)) || (() => {});
        } catch { say('WARN', 'team.engine.subscribe_failed', { team_id: teamId }); }
      }
    }
    const before = JSON.stringify([entry.name, entry.online, entry.active]);
    const cameOnline = snapshot.state === 'online' && !entry.online;
    const cameActive = snapshot.member_state === 'active' && !entry.active;
    entry.name = cleanName(snapshot.team_name);
    entry.online = snapshot.state === 'online';
    entry.active = snapshot.member_state === 'active';
    if (ENDED.has(snapshot.state)) {
      void stopPort(teamId, entry);
      tell(onTeamGone, teamId);
    } else startPort(teamId, entry);
    if ((cameOnline || cameActive) && entry.online && entry.active) void refreshModels(teamId, entry);
    if (before !== JSON.stringify([entry.name, entry.online, entry.active])) tell(onListChange);
  }

  // The team is forgotten or its manager stopped: its port stops, its rows go and its manager is not taken back.
  // `quiet` (a Force local hold, E64): the team is not reported gone, so the member's chosen team model stays chosen
  // (and is refused as `team_force_local` until the hold ends).
  function drop(teamId, { quiet = false } = {}) {
    const entry = teams.get(teamId);
    if (!entry) return Promise.resolve();
    teams.delete(teamId);
    dropped.add(entry.manager);
    entry.unsubscribe();
    if (!quiet) tell(onTeamGone, teamId);
    tell(onListChange);
    return stopPort(teamId, entry, { quiet });
  }

  async function stopAll() {
    stopped = true;
    const all = [...teams];
    teams.clear();
    for (const [, entry] of all) { dropped.add(entry.manager); entry.unsubscribe(); }
    await Promise.all([...all.map(([teamId, entry]) => stopPort(teamId, entry)), ...stops]);
  }

  return {
    connectionChanged,
    drop,
    stopAll,
    // What loadModel checks before it switches; null for a team this Jenny does not hold.
    teamState(teamId) {
      const entry = teams.get(teamId);
      if (!entry) return null;
      return { online: entry.online, active: entry.active, portReady: entry.port?.getStatus?.()?.state === 'ready',
        models: [...entry.models], contextLengths: { ...entry.contextLengths }, capabilities: { ...entry.capabilities },
        stale: entry.stale };
    },
    // Every team that adds rows to the model list now; a list older than the TTL is read again for the next
    // call, and a port whose start failed is tried again.
    listTeams() {
      const out = [];
      for (const [teamId, entry] of teams) {
        if (!entry.online || !entry.active) continue;
        startPort(teamId, entry);
        if (now() - entry.readAt >= listTtlMs) void refreshModels(teamId, entry);
        if (entry.models.length > 0) {
          out.push({ teamId, name: entry.name, models: [...entry.models], contextLengths: { ...entry.contextLengths },
            capabilities: { ...entry.capabilities } });
        }
      }
      return out;
    },
    portFor: (teamId) => teams.get(teamId)?.port || null,
    resources: () => ({ teams: teams.size, ports: [...teams.values()].filter((entry) => entry.port).length,
      stopping: stops.size }),
  };
}

module.exports = { createTeamEngine, engineCall };
