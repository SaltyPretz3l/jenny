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
      // Retired preset id: must normalize back to 'default' rather than carry
      // a broken/unknown id onto the root dataset.
      timelineStyleId: 'explorer-minimal',
    },
  });
  const root = window.document.documentElement;

  assert.equal(root.dataset.palette, 'paper');
  assert.equal(root.dataset.typography, 'editorial');
  assert.equal(root.dataset.motion, 'standard');
  assert.equal(root.dataset.composerHolo, 'on');
  assert.equal(root.dataset.spriteHolo, 'off');
  assert.equal(root.dataset.threadStyle, 'subtle');
  assert.equal(root.dataset.timelineStyle, 'default');
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

test('settings shell renders the redesigned masthead and live appearance proof surface', async (t) => {
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

  assert.ok(masthead, 'masthead should render in the settings content header');
  assert.match(mastheadTitle?.textContent || '', /shell settings/i);
  assert.ok(chipRow, 'overview chip row should render');
  assert.match(chipRow.textContent, /local-first/i);
  assert.match(chipRow.textContent, /session-aware/i);
  assert.match(chipRow.textContent, /file-backed/i);
  assert.ok(appearanceProof);
  assert.match(appearanceProof.textContent, /Chrome/);
  assert.match(appearanceProof.textContent, /Signals/);
  assert.equal(appearanceProof.querySelector('.settings-appearance-stage'), null);
  assert.equal(window.document.documentElement.dataset.palette, 'signal');
});

test('appearance controls update shell appearance without persisting session runtime preferences', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const paletteSelect = window.document.getElementById('appearancePaletteSelect');
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

  assert.equal(root.dataset.palette, 'signal');
  assert.equal(root.dataset.typography, 'technical');
  assert.equal(root.dataset.motion, 'standard');
  assert.equal(root.dataset.composerHolo, 'off');
  assert.equal(root.dataset.spriteHolo, 'off');
  assert.equal(root.dataset.threadStyle, 'subtle');
  assert.equal(root.dataset.timelineStyle, 'default');
  assert.deepEqual(shell.__state.setPreferenceCalls, []);
  assert.deepEqual(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')), {
    paletteId: 'signal',
    typographyId: 'technical',
    surfaceEffectId: 'none',
    composerHoloId: 'off',
    timelineStyleId: 'default',
    fontScaleId: 'xlarge',
    chatWidthId: 'default',
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
  assert.equal(root.dataset.spriteHolo, 'off');
  assert.equal(root.dataset.threadStyle, 'subtle');
  assert.equal(chatView.hasAttribute('data-widget-modifier'), false);
  assert.equal(appearanceBadge.textContent, 'Lexicon');
  assert.match(appearanceStatus.textContent, /Lexicon bundle/i);
  assert.equal(
    Array.from(surfaceEffectSelect.options).some((option) => option.value === 'pretext-drift'),
    false
  );
  assert.deepEqual(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')), {
    paletteId: 'lexicon',
    typographyId: 'editorial',
    surfaceEffectId: 'none',
    composerHoloId: 'on',
    timelineStyleId: 'default',
    // Bundles carry no font-scale axis; the fresh-install Extra Large default
    // (owner review 2026-08-19) survives a bundle apply.
    fontScaleId: 'xlarge',
    chatWidthId: 'default',
  });

  paletteSelect.value = 'signal';
  paletteSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(bundleSelect.value, 'custom');
  assert.equal(appearanceBadge.textContent, 'Custom');
});

test('Slate theme bundle keeps the flat background while restoring composer and sprite holo', async (t) => {
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
  assert.equal(root.dataset.spriteHolo, 'on');
  assert.equal(chatView.hasAttribute('data-widget-modifier'), false);
  assert.deepEqual(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')), {
    paletteId: 'slate',
    typographyId: 'system',
    surfaceEffectId: 'none',
    composerHoloId: 'on',
    timelineStyleId: 'default',
    fontScaleId: 'xlarge',
    chatWidthId: 'default',
  });
});

