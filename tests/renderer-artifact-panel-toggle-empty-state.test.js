'use strict';

// Artifact panel: always-functional split-view toggle + empty panel state.
//
// Owner report 2026-07-05: "not able to open the artifact panel" and "there is
// no empty artifact panel state, so the expand/collapse button is not
// functional all the time". Two structural defects, both invisible to the
// existing suites (none of which drive #artifactSplitViewToggle through the
// real boot path):
//
//   1. DEAD TOGGLE: the split-view toggle's click listener is attached inside
//      the artifact surface controller's bind(), which only runs when
//      ensureArtifactSurface() first builds. Every passive builder is gated on
//      the panel already being visible (or auto-open eligible), so in any
//      state where the panel never showed, the surface never builds and the
//      toggle is a dead button — the ONLY affordances that worked were the
//      per-card ⤢/Studio buttons.
//
//   2. NO EMPTY STATE: isArtifactReviewEligible() required artifacts > 0, so
//      enabling the panel in a session with no artifacts silently did nothing
//      (the V2 chrome hides the legacy status text, so there was zero
//      feedback). The V2 content already ships a "Select an artifact" empty
//      div; eligibility just never let it show.
//
// These tests boot the FULL shell on the real bootstrap path (default seed
// flags, async feature payload carrying the default-ON flags) and drive the
// real #artifactSplitViewToggle element.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function bootOptions(overrides = {}) {
  return {
    windowInnerWidth: 1600,
    windowInnerHeight: 900,
    persistedActiveView: 'chat',
    shell: {
      features: {
        state: {
          featureFlags: {
            artifact_panel_v2: true,
            workspace_artifact_panel: true,
          },
        },
      },
    },
    ...overrides,
  };
}

function getPanel(doc) {
  const panel = doc.getElementById('artifactReviewPanel');
  assert.ok(panel, 'expected #artifactReviewPanel to exist');
  return panel;
}

// jsdom has no layout: every getBoundingClientRect() is 0, which keeps the
// surface's getWorkspaceWidth() below the 1080px min-stage width forever. The
// real app always has workspace layout; give the workspace element a real
// rect so eligibility reflects the configured viewport.
function stubWorkspaceLayout(doc, width) {
  const workspaceEl = doc.getElementById('workspace');
  assert.ok(workspaceEl, 'expected #workspace to exist');
  workspaceEl.getBoundingClientRect = () => ({
    width,
    height: 900,
    top: 0,
    left: 0,
    right: width,
    bottom: 900,
    x: 0,
    y: 0,
  });
}

test('split-view toggle opens the panel (empty state) even when the surface was never built', async (t) => {
  const app = await loadRendererApp(bootOptions());
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  stubWorkspaceLayout(doc, 1600);
  await waitForUi(window, 25);
  // Eligibility requires an active session (as the live app always has in the
  // chat view) -- create one through the real new-chat button.
  doc.getElementById('newChatButton').click();
  await waitForUi(window, 15);

  const panel = getPanel(doc);
  assert.equal(panel.classList.contains('hidden'), true, 'panel starts hidden (prefs default off)');

  const toggle = doc.getElementById('artifactSplitViewToggle');
  assert.ok(toggle, 'expected #artifactSplitViewToggle to exist');
  toggle.click();
  await waitForUi(window, 10);

  assert.equal(
    panel.classList.contains('hidden'),
    false,
    'first toggle click must open the panel even though no artifact surface was ever built'
  );
  // The surface builds on demand with the default-on V3 chrome.
  assert.ok(panel.querySelector('.artifact-panel-header'), 'V3 chrome installed on demand');
  const emptyEl = doc.getElementById('artifactReviewDetailEmpty');
  assert.ok(emptyEl, 'artifact empty-state node exists');
  assert.equal(emptyEl.classList.contains('hidden'), false, 'empty state is visible with zero artifacts');
});

test('second toggle click closes the panel again (no double-binding double-toggle)', async (t) => {
  const app = await loadRendererApp(bootOptions());
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  stubWorkspaceLayout(doc, 1600);
  await waitForUi(window, 25);
  // Eligibility requires an active session (as the live app always has in the
  // chat view) -- create one through the real new-chat button.
  doc.getElementById('newChatButton').click();
  await waitForUi(window, 15);

  const panel = getPanel(doc);
  const toggle = doc.getElementById('artifactSplitViewToggle');
  toggle.click();
  await waitForUi(window, 10);
  assert.equal(panel.classList.contains('hidden'), false, 'open after first click');

  toggle.click();
  await waitForUi(window, 10);
  assert.equal(
    panel.classList.contains('hidden'),
    true,
    'closed after second click — a double-bound listener would toggle twice and leave it open'
  );

  toggle.click();
  await waitForUi(window, 10);
  assert.equal(panel.classList.contains('hidden'), false, 'third click re-opens');
});

test('persisted enabled prefs show the empty panel at boot with zero artifacts', async (t) => {
  const app = await loadRendererApp(bootOptions({
    artifactReviewPreferences: {
      enabled: true,
      collapsed: false,
      width: 460,
      userDismissed: false,
    },
  }));
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  stubWorkspaceLayout(doc, 1600);
  await waitForUi(window, 25);
  // Eligibility requires an active session (as the live app always has in the
  // chat view) -- create one through the real new-chat button.
  doc.getElementById('newChatButton').click();
  await waitForUi(window, 15);

  const panel = getPanel(doc);
  assert.equal(
    panel.classList.contains('hidden'),
    false,
    'panel enabled from a prior session must show (empty state) even before any artifact exists'
  );
  assert.ok(panel.querySelector('.artifact-panel-header'), 'V3 chrome installed');
});
