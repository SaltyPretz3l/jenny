/* global document, window, getComputedStyle */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const browserPath = [
  process.env.JENNY_TEST_CHROMIUM,
  process.platform === 'win32' && 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  chromium.executablePath(),
].find((candidate) => candidate && fs.existsSync(candidate));
const SKIP = !browserPath && 'No local Chromium available; set JENNY_TEST_CHROMIUM';

const MODULES = [
  'renderer/shared/string-utils.js',
  // renderer-settings-support.js reads its tool rows' copy from the descriptors at load (index.html order).
  'renderer/shell/renderer-settings-field-descriptors.js',
  'renderer/shell/renderer-settings-field-copy.js',
  'renderer/shell/renderer-settings-support.js',
  'renderer/inventory/chip.js',
  'renderer/inventory/action-button.js',
  'renderer/chat/renderer-composer-v2-state.js',
  'renderer/chat/renderer-composer-v2-render.js',
  'renderer/chat/renderer-turn-pause-interaction.js',
  'renderer/chat/renderer-composer-toolbar-fit.js',
  'renderer/chat/renderer-pane-composer-rail.js',
];

function populateSettingsGroup(mode) {
  const group = document.querySelector('.composer-settings-group');
  const composer = group.closest('.composer');
  const chip = window.inventoryChip;
  composer.querySelector('.composer-project-pill-slot').innerHTML = chip({ id: 'composer-project', label: 'jenny-ui-test', hasPopup: true, className: 'composer-project-pill', title: 'This chat is in jenny-ui-test' });
  window.rendererComposerV2Render.createRunModeSwitcherRenderer({ slot: group.querySelector('.composer-run-mode-slot'), getRunMode: () => mode });
  group.querySelector('.composer-model-pill-slot').insertAdjacentHTML('afterbegin', chip({ id: 'composer-model', label: 'Ornith-1.5-9B-GGUF · Q4_K_M', hasPopup: true, className: 'composer-model-pill' })
    .replace('<span class="inv-chip-label">', '<span class="composer-model-pill-dot status-dot status-dot--ok"></span><span class="inv-chip-label">'));
  composer.querySelector('.composer-toggle-slot').innerHTML = chip({ id: 'composer-tools', label: 'Tools', count: '4/4', hasPopup: true, className: 'composer-tools-chip' })
    + '<div class="inv-popover composer-tools-popover" data-inv-popover="composer-tools" hidden><div class="composer-tools-popover-header">Workspace tools</div></div>';
  const ring = chip({ id: 'composer-context-ring', label: '', hasPopup: true, className: 'inv-context-ring' });
  const close = ring.lastIndexOf('</');
  group.querySelector('.composer-context-usage-slot').innerHTML = '<div class="inv-context-usage inv-context-usage--ring">'
    + ring.slice(0, ring.indexOf('>')) + ' style="--usage-ratio:0.64"' + ring.slice(ring.indexOf('>'), close)
    + '<span class="inv-usage-bar" aria-hidden="true"><span class="inv-usage-bar-fill"></span></span>'
    + '<span class="inv-chip-label inv-context-ring-percent">64%</span>' + ring.slice(close) + '</div>';
}

