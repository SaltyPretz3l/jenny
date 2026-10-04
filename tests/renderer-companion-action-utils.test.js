const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createCompanionActionUtils } = require('../renderer/features/renderer-companion-action-utils.js');
const { buildTaskBrief } = require('../renderer/shared/task-brief-utils.js');

test('companion action utils derive unique resolvable Home actions', () => {
  const utils = createCompanionActionUtils();
  const focusAction = { id: 'focus:primary', type: 'prefill_chat', label: 'Focus', prompt: 'Focus' };
  const duplicateFocusAction = { id: 'focus:primary', type: 'prefill_chat', label: 'Duplicate', prompt: 'Nope' };
  const suggestedAction = { id: 'suggested:start', type: 'new_session', label: 'Start fresh' };
  const todayAction = { id: 'today:resume', type: 'continue_session', label: 'Resume', sessionId: 's1' };
  const reminderAction = { id: 'reminder:promote', type: 'promote_reminder', label: 'Promote', reminderId: 'r1' };
  const loopAction = { id: 'loop:done', type: 'resolve_follow_up', label: 'Done', followUpId: 'f1' };
  const companionState = {
    homeFocus: {
      primaryAction: focusAction,
      secondaryActions: [duplicateFocusAction],
    },
    suggestedActions: [suggestedAction, focusAction],
    todayCards: [{ items: [{ action: todayAction }] }],
    reminders: [{ action: reminderAction }],
    openLoopsBoard: {
      active: [{ actions: [loopAction] }],
      deferred: [],
      recentResolved: [],
      archived: [],
    },
  };

  assert.deepEqual(
    utils.getResolvableActions(companionState).map((action) => action.id),
    ['focus:primary', 'suggested:start', 'today:resume', 'reminder:promote', 'loop:done']
  );
});

test('companion action utils format handoff origin labels for chat actions', () => {
  const utils = createCompanionActionUtils();

  assert.equal(utils.formatCompanionOriginLabel({ label: 'Start Fresh Session' }), 'Home / New session');
  assert.equal(utils.formatCompanionOriginLabel({ label: 'Resume Current Session' }), 'Home / Resume');
  assert.equal(utils.formatCompanionOriginLabel({ label: 'Open Memories' }), 'Home / Open Memories');
});

function createLoopHarness({ loops = [], companion = {}, extraWindow = {}, extraCallbacks = {}, dom = {}, state = {} } = {}) {
  const calls = { toasts: [], errors: [], renders: 0, views: [], applied: [], dismissed: [] };
  const board = { active: loops, deferred: [], recentResolved: [], archived: [] };
  const utils = createCompanionActionUtils({
    state,
    windowRef: {
      getComputedStyle: () => ({ animationName: 'none' }),
      jennyShell: { companion },
      ...extraWindow,
    },
    documentRef: dom.documentRef || null,
    dom,
    callbacks: {
      getCompanionState: () => ({ loaded: true, openLoopsBoard: board }),
      applyCompanionPayload: (payload) => calls.applied.push(payload),
      renderAll: () => { calls.renders += 1; },
      showToastMessage: (message, options) => `toast-${calls.toasts.push({ message, options })}`,
      dismissToast: (toastId) => calls.dismissed.push(toastId),
      showShellErrorToast: (message, options) => calls.errors.push({ message, options }),
      toErrorMessage: (error, fallback) => (error?.message ? error.message : fallback),
      setActiveView: (view) => calls.views.push(view),
      ...extraCallbacks,
    },
  });
  // Minimal event target: closest('[data-x]') matches when the dataset has x.
  const click = (dataset) => utils.handleHomeClick({
    target: {
      closest: (selector) => {
        const match = /^\[data-([a-z-]+)\]$/.exec(selector);
        if (!match) return null;
        const key = match[1].replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        return Object.prototype.hasOwnProperty.call(dataset, key)
          ? { dataset, setAttribute() {}, isConnected: true }
          : null;
      },
    },
    preventDefault() {},
  });
  return { utils, calls, click };
}

