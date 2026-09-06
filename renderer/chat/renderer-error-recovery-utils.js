/**
 * renderer/chat/renderer-error-recovery-utils.js
 *
 * Error classification from CMP-* codes and the unified timeline error
 * card (.chat-error-card). Every turn-level error renders through one
 * card with two severities: danger (role=alert) and calm
 * (cancelled/denied/aborted — role=status, muted). Action buttons are
 * inventory primitives carrying data-inv-error-action for the
 * delegated transcript click handler (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../inventory/action-button'),
      require('../inventory/badge')
    );
    return;
  }
  root.rendererErrorRecoveryUtils = factory(
    root.inventoryActionButton,
    root.inventoryBadge
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (injectedActionButton, injectedBadge) {
  'use strict';

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  /* ── Error classification ── */

  /**
   * Error classes determine which recovery actions to show.
   * @typedef {'transport'|'provider'|'tool'|'context'|'loop'|'unknown'} ErrorClass
   */

  /* WO-12c: the session-lockdown gate's terminal_subcode / error_code
   * (services/backend/session-lockdown-gate.js LOCKDOWN_REMOTE_ENGINE). Not a
   * CMP-* code, so it needs an explicit branch rather than a prefix-map entry
   * -- and it is a refusal the user caused on purpose, not a crash, so it
   * renders 'calm' with three lockdown-specific actions instead of the generic
   * danger-card machinery. */
  var LOCKDOWN_REMOTE_ENGINE_CODE = 'lockdown_remote_engine';
  var LOCKDOWN_REFUSAL_MESSAGE = 'This session is in offline lockdown; the selected engine is remote. '
    + 'Switch to a local model or turn lockdown off.';

  var PREFIX_CLASS_MAP = {
    'CMP-AI-0002': 'transport',   /* engine connection */
    'CMP-AI-0003': 'provider',    /* rate limit */
    'CMP-AI-0001': 'provider',    /* model not loaded */
    'CMP-AI-0004': 'provider',    /* model load failed */
    'CMP-AI-0005': 'provider',    /* generation error */
    'CMP-AI-0006': 'provider',    /* unsupported modal */
    'CMP-AI-0007': 'provider',    /* skill execution */
    'CMP-CLOUD-1001': 'provider', /* cloud rate limited */
    'CMP-CLOUD-1002': 'transport', /* cloud network error */
    'CMP-CLOUD-1003': 'transport', /* cloud HTTP error */
    'CMP-CLOUD-1004': 'transport', /* cloud response parse */
    'CMP-CHAT-0002': 'transport', /* stream failed */
  };

  var PREFIX_GROUP_MAP = {
    'CMP-TOOL': 'tool',
    'CMP-MCP': 'tool',
    'CMP-WEB': 'tool',
    'CMP-TSRCH': 'tool',
    'CMP-STREAM': 'transport',
    'CMP-SIDECAR': 'transport',
    'CMP-RENDER': 'loop',
    'CMP-INTERACTIVE': 'loop',
    'CMP-CTX': 'context',
    'CMP-CFG': 'setup',
    'CMP-LOOP': 'loop',
    'CMP-MEM': 'tool',
  };

  /**
   * Classify an error code into a recovery action class.
   * @param {string} errorCode - CMP-* error code
   * @returns {ErrorClass}
   */
  function classifyError(errorCode) {
    var code = String(errorCode || '').trim().toUpperCase();
    if (!code) return 'unknown';

    /* Exact match first. */
    if (PREFIX_CLASS_MAP[code]) return PREFIX_CLASS_MAP[code];

    /* Prefix group match. */
    var prefixes = Object.keys(PREFIX_GROUP_MAP);
    for (var i = 0; i < prefixes.length; i++) {
      if (code.startsWith(prefixes[i])) return PREFIX_GROUP_MAP[prefixes[i]];
    }

    return 'unknown';
  }

  /**
   * Check if an error is retryable based on its code.
   * @param {string} errorCode
   * @returns {boolean}
   */
  function isRetryable(errorCode, errorMessage) {
    var cls = classifyError(errorCode);
    if (cls === 'transport' || cls === 'loop') return true;
    if (cls !== 'provider') return false;
    var code = String(errorCode || '').trim().toUpperCase();
    if (code === 'CMP-AI-0003' || code === 'CMP-CLOUD-1001') return true;
    return /rate.?limit/i.test(String(errorMessage || ''));
  }

  /* ── Severity ── */

  function normalizeToken(value) {
    return String(value || '').trim().toLowerCase();
  }

  /**
   * Resolve the card severity for a message-shaped error.
   * 'calm' covers user-initiated terminations (cancelled / denied /
   * aborted) — these render muted with role=status instead of a danger
   * alert. Derives from recovery_class when the backend enriched the
   * payload, with terminal status as the pre-enrichment fallback.
   * @param {Object} message
   * @returns {'danger'|'calm'}
   */
  function resolveErrorSeverity(message) {
    var m = message && typeof message === 'object' ? message : {};
    var recoveryClass = normalizeToken(m.recoveryClass || m.recovery_class);
    if (recoveryClass === 'cancelled' || recoveryClass === 'denied') return 'calm';
    var status = normalizeToken(m.terminalStatus || m.terminal_status || m.status);
    if (status === 'cancelled' || status === 'aborted' || status === 'denied') return 'calm';
    return 'danger';
  }

  /* ── Rendering ── */

  var ICONS = {
    retry: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M13 8a5 5 0 1 1-1.43-3.49" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M13 3v3.5H9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    settings: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
    skip: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M4 4l8 4-8 4V4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M12 4v8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  };

  var CARD_ICONS = {
    danger: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M8 1.5 15 14H1L8 1.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="12" r="0.75" fill="currentColor"/></svg>',
    calm: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><rect x="5.75" y="5.75" width="4.5" height="4.5" rx="0.75" fill="currentColor"/></svg>',
  };

  var BACKEND_ACTIONS = {
    retry_turn: { icon: 'retry', label: 'Retry turn' },
    restart_sidecar: { icon: 'retry', label: 'Restart sidecar' },
    open_diagnostics: { icon: 'settings', label: 'Open diagnostics' },
    open_settings: { icon: 'settings', label: 'Open settings' },
    start_new_session: { icon: 'skip', label: 'Start new session' },
  };

  /* Secondary navigations that demote to a muted/tertiary style when they
   * are not the leading (primary) action in a card's action row. */
  var SECONDARY_NAV_ACTIONS = { open_diagnostics: true, open_settings: true };

  /* Backend recovery_class (services/backend/chat-error-recovery.js
   * classifyAssistantError taxonomy) -> renderer LOCAL ErrorClass. Lets the
   * button-derivation chain (which keys off the local taxonomy) agree with
   * a backend-supplied recoveryTitle instead of deriving buttons from a pure
   * code-prefix classifyError() result that can diverge in semantics (e.g.
   * CMP-LOOP-* classifies locally as 'loop' but the backend's own taxonomy
   * calls the same failure 'runtime'). Only consulted when opts carries a
   * non-empty recoveryClass/recovery_class; classifyError(errorCode) stays
   * the sole source pre-enrichment. */
  var BACKEND_CLASS_TO_LOCAL_CLASS = {
    sidecar_transport: 'transport',
    timeout: 'transport',
    turn_deadline: 'loop',
    transport: 'transport',
    retryable: 'transport',
    runtime: 'loop',
    provider: 'provider',
    provider_rate_limited: 'provider',
    tool: 'tool',
    context: 'context',
    setup: 'setup',
    cancelled: 'unknown',
    denied: 'unknown',
  };

  /* Local fallback titles per error class — mirrors the backend
   * RECOVERY_COPY titles so the pre-enrichment path reads the same. */
  var LOCAL_TITLES = {
    transport: 'Connection issue',
    provider: 'Provider issue',
    tool: 'Tool failed',
    context: 'Context limit reached',
    setup: 'Setup required',
    loop: 'Processing issue',
    unknown: 'Turn failed',
  };

  /**
   * Build descriptive recovery guidance per error class.
   */
  function getRecoveryHint(errorClass, errorMessage) {
    switch (errorClass) {
      case 'transport':
        return 'Connection issue — the request may succeed on retry.';
      case 'provider':
        if (/rate.?limit/i.test(errorMessage)) return 'Rate limit reached — wait a moment or check provider settings.';
        if (/not.?loaded|model.?load/i.test(errorMessage)) return 'Model not available — load it or choose another in settings.';
        return 'Provider error — check your model or API configuration.';
      case 'tool':
        return 'Tool execution failed — you can retry, skip, or edit the input.';
      case 'context':
        return 'Context window limit reached — consider starting a new session.';
      case 'setup':
        return 'A workspace root is not set — open Settings to set one, then retry.';
      case 'loop':
        return 'Processing limit hit — the request can be retried.';
      default:
        return '';
    }
  }

  function normalizeActionText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeRecoveryActions(value, nextAction, nextActionLabel) {
    var source = Array.isArray(value) ? value : [];
    var seen = new Set();
    var output = [];
    for (var i = 0; i < source.length; i++) {
      var entry = source[i] && typeof source[i] === 'object' ? source[i] : {};
      var id = normalizeActionText(entry.id);
      if (!Object.prototype.hasOwnProperty.call(BACKEND_ACTIONS, id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      var defaults = BACKEND_ACTIONS[id];
      var label = normalizeActionText(entry.label)
        || (id === nextAction ? normalizeActionText(nextActionLabel) : '')
        || defaults.label;
      output.push({
        id: id,
        label: label,
        icon: defaults.icon,
      });
    }
    return output;
  }

  function resolveActionButtonPrimitive() {
    if (typeof globalThis !== 'undefined') {
      var inv = globalThis.inventory;
      if (inv && typeof inv.actionButton === 'function') return inv.actionButton;
      if (typeof globalThis.inventoryActionButton === 'function') return globalThis.inventoryActionButton;
    }
    return typeof injectedActionButton === 'function' ? injectedActionButton : null;
  }

  function resolveBadgePrimitive() {
    if (typeof globalThis !== 'undefined') {
      var inv = globalThis.inventory;
      if (inv && typeof inv.badge === 'function') return inv.badge;
      if (typeof globalThis.inventoryBadge === 'function') return globalThis.inventoryBadge;
    }
    return typeof injectedBadge === 'function' ? injectedBadge : null;
  }

  function buildActionButton(action, options) {
    var settings = options || {};
    var actionId = normalizeActionText(action && action.id);
    var label = normalizeActionText(action && action.label);
    if (!actionId || !label) {
      return '';
    }
    var actionButton = resolveActionButtonPrimitive();
    if (!actionButton) {
      return '';
    }
    var explicitMuted = settings.muted === true;
    /* Recovery action hierarchy: the recommended next step (Retry) leads as
     * primary; secondary navigations (diagnostics/settings) demote to muted
     * unless they ARE the primary action (e.g. non-retryable provider). */
    var isPrimary = settings.primary === true && !explicitMuted;
    var muted = explicitMuted || (!isPrimary && SECONDARY_NAV_ACTIONS[actionId] === true);
    var icon = ICONS[action && action.icon] || '';
    var dataset = { 'inv-error-action': actionId };
    var callId = String(settings.callId || '').trim();
    var sessionId = String(settings.sessionId || '').trim();
    var messageId = String(settings.messageId || '').trim();
    var errorClass = String(settings.errorClass || '').trim();
    var streamId = String(settings.streamId || '').trim();
    if (callId) dataset['call-id'] = callId;
    if (sessionId) dataset['session-id'] = sessionId;
    if (messageId) dataset['message-id'] = messageId;
    if (errorClass) dataset['error-class'] = errorClass;
    if (streamId) dataset['stream-id'] = streamId;
    return actionButton({
      label: label,
      title: action && action.title,
      plain: true,
      className: 'inv-error-action'
        + (isPrimary ? ' inv-error-action--primary' : '')
        + (muted ? ' inv-error-action--muted' : ''),
      dataset: dataset,
      trustedHtml: (icon ? icon + ' ' : '') + escapeHtml(label),
    });
  }

  /* Tooltip copy for the logs deep-link chip. The global tooltip layer
   * (renderer/inventory/tooltip.js) migrates a plain title= into its own
   * popover, so setting title is the whole contract. */
  var LOGS_LINK_TITLE = "View this error's diagnostic event in Activity";

  /**
   * Resolve the turn's stream id from a message-shaped error payload.
   * Mirrors renderer-turn-tree-projector.js extractMessageStreamId() for the
   * fields that survive persistence (the projector's own helper is not
   * exported, and importing that module here would pull the whole turn-tree
   * dependency chain into the error card). opts.streamId wins when the caller
   * already resolved the row's turn id.
   * @param {Object} message
   * @param {Object} [opts]
   * @returns {string}
   */
  function resolveErrorStreamId(message, opts) {
    var m = message && typeof message === 'object' ? message : {};
    var o = opts && typeof opts === 'object' ? opts : {};
    return normalizeActionText(o.streamId)
      || normalizeActionText(m.stream_id)
      || normalizeActionText(m.streamId)
      || normalizeActionText(m.request_id)
      || normalizeActionText(m.requestId)
      || normalizeActionText(m.parent_stream_id)
      || normalizeActionText(m.parentStreamId)
      || normalizeActionText(m.tool_call && m.tool_call.parent_stream_id)
      || normalizeActionText(m.tool_result && m.tool_result.parent_stream_id);
  }

  /**
   * De-emphasized error-code chip (inventory badge), tone supplied by the
   * caller. Shared by the timeline card and the in-tool-card result notice so
   * the chip treatment lives in one place. Returns '' for an empty code.
   *
   * With a streamId the chip becomes the logs deep-link: a focusable
   * role=link span carrying the same data-inv-error-action="open_logs"
   * contract as the "View in logs" button, so the delegated transcript
   * handler routes both without a second code path. The badge primitive
   * stays untouched — the link attributes are spliced onto its opening tag.
   * @param {string} errorCode
   * @param {{tone?:string, size?:string, className?:string, streamId?:string}} [options]
   * @returns {string} HTML string
   */
  function buildErrorCodeChip(errorCode, options) {
    var code = normalizeActionText(errorCode);
    if (!code) {
      return '';
    }
    var badge = resolveBadgePrimitive();
    if (typeof badge !== 'function') {
      return '';
    }
    var o = options || {};
    var markup = badge({
      tone: o.tone || 'danger',
      size: o.size || 'sm',
      text: code,
      className: o.className || '',
    });
    var streamId = normalizeActionText(o.streamId);
    /* No target -> stay inert metadata rather than render a dead link. */
    if (!streamId || markup.indexOf('<span') !== 0) {
      return markup;
    }
    return '<span role="link" tabindex="0" data-inv-error-action="open_logs"'
      + ' data-stream-id="' + escapeHtml(streamId) + '"'
      + ' title="' + escapeHtml(LOGS_LINK_TITLE) + '"'
      + markup.slice('<span'.length);
  }

  function hasRecoveryMetadata(message) {
    var actions = message && (message.recoveryActions || message.recovery_actions);
    var nextAction = normalizeActionText(message?.nextAction || message?.next_action);
    var nextActionLabel = normalizeActionText(message?.nextActionLabel || message?.next_action_label);
    return Boolean(
      normalizeActionText(message?.recoveryClass || message?.recovery_class)
      || nextAction
      || normalizeActionText(message?.recoveryTitle || message?.recovery_title)
      || normalizeActionText(message?.recoveryHint || message?.recovery_hint)
      || nextActionLabel
      || normalizeRecoveryActions(actions, nextAction, nextActionLabel).length > 0
    );
  }

  /**
   * Render the unified timeline error card from option-shaped input.
   * @param {Object} opts
   * @param {string} opts.errorCode - CMP-* error code
   * @param {string} opts.message - Human-readable error message
   * @param {'danger'|'calm'} [opts.severity='danger'] - Card severity
   * @param {string} [opts.callId] - Tool call ID (for tool-level retry/skip)
   * @param {string} [opts.sessionId] - Session ID (for stream-level retry)
   * @param {string} [opts.streamId] - Turn stream ID (logs deep-link target)
   * @param {boolean} [opts.retryable] - Override retryable flag from server
   * @param {string} [opts.recoveryTitle] - Server-supplied recovery title (snake_case alias: recovery_title)
   * @param {string} [opts.recoveryHint] - Server-supplied recovery hint (snake_case alias: recovery_hint)
   * @param {string} [opts.nextActionLabel] - Server-supplied label for the primary action (snake_case alias: next_action_label)
   * @returns {string} HTML string
   */
  function renderErrorRecovery(opts) {
    var o = opts || {};
    var severity = o.severity === 'calm' ? 'calm' : 'danger';
    var errorCode = String(o.errorCode || '').trim();
    var message = normalizeActionText(o.message);
    var callId = String(o.callId || '').trim();
    var sessionId = String(o.sessionId || '').trim();
    var messageId = String(o.messageId || '').trim();
    var streamId = String(o.streamId || '').trim();
    var createdAt = normalizeActionText(o.createdAt) || normalizeActionText(o.timestamp);
    var terminalSubcode = normalizeToken(o.terminalSubcode || o.terminal_subcode);
    var isLockdownRefusal = normalizeToken(errorCode) === LOCKDOWN_REMOTE_ENGINE_CODE
      || terminalSubcode === LOCKDOWN_REMOTE_ENGINE_CODE;
    var backendRecoveryClass = normalizeToken(o.recoveryClass || o.recovery_class);
    var errorClass = backendRecoveryClass
      ? (BACKEND_CLASS_TO_LOCAL_CLASS[backendRecoveryClass] || classifyError(errorCode))
      : classifyError(errorCode);
    var title = isLockdownRefusal
      ? 'Offline lockdown is on'
      : (normalizeActionText(o.recoveryTitle) || normalizeActionText(o.recovery_title)
        || (severity === 'calm' ? 'Response stopped' : (LOCAL_TITLES[errorClass] || LOCAL_TITLES.unknown)));
    if (isLockdownRefusal) {
      message = LOCKDOWN_REFUSAL_MESSAGE;
    }
    var serverHint = normalizeActionText(o.recoveryHint) || normalizeActionText(o.recovery_hint);
    var hint = severity === 'calm'
      ? serverHint
      : (serverHint || getRecoveryHint(errorClass, message));
    var nextActionLabel = normalizeActionText(o.nextActionLabel) || normalizeActionText(o.next_action_label);
    var nextAction = normalizeActionText(o.nextAction) || normalizeActionText(o.next_action);
    /* Retryability follows the SAME source as errorClass: a backend-classified
     * card must not resurrect a code-prefix Retry (e.g. backend 'setup' over a
     * CMP-LOOP-* code); pre-enrichment keeps the code/message heuristic. */
    var retryable = typeof o.retryable === 'boolean'
      ? o.retryable
      : (backendRecoveryClass
        ? (errorClass === 'transport' || errorClass === 'loop')
        : isRetryable(errorCode, message));

    var codeBadge = buildErrorCodeChip(errorCode, {
      tone: severity === 'calm' ? 'default' : 'danger',
      className: 'chat-error-card-code',
      streamId: streamId,
    });

    var actions = [];
    var actionIds = [];
    var backendActions = normalizeRecoveryActions(
      o.recoveryActions || o.recovery_actions,
      nextAction,
      nextActionLabel
    );
    if (backendActions.length) {
      actions = backendActions.map(function mapRecoveryAction(action, index) {
        return buildActionButton(action, {
          callId: callId,
          sessionId: sessionId,
          messageId: messageId,
          errorClass: errorClass,
          primary: severity === 'danger' && index === 0,
        });
      }).filter(Boolean);
      actionIds = backendActions.map(function mapRecoveryActionId(action) {
        return action.id;
      });
    }
    /* Lockdown refusal actions are local-only (the backend gate has no
     * recovery_actions of its own) and apply regardless of card severity --
     * unlike the danger-only synthesis below, this is the ONLY source of
     * actions for this code, so it must not be gated on backendActions.length
     * or severity. */
    if (isLockdownRefusal) {
      // The local refusal contract is exact. Do not let stale or synthesized
      // backend recovery metadata replace one of the three usable exits.
      actions = [];
      actionIds = [];
      actions.push(buildActionButton({ id: 'lockdown_off', label: 'Turn lockdown off' }, {
        sessionId: sessionId,
        errorClass: 'lockdown',
        primary: true,
      }));
      actionIds.push('lockdown_off');
      actions.push(buildActionButton({ id: 'switch_local_model', label: 'Switch to a local model' }, {
        sessionId: sessionId,
        errorClass: 'lockdown',
      }));
      actionIds.push('switch_local_model');
      /* The refused turn is already in the transcript (the gate runs after the
       * user message is persisted), so after either fix the user needs a
       * re-send, not a retype: the standard stream-level retry. */
      actions.push(buildActionButton({ id: 'retry_turn', label: 'Retry turn', icon: 'retry', title: 'Retry the failed turn' }, {
        sessionId: sessionId,
        errorClass: 'lockdown',
      }));
      actionIds.push('retry_turn');
    }
    var primaryLabelOverride = nextActionLabel;
    function applyPrimaryLabel(defaultLabel) {
      if (primaryLabelOverride) {
        var label = primaryLabelOverride;
        primaryLabelOverride = '';
        return label;
      }
      return defaultLabel;
    }

    /* Local action synthesis only applies to danger cards — calm cards
     * render backend-supplied actions verbatim (W4 adds Regenerate). */
    if (severity === 'danger' && !isLockdownRefusal) {
      if (!actions.length && (errorClass === 'transport' || errorClass === 'loop' || retryable)) {
        actions.push(buildActionButton({ id: 'retry', label: applyPrimaryLabel('Retry'), icon: 'retry', title: 'Retry this request' }, {
          callId: callId,
          sessionId: sessionId,
          messageId: messageId,
          errorClass: errorClass,
          primary: true,
        }));
        actionIds.push('retry');
      }

      if (!actions.length && errorClass === 'provider') {
        actions.push(buildActionButton({ id: 'settings', label: applyPrimaryLabel('Settings'), icon: 'settings' }, {
          errorClass: errorClass,
          primary: true,
        }));
        actionIds.push('settings');
      }

      if (!actions.length && errorClass === 'tool' && callId) {
        actions.push(buildActionButton({ id: 'retry-tool', label: applyPrimaryLabel('Retry tool'), icon: 'retry', title: 'Retry this tool call' }, {
          callId: callId,
          messageId: messageId,
          errorClass: errorClass,
          primary: true,
        }));
        actions.push(buildActionButton({ id: 'skip-tool', label: 'Skip', icon: 'skip', title: 'Skip this tool call and continue' }, {
          callId: callId,
          errorClass: errorClass,
          muted: true,
        }));
        actionIds.push('retry-tool', 'skip-tool');
      }

      if (!actions.length && errorClass === 'context') {
        actions.push(buildActionButton({ id: 'new-session', label: applyPrimaryLabel('New session') }, {
          errorClass: errorClass,
          primary: true,
        }));
        actionIds.push('new-session');
      }

      /* A config/setup error (e.g. no workspace root) is fixed in Settings, not by retry —
       * lead with Settings (the universal-retry fallback below is suppressed for this class). */
      if (!actions.length && errorClass === 'setup') {
        actions.push(buildActionButton({ id: 'settings', label: applyPrimaryLabel('Open settings'), icon: 'settings' }, {
          errorClass: errorClass,
          primary: true,
        }));
        actionIds.push('settings');
      }
    }

    /* Retryable cards with a resolvable target message get a fallback retry
     * when recovery metadata did not already provide one. Provider-class
     * failures count even when isRetryable() said no: a generation error is
     * re-sendable by nature (the dedupe regression guard pins Retry-primary
     * for CMP-AI-0005), while setup/context stay excluded — fixing those in
     * Settings or a new session, not by re-sending the same request. */
    var hasRetryLikeAction = actionIds.some(function isRetryLike(id) {
      return id === 'retry' || id === 'retry_turn' || id === 'retry-tool';
    });
    if (messageId && !hasRetryLikeAction && (retryable || errorClass === 'provider')) {
      var universalRetry = buildActionButton({
        id: 'retry',
        label: severity === 'calm' ? 'Regenerate response' : 'Retry',
        icon: 'retry',
      }, {
        callId: callId,
        sessionId: sessionId,
        messageId: messageId,
        errorClass: errorClass,
        muted: severity === 'calm',
        primary: severity === 'danger',
      });
      if (universalRetry) {
        if (severity === 'calm') {
          actions.push(universalRetry);
        } else {
          actions.unshift(universalRetry);
        }
      }
    }
    actions = actions.filter(Boolean);

    /* Cap VISIBLE top-level buttons to 2 (danger cards only — calm cards
     * render backend-supplied actions verbatim, per W4): the leading
     * primary action (whatever the chain above produced at index 0) +
     * "View in logs". Anything else backend/local synthesis produced
     * (open_settings, open_diagnostics, skip-tool, start_new_session,
     * restart_sidecar, ...) demotes into the Details disclosure as a
     * link-styled action instead of being dropped — same buildActionButton()
     * wiring, just relocated. */
    var demotedActions = [];
    if (severity === 'danger') {
      var primaryAction = actions.length ? actions[0] : '';
      demotedActions = actions.slice(1);
      actions = primaryAction ? [primaryAction] : [];
    }

    /* Surface the logs deep-link as the 2nd top-level action (promoted out
     * of the Details panel for discoverability). Danger cards only; calm
     * cards stay minimal (the user asked it to stop). */
    if (severity === 'danger') {
      var logsButton = buildActionButton({ id: 'open_logs', label: 'View in logs' }, {
        sessionId: sessionId,
        messageId: messageId,
        errorClass: errorClass,
        streamId: streamId,
        muted: true,
      });
      if (logsButton) actions.push(logsButton);
    }
    actions = actions.filter(Boolean);

    /* Collapsed diagnostics — danger cards only. Carries copy-paste
     * context (time / code / ids) instead of echoing the already-visible
     * code + message, so opening Details is actually worthwhile. Also
     * absorbs (a) demoted action buttons beyond the 2-button cap above,
     * rendered as inline text-link actions, and (b) same-turn suppressed
     * tool-level errors folded in by the caller (renderer-turn-row-render-utils.js). */
    var detailsMarkup = '';
    if (severity === 'danger') {
      var diagnosticLines = [];
      if (createdAt) diagnosticLines.push('Time:    ' + createdAt);
      if (errorCode) diagnosticLines.push('Code:    ' + errorCode);
      if (sessionId) diagnosticLines.push('Session: ' + sessionId);
      if (messageId) diagnosticLines.push('Msg ID:  ' + messageId);
      var suppressedErrors = Array.isArray(o.suppressedErrors) ? o.suppressedErrors : [];
      for (var s = 0; s < suppressedErrors.length; s++) {
        var suppressed = suppressedErrors[s] || {};
        var suppressedCode = normalizeActionText(suppressed.code);
        var suppressedMessage = normalizeActionText(suppressed.message);
        if (!suppressedCode && !suppressedMessage) continue;
        diagnosticLines.push('Also: ' + (suppressedCode ? suppressedCode + ' — ' : '') + suppressedMessage);
      }
      var rawDetailText = diagnosticLines.length
        ? diagnosticLines.join('\n')
        : 'No additional diagnostic data available.';
      // Same buildActionButton() markup, just relocated into Details — add
      // the one new modifier class (styled as a link, not a button) onto
      // the existing class="inv-error-action ..." attribute without forking
      // buildActionButton's data-* attribute wiring.
      var demotedActionsMarkup = demotedActions.length
        ? '<div class="chat-error-card-details-actions">' + demotedActions.join('').replace(
            /class="inv-error-action/g,
            'class="inv-error-action chat-error-card-details-action'
          ) + '</div>'
        : '';
      detailsMarkup = '<details class="chat-error-card-details">'
        + '<summary class="chat-error-card-details-summary">Details</summary>'
        + '<pre class="chat-error-card-raw">' + escapeHtml(rawDetailText) + '</pre>'
        + demotedActionsMarkup
        + '</details>';
    }

    var showMessage = message && message.toLowerCase() !== title.toLowerCase();
    /* Persisted scrollback entry, not a live toast: render as a static
     * labelled region so screen readers don't re-announce the card on
     * every timeline re-render. Fresh-error announcement is the toast
     * layer's job (renderer-toast-utils.js, role=alert/status). */
    var ariaLabel = severity === 'calm' ? title : ('Error: ' + title);
    var roleAttrs = ' role="group" aria-label="' + escapeHtml(ariaLabel) + '"';

    return '<div class="chat-error-card chat-error-card--' + severity + '"'
      + roleAttrs
      + ' data-error-severity="' + severity + '"'
      + (errorCode ? ' data-error-code="' + escapeHtml(errorCode) + '"' : '')
      + '>'
      + '<div class="chat-error-card-head">'
      + '<span class="chat-error-card-icon" aria-hidden="true">' + (CARD_ICONS[severity] || '') + '</span>'
      + '<span class="chat-error-card-title">' + escapeHtml(title) + '</span>'
      + codeBadge
      + '</div>'
      + (showMessage ? '<div class="chat-error-card-message">' + escapeHtml(message) + '</div>' : '')
      + (hint ? '<div class="chat-error-card-hint">' + escapeHtml(hint) + '</div>' : '')
      + detailsMarkup
      + (actions.length > 0
        ? '<div class="chat-error-card-actions">' + actions.join('') + '</div>'
        : '')
      + '</div>';
  }

  /**
   * Render the unified timeline error card from a message-shaped input
   * (stream_error / error_code / recovery_* fields). This is the
   * canonical entry point for timeline consumers.
   * @param {Object} message - Message object with stream_error, error_code, etc.
   * @param {Object} [opts]
   * @param {'danger'|'calm'} [opts.severity] - Override derived severity
   * @param {string} [opts.callId] - Tool call ID when rendered at tool level
   * @param {string} [opts.streamId] - Turn stream ID when the caller already
   *   resolved it (the row's turn_id); otherwise derived from the message.
   * @returns {string} HTML string ('' when there is nothing to show)
   */
  function renderTimelineErrorCard(message, opts) {
    var m = message && typeof message === 'object' ? message : {};
    var options = opts && typeof opts === 'object' ? opts : {};
    var errorCode = String(m.error_code || m.errorCode || '').trim();
    var terminalSubcode = normalizeToken(m.terminal_subcode || m.terminalSubcode);
    /* WO-12c: a session-lockdown refusal is an expected, user-caused stop
     * (like cancelled/denied), not a crash -- render it calm even though its
     * terminal status is 'runtime_error' (resolveErrorSeverity would
     * otherwise call it 'danger'). An explicit opts.severity still wins. */
    var isLockdownRefusal = normalizeToken(errorCode) === LOCKDOWN_REMOTE_ENGINE_CODE
      || terminalSubcode === LOCKDOWN_REMOTE_ENGINE_CODE;
    var severity = options.severity === 'calm' || options.severity === 'danger'
      ? options.severity
      : (isLockdownRefusal ? 'calm' : resolveErrorSeverity(m));
    var errorText = normalizeActionText(m.stream_error) || normalizeActionText(m.streamError);
    if (severity !== 'calm' && !errorText && !errorCode && !hasRecoveryMetadata(m)) {
      return '';
    }
    /* EH-W11: feed the error center on render. The recorder global is
     * flag-gated and dedupes by message id, so re-renders are no-ops;
     * calm cards map to info, which the store does not keep. */
    if (typeof globalThis !== 'undefined' && typeof globalThis.rendererErrorCenterRecord === 'function') {
      try {
        globalThis.rendererErrorCenterRecord({
          key: 'error-card:' + String(m.id || options.messageId || ''),
          code: errorCode,
          title: normalizeActionText(m.recoveryTitle) || normalizeActionText(m.recovery_title) || errorText,
          surface: 'timeline',
          severity: severity === 'calm' ? 'info' : 'danger',
        });
      } catch (_err) { /* history is best-effort */ }
    }
    return renderErrorRecovery({
      severity: severity,
      errorCode: errorCode,
      terminalSubcode: terminalSubcode,
      message: errorText,
      sessionId: m.session_id || m.sessionId || options.sessionId,
      messageId: m.id || options.messageId,
      streamId: resolveErrorStreamId(m, options),
      createdAt: m.created_at || m.createdAt || m.timestamp || m.ts || options.createdAt,
      callId: options.callId,
      retryable: typeof m.retryable === 'boolean' ? m.retryable : undefined,
      recoveryTitle: m.recoveryTitle || m.recovery_title,
      recoveryHint: m.recoveryHint || m.recovery_hint,
      recoveryClass: m.recoveryClass || m.recovery_class,
      nextActionLabel: m.nextActionLabel || m.next_action_label,
      nextAction: m.nextAction || m.next_action,
      recoveryActions: m.recoveryActions || m.recovery_actions,
      suppressedErrors: Array.isArray(m.suppressedErrors) ? m.suppressedErrors : options.suppressedErrors,
    });
  }

  /**
   * Render an assistant failure notice as the unified error card.
   * Kept as the compatibility export for the transcript-thinking
   * adapter; requires a non-empty stream_error like the original.
   * @param {Object} message - Message object with stream_error, error_code, etc.
   * @returns {string} HTML string
   */
  function renderEnhancedFailureNotice(message) {
    var m = message && typeof message === 'object' ? message : {};
    if (!normalizeActionText(m.stream_error) && !normalizeActionText(m.streamError)) {
      return '';
    }
    return renderTimelineErrorCard(m);
  }

  return {
    classifyError: classifyError,
    isRetryable: isRetryable,
    resolveErrorSeverity: resolveErrorSeverity,
    renderErrorRecovery: renderErrorRecovery,
    renderTimelineErrorCard: renderTimelineErrorCard,
    renderEnhancedFailureNotice: renderEnhancedFailureNotice,
    buildActionButton: buildActionButton,
    buildErrorCodeChip: buildErrorCodeChip,
    resolveErrorStreamId: resolveErrorStreamId,
    LOGS_LINK_TITLE: LOGS_LINK_TITLE,
  };
});
