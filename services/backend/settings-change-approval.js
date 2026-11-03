'use strict';

// The `settings_change` approval card's trusted rows (row 88 D3). The model names settings only
// by key and value; the card shows what the app's own registry reads now and what each key will
// become, computed by the settings port (primary-settings-service.js `prepareCard`), never from
// model text. The port remembers the rows under this call, and the tool writes only when they
// still match. A request the port refuses (a value it cannot set, nothing to change, the window
// cannot be read) still gets a card, in the `refused` state with no Allow, so a denial is never
// mistaken for the user's: the reason travels to the renderer, which words it.
const TOOL_NAME = 'settings_change';
// The chip the card shows for this tool (the sidecar's family says nothing about settings).
const SETTINGS_CHANGE_SCOPE = 'App settings';
const REFUSAL_REASONS = new Set(['not_allowed', 'invalid_value', 'unchanged', 'unavailable', 'disabled', 'invalid_input']);
const isPrimitive = (value) => typeof value === 'boolean' || Number.isFinite(value) || typeof value === 'string';

function cardRow(row) {
  return {
    key: row.key, label: row.label, label_key: row.label_key, kind: row.kind,
    ...(isPrimitive(row.before) ? { before: row.before } : {}), ...(isPrimitive(row.after) ? { after: row.after } : {}),
    before_label: row.before_label, after_label: row.after_label,
  };
}

/** `{ settings_change_approval }` for a `settings_change` request; a refused card on any failure. */
async function settingsChangeApprovalFields(service, sessionId, callId, input) {
  let answer = null;
  try {
    const port = service?.primarySettings;
    if (typeof port?.prepareCard === 'function') {
      answer = await port.prepareCard({ session_id: sessionId, tool_call_id: callId, changes: input?.changes });
    }
  } catch (_error) {
    answer = null;
  }
  if (answer?.ok === true && Array.isArray(answer.rows)) {
    return { settings_change_approval: { schema_version: 1, state: 'ready', rows: answer.rows.map(cardRow) } };
  }
  const reason = REFUSAL_REASONS.has(answer?.reason) ? answer.reason : 'unavailable';
  return { settings_change_approval: {
    schema_version: 1, state: 'refused', reason, key: typeof answer?.key === 'string' ? answer.key : null, rows: [],
  } };
}

module.exports = { SETTINGS_CHANGE_SCOPE, TOOL_NAME, settingsChangeApprovalFields };
