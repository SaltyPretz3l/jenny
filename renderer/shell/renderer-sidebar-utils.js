/* renderer/shell/renderer-sidebar-utils.js
 *
 * Sidebar-adjacent composer utilities. Chats history and panel layout have
 * dedicated owners: renderer-chats-panel.js and renderer-top-nav-shell.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/chip'), require('../inventory/action-button'));
    return;
  }
  root.rendererSidebarUtils = factory(root.inventoryChip, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventoryChip, actionButton) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function createSidebarController(deps) {
    const { state } = deps;
    const { chatView, attachmentTray, attachmentNotice } = deps.dom;
    const { escapeHtml } = deps.callbacks;
    let overheadRefreshPromise = null;
    // W2-2b: the last rendered signature (ids, chips, placeholders) per tray.
    const paneTraySignatures = new WeakMap();
    let overheadLastRefreshedAt = 0;
    const OVERHEAD_STALE_MS = 15000;

    async function refreshContextOverhead() {
      const shell = globalThis.window?.jennyShell || globalThis.jennyShell;
      if (!shell) return;
      try {
        const [personalityResult, memoryResult, toolsResult] = await Promise.allSettled([
          shell.personality.getState(),
          shell.memory.listApproved(),
          shell.tools.list(),
        ]);
        let overhead = 0;
        // Use the compiled personality token estimate so sidebar overhead
        // matches the payload sent with the turn.
        if (personalityResult.status === 'fulfilled' && personalityResult.value) {
          const compiled = personalityResult.value.compiled || {};
          const tokens = Number(compiled.tokensEstimate);
          overhead += Number.isFinite(tokens) && tokens > 0
            ? tokens
            : Math.ceil(String(compiled.text || '').length / 4);
        }
        if (memoryResult.status === 'fulfilled') {
          const memories = Array.isArray(memoryResult.value?.memories) ? memoryResult.value.memories : [];
          const memoryText = memories
            .map((memory) => String(memory.content || memory.lesson_text || memory.title || ''))
            .join('\n');
          if (memoryText) overhead += Math.ceil(memoryText.length / 4);
        }
        if (toolsResult.status === 'fulfilled') {
          const tools = Array.isArray(toolsResult.value) ? toolsResult.value : [];
          const toolText = tools
            .map((tool) => `${tool.name || ''}: ${tool.description || ''}`)
            .join('\n');
          if (toolText) overhead += Math.ceil(toolText.length / 4);
        }
        state.ui.contextOverheadTokens = overhead;
        overheadLastRefreshedAt = Date.now();
      } catch (_error) {
        // Context overhead is best-effort presentation data.
      }
    }

    function updateTokenDisplay() {
      const backendReady = state.backend?.phase === 'ready';
      if (!backendReady || overheadRefreshPromise || Date.now() - overheadLastRefreshedAt <= OVERHEAD_STALE_MS) {
        return;
      }
      overheadRefreshPromise = refreshContextOverhead()
        .finally(() => { overheadRefreshPromise = null; });
    }

    function toImageAssetUrl(assetPath) {
      const normalized = String(assetPath || '').trim();
      if (!normalized) return '';
      const withForwardSlashes = normalized.replace(/\\/g, '/');
      return `file://${encodeURI(withForwardSlashes.startsWith('/') ? withForwardSlashes : `/${withForwardSlashes}`)}`;
    }

    function formatAudioDuration(durationMs) {
      const totalSeconds = Math.max(Math.round(Number(durationMs || 0) / 1000), 0);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    function formatSourceLabel(entry) {
      const sourceKind = String(entry?.sourceKind || '').trim().toLowerCase();
      if (sourceKind === 'capture') return jt('sidebar.attachments.source.capture', 'Screen capture');
      if (sourceKind === 'clipboard') return jt('sidebar.attachments.source.paste', 'Pasted');
      return jt('sidebar.attachments.source.file', 'Image');
    }

    function formatSize(sizeBytes) {
      const bytes = Math.max(Number(sizeBytes) || 0, 0);
      return bytes < 1024 * 1024
        ? jt('sidebar.attachments.sizeKb', '{size} KB', { size: Math.max(Math.ceil(bytes / 1024), 1) })
        : jt('sidebar.attachments.sizeMb', '{size} MB', { size: (bytes / (1024 * 1024)).toFixed(1) });
    }

    // The extension a file tile shows: up to four letters, upper case, or "File".
    function fileTypeLabel(name) {
      const match = /\.([a-z0-9]{1,4})$/i.exec(String(name || '').trim());
      return match ? match[1].toUpperCase() : jt('sidebar.attachments.typeFallback', 'File');
    }

    function formatAttachmentMeta(entry) {
      const kind = String(entry?.kind || '').trim();
      if (kind === 'audio') {
        return entry?.durationMs
          ? jt('sidebar.attachments.metaAudio', 'Audio · {duration}', { duration: formatAudioDuration(entry.durationMs) })
          : jt('sidebar.attachments.metaAudioNoDuration', 'Audio');
      }
      const params = { type: fileTypeLabel(entry?.displayName), size: formatSize(entry?.sizeBytes) };
      return entry?.truncated
        ? jt('sidebar.attachments.metaFileTruncated', '{type} · {size} · first part only', params)
        : jt('sidebar.attachments.metaFile', '{type} · {size}', params);
    }

    // "{source} · {width} × {height}": the image's caption in its tooltip and in the image viewer.
    function imageCaption(entry) {
      const source = formatSourceLabel(entry);
      return entry?.width && entry?.height
        ? jt('sidebar.attachments.imageCaption', '{source} · {width} × {height}', { source, width: entry.width, height: entry.height })
        : source;
    }

    /* No argument (every pre-W2-2b caller): pane 0's nodes and the live queue.
     * Split view W2-2b: a target `{ tray, notice, chatView, queued, dragDepth,
     * sessionId }` renders another pane's tray from that pane's queue and
     * rebuilds its markup only when its ids, skill or placeholders changed.
     * W3-1: the pending-skill chip renders in the pane showing the skill's
     * session (pane 1 peeks; pane 0 drops a skill no pane shows), and the drop highlight lights the
     * pane's own root (#chatPane0 for pane 0), never the whole view. */
    function renderAttachmentTray(target) {
      const scoped = target && typeof target === 'object' && target.tray ? target : null;
      if (scoped) {
        renderPaneAttachmentTray(scoped);
        return;
      }
      const queuedAttachments = Array.isArray(state.attachments.queued) ? state.attachments.queued : [];
      const skillState = getSkillState();
      // Read as pane 0's session: a skill no pane shows is dropped (one pane: a switch drops it, as before).
      const pendingSkill = skillState?.getPendingSkillInvocation?.(state, { getSessionId: getPaneZeroSessionId }) || null;
      const pendingPrompt = skillState?.getPendingPromptBlock?.(state, { getSessionId: getPaneZeroSessionId }) || null;
      const imagePromptHtml = imagePromptChipsHtml(getPaneZeroSessionId());
      const depth = Number(state.attachments.dragDepth) || 0;
      const pending = pendingFor((sessionId) => isLiveQueueSession(sessionId));
      getPaneZeroRoot().classList.toggle('chat-drop-active', depth > 0);
      const empty = !queuedAttachments.length && !pending.length && !pendingSkill && !pendingPrompt && !imagePromptHtml;
      attachmentTray.classList.toggle('hidden', empty);
      attachmentNotice.classList.add('hidden');
      attachmentNotice.textContent = '';
      // Row 153: the same markup is never written twice. A drag only toggles chat-drop-active
      // (the composer's drop hint is CSS), so it never rewrites the tray.
      const signature = traySignature(getPaneZeroSessionId(), queuedAttachments, pending, pendingSkill, pendingPrompt, imagePromptHtml);
      if (paneTraySignatures.get(attachmentTray) === signature) return;
      paneTraySignatures.set(attachmentTray, signature);
      if (empty) {
        attachmentTray.innerHTML = '';
        return;
      }
      attachmentTray.innerHTML = imagePromptHtml + skillChipHtml(pendingSkill, 'composerSkillChip') + promptChipHtml(pendingPrompt)
        + attachmentItemsHtml(queuedAttachments, pending);
      bindImagePromptChips(attachmentTray, getPaneZeroSessionId(), () => { paneTraySignatures.delete(attachmentTray); renderAttachmentTray(); });
      attachmentTray.querySelector('[data-inv-chip="prompt_pending"]')?.addEventListener('click', () => {
        if (skillState?.clearPendingPromptBlock?.(state)) renderAttachmentTray();
      });
      attachmentTray.querySelector('#composerSkillChip')?.addEventListener('click', () => {
        if (skillState?.clearPendingSkillInvocation?.(state)) renderAttachmentTray();
      });
    }

    // The session is part of it: the chip listeners bound with the markup act on that session.
    function traySignature(sessionId, queued, pending, pendingSkill, pendingPrompt, imagePromptHtml) {
      return [
        String(sessionId || ''),
        queued.map((entry) => String(entry?.id || '')).join('\u0000'),
        pending.map((entry) => `${entry.operationId}:${entry.name}`).join('\u0000'),
        pendingSkill ? pendingSkill.id : '',
        JSON.stringify(pendingPrompt),
        imagePromptHtml,
      ].join('|');
    }

    function isLiveQueueSession(sessionId) {
      const helpers = globalThis.rendererComposerSessionState;
      return typeof helpers?.isLiveQueueSession === 'function'
        ? helpers.isLiveQueueSession(state, sessionId)
        : String(sessionId || '') === String(state.currentSessionId || '').trim();
    }

    // Row 153: placeholders of attachments still being prepared, for the sessions `matches` accepts.
    function pendingFor(matches) {
      const list = Array.isArray(state.attachmentPending) ? state.attachmentPending : [];
      return list.filter((entry) => entry && matches(String(entry.sessionId || '')));
    }

    // Row 91: the /image chips of a chat (image, size, optional seed); '' when it is not armed.
    function imagePromptChipsHtml(sessionId) {
      const imagePrompt = globalThis.rendererImagePrompt;
      return imagePrompt && sessionId ? imagePrompt.chipsHtml(imagePrompt.peek(state, sessionId)) : '';
    }

    function bindImagePromptChips(tray, sessionId, rerender) {
      globalThis.rendererImagePrompt?.bindChips(tray, { state, sessionId, rerender,
        focusInput: () => tray.closest?.('.composer-wrap')?.querySelector?.('textarea')?.focus?.() });
    }

    function getSkillState() {
      return globalThis.rendererComposerV2State
        || (typeof require === 'function' ? require('../chat/renderer-composer-v2-state') : null);
    }

    // Pane 0's session: the layout's pane 0 entry, or currentSessionId with one pane.
    function getPaneZeroSessionId() {
      const visibility = globalThis.rendererPaneVisibilityUtils;
      return typeof visibility?.resolvePaneSessionId === 'function'
        ? visibility.resolvePaneSessionId(state, 0)
        : String(state.currentSessionId || '').trim();
    }

    // #chatPane0 (the view itself only in a fixture without the pane wrapper).
    function getPaneZeroRoot() {
      return chatView.querySelector?.(':scope > .chat-pane[data-pane-id="0"]') || chatView;
    }

    // `domId` names pane 0's chip (#composerSkillChip); a pane target's chip is
    // found by its data-inv-chip id inside its own tray instead.
    function skillChipHtml(pendingSkill, domId) {
      return pendingSkill && typeof inventoryChip === 'function' ? inventoryChip({
        id: 'attached-skill',
        ...(domId ? { domId } : {}),
        iconHtml: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5l1.1 3.4L12.5 6 9.1 7.1 8 10.5 6.9 7.1 3.5 6l3.4-1.1L8 1.5z"/><path d="M12.5 10l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9z"/></svg>',
        label: `${pendingSkill.name || pendingSkill.command} ×`,
        ariaLabel: jt('sidebar.skills.attachedRemoveLabel', 'Skill attached: {skill}. Remove', { skill: pendingSkill.name || pendingSkill.command }),
        title: jt('sidebar.skills.attachedRemoveTitle', 'Attached skill — click to remove'),
        className: 'composer-skill-chip',
      }) : '';
    }

    const REMOVE_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
    const FILE_ICON = '<svg viewBox="0 0 30 36" aria-hidden="true"><path class="composer-attachment-icon-body" d="M4 1.5h15l7.5 7.5v24a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-29.5a2 2 0 0 1 2-2z"/><path class="composer-attachment-icon-fold" d="M19 1.5V9h7.5"/><text x="14.5" y="27" text-anchor="middle" font-size="7.5">{type}</text></svg>';
    const AUDIO_ICON = '<svg viewBox="0 0 30 36" aria-hidden="true"><rect class="composer-attachment-icon-body" x="2" y="3" width="26" height="30" rx="7"/><path class="composer-attachment-icon-wave" d="M8 18v0M11.5 14v8M15 11v14M18.5 15v6M22 17v2"/></svg>';

    function removeButtonHtml(entry) {
      const name = String(entry?.displayName || '');
      return actionButton({ plain: true, className: 'composer-attachment-remove', dataset: { 'attachment-remove': String(entry?.id || '') },
        ariaLabel: jt('sidebar.attachments.removeLabel', 'Remove {name}', { name }), title: jt('sidebar.attachments.removeTitle', 'Remove attachment'), trustedHtml: REMOVE_ICON });
    }

    function imageItemHtml(entry, overLimit, maxImages) {
      const name = String(entry?.displayName || '');
      const caption = imageCaption(entry);
      const title = jt('sidebar.attachments.imageTitle', '{name} · {caption}', { name, caption });
      const tip = overLimit ? jt('sidebar.attachments.overLimitTitle', '{title} · over the {max}-image limit', { title, max: maxImages }) : title;
      return `<div class="composer-attachment composer-attachment--image${overLimit ? ' composer-attachment--over' : ''}" data-attachment-id="${escapeHtml(entry.id)}">`
        + actionButton({ plain: true, className: 'composer-attachment-thumb', title: tip,
          dataset: { 'attachment-open': String(entry?.id || ''), 'attachment-title': name, 'attachment-caption': caption },
          ariaLabel: jt('sidebar.attachments.openLabel', 'Open {name}', { name }),
          trustedHtml: `<img src="${escapeHtml(toImageAssetUrl(entry.assetPath))}" alt="" decoding="async" draggable="false">` })
        + removeButtonHtml(entry) + '</div>';
    }

    function fileItemHtml(entry, kind) {
      const name = String(entry?.displayName || '');
      const icon = kind === 'audio' ? AUDIO_ICON : FILE_ICON.replace('{type}', () => escapeHtml(fileTypeLabel(name)));
      return `<div class="composer-attachment composer-attachment--${kind === 'audio' ? 'audio' : 'file'}" data-attachment-id="${escapeHtml(entry.id)}">`
        + `<span class="composer-attachment-icon" aria-hidden="true">${icon}</span>`
        + `<span class="composer-attachment-copy"><span class="composer-attachment-name" dir="auto" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`
        + `<span class="composer-attachment-meta">${escapeHtml(formatAttachmentMeta(entry))}</span></span>`
        + removeButtonHtml(entry) + '</div>';
    }

    function pendingItemHtml(entry) {
      const label = escapeHtml(jt('sidebar.attachments.preparingLabel', 'Preparing {name}', { name: entry.name }));
      if (entry.kind === 'image') {
        return `<div class="composer-attachment composer-attachment--pending composer-attachment--image" role="status"><span class="inv-spinner composer-attachment-spinner" aria-hidden="true"></span><span class="sr-only">${label}</span></div>`;
      }
      return `<div class="composer-attachment composer-attachment--pending composer-attachment--file" role="status" aria-label="${label}"><span class="inv-spinner composer-attachment-spinner" aria-hidden="true"></span>`
        + `<span class="composer-attachment-copy"><span class="composer-attachment-name" dir="auto">${escapeHtml(entry.name)}</span>`
        + `<span class="composer-attachment-meta">${escapeHtml(jt('sidebar.attachments.preparing', 'Preparing…'))}</span></span></div>`;
    }

    // Row 153: the queued items (images past the per-message image limit marked), the placeholders,
    // "Clear all" from three items ("{count} of {max}" before it at the cap).
    function attachmentItemsHtml(queued, pending) {
      const maxImages = Number(globalThis.rendererComposerVisionGate?.MAX_IMAGE_ATTACHMENTS) || 4;
      const maxQueued = Number(globalThis.rendererComposerSessionState?.ATTACHMENT_CAP) || 8;
      let images = 0;
      const items = queued.map((entry) => {
        const kind = String(entry?.kind || '').trim();
        if (kind !== 'image') return fileItemHtml(entry, kind);
        images += 1;
        return imageItemHtml(entry, images > maxImages, maxImages);
      }).join('') + pending.map(pendingItemHtml).join('');
      const count = queued.length >= maxQueued
        ? `<span class="composer-attachment-count">${escapeHtml(jt('sidebar.attachments.countAtCap', '{count} of {max}', { count: queued.length, max: maxQueued }))}</span>`
        : '';
      const tail = count || queued.length >= 3 ? `<span class="composer-attachment-tail">${count}${clearAllButtonHtml()}</span>` : '';
      return items + tail;
    }

    function promptChipHtml(block) {
      return block && typeof inventoryChip === 'function' ? inventoryChip({ id: 'prompt_pending',
        label: jt('composer.prompts.chipLabel', '{server} · {prompt}', block), count: '×', className: 'composer-skill-chip',
        ariaLabel: jt('composer.prompts.chipRemoveLabel', 'Prompt attached: {prompt}. Remove', block),
        title: jt('composer.prompts.chipRemoveTitle', 'Remove prompt') }) : '';
    }

    function clearAllButtonHtml() {
      return actionButton({ plain: true, className: 'composer-attachment-clear', dataset: { 'attachment-clear': 'true' },
        title: jt('sidebar.attachments.removeAllTitle', 'Remove all attachments'), ariaLabel: jt('sidebar.attachments.clearAllLabel', 'Clear all attachments'),
        label: jt('sidebar.attachments.clearAll', 'Clear all') });
    }

    function renderPaneAttachmentTray(target) {
      const { tray, notice, chatView: paneView, queued, dragDepth, sessionId } = target;
      const queuedAttachments = Array.isArray(queued) ? queued : [];
      const depth = Number(dragDepth) || 0;
      const skillState = getSkillState();
      const pendingSkill = sessionId ? skillState?.peekPendingSkillInvocation?.(state, sessionId) || null : null;
      const composer = skillState?.ensureComposerV2State?.(state);
      const pendingPrompt = sessionId && composer?.pendingPromptBlockSessionId === sessionId ? composer.pendingPromptBlock : null;
      const imagePromptHtml = imagePromptChipsHtml(sessionId);
      const pending = sessionId ? pendingFor((id) => id === sessionId) : [];
      paneView?.classList?.toggle('chat-drop-active', depth > 0);
      tray.classList.toggle('hidden', queuedAttachments.length === 0 && !pending.length && !pendingSkill && !pendingPrompt && !imagePromptHtml);
      if (notice) {
        notice.classList.add('hidden');
        notice.textContent = '';
      }
      const signature = traySignature(sessionId, queuedAttachments, pending, pendingSkill, pendingPrompt, imagePromptHtml);
      if (paneTraySignatures.get(tray) === signature) return;
      paneTraySignatures.set(tray, signature);
      tray.innerHTML = imagePromptHtml + skillChipHtml(pendingSkill, '') + promptChipHtml(pendingPrompt) + attachmentItemsHtml(queuedAttachments, pending);
      bindImagePromptChips(tray, sessionId, () => { paneTraySignatures.delete(tray); renderPaneAttachmentTray(target); });
      tray.querySelector('[data-inv-chip="attached-skill"]')?.addEventListener('click', () => {
        if (skillState?.clearPendingSkillInvocation?.(state)) renderPaneAttachmentTray(target);
      });
      tray.querySelector('[data-inv-chip="prompt_pending"]')?.addEventListener('click', () => {
        if (skillState?.clearPendingPromptBlock?.(state)) renderPaneAttachmentTray(target);
      });
    }

    return { updateTokenDisplay, refreshContextOverhead, renderAttachmentTray };
  }

  return { createSidebarController };
});
