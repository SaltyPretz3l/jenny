'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { ChatGpuHandoffError, CHAT_GPU_HANDOFF_CODES } = require('../../services/backend/chat-gpu-handoff');
const { TOOL_ERROR_CODES } = require('../../services/backend/error-codes');
const toolModule = require('../../services/tools/builtin/image-generate-tool');
const { createImageGenerateTool, IMAGE_GENERATE_BUDGET_MS, RESTORE_RESERVE_MS, VALIDATION_MARGIN_MS } = toolModule;

const { ID, UUID, FAMILY, png, fixture, failed } = require('../helpers/image-generate-fixture');

test('registry fallback loads without requiring the unfinished runner', () => {
  const original = Module._load;
  const modulePath = require.resolve('../../services/tools/builtin/image-generate-tool');
  delete require.cache[modulePath];
  try {
    Module._load = function(request, ...args) {
      if (request === '../../image-engine-runner') throw new Error('runner missing');
      return original.call(this, request, ...args);
    };
    const loaded = require(modulePath);
    assert.equal(loaded.name, 'image_generate');
    assert.equal(typeof loaded.execute, 'function');
  } finally { Module._load = original; }
});

test('advertised complete size pairs and defaults match every installed family preset', () => {
  const manifest = require('../../services/tools/tool-manifest.json');
  const families = require('../../config/sdcpp-families.json').families;
  const descriptor = manifest.tools.find(({ name }) => name === 'image_generate');
  const advertised = [...new Set(descriptor.description.match(/\d+x\d+/g))];
  assert.equal(advertised.length, 8);
  for (const family of Object.values(families)) {
    assert.deepEqual(advertised, family.resolutions);
  }
  const { width, height } = descriptor.parameters.properties;
  assert.deepEqual([width.default, height.default], [1024, 1024]);
  assert.deepEqual(width.enum, advertised.map((pair) => Number(pair.split('x')[0])));
  assert.deepEqual(height.enum, advertised.map((pair) => Number(pair.split('x')[1])));
  assert.ok(descriptor.description.includes('portrait example: 1120x1472'));
  assert.ok(descriptor.description.includes('landscape example: 1472x1120'));
  assert.ok(descriptor.description.includes('do not combine dimensions from different pairs'));
});

test('collaborators are checked before the engine or model set', async (t) => {
  for (const missing of ['chatGpuHandoff', 'imageEngine', 'artifactService', 'sessionId', 'streamId', 'callId', 'workingDirectory', 'backendService']) {
    const f = fixture(t);
    if (['chatGpuHandoff', 'imageEngine'].includes(missing)) delete f.context.backendService[missing];
    else delete f.context[missing];
    const result = await f.tool.execute(f.input, f.context);
    failed(result, 'image_tool_unavailable');
    assert.equal(result.content, 'Image generation is not available in this session.');
    assert.deepEqual(f.calls, []);
  }
});

test('engine missing stops before model resolution', async (t) => {
  const f = fixture(t);
  f.context.backendService.imageEngine.resolveExecutable = () => ({ ok: false, reason: 'image_engine_missing' });
  const result = await f.tool.execute(f.input, f.context);
  failed(result, 'image_engine_missing');
  assert.equal(result.content, 'No image engine is installed. Install it in Settings > Models > Image engine.');
  assert.deepEqual(f.calls, []);
});

test('missing, stale, store-error and unknown-family sets fail before handoff', async (t) => {
  for (const reason of ['none', 'image_model_set_stale', 'model_set_not_found', 'store_error', 'unknown_family']) {
    const f = fixture(t, reason === 'none' ? { listModelSets: () => ({ sets: [], default_id: null }) }
      : reason === 'unknown_family' ? { loadFamilies: () => ({ families: {} }) }
        : { resolveModelSet: () => ({ ok: false, reason }) });
    failed(await f.tool.execute(f.input, f.context), reason === 'image_model_set_stale' ? reason : 'image_model_set_missing');
    assert.equal(f.calls.some(([kind]) => kind === 'suspend'), false);
  }
});

