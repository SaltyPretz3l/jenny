'use strict';

// Row 88 D6: createExternalSettingsSync folds chatUi / windowUi / workspace-IDE preference
// commits made in main by any writer into renderer state, echo-safe and never writing back.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createExternalSettingsSync } = require('../renderer/shell/renderer-settings-support');
const editorSection = require('../renderer/shell/renderer-settings-editor-section');
const ideState = require('../renderer/features/renderer-ide-state');
const { normalizeNotificationSettings } = require('../renderer/shell/renderer-desktop-notifications');

function makeHarness({ stateOverrides = {}, transcript = true, editor = true } = {}) {
  const calls = { renderAll: 0, renderSettings: 0, reapplyIde: [], timeFormat: [], writes: [], adopted: [], logs: [] };
  const handlers = {};
  const storage = new Map();
  const state = {
    use24HourTime: false,
    defaultRunMode: 'ask',
    uiLanguage: 'en',
    safetyMode: 'normal',
    unattendedGuardMinutes: 0,
    autoApproveStreakCap: 50,
    digestQuietStart: '22:00',
    digestQuietEnd: '07:00',
    transcriptViewDefault: 'thinking',
    currentSessionId: '',
    runtimeDraft: { runMode: 'ask' },
    ui: { appZoomPercent: 110, notifications: normalizeNotificationSettings({}), dictation: { deviceId: '' }, ide: {} },
    ...stateOverrides,
  };
  const subscribe = (name) => (fn) => { handlers[name] = fn; return () => { handlers[name] = null; }; };
  // Every writer on the bridge is a spy: the sync must never call any of them.
  const writer = (name) => () => { calls.writes.push(name); };
  const windowRef = {
    localStorage: { setItem: (key, value) => storage.set(key, value) },
    jennyShell: {
      chatUi: { onChanged: subscribe('chatUi'), updateSettings: writer('chatUi.updateSettings') },
      windowUi: { onChanged: subscribe('windowUi'), updateSettings: writer('windowUi.updateSettings') },
      workspaceIde: { onPreferencesChanged: subscribe('ide'), updateSettings: writer('workspaceIde.updateSettings') },
    },
    rendererDesktopNotifications: { normalizeNotificationSettings },
    rendererSettingsEditorSection: editor ? editorSection : undefined,
    rendererIdeState: ideState,
    rendererTranscriptViewController: transcript ? {
      adoptDefault(view) {
        calls.adopted.push(view);
        state.transcriptViewDefault = view;
      },
    } : null,
  };
  const previousI18n = globalThis.jennyI18n;
  globalThis.jennyI18n = { ...(previousI18n || {}), setTimeFormat: (value) => calls.timeFormat.push(value) };
  const sync = createExternalSettingsSync({
    state,
    windowRef,
    renderAll: () => { calls.renderAll += 1; },
    renderSettings: () => { calls.renderSettings += 1; },
    reapplyIde: (keys) => calls.reapplyIde.push(keys),
    appendClientLog: (...args) => calls.logs.push(args),
  });
  return { sync, state, calls, handlers, storage, restore: () => { globalThis.jennyI18n = previousI18n; } };
}

test('chatUi payload with changes updates state, applies the side effects and repaints', (t) => {
  const { sync, state, calls, storage, restore } = makeHarness();
  t.after(restore);
  const changed = sync.applyChatUi({
    use24HourTime: true, defaultRunMode: 'plan', uiLanguage: 'es', safetyMode: 'normal',
    unattendedGuardMinutes: 15, autoApproveStreakCap: 50, transcriptViewDefault: 'answers',
  });
  assert.deepEqual(
    [...changed].sort(),
    ['defaultRunMode', 'transcriptViewDefault', 'uiLanguage', 'unattendedGuardMinutes', 'use24HourTime'],
  );
  assert.equal(state.use24HourTime, true);
  assert.deepEqual(calls.timeFormat, [true]);
  assert.equal(state.defaultRunMode, 'plan');
  assert.equal(state.runtimeDraft.runMode, 'plan', 'a draft with no session follows the new default');
  assert.equal(storage.get('jenny.ui.language'), state.uiLanguage);
  assert.equal(state.unattendedGuardMinutes, 15);
  assert.deepEqual(calls.adopted, ['answers']);
  assert.equal(calls.renderAll, 1);
  assert.equal(calls.renderSettings, 1);
});

