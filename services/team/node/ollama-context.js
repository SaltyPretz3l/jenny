'use strict';

// The context length an Ollama model carries (row 201, OD-4: a shared GPU keeps `context_length`). Ollama's `/v1/models`
// does not say it; `/api/show` names it in `model_info` under `<architecture>.context_length`. One POST per model on the
// loopback daemon the member's own Jenny names, bounded in time and size, answered from a cache keyed by name and digest
// (a changed model is a new digest) so the repeat reads of a shared GPU cost nothing. The answer is a whole number from
// 2048 to 1048576 (the profile's bounds), else null. Nothing is logged; a failure is null.

const http = require('node:http');

const SHOW_PATH = '/api/show';
const SHOW_TIMEOUT_MS = 2_000;
const SHOW_MAX_BYTES = 512 * 1024;
const CONTEXT_MIN = 2048;
const CONTEXT_MAX = 1048576;
const CACHE_MAX = 256;
// A model that names no usable length is asked again after this long, not on every 45 s survey (row 201 review).
const NULL_TTL_MS = 5 * 60 * 1000;

// The context length `model_info` names, or null.
function contextOfInfo(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  let found = null;
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith('.context_length') || !Number.isSafeInteger(value) || value < CONTEXT_MIN || value > CONTEXT_MAX) continue;
    found = found === null ? value : Math.min(found, value);
  }
  return found;
}

/** `(host, port, name, digest)` -> the model's context length or null. `request` and `now` are seams for tests. */
function createOllamaContextReader({ request = http.request, now = Date.now } = {}) {
  const cache = new Map();
  function show(host, port, name) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      const body = Buffer.from(JSON.stringify({ model: name }));
      let req;
      try {
        req = request({ host, port, method: 'POST', path: SHOW_PATH, agent: false, timeout: SHOW_TIMEOUT_MS,
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Accept: 'application/json' } });
      } catch (_error) { done(null); return; }
      req.on('timeout', () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
      req.on('response', (response) => {
        if (response.statusCode !== 200) { response.destroy(); done(null); return; }
        const parts = [];
        let size = 0;
        response.on('data', (part) => {
          size += part.length;
          if (size > SHOW_MAX_BYTES) { response.destroy(); done(null); return; }
          parts.push(part);
        });
        response.on('end', () => {
          try { done(contextOfInfo(JSON.parse(Buffer.concat(parts).toString('utf8'))?.model_info)); } catch (_error) { done(null); }
        });
        response.on('error', () => done(null));
        response.on('close', () => done(null));
      });
      req.end(body);
    });
  }
  return async function contextLength(host, port, name, digest = '') {
    const key = `${host}:${port}|${name}|${digest}`;
    const held = digest ? cache.get(key) : undefined;
    if (held && held.until > now()) return held.value;
    const value = await show(host, port, name);
    if (digest) {
      cache.delete(key);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { value, until: value === null ? now() + NULL_TTL_MS : Infinity });
    }
    return value;
  };
}

module.exports = { contextOfInfo, createOllamaContextReader };