test('every parameter violation names the parameter and stops before suspend', async (t) => {
  const invalid = [
    ['prompt', undefined], ['prompt', ' \0 '], ['prompt', 'x'.repeat(2001)], ['prompt', 12],
    ['negative_prompt', 'x'.repeat(2001)], ['negative_prompt', 12],
    ['width', 512], ['width', '1024'], ['height', 0], ['height', 1024.5],
    ['steps', 0], ['steps', 101], ['steps', 1.5], ['steps', '20'],
    ['seed', -1], ['seed', 4294967296], ['seed', 0.5], ['seed', '42'],
    ['cfg_scale', 0], ['cfg_scale', 21], ['cfg_scale', NaN], ['cfg_scale', '2'],
    ['model_set_id', '../bad'], ['model_set_id', 'ABCDEF123456'], ['model_set_id', ''], ['model_set_id', 12],
  ];
  for (const [parameter, value] of invalid) {
    const f = fixture(t);
    const result = await f.tool.execute({ ...f.input, [parameter]: value }, f.context);
    failed(result, 'image_invalid_params');
    assert.equal(result.metadata.failure_class, 'bad_arguments');
    assert.equal(result.metadata.effects, 'none');
    assert.ok(result.metadata.remediation.includes('image_generate'));
    assert.ok(result.content.includes(parameter), result.content);
    assert.equal(result.content.includes('\n'), false);
    if (parameter === 'width' || parameter === 'height') {
      for (const size of FAMILY.resolutions) assert.ok(result.content.includes(size));
    }
    assert.equal(f.calls.some(([kind]) => kind === 'suspend'), false);
  }
});

test('mismatched size pairs and invalid dimension types carry repair advice without GPU work', async (t) => {
  for (const [width, height] of [[1472, 1472], [1024, 1120], [1024, '1024'],
    [null, 1024], [true, 1024], [1024, NaN], [Infinity, 1024]]) {
    const f = fixture(t);
    const result = await f.tool.execute({ ...f.input, width, height }, f.context);
    failed(result, 'image_invalid_params');
    assert.equal(result.metadata.failure_class, 'bad_arguments');
    assert.equal(result.metadata.effects, 'none');
    assert.ok(result.metadata.remediation.includes('matching width/height pair'));
    assert.ok(result.metadata.remediation.includes('omit both dimensions'));
    for (const size of FAMILY.resolutions) assert.ok(result.metadata.remediation.includes(size));
    assert.equal(f.calls.some(([kind]) => ['suspend', 'register', 'run', 'artifact', 'restore'].includes(kind)), false);
  }
});

test('handoff errors surface their translated message, reason and detail without a render', async (t) => {
  for (const code of [CHAT_GPU_HANDOFF_CODES.BUSY, CHAT_GPU_HANDOFF_CODES.EVICTION_UNVERIFIED,
    CHAT_GPU_HANDOFF_CODES.VRAM_INSUFFICIENT, CHAT_GPU_HANDOFF_CODES.CLEANUP_PENDING]) {
    const f = fixture(t);
    const error = new ChatGpuHandoffError(code, 'test_detail');
    f.handoff.suspend = async () => { throw error; };
    const result = await f.tool.execute(f.input, f.context);
    failed(result, code);
    assert.equal(result.content, error.message);
    assert.equal(result.metadata.detail, 'test_detail');
    assert.equal(f.calls.some(([kind]) => ['run', 'restore'].includes(kind)), false);
  }
  const f = fixture(t);
  f.handoff.suspend = async () => { throw new Error('unexpected'); };
  failed(await f.tool.execute(f.input, f.context), 'image_gpu_eviction_unverified');
});

