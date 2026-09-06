(function (root) {
  'use strict';

  const noop = () => {};
  const noopArr = () => [];
  const noopAsync = async () => {};
  const noopNull = () => null;

  function clipMessagePreview(value, maxLength = 120) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength - 3).trim()}...`
      : normalized;
  }

  function getOpenLoopCaptureDetails(message, sourceKind) {
    if (sourceKind === 'proactive_suggestion') {
      const suggestion =
        message?.proactive_suggestion && typeof message.proactive_suggestion === 'object'
          ? message.proactive_suggestion
          : {};
      const title = String(
        suggestion.title
          || clipMessagePreview(suggestion.body || suggestion.promptSuggestion || message?.content, 80)
          || 'Proactive suggestion'
      ).trim();
      const body = String(suggestion.body || suggestion.promptSuggestion || message?.content || '').trim();
      return {
        label: title,
        body,
        sourceId: String(suggestion.id || message?.id || '').trim(),
        sourceMeta: {
          kind: String(suggestion.kind || '').trim(),
          promptSuggestion: String(suggestion.promptSuggestion || '').trim(),
          createdAt: String(suggestion.createdAt || '').trim(),
        },
      };
    }
    const preview = clipMessagePreview(message?.content, 120);
    return {
      label: clipMessagePreview(message?.content, 60) || 'Follow-up',
      body: preview,
      sourceId: String(message?.id || '').trim(),
      sourceMeta: {},
    };
  }

  function createOpenLoopActionHandlers({
    state = {},
    shell = root.jennyShell || {},
    constants = {},
    callbacks = {},
  } = {}) {
    const {
      getCurrentMessageById = noopNull,
      applyCompanionPayload = noop,
      appendClientLog = noop,
      showToastMessage = noop,
      renderAll = noop,
      getAvailableCompanionDeferPresets = noopArr,
      refreshCompanionState = noopAsync,
    } = callbacks;
    const { TOAST_SOURCE = {} } = constants;
    const sessionActionSource = TOAST_SOURCE.sessionAction || 'session_action';

    async function saveMessageAsOpenLoop(messageId, {
      sourceKind = 'assistant_reply',
      status = 'active',
      deferPreset = '',
    } = {}) {
      const message = getCurrentMessageById(messageId);
      if (!message) {
        return null;
      }
      const details = getOpenLoopCaptureDetails(message, sourceKind);
      const sessionId = String(state.currentSessionId || state.activeSessionId || '').trim();
      const payload = await shell.companion.addFollowUp({
        label: details.label,
        body: details.body,
        sessionId,
        status,
        deferPreset,
        sourceKind,
        sourceId: details.sourceId,
        sourceMeta: details.sourceMeta,
      });
      applyCompanionPayload(payload);
      appendClientLog('INFO', 'chat.follow_up_captured', {
        messageId,
        sessionId,
        sourceKind,
        deferPreset,
        previewLength: details.body.length,
      });
      showToastMessage(
        status === 'deferred' ? 'Saved to deferred open loops.' : 'Saved to Open Loops.',
        {
          title: status === 'deferred' ? 'Open Loop Deferred' : 'Follow-up Saved',
          tone: 'success',
          source: sessionActionSource,
          dedupeKey: `${sessionActionSource}:follow-up:${messageId}:${status}:${deferPreset || 'active'}`,
        }
      );
      renderAll();
      return payload;
    }

    async function ensureAvailableCompanionDeferPresets() {
      let presets = getAvailableCompanionDeferPresets();
      if (presets.length) {
        return presets;
      }
      try {
        await refreshCompanionState();
      } catch (_error) {
        // Best effort only. The caller will surface the empty-state toast.
      }
      presets = getAvailableCompanionDeferPresets();
      return presets;
    }

    async function promptMessageDeferSelection(messageId, sourceKind) {
      const presets = await ensureAvailableCompanionDeferPresets();
      if (!presets.length) {
        showToastMessage('No defer presets are available right now.', {
          title: 'Open Loops',
          tone: 'warning',
          source: sessionActionSource,
          dedupeKey: `${sessionActionSource}:follow-up:defer:none`,
        });
        return null;
      }
      showToastMessage('Choose when this should come back.', {
        title: 'Defer Open Loop',
        tone: 'info',
        sticky: true,
        source: sessionActionSource,
        dedupeKey: `${sessionActionSource}:follow-up:defer:${messageId}`,
        actions: presets.map((preset, index) => ({
          id: `follow-up-defer:${messageId}:${preset.preset}`,
          label: preset.label,
          kind: index === 0 ? 'primary' : 'secondary',
          onClick: () => saveMessageAsOpenLoop(messageId, {
            sourceKind,
            status: 'deferred',
            deferPreset: preset.preset,
          }),
        })),
      });
      return null;
    }

    return {
      // One per-message capture button ("Follow up") saves the reply as an
      // active Open Loop. Timing/deferral is managed in the Open Loops board,
      // so there is no separate per-message "Later" picker (the proactive-
      // suggestion defer path below still uses promptMessageDeferSelection).
      handleFollowUpMessage: (messageId) => saveMessageAsOpenLoop(messageId, {
        sourceKind: 'assistant_reply',
        status: 'active',
      }),
      handleSaveProactiveSuggestionMessage: (messageId) => saveMessageAsOpenLoop(messageId, {
        sourceKind: 'proactive_suggestion',
        status: 'active',
      }),
      handleLaterProactiveSuggestionMessage: (messageId) => (
        promptMessageDeferSelection(messageId, 'proactive_suggestion')
      ),
      saveMessageAsOpenLoop,
    };
  }

  root.rendererAppOpenLoopActions = {
    clipMessagePreview,
    createOpenLoopActionHandlers,
    getOpenLoopCaptureDetails,
  };
})(window);
