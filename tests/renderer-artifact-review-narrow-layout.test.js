/* global document, window, getComputedStyle, KeyboardEvent */
'use strict';

/* G5 dogfooding (2026-09-29): with the artifact rail open the chat column
 * kept no floor, so a squished window with the Chats sidebar expanded left
 * the composer 85px wide and its buttons spilled out. The real stylesheet
 * (index.html + styles.css) laid out in headless Chromium with the real rail
 * (prefs + auto-open + rail modules) bound to the real #workspace / #viewPanel
 * / #chatView / #artifactReviewPanel nodes:
 *
 *   R1  a 1400px window with a 265px sidebar: the rail opened for Tasks and
 *       dragged to its End keeps the chat track at 320px; the streaming,
 *       collapsed composer keeps every control on one line inside the pane
 *       and the run-mode hint inside the composer wrap.
 *   R2  an 850px window: the rail is the overlay drawer (no shared column)
 *       and the composer keeps its full width.
 *   R3  no rail at all: a stale 1040px inline panel width under
 *       .artifact-review-open is bounded by the CSS guard alone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SKIP, withBrowser, mountComposer, measureButtons, assertOneCleanLine, isCompact } = require('./helpers/composer-layout-harness');
const { MIN_PANE_WIDTH_PX } = require('../renderer/chat/renderer-chat-pane-resizer');

const ROOT = path.resolve(__dirname, '..');
const RAIL_MODULES = [
  'renderer/features/renderer-artifact-review-prefs.js',
  'renderer/features/renderer-artifact-review-autoopen.js',
  'renderer/features/renderer-artifact-review-rail.js',
];
/* Two frames for the fit's verify pass, then the panel's slide-in (it
   starts 24px to the right) so boxes are measured at rest. */
const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
});

/* The harness mounts a two-pane view with an inline grid; this gate wants the
   real one-pane grid inside the real workspace, with the sidebar column set
   the way renderer-view-panel-registry.js writes it. */
async function mountShell(browser, { viewportWidth, sidebarWidth }) {
  const page = await mountComposer(browser, { paneWidth: 900, streaming: true, waitCompact: false, viewport: { width: viewportWidth, height: 900 } });
  await page.evaluate((sidebar) => {
    const view = document.getElementById('chatView');
    view.dataset.paneCount = '1';
    view.style.gridTemplateColumns = '';
    document.getElementById('chatPaneResizer').classList.add('hidden');
    document.getElementById('workspace').style.setProperty('--sidebar-current-width', `${sidebar}px`);
    document.getElementById('viewPanel').hidden = false;
    window.rendererComposerV2Render.syncComposerLoadingLine(document, 'Jenny is loading the model. You can type; Send turns on when it is ready.');
  }, sidebarWidth);
  return page;
}

async function bindRail(page) {
  for (const file of RAIL_MODULES) await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, file), 'utf8') });
  await page.evaluate(() => {
    const state = {
      currentSessionId: 's1',
      ui: { activeView: 'chat', artifactReview: {} },
      artifacts: { autoOpenedSessionIds: [], deletedArtifactIds: [] },
      messagesBySession: new Map(),
      features: { featureFlags: {} },
    };
    window.__rail = window.rendererArtifactReviewRail.createArtifactReviewRail({
      state,
      dom: {
        workspace: document.getElementById('workspace'),
        sidebar: document.getElementById('viewPanel'),
        chatView: document.getElementById('chatView'),
        artifactSplitViewToggle: document.getElementById('artifactSplitViewToggle'),
        artifactReviewResizer: document.getElementById('artifactReviewResizer'),
        artifactReviewPanel: document.getElementById('artifactReviewPanel'),
      },
      callbacks: {
        getActiveSession: () => ({ id: 's1' }),
        setActiveView() {}, updateComposerSafeOffset() {}, renderAll() {}, appendClientLog() {},
      },
    });
    window.__rail.bind();
  });
}