test('happy path uses exact argv, publishes after release, records provenance and removes scratch PNG', async (t) => {
  const f = fixture(t);
  const result = await f.tool.execute({ ...f.input, model_set_id: ID, negative_prompt: 'blur', width: 1472, height: 1120, steps: 25, cfg_scale: 4 }, f.context);
  assert.equal(result.isError, false);
  assert.equal(result.content, 'Image: A quiet garden.\nGenerated a 1472x1120 image (seed 42, 25 steps, 3s).\n'
    + 'Saved as artifacts/generated.png. The image is already shown to the user in the chat.\n'
    + 'The primary image is already shown in chat. Briefly acknowledge completion; do not add another Markdown image or invent an image URL.\n'
    + JSON.stringify({ image_title: 'A quiet garden', source_artifact_id: 'artifact-1' }));
  assert.equal(result.metadata.result_kind, 'image_generated');
  assert.deepEqual(result.metadata.generatedArtifacts, [f.artifact]);
  assert.deepEqual(result.metadata.provenance, { backend: 'sdcpp', family: 'test_family', engine_tag: 'test-tag',
    model_set_id: ID, quant: 'Q4_K', model_label: 'test_family · Q4_K', seed: 42, width: 1472, height: 1120, steps: 25, cfg_scale: 4,
    image_prompt: 'A quiet garden', image_negative_prompt: 'blur' });
  const [, owner, memory] = f.calls.find(([kind]) => kind === 'suspend');
  assert.deepEqual(owner, { kind: 'builtin', tool_name: 'image_generate', call_id: 'call-1', stream_id: 'stream-1' });
  assert.deepEqual(memory, { minTotalVramMb: 8000, requiredFreeMb: 3002 });
  const options = f.calls.find(([kind]) => kind === 'run')[1];
  assert.equal(options.opId, 'img_0123456789ab');
  assert.equal(options.exePath, path.join(f.root, 'sd-cli.exe'));
  assert.equal(options.userDataPath, f.root);
  assert.equal(options.log, f.context.logger);
  assert.equal(options.expectedWidth, 1472);
  assert.equal(options.expectedHeight, 1120);
  assert.equal(IMAGE_GENERATE_BUDGET_MS, 900000);
  assert.equal(RESTORE_RESERVE_MS, 200000);
  assert.equal(VALIDATION_MARGIN_MS, 10000);
  assert.equal(options.deadlineMs, 690000);
  assert.equal(options.scratchDir, path.join(f.root, 'image-engine-scratch'));
  assert.equal(options.outputPath, path.join(options.scratchDir, `${options.opId}.png`));
  assert.deepEqual(options.argv, ['--diffusion-model', f.paths.diffusion, '--llm', f.paths.text_encoder,
    '--vae', f.paths.vae, '-p', 'A quiet garden', '-n', 'blur', '-W', '1472', '-H', '1120', '--steps', '25',
    '--cfg-scale', '4', '--sampling-method', 'euler', '--flow-shift', '3', '-s', '42', '--fa', '--offload-to-cpu', '-o', options.outputPath]);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'restore'), [['restore', { cleanupConfirmed: true, reason: 'ok', recorded: true }]]);
  assert.ok(f.calls.findIndex(([kind]) => kind === 'restore') < f.calls.findIndex(([kind]) => kind === 'artifact'));
  const [, sessionId, artifactInput] = f.calls.find(([kind]) => kind === 'artifact');
  assert.equal(sessionId, f.context.sessionId);
  assert.deepEqual(artifactInput, { content: png(1472, 1120), artifactKind: 'image', mimeType: 'image/png',
    title: 'A quiet garden', fileName: 'A quiet garden.png', width: 1472, height: 1120, pngValidated: true });
  assert.equal(fs.existsSync(options.outputPath), false);
  assert.deepEqual(f.calls.find(([kind]) => kind === 'resolve').slice(1), [ID, { storePath: path.join(f.root, 'image-models.json') }]);
  assert.equal(f.calls.some(([kind]) => kind === 'list'), false);
});

// F29: the persisted tool_result keeps the prompt sent to the engine. The
// canonical normalizer redacts engine/system prompt keys named "prompt", so
// provenance must not use that name or the caption showed "[redacted]".
test('provenance labels the model with the saved set label, else the family label', async (t) => {
  const labelled = fixture(t);
  labelled.set.label = '  My Qwen  ';
  assert.equal((await labelled.tool.execute(labelled.input, labelled.context)).metadata.provenance.model_label, 'My Qwen');
  const family = fixture(t, { loadFamilies: () => ({ families: { test_family: { ...FAMILY, label: 'Test Family' } } }) });
  assert.equal((await family.tool.execute(family.input, family.context)).metadata.provenance.model_label, 'Test Family · Q4_K');
});

test('provenance survives the canonical tool_result normalizer unchanged', async (t) => {
  const { buildCanonicalTurnEvent } = require('../../services/backend/canonical-turn-event');
  const f = fixture(t);
  const result = await f.tool.execute({ ...f.input, model_set_id: ID, negative_prompt: 'blur' }, f.context);
  assert.equal(result.isError, false);
  const event = buildCanonicalTurnEvent({ type: 'tool_execution_completed', turn_id: 'turn-1', seq: 1,
    tool_call_id: 'call-1', payload: { tool_call_id: 'call-1', tool_name: 'image_generate', metadata: result.metadata } });
  assert.deepEqual(event.payload.metadata.provenance, result.metadata.provenance);
  assert.equal(JSON.stringify(event.payload).includes('[redacted]'), false);
});

test('default set and parameters resolve; shell characters remain verbatim; controls are removed', async (t) => {
  const f = fixture(t);
  const prompt = '" & | < > ^ %\n\t';
  const result = await f.tool.execute({ prompt: ` \0${prompt}draw\x7f ` }, f.context);
  assert.equal(result.isError, false);
  assert.deepEqual(f.calls.find(([kind]) => kind === 'list')[1], { storePath: path.join(f.root, 'image-models.json') });
  const argv = f.calls.find(([kind]) => kind === 'run')[1].argv;
  assert.equal(argv[argv.indexOf('-p') + 1], `${prompt}draw`);
  assert.equal(argv.includes('-n'), false);
  assert.equal(argv[argv.indexOf('--steps') + 1], '20');
  assert.equal(argv[argv.indexOf('--cfg-scale') + 1], '2.5');
  assert.equal(argv[argv.indexOf('-W') + 1], '1024');
  assert.equal(argv[argv.indexOf('-H') + 1], '1024');
  assert.ok(Number.isInteger(result.metadata.provenance.seed));
  assert.ok(result.metadata.provenance.seed >= 0 && result.metadata.provenance.seed <= 4294967295);
  // F27: provenance records the cleaned prompt actually sent, and no negative prompt when none was set.
  assert.equal(result.metadata.provenance.image_prompt, `${prompt}draw`);
  assert.equal(Object.hasOwn(result.metadata.provenance, 'image_negative_prompt'), false);
});

