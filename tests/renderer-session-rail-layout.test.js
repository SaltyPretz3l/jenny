/* global document, window, getComputedStyle */
'use strict';

/* Row 59 checkpoint 2, slice S3: the session rail's layout gate. The REAL stylesheets (index.html
 * plus styles/chat-session-rail.css) and the real rail modules in headless Chromium, on the
 * reading-layout harness (every app script blocked; the rail modules and a fake chatWorkspace
 * bridge injected). jsdom cannot lay out CSS, so this is the contract for the placement:
 *
 *   1455 single        docked: a 280px rail at the pane's end edge, the stage and the composer
 *                      give it room together (composer edges = the timeline measure), the session bar
 *                      (the utility cluster with the Session toggle) spans the pane above the stage and
 *                      the rail's tray starts below it
 *   ~2327 split        both panes docked, each its own facts, neither overlapping the other
 *   700                undocked: no rail, a Session toggle, a sheet anchored inside the pane
 *   1455 + side panel  the rail stays docked and the pane keeps >= 360px of reading
 *   Default / Large    text, Narrow / Standard width, in every layout above
 *
 * Every cell also asserts: no horizontal page or scroller overflow, header values never clipped.
 * Set SESSION_RAIL_LAYOUT_REPORT=<file> to append the measured numbers as JSON lines. */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SKIP, withBrowser, frames, FONT_SCALE_IDS, CHAT_WIDTH_IDS, mountReadingLayout, setReadingAppearance, createCollector, fmt,
} = require('./helpers/chat-reading-layout-harness');
const {
  RESERVE_PX, READING_FLOOR_PX, installRails, toggleRail, openPanel, measureRails, writeReport, checkCommon, checkDocked,
} = require('./helpers/session-rail-layout');

const CELLS = [
  { name: '1455x900 single', viewport: { width: 1455, height: 900 }, split: false, expect: ['docked'] },
  { name: '1455x900 single, no Artifacts toggle', viewport: { width: 1455, height: 900 }, split: false, artifactsToggle: false, expect: ['docked'] },
  { name: '2327x1300 split', viewport: { width: 2327, height: 1300 }, split: true, expect: ['docked', 'docked'] },
  { name: '700x900 single (sidebar collapsed)', viewport: { width: 700, height: 900 }, split: false, sidebarCollapsed: true, expect: ['undocked'] },
  { name: '700x900 single (sidebar expanded)', viewport: { width: 700, height: 900 }, split: false, expect: ['undocked'] },
  { name: '1455x900 single, artifact panel open', viewport: { width: 1455, height: 900 }, split: false, panel: true, expect: ['docked'] },
];
for (const cell of CELLS) {
  test(`session rail layout ${cell.name}: placement, composer = measure, no horizontal scroll`, { skip: SKIP, timeout: 180000 }, async () => {
    const collector = createCollector();
    await withBrowser(async (browser) => {
      const page = await mountReadingLayout(browser, { viewport: cell.viewport, split: cell.split, sidebarCollapsed: cell.sidebarCollapsed === true });
      await installRails(page, { artifactsToggle: cell.artifactsToggle !== false });
      if (cell.panel) await openPanel(page);
      for (const fontScale of FONT_SCALE_IDS) {
        for (const chatWidth of CHAT_WIDTH_IDS) {
          const label = `${cell.name} / ${fontScale} text / ${chatWidth}`;
          await setReadingAppearance(page, { fontScale, chatWidth });
          await frames(page, 4);
          const layout = await page.evaluate(measureRails);
          writeReport(label, layout);
          assert.equal(layout.panes.length, cell.expect.length, `${label}: pane count`);
          checkCommon(collector, label, layout);
          layout.panes.forEach((pane, index) => {
            assert.equal(pane.mode, cell.expect[index], `${label} / pane ${pane.paneId}: mode`);
            if (cell.expect[index] === 'docked') {
              checkDocked(collector, label, pane, { paneEdge: pane.rail ? pane.stage.right + RESERVE_PX : 0 });
              if (cell.panel) {
                collector.ok(pane.stage.width >= READING_FLOOR_PX, `${label} / pane ${pane.paneId}: the pane keeps >= ${READING_FLOOR_PX}px of reading beside the rail (${fmt(pane.stage.width)}px)`);
              }
            } else {
              collector.ok(pane.rail === null, `${label} / pane ${pane.paneId}: no docked rail below the threshold`);
              collector.ok(pane.toggle !== null, `${label} / pane ${pane.paneId}: the Session toggle is in the cluster`);
              collector.ok(Math.abs(pane.stageMarginEnd) < 0.5, `${label} / pane ${pane.paneId}: an undocked pane gives nothing to a rail`);
            }
          });
          if (cell.split) {
            const [first, second] = layout.panes;
            collector.ok(first.rail && second.rail && first.rail.right <= second.stage.left + 0.5, `${label}: the first pane's rail stays out of the second pane`);
            collector.ok(first.projectText !== second.projectText, `${label}: each pane shows its own facts ("${first.projectText}" / "${second.projectText}")`);
            collector.ok(first.contextValue !== second.contextValue, `${label}: each pane shows its own context (${first.contextValue} / ${second.contextValue})`);
          }
        }
      }
      await page.close();
    });
    assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
  });
}

