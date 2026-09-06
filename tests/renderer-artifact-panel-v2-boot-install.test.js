'use strict';

// Artifact Panel V2 boot-install regression (artifact_panel_v2, default-ON).
//
// Reproduces the owner's 2026-07-02 report: with the flag default-ON the LIVE
// app still rendered the LEGACY artifact review surface. Root cause is a
// feature-flag hydration race, not the V2 renderer itself:
//
//   * The V2 chrome is installed by a ONE-SHOT ensurePanelV2() the first time
//     ensureArtifactSurface() builds the surface controller. installed() gates
//     on state.features.featureFlags.artifact_panel_v2 === true.
//   * The renderer boot seed (renderer-bootstrap-utils.js) does NOT carry the
//     artifact_panel_v2 key, so it is `undefined` until the async feature
//     payload lands via refreshFeatureState() partway through boot.
//   * A user who had the review panel enabled (persisted localStorage prefs)
//     makes isArtifactReviewVisible() true at the FIRST bootstrap renderAll(),
//     which runs BEFORE hydration. The surface builds against the static
//     (legacy) shell, installed() sees the flag undefined -> false, and the
//     controller is cached forever. Nothing re-installs V2 after hydration.
//
// The existing V2 coverage constructs createArtifactPanelV2() with the flag
// already true, so it is vacuous with respect to this boot ordering. This test
// boots the FULL shell on the real bootstrap path with default flags and the
// panel visible at cold boot, and asserts the V2 chrome wins.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

// Boot options that recreate the owner's environment: review panel enabled from
// a prior session (persisted prefs) + a wide viewport so the panel clears the
// 1080px min-stage width at the FIRST render, and artifact_panel_v2 default-ON
// on the backend feature payload (the renderer seed still omits it).
function bootOptions() {
  return {
    windowInnerWidth: 1600,
    windowInnerHeight: 900,
    persistedActiveView: 'chat',
    artifactReviewPreferences: {
      enabled: true,
      collapsed: false,
      width: 460,
      userDismissed: false,
    },
    // Backend feature payload (returned by the harness features.getState stub):
    // artifact_panel_v2 default-ON, exactly as the live buildEffectiveFeatureFlags
    // reports it. The renderer boot seed still omits the key, so it stays
    // undefined until this payload hydrates partway through boot.
    shell: {
      features: {
        state: {
          featureFlags: {
            artifact_panel_v2: true,
          },
        },
      },
    },
  };
}

test('boots the Artifact Panel V3 chrome (not legacy) with the flag default-ON and the panel visible at cold boot', async (t) => {
  const app = await loadRendererApp(bootOptions());
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;

  // Let any post-hydration render settle.
  await waitForUi(window, 25);

  const panel = doc.getElementById('artifactReviewPanel');
  assert.ok(panel, 'expected #artifactReviewPanel to exist');

  // V3 keeps the V2 compatibility marker while stamping `.artifact-panel-v3`
  // and laying out the Canvas header + status line. Legacy tells: the "Artifact Review"
  // kicker and the always-visible meta/provenance <section> chrome.
  const hasV2Class = panel.classList.contains('artifact-panel-v2');
  const hasV3Class = panel.classList.contains('artifact-panel-v3');
  const hasV3Header = Boolean(panel.querySelector('.artifact-panel-header'));
  const hasV3Status = Boolean(panel.querySelector('.artifact-panel-status'));
  const hasLegacyKicker = Boolean(panel.querySelector('.artifact-review-kicker'));
  const hasLegacyMetaSection = Boolean(panel.querySelector('.artifact-review-meta-section'));

  assert.equal(
    hasLegacyKicker,
    false,
    'legacy "Artifact Review" kicker must not be present when artifact_panel_v2 is on'
  );
  assert.equal(
    hasLegacyMetaSection,
    false,
    'legacy always-visible meta/provenance sections must not be present under V2'
  );
  assert.equal(hasV2Class, true, 'panel must carry the .artifact-panel-v2 marker class');
  assert.equal(hasV3Class, true, 'panel must carry the .artifact-panel-v3 marker class');
  assert.equal(hasV3Header, true, 'V3 Canvas header must be installed');
  assert.equal(hasV3Status, true, 'V3 status line must be installed');
});

// Same-root-cause regression for the code-review rail. ensureCodeReviewRail()
// used to pass the undefined eager `artifactReviewPanel` dep to the rail
// factory, so rail.bind() early-returned on !artifactReviewPanel and its
// click/keydown listeners never attached on the real boot path -- the rail was
// dead-on-arrival (its logic is unit-tested, but the boot wiring was masked
// because that unit test constructs the rail with a real element). The fix
// resolves the container via getElementById for the rail too. Probe: inject a
// [data-jenny-code-review-close] target into the real #artifactReviewPanel and
// dispatch a cancelable click; handleRailClick calls preventDefault() on it
// (no mode guard), so defaultPrevented is true iff the listener is attached.
test('wires the code-review rail click listener to #artifactReviewPanel on the real boot path', async (t) => {
  const app = await loadRendererApp(bootOptions());
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;

  // Let the post-hydration renderAll() build the artifact surface, which builds
  // and binds the code-review rail (ensureCodeReviewRail runs inside
  // ensureArtifactSurface).
  await waitForUi(window, 25);

  const panel = doc.getElementById('artifactReviewPanel');
  assert.ok(panel, 'expected #artifactReviewPanel to exist');

  // Minimal close affordance the rail's delegated click handler recognizes.
  const closeBtn = doc.createElement('button');
  closeBtn.setAttribute('data-jenny-code-review-close', '');
  panel.appendChild(closeBtn);

  const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  closeBtn.dispatchEvent(clickEvent);

  assert.equal(
    clickEvent.defaultPrevented,
    true,
    'code-review rail click listener must be attached to #artifactReviewPanel (bind() must not early-return on an undefined dep)'
  );
});
