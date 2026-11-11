/* global document, window, getComputedStyle */
'use strict';

/* Row 115 slice 3 (session bar): the Session rail moves like the other panels. The shared setup is
   tests/helpers/session-rail-layout.js; the unit-level wiring is tests/renderer-session-rail-motion.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SKIP, withBrowser, frames, mountReadingLayout, createCollector, fmt,
} = require('./helpers/chat-reading-layout-harness');
const {
  RAIL_PX, RESERVE_PX, PANEL_PX, installRails, toggleRail, measureRails, checkCommon,
} = require('./helpers/session-rail-layout');

/* ── Row 115 slice 3: the rail moves like the other panels ────────────────────────────────────────────────
   Real layout, real stylesheets, the shared side-panel motion and the rail's own modules. A glide cannot be
   watched headless, so the gate pauses every running animation and seeks it (0, 50 and 100 %), reading the rail,
   the stage's reserve, the tray and the reading measure at each step, then lets the motion finish. */

/* Inside the page: pause and seek every finite animation, reading the numbers the glide moves. */
function sampleRailGlide(steps) {
  const pane = document.querySelector('#chatView .chat-pane');
  const rail = pane.querySelector('[data-session-rail-root]');
  const stage = pane.querySelector('.chat-thread-stage');
  const tray = pane.querySelector('.session-rail-tray');
  const timeline = pane.querySelector('.chat-timeline');
  void document.body.offsetWidth;
  const animations = document.getAnimations().filter((anim) => {
    const timing = anim.effect && anim.effect.getComputedTiming();
    return timing && Number.isFinite(timing.endTime) && timing.endTime > 0;
  });
  animations.forEach((anim) => anim.pause());
  const samples = steps.map((progress) => {
    animations.forEach((anim) => { anim.currentTime = anim.effect.getComputedTiming().endTime * progress; });
    return {
      progress,
      rail: getComputedStyle(rail).display === 'none' ? 0 : rail.getBoundingClientRect().width,
      tray: tray && tray.isConnected ? tray.getBoundingClientRect().width : null,
      reserve: Number.parseFloat(getComputedStyle(stage).marginInlineEnd) || 0,
      stage: stage.getBoundingClientRect().width,
      measure: timeline.getBoundingClientRect().width,
    };
  });
  return { names: animations.map((anim) => anim.animationName).filter(Boolean), samples };
}

// sampleRailGlide runs in the page: install it once per page.
const installSampler = (page) => page.addScriptTag({ content: `window.__sampleRailGlide = ${sampleRailGlide.toString()};` });

async function finishMotion(page) {
  await page.evaluate(() => { document.getAnimations().forEach((anim) => { try { anim.finish(); } catch (_e) { /* infinite */ } }); });
  await page.waitForFunction(() => !document.getElementById('chatView').hasAttribute('data-panel-motion'));
  await frames(page, 4);
}

async function recordReflow(page) {
  await page.evaluate(() => {
    window.__reflow = [];
    document.querySelector('#chatView .chat-pane').addEventListener('session-rail-reflow', (event) => window.__reflow.push(event.detail.phase));
  });
}

