'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const homeTool = require('../services/tools/builtin/home-tool');

const CALENDAR_HINT = '(The user sees this list rendered as a calendar in chat. Summarize what matters'
  + ' — conflicts, gaps, what changed — rather than repeating every entry.)';

function calendarInstance(overrides = {}) {
  return {
    instanceId: 'evt_1:2026-09-07T09:00',
    eventId: 'evt_1',
    title: 'Planning',
    start: '2026-09-07T09:00',
    end: '2026-09-07T10:00',
    allDay: false,
    categoryId: 'work',
    source: 'local',
    sourceKind: 'assistant',
    readonly: false,
    recurrenceUnsupported: false,
    tzApprox: false,
    ...overrides,
  };
}

function service(overrides = {}) {
  return {
    listCalendar() {
      return {
        rangeStart: '2026-09-07T00:00',
        rangeEnd: '2026-09-08T00:00',
        instances: [],
      };
    },
    readEvent(id) {
      return id === 'evt_existing'
        ? {
          id,
          title: 'Existing event',
          start: '2026-09-07T12:00',
          end: '2026-09-07T12:30',
          allDay: false,
          categoryId: 'personal',
        }
        : null;
    },
    getProactive() {
      return {
        reminders: [{
          id: 'rem_existing',
          label: 'Existing reminder',
          scheduleType: 'daily_at',
          dailyAt: '08:30',
        }],
      };
    },
    upsertEvent(input) {
      return {
        ok: true,
        entityId: input.id || 'evt_created',
        entryId: 'journal-event',
        op: input.id ? 'update' : 'create',
        journaled: true,
        entityState: {
          id: input.id || 'evt_created',
          title: input.title || 'Existing event',
          start: input.start || '2026-09-07T12:00',
          end: input.end || '2026-09-07T12:30',
          allDay: input.allDay === true,
          categoryId: input.categoryId || 'personal',
        },
      };
    },
    deleteEvent(id) {
      return { ok: true, entityId: id, entryId: 'journal-event-delete', journaled: true };
    },
    upsertReminder(input) {
      return {
        ok: true,
        entityId: input.id || 'rem_created',
        entryId: 'journal-reminder',
        op: input.id ? 'update' : 'create',
        journaled: true,
        entityState: {
          id: input.id || 'rem_created',
          label: input.label || 'Existing reminder',
          ...input,
        },
      };
    },
    deleteReminder(id) {
      return { ok: true, entityId: id, entryId: 'journal-reminder-delete', journaled: true };
    },
    ...overrides,
  };
}

function context(homeAssistantService, extra = {}) {
  return { homeAssistantService, sessionId: 'sess_1', callId: 'call_1', ...extra };
}

describe('home calendar_list metadata', () => {
  test('attaches the typed agenda, same-session recent mark, overlap prose, and hint', async () => {
    const result = await homeTool.execute({ action: 'calendar_list' }, context(service({
      listCalendar() {
        return {
          rangeStart: '2026-09-07T00:00',
          rangeEnd: '2026-09-08T00:00',
          instances: [
            calendarInstance(),
            calendarInstance({
              instanceId: 'evt_2:2026-09-07T09:30',
              eventId: 'evt_2',
              title: 'Review',
              start: '2026-09-07T09:30',
              end: '2026-09-07T10:30',
            }),
          ],
        };
      },
      listJournal() {
        return {
          entries: [{
            id: 'journal-recent',
            entity: 'calendar_event',
            entityId: 'evt_2',
            op: 'update',
            sessionId: 'sess_1',
            undoneAt: '',
            supersededAt: '',
          }],
        };
      },
    })));

    assert.equal(result.metadata.result_kind, 'home');
    assert.equal(result.metadata.calendar.schema_version, 1);
    assert.equal(result.metadata.calendar.instance_count, 2);
    assert.deepEqual(result.metadata.calendar.instances[1].overlaps, [{
      instance_id: 'evt_1:2026-09-07T09:00',
      title: 'Planning',
      start: '2026-09-07T09:00',
    }]);
    assert.equal(result.metadata.calendar.instances[1].recent, 'updated');
    assert.equal(result.metadata.calendar.instances[1].journal_entry_id, 'journal-recent');
    assert.match(
      result.content,
      /Overlaps:\n- Review \(2026-09-07T09:30\) overlaps Planning \(2026-09-07T09:00\)/
    );
    assert.ok(result.content.endsWith(CALENDAR_HINT));
  });

  test('missing or throwing listJournal yields no recent marks and keeps the hint on empty ranges', async () => {
    const withoutJournal = await homeTool.execute(
      { action: 'calendar_list' },
      context(service({
        listCalendar() {
          return {
            rangeStart: '2026-09-07T00:00',
            rangeEnd: '2026-09-08T00:00',
            instances: [calendarInstance()],
          };
        },
      }))
    );
    const throwingJournal = await homeTool.execute(
      { action: 'calendar_list' },
      context(service({
        listJournal() {
          throw new Error('journal unavailable');
        },
      }))
    );

    assert.equal(Object.hasOwn(withoutJournal.metadata.calendar.instances[0], 'recent'), false);
    assert.equal(throwingJournal.content.includes('No events in that range.'), true);
    assert.equal(throwingJournal.content.endsWith(CALENDAR_HINT), true);
    assert.deepEqual(throwingJournal.metadata.calendar.instances, []);
  });

  test('caps overlap prose at twelve lines and reports the omitted pair count', async () => {
    const instances = Array.from({ length: 14 }, (_, index) => {
      const day = index < 7 ? '07' : '08';
      const hour = String(8 + (index % 7) * 2).padStart(2, '0');
      return [
        calendarInstance({
          instanceId: `earlier-${index}`,
          eventId: `earlier-${index}`,
          title: `Earlier ${index}`,
          start: `2026-09-${day}T${hour}:00`,
          end: `2026-09-${day}T${hour}:45`,
        }),
        calendarInstance({
          instanceId: `later-${index}`,
          eventId: `later-${index}`,
          title: `Later ${index}`,
          start: `2026-09-${day}T${hour}:30`,
          end: `2026-09-${day}T${hour}:50`,
        }),
      ];
    }).flat();
    const result = await homeTool.execute({ action: 'calendar_list' }, context(service({
      listCalendar() {
        return {
          rangeStart: '2026-09-07T00:00',
          rangeEnd: '2026-09-09T00:00',
          instances,
        };
      },
    })));
    const overlapBlock = result.content.split('\nOverlaps:\n')[1].split(`\n${CALENDAR_HINT}`)[0];

    assert.equal(overlapBlock.split('\n').filter((line) => line.startsWith('- ')).length, 12);
    assert.match(overlapBlock, /\(2 more overlaps not shown\)$/);
  });
});

