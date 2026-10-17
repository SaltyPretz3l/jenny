/* global document, window, getComputedStyle */
'use strict';

/* Row 59 checkpoint 2, slice S3: the session rail's layout gate. The REAL stylesheets (index.html
 * plus styles/chat-session-rail.css) and the real rail modules in headless Chromium, on the
 * reading-layout harness (every app script blocked; the rail modules and a fake chatWorkspace
 * bridge injected). jsdom cannot lay out CSS, so this is the contract for the placement:
 *
 *   1455 single        docked: a 280px rail at the pane's end edge, the stage and the composer
 *                      give it room together (composer edges = the timeline measure), the utility
 *                      cluster with the Session toggle sits over the rail head (not the reading column)
 *   ~2327 split        both panes docked, each its own facts, neither overlapping the other
 *   700                undocked: no rail, a Session toggle, a sheet anchored inside the pane
 *   1455 + side panel  the rail stays docked and the pane keeps >= 360px of reading
 *   Default / Large    text, Narrow / Standard width, in every layout above
 *
 * Every cell also asserts: no horizontal page or scroller overflow, header values never clipped.
 * Set SESSION_RAIL_LAYOUT_REPORT=<file> to append the measured numbers as JSON lines. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SKIP, withBrowser, frames, FONT_SCALE_IDS, CHAT_WIDTH_IDS, mountReadingLayout, setReadingAppearance, createCollector, fmt,
} = require('./helpers/chat-reading-layout-harness');

const ROOT = path.resolve(__dirname, '..');
const RAIL_PX = 280;
const RESERVE_PX = RAIL_PX + 16; // the rail plus var(--space-8) of air
const READING_FLOOR_PX = 360;
const PANEL_PX = 420;
const REPORT = process.env.SESSION_RAIL_LAYOUT_REPORT || '';

const inject = (page, files) => files.reduce((chain, file) => chain.then(() => page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, file), 'utf8') })), Promise.resolve());

const CELLS = [
  { name: '1455x900 single', viewport: { width: 1455, height: 900 }, split: false, expect: ['docked'] },
  { name: '1455x900 single, no Artifacts toggle', viewport: { width: 1455, height: 900 }, split: false, artifactsToggle: false, expect: ['docked'] },
  { name: '2327x1300 split', viewport: { width: 2327, height: 1300 }, split: true, expect: ['docked', 'docked'] },
  { name: '700x900 single (sidebar collapsed)', viewport: { width: 700, height: 900 }, split: false, sidebarCollapsed: true, expect: ['undocked'] },
  { name: '700x900 single (sidebar expanded)', viewport: { width: 700, height: 900 }, split: false, expect: ['undocked'] },
  { name: '1455x900 single, artifact panel open', viewport: { width: 1455, height: 900 }, split: false, panel: true, expect: ['docked'] },
];

/* Mounts the injected rails the way renderer-chat-event-transcript-bindings does: one per pane, its
   own session, the utility reserve observer the app runs beside it. */
