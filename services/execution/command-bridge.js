'use strict';
const { TOOL_ERROR_CODES } = require('../backend/error-codes');
const { evaluatePolicy } = require('../tools/tool-policy-evaluator');
const { digest, sandboxError } = require('./sandbox-errors');
const { captureSandboxAuthority } = require('./sandbox-project-authority');
const { createToolResourceClaim, projectToolResourceWait } = require('../tools/tool-resource-execution');
const { getTrustedExecutionBinding } = require('../backend/session-execution-authority');
const { buildSyncedChangeReview } = require('./sandbox-change-review');
const { workspaceRootId } = require('../workspace-root-identity');
// Electron-owned tools that touch no host shell pass through the sandbox bridge unchanged.
// Seam 17 for a new manifest tool: tests/desktop-command-sandbox-approval.test.js pins this set.
const ALLOWED = new Set(['run_command', 'ask_user', 'suggest_next_step', 'exit_plan_mode', 'home', 'task_board', 'project_notes', 'propose_command',
  'propose_session', 'complete_session_handoff', 'conversations_recent', 'conversation_open', 'conversations_search',
  'sessions_list', 'session_status', 'session_transcript', 'session_stop', 'jenny_help',
  'settings_get', 'settings_change', 'chat_organize', 'chat_configure', 'project_create', 'projects_list', 'app_view', 'schedule_list', 'schedule_change', 'away_digest',
  'session_export', 'terminal_read', 'browser']); // row 94 P4: not terminal_run, which types into a real shell
// What the model reads for a refusal it cannot fix by retrying; other reasons keep the plain form.
const SNAPSHOT_LIMITS = require('./desktop-workspace-snapshot').LIMITS;
const { SYNCED_LIMITS } = require('./sandbox-mirror-sync');
const sizeLimit = (limits, verb) => `this workspace is too large to ${verb} the sandbox (limits: `
  + `${limits.bytes / 1048576} MiB, ${limits.entries.toLocaleString('en-US')} files and folders, `
  + `${limits.depth} levels deep). Retrying fails the same way`;
