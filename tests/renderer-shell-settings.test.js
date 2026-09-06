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

test('renderer removes the composer token display even when backend context metadata is present', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      status: {
        async get() {
          return {
            effective_context_length: 8192,
            configured_context_length: 8192,
            native_context_length: 262144,
          };
        },
      },
    },
  });
  assert.equal(window.document.getElementById('composerTokenLabel'), null);
});

test('renderer shows the model-load hint in the hero and hides it once a real chat thread exists', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      status: {
        async get() {
          return {
            model_loaded: false,
          };
        },
      },
    },
  });
  const heroRuntimeHint = window.document.getElementById('heroRuntimeHint');
  const chatView = window.document.getElementById('chatView');
  const input = window.document.getElementById('chatInput');
  // The backend banner is gone entirely; the runtime hint lives in the chat hero
  // and live phase state lives in the workbench health pill.
  assert.equal(window.document.getElementById('backendBanner'), null);
  assert.equal(heroRuntimeHint.classList.contains('hidden'), false);
  assert.match(heroRuntimeHint.textContent, /Model loads with your first message/i);
  input.value = 'Start a real thread'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('sendButton').click();
  await waitForUi(window, 30);
  assert.equal(chatView.getAttribute('data-chat-mode'), 'thread'); // hero fades out
});

// The "runtime notice moves into the artifacts view" test was deleted in
// W1-5: the Artifacts studio view (and its #artifactsRuntimeNote slot) no
// longer exists. Banner suppression on non-chat views is covered at unit
// level in tests/renderer-shell-status-controller.test.js.

