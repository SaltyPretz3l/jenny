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
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  var PERSONALITY_HEADING = '## Personality';
  var PERSONALITY_PRECEDENCE_TEMPLATE = 'Your name is {name}. You are software, not a living being: '
    + 'you have no body, feelings, or consciousness, and you never claim otherwise. Personality shapes tone, not facts; '
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

  var LINT_MESSAGE = jt('personality.lint.unexpandedPlaceholders', '{{…}} placeholders aren’t expanded — the app already tells the model the date.');
  var OVERSIZED_MESSAGE = jt('personality.errors.fileTooLarge', 'This file is larger than 64 KiB. Open the folder to edit it.');

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

  // Keep the preview pipeline in lockstep with sidecar personality.sanitization.
  const PYTHON_WHITESPACE = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u; // eslint-disable-line no-control-regex -- Python str.split whitespace.
  const PYTHON_WORD_BOUNDARY = '(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))';

  function previewPattern(pattern) {
    let source = pattern.source.replace(/\[\\s\\S\]|\[\^\\s[^\]]*\]|\\s/g,
      token => token.startsWith('[') ? token.replace('\\s', '\\s\\u0085') : '[\\s\\u0085]');
    if (pattern.ignoreCase) source = source.replace(/[iI]/g, '[iI\\u0130\\u0131]')
      .replace(/\[A-Za-z/g, '[A-Za-z\\u0130\\u0131');
    return new RegExp(source.replace(/\\b/g, PYTHON_WORD_BOUNDARY), `${pattern.flags}u`);
  }

  const INJECTION_PATTERNS = [
    /<!--(?=[\s\S]{0,1000}?(?:ignore|disregard|reveal|system\s+prompt|developer\s+prompt|instructions?|exfiltrat|upload|send|post))[\s\S]*?-->/gi,
    /\b(?:base64|encode|zip|tar|cat|read|copy|extract)[\s\S]{0,120}\b(?:secret|token|password|api[_-]?key|credential|\.env|id_rsa|ssh|private\s+key)[\s\S]{0,160}\b(?:https?:\/\/|post|send|upload|exfiltrat|curl|wget)/gi,
    /ignore\s+all\s+previous\s+instructions/gi,
    /(?:ignore|disregard)\s+(?:all\s+)?(?:prior|previous|above)\s+(?:instructions|directives|rules)/gi,
    /ignore\s+the\s+system\s+prompt/gi,
    /reveal\s+(?:the\s+)?(?:system|developer)\s+prompt/gi,
    /act\s+as\s+system/gi,
    /pretend\s+to\s+be\s+(?:the\s+)?(?:system|developer)/gi,
    /\bdo\s+not\s+follow\s+the\s+rules\b/gi,
    /\byou\s+are\s+now\b/gi,
    /(?:new|updated|override)\s+instructions/gi,
    /(?:begin|start)\s+(?:a\s+)?new\s+(?:conversation|session)/gi,
    /(?:output|repeat|print)\s+(?:the\s+)?(?:above|previous|system)/gi,
    /\[(?:SYSTEM|USER|ASSISTANT)\]/g,
  ].map(previewPattern);
  const SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9]{8,}\b/g,
    /\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{16,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\b(api[_-]?key|api-key|authorization|token|secret|password|dsn)\s*[:=]\s*(?:Bearer\s+)?([^\s,;'"{}]+)/gi,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
    /\b(?:X-Amz-(?:Signature|Credential|Security-Token)|signature|sig)\s*[:=]\s*([^\s,;'"{}&]+)/gi,
    /\beyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_.+/=-]{8,}\b/g,
  ].map(previewPattern);
  const LANGUAGE_NAMES = {
    es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', 'pt-br': 'Brazilian Portuguese',
    nl: 'Dutch', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian', tr: 'Turkish', ar: 'Arabic',
    hi: 'Hindi', id: 'Indonesian', vi: 'Vietnamese', ja: 'Japanese', ko: 'Korean',
    'zh-cn': 'Simplified Chinese', 'zh-tw': 'Traditional Chinese',
  };

  function sanitizePersonalityPreview(value) {
    let text = Array.from(String(value || ''), char => /^[\uD800-\uDFFF]$/.test(char) ? '\ufffd' : char).join('')
      // eslint-disable-next-line no-control-regex -- Mirrors Python's bootstrap control-character removal.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/\r\n?/g, '\n').normalize('NFKC')
      .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
      .replace(previewPattern(/<\|(?:im_start|im_end|endoftext|system|user|assistant|tool_response|tool_call|eot_id|start_header_id|end_header_id|end|pad)\|>|<\|(?:tool_response|tool_call)>|\[\/?INST\]|<\/?s>|<(?:eos|bos|pad|end_of_turn|start_of_turn)>|<channel\|>|<\|channel\|>/gi), '[TOKEN_REDACTED]');
    for (const pattern of INJECTION_PATTERNS) text = text.replace(pattern, '[FILTERED_INSTRUCTION]');
    text = text.replace(previewPattern(/<!--\s*CACHE_BOUNDARY\s*-->/gi), '<!-- CACHE_BOUNDARY (escaped) -->')
      .replace(previewPattern(/<<\s*\/\s*SYS\s*>>/gi), '[SYS_CLOSE_ESCAPED]')
      .replace(previewPattern(/<<\s*SYS\s*>>/gi), '[SYS_OPEN_ESCAPED]');
    for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
    return text.replace(/^[\s\u0085]+|[\s\u0085]+$/g, '');
  }

  function promptAgentName(value) {
    if (typeof value !== 'string') return DEFAULT_AGENT_NAME;
    const normalized = value.split(PYTHON_WHITESPACE).filter(Boolean).join(' ');
    if (!normalized || sanitizePersonalityPreview(normalized) !== normalized) return DEFAULT_AGENT_NAME;
    const name = normalized.replace(/[^\p{L}\p{N} ._'-]/gu, ' ').trim().split(/\s+/u).join(' ');
    return Array.from(name).slice(0, 80).join('') || DEFAULT_AGENT_NAME;
  }

  function buildPrecedenceLine(agentName) {
    return PERSONALITY_PRECEDENCE_TEMPLATE.replace('{name}', promptAgentName(agentName));
  }

  /** Mirror of Electron message assembly. */
  function buildPersonalityMessage(agentName, content, { uiLanguage = 'en' } = {}) {
    var header = PERSONALITY_HEADING + '\n' + buildPrecedenceLine(agentName);
    const languageToken = typeof uiLanguage === 'string'
      ? uiLanguage.split(PYTHON_WHITESPACE).filter(Boolean).join(' ').toLowerCase().replace(/\u017f/g, 's') : '';
    const language = Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, languageToken) ? LANGUAGE_NAMES[languageToken] : '';
    if (language) header += `\nReply in ${language} unless the user writes in another language; then match the user's language.`;
    const body = sanitizePersonalityPreview(content);
    return body ? `${header}\n\n${body}` : header;
  }

  /**
   * Full `## Personality` message from RAW draft bodies: normalize each body
   * exactly once, then run the shared compile.
   */
  function buildCompiledText(bodies, budgets, { projectId = 'project_general', uiLanguage = 'en' } = {}) {
    var source = bodies && typeof bodies === 'object' ? bodies : {};
    var compiled = compileSections({
      personality: normalizeBody(source.personality),
      user: normalizeBody(source.user),
      memory: projectId === 'project_general' ? normalizeBody(source.memory) : '',
    }, budgets);
    return buildPersonalityMessage(source.agentName, compiled.content, { uiLanguage });
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
    var text = buildCompiledText(o.bodies, o.budgets, { projectId: o.projectId, uiLanguage: o.uiLanguage });
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
    return Number(value || 0).toLocaleString(globalThis.jennyI18n?.tag?.());
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
      text: over ? jt('personality.counter.overflow', '{used} / {limit} — the last {overflow} characters won’t be sent', { used: formatNumber(chars), limit: formatNumber(limit), overflow: formatNumber(overflow) }) : formatNumber(chars) + ' / ' + formatNumber(limit),
    };
  }

  function buildLintMessage(value) {
    return String(value == null ? '' : value).indexOf('{{') >= 0 ? LINT_MESSAGE : '';
  }

  function buildTokenLine(tokens) {
    return jt('personality.counter.tokenEstimate', 'Sent with every message · about {count} tokens', { count: formatNumber(Math.max(Number(tokens) || 0, 0)) });
  }

  function formatSavedAgo(deltaMs) {
    var delta = Number(deltaMs);
    if (!Number.isFinite(delta) || delta < 0) delta = 0;
    if (delta < 45000) return jt('personality.status.justNow', 'just now');
    if (delta < 3600000) return jtn('personality.status.minutesAgo', Math.max(Math.round(delta / 60000), 1), { count: Math.max(Math.round(delta / 60000), 1) }, '{count} min ago', '{count} min ago');
    if (delta < 86400000) return jtn('personality.status.hoursAgo', Math.max(Math.round(delta / 3600000), 1), { count: Math.max(Math.round(delta / 3600000), 1) }, '{count} hr ago', '{count} hr ago');
    return jt('personality.status.aWhileAgo', 'a while ago');
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
    if (source.dirty === true) return jt('personality.status.unsavedChangesShort', 'Unsaved changes');
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
    if (failed.length) return jt('personality.errors.writeFailed', '{prefix}could not write {files}.', { prefix: prefix, files: failed.join(', ') });
    return jt('personality.errors.changeNotAcknowledged', '{prefix}the change was not acknowledged.', { prefix: prefix });
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
    normalizeBody: normalizeBody,
    resolveCompiledPreview: resolveCompiledPreview,
    splitNotesBody: splitNotesBody,
    truncateUtf8: truncateUtf8,
    utf8Length: utf8Length,
  };
});
