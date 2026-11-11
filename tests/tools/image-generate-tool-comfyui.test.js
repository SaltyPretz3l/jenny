'use strict';

// Row 127: image_generate on a ComfyUI model set. The preflight runs before the
// chat engine is evicted, the recipe maps sizes and locks settings, and the
// server is stopped with proof before the restore.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { ChatGpuHandoffError, CHAT_GPU_HANDOFF_CODES } = require('../../services/backend/chat-gpu-handoff');
const { png, fixture, failed } = require('../helpers/image-generate-fixture');

const RECIPES = require('../../config/comfyui-recipes.json').recipes;
const RECIPE = RECIPES.minimax_h3_image;
const SET_ID = 'c0ffee123456';
const FOLDER = path.join(os.tmpdir(), 'ComfyUI_windows_portable');
const MODELS = path.join(FOLDER, 'ComfyUI', 'models');
const FILES = {
  diffusion: 'diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors',
  text_encoder: 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  vae: 'vae/minimax_h3_image_vae_fp16.safetensors',
};
const LOADER_NAMES = Object.fromEntries(Object.entries(FILES).map(([slot, name]) => [slot, name.split('/').slice(1).join(path.sep)]));

function comfyFixture(t, { owner: ownerPatch = {}, flags, run, resolveAgain, ...overrides } = {}) {
  const box = { calls: [] };
  const record = (...entry) => box.calls.push(entry);
  const set = { id: SET_ID, label: '', backend: 'comfyui', recipe: 'minimax_h3_image', root: MODELS,
    files: Object.fromEntries(Object.entries(FILES).map(([slot, name]) => [slot, { name, size_bytes: 1000 }])) };
  const paths = Object.fromEntries(Object.entries(FILES).map(([slot, name]) => [slot, path.join(MODELS, ...name.split('/'))]));
  const resolved = { ok: true, set, paths, comfy: { folder: FOLDER, modelsRoot: MODELS, loaderNames: LOADER_NAMES,
    pythonPath: path.join(FOLDER, 'python_embeded', 'python.exe'), mainPath: path.join(FOLDER, 'ComfyUI', 'main.py') } };
  let resolves = 0;
  const server = { opId: 'img_0123456789ab', pid: 4242, port: 50123, baseUrl: 'http://127.0.0.1:50123',
    runDir: path.join(os.tmpdir(), 'jenny-run'), outputDir: path.join(os.tmpdir(), 'jenny-run', 'output'), comfyuiVersion: '0.45.0' };
  let stopped = null;
  const owner = {
    async start(options) { record('start', options); return { ok: true, server }; },
    async missingNodes(srv, types) { record('nodes', types); return []; },
    async loaderValues(srv, node, input) {
      record('loader', node, input);
      return Object.values(LOADER_NAMES);
    },
    stop(srv) { record('stop', srv.opId); stopped ??= Promise.resolve({ confirmed: true }); return stopped; },
    ...ownerPatch,
  };
  const f = fixture(t, {
    resolveModelSet(id, options) {
      record('resolve', id, options);
      resolves += 1;
      return resolves > 1 && resolveAgain ? resolveAgain(resolved) : resolved;
    },
    listModelSets(options) { record('list', options); return { sets: [set], default_id: SET_ID }; },
    loadRecipes: () => ({ recipes: RECIPES }),
    async runComfyGeneration(options) {
      record('comfy_run', options);
      if (run) return run(options);
      if (options.abortSignal.aborted) return { status: 'cancelled', reason: 'image_cancelled', png: null, stderrTail: [] };
      options.onProgress({ phase: 'load' });
      options.onProgress({ phase: 'sample', step: 6, steps: 6, fraction: 1 });
      options.onProgress({ phase: 'decode' });
      const buffer = png(options.params.width, options.params.height);
      return { status: 'ok', reason: '', seconds: { load: 20, sample: 2, total: 44 },
        png: { width: options.params.width, height: options.params.height, bytes: buffer.length, buffer }, stderrTail: [] };
    },
    ...overrides,
  });
  box.calls = f.calls;
  f.context.backendService.comfyui = owner;
  f.context.backendService.featureFlags = { image_comfyui_enabled: true, ...flags };
  // A ComfyUI set needs no installed sd.cpp engine.
  f.context.backendService.imageEngine.resolveExecutable = () => { record('engine'); return { ok: false }; };
  return { ...f, owner, server, set, kinds: () => f.calls.map(([kind]) => kind) };
}