// F27: the chat model gets its own copy of the picture, at most 1024 px on the long side.
function fakeNativeImage(resizes) {
  return (buffer) => ({
    toPNG: () => buffer,
    resize(options) {
      resizes.push(options);
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      const scale = (options.width || options.height * width / height) / width;
      return { toPNG: () => png(Math.round(width * scale), Math.round(height * scale)) };
    },
  });
}

test('a successful render hands the model a copy at most 1024 px on the long side', async (t) => {
  const resizes = [];
  const f = fixture(t, { createNativeImage: fakeNativeImage(resizes) });
  const wide = await f.tool.execute({ ...f.input, width: 1472, height: 1120 }, f.context);
  assert.equal(wide.isError, false);
  assert.deepEqual(resizes, [{ width: 1024 }]);
  assert.deepEqual(wide.previewImage, { buffer: png(1024, 779), width: 1024, height: 779, mime_type: 'image/png' });
  const square = await f.tool.execute(f.input, f.context);
  assert.equal(resizes.length, 1);
  assert.deepEqual(square.previewImage, { buffer: png(1024, 1024), width: 1024, height: 1024, mime_type: 'image/png' });
});

test('failed renders carry no model image and an unavailable encoder leaves the image result intact', async (t) => {
  const failedRender = fixture(t, { createNativeImage: fakeNativeImage([]),
    runImageGeneration: async () => ({ status: 'failed', exitCode: 1, stderrTail: [] }) });
  const failure = await failedRender.tool.execute(failedRender.input, failedRender.context);
  failed(failure, 'image_engine_failed');
  assert.equal(failure.previewImage, undefined);
  const noEncoder = fixture(t, { createNativeImage: () => { throw new Error('nativeImage unavailable'); } });
  const result = await noEncoder.tool.execute(noEncoder.input, noEncoder.context);
  assert.equal(result.isError, false);
  assert.equal(result.previewImage, undefined);
  assert.deepEqual(result.metadata.generatedArtifacts, [noEncoder.artifact]);
});

test('cancel before or during rendering and close-style cancellation abort the runner and still restore', async (t) => {
  for (const trigger of ['before', 'during', 'close']) {
    const controller = new AbortController();
    if (trigger === 'before') controller.abort();
    const f = fixture(t, { runImageGeneration: async (options) => {
      if (trigger === 'during') controller.abort();
      if (trigger === 'close') f.calls.find(([kind]) => kind === 'register')[1].cancel();
      assert.equal(options.abortSignal.aborted, true);
      return { status: 'cancelled' };
    } });
    f.context.abortSignal = controller.signal;
    failed(await f.tool.execute(f.input, f.context), 'image_cancelled', 'ok');
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'restore'), [['restore', { cleanupConfirmed: true, reason: 'cancelled', recorded: true }]]);
  }
});

test('the registered cancel answers with the runner settlement, so close() gets real proof', async (t) => {
  for (const status of ['cancelled', 'unconfirmed']) {
    let release;
    const running = new Promise((resolve) => { release = resolve; });
    const f = fixture(t, { runImageGeneration: async (options) => {
      await running;
      assert.equal(options.abortSignal.aborted, true);
      return { status, exitCode: null, stderrTail: [] };
    } });
    const execution = f.tool.execute(f.input, f.context);
    while (!f.calls.some(([kind]) => kind === 'register')) await new Promise((resolve) => setImmediate(resolve));
    const settlement = f.calls.find(([kind]) => kind === 'register')[1].cancel('runtime_closing');
    release();
    assert.deepEqual(await settlement, { confirmed: status !== 'unconfirmed' });
    const result = await execution;
    assert.equal(result.metadata.reason, status === 'cancelled' ? 'image_cancelled' : 'image_engine_cleanup_pending');
  }
});

test('an unrecorded launch is passed to the handoff so a missing pidfile is not taken as proof', async (t) => {
  const f = fixture(t, { runImageGeneration: async () => ({ status: 'launch_unrecorded', exitCode: null, stderrTail: [], recorded: false }) });
  failed(await f.tool.execute(f.input, f.context), 'image_engine_launch_unrecorded', 'ok');
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'restore'),
    [['restore', { cleanupConfirmed: true, reason: 'launch_unrecorded', recorded: false }]]);
});

