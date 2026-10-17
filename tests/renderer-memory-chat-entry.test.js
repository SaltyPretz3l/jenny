'use strict';

// The memory chip (memory v2, row 58 W1): the chat row for the sidecar memory
// tool's saved and pending writes, with Undo through jennyShell.memory.undo.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const { buildMemoryResultBlockMarkup, createMemoryChatEntry } = require('../renderer/features/renderer-memory-chat-entry');
const { escapeHtml } = require('../renderer/shared/string-utils');

function memoryMetadata(overrides = {}) {
  return {
    result_kind: 'memory',
    action: 'remember',
    status: 'saved',
    memory_id: 12,
    revision: 1,
    operation_id: 'tool:s1:call-1',
    scope: 'project',
    kind: 'fact',
    duplicate: false,
    undoable: true,
    text_preview: 'The deploy runs on Fridays',
    ...overrides,
  };
}

function markup(metadata, extra = {}) {
  return buildMemoryResultBlockMarkup(metadata, { escapeHtml, actionButton, ...extra });
}

function fragment(html) {
  return new JSDOM(`<body>${html}</body>`).window.document;
}

test('renders nothing for recall, list, refused, conflict and foreign results', () => {
  assert.equal(markup(memoryMetadata({ action: 'recall', status: 'ok' })), '');
  assert.equal(markup(memoryMetadata({ action: 'list', status: 'ok' })), '');
  assert.equal(markup(memoryMetadata({ status: 'refused', reason: 'capacity' })), '');
  assert.equal(markup(memoryMetadata({ action: 'update', status: 'conflict' })), '');
  assert.equal(markup(memoryMetadata({ result_kind: 'project_notes' })), '');
  assert.equal(markup(null), '');
  assert.equal(markup([]), '');
});

test('a saved remember renders the title, kind, scope, preview and Undo', () => {
  const doc = fragment(markup(memoryMetadata()));
  const row = doc.querySelector('.notes-chat__row.notes-chat__row--memory');
  assert.equal(row.dataset.memoryOperation, 'tool:s1:call-1');
  assert.ok(row.querySelector('.notes-chat__icon svg'));
  assert.equal(row.querySelector('.notes-chat__title').textContent, 'Remembered');
  assert.equal(row.querySelector('.notes-chat__meta').textContent, 'Fact · This project · The deploy runs on Fridays');
  const undo = row.querySelector('[data-memory-undo]');
  assert.equal(undo.dataset.memoryUndo, 'tool:s1:call-1');
  assert.ok(undo.classList.contains('notes-chat__undo'));
  assert.equal(undo.textContent.trim(), 'Undo');
});

test('update, forget and pending rows carry their own titles', () => {
  const title = (overrides) => fragment(markup(memoryMetadata(overrides))).querySelector('.notes-chat__title').textContent;
  assert.equal(title({ action: 'update' }), 'Updated a memory');
  assert.equal(title({ action: 'forget', scope: 'global', kind: 'person' }), 'Forgot a memory');
  assert.equal(title({ action: 'remember', origin: 'reflection', scope: 'project', kind: 'fact' }), 'Jenny took a note');
  assert.equal(title({ status: 'pending_approval', undoable: false }), 'Memory waiting for approval');
  const forget = fragment(markup(memoryMetadata({ action: 'forget', scope: 'global', kind: 'person', text_preview: '' })));
  assert.equal(forget.querySelector('.notes-chat__meta').textContent, 'Person · Everywhere');
  const chat = fragment(markup(memoryMetadata({ scope: 'chat', kind: 'lesson' })));
  assert.match(chat.querySelector('.notes-chat__meta').textContent, /^Lesson · This chat · /u);
});

test('no Undo when the write is not undoable, pending or has no operation id', () => {
  assert.equal(fragment(markup(memoryMetadata({ undoable: false }))).querySelector('[data-memory-undo]'), null);
  assert.equal(fragment(markup(memoryMetadata({ status: 'pending_approval' }))).querySelector('[data-memory-undo]'), null);
  assert.equal(fragment(markup(memoryMetadata({ operation_id: '' }))).querySelector('[data-memory-undo]'), null);
  assert.equal(fragment(markup(memoryMetadata({ operation_id: 'bad id' }))).querySelector('[data-memory-undo]'), null);
});

test('the memory text never enters the markup, and the preview is escaped and bounded', () => {
  const html = markup(memoryMetadata({ text: 'SECRET BODY', lesson_text: 'SECRET BODY', memory: { lesson_text: 'SECRET BODY' } }));
  assert.equal(html.includes('SECRET BODY'), false);
  const hostile = fragment(markup(memoryMetadata({ text_preview: '<img src=x onerror=alert(1)>' + 'z'.repeat(400) })));
  assert.equal(hostile.querySelector('img'), null);
  assert.ok(hostile.querySelector('.notes-chat__meta').textContent.length <= 160);
});

