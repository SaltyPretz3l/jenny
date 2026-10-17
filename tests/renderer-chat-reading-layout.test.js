/* global document, window, getComputedStyle, requestAnimationFrame */
'use strict';

/* Row 59 checkpoint 1 (reading layout): the layout gate. The REAL stylesheets
 * (index.html) in headless Chromium, a realistic transcript in the chat pane(s)
 * and the real composer toolbar, every app script blocked (see
 * tests/helpers/chat-reading-layout-harness.js). jsdom cannot lay out CSS, so
 * these assertions are the contract for the reading measure:
 *
 *   1  the timeline measure is no wider than 68ch (Narrow) / 92ch (Standard) in
 *      the prose font, and follows its pane, not the viewport;
 *   2  the composer's edges are the measure's edges (1px), at every viewport;
 *   3  nothing scrolls horizontally except the code block / table that is
 *      oversized, and those never exceed the measure;
 *   4  the composer tools stay on one line;
 *   5  characters-per-line sanity at 1455 Standard and the 700px floor.
 *
 * Matrix: 1455x900 single pane, 2327x1300 split (two panes at the app's default
 * 50/50), 700x900 single; Default and Large text; Narrow and Standard width.
 *
 * The last test (side panel column motion) is the checkpoint 1 slice C gate: it
 * stays red until the panel opens by growing a column with a locked measure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SKIP, withBrowser, frames, FONT_SCALE_IDS, CHAT_WIDTH_IDS, mountReadingLayout, setReadingAppearance,
  measureReadingLayout, measureComposerToolbar, createCollector, checkToolbarOneLine, checkPaneReadingLayout, fmt,
} = require('./helpers/chat-reading-layout-harness');

const VIEWPORTS = [
  { name: '1455x900 single', viewport: { width: 1455, height: 900 }, split: false },
  { name: '2327x1300 split', viewport: { width: 2327, height: 1300 }, split: true },
  // 700px is a narrow window with the view panel collapsed (84px), the state the app is in when
  // the user collapses it or the window is <= 480px wide: the pane is then 616px and the
  // measure must hold >= 520px. The expanded 320px panel leaves a 380px pane; same assertions
  // minus the 520px floor.
  { name: '700x900 single', viewport: { width: 700, height: 900 }, split: false, sidebarCollapsed: true },
  { name: '700x900 single, sidebar expanded', viewport: { width: 700, height: 900 }, split: false, narrowFloor: false },
];

for (const { name, viewport, split, sidebarCollapsed = false, narrowFloor = true } of VIEWPORTS) {
  test(`reading layout ${name}: measure within cap, composer = measure, no horizontal scroll, one-line tools`, { skip: SKIP, timeout: 120000 }, async () => {
    const collector = createCollector();
    await withBrowser(async (browser) => {
      const page = await mountReadingLayout(browser, { viewport, split, sidebarCollapsed });
      if (split) {
        const state = await page.evaluate(() => ({
          count: document.getElementById('chatView').dataset.paneCount,
          panes: document.querySelectorAll('#chatView .chat-pane').length,
          resizerVisible: document.getElementById('chatPaneResizer').getClientRects().length > 0,
        }));
        assert.deepEqual(state, { count: '2', panes: 2, resizerVisible: true }, 'split view has two panes and a visible resizer');
      }
      for (const fontScale of FONT_SCALE_IDS) {
        for (const chatWidth of CHAT_WIDTH_IDS) {
          const label = `${name} / ${fontScale} text / ${chatWidth}`;
          await setReadingAppearance(page, { fontScale, chatWidth });
          const layout = await page.evaluate(measureReadingLayout);
          collector.ok(layout.page.scrollWidth <= layout.page.innerWidth, `${label}: no horizontal page scroll (scrollWidth ${layout.page.scrollWidth} > innerWidth ${layout.page.innerWidth})`);
          assert.equal(layout.panes.length, split ? 2 : 1, `${label}: pane count`);
          layout.panes.forEach((pane) => {
            checkPaneReadingLayout(collector, `${label} / pane ${pane.paneId}`, pane, { chatWidth, fontScale, viewportWidth: layout.viewport.width, single: !split, narrowFloor });
          });
          checkToolbarOneLine(collector, label, await page.evaluate(measureComposerToolbar));
        }
      }
      await page.close();
    });
    assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
  });
}

test('reading layout: Large text widens the character budget (the cap follows the prose font, not a px width)', { skip: SKIP, timeout: 120000 }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 2327, height: 1300 }, split: false });
    const measures = {};
    for (const fontScale of FONT_SCALE_IDS) {
      await setReadingAppearance(page, { fontScale, chatWidth: 'narrow' });
      const pane = (await page.evaluate(measureReadingLayout)).panes[0];
      measures[fontScale] = { width: pane.measure.width, chars: pane.measure.width / pane.ch, ch: pane.ch };
    }
    await page.close();
    assert.ok(measures.large.ch > measures.default.ch, `Large text has a wider ch (${fmt(measures.large.ch)} vs ${fmt(measures.default.ch)})`);
    assert.ok(Math.abs(measures.large.chars - measures.default.chars) <= 1,
      `the line keeps its character count when text grows (${fmt(measures.default.chars)}ch default, ${fmt(measures.large.chars)}ch large)`);
  });
});

/* The floating transcript utilities (the labelled Artifacts toggle) never sit
   over the text: the pane publishes their reach as --chat-utility-reserve
   (renderer-chat-pane-surface-controllers.js) and the one-pane gutter holds it. */
