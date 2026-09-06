const {
  MAX_INSTANCES_PER_EVENT,
  addLocalDays,
  addWallClockMinutes,
  formatLocalDateTime,
  wallClockDurationMinutes,
} = require('./home-calendar-schema');

// Minimal RFC 5545 (ICS) parser for read-only calendar feed subscriptions.
// Deliberately bounded — this is NOT a general iCalendar implementation:
// - RRULE subset: FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, COUNT, UNTIL, and
//   BYDAY (plain weekday codes, WEEKLY only). Anything else marks the event
//   recurrenceUnsupported: its first occurrence renders with a marker and the
//   feed surfaces a warning, instead of silently showing wrong dates.
// - Named-TZID times convert to local via Intl zone math; an unrecognized zone
//   (custom Outlook VTIMEZONE ids) falls back to wall-clock local + tzApprox.
// - VEVENTs carrying RECURRENCE-ID (modified single occurrences) are skipped
//   and counted: showing the unmodified series beats double-showing the
//   moved instance.
// - EXDATE is honored (it is common in real Outlook/Google feeds).
const MAX_RRULE_ITERATIONS = 5000;
const MAX_ICS_INPUT_CHARS = 2_000_000;
const MAX_ICS_UNFOLDED_LINES = 50_000;
const MAX_ICS_EVENTS = 5_000;

const WEEKDAY_OFFSET_FROM_MONDAY = Object.freeze({
  MO: 0,
  TU: 1,
  WE: 2,
  TH: 3,
  FR: 4,
  SA: 5,
  SU: 6,
});

// RFC 5545 line folding: a line starting with one space or tab continues the
// previous line (the leading char is stripped).
function unfoldIcsLinesBounded(text, maxLines) {
  const lines = [];
  const source = String(text || '');
  let start = 0;
  while (start <= source.length) {
    const lineEnd = source.indexOf('\n', start);
    const end = lineEnd === -1 ? source.length : lineEnd;
    let raw = source.slice(start, end);
    if (raw.endsWith('\r')) {
      raw = raw.slice(0, -1);
    }
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += raw.slice(1);
    } else if (raw !== '') {
      if (lines.length >= maxLines) {
        return { lines, truncated: true };
      }
      lines.push(raw);
    }
    if (lineEnd === -1) {
      break;
    }
    start = lineEnd + 1;
  }
  return { lines, truncated: false };
}

function unfoldIcsLines(text) {
  return unfoldIcsLinesBounded(text, Number.POSITIVE_INFINITY).lines;
}

// Splits "NAME;PARAM=V:value" at the first ':' outside double quotes (param
// values like ALTREP="http://..." legally contain colons).
function splitIcsProperty(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ':' && !inQuotes) {
      return { head: line.slice(0, i), value: line.slice(i + 1) };
    }
  }
  return null;
}

function parseIcsPropertyHead(head) {
  const segments = [];
  let current = '';
  let inQuotes = false;
  for (const ch of head) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ';' && !inQuotes) {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  const params = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = segment.slice(0, eq).trim().toUpperCase();
    params[key] = segment.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { name: segments[0].trim().toUpperCase(), params };
}

function unescapeIcsText(value) {
  return String(value || '').replace(/\\([\\;,nN])/g, (_, ch) =>
    ch === 'n' || ch === 'N' ? '\n' : ch
  );
}

