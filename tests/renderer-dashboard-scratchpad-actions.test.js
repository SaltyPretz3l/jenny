const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScratchpadActions } = require('../renderer/features/renderer-dashboard-scratchpad-actions.js');
const { createScratchpadWidget } = require('../renderer/features/renderer-dashboard-widgets-scratchpad.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const scratchpadMarkdown = require('../renderer/features/renderer-dashboard-scratchpad-markdown.js');
const { scratch, twoNotesActive, flagOnCtx } = require('./helpers/scratchpad-fixtures.js');

const FIXED_NOW = new Date(2026, 5, 11, 10, 0);

function createTimerStub() {
  const timers = [];
  return {
    timers,
    setTimeoutImpl: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    },
    async fire() {
      for (const timer of timers.splice(0)) {
        if (!timer.cleared) {
          timer.fn();
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

// Pass `getScratchpad` to echo the MERGED config: scratchpadEchoMatches() rejects
// an acknowledgement missing notes/activeNoteId/settings/pins, so a bare pointer
// echo reads as a FAILED write. See hyg-W7 / W7e-18-F01.
function createShellStub(getScratchpad) {
  const calls = { updates: [], followUps: [] };
  return {
    calls,
    shell: {
      home: {
        updateConfig: async (patch) => {
          calls.updates.push(patch);
          const base = (getScratchpad && getScratchpad()) || {};
          return {
            links: [], weather: {}, widgets: {}, calendar: {}, focusMode: false, showContextualTips: true,
            scratchpad: { ...base, ...patch.scratchpad, pins: patch.scratchpad?.pins || base.pins || [] },
          };
        },
      },
      companion: {
        addFollowUp: async (payload) => {
          calls.followUps.push(payload);
          return { openLoopsBoard: { counts: { active: 1 } } };
        },
      },
    },
  };
}

test('queueSave debounces: bursts collapse into one updateConfig write', async () => {
  const { shell, calls } = createShellStub();
  const timers = createTimerStub();
  const configs = [];
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => scratch(''),
    onHomeConfig: (config) => configs.push(config),
    nowProvider: () => FIXED_NOW,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  actions.queueSave('a');
  actions.queueSave('ab');
  actions.queueSave('abc');
  await timers.fire();

  assert.equal(calls.updates.length, 1);
  // The whole notes array is rewritten; the active note carries the new text.
  assert.equal(calls.updates[0].scratchpad.notes[0].text, 'abc');
  assert.equal(calls.updates[0].scratchpad.notes[0].updatedAt, FIXED_NOW.toISOString());
  assert.equal(calls.updates[0].scratchpad.activeNoteId, 'note-1');
  assert.equal(configs.length, 1);
});

test('queueSave rejects a partial Home acknowledgement and retains the prior scratchpad', async () => {
  const timers = createTimerStub();
  const prior = scratch('before');
  const adopted = [];
  const logs = [];
  const actions = createScratchpadActions({
    shell: { home: { updateConfig: async (patch) => ({ scratchpad: patch.scratchpad }) } },
    getScratchpad: () => prior,
    onHomeConfig: (config) => adopted.push(config),
    appendClientLog: (level, event) => logs.push([level, event]),
    nowProvider: () => FIXED_NOW,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  actions.queueSave('after');
  await timers.fire();

  assert.equal(adopted.length, 0);
  assert.equal(prior.notes[0].text, 'before');
  assert.deepEqual(logs, [['WARN', 'home.scratchpad_save_failed']]);
});

test('pointer-only Scratchpad acknowledgement rejects sibling note content loss', async () => {
  const currentHome = {
    links: [{ id: 'docs', name: 'Docs', tiles: [] }],
    weather: { city: 'Chicago' },
    widgets: { order: [], hidden: [] },
    scratchpad: twoNotesActive('note-1'),
    calendar: { feeds: [] },
    focusMode: false,
    showContextualTips: true,
  };
  const adopted = [];
  const logs = [];
  const actions = createScratchpadActions({
    shell: { home: { updateConfig: async () => ({
      ...currentHome,
      scratchpad: {
        ...currentHome.scratchpad,
        activeNoteId: 'note-2',
        notes: currentHome.scratchpad.notes.map((note) => ({ id: note.id })),
      },
    }) } },
    getScratchpad: () => currentHome.scratchpad,
    getHomeConfig: () => currentHome,
    onHomeConfig: (config) => adopted.push(config),
    appendClientLog: (level, event) => logs.push([level, event]),
    nowProvider: () => FIXED_NOW,
  });

  await actions.setActiveNote('note-2');

  assert.equal(adopted.length, 0);
  assert.equal(currentHome.scratchpad.notes[0].text, 'A');
  assert.equal(currentHome.scratchpad.notes[1].text, 'B');
  assert.deepEqual(logs, [['WARN', 'home.scratchpad_save_failed']]);
});

test('queueSave rewrites the whole notes array, updating only the active (non-first) note', async () => {
  const { shell, calls } = createShellStub();
  const timers = createTimerStub();
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => ({
      notes: [
        { id: 'note-1', title: 'One', text: 'keep me', updatedAt: '2026-06-10T09:00:00.000Z', appendLog: false },
        { id: 'note-2', title: 'Two', text: 'old', updatedAt: '', appendLog: false },
      ],
      activeNoteId: 'note-2',
      settings: { rows: 6, font: 'prose', captureMode: 'overwrite' },
    }),
    nowProvider: () => FIXED_NOW,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  actions.queueSave('fresh');
  await timers.fire();

  assert.equal(calls.updates.length, 1);
  const written = calls.updates[0].scratchpad;
  // The WHOLE array is rewritten — the sibling note is preserved, not dropped
  // (the section-merge replaces the notes array wholesale; a single-note delta
  // would silently lose note-1).
  assert.equal(written.notes.length, 2);
  // The non-active first note is byte-identical (untouched text + timestamp).
  assert.equal(written.notes[0].text, 'keep me');
  assert.equal(written.notes[0].updatedAt, '2026-06-10T09:00:00.000Z');
  // Only the active (second) note receives the new text + a fresh stamp.
  assert.equal(written.notes[1].text, 'fresh');
  assert.equal(written.notes[1].updatedAt, FIXED_NOW.toISOString());
  assert.equal(written.activeNoteId, 'note-2');
  assert.deepEqual(written.settings, { rows: 6, font: 'prose', captureMode: 'overwrite' });
});

test('promoteToLoop flushes pending saves and posts a manual follow-up', async () => {
  const { shell, calls } = createShellStub();
  const timers = createTimerStub();
  const companionPayloads = [];
  const actions = createScratchpadActions({
    shell,
    applyCompanionPayload: (payload) => companionPayloads.push(payload),
    nowProvider: () => FIXED_NOW,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  actions.queueSave('Ship the calendar\nthen write the release notes');
  const result = await actions.promoteToLoop('Ship the calendar\nthen write the release notes');

  assert.deepEqual(result, { ok: true });
  // The pending debounced save flushed before promotion (no timer fire needed).
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.followUps.length, 1);
  assert.equal(calls.followUps[0].label, 'Ship the calendar');
  assert.equal(calls.followUps[0].body, 'Ship the calendar\nthen write the release notes');
  assert.equal(calls.followUps[0].sourceKind, 'manual');
  assert.equal(calls.followUps[0].status, 'active');
  assert.equal(companionPayloads.length, 1);
});

test('promoteToLoop clips long first lines and rejects empty pads', async () => {
  const { shell, calls } = createShellStub();
  const actions = createScratchpadActions({ shell, nowProvider: () => FIXED_NOW });

  const empty = await actions.promoteToLoop('   \n  ');
  assert.match(empty.error, /Write something/);
  assert.equal(calls.followUps.length, 0);

  const long = 'x'.repeat(200);
  await actions.promoteToLoop(long);
  assert.equal(calls.followUps[0].label.length, 120);
  assert.match(calls.followUps[0].label, /\.\.\.$/);
});

test('scratchpad widget builds once, syncs unfocused value, and never clobbers typing', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: null,
  });

  widget.render(body, { state: { homeConfig: { scratchpad: scratch('first') } } });
  const textarea = body.querySelector('#homeScratchpadInput');
  assert.equal(textarea.value, 'first');

  // Unfocused repaint with new state syncs the value (same DOM node).
  widget.render(body, { state: { homeConfig: { scratchpad: scratch('second') } } });
  assert.equal(body.querySelector('#homeScratchpadInput'), textarea);
  assert.equal(textarea.value, 'second');

  // Focused repaint must not clobber in-progress typing.
  textarea.focus();
  textarea.value = 'typing in progress';
  widget.render(body, { state: { homeConfig: { scratchpad: scratch('stale save') } } });
  assert.equal(textarea.value, 'typing in progress');
});

test('scratchpad widget renders the active note, not just the first, and falls back on a dangling id', () => {
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: null,
  });
  const twoNotes = (activeNoteId) => ({
    notes: [
      { id: 'note-1', title: 'One', text: 'A', updatedAt: '', appendLog: false },
      { id: 'note-2', title: 'Two', text: 'B', updatedAt: '', appendLog: false },
    ],
    activeNoteId,
    settings: { rows: 6, font: 'prose', captureMode: 'overwrite' },
  });

  // The active note is the SECOND one -> the textarea must show 'B', not 'A'.
  const active = new JSDOM('<section id="body"></section>').window.document.getElementById('body');
  widget.render(active, { state: { homeConfig: { scratchpad: twoNotes('note-2') } } });
  assert.equal(active.querySelector('#homeScratchpadInput').value, 'B');

  // A dangling activeNoteId falls back to the first note's text.
  const dangling = new JSDOM('<section id="body"></section>').window.document.getElementById('body');
  widget.render(dangling, { state: { homeConfig: { scratchpad: twoNotes('ghost') } } });
  assert.equal(dangling.querySelector('#homeScratchpadInput').value, 'A');
});

test('scratchpad widget wires input to queueSave and the loop button to promote', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const seen = { saved: [], promoted: [] };
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: {
      queueSave: (text) => seen.saved.push(text),
      promoteToLoop: async (text) => {
        seen.promoted.push(text);
        return { ok: true };
      },
    },
  });

  widget.render(body, { state: { homeConfig: { scratchpad: scratch('') } } });
  const textarea = body.querySelector('#homeScratchpadInput');
  textarea.value = 'note';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.deepEqual(seen.saved, ['note']);

  body.querySelector('[data-scratchpad-to-loop]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen.promoted, ['note']);
  assert.match(body.querySelector('[data-scratchpad-note]').textContent, /Saved to Open Loops\./);
});

// ---- Phase 2: note CRUD, race-safe saves, and routing --------------------

function mutableState(notes, activeNoteId, settings) {
  return {
    notes,
    activeNoteId,
    settings: settings || { rows: 6, font: 'prose', captureMode: 'overwrite' },
  };
}

test('setActiveNote flushes the outgoing note then persists a pointer-only switch', async () => {
  let state;
  const { shell, calls } = createShellStub(() => state);
  const timers = createTimerStub();
  state = mutableState(
    [
      { id: 'note-1', title: 'One', text: '', updatedAt: '', appendLog: false },
      { id: 'note-2', title: 'Two', text: '', updatedAt: '', appendLog: false },
    ],
    'note-1'
  );
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => state,
    nowProvider: () => FIXED_NOW,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  actions.queueSave('draft in one', 'note-1');
  const result = await actions.setActiveNote('note-2');

  assert.deepEqual(result, { ok: true }, 'calls.updates records what was SENT, not the outcome');
  // The flush carried the in-flight text to note-1 (the OUTGOING note)...
  assert.equal(calls.updates[0].scratchpad.notes[0].id, 'note-1');
  assert.equal(calls.updates[0].scratchpad.notes[0].text, 'draft in one');
  // ...then a pointer-only patch (no notes key) switched the active note.
  assert.equal(calls.updates[1].scratchpad.activeNoteId, 'note-2');
  assert.ok(!('notes' in calls.updates[1].scratchpad));
});

test('queueSave pins the save to the note active at keystroke time, not at fire time', async () => {
  const { shell, calls } = createShellStub();
  const timers = createTimerStub();
  const state = mutableState(
    [
      { id: 'note-1', title: 'One', text: 'a', updatedAt: '', appendLog: false },
      { id: 'note-2', title: 'Two', text: 'b', updatedAt: '', appendLog: false },
    ],
    'note-1'
  );
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => state,
    nowProvider: () => FIXED_NOW,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  actions.queueSave('edited one', 'note-1');
  // The user switches notes (config active flips) before the debounce fires.
  state.activeNoteId = 'note-2';
  await timers.fire();

  const written = calls.updates[0].scratchpad;
  assert.equal(written.notes[0].text, 'edited one'); // landed in note-1, the edited note
  assert.equal(written.notes[1].text, 'b'); // note-2 untouched
});

test('addNote appends an active empty note and caps at the maximum', async () => {
  const { shell, calls } = createShellStub();
  let state = mutableState([{ id: 'note-1', title: 'One', text: '', updatedAt: '', appendLog: false }], 'note-1');
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => state,
    nowProvider: () => FIXED_NOW,
    onHomeConfig: (config) => { state = config.scratchpad; },
  });

  const first = await actions.addNote();
  assert.equal(first.ok, true);
  assert.equal(first.activeNoteId, 'note-2');
  assert.equal(calls.updates[0].scratchpad.notes.length, 2);

  for (let i = 0; i < 6; i += 1) {
    await actions.addNote();
  }
  assert.equal(state.notes.length, 8);
  const capped = await actions.addNote();
  assert.match(capped.error, /Up to 8/);
});

