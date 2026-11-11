/* global document, window, getComputedStyle */
'use strict';

/* Shared pieces of the session rail's layout gates (tests/renderer-session-rail-layout.test.js and
   tests/renderer-session-rail-glide-layout.test.js): the injected rail modules and fake bridge, the in-page
   measurement, and the common and docked assertions. */

const fs = require('node:fs');
const path = require('node:path');
const { frames, fmt } = require('./chat-reading-layout-harness');

const ROOT = path.resolve(__dirname, '../..');
const RAIL_PX = 280;
const RESERVE_PX = RAIL_PX + 16; // the rail plus var(--space-8) of air
const READING_FLOOR_PX = 360;
const PANEL_PX = 420;
const REPORT = process.env.SESSION_RAIL_LAYOUT_REPORT || '';

const inject = (page, files) => files.reduce((chain, file) => chain.then(() => page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, file), 'utf8') })), Promise.resolve());

/* Mounts the injected rails the way renderer-chat-event-transcript-bindings does: one per pane, its
   own session. */
async function installRails(page, { artifactsToggle = true, summaryDelayMs = 0 } = {}) {
  await page.addStyleTag({ content: fs.readFileSync(path.join(ROOT, 'styles/chat-session-rail.css'), 'utf8') });
  await inject(page, [
    'renderer/chat/renderer-context-usage-model.js',
    'renderer/chat/renderer-context-preview.js',
    'renderer/chat/renderer-session-rail-model.js',
    'renderer/chat/renderer-session-rail-render.js',
    'renderer/features/renderer-side-panel-motion.js',
    'renderer/chat/renderer-session-rail-motion.js',
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
      const sessionId = paneEl.dataset.paneId === '1' ? 'sess_two' : 'sess_one';
      window.__rails.push(window.rendererSessionRail.mountSessionRail({
        pane: paneEl, cluster, chatTimeline: paneEl.querySelector('.chat-timeline'), getSessionId: () => sessionId,
      }));
    });
  }, { showArtifactsToggle: artifactsToggle, delayMs: summaryDelayMs });
  await frames(page, 6);
}

/* The Session toggle glides (row 115 slice 3): click, then wait for the shared motion to end before measuring. */
async function toggleRail(page) {
  await page.click('[data-session-rail-toggle]');
  await page.waitForFunction(() => !document.getElementById('chatView').hasAttribute('data-panel-motion'));
  await frames(page, 4);
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
      clusterDirection: getComputedStyle(cluster).flexDirection,
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
  collector.ok(pane.toggle && (!pane.tray || pane.toggle.bottom <= pane.tray.top + 0.5), `${tag}: the Session toggle (${pane.toggleLabel}) sits in the bar, above the tray`);
  collector.ok(pane.cluster.bottom <= pane.stage.top + 0.5, `${tag}: nothing of the bar floats over the reading column (bar ends ${fmt(pane.cluster.bottom)}, stage starts ${fmt(pane.stage.top)})`);
  if (pane.railPaddings && pane.railPaddings.scrollbar === 0 && pane.tray) {
    const startGap = pane.tray.left - pane.rail.left;
    const endGap = pane.rail.right - pane.tray.right;
    collector.ok(Math.abs(startGap - endGap) <= 1 && startGap >= 15, `${tag}: equal room round the tray (${fmt(startGap)} / ${fmt(endGap)})`);
  }
  if (pane.trayOverflow) collector.ok(pane.trayOverflow.scrollWidth <= pane.trayOverflow.clientWidth + 1, `${tag}: the tray has no horizontal overflow`);
  for (const row of pane.rows) collector.ok(row.right <= pane.rail.right + 0.5, `${tag}: a row stays inside the rail`);
}

module.exports = {
  ROOT, RAIL_PX, RESERVE_PX, READING_FLOOR_PX, PANEL_PX, REPORT, inject, installRails, toggleRail, openPanel, measureRails, writeReport, checkCommon, checkDocked,
};
