const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getApprovedMemoryKindLabel,
  getApprovedMemoryKindOptions,
} = require('../renderer/features/renderer-memory-utils.js');
const {
  normalizeMemoryStatus,
  buildMemoryHealthMessages,
} = require('../renderer/features/renderer-memory-settings-utils.js');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

async function openMemorySettings(window, settleMs = 80) {
  const doc = window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  const memoryNav = doc.getElementById('settingsNav-memories');
  assert.ok(memoryNav, 'Settings renders a Memory category');
  memoryNav.click();
  await waitForUi(window, settleMs);
}

// The harness bridge stub has no ledger methods (undoChange, acceptPending), so tests install them on the bridge.
function installLedgerBridge(window, methods) {
  Object.assign(window.jennyShell.memory, methods);
}

// Forget is the ⋯ menu's second item on a memory row (row 58 W4 page).
async function forgetFirstMemory(window) {
  window.document.querySelector('#approvedMemoryList [data-memory-page-action="menu"]').click();
  await waitForUi(window, 10);
  const item = [...window.document.querySelectorAll('.inv-context-menu-item')].find((node) => /Forget/.test(node.textContent));
  assert.ok(item, 'the ⋯ menu offers Forget');
  item.click();
}

test('renderer memory kind labels are the schema v9 kinds', () => {
  assert.deepEqual(
    getApprovedMemoryKindOptions().map((option) => [option.value, option.label]),
    [
      ['all', 'All'],
      ['preference', 'Preference'],
      ['fact', 'Fact'],
      ['decision', 'Decision'],
      ['convention', 'Convention'],
      ['person', 'Person'],
      ['routine', 'Routine'],
      ['lesson', 'Lesson'],
    ]
  );
  assert.equal(getApprovedMemoryKindLabel('routine'), 'Routine');
  assert.equal(getApprovedMemoryKindLabel('person'), 'Person');
  assert.equal(getApprovedMemoryKindLabel('lesson'), 'Lesson');
});

test('Memory page renders the three memory v2 switches and saves one through the features bridge', async () => {
  const calls = [];
  const app = await loadRendererApp({
    shell: {
      memory: {
        async listApproved() { return { memories: [] }; },
        async listPending() { return { candidates: [] }; },
      },
      features: {
        async updateSettings(patch) {
          calls.push(patch);
          return { memory: { takeNotes: true, askBeforeSaving: false, pauseSaving: patch.memory?.pauseSaving === true, useInChats: true } };
        },
      },
    },
  });
  const { window } = app;
  try {
    await openMemorySettings(window, 40);
    const doc = window.document;
    const checked = (id) => doc.querySelector(`#memoryPolicyHost [data-inv-toggle="${id}"]`)?.getAttribute('aria-checked');
    assert.deepEqual(['memoryTakeNotes', 'memoryAskBeforeSaving', 'memoryPauseSaving', 'memoryUseInChats'].map(checked), ['true', 'false', 'false', 'true']);
    doc.getElementById('memorySettingsSection').dispatchEvent(new window.CustomEvent(
      'inv-toggle-change',
      { bubbles: true, detail: { id: 'memoryPauseSaving', checked: true } }
    ));
    await waitForUi(window, 80);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ memory: { pauseSaving: true } }]);
    assert.equal(window.__rendererState.features.memory.pauseSaving, true);
    assert.equal(checked('memoryPauseSaving'), 'true');
  } finally {
    await app.dispose();
  }
});