function setup(options = {}) {
  const dom = new JSDOM('<body><div id="transcript"></div></body>', { pretendToBeVisual: true });
  const win = dom.window;
  const calls = { undo: [], toasts: [], logs: [] };
  win.jennyShell = {
    memory: {
      undo: async (request) => {
        calls.undo.push(request);
        if (options.undoThrows) throw new Error('ipc down');
        return options.undoResult || { status: 'saved', operation_id: 'ui:1', undoable: false };
      },
    },
  };
  const state = { currentSessionId: 's1', sessions: [{ id: 's1', project_id: 'proj-1' }] };
  const entry = createMemoryChatEntry({
    state,
    windowRef: win,
    appendClientLog: (...args) => calls.logs.push(args),
    showToastMessage: (message) => calls.toasts.push(message),
  });
  entry.bind();
  const mount = (metadata = memoryMetadata(), extra = {}) => {
    const host = win.document.createElement('div');
    host.innerHTML = markup(metadata, extra);
    win.document.getElementById('transcript').appendChild(host);
    return host;
  };
  return { win, doc: win.document, entry, state, calls, mount };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test('Undo calls the bridge with the session and operation id and settles as Undone', async () => {
  const ctx = setup();
  const row = ctx.mount();
  row.querySelector('[data-memory-undo]').click();
  await flush();
  assert.deepEqual(ctx.calls.undo, [{ sessionId: 's1', operationId: 'tool:s1:call-1' }]);
  assert.equal(row.querySelector('[data-memory-undo]'), null);
  assert.equal(row.querySelector('.notes-chat__undone').textContent, 'Undone');
  assert.equal(ctx.entry.operationState('tool:s1:call-1'), 'undone');
  // A re-render of the same operation renders at rest, without a live Undo.
  const again = ctx.mount();
  assert.equal(again.querySelector('[data-memory-undo]'), null);
  assert.equal(again.querySelector('.notes-chat__undone').textContent, 'Undone');
  ctx.entry.dispose();
});

test('Undo uses the chat the row belongs to (split panes), else the current chat', async () => {
  const ctx = setup();
  const row = ctx.mount(memoryMetadata(), { sessionId: 's2' });
  assert.equal(row.querySelector('.notes-chat__row').dataset.memorySession, 's2');
  row.querySelector('[data-memory-undo]').click();
  await flush();
  assert.deepEqual(ctx.calls.undo, [{ sessionId: 's2', operationId: 'tool:s1:call-1' }]);
  ctx.entry.dispose();
});

test('a focused Undo hands focus to its result', async () => {
  const ctx = setup();
  const row = ctx.mount();
  const undo = row.querySelector('[data-memory-undo]');
  undo.focus();
  undo.click();
  await flush();
  const undone = row.querySelector('.notes-chat__undone');
  assert.equal(ctx.doc.activeElement, undone);
  assert.equal(undone.getAttribute('tabindex'), '-1');
  ctx.entry.dispose();
});

test('a conflict or a stale refusal settles as Changed since', async () => {
  for (const undoResult of [
    { status: 'conflict', reason: 'stale_revision' },
    { status: 'refused', reason: 'operation_expired' },
    { status: 'refused', reason: 'not_found' },
  ]) {
    const ctx = setup({ undoResult });
    const row = ctx.mount();
    row.querySelector('[data-memory-undo]').click();
    await flush();
    assert.equal(row.querySelector('.notes-chat__stale').textContent, 'Changed since', JSON.stringify(undoResult));
    assert.equal(ctx.entry.operationState('tool:s1:call-1'), 'stale');
    const again = ctx.mount();
    assert.equal(again.querySelector('.notes-chat__stale').textContent, 'Changed since');
    ctx.entry.dispose();
  }
});

test('another refusal or a failed bridge keeps Undo and shows a toast', async () => {
  for (const options of [{ undoResult: { status: 'refused', reason: 'sidecar_unavailable' } }, { undoThrows: true }]) {
    const ctx = setup(options);
    const row = ctx.mount();
    const undo = row.querySelector('[data-memory-undo]');
    undo.click();
    await flush();
    assert.equal(row.querySelector('[data-memory-undo]'), undo, 'Undo stays for a retry');
    assert.equal(undo.disabled, false);
    assert.equal(ctx.calls.toasts.length, 1);
    assert.equal(ctx.entry.operationState('tool:s1:call-1'), '');
    assert.equal(JSON.stringify(ctx.calls.logs).includes('SECRET'), false);
    ctx.entry.dispose();
  }
});

test('dispose stops the click delegate', async () => {
  const ctx = setup();
  ctx.entry.dispose();
  const row = ctx.mount();
  row.querySelector('[data-memory-undo]').click();
  await flush();
  assert.deepEqual(ctx.calls.undo, []);
});
