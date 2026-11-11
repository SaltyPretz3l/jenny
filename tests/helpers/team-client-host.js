'use strict';

// A real team host for the desktop member client tests: the real member store,
// invite service, team commands, host core, preamble listener and team routes,
// composed the way server/team/team-main.js composes them (with the same revoke
// fan-out) but over a controllable clock, behind a real host bridge supervisor
// driving the fake bridge child; plus a member-side fake child spawner over the
// same in-memory transport. The fake transport names an endpoint by a hash of
// its seed; the wrapper here maps that to the real Ed25519 key, so the device
// key the client redeems is the key the host bridge admits. Nothing opens a
// real interface.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ClientRegistry } = require('../../server/client-registry');
const { loadHostConfig } = require('../../server/config');
const { ControlLeases } = require('../../server/control-leases');
const { createHostCore } = require('../../server/host-core');
const { createAuthorizer } = require('../../server/team/authorize');
const { decodeBase64url, keyPairFromSeed } = require('../../server/team/ids');
const { createInviteService, parseInvite } = require('../../server/team/invites');
const { MemberStore } = require('../../server/team/member-store');
const { REVOKE_EVENT_KINDS } = require('../../server/team/membership-events');
const { createRateLimiter } = require('../../server/team/rate-limit');
const { createTeamCommands } = require('../../server/team/team-commands');
const { createTeamListener } = require('../../server/team/team-http-server');
const { createHostBridge } = require('../../server/team/transport/host-bridge');
const { createFakeBridgeSpawner } = require('../server/helpers/fake-bridge');
const { createFakeTransport, hex } = require('../server/helpers/fake-team-transport');
const { HOST_SEED, createTeamHostFixture, randomKey } = require('../server/helpers/team-host-fixture');
const { createClock, pause, waitUntil } = require('../server/helpers/team-http-fixture');

const HINT = '192.0.2.7:4242';

function edPublic(secret) {
  return Buffer.from(keyPairFromSeed(Buffer.from(secret)).publicKey, 'base64url');
}

// The fake transport, re-keyed to real Ed25519 public keys, with a switch for which
// dialled addresses reach the host and `reach.gate` (a promise) that holds every dial.
function ed25519Transport(fake, reach) {
  const hostKeys = new Map();
  const memberKeys = new Map();
  return {
    async listen(options) {
      hostKeys.set(hex(edPublic(options.secretKey)), fake.publicKeyOf(options.secretKey));
      const inner = await fake.transport.listen({ ...options, onConnection: (conn) => {
        const real = memberKeys.get(hex(conn.remoteKey));
        if (real) conn.remoteKey = real;
        options.onConnection(conn);
      } });
      return { publicKey: edPublic(options.secretKey), addresses: inner.addresses, close: inner.close };
    },
    async connect(options) {
      reach.dials.push([...options.addresses]);
      if (reach.gate) await reach.gate;
      if (reach.allowed && !options.addresses.some((address) => reach.allowed.has(address))) {
        throw Object.assign(new Error('unreachable'), { code: 'host_unreachable' });
      }
      memberKeys.set(hex(fake.publicKeyOf(options.secretKey)), edPublic(options.secretKey));
      const mapped = hostKeys.get(hex(options.hostPublicKey)) || options.hostPublicKey;
      return fake.transport.connect({ ...options, hostPublicKey: mapped });
    },
  };
}

// The app's secure store, in memory: `get`, `set`, `delete`, `getStatus`.
function createMemorySecureStore({ status = 'ready' } = {}) {
  const values = new Map();
  const store = {
    values, sets: [], deletes: [], refuseSet: false, status,
    getStatus: () => ({ status: store.status, ready: store.status === 'ready',
      storageBackend: store.status === 'basic_text' ? 'basic_text' : '' }),
    get(key) {
      if (store.status !== 'ready') throw new Error('SecureStore: credential storage is unavailable.');
      return values.get(key) || '';
    },
    set(key, value) {
      if (store.refuseSet || store.status !== 'ready') throw new Error('SecureStore: refusing to store.');
      store.sets.push(key);
      values.set(key, String(value));
    },
    delete(key) {
      if (store.status !== 'ready') throw new Error('SecureStore: not ready.');
      store.deletes.push(key);
      values.delete(key);
    },
  };
  return store;
}

