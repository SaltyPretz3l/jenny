/* global document, window */
/* renderer/features/renderer-attachment-event-utils.js - Attachment tray, paste/capture, and drag/drop bindings. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let composerFlowUtils = {};
    try { composerFlowUtils = require('../chat/renderer-composer-flow-utils'); } catch (_error) { /* Optional in CommonJS tests. */ }
    module.exports = factory(composerFlowUtils);
    return;
  }
  root.rendererAttachmentEventUtils = factory(root.rendererComposerFlowUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (composerFlowUtils) {
  function createAttachmentEventBindings(deps) {
    const { state } = deps;
    const {
      attachmentTray,
      composerSettingsPopover,
      composerSettingsButton,
      composerCommandPopover,
      composerTerminalShortcut,
      composerAttachShortcut,
      chatInput,
      chatView,
      attachFilesButton,
      captureScreenButton,
    } = deps.dom;
    const { TOAST_SOURCE } = deps.constants;
    const {
      resetAttachmentQueue,
      removeQueuedAttachment,
      renderAttachmentTray,
      suppressFileDropNavigation,
      setDropActive,
      prepareDroppedAttachments,
      getDroppedFilePaths,
      renderComposerPopover,
      renderCommandPopover,
      syncComposerModelSelectWidth,
      updateComposerSafeOffset,
      closeComposerPopover,
      closeCommandPopover,
      queueInlineImageAttachment,
      handleAttachmentPicker,
      beginAttachmentToken = () => null,
      cancelAttachmentToken = () => false,
      showToastMessage,
      toErrorMessage,
      appendClientLog = function noopAppendClientLog() {},
    } = deps.callbacks;
    const globalDropEvents = ['dragenter', 'dragover', 'dragleave', 'drop'];
    const chatDropEnterEvents = ['dragenter', 'dragover'];
    const cleanupFns = [];
    const attachmentTokens = new Set();
    let commandTypeahead = '';
    let commandTypeaheadTimer = 0;
    let bound = false;
    let disposed = false;

    function beginTrackedAttachmentToken() {
      const token = beginAttachmentToken();
      if (token) { attachmentTokens.add(token); }
      return token;
    }

    function settleAttachmentToken(token, cancel = false) {
      if (!token) { return; }
      attachmentTokens.delete(token);
      if (cancel) { cancelAttachmentToken(token); }
    }

    // Logging must never break the paste/attach flow.
    function safeLog(level, event, data) {
      try { appendClientLog(level, event, data); } catch (_error) { /* noop */ }
    }

    async function handleClipboardImagePaste(event) {
      const clipboardItems = event.clipboardData?.items ? [...event.clipboardData.items] : [];
      const types = Array.from(event.clipboardData?.types || []);
      const imageItem = clipboardItems.find((item) => String(item?.type || '').startsWith('image/'));
      safeLog('DEBUG', 'composer.paste.received', { types, itemCount: clipboardItems.length, fileCount: event.clipboardData?.files?.length || 0, hasImage: Boolean(imageItem) });
      if (!imageItem) {
        return;
      }
      const file = typeof imageItem.getAsFile === 'function' ? imageItem.getAsFile() : null;
      if (!file) {
        safeLog('WARN', 'composer.paste.image_item_no_file', { type: imageItem.type });
        return;
      }
      event.preventDefault();
      const token = beginTrackedAttachmentToken();
      const displayName =
        String(file.name || '').trim()
        || `Pasted Image ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        safeLog('INFO', 'composer.paste.image_decoded', { mimeType: file.type || 'image/png', sizeBytes: bytes.byteLength, displayName });
        const saved = await queueInlineImageAttachment({
          bytes,
          mimeType: file.type || 'image/png',
          displayName,
          sourceKind: 'clipboard',
        }, token);
        const bindingActive = !disposed && attachmentTokens.has(token);
        safeLog('INFO', 'composer.paste.saved', { id: saved?.id || '', sizeBytes: saved?.sizeBytes ?? null, bindingActive });
        settleAttachmentToken(token);
        if (bindingActive) { closeComposerPopover(); }
      } catch (error) {
        safeLog('WARN', 'composer.paste.failed', { message: error?.message || String(error) });
        settleAttachmentToken(token, true);
        throw error;
      }
    }

    function getClipboardText(event) {
      if (!event?.clipboardData || typeof event.clipboardData.getData !== 'function') {
        return '';
      }
      return String(event.clipboardData.getData('text/plain') || '');
    }

    function guardNativeTextPaste(event) {
      const text = getClipboardText(event);
      if (!text || typeof composerFlowUtils?.guardComposerTextPaste !== 'function') {
        return true;
      }
      const result = composerFlowUtils.guardComposerTextPaste(text, {
        source: 'native',
        appendClientLog,
        showToastMessage,
        toastSource: TOAST_SOURCE.composerAction || TOAST_SOURCE.attachments,
      });
      if (!result.allowed) {
        event.preventDefault();
        return false;
      }
      return true;
    }

    async function handleScreenCaptureRequest() {
      const token = beginTrackedAttachmentToken();
      const getDisplayMedia = navigator?.mediaDevices?.getDisplayMedia;
      if (typeof getDisplayMedia !== 'function') {
        settleAttachmentToken(token, true);
        throw new Error('Screen capture is not available in this environment.');
      }
      let stream = null;
      try {
        stream = await getDisplayMedia.call(navigator.mediaDevices, {
          video: true,
          audio: false,
        });
        const [track] = Array.isArray(stream?.getVideoTracks?.()) ? stream.getVideoTracks() : [];
        if (!track) {
          throw new Error('No video track was returned from screen capture.');
        }
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        if (video.readyState < 2) {
          await new Promise((resolve) => {
            video.onloadedmetadata = () => resolve();
          });
        }
        const width = Math.max(Number(video.videoWidth || track.getSettings?.().width || 0), 1);
        const height = Math.max(Number(video.videoHeight || track.getSettings?.().height || 0), 1);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('Could not create a screen capture canvas.');
        }
        context.drawImage(video, 0, 0, width, height);
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((value) => {
            if (value) {
              resolve(value);
              return;
            }
            reject(new Error('Could not serialize the captured screen.'));
          }, 'image/png');
        });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await queueInlineImageAttachment({
          bytes,
          mimeType: 'image/png',
          displayName: `Screen Capture ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`,
          sourceKind: 'capture',
        }, token);
        const bindingActive = !disposed && attachmentTokens.has(token);
        settleAttachmentToken(token);
        if (bindingActive) { closeComposerPopover(); }
      } catch (error) {
        settleAttachmentToken(token, true);
        throw error;
      } finally {
        if (typeof stream?.getTracks === 'function') {
          stream.getTracks().forEach((entry) => entry.stop());
        }
      }
    }

    function registerListener(target, eventName, handler, options) {
      if (!target || typeof target.addEventListener !== 'function') {
        return;
      }
      target.addEventListener(eventName, handler, options);
      cleanupFns.push(() => {
        target.removeEventListener(eventName, handler, options);
      });
    }

    function handleAttachmentTrayClick(event) {
      const removeButton = event.target.closest('[data-attachment-remove]');
      if (removeButton) {
        removeQueuedAttachment(removeButton.dataset.attachmentRemove);
        return;
      }

      const clearButton = event.target.closest('[data-attachment-clear]');
      if (clearButton) {
        resetAttachmentQueue();
        renderAttachmentTray();
      }
    }

    function handleAttachmentTrayKeydown(event) {
      const removeButton = event.target.closest('[data-attachment-remove], [data-attachment-clear]');
      if (!removeButton || (event.key !== 'Delete' && event.key !== 'Backspace')) {
        return;
      }
      event.preventDefault();
      removeButton.click();
    }

    function handleDocumentMouseDown(event) {
      const target = event?.target || null;
      const hasComposerPopoverTargets =
        composerSettingsPopover
        && composerSettingsButton
        && typeof composerSettingsPopover.contains === 'function'
        && typeof composerSettingsButton.contains === 'function';
      const hasCommandPopoverTargets =
        composerCommandPopover
        && composerTerminalShortcut
        && typeof composerCommandPopover.contains === 'function'
        && typeof composerTerminalShortcut.contains === 'function';
      if (state.ui.composerPopoverOpen) {
        if (!hasComposerPopoverTargets) {
          closeComposerPopover();
        } else if (
          !composerSettingsPopover.contains(target) &&
          !composerSettingsButton.contains(target)
        ) {
          closeComposerPopover();
        }
      }
      if (state.ui.commandPopoverOpen) {
        if (!hasCommandPopoverTargets) {
          closeCommandPopover();
        } else if (
          !composerCommandPopover.contains(target) &&
          !composerTerminalShortcut.contains(target)
        ) {
          closeCommandPopover();
        }
      }
    }

    function trapTabInPopover(event, container) {
      if (!container || typeof container.querySelectorAll !== 'function') {
        return;
      }
      const focusable = container.querySelectorAll(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function getCommandMenuItems() {
      if (!composerCommandPopover || typeof composerCommandPopover.querySelectorAll !== 'function') return [];
      return [...composerCommandPopover.querySelectorAll('[role="menuitem"][data-command-name]')];
    }

    function focusCommandMenuItem(items, index) {
      if (!items.length) return;
      const normalized = (index + items.length) % items.length;
      items.forEach((item, itemIndex) => { item.tabIndex = itemIndex === normalized ? 0 : -1; });
      items[normalized].focus?.();
    }

    function handleCommandMenuKeydown(event) {
      const items = getCommandMenuItems();
      if (!items.length) return false;
      const activeIndex = Math.max(items.indexOf(document.activeElement), 0);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusCommandMenuItem(items, activeIndex + 1);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusCommandMenuItem(items, activeIndex - 1);
        return true;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        focusCommandMenuItem(items, 0);
        return true;
      }
      if (event.key === 'End') {
        event.preventDefault();
        focusCommandMenuItem(items, items.length - 1);
        return true;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        commandTypeahead += event.key.toLowerCase();
        if (commandTypeaheadTimer) window.clearTimeout(commandTypeaheadTimer);
        commandTypeaheadTimer = window.setTimeout(() => {
          commandTypeahead = '';
          commandTypeaheadTimer = 0;
        }, 500);
        const matchIndex = items.findIndex((item) => (
          String(item.dataset.commandName || '').replace(/^\//, '').toLowerCase().startsWith(commandTypeahead)
        ));
        if (matchIndex >= 0) {
          event.preventDefault();
          focusCommandMenuItem(items, matchIndex);
        }
        return matchIndex >= 0;
      }
      return false;
    }

    function handleDocumentKeydown(event) {
      if (
        event.defaultPrevented
        || event.isComposing === true
        || event.keyCode === 229
      ) {
        return;
      }
      if (event.key === 'Escape' && state.ui.commandPopoverOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeCommandPopover({ restoreFocus: true });
        return;
      }
      if (state.ui.commandPopoverOpen && handleCommandMenuKeydown(event)) {
        return;
      }
      if (event.key === 'Escape' && state.ui.composerPopoverOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeComposerPopover({ restoreFocus: true });
        return;
      }
      if (event.key === 'Tab' && state.ui.commandPopoverOpen) {
        closeCommandPopover();
        return;
      }
      if (event.key === 'Tab' && state.ui.composerPopoverOpen) {
        trapTabInPopover(event, composerSettingsPopover);
        return;
      }
    }

    function handleWindowResize() {
      if (state.ui.composerPopoverOpen) {
        renderComposerPopover();
      }
      if (state.ui.commandPopoverOpen) {
        renderCommandPopover({ positionOnly: true });
      }
      syncComposerModelSelectWidth();
      updateComposerSafeOffset({
        force: true,
        syncViewport: true,
      });
    }

    function handleChatDragEnter(event) {
      suppressFileDropNavigation(event);
      setDropActive(true);
    }

    function handleChatDragLeave(event) {
      suppressFileDropNavigation(event);
      if (!chatView.contains(event.relatedTarget)) {
        setDropActive(false);
      }
    }

    function handleChatDrop(event) {
      suppressFileDropNavigation(event);
      setDropActive(false);
      const token = beginTrackedAttachmentToken();
      prepareDroppedAttachments(getDroppedFilePaths(event), token).then(
        () => settleAttachmentToken(token),
        (error) => {
          settleAttachmentToken(token, true);
          if (disposed) { return; }
          showToastMessage(toErrorMessage(error, 'Could not attach dropped files.'), {
            title: 'Attachment Error',
            tone: 'danger',
            sticky: true,
            source: TOAST_SOURCE.attachments,
            dedupeKey: `${TOAST_SOURCE.attachments}:error`,
          });
        }
      );
    }

    function handleChatPaste(event) {
      const imagePaste = handleClipboardImagePaste(event);
      if (event.defaultPrevented) {
        imagePaste.catch((error) => {
          if (disposed) { return; }
          showToastMessage(toErrorMessage(error, 'Could not paste image attachment.'), {
            title: 'Attachment Error',
            tone: 'danger',
            sticky: true,
            source: TOAST_SOURCE.attachments,
            dedupeKey: `${TOAST_SOURCE.attachments}:error`,
          });
        });
        return;
      }
      if (!guardNativeTextPaste(event)) {
        return;
      }
      imagePaste.catch((error) => {
        if (disposed) { return; }
        showToastMessage(toErrorMessage(error, 'Could not paste image attachment.'), {
          title: 'Attachment Error',
          tone: 'danger',
          sticky: true,
          source: TOAST_SOURCE.attachments,
          dedupeKey: `${TOAST_SOURCE.attachments}:error`,
        });
      });
    }

    function handleDocumentPaste(event) {
      if (event.defaultPrevented || event.target === chatInput) {
        return;
      }
      const targetIsEditable = typeof event.target?.closest === 'function' && Boolean(event.target.closest('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=range]), textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], .monaco-editor'));
      if (targetIsEditable) {
        return;
      }
      const items = event.clipboardData?.items ? [...event.clipboardData.items] : [];
      const hasImage = items.some((item) => String(item?.type || '').startsWith('image/'));
      if (!hasImage) {
        return;
      }
      const targetTag = String(event.target?.tagName || '').toLowerCase();
      if (!chatInput || chatInput.disabled || chatInput.readOnly || typeof chatInput.getClientRects !== 'function' || chatInput.getClientRects().length === 0) {
        safeLog('DEBUG', 'composer.paste.no_composer', { targetTag, reason: chatInput?.disabled || chatInput?.readOnly ? 'disabled' : 'not_rendered' });
        return;
      }
      handleChatPaste(event);
      if (event.defaultPrevented) {
        safeLog('DEBUG', 'composer.paste.rerouted', { targetTag });
        try { chatInput.focus(); } catch (_error) { /* noop */ }
      } else {
        safeLog('DEBUG', 'composer.paste.reroute_skipped', { targetTag });
      }
    }

    function handleAttachFilesClick() {
      const token = beginTrackedAttachmentToken();
      handleAttachmentPicker(token).then(
        () => settleAttachmentToken(token),
        (error) => {
          settleAttachmentToken(token, true);
          if (disposed) { return; }
          showToastMessage(toErrorMessage(error, 'Could not attach files.'), {
            title: 'Attachment Error',
            tone: 'danger',
            sticky: true,
            source: TOAST_SOURCE.attachments,
            dedupeKey: `${TOAST_SOURCE.attachments}:error`,
          });
        }
      );
    }

    function handleCaptureScreenClick() {
      const capture = state.displayMediaCapture
        || (state.displayMediaCapture = { inFlight: false, lastOutcome: null });
      if (capture.inFlight) {
        // A capture (and its source-picker modal) is already in flight; ignore
        // the re-entrant click so we never open two modals / two live streams.
        return;
      }
      capture.inFlight = true;
      capture.lastOutcome = null;
      handleScreenCaptureRequest()
        .catch((error) => {
          if (disposed) { return; }
          // The source picker records a deliberate cancel on the shared capture
          // state; a getDisplayMedia rejection on its own can't be told apart
          // from a genuine OS denial by error name, so trust the picker outcome.
          const cancelled = capture.lastOutcome === 'cancelled';
          capture.lastOutcome = null;
          if (cancelled) {
            return;
          }
          showToastMessage(toErrorMessage(error, 'Could not capture the screen.'), {
            title: 'Capture Error',
            tone: 'danger',
            sticky: true,
            source: TOAST_SOURCE.attachments,
            dedupeKey: `${TOAST_SOURCE.attachments}:capture:error`,
          });
        })
        .finally(() => {
          capture.inFlight = false;
        });
    }

    function dispose() {
      disposed = true;
      if (commandTypeaheadTimer) window.clearTimeout(commandTypeaheadTimer);
      commandTypeaheadTimer = 0;
      commandTypeahead = '';
      for (const token of attachmentTokens) {
        cancelAttachmentToken(token);
      }
      attachmentTokens.clear();
      while (cleanupFns.length) {
        const cleanup = cleanupFns.pop();
        try {
          cleanup();
        } catch (_) {
          // Best-effort teardown for tests and renderer re-init.
        }
      }
      bound = false;
    }

    function bind() {
      if (bound || disposed) {
        return;
      }
      bound = true;
      registerListener(attachmentTray, 'click', handleAttachmentTrayClick);
      registerListener(attachmentTray, 'keydown', handleAttachmentTrayKeydown);
      registerListener(document, 'mousedown', handleDocumentMouseDown);
      registerListener(document, 'keydown', handleDocumentKeydown);
      registerListener(window, 'resize', handleWindowResize);
      globalDropEvents.forEach((eventName) => {
        registerListener(window, eventName, suppressFileDropNavigation);
      });
      chatDropEnterEvents.forEach((eventName) => {
        registerListener(chatView, eventName, handleChatDragEnter);
      });
      registerListener(chatView, 'dragleave', handleChatDragLeave);
      registerListener(chatView, 'drop', handleChatDrop);
      registerListener(chatInput, 'paste', handleChatPaste);
      registerListener(document, 'paste', handleDocumentPaste);
      registerListener(attachFilesButton, 'click', handleAttachFilesClick);
      registerListener(composerAttachShortcut, 'click', handleAttachFilesClick);
      registerListener(captureScreenButton, 'click', handleCaptureScreenClick);
    }

    return { bind, dispose };
  }

  return { createAttachmentEventBindings };
});
