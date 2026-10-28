'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { getBridgeChannel, listBridgeMethodPaths } = require('../services/ipc-contract');
const {
  registerDictationIpc, MICROPHONE_SETTINGS_URL, MIN_AUDIO_BYTES, MAX_AUDIO_BYTES,
} = require('../services/main/dictation-ipc-registration');

const METHODS = ['getState', 'setup', 'cancel', 'remove', 'prepare', 'transcribe', 'openMicrophoneSettings'];

function fixture({ state = 'ready', enabled = true, client, platform = 'win32', openExternal, noService = false } = {}) {
  const handlers = new Map();
  const service = noService ? null : Object.assign(new EventEmitter(), {
    start: async () => {},
    getState: () => ({ state, downloadedBytes: 0, totalBytes: 10,
      modelDir: state === 'ready' ? 'C:/models/speech' : null, error: null }),
    setup: async () => ({ state: 'downloading' }),
    cancel: () => ({ state: 'not_installed' }),
    remove: async () => ({ state: 'not_installed' }),
  });
  const calls = { prepare: [], transcribe: [], opened: [] };
  const sidecar = client === undefined ? {
    speechPrepare: async (params) => { calls.prepare.push(params); return { ready: true, load_ms: 42 }; },
    speechTranscribe: async (params) => {
      calls.transcribe.push(params);
      return { text: 'hello world', duration_ms: 1000, engine_ms: 120 };
    },
  } : client;
  const logs = [];
  registerDictationIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    service,
    authorization: { authorize: (event) => event.trusted === true },
    getClient: () => sidecar,
    isEnabled: () => enabled,
    log: (...args) => logs.push(args),
    platform,
    openExternal: openExternal || (async (url) => { calls.opened.push(url); }),
  });
  const call = (method, payload, event = { trusted: true }) =>
    handlers.get(getBridgeChannel(`dictation.${method}`))(event, payload);
  return { handlers, call, calls, logs, service };
}
const toArrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

test('the contract lists every dictation method and registration covers them all', () => {
  const paths = listBridgeMethodPaths().filter((p) => p.startsWith('dictation.'));
  assert.deepEqual(paths.sort(), [...METHODS.map((m) => `dictation.${m}`), 'dictation.onChanged'].sort());
  const { handlers } = fixture();
  assert.deepEqual([...handlers.keys()].sort(), METHODS.map((m) => getBridgeChannel(`dictation.${m}`)).sort());
  assert.equal(getBridgeChannel('dictation.onChanged', 'subscribe'), 'dictation:changed');
});

test('every handler rejects an untrusted sender before touching the service or the engine', async () => {
  const { call, calls } = fixture();
  for (const method of METHODS) {
    const result = await call(method, method === 'transcribe' ? new ArrayBuffer(8000) : undefined, {});
    assert.equal(result.authorized, false, method);
  }
  assert.deepEqual([calls.prepare, calls.transcribe, calls.opened], [[], [], []]);
});

test('state operations answer ok plus the state and reject stray payloads', async () => {
  const { call } = fixture({ state: 'not_installed' });
  assert.deepEqual(await call('getState'), { ok: true, state: 'not_installed', downloadedBytes: 0, totalBytes: 10, error: null });
  assert.equal((await call('setup')).state, 'downloading');
  assert.equal((await call('cancel')).state, 'not_installed');
  assert.equal((await call('remove')).ok, true);
  assert.equal((await call('getState', { path: 'C:/x' })).reason, 'unexpected_payload');
  assert.equal((await call('prepare', {})).reason, 'unexpected_payload');
});

test('a ready model never shows its path to the renderer', async () => {
  const { call } = fixture({ state: 'ready' });
  for (const method of ['getState', 'setup', 'cancel', 'remove']) {
    const result = await call(method);
    assert.equal(Object.hasOwn(result, 'modelDir'), false, method);
    assert.equal(JSON.stringify(result).includes('C:/models'), false, method);
  }
});

test('a missing service answers dictation_unavailable', async () => {
  const { call } = fixture({ noService: true });
  assert.equal((await call('getState')).reason, 'dictation_unavailable');
});

test('flag off answers disabled for prepare and transcribe without reaching the engine', async () => {
  const { call, calls } = fixture({ enabled: false });
  assert.deepEqual(await call('prepare'), { ok: false, reason: 'disabled' });
  assert.deepEqual(await call('transcribe', toArrayBuffer(Buffer.alloc(8000))), { ok: false, reason: 'disabled' });
  assert.deepEqual([calls.prepare, calls.transcribe], [[], []]);
});

test('a model that is not ready answers model_not_ready', async () => {
  for (const state of ['not_installed', 'downloading', 'verifying', 'failed']) {
    const { call, calls } = fixture({ state });
    assert.deepEqual(await call('prepare'), { ok: false, reason: 'model_not_ready' }, state);
    assert.deepEqual(await call('transcribe', toArrayBuffer(Buffer.alloc(8000))),
      { ok: false, reason: 'model_not_ready' }, state);
    assert.deepEqual([calls.prepare, calls.transcribe], [[], []]);
  }
});