test('renderer signals ready even when non-critical harness bootstrap work never resolves', async (t) => {
  const { shell } = await loadRendererTestApp(t, {
    shell: {
      harness: {
        inspect() {
          return new Promise(() => {});
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(shell.__state.lifecycleReadySignals, 1);
});

test('renderer hydrates Home-owned tips and reminders without retired Settings sections', async (t) => {
  let companionGetCalls = 0;
  let proactiveGetCalls = 0;
  let skillsGetCalls = 0;
  let tipsGetCalls = 0;
  let offlineGetCalls = 0;
  let harnessInspectCalls = 0;
  const { window } = await loadRendererTestApp(t, {
    shell: {
      features: {
        state: { featureFlags: { plugins: true } },
      },
      companion: {
        async getState({ state }) {
          companionGetCalls += 1;
          return state.companionState;
        },
      },
      workspaceRoot: {
        async getState({ state }) {
          return state.workspaceRootState;
        },
      },
      proactive: {
        async getState({ state }) {
          proactiveGetCalls += 1;
          return state.proactiveState;
        },
      },
      skills: {
        async getState({ state }) {
          skillsGetCalls += 1;
          return state.skillsState;
        },
      },
      tips: {
        async getState({ state }) {
          tipsGetCalls += 1;
          return state.tipsState;
        },
      },
      offline: {
        async getState({ state }) {
          offlineGetCalls += 1;
          return state.offlineState;
        },
      },
      harness: {
        async inspect({ state }) {
          harnessInspectCalls += 1;
          return state.harnessSnapshot || {
            generated_at: new Date().toISOString(),
            sections: ['tools', 'memories', 'skills', 'runtime', 'workspace', 'shell'],
            tools: { items: [], counts: { total: 0, enabled: 0, disabled: 0 } },
            memories: { approved: [], pending: [], counts: { approved: 0, pending: 0, provenance: { user_approved: 0, automatic: 0, unknown_legacy: 0 } } },
            skills: { items: [], scopes: [], counts: { total: 0, bundled: 0, user: 0, project: 0 } },
            runtime: {},
            workspace: { blockers: [] },
            shell: {},
          };
        },
      },
    },
  });
  const doc = window.document;
  await waitForUi(window, 80);
  assert.deepEqual(
    {
      companionGetCalls,
      proactiveGetCalls,
      skillsGetCalls,
      tipsGetCalls,
      offlineGetCalls,
      harnessInspectCalls,
    },
    {
      companionGetCalls: 0,
      proactiveGetCalls: 0,
      // Skill slash commands (/verify …) register at boot from skills.getState;
      // Settings hydration itself still makes no extra call.
      skillsGetCalls: 1,
      tipsGetCalls: 1,
      offlineGetCalls: 1,
      harnessInspectCalls: 0,
    }
  );
  doc.getElementById('homeTopRailTab').click();
  await waitForUi(window, 40);
  assert.equal(companionGetCalls, 1);
  assert.equal(proactiveGetCalls, 1);
  assert.equal(tipsGetCalls, 1);
  // Home re-pulls offline state on activation so the dashboard's Model &
  // Engine card never paints a stale boot-time snapshot.
  assert.equal(offlineGetCalls, 2);
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 40);
  // Readiness is its own section now (first in the rail); its rows deep-link to
  // the section that owns the fix.
  doc.getElementById('settingsNav-readiness').click();
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.activeSettingsSection, 'readiness');
  const readinessCard = doc.querySelector('.settings-card[data-settings-section="readiness"]');
  assert.ok(readinessCard.classList.contains('settings-section-active'));
  assert.ok(readinessCard.querySelector('#settingsControlTower .settings-control-tower-row'), 'the list renders at least one row');
  const controlTowerAction = doc.querySelector('#settingsControlTower [data-settings-control-section]');
  const controlTowerTarget = controlTowerAction?.getAttribute('data-settings-control-section') || '';
  assert.ok(controlTowerTarget);
  assert.notEqual(controlTowerTarget, 'readiness');
  controlTowerAction.click(); await waitForUi(window, 40); assert.equal(window.__rendererState.ui.activeSettingsSection, controlTowerTarget);
  // Skills is merged into Plugins & Extensions. Proactive and Tips are owned
  // by Home, so none has a standalone Settings navigation item.
  const base = {
    skills: skillsGetCalls,
    offline: offlineGetCalls,
    harness: harnessInspectCalls,
  };
  assert.equal(doc.querySelector('.settings-nav-item[data-settings-section="skills"]'), null);
  assert.equal(doc.querySelector('.settings-nav-item[data-settings-section="tips"]'), null);
  assert.equal(doc.querySelector('.settings-nav-item[data-settings-section="proactive"]'), null);

  doc.querySelector('.settings-nav-item[data-settings-section="plugins"]').click();
  await waitForUi(window, 40);
  // Opening Plugins & Extensions readies its merged Skills companion.
  assert.equal(skillsGetCalls, base.skills + 1);

  doc.querySelector('.settings-nav-item[data-settings-section="offline"]').click();
  await waitForUi(window, 40);
  assert.ok(offlineGetCalls > base.offline);

  doc.querySelector('.settings-nav-item[data-settings-section="usage"]').click();
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.activeSettingsSection, 'usage');
});

test('renderer composer settings popover works before settings opens and account sign-in is absent', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const composerSettingsPopover = doc.getElementById('composerSettingsPopover');

  assert.equal(window.__rendererState.ui.activeView, 'chat');
  assert.equal(composerSettingsPopover.classList.contains('hidden'), true);
  assert.equal(doc.getElementById('authOverlay'), null);

  doc.getElementById('composerSettingsButton').click();
  await waitForUi(window, 20);
  assert.equal(window.__rendererState.ui.activeView, 'chat');
  assert.equal(composerSettingsPopover.classList.contains('hidden'), false);
  assert.equal(doc.activeElement, doc.getElementById('attachFilesButton'));

  const composingEscape = new window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true, isComposing: true,
  });
  Object.defineProperty(composingEscape, 'keyCode', { value: 229 });
  doc.activeElement.dispatchEvent(composingEscape);
  await waitForUi(window, 10);
  assert.equal(composerSettingsPopover.classList.contains('hidden'), false);

  doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  await waitForUi(window, 10);
  assert.equal(composerSettingsPopover.classList.contains('hidden'), true);
  assert.equal(doc.activeElement, doc.getElementById('composerSettingsButton'));

  assert.equal(doc.getElementById('openAuthButton'), null);
  assert.equal(doc.getElementById('settingsLogoutButton'), null);
  assert.equal(doc.getElementById('authOverlay'), null);
});

