'use strict';

/* Row 88 D8: the renderer side of the appearance relay (renderer-lifecycle-appearance-utils.js).
 * Real appearance model for the option lists and normalization; a fake store and bridge. */

const test = require('node:test');
const assert = require('node:assert/strict');

const appearanceModel = require('../renderer/shared/appearance-utils');
const { createLifecycleAppearanceUtils } = require('../renderer/shell/renderer-lifecycle-appearance-utils');

function createHarness({ saveFails = false, applyThrows = false } = {}) {
  const replies = [];
  const logs = [];
  const writes = [];
  const calls = { settings: 0, unsubscribed: 0 };
  let handler = null;
  const state = { ui: { appearance: appearanceModel.getDefaultAppearancePreferences(), activeView: '' } };
  const utils = createLifecycleAppearanceUtils({
    state,
    constants: { APPEARANCE_STORAGE_KEY: 'k' },
    callbacks: {
      getDefaultAppearancePreferences: appearanceModel.getDefaultAppearancePreferences,
      normalizeAppearancePreferences: appearanceModel.normalizeAppearancePreferences,
      applyAppearanceToDocument: (_doc, value) => { if (applyThrows) throw new Error('dom exploded'); return value; },
      saveStoredAppearancePreferences: (_storage, value) => { if (saveFails) return null; writes.push(value); return value; },
      getDefaultChatZoomPercent: () => 100,
      applyChatZoomToDocument: (_doc, value) => value,
    },
    fwd: { renderSettings: () => { calls.settings += 1; } },
    call: {},
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
    window: {
      localStorage: {},
      jennyShell: { appearance: {
        onRelayRequest: (callback) => { handler = callback; return () => { calls.unsubscribed += 1; handler = null; }; },
        respondRelay: async (reply) => { replies.push(reply); return { ok: true }; },
      } },
    },
    document: {},
  });
  return { utils, state, replies, logs, writes, calls, request: (payload) => handler(payload) };
}

const ids = (list) => list.map((item) => item.value);

test('bind subscribes once and a read replies with the current values and the model option lists', () => {
  const h = createHarness();
  h.utils.bindAppearanceRelay();
  h.utils.bindAppearanceRelay();
  h.request({ request_id: 'ar_1', op: 'read' });
  assert.equal(h.replies.length, 1);
  const [reply] = h.replies;
  assert.equal(reply.request_id, 'ar_1');
  assert.equal(reply.ok, true);
  const defaults = appearanceModel.getDefaultAppearancePreferences();
  assert.deepEqual(reply.values, {
    paletteId: defaults.paletteId, typographyId: defaults.typographyId,
    fontScaleId: defaults.fontScaleId, chatWidthId: defaults.chatWidthId,
  });
  assert.deepEqual(ids(reply.options.paletteId), appearanceModel.getPalettePresets().map((p) => p.id));
  assert.deepEqual(ids(reply.options.typographyId), appearanceModel.getTypographyPresets().map((p) => p.id));
  assert.deepEqual(ids(reply.options.fontScaleId), appearanceModel.getFontScalePresets().map((p) => p.id));
  assert.deepEqual(ids(reply.options.chatWidthId), appearanceModel.getChatWidthPresets().map((p) => p.id));
  assert.ok(Object.values(reply.options).flat().every((o) => typeof o.value === 'string' && typeof o.label === 'string' && o.label));
  assert.equal(h.writes.length, 0, 'a read writes nothing');
});

test('an in-list apply goes through the Settings write path and replies the new values', () => {
  const h = createHarness();
  h.utils.bindAppearanceRelay();
  h.state.ui.activeView = 'settings';
  const palette = appearanceModel.getPalettePresets().map((p) => p.id).find((id) => id !== h.state.ui.appearance.paletteId);
  const width = appearanceModel.getChatWidthPresets().map((p) => p.id).find((id) => id !== h.state.ui.appearance.chatWidthId);
  const before = { ...h.state.ui.appearance };
  h.request({ request_id: 'ar_2', op: 'apply', values: { paletteId: palette } });
  assert.equal(h.replies[0].ok, true);
  assert.equal(h.replies[0].values.paletteId, palette);
  assert.equal(h.state.ui.appearance.paletteId, palette);
  assert.equal(h.state.ui.appearance.typographyId, before.typographyId, 'other axes are kept');
  assert.equal(h.writes.length, 1);
  assert.equal(h.calls.settings, 1, 'an open Settings page re-renders');
  h.request({ request_id: 'ar_3', op: 'apply', values: { chatWidthId: width } });
  assert.equal(h.replies[1].values.chatWidthId, width);
  assert.equal(h.replies[1].values.paletteId, palette);
});