test('session rail layout: the toggle glides the rail, the reserve and the tray together; the text keeps one measure; reflow is bracketed once', { skip: SKIP, timeout: 120000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await installRails(page);
    await installSampler(page);
    await recordReflow(page);
    const docked = (await page.evaluate(measureRails)).panes[0];

    // Hide: the click starts the motion at once and the rail stays up through it.
    const hide = await page.evaluate((steps) => {
      const view = document.getElementById('chatView');
      const pane = view.querySelector('.chat-pane');
      document.querySelector('[data-session-rail-toggle]').click();
      return {
        phase: view.dataset.panelMotion, glide: pane.getAttribute('data-session-rail-glide'), mode: pane.dataset.sessionRail,
        railHidden: pane.querySelector('[data-session-rail-root]').hidden, pressed: document.querySelector('[data-session-rail-toggle]').getAttribute('aria-pressed'),
        reflowAtClick: window.__reflow.slice(), ...window.__sampleRailGlide(steps),
      };
    }, [0, 0.5, 1]);
    collector.ok(hide.phase === 'closing' && hide.glide === 'closing', `hide: the shared motion runs (${hide.phase}, ${hide.glide})`);
    collector.ok(hide.mode === 'docked' && hide.railHidden === false, 'hide: the rail stays up until its column has collapsed');
    collector.ok(hide.pressed === 'false', 'hide: the pressed state flipped with the click');
    collector.ok(hide.reflowAtClick.length === 0, 'hide: nothing is anchored at the start of a close');
    collector.ok(hide.names.some((name) => name === 'session-rail-close') && hide.names.some((name) => name === 'session-rail-room-close'), `hide: the rail and the reserve animate (${hide.names.join(', ')})`);
    const [h0, h50, h100] = hide.samples;
    collector.ok(Math.abs(h0.rail - RAIL_PX) <= 1 && h100.rail <= 1 && h50.rail > 1 && h50.rail < RAIL_PX - 1, `hide: the rail column shrinks ${fmt(h0.rail)} -> ${fmt(h50.rail)} -> ${fmt(h100.rail)}`);
    collector.ok(Math.abs(h0.reserve - RESERVE_PX) <= 1 && h100.reserve <= 1 && h50.reserve > 1 && h50.reserve < RESERVE_PX - 1, `hide: the stage gives the room back ${fmt(h0.reserve)} -> ${fmt(h50.reserve)} -> ${fmt(h100.reserve)}`);
    collector.ok(hide.samples.every((sample) => Math.abs(sample.measure - h0.measure) <= 0.5), `hide: the reading measure is held for the whole glide (${hide.samples.map((sample) => fmt(sample.measure)).join(' / ')})`);
    collector.ok(hide.samples.every((sample) => sample.tray !== null && Math.abs(sample.tray - h0.tray) <= 0.5), `hide: the tray keeps its full width inside the shrinking column (${hide.samples.map((sample) => fmt(sample.tray)).join(' / ')})`);
    collector.ok(Math.abs(h0.stage - docked.stage.width) <= 1, `hide: the stage starts where it was (${fmt(docked.stage.width)} -> ${fmt(h0.stage)})`);
    await finishMotion(page);
    const hidden = (await page.evaluate(measureRails)).panes[0];
    collector.ok(hidden.mode === 'hidden' && hidden.rail === null, 'hide: the rail is gone at the end');
    collector.ok(Math.abs(hidden.stage.width - (docked.stage.width + RESERVE_PX)) <= 1, `hide: the stage took the room back (${fmt(docked.stage.width)} -> ${fmt(hidden.stage.width)})`);
    const hideEvents = await page.evaluate(() => window.__reflow.slice());
    collector.ok(JSON.stringify(hideEvents) === JSON.stringify(['before', 'after']), `hide: one reflow bracket, from the motion alone (${hideEvents.join(',')})`);
    const leftover = await page.evaluate(() => ({ attr: document.getElementById('chatView').hasAttribute('data-panel-motion'), lock: document.querySelector('#chatView .chat-pane').style.getPropertyValue('--chat-measure-lock'), glide: document.querySelector('#chatView .chat-pane').getAttribute('data-session-rail-glide') }));
    collector.ok(!leftover.attr && leftover.lock === '' && leftover.glide === null, `hide: no attribute, lock or glide mark is left (${JSON.stringify(leftover)})`);

    // Show: the end state lands first, then the column grows from nothing.
    await page.evaluate(() => { window.__reflow.length = 0; });
    const show = await page.evaluate((steps) => {
      const view = document.getElementById('chatView');
      const pane = view.querySelector('.chat-pane');
      document.querySelector('[data-session-rail-toggle]').click();
      return { phase: view.dataset.panelMotion, glide: pane.getAttribute('data-session-rail-glide'), mode: pane.dataset.sessionRail, ...window.__sampleRailGlide(steps) };
    }, [0, 0.5, 1]);
    collector.ok(show.phase === 'opening' && show.glide === 'opening' && show.mode === 'docked', `show: the motion runs (${show.phase}, ${show.glide}, ${show.mode})`);
    const [s0, s50, s100] = show.samples;
    collector.ok(s0.rail <= 1 && Math.abs(s100.rail - RAIL_PX) <= 1 && s50.rail > 1 && s50.rail < RAIL_PX - 1, `show: the rail column grows ${fmt(s0.rail)} -> ${fmt(s50.rail)} -> ${fmt(s100.rail)}`);
    collector.ok(s0.reserve <= 1 && Math.abs(s100.reserve - RESERVE_PX) <= 1, `show: the stage gives up the room ${fmt(s0.reserve)} -> ${fmt(s100.reserve)}`);
    collector.ok(show.samples.every((sample) => Math.abs(sample.measure - s0.measure) <= 0.5), 'show: the reading measure is held for the whole glide');
    collector.ok(show.samples.every((sample) => sample.tray !== null && Math.abs(sample.tray - s0.tray) <= 0.5), 'show: the tray keeps its full width while the column grows');
    await finishMotion(page);
    const shown = (await page.evaluate(measureRails)).panes[0];
    collector.ok(shown.mode === 'docked' && Math.abs(shown.stage.width - docked.stage.width) <= 1, `show: back to the docked stage (${fmt(docked.stage.width)} -> ${fmt(shown.stage.width)})`);
    checkCommon(collector, 'shown after the glide', await page.evaluate(measureRails));
    const showEvents = await page.evaluate(() => window.__reflow.slice());
    collector.ok(JSON.stringify(showEvents) === JSON.stringify(['before', 'after', 'before', 'after']), `show: the lock's two reflow points are bracketed, never nested (${showEvents.join(',')})`);

    // Re-toggle mid-glide: the old motion is cancelled and the new one runs; nothing is left stuck.
    const retoggle = await page.evaluate(() => {
      const view = document.getElementById('chatView');
      const toggle = document.querySelector('[data-session-rail-toggle]');
      toggle.click();
      const first = view.dataset.panelMotion;
      toggle.click();
      return { first, second: view.dataset.panelMotion, mode: view.querySelector('.chat-pane').dataset.sessionRail };
    });
    collector.ok(retoggle.first === 'closing' && retoggle.second === 'opening' && retoggle.mode === 'docked', `re-toggle: the second click replaces the first (${JSON.stringify(retoggle)})`);
    await finishMotion(page);
    const settled = await page.evaluate(() => ({ lock: document.querySelector('#chatView .chat-pane').style.getPropertyValue('--chat-measure-lock'), glide: document.querySelector('#chatView .chat-pane').getAttribute('data-session-rail-glide'), mode: document.querySelector('#chatView .chat-pane').dataset.sessionRail }));
    collector.ok(settled.lock === '' && settled.glide === null && settled.mode === 'docked', `re-toggle: nothing is stuck (${JSON.stringify(settled)})`);
    await page.close();
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});

