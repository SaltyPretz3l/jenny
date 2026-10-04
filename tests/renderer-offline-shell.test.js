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

  assert.equal(document.getElementById('offlineBadge'), null);
  assert.match(document.getElementById('offlineSummary').textContent, /Force local inference is on/i);
  assert.equal(document.getElementById('offlineModelStatus').textContent, 'Local inference uses llava:7b. Change it in Model Library.');
  assert.match(document.getElementById('offlineModelActions').textContent, /Manage in Model Library/i);
  assert.equal(document.getElementById('offlineLocalModelSelect'), null);
  assert.equal(document.getElementById('offlineRuntimeStatus'), null);
  assert.equal(document.getElementById('localEnginesContainer'), null);
  assert.equal(document.querySelector('.settings-json-slice'), null);
  assert.equal(document.getElementById('composerChatPosture').hidden, false);
  assert.equal(document.getElementById('composerChatPostureDot').dataset.posture, 'local-only-ready');
  assert.equal(document.getElementById('composerChatPostureDot').classList.contains('status-dot--active'), true);
  assert.match(document.getElementById('composerChatPostureText').textContent, /Force local inference: using llava:7b/i);
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

test('hidden panel posture text separates local readiness from the disabled force-local setting', async (t) => {
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
  assert.equal(window.document.getElementById('composerChatPosture').hidden, true);
  const tooltip = window.document.getElementById('composerChatPostureText').textContent;
  assert.match(tooltip, /Force local inference is off/i);
  assert.match(tooltip, /configured inference providers may use the network/i);
});

test('Offline reads a Model Library GGUF served by llama-server as the installed local model', async (t) => {
  // The Ollama catalog never lists a library GGUF; the service still reports
  // it installed and local (offline-intelligence-service findManagedLibraryModel).
  const { window } = await loadOfflineApp(t, {
    shell: {
      offline: {
        state: {
          mode: 'disabled', preferredLocalModel: 'ternary-bonsai-2-27b-pq2_0',
          localCatalog: { available: true, reason: '', models: ['qwen3.5:9b'] },
          managedSidecar: { mode: 'managed-dev', phase: 'ready', ready: true },
          selectedLocalEngineType: 'openai-compatible',
          selectedLocalModelInstalled: true, localChatReady: true, localVisionReady: false,
          unavailableReason: 'Forced local inference is unavailable right now.', visionUnavailableReason: '',
          summary: 'Local chat is ready with ternary-bonsai-2-27b-pq2_0.',
        },
      },
    },
  });
  const { document } = window;
  const modelStatus = document.getElementById('offlineModelStatus').textContent;
  assert.equal(modelStatus, 'Local inference uses ternary-bonsai-2-27b-pq2_0. Change it in Model Library.');
  assert.doesNotMatch(modelStatus, /not available in the local catalog/i);
  assert.doesNotMatch(document.getElementById('offlineSummary').textContent, /not installed/i);
  // The group states the model once; the boundary is stated by the lede and
  // the toggle help, not repeated as group copy.
  const card = document.querySelector('.settings-card[data-settings-section="offline"]');
  assert.equal(card.querySelector('[data-i18n="settings.offline.inferenceBoundary.description"]'), null);
  assert.equal(card.querySelector('[data-i18n="settings.offline.localModel.description"]'), null);
  assert.ok(card.querySelector('[data-i18n="settings.offline.description"]'), 'the lede stays');
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
  assert.equal(document.getElementById('offlineBadge'), null);
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