const deleteAction = { id: 'delete_follow_up:f1', type: 'delete_follow_up', label: 'Delete', slot: 'overflow', followUpId: 'f1' };

test('delete hides the loop for the undo window, then commits exactly once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deleted = [];
  const { utils, calls, click } = createLoopHarness({
    loops: [{ followUpId: 'f1', status: 'active', actions: [deleteAction] }],
    companion: { deleteFollowUp: async (id) => { deleted.push(id); return { deleted: id }; } },
  });

  await click({ companionActionId: 'delete_follow_up:f1' });
  assert.equal(utils.isLoopPendingDelete('f1'), true, 'row hides immediately');
  assert.deepEqual(deleted, [], 'no IPC during the undo window');
  const toast = calls.toasts.at(-1);
  assert.equal(toast.message, 'Loop deleted.');
  assert.equal(toast.options.durationMs, 6000);

  toast.options.actions[0].onClick();
  assert.equal(utils.isLoopPendingDelete('f1'), false, 'Undo restores the row');
  t.mock.timers.tick(6000);
  await Promise.resolve();
  assert.deepEqual(deleted, [], 'an undone delete never reaches the main process');

  await click({ companionActionId: 'delete_follow_up:f1' });
  await click({ companionActionId: 'delete_follow_up:f1' });
  t.mock.timers.tick(6000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deleted, ['f1'], 'the timer commits one delete');
  assert.equal(utils.isLoopPendingDelete('f1'), false);
  assert.deepEqual(calls.applied.at(-1), { deleted: 'f1' });
});

test('overflow menu lists overflow actions with Delete separated and marked danger', async () => {
  const shown = [];
  const opened = [];
  const loop = {
    followUpId: 'f1',
    status: 'resolved',
    actions: [
      { id: 'activate_follow_up:f1', type: 'activate_follow_up', label: 'Reopen', slot: 'inline', followUpId: 'f1' },
      { id: 'edit_follow_up:f1', type: 'edit_follow_up', label: 'Edit', labelKey: 'companion.actions.edit', slot: 'overflow', followUpId: 'f1' },
      { id: 'archive_follow_up:f1', type: 'archive_follow_up', label: 'Archive', slot: 'overflow', followUpId: 'f1' },
      deleteAction,
    ],
  };
  const { click } = createLoopHarness({
    loops: [loop],
    extraWindow: { inventoryContextMenu: { show: (options) => shown.push(options) } },
    extraCallbacks: { renderHomePanel: () => opened.push('form') },
  });

  await click({ loopOverflow: 'f1' });
  assert.equal(shown.length, 1);
  assert.deepEqual(
    shown[0].items.map((item) => (item.separator ? '---' : `${item.label}${item.danger ? '!' : ''}`)),
    ['Edit', 'Archive', '---', 'Delete!']
  );
  await shown[0].items[0].action();
  assert.deepEqual(opened, ['form'], 'menu items dispatch through the action handler');
});

test('activate toast copy follows the loop status, not the button label', async () => {
  const activate = { id: 'activate_follow_up:f1', type: 'activate_follow_up', label: 'Rouvrir', slot: 'inline', followUpId: 'f1' };
  const { calls, click } = createLoopHarness({
    loops: [{ followUpId: 'f1', status: 'resolved', actions: [activate] }],
    companion: { activateFollowUp: async () => ({}) },
  });
  await click({ companionActionId: 'activate_follow_up:f1' });
  assert.equal(calls.toasts.at(-1).message, 'Reopened open loop.');
});

