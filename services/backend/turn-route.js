'use strict';

// A turn route: an optional port a host composition puts on the backend
// (`service.turnRoute`, null or absent by default). For one managed chat.send it
// answers an opaque per-request routing token that rides the request as
// `route_token`, and a release that runs once when that send is over. The
// backend knows nothing about who issues the token or what it routes to.
//
// The token is held only in the chat.send params object and the sidecar's stdin:
// never in a log line, an error message, an event or a durable record. The route
// may also answer the model it leased ({ id, context_length }); its valid parts
// ride as `model_profile`, so the turn is sized for that model. That is not secret.

const { createCancellationError } = require('./chat-stream-terminal-utils');
const { modelProfileFields, routeTokenFields } = require('./chat-send-optional-fields');

const REASON_PATTERN = /^[a-z][a-z0-9_]{0,79}$/u;

function routeError(reason, { code = '', retryable = false } = {}) {
  const safeReason = REASON_PATTERN.test(reason) ? reason : 'turn_route_unavailable';
  const error = new Error(`The turn could not be routed (${safeReason}).`);
  // error_code is what the terminal error payload carries; code keeps the route's own.
  error.error_code = safeReason;
  error.reason = safeReason;
  if (typeof code === 'string' && code) error.code = code;
  error.retryable = retryable === true;
  return error;
}

function carriesImage(params) {
  return Array.isArray(params?.attachments) && params.attachments.some((entry) => entry?.kind === 'image');
}

function releaseOnce(handle) {
  let released = false;
  return ({ ok = false } = {}) => {
    if (released) return;
    released = true;
    try { handle?.release?.({ ok: ok === true }); } catch (_error) { /* a release never throws into the turn */ }
  };
}

/**
 * Acquires the turn route for one chat.send and puts its token on `params`.
 * Returns `{ release({ ok }) }`, which runs at most once. A refusal, an abort or
 * a malformed token throws, after releasing: a routed backend never sends
 * without its token.
 */
async function acquireTurnRoute(service, { params, sessionSummary, author, signal }) {
  const route = service.turnRoute;
  let handle;
  try {
    handle = await route.acquire({
      sessionId: params.session_id,
      projectId: params.execution_context?.project_id || null,
      memberId: author?.member_id ?? null,
      model: typeof sessionSummary?.preferred_model === 'string' ? sessionSummary.preferred_model : '',
      wantsVision: carriesImage(params),
      // The conversation's allowed-node list (null is any node; [] is a damaged list no node satisfies).
      allowedNodes: Array.isArray(sessionSummary?.allowed_nodes) ? sessionSummary.allowed_nodes : null,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw createCancellationError(signal.reason);
    throw routeError(String(error?.reason || ''), { code: error?.code, retryable: error?.retryable });
  }
  const release = releaseOnce(handle);
  const fields = routeTokenFields(handle?.token);
  if (!fields.route_token) {
    release({ ok: false });
    throw routeError('route_token_invalid');
  }
  if (signal?.aborted) {
    release({ ok: false });
    throw createCancellationError(signal.reason);
  }
  Object.assign(params, fields);
  // The leased model, when the route answers one, is the truth for this turn: a valid answer replaces
  // any profile already on the params; a present but malformed one removes it (never size by something
  // else). A route that answers no model (a member's engine port) leaves the params' profile as it is.
  const model = handle?.model;
  if (model !== undefined) {
    delete params.model_profile;
    Object.assign(params, modelProfileFields(model && typeof model === 'object' ? model : {}));
  }
  return { release };
}

module.exports = { acquireTurnRoute };