test('memory status normalization bounds reasons and maps known health conditions', () => {
  const status = normalizeMemoryStatus({
    available: true,
    schema_version: 7,
    recall_index: 'bounded_scan',
    counts: { approved: 4, pending: 2, quarantined: 1 },
    storage: { state: 'blocked', physical_bytes: 60, capacity_bytes: 50 * 1024 * 1024 },
    degraded_reasons: ['CMP-MEM-0008', 'CMP-MEM-0008', 'CMP-MEM-0007', 'recall_partial'],
  });
  assert.deepEqual(status.degradedReasons, ['CMP-MEM-0008', 'CMP-MEM-0007', 'recall_partial']);
  assert.equal(status.counts.approved, 4);
  assert.match(buildMemoryHealthMessages(status).join(' '), /1 memory record needs review/i);
  assert.match(buildMemoryHealthMessages(status).join(' '), /50 MB capacity/i);
  assert.equal(normalizeMemoryStatus({ available: true, counts: { approved: -1, pending: 0 } }), null);
  assert.equal(normalizeMemoryStatus({
    available: true,
    counts: { approved: '4', pending: 0 },
    storage: { state: 'ok' },
  }), null, 'numeric strings must not be coerced into trusted status counts');
  assert.equal(normalizeMemoryStatus({
    available: true,
    counts: { approved: 4, pending: 0 },
    storage: { state: 'ok', physical_bytes: false },
  }), null, 'malformed storage values must reject the snapshot');
  assert.equal(normalizeMemoryStatus({
    available: true,
    counts: { approved: 4, pending: 0 },
    storage: { state: 'ok' },
    degraded_reasons: ['recall_partial', { code: 'private-detail' }],
  }), null, 'non-string degraded reasons must reject the snapshot');
  const boundedReasons = normalizeMemoryStatus({
    available: true,
    counts: { approved: 4, pending: 0 },
    storage: { state: 'ok' },
    degraded_reasons: Array.from({ length: 100 }, (_value, index) => `reason-${index}`),
  });
  assert.equal(boundedReasons.degradedReasons.length, 8);
});

test('Settings Memory category owns the memory admin surface', async () => {
  const app = await loadRendererApp({
    shell: {
      memory: {
        async listApproved() {
          return { memories: [] };
        },
        async listPending() {
          return { candidates: [] };
        },
      },
    },
  });
  const { window } = app;

  try {
    await openMemorySettings(window, 40);

    const memorySettings = window.document.getElementById('memorySettingsSection');
    assert.equal(window.__rendererState.ui.activeView, 'settings');
    assert.equal(window.__rendererState.ui.activeSettingsSection, 'memories');
    assert.equal(memorySettings.classList.contains('settings-section-active'), true);
    assert.ok(window.document.getElementById('approvedMemoryStatus'));
    assert.ok(window.document.getElementById('memoryManagerSearchInput'));
    assert.ok(window.document.getElementById('memoryManagerKindFilter'));
    assert.equal(window.document.getElementById('memoryManagerProjectFilter'), null, 'scope tabs replace the project filter');
    assert.equal(window.document.querySelector('#memoryTabsHost [role="tablist"] [data-memory-scope="project_general"]')?.getAttribute('aria-selected'), 'true');
    assert.equal(window.document.getElementById('memoryTopRailTab'), null);
    assert.equal(window.document.getElementById('memoryPageHeading').tabIndex, -1);
    assert.equal(window.document.getElementById('approvedMemoryStatus').getAttribute('role'), 'status');
    assert.equal(window.document.getElementById('approvedMemoryStatus').getAttribute('aria-live'), 'polite');
    assert.equal(window.document.getElementById('pendingMemoryHost').hidden, true, 'no proposals, no pending group');
    assert.equal(window.document.getElementById('memoryNotesFieldHost'), null, 'the inline notes editor is gone');
    assert.equal(memorySettings.dataset.settingsSection, 'memories');
    assert.equal(memorySettings.dataset.settingsField, 'memoryManager');
    assert.equal(memorySettings.querySelector('h3')?.id, 'memoryPageHeading');
    assert.equal(memorySettings.querySelectorAll('h5').length, 0);
  } finally {
    await app.dispose();
  }
});

test('Memory status uses authoritative counts and bounded degraded guidance', async () => {
  const app = await loadRendererApp({
    shell: {
      memory: {
        async status() {
          return {
            available: true,
            schema_version: 7,
            recall_index: 'bounded_scan',
            counts: { approved: 4, pending: 2, quarantined: 1 },
            storage: { state: 'ready', physical_bytes: 12, capacity_bytes: 50 * 1024 * 1024 },
            degraded_reasons: ['CMP-MEM-0008', 'recall_index_unavailable', 'unexpected_provider_detail'],
          };
        },
        async listApproved() { return { memories: [] }; },
        async listPending() { return { candidates: [] }; },
      },
    },
  });
  try {
    await openMemorySettings(app.window);
    const doc = app.window.document;
    assert.equal(doc.getElementById('memoryBadge').textContent.trim(), '4 saved');
    assert.equal(doc.getElementById('memoryBadge').dataset.state, 'warn');
    assert.match(doc.getElementById('memoryHealthNote').textContent, /needs review/i);
    assert.match(doc.getElementById('memoryHealthNote').textContent, /Fast recall indexing/i);
    assert.match(doc.getElementById('memoryHealthNote').textContent, /open Diagnostics/i);
    assert.doesNotMatch(doc.getElementById('memoryHealthNote').textContent, /unexpected_provider_detail/i);
  } finally {
    await app.dispose();
  }
});

