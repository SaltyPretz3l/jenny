'use strict';

const { randomUUID } = require('node:crypto');
const { t } = require('../i18n-main');
const { scopedToolAvailability } = require('./request-tool-availability');
const { allowsPlanArtifact } = require('../tools/plan-artifact-policy');

const { builtinExecutionDescriptor } = require('./execution-tool-descriptors');
const { evaluatePolicy } = require('../tools/tool-policy-evaluator');
const { effectiveSideEffecting } = require('../tools/tool-policy-actions');
const { PROJECT_ERROR_CODES, RUNTIME_ERROR_CODES, TOOL_ERROR_CODES } = require('./error-codes');
const {
  authorityFingerprint,
  fingerprintsMatch,
} = require('./plugin-tool-execution-authority');

const EXECUTION_CONTEXT_SCHEMA_VERSION = 1;
const SIDECAR_API_VERSION = '2026-08-17';
const MAX_EXECUTION_CONTEXT_BYTES = 5 * 1024 * 1024;
const MAX_POLICY_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_OPERATION_BYTES = 1024 * 1024;
const MAX_CORRELATION_CHARS = 128;
const MAX_OPERATION_CHARS = 256;
const MAX_ROOT_PATH_CHARS = 4096;
const MAX_KNOWLEDGE_ROOTS = 32;
const MAX_KNOWLEDGE_ROOT_CHARS = 4096;
const EMPTY_SKILLS_CONFIG = Object.freeze({
  skills_bundled_root: null,
  skills_user_root: null,
  skills_project_root: null,
  skills_bundled_enabled: false,
  skills_user_enabled: false,
  skills_project_enabled: false,
  skills_disabled_ids: Object.freeze([]),
  skills_auto_index: 'auto',
});
const SKILLS_CONFIG_KEYS = Object.freeze(Object.keys(EMPTY_SKILLS_CONFIG).sort());
const RUNTIME_OPERATION_KEYS = Object.freeze([
  'api_version',
  'arguments',
  'authority_revision',
  'operation_id',
  'phase',
  'request_id',
  'schema_version',
  'session_id',
  'tool_name',
]);

const bindingStates = new WeakMap();

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, label, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} is not JSON serializable.`, { cause: error });
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds its encoded size limit.`);
  }
  return JSON.parse(serialized);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function boundedToken(value, maxChars) {
  const token = typeof value === 'string' ? value.trim() : '';
  // eslint-disable-next-line no-control-regex -- correlation tokens reject JSON control bytes.
  return token && token.length <= maxChars && !/[\u0000-\u001f\u007f]/u.test(token)
    ? token
    : '';
}

function authoritiesMatch(left, right) {
  return Boolean(left && right
    && left.project_id === right.project_id
    && left.root_path === right.root_path
    && left.root_id === right.root_id
    && left.root_revision === right.root_revision
    && left.device_id === right.device_id
    && left.inode === right.inode);
}

function resolveCurrentRunState(projectAuthority, sessionId, nonPlanMode, nonPlanReadOnly) {
  const session = projectAuthority?._sessionStore?.getSessionSummary?.(sessionId);
  if (!session) return null;
  const runMode = String(session.run_mode || '').trim().toLowerCase();
  const planMode = session.plan_mode === true || runMode === 'plan';
  return { mode: planMode ? 'plan' : nonPlanMode,
    readOnly: nonPlanReadOnly || planMode, runMode };
}