test('session rail layout: below 920px the toggle opens a sheet anchored inside the pane; Escape returns focus; nothing is persisted', { skip: SKIP, timeout: 180000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    for (const sidebarCollapsed of [true, false]) {
      const page = await mountReadingLayout(browser, { viewport: { width: 700, height: 900 }, split: false, sidebarCollapsed });
      await installRails(page);
      for (const fontScale of FONT_SCALE_IDS) {
        const label = `700 single (${sidebarCollapsed ? 'collapsed' : 'expanded'} sidebar) / ${fontScale} text`;
        await setReadingAppearance(page, { fontScale, chatWidth: 'standard' });
        await page.click('[data-session-rail-toggle]');
        await frames(page, 4);
        const open = await page.evaluate(measureRails);
        writeReport(`${label} (sheet open)`, open);
        const pane = open.panes[0];
        collector.ok(pane.sheet !== null, `${label}: the sheet opens`);
        if (pane.sheet) {
          collector.ok(pane.sheet.width <= Math.min(320, pane.stage.width * 0.92) + 1, `${label}: the sheet is min(320px, 92%) wide (${fmt(pane.sheet.width)}px in ${fmt(pane.stage.width)}px)`);
          collector.ok(pane.sheet.left >= pane.stage.left - 0.5 && pane.sheet.right <= pane.stage.right + 0.5, `${label}: the sheet is anchored inside the pane [${fmt(pane.sheet.left)}, ${fmt(pane.sheet.right)}] in [${fmt(pane.stage.left)}, ${fmt(pane.stage.right)}]`);
          collector.ok(pane.sheet.top >= pane.toggle.bottom - 0.5, `${label}: the sheet opens below the toggle`);
          collector.ok(pane.sheet.bottom <= open.view.bottom + 0.5, `${label}: the sheet stays inside the view`);
          collector.ok(pane.sheet.right >= pane.toggle.right - 0.5 || pane.sheet.left <= pane.toggle.left + 0.5, `${label}: the sheet hangs from the toggle's edge`);
        }
        checkCommon(collector, `${label} (sheet open)`, open);
        const focus = await page.evaluate(() => ({ inSheet: Boolean(document.activeElement && document.activeElement.closest('[data-session-rail-sheet]')) }));
        collector.ok(focus.inSheet, `${label}: focus moved into the sheet`);
        await page.keyboard.press('Escape');
        await frames(page, 3);
        const closed = await page.evaluate(() => ({ sheetShown: getComputedStyle(document.querySelector('[data-session-rail-sheet]')).display !== 'none', focusedToggle: document.activeElement === document.querySelector('[data-session-rail-toggle]') }));
        collector.ok(!closed.sheetShown, `${label}: Escape closes the sheet`);
        collector.ok(closed.focusedToggle, `${label}: Escape returns focus to the Session toggle`);
        const writes = await page.evaluate(() => window.__railWrites.length);
        collector.ok(writes === 0, `${label}: the sheet wrote no view state (${writes} writes)`);
      }
      await page.close();
    }
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});

