'use strict';

/* The browser tool's wait action (row 182): frames held for the wait, then one screenshot. Throttling is the
 * step's job (setStepActive in page-host.js), so the action itself must never touch it. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { logNames } = require('./helpers/fake-web-contents-view');
const { harness } = require('./helpers/browser-use-page-actions-harness');

function withThrottleLog(h) {
  h.webContents.setBackgroundThrottling = (allowed) => h.log.push({ who: 'wc', name: 'setBackgroundThrottling', args: [allowed] });
  return h;
}

const throttleCalls = (h) => h.log.filter((e) => e.name === 'setBackgroundThrottling').map((e) => e.args[0]);

test('wait holds frames for the wait, releases them, leaves throttling to the step, then returns a screenshot', async () => {
  const h = withThrottleLog(harness());
  const started = Date.now();
  const result = await h.actions.wait({ seconds: 0.5 });
  assert.ok(Date.now() - started >= 450, 'the wait lasted about its length');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'waited');
  assert.match(result.message, /^Waited 0\.5 s\. Screenshot captured/);
  assert.ok(Buffer.isBuffer(result.image.buffer));
  assert.deepEqual(throttleCalls(h), [], 'throttling stays off for the whole step, screenshot included');
  const names = logNames(h.log).filter((n) => n !== 'wc.executeJavaScript');
  assert.deepEqual(names.slice(0, 2), ['wc.beginFrameSubscription', 'wc.endFrameSubscription']);
  assert.ok(names.indexOf('wc.capturePage') > 1, 'the screenshot comes after the wait');
});

test('wait defaults to 2 seconds and refuses an out-of-range or non-number seconds without touching the page', async () => {
  for (const seconds of [0, 0.2, 11, '3', Number.NaN]) {
    const h = withThrottleLog(harness());
    const result = await h.actions.wait({ seconds });
    assert.equal(result.status, 'invalid_arguments', String(seconds));
    assert.match(result.message, /seconds must be a number from 0\.5 to 10/);
    assert.equal(h.log.length, 0);
  }
});

test('a cancelled wait releases frames and takes no screenshot', async () => {
  const controller = new AbortController();
  const h = withThrottleLog(harness());
  const pending = h.actions.wait({ seconds: 10 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(throttleCalls(h), []);
  assert.ok(logNames(h.log).includes('wc.endFrameSubscription'));
  assert.ok(!logNames(h.log).includes('wc.capturePage'));
});
