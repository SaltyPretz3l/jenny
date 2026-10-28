'use strict';
// Push-to-talk dictation (row 84). `dictation.*` covers the speech-model
// download (getState/setup/cancel/remove/onChanged) and the two audio calls
// (prepare/transcribe). Every handler sits behind the trusted-sender authorizer.
// The renderer only ever sees model state and transcription results: the model
// directory stays in main, and audio is never logged (byte length and timings only).
const { registerIpcInvokeHandlers } = require('../ipc-contract');

const SAMPLE_RATE = 16_000;
const MIN_AUDIO_BYTES = 6_400; // 0.2 s of mono PCM16
const MAX_AUDIO_BYTES = 3_840_000; // 120 s
const MICROPHONE_SETTINGS_URL = 'ms-settings:privacy-microphone';
const CODE = /^CMP-[A-Z]+-\d{4}$/u;
const REASON = /^[a-z][a-z0-9_]{0,99}$/u;

function audioBytes(payload) {
  const tag = Object.prototype.toString.call(payload);
  if (tag === '[object ArrayBuffer]') return Buffer.from(payload);
  if (tag === '[object Uint8Array]') return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  return null;
}

// The renderer shows the reason and the CMP code; the sidecar's message stays in main.
// State results for the renderer drop the model path (main keeps it for the sidecar).
const publicState = ({ modelDir: _modelDir, ...rest } = {}) => rest;

function engineError(error) {
  const code = String(error?.error_code || error?.code || '');
  return { ok: false, reason: 'engine_error', code: CODE.test(code) ? code : '' };
}

function registerDictationIpc(ipcMain, {
  service, authorization, getClient = () => null, isEnabled = () => true, log = () => {},
  openExternal = null, platform = process.platform,
}) {
  const safe = async (operation) => {
    try {
      if (!service) return { ok: false, reason: 'dictation_unavailable' };
      return { ...publicState(await operation()), ok: true };
    } catch (error) {
      return { ...publicState(service?.getState?.()), ok: false,
        reason: REASON.test(error?.reason || '') ? error.reason : 'dictation_operation_failed' };
    }
  };
  const noPayload = (method) => (_event, payload) => safe(() => {
    if (payload !== undefined) throw Object.assign(new Error('unexpected_payload'), { reason: 'unexpected_payload' });
    return method();
  });

  // Shared gate for the two sidecar calls: flag, model and client, then the call.
  const withEngine = async (call) => {
    if (!isEnabled()) return { ok: false, reason: 'disabled' };
    await service?.start?.();
    const state = service?.getState?.();
    if (state?.state !== 'ready' || !state.modelDir) return { ok: false, reason: 'model_not_ready' };
    const client = getClient();
    if (!client) return { ok: false, reason: 'engine_error', code: '' };
    try {
      return await call(client, state.modelDir);
    } catch (error) {
      const result = engineError(error);
      log('WARN', 'dictation.engine_failed', { code: result.code });
      return result;
    }
  };

  const prepare = async () => withEngine(async (client, modelDir) => {
    const result = await client.speechPrepare({ model_dir: modelDir });
    return { ok: true, loadMs: Number(result?.load_ms) || 0 };
  });

  // Opens the OS microphone privacy page. The URL is a constant, never renderer input.
  const openMicrophoneSettings = async () => {
    if (platform !== 'win32' || typeof openExternal !== 'function') return { ok: false, reason: 'unsupported' };
    try {
      await openExternal(MICROPHONE_SETTINGS_URL);
      return { ok: true };
    } catch (_error) {
      return { ok: false, reason: 'open_failed' };
    }
  };

  const transcribe = async (_event, payload) => {
    const bytes = audioBytes(payload);
    if (!bytes || bytes.length % 2 !== 0 || bytes.length < MIN_AUDIO_BYTES || bytes.length > MAX_AUDIO_BYTES) {
      return { ok: false, reason: 'invalid_audio' };
    }
    return withEngine(async (client, modelDir) => {
      const result = await client.speechTranscribe({
        model_dir: modelDir, audio_b64: bytes.toString('base64'), sample_rate: SAMPLE_RATE, format: 'pcm_s16le',
      });
      log('INFO', 'dictation.transcribed', {
        bytes: bytes.length, durationMs: Number(result?.duration_ms) || 0, engineMs: Number(result?.engine_ms) || 0,
      });
      return { ok: true, text: String(result?.text ?? ''), durationMs: Number(result?.duration_ms) || 0,
        engineMs: Number(result?.engine_ms) || 0 };
    });
  };

  return registerIpcInvokeHandlers(ipcMain, {
    'dictation.getState': noPayload(async () => { await service.start(); return service.getState(); }),
    'dictation.setup': noPayload(() => service.setup()),
    'dictation.cancel': noPayload(() => service.cancel()),
    'dictation.remove': noPayload(() => service.remove()),
    'dictation.prepare': (_event, payload) => (payload !== undefined
      ? { ok: false, reason: 'unexpected_payload' } : prepare()),
    'dictation.transcribe': transcribe,
    'dictation.openMicrophoneSettings': (_event, payload) => (payload !== undefined
      ? { ok: false, reason: 'unexpected_payload' } : openMicrophoneSettings()),
  }, authorization);
}

module.exports = { registerDictationIpc, MICROPHONE_SETTINGS_URL, MIN_AUDIO_BYTES, MAX_AUDIO_BYTES };
