'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_METADATA_INSTANCES,
  computeOverlaps,
  indexRecentJournal,
  shapeCalendarMetadata,
  shapeReceipt,
} = require('../services/tools/builtin/home-calendar-result-shape');

function instance(overrides = {}) {
  return {
    instanceId: 'evt_default:2026-09-07T09:00',
    eventId: 'evt_default',
    title: 'Default event',
    start: '2026-09-07T09:00',
    end: '2026-09-07T09:30',
    allDay: false,
    categoryId: 'work',
    source: 'local',
    sourceKind: 'user',
    readonly: false,
    recurrenceUnsupported: false,
    tzApprox: false,
    ...overrides,
  };
}

describe('computeOverlaps', () => {
  test('records timed overlaps on the deterministic later row only', () => {
    const overlaps = computeOverlaps([
      instance({
        instanceId: 'evt_later:2026-09-07T09:15',
        eventId: 'evt_later',
        title: 'Later',
        start: '2026-09-07T09:15',
        end: '2026-09-07T10:00',
      }),
      instance({
        instanceId: 'evt_earlier:2026-09-07T09:00',
        eventId: 'evt_earlier',
        title: 'Earlier',
        start: '2026-09-07T09:00',
        end: '2026-09-07T09:30',
      }),
      instance({
        instanceId: 'evt_all_day:2026-09-07T00:00',
        eventId: 'evt_all_day',
        title: 'All day',
        start: '2026-09-07T00:00',
        end: '2026-09-08T00:00',
        allDay: true,
      }),
      instance({
        instanceId: 'evt_next_day:2026-09-08T09:10',
        eventId: 'evt_next_day',
        title: 'Next day',
        start: '2026-09-08T09:10',
        end: '2026-09-08T09:20',
      }),
    ]);

    assert.deepEqual(overlaps.get('evt_later:2026-09-07T09:15'), [{
      instance_id: 'evt_earlier:2026-09-07T09:00',
      title: 'Earlier',
      start: '2026-09-07T09:00',
    }]);
    assert.equal(overlaps.has('evt_earlier:2026-09-07T09:00'), false);
    assert.equal(overlaps.has('evt_all_day:2026-09-07T00:00'), false);
    assert.equal(overlaps.has('evt_next_day:2026-09-08T09:10'), false);
  });

  test('records an overlap that crosses local midnight', () => {
    const overlaps = computeOverlaps([
      instance({
        instanceId: 'overnight-earlier',
        title: 'Overnight work',
        start: '2026-09-07T23:30',
        end: '2026-09-08T01:00',
      }),
      instance({
        instanceId: 'overnight-later',
        title: 'Midnight review',
        start: '2026-09-08T00:30',
        end: '2026-09-08T01:30',
      }),
    ]);

    assert.deepEqual(overlaps.get('overnight-later'), [{
      instance_id: 'overnight-earlier',
      title: 'Overnight work',
      start: '2026-09-07T23:30',
    }]);
  });

  test('breaks equal-start ties by instance id and caps each row at eight overlaps', () => {
    const tied = [
      instance({ instanceId: 'tie-b', eventId: 'tie-b', title: 'Tie B' }),
      instance({ instanceId: 'tie-a', eventId: 'tie-a', title: 'Tie A' }),
    ];
    const crowded = Array.from({ length: 10 }, (_, index) => instance({
      instanceId: `early-${index}`,
      eventId: `early-${index}`,
      title: `Early ${index}`,
      start: `2026-09-07T08:${String(index).padStart(2, '0')}`,
      end: '2026-09-07T10:00',
    }));
    crowded.push(instance({
      instanceId: 'late',
      eventId: 'late',
      title: 'Late',
      start: '2026-09-07T09:30',
      end: '2026-09-07T10:30',
    }));

    const tiedOverlaps = computeOverlaps(tied);
    const crowdedOverlaps = computeOverlaps(crowded);

    assert.deepEqual(tiedOverlaps.get('tie-b'), [{
      instance_id: 'tie-a',
      title: 'Tie A',
      start: '2026-09-07T09:00',
    }]);
    assert.equal(tiedOverlaps.has('tie-a'), false);
    assert.equal(crowdedOverlaps.get('late').length, 8);
    assert.deepEqual(
      crowdedOverlaps.get('late').map((entry) => entry.instance_id),
      Array.from({ length: 8 }, (_, index) => `early-${index}`)
    );
  });
});

