'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { CalendarService } = require('../services/calendar-service');
const { HomeAssistantService } = require('../services/home-assistant-service');
const { HomeAiJournalStore, MAX_LIVE_ENTRIES } = require('../services/home-ai-journal-store');
const { ShellConfigService } = require('../services/shell-config-service');
const { normalizeReminder, sortReminders } = require('../services/shell-config-followups-schema');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

function memoryStore() {
  let value;
  return {
    read: (fallback) => (value === undefined ? fallback : value),
    writeImmediate: (next) => {
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

// Faithful stand-in for the reminder half of ShellConfigService: it runs the
// SAME normalizer the real service runs (normalizeReminder + sortReminders),
// which is what the journal's postHash fingerprints, without booting the whole
// config service and its on-disk schema migration.
function fakeConfigService(initial = {}) {
  const state = {
    home: initial.home || { scratchpad: { activeNoteId: 'note-1', notes: [] } },
    proactive: { reminders: (initial.reminders || []).map((entry) => normalizeReminder(entry)) },
  };
  return {
    getState: () => state,
    getHomeConfig: () => state.home,
    on: () => {},
    off: () => {},
    upsertReminder(reminder) {
      const normalized = normalizeReminder(reminder);
      const rest = state.proactive.reminders.filter((entry) => entry.id !== normalized.id);
      state.proactive.reminders = sortReminders([...rest, normalized]);
      return state;
    },
    deleteReminder(id) {
      state.proactive.reminders = state.proactive.reminders.filter((entry) => entry.id !== id);
      return state;
    },
  };
}

function build({ reminders = [], home } = {}) {
  let tick = 0;
  const nowProvider = () => new Date(2026, 7, 20, 9, 0, tick++);
  const configService = fakeConfigService({ reminders, home });
  const calendarService = new CalendarService({
    store: memoryStore(),
    configService,
    nowProvider,
  });
  const service = new HomeAssistantService({
    store: memoryStore(),
    calendarService,
    configService,
    nowProvider,
  });
  return { service, calendarService, configService };
}

function liveEntries(service) {
  return service.listJournal().entries.filter((entry) => !entry.undoneAt && !entry.supersededAt);
}

// The reminder-merge contract is about what the REAL ShellConfigService does
// with a partial payload (normalizeReminder is a full replace that fills
// defaults), so these build the actual service against a temp userDataPath —
// a stub that merged for us would prove nothing.
function buildWithRealConfig({ prefix = 'jenny-home-assistant-' } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(userDataPath);
  let tick = 0;
  const nowProvider = () => new Date(2026, 7, 20, 9, 0, tick++);
  const configService = new ShellConfigService({ userDataPath });
  const calendarService = new CalendarService({
    store: memoryStore(),
    configService,
    nowProvider,
  });
  const service = new HomeAssistantService({
    store: memoryStore(),
    calendarService,
    configService,
    nowProvider,
  });
  return { service, calendarService, configService, userDataPath };
}

function reminderById(configService, id) {
  return configService.getState().proactive.reminders.find((entry) => entry.id === id);
}

describe('HomeAssistantService attribution', () => {
  test('stamps assistant attribution on events and reminders', () => {
    const { service, calendarService, configService } = build();
    const event = service.upsertEvent(
      { title: 'Dentist', start: '2026-08-21T10:00' },
      { sessionId: 'sess_1' }
    );
    const reminder = service.upsertReminder(
      { label: 'Stretch', dailyAt: '09:30', scheduleType: 'daily_at' },
      { sessionId: 'sess_1' }
    );

    const storedEvent = calendarService.getState().events.find((entry) => entry.id === event.entityId);
    assert.equal(storedEvent.sourceKind, 'assistant');
    assert.equal(storedEvent.sourceId, 'sess_1');
    const storedReminder = configService.getState().proactive.reminders
      .find((entry) => entry.id === reminder.entityId);
    assert.equal(storedReminder.sourceKind, 'assistant');
    assert.equal(storedReminder.sourceId, 'sess_1');
  });

  // N1: the chip says "Added by jenny", it is permanent, and it cannot be
  // dismissed — so an assistant EDIT must not re-badge a record the user made.
  test('an assistant edit leaves a user-created record unattributed', () => {
    const { service, calendarService, configService } = build();
    // The Home UI's own create path: straight through the shared service, no
    // attribution stamped at all.
    const created = calendarService.createEvent({ title: 'Lunch', start: '2026-08-21T12:00' });
    const eventId = created.events[created.events.length - 1].id;
    configService.upsertReminder({ id: 'rem_user', label: 'Water plants', scheduleType: 'daily_at', dailyAt: '08:00' });
    assert.equal(reminderById(configService, 'rem_user').sourceKind, '');

    service.upsertEvent({ id: eventId, title: 'Lunch with Sam' }, { sessionId: 'sess_2' });
    service.upsertReminder({ id: 'rem_user', label: 'Water the plants' }, { sessionId: 'sess_2' });

    const storedEvent = calendarService.getState().events.find((entry) => entry.id === eventId);
    assert.equal(storedEvent.title, 'Lunch with Sam', 'the edit itself must still land');
    assert.equal(storedEvent.sourceKind, '');
    assert.equal(storedEvent.sourceId, '', 'sourceId travels with sourceKind or the pair is incoherent');
    const storedReminder = reminderById(configService, 'rem_user');
    assert.equal(storedReminder.label, 'Water the plants');
    assert.equal(storedReminder.sourceKind, '');
    assert.equal(storedReminder.sourceId, '');
  });

  test('an assistant edit keeps the ORIGINAL creating call on an assistant record', () => {
    const { service, calendarService } = build();
    const created = service.upsertEvent({ title: 'Dentist', start: '2026-08-21T10:00' }, { sessionId: 'sess_1' });
    service.upsertEvent({ id: created.entityId, title: 'Dentist (moved)' }, { sessionId: 'sess_7' });

    const storedEvent = calendarService.getState().events.find((entry) => entry.id === created.entityId);
    assert.equal(storedEvent.sourceKind, 'assistant');
    assert.equal(storedEvent.sourceId, 'sess_1', 'attribution points at the CREATING call, not the editing one');
  });

  test('a model-supplied attribution cannot re-badge a user record on update', () => {
    const { service, calendarService } = build();
    const created = calendarService.createEvent({ title: 'Gym', start: '2026-08-21T18:00' });
    const eventId = created.events[created.events.length - 1].id;

    service.upsertEvent(
      { id: eventId, title: 'Gym', sourceKind: 'assistant', sourceId: 'spoofed' },
      { sessionId: 'sess_3' }
    );

    const storedEvent = calendarService.getState().events.find((entry) => entry.id === eventId);
    assert.equal(storedEvent.sourceKind, '');
    assert.equal(storedEvent.sourceId, '');
  });

  test('emits changed with the journal and reminder snapshot', () => {
    const { service } = build();
    const seen = [];
    service.on('changed', (payload) => seen.push(payload));

    service.upsertEvent({ title: 'Standup', start: '2026-08-21T09:15' }, {});

    assert.equal(seen.length, 1);
    assert.equal(seen[0].journal.entries.length, 1);
    assert.equal(seen[0].journal.entries[0].entity, 'calendar_event');
    assert.deepEqual(seen[0].proactive, { reminders: [] });
  });
});

describe('HomeAssistantService journal invariants', () => {
  test('a second write to the same entity supersedes the earlier live entry', () => {
    const { service } = build();
    const created = service.upsertEvent({ title: 'Draft', start: '2026-08-21T11:00' }, {});
    service.upsertEvent({ id: created.entityId, title: 'Draft v2' }, {});

    const entries = service.listJournal().entries;
    assert.equal(entries.length, 2);
    assert.notEqual(entries[0].supersededAt, '', 'the earlier entry must be stamped superseded');
    assert.equal(entries[1].supersededAt, '');
    assert.equal(liveEntries(service).length, 1);
  });

  test('the live ring is capped at 20 entries, evicting oldest first', () => {
    const { service } = build();
    const created = [];
    for (let index = 0; index < MAX_LIVE_ENTRIES + 5; index += 1) {
      created.push(service.upsertEvent(
        { title: `Event ${index}`, start: '2026-08-21T12:00' },
        {}
      ).entryId);
    }

    const live = liveEntries(service);
    assert.equal(live.length, MAX_LIVE_ENTRIES);
    const liveIds = new Set(live.map((entry) => entry.id));
    for (const entryId of created.slice(0, 5)) {
      assert.equal(liveIds.has(entryId), false, 'the oldest live entries must be evicted');
    }
    for (const entryId of created.slice(5)) {
      assert.equal(liveIds.has(entryId), true);
    }
  });

  test('a persisted journal row without a valid inverse cannot delete a Home entity', () => {
    const reminder = normalizeReminder({
      id: 'reminder-1',
      label: 'Keep me',
      scheduleType: 'once_at',
      onceAt: '2026-08-22T08:00',
    });
    const configService = fakeConfigService({ reminders: [reminder] });
    const calendarService = new CalendarService({
      store: memoryStore(),
      configService,
    });
    const baseEntry = {
      entity: 'reminder',
      entityId: reminder.id,
      op: 'update',
      postHash: JSON.stringify(reminder),
    };
    const malformedEntries = [
      { id: 'missing-inverse', ...baseEntry },
      { id: 'unknown-inverse', ...baseEntry, inverse: { kind: 'replace', payload: reminder } },
      { id: 'missing-restore-payload', ...baseEntry, inverse: { kind: 'restore' } },
      { id: 'invalid-update-payload', ...baseEntry, inverse: { kind: 'update', payload: 'bad' } },
    ];
    const store = {
      read: () => ({
        version: 1,
        entries: malformedEntries,
      }),
      writeImmediate() {},
    };
    const service = new HomeAssistantService({ store, calendarService, configService });

    for (const entry of malformedEntries) {
      assert.deepEqual(service.undo(entry.id), { ok: false, reason: 'entry_not_found' });
    }
    assert.deepEqual(configService.getState().proactive.reminders, [reminder]);
  });
});

describe('HomeAssistantService undo refusals', () => {
  test('refuses an entry that was already undone', () => {
    const { service } = build();
    const created = service.upsertEvent({ title: 'Once', start: '2026-08-21T13:00' }, {});
    assert.equal(service.undo(created.entryId).ok, true);

    const second = service.undo(created.entryId);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'already_undone');
  });

  test('refuses an entry superseded by a later assistant write', () => {
    const { service } = build();
    const created = service.upsertEvent({ title: 'First', start: '2026-08-21T14:00' }, {});
    service.upsertEvent({ id: created.entityId, title: 'Second' }, {});

    const refused = service.undo(created.entryId);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'superseded');
  });

  test('refuses when the user edited the record through the calendar service', () => {
    const { service, calendarService } = build();
    const created = service.upsertEvent({ title: 'Mine', start: '2026-08-21T15:00' }, {});
    calendarService.updateEvent(created.entityId, { title: 'Renamed by the user' });

    const refused = service.undo(created.entryId);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'changed_since');
    assert.equal(
      calendarService.getState().events.find((entry) => entry.id === created.entityId).title,
      'Renamed by the user',
      'a refused undo must leave the user edit untouched'
    );
  });
});

