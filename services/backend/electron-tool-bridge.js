'use strict';

const path = require('path');

const { TOOL_ERROR_CODES } = require('./error-codes');

const MAX_BRIDGE_METADATA_DEPTH = 6;
const MAX_BRIDGE_METADATA_ITEMS = 100;
const MAX_BRIDGE_METADATA_STRING_LENGTH = 20_000;
const SENSITIVE_METADATA_VALUE_PATTERN = /\b(?:bearer\s+[a-z0-9._~+/=-]{12,}|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{20,})\b/i;

const ELECTRON_BRIDGE_TOOL_NAMES = new Set([
  'jenny_status',
  'worktree_list',
  'worktree_create',
  'worktree_select',
  'worktree_delete',
  'automation_list',
  'automation_read',
  'workspace_present',
  'preview_test',
  'verify',
  'home',
  'task_board',
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
  return key === '__proto__' || key === 'prototype' || key === 'constructor';
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
    const state = service?.configService?.getState?.();
    const workspaceRoot = typeof state?.toolsWorkspaceRoot === 'string'
      ? state.toolsWorkspaceRoot.trim()
      : '';
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

async function executeElectronToolRequest(
  service,
  {
    params,
    sessionId,
    streamId,
    abortSignal = null,
    pluginRuntimeAuthority = null,
  } = {}
) {
  const payload = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const toolName = String(payload.tool_name || '').trim();
  const callId = String(payload.tool_call_id || '').trim() || `electron_tool_${Date.now()}`;
  const input = normalizeBridgeArguments(payload.arguments);
  const effectivePlanMode = typeof payload.plan_mode === 'boolean' ? payload.plan_mode : true;
  const effectiveReadOnly = typeof payload.read_only === 'boolean' ? payload.read_only : true;
  const planDecision = String(payload.plan_decision || '').trim().slice(0, 40);
  const planFeedback = String(payload.plan_feedback || '').trim().slice(0, 800);
  const editedPlan = payload.edited_plan && typeof payload.edited_plan === 'object'
    && !Array.isArray(payload.edited_plan) ? payload.edited_plan : null;

  // __jenny_git_checkpoint is an internal sidecar-originated op (auto-checkpoint
  // before the first repo mutation of a run), never model-callable. It routes
  // straight to WorkspaceGitService.createCheckpoint and MUST bypass
  // toolExecutor.executePreApproved entirely, so no policy/plan-mode/approval
  // checks apply — hence this special-case runs before the allowlist check.
  if (toolName === '__jenny_git_checkpoint') {
    const gitService = service && service.workspaceGitService;
    if (!gitService || typeof gitService.createCheckpoint !== 'function') {
      return bridgeFailure(toolName, 'Auto-checkpoint git service unavailable.');
    }
    let result;
    try {
      result = await gitService.createCheckpoint({
        session: String(sessionId || payload.session_id || '').trim(),
        signal: abortSignal,
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
    const privilegedService = service?._pluginStage8ControlPlane;
    if (privilegedService && pluginRuntimeAuthority?.mode === 'plugin'
      && typeof privilegedService.invokeNativeTool === 'function') {
      const authority = { ...pluginRuntimeAuthority };
      delete authority.mode;
      let native;
      try {
        native = await privilegedService.invokeNativeTool({ authority, toolName,
          arguments: input, signal: abortSignal });
      } catch (_error) {
        native = { ok: false, reason: 'native_mcp_invocation_failed' };
      }
      if (native?.ok) {
        let output;
        try {
          output = typeof native.output === 'string'
            ? native.output : JSON.stringify(native.result ?? native.output ?? null);
        } catch (_error) { output = ''; }
        return {
          tool_name: toolName,
          output: String(output || '').slice(0, MAX_BRIDGE_METADATA_STRING_LENGTH),
          success: true, content_type: 'text', generated_artifacts: [], error_code: null,
          metadata: sanitizeBridgeMetadata({ result_kind: 'plugin_native_mcp',
            binding_digest: native.binding_digest }),
        };
      }
      if (native?.reason !== 'native_mcp_tool_not_found') {
        return bridgeFailure(toolName,
          `Native plugin tool failed: ${String(native?.reason || 'native_mcp_invocation_failed').slice(0, 120)}`,
          TOOL_ERROR_CODES.EXECUTION_FAILED);
      }
    }
    if (toolName.startsWith('plugin:') && toolName.split(':').length === 4) {
      const restrictedService = service?._pluginStage6ControlPlane;
      if (!restrictedService || typeof restrictedService.executeRestrictedTool !== 'function') {
        return bridgeFailure(toolName, 'Restricted plugin runtime is unavailable.');
      }
      let restricted;
      try {
        restricted = await restrictedService.executeRestrictedTool(toolName, input, {
          signal: abortSignal,
          sessionId: String(sessionId || payload.session_id || '').trim(),
          purpose: 'restricted_invocation',
        });
      } catch (_error) {
        restricted = { ok: false, reason: 'restricted_invocation_failed' };
      }
      if (!restricted?.ok) {
        return bridgeFailure(
          toolName,
          `Restricted plugin tool failed: ${String(restricted?.reason || 'restricted_invocation_failed').slice(0, 200)}`,
          String(restricted?.code || TOOL_ERROR_CODES.EXECUTION_FAILED)
        );
      }
      let output;
      try { output = JSON.stringify(restricted.value); } catch (_error) { output = ''; }
      return {
        tool_name: toolName,
        output: String(output || '').slice(0, MAX_BRIDGE_METADATA_STRING_LENGTH),
        success: true,
        content_type: 'text',
        generated_artifacts: [],
        error_code: null,
        metadata: sanitizeBridgeMetadata({
          result_kind: 'plugin_restricted_host',
          invocation_id: restricted.invocation_id,
        }),
      };
    }
    const pluginService = service?._pluginStage5ControlPlane;
    if (!pluginService || typeof pluginService.executeRemoteTool !== 'function') {
      return bridgeFailure(
        toolName,
        `Electron tool bridge rejected unsupported tool "${toolName || 'unknown'}".`,
        TOOL_ERROR_CODES.UNKNOWN
      );
    }
    let remote;
    try {
      remote = await pluginService.executeRemoteTool(toolName, input, {
        signal: abortSignal,
        sessionId: String(sessionId || payload.session_id || '').trim(),
      });
    } catch (_error) {
      return bridgeFailure(toolName, 'Remote plugin tool execution failed.');
    }
    if (!remote?.ok) {
      return bridgeFailure(
        toolName,
        `Remote plugin tool failed: ${String(remote?.reason || 'remote_tool_failed').slice(0, 200)}`,
        String(remote?.code || TOOL_ERROR_CODES.EXECUTION_FAILED)
      );
    }
    let output;
    try { output = JSON.stringify(remote.result); } catch (_error) { output = ''; }
    return {
      tool_name: toolName,
      output: String(output || '').slice(0, MAX_BRIDGE_METADATA_STRING_LENGTH),
      success: true,
      content_type: 'text',
      generated_artifacts: [],
      error_code: null,
      metadata: sanitizeBridgeMetadata({
        result_kind: 'plugin_remote_mcp',
        plugin_provenance: remote.provenance,
      }),
    };
  }

  const toolExecutor = service?.toolExecutor;
  if (!toolExecutor || typeof toolExecutor.executePreApproved !== 'function') {
    return bridgeFailure(toolName, 'Electron tool bridge is unavailable.');
  }

  const workingDirectory = resolveConfiguredWorkspaceRoot(service);
  const result = await toolExecutor.executePreApproved(
    { callId, toolName, input },
    {
      planMode: effectivePlanMode,
      readOnly: effectiveReadOnly,
      planDecision,
      planFeedback,
      planEditedPlan: editedPlan,
      sessionId: String(sessionId || payload.session_id || '').trim(),
      streamId: String(streamId || payload.request_id || '').trim(),
      workingDirectory,
      backendService: service,
      abortSignal,
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
    streamId: String(streamId || payload.request_id || '').trim(),
    callId,
    artifacts: rawMetadata.generatedArtifacts,
  });
  const metadata = sanitizeBridgeMetadata(rawMetadata);

  return {
    tool_name: toolName,
    output: String(result?.content || ''),
    success: result.isError === false,
    content_type: 'text',
    generated_artifacts: generatedArtifacts,
    error_code: String(result?.errorCode || '').trim() || null,
    metadata,
  };
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
  pluginRuntimeAuthority = null,
}) {
  const recordStreamActivity = typeof noteStreamActivity === 'function'
    ? noteStreamActivity
    : () => {};
  const suspendIdleWatchdog = typeof pauseStreamIdleTimer === 'function'
    ? pauseStreamIdleTimer
    : () => {};
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
      try {
        return await waitForToolApproval(
          service,
          streamId,
          resolvedSessionId,
          requestId,
          params,
          controller,
          turnEventCollector
        );
      } finally {
        if (typeof resumeAfterApproval === 'function') {
          resumeAfterApproval();
        } else {
          // A watchdog stub that pauses without handing back a resume: fall back
          // rather than leave both clocks parked for the rest of the turn.
          recordStreamActivity();
        }
      }
    },
    onElectronToolRequest: async (params) => {
      if (params?.tool_name !== 'ask_user') {
        return executeElectronToolRequest(service, {
          params,
          sessionId: resolvedSessionId,
          streamId,
          abortSignal: controller.signal,
          pluginRuntimeAuthority,
        });
      }
      // ask_user blocks on human answers, so that wait is not stream idle time.
      const resumeAfterAnswers = suspendIdleWatchdog();
      try {
        return await executeElectronToolRequest(service, {
          params,
          sessionId: resolvedSessionId,
          streamId,
          abortSignal: controller.signal,
          pluginRuntimeAuthority,
        });
      } finally {
        if (typeof resumeAfterAnswers === 'function') {
          resumeAfterAnswers();
        } else {
          recordStreamActivity();
        }
      }
    },
    onPluginHostRequest: (() => {
      const privileged = service?._pluginStage8ControlPlane;
      if (!privileged?.engineStream) return undefined;
      const { createElectronPluginHostBridge } = require('./electron-plugin-host-bridge');
      const authority = pluginRuntimeAuthority?.mode === 'plugin'
        ? (() => { const value = { ...pluginRuntimeAuthority }; delete value.mode; return value; })()
        : {};
      return createElectronPluginHostBridge({ currentAuthority: async () => authority,
        streamBroker: privileged.engineStream });
    })(),
  };
}

module.exports = {
  buildManagedSidecarChatSendOptions,
  ELECTRON_BRIDGE_TOOL_NAMES,
  executeElectronToolRequest,
  normalizeGeneratedArtifacts,
  sanitizeBridgeMetadata,
};
