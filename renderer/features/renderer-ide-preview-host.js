/* renderer/features/renderer-ide-preview-host.js - rendered-markdown preview
 * pane for the Workspace IDE editor stage (W8). Overlays #ideEditorHost like
 * the diff/image panes. The pane only ever receives ALREADY-SANITIZED HTML
 * (markdownUtils.renderMarkdown -> DOMPurify) from the preview controller;
 * postRender runs the lazy mermaid pass after each injection. Composed by
 * renderer-ide-editor-host, which owns the preview documents. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePreviewHost = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createIdePreviewPane(deps) {
    const getHost = typeof deps?.getHost === 'function' ? deps.getHost : () => null;
    const postRender = typeof deps?.postRender === 'function' ? deps.postRender : () => {};

    let paneEl = null;
    let contentEl = null;
    let currentId = '';

    function ensurePane() {
      if (paneEl) {
        return paneEl;
      }
      const host = getHost();
      const documentRef = host?.ownerDocument || null;
      if (!host || !documentRef) {
        return null;
      }
      paneEl = documentRef.createElement('div');
      paneEl.className = 'ide-preview-pane hidden';
      contentEl = documentRef.createElement('div');
      contentEl.className = 'ide-preview-content';
      paneEl.appendChild(contentEl);
      host.appendChild(paneEl);
      return paneEl;
    }

    function inject(doc) {
      if (!contentEl) {
        return;
      }
      contentEl.innerHTML = String(doc.html || '');
      try {
        postRender(contentEl);
      } catch (_error) {
        /* mermaid pass is best-effort; the sanitized HTML already rendered */
      }
    }

    // doc: editor-host preview document { id, html, sourcePath, label }.
    function show(doc) {
      if (!ensurePane() || !doc) {
        return false;
      }
      currentId = String(doc.id || '');
      inject(doc);
      paneEl.classList.remove('hidden');
      return true;
    }

    // Live-update path: re-inject only when this doc is the visible one.
    function update(doc) {
      if (!paneEl || paneEl.classList.contains('hidden') || String(doc?.id || '') !== currentId) {
        return false;
      }
      inject(doc);
      return true;
    }

    function hide() {
      currentId = '';
      paneEl?.classList.add('hidden');
    }

    function dispose() {
      paneEl?.remove?.();
      paneEl = null;
      contentEl = null;
      currentId = '';
    }

    return {
      dispose,
      hide,
      show,
      update,
    };
  }

  return {
    createIdePreviewPane,
  };
});
