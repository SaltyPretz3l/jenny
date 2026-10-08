'use strict';

const path = require('path');
const { executeHostedRunCommand } = require('./hosted-command-bridge');

const { TOOL_ERROR_CODES } = require('./error-codes');
const { getTrustedExecutionBinding } = require('./session-execution-authority');
const { withQuestionWithdrawal } = require('./runtime-decision-control');

const MAX_BRIDGE_METADATA_DEPTH = 6;
const MAX_BRIDGE_METADATA_ITEMS = 100;
const MAX_BRIDGE_METADATA_STRING_LENGTH = 20_000;
const SENSITIVE_METADATA_VALUE_PATTERN = /\b(?:bearer\s+[a-z0-9._~+/=-]{12,}|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{20,})\b/i;

const ELECTRON_BRIDGE_TOOL_NAMES = new Set([
  'jenny_status',
  'session_spawn',
  'session_wait',
  'session_result',
  'worktree_list',
  'worktree_create',
  'worktree_select',
  'worktree_delete',
  'automation_list',
  'automation_read',
  'workspace_present',
  'preview_test',
  'verify',
  'image_generate',
  'home',
  'task_board',
  'project_notes',
  'exit_plan_mode',
  'ask_user',
]);

function normalizeBridgeArguments(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeArtifactDimension(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function normalizeArtifactText(value) {
  return sanitizeBridgeMetadataString(value).trim();
}

function normalizeArtifactDisplayPath(value) {
  const raw = String(value || '').trim();
  if (SENSITIVE_METADATA_VALUE_PATTERN.test(raw)) return '';
  return raw.length > MAX_BRIDGE_METADATA_STRING_LENGTH
    ? raw.slice(0, MAX_BRIDGE_METADATA_STRING_LENGTH)
    : raw;
}

function containsUnsafePathFragment(value) {
  if (!value || typeof value !== 'string') return true;
  return value.includes('..') || value.includes('\0');
}

function isSafeDisplayPath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized || containsUnsafePathFragment(normalized)) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(normalized)) return false;
  if (normalized.startsWith('/') || normalized.startsWith('//')) return false;
  return true;
}

function normalizeGeneratedArtifacts(value) {
  return Array.isArray(value)
    ? value
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => {
        const artifactKind = normalizeArtifactText(entry.artifact_kind);
        return {
          artifact_id: normalizeArtifactText(entry.artifact_id),
          artifact_kind: artifactKind,
          title: normalizeArtifactText(entry.title),
          file_name: normalizeArtifactText(entry.file_name),
          display_path: normalizeArtifactDisplayPath(entry.display_path),
          language: normalizeArtifactText(entry.language),
          mime_type: normalizeArtifactText(entry.mime_type || entry.mimeType),
          width: normalizeArtifactDimension(entry.width),
          height: normalizeArtifactDimension(entry.height),
          editable: artifactKind === 'image' ? false : entry.editable === true,
          status: normalizeArtifactText(entry.status || 'available') || 'available',
        };
      })
      .filter((entry) => (
        entry.artifact_id
        && entry.title
        && entry.file_name
        && isSafeDisplayPath(entry.display_path)
      ))
    : [];
}

function normalizeLocalGeneratedArtifacts(value) {
  return Array.isArray(value)
    ? value
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => ({
        ...entry,
        artifact_id: String(entry.artifact_id || '').trim(),
        display_path: String(entry.display_path || '').trim(),
        absolute_path: String(entry.absolute_path || '').trim(),
      }))
      .filter((entry) => (
        entry.artifact_id
        && entry.display_path
        && entry.absolute_path
        && isSafeDisplayPath(entry.display_path)
        && !containsUnsafePathFragment(entry.absolute_path)
      ))
    : [];
}

function isSensitiveMetadataKey(key) {
  return /(absolute|local|path|file|token|secret|password|credential|key)/iu.test(String(key || ''));
}

function sanitizeBridgeMetadataString(value) {
  const raw = String(value || '');
  if (SENSITIVE_METADATA_VALUE_PATTERN.test(raw)) {
    return '[redacted]';
  }
  return raw.length > MAX_BRIDGE_METADATA_STRING_LENGTH
    ? raw.slice(0, MAX_BRIDGE_METADATA_STRING_LENGTH)
    : raw;
}

