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
    // Row 91: Edit prompt and the undrawn /image restore, against the composer that shows the chat.
    const imagePrompts = root.rendererImagePrompt?.createController({
      state: ctx.state,
      getInput: (sessionId) => drafts?.inputFor?.(sessionId) || null,
      repaint: () => ctx.callbacks?.renderAttachmentTray?.(),
      syncInput: (input) => input.dispatchEvent(new root.Event('input', { bubbles: true })),
      setNotice: (_sessionId, text) => ctx.callbacks?.setComposerStatusNotice?.(text, { owner: 'image-prompt:not-drawn', tone: 'info' }),
      log: ctx.callbacks?.appendClientLog,
    });
    if (ctx.state && imagePrompts) ctx.state.imagePromptController = imagePrompts;
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
      pin: () => jt('board.pin.error.failed', 'Could not pin that'),
    };
    // Pin to board (row 150 slice C5): the picture is named by session and id only, as Copy and Save as name it.
    function pinPicture(target) {
      const ref = { kind: target?.kind, id: target?.id, sessionId: target?.sessionId };
      const buttons = Array.from(documentRef?.querySelectorAll?.('[data-image-action="pin"]') || []);
      const anchorEl = buttons.find((el) => el.dataset.imageId === ref.id && el.dataset.sessionId === ref.sessionId) || null;
      const opened = root.rendererChatMessageActionBindings?.openPinMenu?.({
        state: ctx.state, windowRef: root, anchorEl, rootEl: documentRef?.body, item: { kind: 'image', ref }, sessionId: ref.sessionId,
      });
      return { ok: opened === true };
    }
    // Show in chat: the chat that holds the image, as a pane target (pane 1 and later) or pane 0 when it is the current chat.
    let highlighted = null;
    function clearHighlight() {
      if (!highlighted) return;
      root.clearTimeout?.(highlighted.timer);
      highlighted.entry.classList.remove('chat-citation-target-highlight');
      highlighted = null;
    }
    function jumpTarget(item) {
      const messageId = String(item?.messageId ?? '');
      const sessionId = String(item?.sessionId ?? '');
      if (!messageId || !sessionId) return null;
      const panes = root.rendererAppPaneComposition?.getPaneComposition?.() || ctx.getPaneComposition?.();
      const pane = panes?.getSessionPaneTarget?.(sessionId);
      if (pane?.scrollMessageIntoView) return { messageId, scroll: pane.scrollMessageIntoView, timeline: pane.chatTimeline };
      const paneZero = root.rendererPaneVisibilityUtils?.resolvePaneSessionId?.(ctx.state, 0) ?? ctx.state?.currentSessionId;
      if (sessionId !== paneZero || typeof ctx.callbacks?.scrollMessageIntoView !== 'function') return null;
      return { messageId, scroll: ctx.callbacks.scrollMessageIntoView, timeline: ctx.dom?.chatTimeline };
    }
    function showInChat(item) {
      const target = jumpTarget(item);
      if (!target) return;
      let scrolled = false;
      try { scrolled = Boolean(target.scroll(target.messageId, { block: 'center', followLatest: false, reason: 'image_viewer_jump' })); } catch (_error) { /* reported below */ }
      const escaped = typeof root.CSS?.escape === 'function' ? root.CSS.escape(target.messageId) : target.messageId.replace(/["\\]/g, '\\$&');
      const node = !scrolled || !target.timeline ? null
        : root.rendererTurnShell?.resolveVisibleMessageDomTarget?.(target.timeline, target.messageId) || target.timeline.querySelector?.(`[data-message-id="${escaped}"]`);
      const entry = node?.closest?.('.chat-entry, .chat-row') || node || null;
      if (!entry) {
        ctx.callbacks?.showToastMessage?.(jt('imageViewer.messageGone', 'That message is no longer in this chat.'), { tone: 'info', dedupeKey: 'image-viewer:message-gone' });
        return;
      }
      clearHighlight();
      entry.classList.add('chat-citation-target-highlight');
      highlighted = { entry, timer: root.setTimeout(clearHighlight, 2200) };
      if (!entry.hasAttribute('tabindex')) entry.setAttribute('tabindex', '-1');
      entry.focus({ preventScroll: true });
    }
    async function ensureViewer() {
      for (const [src, name] of [
        ['renderer/chat/renderer-session-image-list.js', 'rendererSessionImageList'],
        ['renderer/inventory/image-viewer.js', 'inventoryImageViewer'],
        ['renderer/features/renderer-image-viewer-strip.js', 'rendererImageViewerStrip'],
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
        // A picture the chat already holds opens from that copy; only an uncached one is read.
        readArtifact: (sessionId, artifactId) => {
          const cached = root.rendererArtifactCardUtils?.peekArtifactImage?.(sessionId, artifactId);
          return typeof cached === 'string' && cached ? { asset_data_url: cached } : root.jennyShell.artifacts.read(sessionId, artifactId);
        },
        getThumbnail: (item) => (item?.kind === 'artifact'
          ? root.rendererArtifactCardUtils?.peekArtifactImage?.(item.sessionId, item.artifactId) || '' : item?.src || ''),
        canShowInChat: (item) => Boolean(jumpTarget(item)),
        onShowInChat: (item) => showInChat(item),
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
        if (action === 'pin') result = pinPicture(target);
        else { try { result = await invoke(action, target || {}); } catch (_error) { result = { ok: false }; } }
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
      launcher.dispose(); drafts?.dispose(); clearHighlight();
      if (imagePrompts && ctx.state?.imagePromptController === imagePrompts) ctx.state.imagePromptController = null;
      if (root.rendererImageEditDraftController === drafts) root.rendererImageEditDraftController = null;
      if (root.rendererImageViewerController === launcher) root.rendererImageViewerController = null;
    });
    return launcher;
  }

  root.rendererAppImageViewerBinding = { bindImageViewer };
})(window);
