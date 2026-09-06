const { normalizeString } = require('./backend/path-utils');
const { normalizeIsoString, normalizeFollowUpDeferPreset } = require('./shell-config-state');

function hasOwn(source, key) {
  if (!source || typeof source !== 'object') {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(source, key);
}

function readPatchedValue(source, camelKey, snakeKey) {
  if (hasOwn(source, camelKey)) {
    return source[camelKey];
  }
  if (snakeKey && hasOwn(source, snakeKey)) {
    return source[snakeKey];
  }
  return undefined;
}

function readPatchedString(source, camelKey, snakeKey, fallback) {
  const rawValue = readPatchedValue(source, camelKey, snakeKey);
  if (typeof rawValue === 'undefined') {
    return fallback || '';
  }
  return normalizeString(rawValue);
}

function readPatchedIsoString(source, camelKey, snakeKey, fallback) {
  const rawValue = readPatchedValue(source, camelKey, snakeKey);
  if (typeof rawValue === 'undefined') {
    return fallback || '';
  }
  return normalizeIsoString(rawValue);
}

function cloneNow(nowProvider) {
  const candidate = typeof nowProvider === 'function' ? nowProvider() : new Date();
  const normalized = candidate instanceof Date ? new Date(candidate.valueOf()) : new Date(candidate);
  return Number.isNaN(normalized.valueOf()) ? new Date() : normalized;
}

function buildFollowUpId(now = new Date()) {
  const timestamp = now instanceof Date && !Number.isNaN(now.valueOf()) ? now.valueOf() : Date.now();
  return `followup-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValidTimeZone(timeZone) {
  const token = normalizeString(timeZone);
  if (!token) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: token }).format(new Date(0));
    return true;
  } catch (_error) {
    return false;
  }
}

function zonedDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function addDaysToPlainDate(parts, daysToAdd) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + daysToAdd));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = zonedDateParts(date, timeZone);
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  ) - date.getTime();
}

function zonedScheduledIso(dateParts, hours, minutes, timeZone) {
  const localAsUtc = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    hours,
    minutes,
    0,
    0
  );
  let offset = timeZoneOffsetMs(new Date(localAsUtc), timeZone);
  let utcMillis = localAsUtc - offset;
  const correctedOffset = timeZoneOffsetMs(new Date(utcMillis), timeZone);
  if (correctedOffset !== offset) {
    offset = correctedOffset;
    utcMillis = localAsUtc - offset;
  }
  return new Date(utcMillis).toISOString();
}

function buildLocalScheduledIso(now, daysToAdd, hours, minutes) {
  const scheduled = new Date(now);
  scheduled.setDate(scheduled.getDate() + daysToAdd);
  scheduled.setHours(hours, minutes, 0, 0);
  return scheduled.toISOString();
}

function buildZonedScheduledIso(now, daysToAdd, hours, minutes, timeZone) {
  const currentParts = zonedDateParts(now, timeZone);
  const dateParts = addDaysToPlainDate(currentParts, daysToAdd);
  return zonedScheduledIso(dateParts, hours, minutes, timeZone);
}

function calculateDeferredUntilForPreset(preset, now = new Date(), scheduleOptions = {}) {
  const normalizedPreset = normalizeFollowUpDeferPreset(preset);
  if (!normalizedPreset) {
    throw new Error(`Invalid defer preset: ${preset}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error('A valid Date is required to calculate deferred follow-up timing.');
  }
  const timeZone = normalizeString(scheduleOptions?.timeZone);
  const useResolvedTimeZone = isValidTimeZone(timeZone);
  if (normalizedPreset === 'later_today') {
    const scheduledIso = useResolvedTimeZone
      ? buildZonedScheduledIso(now, 0, 17, 0, timeZone)
      : buildLocalScheduledIso(now, 0, 17, 0);
    if (new Date(scheduledIso).valueOf() <= now.valueOf()) {
      throw new Error('The "Later today" preset is unavailable after 5:00 PM local time.');
    }
    return scheduledIso;
  }
  if (normalizedPreset === 'tomorrow') {
    return useResolvedTimeZone
      ? buildZonedScheduledIso(now, 1, 9, 0, timeZone)
      : buildLocalScheduledIso(now, 1, 9, 0);
  }
  return useResolvedTimeZone
    ? buildZonedScheduledIso(now, 7, 9, 0, timeZone)
    : buildLocalScheduledIso(now, 7, 9, 0);
}

function getAvailableFollowUpDeferPresets(now = new Date(), presets = [], scheduleOptions = {}) {
  const options = [];
  for (const preset of presets) {
    try {
      const deferredUntil = calculateDeferredUntilForPreset(preset, now, scheduleOptions);
      options.push({
        preset,
        label:
          preset === 'later_today'
            ? 'Later today'
            : preset === 'tomorrow'
              ? 'Tomorrow'
              : 'Next week',
        deferredUntil,
      });
    } catch (_error) {
      // Hidden/unavailable presets are intentionally omitted from the UI.
    }
  }
  return options;
}

function getFollowUpPresetLabel(preset) {
  return preset === 'later_today'
    ? 'Later today'
    : preset === 'tomorrow'
      ? 'Tomorrow'
      : 'Next week';
}

function followUpRecordsEqual(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function resolveRequestedFollowUpStatus(source, existing = null) {
  const explicitStatus = readPatchedString(source, 'status', null, '');
  if (explicitStatus === 'deferred' || explicitStatus === 'resolved' || explicitStatus === 'active') {
    return explicitStatus;
  }
  if (source?.resolved === true) {
    return 'resolved';
  }
  const patchedDeferPreset = normalizeFollowUpDeferPreset(
    readPatchedString(source, 'deferPreset', 'defer_preset', '')
  );
  const patchedDeferredUntil = readPatchedIsoString(source, 'deferredUntil', 'deferred_until', '');
  if (patchedDeferPreset || patchedDeferredUntil) {
    return 'deferred';
  }
  const existingStatus = normalizeString(existing?.status).toLowerCase();
  if (existingStatus === 'deferred' || existingStatus === 'resolved') {
    return existingStatus;
  }
  return 'active';
}

module.exports = {
  buildFollowUpId,
  calculateDeferredUntilForPreset,
  cloneNow,
  followUpRecordsEqual,
  getAvailableFollowUpDeferPresets,
  getFollowUpPresetLabel,
  hasOwn,
  readPatchedIsoString,
  readPatchedString,
  readPatchedValue,
  resolveRequestedFollowUpStatus,
};
