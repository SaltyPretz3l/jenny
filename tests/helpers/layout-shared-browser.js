'use strict';

/* One headless Chromium per test file, shared by its cells. Launching a browser is the slowest part of a
 * layout cell (a process start, slower still on a loaded Windows machine); a page (with its own context)
 * is cheap and carries no state from the cell before it. Every cell still builds its own fresh page.
 *
 * Use `withSharedBrowser(fn)` where a cell used to call `withBrowser(fn)`, and register
 * `test.after(closeSharedBrowser)` once in the file so the browser exits with the file. A browser that
 * crashed or was closed is relaunched on the next call. */

const { chromium } = require('playwright-core');
const { browserPath } = require('./composer-layout-harness');

let launching = null;

function sharedBrowser() {
  if (launching) {
    return launching.then((browser) => (browser.isConnected() ? browser : relaunch()));
  }
  return relaunch();
}

function relaunch() {
  launching = chromium.launch({ executablePath: browserPath, headless: true });
  return launching;
}

/* Runs one cell on the shared browser and closes every page context the cell opened, also when it threw,
   so a failed cell leaves nothing behind for the next one. */
async function withSharedBrowser(fn) {
  const browser = await sharedBrowser();
  const before = new Set(browser.contexts());
  try {
    return await fn(browser);
  } finally {
    for (const context of browser.contexts()) {
      if (!before.has(context)) await context.close().catch(() => {});
    }
  }
}

async function closeSharedBrowser() {
  if (!launching) return;
  const pending = launching;
  launching = null;
  try {
    await (await pending).close();
  } catch (_error) {
    /* a browser that is already gone has nothing left to close */
  }
}

module.exports = { sharedBrowser, withSharedBrowser, closeSharedBrowser };