test('UIUX-028(d): switching theme bundles preserves Extra Large text size and timeline style instead of silently resetting them', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const root = doc.documentElement;
  const bundleSelect = doc.getElementById('appearanceThemeBundleSelect');
  const fontScaleSelect = doc.getElementById('appearanceFontScaleSelect');

  // User sets Extra Large text (an accessibility preference, not a "look").
  fontScaleSelect.value = 'xlarge';
  fontScaleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);
  assert.equal(root.dataset.fontScale, 'xlarge');

  // Switching to a theme bundle (Pewter documents no fontScaleId/timelineStyleId
  // axis at all) must not silently reset the text size back to Default.
  bundleSelect.value = 'pewter';
  bundleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(root.dataset.palette, 'pewter', 'the bundle axes it DOES document still apply');
  assert.equal(root.dataset.fontScale, 'xlarge', 'a bundle switch must not reset Extra Large text to Default');
  assert.equal(fontScaleSelect.value, 'xlarge');
  assert.equal(
    JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).fontScaleId,
    'xlarge',
    'the persisted preferences must also keep the font scale'
  );

  // Switching bundles again (Obsidian) must still preserve it.
  bundleSelect.value = 'obsidian';
  bundleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);
  assert.equal(root.dataset.fontScale, 'xlarge', 'a second bundle switch still preserves the font scale');
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
  assert.equal(root.dataset.fontScale, 'xlarge');
  assert.equal(root.dataset.motion, 'standard');
  assert.equal(root.dataset.composerHolo, 'on');
  // Sprite holo is palette-derived and resolves ON for slate (same contract
  // the Slate-bundle test pins above).
  assert.equal(root.dataset.spriteHolo, 'on');
  assert.equal(root.dataset.threadStyle, 'subtle');
});

test('appearance status reports the OS reduced-motion override and fixed standard runtime motion', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    reducedMotion: true,
    appearance: {
      paletteId: 'midnight',
      typographyId: 'system',
      motionId: 'expressive',
    },
  });
  const appearanceStatus = window.document.getElementById('appearanceStatus');

  assert.match(appearanceStatus.textContent, /OS reduced motion is active/i);
  assert.match(appearanceStatus.textContent, /Composer typing border/i);
  assert.doesNotMatch(appearanceStatus.textContent, /sprite holo|chat threads/i);
  assert.equal(window.document.documentElement.dataset.motion, 'standard');
});

test('renderer shell applies persisted chat zoom on boot and exposes the contextual Composer control', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      chatUi: {
        state: {
          zoomPercent: 115,
        },
      },
    },
  });

  const root = window.document.documentElement;
  window.document.getElementById('composerSettingsButton').click();
  await waitForUi(window, 20);
  const zoomSelect = window.document.getElementById('composerChatZoomSelect');

  assert.equal(root.dataset.chatZoom, '115');
  assert.equal(root.style.getPropertyValue('--chat-zoom-percent'), '115');
  assert.equal(root.style.getPropertyValue('--chat-zoom-factor'), '1.15');
  assert.equal(zoomSelect.value, '115');
  assert.match(window.document.getElementById('composerChatZoomStatus').textContent, /Ctrl \+ wheel adjusts/i);
});

test('chat zoom controls and shortcuts update the global shell setting', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    chatUi: {
      state: {
        zoomPercent: 100,
      },
    },
  });

  const root = window.document.documentElement;
  const chatView = window.document.getElementById('chatView');
  window.document.getElementById('composerSettingsButton').click();
  await waitForUi(window, 20);
  const zoomSelect = window.document.getElementById('composerChatZoomSelect');

  zoomSelect.value = '125';
  zoomSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  assert.equal(root.dataset.chatZoom, '125');
  assert.equal(shell.__state.chatUiState.zoomPercent, 125);

  const wheelEvent = new window.WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    deltaY: -120,
  });
  chatView.dispatchEvent(wheelEvent);
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  assert.equal(wheelEvent.defaultPrevented, true);
  assert.equal(root.dataset.chatZoom, '130');
  assert.equal(shell.__state.chatUiState.zoomPercent, 130);

  const resetEvent = new window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: '0',
  });
  window.dispatchEvent(resetEvent);
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  assert.equal(root.dataset.chatZoom, '100');
  assert.equal(shell.__state.chatUiState.zoomPercent, 100);
});


