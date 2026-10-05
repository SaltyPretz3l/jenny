'use strict';

/* services/tools/builtin/preview-test-evidence.js — what `preview_test` can
 * show as evidence beyond "loaded": per-event outcome lines, the optional
 * `observe` read-back, and the in-app Preview parity scan. The two page
 * scripts here are TOOL-OWNED and read-only; caller selectors reach them only
 * as JSON.stringify data, so the tool still never evaluates caller script.
 * Page-derived text (observed text, resource names) stays untrusted and is
 * redacted and bounded before it enters a result. */

const { safeBrowserReason } = require('../../browser-interaction-utils');

const MAX_OBSERVE_SELECTORS = 8;
const MAX_OBSERVE_SELECTOR_CHARS = 200;
// JSON-escaped selector payload ceiling: keeps the observe script well under
// the browser service's 10,000-character eval limit (control characters
// escape to six characters each).
const MAX_OBSERVE_ENCODED_CHARS = 4000;
const MAX_EVENT_SELECTOR_CHARS = 80;
const MAX_OBSERVED_TEXT_CHARS = 160;
const MAX_EXTERNAL_RESOURCES = 10;
const MAX_EXTERNAL_RESOURCE_CHARS = 120;
const EVENT_STATUS_EXPLANATIONS = Object.freeze({
  selector_miss: 'no element matched the selector',
  selector_hidden: 'the element is not visible or has no clickable area',
  selector_timeout: 'the selector probe timed out',
  selector_not_editable: 'the element is not a text input',
  selector_focus_failed: 'the element could not be focused',
});
const SUCCESSFUL_EVENT_STATUSES = new Set(['clicked', 'typed']);

// Tool-owned read-only scripts. Caller selectors are embedded only through
// JSON.stringify, so they are string data and never script text.
function buildObserveScript(selectors) {
  return `
const selectors = ${JSON.stringify(selectors)};
const clip = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim().slice(0, ${MAX_OBSERVED_TEXT_CHARS});
return selectors.map((selector) => {
  let nodes;
  try {
    nodes = document.querySelectorAll(selector);
  } catch (error) {
    return { invalid: true };
  }
  const count = nodes.length;
  if (!count) return { count: 0, visible: false, text: '' };
  const element = nodes[0];
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const visible = Boolean(element.isConnected)
    && rect.width > 0 && rect.height > 0
    && style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number(style.opacity) > 0;
  const tag = String(element.tagName || '').toUpperCase();
  const raw = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') ? element.value : element.innerText;
  return { count, visible, text: clip(raw) };
});
`;
}

function buildExternalResourcesScript() {
  return `
const isLocal = (value) => !/^\\s*(?:data|blob):/i.test(value);
const read = (selector, attribute) => Array.from(document.querySelectorAll(selector))
  .map((element) => element.getAttribute(attribute))
  .filter((value) => typeof value === 'string' && value.trim() && isLocal(value))
  .map((value) => value.trim().slice(0, ${MAX_EXTERNAL_RESOURCE_CHARS}))
  .slice(0, ${MAX_EXTERNAL_RESOURCES});
return {
  scripts: read('script[src]', 'src'),
  stylesheets: read('link[rel~="stylesheet" i][href]', 'href'),
  media: read('img[src], iframe[src], audio[src], video[src], source[src]', 'src'),
};
`;
}

function boundedEventSelector(selector) {
  return String(selector ?? '').split(/\s+/).join(' ').trim().slice(0, MAX_EVENT_SELECTOR_CHARS);
}

function eventOutcomeLine(eventResults) {
  const parts = eventResults.map((entry, index) => {
    const explanation = EVENT_STATUS_EXPLANATIONS[entry.status];
    const status = entry.status || 'no_result';
    return `${index + 1}. ${entry.action} ${JSON.stringify(entry.selector)} → ${status}${explanation ? ` (${explanation})` : ''}`;
  });
  return `Events: ${parts.join('; ')}.`;
}

function pluralize(count, noun, plural = `${noun}s`) {
  return `${count} ${count === 1 ? noun : plural}`;
}

function joinWords(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function externalResourcesLine(resources) {
  const counts = [
    [resources.scripts.length, 'script', 'scripts there never run'],
    [resources.stylesheets.length, 'stylesheet', 'styles are missing'],
    [resources.media.length, 'media file', 'media does not load'],
  ].filter(([count]) => count > 0);
  const phrases = counts.map(([count, noun], index) => (
    index === 0 ? pluralize(count, `external ${noun}`, `external ${noun}s`) : pluralize(count, noun)
  ));
  const names = [...resources.scripts, ...resources.stylesheets, ...resources.media].slice(0, MAX_EXTERNAL_RESOURCES);
  return `In-app preview parity: this page references ${joinWords(phrases)} (names are untrusted page text: ${names.join(', ')}). preview_test loads contained workspace files (never the network), but Jenny's in-app Preview is self-contained and loads no external files at all, so ${joinWords(counts.map(([, , effect]) => effect))}. Inline them into the HTML if the user will view it in the in-app Preview.`;
}

function observationLine(selector, entry) {
  const name = JSON.stringify(selector);
  if (entry.invalid) return `- ${name}: invalid selector`;
  if (!entry.count) return `- ${name}: no match`;
  // Hidden text is not what the user sees; metadata keeps it for debugging.
  const text = entry.visible && entry.text ? `, text ${JSON.stringify(entry.text)}` : '';
  return `- ${name}: ${pluralize(entry.count, 'match', 'matches')}, ${entry.visible ? 'visible' : 'hidden'}${text}`;
}

function stripSensitiveValues(text, sensitiveValues) {
  let result = String(text ?? '');
  for (const sensitiveValue of sensitiveValues || []) {
    const candidate = String(sensitiveValue || '').trim();
    if (!candidate) continue;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), '[workspace path]');
  }
  return result;
}

