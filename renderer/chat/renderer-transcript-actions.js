(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-unsaved-reply-actions'));
    return;
  }
  root.rendererTranscriptActionsUtils = factory(root.rendererUnsavedReplyActions || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (unsavedReplyActions) {
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
          <svg viewBox="0 0 16 16" aria-hidden="true">
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
        return 'Copy message to clipboard';
      }
      if (action === 'elaborate') {
        return 'Ask Jenny to elaborate';
      }
      if (action === 'regenerate') {
        return 'Regenerate this response';
      }
      if (action === 'edit') {
        return 'Edit your message';
      }
      if (action === 'branch') {
        return 'Branch from here';
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
          ? 'Copy message'
          : action === 'elaborate'
            ? 'Ask for more detail'
            : action === 'edit'
              ? 'Edit and resend (Enter)'
              : action === 'branch'
                ? 'Branch from here (Ctrl+Shift+B)'
                : description;

      return `
        <button
          class="chat-hover-action"
          type="button"
          data-message-action="${escapeHtml(action)}"
          data-message-id="${escapeHtml(message.id)}"
          aria-label="${escapeHtml(ariaLabel)}"
          title="${escapeHtml(tooltip)}"
          ${disabled ? 'disabled aria-disabled="true"' : ''}
        >
          ${renderMessageActionIcon(action)}
        </button>
      `;
    }

    function renderMessageHoverRow(message, actionOptions, metaLabel) {
      const actionModel = buildMessageActionModel(message, actionOptions);
      const unsavedReplyNotice = typeof unsavedReplyActions.renderUnsavedReplyNotice === 'function'
        ? unsavedReplyActions.renderUnsavedReplyNotice(message, actionModel)
        : '';
      if (!actionModel.showHoverRow) {
        return unsavedReplyNotice;
      }

      const visibleMetaLabel = String(metaLabel || '').trim();
      const meta = actionModel.showMeta || visibleMetaLabel
        ? `<div class="chat-hover-meta">${escapeHtml(visibleMetaLabel)}</div>`
        : '<div class="chat-hover-meta chat-hover-meta-empty" aria-hidden="true"></div>';
      const actions = ['edit', 'branch', 'regenerate', 'copy', 'elaborate']
        .map((action) => renderMessageActionButton(message, action, actionModel.actions[action]))
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