test('chatUi digest quiet hours fold in through the shared normalizer (row 86)', (t) => {
  const { sync, state, calls, restore } = makeHarness();
  t.after(restore);
  const support = require('../renderer/shell/renderer-settings-support');
  assert.equal(support.normalizeDigestQuietStart, require('../renderer/shared/string-utils').normalizeDigestQuietStart, 'one normalizer, not a copy');
  assert.deepEqual(sync.applyChatUi({ digestQuietStart: '23:30', digestQuietEnd: '07:00' }), ['digestQuietStart']);
  assert.equal(state.digestQuietStart, '23:30');
  assert.deepEqual(sync.applyChatUi({ digestQuietStart: '23:45', digestQuietEnd: '05:30' }).sort(), ['digestQuietEnd', 'digestQuietStart']);
  assert.deepEqual([state.digestQuietStart, state.digestQuietEnd], ['22:00', '05:30']);
  assert.equal(calls.renderSettings, 2);
});

test('chatUi default run mode leaves a live session draft alone', (t) => {
  const { sync, state, restore } = makeHarness({ stateOverrides: { currentSessionId: 's1' } });
  t.after(restore);
  sync.applyChatUi({ defaultRunMode: 'propose' });
  assert.equal(state.defaultRunMode, 'propose');
  assert.equal(state.runtimeDraft.runMode, 'ask');
});

test('an echo of current state changes and repaints nothing and never writes back', (t) => {
  const { sync, state, calls, restore } = makeHarness();
  t.after(restore);
  const echo = {
    use24HourTime: false, defaultRunMode: 'ask', uiLanguage: 'en', safetyMode: 'normal',
    unattendedGuardMinutes: 0, autoApproveStreakCap: 50, transcriptViewDefault: 'thinking', zoomPercent: 100,
  };
  assert.deepEqual(sync.applyChatUi(echo), []);
  assert.deepEqual(sync.applyWindowUi({
    appZoomPercent: 110, notifications: state.ui.notifications, dictation: { deviceId: '' },
  }), []);
  assert.deepEqual(sync.applyIdePreferences({}), []);
  assert.equal(calls.renderAll, 0);
  assert.equal(calls.renderSettings, 0);
  assert.deepEqual(calls.timeFormat, []);
  assert.deepEqual(calls.writes, []);
});

test('only the keys present in a partial payload are touched; garbage payloads are ignored', (t) => {
  const { sync, state, calls, restore } = makeHarness();
  t.after(restore);
  assert.deepEqual(sync.applyChatUi({ safetyMode: 'normal' }), []);
  assert.equal(state.defaultRunMode, 'ask');
  for (const junk of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(sync.applyChatUi(junk), []);
    assert.deepEqual(sync.applyWindowUi(junk), []);
    assert.deepEqual(sync.applyIdePreferences(junk), []);
  }
  assert.equal(calls.renderSettings, 0);
});

test('a safety-only change repaints Settings but not the whole shell', (t) => {
  const { sync, state, calls, restore } = makeHarness();
  t.after(restore);
  assert.deepEqual(sync.applyChatUi({ safetyMode: 'strict' }), ['safetyMode']);
  assert.equal(state.safetyMode, 'strict');
  assert.equal(calls.renderAll, 0);
  assert.equal(calls.renderSettings, 1);
});

test('windowUi zoom, notifications and dictation device are adopted and repaint once', (t) => {
  const { sync, state, calls, restore } = makeHarness();
  t.after(restore);
  const notifications = normalizeNotificationSettings({ enabled: false });
  const changed = sync.applyWindowUi({ appZoomPercent: 125, notifications, dictation: { deviceId: 'mic-1' } });
  assert.deepEqual([...changed].sort(), ['appZoomPercent', 'dictation', 'notifications']);
  assert.equal(state.ui.appZoomPercent, 125);
  assert.equal(state.ui.notifications.enabled, false);
  assert.equal(state.ui.dictation.deviceId, 'mic-1');
  assert.equal(calls.renderSettings, 1);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(sync.applyWindowUi({ appZoomPercent: 125, notifications, dictation: { deviceId: 'mic-1' } }), []);
  assert.equal(calls.renderSettings, 1);
});