function catalog(lang) {
  if (lang === 'en') return {};
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${lang}.json`), 'utf8'));
}

async function withBrowser(fn) {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    await fn(browser);
  } finally {
    await browser.close();
  }
}

/* What the render pipeline does when a reply starts: Stop and Pause show,
   Send becomes the queue button. */
function startStreaming() {
  const stop = document.getElementById('stopStreamButton');
  const pause = window.rendererTurnPauseInteraction.mountTurnPauseButton({ anchor: stop, actionButton: window.inventoryActionButton });
  stop.classList.remove('hidden');
  pause.classList.remove('hidden');
  const send = document.getElementById('sendButton');
  send.textContent = 'Queue — runs in Auto';
  send.setAttribute('aria-label', 'Queue follow-up prompt — runs in Auto');
  send.classList.add('composer-send-queue');
}

const isCompact = () => document.querySelector('#composerWrap .composer').hasAttribute('data-toolbar-compact');

/* One composer in pane 0 of a two-pane view, pane 0 `paneWidth` px wide. */
async function mountComposer(browser, { paneWidth, lang = 'en', palette = 'darkroom', streaming = false, mode = 'auto', projectTag = '', waitCompact = true, hostSelector = '#chatPane0', viewport = { width: 1584, height: 914 } }) {
  // The app's CSP forbids inline script; the modules are injected as text.
  const page = await browser.newPage({ viewport, bypassCSP: true });
  await page.route('**/*', (route) => (/\.m?js(\?|$)/.test(route.request().url()) ? route.abort() : route.continue()));
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  await page.evaluate(({ strings, palette: name }) => {
    window.jennyI18n = {
      t: (key, fallback, params) => String(Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : fallback)
        .replace(/\{(\w+)\}/g, (match, id) => (params && Object.prototype.hasOwnProperty.call(params, id) ? String(params[id]) : match)),
    };
    document.documentElement.dataset.palette = name;
    document.getElementById('startupOverlay').remove();
  }, { strings: catalog(lang), palette });
  for (const file of MODULES) await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, file), 'utf8') });
  await page.evaluate(`window.__startStreaming = ${startStreaming}; window.__populateSettingsGroup = ${populateSettingsGroup}`);
  await page.evaluate(({ paneWidth: width, streaming: live, mode: runMode, projectTag: tag, hostSelector }) => {
    const view = document.getElementById('chatView');
    view.dataset.paneCount = '2';
    view.style.gridTemplateColumns = `${width}px 10px minmax(0, 1fr) auto`;
    document.getElementById('chatPaneResizer').classList.remove('hidden');
    const pane = document.getElementById('chatPane0');
    if (tag) {
      const kicker = pane.querySelector('.chat-pane-kicker');
      kicker.hidden = false;
      kicker.innerHTML = '<span class="chat-pane-kicker-title">Use the file write tool to create plan.md</span>'
        + `<span class="chat-pane-kicker-project"> · ${tag}</span>`
        + '<button type="button" class="workspace-rail-close-button chat-pane-close">x</button>';
    }
    const group = pane.querySelector('.composer-settings-group');
    const chip = window.inventoryChip;
    window.__populateSettingsGroup(runMode);
    if (hostSelector === '#ideChatDockBody') {
      const dock = document.getElementById('ideChatDockBody');
      document.body.appendChild(dock);
      // Raised above the sidebar it now overlaps, so hit-tests reach the dock.
      Object.assign(dock.style, { position: 'fixed', insetInlineStart: '0', insetBlockStart: '0', inlineSize: `${width}px`, blockSize: '800px', zIndex: '10' });
      dock.style.setProperty('--ide-chat-dock-width', `${width}px`);
      dock.appendChild(document.getElementById('composerWrap'));
      view.style.display = 'none';
    }
    if (live) window.__startStreaming();
    window.__settings = window.rendererPaneComposerRail.createComposerSettingsFit({ groupEl: group, paneRoot: pane, getRunMode: () => runMode, deps: { chip } });
  }, { paneWidth, streaming, mode, projectTag, hostSelector });
  if (waitCompact) await page.waitForFunction(isCompact);
  return page;
}

function measureButtons(page, hostSelector = '#chatPane0') {
  return page.evaluate((hostSelector) => {
    const pane = document.querySelector(hostSelector).getBoundingClientRect();
    const composer = document.querySelector('#composerWrap .composer').getBoundingClientRect();
    const toolbar = document.querySelector('#composerWrap .composer-toolbar');
    const buttons = [...toolbar.querySelectorAll('button')]
      .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'
        && !node.closest('.composer-settings-group'))
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { name: node.getAttribute('aria-label') || node.className, left: box.left, right: box.right, top: box.top,
          bottom: box.bottom, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
      })
      .sort((a, b) => a.left - b.left);
    return { pane: { left: pane.left, right: pane.right }, composer: { left: composer.left, right: composer.right }, buttons };
  }, hostSelector);
}

/* The row's real sizes against the composer's two size tokens: every primary
   control (Stop, Pause, Send/Queue) is one height, every secondary control
   (icon buttons, chips, rings, the collapsed summary pill) another. A control
   that is not rendered now (hidden, or not mounted) reads null. */
function measureControlSizes(page) {
  return page.evaluate(() => {
    const composer = document.querySelector('#composerWrap .composer');
    const token = (name) => Number.parseFloat(getComputedStyle(composer).getPropertyValue(name));
    const box = (selector) => {
      const node = document.querySelector(selector);
      const rect = node && node.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null;
    };
    const ring = document.querySelector('#composerWrap .inv-context-ring');
    const ringStyle = getComputedStyle(ring);
    return {
      primaryToken: token('--composer-primary-control-size'),
      secondaryToken: token('--composer-secondary-control-size'),
      primary: { stop: box('#stopStreamButton'), pause: box('.composer-pause-button'), send: box('#sendButton') },
      secondary: {
        attach: box('#composerAttachShortcut'), commands: box('#composerTerminalShortcut'), chat: box('#composerToolToggleSlot .inv-chip'),
        runMode: box('.composer-run-mode-chip'), model: box('.composer-model-pill'), ring: box('#composerWrap .inv-context-ring'),
        summary: box('.composer-settings-summary'),
      },
      ring: { background: ringStyle.backgroundColor, border: ringStyle.borderTopColor },
    };
  });
}

/* Asserts every rendered control against its token; returns the names it saw. */
function assertControlSizes(sizes, { primary, secondary }, label) {
  assert.equal(sizes.primaryToken, primary, `${label}: primary token`);
  assert.equal(sizes.secondaryToken, secondary, `${label}: secondary token`);
  const seen = [];
  for (const [name, box] of Object.entries(sizes.primary)) {
    if (!box) continue;
    seen.push(name);
    assert.equal(box.height, primary, `${label}: ${name} is ${primary}px tall`);
    // Send is a circle unless it is the queue pill; Stop and Pause always are.
    if (name !== 'send') assert.equal(box.width, primary, `${label}: ${name} is a ${primary}px circle`);
  }
  for (const [name, box] of Object.entries(sizes.secondary)) {
    if (!box) continue;
    seen.push(name);
    assert.equal(box.height, secondary, `${label}: ${name} is ${secondary}px tall`);
  }
  if (sizes.secondary.attach) assert.equal(sizes.secondary.attach.width, secondary, `${label}: an icon button is a ${secondary}px circle`);
  assert.equal(sizes.ring.background, 'rgba(0, 0, 0, 0)', `${label}: the ring is transparent`);
  assert.equal(sizes.ring.border, 'rgba(0, 0, 0, 0)', `${label}: the ring is borderless`);
  return seen;
}

function assertOneCleanLine({ pane, composer, buttons }, label, expectedControls = ['Attach', 'Commands', 'Tools', 'Composer settings', 'Pause', 'Stop', 'Queue']) {
  assert.equal(buttons.length, expectedControls.length, `${label}: expected controls (${buttons.map((b) => b.name).join(' | ')})`);
  for (const name of expectedControls) assert.ok(buttons.some((button) => button.name.toLowerCase().includes(name.toLowerCase())), `${label}: ${name} is visible`);
  for (const button of buttons) {
    assert.ok(button.left >= Math.max(pane.left, composer.left) - 0.5 && button.right <= Math.min(pane.right, composer.right) + 0.5,
      `${label}: "${button.name}" [${button.left}, ${button.right}] stays inside the pane [${pane.left}, ${pane.right}]`);
    assert.ok(button.scrollWidth <= button.clientWidth + 1,
      `${label}: "${button.name}" is not clipped (scrollWidth ${button.scrollWidth} > clientWidth ${button.clientWidth})`);
  }
  buttons.slice(1).forEach((button, index) => {
    const previous = buttons[index];
    assert.ok(previous.right <= button.left + 0.5, `${label}: "${previous.name}" overlaps "${button.name}"`);
  });
  const middles = buttons.map((button) => (button.top + button.bottom) / 2);
  assert.ok(Math.max(...middles) - Math.min(...middles) <= 2, `${label}: one line (${middles.join(', ')})`);
}

module.exports = { SKIP, withBrowser, mountComposer, startStreaming, measureButtons, measureControlSizes, assertControlSizes, assertOneCleanLine, isCompact };
