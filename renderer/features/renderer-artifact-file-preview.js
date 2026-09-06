/* renderer/features/renderer-artifact-file-preview.js
 *
 * The chat rail's read-only FILE PREVIEW surface (`file_preview` rail mode).
 *
 * Shape mirrors renderer-code-review-rail.js (the other rail-mode owner):
 *   - `state.ui.filePreview` is renderer-local and never persisted (the prefs
 *     module already omits `mode` from saveArtifactReviewPreferences).
 *   - `renderRailContent(surface)` is called by the artifact manager's
 *     renderSplitDetail when mode === 'file_preview'.
 *   - click/keydown delegate off the STABLE #artifactReviewPanel container so
 *     it survives the Panel V2 innerHTML swap.
 *
 * Reads go through the EXISTING versioned workspaceFs bridge
 * (workspaceFs.readText / readImage). No new IPC channel, no preload change.
 * Those calls never throw across the seam — they resolve
 * { ok:true, ... } or { ok:false, code, error_code, message } — so every
 * failure lands in a bounded in-panel state card instead of a crash, and the
 * two rootless codes (0001 / 0008) resolve FALSE so the caller's IDE ->
 * default-app -> toast ladder still runs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-artifact-file-preview-render'));
    return;
  }
  root.rendererArtifactFilePreview = factory(root.rendererArtifactFilePreviewRender);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (filePreviewRender) {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  const render = filePreviewRender || {};
  const MAX_FILE_PREVIEW_BYTES = render.MAX_FILE_PREVIEW_BYTES || 512000;
  const MAX_FILE_PREVIEW_LINES = render.MAX_FILE_PREVIEW_LINES || 2000;
  const MARKDOWN_FENCE_EXTENSIONS = new Set(['mmd', 'mermaid']);

  function positiveInt(value) {
    const numeric = parseInt(value, 10);
    return Number.isFinite(numeric) && numeric >= 1 ? numeric : null;
  }

  function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function createArtifactFilePreview(deps) {
    const d = deps || {};
    const state = d.state;
    if (!state || typeof state !== 'object') {
      throw new Error('renderer-artifact-file-preview: state dep is required');
    }
    const windowRef = d.windowRef || globalRef.window || globalRef;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : fallbackEscapeHtml;
    const markdownUtils = d.markdownUtils || windowRef.markdownUtils || globalRef.markdownUtils || null;
    const codeHighlight = d.codeHighlight || windowRef.rendererCodeHighlight || globalRef.rendererCodeHighlight || null;
    const frameUtils = d.frameUtils || windowRef.rendererHtmlArtifactFrameUtils || globalRef.rendererHtmlArtifactFrameUtils || null;
    const pathOpenUtils = d.pathOpenUtils || windowRef.rendererChatPathOpen || globalRef.rendererChatPathOpen || null;
    const openArtifactRail = typeof d.openArtifactRail === 'function' ? d.openArtifactRail : noop;
    const renderArtifactReviewPanel = typeof d.renderArtifactReviewPanel === 'function' ? d.renderArtifactReviewPanel : noop;
    const syncArtifactReviewLayout = typeof d.syncArtifactReviewLayout === 'function' ? d.syncArtifactReviewLayout : noop;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const getWorkspaceFsApi = typeof d.getWorkspaceFsApi === 'function'
      ? d.getWorkspaceFsApi
      : function defaultGetWorkspaceFsApi() {
        return (windowRef.jennyShell && windowRef.jennyShell.workspaceFs) || null;
      };
    const panelEl = (d.dom && d.dom.artifactReviewPanel)
      || windowRef?.document?.getElementById?.('artifactReviewPanel')
      || null;

    let disposed = false;
    let bound = false;
    // Monotonic guard (renderer-ide-preview-stage.js idiom): a slower earlier
    // read must never repaint over a newer target's result.
    let renderToken = 0;
    let frameHandle = null;
    let frameSignature = '';  // "<path>::<payload.signature>" of the LIVE frame

    function disposeFrame() {
      try { frameHandle?.dispose?.(); } catch (_error) { /* already torn down */ }
      frameHandle = null;
      frameSignature = '';
    }

    // The panel's Open-in-IDE affordance re-enters the SAME cancelable
    // `ide:open-file-at-line` seam the chat timeline uses, marked preferIde so
    // renderer-chat-path-open routes it straight to the IDE instead of
    // bouncing back into this panel. Unclaimed (IDE wiring absent) degrades to
    // the OS default app, matching the chat fallback ladder.
    function defaultOpenInIde(path, line, column) {
      try {
        if (typeof windowRef.CustomEvent === 'function' && typeof windowRef.dispatchEvent === 'function') {
          const event = new windowRef.CustomEvent('ide:open-file-at-line', {
            detail: { path, line, column, preferIde: true },
            bubbles: true,
            cancelable: true,
          });
          if (windowRef.dispatchEvent(event) === false) return true;
        }
      } catch (_error) {
        /* fall through to the default-app degradation */
      }
      const api = getWorkspaceFsApi();
      if (api && typeof api.openInDefaultApp === 'function') {
        Promise.resolve(api.openInDefaultApp({ path })).catch(() => {});
        return true;
      }
      return false;
    }

    const openInIde = typeof d.openInIde === 'function' ? d.openInIde : defaultOpenInIde;

    function isOpenableRelPath(value) {
      if (pathOpenUtils && typeof pathOpenUtils.isOpenableRelPath === 'function') {
        return pathOpenUtils.isOpenableRelPath(value) === true;
      }
      // Conservative local parity guard when the chat module has not loaded.
      const path = String(value || '');
      if (!path || path.length > 512) return false;
      for (let index = 0; index < path.length; index += 1) {
        const code = path.charCodeAt(index);
        if (code <= 0x20 || code === 0x7f) return false;
      }
      if (path.charAt(0) === '/' || /^[a-zA-Z]:/.test(path)) return false;
      return path.split('/').indexOf('..') === -1;
    }

    function ensureSlot() {
      if (!state.ui || typeof state.ui !== 'object') state.ui = {};
      if (!state.ui.filePreview || typeof state.ui.filePreview !== 'object') {
        state.ui.filePreview = {
          path: '', line: null, column: null, status: 'idle', error: null, payload: null, view: 'read',
          frameFailed: false, renderBlocked: '',
        };
      }
      return state.ui.filePreview;
    }

    function isHtmlRenderEnabled() {
      // DEFAULT-ON kill switch; the renderer boot seed omits this key, so
      // undefined must read as ENABLED.
      return state?.features?.featureFlags?.file_preview_html_render !== false;
    }

    function isRenderableKind(kind) {
      if (kind === 'markdown') return true;
      return kind === 'html' && isHtmlRenderEnabled();
    }

    function isFilePreviewMode() {
      return String(state.ui?.artifactReview?.mode || '') === 'file_preview';
    }

    function resolveLanguageId(path) {
      if (codeHighlight && typeof codeHighlight.getLanguageId === 'function') {
        return String(codeHighlight.getLanguageId(path) || '');
      }
      return String(render.fileExtensionOf ? render.fileExtensionOf(path) : '');
    }

    function buildTextPayload(result, path, line) {
      if (typeof result.content !== 'string'
        || typeof result.rootId !== 'string' || !result.rootId
        || !Number.isSafeInteger(result.generation)
        || typeof result.fileVersion !== 'string' || !result.fileVersion) {
        return null;
      }
      const text = result.content;
      const windowed = render.sliceCodeWindow(text.split(/\r\n|\r|\n/), line, MAX_FILE_PREVIEW_LINES);
      return {
        kind: render.resolveFilePreviewKind(path),
        text,
        lines: windowed.lines,
        startLine: windowed.startLine,
        truncated: windowed.truncated === true || result.truncated === true,
        totalLines: windowed.totalLines,
        languageId: resolveLanguageId(path),
        signature: `${result.rootId}:${result.generation}:${result.fileVersion}`,
      };
    }

    function buildImagePayload(result, path) {
      const mime = String(result.mime || '') || String(render.imageMimeForPath?.(path) || '');
      if (typeof result.base64 !== 'string' || !result.base64 || !mime
        || typeof result.rootId !== 'string' || !result.rootId
        || !Number.isSafeInteger(result.generation)) {
        return null;
      }
      return { kind: 'image', mime, base64: result.base64, truncated: false, totalLines: 0 };
    }

    function setFailure(slot, failure) {
      slot.status = 'error';
      slot.error = failure;
      slot.payload = null;
    }

    function reset() {
      renderToken += 1;
      disposeFrame();
      const slot = ensureSlot();
      slot.path = '';
      slot.line = null;
      slot.column = null;
      slot.status = 'idle';
      slot.error = null;
      slot.payload = null;
      slot.view = 'read';
      slot.frameFailed = false;
      slot.renderBlocked = '';
    }

    // Hand the rail back to artifact mode: used when this controller cannot
    // own the target after all (rootless / root transitioning) so the caller's
    // IDE fallback runs against a rail that is not showing a dead preview.
    function resetToArtifactMode() {
      const wasPreview = isFilePreviewMode();
      reset();
      if (wasPreview && state.ui?.artifactReview && typeof state.ui.artifactReview === 'object') {
        state.ui.artifactReview.mode = 'artifact';
        syncArtifactReviewLayout();
      }
      renderArtifactReviewPanel();
    }

    function handleWorkspaceRootCommitted() {
      if (disposed) return;
      resetToArtifactMode();
    }

    async function readTarget(api, kind, path) {
      try {
        if (kind === 'image') {
          return await api.readImage({ path });
        }
        return await api.readText({ path, intent: 'preview', maxBytes: MAX_FILE_PREVIEW_BYTES });
      } catch (error) {
        // The bridge contract is non-throwing; a throw here means the seam
        // itself failed (preload torn down mid-call).
        return { ok: false, code: 'bridge_unavailable', message: String(error?.message || error || '') };
      }
    }

    async function openFilePreviewTarget(target) {
      if (disposed) return false;
      const path = render.normalizePreviewPath
        ? render.normalizePreviewPath(target?.path)
        : String(target?.path || '').trim().replace(/\\/g, '/');
      if (!path || !isOpenableRelPath(path)) return false;
      const kind = render.resolveFilePreviewKind(path);
      const api = getWorkspaceFsApi();
      const reader = kind === 'image' ? api?.readImage : api?.readText;
      if (typeof reader !== 'function') return false;

      const token = ++renderToken;
      disposeFrame();
      const line = positiveInt(target?.line);
      const column = positiveInt(target?.column);
      const slot = ensureSlot();
      slot.path = path;
      slot.line = line;
      slot.column = column;
      slot.status = 'loading';
      slot.error = null;
      slot.payload = null;
      slot.view = isRenderableKind(kind) && !line ? 'read' : 'code';
      slot.frameFailed = false;
      slot.renderBlocked = '';
      // Synchronous so the loading card paints in the same frame as the click.
      openArtifactRail('file_preview');
      renderArtifactReviewPanel();

      const result = await readTarget(api, kind, path);
      if (disposed || token !== renderToken) return true;

      if (!result || result.ok !== true) {
        const failure = render.describeFilePreviewFailure(result);
        // Codes only — never the raw path (redaction contract).
        appendClientLog('WARN', 'artifact_file_preview.read_failed', {
          code: String((result && (result.error_code || result.code)) || 'unknown'),
          kind,
          state: failure.stateKind,
        });
        if (failure.stateKind === 'root-missing' || failure.stateKind === 'root-transitioning') {
          resetToArtifactMode();
          return false;
        }
        setFailure(slot, failure);
        renderArtifactReviewPanel();
        return true;
      }

      // intent:'preview' decodes non-UTF-8 bytes as a hex sample with
      // editable:false instead of an error result — that IS the binary case,
      // and rendering the hex dump as code would defeat the bounded card.
      if (kind !== 'image' && result.editable === false) {
        appendClientLog('WARN', 'artifact_file_preview.read_failed', { code: 'binary_preview', kind, state: 'binary' });
        setFailure(slot, render.describeFilePreviewFailure({ ok: false, error_code: 'CMP-WORKSPACEFS-0013' }));
        renderArtifactReviewPanel();
        return true;
      }

      const payload = kind === 'image'
        ? buildImagePayload(result, path)
        : buildTextPayload(result, path, line);
      if (!payload) {
        appendClientLog('WARN', 'artifact_file_preview.read_failed', { code: 'invalid_payload', kind, state: 'failed' });
        setFailure(slot, render.describeFilePreviewFailure(null));
        renderArtifactReviewPanel();
        return true;
      }
      if (payload.kind === 'html' && payload.truncated === true) {
        // Truncated HTML has unclosed tags and must never render; the existing
        // truncation note + code view show instead, toggle disabled.
        slot.view = 'code';
        slot.renderBlocked = 'truncated';
      }
      slot.status = 'ready';
      slot.error = null;
      slot.payload = payload;
      renderArtifactReviewPanel();
      return true;
    }

    function getFilePreviewTarget() {
      const slot = ensureSlot();
      return slot.path ? { path: slot.path, line: slot.line, column: slot.column } : null;
    }

    function truncationNoteHtml(slot) {
      const payload = slot.payload;
      if (!payload || payload.truncated !== true) return '';
      const last = (payload.startLine || 1) + (payload.lines?.length || 0) - 1;
      return '<p class="artifact-file-preview-note">'
        + escapeHtml(`Showing lines ${payload.startLine || 1}–${last} of ${payload.totalLines || last}.`)
        + '</p>';
    }

    function markdownSourceFor(slot) {
      const extension = String(render.fileExtensionOf ? render.fileExtensionOf(slot.path) : '');
      const text = String(slot.payload?.text || '');
      // Mirrors renderer-ide-preview-stage.js: .mmd/.mermaid wrap as a mermaid
      // fence so the SAME sanitize + lazy-mermaid path renders both kinds.
      return MARKDOWN_FENCE_EXTENSIONS.has(extension) ? '```mermaid\n' + text + '\n```' : text;
    }

    function buildReadyBodyHtml(slot) {
      const payload = slot.payload;
      if (payload.kind === 'image') {
        return '<div class="artifact-file-preview-image">'
          + '<img alt="' + escapeHtml(render.fileNameOf ? render.fileNameOf(slot.path) : slot.path) + '"'
          + ' src="data:' + escapeHtml(payload.mime) + ';base64,' + escapeHtml(payload.base64) + '">'
          + '</div>';
      }
      if (payload.kind === 'html' && slot.view !== 'code' && isRenderableKind('html')
        && typeof render.buildFilePreviewFrameHostHtml === 'function') {
        return render.buildFilePreviewFrameHostHtml();
      }
      if (payload.kind === 'markdown' && slot.view !== 'code' && typeof markdownUtils?.renderMarkdown === 'function') {
        return '<div class="artifact-file-preview-doc">'
          + (markdownUtils.renderMarkdown(markdownSourceFor(slot), { frontmatter: 'metadata' }) || '')
          + '</div>';
      }
      return truncationNoteHtml(slot) + render.buildCodeListHtml({
        lines: payload.lines,
        startLine: payload.startLine,
        languageId: payload.languageId,
        citedLine: slot.line,
      }, { escapeHtml });
    }

    function buildBodyHtml(slot) {
      const kind = slot.payload?.kind || render.resolveFilePreviewKind(slot.path);
      const canToggleView = isRenderableKind(kind) && slot.status === 'ready'
        && slot.frameFailed !== true && !slot.renderBlocked;
      const note = kind === 'html' && slot.view !== 'code' && slot.status === 'ready'
        && !slot.renderBlocked && slot.frameFailed !== true
        ? (render.SELF_CONTAINED_NOTE || '') : '';
      const bar = render.buildFilePreviewBarHtml({
        path: slot.path, line: slot.line, column: slot.column, kind, view: slot.view, canToggleView, note,
      }, { escapeHtml });
      if (slot.status === 'loading') {
        return bar + render.buildFilePreviewStateHtml('loading', 'Loading preview…', { escapeHtml, openInIde: false });
      }
      if (slot.status === 'error' || !slot.payload) {
        const failure = slot.error || render.describeFilePreviewFailure(null);
        return bar + render.buildFilePreviewStateHtml(failure.stateKind, failure.message, {
          escapeHtml, openInIde: true, retry: true,
        });
      }
      return bar + buildReadyBodyHtml(slot);
    }

    function writeDetailTitle(surface) {
      const liveTitle = surface?.root?.querySelector?.('#artifactReviewDetailTitle') || surface?.detailTitle || null;
      if (!liveTitle) return;
      const textNode = liveTitle.querySelector?.('.artifact-panel-title-text') || liveTitle;
      textNode.textContent = '';
    }

    // jsdom-safe scroll (renderer-artifacts-surface-controller.js idiom).
    function setScrollContainerTop(container, top) {
      if (!container) return;
      const nextTop = Math.max(Number(top) || 0, 0);
      if (typeof container.scrollTo === 'function') {
        try {
          container.scrollTo({ top: nextTop, behavior: 'auto' });
          return;
        } catch (_error) {
          /* fall through to direct assignment */
        }
      }
      container.scrollTop = nextTop;
    }

    function scrollToCitedRow(host) {
      const row = host?.querySelector?.('.artifact-file-preview-row.is-cited');
      if (!row) return;
      const container = panelEl?.querySelector?.('.artifact-review-scroll')
        || host.closest?.('.artifact-review-scroll')
        || null;
      if (!container) return;
      const offsetTop = Number(row.offsetTop || 0);
      if (offsetTop > 0) {
        setScrollContainerTop(container, Math.max(offsetTop - 80, 0));
        return;
      }
      const containerRect = container.getBoundingClientRect?.();
      const rowRect = row.getBoundingClientRect?.();
      const base = Number(container.scrollTop || 0);
      setScrollContainerTop(container, containerRect && rowRect
        ? Math.max(base + rowRect.top - containerRect.top - 80, 0)
        : base);
    }

    function hydrate(host, slot) {
      if (slot.status !== 'ready' || !slot.payload) return;
      if (slot.payload.kind === 'html' && slot.view !== 'code') {
        mountHtmlFrame(host, slot);
        return;
      }
      if (slot.payload.kind === 'markdown' && slot.view !== 'code') {
        markdownUtils?.renderInlineMermaidBlocks?.(host.querySelector('.artifact-file-preview-doc'), { isStreaming: false });
        return;
      }
      if (slot.payload.kind !== 'image') {
        codeHighlight?.decorateCodeBlocks?.(host);
      }
    }

    function mountHtmlFrame(host, slot) {
      const frameHost = host.querySelector('[data-file-preview-frame-host]');
      if (!frameHost) return;
      if (!frameUtils || typeof frameUtils.createHtmlArtifactFrame !== 'function') {
        failFrame(slot, 'The sandboxed HTML preview frame is unavailable in this build.');
        return;
      }
      const token = renderToken;
      frameHandle = frameUtils.createHtmlArtifactFrame(frameHost, slot.payload.text, {
        requestKey: slot.path,
        sizing: 'fill',
        onFailure: (payload) => {
          if (disposed || token !== renderToken) return;
          failFrame(slot, payload?.error);
        },
      });
    }

    function failFrame(slot, errorText) {
      slot.frameFailed = true;
      // Codes/messages only, never the path (redaction contract); the error
      // text is attacker-influenced frame content, so cap it and keep it log-only.
      appendClientLog('WARN', 'artifact_file_preview.frame_failed', {
        kind: 'html',
        message: String(errorText || '').slice(0, 200),
      });
      slot.view = 'code';
      disposeFrame();
      renderArtifactReviewPanel();
    }

    function liveFrameSignature(slot) {
      return slot.status === 'ready' && slot.payload?.kind === 'html'
        && slot.view !== 'code' && slot.frameFailed !== true && !slot.renderBlocked
        ? `${slot.path}::${slot.payload.signature || ''}`
        : '';
    }

    function renderRailContent(surface) {
      if (!surface) return;
      // Mirror of the code_review branch in renderSelectedArtifactDetail:
      // every artifact-mode affordance is hidden (kept in the DOM for tab
      // order), and the shared header fields are blanked.
      surface.detailEmpty?.classList?.add('hidden');
      surface.detailPanel?.classList?.remove('hidden');
      surface.metaPane?.classList?.add('hidden');
      for (const button of [surface.saveButton, surface.revertButton, surface.revealButton,
        surface.openExternalButton, surface.deleteButton]) {
        button?.classList?.add('hidden');
      }
      surface.editorShell?.classList?.add('hidden');
      surface.dirtyBadge?.classList?.add('hidden');
      if (surface.detailKicker) surface.detailKicker.textContent = '';
      writeDetailTitle(surface);
      if (surface.detailPath) surface.detailPath.textContent = '';
      if (surface.detailStatus) surface.detailStatus.textContent = '';
      if (surface.detailMeta) surface.detailMeta.innerHTML = '';
      if (surface.detailNote) surface.detailNote.textContent = '';
      if (surface.provenanceTimeline) surface.provenanceTimeline.innerHTML = '';
      const host = surface.previewContent;
      if (!host) return;
      const slot = ensureSlot();
      host.classList?.remove('hidden');
      const nextSignature = liveFrameSignature(slot);
      if (nextSignature
        && nextSignature === frameSignature
        && host.querySelector('[data-file-preview-frame-host] iframe')) {
        // Hold the live frame: renderRailContent re-runs on every renderAll() pass.
        // Rebuilding the iframe per repaint starves its async postMessage handshake
        // and degrades a healthy document to "failed" from churn alone.
        return;
      }
      disposeFrame();
      host.innerHTML = buildBodyHtml(slot);
      frameSignature = nextSignature;
      hydrate(host, slot);
      scrollToCitedRow(host);
    }

    function setView(nextView) {
      const slot = ensureSlot();
      const normalized = nextView === 'code' ? 'code' : 'read';
      if (slot.view === normalized) return;
      slot.view = normalized;
      disposeFrame();
      renderArtifactReviewPanel();
    }

    function handleRailClick(event) {
      if (disposed || !isFilePreviewMode()) return;
      const target = event?.target;
      if (!target || typeof target.closest !== 'function') return;
      const viewButton = target.closest('[data-file-preview-view]');
      if (viewButton) {
        event.preventDefault?.();
        setView(viewButton.getAttribute('data-file-preview-view'));
        return;
      }
      const retryButton = target.closest('[data-file-preview-retry]');
      if (retryButton) {
        event.preventDefault?.();
        const current = getFilePreviewTarget();
        if (current) openFilePreviewTarget(current).catch(() => {});
        return;
      }
      const ideButton = target.closest('[data-file-preview-open-ide]');
      if (ideButton) {
        event.preventDefault?.();
        const current = getFilePreviewTarget();
        if (!current) return;
        try {
          openInIde(current.path, current.line, current.column);
        } catch (error) {
          appendClientLog('WARN', 'artifact_file_preview.open_in_ide_failed', {
            message: String(error?.message || error || ''),
          });
        }
      }
    }

    function handleRailKeydown(event) {
      if (disposed || !isFilePreviewMode()) return;
      const key = String(event?.key || '');
      if (key !== 'Enter' && key !== ' ') return;
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (!target.closest('[data-file-preview-view], [data-file-preview-retry], [data-file-preview-open-ide]')) return;
      handleRailClick(event);
    }

    function bind() {
      if (bound || !panelEl || typeof panelEl.addEventListener !== 'function') return;
      bound = true;
      panelEl.addEventListener('click', handleRailClick);
      panelEl.addEventListener('keydown', handleRailKeydown);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      renderToken += 1;
      disposeFrame();
      if (bound && panelEl && typeof panelEl.removeEventListener === 'function') {
        panelEl.removeEventListener('click', handleRailClick);
        panelEl.removeEventListener('keydown', handleRailKeydown);
      }
      bound = false;
    }

    return {
      bind,
      dispose,
      openFilePreviewTarget,
      renderRailContent,
      handleRailClick,
      handleRailKeydown,
      getFilePreviewTarget,
      handleWorkspaceRootCommitted,
      reset,
    };
  }

  return { createArtifactFilePreview };
});
