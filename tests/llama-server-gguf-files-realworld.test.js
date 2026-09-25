'use strict';

// Real Hugging Face GGUF repo folders as published (file names verbatim,
// listed 2026-09-18 for the W2 review) and the projector each quant in them
// pairs with (services/llama-server-gguf-files.js). Each case launched
// text-only before W2 round 5:
// - [R3-1] an MXFP4 / MXFP4_MOE quant or an imatrix data file does not split
//   a one-model snapshot (noctrex, unsloth);
// - [R3-2] bartowski's and lmstudio-community's "mmproj-<model>-<precision>"
//   names its model: every quant pairs it, and no other model does;
// - [R3-3] Google's QAT naming and Unsloth save_pretrained_gguf exports pair.
// Round 6 adds: two repos in one folder pair each model's own projector
// [R5-1], an imatrix-built model is a model [R5-2], and a precision-less
// "mmproj-<model>" pairs its model [R5-3].
// The synthetic pairing rules are pinned in tests/llama-server-gguf-files.test.js.

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveGgufPath, resolveProjectorPath, splitGgufFiles } = require('../services/llama-server-gguf-files');

// huggingface.co/noctrex/Huihui-Qwen3-VL-4B-Instruct-abliterated-GGUF
const NOCTREX_QWEN3_VL_4B = [
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-BF16.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-F16.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-IQ3_M.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-IQ3_S.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-IQ3_XS.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-IQ3_XXS.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-IQ4_NL.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-IQ4_XS.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-MXFP4.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-Q4_K_M.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-Q4_K_S.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-Q5_K_M.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-Q5_K_S.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-Q6_K.gguf',
  'Huihui-Qwen3-VL-4B-Instruct-abliterated-Q8_0.gguf',
  'mmproj-BF16.gguf',
  'mmproj-F16.gguf',
  'mmproj-F32.gguf',
];
// huggingface.co/noctrex/Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-GGUF
const NOCTREX_QWEN3_VL_30B = [
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-IQ2_M.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-IQ2_S.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-IQ2_XS.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-IQ3_M.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-IQ3_S.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-IQ3_XS.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-IQ3_XXS.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-IQ4_NL.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-IQ4_XS.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-MXFP4_MOE.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-Q2_K.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-Q2_K_S.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-Q3_K_L.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-Q3_K_M.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-Q3_K_S.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-Q4_K_M.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-Q4_K_S.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-Q5_K_M.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-Q5_K_S.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-Q6_K.gguf',
  'Huihui-Qwen3-VL-30B-A3B-Instruct-abliterated-Q8_0.gguf',
  'mmproj-BF16.gguf',
  'mmproj-F16.gguf',
  'mmproj-F32.gguf',
  'mmproj-Q8_0.gguf',
];
// huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF
const UNSLOTH_QWEN36_35B = [
  'Qwen3.6-35B-A3B-MXFP4_MOE.gguf',
  'Qwen3.6-35B-A3B-Q8_0.gguf',
  'Qwen3.6-35B-A3B-UD-IQ1_M.gguf',
  'Qwen3.6-35B-A3B-UD-IQ2_M.gguf',
  'Qwen3.6-35B-A3B-UD-IQ2_XXS.gguf',
  'Qwen3.6-35B-A3B-UD-IQ3_S.gguf',
  'Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
  'Qwen3.6-35B-A3B-UD-IQ4_NL.gguf',
  'Qwen3.6-35B-A3B-UD-IQ4_NL_XL.gguf',
  'Qwen3.6-35B-A3B-UD-IQ4_XS.gguf',
  'Qwen3.6-35B-A3B-UD-Q2_K_XL.gguf',
  'Qwen3.6-35B-A3B-UD-Q3_K_M.gguf',
  'Qwen3.6-35B-A3B-UD-Q3_K_S.gguf',
  'Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf',
  'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf',
  'Qwen3.6-35B-A3B-UD-Q4_K_S.gguf',
  'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
  'Qwen3.6-35B-A3B-UD-Q5_K_M.gguf',
  'Qwen3.6-35B-A3B-UD-Q5_K_S.gguf',
  'Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf',
  'Qwen3.6-35B-A3B-UD-Q6_K.gguf',
  'Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf',
  'Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf',
  'mmproj-BF16.gguf',
  'mmproj-F16.gguf',
  'mmproj-F32.gguf',
];
// huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF
const UNSLOTH_GEMMA4_26B = [
  'gemma-4-26B-A4B-it-MXFP4_MOE.gguf',
  'gemma-4-26B-A4B-it-Q8_0.gguf',
  'gemma-4-26B-A4B-it-UD-IQ2_M.gguf',
  'gemma-4-26B-A4B-it-UD-IQ2_XXS.gguf',
  'gemma-4-26B-A4B-it-UD-IQ3_S.gguf',
  'gemma-4-26B-A4B-it-UD-IQ3_XXS.gguf',
  'gemma-4-26B-A4B-it-UD-IQ4_NL.gguf',
  'gemma-4-26B-A4B-it-UD-IQ4_XS.gguf',
  'gemma-4-26B-A4B-it-UD-Q2_K_XL.gguf',
  'gemma-4-26B-A4B-it-UD-Q3_K_M.gguf',
  'gemma-4-26B-A4B-it-UD-Q3_K_XL.gguf',
  'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf',
  'gemma-4-26B-A4B-it-UD-Q4_K_S.gguf',
  'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
  'gemma-4-26B-A4B-it-UD-Q5_K_M.gguf',
  'gemma-4-26B-A4B-it-UD-Q5_K_S.gguf',
  'gemma-4-26B-A4B-it-UD-Q5_K_XL.gguf',
  'gemma-4-26B-A4B-it-UD-Q6_K.gguf',
  'gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf',
  'gemma-4-26B-A4B-it-UD-Q8_K_XL.gguf',
  'mmproj-BF16.gguf',
  'mmproj-F16.gguf',
  'mmproj-F32.gguf',
  'mtp-gemma-4-26B-A4B-it.gguf',
];
// huggingface.co/unsloth/Qwen3.5-122B-A10B-GGUF
const UNSLOTH_QWEN35_122B = [
  'Qwen3.5-122B-A10B-UD-IQ1_M.gguf',
  'Qwen3.5-122B-A10B-UD-IQ2_M.gguf',
  'Qwen3.5-122B-A10B-UD-IQ2_XXS.gguf',
  'Qwen3.5-122B-A10B-UD-IQ3_S.gguf',
  'Qwen3.5-122B-A10B-UD-IQ3_XXS.gguf',
  'Qwen3.5-122B-A10B-UD-Q2_K_XL.gguf',
  'imatrix_unsloth.gguf',
  'mmproj-BF16.gguf',
  'mmproj-F16.gguf',
  'mmproj-F32.gguf',
];
// huggingface.co/lmstudio-community/Qwen3-VL-8B-Instruct-GGUF
const LMSTUDIO_QWEN3_VL_8B = [
  'Qwen3-VL-8B-Instruct-Q4_K_M.gguf',
  'Qwen3-VL-8B-Instruct-Q6_K.gguf',
  'Qwen3-VL-8B-Instruct-Q8_0.gguf',
  'mmproj-Qwen3-VL-8B-Instruct-F16.gguf',
];
// huggingface.co/lmstudio-community/gemma-4-31B-it-GGUF
const LMSTUDIO_GEMMA4_31B = [
  'gemma-4-31B-it-Q4_K_M.gguf',
  'gemma-4-31B-it-Q6_K.gguf',
  'gemma-4-31B-it-Q8_0.gguf',
  'mmproj-gemma-4-31B-it-BF16.gguf',
];
// huggingface.co/bartowski/google_gemma-4-31B-it-GGUF
const BARTOWSKI_GEMMA4_31B = [
  'google_gemma-4-31B-it-IQ1_M.gguf',
  'google_gemma-4-31B-it-IQ2_M.gguf',
  'google_gemma-4-31B-it-IQ2_S.gguf',
  'google_gemma-4-31B-it-IQ2_XS.gguf',
  'google_gemma-4-31B-it-IQ2_XXS.gguf',
  'google_gemma-4-31B-it-IQ3_M.gguf',
  'google_gemma-4-31B-it-IQ3_XS.gguf',
  'google_gemma-4-31B-it-IQ3_XXS.gguf',
  'google_gemma-4-31B-it-IQ4_NL.gguf',
  'google_gemma-4-31B-it-IQ4_XS.gguf',
  'google_gemma-4-31B-it-Q2_K.gguf',
  'google_gemma-4-31B-it-Q2_K_L.gguf',
  'google_gemma-4-31B-it-Q3_K_L.gguf',
  'google_gemma-4-31B-it-Q3_K_M.gguf',
  'google_gemma-4-31B-it-Q3_K_S.gguf',
  'google_gemma-4-31B-it-Q3_K_XL.gguf',
  'google_gemma-4-31B-it-Q4_0.gguf',
  'google_gemma-4-31B-it-Q4_1.gguf',
  'google_gemma-4-31B-it-Q4_K_L.gguf',
  'google_gemma-4-31B-it-Q4_K_M.gguf',
  'google_gemma-4-31B-it-Q4_K_S.gguf',
  'google_gemma-4-31B-it-Q5_K_L.gguf',
  'google_gemma-4-31B-it-Q5_K_M.gguf',
  'google_gemma-4-31B-it-Q5_K_S.gguf',
  'google_gemma-4-31B-it-Q6_K.gguf',
  'google_gemma-4-31B-it-Q6_K_L.gguf',
  'google_gemma-4-31B-it-Q8_0.gguf',
  'google_gemma-4-31B-it-imatrix.gguf',
  'mmproj-google_gemma-4-31B-it-bf16.gguf',
  'mmproj-google_gemma-4-31B-it-f16.gguf',
  'mtp-google_gemma-4-31B-it-Q4_0.gguf',
  'mtp-google_gemma-4-31B-it-Q8_0.gguf',
];
// Two-file repos, [model, projector]: Google's official QAT GGUFs.
const GOOGLE_QAT = [
  // google/gemma-4-31B-it-qat-q4_0-gguf
  ['gemma-4-31B_q4_0-it.gguf', 'gemma-4-31B-it-mmproj.gguf'],
  // google/gemma-4-E4B-it-qat-q4_0-gguf
  ['gemma-4-E4B_q4_0-it.gguf', 'gemma-4-E4B-it-mmproj.gguf'],
  // google/gemma-4-26B-A4B-it-qat-q4_0-gguf
  ['gemma-4-26B_q4_0-it.gguf', 'gemma-4-26B-it-mmproj.gguf'],
  // google/gemma-4-E2B-it-qat-q4_0-gguf
  ['gemma-4-E2B_q4_0-it.gguf', 'gemma-4-E2B-it-mmproj.gguf'],
];
// Two-file repos, [model, projector]: Unsloth save_pretrained_gguf exports.
const UNSLOTH_EXPORTS = [
  // Merttemur06/gokdogan-thermal-json-vision-kimi-Qwen3-VL-4B-Instruct-vision-gguf-q5_k_m
  ['qwen3-vl-4b-instruct.Q5_K_M.gguf', 'qwen3-vl-4b-instruct.BF16-mmproj.gguf'],
  // jica98/qwen3.5-4B-super-coder
  ['qwen3.5-4B-super-coder.Q4_0.gguf', 'qwen3.5-4B-super-coder.BF16-mmproj.gguf'],
];

