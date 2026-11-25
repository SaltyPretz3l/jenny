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

/* The transcript utilities (the labelled Artifacts toggle) never sit over the text: they are the
   session bar above the stage (styles/chat-session-bar.css), and the gutter reserves nothing for them. */
const ROOT = path.resolve(__dirname, '..');
const READING_FLOOR_PX = 320;
const injectModules = (page, files) => files.reduce((chain, file) => chain.then(() => page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, file), 'utf8') })), Promise.resolve());

test('reading layout: the session bar never covers the measure; the composer keeps its edges', { skip: SKIP, timeout: 180000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    for (const { name, viewport, sidebarCollapsed = false } of VIEWPORTS.filter((cell) => !cell.split)) {
      const page = await mountReadingLayout(browser, { viewport, split: false, sidebarCollapsed });
      await page.evaluate(() => {
        document.getElementById('artifactSplitViewToggle').hidden = false;
      });
      for (const fontScale of FONT_SCALE_IDS) {
        for (const chatWidth of CHAT_WIDTH_IDS) {
          const label = `${name} / ${fontScale} text / ${chatWidth} / utilities shown`;
          await setReadingAppearance(page, { fontScale, chatWidth });
          await frames(page, 3);
          const box = await page.evaluate(() => {
            const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom }; };
            return { cluster: rect(document.getElementById('chatTimelineUtilityCluster')), stage: rect(document.getElementById('chatThreadStage')), measure: rect(document.getElementById('chatTimeline')), composer: rect(document.querySelector('#chatPane0 .composer')) };
          });
          collector.ok(box.cluster.right > box.cluster.left, `${label}: the utility cluster is shown`);
          collector.ok(box.cluster.bottom <= box.stage.top + 0.5, `${label}: the bar ends at ${fmt(box.cluster.bottom)}, above the stage at ${fmt(box.stage.top)}, so nothing covers the measure`);
          collector.ok(box.measure.width >= Math.min(READING_FLOOR_PX, box.stage.width - 2 * 40) - 1, `${label}: the measure keeps its reading width (${fmt(box.measure.width)}px in a ${fmt(box.stage.width)}px pane)`);
          collector.ok(Math.abs(box.composer.left - box.measure.left) <= 1 && Math.abs(box.composer.right - box.measure.right) <= 1,
            `${label}: composer [${fmt(box.composer.left)}, ${fmt(box.composer.right)}] keeps the measure's edges [${fmt(box.measure.left)}, ${fmt(box.measure.right)}]`);
        }
      }
      await page.close();
    }
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});

// A one-line tool row whose summary is a long command (labels clip at 500 chars since row 92): its
// toggle must shrink to the measure and ellipsize in every width, including after Wide -> Standard.
test('reading layout: a long command row stays inside the measure after Wide -> Standard -> Narrow', { skip: SKIP, timeout: 120000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await page.evaluate((command) => {
      const anchor = document.querySelector('#chatView .chat-row[data-row-kind="tool_run"]');
      const holder = document.createElement('div');
      holder.innerHTML = '<div class="chat-row" data-row-id="long-cmd" data-row-kind="tool"><span class="chat-row-node-dot" aria-hidden="true"></span>'
        + '<div class="tool-call-row tool-call-row--minimal" data-tool-status="error" data-expanded="false"><div class="tool-call-row-header">'
        + '<div class="tool-call-row-toggle" role="button" tabindex="0" data-tool-row-toggle="true">'
        + '<span class="status-dot status-dot--error" aria-hidden="true"></span><span class="tool-call-main">'
        + '<span class="tool-call-name">Bash</span><span class="tool-call-summary tool-call-row-summary"></span></span>'
        + '<span class="tool-call-status-cluster"><span class="tool-call-status-label">1 failed · 0 passed</span>'
        + ' <span class="tool-result-duration">682ms</span></span></div></div></div></div>';
      holder.querySelector('.tool-call-row-summary').textContent = command;
      anchor.after(holder.firstElementChild);
    }, `Run ${'node --test --test-concurrency=1 tests-js/ '.repeat(10)}`);
    for (const chatWidth of ['full', 'standard', 'narrow']) {
      await setReadingAppearance(page, { fontScale: 'default', chatWidth });
      const m = await page.evaluate(() => {
        const row = document.querySelector('[data-row-id="long-cmd"] .tool-call-row');
        const summary = row.querySelector('.tool-call-row-summary');
        return {
          row: row.getBoundingClientRect().width,
          toggle: row.querySelector('.tool-call-row-toggle').getBoundingClientRect().width,
          overflow: row.scrollWidth - row.clientWidth,
          clipped: summary.scrollWidth > summary.clientWidth,
        };
      });
      collector.ok(m.toggle <= m.row + 1, `${chatWidth}: toggle ${fmt(m.toggle)} within row ${fmt(m.row)}`);
      collector.ok(m.overflow <= 1, `${chatWidth}: row does not overflow (${fmt(m.overflow)}px)`);
      collector.ok(m.clipped, `${chatWidth}: the long summary ellipsizes`);
    }
    await page.close();
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});

