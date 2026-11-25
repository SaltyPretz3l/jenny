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

// Row 196: the same line for the real mouse and keyboard.
const COMPUTER_OFF_NOTE = 'The computer tool is off in this chat. If the user asks you to use a desktop program with the mouse '
  + 'and keyboard, tell them they can turn on Computer in the tools menu by the message box, and do that before trying anything else.';

/** The note, or '' when turning Computer on would not help (flag off, not Windows, not normal safety, sandbox on) or it is on. */
function computerOffNote(service, sessionId, { planMode = false } = {}) {
  if (planMode || service?.featureFlags?.tools_computer_use_enabled !== true || !service.toolExecutor?.computerUse) return '';
  if ((service.platform || process.platform) !== 'win32') return '';
  // The tool gate's own checks, failing closed the same way: a note never offers what the gate would hide.
  if (require('./computer-use-tool-gate').blockedBy(service, { engine: false }) !== null) return '';
  const session = service.sessionStore?.peekSession?.(sessionId);
  return session && session.tool_category_overrides?.computer_use !== true ? COMPUTER_OFF_NOTE : '';
}

module.exports = { BROWSER_OFF_NOTE, COMPUTER_OFF_NOTE, browserOffNote, computerOffNote };