test('the render deadline follows the sidecar wait minus the restore reserve and the time already spent', async (t) => {
  let clock = 1000;
  const f = fixture(t, { now: () => clock, resolveModelSet(id, options) { clock += 30_000; f.calls.push(['resolve', id, options]); return { ok: true, set: f.set, paths: f.paths }; } });
  f.context.timeoutMs = 600_000;
  assert.equal((await f.tool.execute(f.input, f.context)).isError, false);
  // The set is resolved twice (before and after the eviction), 30 s each here.
  assert.equal(f.calls.find(([kind]) => kind === 'run')[1].deadlineMs, 600_000 - 200_000 - 10_000 - 60_000);
  assert.equal(f.calls.filter(([kind]) => kind === 'resolve').length, 2);
  const short = fixture(t);
  short.context.timeoutMs = 260_000;
  failed(await short.tool.execute(short.input, short.context), 'image_invalid_params');
  assert.equal(short.calls.some(([kind]) => kind === 'suspend'), false, 'no GPU handoff without a usable budget');
  assert.match((await short.tool.execute(short.input, short.context)).content, /time budget/);
});

test('after the eviction the model set is re-resolved and the remaining budget re-checked before the spawn', async (t) => {
  let resolves = 0;
  const stale = fixture(t, { resolveModelSet(id, options) {
    resolves += 1;
    stale.calls.push(['resolve', id, options]);
    if (resolves === 1) return { ok: true, set: stale.set, paths: stale.paths };
    return { ok: true, set: stale.set, paths: { ...stale.paths, vae: path.join(stale.root, 'swapped.gguf') } };
  } });
  failed(await stale.tool.execute(stale.input, stale.context), 'image_model_set_stale', 'ok');
  assert.equal(stale.calls.some(([kind]) => kind === 'run'), false, 'nothing is spawned on a changed path');
  assert.equal(stale.calls.filter(([kind]) => kind === 'restore').length, 1);
  let clock = 1000;
  const slow = fixture(t, { now: () => clock });
  slow.handoff.suspend = async (...args) => { slow.calls.push(['suspend', ...args]); clock += 700_000; return { leaseId: 'lease-1' }; };
  failed(await slow.tool.execute(slow.input, slow.context), 'image_invalid_params', 'ok');
  assert.equal(slow.calls.some(([kind]) => kind === 'run'), false);
  assert.equal(slow.calls.filter(([kind]) => kind === 'restore').length, 1, 'the lease is released after a slow eviction');
});

test('prompts that are output flags are rejected before any handoff', async (t) => {
  const f = fixture(t);
  for (const prompt of ['-o', '--output', '--output=C:\\x.png', '-o C:\\x.png']) {
    failed(await f.tool.execute({ prompt }, f.context), 'image_invalid_params');
    failed(await f.tool.execute({ prompt: 'ok', negative_prompt: prompt }, f.context), 'image_invalid_params');
  }
  assert.equal(f.calls.some(([kind]) => kind === 'suspend'), false);
  assert.equal((await f.tool.execute({ prompt: 'an old outpost' }, f.context)).isError, false);
});

test('a custom engine is tagged custom in provenance and an unknown set id names the id problem', async (t) => {
  const f = fixture(t);
  f.context.backendService.imageEngine.resolveExecutable = async () => ({ ok: true, path: path.join(f.root, 'sd-cli.exe'), source: 'custom', tag: 'test-tag' });
  assert.equal((await f.tool.execute(f.input, f.context)).metadata.provenance.engine_tag, 'custom');
  const missing = fixture(t, { resolveModelSet: () => ({ ok: false, reason: 'model_set_not_found' }) });
  const result = await missing.tool.execute({ ...missing.input, model_set_id: '0123456789ab' }, missing.context);
  failed(result, 'image_model_set_missing');
  assert.match(result.content, /No saved image model set has that id/);
});

test('runner outcomes map reasons, release once and clean scratch except unconfirmed', async (t) => {
  for (const [status, reason] of [['cancelled', 'image_cancelled'], ['timeout', 'image_timeout'],
    ['failed', 'image_engine_failed'], ['unconfirmed', 'image_engine_cleanup_pending'], ['launch_unrecorded', 'image_engine_launch_unrecorded']]) {
    let outputPath;
    const f = fixture(t, { runImageGeneration: async (options) => {
      outputPath = options.outputPath;
      await fs.promises.writeFile(outputPath, 'partial');
      return { status, exitCode: 7, stderrTail: ['old line', '\x1b[31mrender failed\x1b[0m\0'] };
    } });
    const result = await f.tool.execute(f.input, f.context);
    failed(result, reason, 'ok');
    if (status === 'failed') assert.equal(result.content, 'The image engine failed (exit 7). render failed');
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'restore'), [['restore', { cleanupConfirmed: status !== 'unconfirmed', reason: status, recorded: true }]]);
    assert.equal(fs.existsSync(outputPath), status === 'unconfirmed');
    assert.equal(f.calls.some(([kind]) => kind === 'artifact'), false);
  }
});

