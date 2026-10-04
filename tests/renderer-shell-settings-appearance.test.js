const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { segmentedGroup, segmentedValue, segmentedOptions } = require('./helpers/segmented-control');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function setSurfaceHostBounds(window, host) {
  const width = 1280;
  const height = 720;
  host.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
  });
  window.dispatchEvent(new window.Event('resize'));
}

test('renderer shell applies saved appearance preferences on boot', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    appearance: {
      paletteId: 'paper',
      typographyId: 'editorial',
      motionId: 'expressive',
      threadStyleId: 'bold-graph',
      // Retired timeline-style preset: must be dropped, never projected onto
      // the root dataset.
      timelineStyleId: 'explorer-minimal',
    },
  });
  const root = window.document.documentElement;

  assert.equal(root.dataset.palette, 'paper');
  assert.equal(root.dataset.typography, 'editorial');
  assert.equal(root.dataset.motion, 'standard');
  assert.equal(root.dataset.composerHolo, 'on');
  assert.equal(root.dataset.spriteHolo, undefined);
  assert.equal(root.dataset.threadStyle, 'subtle');
  assert.equal(root.dataset.timelineStyle, undefined);
});

test('logs view inherits palette and typography changes across light and signal themes', async (t) => {
  const paperApp = await loadRendererTestApp(t, {
    appearance: {
      paletteId: 'paper',
      typographyId: 'editorial',
      motionId: 'calm',
    },
  });
  const signalApp = await loadRendererTestApp(t, {
    appearance: {
      paletteId: 'signal',
      typographyId: 'technical',
      motionId: 'expressive',
    },
  });

  const paperWindow = paperApp.window;
  const signalWindow = signalApp.window;
  const paperDoc = paperWindow.document;
  const signalDoc = signalWindow.document;

  paperDoc.getElementById('logsTopRailTab').click();
  signalDoc.getElementById('logsTopRailTab').click();
  await waitForUi(paperWindow, 30);
  await waitForUi(signalWindow, 30);

  assert.equal(paperDoc.documentElement.dataset.palette, 'paper');
  assert.equal(signalDoc.documentElement.dataset.palette, 'signal');
  assert.equal(paperDoc.documentElement.dataset.typography, 'editorial');
  assert.equal(signalDoc.documentElement.dataset.typography, 'technical');
  assert.ok(paperDoc.querySelector('.diagnostics-header'));
  assert.ok(signalDoc.querySelector('.diagnostics-header'));
  assert.ok(paperDoc.querySelector('.diagnostics-toolbar'));
  assert.ok(signalDoc.querySelector('.diagnostics-toolbar'));
  assert.ok(paperDoc.getElementById('logResultsLabel'));
  assert.ok(signalDoc.getElementById('logResultsLabel'));
  assert.match(paperDoc.querySelector('.diagnostics-header h2')?.textContent || '', /Diagnostics/i);
  assert.match(signalDoc.querySelector('.diagnostics-header h2')?.textContent || '', /Diagnostics/i);
});

test('settings shell omits the masthead and the retired appearance preview strip', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    appearance: {
      paletteId: 'signal',
      typographyId: 'technical',
    },
  });
  const masthead = window.document.querySelector('.settings-content-header .settings-masthead');
  const mastheadTitle = window.document.querySelector('.settings-masthead-title .page-title');
  const chipRow = window.document.querySelector('.settings-content-header .settings-overview-chip-row');
  const appearanceProof = window.document.getElementById('settingsAppearanceProof');

  assert.equal(masthead, null);
  assert.equal(mastheadTitle, null);
  assert.equal(chipRow, null);
  // Owner, 2026-10-03: the whole app previews a theme live; the strip is gone.
  assert.equal(appearanceProof, null);
  assert.equal(window.document.documentElement.dataset.palette, 'signal');
});

