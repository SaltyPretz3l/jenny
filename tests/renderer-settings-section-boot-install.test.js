'use strict';

// Settings-section sibling-controller boot-install regression (Wave-R R2).
//
// Reproduces the 2026-07-05 queue-drive "backend works, UI surface never
// mounts" class for three flag-gated Settings groups that share one root
// cause -- a feature-flag hydration race, identical in shape to the Artifact
// Panel V2 boot race fixed in 0d0118d:
//
//   * The renderer boot seed (renderer-bootstrap-utils.js) does NOT carry the
//     knowledge_layer / ollama_tray_remediation / mcp_management_ui keys, so
//     they are `undefined` until the async feature payload lands via
//     ensureComposerFeatureStateLoaded() partway through bootstrapAppShell.
//   * registerShellCleanups() creates + bind()s the sibling controllers
//     BEFORE that hydration. Each bind() gates its mount on the flag, so with
//     the flag still undefined the group never mounts -- and nothing
//     re-renders the controller after the real flags land (contrast Model
//     library, which recovers via its 15s syncFromState tick).
//
// The existing per-controller unit tests construct each controller with the
// flag already true, so they are vacuous with respect to this boot ordering.
// This test boots the FULL shell on the real bootstrap path with the flags on
// the async features.getState() stub (NOT the boot seed), and asserts each
// group mounts into its Settings card after hydration settles.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function bootOptions() {
  return {
    windowInnerWidth: 1600,
    windowInnerHeight: 900,
    persistedActiveView: 'chat',
    // Backend feature payload (returned by the harness features.getState stub):
    // all three flags default-ON, exactly as buildEffectiveFeatureFlags reports
    // them live. The renderer boot seed still omits the keys, so they stay
    // undefined until this payload hydrates partway through boot -- preserving
    // the race the bug depends on.
    shell: {
      features: {
        state: {
          featureFlags: {
            knowledge_layer: true,
            ollama_tray_remediation: true,
            mcp_management_ui: true,
            plugins: true,
          },
        },
      },
    },
  };
}

test('mounts the flag-gated Settings sibling groups after feature-flag hydration on the real boot path', async (t) => {
  const app = await loadRendererApp(bootOptions());
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;

  // Let the post-hydration re-activation settle.
  await waitForUi(window, 25);

  const toolsCard = doc.querySelector('.settings-card[data-settings-section="tools"]');
  const modelsCard = doc.querySelector('.settings-card[data-settings-section="models"]');
  const pluginsCard = doc.querySelector('.settings-card[data-settings-section="plugins"]');
  assert.ok(toolsCard, 'expected the Tools settings card to exist in the shell');
  assert.ok(modelsCard, 'expected the Models settings card to exist in the shell');
  assert.ok(pluginsCard, 'expected the Plugins & Extensions settings card to exist in the shell');

  // Knowledge folders (Tools card, knowledge_layer).
  assert.ok(
    toolsCard.querySelector('#knowledgeFoldersGroup'),
    'Knowledge folders group must mount into the Tools card once knowledge_layer hydrates'
  );
  // MCP connections (Plugins & Extensions card, mcp_management_ui).
  assert.ok(
    pluginsCard.querySelector('#mcpServersGroup'),
    'MCP servers group must mount into Plugins & Extensions once mcp_management_ui hydrates'
  );
  const hostOrder = ['pluginsSettingsHost', 'skillsSettingsSection', 'mcpServersHost', 'pluginsSourcesHost'];
  assert.deepEqual(
    Array.from(pluginsCard.children).filter((node) => hostOrder.includes(node.id)).map((node) => node.id),
    hostOrder,
    'plugin groups keep their locked Installed → Skills → MCP → Sources host order'
  );
  assert.ok(pluginsCard.querySelector('#mcpServersGroup.settings-group--wide'));
  assert.equal(pluginsCard.querySelectorAll(':scope > .settings-card-header > h3').length, 1);
  // Ollama engine health (Models card, ollama_tray_remediation).
  assert.ok(
    modelsCard.querySelector('#ollamaHealthGroup'),
    'Ollama engine health group must mount into the Models card once ollama_tray_remediation hydrates'
  );

  // Guard against the card-scoping regression the controllers warn about: the
  // groups must NOT leak into the settings nav (which carries the same
  // data-settings-section attribute and precedes the cards in the DOM).
  const nav = doc.querySelector('.settings-nav, [data-settings-nav]');
  if (nav) {
    assert.equal(nav.querySelector('#knowledgeFoldersGroup'), null, 'group must not mount into the settings nav');
    assert.equal(nav.querySelector('#ollamaHealthGroup'), null, 'group must not mount into the settings nav');
    assert.equal(nav.querySelector('#mcpServersGroup'), null, 'group must not mount into the settings nav');
  }
});
