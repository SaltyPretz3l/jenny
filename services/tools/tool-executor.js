'use strict';

const {
  TOOL_DISABLED_CODE,
  normalizeWorkingDirectory,
} = require('./tool-path-policy');
const {
  buildPolicyDecision,
  buildPolicyDecisionMetadata,
  evaluatePolicy,
} = require('./tool-policy-evaluator');
const { NEVER_PERSIST_ALWAYS_ALLOW } = require('./tool-permission-store');
const { TOOL_ERROR_CODES } = require('../backend/error-codes');

const APPROVAL_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const CMP_ERROR_CODE_PATTERN = /^CMP-[A-Z-]+-\d{4}$/;

function normalizeToolErrorCode(error, fallback = TOOL_ERROR_CODES.EXECUTION_FAILED) {
  const candidate = String(
    error?.errorCode
    || error?.error_code
    || error?.code
    || ''
  ).trim();
  return CMP_ERROR_CODE_PATTERN.test(candidate) ? candidate : fallback;
}

class ToolExecutor {
  constructor({
    registry,
    permissionStore,
    pathPolicy,
    logger,
    artifactService,
    worktreeService,
    automationService,
    workspacePresentationService,
    browserSessionService,
    homeAssistantService,
    configService,
    refreshManagedConfig,
    approvalExpiryMs,
  }) {
    this.registry = registry;
    this._permissionStore = permissionStore;
    this._pathPolicy = pathPolicy;
    this._logger = logger;
    this._artifactService = artifactService || null;
    this._worktreeService = worktreeService || null;
    this._automationService = automationService || null;
    this._workspacePresentationService = workspacePresentationService || null;
    this._browserSessionService = browserSessionService || null;
    // Attached, not injected: the Workspace Test Runner is created during IPC
    // registration, after this executor already exists.
    this._workspaceTestRunnerService = null;
    // Home is composed after the tool executor exists, so this is threaded as
    // a live getter (see services/main/runtime-service-composition.js); a
    // plain reference captured here would be permanently null.
    this._homeAssistantService = typeof homeAssistantService === 'function'
      ? homeAssistantService
      : () => homeAssistantService || null;
    this._configService = configService || null;
    this._refreshManagedConfig = typeof refreshManagedConfig === 'function'
      ? refreshManagedConfig
      : null;
    const normalizedExpiryMs = Number(approvalExpiryMs);
    this._approvalExpiryMs = Number.isFinite(normalizedExpiryMs) && normalizedExpiryMs > 0
      ? normalizedExpiryMs
      : APPROVAL_EXPIRY_MS;

    // callId -> { callId, toolName, streamId, resolve, reject, timer }
    this._pendingApprovals = new Map();
    // streamId -> Set<callId>
    this._streamApprovals = new Map();
  }

