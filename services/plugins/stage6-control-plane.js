'use strict';

const { RestrictedHostDiagnostics } = require('./restricted-host/diagnostics');
const { CrashCircuit } = require('./restricted-host/crash-circuit');
const { RestrictedHostProcessSupervisor } = require('./restricted-host/process-supervisor');
const { RestrictedHostPool } = require('./restricted-host/host-pool');
const { RestrictedTokenService } = require('./restricted-host/token-service');
const { SecretHandleBroker } = require('./restricted-host/secret-handle-broker');
const { RestrictedCapabilityBroker } = require('./restricted-host/capability-broker');
const { RestrictedInvocationController } = require('./restricted-host/invocation-controller');
const {
  Stage6RuntimeAuthority,
  createStage6RuntimeCoordinator,
} = require('./restricted-host/stage6-runtime-authority');

function createStage6ControlPlane({
  runtimeCoordinator,
  resolveRuntime,
  log = () => {},
  spawn,
  connect,
  platform,
  facade,
  baseDir = '',
  networkBroker,
  onQuarantine,
} = {}) {
  if (typeof resolveRuntime !== 'function') {
    throw new TypeError('stage6 control plane requires a restricted-host resolver');
  }
  const diagnostics = new RestrictedHostDiagnostics({ log });
  const crashCircuit = new CrashCircuit();
  const authority = new Stage6RuntimeAuthority({ diagnostics });
  const tokenService = new RestrictedTokenService();
  const secretHandleBroker = new SecretHandleBroker();
  const capabilityBroker = new RestrictedCapabilityBroker({
    tokenService,
    secretHandleBroker,
    networkBroker,
    facade,
    baseDir,
  });
  const supervisor = new RestrictedHostProcessSupervisor({
    resolveRuntime,
    diagnostics,
    crashCircuit,
    capabilityBroker,
    onCircuitOpen: onQuarantine,
    ...(spawn ? { spawn } : {}),
    ...(connect ? { connect } : {}),
    ...(platform ? { platform } : {}),
  });
  const hostPool = new RestrictedHostPool({
    supervisor,
    loadComponentBytes: (descriptor) => authority.loadComponentBytes(descriptor),
  });
  const invocationController = new RestrictedInvocationController({
    hostPool,
    tokenService,
    secretHandleBroker,
    getCurrentAuthority: (descriptor, invocation) => (
      authority.currentForDescriptor(descriptor, invocation)
    ),
  });
  authority.bindInvocationController(invocationController);
  const coordinator = createStage6RuntimeCoordinator({
    runtimeCoordinator,
    restrictedAuthority: authority,
  });

  return Object.freeze({
    runtimeCoordinator: coordinator,
    executeRestrictedTool: (toolName, args, context) => authority.execute(toolName, args, context),
    getState: () => ({
      ok: true,
      stage: 6,
      authority: authority.snapshot(),
      invocations: invocationController.snapshot(),
      hosts: hostPool.snapshot(),
      tokens: tokenService.snapshot(),
      secret_handles: secretHandleBroker.snapshot(),
      diagnostics: diagnostics.snapshot(),
    }),
    issueSecretHandle: (descriptor, execute, options) => {
      const current = authority.currentForDescriptor(descriptor);
      return current
        ? secretHandleBroker.issue(current, execute, options)
        : { ok: false, reason: 'secret_handle_authority_stale' };
    },
    dispose: () => authority.dispose(),
  });
}

module.exports = { createStage6ControlPlane };
