'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeHomeResultMetadata,
} = require('../services/backend/home-calendar-result-metadata');
const {
  normalizePersistedToolResultMetadata,
  normalizeToolResultMetadataForStorage,
} = require('../services/backend/tool-result-diff-metadata');

function makeInstance(index, overrides = {}) {
  return {
    instance_id: `instance-${index}`,
    event_id: `event-${index}`,
    title: `Calendar item ${index}`,
    start: '2026-09-07T09:00',
    end: '2026-09-07T10:00',
    all_day: false,
    category: 'work',
    source: 'local',
    source_kind: 'assistant',
    readonly: false,
    tz_approx: false,
    recurrence_unsupported: false,
    kind: 'event',
    ...overrides,
  };
}

function makeEventReceipt(overrides = {}) {
  return {
    schema_version: 1,
    kind: 'event',
    op: 'create',
    id: 'event-1',
    title: 'Planning block',
    start: '2026-09-07T09:00',
    end: '2026-09-07T10:00',
    all_day: false,
    category: 'focus',
    journal_entry_id: 'journal-1',
    journaled: true,
    ...overrides,
  };
}

test('non-home input normalizes to null', () => {
  assert.equal(normalizeHomeResultMetadata(null), null);
  assert.equal(normalizeHomeResultMetadata([]), null);
  assert.equal(normalizeHomeResultMetadata(Symbol('home')), null);
  assert.equal(normalizeHomeResultMetadata({ result_kind: 'other' }), null);
});

test('full valid calendar round-trips in canonical key order', () => {
  const result = normalizeHomeResultMetadata({
    result_kind: 'home',
    action: `  ${'a'.repeat(70)}  `,
    status: '  complete  ',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07T00:00',
      range_end: '2026-09-14T00:00',
      generated_at: '2026-09-07T08:30',
      instance_count: 1.9,
      omitted_count: -4,
      instances: [makeInstance(1, {
        recent: 'created',
        journal_entry_id: 'journal-1',
        overlaps: [{
          instance_id: 'instance-2',
          title: 'Standup',
          start: '2026-09-07T09:30',
        }],
      })],
    },
  });

  assert.deepEqual(Object.keys(result), ['result_kind', 'action', 'status', 'calendar']);
  assert.equal(result.action, 'a'.repeat(64));
  assert.equal(result.status, 'complete');
  assert.deepEqual(Object.keys(result.calendar), [
    'schema_version', 'range_start', 'range_end', 'generated_at',
    'instance_count', 'omitted_count', 'instances',
  ]);
  assert.equal(result.calendar.instance_count, 1);
  assert.equal(result.calendar.omitted_count, 0);
  assert.deepEqual(Object.keys(result.calendar.instances[0]), [
    'instance_id', 'event_id', 'title', 'start', 'end', 'all_day', 'category',
    'source', 'source_kind', 'readonly', 'tz_approx', 'recurrence_unsupported',
    'kind', 'recent', 'journal_entry_id', 'overlaps',
  ]);
  assert.deepEqual(result.calendar.instances[0].overlaps, [{
    instance_id: 'instance-2',
    title: 'Standup',
    start: '2026-09-07T09:30',
  }]);
});

test('calendar instances are capped at 40 and invalid datetimes are skipped', () => {
  const instances = Array.from({ length: 45 }, (_, index) => makeInstance(index));
  const result = normalizeHomeResultMetadata({
    result_kind: 'home',
    action: 'calendar_list',
    status: 'ok',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07T00:00',
      range_end: '2026-09-14T00:00',
      generated_at: 'bad',
      instance_count: '45',
      omitted_count: 'nope',
      instances,
    },
  });

  assert.equal(result.calendar.instances.length, 40);
  assert.equal(result.calendar.instances[39].instance_id, 'instance-39');
  assert.equal(result.calendar.generated_at, '');
  assert.equal(result.calendar.instance_count, 45);
  assert.equal(result.calendar.omitted_count, 0);

  instances[0] = makeInstance(0, { start: '2026-09-07' });
  instances[1] = makeInstance(1, { end: 'not-a-datetime' });
  const withInvalidInstances = normalizeHomeResultMetadata({
    result_kind: 'home',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07T00:00',
      range_end: '2026-09-14T00:00',
      instances,
    },
  });
  assert.equal(withInvalidInstances.calendar.instances.length, 38);
  assert.equal(withInvalidInstances.calendar.instances[0].instance_id, 'instance-2');
});

