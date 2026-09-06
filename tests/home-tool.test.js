'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const homeTool = require('../services/tools/builtin/home-tool');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { TOOL_ERROR_CODES } = require('../services/backend/error-codes');

// Stub facade: records every call so a "must not mutate" assertion is a
// positive check on the call log, not the absence of an observable effect.
function stubService(overrides = {}) {
  const calls = [];
  const base = {
    calls,
    listCalendar(range) {
      calls.push(['listCalendar', range]);
      return {
        windowStart: '2026-08-13T00:00',
        windowEnd: '2026-10-21T00:00',
        rangeStart: range?.start || '2026-08-13T00:00',
        rangeEnd: range?.end || '2026-10-21T00:00',
        instances: [
          {
            instanceId: 'evt_1:2026-08-21T10:00',
            eventId: 'evt_1',
            source: 'local',
            title: 'Dentist',
            start: '2026-08-21T10:00',
            end: '2026-08-21T10:30',
            allDay: false,
            sourceKind: 'assistant',
          },
        ],
      };
    },
    // Reads the full events array, NOT the expanded instance window — the
    // far-future event below has no instance in listCalendar on purpose.
    readEvent(id) {
      calls.push(['readEvent', id]);
      if (id === 'evt_1') {
        return { id: 'evt_1', title: 'Dentist', start: '2026-08-21T10:00' };
      }
      if (id === 'evt_far') {
        return { id: 'evt_far', title: 'Vacation', start: '2026-11-30T09:00' };
      }
      return null;
    },
    getProactive() {
      calls.push(['getProactive']);
      return { reminders: [{ id: 'rem_1', label: 'Stretch', scheduleType: 'daily_at', dailyAt: '09:30' }] };
    },
    readScratchpad() {
      calls.push(['readScratchpad']);
      return { activeNoteId: 'note-1', notes: [{ id: 'note-1', title: 'Ideas', text: 'ship it' }] };
    },
    upsertEvent(input, meta) {
      calls.push(['upsertEvent', input, meta]);
      return {
        ok: true,
        entryId: 'jnl_1',
        entityId: input.id || 'evt_new',
        op: input.id ? 'update' : 'create',
        entityState: { id: input.id || 'evt_new', title: input.title || '', start: input.start || '2026-08-21T10:00' },
      };
    },
    deleteEvent(id, meta) {
      calls.push(['deleteEvent', id, meta]);
      return { ok: true, entryId: 'jnl_2', entityId: id };
    },
    upsertReminder(input, meta) {
      calls.push(['upsertReminder', input, meta]);
      return {
        ok: true,
        entryId: 'jnl_3',
        entityId: input.id || 'rem_new',
        op: input.id ? 'update' : 'create',
        entityState: { id: input.id || 'rem_new', label: input.label || 'Reminder', ...input },
      };
    },
    deleteReminder(id, meta) {
      calls.push(['deleteReminder', id, meta]);
      return { ok: true, entryId: 'jnl_4', entityId: id };
    },
  };
  return { ...base, ...overrides, calls };
}

function context(service, extra = {}) {
  return { homeAssistantService: service, sessionId: 'sess_1', callId: 'call_1', ...extra };
}

const MUTATORS = ['upsertEvent', 'deleteEvent', 'upsertReminder', 'deleteReminder'];

function mutationCalls(service) {
  return service.calls.filter(([name]) => MUTATORS.includes(name));
}

describe('home tool descriptor', () => {
  test('exposes exactly the six actions and requires no workspace root', () => {
    assert.equal(homeTool.name, 'home');
    assert.equal(homeTool.workspaceRequired, false);
    assert.equal(homeTool.readOnly, false);
    assert.deepEqual(homeTool.parameters.required, ['action']);
    assert.equal(homeTool.parameters.additionalProperties, false);
    assert.deepEqual(homeTool.parameters.properties.action.enum, [
      'calendar_list',
      'event_upsert',
      'event_delete',
      'reminder_upsert',
      'reminder_delete',
      'scratchpad_read',
    ]);
  });

  test('fails structurally when the Home facade is unavailable', async () => {
    const result = await homeTool.execute({ action: 'calendar_list' }, {});
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.DISABLED);
    assert.equal(result.metadata.result_kind, 'home');
    assert.equal(result.metadata.reason, 'unavailable');
  });

  test('rejects an unknown action without touching the facade', async () => {
    const service = stubService();
    const result = await homeTool.execute({ action: 'event_nuke' }, context(service));
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'unsupported_action');
    assert.deepEqual(service.calls, []);
  });
});