function sanitizeBridgeMetadataValue(value, depth = 0) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return sanitizeBridgeMetadataString(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (depth >= MAX_BRIDGE_METADATA_DEPTH) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_BRIDGE_METADATA_ITEMS)
      .map((entry) => sanitizeBridgeMetadataValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (value && typeof value === 'object') {
    const sanitized = {};
    let entryCount = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (entryCount >= MAX_BRIDGE_METADATA_ITEMS) break;
      entryCount += 1;
      if (isForbiddenMetadataKey(key) || isSensitiveMetadataKey(key)) {
        continue;
      }
      const rawValue = value[key];
      const cleaned = sanitizeBridgeMetadataValue(rawValue, depth + 1);
      if (cleaned !== undefined) {
        sanitized[key] = cleaned;
      }
    }
    return sanitized;
  }
  return undefined;
}

function isForbiddenMetadataKey(key) {
  return ['__proto__', 'prototype', 'constructor', 'preview_image', 'previewImage',
    'data_base64', 'trusted_attachments'].includes(key);
}

function sanitizeBridgeMetadata(value) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const sanitized = {};
  for (const [key, rawValue] of Object.entries(metadata)) {
    if (key === 'generatedArtifacts' || key === 'generated_artifacts'
      || isForbiddenMetadataKey(key) || isSensitiveMetadataKey(key)) {
      continue;
    }
    const cleaned = sanitizeBridgeMetadataValue(rawValue, 0);
    if (cleaned !== undefined) {
      sanitized[key] = cleaned;
    }
  }
  return sanitized;
}

function rememberLocalGeneratedArtifacts(service, { streamId, callId, artifacts }) {
  const normalizedStreamId = String(streamId || '').trim();
  const normalizedCallId = String(callId || '').trim();
  const list = normalizeLocalGeneratedArtifacts(artifacts);
  if (!service || !normalizedCallId || !list.length) {
    return;
  }
  if (!(service._electronToolGeneratedArtifactsByCall instanceof Map)) {
    service._electronToolGeneratedArtifactsByCall = new Map();
  }
  const key = `${normalizedStreamId}|${normalizedCallId}`;
  service._electronToolGeneratedArtifactsByCall.set(key, list);
  while (service._electronToolGeneratedArtifactsByCall.size > 100) {
    const oldest = service._electronToolGeneratedArtifactsByCall.keys().next().value;
    if (!oldest) break;
    service._electronToolGeneratedArtifactsByCall.delete(oldest);
  }
}

function resolveConfiguredWorkspaceRoot(service) {
  try {
    // Narrow getter per tool call (no whole-config clone); getState for duck-typed config services.
    const config = service?.configService;
    const root = typeof config?.getToolsWorkspaceRoot === 'function'
      ? config.getToolsWorkspaceRoot()
      : config?.getState?.()?.toolsWorkspaceRoot;
    const workspaceRoot = typeof root === 'string' ? root.trim() : '';
    return workspaceRoot ? path.resolve(workspaceRoot) : '';
  } catch (error) {
    service?._emitServiceLog?.('WARN', 'electron_tool_bridge.workspace_root_lookup_failed', {
      message: error?.message || String(error),
    });
    return '';
  }
}

function bridgeFailure(toolName, output, errorCode = TOOL_ERROR_CODES.EXECUTION_FAILED) {
  return {
    tool_name: String(toolName || 'electron_tool').trim() || 'electron_tool',
    output: String(output || 'Electron tool bridge failed.'),
    success: false,
    content_type: 'text',
    generated_artifacts: [],
    error_code: String(errorCode || TOOL_ERROR_CODES.EXECUTION_FAILED),
    metadata: {
      result_kind: 'electron_tool_bridge',
    },
  };
}


const { executeSandboxCommand, sandboxEnabled, ALLOWED: SANDBOX_BRIDGE_TOOLS } = require('../execution/command-bridge');
const { trackSandboxBridgeRequest } = require('../execution/execution-settlement');