describe('indexRecentJournal', () => {
  test('keeps the latest live create/update mark for the same non-empty session', () => {
    const entries = [
      { id: 'j1', entity: 'calendar_event', entityId: 'evt_1', op: 'create', sessionId: 'sess_1' },
      { id: 'j2', entity: 'calendar_event', entityId: 'evt_1', op: 'update', sessionId: 'sess_1' },
      { id: 'j3', entity: 'calendar_event', entityId: 'evt_2', op: 'create', sessionId: 'sess_2' },
      {
        id: 'j4',
        entity: 'calendar_event',
        entityId: 'evt_3',
        op: 'create',
        sessionId: 'sess_1',
        undoneAt: '2026-09-07T11:00:00.000Z',
      },
      {
        id: 'j5',
        entity: 'calendar_event',
        entityId: 'evt_4',
        op: 'update',
        sessionId: 'sess_1',
        supersededAt: '2026-09-07T11:00:00.000Z',
      },
      { id: 'j6', entity: 'reminder', entityId: 'evt_5', op: 'create', sessionId: 'sess_1' },
      { id: 'j7', entity: 'calendar_event', entityId: 'evt_6', op: 'delete', sessionId: 'sess_1' },
    ];

    assert.deepEqual([...indexRecentJournal(entries, 'sess_1')], [[
      'evt_1',
      { recent: 'updated', journal_entry_id: 'j2' },
    ]]);
    assert.deepEqual([...indexRecentJournal(entries, '')], []);
  });
});

