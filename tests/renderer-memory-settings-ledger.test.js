const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

// Settings memory edits go through the ledger (memory v2, row 58 W1b): edits and
// deletes carry the row revision, a stale revision keeps the draft, Undo inverts
// the recorded delete, and Approve resolves the queued row sidecar-side.

async function openMemorySettings(window) {
  const doc = window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  doc.getElementById('settingsNav-memories').click();
  await waitForUi(window, 80);
}

// The harness bridge stub drops the trailing options argument and has no ledger
// methods, so the methods under test are installed on the bridge itself.
async function loadMemoryApp(t, { approved, pending = [], bridge }) {
  const app = await loadRendererApp({
    shell: {
      memory: {
        listApproved: approved,
        async listPending() { return { candidates: pending }; },
      },
    },
  });
  t.after(async () => { await app.dispose(); });
  Object.assign(app.window.jennyShell.memory, bridge);
  return app;
}

function approvedRow(overrides = {}) {
  return {
    id: 1,
    session_id: 'session-approved',
    project_id: 'project_garden',
    title: 'Preference: tea',
    lesson_text: 'The user prefers tea.',
    lesson_kind: 'preference',
    confidence: 0.9,
    source_excerpt: '',
    provenance: 'user_approved',
    content_fingerprint: `sha256:${'f'.repeat(64)}`,
    revision: 2,
    created_at: '2026-08-16T12:00:00.000Z',
    updated_at: '2026-08-16T12:00:00.000Z',
    ...overrides,
  };
}

const pendingCandidate = () => ({
  id: 501,
  session_id: 'session-approve',
  project_id: 'project_garden',
  title: 'Goal: ship Jenny',
  lesson_text: 'The user wants to ship Jenny.',
  lesson_kind: 'lesson',
  confidence: 0.92,
  source_excerpt: '',
  content_fingerprint: `sha256:${'a'.repeat(64)}`,
  created_at: '2026-08-16T13:00:00.000Z',
  updated_at: '2026-08-16T13:00:00.000Z',
});

const plain = (value) => JSON.parse(JSON.stringify(value));
const toasts = (window) => window.document.getElementById('toastViewport').textContent;

// Row actions live in the ⋯ menu (row 58 W4 page); Forget asks no confirmation.
async function pickMenuItem(window, memoryId, labelPattern) {
  window.document.querySelector(`[data-memory-page-action="menu"][data-memory-id="${memoryId}"]`).click();
  await waitForUi(window, 10);
  const item = [...window.document.querySelectorAll('.inv-context-menu-item')].find((node) => labelPattern.test(node.textContent));
  assert.ok(item, `the ⋯ menu offers ${labelPattern}`);
  item.click();
}

async function forget(window) {
  await pickMenuItem(window, 1, /^\s*Forget\s*$/);
  await waitForUi(window, 60);
}

