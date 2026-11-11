'use strict';

/* Row 122: the Settings switch for before and after pictures. It is a Chat
 * layout row backed by the change_pictures feature flag, on by default, and it
 * writes only its own feature override. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi, openSettingsView } = require('./helpers/renderer-shell-harness');

async function loadSettings(t, options) {
  const app = await loadRendererApp(options);
  t.after(() => app.dispose());
  await openSettingsView(app.window);
  return app;
}

const toggleOf = (window) => window.document.querySelector('[data-inv-toggle="changePicturesToggle"]');

test('the pictures switch is a Chat layout row, on by default, and follows the flag', async (t) => {
  const { window, shell } = await loadSettings(t);
  const doc = window.document;
  const chatLayout = doc.getElementById('appearanceChatLayoutHeading').closest('.settings-group');
  const mount = chatLayout.querySelector('[data-setting-mount="changePicturesToggle"]');
  assert.ok(mount, 'the switch mounts in Chat layout');
  assert.ok(mount.contains(toggleOf(window)));
  assert.equal(toggleOf(window).getAttribute('aria-checked'), 'true');
  assert.match(mount.textContent, /Show before and after pictures of page changes/);
  assert.match(mount.textContent, /Off takes no pictures and shows none/);

  await shell.__emitFeaturesChanged({ featureFlags: { change_pictures: false } });
  assert.equal(toggleOf(window).getAttribute('aria-checked'), 'false');
  await shell.__emitFeaturesChanged({ featureFlags: { change_pictures: true } });
  assert.equal(toggleOf(window).getAttribute('aria-checked'), 'true');
});

test('the pictures switch is searchable and assigned to Appearance', async (t) => {
  const { window } = await loadSettings(t);
  const entry = window.rendererSettingsFieldCopy.listSettingsSearchEntries()
    .find((candidate) => candidate.id === 'changePicturesToggle');
  assert.equal(entry?.sectionId, 'appearance');
  assert.equal(entry?.label, 'Show before and after pictures of page changes');
  for (const term of ['before and after', 'pictures', 'screenshot']) {
    assert.equal(entry?.keywords?.includes(term), true, `the copy must index "${term}"`);
  }
});

test('turning the switch off writes only the change_pictures override', async (t) => {
  const updateCalls = [];
  const { window } = await loadSettings(t, {
    shell: {
      features: {
        async updateSettings(patch, { state }) {
          updateCalls.push(patch);
          return {
            ...state.featuresState,
            featureFlags: { ...state.featuresState.featureFlags, ...patch.featureOverrides },
            featureOverrides: { ...state.featuresState.featureOverrides, ...patch.featureOverrides },
          };
        },
      },
    },
  });
  const mount = window.document.querySelector('[data-setting-mount="changePicturesToggle"]');
  mount.dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'changePicturesToggle', checked: false },
  }));
  await waitForUi(window, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(updateCalls)), [{ featureOverrides: { change_pictures: false } }]);
  assert.equal(toggleOf(window).getAttribute('aria-checked'), 'false');
});
