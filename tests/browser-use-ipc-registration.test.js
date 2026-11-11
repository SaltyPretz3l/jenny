'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getBridgeChannel, getBridgeDescriptor, listBridgeMethodPaths } = require('../services/ipc-contract');
const { registerBrowserUseIpc } = require('../services/main/browser-use-ipc-registration');

const METHODS = ['getState', 'show', 'setBounds', 'hide', 'capture', 'takeOver', 'handBack', 'close', 'navigate', 'zoom', 'find', 'stopFind', 'siteInfo', 'removeSite', 'revealDownload', 'configure', 'toggleSound', 'setAdBlock'];
const BOUNDS = { x: 10, y: 20, width: 640, height: 480 };
const SESSION = 'chat-a';

function makeService(results = {}) {
  const calls = [];
  const answer = (name, fallback) => (...args) => {
    calls.push({ name, args });
    const value = results[name];
    if (typeof value === 'function') return value(...args);
    return value === undefined ? fallback : value;
  };
  const service = {
    calls,
    getState: answer('getState', { open: true, mode: 'model', url: 'https://example.com/', title: 'T', loading: false, busy: false }),
    show: answer('show', { ok: true }),
    setBounds: answer('setBounds', { ok: true }),
    hide: answer('hide', { ok: true }),
    capture: answer('capture', { ok: true, data_url: 'data:image/jpeg;base64,AA==', width: 10, height: 8 }),
    takeOver: answer('takeOver', { ok: true }),
    handBack: answer('handBack', { ok: true }),
    close: answer('close', { ok: true }),
    navigate: answer('navigate', { ok: true }),
    zoom: answer('zoom', { ok: true }),
    find: answer('find', { ok: true }),
    stopFind: answer('stopFind', { ok: true }),
    siteInfo: answer('siteInfo', { ok: true, sites: [] }),
    removeSite: answer('removeSite', { ok: true }),
    revealDownload: answer('revealDownload', { ok: true }),
    configure: answer('configure', { ok: true }),
    toggleSound: answer('toggleSound', { ok: true }),
    setAdBlock: answer('setAdBlock', { ok: true, changed: true }),
  };
  return service;
}

function fixture({ enabled = true, service = makeService(), noService = false } = {}) {
  const handlers = new Map();
  const state = { enabled, service: noService ? null : service };
  registerBrowserUseIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    getService: () => state.service,
    authorization: { authorize: (event) => event.trusted === true },
    isEnabled: () => state.enabled,
  });
  const call = (method, payload, event = { trusted: true }) => handlers.get(getBridgeChannel(`browserUse.${method}`))(event, payload);
  return { handlers, call, service, state };
}

test('the contract lists every browser method and registration covers them', () => {
  const paths = listBridgeMethodPaths().filter((path) => path.startsWith('browserUse.'));
  assert.deepEqual(paths.sort(), [...METHODS.map((method) => `browserUse.${method}`), 'browserUse.onChanged'].sort());
  const { handlers } = fixture();
  assert.deepEqual([...handlers.keys()].sort(), METHODS.map((method) => getBridgeChannel(`browserUse.${method}`)).sort());
  assert.equal(getBridgeDescriptor('browserUse.onChanged').kind, 'subscribe');
  assert.equal(getBridgeChannel('browserUse.onChanged', 'subscribe'), 'browser-use:changed');
  assert.equal(getBridgeChannel('browserUse.setBounds'), 'browser-use:set-bounds');
  assert.equal(getBridgeChannel('browserUse.takeOver'), 'browser-use:take-over');
  assert.equal(getBridgeChannel('browserUse.handBack'), 'browser-use:hand-back');
});

test('an untrusted sender is refused before anything else runs', async () => {
  const { call, service } = fixture();
  for (const method of METHODS) {
    const result = await call(method, { session_id: SESSION, bounds: BOUNDS }, {});
    assert.equal(result.authorized, false, method);
  }
  assert.deepEqual(service.calls, []);
});

test('flag off or no service answers browser_unavailable and touches nothing', async () => {
  for (const options of [{ enabled: false }, { noService: true }]) {
    const { call, service } = fixture(options);
    for (const method of METHODS) {
      assert.deepEqual(await call(method, { session_id: SESSION, bounds: BOUNDS }), { ok: false, reason: 'browser_unavailable' }, method);
      assert.deepEqual(await call(method, 'garbage'), { ok: false, reason: 'browser_unavailable' }, method);
    }
    assert.deepEqual(service.calls, []);
  }
});

test('the flag and the service are read per call', async () => {
  const { call, state } = fixture({ enabled: false });
  assert.equal((await call('getState', { session_id: SESSION })).reason, 'browser_unavailable');
  state.enabled = true;
  assert.equal((await call('getState', { session_id: SESSION })).ok, true);
});

