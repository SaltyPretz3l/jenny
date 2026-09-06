(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../shared/async-fence'));
    return;
  }
  root.rendererContextMeterDetails = factory(root, root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, asyncFence) {
  'use strict';

  var POPOVER_MARGIN_PX = 12;
  var POPOVER_GAP_PX = 8;
  var previewGate = asyncFence.createGenerationGate();
  var positionedPopover = null;
  var positionedTrigger = null;
  var positionedWindow = null;

  function positiveNumber(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function computePopoverLayout(triggerRect, popoverRect, viewport, options) {
    var margin = positiveNumber(options?.margin, POPOVER_MARGIN_PX);
    var gap = positiveNumber(options?.gap, POPOVER_GAP_PX);
    var viewportLeft = positiveNumber(viewport?.left, 0);
    var viewportTop = positiveNumber(viewport?.top, 0);
    var viewportWidth = positiveNumber(viewport?.width, 0);
    var viewportHeight = positiveNumber(viewport?.height, 0);
    var viewportRight = viewportLeft + viewportWidth;
    var viewportBottom = viewportTop + viewportHeight;
    var triggerTop = positiveNumber(triggerRect?.top, viewportTop);
    var triggerBottom = positiveNumber(triggerRect?.bottom, triggerTop);
    var triggerRight = positiveNumber(triggerRect?.right, viewportLeft);
    var popoverWidth = positiveNumber(popoverRect?.width, 0);
    var popoverHeight = positiveNumber(popoverRect?.height, 0);
    var availableAbove = Math.max(triggerTop - viewportTop - margin - gap, 0);
    var availableBelow = Math.max(viewportBottom - triggerBottom - margin - gap, 0);
    var placeAbove = availableAbove >= availableBelow;
    var maxHeight = Math.floor(placeAbove ? availableAbove : availableBelow);
    var renderedHeight = Math.min(popoverHeight, maxHeight);
    var maxLeft = Math.max(viewportRight - margin - popoverWidth, viewportLeft + margin);
    var left = Math.min(Math.max(triggerRight - popoverWidth, viewportLeft + margin), maxLeft);
    var preferredTop = placeAbove
      ? triggerTop - gap - renderedHeight
      : triggerBottom + gap;
    var maxTop = Math.max(viewportBottom - margin - renderedHeight, viewportTop + margin);
    var top = Math.min(Math.max(preferredTop, viewportTop + margin), maxTop);
    return { left: left, top: top, maxHeight: maxHeight, placeAbove: placeAbove };
  }

  function handleViewportResize() {
    if (!positionedPopover?.isConnected || positionedPopover.hidden) return;
    positionPopover(positionedPopover, positionedTrigger);
  }

  function trackPositionTarget(popover, trigger) {
    var nextWindow = popover?.ownerDocument?.defaultView || null;
    if (positionedWindow !== nextWindow) {
      positionedWindow?.removeEventListener?.('resize', handleViewportResize);
      nextWindow?.addEventListener?.('resize', handleViewportResize);
      positionedWindow = nextWindow;
    }
    positionedPopover = popover;
    positionedTrigger = trigger;
  }

  function positionPopover(popover, trigger) {
    if (!popover || !trigger || popover.hidden
      || typeof popover.getBoundingClientRect !== 'function'
      || typeof trigger.getBoundingClientRect !== 'function') return false;
    var windowRef = popover.ownerDocument?.defaultView;
    if (!windowRef) return false;
    popover.style.maxHeight = '';
    popover.style.overflowY = '';
    var visualViewport = windowRef.visualViewport;
    var viewport = {
      left: positiveNumber(visualViewport?.offsetLeft, 0),
      top: positiveNumber(visualViewport?.offsetTop, 0),
      width: positiveNumber(visualViewport?.width, positiveNumber(windowRef.innerWidth, 0)),
      height: positiveNumber(visualViewport?.height, positiveNumber(windowRef.innerHeight, 0)),
    };
    var layout = computePopoverLayout(
      trigger.getBoundingClientRect(),
      popover.getBoundingClientRect(),
      viewport,
    );
    var offsetParentRect = popover.offsetParent?.getBoundingClientRect?.() || { left: 0, top: 0 };
    popover.style.right = 'auto';
    popover.style.bottom = 'auto';
    popover.style.left = Math.round(layout.left - positiveNumber(offsetParentRect.left, 0)) + 'px';
    popover.style.top = Math.round(layout.top - positiveNumber(offsetParentRect.top, 0)) + 'px';
    popover.style.maxHeight = Math.max(layout.maxHeight, 0) + 'px';
    popover.style.overflowY = 'auto';
    trackPositionTarget(popover, trigger);
    return true;
  }

  function boundedCount(value, maximum) {
    var count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) return 0;
    return Math.min(count, maximum);
  }

  function formatSummary(summary) {
    if (!summary || summary.status !== 'estimated') {
      return 'Next-turn estimate is unavailable.';
    }
    var scope = summary.history_scope === 'recent' ? 'Last 6 turns'
      : summary.history_scope === 'fresh' ? 'New prompt only' : 'Full session';
    var categories = summary.context_categories || {};
    var enabled = [];
    if (categories.personality) enabled.push('personality');
    if (categories.approved_memory) enabled.push('approved memory');
    if (categories.git) enabled.push('git');
    if (categories.codebase) enabled.push('codebase');
    if (categories.active_file) enabled.push('active file');
    if (categories.mentions) enabled.push('mentions');
    var attachmentCount = boundedCount(categories.attachments, 64);
    var historyCount = boundedCount(summary.history_message_count, 1000000);
    var availableCount = boundedCount(summary.available_history_message_count, 1000000);
    if (attachmentCount > 0) enabled.push(attachmentCount + ' attachment(s)');
    var narrowing = summary.automatic_narrowing
      ? ' Automatic narrowing will omit ' + Math.max(0, availableCount - historyCount) + ' older message(s).'
      : '';
    return scope + ': ' + historyCount + ' history message(s). '
      + (enabled.length ? 'Additional context planned: ' + enabled.join(', ') + '.' : 'No optional context is planned.')
      + (summary.compaction_snapshot_present ? ' A bounded compacted snapshot may replace its covered prefix.' : '')
      + narrowing;
  }

  async function loadPreview(popover, state) {
    var sessionId = String(state?.currentSessionId || '').trim();
    var output = popover?.querySelector?.('[data-next-turn-context-summary]');
    if (!sessionId || !output) return;
    previewGate.bump();
    var previewToken = previewGate.capture();
    output.dataset.contextPreviewPending = 'true';
    output.textContent = 'Calculating from the canonical session…';
    try {
      var queuedAttachments = Array.isArray(state?.attachments?.queued) ? state.attachments.queued : [];
      var mentionPaths = root?.rendererIdeMentionAutocomplete?.collectMentionPaths?.();
      var summary = await root?.jennyShell?.chat?.getNextTurnContextSummary?.(sessionId, {
        attachment_count: Math.min(queuedAttachments.length, 64),
        has_active_file: root?.rendererIdeActiveFileContext?.isArmed?.() === true,
        has_mentions: Array.isArray(mentionPaths) && mentionPaths.length > 0,
      });
      if (!previewGate.isCurrent(previewToken) || !output.isConnected
        || String(state?.currentSessionId || '').trim() !== sessionId) return;
      output.textContent = formatSummary(summary);
      delete output.dataset.contextPreviewPending;
      positionPopover(popover, popover.__invPopoverTrigger);
    } catch (_error) {
      if (previewGate.isCurrent(previewToken) && output.isConnected
        && String(state?.currentSessionId || '').trim() === sessionId) {
        output.textContent = 'Next-turn estimate is unavailable.';
        delete output.dataset.contextPreviewPending;
        positionPopover(popover, popover.__invPopoverTrigger);
      }
    }
  }

  function handleClick(options) {
    var event = options?.event;
    var composerWrap = options?.composerWrap;
    var state = options?.state;
    var target = event?.target;
    if (!target?.closest) return false;
    var compactButton = target.closest('[data-action="context-meter-compact"]');
    if (compactButton) {
      event.preventDefault();
      var sessionId = String(state?.currentSessionId || '').trim();
      if (sessionId && state?.compactionCoordinator?.invoke) {
        void state.compactionCoordinator.invoke(sessionId, { source: 'meter' });
      }
      return true;
    }
    var chip = target.closest('[data-inv-chip="composer-context-ring"]');
    if (!chip) return false;
    var tooltipApi = root?.inventory?.tooltip;
    tooltipApi?.unpin?.();
    tooltipApi?.hide?.();
    var popover = composerWrap?.ownerDocument?.getElementById?.('composerContextDetailsPopover');
    var popoverApi = root?.inventory?.popover;
    if (popover && popoverApi) {
      popoverApi.toggle(popover, { trigger: chip, restoreFocus: true });
      if (!popover.hidden) {
        positionPopover(popover, chip);
        void loadPreview(popover, state);
      }
    }
    return true;
  }

  function dispose() {
    previewGate.bump();
    positionedWindow?.removeEventListener?.('resize', handleViewportResize);
    positionedPopover = null;
    positionedTrigger = null;
    positionedWindow = null;
  }

  return {
    computePopoverLayout: computePopoverLayout,
    dispose: dispose,
    formatSummary: formatSummary,
    handleClick: handleClick,
    loadPreview: loadPreview,
    positionPopover: positionPopover,
  };
});
