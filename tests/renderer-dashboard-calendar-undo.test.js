/* W6: "added by jenny" attribution, one-click undo, and the live push of
 * assistant writes onto Home.
 *
 * The full renderer app harness has no shell.calendar stub (the widget renders
 * "Calendar unavailable" there), so these drive the production agenda markup
 * and the real controller directly, the way the W5 reminder tests do.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const reminders = require('../renderer/features/renderer-dashboard-calendar-reminders.js');
const gridModule = require('../renderer/features/renderer-dashboard-calendar-grid.js');
const agendaModule = require('../renderer/features/renderer-dashboard-calendar-agenda.js');
const toolbarModule = require('../renderer/features/renderer-dashboard-calendar-toolbar.js');
const monthModule = require('../renderer/features/renderer-dashboard-calendar-month.js');
const formModule = require('../renderer/features/renderer-dashboard-calendar-form.js');
const runtimeModule = require('../renderer/features/renderer-dashboard-calendar-runtime.js');
const railModule = require('../renderer/features/renderer-dashboard-calendar-rail.js');
const { createCalendarWidget } = require('../renderer/features/renderer-dashboard-calendar.js');
const { createDashboardManager } = require('../renderer/features/renderer-dashboard-manager.js');
const dashboardRegistryModule = require('../renderer/features/renderer-dashboard-registry.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryStatusRow = require('../renderer/inventory/status-row.js');
const inventoryChip = require('../renderer/inventory/chip.js');
const inventoryPopover = require('../renderer/inventory/popover.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

const NOW = new Date(2026, 5, 11, 10, 30); // Thursday; week starts Sunday 06-07
const flush = () => new Promise((resolve) => setImmediate(resolve));

function journalEntry(overrides = {}) {
  return {
    id: 'jnl_1',
    at: '2026-06-11T09:00:00.000Z',
    entity: 'calendar_event',
    entityId: 'evt_ai',
    op: 'create',
    label: 'Dentist',
    sessionId: 'sess_1',
    inverse: { kind: 'delete', payload: null },
    postHash: '{}',
    undoneAt: '',
    supersededAt: '',
    ...overrides,
  };
}

function instance(overrides = {}) {
  return {
    instanceId: 'evt_ai:2026-06-11T14:00',
    eventId: 'evt_ai',
    readonly: false,
    title: 'Dentist',
    start: '2026-06-11T14:00',
    end: '2026-06-11T15:00',
    allDay: false,
    categoryId: 'default',
    sourceKind: 'assistant',
    sourceId: 'call_9',
    ...overrides,
  };
}

function reminderRecord(overrides = {}) {
  return {
    id: 'rem_ai',
    label: 'Call the vet',
    prompt: '',
    // once_at, not daily_at: a daily reminder places a row on all seven
    // rendered days, which would make every per-row count in here ambiguous.
    scheduleType: 'once_at',
    dailyAt: '',
    intervalMinutes: 0,
    onceAt: '2026-06-11T11:00',
    enabled: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    sourceKind: 'assistant',
    sourceId: 'call_9',
    ...overrides,
  };
}

function makeState({ instances = [instance()], reminderList = [], entries = [] } = {}) {
  return {
    ui: { activeView: 'home' },
    calendar: {
      generatedAt: '2026-06-11T10:00:00.000Z',
      windowStart: '2026-06-04T00:00',
      windowEnd: '2026-08-11T00:00',
      categories: [{ id: 'default', label: 'Default' }],
      instances,
      events: [],
      feeds: [],
    },
    proactive: { reminders: reminderList, workspaceRoot: 'G:/work', workspaceRootStatus: { state: 'ok', message: '' } },
    homeJournal: { entries },
  };
}

function createHarness({ state = makeState(), shell = { calendar: {} }, onSnapshot, onAiPayload } = {}) {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  inventoryPopover.initPopoverHandlers(dom.window.document);
  const widget = createCalendarWidget({
    shell,
    actionButton: inventoryActionButton,
    statusRow: inventoryStatusRow,
    gridModule,
    formModule,
    agendaModule,
    toolbarModule,
    monthModule,
    runtimeModule,
    railModule,
    remindersModule: reminders,
    chip: inventoryChip,
    popover: inventoryPopover,
    formPrimitives: { actionButton: inventoryActionButton, textField: inventoryTextField },
    nowProvider: () => NOW,
    appendClientLog: () => {},
    onSnapshot,
    onAiPayload,
  });
  return { dom, body, widget, state, ctx: { state, documentRef: dom.window.document } };
}

function click(dom, element) {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

// ---- pure journal projections (renderer-dashboard-calendar-reminders.js) ----

test('the journal index holds only entries the service would still accept an undo for', () => {
  const index = reminders.buildJournalIndex([
    journalEntry({ id: 'live', entityId: 'evt_live' }),
    journalEntry({ id: 'undone', entityId: 'evt_undone', undoneAt: '2026-06-11T09:30:00.000Z' }),
    journalEntry({ id: 'superseded', entityId: 'evt_super', supersededAt: '2026-06-11T09:40:00.000Z' }),
    journalEntry({ id: 'reminder', entity: 'reminder', entityId: 'rem_ai' }),
    journalEntry({ id: '', entityId: 'evt_idless' }),
    journalEntry({ id: 'no-entity', entityId: '' }),
  ]);
  assert.deepEqual([...index.keys()], ['calendar_event:evt_live', 'reminder:rem_ai']);
  assert.equal(index.get('calendar_event:evt_live').id, 'live');
  assert.deepEqual([...reminders.buildJournalIndex(null).keys()], []);
});

test('the journal digest moves when an entry is undone or superseded, not on unrelated fields', () => {
  const base = reminders.computeJournalDigest([journalEntry()]);
  assert.deepEqual(reminders.computeJournalDigest([journalEntry({ label: 'Renamed' })]), base);
  assert.notDeepEqual(reminders.computeJournalDigest([journalEntry({ undoneAt: '2026-06-11T09:30:00.000Z' })]), base);
  assert.notDeepEqual(reminders.computeJournalDigest([journalEntry({ supersededAt: 'x' })]), base);
  assert.notDeepEqual(reminders.computeJournalDigest([journalEntry({ entityId: 'other' })]), base);
  assert.deepEqual(reminders.computeJournalDigest(undefined), []);
});

test('folding an AI payload keeps the workspace-root fields the payload never carries', () => {
  const state = makeState();
  const next = reminders.foldHomeAiPayload(state, {
    journal: { entries: [journalEntry()] },
    proactive: { reminders: [reminderRecord()] },
  });
  assert.equal(next.proactive.reminders[0].id, 'rem_ai');
  assert.equal(next.proactive.workspaceRoot, 'G:/work', 'the AI channel must not blank the proactive workspace root');
  assert.deepEqual(next.proactive.workspaceRootStatus, { state: 'ok', message: '' });
  assert.equal(next.journal.entries[0].id, 'jnl_1');
  // Copies, not aliases: a later push must not mutate the caller's arrays.
  next.journal.entries[0].label = 'mutated';
  assert.equal(state.homeJournal.entries.length, 0);
});

test('a partial AI payload leaves the slice it omits untouched', () => {
  const state = makeState({ reminderList: [reminderRecord()], entries: [journalEntry()] });
  const journalOnly = reminders.foldHomeAiPayload(state, { journal: { entries: [] } });
  assert.deepEqual(journalOnly.journal.entries, []);
  assert.equal(journalOnly.proactive.reminders[0].id, 'rem_ai', 'no reminders array means keep the current one');
  const nothing = reminders.foldHomeAiPayload(state, null);
  assert.equal(nothing.journal.entries[0].id, 'jnl_1');
  assert.equal(nothing.proactive.reminders[0].id, 'rem_ai');
});

// ---- attribution chip ----

test('the jenny chip renders only for rows whose record was written by the assistant', () => {
  const { body, widget, ctx } = createHarness({
    state: makeState({
      instances: [
        instance(),
        instance({ instanceId: 'evt_mine:x', eventId: 'evt_mine', title: 'Lunch', start: '2026-06-11T12:00', end: '2026-06-11T12:30', sourceKind: '', sourceId: '' }),
      ],
      reminderList: [reminderRecord(), reminderRecord({ id: 'rem_mine', label: 'Water plants', onceAt: '2026-06-11T13:00', sourceKind: '', sourceId: '' })],
    }),
  });
  widget.render(body, ctx);

  const chipOwners = [...body.querySelectorAll('.cal-agenda__jenny')]
    .map((chip) => chip.closest('.cal-agenda__item-wrap').textContent);
  assert.equal(chipOwners.length, 2, 'exactly the two assistant-written rows carry a chip');
  assert.ok(chipOwners.some((text) => text.includes('Dentist')), 'the assistant event row is badged');
  assert.ok(chipOwners.some((text) => text.includes('Call the vet')), 'the assistant reminder row is badged');
  assert.ok(chipOwners.every((text) => !text.includes('Lunch') && !text.includes('Water plants')));
  assert.equal(body.querySelectorAll('.cal-agenda__jenny').length, 2);
});

test('the chip survives an evicted journal entry — attribution is not the undo ring', () => {
  const { body, widget, ctx } = createHarness({ state: makeState({ entries: [] }) });
  widget.render(body, ctx);
  assert.equal(body.querySelectorAll('.cal-agenda__jenny').length, 1);
  assert.equal(body.querySelector('[data-cal-undo-journal]'), null, 'no live entry, so no undo affordance');
});

// ---- undo affordance presence ----

test('the undo affordance appears only where a live journal entry names the record', () => {
  const { body, widget, ctx } = createHarness({
    state: makeState({
      instances: [
        instance(),
        instance({ instanceId: 'evt_old:x', eventId: 'evt_old', title: 'Old edit', start: '2026-06-11T16:00', end: '2026-06-11T16:30' }),
      ],
      reminderList: [reminderRecord()],
      entries: [
        journalEntry({ id: 'jnl_live', entityId: 'evt_ai' }),
        journalEntry({ id: 'jnl_done', entityId: 'evt_old', undoneAt: '2026-06-11T09:30:00.000Z' }),
        journalEntry({ id: 'jnl_super', entity: 'reminder', entityId: 'rem_ai', supersededAt: '2026-06-11T09:40:00.000Z' }),
      ],
    }),
  });
  widget.render(body, ctx);
  assert.equal(body.querySelector('[data-cal-undo-journal]').title, "Undo jenny's change to Dentist");

  const undos = [...body.querySelectorAll('[data-cal-undo-journal]')];
  assert.deepEqual(undos.map((node) => node.dataset.calUndoJournal), ['jnl_live']);
  // The undone and superseded records are still on screen — just not undoable.
  assert.match(body.textContent, /Old edit/);
  assert.match(body.textContent, /Call the vet/);
});

test('an event undo control is a sibling of the row, never nested inside that button', () => {
  const { body, widget, ctx } = createHarness({ state: makeState({ entries: [journalEntry()] }) });
  widget.render(body, ctx);
  const undo = body.querySelector('[data-cal-undo-journal]');
  assert.ok(undo, 'the assistant event row offers undo');
  assert.equal(undo.closest('[data-cal-instance]'), null, 'a button inside a button is invalid markup');
  assert.equal(undo.parentElement.className, 'cal-agenda__row-actions');
  assert.equal(undo.closest('.cal-agenda__item-wrap').querySelector('[data-cal-instance]').dataset.calEventId, 'evt_ai');
});

test('a reminder undo control lives in the reminder row actions slot', () => {
  const { body, widget, ctx } = createHarness({
    state: makeState({
      instances: [],
      reminderList: [reminderRecord()],
      entries: [journalEntry({ id: 'jnl_rem', entity: 'reminder', entityId: 'rem_ai' })],
    }),
  });
  widget.render(body, ctx);
  const undo = body.querySelector('[data-cal-undo-journal]');
  assert.equal(undo.dataset.calUndoJournal, 'jnl_rem');
  assert.equal(undo.closest('.cal-agenda__reminder-actions') !== null, true);
  assert.equal(undo.closest('[data-cal-reminder-id]').dataset.calReminderId, 'rem_ai');
});

// ---- undo round-trip ----

test('a successful undo applies the returned calendar, journal, and reminder snapshots and repaints', async () => {
  const state = makeState({ entries: [journalEntry()] });
  const asked = [];
  const restoredCalendar = {
    generatedAt: '2026-06-11T10:05:00.000Z',
    windowStart: '2026-06-04T00:00',
    windowEnd: '2026-08-11T00:00',
    categories: [{ id: 'default', label: 'Default' }],
    instances: [],
    events: [],
    feeds: [],
  };
  const { dom, body, widget, ctx } = createHarness({
    state,
    shell: {
      calendar: {},
      home: {
        undoAiEntry: async (entryId) => {
          asked.push(entryId);
          return {
            ok: true,
            entryId,
            calendar: restoredCalendar,
            journal: { entries: [journalEntry({ undoneAt: '2026-06-11T10:05:00.000Z' })] },
            proactive: { reminders: [reminderRecord({ id: 'rem_restored', label: 'Restored nudge' })] },
          };
        },
      },
    },
    onSnapshot: (payload) => { state.calendar = payload; },
    onAiPayload: (payload) => {
      const next = reminders.foldHomeAiPayload(state, payload);
      state.proactive = next.proactive;
      state.homeJournal = next.journal;
    },
  });
  widget.render(body, ctx);
  const firstKey = body.dataset.calRenderKey;
  assert.match(body.textContent, /Dentist/);

  click(dom, body.querySelector('[data-cal-undo-journal]'));
  await flush();

  assert.deepEqual(asked, ['jnl_1'], 'the clicked entry id reaches the bridge exactly once');
  assert.equal(state.calendar.instances.length, 0, 'the returned calendar snapshot replaced the slice');
  assert.equal(state.homeJournal.entries[0].undoneAt, '2026-06-11T10:05:00.000Z');
  assert.equal(state.proactive.reminders[0].id, 'rem_restored');
  assert.equal(state.proactive.workspaceRoot, 'G:/work', 'the undo apply path preserves the workspace root');
  assert.notEqual(body.dataset.calRenderKey, firstKey, 'the widget repainted off the applied snapshots');
  assert.doesNotMatch(body.textContent, /Dentist/, 'the undone event is gone from the agenda');
  assert.equal(body.querySelector('[data-cal-undo-journal]'), null);
  assert.match(body.textContent, /Restored nudge/);
});

test('undoing a reminder entry repaints the agenda from the returned reminder list alone', async () => {
  const state = makeState({
    instances: [],
    reminderList: [reminderRecord()],
    entries: [journalEntry({ id: 'jnl_rem', entity: 'reminder', entityId: 'rem_ai', op: 'create' })],
  });
  const { dom, body, widget, ctx } = createHarness({
    state,
    shell: {
      calendar: {},
      home: {
        undoAiEntry: async () => ({
          ok: true,
          entryId: 'jnl_rem',
          journal: { entries: [] },
          proactive: { reminders: [] },
        }),
      },
    },
    onSnapshot: (payload) => { state.calendar = payload; },
    onAiPayload: (payload) => {
      const next = reminders.foldHomeAiPayload(state, payload);
      state.proactive = next.proactive;
      state.homeJournal = next.journal;
    },
  });
  widget.render(body, ctx);
  assert.match(body.textContent, /Call the vet/);

  click(dom, body.querySelector('[data-cal-undo-journal]'));
  await flush();

  assert.doesNotMatch(body.textContent, /Call the vet/);
  assert.deepEqual(state.homeJournal.entries, []);
});

// ---- refusals ----

const REFUSALS = [
  ['entry_not_found', /no longer in the undo list/],
  ['already_undone', /already undone/],
  ['superseded', /jenny changed this again since/],
  ['changed_since', /you've edited this since — nothing to undo/],
];

for (const [reason, copy] of REFUSALS) {
  test(`a ${reason} refusal writes its note beside the row and mutates nothing`, async () => {
    const state = makeState({ entries: [journalEntry()] });
    const applied = [];
    const { dom, body, widget, ctx } = createHarness({
      state,
      shell: { calendar: {}, home: { undoAiEntry: async () => ({ ok: false, reason }) } },
      onSnapshot: (payload) => applied.push(['calendar', payload]),
      onAiPayload: (payload) => applied.push(['ai', payload]),
    });
    widget.render(body, ctx);
    const keyBefore = body.dataset.calRenderKey;
    const undo = body.querySelector('[data-cal-undo-journal]');

    click(dom, undo);
    await flush();

    const note = body.querySelector('.cal-agenda__undo-note');
    assert.ok(note, 'the refusal is reported inline');
    assert.equal(note.dataset.calUndoRefusal, reason);
    assert.match(note.textContent, copy);
    assert.equal(note.getAttribute('role'), 'status');
    assert.equal(note.closest('.cal-agenda__item-wrap').querySelector('[data-cal-event-id]').dataset.calEventId, 'evt_ai');
    assert.deepEqual(applied, [], 'a refusal applies no snapshot');
    assert.equal(state.calendar.instances.length, 1, 'nothing was removed from the calendar slice');
    assert.equal(state.homeJournal.entries[0].undoneAt, '', 'the entry stays live');
    assert.equal(body.dataset.calRenderKey, keyBefore, 'a refusal never rebuilds the widget');
    assert.ok(body.querySelector('[data-cal-undo-journal]'), 'the affordance stays for a retry');
  });
}

test('a rejected undo round-trip is logged and reported, never silently swallowed', async () => {
  const logged = [];
  const state = makeState({ entries: [journalEntry()] });
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  inventoryPopover.initPopoverHandlers(dom.window.document);
  const widget = createCalendarWidget({
    shell: { calendar: {}, home: { undoAiEntry: async () => { throw new Error('bridge is gone'); } } },
    actionButton: inventoryActionButton,
    statusRow: inventoryStatusRow,
    gridModule,
    formModule,
    agendaModule,
    toolbarModule,
    monthModule,
    runtimeModule,
    railModule,
    remindersModule: reminders,
    chip: inventoryChip,
    popover: inventoryPopover,
    formPrimitives: { actionButton: inventoryActionButton, textField: inventoryTextField },
    nowProvider: () => NOW,
    appendClientLog: (level, code, detail) => logged.push([level, code, detail]),
  });
  const ctx = { state, documentRef: dom.window.document };
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-undo-journal]'));
  await flush();

  assert.equal(body.querySelector('.cal-agenda__undo-note').dataset.calUndoRefusal, 'failed');
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].slice(0, 2), ['WARN', 'home.calendar_undo_failed']);
  assert.match(logged[0][2].message, /bridge is gone/);
});

test('a second refusal replaces the first note rather than stacking them', async () => {
  const state = makeState({ entries: [journalEntry()] });
  const { dom, body, widget, ctx } = createHarness({
    state,
    shell: { calendar: {}, home: { undoAiEntry: async () => ({ ok: false, reason: 'changed_since' }) } },
  });
  widget.render(body, ctx);
  click(dom, body.querySelector('[data-cal-undo-journal]'));
  await flush();
  click(dom, body.querySelector('[data-cal-undo-journal]'));
  await flush();
  assert.equal(body.querySelectorAll('.cal-agenda__undo-note').length, 1);
});

// ---- render key ----

test('flipping undoneAt on a journal entry rebuilds the widget instead of stranding the button', () => {
  const state = makeState({ entries: [journalEntry()] });
  const { body, widget, ctx } = createHarness({ state });
  widget.render(body, ctx);
  const firstKey = body.dataset.calRenderKey;
  assert.ok(body.querySelector('[data-cal-undo-journal]'), 'the live entry offers undo');

  // Only the journal moves: no calendar, reminder, or UI change accompanies it,
  // so a render key without a journal contribution would take the skip path and
  // leave a button the service now refuses.
  state.homeJournal = { entries: [journalEntry({ undoneAt: '2026-06-11T10:05:00.000Z' })] };
  widget.render(body, ctx);

  assert.notEqual(body.dataset.calRenderKey, firstKey, 'the journal is part of the render key');
  assert.equal(body.querySelector('[data-cal-undo-journal]'), null, 'the dead affordance is gone from the DOM');
  assert.match(body.textContent, /Dentist/, 'the event itself is untouched');
});

test('the render key ignores journal churn that changes no undo affordance', () => {
  const state = makeState({ entries: [journalEntry()] });
  const { body, widget, ctx } = createHarness({ state });
  widget.render(body, ctx);
  const firstKey = body.dataset.calRenderKey;
  state.homeJournal = { entries: [journalEntry({ label: 'Renamed in the journal only' })] };
  widget.render(body, ctx);
  assert.equal(body.dataset.calRenderKey, firstKey);
});

// ---- the onAiChanged push (the only channel reminders have) ----

function createManagerHarness(t) {
  const dom = new JSDOM('<div id="grid"></div><div id="strip"></div>');
  const documentRef = dom.window.document;
  const grid = documentRef.getElementById('grid');
  inventoryPopover.initPopoverHandlers(documentRef);
  const listeners = { ai: [], calendar: [] };
  const shell = {
    calendar: { getState: async () => null, onChanged: (cb) => { listeners.calendar.push(cb); return () => {}; } },
    home: {
      getAiJournal: async () => ({ entries: [] }),
      onAiChanged: (cb) => { listeners.ai.push(cb); return () => { listeners.ai.length = 0; }; },
    },
  };
  const state = { ui: { activeView: 'home' } };
  const manager = createDashboardManager({
    state,
    documentRef,
    shell,
    dom: { homeDashboardGrid: grid, homeInfoStrip: documentRef.getElementById('strip') },
    modules: { dashboardRegistry: dashboardRegistryModule, dashboardCalendarReminders: reminders },
    callbacks: { appendClientLog: () => {} },
  });
  t.after(() => manager.dispose());
  return {
    dom, documentRef, grid, shell, state, manager, listeners,
  };
}

test('an onAiChanged push lands a new assistant reminder in the agenda with no manual refresh', async (t) => {
  const {
    dom, grid, state, manager, listeners,
  } = createManagerHarness(t);
  const widget = createCalendarWidget({
    shell: { calendar: {} },
    actionButton: inventoryActionButton,
    statusRow: inventoryStatusRow,
    gridModule,
    formModule,
    agendaModule,
    toolbarModule,
    monthModule,
    runtimeModule,
    railModule,
    remindersModule: reminders,
    chip: inventoryChip,
    popover: inventoryPopover,
    formPrimitives: { actionButton: inventoryActionButton, textField: inventoryTextField },
    nowProvider: () => NOW,
    appendClientLog: () => {},
  });
  manager.registry.register({ id: 'calendar', title: 'Calendar', render: widget.render });
  assert.deepEqual(state.homeJournal, { entries: [] }, 'the journal slice is seeded before any fetch');

  manager.bind();
  manager.render();
  await flush();
  const paneBefore = grid.querySelector('.dashboard-card__body');
  assert.doesNotMatch(paneBefore.textContent, /Call the vet/);
  assert.equal(listeners.ai.length, 1, 'bind subscribes to the AI push exactly once');

  listeners.ai[0]({
    journal: { entries: [journalEntry({ id: 'jnl_push', entity: 'reminder', entityId: 'rem_ai' })] },
    proactive: { reminders: [reminderRecord()] },
  });

  const pane = grid.querySelector('.dashboard-card__body');
  assert.match(pane.textContent, /Call the vet/, 'the pushed reminder is on screen without a refresh');
  assert.equal(pane.querySelector('.cal-agenda__jenny') !== null, true, 'it arrives badged');
  const undo = pane.querySelector('[data-cal-undo-journal]');
  assert.equal(undo.dataset.calUndoJournal, 'jnl_push');
  assert.equal(state.homeJournal.entries[0].id, 'jnl_push');
  // The push carries no workspace root; folding it must not blank the one the
  // proactive channel owns.
  assert.equal(state.proactive.workspaceRoot, '');
  assert.equal(state.proactive.reminders[0].id, 'rem_ai');
  assert.ok(dom.window.document.contains(grid));
});

test('the prime refresh reads the journal over its own source and seeds the slice', async (t) => {
  const harness = createManagerHarness(t);
  harness.shell.home.getAiJournal = async () => ({ entries: [journalEntry({ id: 'jnl_primed' })] });
  harness.manager.registry.register({ id: 'probe', render: () => {} });

  await harness.manager.refreshDashboardState();

  assert.equal(harness.state.homeJournal.entries[0].id, 'jnl_primed');
});

test('a failing getAiJournal leaves the seeded slice intact instead of throwing', async (t) => {
  const harness = createManagerHarness(t);
  harness.shell.home.getAiJournal = async () => { throw new Error('no bridge'); };
  harness.manager.registry.register({ id: 'probe', render: () => {} });

  await harness.manager.refreshDashboardState();

  assert.deepEqual(harness.state.homeJournal, { entries: [] });
});