test('deleteNote drops a note, reassigns a neighbor for the active one, and refuses the last', async () => {
  const { shell } = createShellStub();
  let state = mutableState(
    [
      { id: 'note-1', title: '1', text: '', updatedAt: '', appendLog: false },
      { id: 'note-2', title: '2', text: '', updatedAt: '', appendLog: false },
      { id: 'note-3', title: '3', text: '', updatedAt: '', appendLog: false },
    ],
    'note-2'
  );
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => state,
    nowProvider: () => FIXED_NOW,
    onHomeConfig: (config) => { state = config.scratchpad; },
  });

  const result = await actions.deleteNote('note-2');
  assert.equal(result.ok, true);
  assert.equal(result.activeNoteId, 'note-3'); // the note that slid into the freed slot
  assert.deepEqual(state.notes.map((n) => n.id), ['note-1', 'note-3']);

  await actions.deleteNote('note-1');
  const last = await actions.deleteNote('note-3');
  assert.match(last.error, /Keep at least one/);
});

test('renameNote changes only the title and preserves the id', async () => {
  const { shell, calls } = createShellStub();
  const state = mutableState([{ id: 'note-1', title: 'Note 1', text: 'keep', updatedAt: '', appendLog: false }], 'note-1');
  const actions = createScratchpadActions({ shell, getScratchpad: () => state, nowProvider: () => FIXED_NOW });

  await actions.renameNote('note-1', '  Ideas  ');
  const written = calls.updates[0].scratchpad.notes[0];
  assert.equal(written.id, 'note-1');
  assert.equal(written.title, 'Ideas');
  assert.equal(written.text, 'keep');
});

