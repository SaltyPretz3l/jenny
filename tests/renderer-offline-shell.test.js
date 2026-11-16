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

// The Force local inference row: its help line is the one readiness sentence; the `?` holds the boundary.
// The switch rows paint with the lazily loaded Settings scripts, so Settings opens first.
async function openSettings(window) {
  window.document.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 40);
  return window.document;
}
const helpOf = (document) => document.querySelector('#offlineLocalOnlyList .settings-field-help').textContent.trim();

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
  const document = await openSettings(app.window);

  assert.equal(document.getElementById('offlineBadge'), null);
  assert.equal(helpOf(document), 'Blocks every cloud model. Ready with llava:7b.');
  const detail = document.querySelector('#offlineLocalOnlyList .settings-field-detail');
  assert.match(detail.getAttribute('data-tooltip'), /^Governs model inference only\. Tools, extensions, sign-in, updates and other services may still use the network\. It needs an Ollama model as the local default\.$/);
  for (const id of ['offlineSummary', 'offlineStatus', 'offlineModelStatus']) assert.equal(document.getElementById(id), null, id);
  // Row 133: the group sits on Models beside the library, so the shortcut button is gone.
  assert.equal(document.getElementById('offlineModelActions'), null);
  assert.equal(document.querySelector('[data-action="openOfflineModelLibrary"]'), null);
  assert.equal(document.getElementById('offlineLocalModelSelect'), null);
  assert.equal(document.getElementById('offlineRuntimeStatus'), null);
  assert.equal(document.getElementById('localEnginesContainer'), null);
  assert.equal(document.querySelector('.settings-json-slice'), null);
  assert.equal(document.getElementById('composerChatPosture').hidden, false);
  assert.equal(document.getElementById('composerChatPostureDot').dataset.posture, 'local-only-ready');
  assert.equal(document.getElementById('composerChatPostureDot').classList.contains('status-dot--active'), true);
  assert.match(document.getElementById('composerChatPostureText').textContent, /Force local inference: using llava:7b/i);
});

test('the Local only toggle on Models persists through the bridge the first time Settings opens', async (t) => {
  const { window, shell } = await loadOfflineApp(t);
  const { document } = window;
  // Settings opens on Models; no rail click, so only the companion readying binds the switch.
  document.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 40);
  assert.equal(document.querySelector('.settings-nav-item[data-settings-section="models"]').classList.contains('active'), true);
  assert.equal(document.querySelector('.settings-nav-item[data-settings-section="offline"]'), null, 'Offline has no rail item');
  const group = document.getElementById('offlineLocalOnlyList').closest('[data-settings-merged-section="offline"]');
  assert.equal(group.closest('.settings-card').dataset.settingsSection, 'models');
  document.getElementById('offlineLocalOnlyList').dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'offlineLocalOnlyToggle', checked: true },
  }));
  await waitForUi(window, 30);
  assert.deepEqual(JSON.parse(JSON.stringify(shell.__state.offlineUpdateCalls)), [{ mode: 'local_only' }]);
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
          selectedLocalEngineType: 'openai-compatible', selectedManagedEngine: 'llama-server',
          selectedLocalModelInstalled: true, localChatReady: true, localVisionReady: false,
          unavailableReason: 'Forced local inference is unavailable right now.', visionUnavailableReason: '',
          summary: 'Local chat is ready with ternary-bonsai-2-27b-pq2_0.',
        },
      },
    },
  });
  const document = await openSettings(window);
  // The model is named once, in the row's help line, with the engine that blocks it.
  const help = helpOf(document);
  assert.equal(help, 'Blocks every cloud model. Not usable with ternary-bonsai-2-27b-pq2_0 yet: it runs on llama-server.');
  assert.doesNotMatch(help, /not installed|not available in the local catalog/i);
  const group = document.querySelector('.settings-card[data-settings-section="models"] [data-settings-merged-section="offline"]');
  assert.equal(group.querySelector('[data-i18n="settings.offline.description"]'), null, 'the boundary is behind the row\'s ?, not group copy');
  assert.equal(group.querySelectorAll('.settings-field--row').length, 2, 'two switch rows: Force local inference and Load model at startup');
});

test('Offline names NInfer as the engine, and says what to pick when no model is selected', async (t) => {
  const state = (overrides) => ({ shell: { offline: { state: {
    mode: 'disabled', preferredLocalModel: 'qwen3.8-27b-nvfp4',
    localCatalog: { available: true, reason: '', models: [] },
    managedSidecar: { mode: 'managed-dev', phase: 'ready', ready: true },
    selectedLocalEngineType: 'openai-compatible', selectedManagedEngine: 'ninfer',
    selectedLocalModelInstalled: true, localChatReady: true, localVisionReady: false,
    unavailableReason: '', visionUnavailableReason: '', summary: '', ...overrides,
  } } } });
  const ninfer = await loadOfflineApp(t, state());
  assert.equal(helpOf(await openSettings(ninfer.window)), 'Blocks every cloud model. Not usable with qwen3.8-27b-nvfp4 yet: it runs on NInfer.');
  const none = await loadOfflineApp(t, state({ preferredLocalModel: '', selectedManagedEngine: '', selectedLocalModelInstalled: false, localChatReady: false }));
  assert.equal(helpOf(await openSettings(none.window)), 'Blocks every cloud model. Pick an Ollama model as the local default.');
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
  const document = await openSettings(window);
  assert.equal(document.getElementById('offlineBadge'), null);
  assert.equal(helpOf(document), 'Blocks every cloud model. Selected model is not installed locally.');
  assert.equal(document.getElementById('offlineModelActions'), null);
  assert.equal(document.getElementById('offlineRuntimeStatus'), null);
  assert.equal(document.getElementById('localEnginesContainer'), null);
});
