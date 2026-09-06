(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererViewportRecapUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createViewportRecapUtils(deps) {
    const {
      state,
      chatTimeline,
      escapeSelectorValue,
      getCurrentMessageById,
      renderMessages,
      getCurrentSessionMessages,
      isMapLike,
      isSetLike,
      buildInteractiveRecapViewModel,
    } = deps;

    function ensureInteractiveRecapExpandedMap() {
      if (!isMapLike(state.ui.interactiveRecapExpandedBySession)) {
        state.ui.interactiveRecapExpandedBySession = new Map();
      }
      return state.ui.interactiveRecapExpandedBySession;
    }

    function getInteractiveRecapExpandedSet(sessionId, options = {}) {
      const resolvedSessionId = String(sessionId || '').trim();
      if (!resolvedSessionId) {
        return null;
      }
      const expandedBySession = ensureInteractiveRecapExpandedMap();
      if (expandedBySession.has(resolvedSessionId)) {
        return expandedBySession.get(resolvedSessionId);
      }
      if (options.create) {
        const createdSet = new Set();
        expandedBySession.set(resolvedSessionId, createdSet);
        return createdSet;
      }
      return null;
    }

    function resolveInteractiveRecapModel(message) {
      if (!message || String(message.kind || '') !== 'interactive_round_recap') {
        return null;
      }
      if (typeof buildInteractiveRecapViewModel === 'function') {
        return buildInteractiveRecapViewModel(message);
      }
      const recap = message && message.interactive_round_recap && typeof message.interactive_round_recap === 'object'
        ? message.interactive_round_recap
        : null;
      if (!recap) {
        return null;
      }
      const items = Array.isArray(recap.items) ? recap.items : [];
      const questionSummaries = items
        .map((item, index) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return null;
          }
          const prompt = String(item.prompt || item.question || item.question_text || '').trim();
          const answerLabel = String(item.answer_label || item.answer || item.selection_label || '').trim();
          if (!prompt && !answerLabel) {
            return null;
          }
          return {
            questionId: String(item.question_id || item.id || `q${index + 1}`).trim(),
            prompt,
            answerLabel,
          };
        })
        .filter(Boolean);
      const parsedAnswerCount = Number(recap.answer_count);
      const askedCount = Number.isFinite(parsedAnswerCount) && parsedAnswerCount > 0
        ? Math.max(1, Math.floor(parsedAnswerCount))
        : questionSummaries.length;
      if (askedCount < 1 && !questionSummaries.length) {
        return null;
      }
      const turnId = String(recap.turn_id || recap.turnId || message.turn_id || message.turnId || '').trim();
      const requestId = String(
        recap.request_id || recap.requestId || message.request_id || message.requestId || message.streamId || ''
      ).trim();
      const batchId = String(recap.batch_id || recap.batchId || '').trim();
      const parsedRoundIndex = Number(recap.round_index);
      const roundIndex = Number.isFinite(parsedRoundIndex) && parsedRoundIndex > 0
        ? Math.floor(parsedRoundIndex)
        : 0;
      const keyParts = [];
      if (turnId) keyParts.push(`turn:${turnId}`);
      if (requestId) keyParts.push(`request:${requestId}`);
      if (batchId) keyParts.push(`batch:${batchId}`);
      if (roundIndex > 0) keyParts.push(`round:${roundIndex}`);
      return {
        recapId: keyParts.length
          ? `interactive-recap:${keyParts.join('|')}`
          : `interactive-recap:message:${String(message.id || '').trim()}`,
        askedCount,
        questionSummaries,
        sourceMessageRefs: [],
        isPartial: String(message.status || '').trim() === 'streaming',
      };
    }

    function findInteractiveRecapModelById(recapId, messages) {
      const targetRecapId = String(recapId || '').trim();
      if (!targetRecapId) {
        return null;
      }
      const sourceMessages = Array.isArray(messages) ? messages : [];
      for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
        const recapModel = resolveInteractiveRecapModel(sourceMessages[index]);
        if (recapModel && String(recapModel.recapId || '') === targetRecapId) {
          return recapModel;
        }
      }
      return null;
    }

    function isInteractiveRoundRecapExpanded(recapId, sessionId) {
      const expandedSet = getInteractiveRecapExpandedSet(
        String(sessionId || state.currentSessionId || '').trim()
      );
      if (!expandedSet) {
        return false;
      }
      return expandedSet.has(String(recapId || '').trim());
    }

    function pruneInteractiveRoundRecapExpansionState(sessionId, messages) {
      const resolvedSessionId = String(sessionId || '').trim();
      if (!resolvedSessionId) {
        return;
      }
      const expandedBySession = ensureInteractiveRecapExpandedMap();
      const expandedSet = expandedBySession.get(resolvedSessionId);
      if (!isSetLike(expandedSet) || expandedSet.size === 0) {
        return;
      }
      const sourceMessages = Array.isArray(messages) ? messages : [];
      const validRecapIds = new Set();
      for (let index = 0; index < sourceMessages.length; index += 1) {
        const recapModel = resolveInteractiveRecapModel(sourceMessages[index]);
        if (recapModel && recapModel.recapId) {
          validRecapIds.add(String(recapModel.recapId));
        }
      }
      Array.from(expandedSet).forEach((recapId) => {
        if (!validRecapIds.has(String(recapId || ''))) {
          expandedSet.delete(recapId);
        }
      });
      if (!expandedSet.size) {
        expandedBySession.delete(resolvedSessionId);
      }
    }

    function syncInteractiveRecapRows(recapId, sessionId) {
      if (!chatTimeline) {
        return false;
      }
      const normalizedRecapId = String(recapId || '').trim();
      const normalizedSessionId = String(sessionId || state.currentSessionId || '').trim();
      if (!normalizedRecapId || !normalizedSessionId) {
        return false;
      }
      const expanded = isInteractiveRoundRecapExpanded(normalizedRecapId, normalizedSessionId);
      const selector = `[data-interactive-recap-row][data-recap-id="${escapeSelectorValue(normalizedRecapId)}"]`;
      const rows = chatTimeline.querySelectorAll(selector);
      rows.forEach((row) => {
        row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        row.classList.toggle('expanded', expanded);
        const recapBlock = row.closest('.interactive-recap-block');
        if (recapBlock) {
          recapBlock.classList.toggle('expanded', expanded);
        }
        const panelId = String(row.getAttribute('aria-controls') || '').trim();
        const panel = panelId
          ? document.getElementById(panelId)
          : row.parentElement?.querySelector('.interactive-recap-panel') || null;
        if (!panel) {
          return;
        }
        panel.classList.toggle('expanded', expanded);
        panel.hidden = !expanded;
      });
      return rows.length > 0;
    }

    function getSessionMessagesForRecap(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return [];
      }
      if (normalizedSessionId === String(state.currentSessionId || '').trim()) {
        return getCurrentSessionMessages();
      }
      const messagesBySession = state.messagesBySession;
      if (messagesBySession && typeof messagesBySession.get === 'function') {
        const candidate = messagesBySession.get(normalizedSessionId);
        return Array.isArray(candidate) ? candidate : [];
      }
      return [];
    }

    function findRecapSessionId(recapId, messageId) {
      const normalizedRecapId = String(recapId || '').trim();
      const normalizedMessageId = String(messageId || '').trim();
      const messagesBySession = state.messagesBySession;
      if (!messagesBySession || typeof messagesBySession.entries !== 'function') {
        return '';
      }
      for (const [sessionId, rawMessages] of messagesBySession.entries()) {
        const messages = Array.isArray(rawMessages) ? rawMessages : [];
        const found = messages.some((message) => {
          if (normalizedMessageId && String(message?.id || '').trim() === normalizedMessageId) {
            return true;
          }
          if (!normalizedRecapId || String(message?.kind || '').trim() !== 'interactive_round_recap') {
            return false;
          }
          const recapModel = resolveInteractiveRecapModel(message);
          return String(recapModel?.recapId || '').trim() === normalizedRecapId;
        });
        if (found) {
          return String(sessionId || '').trim();
        }
      }
      return '';
    }

    async function toggleInteractiveRoundRecap(target) {
      const source = target && typeof target === 'object' && !Array.isArray(target)
        ? target
        : { messageId: target };
      const recapId = String(source.recapId || '').trim();
      const messageId = String(source.messageId || '').trim();
      const resolvedSessionId = String(
        source.sessionId
        || state.currentSessionId
        || state.activeSessionId
        || findRecapSessionId(recapId, messageId)
        || ''
      ).trim();
      if (!resolvedSessionId) {
        return;
      }

      const currentMessages = getSessionMessagesForRecap(resolvedSessionId);
      const recapModel = recapId
        ? findInteractiveRecapModelById(recapId, currentMessages)
        : resolveInteractiveRecapModel(getCurrentMessageById(messageId));
      const resolvedRecapId = String(recapModel?.recapId || recapId || '').trim();
      if (!resolvedRecapId) {
        return;
      }

      const expandedSet = getInteractiveRecapExpandedSet(resolvedSessionId, { create: true });
      if (!expandedSet) {
        return;
      }
      if (expandedSet.has(resolvedRecapId)) {
        expandedSet.delete(resolvedRecapId);
      } else {
        expandedSet.add(resolvedRecapId);
      }
      if (!expandedSet.size) {
        ensureInteractiveRecapExpandedMap().delete(resolvedSessionId);
      }
      const syncedExistingRows = syncInteractiveRecapRows(resolvedRecapId, resolvedSessionId);
      if (!syncedExistingRows) {
        renderMessages();
      }
    }

    return {
      isInteractiveRoundRecapExpanded,
      pruneInteractiveRoundRecapExpansionState,
      toggleInteractiveRoundRecap,
    };
  }

  return {
    createViewportRecapUtils,
  };
});