test('saveToFile writes a slugged path under .jenny/notes and maps a missing root to a hint', async () => {
  const writes = [];
  const actions = createScratchpadActions({
    shell: { workspaceFs: { writeFile: async (payload) => { writes.push(payload); return { mtimeMs: 1 }; } } },
    nowProvider: () => FIXED_NOW,
  });
  const ok = await actions.saveToFile('My Ideas!', 'body');
  assert.equal(ok.path, '.jenny/notes/my-ideas.md');
  assert.deepEqual(writes[0], { path: '.jenny/notes/my-ideas.md', content: 'body' });

  const failing = createScratchpadActions({
    shell: {
      workspaceFs: {
        writeFile: async () => {
          const error = new Error('No workspace root is configured.');
          error.code = 'ROOT_MISSING';
          throw error;
        },
      },
    },
    nowProvider: () => FIXED_NOW,
  });
  const miss = await failing.saveToFile('x', 'body');
  assert.match(miss.error, /Open a workspace folder/);
});

test('createCalendarEvent builds an all-day payload from the note and echoes the snapshot', async () => {
  const created = [];
  let snapshot = null;
  const actions = createScratchpadActions({
    shell: { calendar: { createEvent: async (payload) => { created.push(payload); return { events: [] }; } } },
    nowProvider: () => FIXED_NOW,
    onCalendarSnapshot: (snap) => { snapshot = snap; },
  });

  const result = await actions.createCalendarEvent('Ship release\nnotes line\nmore');
  assert.equal(result.ok, true);
  assert.equal(created[0].title, 'Ship release');
  assert.equal(created[0].notes, 'notes line\nmore');
  assert.equal(created[0].allDay, true);
  assert.match(created[0].start, /^\d{4}-\d{2}-\d{2}T00:00$/);
  assert.ok(snapshot);
});

