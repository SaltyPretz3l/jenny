(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamRevealUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // index.html loads renderer-turn-shell.js AFTER this script: read at factory
  // time the global was always {} in the app, and the live text patches of a
  // later segment went into its hidden thread-compat anchor (dogfood B15).
  const resolveTurnShellUtils = () => (typeof globalThis !== 'undefined' && globalThis.rendererTurnShell)
    || (typeof require === 'function' ? require('./renderer-turn-shell') : null)
    || {};
  function resolveStreamRevealModule(globalName, modulePath) {
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) return globalThis[globalName];
    if (typeof require === 'function') {
      try { return require(modulePath); } catch (_error) { /* not available */ }
    }
    return {};
  }
  const streamDomPatchUtils = resolveStreamRevealModule('rendererStreamDomPatchUtils', './renderer-stream-dom-patch-utils');
  const streamAffordanceUtils = resolveStreamRevealModule('rendererStreamAffordanceUtils', './renderer-stream-affordance-utils');
  const streamPatchTargetUtils = resolveStreamRevealModule('rendererStreamPatchTargetUtils', './renderer-stream-patch-target-utils');
  const thinkingPanelSettleUtils = resolveStreamRevealModule('rendererThinkingPanelSettleUtils', '../shell/renderer-thinking-panel-settle-utils');
  const autocollapseUtils = resolveStreamRevealModule('rendererReasoningAutocollapseUtils', './renderer-reasoning-autocollapse-utils');
  const tokenFadeUtils = resolveStreamRevealModule('rendererStreamTokenFadeUtils', './renderer-stream-token-fade-utils');
  const reasoningPatchUtils = resolveStreamRevealModule('rendererStreamReasoningPatchUtils', './renderer-stream-reasoning-patch-utils');
  const {
    captureCodeBlockScroll,
    describeDomWrite,
    applyRowListFallback,
    restoreCodeBlockScroll,
    setChildrenHtmlPreservingKeyedNodes,
    setInnerHtmlPreservingCodeScroll,
    setOuterHtmlPreservingCodeScroll,
  } = streamDomPatchUtils;
  const { settleVisibleStreamAffordances } = streamAffordanceUtils;

  function createStreamRevealController(deps) {
    const settings = deps || {};
    const readSessionId = () => String(settings.getSessionId?.() ?? settings.state?.currentSessionId ?? '');
    const settleCleanups = new Set();
    let disposed = false;
    const windowRef = settings.windowRef || null;
    const chatTimeline = settings.chatTimeline || null;
    const reducedMotionQuery = settings.reducedMotionQuery || { matches: false };
    const renderStreamingMarkdownUnits =
      typeof settings.renderStreamingMarkdownUnits === 'function'
        ? settings.renderStreamingMarkdownUnits
        : () => ({ html: '', units: [], fingerprints: [], changedStartIndex: -1 });
    const escapeSelectorValue =
      typeof settings.escapeSelectorValue === 'function'
        ? settings.escapeSelectorValue
        : (value) => String(value || '');
    // chat_stream_paint_v2 (Ht-C): read live off renderer state so the flag
    // survives late hydration; absent state (legacy callers) = OFF path.
    const isStreamPaintV2Enabled = () =>
      settings.state?.features?.featureFlags?.chat_stream_paint_v2 === true;
    const isTokenFadeEnabled = () =>
      settings.state?.features?.featureFlags?.chat_stream_token_fade === true;
    const recordChatTimelineRolloutSignal = typeof settings.recordChatTimelineRolloutSignal === 'function'
      ? settings.recordChatTimelineRolloutSignal
      : () => ({ logged: false, count: 0 });
    // Emits the shared timeline-DOM-write record for the lanes this module
    // owns. describeDomWrite is the one definition of the details shape; the
    // recorder is whichever this module was already given.
    function recordTimelineDomWrite(sessionId, lane, outcome, stats) {
      // The `typeof` guard is not defensive padding: resolveStreamRevealModule
      // falls back to `{}`, so an unresolved sibling would make a DIAGNOSTIC
      // throw inside the streaming patch path. Telemetry must never be able to
      // break a paint.
      if (typeof describeDomWrite !== 'function') {
        return;
      }
      recordChatTimelineRolloutSignal(
        String(sessionId || ''),
        'timeline_dom_write',
        describeDomWrite(lane, outcome, stats)
      );
    }
    const streamClientMetrics = settings.streamClientMetrics
      || ((typeof globalThis !== 'undefined'
        && globalThis.rendererStreamClientMetricsModule
        && typeof globalThis.rendererStreamClientMetricsModule.getShared === 'function')
        ? globalThis.rendererStreamClientMetricsModule.getShared()
        : null);
    const noteHeaderPatch = (kind) =>
      streamClientMetrics?.noteRenderForSession?.(readSessionId(), kind);
    const turnShellUtils = resolveTurnShellUtils();
    const resolveVisibleMessageDomTarget = typeof turnShellUtils.resolveVisibleMessageDomTarget === 'function'
      ? turnShellUtils.resolveVisibleMessageDomTarget
      : function fallbackResolveVisibleMessageDomTarget(container, messageId) {
        const normalizedMessageId = String(messageId || '').trim();
        if (!container || !normalizedMessageId || typeof container.querySelector !== 'function') {
          return null;
        }
        return container.querySelector(
          `[data-message-id="${escapeSelectorValue(normalizedMessageId)}"]`
        );
      };

    const runtime = {
      streamingMessageId: '',
      streamingArticleMessageId: '',
      streamingRowTarget: null,
      activeTurnRootMessageId: '',
      activeTurnStructureHash: 0,
      activeTurnTailFingerprint: '',
      previousUnits: [],
      structureSignature: 0,
      sessionId: '',
      tokenFadeTracker: null,
      previousDomCount: 0,
      previousTailFingerprint: '',
      lastThinkingMarkup: '',
      lastThinkingMarkupKey: '',
      lastMessageThinkingMarkup: '',
      lastMessageThinkingMarkupKey: '',
    };
    const streamPatchTargetController = streamPatchTargetUtils.createStreamPatchTargetUtils({
      getRuntime: () => runtime,
      getChatTimeline: () => chatTimeline,
      escapeSelectorValue,
      resolveVisibleMessageDomTarget,
    });
    const {
      anchorStreamingArticleMarker,
      clearStreamingArticleMarker,
      describePatchBlock,
      stampStreamingArticleMarker,
      sweepStreamingArticleMarkers,
      normalizeStreamingRowTarget,
      resolvePatchTargetArticle,
      resolveStreamingArticlePatchTarget,
      resolveStreamingPatchTarget,
      resolveStreamingRowPatchTarget,
    } = streamPatchTargetController;

    function buildAttachmentSignature(message) {
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      if (!attachments.length) {
        return '';
      }
      return attachments
        .map((attachment) => [
          String(attachment?.id || ''),
          String(attachment?.kind || ''),
          String(attachment?.sourceKind || ''),
          String(attachment?.assetPath || ''),
          String(attachment?.mimeType || ''),
          String(attachment?.durationMs || ''),
        ].join('~'))
        .join('^');
    }

    function resetState(options) {
      const nextOptions = options || {};
      reasoningHandoff.clear();
      clearStreamingArticleMarker();
      runtime.streamingMessageId = '';
      runtime.streamingArticleMessageId = '';
      runtime.streamingRowTarget = null;
      runtime.activeTurnRootMessageId = '';
      runtime.activeTurnStructureHash = 0;
      runtime.activeTurnTailFingerprint = '';
      runtime.previousUnits = [];
      if (!nextOptions.preserveStructureSignature) {
        runtime.structureSignature = 0;
      }
      if (!nextOptions.preserveSessionId) {
        runtime.sessionId = '';
      }
      runtime.previousDomCount = 0;
      runtime.previousTailFingerprint = '';
      runtime.lastThinkingMarkup = '';
      runtime.lastThinkingMarkupKey = '';
      runtime.lastMessageThinkingMarkup = '';
      runtime.lastMessageThinkingMarkupKey = '';
    }

    function buildTimelineStructureSignature(messages) {
      return (Array.isArray(messages) ? messages : [])
        .map((message) => {
          const source = message || {};
          const hasReasoning = Boolean(
            source.reasoning
            && Array.isArray(source.reasoning.entries)
            && source.reasoning.entries.length
            && String(source.reasoning.source || '') === 'provider'
          );
          return [
            String(source.id || ''),
            String(source.role || ''),
            String(source.kind || ''),
            String(source.status || ''),
            String(source.finalizedAt || ''),
            buildAttachmentSignature(source),
            hasReasoning ? 'R' : '',
          ].join(':');
        })
        .join('|');
    }

    function getStreamingMessage(messages, latestAssistantMessageId) {
      const targetId = String(latestAssistantMessageId || '').trim();
      if (!targetId) {
        return null;
      }
      const message = (Array.isArray(messages) ? messages : []).find(
        (entry) => String(entry && entry.id || '') === targetId
      );
      if (!message) {
        return null;
      }
      const kind = String(message.kind || '');
      if (
        String(message.role || '') !== 'assistant' ||
        String(message.status || '') !== 'streaming' ||
        kind === 'question_batch' ||
        kind === 'interactive_round_recap' ||
        kind === 'slash_command_output'
      ) {
        return null;
      }
      return message;
    }

    function patchBubbleUnits(bubble, patchModel, doc) {
      streamDomPatchUtils.noteRowSubtreeWrite?.(bubble);
      const units = patchModel.streamUnits;
      const changedStart = patchModel.streamChangedStart;

      // If no structured units or nothing changed, use bulk replacement as fallback.
      if (!units || !units.length || changedStart === -1) {
        if (changedStart !== -1) {
          setInnerHtmlPreservingCodeScroll(bubble, patchModel.bubbleInnerHtml);
        }
        return;
      }

      const existingUnits = bubble.querySelectorAll('[data-stream-unit-index]');

      // If existing unit count doesn't match unchanged prefix, fall back.
      if (existingUnits.length > 0 && changedStart > existingUnits.length) {
        setInnerHtmlPreservingCodeScroll(bubble, patchModel.bubbleInnerHtml);
        return;
      }

      // Update changed existing units in place.
      for (let i = changedStart; i < units.length; i++) {
        const unitData = units[i];
        // chat_stream_token_fade: only the growing tail unit fades its new
        // text (a fresh tail unit fades its first line once); every other
        // write stays the plain innerHTML path.
        const fadeTail = i === units.length - 1 && isTokenFadeEnabled() && !reducedMotionQuery.matches
          && typeof tokenFadeUtils.createStreamTokenFadeTracker === 'function';
        if (fadeTail && !runtime.tokenFadeTracker) {
          runtime.tokenFadeTracker = tokenFadeUtils.createStreamTokenFadeTracker({ setInnerHtml: setInnerHtmlPreservingCodeScroll });
        }
        const writeUnit = (el, plainWrite) => {
          if (fadeTail) {
            runtime.tokenFadeTracker.reset(runtime.streamingMessageId);
            runtime.tokenFadeTracker.applyTailUnit(el, unitData.html, i);
          } else plainWrite();
        };
        if (i < existingUnits.length) {
          writeUnit(existingUnits[i], () => setInnerHtmlPreservingCodeScroll(existingUnits[i], unitData.html));
        } else {
          const el = doc.createElement('div');
          el.className = 'chat-stream-unit';
          el.setAttribute('data-stream-unit-index', String(i));
          writeUnit(el, () => { el.innerHTML = unitData.html; });
          bubble.appendChild(el);
        }
      }
      for (let i = existingUnits.length - 1; i >= units.length; i--) {
        existingUnits[i].remove();
      }
    }

    function buildAutoCollapseOptions(doc) {
      const win = windowRef || doc?.defaultView;
      return { reducedMotion: reducedMotionQuery.matches, transitionMs: readSettleDelayMs(win, doc), windowRef: win };
    }

    // Rebuild paths (full render, keyed morph, article rewrite) replace the
    // live panel node; the tracker replays the eased hand-off on the new one.
    const reasoningHandoff = autocollapseUtils.createReasoningHandoffTracker?.({
      chatTimeline, escapeSelectorValue, buildOptions: buildAutoCollapseOptions,
    }) || { remember() {}, rememberById() {}, clear() {}, replay() { return 0; } };
    const replayReasoningHandoff = () => reasoningHandoff.replay();
    const { patchReasoningStack } = reasoningPatchUtils.createReasoningStackPatcher({
      getRuntime: () => runtime, isStreamPaintV2Enabled, noteHeaderPatch, buildAutoCollapseOptions,
    });

    function buildStreamingBubbleMarkup(message) {
      const messageId = String(message && message.id || '');
      const currentSessionId = readSessionId();
      const hasPreviousState = runtime.sessionId === currentSessionId && runtime.streamingMessageId === messageId && runtime.previousUnits.length > 0;
      const fullContent = (resolveStreamRevealModule('rendererCitationChipsUtils', './renderer-citation-chips-utils').stripCitationMarkersForFlags || String)(String(message && message.content || ''), settings.state?.features?.featureFlags, { streaming: true });
      // Render the full received aggregate. rAF batching in the commit queue
      // already provides frame-rate smoothing; an extra paced cursor on top
      // only adds visible lag and a snap-in when the bubble flips to complete.
      const renderModel = renderStreamingMarkdownUnits(fullContent, {
        previousUnits: hasPreviousState ? runtime.previousUnits : [],
      });
      const unitCount = renderModel.units.length;
      const wrappers = [];
      const streamUnits = unitCount
        ? renderModel.units.map((unit, index) => {
            wrappers.push(`<div class="chat-stream-unit" data-stream-unit-index="${index}">${unit.html}</div>`);
            return { html: unit.html };
          })
        : null;
      const bubbleInnerHtml = streamUnits ? wrappers.join('') : renderModel.html;

      runtime.streamingMessageId = messageId;
      runtime.previousUnits = renderModel.units;

      return {
        bubbleInnerHtml,
        streamUnits,
        streamChangedStart: renderModel.changedStartIndex,
      };
    }

    // The settle delay must outlast the panel's max-height transition
    // (var(--motion-duration-regular): 220ms base, 280ms under
    // data-motion="calm") or settleThinkingPanelNow pins max-height:none
    // mid-transition and the expand visibly snaps. Read the live token with
    // a safety margin; the base token value is the fallback where computed
    // styles are unavailable (jsdom).
    const SETTLE_DURATION_FALLBACK_MS = 220;
    const SETTLE_DURATION_MARGIN_MS = 80;
    function readSettleDelayMs(win, doc) {
      let durationMs = SETTLE_DURATION_FALLBACK_MS;
      const root = doc && doc.documentElement;
      if (win && root && typeof win.getComputedStyle === 'function') {
        const rawValue = String(win.getComputedStyle(root).getPropertyValue('--motion-duration-regular') || '').trim();
        if (rawValue.endsWith('ms')) {
          const parsedMs = Number.parseFloat(rawValue);
          if (Number.isFinite(parsedMs)) {
            durationMs = parsedMs;
          }
        } else if (rawValue.endsWith('s')) {
          const parsedSeconds = Number.parseFloat(rawValue);
          if (Number.isFinite(parsedSeconds)) {
            durationMs = parsedSeconds * 1000;
          }
        }
      }
      return durationMs + SETTLE_DURATION_MARGIN_MS;
    }

    // Every expanded panel in scope, each judged by ITS OWN block. A first-match
    // lookup re-clamped an earlier, user-opened thought on every patch of a later
    // streaming phase (the flicker) and never released the live tail (the scroll
    // fight). Owner gate 2026-09-20.
    function syncExpandedThinkingPanelHeight(article) {
      const panels = article?.querySelectorAll?.('.reasoning-row-panel.expanded');
      if (!panels || !panels.length) return;
      for (const panel of panels) syncOneExpandedThinkingPanel(panel);
    }

    function syncOneExpandedThinkingPanel(panel) {
      if (!panel || panel.hidden) return;
      if (autocollapseUtils.isReasoningPanelCollapsing?.(panel)) return;
      if (reducedMotionQuery.matches) {
        panel.style.maxHeight = 'none';
        return;
      }
      // The live streaming tail grows freely: re-clamping to scrollHeight every
      // patch fights the per-unit reveal and the scroll-follow. On flip to
      // complete/error the pin below writes a measured height in that frame.
      const block = panel.closest?.('.reasoning-row-block');
      if (block?.getAttribute?.('data-reasoning-status') === 'streaming') {
        panel.style.maxHeight = 'none';
        return;
      }
      // A settled panel (settled class, or a px pin from its own expand/flip)
      // is at rest; only the flip-from-streaming case (inline 'none') and a
      // never-pinned panel take the pin.
      const inlineMaxHeight = String(panel.style.maxHeight || '');
      const settled = panel.classList.contains(thinkingPanelSettleUtils.SETTLED_CLASS || 'reasoning-row-panel--settled');
      if (inlineMaxHeight !== 'none' && (settled || inlineMaxHeight !== '')) return;
      panel.style.maxHeight = `${Math.max(panel.scrollHeight || 0, panel.offsetHeight || 0)}px`;
      // The flip-to-complete pin above is a single scrollHeight snapshot: if
      // layout/fonts settle late, or the panel reflows afterward (e.g. a dock
      // resize), that pinned px can land short and clip the last text line.
      // Settle to max-height:none shortly after so late reflow can't clip a
      // resting panel (see renderer-thinking-panel-settle-utils.js).
      const win = (panel.ownerDocument && panel.ownerDocument.defaultView) || windowRef;
      const cleanup = thinkingPanelSettleUtils.armThinkingPanelSettle?.(panel, {
        transitionMs: readSettleDelayMs(win, panel.ownerDocument),
        onCleanup: () => settleCleanups.delete(cleanup),
      });
      if (cleanup) settleCleanups.add(cleanup);
    }

    function commitFullRender(options) {
      if (disposed) return;
      const nextOptions = options || {};
      replayReasoningHandoff();
      runtime.lastThinkingMarkup = '';
      runtime.lastThinkingMarkupKey = '';
      runtime.lastMessageThinkingMarkup = '';
      runtime.lastMessageThinkingMarkupKey = '';
      runtime.sessionId = String(nextOptions.currentSessionId || '');
      runtime.structureSignature = nextOptions.structureSignature != null ? nextOptions.structureSignature : 0;
      const streamingMessage = nextOptions.streamingMessage !== undefined
        ? nextOptions.streamingMessage
        : getStreamingMessage(nextOptions.messages, nextOptions.latestAssistantMessageId);
      runtime.streamingRowTarget = normalizeStreamingRowTarget(nextOptions.streamingRowTarget);
      runtime.activeTurnRootMessageId = String(nextOptions.activeTurnRootMessageId || '');
      runtime.activeTurnStructureHash = Number(nextOptions.activeTurnStructureHash) || 0;
      runtime.activeTurnTailFingerprint = String(nextOptions.activeTurnTailFingerprint || '');
      if (!streamingMessage) {
        // Sweep, not clear: clearStreamingArticleMarker reaches only the ONE
        // article its own resolver finds, and a turn that moved between
        // segments can be holding several markers.
        sweepStreamingArticleMarkers(chatTimeline, null);
        runtime.streamingMessageId = '';
        runtime.streamingArticleMessageId = '';
        runtime.streamingRowTarget = null;
        runtime.previousUnits = [];
      } else {
        runtime.streamingMessageId = String(streamingMessage.id || '');
        runtime.streamingArticleMessageId = String(
          nextOptions.streamingArticleMessageId || streamingMessage.id || ''
        );
        // Sweeps the previous segment marker and re-stamps the live one in a
        // single step, so the marker can never be both stale and present.
        anchorStreamingArticleMarker(runtime, chatTimeline);
      }
      reasoningHandoff.rememberById(streamingMessage ? runtime.streamingArticleMessageId : '');
    }

    // One predicate, one vocabulary: the boolean gate and the reason string it
    // reports are the SAME comparison ladder. Kept as two ladders they drift
    // silently -- a fifth comparand added here would block renders that the
    // telemetry then charges to nothing.
    function canPatchMessage(options) {
      const nextOptions = options || {};
      const streamingMessage = nextOptions.streamingMessage !== undefined
        ? nextOptions.streamingMessage
        : getStreamingMessage(nextOptions.messages, nextOptions.latestAssistantMessageId);
      return describePatchBlock({ ...nextOptions, streamingMessage }) === '';
    }

    function queuePatch(options) {
      // The patch applies synchronously. renderMessages is already rAF-batched
      // by the render queue, so a third deferral layer here only added a frame
      // of lag — and worse, the deferred patch could be cancelled by a later
      // commitFullRender/resetState before ever painting, which is how the last
      // deltas of a burst stayed invisible until the turn completed.
      if (disposed) return;
      runtime.streamingRowTarget = normalizeStreamingRowTarget(options?.streamingRowTarget);
      const patchOptions = options;
      if (!patchOptions) {
        return;
      }

      const message = patchOptions.streamingMessage !== undefined
        ? patchOptions.streamingMessage
        : getStreamingMessage(patchOptions.messages, patchOptions.latestAssistantMessageId);
      if (!message || !chatTimeline) {
        if (typeof patchOptions.onFallback === 'function') {
          patchOptions.onFallback(message ? 'no_timeline' : 'no_streaming_message');
        }
        return;
      }

      const patchTarget = resolveStreamingPatchTarget(runtime, chatTimeline);
      const article = resolvePatchTargetArticle(patchTarget)
        || (patchTarget ? resolveStreamingArticlePatchTarget(runtime, chatTimeline) : null);
      if (!article) {
        if (typeof patchOptions.onFallback === 'function') {
          patchOptions.onFallback('no_article');
        }
        return;
      }

      if (
        patchTarget
        && patchTarget !== article
        && typeof patchOptions.buildRowNodeMarkup === 'function'
      ) {
        const rowMarkup = String(patchOptions.buildRowNodeMarkup() || '').trim();
        if (rowMarkup) {
          setOuterHtmlPreservingCodeScroll(patchTarget, rowMarkup);
        }
      }

      const patchModel = patchOptions.buildMessageNodeState(message, patchOptions.messages, patchOptions.latestAssistantMessageId);

      // Pretext streaming height prediction: prepare accumulated text and
      // store the prediction on the patch model for scroll anchoring.
      const _pretextUtils = typeof rendererPretextUtils !== 'undefined' ? rendererPretextUtils : null;
      if (_pretextUtils && _pretextUtils.isEnabled(patchOptions.state || {})) {
        const content = String(message.content || '');
        if (content) {
          const bubble = article.querySelector('[data-streaming-bubble="true"]') || article.querySelector('.chat-bubble');
          const font = (bubble ? _pretextUtils.resolveFontString(bubble) : null)
            || _pretextUtils.resolveDefaultFontString('.chat-bubble');
          if (font) {
            const messageId = String(message.id || '');
            _pretextUtils.prepareStreaming(messageId, content, font);
            const contentColumn = chatTimeline ? chatTimeline.closest('.chat-thread-column') : null;
            const colWidth = _pretextUtils.resolveElementWidth(contentColumn) || 760;
            const prediction = _pretextUtils.layoutStreaming(messageId, colWidth, 15 * 1.6);
            if (prediction) {
              patchModel.predictedHeight = Math.ceil(prediction.height);
            }
          }
        }
      }

      // Targeted patch: update only the streaming bubble and thinking body,
      // preserving the thinking toggle/panel DOM to prevent hover flicker,
      // click failure, and max-height re-animation.
      //
      // A row-model turn-article interleaves EVERY segment's reasoning
      // stack; the first `.reasoning-row-stack` in the article belongs to
      // segment 0, so an article-wide first-match anchor mirrors the live
      // stream into the TOP of the turn on multi-segment turns. Scope the
      // reasoning patch to the LIVE segment's reasoning row (source-id or
      // source-id-list match, falling back to the last stack — segments
      // append in order). Legacy single-message articles keep the article
      // scope unchanged.
      const rowModelList = article.querySelector('[data-turn-row-list="true"]');
      const segmentScope = rowModelList
        ? streamPatchTargetUtils.resolveLiveReasoningScope(rowModelList, message.id, escapeSelectorValue)
        : article;
      let patchedSurgically = false;
      const existingBubble = article.querySelector('[data-streaming-bubble="true"]');
      const hasMessageThinkingMarkup = Object.prototype.hasOwnProperty.call(patchModel, 'thinkingMarkup');
      // Owner-gated assumption: no row-only state changes while message-level thinking markup is equal.
      const reuseReasoning = hasMessageThinkingMarkup
        && runtime.lastMessageThinkingMarkupKey === runtime.streamingMessageId
        && runtime.lastMessageThinkingMarkup === patchModel.thinkingMarkup
        && segmentScope.querySelector('.reasoning-row-stack');
      let reasoningPatch;
      const liveStackDiagnostics = { reason: '' };
      if (reuseReasoning) {
        reasoningPatch = { patched: true, requiresFullFallback: false, hasThinkingMarkup: true, reason: 'message_stack_unchanged' };
      } else {
        const rowStackMarkup = streamPatchTargetUtils.buildLiveReasoningRowStackMarkup({
          scope: segmentScope, rowModelList, messageId: message.id,
          buildLiveReasoningRowsMarkup: patchOptions.buildLiveReasoningRowsMarkup, doc: article.ownerDocument,
          diagnostics: liveStackDiagnostics,
        });
        reasoningPatch = patchReasoningStack(segmentScope, rowStackMarkup == null
          ? patchModel : { thinkingMarkup: rowStackMarkup }, article.ownerDocument, rowModelList);
        if (hasMessageThinkingMarkup && reasoningPatch.patched) {
          runtime.lastMessageThinkingMarkup = patchModel.thinkingMarkup;
          runtime.lastMessageThinkingMarkupKey = runtime.streamingMessageId;
        }
      }
      const needsReasoningOnlyStructuralFallback = reasoningPatch.requiresFullFallback
        && reasoningPatch.hasThinkingMarkup
        && !existingBubble
        && patchModel.bubbleInnerHtml == null
        && !article.querySelector('.reasoning-row-stack');

      // The bail-out name for the row-list morph below, prefixed with the
      // live-stack helper's reason when it declined. client_timing keeps 64
      // chars per key: the longest composite here is 62.
      let fallbackReason = 'not_surgical';
      const nameFallback = (reason) => {
        fallbackReason = liveStackDiagnostics.reason
          ? `live:${liveStackDiagnostics.reason}>${reason}`
          : reason;
      };
      if (existingBubble && patchModel.bubbleInnerHtml != null) {
        // Case A: bubble exists and has new content — patch at stream-unit
        // level to avoid destroying and recreating unchanged DOM nodes.
        patchBubbleUnits(existingBubble, patchModel, article.ownerDocument);
        patchedSurgically = !reasoningPatch.requiresFullFallback;
        if (!patchedSurgically) nameFallback(`bubble:${reasoningPatch.reason}`);
      } else if (
        needsReasoningOnlyStructuralFallback
        && typeof patchOptions.onFallback === 'function'
      ) {
        patchOptions.onFallback('reasoning_structural');
        return;
      } else if (!existingBubble && patchModel.bubbleInnerHtml == null) {
        // Case B: reasoning-only delta — no bubble expected, none exists.
        // Only mark as surgical when the reasoning stack actually accepted
        // the patch; otherwise fall through to the structural fallback.
        patchedSurgically = reasoningPatch.hasThinkingMarkup
          ? reasoningPatch.patched && !reasoningPatch.requiresFullFallback
          : Boolean(article.querySelector('.reasoning-row-stack'));
        if (!patchedSurgically) {
          nameFallback(reasoningPatch.hasThinkingMarkup ? reasoningPatch.reason : 'no_reasoning_stack');
        }
      } else if (!existingBubble && patchModel.bubbleInnerHtml != null) {
        // Case C: content just appeared — insert a streaming bubble after
        // the reasoning stack, for legacy single-message articles only. A
        // row-model turn opens the answer as its own assistant_text row:
        // that is structural, so the keyed row-list morph below builds it.
        // A bubble inserted here would sit inside the reasoning row and
        // stream there until the terminal render popped the real row in.
        const anchor = rowModelList ? null : segmentScope.querySelector('.reasoning-row-stack');
        if (anchor && !reasoningPatch.requiresFullFallback) {
          streamDomPatchUtils.noteRowSubtreeWrite?.(anchor);
          const newBubble = article.ownerDocument.createElement('div');
          Object.assign(newBubble, { className: 'chat-bubble chat-bubble-markdown chat-bubble-streaming', dir: 'auto' });
          newBubble.setAttribute('data-streaming-bubble', 'true');
          newBubble.innerHTML = patchModel.bubbleInnerHtml;
          anchor.after(newBubble);
          patchedSurgically = true;
        } else {
          nameFallback(rowModelList ? 'answer_row_open' : (anchor ? `anchor:${reasoningPatch.reason}` : 'no_anchor'));
        }
      } else {
        // Case D: reasoning-only delta with a streaming bubble present (think-
        // answer-think). The bubble is unchanged; the stack decides, as in B.
        patchedSurgically = reasoningPatch.hasThinkingMarkup
          ? reasoningPatch.patched && !reasoningPatch.requiresFullFallback
          : Boolean(article.querySelector('.reasoning-row-stack'));
        if (!patchedSurgically) {
          nameFallback(`bubble_idle:${reasoningPatch.hasThinkingMarkup ? reasoningPatch.reason : 'no_reasoning_stack'}`);
        }
      }

      if (reasoningPatch.patched) {
        syncExpandedThinkingPanelHeight(segmentScope);
      }

      if (!patchedSurgically) {
        // A row-model article must NEVER be overwritten with the legacy
        // single-message innerHtml — that deletes every other segment's
        // rows (tool cards, settled text) until the next full render.
        // Render fully NOW via onFallback: deferring to the next frame
        // silently swallows the delta when it is the turn's last (the
        // onAfterPatch below would still commit the render signature, so
        // nothing repaints until settle). Deferral only as a last resort.
        if (rowModelList) {
          // Reconcile the row list by key (per row when the builder supplies
          // segments, else the whole-list keyed morph) rather than charging a
          // full transcript render: settled rows stay in place and Case A's
          // bubble work is kept. The 2026-08-25 flicker charged 526 of one
          // turn's 606 deltas a full render on top of a correct paint.
          // 'no_row_list_markup' means nothing was applied, so an inert morph
          // stays distinguishable from a failed one in the codes below.
          const fallback = applyRowListFallback(rowModelList, {
            segmentsResult: typeof patchOptions.buildTurnRowListSegments === 'function'
              ? patchOptions.buildTurnRowListSegments()
              : null,
            buildMarkup: patchOptions.buildTurnRowListMarkup,
            collectStats: true,
          });
          const { morphed, rowListMarkup } = fallback;
          recordTimelineDomWrite(String(patchOptions.currentSessionId || ''), 'turn_row_list', fallback.outcome, fallback.stats);
          // Always-on (flag-free) cost record: which rows this fallback rebuilt.
          streamClientMetrics?.noteRowListMorph?.(readSessionId(), {
            reason: fallbackReason,
            rowsReused: fallback.rowsReused,
            rowsRebuilt: fallback.rowsRebuilt,
          });
          if (morphed) replayReasoningHandoff();
          if (!morphed) {
            // Name the bail-out. An anonymous fallback hid the flicker this
            // replaces for months; the reason code is what makes a silently
            // inert morph (no markup supplied) distinguishable from a real
            // morph failure in the next turn's full_render_reasons.
            if (typeof patchOptions.onFallback === 'function') {
              patchOptions.onFallback(rowListMarkup
                ? 'row_model_morph_failed'
                : 'row_model_no_row_list_markup');
            }
            return;
          }
        } else {
          setInnerHtmlPreservingCodeScroll(article, patchModel.innerHtml);
        }
      }

      article.classList.toggle('pending', Boolean(patchModel.pending));
      turnShellUtils.syncChatEntryCvExemptAttribute?.(article, { pending: Boolean(patchModel.pending) });
      article.dataset.messageStatus = patchModel.status;
      article.dataset.finalizedAt = patchModel.finalizedAt;
      // Through the single writer: this runs on EVERY delta, so a bare stamp
      // here would re-create a duplicate marker the moment the resolver
      // drifted, undoing the sweep commitFullRender had just done.
      stampStreamingArticleMarker(article, runtime.streamingMessageId, chatTimeline);
      reasoningHandoff.remember(article);

      runtime.sessionId = String(patchOptions.currentSessionId || '');
      runtime.structureSignature = patchOptions.structureSignature ?? 0;

      if (typeof patchOptions.onAfterPatch === 'function') {
        patchOptions.onAfterPatch(patchOptions.messages, {
          messageId: String(message.id || ''),
          predictedHeight: patchModel.predictedHeight,
        });
      }
    }

    function patchActiveTurnRoot(options) {
      const nextOptions = options || {};
      const currentSessionId = String(nextOptions.currentSessionId || '');
      const activeTurnRootMessageId = String(nextOptions.activeTurnRootMessageId || '').trim();
      if (!chatTimeline || !currentSessionId || runtime.sessionId !== currentSessionId || !activeTurnRootMessageId) {
        return false;
      }
      const expectedRootOrder = Array.isArray(nextOptions.expectedRootOrder)
        ? nextOptions.expectedRootOrder.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      if (expectedRootOrder.length) {
        const actualRootOrder = Array.from(chatTimeline.children)
          .map((node) => String(node?.getAttribute?.('data-thread-message-id') || '').trim())
          .filter(Boolean);
        if (
          actualRootOrder.length !== expectedRootOrder.length
          || actualRootOrder.some((value, index) => value !== expectedRootOrder[index])
        ) {
          return false;
        }
      }
      const rootNode = chatTimeline.querySelector(
        `[data-thread-message-id="${escapeSelectorValue(activeTurnRootMessageId)}"]`
      );
      if (!rootNode || rootNode.parentElement !== chatTimeline) {
        return false;
      }
      const nextTurnStructureHash = Number(nextOptions.turnStructureHash) || 0;
      const nextTurnTailFingerprint = String(nextOptions.turnTailFingerprint || '');
      if (
        runtime.activeTurnRootMessageId === activeTurnRootMessageId
        && runtime.activeTurnStructureHash === nextTurnStructureHash
        && runtime.activeTurnTailFingerprint === nextTurnTailFingerprint
      ) {
        runtime.structureSignature = nextOptions.structureSignature != null ? nextOptions.structureSignature : runtime.structureSignature;
        return true;
      }
      const buildTurnRootMarkup =
        typeof nextOptions.buildTurnRootMarkup === 'function'
          ? nextOptions.buildTurnRootMarkup
          : null;
      if (!buildTurnRootMarkup) {
        return false;
      }
      let nextMarkup;
      try {
        nextMarkup = String(buildTurnRootMarkup() || '').trim();
      } catch (_error) {
        return false;
      }
      if (!nextMarkup) {
        return false;
      }
      // Render-path telemetry (Track A): per-rebuild-granularity diagnostics
      // only on the path that actually commits a rebuild (the no-op
      // short-circuit above already returned).
      const priorIdentity = {
        root: runtime.activeTurnRootMessageId,
        hash: runtime.activeTurnStructureHash,
        tail: runtime.activeTurnTailFingerprint,
      };
      // The host article's turn row list (when the builder names one) reconciles per row.
      const rowList = typeof nextOptions.resolveRowListSegments === 'function' ? nextOptions.resolveRowListSegments() : null;
      const patchResult = setOuterHtmlPreservingCodeScroll(rootNode, nextMarkup, {
        collectStats: true, rowListSegments: rowList?.segments, rowListHostId: rowList?.hostId,
      });
      replayReasoningHandoff();
      reasoningHandoff.rememberById(runtime.streamingArticleMessageId);
      runtime.sessionId = currentSessionId;
      runtime.structureSignature = nextOptions.structureSignature != null ? nextOptions.structureSignature : runtime.structureSignature;
      runtime.activeTurnRootMessageId = activeTurnRootMessageId;
      runtime.activeTurnStructureHash = nextTurnStructureHash;
      runtime.activeTurnTailFingerprint = nextTurnTailFingerprint;
      const rootChanged = priorIdentity.root !== activeTurnRootMessageId;
      const hashChanged = priorIdentity.hash !== nextTurnStructureHash;
      const tailChanged = priorIdentity.tail !== nextTurnTailFingerprint;
      // A new turn's first rebuild reaches here with prior* carried from the
      // PREVIOUS turn, so the hash/tail deltas are cross-turn noise — label it
      // root_switch rather than mislabeling it structure_hash/both.
      const reason = rootChanged
        ? 'root_switch'
        : (hashChanged && tailChanged ? 'both' : (hashChanged ? 'structure_hash' : 'tail_fingerprint'));
      const stats = patchResult.stats || { reused: 0, cloned: 0, removed: 0 };
      recordChatTimelineRolloutSignal(currentSessionId, 'active_turn_root_rebuild', {
        turnId: activeTurnRootMessageId,
        reason,
        priorRoot: priorIdentity.root,
        priorHash: priorIdentity.hash,
        nextHash: nextTurnStructureHash,
        priorTail: priorIdentity.tail,
        nextTail: nextTurnTailFingerprint,
        outcome: patchResult.outcome,
        reused: stats.reused,
        cloned: stats.cloned,
        removed: stats.removed,
      });
      recordTimelineDomWrite(currentSessionId, 'active_turn_root', patchResult.outcome, patchResult.stats);
      return true;
    }

    function updateTailState(domContributingMessages, tailFingerprintFn) {
      const count = Array.isArray(domContributingMessages) ? domContributingMessages.length : 0;
      runtime.previousDomCount = count;
      runtime.previousTailFingerprint = count > 0 && typeof tailFingerprintFn === 'function'
        ? tailFingerprintFn(domContributingMessages[count - 1])
        : '';
    }

    return {
      dispose() {
        disposed = true;
        for (const cleanup of settleCleanups) cleanup();
        settleCleanups.clear();
        reasoningHandoff.dispose?.();
        resetState();
      },
      resetState,
      buildTimelineStructureSignature,
      buildStreamingBubbleMarkup,
      commitFullRender,
      replayReasoningHandoff,
      canPatchMessage,
      describePatchBlock,
      stampStreamingArticleMarker,
      resolveStreamingPatchTarget,
      queuePatch,
      patchActiveTurnRoot,
      updateTailState,
    };
  }

  return {
    createStreamRevealController,
    settleVisibleStreamAffordances,
    captureCodeBlockScroll,
    describeDomWrite,
    restoreCodeBlockScroll,
    setChildrenHtmlPreservingKeyedNodes,
    setInnerHtmlPreservingCodeScroll,
  };
});
