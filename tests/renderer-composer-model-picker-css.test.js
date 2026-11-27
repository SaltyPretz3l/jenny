/* global document, window, getComputedStyle */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { SKIP } = require('./helpers/composer-layout-harness');
const { withSharedBrowser, closeSharedBrowser } = require('./helpers/layout-shared-browser');

test.after(closeSharedBrowser);

const repoRoot = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function findRuleBody(css, selector) {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorList = match[1].replace(/\/\*[\s\S]*?\*\//g, '');
    if (selectorList.split(',').map((item) => item.trim()).includes(selector)) return match[2];
  }
  return '';
}

test('composer model carrier shells remain hidden beneath author styles', () => {
  const css = readRepoFile('styles/chat-composer-shell-v2.css');

  assert.match(
    findRuleBody(css, '.composer-model-popover .composer-select-shell[hidden]'),
    /display:\s*none;/
  );
  assert.match(findRuleBody(css, '.composer-model-carriers[hidden]'), /display:\s*none;/);
  assert.doesNotMatch(
    css,
    /\.composer-model-popover \.composer-select-shell\s*\{[^}]*display:\s*flex;/s
  );
  assert.doesNotMatch(css, /\.composer-model-popover-source/);
});

test('composer model pill labels truncate within the rail', () => {
  const css = readRepoFile('styles/chat-composer-shell-v2.css');
  const body = findRuleBody(css, '.composer-model-pill .inv-chip-label');

  assert.match(body, /max-width:\s*[^;]+;/);
  assert.match(body, /text-overflow:\s*ellipsis;/);
});

// Seen live: seven effort choices beside the label ran past the popover and were cut off.
test('the thinking row wraps so no effort choice is cut off', () => {
  const css = readRepoFile('styles/chat-composer-shell-v2.css');

  assert.match(findRuleBody(css, '.composer-model-picker-thinking'), /flex-wrap:\s*wrap;/);
  const segments = findRuleBody(css, '.composer-model-picker-segments');
  assert.match(segments, /flex-wrap:\s*wrap;/);
  assert.match(segments, /max-width:\s*100%;/);
  assert.match(findRuleBody(css, '.composer-model-picker-segment'), /white-space:\s*nowrap;/);
  assert.match(findRuleBody(css, '.composer-model-picker-segments:has(> :nth-child(6))'), /flex:\s*1 1 100%;/);
  assert.match(
    findRuleBody(css, '.composer-model-picker-segments:has(> :nth-child(7)) .composer-model-picker-segment'),
    /padding-inline:\s*var\(--space-2\);/,
  );
});

test('composer model popover contains the picker before hidden select carriers', () => {
  const html = readRepoFile('index.html');
  const dom = new JSDOM(html);
  const popover = dom.window.document.getElementById('composerModelPopover');
  const children = Array.from(popover.children);

  assert.ok(children[0].matches('div.composer-model-picker[data-composer-model-picker]'));
  assert.ok(children[1].matches('div.composer-model-carriers[hidden]'));
  assert.ok(children[1].querySelector('#composerModelSelect'));
  assert.ok(children[1].querySelector('#composerEffortSelect'));
  for (const retired of [
    'composerModelSource',
    'composerEffortSource',
    'composer-model-popover-source',
  ]) {
    assert.doesNotMatch(html, new RegExp(retired));
  }

  dom.window.close();
});

/* The real stylesheets in headless Chromium: the open model menu in the composer, filled like the picker fills it
 * (search, a list with team headings and their notes, a seven-step thinking ladder, the footer). */
