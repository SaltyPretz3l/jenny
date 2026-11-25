'use strict';

// The canonical body of a team engine chat request (review finding C5). A member's
// request is forwarded to a teammate's own local engine, and an engine like Ollama
// reads JSON keys without regard to case and acts on fields no Jenny client sends
// (`options`, `keep_alive`, `slot_id`, `grammar`, `n`). So the host never forwards the
// caller's object: it builds a new one from a fixed lowercase allowlist of the
// OpenAI chat-completions fields Jenny's own clients send (the sidecar's engines and
// `thinking` fitting), with each value held to its type, and refuses a body that
// carries a case variant of an allowed key. Every other key is dropped.
//
// The case rule reaches inside `messages` too: Ollama decodes nested keys without regard to case, so a content
// part spelt `Image_Url` would pass the host's image check and still reach the engine as an image. Every key
// inside a message must be spelt as it folds (all OpenAI message keys are lower case).
//
// Pure: no I/O, no logging, no other team module (the node agent imports it as its own check).

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Deeper than any message Jenny sends (message > content > part > image_url > url): a deeper one is refused.
const MAX_MESSAGE_DEPTH = 8;

const REASON = 'team_request_field_invalid';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isInteger = (value) => Number.isSafeInteger(value);
const isString = (value) => typeof value === 'string';
const isBoolean = (value) => typeof value === 'boolean';

// Fields Jenny's clients send and the type each takes; a value of another type is dropped (the engine's
// own default applies), never forwarded. `n` is handled apart: it is always 1.
const FIELD_TYPES = Object.freeze({
  model: isString,
  messages: Array.isArray,
  stream: isBoolean,
  temperature: isFiniteNumber,
  top_p: isFiniteNumber,
  top_k: isInteger,
  min_p: isFiniteNumber,
  presence_penalty: isFiniteNumber,
  frequency_penalty: isFiniteNumber,
  repeat_penalty: isFiniteNumber,
  max_tokens: isInteger,
  max_completion_tokens: isInteger,
  seed: isInteger,
  thinking_budget_tokens: isInteger,
  reasoning_effort: isString,
  stop: (value) => isString(value) || (Array.isArray(value) && value.every(isString)),
  tools: Array.isArray,
  tool_choice: (value) => isString(value) || isPlainObject(value),
  parallel_tool_calls: isBoolean,
  response_format: isPlainObject,
});
const NESTED = Object.freeze({
  // The one stream option the usage log reads.
  stream_options: Object.freeze({ include_usage: isBoolean }),
  // What the thinking fitter reads and writes; no other template argument is forwarded.
  chat_template_kwargs: Object.freeze({ enable_thinking: isBoolean, reasoning_effort: isString }),
});
const ALLOWED = Object.freeze(new Set([...Object.keys(FIELD_TYPES), ...Object.keys(NESTED), 'n']));

// The name an engine that matches keys without regard to case would read: lower case, and the one non-ASCII
// letter that case-folds into ASCII besides the Kelvin sign (which `toLowerCase` already maps to `k`).
const folded = (key) => key.replace(/ſ/gu, 's').toLowerCase();

// True when every key inside `value` (a messages array) is spelt as it folds, within the depth bound.
function foldedKeys(value, depth = 0) {
  if (depth > MAX_MESSAGE_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => foldedKeys(item, depth + 1));
  if (!isPlainObject(value)) return true;
  return Object.keys(value).every((key) => folded(key) === key && foldedKeys(value[key], depth + 1));
}

function nested(value, shape) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const [name, accepts] of Object.entries(shape)) {
    if (Object.hasOwn(value, name) && accepts(value[name])) out[name] = value[name];
  }
  return out;
}

/**
 * `{ ok: true, body }` with a new object holding only allowlisted, well-typed fields, or
 * `{ ok: false, reason }` when a key is a case variant of an allowed one (`Stream`, `MODEL`) or a key inside
 * `messages` is not spelt as it folds (`Image_Url`, `Content`).
 * `n` is forced to 1 when present; `options`, `keep_alive`, `slot_id`, `lora`, `grammar` and every
 * other key are dropped. The input is never changed or returned.
 */
function canonicalChatBody(body) {
  if (!isPlainObject(body)) return { ok: false, reason: REASON };
  const keys = Object.keys(body);
  for (const key of keys) {
    if (!ALLOWED.has(key) && ALLOWED.has(folded(key))) return { ok: false, reason: REASON };
  }
  if (Object.hasOwn(body, 'messages') && !foldedKeys(body.messages)) return { ok: false, reason: REASON };
  const out = {};
  for (const key of keys) {
    if (!ALLOWED.has(key)) continue;
    const value = body[key];
    if (key === 'n') out.n = 1;
    else if (Object.hasOwn(NESTED, key)) {
      const rebuilt = nested(value, NESTED[key]);
      if (rebuilt) out[key] = rebuilt;
    } else if (FIELD_TYPES[key](value)) out[key] = value;
  }
  return { ok: true, body: out };
}

// Whether `body` is already exactly what the host forwards (the node's check, C5): canonical, every field one the host
// keeps, and one choice.
function isCanonicalBody(body) {
  return canonicalChatBody(body).ok === true && Object.keys(body).every((key) => ALLOWED.has(key)) && (body.n === undefined || body.n === 1);
}

module.exports = { ALLOWED_FIELDS: ALLOWED, REQUEST_FIELD_REASON: REASON, canonicalChatBody, isCanonicalBody };
