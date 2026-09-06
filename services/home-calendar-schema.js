const { normalizeString } = require('./backend/path-utils');
const { HOME_CALENDAR_COLOR_IDS } = require('./home-config-schema');

// Home calendar event schema + recurrence expansion. Pure functions only — no
// I/O — so the calendar service, the ICS parser, and tests share one source of
// truth for event shapes and local wall-clock date math.
//
// Timezone policy (v1): all event times are LOCAL wall-clock, stored as naive
// "YYYY-MM-DDTHH:MM" strings (no Z, no offset). Recurrence steps by date
// COMPONENTS (never by adding milliseconds), so a 09:00 weekly event stays at
// 09:00 across DST transitions.
const MAX_CALENDAR_EVENTS = 500;
const MAX_CALENDAR_EVENT_TITLE_CHARS = 200;
const MAX_CALENDAR_EVENT_NOTES_CHARS = 2000;
const MAX_CALENDAR_EVENT_ID_CHARS = 64;
const MAX_CALENDAR_EVENT_SOURCE_ID_CHARS = 128;
const MAX_INSTANCES_PER_EVENT = 200;
const CALENDAR_WINDOW_PAST_DAYS = 7;
const CALENDAR_WINDOW_FUTURE_DAYS = 60;
const DEFAULT_TIMED_EVENT_MINUTES = 30;

const HOME_CALENDAR_RECURRENCE_PRESETS = Object.freeze([
  'none',
  'daily',
  'weekdays',
  'weekly',
  'biweekly',
  'monthly',
  'yearly',
]);

// Attribution: did the assistant CREATE this event. Mirrors the reminder
// sourceKind precedent (services/shell-config-followups-schema.js) — a closed
// enum that coerces anything unrecognized to '' (unattributed) rather than
// dropping the record, so agenda rows can badge assistant-created events.
// '' is the only value a pre-existing config can produce, which is why this is
// additive and needs no CONFIG_VERSION bump.
//
// 'assistant' is the ONLY member: HomeAssistantService is the only writer that
// stamps this field, the Home UI's own create path stamps nothing, and every
// reader asks exactly one question (`=== 'assistant'`). A 'user' member that no
// writer produces would read as a live distinction the field does not draw.
const HOME_CALENDAR_SOURCE_KINDS = Object.freeze(['assistant']);

// Category ids double as the color enum (palette-safe CSS token ids) — the
// config-level list in home-config-schema is the canonical source.
const HOME_CALENDAR_CATEGORIES = Object.freeze(
  HOME_CALENDAR_COLOR_IDS.map((id) =>
    Object.freeze({ id, label: id.charAt(0).toUpperCase() + id.slice(1) })
  )
);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Strict local-naive parse: "YYYY-MM-DDTHH:MM[:SS]". Field round-trip check
// rejects overflow dates (e.g. Feb 30) that the Date constructor would roll.
function parseLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(normalizeString(value));
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
  ) {
    return null;
  }
  return date;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date, days) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    date.getHours(),
    date.getMinutes()
  );
}

// Wall-clock duration helpers. A recurrence occurrence must keep its local
// start AND end across a DST boundary; deriving the end from a fixed
// millisecond delta drifts the wall-clock end by an hour on the 23h/25h
// transition days, so we measure and re-apply the duration in calendar
// components instead. (round() absorbs the 23h/25h day when counting days.)
function wallClockDurationMinutes(start, end) {
  const dayDiff = Math.round(
    (startOfLocalDay(end).getTime() - startOfLocalDay(start).getTime()) / 86400000
  );
  return dayDiff * 1440
    + (end.getHours() * 60 + end.getMinutes())
    - (start.getHours() * 60 + start.getMinutes());
}

function addWallClockMinutes(date, minutes) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes() + minutes
  );
}

// Per-occurrence exception keys (local-naive occurrence-start strings) removed
// from a recurring series — the "this event only" edit/delete path. Each must
// be a parseable local datetime; deduped, capped to the per-event instance cap.
function normalizeCalendarExceptions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const parsed = parseLocalDateTime(entry);
    if (!parsed) {
      continue;
    }
    const key = formatLocalDateTime(parsed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_INSTANCES_PER_EVENT) {
      break;
    }
  }
  return out;
}

function computeCalendarWindow(now = new Date()) {
  const today = startOfLocalDay(now);
  return {
    windowStart: addLocalDays(today, -CALENDAR_WINDOW_PAST_DAYS),
    // +1 so the final future day is included in full.
    windowEnd: addLocalDays(today, CALENDAR_WINDOW_FUTURE_DAYS + 1),
  };
}

function normalizeCalendarTitle(value) {
  return normalizeString(value).replace(/[\r\n\0]+/g, ' ').slice(0, MAX_CALENDAR_EVENT_TITLE_CHARS);
}

