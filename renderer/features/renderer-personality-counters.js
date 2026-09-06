/**
 * renderer/features/renderer-personality-counters.js
 *
 * Pure helpers for the Personality / Long-term notes editors: body
 * normalization, per-section budgets and clipping, the compiled-block preview,
 * the token estimate and the status line.
 *
 * PARITY CONTRACT: `normalizeBody`, `clipToBudget`, `truncateUtf8` and
 * `compileSections` must produce byte-identical output to
 * `services/personality-workspace-compile.js` for every input. Electron is the
 * oracle and `tests/personality-normalize-parity.test.js` requires both modules
 * and diffs them. The Settings preview claims to be the exact request
 * contribution, and a drifted copy would make that claim a lie the way the v2
 * preview did — so every algorithm below is ported line for line, with
 * `Buffer.byteLength` swapped for `TextEncoder` (the renderer has no Buffer).
 *
 * The editor shows the RAW file body (minus leading frontmatter) so a
 * load/save round trip preserves comments and headings; every counter and the
 * preview normalize it first, because normalized chars are what get sent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPersonalityCounters = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PERSONALITY_HEADING = '## Personality';
  var PERSONALITY_PRECEDENCE_TEMPLATE = 'Your name is {name}. Personality shapes tone, not facts; '
    + 'the current request and the runtime, workspace, and tool instructions take precedence over everything below.';
  var DEFAULT_AGENT_NAME = 'Jenny';

  var ADVANCED_CONTEXT_MAX_BYTES = 4 * 1024;
  var CLIP_MARKER = ' […]';
  var SECTION_SEPARATOR = '\n\n';

  /* Compile order is Voice -> About the user -> Notes. */
  var SECTION_ORDER = ['personality', 'user', 'memory'];
  var SECTION_HEADINGS = {
    personality: '### Voice',
    user: '### About the user',
    memory: '### Notes',
  };
  var SECTION_BUDGETS = { personality: 1500, user: 1000, memory: 1500 };

  var LINT_MESSAGE = '{{…}} placeholders aren’t expanded — the app already tells the model the date.';
  var OVERSIZED_MESSAGE = 'This file is larger than 64 KiB. Open the folder to edit it.';

  var FRONTMATTER_PATTERN = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
  var H1_PATTERN = /^#[ \t]+[^\r\n]*(?:\r?\n|$)/;
  var HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
  /* An unterminated `<!--` is a comment to end-of-text as far as every markdown
     renderer is concerned; treating it as literal text would leak a
     half-written aside straight into the prompt. */
  var UNTERMINATED_COMMENT_PATTERN = /<!--[\s\S]*$/;

  /* ── UTF-8 measurement (Electron uses Buffer; the renderer cannot) ─────── */

  var utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function utf8Length(value) {
    var text = String(value == null ? '' : value);
    if (utf8Encoder) return utf8Encoder.encode(text).length;
    var bytes = 0;
    for (var i = 0; i < text.length; i += 1) {
      var code = text.codePointAt(i);
      if (code > 0xffff) { bytes += 4; i += 1; } else if (code > 0x7ff) { bytes += 3; } else if (code > 0x7f) { bytes += 2; } else { bytes += 1; }
    }
    return bytes;
  }

  var CLIP_MARKER_BYTES = utf8Length(CLIP_MARKER);
  var SECTION_SEPARATOR_BYTES = utf8Length(SECTION_SEPARATOR);

  /* ── Normalization (mirror of Electron `normalizeBody`) ───────────────── */

  function stripLeadingMatch(text, pattern) {
    var match = text.match(pattern);
    return match ? text.slice(match[0].length) : text;
  }

  function stripBom(value) {
    var text = String(value == null ? '' : value);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  /**
   * Normalize a workspace file into the body the model actually receives.
   * Step order mirrors Electron exactly; legacy USER.md files carry the H1
   * *before* the frontmatter, so the frontmatter strip runs on both sides of
   * the H1 strip.
   *
   * NOT idempotent (a second pass eats a second H1) — normalize raw text once,
   * never normalize an already-normalized body.
   */
  function normalizeBody(content) {
    var text = stripBom(content).replace(/\r\n/g, '\n').replace(/^\s+/, '');
    text = stripLeadingMatch(text, FRONTMATTER_PATTERN).replace(/^\s+/, '');
    text = text
      .replace(HTML_COMMENT_PATTERN, '')
      .replace(UNTERMINATED_COMMENT_PATTERN, '')
      .replace(/^\s+/, '');
    text = stripLeadingMatch(text, H1_PATTERN).replace(/^\s+/, '');
    text = stripLeadingMatch(text, FRONTMATTER_PATTERN);
    return text.trim();
  }

  function countChars(value) {
    return normalizeBody(value).length;
  }

  /* ── Budgets (mirrors of Electron `clipToBudget` / `truncateUtf8`) ─────── */

  /**
   * Clip one ALREADY-NORMALIZED body to its char budget, never splitting a
   * surrogate pair. Slices UTF-16 code units exactly like Electron does.
   */
  function clipToBudget(body, budget) {
    var text = String(body || '');
    var limit = Number.isSafeInteger(budget) && budget > 0 ? budget : 0;
    if (text.length <= limit) return { text: text, clipped: false, overflow: 0 };
    var kept = text.slice(0, Math.max(limit - CLIP_MARKER.length, 0));
    if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
    return { text: kept + CLIP_MARKER, clipped: true, overflow: text.length - limit };
  }

  function truncateUtf8(value, maxBytes, suffix) {
    var source = String(value || '');
    var marker = suffix === undefined ? CLIP_MARKER : suffix;
    if (utf8Length(source) <= maxBytes) return source;
    var contentLimit = Math.max(maxBytes - utf8Length(marker), 0);
    var result = '';
    var used = 0;
    var characters = Array.from(source);
    for (var i = 0; i < characters.length; i += 1) {
      var size = utf8Length(characters[i]);
      if (used + size > contentLimit) break;
      result += characters[i];
      used += size;
    }
    return result + marker;
  }

  function resolveBudget(budgets, id) {
    return budgets && Number.isSafeInteger(budgets[id]) ? budgets[id] : SECTION_BUDGETS[id];
  }

  /**
   * Compile the wire content from ALREADY-NORMALIZED bodies. Mirror of
   * Electron's `compilePersonalitySections`: per-section char budgets first,
   * then a shared 4 KiB UTF-8 backstop applied PER SECTION with every heading
   * (and a later section's marker) reserved up front, so a huge Voice can never
   * make `### Notes` vanish from the wire while the counters read green.
   */
  function compileSections(bodies, budgets, maxBytes) {
    var source = bodies && typeof bodies === 'object' ? bodies : {};
    var cap = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : ADVANCED_CONTEXT_MAX_BYTES;
    var participating = [];
    for (var i = 0; i < SECTION_ORDER.length; i += 1) {
      var id = SECTION_ORDER[i];
      var body = String(source[id] || '');
      if (!body) continue;
      var budget = resolveBudget(budgets, id);
      var clip = clipToBudget(body, budget);
      participating.push({
        id: id, heading: SECTION_HEADINGS[id], body: body, budget: budget,
        text: clip.text, clipped: clip.clipped,
      });
    }
    if (!participating.length) return { content: '', sections: [], backstopClipped: false };

    var overheadBytes = SECTION_SEPARATOR_BYTES * (participating.length - 1);
    for (var h = 0; h < participating.length; h += 1) {
      overheadBytes += utf8Length(participating[h].heading + SECTION_SEPARATOR);
    }
    var bodyBudgetBytes = Math.max(cap - overheadBytes, 0);

    var sections = [];
    var rendered = [];
    var usedBytes = 0;
    var backstopClipped = false;
    for (var index = 0; index < participating.length; index += 1) {
      var entry = participating[index];
      var reservedForLater = CLIP_MARKER_BYTES * (participating.length - index - 1);
      var allowedBytes = Math.max(bodyBudgetBytes - usedBytes - reservedForLater, 0);
      var text = entry.text;
      var clipped = entry.clipped;
      if (utf8Length(text) > allowedBytes) {
        text = truncateUtf8(text, allowedBytes, CLIP_MARKER);
        clipped = true;
        backstopClipped = true;
      }
      usedBytes += utf8Length(text);
      sections.push({ id: entry.id, chars: entry.body.length, budget: entry.budget, clipped: clipped });
      rendered.push(entry.heading + SECTION_SEPARATOR + text);
    }

    var joined = rendered.join(SECTION_SEPARATOR);
    var content = truncateUtf8(joined, cap, CLIP_MARKER);
    return {
      content: content,
      sections: sections,
      backstopClipped: backstopClipped || content !== joined,
    };
  }

  /* ── Message assembly ─────────────────────────────────────────────────── */

  function normalizeAgentName(value) {
    return String(value == null ? '' : value).trim() || DEFAULT_AGENT_NAME;
  }

  function buildPrecedenceLine(agentName) {
    return PERSONALITY_PRECEDENCE_TEMPLATE.replace('{name}', normalizeAgentName(agentName));
  }

  /** Mirror of Electron's `buildPersonalityMessage`. */
  function buildPersonalityMessage(agentName, content) {
    var header = PERSONALITY_HEADING + '\n' + buildPrecedenceLine(agentName);
    var body = String(content || '').trim();
    return body ? header + '\n\n' + body : header;
  }

  /**
   * Full `## Personality` message from RAW draft bodies: normalize each body
   * exactly once, then run the shared compile.
   */
  function buildCompiledText(bodies, budgets) {
    var source = bodies && typeof bodies === 'object' ? bodies : {};
    var compiled = compileSections({
      personality: normalizeBody(source.personality),
      user: normalizeBody(source.user),
      memory: normalizeBody(source.memory),
    }, budgets);
    return buildPersonalityMessage(source.agentName, compiled.content);
  }

  function estimateTokens(value) {
    var chars = typeof value === 'number' ? value : String(value == null ? '' : value).length;
    return Math.ceil(Math.max(chars, 0) / 4);
  }

  /**
   * The preview the Settings footer shows. While the draft is clean the
   * service's own compiled block is authoritative — it is the exact string the
   * turn sends, so quote it verbatim. Only a dirty draft needs a local
   * recompute, and that uses the same literals, budgets and backstop.
   * @returns {{text: string, tokens: number}}
   */
  function resolveCompiledPreview(options) {
    var o = options || {};
    var stored = o.compiled && typeof o.compiled === 'object' ? o.compiled : {};
    var storedText = String(stored.text || '');
    var storedTokens = Number(stored.tokensEstimate);
    if (o.dirty !== true && storedText) {
      return {
        text: storedText,
        tokens: Number.isFinite(storedTokens) && storedTokens > 0
          ? storedTokens
          : estimateTokens(storedText),
      };
    }
    var text = buildCompiledText(o.bodies, o.budgets);
    return { text: text, tokens: estimateTokens(text) };
  }

  /**
   * Recover the Notes body out of a compiled block so the live preview can be
   * rebuilt from the Personality drafts without a second IPC call for
   * MEMORY.md. Safe because Electron emits the same `### Notes` literal.
   */
  function splitNotesBody(compiledText) {
    var text = String(compiledText == null ? '' : compiledText);
    var heading = SECTION_HEADINGS.memory + SECTION_SEPARATOR;
    var index = text.lastIndexOf(SECTION_SEPARATOR + heading);
    if (index >= 0) return text.slice(index + SECTION_SEPARATOR.length + heading.length);
    if (text.indexOf(heading) === 0) return text.slice(heading.length);
    return '';
  }

  /* ── Presentation models ──────────────────────────────────────────────── */

  function formatNumber(value) {
    return Number(value || 0).toLocaleString('en-US');
  }

  /**
   * Counter model for one textarea. Counts the NORMALIZED body — what is
   * actually sent — not the raw characters the textarea holds.
   */
  function buildCounterModel(value, budget) {
    var limit = Number.isSafeInteger(budget) && budget > 0 ? budget : 0;
    var chars = countChars(value);
    var over = limit > 0 && chars > limit;
    var overflow = over ? chars - limit : 0;
    return {
      chars: chars,
      budget: limit,
      over: over,
      overflow: overflow,
      text: formatNumber(chars) + ' / ' + formatNumber(limit)
        + (over ? ' — the last ' + formatNumber(overflow) + ' characters won’t be sent' : ''),
    };
  }

  function buildLintMessage(value) {
    return String(value == null ? '' : value).indexOf('{{') >= 0 ? LINT_MESSAGE : '';
  }

  function buildTokenLine(tokens) {
    return 'Sent with every message · about ' + formatNumber(Math.max(Number(tokens) || 0, 0)) + ' tokens';
  }

  function formatSavedAgo(deltaMs) {
    var delta = Number(deltaMs);
    if (!Number.isFinite(delta) || delta < 0) delta = 0;
    if (delta < 45000) return 'just now';
    if (delta < 3600000) return Math.max(Math.round(delta / 60000), 1) + ' min ago';
    if (delta < 86400000) return Math.max(Math.round(delta / 3600000), 1) + ' hr ago';
    return 'a while ago';
  }

  /**
   * Status-line precedence: action message > load message > dirty > saved/ready.
   * One line, aria-live, no badge and no separate "Loading" chrome.
   */
  function buildPersonalityStatusLine(state) {
    var source = state && typeof state === 'object' ? state : {};
    var actionStatus = String(source.actionStatus || '').trim();
    if (actionStatus) return actionStatus;
    var loadStatus = String(source.loadStatus || '').trim();
    if (loadStatus) return loadStatus;
    if (source.loading === true) return 'Loading…';
    if (source.dirty === true) return 'Unsaved changes';
    var savedAt = Number(source.savedAt || 0);
    if (savedAt > 0) {
      var now = Number(source.now || 0) || Date.now();
      return 'Saved · ' + formatSavedAgo(now - savedAt);
    }
    return 'Ready';
  }

  /**
   * Failure copy for a rejected save/clear. The error code is surfaced so a bug
   * report carries it; the oversized case gets the actionable sentence instead
   * of a section list, because there is no in-UI fix for it.
   */
  function buildSaveFailureMessage(result, verb) {
    var source = result && typeof result === 'object' ? result : {};
    var code = String(source.code || '').trim();
    var prefix = String(verb || 'Save') + ' failed' + (code ? ' (' + code + ')' : '') + ': ';
    if (code === 'CMP-PERS-0002') return prefix + OVERSIZED_MESSAGE;
    var failed = Array.isArray(source.failed)
      ? source.failed.map(function (entry) { return String(entry || ''); }).filter(Boolean)
      : [];
    if (failed.length) return prefix + 'could not write ' + failed.join(', ') + '.';
    return prefix + 'the change was not acknowledged.';
  }

  return {
    ADVANCED_CONTEXT_MAX_BYTES: ADVANCED_CONTEXT_MAX_BYTES,
    CLIP_MARKER: CLIP_MARKER,
    CLIP_MARKER_BYTES: CLIP_MARKER_BYTES,
    DEFAULT_AGENT_NAME: DEFAULT_AGENT_NAME,
    LINT_MESSAGE: LINT_MESSAGE,
    OVERSIZED_MESSAGE: OVERSIZED_MESSAGE,
    PERSONALITY_HEADING: PERSONALITY_HEADING,
    PERSONALITY_PRECEDENCE_TEMPLATE: PERSONALITY_PRECEDENCE_TEMPLATE,
    SECTION_BUDGETS: SECTION_BUDGETS,
    SECTION_HEADINGS: SECTION_HEADINGS,
    SECTION_ORDER: SECTION_ORDER,
    buildCompiledText: buildCompiledText,
    buildCounterModel: buildCounterModel,
    buildLintMessage: buildLintMessage,
    buildPersonalityMessage: buildPersonalityMessage,
    buildPersonalityStatusLine: buildPersonalityStatusLine,
    buildPrecedenceLine: buildPrecedenceLine,
    buildSaveFailureMessage: buildSaveFailureMessage,
    buildTokenLine: buildTokenLine,
    clipToBudget: clipToBudget,
    compileSections: compileSections,
    countChars: countChars,
    estimateTokens: estimateTokens,
    formatNumber: formatNumber,
    formatSavedAgo: formatSavedAgo,
    normalizeAgentName: normalizeAgentName,
    normalizeBody: normalizeBody,
    resolveCompiledPreview: resolveCompiledPreview,
    splitNotesBody: splitNotesBody,
    truncateUtf8: truncateUtf8,
    utf8Length: utf8Length,
  };
});
