(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererShellRuntimeUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}
  function noopAsync() { return Promise.resolve(); }
  function noopNull() { return null; }
  function noopArr() { return []; }
  function toNonnegativeFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  /* Cold-reopen seed for the composer context ring. A session summary carries
     the last authoritative terminal reading as `context_usage` (snake_case
     wire shape, normalized and version-checked by
     services/backend/session-context-usage.js). Read-only here: it is mapped
     to the same two continuity fields a live stored record exposes so the
     estimate builder has ONE input shape, and it is never written back into
     the usage store or treated as an authoritative record. */
  function sessionContextUsageSeed(session) {
    const record = session && session.context_usage;
    if (!record || typeof record !== 'object' || Number(record.version) !== 1) return null;
    const usedTokens = Number(record.used_tokens || 0) || 0;
    if (usedTokens <= 0) return null;
    return {
      model: String(record.model || ''),
      usedTokens,
      compactThresholdTokens: Number(record.compact_threshold_tokens || 0) || 0,
      /* The window the threshold was computed FOR — the consumer refuses to
         inherit the threshold when the served window has since changed. */
      contextLimit: Number(record.context_window || 0) || 0,
    };
  }

  function deriveCanonicalSessionDisplayState(state, sessionId, options = {}) {
    const sourceState = state && typeof state === 'object' ? state : {};
    const normalizedSessionId = String(sessionId || '').trim();
    const sessions = Array.isArray(sourceState.sessions) ? sourceState.sessions : [];
    const session = sessions.find(
      (entry) => String(entry?.id || '').trim() === normalizedSessionId
    ) || null;
    const messageStore = sourceState.messagesBySession;
    const hasHydratedMessages = Boolean(
      normalizedSessionId
      && messageStore
      && typeof messageStore.has === 'function'
      && messageStore.has(normalizedSessionId)
    );
    const hydratedMessages = hasHydratedMessages
      ? (messageStore.get(normalizedSessionId) || []).filter(Boolean)
      : [];
    const useHydratedMessageCount = hasHydratedMessages
      && normalizedSessionId === String(sourceState.currentSessionId || '').trim();
    const lastModelUsed = String(session?.last_model_used || '').trim();
    const preferredModel = String(session?.preferred_model || '').trim();
    const model = lastModelUsed || preferredModel;
    const modelSource = lastModelUsed ? 'last_used' : preferredModel ? 'preferred' : '';
    const persistedMessageCount = Math.floor(toNonnegativeFiniteNumber(session?.message_count));
    const messageCount = useHydratedMessageCount ? hydratedMessages.length : persistedMessageCount;
    const estimateTokens = typeof options.estimateTokens === 'function'
      ? options.estimateTokens
      : null;
    const overheadTokens = toNonnegativeFiniteNumber(
      options.contextOverheadTokens ?? sourceState.ui?.contextOverheadTokens ?? 0
    );
    const usedTokens = hasHydratedMessages && estimateTokens
      ? toNonnegativeFiniteNumber(estimateTokens(hydratedMessages)) + overheadTokens
      : null;
    const contextLimit = toNonnegativeFiniteNumber(
      options.contextLimit ?? sourceState.status?.effective_context_length ?? 0
    );
    const tokenRatio = usedTokens !== null && contextLimit > 0
      ? Math.min(usedTokens / contextLimit, 1)
      : 0;
    return {
      sessionId: normalizedSessionId,
      session,
      messages: hydratedMessages,
      hasHydratedMessages,
      messageCount,
      messageCountSource: useHydratedMessageCount ? 'messages' : 'summary',
      model,
      modelSource,
      lastMessagePreview: String(session?.last_message_preview || '').trim(),
      usedTokens,
      contextLimit,
      tokenRatio,
    };
  }

  function createShellRuntimeController(deps) {
    const {
      state,
      windowRef = globalRef.window || globalRef,
      dom = {},
      constants = {},
      modules = {},
      callbacks = {},
    } = deps || {};

    const { TOAST_SOURCE = {} } = constants;
    const {
      composerContextUsageSlot = null,
      composerPlanUsageSlot = null,
      composerToolToggleSlot = null,
    } = dom;
    const {
      contextUsageModule = null,
      composerToggleModule = null,
    } = modules;
    const {
      appendClientLog = noop,
      renderAll = noop,
      renderSettings = noop,
      renderWorkspaceChrome = noop,
      renderComposerState = noop,
      syncComposerInputHeight = noop,
      showToastMessage = noop,
      toErrorMessage = function fallbackToErrorMessage(error) {
        return String(error && error.message || error || '');
      },
      showComposerActionError = noop,
      openSettingsSection = noop,
      setActiveView = noop,
      getLatestReplyAssistantMessageId = function fallbackGetLatestReplyAssistantMessageId(messages) {
        const source = Array.isArray(messages) ? messages : [];
        for (let index = source.length - 1; index >= 0; index -= 1) {
          const message = source[index];
          if (String(message?.role || '').trim() === 'assistant') {
            return String(message?.id || '').trim();
          }
        }
        return '';
      },
      getCurrentVisibleMessages = noopArr,
      getCurrentMessageById = noopNull,
      getCurrentRuntimePreferences = noopNull,
      isSendPreflightPending = () => false,
      loadSessions = noopAsync,
      refreshSessionSummaries = noopAsync,
      handleCreateSession = noopAsync,
      handleDeleteSession = noopAsync,
      syncWorkspaceFromStore = noopAsync,
      applyWorkspaceSnapshot = noop,
      renderComposerEnhancementsHook = null,
      renderSessions = noop,
      refreshSuggestions = noopAsync,
      activateWorkspaceSession = noopAsync,
      openArtifactTarget = noopAsync,
      openIdeFileAtLine = noopAsync,
      openFilePreviewTarget = noopAsync,
    } = callbacks;

    // Chat-path listeners are page-lifetime, and the module resolves its menu
    // dependencies from window globals.
    const chatPathOpenUtils = windowRef.rendererChatPathOpen || null;
    if (chatPathOpenUtils && typeof chatPathOpenUtils.createChatPathOpenController === 'function') {
      chatPathOpenUtils.createChatPathOpenController({
        windowRef,
        chatTimeline: windowRef.document?.getElementById?.('chatTimeline') || null,
        pathRoots: [windowRef.document?.getElementById?.('subagentInspector')].filter(Boolean),
        state,
        setActiveView: (...a) => setActiveView(...a),
        openIdeFileAtLine: (...a) => openIdeFileAtLine(...a),
        openFilePreviewTarget: (...a) => openFilePreviewTarget(...a),
        showToastMessage: (...a) => showToastMessage(...a),
        appendClientLog: (...a) => appendClientLog(...a),
      }).attach();
    }

    // The background-job subscription is page-lifetime.
    const backgroundJobsUtils = windowRef.rendererBackgroundJobs || null;
    if (backgroundJobsUtils && typeof backgroundJobsUtils.createBackgroundJobsStrip === 'function') {
      backgroundJobsUtils.createBackgroundJobsStrip({
        windowRef,
        container: windowRef.document?.getElementById?.('backgroundJobsStrip') || null,
        jennyShell: windowRef.jennyShell || null,
        showToastMessage: (...a) => showToastMessage(...a),
        getActiveSessionId: () => String(state.currentSessionId || '').trim(),
      }).attach();
    }

    /* Composer context ring memo: the last rendered ring HTML per session, so a
       composer repaint whose usage data is unchanged skips the innerHTML
       rewrite and the tooltip un-pin/re-pin dance. Paired with the last
       announced severity so the aria-live announcer fires once per threshold
       crossing rather than on every render. */
    let _composerRingMemo = { sessionId: null, html: null };
    const _lastAnnouncedSeverity = Object.create(null);
    let _contextUsageAnnouncerEl = null;

    function getKnownSessionIds() {
      return Array.isArray(state.sessions)
        ? state.sessions
          .map((session) => String(session?.id || '').trim())
          .filter(Boolean)
        : [];
    }

    function pruneContextUsageCache() {
      if (!contextUsageModule || typeof contextUsageModule.pruneUsage !== 'function') return;
      const keepSessionIds = getKnownSessionIds();
      contextUsageModule.pruneUsage({
        keepSessionIds,
        maxEntries: Math.max(100, keepSessionIds.length + 32),
      });
    }

    function extractToolNamesForComposerToggles(list) {
      const tools = Array.isArray(list) ? list : [];
      return tools
        .map((entry) => (
          entry && typeof entry === 'object' && !Array.isArray(entry)
            ? {
              name: String(entry.name || '').trim(),
              available: entry.available !== false,
              reason: String(entry.reason || '').trim(),
            }
            : String(entry || '').trim()
        ))
        .filter((entry) => (
          entry && typeof entry === 'object'
            ? Boolean(entry.name)
            : Boolean(entry)
        ));
    }

    function getCurrentSessionSummary(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId || !Array.isArray(state.sessions)) {
        return null;
      }
      return state.sessions.find((session) => String(session?.id || '').trim() === normalizedSessionId) || null;
    }

    function getActiveComposerModel(sessionId) {
      const runtimePreferences = getCurrentRuntimePreferences() || {};
      const session = getCurrentSessionSummary(sessionId);
      return String(
        runtimePreferences.preferredModel
        || session?.preferred_model
        || session?.last_model_used
        || state.status?.model
        || ''
      ).trim();
    }

    function getQueuedAttachments() {
      const queued = state.attachments && state.attachments.queued;
      return Array.isArray(queued) ? queued : [];
    }

    function getContextMeterMessages(sessionId) {
      const stored = state.messagesBySession?.get?.(String(sessionId || '').trim());
      return Array.isArray(stored) ? stored : getCurrentVisibleMessages();
    }

    function getContextMeterOptions(sessionId, activeModel = getActiveComposerModel(sessionId)) {
      const runtimePreferences = getCurrentRuntimePreferences() || state.runtimeDraft || {};
      const contextPreferences = runtimePreferences.contextPreferences || {};
      const featureFlags = state.features?.featureFlags || {};
      const session = getCurrentSessionSummary(sessionId);
      /* Continuity inputs for the fallback estimate: the last authoritative
         reading's auto-compact threshold keeps it on the SAME denominator as
         the reading it replaces (the threshold is model-specific, so it is
         only inherited while the record matches the active model), and its
         usedTokens floors the numerator so a model switch never collapses the
         ring to the bare chars/4 sum. */
      const stored = typeof contextUsageModule?.getUsage === 'function'
        ? contextUsageModule.getUsage(sessionId)
        : null;
      /* With no in-memory record yet (the app just reopened on a long
         conversation) the session's persisted last authoritative reading
         supplies the same two inputs, so the ring starts accurate instead of
         showing chars/4 against the full window until the next turn ends. */
      const continuity = stored || sessionContextUsageSeed(session);
      const continuityModelMatches = Boolean(continuity)
        && (typeof contextUsageModule?.storedMatchesActiveModel !== 'function'
          || contextUsageModule.storedMatchesActiveModel(continuity, activeModel));
      const contextLimit = Number(state.status?.effective_context_length || 0) || 0;
      /* The auto-compact threshold is a function of the SERVED window, which
         moves independently of the model name (num_ctx override, engine
         reload). A threshold computed for a different window would put the
         ring on a denominator unrelated to — possibly larger than — the
         current window, so it is only inherited while the windows agree. */
      const continuityWindowMatches = Number(continuity?.contextLimit || 0) > 0
        && Number(continuity.contextLimit) === contextLimit;
      const historyScope = contextPreferences.historyScope || 'session';
      return {
        activeModel,
        autoCompactEnabled:
          featureFlags.token_budget === true && featureFlags.context_compaction === true,
        historyScope,
        contextLimit,
        overheadTokens: Number(state.ui?.contextOverheadTokens || 0) || 0,
        compactionContext: session?.compaction_context || null,
        attachments: getQueuedAttachments(),
        compactThresholdTokens: continuityModelMatches && continuityWindowMatches
          ? Number(continuity.compactThresholdTokens || 0) || 0
          : 0,
        /* The floor asserts "the full conversation is at least this big", so
           it only applies to the full-session scope — recent/fresh estimates
           deliberately measure less than the last authoritative reading. */
        priorUsedTokens: continuity && historyScope === 'session'
          ? Number(continuity.usedTokens || 0) || 0
          : 0,
      };
    }

    function buildComposerContextUsageEstimate(sessionId, activeModel = getActiveComposerModel(sessionId)) {
      if (!contextUsageModule || typeof contextUsageModule.buildContextUsageEstimate !== 'function') {
        return null;
      }
      // Session message arrays are replaced when canonical state changes, so
      // their identity is a stable O(1) memo key across composer-only repaints.
      // The visible-message callback filters into a fresh array every call and
      // is retained only as a compatibility fallback for isolated harnesses.
      const messages = getContextMeterMessages(sessionId);
      const options = getContextMeterOptions(sessionId, activeModel);
      if (typeof contextUsageModule.buildCachedContextUsageEstimate === 'function') {
        return contextUsageModule.buildCachedContextUsageEstimate(sessionId, messages, {
          contextLimit: options.contextLimit,
          model: activeModel,
          attachments: options.attachments,
          overheadTokens: options.overheadTokens,
          historyScope: options.historyScope,
          compactionContext: options.compactionContext,
          autoCompactEnabled: options.autoCompactEnabled,
          compactThresholdTokens: options.compactThresholdTokens,
          priorUsedTokens: options.priorUsedTokens,
        });
      }
      return contextUsageModule.buildContextUsageEstimate(messages, options);
    }

    function hasRenderableSentContextUsage(sessionId, activeModel = getActiveComposerModel(sessionId)) {
      if (!contextUsageModule || typeof contextUsageModule.getUsage !== 'function') {
        return false;
      }
      const usage = contextUsageModule.getUsage(sessionId);
      /* Authoritative sources ('provider' truth or the sidecar 'context'
         estimate) share one predicate with resolveRenderUsage so this guard
         and the render preference can't drift. */
      const isAuthoritative = typeof contextUsageModule.isAuthoritativeUsageSource === 'function'
        ? contextUsageModule.isAuthoritativeUsageSource(usage && usage.usageSource)
        : Boolean(usage) && usage.usageSource === 'context';
      /* Renderability must agree with resolveRenderUsage's own predicate: a
         record can carry an auto-compact threshold without a context_window
         (engines that expose no window getter), and such a record still
         renders. Requiring contextLimit here would rebuild the fallback
         estimate on every repaint only to have resolveRenderUsage discard
         it — a full chars/4 walk per mid-turn snapshot for nothing. */
      const featureFlags = state.features?.featureFlags || {};
      const targetLimit = typeof contextUsageModule.resolveContextTarget === 'function'
        ? contextUsageModule.resolveContextTarget(usage, {
          autoCompactEnabled:
            featureFlags.token_budget === true && featureFlags.context_compaction === true,
        }).limit
        : Number(usage && usage.contextLimit || 0);
      if (
        !usage
        || !isAuthoritative
        || !(Number(usage.usedTokens || 0) > 0)
        || !(Number(targetLimit || 0) > 0)
      ) {
        return false;
      }
      /* A stored record from a different model is stale after a mid-session
         switch; treat it as non-renderable so the fallback estimate (built with
         the new model's window) is produced and wins in resolveRenderUsage. The
         staleness rule lives in the usage module's storedMatchesActiveModel so
         this guard and resolveRenderUsage can't drift to different normalizations. */
      if (
        typeof contextUsageModule.storedMatchesActiveModel === 'function'
        && !contextUsageModule.storedMatchesActiveModel(usage, activeModel)
      ) {
        return false;
      }
      return true;
    }

    function buildComposerContextUsageFallback(sessionId, activeModel = getActiveComposerModel(sessionId)) {
      return hasRenderableSentContextUsage(sessionId, activeModel)
        ? null
        : buildComposerContextUsageEstimate(sessionId, activeModel);
    }

    function ensureContextUsageAnnouncer() {
      if (_contextUsageAnnouncerEl && _contextUsageAnnouncerEl.isConnected) {
        return _contextUsageAnnouncerEl;
      }
      const parent = composerContextUsageSlot && composerContextUsageSlot.parentNode;
      if (!parent) return null;
      let el = parent.querySelector('.composer-context-usage-announcer');
      if (!el) {
        const doc = parent.ownerDocument || (windowRef && windowRef.document) || null;
        if (!doc) return null;
        el = doc.createElement('span');
        /* sr-only (shell-chrome.css): visually hidden, still announced. */
        el.className = 'composer-context-usage-announcer sr-only';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        parent.appendChild(el);
      }
      _contextUsageAnnouncerEl = el;
      return el;
    }

    function announceContextUsageSeverity(sessionId, summary) {
      const sid = String(sessionId || '').trim();
      if (!sid) return;
      /* Mount the (silent) live region as soon as there's a ring so the first
         escalation is announced reliably, rather than inserting the region and
         changing its text in the same frame (which some screen readers skip). */
      const el = summary ? ensureContextUsageAnnouncer() : _contextUsageAnnouncerEl;
      const severity = summary && summary.severity ? summary.severity : '';
      if (_lastAnnouncedSeverity[sid] === severity) return;
      _lastAnnouncedSeverity[sid] = severity;
      if (!el) return;
      /* Only the actionable escalations are spoken; easing back below the
         warning line clears the message so the next crossing re-announces. */
      if (severity !== 'warning' && severity !== 'danger') {
        el.textContent = '';
        return;
      }
      el.textContent = severity === 'danger'
        ? summary.targetType === 'auto_compact'
          ? 'Context ' + summary.percentLabel + ' — nearly full; auto-compaction is imminent.'
          : 'Context ' + summary.percentLabel + ' — the context window is nearly full.'
        : summary.targetType === 'auto_compact'
          ? 'Context ' + summary.percentLabel + ' — approaching auto-compaction.'
          : 'Context ' + summary.percentLabel + ' — the context window is filling up.';
    }

    function renderComposerEnhancements() {
      const sessionId = String(state.currentSessionId || '').trim();
      if (composerContextUsageSlot) {
        const contextPopoverWasOpen = Boolean(
          composerContextUsageSlot.querySelector('.inv-popover:not([hidden])')
        );
        const previousPreview = composerContextUsageSlot
          .querySelector('[data-next-turn-context-summary]');
        const previousPreviewText = previousPreview?.textContent || '';
        const previousPreviewWasPending = previousPreview?.dataset?.contextPreviewPending === 'true';

        let nextRingHtml = '';
        let usageSummary = null;
        if (
          contextUsageModule
          && typeof contextUsageModule.renderContextUsage === 'function'
          && sessionId
        ) {
          const activeModel = getActiveComposerModel(sessionId);
          const contextMeterOptions = getContextMeterOptions(sessionId, activeModel);
          const compactionActivity = state.compactionCoordinator?.getActivity?.(sessionId) || null;
          const sessionDisplay = deriveCanonicalSessionDisplayState(state, sessionId);
          const usageOptions = {
            fallbackEstimate: buildComposerContextUsageFallback(sessionId, activeModel),
            activeModel,
            autoCompactEnabled: contextMeterOptions.autoCompactEnabled,
            manualCompactionEnabled: state.features?.featureFlags?.compaction_manual === true
              && (sessionDisplay.messageCount > 0 || compactionActivity?.pending === true),
            compactionActivity,
          };
          usageSummary = typeof contextUsageModule.describeContextUsage === 'function'
            ? contextUsageModule.describeContextUsage(sessionId, usageOptions)
            : null;
          nextRingHtml = contextUsageModule.renderContextUsage(sessionId, usageOptions) || '';
        }

        /* Skip the innerHTML rewrite when the ring is byte-identical to what's
         * mounted. Composer repaints fire on every tool-lifecycle event, and
         * mid-turn context.usage snapshots now move the numbers several times
         * per agentic turn, so this collapses a per-event rebuild to once per
         * actual change. */
        const ringUnchanged = _composerRingMemo.sessionId === sessionId
          && _composerRingMemo.html === nextRingHtml
          && composerContextUsageSlot.dataset.ringRendered === '1';
        /* While the user has the details popover open, a MID-TURN snapshot
         * does not tear the slot down: rebuilding per iteration would churn
         * the popover under the pointer and re-fire its synchronous preview
         * load. The memo is left stale on purpose, so the pending change
         * materializes at the first render after the snapshot stream moves on
         * (terminal usage and estimate changes still rebuild-and-restore). */
        const freezeForOpenPopover = contextPopoverWasOpen
          && typeof contextUsageModule.getUsage === 'function'
          && (() => {
            const record = contextUsageModule.getUsage(sessionId);
            return Boolean(record && record.phase && record.phase !== 'terminal');
          })();
        if (!ringUnchanged && !freezeForOpenPopover) {
          composerContextUsageSlot.innerHTML = nextRingHtml;
          composerContextUsageSlot.dataset.ringRendered = '1';
          _composerRingMemo = { sessionId, html: nextRingHtml };
          if (contextPopoverWasOpen) {
            const nextPopover = composerContextUsageSlot.querySelector('.inv-popover');
            const nextChip = composerContextUsageSlot.querySelector('[data-inv-chip="composer-context-ring"]');
            const nextPreview = composerContextUsageSlot.querySelector('[data-next-turn-context-summary]');
            if (nextPreview && previousPreviewText) nextPreview.textContent = previousPreviewText;
            windowRef.inventory?.popover?.open?.(nextPopover, { trigger: nextChip, focus: false });
            windowRef.rendererContextMeterDetails?.positionPopover?.(nextPopover, nextChip);
            if (previousPreviewWasPending) {
              void windowRef.rendererContextMeterDetails?.loadPreview?.(nextPopover, state);
            }
          }
        }

        announceContextUsageSeverity(sessionId, usageSummary);
      }
      if (composerPlanUsageSlot) {
        /* ChatGPT plan-usage ring: its own store/memo/popover, sibling of the
           context ring; empty string when inactive keeps the slot inert. */
        windowRef.rendererPlanUsageMeter?.render?.(composerPlanUsageSlot, state);
      }
      if (composerToolToggleSlot) {
        if (
          composerToggleModule
          && typeof composerToggleModule.renderToolToggles === 'function'
        ) {
          /* innerHTML replacement destroys an open tools popover; remember and
           * re-open (without stealing focus) so refresh-driven re-renders do
           * not slam it shut under the pointer. */
          const popoverWasOpen = Boolean(
            composerToolToggleSlot.querySelector('.inv-popover:not([hidden])')
          );
          composerToolToggleSlot.innerHTML = composerToggleModule.renderToolToggles() || '';
          if (popoverWasOpen) {
            const inv = windowRef.inventory || null;
            const nextPopover = composerToolToggleSlot.querySelector('.inv-popover');
            const nextChip = composerToolToggleSlot.querySelector('[data-inv-chip="composer-tools"]');
            if (inv?.popover?.open && nextPopover) {
              inv.popover.open(nextPopover, { trigger: nextChip, focus: false });
            }
          }
        } else {
          composerToolToggleSlot.innerHTML = '';
        }
      }
      if (typeof renderComposerEnhancementsHook === 'function') {
        renderComposerEnhancementsHook();
      }
    }

    async function refreshComposerToolToggles() {
      if (
        !composerToggleModule
        || typeof composerToggleModule.setAvailableTools !== 'function'
        || !windowRef?.jennyShell?.tools?.list
      ) {
        return;
      }
      try {
        const tools = await windowRef.jennyShell.tools.list();
        composerToggleModule.setAvailableTools(extractToolNamesForComposerToggles(tools));
        if (typeof composerToggleModule.hydrateFromToolSettings === 'function') {
          composerToggleModule.hydrateFromToolSettings(state.features?.tools);
        }
        if (typeof composerToggleModule.hydrateFromSessionOverrides === 'function') {
          const active = Array.isArray(state.sessions)
            ? state.sessions.find((entry) => String(entry?.id || '') === String(state.currentSessionId || ''))
            : null;
          composerToggleModule.hydrateFromSessionOverrides(active?.tool_category_overrides);
        }
        renderComposerEnhancements();
      } catch (error) {
        appendClientLog('WARN', 'composer.tool_toggles_refresh_failed', {
          message: error.message || String(error),
        });
      }
    }

    function getToolPreferences() {
      if (!composerToggleModule || typeof composerToggleModule.getToggleStates !== 'function') {
        return {};
      }
      return composerToggleModule.getToggleStates();
    }

    function handleComposerToggleChange(event) {
      const toggleId = String(event?.detail?.id || '').trim();
      if (!toggleId || !composerToggleModule || typeof composerToggleModule.setToggle !== 'function') {
        return;
      }
      const categoryId = toggleId.startsWith('tool-toggle-')
        ? toggleId.slice('tool-toggle-'.length)
        : toggleId;
      if (!categoryId) {
        return;
      }
      const persistence = composerToggleModule.setToggle(categoryId, event?.detail?.checked === true);
      Promise.resolve(persistence).then((persisted) => {
        if (persisted === false) renderComposerEnhancements();
      });
      /* The switch primitive already repainted itself in place; only the chip
       * count needs syncing. A full slot re-render here would destroy the
       * popover the user is interacting with. */
      const inv = windowRef.inventory || null;
      const chipEl = composerToolToggleSlot
        ? composerToolToggleSlot.querySelector('[data-inv-chip="composer-tools"]')
        : null;
      if (chipEl && inv?.chip?.setCount && typeof composerToggleModule.getToolsChipCount === 'function') {
        const count = composerToggleModule.getToolsChipCount();
        inv.chip.setCount(chipEl, count.text);
        chipEl.setAttribute('aria-label', 'Session tools: ' + count.text + ' enabled');
      } else {
        renderComposerEnhancements();
      }
    }

    function queueDeferredStartupTask(task, options = {}) {
      const {
        event = 'renderer.startup_task_failed',
        rerender = false,
      } = options;
      Promise.resolve()
        .then(() => task())
        .catch((error) => {
          appendClientLog('WARN', event, {
            message: error?.message || String(error),
          });
        })
        .finally(() => {
          if (!rerender) {
            return;
          }
          try {
            renderAll();
          } catch (_error) {
            // Global renderer safeguards handle any follow-on render issues.
          }
        });
    }

    function resolveActionMessageId(contextNode, preferredMessageId) {
      const directMessageId = String(preferredMessageId || '').trim();
      if (directMessageId) {
        return directMessageId;
      }
      const ownerMessageId = String(
        contextNode?.closest?.('[data-message-id]')?.dataset?.messageId || ''
      ).trim();
      if (ownerMessageId) {
        return ownerMessageId;
      }
      return getLatestReplyAssistantMessageId(getCurrentVisibleMessages());
    }

    function resolvePendingApprovalKey(approvalRef) {
      const normalizedRef = String(approvalRef || '').trim();
      if (!normalizedRef || !(state.pendingToolApprovals instanceof Map)) {
        return '';
      }
      if (state.pendingToolApprovals.has(normalizedRef)) {
        return normalizedRef;
      }
      const matches = [];
      for (const [key, approval] of state.pendingToolApprovals.entries()) {
        if (String(approval?.approvalId || '').trim() === normalizedRef || String(approval?.callId || '').trim() === normalizedRef) {
          matches.push(String(key || '').trim());
        }
      }
      return matches.length === 1 ? matches[0] : '';
    }

    /* ── Logs deep link (chat error chip / "View in logs" -> Activity) ──
     * The error affordances carry the turn's streamId; the matching
     * diagnostic activity event is resolved out of the already-loaded
     * state.logs buffer (the same array renderer-diagnostics-render-utils
     * reads), so this needs no new bridge call or renderer plumbing. DOM
     * focus is delegated to the diagnostics event bindings, which own
     * focusRow/ensureLogRowMounted, via the LOGS_FOCUS_EVENT below. */
    const LOGS_FOCUS_EVENT = 'diagnostics:focus-log-entry';
    const TURN_DIAGNOSTIC_EVENT = 'chat.turn_diagnostic_dumped';

    function logEntryData(entry) {
      if (!entry || typeof entry !== 'object') return {};
      if (entry.data && typeof entry.data === 'object') return entry.data;
      if (entry.details && typeof entry.details === 'object') return entry.details;
      return {};
    }

    function logEntryStreamId(entry) {
      const data = logEntryData(entry);
      return String(
        data.streamId || data.stream_id || entry?.stream_id || entry?.streamId || ''
      ).trim();
    }

    /* Mirrors entryId() in renderer-diagnostics-render-utils.js — the id the
     * activity rows are keyed by. */
    function logEntryId(entry) {
      return String(entry?.entry_id || entry?.origin_entry_id || entry?.sequence || '').trim();
    }

    function findLogEntryForStream(streamId) {
      const entries = Array.isArray(state.logs) ? state.logs : [];
      let fallback = null;
      for (const entry of entries) {
        if (logEntryStreamId(entry) !== streamId || !logEntryId(entry)) continue;
        if (String(entry?.event || '').trim() === TURN_DIAGNOSTIC_EVENT) return entry;
        if (!fallback) fallback = entry;
      }
      return fallback;
    }

    function ensureLogsViewState() {
      const ensure = windowRef.rendererDiagnosticsViewState?.ensureDiagnosticsViewState;
      if (typeof ensure === 'function') {
        const ensured = ensure(state);
        if (ensured && typeof ensured === 'object') return ensured;
      }
      state.ui = state.ui && typeof state.ui === 'object' ? state.ui : {};
      state.ui.logs = state.ui.logs && typeof state.ui.logs === 'object' ? state.ui.logs : {};
      return state.ui.logs;
    }

    /* Open the Logs view on Activity, selecting the diagnostic event for this
     * turn when one is loaded. No match (diagnostics never loaded, older
     * session, retention drop) is not an error: the tab still opens plainly. */
    function openLogsForStream(streamId) {
      const normalizedStreamId = String(streamId || '').trim();
      const view = ensureLogsViewState();
      view.activeTab = 'activity';
      const entry = normalizedStreamId ? findLogEntryForStream(normalizedStreamId) : null;
      const entryId = entry ? logEntryId(entry) : '';
      if (entryId) {
        /* A stale query/level/source/scope would filter the target row out and
         * renderActivity would silently clear the selection again. */
        view.query = '';
        view.levelFilter = 'all';
        view.sourceFilter = 'all';
        view.issueScope = null;
        /* Empty resolves to the active run, which is what a run_id-less
         * renderer-local entry inherits; keeping the prior selection could
         * filter the target row out. */
        view.selectedRunId = String(entry.run_id || '');
        view.selectedEntryId = entryId;
        view.autoScroll = false;
      }
      setActiveView('logs');
      appendClientLog('INFO', 'error_recovery.logs_deeplink', {
        streamId: normalizedStreamId,
        matched: Boolean(entryId),
      });
      /* Always announced, match or not: when the Logs view is already active,
       * setActiveView is a no-op and the Activity tab flip would never paint. */
      const CustomEventCtor = windowRef.CustomEvent || globalRef.CustomEvent;
      if (typeof CustomEventCtor !== 'function' || typeof windowRef.dispatchEvent !== 'function') return;
      windowRef.dispatchEvent(new CustomEventCtor(LOGS_FOCUS_EVENT, { detail: { entryId } }));
    }

    function isRetryRecoveryAction(action) {
      return action === 'retry' || action === 'retry-tool' || action === 'retry_turn';
    }

    function isSettingsRecoveryAction(action) {
      return action === 'settings' || action === 'open_settings';
    }

    function isNewSessionRecoveryAction(action) {
      return action === 'new-session' || action === 'start_new_session';
    }

    async function restartSidecarForRecovery() {
      const backend = windowRef.jennyShell?.backend;
      if (!backend || typeof backend.retryStart !== 'function') {
        showComposerActionError(new Error('Sidecar restart is unavailable.'), 'Restart Unavailable');
        return;
      }
      try {
        await backend.retryStart();
        showToastMessage('Restart requested for the local sidecar.', {
          title: 'Restart Requested',
          tone: 'info',
          source: TOAST_SOURCE.chatStream,
          dedupeKey: `${TOAST_SOURCE.chatStream}:restart-sidecar`,
        });
      } catch (error) {
        showComposerActionError(error, 'Restart Failed');
      }
    }

    async function handleErrorRecoveryAction(payload, handlers = {}) {
      const {
        handleRegenerateMessage = noopAsync,
        handleCreateSessionWithWorkspace = noopAsync,
      } = handlers;
      const action = String(payload?.action || '').trim();
      if (!action) {
        return;
      }
      if (isRetryRecoveryAction(action)) {
        const targetMessageId = resolveActionMessageId(payload?.contextNode, payload?.messageId);
        if (!targetMessageId) {
          showComposerActionError(new Error('No assistant response is available to retry.'), 'Retry Unavailable');
          return;
        }
        await handleRegenerateMessage(targetMessageId, { failureRetry: true });
        return;
      }
      if (action === 'restart_sidecar') {
        await restartSidecarForRecovery();
        return;
      }
      if (action === 'open_diagnostics' || action === 'open_logs') {
        openLogsForStream(payload?.streamId);
        return;
      }
      if (isSettingsRecoveryAction(action)) {
        openSettingsSection('models', { source: 'error_recovery' });
        return;
      }
      if (isNewSessionRecoveryAction(action)) {
        await handleCreateSessionWithWorkspace();
        return;
      }
      if (action === 'lockdown_off') {
        const lockdownSessionId = String(payload?.sessionId || '').trim();
        if (!lockdownSessionId) {
          showComposerActionError(new Error('No session was found to turn offline lockdown off for.'), 'Lockdown Off Failed');
          return;
        }
        try {
          const persisted = await windowRef.jennyShell.sessions.setPreferences(lockdownSessionId, { lockdown: false });
          if (String(persisted?.id || '').trim() !== lockdownSessionId || persisted?.lockdown !== false) {
            throw new Error('Offline lockdown persistence acknowledgement did not match the requested change.');
          }
          state.sessions = (Array.isArray(state.sessions) ? state.sessions : []).map((session) =>
            (String(session?.id || '').trim() === lockdownSessionId ? { ...session, lockdown: false } : session));
          renderAll();
          appendClientLog('INFO', 'sessions.offline_lockdown_updated', {
            sessionId: lockdownSessionId,
            lockdown: false,
          });
        } catch (error) {
          showComposerActionError(error, 'Lockdown Off Failed');
        }
        return;
      }
      if (action === 'switch_local_model') {
        openSettingsSection('models', { source: 'lockdown_recovery' });
        return;
      }
      if (action === 'skip-tool') {
        const approvalRef = String(payload?.approvalId || payload?.approval_id || payload?.callId || '').trim();
        const approvalKey = resolvePendingApprovalKey(approvalRef);
        if (!approvalKey) {
          showToastMessage('No pending tool approval found to skip.', {
            title: 'Skip Unavailable',
            tone: 'info',
            source: TOAST_SOURCE.chatStream,
            dedupeKey: `${TOAST_SOURCE.chatStream}:skip-tool-unavailable`,
          });
          return;
        }
        await windowRef.jennyShell.tools.deny(approvalKey);
      }
    }

    async function handleArtifactAction(payload) {
      const action = String(payload?.action || '').trim();
      const artifactId = String(payload?.artifactId || '').trim();
      if (!action) {
        return;
      }
      if (!artifactId) {
        showToastMessage('This artifact action is unavailable for the selected entry.', {
          title: 'Artifact Action Unavailable',
          tone: 'info',
          source: TOAST_SOURCE.chatStream,
          dedupeKey: `${TOAST_SOURCE.chatStream}:artifact-action-unavailable`,
        });
        return;
      }
      const currentSessionId = String(payload?.sessionId || state.currentSessionId || '').trim();
      if (!currentSessionId) {
        showToastMessage('Open a session before using artifact actions.', {
          title: 'No Active Session',
          tone: 'info',
          source: TOAST_SOURCE.chatStream,
          dedupeKey: `${TOAST_SOURCE.chatStream}:artifact-action-no-session`,
        });
        return;
      }
      if (action === 'open') {
        const result = await windowRef.jennyShell.artifacts.openExternal(currentSessionId, artifactId);
        if (result && result.ok === false) {
          showToastMessage(String(result.result || result.message || 'Open externally failed.'), {
            title: 'Open External Failed',
            tone: 'danger',
            source: TOAST_SOURCE.chatStream,
            dedupeKey: `${TOAST_SOURCE.chatStream}:artifact-open-external-failed:${artifactId}`,
          });
        }
        return;
      }
      if (action === 'reveal') {
        await windowRef.jennyShell.artifacts.reveal(currentSessionId, artifactId);
        return;
      }
      if (action === 'panel') {
        await openArtifactTarget(artifactId, { source: 'inline-open-panel' });
      }
    }

    function shouldSyncWorkspaceAfterSessionReload() {
      return Boolean(
        state.workspace?.activeSessionId
        || state.workspace?.openSessionIds?.length
        || !state.currentSessionId
      );
    }

    async function loadSessionsWithWorkspace() {
      const result = await loadSessions(...arguments);
      pruneContextUsageCache();
      if (shouldSyncWorkspaceAfterSessionReload()) {
        await syncWorkspaceFromStore();
      }
      return result;
    }

    async function refreshSessionSummariesWithWorkspace() {
      const result = await refreshSessionSummaries(...arguments);
      pruneContextUsageCache();
      if (shouldSyncWorkspaceAfterSessionReload()) {
        await syncWorkspaceFromStore();
      }
      return result;
    }

    async function handleCreateSessionWithWorkspace() {
      const createdSessionId = String(await handleCreateSession(...arguments) || '').trim();
      if (createdSessionId) {
        state.currentSessionId = createdSessionId;
        // A brand-new chat always opens in its own tab, regardless of the
        // open-in-new-tab preference (which only governs existing sessions).
        await activateWorkspaceSession(createdSessionId, { silent: true, mode: 'new-tab' });
        renderWorkspaceChrome();
      }
      return createdSessionId;
    }

    async function handleDeleteSessionWithWorkspace() {
      let deleteResult;
      let deleteError = null;
      try {
        deleteResult = await handleDeleteSession(...arguments);
      } catch (error) {
        deleteError = error;
      }
      try {
        await syncWorkspaceFromStore();
      } catch (syncError) {
        if (!deleteError) {
          throw syncError;
        }
        appendClientLog('WARN', 'workspace.sync_after_delete_failed', {
          message: toErrorMessage(syncError),
        });
      }
      if (deleteError) {
        throw deleteError;
      }
      return deleteResult;
    }

    return {
      getKnownSessionIds,
      pruneContextUsageCache,
      extractToolNamesForComposerToggles,
      renderComposerEnhancements,
      refreshComposerToolToggles,
      getToolPreferences,
      handleComposerToggleChange,
      queueDeferredStartupTask,
      resolveActionMessageId,
      openLogsForStream,
      handleErrorRecoveryAction,
      handleArtifactAction,
      loadSessionsWithWorkspace,
      refreshSessionSummariesWithWorkspace,
      handleCreateSessionWithWorkspace,
      handleDeleteSessionWithWorkspace,
    };
  }

  return {
    createShellRuntimeController,
    deriveCanonicalSessionDisplayState,
  };
});