describe('HomeAssistantService undo execution', () => {
  test('undoing a create deletes the event', () => {
    const { service, calendarService } = build();
    const created = service.upsertEvent({ title: 'Temporary', start: '2026-08-21T16:00' }, {});

    const result = service.undo(created.entryId);
    assert.equal(result.ok, true);
    assert.equal(
      calendarService.getState().events.some((entry) => entry.id === created.entityId),
      false
    );
    assert.equal(result.calendar.events.length, 0);
  });

  test('undoing a delete restores the event fields', () => {
    const { service, calendarService } = build();
    calendarService.createEvent({ title: 'User event', start: '2026-08-21T17:00', notes: 'keep me' });
    const eventId = calendarService.getState().events[0].id;

    const deleted = service.deleteEvent(eventId, {});
    assert.equal(deleted.ok, true);
    assert.equal(calendarService.getState().events.length, 0);

    const undone = service.undo(deleted.entryId);
    assert.equal(undone.ok, true);
    const restored = calendarService.getState().events;
    assert.equal(restored.length, 1);
    assert.equal(restored[0].title, 'User event');
    assert.equal(restored[0].notes, 'keep me');
  });

  test('undoing an update restores the prior snapshot', () => {
    const { service, calendarService } = build();
    const created = service.upsertEvent(
      { title: 'Original', start: '2026-08-21T18:00', notes: 'first' },
      {}
    );
    const updated = service.upsertEvent(
      { id: created.entityId, title: 'Changed', notes: 'second' },
      {}
    );

    const undone = service.undo(updated.entryId);
    assert.equal(undone.ok, true);
    const event = calendarService.getState().events.find((entry) => entry.id === created.entityId);
    assert.equal(event.title, 'Original');
    assert.equal(event.notes, 'first');
  });

  test('undoing a reminder delete restores it with its own id', () => {
    const { service, configService } = build();
    const created = service.upsertReminder(
      { label: 'Water plants', scheduleType: 'once_at', onceAt: '2026-08-22T08:00' },
      {}
    );
    const deleted = service.deleteReminder(created.entityId, {});
    assert.equal(deleted.ok, true);
    assert.equal(configService.getState().proactive.reminders.length, 0);

    const undone = service.undo(deleted.entryId);
    assert.equal(undone.ok, true);
    const reminders = configService.getState().proactive.reminders;
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].id, created.entityId);
    assert.equal(reminders[0].onceAt, '2026-08-22T08:00');
    assert.deepEqual(undone.proactive.reminders.map((entry) => entry.id), [created.entityId]);
  });
});

