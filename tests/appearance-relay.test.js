'use strict';

/* Row 88 D8: the main-side appearance relay. Fake window + webContents + fake timers. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAppearanceRelay } = require('../services/main/appearance-relay');
const { getBridgeChannel } = require('../services/ipc-contract');
const { PRIMARY_SETTINGS_LIMITS } = require('../services/primary-settings-contract');

const CHANNEL = getBridgeChannel('appearance.onRelayRequest', 'subscribe');
const VALUES = { paletteId: 'slate', typographyId: 'technical', fontScaleId: 'default', chatWidthId: 'standard' };
const OPTIONS = {
  paletteId: [{ value: 'slate', label: 'Slate' }, { value: 'dawn', label: 'Dawn' }],
  typographyId: [{ value: 'technical', label: 'Technical' }],
  fontScaleId: [{ value: 'default', label: 'Default' }],
  chatWidthId: [{ value: 'standard', label: 'Standard' }],
};
const okReply = (requestId, extra = {}) => ({ request_id: requestId, ok: true, values: { ...VALUES }, options: OPTIONS, ...extra });

function harness({ sendThrows = false } = {}) {
  const webContents = { sent: [], destroyed: false, isDestroyed() { return this.destroyed; },
    send(channel, payload) { if (sendThrows) throw new Error('secret path C:\\x'); this.sent.push({ channel, payload }); } };
  const win = { webContents, destroyed: false, isDestroyed() { return this.destroyed; } };
  const timers = [];
  const logs = [];
  const state = { win };
  const relay = createAppearanceRelay({
    getWindow: () => state.win,
    log: (level, event, details) => logs.push({ level, event, details }),
    setTimeoutFn: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeoutFn: (timer) => { timer.cleared = true; },
  });
  return { relay, win, webContents, timers, logs, state, event: { sender: webContents } };
}

test('a read round trips: pushes ar_<n> on the relay channel and resolves the clean reply', async () => {
  const h = harness();
  const pending = h.relay.read();
  assert.equal(h.webContents.sent.length, 1);
  assert.equal(h.webContents.sent[0].channel, CHANNEL);
  assert.deepEqual(h.webContents.sent[0].payload, { request_id: 'ar_1', op: 'read' });
  assert.equal(h.timers[0].ms, PRIMARY_SETTINGS_LIMITS.relay_timeout_ms);
  assert.deepEqual(h.relay.handleResponse(h.event, okReply('ar_1')), { ok: true });
  assert.deepEqual(await pending, { ok: true, values: VALUES, options: OPTIONS });
  assert.equal(h.timers[0].cleared, true);
  assert.deepEqual(h.relay.handleResponse(h.event, okReply('ar_1')), { ok: false }, 'a request resolves once');
});

test('an apply sends only the asked fields and resolves the values now in effect', async () => {
  const h = harness();
  const pending = h.relay.apply({ paletteId: 'dawn' });
  assert.deepEqual(h.webContents.sent[0].payload, { request_id: 'ar_1', op: 'apply', values: { paletteId: 'dawn' } });
  h.relay.handleResponse(h.event, okReply('ar_1', { values: { ...VALUES, paletteId: 'dawn' } }));
  assert.equal((await pending).values.paletteId, 'dawn');
});

test('concurrent requests resolve independently, each with its own timer', async () => {
  const h = harness();
  const first = h.relay.read();
  const second = h.relay.read();
  assert.deepEqual(h.webContents.sent.map((item) => item.payload.request_id), ['ar_1', 'ar_2']);
  h.relay.handleResponse(h.event, okReply('ar_2', { values: { ...VALUES, paletteId: 'dawn' } }));
  assert.equal((await second).values.paletteId, 'dawn');
  h.timers[0].fn();
  assert.deepEqual(await first, { ok: false, reason: 'unavailable' });
  assert.equal(h.timers[1].cleared, true);
});

test('a timeout resolves unavailable and a late reply is ignored', async () => {
  const h = harness();
  const pending = h.relay.read();
  h.timers[0].fn();
  assert.deepEqual(await pending, { ok: false, reason: 'unavailable' });
  assert.deepEqual(h.relay.handleResponse(h.event, okReply('ar_1')), { ok: false });
});

test('no window, a destroyed window or webContents, or a throwing send fail closed without leaking text', async () => {
  const h = harness();
  h.state.win = null;
  assert.deepEqual(await h.relay.read(), { ok: false, reason: 'unavailable' });
  h.state.win = h.win;
  h.win.destroyed = true;
  assert.deepEqual(await h.relay.apply({ paletteId: 'dawn' }), { ok: false, reason: 'unavailable' });
  h.win.destroyed = false;
  h.webContents.destroyed = true;
  assert.deepEqual(await h.relay.read(), { ok: false, reason: 'unavailable' });
  assert.equal(h.webContents.sent.length, 0);
  const thrower = harness({ sendThrows: true });
  const result = await thrower.relay.read();
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
  assert.doesNotMatch(JSON.stringify(thrower.logs), /secret|C:/);
});

test('a reply from another sender, or with an unknown or malformed id, is ignored', async () => {
  const h = harness();
  const pending = h.relay.read();
  assert.deepEqual(h.relay.handleResponse({ sender: {} }, okReply('ar_1')), { ok: false });
  assert.deepEqual(h.relay.handleResponse(undefined, okReply('ar_1')), { ok: false });
  assert.equal(h.logs.filter((entry) => entry.event === 'appearance_relay.reply_unauthorized').length, 2);
  for (const bad of ['ar_9', 'x', '', 5, null, 'ar_1234567890123']) {
    assert.deepEqual(h.relay.handleResponse(h.event, okReply(bad)), { ok: false }, String(bad));
  }
  for (const payload of [null, undefined, 'x', [], {}]) assert.deepEqual(h.relay.handleResponse(h.event, payload), { ok: false });
  h.relay.handleResponse(h.event, okReply('ar_1'));
  assert.equal((await pending).ok, true);
});

test('malformed ok replies resolve unavailable', async () => {
  const bad = [
    { values: { paletteId: 'slate' } },
    { values: { ...VALUES, extra: 'x' } },
    { values: { ...VALUES, paletteId: 'has space' } },
    { values: { ...VALUES, paletteId: 5 } },
    { values: { ...VALUES, paletteId: 'x'.repeat(65) } },
    { values: null }, { options: undefined }, { options: [] },
    { options: { ...OPTIONS, paletteId: 'nope' } },
    { options: { paletteId: OPTIONS.paletteId } },
  ];
  for (const extra of bad) {
    const h = harness();
    const pending = h.relay.read();
    assert.deepEqual(h.relay.handleResponse(h.event, okReply('ar_1', extra)), { ok: true });
    assert.deepEqual(await pending, { ok: false, reason: 'unavailable' }, JSON.stringify(extra));
  }
  for (const payload of [{ request_id: 'ar_1' }, { request_id: 'ar_1', ok: 'true' }]) {
    const h = harness();
    const pending = h.relay.read();
    h.relay.handleResponse(h.event, payload);
    assert.deepEqual(await pending, { ok: false, reason: 'unavailable' });
  }
});

test('options are capped and clipped and junk entries dropped', async () => {
  const h = harness();
  const pending = h.relay.read();
  const many = Array.from({ length: 200 }, (_, i) => ({ value: `p${i}`, label: 'L'.repeat(500), extra: 'dropped' }));
  const junk = [null, 'str', { value: 'bad value', label: 'a' }, { value: 7, label: 'a' }, { value: 'ok', label: 9 }];
  h.relay.handleResponse(h.event, okReply('ar_1', { options: { ...OPTIONS, paletteId: [...junk, ...many] } }));
  const { options } = await pending;
  assert.equal(options.paletteId.length, PRIMARY_SETTINGS_LIMITS.options_max);
  assert.ok(options.paletteId.every((item) => Object.keys(item).join() === 'value,label' && item.label.length === PRIMARY_SETTINGS_LIMITS.label_chars));
  assert.equal(options.paletteId[0].value, 'p0');
});

test('an ok:false reply keeps invalid_value and maps every other reason to unavailable', async () => {
  for (const [reason, expected] of [['invalid_value', 'invalid_value'], ['unavailable', 'unavailable'], ['boom: C:\\x', 'unavailable'], [undefined, 'unavailable']]) {
    const h = harness();
    const pending = h.relay.apply({ paletteId: 'dawn' });
    assert.deepEqual(h.relay.handleResponse(h.event, { request_id: 'ar_1', ok: false, reason }), { ok: true });
    assert.deepEqual(await pending, { ok: false, reason: expected });
  }
});

test('an apply with a bad field or value never sends', async () => {
  const h = harness();
  const invalid = { ok: false, reason: 'invalid_value' };
  for (const values of [undefined, null, {}, [], 'x', { surfaceEffectId: 'none' }, { paletteId: 'has space' },
    { paletteId: 5 }, { paletteId: '' }, { paletteId: 'dawn', extra: 'x' }, { paletteId: 'x'.repeat(65) }, { __proto__: { paletteId: 'dawn' } }]) {
    assert.deepEqual(await h.relay.apply(values), invalid, JSON.stringify(values));
  }
  assert.equal(h.webContents.sent.length, 0);
  assert.equal(h.timers.length, 0);
});

test('dispose resolves every pending request unavailable and clears timers', async () => {
  const h = harness();
  const reads = [h.relay.read(), h.relay.apply({ chatWidthId: 'standard' })];
  h.relay.dispose();
  assert.deepEqual(await Promise.all(reads), [{ ok: false, reason: 'unavailable' }, { ok: false, reason: 'unavailable' }]);
  assert.ok(h.timers.every((timer) => timer.cleared));
  assert.deepEqual(h.relay.handleResponse(h.event, okReply('ar_1')), { ok: false });
});
