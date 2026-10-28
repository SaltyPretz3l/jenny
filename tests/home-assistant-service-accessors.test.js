'use strict';

// Read-only accessors on HomeAssistantService: single-record reads, the
// facade clock, and event reads that skip CalendarService.getState().

const test = require('node:test');
const assert = require('node:assert/strict');

const { CalendarService } = require('../services/calendar-service');
const { HomeAssistantService } = require('../services/home-assistant-service');
const { normalizeReminder } = require('../services/shell-config-followups-schema');

function memoryStore() {
  let value;
  return {
    read: (fallback) => (value === undefined ? fallback : value),
    writeImmediate: (next) => { value = JSON.parse(JSON.stringify(next)); },
  };
}

function build() {
  const nowProvider = () => new Date(2026, 7, 20, 9, 0);
  const state = {
    home: { scratchpad: { activeNoteId: '', notes: [] } },
    proactive: { reminders: [normalizeReminder({ id: 'rem_1', label: 'Stretch', scheduleType: 'daily_at', dailyAt: '09:30' })] },
  };
  const configService = {
    getState: () => state,
    getHomeConfig: () => state.home,
    on: () => {},
    off: () => {},
    upsertReminder: () => state,
    deleteReminder: () => state,
  };
  const calendarService = new CalendarService({ store: memoryStore(), configService, nowProvider });
  const service = new HomeAssistantService({ store: memoryStore(), calendarService, configService, nowProvider });
  return { service, calendarService, state };
}

test('readReminder returns one copied reminder and null for an unknown id', () => {
  const { service, state } = build();
  const reminder = service.readReminder('rem_1');
  assert.equal(reminder.label, 'Stretch');
  reminder.label = 'mutated';
  assert.equal(state.proactive.reminders[0].label, 'Stretch');
  assert.equal(service.readReminder('missing'), null);
  assert.equal(service.readReminder(''), null);
});

test('now() is the facade clock', () => {
  const { service } = build();
  assert.equal(service.now().getTime(), new Date(2026, 7, 20, 9, 0).getTime());
});

test('event reads skip the calendar expansion and the journal keeps a copy', () => {
  const { service, calendarService } = build();
  const created = service.upsertEvent({ title: 'Dentist', start: '2026-08-21T10:00', end: '2026-08-21T10:30' }, {});
  const getState = calendarService.getState.bind(calendarService);
  let expansions = 0;
  calendarService.getState = (...args) => { expansions += 1; return getState(...args); };

  const read = service.readEvent(created.entityId);
  read.title = 'mutated';
  assert.equal(service.readEvent(created.entityId).title, 'Dentist');
  assert.equal(expansions, 0, 'readEvent no longer expands every instance');

  calendarService.getState = getState;
  const updated = service.upsertEvent({ id: created.entityId, title: 'Dentist (moved)' }, {});
  const deleted = service.deleteEvent(created.entityId, {});
  assert.equal(updated.ok && deleted.ok, true);
  assert.equal(updated.entityState.title, 'Dentist (moved)');
  const journal = service.listJournal().entries;
  assert.equal(journal.find((entry) => entry.op === 'update').inverse.payload.title, 'Dentist');
  assert.equal(journal.find((entry) => entry.op === 'delete').inverse.payload.title, 'Dentist (moved)');
});