describe('home calendar write receipts', () => {
  test('attaches event create and update receipts', async () => {
    const facade = service();
    const created = await homeTool.execute({
      action: 'event_upsert',
      title: 'Created event',
      start: '2026-09-07T10:00',
      end: '2026-09-07T11:00',
      all_day: true,
      category: 'work',
    }, context(facade));
    const updated = await homeTool.execute({
      action: 'event_upsert',
      id: 'evt_existing',
      title: 'Updated event',
    }, context(facade));

    assert.deepEqual(created.metadata.calendar_receipt, {
      schema_version: 1,
      kind: 'event',
      op: 'create',
      id: 'evt_created',
      title: 'Created event',
      start: '2026-09-07T10:00',
      end: '2026-09-07T11:00',
      all_day: true,
      category: 'work',
      journal_entry_id: 'journal-event',
      journaled: true,
    });
    assert.equal(updated.metadata.calendar_receipt.op, 'update');
    assert.equal(updated.metadata.calendar_receipt.id, 'evt_existing');
    assert.equal(updated.metadata.calendar_receipt.title, 'Updated event');
    assert.match(created.content, /can be undone from the receipt in chat or from Home/);
  });

  test('attaches once/daily reminder upsert receipts', async () => {
    const facade = service();
    const created = await homeTool.execute({
      action: 'reminder_upsert',
      label: 'Call home',
      remind_at: '2026-09-07T18:00',
    }, context(facade));
    const updated = await homeTool.execute({
      action: 'reminder_upsert',
      id: 'rem_existing',
      label: 'Stretch now',
      remind_at: '09:45',
    }, context(facade));

    assert.deepEqual(created.metadata.calendar_receipt, {
      schema_version: 1,
      kind: 'reminder',
      op: 'create',
      id: 'rem_created',
      title: 'Call home',
      schedule_type: 'once_at',
      when: '2026-09-07T18:00',
      journal_entry_id: 'journal-reminder',
      journaled: true,
    });
    assert.equal(updated.metadata.calendar_receipt.op, 'update');
    assert.equal(updated.metadata.calendar_receipt.schedule_type, 'daily_at');
    assert.equal(updated.metadata.calendar_receipt.when, '09:45');
  });

  test('attaches completed event and reminder delete receipts from pre-delete state', async () => {
    const facade = service();
    const eventResult = await homeTool.execute(
      { action: 'event_delete', id: 'evt_existing', confirm: true },
      context(facade)
    );
    const reminderResult = await homeTool.execute(
      { action: 'reminder_delete', id: 'rem_existing', confirm: true },
      context(facade)
    );

    assert.deepEqual(eventResult.metadata.calendar_receipt, {
      schema_version: 1,
      kind: 'event',
      op: 'delete',
      id: 'evt_existing',
      title: 'Existing event',
      start: '2026-09-07T12:00',
      end: '2026-09-07T12:30',
      all_day: false,
      category: 'personal',
      journal_entry_id: 'journal-event-delete',
      journaled: true,
    });
    assert.deepEqual(reminderResult.metadata.calendar_receipt, {
      schema_version: 1,
      kind: 'reminder',
      op: 'delete',
      id: 'rem_existing',
      title: 'Existing reminder',
      schedule_type: 'daily_at',
      when: '08:30',
      journal_entry_id: 'journal-reminder-delete',
      journaled: true,
    });
    assert.match(eventResult.content, /undone from the receipt in chat or from Home/);
    assert.match(reminderResult.content, /undone from the receipt in chat or from Home/);
  });

  test('omits receipts from confirmation-required and failed writes/deletes', async () => {
    const confirmation = await homeTool.execute(
      { action: 'event_delete', id: 'evt_existing' },
      context(service())
    );
    const failedWrite = await homeTool.execute({
      action: 'event_upsert',
      title: 'Failure',
      start: '2026-09-07T10:00',
    }, context(service({
      upsertEvent() {
        return { ok: false, reason: 'calendar_write_failed' };
      },
    })));
    const failedDelete = await homeTool.execute(
      { action: 'reminder_delete', id: 'rem_existing', confirm: true },
      context(service({
        deleteReminder() {
          return { ok: false, reason: 'delete_failed' };
        },
      }))
    );

    assert.equal(confirmation.metadata.status, 'confirmation_required');
    assert.equal(Object.hasOwn(confirmation.metadata, 'calendar_receipt'), false);
    assert.equal(failedWrite.isError, true);
    assert.equal(Object.hasOwn(failedWrite.metadata, 'calendar_receipt'), false);
    assert.equal(failedDelete.isError, true);
    assert.equal(Object.hasOwn(failedDelete.metadata, 'calendar_receipt'), false);
  });
});
