'use strict';

const { FATAL_OLLAMA_STDERR_PATTERNS } = require('./ollama-crash-diagnostics');
const { collapseRedactedPathTails, redactLogValue } = require('../log-entry-normalizer');

const GPU_FAILURE_PATTERN = FATAL_OLLAMA_STDERR_PATTERNS.find((entry) => entry.likelyCause === 'gpu').pattern;
const CAUSES = new Set(['out_of_memory', 'engine_unreachable', 'timeout', 'other']);

function classifyLoadFailure(message, { timedOut = false, unreachable = false } = {}) {
  const text = String(message || '');
  if (timedOut || /timed out/i.test(text)) return 'timeout';
  if (unreachable || /connection refused|could not connect|unreachable/i.test(text)) return 'engine_unreachable';
  if (/memory|VRAM/i.test(text) || GPU_FAILURE_PATTERN.test(text)) return 'out_of_memory';
  return 'other';
}

function buildLoadFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const { cause, message, context, engine, model, at } = value;
  if (!CAUSES.has(cause) || typeof message !== 'string'
    || typeof engine !== 'string' || typeof model !== 'string') return null;
  return {
    cause,
    message: collapseRedactedPathTails(String(redactLogValue(message)), '[redacted]').trim().slice(0, 240),
    context: Number.isSafeInteger(context) && context > 0 ? context : null,
    at: typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : new Date().toISOString(),
    engine: engine.trim(),
    model: model.trim(),
  };
}

module.exports = { classifyLoadFailure, buildLoadFailure };
