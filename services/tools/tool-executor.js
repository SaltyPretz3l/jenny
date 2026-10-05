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
const { TOOL_ERROR_CODES } = require('../backend/error-codes');
const { getTrustedExecutionBinding } = require('../backend/session-execution-authority');
const { executeResolvedTool } = require('./tool-execution-dispatch');
const { effectiveSideEffecting, isNonEmptyPlainObject } = require('./tool-policy-actions');

// True only when the tool declares per-action side effects and this call names
// a declared read action; the same rule the sidecar and the policy evaluator
// apply (tool-policy-actions.js), so the three gates agree.
function isReadOnlyActionCall(tool, input) {
  if (!tool || !isNonEmptyPlainObject(tool.actions)) return false;
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return effectiveSideEffecting({ actions: tool.actions }, args) === false;
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
  }

  async executePreApproved(call, context) {
    context = this._bindExecutionContext(context);
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

  // The unscoped presentation owner; backend wiring routes the IDE's
  // workspace_present outcome reports through it.
  get workspacePresentationService() {
    return this._workspacePresentationService;
  }

  // Late-bind the Test Runner the `verify` tool reads off the execution
  // context; ipc-handler-registration.js owns its construction order.
  attachWorkspaceTestRunnerService(service) {
    this._workspaceTestRunnerService = service || null;
  }

  getToolPolicy(toolName, input = {}, context = {}) {
    context = this._bindExecutionContext(context);
    const tool = this.registry.getTool(toolName);
    if (tool) {
      return this._evaluateToolPolicy(tool, input, context).decision;
    }
    return this._legacyPolicyForUnknownTool(toolName);
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

    if (context.authorityInvalid === true) {
      return this._errorResult(callId, toolName,
        `Tool "${toolName}" is disabled: execution authority is invalid.`, startTime,
        { errorCode: TOOL_ERROR_CODES.DISABLED });
    }

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

    // A mixed read/write tool (manifest `actions`) keeps its read actions in a
    // read-only request (Plan Mode): task_board list, home calendar_list. Its
    // writes, and a missing or undeclared action, still refuse (fail closed).
    if (context.readOnly && !tool.readOnly && !isReadOnlyActionCall(tool, call.input)) {
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

  _executeResolvedTool(call, context, options) {
    return executeResolvedTool(this, call, context, options);
  }
  _evaluateToolPolicy(tool, input, context = {}) {
    const descriptor = this._toolPolicyDescriptor(tool);
    const mode = this._policyMode(context);
    const snapshot = this._policySnapshot(tool.name, context);
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

  _policySnapshot(toolName, context = {}) {
    try {
      if (this._permissionStore && typeof this._permissionStore.getSnapshot === 'function') {
        const trustedExecution = getTrustedExecutionBinding(context.executionAuthority);
        return trustedExecution
          ? this._permissionStore.getSnapshot(trustedExecution.authority)
          : this._permissionStore.getSnapshot();
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

  _bindExecutionContext(context) {
    const source = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
    if (!Object.hasOwn(source, 'executionAuthority')) return source;
    const trustedExecution = getTrustedExecutionBinding(source.executionAuthority);
    if (!trustedExecution) return { ...source, workingDirectory: '', authorityInvalid: true };
    return {
      ...source,
      workingDirectory: trustedExecution.authority.root_path || '',
      projectAuthority: trustedExecution.authority,
    };
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
