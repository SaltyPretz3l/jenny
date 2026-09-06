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

  function createSidebarController(deps) {
    const { state } = deps;
    const { chatView, attachmentTray, attachmentNotice } = deps.dom;
    const { escapeHtml } = deps.callbacks;
    let overheadRefreshPromise = null;
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

    function renderAttachmentTray() {
      const queuedAttachments = Array.isArray(state.attachments.queued) ? state.attachments.queued : [];
      const skillState = globalThis.rendererComposerV2State
        || (typeof require === 'function' ? require('../chat/renderer-composer-v2-state') : null);
      const pendingSkill = skillState?.getPendingSkillInvocation?.(state) || null;
      chatView.classList.toggle('chat-drop-active', state.attachments.dragDepth > 0);
      attachmentTray.classList.toggle('hidden', queuedAttachments.length === 0 && !pendingSkill);
      attachmentNotice.classList.add('hidden');
      attachmentNotice.textContent = '';
      if (!queuedAttachments.length && !pendingSkill) {
        attachmentTray.innerHTML = '';
        return;
      }
      const skillChip = pendingSkill && typeof inventoryChip === 'function' ? inventoryChip({
        id: 'attached-skill',
        domId: 'composerSkillChip',
        iconHtml: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5l1.1 3.4L12.5 6 9.1 7.1 8 10.5 6.9 7.1 3.5 6l3.4-1.1L8 1.5z"/><path d="M12.5 10l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9z"/></svg>',
        label: `${pendingSkill.name || pendingSkill.command} ×`,
        ariaLabel: `Skill attached: ${pendingSkill.name || pendingSkill.command}. Remove`,
        title: 'Attached skill — click to remove',
        className: 'composer-skill-chip',
      }) : '';
      attachmentTray.innerHTML = skillChip + queuedAttachments.map((entry) => {
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
            <button class="attachment-chip-remove" type="button" data-attachment-remove="${escapeHtml(entry.id)}" aria-label="Remove ${escapeHtml(entry.displayName)}" title="Remove attachment">x</button>
          </div>`;
      }).join('');
      attachmentTray.querySelector('#composerSkillChip')?.addEventListener('click', () => {
        if (skillState?.clearPendingSkillInvocation?.(state)) renderAttachmentTray();
      });
      if (queuedAttachments.length > 1) {
        attachmentTray.insertAdjacentHTML(
          'beforeend',
          '<button class="attachment-chip attachment-chip-clear" type="button" data-attachment-clear="true" title="Remove all attachments" aria-label="Clear all attachments">Clear all</button>'
        );
      }
    }

    return { updateTokenDisplay, refreshContextOverhead, renderAttachmentTray };
  }

  return { createSidebarController };
});