  async execute(call, context) {
    const { callId, toolName, input } = call;
    const preflight = this._preflightTool(call, context, { preApproved: false });
    if (!preflight.tool) {
      return preflight;
    }
    const { startTime, tool } = preflight;

    const policyDecision = this._evaluateToolPolicy(tool, input, context);

    if (policyDecision.decision === 'deny') {
      this._logger('INFO', 'tool.denied', {
        callId,
        toolName,
        reason: 'policy_deny',
        policyDecisionId: policyDecision.id,
        matchedRuleId: policyDecision.matched_rule_id,
      });
      return this._errorResult(
        callId,
        toolName,
        `Tool "${toolName}" is denied by permission policy.`,
        startTime,
        {
          approvalState: 'denied',
          summary: `${toolName} denied`,
          errorCode: TOOL_ERROR_CODES.POLICY_DENIED,
          metadata: this._policyDecisionMetadata(policyDecision),
        }
      );
    }

    let approvalState;
    let resolvedContext = context;
    if (policyDecision.decision === 'auto') {
      approvalState = 'auto';
    } else {
      this._logger('INFO', 'tool.approval_requested', { callId, toolName, streamId: context.streamId });
      const approvalResolution = await this._waitForApproval(callId, toolName, context.streamId, input);
      if (approvalResolution && typeof approvalResolution === 'object') {
        approvalState = String(approvalResolution.state || 'approved');
        resolvedContext = {
          ...context,
          planDecision: String(approvalResolution.decision || '').slice(0, 40),
          planFeedback: String(approvalResolution.feedback || '').slice(0, 800),
        };
      } else {
        approvalState = approvalResolution;
      }
    }

    if (approvalState === 'denied') {
      this._logger('INFO', 'tool.denied', { callId, toolName, reason: 'user_denied' });
      return this._errorResult(
        callId,
        toolName,
        `Tool "${toolName}" was denied by the user.`,
        startTime,
        {
          approvalState: 'denied',
          summary: `${toolName} denied`,
          errorCode: TOOL_ERROR_CODES.APPROVAL_DENIED,
          metadata: this._policyDecisionMetadata(policyDecision),
        }
      );
    }

    if (approvalState === 'cancelled') {
      this._logger('INFO', 'tool.cancelled', { callId, toolName });
      return this._errorResult(
        callId,
        toolName,
        `Tool "${toolName}" was cancelled.`,
        startTime,
        {
          approvalState: 'cancelled',
          summary: `${toolName} cancelled`,
          errorCode: TOOL_ERROR_CODES.APPROVAL_DENIED,
          metadata: this._policyDecisionMetadata(policyDecision),
        }
      );
    }

    if (approvalState === 'expired') {
      this._logger('WARN', 'tool.expired', { callId, toolName });
      return this._errorResult(
        callId,
        toolName,
        `Approval for "${toolName}" expired.`,
        startTime,
        {
          approvalState: 'expired',
          summary: `${toolName} expired`,
          errorCode: TOOL_ERROR_CODES.APPROVAL_DENIED,
          metadata: this._policyDecisionMetadata(policyDecision),
        }
      );
    }

    return this._executeResolvedTool(call, resolvedContext, {
      approvalState,
      policyDecision,
      startTime,
      tool,
    });
  }

  async executePreApproved(call, context) {
    const { callId, toolName } = call;
    const preflight = this._preflightTool(call, context, { preApproved: true });
    if (!preflight.tool) {
      return preflight;
    }
    const { startTime, tool } = preflight;

    const policyDecision = this._evaluateToolPolicy(tool, call.input || {}, context);
    if (policyDecision.decision === 'deny') {
      this._logger('INFO', 'tool.denied', {
        callId,
        toolName,
        reason: 'policy_deny',
        preApproved: true,
        policyDecisionId: policyDecision.id,
        matchedRuleId: policyDecision.matched_rule_id,
      });
      return this._errorResult(
        callId,
        toolName,
        `Tool "${toolName}" is denied by permission policy.`,
        startTime,
        {
          approvalState: 'denied',
          summary: `${toolName} denied`,
          errorCode: TOOL_ERROR_CODES.POLICY_DENIED,
          metadata: this._policyDecisionMetadata(policyDecision),
        }
      );
    }

    return this._executeResolvedTool(call, context, {
      approvalState: 'auto',
      policyDecision,
      startTime,
      tool,
    });
  }

  // Late-bind the Test Runner the `verify` tool reads off the execution
  // context; ipc-handler-registration.js owns its construction order.
  attachWorkspaceTestRunnerService(service) {
    this._workspaceTestRunnerService = service || null;
  }

