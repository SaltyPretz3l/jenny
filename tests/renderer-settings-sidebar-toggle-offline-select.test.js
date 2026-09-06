const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadOfflineApp(t) {
  const app = await loadRendererApp();
  t.after(async () => app.dispose());
  return app;
}

test('Offline keeps model selection in Model Library across section re-renders', async (t) => {
  const { window } = await loadOfflineApp(t);
  const doc = window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 30);
  doc.querySelector('.settings-nav-item[data-settings-section="offline"]').click();
  await waitForUi(window, 30);

  const offlineCard = doc.querySelector('section.settings-card[data-settings-section="offline"]');
  assert.ok(offlineCard);
  assert.equal(offlineCard.querySelector('select'), null);
  assert.equal(doc.getElementById('offlineLocalModelSelect'), null);
  assert.equal(doc.getElementById('offlineRuntimeStatus'), null);
  assert.equal(doc.getElementById('localEnginesContainer'), null);
  assert.ok(offlineCard.querySelector('[data-action="openOfflineModelLibrary"]'));

  doc.querySelector('.settings-nav-item[data-settings-section="account"]').click();
  doc.querySelector('.settings-nav-item[data-settings-section="offline"]').click();
  await waitForUi(window, 30);
  assert.equal(doc.getElementById('offlineLocalModelSelect'), null);
  assert.ok(doc.querySelector('[data-action="openOfflineModelLibrary"]'));
});

test('Offline model shortcut routes to Model Library without writing settings', async (t) => {
  const { window, shell } = await loadOfflineApp(t);
  const doc = window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 30);
  doc.querySelector('.settings-nav-item[data-settings-section="offline"]').click();
  await waitForUi(window, 30);
  doc.querySelector('[data-action="openOfflineModelLibrary"]').click();
  await waitForUi(window, 30);

  assert.equal(doc.querySelector('.settings-nav-item[data-settings-section="models"]').classList.contains('active'), true);
  assert.deepEqual(shell.__state.offlineUpdateCalls, []);
});