test('prepare forwards only the model directory and returns the load time', async () => {
  const { call, calls } = fixture();
  assert.deepEqual(await call('prepare'), { ok: true, loadMs: 42 });
  assert.deepEqual(calls.prepare, [{ model_dir: 'C:/models/speech' }]);
});

test('transcribe validates the payload type and byte length', async () => {
  const { call, calls } = fixture();
  const invalid = { ok: false, reason: 'invalid_audio' };
  assert.deepEqual(await call('transcribe', undefined), invalid);
  assert.deepEqual(await call('transcribe', 'AAAA'), invalid);
  assert.deepEqual(await call('transcribe', { length: 8000 }), invalid);
  assert.deepEqual(await call('transcribe', [1, 2, 3, 4]), invalid);
  assert.deepEqual(await call('transcribe', new Int16Array(4000)), invalid);
  assert.deepEqual(await call('transcribe', new ArrayBuffer(MIN_AUDIO_BYTES - 2)), invalid);
  assert.deepEqual(await call('transcribe', new ArrayBuffer(7001)), invalid);
  assert.deepEqual(await call('transcribe', new ArrayBuffer(MAX_AUDIO_BYTES + 2)), invalid);
  assert.deepEqual(await call('transcribe', new ArrayBuffer(0)), invalid);
  assert.equal(calls.transcribe.length, 0);
  assert.equal((await call('transcribe', new ArrayBuffer(MIN_AUDIO_BYTES))).ok, true);
  assert.equal((await call('transcribe', new ArrayBuffer(MAX_AUDIO_BYTES))).ok, true);
  assert.equal(calls.transcribe.length, 2);
});

test('the audio reaches the engine as exact base64 PCM16 from an ArrayBuffer or a Uint8Array view', async () => {
  const { call, calls, logs } = fixture();
  const samples = Buffer.alloc(8000);
  for (let i = 0; i < samples.length; i += 1) samples[i] = (i * 31) & 0xff;
  const viaBuffer = await call('transcribe', toArrayBuffer(samples));
  assert.deepEqual(viaBuffer, { ok: true, text: 'hello world', durationMs: 1000, engineMs: 120 });
  // A view into a larger buffer must send only its own bytes.
  const big = new Uint8Array(20000);
  big.set(samples, 4000);
  await call('transcribe', new Uint8Array(big.buffer, 4000, samples.length));
  assert.equal(calls.transcribe.length, 2);
  for (const sent of calls.transcribe) {
    assert.deepEqual(Object.keys(sent).sort(), ['audio_b64', 'format', 'model_dir', 'sample_rate']);
    assert.equal(sent.model_dir, 'C:/models/speech');
    assert.equal(sent.sample_rate, 16000);
    assert.equal(sent.format, 'pcm_s16le');
    assert.deepEqual(Buffer.from(sent.audio_b64, 'base64'), samples);
  }
  assert.ok(!JSON.stringify(logs).includes(calls.transcribe[0].audio_b64));
  assert.ok(logs.some(([, event, fields]) => event === 'dictation.transcribed' && fields.bytes === 8000));
});

test('engine errors pass through as engine_error with the CMP code and no sidecar text', async () => {
  const failing = Object.assign(new Error('x'.repeat(500)), { error_code: 'CMP-SPEECH-0003' });
  const client = { speechPrepare: async () => { throw failing; }, speechTranscribe: async () => { throw failing; } };
  const { call } = fixture({ client });
  for (const result of [await call('prepare'), await call('transcribe', new ArrayBuffer(8000))]) {
    assert.deepEqual([result.ok, result.reason, result.code], [false, 'engine_error', 'CMP-SPEECH-0003']);
    assert.equal(result.message, undefined);
  }
  const odd = fixture({ client: { speechPrepare: async () => {
    throw Object.assign(new Error('boom'), { code: 'EPIPE' });
  } } });
  const result = await odd.call('prepare');
  assert.deepEqual([result.reason, result.code, result.message], ['engine_error', '', undefined]);
});

test('no sidecar client answers engine_error', async () => {
  const { call } = fixture({ client: null });
  assert.equal((await call('prepare')).reason, 'engine_error');
});

test('openMicrophoneSettings opens exactly the fixed URL on win32 and nothing elsewhere', async () => {
  const win = fixture();
  assert.deepEqual(await win.call('openMicrophoneSettings'), { ok: true });
  assert.deepEqual(win.calls.opened, ['ms-settings:privacy-microphone']);
  assert.equal(MICROPHONE_SETTINGS_URL, 'ms-settings:privacy-microphone');
  // A renderer payload is refused, never used as the target.
  assert.equal((await win.call('openMicrophoneSettings', 'https://evil.example')).reason, 'unexpected_payload');
  assert.equal(win.calls.opened.length, 1);
  for (const platform of ['darwin', 'linux']) {
    const other = fixture({ platform });
    assert.deepEqual(await other.call('openMicrophoneSettings'), { ok: false, reason: 'unsupported' });
    assert.deepEqual(other.calls.opened, []);
  }
  const throwing = fixture({ openExternal: async () => { throw new Error('no handler'); } });
  assert.deepEqual(await throwing.call('openMicrophoneSettings'), { ok: false, reason: 'open_failed' });
});
