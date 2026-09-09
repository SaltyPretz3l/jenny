'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const calendarBlock = require('../renderer/chat/renderer-calendar-chat-block');
const bindings = require('../renderer/chat/renderer-calendar-chat-bindings');
const calendarRuntime = require('../renderer/features/renderer-dashboard-calendar-runtime');

const NOW = new Date(2026, 8, 7, 11, 0);

function calendarMetadata() {
  return {
    result_kind: 'home',
    calendar: {
      schema_version: 1,
      range_start: '2026-09-07T00:00',
      range_end: '2026-09-09T00:00',
      generated_at: '2026-09-07T11:00',
      instance_count: 2,
      omitted_count: 0,
      instances: [
        {
          instance_id: 'instance-live', event_id: 'event-live', title: 'Live event',
          start: '2026-09-07T12:00', end: '2026-09-07T12:30', category: 'work',
          source: 'local', source_kind: 'assistant', recent: 'created',
          journal_entry_id: 'journal-live',
        },
        {
          instance_id: 'instance-gone', event_id: 'event-gone', title: 'Gone event',
          start: '2026-09-08T13:00', end: '2026-09-08T13:30', category: 'work',
          source: 'local', source_kind: 'assistant', recent: 'created',
          journal_entry_id: 'journal-gone',
        },
      ],
    },
  };
}

function buildMarkup(metadata = calendarMetadata()) {
  return calendarBlock.buildHomeResultBlockMarkup(metadata, {
    actionButton,
    hasLiveJournalEntry: bindings.hasLiveJournalEntry,
    now: NOW,
  });
}

function buildContainer(markup = buildMarkup()) {
  const dom = new JSDOM(`<div id="timeline">${markup}</div>`);
  return { dom, container: dom.window.document.getElementById('timeline') };
}