const FAILURE_GUIDANCE = Object.freeze({
  snapshot_limit: sizeLimit(SNAPSHOT_LIMITS, 'copy into'),
  sandbox_unavailable: 'the sandbox is not ready. The user can retry it or turn it off in Settings',
  sandbox_restore_point_failed: 'Jenny could not take a restore point for this folder, so the command did not start. Retrying may work',
});
const SYNCED_GUIDANCE = Object.freeze({ snapshot_limit: sizeLimit(SYNCED_LIMITS, 'sync into') });
// Row 106 approval wording (owner plan §8); without a restore point the card says there is no undo.
const APPROVAL_REASON = Object.freeze({
  copy: 'Run in the offline Docker sandbox. Command-created files are discarded.',
  synced: 'Run offline in a Linux copy of your workspace (/bin/sh). Changed files are copied back, except .git, '
    + 'hook folders, dependency folders and links, and can be undone one file at a time, except files Git ignores. '
    + 'Windows-built venvs and native modules may not run.',
  synced_no_undo: 'Run offline in a Linux copy of your workspace (/bin/sh). Changed files are copied back, except .git, '
    + 'hook folders, dependency folders and links. No undo: Jenny cannot take a restore point for this folder. '
    + 'Windows-built venvs and native modules may not run.',
});
function approvalReason(binding) {
  if (binding.workspace !== 'synced') return APPROVAL_REASON.copy;
  return binding.undo === true ? APPROVAL_REASON.synced : APPROVAL_REASON.synced_no_undo;
}
function failureOutput(reason, mode = 'copy') {
  const guidance = (mode === 'synced' && SYNCED_GUIDANCE[reason]) || FAILURE_GUIDANCE[reason];
  if (!guidance) return 'Docker sandbox: ' + reason.replaceAll('_', ' ') + '. No host command was run.';
  return `Docker sandbox: ${guidance}. No host command was run. Give the user the command to run in their own `
    + 'terminal, or tell them they can turn the command sandbox off in Settings to let commands run on this computer.';
}
// Row 106: what the model must know about write-back, since its next read sees the folder, not the mirror.
const WRITE_BACK_FAILED = Object.freeze({
  too_large: 'Jenny copied none of these changes back to the workspace: the command changed more files or bytes than the sync limit',
  failed: 'Jenny could not copy these changes back to the workspace',
});
function writeBackNotice(writeBack) {
  if (!writeBack) return 'No changes were copied back to the workspace.';
  if (WRITE_BACK_FAILED[writeBack.status]) return `${WRITE_BACK_FAILED[writeBack.status]}. The workspace on this computer is unchanged.`;
  const applied = Array.isArray(writeBack.applied) ? writeBack.applied.length : 0;
  const refused = Array.isArray(writeBack.refused) ? writeBack.refused : [];
  const lines = applied ? [`Copied ${applied} changed path(s) back to the workspace.`] : [];
  if (refused.length) {
    const listed = refused.slice(0, 5).map((item) => `${item.path} (${String(item.reason).replaceAll('_', ' ')})`).join(', ');
    lines.push(`${refused.length} changed path(s) were not copied back to the workspace on this computer: ${listed}`
      + `${refused.length > 5 ? ', ...' : ''}. Those paths still hold their earlier content there.`);
  }
  return lines.join(' ');
}
function sandboxEnabled(service) {
  return service?.commandSandbox?.enabled === true
    || service?.configService?.getState?.()?.commandSandbox?.enabled === true;
}
// Busy is ready for the next call; anything else refuses every Run until the user retries.
function sandboxReady(service) {
  return ['ready', 'busy'].includes(service?.commandSandbox?.state);
}
function normalizeCommand(input) {
  const allowed = ['command', 'cwd', 'timeout_seconds', 'expected_exit_codes', 'purpose'];
  if (!input || Object.keys(input).some((key) => !allowed.includes(key))) throw sandboxError('sandbox_foreground_arguments_required');
  return { command: input.command, cwd: input.cwd ?? '.', timeoutSeconds: input.timeout_seconds ?? 10,
    expectedExitCodes: input.expected_exit_codes ?? [0] };
}
function authorizationPolicy(service, input, authority, mode = sandboxMode(service)) {
  let snapshot;
  try { snapshot = service.toolPermissionStore?.getSnapshot?.(authority); } catch { /* unavailable fails closed below */ }
  const decision = evaluatePolicy({
    descriptor: { name: 'run_command', read_only: false, side_effecting: true, tool_family: 'shell', source_kind: 'builtin' },
    args: input, mode: '', snapshot: snapshot || {},
  });
  const paranoid = service.configService?.getState?.()?.safetyMode === 'paranoid';
  return { decision: !snapshot || decision.decision === 'deny' ? 'deny' : (paranoid ? 'ask' : decision.decision),
    ordinaryAsk: !paranoid && decision.stage === 'tool_default' && decision.decision === 'ask'
      && !Object.hasOwn(snapshot?.legacy_policies || {}, 'run_command'),
    digest: digest([snapshot || {}, paranoid, decision.decision, mode]), id: decision.id || '' };
}
function sandboxMode(service) {
  return service?.commandSandbox?.mode === 'synced' ? 'synced' : 'copy';
}
// Who would run this without a card: the auto policy or the chat's auto-run (ordinary asks only).
function unattendedGrant(policy, trusted, sessionId) {
  if (policy.decision === 'auto') return digest(['synced-grant', 'policy', policy.digest]);
  if (policy.ordinaryAsk && trusted?.autoRun === true) return digest(['synced-grant', 'auto_run', sessionId]);
  return null;
}
// What Dockerfile.worker ships: a missing program is the image, not the command (2026-11-03
// Rust session: rustc "not found" read as success behind a pipe, then as an internal error).
const SANDBOX_RUNTIMES = 'Node.js (node, npm, npx, yarn) and Python 3';
const MISSING_PROGRAM = /(?:^|\n)(?:[\w/]*sh: \d+: )?([\w.+-]+): (?:command )?not found/u;
// A completed run's exit code is the command's own result: the model reads it, and the class
// says fix-and-rerun rather than internal_error (the host shell's HB-035 rule).
function completedRunReport(result) {
  const exitCode = result.status === 'completed' && Number.isInteger(result.exit_code) ? result.exit_code : null;
  if (exitCode === null) return { notes: [], metadata: {} };
  const notes = [`[exit code ${exitCode}]`];
  const missing = MISSING_PROGRAM.exec(`${result.stdout || ''}\n${result.stderr || ''}`);
  if (missing || exitCode === 127) {
    notes.push(`The sandbox image has only ${SANDBOX_RUNTIMES}${missing ? `; ${missing[1]} is not installed there` : ''}. `
      + 'Give the user the command for their own terminal, or tell them they can turn the command sandbox off in Settings.');
  }
  if (result.success === true) return { notes, metadata: {} };
  return { notes, metadata: { failure_class: 'precondition_unmet',
    remediation: `The command ran in the sandbox and exited with code ${exitCode}. That is the command's own result, `
      + 'not a tool failure: read the output, fix the cause and run it again.' } };
}
function workspaceMetadata(mode, result, { authority, callId, success, cancelled }) {
  if (mode !== 'synced') return { workspace: 'disposable_copy' };
  const detail = result?.synced;
  const metadata = { workspace: 'synced' };
  if (!detail?.command_may_start) return metadata;
  const callOutcome = cancelled ? 'cancelled' : success ? 'succeeded' : 'failed';
  return { ...metadata, review: buildSyncedChangeReview({ writeBack: detail.write_back || { status: 'failed' },
    restorePoint: detail.restore_point, callOutcome, workspaceId: workspaceRootId(authority.root_path) || '',
    operationId: callId }) };
}
async function executeSandboxCommand(service, { input, sessionId, streamId, callId, abortSignal,
  readOnly, planMode, authorize, canonicalReadOnly = true, projectAuthority, executionAuthority, beforeProducer = null }) {
  const sandbox = service.commandSandbox;
  const mode = sandboxMode(service);
  let authority = null;
  const failure = (reason, error = null) => {
    // Bounded to the last refusal: a command card's Run reads it to say why nothing ran.
    service.lastSandboxFailure = { streamId, reason };
    const { review, workspace } = authority ? workspaceMetadata(mode, error, { authority, callId, success: false })
      : { workspace: mode === 'synced' ? 'synced' : 'disposable_copy' };
    const ran = error?.synced?.command_may_start === true;
    return {
      tool_name: 'run_command', success: false, content_type: 'text', generated_artifacts: [],
      output: ran ? 'Docker sandbox: ' + reason.replaceAll('_', ' ') + '. The command may have run in the synced copy. '
        + writeBackNotice(error.synced.write_back) : failureOutput(reason, mode),
      error_code: TOOL_ERROR_CODES.EXECUTION_FAILED,
      metadata: { execution: { backend: 'docker', status: 'failed', cleanup_confirmed: sandbox?.state !== 'recovery-required' && !['sandbox_cleanup_unconfirmed', 'sandbox_execution_uncertain'].includes(reason),
        workspace, reason }, ...(review || {}) },
    };
  };
  if (!sandbox || !sandbox.enabled || typeof authorize !== 'function') return failure('sandbox_unavailable');
  if (canonicalReadOnly || readOnly || planMode) return failure('sandbox_read_only');
  if (!service.sidecarManager?.process || service._desktopPolicyProcess !== service.sidecarManager.process) {
    return failure('sandbox_policy_unacknowledged');
  }
  try {
    const scope = captureSandboxAuthority(service, sessionId, projectAuthority);
    authority = scope.authority;
    const trusted = getTrustedExecutionBinding(executionAuthority);
    if (executionAuthority != null && !trusted) throw sandboxError('sandbox_stale_authority');
    trusted?.assertCurrent();
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
      trusted?.assertCurrent();
      // The binding's mode is the one this run stages; the policy digest is bound to it.
      const runMode = binding.workspace === 'synced' ? 'synced' : 'copy';
      const current = authorizationPolicy(service, input, scope.authority, runMode);
      if (current.decision === 'deny') return { approved: false };
      const grant = unattendedGrant(current, trusted, sessionId);
      // Synced: unattended only with a restore point and a grant the user approved in synced mode.
      const unattended = grant !== null && (runMode === 'copy'
        || (binding.undo === true && await sandbox.synced?.hasGrant?.(grant) === true));
      const asked = !unattended;
      const approved = unattended || await authorize({
        tool_name: 'run_command', tool_call_id: callId, tool_input: input,
        reason: approvalReason(binding),
        policy_decision_id: current.id,
      }, approvalSignal);
      assertLive();
      scope.assertCurrent();
      trusted?.assertCurrent();
      const final = authorizationPolicy(service, input, scope.authority, runMode);
      if (approved !== true || final.decision === 'deny'
        || (final.digest !== current.digest && !(current.decision === 'ask' && final.decision === 'auto'))) return { approved: false };
      // A grant is a person's approval: a Full auto answer must not outlive Full auto (row 111).
      if (runMode === 'synced' && asked && grant && service.primaryFullAuto?.isArmed?.(sessionId) !== true) await sandbox.synced?.stampGrant?.(grant);
      return { approved: true, digest: digest([binding, final.digest]),
        validate: () => {
          assertLive();
          scope.assertCurrent();
          trusted?.assertCurrent();
          if (authorizationPolicy(service, input, scope.authority, runMode).digest !== final.digest) throw sandboxError('sandbox_policy_changed');
        } };
    });
    const { review, workspace } = workspaceMetadata(result.synced ? 'synced' : 'copy', result, { authority,
      callId, success: result.success === true, cancelled: result.status === 'cancelled' });
    const writeBack = result.synced?.write_back;
    const success = result.success === true && !WRITE_BACK_FAILED[writeBack?.status];
    const report = completedRunReport(result);
    return {
      tool_name: 'run_command', success, content_type: 'text', generated_artifacts: [],
      output: [result.stdout, result.stderr, result.synced && writeBackNotice(writeBack), ...report.notes]
        .filter(Boolean).join('\n'),
      error_code: success ? null : TOOL_ERROR_CODES.EXECUTION_FAILED,
      metadata: { execution: { backend: 'docker', job_id: result.job_id, status: result.status,
        exit_code: result.exit_code, output_truncated: result.output_truncated === true,
        cleanup_confirmed: result.cleanup_confirmed === true, workspace }, ...(review || {}), ...report.metadata },
    };
  } catch (error) {
    if (projectToolResourceWait(error)) throw error;
    const reason = /^[a-z_]{1,100}$/u.test(error?.reason || '') ? error.reason : 'sandbox_execution_failed';
    return failure(reason, error);
  }
}
module.exports = { executeSandboxCommand, sandboxEnabled, sandboxReady, sandboxMode, ALLOWED, normalizeCommand, authorizationPolicy };
