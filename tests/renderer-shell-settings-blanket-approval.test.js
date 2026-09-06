/* Retirement regression for the former blanket auto-approve Settings surface. */
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

test('renderer Tools settings no longer exposes or persists blanket auto-approval', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      tools: {
        getPermissions() {
          return { policies: {} };
        },
      },
    },
  });
  const doc = window.document;

  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  doc.querySelector('.settings-nav-item[data-settings-section="tools"]').click();
  await waitForUi(window, 20);

  assert.equal(doc.getElementById('toolsApprovalList'), null);
  assert.equal(doc.querySelector('[data-inv-toggle="toolsBlanketApprovalToggle"]'), null);
});
