'use strict';

// Row 127: the ComfyUI side of image_generate. A recipe maps the tool's size
// pairs to its own sizes and locks the settings its model needs; one ComfyUI
// server lives for one image and is proven gone before the chat engine returns.
const { t } = require('../../i18n-main');
const { REQUIRED_SLOTS } = require('../../image-model-sets');
const { ChatGpuHandoffError, CHAT_GPU_HANDOFF_CODES: CODES } = require('../../backend/chat-gpu-handoff');

const LOADER_SLOTS = REQUIRED_SLOTS;

// suspend()'s preamble, run before a ComfyUI start: a retained lease from an
// unproven render is reconciled first; a lease still held refuses the start.
async function leaseRefusal(handoff) {
  if (handoff.getState?.().retained) {
    try { await handoff.reconcile?.(); } catch (_error) { /* the refusal below decides */ }
  }
  const held = typeof handoff.launchRefusal === 'function' ? handoff.launchRefusal() : '';
  if (!held) return null;
  if (held === 'runtime_closing') return new ChatGpuHandoffError(CODES.BUSY, held);
  return handoff.getState?.().retained
    ? new ChatGpuHandoffError(CODES.CLEANUP_PENDING, 'render_cleanup_unconfirmed')
    : new ChatGpuHandoffError(CODES.BUSY, 'handoff_active');
}

// The tool contract as a recipe sees it: the schema's pairs and the locked
// values as defaults, so validation and its messages match the sd.cpp path.
function recipeContract(recipe) {
  return {
    resolutions: Object.keys(recipe.size_map),
    defaults: { steps: recipe.locked.steps, cfg_scale: recipe.locked.cfg_scale },
  };
}

// Validated tool parameters become the recipe's own. A model cannot know which
// backend a set uses, so a value the recipe overrides is noted, never an error.
function applyRecipe(params, input, recipe) {
  const requested = `${params.width}x${params.height}`;
  const [width, height] = recipe.size_map[requested].split('x').map(Number);
  const dropNegative = recipe.locked.negative_prompt === false;
  const locked = [];
  if (input.steps !== undefined && input.steps !== recipe.locked.steps) locked.push('steps');
  if (input.cfg_scale !== undefined && input.cfg_scale !== recipe.locked.cfg_scale) locked.push('cfg_scale');
  if (dropNegative && params.negative) locked.push('negative_prompt');
  return {
    ...params, width, height, requested, locked,
    steps: recipe.locked.steps, cfgScale: recipe.locked.cfg_scale, negative: dropNegative ? '' : params.negative,
  };
}

function adjustmentLines(params, label) {
  const lines = [];
  const size = `${params.width}x${params.height}`;
  if (size !== params.requested) {
    lines.push(t('tool.imageGen.recipeSize', 'Made {size} instead of {requested}: {model} works at this size for that shape.',
      { size, requested: params.requested, model: label }));
  }
  if (params.locked.length) {
    lines.push(t('tool.imageGen.recipeLocked', '{model} uses fixed settings, so these were not used: {settings}.',
      { model: label, settings: params.locked.join(', ') }));
  }
  return lines;
}

function failureFor(reason, detail = '') {
  const messages = {
    image_comfyui_disabled: () => t('error.imageGen.comfyuiDisabled', 'ComfyUI image generation is turned off in this build.'),
    image_comfyui_missing: () => t('error.imageGen.comfyuiMissing',
      'The ComfyUI folder for this image model set is missing or no longer valid. Choose it again in Settings > Models > Image engine.'),
    image_comfyui_start_failed: () => t('error.imageGen.comfyuiStartFailed', 'ComfyUI did not start. {detail}', { detail }).trim(),
    image_comfyui_not_ours: () => t('error.imageGen.comfyuiNotOurs',
      'Jenny could not confirm that the ComfyUI server it reached is the one it started, so the image was not made.'),
    image_engine_launch_unrecorded: () => t('error.imageGen.launchUnrecorded', 'The image engine launch could not be recorded.'),
    image_engine_cleanup_pending: () => t('error.imageGen.cleanupPending',
      'The image engine did not shut down cleanly. Use Clean up now in Settings > Models > Image engine before the next image.'),
    image_cancelled: () => t('error.imageGen.cancelled', 'Image generation was cancelled.'),
  };
  return { reason: Object.hasOwn(messages, reason) ? reason : 'image_comfyui_start_failed',
    content: (messages[reason] || messages.image_comfyui_start_failed)() };
}

function nodeMissing(nodes, recipe) {
  return { reason: 'image_comfyui_node_missing', content: t('error.imageGen.comfyuiNodeMissing',
    'This ComfyUI is missing {nodes}. Update ComfyUI to version {version} or newer.',
    { nodes: nodes.join(', '), version: recipe.min_comfyui_version || '' }) };
}

function modelMissing(name) {
  return { reason: 'image_comfyui_model_missing', content: t('error.imageGen.comfyuiModelMissing',
    'ComfyUI does not list the model file {name}. Check the model set in Settings > Models > Image engine.', { name }) };
}

function stopFailure(stopped, fallback) {
  return stopped?.confirmed === true ? fallback : failureFor('image_engine_cleanup_pending');
}

// Before the chat engine is evicted: the server starts, is ours, has every
// recipe node and lists the set's files. Any refusal stops the server first.
async function preflight({ owner, comfy, recipe, nodeTypes, opId, abortSignal, set }) {
  let started;
  try { started = await owner.start({ comfy, opId, abortSignal }); }
  catch (_error) { started = { ok: false, reason: 'image_comfyui_start_failed' }; }
  if (!started?.ok) {
    const detail = Array.isArray(started?.stderrTail) ? String(started.stderrTail.at(-1) || '') : '';
    return { ok: false, failure: failureFor(started?.reason, detail.slice(0, 300)) };
  }
  const { server } = started;
  const refuse = async (failure) => ({ ok: false, failure: stopFailure(await owner.stop(server), failure) });
  try {
    const missing = await owner.missingNodes(server, nodeTypes);
    if (missing === null) return await refuse(failureFor('image_comfyui_start_failed'));
    if (missing.length) return await refuse(nodeMissing(missing, recipe));
    for (const slot of LOADER_SLOTS) {
      const [node, input] = recipe.slots[slot];
      const values = await owner.loaderValues(server, recipe.graph[node].class_type, input);
      if (!Array.isArray(values) || !values.includes(comfy.loaderNames[slot])) {
        return await refuse(modelMissing(set.files[slot].name));
      }
    }
  } catch (_error) {
    return refuse(failureFor('image_comfyui_start_failed'));
  }
  return { ok: true, server };
}

// The render's settlement includes the kill proof: an unproven stop is the
// same `unconfirmed` the sd.cpp runner reports, so the handoff keeps its lease.
async function renderAndStop({ owner, server, runComfyGeneration, options }) {
  let result;
  try { result = await runComfyGeneration({ ...options, server }); }
  catch (_error) { result = { status: 'failed', reason: 'image_comfyui_failed', stderrTail: [] }; }
  let stopped;
  try { stopped = await owner.stop(server); } catch (_error) { stopped = { confirmed: false }; }
  return stopped?.confirmed === true ? result : { ...result, status: 'unconfirmed', png: null, recorded: true };
}

function quantOf(name) {
  return String(name || '').match(/nvfp4|w4a8|int8|fp8|bf16|fp16|fp32/i)?.[0] || '';
}

module.exports = {
  LOADER_SLOTS, leaseRefusal, recipeContract, applyRecipe, adjustmentLines, failureFor, preflight, renderAndStop, quantOf,
};
