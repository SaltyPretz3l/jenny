/* global document, window, getComputedStyle */
'use strict';

/* Top chrome, one row (area 1) + the window-control cluster (area 4), laid out
 * by the REAL stylesheet (index.html + styles.css) in headless Chromium with
 * the real nav / health-pill / action-button modules injected (every other
 * app script is blocked; no app, no window). jsdom cannot lay out CSS, so
 * these are the layout gates for the title bar:
 *
 *   - one 52px row at >= 1200px, the nav on a 40px second row below;
 *     --toprail-height is 0 and the content starts right under the header
 *   - nothing overlaps at 519 / 719 / 900 / 1200 / 1600, the wordmark is never
 *     under the cluster (a click on it lands on it), and the drag gutter keeps
 *     its 48px
 *   - the three window tiles are 46px each (138px), stretch to the 52px row,
 *     sit flush in the top-right corner and are untouched at <= 480px
 *   - the machine-load read-out keeps the cluster's width across ticks
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const browserPath = [
  process.env.JENNY_TEST_CHROMIUM,
  process.platform === 'win32' && 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  chromium.executablePath(),
].find((candidate) => candidate && fs.existsSync(candidate));
const SKIP = !browserPath && 'No local Chromium available; set JENNY_TEST_CHROMIUM';

const MODULES = [
  'renderer/shared/string-utils.js',
  'renderer/inventory/action-button.js',
  'renderer/inventory/badge.js',
  'renderer/shell/renderer-toprail-utils.js',
  'renderer/shell/renderer-health-pill-markup-utils.js',
  'renderer/shell/renderer-header-utils.js',
];

const WIDTHS = [519, 719, 900, 1200, 1600];

async function withBrowser(fn) {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    await fn(browser);
  } finally {
    await browser.close();
  }
}

/* The title bar as the app paints it: the nav rendered by the real rail
   controller (gear included), the health dot with an Auto chip and one unseen
   error, the palette glyph and two pinned notes. */
async function mountTitlebar(browser, { width, readout = false }) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, bypassCSP: true });
  await page.route('**/*', (route) => (/\.m?js(\?|$)/.test(route.request().url()) ? route.abort() : route.continue()));
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  await page.evaluate(() => {
    document.documentElement.dataset.palette = 'darkroom';
    document.getElementById('startupOverlay').remove();
  });
  for (const file of MODULES) await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, file), 'utf8') });
  await page.evaluate(({ withReadout }) => {
    const state = { ui: { activeView: 'chat' } };
    const rail = window.rendererTopRailUtils.createTopRailController({
      state,
      staticModel: { tabs: [
        { id: 'home', label: 'Home' }, { id: 'chat', label: 'Chat' }, { id: 'ide', label: 'Workspace' },
        { id: 'logs', label: 'Diagnostics' }, { id: 'settings', label: 'Settings' },
      ] },
      dom: {
        topRail: document.getElementById('topRail'),
        topRailTabs: document.getElementById('topRailTabs'),
        topRailIndicator: document.getElementById('topRailIndicator'),
      },
      callbacks: {},
    });
    rail.setTopRailVisible(true);
    document.getElementById('titlebarPalettePill').classList.remove('hidden');
    document.getElementById('workbenchHealthPillSlot').innerHTML = window.rendererHealthPillMarkupUtils.buildPillMarkup(
      { tone: 'success', label: 'Ready' },
      { runMode: 'auto', unseenErrorCount: 1 },
    );
    const pins = document.getElementById('pinnedNoteTabs');
    pins.hidden = false;
    pins.innerHTML = '<span class="palette-pill pin-tab"><span class="pin-tab__title">Band rules</span></span>'
      + '<span class="palette-pill pin-tab"><span class="pin-tab__title">G3 checklist</span></span>';
    if (withReadout) {
      state.ui.appearance = { titlebarLoad: true };
      state.systemStats = { cpuPercent: 21, ramPercent: 40, gpuMemory: { available: true, usedMb: 13926, totalMb: 16282, utilAvailable: true, utilPercent: 93 } };
      window.__header = window.rendererHeaderUtils.createHeaderController({
        state, dom: { metricList: document.getElementById('metricList') }, documentRef: document,
      });
      window.__headerState = state;
      window.__header.renderHeader();
    }
  }, { withReadout: readout });
  return page;
}

function measure(page) {
  return page.evaluate(() => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const visible = (node) => node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const header = document.querySelector('.titlebar');
    const brand = document.getElementById('homeNavButton');
    const brandBox = box(brand);
    const hit = document.elementFromPoint(brandBox.left + brandBox.width / 2, brandBox.top + brandBox.height / 2);
    const cluster = [...document.querySelectorAll('.titlebar-status > *')].filter(visible);
    const clusterItems = cluster.flatMap((node) => (node.matches('.workbench-health-pill-slot')
      ? [...node.children].filter(visible) : [node]));
    return {
      header: box(header),
      toprailHeight: getComputedStyle(document.documentElement).getPropertyValue('--toprail-height').trim(),
      workspaceTop: document.getElementById('workspace').getBoundingClientRect().top,
      brand: brandBox,
      brandHit: hit === brand || brand.contains(hit),
      tabs: [...document.querySelectorAll('#topRailTabs .toprail-tab')].filter(visible).map((node) => ({ name: node.textContent.trim(), ...box(node) })),
      gutter: box(document.querySelector('.titlebar-center')),
      status: box(document.querySelector('.titlebar-status')),
      clusterItems: clusterItems.map((node) => ({ name: node.id || node.className, ...box(node) })),
      controls: box(document.querySelector('.window-controls')),
      tiles: [...document.querySelectorAll('.window-controls .window-button')].map(box),
      viewport: window.innerWidth,
    };
  });
}