test('session rail layout: hiding the docked rail gives the room back and keeps composer = measure; showing takes it again', { skip: SKIP, timeout: 120000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await installRails(page);
    const docked = (await page.evaluate(measureRails)).panes[0];
    await toggleRail(page);
    const hidden = await page.evaluate(measureRails);
    const pane = hidden.panes[0];
    collector.ok(pane.mode === 'hidden' && pane.rail === null, `hidden: the rail is gone (${pane.mode})`);
    collector.ok(Math.abs(pane.stage.width - (docked.stage.width + RESERVE_PX)) <= 1, `hidden: the stage took the room back (${fmt(docked.stage.width)} -> ${fmt(pane.stage.width)})`);
    checkCommon(collector, 'hidden', hidden);
    collector.ok(pane.toggle !== null, 'hidden: the toggle stays so the rail can come back');
    const writes = await page.evaluate(() => window.__railWrites.map((write) => write.patch));
    collector.ok(JSON.stringify(writes) === JSON.stringify([{ rail_visible: false }]), `hidden: one rail_visible write (${JSON.stringify(writes)})`);
    await toggleRail(page);
    const shown = await page.evaluate(measureRails);
    collector.ok(shown.panes[0].mode === 'docked' && Math.abs(shown.panes[0].stage.width - docked.stage.width) <= 1, `shown again: the same stage width (${fmt(docked.stage.width)} -> ${fmt(shown.panes[0].stage.width)})`);
    checkCommon(collector, 'shown again', shown);
    await page.close();
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});

test('session rail layout: a section disclosure animates height and a collapsed body is out of the tab order', { skip: SKIP, timeout: 120000 }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await installRails(page);
    const read = () => page.evaluate(() => {
      const head = document.querySelector('[data-rail-section="context"]');
      const body = head.parentElement.querySelector('[data-rail-body]');
      const rows = [...body.querySelectorAll('button')];
      return { expanded: head.getAttribute('aria-expanded'), height: body.getBoundingClientRect().height, visibility: getComputedStyle(body).visibility, interpolate: getComputedStyle(body).getPropertyValue('interpolate-size'), focusable: rows.filter((el) => getComputedStyle(el).visibility !== 'hidden').length };
    });
    const closed = await read();
    assert.equal(closed.expanded, 'false');
    assert.equal(closed.height, 0, 'a closed section takes no height');
    assert.equal(closed.visibility, 'hidden', 'its rows cannot take focus');
    assert.equal(closed.focusable, 0);
    await page.click('[data-rail-section="context"]');
    // The height transition is running: sample it half way through.
    const midway = await page.evaluate(() => {
      const body = document.querySelector('[data-rail-section="context"]').parentElement.querySelector('[data-rail-body]');
      const animations = body.getAnimations().filter((anim) => anim.effect && anim.effect.getComputedTiming().endTime > 0);
      animations.forEach((anim) => { anim.pause(); anim.currentTime = anim.effect.getComputedTiming().endTime * 0.5; });
      return { count: animations.length, properties: animations.map((anim) => anim.transitionProperty).filter(Boolean), height: body.getBoundingClientRect().height };
    });
    await page.evaluate(() => { document.getAnimations().forEach((anim) => { try { anim.finish(); } catch (_e) { /* infinite */ } }); });
    await frames(page, 3);
    const opened = await read();
    assert.equal(opened.expanded, 'true');
    assert.ok(opened.height > 40, `an open section has its rows' height (${opened.height})`);
    assert.ok(midway.count > 0, 'opening runs a transition');
    assert.ok(midway.properties.some((property) => /block-size|height/.test(property)), `the height is what animates (${midway.properties.join(', ')})`);
    assert.ok(midway.height > 0 && midway.height < opened.height, `half way the section is between closed and open (${midway.height} of ${opened.height})`);
    await page.close();
  });
});

test('session rail layout: data arriving after "checking" settles at once, with no height or opacity motion', { skip: SKIP, timeout: 120000 }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await installRails(page, { summaryDelayMs: 250 });
    assert.equal(await page.evaluate(() => document.querySelector('[data-section="context"]').dataset.state), 'checking', 'the first paint is still checking');
    await page.waitForFunction(() => document.querySelector('[data-section="context"]').dataset.state === 'available');
    const motion = await page.evaluate(() => document.getAnimations()
      .filter((anim) => anim.effect && anim.effect.target && anim.effect.target.closest && anim.effect.target.closest('.session-rail-tray') && anim.transitionProperty)
      .map((anim) => anim.transitionProperty));
    assert.deepEqual(motion, [], 'nothing animates on load or a session switch');
    const open = await page.evaluate(() => ['environment', 'outputs', 'background_tasks'].map((key) => document.querySelector(`[data-rail-section="${key}"]`).getAttribute('aria-expanded')));
    assert.deepEqual(open, ['true', 'true', 'true'], 'the defaults applied');
    await page.close();
  });
});