// Converts a wall-clock time in a named IANA zone to the absolute instant,
// returned as a Date the app then reads with LOCAL getters (the same
// representation 'Z'/UTC values already use). Uses the standard Intl
// offset-probe: format the naive-as-UTC instant in the target zone, diff to
// recover the zone offset, subtract it. Returns null when the zone string is
// not a recognizable IANA name (custom Outlook VTIMEZONE ids, typos) so the
// caller can fall back to the wall-clock-local / tzApprox path. May be off by
// an hour for instants inside the DST transition window itself (rare).
function zonedWallClockToLocalDate(year, month, day, hour, minute, second, timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch (_error) {
    return null; // unrecognized time zone
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = {};
  for (const part of formatter.formatToParts(new Date(asUtc))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  if (!Number.isFinite(parts.year) || !Number.isFinite(parts.hour)) {
    return null;
  }
  // h23 renders midnight as 24; fold it back so Date.UTC stays in-range.
  const zonedHour = parts.hour === 24 ? 0 : parts.hour;
  const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, zonedHour, parts.minute, parts.second);
  const offset = zonedAsUtc - asUtc; // ms the zone leads UTC at ~this instant
  return new Date(asUtc - offset);
}

// Range + calendar validity (rejects 25:00, Feb 30, month 13). Deliberately a UTC
// probe: local round-trips would reject wall-clock times that fall in a DST gap.
function validIcsDateParts(year, month, day, hour, minute, second) {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31
    || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return false;
  }
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, 0);
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
    && probe.getUTCHours() === hour
    && probe.getUTCMinutes() === minute
    && probe.getUTCSeconds() === second;
}

function createIcsDate(year, month, day, hour, minute, second, utc) {
  const date = new Date(0);
  if (utc) {
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, 0);
  } else {
    date.setFullYear(year, month - 1, day);
    date.setHours(hour, minute, second, 0);
  }
  return date;
}

// Returns { date, allDay, tzApprox } or null. 'Z' values are absolute UTC and
// convert to local exactly; named-TZID values convert via Intl zone math
// (tzApprox=false), falling back to wall-clock local (tzApprox=true) when the
// zone is unrecognized; floating values are local by definition.
function parseIcsDateValue(value, params = {}) {
  const v = String(value || '').trim();
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (match || params.VALUE === 'DATE') {
    if (!match) {
      match = /^(\d{4})(\d{2})(\d{2})/.exec(v);
    }
    if (!match) {
      return null;
    }
    const year = +match[1];
    const month = +match[2];
    const day = +match[3];
    if (!validIcsDateParts(year, month, day, 0, 0, 0)) {
      return null;
    }
    const date = createIcsDate(year, month, day, 0, 0, 0, false);
    return Number.isNaN(date.getTime()) ? null : { date, allDay: true, tzApprox: false };
  }
  match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, utc] = match;
  const numericParts = [+year, +month, +day, +hour, +minute, +(second || 0)];
  const [yearValue, monthValue, dayValue, hourValue, minuteValue, sec] = numericParts;
  if (!validIcsDateParts(...numericParts)) {
    return null;
  }
  if (utc) {
    const date = createIcsDate(yearValue, monthValue, dayValue, hourValue, minuteValue, sec, true);
    return Number.isNaN(date.getTime()) ? null : { date, allDay: false, tzApprox: false };
  }
  if (params.TZID) {
    const converted = zonedWallClockToLocalDate(
      yearValue, monthValue, dayValue, hourValue, minuteValue, sec, params.TZID
    );
    if (converted && !Number.isNaN(converted.getTime())) {
      return { date: converted, allDay: false, tzApprox: false };
    }
    // Unrecognized zone: keep the wall-clock-local reading, flagged approximate.
    const fallback = createIcsDate(yearValue, monthValue, dayValue, hourValue, minuteValue, sec, false);
    return Number.isNaN(fallback.getTime()) ? null : { date: fallback, allDay: false, tzApprox: true };
  }
  const floating = createIcsDate(yearValue, monthValue, dayValue, hourValue, minuteValue, sec, false);
  return Number.isNaN(floating.getTime()) ? null : { date: floating, allDay: false, tzApprox: false };
}

