'use strict';

/* Argument names `preview_test` accepts, mirrored from the tool manifest for
 * direct callers. A misspelled key must fail: a call that sent `interactions`
 * instead of `events` once came back as a successful zero-interaction test.
 * No extension arguments are consumed by this bounded, one-shot tool. */

const INPUT_KEYS = new Set(['path', 'viewport', 'wait_ms', 'screenshot', 'events', 'observe']);
const EVENT_KEYS = new Set(['action', 'selector', 'text', 'press_enter']);

function hasUnknownKey(value, allowed) {
  return Object.keys(value || {}).some((key) => !allowed.has(key));
}

/** Failure fields for an unrecognised top-level argument, or null. */
function unknownArgumentFailure(input) {
  if (!hasUnknownKey(input, INPUT_KEYS)) return null;
  return {
    reason: 'unknown_argument',
    message: 'Unsupported preview_test argument. Supported arguments: path, viewport, wait_ms, screenshot, events, observe. Use events for click/type interactions.',
    summary: 'Unsupported preview argument',
  };
}

/** Failure fields for an unrecognised argument on one event, or null. */
function unknownEventArgumentFailure(event) {
  if (!hasUnknownKey(event, EVENT_KEYS)) return null;
  return {
    reason: 'unknown_event_argument',
    message: 'Unsupported preview event argument. Supported event arguments: action, selector, text, press_enter.',
    summary: 'Unsupported preview event argument',
  };
}

module.exports = { unknownArgumentFailure, unknownEventArgumentFailure };