test('Settings saves an optional local profile without account controls', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 30);
  doc.querySelector('.settings-nav-item[data-settings-section="account"]').click();
  await waitForUi(window, 30);
  const input = doc.getElementById('localProfileDisplayName');
  assert.ok(input);
  input.value = 'Brendan';
  doc.querySelector('[data-action="save-local-profile"]').click();
  await waitForUi(window, 30);
  assert.equal(shell.__state.authState.user.display_name, 'Brendan');
  assert.match(doc.getElementById('accountSummary').textContent, /Brendan/);
  assert.equal(doc.getElementById('settingsLogoutButton'), null);
});

test('renderer keeps the composer token display removed when context metadata is unavailable', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      status: {
        async get() {
          return {};
        },
      },
    },
  });

  assert.equal(window.document.getElementById('composerTokenLabel'), null);
});

test('renderer retires the history disclosure without deleting the rollback preference', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    sidebarHistoryPreferences: { expanded: false },
  });
  const doc = window.document;
  assert.equal(doc.getElementById('sidebarHistoryToggle'), null);
  assert.equal(doc.getElementById('sidebarHistoryContent').hidden, false);
  assert.ok(doc.getElementById('conversationGroups'), 'history remains directly available without a disclosure');
  assert.deepEqual(JSON.parse(window.localStorage.getItem('jenny.sidebarHistory.v1')), {
    expanded: false,
  });
});

test('renderer sidebar resizer ignores non-primary drags and supports keyboard reset', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const workspace = doc.getElementById('workspace');
  const sidebarResizer = doc.getElementById('sidebarResizer');
  workspace.getBoundingClientRect = () => ({ top: 0, left: 0, right: 1600, bottom: 900, width: 1600, height: 900 });
  sidebarResizer.setPointerCapture = () => {};
  sidebarResizer.releasePointerCapture = () => {};

  function pointer(type, detail) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      button: { value: detail.button ?? 0 },
      pointerId: { value: detail.pointerId ?? 1 },
      clientX: { value: detail.clientX ?? 0 },
    });
    sidebarResizer.dispatchEvent(event);
  }

  sidebarResizer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(workspace.style.getPropertyValue('--sidebar-current-width'), '320px');

  pointer('pointerdown', { button: 2, pointerId: 99, clientX: 320 });
  pointer('pointermove', { button: 2, pointerId: 99, clientX: 420 });
  assert.equal(workspace.classList.contains('panel-resizing'), false);
  assert.equal(workspace.style.getPropertyValue('--sidebar-current-width'), '320px');

  sidebarResizer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(sidebarResizer.getAttribute('aria-valuenow'), '344');
  assert.equal(workspace.style.getPropertyValue('--sidebar-current-width'), '344px');

  sidebarResizer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(sidebarResizer.getAttribute('aria-valuenow'), '320');
  assert.equal(workspace.style.getPropertyValue('--sidebar-current-width'), '320px');
});

test('renderer tools summary counts only mounted typed tool fields', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      features: {
        state: {
          tools: {
            web: true,
            todo: true,
          },
          featureFlags: {
            shell_security: true,
            git_tracking: false,
          },
          availability: {
            runtime: {
              managedSidecarActive: true,
              windowsOnly: true,
              workspaceRootStatus: {
                state: 'missing',
                message: 'No workspace root is configured yet.',
              },
            },
            tools: {
              web: { enabled: true, managedSidecarRequired: true },
              todo: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
            },
            featureFlags: {
              shell_security: { enabled: false },
            },
          },
        },
      },
    },
  });
  const doc = window.document;

  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  doc.querySelector('.settings-nav-item[data-settings-section="tools"]').click();
  await waitForUi(window, 20);

  assert.match(
    doc.getElementById('toolsSummary').textContent,
    /1 enabled capabilities ready .* workspace root missing/i
  );
  assert.ok(doc.getElementById('toolsSummary').querySelector('.inv-status-row'));
});

