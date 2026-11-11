'use strict';

const fs = require('fs');
const path = require('path');
const { readBoundedRegularFile, sameFileSnapshot } = require('./backend/bounded-file-reader');
const { readPngStructure } = require('./backend/png-validator');
const { assertOutputParent } = require('./image-engine-runner');

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const MAX_EARLY_MESSAGES = 256;
const SLOTS = ['diffusion', 'text_encoder', 'vae', 'prompt', 'width', 'height', 'seed'];
const PROMPT_ID = /^[A-Za-z0-9-]{1,64}$/;
const OUTPUT_NAME = /^[A-Za-z0-9._-]{1,128}\.png$/;
const PER_PROMPT_EVENTS = new Set(['execution_start', 'progress', 'executing', 'executed',
  'execution_success', 'execution_error', 'execution_interrupted']);

const invalid = () => new Error('image_invalid_params');
const has = (object, key) => object !== null && typeof object === 'object' && Object.hasOwn(object, key);
const safeText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');

// Everything ComfyUI says can carry control bytes and absolute paths.
function sanitizeLine(text) {
  /* eslint-disable no-control-regex */
  return String(text).replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
    .replace(/[A-Za-z]:[\\/][^\s]+|(?<![A-Za-z0-9_])\/[^\s]+/g, '<path>')
    .trim().slice(0, 512);
  /* eslint-enable no-control-regex */
}

function fillRecipeGraph(recipe, { loaderNames, prompt, width, height, seed } = {}) {
  if (!recipe || typeof recipe.graph !== 'object' || recipe.graph === null || !recipe.slots
    || !Array.isArray(recipe.resolutions)) throw invalid();
  const values = {};
  for (const slot of ['diffusion', 'text_encoder', 'vae']) {
    const name = loaderNames?.[slot];
    if (!safeText(name, 1024)) throw invalid();
    values[slot] = name;
  }
  if (!safeText(prompt, 4000)) throw invalid();
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || !recipe.resolutions.includes(`${width}x${height}`)) throw invalid();
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) throw invalid();
  Object.assign(values, { prompt, width, height, seed });
  const graph = structuredClone(recipe.graph);
  for (const slot of SLOTS) {
    const target = recipe.slots[slot];
    if (!Array.isArray(target) || target.length !== 2) throw invalid();
    const [nodeId, inputName] = target;
    if (!has(graph, nodeId) || !has(graph[nodeId].inputs, inputName)) throw invalid();
    graph[nodeId].inputs[inputName] = values[slot];
  }
  return graph;
}

function validateOptions(options) {
  const { server, recipe, deadlineMs, fsImpl } = options;
  if (!server || !Number.isSafeInteger(server.port) || server.port < 1 || server.port > 65535
    || server.baseUrl !== `http://127.0.0.1:${server.port}`
    || typeof server.opId !== 'string' || !/^img_[a-f0-9]{12}$/.test(server.opId)
    || !safeText(server.outputDir, 1024) || !path.isAbsolute(server.outputDir)
    || !Number.isFinite(deadlineMs) || deadlineMs <= 0) throw invalid();
  let root;
  try {
    if (!fsImpl.statSync(server.outputDir).isDirectory()) throw invalid();
    root = fsImpl.realpathSync(server.outputDir);
  } catch (_error) { throw invalid(); }
  const graph = fillRecipeGraph(recipe, { loaderNames: options.loaderNames, ...options.params });
  if (!recipe.phase_nodes || !['sample', 'decode', 'output'].every((key) => safeText(recipe.phase_nodes[key], 64))) throw invalid();
  return { graph, root };
}

// The one image entry we accept: a bare .png name directly in the output directory.
function outputName(entry) {
  if (!entry || typeof entry !== 'object' || entry.type !== 'output' || entry.subfolder !== ''
    || typeof entry.filename !== 'string' || !OUTPUT_NAME.test(entry.filename)) return null;
  return entry.filename;
}

