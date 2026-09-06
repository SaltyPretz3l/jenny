// Proactive reminders + follow-ups configuration schema.
//
// Owns the follow-up / reminder / proactive-alert constants, the shared JSON
// clone + reminder-id helpers, and the per-field normalizers for reminders,
// follow-ups, follow-up history, schedule shapes, watcher globs, and resource
// alert thresholds. Extracted from shell-config-state.js as a behavior-
// preserving one-way slice (depends only on path-utils); shell-config-state.js
// re-exports the public members so the config barrel stays stable.
const { clipText, normalizeString } = require('./backend/path-utils');

const RESOURCE_ALERT_THRESHOLD_DEFAULT = 90;
const RESOURCE_ALERT_THRESHOLD_MIN = 50;
const RESOURCE_ALERT_THRESHOLD_MAX = 100;
const MAX_PROACTIVE_REMINDERS = 50;
const MAX_PROACTIVE_REMINDER_LABEL_CHARS = 200;
const MAX_PROACTIVE_REMINDER_PROMPT_CHARS = 4000;
const MAX_FOLLOW_UP_LABEL_CHARS = 200;
const MAX_FOLLOW_UP_BODY_CHARS = 4000;
const MAX_REMINDER_SOURCE_ID_CHARS = 128;
// Reminder cadences. 'once_at' is the one-shot: it fires at a single local
// wall-clock moment instead of repeating. NOTE: nothing in this codebase
// actually fires reminders (they surface as manual nudges), so this enum is
// schema only — adding it does not introduce a scheduler.
const REMINDER_SCHEDULE_TYPES = Object.freeze(['daily_at', 'interval_minutes', 'once_at']);
// Attribution for a reminder, mirroring the follow-up sourceKind precedent
// below: a closed enum coercing anything unrecognized to '' (unattributed).
// Single-member for the same reason as HOME_CALENDAR_SOURCE_KINDS
// (services/home-calendar-schema.js): only HomeAssistantService stamps it, only
// on create, and every reader tests `=== 'assistant'`.
const REMINDER_SOURCE_KINDS = Object.freeze(['assistant']);
const FOLLOW_UP_STATUSES = Object.freeze(['active', 'deferred', 'resolved']);
const FOLLOW_UP_DEFER_PRESETS = Object.freeze(['later_today', 'tomorrow', 'next_week']);
const FOLLOW_UP_SOURCE_KINDS = Object.freeze([
  'agent_task',
  'assistant_reply',
  'manual',
  'proactive_suggestion',
  'reminder',
]);
const FOLLOW_UP_HISTORY_KINDS = Object.freeze([
  'created',
  'edited',
  'deferred',
  'activated',
  'resolved',
  'archived',
  'unarchived',
]);

function cloneJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)])
    );
  }
  return value;
}

