'use strict';

// Registers the team.* IPC (row 123, slice 1f-1): the desktop member client.
// This module is the only team code loaded at startup, and only when the `team`
// flag is on. It registers one handler per team invoke descriptor behind the
// trusted-sender authorizer; services/team/ loads on the first team call. Saved
// memberships connect once the backend reports ready (the same moment main.js
// starts its deferred services, after the window exists), never at boot, and
// only when <userData>/team/ holds a team directory. One shutdown task stops
// every bridge. A payload is never logged: join carries the invite string.
//
// Slice 1f-2: the `team.host*` methods go to the team host controller
// (services/team/host/), required on the first host call, never at startup. The
// same shutdown task stops the host child alongside the member client.
//
// Slice 2a-4b: the `team.chat*` methods reach the same service (its chat
// clients); their pushes go out on `team.onChat`. A payload is never logged:
// chat methods carry message text and drafts.
//
// Slice 4b member wiring: the service gets one team engine (services/team/team-engine.js,
// a port per online team). The backend reads it through two options (`getTeamEngine`,
// `getTeamEnginePort`: the selected team's port only) and a `turnRoute` getter that answers
// the port's turn route only while the turn runs on that very port. A team or port change
// clears the backend's cached model list; the selected team's port starting re-initializes the
// sidecar, and its team going, its port stopping or this registration's dispose clears the selection.
// Nothing team-side loads before the first team call.
//
// Slice 4e: the service also gets this PC's GPU sharing (services/team/node/team-sharing.js), which reads the
// member's local engine from the backend on every look and counts the member's own running chats as busy
// (backend-chat-stream.js `hasActiveChatStreams`, loaded on the first look). It stops with the service.
//
// E64: Force local means no team networking. `readOfflineMode` reads the mode (none wired counts as on) and
// `subscribeConfig` hears every saved config change; the mode is compared on each (never the reason). The gate
// (services/team/force-local-hold.js) is made with the first service or host, and both always get it: nothing
// under services/team/ loads for a change while neither exists. The listener goes with dispose.
//
// Owner report (Team page stuck on reconnecting): a host state that moves to `running` asks an already loaded member
// service to dial that host's team now (`retryTeam`), so this PC's own row does not wait out its backoff.

const fs = require('node:fs');
const path = require('node:path');

const { JENNY_SHELL_BRIDGE_DESCRIPTORS, registerIpcInvokeHandlers } = require('../ipc-contract');
const { resolveManagedServerOwner } = require('../backend/managed-server-owner');
const { resolveOpenAICompatibleApiUrl } = require('../backend/managed-sidecar-config-model');
const { isTeamModelId, liveTeamSelection } = require('../backend/team-engine-models');
const { clearModelListCaches } = require('../backend/backend-model-list');
const { TEAM_DIR, TEAM_DIR_NAME } = require('./team-data-probe');

function noop() {}

const HOST_METHOD = /^host[A-Z]/u;

function teamMethods() {
  return Object.keys(JENNY_SHELL_BRIDGE_DESCRIPTORS)
    .filter((key) => key.startsWith('team.') && JENNY_SHELL_BRIDGE_DESCRIPTORS[key].kind === 'invoke');
}

// True when <userData>/team/ holds at least one team directory; reads directory names only.
function hasSavedTeams(userDataPath) {
  if (typeof userDataPath !== 'string' || !userDataPath) return false;
  try {
    return fs.readdirSync(path.join(userDataPath, TEAM_DIR), { withFileTypes: true })
      .some((entry) => entry.isDirectory() && TEAM_DIR_NAME.test(entry.name));
  } catch {
    return false;
  }
}

// The backend's start is over: up with a model, up without one (startup loading off, or a load that failed), or
// failed. A team's people and chat need no local model, so the saved teams start in each of them. Waiting for
// 'ready' alone left a launch with no model holding no team: no team row, no names, and a Start that asked the
// owner to reclaim a place this Jenny still held (owner, 2026-11-16).
const STARTED_PHASES = new Set(['ready', 'model_unavailable', 'failed']);

// Calls `fn` once the backend's start is over; returns a function that cancels the wait.
function whenBackendReady(backendService, fn) {
  if (!backendService || typeof backendService.on !== 'function') return noop;
  let status;
  try { status = backendService.getBackendStatus?.() || null; } catch { status = null; }
  if (status && STARTED_PHASES.has(status.phase)) {
    const handle = setImmediate(fn);
    return () => clearImmediate(handle);
  }
  const onStatus = (next) => {
    if (!STARTED_PHASES.has(next?.phase)) return;
    backendService.off?.('backend-status', onStatus);
    fn();
  };
  backendService.on('backend-status', onStatus);
  return () => backendService.off?.('backend-status', onStatus);
}

