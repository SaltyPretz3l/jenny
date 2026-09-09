'use strict';

/* Typed, renderer-only calendar result shapes for the `home` tool. Keeping the
 * computation here leaves the action handlers focused on facade dispatch and
 * keeps calendar metadata independent from Electron persistence and UI code. */

const { normalizeString } = require('../../shared/normalize');

const MAX_METADATA_INSTANCES = 40;
const MAX_OVERLAPS_PER_INSTANCE = 8;
const MAX_METADATA_TITLE_CHARS = 120;

function text(value) {
  return typeof value === 'string' ? value : '';
}

function title(value) {
  return text(value).slice(0, MAX_METADATA_TITLE_CHARS);
}

function formatLocalMinute(value) {
  const pad2 = (part) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
    + `T${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
}

function isTimedAndParseable(instance) {
  return instance?.allDay !== true
    && Number.isFinite(Date.parse(instance?.start))
    && Number.isFinite(Date.parse(instance?.end));
}

function compareInstances(left, right) {
  return text(left?.start).localeCompare(text(right?.start))
    || normalizeString(left?.instanceId).localeCompare(normalizeString(right?.instanceId));
}

function instancesOverlap(earlier, later) {
  return earlier.start < later.end
    && later.start < earlier.end;
}

function computeOverlaps(instances) {
  const candidates = (Array.isArray(instances) ? instances : [])
    .filter(isTimedAndParseable)
    .sort(compareInstances);
  const overlaps = new Map();
  for (let laterIndex = 1; laterIndex < candidates.length; laterIndex += 1) {
    const later = candidates[laterIndex];
    for (let earlierIndex = 0; earlierIndex < laterIndex; earlierIndex += 1) {
      const earlier = candidates[earlierIndex];
      if (!instancesOverlap(earlier, later)) continue;
      const laterId = normalizeString(later.instanceId);
      const current = overlaps.get(laterId) || [];
      if (current.length >= MAX_OVERLAPS_PER_INSTANCE) continue;
      current.push({
        instance_id: normalizeString(earlier.instanceId),
        title: text(earlier.title),
        start: text(earlier.start),
      });
      overlaps.set(laterId, current);
    }
  }
  return overlaps;
}

function indexRecentJournal(entries, sessionId) {
  const expectedSessionId = normalizeString(sessionId);
  const recent = new Map();
  if (!expectedSessionId) return recent;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const op = entry?.op;
    if (
      entry?.entity !== 'calendar_event'
      || normalizeString(entry?.sessionId) !== expectedSessionId
      || entry?.undoneAt
      || entry?.supersededAt
      || (op !== 'create' && op !== 'update')
    ) {
      continue;
    }
    const eventId = normalizeString(entry?.entityId);
    if (!eventId) continue;
    recent.set(eventId, {
      recent: op === 'create' ? 'created' : 'updated',
      journal_entry_id: normalizeString(entry?.id),
    });
  }
  return recent;
}

function shapeInstance(instance, overlaps, recentJournal) {
  const shaped = {
    instance_id: normalizeString(instance?.instanceId),
    event_id: normalizeString(instance?.eventId),
    title: title(instance?.title),
    start: text(instance?.start),
    end: text(instance?.end),
    all_day: instance?.allDay === true,
    category: normalizeString(instance?.categoryId) || 'default',
    source: instance?.source === 'feed' ? 'feed' : 'local',
    source_kind: ['assistant', 'user'].includes(instance?.sourceKind) ? instance.sourceKind : '',
    readonly: instance?.readonly === true,
    tz_approx: instance?.tzApprox === true,
    recurrence_unsupported: instance?.recurrenceUnsupported === true,
    kind: 'event',
  };
  const recent = recentJournal.get(shaped.event_id);
  const instanceOverlaps = overlaps.get(shaped.instance_id);
  if (recent) Object.assign(shaped, recent);
  if (instanceOverlaps?.length) shaped.overlaps = instanceOverlaps;
  return shaped;
}

function shapeCalendarMetadata({ listing, journalEntries, sessionId, now, overlaps }) {
  const allInstances = Array.isArray(listing?.instances) ? listing.instances : [];
  const shownInstances = allInstances.slice(0, MAX_METADATA_INSTANCES);
  const overlapIndex = overlaps === undefined ? computeOverlaps(allInstances) : overlaps;
  const recentJournal = indexRecentJournal(journalEntries, sessionId);
  return {
    schema_version: 1,
    range_start: listing?.rangeStart,
    range_end: listing?.rangeEnd,
    generated_at: formatLocalMinute(now),
    instance_count: allInstances.length,
    omitted_count: allInstances.length - shownInstances.length,
    instances: shownInstances.map((instance) => shapeInstance(instance, overlapIndex, recentJournal)),
  };
}

function firstDefined(primary, fallback, key) {
  return primary?.[key] === undefined ? fallback?.[key] : primary[key];
}

function shapeEventFields(primary, fallback) {
  const shaped = {};
  const start = firstDefined(primary, fallback, 'start');
  const end = firstDefined(primary, fallback, 'end');
  const allDay = firstDefined(primary, fallback, 'allDay');
  const category = firstDefined(primary, fallback, 'categoryId');
  if (typeof start === 'string' && start) shaped.start = start;
  if (typeof end === 'string' && end) shaped.end = end;
  if (typeof allDay === 'boolean') shaped.all_day = allDay;
  if (typeof category === 'string' && category) shaped.category = category;
  return shaped;
}

function shapeReminderFields(primary, fallback) {
  const scheduleType = firstDefined(primary, fallback, 'scheduleType');
  if (scheduleType === 'interval_minutes') {
    return {
      schedule_type: scheduleType,
      when: String(firstDefined(primary, fallback, 'intervalMinutes')),
    };
  }
  if (scheduleType !== 'once_at' && scheduleType !== 'daily_at') return {};
  const timeKey = scheduleType === 'once_at' ? 'onceAt' : 'dailyAt';
  return {
    schedule_type: scheduleType,
    when: text(firstDefined(primary, fallback, timeKey)),
  };
}

function shapeReceipt({
  kind,
  op,
  entityState,
  existing,
  journalEntryId,
  journaled,
  fallback = {},
}) {
  const primary = entityState || existing || {};
  const nameKey = kind === 'event' ? 'title' : 'label';
  return {
    schema_version: 1,
    kind,
    op,
    id: normalizeString(firstDefined(primary, fallback, 'id')),
    title: title(firstDefined(primary, fallback, nameKey)),
    ...(kind === 'event'
      ? shapeEventFields(primary, fallback)
      : shapeReminderFields(primary, fallback)),
    journal_entry_id: normalizeString(journalEntryId),
    journaled: journaled === true,
  };
}

module.exports = {
  MAX_METADATA_INSTANCES,
  computeOverlaps,
  indexRecentJournal,
  shapeCalendarMetadata,
  shapeReceipt,
};