function readLayout(page) {
  return page.evaluate(() => {
    const view = document.getElementById('chatView');
    const panel = document.getElementById('artifactReviewPanel');
    const wrap = document.getElementById('composerWrap').getBoundingClientRect();
    // One pane is display: contents; the composer wrap is the chat column's box.
    const hint = document.getElementById('composerLoadingLine').getBoundingClientRect();
    const viewBox = view.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    return {
      tracks: getComputedStyle(view).gridTemplateColumns.split(' ').map((track) => Number.parseFloat(track)),
      wrap: wrap.width,
      stage: viewBox.width,
      open: view.classList.contains('artifact-review-open'),
      overlay: panel.classList.contains('artifact-review-overlay'),
      panelWidth: panelBox.width,
      panelInsideView: panelBox.left >= viewBox.left - 0.5 && panelBox.right <= viewBox.right + 0.5,
      hintInsideWrap: hint.width > 0 && hint.left >= wrap.left - 0.5 && hint.right <= wrap.right + 0.5,
      valuemax: document.getElementById('artifactReviewResizer').getAttribute('aria-valuemax'),
    };
  });
}

test('R1: rail at its End with a 265px sidebar keeps a 320px chat column and a clean streaming toolbar', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountShell(browser, { viewportWidth: 1400, sidebarWidth: 265 });
    await bindRail(page);
    await page.evaluate(() => {
      window.__rail.openArtifactRail('tasks');
      document.getElementById('artifactReviewResizer').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(isCompact, null, { timeout: 5000 });
    await settle(page);
    const layout = await readLayout(page);
    assert.equal(layout.open, true);
    assert.equal(layout.overlay, false);
    assert.equal(layout.stage, 1135, 'the stage is the workspace less the sidebar');
    assert.equal(layout.valuemax, '775', 'End lands on 90% of the stage less the 360px reserve');
    assert.equal(layout.panelWidth, 775);
    assert.ok(layout.tracks[0] >= MIN_PANE_WIDTH_PX, `the chat track keeps the composer floor (${layout.tracks.join(' ')})`);
    assert.ok(layout.wrap >= MIN_PANE_WIDTH_PX - 1, `the composer wrap is ${layout.wrap}px`);
    assertOneCleanLine(await measureButtons(page, '#composerWrap'), 'rail at End, streaming');
    assert.equal(layout.hintInsideWrap, true, 'the run-mode hint stays inside the composer wrap');
    await page.close();
  });
});

test('R2: an 850px window gets the overlay drawer and the composer keeps the whole stage', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountShell(browser, { viewportWidth: 850, sidebarWidth: 248 });
    await bindRail(page);
    await page.evaluate(() => window.__rail.openArtifactRail('tasks'));
    await page.waitForFunction(isCompact, null, { timeout: 5000 });
    await settle(page);
    const layout = await readLayout(page);
    assert.equal(layout.overlay, true);
    assert.equal(layout.open, false, 'an overlay never claims a grid column');
    assert.equal(layout.stage, 602);
    assert.ok(layout.tracks[0] >= layout.stage - 1, `the chat track keeps the stage (${layout.tracks.join(' ')} of ${layout.stage})`);
    assertOneCleanLine(await measureButtons(page, '#composerWrap'), 'overlay drawer, streaming');
    assert.equal(layout.hintInsideWrap, true);
    await page.close();
  });
});

test('R3: the CSS guard alone bounds a stale inline panel width', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountShell(browser, { viewportWidth: 1400, sidebarWidth: 265 });
    await page.evaluate(() => {
      const panel = document.getElementById('artifactReviewPanel');
      panel.classList.remove('hidden');
      panel.style.width = '1040px';
      document.getElementById('workspace').style.setProperty('--artifact-review-width', '1040px');
      document.getElementById('chatView').classList.add('artifact-review-open');
    });
    await page.waitForFunction(isCompact, null, { timeout: 5000 });
    await settle(page);
    const layout = await readLayout(page);
    assert.equal(layout.open, true);
    assert.ok(layout.tracks[0] >= MIN_PANE_WIDTH_PX, `the chat track keeps the floor (${layout.tracks.join(' ')})`);
    assert.equal(layout.panelWidth, 1135 - 10 - 320, 'the panel is capped at stage - resizer - 320');
    assert.equal(layout.panelInsideView, true, 'the capped panel is not clipped by the view');
    assertOneCleanLine(await measureButtons(page, '#composerWrap'), 'stale 1040px width, streaming');
    await page.close();
  });
});