test('a missing recipe node stops the server and never evicts the chat engine', async (t) => {
  const f = comfyFixture(t, { owner: { async missingNodes() { return ['MiniMaxH3ImageConditioning']; } } });
  const result = await f.tool.execute(f.input, f.context);
  failed(result, 'image_comfyui_node_missing');
  assert.match(result.content, /MiniMaxH3ImageConditioning/);
  assert.match(result.content, /0\.45\.0/);
  assert.ok(f.kinds().includes('stop'));
  assert.equal(f.kinds().includes('suspend'), false);
  assert.equal(f.kinds().includes('comfy_run'), false);
});

test('happy path: preflight before eviction, mapped size, locked settings, stop before restore, comfyui provenance', async (t) => {
  const progress = [];
  const f = comfyFixture(t);
  f.context.onProgress = (event) => progress.push(event.phase);
  const result = await f.tool.execute({ ...f.input, steps: 25, negative_prompt: 'blur' }, f.context);
  assert.equal(result.isError, false, result.content);
  const kinds = f.kinds();
  // The render and the pre-restore safety net both ask for the stop; the owner answers once (same promise).
  assert.deepEqual(kinds.filter((kind, index) => ['start', 'nodes', 'suspend', 'comfy_run', 'stop', 'restore', 'artifact'].includes(kind)
    && kind !== kinds[index - 1]), ['start', 'nodes', 'suspend', 'comfy_run', 'stop', 'restore', 'artifact']);
  assert.equal(kinds.includes('engine'), false);
  assert.equal(kinds.filter((kind) => kind === 'loader').length, 3);
  const suspend = f.calls.find(([kind]) => kind === 'suspend');
  assert.deepEqual(suspend[2], { minTotalVramMb: RECIPE.min_total_vram_mb, requiredFreeMb: RECIPE.free_vram_mb });
  const start = f.calls.find(([kind]) => kind === 'start')[1];
  assert.match(start.opId, /^img_[a-f0-9]{12}$/);
  assert.equal(start.comfy.folder, FOLDER);
  const run = f.calls.find(([kind]) => kind === 'comfy_run')[1];
  assert.deepEqual(run.params, { prompt: 'A quiet garden', width: 2048, height: 2048, seed: 42 });
  assert.deepEqual(run.loaderNames, LOADER_NAMES);
  assert.equal(run.server, f.server);
  assert.equal(run.recipe.graph['7'].inputs.steps, 6);
  const artifact = f.calls.find(([kind]) => kind === 'artifact')[2];
  assert.deepEqual([artifact.width, artifact.height], [2048, 2048]);
  const provenance = result.metadata.provenance;
  assert.equal(provenance.backend, 'comfyui');
  assert.equal(provenance.family, 'minimax_h3_image');
  assert.equal(provenance.engine_tag, 'comfyui-0.45.0');
  assert.equal(provenance.quant, 'int8');
  assert.equal(provenance.model_label, 'MiniMax-H3-Image · int8');
  assert.equal(provenance.requested_size, '1024x1024');
  assert.deepEqual([provenance.width, provenance.height, provenance.steps, provenance.cfg_scale], [2048, 2048, 6, 1]);
  assert.equal(provenance.image_negative_prompt, undefined);
  assert.match(result.content, /Made 2048x2048 instead of 1024x1024/);
  assert.match(result.content, /these were not used: steps, negative_prompt\./);
  assert.deepEqual(progress, ['gpu', 'load', 'sample', 'decode']);
});

test('each schema pair maps to the recipe size of the same shape and an unchanged request adds no note', async (t) => {
  for (const [pair, native] of Object.entries(RECIPE.size_map)) {
    const f = comfyFixture(t);
    const [width, height] = pair.split('x').map(Number);
    const result = await f.tool.execute({ ...f.input, width, height, steps: 6, cfg_scale: 1 }, f.context);
    assert.equal(result.isError, false, result.content);
    const run = f.calls.find(([kind]) => kind === 'comfy_run')[1];
    assert.equal(`${run.params.width}x${run.params.height}`, native);
    assert.equal(result.content.includes('were not used'), false);
  }
  const f = comfyFixture(t);
  const result = await f.tool.execute({ ...f.input, width: 2048, height: 2048 }, f.context);
  failed(result, 'image_invalid_params');
  assert.equal(f.kinds().includes('start'), false);
});