test('appearance controls update shell appearance without persisting session runtime preferences', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const paletteSelect = window.document.getElementById('appearancePaletteSelect');
  assert.ok(paletteSelect.closest('.settings-field').classList.contains('settings-field--wide-control'), 'long palette names get the wide dropdown');
  const typographySelect = window.document.getElementById('appearanceTypographySelect');
  const holoList = window.document.getElementById('appearanceHoloList');
  const root = window.document.documentElement;

  paletteSelect.value = 'signal';
  paletteSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  typographySelect.value = 'technical';
  typographySelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  const fireHolo = (id, checked) => holoList.dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id, checked },
  }));
  fireHolo('appearanceComposerHoloToggle', false);
  // The Appearance store serializes its writes; each settles before the next.
  await waitForUi(window, 20);

  assert.equal(root.dataset.palette, 'signal');
  assert.equal(root.dataset.typography, 'technical');
  assert.equal(root.dataset.motion, 'standard');
  assert.equal(root.dataset.composerHolo, 'off');
  assert.equal(root.dataset.spriteHolo, undefined);
  assert.equal(root.dataset.threadStyle, 'subtle');
  assert.deepEqual(shell.__state.setPreferenceCalls, []);
  assert.deepEqual(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')), {
    paletteId: 'signal',
    typographyId: 'technical',
    surfaceEffectId: 'none',
    composerHoloId: 'off',
    fontScaleId: 'default',
    chatWidthId: 'standard',
    startupAnimation: true,
    titlebarLoad: false,
    artifactAutoOpen: false,
    typeScaleVersion: 3,
  });
});

test('appearance spellcheck toggle reflects the resolved feature flag', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const getSpellcheckToggle = () => window.document.querySelector(
    '[data-inv-toggle="appearanceSpellcheckToggle"]'
  );

  assert.equal(getSpellcheckToggle()?.getAttribute('aria-checked'), 'true');
  await shell.__emitFeaturesChanged({ featureFlags: { text_spellcheck: false } });
  assert.equal(getSpellcheckToggle()?.getAttribute('aria-checked'), 'false');
  await shell.__emitFeaturesChanged({ featureFlags: { text_spellcheck: true } });
  assert.equal(getSpellcheckToggle()?.getAttribute('aria-checked'), 'true');
});

test('appearance spellcheck copy remains searchable and assigned to Appearance', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const entry = window.rendererSettingsFieldCopy
    ?.SETTINGS_FIELD_COPY?.appearanceSpellcheckToggle;

  assert.equal(entry?.label, 'Check spelling as you type');
  assert.equal(
    entry?.description,
    'Misspelled words are underlined in message and note fields, and right-clicking one offers corrections.'
  );
  assert.equal(entry?.sectionId, 'appearance');
  for (const term of ['spell check', 'spelling', 'dictionary']) {
    assert.equal(entry?.keywords?.includes(term), true, `spellcheck Settings copy must index "${term}"`);
  }
});

test('appearance spellcheck toggle persists only its guarded feature override', async (t) => {
  const updateCalls = [];
  const { window } = await loadRendererTestApp(t, {
    shell: {
      features: {
        async updateSettings(patch, { state }) {
          updateCalls.push(patch);
          return {
            ...state.featuresState,
            featureFlags: {
              ...state.featuresState.featureFlags,
              text_spellcheck: patch.featureOverrides.text_spellcheck,
            },
            featureOverrides: {
              ...state.featuresState.featureOverrides,
              ...patch.featureOverrides,
            },
          };
        },
      },
    },
  });
  const spellcheckList = window.document.getElementById('appearanceSpellcheckList');
  const fireSpellcheck = (id, checked) => spellcheckList.dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id, checked },
  }));

  fireSpellcheck('appearanceComposerHoloToggle', false);
  await waitForUi(window, 0);
  assert.deepEqual(updateCalls, []);

  fireSpellcheck('appearanceSpellcheckToggle', false);
  await waitForUi(window, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(updateCalls)), [
    { featureOverrides: { text_spellcheck: false } },
  ]);
});

