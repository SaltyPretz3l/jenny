/* global document, window, getComputedStyle, requestAnimationFrame */
'use strict';

/* Row 59 checkpoint 1 (reading layout): a headless-Chromium page that lays out
 * the REAL index.html + stylesheets with a realistic transcript in the chat
 * pane(s) and the real composer toolbar, so a test can read the timeline
 * measure, the composer edges and the oversized-content scrollers as computed
 * boxes. Built on composer-layout-harness (every app script aborted, chosen
 * UMD modules injected as text, bypassCSP); that file is imported, not edited.
 *
 * Definitions the gate reads (the contract the style slices implement):
 *   measure   the timeline column's box: `#chatTimeline` of a pane. Its left and
 *             width are the reading measure (sprite rail excluded).
 *   pane      `.chat-thread-stage` of a pane (the pane's inline extent; `.chat-pane`
 *             itself generates no box in the one-pane view).
 *   cap       68ch (Narrow) / 92ch (Standard) in the prose font: the computed
 *             font of an assistant paragraph, with `1ch` read from a probe span.
 */

const fs = require('node:fs');
const path = require('node:path');
const { SKIP, withBrowser, mountComposer } = require('./composer-layout-harness');

const ROOT = path.resolve(__dirname, '../..');
const GUTTER_MAX_PX = 40;
const FONT_SCALE_IDS = ['default', 'large'];
const CHAT_WIDTH_IDS = ['narrow', 'standard'];
const CAP_CH = { narrow: 68, standard: 92 };

const PROSE = [
  'The reading column is the one place Jenny asks the person to stay for more than a glance, so its line length has to be a deliberate choice rather than whatever a window happens to leave over. A line that runs past ninety characters loses the eye on the return sweep, and a line that is squeezed under forty turns every sentence into a stutter.',
  'When the window grows, the measure should stop growing at a comfortable ceiling and the extra room should become margin; when the window shrinks, the measure should follow the pane it lives in instead of the screen it is shown on, because a split view gives each conversation only half of the screen. Nothing in the column may reach past that measure, including the composer that sits underneath it.',
];
const LONG_CODE_LINE = `curl --silent --show-error --fail-with-body --retry 3 --retry-delay 2 --header "Authorization: Bearer $JENNY_TOKEN" --header "Content-Type: application/json" --data @payload.json "https://example.invalid/api/v1/workspaces/0123456789abcdef/sessions/fedcba9876543210/export?format=json&include=history,artifacts,settings"`;
const TABLE_COLUMNS = ['Component', 'Owner', 'Current behavior', 'Expected behavior', 'Measured width', 'Notes', 'Ticket', 'Status'];
// Real tables carry paths and identifiers that cannot wrap, which is what makes them wider than the column.
const TABLE_CELL = (name, n) => `renderer/chat/${name.toLowerCase().replace(/\s+/g, '-')}-row-${n}-controller.js`;

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function row(id, inner, attrs = '') {
  return `<div class="chat-row" data-row-id="${id}" data-source-message-id="${id}"${attrs}>${inner}</div>`;
}

function bubble(inner) {
  return `<div class="chat-bubble chat-bubble-markdown" dir="auto">${inner}</div>`;
}

function article(role, id, rowsHtml) {
  return `<article class="chat-entry message-shell ${role}" data-message-id="${id}" data-message-role="${role}" data-message-status="complete" tabindex="-1">`
    + `<div class="chat-message-content"><div class="turn-row-list" data-turn-row-list="true">${rowsHtml}</div></div></article>`;
}

function codeBlock(id) {
  const lines = ['#!/usr/bin/env bash', 'set -euo pipefail', LONG_CODE_LINE, 'echo done'];
  return '<div class="markdown-code-block inv-codeblock-wrap">'
    + '<div class="markdown-code-header inv-codeblock-toolbar"><span class="markdown-code-language inv-codeblock-language">bash</span></div>'
    + `<pre id="${id}"><code class="language-bash">${esc(lines.join('\n'))}</code></pre></div>`;
}