describe('shapeCalendarMetadata', () => {
  test('caps in listing order while counting all rows and using full-list overlaps', () => {
    const listingInstances = Array.from({ length: MAX_METADATA_INSTANCES - 1 }, (_, index) => instance({
      instanceId: `filler-${index}`,
      eventId: `filler-${index}`,
      title: `Filler ${index}`,
      start: `2026-09-08T${String(10 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
      end: `2026-09-08T${String(10 + Math.floor(index / 60)).padStart(2, '0')}:${String((index % 60) + 1).padStart(2, '0')}`,
      ...(index === 0 ? { categoryId: 'family', source: 'feed', sourceKind: 'assistant' } : {}),
    }));
    listingInstances.push(instance({
      instanceId: 'shown-later',
      eventId: 'shown-later-event',
      title: 'T'.repeat(140),
      start: '2026-09-07T09:15',
      end: '2026-09-07T10:00',
      categoryId: '',
      source: 'unexpected',
      sourceKind: 'unexpected',
      readonly: 1,
      tzApprox: true,
      recurrenceUnsupported: true,
    }));
    listingInstances.push(instance({
      instanceId: 'omitted-earlier',
      eventId: 'omitted-earlier-event',
      title: 'Omitted earlier',
      start: '2026-09-07T09:00',
      end: '2026-09-07T09:30',
    }));

    const metadata = shapeCalendarMetadata({
      listing: {
        rangeStart: '2026-09-07T00:00',
        rangeEnd: '2026-09-09T00:00',
        instances: listingInstances,
      },
      journalEntries: [
        {
          id: 'journal-shown',
          entity: 'calendar_event',
          entityId: 'shown-later-event',
          op: 'create',
          sessionId: 'sess_1',
        },
      ],
      sessionId: 'sess_1',
      now: new Date(2026, 8, 7, 9, 5),
    });

    assert.equal(metadata.instance_count, MAX_METADATA_INSTANCES + 1);
    assert.equal(metadata.omitted_count, 1);
    assert.equal(metadata.instances.length, MAX_METADATA_INSTANCES);
    assert.equal(metadata.generated_at, '2026-09-07T09:05');
    assert.equal(metadata.range_start, '2026-09-07T00:00');
    assert.equal(metadata.range_end, '2026-09-09T00:00');
    assert.deepEqual(
      metadata.instances.slice(0, 2).map((row) => [row.category, row.source, row.source_kind]),
      [['family', 'feed', 'assistant'], ['work', 'local', 'user']]
    );
    const shown = metadata.instances.at(-1);
    assert.equal(shown.title, 'T'.repeat(120));
    assert.equal(shown.category, 'default');
    assert.equal(shown.source, 'local');
    assert.equal(shown.source_kind, '');
    assert.equal(shown.readonly, false);
    assert.equal(shown.tz_approx, true);
    assert.equal(shown.recurrence_unsupported, true);
    assert.equal(shown.kind, 'event');
    assert.equal(shown.recent, 'created');
    assert.equal(shown.journal_entry_id, 'journal-shown');
    assert.deepEqual(shown.overlaps, [{
      instance_id: 'omitted-earlier',
      title: 'Omitted earlier',
      start: '2026-09-07T09:00',
    }]);
  });

  test('uses a supplied overlap index', () => {
    const metadata = shapeCalendarMetadata({
      listing: {
        rangeStart: '2026-09-07T00:00',
        rangeEnd: '2026-09-08T00:00',
        instances: [instance({ instanceId: 'shown' })],
      },
      journalEntries: [],
      sessionId: 'sess_1',
      now: new Date(2026, 8, 7, 9, 5),
      overlaps: new Map([['shown', [{
        instance_id: 'omitted',
        title: 'Omitted',
        start: '2026-09-07T08:30',
      }]]]),
    });

    assert.deepEqual(metadata.instances[0].overlaps, [{
      instance_id: 'omitted',
      title: 'Omitted',
      start: '2026-09-07T08:30',
    }]);
  });
});

describe('shapeReceipt', () => {
  test('shapes event and reminder fields without inventing missing event keys', () => {
    const eventReceipt = shapeReceipt({
      kind: 'event',
      op: 'create',
      entityState: {
        id: 'evt_1',
        title: 'E'.repeat(140),
        start: '2026-09-07T09:00',
        end: '2026-09-07T10:00',
        allDay: false,
        categoryId: 'work',
      },
      journalEntryId: 'j1',
      journaled: true,
    });
    const sparseDelete = shapeReceipt({
      kind: 'event',
      op: 'delete',
      existing: { id: 'evt_2', title: 'Sparse' },
      journalEntryId: '',
      journaled: false,
    });
    const reminderReceipt = shapeReceipt({
      kind: 'reminder',
      op: 'update',
      entityState: {
        id: 'rem_1',
        label: 'Stretch',
        scheduleType: 'daily_at',
        dailyAt: '09:30',
      },
      journalEntryId: 'j2',
      journaled: true,
    });
    const intervalReceipt = shapeReceipt({
      kind: 'reminder',
      op: 'delete',
      existing: {
        id: 'rem_interval',
        label: 'Hydrate',
        scheduleType: 'interval_minutes',
        intervalMinutes: 45,
      },
      journalEntryId: 'j3',
      journaled: true,
    });

    assert.deepEqual(eventReceipt, {
      schema_version: 1,
      kind: 'event',
      op: 'create',
      id: 'evt_1',
      title: 'E'.repeat(120),
      start: '2026-09-07T09:00',
      end: '2026-09-07T10:00',
      all_day: false,
      category: 'work',
      journal_entry_id: 'j1',
      journaled: true,
    });
    assert.deepEqual(sparseDelete, {
      schema_version: 1,
      kind: 'event',
      op: 'delete',
      id: 'evt_2',
      title: 'Sparse',
      journal_entry_id: '',
      journaled: false,
    });
    assert.deepEqual(reminderReceipt, {
      schema_version: 1,
      kind: 'reminder',
      op: 'update',
      id: 'rem_1',
      title: 'Stretch',
      schedule_type: 'daily_at',
      when: '09:30',
      journal_entry_id: 'j2',
      journaled: true,
    });
    assert.deepEqual(intervalReceipt, {
      schema_version: 1,
      kind: 'reminder',
      op: 'delete',
      id: 'rem_interval',
      title: 'Hydrate',
      schedule_type: 'interval_minutes',
      when: '45',
      journal_entry_id: 'j3',
      journaled: true,
    });
  });
});
