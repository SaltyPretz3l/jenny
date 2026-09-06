'use strict';

const { redactSensitiveLikeText } = require('./backend/tool-loop-input-sanitization');

const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 5_000;
const MAX_BROWSER_ACTION_TIMEOUT_MS = 30_000;
const MAX_SELECTOR_LENGTH = 1_000;
const MAX_TYPE_TEXT_LENGTH = 10_000;
const MAX_EVAL_SCRIPT_LENGTH = 10_000;
const MAX_EVAL_RESULT_CHARS = 20_000;
const MAX_EVAL_RESULT_DEPTH = 6;
const MAX_EVAL_RESULT_ITEMS = 100;

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|bearer|credential|password|refresh[_-]?token|secret|token)/i;
const SENSITIVE_VALUE_PATTERN = /\b(?:bearer\s+[a-z0-9._~+/=-]{12,}|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{20,})\b/i;

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function boundedPositiveInt(value, fallback, maxValue) {
  const normalized = positiveInt(Number(value), fallback);
  return Math.min(normalized, maxValue);
}

function normalizeSelector(value) {
  const selector = String(value || '').trim();
  if (!selector) {
    throw new Error('A browser selector is required.');
  }
  if (selector.length > MAX_SELECTOR_LENGTH) {
    throw new Error(`Browser selector exceeds ${MAX_SELECTOR_LENGTH} characters.`);
  }
  return selector;
}

function normalizeClickButton(value) {
  const button = String(value || 'left').trim().toLowerCase();
  return ['left', 'middle', 'right'].includes(button) ? button : 'left';
}

function safeBrowserReason(value, fallback = 'browser_action_failed') {
  const reason = redactSensitiveLikeText(value || fallback)
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return reason.slice(0, 500) || fallback;
}

function redactString(value, state) {
  const raw = String(value || '');
  if (SENSITIVE_VALUE_PATTERN.test(raw)) {
    return '[redacted]';
  }
  const available = Math.max(0, MAX_EVAL_RESULT_CHARS - state.chars);
  if (available <= 0) {
    state.truncated = true;
    return '';
  }
  if (raw.length > available) {
    state.truncated = true;
    state.chars += available;
    return raw.slice(0, available);
  }
  state.chars += raw.length;
  return raw;
}

function sanitizePageResult(value, state = { chars: 0, truncated: false, seen: new Set() }, depth = 0) {
  if (value === null || value === undefined) {
    return { value: null, truncated: state.truncated };
  }
  const type = typeof value;
  if (type === 'string') {
    return { value: redactString(value, state), truncated: state.truncated };
  }
  if (type === 'number' || type === 'boolean') {
    return { value: Number.isFinite(value) || type === 'boolean' ? value : null, truncated: state.truncated };
  }
  if (type === 'bigint') {
    return { value: String(value), truncated: state.truncated };
  }
  if (type === 'function' || type === 'symbol') {
    return { value: `[unserializable:${type}]`, truncated: state.truncated };
  }
  if (depth >= MAX_EVAL_RESULT_DEPTH) {
    state.truncated = true;
    return { value: '[truncated]', truncated: true };
  }
  if (state.seen.has(value)) {
    return { value: '[circular]', truncated: state.truncated };
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    const output = [];
    for (const item of value.slice(0, MAX_EVAL_RESULT_ITEMS)) {
      output.push(sanitizePageResult(item, state, depth + 1).value);
    }
    if (value.length > MAX_EVAL_RESULT_ITEMS) {
      state.truncated = true;
    }
    state.seen.delete(value);
    return { value: output, truncated: state.truncated };
  }
  const output = Object.create(null);
  let entryCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (entryCount >= MAX_EVAL_RESULT_ITEMS) {
      state.truncated = true;
      break;
    }
    entryCount += 1;
    const entryValue = value[key];
    const safeKey = String(key || '').slice(0, 200);
    if (SENSITIVE_KEY_PATTERN.test(safeKey)) {
      output[safeKey] = '[redacted]';
    } else {
      output[safeKey] = sanitizePageResult(entryValue, state, depth + 1).value;
    }
  }
  state.seen.delete(value);
  return { value: output, truncated: state.truncated };
}

function buildSelectorProbeScript(selector, { focus = false, clear = false } = {}) {
  return `
(() => {
  const selector = ${JSON.stringify(selector)};
  let element = null;
  try {
    element = document.querySelector(selector);
  } catch (error) {
    return { status: 'selector_miss', selector, reason: 'invalid_selector' };
  }
  if (!element) {
    return { status: 'selector_miss', selector, reason: 'selector_not_found' };
  }
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const hidden = (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.pointerEvents === 'none' ||
    Number(rect.width) <= 0 ||
    Number(rect.height) <= 0
  );
  if (hidden) {
    return { status: 'selector_hidden', selector, reason: 'selector_not_visible' };
  }
  if (${focus ? 'true' : 'false'}) {
    const tagName = String(element.tagName || '').toLowerCase();
    const inputType = String(element.type || '').toLowerCase();
    const nonTextInputTypes = new Set([
      'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range',
      'reset', 'submit'
    ]);
    const editable = element.isContentEditable
      || tagName === 'textarea'
      || (tagName === 'input' && !nonTextInputTypes.has(inputType));
    if (!editable || element.disabled === true || element.readOnly === true) {
      return { status: 'selector_not_editable', selector, reason: 'selector_not_editable' };
    }
    if (typeof element.focus === 'function') {
      element.focus({ preventScroll: true });
    }
    if (document.activeElement !== element) {
      return { status: 'selector_focus_failed', selector, reason: 'selector_focus_failed' };
    }
    if (${clear ? 'true' : 'false'}) {
      if ('value' in element) {
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element.isContentEditable) {
        element.textContent = '';
        const event = typeof InputEvent === 'function'
          ? new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })
          : new Event('input', { bubbles: true });
        element.dispatchEvent(event);
      }
    }
  }
  return {
    status: 'ready',
    selector,
    rect: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      center_x: rect.left + (rect.width / 2),
      center_y: rect.top + (rect.height / 2)
    }
  };
})()
`;
}

function buildEvalScript(script) {
  return `
(async () => {
  "use strict";
  const __jennyBrowserEval = async () => {
${script}
  };
  return await __jennyBrowserEval();
})()
`;
}

module.exports = {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  MAX_BROWSER_ACTION_TIMEOUT_MS,
  MAX_EVAL_SCRIPT_LENGTH,
  MAX_TYPE_TEXT_LENGTH,
  boundedPositiveInt,
  buildEvalScript,
  buildSelectorProbeScript,
  normalizeClickButton,
  normalizeSelector,
  safeBrowserReason,
  sanitizePageResult,
};