function tableBlock() {
  const header = `<thead><tr>${TABLE_COLUMNS.map((name) => `<th>${esc(name)}</th>`).join('')}</tr></thead>`;
  const bodyRows = [1, 2, 3].map((n) => `<tr>${TABLE_COLUMNS.map((name) => `<td>${esc(TABLE_CELL(name, n))}</td>`).join('')}</tr>`).join('');
  return '<div class="markdown-table-wrapper">'
    + '<div class="markdown-table-header inv-codeblock-toolbar"></div>'
    + `<table>${header}<tbody>${bodyRows}</tbody></table></div>`;
}

function toolRun(id) {
  return row(id, '<span class="chat-row-node-dot" aria-hidden="true"></span>'
    + '<div class="tool-run-row" data-tool-run-state="done"><div class="tool-run-toggle" role="button" tabindex="0" data-tool-run-toggle="true" aria-expanded="false">'
    + '<span class="tool-run-summary">Read 14 files, searched the workspace for the layout tokens and ran the style checks on every stylesheet that sets the measure</span>'
    + '<span class="tool-result-duration">3.2s</span></div></div>', ' data-row-kind="tool_run" data-run-expanded="false"');
}

/* Several user/assistant turns with long prose, one fenced code block with a
   300+ character line, a wide table and a tool row, in the app's own classes. */
function transcriptHtml(prefix) {
  const turns = [];
  for (let n = 0; n < 4; n += 1) {
    const id = `${prefix}-${n}`;
    turns.push(article('user', `${id}-u`, row(`${id}-u-row`, bubble(`<p>${esc(`Turn ${n + 1}: ${PROSE[0].slice(0, 180)}`)}</p>`))));
    const rows = [row(`${id}-a-p1`, bubble(`<p>${esc(PROSE[0])}</p><p>${esc(PROSE[1])}</p>`))];
    if (n === 0) {
      rows.push(toolRun(`${id}-a-tool`));
      rows.push(row(`${id}-a-code`, bubble(`<p>${esc('The export step is one long command:')}</p>${codeBlock(`${id}-pre`)}`)));
      rows.push(row(`${id}-a-table`, bubble(`${tableBlock()}`)));
    }
    rows.push(row(`${id}-a-p2`, bubble(`<p>${esc(PROSE[1])}</p><p>${esc(PROSE[0])}</p>`)));
    turns.push(article('assistant', `${id}-a`, rows.join('')));
  }
  return turns.join('');
}

const frames = (page, count = 2) => page.evaluate((n) => new Promise((resolve) => {
  const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(n);
}), count);

/* Mounts the real composer (streaming = the worst-case toolbar row) in pane 0
   and lays the view out as the app does: one pane, or two at the default 50/50
   (the app's CSS, no inline grid override). */
async function mountReadingLayout(browser, { viewport, split, sidebarCollapsed = false }) {
  const page = await mountComposer(browser, { paneWidth: 600, streaming: true, viewport });
  await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'renderer/shared/appearance-utils.js'), 'utf8') });
  await page.evaluate(({ html, split: wantSplit, collapsed }) => {
    if (collapsed) {
      // The view-panel registry's collapsed state (SIDEBAR_COLLAPSED_WIDTH = 84px).
      const workspace = document.getElementById('workspace');
      workspace.classList.add('panel-collapsed');
      workspace.style.setProperty('--view-panel-current-width', '84px');
      workspace.style.setProperty('--sidebar-current-width', '84px');
    }
    const view = document.getElementById('chatView');
    // mountComposer lays out a fixed two-pane grid; hand the grid back to the app's CSS.
    view.style.gridTemplateColumns = '';
    // The app's default: the context panel is collapsed until the user opens it (renderer-context-panel-utils prefs.collapsed !== false).
    document.getElementById('chatContextPanel').classList.add('collapsed');
    view.classList.remove('chat-empty');
    view.classList.add('chat-active');
    view.dataset.chatMode = 'active';
    const resizer = document.getElementById('chatPaneResizer');
    view.dataset.paneCount = wantSplit ? '2' : '1';
    resizer.classList.toggle('hidden', !wantSplit);
    document.getElementById('chatTimeline').innerHTML = html.pane0;
    document.getElementById('chatTimeline').dataset.transcriptView = 'answers';
    if (wantSplit) {
      const template = document.getElementById('chatPaneTemplate');
      const clone = template.content.cloneNode(true);
      const paneEl = clone.querySelector('.chat-pane');
      paneEl.dataset.paneId = '1';
      paneEl.dataset.paneFocused = 'false';
      paneEl.classList.add('chat-active');
      paneEl.querySelector('.chat-timeline').innerHTML = html.pane1;
      paneEl.querySelector('.chat-timeline').dataset.transcriptView = 'answers';
      resizer.after(paneEl);
    }
  }, { html: { pane0: transcriptHtml('p0'), pane1: transcriptHtml('p1') }, split, collapsed: sidebarCollapsed });
  await frames(page, 3);
  return page;
}

