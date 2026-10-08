'use strict';

/* Argument names `preview_test` accepts, mirrored from the tool manifest for
 * direct callers. A misspelled key must fail: a call that sent `interactions`
 * instead of `events` once came back as a successful zero-interaction test.
 * No extension arguments are consumed by this bounded, one-shot tool. */

const { normalizeString } = require('../../shared/normalize');
const { PRESS_KEYS, resolvePressKeyAlias } = require('../../browser-interaction-utils');

const INPUT_KEYS = new Set(['path', 'viewport', 'wait_ms', 'screenshot', 'events', 'observe']);
const EVENT_KEYS = new Set(['action', 'selector', 'key', 'text', 'press_enter']);

function hasUnknownKey(value, allowed) {
  return Object.keys(value || {}).some((key) => !allowed.has(key));
}

/** Failure fields for an unrecognised top-level argument, or null. */
function unknownArgumentFailure(input) {
  if (!hasUnknownKey(input, INPUT_KEYS)) return null;
  return {
    reason: 'unknown_argument',
    message: 'Unsupported preview_test argument. Supported arguments: path, viewport, wait_ms, screenshot, events, observe. Use events for click/type/hover/focus/press interactions.',
    summary: 'Unsupported preview argument',
  };
}

/** Failure fields for an unrecognised argument on one event, or null. */
function unknownEventArgumentFailure(event) {
  if (!hasUnknownKey(event, EVENT_KEYS)) return null;
  return {
    reason: 'unknown_event_argument',
    message: 'Unsupported preview event argument. Supported event arguments: action, selector, key, text, press_enter. Actions: click, type, hover, focus, press; key applies to press only.',
    summary: 'Unsupported preview event argument',
  };
}

const EVENT_ACTIONS = Object.freeze(['click', 'type', 'hover', 'focus', 'press']);

function invalidEvent(message) {
  return { reason: 'invalid_event', message, summary: 'Invalid preview event' };
}

/** One raw event as `{ event }`, or `{ failure }` fields for the tool's failure(). */
function normalizePreviewEvent(raw) {
  const action = normalizeString(raw?.action);
  const selector = normalizeString(raw?.selector);
  // " " is Space (resolved before trimming would erase it); the event carries the canonical name.
  const key = raw?.key === undefined ? '' : resolvePressKeyAlias(raw.key);
  if (
    !raw
    || typeof raw !== 'object'
    || Array.isArray(raw)
    || !EVENT_ACTIONS.includes(action)
    || (action !== 'press' && !selector)
  ) {
    return { failure: invalidEvent('Each event must provide action "click", "type", "hover", "focus" or "press"; every action except press also needs a non-empty selector.') };
  }
  const unknown = unknownEventArgumentFailure(raw);
  if (unknown) return { failure: unknown };
  if ((action === 'press') !== (raw.key !== undefined) || (action === 'press' && !PRESS_KEYS.includes(key))) {
    return { failure: invalidEvent(`A press event requires key to be one of: ${PRESS_KEYS.join(', ')}; key is not allowed on other actions.`) };
  }
  return {
    event: { action, selector, key, text: String(raw.text ?? ''), press_enter: raw.press_enter === true },
  };
}

module.exports = {
  EVENT_ACTIONS,
  normalizePreviewEvent,
  unknownArgumentFailure,
};
