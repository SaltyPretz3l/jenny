/* renderer/shell/renderer-shell-context-ring.js - the composer context ring of the shell runtime controller.
 *
 * Split out of renderer-shell-runtime-utils.js (which creates one per controller and still exports
 * deriveCanonicalSessionDisplayState): the next-send context estimate inputs, the ring repaint with its
 * byte-identical memo and open-popover freeze, the severity announcer and the next-turn preview feed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererShellContextRing = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

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
    // A caller that already holds the summary passes it (options.session) and skips the list scan.
    const session = (options.session && String(options.session.id || '').trim() === normalizedSessionId ? options.session : null)
      || sessions.find((entry) => String(entry?.id || '').trim() === normalizedSessionId)
      || null;
    const messageStore = sourceState.messagesBySession;
    const hasHydratedMessages = Boolean(
      normalizedSessionId
      && messageStore
      && typeof messageStore.has === 'function'
      && messageStore.has(normalizedSessionId)
    );
    // A strip chip of a background chat reads only the summary count: copy the list on first use.
    let hydratedCopy = null;
    const hydratedMessages = () => hydratedCopy || (hydratedCopy = hasHydratedMessages
      ? (messageStore.get(normalizedSessionId) || []).filter(Boolean)
      : []);
    const useHydratedMessageCount = hasHydratedMessages
      && normalizedSessionId === String(sourceState.currentSessionId || '').trim();
    const lastModelUsed = String(session?.last_model_used || '').trim();
    const preferredModel = String(session?.preferred_model || '').trim();
    const model = lastModelUsed || preferredModel;
    const modelSource = lastModelUsed ? 'last_used' : preferredModel ? 'preferred' : '';
    const persistedMessageCount = Math.floor(toNonnegativeFiniteNumber(session?.message_count));
    const messageCount = useHydratedMessageCount ? hydratedMessages().length : persistedMessageCount;
    const estimateTokens = typeof options.estimateTokens === 'function'
      ? options.estimateTokens
      : null;
    const overheadTokens = toNonnegativeFiniteNumber(
      options.contextOverheadTokens ?? sourceState.ui?.contextOverheadTokens ?? 0
    );
    const usedTokens = hasHydratedMessages && estimateTokens
      ? toNonnegativeFiniteNumber(estimateTokens(hydratedMessages())) + overheadTokens
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
      get messages() { return hydratedMessages(); },
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

  function createShellContextRing(deps) {
    const {
      state,
      windowRef,
      contextUsageModule,
      composerContextUsageSlot,
      getCurrentRuntimePreferences,
      getCurrentVisibleMessages,
    } = deps;

    /* Composer context ring memo: the last rendered ring HTML per session, so a
       composer repaint whose usage data is unchanged skips the innerHTML
       rewrite and the tooltip un-pin/re-pin dance. Paired with the last
       announced severity so the aria-live announcer fires once per threshold
       crossing rather than on every render. */
    let _composerRingMemo = { sessionId: null, html: null };
    const _lastAnnouncedSeverity = Object.create(null);
    let _contextUsageAnnouncerEl = null;

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
          ? jt('shell.runtime.contextAutoCompactImminent', 'Context {percent} — nearly full; auto-compaction is imminent.', { percent: summary.percentLabel })
          : jt('shell.runtime.contextNearlyFull', 'Context {percent} — the context window is nearly full.', { percent: summary.percentLabel })
        : summary.targetType === 'auto_compact'
          ? jt('shell.runtime.contextApproachingAutoCompact', 'Context {percent} — approaching auto-compaction.', { percent: summary.percentLabel })
          : jt('shell.runtime.contextFilling', 'Context {percent} — the context window is filling up.', { percent: summary.percentLabel });
    }

    /* Row 63: the ring reads the same next-send estimate as the Session summary. The feed
       repaints the ring alone when that estimate or the draft changes, and refreshes it when the
       chat's inputs change outside a reply. */
    let _contextFeed = null;

    function isContextTurnActive(sessionId) {
      const streams = windowRef.rendererMultiStreamController;
      if (streams && typeof streams.isSessionStreaming === 'function') return streams.isSessionStreaming(sessionId);
      return Boolean(String(state.activeStreamId || '').trim());
    }

    function contextInputsKey() {
      const sessionId = String(state.currentSessionId || '').trim();
      const session = getCurrentSessionSummary(sessionId);
      return [sessionId, getContextMeterMessages(sessionId).length, session?.updated_at || '',
        getActiveComposerModel(sessionId), session?.run_mode || '', JSON.stringify(session?.context_preferences || null)].join('\u001f');
    }

    function getComposerDraftText() {
      const input = composerContextUsageSlot?.closest?.('.composer-wrap')
        ?.querySelector?.('[data-chat-node="chatInput"], #chatInput');
      return input ? String(input.value || '') : '';
    }

    function ensureContextFeed() {
      if (_contextFeed || !composerContextUsageSlot) return _contextFeed;
      const previewModule = windowRef.rendererContextPreview;
      const doc = windowRef.document;
      if (!previewModule || typeof previewModule.bindComposerFeed !== 'function' || !doc) return null;
      _contextFeed = previewModule.bindComposerFeed({
        win: windowRef,
        doc,
        getSessionId: () => state.currentSessionId,
        getInputsKey: contextInputsKey,
        isTurnActive: () => isContextTurnActive(String(state.currentSessionId || '').trim()),
        request: (sessionId) => windowRef.jennyShell?.chat?.getNextTurnContextSummary?.(sessionId, {}),
        paint: renderContextRing,
      });
      return _contextFeed;
    }

    function renderContextRing() {
      const sessionId = String(state.currentSessionId || '').trim();
      if (composerContextUsageSlot) {
        const contextPopoverWasOpen = Boolean(
          composerContextUsageSlot.querySelector('.inv-popover:not([hidden])')
        );
        const previousPreview = composerContextUsageSlot
          .querySelector('[data-next-turn-context-summary]');
        const previousPreviewText = previousPreview?.textContent || '';
        const previousPreviewWasPending = previousPreview?.dataset?.contextPreviewPending === 'true';
        const focused = composerContextUsageSlot.ownerDocument?.activeElement;
        const focusSelector = focused && composerContextUsageSlot.contains(focused)
          ? (focused.matches('[data-inv-chip]') ? '[data-inv-chip="composer-context-ring"]'
            : focused.dataset?.action ? `[data-action="${focused.dataset.action}"]` : null)
          : null;

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
            turnActive: isContextTurnActive(sessionId),
            draftText: getComposerDraftText(),
            draftAttachments: getQueuedAttachments(),
            autoCompactEnabled: contextMeterOptions.autoCompactEnabled,
            manualCompactionEnabled: sessionDisplay.messageCount > 0 || compactionActivity?.pending === true,
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
            if (nextPreview && previousPreviewText) {
              nextPreview.textContent = previousPreviewText;
              nextPreview.hidden = previousPreview.hidden;
            }
            windowRef.inventory?.popover?.open?.(nextPopover, { trigger: nextChip, focus: false });
            windowRef.rendererContextMeterDetails?.positionPopover?.(nextPopover, nextChip);
            if (previousPreviewWasPending) {
              void windowRef.rendererContextMeterDetails?.loadPreview?.(nextPopover, state);
            }
          }
          if (focusSelector) composerContextUsageSlot.querySelector(focusSelector)?.focus();
        }

        announceContextUsageSeverity(sessionId, usageSummary);
      }
    }

    return { renderContextRing, ensureContextFeed };
  }

  return { createShellContextRing, deriveCanonicalSessionDisplayState };
});
