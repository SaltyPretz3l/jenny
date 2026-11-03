'use strict';

// Row 85 S4: the port behind schedule_list / schedule_change and their approval card. A scheduled check is a
// Home reminder with action 'jenny_turn'; this service is its only model-facing writer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrimaryScheduleService } = require('../services/primary-schedule-service');
const { normalizeReminder, MAX_PROACTIVE_REMINDERS } = require('../services/shell-config-followups-schema');

const PRIMARY = 'sess_primary';
// Monday 2026-11-02 07:00 local (2026-11-01 was a Sunday).
const NOW = new Date(2026, 10, 2, 7, 0).getTime();
const local = (...parts) => new Date(...parts).getTime();
const LOCAL_ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/;

function harness({ reminders = [], flags = {}, primary = PRIMARY, failWrites = false, recordResult = true } = {}) {
  const state = { reminders: reminders.map((entry) => normalizeReminder(entry)), writes: 0 };
  const history = [];
  const logs = [];
  const shellConfigService = {
    getState: () => ({ proactive: { reminders: JSON.parse(JSON.stringify(state.reminders)) } }),
    upsertReminder(record) {
      if (failWrites) throw new Error('disk full at C:\\private');
      const normalized = normalizeReminder(record);
      const rest = state.reminders.filter((entry) => entry.id !== normalized.id);
      if (rest.length === state.reminders.length && state.reminders.length >= MAX_PROACTIVE_REMINDERS) {
        throw new Error('Reminder count exceeds the 50 reminder limit.');
      }
      state.reminders = [...rest, normalized];
      state.writes += 1;
    },
    deleteReminder(id) {
      if (failWrites) throw new Error('disk full');
      state.reminders = state.reminders.filter((entry) => entry.id !== id);
      state.writes += 1;
    },
  };
  const controls = {
    primarySessionId: () => primary,
    recordScheduleEvent: (entry) => { history.push(entry); return recordResult; },
  };
  const service = createPrimaryScheduleService({
    shellConfigService: () => shellConfigService,
    controls: () => controls,
    featureFlags: () => flags,
    now: () => NOW,
    log: (level, event, fields) => logs.push({ level, event, fields }),
  });
  return { service, state, history, logs };
}

const DAILY = { type: 'daily_at', daily_at: '08:00', weekdays: [1, 2, 3, 4, 5] };
const CREATE = { action: 'create', label: 'Morning summary', instruction: 'Tell me what finished overnight.', cadence: DAILY, caller_session_id: PRIMARY };
const PLAIN = { id: 'rem_plain', label: 'Stretch', scheduleType: 'daily_at', dailyAt: '09:30', createdAt: '2026-11-01T00:00:00.000Z' };
const CHECK = {
  id: 'rem_check', label: 'Release PR', prompt: 'Check whether the release PR is green.', scheduleType: 'once_at',
  onceAt: '2026-11-06T16:00', action: 'jenny_turn', sourceKind: 'assistant', createdAt: '2026-11-01T00:00:00.000Z',
};
const asMs = (values) => values.map((value) => { assert.match(value, LOCAL_ISO); return Date.parse(value); });

