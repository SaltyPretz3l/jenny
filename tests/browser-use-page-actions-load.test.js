'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPageActions } = require('../services/browser-use/page-actions');
const { createFakeWebContents, logNames } = require('./helpers/fake-web-contents-view');

const NEVER = () => new Promise(() => {});
const PAGE = Object.freeze({ status: 'ok', text: 'Page: Example' });

function harness({ loadURL, maskReply = { status: 'ok' }, blocked = null } = {}) {
  const webContents = createFakeWebContents({ loadURL });
  const reader = {
    async call(op) {
      webContents.log.push({ who: 'reader', name: op, args: [] });
      return op === 'secretMask' ? maskReply : PAGE;
    },
  };
  let pendingBlock = blocked;
  const gate = {
    beforeNavigate: async () => ({ proceed: true }),
    hasBlockedNavigation: () => pendingBlock !== null,
    takeBlockedNavigation: () => {
      const found = pendingBlock;
      pendingBlock = null;
      return found;
    },
  };
  const settler = { waitForSettle: () => new Promise(resolve => setImmediate(resolve, { settled: false, reason: 'cap' })) };
  return { actions: createPageActions({ webContents, reader, gate, settler }), webContents };
}

test('a page that never finishes loading does not hold the call past the settle cap', async () => {
  const { actions } = harness({ loadURL: NEVER });
  const result = await actions.navigate({ url: 'https://slow.example/' });
  assert.deepEqual([result.ok, result.status], [true, 'navigated']);
  assert.deepEqual(result.page, PAGE);
});

test('a page that replaces its own load counts as loaded, not as a failure', async () => {
  const error = Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' });
  const ctx = harness({ loadURL: async () => { ctx.webContents.getURL = () => 'https://www.youtube.com/results?q=jazz'; throw error; } });
  ctx.webContents.getURL = () => '';
  const result = await ctx.actions.navigate({ url: 'https://www.youtube.com/results?q=jazz' });
  assert.deepEqual([result.ok, result.status], [true, 'navigated']);
  assert.deepEqual(result.page, PAGE);
});

test('an aborted load that leaves nothing new is still a failure', async () => {
  const error = Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' });
  for (const before of ['', 'https://old.example/']) {
    const ctx = harness({ loadURL: async () => { throw error; } });
    ctx.webContents.getURL = () => before;
    const result = await ctx.actions.navigate({ url: 'https://new.example/' });
    assert.deepEqual([result.ok, result.status], [false, 'load_failed'], `left on "${before}"`);
  }
});

test('any other load failure is still a failure even if the address changed', async () => {
  const error = Object.assign(new Error('refused'), { code: 'ERR_CONNECTION_REFUSED' });
  const ctx = harness({ loadURL: async () => { ctx.webContents.getURL = () => 'https://new.example/'; throw error; } });
  ctx.webContents.getURL = () => '';
  const result = await ctx.actions.navigate({ url: 'https://new.example/' });
  assert.deepEqual([result.ok, result.status], [false, 'load_failed']);
});

test('a redirect the guard stopped tells the model where it was going', async () => {
  const error = Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' });
  const { actions } = harness({
    loadURL: async () => { throw error; },
    blocked: { host: 'elsewhere.example', reason: 'new_site' },
  });
  const result = await actions.navigate({ url: 'https://short.example/x' });
  assert.deepEqual([result.ok, result.status], [false, 'load_failed']);
  assert.equal(result.blockedNavigation.host, 'elsewhere.example');
  assert.match(result.message, /elsewhere\.example/);
  assert.equal(result.page, undefined);
});

test('a blocked download is described as a download, not a site to ask about', async () => {
  const { actions } = harness({ blocked: { host: 'files.example', reason: 'download' } });
  const result = await actions.navigate({ url: 'https://files.example/a.zip' });
  assert.match(result.message, /downloads are turned off/);
  assert.doesNotMatch(result.message, /ask the user/);
});

for (const maskReply of [{ status: 'failed' }, null]) {
  test(`a screenshot is not taken when the mask answers ${JSON.stringify(maskReply)}`, async () => {
    const { actions, webContents } = harness({ maskReply });
    const result = await actions.screenshot({});
    assert.equal(result.status, 'screenshot_failed');
    assert.equal(logNames(webContents.log).includes('wc.capturePage'), false);
  });
}
