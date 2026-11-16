'use strict';

// new-test-file: the request filter's blocked-host record is a new surface; browser-session-service.test.js is already past 600 lines.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { BrowserSessionService } = require('../services/browser-session-service');
const { createFakeBrowserWindowFactory } = require('./helpers/fake-browser-window');

function ask(factory, url) {
  let response = null;
  factory.windows[0].browserSession.webRequest.beforeRequestListener(
    { url, resourceType: 'script' },
    (value) => { response = value; }
  );
  return response;
}

async function openSession(sessionId = 'blocked_hosts') {
  const factory = createFakeBrowserWindowFactory();
  const service = new BrowserSessionService({ browserWindowFactory: factory });
  await service.open({ sessionId, streamId: 'stream_1', url: 'http://localhost:3000/page' });
  return { factory, service };
}

describe('BrowserSessionService / blocked external hosts', () => {
  test('records the lower-cased host of a blocked external request and reports a copy', async () => {
    const { factory, service } = await openSession();
    assert.deepEqual(service.blockedExternalHosts('blocked_hosts'), []);

    assert.deepEqual(ask(factory, 'https://CDN.jsdelivr.net/npm/three.module.js'), { cancel: true });
    assert.deepEqual(ask(factory, 'https://cdn.jsdelivr.net/npm/other.js'), { cancel: true });
    assert.deepEqual(service.blockedExternalHosts('blocked_hosts'), ['cdn.jsdelivr.net']);

    service.blockedExternalHosts('blocked_hosts').push('mutated.example');
    assert.deepEqual(service.blockedExternalHosts('blocked_hosts'), ['cdn.jsdelivr.net']);
  });

  test('keeps at most four hosts and ignores requests blocked for another reason', async () => {
    const { factory, service } = await openSession();
    for (const host of ['a.example', 'b.example', 'c.example', 'd.example', 'e.example']) {
      ask(factory, `https://${host}/x.js`);
    }
    ask(factory, 'ftp://ftp.example/file');
    assert.deepEqual(service.blockedExternalHosts('blocked_hosts'), ['a.example', 'b.example', 'c.example', 'd.example']);
  });

  test('reports nothing for an unknown session', async () => {
    const { service } = await openSession();
    assert.deepEqual(service.blockedExternalHosts('nope'), []);
  });
});

describe('BrowserSessionService / blocked scripts the page waits on', () => {
  const { waitsOnBlockedAsset } = require('../services/browser-session-security');
  const three = 'https://unpkg.com/three@0.160.0/build/three.module.js';
  const stats = 'https://stats.example/tag.js';

  test('a plain script tag and an imported module are waited on; an async tag is not', () => {
    const script = (url) => ({ type: 'script', url });
    assert.equal(waitsOnBlockedAsset([], []), false);
    assert.equal(waitsOnBlockedAsset([script(three)], [{ url: three, async: false }]), true);
    assert.equal(waitsOnBlockedAsset([script(three)], []), true, 'no tag: a module the page imports');
    assert.equal(waitsOnBlockedAsset([script(stats)], [{ url: stats, async: true }]), false);
    assert.equal(waitsOnBlockedAsset([script(stats), script(three)], [{ url: stats, async: true }, { url: three, async: false }]), true);
    assert.equal(waitsOnBlockedAsset([script(stats)], [{ url: stats, async: true }, { url: stats, async: false }]), true);
    assert.equal(waitsOnBlockedAsset([script(stats)], null), true, 'the page could not be asked');
  });

  test('the session asks the page for its script tags only when a script was refused', async () => {
    let tags = [{ url: stats, async: true }];
    const factory = createFakeBrowserWindowFactory({ scriptHandler: () => tags });
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'page', streamId: 'stream_1', url: 'http://localhost:3000/page' });
    const refuse = (url, resourceType) => factory.windows[0].browserSession.webRequest.beforeRequestListener({ url, resourceType }, () => {});

    refuse('https://pictures.example/a.png', 'image');
    refuse('https://fonts.example/css2?family=Inter', 'stylesheet');
    const asked = factory.windows[0].executedScripts.length;
    assert.equal(await service.pageWaitsOnBlockedAsset('page'), false);
    assert.equal(factory.windows[0].executedScripts.length, asked, 'a page draws without an image or a web-font stylesheet');

    refuse(stats, 'script');
    assert.equal(await service.pageWaitsOnBlockedAsset('page'), false);
    tags = [{ url: stats, async: false }];
    assert.equal(await service.pageWaitsOnBlockedAsset('page'), true);
    tags = [{ url: stats, async: true }];
    refuse(three, 'script');
    assert.equal(await service.pageWaitsOnBlockedAsset('page'), true);
    assert.equal(await service.pageWaitsOnBlockedAsset('nobody'), false);
    await service.dispose();
  });
});