// UIUX-039: peripheral-garden had a full CSS token surface and a picker
// option but no bound JS controller (no renderer/peripheral-garden/index.js)
// -- an advertised surface with no runtime owner. Removed from
// SURFACE_EFFECT_PRESETS; this test now pins the option's absence.
test('Peripheral Garden is not offered as a surface effect option (removed, never had a controller)', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const surfaceEffectSelect = doc.getElementById('appearanceSurfaceEffectSelect');

  assert.ok(surfaceEffectSelect);
  assert.equal(doc.getElementById('appearancePeripheralGardenToggle'), null);
  assert.equal(
    Array.from(surfaceEffectSelect.options).some((option) => option.value === 'peripheral-garden'),
    false
  );
  assert.equal(
    Array.from(surfaceEffectSelect.options).some((option) => option.value === 'circuit-trace-v3'),
    false
  );
});

test('Circuit Trace remains the rendered surface when it is the selected effect', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    appearance: {
      paletteId: 'midnight',
      typographyId: 'system',
      motionId: 'standard',
      surfaceEffectId: 'circuit-trace',
    },
  });
  const doc = window.document;
  const homeView = doc.getElementById('homeView');
  const chatSurfaceEffectLeft = doc.getElementById('chatSurfaceEffectLeft');
  const surfaceEffectSelect = doc.getElementById('appearanceSurfaceEffectSelect');
  setSurfaceHostBounds(window, homeView);
  setSurfaceHostBounds(window, chatSurfaceEffectLeft);

  surfaceEffectSelect.value = 'none';
  surfaceEffectSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);
  surfaceEffectSelect.value = 'circuit-trace';
  surfaceEffectSelect.dispatchEvent(new window.Event('change', { bubbles: true }));

  await waitForUi(window, 50);

  assert.equal(doc.documentElement.dataset.surfaceEffect, 'circuit-trace');
  assert.ok(doc.querySelector('[data-widget-modifier~="circuit-trace"]'));
  assert.ok(doc.querySelector('.widget-circuit-trace-canvas'));
  assert.equal(doc.querySelector('.peripheral-garden'), null);
});

test('appearance bundle selector applies Lexicon and falls back to Custom after manual tweaks', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const root = doc.documentElement;
  const bundleSelect = doc.getElementById('appearanceThemeBundleSelect');
  const paletteSelect = doc.getElementById('appearancePaletteSelect');
  const surfaceEffectSelect = doc.getElementById('appearanceSurfaceEffectSelect');
  const appearanceBadge = doc.getElementById('appearanceBadge');
  const appearanceStatus = doc.getElementById('appearanceStatus');
  const chatView = doc.getElementById('chatView');

  assert.ok(bundleSelect);
  assert.equal(bundleSelect.value, 'jenny-default');

  bundleSelect.value = 'lexicon';
  bundleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(root.dataset.palette, 'lexicon');
  assert.equal(root.dataset.typography, 'editorial');
  assert.equal(root.dataset.motion, 'standard');
  assert.equal(root.dataset.surfaceEffect, 'none');
  assert.equal(root.dataset.composerHolo, 'on');
  assert.equal(root.dataset.spriteHolo, undefined);
  assert.equal(root.dataset.threadStyle, 'subtle');
  assert.equal(chatView.hasAttribute('data-widget-modifier'), false);
  assert.equal(appearanceBadge, null);
  assert.equal(appearanceStatus, null);
  assert.equal(
    Array.from(surfaceEffectSelect.options).some((option) => option.value === 'pretext-drift'),
    false
  );
  assert.deepEqual(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')), {
    paletteId: 'lexicon',
    typographyId: 'editorial',
    surfaceEffectId: 'none',
    composerHoloId: 'on',
    // Bundles carry no font-scale axis; the Default text size survives a
    // bundle apply (owner review 2026-08-19).
    fontScaleId: 'default',
    chatWidthId: 'standard',
    startupAnimation: true,
    titlebarLoad: false,
    artifactAutoOpen: false,
    typeScaleVersion: 3,
  });

  paletteSelect.value = 'signal';
  paletteSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(bundleSelect.value, 'custom');
});