test('renderer settings renders and saves manifest-backed tool config fields', async (t) => {
  const updatePatches = [];
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      features: {
        state: {
          tools: {
            futureTool: false,
          },
          featureFlags: {
            shell_security: true,
            git_tracking: true,
          },
          toolConfig: {
            schemaVersion: 1,
            fields: [
              {
                key: 'futureTool',
                label: 'Future tool',
                fieldType: 'toggle',
                storage: 'config',
                default: false,
                helpText: 'Only appears in test metadata.',
                configFlag: 'tools_future_tool_enabled',
                toolIds: ['future_tool'],
              },
            ],
          },
          availability: {
            runtime: {
              managedSidecarActive: true,
              windowsOnly: true,
              workspaceRootStatus: {
                state: 'ready',
                message: 'Workspace root is configured.',
              },
            },
            tools: {
              futureTool: { enabled: true, managedSidecarRequired: true },
            },
            featureFlags: {},
          },
        },
        async updateSettings(patch) {
          updatePatches.push(patch);
          return { tools: patch.tools || {} };
        },
      },
    },
  });
  const doc = window.document;

  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  doc.querySelector('.settings-nav-item[data-settings-section="tools"]').click();
  await waitForUi(window, 20);

  const toolConfigList = doc.getElementById('toolsConfigFieldList');
  assert.ok(toolConfigList);
  assert.match(toolConfigList.textContent, /Future tool/);
  assert.match(toolConfigList.textContent, /Only appears in test metadata\./);
  const toggle = toolConfigList.querySelector('[data-inv-toggle="settings-tool-config-futureTool"]');
  assert.ok(toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');

  toggle.click();
  await waitForUi(window, 40);

  assert.deepEqual(JSON.parse(JSON.stringify(updatePatches.at(-1))), { tools: { futureTool: true } });
  assert.equal(shell.__state.featuresState.tools.futureTool, true);
});

test('Session Tools renders and saves the default run mode for new chats', async (t) => {
  const updatePatches = [];
  const { window } = await loadRendererTestApp(t, {
    shell: {
      chatUi: {
        async getState() {
          return { zoomPercent: 100, defaultRunMode: 'auto' };
        },
        async updateSettings(patch) {
          updatePatches.push(patch);
          return { zoomPercent: 100, defaultRunMode: patch.defaultRunMode };
        },
      },
    },
  });
  const doc = window.document;

  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  doc.querySelector('.settings-nav-item[data-settings-section="tools"]').click();
  await waitForUi(window, 20);

  const select = doc.getElementById('defaultRunModeSelect');
  assert.ok(select);
  assert.equal(select.value, 'auto');
  assert.equal(select.getAttribute('aria-label'), 'Default run mode for new sessions');
  assert.deepEqual([...select.options].map((option) => option.textContent), ['Ask', 'Auto', 'Plan']);
  const fieldText = doc.querySelector('[data-default-run-mode-field]').textContent;
  assert.match(fieldText, /Jenny asks before running tools that change things\./);
  assert.match(fieldText, /Python, blocked commands, and explicit denies still prompt\./);
  assert.match(fieldText, /Read-only: Jenny plans first and presents it before acting\./);
  assert.match(fieldText, /Applies to new chats; the composer switcher changes the current chat\./);

  select.value = 'plan';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.deepEqual(JSON.parse(JSON.stringify(updatePatches)), [{ defaultRunMode: 'plan' }]);
  assert.equal(doc.getElementById('defaultRunModeSelect').value, 'plan');
});

test('a fresh chat projects an auto default onto its first send', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chatUi: {
        async getState() {
          return { zoomPercent: 100, defaultRunMode: 'auto' };
        },
      },
    },
  });
  await waitForUi(window, 20);
  const input = window.document.getElementById('chatInput');
  input.value = 'Use the configured default';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('sendButton').click();
  await waitForUi(window, 30);

  assert.equal(shell.__state.chatCalls[0].approvalMode, 'auto_run');
});