test('calendar identifiers survive intact up to 512 characters and reject longer values', () => {
  const feedInstanceId = `feed:feed-1:${'u'.repeat(171)}:2026-09-07T09:00`;
  const result = normalizeHomeResultMetadata({
    result_kind: 'home',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07T00:00',
      range_end: '2026-09-08T00:00',
      instances: [
        makeInstance(1, { instance_id: feedInstanceId }),
        makeInstance(2, { instance_id: 'x'.repeat(600) }),
        makeInstance(3, { event_id: 'x'.repeat(600) }),
        makeInstance(4, { recent: 'created', journal_entry_id: 'x'.repeat(600) }),
      ],
    },
  });

  assert.equal(result.calendar.instances.length, 2);
  assert.equal(result.calendar.instances[0].instance_id, feedInstanceId);
  assert.equal(result.calendar.instances[0].instance_id.length, 200);
  assert.equal(result.calendar.instances[1].journal_entry_id, '');
});

test('calendar datetimes reject impossible dates and suffixed timestamps', () => {
  for (const start of [
    '2026-99-99T99:99',
    '2026-02-30T10:00',
    '2026-09-07T10:00+02:00',
  ]) {
    const result = normalizeHomeResultMetadata({
      result_kind: 'home',
      calendar: {
        schema_version: 1,
        range_start: start,
        range_end: '2026-09-08T00:00',
        instances: [],
      },
    });
    assert.equal(Object.hasOwn(result, 'calendar'), false);
  }
});

test('instance enums coerce safely and recent controls journal metadata', () => {
  const result = normalizeHomeResultMetadata({
    result_kind: 'home',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07T00:00',
      range_end: '2026-09-08T00:00',
      instances: [
        makeInstance(1, {
          category: 'chartreuse',
          source: 'remote',
          source_kind: 'system',
          kind: 'task',
          recent: 'deleted',
          journal_entry_id: 'must-drop',
          all_day: 1,
          readonly: 'true',
          tz_approx: true,
          recurrence_unsupported: true,
        }),
        makeInstance(2, { recent: 'updated', journal_entry_id: 42 }),
      ],
    },
  });

  assert.deepEqual(result.calendar.instances[0], {
    instance_id: 'instance-1',
    event_id: 'event-1',
    title: 'Calendar item 1',
    start: '2026-09-07T09:00',
    end: '2026-09-07T10:00',
    all_day: false,
    category: 'default',
    source: 'local',
    source_kind: '',
    readonly: false,
    tz_approx: true,
    recurrence_unsupported: true,
    kind: 'event',
  });
  assert.equal(result.calendar.instances[1].recent, 'updated');
  assert.equal(result.calendar.instances[1].journal_entry_id, '42');
});

test('overlaps are capped at 8 and entries with invalid starts are skipped', () => {
  const overlaps = Array.from({ length: 10 }, (_, index) => ({
    instance_id: `overlap-${index}`,
    title: `Overlap ${index}`,
    start: '2026-09-07T09:30',
  }));
  const result = normalizeHomeResultMetadata({
    result_kind: 'home',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07T00:00',
      range_end: '2026-09-08T00:00',
      instances: [
        makeInstance(1, { overlaps }),
        makeInstance(2, { overlaps: [
          { instance_id: 'bad', title: 'Bad', start: 'tomorrow' },
          { instance_id: 'good', title: 'Good', start: '2026-09-07T09:30' },
        ] }),
      ],
    },
  });

  assert.equal(result.calendar.instances[0].overlaps.length, 8);
  assert.deepEqual(result.calendar.instances[1].overlaps, [{
    instance_id: 'good',
    title: 'Good',
    start: '2026-09-07T09:30',
  }]);

  const invalidIdResult = normalizeHomeResultMetadata({
    result_kind: 'home',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07T00:00',
      range_end: '2026-09-08T00:00',
      instances: [makeInstance(3, { overlaps: [{
        instance_id: 'x'.repeat(600),
        title: 'Too long',
        start: '2026-09-07T09:30',
      }] })],
    },
  });
  assert.equal(Object.hasOwn(invalidIdResult.calendar.instances[0], 'overlaps'), false);
});

test('bad calendar range drops calendar while preserving a valid receipt', () => {
  const result = normalizeHomeResultMetadata({
    result_kind: 'home',
    action: 'calendar_create',
    status: 'ok',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07',
      range_end: '2026-09-08T00:00',
      instances: [],
    },
    calendar_receipt: makeEventReceipt(),
  });

  assert.equal(Object.hasOwn(result, 'calendar'), false);
  assert.deepEqual(Object.keys(result.calendar_receipt), [
    'schema_version', 'kind', 'op', 'id', 'title', 'start', 'end', 'all_day',
    'category', 'journal_entry_id', 'journaled',
  ]);
});

