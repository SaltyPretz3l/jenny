'use strict';

// Settings > Memory page (agentic memory v2, row 58 W4): scope tabs, the
// always-on switch and meter, the Forgotten and History folds, export, the
// notes-file links and the "Why" link, each against the page bridge contract.
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const SOURCE_CHAT = 'session-source';

function row(overrides = {}) {
  return {
    id: 1,
    session_id: SOURCE_CHAT,
    project_id: 'project_general',
    title: 'Preference: tea',
    lesson_text: 'The user prefers tea.',
    lesson_kind: 'preference',
    origin: 'user',
    always_on: false,
    revision: 2,
    content_fingerprint: `sha256:${'f'.repeat(64)}`,
    created_at: '2026-10-01T12:00:00.000Z',
    updated_at: '2026-10-01T12:00:00.000Z',
    ...overrides,
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const toasts = (window) => window.document.getElementById('toastViewport').textContent;

async function openMemoryPage(t, { memories, pending = [], bridge = {}, sessions = [], status = {}, projects = null }) {
  const app = await loadRendererApp({
    shell: {
      sessions,
      ...(projects ? { projects: { list: () => ({ projects }) } } : {}),
      memory: {
        async status() {
          return {
            available: true, counts: { approved: memories.length, pending: pending.length }, storage: { state: 'ready' },
            degraded_reasons: [], always_on_budget: { budget_chars: 1200, heading_reserve: 144, row_overhead: 16 },
            ...status,
          };
        },
        async listApproved() { return { memories }; },
        async listPending() { return { candidates: pending }; },
      },
    },
  });
  t.after(async () => { await app.dispose(); });
  Object.assign(app.window.jennyShell.memory, bridge);
  const doc = app.window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(app.window, 20);
  doc.getElementById('settingsNav-memories').click();
  await waitForUi(app.window, 80);
  return app.window;
}

async function clickToastAction(window, actionId) {
  const button = window.document.querySelector(`[data-toast-action-id="${actionId}"]`);
  assert.ok(button, `the toast offers ${actionId}`);
  button.click();
  await waitForUi(window, 60);
}

test('scope tabs split General from a project, and the meter counts pinned text', async (t) => {
  const window = await openMemoryPage(t, {
    projects: [
      { id: 'project_general', name: 'General' },
      { id: 'project_garden', name: 'Garden' },
    ],
    memories: [
      row({ id: 1, always_on: true, lesson_text: 'Call me Sam.' }),
      row({ id: 2 }),
      row({ id: 3, project_id: 'project_garden', lesson_text: 'The beds face south.' }),
    ],
  });
  const doc = window.document;
  const tabs = [...doc.querySelectorAll('#memoryTabsHost [role="tab"]')];
  assert.deepEqual(tabs.map((tab) => tab.dataset.memoryScope), ['project_general', 'project_garden']);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(doc.querySelectorAll('#approvedMemoryList > article').length, 2);
  // 144 heading reserve + 12 chars + 16 row overhead.
  assert.match(doc.getElementById('memoryMeter').textContent, /172 \/ 1,200 characters/);

  tabs[1].click();
  await waitForUi(window, 40);
  assert.equal(doc.querySelector('[data-memory-scope="project_garden"]').getAttribute('aria-selected'), 'true');
  assert.deepEqual([...doc.querySelectorAll('#approvedMemoryList .memory-text')].map((node) => node.textContent), ['The beds face south.']);
  assert.match(doc.getElementById('memoryMeter').textContent, /with General/, 'a project tab counts General\'s pinned rows too');
});

test('the always-on switch sends the row revision and a full budget says so', async (t) => {
  const calls = [];
  const window = await openMemoryPage(t, {
    memories: [row()],
    bridge: {
      async setAlwaysOn(request) {
        calls.push(request);
        return calls.length === 1 ? { ok: true, status: 'saved' } : { ok: true, status: 'refused', reason: 'always_on_full' };
      },
    },
  });
  const toggle = () => window.document.querySelector('[data-inv-toggle="memoryAlwaysOn-1"]');
  assert.ok(toggle(), 'an active row has an always-on switch');
  toggle().click();
  await waitForUi(window, 80);
  assert.deepEqual(plain(calls[0]), { projectId: 'project_general', memoryId: 1, alwaysOn: true, expectedRevision: 2 });

  toggle().click();
  await waitForUi(window, 80);
  assert.match(toasts(window), /Always-on memories are full/);
});

test('a chat-only note has no always-on switch and Why opens only a chat that still exists', async (t) => {
  const window = await openMemoryPage(t, {
    sessions: [{ id: SOURCE_CHAT, title: 'Tea talk', session_type: 'chat', updated_at: '2026-10-01T12:00:00.000Z' }],
    memories: [row({ id: 1 }), row({ id: 2, session_id: 'session-gone', scope_session_id: 'session-gone' })],
  });
  const doc = window.document;
  assert.ok(doc.querySelector('[data-memory-page-action="why"][data-memory-id="1"]'));
  assert.equal(doc.querySelector('[data-memory-page-action="why"][data-memory-id="2"]'), null);
  assert.equal(doc.querySelector('[data-inv-toggle="memoryAlwaysOn-2"]'), null);
  assert.match(doc.querySelector('[data-memory-id="2"].memory-record').textContent, /This chat only/);
});

test('the Forgotten fold loads lazily, restores, erases after a confirm and clears the list', async (t) => {
  const calls = { list: [], restore: [], erase: [], clear: [] };
  const restoreAnswers = [
    { ok: true, status: 'refused', reason: 'already_remembered' },
    { ok: true, status: 'refused', reason: 'capacity' },
    { ok: true, status: 'refused', reason: 'project_archived' },
    { ok: true, status: 'saved' },
  ];
  const window = await openMemoryPage(t, {
    memories: [row()],
    bridge: {
      async listArchived(request) {
        calls.list.push(request);
        return { ok: true, memories: [row({ id: 9, status: 'archived', lesson_text: 'Old habit.', archived_at: '2026-10-02T09:00:00.000Z' })] };
      },
      async restore(request) { calls.restore.push(request); return restoreAnswers.shift(); },
      async erase(request) { calls.erase.push(request); return { ok: true, status: 'erased' }; },
      async clearForgotten(request) { calls.clear.push(request); return { ok: true, cleared: 1 }; },
    },
  });
  const doc = window.document;
  assert.equal(calls.list.length, 0, 'nothing loads while the fold is closed');
  doc.querySelector('[data-memory-fold="memoryForgottenFold"]').click();
  await waitForUi(window, 80);
  assert.deepEqual(plain(calls.list), [{ projectId: 'project_general' }]);
  assert.match(doc.getElementById('memoryForgottenHost').textContent, /Old habit\./);

  const restore = () => doc.querySelector('[data-memory-page-action="restore"][data-memory-id="9"]').click();
  restore();
  await waitForUi(window, 80);
  assert.deepEqual(plain(calls.restore[0]), { projectId: 'project_general', memoryId: 9 });
  assert.match(toasts(window), /Jenny already remembers this\./);
  restore();
  await waitForUi(window, 80);
  assert.match(toasts(window), /Memory is full/);
  restore();
  await waitForUi(window, 80);
  assert.match(toasts(window), /Its project was deleted/);
  restore();
  await waitForUi(window, 80);
  assert.match(toasts(window), /Memory restored\./);

  doc.querySelector('[data-memory-page-action="erase"][data-memory-id="9"]').click();
  await waitForUi(window, 20);
  assert.equal(calls.erase.length, 0, 'erase waits for the confirm');
  assert.match(toasts(window), /can’t be undone/);
  await clickToastAction(window, 'confirm');
  assert.deepEqual(plain(calls.erase), [{ projectId: 'project_general', memoryId: 9 }]);
  assert.match(toasts(window), /Memory erased\./);

  doc.querySelector('[data-memory-page-action="clear-forgotten"]').click();
  await waitForUi(window, 20);
  await clickToastAction(window, 'confirm');
  assert.deepEqual(plain(calls.clear), [{ projectId: 'project_general' }]);
});

test('the History fold joins rows to their text and Undo names the tab project', async (t) => {
  const undos = [];
  const window = await openMemoryPage(t, {
    memories: [row()],
    bridge: {
      async listOperations() {
        return { ok: true, operations: [
          { operation_id: 'rpc:op2', op: 'update', origin: 'user', memory_id: 1, created_at: '2026-10-03T10:00:00.000Z', undoable: true },
          { operation_id: 'rpc:op1', op: 'save', origin: 'reflection', memory_id: 77, created_at: '2026-10-02T10:00:00.000Z', undoable: false },
        ] };
      },
      async undoChange(operationId, projectId) { undos.push({ operationId, projectId }); return { status: 'saved' }; },
    },
  });
  const doc = window.document;
  doc.querySelector('[data-memory-fold="memoryHistoryFold"]').click();
  await waitForUi(window, 80);
  const history = doc.getElementById('memoryHistoryHost').textContent;
  assert.match(history, /You edited “The user prefers tea\.”/);
  assert.match(history, /A memory that is no longer here/);
  assert.equal(doc.querySelectorAll('[data-memory-page-action="undo-operation"]').length, 1, 'only an undoable change offers Undo');
  doc.querySelector('[data-memory-page-action="undo-operation"]').click();
  await waitForUi(window, 80);
  assert.deepEqual(undos, [{ operationId: 'rpc:op2', projectId: 'project_general' }]);
});

test('export reports a failed save, a canceled dialog stays quiet, and the files open by name', async (t) => {
  const exports = [];
  const opened = [];
  const exportAnswers = [{ ok: true, saved: false }, { ok: false, reason: 'save_failed' }, { ok: true, saved: true, path: 'C:/x.md' }];
  const window = await openMemoryPage(t, {
    memories: [row()],
    bridge: {
      async exportMarkdown(request) { exports.push(request); return exportAnswers.shift(); },
      async openContextFile(request) { opened.push(request); return opened.length === 1 ? { ok: true } : { ok: false, reason: 'launch_failed' }; },
    },
  });
  const doc = window.document;
  const exportButton = () => doc.querySelector('#memoryHeaderActions [data-memory-page-action="export"]');
  exportButton().click();
  await waitForUi(window, 60);
  assert.deepEqual(plain(exports[0]), { projectId: null, title: 'Export memories' });
  assert.doesNotMatch(toasts(window), /export/i, 'a canceled save dialog needs no toast');
  exportButton().click();
  await waitForUi(window, 60);
  assert.match(toasts(window), /Could not export memories\./);
  exportButton().click();
  await waitForUi(window, 60);
  assert.match(toasts(window), /Memories exported\./);

  doc.querySelector('[data-memory-page-action="open-file"][data-file="USER.md"]').click();
  await waitForUi(window, 40);
  doc.querySelector('[data-memory-page-action="open-file"][data-file="MEMORY.md"]').click();
  await waitForUi(window, 40);
  assert.deepEqual(plain(opened), [{ name: 'USER.md' }, { name: 'MEMORY.md' }]);
  assert.match(toasts(window), /Could not open MEMORY\.md\./);
});

test('Dismiss names the queued candidate project', async (t) => {
  const deletes = [];
  const window = await openMemoryPage(t, {
    memories: [],
    pending: [{
      id: 5, session_id: 'session-moved', project_id: 'project_garden', title: 'Goal: ship', lesson_text: 'The user wants to ship.',
      lesson_kind: 'goal', confidence: 0.9, content_fingerprint: `sha256:${'a'.repeat(64)}`,
      created_at: '2026-10-01T12:00:00.000Z', updated_at: '2026-10-01T12:00:00.000Z',
    }],
    bridge: {
      async deletePending(sessionId, fingerprint, projectId) { deletes.push({ sessionId, fingerprint, projectId }); return { deleted: true }; },
    },
  });
  window.document.querySelector('[data-pending-memory-action="discard"]').click();
  await waitForUi(window, 60);
  assert.deepEqual(deletes, [{ sessionId: 'session-moved', fingerprint: `sha256:${'a'.repeat(64)}`, projectId: 'project_garden' }]);
});

test('a scope whose rows are all forgotten keeps its tab and its Forgotten fold', async (t) => {
  const calls = [];
  const window = await openMemoryPage(t, {
    memories: [],
    status: { forgotten_scopes: ['project_general', 'project_garden', 42, 'x'.repeat(200)] },
    bridge: {
      async listArchived(request) {
        calls.push(request);
        return { ok: true, memories: [row({ id: 9, project_id: request.projectId, status: 'archived', lesson_text: 'Old habit.' })] };
      },
    },
  });
  const doc = window.document;
  const tabs = [...doc.querySelectorAll('[data-memory-scope]')].map((tab) => tab.dataset.memoryScope);
  assert.deepEqual(tabs, ['project_general', 'project_garden'], 'invalid scope ids are dropped');
  assert.equal(doc.getElementById('memoryForgottenHost').hidden, false);
  assert.equal(doc.getElementById('memoryHistoryHost').hidden, false);

  doc.querySelector('[data-memory-scope="project_garden"]').click();
  await waitForUi(window, 40);
  doc.querySelector('[data-memory-fold="memoryForgottenFold"]').click();
  await waitForUi(window, 80);
  assert.deepEqual(plain(calls), [{ projectId: 'project_garden' }]);
  assert.match(doc.getElementById('memoryForgottenHost').textContent, /Old habit\./);
});

test('a deleted project’s forgotten memories restore into a live project or General', async (t) => {
  const calls = [];
  const window = await openMemoryPage(t, {
    memories: [],
    projects: [{ id: 'project_general', name: 'General' }, { id: 'project_garden', name: 'Garden' }],
    status: { forgotten_scopes: ['project_old'] },
    bridge: {
      async listArchived() {
        return { ok: true, memories: [
          row({ id: 9, project_id: 'project_old', status: 'archived', lesson_text: 'Old repo uses tabs.' }),
          row({ id: 10, project_id: 'project_old', status: 'archived', lesson_text: 'Drafting a toast.', scope_session_id: 'chat-9' }),
        ] };
      },
      async restore(request) {
        calls.push(request);
        return { ok: true, status: 'saved', memory: row({ id: 9, project_id: request.targetProjectId }) };
      },
    },
  });
  const doc = window.document;
  const tab = doc.querySelector('[data-memory-scope="project_old"]');
  assert.match(tab.textContent, /Deleted project/);
  tab.click();
  await waitForUi(window, 40);
  doc.querySelector('[data-memory-fold="memoryForgottenFold"]').click();
  await waitForUi(window, 80);
  const host = doc.getElementById('memoryForgottenHost');
  assert.match(host.textContent, /This project was deleted/);
  assert.equal(host.querySelector('[data-memory-page-action="restore"]'), null, 'no plain Restore on a deleted project');
  assert.equal(host.querySelector('[data-memory-page-action="restore-to"][data-memory-id="10"]'), null, 'a chat note can only be erased');
  assert.ok(host.querySelector('[data-memory-page-action="erase"][data-memory-id="10"]'));

  const restoreTo = host.querySelector('[data-memory-page-action="restore-to"][data-memory-id="9"]');
  assert.equal(restoreTo.getAttribute('aria-haspopup'), 'menu');
  restoreTo.click();
  await waitForUi(window, 40);
  const items = [...doc.querySelectorAll('[role="menu"][aria-label="Restore to project"] [role="menuitem"]')];
  assert.deepEqual(items.map((item) => item.textContent.trim()), ['General', 'Garden']);
  items[1].click();
  await waitForUi(window, 80);
  assert.deepEqual(plain(calls), [{ projectId: 'project_old', memoryId: 9, targetProjectId: 'project_garden' }]);
  assert.match(toasts(window), /Restored to Garden\./);
});
