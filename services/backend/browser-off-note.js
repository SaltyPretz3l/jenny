'use strict';

/* The one line that tells the model the browser exists but is off in this chat (row 117). Without it
 * the model has no way to know, so a request to use a website goes wrong with no explanation. */

const BROWSER_OFF_NOTE = 'The browser tool is off in this chat. If the user asks you to open, visit or act on a website, '
  + 'tell them they can turn on Browser in the tools menu by the message box, and do that before trying anything else.';

/** The note, or '' when turning Browser on would not help or it is already on. */
function browserOffNote(service, sessionId, { planMode = false } = {}) {
  if (planMode || service?.featureFlags?.tools_browser_use_enabled !== true || !service.toolExecutor?.browserUse) return '';
  if ((service.configService?.getChatUiState?.()?.safetyMode || 'normal') !== 'normal') return '';
  const session = service.sessionStore?.peekSession?.(sessionId);
  return session && session.tool_category_overrides?.browser_use !== true ? BROWSER_OFF_NOTE : '';
}

module.exports = { BROWSER_OFF_NOTE, browserOffNote };