test('the kill switch and a missing ComfyUI owner or folder refuse before anything starts', async (t) => {
  const off = comfyFixture(t, { flags: { image_comfyui_enabled: false } });
  failed(await off.tool.execute(off.input, off.context), 'image_comfyui_disabled');
  assert.equal(off.kinds().includes('start'), false);
  const noOwner = comfyFixture(t);
  delete noOwner.context.backendService.comfyui;
  failed(await noOwner.tool.execute(noOwner.input, noOwner.context), 'image_comfyui_missing');
  const noFolder = comfyFixture(t, { resolveAgain: (resolved) => resolved });
  noFolder.dependencies.resolveModelSet = undefined;
  const bare = comfyFixture(t, { resolveModelSet: () => ({ ok: true, set: noFolder.set, paths: {}, comfy: null }) });
  failed(await bare.tool.execute(bare.input, bare.context), 'image_comfyui_missing');
  assert.equal(bare.kinds().includes('start'), false);
});

test('start refusals map to their own reasons without eviction', async (t) => {
  for (const [started, reason, text] of [
    [{ ok: false, reason: 'image_comfyui_not_ours' }, 'image_comfyui_not_ours', /could not confirm/],
    [{ ok: false, reason: 'image_comfyui_start_failed', stderrTail: ['ModuleNotFoundError: torch'] }, 'image_comfyui_start_failed', /torch/],
    [{ ok: false, reason: 'image_comfyui_missing' }, 'image_comfyui_missing', /ComfyUI folder/],
    [{ ok: false, reason: 'image_engine_cleanup_pending' }, 'image_engine_cleanup_pending', /Clean up now/],
    [{ ok: false, reason: 'image_engine_launch_unrecorded' }, 'image_engine_launch_unrecorded', /recorded/],
  ]) {
    const f = comfyFixture(t, { owner: { async start() { return started; } } });
    const result = await f.tool.execute(f.input, f.context);
    failed(result, reason);
    assert.match(result.content, text);
    assert.equal(f.kinds().includes('suspend'), false);
  }
  const thrown = comfyFixture(t, { owner: { async start() { throw new Error('boom'); } } });
  failed(await thrown.tool.execute(thrown.input, thrown.context), 'image_comfyui_start_failed');
});

test('a model file ComfyUI does not list, or an unreachable node listing, stops the server before eviction', async (t) => {
  const f = comfyFixture(t, { owner: { async loaderValues() { return ['something_else.safetensors']; } } });
  const result = await f.tool.execute(f.input, f.context);
  failed(result, 'image_comfyui_model_missing');
  assert.match(result.content, /diffusion_models\/minimax_h3_image_pruned_int8_convrot\.safetensors/);
  assert.ok(f.kinds().includes('stop'));
  assert.equal(f.kinds().includes('suspend'), false);
  const unreachable = comfyFixture(t, { owner: { async missingNodes() { return null; } } });
  failed(await unreachable.tool.execute(unreachable.input, unreachable.context), 'image_comfyui_start_failed');
  assert.ok(unreachable.kinds().includes('stop'));
  const unproven = comfyFixture(t, { owner: { async missingNodes() { return ['KSampler']; }, async stop() { return { confirmed: false }; } } });
  failed(await unproven.tool.execute(unproven.input, unproven.context), 'image_engine_cleanup_pending');
});

test('a refused eviction stops the server; an unproven stop reports cleanup pending', async (t) => {
  const f = comfyFixture(t);
  const error = new ChatGpuHandoffError(CHAT_GPU_HANDOFF_CODES.VRAM_INSUFFICIENT, 'total_vram_below_floor');
  f.handoff.suspend = async () => { f.calls.push(['suspend']); throw error; };
  const result = await f.tool.execute(f.input, f.context);
  failed(result, CHAT_GPU_HANDOFF_CODES.VRAM_INSUFFICIENT);
  assert.deepEqual(f.kinds().slice(-2), ['suspend', 'stop']);
  const g = comfyFixture(t, { owner: { async stop() { return { confirmed: false }; } } });
  g.handoff.suspend = async () => { throw error; };
  failed(await g.tool.execute(g.input, g.context), 'image_engine_cleanup_pending');
});

test('an unproven stop after the render keeps the GPU lease as cleanup pending', async (t) => {
  const f = comfyFixture(t, { owner: { async stop() { f.calls.push(['stop']); return { confirmed: false }; } } });
  const result = await f.tool.execute(f.input, f.context);
  failed(result, 'image_engine_cleanup_pending');
  const restore = f.calls.find(([kind]) => kind === 'restore')[1];
  assert.equal(restore.cleanupConfirmed, false);
  assert.equal(restore.reason, 'unconfirmed');
  assert.equal(f.kinds().includes('artifact'), false);
});

