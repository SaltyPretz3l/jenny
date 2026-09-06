/**
 * renderer/shared/error-intake.js
 *
 * DOM-free normalization and first-match routing core using the existing recovery classifier.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../chat/renderer-error-recovery-utils'));
    return;
  }
  root.rendererErrorIntake = factory(root.rendererErrorRecoveryUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (injectedRecoveryUtils) {
  'use strict';

  /* Reuse the existing classifier — the plan forbids a second one. */
  function resolveRecoveryUtils() {
    if (typeof globalThis !== 'undefined') {
      var utils = globalThis.rendererErrorRecoveryUtils;
      if (utils && typeof utils.classifyError === 'function') return utils;
    }
    if (injectedRecoveryUtils && typeof injectedRecoveryUtils.classifyError === 'function') {
      return injectedRecoveryUtils;
    }
    return null;
  }

  function normalizeToken(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function firstText() {
    for (var i = 0; i < arguments.length; i++) {
      var candidate = normalizeText(arguments[i]);
      if (candidate) return candidate;
    }
    return '';
  }

  var SEVERITIES = Object.freeze(['info', 'warning', 'danger']);

  /* Legacy toast `tone` values map onto envelope severities. 'error'
   * is the historical invalid tone (renderer-update-dialog-utils
   * passed it and the toast store silently normalized it to 'info') —
   * intake maps it to danger so the bug is structurally unexpressible. */
  var TONE_SEVERITY_MAP = Object.freeze({
    danger: 'danger',
    error: 'danger',
    warning: 'warning',
    info: 'info',
    success: 'info',
  });

  /* Origins whose failures are staleness/noise rather than broken
   * turns default to warning instead of danger. */
  var WARNING_DEFAULT_ORIGINS = Object.freeze([
    'settings-refresh', 'offline-refresh', 'health-poll', 'global-boundary',
  ]);

  function isUserInitiatedStop(recoveryClass, terminalStatus, terminalSubcode) {
    if (recoveryClass === 'cancelled' || recoveryClass === 'denied') return true;
    if (terminalSubcode === 'user_cancel' || terminalSubcode === 'user_explicit') return true;
    return terminalStatus === 'cancelled' || terminalStatus === 'aborted' || terminalStatus === 'denied';
  }

  function deriveSeverity(origin, explicitSeverity, recoveryClass, terminalStatus, terminalSubcode) {
    if (isUserInitiatedStop(recoveryClass, terminalStatus, terminalSubcode)) return 'info';
    /* update-action danger override — sticky danger toast regardless of
     * whatever tone the legacy callsite carried. */
    if (origin === 'update-action') return 'danger';
    if (SEVERITIES.indexOf(explicitSeverity) !== -1) return explicitSeverity;
    if (WARNING_DEFAULT_ORIGINS.indexOf(origin) !== -1) return 'warning';
    return 'danger';
  }

  function normalizeRecoveryActions(value) {
    if (!Array.isArray(value)) return [];
    var output = [];
    for (var i = 0; i < value.length; i++) {
      var entry = value[i] && typeof value[i] === 'object' ? value[i] : null;
      if (!entry) continue;
      var id = normalizeText(entry.id);
      if (!id) continue;
      output.push({ id: id, label: normalizeText(entry.label) });
    }
    return output;
  }

  /**
   * Normalize any renderer error shape into the intake envelope.
   * Accepts a raw Error, a chat-stream terminal payload (snake_case
   * recovery fields), a backend.onStatus payload ({phase, detail}),
   * a legacy {message, options} toast pair, or an already-normalized
   * envelope (idempotent). `context` supplies what the input cannot
   * know about itself: origin, source/dedupeKey, ids, inflight state.
   * @param {*} input
   * @param {Object} [context]
   * @returns {Object} envelope
   */
  function normalizeErrorEnvelope(input, context) {
    var ctx = context && typeof context === 'object' ? context : {};
    var raw = input && typeof input === 'object' ? input : {};
    var isError = input instanceof Error
      || (typeof raw.message === 'string' && typeof raw.stack === 'string');
    /* Legacy toast pair: showErrorToast(message, options). */
    var options = raw.options && typeof raw.options === 'object' ? raw.options : {};

    var message = firstText(
      typeof input === 'string' ? input : '',
      raw.stream_error, raw.streamError,
      isError ? raw.message : '',
      raw.message,
      typeof raw.error === 'string' ? raw.error : '',
      raw.detail
    );
    var errorCode = firstText(raw.error_code, raw.errorCode,
      /^CMP-/i.test(normalizeText(raw.code)) ? raw.code : '');

    var recoveryUtils = resolveRecoveryUtils();
    var recoveryClass = normalizeToken(raw.recovery_class || raw.recoveryClass);
    var category = normalizeToken(raw.category)
      || (recoveryUtils ? recoveryUtils.classifyError(errorCode) : 'unknown');
    var terminalStatus = normalizeToken(
      raw.terminal_status || raw.terminalStatus || raw.status || raw.phase
    );
    var terminalSubcode = normalizeToken(raw.terminal_subcode || raw.terminalSubcode);
    var origin = normalizeToken(ctx.origin || raw.origin) || 'unknown';
    var explicitSeverity = normalizeToken(raw.severity)
      || TONE_SEVERITY_MAP[normalizeToken(options.tone || raw.tone)] || '';

    var retryable;
    if (typeof raw.retryable === 'boolean') {
      retryable = raw.retryable;
    } else {
      retryable = recoveryUtils ? recoveryUtils.isRetryable(errorCode, message) : false;
    }

    var source = firstText(ctx.source, raw.source, options.source);
    return {
      origin: origin,
      source: source,
      dedupeKey: firstText(ctx.dedupeKey, raw.dedupeKey, options.dedupeKey, source),
      errorCode: errorCode,
      recoveryClass: recoveryClass,
      category: category,
      terminalStatus: terminalStatus,
      terminalSubcode: terminalSubcode,
      retryable: retryable,
      recoveryTitle: firstText(raw.recovery_title, raw.recoveryTitle, options.title, raw.title),
      recoveryHint: firstText(raw.recovery_hint, raw.recoveryHint),
      recoveryActions: normalizeRecoveryActions(raw.recovery_actions || raw.recoveryActions),
      nextAction: firstText(raw.next_action, raw.nextAction),
      nextActionLabel: firstText(raw.next_action_label, raw.nextActionLabel),
      severity: deriveSeverity(origin, explicitSeverity, recoveryClass, terminalStatus, terminalSubcode),
      title: firstText(raw.recovery_title, raw.recoveryTitle, options.title, raw.title),
      message: message,
      sessionId: firstText(ctx.sessionId, raw.session_id, raw.sessionId),
      messageId: firstText(ctx.messageId, raw.message_id, raw.messageId, raw.id),
      isInflightTurn: ctx.isInflightTurn === true || raw.isInflightTurn === true,
      /* Row-3 signal (inflight recovery for an unusable backend) —
       * supplied by the caller, not derivable from the error itself. */
      backendUnusable: ctx.backendUnusable === true
        || raw.backendUnusable === true || raw.backend_unusable === true,
    };
  }

  /* ── Frozen routing policy ──
   * Row ids match the plan's 12-row table. Array order is evaluation
   * order (first-match-wins); row 3 precedes row 2 because the
   * backend-unusable chat-stream case is the more specific match.
   * Every routed error with severity >= warning is ALSO recorded to
   * the error center; row 1 records explicitly (its only surface). */
  var ERROR_ROUTING_TABLE = Object.freeze([
    Object.freeze({
      id: 1,
      rule: 'cancelled_or_denied',
      surface: 'none',
      recordAlways: true,
      match: function matchCancelled(envelope) {
        return isUserInitiatedStop(envelope.recoveryClass, envelope.terminalStatus, envelope.terminalSubcode);
      },
    }),
    Object.freeze({
      id: 3,
      rule: 'chat_stream_backend_unusable',
      surface: 'banner',
      bannerTone: 'danger',
      bannerSticky: true,
      match: function matchInflightRecovery(envelope) {
        return envelope.origin === 'chat-stream' && envelope.backendUnusable === true;
      },
    }),
    Object.freeze({
      id: 2,
      rule: 'chat_stream_turn_error',
      /* The timeline card renders organically from message state via
       * the projector — intake suppresses the toast and records
       * history; it never renders the card itself. */
      surface: 'timeline',
      match: function matchChatStream(envelope) {
        return envelope.origin === 'chat-stream';
      },
    }),
    Object.freeze({
      id: 4,
      rule: 'backend_status',
      surface: 'banner',
      bannerTone: 'danger',
      bannerSticky: true,
      match: function matchBackendStatus(envelope) {
        return envelope.origin === 'backend-status';
      },
    }),
    Object.freeze({
      id: 5,
      rule: 'settings_refresh',
      surface: 'toast',
      toastTone: 'warning',
      toastSticky: false,
      toastDurationMs: 6000,
      match: function matchSettingsRefresh(envelope) {
        return envelope.origin === 'settings-refresh';
      },
    }),
    Object.freeze({
      id: 6,
      rule: 'background_poll',
      surface: 'none',
      recordAlways: true,
      match: function matchBackgroundPoll(envelope) {
        return envelope.origin === 'offline-refresh' || envelope.origin === 'health-poll';
      },
    }),
    Object.freeze({
      id: 7,
      rule: 'update_action',
      surface: 'toast',
      toastTone: 'danger',
      toastSticky: true,
      match: function matchUpdateAction(envelope) {
        return envelope.origin === 'update-action';
      },
    }),
    Object.freeze({
      id: 8,
      rule: 'shell_action',
      surface: 'toast',
      toastTone: 'danger',
      toastSticky: true,
      match: function matchShellAction(envelope) {
        return envelope.origin === 'shell-action';
      },
    }),
    Object.freeze({
      id: 9,
      rule: 'global_boundary',
      surface: 'toast',
      toastTone: 'warning',
      toastSticky: false,
      toastDurationMs: 6000,
      match: function matchGlobalBoundary(envelope) {
        return envelope.origin === 'global-boundary';
      },
    }),
    Object.freeze({
      id: 10,
      rule: 'auth',
      surface: 'auth-inline',
      match: function matchAuth(envelope) {
        return envelope.origin === 'auth';
      },
    }),
    Object.freeze({
      id: 11,
      rule: 'startup_crash',
      surface: 'startup-overlay',
      match: function matchStartupCrash(envelope) {
        return envelope.origin === 'startup-crash';
      },
    }),
    Object.freeze({
      id: 12,
      rule: 'default',
      surface: 'toast',
      toastTone: 'danger',
      toastSticky: true,
      match: function matchDefault() {
        return true;
      },
    }),
  ]);

  function buildToastDirective(row, envelope) {
    if (row.surface !== 'toast') return null;
    return {
      tone: row.toastTone,
      sticky: row.toastSticky === true,
      durationMs: row.toastSticky === true ? 0 : row.toastDurationMs || 0,
      source: envelope.source,
      dedupeKey: envelope.dedupeKey,
      title: envelope.title,
      message: envelope.message,
    };
  }

  function buildBannerDirective(row) {
    if (row.surface !== 'banner') return null;
    return { tone: row.bannerTone || 'danger', sticky: row.bannerSticky === true };
  }

  /**
   * Resolve an error to its primary surface. Accepts anything
   * `normalizeErrorEnvelope` accepts (normalization is idempotent,
   * so pre-normalized envelopes pass straight through).
   * @param {*} input
   * @param {Object} [context] - origin/source/ids/inflight signals
   * @returns {Object} route - {ruleId, rule, surface, toast, banner,
   *   recordToErrorCenter, envelope}
   */
  function routeError(input, context) {
    var envelope = normalizeErrorEnvelope(input, context);
    for (var i = 0; i < ERROR_ROUTING_TABLE.length; i++) {
      var row = ERROR_ROUTING_TABLE[i];
      if (!row.match(envelope)) continue;
      return {
        ruleId: row.id,
        rule: row.rule,
        surface: row.surface,
        toast: buildToastDirective(row, envelope),
        banner: buildBannerDirective(row),
        recordToErrorCenter: row.recordAlways === true
          || envelope.severity === 'warning'
          || envelope.severity === 'danger',
        envelope: envelope,
      };
    }
    /* Unreachable — row 12 matches everything — but never throw. */
    return {
      ruleId: 12,
      rule: 'default',
      surface: 'toast',
      toast: buildToastDirective(ERROR_ROUTING_TABLE[ERROR_ROUTING_TABLE.length - 1], envelope),
      banner: null,
      recordToErrorCenter: true,
      envelope: envelope,
    };
  }

  return {
    ERROR_ROUTING_TABLE: ERROR_ROUTING_TABLE,
    normalizeErrorEnvelope: normalizeErrorEnvelope,
    routeError: routeError,
  };
});