function removeOutput(root, name, fsImpl) {
  if (!name) return;
  try { assertOutputParent(root, path.join(root, name), fsImpl); fsImpl.unlinkSync(path.join(root, name)); }
  catch (_error) { /* Missing output or changed containment is safe to leave alone. */ }
}

function readOutput(root, name, expected, fsImpl) {
  const outputPath = path.join(root, name);
  try {
    assertOutputParent(root, outputPath, fsImpl);
    const stat = fsImpl.lstatSync(outputPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { reason: 'image_output_invalid', png: null };
    if (path.dirname(fsImpl.realpathSync(outputPath)) !== root) return { reason: 'image_output_invalid', png: null };
    const guardedFs = Object.create(fsImpl);
    guardedFs.fstatSync = (descriptor) => {
      const snapshot = fsImpl.fstatSync(descriptor);
      if (!sameFileSnapshot(stat, snapshot)) throw new Error('image_output_invalid');
      return snapshot;
    };
    const read = readBoundedRegularFile({ fsImpl: guardedFs, filePath: outputPath, maxBytes: MAX_PNG_BYTES });
    if (!read.ok) return { reason: 'image_output_invalid', png: null };
    assertOutputParent(root, outputPath, fsImpl);
    const after = fsImpl.lstatSync(outputPath);
    if (after.isSymbolicLink() || !sameFileSnapshot(stat, after)
      || path.dirname(fsImpl.realpathSync(outputPath)) !== root) return { reason: 'image_output_invalid', png: null };
    const structure = readPngStructure(read.buffer);
    if (!structure.ok) return { reason: 'image_output_invalid', png: null };
    if (structure.width !== expected.width || structure.height !== expected.height) return { reason: 'image_output_mismatch', png: null };
    return { reason: '', png: { width: structure.width, height: structure.height, bytes: read.buffer.length, buffer: read.buffer } };
  } catch (error) {
    return { reason: error?.code === 'ENOENT' ? 'image_output_missing' : 'image_output_invalid', png: null };
  }
}

async function readBody(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return text.length > MAX_BODY_BYTES ? null : text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY_BYTES) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function refusalLine(body) {
  const first = Object.values(body?.node_errors && typeof body.node_errors === 'object' ? body.node_errors : {})[0];
  const entry = Array.isArray(first?.errors) ? first.errors[0] : null;
  const parts = [body?.error?.message, entry?.details || entry?.message].filter((part) => typeof part === 'string' && part);
  return sanitizeLine(parts.join(': ') || 'ComfyUI refused the prompt');
}

function runComfyGeneration(options = {}) {
  const base = { status: 'failed', reason: 'image_invalid_params', png: null,
    seconds: { load: null, sample: null, total: 0 }, stderrTail: [], promptId: null };
  const fsImpl = options?.fsImpl || fs;
  let graph;
  let root;
  try { ({ graph, root } = validateOptions({ ...options, fsImpl })); }
  catch (_error) { return Promise.resolve(base); }
  const { server, recipe, params, deadlineMs, abortSignal, onProgress, log, connectTimeoutMs = 10000, interruptGraceMs = 5000,
    fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, now = Date.now } = options;
  if (abortSignal?.aborted) return Promise.resolve({ ...base, status: 'cancelled', reason: 'image_cancelled' });
  const nodes = recipe.phase_nodes;
  const clock = () => { try { const time = now(); return Number.isFinite(time) ? time : Date.now(); } catch (_error) { return Date.now(); } };
  const startedAt = clock();

  return new Promise((resolve) => {
    const result = { ...base, reason: '', seconds: { ...base.seconds } };
    let done = false;
    let phase = 'connecting'; // connecting -> queueing -> running -> output
    let socket;
    let stopReason = null; // 'abort' | 'deadline'
    let interruptSent = false;
    let promptId = null;
    let lastImage = null;
    let executionStartedAt = null;
    let firstProgressAt = null;
    let decodeNotified = false;
    let lastProgressAt = -Infinity;
    let early = [];
    let connectTimer;
    let deadlineTimer;
    let graceTimer;
    const queueController = new AbortController();
    const notify = (event) => { try { onProgress?.(event); } catch (_error) { /* Consumer callbacks are isolated. */ } };
    const seconds = (from) => Math.max(0, clock() - from) / 1000;

    const finish = (status, reason, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer); clearTimeout(deadlineTimer); clearTimeout(graceTimer);
      try { abortSignal?.removeEventListener('abort', onAbort); } catch (_error) { /* best effort */ }
      queueController.abort();
      try { socket?.close(); } catch (_error) { /* best effort */ }
      Object.assign(result, { status, reason, promptId }, extra);
      result.seconds.total = seconds(startedAt);
      try { log?.(status === 'ok' ? 'INFO' : 'WARN', 'comfyui_runner.settled', { opId: server.opId, status, reason }); }
      catch (_error) { /* Diagnostics cannot interrupt a render. */ }
      resolve(result);
    };
    const fail = (line, reason = 'image_comfyui_failed') => finish('failed', reason, { stderrTail: [sanitizeLine(line)] });
    const finishStopped = (interruptSettled, entry = null) => {
      if (done) return;
      removeOutput(root, outputName(entry), fsImpl);
      finish(stopReason === 'abort' ? 'cancelled' : 'timeout', stopReason === 'abort' ? 'image_cancelled' : 'image_timeout',
        interruptSettled === undefined ? { png: null } : { png: null, interruptSettled });
    };

    const requestStop = (kind) => {
      if (done || stopReason) return;
      stopReason = kind;
      if (phase === 'connecting') { finishStopped(undefined); return; }
      if (phase === 'output') { finishStopped(true, lastImage); return; }
      if (phase === 'running') {
        graceTimer = setTimeout(() => finishStopped(false, lastImage), interruptGraceMs);
      }
      try {
        Promise.resolve(fetchImpl(`${server.baseUrl}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(2000) })).catch(() => {});
      } catch (_error) { /* The interrupt is best effort. */ }
      // A prompt still being queued has no id to wait on.
      if (phase === 'queueing') finishStopped(false);
    };
    function onAbort() { requestStop('abort'); }

    const progressEvent = (data) => {
      const { value, max } = data;
      if (!Number.isInteger(value) || !Number.isInteger(max) || value <= 0 || value > max || max > 1000) return;
      if (firstProgressAt === null) {
        firstProgressAt = clock();
        if (executionStartedAt !== null) result.seconds.load = Math.max(0, firstProgressAt - executionStartedAt) / 1000;
      }
      const time = clock();
      if (value !== max && time - lastProgressAt < 250) return;
      lastProgressAt = time;
      notify({ phase: 'sample', step: value, steps: max, fraction: value / max });
    };

    const finishOutput = async () => {
      phase = 'output';
      let entry = lastImage;
      if (!entry) {
        try { entry = await fetchHistoryImage(); } catch (_error) { entry = null; }
        if (done) return;
        if (stopReason) { finishStopped(true, entry); return; }
      }
      const name = outputName(entry);
      if (!entry) { finish('failed', 'image_output_missing'); return; }
      const output = name ? readOutput(root, name, params, fsImpl) : { reason: 'image_output_invalid', png: null };
      removeOutput(root, name, fsImpl);
      if (output.png) finish('ok', '', { png: output.png });
      else finish('failed', output.reason);
    };

    const handleEvent = (message) => {
      if (done) return;
      const { type, data } = message;
      if (stopReason && ['execution_interrupted', 'execution_error', 'execution_success'].includes(type)) {
        finishStopped(true, type === 'execution_success' ? lastImage : null);
        return;
      }
      switch (type) {
        case 'execution_start':
          if (executionStartedAt === null) { executionStartedAt = clock(); notify({ phase: 'load' }); }
          break;
        case 'progress':
          if (data.node === nodes.sample) progressEvent(data);
          break;
        case 'executing':
          if (data.node === nodes.decode && !decodeNotified) {
            decodeNotified = true;
            if (firstProgressAt !== null) result.seconds.sample = seconds(firstProgressAt);
            notify({ phase: 'decode' });
          }
          break;
        case 'executed':
          if (data.node === nodes.output && Array.isArray(data.output?.images)) lastImage = data.output.images[0] ?? null;
          break;
        case 'execution_success': finishOutput().catch(() => { if (!done) finish('failed', 'image_output_invalid'); }); break;
        case 'execution_error':
          fail([data.node_type, data.exception_type, data.exception_message]
            .filter((part) => typeof part === 'string' && part).join(': ') || 'ComfyUI execution failed');
          break;
        case 'execution_interrupted': fail('ComfyUI interrupted the job'); break;
        default: break;
      }
    };

    const onMessage = (event) => {
      if (done || typeof event?.data !== 'string' || event.data.length > MAX_BODY_BYTES) return;
      let message;
      try { message = JSON.parse(event.data); } catch (_error) { return; }
      if (!message || typeof message.type !== 'string' || !PER_PROMPT_EVENTS.has(message.type)
        || !message.data || typeof message.data !== 'object' || typeof message.data.prompt_id !== 'string') return;
      if (promptId === null) { if (early.length < MAX_EARLY_MESSAGES) early.push(message); return; }
      if (message.data.prompt_id === promptId) handleEvent(message);
    };
    const onSocketGone = () => {
      if (done || phase === 'output') return;
      if (stopReason) finishStopped(false, lastImage);
      else if (phase === 'connecting') fail('ComfyUI event connection failed');
      else fail('ComfyUI connection lost');
    };

    async function fetchHistoryImage() {
      const response = await fetchImpl(`${server.baseUrl}/history/${promptId}`, { signal: AbortSignal.timeout(15000) });
      if (response.status !== 200) return null;
      const entry = JSON.parse(await readBody(response) ?? 'null')?.[promptId];
      return has(entry?.outputs, nodes.output) && Array.isArray(entry.outputs[nodes.output]?.images)
        ? entry.outputs[nodes.output].images[0] ?? null : null;
    }

    async function queuePrompt() {
      try {
        const response = await fetchImpl(`${server.baseUrl}/prompt`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: graph, client_id: server.opId }),
          signal: AbortSignal.any([AbortSignal.timeout(15000), queueController.signal]),
        });
        const text = await readBody(response);
        if (done) return;
        let body = null;
        try { body = JSON.parse(text ?? 'null'); } catch (_error) { /* handled below */ }
        if (response.status === 400) { fail(refusalLine(body)); return; }
        if (response.status !== 200 || typeof body?.prompt_id !== 'string' || !PROMPT_ID.test(body.prompt_id)) {
          fail(`ComfyUI answered ${Number(response.status) || 'with an unusable reply'} to the prompt`);
          return;
        }
        promptId = body.prompt_id;
        phase = 'running';
        const queued = early;
        early = [];
        for (const message of queued) if (message.data.prompt_id === promptId) handleEvent(message);
      } catch (_error) { if (!done) fail('ComfyUI did not accept the prompt'); }
    }

    const onOpen = () => {
      if (done || phase !== 'connecting') return;
      clearTimeout(connectTimer);
      phase = 'queueing';
      void queuePrompt();
    };

    try {
      deadlineTimer = setTimeout(() => requestStop('deadline'), Math.min(deadlineMs, 2147483647));
      connectTimer = setTimeout(() => fail('ComfyUI event connection failed'), connectTimeoutMs);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      socket = new WebSocketImpl(`ws://127.0.0.1:${server.port}/ws?clientId=${server.opId}`);
      const handlers = { open: onOpen, message: onMessage, error: onSocketGone, close: onSocketGone };
      if (typeof socket.addEventListener === 'function') {
        for (const [name, handler] of Object.entries(handlers)) socket.addEventListener(name, handler);
      } else {
        for (const [name, handler] of Object.entries(handlers)) socket[`on${name}`] = handler;
      }
    } catch (_error) { fail('ComfyUI event connection failed'); }
  });
}

module.exports = { fillRecipeGraph, runComfyGeneration };