test('failed status refresh keeps records and falls back to list-derived counts', async () => {
  let statusCalls = 0;
  const memory = {
    id: 1,
    session_id: 'session-approved',
    title: 'Preference: tea',
    lesson_text: 'The user prefers tea.',
    lesson_kind: 'preference',
    content_fingerprint: `sha256:${'8'.repeat(64)}`,
  };
  const app = await loadRendererApp({
    shell: {
      memory: {
        async status() {
          statusCalls += 1;
          if (statusCalls > 1) throw new Error('sidecar offline');
          return {
            available: true,
            counts: { approved: 99, pending: 0 },
            storage: { state: 'ready' },
            degraded_reasons: [],
          };
        },
        async listApproved() { return { memories: [memory] }; },
        async listPending() { return { candidates: [] }; },
        async delete() { return { deleted: true, memory_id: memory.id }; },
      },
    },
  });
  const { window } = app;

  try {
    await openMemorySettings(window);
    assert.equal(window.document.getElementById('memoryBadge').textContent.trim(), '99 saved');
    await forgetFirstMemory(window);
    await waitForUi(window, 80);
    assert.equal(window.document.querySelectorAll('#approvedMemoryList > article').length, 1);
    assert.equal(window.document.getElementById('memoryBadge').dataset.state, 'error');
    assert.match(window.document.getElementById('memoryHealthNote').textContent, /health details are unavailable/i);
  } finally {
    await app.dispose();
  }
});

test('synchronous status bridge failure settles unavailable without clearing loaded records', async () => {
  const memory = {
    id: 1,
    session_id: 'session-approved',
    title: 'Preference: tea',
    lesson_text: 'The user prefers tea.',
    lesson_kind: 'preference',
    content_fingerprint: `sha256:${'7'.repeat(64)}`,
  };
  const app = await loadRendererApp({
    shell: {
      memory: {
        status() { throw new Error('synchronous bridge failure'); },
        async listApproved() { return { memories: [memory] }; },
        async listPending() { return { candidates: [] }; },
      },
    },
  });
  try {
    await openMemorySettings(app.window);
    assert.equal(app.window.__rendererState.memoryManager.statusLoading, false);
    assert.equal(app.window.__rendererState.memoryManager.statusUnavailable, true);
    assert.equal(app.window.document.querySelectorAll('#approvedMemoryList > article').length, 1);
    assert.equal(app.window.document.getElementById('memoryBadge').dataset.state, 'error');
  } finally {
    await app.dispose();
  }
});

test('revisiting Memory forces fresh approved, pending, and status snapshots', async () => {
  const calls = { approved: 0, pending: 0, status: 0 };
  const app = await loadRendererApp({
    shell: {
      memory: {
        async status() {
          calls.status += 1;
          return { available: true, counts: { approved: 0, pending: 0 }, storage: { state: 'ok' } };
        },
        async listApproved() { calls.approved += 1; return { memories: [] }; },
        async listPending() { calls.pending += 1; return { candidates: [] }; },
      },
    },
  });
  try {
    await openMemorySettings(app.window);
    const initialCalls = { ...calls };
    assert.ok(initialCalls.approved >= 1);
    assert.ok(initialCalls.pending >= 1);
    assert.ok(initialCalls.status >= 1);
    app.window.document.getElementById('settingsNav-account').click();
    await waitForUi(app.window, 30);
    app.window.document.getElementById('settingsNav-memories').click();
    await waitForUi(app.window, 80);
    assert.deepEqual(calls, {
      approved: initialCalls.approved + 1,
      pending: initialCalls.pending + 1,
      status: initialCalls.status + 1,
    });
  } finally {
    await app.dispose();
  }
});