describe('home tool reads', () => {
  test('calendar_list respects an explicit range and lists instances', async () => {
    const service = stubService();
    const result = await homeTool.execute(
      { action: 'calendar_list', range_start: '2026-08-21T00:00', range_end: '2026-08-22T00:00' },
      context(service)
    );
    assert.equal(result.isError, false);
    assert.equal(result.metadata.result_kind, 'home');
    assert.equal(result.metadata.range_start, '2026-08-21T00:00');
    assert.equal(result.metadata.instance_count, 1);
    assert.match(result.content, /Dentist/);
    assert.match(result.content, /id=evt_1/);
    assert.deepEqual(service.calls[0], [
      'listCalendar',
      { start: '2026-08-21T00:00', end: '2026-08-22T00:00' },
    ]);
  });

  test('scratchpad_read returns note titles and text and never writes', async () => {
    const service = stubService();
    const result = await homeTool.execute({ action: 'scratchpad_read' }, context(service));
    assert.equal(result.isError, false);
    assert.equal(result.metadata.note_count, 1);
    assert.match(result.content, /Ideas/);
    assert.match(result.content, /ship it/);
    assert.deepEqual(mutationCalls(service), []);
  });
});

describe('home tool writes', () => {
  test('event_upsert maps snake_case input onto schema fields', async () => {
    const service = stubService();
    const result = await homeTool.execute(
      {
        action: 'event_upsert',
        title: 'Dentist',
        start: '2026-08-21T10:00',
        end: '2026-08-21T11:00',
        all_day: false,
        category: 'personal',
        notes: 'bring the card',
        recurrence: 'monthly',
      },
      context(service)
    );
    assert.equal(result.isError, false);
    assert.equal(result.metadata.op, 'create');
    assert.equal(result.metadata.journal_entry_id, 'jnl_1');
    const [, payload, meta] = service.calls.find(([name]) => name === 'upsertEvent');
    assert.deepEqual(payload, {
      title: 'Dentist',
      start: '2026-08-21T10:00',
      end: '2026-08-21T11:00',
      allDay: false,
      categoryId: 'personal',
      notes: 'bring the card',
      recurrence: 'monthly',
    });
    assert.deepEqual(meta, { sessionId: 'sess_1', callId: 'call_1' });
  });

  test('event_upsert rejects out-of-enum category and recurrence without writing', async () => {
    const service = stubService();
    const bad = await homeTool.execute(
      { action: 'event_upsert', title: 'x', start: '2026-08-21T10:00', category: 'chartreuse' },
      context(service)
    );
    assert.equal(bad.metadata.reason, 'invalid_category');
    const worse = await homeTool.execute(
      { action: 'event_upsert', title: 'x', start: '2026-08-21T10:00', recurrence: 'hourly' },
      context(service)
    );
    assert.equal(worse.metadata.reason, 'invalid_recurrence');
    assert.deepEqual(mutationCalls(service), []);
  });

  test('event_upsert refuses a new event with no parseable start', async () => {
    const service = stubService();
    const result = await homeTool.execute(
      { action: 'event_upsert', title: 'Someday', start: 'next tuesday' },
      context(service)
    );
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'invalid_start');
    assert.deepEqual(mutationCalls(service), []);
  });

  test('event_upsert clips over-long title and notes to the schema bounds', async () => {
    const service = stubService();
    await homeTool.execute(
      {
        action: 'event_upsert',
        title: 'T'.repeat(400),
        notes: 'N'.repeat(5000),
        start: '2026-08-21T10:00',
      },
      context(service)
    );
    const [, payload] = service.calls.find(([name]) => name === 'upsertEvent');
    assert.equal(payload.title.length, 200);
    assert.equal(payload.notes.length, 2000);
  });

  test('reminder_upsert maps remind_at to once_at and daily_at cadences', async () => {
    const service = stubService();
    await homeTool.execute(
      { action: 'reminder_upsert', label: 'Call back', remind_at: '2026-08-22T08:00' },
      context(service)
    );
    await homeTool.execute(
      { action: 'reminder_upsert', label: 'Stretch', remind_at: '09:30' },
      context(service)
    );
    const [first, second] = service.calls.filter(([name]) => name === 'upsertReminder');
    assert.deepEqual(first[1], {
      label: 'Call back',
      scheduleType: 'once_at',
      onceAt: '2026-08-22T08:00',
    });
    assert.deepEqual(second[1], {
      label: 'Stretch',
      scheduleType: 'daily_at',
      dailyAt: '09:30',
    });
  });

  test('reminder_upsert refuses an unparseable remind_at without writing', async () => {
    const service = stubService();
    const result = await homeTool.execute(
      { action: 'reminder_upsert', label: 'Later', remind_at: 'tomorrow morning' },
      context(service)
    );
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'invalid_remind_at');
    assert.deepEqual(mutationCalls(service), []);
  });

  test('reminder_upsert refuses impossible clock times and calendar dates', async () => {
    for (const remindAt of ['24:00', '2026-08-22T10:60', '2026-02-30T10:00']) {
      const service = stubService();
      const result = await homeTool.execute(
        { action: 'reminder_upsert', label: 'Invalid', remind_at: remindAt },
        context(service)
      );
      assert.equal(result.isError, true);
      assert.equal(result.metadata.reason, 'invalid_remind_at');
      assert.deepEqual(mutationCalls(service), []);
    }
  });

  test('reminder_upsert clips label and prompt to the reminder bounds', async () => {
    const service = stubService();
    await homeTool.execute(
      {
        action: 'reminder_upsert',
        label: 'L'.repeat(500),
        prompt: 'P'.repeat(9000),
        remind_at: '09:30',
      },
      context(service)
    );
    const [, payload] = service.calls.find(([name]) => name === 'upsertReminder');
    assert.equal(payload.label.length, 200);
    assert.equal(payload.prompt.length, 4000);
  });
});

