'use strict';

const { HOME_CALENDAR_COLOR_IDS } = require('../home-config-schema');

const MAX_RESULT_FIELD_CHARS = 64;
const MAX_ID_CHARS = 512;
const MAX_TITLE_CHARS = 120;
const MAX_WHEN_CHARS = 32;
const MAX_INSTANCES = 40;
const MAX_OVERLAPS = 8;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const CALENDAR_CATEGORIES = new Set(HOME_CALENDAR_COLOR_IDS);
const CALENDAR_SOURCES = new Set(['local', 'feed']);
const CALENDAR_SOURCE_KINDS = new Set(['assistant', 'user']);
const CALENDAR_ITEM_KINDS = new Set(['event', 'reminder']);
const CALENDAR_RECENT_STATES = new Set(['created', 'updated']);
const CALENDAR_RECEIPT_OPERATIONS = new Set(['create', 'update', 'delete']);
const REMINDER_SCHEDULE_TYPES = new Set(['once_at', 'daily_at', 'interval_minutes']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function safeString(value, maxChars = Infinity) {
  if (typeof value === 'symbol' || value == null) return '';
  try {
    return String(value).trim().slice(0, maxChars);
  } catch (_error) {
    return '';
  }
}

function normalizeDatetime(value) {
  if (typeof value !== 'string' || value.length !== 16 || !DATETIME_PATTERN.test(value)) return '';
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    && date.getHours() === hour
    && date.getMinutes() === minute
    ? value
    : '';
}

function normalizeNonNegativeInteger(value) {
  try {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
  } catch (_error) {
    return 0;
  }
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = safeString(value, MAX_ID_CHARS);
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeId(value) {
  const normalized = safeString(value);
  return normalized.length <= MAX_ID_CHARS ? normalized : null;
}

function normalizeOverlap(value) {
  if (!isPlainObject(value)) return null;
  const instanceId = normalizeId(value.instance_id);
  const start = normalizeDatetime(value.start);
  if (!instanceId || !start) return null;
  return {
    instance_id: instanceId,
    title: safeString(value.title, MAX_TITLE_CHARS),
    start,
  };
}

function normalizeOverlaps(value) {
  if (!Array.isArray(value)) return [];
  const overlaps = [];
  for (const entry of value.slice(0, MAX_OVERLAPS)) {
    const overlap = normalizeOverlap(entry);
    if (overlap) overlaps.push(overlap);
  }
  return overlaps;
}

function normalizeCalendarInstance(value) {
  if (!isPlainObject(value)) return null;
  const instanceId = normalizeId(value.instance_id);
  const eventId = normalizeId(value.event_id);
  const start = normalizeDatetime(value.start);
  const end = normalizeDatetime(value.end);
  if (!instanceId || eventId === null || !start || !end) return null;
  const normalized = {
    instance_id: instanceId,
    event_id: eventId,
    title: safeString(value.title, MAX_TITLE_CHARS),
    start,
    end,
    all_day: value.all_day === true,
    category: normalizeEnum(value.category, CALENDAR_CATEGORIES, 'default'),
    source: normalizeEnum(value.source, CALENDAR_SOURCES, 'local'),
    source_kind: normalizeEnum(value.source_kind, CALENDAR_SOURCE_KINDS, ''),
    readonly: value.readonly === true,
    tz_approx: value.tz_approx === true,
    recurrence_unsupported: value.recurrence_unsupported === true,
    kind: normalizeEnum(value.kind, CALENDAR_ITEM_KINDS, 'event'),
  };
  const recent = normalizeEnum(value.recent, CALENDAR_RECENT_STATES, '');
  if (recent) {
    normalized.recent = recent;
    if (hasOwn(value, 'journal_entry_id')) {
      normalized.journal_entry_id = normalizeId(value.journal_entry_id) || '';
    }
  }
  const overlaps = normalizeOverlaps(value.overlaps);
  if (overlaps.length) normalized.overlaps = overlaps;
  return normalized;
}

function normalizeCalendar(value) {
  if (!isPlainObject(value) || value.schema_version !== 1) return null;
  const rangeStart = normalizeDatetime(value.range_start);
  const rangeEnd = normalizeDatetime(value.range_end);
  if (!rangeStart || !rangeEnd) return null;
  const instances = [];
  if (Array.isArray(value.instances)) {
    for (const entry of value.instances.slice(0, MAX_INSTANCES)) {
      const instance = normalizeCalendarInstance(entry);
      if (instance) instances.push(instance);
    }
  }
  return {
    schema_version: 1,
    range_start: rangeStart,
    range_end: rangeEnd,
    generated_at: normalizeDatetime(value.generated_at),
    instance_count: normalizeNonNegativeInteger(value.instance_count),
    omitted_count: normalizeNonNegativeInteger(value.omitted_count),
    instances,
  };
}

function assignEventReceiptFields(normalized, source) {
  const start = normalizeDatetime(source.start);
  const end = normalizeDatetime(source.end);
  if (start) normalized.start = start;
  if (end) normalized.end = end;
  if (hasOwn(source, 'all_day')) normalized.all_day = source.all_day === true;
  if (hasOwn(source, 'category')) {
    normalized.category = normalizeEnum(source.category, CALENDAR_CATEGORIES, 'default');
  }
}

function assignReminderReceiptFields(normalized, source) {
  const scheduleType = normalizeEnum(source.schedule_type, REMINDER_SCHEDULE_TYPES, '');
  if (scheduleType) normalized.schedule_type = scheduleType;
  if (hasOwn(source, 'when')) normalized.when = safeString(source.when, MAX_WHEN_CHARS);
}

function normalizeCalendarReceipt(value) {
  if (!isPlainObject(value) || value.schema_version !== 1) return null;
  const kind = normalizeEnum(value.kind, CALENDAR_ITEM_KINDS, '');
  const op = normalizeEnum(value.op, CALENDAR_RECEIPT_OPERATIONS, '');
  const id = normalizeId(value.id);
  if (!kind || !op || !id) return null;
  const normalized = {
    schema_version: 1,
    kind,
    op,
    id,
    title: safeString(value.title, MAX_TITLE_CHARS),
  };
  if (kind === 'event') assignEventReceiptFields(normalized, value);
  if (kind === 'reminder') assignReminderReceiptFields(normalized, value);
  normalized.journal_entry_id = normalizeId(value.journal_entry_id) || '';
  normalized.journaled = value.journaled === true;
  return normalized;
}

function normalizeHomeResultMetadata(source) {
  try {
    if (!isPlainObject(source) || source.result_kind !== 'home') return null;
    const normalized = {
      result_kind: 'home',
      action: safeString(source.action, MAX_RESULT_FIELD_CHARS),
      status: safeString(source.status, MAX_RESULT_FIELD_CHARS),
    };
    const calendar = normalizeCalendar(source.calendar);
    const calendarReceipt = normalizeCalendarReceipt(source.calendar_receipt);
    if (calendar) normalized.calendar = calendar;
    if (calendarReceipt) normalized.calendar_receipt = calendarReceipt;
    return normalized;
  } catch (_error) {
    return null;
  }
}

module.exports = { normalizeHomeResultMetadata };
