'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const homeTool = require('../services/tools/builtin/home-tool');
const {
  normalizePersistedToolResultMetadata,
  normalizeToolResultMetadataForStorage,
} = require('../services/backend/tool-result-diff-metadata');
const {
  cloneSubagentReportMetadata,
} = require('../renderer/chat/renderer-turn-tree-projector-message-utils');

function calendarInstance(index) {
  const hour = 8 + (index % 10);
  const day = 7 + Math.floor(index / 10);
  const date = `2026-09-${String(day).padStart(2, '0')}`;
  return {
    instanceId: `event-${index}:${date}T${String(hour).padStart(2, '0')}:00`,
    eventId: `event-${index}`,
    title: `Event ${index}`,
    start: `${date}T${String(hour).padStart(2, '0')}:00`,
    end: `${date}T${String(hour + 1).padStart(2, '0')}:00`,
    allDay: false,
    categoryId: 'work',
    source: 'local',
    sourceKind: 'assistant',
    readonly: false,
    tzApprox: false,
    recurrenceUnsupported: false,
  };
}

function stubService() {
  const instances = Array.from({ length: 45 }, (_, index) => calendarInstance(index));
  instances[1] = {
    ...instances[1],
    start: instances[0].start,
    end: instances[0].end,
  };
  return {
    listCalendar() {
      return {
        rangeStart: '2026-09-07T00:00',
        rangeEnd: '2026-09-12T00:00',
        instances,
      };
    },
    listJournal() {
      return {
        entries: [{
          id: 'journal-recent',
          entity: 'calendar_event',
          entityId: 'event-1',
          op: 'update',
          sessionId: 'session-roundtrip',
          undoneAt: '',
          supersededAt: '',
        }],
      };
    },
    upsertEvent(input) {
      return {
        ok: true,
        entryId: 'journal-created',
        entityId: 'event-created',
        op: 'create',
        journaled: true,
        entityState: {
          id: 'event-created',
          title: input.title,
          start: input.start,
          end: input.end,
          allDay: input.allDay,
          categoryId: input.categoryId,
        },
      };
    },
  };
}

function normalizeStages(metadata) {
  const persisted = normalizePersistedToolResultMetadata(metadata);
  const stored = normalizeToolResultMetadataForStorage(metadata, {}, persisted);
  const projected = cloneSubagentReportMetadata(stored);
  return { persisted, stored, projected };
}

test('calendar_list metadata survives the real tool-to-projector round trip', async () => {
  const result = await homeTool.execute(
    { action: 'calendar_list' },
    {
      homeAssistantService: stubService(),
      sessionId: 'session-roundtrip',
      callId: 'call-list',
    }
  );
  const stages = normalizeStages(result.metadata);

  for (const calendar of [
    result.metadata.calendar,
    stages.persisted.calendar,
    stages.stored.calendar,
    stages.projected.calendar,
  ]) {
    assert.equal(calendar.instances.length, 40);
    assert.equal(calendar.instance_count, 45);
    assert.equal(calendar.omitted_count, 5);
    assert.equal(calendar.instances[1].recent, 'updated');
    assert.equal(calendar.instances[1].journal_entry_id, 'journal-recent');
    assert.equal(calendar.instances[1].overlaps.length, 1);
  }
  assert.deepEqual(stages.projected.calendar.instances[1].overlaps, [{
    instance_id: result.metadata.calendar.instances[0].instance_id,
    title: 'Event 0',
    start: result.metadata.calendar.instances[0].start,
  }]);
  assert.deepEqual(stages.projected.calendar, stages.stored.calendar);
});

test('event_upsert receipt survives the real tool-to-projector round trip', async () => {
  const result = await homeTool.execute(
    {
      action: 'event_upsert',
      title: 'Created event',
      start: '2026-09-07T10:00',
      end: '2026-09-07T11:00',
      all_day: false,
      category: 'work',
    },
    {
      homeAssistantService: stubService(),
      sessionId: 'session-roundtrip',
      callId: 'call-upsert',
    }
  );
  const stages = normalizeStages(result.metadata);

  assert.deepEqual(stages.persisted.calendar_receipt, result.metadata.calendar_receipt);
  assert.deepEqual(stages.stored.calendar_receipt, result.metadata.calendar_receipt);
  assert.deepEqual(stages.projected.calendar_receipt, stages.stored.calendar_receipt);
});
