/* global document, window */
'use strict';

// new-test-file: no existing test lays the Team conversation bar out in a browser; this one drives the real
// stylesheets (index.html and the four team sheets) in headless Chromium through the shared layout harness.

/* Live run 2026-11-25: at about 800 px the Team bar's model pill showed only its status dot. In a narrow bar the
 * Tools chip gives way first (its word hides, its accessible name stays), so the pill keeps a readable name and
 * Send stays inside the box. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SKIP } = require('./helpers/composer-layout-harness');
const { withSharedBrowser, closeSharedBrowser } = require('./helpers/layout-shared-browser');

test.after(closeSharedBrowser);

const ROOT = path.resolve(__dirname, '..');
const TEAM_SHEETS = ['team-settings.css', 'team-tab.css', 'team-chat.css', 'team-projects.css'];
const MODEL = 'Qwen3.8-27B-Instruct-Q6_K';

async function mountBar(browser, width) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, bypassCSP: true });
  await page.route('**/*', (route) => (/\.m?js(\?|$)/.test(route.request().url()) ? route.abort() : route.continue()));
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  for (const sheet of TEAM_SHEETS) await page.addStyleTag({ url: pathToFileURL(path.join(ROOT, 'styles', sheet)).href });
  for (const file of ['renderer/shared/string-utils.js', 'renderer/inventory/chip.js', 'renderer/inventory/action-button.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, file), 'utf8') });
  }
  await page.evaluate(({ barWidth, model }) => {
    document.getElementById('startupOverlay')?.remove();
    document.documentElement.dataset.palette = 'darkroom';
    const svg = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h6M3 11.5h1"/></svg>';
    const icon = (label) => window.inventoryActionButton({ plain: true, className: 'team-icon-btn', ariaLabel: label, title: label, trustedHtml: svg });
    const tools = '<span class="team-conv-ctl team-conv-ctl--tools">' + window.inventoryChip({
      id: 'team-tools', label: 'Tools', iconHtml: svg, hasPopup: true, title: 'Tools for this conversation',
      ariaLabel: 'Tools for this conversation: 4 of 4 on', className: 'composer-tools-chip',
    }) + '</span>';
    const pill = '<span class="team-conv-ctl team-conv-ctl--model">' + window.inventoryChip({
      id: 'team-model', label: model, hasPopup: true, className: 'composer-model-pill',
      iconHtml: '<span class="composer-model-pill-dot status-dot status-dot--ok" aria-hidden="true"></span>',
    }) + '</span>';
    const hint = '<span class="team-composer__hint" data-hint="send">Markdown · Enter to send</span>';
    const send = window.inventoryActionButton({ label: 'Send', variant: 'primary', size: 'sm', dataset: { 'project-action': 'send' } });
    const host = document.createElement('div');
    host.id = 'barHost';
    host.style.cssText = `position:fixed;inset-inline-start:10px;inset-block-start:200px;inline-size:${barWidth}px;display:flex;flex-direction:column`;
    host.innerHTML = '<div class="team-conv team-conv--channel"><div class="team-conv__box"><div class="team-composer-root"><div class="team-composer">'
      + '<div class="team-composer__field"><textarea class="team-composer__input"></textarea></div>'
      + '<div class="team-composer__bar"><div data-conv-box="left">' + icon('Code block') + icon('Insert a project file') + icon('Attach files') + icon('Dictate')
      + tools + hint + pill + '</div><div data-conv-box="bar">' + send + '</div></div></div></div></div></div>';
    document.body.appendChild(host);
  }, { barWidth: width, model: MODEL });
  return page;
}

const measureBar = (page) => page.evaluate(() => {
  const box = (selector) => {
    const rect = document.querySelector(`#barHost ${selector}`).getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  };
  const word = document.querySelector('#barHost .composer-tools-chip .inv-chip-label');
  return {
    shell: box('.team-composer'),
    label: box('.composer-model-pill .inv-chip-label'),
    send: box('[data-project-action="send"]'),
    toolsWord: word.getBoundingClientRect().width,
    toolsName: document.querySelector('#barHost .composer-tools-chip').getAttribute('aria-label'),
  };
});

for (const width of [300, 360, 420]) {
  test(`a ${width}px Team bar keeps a readable model name and Send inside the box`, { skip: SKIP }, async () => {
    await withSharedBrowser(async (browser) => {
      const m = await measureBar(await mountBar(browser, width));
      assert.ok(m.label.width >= 30, `the model name is ${m.label.width}px wide`);
      assert.ok(m.send.right <= m.shell.right + 0.5, `Send ends at ${m.send.right}, the box at ${m.shell.right}`);
      if (width <= 360) assert.equal(m.toolsWord, 0, 'the Tools word gives way first');
      assert.ok(m.toolsName, 'the Tools chip keeps its accessible name');
    });
  });
}

for (const width of [540, 700]) {
  test(`a ${width}px Team bar changes nothing: the Tools chip still shows its word`, { skip: SKIP }, async () => {
    await withSharedBrowser(async (browser) => {
      const m = await measureBar(await mountBar(browser, width));
      assert.ok(m.toolsWord > 0, 'the Tools word shows');
      assert.ok(m.label.width >= 150, `the model name is ${m.label.width}px wide`);
      assert.ok(m.send.right <= m.shell.right + 0.5);
    });
  });
}
