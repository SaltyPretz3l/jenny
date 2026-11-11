'use strict';

// App-started turns nobody typed (row 70 wake, F6 auto-resume, row 85 scheduled check). Their persisted user row carries
// `application_turn` like the New session preparation turn (session-handoff-context.js): the
// timeline draws no bubble for it, and Retry/Edit never replay its label as an ordinary prompt.
// Application-authored only: the renderer submission contract has no field that reaches it.
const APPLICATION_TURN_WAKE = 'wake';
const APPLICATION_TURN_AUTO_RESUME = 'auto_resume';
const APPLICATION_TURN_SCHEDULED_CHECK = 'scheduled_check'; // its label is "Scheduled check: <title>"
// Row 86: a "While you were away" digest (primary-digest.js). Its request is offered, and may call, only the read
// tools below (managed-sidecar-chat-helpers.js narrows the offer, session-execution-authority.js enforces it); the
// marker stands in when every one of them is disabled, because an empty allowlist means "no restriction".
const APPLICATION_TURN_DIGEST = 'digest';
const DIGEST_TURN_TOOLS = Object.freeze(['away_digest', 'sessions_list', 'session_status', 'session_transcript', 'jenny_help']);
const DIGEST_NO_TOOLS_MARKER = '__digest_no_tools__';
const REQUEST_APPLICATION_TURNS = new Set([
  APPLICATION_TURN_WAKE, APPLICATION_TURN_AUTO_RESUME, APPLICATION_TURN_SCHEDULED_CHECK, APPLICATION_TURN_DIGEST,
]);

// Nobody is at the keyboard for these, so a tool that is off until a chat turns it on stays off (row 114). An auto-resume
// is left out: it finishes a turn the user started, and its history already holds those tool calls. A wake is offered
// the browser when the chat's switch is on, but only to close its page (browser-tool.js enforces that at the call).
const UNATTENDED_APPLICATION_TURNS = new Set([APPLICATION_TURN_WAKE, APPLICATION_TURN_SCHEDULED_CHECK, APPLICATION_TURN_DIGEST]);
const isUnattendedApplicationTurn = (value) => UNATTENDED_APPLICATION_TURNS.has(value);

// Row 86: a digest request's tool preferences narrowed to DIGEST_TURN_TOOLS minus anything already disabled.
function narrowDigestToolPreferences(preferences) {
  const source = preferences && typeof preferences === 'object' ? preferences : {};
  const denied = new Set(Array.isArray(source.disabled_tools) ? source.disabled_tools : []);
  const allowed = DIGEST_TURN_TOOLS.filter((name) => !denied.has(name));
  return { ...source, enabled_tools: allowed.length ? allowed : [DIGEST_NO_TOOLS_MARKER] };
}

// A label marker never widens authority (a digest only narrows its own tools), so an unknown value is dropped, not refused.
function normalizeRequestApplicationTurn(value) {
  return REQUEST_APPLICATION_TURNS.has(value) ? value : '';
}

// Row 89: stream event fields the renderer names a Jenny-started turn's desktop toast from (a check by its title, the
// visible label minus its "Scheduled check: " prefix; the renderer and main clip it). An ordinary or preparation turn
// gets none.
function applicationTurnEventFields(applicationTurn, visiblePrompt) {
  const kind = normalizeRequestApplicationTurn(applicationTurn);
  if (!kind) return {};
  const title = kind === APPLICATION_TURN_SCHEDULED_CHECK ? String(visiblePrompt || '').replace(/^Scheduled check:\s*/, '').trim() : '';
  return { applicationTurn: kind, ...(title ? { applicationTurnTitle: title } : {}) };
}

module.exports = {
  APPLICATION_TURN_AUTO_RESUME,
  APPLICATION_TURN_DIGEST,
  DIGEST_NO_TOOLS_MARKER,
  DIGEST_TURN_TOOLS,
  APPLICATION_TURN_SCHEDULED_CHECK,
  APPLICATION_TURN_WAKE,
  applicationTurnEventFields,
  isUnattendedApplicationTurn,
  narrowDigestToolPreferences,
  normalizeRequestApplicationTurn,
};