function normalizeCapturedAuthority(value) {
  if (!isPlainRecord(value)) throw new Error('Captured project authority is invalid.');
  const projectId = boundedToken(value.project_id, MAX_CORRELATION_CHARS);
  const rootPath = value.root_path === null ? null
    : typeof value.root_path === 'string' ? value.root_path.trim() : '';
  const rootId = value.root_id === null ? null
    : boundedToken(value.root_id, MAX_CORRELATION_CHARS);
  const deviceId = value.device_id === null ? null
    : boundedToken(value.device_id, MAX_CORRELATION_CHARS);
  const inode = value.inode === null ? null
    : boundedToken(value.inode, MAX_CORRELATION_CHARS);
  const rootRevision = value.root_revision;
  if (!projectId || (rootPath !== null && (!rootPath || rootPath.length > MAX_ROOT_PATH_CHARS))
    || !Number.isSafeInteger(rootRevision) || rootRevision < 0
    || (rootPath === null && (rootId !== null || deviceId !== null || inode !== null))
    || (rootPath !== null && !rootId)
    || ((deviceId === null) !== (inode === null))) {
    throw new Error('Captured project authority fields are invalid.');
  }
  return deepFreeze({
    project_id: projectId,
    root_path: rootPath,
    root_id: rootId,
    root_revision: rootRevision,
    device_id: deviceId,
    inode,
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function operationSignature(toolName, args) {
  return `${toolName}\n${canonicalJson(args)}`;
}

function rejected(operationId, code, reason, message) {
  return {
    schema_version: EXECUTION_CONTEXT_SCHEMA_VERSION,
    status: 'rejected',
    operation_id: boundedToken(operationId, MAX_OPERATION_CHARS),
    error: { code, reason, message },
  };
}

function validateRuntimeOperation(params) {
  if (!isPlainRecord(params) || Object.keys(params).sort().join('\0') !== RUNTIME_OPERATION_KEYS.join('\0')) {
    return { ok: false, reason: 'invalid_schema', message: t('error.runtime.operationSchema', 'Runtime operation has an invalid schema.') };
  }
  const requestId = boundedToken(params.request_id, MAX_CORRELATION_CHARS);
  const sessionId = boundedToken(params.session_id, MAX_CORRELATION_CHARS);
  const authorityRevision = boundedToken(params.authority_revision, MAX_CORRELATION_CHARS);
  const operationId = boundedToken(params.operation_id, MAX_OPERATION_CHARS);
  const toolName = boundedToken(params.tool_name, MAX_OPERATION_CHARS);
  if (params.api_version !== SIDECAR_API_VERSION
    || params.schema_version !== EXECUTION_CONTEXT_SCHEMA_VERSION || params.phase !== 'check'
    || !requestId || !sessionId || !authorityRevision || !operationId || !toolName
    || !isPlainRecord(params.arguments)) {
    return { ok: false, reason: 'invalid_schema', message: t('error.runtime.operationFields', 'Runtime operation fields are invalid.') };
  }
  try {
    const args = cloneJson(params.arguments, 'Runtime operation', MAX_RUNTIME_OPERATION_BYTES);
    if (Buffer.byteLength(JSON.stringify({ ...params, arguments: args }), 'utf8')
      > MAX_RUNTIME_OPERATION_BYTES) {
      throw new Error('Runtime operation exceeds its encoded size limit.');
    }
    return { ok: true, requestId, sessionId, authorityRevision, operationId, toolName, args };
  } catch (error) {
    return { ok: false, reason: 'payload_too_large', message: error.message };
  }
}

function normalizeKnowledgeRoots(config) {
  const roots = Array.isArray(config?.knowledge_roots) ? config.knowledge_roots : [];
  if (roots.length > MAX_KNOWLEDGE_ROOTS) throw new Error('Knowledge root snapshot exceeds its bound.');
  return roots.map((value) => {
    const root = typeof value === 'string' ? value.trim() : '';
    if (!root || root.length > MAX_KNOWLEDGE_ROOT_CHARS) {
      throw new Error('Knowledge root snapshot contains an invalid path.');
    }
    return root;
  });
}

function normalizeSkillsConfig(config) {
  const source = config || EMPTY_SKILLS_CONFIG;
  if (!isPlainRecord(source)
    || Object.keys(source).sort().join('\0') !== SKILLS_CONFIG_KEYS.join('\0')) {
    throw new Error('Skills configuration has an invalid schema.');
  }
  const roots = ['skills_bundled_root', 'skills_user_root', 'skills_project_root'];
  const flags = ['skills_bundled_enabled', 'skills_user_enabled', 'skills_project_enabled'];
  if (roots.some((key) => source[key] !== null
    && (typeof source[key] !== 'string' || !source[key] || source[key].length > MAX_ROOT_PATH_CHARS))
    || flags.some((key) => typeof source[key] !== 'boolean')
    || !['auto', 'on', 'off'].includes(source.skills_auto_index)
    || !Array.isArray(source.skills_disabled_ids)
    || source.skills_disabled_ids.length > 512
    || source.skills_disabled_ids.some((value) => !boundedToken(value, MAX_OPERATION_CHARS))) {
    throw new Error('Skills configuration fields are invalid.');
  }
  return {
    skills_bundled_root: source.skills_bundled_root,
    skills_user_root: source.skills_user_root,
    skills_project_root: source.skills_project_root,
    skills_bundled_enabled: source.skills_bundled_enabled,
    skills_user_enabled: source.skills_user_enabled,
    skills_project_enabled: source.skills_project_enabled,
    skills_disabled_ids: [...source.skills_disabled_ids],
    skills_auto_index: source.skills_auto_index,
  };
}

function getTrustedExecutionBinding(binding) {
  const state = bindingStates.get(binding);
  return state && !state.closed ? state.trustedContext : null;
}

function normalizePluginToolCapture(value, expectedAuthority) {
  if (!isPlainRecord(value) || !Array.isArray(value.descriptors)
    || !/^[0-9a-f]{64}$/u.test(String(value.descriptor_digest || ''))
    || value.descriptors.length > 256) {
    throw new Error('Captured plugin tool authority is invalid.');
  }
  const expected = authorityFingerprint(expectedAuthority);
  const captured = authorityFingerprint(value.authority);
  if (!expected || !captured || !fingerprintsMatch(expected, captured)) {
    throw new Error('Captured plugin tool authority fingerprint is stale.');
  }
  const descriptors = new Map();
  for (const raw of value.descriptors) {
    const descriptor = deepFreeze(cloneJson(raw, 'Plugin tool descriptor', 256 * 1024));
    const name = boundedToken(descriptor.name, MAX_OPERATION_CHARS);
    if (!name || descriptor.name !== name || typeof descriptor.side_effecting !== 'boolean'
      || typeof descriptor.read_only !== 'boolean'
      || typeof descriptor.tool_family !== 'string'
      || typeof descriptor.source_kind !== 'string'
      || typeof descriptor.server_name !== 'string'
      || descriptor.plan_mode_only !== false || descriptor.workspace_required !== false
      || builtinExecutionDescriptor(name) || descriptors.has(name)) {
      throw new Error('Captured plugin tool descriptor is invalid.');
    }
    descriptors.set(name, descriptor);
  }
  return {
    authority: captured,
    descriptorDigest: value.descriptor_digest,
    descriptors,
  };
}

class SessionExecutionAuthority {
  constructor({
    projectAuthority,
    permissionStore,
    knowledgeService,
    skillsService = null,
    resolveProjectWorkspaceServices,
    resolvePluginToolAuthority = null,
    randomUUID: createUUID = randomUUID,
  } = {}) {
    if (!projectAuthority || typeof projectAuthority.captureSession !== 'function'
      || typeof projectAuthority.requireCurrent !== 'function') {
      throw new TypeError('SessionExecutionAuthority requires project authority.');
    }
    if (!permissionStore || typeof permissionStore.getSnapshot !== 'function') {
      throw new TypeError('SessionExecutionAuthority requires a permission store.');
    }
    if (!knowledgeService || typeof knowledgeService.getSidecarConfig !== 'function') {
      throw new TypeError('SessionExecutionAuthority requires a knowledge service.');
    }
    if (typeof resolveProjectWorkspaceServices !== 'function') {
      throw new TypeError('SessionExecutionAuthority requires scoped workspace services.');
    }
    if (resolvePluginToolAuthority !== null
      && typeof resolvePluginToolAuthority !== 'function') {
      throw new TypeError('Plugin tool authority resolver is invalid.');
    }
    this._projectAuthority = projectAuthority;
    this._permissionStore = permissionStore;
    this._knowledgeService = knowledgeService;
    this._skillsService = skillsService;
    this._resolveProjectWorkspaceServices = resolveProjectWorkspaceServices;
    this._resolvePluginToolAuthority = resolvePluginToolAuthority;
    this._createUUID = createUUID;
  }

  captureSession(sessionId, {
    requestId, signal = null, mode = '', readOnly = false, toolPreferences = null,
    approvalMode = 'prompt',
  } = {}) {
    const normalizedSessionId = boundedToken(sessionId, MAX_CORRELATION_CHARS);
    const normalizedRequestId = boundedToken(requestId, MAX_CORRELATION_CHARS);
    if (!normalizedSessionId || !normalizedRequestId) {
      throw new Error('Session and request identity are required for execution authority.');
    }
    const authority = normalizeCapturedAuthority(
      this._projectAuthority.captureSession(normalizedSessionId)
    );
    const authorityRevision = boundedToken(this._createUUID(), MAX_CORRELATION_CHARS);
    if (!authorityRevision) throw new Error('Execution authority revision is invalid.');
    const policySnapshot = deepFreeze(cloneJson(
      this._permissionStore.getSnapshot(authority),
      'Tool policy snapshot',
      MAX_POLICY_SNAPSHOT_BYTES
    ));
    const knowledgeConfig = this._knowledgeService.getSidecarConfig({
      projectId: authority.project_id,
    });
    const knowledgeRoots = deepFreeze(authority.root_path
      ? normalizeKnowledgeRoots(knowledgeConfig) : []);
    const normalizedSkills = normalizeSkillsConfig(
      this._skillsService?.getSidecarConfig?.({ authority })
    );
    if (!authority.root_path) {
      normalizedSkills.skills_project_root = null;
      normalizedSkills.skills_project_enabled = false;
    }
    const skillsConfig = deepFreeze(cloneJson(
      normalizedSkills,
      'Skills configuration',
      256 * 1024
    ));
    const services = this._resolveProjectWorkspaceServices(authority, {
      sessionId: normalizedSessionId,
    });
    if (!services || typeof services !== 'object' || Array.isArray(services)) {
      throw new Error('Scoped project workspace services are unavailable.');
    }
    const requestedMode = String(mode || '').trim().slice(0, 40);
    const nonPlanMode = requestedMode === 'plan' ? 'assist' : requestedMode;
    const capturedMode = resolveCurrentRunState(this._projectAuthority, normalizedSessionId,
      nonPlanMode, readOnly === true)?.mode || requestedMode;
    const capturedReadOnly = readOnly === true || capturedMode === 'plan';
    const executionContext = deepFreeze({
      schema_version: EXECUTION_CONTEXT_SCHEMA_VERSION,
      authority_revision: authorityRevision,
      ...authority,
      tool_policy_snapshot: policySnapshot,
      knowledge_roots: knowledgeRoots,
      skills_config: skillsConfig,
    });
    if (Buffer.byteLength(JSON.stringify(executionContext), 'utf8') > MAX_EXECUTION_CONTEXT_BYTES) {
      throw new Error('Execution context exceeds its encoded size limit.');
    }
    const binding = Object.freeze({});
    const trustedContext = Object.freeze({
      authority,
      services: Object.freeze({ ...services }),
      sessionId: normalizedSessionId,
      requestId: normalizedRequestId,
      authorityRevision,
      get mode() { return bindingStates.get(binding)?.mode || capturedMode; },
      get readOnly() { return bindingStates.get(binding)?.readOnly ?? capturedReadOnly; },
      assertCurrent: () => this.requireCurrent(binding),
      captureRuntimeTool: (toolName) => this.captureRuntimeTool(binding, toolName),
      describeToolAvailability: (status) => {
        this.requireCurrent(binding);
        const state = bindingStates.get(binding);
        return scopedToolAvailability(status, state,
          (name) => builtinExecutionDescriptor(name) || state.pluginDescriptors.get(name));
      },
    });
    bindingStates.set(binding, {
      authority,
      approved: new Map(),
      autoRun: approvalMode === 'auto_run',
      authorityRevision,
      binding,
      closed: false,
      executionContext,
      mode: capturedMode,
      nonPlanMode,
      pluginDescriptors: new Map(),
      pluginToolAuthority: null,
      planApprovals: new Map(),
      nonPlanReadOnly: readOnly === true,
      readOnly: capturedReadOnly,
      requestId: normalizedRequestId,
      sessionId: normalizedSessionId,
      signal,
      runtimeSealed: false,
      toolPreferences: isPlainRecord(toolPreferences) ? cloneJson(toolPreferences, 'Tool preferences', 64 * 1024) : null,
      trustedContext,
    });
    return binding;
  }

  toExecutionContext(binding) {
    const state = bindingStates.get(binding);
    if (!state || state.closed) throw new Error('Execution authority is unavailable.');
    return state.executionContext;
  }

  requireCurrent(binding) {
    const state = bindingStates.get(binding);
    if (!state || state.closed || state.signal?.aborted) {
      throw new Error('Execution authority is cancelled or unavailable.');
    }
    const sessionAuthority = this._projectAuthority.captureSession(state.sessionId);
    if (!authoritiesMatch(sessionAuthority, state.authority)) {
      throw new Error('Session project authority changed during the request.');
    }
    this._projectAuthority.requireCurrent(state.authority);
    const currentRunState = resolveCurrentRunState(this._projectAuthority, state.sessionId,
      state.nonPlanMode, state.nonPlanReadOnly);
    if (currentRunState && (currentRunState.mode !== state.mode
      || (currentRunState.readOnly && !state.readOnly)
      || (state.autoRun && currentRunState.runMode !== 'auto'))) {
      // Coded so the terminal classifier can name the user's own mode flip
      // (calm card, retry alone) instead of the generic retry copy.
      throw Object.assign(
        new Error('The run mode changed while this request was running, so the reply stopped.'),
        { code: 'run_mode_changed', retryable: true }
      );
    }
    if (state.pluginToolAuthority?.authority) {
      if (!this._resolvePluginToolAuthority) {
        throw new Error('Plugin tool authority resolver is unavailable.');
      }
      const current = normalizePluginToolCapture(
        this._resolvePluginToolAuthority(state.pluginToolAuthority.authority),
        state.pluginToolAuthority.authority
      );
      if (current.descriptorDigest !== state.pluginToolAuthority.descriptorDigest) {
        throw new Error('Plugin tool authority changed during the request.');
      }
    }
    return state.authority;
  }

  bindPluginTools(binding, expectedAuthority) {
    const state = bindingStates.get(binding);
    if (!state || state.closed || state.signal?.aborted) {
      throw new Error('Execution authority is cancelled or unavailable.');
    }
    const sessionAuthority = this._projectAuthority.captureSession(state.sessionId);
    if (!authoritiesMatch(sessionAuthority, state.authority)) {
      throw new Error('Session project authority changed during the request.');
    }
    this._projectAuthority.requireCurrent(state.authority);
    let next;
    if (isPlainRecord(expectedAuthority) && expectedAuthority.mode === 'core_only'
      && Object.keys(expectedAuthority).length === 1) {
      next = { authority: null, descriptorDigest: null, descriptors: new Map() };
    } else {
      if (!this._resolvePluginToolAuthority) {
        throw new Error('Plugin tool authority resolver is unavailable.');
      }
      next = normalizePluginToolCapture(
        this._resolvePluginToolAuthority(expectedAuthority),
        expectedAuthority
      );
    }
    const prior = state.pluginToolAuthority;
    const unchanged = prior && prior.descriptorDigest === next.descriptorDigest
      && ((!prior.authority && !next.authority)
        || fingerprintsMatch(prior.authority, next.authority));
    if (!unchanged && state.runtimeSealed) {
      throw new Error('Plugin tool authority is sealed for this request.');
    }
    state.pluginToolAuthority = Object.freeze({
      authority: next.authority,
      descriptorDigest: next.descriptorDigest,
    });
    state.pluginDescriptors = next.descriptors;
    return true;
  }

  captureRuntimeTool(binding, toolName) {
    const state = bindingStates.get(binding);
    this.requireCurrent(binding);
    const descriptor = state?.pluginDescriptors.get(String(toolName || '').trim());
    if (!descriptor || !state.pluginToolAuthority?.authority) return null;
    return Object.freeze({
      authority: state.pluginToolAuthority.authority,
      descriptor,
    });
  }

  noteApproved(binding, { operationId, toolName, arguments: args, decision } = {}) {
    const state = bindingStates.get(binding);
    this.requireCurrent(binding);
    const normalizedOperationId = boundedToken(operationId, MAX_OPERATION_CHARS);
    const normalizedToolName = boundedToken(toolName, MAX_OPERATION_CHARS);
    if (!state || !normalizedOperationId || !normalizedToolName || !isPlainRecord(args)) return false;
    state.runtimeSealed = true;
    state.approved.set(normalizedOperationId, operationSignature(normalizedToolName, args));
    if (normalizedToolName === 'exit_plan_mode' && ['approved', 'approved_auto'].includes(decision)) {
      state.planApprovals.set(normalizedOperationId, decision);
    }
    return true;
  }

  preparePlanExit(binding, { operationId, arguments: args, decision } = {}) {
    const state = bindingStates.get(binding);
    const assertApproved = (checkCurrent = true) => {
      if (checkCurrent) this.requireCurrent(binding);
      if (state.mode !== 'plan' || state.nonPlanReadOnly
        || state.planApprovals.get(operationId) !== decision
        || !['approved', 'approved_auto'].includes(decision)
        || state.approved.get(operationId) !== operationSignature('exit_plan_mode', args)) {
        throw new Error('Plan exit requires the exact approved operation and writable authority.');
      }
    };
    assertApproved();
    return (restoredMode = decision === 'approved_auto' ? 'auto' : 'ask') => {
      assertApproved(false);
      const previousAutoRun = state.autoRun;
      state.mode = state.nonPlanMode;
      state.readOnly = false;
      state.autoRun = restoredMode === 'auto';
      try { this.requireCurrent(binding); } catch (error) {
        state.mode = 'plan'; state.readOnly = true; state.autoRun = previousAutoRun;
        throw error;
      }
      state.planApprovals.delete(operationId);
    };
  }

  checkRuntimeOperation(binding, params) {
    const validation = validateRuntimeOperation(params);
    const operationId = validation.ok ? validation.operationId : params?.operation_id;
    if (!validation.ok) {
      return rejected(operationId, RUNTIME_ERROR_CODES.ADMISSION_REJECTED, validation.reason, validation.message);
    }
    const state = bindingStates.get(binding);
    if (!state || state.closed || state.signal?.aborted
      || validation.requestId !== state.requestId
      || validation.sessionId !== state.sessionId
      || validation.authorityRevision !== state.authorityRevision) {
      return rejected(validation.operationId, RUNTIME_ERROR_CODES.ADMISSION_REJECTED, 'authority_mismatch',
        'Runtime operation authority does not match the active request.');
    }
    state.runtimeSealed = true;
    try {
      this.requireCurrent(binding);
    } catch (error) {
      return rejected(validation.operationId, PROJECT_ERROR_CODES.STALE, 'project_authority_stale',
        String(error?.message || error || 'Project authority is stale.').slice(0, 300));
    }
    const descriptor = builtinExecutionDescriptor(validation.toolName)
      || state.pluginDescriptors.get(validation.toolName);
    if (!descriptor || (descriptor.workspace_required && !state.authority.root_path)) {
      return rejected(validation.operationId, TOOL_ERROR_CODES.DISABLED, 'tool_unavailable',
        'The tool is unavailable for this captured project authority.');
    }
    if ((descriptor.plan_mode_only && state.mode !== 'plan')
      || (state.readOnly && effectiveSideEffecting(descriptor, validation.args)
        && !(state.mode === 'plan' && !state.nonPlanReadOnly
          && allowsPlanArtifact(descriptor, validation.args)))) {
      return rejected(validation.operationId, TOOL_ERROR_CODES.POLICY_DENIED, 'read_only',
        'The tool operation is unavailable in the captured read-only mode.');
    }
    const preferences = state.toolPreferences;
    if (Array.isArray(preferences?.disabled_tools)
      && preferences.disabled_tools.includes(validation.toolName)) {
      return rejected(validation.operationId, TOOL_ERROR_CODES.POLICY_DENIED, 'tool_disabled',
        'The tool is disabled for this request.');
    }
    let snapshot;
    try {
      snapshot = this._permissionStore.getSnapshot(state.authority);
    } catch (_error) {
      return rejected(validation.operationId, TOOL_ERROR_CODES.POLICY_DENIED, 'policy_unavailable',
        'Current tool policy is unavailable.');
    }
    const policy = evaluatePolicy({
      descriptor,
      args: validation.args,
      mode: state.mode,
      snapshot,
    });
    const approvedSignature = state.approved.get(validation.operationId);
    const approved = approvedSignature === operationSignature(validation.toolName, validation.args);
    // The trusted run grant covers ordinary asks; Python still applies its
    // mandatory destructive/interactive gates before this final authority check.
    const ordinaryAutoRun = state.autoRun && !descriptor.plan_mode_only;
    const planArtifactDefault = state.mode === 'plan' && !state.nonPlanReadOnly
      && allowsPlanArtifact(descriptor, validation.args)
      && policy.stage === 'tool_default' && policy.matched_rule_id === null;
    if (policy.decision !== 'auto'
      && !(policy.decision === 'ask' && (approved || ordinaryAutoRun || planArtifactDefault))) {
      return rejected(validation.operationId, TOOL_ERROR_CODES.POLICY_DENIED, 'policy_rejected',
        'Current tool policy does not authorize this operation.');
    }
    return {
      schema_version: EXECUTION_CONTEXT_SCHEMA_VERSION,
      status: 'granted',
      operation_id: validation.operationId,
    };
  }

  close(binding) {
    const state = bindingStates.get(binding);
    if (!state) return false;
    state.closed = true;
    state.approved.clear();
    state.planApprovals.clear();
    state.pluginDescriptors.clear();
    return true;
  }
}

module.exports = {
  EXECUTION_CONTEXT_SCHEMA_VERSION,
  MAX_EXECUTION_CONTEXT_BYTES,
  MAX_POLICY_SNAPSHOT_BYTES,
  MAX_RUNTIME_OPERATION_BYTES,
  SessionExecutionAuthority,
  getTrustedExecutionBinding,
  validateRuntimeOperation,
};
