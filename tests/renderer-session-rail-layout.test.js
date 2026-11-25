/* global document, getComputedStyle */
'use strict';

/* Row 59 checkpoint 2, slice S3: the session rail's layout gate. The REAL rail stylesheet
 * (styles/chat-session-rail.css) and the real rail modules in headless Chromium, on the
 * reading-layout harness (every app script blocked; the rail modules and a fake chatWorkspace
 * bridge injected, the rail hosted in one fixed element as the Chat workbench's Session view hosts it).
 * jsdom cannot run CSS transitions, so this is the contract for the disclosure motion:
 *
 *   a closed section takes no height and its rows cannot take focus; opening runs a block-size transition
 *   data arriving after "checking" settles at once, with no height or opacity motion
 *
 * Where the rail sits and how wide it is belongs to the workbench (tests/renderer-chat-workbench.test.js). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, frames, mountReadingLayout } = require('./helpers/chat-reading-layout-harness');
const { installRails } = require('./helpers/session-rail-layout');
const { withSharedBrowser, closeSharedBrowser } = require('./helpers/layout-shared-browser');

// One browser serves every cell of the file, each on its own page; it exits with the file.
test.after(closeSharedBrowser);

test('session rail layout: a section disclosure animates height and a collapsed body is out of the tab order', { skip: SKIP, timeout: 120000 }, async () => {
  await withSharedBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await installRails(page);
    const read = () => page.evaluate(() => {
      const head = document.querySelector('[data-rail-section="context"]');
      const body = head.parentElement.querySelector('[data-rail-body]');
      const rows = [...body.querySelectorAll('button')];
      return { expanded: head.getAttribute('aria-expanded'), height: body.getBoundingClientRect().height, visibility: getComputedStyle(body).visibility, interpolate: getComputedStyle(body).getPropertyValue('interpolate-size'), focusable: rows.filter((el) => getComputedStyle(el).visibility !== 'hidden').length };
    });
    const closed = await read();
    assert.equal(closed.expanded, 'false');
    assert.equal(closed.height, 0, 'a closed section takes no height');
    assert.equal(closed.visibility, 'hidden', 'its rows cannot take focus');
    assert.equal(closed.focusable, 0);
    await page.click('[data-rail-section="context"]');
    // The height transition is running: sample it half way through.
    const midway = await page.evaluate(() => {
      const body = document.querySelector('[data-rail-section="context"]').parentElement.querySelector('[data-rail-body]');
      const animations = body.getAnimations().filter((anim) => anim.effect && anim.effect.getComputedTiming().endTime > 0);
      animations.forEach((anim) => { anim.pause(); anim.currentTime = anim.effect.getComputedTiming().endTime * 0.5; });
      return { count: animations.length, properties: animations.map((anim) => anim.transitionProperty).filter(Boolean), height: body.getBoundingClientRect().height };
    });
    await page.evaluate(() => { document.getAnimations().forEach((anim) => { try { anim.finish(); } catch (_e) { /* infinite */ } }); });
    await frames(page, 3);
    const opened = await read();
    assert.equal(opened.expanded, 'true');
    assert.ok(opened.height > 40, `an open section has its rows' height (${opened.height})`);
    assert.ok(midway.count > 0, 'opening runs a transition');
    assert.ok(midway.properties.some((property) => /block-size|height/.test(property)), `the height is what animates (${midway.properties.join(', ')})`);
    assert.ok(midway.height > 0 && midway.height < opened.height, `half way the section is between closed and open (${midway.height} of ${opened.height})`);
    await page.close();
  });
});

test('session rail layout: data arriving after "checking" settles at once, with no height or opacity motion', { skip: SKIP, timeout: 120000 }, async () => {
  await withSharedBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await installRails(page, { summaryDelayMs: 250 });
    assert.equal(await page.evaluate(() => document.querySelector('[data-section="context"]').dataset.state), 'checking', 'the first paint is still checking');
    await page.waitForFunction(() => document.querySelector('[data-section="context"]').dataset.state === 'available');
    const motion = await page.evaluate(() => document.getAnimations()
      .filter((anim) => anim.effect && anim.effect.target && anim.effect.target.closest && anim.effect.target.closest('.session-rail-tray') && anim.transitionProperty)
      .map((anim) => anim.transitionProperty));
    assert.deepEqual(motion, [], 'nothing animates on load or a session switch');
    const open = await page.evaluate(() => ['this_chat', 'running_now'].map((key) => document.querySelector(`[data-rail-section="${key}"]`).getAttribute('aria-expanded')));
    assert.deepEqual(open, ['true', 'true'], 'the defaults applied');
    await page.close();
  });
});