// The projector file name paired with `model` in a folder listing `names` ('' = none).
function pairedIn(names, model) {
  const projectorPath = resolveProjectorPath({
    modelPath: path.join('models', model),
    fsImpl: { readdirSync: () => [...names] },
  });
  return projectorPath ? path.basename(projectorPath) : '';
}

// A folder's main model files, each mapped to its pick, or all to one projector.
const mainsOf = (names) => splitGgufFiles(names).main;
function picks(names, models = mainsOf(names)) {
  return Object.fromEntries(models.map((model) => [model, pairedIn(names, model)]));
}
const all = (models, projector) => Object.fromEntries(models.map((model) => [model, projector]));

// What a tag resolve over the folder serves: "<model> + <projector>".
function servedFrom(names) {
  const userDataPath = path.resolve('user-data');
  const resolved = resolveGgufPath({
    modelTag: 'tag',
    userDataPath,
    repoRoot: path.resolve('repo'),
    fsImpl: {
      readdirSync: (dir) => {
        if (dir === path.join(userDataPath, 'models', 'tag')) return [...names];
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
    },
  });
  return `${path.basename(resolved.path)} + ${path.basename(resolved.projectorPath) || '(none)'}`;
}

test('noctrex Qwen3-VL-4B: the MXFP4 quant does not split the snapshot [R3-1]', () => {
  assert.deepEqual(picks(NOCTREX_QWEN3_VL_4B), all(mainsOf(NOCTREX_QWEN3_VL_4B), 'mmproj-BF16.gguf'));
  assert.equal(servedFrom(NOCTREX_QWEN3_VL_4B), 'Huihui-Qwen3-VL-4B-Instruct-abliterated-BF16.gguf + mmproj-BF16.gguf');
});

test('noctrex Qwen3-VL-30B-A3B: the MXFP4_MOE quant does not split the snapshot [R3-1]', () => {
  assert.deepEqual(picks(NOCTREX_QWEN3_VL_30B), all(mainsOf(NOCTREX_QWEN3_VL_30B), 'mmproj-Q8_0.gguf'));
});

test('unsloth Qwen3.6-35B-A3B and gemma-4-26B-A4B-it roots: the MXFP4_MOE quant does not split them [R3-1]', () => {
  for (const names of [UNSLOTH_QWEN36_35B, UNSLOTH_GEMMA4_26B]) {
    assert.deepEqual(picks(names), all(mainsOf(names), 'mmproj-BF16.gguf'));
  }
});

test('unsloth Qwen3.5-122B-A10B root: the imatrix_unsloth.gguf data file does not split it [R3-1]', () => {
  const quants = mainsOf(UNSLOTH_QWEN35_122B).filter((name) => name !== 'imatrix_unsloth.gguf');
  assert.equal(quants.length, 6);
  assert.deepEqual(picks(UNSLOTH_QWEN35_122B, quants), all(quants, 'mmproj-BF16.gguf'));
});

test('lmstudio-community Qwen3-VL-8B and gemma-4-31B-it: every quant pairs the projector named for it [R3-2]', () => {
  for (const [names, projector] of [
    [LMSTUDIO_QWEN3_VL_8B, 'mmproj-Qwen3-VL-8B-Instruct-F16.gguf'],
    [LMSTUDIO_GEMMA4_31B, 'mmproj-gemma-4-31B-it-BF16.gguf'],
  ]) {
    assert.deepEqual(picks(names), all(mainsOf(names), projector));
  }
});

test('bartowski gemma-4-31B-it root: all 27 quants pair the bf16 projector [R3-2]', () => {
  // The root also holds an imatrix data file and two MTP drafters.
  const quants = mainsOf(BARTOWSKI_GEMMA4_31B).filter((name) => name !== 'google_gemma-4-31B-it-imatrix.gguf');
  assert.equal(quants.length, 27);
  assert.deepEqual(picks(BARTOWSKI_GEMMA4_31B, quants), all(quants, 'mmproj-google_gemma-4-31B-it-bf16.gguf'));
});

test('a projector named for one model pairs only that model\'s quants [R3-2 guard]', () => {
  // Both repos flattened into one folder: each quant keeps its own projector.
  const flat = [...LMSTUDIO_QWEN3_VL_8B, ...BARTOWSKI_GEMMA4_31B];
  assert.equal(pairedIn(flat, 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf'), 'mmproj-Qwen3-VL-8B-Instruct-F16.gguf');
  assert.equal(pairedIn(flat, 'google_gemma-4-31B-it-Q4_K_M.gguf'), 'mmproj-google_gemma-4-31B-it-bf16.gguf');
  // The 8B projector never pairs a 4B or a 30B-A3B quant.
  const sizes = [...LMSTUDIO_QWEN3_VL_8B, 'Qwen3-VL-4B-Instruct-Q4_K_M.gguf', 'Qwen3-VL-30B-A3B-Instruct-Q4_K_M.gguf'];
  assert.equal(pairedIn(sizes, 'Qwen3-VL-4B-Instruct-Q4_K_M.gguf'), '');
  assert.equal(pairedIn(sizes, 'Qwen3-VL-30B-A3B-Instruct-Q4_K_M.gguf'), '');
});

// Each two-file repo as its own folder: [model, the projector it pairs].
const pairsIn = (repos) => repos.map(([model, projector]) => [model, pairedIn([projector, model], model)]);

test('Google\'s official gemma-4 QAT GGUFs ("<m>_q4_0-it" + "<m>-it-mmproj") pair [R3-3]', () => {
  assert.deepEqual(pairsIn(GOOGLE_QAT), GOOGLE_QAT);
});

test('Unsloth save_pretrained_gguf exports ("<m>.Q5_K_M" + "<m>.BF16-mmproj") pair [R3-3]', () => {
  assert.deepEqual(pairsIn(UNSLOTH_EXPORTS), UNSLOTH_EXPORTS);
});

// Two repos in one flat folder, where one model's name extends the other's.
// lmstudio-community/GLM-4.6V-Flash-GGUF (9B dense) and ggml-org/GLM-4.6V-GGUF
// (106B MoE) share a vision shape, so the other's projector would load and
// silently describe images wrong.
const LMSTUDIO_GLM46V_FLASH = ['GLM-4.6V-Flash-Q4_K_M.gguf', 'GLM-4.6V-Flash-Q6_K.gguf', 'GLM-4.6V-Flash-Q8_0.gguf', 'mmproj-GLM-4.6V-Flash-F16.gguf'];
const GGML_GLM46V = ['GLM-4.6V-Q4_K_M.gguf', 'GLM-4.6V-Q8_0-00001-of-00003.gguf', 'GLM-4.6V-Q8_0-00002-of-00003.gguf', 'GLM-4.6V-Q8_0-00003-of-00003.gguf', 'mmproj-GLM-4.6V-Q8_0.gguf'];
// mradermacher/Qwen2.5-VL-7B-Instruct-abliterated-GGUF and ggml-org/Qwen2.5-VL-7B-Instruct-GGUF.
const MRADERMACHER_QWEN25VL7B_ABLITERATED = [
  'Qwen2.5-VL-7B-Instruct-abliterated.IQ4_XS.gguf', 'Qwen2.5-VL-7B-Instruct-abliterated.Q2_K.gguf',
  'Qwen2.5-VL-7B-Instruct-abliterated.Q4_K_M.gguf', 'Qwen2.5-VL-7B-Instruct-abliterated.Q8_0.gguf',
  'Qwen2.5-VL-7B-Instruct-abliterated.f16.gguf',
  'Qwen2.5-VL-7B-Instruct-abliterated.mmproj-Q8_0.gguf', 'Qwen2.5-VL-7B-Instruct-abliterated.mmproj-f16.gguf',
];
const GGML_QWEN25VL7B = ['Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf', 'Qwen2.5-VL-7B-Instruct-Q8_0.gguf', 'Qwen2.5-VL-7B-Instruct-f16.gguf', 'mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf', 'mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf'];
// HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive and lmstudio-community/Qwen3.5-9B-GGUF.
const HAUHAUCS_QWEN35_9B = [
  'Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf', 'Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf',
  'Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q8_0.gguf', 'mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf',
];
const LMSTUDIO_QWEN35_9B = ['Qwen3.5-9B-Q4_K_M.gguf', 'Qwen3.5-9B-Q6_K.gguf', 'Qwen3.5-9B-Q8_0.gguf', 'mmproj-Qwen3.5-9B-BF16.gguf'];
// ManniX-ITA/Qwen3.6-27B-Omnimerge-v4-GGUF (subset) and lmstudio-community/Qwen3.6-27B-GGUF.
const MANNIX_OMNIMERGE = ['Qwen3.6-27B-Omnimerge-v4-F16.gguf', 'Qwen3.6-27B-Omnimerge-v4-IQ4_XS.gguf', 'Qwen3.6-27B-Omnimerge-v4-Q4_K_M.gguf', 'mmproj-Qwen3.6-27B-Omnimerge-v4-F16.gguf'];
const LMSTUDIO_QWEN36_27B = ['Qwen3.6-27B-Q4_K_M.gguf', 'Qwen3.6-27B-Q6_K.gguf', 'Qwen3.6-27B-Q8_0.gguf', 'mmproj-Qwen3.6-27B-BF16.gguf'];

test('two repos in one folder: each model pairs the projector that names it most closely [R5-1]', () => {
  for (const [repo, own, other, otherOwn] of [
    [LMSTUDIO_GLM46V_FLASH, 'mmproj-GLM-4.6V-Flash-F16.gguf', GGML_GLM46V, 'mmproj-GLM-4.6V-Q8_0.gguf'],
    [MRADERMACHER_QWEN25VL7B_ABLITERATED, 'Qwen2.5-VL-7B-Instruct-abliterated.mmproj-Q8_0.gguf',
      GGML_QWEN25VL7B, 'mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf'],
    [HAUHAUCS_QWEN35_9B, 'mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf',
      LMSTUDIO_QWEN35_9B, 'mmproj-Qwen3.5-9B-BF16.gguf'],
    [MANNIX_OMNIMERGE, 'mmproj-Qwen3.6-27B-Omnimerge-v4-F16.gguf', LMSTUDIO_QWEN36_27B, 'mmproj-Qwen3.6-27B-BF16.gguf'],
  ]) {
    const flat = [...repo, ...other];
    assert.deepEqual(picks(repo), all(mainsOf(repo), own), `${own} alone`);
    assert.deepEqual(picks(flat, mainsOf(repo)), all(mainsOf(repo), own), `${own} beside ${otherOwn}`);
    assert.deepEqual(picks(flat, mainsOf(other)), all(mainsOf(other), otherOwn), `${otherOwn} beside ${own}`);
  }
});

// A precision-less "mmproj-<model>.gguf" names <model> only by containment.
// janhq/Jan-v2-VL-high-gguf and gabriellarson/LFM2-VL-450M-GGUF (subsets).
const JANHQ_JAN_V2_VL_HIGH = ['Jan-v2-VL-high-Q4_K_M.gguf', 'Jan-v2-VL-high-Q8_0.gguf', 'Jan-v2-VL-high.gguf', 'mmproj-Jan-v2-VL-high.gguf'];
const GABRIELLARSON_LFM2_VL_450M = ['LFM2-VL-450M-F16.gguf', 'LFM2-VL-450M-IQ2_M.gguf', 'LFM2-VL-450M-Q4_K_M.gguf', 'mmproj-LFM2-VL-450M.gguf'];

test('a precision-less "mmproj-<model>.gguf" pairs every quant of <model> [R5-3]', () => {
  assert.deepEqual(picks(JANHQ_JAN_V2_VL_HIGH), all(mainsOf(JANHQ_JAN_V2_VL_HIGH), 'mmproj-Jan-v2-VL-high.gguf'));
  assert.deepEqual(picks(GABRIELLARSON_LFM2_VL_450M), all(mainsOf(GABRIELLARSON_LFM2_VL_450M), 'mmproj-LFM2-VL-450M.gguf'));
});

// ZuzeTt/LFM2.5-VL-450M-GGUF and DogContext/GLM-5.3-Flash-Uncensored-Q2-ds4
// ship imatrix-built models whose quant is not the last name token.
test('an imatrix-built model is another model, not imatrix data, wherever its quant sits [R5-2]', () => {
  for (const other of ['LFM2.5-VL-450M-imatrix-Q4_0-pure.gguf', 'GLM-5.3-Flash-Uncensored-IQ2-imatrix-MTP-ds4.gguf']) {
    assert.equal(pairedIn(['gemma-3-4b-it-Q4_K_M.gguf', other, 'mmproj-F16.gguf'], 'gemma-3-4b-it-Q4_K_M.gguf'), '', other);
  }
});