test('Memory page rejects false-success review responses and leaves candidates actionable', async () => {
  const candidate = {
    id: 501,
    session_id: 'session-review',
    title: 'Goal: ship Jenny',
    lesson_text: 'The user wants to ship Jenny.',
    lesson_kind: 'goal',
    confidence: 0.92,
    source_excerpt: 'I want to ship Jenny.',
    content_fingerprint: 'sha256:' + 'e'.repeat(64),
    created_at: '2026-08-16T13:00:00.000Z',
    updated_at: '2026-08-16T13:00:00.000Z',
  };
  const app = await loadRendererApp({
    shell: {
      memory: {
        async listApproved() { return { memories: [] }; },
        async listPending() { return { candidates: [candidate] }; },
        async deletePending() { return { deleted: false }; },
      },
    },
  });
  const { window } = app;
  const doc = window.document;
  installLedgerBridge(window, { async acceptPending() { return { accepted: false }; } });

  try {
    await openMemorySettings(window);

    doc.querySelector('[data-pending-memory-action="approve"]').click();
    await waitForUi(window, 40);
    assert.match(doc.getElementById('toastViewport').textContent, /Memory Review Failed/i);
    assert.ok(doc.querySelector('[data-pending-memory-action="approve"]'));

    doc.querySelector('[data-pending-memory-action="discard"]').click();
    await waitForUi(window, 40);
    assert.match(doc.getElementById('toastViewport').textContent, /Memory Review Failed/i);
    assert.ok(doc.querySelector('[data-pending-memory-action="discard"]'));
  } finally {
    await app.dispose();
  }
});

test('Memory delete undo rejects an unavailable false-success restore', async () => {
  const memory = {
    id: 1,
    session_id: 'session-approved',
    title: 'Preference: tea',
    lesson_text: 'The user prefers tea.',
    lesson_kind: 'preference',
    confidence: 0.9,
    source_excerpt: 'I prefer tea.',
    content_fingerprint: 'sha256:' + 'f'.repeat(64),
  };
  const app = await loadRendererApp({
    shell: {
      memory: {
        async listApproved() { return { memories: [memory] }; },
        async listPending() { return { candidates: [] }; },
        async delete() { return { deleted: true, memory_id: memory.id, operation_id: 'rpc:del1', undoable: true }; },
      },
    },
  });
  const { window } = app;
  const doc = window.document;
  installLedgerBridge(window, { async undoChange() { return { status: 'refused', reason: 'sidecar_unavailable' }; } });

  try {
    await openMemorySettings(window);
    await forgetFirstMemory(window);
    await waitForUi(window, 50);
    doc.querySelector('[data-toast-action-id="undo-delete"]').click();
    await waitForUi(window, 40);

    assert.match(doc.getElementById('toastViewport').textContent, /Undo Failed/i);
    assert.doesNotMatch(doc.getElementById('toastViewport').textContent, /Undo Successful/i);
  } finally {
    await app.dispose();
  }
});

test('Memory page reports malformed partial results instead of treating them as empty success', async () => {
  const app = await loadRendererApp({
    shell: {
      memory: {
        async status() { return { available: true, counts: { approved: 'bad' } }; },
        async listApproved() {
          return {
            memories: [{
              id: 1,
              title: 'Preference: concise replies',
              lesson_text: 'The user prefers concise replies.',
              lesson_kind: 'preference',
              content_fingerprint: `sha256:${'c'.repeat(64)}`,
            }],
          };
        },
        async listPending() { return { candidates: 'not-an-array' }; },
      },
    },
  });
  const { window } = app;

  try {
    await openMemorySettings(window);
    assert.equal(window.document.querySelectorAll('#approvedMemoryList > article').length, 1);
    assert.match(window.document.getElementById('memorySummary').textContent, /partially available/i);
    assert.match(window.document.getElementById('memoryHealthNote').textContent, /health details are unavailable/i);
    assert.match(window.document.getElementById('memoryHealthNote').textContent, /could not be loaded/i);
    assert.equal(window.document.getElementById('pendingMemoryHost').hidden, true);
  } finally {
    await app.dispose();
  }
});

test('Memory page reports unavailable managed-sidecar reads without presenting an empty success', async () => {
  const app = await loadRendererApp({
    shell: {
      memory: {
        async listApproved() { throw new Error('sidecar offline'); },
        async listPending() { throw new Error('sidecar offline'); },
      },
    },
  });
  const { window } = app;

  try {
    await openMemorySettings(window);
    assert.match(window.document.getElementById('memorySummary').textContent, /unavailable/i);
    assert.match(window.document.getElementById('approvedMemoryStatus').textContent, /unavailable/i);
    assert.equal(window.document.querySelectorAll('#approvedMemoryList > article').length, 0);
    assert.equal(window.document.getElementById('pendingMemoryHost').hidden, true);
  } finally {
    await app.dispose();
  }
});