async function executeElectronToolRequest(
  service,
  {
    params,
    sessionId,
    streamId,
    abortSignal = null,
    executionAuthority = null,
    sandboxAuthorization = null,
    canonicalReadOnly = true,
    runtimeDecisionControl = null,
    logicalTurnId = null,
    beforeProducer = null,
  } = {}
) {
  const payload = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const toolName = String(payload.tool_name || '').trim();
  const callId = String(payload.tool_call_id || '').trim() || `electron_tool_${Date.now()}`;
  const input = normalizeBridgeArguments(payload.arguments);
  const planDecision = String(payload.plan_decision || '').trim().slice(0, 40);
  const planFeedback = String(payload.plan_feedback || '').trim().slice(0, 800);
  const editedPlan = payload.edited_plan && typeof payload.edited_plan === 'object'
    && !Array.isArray(payload.edited_plan) ? payload.edited_plan : null;
  const trustedExecution = getTrustedExecutionBinding(executionAuthority);
  if (executionAuthority && !trustedExecution) {
    return bridgeFailure(toolName, 'Session execution authority is invalid or expired.',
      TOOL_ERROR_CODES.DISABLED);
  }
  try {
    trustedExecution?.assertCurrent();
  } catch (_error) {
    return bridgeFailure(toolName, 'Session execution authority is stale or cancelled.',
      TOOL_ERROR_CODES.DISABLED);
  }
  const scopedSessionId = trustedExecution?.sessionId
    || String(sessionId || payload.session_id || '').trim();
  const scopedStreamId = trustedExecution?.requestId
    || String(streamId || payload.request_id || '').trim();
  const effectivePlanMode = trustedExecution
    ? trustedExecution.mode === 'plan'
    : typeof payload.plan_mode === 'boolean' ? payload.plan_mode : true;
  const effectiveReadOnly = trustedExecution
    ? trustedExecution.readOnly
    : typeof payload.read_only === 'boolean' ? payload.read_only : true;

  if (service?.hostMode === 'server' && toolName === 'run_command') {
    if (effectivePlanMode || effectiveReadOnly) {
      return bridgeFailure(toolName, 'Command execution is unavailable in read-only or plan mode.', TOOL_ERROR_CODES.DISABLED);
    }
    return executeHostedRunCommand(service, {
      input,
      sessionId: scopedSessionId,
      streamId: scopedStreamId,
      abortSignal,
      projectAuthority: trustedExecution?.authority || null,
      executionAuthority, callId, beforeProducer,
    }, { bridgeFailure, sanitizeBridgeMetadata, maxOutputChars: MAX_BRIDGE_METADATA_STRING_LENGTH });
  }

  if (sandboxEnabled(service)) {
    if (!SANDBOX_BRIDGE_TOOLS.has(toolName)) return bridgeFailure(toolName, 'This execution path is unavailable in Docker sandbox mode.', TOOL_ERROR_CODES.DISABLED);
    if (toolName === 'run_command') {
      if (!payload.tool_call_id) return bridgeFailure(toolName, 'Sandbox call identity is required.');
      return executeSandboxCommand(service, { input, sessionId: scopedSessionId,
        streamId: scopedStreamId, callId, abortSignal,
        readOnly: effectiveReadOnly, planMode: effectivePlanMode, authorize: sandboxAuthorization,
        canonicalReadOnly, projectAuthority: trustedExecution?.authority || null, executionAuthority, beforeProducer });
    }
  }
  if (service?.hostMode === 'server' && !['ask_user', 'exit_plan_mode'].includes(toolName)) {
    return bridgeFailure(toolName, 'Tool is unavailable in the hosted execution policy.', TOOL_ERROR_CODES.DISABLED);
  }

  // __jenny_git_checkpoint is an internal sidecar-originated op (auto-checkpoint
  // before the first repo mutation of a run), never model-callable. It routes
  // straight to WorkspaceGitService.createCheckpoint and MUST bypass
  // toolExecutor.executePreApproved entirely, so no policy/plan-mode/approval
  // checks apply — hence this special-case runs before the allowlist check.
  if (toolName === '__jenny_git_checkpoint') {
    const gitService = trustedExecution
      ? trustedExecution.services.workspaceGitService
      : service?.workspaceGitService;
    if (!gitService || typeof gitService.createCheckpoint !== 'function') {
      return bridgeFailure(toolName, 'Auto-checkpoint git service unavailable.');
    }
    let result;
    try {
      result = await gitService.createCheckpoint({
        session: scopedSessionId,
        signal: abortSignal,
        // A clean tree still gets a ref: the run's restore point (row 34 S5).
        allowClean: true,
      });
    } catch (error) {
      return bridgeFailure(toolName, `Auto-checkpoint failed: ${error?.message || String(error)}`);
    }
    // `result` is always a non-null object here — createCheckpoint returns an
    // object on every path and a throw was already caught above — so no
    // `result &&` guards are needed below.
    const created = result.created === true;
    return {
      tool_name: toolName,
      output: created
        ? `checkpoint ${result.ref}`
        : `no checkpoint (${result.reason || 'skipped'})`,
      success: result.ok !== false,
      content_type: 'text',
      generated_artifacts: [],
      error_code: null,
      metadata: {
        result_kind: 'auto_checkpoint',
        created,
        ref: result.ref || '',
        sequence: result.sequence || 0,
        reason: result.reason || '',
      },
    };
  }

  if (!ELECTRON_BRIDGE_TOOL_NAMES.has(toolName)) {
    return bridgeFailure(
      toolName,
      `Electron tool bridge rejected unsupported tool "${toolName || 'unknown'}".`,
      TOOL_ERROR_CODES.UNKNOWN
    );
  }

  const toolExecutor = service?.toolExecutor;
  if (!toolExecutor || typeof toolExecutor.executePreApproved !== 'function') {
    return bridgeFailure(toolName, 'Electron tool bridge is unavailable.');
  }

  const workingDirectory = trustedExecution
    ? trustedExecution.authority.root_path || ''
    : resolveConfiguredWorkspaceRoot(service);
  const result = await toolExecutor.executePreApproved(
    { callId, toolName, input },
    {
      planMode: effectivePlanMode,
      readOnly: effectiveReadOnly,
      planDecision,
      planFeedback,
      planEditedPlan: editedPlan,
      sessionId: scopedSessionId,
      streamId: scopedStreamId,
      logicalTurnId,
      workingDirectory,
      backendService: service,
      abortSignal,
      executionAuthority,
      projectAuthority: trustedExecution?.authority || null,
      beforeProducer,
      ...(toolName === 'ask_user' && runtimeDecisionControl ? {
        runtimeDecisionControl: withQuestionWithdrawal(runtimeDecisionControl, service, {
          sessionId: scopedSessionId, streamId: scopedStreamId, callId, turnId: logicalTurnId,
        }),
        runtimeDecision: payload.runtime_decision,
      } : {}),
    }
  );
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return bridgeFailure(toolName, 'Electron tool bridge returned a malformed executor result.');
  }
  if (typeof result.isError !== 'boolean') {
    return bridgeFailure(toolName, 'Electron tool bridge result omitted a valid isError flag.');
  }
  const rawMetadata = result && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
    ? { ...result.metadata }
    : {};
  const generatedArtifacts = normalizeGeneratedArtifacts(rawMetadata.generatedArtifacts);
  rememberLocalGeneratedArtifacts(service, {
    streamId: scopedStreamId,
    callId,
    artifacts: rawMetadata.generatedArtifacts,
  });
  const metadata = sanitizeBridgeMetadata(rawMetadata);
  // preview_test screenshots and image_generate pictures reach a vision chat model.
  const carriesPreviewImage = toolName === 'image_generate'
    || (toolName === 'preview_test' && input.screenshot === true);

  return {
    tool_name: toolName,
    output: String(result?.content || ''),
    success: result.isError === false,
    content_type: 'text',
    generated_artifacts: generatedArtifacts,
    error_code: String(result?.errorCode || '').trim() || null,
    metadata,
    ...(carriesPreviewImage && result.isError === false
      && Buffer.isBuffer(result.previewImage?.buffer)
      && result.previewImage.buffer.length <= 2 * 1024 * 1024 ? {
        preview_image: {
          call_id: callId, mime_type: 'image/png',
          data_base64: result.previewImage.buffer.toString('base64'),
          byte_length: result.previewImage.buffer.length,
          width: result.previewImage.width, height: result.previewImage.height,
        },
      } : {}),
  };
}

