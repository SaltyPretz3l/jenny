'use strict';

// `session_export` (row 94 P4): the Jenny chat saves a Markdown copy of one chat's whole transcript to the user's
// Downloads folder. Side-effecting and always carded (the sidecar asks even in Auto); the approval path prepares the
// card through the port (services/primary-chat-export-service.js), which proves the model's `chat_title` names the
// chat, and ends a refused request before any card. The port writes only under this call's card, re-checks the
// caller's scope, redacts secrets and host paths, and never overwrites a file. Refused in Plan mode and read-only
// chats and when the kill switch is off. No result carries exception text or a path.
const { manifestSchema } = require('./tool-result');
const { checkLiveCall } = require('./propose-tool-support');
const { jsonToolResult, plainInput } = require('./session-directory-tool-support');

const NAME = 'session_export';
const LABEL = 'Chat: export';
const KEYS = ['session_id', 'chat_title', 'purpose'];
const LIMITS = Object.freeze({ id_chars: 256, title_chars: 200, purpose_chars: 200 });

const bounded = (value, max) => typeof value === 'string' && value.trim().length >= 1 && value.length <= max;

function validInput(input) {
  return plainInput(input, KEYS) && bounded(input.session_id, LIMITS.id_chars)
    && bounded(input.chat_title, LIMITS.title_chars) && bounded(input.purpose, LIMITS.purpose_chars);
}

function answerOf(answer) {
  if (answer?.ok === true) {
    return { ok: true, file_name: answer.file_name, bytes: answer.bytes, messages: answer.messages, folder: 'Downloads' };
  }
  return { ok: false, reason: typeof answer?.reason === 'string' ? answer.reason : 'unavailable' };
}

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: false, sideEffecting: true,
  summarize: () => LABEL,
  async execute(input = {}, context = {}) {
    const result = (value) => jsonToolResult(NAME, LABEL, value);
    if (context.backendService?.featureFlags?.primary_chat_export === false) return result({ ok: false, reason: 'disabled' });
    if (context.readOnly || context.planMode) return result({ ok: false, reason: 'mode_refused' });
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_input' });
    const live = checkLiveCall(context);
    const port = context.primaryChatExportService;
    if (!live.ok || typeof port?.exportChat !== 'function') return result({ ok: false, reason: 'unavailable' });
    try {
      return result(answerOf(await port.exportChat({
        caller_session_id: live.sessionId, tool_call_id: String(context.callId || ''),
        session_id: input.session_id, chat_title: input.chat_title,
      })));
    } catch (_error) {
      return result({ ok: false, reason: 'unavailable' });
    }
  },
};
