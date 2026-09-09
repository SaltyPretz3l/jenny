/**
 * Context token usage indicator — ambient composer ring rendered through the
 * inventory chip primitive. State and estimation live in the sibling model.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-context-usage-model'));
    return;
  }
  root.rendererContextUsageUtils = factory(root.rendererContextUsageModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  if (!model || typeof model.createContextUsageStore !== 'function') {
    throw new Error('renderer-context-usage-utils requires renderer-context-usage-model');
  }

  var store = model.createContextUsageStore();
  var lastRingUsage = new Map();
  var RING_WARNING_THRESHOLD = 0.8;
  var RING_DANGER_THRESHOLD = 0.95;
  var RING_RADIUS = 8;
  var RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function formatTokenCount(value) {
    var count = Math.max(Number(value || 0), 0);
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return String(Math.floor(count));
  }

  function formatMessageTokenMeta(meta) {
    var data = meta || {};
    var messageTokens = model.normalizePositiveInteger(data.messageTokens);
    var cumulativeTokens = model.normalizePositiveInteger(data.cumulativeTokens);
    var parts = [];
    if (data.wholeTurn) return jt('chat.contextUsage.visibleTurnTokenEstimate', '~{count} visible-reply tokens est. (whole turn)', { count: formatTokenCount(messageTokens) });
    if (messageTokens > 0) parts.push(jt('chat.contextUsage.messageTokenEstimate', '~{count} tokens est.', { count: formatTokenCount(messageTokens) }));
    if (cumulativeTokens > 0) parts.push(jt('chat.contextUsage.cumulativeTextEstimate', '~{count} cumulative text tokens est.', { count: formatTokenCount(cumulativeTokens) }));
    return parts.join(' · ');
  }

  function combineMessageMetaLabels(primaryLabel, tokenLabel) {
    var primary = String(primaryLabel || '').trim();
    var token = String(tokenLabel || '').trim();
    if (primary && token) return primary + ' · ' + token;
    return primary || token;
  }

  function updateUsage(sessionId, payload) {
    return store.updateUsage(sessionId, payload);
  }

  function updateCompactionUsage(sessionId, result, metadata) {
    return store.updateCompactionUsage(sessionId, result, metadata);
  }

  function getUsage(sessionId) {
    return store.getUsage(sessionId);
  }

  function clearUsage(sessionId) {
    var key = String(sessionId || '').trim();
    store.clearUsage(key);
    lastRingUsage.delete(key);
  }

  function clearAllUsage() {
    store.clearAllUsage();
    lastRingUsage.clear();
  }

  function pruneUsage(options) {
    var before = new Set(lastRingUsage.keys());
    var removed = store.pruneUsage(options);
    for (var sessionId of before) {
      if (!store.getUsage(sessionId)) lastRingUsage.delete(sessionId);
    }
    return removed;
  }

  function buildContextUsageEstimate(messages, options) {
    return model.buildContextUsageEstimate(messages, options);
  }

  function buildCachedContextUsageEstimate(sessionId, messages, options) {
    return store.buildCachedEstimate(sessionId, messages, options);
  }

  function contextPercentValue(usedTokens, denominatorTokens) {
    var limit = Number(denominatorTokens || 0);
    if (!(limit > 0)) return null;
    var raw = (Number(usedTokens || 0) / limit) * 100;
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.min(100, Math.round(raw));
  }

  function formatContextPercent(usedTokens, denominatorTokens) {
    var limit = Number(denominatorTokens || 0);
    var used = Number(usedTokens || 0);
    if (!(limit > 0) || !(used >= 0)) return '';
    var raw = (used / limit) * 100;
    if (!Number.isFinite(raw) || raw < 0) return '';
    if (raw > 0 && raw < 1) return '<1%';
    return Math.min(100, Math.round(raw)) + '%';
  }

  function isRenderableUsageData(data, options) {
    return Boolean(
      data
      && model.normalizePositiveInteger(data.usedTokens) > 0
      && model.resolveContextTarget(data, options).limit > 0
    );
  }

  function isAuthoritativeUsageSource(source) {
    var normalized = String(source || '').trim();
    return normalized === 'provider' || normalized === 'context';
  }

  function storedMatchesActiveModel(stored, activeModel) {
    var active = String(activeModel || '').trim().toLowerCase();
    var storedModel = String(stored && stored.model || '').trim().toLowerCase();
    return !active || !storedModel || storedModel === active;
  }

  function resolveRenderUsage(sessionId, options) {
    var opts = options || {};
    var stored = store.getUsage(sessionId);
    var fallbackEstimate = opts.fallbackEstimate || null;
    if (
      isRenderableUsageData(stored, opts)
      && isAuthoritativeUsageSource(stored.usageSource)
      && storedMatchesActiveModel(stored, opts.activeModel)
    ) {
      return stored;
    }
    if (
      isRenderableUsageData(stored, opts)
      && stored.usageSource === 'compaction'
      && storedMatchesActiveModel(stored, opts.activeModel)
      && (!isRenderableUsageData(fallbackEstimate, opts) || fallbackEstimate.usageSource !== 'compaction')
    ) {
      return stored;
    }
    if (isRenderableUsageData(fallbackEstimate, opts)) return fallbackEstimate;
    return stored;
  }

  function classifyContextSeverity(ratio) {
    var normalized = Number(ratio);
    if (!Number.isFinite(normalized)) return '';
    if (normalized >= RING_DANGER_THRESHOLD) return 'danger';
    if (normalized >= RING_WARNING_THRESHOLD) return 'warning';
    return '';
  }

  function sourceLabel(source) {
    if (source === 'provider') return jt('chat.contextUsage.lastRequest', 'last request');
    if (source === 'context') return jt('chat.contextUsage.estimatedLastRequest', 'est. last request');
    if (source === 'compaction') return jt('chat.contextUsage.estimatedCompactedHistory', 'est. compacted history');
    return 'est. context';
  }

  function describeContextUsage(sessionId, options) {
    var opts = options || {};
    var data = resolveRenderUsage(sessionId, opts);
    if (!isRenderableUsageData(data, opts)) return null;
    var used = model.normalizePositiveInteger(data.usedTokens);
    var target = model.resolveContextTarget(data, opts);
    var ratio = Math.max(0, Math.min(1, used / target.limit));
    return {
      used: used,
      limit: target.limit,
      ratio: ratio,
      severity: classifyContextSeverity(ratio),
      percent: contextPercentValue(used, target.limit),
      percentLabel: formatContextPercent(used, target.limit),
      source: String(data.usageSource || ''),
      sourceLabel: sourceLabel(String(data.usageSource || '')),
      targetType: target.type,
      targetExact: target.exact === true,
    };
  }

  function buildDetailText(summary) {
    var usedLabel = formatTokenCount(summary.used);
    var limitLabel = formatTokenCount(summary.limit);
    var remainingLabel = formatTokenCount(Math.max(summary.limit - summary.used, 0));
    var lines = ['Context: ' + summary.percentLabel];
    if (summary.targetType === 'auto_compact') {
      lines.push(
        jt('chat.contextUsage.tokensBeforeAutoCompact', '{used} of {limit} tokens before auto-compact ({source})', { used: usedLabel, limit: limitLabel, source: summary.sourceLabel })
      );
      lines.push(remainingLabel + ' remaining');
      if (summary.severity === 'danger') lines.push(jt('chat.contextUsage.autoCompactionImminent', 'Nearly full — auto-compaction is imminent.'));
      else if (summary.severity === 'warning') lines.push(jt('chat.contextUsage.approachingAutoCompaction', 'Approaching auto-compaction.'));
    } else {
      lines.push(
        jt('chat.contextUsage.tokenContextWindow', '{used} of {limit} token context window ({source})', { used: usedLabel, limit: limitLabel, source: summary.sourceLabel })
      );
      lines.push(jt('chat.contextUsage.remainingInWindow', '{count} remaining in window', { count: remainingLabel }));
      if (summary.severity === 'danger') lines.push(jt('chat.contextUsage.windowNearlyFull', 'Context window is nearly full.'));
      else if (summary.severity === 'warning') lines.push(jt('chat.contextUsage.windowFillingUp', 'Context window is filling up.'));
    }
    return lines.join('\n');
  }

  function renderContextUsage(sessionId, options) {
    var opts = options || {};
    var summary = describeContextUsage(sessionId, opts);
    if (!summary) return '';
    var inventory = typeof globalThis !== 'undefined' ? globalThis.inventory : null;
    var chip = inventory && inventory.chip;
    var popover = inventory && inventory.popover;
    var actionButton = inventory && inventory.actionButton;
    if (!chip) return '';

    var displayText = formatTokenCount(summary.used)
      + ' / ' + formatTokenCount(summary.limit)
      + ' ' + summary.sourceLabel
      + ' · ' + summary.percentLabel;
    var key = String(sessionId || '').trim();
    var previous = lastRingUsage.get(key);
    var usageChanged = key && previous !== summary.used;
    var pulse = summary.severity === 'danger' && usageChanged;
    var warnPulse = summary.severity === 'warning' && usageChanged;
    if (key) lastRingUsage.set(key, summary.used);

    var arc = (summary.ratio * RING_CIRCUMFERENCE).toFixed(2);
    var svg = '<svg class="inv-context-ring-svg" viewBox="0 0 20 20" aria-hidden="true" focusable="false">'
      + '<circle class="inv-context-ring-track" cx="10" cy="10" r="' + RING_RADIUS + '"/>'
      + '<circle class="inv-context-ring-arc" cx="10" cy="10" r="' + RING_RADIUS + '"'
      + ' stroke-dasharray="' + arc + ' ' + RING_CIRCUMFERENCE.toFixed(2) + '"/>'
      + '</svg>';
    var ringClass = 'inv-context-ring'
      + (summary.severity ? ' inv-context-ring--' + summary.severity : '')
      + (pulse ? ' inv-context-ring--pulse' : '')
      + (warnPulse ? ' inv-context-ring--warn-pulse' : '');

    return '<div class="inv-context-usage inv-context-usage--ring">'
      + chip({
        id: 'composer-context-ring',
        domId: 'composerContextRing',
        iconHtml: svg,
        ariaLabel: jt('chat.contextUsage.ariaLabel', 'Context usage: {usage}', { usage: displayText }),
        title: buildDetailText(summary),
        hasPopup: Boolean(popover && actionButton),
        ariaControls: popover && actionButton ? 'composerContextDetailsPopover' : '',
        pressed: false,
        className: ringClass,
      })
      + (popover && actionButton ? popover({
        id: 'composer-context-details',
        domId: 'composerContextDetailsPopover',
        ariaLabel: jt('chat.contextUsage.detailsAriaLabel', 'Context details'),
        className: 'inv-context-details-popover',
        trustedHtml: '<h3>' + escapeHtml(jt('chat.contextUsage.nextTurnSummary', 'Next turn context summary')) + '</h3>'
          + '<p data-next-turn-context-summary>' + escapeHtml(jt('chat.contextUsage.openToCalculate', 'Open to calculate from the canonical session.')) + '</p>'
          + '<h3>' + escapeHtml(jt('chat.contextUsage.lastCompletedRequest', 'Last completed request')) + '</h3>'
          + '<p>' + escapeHtml(buildDetailText(summary)).replace(/\n/g, '<br>') + '</p>'
          + (opts.manualCompactionEnabled === true
            ? '<div class="inv-context-details-actions">' + actionButton({
              id: 'context-meter-compact',
              label: opts.compactionActivity?.pending ? jt('chat.contextUsage.compacting', 'Compacting…') : jt('chat.contextUsage.compactNow', 'Compact now'),
              variant: 'secondary',
              disabled: opts.compactionActivity?.pending === true,
              title: jt('chat.contextUsage.compactTitle', 'Compact the conversation now to free context'),
            }) + '</div>'
            : '')
          + '<p class="inv-context-details-status" aria-live="polite">'
          + escapeHtml(opts.compactionActivity?.message || '') + '</p>',
      }) : '')
      + '</div>';
  }

  return {
    updateUsage: updateUsage,
    updateCompactionUsage: updateCompactionUsage,
    getUsage: getUsage,
    clearUsage: clearUsage,
    clearAllUsage: clearAllUsage,
    pruneUsage: pruneUsage,
    invalidateEstimate: store.invalidateEstimate,
    renderContextUsage: renderContextUsage,
    describeContextUsage: describeContextUsage,
    resolveContextTarget: model.resolveContextTarget,
    isAuthoritativeUsageSource: isAuthoritativeUsageSource,
    storedMatchesActiveModel: storedMatchesActiveModel,
    formatTokenCount: formatTokenCount,
    estimateTextTokens: model.estimateTextTokens,
    estimateContextMessagesTokens: model.estimateContextMessagesTokens,
    selectContextEstimateMessages: model.selectContextEstimateMessages,
    buildMessageTokenMeta: model.buildMessageTokenMeta,
    formatMessageTokenMeta: formatMessageTokenMeta,
    combineMessageMetaLabels: combineMessageMetaLabels,
    buildContextUsageEstimate: buildContextUsageEstimate,
    buildCachedContextUsageEstimate: buildCachedContextUsageEstimate,
  };
});
