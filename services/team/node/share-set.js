'use strict';

// What a shared GPU offers from Ollama, and how a changed offer is noticed (row 201, OD-4). Ollama lists every
// installed model at `/v1/models`: sharing all of them lets one team turn swap a 64-model library through the
// sharer's VRAM. So for Ollama the node offers only a share set:
//   - the models the sharer chose (`ollama_models` in sharing.json, sharing-file.js), else
//   - the model the owner's own chat has loaded (`currentModel`, while Ollama is the current engine), else
//   - the models Ollama reports loaded now (`/api/ps`).
// The set is applied where the agent reads `/v1/models` (`createShareClient` wraps the engine client), so the
// register, the offered-model check for each job and the refresh below all see the same list. Names are compared
// without a trailing `:latest` and without case. Every other engine's answer is passed through untouched.
// A list that cannot be read is an empty share set: fail closed. Nothing here is logged or kept.

const { Readable } = require('node:stream');
const { readBounded } = require('./engine-forward');

const MODELS_PATH = '/v1/models';
const PS_PATH = '/api/ps';
const LIST_MAX_BYTES = 1024 * 1024;
const PS_MAX_BYTES = 256 * 1024;

const stem = (name) => String(name).trim().replace(/:latest$/iu, '').toLowerCase();


async function readJsonBody(answer, max) {
  const bytes = await readBounded(answer.body, max);
  try { return bytes ? JSON.parse(bytes.toString('utf8')) : null; } catch (_error) { return null; }
}

// The names Ollama has loaded now, as a Set of stems; empty when it cannot say.
async function loadedModels(base, target, signal) {
  let answer;
  try { answer = await base.call({ target, method: 'GET', path: PS_PATH, signal }); } catch (_error) { return new Set(); }
  if (answer.status !== 200) { answer.body.destroy(); return new Set(); }
  const parsed = await readJsonBody(answer, PS_MAX_BYTES);
  const rows = Array.isArray(parsed?.models) ? parsed.models : [];
  const names = rows.map((row) => (typeof row?.name === 'string' ? row.name : row?.model)).filter((name) => typeof name === 'string' && name);
  return new Set(names.map(stem));
}

/**
 * The share set of Ollama as `allowed({ target, signal })`: a Set of stems. `chosen()` is the sharer's saved list or null,
 * `current()` the owner's own current Ollama model or ''.
 */
function createOllamaShareSet({ base, chosen = () => null, current = () => '' }) {
  return async ({ target, signal }) => {
    const picked = chosen();
    if (Array.isArray(picked) && picked.length > 0) return new Set(picked.map(stem));
    const name = current();
    if (typeof name === 'string' && name.trim()) return new Set([stem(name)]);
    return loadedModels(base, target, signal);
  };
}

/**
 * The engine client with the share set applied to its `/v1/models` answer. `allowed` answers a Set of stems, or null for
 * "every model" (the answer then passes through unread); a throw is an empty set.
 */
function createShareClient({ base, allowed }) {
  async function call(options) {
    const answer = await base.call(options);
    if (options.method !== 'GET' || options.path !== MODELS_PATH || answer.status !== 200) return answer;
    let keep;
    try { keep = await allowed({ target: options.target, signal: options.signal }); } catch (_error) { keep = new Set(); }
    if (keep === null || keep === undefined) return answer;
    const parsed = await readJsonBody(answer, LIST_MAX_BYTES);
    if (!parsed || !Array.isArray(parsed.data)) return { status: 502, body: Readable.from([]) };
    const data = parsed.data.filter((row) => typeof row?.id === 'string' && keep.has(stem(row.id)));
    return { status: 200, body: Readable.from([Buffer.from(JSON.stringify({ ...parsed, data }))]) };
  }
  return { call, openRequests: () => base.openRequests() };
}

/**
 * What a register would send, as one comparable text: each model's name, context length, vision and thinking, in name order.
 * `models` are readModels rows, `capabilities` the member's own capability Map or null.
 */
function modelSignature(models, capabilities) {
  const known = capabilities instanceof Map ? capabilities : new Map();
  const rows = models.map((entry) => {
    const caps = known.get(entry.name);
    const length = Number.isSafeInteger(entry.context_length) ? entry.context_length : caps?.context_length;
    return [entry.name, Number.isSafeInteger(length) ? length : null, caps?.vision === true, caps?.thinking === true];
  });
  return JSON.stringify(rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

module.exports = { createOllamaShareSet, createShareClient, modelSignature };