test('before Settings loads its editor section, an open IDE still takes the change (no stale write-back)', (t) => {
  const { sync, state, calls, restore } = makeHarness({ editor: false });
  t.after(restore);
  state.ui.ide = ideState.createIdeUiState();
  const persisted = ideState.toPersistedState(state.ui.ide).preferences || {};
  const changed = sync.applyIdePreferences({ ...persisted, fontSize: 18, tabSize: 4, autoSaveMode: 'afterDelay' });
  assert.deepEqual([...changed].sort(), ['autoSaveEnabled', 'autoSaveMode', 'fontSize', 'tabSize']);
  assert.equal(state.ui.ide.fontSize, 18);
  assert.equal(state.ui.ide.tabSize, 4);
  assert.equal(state.ui.ide.autoSaveEnabled, true);
  assert.deepEqual(calls.reapplyIde, [changed]);
  assert.deepEqual(sync.applyIdePreferences({ fontSize: 18 }), [], 'an echo changes nothing');
  assert.deepEqual(sync.applyIdePreferences({ tabSize: 8 }).length, 1, 'a partial payload touches only its keys');
  assert.equal(state.ui.ide.fontSize, 18);
  assert.deepEqual(calls.writes, []);
});

test('IDE preferences update the editor slice, repaint Settings and re-apply open editors', (t) => {
  const { sync, state, calls, restore } = makeHarness();
  t.after(restore);
  state.ui.ide = { fontSize: 14, tabSize: 2 };
  const changed = sync.applyIdePreferences({ fontSize: 16, tabSize: 2, notAnEditorKey: 'x' });
  assert.deepEqual(changed, ['fontSize']);
  assert.equal(state.ui.ide.fontSize, 16);
  assert.equal('notAnEditorKey' in state.ui.ide, false);
  assert.equal(calls.renderSettings, 1);
  assert.deepEqual(calls.reapplyIde, [['fontSize']]);
  assert.deepEqual(sync.applyIdePreferences({ fontSize: 16, tabSize: 2 }), []);
  assert.equal(calls.reapplyIde.length, 1);
  assert.deepEqual(calls.writes, []);
});

test('bind subscribes the three events once, routes payloads, and unbinds', (t) => {
  const { sync, state, handlers, calls, restore } = makeHarness();
  t.after(restore);
  const unbind = sync.bind();
  assert.equal(typeof handlers.chatUi, 'function');
  assert.equal(typeof handlers.windowUi, 'function');
  assert.equal(typeof handlers.ide, 'function');
  handlers.chatUi({ use24HourTime: true });
  handlers.windowUi({ appZoomPercent: 150 });
  state.ui.ide = {};
  handlers.ide({ tabSize: 8 });
  assert.equal(state.use24HourTime, true);
  assert.equal(state.ui.appZoomPercent, 150);
  assert.equal(state.ui.ide.tabSize, 8);
  unbind();
  assert.equal(handlers.chatUi, null);
  assert.equal(handlers.windowUi, null);
  assert.equal(handlers.ide, null);
  assert.deepEqual(calls.writes, []);
});

test('a throwing repaint is logged and never reaches the bridge', () => {
  const handlers = {};
  const logs = [];
  const throwing = createExternalSettingsSync({
    state: { ui: {}, safetyMode: 'normal' },
    windowRef: {
      jennyShell: { chatUi: { onChanged: (fn) => { handlers.chatUi = fn; return () => {}; } } },
    },
    renderSettings: () => { throw new Error('boom'); },
    appendClientLog: (...args) => logs.push(args),
  });
  throwing.bind();
  assert.doesNotThrow(() => handlers.chatUi({ safetyMode: 'strict' }));
  assert.equal(logs[0][1], 'settings.external_change_failed');
});

test('bind tolerates a missing bridge', () => {
  const sync = createExternalSettingsSync({ state: {}, windowRef: {} });
  const unbind = sync.bind();
  assert.equal(typeof unbind, 'function');
  assert.equal(unbind(), undefined);
});

test('adoptExternalPreferences returns the differing keys only and seeds a bare slice', () => {
  const state = { ui: {} };
  const first = editorSection.adoptExternalPreferences(state, { fontSize: 16, tabSize: 4 });
  assert.deepEqual([...first].sort(), ['fontSize', 'tabSize']);
  assert.equal(state.ui.ide.fontSize, 16);
  assert.deepEqual(editorSection.adoptExternalPreferences(state, { fontSize: 16, tabSize: 4 }), []);
  assert.deepEqual(editorSection.adoptExternalPreferences(state, null), []);
});
