'use strict';

/*
 * computer-use-ipc-registration.js: the computer tool's bridge methods (row 196, C4).
 *
 * Maps `computerUse.*` (services/ipc-contract/descriptors-addons.js) onto the lazy holder
 * (services/main/computer-use-composition.js). Nothing here starts the service: status, grants,
 * resume and stop read what has started, so opening the Tools menu or Settings costs nothing.
 * The owner's program list is read and written here (Settings > Tools > Computer); a program is
 * added only through main's own file picker, so the renderer never names a path to add.
 * Every answer is { ok, ... } or { ok: false, reason }. A hosted server has none of it.
 */

const path = require('path');
const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { computerBlockReason } = require('../backend/computer-use-tool-gate');
const { STOP_KEY: STOP_CHORD } = require('../computer-use/turn-overlay'); // requires nothing itself
const SESSION_ID_MAX = 200;
const PATH_MAX = 1024;
const TURN_STATES = new Set(['thinking', 'step', 'paused', 'idle']);

// Method paths; the channels live with the descriptors (services/ipc-contract/descriptors-addons.js).
const CHANNELS = Object.freeze({
  status: 'computerUse.status',
  grants: 'computerUse.grants',
  revoke: 'computerUse.revoke',
  resume: 'computerUse.resume',
  stop: 'computerUse.stop',
  listPrograms: 'computerUse.listPrograms',
  addProgram: 'computerUse.addProgram',
  renameProgram: 'computerUse.renameProgram',
  removeProgram: 'computerUse.removeProgram',
});

const safely = (read, fallback) => {
  try { return read(); } catch { return fallback; }
};
const refusal = (reason) => ({ ok: false, reason });

function plainPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

function cleanString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : '';
}

/** The program's name from its file: `C:\Games\Game\game.exe` is `game`. */
function nameFromPath(programPath) {
  return path.win32.basename(programPath).replace(/\.exe$/i, '').slice(0, 120) || 'Program';
}