test('Text Size scales shell typography (isolated from chat) and Overall App Zoom persists via windowUi', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const root = doc.documentElement;
  const fontScaleSelect = doc.getElementById('appearanceFontScaleSelect');
  const appZoomSelect = doc.getElementById('appearanceAppZoomSelect');

  // --- Font scale: discrete ladder, default, applies to the shell root ---
  assert.ok(fontScaleSelect, 'Text Size select exists');
  assert.deepEqual(
    Array.from(fontScaleSelect.options).map((option) => option.value),
    ['small', 'default', 'large', 'xlarge']
  );
  assert.equal(fontScaleSelect.value, 'xlarge');
  assert.equal(root.dataset.fontScale, 'xlarge');
  assert.equal(root.style.getPropertyValue('--font-scale'), '1.3');

  fontScaleSelect.value = 'large';
  fontScaleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(root.dataset.fontScale, 'large');
  assert.equal(root.style.getPropertyValue('--font-scale'), '1.15');
  assert.equal(
    JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).fontScaleId,
    'large'
  );
  // Font scale must NOT bleed into the chat zoom axis.
  assert.equal(root.dataset.chatZoom, '100');

  // --- Overall app zoom: discrete ladder, persists through jennyShell.windowUi ---
  assert.ok(appZoomSelect, 'Overall App Zoom select exists');
  assert.deepEqual(
    Array.from(appZoomSelect.options).map((option) => option.value),
    ['90', '100', '110', '125', '150']
  );
  assert.equal(appZoomSelect.value, '100');

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
  assert.equal(shell.__state.windowUiState.appZoomPercent, 100);

  appZoomSelect.value = '125';
  appZoomSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  // Main-process state was never touched (the write rejected) -- the
  // renderer must not go on claiming 125% was applied.
  assert.equal(shell.__state.windowUiState.appZoomPercent, 100);
  assert.equal(appZoomSelect.value, '100', 'the select rolls back instead of showing an unapplied value');
});

test('UIUX-028(c): an older Overall App Zoom write settling after a newer one does not clobber it (out of order)', async (t) => {
  // NOTE: this asserts against the RENDERER's own observable state (the
  // select's displayed value, which renderSettings() repaints from
  // state.ui.appZoomPercent) -- not shell.__state.windowUiState. The harness
  // mock's windowUiState is a dumb "whichever IPC call resolves last wins"
  // bookkeeping with no ordering guard of its own (that's not production
  // code this fix touches); the generation guard under test lives entirely
  // in the renderer's change handler and is only observable via what it
  // renders.
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

  // The newer (150) write's persist call wins the race and resolves first.
  responders.get(150)();
  await waitForUi(window, 30);
  assert.equal(appZoomSelect.value, '150');

  // The OLDER (125) write's persist call resolves after -- must not
  // reconcile the UI back to 125.
  responders.get(125)();
  await waitForUi(window, 30);

  assert.equal(appZoomSelect.value, '150', "a stale 125% response must not clobber the newer 150% result");
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
  assert.equal(appZoomSelect.value, '100', 'true persisted baseline');

  appZoomSelect.value = '125';
  appZoomSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 5);

  appZoomSelect.value = '150';
  appZoomSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 5);

  // The newer (150) write fails FIRST...
  rejecters.get(150)();
  await waitForUi(window, 30);
  // ...then the older (125) write fails LAST.
  rejecters.get(125)();
  await waitForUi(window, 30);

  assert.equal(
    appZoomSelect.value,
    '100',
    'when every overlapping write fails, the select must return to the true persisted baseline (100%), '
      + 'never strand on the intermediate optimistic 125% that was never persisted'
  );
});

