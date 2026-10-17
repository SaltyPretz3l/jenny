'use strict';

// Memory Settings empty states (live review 2026-10-03; row 58 W4 page): one
// message per empty tab, filter-empty wording, list tools only with items, no
// pending group without proposals, and no healthy summary row repeating the
// header badge.
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function openMemorySettings(window, settleMs = 80) {
  const doc = window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  doc.getElementById('settingsNav-memories').click();
  await waitForUi(window, settleMs);
}

const listGroup = (doc) => doc.querySelector('#memorySettingsSection .memory-list-group');

test('an empty Memory tab reads once and hides the tools, folds, meter and pending group', async () => {
  const app = await loadRendererApp({
    shell: {
      memory: {
        async status() {
          return { available: true, counts: { approved: 0, pending: 0 }, storage: { state: 'ready' }, degraded_reasons: [] };
        },
        async listApproved() { return { memories: [] }; },
        async listPending() { return { candidates: [] }; },
      },
    },
  });
  const doc = app.window.document;
  try {
    await openMemorySettings(app.window);
    const status = doc.getElementById('approvedMemoryStatus');
    assert.match(status.textContent, /hasn’t remembered anything here yet/);
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.equal(listGroup(doc).textContent.match(/remembered anything/g).length, 1, 'one empty message');
    assert.equal(doc.getElementById('approvedMemoryList').children.length, 0);
    assert.equal(doc.getElementById('approvedMemoryList').hidden, true);

    assert.equal(doc.getElementById('pendingMemoryHost').hidden, true, 'no proposals, no pending group');
    assert.equal(doc.querySelector('#memorySettingsSection .memory-page-filters').hidden, true, 'tools hide while the tab is empty');
    assert.equal(doc.getElementById('memoryForgottenHost').hidden, true, 'nothing forgotten, no fold');
    assert.equal(doc.getElementById('memoryHistoryHost').hidden, true, 'nothing changed, no fold');
    assert.equal(doc.getElementById('memoryMeter').hidden, true, 'nothing pinned, no meter');

    assert.equal(doc.getElementById('memoryBadge').textContent.trim(), '0 saved');
    assert.equal(doc.getElementById('memorySummary').hidden, true, 'a healthy summary no longer repeats the badge');
  } finally {
    await app.dispose();
  }
});

test('Memory tools return with items, proposals show, and a filtered-out tab says nothing matches', async () => {
  const app = await loadRendererApp({
    shell: {
      memory: {
        async status() {
          return { available: true, counts: { approved: 1, pending: 1 }, storage: { state: 'ready' }, degraded_reasons: [] };
        },
        async listApproved() {
          return { memories: [{
            id: 1, session_id: 'session-approved', title: 'Preference: tea', lesson_text: 'The user prefers tea.',
            lesson_kind: 'preference', content_fingerprint: `sha256:${'1'.repeat(64)}`,
          }] };
        },
        async listPending() {
          return { candidates: [{
            id: 9, session_id: 'session-pending', title: 'Goal: ship', lesson_text: 'The user wants to ship.',
            lesson_kind: 'goal', confidence: 0.9, content_fingerprint: `sha256:${'2'.repeat(64)}`,
            created_at: '2026-08-16T12:00:00.000Z', updated_at: '2026-08-16T12:00:00.000Z',
          }] };
        },
      },
    },
  });
  const { window } = app;
  const doc = window.document;
  try {
    await openMemorySettings(window);
    assert.equal(doc.querySelector('#memorySettingsSection .memory-page-filters').hidden, false);
    assert.equal(doc.getElementById('approvedMemoryList').hidden, false);
    assert.equal(doc.getElementById('pendingMemoryHost').hidden, false);
    assert.equal(doc.querySelectorAll('#pendingMemoryHost [data-pending-memory-action="approve"]').length, 1);
    assert.equal(doc.querySelectorAll('#approvedMemoryList > article').length, 1);
    assert.equal(doc.getElementById('approvedMemoryStatus').textContent, '');

    const search = doc.getElementById('memoryManagerSearchInput');
    search.value = 'no-such-memory';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitForUi(window, 400);
    assert.equal(doc.getElementById('approvedMemoryStatus').textContent, 'No memories match.');
    assert.equal(listGroup(doc).textContent.match(/No memories match/g).length, 1, 'one filtered-empty message');
    assert.doesNotMatch(listGroup(doc).textContent, /remembered anything/);
    assert.equal(doc.getElementById('approvedMemoryList').hidden, true);
    assert.equal(doc.querySelector('#memorySettingsSection .memory-page-filters').hidden, false, 'tools stay so the user can clear them');
  } finally {
    await app.dispose();
  }
});
