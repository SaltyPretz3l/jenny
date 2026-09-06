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

test('renderer memory kind labels include new approved memory kinds', () => {
  assert.deepEqual(
    getApprovedMemoryKindOptions().map((option) => [option.value, option.label]),
    [
      ['all', 'All'],
      ['profile', 'Profile'],
      ['preference', 'Preference'],
      ['response_style', 'Response Style'],
      ['tool_strategy', 'Tool Strategy'],
      ['working_preference', 'Working Preference'],
      ['project_context', 'Project Context'],
      ['routine', 'Routine'],
      ['goal', 'Goal'],
      ['important_person', 'People'],
    ]
  );
  assert.equal(getApprovedMemoryKindLabel('routine'), 'Routine');
  assert.equal(getApprovedMemoryKindLabel('goal'), 'Goal');
  assert.equal(getApprovedMemoryKindLabel('important_person'), 'People');
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
    assert.ok(window.document.getElementById('pendingMemoryStatus'));
    assert.ok(window.document.getElementById('memoryManagerSearchInput'));
    assert.ok(window.document.getElementById('memoryManagerKindFilter'));
    assert.equal(window.document.getElementById('memoryTopRailTab'), null);
    assert.equal(window.document.getElementById('memoryPageHeading').tabIndex, -1);
    assert.equal(window.document.getElementById('approvedMemoryStatus').getAttribute('role'), 'status');
    assert.equal(window.document.getElementById('pendingMemoryStatus').getAttribute('aria-live'), 'polite');
    assert.equal(memorySettings.dataset.settingsSection, 'memories');
    assert.equal(memorySettings.dataset.settingsField, 'memoryManager');
    assert.equal(memorySettings.querySelector('[aria-labelledby="approvedMemoryHeading"]').hasAttribute('data-settings-field'), false);
    assert.equal(memorySettings.querySelector('h3')?.id, 'memoryPageHeading');
    assert.equal(memorySettings.querySelectorAll('h5').length, 0);
    assert.equal(window.document.querySelector('#approvedMemoryList > .memory-page-empty')?.getAttribute('role'), 'listitem');
    assert.equal(window.document.querySelector('#pendingMemoryList > .memory-page-empty')?.getAttribute('role'), 'listitem');
  } finally {
    await app.dispose();
  }
});

