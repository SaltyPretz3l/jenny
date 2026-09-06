/* renderer/chat/renderer-render-pipeline-render-effects.js
 * Owns post-render orchestration for full renders and active-turn patches;
 * renderMessages remains the caller in renderer-render-pipeline-utils.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineRenderEffectsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Threshold for when an assistant turn is "substantial enough" to deserve
  // the Follow up action. Tuned to skip greetings and
  // short acknowledgements without suppressing real recommendations.
  const FOLLOWUP_SUBSTANTIAL_BUBBLE_CHARS = 280;
  const streamRevealUtils = (function resolveStreamRevealUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererStreamRevealUtils) {
      return globalThis.rendererStreamRevealUtils;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-stream-reveal-utils'); } catch (_error) { /* not available */ }
    }
    return null;
  })();
  const decoratorChannelUtils = (function resolveDecoratorChannelUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererTimelineDecoratorChannel) {
      return globalThis.rendererTimelineDecoratorChannel;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-timeline-decorator-channel'); } catch (_error) { /* not available */ }
    }
    return null;
  })();
  const longThreadBudget = (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineProjectionCacheUtils)
    || (typeof require === 'function' ? require('./renderer-render-pipeline-projection-cache') : null)
    || {};
  const LONG_THREAD_BUDGETS = longThreadBudget.BUDGETS || { rootMarkupEntries: 128 };
  const isLongThreadBoundsEnabled = typeof longThreadBudget.isLongThreadBoundsEnabled === 'function'
    ? longThreadBudget.isLongThreadBoundsEnabled
    : () => true;
  const pruneMapOldestFirst = typeof longThreadBudget.pruneMapOldestFirst === 'function'
    ? longThreadBudget.pruneMapOldestFirst
    : () => ({ evicted: [], remaining: 0 });

  function createRenderEffectsPipeline(deps) {
    const {
      state = {},
      dom = {},
      runtime = {},
      callbacks = {},
    } = deps || {};
    const { chatTimeline = null } = dom;
    const { uiRuntime = {} } = runtime;
    const {
      // D2 article-markup pipeline methods:
      buildMessageArticleMarkup = () => '',
      schedulePredictedHeightCleanup = () => {},
      syncPatchedArticlePrediction = () => {},
      // D3 thread-DOM pipeline methods:
      renderThreadTree = () => '',
      renderThreadNode = () => '',
      updateThreadRailExtents = () => {},
      measureThreadRailExtentsNow = () => {},
      scheduleRailResizeUpdate = () => {},
      attachRailResizeObserver = () => {},
      refreshRailRootObservation = () => {},
      syncTimelineBusyState = () => {},
      // Pipelines passed through:
      thinkingPipeline = {},
      chromePipeline = {},
      // streamReveal controller methods:
      commitStreamRevealFullRender = () => {},
      patchStreamRevealActiveTurnRoot = () => false,
      updateStreamRevealTailState = () => {},
      // C1/C2 helpers:
      resolveProjectionStreamingRowTarget = () => null,
      resolveTurnArticleMessageId = (messageId) => String(messageId || ''),
      computeTailFingerprint = () => '',
      // Injected renderer callbacks:
      syncBackendNotice = () => {},
      renderArtifactReviewPanel = () => {},
      // Review fix (F3 memo-key completeness): the article builder flips the
      // latest settled turn's phase to review_artifact when the split review
      // panel is visible; the memo key must fold that bool or the flip goes
      // stale. Default noop-false keeps flag-off/test paths unchanged.
      isArtifactReviewVisible = () => false,
      scheduleMessageViewportSync = () => {},
      appendClientLog = () => {},
      recordChatTimelineRolloutSignal = () => ({ logged: false, count: 0 }),
      escapeSelectorValue = (value) => String(value || ''),
      // B5 virtualizer facade. setActiveTurnRoot updates the
      // pin-invariant probe before each render; rebuild is scheduled in
      // a rAF after the rail's first measurement so heights are
      // accurate; refreshScope re-observes the entries inside an
      // outerHTML-swapped active-turn root. Default is a no-op stub so
      // small-conversation paths and tests don't need to wire one.
      virtualizerFacade = {
        setActiveTurnRoot() {},
        rebuild() {},
        prepareForStructuralMorph() {},
        refreshScope() {},
      },
    } = callbacks;
    let pendingVirtualizerRebuildFrame = null;
    let latestVirtualizedArticleContext = null;

    // One record for every timeline DOM write, whatever its scope. The four
    // render lanes all build their markup with buildMessageArticleMarkup and
    // all write through the shared keyed morph, but only two of them could say
    // whether that write morphed or replaced the subtree -- so a flicker was
    // diagnosed by elimination instead of by evidence. `lane` names which of
    // the four wrote; `outcome` uses the shared morph vocabulary.
    function recordTimelineDomWrite(lane, outcome, stats) {
      if (state.features?.featureFlags?.chat_timeline_render_telemetry !== true) {
        return;
      }
      const describe = typeof streamRevealUtils?.describeDomWrite === 'function'
        ? streamRevealUtils.describeDomWrite
        : null;
      if (!describe) {
        return;
      }
      recordChatTimelineRolloutSignal(
        String(state.currentSessionId || ''),
        'timeline_dom_write',
        describe(lane, outcome, stats)
      );
    }

    function setTimelineMarkup(html) {
      // The whole-transcript write -- the largest of the four lanes. It now
      // shares the children-scope fallback policy with every other caller of
      // setInnerHtmlPreservingCodeScroll, so a morph that does not take still
      // preserves code-block scroll here instead of discarding it. The bare
      // innerHTML below is reachable only when the sibling module did not
      // resolve at all, which is exactly what 'morph_unavailable' records.
      let outcome = 'morph_unavailable';
      let stats;
      if (
        streamRevealUtils
        && typeof streamRevealUtils.setInnerHtmlPreservingCodeScroll === 'function'
      ) {
        const result = streamRevealUtils.setInnerHtmlPreservingCodeScroll(chatTimeline, html, {
          collectStats: state.features?.featureFlags?.chat_timeline_render_telemetry === true,
          onError(error) {
            appendClientLog('WARN', 'timeline.keyed_morph_fallback', {
              target: 'chatTimeline',
              message: String(error?.message || error).slice(0, 200),
            });
          },
        });
        outcome = String(result?.outcome || 'morph_unavailable');
        stats = result?.stats;
      } else {
        chatTimeline.innerHTML = html;
      }
      recordTimelineDomWrite('full_render', outcome, stats);
    }

    // Both render paths use the same per-render buildArticle closure; centralize it so the dispatcher argument order has one owner.
    function makeBuildArticle({
      messages,
      latestAssistantMessageId,
      latestReplyAssistantMessageId,
      followUpDisabledReason,
      latestRegenerateRequest,
      projectionContext,
    }) {
      return (message) => {
        const regenerateRequest =
          String(message?.id || '') === latestReplyAssistantMessageId
            ? latestRegenerateRequest
            : null;
        return buildMessageArticleMarkup(
          message,
          messages,
          latestAssistantMessageId,
          latestReplyAssistantMessageId,
          followUpDisabledReason,
          regenerateRequest,
          projectionContext
        );
      };
    }

    // Finding 3: fingerprint the regenerate-request object into a short,
    // stable string so it can fold into the session-global markup-cache key
    // without threading the whole object through renderThreadTree/renderThreadNode.
    function fingerprintRegenerateRequest(latestRegenerateRequest) {
      if (!latestRegenerateRequest) {
        return '';
      }
      try {
        return JSON.stringify(latestRegenerateRequest);
      } catch (_error) {
        return String(latestRegenerateRequest.reason || latestRegenerateRequest.allowed || '');
      }
    }

    // Finding 3: messageFingerprints (from computeMessageFingerprintList) is
    // an array parallel to `messages`, not keyed by id. Build the id lookup
    // once per full render so computeRootMarkupKey (thread-dom.js) can pull a
    // subtree's content fingerprints in O(1) per message instead of
    // re-fingerprinting.
    // NOTE: deliberately built from THIS render's own `messages`/`messageFingerprints`
    // rather than reusing projectionContext.messageContentFingerprintById — that
    // map is keyed off the projection context's canonical `sourceMessages`, which
    // is not guaranteed index-aligned with the array rendered here. Keeping the
    // build local costs one extra O(n) Map pass (rides on an already-O(n) full
    // render) but keeps the memo key aligned to exactly what is drawn.
    function buildMessageFingerprintById(messages, messageFingerprints) {
      if (!Array.isArray(messageFingerprints) || !Array.isArray(messages)) {
        return null;
      }
      const byId = new Map();
      for (let index = 0; index < messages.length; index += 1) {
        const messageId = String(messages[index]?.id || '').trim();
        if (messageId && !byId.has(messageId)) {
          byId.set(messageId, String(messageFingerprints[index]?.content || ''));
        }
      }
      return byId;
    }

    function performFullMessageRender(
      messages,
      threadTree,
      latestAssistantMessageId,
      latestReplyAssistantMessageId,
      followUpDisabledReason,
      latestRegenerateRequest,
      structureSignature,
      derivedState,
      forcedOpenIds,
      projectionContext,
      timelineDividerByMessageId,
      messageFingerprints
    ) {
      const buildArticle = makeBuildArticle({
        messages,
        latestAssistantMessageId,
        latestReplyAssistantMessageId,
        followUpDisabledReason,
        latestRegenerateRequest,
        projectionContext,
      });
      const messageById = new Map();
      for (let index = 0; index < messages.length; index += 1) {
        const messageId = String(messages[index]?.id || '').trim();
        if (messageId && !messageById.has(messageId)) messageById.set(messageId, messages[index]);
      }
      latestVirtualizedArticleContext = { buildArticle, messageById };

      // Finding 3: settled-root markup memoization. Flag-gated the same way
      // other renderer rollout flags read straight off state.features.featureFlags
      // (no state.ui mirror). The active/
      // streaming root is never memoized — renderThreadTree/renderThreadNode
      // skip the cache for String(node.id) === renderOptions.activeTurnRootMessageId.
      const memoEnabled = state.features?.featureFlags?.thread_root_markup_memo === true;
      uiRuntime.threadRootMarkupCache = uiRuntime.threadRootMarkupCache || new Map();
      // Per-node .content fingerprints are what discriminate a settled root's
      // content in the cache key; only memoize when they're available — a
      // blank fingerprint could not tell two revisions of a message apart.
      // (This is the same completeness the whole-transcript render no-op guard
      // already trusts, so a per-node key is as safe as skipping a render.)
      const messageFingerprintById = buildMessageFingerprintById(messages, messageFingerprints);
      // NOTE: do NOT fold the whole-transcript messageTokenSignature into the
      // per-root key. It is just the join of every message's .content, so each
      // subtree's own per-node .content already captures its content — adding
      // the transcript-wide signature over-invalidates (every settled root
      // would miss whenever the active turn streams a token), defeating the
      // memo in exactly the structural-update-while-streaming case it targets.
      //
      // Review fix (memo-key completeness): buildMessageArticleMarkup reads
      // several ambient UI states straight off `state`/callbacks that are NOT
      // captured by the per-root content key. A root memoized before one of
      // them changed would be served stale (the F1 stale-cache class). Guard
      // each markup-affecting ambient input:
      //  - editingMessageId: the edited USER root swaps its bubble for the
      //    inline editor (article-markup buildMessageInnerMarkup) — exclude
      //    that one root from memo eligibility (it is a root: role==='user').
      //  - selectionMode: every settled root grows a selection checkbox/handle
      //    (resolveSelectionState) — suspend the whole cache while selection
      //    mode is active (rare, short); no root memoizes this render.
      //  - review_artifact: isArtifactReviewVisible() flips the latest settled
      //    turn's phase — fold the bool into sessionGlobals so a panel toggle
      //    busts every root's key once (isArtifactReviewVisible is false in the
      //    common case, so this does not perturb keys normally).
      const editingMessageId = state.ui && typeof state.ui.editingMessageId === 'string'
        ? state.ui.editingMessageId
        : '';
      const selectionModeActive = Boolean(state.ui && state.ui.selectionMode === true);
      const artifactReviewVisible = typeof isArtifactReviewVisible === 'function'
        ? isArtifactReviewVisible() === true
        : false;
      const sessionGlobals = {
        sessionId: state.currentSessionId,
        latestReplyAssistantMessageId,
        followUpDisabledReason,
        regenerateRequestFingerprint: fingerprintRegenerateRequest(latestRegenerateRequest),
        artifactReviewVisible,
      };
      // A projection-state revision bump means projection ROWS changed without
      // any message content changing (terminal reconcile consumption,
      // row-model rollback). The per-root memo key is built from message
      // fingerprints only, so a root memoized during the pre-reconcile render
      // would be served stale — drop the memo so every root rebuilds from the
      // corrected projection this one time (once per turn terminal). This runs
      // before the caller (renderer-render-pipeline-message-renderer.js)
      // advances projectionCommittedRevisionKey, so the compare below sees the
      // last COMMITTED revision — and keeps clearing on every retry if a
      // dropped render leaves the commit stale. `undefined` means no timeline
      // commit has happened yet (fresh runtime): the memo is empty, nothing to
      // drop. A session switch also mismatches (the key is session-scoped) and
      // clears once — deliberate, not just tolerated: a reconcile stored while
      // the session was backgrounded is consumed on its first render after
      // switching back, and roots memoized before that reconcile must not be
      // served over the corrected projection.
      const projectionRevisionKey = String(projectionContext?.projectionStateRevisionKey || '');
      if (
        uiRuntime.projectionCommittedRevisionKey !== undefined
        && uiRuntime.projectionCommittedRevisionKey !== projectionRevisionKey
      ) {
        uiRuntime.threadRootMarkupCache?.clear();
      }
      const html = renderThreadTree(threadTree, state.currentSessionId, forcedOpenIds, buildArticle, {
        dividerByMessageId: timelineDividerByMessageId,
        markupCache: (memoEnabled && messageFingerprintById) ? uiRuntime.threadRootMarkupCache : null,
        activeTurnRootMessageId: String(projectionContext?.activeTurnRootMessageId || ''),
        editingMessageId,
        selectionModeActive,
        sessionGlobals,
        messageFingerprintById,
      });
      if (isLongThreadBoundsEnabled(state.features?.featureFlags)) {
        pruneMapOldestFirst(uiRuntime.threadRootMarkupCache, LONG_THREAD_BUDGETS.rootMarkupEntries, {
          isPinned(rootId) {
            return String(rootId || '').trim() === String(projectionContext?.activeTurnRootMessageId || '').trim();
          },
        });
      }
      const longThreadBudgetStats = {
        ...(state.ui?.longThreadBudgetStats || {}),
        ...(uiRuntime.longThreadBudgetStats || {}),
        rootMarkupEntries: uiRuntime.threadRootMarkupCache.size,
        rootMarkupCap: LONG_THREAD_BUDGETS.rootMarkupEntries,
      };
      uiRuntime.longThreadBudgetStats = longThreadBudgetStats;
      if (state.ui && typeof state.ui === 'object') {
        state.ui.longThreadBudgetStats = longThreadBudgetStats;
      }
      virtualizerFacade.prepareForStructuralMorph?.();
      setTimelineMarkup(html);
      updateStreamRevealTailState([], computeTailFingerprint);
      const streamingRowTarget = resolveProjectionStreamingRowTarget(projectionContext);

      commitStreamRevealFullRender({
        currentSessionId: state.currentSessionId,
        structureSignature,
        latestAssistantMessageId,
        messages,
        streamingMessage: derivedState ? derivedState.streamingMessage : undefined,
        streamingArticleMessageId: resolveTurnArticleMessageId(
          String(derivedState?.streamingMessage?.id || ''),
          projectionContext
        ),
        streamingRowTarget: streamingRowTarget
          ? {
            turnId: streamingRowTarget.turnId,
            rowKind: streamingRowTarget.rowKind,
            toolCallId: streamingRowTarget.toolCallId,
          }
          : null,
        activeTurnRootMessageId: projectionContext?.activeTurnRootMessageId,
        activeTurnStructureHash: projectionContext?.activeTurnStructureHash,
        activeTurnTailFingerprint: projectionContext?.activeTurnTailFingerprint,
      });

      if (window.markdownUtils && typeof window.markdownUtils.renderInlineMermaidBlocks === 'function') {
        window.markdownUtils.renderInlineMermaidBlocks(chatTimeline, { isStreaming: false });
      }
      renderMathAfterTimelinePatch();

      schedulePredictedHeightCleanup();
      // Finding 2: attach first so its cancel clears the PREVIOUS render's
      // pending debounce timer/rAF, then measure synchronously so
      // --_rail-top/--_rail-height are set before paint (no height:0 ->
      // snap window). The observer's own later initial-fire still runs
      // through the debounced scheduleRailResizeUpdate for subsequent
      // resizes; it will coalesce to the same values (harmless).
      attachRailResizeObserver();
      measureThreadRailExtentsNow();

      // B5 virtualization hook. Update the active-turn-root pin probe
      // first so the virtualizer's first observer-callback batch knows
      // which root to keep mounted while streaming. Defer rebuild() one
      // rAF so the rail tick runs first and entries are laid out — the
      // virtualizer needs accurate getBoundingClientRect heights to size
      // its placeholders.
      virtualizerFacade.setActiveTurnRoot(projectionContext?.activeTurnRootMessageId || '');
      if (pendingVirtualizerRebuildFrame !== null) return;
      pendingVirtualizerRebuildFrame = true;
      const frameId = requestAnimationFrame(function virtualizerRebuildAfterRail() {
        pendingVirtualizerRebuildFrame = null;
        virtualizerFacade.rebuild();
      });
      if (pendingVirtualizerRebuildFrame !== null) pendingVirtualizerRebuildFrame = frameId;
    }

    function tryPatchActiveTurnRoot(messages, threadTree, forcedOpenIds, latestAssistantMessageId, latestReplyAssistantMessageId, followUpDisabledReason, latestRegenerateRequest, structureSignature, projectionContext, timelineDividerByMessageId) {
      // The root id alone gates the repaint scope because a live turn may have no streaming segment.
      if (
        !state.ui?.chatTimelineBatch4FastPathEnabled
        || !projectionContext?.available
        || !projectionContext.activeTurnRootMessageId
      ) {
        return false;
      }
      const activeRootId = String(projectionContext.activeTurnRootMessageId || '').trim();
      const activeRootNode = threadTree?.nodeById?.get?.(activeRootId) || null;
      if (!activeRootNode) {
        return false;
      }
      const activeRootSelector = '.chat-thread-root[data-thread-message-id="'
        + escapeSelectorValue(activeRootId)
        + '"]';
      const previousRootEl = chatTimeline?.querySelector?.(activeRootSelector) || null;
      const buildArticle = makeBuildArticle({
        messages,
        latestAssistantMessageId,
        latestReplyAssistantMessageId,
        followUpDisabledReason,
        latestRegenerateRequest,
        projectionContext,
      });
      const patched = patchStreamRevealActiveTurnRoot({
        currentSessionId: state.currentSessionId,
        structureSignature,
        activeTurnRootMessageId: activeRootId,
        turnStructureHash: projectionContext.activeTurnStructureHash,
        turnTailFingerprint: projectionContext.activeTurnTailFingerprint,
        expectedRootOrder: Array.isArray(threadTree?.roots) ? threadTree.roots.map((node) => String(node?.id || '').trim()).filter(Boolean) : [],
        buildTurnRootMarkup: () => renderThreadNode(activeRootNode, 0, state.currentSessionId, forcedOpenIds, buildArticle, {
          dividerByMessageId: timelineDividerByMessageId,
          suppressOwnLeadingDivider: true,
        }),
      });

      if (patched) {
        // The active-turn root's outerHTML was just swapped — its old
        // .chat-entry observers are pointing at detached nodes. Tell the
        // virtualizer to re-observe the freshly-built subtree.
        virtualizerFacade.setActiveTurnRoot(activeRootId);
        if (chatTimeline) {
          const rootEl = chatTimeline.querySelector(activeRootSelector);
          if (rootEl) {
            virtualizerFacade.refreshScope(rootEl);
          }
          refreshRailRootObservation(rootEl, previousRootEl);
        }
      }

      return patched;
    }

    function decorateTranscriptFollowUpButtonsIn(containerEl) {
      // Scoped variant — used by both the full-render sweep (containerEl
      // = chatTimeline) and B5 onAfterMount re-decoration (containerEl =
      // a freshly-restored .chat-entry). The decorator is idempotent so
      // calling it twice on the same row is safe.
      if (!containerEl || typeof containerEl.querySelectorAll !== 'function') {
        return;
      }
      const hoverRows = containerEl.querySelectorAll('.chat-hover-row[data-hover-row="true"]');
      for (const hoverRow of hoverRows) {
        const messageId = String(hoverRow.getAttribute('data-message-id') || '').trim();
        if (!messageId) {
          continue;
        }
        const entry = hoverRow.closest('.chat-entry[data-message-role]');
        if (!entry || String(entry.getAttribute('data-message-role') || '').trim() !== 'assistant') {
          continue;
        }
        // Skip already-decorated rows before doing any expensive DOM walks
        // — this loop runs on every transcript render.
        const actionContainer = hoverRow.querySelector('.chat-hover-actions');
        if (!actionContainer || actionContainer.querySelector('[data-message-action="follow-up"]')) {
          continue;
        }
        // Gate: only decorate turns the user might actually want to defer
        // (proactive blocks, substantial replies, or an upstream opt-in).
        // Tool work alone doesn't qualify — a chatty turn that happens to
        // invoke an introspection tool shouldn't surface follow-up actions.
        const optedIn = entry.dataset.followupsEligible === 'true';
        const hasProactive = !optedIn
          && !!entry.querySelector('.proactive-suggestion-block, .interactive-card');
        let isSubstantial = false;
        if (!optedIn && !hasProactive) {
          let total = 0;
          for (const bubble of entry.querySelectorAll('.chat-bubble')) {
            total += (bubble.textContent || '').length;
            if (total >= FOLLOWUP_SUBSTANTIAL_BUBBLE_CHARS) {
              isSubstantial = true;
              break;
            }
          }
        }
        if (!optedIn && !hasProactive && !isSubstantial) {
          continue;
        }
        const followUpBtn = document.createElement('button');
        followUpBtn.className = 'chat-hover-action chat-hover-action-text message-action-button';
        followUpBtn.type = 'button';
        followUpBtn.textContent = 'Follow up';
        followUpBtn.dataset.action = 'follow-up';
        followUpBtn.dataset.messageAction = 'follow-up';
        followUpBtn.dataset.messageId = messageId;
        followUpBtn.setAttribute('aria-label', 'Save to Open Loops');
        followUpBtn.setAttribute('title', 'Save to Open Loops');
        actionContainer.append(followUpBtn);
      }
    }

    function decorateTranscriptFollowUpButtons() {
      // Original full-sweep entry point. Backwards-compatible wrapper
      // around the new scoped variant — runPostTimelineRenderEffects and
      // any external callers keep working unchanged.
      decorateTranscriptFollowUpButtonsIn(chatTimeline);
    }

    // Resolve the patched turn's article so a stream-patch frame can scope the
    // (idempotent, container-scoped) follow-up decorator to that one article
    // instead of sweeping every hover row in the timeline (finding #16).
    function resolvePatchedFollowUpRoot(messageId) {
      const id = String(messageId || '').trim();
      if (!id || /["\\]/.test(id) || !chatTimeline || typeof chatTimeline.querySelector !== 'function') {
        return null;
      }
      try {
        return chatTimeline.querySelector('.chat-entry[data-message-id="' + id + '"]');
      } catch (_error) {
        return null;
      }
    }

    // B5: one decorator channel resolves the patched root once per render/patch and
    // drives the post-render decorators. The follow-up decorator subscribes here; the pin
    // re-scan reuses the same scope.patchedRoot (passed to the viewport sync below).
    const decoratorChannel = (decoratorChannelUtils
      && typeof decoratorChannelUtils.createTimelineDecoratorChannel === 'function')
      ? decoratorChannelUtils.createTimelineDecoratorChannel({ chatTimeline })
      : null;
    if (decoratorChannel) {
      decoratorChannel.subscribe('follow-up', function followUpDecorator(scope) {
        if (!scope.decorateFollowUps) {
          return;
        }
        if (scope.patchedRoot) {
          decorateTranscriptFollowUpButtonsIn(scope.patchedRoot);
        } else {
          decorateTranscriptFollowUpButtons();
        }
      });
    }

    function renderLiveThinkingChip() {
      return thinkingPipeline.renderLiveThinkingChip?.();
    }

    function renderInlineMermaidAfterTimelinePatch(isStreaming, targetRoot = chatTimeline) {
      if (window.markdownUtils && typeof window.markdownUtils.renderInlineMermaidBlocks === 'function') {
        window.markdownUtils.renderInlineMermaidBlocks(targetRoot, { isStreaming: Boolean(isStreaming) });
      }
      renderMathAfterTimelinePatch(targetRoot);
    }

    // KaTeX live-DOM typeset pass (katex_math): same post-insert seam as the
    // Mermaid pass above. Idempotent — already-rendered wrappers are skipped.
    function renderMathAfterTimelinePatch(targetRoot = chatTimeline) {
      if (window.markdownMathUtils && typeof window.markdownMathUtils.renderMathInto === 'function') {
        window.markdownMathUtils.renderMathInto(targetRoot);
      }
    }

    // Re-trigger heavy lazy decorations for a virtualizer-restored article:
    // B4 lazy-Mermaid loses its IntersectionObserver targets when markdown
    // blocks unmount (re-observe them), math wrappers re-typeset
    // idempotently, and hover-action follow-up decoration never ran on the
    // un-mounted markup. Every pass is best-effort in isolation so one
    // failing decoration can't suppress the others.
    function redecorateVirtualizedEntry(containerEl) {
      if (!containerEl) return;
      try {
        if (window.markdownUtils && typeof window.markdownUtils.renderInlineMermaidBlocks === 'function') {
          window.markdownUtils.renderInlineMermaidBlocks(containerEl, { isStreaming: false });
        }
      } catch (_mermaidErr) { /* best-effort */ }
      try {
        if (window.markdownMathUtils && typeof window.markdownMathUtils.renderMathInto === 'function') {
          window.markdownMathUtils.renderMathInto(containerEl);
        }
      } catch (_mathErr) { /* best-effort */ }
      try {
        decorateTranscriptFollowUpButtonsIn(containerEl);
      } catch (_decorateErr) { /* best-effort */ }
    }

    function buildVirtualizedEntryInnerHtml(entryEl) {
      const messageId = String(entryEl?.getAttribute?.('data-message-id') || '').trim();
      const context = latestVirtualizedArticleContext;
      const message = messageId ? context?.messageById?.get?.(messageId) : null;
      if (!message || typeof context?.buildArticle !== 'function') return '';
      const articleMarkup = String(context.buildArticle(message) || '').trim();
      const doc = entryEl?.ownerDocument || (typeof document !== 'undefined' ? document : null);
      const template = doc?.createElement?.('template') || null;
      if (!articleMarkup || !template) return '';
      template.innerHTML = articleMarkup;
      return String(template.content?.querySelector?.('.chat-entry[data-message-id]')?.innerHTML || '');
    }

    function syncPostRenderChrome() {
      // Inlines the former local utils.js wrappers `syncSurfaceStates()` and
      // `renderOriginChip()` directly onto chromePipeline. Both wrappers were
      // pure delegations; the indirection has no behavioral value here.
      chromePipeline.syncSurfaceStates?.();
      chromePipeline.renderOriginChip?.();
      syncBackendNotice();
      renderArtifactReviewPanel();
    }

    function runPostTimelineRenderEffects(messages, options) {
      const opts = options || {};
      syncTimelineBusyState();
      // Resolve the patched root once and run the follow-up decorator through the channel;
      // the same scope.patchedRoot drives the scoped pin re-scan in the viewport sync below.
      const decoratorScope = decoratorChannel
        ? decoratorChannel.dispatch({
          patchedMessageId: opts.patchedMessageId || '',
          decorateFollowUps: opts.decorateFollowUps === true,
          syncViewport: opts.syncViewport === true,
        })
        : null;
      let patchedRoot = decoratorScope ? decoratorScope.patchedRoot : null;
      if (!decoratorChannel && opts.decorateFollowUps) {
        // Defensive: channel module unavailable -> preserve the old inline behavior.
        patchedRoot = opts.patchedMessageId
          ? resolvePatchedFollowUpRoot(opts.patchedMessageId)
          : null;
        if (patchedRoot) {
          decorateTranscriptFollowUpButtonsIn(patchedRoot);
        } else {
          decorateTranscriptFollowUpButtons();
        }
      }
      if (opts.patchedMessageId && patchedRoot && typeof patchedRoot.closest === 'function') {
        const patchedRailRoot = patchedRoot.closest('.chat-thread-root');
        if (patchedRailRoot) scheduleRailResizeUpdate(patchedRailRoot);
      }
      if (Object.prototype.hasOwnProperty.call(opts, 'inlineMermaidStreaming')) {
        renderInlineMermaidAfterTimelinePatch(opts.inlineMermaidStreaming, patchedRoot || chatTimeline);
      }
      if (opts.patchedMessageId) {
        syncPatchedArticlePrediction(opts.patchedMessageId, opts.predictedHeight);
      }
      if (opts.cleanupPredictedHeights) {
        schedulePredictedHeightCleanup();
      }
      if (opts.liveThinking !== false) {
        renderLiveThinkingChip();
      }
      if (opts.syncViewport) {
        scheduleMessageViewportSync(messages, {
          patchedRoot,
        });
      }
      if (opts.syncChrome) {
        syncPostRenderChrome();
      }
    }

    /* ---- sprite helpers ---- */
    function hideAssistantSprite({ clearTarget = false } = {}) {
      return thinkingPipeline.hideAssistantSprite?.({ clearTarget });
    }

    function applyAssistantSprite(targetMessage, targetY) {
      return thinkingPipeline.applyAssistantSprite?.(targetMessage, targetY);
    }

    function updateAssistantSpritePosition(messages, derivedState) {
      return thinkingPipeline.updateAssistantSpritePosition?.(messages, derivedState);
    }

    /* ---- render functions ---- */
    function renderLayout() {
      return chromePipeline.renderLayout?.();
    }

    function dispose() {
      latestVirtualizedArticleContext = null;
      if (pendingVirtualizerRebuildFrame === null) return;
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pendingVirtualizerRebuildFrame);
      pendingVirtualizerRebuildFrame = null;
    }

    return {
      performFullMessageRender,
      tryPatchActiveTurnRoot,
      syncPostRenderChrome,
      runPostTimelineRenderEffects,
      renderLiveThinkingChip,
      hideAssistantSprite,
      applyAssistantSprite,
      updateAssistantSpritePosition,
      renderLayout,
      dispose,
      // Scoped follow-up decorator — exported so the B5 virtualizer's
      // onAfterMount can re-decorate a freshly-restored .chat-entry
      // without sweeping the whole timeline.
      decorateTranscriptFollowUpButtonsIn,
      redecorateVirtualizedEntry,
      buildVirtualizedEntryInnerHtml,
    };
  }

  return { createRenderEffectsPipeline };
});