// The port's turn route while this turn runs on it: the engine is openai-compatible, the endpoint it
// resolves to is the selected team's ready engine port. Otherwise null, so a local turn acquires nothing.
function teamTurnRoute(backend, port) {
  if (!port || !liveTeamSelection(backend)) return null;
  const owner = resolveManagedServerOwner(backend, resolveOpenAICompatibleApiUrl(backend));
  if (owner?.kind !== 'team-engine' || owner.manager !== port || owner.status.state !== 'ready') return null;
  return port.turnRoute;
}

// Puts the team engine on the backend; returns the function that takes it off again.
function wireBackend(backend, getEngine, log) {
  if (!backend || typeof backend !== 'object') return noop;
  const options = backend.options && typeof backend.options === 'object' ? backend.options : null;
  const selectedPort = () => {
    const selection = backend._teamEngineSelection;
    return selection ? getEngine()?.portFor(selection.teamId) || null : null;
  };
  if (options) Object.assign(options, { getTeamEngine: getEngine, getTeamEnginePort: selectedPort });
  const own = Object.getOwnPropertyDescriptor(backend, 'turnRoute');
  // A host composition's route (services/host) is never replaced.
  const wired = !own || (own.configurable !== false && own.value == null && !own.get);
  if (wired) {
    Object.defineProperty(backend, 'turnRoute', { configurable: true, enumerable: false,
      get: () => teamTurnRoute(backend, selectedPort()) });
  } else log('WARN', 'team.engine.turn_route_taken');
  return () => {
    if (options) { delete options.getTeamEngine; delete options.getTeamEnginePort; }
    if (wired) delete backend.turnRoute;
  };
}

// The team selection goes with its team or its port (TEAM_NODE_PROTOCOL_SPEC "4b member wiring as
// built"): a chat on that team model then reloads and is refused, a chat with no model loads its own.
function clearTeamSelection(backend, teamId = null) {
  const selection = backend?._teamEngineSelection;
  if (!selection || (teamId !== null && selection.teamId !== teamId)) return;
  backend._teamEngineSelection = null;
  if (isTeamModelId(backend.currentModel)) backend.currentModel = '';
}

// The member's own work for GPU sharing: the backend's own active-stream rule.
function sharingIsBusy(backendService) {
  let streams = null;
  return () => {
    streams = streams || require('../backend/backend-chat-stream');
    return streams.hasActiveChatStreams(backendService);
  };
}

