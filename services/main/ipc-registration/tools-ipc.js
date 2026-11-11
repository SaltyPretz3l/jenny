const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { normalizeRuntimeToolStatusMap } = require('../../ipc-validation-helpers');
const { normalizeToolName } = require('../../tools/tool-permission-store');
const { surfaceFamilyForTool, connectionIdForTool } = require('../../tools/tool-surface-families');
const { DEFAULT_TOOL_DEFAULTS } = require('../../tools/tool-policy-evaluator');
const { isToolAvailableDuringSessionLockdown } = require('../../backend/session-lockdown-gate');
const { markAcceptedPlanApproved } = require('../../backend/plan-document-events');

// Tools domain IPC: the tool catalog (registry tools joined to the sidecar's
// runtime availability), tool-call approve/deny, accepted-plan build, and the
// saved approval rules.

const TOOL_RUNTIME_NOT_READY_REASON = 'Managed sidecar is not ready yet.';
const TOOL_STATUS_MISSING_REASON = 'Tool availability has not been reported yet.';

function getBackendStatusPhase(backendService) {
  try {
    if (backendService && typeof backendService.getBackendStatus === 'function') {
      return String(backendService.getBackendStatus()?.phase || '').trim().toLowerCase();
    }
    if (
      backendService
      && backendService.sidecarManager
      && typeof backendService.sidecarManager.getStatus === 'function'
    ) {
      return String(backendService.sidecarManager.getStatus()?.phase || '').trim().toLowerCase();
    }
  } catch (_error) {
    return '';
  }
  return '';
}

function unavailableRuntimeStatus(name, runtimeStatus, reason) {
  const status = runtimeStatus && typeof runtimeStatus === 'object' ? runtimeStatus : {};
  return {
    ...status,
    name,
    available: false,
    reason,
  };
}

function getToolListUnavailableReason(backendService, toolsStatus) {
  const phase = getBackendStatusPhase(backendService);
  if (phase && phase !== 'ready') {
    return TOOL_RUNTIME_NOT_READY_REASON;
  }
  if (!Object.keys(toolsStatus).length) {
    return TOOL_STATUS_MISSING_REASON;
  }
  return '';
}

function normalizeToolListEntry(tool, runtimeStatus) {
  const name = String(tool?.name || runtimeStatus?.name || '').trim();
  if (!name) {
    return null;
  }
  const status = runtimeStatus && typeof runtimeStatus === 'object' ? runtimeStatus : null;
  const toolFamily = status?.toolFamily || '';
  const sideEffecting = typeof status?.sideEffecting === 'boolean'
    ? status.sideEffecting : tool?.readOnly === false;
  return {
    name,
    description: String(tool?.description || '').trim(),
    readOnly: tool?.readOnly === true,
    category: String(tool?.category || status?.toolFamily || 'builtin').trim() || 'builtin',
    available: status ? status.available === true : true,
    reason: status && typeof status.reason === 'string' ? status.reason : '',
    toolFamily,
    sourceKind: status?.sourceKind || '',
    serverName: status?.serverName || '',
    connectionId: status?.connectionId || connectionIdForTool(name, {
      source_kind: status?.sourceKind, server_name: status?.serverName,
    }),
    sideEffecting,
    surfaceFamily: surfaceFamilyForTool(name, toolFamily),
    approvalDefault: DEFAULT_TOOL_DEFAULTS[name] || (sideEffecting ? 'ask' : 'auto'),
    lockdownAvailable: isToolAvailableDuringSessionLockdown(name, true),
  };
}

// Live-push a permission-store change into the running sidecar config (same
// path the approval card's "Always allow" checkbox uses).
function pushToolPermissionUpdate(backendService) {
  if (backendService && typeof backendService.refreshManagedConfig === 'function') {
    Promise.resolve(backendService.refreshManagedConfig('tool_permission_updated')).catch(
      () => null
    );
  }
}

function registerToolIpcHandlers(ipcMainLike, {
  backendService,
  toolExecutor,
  toolPermissionStore,
  ipcAuthorization,
}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'tools.list': () => {
      const toolsStatus = normalizeRuntimeToolStatusMap(
        backendService && backendService.currentStatus
          ? backendService.currentStatus.tools_status
          : null
      );
      const unavailableReason = getToolListUnavailableReason(backendService, toolsStatus);
      const registeredStatusKeys = new Set();
      const registryTools = toolExecutor && toolExecutor.registry
        && typeof toolExecutor.registry.getAllTools === 'function'
        ? toolExecutor.registry.getAllTools()
        : [];
      const entries = [];
      for (const tool of registryTools) {
        const statusKey = normalizeToolName(tool.name);
        registeredStatusKeys.add(statusKey);
        const runtimeStatus = unavailableReason
          ? unavailableRuntimeStatus(statusKey, toolsStatus[statusKey], unavailableReason)
          : toolsStatus[statusKey];
        const entry = normalizeToolListEntry(tool, runtimeStatus);
        if (entry) {
          entries.push(entry);
        }
      }
      for (const [name, status] of Object.entries(toolsStatus)) {
        if (registeredStatusKeys.has(name)) {
          continue;
        }
        const runtimeStatus = unavailableReason
          ? unavailableRuntimeStatus(name, status, unavailableReason)
          : { ...status, name };
        const entry = normalizeToolListEntry({ name }, runtimeStatus);
        if (entry) {
          entries.push(entry);
        }
      }
      return entries;
    },
    'tools.approve': (_, callId, options) => Boolean(
      backendService && backendService.approveToolCall(callId, options)
    ),
    // Accepted-not-built plan -> approved, so the renderer's follow-up send
    // carries it as the approved plan. Refuses unless latest, accepted, idle.
    'tools.buildAcceptedPlan': (_, sessionId, planId) => (backendService
      ? markAcceptedPlanApproved({ service: backendService, sessionId, planId })
      : { ok: false, reason: 'unavailable' }),
    'tools.deny': (_, callId) => Boolean(backendService && backendService.denyToolCall(callId)),
    'tools.getPermissions': () => ({
      policies: toolPermissionStore.getAllPolicies(),
      // saved = the user's own decisions (Settings > Tools > Approval rules).
      saved: toolPermissionStore.listStoredDecisions(),
      blanket_auto_approve_retired: toolPermissionStore.consumeBlanketRuleRetiredNotice(),
    }),
    'tools.clearPermission': (_, name) => {
      const result = toolPermissionStore.clearPolicy(name);
      pushToolPermissionUpdate(backendService);
      return result;
    },
    'tools.removePermissionRule': (_, ruleId) => {
      const result = toolPermissionStore.removeRule(ruleId);
      pushToolPermissionUpdate(backendService);
      return result;
    },
  }, ipcAuthorization);
}

module.exports = {
  normalizeToolListEntry,
  registerToolIpcHandlers,
};
