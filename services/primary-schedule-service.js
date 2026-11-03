'use strict';

/* services/primary-schedule-service.js - the port behind the primary Jenny chat's `schedule_list` and
 * `schedule_change` tools and the `schedule_change` approval card (row 85 D8,
 * docs/plans/PRIMARY_SCHEDULES_2026-10-27.md sections 2-4).
 *
 * A scheduled check is a Home reminder with `action: 'jenny_turn'`: its `prompt` is the instruction the user
 * approved and its `label` the title. This service is the only model-facing writer of that action: `create`
 * writes it, `update` / `enable` / `disable` / `cancel` act only on a reminder that already has it, and plain
 * reminders are read-only here (the `home` tool owns them). Each call re-checks that the caller is the primary
 * chat, validates a closed snake_case input, writes through the shell-config reminder path (whose 50-reminder
 * cap is shared with plain reminders) and records a `schedule_*` history entry for Activity.
 *
 * `describeChange` computes the card's trusted fields from the normalized record the change would write (cadence
 * in words, the next three fire times in local time, the instruction, before and after); it never writes.
 * Composition-root style: every dependency is an injected getter, a missing or throwing one yields a refusal,
 * never a throw. Refusals are closed tokens; diagnostics carry the action only, never labels or instructions.
 */

const {
  MAX_PROACTIVE_REMINDERS, MAX_PROACTIVE_REMINDER_LABEL_CHARS, MAX_PROACTIVE_REMINDER_PROMPT_CHARS,
  JENNY_TURN_MIN_INTERVAL_MINUTES, armJennyCheck, nextReminderOccurrences, normalizeReminder, sameReminderCadence,
} = require('./shell-config-followups-schema');

const SCHEMA_VERSION = 1;
const JENNY_TURN = 'jenny_turn';
const CHANGE_ACTIONS = Object.freeze(['create', 'update', 'enable', 'disable', 'cancel']);
const CHANGE_KEYS = Object.freeze(['action', 'reminder_id', 'label', 'instruction', 'cadence', 'caller_session_id']);
const LIST_KEYS = Object.freeze(['include_reminders', 'caller_session_id']);
const CADENCE_KEYS = Object.freeze({
  once_at: ['type', 'once_at'], daily_at: ['type', 'daily_at', 'weekdays'], interval_minutes: ['type', 'interval_minutes'],
});
const HISTORY_KIND = Object.freeze({
  create: 'schedule_created', update: 'schedule_updated', enable: 'schedule_enabled', disable: 'schedule_disabled', cancel: 'schedule_cancelled',
});
const SCHEDULE_LIMITS = Object.freeze({ reminder_id_chars: 128, interval_minutes_max: 7 * 24 * 60, next_fires: 3 });
const ONCE_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAILY_AT = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

const refusal = (reason) => ({ ok: false, reason });
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const pad = (value) => String(value).padStart(2, '0');

function read(getter) {
  try { return typeof getter === 'function' ? getter() ?? null : getter ?? null; } catch (_error) { return null; }
}