function receiptMarkup(journalEntryId = 'journal-live') {
  return buildMarkup({
    result_kind: 'home',
    calendar_receipt: {
      schema_version: 1,
      kind: 'event',
      op: 'create',
      id: 'event-live',
      title: 'Live event',
      start: '2026-09-07T12:00',
      end: '2026-09-07T12:30',
      category: 'work',
      journal_entry_id: journalEntryId,
      journaled: true,
    },
  });
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function reset(t, dom) {
  bindings._resetForTests();
  t.after(() => {
    bindings._resetForTests();
    dom?.window.close();
  });
}

test('row and footer clicks focus Home on the selected day in order', (t) => {
  const { dom, container } = buildContainer();
  reset(t, dom);
  const calls = [];
  bindings.bindCalendarChatInteractions(container, {
    setHomeCalendarFocusDay: (key) => calls.push(['focus', key]),
    setActiveView: (view) => calls.push(['view', view]),
  });

  container.querySelector('.cal-chat__row[data-cal-open-day="2026-09-07"]').click();
  container.querySelector('.cal-chat__open-home').click();

  assert.deepEqual(calls, [
    ['focus', '2026-09-07'], ['view', 'home'],
    ['focus', '2026-09-07'], ['view', 'home'],
  ]);
});

test('invalid open-day values do not navigate', (t) => {
  const { dom, container } = buildContainer('<button data-cal-open-day="09/07/2026">Open</button>');
  reset(t, dom);
  let calls = 0;
  bindings.bindCalendarChatInteractions(container, {
    setHomeCalendarFocusDay: () => { calls += 1; },
    setActiveView: () => { calls += 1; },
  });

  container.querySelector('button').click();

  assert.equal(calls, 0);
});

test('successful Undo replaces the control with an Undone marker', async (t) => {
  const { dom, container } = buildContainer(receiptMarkup());
  reset(t, dom);
  const shell = {
    home: {
      getAiJournal: () => ({ entries: [{ id: 'journal-live', undoneAt: '', supersededAt: '' }] }),
      undoAiEntry: async () => ({ ok: true, journal: { entries: [] } }),
    },
  };
  bindings.bindCalendarChatInteractions(container, { shell });

  container.querySelector('[data-cal-undo-journal]').click();
  await flushPromises();

  assert.equal(container.querySelector('[data-cal-undo-journal]'), null);
  const marker = container.querySelector('.cal-chat__undone');
  assert.ok(marker);
  assert.equal(marker.textContent, 'Undone');
  assert.equal(bindings.hasLiveJournalEntry('journal-live'), false);
});

test('refused Undo keeps the control and renders the runtime refusal copy', async (t) => {
  const { dom, container } = buildContainer(receiptMarkup());
  reset(t, dom);
  const shell = {
    home: {
      getAiJournal: () => ({ entries: [{ id: 'journal-live' }] }),
      undoAiEntry: async () => ({ ok: false, reason: 'already_undone' }),
    },
  };
  bindings.bindCalendarChatInteractions(container, { shell, setTimeoutImpl: () => 1 });

  const undo = container.querySelector('[data-cal-undo-journal]');
  undo.click();
  await flushPromises();

  assert.equal(container.querySelector('[data-cal-undo-journal]'), undo);
  assert.match(
    container.querySelector('[data-cal-undo-refusal]').textContent,
    new RegExp(calendarRuntime.UNDO_REFUSAL_COPY.already_undone),
  );
});

test('journal snapshots gate Undo visibility and pushes refresh the live set', async (t) => {
  assert.equal(bindings.hasLiveJournalEntry('not-loaded-yet'), true);
  const { dom, container } = buildContainer();
  reset(t, dom);
  let onAiChanged;
  let unsubscribed = 0;
  const shell = {
    home: {
      getAiJournal: () => ({ entries: [{ id: 'journal-live', undoneAt: '', supersededAt: '' }] }),
      onAiChanged: (callback) => {
        onAiChanged = callback;
        return () => { unsubscribed += 1; };
      },
    },
  };
  bindings.bindCalendarChatInteractions(container, { shell });
  await flushPromises();

  assert.equal(container.querySelector('[data-cal-undo-journal="journal-live"]').hidden, false);
  assert.equal(container.querySelector('[data-cal-undo-journal="journal-gone"]').hidden, true);
  assert.equal(bindings.hasLiveJournalEntry('journal-live'), true);
  assert.equal(bindings.hasLiveJournalEntry('journal-gone'), false);

  onAiChanged({ journal: { entries: [{ id: 'journal-gone' }, { id: 'journal-live', undoneAt: 'now' }] } });
  assert.equal(container.querySelector('[data-cal-undo-journal="journal-live"]').hidden, true);
  assert.equal(container.querySelector('[data-cal-undo-journal="journal-gone"]').hidden, false);

  bindings._resetForTests();
  assert.equal(unsubscribed, 1);
});

test('a newer journal push wins over a deferred initial snapshot', async (t) => {
  const { dom, container } = buildContainer(receiptMarkup('j'));
  reset(t, dom);
  let onAiChanged;
  let resolveInitial;
  const shell = {
    home: {
      getAiJournal: () => new Promise((resolve) => { resolveInitial = resolve; }),
      onAiChanged: (callback) => { onAiChanged = callback; },
    },
  };
  bindings.bindCalendarChatInteractions(container, { shell });
  const undo = container.querySelector('[data-cal-undo-journal="j"]');

  onAiChanged({ journal: { entries: [] } });
  resolveInitial({ entries: [{ id: 'j' }] });
  await flushPromises();

  assert.equal(bindings.hasLiveJournalEntry('j'), false);
  assert.equal(undo.hidden, true);
});

test('a journal push reveals an evicted Undo using hidden as the sole gate', (t) => {
  const { dom, container } = buildContainer(
    '<button data-cal-undo-journal="j" data-cal-undo-evicted="1" hidden>Undo</button>',
  );
  reset(t, dom);
  let onAiChanged;
  const shell = { home: { onAiChanged: (callback) => { onAiChanged = callback; } } };
  bindings.bindCalendarChatInteractions(container, { shell });

  onAiChanged({ journal: { entries: [{ id: 'j' }] } });

  const undo = container.querySelector('[data-cal-undo-journal="j"]');
  assert.equal(undo.hidden, false);
  assert.equal(undo.hasAttribute('data-cal-undo-evicted'), false);
});

test('binding the same container twice attaches one click listener', (t) => {
  const { dom, container } = buildContainer();
  reset(t, dom);
  let calls = 0;
  const deps = { setActiveView: () => { calls += 1; } };
  bindings.bindCalendarChatInteractions(container, deps);
  bindings.bindCalendarChatInteractions(container, deps);

  container.querySelector('[data-cal-open-day]').click();

  assert.equal(calls, 1);
});

test('dispose removes the listener and permits a fresh binding and subscription', (t) => {
  const { dom, container } = buildContainer('<button data-cal-open-day="2026-09-07">Open</button>');
  reset(t, dom);
  let subscriptions = 0;
  let unsubscriptions = 0;
  const shell = {
    home: {
      onAiChanged: () => {
        subscriptions += 1;
        return () => { unsubscriptions += 1; };
      },
    },
  };
  const oldCalls = [];
  const dispose = bindings.bindCalendarChatInteractions(container, {
    shell,
    setHomeCalendarFocusDay: (key) => oldCalls.push(key),
    setActiveView: (view) => oldCalls.push(view),
  });

  dispose();
  dispose();
  container.querySelector('[data-cal-open-day]').click();
  assert.deepEqual(oldCalls, []);
  assert.equal(container.hasAttribute('data-calendar-chat-bound'), false);
  assert.equal(unsubscriptions, 1);

  const newCalls = [];
  bindings.bindCalendarChatInteractions(container, {
    shell,
    setHomeCalendarFocusDay: (key) => newCalls.push(key),
    setActiveView: (view) => newCalls.push(view),
  });
  container.querySelector('[data-cal-open-day]').click();
  assert.deepEqual(newCalls, ['2026-09-07', 'home']);
  assert.equal(subscriptions, 2);
});

test('missing shell and optional handlers do not throw', (t) => {
  const { dom, container } = buildContainer(receiptMarkup());
  reset(t, dom);
  let activeView = '';
  assert.doesNotThrow(() => bindings.bindCalendarChatInteractions(container, {
    setActiveView: (view) => { activeView = view; },
  }));
  assert.equal(container.dataset.calendarChatBound, '1');
  assert.doesNotThrow(() => container.querySelector('[data-cal-open-day]').click());
  assert.equal(activeView, 'home');
  assert.doesNotThrow(() => container.querySelector('[data-cal-undo-journal]').click());
});
