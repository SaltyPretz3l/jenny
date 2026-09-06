const {
  AI_ERROR_CODES,
  CLOUD_ERROR_CODES,
  SIDECAR_ERROR_CODES,
  SIDECAR_TERMINAL_SUBCODES,
} = require('./error-codes');

const RECOVERY_ACTIONS = Object.freeze({
  retry_turn: Object.freeze({
    id: 'retry_turn',
    kind: 'retry',
    label: 'Retry turn',
    priority: 10,
  }),
  restart_sidecar: Object.freeze({
    id: 'restart_sidecar',
    kind: 'restart',
    label: 'Restart sidecar',
    priority: 20,
  }),
  open_diagnostics: Object.freeze({
    id: 'open_diagnostics',
    kind: 'diagnostics',
    label: 'Open diagnostics',
    priority: 30,
  }),
  open_settings: Object.freeze({
    id: 'open_settings',
    kind: 'settings',
    label: 'Open settings',
    priority: 20,
  }),
  start_new_session: Object.freeze({
    id: 'start_new_session',
    kind: 'new_session',
    label: 'Start new session',
    priority: 20,
  }),
});

const ASSISTANT_ERROR_RECOVERY_TOKEN_FIELDS = Object.freeze([
  'terminal_status',
  'recovery_class',
  'next_action',
]);

const ASSISTANT_ERROR_RECOVERY_TEXT_FIELDS = Object.freeze([
  'recovery_title',
  'recovery_hint',
  'next_action_label',
]);

const RECOVERY_COPY = Object.freeze({
  cancelled: Object.freeze({
    title: 'Turn cancelled',
    hint: 'This turn was cancelled before it completed.',
  }),
  denied: Object.freeze({
    title: 'Tool denied',
    hint: 'The requested tool did not run because approval was denied.',
  }),
  sidecar_transport: Object.freeze({
    title: 'Sidecar connection issue',
    hint: 'Restart the local sidecar if it does not reconnect, then retry this turn.',
  }),
  timeout: Object.freeze({
    title: 'Request timed out',
    hint: 'The local sidecar took too long to respond. Retry the turn or open diagnostics if it repeats.',
  }),
  turn_deadline: Object.freeze({
    title: 'Turn working-time limit reached',
    hint: 'Jenny reached the local working-time limit before finishing. Retry, or raise Turn working-time limit in Settings → Developer → Advanced.',
  }),
  thinking_budget: Object.freeze({
    title: 'Hit its thinking budget',
    hint: "The model kept reasoning past its budget without finishing. Retry, lower the reasoning effort, or raise this model's context in Settings.",
  }),
  transport: Object.freeze({
    title: 'Connection issue',
    hint: 'The request may succeed on retry. Open diagnostics if the connection keeps failing.',
  }),
  provider: Object.freeze({
    title: 'Provider issue',
    hint: 'Check the model or provider settings, then retry the turn.',
  }),
  provider_rate_limited: Object.freeze({
    title: 'Provider rate limit',
    hint: 'Rate limit reached. Wait a moment, then retry this turn.',
  }),
  tool: Object.freeze({
    title: 'Tool failed',
    hint: 'Retry the tool or open diagnostics if the same tool keeps failing.',
  }),
  context: Object.freeze({
    title: 'Context limit reached',
    hint: 'Start a new session or simplify the request before trying again.',
  }),
  setup: Object.freeze({
    title: 'Setup required',
    hint: 'Open Settings to set a workspace root, then try again.',
  }),
  runtime: Object.freeze({
    title: 'Model stopped responding',
    hint: 'Usually clears on a retry — open diagnostics if it keeps happening.',
  }),
  retryable: Object.freeze({
    title: 'Retry available',
    hint: 'The failure looks temporary. Retry the turn.',
  }),
  unknown: Object.freeze({
    title: 'Turn failed',
    hint: 'Open diagnostics if this keeps happening.',
  }),
});

function cloneJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry));
  }
  if (value && typeof value === 'object') {
    const cloned = {};
    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneJsonValue(entry);
    }
    return cloned;
  }
  return value;
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function cloneAction(actionId) {
  const action = RECOVERY_ACTIONS[actionId];
  return action ? { ...action } : null;
}

function isSidecarTransportCode(code) {
  return code === SIDECAR_ERROR_CODES.PROCESS_EXIT
    || code === SIDECAR_ERROR_CODES.TRANSPORT
    || code === SIDECAR_ERROR_CODES.TIMEOUT
    || code === SIDECAR_ERROR_CODES.ABORTED;
}

function isRateLimitPayload(errorPayload) {
  const payload = errorPayload && typeof errorPayload === 'object' && !Array.isArray(errorPayload)
    ? errorPayload
    : {};
  const code = normalizeCode(payload.error_code || payload.code);
  if (code === AI_ERROR_CODES.RATE_LIMIT || code === CLOUD_ERROR_CODES.RATE_LIMITED) {
    return true;
  }
  return /rate.?limit/i.test(String(
    payload.message || payload.detail || payload.error || ''
  ));
}

function recoveryCopyForClass(recoveryClass, errorPayload, nextAction) {
  const key = recoveryClass === 'provider' && isRateLimitPayload(errorPayload)
    ? 'provider_rate_limited'
    : recoveryClass;
  const copy = RECOVERY_COPY[key] || RECOVERY_COPY.unknown;
  return {
    recovery_title: copy.title,
    recovery_hint: copy.hint,
    next_action_label: RECOVERY_ACTIONS[nextAction]?.label || '',
  };
}