function createReminderId() {
  return `rem_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeWatcherGlobs(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  return value
    .map((entry) => normalizeString(entry).replace(/\\/g, '/'))
    .filter((entry) => {
      if (!entry || seen.has(entry)) {
        return false;
      }
      seen.add(entry);
      return true;
    });
}

function normalizeScheduleType(value) {
  const token = String(value || '').trim().toLowerCase();
  return REMINDER_SCHEDULE_TYPES.includes(token) ? token : 'daily_at';
}

// One-shot fire time as a LOCAL-NAIVE "YYYY-MM-DDTHH:MM" string (no Z, no
// offset) — the same wall-clock convention the home calendar stores, so a
// reminder promoted to/from a calendar event keeps its literal time. The
// component round-trip rejects overflow dates (e.g. Feb 30) that the Date
// constructor would silently roll forward.
function normalizeReminderOnceAt(value) {
  const token = normalizeString(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(token);
  if (!match) {
    return '';
  }
  const [, year, month, day, hour, minute] = match.map(Number);
  const parsed = new Date(year, month - 1, day, hour, minute);
  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
    || parsed.getHours() !== hour
    || parsed.getMinutes() !== minute
  ) {
    return '';
  }
  return token;
}

function normalizeReminderSourceKind(value) {
  const token = normalizeString(value).toLowerCase();
  return REMINDER_SOURCE_KINDS.includes(token) ? token : '';
}

function normalizeDailyAt(value) {
  const token = normalizeString(value);
  const match = /^(\d{2}):(\d{2})$/.exec(token);
  return match && Number(match[1]) <= 23 && Number(match[2]) <= 59 ? token : '09:00';
}

function normalizeIntervalMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 60;
  }
  return Math.max(5, Math.floor(parsed));
}

function normalizeIsoString(value) {
  const token = normalizeString(value);
  if (!token) {
    return '';
  }
  const parsed = new Date(token);
  return Number.isNaN(parsed.valueOf()) ? '' : parsed.toISOString();
}

function normalizeFollowUpStatus(value, legacyResolved = false) {
  const token = normalizeString(value).toLowerCase();
  if (token === 'deferred' || token === 'resolved') {
    return token;
  }
  return legacyResolved === true ? 'resolved' : 'active';
}

function normalizeFollowUpDeferPreset(value) {
  const token = normalizeString(value).toLowerCase();
  return FOLLOW_UP_DEFER_PRESETS.includes(token) ? token : '';
}

function normalizeFollowUpSourceKind(value) {
  const token = normalizeString(value).toLowerCase();
  return FOLLOW_UP_SOURCE_KINDS.includes(token) ? token : '';
}

function normalizeFollowUpSourceMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return cloneJsonValue(value);
}

function normalizeFollowUpHistoryKind(value) {
  const token = normalizeString(value).toLowerCase();
  return FOLLOW_UP_HISTORY_KINDS.includes(token) ? token : '';
}

function normalizeFollowUpHistoryEntry(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const kind = normalizeFollowUpHistoryKind(source.kind);
  const at = normalizeIsoString(source.at);
  const detail = normalizeString(source.detail);
  if (!kind || !at) {
    return null;
  }
  return {
    kind,
    at,
    detail,
  };
}

function normalizeFollowUpHistory(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeFollowUpHistoryEntry(entry))
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeResourceAlertThreshold(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return RESOURCE_ALERT_THRESHOLD_DEFAULT;
  }
  return Math.max(
    RESOURCE_ALERT_THRESHOLD_MIN,
    Math.min(RESOURCE_ALERT_THRESHOLD_MAX, Math.round(numeric))
  );
}

function normalizeReminder(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const scheduleType = normalizeScheduleType(source.scheduleType || source.schedule_type);
  return {
    id: normalizeString(source.id) || createReminderId(),
    label: clipText(source.label || 'Reminder', MAX_PROACTIVE_REMINDER_LABEL_CHARS) || 'Reminder',
    prompt: clipText(source.prompt, MAX_PROACTIVE_REMINDER_PROMPT_CHARS),
    scheduleType,
    dailyAt: scheduleType === 'daily_at' ? normalizeDailyAt(source.dailyAt || source.daily_at) : '',
    intervalMinutes:
      scheduleType === 'interval_minutes'
        ? normalizeIntervalMinutes(source.intervalMinutes || source.interval_minutes)
        : 0,
    // Same discipline as dailyAt/intervalMinutes: the key is always present but
    // only carries a value for its own scheduleType, so switching cadence can
    // never leave a stale one-shot time behind.
    onceAt: scheduleType === 'once_at' ? normalizeReminderOnceAt(source.onceAt || source.once_at) : '',
    sourceKind: normalizeReminderSourceKind(source.sourceKind || source.source_kind),
    sourceId: normalizeString(source.sourceId || source.source_id).slice(0, MAX_REMINDER_SOURCE_ID_CHARS),
    enabled: source.enabled !== false,
    createdAt: normalizeIsoString(source.createdAt || source.created_at) || new Date().toISOString(),
    lastFiredAt: normalizeIsoString(source.lastFiredAt || source.last_fired_at),
  };
}

function normalizeFollowUp(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const createdAt = normalizeIsoString(source.createdAt || source.created_at);
  const updatedAt =
    normalizeIsoString(source.updatedAt || source.updated_at)
    || createdAt;
  const resolvedAt = normalizeIsoString(source.resolvedAt || source.resolved_at);
  const deferredUntil = normalizeIsoString(source.deferredUntil || source.deferred_until);
  const archivedAt = normalizeIsoString(source.archivedAt || source.archived_at);
  const sourceId = normalizeString(source.sourceId || source.source_id);
  const status = normalizeFollowUpStatus(source.status, source.resolved === true);
  const normalizedStatus =
    status === 'deferred' && !deferredUntil
      ? 'active'
      : status;
  const normalizedArchivedAt = normalizedStatus === 'resolved' ? archivedAt : '';
  return {
    id: normalizeString(source.id),
    label: clipText(source.label || 'Follow-up', MAX_FOLLOW_UP_LABEL_CHARS) || 'Follow-up',
    body: clipText(source.body, MAX_FOLLOW_UP_BODY_CHARS),
    status: normalizedStatus,
    createdAt,
    updatedAt,
    resolvedAt: normalizedStatus === 'resolved' ? (resolvedAt || updatedAt || createdAt) : '',
    deferredUntil: normalizedStatus === 'deferred' ? deferredUntil : '',
    deferPreset:
      normalizedStatus === 'deferred' && deferredUntil
        ? normalizeFollowUpDeferPreset(source.deferPreset || source.defer_preset)
        : '',
    archivedAt: normalizedArchivedAt,
    sessionId: normalizeString(source.sessionId || source.session_id),
    sourceKind: normalizeFollowUpSourceKind(source.sourceKind || source.source_kind),
    sourceId,
    sourceMeta: normalizeFollowUpSourceMeta(source.sourceMeta || source.source_meta),
    history: normalizeFollowUpHistory(source.history),
  };
}

function sortReminders(reminders) {
  return reminders.slice().sort((left, right) => {
    const leftCreated = String(left.createdAt || '');
    const rightCreated = String(right.createdAt || '');
    return leftCreated.localeCompare(rightCreated);
  }).slice(0, MAX_PROACTIVE_REMINDERS);
}

module.exports = {
  RESOURCE_ALERT_THRESHOLD_DEFAULT,
  RESOURCE_ALERT_THRESHOLD_MIN,
  RESOURCE_ALERT_THRESHOLD_MAX,
  MAX_PROACTIVE_REMINDERS,
  MAX_PROACTIVE_REMINDER_LABEL_CHARS,
  MAX_PROACTIVE_REMINDER_PROMPT_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_REMINDER_SOURCE_ID_CHARS,
  REMINDER_SCHEDULE_TYPES,
  REMINDER_SOURCE_KINDS,
  FOLLOW_UP_STATUSES,
  FOLLOW_UP_DEFER_PRESETS,
  FOLLOW_UP_SOURCE_KINDS,
  FOLLOW_UP_HISTORY_KINDS,
  cloneJsonValue,
  createReminderId,
  normalizeWatcherGlobs,
  normalizeScheduleType,
  normalizeReminderOnceAt,
  normalizeReminderSourceKind,
  normalizeDailyAt,
  normalizeIntervalMinutes,
  normalizeIsoString,
  normalizeFollowUpStatus,
  normalizeFollowUpDeferPreset,
  normalizeFollowUpSourceKind,
  normalizeFollowUpSourceMeta,
  normalizeFollowUpHistoryKind,
  normalizeFollowUpHistoryEntry,
  normalizeFollowUpHistory,
  normalizeResourceAlertThreshold,
  normalizeReminder,
  normalizeFollowUp,
  sortReminders,
};