test('Memory page ignores a superseded approved-memory response after disposal', async () => {
  let resolveApproved;
  const approvedResponse = new Promise((resolve) => { resolveApproved = resolve; });
  const app = await loadRendererApp({
    shell: {
      memory: {
        async listApproved() { return approvedResponse; },
        async listPending() { return { candidates: [] }; },
      },
    },
  });
  const { window } = app;

  await openMemorySettings(window, 30);
  assert.match(window.document.getElementById('approvedMemoryStatus').textContent, /loading/i);
  await window.__disposeRenderer();
  resolveApproved({
    memories: [{
      id: 99,
      title: 'Late memory',
      lesson_text: 'This response arrived after disposal.',
      lesson_kind: 'project_context',
      content_fingerprint: `sha256:${'d'.repeat(64)}`,
    }],
  });
  await waitForUi(window, 30);
  assert.doesNotMatch(window.document.getElementById('approvedMemoryList').textContent, /Late memory/);
  await app.dispose();
});

test('Memory status queues one forced refresh and ignores a late response after disposal', async () => {
  let statusCalls = 0;
  const statusResolvers = [];
  const memory = {
    id: 1,
    session_id: 'session-approved',
    title: 'Preference: tea',
    lesson_text: 'The user prefers tea.',
    lesson_kind: 'preference',
    content_fingerprint: `sha256:${'9'.repeat(64)}`,
  };
  const app = await loadRendererApp({
    shell: {
      memory: {
        async status() {
          statusCalls += 1;
          return new Promise((resolve) => statusResolvers.push(resolve));
        },
        async listApproved() { return { memories: [memory] }; },
        async listPending() { return { candidates: [] }; },
        async delete() { return { deleted: true, memory_id: memory.id }; },
      },
    },
  });
  const { window } = app;

  await openMemorySettings(window, 40);
  await forgetFirstMemory(window);
  await waitForUi(window, 40);
  assert.equal(statusCalls, 1, 'forced refresh should queue behind the in-flight status request');

  statusResolvers.shift()({
    available: true,
    counts: { approved: 1, pending: 0 },
    storage: { state: 'ready' },
    degraded_reasons: [],
  });
  await waitForUi(window, 40);
  assert.equal(statusCalls, 2, 'only one queued forced refresh should start');

  await window.__disposeRenderer();
  statusResolvers.shift()({
    available: true,
    counts: { approved: 99, pending: 99 },
    storage: { state: 'ready' },
    degraded_reasons: [],
  });
  await waitForUi(window, 30);
  assert.notEqual(window.__rendererState.memoryManager.statusSnapshot?.counts?.approved, 99);
  await app.dispose();
});

// Forget needs no confirmation (Undo and the Forgotten fold bring it back);
// Undo closes the toast it was clicked on (the store dismisses by toast id).
test('Memory Forget shows an Undo toast and Undo closes it', async (t) => {
  const memory = {
    id: 1,
    session_id: 'session-approved',
    title: 'Preference: tea',
    lesson_text: 'The user prefers tea.',
    lesson_kind: 'preference',
    confidence: 0.9,
    content_fingerprint: 'sha256:' + 'f'.repeat(64),
  };
  const app = await loadRendererApp({
    shell: {
      memory: {
        async listApproved() { return { memories: [memory] }; },
        async listPending() { return { candidates: [] }; },
        async delete() { return { deleted: true, memory_id: memory.id, operation_id: 'rpc:del1', undoable: true }; },
      },
    },
  });
  t.after(async () => { await app.dispose(); });
  const { window } = app;
  const doc = window.document;
  const toastText = () => doc.getElementById('toastViewport').textContent;
  installLedgerBridge(window, { async undoChange() { return { status: 'saved' }; } });
  await openMemorySettings(window);
  await forgetFirstMemory(window);
  await waitForUi(window, 50);
  assert.doesNotMatch(toastText(), /Confirm/i, 'Forget asks no confirmation');
  assert.match(toastText(), /Memory Forgotten/i, 'precondition: the undo toast is shown');
  doc.querySelector('[data-toast-action-id="undo-delete"]').click();
  await waitForUi(window, 50);
  assert.match(toastText(), /Undo Successful/i, 'precondition: the restore succeeded');
  assert.doesNotMatch(toastText(), /Memory Forgotten/i, 'Undo closes the undo toast');
});
