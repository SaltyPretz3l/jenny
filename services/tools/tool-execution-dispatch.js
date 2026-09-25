'use strict';
const { projectDecisionPause } = require('../backend/runtime-decision-control');
const { TOOL_ERROR_CODES } = require('../backend/error-codes');
const { getTrustedExecutionBinding } = require('../backend/session-execution-authority');
const { createProjectBrowserService } = require('../projects/project-browser-service');
const { createToolResourceClaim, projectToolResourceWait } = require('./tool-resource-execution');
const { createToolTestRunnerService } = require('./tool-test-runner-authority');
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

async function executeResolvedTool(executor, call, context, {
    approvalState,
    policyDecision = null,
    startTime,
    tool,
  }) {
    const { callId, toolName, input } = call;

    executor._logger('DEBUG', 'tool.execution_started', { callId, toolName });

    const trustedExecution = getTrustedExecutionBinding(context.executionAuthority);
    if (Object.hasOwn(context, 'executionAuthority') && !trustedExecution) {
      return executor._errorResult(callId, toolName,
        `Tool "${toolName}" was cancelled because execution authority expired.`, startTime,
        { approvalState: 'cancelled', errorCode: TOOL_ERROR_CODES.DISABLED });
    }
    let resourceClaim;
    let policyDeniedResult = null;
    let producerStarted = false;
    let producerReturned = false;
    let resourceStatus = 'failed';
    const deferredVerify = toolName === 'verify' && input.action !== 'list' && typeof context.beforeProducer === 'function';
    const startProducer = async () => {
      await context.beforeProducer?.();
      trustedExecution?.assertCurrent();
      const freshPolicyDecision = executor._evaluateToolPolicy(tool, input, context);
      const policyStillAllowsExecution = freshPolicyDecision.decision === 'auto'
        || (freshPolicyDecision.decision === 'ask' && policyDecision?.decision === 'ask');
      if (!policyStillAllowsExecution) {
        executor._logger('INFO', 'tool.denied', { callId, toolName, reason: 'policy_deny',
          policyDecisionId: freshPolicyDecision.id,
          matchedRuleId: freshPolicyDecision.matched_rule_id });
        policyDeniedResult = executor._errorResult(callId, toolName,
          `Tool "${toolName}" is denied by permission policy.`, startTime, {
            approvalState: 'denied', summary: `${toolName} denied`,
            errorCode: TOOL_ERROR_CODES.POLICY_DENIED,
            metadata: executor._policyDecisionMetadata(freshPolicyDecision),
          });
        throw new Error('Tool policy changed before producer start.');
      }
      producerStarted = true;
    };
    try {
      const scopedServices = trustedExecution?.services || null;
      const executionContext = {
      ...context,
      callId,
      pathPolicy: executor._pathPolicy,
      artifactService: scopedServices ? scopedServices.artifactService || null : executor._artifactService,
      worktreeService: scopedServices ? scopedServices.worktreeService || null : executor._worktreeService,
      automationService: scopedServices ? scopedServices.automationService || null : executor._automationService,
      workspacePresentationService: scopedServices
        ? executor._workspacePresentationService?.forSessionAuthority?.(
          trustedExecution.authority, trustedExecution.sessionId
        ) || null
        : executor._workspacePresentationService,
      browserSessionService: scopedServices
        ? createProjectBrowserService(executor._browserSessionService, trustedExecution, {
          signal: context.abortSignal,
        })
        : executor._browserSessionService,
      workspaceTestRunnerService: scopedServices
        ? toolName === 'verify' && scopedServices.workspaceTestRunnerService
          ? createToolTestRunnerService({
            service: scopedServices.workspaceTestRunnerService,
            executionAuthority: context.backendService?.sessionExecutionAuthority,
            binding: context.executionAuthority,
            callId,
            input,
            abortSignal: context.abortSignal,
            beforeProducer: deferredVerify ? startProducer : null,
          })
          : null
        : executor._workspaceTestRunnerService,
      homeAssistantService: scopedServices
        ? scopedServices.homeAssistantService || null : executor._homeAssistantService(),
      configService: scopedServices ? scopedServices.configService || null : executor._configService,
      refreshManagedConfig: executor._refreshManagedConfig,
      logger: executor._logger,
      };
      trustedExecution?.assertCurrent();
      // Decisions retain their live waiter; verify acquires its complete resource
      // set at the test runner. Child coordination owns bounded publication and
      // idempotence; child inference acquires its own lane and budget.
      if (!['ask_user', 'exit_plan_mode', 'verify', 'session_spawn', 'session_wait', 'session_result'].includes(toolName)) {
        resourceClaim = createToolResourceClaim({ binding: context.executionAuthority,
          operationId: callId, toolName, input, required: !!context.backendService?.sessionRuntime });
        await resourceClaim?.admit();
        trustedExecution?.assertCurrent();
      }
      if (!deferredVerify) await startProducer();
      const result = await tool.execute(input, executionContext);
      producerReturned = true;
      resourceStatus = result.isError ? 'failed' : 'succeeded';
      const durationMs = Date.now() - startTime;
      const isError = result.isError || false;
      const errorCode = isError ? normalizeToolErrorCode(result) : '';
      executor._logger('DEBUG', 'tool.execution_completed', {
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
        metadata: executor._mergePolicyDecisionMetadata(result.metadata, policyDecision),
        ...(toolName === 'preview_test' && tool.category === 'builtin' && input?.screenshot === true && !isError
          ? { previewImage: result.previewImage } : {}),
        errorCode,
      };
    } catch (error) {
      if (policyDeniedResult) return policyDeniedResult;
      if (!producerStarted && projectToolResourceWait(error)) throw error;
      if (toolName === 'ask_user' && projectDecisionPause(error)) {
        producerReturned = true;
        throw error;
      }
      const durationMs = Date.now() - startTime;
      const errorCode = normalizeToolErrorCode(error);
      const errorMessage = String(error && error.message || error || 'Unknown error');

      executor._logger('ERROR', 'tool.execution_failed', {
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
        metadata: executor._mergePolicyDecisionMetadata({}, policyDecision),
        errorCode,
      };
    } finally {
      await resourceClaim?.settle({ status: resourceStatus,
        cleanup: !producerStarted || producerReturned ? 'confirmed' : 'uncertain' });
    }
  }

module.exports = { executeResolvedTool };
