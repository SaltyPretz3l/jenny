/* renderer/shell/renderer-slash-command-context.js - UMD
 * /context reports the same bounded usage truth as the composer context meter. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSlashCommandContextUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ROW_WIDTH = 40;
  var BAR_WIDTH = 26;

  function dotRow(label, value) {
    var left = String(label);
    var right = String(value);
    var gap = ROW_WIDTH - left.length - right.length;
    return gap < 3 ? left + '  ' + right : left + ' ' + '\u00B7'.repeat(gap - 2) + ' ' + right;
  }

  function formatTokenCount(value, estimated) {
    var normalized = Math.max(Number(value) || 0, 0);
    return (estimated ? '~' : '') + Math.floor(normalized).toLocaleString() + ' tokens';
  }

  function usageBar(fraction) {
    var normalized = Math.max(0, Math.min(1, Number(fraction) || 0));
    var filled = Math.round(normalized * BAR_WIDTH);
    return '\u2588'.repeat(filled) + '\u2591'.repeat(BAR_WIDTH - filled);
  }

  function findSessionSummary(state, sessionId) {
    var sessions = Array.isArray(state && state.sessions) ? state.sessions : [];
    return sessions.find(function matches(entry) {
      return String(entry && entry.id || '').trim() === sessionId;
    }) || null;
  }

  function createContextCommand(deps) {
    var options = deps || {};
    var state = options.state || {};
    var getCurrentSessionMessages = options.getCurrentSessionMessages || function empty() { return []; };
    var getSessionMessages = options.getSessionMessages;
    var usageModule = options.contextUsageModule || null;
    var appendClientLog = options.appendClientLog || function noop() {};
    var injectOutput = options.injectOutput || function noop() { return false; };

    return function handleContextCommand(invocation) {
      var sessionId = String(invocation && invocation.sessionId || '').trim();
      if (!sessionId) return { ok: false, handled: true, code: 'no_session' };

      var source = typeof getSessionMessages === 'function'
        ? getSessionMessages(sessionId)
        : getCurrentSessionMessages();
      var messages = Array.isArray(source) ? source : [];
      var runtimeDraft = state.runtimeDraft || {};
      var preferences = runtimeDraft.contextPreferences || {};
      var status = state.status || {};
      var featureFlags = state.features && state.features.featureFlags || {};
      var model = String(runtimeDraft.preferredModel || status.model || 'unknown');
      var reasoningEffort = String(runtimeDraft.reasoningEffort || status.reasoning_effort || 'default');
      var contextLimit = Math.max(Number(status.effective_context_length || 0), 0);
      var historyScope = String(preferences.historyScope || 'session');
      var autoCompactEnabled = featureFlags.token_budget === true
        && featureFlags.context_compaction === true;
      var overheadTokens = Math.max(Number(state.ui && state.ui.contextOverheadTokens || 0), 0);
      var sessionSummary = findSessionSummary(state, sessionId);
      var fallbackOptions = {
        contextLimit: contextLimit,
        model: model,
        historyScope: historyScope,
        overheadTokens: overheadTokens,
        compactionContext: sessionSummary && sessionSummary.compaction_context || null,
        attachments: Array.isArray(state.attachments && state.attachments.queued)
          ? state.attachments.queued : [],
        autoCompactEnabled: autoCompactEnabled,
      };
      var fallbackEstimate = null;
      var meter = null;
      var usageUnavailable = !usageModule;
      try {
        if (usageModule && typeof usageModule.buildCachedContextUsageEstimate === 'function') {
          fallbackEstimate = usageModule.buildCachedContextUsageEstimate(
            sessionId, messages, fallbackOptions
          );
        } else if (usageModule && typeof usageModule.buildContextUsageEstimate === 'function') {
          fallbackEstimate = usageModule.buildContextUsageEstimate(messages, fallbackOptions);
        }
        meter = usageModule && typeof usageModule.describeContextUsage === 'function'
          ? usageModule.describeContextUsage(sessionId, {
            activeModel: model,
            fallbackEstimate: fallbackEstimate,
            autoCompactEnabled: autoCompactEnabled,
          })
          : null;
      } catch (_error) {
        usageUnavailable = true;
      }
      if (usageUnavailable) {
        appendClientLog('WARN', 'slash.context_usage_unavailable', { sessionId: sessionId });
      }

      var lines = ['Context Usage', ''];
      if (meter) {
        var estimated = meter.source !== 'provider';
        lines.push('  ' + dotRow('Used', formatTokenCount(meter.used, estimated)));
        lines.push('  ' + dotRow('Limit', formatTokenCount(meter.limit, false)));
        lines.push('  ' + dotRow(
          'Remaining', formatTokenCount(Math.max(meter.limit - meter.used, 0), estimated)
        ));
        lines.push('  ' + usageBar(meter.ratio) + '  ' + meter.percentLabel);
        lines.push('  ' + dotRow('Freshness', meter.sourceLabel));
        lines.push('  ' + dotRow(
          'Target', meter.targetType === 'auto_compact' ? 'auto-compact threshold' : 'context window'
        ));
      } else {
        lines.push('  Usage unavailable');
      }

      lines.push('', 'Session', '');
      lines.push('  ' + dotRow('Messages', messages.length));
      lines.push('  ' + dotRow('Cached overhead', formatTokenCount(overheadTokens, true)));
      lines.push('  ' + dotRow('Model', model));
      lines.push('  ' + dotRow('Effort', reasoningEffort));
      lines.push('  ' + dotRow('History', historyScope));
      lines.push('  ' + dotRow('Personality and notes', preferences.includePersonality === false ? 'off' : 'on'));
      lines.push('  ' + dotRow('Memory', preferences.includeMemory === false ? 'off' : 'on'));

      var added = injectOutput(lines.join('\n'), '/context', invocation);
      appendClientLog(added === false ? 'WARN' : 'INFO',
        added === false ? 'slash.context_stale_output' : 'slash.context_rendered', {
          sessionId: sessionId,
          source: meter && meter.source || 'unavailable',
          authoritative: Boolean(meter && meter.source === 'provider'),
          contextLimit: meter && meter.limit || null,
        });
      return {
        ok: added !== false,
        handled: added === false,
        code: added === false ? 'stale_output' : 'context_shown',
      };
    };
  }

  return { createContextCommand: createContextCommand };
});