/* Row 115 slice 1: the cluster is a bar that never changes orientation, so the Session button is
   where it was whether the rail is docked, hidden or the panel beside it is open. */
test('session bar: the cluster keeps flex-direction row and the Session button does not move when the rail docks, hides or a panel opens', { skip: SKIP, timeout: 120000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await installRails(page);
    const docked = (await page.evaluate(measureRails)).panes[0];
    await toggleRail(page);
    const hidden = (await page.evaluate(measureRails)).panes[0];
    collector.ok(docked.mode === 'docked' && hidden.mode === 'hidden', `the two rail states were measured (${docked.mode}, ${hidden.mode})`);
    for (const [name, pane] of [['docked', docked], ['hidden', hidden]]) {
      collector.ok(pane.clusterDirection === 'row', `${name}: the cluster is a row (${pane.clusterDirection})`);
      collector.ok(Math.abs(pane.cluster.height - 40) <= 0.5, `${name}: the bar is 40px tall (${fmt(pane.cluster.height)})`);
      collector.ok(pane.cluster.bottom <= pane.stage.top + 0.5, `${name}: the stage starts below the bar`);
    }
    for (const [name, pane] of [['docked', docked], ['hidden', hidden]]) {
      collector.ok(pane.cluster.left <= pane.stage.left + 0.5 && pane.cluster.right >= pane.stage.right - 0.5, `${name}: the bar spans the whole pane, not only the rail (bar [${fmt(pane.cluster.left)}, ${fmt(pane.cluster.right)}], stage [${fmt(pane.stage.left)}, ${fmt(pane.stage.right)}])`);
    }
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      collector.ok(Math.abs(docked.toggle[edge] - hidden.toggle[edge]) <= 0.5, `the Session button's ${edge} is the same docked and hidden (${fmt(docked.toggle[edge])} vs ${fmt(hidden.toggle[edge])})`);
    }
    await toggleRail(page);
    await openPanel(page);
    const withPanel = (await page.evaluate(measureRails)).panes[0];
    collector.ok(withPanel.clusterDirection === 'row', `panel open: the cluster is a row (${withPanel.clusterDirection})`);
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      collector.ok(Math.abs(withPanel.toggle[edge] - docked.toggle[edge]) <= 0.5, `the Session button's ${edge} does not move when the panel opens (${fmt(docked.toggle[edge])} vs ${fmt(withPanel.toggle[edge])})`);
    }
    const panelBox = await page.evaluate(() => {
      const r = document.getElementById('artifactReviewPanel').getBoundingClientRect();
      return { top: r.top };
    });
    collector.ok(panelBox.top >= withPanel.cluster.bottom - 0.5, `the open panel starts below the bar (${fmt(panelBox.top)} vs ${fmt(withPanel.cluster.bottom)})`);
    await page.close();
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});

test('session bar: the buttons keep a fixed visual order whatever order they mounted in', { skip: SKIP, timeout: 120000 }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await installRails(page);
    const order = await page.evaluate(() => {
      const cluster = document.querySelector('#chatPane0 .chat-timeline-utility-cluster');
      const make = (id, label) => { const b = document.createElement('button'); b.id = id; b.textContent = label; return b; };
      // Mounted in the reverse of the visual order, Notes first.
      cluster.append(make('chatTimelineNotesToggle', 'Notes'), make('chatTimelineTasksToggle', 'Tasks'));
      document.getElementById('artifactSplitViewToggle').hidden = false;
      const title = document.createElement('div');
      title.className = 'session-bar-title';
      title.textContent = 'A chat title';
      cluster.append(title);
      return [...cluster.children].filter((el) => el.getClientRects().length).map((el) => ({ key: el.id || el.className || el.tagName, left: el.getBoundingClientRect().left }))
        .sort((a, b) => a.left - b.left).map((entry) => entry.key);
    });
    const index = (key) => order.findIndex((entry) => entry.includes(key));
    assert.ok(index('session-bar-title') === 0, `the title is first (${order.join(' | ')})`);
    assert.ok(index('artifactSplitViewToggle') < index('chatTimelineTasksToggle'), `Artifacts before Tasks (${order.join(' | ')})`);
    assert.ok(index('chatTimelineTasksToggle') < index('chatTimelineNotesToggle'), `Tasks before Notes (${order.join(' | ')})`);
    assert.ok(index('chatTimelineNotesToggle') < index('session-rail-toggle'), `Notes before Session (${order.join(' | ')})`);
    await page.close();
  });
});