async function installRails(page, { artifactsToggle = true, summaryDelayMs = 0 } = {}) {
  await page.addStyleTag({ content: fs.readFileSync(path.join(ROOT, 'styles/chat-session-rail.css'), 'utf8') });
  await inject(page, [
    'renderer/chat/renderer-context-usage-model.js',
    'renderer/chat/renderer-context-preview.js',
    'renderer/chat/renderer-chat-pane-surface-controllers.js',
    'renderer/chat/renderer-session-rail-model.js',
    'renderer/chat/renderer-session-rail-render.js',
    'renderer/chat/renderer-session-rail.js',
  ]);
  await page.evaluate(({ showArtifactsToggle, delayMs }) => {
    const wrap = (data, state = 'available') => ({ state, sampled_at: '2026-10-15T10:00:00.000Z', reason: null, data });
    const summaryFor = (sessionId) => ({
      session_id: sessionId, session_incarnation: `inc_${sessionId}`, revision: 1,
      environment: wrap({
        project_id: `p_${sessionId}`, project_name: sessionId === 'sess_two' ? 'second-project-with-a-rather-long-name-that-must-ellipsize' : 'jenny',
        workspace_id: 'w', display_path: 'D:\\Work\\jenny\\renderer\\features\\some\\very\\long\\directory\\name\\that\\cannot\\fit',
        branch: 'feature/session-rail-with-a-very-long-descriptive-branch-name', worktree_id: null, execution_environment: 'local', run_mode: 'auto',
      }),
      context: wrap({ turn_id: null, used_tokens: sessionId === 'sess_two' ? 29000 : 20480, capacity_tokens: 32000, available_tokens: 3000, measurement: 'actual', scope: 'request' }),
      outputs: wrap({ items: [{ artifact_id: `${sessionId}_a1`, display_name: 'a_rather_long_generated_file_name_for_the_probe.py', kind: 'code', availability: 'available' }, { artifact_id: `${sessionId}_a2`, display_name: 'results.md', kind: 'document', availability: 'available' }], total_count: 2, next_cursor: null }),
      changes: wrap({ workspace_id: 'w', scope: 'working_tree', file_count: 6, additions: 412, deletions: 37, ref: 'main', head: 'abc1234' }),
      background_tasks: wrap({ scope: 'session_and_direct_children', counts: { active: 1, waiting: 0, failed: 0, completed: 12 }, coverage: 'partial', unsupported_sources: ['linked_chat_turn'], items: [{ source_kind: 'workspace_test', operation_id: 'op_1', session_id: sessionId, state: 'running', started_at: null, finished_at: null, output_ref: null }] }),
    });
    const writes = [];
    const persisted = { rail_visible: null, disclosures: {} };
    window.__railWrites = writes;
    window.jennyShell = {
      chatWorkspace: {
        getSummary: async ({ session_id: sessionId }) => (await new Promise((resolve) => setTimeout(resolve, delayMs)), { schema_version: 1, ok: true, summary: summaryFor(sessionId), workspace_view: { schema_version: 1, rail_visible: null, disclosures: {}, children_expanded: null }, coordination_revision: 0 }),
        setView: async (request) => {
          writes.push(request);
          if (Object.hasOwn(request.patch, 'rail_visible')) persisted.rail_visible = request.patch.rail_visible;
          Object.assign(persisted.disclosures, request.patch.disclosures || {});
          return { schema_version: 1, ok: true, workspace_view: { schema_version: 1, ...persisted, children_expanded: null }, coordination_revision: writes.length };
        },
        onChanged: () => () => {},
      },
    };
    window.rendererChatWorkspaceDetail = { open: (request) => { window.__railDetail = request; } };
    // The labelled Artifacts toggle is the widest thing the cluster can hold (shown once a chat has artifacts).
    document.getElementById('artifactSplitViewToggle').hidden = !showArtifactsToggle;
    window.__rails = [];
    document.querySelectorAll('#chatView .chat-pane').forEach((paneEl) => {
      const cluster = paneEl.querySelector('.chat-timeline-utility-cluster');
      const stage = paneEl.querySelector('.chat-thread-stage');
      const sessionId = paneEl.dataset.paneId === '1' ? 'sess_two' : 'sess_one';
      window.rendererChatPaneSurfaceControllers.observeUtilityReserve(stage, cluster, window);
      window.__rails.push(window.rendererSessionRail.mountSessionRail({
        pane: paneEl, cluster, chatTimeline: paneEl.querySelector('.chat-timeline'), getSessionId: () => sessionId,
      }));
    });
  }, { showArtifactsToggle: artifactsToggle, delayMs: summaryDelayMs });
  await frames(page, 6);
}

/* The end state the app applies when the artifact review panel is open (no motion). */
async function openPanel(page) {
  await page.evaluate((width) => {
    const view = document.getElementById('chatView');
    const panel = document.getElementById('artifactReviewPanel');
    view.style.setProperty('--artifact-review-width', `${width}px`);
    panel.style.setProperty('width', `${width}px`);
    panel.classList.remove('hidden');
    document.getElementById('artifactReviewResizer').classList.remove('hidden');
    view.classList.add('artifact-review-mode', 'artifact-review-open');
  }, PANEL_PX);
  await frames(page, 6);
}