test('payloads are closed: bad shapes, bad chat ids and unknown keys are rejected', async () => {
  const { call, service } = fixture();
  const bad = [
    undefined, null, 'chat-a', 7, [], [SESSION], {}, { session_id: '' }, { session_id: 7 }, { session_id: '../etc' },
    { session_id: 'a b' }, { session_id: 'x'.repeat(129) }, { session_id: SESSION, extra: 1 },
    { session_id: SESSION, bounds: BOUNDS },
  ];
  for (const method of ['getState', 'hide', 'capture', 'takeOver', 'handBack', 'close']) {
    for (const payload of bad) {
      assert.deepEqual(await call(method, payload), { ok: false, reason: 'invalid_payload' }, `${method} ${JSON.stringify(payload)}`);
    }
  }
  assert.deepEqual(service.calls, []);
});

test('show and setBounds need exact integer bounds in range', async () => {
  const { call, service } = fixture();
  const badBounds = [
    undefined, null, 'x', [], {}, { x: 1, y: 1, width: 10 }, { x: 1, y: 1, width: 10, height: 10, extra: 1 },
    { x: 1.5, y: 1, width: 10, height: 10 }, { x: 1, y: 1, width: 10.5, height: 10 }, { x: '1', y: 1, width: 10, height: 10 },
    { x: NaN, y: 1, width: 10, height: 10 }, { x: Infinity, y: 1, width: 10, height: 10 },
    { x: -32769, y: 0, width: 10, height: 10 }, { x: 0, y: 32768, width: 10, height: 10 },
    { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10, height: 0 },
    { x: 0, y: 0, width: -1, height: 10 }, { x: 0, y: 0, width: 16385, height: 10 }, { x: 0, y: 0, width: 10, height: 16385 },
  ];
  for (const method of ['show', 'setBounds']) {
    for (const bounds of badBounds) {
      const payload = bounds === undefined ? { session_id: SESSION } : { session_id: SESSION, bounds };
      assert.deepEqual(await call(method, payload), { ok: false, reason: 'invalid_payload' }, `${method} ${JSON.stringify(bounds)}`);
    }
    assert.deepEqual(await call(method, { session_id: SESSION, bounds: BOUNDS, extra: true }), { ok: false, reason: 'invalid_payload' });
  }
  assert.deepEqual(service.calls, []);
  for (const bounds of [{ x: -32768, y: 32767, width: 1, height: 16384 }, { x: 0, y: 0, width: 16384, height: 1 }]) {
    assert.equal((await call('show', { session_id: SESSION, bounds })).ok, true);
  }
});

test('good calls reach the service with a copy of the validated fields', async () => {
  const { call, service } = fixture();
  assert.deepEqual(await call('getState', { session_id: SESSION }), {
    ok: true, open: true, mode: 'model', url: 'https://example.com/', title: 'T', loading: false, busy: false,
  });
  const payload = { session_id: SESSION, bounds: { ...BOUNDS } };
  assert.deepEqual(await call('show', payload), { ok: true });
  assert.deepEqual(await call('setBounds', payload), { ok: true });
  for (const method of ['hide', 'takeOver', 'handBack', 'close']) {
    assert.deepEqual(await call(method, { session_id: SESSION }), { ok: true }, method);
  }
  assert.deepEqual(await call('capture', { session_id: SESSION }), {
    ok: true, data_url: 'data:image/jpeg;base64,AA==', width: 10, height: 8,
  });
  assert.deepEqual(service.calls.map((entry) => entry.name), ['getState', 'show', 'setBounds', 'hide', 'takeOver', 'handBack', 'close', 'capture']);
  assert.deepEqual(service.calls[1].args, [SESSION, BOUNDS]);
  assert.notEqual(service.calls[1].args[1], payload.bounds, 'a copy, not the renderer\'s object');
});

test('a chat with no page answers no_page', async () => {
  const none = { ok: false, reason: 'no_page' };
  const { call } = fixture({ service: makeService({ show: none, hide: none, capture: none, takeOver: none, handBack: none, close: none, setBounds: none }) });
  for (const method of ['hide', 'capture', 'takeOver', 'handBack', 'close']) {
    assert.deepEqual(await call(method, { session_id: SESSION }), none, method);
  }
  assert.deepEqual(await call('show', { session_id: SESSION, bounds: BOUNDS }), none);
});

test('getState for a chat with no page is a normal closed answer', async () => {
  const closed = { open: false, mode: 'model', url: '', title: '', loading: false, busy: false };
  const { call } = fixture({ service: makeService({ getState: closed }) });
  assert.deepEqual(await call('getState', { session_id: SESSION }), { ok: true, ...closed });
});

test('a service failure never leaks a message, and odd reasons are replaced', async () => {
  const boom = () => { throw new Error('C:\\secret\\path exploded'); };
  const { call } = fixture({ service: makeService({
    show: boom, close: () => Promise.reject(new Error('secret')), hide: { ok: false, reason: 'Has Spaces & C:\\x' },
    getState: boom,
  }) });
  assert.deepEqual(await call('show', { session_id: SESSION, bounds: BOUNDS }), { ok: false, reason: 'browser_error' });
  assert.deepEqual(await call('close', { session_id: SESSION }), { ok: false, reason: 'browser_error' });
  assert.deepEqual(await call('hide', { session_id: SESSION }), { ok: false, reason: 'browser_error' });
  assert.deepEqual(await call('getState', { session_id: SESSION }), { ok: false, reason: 'browser_error' });
});