// Every file under a directory, as { path, text }.
function readTree(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ path: full, text: fs.readFileSync(full, 'latin1') });
    }
  };
  walk(root);
  return out;
}

// The host side: team-main's steps 5 to 8 over a controllable clock. `bridge()` is read lazily for `dropKey`.
async function createHostEnv(t, clock, bridge) {
  const fx = createTeamHostFixture(t);
  const config = loadHostConfig(fx.configPath);
  const store = new MemberStore({ userDataPath: fx.profile, hostPublicKey: fx.hostPublicKey, teamName: fx.teamName,
    clock, logger: fx.logger });
  const opened = store.open();
  if (!opened.ok) throw new Error(`store open failed: ${opened.error.reason}`);
  const { authorize } = createAuthorizer({ directory: store.directory });
  const realInvites = createInviteService({ store, clock, logger: fx.logger });
  const redeemCalls = [];
  // Mutable on purpose: a test may replace `redeem` to lose its answer.
  const invites = { ...realInvites, redeem: async (input) => { redeemCalls.push({ inviteId: input.inviteId }); return realInvites.redeem(input); } };
  const addresses = () => [HINT];
  const teamCommands = createTeamCommands({ store, invites, directory: store.directory, addresses, clock,
    limiter: createRateLimiter({ limit: 30, windowMs: 60_000, maxKeys: 64, clock }), logger: fx.logger });
  const dropKey = (text) => {
    const bytes = decodeBase64url(text, 32);
    const active = bridge();
    return bytes && active ? active.drop(bytes) : 0;
  };
  // The parts a host restart replaces (a new boot epoch, client registry, leases, events and listener).
  let live = null;
  const unsubscribe = store.onMembershipChange((event) => {
    if (!REVOKE_EVENT_KINDS.has(event.kind) || !live) return;
    const devices = store.listDevices(event.member_id);
    for (const deviceId of event.device_ids) {
      const device = devices.find((entry) => entry.device_id === deviceId);
      if (device) dropKey(device.public_key);
      live.clients.revokeDevice(deviceId);
      live.leases.revokeDevice(deviceId);
      live.core.events.revokeDevice(deviceId);
    }
  });
  // Every command the routes dispatched ({ operation, request_id }) and every event subscription
  // ({ bootEpoch, cursor } parsed from Last-Event-ID; bootEpoch is null when none was sent).
  const commandsSeen = [];
  const subscribesSeen = [];
  // The real bridge lets a finished answer out before it closes a dropped connection
  // (best effort, within its 1 s grace; TEAM_MEMBERSHIP_SPEC "1d-R slice spec"); the fake
  // child closes at once. The routes that answer and then drop the caller (a refused hello,
  // a join) get that grace here, so the client sees the answer the real binary delivers.
  const dropAfterAnswer = (text) => { setTimeout(() => dropKey(text), 50).unref(); return 0; };
  async function startCore() {
    const clients = new ClientRegistry({ capacity: 64, perDeviceCapacity: 4 });
    const leases = new ControlLeases();
    const core = createHostCore({ config, clients, leases, authorize, guardRequired: true, maxEventClients: 64,
      logger: fx.logger, createBackend: fx.createBackend, teamCommands });
    const subscribe = core.events.subscribe.bind(core.events);
    core.events.subscribe = (options) => {
      subscribesSeen.push({ bootEpoch: options.bootEpoch ?? null, cursor: options.cursor });
      return subscribe(options);
    };
    const router = Object.create(core.router, { dispatch: { value: async (value, ctx) => {
      commandsSeen.push({ operation: value?.operation, request_id: value?.request_id });
      const hooked = env.commandHook ? env.commandHook(value) : null;
      return hooked || core.router.dispatch(value, ctx);
    } } });
    const bootSecret = crypto.randomBytes(32);
    const context = Object.freeze({
      config, bootEpoch: core.bootEpoch, bootSecret, store, directory: store.directory, invites, authorize, clients,
      leases, events: core.events, router, assetRoutes: core.assetRoutes,
      resourceLimits: config.resourceLimits, isReady: () => true, addresses, dropKey: dropAfterAnswer,
      notifyMembership: () => {},
      logger: fx.logger,
    });
    const listener = await createTeamListener(context);
    live = { clients, leases, core, listener };
    Object.assign(env, { core, context, port: listener.port, bootSecret });
  }
  async function stopCore() {
    const current = live;
    live = null;
    if (current) { await current.listener.close(); await current.core.dispose(); }
  }
  const env = {
    fx, store, core: null, context: null, port: 0, bootSecret: null, redeemCalls, logs: fx.logs, clock,
    commandsSeen, subscribesSeen,
    // When set, `commandHook(command)` may return an answer the routes send instead of dispatching.
    commandHook: null,
    // A host process restart over the same member store: a new boot epoch and an empty event replay.
    async restart() { await stopCore(); await startCore(); },
    async redeemDirect({ kind = 'new_member', actor = null, role = 'member', name, label = 'Laptop' }) {
      const created = await store.createInvite({ kind, actorMemberId: actor, ...(kind === 'new_member' ? { role } : {}),
        invitePublicKey: randomKey() });
      if (!created.ok) throw new Error(`invite failed: ${created.error.reason}`);
      const deviceKey = randomKey();
      const redeemed = await store.redeem({ inviteId: created.invite_id, devicePublicKey: deviceKey,
        displayName: name, label });
      if (!redeemed.ok) throw new Error(`redeem failed: ${redeemed.error.reason}`);
      return { ...redeemed, key: deviceKey };
    },
  };
  await startCore();
  t.after(async () => { unsubscribe(); await stopCore(); });
  return env;
}

