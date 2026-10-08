'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { BrowserSessionService } = require('../services/browser-session-service');
const { createFakeBrowserWindowFactory } = require('./helpers/fake-browser-window');

describe('BrowserSessionService / fresh frame before capture', () => {
  async function openRecording(factoryOptions = {}, serviceOptions = {}) {
    const order = [];
    const factory = createFakeBrowserWindowFactory(factoryOptions);
    const service = new BrowserSessionService({ browserWindowFactory: factory, ...serviceOptions });
    await service.open({ sessionId: 'frame_session', url: 'http://localhost:3000/' });
    const contents = factory.windows[0].webContents;
    const originalCapture = contents.capturePage;
    const originalExecute = contents.executeJavaScript;
    const subscriptions = [];
    contents.invalidate = () => { order.push('invalidate'); };
    contents.beginFrameSubscription = (...args) => { order.push('subscribe'); subscriptions.push(args); };
    contents.endFrameSubscription = () => { order.push('unsubscribe'); };
    contents.capturePage = async (...args) => { order.push('capture'); return originalCapture(...args); };
    contents.executeJavaScript = async (...args) => {
      order.push(/requestAnimationFrame/.test(String(args[0])) ? 'frame_wait' : 'script');
      return originalExecute(...args);
    };
    return { order, service, subscriptions, window: factory.windows[0] };
  }

  test('screenshot holds frame production through the frame wait and the capture', async () => {
    const { order, service, subscriptions } = await openRecording();
    await service.screenshot('frame_session');
    assert.deepEqual(order, ['subscribe', 'invalidate', 'frame_wait', 'capture', 'unsubscribe']);
    // Dirty-only frames keep the hold cheap; the frames themselves are unused.
    assert.equal(subscriptions[0][0], true);
    assert.equal(typeof subscriptions[0][1], 'function');
  });

  test('the capture keeps the hidden page hidden', async () => {
    const { service, window } = await openRecording();
    const contents = window.webContents;
    const seen = [];
    const original = contents.capturePage;
    contents.capturePage = async (...args) => { seen.push(args); return original(...args); };
    await service.screenshot('frame_session');
    assert.deepEqual(seen, [[undefined, { stayHidden: true }]]);
  });

  test('without a frame subscription API the capture still follows the frame wait', async () => {
    const { order, service, window } = await openRecording();
    delete window.webContents.beginFrameSubscription;
    delete window.webContents.endFrameSubscription;
    const shot = await service.screenshot('frame_session');
    assert.equal(shot.mime_type, 'image/png');
    assert.deepEqual(order, ['invalidate', 'frame_wait', 'capture']);
  });

  test('a throwing frame subscription is skipped and never released', async () => {
    const { order, service, window } = await openRecording();
    window.webContents.beginFrameSubscription = () => { throw new Error('no view'); };
    const shot = await service.screenshot('frame_session');
    assert.equal(shot.mime_type, 'image/png');
    assert.deepEqual(order, ['invalidate', 'frame_wait', 'capture']);
  });

  test('a throwing release does not fail the screenshot', async () => {
    const { order, service, window } = await openRecording();
    window.webContents.endFrameSubscription = () => { order.push('unsubscribe'); throw new Error('gone'); };
    const shot = await service.screenshot('frame_session');
    assert.equal(shot.mime_type, 'image/png');
    assert.deepEqual(order, ['subscribe', 'invalidate', 'frame_wait', 'capture', 'unsubscribe']);
  });

  test('a failed capture still releases frame production', async () => {
    const { order, service, window } = await openRecording();
    window.webContents.capturePage = async () => { order.push('capture'); throw new Error('copy failed'); };
    await assert.rejects(() => service.screenshot('frame_session'), /copy failed/);
    assert.deepEqual(order, ['subscribe', 'invalidate', 'frame_wait', 'capture', 'unsubscribe']);
  });

  test('a hung frame wait is abandoned and the capture still happens', async () => {
    const { order, service } = await openRecording(
      { scriptHandler: () => new Promise(() => {}) },
      { setTimeoutImpl: (fn, ms, ...rest) => setTimeout(fn, ms === 1000 ? 5 : ms, ...rest) }
    );
    const shot = await service.screenshot('frame_session');
    assert.deepEqual(order, ['subscribe', 'invalidate', 'frame_wait', 'capture', 'unsubscribe']);
    assert.equal(shot.mime_type, 'image/png');
  });

  test('a throwing invalidate or frame wait is swallowed', async () => {
    const { order, service, window } = await openRecording();
    window.webContents.invalidate = () => { throw new Error('gone'); };
    window.webContents.executeJavaScript = async () => { throw new Error('page crashed'); };
    const shot = await service.screenshot('frame_session');
    assert.equal(shot.mime_type, 'image/png');
    assert.deepEqual(order, ['subscribe', 'capture', 'unsubscribe']);
  });

  test('abort during the frame wait rejects without capturing and releases frame production', async () => {
    const { order, service } = await openRecording({ scriptHandler: () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = service.screenshot('frame_session', { abortSignal: controller.signal })
      .then(() => 'resolved', (error) => error.name);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    assert.equal(await pending, 'AbortError');
    assert.equal(order.includes('capture'), false);
    assert.deepEqual(order, ['subscribe', 'invalidate', 'frame_wait', 'unsubscribe']);
    service.disposeSync();
  });
});

describe('BrowserSessionService / hover, focus and press', () => {
  const ready = { status: 'ready', selector: '#a', rect: { center_x: 30, center_y: 12, width: 10, height: 6 } };

  async function openWith(scriptHandler) {
    const factory = createFakeBrowserWindowFactory({ scriptHandler });
    const service = new BrowserSessionService({ browserWindowFactory: factory });
    await service.open({ sessionId: 'act_session', url: 'http://localhost:3000/' });
    return { service, window: factory.windows[0] };
  }

  test('hover sends only a mouseMove to the element centre', async () => {
    const { service, window } = await openWith(() => ready);
    const result = await service.hover('act_session', { selector: '#a' });
    assert.equal(result.status, 'hovered');
    assert.equal(result.selector, '#a');
    assert.deepEqual(window.inputEvents.map((e) => e.type), ['mouseMove']);
    assert.equal(window.inputEvents[0].x, 30);
    assert.equal(window.inputEvents[0].y, 12);
  });

  test('hover reports selector misses without dispatching input', async () => {
    const { service, window } = await openWith(() => ({ status: 'selector_miss', reason: 'selector_not_found' }));
    const result = await service.hover('act_session', { selector: '#a' });
    assert.equal(result.status, 'selector_miss');
    assert.deepEqual(window.inputEvents, []);
  });

  test('focus uses a focus-any probe and reports focused', async () => {
    const { service, window } = await openWith(() => ready);
    const result = await service.focus('act_session', { selector: '#a' });
    assert.equal(result.status, 'focused');
    assert.equal(window.executedScripts.length, 1);
    assert.deepEqual(window.inputEvents, []);
  });

  test('focus passes through a not-focusable status', async () => {
    const { service } = await openWith(() => ({ status: 'selector_not_focusable', reason: 'selector_not_focusable' }));
    const result = await service.focus('act_session', { selector: '#a' });
    assert.equal(result.status, 'selector_not_focusable');
  });

  test('press without a selector dispatches keyDown then keyUp with Electron key names', async () => {
    const { service, window } = await openWith(() => ready);
    const result = await service.press('act_session', { key: 'ArrowDown' });
    assert.equal(result.status, 'pressed');
    assert.equal(result.key, 'ArrowDown');
    assert.deepEqual(window.inputEvents.map((e) => `${e.type}:${e.keyCode}`), ['keyDown:Down', 'keyUp:Down']);
    // Only the keyup acknowledgement runs: arm, then wait.
    assert.equal(window.executedScripts.length, 2);
    assert.ok(window.executedScripts.every((script) => /__jennyInputAck/.test(script)));
  });

  // Gate follow-up 2026-10-05: a later focus overtook queued keys, so `focus #b`
  // after `press Enter` on #a sometimes landed the Enter on #b.
  test('a key press is acknowledged by the page before the next action can run', async () => {
    const log = [];
    const { service, window } = await openWith((script) => {
      log.push(/addEventListener\('keyup'/.test(script) ? 'arm' : /__jennyInputAck/.test(script) ? 'wait' : 'focus');
      return ready;
    });
    const send = window.webContents.sendInputEvent;
    window.webContents.sendInputEvent = (event) => { log.push(event.type); return send.call(window.webContents, event); };
    await service.press('act_session', { key: 'Enter', selector: '#a' });
    await service.focus('act_session', { selector: '#b' });
    assert.deepEqual(log, ['focus', 'arm', 'keyDown', 'char', 'keyUp', 'wait', 'focus']);
  });

  test('a page that cannot be armed still gets the key, without a wait', async () => {
    const { service, window } = await openWith((script) => {
      if (/addEventListener\('keyup'/.test(script)) throw new Error('context gone');
      return ready;
    });
    const result = await service.press('act_session', { key: 'Space' });
    assert.equal(result.status, 'pressed');
    assert.deepEqual(window.inputEvents.map((e) => e.type), ['keyDown', 'char', 'keyUp']);
    assert.equal(window.executedScripts.length, 1, 'no wait after a failed arm');
  });

  test('a page that never acknowledges does not fail the press', async () => {
    const { service, window } = await openWith((script) => {
      if (/__jennyInputAck = null/.test(script)) throw new Error('Browser input acknowledgement timed out.');
      return ready;
    });
    const result = await service.press('act_session', { key: 'Enter' });
    assert.equal(result.status, 'pressed');
    assert.equal(window.inputEvents.length, 3);
  });

  test('press Enter and Space add a char event between keyDown and keyUp', async () => {
    const { service, window } = await openWith(() => ready);
    await service.press('act_session', { key: 'Enter' });
    await service.press('act_session', { key: 'Space' });
    assert.deepEqual(
      window.inputEvents.map((e) => `${e.type}:${e.keyCode}`),
      ['keyDown:Enter', 'char:Enter', 'keyUp:Enter', 'keyDown:Space', 'char:Space', 'keyUp:Space']
    );
  });

  test('press " " is the Space key (alias resolved before trimming)', async () => {
    const { service, window } = await openWith(() => ready);
    const result = await service.press('act_session', { key: ' ' });
    assert.equal(result.status, 'pressed');
    assert.deepEqual(
      window.inputEvents.map((e) => `${e.type}:${e.keyCode}`),
      ['keyDown:Space', 'char:Space', 'keyUp:Space']
    );
  });

  test('press with a selector focuses first and stops when focus fails', async () => {
    const { service, window } = await openWith(() => ({ status: 'selector_not_focusable', reason: 'selector_not_focusable' }));
    const result = await service.press('act_session', { key: 'Enter', selector: '#a' });
    assert.equal(result.status, 'selector_not_focusable');
    assert.deepEqual(window.inputEvents, []);
  });

  test('press with a selector focuses then sends the key', async () => {
    const { service, window } = await openWith(() => ready);
    const result = await service.press('act_session', { key: 'Tab', selector: '#a' });
    assert.equal(result.status, 'pressed');
    assert.equal(window.executedScripts.filter((script) => !/__jennyInputAck/.test(script)).length, 1);
    assert.deepEqual(window.inputEvents.map((e) => e.type), ['keyDown', 'keyUp']);
  });

  test('press rejects a key outside the allowlist before any input', async () => {
    const { service, window } = await openWith(() => ready);
    await assert.rejects(service.press('act_session', { key: 'F5' }), /key/i);
    await assert.rejects(service.press('act_session', {}), /key/i);
    assert.deepEqual(window.inputEvents, []);
  });
});
