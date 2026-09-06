(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererToolMarkerUtils = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';

  const STUCK_LOOP_EVENTS = new Set([
    'agent.stopped_due_to_loop',
    'agent.stopped_loop',
    'agent.loop_stopped',
  ]);
  const ORPHAN_SOURCE = 'electron_orphan_repair';
  const TOOL_CANCELLED_EVENT = 'tool.cancelled';
  const BUDGET_EVENTS = new Set(['budget.exceeded', 'budget.limit_reached']);

  const escapeHtml = stringUtils.escapeHtml;
  const normString = stringUtils.normalizeString;

  function readPromotedObservations(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const observations = payload.promoted_observations;
    if (!Array.isArray(observations)) return [];
    return observations.filter((entry) => entry && typeof entry === 'object');
  }

  function summarizePromotedObservations(payload) {
    const observations = readPromotedObservations(payload);
    if (observations.length === 0) {
      return null;
    }
    let stuckLoop = null;
    let orphan = null;
    let budget = null;
    for (const obs of observations) {
      const eventType = normString(obs.event_type).toLowerCase();
      const source = normString(obs.source).toLowerCase();
      if (!stuckLoop && STUCK_LOOP_EVENTS.has(eventType)) {
        stuckLoop = obs;
        continue;
      }
      if (!orphan && eventType === TOOL_CANCELLED_EVENT && source === ORPHAN_SOURCE) {
        orphan = obs;
        continue;
      }
      if (!budget && BUDGET_EVENTS.has(eventType)) {
        budget = obs;
      }
    }
    if (!stuckLoop && !orphan && !budget) {
      return null;
    }
    return { stuckLoop, orphan, budget };
  }

  function buildBannerMarkup(kind, body) {
    const safeKind = escapeHtml(kind);
    return ''
      + '<div class="tool-marker-banner" data-marker-kind="' + safeKind + '" role="note">'
      + '<span class="tool-marker-banner-icon" aria-hidden="true"></span>'
      + '<span class="tool-marker-banner-body">' + body + '</span>'
      + '</div>';
  }

  function buildStuckLoopMarkup(observation) {
    const code = normString(observation.error_code).toUpperCase() || 'CMP-LOOP-0013';
    const summary = normString(observation.summary);
    return buildBannerMarkup(
      'stuck-loop',
      ''
        + '<span class="tool-marker-banner-title">Agent stopped — repeated tool pattern detected</span>'
        + '<span class="tool-marker-banner-detail">' + escapeHtml(code) + '</span>'
        + (summary
          ? '<span class="tool-marker-banner-meta" title="' + escapeHtml(summary) + '">'
            + escapeHtml(summary.length > 140 ? summary.slice(0, 137) + '...' : summary)
            + '</span>'
          : '')
    );
  }

  function buildOrphanMarkup(observation) {
    const code = normString(observation.error_code).toUpperCase() || 'CMP-LOOP-0013';
    const summary = normString(observation.summary);
    const terminalState = (function readTerminalState() {
      const tokens = summary.split(/\s+/);
      if (tokens.length >= 2 && tokens[0].toLowerCase() === 'orphaned_tool_call') {
        return tokens.slice(1).join(' ');
      }
      return summary;
    })();
    const detailHtml = terminalState
      ? '<span class="tool-marker-banner-detail">' + escapeHtml(terminalState) + '</span>'
      : '';
    return buildBannerMarkup(
      'orphan',
      ''
        + '<span class="tool-marker-banner-title">Tool was cancelled and recovered</span>'
        + detailHtml
        + '<span class="tool-marker-banner-meta">' + escapeHtml(code) + '</span>'
    );
  }

  function buildBudgetMarkup(observation) {
    const code = normString(observation.error_code).toUpperCase() || 'CMP-BUDGET-EXCEEDED';
    const summary = normString(observation.summary);
    return buildBannerMarkup(
      'budget',
      ''
        + '<span class="tool-marker-banner-title">Budget limit reached</span>'
        + '<span class="tool-marker-banner-detail">' + escapeHtml(code) + '</span>'
        + (summary ? '<span class="tool-marker-banner-meta">' + escapeHtml(summary) + '</span>' : '')
    );
  }

  function buildToolMarkerBannerMarkup(payload) {
    const summary = summarizePromotedObservations(payload);
    if (!summary) return '';
    const parts = [];
    if (summary.stuckLoop) parts.push(buildStuckLoopMarkup(summary.stuckLoop));
    if (summary.orphan) parts.push(buildOrphanMarkup(summary.orphan));
    if (summary.budget) parts.push(buildBudgetMarkup(summary.budget));
    return parts.join('');
  }

  function readOrphanCarryCount(payload) {
    if (!payload || typeof payload !== 'object') return 0;
    const candidates = [
      payload.orphaned_tool_call_count,
      payload.orphan_count,
      payload.count,
    ];
    if (Array.isArray(payload.orphaned_tool_call_ids)) {
      candidates.push(payload.orphaned_tool_call_ids.length);
    }
    if (Array.isArray(payload.tool_call_ids)) {
      candidates.push(payload.tool_call_ids.length);
    }
    for (const candidate of candidates) {
      const n = Number(candidate);
      if (Number.isFinite(n) && n > 0) {
        return Math.floor(n);
      }
    }
    return 0;
  }

  function buildOrphanCarryNoticeMarkup(payload) {
    const count = readOrphanCarryCount(payload);
    const phrase = count === 1
      ? '1 orphaned tool call was carried into a clean turn.'
      : (count > 1
        ? count + ' orphaned tool calls were carried into a clean turn.'
        : 'Orphaned tool calls were carried into a clean turn.');
    return ''
      + '<div class="system-notice-orphan-carry" role="note" data-orphan-count="' + escapeHtml(String(count)) + '">'
      + '<span class="system-notice-orphan-carry-icon" aria-hidden="true"></span>'
      + '<span class="system-notice-orphan-carry-body">' + escapeHtml(phrase) + '</span>'
      + '</div>';
  }

  return {
    summarizePromotedObservations,
    buildToolMarkerBannerMarkup,
    buildOrphanCarryNoticeMarkup,
  };
});