describe('home tool write refusals and degraded journaling', () => {
  test('event_upsert surfaces a not_found facade refusal naming the id', async () => {
    const service = stubService({
      upsertEvent(input, meta) {
        this.calls.push(['upsertEvent', input, meta]);
        return { ok: false, reason: 'not_found', entityId: input.id };
      },
    });

    const result = await homeTool.execute(
      { action: 'event_upsert', id: 'evt_made_up', title: 'Ghost' },
      context(service)
    );

    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'not_found');
    assert.match(result.content, /evt_made_up/);
    assert.match(result.content, /omit id to create a new event/);
    assert.equal(result.summary, 'Event not found');
  });

  test('reminder_upsert surfaces a not_found facade refusal naming the id', async () => {
    const service = stubService({
      upsertReminder(input, meta) {
        this.calls.push(['upsertReminder', input, meta]);
        return { ok: false, reason: 'not_found', entityId: input.id };
      },
    });

    const result = await homeTool.execute(
      { action: 'reminder_upsert', id: 'rem_made_up', label: 'Ghost' },
      context(service)
    );

    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'not_found');
    assert.match(result.content, /rem_made_up/);
    assert.match(result.content, /Omit id to create a new reminder/);
    assert.equal(result.summary, 'Reminder not found');
  });

  test('a write whose journal entry failed says so instead of promising an undo', async () => {
    const service = stubService({
      upsertEvent(input, meta) {
        this.calls.push(['upsertEvent', input, meta]);
        return {
          ok: true,
          entryId: '',
          entityId: 'evt_new',
          op: 'create',
          journaled: false,
          entityState: { id: 'evt_new', title: input.title, start: input.start },
        };
      },
    });

    const result = await homeTool.execute(
      { action: 'event_upsert', title: 'Written anyway', start: '2026-08-21T10:00' },
      context(service)
    );

    assert.equal(result.isError, false, 'the entity write landed, so the call succeeded');
    assert.equal(result.metadata.journaled, false);
    assert.match(result.content, /cannot be undone from Home/);
  });

  test('a normal write reports journaled true', async () => {
    const service = stubService();
    const result = await homeTool.execute(
      { action: 'event_upsert', title: 'Normal', start: '2026-08-21T10:00' },
      context(service)
    );
    assert.equal(result.metadata.journaled, true);
    assert.match(result.content, /can be undone from Home/);
  });
});