test('session rail layout: with reduced motion the toggle is instant, with the one reflow bracket it always had', { skip: SKIP, timeout: 120000 }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installRails(page);
    await recordReflow(page);
    const result = await page.evaluate(() => {
      document.querySelector('[data-session-rail-toggle]').click();
      const view = document.getElementById('chatView');
      return { attr: view.hasAttribute('data-panel-motion'), mode: view.querySelector('.chat-pane').dataset.sessionRail, events: window.__reflow.slice(), animations: document.getAnimations().filter((anim) => /^session-rail-(open|close|room|hero)/.test(anim.animationName || '')).length };
    });
    assert.equal(result.attr, false, 'no motion starts');
    assert.equal(result.mode, 'hidden', 'the mode lands at once');
    assert.deepEqual(result.events, ['before', 'after']);
    assert.equal(result.animations, 0, 'nothing animates');
    await page.close();
  });
});

test('session rail layout: a panel that leaves the pane under the dock width takes the rail out inside its own glide, with no second reflow after it', { skip: SKIP, timeout: 120000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await installRails(page);
    await installSampler(page);
    // Find the window that gives the pane ~1000px: wide enough to dock, too narrow to dock beside a 420px panel.
    const paneNow = (await page.evaluate(measureRails)).panes[0];
    const viewportWidth = Math.round(1455 - (paneNow.stage.width + RESERVE_PX - 1000));
    await page.setViewportSize({ width: viewportWidth, height: 900 });
    await frames(page, 8);
    const before = (await page.evaluate(measureRails)).panes[0];
    collector.ok(before.mode === 'docked', `before: docked at ${viewportWidth}px (pane ${fmt(before.stage.width + RESERVE_PX)}px)`);
    await recordReflow(page);
    const open = await page.evaluate(({ width, steps }) => {
      const view = document.getElementById('chatView');
      const panel = document.getElementById('artifactReviewPanel');
      const pane = view.querySelector('.chat-pane');
      window.__panelMotion = window.rendererSidePanelMotion.createSidePanelMotion({ chatView: view, getCoordinators: () => [] });
      window.__panelMotion.open({
        panel,
        applyEnd: () => {
          view.style.setProperty('--artifact-review-width', `${width}px`);
          panel.style.setProperty('width', `${width}px`);
          panel.classList.remove('hidden');
          document.getElementById('artifactReviewResizer').classList.remove('hidden');
          view.classList.add('artifact-review-mode', 'artifact-review-open');
        },
      });
      return { phase: view.dataset.panelMotion, mode: pane.dataset.sessionRail, glide: pane.getAttribute('data-session-rail-glide'), railShown: getComputedStyle(pane.querySelector('[data-session-rail-root]')).display !== 'none', ...window.__sampleRailGlide(steps) };
    }, { width: PANEL_PX, steps: [0, 0.5, 1] });
    collector.ok(open.phase === 'opening', `open: the panel's motion runs (${open.phase})`);
    collector.ok(open.mode === 'undocked' && !open.railShown, `open: the rail left in the first frame, decided with the panel's final layout (${open.mode})`);
    collector.ok(open.glide === 'leaving', `open: its room rides the panel's glide (${open.glide})`);
    const [o0, o50, o100] = open.samples;
    collector.ok(Math.abs(o0.reserve - RESERVE_PX) <= 1 && o100.reserve <= 1 && o50.reserve > 1 && o50.reserve < RESERVE_PX - 1, `open: the reserve eases away ${fmt(o0.reserve)} -> ${fmt(o50.reserve)} -> ${fmt(o100.reserve)}`);
    // The panel's own 10px resizer track appears at once (not the rail's doing); a lost reserve would be ~296px.
    collector.ok(Math.abs(o0.stage - before.stage.width) <= 12, `open: the stage does not jump at the start (${fmt(before.stage.width)} -> ${fmt(o0.stage)})`);
    collector.ok(open.samples.every((sample) => Math.abs(sample.measure - o0.measure) <= 0.5), 'open: the reading measure is held for the whole glide');
    await finishMotion(page);
    const after = (await page.evaluate(measureRails)).panes[0];
    await frames(page, 8);
    const later = (await page.evaluate(measureRails)).panes[0];
    collector.ok(after.mode === 'undocked' && later.mode === 'undocked', 'after: the rail stays out');
    collector.ok(Math.abs(after.stage.width - later.stage.width) <= 0.5 && Math.abs(after.stage.left - later.stage.left) <= 0.5, `after: the end-of-motion dock re-run changed nothing (${fmt(after.stage.width)} -> ${fmt(later.stage.width)})`);
    const events = await page.evaluate(() => window.__reflow.slice());
    collector.ok(events.length === 0, `after: the rail made no reflow bracket of its own (${events.join(',')})`);
    const glide = await page.evaluate(() => document.querySelector('#chatView .chat-pane').getAttribute('data-session-rail-glide'));
    collector.ok(glide === null, 'after: no glide mark is left');
    await page.close();
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});

