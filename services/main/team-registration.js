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

const fs = require('node:fs');
const path = require('node:path');

const { JENNY_SHELL_BRIDGE_DESCRIPTORS, registerIpcInvokeHandlers } = require('../ipc-contract');

const TEAM_DIR_NAME = /^team_[A-Za-z0-9_-]{1,64}$/u;

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
    return fs.readdirSync(path.join(userDataPath, 'team'), { withFileTypes: true })
      .some((entry) => entry.isDirectory() && TEAM_DIR_NAME.test(entry.name));
  } catch {
    return false;
  }
}

// Calls `fn` once the backend is ready; returns a function that cancels the wait.
function whenBackendReady(backendService, fn) {
  if (!backendService || typeof backendService.on !== 'function') return noop;
  let status;
  try { status = backendService.getBackendStatus?.() || null; } catch { status = null; }
  if (status && status.phase === 'ready') {
    const handle = setImmediate(fn);
    return () => clearImmediate(handle);
  }
  const onStatus = (next) => {
    if (next?.phase !== 'ready') return;
    backendService.off?.('backend-status', onStatus);
    fn();
  };
  backendService.on('backend-status', onStatus);
  return () => backendService.off?.('backend-status', onStatus);
}

function registerTeam(ipcMainLike, {
  featureFlags = null, backendService = null, userDataPath = '', getSecureStore = () => null,
  sendBridgeEvent = noop, authorization = {}, getMainLifecycle = () => null, appVersion = '', log = noop,
  serviceOptions = {}, loadService = () => require('../team/team-service'),
  hostOptions = {}, loadHost = () => require('../team/host/host-controller'),
  loadHostLaunch = () => require('../team/host/host-launch'),
} = {}) {
  // Fail closed: a missing flag map or a flag that is not exactly true registers nothing.
  if (!featureFlags || featureFlags.team !== true) return { registered: false, getService: () => null, dispose: noop };
  let service = null;
  let host = null;
  let disposed = false;

  function getService() {
    if (!service && !disposed) {
      service = loadService().createTeamService({
        userDataPath, getSecureStore, appVersion, log,
        sendState: (snapshot) => { if (!disposed) sendBridgeEvent('team.onState', snapshot); },
        ...serviceOptions,
      });
    }
    return service;
  }

  function getHost() {
    if (!host && !disposed) {
      const launch = loadHostLaunch();
      host = loadHost().createHostController({
        userDataPath, getSecureStore, getTeamService: getService, platform: process.platform,
        isPackaged: launch.electronIsPackaged, fork: launch.electronFork, entryPath: launch.HOST_ENTRY,
        environment: launch.hostEnvironment(), lockPython: () => launch.desktopPythonExecutable(backendService), log,
        sendState: (snapshot) => { if (!disposed) sendBridgeEvent('team.onHostState', snapshot); },
        ...hostOptions,
      });
    }
    return host;
  }

  const handlers = {};
  for (const methodPath of teamMethods()) {
    const method = methodPath.slice('team.'.length);
    if (HOST_METHOD.test(method)) {
      handlers[methodPath] = (_event, payload) => {
        const active = getHost();
        if (!active) return { ok: false, error: { code: 'invalid_request', reason: 'team_disposed' } };
        return active.handle(method, payload);
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

  const cancelWait = whenBackendReady(backendService, () => {
    if (disposed || !hasSavedTeams(userDataPath)) return;
    void Promise.resolve().then(() => getService()?.startExisting()).catch(() => log('WARN', 'team.start_failed'));
  });

  async function dispose() {
    disposed = true;
    cancelWait();
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

  return { registered: true, getService: () => service, getHost: () => host, dispose };
}

module.exports = { registerTeam };