// Split view: each pane's header row is the bar. With the three panel buttons hidden in split view (they move into More),
// both panes carry the same five controls, and the button cluster must stay inside its pane.
test('reading layout 2327x1300 split: the button cluster stays inside each pane; the first pane hides Artifacts, Tasks and Notes', { skip: SKIP, timeout: 120000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 2327, height: 1300 }, split: true });
    await page.evaluate(() => {
      const svg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10v10H3z"></path></svg>';
      const button = (className, inner = svg, attrs = '') => `<button type="button" class="chat-timeline-utility-button ${className}" ${attrs}>${inner}</button>`;
      // The worst case the bar meets: the longest branch name, three-digit counts, and the Session readout.
      const diff = button('session-bar-diff', `${svg}<span class="chat-timeline-utility-text session-bar-diff-text"><span class="session-bar-diff-branch">feature/a-very-long-branch-name</span><span class="session-bar-diff-counts"><span>+123</span><span>−456</span></span></span>`);
      const rail = button('session-rail-toggle session-rail-toggle--icon', `${svg}<span class="chat-timeline-utility-text">Session</span>`);
      const common = `${diff}${button('chat-find-toggle')}${rail}${button('chat-timeline-more-button')}`;
      document.querySelectorAll('#chatView > .chat-pane').forEach((pane) => {
        const cluster = pane.querySelector('.chat-timeline-utility-cluster');
        const three = pane.dataset.paneId === '0'
          ? `${button('', svg, 'id="chatTimelineTasksToggle"')}${button('', svg, 'id="chatTimelineNotesToggle"')}` : '';
        cluster.insertAdjacentHTML('beforeend', `${three}${common}`);
        cluster.querySelectorAll('[data-chat-node="artifactSplitViewToggle"]').forEach((node) => { node.hidden = false; });
      });
    });
    await frames(page, 3);
    const boxes = await page.evaluate(() => [...document.querySelectorAll('#chatView > .chat-pane')].map((pane) => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
      const cluster = pane.querySelector('.chat-timeline-utility-cluster');
      const three = [...cluster.querySelectorAll('[data-chat-node="artifactSplitViewToggle"], #chatTimelineTasksToggle, #chatTimelineNotesToggle')];
      return {
        id: pane.dataset.paneId,
        pane: rect(pane), cluster: rect(cluster),
        threeShown: three.filter((node) => getComputedStyle(node).display !== 'none').length,
      };
    }));
    for (const box of boxes) {
      collector.ok(box.threeShown === 0, `pane ${box.id}: Artifacts, Tasks and Notes are not on the bar in split view (${box.threeShown} shown)`);
      collector.ok(box.cluster.left >= box.pane.left, `pane ${box.id}: the buttons stay inside the pane (${fmt(box.cluster.left)} >= ${fmt(box.pane.left)})`);
    }
    await page.close();
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});
