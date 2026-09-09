'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createRemoteControlBannerController } = require('../renderer/chat/renderer-remote-control-banner');
const { createSurfaceStatePipeline } = require('../renderer/chat/renderer-render-pipeline-surface-state');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function status(overrides = {}) {
  return { reachable: false, shared_sessions: [], ...overrides };
}

function harness(initial = status()) {
  const jsdom = new JSDOM(`<!doctype html><body>
    <div id="composerRemoteBanner" role="status" aria-live="polite">
      <span id="composerRemoteBannerLabel"></span>
      <span id="composerRemoteTakeControl"></span>
      <span id="composerRemoteStop"></span>
    </div></body>`);
  const document = jsdom.window.document;
  let current = initial;
  let listener = null;
  let unsubscribed = 0;
  let streaming = false;
  const calls = [];
  const remote = {
    async getState() { return current; },
    onStateChanged(callback) { listener = callback; return () => { unsubscribed += 1; }; },
    async takeControl(payload) { calls.push(['takeControl', payload]); return { ok: true }; },
    emit(next) { current = next; listener?.(next); },
  };
  const controller = createRemoteControlBannerController({
    state: { currentSessionId: 'session-1' },
    dom: {
      banner: document.getElementById('composerRemoteBanner'),
      label: document.getElementById('composerRemoteBannerLabel'),
      takeControlButton: document.getElementById('composerRemoteTakeControl'),
      stopButton: document.getElementById('composerRemoteStop'),
    },
    shell: { remote },
    callbacks: {
      stopActiveStream: () => calls.push(['stopActiveStream']),
      getCurrentSessionId: () => 'session-1',
      isSessionStreaming: () => streaming,
      appendClientLog: (...args) => calls.push(['log', ...args]),
    },
  });
  return {
    jsdom, document, remote, controller, calls,
    setStreaming(value) { streaming = value; },
    get unsubscribed() { return unsubscribed; },
  };
}

test('hidden by default, shows only for a reachable phone-controlled current session, and hides on authority loss', async () => {
  const h = harness();
  const banner = h.document.getElementById('composerRemoteBanner');
  assert.equal(banner.hidden, true);
  assert.equal(banner.getAttribute('aria-hidden'), 'true');
  h.remote.emit(status({
    reachable: true,
    shared_sessions: [{ id: 'session-1', title: 'Chat', controlled_by: 'device-1' }],
  }));
  assert.equal(banner.hidden, false);
  assert.equal(banner.getAttribute('aria-hidden'), 'false');
  assert.equal(h.document.getElementById('composerRemoteBannerLabel').textContent,
    'Your phone is controlling this conversation');

  h.remote.emit(status({
    reachable: true,
    shared_sessions: [{ id: 'session-1', controlled_by: 'desktop' }],
  }));
  assert.equal(banner.hidden, true, 'desktop ownership hides');
  h.remote.emit(status({ reachable: true, shared_sessions: [] }));
  assert.equal(banner.hidden, true, 'unsharing hides');
  h.remote.emit(status({
    reachable: false,
    shared_sessions: [{ id: 'session-1', controlled_by: 'device-1' }],
  }));
  assert.equal(banner.hidden, true, 'unreachable hides');
  h.controller.dispose();
  await flush();
});

test('Take control sends the current session id, disables while pending, and logs refusal', async () => {
  const h = harness(status({
    reachable: true,
    shared_sessions: [{ id: 'session-1', controlled_by: 'device-1' }],
  }));
  await flush();
  const pending = deferred();
  h.remote.takeControl = (payload) => {
    h.calls.push(['takeControl', payload]);
    return pending.promise;
  };
  const button = h.document.getElementById('composerRemoteTakeControl');
  button.click();
  assert.equal(button.disabled, true);
  assert.deepEqual(h.calls[0], ['takeControl', { session_id: 'session-1' }]);
  pending.resolve({ ok: false, reason: 'lease_changed' });
  await flush();
  assert.equal(button.disabled, false);
  assert.ok(h.calls.some((call) => call[0] === 'log' && call[2] === 'remote.take_control_refused'));
  h.controller.dispose();
});

test('Stop response follows streaming state and calls the shared stop callback', async () => {
  const h = harness(status({
    reachable: true,
    shared_sessions: [{ id: 'session-1', controlled_by: 'device-1' }],
  }));
  await flush();
  const stop = h.document.getElementById('composerRemoteStop');
  assert.equal(stop.hidden, true);
  h.setStreaming(true);
  h.controller.syncNow();
  assert.equal(stop.hidden, false);
  stop.click();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'stopActiveStream'), [['stopActiveStream']]);
  h.setStreaming(false);
  h.controller.syncNow();
  assert.equal(stop.hidden, true);
  h.controller.dispose();
});

test('composer lifecycle sync invokes the banner hook without a remote bridge refresh', () => {
  let syncs = 0;
  global.rendererRemoteControlBannerSync = () => { syncs += 1; };
  try {
    const pipeline = createSurfaceStatePipeline({
      state: { currentSessionId: 'session-1', ui: { chatMode: 'thread' } },
      dom: { chatView: { dataset: {} }, composerWrap: { dataset: {} }, composer: { dataset: {} } },
      callbacks: { getChatSendLifecycle: () => 'streaming' },
    });
    pipeline.syncStableChatSurfaceState();
    assert.equal(syncs, 1);
  } finally {
    delete global.rendererRemoteControlBannerSync;
  }
});

test('lifecycle composition refreshes after tab close and owns the global sync hook cleanup', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'renderer', 'app', 'renderer-app-lifecycle-composition.js'), 'utf8');
  assert.match(source, /closeWorkspaceSession:\s*closeWorkspaceSessionBase/);
  assert.match(source, /const withBannerRefresh = \(fn\) => async[\s\S]*?remoteControlBanner\?\.refresh\?\.\(\)/);
  assert.match(source, /const closeWorkspaceSession = withBannerRefresh\(closeWorkspaceSessionBase\)/);
  assert.match(source, /const activateWorkspaceSession = withBannerRefresh\(activateWorkspaceSessionBase\)/);
  assert.match(source, /window\.rendererRemoteControlBannerSync = syncRemoteControlBanner/);
  assert.match(source, /window\.rendererRemoteControlBannerSync = null/);
});

test('dispose unsubscribes and leaves the banner hidden', async () => {
  const h = harness(status({
    reachable: true,
    shared_sessions: [{ id: 'session-1', controlled_by: 'device-1' }],
  }));
  await flush();
  h.controller.dispose(); h.controller.dispose();
  assert.equal(h.unsubscribed, 1);
  assert.equal(h.document.getElementById('composerRemoteBanner').hidden, true);
});
