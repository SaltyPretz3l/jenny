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
//
// The owner's relay token arrives only in the parent's `start` and is never
// logged. This file is the only caller of `judgeReach` and sender of `reach`.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadHostConfig } = require('../config');
const { FileSecretStore, TEAM_HOST_SECRET_FILES } = require('../file-secret-store');
const { assertStartable } = require('./maintenance-markers');
const { assertSafeFile } = require('../../services/host/path-guard');
const { chatRoster, createTeamChatHost } = require('../../services/host/team-chat-host');
const { ClientRegistry } = require('../client-registry');
const { ControlLeases, projectLeaseRevoker } = require('../control-leases');
const { log, acquireConfiguredProfile, assertTeamProjectsRoot, createHostCore, diskRootsFor } = require('../host-core');
const { createAuthorizer } = require('./authorize');
const { PUBLIC_KEY_BYTES, decodeBase64url, encodeBase64url, keyPairFromSeed } = require('./ids');
const { createInviteService, parsePublicAddress, readInternetSetting } = require('./invites');
const { MemberStore } = require('./member-store');
const { REVOKE_EVENT_KINDS } = require('./membership-events');
const { mintOwnerInvite, mintRecoveryInvite } = require('./owner-bootstrap');
const { createRateLimiter } = require('./rate-limit');
const { createTeamBoardHost } = require('./boards/team-board-host');
const { startSweeps } = require('./sweep-timer');
const { announceTeamDeleted } = require('./team-deleted-notice');
const { safeLogger } = require('./safe-logger');
const { writeReadyMarker, removeReadyMarker } = require('./ready-marker');
const { createTeamApprovals } = require('./team-approvals');
const { createTeamCommands } = require('./team-commands');
const { createProjectAnnouncer, createTeamProjectCommands, subscribeProjectChanges } = require('./team-project-commands');
const { createProjectDeleter } = require('./team-project-delete');
const { startTeamProjectRules } = require('./team-project-rules');
const { reconcileProjects } = require('./team-project-reconcile');
const { createProjectFolders } = require('./project-folders');
const { createTeamProjectFiles } = require('./team-project-files');
const { createTeamModelSharing, memberStreamFanOut } = require('./model-sharing');
const { createModelRelayLink } = require('./model-relay-link');
const { createTeamListener } = require('./team-http-server');
const { createChatAttachmentRoutes } = require('./chat-attachment-routes');
const { createPoolComposition } = require('./pool-composition');
const { ENGINE_ACTION, TEAM_RESOURCE, createEngineRoutes: defaultEngineRoutes } = require('./engine-routes');
const { createNodeRates: defaultNodeRates, createTeamNodeCommands } = require('./node-commands');
const { createNodeRoutes } = require('./node-routes');
const { USAGE_LOG_FILE, UsageLog } = require('./usage-log');
const { createHostBridge } = require('./transport/host-bridge');
const { judgeReach } = require('./transport/reach');

const CLIENT_CAPACITY = 64;
const CLIENT_CAPACITY_PER_DEVICE = 4;
const EVENT_CLIENT_CAPACITY = 64;
const BOOT_SECRET_BYTES = 32;
// Admin commands: 30 per member per minute (spec "Limits").
const TEAM_COMMAND_LIMIT = Object.freeze({ limit: 30, windowMs: 60_000, maxKeys: 64 });
// Bridge changes this close together are judged once.
const REACH_DEBOUNCE_MS = 250;
// How long after ready a router that has not answered is still "checking"; then Jenny could not tell.
const CHECKING_BOUND_MS = 60_000;
// How long a new invite waits for the router's answer to the port mapping request, under the member
// client's 15 s request bound; the router usually answers within three.
const INVITE_MAPPING_WAIT_MS = 8000;
// services/team/host/host-supervisor.js MAX_ADDRESSES.
const READY_MAX_ADDRESSES = 16;
// The trash sweep runs after ready and then once a day (slice 3-4b; the spec leaves the period open).
const TRASH_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function failure(reason) {
  return Object.assign(new Error(reason), { reason });
}