function assertNoOverlap(boxes, label) {
  const sorted = [...boxes].sort((a, b) => a.left - b.left);
  sorted.slice(1).forEach((item, index) => {
    const previous = sorted[index];
    assert.ok(previous.right <= item.left + 0.5, `${label}: "${previous.name}" [${previous.left}, ${previous.right}] overlaps "${item.name}" [${item.left}, ${item.right}]`);
  });
}

test('one 52px row at >= 1200px, a 40px nav row below; the rail height is 0 and content starts under the header', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    for (const width of WIDTHS) {
      const page = await mountTitlebar(browser, { width });
      const m = await measure(page);
      const expected = width >= 1200 ? 52 : 92;
      assert.equal(m.toprailHeight, '0px', `${width}: --toprail-height resolves to 0`);
      assert.equal(m.header.top, 0);
      assert.equal(m.header.height, expected, `${width}: header height`);
      assert.equal(m.workspaceTop, expected, `${width}: content starts right under the header`);
      for (const tab of m.tabs) {
        if (width >= 1200) assert.ok(tab.bottom <= 52, `${width}: "${tab.name}" sits in the one row`);
        else assert.ok(tab.top >= 52 && tab.bottom <= 92, `${width}: "${tab.name}" sits in the second row`);
      }
      assert.deepEqual(m.tabs.map((tab) => tab.name), ['Home', 'Chat', 'Workspace', 'Diagnostics']);
      await page.close();
    }
  });
});

test('no overlap at 519 / 719 / 900 / 1200 / 1600; the wordmark is never under the cluster; the gutter keeps 48px', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    for (const width of WIDTHS) {
      const page = await mountTitlebar(browser, { width });
      const m = await measure(page);
      const label = `${width}px`;
      assert.ok(m.brandHit, `${label}: a click on the wordmark lands on the wordmark`);
      const rowOne = [
        { name: 'wordmark', ...m.brand },
        ...(width >= 1200 ? m.tabs : []),
        { name: 'gutter', ...m.gutter },
        ...m.clusterItems,
        { name: 'window controls', ...m.controls },
      ];
      assertNoOverlap(rowOne, label);
      for (const item of rowOne) {
        assert.ok(item.left >= -0.5 && item.right <= m.viewport + 0.5, `${label}: "${item.name}" [${item.left}, ${item.right}] stays inside the window`);
      }
      assert.ok(m.gutter.width >= 48 - 0.5, `${label}: drag gutter keeps 48px (got ${m.gutter.width})`);
      assert.ok(m.clusterItems.some((item) => item.name === 'titlebarSettingsSlot'), `${label}: the gear is in the cluster`);
      await page.close();
    }
  });
});

test('three 46px window tiles stretch to the 52px row, flush top-right, at every width and at <= 480px', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    for (const width of [...WIDTHS, 480, 420]) {
      const page = await mountTitlebar(browser, { width });
      const m = await measure(page);
      assert.equal(m.tiles.length, 3, `${width}: three tiles`);
      assert.equal(m.controls.width, 138, `${width}: cluster width`);
      assert.equal(m.controls.height, 52, `${width}: tiles stretch to the row`);
      assert.equal(m.controls.top, 0, `${width}: flush to the top`);
      assert.equal(m.controls.right, m.viewport, `${width}: flush to the right`);
      for (const tile of m.tiles) assert.equal(tile.width, 46, `${width}: tile width`);
      assert.ok(m.brandHit, `${width}: wordmark stays clickable`);
      await page.close();
    }
  });
});

test('the machine-load read-out keeps the cluster width constant across ticks', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountTitlebar(browser, { width: 1600, readout: true });
    const widths = [];
    const samples = [
      { utilPercent: 93, usedMb: 13926 },
      { utilPercent: 4, usedMb: 812 },
      { utilPercent: 100, usedMb: 15990 },
      { utilPercent: 0, usedMb: 0 },
    ];
    for (const sample of samples) {
      await page.evaluate((next) => {
        const stats = window.__headerState.systemStats;
        stats.gpuMemory = { ...stats.gpuMemory, ...next };
        window.__header.renderSystemLoad();
      }, sample);
      const m = await measure(page);
      widths.push({ status: m.status.width, left: m.status.left });
    }
    const readout = await page.evaluate(() => document.getElementById('metricList').textContent.replace(/\s+/g, ' ').trim());
    assert.match(readout, /GPU 0%\s*VRAM 0\.0 GB/);
    assert.ok(widths.every((entry) => Math.abs(entry.status - widths[0].status) < 0.5 && Math.abs(entry.left - widths[0].left) < 0.5),
      `cluster box is still across ticks: ${JSON.stringify(widths)}`);
    await page.close();
  });
});
