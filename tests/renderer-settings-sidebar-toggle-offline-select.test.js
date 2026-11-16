const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadOfflineApp(t) {
  const app = await loadRendererApp();
  t.after(async () => app.dispose());
  return app;
}

// Row 133: Offline is the "Local only" group of Models, so model selection stays in the
// library on the same page and the group carries no picker and no shortcut button.
test('Models › Local only keeps model selection in the library across section re-renders', async (t) => {
  const { window } = await loadOfflineApp(t);
  const doc = window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 30);

  const group = doc.querySelector('section.settings-card[data-settings-section="models"] [data-settings-merged-section="offline"]');
  assert.ok(group);
  assert.equal(group.querySelector('select'), null);
  assert.equal(doc.getElementById('offlineLocalModelSelect'), null);
  assert.equal(doc.getElementById('offlineRuntimeStatus'), null);
  assert.equal(doc.getElementById('localEnginesContainer'), null);
  assert.equal(doc.querySelector('[data-action="openOfflineModelLibrary"]'), null);

  doc.querySelector('.settings-nav-item[data-settings-section="account"]').click();
  doc.querySelector('.settings-nav-item[data-settings-section="models"]').click();
  await waitForUi(window, 30);
  assert.equal(doc.getElementById('offlineLocalModelSelect'), null);
  assert.equal(doc.querySelector('[data-action="openOfflineModelLibrary"]'), null);
});

test('a stored Offline section opens Models without writing settings', async (t) => {
  const { window, shell } = await loadOfflineApp(t);
  const doc = window.document;
  window.localStorage.setItem('jenny.settings.activeSection', 'offline');
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 30);

  assert.equal(doc.querySelector('.settings-nav-item[data-settings-section="models"]').classList.contains('active'), true);
  assert.equal(window.localStorage.getItem('jenny.settings.activeSection'), 'models');
  assert.deepEqual(shell.__state.offlineUpdateCalls, []);
});
