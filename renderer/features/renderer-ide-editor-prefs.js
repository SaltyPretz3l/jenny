/* renderer/features/renderer-ide-editor-prefs.js
 *
 * Pure glue between the persisted IDE state slice (renderer-ide-state.js /
 * the workspaceIde config slice) and the live Monaco editor. Keeps the IDE
 * controller thin: the controller calls applyEditorPrefs() from onMonacoReady
 * (every editor recreate) and from activateIde() (so a change made in the
 * Settings "Editor" section applies the moment the user returns to the IDE),
 * and routes statusbar chip picks through persistChipChange().
 *
 * Editor-LEVEL prefs (fontSize/lineNumbers/renderWhitespace/minimap/wordWrap, plus the
 * row 82 font family, cursor, ligature, bracket/indent guide, sticky scroll, folding,
 * scroll-beyond-last-line, wheel-zoom and indentation-detection prefs) go through editorHost.setEditorOptions(); per-MODEL prefs (tabSize/eol) are
 * handed to the chip-picker as its session defaults, which it applies to the
 * active doc and to each newly opened file. No DOM, no IPC. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorPrefs = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function noop() {}

  // The enum whitelists are renderer-ide-state.js's pref tables (the renderer-canonical
  // source, an eager script; required under Node), so this sibling can't drift.
  const ideState = (typeof globalThis !== 'undefined' && globalThis.rendererIdeState) || require('./renderer-ide-state');

  // Defensive reads of the row 82 prefs: the slice may be partial, so each falls back to
  // its persisted default (same values as the renderer-ide-state / service specs).
  const flag = (value, fallback) => (fallback ? value !== false : value === true);
  function pick(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }
  // '' (use the app mono token) resolves the live --font-family-mono value; an empty
  // result is OMITTED by the caller because Monaco treats '' as a real family.
  function resolveFontFamily(custom) {
    // renderer-ide-state.js owns the sanitizer.
    const clean = ideState.normalizeFontFamily(custom);
    if (clean) {
      return clean;
    }
    const monacoUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMonacoEditorUtils) || null;
    return typeof monacoUtils?.resolveMonacoFontFamily === 'function'
      ? String(monacoUtils.resolveMonacoFontFamily() || '').trim()
      : '';
  }

  // Reads editor prefs off the IDE slice and pushes them to the live editor.
  // Idempotent and null-safe: a no-Monaco fallback or absent chip-picker is a
  // quiet no-op, so it is safe to call on every activation/recreate.
  function applyEditorPrefs(ide, editorHost, chipPicker) {
    if (!ide || !editorHost || typeof editorHost.setEditorOptions !== 'function') {
      return;
    }
    // 0 = "Match text size": the shared resolver follows --font-scale, and the
    // preference also retunes the diff sides, artifact editors, and terminal.
    const monacoUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMonacoEditorUtils) || null;
    const fontSize = typeof monacoUtils?.setCodeFontSizePreference === 'function'
      ? monacoUtils.setCodeFontSizePreference(ide.fontSize)
      : (Number(ide.fontSize) > 0 ? Number(ide.fontSize) : 13);
    const indentGuides = flag(ide.indentGuides, true);
    const fontFamily = resolveFontFamily(ide.fontFamily);
    // The shared typography observer retunes every editor to the token; this keeps a
    // custom family on the IDE editor through that pass (row 82 E1).
    monacoUtils?.setIdeFontFamilyResolver?.({
      resolve: () => resolveFontFamily(ide.fontFamily),
      apply: (family) => editorHost.setEditorOptions({ fontFamily: family }),
    });
    editorHost.setEditorOptions({
      ...(fontFamily ? { fontFamily } : {}),
      fontSize,
      wordWrap: ide.wordWrap === 'on' ? 'on' : 'off',
      minimap: { enabled: ide.minimap !== false },
      lineNumbers: ide.lineNumbers === 'off' ? 'off' : 'on',
      renderWhitespace: pick(ide.renderWhitespace, ideState.RENDER_WHITESPACE, 'selection'),
      // Column rulers: always pass an array (a copy so Monaco can't retain the
      // slice) so disabling them (-> []) clears the guides rather than leaving
      // the last value in place.
      rulers: Array.isArray(ide.rulers) ? ide.rulers.slice() : [],
      cursorStyle: pick(ide.cursorStyle, ideState.CURSOR_STYLES, 'line'),
      cursorBlinking: pick(ide.cursorBlinking, ideState.CURSOR_BLINKING, 'smooth'),
      cursorSmoothCaretAnimation: flag(ide.cursorSmoothCaretAnimation, true) ? 'on' : 'off',
      fontLigatures: flag(ide.fontLigatures, true),
      bracketPairColorization: { enabled: flag(ide.bracketPairColorization, true) },
      guides: {
        indentation: indentGuides,
        bracketPairs: indentGuides && flag(ide.bracketPairColorization, true),
      },
      stickyScroll: { enabled: flag(ide.stickyScroll, true) },
      folding: flag(ide.folding, true),
      scrollBeyondLastLine: flag(ide.scrollBeyondLastLine, false),
      mouseWheelZoom: flag(ide.mouseWheelZoom, true),
      insertSpaces: flag(ide.insertSpaces, true),
      detectIndentation: flag(ide.detectIndentation, true),
    });
    // Per-model defaults: null means "follow the file" (the chip-picker default).
    chipPicker?.seedDefaults?.({
      tabSize: Number(ide.tabSize) > 0 ? Number(ide.tabSize) : null,
      eol: ide.eol === 'lf' || ide.eol === 'crlf' ? ide.eol : null,
    });
  }

  // Maps a statusbar chip pick ({kind,value}) onto the IDE slice and schedules
  // a persist. Keeps the per-model tab-size/EOL defaults durable across restart
  // (the Tier-1 chips were session-only); editor-level prefs persist via the
  // Settings section instead.
  function persistChipChange(ide, change, commitPreference) {
    if (!ide || !change) {
      return;
    }
    const commit = typeof commitPreference === 'function'
      ? commitPreference
      : () => Promise.resolve({ updated: false });
    if (change.kind === 'tab-size' && Number(change.value) > 0) {
      return commit('tabSize', Number(change.value));
    } else if (change.kind === 'eol' && (change.value === 'lf' || change.value === 'crlf')) {
      return commit('eol', change.value);
    }
    return Promise.resolve({ updated: false, skipped: true });
  }

  // Word-wrap is an editor-LEVEL pref like the rest, but unlike the others it
  // has interactive surfaces (the Alt+Z Monaco action + the statusbar toggle)
  // that applyEditorPrefs() does not own. This thin controller holds the toggle
  // + the action registration so the IDE controller stays under its line cap.
  function createWordWrapController(deps) {
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const editorHost = deps?.editorHost || null;
    const commitPreference = typeof deps?.commitPreference === 'function'
      ? deps.commitPreference
      : () => Promise.resolve({ updated: false });
    const requestStatusRender = typeof deps?.requestStatusRender === 'function' ? deps.requestStatusRender : noop;

    async function toggle() {
      const ide = getIde() || {};
      const next = ide.wordWrap === 'on' ? 'off' : 'on';
      const result = await commitPreference('wordWrap', next);
      if (result?.updated === true) {
        editorHost?.setWordWrap?.(result.value);
        requestStatusRender();
      }
      return result;
    }

    function registerAction(monacoApi) {
      const keybinding = monacoApi?.KeyMod?.Alt && monacoApi?.KeyCode?.KeyZ
        ? [monacoApi.KeyMod.Alt | monacoApi.KeyCode.KeyZ]
        : undefined;
      editorHost?.addEditorAction?.({
        id: 'jenny.toggle-word-wrap',
        label: jt('ide.editorPrefs.toggleWordWrap', 'Toggle Word Wrap'),
        contextMenuGroupId: 'jenny',
        contextMenuOrder: 3,
        keybindings: keybinding,
        run: () => toggle(),
      });
    }

    return { toggle, registerAction };
  }

  async function toggleMinimap(ide, editorHost, commitPreference, requestStatusRender = noop) {
    const result = await commitPreference('minimap', ide?.minimap === false);
    if (result?.updated === true) {
      editorHost?.setEditorOptions?.({ minimap: { enabled: result.value !== false } });
      requestStatusRender();
    }
    return result;
  }

  return { applyEditorPrefs, persistChipChange, createWordWrapController, toggleMinimap };
});