test('session rail layout: the rail resizes by keys and by drag between 240 and 420, holds the measure while dragging, and remembers the width', { skip: SKIP, timeout: 120000 }, async () => {
  const collector = createCollector();
  await withBrowser(async (browser) => {
    // Wide enough that the measure is at its cap, so the stage has slack and a drag moves no text.
    const page = await mountReadingLayout(browser, { viewport: { width: 2000, height: 1000 }, split: false });
    await installRails(page);
    const read = () => page.evaluate(() => {
      const pane = document.querySelector('#chatView .chat-pane');
      const handle = pane.querySelector('.session-rail-resizer');
      const rail = pane.querySelector('[data-session-rail-root]').getBoundingClientRect();
      const box = handle.getBoundingClientRect();
      return {
        rail: rail.width, railLeft: rail.left, handle: { left: box.left, right: box.right, width: box.width, top: box.top, bottom: box.bottom, shown: getComputedStyle(handle).display !== 'none' },
        now: handle.getAttribute('aria-valuenow'), property: pane.style.getPropertyValue('--session-rail-width'), lock: pane.style.getPropertyValue('--chat-measure-lock'),
        measure: pane.querySelector('.chat-timeline').getBoundingClientRect().width, stage: pane.querySelector('.chat-thread-stage').getBoundingClientRect().width,
        stored: (() => { try { return window.localStorage.getItem('jenny.sessionRail.v1'); } catch (_e) { return 'blocked'; } })(),
      };
    });
    const start = await read();
    collector.ok(start.handle.shown && Math.abs((start.handle.left + start.handle.right) / 2 - start.railLeft) <= 1, `the handle is centred on the rail's start edge (${fmt((start.handle.left + start.handle.right) / 2)} vs ${fmt(start.railLeft)})`);
    collector.ok(start.handle.top >= 39.5, `the handle starts below the session bar (${fmt(start.handle.top)})`);
    collector.ok(Math.abs(start.rail - RAIL_PX) <= 0.5 && start.now === '280', 'the default is 280px');
    await page.focus('.session-rail-resizer');
    await page.keyboard.press('ArrowLeft');
    await frames(page, 2);
    const grown = await read();
    collector.ok(Math.abs(grown.rail - 304) <= 0.5 && grown.now === '304' && grown.property === '304px', `ArrowLeft grows by 24 (${fmt(grown.rail)})`);
    collector.ok(grown.stage < start.stage - 23 || Math.abs(grown.measure - start.measure) <= 0.5, 'the stage gave the room up (or the measure was already at its cap)');
    await page.keyboard.press('End');
    const max = await read();
    collector.ok(Math.abs(max.rail - 420) <= 0.5, `End goes to 420 (${fmt(max.rail)})`);
    await page.keyboard.press('Home');
    const home = await read();
    collector.ok(Math.abs(home.rail - 280) <= 0.5, `Home goes back to 280 (${fmt(home.rail)})`);
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight');
    const floor = await read();
    collector.ok(Math.abs(floor.rail - 240) <= 0.5, `the floor is 240 (${fmt(floor.rail)})`);

    // A drag: the measure is locked while moving and the width saves on release only.
    await page.keyboard.press('Home');
    const grab = await read();
    const x = (grab.handle.left + grab.handle.right) / 2;
    const y = grab.handle.top + 200;
    await page.evaluate(() => { try { window.localStorage.removeItem('jenny.sessionRail.v1'); } catch (_e) { /* blocked */ } });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 30, y, { steps: 3 });
    await page.mouse.move(x - 60, y, { steps: 3 });
    await frames(page, 2);
    const during = await read();
    collector.ok(Math.abs(during.rail - 340) <= 1 && during.now === '340', `the drag applies on move (${fmt(during.rail)})`);
    collector.ok(during.lock !== '' && Math.abs(during.measure - grab.measure) <= 0.5, `the measure is held while dragging (lock ${during.lock}, ${fmt(grab.measure)} -> ${fmt(during.measure)})`);
    collector.ok(during.stored === null, 'nothing is saved while moving');
    await page.mouse.up();
    await frames(page, 2);
    const released = await read();
    collector.ok(released.lock === '', 'the lock is released on pointerup');
    collector.ok(released.stored === null ? false : JSON.parse(released.stored).width === 340, `the width is saved on release (${released.stored})`);
    await page.close();

    // A stored width is applied at mount; a corrupt one falls back to the default.
    const remount = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await remount.evaluate(() => { try { window.localStorage.setItem('jenny.sessionRail.v1', JSON.stringify({ width: 360 })); } catch (_e) { /* blocked */ } });
    await installRails(remount);
    const stored = await remount.evaluate(() => document.querySelector('[data-session-rail-root]').getBoundingClientRect().width);
    const canStore = await remount.evaluate(() => { try { window.localStorage.setItem('jenny.probe', '1'); return true; } catch (_e) { return false; } });
    collector.ok(!canStore || Math.abs(stored - 360) <= 0.5, `a stored width is applied at mount (${fmt(stored)})`);
    await remount.close();
  });
  assert.equal(collector.failures.length, 0, `${collector.failures.length} failed:\n${collector.failures.join('\n')}`);
});

test('session rail layout: the resize handle exists only while the rail is docked', { skip: SKIP, timeout: 120000 }, async () => {
  await withBrowser(async (browser) => {
    const narrow = await mountReadingLayout(browser, { viewport: { width: 700, height: 900 }, split: false });
    await installRails(narrow);
    assert.equal(await narrow.evaluate(() => getComputedStyle(document.querySelector('.session-rail-resizer')).display), 'none', 'the sheet has no handle');
    await narrow.close();
    const page = await mountReadingLayout(browser, { viewport: { width: 1455, height: 900 }, split: false });
    await installRails(page);
    await toggleRail(page);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.session-rail-resizer')).display), 'none', 'a hidden rail has no handle');
    await page.close();
  });
});