test('apply does not re-render Settings when it is not open', () => {
  const h = createHarness();
  h.utils.bindAppearanceRelay();
  const palette = appearanceModel.getPalettePresets().map((p) => p.id).find((id) => id !== h.state.ui.appearance.paletteId);
  h.request({ request_id: 'ar_1', op: 'apply', values: { paletteId: palette } });
  assert.equal(h.calls.settings, 0);
});

test('an out-of-list, unknown-field or empty apply replies invalid_value and applies nothing', () => {
  const h = createHarness();
  h.utils.bindAppearanceRelay();
  const before = JSON.stringify(h.state.ui.appearance);
  let n = 0;
  for (const values of [{ paletteId: 'not-a-palette' }, { paletteId: 7 }, { surfaceEffectId: 'none' }, {}, null, [], 'x',
    { paletteId: appearanceModel.getPalettePresets()[0].id, typographyId: 'nope' }]) {
    n += 1;
    h.request({ request_id: `ar_${n}`, op: 'apply', values });
    assert.deepEqual(h.replies.at(-1), { request_id: `ar_${n}`, ok: false, reason: 'invalid_value' }, JSON.stringify(values));
  }
  assert.equal(JSON.stringify(h.state.ui.appearance), before);
  assert.equal(h.writes.length, 0);
});

test('a refused save replies the old value, and a throwing apply replies unavailable without leaking text', () => {
  const refused = createHarness({ saveFails: true });
  refused.utils.bindAppearanceRelay();
  const palette = appearanceModel.getPalettePresets().map((p) => p.id).find((id) => id !== refused.state.ui.appearance.paletteId);
  const old = refused.state.ui.appearance.paletteId;
  refused.request({ request_id: 'ar_1', op: 'apply', values: { paletteId: palette } });
  assert.equal(refused.replies[0].ok, true);
  assert.equal(refused.replies[0].values.paletteId, old);

  const broken = createHarness({ applyThrows: true });
  broken.utils.bindAppearanceRelay();
  broken.request({ request_id: 'ar_1', op: 'apply', values: { paletteId: palette } });
  assert.deepEqual(broken.replies[0], { request_id: 'ar_1', ok: false, reason: 'unavailable' });
  assert.equal(broken.logs.at(-1).event, 'appearance.relay_failed');
});

test('bad requests are ignored or answered unavailable, and dispose unsubscribes', () => {
  const h = createHarness();
  h.utils.bindAppearanceRelay();
  for (const payload of [null, undefined, {}, { op: 'read' }, { request_id: 'bad', op: 'read' }, { request_id: 5, op: 'read' }]) {
    h.request(payload);
  }
  assert.equal(h.replies.length, 0, 'no reply can be addressed without a valid request id');
  h.request({ request_id: 'ar_4', op: 'wipe' });
  assert.deepEqual(h.replies[0], { request_id: 'ar_4', ok: false, reason: 'unavailable' });
  h.utils.disposeAppearanceRelay();
  h.utils.disposeAppearanceRelay();
  assert.equal(h.calls.unsubscribed, 1);
});

test('a missing bridge binds nothing and never throws', () => {
  const utils = createLifecycleAppearanceUtils({
    state: { ui: { appearance: {} } }, constants: {}, callbacks: {}, fwd: {}, call: {}, window: { jennyShell: {} }, document: {},
  });
  assert.equal(utils.bindAppearanceRelay(), utils.disposeAppearanceRelay);
  assert.equal(utils.disposeAppearanceRelay(), undefined);
});
