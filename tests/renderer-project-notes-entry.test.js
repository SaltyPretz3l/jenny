'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const entryModule = require('../renderer/features/renderer-project-notes-entry');
const { escapeHtml } = require('../renderer/shared/string-utils');

const { buildProjectNotesResultBlockMarkup, createProjectNotesEntry } = entryModule;

function appendMetadata(overrides = {}) {
  return {
    result_kind: 'project_notes',
    action: 'append',
    status: 'ok',
    project_id: 'proj-1',
    revision: 4,
    journal_entry_id: 'entry-9',
    summary: 'Added a launch checklist',
    lines: { added: 3, removed: 0, changed: 0 },
    ...overrides,
  };
}

function markup(metadata, extra = {}) {
  return buildProjectNotesResultBlockMarkup(metadata, { escapeHtml, actionButton, ...extra });
}

function fragment(html) {
  return new JSDOM(`<body>${html}</body>`).window.document;
}

test('result block renders nothing for read, failed and foreign result kinds', () => {
  assert.equal(markup(appendMetadata({ action: 'read' })), '');
  assert.equal(markup(appendMetadata({ status: 'failed' })), '');
  assert.equal(markup(appendMetadata({ result_kind: 'task_board' })), '');
  assert.equal(markup(null), '');
  assert.equal(markup({}), '');
});

test('append result renders title, line count, summary, Open and Undo', () => {
  const doc = fragment(markup(appendMetadata()));
  const row = doc.querySelector('.notes-chat__row');
  assert.equal(row.dataset.notesProject, 'proj-1');
  assert.equal(row.querySelector('.notes-chat__title').textContent, 'Updated project notes');
  assert.equal(row.querySelector('.notes-chat__meta').textContent, '+3 lines · Added a launch checklist');
  const open = row.querySelector('[data-notes-open]');
  assert.equal(open.textContent.trim(), 'Open');
  assert.equal(open.dataset.notesProject, 'proj-1');
  const undo = row.querySelector('[data-notes-undo]');
  assert.equal(undo.dataset.notesUndo, 'entry-9');
  assert.equal(undo.dataset.notesProject, 'proj-1');
  assert.equal(undo.textContent.trim(), 'Undo');
});

test('result block verbs follow the line counts and never carry note text', () => {
  const one = fragment(markup(appendMetadata({ lines: { added: 1, removed: 0, changed: 0 }, summary: '' })));
  assert.equal(one.querySelector('.notes-chat__meta').textContent, '+1 line');
  const removed = fragment(markup(appendMetadata({ action: 'replace', lines: { added: 0, removed: 2, changed: 0 }, summary: '' })));
  assert.equal(removed.querySelector('.notes-chat__meta').textContent, '−2 lines');
  const edited = fragment(markup(appendMetadata({ action: 'replace', lines: { added: 2, removed: 1, changed: 0 }, summary: '' })));
  assert.equal(edited.querySelector('.notes-chat__meta').textContent, 'edited');
  const secret = fragment(markup(appendMetadata({ text: 'SECRET BODY', note: 'SECRET BODY' })));
  assert.equal(secret.body.innerHTML.includes('SECRET BODY'), false);
});

test('result block names the touched headings between the line count and the summary', () => {
  const row = fragment(markup(appendMetadata({ headings: ['Status', 'Decisions', 'Three', 'Four'] })));
  assert.equal(row.querySelector('.notes-chat__meta').textContent, '+3 lines · Status, Decisions, Three · Added a launch checklist');
  const bare = fragment(markup(appendMetadata({ headings: ['Status'], summary: '' })));
  assert.equal(bare.querySelector('.notes-chat__meta').textContent, '+3 lines · Status');
});

test('result block escapes and bounds the summary and omits Undo without a journal entry', () => {
  const hostile = fragment(markup(appendMetadata({ summary: '<img src=x onerror=alert(1)>' + 'z'.repeat(400) })));
  assert.equal(hostile.querySelector('img'), null);
  assert.ok(hostile.querySelector('.notes-chat__meta').textContent.length <= 180);
  const noUndo = fragment(markup(appendMetadata({ journal_entry_id: '' })));
  assert.equal(noUndo.querySelector('[data-notes-undo]'), null);
  assert.ok(noUndo.querySelector('[data-notes-open]'));
});