test('sendToChat delegates to the injected impl and guards empty / unavailable', () => {
  const sent = [];
  const actions = createScratchpadActions({ shell: {}, sendToChat: (text) => { sent.push(text); return true; } });
  assert.deepEqual(actions.sendToChat('   '), { error: 'Write something first.' });
  assert.deepEqual(actions.sendToChat('hello'), { ok: true });
  assert.deepEqual(sent, ['hello']);

  const noImpl = createScratchpadActions({ shell: {} });
  assert.match(noImpl.sendToChat('x').error, /unavailable/);
});

test('canSaveFile reflects whether a workspace folder is open', async () => {
  const open = createScratchpadActions({
    shell: { workspaceFs: { getRootState: async () => ({ workspaceRoot: 'G:/x' }), writeFile: async () => ({}) } },
  });
  assert.equal(await open.canSaveFile(), true);

  const closed = createScratchpadActions({
    shell: { workspaceFs: { getRootState: async () => ({ workspaceRoot: '' }), writeFile: async () => ({}) } },
  });
  assert.equal(await closed.canSaveFile(), false);

  const none = createScratchpadActions({ shell: {} });
  assert.equal(await none.canSaveFile(), false);
});

test('flag-on scratchpad renders a tab per note and binds the active one to the textarea', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: null,
  });

  widget.render(body, flagOnCtx(twoNotesActive('note-2')));
  assert.equal(body.querySelectorAll('[data-scratchpad-tab]').length, 2);
  assert.equal(body.querySelector('[data-scratchpad-tab="note-2"]').getAttribute('aria-selected'), 'true');
  assert.equal(body.querySelector('#homeScratchpadInput').value, 'B');
  assert.ok(body.querySelector('[data-scratchpad-add]'));
  assert.ok(body.querySelector('[data-scratchpad-actions]'));
});