test('session bar: in a split the kicker row is the bar, the buttons sit before the close glyph and the title ellipsizes', { skip: SKIP, timeout: 120000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 2327, height: 1300 }, split: true });
    await installRails(page);
    await page.evaluate(() => {
      document.querySelectorAll('#chatView .chat-pane').forEach((paneEl) => {
        const kicker = paneEl.querySelector('.chat-pane-kicker');
        kicker.hidden = false;
        kicker.innerHTML = '<span class="chat-pane-kicker-title">' + 'A very long conversation title that has to ellipsize before it reaches the buttons in the bar. '.repeat(6) + '</span>'
          + '<button type="button" class="workspace-rail-close-button chat-pane-close" aria-label="Close pane"></button>';
      });
    });
    await frames(page, 4);
    const panes = await page.evaluate(() => [...document.querySelectorAll('#chatView .chat-pane')].map((paneEl) => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
      const toggle = paneEl.querySelector('[data-session-rail-toggle]');
      const title = paneEl.querySelector('.chat-pane-kicker-title');
      return {
        pane: rect(paneEl), kicker: rect(paneEl.querySelector('.chat-pane-kicker')), cluster: rect(paneEl.querySelector('.chat-timeline-utility-cluster')),
        close: rect(paneEl.querySelector('.chat-pane-close')), toggle: toggle ? rect(toggle) : null, title: rect(title), titleClipped: title.scrollWidth > title.clientWidth,
        stage: rect(paneEl.querySelector('.chat-thread-stage')), direction: getComputedStyle(paneEl.querySelector('.chat-timeline-utility-cluster')).flexDirection,
      };
    }));
    panes.forEach((pane, index) => {
      const tag = `split pane ${index}`;
      collector.ok(pane.direction === 'row', `${tag}: the cluster is a row`);
      collector.ok(Math.abs(pane.kicker.height - 40) <= 0.5, `${tag}: the kicker row is the 40px bar (${fmt(pane.kicker.height)})`);
      collector.ok(pane.cluster.top >= pane.kicker.top - 0.5 && pane.cluster.bottom <= pane.kicker.bottom + 0.5, `${tag}: the buttons [${fmt(pane.cluster.top)}, ${fmt(pane.cluster.bottom)}] sit inside the kicker row [${fmt(pane.kicker.top)}, ${fmt(pane.kicker.bottom)}]`);
      collector.ok(pane.stage.top >= pane.kicker.bottom - 0.5, `${tag}: the stage is below the kicker row, with no extra offset (${fmt(pane.stage.top)} vs ${fmt(pane.kicker.bottom)})`);
      collector.ok(pane.cluster.right <= pane.close.left + 0.5, `${tag}: the buttons end (${fmt(pane.cluster.right)}) before the close glyph (${fmt(pane.close.left)})`);
      collector.ok(pane.close.right <= pane.pane.right + 0.5 && pane.close.right >= pane.pane.right - 16, `${tag}: the close glyph [${fmt(pane.close.left)}, ${fmt(pane.close.right)}] is at the pane's far end ${fmt(pane.pane.right)}`);
      collector.ok(pane.close.top >= pane.kicker.top - 0.5 && pane.close.bottom <= pane.kicker.bottom + 0.5, `${tag}: the close glyph is inside the bar`);
      collector.ok(pane.title.right <= pane.cluster.left + 0.5, `${tag}: the title ends (${fmt(pane.title.right)}) before the buttons (${fmt(pane.cluster.left)})`);
      collector.ok(pane.titleClipped, `${tag}: a long title ellipsizes`);
    });
    await page.close();
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});
