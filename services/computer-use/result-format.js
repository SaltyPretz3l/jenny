'use strict';

/* services/computer-use/result-format.js: what the model reads back from `computer`, and what is saved (row 196).
 *
 * Plain English, written for the model, not renderer strings. The model sees the whole result; only
 * `stepSummary` is ever saved to the chat: the action, the program's name and the status, never typed text,
 * a chord, a window title or a picture. */

const MAX_STEP_SUMMARY_CHARS = 200;
const MAX_FIELD_CHARS = 80;
const ACTIONS = Object.freeze(['screenshot', 'click', 'drag', 'move', 'scroll', 'type', 'key', 'wait', 'open', 'focus', 'windows']);
const STATUSES = Object.freeze(['done', 'resumed', 'refused', 'declined', 'paused_by_user', 'busy', 'budget', 'no_target', 'not_found',
  'unavailable', 'invalid', 'failed', 'cancelled']);

const NO_TARGET = 'No window is in front for Jenny. Use focus or open first.';
const OWNER_ACTIVE = 'The owner has taken the mouse or keyboard. Stop here and wait for them; do not try again this turn.';
const OWNER_STOPPED = 'The owner pressed Stop. End the turn now.';
const OWNER_RESUMED = 'The owner handed back control. Take a new screenshot before acting.';
const WINDOW_GONE = 'The window is gone. Use focus or open first.';

// What each helper refusal reason becomes: a status, one plain sentence, and what it does to the service's state.
const HELPER_REFUSALS = Object.freeze({
  owner_active: { status: 'paused_by_user', message: OWNER_ACTIVE, pause: 'owner' },
  no_watch: { status: 'refused', message: 'The owner\'s watch is not running, so no input can be sent.', watchLost: true },
  secure_desktop: { status: 'refused', message: 'The screen is locked or showing a security prompt, so no input can be sent.' },
  window_gone: { status: 'refused', message: WINDOW_GONE, clearTarget: true },
  outside_window: { status: 'refused', message: 'That point is outside the window\'s picture. Points are pixels in the latest picture, not a 0 to 1,000 scale.' },
  denied: { status: 'refused', message: 'That window cannot be used.' },
  elevated: { status: 'refused', message: 'That program runs as administrator and cannot be used.' },
  unidentified: { status: 'refused', message: 'Jenny cannot tell which program that window belongs to.' },
  wrong_program: { status: 'refused', message: 'That window belongs to a different program than the one granted.' },
  password_field: { status: 'refused', message: 'That is a password field; the owner fills it in.' },
  refused_chord: { status: 'refused', message: 'That key combination is never sent.' },
  not_front: { status: 'refused', message: 'The window did not come to the front.' },
});

// Every fixed reason a `refused` step can carry: the helper's refusals and the grant gate's answers.
const REFUSAL_CODES = Object.freeze([...Object.keys(HELPER_REFUSALS).filter((code) => HELPER_REFUSALS[code].status === 'refused'),
  'never', 'view_only', 'too_many', 'unanswerable']);

function oneLine(text, maxChars) {
  return [...String(text ?? '')].map((ch) => (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f ? ' ' : ch))
    .join('').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/**
 * A helper error as a status and a message. Nothing the helper said (it never names titles or paths, but
 * this does not rely on that) reaches the model.
 * @returns {{ status: string, message: string, pause?: string, clearTarget?: boolean, watchLost?: boolean }}
 */
function mapHelperError(error) {
  const code = error?.code;
  if (code === 'refused') {
    const known = Object.prototype.hasOwnProperty.call(HELPER_REFUSALS, error.reason);
    return known ? { ...HELPER_REFUSALS[error.reason], refusal: error.reason } : { status: 'refused', message: 'That step was refused.' };
  }
  if (code === 'bad_request') return { status: 'invalid', message: 'That step was not understood.' };
  if (code === 'no_such_window') return { ...HELPER_REFUSALS.window_gone, refusal: 'window_gone' };
  if (code === 'helper_unavailable' || code === 'not_available' || code === 'not_built') {
    return { status: 'unavailable', message: 'Computer use is not available right now.' };
  }
  return { status: 'failed', message: 'The computer step failed.' };
}

/** @returns {object} an outcome; `ok` is true only for `done` */
function outcome({ status, action, message, ...rest }) {
  return { ok: status === 'done', status, action: ACTIONS.includes(action) ? action : 'unknown', message: String(message || ''), ...rest };
}

/** The text the model reads back for one step. */
function formatForModel(result) {
  const action = ACTIONS.includes(result?.action) ? result.action : 'unknown';
  const status = STATUSES.includes(result?.status) ? result.status : 'failed';
  // The list of `windows` keeps its line breaks (the service already cleaned each title).
  const message = result?.action === 'windows' ? String(result.message ?? '').slice(0, 2400) : oneLine(result?.message, 600);
  const lines = [`Computer ${action}: ${status}`];
  if (message) lines.push(message);
  if (result?.program) lines.push(`Program: ${oneLine(result.program, MAX_FIELD_CHARS)}`);
  if (result?.image && Number.isFinite(result.width) && Number.isFinite(result.height)) {
    // The pixel range is stated outright: on a small picture the model slips into a 0 to 1,000 scale (Sitting B).
    lines.push(`Picture: ${result.width} x ${result.height} pixels; points are x 0 to ${result.width - 1}, y 0 to ${result.height - 1}; `
      + `signature ${oneLine(result.signature, 32)}, screen changed: ${result.screenChanged ? 'yes' : 'no'}`);
  }
  return lines.join('\n');
}

/** What the chat keeps: the action, the program's name and the status. */
function stepSummary(result) {
  const action = ACTIONS.includes(result?.action) ? result.action : 'unknown';
  const status = STATUSES.includes(result?.status) ? result.status : 'failed';
  const program = oneLine(result?.program, MAX_FIELD_CHARS);
  return oneLine(`Computer: ${action}${program ? ` ${program}` : ''} ${status}`, MAX_STEP_SUMMARY_CHARS);
}

module.exports = {
  ACTIONS,
  NO_TARGET,
  OWNER_ACTIVE,
  OWNER_RESUMED,
  OWNER_STOPPED,
  REFUSAL_CODES,
  STATUSES,
  formatForModel,
  mapHelperError,
  oneLine,
  outcome,
  stepSummary,
};