test('Slate theme bundle keeps the flat background while restoring the composer holo', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const root = doc.documentElement;
  const bundleSelect = doc.getElementById('appearanceThemeBundleSelect');
  const chatView = doc.getElementById('chatView');

  bundleSelect.value = 'slate';
  bundleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(root.dataset.palette, 'slate');
  assert.equal(root.dataset.typography, 'system');
  assert.equal(root.dataset.surfaceEffect, 'none');
  assert.equal(root.dataset.composerHolo, 'on');
  assert.equal(root.dataset.spriteHolo, undefined);
  assert.equal(chatView.hasAttribute('data-widget-modifier'), false);
  assert.deepEqual(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')), {
    paletteId: 'slate',
    typographyId: 'system',
    surfaceEffectId: 'none',
    composerHoloId: 'on',
    fontScaleId: 'default',
    chatWidthId: 'standard',
    startupAnimation: true,
    titlebarLoad: false,
    artifactAutoOpen: false,
    typeScaleVersion: 3,
  });
});

test('UIUX-028(d): switching theme bundles preserves a Large text size instead of silently resetting it', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const root = doc.documentElement;
  const bundleSelect = doc.getElementById('appearanceThemeBundleSelect');

  // User sets Large text (an accessibility preference, not a "look").
  segmentedGroup(doc, 'appearanceFontScaleSelect').querySelector('[data-value="large"]').click();
  await waitForUi(window, 30);
  assert.equal(root.dataset.fontScale, 'large');

  // Switching to a theme bundle (Pewter documents no fontScaleId axis at
  // all) must not silently reset the text size back to Default.
  bundleSelect.value = 'pewter';
  bundleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(root.dataset.palette, 'pewter', 'the bundle axes it DOES document still apply');
  assert.equal(root.dataset.fontScale, 'large', 'a bundle switch must not reset Large text to Default');
  assert.equal(segmentedValue(doc, 'appearanceFontScaleSelect'), 'large');
  assert.equal(
    JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).fontScaleId,
    'large',
    'the persisted preferences must also keep the font scale'
  );

  // Switching bundles again (Obsidian) must still preserve it.
  bundleSelect.value = 'obsidian';
  bundleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);
  assert.equal(root.dataset.fontScale, 'large', 'a second bundle switch still preserves the font scale');
});

test('appearance reset restores the default shell appearance', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    appearance: {
      paletteId: 'signal',
      typographyId: 'technical',
      motionId: 'expressive',
      threadStyleId: 'bold-graph',
    },
  });
  const resetButton = window.document.getElementById('appearanceResetButton');
  const root = window.document.documentElement;

  // Tier C item 10 upgraded the reset control to a two-step arm -> confirm
  // flow: the first click arms and renders a Confirm/Cancel pair inside the
  // button's container; only Confirm applies the reset.
  resetButton.click();
  const container = resetButton.closest('.settings-actions') || resetButton.parentElement;
  assert.equal(container.dataset.armed, 'true');
  const confirmButton = container.querySelector('[data-action="confirm"]');
  assert.ok(confirmButton, 'arming renders a Confirm button');
  confirmButton.click();
  await waitForUi(window, 30);

  assert.equal(root.dataset.palette, 'slate');
  assert.equal(root.dataset.typography, 'technical');
  assert.equal(root.dataset.fontScale, 'default');
  assert.equal(root.dataset.motion, 'standard');
  assert.equal(root.dataset.composerHolo, 'on');
  // The sprite holo is retired: no palette writes data-sprite-holo.
  assert.equal(root.dataset.spriteHolo, undefined);
  assert.equal(root.dataset.threadStyle, 'subtle');
});

test('appearance keeps fixed standard runtime motion without an idle status line', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    reducedMotion: true,
    appearance: {
      paletteId: 'midnight',
      typographyId: 'system',
      motionId: 'expressive',
    },
  });
  const appearanceStatus = window.document.getElementById('appearanceStatus');

  assert.equal(appearanceStatus, null);
  assert.equal(window.document.documentElement.dataset.motion, 'standard');
});

test('retired chat zoom: a persisted value is ignored on boot and the Composer control is gone', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: { chatUi: { state: { zoomPercent: 115 } } },
  });
  const root = window.document.documentElement;
  window.document.getElementById('composerAttachShortcut').click();
  await waitForUi(window, 20);

  assert.equal(window.document.getElementById('composerChatZoomSelect'), null);
  assert.equal(root.dataset.chatZoom, undefined);
  assert.equal(root.style.getPropertyValue('--chat-zoom-factor'), '');
  assert.equal(shell.__state.chatUiState.zoomPercent, 115, 'the persisted value is preserved, just unused');
});