function setup(options = {}) {
  const dom = new JSDOM(
    '<body><div id="chatTimelineUtilityCluster">'
    + '<button id="artifactSplitViewToggle"></button>'
    + (options.noTasksToggle ? '' : '<button id="chatTimelineTasksToggle"></button>')
    + '<button id="after"></button></div>'
    + '<div id="artifactReviewPanel" class="artifact-review-panel"></div><div id="chatInput"></div></body>',
    { pretendToBeVisual: true },
  );
  const win = dom.window;
  const doc = win.document;
  win.inventoryActionButton = actionButton;
  if (options.storage) Object.defineProperty(win, 'localStorage', { value: options.storage, configurable: true });
  const listeners = new Set();
  const calls = { get: [], undo: [], ensure: [], toasts: [], logs: [] };
  // proj-1 answers with `notes.value`; every other project has its own small note (entry-1 live).
  const notes = { value: options.note || null, others: { 'proj-2': { projectId: 'proj-2', text: 'y', revision: 1, updatedAt: 't', updatedBy: 'user', journal: [{ id: 'entry-1', undoable: true }] } } };
  win.jennyShell = {
    projectNotes: {
      get: async (id) => {
        calls.get.push(id);
        const note = id === 'proj-1' ? notes.value : notes.others[id] || null;
        return note ? { ok: true, note } : { ok: false };
      },
      undo: async (project, entry) => {
        calls.undo.push([project, entry]);
        return options.undoResult || { ok: true, note: notes.value };
      },
      onChanged: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    },
  };
  const hostState = { open: false, calls: [] };
  let host = options.host === true ? makeHost(hostState) : null;
  function makeHost(hs) {
    return {
      open: () => { hs.calls.push('open'); hs.open = true; return options.openResult !== false; },
      toggle: () => { hs.calls.push('toggle'); hs.open = !hs.open; return true; },
      isOpen: () => hs.open,
      refresh: () => {},
      markSeen: () => {},
    };
  }
  win.scriptLoaderUtils = {
    ensureScript: async ({ src }) => {
      calls.ensure.push(src);
      if (options.loadFails) return false;
      if (src.endsWith('-rail.js')) host = host || makeHost(hostState);
      return true;
    },
  };
  const state = {
    sessions: [{ id: 's1', project_id: 'proj-1' }, { id: 's2', project_id: 'proj-2' }],
    currentSessionId: 's1',
  };
  const entry = createProjectNotesEntry({
    state,
    windowRef: win,
    escapeHtml,
    dom: {
      utilityCluster: doc.getElementById('chatTimelineUtilityCluster'),
      artifactReviewPanel: doc.getElementById('artifactReviewPanel'),
    },
    appendClientLog: (...args) => calls.logs.push(args),
    showToastMessage: (message) => calls.toasts.push(message),
    getHost: () => host,
  });
  return { win, doc, entry, state, calls, listeners, notes, hostState, getHost: () => host };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function emit(ctx, payload) {
  for (const cb of [...ctx.listeners]) cb(payload);
}

test('toggle is inserted after the tasks toggle and mirrors the split toggle hidden state', async () => {
  const ctx = setup();
  ctx.doc.getElementById('artifactSplitViewToggle').hidden = false;
  ctx.entry.bind();
  const toggle = ctx.doc.getElementById('chatTimelineNotesToggle');
  assert.equal(ctx.doc.getElementById('chatTimelineTasksToggle').nextElementSibling, toggle);
  assert.equal(toggle.getAttribute('aria-label'), 'Notes');
  assert.equal(toggle.getAttribute('title'), 'Notes');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.ok(toggle.classList.contains('chat-timeline-notes-toggle'));
  assert.ok(toggle.querySelector('.chat-timeline-notes-dot[hidden]'));
  assert.equal(toggle.hidden, false);
  ctx.doc.getElementById('artifactSplitViewToggle').hidden = true;
  await flush();
  assert.equal(toggle.hidden, true);
  ctx.entry.dispose();
});

test('toggle falls back to follow the split toggle when there is no tasks toggle', () => {
  const ctx = setup({ noTasksToggle: true });
  ctx.entry.bind();
  const toggle = ctx.doc.getElementById('chatTimelineNotesToggle');
  assert.equal(ctx.doc.getElementById('artifactSplitViewToggle').nextElementSibling, toggle);
  ctx.entry.dispose();
});

test('clicking the toggle with no host loads both rail scripts in order and then opens', async () => {
  const ctx = setup();
  ctx.entry.bind();
  ctx.doc.getElementById('chatTimelineNotesToggle').click();
  ctx.doc.getElementById('chatTimelineNotesToggle').click();
  await flush();
  assert.deepEqual(ctx.calls.ensure, [
    'renderer/features/renderer-project-notes-rail-render.js',
    'renderer/features/renderer-project-notes-rail.js',
  ]);
  assert.deepEqual(ctx.hostState.calls, ['open']);
  assert.equal(ctx.doc.getElementById('chatTimelineNotesToggle').getAttribute('aria-pressed'), 'true');
  ctx.entry.dispose();
});

test('clicking the toggle with a host present toggles it', async () => {
  const ctx = setup({ host: true });
  ctx.entry.bind();
  ctx.doc.getElementById('chatTimelineNotesToggle').click();
  await flush();
  assert.deepEqual(ctx.hostState.calls, ['toggle']);
  assert.deepEqual(ctx.calls.ensure, []);
  ctx.entry.dispose();
});

test('a failed rail load toasts and logs instead of opening', async () => {
  const ctx = setup({ loadFails: true });
  ctx.entry.bind();
  ctx.doc.getElementById('chatTimelineNotesToggle').click();
  await flush();
  assert.deepEqual(ctx.calls.toasts, ['Notes are unavailable right now.']);
  assert.equal(ctx.calls.logs.some((args) => args[1] === 'project_notes.rail_load_failed'), true);
  ctx.entry.dispose();
});

test('the loader resolves to the rail global and stops at the first failed script', async () => {
  const win = { rendererProjectNotesRail: null };
  const seen = [];
  const ok = await entryModule.loadProjectNotesRailModules({
    windowRef: win,
    ensureScript: async ({ src, isReady }) => {
      seen.push(src);
      if (src.includes('-rail-render')) win.rendererProjectNotesRailRender = {};
      else win.rendererProjectNotesRail = {};
      return isReady();
    },
  });
  assert.equal(ok, win.rendererProjectNotesRail);
  assert.equal(seen.length, 2);
  const failed = await entryModule.loadProjectNotesRailModules({ windowRef: {}, ensureScript: async () => false });
  assert.equal(failed, null);
});

function assistantNote(revision = 5) {
  return { projectId: 'proj-1', text: 'x', revision, updatedAt: 't', updatedBy: 'assistant', journal: [{ id: 'entry-9', undoable: true }] };
}

test('an assistant write shows the accent dot and markSeen hides it', async () => {
  const ctx = setup({ note: assistantNote(5) });
  ctx.entry.bind();
  await flush();
  const dot = ctx.doc.querySelector('.chat-timeline-notes-dot');
  assert.equal(dot.hidden, false);
  assert.deepEqual(ctx.calls.get, ['proj-1']);
  ctx.entry.markSeen('proj-1', 5);
  assert.equal(dot.hidden, true);
  emit(ctx, { projectId: 'proj-1', revision: 5, updatedBy: 'assistant', journalEntryId: 'entry-9', reason: 'append' });
  await flush();
  assert.equal(dot.hidden, true);
  emit(ctx, { projectId: 'proj-1', revision: 6, updatedBy: 'assistant', journalEntryId: 'entry-10', reason: 'append' });
  await flush();
  assert.equal(dot.hidden, false);
  ctx.entry.dispose();
});

test('user writes and other projects never light the dot', async () => {
  const ctx = setup({ note: { ...assistantNote(2), updatedBy: 'user' } });
  ctx.entry.bind();
  await flush();
  const dot = ctx.doc.querySelector('.chat-timeline-notes-dot');
  assert.equal(dot.hidden, true);
  emit(ctx, { projectId: 'proj-1', revision: 3, updatedBy: 'user', journalEntryId: '', reason: 'save' });
  emit(ctx, { projectId: 'proj-2', revision: 3, updatedBy: 'assistant', journalEntryId: 'e', reason: 'append' });
  await flush();
  assert.equal(dot.hidden, true);
  ctx.entry.dispose();
});

test('an open rail marks the current note seen instead of lighting the dot', async () => {
  const ctx = setup({ host: true, note: assistantNote(5) });
  ctx.hostState.open = true;
  ctx.entry.bind();
  await flush();
  const dot = ctx.doc.querySelector('.chat-timeline-notes-dot');
  assert.equal(dot.hidden, true);
  emit(ctx, { projectId: 'proj-1', revision: 6, updatedBy: 'assistant', journalEntryId: 'e', reason: 'append' });
  await flush();
  assert.equal(dot.hidden, true);
  ctx.entry.dispose();
});

test('switching the current chat to another project refreshes the dot', async () => {
  const ctx = setup({ note: assistantNote(5) });
  ctx.entry.bind();
  await flush();
  const dot = ctx.doc.querySelector('.chat-timeline-notes-dot');
  assert.equal(dot.hidden, false);
  ctx.state.currentSessionId = 's2';
  ctx.notes.value = { ...assistantNote(1), projectId: 'proj-2', updatedBy: 'user' };
  ctx.doc.getElementById('chatInput').dispatchEvent(new ctx.win.FocusEvent('focusin', { bubbles: true }));
  await flush();
  assert.deepEqual(ctx.calls.get, ['proj-1', 'proj-2']);
  assert.equal(dot.hidden, true);
  assert.equal(ctx.entry.currentProjectId(), 'proj-2');
  ctx.entry.dispose();
});

function mountRow(ctx, project = 'proj-1', entryId = 'entry-9') {
  const host = ctx.doc.createElement('div');
  host.innerHTML = buildProjectNotesResultBlockMarkup(
    appendMetadata({ project_id: project, journal_entry_id: entryId }),
    { escapeHtml, actionButton },
  );
  ctx.doc.body.appendChild(host);
  return host;
}

test('the Open button opens the rail and never closes one that is already open', async () => {
  const ctx = setup({ host: true });
  ctx.entry.bind();
  const row = mountRow(ctx);
  row.querySelector('[data-notes-open]').click();
  await flush();
  row.querySelector('[data-notes-open]').click();
  await flush();
  assert.deepEqual(ctx.hostState.calls, ['open', 'open']);
  assert.equal(ctx.hostState.open, true);
  ctx.entry.dispose();
});

test('Open on a row from another project explains instead of opening the current note', async () => {
  const ctx = setup({ host: true });
  ctx.entry.bind();
  const row = mountRow(ctx, 'proj-2', 'entry-1');
  row.querySelector('[data-notes-open]').click();
  await flush();
  assert.deepEqual(ctx.hostState.calls, []);
  assert.deepEqual(ctx.calls.toasts, ['These notes belong to another project. Open a chat in that project to see them.']);
  ctx.entry.dispose();
});

test('rows render an Undo the journal already shows undone or overtaken at rest', async () => {
  const ctx = setup({ note: { ...assistantNote(5), journal: [
    { id: 'entry-7', undoable: false, undone: true },
    { id: 'entry-8', undoable: false, undone: false },
    { id: 'entry-9', undoable: true, undone: false },
  ] } });
  ctx.entry.bind();
  await flush(); // the refresh fetched the journal
  const undone = mountRow(ctx, 'proj-1', 'entry-7');
  const overtaken = mountRow(ctx, 'proj-1', 'entry-8');
  const live = mountRow(ctx, 'proj-1', 'entry-9');
  const unknownProject = mountRow(ctx, 'proj-2', 'entry-1');
  assert.equal(undone.querySelector('.notes-chat__undone').textContent, 'Undone');
  assert.equal(undone.querySelector('[data-notes-undo]'), null);
  assert.equal(overtaken.querySelector('.notes-chat__stale').textContent, 'Edited since');
  assert.ok(live.querySelector('[data-notes-undo]'));
  assert.ok(unknownProject.querySelector('[data-notes-undo]'), 'nothing is known about proj-2 yet, so the row keeps Undo');
  // An entry the journal no longer holds renders Undo (unknown) and settles itself right after the render.
  const evicted = mountRow(ctx, 'proj-1', 'entry-1');
  assert.ok(evicted.querySelector('[data-notes-undo]'), 'unknown at render time');
  const getsBefore = ctx.calls.get.filter((id) => id === 'proj-1').length;
  await flush();
  assert.equal(ctx.calls.get.filter((id) => id === 'proj-1').length, getsBefore + 1, 'one fresh fetch settles the render');
  assert.ok(unknownProject.querySelector('[data-notes-undo]'), "proj-2's own journal holds entry-1, so its row stays live");
  assert.equal(evicted.querySelector('.notes-chat__stale').textContent, 'Edited since');
  // A row for a write whose push has not arrived yet is settled from the fresh journal, not the stale cache.
  ctx.notes.value = { ...ctx.notes.value, revision: 6, journal: [...ctx.notes.value.journal, { id: 'entry-10', undoable: true, undone: false }] };
  const fresh = mountRow(ctx, 'proj-1', 'entry-10');
  assert.ok(fresh.querySelector('[data-notes-undo]'));
  await flush();
  assert.ok(fresh.querySelector('[data-notes-undo]'), 'still live after the settle');
  assert.ok(live.querySelector('[data-notes-undo]'));
  ctx.entry.dispose();
});

test('the seen revision survives a restart through localStorage', async () => {
  const stored = {};
  const storage = { getItem: (key) => (key in stored ? stored[key] : null), setItem: (key, value) => { stored[key] = value; } };
  const first = setup({ note: assistantNote(5), storage });
  first.entry.bind();
  await flush();
  assert.equal(first.doc.querySelector('.chat-timeline-notes-dot').hidden, false);
  first.entry.markSeen('proj-1', 5);
  assert.deepEqual(JSON.parse(stored['jenny.projectNotes.seen']), { 'proj-1': 5 });
  first.entry.dispose();
  const again = setup({ note: assistantNote(5), storage });
  again.entry.bind();
  await flush();
  assert.equal(again.doc.querySelector('.chat-timeline-notes-dot').hidden, true, 'revision 5 was already seen');
  again.entry.dispose();
});

test('a chat without a project reads General, as the rails do', () => {
  const ctx = setup();
  ctx.state.sessions.push({ id: 's3' });
  ctx.state.currentSessionId = 's3';
  assert.equal(ctx.entry.currentProjectId(), 'project_general');
  ctx.state.currentSessionId = 'missing';
  assert.equal(ctx.entry.currentProjectId(), '');
  ctx.entry.dispose();
});

test('Undo calls projectNotes.undo and swaps the button for Undone on success', async () => {
  const ctx = setup({ note: assistantNote(5) });
  ctx.entry.bind();
  const row = mountRow(ctx);
  row.querySelector('[data-notes-undo]').click();
  await flush();
  assert.deepEqual(ctx.calls.undo, [['proj-1', 'entry-9']]);
  assert.equal(row.querySelector('[data-notes-undo]'), null);
  assert.equal(row.querySelector('.notes-chat__undone').textContent, 'Undone');
  ctx.entry.dispose();
});

test('a focused Undo hands focus to its result, not to <body> (row 21 gate)', async () => {
  const ctx = setup({ note: assistantNote(5) });
  ctx.entry.bind();
  const row = mountRow(ctx);
  const undo = row.querySelector('[data-notes-undo]');
  undo.focus();
  undo.click();
  await flush();
  const undone = row.querySelector('.notes-chat__undone');
  assert.equal(ctx.doc.activeElement, undone);
  assert.equal(undone.getAttribute('tabindex'), '-1');
  ctx.entry.dispose();
});

test('a refused Undo swaps the button for Edited since', async () => {
  const ctx = setup({ undoResult: { ok: false, reason: 'conflict' } });
  ctx.entry.bind();
  const row = mountRow(ctx);
  row.querySelector('[data-notes-undo]').click();
  await flush();
  assert.equal(row.querySelector('.notes-chat__stale').textContent, 'Edited since');
  assert.equal(row.querySelector('.notes-chat__undone'), null);
  ctx.entry.dispose();
});

test('a change push retires Undo buttons whose journal entry is no longer undoable', async () => {
  const ctx = setup({ note: assistantNote(5) });
  ctx.entry.bind();
  const row = mountRow(ctx, 'proj-1', 'entry-9');
  const other = mountRow(ctx, 'proj-1', 'entry-7');
  const elsewhere = mountRow(ctx, 'proj-2', 'entry-1');
  await flush();
  ctx.notes.value = assistantNote(6);
  emit(ctx, { projectId: 'proj-1', revision: 6, updatedBy: 'user', journalEntryId: '', reason: 'save' });
  await flush();
  assert.ok(row.querySelector('[data-notes-undo]'));
  assert.equal(other.querySelector('[data-notes-undo]'), null);
  assert.equal(other.querySelector('.notes-chat__stale').textContent, 'Edited since');
  assert.ok(elsewhere.querySelector('[data-notes-undo]'));
  ctx.entry.dispose();
});

test('dispose stops the listeners and the push subscription', async () => {
  const ctx = setup({ note: assistantNote(5) });
  ctx.entry.bind();
  await flush();
  ctx.entry.dispose();
  assert.equal(ctx.listeners.size, 0);
  const row = mountRow(ctx);
  row.querySelector('[data-notes-undo]').click();
  await flush();
  assert.deepEqual(ctx.calls.undo, []);
});
