'use strict';

// Row 112: after the first reply of a new chat persists, one short preemptible
// background call asks the local model for a 2-6 word name and replaces the
// clipped first-message title. Never throws, never retries (eligibility ends
// with the second user message), and never overwrites a name the user chose.

const { API_VERSION } = require('./sidecar-client');
const { requestRuntimeInference } = require('./backend-runtime-inference');
const { isDefaultSessionTitle } = require('./interactive-session-utils');
const { PLUGIN_SESSION_TYPE, readSessionType } = require('./session-type');
// The title rule the send path applies, so the stored title can be recognised.
const { deriveSessionTitleFromMessage } = require('../../renderer/shared/string-utils');

const METHOD = 'session.generate_title';
const MAX_MESSAGE_CHARS = 2000;
const inFlight = new WeakMap();
// These answer from a script: an extra call would take the next scripted reply.
const SCRIPTED_ENGINES = new Set(['mock', 'replay']);
// Not faults, and they would repeat after every turn.
const QUIET_SKIPS = new Set(['flag_off', 'scripted_engine']);

function text(value) {
  return typeof value === 'string' ? value : '';
}

function isUsableAssistant(message) {
  return message?.role === 'assistant'
    && message.kind !== 'interactive_round_recap'
    && text(message.content).trim() !== '';
}

// Fails closed: anything unexpected is "not eligible", so nothing is overwritten.
function isTitleEligible(session) {
  if (!session || typeof session !== 'object') return false;
  if (session.session_role === 'primary' || readSessionType(session) === PLUGIN_SESSION_TYPE) return false;
  if (session.spawned_from) return false;
  const messages = (Array.isArray(session.messages) ? session.messages : []).filter((m) => m?.role !== 'context');
  const users = messages.filter((m) => m?.role === 'user');
  if (users.length !== 1 || !messages.some(isUsableAssistant)) return false;
  if (isDefaultSessionTitle(session.title)) return true;
  const firstUser = users[0].content;
  return typeof firstUser === 'string' && session.title === deriveSessionTitleFromMessage(firstUser);
}

function readSession(service, sessionId) {
  try {
    return service.sessionStore.getSession(sessionId);
  } catch (_error) {
    return null;
  }
}

function skipReason(service) {
  if (service?.featureFlags?.session_model_titles === false) return 'flag_off';
  if (service?.hostMode === 'server') return 'hosted_mode';
  if (SCRIPTED_ENGINES.has(String(service?.currentEngineType || '').trim().toLowerCase())) return 'scripted_engine';
  if (!service?.sidecarClient) return 'sidecar_unavailable';
  const phase = typeof service.sidecarManager?.getStatus === 'function'
    ? String(service.sidecarManager.getStatus()?.phase || '').trim().toLowerCase()
    : 'ready';
  if (phase !== 'ready') return 'sidecar_not_ready';
  const modelLoaded = service.currentStatus?.model_loaded === true
    || Boolean(String(service.currentModel || '').trim());
  return modelLoaded ? null : 'model_not_loaded';
}

function log(service, level, event, details) {
  try {
    service._emitServiceLog?.(level, event, details);
  } catch (_error) { /* logging never changes the outcome */ }
}

async function maybeGenerateSessionTitle(service, sessionId, { requestInference = requestRuntimeInference } = {}) {
  try {
    const skipped = skipReason(service);
    if (skipped) {
      // Runs after every turn: only a chat that would have been named is worth a line.
      if (!QUIET_SKIPS.has(skipped) && isTitleEligible(readSession(service, sessionId))) {
        log(service, 'INFO', 'session_title.skipped', { sessionId, reason: skipped });
      }
      return { applied: false, reason: skipped };
    }
    const active = inFlight.get(service) || new Set();
    inFlight.set(service, active);
    if (active.has(sessionId)) return { applied: false, reason: 'request_in_flight' };
    active.add(sessionId);
    try {
      return await generate(service, sessionId, requestInference);
    } finally {
      active.delete(sessionId);
    }
  } catch (_error) {
    return { applied: false, reason: 'generate_failed' };
  }
}

async function generate(service, sessionId, requestInference) {
  const session = readSession(service, sessionId);
  if (!isTitleEligible(session)) return { applied: false, reason: 'not_eligible' };
  const messages = session.messages.filter((m) => m?.role !== 'context');
  const userMessage = text(messages.find((m) => m.role === 'user').content).slice(0, MAX_MESSAGE_CHARS);
  const assistantMessage = text(messages.filter(isUsableAssistant).pop().content).slice(0, MAX_MESSAGE_CHARS);
  let outcome = { applied: false, reason: 'not_applied' };

  const consumeResult = (result, { assertNotPreempted } = {}) => {
    assertNotPreempted?.();
    const title = text(result?.title).trim();
    if (!title) {
      outcome = { applied: false, reason: 'empty_title' };
      return;
    }
    // A rename (or a follow-up send) during the call wins.
    if (!isTitleEligible(readSession(service, sessionId))) {
      outcome = { applied: false, reason: 'not_eligible' };
      return;
    }
    // setSessionMeta, not renameSession: no updated_at bump, so the list does not reorder.
    if (!service.sessionStore.setSessionMeta(sessionId, { title })) {
      outcome = { applied: false, reason: 'write_refused' };
      return;
    }
    outcome = { applied: true, reason: 'applied' };
    try {
      service.emitSessionsChanged?.({ session_ids: [sessionId] });
    } catch (_error) { /* the title is stored; the list repaints on its next refresh */ }
  };

  try {
    // Unscoped like suggestions: no session turn lease, so it cannot block a follow-up send.
    await requestInference(service, METHOD, {
      accept_version: API_VERSION,
      user_message: userMessage,
      assistant_message: assistantMessage,
    }, { preemptible: true, consumeResult });
  } catch (error) {
    const reason = typeof error?.reason === 'string' && error.reason && !error.rpc ? error.reason : '';
    if (reason) {
      log(service, 'INFO', 'session_title.skipped', { sessionId, reason });
      return { applied: false, reason };
    }
    log(service, 'WARN', 'session_title.generate_failed', {
      sessionId, message: error?.message || String(error),
    });
    return { applied: false, reason: 'generate_failed' };
  }
  if (outcome.applied) log(service, 'INFO', 'session_title.generated', { sessionId });
  else if (outcome.reason !== 'not_eligible') log(service, 'INFO', 'session_title.skipped', { sessionId, reason: outcome.reason });
  return outcome;
}

module.exports = { isTitleEligible, maybeGenerateSessionTitle };