// Notes keep user formatting (newlines survive); only NUL is stripped.
function normalizeCalendarNotes(value) {
  return typeof value === 'string'
    ? value.replace(/\0/g, '').slice(0, MAX_CALENDAR_EVENT_NOTES_CHARS)
    : '';
}

function normalizeCalendarSourceKind(value) {
  const token = normalizeString(value).toLowerCase();
  return HOME_CALENDAR_SOURCE_KINDS.includes(token) ? token : '';
}

// Opaque back-reference to whatever created the event (a message id, a task
// id). Never parsed here — only bounded — so the field can never become an
// unbounded blob on the config write path.
function normalizeCalendarSourceId(value) {
  return normalizeString(value).slice(0, MAX_CALENDAR_EVENT_SOURCE_ID_CHARS);
}

function normalizeCalendarIsoOrEmpty(value) {
  const normalized = normalizeString(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(normalized) ? normalized : '';
}

// Returns a normalized event or null when the entry is unsalvageable (no id
// or no parseable start). End times self-heal instead of dropping the event:
// a timed end at/before start becomes start+30min, an all-day end becomes the
// next midnight — the data stays renderable and the rule is documented here.
function normalizeCalendarEvent(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const id = normalizeString(source.id).slice(0, MAX_CALENDAR_EVENT_ID_CHARS);
  if (!id) {
    return null;
  }
  const allDay = source.allDay === true;
  let start = parseLocalDateTime(source.start);
  if (!start) {
    return null;
  }
  let end = parseLocalDateTime(source.end);
  if (allDay) {
    start = startOfLocalDay(start);
    end = end ? startOfLocalDay(end) : null;
    if (!end || end.getTime() <= start.getTime()) {
      end = addLocalDays(start, 1);
    }
  } else if (!end || end.getTime() <= start.getTime()) {
    end = new Date(start.getTime() + DEFAULT_TIMED_EVENT_MINUTES * 60000);
  }
  const categoryId = normalizeString(source.categoryId).toLowerCase();
  const recurrence = normalizeString(source.recurrence).toLowerCase();
  return {
    id,
    title: normalizeCalendarTitle(source.title),
    start: formatLocalDateTime(start),
    end: formatLocalDateTime(end),
    allDay,
    categoryId: HOME_CALENDAR_COLOR_IDS.includes(categoryId) ? categoryId : 'default',
    notes: normalizeCalendarNotes(source.notes),
    recurrence: HOME_CALENDAR_RECURRENCE_PRESETS.includes(recurrence) ? recurrence : 'none',
    exceptions: normalizeCalendarExceptions(source.exceptions),
    sourceKind: normalizeCalendarSourceKind(source.sourceKind),
    sourceId: normalizeCalendarSourceId(source.sourceId),
    createdAt: normalizeCalendarIsoOrEmpty(source.createdAt),
    updatedAt: normalizeCalendarIsoOrEmpty(source.updatedAt),
  };
}

function normalizeCalendarEventList(value) {
  const raw = Array.isArray(value) ? value : [];
  const seenIds = new Set();
  const events = [];
  for (const entry of raw) {
    if (events.length >= MAX_CALENDAR_EVENTS) {
      break;
    }
    const normalized = normalizeCalendarEvent(entry);
    if (!normalized || seenIds.has(normalized.id)) {
      continue;
    }
    seenIds.add(normalized.id);
    events.push(normalized);
  }
  return events;
}

const PRESET_STEP_DAYS = Object.freeze({
  daily: 1,
  weekdays: 1,
  weekly: 7,
  biweekly: 14,
});

function buildLocalInstance(event, occStart, occEnd) {
  return {
    instanceId: `${event.id}:${formatLocalDateTime(occStart)}`,
    eventId: event.id,
    source: 'local',
    feedId: null,
    readonly: false,
    title: event.title,
    start: formatLocalDateTime(occStart),
    end: formatLocalDateTime(occEnd),
    allDay: event.allDay,
    categoryId: event.categoryId,
    notes: event.notes,
    // Attribution rides along onto every occurrence so an agenda row can badge
    // its origin without re-reading the stored event.
    sourceKind: normalizeCalendarSourceKind(event.sourceKind),
    sourceId: normalizeCalendarSourceId(event.sourceId),
    recurring: event.recurrence !== 'none',
    recurrenceUnsupported: false,
  };
}

function instanceOverlapsWindow(occStart, occEnd, windowStart, windowEnd) {
  return occEnd.getTime() > windowStart.getTime() && occStart.getTime() < windowEnd.getTime();
}

// Expands one stored event into concrete instances inside the window. Day-based
// presets fast-forward arithmetically (an event created years ago must not
// iterate day-by-day to reach the window), then step by date components.
function expandCalendarEvent(event, { windowStart, windowEnd, maxInstances = MAX_INSTANCES_PER_EVENT }) {
  const start = parseLocalDateTime(event.start);
  const end = parseLocalDateTime(event.end);
  if (!start || !end) {
    return [];
  }
  const durationMinutes = wallClockDurationMinutes(start, end);
  const exceptionSet = new Set(Array.isArray(event.exceptions) ? event.exceptions : []);
  const instances = [];
  const pushIfVisible = (occStart) => {
    // "This event only" edits/deletes remove the occurrence from the series.
    if (exceptionSet.has(formatLocalDateTime(occStart))) {
      return;
    }
    const occEnd = addWallClockMinutes(occStart, durationMinutes);
    if (instanceOverlapsWindow(occStart, occEnd, windowStart, windowEnd)) {
      instances.push(buildLocalInstance(event, occStart, occEnd));
    }
  };

  if (event.recurrence === 'monthly') {
    const monthDiff = (windowStart.getFullYear() - start.getFullYear()) * 12
      + (windowStart.getMonth() - start.getMonth());
    let k = Math.max(0, monthDiff - 1);
    for (; instances.length < maxInstances; k += 1) {
      const occStart = new Date(
        start.getFullYear(),
        start.getMonth() + k,
        start.getDate(),
        start.getHours(),
        start.getMinutes()
      );
      if (occStart.getTime() >= windowEnd.getTime()) {
        break;
      }
      // Rolled over (e.g. Jan 31 + 1 month -> Mar 3): that month has no such
      // day, so the occurrence is skipped rather than moved.
      if (occStart.getDate() !== start.getDate()) {
        continue;
      }
      pushIfVisible(occStart);
    }
    return instances;
  }

  if (event.recurrence === 'yearly') {
    // Fast-forward to the year before the window, then step by calendar years.
    let k = Math.max(0, windowStart.getFullYear() - start.getFullYear() - 1);
    for (; instances.length < maxInstances; k += 1) {
      const occStart = new Date(
        start.getFullYear() + k,
        start.getMonth(),
        start.getDate(),
        start.getHours(),
        start.getMinutes()
      );
      if (occStart.getTime() >= windowEnd.getTime()) {
        break;
      }
      // Feb 29 in a non-leap year rolls to Mar 1: skip rather than move.
      if (occStart.getDate() !== start.getDate()) {
        continue;
      }
      pushIfVisible(occStart);
    }
    return instances;
  }

  const stepDays = PRESET_STEP_DAYS[event.recurrence];
  if (!stepDays) {
    pushIfVisible(start);
    return instances;
  }
  const approxDaysBehind = Math.floor((windowStart.getTime() - start.getTime()) / 86400000);
  let k = Math.max(0, Math.floor(approxDaysBehind / stepDays) - 2);
  for (; instances.length < maxInstances; k += 1) {
    const occStart = addLocalDays(start, k * stepDays);
    if (occStart.getTime() >= windowEnd.getTime()) {
      break;
    }
    if (event.recurrence === 'weekdays') {
      const weekday = occStart.getDay();
      if (weekday === 0 || weekday === 6) {
        continue;
      }
    }
    pushIfVisible(occStart);
  }
  return instances;
}

function compareInstances(a, b) {
  if (a.start !== b.start) {
    return a.start < b.start ? -1 : 1;
  }
  if (a.end !== b.end) {
    return a.end < b.end ? -1 : 1;
  }
  return a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0;
}

function expandCalendarEvents(events, window) {
  const instances = [];
  for (const event of Array.isArray(events) ? events : []) {
    instances.push(...expandCalendarEvent(event, window));
  }
  instances.sort(compareInstances);
  return instances;
}

module.exports = {
  CALENDAR_WINDOW_PAST_DAYS,
  CALENDAR_WINDOW_FUTURE_DAYS,
  DEFAULT_TIMED_EVENT_MINUTES,
  HOME_CALENDAR_CATEGORIES,
  HOME_CALENDAR_RECURRENCE_PRESETS,
  HOME_CALENDAR_SOURCE_KINDS,
  MAX_CALENDAR_EVENTS,
  MAX_CALENDAR_EVENT_SOURCE_ID_CHARS,
  MAX_CALENDAR_EVENT_NOTES_CHARS,
  MAX_CALENDAR_EVENT_TITLE_CHARS,
  MAX_INSTANCES_PER_EVENT,
  addLocalDays,
  addWallClockMinutes,
  compareInstances,
  computeCalendarWindow,
  expandCalendarEvent,
  expandCalendarEvents,
  formatLocalDateTime,
  normalizeCalendarEvent,
  normalizeCalendarEventList,
  normalizeCalendarExceptions,
  normalizeCalendarSourceKind,
  buildLocalInstance,
  parseLocalDateTime,
  startOfLocalDay,
  wallClockDurationMinutes,
};
