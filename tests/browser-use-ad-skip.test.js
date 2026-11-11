'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createAdSkipper, SKIP_QUERY, isSkipSite } = require('../services/browser-use/ad-skip');
const { createFakeTimers } = require('./helpers/fake-timers');

const YT = 'https://www.youtube.com/watch?v=abc';
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

function makeSkipper(overrides = {}) {
  const timers = createFakeTimers();
  const calls = { queries: [], presses: [] };
  const env = {
    url: YT, canPress: true, hit: { x: 40, y: 50 },
    runInPage: async (code) => { calls.queries.push(code); return env.hit; },
    press: async (point) => { calls.presses.push(point); },
    ...overrides,
  };
  const skipper = createAdSkipper({
    getUrl: () => env.url,
    canPress: () => env.canPress,
    runInPage: (code) => env.runInPage(code),
    press: (point, isCurrent) => env.press(point, isCurrent),
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
    intervalMs: 1000,
    cooldownMs: 2000,
  });
  // Steps in small slices so a tick that finishes asynchronously can schedule the next one in time.
  const advance = async (ms) => {
    for (let left = ms; left > 0; left -= 250) {
      timers.tick(Math.min(250, left));
      await flush();
    }
  };
  return { skipper, env, timers, calls, advance };
}

test('nothing polls until the skipper is made active', async () => {
  const { skipper, timers, calls, advance } = makeSkipper();
  assert.equal(timers.pending(), 0);
  await advance(5000);
  assert.equal(calls.queries.length, 0);
  skipper.setActive(true);
  assert.equal(timers.pending(), 1);
  skipper.dispose();
});

test('the page query is the exported SKIP_QUERY', async () => {
  const { skipper, calls, advance } = makeSkipper();
  skipper.setActive(true);
  await advance(1000);
  assert.deepEqual(calls.queries, [SKIP_QUERY]);
  skipper.dispose();
});

test('setActive(false) stops the polling and setActive(true) resumes it', async () => {
  const { skipper, timers, calls, advance } = makeSkipper({ hit: null });
  skipper.setActive(true);
  await advance(2000);
  assert.equal(calls.queries.length, 2);
  skipper.setActive(false);
  assert.equal(timers.pending(), 0);
  await advance(5000);
  assert.equal(calls.queries.length, 2);
  skipper.setActive(true);
  await advance(1000);
  assert.equal(calls.queries.length, 3);
  skipper.dispose();
});

test('isSkipSite accepts only the four https YouTube hosts', () => {
  for (const url of ['https://youtube.com/', 'https://www.youtube.com/watch?v=1', 'https://m.youtube.com/', 'https://music.youtube.com/']) {
    assert.equal(isSkipSite(url), true, url);
  }
  for (const url of ['http://youtube.com/', 'https://notyoutube.com/', 'https://youtube.com.evil.test/', 'https://evil.test/youtube.com',
    'https://sub.youtube.com/', 'https://youtube.com:8443/', 'about:blank', '', null, undefined, 'not a url']) {
    assert.equal(isSkipSite(url), false, String(url));
  }
});

test('ticks off a skip site never look at the page', async () => {
  for (const url of ['http://youtube.com/', 'https://notyoutube.com/', 'https://youtube.com.evil.test/', 'https://example.com/']) {
    const { skipper, calls, advance } = makeSkipper({ url });
    skipper.setActive(true);
    await advance(3000);
    assert.equal(calls.queries.length, 0, url);
    assert.equal(calls.presses.length, 0, url);
    skipper.dispose();
  }
});

test('ticks are skipped while canPress is false and resume when it turns true', async () => {
  const { skipper, env, calls, advance } = makeSkipper({ canPress: false });
  skipper.setActive(true);
  await advance(3000);
  assert.equal(calls.queries.length, 0);
  env.canPress = true;
  await advance(1000);
  assert.deepEqual(calls.presses, [{ x: 40, y: 50 }]);
  skipper.dispose();
});

test('a hit presses once at the reported coordinates', async () => {
  const { skipper, env, calls, advance } = makeSkipper({ hit: { x: 123.5, y: 77 } });
  skipper.setActive(true);
  await advance(1000);
  assert.deepEqual(calls.presses, [{ x: 123.5, y: 77 }]);
  env.hit = null;
  await advance(1000);
  assert.equal(calls.presses.length, 1);
  skipper.dispose();
});

