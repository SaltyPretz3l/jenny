/* renderer/features/renderer-ide-preview-stage.js — the unified Preview STAGE
 * surface (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md Phase 4,
 * workspace_preview_surface). Renders a workspace file into the keep-alive
 * #idePreviewHost stage sibling:
 *   - md / markdown / mmd / mermaid → the chat's existing sanitized markdown
 *     pipeline (marked + DOMPurify + lazy mermaid runtime — never a second
 *     mermaid load), live-updating from the Monaco buffer (200ms debounce);
 *   - html / htm → ALWAYS the strict sandboxed-iframe path
 *     (renderer-html-artifact-frame-utils.js: staged jenny-artifact:// src +
 *     sandbox="allow-scripts", CSP default-src 'none') — NEVER the DOMPurify
 *     inline artifact path.
 *     v1 previews self-contained documents only; the chrome states that
 *     external CSS/JS/images/network are not loaded. Buffer edits rebuild the
 *     frame on a longer debounce so the postMessage height handshake can
 *     settle (the artifact renderer's churn lesson); a busy/never-reporting
 *     frame lands in a bounded "stopped responding" state via the frame
 *     factory's own timeout.
 *   - everything else (unsupported / missing / binary / too large) → an
 *     explicit bounded state, never injected into a renderer.
 *
 * Display precedence (handoff §C.3): explicit target (ide.previewPath, set by
 * open() or workspace_present) > the active editor file when previewable >
 * an empty pick-a-file state. Artifact reuse is out of v1 scope (no trivial
 * existing state reaches this surface without new public API).
 *
 * Visibility is owned by the stage-surface controller (sync(active) is called
 * from its sync()); this module only owns the host's CONTENT. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePreviewStage = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  // Kept in sync BY CONVENTION with the main-process previewable gate in
  // services/tools/builtin/workspace-present-tool.js (services cannot import
  // renderer UMD modules — the RAIL_PANELS mirroring precedent).
  const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mmd', 'mermaid']);
  const HTML_EXTENSIONS = new Set(['html', 'htm']);
  // Derived from the Sets above so the unsupported-state copy can't drift
  // from what kindOf() actually accepts.
  const SUPPORTED_LABEL = `Markdown (${[...MARKDOWN_EXTENSIONS].map((ext) => `.${ext}`).join(', ')}) and self-contained HTML (${[...HTML_EXTENSIONS].map((ext) => `.${ext}`).join(', ')})`;
  const MAX_PREVIEW_BYTES = 1_500_000;
  const previewUtf8Encoder = new globalRef.TextEncoder();
  const MARKDOWN_DEBOUNCE_MS = 200;
  // HTML rebuilds replace the sandboxed iframe (its handshake is async), so
  // they debounce longer than markdown to leave it an uninterrupted window.
  const HTML_DEBOUNCE_MS = 600;

  const SELF_CONTAINED_NOTE = 'Self-contained preview — external stylesheets, scripts, images, and network requests are not loaded.';

  function createIdePreviewStage(deps) {
    const d = deps || {};
    const getDom = typeof d.getDom === 'function' ? d.getDom : () => ({});
    const getIde = typeof d.getIde === 'function' ? d.getIde : () => ({});
    const ideStateUtils = d.ideStateUtils || {};
    const editorHost = d.editorHost || null;
    const getWorkspaceFsApi = typeof d.getWorkspaceFsApi === 'function' ? d.getWorkspaceFsApi : () => null;
    const getFileOperations = typeof d.getFileOperations === 'function' ? d.getFileOperations : () => null;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : (v) => String(v == null ? '' : v);
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const activateStage = typeof d.activateStage === 'function' ? d.activateStage : noop;
    const schedulePersist = typeof d.schedulePersist === 'function' ? d.schedulePersist : noop;
    const windowRef = d.windowRef || globalRef.window || globalRef;
    const markdownUtils = resolveModule('markdownUtils', '../shared/markdown-utils');
    const frameUtils = resolveModule('rendererHtmlArtifactFrameUtils', './renderer-html-artifact-frame-utils');

    let disposed = false;
    let mounted = false;
    let barEl = null;
    let bodyEl = null;
    let frameHandle = null;
    let renderToken = 0;
    let lastRenderedSignature = '';
    let lastRequestedSignature = '';
    let pendingRequestSignature = '';
    let debounceTimer = null;
    let diskRevisionPath = '';
    let diskRevision = 0;

    function extensionOf(path) {
      return typeof ideStateUtils.fileExtensionOf === 'function'
        ? ideStateUtils.fileExtensionOf(path)
        : '';
    }

    function kindOf(path) {
      const extension = extensionOf(path);
      if (MARKDOWN_EXTENSIONS.has(extension)) {
        return 'markdown';
      }
      if (HTML_EXTENSIONS.has(extension)) {
        return 'html';
      }
      return '';
    }

    function isPreviewablePath(path) {
      return !!path && !String(path).includes('://') && kindOf(path) !== '';
    }

    // Handoff §C.3 precedence: explicit target > active editor file > none.
    function resolveDisplayPath() {
      const ide = getIde() || {};
      const explicit = String(ide.previewPath || '');
      if (explicit && isPreviewablePath(explicit)) {
        return explicit;
      }
      const active = String(ide.activeTabPath || '');
      return isPreviewablePath(active) ? active : '';
    }

    function ensureMounted() {
      if (mounted || disposed) {
        return;
      }
      const hostEl = (getDom() || {}).idePreviewHost;
      if (!hostEl || !hostEl.ownerDocument) {
        return;
      }
      const documentRef = hostEl.ownerDocument;
      hostEl.innerHTML = '';
      barEl = documentRef.createElement('div');
      barEl.className = 'ide-preview-stage-bar';
      bodyEl = documentRef.createElement('div');
      bodyEl.className = 'ide-preview-stage-body';
      hostEl.appendChild(barEl);
      hostEl.appendChild(bodyEl);
      mounted = true;
    }

    function disposeFrame() {
      frameHandle?.dispose?.();
      frameHandle = null;
    }

    function renderBar(path, kind, note) {
      if (!barEl) {
        return;
      }
      const name = path
        ? escapeHtml(typeof ideStateUtils.fileNameOf === 'function' ? ideStateUtils.fileNameOf(path) : path)
        : '';
      const title = path
        ? `<span class="ide-preview-stage-name" title="${escapeHtml(path)}">${name}</span>`
        : '<span class="ide-preview-stage-name ide-preview-stage-name--empty">Preview</span>';
      const chip = kind
        ? `<span class="ide-preview-stage-kind">${escapeHtml(kind === 'html' ? 'Sandboxed HTML' : 'Markdown')}</span>`
        : '';
      const noteHtml = note
        ? `<span class="ide-preview-stage-note" data-preview-note>${escapeHtml(note)}</span>`
        : '';
      barEl.innerHTML = title + chip + noteHtml;
    }

    // Bounded state card. Every non-render outcome routes here — nothing
    // unsupported/binary/oversized is ever injected into a renderer.
    function renderState(path, stateKind, message) {
      renderBar(path, '', '');
      if (!bodyEl) {
        return;
      }
      disposeFrame();
      bodyEl.innerHTML = `<div class="ide-preview-stage-state" data-preview-state="${escapeHtml(stateKind)}">${escapeHtml(message)}</div>`;
    }

    // Mirrors renderer-ide-preview-controller.js buildPreviewHtml (the two are
    // kept in sync by convention): .mmd/.mermaid wraps as a mermaid fence so
    // the SAME sanitize + lazy-mermaid path renders both kinds.
    function buildMarkdownHtml(path, text) {
      const extension = extensionOf(path);
      const source = extension === 'mmd' || extension === 'mermaid'
        ? `\`\`\`mermaid\n${String(text || '')}\n\`\`\``
        : String(text || '');
      if (typeof markdownUtils.renderMarkdown !== 'function') {
        return '';
      }
      const options = extension === 'md' || extension === 'markdown'
        ? { frontmatter: 'metadata' }
        : undefined;
      return markdownUtils.renderMarkdown(source, options) || '';
    }

    async function readSource(path) {
      if (editorHost?.hasDocument?.(path)) {
        return { ok: true, text: String(editorHost.getValue(path) || ''), editable: true };
      }
      try {
        const operations = getFileOperations();
        let payload = null;
        if (operations?.beginPreview && operations?.readForPreview) {
          const intent = operations.beginPreview(path);
          const read = await operations.readForPreview(intent, { maxBytes: MAX_PREVIEW_BYTES });
          if (read.stale || !read.payload) return { ok: false, reason: 'stale' };
          payload = read.payload;
        } else {
          // Compatibility until composition supplies the shared owner. This
          // remains versioned/bounded and never falls back to raw readFile.
          const api = getWorkspaceFsApi();
          if (typeof api?.readText !== 'function') return { ok: false, reason: 'unavailable' };
          payload = await api.readText({ path, intent: 'preview', maxBytes: MAX_PREVIEW_BYTES });
          if (!payload
            || payload.ok !== true
            || typeof payload.content !== 'string'
            || typeof payload.rootId !== 'string'
            || !payload.rootId
            || !Number.isSafeInteger(payload.generation)
            || typeof payload.fileVersion !== 'string'
            || !payload.fileVersion) return { ok: false, reason: 'invalid' };
        }
        return {
          ok: true,
          text: payload.content,
          // Propagated uncoerced: readForPreview's payload always carries the
          // decoder's real editable value, but the compat branch's raw bridge
          // payload may omit the field entirely — only an explicit `false`
          // (never a missing/undefined field) may route to the binary state.
          editable: payload.editable,
          signature: `${payload.rootId}:${payload.generation}:${payload.pathKey}:${payload.fileVersion}`,
        };
      } catch (error) {
        appendClientLog('WARN', 'ide_preview_stage.read_failed', {
          message: String(error?.message || error || ''),
        });
        return { ok: false, reason: 'missing' };
      }
    }

    function signatureFor(path) {
      const buffered = editorHost?.hasDocument?.(path) === true;
      const operations = getFileOperations();
      let version;
      if (buffered) {
        version = editorHost.getAltVersionId?.(path) || 0;
      } else {
        if (diskRevisionPath !== path) {
          diskRevisionPath = path;
          diskRevision = 0;
        }
        version = operations?.getPreviewRequestSignature?.(path) || `disk-${diskRevision}`;
      }
      return `${kindOf(path)}::${path}::${version}`;
    }

    function completeRequest(requestSignature, renderedSignature = requestSignature) {
      if (pendingRequestSignature === requestSignature) pendingRequestSignature = '';
      lastRequestedSignature = requestSignature;
      lastRenderedSignature = renderedSignature;
    }

    async function renderPath(path) {
      const token = ++renderToken;
      const requestSignature = path ? signatureFor(path) : 'empty';
      pendingRequestSignature = requestSignature;
      if (!path) {
        completeRequest(requestSignature);
        renderState('', 'empty', 'Select a Markdown, Mermaid, or HTML file to preview — right-click a file and choose "Open Preview", or open one in the editor.');
        return;
      }
      const kind = kindOf(path);
      if (!kind) {
        completeRequest(requestSignature);
        renderState(path, 'unsupported', `“${path}” can’t be previewed — supported: ${SUPPORTED_LABEL}.`);
        return;
      }
      const source = await readSource(path);
      if (disposed || token !== renderToken) {
        if (pendingRequestSignature === requestSignature) pendingRequestSignature = '';
        return;
      }
      if (source.reason === 'stale') {
        if (pendingRequestSignature === requestSignature) pendingRequestSignature = '';
        return;
      }
      if (!source.ok) {
        completeRequest(requestSignature);
        renderState(path, 'missing', `“${path}” could not be read — it may have been deleted, renamed, or the workspace is unavailable.`);
        return;
      }
      const text = source.text;
      if (previewUtf8Encoder.encode(text).length > MAX_PREVIEW_BYTES) {
        completeRequest(requestSignature);
        renderState(path, 'too-large', `“${path}” is too large to preview safely.`);
        return;
      }
      // The main-process decoder (services/versioned-workspace-file-encoding.js)
      // decodes non-UTF-8 bytes as a hex sample with editable:false instead of
      // throwing — that hex dump IS the binary case, but its bytes are
      // rendered as printable ASCII (`89 50 4e 47 ...`), so the \0 sniff below
      // never trips on it. editable===false is checked first as the real
      // binary signal; \0 stays as a belt-and-braces catch for any source
      // that reaches here with a literal embedded NUL.
      if (source.editable === false || text.includes('\0')) {
        completeRequest(requestSignature);
        appendClientLog('WARN', 'ide_preview_stage.binary_blocked', {
          kind,
          reason: source.editable === false ? 'non_utf8' : 'null_byte',
        });
        renderState(path, 'binary', `“${path}” looks like a binary or non-UTF-8 file and can’t be previewed.`);
        return;
      }
      completeRequest(requestSignature, source.signature || requestSignature);
      if (!bodyEl) {
        return;
      }
      if (kind === 'markdown') {
        disposeFrame();
        renderBar(path, 'markdown', '');
        bodyEl.innerHTML = `<div class="ide-preview-content">${buildMarkdownHtml(path, text)}</div>`;
        // The chat's lazy mermaid pass (single shared runtime).
        markdownUtils.renderInlineMermaidBlocks?.(bodyEl.firstElementChild, { isStreaming: false });
        return;
      }
      // kind === 'html': strict sandboxed iframe only. The frame factory owns
      // the handshake timeout; its onFailure lands the bounded state.
      renderBar(path, 'html', SELF_CONTAINED_NOTE);
      disposeFrame();
      bodyEl.innerHTML = '<div class="ide-preview-frame-host" data-preview-frame-host></div>';
      const frameHost = bodyEl.firstElementChild;
      if (!frameUtils || typeof frameUtils.createHtmlArtifactFrame !== 'function') {
        renderState(path, 'unavailable', 'The sandboxed HTML preview frame is unavailable in this build.');
        return;
      }
      frameHandle = frameUtils.createHtmlArtifactFrame(frameHost, text, {
        requestKey: path,
        sizing: 'fill',
        onFailure: (payload) => {
          if (disposed || token !== renderToken) {
            return;
          }
          // Relay the frame's own error text (script exceptions, staging
          // failures) so a broken artifact names its defect instead of the
          // generic card. renderState escapes the whole message — the text is
          // attacker-influenced frame content.
          const detail = typeof payload?.error === 'string' && payload.error.trim()
            ? ` (${payload.error.trim().slice(0, 200)})`
            : '';
          renderState(path, 'frame-failed', `The preview for “${path}” stopped responding or failed to render${detail}. Its scripts may be busy, or the document may rely on external resources that sandboxed previews never load.`);
        },
      });
    }

    // Explicit open (context menu, workspace_present): pin the target and
    // bring the Preview surface on stage. Returns the normalized target.
    function open(path) {
      if (disposed) {
        return '';
      }
      const applied = typeof ideStateUtils.setPreviewPath === 'function'
        ? ideStateUtils.setPreviewPath(getIde(), path)
        : '';
      schedulePersist();
      activateStage('preview');
      return applied;
    }

    // Called from the stage-surface controller's sync() on every renderIde.
    // Content re-renders only when the resolved target/version changed; a
    // hidden pass keeps the last DOM (keep-alive, like the map host).
    function sync(active) {
      if (disposed || active !== true) {
        return;
      }
      ensureMounted();
      if (!mounted) {
        return;
      }
      const path = resolveDisplayPath();
      const signature = path ? signatureFor(path) : 'empty';
      if ((signature === lastRequestedSignature && Boolean(lastRenderedSignature))
        || signature === pendingRequestSignature) {
        return;
      }
      renderPath(path);
    }

    // Editor-buffer live updates (wired from the controller's onModelChange
    // choke point). Markdown keeps the W8 200ms debounce; HTML rebuilds the
    // iframe on a longer one so the handshake can settle between keystrokes.
    function handleModelChange(path) {
      if (disposed || !path || resolveDisplayPath() !== path) {
        return;
      }
      const ide = getIde() || {};
      if (ideStateUtils.coerceStageSurface?.(ide.activeStageSurface) !== 'preview') {
        return;
      }
      const delay = kindOf(path) === 'html' ? HTML_DEBOUNCE_MS : MARKDOWN_DEBOUNCE_MS;
      if (debounceTimer) {
        windowRef.clearTimeout(debounceTimer);
      }
      debounceTimer = windowRef.setTimeout(() => {
        debounceTimer = null;
        if (!disposed) {
          renderPath(resolveDisplayPath());
        }
      }, delay);
    }

    function handleExternalChange(change) {
      const path = typeof ideStateUtils.normalizeIdeRelativePath === 'function'
        ? ideStateUtils.normalizeIdeRelativePath(change?.relPath)
        : String(change?.relPath || '');
      if (!path) return;
      if (disposed || editorHost?.hasDocument?.(path) || resolveDisplayPath() !== path) return;
      if (diskRevisionPath !== path) {
        diskRevisionPath = path;
        diskRevision = 0;
      }
      diskRevision += 1;
      const ide = getIde() || {};
      if (ideStateUtils.coerceStageSurface?.(ide.activeStageSurface) !== 'preview') return;
      lastRequestedSignature = '';
      renderPath(path);
    }

    function handleWorkspaceRootCommitted() {
      renderToken += 1;
      getFileOperations()?.cancelPreviewIntents?.();
      lastRenderedSignature = '';
      lastRequestedSignature = '';
      pendingRequestSignature = '';
      diskRevisionPath = '';
      diskRevision = 0;
      disposeFrame();
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      renderToken += 1;
      getFileOperations()?.cancelPreviewIntents?.();
      if (debounceTimer) {
        windowRef.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      disposeFrame();
      barEl = null;
      bodyEl = null;
      mounted = false;
    }

    return {
      dispose,
      handleExternalChange,
      handleModelChange,
      handleWorkspaceRootCommitted,
      isPreviewablePath,
      open,
      sync,
    };
  }

  return {
    MAX_PREVIEW_BYTES,
    SELF_CONTAINED_NOTE,
    SUPPORTED_LABEL,
    createIdePreviewStage,
  };
});
