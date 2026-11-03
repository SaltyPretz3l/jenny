'use strict';

// Single source of the `suggest_next_step` limits and shape. The tool normalizes
// model input with `normalizeNextStep`; the persisted-metadata whitelist
// re-validates a stored result with `normalizeNextStepResultMetadata`, so a card
// can only ever render values that fit these bounds.
const { isPlainObject } = require('../value-utils');

const LIMITS = Object.freeze({ recap: 300, question: 100, actions: 3, label: 24, message: 300 });
const ELLIPSIS = '…';

// Collapse every whitespace run (newlines included) to one space; over-length
// text is cut so the result, ellipsis included, is exactly `limit` long.
function clampText(value, limit) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}${ELLIPSIS}` : text;
}

function fail(rule) {
  return { ok: false, error: `suggest_next_step: ${rule}` };
}

// Returns `{ ok: true, value }` or `{ ok: false, error }`; never throws.
function normalizeNextStep(input) {
  const source = isPlainObject(input) ? input : {};
  if (typeof source.recap !== 'string') return fail('recap is required and must be a string.');
  const recap = clampText(source.recap, LIMITS.recap);
  if (!recap) return fail('recap is required and must not be empty.');

  let question = null;
  if (source.question !== undefined && source.question !== null) {
    if (typeof source.question !== 'string') return fail('question must be a string.');
    question = clampText(source.question, LIMITS.question) || null;
  }

  let rawActions = [];
  if (source.actions !== undefined && source.actions !== null) {
    if (!Array.isArray(source.actions)) return fail('actions must be an array.');
    rawActions = source.actions;
  }
  if (rawActions.length > LIMITS.actions) return fail(`actions allows at most ${LIMITS.actions} buttons.`);
  const actions = [];
  for (const raw of rawActions) {
    if (!isPlainObject(raw)) return fail('each action must be an object with a label and a message.');
    if (typeof raw.label !== 'string') return fail('action label must be a string.');
    if (typeof raw.message !== 'string') return fail('action message must be a string.');
    const label = clampText(raw.label, LIMITS.label);
    const message = clampText(raw.message, LIMITS.message);
    if (!label) return fail('action label must not be empty.');
    if (!message) return fail('action message must not be empty.');
    actions.push({ label, message });
  }
  if (question && !actions.length) return fail('question needs at least one action.');
  return { ok: true, value: { recap, question, actions } };
}

const isBoundedText = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit;

// Persistence allowlist: flat keys only, `{}` unless the stored shape is exactly the success shape.
function normalizeNextStepResultMetadata(source) {
  try {
    if (!isPlainObject(source) || source.result_kind !== 'next_step' || source.schema_version !== 1) return {};
    if (!isBoundedText(source.recap, LIMITS.recap)) return {};
    if (source.question != null && !isBoundedText(source.question, LIMITS.question)) return {};
    if (!Array.isArray(source.actions) || source.actions.length > LIMITS.actions) return {};
    const actions = [];
    for (const action of source.actions) {
      if (!isPlainObject(action) || Object.keys(action).length !== 2) return {};
      if (!isBoundedText(action.label, LIMITS.label) || !isBoundedText(action.message, LIMITS.message)) return {};
      actions.push({ label: action.label, message: action.message });
    }
    if (source.question && !actions.length) return {};
    return { result_kind: 'next_step', schema_version: 1, recap: source.recap, question: source.question, actions };
  } catch (_error) {
    return {};
  }
}

module.exports = { LIMITS, normalizeNextStep, normalizeNextStepResultMetadata };