test('appearance card groups its controls into labelled scopes with accessible selects', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const card = doc.querySelector('section.settings-card[data-settings-section="appearance"]');

  // Five primary field groups remain labelled regions (Theme, Typography,
  // Chat layout, Background, Display scale); Advanced is a collapsed
  // disclosure rather than another form region.
  const groups = card.querySelectorAll('.settings-group[role="group"]');
  assert.equal(groups.length, 5);
  for (const group of groups) {
    assert.equal(group.getAttribute('role'), 'group');
    const headingId = group.getAttribute('aria-labelledby');
    assert.ok(headingId && doc.getElementById(headingId), `group heading ${headingId} resolves`);
  }

  // Every appearance select is programmatically labelled, and the owner's
  // font-scale / zoom ids survived the regroup (id-stable wiring).
  const selectIds = [
    'appearanceThemeBundleSelect',
    'appearancePaletteSelect',
    'appearanceTypographySelect',
    'appearanceFontScaleSelect',
    'appearanceChatWidthSelect',
    'appearanceSurfaceEffectSelect',
    'appearanceAppZoomSelect',
  ];
  for (const id of selectIds) {
    assert.ok(card.querySelector(`#${id}`), `${id} still present`);
    assert.ok(card.querySelector(`label.settings-field-label[for="${id}"]`), `${id} has a label[for]`);
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
  assert.equal(doc.getElementById('appearanceStatus').getAttribute('aria-live'), 'polite');
});

// Chat width (Appearance > Chat layout). One control, localStorage-backed like
// every other appearance axis, applied pre-paint via theme-bootstrap.js.
test('chat width persists as a root data attribute and survives a theme-bundle switch', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const root = doc.documentElement;
  const widthSelect = doc.getElementById('appearanceChatWidthSelect');

  assert.ok(widthSelect, 'the Chat width select is mounted in the Appearance card');
  // The control comes from the inventory selectField primitive (index.html's
  // raw-primitive budget only moves down), so it must carry select-shell to
  // pick up the exact styling its sibling select rows already use.
  assert.ok(
    widthSelect.closest('label.select-shell'),
    'the mounted control inherits the card select-shell grammar -- no new CSS needed'
  );
  assert.equal(
    widthSelect.closest('label.select-shell').getAttribute('for'),
    'appearanceChatWidthSelect',
    'the wrapper label is associated with the select'
  );
  assert.deepEqual(
    [...widthSelect.options].map((option) => option.value),
    ['default', 'wide'],
    'exactly two modes are offered'
  );
  assert.equal(root.dataset.chatWidth, 'default', 'Default is the boot state');

  widthSelect.value = 'wide';
  widthSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(root.dataset.chatWidth, 'wide', 'the axis lands on <html> for the CSS to key off');
  assert.equal(
    JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).chatWidthId,
    'wide',
    'the choice is persisted for the next boot'
  );

  // Bundles document no chatWidthId axis; a bundle switch must not reset it
  // (same contract as UIUX-028(d) for font scale).
  const bundleSelect = doc.getElementById('appearanceThemeBundleSelect');
  bundleSelect.value = 'pewter';
  bundleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(root.dataset.palette, 'pewter', 'the bundle axes it does document still apply');
  assert.equal(root.dataset.chatWidth, 'wide', 'a bundle switch must not reset Chat width');
  assert.equal(widthSelect.value, 'wide');
});

test('choosing Wide re-enables Reset Appearance rather than leaving it stranded as disabled', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const widthSelect = doc.getElementById('appearanceChatWidthSelect');
  const resetButton = doc.getElementById('appearanceResetButton');

  assert.equal(resetButton.disabled, true, 'a pristine profile has nothing to reset');

  widthSelect.value = 'wide';
  widthSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  // isDefaultAppearancePreferences enumerates axes explicitly; omitting
  // chatWidthId would leave Reset Appearance disabled with the setting changed.
  assert.equal(resetButton.disabled, false, 'Chat width counts as a non-default appearance');
});

test('the JS-mounted Chat width select keeps a stable node and still gets a per-field reset button', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const widthSelect = doc.getElementById('appearanceChatWidthSelect');

  // Because renderSettings() mounts this control rather than index.html, two
  // things could silently break: the per-field reset button binds to a node
  // that must already exist when fieldReset.mount() runs, and a re-render must
  // repopulate the LIVE select rather than replacing it (a replaced node would
  // orphan that button's listener).
  widthSelect.value = 'wide';
  widthSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);

  assert.equal(
    doc.getElementById('appearanceChatWidthSelect'),
    widthSelect,
    're-rendering repopulates the live select in place instead of replacing the node'
  );
  assert.ok(
    doc.querySelector('[data-action="appearanceChatWidthSelectReset"]'),
    'the per-field reset button found the mounted select'
  );
  assert.equal(widthSelect.value, 'wide', 'the re-render preserves the chosen value');
});