describe('HomeAssistantService reads', () => {
  test('scratchpad reads expose titles and text without any write path', () => {
    const { service } = build({
      home: { scratchpad: { activeNoteId: 'note-1', notes: [{ id: 'note-1', title: 'Ideas', text: 'ship it' }] } },
    });

    const scratchpad = service.readScratchpad();
    assert.deepEqual(scratchpad.notes, [{ id: 'note-1', title: 'Ideas', text: 'ship it' }]);
    assert.equal(typeof service.writeScratchpad, 'undefined');
    assert.equal(typeof service.upsertScratchpadNote, 'undefined');
  });

  test('readEvent sees events outside the calendar instance window', () => {
    const { service } = build();
    // 90 days out is past the service's +60d instance window, so listCalendar
    // cannot see it — readEvent reads the full events array and must.
    const created = service.upsertEvent({ title: 'Far future', start: '2026-11-30T09:00' }, {});

    assert.equal(
      service.listCalendar().instances.some((i) => i.eventId === created.entityId),
      false,
      'the fixture must actually sit outside the window or the test proves nothing'
    );
    const event = service.readEvent(created.entityId);
    assert.equal(event.title, 'Far future');
    assert.equal(service.readEvent('evt_nope'), null);
  });

  test('calendar listing honours an explicit range', () => {
    const { service } = build();
    service.upsertEvent({ title: 'In range', start: '2026-08-21T09:00' }, {});
    service.upsertEvent({ title: 'Out of range', start: '2026-08-29T09:00' }, {});

    const listing = service.listCalendar({ start: '2026-08-21T00:00', end: '2026-08-22T00:00' });
    assert.deepEqual(listing.instances.map((instance) => instance.title), ['In range']);
    assert.equal(listing.rangeStart, '2026-08-21T00:00');
  });
});