test('resume stays on Home when session activation is refused', async () => {
  const resume = { id: 'continue_follow_up:f1', type: 'continue_session', label: 'Resume thread', slot: 'primary', followUpId: 'f1', sessionId: 's1' };
  let activeId = 'other';
  const { calls, click } = createLoopHarness({
    loops: [{ followUpId: 'f1', status: 'active', actions: [resume] }],
    extraCallbacks: { activateWorkspaceSession: async () => ({ activeSessionId: activeId }) },
  });
  await click({ companionActionId: 'continue_follow_up:f1' });
  assert.deepEqual(calls.views, [], 'refused activation does not jump to chat');
  activeId = 's1';
  await click({ companionActionId: 'continue_follow_up:f1' });
  assert.deepEqual(calls.views, ['chat']);
});

test('start a session dispatches through the action utils with a task brief', async () => {
  const startAction = { id: 'start_task_session:task-1', type: 'start_task_session', label: 'Start a session', slot: 'primary', followUpId: 'task-1' };
  const loop = { followUpId: 'task-1', status: 'active', title: 'Ship WO-10c', body: 'Keep the brief unsent.', actions: [startAction] };
  const started = [];
  const { click } = createLoopHarness({
    loops: [loop],
    extraWindow: { rendererTaskSessionActions: { start: async (options) => started.push(options) } },
  });
  await click({ companionActionId: 'start_task_session:task-1' });
  assert.deepEqual(started, [{
    title: 'Ship WO-10c',
    initialPrompt: buildTaskBrief(loop, { linkedTaskId: 'task-1' }),
    linkedTaskId: 'task-1',
  }]);
  assert.match(started[0].initialPrompt, /^Ship WO-10c\n\nKeep the brief unsent\.\n\n/);

  const unavailable = createLoopHarness({ loops: [loop] });
  await unavailable.click({ companionActionId: 'start_task_session:task-1' });
  assert.equal(unavailable.calls.errors.at(-1).message, 'Could not start a session for that task.');
});

test('the add form keeps a typed draft across re-renders and saves once on double submit', async () => {
  const dom = new JSDOM('<form id="homeOpenLoopForm"><input id="t"><textarea id="n"></textarea><select id="s"></select><button id="save" type="submit"></button></form>');
  const documentRef = dom.window.document;
  let resolveAdd;
  const added = [];
  const harness = createLoopHarness({
    companion: {
      addFollowUp: (payload) => {
        added.push(payload);
        return new Promise((resolve) => { resolveAdd = resolve; });
      },
    },
    dom: {
      documentRef,
      homeOpenLoopForm: documentRef.getElementById('homeOpenLoopForm'),
      homeOpenLoopTitleInput: documentRef.getElementById('t'),
      homeOpenLoopNotesInput: documentRef.getElementById('n'),
      homeOpenLoopDeferSelect: documentRef.getElementById('s'),
      homeOpenLoopSaveButton: documentRef.getElementById('save'),
    },
  });
  const companionState = { loaded: true, availableDeferPresets: [] };
  harness.utils.renderManualAddForm(companionState);
  documentRef.getElementById('t').value = 'Draft title';
  documentRef.getElementById('n').value = 'Draft notes';
  harness.utils.renderManualAddForm(companionState);
  assert.equal(documentRef.getElementById('t').value, 'Draft title', 'a routine render keeps the draft');
  assert.equal(documentRef.getElementById('n').value, 'Draft notes');

  const submit = () => harness.utils.handleHomeSubmit({ target: { closest: () => ({}) }, preventDefault() {} });
  const first = submit();
  const second = submit();
  resolveAdd({});
  await Promise.all([first, second]);
  assert.equal(added.length, 1, 'a second submit while saving is ignored');
});

test('a mutation on a vanished loop resyncs and says the loop is gone', async () => {
  const refreshed = [];
  const done = { id: 'resolve_follow_up:f1', type: 'resolve_follow_up', label: 'Done', slot: 'primary', followUpId: 'f1' };
  const { calls, click } = createLoopHarness({
    loops: [{ followUpId: 'f1', status: 'active', actions: [done] }],
    companion: {
      resolveFollowUp: async () => {
        throw new Error('Error invoking remote method: Error: CMP-COMPANION-0002: That open loop no longer exists.');
      },
    },
    extraCallbacks: { refreshCompanionState: async () => { refreshed.push(true); } },
  });
  await click({ companionActionId: 'resolve_follow_up:f1' });
  assert.deepEqual(refreshed, [true]);
  assert.equal(calls.errors.at(-1).message, 'That open loop no longer exists.');
});

