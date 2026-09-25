'use strict';

/**
 * tests/renderer-runtime-refusals.test.js
 *
 * Runtime UX A1 (JEN-048) gate — one legible refusal vocabulary for every
 * closed reason the session runtime can return. The map is the single place
 * refusal copy lives, so the honesty rules (never "Paused" for a request,
 * never a position number for paused work, one named next step) are asserted
 * here rather than at each call site.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RUNTIME_REFUSAL_REASONS,
  describeRuntimeRefusal,
} = require('../renderer/chat/renderer-runtime-refusals');
const errorRecoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');

const SEVERITIES = new Set(['calm', 'danger']);
const CLASS_IDS = new Set(['loop', 'transport', 'provider', 'setup', 'unknown']);
const ACTIONS = new Set([null, 'open_settings', 'retry_turn', 'open_diagnostics']);

test('every published reason resolves to frozen, non-empty, closed-vocabulary copy', () => {
  assert.equal(Array.isArray(RUNTIME_REFUSAL_REASONS), true);
  assert.equal(Object.isFrozen(RUNTIME_REFUSAL_REASONS), true);
  assert.equal(new Set(RUNTIME_REFUSAL_REASONS).size, RUNTIME_REFUSAL_REASONS.length);
  for (const reason of RUNTIME_REFUSAL_REASONS) {
    const described = describeRuntimeRefusal({ reason });
    assert.equal(described.reason, reason, reason);
    assert.equal(Object.isFrozen(described), true, reason);
    assert.ok(String(described.title).trim().length > 0, `${reason} title`);
    assert.ok(String(described.hint).trim().length > 0, `${reason} hint`);
    assert.ok(SEVERITIES.has(described.severity), `${reason} severity`);
    assert.ok(CLASS_IDS.has(described.classId), `${reason} classId`);
    assert.ok(ACTIONS.has(described.action), `${reason} action`);
    assert.equal(String(described.hint).includes('{reason}'), false, `${reason} hint interpolation`);
  }
});

test('every refusal action id exists in the shared backend action table', () => {
  for (const reason of RUNTIME_REFUSAL_REASONS) {
    const { action } = describeRuntimeRefusal(reason);
    if (action === null) continue;
    assert.ok(errorRecoveryUtils.BACKEND_ACTIONS?.[action], `${reason} -> ${action}`);
  }
});

test('the closed vocabulary covers every refusal the runtime can hand the composer', () => {
  for (const reason of [
    'session_busy', 'lane_capacity', 'downstream_capacity', 'runtime_closing', 'runtime_disabled',
    'runtime_transcript_cache_pressure', 'session_pending_capacity', 'project_pending_capacity',
    'host_pending_capacity', 'pending_input_capacity', 'runtime_submission_capacity',
    'budget_exhausted', 'budget_exceeded', 'budget_provider_not_allowed', 'run_mode_changed',
    'inference_authority_stale', 'revision_conflict', 'runtime_snapshot_cursor_stale',
    'idempotency_conflict', 'runtime_unavailable', 'runtime_submission_refused',
    'runtime_submission_request_invalid',
    /* Runtime UX A2 (JEN-044): pause, resume and a work the runtime has dropped. */
    'runtime_pause_refused', 'pause_attempt_unavailable', 'runtime_resume_refused',
    'work_not_found', 'runtime_work_not_found',
    'runtime_no_running_reply', 'work_not_paused', 'runtime_checkpoint_required',
  ]) {
    assert.ok(RUNTIME_REFUSAL_REASONS.includes(reason), reason);
  }
});

test('a refused pause or resume names what failed and what is left to try', () => {
  for (const reason of ['runtime_pause_refused', 'pause_attempt_unavailable']) {
    const described = describeRuntimeRefusal(reason);
    assert.equal(described.title, "Couldn't pause", reason);
    assert.equal(described.severity, 'danger', reason);
    assert.equal(described.action, null, reason);
    assert.match(described.hint, /Try again, or Stop\./, reason);
  }
  const noReply = describeRuntimeRefusal('runtime_no_running_reply');
  assert.equal(noReply.title, "Couldn't pause");
  assert.match(noReply.hint, /nothing to pause/i);
  assert.equal(/next tool call|paused/i.test(noReply.hint), false);
  for (const reason of ['work_not_paused', 'runtime_checkpoint_required']) {
    const described = describeRuntimeRefusal(reason);
    assert.equal(described.title, "Couldn't resume", reason);
    assert.equal(described.severity, 'danger', reason);
  }
  assert.match(describeRuntimeRefusal('runtime_checkpoint_required').hint, /discard/i);
  const resume = describeRuntimeRefusal('runtime_resume_refused');
  assert.equal(resume.title, "Couldn't resume");
  assert.equal(resume.action, 'open_settings');
  assert.match(resume.hint, /Runtime limits/);
  for (const reason of ['work_not_found', 'runtime_work_not_found']) {
    const gone = describeRuntimeRefusal(reason);
    assert.equal(gone.title, 'That work is gone', reason);
    assert.equal(gone.severity, 'danger', reason);
    assert.equal(gone.action, null, reason);
  }
});