test('a ComfyUI execution error is reported with service paths redacted', async (t) => {
  const f = comfyFixture(t, { run: () => ({ status: 'failed', reason: 'image_comfyui_failed', png: null,
    stderrTail: [`VAEDecode: RuntimeError: out of memory in ${MODELS}`] }) });
  const result = await f.tool.execute(f.input, f.context);
  failed(result, 'image_comfyui_failed', 'ok');
  assert.match(result.content, /^ComfyUI could not make the image\. VAEDecode: RuntimeError: out of memory in \[redacted\]$/);
  assert.equal(result.content.includes(FOLDER), false);
  const bad = comfyFixture(t, { run: () => ({ status: 'failed', reason: 'image_output_mismatch', png: null, stderrTail: [] }) });
  failed(await bad.tool.execute(bad.input, bad.context), 'image_output_invalid');
  for (const [status, reason] of [['cancelled', 'image_cancelled'], ['timeout', 'image_timeout']]) {
    const g = comfyFixture(t, { run: () => ({ status, reason, png: null, stderrTail: [] }) });
    failed(await g.tool.execute(g.input, g.context), reason);
    assert.ok(g.kinds().includes('stop'));
  }
});

test('a stale set after the eviction stops the server before the restore', async (t) => {
  const f = comfyFixture(t, { resolveAgain: () => ({ ok: false, reason: 'image_model_set_stale' }) });
  const result = await f.tool.execute(f.input, f.context);
  failed(result, 'image_model_set_stale');
  const kinds = f.kinds();
  assert.equal(kinds.includes('comfy_run'), false);
  assert.ok(kinds.indexOf('stop') < kinds.indexOf('restore'));
});

test('a cancel registered before the render starts answers with the stop proof', async (t) => {
  let render;
  let answer;
  const f = comfyFixture(t, { resolveAgain: (resolved) => resolved });
  f.handoff.registerRender = (value) => { render = value; f.calls.push(['register']); };
  const originalResolve = f.dependencies.resolveModelSet;
  let calls = 0;
  const tool = require('../../services/tools/builtin/image-generate-tool').createImageGenerateTool({
    ...f.dependencies,
    async resolveModelSet(...args) {
      calls += 1;
      if (calls === 2) answer = await render.cancel();
      return originalResolve(...args);
    },
  });
  const result = await tool.execute(f.input, f.context);
  failed(result, 'image_cancelled');
  assert.deepEqual(answer, { confirmed: true });
  assert.ok(f.kinds().indexOf('stop') < f.kinds().indexOf('restore'));
});

test('edits are unavailable on a ComfyUI set before anything starts', async (t) => {
  const f = comfyFixture(t);
  const result = await f.tool.execute({ ...f.input, source_artifact_id: 'artifact-1' }, f.context);
  failed(result, 'image_edit_unavailable');
  assert.equal(f.kinds().includes('start'), false);
});

test('a retained GPU lease is reconciled before ComfyUI starts, and refuses the start while still held', async (t) => {
  const f = comfyFixture(t);
  let retained = true;
  f.handoff.getState = () => ({ active: false, retained });
  f.handoff.reconcile = async () => { f.calls.push(['reconcile']); retained = false; return { confirmed: true }; };
  f.handoff.launchRefusal = () => (retained ? 'gpu_lease_held' : '');
  const result = await f.tool.execute(f.input, f.context);
  assert.equal(result.isError, false, result.content);
  assert.ok(f.kinds().indexOf('reconcile') < f.kinds().indexOf('start'));

  const g = comfyFixture(t);
  g.handoff.getState = () => ({ active: false, retained: true });
  g.handoff.reconcile = async () => { g.calls.push(['reconcile']); return { confirmed: false }; };
  g.handoff.launchRefusal = () => 'gpu_lease_held';
  failed(await g.tool.execute(g.input, g.context), CHAT_GPU_HANDOFF_CODES.CLEANUP_PENDING);
  assert.equal(g.kinds().includes('start'), false);
  assert.equal(g.kinds().includes('suspend'), false);

  const h = comfyFixture(t);
  h.handoff.getState = () => ({ active: true, retained: false });
  h.handoff.reconcile = async () => { h.calls.push(['reconcile']); };
  h.handoff.launchRefusal = () => 'gpu_lease_held';
  failed(await h.tool.execute(h.input, h.context), CHAT_GPU_HANDOFF_CODES.BUSY);
  assert.equal(h.kinds().includes('reconcile'), false);
  assert.equal(h.kinds().includes('start'), false);
});

test('a ComfyUI set whose recipe this build does not ship is reported stale before anything starts', async (t) => {
  const f = comfyFixture(t, { loadRecipes: () => ({ recipes: {} }) });
  failed(await f.tool.execute(f.input, f.context), 'image_model_set_stale');
  assert.equal(f.kinds().includes('start'), false);
});