test('committing a delete dismisses its Undo toast; dispose cancels a pending delete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deleted = [];
  const { utils, calls, click } = createLoopHarness({
    loops: [{ followUpId: 'f1', status: 'active', actions: [deleteAction] }],
    companion: { deleteFollowUp: async (id) => { deleted.push(id); return {}; } },
  });

  await click({ companionActionId: 'delete_follow_up:f1' });
  const toastId = `toast-${calls.toasts.length}`;
  t.mock.timers.tick(6000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deleted, ['f1']);
  assert.deepEqual(calls.dismissed, [toastId], 'a hovered toast cannot outlive the commit');

  await click({ companionActionId: 'delete_follow_up:f1' });
  const secondToast = `toast-${calls.toasts.length}`;
  utils.dispose();
  assert.equal(utils.isLoopPendingDelete('f1'), false);
  assert.deepEqual(calls.dismissed, [toastId, secondToast]);
  t.mock.timers.tick(6000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deleted, ['f1'], 'teardown never commits a pending delete');
});

test('a failed save re-enables Save even if a render disabled it mid-flight', async () => {
  const dom = new JSDOM('<form id="homeOpenLoopForm"><input id="t"><textarea id="n"></textarea><select id="s"></select><button id="save" type="submit"></button></form>');
  const documentRef = dom.window.document;
  let rejectAdd;
  const harness = createLoopHarness({
    companion: { addFollowUp: () => new Promise((_resolve, reject) => { rejectAdd = reject; }) },
    dom: {
      documentRef,
      homeOpenLoopForm: documentRef.getElementById('homeOpenLoopForm'),
      homeOpenLoopTitleInput: documentRef.getElementById('t'),
      homeOpenLoopNotesInput: documentRef.getElementById('n'),
      homeOpenLoopDeferSelect: documentRef.getElementById('s'),
      homeOpenLoopSaveButton: documentRef.getElementById('save'),
    },
  });
  const companionState = { loaded: true, availableDeferPresets: [] };
  harness.utils.renderManualAddForm(companionState);
  documentRef.getElementById('t').value = 'Title';
  const pending = harness.utils.handleHomeSubmit({ target: { closest: () => ({}) }, preventDefault() {} });
  harness.utils.renderManualAddForm(companionState);
  assert.equal(documentRef.getElementById('save').disabled, true, 'Save is disabled while saving');
  rejectAdd(new Error('boom'));
  await pending;
  assert.equal(documentRef.getElementById('save').disabled, false);
});

function formDom() {
  const dom = new JSDOM('<form id="homeOpenLoopForm"><input id="t"><textarea id="n"></textarea><select id="s"></select><button id="save" type="submit"></button><button id="add"></button></form>');
  const documentRef = dom.window.document;
  const byId = (id) => documentRef.getElementById(id);
  return {
    documentRef,
    homeOpenLoopForm: byId('homeOpenLoopForm'),
    homeOpenLoopTitleInput: byId('t'),
    homeOpenLoopNotesInput: byId('n'),
    homeOpenLoopDeferSelect: byId('s'),
    homeOpenLoopSaveButton: byId('save'),
    homeOpenLoopAddButton: byId('add'),
  };
}

const submitEvent = { target: { closest: () => ({}) }, preventDefault() {} };
const editAction = (followUpId) => ({ id: `edit_follow_up:${followUpId}`, type: 'edit_follow_up', label: 'Edit', slot: 'overflow', followUpId });

