'use strict';

// Memory Settings empty states (live review 2026-10-03): one message per empty
// list, filter-empty wording, list controls only with items, and no healthy
// summary row repeating the header badge.
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

function memoryGroup(doc, headingId) {
  return doc.querySelector(`#memorySettingsSection [aria-labelledby="${headingId}"]`);
}

test('empty Memory lists read once and hide controls that have nothing to act on', async () => {
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
    const pendingGroup = memoryGroup(doc, 'pendingMemoryHeading');
    const approvedGroup = memoryGroup(doc, 'approvedMemoryHeading');

    assert.equal(doc.getElementById('pendingMemoryStatus').textContent, 'No pending memory candidates are waiting right now.');
    assert.equal(doc.getElementById('pendingMemoryStatus').getAttribute('aria-live'), 'polite');
    assert.equal(doc.getElementById('pendingMemoryList').children.length, 0);
    assert.equal(doc.getElementById('pendingMemoryList').hidden, true);
    assert.doesNotMatch(pendingGroup.textContent, /No pending candidates to review/);
    assert.equal(pendingGroup.textContent.match(/No pending/g).length, 1, 'one pending empty message');

    assert.equal(doc.getElementById('approvedMemoryStatus').textContent, 'No approved memories saved yet.');
    assert.equal(doc.getElementById('approvedMemoryList').children.length, 0);
    assert.equal(doc.getElementById('approvedMemoryList').hidden, true);
    assert.doesNotMatch(approvedGroup.textContent, /No approved memories to show/);
    assert.equal(approvedGroup.textContent.match(/No approved memories/g).length, 1, 'one approved empty message');
    assert.equal(doc.querySelector('.memory-page-empty'), null);

    assert.equal(doc.getElementById('pendingMemorySortHost').hidden, true, 'Sort hides while pending is empty');
    assert.equal(doc.querySelector('#memorySettingsSection .memory-page-filters').hidden, true, 'filters hide while approved is empty');

    assert.equal(doc.getElementById('memoryNotesHint'), null, 'the notes hint no longer repeats the placeholder');
    assert.equal(doc.getElementById('memoryBadge').textContent.trim(), '0 saved');
    assert.equal(doc.getElementById('memorySummary').hidden, true, 'a healthy summary no longer repeats the badge');
  } finally {
    await app.dispose();
  }
});

test('Memory list controls return with items and a filtered-out list says nothing matches', async () => {
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
    assert.equal(doc.getElementById('pendingMemorySortHost').hidden, false);
    assert.ok(doc.getElementById('pendingMemorySort'));
    assert.equal(doc.querySelector('#memorySettingsSection .memory-page-filters').hidden, false);
    assert.equal(doc.getElementById('approvedMemoryList').hidden, false);
    assert.equal(doc.getElementById('pendingMemoryList').hidden, false);
    assert.equal(doc.querySelectorAll('#approvedMemoryList > article').length, 1);

    const search = doc.getElementById('memoryManagerSearchInput');
    search.value = 'no-such-memory';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitForUi(window, 400);
    const approvedGroup = memoryGroup(doc, 'approvedMemoryHeading');
    assert.equal(doc.getElementById('approvedMemoryStatus').textContent, 'No approved memories match these filters.');
    assert.equal(approvedGroup.textContent.match(/No approved memories/g).length, 1, 'one filtered-empty message');
    assert.doesNotMatch(approvedGroup.textContent, /saved yet/);
    assert.equal(doc.getElementById('approvedMemoryList').hidden, true);
    assert.equal(doc.querySelector('#memorySettingsSection .memory-page-filters').hidden, false, 'filters stay so the user can clear them');
  } finally {
    await app.dispose();
  }
});
