const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

async function loadOfflineApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => app.dispose());
  return app;
}

test('renderer Offline card shows the forced-inference boundary and selected-model readiness', async (t) => {
  const app = await loadOfflineApp(t, {
    shell: {
      offline: {
        state: {
          mode: 'local_only',
          preferredLocalModel: 'llava:7b',
          localCatalog: { available: true, reason: '', models: ['llava:7b'] },
          managedSidecar: { mode: 'managed-dev', phase: 'ready', ready: true },
          currentEngine: 'ollama', currentModel: 'llava:7b', selectedLocalModelInstalled: true,
          localChatReady: true, localVisionReady: true, unavailableReason: '', visionUnavailableReason: '',
          summary: 'Force local inference is on. Jenny will use llava:7b for model inference.',
        },
      },
    },
  });
  const { document } = app.window;

  assert.equal(document.getElementById('offlineBadge').textContent, 'Forced');
  assert.match(document.getElementById('offlineSummary').textContent, /Force local inference is on/i);
  assert.match(document.getElementById('offlineModelStatus').textContent, /llava:7b is ready for local inference/i);
  assert.match(document.getElementById('offlineModelActions').textContent, /Manage in Model Library/i);
  assert.equal(document.getElementById('offlineLocalModelSelect'), null);
  assert.equal(document.getElementById('offlineRuntimeStatus'), null);
  assert.equal(document.getElementById('localEnginesContainer'), null);
  assert.equal(document.querySelector('.settings-json-slice'), null);
  assert.equal(document.getElementById('composerGearPostureDot').dataset.posture, 'local-only-ready');
  assert.match(document.getElementById('composerSettingsButton').getAttribute('data-tooltip'), /Force local inference: using llava:7b/i);
});

test('Offline toggle persists through the bridge and the model shortcut routes to Model Library', async (t) => {
  const { window, shell } = await loadOfflineApp(t);
  const { document } = window;
  document.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 40);
  document.querySelector('.settings-nav-item[data-settings-section="offline"]').click();
  await waitForUi(window, 40);
  document.getElementById('offlineLocalOnlyList').dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'offlineLocalOnlyToggle', checked: true },
  }));
  await waitForUi(window, 30);
  assert.deepEqual(JSON.parse(JSON.stringify(shell.__state.offlineUpdateCalls)), [{ mode: 'local_only' }]);

  document.querySelector('[data-action="openOfflineModelLibrary"]').click();
  await waitForUi(window, 30);
  assert.equal(document.querySelector('.settings-nav-item[data-settings-section="models"]').classList.contains('active'), true);
});

test('composer tooltip separates local readiness from the disabled force-local setting', async (t) => {
  const { window } = await loadOfflineApp(t, {
    shell: {
      offline: {
        state: {
          mode: 'disabled', preferredLocalModel: 'qwen3.5:9b',
          localCatalog: { available: true, reason: '', models: ['qwen3.5:9b'] },
          managedSidecar: { mode: 'managed-dev', phase: 'ready', ready: true },
          selectedLocalModelInstalled: true, localChatReady: true, localVisionReady: false,
          unavailableReason: '', visionUnavailableReason: '', summary: 'Local chat is ready with qwen3.5:9b.',
        },
      },
    },
  });
  const tooltip = window.document.getElementById('composerSettingsButton').getAttribute('data-tooltip');
  assert.match(tooltip, /Force local inference is off/i);
  assert.match(tooltip, /configured inference providers may use the network/i);
});

test('Offline shows unavailable selected-model remediation without exposing engine details', async (t) => {
  const { window } = await loadOfflineApp(t, {
    shell: {
      offline: {
        state: {
          mode: 'local_only', preferredLocalModel: 'gemma3:4b',
          localCatalog: { available: false, reason: 'Catalog unavailable.', models: [] },
          managedSidecar: { mode: 'managed-dev', phase: 'ready', ready: true },
          selectedLocalModelInstalled: false, localChatReady: false, localVisionReady: false,
          unavailableReason: 'Selected model is not installed locally.', visionUnavailableReason: '',
          summary: 'Selected model is not installed locally.',
        },
      },
    },
  });
  const { document } = window;
  assert.equal(document.getElementById('offlineBadge').textContent, 'Blocked');
  assert.match(document.getElementById('offlineModelStatus').textContent, /gemma3:4b is not available/i);
  assert.match(document.getElementById('offlineModelActions').textContent, /Manage in Model Library/i);
  assert.equal(document.getElementById('offlineRuntimeStatus'), null);
  assert.equal(document.getElementById('localEnginesContainer'), null);
});

test('Offline status fallback preserves the force-local label when the shared primitive is unavailable', async (t) => {
  const { window } = await loadOfflineApp(t);
  const previousStatusRow = window.inventory.statusRow;
  window.inventory.statusRow = null;
  t.after(() => { window.inventory.statusRow = previousStatusRow; });
  window.document.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 40);
  window.document.querySelector('.settings-nav-item[data-settings-section="offline"]').click();
  await waitForUi(window, 40);
  window.document.getElementById('offlineLocalOnlyList').dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'offlineLocalOnlyToggle', checked: true },
  }));
  await waitForUi(window, 30);
  const fallbackHtml = window.document.getElementById('offlineSummary').innerHTML;
  assert.match(fallbackHtml, /<span class="inv-status-row-label">Force local inference<\/span>/i);
  // The fallback must mirror the real primitive's shape, not invent its own —
  // drifting fallbacks are what made the old banner and settings notices
  // degrade into three different layouts.
  assert.match(fallbackHtml, /class="inv-status-row inv-status-row--warning"/);
  assert.match(fallbackHtml, /inv-status-row-dot/);
});