test('the defer picker dismisses itself on success and when the loop turned stale', async () => {
  const defer = { id: 'defer_follow_up:f1', type: 'defer_follow_up', label: 'Later', slot: 'inline', followUpId: 'f1' };
  let fail = false;
  const { calls, click } = createLoopHarness({
    loops: [{ followUpId: 'f1', status: 'active', actions: [defer] }],
    companion: {
      deferFollowUp: async () => {
        if (fail) throw new Error("Error invoking remote method 'companion:deferFollowUp': Error: CMP-COMPANION-0003: Completed open loops cannot be deferred. Reopen it first.");
        return {};
      },
    },
  });
  await click({ companionActionId: 'defer_follow_up:f1' });
  const pickerId = `toast-${calls.toasts.length}`;
  await calls.toasts.at(-1).options.actions[0].onClick();
  assert.deepEqual(calls.dismissed, [pickerId], 'a landed defer closes the picker');

  fail = true;
  await click({ companionActionId: 'defer_follow_up:f1' });
  const staleId = `toast-${calls.toasts.length}`;
  await calls.toasts.at(-1).options.actions[0].onClick();
  assert.deepEqual(calls.dismissed, [pickerId, staleId], 'a stale loop closes the picker too');
});

test('coded backend errors show their localized sentence, never the raw IPC text', async () => {
  const archive = { id: 'archive_follow_up:f1', type: 'archive_follow_up', label: 'Archive', slot: 'overflow', followUpId: 'f1' };
  const translated = [];
  const { calls, click } = createLoopHarness({
    loops: [{ followUpId: 'f1', status: 'active', actions: [archive] }],
    companion: {
      archiveFollowUp: async () => {
        throw new Error("Error invoking remote method 'companion:archiveFollowUp': Error: CMP-COMPANION-0003: Only resolved open loops can be archived.");
      },
    },
    extraWindow: {
      jennyBackendStrings: { errorText: (code, text) => { translated.push([code, text]); return 'Diese Änderung ist gerade nicht möglich.'; } },
    },
  });
  await click({ companionActionId: 'archive_follow_up:f1' });
  assert.deepEqual(translated, [['CMP-COMPANION-0003', 'Only resolved open loops can be archived.']]);
  const shown = calls.errors.at(-1).message;
  assert.equal(shown, 'Diese Änderung ist gerade nicht möglich.');
  assert.doesNotMatch(shown, /CMP-|Error invoking/);

  const english = createLoopHarness({
    loops: [{ followUpId: 'f1', status: 'active', actions: [archive] }],
    companion: { archiveFollowUp: async () => { throw new Error('Error: CMP-COMPANION-0003: Only resolved open loops can be archived.'); } },
  });
  await english.click({ companionActionId: 'archive_follow_up:f1' });
  assert.equal(english.calls.errors.at(-1).message, 'Only resolved open loops can be archived.', 'without translators: the backend sentence without its code');
});

test('resume stays on Home when activation returns no session at all', async () => {
  const resume = { id: 'continue_follow_up:f1', type: 'continue_session', label: 'Resume thread', slot: 'primary', followUpId: 'f1', sessionId: 's1' };
  for (const result of [{ activeSessionId: '' }, undefined, null]) {
    const { calls, click } = createLoopHarness({
      loops: [{ followUpId: 'f1', status: 'active', actions: [resume] }],
      extraCallbacks: { activateWorkspaceSession: async () => result },
    });
    await click({ companionActionId: 'continue_follow_up:f1' });
    assert.deepEqual(calls.views, [], JSON.stringify(result));
  }
});

test('deleting the loop open in Edit closes the form; Undo dismisses its toast; pending ids reach shared UI state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = formDom();
  const state = { ui: {} };
  const loop = { followUpId: 'f1', status: 'active', title: 'Loop', actions: [editAction('f1'), deleteAction] };
  const { utils, calls, click } = createLoopHarness({ loops: [loop], dom, state });
  await click({ companionActionId: 'edit_follow_up:f1' });
  utils.renderManualAddForm({ loaded: true });
  assert.equal(dom.homeOpenLoopForm.hidden, false, 'editing f1');

  await click({ companionActionId: 'delete_follow_up:f1' });
  utils.renderManualAddForm({ loaded: true });
  assert.equal(dom.homeOpenLoopForm.hidden, true, 'the edit form closed with the delete');
  assert.deepEqual(state.ui.pendingLoopDeleteIds, ['f1']);

  const toastId = `toast-${calls.toasts.length}`;
  calls.toasts.at(-1).options.actions[0].onClick();
  assert.deepEqual(calls.dismissed, [toastId], 'Undo dismisses the "Loop deleted." toast');
  assert.deepEqual(state.ui.pendingLoopDeleteIds, []);
});

