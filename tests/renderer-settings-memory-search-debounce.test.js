const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

test('Settings Memory category debounces search without rebuilding on each keystroke', async () => {
  const app = await loadRendererApp({
    shell: {
      memory: {
        async listApproved() {
          return {
            memories: [
              {
                id: 1,
                title: 'Preference: tea',
                lesson_text: 'The user prefers tea.',
                lesson_kind: 'preference',
                content_fingerprint: `sha256:${'a'.repeat(64)}`,
              },
              {
                id: 2,
                title: 'Project: Jenny',
                lesson_text: 'The user is shipping Jenny.',
                lesson_kind: 'project_context',
                content_fingerprint: `sha256:${'b'.repeat(64)}`,
              },
            ],
          };
        },
        async listPending() { return { candidates: [] }; },
      },
    },
  });
  const { window } = app;

  try {
    window.document.getElementById('settingsTopRailTab').click();
    await waitForUi(window, 20);
    window.document.getElementById('settingsNav-memories').click();
    await waitForUi(window, 60);
    const search = window.document.getElementById('memoryManagerSearchInput');
    search.focus();

    search.value = 't';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    search.value = 'te';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    search.value = 'tea';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    search.setSelectionRange(1, 2);

    assert.equal(window.document.querySelectorAll('#approvedMemoryList > article').length, 2);
    await waitForUi(window, 180);
    const cards = [...window.document.querySelectorAll('#approvedMemoryList > article')];
    assert.equal(cards.length, 1);
    assert.match(cards[0].textContent, /tea/i);
    const focusedSearch = window.document.getElementById('memoryManagerSearchInput');
    assert.equal(window.document.activeElement, focusedSearch);
    assert.deepEqual([focusedSearch.selectionStart, focusedSearch.selectionEnd], [1, 2]);

    const currentSearch = focusedSearch;
    currentSearch.value = '';
    currentSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitForUi(window, 180);
    const kindFilter = window.document.getElementById('memoryManagerKindFilter');
    kindFilter.focus();
    kindFilter.value = 'project_context';
    kindFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitForUi(window, 30);
    assert.equal(window.document.querySelectorAll('#approvedMemoryList > article').length, 1);
    assert.match(window.document.getElementById('approvedMemoryList').textContent, /Jenny/i);
    assert.equal(window.document.activeElement, window.document.getElementById('memoryManagerKindFilter'));

    const currentKindFilter = window.document.getElementById('memoryManagerKindFilter');
    currentKindFilter.value = 'goal';
    currentKindFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitForUi(window, 30);
    assert.equal(window.document.querySelectorAll('#approvedMemoryList > article').length, 0);
    assert.match(window.document.getElementById('approvedMemoryStatus').textContent, /match these filters/i);
  } finally {
    await app.dispose();
  }
});