describe('home tool delete confirmation contract', () => {
  for (const [action, id, deleteCall, label] of [
    ['event_delete', 'evt_1', 'deleteEvent', 'Dentist'],
    ['reminder_delete', 'rem_1', 'deleteReminder', 'Stretch'],
  ]) {
    test(`${action} without confirm mutates nothing and names the target`, async () => {
      const service = stubService();
      const result = await homeTool.execute({ action, id }, context(service));
      assert.equal(result.isError, false);
      assert.equal(result.metadata.status, 'confirmation_required');
      assert.equal(result.metadata.target_label, label);
      assert.match(result.content, new RegExp(label));
      assert.match(result.content, /Nothing has been deleted/);
      assert.deepEqual(mutationCalls(service), []);
    });

    test(`${action} with confirm deletes and reports the journal entry`, async () => {
      const service = stubService();
      const result = await homeTool.execute({ action, id, confirm: true }, context(service));
      assert.equal(result.isError, false);
      assert.equal(result.metadata.status, 'ok');
      assert.ok(result.metadata.journal_entry_id);
      assert.deepEqual(
        mutationCalls(service).map(([name, calledId]) => [name, calledId]),
        [[deleteCall, id]]
      );
    });

    test(`${action} refuses an unknown id`, async () => {
      const service = stubService();
      const result = await homeTool.execute(
        { action, id: 'nope', confirm: true },
        context(service)
      );
      assert.equal(result.isError, true);
      assert.equal(result.metadata.reason, 'not_found');
      assert.deepEqual(mutationCalls(service), []);
    });
  }

  test('event_delete reaches an event outside the calendar instance window', async () => {
    const service = stubService();
    // listCalendar's window has no instance for evt_far; a precheck that read
    // instances would refuse a delete the service itself can perform.
    assert.equal(
      service.listCalendar().instances.some((instance) => instance.eventId === 'evt_far'),
      false
    );

    const prompt = await homeTool.execute(
      { action: 'event_delete', id: 'evt_far' },
      context(service)
    );
    assert.equal(prompt.metadata.status, 'confirmation_required');
    assert.equal(prompt.metadata.target_label, 'Vacation');
    assert.deepEqual(mutationCalls(service), []);

    const done = await homeTool.execute(
      { action: 'event_delete', id: 'evt_far', confirm: true },
      context(service)
    );
    assert.equal(done.isError, false);
    assert.equal(done.metadata.status, 'ok');
    assert.deepEqual(
      mutationCalls(service).map(([name, calledId]) => [name, calledId]),
      [['deleteEvent', 'evt_far']]
    );
  });

  test('event_delete requires an id', async () => {
    const service = stubService();
    const result = await homeTool.execute({ action: 'event_delete', confirm: true }, context(service));
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'id_required');
    assert.deepEqual(mutationCalls(service), []);
  });
});

describe('home tool registration and gating', () => {
  test('the registry registers home only when the flag option is true', () => {
    assert.equal(
      createDefaultRegistry({}).getAllTools().some((tool) => tool.name === 'home'),
      false
    );
    assert.equal(
      createDefaultRegistry({ toolsHomeEnabled: true }).getAllTools().some((tool) => tool.name === 'home'),
      true
    );
  });

  test('a read-only request refuses the home tool because it is not read-only', async () => {
    const service = stubService();
    const executor = new ToolExecutor({
      registry: createDefaultRegistry({ toolsHomeEnabled: true }),
      permissionStore: {
        getAllPolicies: () => ({ home: 'auto' }),
        getSnapshot: () => ({ version: 1, legacy_policies: { home: 'auto' }, rules: [] }),
      },
      pathPolicy: {},
      logger: () => {},
      homeAssistantService: () => service,
    });

    const result = await executor.execute(
      { callId: 'call_ro', toolName: 'home', input: { action: 'calendar_list' } },
      { readOnly: true }
    );

    assert.equal(result.isError, true);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.DISABLED);
    assert.match(result.content, /read-only/);
    assert.deepEqual(service.calls, []);
  });

  test('the executor threads the live home facade into the execution context', async () => {
    const service = stubService();
    const executor = new ToolExecutor({
      registry: createDefaultRegistry({ toolsHomeEnabled: true }),
      permissionStore: {
        getAllPolicies: () => ({ home: 'auto' }),
        getSnapshot: () => ({ version: 1, legacy_policies: { home: 'auto' }, rules: [] }),
      },
      pathPolicy: {},
      logger: () => {},
      homeAssistantService: () => service,
    });

    const result = await executor.execute(
      { callId: 'call_ok', toolName: 'home', input: { action: 'scratchpad_read' } },
      {}
    );

    assert.equal(result.isError, false);
    assert.equal(result.metadata.result_kind, 'home');
    assert.deepEqual(service.calls, [['readScratchpad']]);
  });
});
