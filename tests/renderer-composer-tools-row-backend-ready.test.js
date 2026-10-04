'use strict';

// Live re-check 2026-09-27: after an app restart the composer's Tools row was
// missing in both panes (`.composer-toggle-slot` empty). The row is built from
// tools.list, whose composer categories (web, terminal, Python, files) come
// from the sidecar's tools_status. The only boot read ran while the backend was
// still starting, so it saw no category, rendered nothing, and nothing re-read
// the inventory once the backend reported ready. Full-app boot through the
// real wiring (composition -> chat shell controller -> chat event bindings).

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const SIDECAR_TOOLS = [
  { name: 'web_search', surfaceFamily: 'web', available: true, reason: '', lockdownAvailable: false },
  { name: 'run_command', surfaceFamily: 'terminal', available: true, reason: '', lockdownAvailable: false },
];

test('the composer Tools row appears once the backend reports ready after a cold boot', async (t) => {
  let sidecarReady = false;
  const app = await loadRendererApp({ shell: {
    features: { state: { tools: { web: true } } },
    backend: {
      getStatus: () => (sidecarReady
        ? { phase: 'ready', detail: '', mode: 'managed-dev' }
        : { phase: 'starting', detail: 'Starting managed sidecar.', mode: 'managed-dev' }),
    },
    tools: {
      // Before ready the main process only knows its own registry tools, none
      // of which belongs to a composer category.
      list: () => (sidecarReady ? SIDECAR_TOOLS : [{ name: 'ask_user', available: false }]),
    },
  } });
  t.after(async () => { await app.dispose(); });
  const { window, shell } = app;
  const slot = () => window.document.getElementById('composerToolToggleSlot');

  await waitForUi(window, 40);
  assert.equal(
    slot().querySelector('[data-inv-chip="composer-tools"]'),
    null,
    'no composer category is known while the backend is starting'
  );

  sidecarReady = true;
  await shell.__emitBackendStatus({ phase: 'ready', detail: '', mode: 'managed-dev' });
  await waitForUi(window, 40);

  const chip = slot().querySelector('[data-inv-chip="composer-tools"]');
  assert.ok(chip, 'the Tools row renders once the sidecar tool inventory exists');
  assert.match(chip.textContent, /2 tools/, 'both sidecar categories are counted');
});

test('chat panel keeps the project pill slot and Full settings works while composer preferences are locked', async (t) => {
  const app = await loadRendererApp({ shell: { sessions: [{ id: 'chat-panel-test', title: 'Panel test', project_id: 'project_general' }], tools: { list: () => SIDECAR_TOOLS } } });
  t.after(async () => { await app.dispose(); });
  const { window } = app;
  await waitForUi(window, 40);
  const doc = window.document;
  const panel = doc.getElementById('composerChatPanel');
  doc.querySelector('[data-session-id="chat-panel-test"]')?.click();
  await waitForUi(window, 30);
  const project = doc.getElementById('composerProjectPillSlot');
  assert.equal(panel.contains(project), true);
  assert.ok(project.querySelector('#composerProjectPill'), 'the real workspace nudge renders the moved project pill');
  const state = window.__rendererState;
  state.auth.authenticated = false;
  const slot = doc.getElementById('composerToolToggleSlot');
  slot.querySelector('#composerToolsChip').click();
  panel.querySelector('[data-chat-panel-action="settings"]').click();
  await waitForUi(window, 20);
  assert.equal(panel.hidden, true);
  assert.equal(state.ui.activeView, 'settings');
  assert.equal(state.ui.activeSettingsSection, 'tools');
});
