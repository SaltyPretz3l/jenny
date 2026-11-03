'use strict';

// Row 85 D9: the Home write path for reminders (`proactive.upsertReminder`). The renderer
// sends a partial record; this merges it over the stored one with the same id, so a
// scheduled check's `action`, `weekdays` and `lastDueAt` survive an edit that omits them.
// `action` is never the renderer's to set: a new reminder cannot carry one and a stored
// reminder's cannot change or clear (refused, nothing written); `lastDueAt` is the
// scheduler's cursor and always keeps its stored value. A user edit of a check's label,
// prompt or schedule is reported back as a `schedule_updated` event for the schedule log, a Turn
// off / Turn on as `schedule_disabled` / `schedule_enabled`, and a Delete as `schedule_cancelled`.
// A check turned on or re-timed here is re-armed (armJennyCheck), so it never fires at once.

const { normalizeString } = require('../shared/normalize');
const { armJennyCheck, normalizeReminder, sameReminderCadence } = require('../shell-config-followups-schema');
const { proactiveReminderError } = require('../ipc-validation-helpers');

const SCHEDULE_FIELDS = ['label', 'prompt', 'scheduleType', 'dailyAt', 'intervalMinutes', 'onceAt'];

const sameSchedule = (left, right) => SCHEDULE_FIELDS.every((key) => left[key] === right[key])
  && JSON.stringify(left.weekdays || []) === JSON.stringify(right.weekdays || []);

function storedReminder(shellConfigService, id) {
  const state = typeof shellConfigService?.getState === 'function' ? shellConfigService.getState() : {};
  const reminders = Array.isArray(state?.proactive?.reminders) ? state.proactive.reminders : [];
  return id ? reminders.find((entry) => normalizeString(entry?.id) === id) || null : null;
}

// Returns { reminder, event }: the record to write and the schedule event to record after the
// write lands (null for plain reminders and non-schedule edits). Throws the reminder-invalid
// error for a refused action change.
function prepareReminderUpsert(shellConfigService, incoming, nowMs = Date.now()) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { reminder: incoming, event: null };
  }
  const stored = storedReminder(shellConfigService, normalizeString(incoming.id));
  const storedAction = normalizeString(stored?.action);
  if (Object.hasOwn(incoming, 'action')
    && normalizeString(incoming.action).toLowerCase() !== storedAction) {
    throw proactiveReminderError('A reminder action is set by Jenny and cannot be changed here.');
  }
  if (!stored) return { reminder: incoming, event: null };
  const reminder = {
    ...stored,
    ...incoming,
    action: storedAction,
    lastDueAt: stored.lastDueAt || '',
  };
  if (!storedAction) return { reminder, event: null };
  const prior = normalizeReminder(stored);
  const next = normalizeReminder(reminder);
  const turnedOn = prior.enabled === false && next.enabled !== false;
  const event = (kind) => ({ kind, reminder_id: next.id, label: next.label, by: 'user' });
  const armed = turnedOn || !sameReminderCadence(prior, next) ? armJennyCheck(reminder, nowMs) : reminder;
  if (prior.enabled !== next.enabled) return { reminder: armed, event: event(turnedOn ? 'schedule_enabled' : 'schedule_disabled') };
  return { reminder: armed, event: sameSchedule(prior, next) ? null : event('schedule_updated') };
}

// The `schedule_cancelled` event for a Home Delete of a scheduled check (null for anything else),
// read before the delete lands.
function reminderDeleteEvent(shellConfigService, id) {
  const stored = storedReminder(shellConfigService, normalizeString(id));
  return stored && normalizeString(stored.action)
    ? { kind: 'schedule_cancelled', reminder_id: normalizeString(stored.id), label: normalizeString(stored.label), by: 'user' }
    : null;
}

module.exports = { prepareReminderUpsert, reminderDeleteEvent };