test('Ctrl+wheel in chat and Ctrl +/-/0 drive the app zoom setting', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const chatView = window.document.getElementById('chatView');
  const tick = () => new Promise((resolve) => window.setTimeout(resolve, 0));

  // The chat's wheel-zoom listener exists only while Ctrl is held.
  window.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'Control' }));
  const wheelEvent = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120 });
  chatView.dispatchEvent(wheelEvent);
  await tick();
  assert.equal(wheelEvent.defaultPrevented, true);
  assert.equal(shell.__state.windowUiState.appZoomPercent, 125);

  window.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: '=' }));
  await tick();
  assert.equal(shell.__state.windowUiState.appZoomPercent, 150);

  window.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: '-' }));
  await tick();
  assert.equal(shell.__state.windowUiState.appZoomPercent, 125);

  window.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: '0' }));
  await tick();
  assert.equal(shell.__state.windowUiState.appZoomPercent, 110);
  assert.equal(window.document.documentElement.dataset.chatZoom, undefined, 'no chat zoom axis is written');

  // A shortcut an earlier handler already consumed (the plugin view's own
  // zoom) must not also move app zoom.
  const handled = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: '=' });
  handled.preventDefault();
  window.dispatchEvent(handled);
  await tick();
  assert.equal(shell.__state.windowUiState.appZoomPercent, 110);

  // Every shortcut step is a choice the Settings row can show.
  for (let step = 0; step < 3; step += 1) {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: '-' }));
    await tick();
  }
  assert.equal(shell.__state.windowUiState.appZoomPercent, 80);
  assert.equal(window.document.getElementById('appearanceAppZoomSelect').value, '80');
});

test('Text Size scales every surface through --font-scale and Overall App Zoom persists via windowUi', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const root = doc.documentElement;
  const fontScaleGroup = segmentedGroup(doc, 'appearanceFontScaleSelect');
  const appZoomSelect = doc.getElementById('appearanceAppZoomSelect');

  // --- Text size: discrete ladder, rebased Default, applies to the root ---
  assert.ok(fontScaleGroup, 'the Text size control exists');
  assert.deepEqual(
    segmentedOptions(doc, 'appearanceFontScaleSelect').map((option) => option.value),
    ['small', 'default', 'large']
  );
  assert.equal(segmentedValue(doc, 'appearanceFontScaleSelect'), 'default');
  assert.equal(root.dataset.fontScale, 'default');
  assert.equal(root.style.getPropertyValue('--font-scale'), '1.2');

  fontScaleGroup.querySelector('[data-value="large"]').click();
  await waitForUi(window, 30);

  assert.equal(root.dataset.fontScale, 'large');
  assert.equal(root.style.getPropertyValue('--font-scale'), '1.3');
  assert.equal(
    JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).fontScaleId,
    'large'
  );

  // --- Overall app zoom: discrete ladder, persists through jennyShell.windowUi ---
  assert.ok(appZoomSelect, 'Overall App Zoom select exists');
  assert.deepEqual(
    Array.from(appZoomSelect.options).map((option) => option.value),
    ['80', '90', '100', '110', '125', '150']
  );
  assert.equal(appZoomSelect.value, '110');

  appZoomSelect.value = '125';
  appZoomSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(shell.__state.windowUiState.appZoomPercent, 125);
  assert.equal(appZoomSelect.value, '125');
});

test('UIUX-028(c): a failed Overall App Zoom write rolls back rather than reporting an unapplied value', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      windowUi: {
        async updateSettings() {
          throw new Error('ipc boom');
        },
      },
    },
  });
  const doc = window.document;
  const appZoomSelect = doc.getElementById('appearanceAppZoomSelect');
  assert.equal(shell.__state.windowUiState.appZoomPercent, 110);

  appZoomSelect.value = '125';
  appZoomSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  // Main-process state was never touched (the write rejected) -- the
  // renderer must not go on claiming 125% was applied.
  assert.equal(shell.__state.windowUiState.appZoomPercent, 110);
  assert.equal(appZoomSelect.value, '110', 'the select rolls back instead of showing an unapplied value');
});