/* Applies the two appearance axes the way applyAppearanceToDocument does for
   layout: data attributes plus the --font-scale variable from the real presets. */
async function setReadingAppearance(page, { fontScale, chatWidth }) {
  await page.evaluate(({ fontScale: scaleId, chatWidth: widthId }) => {
    const root = document.documentElement;
    const scale = window.appearanceUtils.getFontScalePresets().find((preset) => preset.id === scaleId).value;
    root.dataset.fontScale = scaleId;
    root.dataset.chatWidth = widthId;
    root.style.setProperty('--font-scale', String(scale));
  }, { fontScale, chatWidth });
  await frames(page, 3);
}

/* Everything the layout assertions read, as plain numbers. Runs in the page. */
function measureReadingLayout() {
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom };
  };
  const panes = [];
  document.querySelectorAll('#chatView .chat-pane').forEach((paneEl) => {
    const stage = paneEl.querySelector('.chat-thread-stage');
    const column = paneEl.querySelector('.chat-thread-column');
    const scroll = paneEl.querySelector('.chat-thread-scroll');
    const timeline = paneEl.querySelector('.chat-timeline');
    const composerEl = paneEl.querySelector('.composer');
    const prose = paneEl.querySelector('.chat-entry.assistant .chat-bubble-markdown p');
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:1ch;height:1px;';
    prose.appendChild(probe);
    const ch = probe.getBoundingClientRect().width;
    probe.remove();
    const proseStyle = getComputedStyle(prose);
    const columnStyle = getComputedStyle(column);
    const oversized = (selector) => [...paneEl.querySelectorAll(selector)].map((el) => ({
      rect: rectOf(el), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
    }));
    const stageRect = rectOf(stage);
    const paneBox = getComputedStyle(paneEl).display === 'contents' ? null : rectOf(paneEl);
    panes.push({
      paneId: paneEl.dataset.paneId,
      paneDisplay: getComputedStyle(paneEl).display,
      stage: stageRect,
      paneBox,
      paneScroll: paneBox ? { scrollWidth: paneEl.scrollWidth, clientWidth: paneEl.clientWidth } : null,
      threadScroll: { scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth },
      column: rectOf(column),
      columnPaddingStart: Number.parseFloat(columnStyle.paddingLeft),
      measure: rectOf(timeline),
      composer: composerEl ? rectOf(composerEl) : null,
      ch,
      proseFont: `${proseStyle.fontSize} ${proseStyle.fontFamily}`,
      proseFontPx: Number.parseFloat(proseStyle.fontSize),
      articles: oversized('.chat-entry.assistant, .chat-entry.user'),
      userBubbles: oversized('.chat-entry.user'),
      codeBlocks: oversized('.markdown-code-block'),
      codeScrollers: oversized('.markdown-code-block pre'),
      tables: oversized('.markdown-table-wrapper'),
      toolRows: oversized('.tool-run-row'),
      toolSummaries: [...paneEl.querySelectorAll('.tool-run-summary')].map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return { lines: new Set([...range.getClientRects()].map((rc) => Math.round(rc.top))).size, overflow: getComputedStyle(el).textOverflow, clipped: el.scrollWidth > el.clientWidth };
      }),
    });
  });
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    page: { scrollWidth: document.scrollingElement.scrollWidth, innerWidth: window.innerWidth },
    panes,
  };
}

