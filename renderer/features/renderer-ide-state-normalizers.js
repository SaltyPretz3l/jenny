/* renderer/features/renderer-ide-state-normalizers.js - the pure value normalizers behind
 * renderer-ide-state.js (no DOM, no IPC): the editor-preference tables and clamps, the
 * workspace-relative path gate, and the replace-journal / search-history sanitizers. Split out
 * of renderer-ide-state.js to keep it under the file-size ceiling; that module re-exports the
 * names it always exported. Eager script: loaded before renderer-ide-state.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeStateNormalizers = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Editor preference bounds/whitelists, duplicated from services/shell-config-state.js
  // (this UMD module cannot import services). Defaults MUST match the service side.
  const FONT_SIZE_MIN = 8;
  const FONT_SIZE_MAX = 40;
  // 0 = "Match text size" (code role, 13px x --font-scale). The pre-rebase
  // default 13 was persisted for everyone, so it also reads as Match.
  const FONT_SIZE_DEFAULT = 0;
  const FONT_SIZE_LEGACY_DEFAULT = 13;
  function normalizeEditorFontSize(value) {
    const size = Math.trunc(Number(value));
    if (!Number.isFinite(size) || size <= 0 || size === FONT_SIZE_LEGACY_DEFAULT) {
      return FONT_SIZE_DEFAULT;
    }
    return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size));
  }
  const TAB_SIZES = [2, 4, 8];
  const TAB_SIZE_DEFAULT = 2;
  const LINE_NUMBERS = ['on', 'off'];
  const RENDER_WHITESPACE = ['none', 'boundary', 'selection', 'trailing', 'all'];
  const EOL_VALUES = ['', 'lf', 'crlf'];
  const EXPLORER_SORT_MODES = ['name', 'type', 'modified'];
  const REPLACE_JOURNAL_MAX_APPLIED = 200;
  const REPLACE_JOURNAL_QUERY_MAX = 500;
  // Row 82 editor/terminal/auto-save prefs: additive persisted keys, table-driven and
  // mirrored by services/workspace-ide-config-schema.js (same specs, same results; the
  // parity test pins it). 'bool' defaults true -> false only on literal false; default
  // false -> true only on literal true. `legacy(src)` is the fallback for an invalid enum.
  const CURSOR_STYLES = ['line', 'block', 'underline'];
  const CURSOR_BLINKING = ['smooth', 'blink', 'phase', 'expand', 'solid'];
  const AUTO_SAVE_MODES = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'];
  const AUTO_SAVE_DELAY_MIN = 100;
  const AUTO_SAVE_DELAY_MAX = 60000;
  const FONT_FAMILY_MAX_CHARS = 200;
  // Shell profile id ('' = platform default): the ids workspace-pty-profiles.js emits
  // (pwsh, git-bash, ...); main checks it against the detected shells.
  const TERMINAL_PROFILE_ID_RE = /^[a-z0-9-]{1,32}$/;
  // D1: 25,000 lines (about 1.5 MB per 1,000 lines per terminal); a larger stored value clamps on load.
  const TERMINAL_SCROLLBACK_MIN = 500;
  const TERMINAL_SCROLLBACK_DEFAULT = 1000;
  const TERMINAL_SCROLLBACK_MAX = 25000;
  // '' = use the app mono token. Only plain family-list characters survive; anything else
  // (or an over-long value) collapses to '' rather than reaching Monaco's CSS.
  function normalizeFontFamily(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0 && text.length <= FONT_FAMILY_MAX_CHARS && /^[A-Za-z0-9 _\-.,'"]+$/.test(text) ? text : '';
  }
  function clampPrefInt(value, min, max, fallback) {
    const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
      ? Math.trunc(Number(value))
      : NaN;
    return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
  }
  const EDITOR_PREF_SPECS = [
    { key: 'fontFamily', kind: 'text', def: '', clean: normalizeFontFamily },
    { key: 'cursorStyle', kind: 'enum', def: 'line', values: CURSOR_STYLES },
    { key: 'cursorBlinking', kind: 'enum', def: 'smooth', values: CURSOR_BLINKING },
    { key: 'cursorSmoothCaretAnimation', kind: 'bool', def: true },
    { key: 'fontLigatures', kind: 'bool', def: true },
    { key: 'bracketPairColorization', kind: 'bool', def: true },
    { key: 'indentGuides', kind: 'bool', def: true },
    { key: 'stickyScroll', kind: 'bool', def: true },
    { key: 'folding', kind: 'bool', def: true },
    { key: 'insertSpaces', kind: 'bool', def: true },
    { key: 'detectIndentation', kind: 'bool', def: true },
    // A valid autoSaveMode wins; else the pre-row-82 boolean migrates (true -> afterDelay).
    {
      key: 'autoSaveMode', kind: 'enum', def: 'off', values: AUTO_SAVE_MODES,
      legacy: (src) => (src.autoSaveEnabled === true ? 'afterDelay' : 'off'),
    },
    { key: 'autoSaveDelayMs', kind: 'int', def: 1000, min: AUTO_SAVE_DELAY_MIN, max: AUTO_SAVE_DELAY_MAX },
    { key: 'scrollBeyondLastLine', kind: 'bool', def: false },
    { key: 'mouseWheelZoom', kind: 'bool', def: true },
    { key: 'inlineBlame', kind: 'bool', def: true },
    { key: 'terminalScrollback', kind: 'int', def: TERMINAL_SCROLLBACK_DEFAULT, min: TERMINAL_SCROLLBACK_MIN, max: TERMINAL_SCROLLBACK_MAX },
    {
      key: 'terminalDefaultProfile', kind: 'text', def: '',
      clean: (value) => (typeof value === 'string' && TERMINAL_PROFILE_ID_RE.test(value) ? value : ''),
    },
  ];
  function normalizeEditorPrefSpec(spec, src) {
    const raw = src[spec.key];
    if (spec.kind === 'bool') {
      return spec.def === true ? raw !== false : raw === true;
    }
    if (spec.kind === 'enum') {
      return spec.values.includes(raw) ? raw : (spec.legacy ? spec.legacy(src) : spec.def);
    }
    if (spec.kind === 'int') {
      return clampPrefInt(raw, spec.min, spec.max, spec.def);
    }
    return spec.clean(raw);
  }
  // Editor column rulers (CONFIG_VERSION 34); mirrors the service bounds. [] = off.
  const RULERS_MAX_COUNT = 8;
  const RULERS_MAX_COLUMN = 500;
  function normalizeRulers(value) {
    const raw = Array.isArray(value) ? value : [];
    const seen = new Set();
    for (const entry of raw) {
      const column = Math.trunc(Number(entry));
      if (Number.isFinite(column) && column > 0 && column <= RULERS_MAX_COLUMN) {
        seen.add(column);
      }
    }
    return [...seen].sort((a, b) => a - b).slice(0, RULERS_MAX_COUNT);
  }

  // Preview-source gate: stricter than normalizeIdeRelativePath because the
  // relative-path gate collapses '//' runs (a legacy 'preview://a.md' id would
  // survive as the junk path 'preview:/a.md') and stringifies non-strings.
  // Only a real string with no scheme-like ':' segment passes.
  function normalizePreviewSourcePath(value) {
    if (typeof value !== 'string') {
      return '';
    }
    const normalized = normalizeIdeRelativePath(value);
    return normalized.includes(':') ? '' : normalized;
  }

  // Mirror of the main-process lexical path gate: workspace-relative POSIX
  // paths only. Returns '' for anything absolute / drive-lettered / escaping.
  function normalizeIdeRelativePath(value) {
    const raw = String(value || '').replace(/\\/g, '/');
    const lead = raw.trimStart();
    if (!lead || raw.includes('\0') || lead.startsWith('/') || /^[A-Za-z]:/.test(lead)) {
      return '';
    }
    const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
    if (!segments.length || segments.some((segment) => segment === '..')) {
      return '';
    }
    return segments.join('/');
  }

  function normalizeReplaceJournal(value) {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)
      || typeof value.query !== 'string'
      || typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total < 0
      || !Array.isArray(value.applied)
      || (value.truncated !== undefined && typeof value.truncated !== 'boolean')) return null;
    const validPaths = value.applied.map(normalizeIdeRelativePath).filter(Boolean);
    return {
      startedAt: value.startedAt,
      query: value.query.slice(0, REPLACE_JOURNAL_QUERY_MAX),
      total: value.total,
      applied: validPaths.slice(0, REPLACE_JOURNAL_MAX_APPLIED),
      truncated: value.truncated === true || validPaths.length > REPLACE_JOURNAL_MAX_APPLIED,
    };
  }

  // Search history (root-bound, mirrors the service normalizer): trimmed non-empty
  // strings <= 256 chars, de-duplicated keeping the newest, newest last, max 20.
  function normalizeSearchHistory(value) {
    if (!Array.isArray(value)) return [];
    const newestFirst = [];
    for (let index = value.length - 1; index >= 0 && newestFirst.length < 20; index -= 1) {
      const entry = typeof value[index] === 'string' ? value[index].trim() : '';
      if (entry && entry.length <= 256 && !newestFirst.includes(entry)) newestFirst.push(entry);
    }
    return newestFirst.reverse();
  }

  // Editor prefs, validated on write and on restore so a corrupt value never lands.
  function normalizeEditorPrefs(src) {
    const prefs = {
      wordWrap: src.wordWrap === 'on' ? 'on' : 'off',
      fontSize: normalizeEditorFontSize(src.fontSize),
      tabSize: TAB_SIZES.includes(Number(src.tabSize)) ? Number(src.tabSize) : TAB_SIZE_DEFAULT,
      minimap: src.minimap === false ? false : true,
      lineNumbers: LINE_NUMBERS.includes(src.lineNumbers) ? src.lineNumbers : 'on',
      renderWhitespace: RENDER_WHITESPACE.includes(src.renderWhitespace) ? src.renderWhitespace : 'selection',
      eol: EOL_VALUES.includes(src.eol) ? src.eol : '',
      formatOnSave: src.formatOnSave === true,
      trimTrailingWhitespace: src.trimTrailingWhitespace === true,
      insertFinalNewline: src.insertFinalNewline === true,
      rulers: normalizeRulers(src.rulers),
    };
    for (const spec of EDITOR_PREF_SPECS) {
      prefs[spec.key] = normalizeEditorPrefSpec(spec, src);
    }
    // Derived mirror of the resolved mode (rollback safety for one release); never trusted
    // independently, so a stale autoSaveEnabled can't override an explicit 'off'.
    prefs.autoSaveEnabled = prefs.autoSaveMode !== 'off';
    return prefs;
  }

  return {
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    FONT_SIZE_DEFAULT,
    normalizeEditorFontSize,
    TAB_SIZES,
    TAB_SIZE_DEFAULT,
    EDITOR_PREF_SPECS,
    RENDER_WHITESPACE,
    EXPLORER_SORT_MODES,
    REPLACE_JOURNAL_MAX_APPLIED,
    REPLACE_JOURNAL_QUERY_MAX,
    CURSOR_STYLES,
    CURSOR_BLINKING,
    AUTO_SAVE_MODES,
    AUTO_SAVE_DELAY_MIN,
    AUTO_SAVE_DELAY_MAX,
    TERMINAL_SCROLLBACK_MIN,
    TERMINAL_SCROLLBACK_DEFAULT,
    TERMINAL_SCROLLBACK_MAX,
    normalizeFontFamily,
    normalizeRulers,
    normalizeIdeRelativePath,
    normalizePreviewSourcePath,
    normalizeReplaceJournal,
    normalizeSearchHistory,
    normalizeEditorPrefs,
  };
});