function redactKnownPaths(value, sensitiveValues) {
  const flattened = safeBrowserReason(value, 'preview_probe_failed').split(/\s+/).join(' ');
  return stripSensitiveValues(flattened, sensitiveValues).slice(0, 500);
}

// The optional observe list: 1-8 trimmed selectors, bounded per entry and in
// JSON-encoded total so the tool-owned script stays far below the eval limit.
function normalizeObserveInput(rawObserve) {
  if (rawObserve === undefined) return { ok: true, observe: [] };
  const valid = Array.isArray(rawObserve)
    && rawObserve.length >= 1
    && rawObserve.length <= MAX_OBSERVE_SELECTORS
    && rawObserve.every((entry) => (
      typeof entry === 'string'
      && entry.trim().length >= 1
      && entry.trim().length <= MAX_OBSERVE_SELECTOR_CHARS
    ))
    && JSON.stringify(rawObserve.map((entry) => entry.trim())).length <= MAX_OBSERVE_ENCODED_CHARS;
  return valid
    ? { ok: true, observe: rawObserve.map((entry) => entry.trim()) }
    : {
      ok: false,
      message: `observe must be an array of 1-${MAX_OBSERVE_SELECTORS} CSS selector strings of 1-${MAX_OBSERVE_SELECTOR_CHARS} characters (${MAX_OBSERVE_ENCODED_CHARS} characters in total once JSON-encoded).`,
    };
}

async function evalToolScript(service, sessionId, script) {
  if (typeof service.eval !== 'function') return { reason: 'Page observation is unavailable.' };
  const result = await service.eval(sessionId, { script });
  return result?.status === 'evaluated' ? { value: result.result } : { reason: result?.reason };
}

async function observeSelectors(service, sessionId, selectors, sensitiveValues) {
  let outcome;
  try {
    outcome = await evalToolScript(service, sessionId, buildObserveScript(selectors));
  } catch (error) {
    outcome = { reason: error?.message || error };
  }
  if (!Array.isArray(outcome.value) || outcome.value.length !== selectors.length) {
    return { error: redactKnownPaths(outcome.reason, sensitiveValues).slice(0, 200) };
  }
  return {
    entries: outcome.value.map((raw) => {
      if (raw?.invalid === true) {
        return { count: 0, visible: false, text: '', invalid: true };
      }
      const count = Number.isInteger(raw?.count) && raw.count > 0 ? raw.count : 0;
      const text = stripSensitiveValues(String(raw?.text ?? ''), sensitiveValues)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_OBSERVED_TEXT_CHARS);
      return { count, visible: count > 0 && raw?.visible === true, text: count > 0 ? text : '' };
    }),
  };
}

async function collectExternalResources(service, sessionId, sensitiveValues) {
  try {
    const { value } = await evalToolScript(service, sessionId, buildExternalResourcesScript());
    const collect = (list) => (Array.isArray(list) ? list : [])
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .slice(0, MAX_EXTERNAL_RESOURCES)
      .map((entry) => redactKnownPaths(entry, sensitiveValues).slice(0, MAX_EXTERNAL_RESOURCE_CHARS));
    const resources = {
      scripts: collect(value?.scripts),
      stylesheets: collect(value?.stylesheets),
      media: collect(value?.media),
    };
    return resources.scripts.length || resources.stylesheets.length || resources.media.length
      ? resources
      : null;
  } catch (_error) {
    return null;
  }
}

// "1 of 2" counts only events that took effect; "0" when none ran.
function appliedEventsText(eventResults) {
  if (!eventResults.length) return '0';
  const applied = eventResults.filter((entry) => SUCCESSFUL_EVENT_STATUSES.has(entry.status)).length;
  return `${applied} of ${eventResults.length}`;
}

function observationLines(observe, observed) {
  if (!observed) return [];
  if (observed.error) return [`Observation unavailable: ${observed.error}`];
  return [
    'Observed after events (untrusted page text):',
    ...observed.entries.map((entry, index) => observationLine(observe[index], entry)),
  ];
}

function observationMetadata(observe, observed) {
  if (!observed) return {};
  if (observed.error) return { observation_error: observed.error };
  return {
    observations: observed.entries.map((entry, index) => ({ selector: observe[index], ...entry })),
  };
}

module.exports = {
  appliedEventsText,
  boundedEventSelector,
  collectExternalResources,
  eventOutcomeLine,
  externalResourcesLine,
  normalizeObserveInput,
  observationLines,
  observationMetadata,
  observeSelectors,
  redactKnownPaths,
  stripSensitiveValues,
};