test('renderer settings surfaces an unavailable Ollama model catalog reason', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      models: {
        async list() {
          return {
            object: 'list',
            active_model: '',
            available: false,
            reason: 'Could not query Ollama at http://localhost:11434: ConnectError',
            data: [],
          };
        },
      },
      status: {
        async get() {
          return {};
        },
      },
    },
  });

  const modelBadge = window.document.getElementById('modelBadge');
  const modelStatus = window.document.getElementById('modelStatus');
  const composerModelSelect = window.document.getElementById('composerModelSelect');

  assert.equal(modelBadge.textContent, 'Unavailable');
  assert.equal(
    modelStatus.textContent,
    'Could not query Ollama at http://localhost:11434: ConnectError'
  );
  assert.equal(window.document.getElementById('modelSelect'), null);
  assert.equal(composerModelSelect.options.length, 1);
  assert.equal(composerModelSelect.options[0].textContent, 'Use default');
});

test('renderer settings shows catalog failure warning even when active model is set', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      models: {
        async list() {
          return {
            object: 'list',
            active_model: 'gpt-4o',
            available: false,
            reason: 'connection refused',
            data: [],
          };
        },
      },
      status: {
        async get() {
          return { model: 'gpt-4o' };
        },
      },
    },
  });

  const modelBadge = window.document.getElementById('modelBadge');
  const modelStatus = window.document.getElementById('modelStatus');

  assert.equal(modelBadge.textContent, 'gpt-4o');
  assert.ok(
    modelStatus.textContent.includes('catalog unavailable'),
    `expected catalog unavailable warning but got: ${modelStatus.textContent}`
  );
  assert.ok(
    modelStatus.textContent.includes('gpt-4o'),
    `expected active model in status but got: ${modelStatus.textContent}`
  );
});

test('models badge reads "Default backend" at rest with an info data-state', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      models: {
        async list() {
          return { object: 'list', active_model: '', available: true, data: [] };
        },
      },
      status: { async get() { return {}; } },
    },
  });

  const modelBadge = window.document.getElementById('modelBadge');
  assert.equal(modelBadge.textContent, 'Default backend');
  assert.equal(modelBadge.getAttribute('data-state'), 'info');
});

test('models badge reflects the active runtime model with a live data-state', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      models: {
        async list() {
          return { object: 'list', active_model: 'llama3', available: true, data: [] };
        },
      },
      status: { async get() { return { model: 'llama3' }; } },
    },
  });

  const modelBadge = window.document.getElementById('modelBadge');
  assert.equal(modelBadge.textContent, 'llama3');
  assert.equal(modelBadge.getAttribute('data-state'), 'live');
});

test('Composer disables reasoning effort and explains unsupported model capability', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      models: {
        async list() {
          return { object: 'list', active_model: '', available: true, data: [] };
        },
      },
      status: { async get() { return { reasoning_effort_support: 'unsupported' }; } },
    },
  });

  const effortSelect = window.document.getElementById('composerEffortSelect');
  assert.equal(effortSelect.disabled, true);
  assert.equal(effortSelect.dataset.reasoningSupported, 'false');
  const popover = window.document.getElementById('composerModelPopover');
  window.inventory.popover.open(popover, {
    trigger: window.document.getElementById('composerModelPill'),
  });
  assert.ok(popover.querySelector('.composer-model-picker-option'));
  assert.equal(popover.querySelector('.composer-model-picker-thinking'), null);
  assert.equal(window.document.getElementById('settingsEffortSelect'), null);
});

