/* Real index/CSS and Diagnostics render/binding modules in Chromium. No application backend. */
/* global document, window, requestAnimationFrame, innerWidth */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { SKIP, withBrowser } = require('./helpers/composer-layout-harness');
const { makeState, entry } = require('./helpers/diagnostics-overview-harness');
const ROOT = path.resolve(__dirname, '..');
const bundle = buildSync({
  stdin: { contents: `window.diagnosticsTest = {
    renderer: require('./renderer/shell/renderer-diagnostics-render-utils'),
    bindings: require('./renderer/shell/renderer-diagnostics-event-bindings')
  };`, resolveDir: ROOT }, bundle: true, write: false, platform: 'browser',
}).outputFiles[0].text;

function logs(count) {
  return Array.from({ length: count }, (_, i) => entry({
    entry_id: `warning-${i}`, event: `diagnostics.test_${i}`, sequence: i + 1,
    message: `Warning ${i}: a diagnostic operation needs attention.`,
    ts: new Date(Date.now() - (count - i) * 1000).toISOString(),
  }));
}
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

async function mount(browser, viewport) {
  const page = await browser.newPage({ viewport, bypassCSP: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => /\.m?js(\?|$)/.test(route.request().url()) ? route.abort() : route.continue());
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  await page.addScriptTag({ content: bundle });
  const state = makeState({ logs: logs(35), ui: { activeView: 'logs', logs: {} } });
  state.phasePercentiles = { loadedAt: 1, payload: { phases: {
    provider_request_start_to_first_chunk: { count: 12, p50: 100, p95: 300, p99: 900 },
    first_chunk_to_first_visible_token: { count: 12, p50: 25, p95: 100, p99: 120 },
    completion_to_terminal_persist: { count: 11, p50: 400, p95: 1500, p99: 1600 },
  }, targets: {} } };
  state.diagnosticsStatus.tool_observability = { available: true, tools: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
    `read_file_${i}`, { count: 3, error_count: 0, latency_ms: { p50: 10, p95: 20, p99: 30 } },
  ])) };
  await page.evaluate((state) => {
    document.getElementById('startupOverlay')?.remove();
    document.querySelector('.view-shell').classList.add('panel-none');
    document.querySelectorAll('.main-view').forEach((node) => {
      const active = node.id === 'logsView';
      node.classList.toggle('view-offscreen', !active);
      node.classList.toggle('active-view', active);
      node.inert = !active;
      node.setAttribute('aria-hidden', String(!active));
    });
    window.diagState = state;
    const options = { state, dom: { logList: document.getElementById('logList') } };
    window.diagRenderer = window.diagnosticsTest.renderer.createLogRenderer(options);
    window.diagBindings = window.diagnosticsTest.bindings.createLogsEventBindings({
      ...options, callbacks: { renderLogs: () => window.diagRenderer.renderLogs() },
    });
    window.diagBindings.bind();
    window.diagRenderer.renderLogs();
  }, state);
  await frames(page);
  assert.deepEqual(errors, [], 'Diagnostics modules initialize without browser errors');
  return { page, errors };
}

function measure() {
  const box = (selector) => {
    const node = document.querySelector(selector);
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height, left: rect.left, right: rect.right,
      client: node.clientHeight, scroll: node.scrollHeight, scrollTop: node.scrollTop };
  };
  return {
    stacked: document.getElementById('diagnosticsOverview').dataset.stacked,
    overview: box('#diagnosticsOverview'), body: box('#diagnosticsOverviewBody'), metrics: box('#diagnosticsMetrics'),
    runtime: box('#runtimeInventoryHeading'), performance: box('#diagnosticsPerformanceHeading'),
    issues: box('#diagnosticsIssueList'), attention: box('#diagnosticsAttention'),
    dividerHidden: document.getElementById('diagnosticsOverviewDivider').hidden,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
  };
}

