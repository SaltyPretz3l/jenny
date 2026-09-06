(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnRowBubbleUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fallbackEscapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fallbackNormalizeId(value) {
    return String(value || '').trim();
  }

  function createTurnRowBubbleUtils(deps) {
    const settings = deps || {};
    const escapeHtml = typeof settings.escapeHtml === 'function'
      ? settings.escapeHtml
      : fallbackEscapeHtml;
    const normalizeId = typeof settings.normalizeId === 'function'
      ? settings.normalizeId
      : fallbackNormalizeId;
    const getMessageById = typeof settings.getMessageById === 'function'
      ? settings.getMessageById
      : function noopGetMessageById() { return null; };
    const getFeatureFlags = typeof settings.getFeatureFlags === 'function'
      ? settings.getFeatureFlags
      : function noopGetFeatureFlags() { return {}; };
    const renderMarkdown = typeof settings.renderMarkdown === 'function'
      ? settings.renderMarkdown
      : function fallbackRenderMarkdown(text) { return escapeHtml(String(text || '')); };
    const renderStreamingMarkdownUnits = typeof settings.renderStreamingMarkdownUnits === 'function'
      ? settings.renderStreamingMarkdownUnits
      : function noopRenderStreamingMarkdownUnits() { return { html: '', units: [] }; };
    const renderMessageAttachments = typeof settings.renderMessageAttachments === 'function'
      ? settings.renderMessageAttachments
      : function noopRenderMessageAttachments() { return ''; };
    const resolveTurnRowModule = typeof settings.resolveTurnRowModule === 'function'
      ? settings.resolveTurnRowModule
      : function noopResolveTurnRowModule() { return null; };

    function getSourceMessage(row, messages, options) {
      const renderOptions = options || {};
      return getMessageById(row && row.primary_message_id, messages, renderOptions.messageById);
    }

    function buildStreamUnitsMarkup(streamUnits) {
      const units = Array.isArray(streamUnits) ? streamUnits : [];
      return units.map(function renderUnit(unit, index) {
        const revealed = unit && unit.revealed ? ' is-revealed' : '';
        return `<div class="chat-stream-unit${revealed}" data-stream-unit-index="${index}">${String(unit && unit.html || '')}</div>`;
      }).join('');
    }

    function buildStreamingBubbleHtml(text, options) {
      const renderOptions = options || {};
      const reducedMotion = renderOptions.reducedMotion === true;
      if (Array.isArray(renderOptions.streamUnits) && renderOptions.streamUnits.length) {
        return buildStreamUnitsMarkup(renderOptions.streamUnits);
      }
      const renderModel = renderStreamingMarkdownUnits(String(text || ''), {
        previousFingerprints: Array.isArray(renderOptions.previousFingerprints)
          ? renderOptions.previousFingerprints
          : [],
      });
      const changedStart = renderOptions.streamChangedStart != null
        ? Number(renderOptions.streamChangedStart)
        : Number(renderModel && renderModel.changedStartIndex);
      if (Array.isArray(renderModel?.units) && renderModel.units.length) {
        return buildStreamUnitsMarkup(renderModel.units.map(function normalizeUnit(unit, index) {
          return {
            html: String(unit && unit.html || ''),
            revealed: reducedMotion
              ? false
              : Number.isFinite(changedStart) && changedStart >= 0
              ? index >= changedStart
              : Boolean(unit && unit.revealed),
          };
        }));
      }
      return String(renderModel && renderModel.html || '');
    }

    function shouldRenderMessageAttachments(row, options) {
      const renderOptions = options || {};
      const siblingRows = Array.isArray(renderOptions.siblingRows) ? renderOptions.siblingRows : [];
      const rowIndex = Number.isInteger(renderOptions.rowIndex) ? renderOptions.rowIndex : -1;
      const rowKind = normalizeId(row && row.kind);
      if (rowKind === 'user_bubble') {
        return true;
      }
      if (rowKind !== 'assistant_text') {
        return false;
      }
      const primaryMessageId = normalizeId(row && row.primary_message_id);
      if (!primaryMessageId || rowIndex < 0) {
        return true;
      }
      for (let index = rowIndex + 1; index < siblingRows.length; index += 1) {
        const candidate = siblingRows[index];
        if (!candidate) {
          continue;
        }
        if (normalizeId(candidate.kind) !== 'assistant_text') {
          continue;
        }
        if (normalizeId(candidate.primary_message_id) === primaryMessageId) {
          return false;
        }
      }
      return true;
    }

    function buildRowAttachmentsMarkup(messageLike) {
      return String(renderMessageAttachments(messageLike) || '').trim();
    }

    /* message.send_failure is the source of truth; the explicit status chip is accessible. */
    function buildSendFailureChipMarkup(messageLike) {
      const failure = messageLike && messageLike.send_failure;
      if (!failure || failure.state !== 'failed' || failure.dismissed === true) {
        return '';
      }
      /* Error-center recording is flag-gated, best-effort, and deduplicated by message ID. */
      if (typeof globalThis !== 'undefined' && typeof globalThis.rendererErrorCenterRecord === 'function') {
        try {
          globalThis.rendererErrorCenterRecord({
            key: 'send-failure:' + String(messageLike.id || ''),
            title: 'Message failed to send',
            surface: 'composer',
            severity: 'warning',
          });
        } catch (_err) { /* history is best-effort */ }
      }
      return '<span class="chat-bubble-send-status" role="status">Failed to send</span>';
    }

    function buildUserBubbleRowMarkup(row, messages, options) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const sourceMessage = getSourceMessage(row, messages, options);
      const text = String(payload.content || sourceMessage && sourceMessage.content || '');
      const messageId = normalizeId(row && row.primary_message_id);
      const messageForAttachments = sourceMessage
        ? sourceMessage
        : {
            id: messageId,
            attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
          };
      const renderOptions = options || {};
      const editingMessageId = String(renderOptions.editingMessageId || '');
      const isEditingThisRow = !!editingMessageId && !!messageId && editingMessageId === messageId;
      let bubbleMarkup;
      if (isEditingThisRow) {
        const draftText = typeof renderOptions.editingDraftText === 'string'
          ? renderOptions.editingDraftText
          : text;
        const committing = renderOptions.editingCommitting === true;
        bubbleMarkup = buildEditingUserBubbleMarkup(messageId, draftText, { committing });
      } else {
        const failureChip = buildSendFailureChipMarkup(sourceMessage);
        const sendStateAttr = failureChip ? ' data-send-state="failed"' : '';
        bubbleMarkup = text.trim()
          ? `<div class="chat-bubble chat-bubble-markdown" data-pin-fade-trigger="user"${sendStateAttr}>${renderMarkdown(text, { breaks: true })}${failureChip}</div>`
          : '';
      }
      const attachmentsMarkup = shouldRenderMessageAttachments(row, options)
        ? buildRowAttachmentsMarkup(messageForAttachments)
        : '';
      return `${bubbleMarkup}${attachmentsMarkup}`;
    }

    // F2: inline edit affordance for user bubbles. Delegates to the
    // inventory primitive at renderer/inventory/inline-text-editor.js
    // so the raw textarea + button markup lives inside renderer/inventory/
    // (check_no_raw_html_primitives.py contract). The textarea carries
    // data-edit-target-message-id so the edit-utils controller can
    // locate + wire it after each render.
    function buildEditingUserBubbleMarkup(messageId, draftText, options) {
      const opts = options || {};
      const inventory = typeof globalThis !== 'undefined'
        ? globalThis.inventoryInlineTextEditor
        : null;
      if (inventory && typeof inventory.buildInlineUserMessageEditorMarkup === 'function') {
        return inventory.buildInlineUserMessageEditorMarkup({
          messageId,
          draftText,
          committing: opts.committing === true,
          affectedCount: opts.affectedCount,
        });
      }
      // Test/headless fallback — if the inventory primitive isn't loaded,
      // emit a minimal bubble shell so the caller still gets editable
      // markup. Render-path tests load the inventory module before this.
      const id = String(messageId || '');
      const draft = String(draftText == null ? '' : draftText);
      return `<div class="chat-bubble chat-bubble-editing" data-message-id="${escapeHtml(id)}" data-pin-fade-trigger="user">${escapeHtml(draft)}</div>`;
    }

    /* EH-W5: rows the reducer marked truncated (stream_reset discarded
     * their tail) get a subtle hairline marker — a reset that recovers
     * cleanly shows nothing else (no system_notice, no toast). Upstream
     * guarantee: markLatestAssistantRowsTruncated in
     * renderer-turn-reducer.js (covered by renderer-turn-reducer.test.js). */
    function buildTruncationMarkerMarkup(payload) {
      if (!payload || payload.truncated !== true) {
        return '';
      }
      return '<div class="chat-truncation-marker" role="note" aria-label="Response restarted">'
        + '<span class="chat-truncation-marker-rule" aria-hidden="true"></span>'
        + '<span class="chat-truncation-marker-label">restarted</span>'
        + '<span class="chat-truncation-marker-rule" aria-hidden="true"></span>'
        + '</div>';
    }

    // Citations: gpt-oss (at minimum) echoes the tool's web:N ids back into
    // the visible answer as raw [web:N] / 【web:N】 markers (drive evidence:
    // queue #13). The chip row (buildSystemNoticeRowMarkup, subkind
    // source_citations) makes those markers redundant noise once it exists,
    // so strip them from the settled bubble text — flag-gated so a flag-off
    // relaunch renders the marker exactly as before (parity with the
    // collector/row derive gate). Streaming text is left untouched: a marker
    // can arrive split across chunks mid-stream, and the settled re-render
    // (this function, isStreaming false) cleans it up once the message
    // finalizes.
    function stripCitationMarkersForDisplay(text) {
      if (getFeatureFlags()?.source_citations !== true) {
        return text;
      }
      const chipsModule = resolveTurnRowModule('rendererCitationChipsUtils', './renderer-citation-chips-utils');
      if (!chipsModule || typeof chipsModule.stripCitationMarkers !== 'function') {
        return text;
      }
      return chipsModule.stripCitationMarkers(text);
    }

    return {
      getSourceMessage,
      buildStreamUnitsMarkup,
      buildStreamingBubbleHtml,
      shouldRenderMessageAttachments,
      buildRowAttachmentsMarkup,
      buildSendFailureChipMarkup,
      buildUserBubbleRowMarkup,
      buildEditingUserBubbleMarkup,
      buildTruncationMarkerMarkup,
      stripCitationMarkersForDisplay,
    };
  }

  return {
    createTurnRowBubbleUtils,
  };
});