async function openModelMenu(browser, { width, height }) {
  const page = await browser.newPage({ viewport: { width, height }, bypassCSP: true });
  await page.route('**/*', (route) => (/\.m?js(\?|$)/.test(route.request().url()) ? route.abort() : route.continue()));
  await page.goto(require('node:url').pathToFileURL(path.join(repoRoot, 'index.html')).href);
  for (const file of ['renderer/shared/string-utils.js', 'renderer/inventory/chip.js']) {
    await page.addScriptTag({ content: readRepoFile(file) });
  }
  await page.evaluate(() => {
    document.getElementById('startupOverlay')?.remove();
    document.documentElement.dataset.palette = 'darkroom';
    document.getElementById('composerModelPillSlot').insertAdjacentHTML('afterbegin',
      window.inventoryChip({ id: 'composer-model', label: 'Qwen3.8-27B', hasPopup: true, className: 'composer-model-pill' }));
    const option = (name) => '<button type="button" class="composer-model-picker-option"><span class="composer-model-picker-name">'
      + `<span class="composer-model-picker-family">${name}</span><span class="composer-model-picker-tag"> \u00b7 Q4_K_M</span></span></button>`;
    const group = (title, count) => `<div class="composer-model-picker-group">${title}</div>`
      + '<div class="composer-model-picker-group-note">The host and the answering PC can read your prompts, so keep private work on your own models.</div>'
      + Array.from({ length: count }, (_, index) => option(`${title} ${index}`)).join('');
    const efforts = ['Default', 'Off', 'Minimal', 'Low', 'Medium', 'High', 'Max']
      .map((name) => `<button type="button" class="composer-model-picker-segment">${name}</button>`).join('');
    document.querySelector('[data-composer-model-picker]').innerHTML = '<div class="composer-model-picker-search">'
      + '<input type="search" id="probeSearch" class="composer-model-picker-search-field" placeholder="Search models"></div>'
      + `<div class="composer-model-picker-list" role="listbox">${option('Default')}${group('On this PC', 8)}${group('From your teams', 6)}${group('Cloud', 6)}</div>`
      + `<div class="composer-model-picker-thinking"><span class="composer-model-picker-thinking-label">Thinking</span><div class="composer-model-picker-segments">${efforts}</div></div>`
      + '<div class="inv-popover-footer">Applies to this chat. Defaults live in Settings.</div>';
    document.getElementById('composerModelPopover').hidden = false;
  });
  return page;
}

const measureModelMenu = (page) => page.evaluate(() => {
  const top = (node) => node.getBoundingClientRect().top;
  const list = document.querySelector('.composer-model-picker-list');
  return {
    railBottom: document.querySelector('.titlebar').getBoundingClientRect().bottom,
    searchTop: top(document.getElementById('probeSearch')),
    popoverTop: top(document.getElementById('composerModelPopover')),
    listHeight: list.getBoundingClientRect().height,
    listCap: Number.parseFloat(getComputedStyle(list).maxHeight),
    listScrolls: list.scrollHeight > list.clientHeight,
    footerBottom: document.querySelector('#composerModelPopover .inv-popover-footer').getBoundingClientRect().bottom,
    popoverBottom: document.getElementById('composerModelPopover').getBoundingClientRect().bottom,
  };
});

// Seen live (2026-11-25, 1024 by 720): the menu's search field sat under the top rail.
test('the model menu stays below the top rail and its list scrolls in what is left', { skip: SKIP }, async () => {
  await withSharedBrowser(async (browser) => {
    for (const height of [720, 600]) {
      const page = await openModelMenu(browser, { width: 1024, height });
      const m = await measureModelMenu(page);
      assert.ok(m.popoverTop >= m.railBottom, `${height}px tall: the menu top (${m.popoverTop}) is below the top rail (${m.railBottom})`);
      assert.ok(m.searchTop >= m.railBottom, `${height}px tall: the search field (${m.searchTop}) is below the top rail (${m.railBottom})`);
      assert.ok(m.listScrolls, `${height}px tall: the list scrolls inside the menu`);
      assert.ok(m.footerBottom <= m.popoverBottom, `${height}px tall: the footer stays inside the menu`);
    }
  });
});

test('a tall window leaves the model menu as it was: the list keeps its 320px cap', { skip: SKIP }, async () => {
  await withSharedBrowser(async (browser) => {
    const page = await openModelMenu(browser, { width: 1024, height: 1400 });
    const m = await measureModelMenu(page);
    assert.equal(m.listCap, 320);
    assert.ok(m.listHeight > 300 && m.listHeight <= m.listCap, `the list is ${m.listHeight}px tall, not squeezed`);
    assert.ok(m.searchTop >= m.railBottom);
  });
});