test('overview layout: metrics stay visible across issue growth, widths, text sizes and themes', { skip: SKIP, timeout: 90000 }, async () => {
  await withBrowser(async (browser) => {
    const { page, errors } = await mount(browser, { width: 1455, height: 900 });
    for (const viewport of [{ width: 1455, height: 900 }, { width: 2327, height: 1300 }, { width: 700, height: 900 }, { width: 1455, height: 600 }]) {
      await page.setViewportSize(viewport);
      for (const palette of ['darkroom', 'paper']) for (const scale of [1.2, 1.3]) {
        await page.evaluate(({ palette, scale }) => {
          document.documentElement.dataset.palette = palette;
          document.documentElement.style.setProperty('--font-scale', String(scale));
        }, { palette, scale });
        await frames(page);
        const m = await page.evaluate(measure);
        const label = `${viewport.width}x${viewport.height}/${palette}/${scale}`;
        assert.equal(m.horizontalOverflow, false, label);
        if (viewport.width < 1100 || viewport.height < 700) {
          assert.equal(m.stacked, 'true', label);
          assert.equal(m.dividerHidden, true, label);
          assert.ok(m.performance.top > m.runtime.top, label);
          assert.ok(m.overview.scroll > m.overview.client, label);
        } else {
          assert.equal(m.stacked, 'false', label);
          assert.equal(m.dividerHidden, false, label);
          assert.ok(Math.abs(m.runtime.top - m.performance.top) <= 1, label);
          assert.ok(m.runtime.bottom < viewport.height && m.performance.bottom < viewport.height, label);
          assert.ok(Math.abs(m.metrics.height / (m.body.height - 12) - 0.6) < 0.01, label);
          assert.ok(m.issues.scroll > m.issues.client, label);
          assert.ok(m.attention.bottom <= m.overview.bottom + 1, label);
          await page.evaluate(() => { document.getElementById('diagnosticsIssueList').scrollTop = 500; });
          const after = await page.evaluate(measure);
          assert.equal(after.runtime.top, m.runtime.top, label);
          assert.equal(after.performance.top, m.performance.top, label);
        }
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  });
});

test('overview interactions: resize, navigation, refresh anchoring, empty and prior launch', { skip: SKIP, timeout: 90000 }, async () => {
  await withBrowser(async (browser) => {
    const { page, errors } = await mount(browser, { width: 1455, height: 900 });
    const separator = page.getByRole('separator', { name: 'Resize Runtime and Performance' });
    await separator.focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await separator.getAttribute('aria-valuenow'), '65');
    const before = await page.evaluate(measure);
    const rect = await separator.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2, rect.y + 60); await page.mouse.up();
    assert.ok((await page.evaluate(measure)).metrics.height > before.metrics.height);
    await page.keyboard.press('Home'); assert.equal(await separator.getAttribute('aria-valuenow'), '40');
    await page.keyboard.press('End'); assert.equal(await separator.getAttribute('aria-valuenow'), '75');
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await frames(page);
    assert.equal(await separator.getAttribute('aria-valuenow'), '75');
    // Expand and focus a middle entry, scroll to it, then prepend a new error through the renderer.
    const anchor = await page.evaluate(() => {
      const list = document.getElementById('diagnosticsIssueList');
      const row = list.children[8];
      const fold = row.querySelector('details'); fold.open = true;
      fold.querySelector('summary').focus({ preventScroll: true });
      list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
      return { group: row.dataset.issueGroup, top: row.getBoundingClientRect().top };
    });
    await page.evaluate((newLogs) => {
      window.diagState.logs.push(...newLogs);
      window.diagRenderer.renderLogs();
    }, logs(1).map((row) => ({ ...row, entry_id: 'new-error', event: 'new.error', level: 'ERROR' })));
    await frames(page);
    const restored = await page.evaluate((group) => {
      const row = [...document.getElementById('diagnosticsIssueList').children].find((node) => node.dataset.issueGroup === group);
      return { top: row.getBoundingClientRect().top, open: row.querySelector('details').open, focused: row.contains(document.activeElement) };
    }, anchor.group);
    assert.ok(Math.abs(restored.top - anchor.top) < 2, 'new issues preserve the visible reading anchor');
    assert.equal(restored.open, true); assert.equal(restored.focused, true);
    await page.evaluate(() => { window.diagState.logs = []; window.diagRenderer.renderLogs(); });
    await frames(page);
    const empty = await page.evaluate(measure);
    assert.equal(empty.dividerHidden, true);
    assert.equal(empty.metrics.height, empty.body.height);
    await page.evaluate((single) => { window.diagState.logs = single; window.diagRenderer.renderLogs(); }, logs(1));
    await frames(page);
    assert.equal((await page.evaluate(measure)).dividerHidden, false);
    assert.equal(await separator.getAttribute('aria-valuenow'), '75');
    await page.evaluate(() => {
      const state = window.diagState;
      state.diagnosticsSnapshot.prior_run = { ...state.diagnosticsSnapshot.active_run, run_id: 'prior' };
      state.ui.logs.selectedRunId = 'prior';
      state.logs = state.logs.map((row) => ({ ...row, run_id: 'prior' }));
      window.diagRenderer.renderLogs();
    });
    await frames(page);
    assert.match(await page.locator('#diagnosticsRuntimeInventory').innerText(), /previous launch/i);
    assert.equal(await page.locator('#diagnosticsIssueList > li').count(), 1);
    await page.evaluate(() => { window.diagBindings.dispose(); window.diagRenderer.dispose(); });
    assert.equal(await separator.count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  });
});