test('a malformed page answer presses nothing', async () => {
  const { skipper, env, calls, advance } = makeSkipper({ hit: { x: 'a', y: 1 } });
  skipper.setActive(true);
  await advance(2000);
  env.hit = { x: Infinity, y: 1 };
  await advance(2000);
  assert.equal(calls.presses.length, 0);
  skipper.dispose();
});

test('the cooldown blocks a second press until it has passed', async () => {
  const { skipper, calls, advance } = makeSkipper();
  skipper.setActive(true);
  await advance(1000);
  assert.equal(calls.presses.length, 1);
  await advance(1000); // 1000 ms after the press, still cooling
  assert.equal(calls.presses.length, 1);
  assert.equal(calls.queries.length, 1);
  await advance(1000); // 2000 ms after the press, cooldown over
  assert.equal(calls.presses.length, 2);
  skipper.dispose();
});

test('no more than 3 presses until the query goes null, then the count resets', async () => {
  const { skipper, env, calls, advance } = makeSkipper();
  skipper.setActive(true);
  await advance(10000);
  assert.equal(calls.presses.length, 3);
  env.hit = null;
  await advance(3000);
  env.hit = { x: 1, y: 2 };
  await advance(10000);
  assert.equal(calls.presses.length, 6);
  skipper.dispose();
});

test('a slow runInPage never overlaps ticks', async () => {
  let release = () => {};
  let running = 0;
  let peak = 0;
  const { skipper, calls, advance } = makeSkipper({
    runInPage: () => {
      running += 1;
      peak = Math.max(peak, running);
      return new Promise((resolve) => { release = () => { running -= 1; resolve(null); }; });
    },
  });
  skipper.setActive(true);
  await advance(1000);
  assert.equal(running, 1);
  await advance(5000);
  assert.equal(running, 1);
  release();
  await flush();
  await advance(1000);
  assert.equal(running, 1);
  assert.equal(peak, 1);
  assert.equal(calls.presses.length, 0);
  skipper.dispose();
});

test('a rejecting runInPage is swallowed and polling continues', async () => {
  let attempts = 0;
  const { skipper, calls, advance } = makeSkipper({
    runInPage: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('page is gone');
      return { x: 5, y: 6 };
    },
  });
  skipper.setActive(true);
  await advance(3000);
  assert.equal(attempts, 3);
  assert.deepEqual(calls.presses, [{ x: 5, y: 6 }]);
  skipper.dispose();
});

test('a rejecting press is swallowed and polling continues', async () => {
  let attempts = 0;
  const { skipper, env, advance } = makeSkipper({
    press: async () => { attempts += 1; throw new Error('input refused'); },
  });
  skipper.setActive(true);
  await advance(1000);
  assert.equal(attempts, 1);
  env.hit = null;
  await advance(3000);
  env.hit = { x: 1, y: 1 };
  await advance(1000);
  assert.equal(attempts, 2);
  skipper.dispose();
});

test('dispose cancels the timer and nothing runs afterwards', async () => {
  const { skipper, timers, calls, advance } = makeSkipper();
  skipper.setActive(true);
  skipper.dispose();
  assert.equal(timers.pending(), 0);
  await advance(10000);
  assert.equal(calls.queries.length, 0);
  skipper.setActive(true);
  skipper.dispose();
});

test('dispose during a cooldown cancels that timer too', async () => {
  const { skipper, timers, advance } = makeSkipper();
  skipper.setActive(true);
  await advance(1000);
  skipper.dispose();
  assert.equal(timers.pending(), 0);
});

// jsdom has no layout, so the query's rects come from stubs: every element reports the rect set on its
// data-rect attribute ("left,top,width,height"), and getClientRects is empty only for a missing rect.
function makeAdPage(html, { width = 1280, height = 720 } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: YT });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  const rectOf = (el) => (el.getAttribute('data-rect') || '0,0,0,0').split(',').map(Number);
  window.Element.prototype.getClientRects = function getClientRects() {
    return this.hasAttribute('data-rect') ? [{}] : [];
  };
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const [left, top, w, h] = rectOf(this);
    return { x: left, y: top, left, top, width: w, height: h, right: left + w, bottom: top + h };
  };
  return () => JSON.parse(JSON.stringify(window.eval(SKIP_QUERY)));
}