function registerTeam(ipcMainLike, {
  featureFlags = null, backendService = null, userDataPath = '', getSecureStore = () => null,
  sendBridgeEvent = noop, authorization = {}, getMainLifecycle = () => null, appVersion = '', log = noop,
  serviceOptions = {}, loadService = () => require('../team/team-service'),
  hostOptions = {}, loadHost = () => require('../team/host/host-controller'),
  loadHostLaunch = () => require('../team/host/host-launch'), loadEngine = () => require('../team/team-engine'),
  loadSharing = () => require('../team/node/team-sharing'), readOfflineMode = null, subscribeConfig = null,
  loadHold = () => require('../team/force-local-hold'), modelSources = null,
} = {}) {
  // Fail closed: a missing flag map or a flag that is not exactly true registers nothing.
  if (!featureFlags || featureFlags.team !== true) return { registered: false, getService: () => null, dispose: noop };
  let service = null;
  let host = null;
  let engine = null;
  let gate = null;
  let disposed = false;

  // The one Force local gate; the host is released before the members, each part asked only while it exists.
  function getGate() {
    if (!gate) {
      gate = loadHold().createForceLocalHold({ readMode: readOfflineMode, log });
      gate.attach('host', { hold: () => host?.holdForceLocal?.(), release: () => host?.releaseForceLocal?.(),
        interrupt: () => host?.interruptForceLocal?.(), announce: () => host?.pushState?.() });
      gate.attach('service', { hold: () => service?.holdForceLocal?.(), release: () => service?.releaseForceLocal?.(),
        interrupt: () => service?.interruptForceLocal?.(), announce: () => service?.pushState?.() });
    }
    return gate;
  }

  function portChanged(teamId) {
    clearModelListCaches(backendService);
    if (disposed || liveTeamSelection(backendService)?.teamId !== teamId) return;
    // A selection whose port stopped or is not serving is cleared, never pointed anywhere else.
    if (engine?.portFor(teamId)?.getStatus?.()?.state !== 'ready') { clearTeamSelection(backendService, teamId); return; }
    void Promise.resolve(backendService.refreshManagedConfig?.('team_engine_changed'))
      .catch(() => log('WARN', 'team.engine.refresh_failed'));
  }

  function getService() {
    if (!service && !disposed) {
      engine = loadEngine().createTeamEngine({ log, onPortChange: portChanged,
        onTeamGone: (teamId) => clearTeamSelection(backendService, teamId),
        onListChange: () => { if (!disposed) clearModelListCaches(backendService); } });
      const teamSharing = loadSharing().createTeamSharing({ userDataPath, log,
        getBackend: () => (disposed ? null : backendService),
        isBusy: sharingIsBusy(backendService) });
      service = loadService().createTeamService({
        userDataPath, getSecureStore, appVersion, log, teamEngine: engine, teamSharing,
        sendState: (snapshot) => { if (!disposed) sendBridgeEvent('team.onState', snapshot); },
        sendChat: (payload) => { if (!disposed) sendBridgeEvent('team.onChat', payload); },
        sendProject: (payload) => { if (!disposed) sendBridgeEvent('team.onProject', payload); },
        sendModel: (payload) => { if (!disposed) sendBridgeEvent('team.onModel', payload); },
        sendBoard: (payload) => { if (!disposed) sendBridgeEvent('team.onBoard', payload); },
        ...serviceOptions, gate: getGate(),
        // Slice 6-5: the `team_model_sharing` kill switch is read at each model call (default on: only `false` turns it
        // off); discovery and the model roots are late-bound (the engine handlers register after this).
        modelOptions: { sources: modelSources, enabled: () => featureFlags.team_model_sharing !== false,
          ...(serviceOptions.modelOptions || {}) },
      });
    }
    return service;
  }

  // The host's last pushed state: only a move to running asks, and only a service that exists (nothing loads for it).
  let hostState = null;
  function hostStateChanged(snapshot) {
    const was = hostState;
    hostState = snapshot?.state ?? null;
    if (hostState === 'running' && was !== 'running' && typeof snapshot.team_id === 'string') service?.retryTeam?.(snapshot.team_id, 'host_running');
  }

  function getHost() {
    if (!host && !disposed) {
      const launch = loadHostLaunch();
      host = loadHost().createHostController({
        userDataPath, getSecureStore, getTeamService: getService, platform: process.platform,
        isPackaged: launch.electronIsPackaged, fork: launch.electronFork, entryPath: launch.HOST_ENTRY,
        environment: launch.hostEnvironment(), lockPython: () => launch.desktopPythonExecutable(backendService), log,
        pick: { folder: launch.electronPickFolder, file: launch.electronPickBackup, open: launch.electronOpenFolder },
        sendState: (snapshot) => { if (!disposed) { sendBridgeEvent('team.onHostState', snapshot); hostStateChanged(snapshot); } },
        ...hostOptions, gate: getGate(),
      });
    }
    return host;
  }

  const handlers = {};
  for (const methodPath of teamMethods()) {
    const method = methodPath.slice('team.'.length);
    if (HOST_METHOD.test(method)) {
      handlers[methodPath] = (event, payload) => {
        const active = getHost();
        if (!active) return { ok: false, error: { code: 'invalid_request', reason: 'team_disposed' } };
        // The asking window: a backup picked for Restore is kept per window and dropped when it goes.
        return active.handle(method, payload, { sender: event?.sender ?? null });
      };
      continue;
    }
    handlers[methodPath] = (_event, payload) => {
      const active = getService();
      if (!active) return { ok: false, error: { code: 'invalid_request', reason: 'team_disposed' } };
      return active.handle(method, payload);
    };
  }
  registerIpcInvokeHandlers(ipcMainLike, handlers, authorization);

  const unwire = wireBackend(backendService, () => (disposed ? null : engine), log);

  let unsubscribe = noop;
  try {
    const off = typeof subscribeConfig === 'function' ? subscribeConfig(() => { if (!disposed) void gate?.changed(); }) : null;
    if (typeof off === 'function') unsubscribe = off;
  } catch { log('WARN', 'team.force_local.subscribe_failed'); }

  const cancelWait = whenBackendReady(backendService, () => {
    if (disposed || !hasSavedTeams(userDataPath)) return;
    void Promise.resolve().then(() => getService()?.startExisting()).then(async () => {
      // Start with Jenny (host-autostart.js): the host controller is made only when the owner turned it on.
      const autostart = disposed ? null : require('../team/host/host-autostart');
      if (autostart?.readAutostart(userDataPath)) await autostart.launchStart({ getHost, getService, log });
    }).catch(() => log('WARN', 'team.start_failed'));
  });

  async function dispose() {
    disposed = true;
    cancelWait();
    unsubscribe();
    clearTeamSelection(backendService);
    unwire();
    engine = null;
    const active = service;
    const activeHost = host;
    service = null;
    host = null;
    // Settled, not all: one stop that fails must not abandon the other.
    const results = await Promise.allSettled([activeHost?.stop(), active?.stopAll()]);
    if (results.some((result) => result.status === 'rejected')) log('WARN', 'team.dispose.stop_failed');
  }

  let lifecycle;
  try { lifecycle = getMainLifecycle?.() || null; } catch { lifecycle = null; }
  if (typeof lifecycle?.registerShutdownTask === 'function') lifecycle.registerShutdownTask(dispose);

  return { registered: true, getService: () => service, getHost: () => host, dispose,
    forceLocalIdle: () => gate?.idle() ?? Promise.resolve() };
}

module.exports = { registerTeam, sharingIsBusy };
