'use strict';

// The team host's start and stop sequence (TEAM_MEMBERSHIP_SPEC "Team mode of
// the host"). It wires the member store, the shared host composition, the
// transport bridge and the parent channel together. The listener is a seam: the
// default is the preamble listener in front of the team HTTP layer, and a test
// may inject its own.
//
// Fail closed: a host that cannot get its key, open its store or start its
// transport serves nothing and holds nothing. Logs and parent messages carry
// event names, reasons, ids and counts only: never the host key, an invite
// string, the team name or an address.

const crypto = require('node:crypto');

const { loadHostConfig } = require('../config');
const { FileSecretStore, TEAM_HOST_SECRET_FILES } = require('../file-secret-store');
const { assertImportComplete } = require('../../services/host/maintenance-commands');
const { assertSafeFile } = require('../../services/host/path-guard');
const { chatRoster, createTeamChatHost } = require('../../services/host/team-chat-host');
const { ClientRegistry } = require('../client-registry');
const { ControlLeases } = require('../control-leases');
const { log, acquireConfiguredProfile, createHostCore } = require('../host-core');
const { createAuthorizer } = require('./authorize');
const { PUBLIC_KEY_BYTES, decodeBase64url, encodeBase64url, keyPairFromSeed } = require('./ids');
const { createInviteService } = require('./invites');
const { MemberStore } = require('./member-store');
const { REVOKE_EVENT_KINDS } = require('./membership-events');
const { mintOwnerInvite, mintRecoveryInvite } = require('./owner-bootstrap');
const { createRateLimiter } = require('./rate-limit');
const { safeLogger } = require('./safe-logger');
const { writeReadyMarker, removeReadyMarker } = require('./ready-marker');
const { createTeamCommands } = require('./team-commands');
const { createTeamListener } = require('./team-http-server');
const { createHostBridge } = require('./transport/host-bridge');

const CLIENT_CAPACITY = 64;
const CLIENT_CAPACITY_PER_DEVICE = 4;
const EVENT_CLIENT_CAPACITY = 64;
const BOOT_SECRET_BYTES = 32;
// Admin commands: 30 per member per minute (spec "Limits").
const TEAM_COMMAND_LIMIT = Object.freeze({ limit: 30, windowMs: 60_000, maxKeys: 64 });

function failure(reason) {
  return Object.assign(new Error(reason), { reason });
}

function reasonOf(error) {
  if (typeof error?.reason === 'string') return error.reason;
  return error?.message === 'host_child_exit_unconfirmed' ? error.message : 'team_unavailable';
}

// The revoke fan-out (spec "Revocation fan-out"): five separate subscribers so
// that one that throws marks the store degraded while the rest still run.
function subscribeRevokeFanOut({ store, clients, leases, events, parent, dropKey }) {
  const revokes = REVOKE_EVENT_KINDS;
  const each = (event, action) => { for (const deviceId of event.device_ids) action(deviceId); };
  const subscribe = (listener) => store.onMembershipChange(listener);
  return [
    subscribe((event) => {
      if (!revokes.has(event.kind)) return;
      const devices = store.listDevices(event.member_id);
      each(event, (deviceId) => {
        const device = devices.find((entry) => entry.device_id === deviceId);
        if (device) dropKey(device.public_key);
      });
    }),
    subscribe((event) => { if (revokes.has(event.kind)) each(event, (id) => clients.revokeDevice(id)); }),
    subscribe((event) => {
      if (revokes.has(event.kind) || event.kind === 'role_changed') each(event, (id) => leases.revokeDevice(id));
    }),
    subscribe((event) => { if (revokes.has(event.kind)) each(event, (id) => events.revokeDevice(id)); }),
    subscribe((event) => { parent?.send({ type: 'membership_changed', kind: event.kind, member_id: event.member_id }); }),
  ];
}