test('Memory page supports bounded expansion, review actions, and source removal', async () => {
  const approved = Array.from({ length: 201 }, (_entry, index) => ({
    id: index + 1,
    session_id: 'session-approved',
    title: index === 0 ? 'Preference: tea' : `Memory ${index + 1}`,
    lesson_text: index === 0 ? 'The user prefers tea.' : `The user prefers item ${index + 1}.`,
    lesson_kind: index === 0 ? 'preference' : 'project_context',
    confidence: 0.9,
    source_excerpt: index === 0 ? 'I prefer tea while coding.' : '',
    provenance: index === 1 ? 'source_removed' : 'user_approved',
    content_fingerprint: `sha256:${String(index + 1).padStart(64, '0')}`,
    created_at: '2026-08-16T12:00:00.000Z',
    updated_at: `2026-08-16T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
  }));
  const pending = [
    {
      id: 501,
      session_id: 'session-approve',
      title: 'Goal: ship Jenny',
      lesson_text: 'The user wants to ship Jenny.',
      lesson_kind: 'goal',
      confidence: 0.92,
      source_excerpt: 'I want to ship Jenny.',
      content_fingerprint: 'sha256:' + 'a'.repeat(64),
      created_at: '2026-08-16T13:00:00.000Z',
      updated_at: '2026-08-16T13:00:00.000Z',
    },
    {
      id: 502,
      session_id: 'session-dismiss',
      title: 'Routine: tea',
      lesson_text: 'The user drinks tea each morning.',
      lesson_kind: 'routine',
      confidence: 0.8,
      source_excerpt: 'I drink tea each morning.',
      content_fingerprint: 'sha256:' + 'b'.repeat(64),
      created_at: '2026-08-16T12:00:00.000Z',
      updated_at: '2026-08-16T12:00:00.000Z',
    },
  ];
  const calls = { status: 0, updates: [], saves: [], deletes: [], dismisses: [] };
  const app = await loadRendererApp({
    shell: {
      memory: {
        async status() {
          calls.status += 1;
          return {
            available: true,
            counts: { approved: approved.length, pending: pending.length },
            storage: { state: 'ready' },
            degraded_reasons: [],
          };
        },
        async listApproved() { return { memories: approved }; },
        async listPending() { return { candidates: pending }; },
        async update(memoryId, patch) {
          calls.updates.push({ memoryId, patch });
          return { updated: true, memory: { ...approved[0], ...patch, source_excerpt: '' } };
        },
        async save(sessionId, candidate) {
          calls.saves.push({ sessionId, candidate });
          return { created: true, memory: candidate };
        },
        async delete(memoryId) {
          calls.deletes.push(memoryId);
          return { deleted: true, memory_id: memoryId };
        },
        async deletePending(sessionId, fingerprint) {
          calls.deletes.push({ sessionId, fingerprint });
          return { deleted: true };
        },
        async dismiss(fingerprint) {
          calls.dismisses.push(fingerprint);
          return { dismissed: true };
        },
      },
    },
  });
  const { window } = app;
  const doc = window.document;

  try {
    await openMemorySettings(window);

    assert.equal(doc.querySelectorAll('#approvedMemoryList > article.memory-record').length, 200);
    assert.equal(doc.querySelector('#approvedMemoryList > article')?.getAttribute('role'), 'listitem');
    assert.ok(doc.querySelector('#approvedMemoryList .inv-badge--muted'));
    assert.match(doc.querySelector('#approvedMemoryList [data-inv-collapsible]')?.textContent || '', /Source · 2026-08-16/);
    assert.match(doc.querySelector('[data-memory-id="2"]')?.textContent || '', /Source removed; memory retained/i);
    assert.equal(doc.querySelector('[data-memory-id="2"] [data-inv-collapsible]'), null);
    assert.equal(calls.status, 1);
    doc.querySelector('[data-memory-page-action="show-more-approved"]').click();
    await waitForUi(window, 30);
    assert.equal(doc.querySelectorAll('#approvedMemoryList > article.memory-record').length, 201);
    assert.equal(doc.querySelector('[data-inv-toggle="memoryCaptureSuggestions"]')?.getAttribute('aria-checked'), 'true');

    doc.querySelector('[data-memory-action="remove-provenance"][data-memory-id="1"]').click();
    await waitForUi(window, 80);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.updates[0])), {
      memoryId: 1,
      patch: {
        title: 'Preference: tea',
        lesson_text: 'The user prefers tea.',
        remove_provenance: true,
      },
    });
    assert.equal(calls.status, 1, 'source removal must keep status refresh list-only');

    doc.querySelector('[data-memory-action="edit"][data-memory-id="2"]').click();
    await waitForUi(window, 30);
    const titleDraft = doc.querySelector('[data-memory-draft-field="title"][data-memory-id="2"]');
    assert.equal(doc.activeElement, titleDraft, 'Edit must move focus into the title field');
    assert.equal(doc.querySelector('[data-memory-draft-field="lesson_text"][data-memory-id="2"]').maxLength, 240);
    titleDraft.value = 'Edited memory title';
    titleDraft.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(doc.activeElement, titleDraft, 'editing must preserve focus while the draft changes');
    assert.equal(doc.querySelector('[data-memory-action="save"][data-memory-id="2"]').disabled, false);
    doc.querySelector('[data-memory-action="save"][data-memory-id="2"]').click();
    await waitForUi(window, 80);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.updates[1])), {
      memoryId: 2,
      patch: { title: 'Edited memory title', lesson_text: 'The user prefers item 2.' },
    });
    assert.equal(doc.activeElement, doc.querySelector('[data-memory-action="edit"][data-memory-id="2"]'));
    assert.equal(calls.status, 1, 'editing must keep status refresh list-only');

    doc.querySelector('[data-memory-action="edit"][data-memory-id="4"]').click();
    await waitForUi(window, 20);
    doc.querySelector('[data-memory-action="cancel"][data-memory-id="4"]').click();
    assert.equal(doc.activeElement, doc.querySelector('[data-memory-action="edit"][data-memory-id="4"]'));

    doc.querySelector('[data-memory-action="delete"][data-memory-id="3"]').click();
    doc.querySelector('[data-toast-action-id="confirm-delete"]').click();
    await waitForUi(window, 80);
    assert.deepEqual(calls.deletes, [3]);
    assert.equal(calls.status, 2);
    doc.querySelector('[data-toast-action-id="undo-delete"]').click();
    await waitForUi(window, 80);
    assert.equal(calls.saves[0].sessionId, 'session-approved');
    assert.equal(calls.status, 3);

    doc.querySelector('[data-pending-memory-action="approve"][data-session-id="session-approve"]').click();
    await waitForUi(window, 80);
    assert.equal(calls.saves.length, 2, 'approval requires an explicit page action');
    assert.equal(calls.saves[1].sessionId, 'session-approve');
    assert.equal(calls.status, 4);

    doc.querySelector('[data-pending-memory-action="discard"][data-session-id="session-dismiss"]').click();
    await waitForUi(window, 80);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.deletes[1])), {
      sessionId: 'session-dismiss',
      fingerprint: 'sha256:' + 'b'.repeat(64),
    });
    assert.deepEqual(calls.dismisses, ['sha256:' + 'b'.repeat(64)]);
    assert.equal(calls.status, 5);
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
    assert.equal(doc.getElementById('approvedMemoryCount').textContent, '4');
    assert.equal(doc.getElementById('pendingMemoryCount').textContent, '2');
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
    assert.equal(window.document.getElementById('approvedMemoryCount').textContent, '99');
    window.document.querySelector('[data-memory-action="delete"]').click();
    window.document.querySelector('[data-toast-action-id="confirm-delete"]').click();
    await waitForUi(window, 80);
    assert.equal(window.document.querySelectorAll('#approvedMemoryList > article').length, 1);
    assert.equal(window.document.getElementById('approvedMemoryCount').textContent, '1');
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

test('pending provenance disclosure ids remain unique for repeated fingerprints', async () => {
  const fingerprint = `sha256:${'6'.repeat(64)}`;
  const candidates = ['session-one', 'session-two'].map((sessionId, index) => ({
    id: index + 1,
    session_id: sessionId,
    title: `Candidate ${index + 1}`,
    lesson_text: `Candidate memory ${index + 1}.`,
    lesson_kind: 'profile',
    source_excerpt: `Source ${index + 1}`,
    content_fingerprint: fingerprint,
    created_at: '2026-08-16T13:00:00.000Z',
  }));
  const app = await loadRendererApp({
    shell: { memory: {
      async listApproved() { return { memories: [] }; },
      async listPending() { return { candidates }; },
    } },
  });
  try {
    await openMemorySettings(app.window);
    const controls = [...app.window.document.querySelectorAll('#pendingMemoryList [data-inv-collapsible]')]
      .map((node) => node.getAttribute('aria-controls'));
    assert.equal(controls.length, 2);
    assert.equal(new Set(controls).size, 2);
    controls.forEach((id) => assert.ok(app.window.document.getElementById(id)));
  } finally {
    await app.dispose();
  }
});

test('legacy capture preference adoption serializes a newer user toggle', async () => {
  const calls = [];
  let resolveAdoption;
  const adoptionGate = new Promise((resolve) => { resolveAdoption = resolve; });
  const app = await loadRendererApp({
    legacyMemoryCapturePreference: '0',
    shell: {
      features: {
        async updateSettings(patch) {
          calls.push(patch);
          if (calls.length === 1) await adoptionGate;
          return { memory: { captureSuggestions: patch.memory.captureSuggestions } };
        },
      },
    },
  });
  try {
    await openMemorySettings(app.window, 30);
    app.window.document.getElementById('memorySettingsSection').dispatchEvent(new app.window.CustomEvent(
      'inv-toggle-change',
      { bubbles: true, detail: { id: 'memoryCaptureSuggestions', checked: true } }
    ));
    resolveAdoption();
    await waitForUi(app.window, 80);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      { memory: { captureSuggestions: false } },
      { memory: { captureSuggestions: true } },
    ]);
    assert.equal(app.window.__rendererState.features.memory.captureSuggestions, true);
    assert.equal(app.window.localStorage.getItem('jenny.memory.captureSuggestions'), null);
  } finally {
    await app.dispose();
  }
});

test('failed legacy capture preference adoption retains and honors the local value', async () => {
  const app = await loadRendererApp({
    legacyMemoryCapturePreference: '0',
    shell: {
      features: {
        async updateSettings() { throw new Error('disk unavailable'); },
      },
    },
  });
  try {
    await openMemorySettings(app.window, 50);
    assert.equal(app.window.__rendererState.features.memory.captureSuggestions, false);
    assert.equal(app.window.localStorage.getItem('jenny.memory.captureSuggestions'), '0');
  } finally {
    await app.dispose();
  }
});

test('malformed legacy adoption acknowledgement retains and honors the local value', async () => {
  const app = await loadRendererApp({
    legacyMemoryCapturePreference: '0',
    shell: { features: { async updateSettings() { return {}; } } },
  });
  try {
    await openMemorySettings(app.window, 50);
    assert.equal(app.window.__rendererState.features.memory.captureSuggestions, false);
    assert.equal(app.window.localStorage.getItem('jenny.memory.captureSuggestions'), '0');
  } finally {
    await app.dispose();
  }
});

test('two failed capture toggles roll back to the last confirmed preference', async () => {
  let calls = 0;
  const app = await loadRendererApp({
    shell: { features: { async updateSettings() { calls += 1; throw new Error('disk unavailable'); } } },
  });
  try {
    await openMemorySettings(app.window, 30);
    const section = app.window.document.getElementById('memorySettingsSection');
    section.dispatchEvent(new app.window.CustomEvent('inv-toggle-change', {
      bubbles: true,
      detail: { id: 'memoryCaptureSuggestions', checked: false },
    }));
    section.dispatchEvent(new app.window.CustomEvent('inv-toggle-change', {
      bubbles: true,
      detail: { id: 'memoryCaptureSuggestions', checked: true },
    }));
    await waitForUi(app.window, 80);
    assert.equal(calls, 2);
    assert.equal(app.window.__rendererState.features.memory.captureSuggestions, true);
  } finally {
    await app.dispose();
  }
});

test('failed first toggle restores the hydrated durable preference', async () => {
  const app = await loadRendererApp({
    shell: {
      features: {
        state: { memory: { captureSuggestions: false } },
        async updateSettings() { throw new Error('disk unavailable'); },
      },
    },
  });
  try {
    await openMemorySettings(app.window, 40);
    await app.shell.__emitFeaturesChanged({ memory: { captureSuggestions: false } });
    await waitForUi(app.window, 30);
    assert.equal(app.window.__rendererState.features.memory.captureSuggestions, false);
    app.window.document.getElementById('memorySettingsSection').dispatchEvent(new app.window.CustomEvent(
      'inv-toggle-change',
      { bubbles: true, detail: { id: 'memoryCaptureSuggestions', checked: true } }
    ));
    await waitForUi(app.window, 60);
    assert.equal(app.window.__rendererState.features.memory.captureSuggestions, false);
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
  let dismissCalls = 0;
  const app = await loadRendererApp({
    shell: {
      memory: {
        async listApproved() { return { memories: [] }; },
        async listPending() { return { candidates: [candidate] }; },
        async save() { return { created: false, memory: null }; },
        async deletePending() { return { deleted: false }; },
        async dismiss() { dismissCalls += 1; return { dismissed: true }; },
      },
    },
  });
  const { window } = app;
  const doc = window.document;

  try {
    await openMemorySettings(window);

    doc.querySelector('[data-pending-memory-action="approve"]').click();
    await waitForUi(window, 40);
    assert.match(doc.getElementById('toastViewport').textContent, /Memory Review Failed/i);
    assert.ok(doc.querySelector('[data-pending-memory-action="approve"]'));

    doc.querySelector('[data-pending-memory-action="discard"]').click();
    await waitForUi(window, 40);
    assert.equal(dismissCalls, 0, 'suppression must not run when pending deletion was rejected');
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
        async delete() { return { deleted: true, memory_id: memory.id }; },
        async save() { return { created: false, memory: null }; },
      },
    },
  });
  const { window } = app;
  const doc = window.document;

  try {
    await openMemorySettings(window);
    doc.querySelector('[data-memory-action="delete"]').click();
    doc.querySelector('[data-toast-action-id="confirm-delete"]').click();
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
    assert.match(window.document.getElementById('pendingMemoryStatus').textContent, /malformed response/i);
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
    assert.match(window.document.getElementById('pendingMemoryStatus').textContent, /unavailable/i);
    assert.equal(window.document.querySelectorAll('#approvedMemoryList > article').length, 0);
    assert.equal(window.document.querySelectorAll('#pendingMemoryList > article').length, 0);
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
  window.document.querySelector('[data-memory-action="delete"]').click();
  window.document.querySelector('[data-toast-action-id="confirm-delete"]').click();
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