const adHtml = ({ playerClass = 'html5-video-player ad-showing', buttonStyle = '', rect = '1000,600,100,40' } = {}) => `<body>
<div id="movie_player" class="${playerClass}"><div class="ytp-ad-skip-button-container">
<button class="ytp-skip-ad-button" style="${buttonStyle}" data-rect="${rect}">Skip</button></div></div></body>`;

test('SKIP_QUERY returns the centre of a visible Skip button during an ad', () => {
  const query = makeAdPage(adHtml());
  assert.deepEqual(query(), { x: 1050, y: 620 });
});

test('SKIP_QUERY returns null when no ad is showing', () => {
  assert.equal(makeAdPage(adHtml({ playerClass: 'html5-video-player' }))(), null);
});

test('SKIP_QUERY returns null when there is no Skip button or no player', () => {
  assert.equal(makeAdPage('<body><div id="movie_player" class="ad-showing"></div></body>')(), null);
  assert.equal(makeAdPage('<body><button class="ytp-skip-ad-button" data-rect="10,10,50,20">Skip</button></body>')(), null);
});

test('SKIP_QUERY returns null for a hidden or display-none button', () => {
  assert.equal(makeAdPage(adHtml({ buttonStyle: 'visibility:hidden' }))(), null);
  assert.equal(makeAdPage(adHtml({ buttonStyle: 'display:none' }))(), null);
});

test('SKIP_QUERY returns null for a zero-opacity or nearly transparent button', () => {
  assert.equal(makeAdPage(adHtml({ buttonStyle: 'opacity:0' }))(), null);
  assert.equal(makeAdPage(adHtml({ buttonStyle: 'opacity:0.1' }))(), null);
  assert.notEqual(makeAdPage(adHtml({ buttonStyle: 'opacity:0.5' }))(), null);
});

test('SKIP_QUERY returns null when the button has no client rects', () => {
  const html = adHtml().replace(' data-rect="1000,600,100,40"', '');
  assert.equal(makeAdPage(html)(), null);
});

test('SKIP_QUERY returns null when the button centre is outside the viewport', () => {
  assert.equal(makeAdPage(adHtml({ rect: '2000,600,100,40' }))(), null);
  assert.equal(makeAdPage(adHtml({ rect: '1000,900,100,40' }))(), null);
  assert.equal(makeAdPage(adHtml({ rect: '-200,10,100,40' }))(), null);
});

test('SKIP_QUERY returns null when a wrapper around the button is hidden', () => {
  const html = adHtml().replace('class="ytp-ad-skip-button-container"', 'class="ytp-ad-skip-button-container" style="opacity:0"');
  assert.equal(makeAdPage(html)(), null);
});

test('a press that could not be delivered does not use up the three tries', async () => {
  let delivered = false;
  const { skipper, calls, advance } = makeSkipper({
    press: async (point) => { calls.presses.push(point); return delivered; },
  });
  skipper.setActive(true);
  await advance(16000);
  const refused = calls.presses.length;
  assert.ok(refused > 3, `kept trying, ${refused} attempts`);
  delivered = true;
  await advance(16000);
  assert.equal(calls.presses.length, refused + 3);
  skipper.dispose();
});

test('nothing is pressed when the page moved on while it was being looked at', async () => {
  const fixture = makeSkipper();
  fixture.env.runInPage = async () => { fixture.env.url = 'https://www.youtube.com/watch?v=other'; return fixture.env.hit; };
  fixture.skipper.setActive(true);
  await fixture.advance(1000);
  assert.equal(fixture.calls.presses.length, 0);
  fixture.skipper.dispose();
});

test('the press is told when ad blocking went off or the page moved after the look', async () => {
  let isCurrent = null;
  const fixture = makeSkipper({ press: async (_point, check) => { isCurrent = check; } });
  fixture.skipper.setActive(true);
  await fixture.advance(1000);
  assert.equal(isCurrent(), true);
  fixture.env.canPress = false;
  assert.equal(isCurrent(), false);
  fixture.env.canPress = true;
  fixture.env.url = 'https://www.youtube.com/';
  assert.equal(isCurrent(), false);
  fixture.skipper.dispose();
});