test('UIUX-028(c): an older Overall App Zoom write can never settle after a newer one (writes are serialized)', async (t) => {
  // NOTE: this asserts against the RENDERER's own observable state (the
  // select's displayed value) -- not shell.__state.windowUiState, whose mock
  // bookkeeping has no ordering guard of its own. The windowUi adapter's
  // coordinator sends the newer write only after the older one settles, so a
  // stale response cannot arrive last.
  const responders = new Map();
  const { window } = await loadRendererTestApp(t, {
    shell: {
      windowUi: {
        async updateSettings(patch) {
          const percent = Number(patch?.appZoomPercent);
          return new Promise((resolve) => {
            responders.set(percent, () => resolve({ appZoomPercent: percent }));
          });
        },
      },
    },
  });
  const doc = window.document;
  const appZoomSelect = doc.getElementById('appearanceAppZoomSelect');

  appZoomSelect.value = '125';
  appZoomSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 5);

  appZoomSelect.value = '150';
  appZoomSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 5);

  assert.deepEqual([...responders.keys()], [125], 'the newer write waits for the one in flight');
  assert.equal(appZoomSelect.value, '150', 'the queued value shows while it waits');

  responders.get(125)();
  await waitForUi(window, 30);
  assert.equal(appZoomSelect.value, '150', "the older 125% acknowledgement does not clobber the queued 150%");
  assert.ok(responders.has(150), 'the queued write goes out once the older one settles');

  responders.get(150)();
  await waitForUi(window, 30);
  assert.equal(appZoomSelect.value, '150');
});

test('a select zoom save that settles late does not undo a newer Ctrl +/- step', async (t) => {
  // Two writers share state.ui.appZoomPercent: the Settings select (windowUi
  // adapter) and the shortcuts. Answers arrive in request order.
  const pending = [];
  const { window } = await loadRendererTestApp(t, {
    shell: {
      windowUi: {
        async updateSettings(patch) {
          const percent = Number(patch?.appZoomPercent);
          return new Promise((resolve) => {
            pending.push({ percent, release: () => resolve({ appZoomPercent: percent }) });
          });
        },
      },
    },
  });
  const appZoomSelect = window.document.getElementById('appearanceAppZoomSelect');
  const shortcut = (key) => window.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key }));

  appZoomSelect.value = '125';
  appZoomSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 5);
  shortcut('=');
  await waitForUi(window, 5);
  assert.deepEqual(pending.map((entry) => entry.percent), [125, 150]);

  pending[0].release();
  await waitForUi(window, 30);
  assert.equal(window.__rendererState.ui.appZoomPercent, 150, 'the acknowledged 125% does not replace the newer shortcut step');

  shortcut('-');
  await waitForUi(window, 5);
  assert.deepEqual(pending.map((entry) => entry.percent), [125, 150, 125], 'the step down starts from 150%');
  pending[1].release();
  pending[2].release();
  await waitForUi(window, 30);
  assert.equal(window.__rendererState.ui.appZoomPercent, 125);
  assert.equal(appZoomSelect.value, '125');
});

test('UIUX-028(c): two overlapping App Zoom writes BOTH failing roll back to the true baseline, never a stranded intermediate', async (t) => {
  // Adversarial-audit finding on d49df22c: previousPercent is read from
  // state.ui.appZoomPercent AFTER the prior write already mutated it
  // optimistically, so the newer write's rollback target is the older
  // write's un-persisted value. With both writes failing (older failing
  // LAST), the generation guard suppressed the only rollback holding the
  // true baseline -- the select stranded on a value never persisted.
  const rejecters = new Map();
  const { window } = await loadRendererTestApp(t, {
    shell: {
      windowUi: {
        async updateSettings(patch) {
          const percent = Number(patch?.appZoomPercent);
          return new Promise((_resolve, reject) => {
            rejecters.set(percent, () => reject(new Error(`persist ${percent} failed`)));
          });
        },
      },
    },
  });
  const doc = window.document;
  const appZoomSelect = doc.getElementById('appearanceAppZoomSelect');
  assert.equal(appZoomSelect.value, '110', 'true persisted baseline');

  appZoomSelect.value = '125';
  appZoomSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 5);

  appZoomSelect.value = '150';
  appZoomSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 5);

  // The older (125) write fails first; the queued (150) write then goes out
  // from the acknowledged baseline and fails too.
  rejecters.get(125)();
  await waitForUi(window, 30);
  rejecters.get(150)();
  await waitForUi(window, 30);

  assert.equal(
    appZoomSelect.value,
    '110',
    'when every overlapping write fails, the select must return to the true persisted baseline (110%), '
      + 'never strand on the intermediate optimistic 125% that was never persisted'
  );
});