/* Everything the assertions read, as plain numbers. Runs in the page. */
function measureRails() {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const view = document.getElementById('chatView');
  const panes = [...document.querySelectorAll('#chatView .chat-pane')].map((paneEl) => {
    const stage = paneEl.querySelector('.chat-thread-stage');
    const rail = paneEl.querySelector('[data-session-rail-root]');
    const sheet = paneEl.querySelector('[data-session-rail-sheet]');
    const toggle = paneEl.querySelector('[data-session-rail-toggle]');
    const cluster = paneEl.querySelector('.chat-timeline-utility-cluster');
    const tray = paneEl.querySelector('.session-rail-tray');
    const scroll = paneEl.querySelector('.chat-thread-scroll');
    const composerWrap = paneEl.querySelector('.composer-wrap');
    const stageStyle = getComputedStyle(stage);
    const railStyle = rail ? getComputedStyle(rail) : null;
    const trayRect = tray ? rect(tray) : null;
    const prose = paneEl.querySelector('.chat-entry.assistant .chat-bubble-markdown p');
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:1ch;height:1px;';
    prose.appendChild(probe);
    const ch = probe.getBoundingClientRect().width;
    probe.remove();
    const values = [...paneEl.querySelectorAll('.session-rail-section-value')].filter((el) => el.getClientRects().length).map((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, right: el.getBoundingClientRect().right, text: el.textContent.trim() }));
    const rows = [...paneEl.querySelectorAll('.session-rail-fact')].filter((el) => el.getClientRects().length).map((el) => ({ right: el.getBoundingClientRect().right, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    return {
      paneId: paneEl.dataset.paneId,
      mode: paneEl.dataset.sessionRail,
      stage: rect(stage),
      stageMarginEnd: Number.parseFloat(stageStyle.marginInlineEnd),
      measure: rect(paneEl.querySelector('.chat-timeline')),
      composer: rect(paneEl.querySelector('.composer')),
      composerWrap: rect(composerWrap),
      rail: rail && getComputedStyle(rail).display !== 'none' ? rect(rail) : null,
      railPaddings: railStyle ? { start: Number.parseFloat(railStyle.paddingLeft), end: Number.parseFloat(railStyle.paddingRight), scrollbar: rail.offsetWidth - rail.clientWidth } : null,
      tray: trayRect,
      trayOverflow: tray ? { scrollWidth: tray.scrollWidth, clientWidth: tray.clientWidth } : null,
      sheet: sheet && getComputedStyle(sheet).display !== 'none' ? rect(sheet) : null,
      toggle: toggle && toggle.getClientRects().length ? rect(toggle) : null,
      toggleLabel: toggle ? toggle.textContent.trim() : null,
      cluster: rect(cluster),
      threadScroll: { scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth },
      ch,
      projectText: (paneEl.querySelector('[data-section="environment"] .session-rail-ellip') || {}).textContent || null,
      contextValue: (paneEl.querySelector('[data-section="context"] [data-rail-value]') || {}).textContent || null,
      values,
      rows,
    };
  });
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    page: { scrollWidth: document.scrollingElement.scrollWidth, innerWidth: window.innerWidth },
    view: rect(view),
    viewOverflow: { scrollWidth: view.scrollWidth, clientWidth: view.clientWidth },
    panes,
  };
}

function writeReport(label, layout) {
  if (!REPORT) return;
  const summary = layout.panes.map((pane) => ({
    pane: pane.paneId, mode: pane.mode, stage: Math.round(pane.stage.width), measure: Math.round(pane.measure.width), composer: Math.round(pane.composer.width),
    rail: pane.rail ? Math.round(pane.rail.width) : null, sheet: pane.sheet ? Math.round(pane.sheet.width) : null, cluster: Math.round(pane.cluster.width),
  }));
  fs.appendFileSync(REPORT, `${JSON.stringify({ label, viewport: layout.viewport, panes: summary })}\n`);
}

function checkCommon(collector, label, layout) {
  collector.ok(layout.page.scrollWidth <= layout.page.innerWidth, `${label}: no horizontal page scroll (${layout.page.scrollWidth} > ${layout.page.innerWidth})`);
  collector.ok(layout.viewOverflow.scrollWidth <= layout.viewOverflow.clientWidth + 1, `${label}: the chat view does not overflow sideways (${layout.viewOverflow.scrollWidth} > ${layout.viewOverflow.clientWidth})`);
  layout.panes.forEach((pane) => {
    const tag = `${label} / pane ${pane.paneId}`;
    collector.ok(pane.threadScroll.scrollWidth <= pane.threadScroll.clientWidth + 1, `${tag}: the thread scroller has no horizontal scroll`);
    collector.ok(Math.abs(pane.composer.left - pane.measure.left) <= 1 && Math.abs(pane.composer.right - pane.measure.right) <= 1,
      `${tag}: composer [${fmt(pane.composer.left)}, ${fmt(pane.composer.right)}] keeps the measure's edges [${fmt(pane.measure.left)}, ${fmt(pane.measure.right)}]`);
    collector.ok(pane.measure.left >= pane.stage.left - 0.5 && pane.measure.right <= pane.stage.right + 0.5, `${tag}: the measure stays inside the stage`);
    for (const value of pane.values) {
      collector.ok(value.scrollWidth <= value.clientWidth + 1, `${tag}: header value "${value.text}" is not clipped (${value.scrollWidth} > ${value.clientWidth})`);
    }
  });
}

function checkDocked(collector, label, pane, { paneEdge }) {
  const tag = `${label} / pane ${pane.paneId}`;
  collector.ok(pane.mode === 'docked', `${tag}: data-session-rail is docked (saw ${pane.mode})`);
  if (!pane.rail) { collector.ok(false, `${tag}: the rail is shown`); return; }
  collector.ok(Math.abs(pane.rail.width - RAIL_PX) <= 0.5, `${tag}: rail width ${fmt(pane.rail.width)}px is ${RAIL_PX}px`);
  collector.ok(Math.abs(pane.rail.right - paneEdge) <= 1, `${tag}: the rail sits at the pane's end edge (${fmt(pane.rail.right)} vs ${fmt(paneEdge)})`);
  collector.ok(Math.abs(pane.stageMarginEnd - RESERVE_PX) <= 0.5, `${tag}: the stage gives up the rail plus one space-8 (${fmt(pane.stageMarginEnd)}px)`);
  collector.ok(Math.abs(pane.rail.left - pane.stage.right - 16) <= 1, `${tag}: the reading area ends 16px before the rail (${fmt(pane.stage.right)} -> ${fmt(pane.rail.left)})`);
  collector.ok(pane.measure.right <= pane.rail.left, `${tag}: the measure never reaches the rail`);
  collector.ok(pane.composerWrap.right <= pane.rail.left + 0.5, `${tag}: the composer stays clear of the rail`);
  collector.ok(pane.composerWrap.bottom <= pane.rail.bottom + 1 && pane.rail.top <= pane.stage.top + 1, `${tag}: the rail spans the stage and composer rows`);
  collector.ok(pane.toggle && pane.toggle.left >= pane.rail.left - 0.5 && (!pane.tray || pane.toggle.bottom <= pane.tray.top + 0.5), `${tag}: the Session toggle (${pane.toggleLabel}) sits over the rail head, above the tray`);
  collector.ok(pane.cluster.left >= pane.rail.left - 0.5 && pane.cluster.right <= pane.rail.right + 0.5, `${tag}: the utility cluster [${fmt(pane.cluster.left)}, ${fmt(pane.cluster.right)}] sits over the rail [${fmt(pane.rail.left)}, ${fmt(pane.rail.right)}]`);
  collector.ok(pane.cluster.left >= pane.stage.right - 0.5, `${tag}: nothing of the cluster floats over the reading column`);
  if (pane.railPaddings && pane.railPaddings.scrollbar === 0 && pane.tray) {
    const startGap = pane.tray.left - pane.rail.left;
    const endGap = pane.rail.right - pane.tray.right;
    collector.ok(Math.abs(startGap - endGap) <= 1 && startGap >= 15, `${tag}: equal room round the tray (${fmt(startGap)} / ${fmt(endGap)})`);
  }
  if (pane.trayOverflow) collector.ok(pane.trayOverflow.scrollWidth <= pane.trayOverflow.clientWidth + 1, `${tag}: the tray has no horizontal overflow`);
  for (const row of pane.rows) collector.ok(row.right <= pane.rail.right + 0.5, `${tag}: a row stays inside the rail`);
}

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
    await page.click('[data-session-rail-toggle]');
    await frames(page, 4);
    const hidden = await page.evaluate(measureRails);
    const pane = hidden.panes[0];
    collector.ok(pane.mode === 'hidden' && pane.rail === null, `hidden: the rail is gone (${pane.mode})`);
    collector.ok(Math.abs(pane.stage.width - (docked.stage.width + RESERVE_PX)) <= 1, `hidden: the stage took the room back (${fmt(docked.stage.width)} -> ${fmt(pane.stage.width)})`);
    checkCommon(collector, 'hidden', hidden);
    collector.ok(pane.toggle !== null, 'hidden: the toggle stays so the rail can come back');
    const writes = await page.evaluate(() => window.__railWrites.map((write) => write.patch));
    collector.ok(JSON.stringify(writes) === JSON.stringify([{ rail_visible: false }]), `hidden: one rail_visible write (${JSON.stringify(writes)})`);
    await page.click('[data-session-rail-toggle]');
    await frames(page, 4);
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
