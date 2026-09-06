/* global window */

/* monaco-editor VERSION PIN (WIDE-049, verified 2026-07-12): stays at exactly
 * 0.52.0 — the last release whose min/vs AMD build is compatible with this
 * bundler-less renderer. Do NOT bump to 0.53+ without a renderer bundler:
 *  - 0.53.0 officially deprecated AND de-supported the AMD build, and broke
 *    custom AMD workers "out of the box" (their changelog's words).
 *  - 0.55.1's min/vs was verified against the actual npm tarball to be a
 *    restructured hashed-chunk build: vs/base/worker/workerMain.js and the
 *    per-language worker bundles (vs/language/json/jsonWorker.js, cssWorker,
 *    htmlWorker, tsWorker) NO LONGER EXIST — the exact files
 *    renderer/frames/monaco-worker-bootstrap.js importScripts()es. Workers
 *    (and with them diagnostics/completions) would silently die.
 *  - 0.55.0 additionally moved languages.css/html/json/typescript to
 *    top-level namespaces (three call sites here use languages.typescript).
 * The supported upgrade path is Monaco's ESM build behind a real bundler
 * (vite/esbuild renderer bundle) — an architecture decision for the owner,
 * tracked in the WIDE-049 audit row. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererMonacoEditorUtils = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  const MONACO_THEME = 'vs-dark';
  const MONACO_STATE_KEY = '__jennyMonacoSharedState';
  const MONACO_DEFAULTS = {
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    fontSize: 13,
    lineNumbersMinChars: 3,
    tabSize: 2,
  };

  function normalizeEditorLanguage(value) {
    const token = String(value || '').trim().toLowerCase();
    if (!token) {
      return 'plaintext';
    }
    const aliases = {
      md: 'markdown',
      text: 'plaintext',
      txt: 'plaintext',
      js: 'javascript',
      cjs: 'javascript',
      mjs: 'javascript',
      ts: 'typescript',
      py: 'python',
      ps1: 'powershell',
      sh: 'shell',
      yml: 'yaml',
      jsonc: 'json',
      mermaid: 'plaintext',
      mmd: 'plaintext',
    };
    return aliases[token] || token;
  }

  // ── Large-file guard (Tier-3 local-model viability) ──
  // Past these thresholds a file opens in a degraded Monaco mode (expensive
  // chrome off) and is excluded from the auto active-file context window so a
  // huge/minified file never gets sliced into a small model's token budget.
  const LARGE_FILE_MAX_BYTES = 256 * 1024; // 256 KB
  const LARGE_FILE_MAX_LINES = 20000;
  const LARGE_FILE_MINIFIED_BYTES = 50 * 1024; // 50 KB packed into very few lines
  const LARGE_FILE_AVG_LINE_LEN = 2000;

  // Pure: the ONE workspace-path -> Monaco model URI encoding. encodeURI keeps
  // '/' as path structure (and escapes '%' as %25) but leaves '#' and '?' raw,
  // which Monaco's URI.parse splits into fragment/query — losing the suffix of
  // a legal filename like foo#bar.ts. Escaping those two delimiters makes the
  // round trip lossless: URI.parse(...).path decodes back to '/<path>'.
  function workspacePathToMonacoUriString(path) {
    return 'jenny-workspace:/' + encodeURI(String(path == null ? '' : path))
      .replace(/#/g, '%23')
      .replace(/\?/g, '%3F');
  }

  // Pure: classify a file's text as "large" (degrade + exclude from context).
  // Counts newlines without allocating a giant array (split() on a multi-MB
  // string is wasteful and this runs on every open).
  function classifyLargeFile(text) {
    const value = String(text == null ? '' : text);
    const bytes = value.length;
    if (bytes > LARGE_FILE_MAX_BYTES) {
      return true;
    }
    let lines = 1;
    for (let i = 0; i < bytes; i += 1) {
      if (value.charCodeAt(i) === 10) {
        lines += 1;
        if (lines > LARGE_FILE_MAX_LINES) {
          return true; // already classified large — stop counting
        }
      }
    }
    // Minified heuristic: substantial content packed into very few lines.
    return bytes > LARGE_FILE_MINIFIED_BYTES && bytes / lines > LARGE_FILE_AVG_LINE_LEN;
  }

  // Cheap content fingerprint for the large-file classification cache: a same-
  // length rewrite (e.g. minified <-> normal) must not collide with the prior
  // fingerprint, so length alone is not a valid cache key (WIDE-053).
  function fingerprintText(text) {
    const value = String(text == null ? '' : text);
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
    }
    return `${value.length}:${hash}`;
  }

  // Degraded editor options: keep the caller's base (so session wordWrap/minimap
  // toggles survive) but switch off the expensive per-line chrome.
  function largeFileEditorOptions(base) {
    return {
      ...(base && typeof base === 'object' ? base : {}),
      minimap: { enabled: false },
      stickyScroll: { enabled: false },
      occurrencesHighlight: 'off',
      bracketPairColorization: { enabled: false },
      guides: { bracketPairs: false, indentation: false },
      folding: false,
      fontLigatures: false,
      linkedEditing: false,
      renderWhitespace: 'none',
    };
  }

  // Show/hide the "large file — features reduced" notice inside the editor host.
  // Builds the restore control through the inventory action-button primitive
  // (no raw element in source) and delegates the click. Idempotent per host.
  function renderLargeFileNotice(hostEl, show, onRestore) {
    if (!hostEl || !hostEl.ownerDocument) {
      return;
    }
    const documentRef = hostEl.ownerDocument;
    let notice = hostEl.querySelector ? hostEl.querySelector('.ide-large-file-notice') : null;
    if (!show) {
      if (notice) {
        notice.classList.add('hidden');
      }
      return;
    }
    if (!notice) {
      const actionButton = (typeof window !== 'undefined' && window.inventoryActionButton) || null;
      notice = documentRef.createElement('div');
      notice.className = 'ide-large-file-notice';
      notice.setAttribute('role', 'status');
      const restoreHtml = actionButton
        ? actionButton({
            label: 'Restore full features',
            className: 'ide-large-file-notice-restore',
            dataset: { 'large-file-restore': '1' },
          })
        : '';
      notice.innerHTML =
        '<span class="ide-large-file-notice-label">Large file — editor features reduced'
        + ' and not auto-shared with Jenny.</span>' + restoreHtml;
      notice.addEventListener('click', function onNoticeClick(event) {
        const target = event && event.target;
        if (target && typeof target.closest === 'function'
          && target.closest('[data-large-file-restore]')) {
          notice.classList.add('hidden');
          // Call the LATEST restore handler (rebound per activation below), not
          // the one captured when the notice was first created — otherwise a
          // second large file would restore the first file's options snapshot.
          if (typeof notice._jennyOnRestore === 'function') {
            notice._jennyOnRestore();
          }
        }
      });
      hostEl.appendChild(notice);
    }
    notice._jennyOnRestore = typeof onRestore === 'function' ? onRestore : null;
    notice.classList.remove('hidden');
  }

  // Apply degraded (or full) editor options for the active file and toggle the
  // notice. `fullOptions` is the host's live option set so restore/normal files
  // keep the user's wordWrap/minimap choices.
  function applyLargeFileEditorMode(editor, hostEl, isLarge, fullOptions) {
    if (!editor || typeof editor.updateOptions !== 'function') {
      return;
    }
    editor.updateOptions(isLarge ? largeFileEditorOptions(fullOptions) : fullOptions);
    renderLargeFileNotice(hostEl, isLarge === true, function onRestore() {
      editor.updateOptions(fullOptions);
    });
  }

  // The fallback (jsdom / loader-failure) diff rendering: either the
  // placeholder summary or both versions stacked. Pure given the diff doc.
  function composeFallbackDiffText(doc) {
    if (doc && doc.placeholderText) {
      return doc.placeholderText;
    }
    return [
      '=== Original (before change) ===',
      doc ? doc.original : '',
      '',
      '=== Current ===',
      doc ? doc.modified : '',
    ].join('\n');
  }

  // 1-based line numbers for a [start, end) offset pair in a textarea buffer;
  // mirrors what Monaco selections report natively (the editor-host fallback).
  function fallbackSelectionLines(buffer, start, end) {
    const text = String(buffer == null ? '' : buffer);
    const before = text.slice(0, Math.max(0, start));
    const startLine = before.split('\n').length;
    const inside = text.slice(Math.max(0, start), Math.max(0, end));
    const endLine = startLine + (inside ? inside.split('\n').length - 1 : 0);
    return { startLine, endLine };
  }

  function getSharedMonacoState() {
    const fallback = {
      ready: false,
      failed: false,
      readyPromise: null,
      loaderConfigured: false,
      failureReason: '',
      loggedFailure: false,
      requireErrorHookInstalled: false,
      // Live editors that follow the --font-family-mono token, plus the latch
      // for the single typography MutationObserver that drives them.
      fontConsumers: null,
      typographyObserverInstalled: false,
    };
    if (typeof window === 'undefined') {
      return fallback;
    }
    if (!window[MONACO_STATE_KEY] || typeof window[MONACO_STATE_KEY] !== 'object') {
      window[MONACO_STATE_KEY] = { ...fallback };
    }
    return window[MONACO_STATE_KEY];
  }

  function logMonacoEvent(log, level, event, details) {
    if (typeof log === 'function') {
      try {
        log(level, event, details);
        return;
      } catch (_error) {
        /* fall through */
      }
    }
    const logger = level === 'ERROR' ? console.error : console.warn;
    if (typeof logger === 'function') {
      logger('[renderer.monaco]', event, details);
    }
  }

  function resolveScriptLoader() {
    if (typeof globalThis !== 'undefined' && globalThis.scriptLoaderUtils) {
      return globalThis.scriptLoaderUtils;
    }
    if (typeof require === 'function') {
      try {
        return require('../shared/script-loader-utils');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function getVsBaseUrl() {
    try {
      return new URL('node_modules/monaco-editor/min/vs/', window.location.href).toString();
    } catch (_error) {
      return 'node_modules/monaco-editor/min/vs/';
    }
  }

  function getLoaderScriptUrl() {
    try {
      return new URL('node_modules/monaco-editor/min/vs/loader.js', window.location.href).toString();
    } catch (_error) {
      return 'node_modules/monaco-editor/min/vs/loader.js';
    }
  }

  function isMonacoLoaderReady() {
    return typeof window !== 'undefined'
      && typeof window.require === 'function'
      && typeof window.require.config === 'function';
  }

  // Lazy-load the Monaco AMD loader (node_modules/.../vs/loader.js) on first
  // editor use. The loader defines window.require/define.amd and ~50 KB of
  // machinery; deferring it keeps those globals (and the cost) out of cold
  // startup. Resolves true once window.require is usable. When the loader is
  // already present (injected earlier, or a test stub), this is a no-op.
  async function ensureMonacoLoader(log) {
    if (isMonacoLoaderReady()) {
      return true;
    }
    const loader = resolveScriptLoader();
    if (!loader || typeof loader.ensureScript !== 'function') {
      return false;
    }
    return loader.ensureScript({
      src: getLoaderScriptUrl(),
      isReady: isMonacoLoaderReady,
      log,
    });
  }

  // The resolved AMD base rides into the worker as ?vs=..., the worker label
  // as &label=... - the bootstrap runs with self.location inside
  // renderer/frames/, where relative node_modules resolution lands on a path
  // that does not exist (workers failed importScripts and Monaco fell back
  // to main-thread workers). The label lets the bootstrap pre-import the
  // language worker bundle: Electron file:// pages have a real 'file://'
  // origin, so Monaco's in-worker AMD loader classifies module URLs as
  // same-origin and loads them via fetch() - which cannot read file: URLs.
  // Pre-registered AMD defines never hit that fetch path.
  function getWorkerBootstrapUrl(vsBaseUrl, label) {
    const query = `?vs=${encodeURIComponent(String(vsBaseUrl || ''))}`
      + `&label=${encodeURIComponent(String(label || ''))}`;
    try {
      return new URL(`renderer/frames/monaco-worker-bootstrap.js${query}`, window.location.href).toString();
    } catch (_error) {
      return `renderer/frames/monaco-worker-bootstrap.js${query}`;
    }
  }

  function ensureMonacoEnvironment() {
    if (typeof window === 'undefined') {
      return '';
    }
    const vsBaseUrl = getVsBaseUrl();
    const existing = window.MonacoEnvironment && typeof window.MonacoEnvironment === 'object'
      ? window.MonacoEnvironment
      : {};
    if (existing.__jennyConfigured !== true) {
      existing.globalAPI = true;
      existing.getWorkerUrl = function getWorkerUrl(_moduleId, label) {
        return getWorkerBootstrapUrl(vsBaseUrl, label);
      };
      existing.baseUrl = vsBaseUrl;
      existing.__jennyConfigured = true;
      window.MonacoEnvironment = existing;
    }
    return vsBaseUrl;
  }

  function isMonacoModuleError(error) {
    const modules = Array.isArray(error?.requireModules) ? error.requireModules : [];
    if (modules.some((moduleId) => String(moduleId || '').startsWith('vs/'))) {
      return true;
    }
    const message = String(error?.message || '').toLowerCase();
    if (message.includes('monaco') || message.includes('editor.main')) {
      return true;
    }
    const filename = String(error?.filename || error?.fileName || error?.target?.src || '').toLowerCase();
    return filename.includes('monaco-editor') || filename.includes('editor.main.js');
  }

  function configureMonaco(log) {
    if (
      typeof window === 'undefined'
      || typeof window.require !== 'function'
      || typeof window.require.config !== 'function'
    ) {
      return null;
    }
    const sharedState = getSharedMonacoState();
    const amdRequire = window.require;
    const vsBaseUrl = ensureMonacoEnvironment();
    if (!sharedState.loaderConfigured) {
      amdRequire.config({
        paths: {
          vs: String(vsBaseUrl || '').replace(/\/$/, ''),
        },
      });
      sharedState.loaderConfigured = true;
    }
    if (!sharedState.requireErrorHookInstalled) {
      const previousOnError = typeof amdRequire.onError === 'function'
        ? amdRequire.onError.bind(amdRequire)
        : null;
      amdRequire.onError = function onError(error) {
        if (isMonacoModuleError(error)) {
          const currentState = getSharedMonacoState();
          currentState.ready = false;
          currentState.failed = true;
          currentState.readyPromise = null;
          currentState.failureReason = 'amd_load_failed';
          if (!currentState.loggedFailure) {
            currentState.loggedFailure = true;
            logMonacoEvent(log, 'WARN', 'renderer.monaco_loader_failed', {
              message: String(error?.message || 'Monaco AMD load failed.'),
              status: 'failed',
            });
          }
          return undefined;
        }
        if (previousOnError) {
          return previousOnError(error);
        }
        return undefined;
      };
      sharedState.requireErrorHookInstalled = true;
    }
    return amdRequire;
  }

  function noteSharedMonacoFailure(log, reason, error) {
    const sharedState = getSharedMonacoState();
    sharedState.ready = false;
    sharedState.failed = true;
    sharedState.readyPromise = null;
    sharedState.failureReason = String(reason || '').trim() || 'unknown';
    if (sharedState.loggedFailure) {
      return false;
    }
    sharedState.loggedFailure = true;
    logMonacoEvent(log, 'WARN', 'renderer.monaco_fallback', {
      message: String(error?.message || error || 'Monaco editor unavailable; using textarea fallback.'),
      reason: sharedState.failureReason,
      status: 'fallback',
    });
    return false;
  }

  // Shared lazy-load of the full Monaco editor API (loader + editor.main).
  // Both the artifact editor and the Workspace IDE editor host funnel through
  // this single shared-state promise, so concurrent callers never double-load.
  // Resolves window.monaco, or null when Monaco is unavailable (jsdom tests,
  // loader failure) - callers fall back to their textarea path.
  async function ensureMonacoEditorApi(log) {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return null;
    }
    const sharedState = getSharedMonacoState();
    if (sharedState.failed) {
      return null;
    }
    if (window.monaco?.editor) {
      sharedState.ready = true;
      return window.monaco;
    }
    if (!sharedState.readyPromise) {
      sharedState.readyPromise = (async () => {
        const loaderReady = await ensureMonacoLoader(log).catch(() => false);
        if (!loaderReady) {
          sharedState.readyPromise = null;
          return noteSharedMonacoFailure(log, 'loader_unavailable');
        }
        const amdRequire = configureMonaco(log);
        if (!amdRequire) {
          sharedState.readyPromise = null;
          return noteSharedMonacoFailure(log, 'loader_unavailable');
        }
        return new Promise((resolve) => {
          try {
            amdRequire(
              ['vs/editor/editor.main'],
              function onReady() {
                if (!window.monaco || !window.monaco.editor) {
                  sharedState.readyPromise = null;
                  resolve(noteSharedMonacoFailure(log, 'editor_api_missing'));
                  return;
                }
                sharedState.ready = true;
                sharedState.failed = false;
                window.monaco.editor.setTheme(MONACO_THEME);
                resolve(true);
              },
              function onError(error) {
                sharedState.readyPromise = null;
                resolve(noteSharedMonacoFailure(log, 'amd_callback_failed', error));
              }
            );
          } catch (error) {
            sharedState.readyPromise = null;
            resolve(noteSharedMonacoFailure(log, 'loader_threw', error));
          }
        });
      })();
    }
    const ready = await sharedState.readyPromise;
    return ready && window.monaco?.editor ? window.monaco : null;
  }

  // -- Mono face: read the app token instead of Monaco's built-in default --
  // Monaco ships its own per-platform stack (Consolas on Windows, Menlo on
  // macOS) and applies it whenever fontFamily is absent, so an unset option is
  // NOT a no-op - it silently opts the editor out of the app's typography.
  // Resolving the token here keeps the artifact/IDE editors on the same face
  // as every other code surface, and lets the typography preference reach them
  // (that preference only remaps --font-family-* custom properties).
  //
  // Returns '' when the token cannot be resolved - the normal result under
  // JSDOM, where no stylesheet is attached. Callers must OMIT the key on ''
  // rather than passing it through: Monaco treats an empty string as a real
  // family and falls back to the UA serif, which is worse than its default.
  function resolveMonacoFontFamily(doc) {
    const target = doc || (typeof document !== 'undefined' ? document : null);
    const root = target?.documentElement || null;
    const view = target?.defaultView || (typeof window !== 'undefined' ? window : null);
    if (!root || typeof view?.getComputedStyle !== 'function') {
      return '';
    }
    try {
      const value = view.getComputedStyle(root).getPropertyValue('--font-family-mono');
      return String(value || '').trim();
    } catch (_error) {
      // getComputedStyle throws on a detached document during teardown.
      return '';
    }
  }

  // Spreads fontFamily onto an options object only when the token resolves, so
  // the '' case leaves Monaco's own default in place untouched.
  function withMonacoFontFamily(options, doc) {
    const base = options && typeof options === 'object' ? options : {};
    const fontFamily = resolveMonacoFontFamily(doc);
    return fontFamily ? { ...base, fontFamily } : { ...base };
  }

  function applyMonacoFontFamily(editor, fontFamily) {
    if (!editor || typeof editor.updateOptions !== 'function' || !fontFamily) {
      return;
    }
    try {
      editor.updateOptions({ fontFamily });
    } catch (_error) {
      // A disposed editor rejects updateOptions; the consumer set prunes below.
    }
  }

  // One observer for the whole renderer, latched in shared state. The
  // typography preset is applied by appearanceUtils.applyAppearanceToDocument,
  // which has six call sites (lifecycle, app, theme-bootstrap, uninstall
  // assistant); watching the attribute it writes covers all of them without
  // wiring any. Note the remeasureFonts() call - Monaco caches character-width
  // metrics per font, so updateOptions alone leaves the caret and column
  // positions measured against the OLD face.
  function ensureTypographyObserver(doc) {
    const sharedState = getSharedMonacoState();
    if (sharedState.typographyObserverInstalled) {
      return;
    }
    const target = doc || (typeof document !== 'undefined' ? document : null);
    const root = target?.documentElement || null;
    const view = target?.defaultView || (typeof window !== 'undefined' ? window : null);
    const ObserverCtor = view?.MutationObserver || null;
    if (!root || typeof ObserverCtor !== 'function') {
      return;
    }
    const observer = new ObserverCtor(() => {
      const fontFamily = resolveMonacoFontFamily(target);
      if (!fontFamily) {
        return;
      }
      const consumers = sharedState.fontConsumers;
      if (consumers?.size) {
        consumers.forEach((editor) => applyMonacoFontFamily(editor, fontFamily));
      }
      try {
        view.monaco?.editor?.remeasureFonts?.();
      } catch (_error) {
        // Monaco may be mid-teardown; the next create picks the face up anyway.
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-typography'] });
    sharedState.typographyObserverInstalled = true;
  }

  // Registers a live editor so the typography observer can retune it. ALWAYS
  // call the returned unregister on dispose - a retained handle would have
  // updateOptions called on a torn-down editor.
  function registerMonacoFontConsumer(editor, doc) {
    if (!editor || typeof editor.updateOptions !== 'function') {
      return () => {};
    }
    const sharedState = getSharedMonacoState();
    if (!sharedState.fontConsumers) {
      sharedState.fontConsumers = new Set();
    }
    sharedState.fontConsumers.add(editor);
    ensureTypographyObserver(doc);
    return function unregisterMonacoFontConsumer() {
      sharedState.fontConsumers?.delete(editor);
    };
  }

  // Read-only side-by-side options for the IDE diff editor. Lives beside the
  // other shared Monaco option sets so the diff chrome is tuned in one place.
  const IDE_DIFF_EDITOR_OPTIONS = {
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineNumbers: 'on',
  };

  // Bundles the font opt-in + consumer bookkeeping for a host that owns several
  // editors (the IDE host runs a main editor plus both sides of a diff editor).
  // Callers get a null-object when this module is stubbed, so the host needs no
  // per-call guards. ALWAYS release() on dispose - a retained handle would have
  // updateOptions called on a torn-down editor.
  function createIdeFontBinding() {
    const handles = [];
    return {
      withFont: (options, doc) => withMonacoFontFamily(options, doc),
      register(editor, doc) {
        handles.push(registerMonacoFontConsumer(editor, doc));
      },
      release() {
        handles.splice(0).forEach((unregister) => unregister?.());
      },
    };
  }

  function createArtifactEditor(options = {}) {
    const host = options.host || null;
    const fallbackTextarea = options.fallbackTextarea || null;
    const log = typeof options.log === 'function' ? options.log : null;
    const changeListeners = new Set();
    const disposalFence = asyncFence.createDisposalFence();
    let monacoEditor = null;
    let monacoModel = null;
    let fallbackBound = false;
    let isApplyingValue = false;
    let currentValue = '';
    let currentLanguage = 'plaintext';
    let currentReadOnly = false;
    let unregisterFontConsumer = null;
    /* Wrap defaults ON (MONACO_DEFAULTS.wordWrap) — the panel's wrap toggle
     * flips it; tracked here so a late-created instance honors the choice. */
    let currentWordWrap = true;

    function notifyChange() {
      if (isApplyingValue) {
        return;
      }
      const nextValue = api.getValue();
      currentValue = nextValue;
      for (const listener of changeListeners) {
        try {
          listener(nextValue);
        } catch (_error) {
          /* Listener failures should not break editor input. */
        }
      }
    }

    function ensureFallbackBinding() {
      if (!fallbackTextarea || fallbackBound) {
        return;
      }
      fallbackBound = true;
      fallbackTextarea.addEventListener('input', notifyChange);
    }

    function setFallbackVisible(visible) {
      if (fallbackTextarea) {
        fallbackTextarea.classList.toggle('hidden', !visible);
        if (visible) {
          fallbackTextarea.readOnly = currentReadOnly;
        }
      }
      if (host) {
        host.classList.toggle('artifact-editor-host-fallback', visible);
      }
    }

    async function ensureMonacoReady() {
      if (disposalFence.isDisposed() || !host || typeof document === 'undefined') {
        return false;
      }
      const monacoApi = await ensureMonacoEditorApi(log);
      return !disposalFence.isDisposed() && Boolean(monacoApi);
    }

    function ensureMonacoInstance() {
      if (disposalFence.isDisposed() || !window?.monaco?.editor || !host) {
        return false;
      }
      if (!monacoModel) {
        monacoModel = window.monaco.editor.createModel(
          currentValue,
          normalizeEditorLanguage(currentLanguage)
        );
      }
      if (!monacoEditor) {
        // Resolved per-create, never baked into MONACO_DEFAULTS: that constant
        // is evaluated at module load, before the appearance preference has
        // been applied to the document.
        monacoEditor = window.monaco.editor.create(host, withMonacoFontFamily({
          ...MONACO_DEFAULTS,
          model: monacoModel,
          readOnly: currentReadOnly,
          wordWrap: currentWordWrap ? 'on' : 'off',
        }, host?.ownerDocument));
        monacoEditor.onDidChangeModelContent(notifyChange);
        unregisterFontConsumer = registerMonacoFontConsumer(monacoEditor, host?.ownerDocument);
      }
      return true;
    }

    async function applyDocument(value, { language = 'plaintext', readOnly = false } = {}) {
      if (disposalFence.isDisposed()) {
        return;
      }
      const nextValue = String(value || '');
      const nextLanguage = normalizeEditorLanguage(language);
      const nextReadOnly = readOnly === true;
      if (nextValue === currentValue && nextLanguage === currentLanguage && nextReadOnly === currentReadOnly) {
        return;
      }
      currentValue = nextValue;
      currentLanguage = nextLanguage;
      currentReadOnly = nextReadOnly;

      ensureFallbackBinding();
      const monacoReady = await ensureMonacoReady().catch(() => false);
      if (disposalFence.isDisposed()) {
        return;
      }
      isApplyingValue = true;
      try {
        if (monacoReady && ensureMonacoInstance() && monacoModel && monacoEditor && window.monaco?.editor) {
          if (monacoModel.getValue() !== currentValue) {
            monacoModel.setValue(currentValue);
          }
          window.monaco.editor.setModelLanguage(monacoModel, currentLanguage);
          monacoEditor.updateOptions({ readOnly: currentReadOnly });
          setFallbackVisible(false);
          return;
        }
        setFallbackVisible(true);
        if (fallbackTextarea) {
          fallbackTextarea.value = currentValue;
          fallbackTextarea.readOnly = currentReadOnly;
        }
      } finally {
        isApplyingValue = false;
      }
    }

    const api = {
      async setDocument(documentState) {
        const next = documentState && typeof documentState === 'object' ? documentState : {};
        await applyDocument(next.value, {
          language: next.language,
          readOnly: next.readOnly,
        });
      },
      getValue() {
        if (monacoEditor && monacoModel) {
          return monacoModel.getValue();
        }
        return fallbackTextarea ? String(fallbackTextarea.value || '') : '';
      },
      async setReadOnly(readOnly) {
        currentReadOnly = readOnly === true;
        if (monacoEditor) {
          monacoEditor.updateOptions({ readOnly: currentReadOnly });
        }
        if (fallbackTextarea) {
          fallbackTextarea.readOnly = currentReadOnly;
        }
      },
      setWordWrap(enabled) {
        currentWordWrap = enabled !== false;
        if (monacoEditor) {
          monacoEditor.updateOptions({ wordWrap: currentWordWrap ? 'on' : 'off' });
        }
        if (fallbackTextarea) {
          fallbackTextarea.setAttribute('wrap', currentWordWrap ? 'soft' : 'off');
        }
      },
      getWordWrap() {
        return currentWordWrap;
      },
      focus() {
        if (monacoEditor) {
          monacoEditor.focus();
          return;
        }
        fallbackTextarea?.focus();
      },
      onDidChange(listener) {
        if (typeof listener !== 'function') {
          return function noop() {};
        }
        changeListeners.add(listener);
        return () => {
          changeListeners.delete(listener);
        };
      },
      isUsingMonaco() {
        return Boolean(monacoEditor);
      },
      dispose() {
        if (!disposalFence.dispose()) {
          return;
        }
        changeListeners.clear();
        if (fallbackBound && fallbackTextarea) {
          fallbackTextarea.removeEventListener('input', notifyChange);
          fallbackBound = false;
        }
        if (unregisterFontConsumer) {
          unregisterFontConsumer();
          unregisterFontConsumer = null;
        }
        if (monacoEditor) {
          monacoEditor.dispose();
          monacoEditor = null;
        }
        if (monacoModel) {
          monacoModel.dispose();
          monacoModel = null;
        }
      },
    };

    return api;
  }

  return {
    createArtifactEditor,
    ensureMonacoEditorApi,
    resolveMonacoFontFamily,
    withMonacoFontFamily,
    registerMonacoFontConsumer,
    createIdeFontBinding,
    IDE_DIFF_EDITOR_OPTIONS,
    normalizeEditorLanguage,
    workspacePathToMonacoUriString,
    classifyLargeFile,
    fingerprintText,
    largeFileEditorOptions,
    applyLargeFileEditorMode,
    composeFallbackDiffText,
    fallbackSelectionLines,
  };
});
