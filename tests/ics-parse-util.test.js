const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractIcsInstances,
  parseIcs,
  parseIcsDateValue,
  parseIcsDuration,
  parseIcsRrule,
  unfoldIcsLines,
} = require('../services/ics-parse-util');

const WINDOW = {
  windowStart: new Date(2026, 5, 1), // 2026-06-01 local midnight
  windowEnd: new Date(2026, 6, 1), // 2026-07-01 local midnight
};

function wrapVevent(body) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    ...body,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

test('unfoldIcsLines joins space- and tab-continued lines', () => {
  // The single leading space/tab is the folding marker and is stripped; any
  // further whitespace is content.
  const lines = unfoldIcsLines('SUMMARY:part one\r\n  and two\r\nDESCRIPTION:x\n\t tab fold');
  assert.deepEqual(lines, ['SUMMARY:part one and two', 'DESCRIPTION:x tab fold']);
});

test('parseIcsDateValue handles date, floating, utc, and tzid forms', () => {
  const allDay = parseIcsDateValue('20260611', {});
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.date.getDate(), 11);

  const floating = parseIcsDateValue('20260611T093000', {});
  assert.equal(floating.allDay, false);
  assert.equal(floating.tzApprox, false);
  assert.equal(floating.date.getHours(), 9);

  const utc = parseIcsDateValue('20260611T120000Z', {});
  assert.equal(utc.tzApprox, false);
  assert.equal(utc.date.getTime(), Date.UTC(2026, 5, 11, 12, 0, 0));

  // A recognized IANA zone converts to the absolute instant (09:30 EDT =
  // 13:30 UTC on 2026-06-11) and is NOT flagged approximate; the instant check
  // is independent of the machine's local zone.
  const tzid = parseIcsDateValue('20260611T093000', { TZID: 'America/New_York' });
  assert.equal(tzid.tzApprox, false);
  assert.equal(tzid.date.getTime(), Date.UTC(2026, 5, 11, 13, 30, 0));

  // An unrecognized zone (custom Outlook id) falls back to wall-clock local + flag.
  const customZone = parseIcsDateValue('20260611T093000', { TZID: 'Customized Time Zone' });
  assert.equal(customZone.tzApprox, true);
  assert.equal(customZone.date.getHours(), 9);

  assert.equal(parseIcsDateValue('garbage', {}), null);
  assert.equal(parseIcsDateValue('20260231', {}), null);
});

test('parseIcsDateValue rejects overflowing calendar and time components', () => {
  assert.equal(parseIcsDateValue('20241301', {}), null);
  assert.equal(parseIcsDateValue('20240230T090000', {}), null);
  assert.equal(parseIcsDateValue('20241301T090000Z', {}), null);
  assert.equal(parseIcsDateValue('20260611T240000', {}), null);
  assert.equal(parseIcsDateValue('20260611T096000', { TZID: 'Customized Time Zone' }), null);
  assert.equal(parseIcsDateValue('20260611T095960', { TZID: 'America/New_York' }), null);
});

test('parseIcsDuration covers weeks/days/time and rejects junk', () => {
  assert.equal(parseIcsDuration('P1D'), 86400000);
  assert.equal(parseIcsDuration('PT1H30M'), 5400000);
  assert.equal(parseIcsDuration('P1W'), 604800000);
  assert.equal(parseIcsDuration('-PT15M'), -900000);
  assert.equal(parseIcsDuration('P'), null);
  assert.equal(parseIcsDuration('soon'), null);
});

test('parseIcsDuration rejects an empty time section but accepts explicit zero', () => {
  assert.equal(parseIcsDuration('PT'), null);
  assert.equal(parseIcsDuration('PT0S'), 0);
});

test('parseIcsRrule accepts the supported subset and flags the rest', () => {
  assert.equal(parseIcsRrule('FREQ=WEEKLY;BYDAY=MO,WE,FR').unsupported, false);
  assert.equal(parseIcsRrule('FREQ=DAILY;INTERVAL=2;COUNT=10').unsupported, false);
  assert.equal(parseIcsRrule('FREQ=MONTHLY;UNTIL=20261231').unsupported, false);
  assert.equal(parseIcsRrule('FREQ=WEEKLY;WKST=SU').unsupported, false);

  assert.equal(parseIcsRrule('FREQ=YEARLY').unsupported, true);
  assert.equal(parseIcsRrule('FREQ=MONTHLY;BYDAY=1MO').unsupported, true);
  assert.equal(parseIcsRrule('FREQ=MONTHLY;BYMONTHDAY=15').unsupported, true);
  assert.equal(parseIcsRrule('FREQ=WEEKLY;BYSETPOS=1;BYDAY=MO').unsupported, true);
  assert.equal(parseIcsRrule('').unsupported, true);
});

