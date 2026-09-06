(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnShell = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isThreadCompatAnchor(node) {
    return Boolean(
      node
      && node.classList
      && node.classList.contains('thread-compat-anchor')
    );
  }

  /**
   * Map a message role to the screen-reader aria-label used on its
   * .chat-entry article. Shared by the canonical shell builder and the
   * legacy fallback builder in renderer-render-pipeline-utils.js so the two
   * paths can never drift.
   */
  function describeMessageRole(role) {
    const normalized = String(role || '').trim().toLowerCase();
    if (normalized === 'assistant') return 'Message from Jenny';
    if (normalized === 'user') return 'Your message';
    if (normalized === 'system') return 'System message';
    if (normalized === 'tool') return 'Tool message';
    return 'Message';
  }

  function escapeSelectorValue(value) {
    const normalizedValue = String(value || '');
    if (typeof globalThis !== 'undefined' && globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
      return globalThis.CSS.escape(normalizedValue);
    }
    return normalizedValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // Ht-D: content-visibility exemption contract. An article is exempt from
  // paint-skip (never content-visibility:auto-deferred) while pending
  // (streaming) or while it holds an unresolved approval-gap row — the
  // approval_gap row kind exists IFF the call is awaiting approval and
  // unresolved (renderer-turn-reducer-approval-gap.js), so its mere presence
  // in the DOM is the unresolved-gate signal. Bottom-2 is a separate pure-CSS
  // structural selector (styles/chat-thread.css) and needs no JS.
  function isChatContentVisibilityFlagOn() {
    return typeof document !== 'undefined'
      && !!document.documentElement
      && document.documentElement.dataset.chatContentVisibility === 'on';
  }

  function hasUnresolvedApprovalGapRow(article) {
    return Boolean(
      article
      && typeof article.querySelector === 'function'
      && article.querySelector('[data-row-kind="approval_gap"]')
    );
  }

  // Called by the streaming patch paths (renderer-render-pipeline-message-
  // renderer.js, renderer-stream-reveal-utils.js) whenever they toggle the
  // 'pending' class directly on a live article, bypassing a full markup
  // rebuild. Those patches never touch the row list, so an approval_gap row
  // already in the DOM stays accurate to read back here.
  function syncChatEntryCvExemptAttribute(article, options) {
    if (!article || typeof article.setAttribute !== 'function' || typeof article.removeAttribute !== 'function') {
      return;
    }
    if (!isChatContentVisibilityFlagOn()) {
      article.removeAttribute('data-cv-exempt');
      return;
    }
    const pending = Boolean(options && options.pending);
    if (pending || hasUnresolvedApprovalGapRow(article)) {
      article.setAttribute('data-cv-exempt', 'true');
    } else {
      article.removeAttribute('data-cv-exempt');
    }
  }

  function resolveTurnArticleMessageId(messageId, projectionContext) {
    const normalizedMessageId = String(messageId || '').trim();
    if (!normalizedMessageId || !projectionContext || typeof projectionContext !== 'object') {
      return normalizedMessageId;
    }
    if (projectionContext.rowsByRenderMessageId?.has?.(normalizedMessageId)) {
      return normalizedMessageId;
    }
    const projectedPrimaryRow = projectionContext.rowByPrimaryMessageId?.get?.(normalizedMessageId) || null;
    const renderMessageId = String(projectedPrimaryRow?.render_message_id || '').trim();
    if (renderMessageId) {
      return renderMessageId;
    }
    const projectedSourceRow = resolveProjectedRowBySourceMessageId(
      normalizedMessageId,
      projectionContext
    );
    const sourceRenderMessageId = String(
      projectedSourceRow?.render_message_id || projectedSourceRow?.primary_message_id || ''
    ).trim();
    if (sourceRenderMessageId) {
      return sourceRenderMessageId;
    }
    const turnId = String(
      projectionContext.turnIdByMessageId?.get?.(normalizedMessageId) || ''
    ).trim();
    if (!turnId) {
      return normalizedMessageId;
    }
    const turn = projectionContext.turnById?.get?.(turnId) || null;
    const primaryAssistantMessageId = String(turn?.primary_assistant_message_id || '').trim();
    return primaryAssistantMessageId || normalizedMessageId;
  }

  function resolveProjectedRowBySourceMessageId(messageId, projectionContext) {
    const normalizedMessageId = String(messageId || '').trim();
    if (
      !normalizedMessageId
      || !projectionContext
      || !(projectionContext.rowsByTurnId instanceof Map)
    ) {
      return null;
    }
    const turnId = String(
      projectionContext.turnIdByMessageId?.get?.(normalizedMessageId) || ''
    ).trim();
    const rowGroups = turnId
      ? [projectionContext.rowsByTurnId.get(turnId) || []]
      : Array.from(projectionContext.rowsByTurnId.values());
    for (const rows of rowGroups) {
      const sourceRows = Array.isArray(rows) ? rows : [];
      for (const row of sourceRows) {
        if (!Array.isArray(row?.source_message_ids)) {
          continue;
        }
        for (const sourceId of row.source_message_ids) {
          if (String(sourceId || '').trim() === normalizedMessageId) {
            return row;
          }
        }
      }
    }
    return null;
  }

  function getMessageIdMatches(container, messageId) {
    const normalizedMessageId = String(messageId || '').trim();
    if (
      !container
      || !normalizedMessageId
      || typeof container.querySelectorAll !== 'function'
    ) {
      return [];
    }
    try {
      const exactMatches = Array.from(
        container.querySelectorAll(`[data-message-id="${escapeSelectorValue(normalizedMessageId)}"]`)
      );
      if (exactMatches.length) {
        return exactMatches;
      }
    } catch (_error) {
      /* Fall through to the attribute-scan fallback for odd selector engines / ids. */
    }
    return Array.from(container.querySelectorAll('[data-message-id]')).filter(function filterMessageId(node) {
      return String(node?.getAttribute?.('data-message-id') || '').trim() === normalizedMessageId;
    });
  }

  function getRowMatchesForMessageId(container, messageId, options = {}) {
    const normalizedMessageId = String(messageId || '').trim();
    if (
      !container
      || !normalizedMessageId
      || typeof container.querySelectorAll !== 'function'
    ) {
      return [];
    }
    const rowKind = String(options.rowKind || options.row_kind || '').trim();
    const rowKindSelector = rowKind
      ? `[data-row-kind="${escapeSelectorValue(rowKind)}"]`
      : '';
    try {
      const escapedMessageId = escapeSelectorValue(normalizedMessageId);
      const directMatches = Array.from(container.querySelectorAll([
        `.chat-row${rowKindSelector}[data-source-message-id="${escapedMessageId}"]`,
        `.chat-row${rowKindSelector}[data-render-message-id="${escapedMessageId}"]`,
        `.chat-row${rowKindSelector}[data-source-message-ids~="${escapedMessageId}"]`,
      ].join(', ')));
      if (directMatches.length) {
        return directMatches;
      }
    } catch (_error) {
      /* Fall through to the attribute-scan fallback for odd selector engines / ids. */
    }
    return Array.from(container.querySelectorAll('.chat-row[data-source-message-id], .chat-row[data-source-message-ids], .chat-row[data-render-message-id]'))
      .filter(function filterRowTarget(row) {
        if (rowKind && String(row?.getAttribute?.('data-row-kind') || '').trim() !== rowKind) {
          return false;
        }
        const primarySourceId = String(row?.getAttribute?.('data-source-message-id') || '').trim();
        const renderMessageId = String(row?.getAttribute?.('data-render-message-id') || '').trim();
        if (primarySourceId === normalizedMessageId || renderMessageId === normalizedMessageId) {
          return true;
        }
        const allSourceIds = String(row?.getAttribute?.('data-source-message-ids') || '').split(/\s+/).filter(Boolean);
        return allSourceIds.includes(normalizedMessageId);
      });
  }

  function resolveVisibleMessageDomTarget(container, messageId, options = {}) {
    const rowMatches = getRowMatchesForMessageId(container, messageId, options);
    if (options && options.preferRow === true && rowMatches.length) {
      return rowMatches[0];
    }
    const matches = getMessageIdMatches(container, messageId);
    if (!matches.length) {
      const row = rowMatches[0] || null;
      return options && options.preferRow === true
        ? row
        : (row?.closest?.('[data-message-id]:not(.thread-compat-anchor)') || row);
    }
    const directVisibleMatch = matches.find(function findVisibleMatch(node) {
      return !isThreadCompatAnchor(node);
    });
    if (directVisibleMatch) {
      if (options && options.preferRow === true) {
        const nestedRow = rowMatches.find(function findNestedRow(row) {
          return directVisibleMatch.contains(row);
        });
        if (nestedRow) {
          return nestedRow;
        }
      }
      return directVisibleMatch;
    }
    if (rowMatches.length) {
      return options && options.preferRow === true
        ? rowMatches[0]
        : (rowMatches[0].closest?.('[data-message-id]:not(.thread-compat-anchor)') || rowMatches[0]);
    }
    let threadNode = matches[0]?.closest?.('.chat-thread-node') || null;
    while (threadNode) {
      const articleHost = threadNode.querySelector('.chat-thread-node-row .chat-thread-node-article');
      const renderedTarget = articleHost?.querySelector?.('[data-message-id]:not(.thread-compat-anchor)') || null;
      if (renderedTarget) {
        return renderedTarget;
      }
      threadNode = threadNode.parentElement?.closest?.('.chat-thread-node') || null;
    }
    return matches[0] || null;
  }

  function createTurnShellRenderer(deps) {
    const settings = deps || {};
    const escapeHtml = typeof settings.escapeHtml === 'function'
      ? settings.escapeHtml
      : function fallbackEscapeHtml(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      };

    function buildSyntheticRowId(messageId) {
      return `shell:${String(messageId || '').trim()}`;
    }

    function buildSyntheticRowMarkup(messageId, innerHtml, options) {
      const rowOptions = options || {};
      const rowClassName = String(rowOptions.rowClassName || '').trim();
      const sourceMessageId = String(rowOptions.sourceMessageId || messageId || '').trim();
      const rowId = String(rowOptions.rowId || buildSyntheticRowId(messageId)).trim();
      return `
        <div
          class="chat-row${rowClassName ? ` ${escapeHtml(rowClassName)}` : ''}"
          data-row-id="${escapeHtml(rowId)}"
          data-source-message-id="${escapeHtml(sourceMessageId)}"
        >
          ${innerHtml}
        </div>
      `;
    }

    function buildTurnRowListMarkup(rowMarkup) {
      return `
        <div class="turn-row-list" data-turn-row-list="true">
          ${rowMarkup}
        </div>
      `;
    }

    function buildMessageBodyShell(messageId, innerHtml, options) {
      return buildTurnRowListMarkup(buildSyntheticRowMarkup(messageId, innerHtml, options));
    }

    function buildAssistantContentShell(messageId, innerHtml, options) {
      return `
        <div class="chat-message-content">
          ${buildMessageBodyShell(messageId, innerHtml, options)}
        </div>
      `;
    }

    function buildArticleLayoutAttributes(predictedHeight) {
      const nextHeight = Number(predictedHeight) || 0;
      if (nextHeight <= 0) {
        return '';
      }
      const heightAttr = escapeHtml(String(nextHeight));
      return `
          data-predicted-height="${heightAttr}"
          style="min-height: ${heightAttr}px"
      `;
    }

    // F4/F5/F6: optionally builds the selection-handle markup via the
    // inventory primitive when selection mode is active for a given role.
    // Roles other than user/assistant don't receive a handle (system / tool
    // notice rows are not user-selectable).
    function buildSelectionHandleHtmlForArticle(messageRole, messageId, selected) {
      const role = String(messageRole || '').trim().toLowerCase();
      if (role !== 'user' && role !== 'assistant') return '';
      const inventory = typeof globalThis !== 'undefined'
        ? globalThis.inventorySelectionHandle
        : null;
      if (!inventory || typeof inventory.buildSelectionHandleMarkup !== 'function') return '';
      const ariaLabel = role === 'assistant'
        ? 'Select message from Jenny'
        : 'Select your message';
      return inventory.buildSelectionHandleMarkup({
        messageId,
        selected: selected === true,
        ariaLabel,
      });
    }

    function buildMessageShellArticle(options) {
      const shellOptions = options || {};
      const className = String(shellOptions.className || '').trim();
      const messageId = String(shellOptions.messageId || '').trim();
      const messageRole = String(shellOptions.messageRole || '').trim();
      const messageStatus = String(shellOptions.messageStatus || '').trim();
      const finalizedAt = String(shellOptions.finalizedAt || '').trim();
      const extraAttributes = String(shellOptions.extraAttributes || '').trim();
      const ariaLabel = describeMessageRole(messageRole);
      // F4/F5/F6: selection mode adornment. data-selected is always emitted
      // when selectionMode is on, even for non-selectable roles, so the CSS
      // layout shift applies uniformly.
      const selectionMode = shellOptions.selectionMode === true;
      const selected = shellOptions.selected === true;
      const selectedAttr = selectionMode
        ? ` data-selected="${selected ? 'true' : 'false'}"`
        : '';
      // Ht-D: build-time exemption. Flag-gated at this single choke point so
      // every article-producing call site stays byte-identical when the flag
      // is off, without needing its own gate.
      const cvExemptAttr = shellOptions.cvExempt === true && isChatContentVisibilityFlagOn()
        ? ' data-cv-exempt="true"'
        : '';
      const selectionHandleHtml = selectionMode
        ? buildSelectionHandleHtmlForArticle(messageRole, messageId, selected)
        : '';
      const innerHtml = shellOptions.innerHtml || '';
      const articleInner = selectionHandleHtml
        ? `${selectionHandleHtml}${innerHtml}`
        : innerHtml;
      return `
        <article
          class="chat-entry message-shell${className ? ` ${escapeHtml(className)}` : ''}"
          data-message-id="${escapeHtml(messageId)}"
          data-message-role="${escapeHtml(messageRole)}"
          data-message-status="${escapeHtml(messageStatus)}"
          data-finalized-at="${escapeHtml(finalizedAt)}"${selectedAttr}${cvExemptAttr}
          tabindex="-1"
          aria-label="${escapeHtml(ariaLabel)}"
          ${extraAttributes ? `${extraAttributes}` : ''}
          ${buildArticleLayoutAttributes(shellOptions.predictedHeight)}
        >
          ${articleInner}
        </article>
      `;
    }

    return {
      buildAssistantContentShell,
      buildMessageBodyShell,
      buildMessageShellArticle,
      buildSyntheticRowId,
      buildSyntheticRowMarkup,
      buildTurnRowListMarkup,
    };
  }

  return {
    createTurnShellRenderer,
    resolveTurnArticleMessageId,
    resolveVisibleMessageDomTarget,
    describeMessageRole,
    hasUnresolvedApprovalGapRow,
    syncChatEntryCvExemptAttribute,
  };
});
