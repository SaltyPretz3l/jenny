'use strict';

// Shared skeleton of `chat_organize` and `chat_configure` (row 94 P1). Both are side-effecting with an `ask`
// policy default, so the approval card comes from the normal tool approval path before this runs; refused in
// Plan mode and read-only chats and when the kill switch is off. Shape and the closed action list are checked
// here, before the port (`context.primaryChatManageService`, which re-checks the caller, the target and every
// guard and applies the change through the user's own store path). The caller comes only from the live call
// binding; no result carries exception text.
const { manifestSchema } = require('./tool-result');
const { checkLiveCall } = require('./propose-tool-support');
const { jsonToolResult, plainInput } = require('./session-directory-tool-support');

const KEYS = ['session_id', 'action', 'value', 'purpose'];
const LIMITS = Object.freeze({ session_id_chars: 256, value_chars: 200, purpose_chars: 200 });

function validInput(input, actions) {
  if (!plainInput(input, KEYS)) return false;
  if (typeof input.session_id !== 'string' || input.session_id.length < 1 || input.session_id.length > LIMITS.session_id_chars) return false;
  if (typeof input.action !== 'string' || !actions.includes(input.action)) return false;
  if (input.value !== undefined && (typeof input.value !== 'string' || input.value.length > LIMITS.value_chars)) return false;
  return typeof input.purpose === 'string' && input.purpose.length >= 1 && input.purpose.length <= LIMITS.purpose_chars;
}

// `forbidden(action, value)`: a request the tool refuses outright with `not_allowed` (chat_configure: Auto).
function createChatManageTool({ name, label, actions, method, forbidden = () => false }) {
  const result = (value) => jsonToolResult(name, label, value, { change_id: value.change_id });
  const refused = (reason) => result({ ok: false, reason });
  return {
    name, ...manifestSchema(name), category: 'builtin', workspaceRequired: false,
    readOnly: false, sideEffecting: true,
    summarize: () => label,
    async execute(input = {}, context = {}) {
      if (context.backendService?.featureFlags?.primary_chat_manage === false) return refused('disabled');
      if (context.readOnly || context.planMode) return refused('mode_refused');
      if (!validInput(input, actions)) return refused('invalid_input');
      if (forbidden(input.action, input.value)) return refused('not_allowed');
      const live = checkLiveCall(context);
      const port = context.primaryChatManageService;
      if (!live.ok || typeof port?.[method] !== 'function') return refused('unavailable');
      try {
        const answer = await port[method]({
          target_session_id: input.session_id, action: input.action,
          ...(input.value === undefined ? {} : { value: input.value }),
          caller_session_id: live.sessionId,
        });
        return answer && typeof answer === 'object' ? result(answer) : refused('unavailable');
      } catch (_error) {
        return refused('unavailable');
      }
    },
  };
}

module.exports = { createChatManageTool };