// The shape of a team start: every step either succeeds or throws a reason.
async function startTeamHost(configPath, parent, options = {}) {
  const {
    teamInit = false, teamRecover = false, spawnBridge = null, createListener = createTeamListener,
    createBackend, acquireProfileImpl, keyTimeoutMs = 10_000, logger = log, randomBytes = crypto.randomBytes,
  } = options;
  parent = parent ?? null;
  // This file's own log lines: a logger that throws must not break a start or a stop.
  const say = safeLogger(logger);

  let starting = true;
  let stopRequested = false;
  let tearingDown = false;
  let ready = false;
  let lock = null;
  let lockedUserData = null;
  let hostKey = null;
  let bootSecret = null;
  let store = null;
  let chat = null;
  let coreHandle = null;
  let listener = null;
  let bridge = null;
  const unsubscribes = [];
  let keyWaiter = null;
  let pendingKey = null;
  let keyTaken = false;
  let errorSent = false;

  let settleStopped;
  const stopped = new Promise((resolve, reject) => { settleStopped = { resolve, reject }; });
  stopped.catch(() => {});

  const alive = () => { if (stopRequested) throw failure('team_start_cancelled'); };

  async function teardown() {
    if (tearingDown) return stopped;
    tearingDown = true;
    ready = false;
    const errors = [];
    const attempt = async (step) => { try { await step(); } catch (error) { errors.push(error); } };
    if (lock) await attempt(() => removeReadyMarker({ userDataPath: lockedUserData }));
    if (bridge) await attempt(() => bridge.stop());
    if (chat) await attempt(() => chat.dispose());
    if (listener) await attempt(() => listener.close());
    if (coreHandle) await attempt(() => coreHandle.dispose());
    for (const unsubscribe of unsubscribes.splice(0).reverse()) await attempt(unsubscribe);
    hostKey?.fill(0);
    bootSecret?.fill(0);
    pendingKey?.fill(0);
    // A child whose exit is uncertain keeps the profile lock (exit watchdog is the boundary).
    if (lock && (!coreHandle || coreHandle.canReleaseLock())) await attempt(() => lock.release());
    if (errors.length > 0) {
      sendError(errors[0]);
      say('ERROR', 'team.stop_failed', { reason: reasonOf(errors[0]) });
      settleStopped.reject(errors[0]);
    } else {
      if (stopRequested) parent?.send({ type: 'stopped' });
      settleStopped.resolve();
    }
    return stopped;
  }

  const stop = () => {
    stopRequested = true;
    if (keyWaiter) keyWaiter(null);
    if (!starting) teardown().catch(() => {});
    return stopped;
  };

  // The parent hears one error per host, the first.
  function sendError(error) {
    if (errorSent) return;
    errorSent = true;
    parent?.send({ type: 'error', reason: reasonOf(error) });
  }

  async function failStart(error) {
    if (!stopRequested) sendError(error);
    try { await teardown(); } catch { say('ERROR', 'team.cleanup_failed'); }
    throw error;
  }

  function waitForKey() {
    if (pendingKey) return Promise.resolve(pendingKey);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { keyWaiter = null; resolve(null); }, keyTimeoutMs);
      keyWaiter = (value) => { clearTimeout(timer); keyWaiter = null; resolve(value); };
    });
  }

  function onParentMessage(message) {
    if (message.type === 'stop') { stop(); return; }
    // The first key wins; a later one is ignored, also once the key is in use.
    if (pendingKey || keyTaken) return;
    pendingKey = decodeBase64url(message.host_key, PUBLIC_KEY_BYTES);
    if (keyWaiter) keyWaiter(pendingKey);
  }

  try {
    // 1. The configuration and the channel it needs.
    const preflight = loadHostConfig(configPath);
    if (!preflight.team) throw failure('team_config_required');
    if (teamInit && teamRecover) throw failure('invalid_arguments');
    const mintsOwnerInvite = teamInit || teamRecover;
    if ((mintsOwnerInvite || preflight.team.keySource === 'parent_channel') && !parent) {
      throw failure('team_parent_required');
    }
    if (parent) unsubscribes.push(parent.onMessage(onParentMessage));

    // 2. The exclusive profile lock; losing it stops the host.
    const acquired = await acquireConfiguredProfile(configPath, {
      acquireProfileImpl,
      onLost: () => { say('ERROR', 'team.profile_lock_lost'); stop().catch(() => {}); },
    });
    lock = acquired.lock;
    const config = acquired.config;
    lockedUserData = config.userDataPath;
    if (!config.team) throw failure('team_config_required');
    alive();

    // 3. The host key: from the parent, or from the mounted secret file.
    let seed;
    if (config.team.keySource === 'parent_channel') {
      seed = await waitForKey();
      alive();
      if (!seed) throw failure('team_key_timeout');
    } else {
      let value = null;
      try {
        value = new FileSecretStore({ directory: config.secretsDir, files: TEAM_HOST_SECRET_FILES }).get('team_host_key');
      } catch { value = null; }
      seed = decodeBase64url(value, PUBLIC_KEY_BYTES);
      if (!seed) throw failure('team_host_key_invalid');
    }
    hostKey = Buffer.from(seed);
    seed.fill(0);
    keyTaken = true;
    pendingKey = null;
    const { publicKey } = keyPairFromSeed(hostKey);

    // 4. An unfinished import blocks start; a stale ready marker goes.
    assertImportComplete(config.userDataPath);
    removeReadyMarker({ userDataPath: config.userDataPath });

    // 5. The member store.
    store = new MemberStore({ userDataPath: config.userDataPath, hostPublicKey: publicKey,
      teamName: config.team.name, logger, assertSafePath: assertSafeFile });
    const opened = store.open();
    if (!opened.ok) throw failure(opened.error.reason);

    // 6. The shared composition, in team mode.
    const clients = new ClientRegistry({ capacity: CLIENT_CAPACITY, perDeviceCapacity: CLIENT_CAPACITY_PER_DEVICE });
    const leases = new ControlLeases();
    const { authorize } = createAuthorizer({ directory: store.directory });
    const invites = createInviteService({ store, logger });
    // Lazy: the commands and the listener are built before the bridge exists.
    const addresses = () => (bridge ? bridge.addresses() : []);
    const dropKey = (publicKeyText) => {
      const bytes = decodeBase64url(publicKeyText, PUBLIC_KEY_BYTES);
      if (!bytes || !bridge) return 0;
      try { return bridge.drop(bytes); } catch { return 0; }
    };
    // Team chat: its own store on this profile; a store that fails to open stops chat, not the host.
    let core = null;
    chat = createTeamChatHost({ profileDir: config.userDataPath, directory: store.directory, logger,
      maxResponseBytes: config.resourceLimits?.maxResponseBytes, roster: chatRoster(store),
      publish: (type, payload, options) => core?.events.publish(type, payload, options) });
    const teamCommands = createTeamCommands({ store, invites, directory: store.directory, logger,
      addresses, limiter: createRateLimiter(TEAM_COMMAND_LIMIT), chat: chat.commands });
    try {
      core = createHostCore({ config, clients, leases, authorize, guardRequired: true,
        maxEventClients: EVENT_CLIENT_CAPACITY, logger, createBackend, teamCommands });
    } catch (error) { coreHandle = error.hostCore ?? null; throw error; }
    coreHandle = core;

    // 7. The revoke fan-out, before anything can connect.
    unsubscribes.push(...subscribeRevokeFanOut({ store, clients, leases, events: core.events, parent, dropKey }));
    await chat.start();
    alive();

    // 8. The boot secret and the listener.
    bootSecret = Buffer.from(randomBytes(BOOT_SECRET_BYTES));
    const notifyMembership = (kind, memberId) => {
      parent?.send({ type: 'membership_changed', kind, member_id: memberId });
    };
    const context = Object.freeze({
      config, bootEpoch: core.bootEpoch, bootSecret, store, directory: store.directory, invites, authorize,
      clients, leases, events: core.events, router: core.router, assetRoutes: core.assetRoutes,
      resourceLimits: config.resourceLimits, isReady: () => ready,
      addresses, dropKey, notifyMembership, logger,
      // Presence (slice 2a-3b): the listener reports each member stream's open and close.
      onMemberStream: chat.onMemberStream,
    });
    listener = await createListener(context);
    alive();

    // 9. The backend, before anyone can connect. A model that is down does not stop the host.
    await core.startBackend();
    alive();

    // 10. The transport bridge: from here members reach the listener.
    try {
      bridge = createHostBridge({ spawnChild: spawnBridge ?? undefined, secretKey: hostKey,
        directPort: config.team.directPort ?? undefined, loopbackPort: listener.port, bootSecret,
        admit: (keyBytes) => store.directory.admitKind(encodeBase64url(keyBytes)),
        log: (event, fields) => logger('INFO', event, fields),
        onDown: () => {
          say('ERROR', 'team.transport_down');
          sendError(failure('team_transport_down'));
          stop().catch(() => {});
        } });
      await bridge.start();
    } catch { throw failure('team_transport_down'); }
    alive();

    // 11. Ready.
    if (parent) {
      parent.send({ type: 'ready', boot_epoch: core.bootEpoch, team_id: store.teamId(), public_key: publicKey,
        addresses: bridge.addresses() });
    } else {
      writeReadyMarker({ userDataPath: config.userDataPath, bootEpoch: core.bootEpoch });
    }
    ready = true;
    say('INFO', 'team.listening', { boot_epoch: core.bootEpoch });

    // 12. The first owner's invite, or the owner's recovery invite, after `ready`.
    if (mintsOwnerInvite) {
      const minted = teamRecover
        ? await mintRecoveryInvite({ invites, addresses: bridge.addresses() })
        : await mintOwnerInvite({ store, invites, addresses: bridge.addresses() });
      if (!minted.ok) throw failure(minted.error.reason);
      if (minted.minted) parent.send({ type: 'owner_invite', invite: minted.invite });
      else parent.send({ type: 'owner_exists' });
      alive();
    }

    starting = false;
    return { stop, stopped, bootEpoch: core.bootEpoch, publicKey, port: listener.port };
  } catch (error) {
    return failStart(error);
  }
}

module.exports = { startTeamHost };
