'use strict';

/* services/tools/builtin/browser-tool.js: `browser` (roadmap row 114)
 *
 * Electron owns the page, the safety tiers and the consent asks (services/browser-use/). This
 * file is the tool-shaped door onto them: validate the call is live, hand it to the chat's
 * browser service, and map the outcome to a result. The model reads the whole outline; only the
 * short step summary in `metadata` is ever saved (savedToolOutput in chat-stream-tool-payload-utils.js). */

const { APPLICATION_TURN_AUTO_RESUME, isUnattendedApplicationTurn } = require('../../backend/application-turns');
const { peekToolLookupMessages } = require('../../backend/chat-stream-tool-payload-utils');
const { formatForModel, stepSummary } = require('../../browser-use/result-format');
const { isPlainObject } = require('../../value-utils');
const { checkLiveCall } = require('./propose-tool-support');
const { manifestSchema } = require('./tool-result');

const ACTIONS = new Set(['navigate', 'read', 'find', 'click', 'type', 'select', 'scroll', 'press', 'screenshot', 'close', 'ad_block']);
const NAVIGATE_WORDS = new Set(['back', 'forward', 'reload']);
const REF_PATTERN = /^\[?(r\d{1,6})\]?$/;
// Steps the model can retry or move on from. A refusal closes one target only, and a request with
// several parts must still reach the rest. Everything else counts as a failure, so the loop's
// repeated-error stop still catches a model that keeps retrying a declined step.
const RECOVERABLE_STATUSES = new Set(['stale_ref', 'element_changed', 'element_obscured', 'not_visible',
  'not_editable', 'no_such_option', 'not_selectable', 'no_history', 'paused_by_user', 'refused']);
const MAX_STEP_TEXT_CHARS = 300;
const CLOSE_ONLY_MESSAGE = 'The user did not start this turn: another chat or a scheduled job did. '
  + 'Here the browser can only close this chat\'s page. Use close if you were asked to, and leave any other browsing for the user.';

function knownAction(input) {
  return isPlainObject(input) && typeof input.action === 'string' && ACTIONS.has(input.action) ? input.action : '';
}

// Never typed text, a query, or an unknown action string: only the action, a host or a ref.
function summarize(input) {
  const action = knownAction(input);
  if (!action) return 'Browser: invalid request';
  let detail = '';
  if (action === 'navigate' && typeof input.url === 'string') {
    if (NAVIGATE_WORDS.has(input.url.trim().toLowerCase())) detail = input.url.trim().toLowerCase();
    else {
      try { detail = new URL(input.url).host; } catch (_error) { detail = ''; }
    }
  } else if (typeof input.ref === 'string') {
    detail = REF_PATTERN.exec(input.ref.trim())?.[1] || '';
  }
  return detail ? `Browser: ${action} ${detail}` : `Browser: ${action}`;
}

function failure(status, message) {
  const text = message.slice(0, MAX_STEP_TEXT_CHARS);
  return {
    content: text, summary: `Browser: ${status}`, isError: true,
    metadata: { result_kind: 'browser', status, step_summary: text },
  };
}

/**
 * The newest message the user actually wrote. This text decides whether a site counts as named by
 * the user, so a row the app injected must never count: mail and handoffs are stored as
 * role 'context', and wake, resume, scheduled-check and digest turns are user rows that carry
 * `application_turn`. Any failure reads as no text, which only makes the tool ask more.
 */
function latestUserText(context, sessionId) {
  try {
    const messages = peekToolLookupMessages(context.backendService, sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'user' || message.kind || message.application_turn) continue;
      if (typeof message.content === 'string' && message.content.trim()) return message.content;
    }
  } catch (_error) { /* fall through */ }
  return '';
}

/**
 * Whether nobody typed the turn this call belongs to (a wake, a scheduled check, a digest). The
 * turn's anchor is the newest user row. Such a turn may close the chat's page and nothing else,
 * so a message from another chat can free a page but never drive one. A transcript that cannot
 * be read counts as unattended, which only leaves close.
 */
function isUnattendedTurn(context, sessionId) {
  try {
    const messages = peekToolLookupMessages(context.backendService, sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'user' || message.kind) continue;
      // A resume carries on the turn before it, so it is whatever that turn was.
      if (message.application_turn !== APPLICATION_TURN_AUTO_RESUME) return isUnattendedApplicationTurn(message.application_turn);
    }
    return false;
  } catch (_error) {
    return true;
  }
}

function toResult(outcome) {
  const status = String(outcome?.status || 'failed');
  return {
    content: formatForModel(outcome),
    summary: `Browser: ${status}`,
    isError: !(outcome.ok === true || RECOVERABLE_STATUSES.has(status)),
    metadata: {
      result_kind: 'browser', status, step_summary: stepSummary(outcome),
      ...(outcome.humanWaitMs > 0 ? { human_wait_ms: outcome.humanWaitMs } : {}),
    },
    ...(outcome.image ? { previewImage: outcome.image } : {}),
  };
}

module.exports = {
  name: 'browser', ...manifestSchema('browser'), category: 'builtin', workspaceRequired: false,
  readOnly: false, sideEffecting: true,
  summarize,
  async execute(input, context = {}) {
    if (!isPlainObject(input)) return failure('invalid', 'The browser tool needs an action.');
    if (context.readOnly || context.planMode) {
      return failure('refused', 'The browser is not available in Plan or read-only mode.');
    }
    const service = context.browserUseService;
    if (!service || typeof service.execute !== 'function') {
      return failure('unavailable', 'The browser is not available in this chat.');
    }
    const live = checkLiveCall(context);
    if (!live.ok || !context.callId) return failure('stale', 'This browser step no longer belongs to a running turn.');
    if (input.action !== 'close' && isUnattendedTurn(context, live.sessionId)) return failure('refused', CLOSE_ONLY_MESSAGE);
    try {
      const outcome = await service.execute(input, {
        sessionId: live.sessionId, turnId: live.turnId, callId: context.callId,
        abortSignal: context.abortSignal, authorize: context.authorize,
        suspendTurnClocks: context.suspendTurnClocks,
        userText: latestUserText(context, live.sessionId),
      });
      return toResult(outcome);
    } catch (_error) {
      return failure('failed', 'The browser step failed.');
    }
  },
};