test('a stale edit keeps the draft, shows the conflict copy and retries with the refreshed revision', async (t) => {
  const updates = [];
  let listCalls = 0;
  const { window } = await loadMemoryApp(t, {
    async approved() {
      listCalls += 1;
      return { memories: [updates.length === 0 ? approvedRow() : approvedRow({ revision: 3, lesson_text: 'The user prefers green tea.' })] };
    },
    bridge: {
      async update(memoryId, patch, projectId, options) {
        updates.push({ memoryId, patch, projectId, options });
        if (updates.length === 1) {
          return { updated: false, status: 'conflict', reason: 'stale_revision', memory: approvedRow({ revision: 3 }) };
        }
        return { updated: true, status: 'saved', memory: approvedRow({ revision: 4 }) };
      },
    },
  });
  const doc = window.document;
  await openMemorySettings(window);

  await pickMenuItem(window, 1, /Edit/);
  await waitForUi(window, 30);
  const text = doc.querySelector('[data-memory-draft-field="lesson_text"][data-memory-id="1"]');
  text.value = 'The user prefers oolong.';
  text.dispatchEvent(new window.Event('input', { bubbles: true }));
  const listsBeforeSave = listCalls;
  doc.querySelector('[data-memory-action="save"][data-memory-id="1"]').click();
  await waitForUi(window, 80);

  assert.deepEqual(plain(updates[0].options), { expectedRevision: 2 });
  assert.deepEqual(plain(updates[0].patch), { lesson_text: 'The user prefers oolong.' }, 'the page edits the text only');
  assert.equal(updates[0].projectId, 'project_garden');
  assert.match(toasts(window), /This memory changed somewhere else, so your edit wasn't saved/);
  assert.match(toasts(window), /Memory Changed/);
  assert.doesNotMatch(toasts(window), /Memory Update Failed/);
  assert.ok(listCalls > listsBeforeSave, 'the approved list is refreshed after a conflict');
  assert.equal(
    doc.querySelector('[data-memory-draft-field="lesson_text"][data-memory-id="1"]')?.value,
    'The user prefers oolong.',
    'the draft and the open editor survive the conflict',
  );

  doc.querySelector('[data-memory-action="save"][data-memory-id="1"]').click();
  await waitForUi(window, 80);
  assert.deepEqual(plain(updates[1].options), { expectedRevision: 3 });
});

test('delete carries the revision and Undo inverts the recorded delete in the row project', async (t) => {
  const calls = { deletes: [], undos: [], saves: 0 };
  const { window } = await loadMemoryApp(t, {
    async approved() { return { memories: [approvedRow()] }; },
    bridge: {
      async delete(memoryId, projectId, options) {
        calls.deletes.push({ memoryId, projectId, options });
        return { deleted: true, memory_id: memoryId, status: 'saved', operation_id: 'rpc:del1', undoable: true };
      },
      async undoChange(operationId, projectId) {
        calls.undos.push({ operationId, projectId });
        return { status: 'saved', operation_id: 'ui:u1' };
      },
      async save() { calls.saves += 1; return { created: true, memory: approvedRow() }; },
    },
  });
  await openMemorySettings(window);

  await forget(window);
  assert.deepEqual(plain(calls.deletes), [{ memoryId: 1, projectId: 'project_garden', options: { expectedRevision: 2 } }]);
  window.document.querySelector('[data-toast-action-id="undo-delete"]').click();
  await waitForUi(window, 60);

  assert.deepEqual(calls.undos, [{ operationId: 'rpc:del1', projectId: 'project_garden' }]);
  assert.equal(calls.saves, 0, 'Undo never re-saves a snapshot');
  assert.match(toasts(window), /Undo Successful/);
});

test('a delete without an undoable operation offers no Undo and a conflicting delete says so', async (t) => {
  let deleteCalls = 0;
  const { window } = await loadMemoryApp(t, {
    async approved() { return { memories: [approvedRow()] }; },
    bridge: {
      async delete() {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          return { deleted: false, status: 'conflict', reason: 'stale_revision', memory: approvedRow({ revision: 3 }) };
        }
        return { deleted: true, memory_id: 1, status: 'saved' };
      },
    },
  });
  await openMemorySettings(window);

  await forget(window);
  assert.match(toasts(window), /so it wasn't deleted/);
  assert.doesNotMatch(toasts(window), /Memory Delete Failed/);

  await forget(window);
  assert.match(toasts(window), /Memory Forgotten/);
  assert.equal(window.document.querySelector('[data-toast-action-id="undo-delete"]'), null);
});

test('a refused Undo reports the failure', async (t) => {
  const { window } = await loadMemoryApp(t, {
    async approved() { return { memories: [approvedRow()] }; },
    bridge: {
      async delete() { return { deleted: true, memory_id: 1, status: 'saved', operation_id: 'rpc:del1', undoable: true }; },
      async undoChange() { return { status: 'refused', reason: 'not_found' }; },
    },
  });
  await openMemorySettings(window);
  await forget(window);
  window.document.querySelector('[data-toast-action-id="undo-delete"]').click();
  await waitForUi(window, 60);
  assert.match(toasts(window), /Undo Failed/);
  assert.doesNotMatch(toasts(window), /Undo Successful/);
});

test('Approve resolves the queued row through acceptPending and reports a refusal in plain words', async (t) => {
  const accepts = [];
  const answers = [
    { accepted: true, status: 'saved', memory: approvedRow(), operation_id: 'rpc:acc1' },
    { accepted: false, status: 'refused', reason: 'suppressed' },
    { accepted: false, status: 'refused', reason: 'not_found' },
  ];
  let saves = 0;
  let pendingLists = 0;
  const { window } = await loadMemoryApp(t, {
    async approved() { return { memories: [] }; },
    bridge: {
      async listPending() { pendingLists += 1; return { candidates: [pendingCandidate()] }; },
      async acceptPending(sessionId, fingerprint, projectId) {
        accepts.push({ sessionId, fingerprint, projectId });
        return answers.shift();
      },
      async save() { saves += 1; return { created: true, memory: approvedRow() }; },
    },
  });
  await openMemorySettings(window);
  const approve = () => window.document
    .querySelector('[data-pending-memory-action="approve"][data-session-id="session-approve"]').click();

  approve();
  await waitForUi(window, 60);
  assert.deepEqual(plain(accepts), [{
    sessionId: 'session-approve',
    fingerprint: `sha256:${'a'.repeat(64)}`,
    projectId: 'project_garden',
  }], 'Approve names the queued row project, so a moved chat still resolves');
  assert.equal(saves, 0, 'Approve no longer re-saves the candidate');
  assert.doesNotMatch(toasts(window), /Memory Review/);

  const listsBefore = pendingLists;
  approve();
  await waitForUi(window, 60);
  assert.match(toasts(window), /You asked me to forget this, so I didn't save it\./);
  assert.ok(pendingLists > listsBefore, 'a refused candidate may be gone, so the pending list is refreshed');

  approve();
  await waitForUi(window, 60);
  assert.match(toasts(window), /This memory can no longer be saved\./);
  assert.doesNotMatch(toasts(window), /Memory Review Failed/);
});

test('Approve without the acceptPending bridge reports the review as failed', async (t) => {
  const { window } = await loadMemoryApp(t, {
    async approved() { return { memories: [] }; },
    pending: [pendingCandidate()],
    bridge: {},
  });
  await openMemorySettings(window);
  window.document.querySelector('[data-pending-memory-action="approve"]').click();
  await waitForUi(window, 60);
  assert.match(toasts(window), /Memory Review Failed/);
});
