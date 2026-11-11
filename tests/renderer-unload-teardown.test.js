'use strict';

// Chromium runs beforeunload in the renderer before the main process can cancel the navigation in
// will-navigate. So a chat link the window guard blocks still fires it, and the page then lives on:
// anything torn down there stays dead for the rest of the session. One clicked link stopped every
// live stream until the app was restarted (2026-11-09). Teardown belongs on pagehide, which fires
// only when the page is really going away.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createHarness } = require('./helpers/renderer-stream-handler-harness');

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const TEARDOWN_ON_BEFOREUNLOAD = /addEventListener\??\.?\(\s*['"]beforeunload['"]\s*,\s*(?:[\w.]*(?:dispose|teardown|destroy)\b|\([^)]*\)\s*=>[^\n]*(?:dispose|teardown|destroy))/i;

function rendererScripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return rendererScripts(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function fakeUnloadWindow() {
  const listeners = new Map();
  return {
    jennyShell: { sessions: { async getMessages() { return { data: [] }; } } },
    addEventListener(name, handler) { listeners.set(name, [...(listeners.get(name) || []), handler]); },
    removeEventListener(name, handler) { listeners.set(name, (listeners.get(name) || []).filter((entry) => entry !== handler)); },
    fire(name) { for (const handler of listeners.get(name) || []) handler(); },
  };
}

test('no renderer module tears itself down on beforeunload', () => {
  const offenders = rendererScripts(RENDERER_ROOT)
    .filter((file) => TEARDOWN_ON_BEFOREUNLOAD.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(RENDERER_ROOT, file));
  assert.deepEqual(offenders, []);
});

test('the scan recognises the shapes it is there to stop', () => {
  for (const source of [
    "window.addEventListener('beforeunload', dispose);",
    "root.addEventListener('beforeunload', dispose, { once: true });",
    "root.addEventListener?.('beforeunload', () => root.controller?.dispose?.(), { once: true });",
  ]) assert.match(source, TEARDOWN_ON_BEFOREUNLOAD);
  assert.doesNotMatch("windowRef.addEventListener?.('beforeunload', flushOnUnload);", TEARDOWN_ON_BEFOREUNLOAD);
});

test('a navigation the window guard blocks leaves the live stream subscribed', (t) => {
  const fakeWindow = fakeUnloadWindow();
  const harness = createHarness({ stateOverrides: { window: fakeWindow } });
  t.after(() => harness.restore());
  let unsubscribed = 0;
  harness.handler.registerStreamHandler({ chat: { onStream() { return () => { unsubscribed += 1; }; } } });

  fakeWindow.fire('beforeunload');
  assert.equal(unsubscribed, 0, 'the page has not gone anywhere yet');

  fakeWindow.fire('pagehide');
  assert.equal(unsubscribed, 1, 'the page really is going away');
});