test('Edit A then Edit B repopulates the form from B', async () => {
  const dom = formDom();
  const loops = [
    { followUpId: 'a', status: 'active', title: 'Loop A', body: 'Notes A', actions: [editAction('a')] },
    { followUpId: 'b', status: 'deferred', deferPreset: 'tomorrow', title: 'Loop B', body: 'Notes B', actions: [editAction('b')] },
  ];
  const { utils, click } = createLoopHarness({ loops, dom });
  await click({ companionActionId: 'edit_follow_up:a' });
  utils.renderManualAddForm({ loaded: true });
  dom.homeOpenLoopTitleInput.value = 'Typed over A';
  await click({ companionActionId: 'edit_follow_up:b' });
  utils.renderManualAddForm({ loaded: true });
  assert.equal(dom.homeOpenLoopTitleInput.value, 'Loop B');
  assert.equal(dom.homeOpenLoopNotesInput.value, 'Notes B');
  assert.equal(dom.homeOpenLoopDeferSelect.value, 'tomorrow');
});

test('a save that finishes after the form was reopened leaves the new draft alone', async () => {
  const dom = formDom();
  let resolveUpdate;
  const loops = [
    { followUpId: 'a', status: 'active', title: 'Loop A', actions: [editAction('a')] },
    { followUpId: 'b', status: 'active', title: 'Loop B', actions: [editAction('b')] },
  ];
  const { utils, click } = createLoopHarness({
    loops,
    dom,
    companion: { updateFollowUp: () => new Promise((resolve) => { resolveUpdate = resolve; }) },
  });
  await click({ companionActionId: 'edit_follow_up:a' });
  utils.renderManualAddForm({ loaded: true });
  const saving = utils.handleHomeSubmit(submitEvent);
  await click({ companionActionId: 'edit_follow_up:b' });
  utils.renderManualAddForm({ loaded: true });
  dom.homeOpenLoopTitleInput.value = 'Draft for B';
  resolveUpdate({});
  await saving;
  utils.renderManualAddForm({ loaded: true });
  assert.equal(dom.homeOpenLoopForm.hidden, false, 'B stays open');
  assert.equal(dom.homeOpenLoopTitleInput.value, 'Draft for B');
});

test('an edit sends timing only when the timing select changed', async () => {
  const dom = formDom();
  const patches = [];
  const loops = [{ followUpId: 'due', status: 'active', isDue: true, title: 'Due loop', actions: [editAction('due')] }];
  const { utils, click } = createLoopHarness({
    loops,
    dom,
    companion: { updateFollowUp: async (_id, patch) => { patches.push(patch); return {}; } },
  });
  await click({ companionActionId: 'edit_follow_up:due' });
  utils.renderManualAddForm({ loaded: true });
  dom.homeOpenLoopTitleInput.value = 'Due loop, renamed';
  await utils.handleHomeSubmit(submitEvent);
  assert.deepEqual(patches.at(-1), { label: 'Due loop, renamed', body: '' }, 'untouched timing keeps the deferral');

  await click({ companionActionId: 'edit_follow_up:due' });
  utils.renderManualAddForm({ loaded: true });
  dom.homeOpenLoopDeferSelect.value = 'next_week';
  await utils.handleHomeSubmit(submitEvent);
  assert.deepEqual(patches.at(-1), { label: 'Due loop', body: '', status: 'deferred', deferPreset: 'next_week' });
});