const ROOT = path.resolve(__dirname, '..');
const READING_FLOOR_PX = 320;
const injectModules = (page, files) => files.reduce((chain, file) => chain.then(() => page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, file), 'utf8') })), Promise.resolve());

test('reading layout: the floating utilities never cover the measure; the composer keeps its edges', { skip: SKIP, timeout: 180000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    for (const { name, viewport, sidebarCollapsed = false } of VIEWPORTS.filter((cell) => !cell.split)) {
      const page = await mountReadingLayout(browser, { viewport, split: false, sidebarCollapsed });
      await injectModules(page, ['renderer/chat/renderer-chat-pane-surface-controllers.js']);
      await page.evaluate(() => {
        document.getElementById('artifactSplitViewToggle').hidden = false;
        window.rendererChatPaneSurfaceControllers.observeUtilityReserve(document.getElementById('chatThreadStage'), document.getElementById('chatTimelineUtilityCluster'), window);
      });
      for (const fontScale of FONT_SCALE_IDS) {
        for (const chatWidth of CHAT_WIDTH_IDS) {
          const label = `${name} / ${fontScale} text / ${chatWidth} / utilities shown`;
          await setReadingAppearance(page, { fontScale, chatWidth });
          await frames(page, 3);
          const box = await page.evaluate(() => {
            const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
            return { cluster: rect(document.getElementById('chatTimelineUtilityCluster')), stage: rect(document.getElementById('chatThreadStage')), measure: rect(document.getElementById('chatTimeline')), composer: rect(document.querySelector('#chatPane0 .composer')) };
          });
          collector.ok(box.cluster.right > box.cluster.left, `${label}: the utility cluster is shown`);
          // Room for the utilities on both sides only while the measure keeps the 320px reading floor.
          const reach = box.stage.right - box.cluster.left;
          if (box.stage.width - 2 * reach >= READING_FLOOR_PX + 8) {
            collector.ok(box.measure.right <= box.cluster.left, `${label}: the measure end ${fmt(box.measure.right)} stays clear of the utilities at ${fmt(box.cluster.left)}`);
          } else {
            collector.ok(box.measure.width >= Math.min(READING_FLOOR_PX, box.stage.width - 2 * 40) - 1, `${label}: a pane too narrow to clear the utilities keeps its reading width (${fmt(box.measure.width)}px in a ${fmt(box.stage.width)}px pane)`);
          }
          collector.ok(Math.abs(box.composer.left - box.measure.left) <= 1 && Math.abs(box.composer.right - box.measure.right) <= 1,
            `${label}: composer [${fmt(box.composer.left)}, ${fmt(box.composer.right)}] keeps the measure's edges [${fmt(box.measure.left)}, ${fmt(box.measure.right)}]`);
        }
      }
      await page.close();
    }
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});

