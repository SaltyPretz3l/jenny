/* renderer/shared/string-utils.js – shared string normalization helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.stringUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Heading / bullet / ordered / quote markers that open a line. */
  var LEADING_BLOCK_MARKER_RE = /^[ \t]*(?:#{1,6}\s+|[-*+>]\s+|\d+\.\s+)/gmu;
  var WHOLE_LABEL_DUNDER_RE = /^__([^_](?:.*[^_])?)__$/u;
  /* Single-marker emphasis unwraps ONLY when it spans the whole label
   * (mirrors the dunder rule): interior single markers are
   * identifier-shaped (snake_case, *args) and must survive. */
  var WHOLE_LABEL_EMPHASIS_RE = /^(?:\*([^*](?:.*[^*])?)\*|_([^_](?:.*[^_])?)_)$/u;
  /* Link destinations may carry ONE level of balanced parentheses
   * (wiki URLs like /Array_(data_structure)). */
  var LINK_RE = /\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g;

  /**
   * Coerce any value to a trimmed string.
   * Null / undefined → '', numbers → their string form, etc.
   */
  function normalizeString(value) {
    return String(value || '').trim();
  }

  /**
   * Semantic alias for normalizing identifier fields (session IDs, call IDs, etc.).
   */
  function normalizeId(value) {
    return String(value || '').trim();
  }

  /**
   * Escape the five XML special characters so a string can be safely
   * interpolated into HTML markup. Use this anywhere user-provided or
   * model-provided text is concatenated into an innerHTML payload.
   */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Escape regex metacharacters so a runtime string can be embedded as
   * a literal in `new RegExp(...)`.
   */
  function escapeRegExp(value) {
    return String(value || '').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }

  /**
   * Coerce a value to a [A-Za-z0-9_-] token, falling back to the
   * provided default if the input contains anything else. Use for
   * identifiers that flow into DOM ids / class names where a malformed
   * input could break selectors.
   */
  function sanitizeToken(value, fallback) {
    var normalized = String(value || '').trim();
    return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : fallback;
  }

  /**
   * Flatten markdown decoration out of a one-line label — a reasoning row
   * header, a home-panel loop title — without mangling literal identifiers.
   * Deliberately conservative: only paired `**…**` / backtick spans and a
   * whole-label `__…__` wrap are unwrapped, so snake_case, `__init__.py`,
   * `**kwargs` and other unpaired markers pass through untouched. Link
   * syntax collapses to its text, a leading block marker is dropped from
   * each line, and whitespace runs collapse so the result is one display
   * line. (A label that IS a bare dunder, e.g. exactly `__init__`, does
   * unwrap — an accepted non-case for titles.)
   */
  function stripInlineMarkdownLabel(value) {
    var label = String(value == null ? '' : value).trim();
    if (!label) {
      return '';
    }
    label = label.replace(LINK_RE, '$1');
    label = label.replace(LEADING_BLOCK_MARKER_RE, '');
    var previous;
    do {
      previous = label;
      label = label
        .replace(/\*\*([^*\n]+)\*\*/gu, '$1')
        .replace(/`([^`\n]+)`/gu, '$1');
    } while (label !== previous);
    var wholeDunder = label.match(WHOLE_LABEL_DUNDER_RE);
    if (wholeDunder) {
      label = wholeDunder[1];
    }
    var wholeEmphasis = label.match(WHOLE_LABEL_EMPHASIS_RE);
    if (wholeEmphasis) {
      label = wholeEmphasis[1] != null ? wholeEmphasis[1] : wholeEmphasis[2];
    }
    return label.replace(/\s+/gu, ' ').trim();
  }

  /* Linked-session recall (services/backend/linked-session-recall.js) reads at
   * most LINKED_RECALL_LIMIT linked chats: each counted once, in the active
   * chat's project (no project matches no project), newest first. The rail's
   * link popover marks exactly this set as "Used for recall". */
  var LINKED_RECALL_LIMIT = 3;
  function projectKey(summary) {
    return summary && summary.project_id != null ? String(summary.project_id) : '';
  }
  function selectLinkedRecallSessions(activeSummary, linkedIds, getSummary) {
    var project = projectKey(activeSummary);
    var ids = Array.from(new Set(Array.from(linkedIds || [], function (id) { return String(id || '').trim(); })));
    return ids.filter(Boolean)
      .map(function (id) { return getSummary(id); })
      .filter(function (entry) { return entry && projectKey(entry) === project; })
      .sort(function (left, right) { return String(right.updated_at || '').localeCompare(String(left.updated_at || '')); })
      .slice(0, LINKED_RECALL_LIMIT);
  }

  /* Resolved per call: the backend requires this module without a translator. */
  function jt(key, fallback) {
    var i18n = globalThis.jennyI18n;
    return i18n && typeof i18n.t === 'function' ? i18n.t(key, fallback) : fallback;
  }

  /** The one place a stored default title becomes its display label. */
  function resolveDefaultTitle(title) {
    var value = String(title || '').trim();
    if (value === 'New Plugin Session') return jt('session.defaultTitle.plugin', 'New Plugin Session');
    return !value || value === 'New Chat' ? jt('session.defaultTitle.chat', 'New Chat') : String(title);
  }

  /* Session default titles: one rule for the renderer auto-title and the
   * backend send preflight (services/backend/managed-sidecar-session-preflight.js
   * requires this module). No model inference. */
  var SESSION_TITLE_MAX_LENGTH = 48;
  var LEADING_SLASH_COMMAND_RE = /^\/[\w:-]+(?:\s+|$)/;
  /* Common greetings per UI locale; a title drops one leading greeting in
   * any of them, whatever the UI language, since people write in their own. */
  var GREETINGS_BY_LOCALE = {
    en: ['hi', 'hello', 'hey'],
    es: ['hola', 'buenas'],
    fr: ['bonjour', 'salut', 'coucou'],
    de: ['hallo', 'hi', 'servus'],
    it: ['ciao', 'salve'],
    'pt-BR': ['oi', 'olá', 'ola'],
    nl: ['hoi', 'hallo', 'hey'],
    pl: ['cześć', 'hej', 'witaj'],
    ru: ['привет', 'здравствуй', 'здравствуйте'],
    uk: ['привіт', 'вітаю'],
    tr: ['merhaba', 'selam'],
    ar: ['مرحبا', 'مرحباً', 'أهلا', 'اهلا', ['السلام', 'عليكم']],
    hi: ['नमस्ते', 'नमस्कार'],
    id: ['halo', 'hai'],
    vi: [['xin', 'chào'], 'chào'],
    ja: ['こんにちは', 'やあ'],
    ko: ['안녕하세요', '안녕'],
    'zh-CN': ['你好', '您好', '嗨'],
    'zh-TW': ['你好', '您好', '嗨'],
  };
  /* The assistant's name as users write it in each script. */
  var JENNY_NAMES = ['jenny', 'дженни', 'женни', 'جيني', 'जेनी', 'ジェニー', '제니', '珍妮'];
  /* A multi-word greeting is listed as its words, matched across any run
   * of whitespace. Longest first, so "xin chào" wins over "chào". */
  function alternation(entries) {
    var sources = entries.map(function (entry) {
      return [].concat(entry).map(escapeRegExp).join('\\s+');
    });
    var unique = Array.from(new Set(sources));
    unique.sort(function (a, b) { return b.length - a.length; });
    return unique.join('|');
  }
  /* "Hi Jenny.", "Hi, Jenny!", "¡Hola!", "你好，": a greeting only counts when
   * punctuation closes it, so "Hey there", "Hello-world" and the phrase
   * "Hello, world" stay whole. */
  var LEADING_GREETING_RE = new RegExp(
    '^(?!hello\\s*,\\s*world\\b)¡?(?:' + alternation([].concat.apply([], Object.values(GREETINGS_BY_LOCALE))) + ')'
      + '(?:\\s*[,，、،]?\\s*(?:' + alternation(JENNY_NAMES) + '))?'
      + '\\s*[.,!;:…—–，。！；：、،؛।～]+\\s*',
    'iu'
  );

  function clipTitleAtWordBoundary(value, maxLength) {
    if (value.length <= maxLength) {
      return value;
    }
    var slice = value.slice(0, maxLength + 1);
    var lastSpace = slice.lastIndexOf(' ');
    // Cut at the last word boundary unless that loses too much of the
    // budget (one giant token); then a hard clip beats an empty title.
    var clipped = lastSpace >= Math.floor(maxLength * 0.6)
      ? slice.slice(0, lastSpace)
      : value.slice(0, maxLength);
    clipped = clipped.replace(/[\s.,;:!?-]+$/, '');
    return clipped ? clipped + '...' : '';
  }

  /**
   * A chat's default title from its first user message: whitespace
   * collapsed, leading slash-commands and one leading greeting dropped,
   * clipped at a word boundary. A message that is only commands or only a
   * greeting keeps its text rather than leaving the chat untitled.
   */
  function deriveSessionTitleFromMessage(text, maxLength) {
    var budget = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : SESSION_TITLE_MAX_LENGTH;
    var normalized = String(text || '').replace(/\s+/g, ' ').trim();
    var withoutCommands = normalized;
    while (LEADING_SLASH_COMMAND_RE.test(withoutCommands)) {
      withoutCommands = withoutCommands.replace(LEADING_SLASH_COMMAND_RE, '');
    }
    withoutCommands = withoutCommands || normalized;
    var source = withoutCommands.replace(LEADING_GREETING_RE, '') || withoutCommands;
    return source ? clipTitleAtWordBoundary(source, budget) : '';
  }

  return {
    normalizeString,
    normalizeId,
    escapeHtml,
    escapeRegExp,
    sanitizeToken,
    stripInlineMarkdownLabel,
    resolveDefaultTitle,
    selectLinkedRecallSessions,
    SESSION_TITLE_MAX_LENGTH,
    deriveSessionTitleFromMessage,
  };
});