test('event create, reminder once_at, and event delete receipts normalize', () => {
  const eventCreate = normalizeHomeResultMetadata({
    result_kind: 'home',
    calendar_receipt: makeEventReceipt({ category: 'invalid' }),
  }).calendar_receipt;
  assert.equal(eventCreate.category, 'default');
  assert.equal(eventCreate.all_day, false);

  const reminder = normalizeHomeResultMetadata({
    result_kind: 'home',
    calendar_receipt: {
      schema_version: 1,
      kind: 'reminder',
      op: 'create',
      id: 'reminder-1',
      title: 'Call home',
      schedule_type: 'once_at',
      when: `  ${'x'.repeat(40)}  `,
      journal_entry_id: '',
      journaled: false,
    },
  }).calendar_receipt;
  assert.deepEqual(Object.keys(reminder), [
    'schema_version', 'kind', 'op', 'id', 'title', 'schedule_type', 'when',
    'journal_entry_id', 'journaled',
  ]);
  assert.equal(reminder.when, 'x'.repeat(32));

  const intervalReminder = normalizeHomeResultMetadata({
    result_kind: 'home',
    calendar_receipt: {
      schema_version: 1,
      kind: 'reminder',
      op: 'update',
      id: 'reminder-interval',
      title: 'Check progress',
      schedule_type: 'interval_minutes',
      when: '30',
      journal_entry_id: 'journal-interval',
      journaled: true,
    },
  }).calendar_receipt;
  assert.equal(intervalReminder.schedule_type, 'interval_minutes');
  assert.equal(intervalReminder.when, '30');

  const eventDelete = normalizeHomeResultMetadata({
    result_kind: 'home',
    calendar_receipt: makeEventReceipt({
      op: 'delete',
      start: 'bad',
      end: 'bad',
      journaled: 1,
    }),
  }).calendar_receipt;
  assert.equal(eventDelete.op, 'delete');
  assert.equal(Object.hasOwn(eventDelete, 'start'), false);
  assert.equal(Object.hasOwn(eventDelete, 'end'), false);
  assert.equal(eventDelete.journaled, false);
});

test('receipt is dropped when its operation is invalid', () => {
  const result = normalizeHomeResultMetadata({
    result_kind: 'home',
    action: 'calendar_write',
    status: 'rejected',
    calendar_receipt: makeEventReceipt({ op: 'upsert' }),
  });
  assert.deepEqual(result, {
    result_kind: 'home',
    action: 'calendar_write',
    status: 'rejected',
  });
});

test('receipt rejects overlong ids and clears overlong journal ids', () => {
  const rejected = normalizeHomeResultMetadata({
    result_kind: 'home',
    calendar_receipt: makeEventReceipt({ id: 'x'.repeat(600) }),
  });
  assert.equal(Object.hasOwn(rejected, 'calendar_receipt'), false);

  const accepted = normalizeHomeResultMetadata({
    result_kind: 'home',
    calendar_receipt: makeEventReceipt({ journal_entry_id: 'x'.repeat(600) }),
  });
  assert.equal(accepted.calendar_receipt.journal_entry_id, '');
});

test('persisted and session-storage metadata use the normalized home fields', () => {
  const metadata = {
    trace: 'keep-in-session-message',
    result_kind: 'home',
    action: 'calendar_list',
    status: 'ok',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07T00:00',
      range_end: '2026-09-08T00:00',
      generated_at: 'bad',
      instance_count: -1,
      omitted_count: 0,
      instances: [makeInstance(1, { category: 'not-valid' })],
      untrusted: 'drop',
    },
  };

  const persisted = normalizePersistedToolResultMetadata(metadata);
  assert.deepEqual(Object.keys(persisted), ['result_kind', 'action', 'status', 'calendar']);
  assert.equal(persisted.calendar.instances[0].category, 'default');
  assert.equal(Object.hasOwn(persisted.calendar, 'untrusted'), false);

  const stored = normalizeToolResultMetadataForStorage(metadata, {}, persisted);
  assert.equal(stored.trace, 'keep-in-session-message');
  assert.deepEqual(stored.calendar, persisted.calendar);
  assert.notEqual(stored.calendar, metadata.calendar);
});

test('session storage removes rejected calendar metadata before restoring valid structured fields', () => {
  const metadata = {
    result_kind: 'home',
    action: 'event_upsert',
    status: 'ok',
    calendar: {
      schema_version: 2,
      instances: [{ title: 'T'.repeat(3000), overlaps: Array(12).fill({}) }],
    },
    calendar_receipt: makeEventReceipt(),
  };

  const stored = normalizeToolResultMetadataForStorage(metadata);
  assert.equal(Object.hasOwn(stored, 'calendar'), false);
  assert.deepEqual(stored.calendar_receipt, normalizeHomeResultMetadata(metadata).calendar_receipt);
});

test('home result without calendar sub-objects keeps its discriminator and status', () => {
  assert.deepEqual(normalizeHomeResultMetadata({
    result_kind: 'home',
    action: null,
    status: Symbol('status'),
    calendar: [],
    calendar_receipt: 'invalid',
  }), {
    result_kind: 'home',
    action: '',
    status: '',
  });
});