/* ── Side panel column motion (renderer-side-panel-motion.js) ───────────────
 * The driver opens and closes the artifact review panel through the real
 * motion module, with the real scroll coordinator supplying the reader anchor
 * (both injected; every other app script stays blocked). applyEnd is the end
 * state syncArtifactReviewLayout applies. The assertions read the page only
 * through document.getAnimations(): every running animation is paused and
 * seeked to 0, 25, 50, 75 and 100 % of its own duration.
 */
const PANEL_WIDTH_PX = 420;
const PROGRESS_STEPS = [0, 0.25, 0.5, 0.75, 1];

const panelDriver = {
  async install(page) {
    await injectModules(page, ['renderer/chat/chat-scroll-utils.js', 'renderer/chat/renderer-chat-scroll-coordinator.js', 'renderer/features/renderer-side-panel-motion.js']);
    await page.evaluate(() => {
      const coordinator = window.rendererChatScrollCoordinator.createChatScrollCoordinator({
        state: { ui: { followLatest: false } },
        followState: { get: () => false, set: () => {} },
        getSessionId: () => 'gate-session',
        scrollContainer: document.getElementById('chatThreadScroll'),
        timelineContainer: document.getElementById('chatTimeline'),
        window,
      });
      window.__panelMotion = window.rendererSidePanelMotion.createSidePanelMotion({ chatView: document.getElementById('chatView'), getCoordinators: () => [coordinator] });
    });
  },
  async open(page) {
    await page.evaluate((width) => {
      const view = document.getElementById('chatView');
      const panel = document.getElementById('artifactReviewPanel');
      window.__panelMotion.open({
        panel,
        applyEnd: () => {
          view.style.setProperty('--artifact-review-width', `${width}px`);
          panel.style.setProperty('width', `${width}px`);
          panel.classList.remove('hidden');
          document.getElementById('artifactReviewResizer').classList.remove('hidden');
          view.classList.add('artifact-review-mode', 'artifact-review-open');
        },
      });
    }, PANEL_WIDTH_PX);
  },
  async close(page) {
    await page.evaluate(() => {
      const view = document.getElementById('chatView');
      const panel = document.getElementById('artifactReviewPanel');
      window.__panelMotion.close({
        panel,
        deferEnd: true,
        applyEnd: () => {
          view.classList.remove('artifact-review-open', 'artifact-review-mode');
          panel.classList.add('hidden');
          document.getElementById('artifactReviewResizer').classList.add('hidden');
        },
      });
    });
  },
};

/* Pauses every finite animation/transition and reads the measure and the panel
   column at each progress step. Runs after a driver call, before any frame. */
function sampleMotion(steps) {
  const timeline = document.getElementById('chatTimeline');
  const panel = document.getElementById('artifactReviewPanel');
  const read = () => ({ measure: timeline.getBoundingClientRect().width, panel: panel.getBoundingClientRect().width });
  void document.body.offsetWidth;
  const animations = document.getAnimations().filter((anim) => {
    const timing = anim.effect && anim.effect.getComputedTiming();
    return timing && Number.isFinite(timing.endTime) && timing.endTime > 0;
  });
  animations.forEach((anim) => anim.pause());
  const samples = steps.map((progress) => {
    animations.forEach((anim) => { anim.currentTime = anim.effect.getComputedTiming().endTime * progress; });
    return { progress, ...read() };
  });
  return { animationCount: animations.length, samples };
}

/* The first row whose bottom edge is below the scroller top, and its offset. */
function readAnchor() {
  const scroll = document.getElementById('chatThreadScroll');
  const top = scroll.getBoundingClientRect().top;
  const rowEl = [...document.querySelectorAll('#chatTimeline .chat-row')].find((el) => el.getBoundingClientRect().bottom > top + 1);
  return { scrollTop: scroll.scrollTop, rowId: rowEl ? rowEl.dataset.rowId : null, rowOffset: rowEl ? rowEl.getBoundingClientRect().top - top : null };
}

async function settle(page) {
  await page.evaluate(() => { document.getAnimations().forEach((anim) => { try { anim.finish(); } catch (_e) { /* infinite animation */ } }); });
  await frames(page, 3);
}