test('failed chat restore still returns the image and restart guidance', async (t) => {
  const f = fixture(t);
  f.handoff.restoreAndRelease = async (options) => { f.calls.push(['restore', options]); return { restored: false, released: true }; };
  const result = await f.tool.execute(f.input, f.context);
  assert.equal(result.isError, false);
  assert.equal(result.metadata.chat_restore, 'failed');
  assert.equal(result.metadata.reason, 'image_chat_restore_failed');
  assert.equal(result.content.split('\n')[2], 'Saved as artifacts/generated.png. The image is already shown to the user in the chat.');
  assert.equal(result.content.split('\n').at(-1), 'The chat engine did not come back; send your next message to restart it.');
  assert.deepEqual(result.metadata.generatedArtifacts, [f.artifact]);
});

test('unexpected runner and setup throws restore once, report engine failure and clean partial output', async (t) => {
  for (const trigger of ['runner', 'mkdir', 'register']) {
    const f = fixture(t, { runImageGeneration: async (options) => {
      f.calls.push(['run', options]);
      await fs.promises.writeFile(options.outputPath, 'partial');
      throw new Error('unexpected runner exception');
    } });
    if (trigger === 'mkdir') f.dependencies.fs = { promises: { ...fs.promises, mkdir: async () => { throw new Error('mkdir failed'); } } };
    if (trigger === 'register') f.handoff.registerRender = () => { throw new Error('register failed'); };
    const result = await createImageGenerateTool(f.dependencies).execute(f.input, f.context);
    failed(result, 'image_engine_failed', 'ok');
    assert.equal(f.calls.filter(([kind]) => kind === 'restore').length, 1);
    const run = f.calls.find(([kind]) => kind === 'run');
    if (run) assert.equal(fs.existsSync(run[1].outputPath), false);
  }
});

test('artifact exceptions or missing metadata fail after release and remove the PNG', async (t) => {
  for (const mode of ['throw', 'missing']) {
    const f = fixture(t);
    f.context.artifactService.createBinaryArtifact = async () => {
      assert.equal(f.calls.filter(([kind]) => kind === 'restore').length, 1);
      if (mode === 'throw') throw new Error('artifact failure');
      return { output: 'no metadata' };
    };
    failed(await f.tool.execute(f.input, f.context), 'image_artifact_failed', 'ok');
    assert.equal(fs.existsSync(f.calls.find(([kind]) => kind === 'run')[1].outputPath), false);
  }
});

test('unreadable, oversized, corrupt and wrong-dimension PNGs are rejected after release', async (t) => {
  for (const mode of ['missing', 'oversized', 'corrupt', 'dimensions']) {
    const f = fixture(t, { runImageGeneration: async (options) => {
      f.calls.push(['run', options]);
      if (mode !== 'missing') await fs.promises.writeFile(options.outputPath,
        mode === 'oversized' ? Buffer.alloc(10 * 1024 * 1024 + 1) : mode === 'corrupt' ? Buffer.from('not png') : png(1, 1));
      return { status: 'ok', seconds: { total: 3 } };
    } });
    failed(await f.tool.execute(f.input, f.context), 'image_output_invalid', 'ok');
    assert.equal(f.calls.filter(([kind]) => kind === 'restore').length, 1);
    assert.equal(f.calls.some(([kind]) => kind === 'artifact'), false);
    assert.equal(fs.existsSync(f.calls.find(([kind]) => kind === 'run')[1].outputPath), false);
  }
});

test('parameter boundaries are accepted and caller paths cannot change engine arguments', async (t) => {
  for (const [seed, steps, cfgScale] of [[0, 1, 1], [4294967295, 100, 20]]) {
    const f = fixture(t);
    const result = await f.tool.execute({ prompt: 'x'.repeat(2000), negative_prompt: 'y'.repeat(2000),
      seed, steps, cfg_scale: cfgScale, exePath: 'caller.exe', diffusion: 'caller.gguf', outputPath: 'caller.png' }, f.context);
    assert.equal(result.isError, false);
    const options = f.calls.find(([kind]) => kind === 'run')[1];
    assert.equal(options.exePath, path.join(f.root, 'sd-cli.exe'));
    assert.equal(options.argv.includes('caller.gguf'), false);
    assert.equal(options.argv.includes('caller.png'), false);
    assert.deepEqual([result.metadata.provenance.seed, result.metadata.provenance.steps, result.metadata.provenance.cfg_scale], [seed, steps, cfgScale]);
  }
});

