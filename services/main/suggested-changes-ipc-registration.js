'use strict';

// suggestedChanges.* IPC (row 35, Propose mode). Every handler sits behind the
// trusted-sender authorizer: accept writes workspace files through the sidecar.
// Payloads are plain objects; the service validates ids and transitions.

const { registerIpcInvokeHandlers } = require('../ipc-contract');

const DECISIONS = new Set(['reject', 'later', 'restore', 'ungroup']);

function payloadOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sessionIdOf(payload) {
  const id = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  return id && id.length <= 128 ? id : '';
}

function registerSuggestedChangesIpc(ipcMain, { backendService, authorization }) {
  const service = () => backendService?.suggestedChanges || null;
  const unavailable = { ok: false, error: 'unavailable' };
  const withSession = (fn) => (_event, raw) => {
    const payload = payloadOf(raw);
    const sessionId = sessionIdOf(payload);
    if (!sessionId) return { ok: false, error: 'invalid_session' };
    const target = service();
    return target ? fn(target, sessionId, payload) : unavailable;
  };
  return registerIpcInvokeHandlers(ipcMain, {
    'suggestedChanges.list': withSession((target, sessionId) => (
      target.list(sessionId) || { ok: false, error: 'not_found' }
    )),
    'suggestedChanges.decide': withSession((target, sessionId, payload) => (
      DECISIONS.has(payload.decision)
        ? target.decide({ sessionId, id: payload.id, decision: payload.decision, reason: payload.reason })
        : { ok: false, error: 'invalid_decision' }
    )),
    'suggestedChanges.comment': withSession((target, sessionId, payload) => (
      target.comment({ sessionId, id: payload.id, text: payload.text })
    )),
    'suggestedChanges.sendComments': withSession((target, sessionId, payload) => target.sendComments({
      sessionId,
      undo: payload && payload.undo && Array.isArray(payload.undo.ids) && typeof payload.undo.sent_at === 'string'
        ? { ids: payload.undo.ids.filter((item) => typeof item === 'string').slice(0, 200), sent_at: payload.undo.sent_at }
        : null,
    })),
    'suggestedChanges.discardPending': withSession((target, sessionId) => target.discardPending({ sessionId })),
    'suggestedChanges.accept': withSession((target, sessionId, payload) => target.accept({
      sessionId,
      id: payload.id,
      revision: Number.isSafeInteger(payload.revision) ? payload.revision : null,
      force: payload.force === true,
    })),
  }, authorization);
}

module.exports = { registerSuggestedChangesIpc };
