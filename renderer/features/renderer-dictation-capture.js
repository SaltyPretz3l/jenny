/* Dictation microphone capture (row 84, lazy: loaded on the first press).
 *
 * getUserMedia with the browser's echo cancellation, noise suppression and
 * automatic gain all off, into a 16 kHz AudioContext (Chromium resamples the
 * device), through dictation-capture-worklet.js. Samples are kept as PCM16 in
 * memory only, never written anywhere, and the tracks stop the moment the
 * recording ends so the Windows "microphone in use" indicator clears.
 *
 * The level meter reads the same samples the model gets: one value per 50 ms
 * block, the block's RMS in dBFS mapped linearly from -60 to -6 dBFS onto 0..1.
 * No smoothing, so silence draws flat bars. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDictationCapture = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SAMPLE_RATE = 16000;
  const MAX_MS = 120000;
  const FLOOR_DB = -60;
  const CEILING_DB = -6;
  const WORKLET_URL = 'renderer/features/dictation-capture-worklet.js';
  const WORKLET_NAME = 'jenny-dictation-capture';

  function rmsDb(samples) {
    if (!samples || samples.length === 0) return -Infinity;
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }
  function levelFromDb(db) {
    if (!Number.isFinite(db)) return 0;
    return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
  }
  function floatToPcm16(samples, out, offset) {
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[offset + i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
  }
  function joinPcm16(blocks, total) {
    const out = new Int16Array(total);
    let offset = 0;
    blocks.forEach((block) => { floatToPcm16(block, out, offset); offset += block.length; });
    return out.buffer;
  }

  function classify(error) {
    const name = String(error && error.name || '');
    const reason = name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotReadableError' ? 'blocked'
      : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'no_device'
        : 'failed';
    const wrapped = new Error(String(error && error.message || name || 'capture failed'));
    wrapped.name = name;
    wrapped.reason = reason;
    return wrapped;
  }

  function audioConstraints(deviceId) {
    const base = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
  }

  async function openStream(mediaDevices, deviceId) {
    try {
      return await mediaDevices.getUserMedia({ audio: audioConstraints(deviceId), video: false });
    } catch (error) {
      // A remembered microphone that is unplugged falls back to the system default.
      if (deviceId && (error && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError'))) {
        return mediaDevices.getUserMedia({ audio: audioConstraints(''), video: false });
      }
      throw error;
    }
  }

  async function startCapture({ windowRef, deviceId = '', onLevel = () => {}, onLimit = () => {}, maxMs = MAX_MS }) {
    const mediaDevices = windowRef.navigator && windowRef.navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function' || typeof windowRef.AudioContext !== 'function') {
      throw Object.assign(new Error('audio capture unavailable'), { reason: 'failed' });
    }
    let stream = null;
    let context = null;
    let source;
    let node;
    try {
      stream = await openStream(mediaDevices, deviceId);
      context = new windowRef.AudioContext({ sampleRate: SAMPLE_RATE });
      await context.audioWorklet.addModule(WORKLET_URL);
      // Inside the guard too: a throw here must not leave the microphone open.
      source = context.createMediaStreamSource(stream);
      node = new windowRef.AudioWorkletNode(context, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      context?.close().catch(() => {});
      throw classify(error);
    }
    const blocks = [];
    const maxSamples = Math.round(maxMs * SAMPLE_RATE / 1000);
    let total = 0;
    let peakDb = -Infinity;
    let closed = false;
    let limitHit = false;
    let flushed = null;

    node.port.onmessage = (event) => {
      if (event.data === 'flushed') { flushed?.(); return; }
      if (closed || limitHit || !(event.data instanceof Float32Array)) return;
      const room = maxSamples - total;
      const block = event.data.length > room ? event.data.subarray(0, room) : event.data;
      blocks.push(block);
      total += block.length;
      const db = rmsDb(block);
      if (db > peakDb) peakDb = db;
      onLevel(levelFromDb(db), db);
      if (total >= maxSamples) { limitHit = true; onLimit(); }
    };
    source.connect(node);

    function close() {
      if (closed) return;
      closed = true;
      try { source.disconnect(); } catch (_error) { /* already gone */ }
      node.port.onmessage = null;
      stream.getTracks().forEach((track) => track.stop());
      context.close().catch(() => {});
    }

    return {
      // Resolves once the worklet has handed over its partial block (or after 250 ms).
      stop() {
        if (closed) return Promise.resolve(null);
        return new Promise((resolve) => {
          const timer = windowRef.setTimeout(() => resolve(), 250);
          flushed = () => { windowRef.clearTimeout(timer); resolve(); };
          node.port.postMessage('flush');
        }).then(() => {
          close();
          return { pcm: joinPcm16(blocks, total), durationMs: Math.round(total * 1000 / SAMPLE_RATE), peakDb };
        });
      },
      cancel() { blocks.length = 0; close(); },
    };
  }

  return { startCapture, rmsDb, levelFromDb, joinPcm16, classify, SAMPLE_RATE, MAX_MS };
});