test('flag-on input routes typing to queueSave with the active note id', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const saved = [];
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: { queueSave: (text, id) => saved.push([text, id]) },
  });

  widget.render(body, flagOnCtx(twoNotesActive('note-2')));
  const textarea = body.querySelector('#homeScratchpadInput');
  textarea.value = 'typed';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.deepEqual(saved, [['typed', 'note-2']]);
});

test('clicking a tab optimistically shows that note and calls setActiveNote', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const switched = [];
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: { setActiveNote: async (id) => { switched.push(id); return { ok: true }; } },
  });

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  assert.equal(body.querySelector('#homeScratchpadInput').value, 'A');
  body.querySelector('[data-scratchpad-tab="note-2"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(body.querySelector('#homeScratchpadInput').value, 'B'); // optimistic
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(switched, ['note-2']);
});

test('clicking + calls addNote', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  let added = 0;
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: { addNote: async () => { added += 1; return { ok: true, activeNoteId: 'note-2' }; } },
  });

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  body.querySelector('[data-scratchpad-add]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(added, 1);
});

test('flag-on shows the near-cap counter and a relative saved time', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const now = new Date(2026, 5, 11, 10, 5);
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: null,
    nowProvider: () => now,
  });
  const scratchpad = {
    notes: [{
      id: 'note-1',
      title: 'One',
      text: 'x'.repeat(3700),
      updatedAt: new Date(2026, 5, 11, 10, 0).toISOString(),
      appendLog: false,
    }],
    activeNoteId: 'note-1',
    settings: { rows: 6, font: 'prose', captureMode: 'overwrite' },
  };

  widget.render(body, flagOnCtx(scratchpad));
  assert.match(body.querySelector('[data-scratchpad-count]').textContent, /3700\/4000/);
  assert.match(body.querySelector('[data-scratchpad-meta]').textContent, /Saved · 5m ago/);
});

test('the ⋯ button opens the actions menu through the injected context menu', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const shown = [];
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: { canSaveFile: async () => true },
    contextMenu: { show: (opts) => shown.push(opts) },
    menuModule: { buildScratchpadMenu: (opts) => [{ label: `save:${opts.canSaveFile}`, action() {} }] },
  });

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  body.querySelector('[data-scratchpad-actions]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 5, clientY: 6 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].anchorX, 5);
  assert.equal(shown[0].items[0].label, 'save:true');
});

test('addNote re-renders so the new note is selected even after a prior optimistic tab switch', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: {
      setActiveNote: async () => ({ ok: true }),
      // The new note's id (an existing fixture id keeps lastScratchpad valid).
      addNote: async () => ({ ok: true, activeNoteId: 'note-1' }),
    },
  });

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  // Optimistically switch to note-2 (sets localActiveId = note-2).
  body.querySelector('[data-scratchpad-tab="note-2"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(body.querySelector('[data-scratchpad-tab="note-2"]').getAttribute('aria-selected'), 'true');

  // Add a note that becomes active note-1; the strip must reflect note-1, not the
  // stale optimistic note-2 (regression: the .then re-renders immediately).
  body.querySelector('[data-scratchpad-add]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(body.querySelector('[data-scratchpad-tab="note-1"]').getAttribute('aria-selected'), 'true');
  assert.equal(body.querySelector('[data-scratchpad-tab="note-2"]').getAttribute('aria-selected'), 'false');
});

