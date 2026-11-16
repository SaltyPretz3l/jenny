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
const MAX_OBSERVED_TEXT_CHARS = 600;
// Longer text keeps its beginning and its end: a diagnostic line puts the
// verdict last, so a plain prefix clip would hide it.
const OBSERVED_HEAD_CHARS = 150;
const OBSERVED_TAIL_CHARS = 440;
// Extra characters sent past each cut, so a workspace path that straddles a cut
// is redacted whole before the host trims to the head and tail sizes.
const OBSERVED_REDACTION_MARGIN = 256;
const MAX_BLOCKED_HOSTS = 4;
const MAX_EXTERNAL_RESOURCES = 10;
const MAX_EXTERNAL_RESOURCE_CHARS = 120;
const EVENT_STATUS_EXPLANATIONS = Object.freeze({
  selector_miss: 'no element matched the selector',
  selector_hidden: 'the element is not visible or has no clickable area',
  selector_timeout: 'the selector probe timed out',
  selector_not_editable: 'the element is not a text input',
  selector_focus_failed: 'the element could not be focused',
  selector_not_focusable: 'the element cannot take focus',
  error: 'the browser could not run this interaction',
});
const SUCCESSFUL_EVENT_STATUSES = new Set(['clicked', 'typed', 'hovered', 'focused', 'pressed']);

// Tool-owned read-only scripts. Caller selectors are embedded only through
// JSON.stringify, so they are string data and never script text.
function buildObserveScript(selectors) {
  return `
const selectors = ${JSON.stringify(selectors)};
const clip = (value) => {
  const text = String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  return text.length <= ${MAX_OBSERVED_TEXT_CHARS}
    ? { text }
    : { head: text.slice(0, ${OBSERVED_HEAD_CHARS + OBSERVED_REDACTION_MARGIN}), tail: text.slice(-${OBSERVED_TAIL_CHARS + OBSERVED_REDACTION_MARGIN}), total: text.length };
};
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
  return Object.assign({ count, visible }, clip(raw));
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
    const target = [entry.key, entry.selector ? JSON.stringify(entry.selector) : ''].filter(Boolean).join(' ');
    return `${index + 1}. ${entry.action}${target ? ` ${target}` : ''} → ${status}${explanation ? ` (${explanation})` : ''}`;
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
  const hosts = blockedHosts(names);
  const blocked = hosts.length ? ` Blocked: ${hosts.join(', ')}.` : '';
  return `In-app preview parity: this page references ${joinWords(phrases)} (names are untrusted page text: ${names.join(', ')}). preview_test loads contained workspace files (never the network), but Jenny's in-app Preview is self-contained and loads no external files at all, so ${joinWords(counts.map(([, , effect]) => effect))}. Inline them into the HTML if the user will view it in the in-app Preview.${blocked}`;
}

// Unique lower-cased hostnames of the http(s) names; relative and
// protocol-relative names do not parse and are skipped.
function blockedHosts(names) {
  const hosts = new Set();
  for (const name of names) {
    try {
      const url = new URL(name);
      if (url.protocol === 'http:' || url.protocol === 'https:') hosts.add(url.hostname.toLowerCase());
    } catch (_error) {
      // Not an absolute URL.
    }
  }
  return [...hosts].slice(0, MAX_BLOCKED_HOSTS);
}

// The already-bounded error texts as a block the model can read. Uncaught page
// errors come first: ten 404s in the console must not hide the one SyntaxError.
// `totalCount` is every error seen, listed or not.
function errorTextLines(consoleErrors, pageErrors, totalCount, limit) {
  const listed = [
    ...pageErrors.map((text) => `- page: ${text}`),
    ...consoleErrors.map((text) => `- console: ${text}`),
  ].slice(0, limit);
  if (!listed.length) return [];
  const lines = ['Errors (untrusted page text):', ...listed];
  if (totalCount > listed.length) lines.push(`- (${totalCount - listed.length} more not shown)`);
  return lines;
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

const flattenText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// Pure: text over the cap keeps its first OBSERVED_HEAD_CHARS and last
// OBSERVED_TAIL_CHARS around a marker that states how many characters went.
function clipObservedText(text) {
  const flat = flattenText(text);
  if (flat.length <= MAX_OBSERVED_TEXT_CHARS) return flat;
  const omitted = flat.length - OBSERVED_HEAD_CHARS - OBSERVED_TAIL_CHARS;
  return `${flat.slice(0, OBSERVED_HEAD_CHARS)} [... ${omitted} chars omitted ...] ${flat.slice(-OBSERVED_TAIL_CHARS)}`;
}

// The in-page script sends whole text up to the cap, or a margin-extended head
// and tail plus the full length beyond it; either way what crosses back stays
// bounded. Each piece is redacted before it is cut to size.
function observedText(raw, sensitiveValues) {
  if (typeof raw?.head === 'string' && typeof raw?.tail === 'string') {
    const head = flattenText(stripSensitiveValues(raw.head.slice(0, OBSERVED_HEAD_CHARS + OBSERVED_REDACTION_MARGIN), sensitiveValues))
      .slice(0, OBSERVED_HEAD_CHARS);
    const tail = flattenText(stripSensitiveValues(raw.tail.slice(-(OBSERVED_TAIL_CHARS + OBSERVED_REDACTION_MARGIN)), sensitiveValues))
      .slice(-OBSERVED_TAIL_CHARS);
    const total = Number.isFinite(raw.total) ? raw.total : head.length + tail.length;
    const omitted = Math.max(0, total - OBSERVED_HEAD_CHARS - OBSERVED_TAIL_CHARS);
    return `${head} [... ${omitted} chars omitted ...] ${tail}`;
  }
  return clipObservedText(stripSensitiveValues(String(raw?.text ?? '').slice(0, 4 * MAX_OBSERVED_TEXT_CHARS), sensitiveValues));
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
      const text = observedText(raw, sensitiveValues);
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
  clipObservedText,
  collectExternalResources,
  errorTextLines,
  eventOutcomeLine,
  externalResourcesLine,
  normalizeObserveInput,
  observationLines,
  observationMetadata,
  observeSelectors,
  redactKnownPaths,
  stripSensitiveValues,
};
