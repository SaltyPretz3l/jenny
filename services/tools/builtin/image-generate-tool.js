'use strict';

const path = require('node:path');
const { readEditReference, MAX_BYTES: MAX_PNG_BYTES } = require('../../image-edit-reference');
const crypto = require('node:crypto');
const defaultFs = require('node:fs');
const modelSets = require('../../image-model-sets');
const { ChatGpuHandoffError } = require('../../backend/chat-gpu-handoff');
const { readPngStructure } = require('../../backend/png-validator');
const { PROGRESS_PHASES } = require('../../backend/chat-stream-tool-progress');
const { encodePreviewImage } = require('../../preview-vision-image');
const renderPreview = require('../../image-render-preview');
const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { t } = require('../../i18n-main');
const { manifestSchema } = require('./tool-result');

const IMAGE_GENERATE_BUDGET_MS = 900_000;
// Restore = kill proof (up to ~30 s) + relaunch readiness (90 s) + margin.
const RESTORE_RESERVE_MS = 200_000;
const VALIDATION_MARGIN_MS = 10_000;
const MIN_RENDER_DEADLINE_MS = 60_000;
// The chat model's copy of the picture: about four vision tiles at most.
const MODEL_IMAGE_MAX_EDGE = 1024;
const MODEL_SET_ID = /^[a-f0-9]{12}$/;
// A prompt that is itself an output flag must not reach the argv.
const OUTPUT_FLAG_PROMPT = /^(-o|--output)(=|\s|$)/;

function failure(reason, content, extra = {}) {
  return {
    content,
    summary: t('tool.imageGen.failedSummary', 'Image generation failed'),
    isError: true,
    errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
    metadata: { result_kind: 'image_generate', status: 'failed', reason, ...extra },
  };
}

function cleanText(value) {
  // Preserve newlines, tabs and shell punctuation as argument data.
  return Array.from(value).filter((char) => {
    const code = char.codePointAt(0);
    return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159) && !(code >= 0xD800 && code <= 0xDFFF));
  }).join('').trim();
}

function invalidParameter(parameter) {
  return failure('image_invalid_params', t('error.imageGen.invalidParameter',
    'Invalid {parameter} for image generation.', { parameter }), {
    failure_class: 'bad_arguments', effects: 'none',
    remediation: t('error.imageGen.parameterRemediation',
      'Correct {parameter} using the image_generate parameter schema before retrying.', { parameter }),
  });
}

function validateParameters(input, family, randomUUID) {
  if (typeof input.prompt !== 'string') return { error: invalidParameter('prompt') };
  const prompt = cleanText(input.prompt);
  if (!prompt || prompt.length > 2000 || OUTPUT_FLAG_PROMPT.test(prompt)) return { error: invalidParameter('prompt') };
  if (input.negative_prompt !== undefined && typeof input.negative_prompt !== 'string') {
    return { error: invalidParameter('negative_prompt') };
  }
  if (input.title !== undefined && (typeof input.title !== 'string' || !cleanText(input.title) || Array.from(cleanText(input.title)).length > 100)) return { error: invalidParameter('title') };
  const title = Array.from(cleanText(input.title || prompt).replace(/\s+/g, ' ')).slice(0, 100).join('');
  const negative = cleanText(input.negative_prompt || '');
  if (negative.length > 2000 || OUTPUT_FLAG_PROMPT.test(negative)) return { error: invalidParameter('negative_prompt') };
  const width = input.width === undefined ? 1024 : input.width;
  const height = input.height === undefined ? 1024 : input.height;
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || !family.resolutions.includes(`${width}x${height}`)) {
    return { error: failure('image_invalid_params', t('error.imageGen.invalidResolution',
      'Invalid width/height. Supported sizes: {sizes}.', { sizes: family.resolutions.join(', ') }), {
      failure_class: 'bad_arguments', effects: 'none',
      remediation: t('error.imageGen.resolutionRemediation',
        'Retry image_generate with a matching width/height pair from {sizes}, or omit both dimensions for the 1024x1024 default.',
        { sizes: family.resolutions.join(', ') }),
    }) };
  }
  const steps = input.steps === undefined ? family.defaults.steps : input.steps;
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) return { error: invalidParameter('steps') };
  const seed = input.seed === undefined
    ? Number.parseInt(randomUUID().replace(/-/g, '').slice(0, 8), 16) : input.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) return { error: invalidParameter('seed') };
  const cfgScale = input.cfg_scale === undefined ? family.defaults.cfg_scale : input.cfg_scale;
  if (!Number.isFinite(cfgScale) || cfgScale < 1 || cfgScale > 20) return { error: invalidParameter('cfg_scale') };
  return { prompt, title, negative, width, height, steps, seed, cfgScale };
}