/* Every visible control of pane 0's composer toolbar: one line, no overlap,
   nothing clipped, all inside the composer box. */
function measureComposerToolbar() {
  const composerEl = document.querySelector('#chatPane0 .composer');
  const toolbar = composerEl.querySelector('.composer-toolbar');
  const box = composerEl.getBoundingClientRect();
  const controls = [...toolbar.querySelectorAll('button')]
    .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
    .map((node) => {
      const r = node.getBoundingClientRect();
      return { name: node.getAttribute('aria-label') || node.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    })
    .sort((a, b) => a.left - b.left);
  return { composer: { left: box.left, right: box.right }, controls };
}

/* Collects failures instead of stopping at the first one, so a red run lists
   every broken assertion with its numbers. */
function createCollector() {
  const failures = [];
  return {
    failures,
    ok(condition, message) { if (!condition) failures.push(message); },
  };
}

const fmt = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : String(n));

function checkToolbarOneLine(collector, label, { composer, controls }) {
  collector.ok(controls.length >= 3, `${label}: composer toolbar shows its controls (saw ${controls.length}: ${controls.map((c) => c.name).join(' | ')})`);
  for (const control of controls) {
    collector.ok(control.left >= composer.left - 0.5 && control.right <= composer.right + 0.5,
      `${label}: toolbar control "${control.name}" [${fmt(control.left)}, ${fmt(control.right)}] stays inside the composer [${fmt(composer.left)}, ${fmt(composer.right)}]`);
    collector.ok(control.scrollWidth <= control.clientWidth + 1,
      `${label}: toolbar control "${control.name}" is not clipped (scrollWidth ${control.scrollWidth} > clientWidth ${control.clientWidth})`);
  }
  controls.slice(1).forEach((control, index) => {
    const previous = controls[index];
    collector.ok(previous.right <= control.left + 0.5, `${label}: toolbar "${previous.name}" overlaps "${control.name}"`);
  });
  const middles = controls.map((c) => (c.top + c.bottom) / 2);
  if (middles.length) {
    collector.ok(Math.max(...middles) - Math.min(...middles) <= 2, `${label}: toolbar controls share one line (centers ${middles.map(fmt).join(', ')})`);
  }
}

