'use strict';

/**
 * chat-proposal-session-binding - the authority binding captured when a model proposes a linked
 * session (row 59 checkpoint 5a). It is the cp3 common binding with two differences: a projectless
 * chat may propose a session, so `workspace_id` and `root_identity` are null when the session has
 * no bound root; and kind `session` adds `session:{source_run_mode, lockdown}`. The proposal
 * service fills `effective_initiation`, `authorization_required` and `launch_grant_ref` once the
 * launch grant is resolved. `git` and `command` stay null. Nothing here logs or executes anything.
 *
 * `captureSessionBinding` resolves `{ok:true, binding}` or `{ok:false, reason, cause_code}` with
 * reason one of invalid_request | authority_changed | unavailable.
 */

const { normalizeRunMode } = require('./backend/session-preferences-patch');

const fail = (reason, cause_code) => ({ ok: false, reason, cause_code });

function cleanToken(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function authorityFailure(error) {
  const code = String(error?.reason || error?.code || '');
  if (/stale/i.test(code) || /stale/i.test(String(error?.message || ''))) return fail('authority_changed', 'authority_stale');
  if (/not_found|invalid_project/i.test(code)) return fail('invalid_request', 'session_unbound');
  return fail('unavailable', 'authority_unavailable');
}

function trustedFailure(error) {
  if (error?.code === 'run_mode_changed') return fail('authority_changed', 'run_mode_changed');
  if (/authority/i.test(String(error?.message || ''))) return fail('authority_changed', 'authority_stale');
  return fail('unavailable', 'execution_unavailable');
}

// `live` is the checked live call (`checkLiveCall`): its trusted binding supplies the captured
// Plan/read-only state; the stored session summary supplies the raw run mode and the lockdown flag.
function captureSessionBinding(context, live) {
  const backendService = context?.backendService;
  const sessionId = cleanToken(live?.sessionId);
  const trusted = live?.trusted || null;
  const owner = backendService?.projectAuthority;
  if (!sessionId || typeof owner?.captureSession !== 'function') return fail('unavailable', 'authority_unavailable');
  if (typeof trusted?.assertCurrent === 'function') {
    try {
      trusted.assertCurrent();
    } catch (error) {
      return trustedFailure(error);
    }
  }
  let authority;
  try {
    authority = owner.captureSession(sessionId);
  } catch (error) {
    return authorityFailure(error);
  }
  const revision = authority?.root_revision;
  if (!Number.isSafeInteger(revision) || revision < 0) return fail('unavailable', 'authority_unavailable');
  const rootId = cleanToken(authority.root_id);

  const summary = backendService.sessionStore?.getSessionSummary?.(sessionId) || null;
  const planMode = trusted ? trusted.mode === 'plan' : (summary?.plan_mode === true || summary?.run_mode === 'plan');
  const readOnly = trusted ? trusted.readOnly === true : (planMode || summary?.run_mode === 'propose');
  const sourceRunMode = planMode ? 'plan'
    : normalizeRunMode(summary?.run_mode, { planModeFallback: summary?.plan_mode === true });
  return {
    ok: true,
    binding: {
      source_project_id: cleanToken(authority.project_id),
      workspace_id: rootId,
      root_identity: rootId
        ? { root_id: rootId, device_id: authority.device_id ?? null, inode: authority.inode ?? null }
        : null,
      authority_revision: revision,
      run_mode: planMode ? 'plan' : 'agent',
      restrictions: { read_only: readOnly, plan_mode: planMode },
      model: cleanToken(summary?.preferred_model),
      effort: cleanToken(summary?.reasoning_effort),
      git: null,
      command: null,
      session: { source_run_mode: sourceRunMode, lockdown: summary?.lockdown === true },
    },
  };
}

module.exports = { captureSessionBinding };
