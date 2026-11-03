'use strict';

// `app_view` (row 94 P3): the Jenny chat moves the user's view, so it can show what it is talking about: Settings
// at a section, a chat, a project file at a line, the terminal, Activity, a chat's detail panel, or close, split or
// the sidebar; `state` reads the current layout (ids and booleans only). It writes nothing, so it needs no card;
// the renderer moves the view at once only while the user is idle on the Jenny chat and otherwise asks with a chip.
// Allowed in Plan mode and read-only chats (viewing, like `workspace_present`). A chat target must be one the
// session directory shows this caller. No result carries exception text.
const { manifestSchema } = require('./tool-result');
const { checkLiveCall } = require('./propose-tool-support');
const { inDirectoryScope, jsonToolResult, plainInput } = require('./session-directory-tool-support');

const NAME = 'app_view';
const LABEL = 'App: view';
// The target keys each action takes (`purpose` is required for every action but `state`).
const TARGET_KEYS = Object.freeze({
  settings: ['section'], chat: ['session_id'], file: ['project_id', 'path', 'line'], terminal: [], activity: ['pane'],
  chat_panel: ['session_id', 'surface'], close: ['pane'], split: ['session_id'], sidebar: ['collapsed'], state: [],
});
const CHAT_TARGET_ACTIONS = new Set(['chat', 'chat_panel', 'split']);
const PURPOSE_MAX = 200;
const REQUESTED = 'The view moves at once only if the user is idle on the Jenny chat; otherwise they see a '
  + '"Jenny wants to open…" prompt. What happened is reported at the start of your next request; until then, do '
  + 'not tell the user it is open.';

function validInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const keys = TARGET_KEYS[input.action];
  if (!keys) return false;
  if (input.action === 'state') return plainInput(input, ['action', 'purpose']);
  if (!plainInput(input, ['action', 'purpose', ...keys])) return false;
  return typeof input.purpose === 'string' && input.purpose.length >= 1 && input.purpose.length <= PURPOSE_MAX;
}

// The request's target without `action`/`purpose`.
function targetOf(input) {
  return Object.fromEntries(TARGET_KEYS[input.action].filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
}

async function chatInScope(context, sessionId, callerId) {
  return sessionId === callerId || inDirectoryScope(context, sessionId);
}

module.exports = {
  TARGET_KEYS,
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: true, sideEffecting: false,
  summarize: (input) => (input?.action === 'state' ? 'App: layout' : LABEL),
  async execute(input = {}, context = {}) {
    const result = (value) => jsonToolResult(NAME, LABEL, value);
    if (context.backendService?.featureFlags?.primary_app_view === false) return result({ ok: false, reason: 'disabled' });
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_input' });
    const live = checkLiveCall(context);
    const port = context.appViewService;
    if (!live.ok || typeof port?.requestView !== 'function') return result({ ok: false, reason: 'unavailable' });
    try {
      // Primary and enabled first: no directory or filesystem answer reaches any other caller.
      const admitted = port.admit({ session_id: live.sessionId });
      if (!admitted?.ok) return result({ ok: false, reason: admitted?.reason || 'unavailable' });
      if (input.action === 'state') return result(port.state({ session_id: live.sessionId }));
      const target = targetOf(input);
      if (CHAT_TARGET_ACTIONS.has(input.action) && typeof target.session_id === 'string'
        && !(await chatInScope(context, target.session_id, live.sessionId))) {
        return result({ ok: false, reason: 'unknown_chat' });
      }
      if (input.action === 'file') {
        const file = await port.resolveProjectFile({ project_id: target.project_id, path: target.path });
        if (!file?.ok) return result({ ok: false, reason: file?.reason || 'unavailable' });
        target.path = file.path;
      }
      if (!checkLiveCall(context).ok) return result({ ok: false, reason: 'unavailable' });
      const sent = port.requestView({ session_id: live.sessionId, action: input.action, target });
      if (!sent?.ok) return result({ ok: false, reason: sent?.reason || 'unavailable' });
      return result({ ok: true, status: 'requested', note: REQUESTED });
    } catch (_error) {
      return result({ ok: false, reason: 'unavailable' });
    }
  },
};