/* Assertions 1 to 3 and 5 for one pane at one appearance. */
function checkPaneReadingLayout(collector, label, pane, { chatWidth, viewportWidth, single, fontScale, narrowFloor = true }) {
  const cap = CAP_CH[chatWidth] * pane.ch;
  const { measure, stage, composer } = pane;
  // The gutter is max(the 40px clamp, the avatar rail) per side (styles/chat-panes.css); the rail
  // shows while the composer toolbar fits, and the column's start padding is its resolved width.
  const gutter = Math.max(GUTTER_MAX_PX, pane.columnPaddingStart || 0);
  const lowerBound = Math.min(cap, stage.width - 2 * gutter) - 1;
  collector.ok(measure.width <= cap + 1, `${label}: measure ${fmt(measure.width)}px is within the ${CAP_CH[chatWidth]}ch cap ${fmt(cap)}px (ch ${fmt(pane.ch)}px, ${pane.proseFont.split(',')[0]})`);
  collector.ok(measure.width >= lowerBound, `${label}: measure ${fmt(measure.width)}px follows the pane (${fmt(stage.width)}px wide), at least min(cap ${fmt(cap)}, pane - 2 x ${fmt(gutter)}) - 1 = ${fmt(lowerBound)}px`);
  collector.ok(measure.left >= stage.left - 0.5 && measure.right <= stage.right + 0.5, `${label}: measure [${fmt(measure.left)}, ${fmt(measure.right)}] stays inside its pane [${fmt(stage.left)}, ${fmt(stage.right)}]`);
  if (composer) {
    collector.ok(Math.abs(composer.left - measure.left) <= 1, `${label}: composer start ${fmt(composer.left)} lines up with the measure start ${fmt(measure.left)} (delta ${fmt(composer.left - measure.left)})`);
    collector.ok(Math.abs(composer.right - measure.right) <= 1, `${label}: composer end ${fmt(composer.right)} lines up with the measure end ${fmt(measure.right)} (delta ${fmt(composer.right - measure.right)})`);
  }
  collector.ok(pane.threadScroll.scrollWidth <= pane.threadScroll.clientWidth + 1, `${label}: the thread scroller has no horizontal scroll (${pane.threadScroll.scrollWidth} > ${pane.threadScroll.clientWidth})`);
  if (pane.paneScroll) {
    collector.ok(pane.paneScroll.scrollWidth <= pane.paneScroll.clientWidth + 1, `${label}: the pane has no horizontal scroll (${pane.paneScroll.scrollWidth} > ${pane.paneScroll.clientWidth})`);
  }
  // Oversized content stays inside the measure: its own scroller is no wider than it.
  const inside = (item) => item.rect.left >= measure.left - 1 && item.rect.right <= measure.right + 1;
  for (const [name, items] of [['article', pane.articles], ['code block', pane.codeBlocks], ['table', pane.tables], ['tool row', pane.toolRows]]) {
    items.forEach((item, index) => collector.ok(inside(item), `${label}: ${name} ${index} [${fmt(item.rect.left)}, ${fmt(item.rect.right)}] stays inside the measure [${fmt(measure.left)}, ${fmt(measure.right)}]`));
  }
  pane.codeScrollers.forEach((item, index) => {
    collector.ok(item.clientWidth <= measure.width + 1, `${label}: code scroller ${index} clientWidth ${item.clientWidth} <= measure ${fmt(measure.width)}`);
    collector.ok(item.scrollWidth > item.clientWidth, `${label}: the 300-char code line scrolls inside its own block (scrollWidth ${item.scrollWidth} vs clientWidth ${item.clientWidth})`);
  });
  pane.tables.forEach((item, index) => {
    collector.ok(item.clientWidth <= measure.width + 1, `${label}: table scroller ${index} clientWidth ${item.clientWidth} <= measure ${fmt(measure.width)}`);
    collector.ok(item.scrollWidth > item.clientWidth, `${label}: the wide table scrolls inside its wrapper (scrollWidth ${item.scrollWidth} vs clientWidth ${item.clientWidth})`);
  });
  pane.userBubbles.forEach((item, index) => collector.ok(item.rect.width <= measure.width + 1, `${label}: user bubble ${index} (${fmt(item.rect.width)}px) never exceeds the measure ${fmt(measure.width)}`));
  pane.toolSummaries.forEach((item, index) => collector.ok(item.lines === 1, `${label}: tool row summary ${index} stays on one line (${item.lines} lines)`));
  // 5: characters-per-line sanity.
  if (single && chatWidth === 'standard' && fontScale === 'default' && viewportWidth >= 1400) {
    collector.ok(measure.width / pane.ch >= 80, `${label}: the measure holds >= 80ch (${fmt(measure.width / pane.ch)}ch)`);
  }
  if (single && narrowFloor && viewportWidth <= 760) {
    collector.ok(measure.width >= 520, `${label}: at ${viewportWidth}px wide the measure is >= 520px (${fmt(measure.width)}px)`);
  }
}

module.exports = {
  SKIP,
  withBrowser,
  frames,
  FONT_SCALE_IDS,
  CHAT_WIDTH_IDS,
  mountReadingLayout,
  setReadingAppearance,
  measureReadingLayout,
  measureComposerToolbar,
  createCollector,
  checkToolbarOneLine,
  checkPaneReadingLayout,
  fmt,
};
