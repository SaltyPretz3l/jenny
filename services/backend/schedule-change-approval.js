'use strict';

// The `schedule_change` approval card's trusted fields (row 85 D8). The model names a check only by
// reminder id and proposes text and a cadence; the card shows what the schedule port computes from the
// normalized record the change would write: the label and instruction as they would be stored, the cadence
// in words, the next three fire times in local time, and before/after for an edit. A request the port
// refuses (not a check, the cap, a bad cadence) still gets a card, in the `refused` state with no Allow, so
// a refusal is never mistaken for the user's; the reason is a closed token the renderer words.
const TOOL_NAME = 'schedule_change';
// The chip the card shows for this tool (the sidecar's family says nothing about schedules).
const SCHEDULE_CHANGE_SCOPE = 'Scheduled checks';
const REFUSAL_REASONS = new Set(['invalid_input', 'not_found', 'not_a_check', 'limit_reached', 'denied', 'disabled']);
const ACTIONS = new Set(['create', 'update', 'enable', 'disable', 'cancel']);
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function cardSide(side) {
  if (!isRecord(side)) return null;
  return {
    label: String(side.label ?? ''), instruction: String(side.instruction ?? ''), cadence_text: String(side.cadence_text ?? ''),
    enabled: side.enabled !== false, next_fires: Array.isArray(side.next_fires) ? side.next_fires.filter((at) => typeof at === 'string') : [],
  };
}

/** `{ schedule_change_approval }` for a `schedule_change` request; a refused card on any failure. */
async function scheduleChangeApprovalFields(service, sessionId, input) {
  const port = service?.primarySchedules;
  if (typeof port?.describeChange !== 'function') {
    return { schedule_change_approval: { schema_version: 1, state: 'refused', reason: 'disabled', before: null, after: null } };
  }
  let answer;
  try {
    const { purpose: _purpose, ...change } = isRecord(input) ? input : {};
    answer = await port.describeChange({ ...change, caller_session_id: sessionId });
  } catch (_error) {
    answer = null;
  }
  if (answer?.ok === true && ACTIONS.has(answer.action)) {
    return { schedule_change_approval: {
      schema_version: 1, state: 'ready', action: answer.action,
      reminder_id: typeof answer.reminder_id === 'string' ? answer.reminder_id : null,
      before: cardSide(answer.before), after: cardSide(answer.after),
    } };
  }
  const reason = REFUSAL_REASONS.has(answer?.reason) ? answer.reason : 'denied';
  return { schedule_change_approval: { schema_version: 1, state: 'refused', reason, before: null, after: null } };
}

module.exports = { SCHEDULE_CHANGE_SCOPE, TOOL_NAME, scheduleChangeApprovalFields };