// ISO 8601 duration subset (P1D, PT1H30M, P1W...) -> milliseconds, or null.
function parseIcsDuration(value) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    String(value || '').trim()
  );
  if (!match || !match.slice(2).some((component) => component !== undefined)) {
    return null;
  }
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const ms = ((+weeks || 0) * 604800 + (+days || 0) * 86400 + (+hours || 0) * 3600
    + (+minutes || 0) * 60 + (+seconds || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

function parseIcsRrule(value) {
  const rule = { freq: '', interval: 1, count: null, until: null, byDay: null };
  let unsupported = false;
  for (const part of String(value || '').split(';')) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf('=');
    const key = eq > 0 ? part.slice(0, eq).toUpperCase() : part.toUpperCase();
    const val = eq > 0 ? part.slice(eq + 1) : '';
    if (key === 'FREQ') {
      const freq = val.toUpperCase();
      if (freq === 'DAILY' || freq === 'WEEKLY' || freq === 'MONTHLY') {
        rule.freq = freq;
      } else {
        unsupported = true;
      }
    } else if (key === 'INTERVAL') {
      const interval = /^\d+$/.test(val) ? Number(val) : Number.NaN;
      if (Number.isSafeInteger(interval) && interval >= 1) {
        rule.interval = interval;
      } else {
        unsupported = true;
      }
    } else if (key === 'COUNT') {
      const count = /^\d+$/.test(val) ? Number(val) : Number.NaN;
      if (Number.isSafeInteger(count) && count >= 1) {
        rule.count = count;
      } else {
        unsupported = true;
      }
    } else if (key === 'UNTIL') {
      const parsed = parseIcsDateValue(val, {});
      if (parsed) {
        // Date-only UNTIL is inclusive of that whole day.
        rule.until = parsed.allDay
          ? new Date(addLocalDays(parsed.date, 1).getTime() - 1)
          : parsed.date;
      } else {
        unsupported = true;
      }
    } else if (key === 'BYDAY') {
      const codes = val.toUpperCase().split(',').map((code) => code.trim()).filter(Boolean);
      if (codes.every((code) => code in WEEKDAY_OFFSET_FROM_MONDAY)) {
        rule.byDay = codes;
      } else {
        // Ordinal BYDAY (1MO, -1FR...) is out of the supported subset.
        unsupported = true;
      }
    } else if (key !== 'WKST') {
      // Any other BYxxx/BYSETPOS rule part changes the recurrence set in ways
      // this subset cannot reproduce — degrade instead of guessing.
      unsupported = true;
    }
  }
  if (!rule.freq || (rule.byDay && rule.freq !== 'WEEKLY')) {
    unsupported = true;
  }
  return { rule, unsupported };
}

function finalizeIcsEvent(props) {
  const dtstart = props.dtstart ? parseIcsDateValue(props.dtstart.value, props.dtstart.params) : null;
  if (!dtstart) {
    return null;
  }
  let end = null;
  if (props.dtend) {
    const parsed = parseIcsDateValue(props.dtend.value, props.dtend.params);
    end = parsed ? parsed.date : null;
  } else if (props.duration) {
    const ms = parseIcsDuration(props.duration.value);
    end = ms !== null ? new Date(dtstart.date.getTime() + ms) : null;
  }
  if (!end || end.getTime() < dtstart.date.getTime()) {
    // RFC defaults: DATE events span one day; DATE-TIME events are point-in-time.
    end = dtstart.allDay ? addLocalDays(dtstart.date, 1) : new Date(dtstart.date.getTime());
  }
  let rrule = null;
  let rruleUnsupported = false;
  if (props.rrule) {
    const parsed = parseIcsRrule(props.rrule.value);
    rrule = parsed.rule;
    rruleUnsupported = parsed.unsupported;
  }
  const exdateKeys = new Set();
  for (const entry of props.exdates) {
    for (const value of entry.value.split(',')) {
      const parsed = parseIcsDateValue(value, entry.params);
      if (parsed) {
        exdateKeys.add(formatLocalDateTime(parsed.date));
      }
    }
  }
  return {
    uid: props.uid ? unescapeIcsText(props.uid.value).trim() : '',
    title: props.summary ? unescapeIcsText(props.summary.value).replace(/\s+/g, ' ').trim() : '',
    notes: props.location ? unescapeIcsText(props.location.value).trim() : '',
    start: dtstart.date,
    end,
    allDay: dtstart.allDay,
    tzApprox: dtstart.tzApprox,
    rrule,
    rruleUnsupported,
    exdateKeys,
  };
}

// Parses unfolded ICS text into raw event descriptors. Properties inside
// nested components (VALARM etc.) are ignored; VEVENTs without a parseable
// DTSTART or carrying RECURRENCE-ID are dropped and tallied in skippedCount.
function parseIcs(text) {
  const events = [];
  const source = String(text || '');
  const inputTruncated = source.length > MAX_ICS_INPUT_CHARS;
  const unfolded = unfoldIcsLinesBounded(
    source.slice(0, MAX_ICS_INPUT_CHARS),
    MAX_ICS_UNFOLDED_LINES
  );
  let skippedCount = inputTruncated || unfolded.truncated ? 1 : 0;
  const componentStack = [];
  let props = null;
  let eventCount = 0;
  let droppingEvent = false;
  for (const line of unfolded.lines) {
    const split = splitIcsProperty(line);
    if (!split) {
      continue;
    }
    const { name, params } = parseIcsPropertyHead(split.head);
    if (name === 'BEGIN') {
      componentStack.push(split.value.trim().toUpperCase());
      if (componentStack[componentStack.length - 1] === 'VEVENT') {
        eventCount += 1;
        droppingEvent = eventCount > MAX_ICS_EVENTS;
        props = droppingEvent ? null : { exdates: [] };
      }
      continue;
    }
    if (name === 'END') {
      const component = componentStack.pop();
      if (component === 'VEVENT') {
        if (droppingEvent) {
          skippedCount += 1;
        } else if (props) {
          if (props.recurrenceId) {
            skippedCount += 1;
          } else {
            const event = finalizeIcsEvent(props);
            if (event) {
              events.push(event);
            } else {
              skippedCount += 1;
            }
          }
        }
        props = null;
        droppingEvent = false;
      }
      continue;
    }
    if (!props || componentStack[componentStack.length - 1] !== 'VEVENT') {
      continue;
    }
    const entry = { value: split.value, params };
    if (name === 'DTSTART') {
      props.dtstart = entry;
    } else if (name === 'DTEND') {
      props.dtend = entry;
    } else if (name === 'DURATION') {
      props.duration = entry;
    } else if (name === 'SUMMARY') {
      props.summary = entry;
    } else if (name === 'LOCATION') {
      props.location = entry;
    } else if (name === 'UID') {
      props.uid = entry;
    } else if (name === 'RRULE') {
      props.rrule = entry;
    } else if (name === 'EXDATE') {
      props.exdates.push(entry);
    } else if (name === 'RECURRENCE-ID') {
      props.recurrenceId = entry;
    }
  }
  return { events, skippedCount };
}

function buildIcsInstance(event, occStart, occEnd, flags = {}) {
  return {
    uid: event.uid,
    title: event.title,
    notes: event.notes,
    start: formatLocalDateTime(occStart),
    end: formatLocalDateTime(occEnd),
    allDay: event.allDay,
    recurring: Boolean(event.rrule),
    recurrenceUnsupported: flags.recurrenceUnsupported === true,
    tzApprox: event.tzApprox,
  };
}

function* iterateRruleStarts(event, rule, windowStart) {
  const start = event.start;
  if (rule.freq === 'MONTHLY') {
    let k = 0;
    if (rule.count === null) {
      const monthDiff = (windowStart.getFullYear() - start.getFullYear()) * 12
        + (windowStart.getMonth() - start.getMonth());
      k = Math.max(0, Math.floor(monthDiff / rule.interval) - 1);
    }
    for (let i = 0; i < MAX_RRULE_ITERATIONS; i += 1, k += 1) {
      const occ = new Date(
        start.getFullYear(),
        start.getMonth() + k * rule.interval,
        start.getDate(),
        start.getHours(),
        start.getMinutes()
      );
      if (occ.getDate() !== start.getDate()) {
        continue; // month without that day: skipped, not rolled
      }
      yield occ;
    }
    return;
  }
  if (rule.freq === 'WEEKLY' && rule.byDay && rule.byDay.length) {
    // Anchor on the Monday of DTSTART's week (RFC default WKST=MO), then emit
    // the listed weekdays per week step, excluding anything before DTSTART.
    const offsets = rule.byDay
      .map((code) => WEEKDAY_OFFSET_FROM_MONDAY[code])
      .sort((a, b) => a - b);
    const mondayShift = (start.getDay() + 6) % 7;
    const weekAnchor = addLocalDays(start, -mondayShift);
    let week = 0;
    if (rule.count === null) {
      const daysBehind = Math.floor((windowStart.getTime() - weekAnchor.getTime()) / 86400000);
      week = Math.max(0, Math.floor(daysBehind / (7 * rule.interval)) - 1);
    }
    for (let i = 0; i < MAX_RRULE_ITERATIONS; i += 1, week += 1) {
      for (const offset of offsets) {
        const occ = addLocalDays(weekAnchor, week * 7 * rule.interval + offset);
        if (occ.getTime() < start.getTime()) {
          continue;
        }
        yield occ;
      }
    }
    return;
  }
  const stepDays = rule.freq === 'WEEKLY' ? 7 * rule.interval : rule.interval;
  let k = 0;
  if (rule.count === null) {
    const daysBehind = Math.floor((windowStart.getTime() - start.getTime()) / 86400000);
    k = Math.max(0, Math.floor(daysBehind / stepDays) - 1);
  }
  for (let i = 0; i < MAX_RRULE_ITERATIONS; i += 1, k += 1) {
    yield addLocalDays(start, k * stepDays);
  }
}

function expandIcsEvent(event, { windowStart, windowEnd, maxInstances = MAX_INSTANCES_PER_EVENT }) {
  // Wall-clock duration (not a ms delta) so recurring occurrences keep their
  // local end across DST transition days — matches the local-event expander.
  const durationMinutes = wallClockDurationMinutes(event.start, event.end);
  const instances = [];
  const pushIfVisible = (occStart, flags) => {
    const occEnd = addWallClockMinutes(occStart, durationMinutes);
    if (occEnd.getTime() > windowStart.getTime() && occStart.getTime() < windowEnd.getTime()) {
      instances.push(buildIcsInstance(event, occStart, occEnd, flags));
    }
  };
  if (!event.rrule) {
    pushIfVisible(event.start);
    return instances;
  }
  if (event.rruleUnsupported) {
    pushIfVisible(event.start, { recurrenceUnsupported: true });
    return instances;
  }
  const rule = event.rrule;
  let generated = 0;
  for (const occStart of iterateRruleStarts(event, rule, windowStart)) {
    if (occStart.getTime() >= windowEnd.getTime() && rule.count === null) {
      break;
    }
    generated += 1;
    if (rule.count !== null && generated > rule.count) {
      break;
    }
    if (rule.until && occStart.getTime() > rule.until.getTime()) {
      break;
    }
    // EXDATE removes from the set AFTER COUNT/UNTIL bookkeeping.
    if (!event.exdateKeys.has(formatLocalDateTime(occStart))) {
      pushIfVisible(occStart);
    }
    if (instances.length >= maxInstances || (rule.count !== null && occStart.getTime() >= windowEnd.getTime())) {
      break;
    }
  }
  return instances;
}

// The one-call entry the calendar service uses per feed body.
function extractIcsInstances(icsText, { windowStart, windowEnd }) {
  const { events, skippedCount } = parseIcs(icsText);
  const instances = [];
  let unsupportedRruleCount = 0;
  for (const event of events) {
    if (event.rruleUnsupported) {
      unsupportedRruleCount += 1;
    }
    instances.push(...expandIcsEvent(event, { windowStart, windowEnd }));
  }
  return { instances, skippedCount, unsupportedRruleCount };
}

module.exports = {
  expandIcsEvent,
  extractIcsInstances,
  parseIcs,
  parseIcsDateValue,
  parseIcsDuration,
  parseIcsRrule,
  unfoldIcsLines,
};
