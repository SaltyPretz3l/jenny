/* renderer/features/renderer-ide-editor-prefs.js
 *
 * Pure glue between the persisted IDE state slice (renderer-ide-state.js /
 * the workspaceIde config slice) and the live Monaco editor. Keeps the IDE
 * controller thin: the controller calls applyEditorPrefs() from onMonacoReady
 * (every editor recreate) and from activateIde() (so a change made in the
 * Settings "Editor" section applies the moment the user returns to the IDE),
 * and routes statusbar chip picks through persistChipChange().
 *
 * Editor-LEVEL prefs (fontSize/lineNumbers/renderWhitespace/minimap/wordWrap)
 * go through editorHost.setEditorOptions(); per-MODEL prefs (tabSize/eol) are
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

  function noop() {}

  // The render-whitespace whitelist is owned by renderer-ide-state.js (the
  // renderer-canonical source); reuse it so this sibling can't drift. The
  // literal fallback only matters if that module isn't loaded (never in app).
  function whitespaceValues() {
    const ref = (typeof globalThis !== 'undefined' && globalThis.rendererIdeState) || null;
    return Array.isArray(ref && ref.RENDER_WHITESPACE)
      ? ref.RENDER_WHITESPACE
      : ['none', 'boundary', 'selection', 'trailing', 'all'];
  }

  // Reads editor prefs off the IDE slice and pushes them to the live editor.
  // Idempotent and null-safe: a no-Monaco fallback or absent chip-picker is a
  // quiet no-op, so it is safe to call on every activation/recreate.
  function applyEditorPrefs(ide, editorHost, chipPicker) {
    if (!ide || !editorHost || typeof editorHost.setEditorOptions !== 'function') {
      return;
    }
    const fontSize = Number(ide.fontSize) > 0 ? Number(ide.fontSize) : 13;
    editorHost.setEditorOptions({
      fontSize,
      wordWrap: ide.wordWrap === 'on' ? 'on' : 'off',
      minimap: { enabled: ide.minimap !== false },
      lineNumbers: ide.lineNumbers === 'off' ? 'off' : 'on',
      renderWhitespace: whitespaceValues().includes(ide.renderWhitespace) ? ide.renderWhitespace : 'selection',
      // Column rulers: always pass an array (a copy so Monaco can't retain the
      // slice) so disabling them (-> []) clears the guides rather than leaving
      // the last value in place.
      rulers: Array.isArray(ide.rulers) ? ide.rulers.slice() : [],
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
        label: 'Toggle Word Wrap',
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
