'use strict';
const { TOOL_ERROR_CODES } = require('../backend/error-codes');
const { evaluatePolicy } = require('../tools/tool-policy-evaluator');
const { digest, sandboxError } = require('./sandbox-errors');
const { captureSandboxAuthority } = require('./sandbox-project-authority');
const { createToolResourceClaim, projectToolResourceWait } = require('../tools/tool-resource-execution');
const ALLOWED = new Set(['run_command', 'ask_user', 'exit_plan_mode', 'home', 'task_board']);
function sandboxEnabled(service) {
  return service?.commandSandbox?.enabled === true
    || service?.configService?.getState?.()?.commandSandbox?.enabled === true;
}
function normalizeCommand(input) {
  const allowed = ['command', 'cwd', 'timeout_seconds', 'expected_exit_codes', 'purpose'];
  if (!input || Object.keys(input).some((key) => !allowed.includes(key))) throw sandboxError('sandbox_foreground_arguments_required');
  return { command: input.command, cwd: input.cwd ?? '.', timeoutSeconds: input.timeout_seconds ?? 10,
    expectedExitCodes: input.expected_exit_codes ?? [0] };
}
function authorizationPolicy(service, input, authority) {
  let snapshot;
  try { snapshot = service.toolPermissionStore?.getSnapshot?.(authority); } catch { /* unavailable fails closed below */ }
  const decision = evaluatePolicy({
    descriptor: { name: 'run_command', read_only: false, side_effecting: true, tool_family: 'shell', source_kind: 'builtin' },
    args: input, mode: '', snapshot: snapshot || {},
  });
  const paranoid = service.configService?.getState?.()?.safetyMode === 'paranoid';
  return { decision: !snapshot || decision.decision === 'deny' ? 'deny' : (paranoid ? 'ask' : decision.decision),
    digest: digest([snapshot || {}, paranoid, decision.decision]), id: decision.id || '' };
}
async function executeSandboxCommand(service, { input, sessionId, streamId, callId, abortSignal,
  readOnly, planMode, authorize, canonicalReadOnly = true, projectAuthority, executionAuthority, beforeProducer = null }) {
  const sandbox = service.commandSandbox;
  const failure = (reason) => ({
    tool_name: 'run_command', success: false, content_type: 'text', generated_artifacts: [],
    output: 'Docker sandbox: ' + reason.replaceAll('_', ' ') + '. No host command was run.',
    error_code: TOOL_ERROR_CODES.EXECUTION_FAILED,
    metadata: { execution: { backend: 'docker', status: 'failed', cleanup_confirmed: sandbox?.state !== 'recovery-required' && !['sandbox_cleanup_unconfirmed', 'sandbox_execution_uncertain'].includes(reason),
      workspace: 'disposable_copy', reason } },
  });
  if (!sandbox || !sandbox.enabled || typeof authorize !== 'function') return failure('sandbox_unavailable');
  if (canonicalReadOnly || readOnly || planMode) return failure('sandbox_read_only');
  if (!service.sidecarManager?.process || service._desktopPolicyProcess !== service.sidecarManager.process) {
    return failure('sandbox_policy_unacknowledged');
  }
  try {
    const scope = captureSandboxAuthority(service, sessionId, projectAuthority);
    const args = normalizeCommand(input);
    const policy = authorizationPolicy(service, input, scope.authority);
    if (policy.decision === 'deny') return failure('sandbox_policy_denied');
    const resourceClaim = createToolResourceClaim({ binding: executionAuthority,
      operationId: callId, toolName: 'run_command', input,
      required: !!service.sessionRuntime });
    const result = await sandbox.execute(args, {
      sessionId, streamId, callId, signal: abortSignal, readOnly, planMode, projectAuthority: scope.authority,
      resourceClaim, beforeProducer,
      isLive: () => service.activeStreams?.has(streamId) === true
        && service._desktopPolicyProcess === service.sidecarManager?.process,
    }, async (binding, assertLive, approvalSignal) => {
      assertLive();
      scope.assertCurrent();
      const current = authorizationPolicy(service, input, scope.authority);
      if (current.decision === 'deny') return { approved: false };
      const approved = current.decision === 'auto' || await authorize({
        tool_name: 'run_command', tool_call_id: callId, tool_input: input,
        reason: 'Run in the offline Docker sandbox. Command-created files are discarded.',
        policy_decision_id: current.id,
      }, approvalSignal);
      assertLive();
      scope.assertCurrent();
      const final = authorizationPolicy(service, input, scope.authority);
      if (approved !== true || final.decision === 'deny'
        || (final.digest !== current.digest && !(current.decision === 'ask' && final.decision === 'auto'))) return { approved: false };
      return { approved: true, digest: digest([binding, final.digest]),
        validate: () => {
          assertLive();
          scope.assertCurrent();
          if (authorizationPolicy(service, input, scope.authority).digest !== final.digest) throw sandboxError('sandbox_policy_changed');
        } };
    });
    return {
      tool_name: 'run_command', success: result.success === true, content_type: 'text', generated_artifacts: [],
      output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
      error_code: result.success ? null : TOOL_ERROR_CODES.EXECUTION_FAILED,
      metadata: { execution: { backend: 'docker', job_id: result.job_id, status: result.status,
        exit_code: result.exit_code, output_truncated: result.output_truncated === true,
        cleanup_confirmed: result.cleanup_confirmed === true, workspace: 'disposable_copy' } },
    };
  } catch (error) {
    if (projectToolResourceWait(error)) throw error;
    const reason = /^[a-z_]{1,100}$/u.test(error?.reason || '') ? error.reason : 'sandbox_execution_failed';
    return failure(reason);
  }
}
module.exports = { executeSandboxCommand, sandboxEnabled, ALLOWED, normalizeCommand, authorizationPolicy };
