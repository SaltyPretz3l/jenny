/* renderer/shell/renderer-sidebar-utils.js
 *
 * Sidebar-adjacent composer utilities. Chats history and panel layout have
 * dedicated owners: renderer-chats-panel.js and renderer-view-panel-registry.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/chip'));
    return;
  }
  root.rendererSidebarUtils = factory(root.inventoryChip);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventoryChip) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function createSidebarController(deps) {
    const { state } = deps;
    const { chatView, attachmentTray, attachmentNotice } = deps.dom;
    const { escapeHtml } = deps.callbacks;
    let overheadRefreshPromise = null;
    // W2-2b: the last rendered signature (ids + drag depth) per pane tray.
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
      if (sourceKind === 'capture') return 'capture';
      if (sourceKind === 'clipboard') return 'paste';
      return 'file';
    }

    function formatAttachmentMeta(entry) {
      const kind = String(entry?.kind || '').trim();
      if (kind === 'image') {
        return `${formatSourceLabel(entry)}${entry.width && entry.height ? ` - ${entry.width}x${entry.height}` : ''}`;
      }
      if (kind === 'audio') {
        return entry.durationMs ? formatAudioDuration(entry.durationMs) : 'audio';
      }
      return entry.truncated ? 'truncated' : `${Math.ceil(Number(entry.sizeBytes || 0) / 1024)} KB`;
    }

    /* No argument (every pre-W2-2b caller): pane 0's nodes and the live queue.
     * Split view W2-2b: a target `{ tray, notice, chatView, queued, dragDepth,
     * sessionId }` renders another pane's tray from that pane's queue and
     * rebuilds its markup only when its ids, skill or drag depth changed.
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
      getPaneZeroRoot().classList.toggle('chat-drop-active', state.attachments.dragDepth > 0);
      attachmentTray.classList.toggle('hidden', queuedAttachments.length === 0 && !pendingSkill);
      attachmentNotice.classList.add('hidden');
      attachmentNotice.textContent = '';
      if (!queuedAttachments.length && !pendingSkill) {
        attachmentTray.innerHTML = '';
        return;
      }
      attachmentTray.innerHTML = skillChipHtml(pendingSkill, 'composerSkillChip') + queuedAttachments.map(attachmentChipHtml).join('');
      attachmentTray.querySelector('#composerSkillChip')?.addEventListener('click', () => {
        if (skillState?.clearPendingSkillInvocation?.(state)) renderAttachmentTray();
      });
      if (queuedAttachments.length > 1) {
        attachmentTray.insertAdjacentHTML('beforeend', clearAllButtonHtml());
      }
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

    function attachmentChipHtml(entry) {
      const kind = String(entry?.kind || '').trim();
      const preview = kind === 'image'
        ? `<img class="attachment-chip-preview" src="${escapeHtml(toImageAssetUrl(entry.assetPath))}" alt="${escapeHtml(entry.displayName)}">`
        : kind === 'audio' ? '<span class="attachment-chip-audio-glyph" aria-hidden="true">Mic</span>' : '';
      return `
          <div class="attachment-chip${kind === 'image' ? ' attachment-chip-image' : ''}${kind === 'audio' ? ' attachment-chip-audio' : ''}" data-attachment-id="${escapeHtml(entry.id)}">
            ${preview}
            <span class="attachment-chip-copy">
              <span class="attachment-chip-name" title="${escapeHtml(entry.displayName)}">${escapeHtml(entry.displayName)}</span>
              <span class="attachment-chip-meta">${escapeHtml(formatAttachmentMeta(entry))}</span>
            </span>
            <button class="attachment-chip-remove" type="button" data-attachment-remove="${escapeHtml(entry.id)}" aria-label="${escapeHtml(jt('sidebar.attachments.removeLabel', 'Remove {name}', { name: entry.displayName }))}" title="${escapeHtml(jt('sidebar.attachments.removeTitle', 'Remove attachment'))}">x</button>
          </div>`;
    }

    function clearAllButtonHtml() {
      return '<button class="attachment-chip attachment-chip-clear" type="button" data-attachment-clear="true" title="{title}" aria-label="{label}">{text}</button>'.replace('{title}', () => escapeHtml(jt('sidebar.attachments.removeAllTitle', 'Remove all attachments'))).replace('{label}', () => escapeHtml(jt('sidebar.attachments.clearAllLabel', 'Clear all attachments'))).replace('{text}', () => escapeHtml(jt('sidebar.attachments.clearAll', 'Clear all')));
    }

    function renderPaneAttachmentTray(target) {
      const { tray, notice, chatView: paneView, queued, dragDepth, sessionId } = target;
      const queuedAttachments = Array.isArray(queued) ? queued : [];
      const depth = Number(dragDepth) || 0;
      const skillState = getSkillState();
      const pendingSkill = sessionId ? skillState?.peekPendingSkillInvocation?.(state, sessionId) || null : null;
      paneView?.classList?.toggle('chat-drop-active', depth > 0);
      tray.classList.toggle('hidden', queuedAttachments.length === 0 && !pendingSkill);
      if (notice) {
        notice.classList.add('hidden');
        notice.textContent = '';
      }
      const signature = `${queuedAttachments.map((entry) => String(entry?.id || '')).join('\u0000')}|${depth}|${pendingSkill ? pendingSkill.id : ''}`;
      if (paneTraySignatures.get(tray) === signature) return;
      paneTraySignatures.set(tray, signature);
      tray.innerHTML = skillChipHtml(pendingSkill, '') + queuedAttachments.map(attachmentChipHtml).join('')
        + (queuedAttachments.length > 1 ? clearAllButtonHtml() : '');
      tray.querySelector('[data-inv-chip="attached-skill"]')?.addEventListener('click', () => {
        if (skillState?.clearPendingSkillInvocation?.(state)) renderPaneAttachmentTray(target);
      });
    }

    return { updateTokenDisplay, refreshContextOverhead, renderAttachmentTray };
  }

  return { createSidebarController };
});
