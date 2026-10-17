/* Image viewer and source-draft application bindings. */
(function (root) {
  'use strict';
  function bindImageViewer(ctx, overlayManager) {
    const documentRef = ctx.documentRef || root.document;
    let viewer = null;
    let loading = null;
    let disposed = false;
    let openGeneration = 0;
    let storage;
    try { storage = root.localStorage; } catch (_error) { /* unavailable */ }
    const drafts = root.rendererImageEditDraft?.createController({
      documentRef, windowRef: root, storage,
      getBindings: () => {
        const panes = ctx.getPaneComposition?.() || root.rendererAppPaneComposition?.getPaneComposition?.();
        if (panes?.getPaneCount?.()) return Array.from({ length: panes.getPaneCount() }, (_, id) => ({ sessionId: panes.getPaneSessionId(id), input: panes.getPane(id)?.dom?.chatInput || (id === 0 ? ctx.dom?.chatInput : null) })).filter(b => b.input);
        return [{ sessionId: ctx.state?.currentSessionId || '', input: ctx.dom?.chatInput }];
      },
      readArtifact: (sessionId, artifactId) => root.jennyShell.artifacts.read(sessionId, artifactId),
    });
    root.rendererImageEditDraftController = drafts;
    const jt = root.jennyI18n?.t || root.jennyI18nFallback || ((key, fallback) => fallback);
    const artifactMethods = { copy: 'copyImage', 'save-as': 'saveAs', open: 'openExternal', 'open-with': 'openWith', reveal: 'reveal' };
    const sourceMethods = { copy: 'copyImage', 'save-as': 'saveAs', reveal: 'reveal' };
    // One routing table for every image action: artifacts by id, attached and tool images by ref.
    function invoke(action, { kind, id, sessionId }) {
      const artifact = kind === 'artifact';
      const api = artifact ? root.jennyShell.artifacts : root.jennyShell.chatImages;
      const method = (artifact ? artifactMethods : sourceMethods)[action];
      return id && method && api?.[method] ? api[method](sessionId, artifact ? id : { kind, id }) : { ok: false, reason: 'unsupported' };
    }
    const failures = {
      copy: () => jt('shell.runtime.artifactCopyFailed', 'Could not copy the image.'),
      'save-as': () => jt('shell.runtime.artifactSaveFailed', 'Could not save the image.'),
      reveal: () => jt('chat.imageActions.revealFailed', 'Could not show the image in its folder.'),
      open: () => jt('shell.runtime.openExternallyFailed', 'Open externally failed.'),
    };
    async function ensureViewer() {
      for (const [src, name] of [
        ['renderer/chat/renderer-session-image-list.js', 'rendererSessionImageList'],
        ['renderer/inventory/image-viewer.js', 'inventoryImageViewer'],
        ['renderer/features/renderer-image-viewer.js', 'rendererImageViewer'],
      ]) {
        if (!root[name] && !await root.scriptLoaderUtils?.ensureScript({ src, isReady: () => Boolean(root[name]) })) {
          throw new Error('Image viewer could not be loaded.');
        }
      }
      if (disposed) return null;
      if (!root.rendererImageViewer?.createImageViewer) throw new Error('Image viewer unavailable');
      viewer = root.rendererImageViewer.createImageViewer({
        documentRef, windowRef: root, overlayManager,
        onEdit: (record) => drafts?.add(record) || false,
        readArtifact: (sessionId, artifactId) => root.jennyShell.artifacts.read(sessionId, artifactId),
        getCapabilities: () => root.jennyShell.artifacts.capabilities?.() || { openWith: false },
        onAction: (action, target) => invoke(action, target?.kind === 'source'
          ? { kind: target.ref?.kind, id: target.ref?.id, sessionId: target.sessionId }
          : { kind: 'artifact', id: target?.artifactId, sessionId: target?.sessionId }),
        copyText: (text) => root.jennyShell.clipboard.writeText(text),
        fallbackFocusTo: ctx.dom?.chatInput,
      });
      return viewer;
    }
    // The chat's whole image list, opened at the selected image; an unlisted artifact opens alone.
    function galleryTarget({ sessionId, select, contextNode }) {
      const items = root.rendererSessionImageList.listSessionImages(ctx.state?.messagesBySession?.get(sessionId), {
        sessionId, deletedArtifactIds: ctx.state?.artifacts?.deletedArtifactIds,
        toFileUrl: root.rendererTranscriptAttachmentsUtils.toFileAssetUrl,
      });
      const index = items.findIndex((item) => item.key === `${select.kind}:${select.id}`);
      if (index >= 0) return { items, index, contextNode };
      return select.kind === 'artifact' ? { sessionId, artifactId: select.id, contextNode } : null;
    }
    const launcher = {
      async open(target) {
        const generation = ++openGeneration;
        if (disposed) return;
        if (!loading) loading = ensureViewer().catch((error) => { loading = null; throw error; });
        const instance = await loading;
        if (disposed || generation !== openGeneration || !instance) return;
        const resolved = target?.select ? galleryTarget(target) : target;
        return resolved ? instance.open(resolved) : false;
      },
      // An image action from outside the viewer (chat tools, artifact panel), reported by toast.
      async run(action, target) {
        let result;
        try { result = await invoke(action, target || {}); } catch (_error) { result = { ok: false }; }
        const toast = ctx.callbacks?.showToastMessage;
        const key = `image-action:${action}:${target?.kind}:${target?.id}`;
        if (action === 'copy' && result?.ok) toast?.(jt('shell.runtime.artifactImageCopied', 'Image copied.'), { tone: 'info', dedupeKey: key });
        else if (!result?.ok && !result?.canceled && failures[action]) toast?.(failures[action](), { tone: 'danger', dedupeKey: key });
        return result;
      },
      close() { openGeneration += 1; viewer?.close(); },
      dispose() { disposed = true; openGeneration += 1; viewer?.dispose(); viewer = null; },
    };
    root.rendererImageViewerController = launcher;
    ctx.callbacks?.registerCleanup?.(() => {
      launcher.dispose(); drafts?.dispose();
      if (root.rendererImageEditDraftController === drafts) root.rendererImageEditDraftController = null;
      if (root.rendererImageViewerController === launcher) root.rendererImageViewerController = null;
    });
    return launcher;
  }

  root.rendererAppImageViewerBinding = { bindImageViewer };
})(window);
