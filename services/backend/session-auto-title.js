'use strict';

// Row 112: after the first reply of a new chat persists, one short preemptible
// background call asks the local model for a 2-6 word name and replaces the
// clipped first-message title. Never throws, never retries (eligibility ends
// with the second user message), and never overwrites a name the user chose.
//
// Team host (row 175 item 10, owner decision D4): the host's own conversation takes the same name after
// its first answer. It borrows one pool lease through the conversation's turn route (the prompter's member
// id, the conversation's model and allowed nodes) and never waits for one: a busy pool, or a next turn
// queued or running in that conversation, skips the name and the clipped first question stays. The lease
// token rides as `route_token`. The team-engine route is never used. Kill switch JENNY_ENABLE_TEAM_TITLES=0.

const { buildFeatureFlagDefaults } = require('../feature-flags');
const { API_VERSION } = require('./sidecar-client');
const { acquireTurnRoute } = require('./turn-route');
const { normalizeMessageAuthor } = require('./message-author');
const { requestRuntimeInference } = require('./backend-runtime-inference');
const { isDefaultSessionTitle } = require('./interactive-session-utils');
const { PLUGIN_SESSION_TYPE, readSessionType } = require('./session-type');
// The title rule the send path applies, so the stored title can be recognised.
const { deriveSessionTitleFromMessage } = require('../../renderer/shared/string-utils');
const { stubBoardBlocks } = require('../boards/board-fence');

const METHOD = 'session.generate_title';
const MAX_MESSAGE_CHARS = 2000;
const inFlight = new WeakMap();
// These answer from a script: an extra call would take the next scripted reply.
const SCRIPTED_ENGINES = new Set(['mock', 'replay']);
// Not faults, and they would repeat after every turn.
const QUIET_SKIPS = new Set(['flag_off', 'scripted_engine', 'team_titles_off']);
// A team host's naming call that finds no free slot or a busy conversation says nothing: the next turn retries.
const QUIET_TEAM_REASONS = new Set(['pool_busy', 'conversation_busy']);
// Statuses of a queued (not yet started) turn in the session runtime.
const QUEUED_WORK = new Set(['pending', 'paused']);
const WORK_PAGES = 8;

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

// A team host is a hosted server that carries a turn route; any other hosted server never names a chat.
function isTeamHost(service) {
  return service?.hostMode === 'server' && Boolean(service.turnRoute);
}

function teamTitlesOn(service) {
  const set = service?.featureFlags?.team_titles;
  return typeof set === 'boolean' ? set : buildFeatureFlagDefaults().team_titles !== false;
}

function hostedSkip(service) {
  if (service?.hostMode !== 'server') return null;
  if (!service.turnRoute) return 'hosted_mode';
  return teamTitlesOn(service) ? null : 'team_titles_off';
}

function skipReason(service) {
  if (service?.featureFlags?.session_model_titles === false) return 'flag_off';
  const hosted = hostedSkip(service);
  if (hosted) return hosted;
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

// A next turn running (an active turn) or queued (pending work) in the conversation. Fails closed.
function conversationBusy(service, sessionId) {
  try {
    if (service.sessionStore?.peekActiveTurn?.(sessionId)) return true;
    const store = service.sessionRuntime?.store;
    if (typeof store?.listSummaries !== 'function') return false;
    let cursor = null;
    for (let page = 0; page < WORK_PAGES; page += 1) {
      const listed = store.listSummaries({ sessionId, cursor, limit: 100 });
      if (listed.items.some((work) => QUEUED_WORK.has(work.status))) return true;
      cursor = listed.next_cursor;
      if (!cursor) return false;
    }
    return false;
  } catch (_error) {
    return true;
  }
}

// The conversation's own turn route, never waiting: `{ token, release }`, or `{ reason }` to skip.
// The prompter is the author of the first (only) user message.
async function acquireTeamRoute(service, sessionId, session) {
  if (conversationBusy(service, sessionId)) return { reason: 'conversation_busy' };
  const firstUser = session.messages.find((m) => m?.role === 'user');
  const params = { session_id: sessionId, execution_context: { project_id: session.project_id || null } };
  try {
    const { release } = await acquireTurnRoute(service, {
      params,
      sessionSummary: { preferred_model: session.preferred_model, allowed_nodes: session.allowed_nodes },
      author: { member_id: normalizeMessageAuthor(firstUser?.author)?.member_id ?? null },
      wait: false,
    });
    return { token: params.route_token, release };
  } catch (error) {
    return { reason: typeof error?.reason === 'string' && error.reason ? error.reason : 'route_unavailable' };
  }
}

async function generate(service, sessionId, requestInference) {
  const session = readSession(service, sessionId);
  if (!isTitleEligible(session)) return { applied: false, reason: 'not_eligible' };
  let route = null;
  if (isTeamHost(service)) {
    route = await acquireTeamRoute(service, sessionId, session);
    if (route.reason) {
      if (!QUIET_TEAM_REASONS.has(route.reason)) log(service, 'INFO', 'session_title.skipped', { sessionId, reason: route.reason });
      return { applied: false, reason: route.reason };
    }
  }
  let outcome = { applied: false, reason: 'generate_failed' };
  try {
    outcome = await requestTitle(service, sessionId, session, requestInference, route);
    return outcome;
  } finally {
    // Once, on every path; a failed call cancels the lease instead of releasing it as used.
    route?.release({ ok: outcome.reason !== 'generate_failed' });
  }
}

async function requestTitle(service, sessionId, session, requestInference, route) {
  const messages = session.messages.filter((m) => m?.role !== 'context');
  const userMessage = text(messages.find((m) => m.role === 'user').content).slice(0, MAX_MESSAGE_CHARS);
  const assistantMessage = stubBoardBlocks(text(messages.filter(isUsableAssistant).pop().content)).slice(0, MAX_MESSAGE_CHARS);
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
      // On a team host the router turns this into session_changed (reason renamed) for the audience.
      service.emitSessionsChanged?.({ session_ids: [sessionId] });
    } catch (_error) { /* the title is stored; the list repaints on its next refresh */ }
  };

  try {
    // Unscoped like suggestions: no session turn lease, so it cannot block a follow-up send.
    await requestInference(service, METHOD, {
      accept_version: API_VERSION,
      user_message: userMessage,
      assistant_message: assistantMessage,
      ...(route ? { route_token: route.token } : {}),
    }, { preemptible: true, consumeResult });
  } catch (error) {
    const reason = typeof error?.reason === 'string' && error.reason && !error.rpc ? error.reason : '';
    if (reason) {
      log(service, 'INFO', 'session_title.skipped', { sessionId, reason });
      return { applied: false, reason };
    }
    // A team host's line carries a reason only: nothing a node or the pool said, never a title or a message.
    log(service, 'WARN', 'session_title.generate_failed', route
      ? { sessionId, reason: 'generate_failed' }
      : { sessionId, message: error?.message || String(error) });
    return { applied: false, reason: 'generate_failed' };
  }
  if (outcome.applied) log(service, 'INFO', 'session_title.generated', { sessionId });
  else if (route && outcome.reason === 'empty_title') log(service, 'WARN', 'session_title.generate_failed', { sessionId, reason: outcome.reason });
  else if (outcome.reason !== 'not_eligible') log(service, 'INFO', 'session_title.skipped', { sessionId, reason: outcome.reason });
  return outcome;
}

module.exports = { isTitleEligible, maybeGenerateSessionTitle };