// A local instant as `YYYY-MM-DDTHH:MM:SS+HH:MM` (the machine's zone, as reminders fire in it).
function localIso(ms) {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
    + `:${pad(date.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

// A real local wall-clock "YYYY-MM-DDTHH:MM" (the round trip rejects 2026-02-30), as epoch ms, else null.
function onceAtMs(value) {
  const match = typeof value === 'string' ? ONCE_AT.exec(value) : null;
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    && date.getHours() === hour && date.getMinutes() === minute ? date.getTime() : null;
}

function validWeekdays(value) {
  return Array.isArray(value) && value.length <= 7 && new Set(value).size === value.length
    && value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}

// A closed cadence as the reminder fields it sets (all five, so a new type clears the old one), or null.
function parseCadence(value, nowMs) {
  if (!isPlain(value) || !Object.hasOwn(CADENCE_KEYS, value.type) || !onlyKeys(value, CADENCE_KEYS[value.type])) return null;
  const fields = { scheduleType: value.type, onceAt: '', dailyAt: '', weekdays: [], intervalMinutes: 0 };
  if (value.type === 'once_at') {
    const at = onceAtMs(value.once_at);
    return at !== null && at > nowMs ? { ...fields, onceAt: value.once_at } : null; // never a time already past
  }
  if (value.type === 'daily_at') {
    if (typeof value.daily_at !== 'string' || !DAILY_AT.test(value.daily_at)) return null;
    if (value.weekdays !== undefined && !validWeekdays(value.weekdays)) return null;
    return { ...fields, dailyAt: value.daily_at, weekdays: value.weekdays ? [...value.weekdays] : [] };
  }
  const minutes = value.interval_minutes;
  return Number.isInteger(minutes) && minutes >= JENNY_TURN_MIN_INTERVAL_MINUTES && minutes <= SCHEDULE_LIMITS.interval_minutes_max
    ? { ...fields, intervalMinutes: minutes } : null;
}

const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

// The shape of a change: `{ ok, cadence }` (the parsed cadence fields or null) or invalid_input.
function validateChange(input, nowMs) {
  if (!isPlain(input) || !onlyKeys(input, CHANGE_KEYS) || !CHANGE_ACTIONS.includes(input.action)) return refusal('invalid_input');
  const has = (key) => input[key] !== undefined;
  const create = input.action === 'create';
  const edits = ['label', 'instruction', 'cadence'].filter(has);
  if (create ? has('reminder_id') || edits.length !== 3 : !has('reminder_id')) return refusal('invalid_input');
  if (input.action === 'update' ? edits.length === 0 : !create && edits.length > 0) return refusal('invalid_input');
  if (has('reminder_id') && !(typeof input.reminder_id === 'string' && input.reminder_id.length >= 1
    && input.reminder_id.length <= SCHEDULE_LIMITS.reminder_id_chars)) return refusal('invalid_input');
  if (has('label') && !validText(input.label, MAX_PROACTIVE_REMINDER_LABEL_CHARS)) return refusal('invalid_input');
  if (has('instruction') && !validText(input.instruction, MAX_PROACTIVE_REMINDER_PROMPT_CHARS)) return refusal('invalid_input');
  const cadence = has('cadence') ? parseCadence(input.cadence, nowMs) : null;
  if (has('cadence') && !cadence) return refusal('invalid_input');
  return { ok: true, cadence };
}

function cadenceOf(reminder) {
  if (reminder.scheduleType === 'once_at') return { type: 'once_at', once_at: reminder.onceAt };
  if (reminder.scheduleType === 'interval_minutes') return { type: 'interval_minutes', interval_minutes: reminder.intervalMinutes };
  return { type: 'daily_at', daily_at: reminder.dailyAt, weekdays: [...(reminder.weekdays || [])] };
}

function dayWords(weekdays) {
  const days = [...weekdays].sort((left, right) => ((left + 6) % 7) - ((right + 6) % 7));
  if (!days.length) return 'Every day';
  if (days.join() === '1,2,3,4,5') return 'Weekdays';
  if (days.join() === '6,0') return 'Weekends';
  return days.map((day) => DAY_NAMES[day]).join(', ');
}

// The cadence in words for the card and the model (English; the renderer may word its own).
function cadenceText(reminder) {
  if (reminder.scheduleType === 'once_at') {
    const [date, time] = String(reminder.onceAt || '').split('T');
    return `Once on ${date} at ${time}`;
  }
  if (reminder.scheduleType === 'interval_minutes') {
    const minutes = Number(reminder.intervalMinutes);
    if (minutes % 60 !== 0) return `Every ${minutes} minutes`;
    return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
  }
  return `${dayWords(reminder.weekdays || [])} at ${reminder.dailyAt}`;
}

function createPrimaryScheduleService({
  shellConfigService = () => null, controls = () => null, featureFlags = () => ({}), now = () => Date.now(), log = () => {},
} = {}) {
  const nowMs = () => { const value = Number(new Date(read(now) ?? Date.now())); return Number.isFinite(value) ? value : Date.now(); };
  const enabled = () => { const flags = read(featureFlags) || {}; return flags.primary_chat !== false && flags.primary_scheduled_checks !== false; };
  const note = (level, event, fields) => { try { log(level, event, fields); } catch (_error) { /* diagnostics only */ } };
  const nextFires = (reminder, at) => nextReminderOccurrences(reminder, at, SCHEDULE_LIMITS.next_fires).map(localIso);

  function callerIsPrimary(callerSessionId) {
    const primary = read(() => read(controls)?.primarySessionId?.());
    return typeof callerSessionId === 'string' && callerSessionId.length > 0 && callerSessionId === primary;
  }

  function readReminders() {
    const reminders = read(() => read(shellConfigService)?.getState?.()?.proactive?.reminders);
    return Array.isArray(reminders) ? reminders.filter(isPlain) : null;
  }

  const checkView = (reminder) => ({
    reminder_id: reminder.id, label: reminder.label, instruction: reminder.prompt, instruction_trust: 'user_approved',
    cadence: cadenceOf(reminder), cadence_text: cadenceText(reminder), enabled: reminder.enabled !== false,
    last_fired_at: reminder.lastFiredAt || null,
  });
  const cardView = (reminder, at) => ({
    label: reminder.label, instruction: reminder.prompt, cadence_text: cadenceText(reminder),
    enabled: reminder.enabled !== false, next_fires: nextFires(reminder, at),
  });

  // `{ ok, action, prior, next }` for a valid change by the primary chat (next null for cancel), or a refusal.
  function plan(input, at) {
    if (!enabled()) return refusal('disabled');
    const checked = validateChange(input, at);
    if (!checked.ok) return checked;
    if (!callerIsPrimary(input.caller_session_id)) return refusal('denied');
    const reminders = readReminders();
    if (!reminders) return refusal('denied');
    const { action } = input;
    if (action === 'create') {
      if (reminders.length >= MAX_PROACTIVE_REMINDERS) return refusal('limit_reached');
      const next = normalizeReminder({
        label: input.label.trim(), prompt: input.instruction.trim(), ...checked.cadence, action: JENNY_TURN,
        sourceKind: 'assistant', enabled: true, createdAt: new Date(at).toISOString(),
      });
      return { ok: true, action, prior: null, next: armJennyCheck(next, at) };
    }
    const prior = reminders.find((reminder) => reminder.id === input.reminder_id);
    if (!prior) return refusal('not_found');
    if (prior.action !== JENNY_TURN) return refusal('not_a_check');
    if (action === 'cancel') return { ok: true, action, prior, next: null };
    if (action !== 'update') {
      const toggled = normalizeReminder({ ...prior, enabled: action === 'enable' });
      return { ok: true, action, prior, next: action === 'enable' && prior.enabled === false ? armJennyCheck(toggled, at) : toggled };
    }
    const next = normalizeReminder({
      ...prior, ...(input.label === undefined ? {} : { label: input.label.trim() }),
      ...(input.instruction === undefined ? {} : { prompt: input.instruction.trim() }), ...(checked.cadence || {}),
    });
    // A re-timed one-off fires again (the Home write path's HOM-10 rule); a re-timed recurring one is re-armed.
    if (next.scheduleType === 'once_at' && (prior.scheduleType !== 'once_at' || prior.onceAt !== next.onceAt)) next.lastFiredAt = '';
    return { ok: true, action, prior, next: sameReminderCadence(prior, next) ? next : armJennyCheck(next, at) };
  }

  function change(input) {
    const at = nowMs();
    const planned = plan(input, at);
    if (!planned.ok) return planned;
    const { action, prior, next } = planned;
    try {
      const config = read(shellConfigService);
      if (next) config.upsertReminder(next); else config.deleteReminder(prior.id);
    } catch (_error) {
      note('WARN', 'primary_schedules.write_failed', { action });
      return refusal('denied');
    }
    const record = next || prior;
    try {
      read(controls)?.recordScheduleEvent?.({ kind: HISTORY_KIND[action], reminder_id: record.id, label: record.label, by: 'jenny' });
    } catch (_error) {
      note('WARN', 'primary_schedules.history_failed', { action });
    }
    return { ok: true, check: checkView(record), next_fires: next ? nextFires(next, at) : [] };
  }

  function describeChange(input) {
    const at = nowMs();
    const planned = plan(input, at);
    if (!planned.ok) return planned;
    const { action, prior, next } = planned;
    return {
      ok: true, action, reminder_id: prior ? prior.id : null,
      before: prior ? cardView(prior, at) : null, after: next ? cardView(next, at) : null,
    };
  }

  function list(input) {
    if (!enabled()) return refusal('disabled');
    if (!isPlain(input) || !onlyKeys(input, LIST_KEYS)
      || (input.include_reminders !== undefined && typeof input.include_reminders !== 'boolean')) return refusal('invalid_input');
    if (!callerIsPrimary(input.caller_session_id)) return refusal('denied');
    const reminders = readReminders();
    if (!reminders) return refusal('denied');
    const at = nowMs();
    const checks = reminders.filter((reminder) => reminder.action === JENNY_TURN)
      .map((reminder) => ({ ...checkView(reminder), next_fires: nextFires(reminder, at) }));
    // Plain reminders are listed read-only and without their text: the home tool owns them.
    const plain = input.include_reminders === true ? {
      reminders: reminders.filter((reminder) => reminder.action !== JENNY_TURN).map((reminder) => ({
        reminder_id: reminder.id, label: reminder.label, cadence: cadenceOf(reminder), cadence_text: cadenceText(reminder),
        enabled: reminder.enabled !== false, next_fires: nextFires(reminder, at),
      })),
    } : {};
    return { ok: true, schema_version: SCHEMA_VERSION, checks, ...plain, truncated: false };
  }

  return { change, describeChange, list };
}

module.exports = { createPrimaryScheduleService };