test('dispose flushes pending text instead of dropping it on teardown', async () => {
  const { shell, calls } = createShellStub();
  const timers = createTimerStub();
  const state = mutableState([{ id: 'note-1', title: 'One', text: '', updatedAt: '', appendLog: false }], 'note-1');
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => state,
    nowProvider: () => FIXED_NOW,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  actions.queueSave('unsaved tail', 'note-1');
  actions.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].scratchpad.notes[0].text, 'unsaved tail');
});

test('inline rename ignores focus moving into the shared context menu but commits elsewhere', async () => {
  const dom = new JSDOM('<section id="body"></section>'); const body = dom.window.document.getElementById('body');
  const renamed = [];
  const widget = createScratchpadWidget({
    textField: inventoryTextField, actionButton: inventoryActionButton,
    actions: { renameNote: async (id, title) => { renamed.push([id, title]); return { ok: true }; } },
  });
  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  body.querySelector('[data-scratchpad-tab="note-1"]')
    .dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const input = body.querySelector('#homeScratchpadRename');
  input.value = 'Corrected title';
  dom.window.document.body.insertAdjacentHTML('beforeend', '<div class="inv-context-menu"><button id="menuItem"></button></div><button id="elsewhere"></button>');
  const focusout = (relatedTarget) => input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true, relatedTarget }));
  focusout(dom.window.document.getElementById('menuItem'));
  assert.deepEqual(renamed, []); assert.equal(body.querySelector('#homeScratchpadRename'), input);
  focusout(dom.window.document.getElementById('elsewhere'));
  assert.deepEqual(renamed, [['note-1', 'Corrected title']]); assert.equal(body.querySelector('#homeScratchpadRename'), null);
});

// ── Phase 3: captureToScratchpad (the /note + Ctrl+Shift+Space entry point) ──

test('captureToScratchpad appends a timestamped line to the active note', async () => {
  const { shell, calls } = createShellStub();
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => scratch('existing'),
    nowProvider: () => FIXED_NOW, // 2026-06-11 10:00 local
  });

  const result = await actions.captureToScratchpad('buy milk');

  assert.deepEqual(result, { ok: true, noteTitle: 'Note 1' });
  assert.equal(calls.updates.length, 1);
  const written = calls.updates[0].scratchpad;
  assert.equal(written.notes[0].text, 'existing\n[10:00] buy milk');
  assert.equal(written.notes[0].updatedAt, FIXED_NOW.toISOString());
  assert.equal(written.activeNoteId, 'note-1');
});

test('captureToScratchpad on an empty note omits the leading newline and trims the body', async () => {
  const { shell, calls } = createShellStub();
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => scratch(''),
    nowProvider: () => FIXED_NOW,
  });

  const result = await actions.captureToScratchpad('  first thought  ');

  assert.equal(result.ok, true);
  assert.equal(calls.updates[0].scratchpad.notes[0].text, '[10:00] first thought');
});

test('captureToScratchpad overwrite mode replaces the note contents', async () => {
  const { shell, calls } = createShellStub();
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => scratch('old stuff'),
    nowProvider: () => FIXED_NOW,
  });

  await actions.captureToScratchpad('replace it', { mode: 'overwrite' });

  assert.equal(calls.updates[0].scratchpad.notes[0].text, '[10:00] replace it');
});

test('captureToScratchpad honors settings.captureMode = overwrite as the default mode', async () => {
  const { shell, calls } = createShellStub();
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => ({
      notes: [{ id: 'note-1', title: 'Note 1', text: 'old stuff', updatedAt: '', appendLog: false }],
      activeNoteId: 'note-1',
      settings: { rows: 6, font: 'prose', captureMode: 'overwrite', markdown: false, globalCapture: true },
    }),
    nowProvider: () => FIXED_NOW,
  });

  // No explicit mode → the persisted captureMode ('overwrite') drives it.
  await actions.captureToScratchpad('replace via setting');

  assert.equal(calls.updates[0].scratchpad.notes[0].text, '[10:00] replace via setting');
});

