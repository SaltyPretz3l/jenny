(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnRowBubbleUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  // Literal keys per reason (the i18n scanner rejects computed keys).
  function discardReasonPhrase(reason) {
    switch (reason) {
      case 'provider_retry': return jt('chat.discardedDraft.reason.provider_retry', 'the engine dropped the reply, so Jenny asked again');
      case 'nudge_retry': return jt('chat.discardedDraft.reason.nudge_retry', 'it skipped a tool it needed, so Jenny asked again');
      case 'reflexive_retry': return jt('chat.discardedDraft.reason.reflexive_retry', 'the first answer missed, so Jenny asked again');
      case 'post_tool_restart': return jt('chat.discardedDraft.reason.post_tool_restart', "the answer after the tools didn't hold up, so Jenny asked again");
      case 'deterministic_replacement': return jt('chat.discardedDraft.reason.deterministic_replacement', "it made up a result Jenny couldn't get, so Jenny replaced it");
      case 'verification_gate_retry': return jt('chat.discardedDraft.reason.verification_gate_retry', 'it failed a check, so Jenny asked again');
      case 'model_winddown': return jt('chat.discardedDraft.reason.model_winddown', 'cut short so the reply could wrap up within limits');
      default: return jt('chat.discardedDraft.reason.unknown', 'Jenny started this part over');
    }
  }

  function discardReceiptReasonPhrase(reason) {
    switch (reason) {
      case 'provider_retry': return jt('chat.discardedDraft.receiptReason.provider_retry', 'the engine dropped the reply');
      case 'nudge_retry': return jt('chat.discardedDraft.receiptReason.nudge_retry', 'it skipped a tool it needed');
      case 'reflexive_retry': return jt('chat.discardedDraft.receiptReason.reflexive_retry', 'the first answer missed');
      case 'post_tool_restart': return jt('chat.discardedDraft.receiptReason.post_tool_restart', "the answer after the tools didn't hold up");
      case 'deterministic_replacement': return jt('chat.discardedDraft.receiptReason.deterministic_replacement', 'it made up a result');
      case 'verification_gate_retry': return jt('chat.discardedDraft.receiptReason.verification_gate_retry', 'it failed a check');
      case 'model_winddown': return jt('chat.discardedDraft.receiptReason.model_winddown', 'cut short to wrap up');
      default: return jt('chat.discardedDraft.receiptReason.unknown', 'started over');
    }
  }

  const fallbackEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

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
        return `<div class="chat-stream-unit" data-stream-unit-index="${index}">${String(unit && unit.html || '')}</div>`;
      }).join('');
    }

    function buildStreamingBubbleHtml(text, options) {
      const renderOptions = options || {};
      if (Array.isArray(renderOptions.streamUnits) && renderOptions.streamUnits.length) {
        return buildStreamUnitsMarkup(renderOptions.streamUnits);
      }
      const renderModel = renderStreamingMarkdownUnits(stripCitationMarkersForDisplay(String(text || ''), { streaming: true }), {
        previousFingerprints: Array.isArray(renderOptions.previousFingerprints)
          ? renderOptions.previousFingerprints
          : [],
      });
      if (Array.isArray(renderModel?.units) && renderModel.units.length) {
        return buildStreamUnitsMarkup(renderModel.units);
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
            title: jt('chat.bubble.sendFailedTitle', 'Message failed to send'),
            surface: 'composer',
            severity: 'warning',
          });
        } catch (_err) { /* history is best-effort */ }
      }
      return '<span class="chat-bubble-send-status" role="status">' + escapeHtml(jt('chat.bubble.failedToSend', 'Failed to send')) + '</span>';
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
          ? `<div class="chat-bubble chat-bubble-markdown" dir="auto" data-pin-fade-trigger="user"${sendStateAttr}>${renderMarkdown(text, { breaks: true, literalBackslashes: true })}${failureChip}</div>`
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
      return `<div class="chat-bubble chat-bubble-editing" dir="auto" data-message-id="${escapeHtml(id)}" data-pin-fade-trigger="user">${escapeHtml(draft)}</div>`;
    }

    /* Live stream_reset fold: the reducer stamps ONE anchor row per reset
     * (discard_anchor + reason + capped erased text) and hides the rest
     * (discard_hidden). Plain escaped text, closed by default; a plain
     * <details> keeps its open state through the preservation registry. */
    function buildDiscardedDraftFoldMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      if (payload.discard_anchor !== true) {
        return '';
      }
      const text = String(payload.discard_text || '');
      const reasoning = String(payload.discard_reasoning_text || '');
      return '<details class="chat-discarded-draft"><summary>'
        + '<span class="chat-discarded-draft-chevron" aria-hidden="true">&#9654;</span>'
        + `<span class="chat-discarded-draft-what">${escapeHtml(jt('chat.discardedDraft.summary', 'Draft discarded'))}</span>`
        + `<span class="chat-discarded-draft-reason">\u00b7 ${escapeHtml(discardReasonPhrase(payload.discard_reason))}</span>`
        + '</summary><div class="chat-discarded-draft-body">'
        + (text ? `<div class="chat-discarded-draft-text">${escapeHtml(text)}</div>` : '')
        + (reasoning
          ? `<div class="chat-discarded-draft-label">${escapeHtml(jt('chat.discardedDraft.thinking', 'Thinking'))}</div>`
            + `<div class="chat-discarded-draft-text chat-discarded-draft-reasoning">${escapeHtml(reasoning)}</div>`
          : '')
        + (payload.discard_text_trimmed === true
          ? `<div class="chat-discarded-draft-trimmed">${escapeHtml(jt('chat.discardedDraft.trimmed', 'Trimmed.'))}</div>`
          : '')
        + `<div class="chat-discarded-draft-note">${escapeHtml(jt('chat.discardedDraft.notSaved', 'Not saved. Shown only while this reply is streaming.'))}</div>`
        + '</div></details>';
    }

    /* Settled receipt: one line under the LAST assistant_text row of a message
     * whose persisted discarded_drafts is set. "Last" = no later sibling
     * assistant_text row shares its primary_message_id (the attachments rule), so
     * every settled turn keeps its receipt, not just the resume tail. */
    function buildDiscardedReceiptMarkup(row, sourceMessage, options) {
      const drafts = sourceMessage && sourceMessage.discarded_drafts;
      const draftCount = Math.floor(Number(drafts && drafts.count));
      // Between `complete` and the hydrated swap the live fold is still on
      // screen ("Shown only while this reply is streaming"): no receipt yet.
      const liveFoldShown = (options.turnRows || options.siblingRows || []).some((sibling) => sibling?.payload?.discard_anchor === true);
      if (!(draftCount > 0) || options.isStreaming === true || liveFoldShown || !shouldRenderMessageAttachments(row, options)) {
        return '';
      }
      const phrase = discardReceiptReasonPhrase(drafts.latest_reason);
      const label = jtn('chat.discardedDraft.receipt', draftCount, { count: draftCount }, '{count} draft discarded', '{count} drafts discarded');
      return `<div class="chat-discarded-receipt" title="${escapeHtml(jt('chat.discardedDraft.receiptTitle', 'Jenny threw away a draft of this reply and replaced it. The draft was not saved.'))}">${escapeHtml(`${label} \u00b7 ${phrase}`)}</div>`;
    }

    // Citations: gpt-oss (at minimum) echoes the tool's web:N ids back into
    // the visible answer as raw [web:N] / 【web:N】 markers (drive evidence:
    // queue #13). The chip row (buildSystemNoticeRowMarkup, subkind
    // source_citations) makes those markers redundant noise once it exists,
    // so strip them from the settled bubble text — flag-gated so a flag-off
    // relaunch renders the marker exactly as before (parity with the
    // collector/row derive gate). Streaming text uses the streaming variant,
    // which also holds back a marker still arriving split across chunks, so
    // the live bubble never shows a marker that vanishes at settle.
    function stripCitationMarkersForDisplay(text, options) {
      const chipsModule = resolveTurnRowModule('rendererCitationChipsUtils', './renderer-citation-chips-utils');
      return typeof chipsModule?.stripCitationMarkersForFlags === 'function'
        ? chipsModule.stripCitationMarkersForFlags(text, getFeatureFlags(), options)
        : text;
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
      buildDiscardedDraftFoldMarkup,
      buildDiscardedReceiptMarkup,
      stripCitationMarkersForDisplay,
    };
  }

  return {
    createTurnRowBubbleUtils,
  };
});
