'use strict';

// `projects_list` (row 94 P2): every project with its folder, whether that folder is there, its unarchived chat
// count and latest activity, including projects with no chats (which `sessions_list` never shows). Read-only and
// primary-only; the port re-checks the caller from the live call binding.
const { manifestSchema } = require('./tool-result');
const { checkLiveCall } = require('./propose-tool-support');
const { jsonToolResult, plainInput } = require('./session-directory-tool-support');

const NAME = 'projects_list';
const LABEL = 'Projects: list';

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: true, sideEffecting: false,
  summarize: () => LABEL,
  async execute(input = {}, context = {}) {
    const result = (value) => jsonToolResult(NAME, LABEL, value);
    if (context.backendService?.featureFlags?.primary_chat_placement === false) return result({ ok: false, reason: 'disabled' });
    if (!plainInput(input, [])) return result({ ok: false, reason: 'invalid_input' });
    const live = checkLiveCall(context);
    const port = context.primaryChatPlacementService;
    if (!live.ok || typeof port?.list !== 'function') return result({ ok: false, reason: 'unavailable' });
    try {
      const answer = await port.list({ caller_session_id: live.sessionId });
      return result(answer && typeof answer === 'object' ? answer : { ok: false, reason: 'unavailable' });
    } catch (_error) {
      return result({ ok: false, reason: 'unavailable' });
    }
  },
};
