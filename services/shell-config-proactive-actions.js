const { normalizeString } = require('./backend/path-utils');
const { PROACTIVE_ERROR_CODES } = require('./backend/error-codes');
const {
  MAX_PROACTIVE_REMINDER_LABEL_CHARS,
  MAX_PROACTIVE_REMINDER_PROMPT_CHARS,
  MAX_PROACTIVE_REMINDERS,
  normalizeReminder,
  sortReminders,
} = require('./shell-config-state');

function proactiveReminderError(message) {
  const error = new Error(message);
  error.code = PROACTIVE_ERROR_CODES.REMINDER_INVALID;
  error.errorCode = PROACTIVE_ERROR_CODES.REMINDER_INVALID;
  return error;
}

function requirePersistedReminderCommit(committed) {
  if (committed?.persisted === true) return committed.snapshot;
  const error = new Error('Reminder changes could not be persisted.');
  error.code = 'proactive_reminder_write_failed';
  throw error;
}

function assertAllowedReminderPayload(reminder = {}, existingCount = 0, isUpdate = false) {
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
  if (!isUpdate && existingCount >= MAX_PROACTIVE_REMINDERS) {
    throw proactiveReminderError(
      `Reminder count exceeds the ${MAX_PROACTIVE_REMINDERS} reminder limit.`
    );
  }
}

const proactiveActionMethods = {
  upsertReminder(reminder) {
    const normalized = normalizeReminder(reminder);
    const nextReminders = this.state.proactive.reminders.filter(
      (entry) => entry.id !== normalized.id
    );
    assertAllowedReminderPayload(
      reminder,
      this.state.proactive.reminders.length,
      nextReminders.length !== this.state.proactive.reminders.length
    );
    nextReminders.push(normalized);
    return requirePersistedReminderCommit(this._commitState(
      {
        ...this.state,
        proactive: {
          ...this.state.proactive,
          reminders: sortReminders(nextReminders),
        },
      },
      'proactive_reminder_upserted',
      { reminderId: normalized.id }
    ));
  },

  deleteReminder(reminderId) {
    const normalizedReminderId = normalizeString(reminderId);
    if (!normalizedReminderId) {
      return this.getState();
    }
    return requirePersistedReminderCommit(this._commitState(
      {
        ...this.state,
        proactive: {
          ...this.state.proactive,
          reminders: this.state.proactive.reminders.filter(
            (entry) => entry.id !== normalizedReminderId
          ),
        },
      },
      'proactive_reminder_deleted',
      { reminderId: normalizedReminderId }
    ));
  },

};

module.exports = { proactiveActionMethods };