  approve(callId, options = {}) {
    const pending = this._pendingApprovals.get(callId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this._removePending(callId, pending.streamId);

    this._logger('INFO', 'tool.approved', {
      callId,
      toolName: pending.toolName,
      alwaysAllow: !!options.alwaysAllow,
    });

    const requestedDecision = String(options.decision || 'approved').trim();
    const decision = ['approved', 'approved_auto', 'rejected'].includes(requestedDecision)
      ? requestedDecision
      : 'approved';
    pending.resolve({
      state: 'approved',
      decision,
      feedback: String(options.feedback || '').trim().slice(0, 800),
    });

    if (options.alwaysAllow && !NEVER_PERSIST_ALWAYS_ALLOW.has(pending.toolName)) {
      try {
        const store = this._permissionStore;
        (store.grantAlwaysAllow || ((name) => store.setPolicy(name, 'auto'))).call(store, pending.toolName, pending.toolInput);
      } catch (error) {
        this._logger('WARN', 'tool.always_allow_persist_failed', {
          callId,
          toolName: pending.toolName,
          error: String(error?.message || error || '').slice(0, 500),
        });
      }
    }
    return true;
  }

  deny(callId) {
    const pending = this._pendingApprovals.get(callId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this._removePending(callId, pending.streamId);

    this._logger('INFO', 'tool.denied', {
      callId,
      toolName: pending.toolName,
      reason: 'user_denied',
    });

    pending.resolve('denied');
    return true;
  }

  cancelPendingForStream(streamId) {
    const callIds = this._streamApprovals.get(streamId);
    if (!callIds) {
      return;
    }

    for (const callId of callIds) {
      const pending = this._pendingApprovals.get(callId);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve('cancelled');
        this._pendingApprovals.delete(callId);
      }

    }

    this._streamApprovals.delete(streamId);
  }

  getToolPolicy(toolName, input = {}, context = {}) {
    const tool = this.registry.getTool(toolName);
    if (tool) {
      return this._evaluateToolPolicy(tool, input, context).decision;
    }
    return this._legacyPolicyForUnknownTool(toolName);
  }

  getPendingApprovals() {
    const result = [];
    for (const [callId, entry] of this._pendingApprovals) {
      result.push({ callId, toolName: entry.toolName, streamId: entry.streamId });
    }
    return result;
  }

  _preflightTool(call, context, { preApproved }) {
    const { callId, toolName } = call;
    const startTime = Date.now();

    this._logger('DEBUG', 'tool.call_requested', {
      callId,
      toolName,
      streamId: context.streamId,
      ...(preApproved ? { preApproved: true } : {}),
    });

    const tool = this.registry.getTool(toolName);
    if (!tool) {
      return this._errorResult(
        callId,
        toolName,
        `Unknown tool "${toolName}".`,
        startTime,
        { errorCode: TOOL_ERROR_CODES.UNKNOWN }
      );
    }

    if (tool.workspaceRequired !== false && !normalizeWorkingDirectory(context)) {
      this._logger('ERROR', 'tool.workspace_root_missing', {
        callId,
        toolName,
        streamId: context.streamId,
        errorCode: TOOL_DISABLED_CODE,
      });
      return this._errorResult(
        callId,
        toolName,
        `Tool "${toolName}" is disabled: tools workspace root is not configured.`,
        startTime,
        { errorCode: TOOL_DISABLED_CODE }
      );
    }

    if (tool.planModeOnly && context.planMode !== true) {
      this._logger('INFO', 'tool.plan_mode_only_rejected', { callId, toolName });
      return this._errorResult(
        callId,
        toolName,
        `Tool "${toolName}" is only available in Plan Mode.`,
        startTime,
        { errorCode: TOOL_ERROR_CODES.DISABLED }
      );
    }

    if (context.readOnly && !tool.readOnly) {
      this._logger('INFO', 'tool.read_only_rejected', { callId, toolName });
      return this._errorResult(
        callId,
        toolName,
        `Tool "${toolName}" is not available because this request is read-only.`,
        startTime,
        { errorCode: TOOL_ERROR_CODES.DISABLED }
      );
    }

    return { startTime, tool };
  }

  _waitForApproval(callId, toolName, streamId, toolInput) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._removePending(callId, streamId);
        resolve('expired');
      }, this._approvalExpiryMs);

      this._pendingApprovals.set(callId, { callId, toolName, streamId, toolInput, resolve, timer });

      if (!this._streamApprovals.has(streamId)) {
        this._streamApprovals.set(streamId, new Set());
      }
      this._streamApprovals.get(streamId).add(callId);
    });
  }

  _removePending(callId, streamId) {
    this._pendingApprovals.delete(callId);
    const streamSet = this._streamApprovals.get(streamId);
    if (streamSet) {
      streamSet.delete(callId);
      if (streamSet.size === 0) {
        this._streamApprovals.delete(streamId);
      }
    }
  }

  async _executeResolvedTool(call, context, {
    approvalState,
    policyDecision = null,
    startTime,
    tool,
  }) {
    const { callId, toolName, input } = call;

    this._logger('DEBUG', 'tool.execution_started', { callId, toolName });

    const executionContext = {
      ...context,
      callId,
      pathPolicy: this._pathPolicy,
      artifactService: this._artifactService,
      worktreeService: this._worktreeService,
      automationService: this._automationService,
      workspacePresentationService: this._workspacePresentationService,
      browserSessionService: this._browserSessionService,
      workspaceTestRunnerService: this._workspaceTestRunnerService,
      homeAssistantService: this._homeAssistantService(),
      configService: this._configService,
      refreshManagedConfig: this._refreshManagedConfig,
      logger: this._logger,
    };

    try {
      const result = await tool.execute(input, executionContext);
      const durationMs = Date.now() - startTime;
      const isError = result.isError || false;
      const errorCode = isError ? normalizeToolErrorCode(result) : '';

      this._logger('DEBUG', 'tool.execution_completed', {
        callId,
        toolName,
        durationMs,
        isError,
        errorCode,
      });

      return {
        callId,
        toolName,
        content: result.content,
        summary: result.summary || tool.summarize(input),
        isError,
        approvalState,
        durationMs,
        metadata: this._mergePolicyDecisionMetadata(result.metadata, policyDecision),
        errorCode,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorCode = normalizeToolErrorCode(error);
      const errorMessage = String(error && error.message || error || 'Unknown error');

      this._logger('ERROR', 'tool.execution_failed', {
        callId,
        toolName,
        durationMs,
        error: errorMessage,
        errorCode,
      });

      return {
        callId,
        toolName,
        content: `Error executing "${toolName}": ${errorMessage}`,
        summary: `${toolName} failed`,
        isError: true,
        approvalState,
        durationMs,
        metadata: this._mergePolicyDecisionMetadata({}, policyDecision),
        errorCode,
      };
    }
  }

  _evaluateToolPolicy(tool, input, context = {}) {
    const descriptor = this._toolPolicyDescriptor(tool);
    const mode = this._policyMode(context);
    const snapshot = this._policySnapshot(tool.name);
    const args = input && typeof input === 'object' ? input : {};
    const decision = evaluatePolicy({ descriptor, args, mode, snapshot: snapshot ?? {} });
    // Unreadable permission store (snapshot === null): never auto-run on built-in defaults alone.
    if (snapshot !== null || decision.decision !== 'auto') return decision;
    return buildPolicyDecision({
      descriptor, snapshot: {}, mode, decision: 'ask', stage: 'policy_snapshot_unavailable',
      matched_rule_id: null, reason: 'permission store unreadable; explicit approval required',
    });
  }

  _toolPolicyDescriptor(tool) {
    return {
      name: tool.name,
      side_effecting: tool.sideEffecting === true,
      read_only: tool.readOnly === true,
      tool_family: tool.toolFamily || '',
      source_kind: tool.sourceKind || tool.category || '',
      server_name: tool.serverName || '',
      actions: tool.actions,
    };
  }

  _policyMode(context = {}) {
    return String(
      context.mode
      || context.conversationMode
      || context.chatMode
      || (context.planMode ? 'plan' : '')
      || ''
    ).trim();
  }

  _policySnapshot(toolName) {
    try {
      if (this._permissionStore && typeof this._permissionStore.getSnapshot === 'function') {
        return this._permissionStore.getSnapshot();
      }
      if (this._permissionStore && typeof this._permissionStore.getAllPolicies === 'function') {
        return this._permissionStore.getAllPolicies();
      }
    } catch (_error) {
      this._logger('WARN', 'tool.policy_snapshot_unavailable', {
        toolName,
        reason: 'snapshot_read_failed',
        effect: 'approval_required',
      });
      return null;
    }
    return {};
  }

  _legacyPolicyForUnknownTool(toolName) {
    try {
      if (this._permissionStore && typeof this._permissionStore.getAllPolicies === 'function') {
        const policies = this._permissionStore.getAllPolicies();
        return policies[toolName] || 'ask';
      }
    } catch (_error) {
      this._logger('WARN', 'tool.policy_snapshot_unavailable', {
        toolName,
        reason: 'legacy_policy_read_failed',
      });
    }
    return 'ask';
  }

  _policyDecisionMetadata(policyDecision) {
    const metadata = buildPolicyDecisionMetadata(policyDecision);
    return metadata ? { policy_decision: metadata } : {};
  }

  _mergePolicyDecisionMetadata(metadata, policyDecision) {
    return {
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
      ...this._policyDecisionMetadata(policyDecision),
    };
  }

  _errorResult(
    callId,
    toolName,
    content,
    startTime,
    {
      approvalState = 'not_required',
      summary = `${toolName} error`,
      errorCode = TOOL_ERROR_CODES.EXECUTION_FAILED,
      metadata = {},
    } = {}
  ) {
    return {
      callId,
      toolName,
      content,
      summary,
      isError: true,
      approvalState,
      durationMs: Date.now() - startTime,
      metadata,
      errorCode,
    };
  }
}

module.exports = { ToolExecutor };
