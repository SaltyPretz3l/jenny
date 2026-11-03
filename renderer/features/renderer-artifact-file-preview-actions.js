/* renderer/features/renderer-artifact-file-preview-actions.js - text actions for the chat
 * rail's FILE PREVIEW body: attaches the shared panel code actions (clean copy, Ask Jenny chip,
 * body menu) and find-in-file to the rendered code list, the actions alone to the markdown Read
 * body, and implements the header Copy for `file_preview` (copies the loaded text, not just the
 * rendered line window). Image, HTML-frame and error bodies get nothing: the sandboxed frame is
 * never touched. The controller creates this lazily and calls hydrate() after each body render. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactFilePreviewActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const jtDefault = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const FIND_OFFSET_VAR = '--panel-code-find-offset';

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  // deps: windowRef (required), jt, showToast, writeClipboard, insertIntoComposer, contextMenu,
  // appendClientLog, plus the controller's openInIde(slot, line) and reload().
  function createFilePreviewActions(deps = {}) {
    const windowRef = deps.windowRef;
    const documentRef = deps.documentRef || windowRef.document;
    const jt = typeof deps.jt === 'function' ? deps.jt : jtDefault;
    const showToast = typeof deps.showToast === 'function' ? deps.showToast : () => {};
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : () => {};
    const log = (level, event, payload) => appendClientLog(String(level).toUpperCase(), event, payload);
    const writeClipboard = deps.writeClipboard || ((text) => windowRef.jennyShell.clipboard.writeText(text));
    const insertIntoComposer = deps.insertIntoComposer
      || ((payload) => resolveModule('rendererComposerInsert', '../chat/renderer-composer-insert').insertIntoComposer(payload));
    const panelCodeActions = (deps.panelCodeActions || resolveModule('rendererPanelCodeActions', './renderer-panel-code-actions'))
      .createPanelCodeActions({
        documentRef, jt, log, contextMenu: deps.contextMenu, writeClipboard, insertIntoComposer, showToast,
      });
    const panelCodeFind = (deps.panelCodeFind || resolveModule('rendererPanelCodeFind', './renderer-panel-code-find'))
      .createPanelCodeFind({
        documentRef, windowRef, jt, textField: windowRef.inventoryTextField, actionButton: windowRef.inventoryActionButton,
      });
    let detachers = [];

    function detachAll() {
      for (const detach of detachers) detach();
      detachers = [];
    }

    function adapterFor(slot, bodyEl) {
      return {
        kind: 'file',
        getPath: () => slot.display || slot.path, // a project file names its full path
        getLanguageId: (rowEl) => (rowEl || bodyEl).querySelector('[data-language-id]')?.getAttribute('data-language-id') || '',
        openInIde: (line) => deps.openInIde(slot, line),
        extraMenuItems: () => [{ label: jt('panelCode.reload', 'Reload file'), action: () => deps.reload() }],
      };
    }

    // Called after each body render; the previous body's listeners and chip are always released first.
    function hydrate(host, slot) {
      detachAll();
      host.style.removeProperty(FIND_OFFSET_VAR);
      if (slot.status !== 'ready' || !slot.payload) return;
      const codeList = host.querySelector('.artifact-file-preview-code');
      const body = codeList || host.querySelector('.artifact-file-preview-doc');
      if (!body) return;
      detachers.push(panelCodeActions.attach(body, adapterFor(slot, body)));
      if (!codeList) return;
      detachers.push(panelCodeFind.attach(codeList, { rowSelector: '.artifact-file-preview-row', textSelector: 'code' }).detach);
      // The find field sits under the sticky file bar.
      const bar = host.querySelector('.artifact-file-preview-bar');
      if (bar) host.style.setProperty(FIND_OFFSET_VAR, `${bar.offsetHeight}px`);
    }

    // The whole text the read returned (up to the byte cap), not the rendered line window.
    async function copyContents(slot) {
      const payload = slot?.status === 'ready' ? slot.payload : null;
      if (!payload || typeof payload.text !== 'string') return false;
      try {
        await writeClipboard(payload.text);
      } catch (error) {
        log('warn', 'artifact_file_preview.copy_failed', { message: String(error?.message || error) });
        showToast(jt('panelCode.copyFailed', 'Couldn’t copy'));
        return false;
      }
      showToast(payload.byteTruncated === true
        ? jt('artifacts.filePreview.copiedPartial', 'Copied the first {lines} lines', { lines: payload.totalLines })
        : jt('artifacts.filePreview.copied', 'Copied'));
      return true;
    }

    function dispose() {
      detachAll();
      panelCodeActions.dispose();
      panelCodeFind.dispose();
    }

    return { hydrate, copyContents, dispose };
  }

  return { createFilePreviewActions };
});
