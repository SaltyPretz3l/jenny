/* renderer/chat/renderer-chat-timeline-orientation-utils.js
 * F7: pure timeline orientation helpers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatTimelineOrientationUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_TIME_DIVIDER_GAP_MS = 5 * 60 * 1000;
  var MINUTE_MS = 60 * 1000;
  var HOUR_MS = 60 * MINUTE_MS;
  var DAY_MS = 24 * HOUR_MS;

  var SKIPPED_KINDS = new Set([
    'interactive_round_recap',
    'proactive_suggestion',
    'question_batch',
    'slash_command_output',
    'tool_result',
  ]);

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function parseMessageTimestampMs(message) {
    var raw = message && message.timestamp;
    if (raw == null || raw === '') {
      return null;
    }
    var parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function pluralUnit(value, singular) {
    return value === 1 ? singular : singular + 's';
  }

  function formatGap(gapMs) {
    var safeGapMs = Math.max(0, Number(gapMs) || 0);
    var value;
    var unit;
    if (safeGapMs >= DAY_MS) {
      value = Math.floor(safeGapMs / DAY_MS);
      unit = 'day';
      return {
        label: value + ' ' + unit + (value === 1 ? '' : 's') + ' later',
        ariaLabel: value + ' ' + pluralUnit(value, unit) + ' later',
      };
    }
    if (safeGapMs >= HOUR_MS) {
      value = Math.floor(safeGapMs / HOUR_MS);
      return {
        label: value + ' hr later',
        ariaLabel: value + ' ' + pluralUnit(value, 'hour') + ' later',
      };
    }
    value = Math.floor(safeGapMs / MINUTE_MS);
    return {
      label: value + ' min later',
      ariaLabel: value + ' ' + pluralUnit(value, 'minute') + ' later',
    };
  }

  function isEligibleTimelineNode(node) {
    if (!node || !node.message) {
      return false;
    }
    var id = normalizeId(node.message.id || node.id);
    if (!id) {
      return false;
    }
    var kind = normalizeId(node.message.kind || node.kind);
    if (kind && SKIPPED_KINDS.has(kind)) {
      return false;
    }
    var role = normalizeId(node.message.role || node.role);
    return role === 'user' || role === 'assistant';
  }

  function buildTimelineDividerInputSignature(messages) {
    var list = Array.isArray(messages) ? messages : [];
    return list.map(function mapTimestamp(message) {
      var timestampMs = parseMessageTimestampMs(message);
      return timestampMs == null ? '' : String(timestampMs);
    }).join('\u001f');
  }

  function walkNodes(nodes, visit, includeChildren) {
    var list = Array.isArray(nodes) ? nodes : [];
    for (var index = 0; index < list.length; index += 1) {
      var node = list[index];
      if (!node) {
        continue;
      }
      visit(node);
      if (Array.isArray(node.children) && node.children.length && includeChildren(node)) {
        walkNodes(node.children, visit, includeChildren);
      }
    }
  }

  function deriveTimelineTimeDividers(threadTree, options) {
    var settings = options || {};
    var gapMsThreshold = Number(settings.gapMs);
    if (!Number.isFinite(gapMsThreshold) || gapMsThreshold <= 0) {
      gapMsThreshold = DEFAULT_TIME_DIVIDER_GAP_MS;
    }
    var includeChildren = typeof settings.includeChildren === 'function'
      ? settings.includeChildren
      : function defaultIncludeChildren() { return true; };
    var dividers = [];
    var previous = null;
    walkNodes(threadTree && threadTree.roots, function visitNode(node) {
      if (!isEligibleTimelineNode(node)) {
        return;
      }
      var message = node.message || {};
      var id = normalizeId(message.id || node.id);
      var currentMs = parseMessageTimestampMs(message);
      if (currentMs == null) {
        previous = null;
        return;
      }
      if (previous && currentMs >= previous.timestampMs) {
        var gapMs = currentMs - previous.timestampMs;
        if (gapMs >= gapMsThreshold) {
          var formatted = formatGap(gapMs);
          dividers.push({
            beforeMessageId: id,
            previousMessageId: previous.messageId,
            gapMs: gapMs,
            label: formatted.label,
            ariaLabel: formatted.ariaLabel,
          });
        }
      } else if (previous && currentMs < previous.timestampMs) {
        previous = null;
        return;
      }
      previous = {
        messageId: id,
        timestampMs: currentMs,
      };
    }, includeChildren);
    return dividers;
  }

  function buildTimeDividerMap(dividers) {
    var map = new Map();
    var list = Array.isArray(dividers) ? dividers : [];
    for (var index = 0; index < list.length; index += 1) {
      var divider = list[index];
      var targetId = normalizeId(divider && divider.beforeMessageId);
      if (targetId) {
        map.set(targetId, divider);
      }
    }
    return map;
  }

  function buildTimeDividerMarkup(divider, options) {
    var settings = options || {};
    var escapeHtml = typeof settings.escapeHtml === 'function'
      ? settings.escapeHtml
      : defaultEscapeHtml;
    var beforeMessageId = normalizeId(divider && divider.beforeMessageId);
    var label = String(divider && divider.label || '').trim();
    var ariaLabel = String(divider && divider.ariaLabel || label).trim();
    if (!beforeMessageId || !label) {
      return '';
    }
    return ''
      + '<div'
      + ' class="chat-timeline-divider"'
      + ' role="separator"'
      + ' aria-label="' + escapeHtml(ariaLabel) + '"'
      + ' data-timeline-divider="time-gap"'
      + ' data-before-message-id="' + escapeHtml(beforeMessageId) + '"'
      + ' data-search-skip="true"'
      + '>'
      + '<span class="chat-timeline-divider-line" aria-hidden="true"></span>'
      + '<span class="chat-timeline-divider-label">' + escapeHtml(label) + '</span>'
      + '<span class="chat-timeline-divider-line" aria-hidden="true"></span>'
      + '</div>';
  }

  return {
    DEFAULT_TIME_DIVIDER_GAP_MS: DEFAULT_TIME_DIVIDER_GAP_MS,
    buildTimeDividerMap: buildTimeDividerMap,
    buildTimeDividerMarkup: buildTimeDividerMarkup,
    buildTimelineDividerInputSignature: buildTimelineDividerInputSignature,
    deriveTimelineTimeDividers: deriveTimelineTimeDividers,
  };
});