test('parseIcsRrule rejects partial INTERVAL and COUNT integer tokens', () => {
  assert.equal(parseIcsRrule('FREQ=DAILY;INTERVAL=2junk').unsupported, true);
  assert.equal(parseIcsRrule('FREQ=DAILY;COUNT=3oops').unsupported, true);
  assert.equal(parseIcsRrule('FREQ=DAILY;INTERVAL=2;COUNT=3').unsupported, false);
});

test('parseIcs reads a plain VEVENT with escaped text and quoted params', () => {
  const { events, skippedCount } = parseIcs(wrapVevent([
    'UID:abc-123',
    'SUMMARY:Lunch\\, then sync\\; notes',
    'LOCATION:Caf\\\\e',
    'DTSTART;TZID="America/New_York":20260610T120000',
    'DTEND;TZID="America/New_York":20260610T130000',
  ]));
  assert.equal(skippedCount, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].uid, 'abc-123');
  assert.equal(events[0].title, 'Lunch, then sync; notes');
  assert.equal(events[0].notes, 'Caf\\e');
  // America/New_York is a recognized zone, so it converts (not approximate).
  assert.equal(events[0].tzApprox, false);
  assert.equal(events[0].end.getHours() - events[0].start.getHours(), 1);
});

test('parseIcs ignores VALARM properties and skips events without DTSTART', () => {
  const { events, skippedCount } = parseIcs([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:with-alarm',
    'DTSTART:20260610T090000',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'SUMMARY:alarm summary must not leak',
    'END:VALARM',
    'SUMMARY:real summary',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:no-start',
    'SUMMARY:broken',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'real summary');
  assert.equal(skippedCount, 1);
});

test('parseIcs skips RECURRENCE-ID override events and tallies them', () => {
  const { events, skippedCount } = parseIcs(wrapVevent([
    'UID:series',
    'RECURRENCE-ID:20260610T090000',
    'DTSTART:20260611T090000',
    'SUMMARY:moved occurrence',
  ]));
  assert.equal(events.length, 0);
  assert.equal(skippedCount, 1);
});

test('DURATION substitutes for DTEND and all-day defaults to one day', () => {
  const { events } = parseIcs([
    'BEGIN:VEVENT',
    'UID:dur',
    'DTSTART:20260610T090000',
    'DURATION:PT2H',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:allday',
    'DTSTART;VALUE=DATE:20260610',
    'END:VEVENT',
  ].join('\n'));
  assert.equal(events[0].end.getHours(), 11);
  assert.equal(events[1].allDay, true);
  assert.equal(events[1].end.getDate(), 11);
});

test('extractIcsInstances expands weekly BYDAY rules inside the window', () => {
  const { instances, unsupportedRruleCount } = extractIcsInstances(wrapVevent([
    'UID:standup',
    'SUMMARY:Standup',
    'DTSTART:20260601T091500',
    'DTEND:20260601T093000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
  ]), WINDOW);
  assert.equal(unsupportedRruleCount, 0);
  // June 2026: Mondays 1,8,15,22,29 + Wednesdays 3,10,17,24 = 9
  assert.equal(instances.length, 9);
  assert.equal(instances[0].start, '2026-06-01T09:15');
  assert.equal(instances[1].start, '2026-06-03T09:15');
  assert.equal(instances.every((i) => i.recurring), true);
});

test('COUNT bounds the set from DTSTART and EXDATE removes without refunding', () => {
  const { instances } = extractIcsInstances(wrapVevent([
    'UID:counted',
    'SUMMARY:Counted',
    'DTSTART:20260601T080000',
    'DTEND:20260601T083000',
    'RRULE:FREQ=DAILY;COUNT=5',
    'EXDATE:20260603T080000',
  ]), WINDOW);
  // 5 generated (Jun 1-5), Jun 3 excluded -> 4 visible
  assert.deepEqual(
    instances.map((i) => i.start),
    ['2026-06-01T08:00', '2026-06-02T08:00', '2026-06-04T08:00', '2026-06-05T08:00']
  );
});

test('UNTIL is inclusive and date-only UNTIL covers its whole day', () => {
  const { instances } = extractIcsInstances(wrapVevent([
    'UID:until',
    'SUMMARY:Until',
    'DTSTART:20260601T100000',
    'DTEND:20260601T103000',
    'RRULE:FREQ=DAILY;UNTIL=20260604',
  ]), WINDOW);
  assert.equal(instances.length, 4); // Jun 1,2,3,4
  assert.equal(instances[3].start, '2026-06-04T10:00');
});

test('INTERVAL applies to daily and monthly skips short months', () => {
  const everyOther = extractIcsInstances(wrapVevent([
    'UID:eo',
    'SUMMARY:Every other day',
    'DTSTART:20260601T070000',
    'DTEND:20260601T073000',
    'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=4',
  ]), WINDOW).instances;
  assert.deepEqual(
    everyOther.map((i) => i.start),
    ['2026-06-01T07:00', '2026-06-03T07:00', '2026-06-05T07:00', '2026-06-07T07:00']
  );

  const monthly = extractIcsInstances(wrapVevent([
    'UID:m31',
    'SUMMARY:Day 31',
    'DTSTART:20260131T120000',
    'DTEND:20260131T130000',
    'RRULE:FREQ=MONTHLY',
  ]), {
    windowStart: new Date(2026, 0, 1),
    windowEnd: new Date(2026, 6, 1),
  }).instances;
  assert.deepEqual(
    monthly.map((i) => i.start),
    ['2026-01-31T12:00', '2026-03-31T12:00', '2026-05-31T12:00']
  );
});

test('unsupported RRULE degrades to first instance with markers', () => {
  const { instances, unsupportedRruleCount } = extractIcsInstances(wrapVevent([
    'UID:yearly',
    'SUMMARY:Anniversary',
    'DTSTART:20260615T000000',
    'DTEND:20260616T000000',
    'RRULE:FREQ=YEARLY',
  ]), WINDOW);
  assert.equal(unsupportedRruleCount, 1);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].recurrenceUnsupported, true);
  assert.equal(instances[0].recurring, true);
});