function renderArguments(family, paths, params, outputPath, previewPattern = '') {
  const { prompt, negative, width, height, steps, cfgScale, seed } = params;
  return [family.diffusion_flag, paths.diffusion, family.encoder_flag, paths.text_encoder,
    family.vae_flag, paths.vae, ...(params.referencePath ? [family.vision_flag, paths.vision_projector, '-r', params.referencePath] : []),
    '-p', params.reference?.region ? 'Edit only the region outlined in magenta in the reference. Remove the magenta guide. Preserve the rest of the image. ' + prompt : prompt, ...(negative ? ['-n', negative] : []),
    '-W', String(width), '-H', String(height), '--steps', String(steps), '--cfg-scale', String(cfgScale),
    '--sampling-method', family.defaults.sampler, '--flow-shift', String(family.defaults.flow_shift),
    '-s', String(seed), ...family.extra_args,
    ...(previewPattern ? ['--preview', family.preview, '--preview-interval', String(renderPreview.previewInterval(steps)),
      '--preview-path', previewPattern] : []),
    '-o', outputPath];
}

// Best effort: without Electron's nativeImage the model simply gets no copy.
function modelImage(content, { width, height }, createNativeImage) {
  try {
    const image = createNativeImage(content);
    if (Math.max(width, height) <= MODEL_IMAGE_MAX_EDGE) return encodePreviewImage(image, content);
    return encodePreviewImage(image.resize(width >= height
      ? { width: MODEL_IMAGE_MAX_EDGE } : { height: MODEL_IMAGE_MAX_EDGE }));
  } catch (_error) { return null; }
}

