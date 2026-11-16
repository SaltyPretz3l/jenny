'use strict';

// The member side of Force local (row 123, E64) as main wires it: the real registration, team service, team engine
// and team sharing, with fake connection managers and a fake engine port (no socket, no DNS, no child), the mode
// behind a reader the test sets and the saved config's `changed` event, and a stand-in host controller.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { saveClientFile } = require('../../services/team/client-file');
const { saveSharing } = require('../../services/team/node/sharing-file');
const { deriveTeamId, keyPairFromSeed } = require('../../server/team/ids');
const { createMemorySecureStore, tempProfile } = require('./team-client-host');
const { registerTeam } = require('../../services/main/team-registration');
const { createTeamEngine } = require('../../services/team/team-engine');

const tick = (ms = 5) => new Promise((resolve) => { setTimeout(resolve, ms); });
const reasonOf = (answer) => answer?.error?.reason;

function savedRecord() {
  const host = keyPairFromSeed(crypto.randomBytes(32)).publicKey;
  return { schema_version: 1, team_id: deriveTeamId(host), host_public_key: host, address_hints: ['192.0.2.7:4242'],
    last_addresses: ['192.0.2.7:4242'], member_id: 'member_abcDEF123', device_id: 'device_abcDEF123',
    display_name: 'Mika Member', joined_at: '2026-11-10T10:00:00.000Z', state_seen: 'active' };
}

// A connection manager with no network: online once started, with a live timer count until it is stopped. A test may
// set `snapshotThrows` (its snapshot throws) or `stopWith` (a function whose promise its stop awaits) on one.
function fakeManagers() {
  const made = [];
  const createManager = ({ record, onChange }) => {
    const manager = {
      teamId: record.team_id, started: false, stopped: false, timers: 0, listeners: [], snapshotThrows: false, stopWith: null,
      start() { manager.started = true; manager.timers = 1; setImmediate(() => { if (!manager.stopped) onChange(); }); },
      async stop() {
        if (manager.stopWith) await manager.stopWith();
        manager.stopped = true;
        manager.timers = 0;
      },
      snapshot: () => {
        if (manager.snapshotThrows) throw new Error('secure store gone');
        return { team_id: record.team_id, team_name: `Team ${made.indexOf(manager)}`, state: manager.stopped ? 'offline' : 'online',
          reason: null, role: 'member', member_state: 'active', member_id: record.member_id, device_id: record.device_id };
      },
      onEvent: (listener) => { manager.listeners.push(listener); return () => {}; },
      resources: () => ({ bridges: manager.stopped ? 0 : 1, timers: manager.timers, sockets: 0, streams: 0 }),
      command: async () => ({ ok: true }), leave: async () => ({ ok: true }), isOwnDevice: () => false,
      engine: async () => { throw new Error('no engine call expected'); },
      borrow: () => ({ link: null, ensureClient: async () => null, online: false }),
    };
    made.push(manager);
    return manager;
  };
  return { made, createManager, live: () => made.filter((m) => !m.stopped) };
}

function fakePorts() {
  const ports = [];
  const createPort = () => {
    const port = { state: 'stopped', start: async () => { port.state = 'ready'; }, stop: async () => { port.state = 'stopped'; },
      getStatus: () => ({ state: port.state }), turnRoute: null };
    ports.push(port);
    return port;
  };
  return { ports, createPort, open: () => ports.filter((p) => p.state === 'ready').length };
}

// `dir` and `records` reuse a profile (a second launch); `hostRelease` replaces the stand-in host's release.
function world(t, { mode = 'disabled', teams = 2, sharingOn = true, reader = true, dir = null, records = null, hostRelease = null } = {}) {
  const profile = dir || tempProfile(t, 'jenny-force-local-');
  const saved = records || Array.from({ length: teams }, () => savedRecord());
  if (!records) for (const record of saved) assert.equal(saveClientFile(profile, record).ok, true);
  if (!records && sharingOn && saved[0]) assert.equal(saveSharing(profile, saved[0].team_id, { on: true, claim_seq: 7 }).ok, true);
  const state = { mode, clock: 1_000_000 };
  const secureStore = createMemorySecureStore();
  const config = new EventEmitter();
  const backend = new EventEmitter();
  Object.assign(backend, { featureFlags: { team: true }, options: {}, getBackendStatus: () => ({ phase: 'ready' }),
    refreshManagedConfig: async () => { backend.refreshed = (backend.refreshed || 0) + 1; } });
  const managers = fakeManagers();
  const ports = fakePorts();
  const events = [];
  const spawns = [];
  const captured = {};
  const shutdown = [];
  const host = { holdForceLocal: async () => { events.push('host.hold'); },
    releaseForceLocal: () => { events.push('host.release'); return hostRelease ? hostRelease() : undefined; },
    handle: async () => ({ ok: true }), stop: async () => {} };
  const createManager = (options) => { events.push(`manager:${options.record.team_id}`); return managers.createManager(options); };
  const handlers = new Map();
  const registered = registerTeam({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    featureFlags: { team: true }, backendService: backend, userDataPath: profile, getSecureStore: () => secureStore,
    getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }),
    ...(reader ? { readOfflineMode: () => { if (state.mode instanceof Error) throw state.mode; return state.mode; } } : {}),
    subscribeConfig: (fn) => { config.on('changed', fn); return () => config.off('changed', fn); },
    serviceOptions: { createManager, now: () => state.clock, spawnChild: (kind) => { spawns.push(kind); throw new Error('no child expected'); } },
    loadService: () => { const real = require('../../services/team/team-service'); return { createTeamService: (options) => { captured.service = options; return real.createTeamService(options); } }; },
    loadHost: () => ({ createHostController: (options) => { captured.host = options; return host; } }),
    loadEngine: () => ({ createTeamEngine: (options) => createTeamEngine({ ...options, createPort: ports.createPort }) }),
  });
  t.after(() => shutdown[0]?.());
  // The host controller exists once a host method was called (here the page's first status read).
  void handlers.get('team:host-status')({ sender: {} }, undefined);
  const service = () => registered.getService();
  // Sets the mode and tells the registration, without waiting for the hold or release.
  const emit = (next, reason = 'whole_state') => { state.mode = next; config.emit('changed', {}, { reason }); };
  const flip = async (next, reason) => {
    emit(next, reason);
    await registered.forceLocalIdle();
    await tick();
  };
  return { dir: profile, records: saved, state, config, backend, managers, ports, events, spawns, captured, registered, service,
    emit, flip, shutdown, handlers };
}

module.exports = { fakeManagers, fakePorts, reasonOf, savedRecord, tick, world };