describe('HomeAssistantService reminder patch merge (real ShellConfigService)', () => {
  test.afterEach(async () => {
    await cleanupTrackedResources();
  });

  test('a label-only update preserves every field the patch did not mention', () => {
    const { service, configService } = buildWithRealConfig();
    const created = service.upsertReminder(
      {
        label: 'Call the dentist',
        prompt: 'Ask about the crown',
        scheduleType: 'once_at',
        onceAt: '2026-09-01T14:30',
      },
      { sessionId: 'sess_merge' }
    );
    const before = reminderById(configService, created.entityId);
    assert.equal(before.scheduleType, 'once_at');
    assert.equal(before.onceAt, '2026-09-01T14:30');

    // Exactly what the tool sends for `{action:'reminder_upsert', id, label}`:
    // no cadence, no prompt. A replace-not-merge write would reset this to a
    // 09:00 daily reminder with an empty prompt.
    const updated = service.upsertReminder(
      { id: created.entityId, label: 'Call the dentist back' },
      { sessionId: 'sess_merge' }
    );
    assert.equal(updated.op, 'update');

    const after = reminderById(configService, created.entityId);
    assert.equal(after.label, 'Call the dentist back');
    assert.equal(after.scheduleType, 'once_at', 'the cadence must survive a label-only patch');
    assert.equal(after.onceAt, '2026-09-01T14:30');
    assert.equal(after.dailyAt, '', 'a once_at reminder must not gain a daily time');
    assert.equal(after.prompt, 'Ask about the crown');
    assert.equal(after.enabled, true);
    assert.equal(after.createdAt, before.createdAt, 'createdAt is not the model\'s to rewrite');
  });

  test('a merged update still lets a disabled reminder stay disabled', () => {
    const { service, configService } = buildWithRealConfig();
    const created = service.upsertReminder({ label: 'Snoozed', dailyAt: '07:15' }, {});
    configService.upsertReminder({
      ...reminderById(configService, created.entityId),
      enabled: false,
    });
    assert.equal(reminderById(configService, created.entityId).enabled, false);

    service.upsertReminder({ id: created.entityId, label: 'Snoozed, renamed' }, {});

    const after = reminderById(configService, created.entityId);
    assert.equal(after.label, 'Snoozed, renamed');
    assert.equal(after.enabled, false, 'merging must not silently re-enable a reminder');
  });

  test('an unknown reminder id is refused instead of minting one under it', () => {
    const { service, configService } = buildWithRealConfig();
    const created = service.upsertReminder({ label: 'Real', dailyAt: '08:00' }, {});

    const result = service.upsertReminder(
      { id: 'rem_made_up', label: 'Ghost' },
      { sessionId: 'sess_ghost' }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_found');
    assert.equal(result.entityId, 'rem_made_up');
    // normalizeReminder honours whatever id it is handed, so without the
    // refusal this would be a real 09:00-daily reminder living under the
    // invented id — not even a duplicate the user could recognise.
    assert.deepEqual(
      configService.getState().proactive.reminders.map((entry) => entry.id),
      [created.entityId],
      'a refused upsert must leave the reminder list untouched'
    );
    assert.equal(service.listJournal().entries.length, 1, 'and must not journal anything');
  });

  test('switching cadence clears the other cadence field', () => {
    const { service, configService } = buildWithRealConfig();
    const created = service.upsertReminder(
      { label: 'Standup', scheduleType: 'once_at', onceAt: '2026-09-01T14:30' },
      {}
    );

    service.upsertReminder(
      { id: created.entityId, scheduleType: 'daily_at', dailyAt: '09:15' },
      {}
    );

    const after = reminderById(configService, created.entityId);
    assert.equal(after.scheduleType, 'daily_at');
    assert.equal(after.dailyAt, '09:15');
    assert.equal(after.onceAt, '', 'the merge must not resurrect the old one-shot time');
    assert.equal(after.label, 'Standup', 'unmentioned fields still survive the cadence switch');
  });
});

describe('HomeAssistantService upsertEvent id handling', () => {
  test('an unknown event id is refused instead of creating a duplicate', () => {
    const { service, calendarService } = build();
    const created = service.upsertEvent({ title: 'Real', start: '2026-08-21T10:00' }, {});

    const result = service.upsertEvent({ id: 'evt_made_up', title: 'Ghost' }, {});

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_found');
    assert.equal(result.entityId, 'evt_made_up');
    assert.deepEqual(
      calendarService.getState().events.map((event) => event.id),
      [created.entityId],
      'a refused upsert must leave the store untouched'
    );
    assert.equal(service.listJournal().entries.length, 1, 'and must not journal anything');
  });

  test('the created id comes back from the write, not a re-read', () => {
    const { service, calendarService } = build();
    const created = service.upsertEvent({ title: 'Fresh', start: '2026-08-21T10:00' }, {});

    assert.match(created.entityId, /^evt_/);
    assert.equal(created.journaled, true);
    assert.equal(calendarService.getState().events[0].id, created.entityId);
    assert.equal(service.listJournal().entries[0].entityId, created.entityId);
  });
});

describe('HomeAiJournalStore persistence ordering', () => {
  function throwingStore(failAfter) {
    let writes = 0;
    const persisted = [];
    return {
      persisted,
      read: (fallback) => fallback,
      writeImmediate: (next) => {
        writes += 1;
        if (writes > failAfter) {
          throw new Error('disk is full');
        }
        persisted.push(JSON.parse(JSON.stringify(next)));
      },
    };
  }

  function entryFor(id, entityId, overrides = {}) {
    return {
      id,
      at: '2026-08-20T09:00:00.000Z',
      entity: 'calendar_event',
      entityId,
      op: 'create',
      label: id,
      sessionId: '',
      inverse: { kind: 'delete', payload: null },
      postHash: 'null',
      undoneAt: '',
      supersededAt: '',
      ...overrides,
    };
  }

  test('a failed persist leaves the in-memory ring exactly as it was', () => {
    const store = throwingStore(1);
    const journal = new HomeAiJournalStore({ store });
    const now = new Date('2026-08-20T09:00:00.000Z');
    journal.append(entryFor('jnl_1', 'evt_1'), now);
    const snapshot = JSON.parse(JSON.stringify(journal.list()));

    assert.throws(() => journal.append(entryFor('jnl_2', 'evt_1'), now), /disk is full/);

    assert.deepEqual(journal.list(), snapshot, 'memory must not diverge from disk');
    assert.equal(journal.list().length, 1);
    assert.equal(
      journal.list()[0].supersededAt,
      '',
      'the supersede stamp belongs to a write that never landed'
    );
    assert.deepEqual(
      store.persisted[store.persisted.length - 1].entries.map((entry) => entry.id),
      ['jnl_1']
    );
  });
});

describe('HomeAssistantService journal degradation', () => {
  test('a journal failure after a successful write returns ok with journaled:false', () => {
    const { service, calendarService } = build();
    const logs = [];
    service.logger = (level, event, fields) => logs.push([level, event, fields]);
    service.journal.append = () => {
      throw new Error('journal store is unwritable');
    };

    const created = service.upsertEvent({ title: 'Still written', start: '2026-08-21T10:00' }, {});

    assert.equal(created.ok, true, 'the entity write is the source of truth');
    assert.equal(created.journaled, false);
    assert.equal(created.entryId, '');
    assert.equal(
      calendarService.getState().events[0].title,
      'Still written',
      'the event must survive — failing the call would make the model retry and duplicate it'
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'WARN');
    assert.equal(logs[0][1], 'home_assistant.journal_append_failed');
    assert.equal(logs[0][2].op, 'create');
  });

  test('an unresolvable created id skips the journal instead of throwing', () => {
    const { service, calendarService } = build();
    const logs = [];
    service.logger = (level, event) => logs.push([level, event]);
    // A calendar store that reordered or swallowed the returned post-state is
    // the only way the id resolution can come back empty; the write itself has
    // already landed, so the call must still succeed.
    const realCreate = calendarService.createEvent.bind(calendarService);
    calendarService.createEvent = (payload) => {
      realCreate(payload);
      return { events: [] };
    };

    const created = service.upsertEvent({ title: 'Orphan', start: '2026-08-21T10:00' }, {});

    assert.equal(created.ok, true);
    assert.equal(created.journaled, false);
    assert.equal(created.entityId, '');
    assert.equal(service.listJournal().entries.length, 0);
    assert.deepEqual(logs, [['WARN', 'home_assistant.journal_append_failed']]);
  });
});
