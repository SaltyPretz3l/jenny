'use strict';

/* Row 117: a chat a person starts copies the Browser on/off choice last made in the composer.
 * Applied only at the sessions.create IPC entry: BackendService.createSession also serves the CLI
 * and the hosted router, which have no Browser row, and cannot tell those callers apart. */

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function seedRememberedBrowserChoice(payload, shellConfigService) {
  const request = payload === undefined ? {} : payload;
  if (!isObject(request) || request.sessionRole) return payload;
  if (request.preferences != null && !isObject(request.preferences)) return payload;
  const preferences = request.preferences || {};
  if (Object.hasOwn(preferences, 'tool_category_overrides')) return payload;
  if (shellConfigService?.getChatUiState?.()?.browserOnInNewChats !== true) return payload;
  return { ...request, preferences: { ...preferences, tool_category_overrides: { browser_use: true } } };
}

module.exports = { seedRememberedBrowserChoice };
