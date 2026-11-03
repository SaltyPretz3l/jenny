const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  createSettingsChangeBroadcast,
  CHAT_UI_REASONS,
} = require('../services/main/settings-change-broadcast');

function createFixture({ zoomFactor = 1.1, windowDestroyed = false, setZoomThrows = false } = {}) {
  const config = new EventEmitter();
  config.chatUi = { defaultRunMode: 'ask', use24HourTime: true };
  config.windowUi = { appZoomPercent: 125, notifications: { enabled: true } };
  config.ideStore = { preferences: { fontSize: 14 }, roots: { r1: { openTabs: ['secret-tab'] } } };
  config.getChatUiState = () => config.chatUi;
  config.getWindowUiState = () => config.windowUi;
  config.getWorkspaceIdeStore = () => config.ideStore;
  const sent = [];
  const zoomCalls = [];
  const webContents = {
    getZoomFactor: () => zoomFactor,
    setZoomFactor: (value) => {
      if (setZoomThrows) throw new Error('frame gone');
      zoomCalls.push(value);
    },
  };
  const win = { isDestroyed: () => windowDestroyed, webContents };
  const logs = [];
  const broadcast = createSettingsChangeBroadcast({
    shellConfigService: config,
    sendBridgeEvent: (pathName, payload) => sent.push([pathName, payload]),
    getWindow: () => win,
    log: (...args) => logs.push(args),
  });
  const commit = (reason, details = {}) => config.emit('changed', {}, { reason, ...details });
  return { config, broadcast, sent, zoomCalls, logs, commit };
}

test('every chat-UI commit reason maps to chatUi.onChanged with the getState payload', () => {
  const fx = createFixture();
  for (const reason of CHAT_UI_REASONS) fx.commit(reason);
  assert.equal(fx.sent.length, CHAT_UI_REASONS.size);
  for (const [channel, payload] of fx.sent) {
    assert.equal(channel, 'chatUi.onChanged');
    assert.equal(payload, fx.config.chatUi);
  }
});

test('the chat-UI reason list stays in step with shell-config-service CHAT_UI_TOP_LEVEL_FIELDS', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'shell-config-service.js'), 'utf8');
  const block = source.match(/const CHAT_UI_TOP_LEVEL_FIELDS = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'CHAT_UI_TOP_LEVEL_FIELDS block found');
  const reasons = [...block[1].matchAll(/'([a-z0-9_]+_updated)'\]/g)].map((match) => match[1]);
  assert.ok(reasons.length >= 6);
  for (const reason of reasons) assert.ok(CHAT_UI_REASONS.has(reason), `${reason} is broadcast`);
  assert.ok(CHAT_UI_REASONS.has('chat_ui_settings_updated'));
});

test('a multi-reason chat-UI commit sends exactly one event', () => {
  const fx = createFixture();
  fx.commit('chat_ui_settings_updated', { reasons: ['time_format_updated', 'default_run_mode_updated', 'chat_ui_settings_updated'] });
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0][0], 'chatUi.onChanged');
});

test('window_ui_settings_updated sends windowUi.onChanged and applies a different zoom', () => {
  const fx = createFixture({ zoomFactor: 1.1 });
  fx.commit('window_ui_settings_updated');
  assert.deepEqual(fx.sent, [['windowUi.onChanged', fx.config.windowUi]]);
  assert.deepEqual(fx.zoomCalls, [1.25]);
});

test('zoom is left alone when the window already runs at the stored percent', () => {
  const fx = createFixture({ zoomFactor: 1.25 });
  fx.commit('window_ui_settings_updated');
  assert.equal(fx.sent.length, 1);
  assert.deepEqual(fx.zoomCalls, []);
});

test('a destroyed window or a throwing setZoomFactor never breaks the broadcast', () => {
  const destroyed = createFixture({ windowDestroyed: true });
  assert.doesNotThrow(() => destroyed.commit('window_ui_settings_updated'));
  assert.equal(destroyed.sent.length, 1);
  assert.deepEqual(destroyed.zoomCalls, []);

  const throwing = createFixture({ setZoomThrows: true });
  assert.doesNotThrow(() => throwing.commit('window_ui_settings_updated'));
  assert.equal(throwing.sent.length, 1);
  assert.equal(throwing.logs.length, 1);
  assert.equal(throwing.logs[0][1], 'settings_change_broadcast.zoom_failed');
});

test('a missing window or a nonsense zoom percent applies nothing', () => {
  const fx = createFixture();
  fx.config.windowUi = { appZoomPercent: 'abc' };
  fx.commit('window_ui_settings_updated');
  assert.deepEqual(fx.zoomCalls, []);
  const noWindow = createSettingsChangeBroadcast({
    shellConfigService: fx.config,
    sendBridgeEvent: () => {},
    getWindow: () => null,
  });
  fx.config.windowUi = { appZoomPercent: 150 };
  assert.doesNotThrow(() => fx.commit('window_ui_settings_updated'));
  noWindow.dispose();
});

test('workspace IDE preferences send the preferences object only, never per-root state', () => {
  const fx = createFixture();
  fx.commit('workspace_ide_preferences_updated');
  assert.deepEqual(fx.sent, [['workspaceIde.onPreferencesChanged', { fontSize: 14 }]]);
  fx.commit('workspace_ide_state_updated');
  fx.commit('workspace_ide_root_touched');
  assert.equal(fx.sent.length, 1);
});

test('unrelated reasons send nothing', () => {
  const fx = createFixture();
  for (const reason of ['feature_settings_updated', 'workspace_state_updated', 'tools_web_enabled_updated', 'skills_settings_updated', 'updated']) {
    fx.commit(reason);
  }
  fx.config.emit('changed', {}, undefined);
  fx.config.emit('changed', {});
  assert.deepEqual(fx.sent, []);
  assert.deepEqual(fx.zoomCalls, []);
});

test('a throwing sender is contained and logged', () => {
  const config = new EventEmitter();
  config.getChatUiState = () => ({});
  const logs = [];
  createSettingsChangeBroadcast({
    shellConfigService: config,
    sendBridgeEvent: () => { throw new Error('window gone'); },
    log: (...args) => logs.push(args),
  });
  assert.doesNotThrow(() => config.emit('changed', {}, { reason: 'time_format_updated' }));
  assert.equal(logs[0][1], 'settings_change_broadcast.send_failed');
});

test('dispose removes the listener', () => {
  const fx = createFixture();
  assert.equal(fx.config.listenerCount('changed'), 1);
  fx.broadcast.dispose();
  assert.equal(fx.config.listenerCount('changed'), 0);
  fx.commit('time_format_updated');
  assert.deepEqual(fx.sent, []);
});

test('a service without an emitter yields an inert broadcaster', () => {
  const broadcast = createSettingsChangeBroadcast({ shellConfigService: null });
  assert.deepEqual(Object.keys(broadcast), ['dispose']);
  assert.equal(broadcast.dispose(), undefined);
});
