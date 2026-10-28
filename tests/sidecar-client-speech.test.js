'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');

const { SidecarClient } = require('../services/backend/sidecar-client');
const { SPEECH_ERROR_CODES } = require('../services/backend/error-codes');
const { resolveRequestTimeoutMs } = require('../services/backend/sidecar-request-timeouts');

const AUDIO_B64 = Buffer.alloc(6400, 7).toString('base64');

function buildFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, body]);
}

function attachedClient() {
  const logs = [];
  const client = new SidecarClient({ logger: (...args) => logs.push(args) });
  const stdout = new Readable({ read() {} });
  const writes = [];
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  stdin.write = (chunk) => { writes.push(Buffer.from(chunk)); return true; };
  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stdin = stdin;
  client.attachProcess(proc);
  const lastRequest = () => JSON.parse(Buffer.concat(writes).toString('utf8').split('\r\n\r\n')[1]);
  return { client, stdout, logs, lastRequest };
}

test('speechPrepare sends speech.prepare with only the version and model_dir', async () => {
  const { client, stdout, lastRequest } = attachedClient();
  const promise = client.speechPrepare({ model_dir: 'C:/models/speech', extra: 'dropped' });
  stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { ready: true, load_ms: 812 } }));
  assert.deepEqual(await promise, { ready: true, load_ms: 812 });
  const request = lastRequest();
  assert.equal(request.method, 'speech.prepare');
  assert.deepEqual(request.params, { accept_version: '2026-10-15', model_dir: 'C:/models/speech' });
});

test('speechTranscribe sends speech.transcribe with the audio fields', async () => {
  const { client, stdout, lastRequest } = attachedClient();
  const promise = client.speechTranscribe({
    model_dir: 'C:/models/speech', audio_b64: AUDIO_B64, sample_rate: 16000, format: 'pcm_s16le',
  });
  stdout.push(buildFrame({
    jsonrpc: '2.0', id: 1, result: { text: 'hello there', duration_ms: 200, engine_ms: 90 },
  }));
  assert.deepEqual(await promise, { text: 'hello there', duration_ms: 200, engine_ms: 90 });
  const request = lastRequest();
  assert.equal(request.method, 'speech.transcribe');
  assert.deepEqual(request.params, {
    accept_version: '2026-10-15',
    model_dir: 'C:/models/speech',
    audio_b64: AUDIO_B64,
    sample_rate: 16000,
    format: 'pcm_s16le',
  });
});

test('a speech error keeps its CMP code and the audio never reaches the logger or the error', async () => {
  const { client, stdout, logs } = attachedClient();
  const promise = client.speechTranscribe({
    model_dir: 'C:/models/speech', audio_b64: AUDIO_B64, sample_rate: 16000, format: 'pcm_s16le',
  });
  stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32602,
      message: 'Audio is shorter than 0.2 seconds.',
      data: { error_code: SPEECH_ERROR_CODES.INVALID_AUDIO, reason: 'too_short' },
    },
  }));
  const error = await promise.then(() => null, (caught) => caught);
  assert.equal(error.error_code, 'CMP-SPEECH-0002');
  assert.equal(JSON.stringify(logs).includes(AUDIO_B64), false);
  assert.equal(String(error.message).includes(AUDIO_B64), false);
});

test('speech requests get a 60 s default timeout that a caller can override', () => {
  assert.equal(resolveRequestTimeoutMs('speech.prepare', {}), 60_000);
  assert.equal(resolveRequestTimeoutMs('speech.transcribe', {}), 60_000);
  assert.equal(resolveRequestTimeoutMs('speech.transcribe', { timeoutMs: 5_000 }), 5_000);
});

test('the SPEECH error group holds the four dictation codes', () => {
  assert.deepEqual(Object.values(SPEECH_ERROR_CODES), [
    'CMP-SPEECH-0001', 'CMP-SPEECH-0002', 'CMP-SPEECH-0003', 'CMP-SPEECH-0004',
  ]);
});