test('recurring events anchored years back fast-forward into the window', () => {
  const { instances } = extractIcsInstances(wrapVevent([
    'UID:old',
    'SUMMARY:Old weekly',
    'DTSTART:20200106T140000', // Monday years before the window
    'DTEND:20200106T150000',
    'RRULE:FREQ=WEEKLY',
  ]), WINDOW);
  assert.equal(instances.length > 0, true);
  assert.equal(instances[0].start, '2026-06-01T14:00');
  assert.equal(instances.every((i) => i.start.endsWith('T14:00')), true);
});

test('multi-event blobs expand independently and tally skips', () => {
  const blob = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:ok',
    'SUMMARY:Fine',
    'DTSTART:20260610T090000',
    'DTEND:20260610T100000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:broken',
    'DTSTART:not-a-date',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const { instances, skippedCount } = extractIcsInstances(blob, WINDOW);
  assert.equal(instances.length, 1);
  assert.equal(skippedCount, 1);
});

test('parseIcs caps input characters, unfolded lines, and VEVENT records', () => {
  const event = 'BEGIN:VEVENT\nDTSTART:20260601\nEND:VEVENT\n';
  const eventLimited = parseIcs(event.repeat(5_002));
  assert.equal(eventLimited.events.length, 5_000);
  assert.equal(eventLimited.skippedCount, 2);

  const lineLimited = parseIcs(`${Array.from(
    { length: 50_000 },
    (_, index) => `X-${index}:value`
  ).join('\n')}\n${event}`);
  assert.equal(lineLimited.events.length, 0);
  assert.equal(lineLimited.skippedCount, 1);

  const charLimited = parseIcs(`${'X'.repeat(2_000_000)}\n${event}`);
  assert.equal(charLimited.events.length, 0);
  assert.equal(charLimited.skippedCount, 1);
});

test('expansion caps runaway recurring events', () => {
  const { instances } = extractIcsInstances(wrapVevent([
    'UID:cap',
    'SUMMARY:Cap',
    'DTSTART:20260601T060000',
    'DTEND:20260601T063000',
    'RRULE:FREQ=DAILY',
  ]), {
    windowStart: new Date(2026, 5, 1),
    windowEnd: new Date(2030, 5, 1),
  });
  assert.equal(instances.length, 200);
});
