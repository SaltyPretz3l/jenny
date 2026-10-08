/**
 * EH-W10 gate: silent-path intake wiring. The route behavior (row 5
 * settings-refresh warning toast, row 6 offline/health-poll error-center
 * only) is table-tested in tests/renderer-error-intake.test.js; these
 * checks pin the catch-site wiring — each silent path reports with the
 * right origin and dedupe key while keeping its appendClientLog WARN.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

async function assertMemoryRefreshReports(t, omitReport = false, eventName = 'backend') {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const subscriptions = {}, reports = [], logs = [], refreshes = [];
  const subscribe = (name) => (handler) => { subscriptions[name] = handler; return () => { delete subscriptions[name]; }; };
  window.jennyShell = {
    diagnostics: { logs: { onEntry: subscribe('logs') } },
    backend: { onStatus: subscribe('backend') },
    auth: { getState: async () => ({ authenticated: true }), onState: subscribe('auth') },
  };
  const context = {
    window, document: window.document, AbortController: window.AbortController,
    rendererChatEventTranscriptBindings: { createTranscriptEventBindings: () => ({ bindTranscriptEvents() {}, dispose() {} }) },
    rendererChatEventSettingsBindings: { createSettingsEventBindings: () => ({ bindSettingsEvents() {} }) },
    rendererChatEventInteractiveBindings: { bindInteractiveComposerEvents() {} },
    rendererChatBackendRecoveryUtils: { recoverInflightSendsForUnusableBackend() {} },
    rendererAsyncFence: require('../renderer/shared/async-fence'),
    rendererEnterKeydownUtils: require('../renderer/chat/renderer-enter-keydown-utils'),
    rendererChatCtrlWheelGate: require('../renderer/chat/renderer-chat-ctrl-wheel-gate'),
  };
  vm.runInNewContext(readSource('renderer/chat/renderer-chat-event-utils.js'), context);
  const callbacks = new Proxy({
    reportError: omitReport ? null : (...args) => reports.push(args),
    appendClientLog: (...args) => logs.push(args),
    refreshApprovedMemories: async (options) => { refreshes.push(options); throw new Error('memory refresh rejected'); },
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  const bindings = context.rendererChatEventUtils.createChatEventBindings({
    state: { ui: { activeView: 'chat' } }, constants: { TOAST_SOURCE: { memory: 'memory' }, ACTIVITY_SCOPE: {} },
    callbacks, controllers: {}, dom: {},
  });
  t.after(() => { bindings.dispose(); window.close(); });
  bindings.bind();
  for (const [event, payload, warnEvent] of [
    ['backend', { phase: 'ready' }, 'chat.refresh_memories_failed'],
    ['auth', { authenticated: true }, 'chat.auth_refresh_memories_failed'],
  ]) {
    if (event !== eventName) continue;
    reports.length = 0; logs.length = 0; refreshes.length = 0;
    await subscriptions[event](payload);
    // VM-created objects have a different prototype; compare their wire values.
    assert.deepEqual(JSON.parse(JSON.stringify(refreshes)), [{ force: true }]);
    assert.deepEqual(JSON.parse(JSON.stringify(logs.filter(([level]) => level === 'WARN'))), [
      ['WARN', warnEvent, { message: 'memory refresh rejected' }],
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(reports)), [[{
      message: 'Approved memories could not be refreshed.',
      options: { source: 'memory', dedupeKey: 'settings-refresh:memories' },
    }, { origin: 'settings-refresh' }]], `${event} refresh failure must reach error intake`);
  }
}

test('settings-refresh failures report with origin settings-refresh and keep their WARN logs', async (t) => {
  for (const event of ['backend', 'auth']) {
    await t.test(event, async (st) => {
      await assertMemoryRefreshReports(st, false, event);
      await assert.rejects(() => assertMemoryRefreshReports(st, true, event), {
        code: 'ERR_ASSERTION', message: new RegExp(`${event} refresh failure must reach error intake`),
      });
    });
  }
});

test('offline/companion refresh failures report with origin offline-refresh', () => {
  // The home-view hydration catches (companion refresh + the home-view
  // activation offline catch) were extracted to renderer-home-view-hydrate.js;
  // the bootstrap offline catch stays in renderer-lifecycle-utils.js. Read both
  // so the silent-path wiring is pinned wherever the catch-site now lives.
  const source = [
    readSource('renderer/shell/renderer-lifecycle-utils.js'),
    readSource('renderer/shell/renderer-home-view-hydrate.js'),
  ].join('\n');

  assert.match(source, /dedupeKey: 'offline-refresh:companion' \}, \{ origin: 'offline-refresh' \}/);
  const offlineSites = source.match(/dedupeKey: 'offline-refresh:offline' \}, \{ origin: 'offline-refresh' \}/g) || [];
  assert.equal(offlineSites.length, 2, 'home-view activation + bootstrap offline catches both report');
  assert.ok(source.includes("'reportError'"), 'reportError forwarded through FWD_KEYS');
  for (const warnEvent of ['home.refresh_companion_failed', 'home.refresh_offline_failed', 'offline.bootstrap_failed']) {
    assert.ok(source.includes(warnEvent), `observability WARN ${warnEvent} kept`);
  }
});

test('health pill controller is wired with the flag-gated intake route', () => {
  const composition = readSource('renderer/app/renderer-app-controller-composition.js');
  const healthPillBlock = composition.slice(
    composition.indexOf('createHealthPillController'),
    composition.indexOf('headerController')
  );
  assert.match(healthPillBlock, /reportError: \(\.\.\.a\) => reportErrorWhenActive\(\.\.\.a\)/);
});
