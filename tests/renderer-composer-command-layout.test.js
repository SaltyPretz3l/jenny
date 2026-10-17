/* global document, getComputedStyle, requestAnimationFrame */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, withBrowser, mountComposer } = require('./helpers/composer-layout-harness');

test('Commands glyph and label stay inside their button at normal and large text sizes', { skip: SKIP }, async () => {
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
            const button = document.getElementById('composerTerminalShortcut');
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
          assert.equal(geometry.label, 'Commands');
          assert.equal(geometry.children.length, geometry.compact ? 1 : 2, label);
          if (paneWidth === 1200 && scale === 1.2) assert.equal(geometry.compact, false, label);
          if (paneWidth === 420) assert.equal(geometry.compact, true, label);
          for (const child of geometry.children) {
            assert.ok(child.left >= geometry.button.left && child.right <= geometry.button.right
              && child.top >= geometry.button.top && child.bottom <= geometry.button.bottom,
            `${label}: content stays inside the button: ${JSON.stringify(geometry)}`);
          }
          if (geometry.children.length === 2) {
            const [glyph, text] = geometry.children;
            assert.ok(glyph.right <= text.left, `${label}: glyph precedes label without overlap`);
            assert.ok(Math.abs((glyph.top + glyph.bottom) - (text.top + text.bottom)) < 2, `${label}: contents share a row`);
          }
          await page.close();
        }
      }
    }
  });
});