test('side panel motion: the column grows over a locked measure; the reader does not move (slice C gate)', { skip: SKIP, timeout: 120000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await setReadingAppearance(page, { fontScale: 'default', chatWidth: 'standard' });
    await panelDriver.install(page);
    const measureNow = () => page.evaluate(() => document.getElementById('chatTimeline').getBoundingClientRect().width);
    // Park the reader mid-transcript so a reflow above the viewport would move it.
    await page.evaluate(() => {
      const scroll = document.getElementById('chatThreadScroll');
      scroll.scrollTop = Math.round((scroll.scrollHeight - scroll.clientHeight) * 0.4);
    });
    await frames(page, 2);
    const closedMeasure = await measureNow();
    const before = await page.evaluate(readAnchor);
    assert.ok(before.scrollTop > 0 && before.rowId, 'the reader is parked mid-transcript');

    // Open.
    await panelDriver.open(page);
    const opening = await page.evaluate(sampleMotion, PROGRESS_STEPS);
    await settle(page);
    const openMeasure = await measureNow();
    const afterOpen = await page.evaluate(readAnchor);
    collector.ok(openMeasure < closedMeasure - 20, `opening the ${PANEL_WIDTH_PX}px panel narrows the measure (${fmt(closedMeasure)} -> ${fmt(openMeasure)})`);
    collector.ok(opening.animationCount > 0, 'opening runs a motion (no animation or transition was found; the driver or slice C mechanism is not exercised)');
    opening.samples.forEach((sample) => {
      collector.ok(Math.abs(sample.measure - openMeasure) <= 0.5,
        `open ${sample.progress * 100}%: measure ${fmt(sample.measure)}px equals the final open measure ${fmt(openMeasure)}px (reflow once, not per frame)`);
    });
    collector.ok(opening.samples[0].panel < opening.samples[4].panel - 1,
      `open: the panel column grows from 0 (width ${fmt(opening.samples[0].panel)} at 0%, ${fmt(opening.samples[4].panel)} at 100%)`);
    // scrollTop may move on open: the narrower measure makes the rows above taller, and the anchor restore compensates.
    collector.ok(afterOpen.rowId === before.rowId && Math.abs(afterOpen.rowOffset - before.rowOffset) <= 1,
      `open: the first visible row keeps its offset (${before.rowId} ${fmt(before.rowOffset)} -> ${afterOpen.rowId} ${fmt(afterOpen.rowOffset)})`);

    // Close.
    await panelDriver.close(page);
    const closing = await page.evaluate(sampleMotion, PROGRESS_STEPS);
    await settle(page);
    const afterCloseMeasure = await measureNow();
    const afterClose = await page.evaluate(readAnchor);
    collector.ok(Math.abs(afterCloseMeasure - closedMeasure) <= 0.5, `close: the measure returns to ${fmt(closedMeasure)}px (${fmt(afterCloseMeasure)}px)`);
    collector.ok(closing.animationCount > 0, 'closing runs a motion (no animation or transition was found)');
    closing.samples.forEach((sample) => {
      collector.ok(Math.abs(sample.measure - openMeasure) <= 0.5,
        `close ${sample.progress * 100}%: measure ${fmt(sample.measure)}px stays at the open measure ${fmt(openMeasure)}px until the column has collapsed (reflow once, at the end)`);
    });
    collector.ok(closing.samples[0].panel > closing.samples[4].panel + 1,
      `close: the panel column collapses to 0 (width ${fmt(closing.samples[0].panel)} at 0%, ${fmt(closing.samples[4].panel)} at 100%)`);
    collector.ok(Math.abs(afterClose.scrollTop - before.scrollTop) <= 1, `close: scrollTop is unchanged (${before.scrollTop} -> ${afterClose.scrollTop})`);
    collector.ok(afterClose.rowId === before.rowId && Math.abs(afterClose.rowOffset - before.rowOffset) <= 1,
      `close: the first visible row keeps its offset (${before.rowId} ${fmt(before.rowOffset)} -> ${afterClose.rowId} ${fmt(afterClose.rowOffset)})`);
    await page.close();
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});