test('captureToScratchpad targets the active note among several and leaves siblings untouched', async () => {
  const { shell, calls } = createShellStub();
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => ({
      notes: [
        { id: 'note-1', title: 'One', text: 'a', updatedAt: '', appendLog: false },
        { id: 'note-2', title: 'Two', text: 'b', updatedAt: '', appendLog: false },
      ],
      activeNoteId: 'note-2',
      settings: { rows: 6, font: 'prose', captureMode: 'append' },
    }),
    nowProvider: () => FIXED_NOW,
  });

  const result = await actions.captureToScratchpad('to two');

  assert.equal(result.noteTitle, 'Two');
  const written = calls.updates[0].scratchpad;
  assert.equal(written.notes[0].text, 'a'); // untouched
  assert.equal(written.notes[1].text, 'b\n[10:00] to two');
  assert.equal(written.activeNoteId, 'note-2');
});

test('captureToScratchpad rejects empty text and a missing shell', async () => {
  const { shell } = createShellStub();
  const withShell = createScratchpadActions({ shell, getScratchpad: () => scratch(''), nowProvider: () => FIXED_NOW });
  assert.deepEqual(await withShell.captureToScratchpad('   '), { error: 'Write something first.' });

  const noShell = createScratchpadActions({ shell: {}, getScratchpad: () => scratch(''), nowProvider: () => FIXED_NOW });
  assert.deepEqual(await noShell.captureToScratchpad('x'), { error: 'Notes are unavailable.' });
});

test('captureToScratchpad refuses when the result would exceed the 4000-char note cap', async () => {
  const { shell, calls } = createShellStub();
  const big = 'x'.repeat(3990);
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => scratch(big),
    nowProvider: () => FIXED_NOW,
  });

  const result = await actions.captureToScratchpad('this push goes past the cap');

  assert.match(result.error, /full/);
  assert.equal(calls.updates.length, 0); // nothing was written (no silent truncation)
});

test('blurring the scratchpad textarea flushes the pending save immediately', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  let flushed = 0;
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: { queueSave() {}, flushSave: () => { flushed += 1; } },
  });

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  const textarea = body.querySelector('#homeScratchpadInput');
  assert.ok(textarea);
  textarea.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));

  assert.equal(flushed, 1);
});

test('captureToScratchpad flushes a pending debounced save before appending (no lost keystrokes)', async () => {
  const { shell, calls } = createShellStub();
  const timers = createTimerStub();
  // Mutable state so the flushed write becomes visible to the capture read.
  let current = scratch('');
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => current,
    onHomeConfig: (config) => { if (config && config.scratchpad) current = config.scratchpad; },
    nowProvider: () => FIXED_NOW,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  actions.queueSave('typed but unsaved', 'note-1');
  // Deliberately do NOT fire the debounce — capture must flush it first.
  const result = await actions.captureToScratchpad('appended');

  assert.equal(result.ok, true);
  assert.equal(calls.updates.length, 2);
  assert.equal(calls.updates[0].scratchpad.notes[0].text, 'typed but unsaved');
  assert.equal(calls.updates[1].scratchpad.notes[0].text, 'typed but unsaved\n[10:00] appended');
});

// ── Phase 4: settings-driven font/height + opt-in markdown preview ──────────

function mdScratch(text, settingsOverride) {
  return {
    notes: [{ id: 'note-1', title: 'One', text, updatedAt: '', appendLog: false }],
    activeNoteId: 'note-1',
    settings: { rows: 6, font: 'prose', captureMode: 'append', markdown: true, globalCapture: true, ...(settingsOverride || {}) },
  };
}

test('the widget reflects the persisted font + height settings on the field', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: { queueSave() {}, flushSave() {} },
  });

  widget.render(body, flagOnCtx(mdScratch('hi', { font: 'mono', rows: 12, markdown: false })));
  assert.equal(body.querySelector('.dashboard-scratchpad').dataset.font, 'mono');
  assert.equal(body.querySelector('#homeScratchpadInput').rows, 12);
});

test('markdown off: no preview toggle is rendered (plain-text path is untouched)', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    markdownModule: scratchpadMarkdown,
    actions: { queueSave() {}, flushSave() {} },
  });

  widget.render(body, flagOnCtx(mdScratch('- [ ] x', { markdown: false })));
  assert.equal(body.querySelector('[data-scratchpad-preview-toggle]'), null);
  assert.ok(body.querySelector('#homeScratchpadInput'));
});

