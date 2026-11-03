'use strict';

// `project_create` (row 94 P2): a new project bound to a folder the user named, so the Jenny chat can propose a
// chat there. Side-effecting and always carded (the sidecar asks even in Auto); the approval path prepares the
// card through the port and ends a refused request before any card. The port (`context.primaryChatPlacementService`)
// writes only under this call's card, re-checks the caller and the folder, and never creates the folder itself.
// Refused in Plan mode and read-only chats and when the kill switch is off. No result carries exception text.
const { manifestSchema } = require('./tool-result');
const { checkLiveCall } = require('./propose-tool-support');
const { jsonToolResult, plainInput } = require('./session-directory-tool-support');
const { refusalExtras } = require('../../backend/project-create-approval');

const NAME = 'project_create';
const LABEL = 'Project: create';
const KEYS = ['name', 'folder', 'purpose'];
const LIMITS = Object.freeze({ name_chars: 80, folder_chars: 1024, purpose_chars: 200 });

function validInput(input) {
  if (!plainInput(input, KEYS)) return false;
  if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > LIMITS.name_chars) return false;
  if (typeof input.folder !== 'string' || input.folder.length < 1 || input.folder.length > LIMITS.folder_chars) return false;
  return typeof input.purpose === 'string' && input.purpose.length >= 1 && input.purpose.length <= LIMITS.purpose_chars;
}

function answerOf(answer) {
  if (answer?.ok === true) {
    const value = { ok: true, project_id: answer.project_id, name: answer.name, folder: answer.folder };
    return typeof answer.change_id === 'string' ? { ...value, change_id: answer.change_id } : value;
  }
  return { ok: false, reason: typeof answer?.reason === 'string' ? answer.reason : 'unavailable', ...refusalExtras(answer) };
}

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: false, sideEffecting: true,
  summarize: () => LABEL,
  async execute(input = {}, context = {}) {
    const result = (value) => jsonToolResult(NAME, LABEL, value, { change_id: value.change_id, project_id: value.project_id });
    if (context.backendService?.featureFlags?.primary_chat_placement === false) return result({ ok: false, reason: 'disabled' });
    if (context.readOnly || context.planMode) return result({ ok: false, reason: 'mode_refused' });
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_input' });
    const live = checkLiveCall(context);
    const port = context.primaryChatPlacementService;
    if (!live.ok || typeof port?.create !== 'function') return result({ ok: false, reason: 'unavailable' });
    try {
      return result(answerOf(await port.create({
        caller_session_id: live.sessionId, tool_call_id: String(context.callId || ''), name: input.name, folder: input.folder,
      })));
    } catch (_error) {
      return result({ ok: false, reason: 'unavailable' });
    }
  },
};