test('models catalog-unavailable affordance is additive to the existing model status', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      models: {
        async list() {
          return {
            object: 'list',
            active_model: '',
            available: false,
            reason: 'Could not query Ollama at http://localhost:11434: ConnectError',
            data: [],
          };
        },
      },
      status: { async get() { return {}; } },
    },
  });

  const modelCatalogEmpty = window.document.getElementById('modelCatalogEmpty');
  const modelStatus = window.document.getElementById('modelStatus');
  const composerModelSelect = window.document.getElementById('composerModelSelect');

  // New affordance shows.
  assert.equal(modelCatalogEmpty.hidden, false);
  assert.match(modelCatalogEmpty.textContent, /Model catalog unavailable/);
  // ...without disturbing the existing status text or Composer option-building (additive).
  assert.equal(
    modelStatus.textContent,
    'Could not query Ollama at http://localhost:11434: ConnectError'
  );
  assert.equal(composerModelSelect.options.length, 1);
  assert.equal(composerModelSelect.options[0].textContent, 'Use default');
});

test('Models Settings removes duplicate session controls while Composer remains their owner', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const card = doc.querySelector('section.settings-card[data-settings-section="models"]');

  assert.equal(doc.getElementById('modelStatus').getAttribute('aria-live'), 'polite');
  for (const removedId of [
    'modelSelect', 'settingsEffortSelect', 'clearSessionModelButton',
    'loadModelButton', 'unloadModelButton', 'sessionModelStatus', 'effortStatus',
  ]) {
    assert.equal(doc.getElementById(removedId), null, `${removedId} is removed from Settings`);
  }
  assert.ok(doc.getElementById('composerModelSelect'));
  assert.ok(doc.getElementById('composerEffortSelect'));
  // The composer popover hosts the picker plus the hidden carrier selects.
  assert.ok(doc.querySelector('#composerModelPopover [data-composer-model-picker]'));
  assert.ok(doc.querySelector('#composerModelPopover .composer-model-carriers[hidden] #composerModelSelect'));
});

test('legacy face flag does not inject face DOM into the standard shell', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      features: { state: { featureFlags: { face_avatar: true } } },
    },
  });

  assert.equal(window.document.getElementById('faceStatusNote'), null);
  assert.equal(window.document.getElementById('mouthPath'), null);
  assert.equal(window.document.getElementById('symbolPath'), null);
  assert.equal(window.document.getElementById('settingsDetailsToggle'), null);
});

test('renderer stays stable when comet personality is disabled', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      features: { state: { featureFlags: { comet_personality: false } } },
    },
  });

  await waitForUi(window, 20);

  assert.ok(window.document.getElementById('chatView'));
  assert.equal(window.document.querySelector('.chat-comet-svg'), null);
});

/* ── Phase 7B — Run setup again row in Settings ────────────────────────── */

test('phase7B Run setup again row dispatches updateState with dismissed=false and setupComplete=false', async () => {
  const { createSetupService } = require('../renderer/services/renderer-setup-service');
  const calls = [];
  const fakeBridge = {
    setup: {
      async getState() {
        return {
          setup_complete: true,
          setup_state: {
            seen: true,
            dismissed: true,
            setup_complete: true,
            completed_at: '2026-05-07T12:00:00.000Z',
            updated_at: '2026-05-07T12:00:00.000Z',
            steps: { workspace_root: 'done', local_model: 'done', endpoint: 'done', personality: 'done', skills: 'done' },
            tools_workspace_root_configured: true,
            mcp_tools_discovered: false,
            assistant_identity: { agentName: 'Jenny', profile: 'balanced', customText: '', updatedAt: '' },
          },
        };
      },
      async updateState(patch) {
        calls.push(patch);
        return {
          setup_complete: false,
          setup_state: {
            seen: true,
            dismissed: false,
            setup_complete: false,
            completed_at: '2026-05-07T12:00:00.000Z',
            updated_at: '2026-05-07T12:01:00.000Z',
            steps: { workspace_root: 'done', local_model: 'done', endpoint: 'done', personality: 'done', skills: 'done' },
            tools_workspace_root_configured: true,
            mcp_tools_discovered: false,
            assistant_identity: { agentName: 'Jenny', profile: 'balanced', customText: '', updatedAt: '' },
          },
        };
      },
    },
  };
  const service = createSetupService({
    windowRef: { jennyShell: fakeBridge },
    appendClientLog: () => {},
    toErrorMessage: (e) => String((e && e.message) || e),
  });
  const result = await service.updateState({ dismissed: false, setupComplete: false });
  assert.equal(calls.length, 1, 'one updateState call');
  assert.deepEqual(calls[0], { dismissed: false, setupComplete: false });
  assert.equal(result.setupComplete, false, 'normalized snapshot reflects re-opened setup');
  assert.equal(result.dismissed, false, 'dismissed flag flipped');
  // Step progress is preserved: we did not pass steps in the patch, so the
  // returned snapshot still reports each step as `done`.
  assert.equal(result.steps.workspaceRoot, 'done');
  assert.equal(result.steps.skills, 'done');
});