test('appearance card groups its controls into labelled scopes with accessible selects', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const card = doc.querySelector('section.settings-card[data-settings-section="appearance"]');

  // Five primary field groups are labelled regions (Theme, Typography,
  // Language, Chat layout, Background); Advanced is a collapsed fold that
  // also holds the app zoom, rather than another form region.
  const groups = card.querySelectorAll('.settings-group[role="group"]');
  assert.equal(groups.length, 5);
  assert.ok(doc.getElementById('appearanceLanguageField').closest('.settings-group').contains(doc.getElementById('appearanceLanguageHeading')), 'the Language heading sits in the group it names');
  assert.ok(card.querySelector('details.appearance-advanced #appearanceAppZoomSelect'), 'app zoom sits in the Advanced fold');
  const chatLayout = doc.getElementById('appearanceChatLayoutHeading').closest('.settings-group');
  assert.ok(segmentedGroup(chatLayout, 'transcriptViewDefaultSelect'), 'the transcript view is a Chat layout row');
  assert.ok(chatLayout.querySelector('[data-inv-toggle="appearanceArtifactAutoOpenToggle"]'), 'artifact auto-open is a Chat layout row');
  assert.equal(doc.getElementById('appearanceHoloList').querySelector('[data-inv-toggle="appearanceArtifactAutoOpenToggle"]'), null);
  for (const group of groups) {
    assert.equal(group.getAttribute('role'), 'group');
    const headingId = group.getAttribute('aria-labelledby');
    assert.ok(headingId && doc.getElementById(headingId), `group heading ${headingId} resolves`);
  }

  // Every appearance select is programmatically labelled, and the owner's
  // zoom id survived the regroup (id-stable wiring).
  const selectIds = [
    'appearanceThemeBundleSelect',
    'appearancePaletteSelect',
    'appearanceTypographySelect',
    'appearanceSurfaceEffectSelect',
    'appearanceAppZoomSelect',
  ];
  for (const id of selectIds) {
    assert.ok(card.querySelector(`#${id}`), `${id} still present`);
    assert.ok(card.querySelector(`label[for="${id}"]`), `${id} has a label[for]`);
    assert.ok(card.querySelector(`#${id}`).getAttribute('aria-label'), `${id} carries an accessible name`);
    assert.ok(card.querySelector(`[data-settings-field="${id}"] .settings-field-title`)?.textContent, `${id} row has a title`);
  }
  // Text size and Chat width (two to four choices) are named radio groups.
  for (const id of ['appearanceFontScaleSelect', 'appearanceChatWidthSelect']) {
    const group = segmentedGroup(card, id);
    assert.equal(group?.getAttribute('role'), 'radiogroup', `${id} is a radio group`);
    assert.ok(group.getAttribute('aria-label'), `${id} carries an accessible name`);
    assert.ok(card.querySelector(`[data-settings-field="${id}"] .settings-field-title`)?.textContent, `${id} row has a title`);
  }

  assert.equal(doc.getElementById('appearanceMotionSelect'), null);
  assert.equal(doc.getElementById('appearanceThreadStyleSelect'), null);
  assert.equal(doc.getElementById('appearanceChatZoomSelect'), null);
  assert.equal(doc.getElementById('chatZoomResetButton'), null);
  assert.equal(doc.getElementById('appearanceJsonSlice'), null);
  assert.equal(doc.getElementById('sessionSummary'), null);
  assert.equal(card.querySelector('details.appearance-advanced')?.open, false);
  assert.ok(doc.getElementById('appearanceResetButton').closest('details.settings-overflow'));
  assert.equal(doc.getElementById('appearanceResetButton').closest('.settings-group'), null);

  // The appearance status note announces politely (T9).
  assert.equal(doc.getElementById('appearanceStatus'), null);
});