// The project folders (slice 3-4b): the trash is the folder named `trash` beside the projects root (the
// desktop layout's `team-host/trash`), made here if absent, one level only. A host with no projects root
// has neither, and a trash that cannot sit apart from the root is none: `trash` then refuses at use.
function projectFolders(createFolders, projectsRoot, { clock, logger }) {
  if (!projectsRoot) return createFolders({ projectsRoot: null, trashRoot: null, clock, logger });
  const trashRoot = path.join(path.dirname(projectsRoot), 'trash');
  try {
    fs.mkdirSync(trashRoot);
  } catch (error) {
    // Already there is the normal case; anything else is one reason word (never the path).
    if (error?.code !== 'EEXIST') safeLogger(logger)('WARN', 'team_project.trash_unavailable', { reason: 'trash_mkdir_failed' });
  }
  try {
    return createFolders({ projectsRoot, trashRoot, clock, logger });
  } catch {
    // Reached for a projects root at a drive or filesystem root (`G:\`, `/`): its parent is itself, so the
    // trash would sit inside the root and the folder module refuses it. Such a host has no trash.
    safeLogger(logger)('WARN', 'team_project.trash_unavailable', { reason: 'trash_inside_root' });
    return createFolders({ projectsRoot, trashRoot: null, clock, logger });
  }
}

function reasonOf(error) {
  if (typeof error?.reason === 'string') return error.reason;
  return error?.message === 'host_child_exit_unconfirmed' ? error.message : 'team_unavailable';
}

// Who may use the pooled GPUs (owner decisions E6 and E37), by the
// one authorization function through any active device of the member: `engine.use`
// (owner and full member) and, for a conversation's turn, `session.write` on that
// conversation (its project resolved by the authorizer). No device, a refusal or a
// degraded directory answers false.
function poolAccess({ store, authorize }) {
  return (memberId, sessionId) => {
    const device = store.listDevices(memberId).find((entry) => store.directory.isDeviceActive(entry.device_id));
    if (!device) return false;
    const actor = { device_id: device.device_id };
    if (authorize(actor, ENGINE_ACTION, TEAM_RESOURCE).ok !== true) return false;
    return sessionId === null || authorize(actor, 'session.write', { kind: 'session', id: sessionId }).ok === true;
  };
}

// The revoke fan-out (spec "Revocation fan-out"): separate subscribers so that one
// that throws marks the store degraded while the rest still run. An owner transfer
// changes the previous owner's role: the event names the new owner and both owners'
// devices, so the previous owner's are the event's devices less the new owner's.
// With a pool, every membership or role change asks again about every shared GPU (a node
// whose device may no longer share leaves at once), then about every live lease.
function subscribeRevokeFanOut({ store, clients, leases, events, parent, dropKey, pool = null, nodes = null }) {
  const revokes = REVOKE_EVENT_KINDS;
  const each = (event, action) => { for (const deviceId of event.device_ids) action(deviceId); };
  const subscribe = (listener) => store.onMembershipChange(listener);
  const previousOwnerDevices = (event) => {
    const newOwner = new Set(store.listDevices(event.member_id).map((device) => device.device_id));
    return event.device_ids.filter((deviceId) => !newOwner.has(deviceId));
  };
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
      else if (event.kind === 'owner_transferred') for (const id of previousOwnerDevices(event)) leases.revokeDevice(id);
    }),
    subscribe((event) => { if (revokes.has(event.kind)) each(event, (id) => events.revokeDevice(id)); }),
    ...(pool ? [subscribe((event) => {
      const { kind } = event;
      if (!(revokes.has(kind) || kind === 'role_changed' || kind === 'owner_transferred')) return;
      nodes?.recheck();
      pool.recheckLeases();
    })] : []),
    subscribe((event) => { parent?.send({ type: 'membership_changed', kind: event.kind, member_id: event.member_id }); }),
    // X3b-F01: an invite a commit ended (revoked, in a cascade, pruned once expired) gives back its bridge slots at once.
    store.onInviteKeysEnded((keys) => { for (const key of keys) dropKey(key); }),
  ];
}

