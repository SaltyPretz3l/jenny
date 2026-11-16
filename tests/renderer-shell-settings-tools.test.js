'use strict';

// The Tools page as the booted renderer fills it (split from renderer-shell-settings.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('W2-2 contract 1 fills the frozen Tools hosts with standard rows in order', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  doc.querySelector('.settings-nav-item[data-settings-section="tools"]').click();
  await waitForUi(window, 20);
  // Row 133: the run-mode and approval rows moved to the Permissions page; Tools keeps only the tools.
  assert.equal(doc.querySelector('[data-settings-section="tools"] [data-setting-mount]'), null);
  assert.equal(doc.getElementById('toolsPermissionsList'), null);
  const expected = {
    toolsFilesList: ['fileTools', 'richFiles', 'imageRead'],
    toolsWebList: ['web'],
    toolsTerminalList: ['bash'],
    toolsCodeList: ['pythonRuntime', 'lsp', 'worktree', 'subagents'],
  };
  for (const [host, ids] of Object.entries(expected)) {
    assert.ok(doc.getElementById(host), host);
    assert.deepEqual(Array.from(doc.getElementById(host).querySelectorAll(':scope > .settings-field--row'), (row) => row.dataset.settingsField),
      ids.map((id) => `settings-tool-config-${id}`));
  }
  assert.equal(doc.querySelector('.tools-config-field-row'), null);
  assert.equal(doc.getElementById('toolsSummary'), null);
});