function classifyAssistantError(errorPayload, {
  terminalStatus = '',
  terminalSubcode = '',
} = {}) {
  const payload = errorPayload && typeof errorPayload === 'object' && !Array.isArray(errorPayload)
    ? errorPayload
    : {};
  const code = normalizeCode(payload.error_code || payload.code);
  const category = normalizeToken(payload.category);
  const status = normalizeToken(payload.status || payload.terminal_status || terminalStatus);
  const subcode = normalizeToken(payload.terminal_subcode || terminalSubcode);

  if (status === 'cancelled' || category === 'cancelled') {
    return 'cancelled';
  }
  if (status === 'denied' || category === 'denied') {
    return 'denied';
  }
  if (subcode === 'thinking_budget') {
    return 'thinking_budget';
  }
  if (
    (status === 'timeout' || category === 'timeout')
    && subcode === SIDECAR_TERMINAL_SUBCODES.TURN_TIMEOUT
  ) {
    return 'turn_deadline';
  }
  if (
    category === 'process_exit'
    || subcode === SIDECAR_TERMINAL_SUBCODES.CRASH
    || subcode === SIDECAR_TERMINAL_SUBCODES.RECONNECT_FAILED
    || subcode === SIDECAR_TERMINAL_SUBCODES.RECONNECT_IN_PROGRESS
    || isSidecarTransportCode(code)
  ) {
    return 'sidecar_transport';
  }
  if (category === 'timeout') {
    return 'timeout';
  }
  if (category === 'transport') {
    return 'transport';
  }
  if (category === 'provider' || code.startsWith('CMP-AI-') || code.startsWith('CMP-CLOUD-')) {
    return 'provider';
  }
  if (
    category === 'tool'
    || code.startsWith('CMP-TOOL-')
    || code.startsWith('CMP-MCP-')
    || code.startsWith('CMP-WEB-')
    || code.startsWith('CMP-TSRCH-')
  ) {
    return 'tool';
  }
  if (category === 'setup' || code.startsWith('CMP-CFG-')) {
    return 'setup';
  }
  if (category === 'context' || code.startsWith('CMP-CTX-')) {
    return 'context';
  }
  if (
    category === 'loop'
    || code.startsWith('CMP-LOOP-')
    || code.startsWith('CMP-INTERACTIVE-')
    || code.startsWith('CMP-CHAT-')
  ) {
    return 'runtime';
  }
  return payload.retryable === true ? 'retryable' : 'unknown';
}

function recoveryActionIdsForClass(recoveryClass, errorPayload) {
  const payload = errorPayload && typeof errorPayload === 'object' && !Array.isArray(errorPayload)
    ? errorPayload
    : {};
  const retryable = payload.retryable !== false;
  switch (recoveryClass) {
    case 'thinking_budget':
      return ['retry_turn', 'open_settings', 'open_diagnostics'];
    case 'sidecar_transport':
      return ['retry_turn', 'restart_sidecar', 'open_diagnostics'];
    case 'timeout':
    case 'turn_deadline':
    case 'transport':
    case 'runtime':
    case 'retryable':
      return ['retry_turn', 'open_diagnostics'];
    case 'provider':
      return retryable
        ? ['retry_turn', 'open_settings', 'open_diagnostics']
        : ['open_settings', 'open_diagnostics'];
    case 'tool':
      return retryable
        ? ['retry_turn', 'open_diagnostics']
        : ['open_diagnostics'];
    case 'context':
      return ['start_new_session', 'open_diagnostics'];
    case 'setup':
      return ['open_settings', 'open_diagnostics'];
    default:
      return [];
  }
}

function buildAssistantErrorRecoveryMetadata(errorPayload, options = {}) {
  const recoveryClass = classifyAssistantError(errorPayload, options);
  const recoveryActions = recoveryActionIdsForClass(recoveryClass, errorPayload)
    .map(cloneAction)
    .filter(Boolean);
  const nextAction = recoveryActions[0]?.id || '';
  return {
    recovery_class: recoveryClass,
    next_action: nextAction,
    recovery_actions: recoveryActions,
    ...recoveryCopyForClass(recoveryClass, errorPayload, nextAction),
  };
}

function copyAssistantErrorRecoveryMetadata(target, source) {
  const output = target && typeof target === 'object' && !Array.isArray(target)
    ? target
    : {};
  const metadata = source && typeof source === 'object' && !Array.isArray(source)
    ? source
    : {};
  for (const key of ASSISTANT_ERROR_RECOVERY_TOKEN_FIELDS) {
    const value = normalizeToken(metadata[key]);
    if (!output[key] && value) {
      output[key] = value;
    }
  }
  for (const key of ASSISTANT_ERROR_RECOVERY_TEXT_FIELDS) {
    const value = String(metadata[key] || '').trim();
    if (!output[key] && value) {
      output[key] = value;
    }
  }
  if (
    !Array.isArray(output.recovery_actions)
    && Array.isArray(metadata.recovery_actions)
  ) {
    output.recovery_actions = cloneJsonValue(metadata.recovery_actions);
  }
  return output;
}

function buildAssistantErrorRecoveryFields(errorPayload, options = {}) {
  const fields = copyAssistantErrorRecoveryMetadata(
    {},
    buildAssistantErrorRecoveryMetadata(errorPayload, options)
  );
  if (Array.isArray(fields.recovery_actions) && fields.recovery_actions.length === 0) {
    delete fields.recovery_actions;
  }
  return fields;
}

module.exports = {
  buildAssistantErrorRecoveryFields,
  buildAssistantErrorRecoveryMetadata,
  classifyAssistantError,
  copyAssistantErrorRecoveryMetadata,
};