function sanitizedStderr(lines, sensitiveValues) {
  const last = Array.isArray(lines) ? lines.at(-1) : '';
  // Strip terminal escapes before controls, then redact service-owned paths.
  // eslint-disable-next-line no-control-regex -- ANSI CSI sequences in native stderr.
  let text = String(last || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const value of sensitiveValues.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(value).join('[redacted]');
  }
  return cleanText(text).replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

function renderFailure(result, extra, sensitiveValues) {
  switch (result.status) {
    case 'cancelled':
      return failure('image_cancelled', t('error.imageGen.cancelled', 'Image generation was cancelled.'), extra);
    case 'timeout':
      return failure('image_timeout', t('error.imageGen.timeout', 'Image generation timed out.'), extra);
    case 'unconfirmed':
      return failure('image_engine_cleanup_pending', t('error.imageGen.cleanupPending',
        'The image engine did not shut down cleanly. Use Clean up now in Settings > Models > Image engine before the next image.'), extra);
    case 'launch_unrecorded':
      return failure('image_engine_launch_unrecorded', t('error.imageGen.launchUnrecorded',
        'The image engine launch could not be recorded.'), extra);
    case 'stale':
      return failure('image_model_set_stale', t('error.imageGen.modelSetStale',
        'The saved image model set has changed. Add your model files again in Settings > Models > Image engine.'), extra);
    case 'budget':
      return failure('image_invalid_params', t('error.imageGen.budgetTooSmall',
        'Not enough time budget is left for an image in this turn.'), extra);
    default:
      return failure('image_engine_failed', t('error.imageGen.engineFailed',
        'The image engine failed (exit {exitCode}). {detail}', {
          exitCode: result.exitCode ?? 'unknown', detail: sanitizedStderr(result.stderrTail, sensitiveValues),
        }).trim(), extra);
  }
}

function createImageGenerateTool({
  // Resolve only on execution: registry loading does not depend on the runner slice.
  runImageGeneration = (options) => require('../../image-engine-runner').runImageGeneration(options),
  resolveModelSet = modelSets.resolveModelSet,
  listModelSets = modelSets.listModelSets,
  loadFamilies = modelSets.loadFamilies,
  fs = defaultFs,
  randomUUID = crypto.randomUUID,
  now = Date.now,
  readReference = (options) => readEditReference({ ...options, nativeImage: require('electron').nativeImage }),
  createNativeImage = (buffer) => require('electron').nativeImage.createFromBuffer(buffer),
} = {}) {
  async function publishImage(outputPath, opId, context, params, set, family, engine, result, settled, startedAt) {
    const extra = { chat_restore: settled.restored ? 'ok' : 'failed' };
    if (settled.restored === false) extra.reason = 'image_chat_restore_failed';
    let content;
    try {
      // The runner validated these bytes before the kill proof and the chat
      // restore; re-reading the scratch file after that window is not it.
      content = result.png?.buffer;
      if (!Buffer.isBuffer(content)) throw new Error('image_output_missing');
      if (content.length > MAX_PNG_BYTES) throw new Error('image_output_oversized');
      const structure = readPngStructure(content);
      if (!structure.ok || structure.width !== params.width || structure.height !== params.height) {
        throw new Error('image_output_invalid');
      }
    } catch (_error) {
      return failure('image_output_invalid', t('error.imageGen.outputInvalid',
        'The image engine did not produce a valid PNG image.'), extra);
    }
    let artifact;
    try {
      const created = await context.artifactService.createBinaryArtifact(context.sessionId, {
        content, artifactKind: 'image', mimeType: 'image/png',
        title: params.title, fileName: `${params.title}.png`,
        width: params.width, height: params.height, pngValidated: true,
      });
      artifact = created?.metadata;
      if (!artifact?.artifact_id) throw new Error('image_artifact_missing');
    } catch (_error) {
      return failure('image_artifact_failed', t('error.imageGen.artifactFailed',
        'The generated image could not be saved as an artifact.'), extra);
    }
    const total = result.seconds?.total ?? Math.max(0, (now() - startedAt) / 1000);
    const lines = [t('imageEdit.named', 'Image: {title}.', { title: params.title }), t('tool.imageGen.generated',
      'Generated a {width}x{height} image (seed {seed}, {steps} steps, {total}s).', { ...params, total })];
    if (typeof artifact.display_path === 'string' && artifact.display_path.length > 0) {
      lines.push(t('tool.imageGen.savedAs',
        'Saved as {path}. The image is already shown to the user in the chat.', { path: artifact.display_path }));
    }
    lines.push(t('tool.imageGen.completionGuidance',
      'The primary image is already shown in chat. Briefly acknowledge completion; do not add another Markdown image or invent an image URL.'));
    lines.push(JSON.stringify({ image_title: params.title, source_artifact_id: artifact.artifact_id }));
    const previewImage = modelImage(content, params, createNativeImage);
    const quant = set.files.diffusion.name.match(/Q\d[_A-Z0-9]*|BF16|F16|F32/i)?.[0] || '';
    if (settled.restored === false) {
      lines.push(t('error.imageGen.restoreFailed',
        'The chat engine did not come back; send your next message to restart it.'));
    }
    return {
      content: lines.join('\n'),
      summary: t('tool.imageGen.generatedSummary', 'Generated image'),
      isError: false,
      metadata: {
        result_kind: 'image_generated', ...extra, generatedArtifacts: [artifact],
        provenance: {
          backend: 'sdcpp', family: set.family, engine_tag: engine.source === 'custom' ? 'custom' : engine.tag, model_set_id: set.id,
          quant, model_label: (typeof set.label === 'string' && cleanText(set.label)) || [family?.label || set.family, quant].filter(Boolean).join(' · '),
          seed: params.seed, width: params.width, height: params.height, steps: params.steps, cfg_scale: params.cfgScale,
          // F29: not `prompt`; the canonical normalizer redacts engine/system prompt keys by that name.
          ...(params.reference ? { source_artifact_id: params.reference.artifactId, image_edit_region: params.reference.region } : {}),
          image_prompt: params.prompt, ...(params.negative ? { image_negative_prompt: params.negative } : {}),
        },
      },
      // The bridge hands this to a vision chat model as the picture it drew.
      ...(previewImage ? { previewImage } : {}),
    };
  }

  return {
    name: 'image_generate',
    ...manifestSchema('image_generate'),
    // Approval-row and transcript label: the prompt's first words, never a path.
    summarize(input) {
      const prompt = typeof input?.prompt === 'string' ? cleanText(input.prompt).replace(/\s+/g, ' ') : '';
      return `Generate image${prompt ? `: ${prompt.slice(0, 80)}` : ''}`;
    },
    async execute(input = {}, context = {}) {
      input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
      const executeStartedAt = now();
      const backend = context.backendService;
      const handoff = backend?.chatGpuHandoff;
      const imageEngine = backend?.imageEngine;
      const userDataPath = backend?.options?.userDataPath;
      if (!handoff || typeof handoff.suspend !== 'function' || typeof handoff.registerRender !== 'function'
        || typeof handoff.restoreAndRelease !== 'function' || typeof imageEngine?.resolveExecutable !== 'function'
        || typeof context.artifactService?.createBinaryArtifact !== 'function' || !context.sessionId
        || !context.streamId || !context.callId || !context.workingDirectory || !userDataPath) {
        return failure('image_tool_unavailable', t('error.imageGen.unavailable',
          'Image generation is not available in this session.'));
      }
      let engine;
      try { engine = await imageEngine.resolveExecutable(); } catch (_error) { /* report engine missing */ }
      if (!engine?.ok) {
        return failure('image_engine_missing', t('error.imageGen.engineMissing',
          'No image engine is installed. Install it in Settings > Models > Image engine.'));
      }
      if (input?.model_set_id !== undefined
        && (typeof input.model_set_id !== 'string' || !MODEL_SET_ID.test(input.model_set_id))) {
        return invalidParameter('model_set_id');
      }
      let resolved;
      let family;
      try {
        const storePath = path.join(userDataPath, 'image-models.json');
        const id = input?.model_set_id ?? (await listModelSets({ storePath })).default_id;
        if (id) resolved = await resolveModelSet(id, { storePath });
        if (resolved?.ok) family = (await loadFamilies()).families[resolved.set.family];
      } catch (_error) { /* unreadable stores or presets are unavailable */ }
      if (!resolved?.ok || !family) {
        if (resolved?.reason === 'image_model_set_stale') {
          return failure('image_model_set_stale', t('error.imageGen.modelSetStale',
            'The saved image model set has changed. Add your model files again in Settings > Models > Image engine.'));
        }
        if (resolved?.reason === 'model_set_not_found') {
          return failure('image_model_set_missing', t('error.imageGen.modelSetNotFound',
            'No saved image model set has that id. Use a set listed in Settings > Models > Image engine, or omit model_set_id for the default.'));
        }
        return failure('image_model_set_missing', t('error.imageGen.modelSetMissing',
          'No image model set is saved. Add your model files in Settings > Models > Image engine.'));
      }
      const { set, paths } = resolved;
      let reference;
      if (input.source_artifact_id !== undefined || input.region !== undefined) {
        if (!family.vision_flag || !paths.vision_projector) return failure('image_edit_unavailable',
          t('imageEdit.unavailable', 'Image editing needs a saved model set with a matching vision projector.'),
          { failure_class: 'bad_arguments', effects: 'none', remediation: t('imageEdit.configureProjector', 'Choose a compatible projector in Settings > Models > Image engine, then retry the edit.') });
        try {
          reference = await readReference({ artifactService: context.artifactService, sessionId: context.sessionId,
            artifactId: input.source_artifact_id, region: input.region });
        } catch (error) {
          if (error.message === 'image_edit_invalid_region') return invalidParameter('region');
          return failure('image_edit_source_invalid',
          t('imageEdit.invalidSource', 'The image or selection is unavailable. Open the original image and select it again.'),
          { failure_class: 'bad_arguments', effects: 'none', remediation: t('imageEdit.selectAgain', 'Select an available PNG and a valid region in this chat, then retry.') }); }
      }
      if (reference && (!family.resolutions.includes(`${reference.width}x${reference.height}`)
        || (input.width !== undefined && input.width !== reference.width) || (input.height !== undefined && input.height !== reference.height))) {
        return failure('image_edit_size_unsupported', t('imageEdit.unsupportedSize', 'Edits require a supported source size and matching output dimensions.'),
          { failure_class: 'bad_arguments', effects: 'none', remediation: t('imageEdit.sizeRemediation', 'Use a source with one of these sizes: {sizes}. Keep its dimensions.', { sizes: family.resolutions.join(', ') }) });
      }
      const params = validateParameters(reference ? { width: reference.width, height: reference.height, ...input } : input || {}, family, randomUUID);
      if (params.error) return params.error;
      if (reference) params.reference = reference;
      // The render must finish inside the sidecar's wait with the restore
      // reserve intact, counted from when this call actually began.
      const budgetMs = Number.isFinite(context.timeoutMs) && context.timeoutMs > 0
        ? Math.min(context.timeoutMs, IMAGE_GENERATE_BUDGET_MS) : IMAGE_GENERATE_BUDGET_MS;
      const renderDeadline = () => budgetMs - RESTORE_RESERVE_MS - VALIDATION_MARGIN_MS - (now() - executeStartedAt);
      if (renderDeadline() < MIN_RENDER_DEADLINE_MS) {
        return failure('image_invalid_params', t('error.imageGen.budgetTooSmall',
          'Not enough time budget is left for an image in this turn.'));
      }
      // The chat row shows the render's phase, step and newest preview frame. A
      // report never steps back, and only sampling repeats its phase.
      let reachedPhase = -1;
      const report = (event) => {
        const rank = PROGRESS_PHASES.indexOf(event?.phase);
        if (typeof context.onProgress !== 'function' || rank < reachedPhase
          || (rank === reachedPhase && event.phase !== 'sample')) return;
        reachedPhase = rank;
        try { context.onProgress(event); } catch (_error) { /* Progress display never interrupts a render. */ }
      };
      report({ phase: 'gpu' });
      try {
        await handoff.suspend({ kind: 'builtin', tool_name: 'image_generate', call_id: context.callId, stream_id: context.streamId }, {
          minTotalVramMb: family.min_total_vram_mb,
          requiredFreeMb: Math.ceil(set.files.diffusion.size_bytes / 1048576) + family.free_vram_headroom_mb,
        });
      } catch (error) {
        if (error instanceof ChatGpuHandoffError) return failure(error.code, error.message, { detail: error.reason });
        return failure('image_gpu_eviction_unverified', t('error.imageGen.evictionUnverified',
          'Jenny could not confirm the chat engine released the GPU, so the image was not started.'));
      }

      let outputPath;
      let referencePath;
      let opId;
      let startedAt;
      let result;
      let settled;
      let controller;
      let running = null;
      let previews = null;
      const abort = () => controller.abort();
      // close() needs the runner's own settlement: an abort is a request, the
      // tree-death proof is the answer.
      const cancel = async () => {
        controller.abort();
        if (!running) return { confirmed: true };
        try { return { confirmed: (await running).status !== 'unconfirmed' }; }
        catch (_error) { return { confirmed: false }; }
      };
      try {
        // Everything after acquiring the GPU, including setup throws, settles once.
        try {
          startedAt = now();
          controller = new AbortController();
          context.abortSignal?.addEventListener('abort', abort, { once: true });
          if (context.abortSignal?.aborted) controller.abort();
          opId = `img_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
          let scratchDir = path.join(userDataPath, 'image-engine-scratch');
          outputPath = path.join(scratchDir, `${opId}.png`);
          await fs.promises.mkdir(scratchDir, { recursive: true });
          if (reference) {
            const profileRoot = await fs.promises.realpath(userDataPath);
            referencePath = path.join(scratchDir, `${opId}-reference.png`);
            require('../../image-engine-runner').assertOutputParent(profileRoot, referencePath, fs);
            await fs.promises.writeFile(referencePath, reference.buffer, { flag: 'wx' });
            params.referencePath = referencePath;
          }
          handoff.registerRender({ cancel });
          if (handoff.closing) controller.abort();
          // The eviction took time: the model files are re-resolved under the
          // saved root right before the spawn, and the deadline is what is left.
          const again = await resolveModelSet(set.id, { storePath: path.join(userDataPath, 'image-models.json') });
          if (!again?.ok || Object.keys(paths).some((slot) => again.paths[slot] !== paths[slot])) {
            result = { status: 'stale', exitCode: null, stderrTail: [] };
          } else if (renderDeadline() < MIN_RENDER_DEADLINE_MS) {
            result = { status: 'budget', exitCode: null, stderrTail: [] };
          } else {
            // A custom engine may predate --preview; only the pinned build gets it.
            const previewPattern = family.preview && engine.source === 'managed'
              ? renderPreview.previewPathPattern(scratchDir, opId) : '';
            if (previewPattern) previews = renderPreview.createPreviewReader({ scratchDir, opId, fsImpl: fs });
            report({ phase: 'load' });
            running = Promise.resolve(runImageGeneration({
              exePath: engine.path, argv: renderArguments(family, paths, params, outputPath, previewPattern),
              scratchDir, outputPath, opId, userDataPath, deadlineMs: renderDeadline(),
              abortSignal: controller.signal, expectedWidth: params.width, expectedHeight: params.height, log: context.logger,
              onProgress: (event) => {
                if (event?.phase !== 'sample') return report(event);
                let preview = '';
                try { preview = previews?.next() || ''; } catch (_error) { /* A missing frame is skipped. */ }
                report({ phase: 'sample', step: event.step, steps: event.steps, ...(preview ? { preview } : {}) });
              },
            }));
            result = await running;
          }
        } catch (_error) {
          result = { status: 'failed', exitCode: null, stderrTail: [] };
        } finally {
          try {
            settled = await handoff.restoreAndRelease({
              cleanupConfirmed: result.status !== 'unconfirmed', reason: result.status, recorded: result.recorded !== false,
            });
          } finally {
            // A throwing restore must not leave the call's signal holding this listener.
            context.abortSignal?.removeEventListener('abort', abort);
          }
        }
        // A turn lost during the restore can no longer reference the picture.
        if (result.status === 'ok' && controller?.signal.aborted) result = { ...result, status: 'cancelled', png: null };
        if (result.status !== 'ok') {
          return renderFailure(result, { chat_restore: settled.restored ? 'ok' : 'failed' },
            [userDataPath, context.workingDirectory, engine.path, outputPath, referencePath, ...Object.values(paths)]);
        }
        return await publishImage(outputPath, opId, context, params, set, family, engine, result, settled, startedAt);
      } finally {
        if (referencePath && result.status !== 'unconfirmed') {
          try { await fs.promises.unlink(referencePath); } catch (_error) { /* bounded scratch cleanup */ }
        }
        if (outputPath && result.status !== 'unconfirmed') {
          try { await fs.promises.unlink(outputPath); } catch (_error) { /* scratch cleanup is best effort */ }
        }
        if (previews && result.status !== 'unconfirmed') {
          for (const frame of renderPreview.listPreviewFrames(path.dirname(outputPath), opId, fs)) {
            try { await fs.promises.unlink(frame); } catch (_error) { /* scratch cleanup is best effort */ }
          }
        }
      }
    },
  };
}

module.exports = Object.assign(createImageGenerateTool(), {
  createImageGenerateTool, IMAGE_GENERATE_BUDGET_MS, RESTORE_RESERVE_MS, VALIDATION_MARGIN_MS, MIN_RENDER_DEADLINE_MS,
});
