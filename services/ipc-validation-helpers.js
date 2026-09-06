'use strict';

const { normalizeString } = require('../renderer/shared/string-utils');
const { PROACTIVE_ERROR_CODES } = require('./backend/error-codes');
const {
  MAX_PROACTIVE_REMINDER_LABEL_CHARS,
  MAX_PROACTIVE_REMINDER_PROMPT_CHARS,
  MAX_PROACTIVE_REMINDERS,
} = require('./shell-config-state');
const { normalizeToolName } = require('./tools/tool-permission-store');
const { isPlainObject } = require('./value-utils');

function proactiveReminderError(message) {
  const error = new Error(message);
  error.code = PROACTIVE_ERROR_CODES.REMINDER_INVALID;
  error.errorCode = PROACTIVE_ERROR_CODES.REMINDER_INVALID;
  return error;
}

function assertProactiveReminderIpcPayload(shellConfigService, reminder = {}) {
  const label = normalizeString(reminder?.label);
  const prompt = normalizeString(reminder?.prompt);
  if (label.length > MAX_PROACTIVE_REMINDER_LABEL_CHARS) {
    throw proactiveReminderError(
      `Reminder label exceeds the ${MAX_PROACTIVE_REMINDER_LABEL_CHARS} character limit.`
    );
  }
  if (prompt.length > MAX_PROACTIVE_REMINDER_PROMPT_CHARS) {
    throw proactiveReminderError(
      `Reminder prompt exceeds the ${MAX_PROACTIVE_REMINDER_PROMPT_CHARS} character limit.`
    );
  }
  const state = shellConfigService && typeof shellConfigService.getState === 'function'
    ? shellConfigService.getState()
    : {};
  const reminders = Array.isArray(state?.proactive?.reminders)
    ? state.proactive.reminders
    : [];
  const reminderId = normalizeString(reminder?.id);
  const isUpdate = Boolean(reminderId && reminders.some((entry) => normalizeString(entry?.id) === reminderId));
  if (!isUpdate && reminders.length >= MAX_PROACTIVE_REMINDERS) {
    throw proactiveReminderError(
      `Reminder count exceeds the ${MAX_PROACTIVE_REMINDERS} reminder limit.`
    );
  }
}

function normalizeRuntimeToolStatusMap(statusMap) {
  if (!isPlainObject(statusMap)) {
    return {};
  }
  const normalized = {};
  for (const [rawName, rawStatus] of Object.entries(statusMap)) {
    const name = normalizeToolName(rawName);
    if (!name || !isPlainObject(rawStatus)) {
      continue;
    }
    normalized[name] = {
      available: rawStatus.available === true,
      reason: typeof rawStatus.reason === 'string' ? rawStatus.reason : '',
      displayName: normalizeString(rawStatus.display_name || rawStatus.displayName || name) || name,
      sourceKind: normalizeString(rawStatus.source_kind || rawStatus.sourceKind),
      toolFamily: normalizeString(rawStatus.tool_family || rawStatus.toolFamily),
    };
  }
  return normalized;
}

module.exports = {
  assertProactiveReminderIpcPayload,
  normalizeRuntimeToolStatusMap,
  proactiveReminderError,
};
