'use strict';

// GGUF file discovery for the managed llama-server: which files in a model
// directory are the main model, the MTP drafters and the vision projectors,
// where a model tag's GGUF lives, and which projector a model carries. Split
// out of llama-server-lifecycle.js (which re-exports these names) so the
// spawn/stop module stays under the 600-line ratchet.

const fs = require('fs');
const path = require('path');

const { stripLatestTag } = require('./llama-server-readiness');

function isUnsafeFilenameCharacter(character) {
  return character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character);
}

function normalizeModelTagForFilename(modelTag) {
  return Array.from(stripLatestTag(modelTag))
    .map((character) => (isUnsafeFilenameCharacter(character) ? '_' : character))
    .join('')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Name separators are "-", "_", "." and whitespace: browser and Explorer
// duplicates add " (1)" and " - Copy", and some names are space-separated.
// Projector names are matched on the file name without its extension. A
// LEADING mmproj keeps the original boundary-free rule ("mmproj-x-f16",
// "mmprojector"), so no file that was a projector becomes a main model. An
// infix mmproj must be a whole separator-delimited token ("x-mmproj-Q8_0",
// "x.mmproj-f16", "x_mmproj", "x mmproj Q8_0", "x-mmproj (1)"), so
// "x-mmprojector" stays a main model.
const PREFIX_PROJECTOR = /^mmproj/i;
const INFIX_PROJECTOR = /[-_.\s]mmproj(?=[-_.\s]|$)/i;
// A precision: Q8_0 / Q4_K_M / IQ4_XS / TQ2_0 / Q8, BF16 / F16 / FP16, F32 / FP32.
const PRECISION = String.raw`[it]?q\d+(?:_[a-z0-9]+)*|bf16|fp?16|fp?32`;
const PRECISION_TOKEN = new RegExp(String.raw`(?:^|[-_.\s])(${PRECISION})(?=[-_.\s]|$)`, 'gi');
// A prefix stem that is only a precision, optionally after "model"
// ("mmproj-F16", ggml-org's "mmproj-model-f16"), names no model.
const GENERIC_STEM = new RegExp(String.raw`^(?:model(?:[-_.\s]|$))?(?:${PRECISION})?$`, 'i');
// A model quant: a precision, or an MXFP4 / MXFP4_MOE / NVFP4 4-bit float. A
// trailing one may carry unsloth's dynamic ("-UD-") or mradermacher's imatrix
// ("-i1-") marker.
const QUANT = String.raw`${PRECISION}|mxfp4(?:_moe)?|nvfp4`;
const QUANT_SUFFIX = new RegExp(String.raw`(?:[-_.\s](?:ud|i1))?[-_.\s](?:${QUANT})$`, 'i');

const baseName = (name) => path.basename(String(name), path.extname(String(name)));
const isDrafter = (name) => /^mtp-/i.test(name);
// A drafter is never a projector, even when its name carries an mmproj token.
const isProjector = (name) => {
  if (isDrafter(name)) return false;
  const base = baseName(name);
  return PREFIX_PROJECTOR.test(base) || INFIX_PROJECTOR.test(base);
};

// MTP drafters (mtp-*.gguf) and vision projectors (mmproj-*.gguf, or
// <model>-mmproj-<quant>.gguf) are documented to live next to the main model —
// never serve one AS the main model. Sorted so every consumer picks the same
// first main candidate.
function splitGgufFiles(names) {
  const ggufs = (Array.isArray(names) ? names : [])
    .filter((name) => /\.gguf$/i.test(String(name)))
    .map(String)
    .sort();
  return {
    main: ggufs.filter((name) => !isDrafter(name) && !isProjector(name)),
    drafters: ggufs.filter((name) => isDrafter(name)),
    projectors: ggufs.filter((name) => isProjector(name)),
  };
}

function resolveGgufPath({
  modelTag,
  userDataPath = '',
  repoRoot = process.cwd(),
  fsImpl = fs,
} = {}) {
  const alias = stripLatestTag(modelTag);
  const filenameTag = normalizeModelTagForFilename(modelTag);
  if (!filenameTag) {
    return { path: '', projectorPath: '', reason: 'model_tag_empty' };
  }

  const candidateDirs = [];
  if (userDataPath) {
    candidateDirs.push(path.join(userDataPath, 'models', filenameTag));
  }
  candidateDirs.push(path.join(repoRoot, '.jenny', 'models', filenameTag));

  for (const dir of candidateDirs) {
    try {
      // A directory holding only auxiliaries (e.g. a partial download) means
      // the main model is genuinely absent: keep scanning and let the
      // standard not_found path report it.
      const split = splitGgufFiles(fsImpl.readdirSync(dir));
      if (split.main.length > 0) {
        return {
          path: path.join(dir, split.main[0]),
          projectorPath: pairProjector(dir, split.main[0], split),
          reason: 'resolved',
        };
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        return { path: '', projectorPath: '', reason: `read_dir_failed:${error.code || 'unknown'}` };
      }
    }
  }

  if (alias.toLowerCase().startsWith('gemma4-e4b-it-')) {
    const legacyPath = path.join(repoRoot, 'gemma-4-E4B-it-UD-Q5_K_XL.gguf');
    try {
      if (fsImpl.statSync(legacyPath).isFile()) {
        return { path: legacyPath, projectorPath: '', reason: 'resolved_legacy' };
      }
    } catch (_error) {
      /* fall through to not_found */
    }
  }

  return { path: '', projectorPath: '', reason: 'not_found' };
}

// The stem a projector pairs by, and the tail after its mmproj token. A prefix
// name ("mmproj-<model>-<quant>") keeps the original stem: drop "mmproj-" or
// "mmproj_", lowercase. An infix name ("<model>-mmproj-<quant>") drops the
// token and everything after it, then trailing separators, then a trailing
// quant (Unsloth's save_pretrained_gguf "<model>.BF16-mmproj"), then lowercases.
function parseProjectorName(name) {
  const base = baseName(name);
  const infix = PREFIX_PROJECTOR.test(base) ? null : INFIX_PROJECTOR.exec(base);
  if (!infix) {
    return {
      infix: false,
      stem: base.replace(/^mmproj[-_]/i, '').toLowerCase(),
      tail: base.replace(PREFIX_PROJECTOR, ''),
    };
  }
  return {
    infix: true,
    stem: base.slice(0, infix.index).replace(/[-_.\s]+$/, '').replace(QUANT_SUFFIX, '').toLowerCase(),
    tail: base.slice(infix.index + infix[0].length),
  };
}

// The model stem equals `stem` or continues it past a separator.
const continuesStem = (modelStem, stem) => modelStem.startsWith(stem)
  && /^(?:[-_.\s]|$)/.test(modelStem.slice(stem.length));

// A prefix stem keeps the original two-way containment match, except a
// generic one ("f32", "model-f16") that names no model, so "mmproj-F32" never
// claims a "...-F32" model. A prefix stem "<model>-<precision>" (bartowski's
// and lmstudio-community's "mmproj-<model>-<precision>") also names <model>
// the way an infix stem does. An infix stem names its model outright, so the
// model stem must equal it or continue it past a separator: "x-27b" pairs
// "x-27b-pq2_0", never "x-27bx-q4" or "my-x-27b-q4".
function projectorNamesModel(projector, modelStem) {
  const { infix, stem } = parseProjectorName(projector);
  if (!modelStem || !stem) return false;
  if (infix) return continuesStem(modelStem, stem);
  if (GENERIC_STEM.test(stem)) return false;
  const bare = stem.replace(QUANT_SUFFIX, '');
  return modelStem.includes(stem) || stem.includes(modelStem)
    || (bare !== '' && bare !== stem && continuesStem(modelStem, bare));
}

// How much of the model's name a naming projector names: the whole stem of an
// infix one, else the prefix stem without its precision. A fine-tune or a
// "-Flash" sibling beside its base pairs its own projector, not the base's.
function namedLength(projector, modelStem) {
  const { infix, stem } = parseProjectorName(projector);
  if (infix) return stem.length;
  const bare = stem.replace(QUANT_SUFFIX, '');
  return continuesStem(modelStem, bare) || modelStem.includes(stem) ? bare.length : 0;
}

// What a lone main model may own when no projector names it: a prefix
// projector, an infix one with no stem, or an infix one whose stem loosely
// names the model with separators and the model's own precision tokens ignored
// (koboldcpp's "gemma3-4b-mmproj" for "gemma-3-4b-it-Q4_K_M", Google's
// "gemma-4-31B-it-mmproj" for "gemma-4-31B_q4_0-it"). Never an infix projector
// naming another model: a mismatched projector fails the whole launch, where
// none only loses vision.
const squashSeparators = (text) => text.replace(/[-_.\s]/g, '');
function loneModelOwns(projector, modelStem) {
  const { infix, stem } = parseProjectorName(projector);
  if (!infix || !stem) return true;
  return squashSeparators(modelStem.replace(PRECISION_TOKEN, '')).startsWith(squashSeparators(stem));
}

// Several mains that are all quants or shards of ONE model ("<model>-BF16",
// "<model>-Q4_K_M", "<model>-UD-Q4_K_XL", "<model>.i1-IQ4_XS", "<model>-MXFP4_MOE",
// "<model>-Q4_K_M-00001-of-00002") are one model, as in an unsloth or noctrex
// snapshot beside its generic mmproj-BF16/F16/F32. When no projector names that
// model, it owns only the projectors that name no model ("mmproj-F16",
// "mmproj-model-f16"). Another size or build ("-12b-", "-qat-") is another
// model. An imatrix data file (unsloth's "imatrix_unsloth.gguf", bartowski's
// "<model>-imatrix.gguf") is no model at all: its name ends with the imatrix
// token, or starts with it and carries no trailing quant, so
// "<model>-imatrix-IQ2_M" and "<model>-imatrix-Q4_0-pure" are models. The
// requested file must be that model too: a deleted model or an Ollama blob
// beside another model's quants owns nothing.
const SHARD_SUFFIX = /[-_.\s]\d{5}-of-\d{5}$/i;
const isImatrixData = (name) => {
  const base = baseName(name).replace(SHARD_SUFFIX, '');
  return /(?:^|[-_.\s])imatrix$/i.test(base) || (/^imatrix(?:[-_.\s]|$)/i.test(base) && !QUANT_SUFFIX.test(base));
};
const modelFamily = (name) => baseName(name).replace(SHARD_SUFFIX, '').replace(QUANT_SUFFIX, '').toLowerCase();
function oneModel(modelFile, main) {
  const models = main.filter((name) => !isImatrixData(name));
  if (models.length === 0) return false;
  const family = modelFamily(models[0]);
  return [modelFile, ...models].every((name) => modelFamily(name) === family);
}
const namesNoModel = (projector) => {
  const { stem } = parseProjectorName(projector);
  return !stem || GENERIC_STEM.test(stem);
};

// Smallest first: quantized (Q8_0, IQ4_XS, TQ2_0, Q8 ...), then F16/BF16, then
// F32, then an unknown precision. Read from the LAST precision token after the
// mmproj token: an infix name's model quant sits before the token, and a prefix
// name's own precision trails any quant inside its model part.
function projectorPrecisionRank(projector) {
  const tokens = [...parseProjectorName(projector).tail.matchAll(PRECISION_TOKEN)];
  const precision = tokens.length > 0 ? tokens[tokens.length - 1][1].toLowerCase() : '';
  if (/^[it]?q/.test(precision)) return 0;
  if (precision.endsWith('16')) return 1;
  if (precision.endsWith('32')) return 2;
  return 3;
}

// Precision rank first, then the case-folded name, so capitalisation never
// changes the pick: "mmproj-bf16" beats "mmproj-F16" as "mmproj-BF16" beats
// "mmproj-f16".
function compareProjectors(left, right) {
  const byRank = projectorPrecisionRank(left) - projectorPrecisionRank(right);
  if (byRank !== 0) return byRank;
  const [a, b] = [left.toLowerCase(), right.toLowerCase()];
  return a < b ? -1 : Number(a > b);
}

// Shared pairing rule: a projector pairs with the model its stem names. When
// none does, a lone main model owns the projectors loneModelOwns allows, and a
// quant in a folder of only its own model's quants or shards owns those that
// name no model. Among several naming candidates the most specific name wins,
// then compareProjectors decides.
function pairProjector(dir, modelFile, { main, projectors }) {
  if (projectors.length === 0) return '';
  const modelStem = path.basename(modelFile, path.extname(modelFile))
    .replace(/^mmproj[-_]/i, '').toLowerCase();
  const named = projectors.filter((projector) => projectorNamesModel(projector, modelStem));
  let candidates = named;
  if (named.length === 0 && main.length === 1) {
    candidates = projectors.filter((projector) => loneModelOwns(projector, modelStem));
  } else if (named.length === 0 && oneModel(modelFile, main)) {
    candidates = projectors.filter(namesNoModel);
  }
  const bySpecificity = (left, right) => (candidates === named
    ? namedLength(right, modelStem) - namedLength(left, modelStem) : 0) || compareProjectors(left, right);
  const [paired] = [...candidates].sort(bySpecificity);
  return paired ? path.join(dir, paired) : '';
}

function resolveProjectorPath({ modelPath, fsImpl = fs } = {}) {
  try {
    if (!String(modelPath || '').trim()) {
      return '';
    }
    const dir = path.dirname(modelPath);
    return pairProjector(dir, modelPath, splitGgufFiles(fsImpl.readdirSync(dir)));
  } catch (_error) {
    return '';
  }
}

module.exports = {
  normalizeModelTagForFilename,
  pairProjector,
  resolveGgufPath,
  resolveProjectorPath,
  splitGgufFiles,
};