test('markdown preview: the Preview toggle swaps the textarea for a sanitized checklist view', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    markdownModule: scratchpadMarkdown,
    actions: { queueSave() {}, flushSave() {} },
  });

  widget.render(body, flagOnCtx(mdScratch('- [ ] ship it\n<img onerror=alert(1)>')));
  assert.ok(body.querySelector('#homeScratchpadInput'));
  const toggle = body.querySelector('[data-scratchpad-preview-toggle]');
  assert.ok(toggle);

  toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(body.querySelector('#homeScratchpadInput'), null, 'textarea swapped out');
  const check = body.querySelector('[data-scratchpad-check]');
  assert.ok(check, 'checklist row present');
  assert.match(check.textContent, /ship it/);
  // The injected HTML is inert (escaped), never a live element.
  assert.equal(body.querySelector('img'), null);
});

test('markdown preview: clicking a checklist row flips the marker, persists, and re-renders', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const saved = [];
  let flushed = 0;
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    markdownModule: scratchpadMarkdown,
    actions: { queueSave: (text, id) => saved.push([text, id]), flushSave: () => { flushed += 1; } },
  });

  widget.render(body, flagOnCtx(mdScratch('- [ ] a\n- [x] b')));
  body.querySelector('[data-scratchpad-preview-toggle]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  body.querySelector('[data-scratchpad-check="0"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  // toggleCheck settles in-flight saves first (async), so the write lands a tick later.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(saved, [['- [x] a\n- [x] b', 'note-1']]);
  assert.equal(flushed, 2); // one settle-flush before reading + one persist-flush after queueSave
  // Optimistic re-render reflects the new checked state immediately.
  assert.equal(body.querySelector('[data-scratchpad-check="0"]').getAttribute('aria-pressed'), 'true');
});

test('markdown preview: switching notes returns to the editable textarea', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const scratchpad = {
    notes: [
      { id: 'note-1', title: 'One', text: '- [ ] a', updatedAt: '', appendLog: false },
      { id: 'note-2', title: 'Two', text: 'plain', updatedAt: '', appendLog: false },
    ],
    activeNoteId: 'note-1',
    settings: { rows: 6, font: 'prose', captureMode: 'append', markdown: true, globalCapture: true },
  };
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    markdownModule: scratchpadMarkdown,
    actions: { setActiveNote: async () => ({ ok: true }), queueSave() {}, flushSave() {} },
  });

  widget.render(body, flagOnCtx(scratchpad));
  body.querySelector('[data-scratchpad-preview-toggle]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(body.querySelector('#homeScratchpadInput'), null); // in preview
  // Switching to note-2 must drop preview and show the editable textarea.
  body.querySelector('[data-scratchpad-tab="note-2"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(body.querySelector('#homeScratchpadInput'), 'switch returns to edit mode');
});

test('flushSave awaits an in-flight fire-and-forget write even with no queued text', async () => {
  let resolveUpdate;
  const order = [];
  const shell = {
    home: {
      updateConfig: () => new Promise((resolve) => {
        resolveUpdate = () => { order.push('write'); resolve({ scratchpad: scratch('typed') }); };
      }),
    },
  };
  const actions = createScratchpadActions({ shell, getScratchpad: () => scratch('typed'), nowProvider: () => FIXED_NOW });

  // First flush (a textarea focusout) starts a write that stays in flight.
  actions.queueSave('typed', 'note-1');
  const flush1 = actions.flushSave();
  // A SECOND flushSave with no queued text (the checklist toggle's settle) must
  // still await that in-flight write, so the caller reads reconciled state.
  let flush2Done = false;
  const flush2 = actions.flushSave().then(() => { order.push('flush2'); flush2Done = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flush2Done, false, 'the second flushSave waits for the in-flight write');

  resolveUpdate();
  await Promise.all([flush1, flush2]);
  assert.equal(flush2Done, true);
  assert.deepEqual(order, ['write', 'flush2']);
});

test('markdown preview: a repaint with unchanged text reuses the preview DOM (keeps focus)', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    markdownModule: scratchpadMarkdown,
    actions: { queueSave() {}, flushSave() {} },
  });
  const scratchpad = mdScratch('- [ ] a');

  widget.render(body, flagOnCtx(scratchpad));
  body.querySelector('[data-scratchpad-preview-toggle]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const rowBefore = body.querySelector('[data-scratchpad-check="0"]');
  assert.ok(rowBefore);
  rowBefore.focus();
  assert.equal(body.ownerDocument.activeElement, rowBefore);

  // A stats-tick repaint with the SAME note text must not reparse the preview.
  widget.render(body, flagOnCtx(scratchpad));
  assert.equal(body.querySelector('[data-scratchpad-check="0"]'), rowBefore, 'preview node is reused, not reparsed');
  assert.equal(body.ownerDocument.activeElement, rowBefore, 'focus is preserved across the repaint');
});
