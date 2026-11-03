'use strict';

const { registerRuntimeChildCapability } = require('../session-runtime/child-capabilities');
const { APPLICATION_TURN_DIGEST, narrowDigestToolPreferences } = require('./application-turns');
const { RuntimeOperations } = require('../session-runtime/operations');
const { captureSessionRuntimeProviderRoute, assertSessionRuntimeProviderRouteCurrent } = require('./session-runtime-provider-route');
const { bindRuntimeInferenceBudget, assertRuntimeWork } = require('../session-runtime/runtime-work-authority');

// A row 86 digest turn's authority is read-only and limited to the digest's read tools.
function executionOptionsFor(request, cancellation) {
  const planMode = request.normalizedPreferences?.plan_mode === true;
  const digest = request.applicationTurn === APPLICATION_TURN_DIGEST;
  return {
    signal: cancellation?.signal || null,
    mode: planMode ? 'plan' : 'assist',
    readOnly: request.runtimeChildReadOnly === true || digest,
    toolPreferences: digest ? narrowDigestToolPreferences(request.toolPreferences) : request.toolPreferences,
    approvalMode: request.approvalMode,
    handoffPreparation: request.sessionHandoffPreparation,
  };
}

// Construct only inside the adapter's pre-start cleanup boundary: budget reads
// can fail after canonical claim, before any provider has acquired a worker.
function createRuntimeChatOperations(adapter, { work, route, context, assertCurrent, onSettled }) {
  // Configured local fallback stays in the admitted turn's resource class.
  // Engine selection still belongs to the sidecar's trusted RuntimeConfig.
  const fallbackRoutes = route.resource_class === 'local'
    ? ['ollama', 'vllm', 'openai-compatible', 'mock'].filter(engine => engine !== route.engine_type)
      .flatMap(engineType => {
        try {
          const candidate = captureSessionRuntimeProviderRoute(adapter.service, { engineType });
          return candidate.resource_class === route.resource_class ? [candidate] : [];
        } catch (_error) {
          // An unavailable optional fallback cannot prevent the primary route.
          // Any later attempt to use that uncaptured route is refused by admission.
          return [];
        }
      }) : [];
  const check = () => {
    assertCurrent();
    if (work.input.kind === 'child_chat') assertRuntimeWork(adapter.budgetStore, adapter.service, work, context);
  };
  const gateway = new RuntimeOperations({ children: adapter.service.sessionRuntime?.children?.bind({ work, context, assertCurrent }), inference: {
    lanes: adapter.lanes,
    initialLease: context.initialInferenceLease || null,
    fallbackRoutes,
    assertRouteCurrent: candidate => assertSessionRuntimeProviderRouteCurrent(adapter.service, candidate),
    budget: bindRuntimeInferenceBudget(adapter.budgetStore, adapter.service, work, context),
    route,
    requestId: context.lease.identity.streamId,
    sessionId: work.session_id,
    authorityRevision: context.trusted.authorityRevision,
    assertCurrent: check,
  }, tools: {
    broker: adapter.resourceBroker,
    pathResolver: adapter.pathResolver,
    executionAuthority: adapter.service.sessionExecutionAuthority,
    binding: context.binding,
    sandboxCommands: adapter.service.commandSandbox?.enabled === true || adapter.service.hostMode === 'server',
    onSettled,
  } });
  registerRuntimeChildCapability({ binding: context.binding, gateway, runtime: adapter.service.sessionRuntime,
    work, assertCurrent: check });
  return gateway;
}

module.exports = { createRuntimeChatOperations, executionOptionsFor };