test('reading happens after release and best-effort deletion does not discard the artifact', async (t) => {
  const f = fixture(t);
  const realRead = fs.promises.readFile;
  const tool = createImageGenerateTool({ ...f.dependencies, fs: { promises: { ...fs.promises,
    readFile: async (...args) => {
      assert.equal(f.calls.filter(([kind]) => kind === 'restore').length, 1);
      return realRead(...args);
    },
    unlink: async () => { throw new Error('file locked'); },
  } } });
  const result = await tool.execute(f.input, f.context);
  assert.equal(result.isError, false);
  assert.deepEqual(result.metadata.generatedArtifacts, [f.artifact]);
});

test('failure maps chat restore failure and redacts service-owned paths from stderr', async (t) => {
  const f = fixture(t, { runImageGeneration: async () => ({ status: 'failed', exitCode: 8,
    stderrTail: [`cannot read ${f.paths.diffusion}\n${f.root}`] }) });
  f.handoff.restoreAndRelease = async (options) => { f.calls.push(['restore', options]); return { restored: false, released: true }; };
  const result = await f.tool.execute(f.input, f.context);
  failed(result, 'image_engine_failed', 'failed');
  assert.equal(result.content.includes(f.root), false);
  assert.equal(result.content.includes('\n'), false);
  assert.equal(f.calls.filter(([kind]) => kind === 'restore').length, 1);
});

test('edit reads a session-bound reference before GPU handoff and publishes a new image with source provenance', async (t) => {
  const fx = fixture(t, { readReference: async (options) => {
    assert.equal(options.sessionId, 'session-1'); assert.equal(options.artifactId, 'original-image');
    return { artifactId: options.artifactId, width: 1024, height: 1024, buffer: png(), region: null };
  } });
  fx.paths.vision_projector = path.join(fx.root, 'vision.gguf');
  fx.dependencies.loadFamilies = () => ({ families: { test_family: { ...FAMILY, vision_flag: '--llm_vision' } } });
  const result = await createImageGenerateTool(fx.dependencies).execute({ ...fx.input, source_artifact_id: 'original-image' }, fx.context);
  assert.equal(result.isError, false);
  assert.equal(result.metadata.provenance.source_artifact_id, 'original-image');
  const run = fx.calls.find(([name]) => name === 'run')[1];
  assert.equal(run.argv[run.argv.indexOf('--llm_vision') + 1], fx.paths.vision_projector);
  assert.equal(run.argv.includes('-r'), true);
  assert.equal(fs.existsSync(run.argv[run.argv.indexOf('-r') + 1]), false, 'temporary reference removed after settlement');
});

test('editing without a projector fails before GPU handoff', async (t) => {
  const fx = fixture(t);
  const result = await fx.tool.execute({ ...fx.input, source_artifact_id: 'original-image' }, fx.context);
  failed(result, 'image_edit_unavailable');
  assert.equal(fx.calls.some(([name]) => name === 'suspend'), false);
});

test('model title becomes searchable artifact metadata and a safe, unique filename', async (t) => {
  const fx = fixture(t);
  const result = await fx.tool.execute({ ...fx.input, title: 'Green apple on a blue plate' }, fx.context);
  assert.equal(result.isError, false);
  const input = fx.calls.find(([name]) => name === 'artifact')[2];
  assert.equal(input.title, 'Green apple on a blue plate');
  assert.equal(input.fileName, 'Green apple on a blue plate.png');
  const bad = await fx.tool.execute({ ...fx.input, title: 'x'.repeat(101) }, fx.context);
  assert.equal(bad.isError, true);
});


test('invalid edit references fail before suspending chat or starting the engine', async (t) => {
  const fx = fixture(t, { readReference: async () => { throw new Error('wrong session or corrupt image'); } });
  fx.paths.vision_projector = path.join(fx.root, 'vision.gguf');
  fx.dependencies.loadFamilies = () => ({ families: { test_family: { ...FAMILY, vision_flag: '--llm_vision' } } });
  const result = await createImageGenerateTool(fx.dependencies).execute({ ...fx.input, source_artifact_id: 'original' }, fx.context);
  failed(result, 'image_edit_source_invalid');
  assert.equal(fx.calls.some(([name]) => name === 'suspend' || name === 'run'), false);
});