async function createTeamClientHost(t, { clock = createClock(), startBridge = true } = {}) {
  let hostBridge = null;
  const env = await createHostEnv(t, clock, () => hostBridge);
  const fake = createFakeTransport();
  const reach = { allowed: null, dials: [], gate: null };
  let releaseGate = null;
  const transport = ed25519Transport(fake, reach);
  const hostSpawner = createFakeBridgeSpawner({ transport });
  const memberSpawner = createFakeBridgeSpawner({ transport });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-client-'));
  const secureStore = createMemorySecureStore();
  const logs = [];
  const states = [];
  const services = [];

  const host = {
    env, fake, reach, transport, hostSpawner, memberSpawner, userData, secureStore, logs, states, clock,
    get hostBridge() { return hostBridge; },
    async startHostBridge() {
      hostBridge = createHostBridge({ spawnChild: hostSpawner, secretKey: Uint8Array.from(HOST_SEED),
        loopbackPort: env.port, bootSecret: Uint8Array.from(env.bootSecret),
        admit: (keyBytes) => {
          // `refuseNextAdmits` refuses that many connections, known keys included (a transient refusal).
          if (host.refuseNextAdmits > 0) { host.refuseNextAdmits -= 1; return null; }
          return env.store.directory.admitKind(Buffer.from(keyBytes).toString('base64url'));
        } });
      await hostBridge.start();
      return hostBridge;
    },
    async stopHostBridge() {
      const bridge = hostBridge;
      hostBridge = null;
      if (bridge) await bridge.stop();
    },
    refuseNextAdmits: 0,
    setReachable(addresses) { reach.allowed = addresses ? new Set(addresses) : null; },
    // Holds every member dial until `releaseDials()`.
    holdDials() { reach.gate = new Promise((resolve) => { releaseGate = resolve; }); },
    releaseDials() { const release = releaseGate; reach.gate = null; releaseGate = null; if (release) release(); },
    async invite({ kind = 'new_member', actor = null, role = 'member', hints = [HINT] } = {}) {
      const created = await env.context.invites.create({ kind, actorMemberId: actor,
        ...(kind === 'new_member' ? { role } : {}), hints });
      if (!created.ok) throw new Error(`invite create failed: ${created.error.reason}`);
      const revealed = env.context.invites.reveal(created.invite_id);
      if (!revealed.ok) throw new Error(`invite reveal failed: ${revealed.error.reason}`);
      return { invite: revealed.invite, inviteId: created.invite_id };
    },
    async ownerDirect() { return env.redeemDirect({ kind: 'owner_first', name: 'Olive Owner' }); },
    // Publishes one host event to every subscriber (no audience), as a host subsystem would.
    publishEvent(type, payload = {}) { env.core.events.publish(type, payload); },
    // Closes the host side of every event stream this device holds (the member sees its stream end).
    dropEventStreams(deviceId) { env.core.events.revokeDevice(deviceId); },
    // Writes raw bytes to every open event stream, past the host's own framing (a corrupted frame).
    writeRawToStreams(bytes) {
      for (const client of env.core.events.events.clients) client.response.write(bytes);
    },
    // A host process restart: the bridge goes away, a new core with a new boot epoch comes up.
    async restartHost() {
      await host.stopHostBridge();
      await env.restart();
      await host.startHostBridge();
    },
    log(level, event, fields) { logs.push({ level, event, fields: fields ?? {} }); },
    serviceOptions(extra = {}) {
      return {
        userDataPath: userData,
        getSecureStore: () => secureStore,
        sendState: (snapshot) => states.push(JSON.parse(JSON.stringify(snapshot))),
        spawnChild: memberSpawner,
        appVersion: '1.6.1',
        log: host.log,
        backoff: { initialMs: 20, maxMs: 80 },
        pendingPollMs: 30,
        requestTimeoutMs: 3000,
        ...extra,
      };
    },
    createService(extra = {}) {
      const { createTeamService } = require('../../services/team/team-service');
      const service = createTeamService(host.serviceOptions(extra));
      services.push(service);
      return service;
    },
    files: () => readTree(userData),
    lastState(teamId) {
      const last = states[states.length - 1];
      return last ? last.teams.find((team) => team.team_id === teamId) || null : null;
    },
    async waitForState(teamId, state, { attempts = 250, interval = 20 } = {}) {
      const ok = await waitUntil(() => host.lastState(teamId)?.state === state, { attempts, interval });
      if (!ok) throw new Error(`team never reached ${state}; last ${JSON.stringify(host.lastState(teamId))}`);
      return host.lastState(teamId);
    },
    liveMemberChildren() { return memberSpawner.children.filter((child) => !child.exited); },
  };
  if (startBridge) await host.startHostBridge();
  t.after(async () => {
    host.releaseDials();
    for (const service of services) await service.stopAll().catch(() => {});
    await host.stopHostBridge().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  });
  return host;
}

function randomSeed() {
  return new Uint8Array(crypto.randomBytes(32));
}

// A temporary user data directory, removed when the test ends.
function tempProfile(t, prefix = 'jenny-team-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Joins through the service: the first owner with no `owner`, else a member invited (and admitted) by `owner`.
async function joinAs(host, service, { owner, role = 'member', admit = true, name = 'Mika Member' } = {}) {
  const { invite } = owner
    ? await host.invite({ actor: owner.member_id, role })
    : await host.invite({ kind: 'owner_first' });
  const joined = await service.handle('join', { invite, display_name: name, label: 'Laptop' });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  const teamId = parseInvite(invite).team_id;
  if (owner && admit) {
    const admitted = await host.env.store.admit({ actorMemberId: owner.member_id, memberId: joined.team.member_id });
    assert.equal(admitted.ok, true);
  }
  return { teamId, ...joined.team };
}

module.exports = {
  HINT, createMemorySecureStore, createTeamClientHost, joinAs, pause, randomSeed, readTree, tempProfile, waitUntil,
};