// Chat width (Appearance > Chat layout). One control, localStorage-backed like
// every other appearance axis, applied pre-paint via theme-bootstrap.js.
test('chat width persists as a root data attribute and survives a theme-bundle switch', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const root = doc.documentElement;
  const widthGroup = segmentedGroup(doc, 'appearanceChatWidthSelect');

  assert.ok(widthGroup, 'the Chat width control is mounted in the Appearance card');
  assert.ok(widthGroup.closest('[data-setting-mount="appearanceChatWidthSelect"]'), 'inside its mount host');
  assert.deepEqual(
    segmentedOptions(doc, 'appearanceChatWidthSelect').map((option) => option.value),
    ['narrow', 'standard'],
    'exactly two modes are offered'
  );
  assert.equal(root.dataset.chatWidth, 'standard', 'Standard is the boot state (owner, 2026-10-02)');

  widthGroup.querySelector('[data-value="narrow"]').click();
  await waitForUi(window, 30);

  assert.equal(root.dataset.chatWidth, 'narrow', 'the axis lands on <html> for the CSS to key off');
  assert.equal(
    JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).chatWidthId,
    'narrow',
    'the choice is persisted for the next boot'
  );

  // Bundles document no chatWidthId axis; a bundle switch must not reset it
  // (same contract as UIUX-028(d) for font scale).
  const bundleSelect = doc.getElementById('appearanceThemeBundleSelect');
  bundleSelect.value = 'pewter';
  bundleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(root.dataset.palette, 'pewter', 'the bundle axes it does document still apply');
  assert.equal(root.dataset.chatWidth, 'narrow', 'a bundle switch must not reset Chat width');
  assert.equal(segmentedValue(doc, 'appearanceChatWidthSelect'), 'narrow');
});

test('choosing Narrow re-enables Reset Appearance rather than leaving it stranded as disabled', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const resetButton = doc.getElementById('appearanceResetButton');

  assert.equal(resetButton.disabled, true, 'a pristine profile has nothing to reset');

  segmentedGroup(doc, 'appearanceChatWidthSelect').querySelector('[data-value="narrow"]').click();
  await waitForUi(window, 30);

  // isDefaultAppearancePreferences enumerates axes explicitly; omitting
  // chatWidthId would leave Reset Appearance disabled with the setting changed.
  assert.equal(resetButton.disabled, false, 'Chat width counts as a non-default appearance');
});

test('the JS-mounted Chat width control keeps a stable node and carries the shared Revert', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const widthGroup = segmentedGroup(doc, 'appearanceChatWidthSelect');
  const narrow = widthGroup.querySelector('[data-value="narrow"]');

  // renderSettings() mounts this control rather than index.html, so a
  // re-render must patch the LIVE control rather than replacing it.
  narrow.click();
  await waitForUi(window, 30);

  assert.equal(segmentedGroup(doc, 'appearanceChatWidthSelect'), widthGroup, 're-rendering patches the live group in place');
  assert.equal(widthGroup.querySelector('[data-value="narrow"]'), narrow, 'and keeps its option nodes (keyboard focus survives)');
  assert.equal(segmentedValue(doc, 'appearanceChatWidthSelect'), 'narrow', 'the re-render preserves the chosen value');
  const revert = doc.querySelector('[data-setting-revert="appearanceChatWidthSelect"]');
  assert.ok(revert && !revert.hidden, 'a modified Chat width offers the shared Revert');

  revert.click();
  await waitForUi(window, 30);
  assert.equal(segmentedValue(doc, 'appearanceChatWidthSelect'), 'standard');
  assert.equal(doc.documentElement.dataset.chatWidth, 'standard');
  assert.equal(segmentedGroup(doc, 'appearanceChatWidthSelect'), widthGroup);
});