test('waiting on a reply, a shutdown or the user own run-mode flip stays calm', () => {
  for (const reason of ['session_busy', 'runtime_closing', 'run_mode_changed', 'lane_capacity',
    'downstream_capacity', 'runtime_transcript_cache_pressure', 'runtime_submission_capacity',
    'runtime_snapshot_cursor_stale']) {
    assert.equal(describeRuntimeRefusal(reason).severity, 'calm', reason);
  }
  for (const reason of ['runtime_disabled', 'host_pending_capacity', 'pending_input_capacity',
    'budget_exhausted', 'idempotency_conflict', 'runtime_submission_refused']) {
    assert.equal(describeRuntimeRefusal(reason).severity, 'danger', reason);
  }
});

test('an off runtime and an exhausted budget point at one concrete next step', () => {
  const off = describeRuntimeRefusal('runtime_disabled');
  assert.equal(off.action, 'open_settings');
  assert.match(off.hint, /Settings/);
  assert.equal(describeRuntimeRefusal('budget_exhausted').action, 'open_settings');
  assert.equal(describeRuntimeRefusal('inference_authority_stale').action, 'retry_turn');
  assert.equal(describeRuntimeRefusal('runtime_submission_refused').action, 'open_diagnostics');
});

test('refusal copy never says paused, never numbers a queue position, never quotes money', () => {
  for (const reason of RUNTIME_REFUSAL_REASONS) {
    const { title, hint } = describeRuntimeRefusal(reason);
    const copy = `${title} ${hint}`;
    assert.equal(/\bpaused\b/i.test(copy), false, `${reason} must not call a refusal "paused"`);
    assert.equal(/position \d|#\d/i.test(copy), false, `${reason} must not number a position`);
    assert.equal(/\$\s*\d/.test(copy), false, `${reason} must not quote a dollar amount`);
    assert.equal(/\bwithdrawn\b/i.test(copy), false, `${reason} must not claim a withdrawal`);
  }
});

test('an IPC failure, a thrown error and a bare string resolve the same reason', () => {
  const fromIpc = describeRuntimeRefusal({ ok: false, acceptance: 'rejected',
    error: { code: 'CMP-RUNTIME-0005', reason: 'runtime_closing' } });
  const fromError = describeRuntimeRefusal(Object.assign(new Error('runtime_closing'),
    { code: 'runtime_closing' }));
  const fromString = describeRuntimeRefusal('runtime_closing');
  const fromNested = describeRuntimeRefusal({ error: { code: 'runtime_closing' } });
  for (const described of [fromIpc, fromError, fromString, fromNested]) {
    assert.equal(described.reason, 'runtime_closing');
    assert.equal(described.severity, 'calm');
    assert.match(described.title, /shutting down/i);
  }
});

test('an unrecognised reason falls back without losing the raw reason or inventing a step', () => {
  const described = describeRuntimeRefusal({ reason: 'bespoke_internal_failure' });
  assert.equal(described.reason, 'bespoke_internal_failure');
  assert.equal(described.classId, 'unknown');
  assert.equal(described.severity, 'danger');
  assert.equal(described.action, null);
  assert.match(described.hint, /bespoke_internal_failure/);
  const empty = describeRuntimeRefusal(null);
  assert.equal(empty.reason, 'unknown');
  assert.ok(String(empty.hint).trim().length > 0);
  assert.equal(Object.isFrozen(empty), true);
});

test('free text never reaches the person: only reason-shaped tokens are echoed', () => {
  for (const input of [
    'private C:\\profile\\runtime failure',
    { message: 'Something broke at C:\\profile' },
    { error: { code: 'CMP-RUNTIME-0005', message: 'private C:\\profile\\runtime failure' } },
    new Error('private C:\\profile\\runtime failure'),
  ]) {
    const described = describeRuntimeRefusal(input);
    assert.equal(described.reason, 'unknown');
    assert.equal(String(described.hint).includes('profile'), false);
    assert.equal(String(described.hint).includes('CMP-RUNTIME'), false, 'the envelope code is not a reason');
  }
  assert.equal(describeRuntimeRefusal({ error: { code: 'CMP-RUNTIME-0005', reason: 'runtime_work_not_found' } }).reason,
    'runtime_work_not_found');
});