test('phase7D Settings account row opens Help and bounded factory reset modal', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;

  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 30);
  doc.querySelector('.settings-nav-item[data-settings-section="account"]').click();
  await waitForUi(window, 40);

  const actions = doc.getElementById('setupSettingsActions');
  assert.match(actions.textContent, /Run setup again/);
  assert.match(actions.textContent, /help/i);
  assert.match(actions.textContent, /Reset onboarding/);

  actions.querySelector('[data-action="settingsOpenSetupHelp"]').click();
  await waitForUi(window, 30);
  assert.match(doc.body.textContent, /Workspace root/);
  assert.match(doc.body.textContent, /MCP servers/);
  doc.querySelector('[data-step-modal-action="close"]').click();
  await waitForUi(window, 20);

  actions.querySelector('[data-action="settingsOpenFactoryReset"]').click();
  await waitForUi(window, 30);
  assert.match(doc.body.textContent, /Redo first-launch setup/);
  assert.match(doc.body.textContent, /Chat sessions and sidebar history/);

  doc.querySelector('[data-step-modal-action="confirm"]').click();
  await waitForUi(window, 60);

  assert.equal(shell.__state.setupResetCalls, 0);
  assert.equal(shell.__state.setupFactoryResetCalls, 1);
  assert.equal(window.__rendererState.setup.setupComplete, false);
  assert.equal(window.__rendererState.setup.assistantIdentity.agentName, 'Jenny');
  assert.equal(window.__rendererState.ui.activeView, 'home');
  assert.match(doc.body.textContent, /Onboarding reset complete — setup tiles reopened on Companion Home\./);
});

test('Settings relocates standalone MCP management into Plugins & Extensions', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      features: { state: { featureFlags: { plugins: true, mcp_management_ui: true } } },
      skills: {
        state: {
          featureEnabled: true,
          settings: { bundledEnabled: true, userEnabled: true, projectEnabled: true },
          scopes: [],
          warnings: [],
          counts: { total: 0, always: 0, warnings: 0 },
        },
      },
      mcpDiscovery: {
        state: {
          schemaVersion: 1,
          readOnly: false,
          servers: [
            { name: 'notes', transport: 'stdio', status: 'running', toolsCount: 3,
              enabled: true, trust: { status: 'approved' } },
          ],
        },
      },
    },
  });
  const doc = window.document;

  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 30);
  doc.querySelector('.settings-nav-item[data-settings-section="plugins"]').click();
  await waitForUi(window, 60);

  const group = doc.getElementById('mcpServersGroup');
  assert.ok(group);
  assert.ok(group.closest('.settings-card[data-settings-section="plugins"]'));
  assert.equal(group.parentElement.id, 'mcpServersHost');
  assert.ok(group.classList.contains('settings-group--wide'));
  assert.match(group.textContent, /notes/);
  assert.ok(group.querySelector('[data-mcp-servers-action="details"]'));
  assert.ok(group.querySelector('[role="switch"]'));
  assert.equal(doc.getElementById('mcpDiscoveryStatus'), null);
  assert.equal(doc.querySelector('[data-action="mcpDiscoveryOpenConfig"]'), null);
});
