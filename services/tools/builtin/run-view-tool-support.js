'use strict';

/* services/tools/builtin/run-view-tool-support.js: what the Live tab's two model tools share (row 197)
 *
 * `run_view_look` and `run_view_restart` check the same things in the same order before they touch
 * the run service. A refusal is a short model-facing sentence with a status word; there is no error
 * code. Only the first line of a result is ever saved (the step summary in `metadata`). */

const { isPlainObject } = require('../../value-utils');
const { checkLiveCall } = require('./propose-tool-support');
const { isUnattendedTurn } = require('./unattended-turn');

const MAX_STEP_TEXT_CHARS = 300;
const UNAVAILABLE_MESSAGES = Object.freeze({
  unsupported_platform: 'The Live tab is not supported on this computer.',
  disabled: 'The Live tab is turned off.',
});

function failure(kind, status, message) {
  const text = message.slice(0, MAX_STEP_TEXT_CHARS);
  return {
    content: text, summary: `Live: ${status}`, isError: true,
    metadata: { result_kind: kind, status, step_summary: text },
  };
}

// The turn gate's reader: an unreadable mode counts as strict.
function safetyModeOf(context) {
  return require('../../backend/run-view-tool-gate').safetyModeOf(context.backendService);
}

// Null when a program may start here, else a refusal word; a holder that cannot say fails closed.
function startRefusalOf(holder) {
  try {
    if (typeof holder.startRefusal !== 'function') return 'disabled';
    return holder.startRefusal() ?? null;
  } catch (_error) {
    return 'disabled';
  }
}

/**
 * The refusals both tools share, in order. Returns `{ failure }` or `{ live, holder, projectId }`.
 * `restart` is true for the tool that starts a program (the sandbox-only mode refuses only that one).
 */
function checkRunViewCall(kind, input, context, { restart }) {
  if (input !== undefined && input !== null && !isPlainObject(input)) {
    return { failure: failure(kind, 'invalid', 'This tool takes no arguments.') };
  }
  if (context.readOnly || context.planMode) {
    return { failure: failure(kind, 'refused', 'The Live tab\'s tools are not available in Plan or read-only mode.') };
  }
  if (safetyModeOf(context) !== 'normal') {
    return { failure: failure(kind, 'refused', 'The Live tab\'s tools are off in strict and paranoid safety mode.') };
  }
  const live = checkLiveCall(context);
  if (!live.ok || !context.callId) {
    return { failure: failure(kind, 'stale', 'This Live tab step no longer belongs to a running turn.') };
  }
  if (isUnattendedTurn(context, live.sessionId)) {
    return { failure: failure(kind, 'refused', 'The user did not start this turn, so the Live tab is not available to it. Leave the program for the user.') };
  }
  const holder = context.backendService?.runView;
  if (!holder || typeof holder.peek !== 'function' || typeof holder.get !== 'function') {
    return { failure: failure(kind, 'unavailable', 'The Live tab is not available in this chat.') };
  }
  const refusal = startRefusalOf(holder);
  if (refusal === 'sandbox_only') {
    if (restart) {
      return { failure: failure(kind, 'refused', 'Commands run only in the sandbox, so the program cannot be started on the desktop.') };
    }
  } else if (refusal !== null) {
    return { failure: failure(kind, 'unavailable', UNAVAILABLE_MESSAGES[refusal] || UNAVAILABLE_MESSAGES.disabled) };
  }
  const authority = live.trusted.authority;
  const projectId = authority && typeof authority.project_id === 'string' && authority.root_path ? authority.project_id : '';
  if (!projectId) return { failure: failure(kind, 'unavailable', 'This chat has no project folder.') };
  return { live, holder, projectId };
}

// A refusal or failure word that is safe to show the model.
function reasonWord(reason) {
  return typeof reason === 'string' && /^[a-z0-9_]{1,64}$/.test(reason) ? reason : 'unknown';
}

module.exports = { MAX_STEP_TEXT_CHARS, checkRunViewCall, failure, reasonWord };