// The shape of a team start: every step either succeeds or throws a reason.
async function startTeamHost(configPath, parent, options = {}) {
  const {
    teamInit = false, teamRecover = false, spawnBridge = null, createListener = createTeamListener,
    createBackend, acquireProfileImpl, keyTimeoutMs = 10_000, logger = log, randomBytes = crypto.randomBytes,
    createPool = createPoolComposition, createEngineRoutes = defaultEngineRoutes, clock = Date.now,
    createNodeRates = defaultNodeRates, createInvites = createInviteService, networkInterfaces = os.networkInterfaces,
    reachDebounceMs = REACH_DEBOUNCE_MS, inviteMappingWaitMs = INVITE_MAPPING_WAIT_MS, createFolders = createProjectFolders, sweepIntervalMs = TRASH_SWEEP_INTERVAL_MS,
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
  let pool = null;
  let engineRoutes = null;
  let nodeCommands = null;
  let nodeRoutes = null;
  let listener = null;
  let bridge = null;
  let invites = null;
  let files = null;
  // The owner's relay token from `start`, a string for the whole run (it cannot be zeroed; spec 5-5a limits).
  let relayToken = null;
  let reachTimer = null;
  let checkingTimer = null;
  let relayLink = null; // slice 6-7: the owner's relay setting and the passing count, from ready on
  let readyAt = null;
  let sweepTimer = null;
  let sentReach = null;
  let sentMapped = null;
  const unsubscribes = [];
  let keyWaiter = null;
  let endStartWait = null;
  let pendingKey = null;
  let keyTaken = false;
  // Slice 5-6: tells connected members the team was deleted (set once the event core exists).
  let onDeleting = null;
  let errorSent = false;

  let settleStopped;
  const stopped = new Promise((resolve, reject) => { settleStopped = { resolve, reject }; });
  stopped.catch(() => {});

  const alive = () => { if (stopRequested) throw failure('team_start_cancelled'); };

  async function teardown() {
    if (tearingDown) return stopped;
    tearingDown = true;
    ready = false;
    if (reachTimer !== null) clearTimeout(reachTimer);
    reachTimer = null;
    if (checkingTimer !== null) clearTimeout(checkingTimer);
    checkingTimer = null;
    // A sweep already running is not awaited: it ends on its own (its removals are bounded).
    if (sweepTimer !== null) clearInterval(sweepTimer);
    sweepTimer = null;
    const errors = [];
    const attempt = async (step) => { try { await step(); } catch (error) { errors.push(error); } };
    if (lock) await attempt(() => removeReadyMarker({ userDataPath: lockedUserData }));
    if (bridge) await attempt(() => bridge.stop());
    // The engine routes before the pool, on every path: their requests end as cancelled, their leases go back.
    if (engineRoutes) await attempt(() => engineRoutes.stop());
    // Waiting node claims end before the pool stops.
    if (nodeCommands) await attempt(() => nodeCommands.dispose());
    if (chat) await attempt(() => chat.dispose());
    if (files) await attempt(() => files.close());
    if (invites) await attempt(() => invites.dispose());
    if (listener) await attempt(() => listener.close());
    if (coreHandle) await attempt(() => coreHandle.dispose());
    // The pool goes after the host core (its sidecar is the gateway's only client), whatever failed before.
    if (pool) await attempt(() => pool.stop());
    for (const unsubscribe of unsubscribes.splice(0).reverse()) await attempt(unsubscribe);
    hostKey?.fill(0);
    bootSecret?.fill(0);
    pendingKey?.fill(0);
    relayToken = null;
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
    if (endStartWait) endStartWait();
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
    if (!parent) say('ERROR', 'team.start_failed', { reason: reasonOf(error) }); // headless: no parent hears it
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

  // A timed wait inside the start (the member store's bounded wait for a busy
  // audit log); stop() ends it at once.
  function startWait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { endStartWait = null; resolve(); }, ms);
      endStartWait = () => { clearTimeout(timer); endStartWait = null; resolve(); };
    });
  }

  function onParentMessage(message) {
    if (message.type === 'stop') { stop(); return; }
    if (message.type === 'team_deleting') { onDeleting?.(); return; }
    if (message.type === 'model_relay') { relayLink?.set(message.flowing); return; }
    // The first key wins; a later one is ignored, also once the key is in use.
    if (pendingKey || keyTaken) return;
    pendingKey = decodeBase64url(message.host_key, PUBLIC_KEY_BYTES);
    relayToken = message.relay_token ?? null;
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

    // 4. An unfinished delete, restore (R09-F02) or import blocks start; a stale ready marker goes.
    assertStartable(config.userDataPath);
    removeReadyMarker({ userDataPath: config.userDataPath });
    assertTeamProjectsRoot(config); // 3-11: a missing root is named, before any folder, core or disk probe

    // 5. The member store.
    store = new MemberStore({ userDataPath: config.userDataPath, hostPublicKey: publicKey, teamName: config.team.name, logger, assertSafePath: assertSafeFile });
    const opened = await store.openAtStart({ wait: startWait, alive });
    alive();
    if (!opened.ok) throw failure(opened.error.reason);

    // 6. The shared composition, in team mode.
    const clients = new ClientRegistry({ capacity: CLIENT_CAPACITY, perDeviceCapacity: CLIENT_CAPACITY_PER_DEVICE });
    const leases = new ControlLeases();
    // A conversation's project comes from the host's own session index; before the
    // core exists, or for an id or summary without one, it is General (owner only).
    let core = null;
    // A direct conversation's participants come from the chat store, which is built just below.
    const sessionProject = (id) => core?.composition?.backend?.sessionStore?.peekSessionSummary?.(id)?.project_id ?? null;
    const { authorize, sessionScope } = createAuthorizer({ directory: store.directory, sessionProject, dmParticipants: (channelId) => chat?.store?.participantsOf(channelId) });
    // Approvals (slice 3-6b): the viewer store, the project audit log (opened before any command) and their hooks.
    const approvals = createTeamApprovals({ userDataPath: config.userDataPath, authorize, sessionProject, logger, clock, assertSafePath: assertSafeFile });
    approvals.open();
    invites = createInvites({ store, logger });
    // Lazy: the commands and the listener are built before the bridge exists.
    const addresses = () => (bridge ? bridge.addresses() : []);
    // Internet joining as invites.js `inviteContent` takes it: null while off, else exactly its five fields.
    const internet = config.team.internet ?? null;
    const internetSetting = () => {
      if (!internet) return null;
      const mapping = bridge ? bridge.mapping() : null;
      return { direct_port: config.team.directPort, mapped: mapping?.state === 'mapped' ? mapping.external : null,
        public_address: internet.publicAddress, relay_url: internet.relayUrl,
        relay_token: internet.relayUrl ? relayToken : null };
    };
    // For a new invite: the router's answer is in, or the bound has passed (host-bridge.js `mappingSettled`).
    const mappingSettled = () => (bridge ? bridge.mappingSettled(inviteMappingWaitMs) : Promise.resolve());
    // The router's outside address, told to the parent when it moved: main builds the reconnect code from it.
    const reportMapped = () => {
      if (!ready || !parent || !bridge) return;
      const external = internetSetting()?.mapped ?? null;
      if (external === sentMapped) return;
      parent.send({ type: 'mapped', external });
      sentMapped = external;
    };
    // The verdict from what the bridge, the owner and the interfaces say now; the table is read once.
    const judgeNow = () => {
      let interfaces;
      try { interfaces = networkInterfaces(); } catch { interfaces = null; }
      const stats = bridge.stats();
      return judgeReach({ internet: internet ? { ...internet } : null, mapping: bridge.mapping(),
        entered: internet?.publicAddress ? parsePublicAddress(internet.publicAddress, config.team.directPort) : null,
        interfaces, direct_external: stats.directExternalConnections ?? null,
        relay_configured: Boolean(internet?.relayUrl), relay: bridge.relay(),
        checking_expired: readyAt !== null && clock() - readyAt >= CHECKING_BOUND_MS });
    };
    // Sends `reach` when the verdict moved since the last one sent; only a ready host with a parent judges.
    const reportReach = () => {
      if (!ready || !parent || !bridge) return;
      const verdict = judgeNow();
      const word = `${verdict.result}/${verdict.reason}`;
      if (word === sentReach) return;
      parent.send({ type: 'reach', result: verdict.result, reason: verdict.reason });
      sentReach = word;
    };
    const onBridgeChange = () => {
      if (reachTimer !== null || tearingDown) return;
      reachTimer = setTimeout(() => {
        reachTimer = null;
        // A bridge getter or a send that throws leaves the last verdict sent standing; a timer must not crash the child.
        try { reportReach(); reportMapped(); } catch { say('WARN', 'team.reach_judge_failed'); }
      }, reachDebounceMs);
      reachTimer.unref?.();
    };
    const dropKey = (publicKeyText) => {
      const bytes = decodeBase64url(publicKeyText, PUBLIC_KEY_BYTES);
      if (!bytes || !bridge) return 0;
      try { return bridge.drop(bytes); } catch { return 0; }
    };
    // Team chat: its own store on this profile; a store that fails to open stops chat, not the host.
    const publish = (type, payload, options) => core?.events.publish(type, payload, options);
    onDeleting = () => announceTeamDeleted({ store, publish });
    chat = createTeamChatHost({ profileDir: config.userDataPath, directory: store.directory, logger,
      maxResponseBytes: config.resourceLimits?.maxResponseBytes, roster: chatRoster(store), publish });
    // Shared projects (slice 3-4a): the application project service and the chat store are read
    // lazily, since the core and the chat store do not exist yet.
    const announce = createProjectAnnouncer({ directory: store.directory, logger, publish });
    const folders = projectFolders(createFolders, config.team.projectsRoot ?? null, { clock, logger });
    // Project boards (row 151): the store on `<profile>/team-boards`, its commands, routes and sweeps (boards/team-board-host.js).
    const boards = createTeamBoardHost({ userDataPath: config.userDataPath, directory: store.directory, sessionProject, publish, clock, logger, assertSafePath: assertSafeFile,
      audit: approvals.append, diskRoots: diskRootsFor(config), statfs: options.statfs });
    // One deleter for the command and the start-up reconcile; the core is read lazily.
    const deleter = createProjectDeleter({ store, folders, router: () => core?.router ?? null, boards: () => boards.store,
      sessionStore: () => core?.composition?.backend?.sessionStore ?? null,
      records: () => core?.composition?.backend?.projectService ?? null, chat: () => chat?.store ?? null, rules: () => rules, logger });
    const projects = createTeamProjectCommands({ store, directory: store.directory, logger, announce, folders, deleter,
      projects: () => core?.composition?.backend?.projectApplicationService ?? null, chat: () => chat?.store ?? null });
    // "Always allowed" rules (slice 3-12): the store (opened before any command), the commands and the backend port.
    const rules = startTeamProjectRules({ userDataPath: config.userDataPath, memberStore: store, approvals, clock, logger,
      serialized: projects.serialized, publish, backend: () => core?.composition?.backend ?? null, assertSafePath: assertSafeFile });
    // Sharing a GPU (slice 4c host): the node commands and the two raw node routes read the pool
    // lazily (it is built below, only with a `pool` block) and share one per-node rate limit.
    const nodeRates = createNodeRates();
    // Slice 4e: list rows name each PC (the device label), the list carries the team model, and
    // team_pool_nodes goes out on the host's events once the pool exists (watch() below).
    nodeCommands = createTeamNodeCommands({ pool: () => pool, directory: store.directory, authorize, rates: nodeRates,
      logger, publish, names: () => store.poolNames() });
    nodeRoutes = createNodeRoutes({ pool: () => pool, rates: nodeRates, logger });
    // Project files (slice 3-8b): the transfer core on `<profile>/team-uploads`, the shared audit (Windows: 3-8c).
    files = createTeamProjectFiles({ userDataPath: config.userDataPath, folders, store, authorize, logger, clock,
      serialized: projects.serialized, audit: approvals.audit, backend: () => core?.composition?.backend ?? null,
      publish, projectsRoot: config.team.projectsRoot ?? null, randomBytes });
    await files.open();
    alive();
    let usageLog = null;
    const models = createTeamModelSharing({ flowing: config.team.modelRelayFlowing, store, authorize, publish, logger, clock });
    const teamCommands = createTeamCommands({ store, invites, directory: store.directory, logger, internet: internetSetting, settle: mappingSettled,
      addresses, limiter: createRateLimiter(TEAM_COMMAND_LIMIT), chat: chat.commands, projects, nodes: nodeCommands,
      usage: () => usageLog, projectAudit: approvals.audit, files: files.commands, rules: rules.commands, models: models.commands, boards: boards.commands,
      admitChatBoard: boards.admitChat });
    // The pool (slice 4a-4), only with a `pool` block: its gateway is the backend's model endpoint, a
    // derived config in memory (the file is never rewritten), and its key the sidecar's credential.
    let coreConfig = config;
    let poolInputs = {};
    if (config.team.pool) {
      pool = createPool({ contextLength: config.team.pool.contextLength, logger, mayUsePool: poolAccess({ store, authorize }),
        teamModel: () => store.poolNames()?.team_model ?? null });
      const { modelEndpoint } = await pool.start();
      alive();
      coreConfig = Object.freeze({ ...config, modelEndpoint: Object.freeze(modelEndpoint) });
      poolInputs = { turnRoute: pool.turnRoute, modelCredential: pool.modelCredential };
      nodeCommands.watch();
    }
    // The team engine routes (slice 4b), on a team host only: without a pool they answer
    // team_pool_unavailable, and a usage file that cannot be loaded refuses chat, not the start.
    usageLog = new UsageLog({ filePath: path.join(config.userDataPath, USAGE_LOG_FILE), clock, logger,
      assertSafePath: assertSafeFile });
    usageLog.openAtStart(); // a file refused for its content is set aside (E46's rule, slice 3-4b)
    engineRoutes = createEngineRoutes({ pool, usageLog, clock, logger });
    try {
      core = createHostCore({ config: coreConfig, clients, leases, authorize, guardRequired: true, maxEventClients: EVENT_CLIENT_CAPACITY,
        logger, createBackend, teamCommands, sessionScope, teamApprovals: rules.withApprovals(approvals), ...poolInputs });
    } catch (error) { coreHandle = error.hostCore ?? null; throw error; }
    coreHandle = core;

    // 7. The revoke fan-out, before anything can connect.
    unsubscribes.push(...subscribeRevokeFanOut({ store, clients, leases, events: core.events, parent, dropKey, pool,
      nodes: nodeCommands }));
    unsubscribes.push(...approvals.attach({ core, store }), ...files.attach(), ...rules.attach({ core, store }), ...models.attach(),
      ...boards.attach({ core, store }));
    unsubscribes.push(subscribeProjectChanges({ store, announce, pool: () => pool, logger,
      revokeLeases: projectLeaseRevoker({ leases, sessionProject }),
      dropViewers: (event) => { try { approvals.dropForProject(event); } finally { boards.dropForProject(event); } },
      dropFiles: files.dropForProject }));
    await chat.start();
    alive();

    // 8. The boot secret and the listener.
    bootSecret = Buffer.from(randomBytes(BOOT_SECRET_BYTES));
    const notifyMembership = (kind, memberId) => {
      parent?.send({ type: 'membership_changed', kind, member_id: memberId });
    };
    const chatFiles = createChatAttachmentRoutes({ chat: () => chat, logger, diskRoots: diskRootsFor(config), statfs: options.statfs });
    const context = Object.freeze({
      config, bootEpoch: core.bootEpoch, bootSecret, store, directory: store.directory, invites, authorize, sessionScope,
      clients, leases, events: core.events, router: core.router,
      // The asset and artifact routes answer first, as before; the engine and node routes take only their paths.
      assetRoutes: async (ctx) => await core.assetRoutes(ctx) || await engineRoutes(ctx) || await nodeRoutes(ctx)
        || await files.routes(ctx) || await chatFiles(ctx) || await models.routes(ctx) || await boards.routes(ctx),
      resourceLimits: config.resourceLimits, isReady: () => ready,
      addresses, bulkStreams: () => Boolean(bridge?.bulk()), dropKey, notifyMembership, logger, approvals, models, // approvals, models: read by start-up tests only
      // Presence (2a-3b), the viewers' last-stream rule (3-6b) and model senders' presence (6-3): each stream's open and close.
      onMemberStream: memberStreamFanOut({ chat, approvals, models, boards }, logger),
    });
    listener = await createListener(context);
    alive();

    // 9. The backend, before anyone can connect. A model that is down does not stop the host.
    await core.startBackend();
    alive();
    if (pool) {
      const backend = core.composition.backend;
      pool.bindRuntime({ lanes: backend.sessionRuntime?.lanes });
    }
    // Shared projects a crash left half made or half deleted (slice 3-4b), before anyone can connect.
    // Bounded; a failure is logged and never stops the start.
    await reconcileProjects({ store, projects: core.composition?.backend?.projectApplicationService ?? null, folders,
      records: () => core?.composition?.backend?.projectService ?? null, chat: chat.store ?? null, logger, deleter, alive });
    alive();

    // 10. The transport bridge: from here members reach the listener.
    try {
      bridge = createHostBridge({ spawnChild: spawnBridge ?? undefined, secretKey: hostKey,
        directPort: config.team.directPort ?? undefined, loopbackPort: listener.port, bootSecret,
        admit: (keyBytes) => store.directory.admitKind(encodeBase64url(keyBytes)),
        internet: internet?.mapPort ? { mapPort: true } : null,
        relay: internet?.relayUrl ? { url: internet.relayUrl, token: relayToken } : null,
        onChange: onBridgeChange,
        log: (event, fields) => logger('INFO', event, fields),
        onDown: () => {
          say('ERROR', 'team.transport_down');
          // A requested stop is not a transport failure: the parent hears `stopped` alone. No in-process
          // test reaches this branch (the window between `ready` and teardown's bridge.stop() holds no
          // real I/O wait); it guards a real bridge child that exits in that window.
          if (!stopRequested) sendError(failure('team_transport_down'));
          stop().catch(() => {});
        } });
      await bridge.start();
    } catch { throw failure('team_transport_down'); }
    alive();

    // 11. Ready.
    if (parent) {
      parent.send({ type: 'ready', boot_epoch: core.bootEpoch, team_id: store.teamId(), public_key: publicKey,
        // The supervisor drops a `ready` with more addresses (a PC with many virtual adapters has them).
        addresses: bridge.addresses().slice(0, READY_MAX_ADDRESSES) });
    } else {
      writeReadyMarker({ userDataPath: config.userDataPath, bootEpoch: core.bootEpoch });
    }
    ready = true;
    readyAt = clock();
    if (parent) { relayLink = createModelRelayLink({ sharing: models, send: (m) => parent.send(m) }); unsubscribes.push(() => relayLink.dispose()); }
    say('INFO', 'team.listening', { boot_epoch: core.bootEpoch });
    reportReach();
    reportMapped();
    checkingTimer = setTimeout(() => {
      checkingTimer = null;
      try { reportReach(); } catch { say('WARN', 'team.reach_judge_failed'); }
    }, CHECKING_BOUND_MS);
    checkingTimer.unref?.();
    // The sweeps (project folder trash, slice 3-4b; deleted boards, row 151 T1): after ready, never awaited, then
    // on a timer; teardown clears it. The folder trash is swept only with a projects root.
    sweepTimer = startSweeps({ intervalMs: sweepIntervalMs, warn: (event) => say('WARN', event), tasks: [
      ...(folders.hasRoot ? [['team.project_trash_sweep_failed', () => folders.sweepTrash()]] : []),
      ...boards.sweeps] });

    // 12. The first owner's invite, or the owner's recovery invite, after `ready`.
    if (mintsOwnerInvite) {
      const carried = readInternetSetting(internetSetting);
      const minted = teamRecover
        ? await mintRecoveryInvite({ invites, addresses: bridge.addresses(), internet: carried })
        : await mintOwnerInvite({ store, invites, addresses: bridge.addresses(), internet: carried });
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
