(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineThreadStateUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const COLLECTION_BRAND_PROBE = Object.freeze({});

  function hasNativeCollectionBrand(value, hasMethod) {
    if (!value) return false;
    try {
      hasMethod.call(value, COLLECTION_BRAND_PROBE);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function isMapLike(value) {
    return hasNativeCollectionBrand(value, Map.prototype.has);
  }

  function isSetLike(value) {
    return hasNativeCollectionBrand(value, Set.prototype.has);
  }
  function ensureThreadBranchesCollapsedMap(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return new Map();
    }
    if (!state.ui || typeof state.ui !== 'object' || Array.isArray(state.ui)) {
      state.ui = {};
    }
    if (!isMapLike(state.ui.threadBranchesCollapsedBySession)) {
      state.ui.threadBranchesCollapsedBySession = new Map();
    }
    return state.ui.threadBranchesCollapsedBySession;
  }

  function getThreadCollapsedSetForState(state, sessionId, options) {
    const settings = options || {};
    const normalizedSessionId = String(sessionId || state?.currentSessionId || '').trim();
    if (!normalizedSessionId) {
      return null;
    }
    const collapsedBySession = ensureThreadBranchesCollapsedMap(state);
    let collapsedSet = collapsedBySession.get(normalizedSessionId);
    if (collapsedSet !== undefined && !isSetLike(collapsedSet)) {
      collapsedBySession.delete(normalizedSessionId);
      collapsedSet = null;
    }
    if (!collapsedSet && settings.create) {
      collapsedSet = new Set();
      collapsedBySession.set(normalizedSessionId, collapsedSet);
    }
    return isSetLike(collapsedSet) ? collapsedSet : null;
  }

  function clearThreadBranchCollapseState(state) {
    const stateUi = state?.ui;
    if (!stateUi || typeof stateUi !== 'object' || Array.isArray(stateUi)) return false;
    if (!Object.prototype.hasOwnProperty.call(stateUi, 'threadBranchesCollapsedBySession')) return false;
    const collapsedBySession = stateUi.threadBranchesCollapsedBySession;
    if (!isMapLike(collapsedBySession)) {
      stateUi.threadBranchesCollapsedBySession = new Map();
      return false;
    }
    Map.prototype.clear.call(collapsedBySession);
    return true;
  }


  function coalesceDefined() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = arguments[index];
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    return undefined;
  }

  function createThreadStatePipeline(deps) {
    const { state = {}, callbacks = {} } = deps || {};
    const {
      buildInteractiveRecapViewModel = null,
      isInteractiveRoundRecapExpanded = null,
      pruneInteractiveRoundRecapExpansionState = null,
      shouldShowThreadToggle = () => false,
      renderMessages = () => {},
    } = callbacks;

    const isRecapExpanded = typeof isInteractiveRoundRecapExpanded === 'function'
      ? isInteractiveRoundRecapExpanded
      : function noopIsRecapExpanded() { return false; };
    const pruneRecapExpansionState = typeof pruneInteractiveRoundRecapExpansionState === 'function'
      ? pruneInteractiveRoundRecapExpansionState
      : function noopPruneRecapExpansionState() {};

    function buildFallbackInteractiveRecapModel(message) {
      if (!message || String(message.kind || '') !== 'interactive_round_recap') {
        return null;
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
      const parsedAskedCount = Number(coalesceDefined(
        recap.asked_count,
        recap.askedCount,
        recap.answer_count,
        recap.answerCount
      ));
      const askedCount = Number.isFinite(parsedAskedCount) && parsedAskedCount > 0
        ? Math.max(1, Math.floor(parsedAskedCount))
        : questionSummaries.length;
      if (askedCount < 1 && !questionSummaries.length) {
        return null;
      }
      const turnId = String(recap.turn_id || recap.turnId || message.turn_id || message.turnId || '').trim();
      const requestId = String(
        recap.request_id || recap.requestId || message.request_id || message.requestId || message.streamId || ''
      ).trim();
      const batchId = String(recap.batch_id || recap.batchId || '').trim();
      const parsedRoundIndex = Number(coalesceDefined(recap.round_index, recap.roundIndex));
      const roundIndex = Number.isFinite(parsedRoundIndex) && parsedRoundIndex > 0
        ? Math.floor(parsedRoundIndex)
        : 0;
      const keyParts = [];
      if (turnId) keyParts.push(`turn:${turnId}`);
      if (requestId) keyParts.push(`request:${requestId}`);
      if (batchId) keyParts.push(`batch:${batchId}`);
      if (roundIndex > 0) keyParts.push(`round:${roundIndex}`);
      const recapId = keyParts.length
        ? `interactive-recap:${keyParts.join('|')}`
        : `interactive-recap:message:${String(message.id || '').trim()}`;
      return {
        recapId,
        turnId,
        requestId,
        askedCount,
        questionSummaries,
        sourceMessageRefs: [],
        isPartial: String(message.status || '').trim() === 'streaming',
      };
    }

    function buildInteractiveRecapModel(message) {
      if (typeof buildInteractiveRecapViewModel === 'function') {
        const providedModel = buildInteractiveRecapViewModel(message);
        if (providedModel && typeof providedModel === 'object') {
          return providedModel;
        }
      }
      return buildFallbackInteractiveRecapModel(message);
    }

    function getThreadCollapsedSet(sessionId, options) {
      return getThreadCollapsedSetForState(state, sessionId, options);
    }

    function isThreadBranchCollapsed(messageId, sessionId) {
      const collapsedSet = getThreadCollapsedSet(sessionId);
      const normalizedMessageId = String(messageId || '').trim();
      return Boolean(collapsedSet && normalizedMessageId && collapsedSet.has(normalizedMessageId));
    }

    function pruneThreadBranchState(sessionId, threadTree) {
      const collapsedSet = getThreadCollapsedSet(sessionId);
      if (!collapsedSet || !threadTree || !isMapLike(threadTree.nodeById)) {
        return;
      }
      const validIds = new Set();
      threadTree.nodeById.forEach(function collectValidIds(node, nodeId) {
        if (node && shouldShowThreadToggle(node)) {
          validIds.add(String(nodeId || ''));
        }
      });
      Array.from(collapsedSet).forEach(function removeInvalidId(messageId) {
        if (!validIds.has(String(messageId || ''))) {
          collapsedSet.delete(messageId);
        }
      });
      if (collapsedSet.size === 0) {
        ensureThreadBranchesCollapsedMap(state).delete(String(sessionId || state.currentSessionId || '').trim());
      }
    }

    function buildThreadExpansionSignature(threadTree, sessionId, forcedOpenIds) {
      if (!threadTree || !isMapLike(threadTree.nodeById)) {
        return '';
      }
      const forcedOpen = forcedOpenIds instanceof Set ? forcedOpenIds : new Set();
      const collapsedIds = [];
      threadTree.nodeById.forEach(function collectCollapsedIds(node, nodeId) {
        const normalizedNodeId = String(nodeId || '').trim();
        if (!node || !normalizedNodeId || !shouldShowThreadToggle(node) || forcedOpen.has(normalizedNodeId)) {
          return;
        }
        if (isThreadBranchCollapsed(normalizedNodeId, sessionId)) {
          collapsedIds.push(normalizedNodeId);
        }
      });
      collapsedIds.sort();
      return collapsedIds.join('|');
    }

    function isThreadBranchOpen(node, sessionId, forcedOpenIds) {
      const normalizedNodeId = String(node?.id || '').trim();
      if (!normalizedNodeId) {
        return true;
      }
      if (forcedOpenIds instanceof Set && forcedOpenIds.has(normalizedNodeId)) {
        return true;
      }
      return !isThreadBranchCollapsed(normalizedNodeId, sessionId);
    }

    function toggleThreadBranch(messageId) {
      const normalizedMessageId = String(messageId || '').trim();
      const normalizedSessionId = String(state.currentSessionId || '').trim();
      if (!normalizedMessageId || !normalizedSessionId) {
        return;
      }
      const collapsedSet = getThreadCollapsedSet(normalizedSessionId, { create: true });
      if (!collapsedSet) {
        return;
      }
      if (collapsedSet.has(normalizedMessageId)) {
        collapsedSet.delete(normalizedMessageId);
      } else {
        collapsedSet.add(normalizedMessageId);
      }
      if (collapsedSet.size === 0) {
        ensureThreadBranchesCollapsedMap(state).delete(normalizedSessionId);
      }
      renderMessages();
    }

    function isRecapExpandedForSession(recapId, sessionId) {
      const normalizedRecapId = String(recapId || '').trim();
      const normalizedSessionId = String(sessionId || state.currentSessionId || '').trim();
      if (!normalizedRecapId || !normalizedSessionId) {
        return false;
      }
      const expandedBySession = state.ui?.interactiveRecapExpandedBySession;
      if (isMapLike(expandedBySession)) {
        const expandedSet = expandedBySession.get(normalizedSessionId);
        if (isSetLike(expandedSet) && expandedSet.has(normalizedRecapId)) {
          return true;
        }
      }
      return isRecapExpanded(normalizedRecapId, normalizedSessionId);
    }

    return {
      buildFallbackInteractiveRecapModel,
      buildInteractiveRecapModel,
      getThreadCollapsedSet,
      isThreadBranchCollapsed,
      pruneThreadBranchState,
      buildThreadExpansionSignature,
      isThreadBranchOpen,
      toggleThreadBranch,
      isRecapExpandedForSession,
      isMapLike,
      isSetLike,
      pruneRecapExpansionState,
    };
  }

  return {
    createThreadStatePipeline,
    ensureThreadBranchesCollapsedMap,
    getThreadCollapsedSetForState,
    clearThreadBranchCollapseState,
  };
});