test('edit staging refuses a linked scratch directory without writing a source copy', async (t) => {
  const fx = fixture(t, { readReference: async () => ({ artifactId: 'original', width: 1024, height: 1024, buffer: png(), region: null }) });
  fx.paths.vision_projector = path.join(fx.root, 'vision.gguf');
  fx.dependencies.loadFamilies = () => ({ families: { test_family: { ...FAMILY, vision_flag: '--llm_vision' } } });
  const outside = path.join(fx.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(fx.root, 'image-engine-scratch'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await createImageGenerateTool(fx.dependencies).execute({ ...fx.input, source_artifact_id: 'original' }, fx.context);
  assert.equal(result.isError, true);
  assert.equal(fx.calls.some(([name]) => name === 'run'), false);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fx.calls.filter(([name]) => name === 'restore').length, 1);
});


test('null input and invalid edit geometry return actionable errors before GPU work', async(t)=>{
  const fx=fixture(t,{readReference:async()=>{throw new Error('image_edit_invalid_region');}});
  assert.equal((await fx.tool.execute(null,fx.context)).metadata.failure_class,'bad_arguments');
  fx.paths.vision_projector=path.join(fx.root,'vision.gguf');fx.dependencies.loadFamilies=()=>({families:{test_family:{...FAMILY,vision_flag:'--llm_vision'}}});
  const result=await createImageGenerateTool(fx.dependencies).execute({...fx.input,source_artifact_id:'original'},fx.context);
  assert.match(result.content,/region/);assert.match(result.metadata.remediation,/region/);
  assert.equal(fx.calls.some(([name])=>name==='suspend'),false);
});

test('edits retain source dimensions and reject unsupported source sizes before GPU work', async(t)=>{
  for(const [width,height,overrides] of [[800,600,{}],[1024,1024,{width:1472,height:1120}]]){
    const fx=fixture(t,{readReference:async()=>({artifactId:'original',width,height,buffer:png(width,height)})});
    fx.paths.vision_projector=path.join(fx.root,'vision.gguf');fx.dependencies.loadFamilies=()=>({families:{test_family:{...FAMILY,vision_flag:'--llm_vision'}}});
    const result=await createImageGenerateTool(fx.dependencies).execute({...fx.input,source_artifact_id:'original',...overrides},fx.context);
    assert.equal(result.metadata.reason,'image_edit_size_unsupported');assert.doesNotMatch(result.metadata.remediation,/omit both/);
    assert.equal(fx.calls.some(([name])=>name==='suspend'),false);
  }
});

test('fallback title preserves Unicode scalars and the real artifact service persists safe unique names', async(t)=>{
  const {ArtifactWorkspaceService}=require('../../services/artifact-workspace-service');
  const fx=fixture(t);const service=new ArtifactWorkspaceService({configService:{getState:()=>({toolsWorkspaceRoot:fx.root})},sessionMessageReader:()=>[]});
  fx.context.artifactService=service;
  const result=await fx.tool.execute({...fx.input,prompt:'a'.repeat(99)+'🌱 garden'},fx.context);
  assert.equal(result.isError,false);const artifact=result.metadata.generatedArtifacts[0];
  assert.equal(artifact.title,'a'.repeat(99)+'🌱');assert.equal(artifact.title.isWellFormed(),true);
  assert.ok(fs.existsSync(path.join(fx.root,artifact.display_path)));
  assert.match(artifact.file_name,/^[a-z0-9-]+\.png$/);
});


test('generated schema stays in parity and freehand has at least three points',()=>{
  const manifest=require('../../services/tools/tool-manifest.json');
  const {updateImageToolSchema}=require('../../scripts/generate-image-tool-schema');
  assert.deepEqual(updateImageToolSchema(structuredClone(manifest),require('../../config/sdcpp-families.json').families),manifest);
  const validate=new (require('ajv'))({strict:false}).compile(manifest.tools.find(x=>x.name==='image_generate').parameters);
  assert.equal(validate({prompt:'edit',region:{kind:'freehand',points:[[1,1],[10,10]]}}),false);
  assert.equal(validate({prompt:'edit',region:{kind:'freehand',points:[[1,1],[10,10],[20,1]]}}),true);
});

test('a cancel that lands after the render but before publication publishes nothing and removes scratch', async (t) => {
  const controller = new AbortController();
  const f = fixture(t);
  const restore = f.handoff.restoreAndRelease;
  // The owning turn is lost while the chat engine is being restored.
  f.handoff.restoreAndRelease = async (options) => { controller.abort(); return restore(options); };
  f.context.abortSignal = controller.signal;
  failed(await f.tool.execute(f.input, f.context), 'image_cancelled', 'ok');
  assert.equal(f.calls.some(([kind]) => kind === 'artifact'), false, 'no unreferenced artifact is published');
  const output = f.calls.find(([kind]) => kind === 'run')[1].outputPath;
  assert.equal(fs.existsSync(output), false, 'the rendered scratch PNG is removed');
});

test('a throwing chat restore still removes the call signal listener', async (t) => {
  const f = fixture(t);
  const added = [];
  const removed = [];
  f.context.abortSignal = {
    aborted: false,
    addEventListener: (type, listener) => added.push([type, listener]),
    removeEventListener: (type, listener) => removed.push([type, listener]),
  };
  f.handoff.restoreAndRelease = async () => { throw new Error('restore failed'); };
  await assert.rejects(f.tool.execute(f.input, f.context), /restore failed/);
  assert.equal(added.length, 1);
  assert.deepEqual(removed, added);
});
