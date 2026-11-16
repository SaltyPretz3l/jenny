'use strict';

// Row 166 D10: one answer for a round of file edits. A model that sends several `edit_file` (or `write_file`) calls
// in one round is asked about them one after another (sidecar/runtime/approval_round_carry.py). The first request
// names the ones behind it (`round_calls`), so its card can show every edit whole and offer to allow them together.
//
// What needs approval does not change. Each call still makes its own request and its own records. A call is answered
// here, without a card, only when all of this holds: the user pressed "Allow all" on a card that showed that call's
// exact input; the call is the next one of that round, in this stream, with the same tool; and the input it now
// asks for hashes to what was shown. One use per call. Any other request, a denial, a timeout or a stop ends the
// round, and whatever is left asks on its own card as before.
//
// Never on a team or hosted server (prompter and approver are recorded per call there), never for a request that
// must be approved once by a person, and never for another tool: commands keep one card each. Paranoid safety
// mode asks for a card on every call, so it gets one; a safety mode that cannot be read counts as paranoid. A turn
// the inactivity guard paused shows its next card too.

const { summarizeToolPayload } = require('./backend-service-utils');
const { buildExactApprovalPresentation } = require('./chat-stream-exact-approval');
const { sanitizeToolSummary } = require('./chat-stream-tool-payload-utils');
const { isPlainObject } = require('../value-utils');

const ROUND_SCOPE = 'round';
const ROUND_TOOLS = new Set(['edit_file', 'write_file']);
const MAX_ROUND_CALLS = 16;
// Everything offered is shown whole on one card, so the offer stops where the card would stop being readable.
const MAX_ROUND_BYTES = 128 * 1024;
const MAX_CALL_ID_CHARS = 200;

const ROUND_SAFETY_MODES = new Set(['normal', 'strict']);

function roundApplies(service, toolName, oneOffOnly) {
  if (service?.hostMode === 'server' || oneOffOnly === true || !ROUND_TOOLS.has(toolName)) return false;
  try {
    return ROUND_SAFETY_MODES.has(service.configService?.getChatUiState?.()?.safetyMode);
  } catch {
    return false;
  }
}

function exactOrNull(toolName, input) {
  try {
    return buildExactApprovalPresentation(toolName, input);
  } catch {
    return null;
  }
}

// The later calls this card may offer with its own: `[{ callId, summary, exactApproval }]`, in order. The list stops
// at the first hint that is not a well-formed call of the same tool whose exact input can be shown.
function roundOfferFor(service, { toolName, callId, params, oneOffOnly, exactApproval } = {}) {
  const hints = params?.round_calls;
  if (!roundApplies(service, toolName, oneOffOnly) || !exactApproval?.sha256 || !Array.isArray(hints)) return [];
  const offer = [];
  const seen = new Set([callId]);
  let bytes = 0;
  for (const hint of hints.slice(0, MAX_ROUND_CALLS)) {
    const hintId = isPlainObject(hint) && typeof hint.tool_call_id === 'string' ? hint.tool_call_id.trim() : '';
    if (!hintId || hintId.length > MAX_CALL_ID_CHARS || seen.has(hintId) || hint.tool_name !== toolName
      || !isPlainObject(hint.tool_input)) break;
    const exact = exactOrNull(toolName, hint.tool_input);
    if (!exact?.sha256) break;
    bytes += exact.bytes;
    if (bytes > MAX_ROUND_BYTES) break;
    seen.add(hintId);
    offer.push({
      callId: hintId,
      summary: sanitizeToolSummary(summarizeToolPayload(toolName, hint.tool_input)),
      exactApproval: exact,
    });
  }
  return offer;
}

// The user allowed the round on a card that offered it. The grants live on the stream's own controller, so they
// end with the stream and no other stream can use them.
function noteRoundAllowed(controller, toolName, offer) {
  if (!controller || !Array.isArray(offer) || offer.length === 0) return;
  controller.roundApprovalGrants = new Map(
    offer.map((call) => [call.callId, { toolName, sha256: call.exactApproval.sha256 }]));
}

// Whether this request is the next call of a round the user allowed. Called once for every approval request of the
// stream: a request that is not the next granted call, or does not ask for exactly what was shown, ends the round.
// So does a stopped turn, and so does every card that follows, whatever its answer.
function roundGrantApproves(service, controller, { toolName, callId, oneOffOnly, exactApprovalSha256 } = {}) {
  const grants = controller?.roundApprovalGrants;
  if (!(grants instanceof Map) || grants.size === 0) return false;
  const [nextCallId, grant] = grants.entries().next().value;
  const answers = nextCallId === callId && roundApplies(service, toolName, oneOffOnly)
    && controller.signal?.aborted !== true && controller.unattendedPauseRequested !== true && grant.toolName === toolName
    && typeof exactApprovalSha256 === 'string' && exactApprovalSha256 !== '' && grant.sha256 === exactApprovalSha256;
  if (answers) grants.delete(callId);
  else grants.clear();
  return answers;
}

// The offer as the live card reads it. Live only: like `exact_approval`, it is never persisted.
function roundApprovalEventFields(offer) {
  return Array.isArray(offer) && offer.length
    ? { round_approval: { calls: offer.map((call) => ({ call_id: call.callId, summary: call.summary, exact_approval: call.exactApproval })) } }
    : {};
}

module.exports = {
  MAX_ROUND_CALLS, ROUND_SCOPE, noteRoundAllowed, roundApprovalEventFields, roundGrantApproves, roundOfferFor,
};