function registerComputerUseIpc(ipcMain, {
  getHolder, getBackendService, dialog = null, getMainWindow = () => null, sendBridgeEvent = () => {},
  authorization, platform = process.platform, isHostedServer = () => false,
}) {
  const holder = () => safely(getHolder, null);
  const service = () => safely(() => holder()?.peek?.() || null, null);
  const windows = platform === 'win32';
  let lastRegistered = null;

  function status() {
    const reason = safely(isHostedServer, true) !== false ? 'disabled' : safely(() => computerBlockReason(getBackendService(), { platform }), 'disabled');
    const registered = safely(() => service()?.stopChordRegistered?.(), null);
    return {
      ok: true, available: reason === null, reason, stopChord: STOP_CHORD,
      stopChordRegistered: typeof registered === 'boolean' ? registered : null,
    };
  }

  // A chat id the renderer sends must name a chat that exists.
  function sessionOf(payload) {
    const sessionId = cleanString(plainPayload(payload).sessionId, SESSION_ID_MAX);
    if (!sessionId) return '';
    const known = safely(() => getBackendService()?.sessionStore?.peekSession?.(sessionId), null);
    return known ? sessionId : '';
  }

  function grantsOf(sessionId) {
    const list = safely(() => service()?.grants?.(sessionId), []);
    return (Array.isArray(list) ? list : []).map((grant) => ({
      name: String(grant?.name || ''), path: String(grant?.program || ''), viewOnly: grant?.kind === 'view_only',
    })).filter((grant) => grant.path);
  }

  function programs() {
    return safely(() => holder()?.ownerPrograms?.(), null);
  }

  const handlers = {
    [CHANNELS.status]: async () => status(),
    [CHANNELS.grants]: async (_event, payload) => {
      const sessionId = sessionOf(payload);
      if (!sessionId) return refusal('bad_request');
      return { ok: true, grants: grantsOf(sessionId) };
    },
    [CHANNELS.revoke]: async (_event, payload) => {
      const sessionId = sessionOf(payload);
      const programPath = cleanString(plainPayload(payload).path, PATH_MAX);
      if (!sessionId || !programPath) return refusal('bad_request');
      // Only one of this chat's own grants, exactly as listed.
      if (!grantsOf(sessionId).some((grant) => grant.path === programPath)) return { ok: true, revoked: false };
      return { ok: true, revoked: safely(() => service()?.revoke?.(sessionId, programPath) === true, false) };
    },
    [CHANNELS.resume]: async (_event, payload) => {
      const sessionId = sessionOf(payload);
      if (!sessionId) return refusal('bad_request');
      const running = service();
      if (!running) return { ok: true, held: false };
      try { return await running.resume(sessionId); } catch { return refusal('helper_failed'); }
    },
    [CHANNELS.stop]: async (_event, payload) => {
      const sessionId = sessionOf(payload);
      if (!sessionId) return refusal('bad_request');
      const running = service();
      if (!running) return { ok: true, held: false };
      return safely(() => running.stop(sessionId), { ok: true, held: false });
    },
    [CHANNELS.listPrograms]: async () => {
      const store = programs();
      if (!store) return refusal('unavailable');
      try {
        return { ok: true, programs: (await store.list()).map((item) => ({ name: item.name, path: item.program })) };
      } catch {
        return refusal('unreadable');
      }
    },
    [CHANNELS.addProgram]: async () => {
      if (!windows) return refusal('unsupported_platform');
      const store = programs();
      if (!store || !dialog?.showOpenDialog) return refusal('unavailable');
      let picked;
      try {
        const options = { properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }] };
        const parent = safely(getMainWindow, null);
        picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      } catch {
        return refusal('cancelled');
      }
      const programPath = picked?.canceled ? '' : cleanString(picked?.filePaths?.[0], PATH_MAX);
      if (!programPath) return refusal('cancelled');
      const program = { name: nameFromPath(programPath), program: programPath };
      const added = await store.add(program);
      return added?.ok ? { ok: true, program: { name: program.name, path: programPath } } : refusal(added?.reason || 'write_failed');
    },
    [CHANNELS.renameProgram]: async (_event, payload) => {
      const store = programs();
      const { path: programPath, name } = plainPayload(payload);
      if (!store || !cleanString(programPath, PATH_MAX) || typeof name !== 'string') return refusal('bad_request');
      // Rename only an entry that is there: add() replaces the entry with the same file.
      const current = await store.list();
      const { normalizeProgramPath } = require('../computer-use/program-rules');
      if (!current.some((item) => normalizeProgramPath(item.program) === normalizeProgramPath(programPath))) return refusal('not_found');
      const renamed = await store.add({ name, program: programPath });
      return renamed?.ok ? { ok: true } : refusal(renamed?.reason || 'write_failed');
    },
    [CHANNELS.removeProgram]: async (_event, payload) => {
      const store = programs();
      const programPath = cleanString(plainPayload(payload).path, PATH_MAX);
      if (!store || !programPath) return refusal('bad_request');
      return { ok: true, removed: (await store.remove(programPath)) === true };
    },
  };

  // Pushes: the turn state without the screen point (that is only for placing the pill), and the status
  // when the Stop key's registration becomes known or changes (it is known only once the watch starts).
  safely(() => holder()?.subscribeTurnState?.((state) => {
    if (!state || typeof state.sessionId !== 'string' || !TURN_STATES.has(state.state)) return;
    sendBridgeEvent('computerUse.onTurnState', {
      sessionId: state.sessionId, state: state.state, action: String(state.action || ''), programName: String(state.programName || ''),
    });
    // The full status (config reads) only when the registration actually changed: at most once per watch start.
    const registered = safely(() => service()?.stopChordRegistered?.(), null);
    if (typeof registered === 'boolean' && registered !== lastRegistered) {
      lastRegistered = registered;
      sendBridgeEvent('computerUse.onStatus', status());
    }
  }), null);

  registerIpcInvokeHandlers(ipcMain, handlers, authorization);
}

module.exports = { CHANNELS, STOP_CHORD, nameFromPath, registerComputerUseIpc };
