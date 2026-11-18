(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-unsaved-reply-actions'));
    return;
  }
  root.rendererTranscriptActionsUtils = factory(root.rendererUnsavedReplyActions || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (unsavedReplyActions) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function createTranscriptActionRenderer(deps) {
    const { buildMessageActionModel, escapeHtml } = deps || {};

    function renderMessageActionIcon(action) {
      if (action === 'copy') {
        return `
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="5" y="3" width="8" height="10" rx="2"></rect>
            <path d="M3 11V5a2 2 0 0 1 2-2"></path>
          </svg>
        `;
      }
      if (action === 'elaborate') {
        return `
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.75 9.5 6.5 14.25 8 9.5 9.5 8 14.25 6.5 9.5 1.75 8 6.5 6.5Z"></path>
          </svg>
        `;
      }
      if (action === 'pin') {
        return `
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9.5 2.5 13.5 6.5 11.5 7.5 10 10 6 6 8.5 4.5Z"></path>
            <path d="M6 10 2.5 13.5"></path>
          </svg>
        `;
      }
      if (action === 'post-to-team') {
        return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"></path></svg>';
      }
      if (action === 'edit') {
        return `
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M11.5 2.5 13.5 4.5 5 13 2 13.5 2.5 10.5Z"></path>
            <path d="M10 4 12 6"></path>
          </svg>
        `;
      }
      if (action === 'branch') {
        return `
          <svg class="icon-mirror-rtl" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 2v3.5a3.5 3.5 0 0 0 3.5 3.5H12"></path>
            <path d="M8.5 5.5 12 9l-3.5 3.5"></path>
            <path d="M4 14V2"></path>
          </svg>
        `;
      }
      return `
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13 8a5 5 0 1 1-1.43-3.49"></path>
          <path d="M13 3v3.5H9.5"></path>
        </svg>
      `;
    }

    function describeAction(action) {
      if (action === 'copy') {
        return jt('chat.transcript.copyMessageToClipboard', 'Copy message to clipboard');
      }
      if (action === 'elaborate') {
        return jt('chat.transcript.askJennyToElaborate', 'Ask Jenny to elaborate');
      }
      if (action === 'regenerate') {
        return jt('chat.transcript.regenerateResponse', 'Regenerate this response');
      }
      if (action === 'pin') {
        return jt('chat.transcript.pinToBoard', 'Pin to board');
      }
      if (action === 'post-to-team') {
        return jt('chat.postToTeam.menu', 'Post to Team…');
      }
      if (action === 'edit') {
        return jt('chat.transcript.editYourMessage', 'Edit your message');
      }
      if (action === 'branch') {
        return jt('chat.transcript.branchFromHere', 'Branch from here');
      }
      return action.charAt(0).toUpperCase() + action.slice(1);
    }

    function renderMessageActionButton(message, action, config) {
      if (!config || !config.visible) {
        return '';
      }
      const disabled = config.enabled === false;
      const description = describeAction(action);
      const reason = String((config && config.reason) || '').trim();
      const ariaLabel = disabled && reason
        ? `${description} (${reason})`
        : description;
      const tooltip = disabled && reason
        ? reason
        : action === 'copy'
          ? jt('chat.transcript.copyMessage', 'Copy message')
          : action === 'elaborate'
            ? jt('chat.transcript.askForMoreDetail', 'Ask for more detail')
            : action === 'edit'
              ? jt('chat.transcript.editAndResend', 'Edit and resend (Enter)')
              : action === 'branch'
                ? jt('chat.transcript.branchFromHereShortcut', 'Branch from here (Ctrl+Shift+B)')
                : description;

      // Branch and Elaborate are not universal icons: they show their word
      // (row 38 item 7, variant B); edit, regenerate and copy stay icon-only.
      const word = action === 'branch'
        ? jt('chat.transcript.branchShort', 'Branch')
        : action === 'elaborate'
          ? jt('chat.transcript.elaborateShort', 'Elaborate')
          : '';
      return `
        <button
          class="chat-hover-action${word ? ' chat-hover-action--labeled' : ''}"
          type="button"
          data-message-action="${escapeHtml(action)}"
          data-message-id="${escapeHtml(message.id)}"
          aria-label="${escapeHtml(ariaLabel)}"
          title="${escapeHtml(tooltip)}"
          ${disabled ? 'disabled aria-disabled="true"' : ''}
        >
          ${renderMessageActionIcon(action)}${word ? `<span class="chat-hover-action-word">${escapeHtml(word)}</span>` : ''}
        </button>
      `;
    }

    function renderMessageHoverRow(message, actionOptions, metaLabel, shortMetaLabel) {
      // Pin to board (row 150 slice C5): the model is told only while the `project_boards` flag is on.
      const pinOn = globalThis.rendererChatMessageActionBindings?.pinEnabled?.() === true;
      const actionModel = buildMessageActionModel(message, pinOn ? { ...actionOptions, pinToBoard: true } : actionOptions);
      const unsavedReplyNotice = typeof unsavedReplyActions.renderUnsavedReplyNotice === 'function'
        ? unsavedReplyActions.renderUnsavedReplyNotice(message, actionModel)
        : '';
      if (!actionModel.showHoverRow) {
        return unsavedReplyNotice;
      }

      // The line shows the short label (its accessible name); the full label is the tooltip.
      const fullMetaLabel = String(metaLabel || '').trim();
      const visibleMetaLabel = String(shortMetaLabel || '').trim() || fullMetaLabel;
      const meta = actionModel.showMeta || visibleMetaLabel
        ? `<div class="chat-hover-meta" tabindex="0" title="${escapeHtml(fullMetaLabel || visibleMetaLabel)}">${escapeHtml(visibleMetaLabel)}</div>`
        : '<div class="chat-hover-meta chat-hover-meta-empty" aria-hidden="true"></div>';
      // Post to Team (row 175 D5): on a Jenny answer only; the bindings say whether it is usable now, or null while Team is off.
      const toTeam = message.role === 'assistant' && actionModel.actions.copy?.visible ? globalThis.rendererChatMessageActionBindings?.postToTeamState?.(message) : null;
      const shown = toTeam ? { ...actionModel.actions, 'post-to-team': toTeam } : actionModel.actions;
      const actions = ['edit', 'branch', 'regenerate', 'copy', 'pin', 'post-to-team', 'elaborate']
        .map((action) => renderMessageActionButton(message, action, shown[action]))
        .join('');

      return `${unsavedReplyNotice}
        <div class="chat-hover-row" data-hover-row="true" data-message-id="${escapeHtml(message.id)}">
          ${meta}
          <div class="chat-hover-actions">
            ${actions}
          </div>
        </div>
      `;
    }

    function renderSlashCommandOutput(message) {
      const commandName = escapeHtml(String(message.slash_command || '/command'));
      const content = escapeHtml(String(message.content || ''));
      return `
        <div class="slash-command-output">
          <div class="slash-command-kicker">${commandName}</div>
          <pre class="slash-command-body">${content}</pre>
        </div>
      `;
    }

    return {
      renderMessageHoverRow,
      renderSlashCommandOutput,
    };
  }

  return {
    createTranscriptActionRenderer,
  };
});