// "Build it" on an exit_plan_mode card continues the build inside the same
// chat.send with a fresh working-time budget on the sidecar side.
function isPlanBuildApproval(params, result) {
  return params?.tool_name === 'exit_plan_mode'
    && result?.approved === true
    && ['approved', 'approved_auto'].includes(result?.decision);
}

function buildManagedSidecarChatSendOptions({
  service,
  controller,
  streamId,
  resolvedSessionId,
  requestId,
  requestTraceId,
  runtime,
  toolContext,
  handleToolNotification,
  waitForToolApproval,
  turnEventCollector,
  normalizedPreferences,
  timeoutMs,
  noteStreamActivity,
  pauseStreamIdleTimer,
  // Optional turn-effect probes (ChatGPT auth retry). Pure observers: they
  // are called before the real handlers and may never influence them.
  onNotificationObserved,
  onApprovalObserved,
  executionAuthority = null,
}) {
  const recordStreamActivity = typeof noteStreamActivity === 'function'
    ? noteStreamActivity
    : () => {};
  const suspendIdleWatchdog = typeof pauseStreamIdleTimer === 'function'
    ? pauseStreamIdleTimer
    : () => {};
  // The sidecar credits every approval wait to its working-time deadline and
  // gives a plan-build approval a fresh budget (request_dispatch_chat.py
  // _credit_approval_wait / _fresh_build_budget), so the chat.send transport
  // deadline follows the same clock or it fires first (dogfood HB-026).
  const suspendTransportTimeout = () => (
    typeof service.sidecarClient?.suspendRequestTimeout === 'function'
      ? service.sidecarClient.suspendRequestTimeout(requestId)
      : () => {}
  );
  async function waitForAuthorizedToolApproval(params, approvalController = controller) {
    const result = await waitForToolApproval(
      service,
      streamId,
      resolvedSessionId,
      requestId,
      params,
      approvalController,
      turnEventCollector,
      executionAuthority
    );
    const approved = result === true || result?.approved === true;
    if (!approved) return result;
    try {
      service.sessionExecutionAuthority.requireCurrent(executionAuthority);
      service.sessionExecutionAuthority.noteApproved(executionAuthority, {
        operationId: params?.tool_call_id,
        toolName: params?.tool_name,
        arguments: params?.tool_input || params?.arguments || {},
        decision: result?.decision,
      });
      return result;
    } catch (_error) {
      return false;
    }
  }
  return {
    signal: controller.signal,
    timeoutMs,
    onNotification: (notification) => {
      try {
        if (controller.signal.aborted) {
          return;
        }
        // Any observable stream event (token/reasoning/tool) re-arms the idle
        // watchdog so a healthy, actively-producing turn is never timed out.
        recordStreamActivity();
        try {
          onNotificationObserved?.(notification);
        } catch (_probeError) {
          // A probe must never break a turn.
        }
        runtime.handleNotification(notification, {
          toolContext,
          handleToolNotification,
        });
      } catch (handlerError) {
        service._emitServiceLog('ERROR', 'chat.notification_handler_error', {
          sessionId: resolvedSessionId,
          streamId,
          traceId: requestTraceId,
          method: notification?.method,
          message: handlerError?.message || String(handlerError),
        });
      }
    },
    onApprovalRequest: async (params) => {
      // A tool approval can wait on human input for a long time; that is not a
      // hang, so pause the idle watchdog for the duration and re-arm it once the
      // user responds (or the wait resolves/rejects).
      try {
        // An approval REQUEST is a turn effect regardless of its outcome.
        onApprovalObserved?.();
      } catch (_probeError) {
        // A probe must never break a turn.
      }
      // pauseForApproval hands back its own resume; only that call ends the
      // pause. recordStreamActivity() must NOT be used here -- it is the same
      // function every notification calls, so an unrelated event arriving while
      // the user decides would resume the clocks mid-decision.
      const resumeAfterApproval = suspendIdleWatchdog();
      const resumeTransportTimeout = suspendTransportTimeout();
      let freshBudget = false;
      try {
        // The approval wait appends the tool_use row at once, but the text the
        // model wrote before the call is otherwise cut only when the tool
        // starts, after the decision. Stored in that order the commentary is
        // replayed to the model after the tool result it introduced.
        try {
          runtime.persistToolBoundarySegment?.();
        } catch (segmentError) {
          service._emitServiceLog?.('WARN', 'chat.approval_segment_persist_failed', {
            sessionId: resolvedSessionId,
            streamId,
            message: segmentError?.message || String(segmentError),
          });
        }
        const result = await waitForAuthorizedToolApproval(params);
        freshBudget = isPlanBuildApproval(params, result);
        return result;
      } finally {
        resumeTransportTimeout({ freshBudget });
        if (typeof resumeAfterApproval === 'function') {
          resumeAfterApproval({ freshBudget });
        } else {
          // A watchdog stub that pauses without handing back a resume: fall back
          // rather than leave both clocks parked for the rest of the turn.
          recordStreamActivity();
        }
      }
    },
    onElectronToolRequest: require('./runtime-electron-start-gate').createElectronStartGate({
      enabled: params => Boolean(controller._runtimeDecisionControl)
        && params.request_id === streamId && params.session_id === resolvedSessionId
        && (ELECTRON_BRIDGE_TOOL_NAMES.has(params.tool_name) || params.tool_name === 'run_command')
        && !['ask_user', 'exit_plan_mode', 'session_spawn', 'session_wait', 'session_result'].includes(params.tool_name),
      signal: controller.signal,
      execute: async (params, beforeProducer) => {
      if (sandboxEnabled(service) && params?.tool_name === 'run_command') {
        let producerAcknowledged = beforeProducer === null;
        const announceProducer = beforeProducer ? async () => {
          await beforeProducer(); producerAcknowledged = true;
        } : null;
        const resume = suspendIdleWatchdog();
        try {
          return await trackSandboxBridgeRequest(service, streamId, () => executeElectronToolRequest(service, {
            beforeProducer: announceProducer,
            params, sessionId: resolvedSessionId, streamId, abortSignal: controller.signal,
            executionAuthority,
            canonicalReadOnly: normalizedPreferences?.plan_mode !== false
              || toolContext?.readOnly === true || params?.read_only !== false,
            sandboxAuthorization: (approval, signal) => waitForAuthorizedToolApproval(
              approval, { signal: signal || controller.signal }
            ),
          }), result => {
            // The aborted sidecar transport cannot return its tool.result. Settle
            // through the existing persistence path before the terminal barrier.
            if (controller.signal.aborted && producerAcknowledged) runtime.handleNotification({ method: 'tool.result',
              params: { ...result, tool_call_id: params.tool_call_id, tool_input: params.arguments } },
            { toolContext, handleToolNotification });
          });
        } finally { if (typeof resume === 'function') resume(); }
      }
      const suspendsIdle = params?.tool_name === 'ask_user' || params?.tool_name === 'image_generate';
      if (!suspendsIdle) {
        return executeElectronToolRequest(service, {
          beforeProducer,
          params,
          sessionId: resolvedSessionId,
          streamId,
          abortSignal: controller.signal,
          executionAuthority,
        });
      }
      // Human answers and image renders can take minutes without stream activity.
      const resumeAfterAnswers = suspendIdleWatchdog();
      try {
        return await executeElectronToolRequest(service, {
          beforeProducer,
          runtimeDecisionControl: controller._runtimeDecisionControl,
          logicalTurnId: turnEventCollector?.turnId || streamId,
          params,
          sessionId: resolvedSessionId,
          streamId,
          abortSignal: controller.signal,
          executionAuthority,
        });
      } finally {
        if (typeof resumeAfterAnswers === 'function') {
          resumeAfterAnswers();
        } else {
          recordStreamActivity();
        }
      }
    } }),
    onRuntimeOperation: (params) => service.sessionExecutionAuthority
      .checkRuntimeOperation(executionAuthority, params),
  };
}

module.exports = {
  buildManagedSidecarChatSendOptions,
  ELECTRON_BRIDGE_TOOL_NAMES,
  executeElectronToolRequest,
  normalizeGeneratedArtifacts,
  sanitizeBridgeMetadata,
};
