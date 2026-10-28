/* global document, getComputedStyle, requestAnimationFrame */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, withBrowser, mountComposer } = require('./helpers/composer-layout-harness');

// Row 63: the + button replaced the paperclip and the Commands pill; it stays a square icon button.
test('the + button keeps its glyph inside a square button at normal and large text sizes', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    for (const viewportWidth of [1455, 2327, 680]) {
      for (const paneWidth of (viewportWidth < 720 ? [420] : [1200, 420])) {
        for (const scale of [1.2, 1.3]) {
          const page = await mountComposer(browser, {
            paneWidth, waitCompact: paneWidth === 420, viewport: { width: viewportWidth, height: 914 },
          });
          await page.evaluate((value) => document.documentElement.style.setProperty('--font-scale', value), String(scale));
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const geometry = await page.evaluate(() => {
            const button = document.getElementById('composerAttachShortcut');
            const box = (node) => {
              const { left, right, top, bottom } = node.getBoundingClientRect();
              return { left, right, top, bottom };
            };
            return {
              button: box(button), label: button.getAttribute('aria-label'),
              compact: button.closest('.composer').hasAttribute('data-toolbar-compact'),
              children: [...button.children].filter((node) => getComputedStyle(node).display !== 'none').map(box),
            };
          });
          const label = `${viewportWidth}px viewport, ${paneWidth}px pane, scale ${scale}`;
          assert.equal(geometry.label, 'Add files, commands and skills');
          assert.equal(geometry.children.length, 1, label);
          assert.ok(Math.abs((geometry.button.right - geometry.button.left) - (geometry.button.bottom - geometry.button.top)) <= 1,
            `${label}: the + button stays square: ${JSON.stringify(geometry.button)}`);
          if (paneWidth === 1200 && scale === 1.2) assert.equal(geometry.compact, false, label);
          if (paneWidth === 420) assert.equal(geometry.compact, true, label);
          for (const child of geometry.children) {
            assert.ok(child.left >= geometry.button.left && child.right <= geometry.button.right
              && child.top >= geometry.button.top && child.bottom <= geometry.button.bottom,
            `${label}: content stays inside the button: ${JSON.stringify(geometry)}`);
          }
          await page.close();
        }
      }
    }
  });
});