test('create writes a jenny_turn reminder with the instruction as its prompt, records history and answers the view', async () => {
  const { service, state, history } = harness({ reminders: [PLAIN] });
  const answer = await service.change(CREATE);
  assert.equal(answer.ok, true);
  const stored = state.reminders.find((entry) => entry.action === 'jenny_turn');
  assert.equal(stored.prompt, CREATE.instruction);
  assert.equal(stored.label, CREATE.label);
  assert.equal(stored.sourceKind, 'assistant');
  assert.equal(stored.scheduleType, 'daily_at');
  assert.equal(stored.dailyAt, '08:00');
  assert.deepEqual(stored.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(stored.enabled, true);
  assert.deepEqual(answer.check, {
    reminder_id: stored.id, label: 'Morning summary', instruction: CREATE.instruction, instruction_trust: 'user_approved',
    cadence: { type: 'daily_at', daily_at: '08:00', weekdays: [1, 2, 3, 4, 5] }, cadence_text: 'Weekdays at 08:00',
    enabled: true, last_fired_at: null,
  });
  assert.deepEqual(asMs(answer.next_fires), [local(2026, 10, 2, 8, 0), local(2026, 10, 3, 8, 0), local(2026, 10, 4, 8, 0)]);
  assert.deepEqual(history, [{ kind: 'schedule_created', reminder_id: stored.id, label: 'Morning summary', by: 'jenny' }]);
});

test('cadences in words and their next three fires', async () => {
  const cases = [
    [{ type: 'daily_at', daily_at: '08:00' }, 'Every day at 08:00', [local(2026, 10, 2, 8, 0), local(2026, 10, 3, 8, 0), local(2026, 10, 4, 8, 0)]],
    [{ type: 'daily_at', daily_at: '06:30', weekdays: [0, 6] }, 'Weekends at 06:30', [local(2026, 10, 7, 6, 30), local(2026, 10, 8, 6, 30), local(2026, 10, 14, 6, 30)]],
    [{ type: 'daily_at', daily_at: '18:00', weekdays: [5, 1, 3] }, 'Mon, Wed, Fri at 18:00', [local(2026, 10, 2, 18, 0), local(2026, 10, 4, 18, 0), local(2026, 10, 6, 18, 0)]],
    [{ type: 'daily_at', daily_at: '08:00', weekdays: [0, 1, 2, 3, 4, 5, 6] }, 'Every day at 08:00', null],
    [{ type: 'interval_minutes', interval_minutes: 120 }, 'Every 2 hours', [NOW + 120 * 60000, NOW + 240 * 60000, NOW + 360 * 60000]],
    [{ type: 'interval_minutes', interval_minutes: 60 }, 'Every hour', null],
    [{ type: 'interval_minutes', interval_minutes: 45 }, 'Every 45 minutes', null],
    [{ type: 'once_at', once_at: '2026-11-03T16:00' }, 'Once on 2026-11-03 at 16:00', [local(2026, 10, 3, 16, 0)]],
  ];
  for (const [cadence, words, fires] of cases) {
    const { service } = harness();
    const answer = await service.change({ ...CREATE, cadence });
    assert.equal(answer.ok, true, JSON.stringify(cadence));
    assert.equal(answer.check.cadence_text, words);
    if (fires) assert.deepEqual(asMs(answer.next_fires), fires, words);
  }
});

test('a closed input: unknown keys, bad shapes and bad cadences refuse invalid_input without a write', async () => {
  const { service, state, history } = harness({ reminders: [CHECK] });
  const bad = [
    undefined, null, [], {}, { ...CREATE, extra: 1 }, { ...CREATE, action: 'delete' }, { ...CREATE, purpose: 'x' },
    { ...CREATE, label: undefined }, { ...CREATE, label: '' }, { ...CREATE, label: '   ' }, { ...CREATE, label: 'x'.repeat(201) },
    { ...CREATE, instruction: undefined }, { ...CREATE, instruction: '' }, { ...CREATE, instruction: 'x'.repeat(4001) },
    { ...CREATE, cadence: undefined }, { ...CREATE, cadence: 'daily' }, { ...CREATE, cadence: { type: 'weekly' } },
    { ...CREATE, cadence: { type: 'daily_at' } }, { ...CREATE, cadence: { type: 'daily_at', daily_at: '24:00' } },
    { ...CREATE, cadence: { type: 'daily_at', daily_at: '8:00' } }, { ...CREATE, cadence: { ...DAILY, weekdays: [7] } },
    { ...CREATE, cadence: { ...DAILY, weekdays: [1, 1] } }, { ...CREATE, cadence: { ...DAILY, weekdays: '1-5' } },
    { ...CREATE, cadence: { ...DAILY, interval_minutes: 30 } },
    { ...CREATE, cadence: { type: 'interval_minutes', interval_minutes: 29 } },
    { ...CREATE, cadence: { type: 'interval_minutes', interval_minutes: 30.5 } },
    { ...CREATE, cadence: { type: 'interval_minutes', interval_minutes: 10081 } },
    { ...CREATE, cadence: { type: 'interval_minutes', interval_minutes: 60, weekdays: [1] } },
    { ...CREATE, cadence: { type: 'once_at', once_at: '2026-11-02T06:59' } }, // already past
    { ...CREATE, cadence: { type: 'once_at', once_at: '2026-02-30T10:00' } },
    { ...CREATE, cadence: { type: 'once_at', once_at: '2026-11-03 16:00' } },
    { ...CREATE, reminder_id: 'rem_check' },
    { action: 'update', reminder_id: 'rem_check', caller_session_id: PRIMARY },
    { action: 'update', label: 'x', caller_session_id: PRIMARY },
    { action: 'enable', caller_session_id: PRIMARY },
    { action: 'disable', reminder_id: 'rem_check', label: 'x', caller_session_id: PRIMARY },
    { action: 'cancel', reminder_id: '', caller_session_id: PRIMARY },
    { action: 'cancel', reminder_id: 'r'.repeat(129), caller_session_id: PRIMARY },
  ];
  for (const input of bad) {
    assert.deepEqual(await service.change(input), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
    assert.deepEqual(await service.describeChange(input), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.equal(state.writes, 0);
  assert.deepEqual(history, []);
});

test('the reminder id must name a stored check: not_found, then not_a_check for a plain reminder', async () => {
  const { service, state } = harness({ reminders: [PLAIN, CHECK] });
  for (const action of ['enable', 'disable', 'cancel']) {
    assert.deepEqual(await service.change({ action, reminder_id: 'rem_nope', caller_session_id: PRIMARY }), { ok: false, reason: 'not_found' });
    assert.deepEqual(await service.change({ action, reminder_id: 'rem_plain', caller_session_id: PRIMARY }), { ok: false, reason: 'not_a_check' });
  }
  assert.deepEqual(await service.change({ action: 'update', reminder_id: 'rem_plain', label: 'x', caller_session_id: PRIMARY }),
    { ok: false, reason: 'not_a_check' });
  assert.equal(state.writes, 0);
});

test('update keeps the action and attribution, edits only what it names and re-arms a re-timed one-off', async () => {
  const fired = { ...CHECK, lastFiredAt: '2026-11-01T12:00:00.000Z' };
  const { service, state, history } = harness({ reminders: [fired] });
  const renamed = await service.change({ action: 'update', reminder_id: 'rem_check', label: 'Release PR green?', caller_session_id: PRIMARY });
  assert.equal(renamed.ok, true);
  let stored = state.reminders[0];
  assert.equal(stored.label, 'Release PR green?');
  assert.equal(stored.prompt, CHECK.prompt);
  assert.equal(stored.action, 'jenny_turn');
  assert.equal(stored.sourceKind, 'assistant');
  assert.equal(stored.lastFiredAt, '2026-11-01T12:00:00.000Z', 'a label edit does not re-arm');
  assert.deepEqual(renamed.next_fires, []);
  const retimed = await service.change({
    action: 'update', reminder_id: 'rem_check', instruction: 'Check the PR and the CI run.',
    cadence: { type: 'once_at', once_at: '2026-11-07T09:00' }, caller_session_id: PRIMARY,
  });
  stored = state.reminders[0];
  assert.equal(stored.prompt, 'Check the PR and the CI run.');
  assert.equal(stored.onceAt, '2026-11-07T09:00');
  assert.equal(stored.lastFiredAt, '', 'a re-timed one-off fires again');
  assert.deepEqual(asMs(retimed.next_fires), [local(2026, 10, 7, 9, 0)]);
  const toDaily = await service.change({ action: 'update', reminder_id: 'rem_check', cadence: { type: 'interval_minutes', interval_minutes: 90 }, caller_session_id: PRIMARY });
  assert.equal(toDaily.check.cadence_text, 'Every 90 minutes');
  assert.equal(state.reminders[0].onceAt, '');
  assert.deepEqual(history.map((entry) => entry.kind), ['schedule_updated', 'schedule_updated', 'schedule_updated']);
  assert.equal(history[0].label, 'Release PR green?');
});

test('enable, disable and cancel change only the check and record their kinds', async () => {
  const { service, state, history } = harness({ reminders: [PLAIN, CHECK] });
  const off = await service.change({ action: 'disable', reminder_id: 'rem_check', caller_session_id: PRIMARY });
  assert.equal(off.ok, true);
  assert.equal(off.check.enabled, false);
  assert.deepEqual(off.next_fires, []);
  assert.equal(state.reminders.find((entry) => entry.id === 'rem_check').enabled, false);
  const on = await service.change({ action: 'enable', reminder_id: 'rem_check', caller_session_id: PRIMARY });
  assert.equal(on.check.enabled, true);
  assert.deepEqual(asMs(on.next_fires), [local(2026, 10, 6, 16, 0)]);
  const gone = await service.change({ action: 'cancel', reminder_id: 'rem_check', caller_session_id: PRIMARY });
  assert.equal(gone.ok, true);
  assert.equal(gone.check.reminder_id, 'rem_check');
  assert.deepEqual(gone.next_fires, []);
  assert.deepEqual(state.reminders.map((entry) => entry.id), ['rem_plain'], 'plain reminders are untouched');
  assert.deepEqual(history, [
    { kind: 'schedule_disabled', reminder_id: 'rem_check', label: 'Release PR', by: 'jenny' },
    { kind: 'schedule_enabled', reminder_id: 'rem_check', label: 'Release PR', by: 'jenny' },
    { kind: 'schedule_cancelled', reminder_id: 'rem_check', label: 'Release PR', by: 'jenny' },
  ]);
});

test('the 50-reminder cap is shared with plain reminders', async () => {
  const many = Array.from({ length: MAX_PROACTIVE_REMINDERS }, (_unused, index) => ({ ...PLAIN, id: `rem_${index}` }));
  const { service, state } = harness({ reminders: many });
  assert.deepEqual(await service.change(CREATE), { ok: false, reason: 'limit_reached' });
  assert.deepEqual(await service.describeChange(CREATE), { ok: false, reason: 'limit_reached' });
  assert.equal(state.writes, 0);
  const { service: room } = harness({ reminders: many.slice(1) });
  assert.equal((await room.change(CREATE)).ok, true);
});

test('kill switches answer disabled; a caller other than the primary chat is denied', async () => {
  for (const flags of [{ primary_scheduled_checks: false }, { primary_chat: false }]) {
    const { service, state } = harness({ flags, reminders: [CHECK] });
    assert.deepEqual(await service.change(CREATE), { ok: false, reason: 'disabled' });
    assert.deepEqual(await service.describeChange(CREATE), { ok: false, reason: 'disabled' });
    assert.deepEqual(await service.list({ caller_session_id: PRIMARY }), { ok: false, reason: 'disabled' });
    assert.equal(state.writes, 0);
  }
  for (const caller of ['sess_other', undefined, '']) {
    const { service, state } = harness();
    const input = { ...CREATE, caller_session_id: caller };
    if (caller === undefined) delete input.caller_session_id;
    assert.deepEqual(await service.change(input), { ok: false, reason: 'denied' }, String(caller));
    assert.deepEqual(await service.list(caller === undefined ? {} : { caller_session_id: caller }), { ok: false, reason: 'denied' });
    assert.equal(state.writes, 0);
  }
  const { service } = harness({ primary: null });
  assert.deepEqual(await service.change(CREATE), { ok: false, reason: 'denied' }, 'no primary chat, no writes');
});

test('a failed write reads denied, records no history and never throws or leaks the error', async () => {
  const { service, history, logs } = harness({ reminders: [CHECK], failWrites: true });
  assert.deepEqual(await service.change(CREATE), { ok: false, reason: 'denied' });
  assert.deepEqual(await service.change({ action: 'cancel', reminder_id: 'rem_check', caller_session_id: PRIMARY }), { ok: false, reason: 'denied' });
  assert.deepEqual(history, []);
  assert.equal(JSON.stringify(logs).includes('private'), false);
  const broken = createPrimaryScheduleService({ shellConfigService: () => { throw new Error('boom'); }, controls: () => null });
  assert.deepEqual(await broken.change(CREATE), { ok: false, reason: 'denied' });
  assert.deepEqual(await broken.list({ caller_session_id: PRIMARY }), { ok: false, reason: 'denied' });
});

test('list answers the checks, and plain reminders only when asked, without their text', async () => {
  const { service } = harness({ reminders: [PLAIN, CHECK] });
  const answer = await service.list({ caller_session_id: PRIMARY });
  assert.equal(answer.ok, true);
  assert.equal(answer.schema_version, 1);
  assert.equal(answer.truncated, false);
  assert.equal(Object.hasOwn(answer, 'reminders'), false);
  assert.deepEqual(answer.checks, [{
    reminder_id: 'rem_check', label: 'Release PR', instruction: CHECK.prompt, instruction_trust: 'user_approved',
    cadence: { type: 'once_at', once_at: '2026-11-06T16:00' }, cadence_text: 'Once on 2026-11-06 at 16:00',
    enabled: true, last_fired_at: null, next_fires: answer.checks[0].next_fires,
  }]);
  assert.deepEqual(asMs(answer.checks[0].next_fires), [local(2026, 10, 6, 16, 0)]);
  const both = await service.list({ include_reminders: true, caller_session_id: PRIMARY });
  assert.deepEqual(both.reminders, [{
    reminder_id: 'rem_plain', label: 'Stretch', cadence: { type: 'daily_at', daily_at: '09:30', weekdays: [] },
    cadence_text: 'Every day at 09:30', enabled: true, next_fires: both.reminders[0].next_fires,
  }]);
  assert.equal(both.reminders[0].next_fires.length, 3);
  for (const input of [{ include_reminders: 'yes', caller_session_id: PRIMARY }, { extra: 1, caller_session_id: PRIMARY }, null]) {
    assert.deepEqual(await service.list(input), { ok: false, reason: 'invalid_input' });
  }
});

test('describeChange computes the card from the normalized record and never writes', async () => {
  const { service, state, history } = harness({ reminders: [CHECK] });
  const created = await service.describeChange(CREATE);
  assert.equal(created.ok, true);
  assert.equal(created.action, 'create');
  assert.equal(created.reminder_id, null);
  assert.equal(created.before, null);
  assert.equal(created.after.label, 'Morning summary');
  assert.equal(created.after.instruction, CREATE.instruction);
  assert.equal(created.after.cadence_text, 'Weekdays at 08:00');
  assert.equal(created.after.enabled, true);
  assert.deepEqual(asMs(created.after.next_fires), [local(2026, 10, 2, 8, 0), local(2026, 10, 3, 8, 0), local(2026, 10, 4, 8, 0)]);
  const updated = await service.describeChange({
    action: 'update', reminder_id: 'rem_check', cadence: { type: 'daily_at', daily_at: '16:00', weekdays: [5] }, caller_session_id: PRIMARY,
  });
  assert.equal(updated.reminder_id, 'rem_check');
  assert.equal(updated.before.cadence_text, 'Once on 2026-11-06 at 16:00');
  assert.equal(updated.after.cadence_text, 'Fri at 16:00');
  assert.equal(updated.after.instruction, CHECK.prompt);
  const cancelled = await service.describeChange({ action: 'cancel', reminder_id: 'rem_check', caller_session_id: PRIMARY });
  assert.equal(cancelled.before.label, 'Release PR');
  assert.equal(cancelled.after, null);
  const disabled = await service.describeChange({ action: 'disable', reminder_id: 'rem_check', caller_session_id: PRIMARY });
  assert.equal(disabled.before.enabled, true);
  assert.equal(disabled.after.enabled, false);
  assert.deepEqual(disabled.after.next_fires, []);
  assert.equal(state.writes, 0);
  assert.deepEqual(history, []);
});

test('a check created, turned on or re-timed after today’s time never runs at once (it is armed)', async () => {
  const { service, state } = harness();
  const early = { ...CREATE, cadence: { type: 'daily_at', daily_at: '06:00', weekdays: [] } };
  const answer = await service.change(early);
  assert.equal(answer.ok, true);
  const stored = state.reminders[0];
  assert.equal(new Date(stored.lastFiredAt).getTime(), NOW, 'counts as fired today');
  assert.equal(asMs(answer.next_fires)[0], local(2026, 10, 3, 6, 0));
  await service.change({ action: 'disable', reminder_id: stored.id, caller_session_id: PRIMARY });
  state.reminders[0].lastFiredAt = '2026-10-01T06:00:00.000Z';
  await service.change({ action: 'enable', reminder_id: stored.id, caller_session_id: PRIMARY });
  assert.equal(new Date(state.reminders[0].lastFiredAt).getTime(), NOW);
  state.reminders[0].lastFiredAt = '2026-10-01T06:00:00.000Z';
  await service.change({ action: 'update', reminder_id: stored.id, caller_session_id: PRIMARY, label: 'Renamed' });
  assert.equal(state.reminders[0].lastFiredAt, '2026-10-01T06:00:00.000Z', 'a rename keeps the cursor');
});
