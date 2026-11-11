'use strict';

// Creates the child of an accepted primary-chat fork proposal (row 94 P2, owner pick F1). It is the
// fork twin of backend-sessions.js createLinkedChildSession and takes the same spec (the proposal's
// reserved child id and incarnation, its spawned_from proof, title, preferences, lockdown) plus
// `forkOfSessionId`: the child is a fork of that chat at its newest branchable message instead of an
// empty chat. The rest of the launch (proof checks, the first turn, retry) is the ordinary child's.
// Same result shape: {ok:true, session_id[, existed]} | {ok:false, code}.

const { normalizeSpawnedFrom } = require('./session-coordination-records');
const { buildSessionPreferencesPatch } = require('./session-preferences-patch');
const { forkSessionWithArtifacts } = require('./session-branching');
const { readForkSource } = require('./session-fork-source');
const { inheritedToolCategoryOverrides } = require('./spawned-child-tool-switches');

const CHILD_ID_RE = /^sess_[0-9]+_[0-9a-f]{12}$/;
const INCARNATION_RE = /^inc_[0-9a-f]{32}$/;

// The record fields the fork gets on top of the copied history: the reserved identity and proof, a
// child's reporting switch, the accepted preferences and the spawning chat's tool switches. Lockdown
// never drops below the source's.
function childFields(spec, provenance, sourceLockdown, toolCategoryOverrides) {
  const preferences = spec.preferences || {};
  return {
    ...buildSessionPreferencesPatch({
      preferred_model: preferences.preferred_model,
      reasoning_effort: preferences.reasoning_effort,
      run_mode: preferences.run_mode,
      lockdown: spec.lockdown === true || sourceLockdown === true,
      tool_category_overrides: toolCategoryOverrides,
    }),
    session_incarnation: spec.childIncarnation,
    spawned_from: provenance,
    session_mail: { schema_version: 1, reporting_enabled: true },
  };
}

function rollback(service, store, spec) {
  const current = store.getSession(spec.childSessionId);
  if (current && current.session_incarnation === spec.childIncarnation
    && current.spawned_from?.child_creation_hash === spec.spawnedFrom?.child_creation_hash) {
    if (store.deleteSession(spec.childSessionId, { scrubLinks: true }) !== true) {
      service._emitServiceLog?.('WARN', 'session.linked_fork_rollback_failed', { sessionId: spec.childSessionId });
    }
  }
}

async function createLinkedForkSession(service, spec = {}) {
  const { childSessionId, childIncarnation, title, projectId, forkOfSessionId } = spec;
  const provenance = normalizeSpawnedFrom(spec.spawnedFrom);
  if (typeof childSessionId !== 'string' || !CHILD_ID_RE.test(childSessionId)
    || typeof childIncarnation !== 'string' || !INCARNATION_RE.test(childIncarnation)
    || provenance?.schema_version !== 1 || typeof forkOfSessionId !== 'string' || !forkOfSessionId) {
    return { ok: false, code: 'invalid_request' };
  }
  const store = service.sessionStore;
  const existing = store?.getSession?.(childSessionId);
  if (existing) {
    return existing.spawned_from?.child_creation_hash === provenance.child_creation_hash
      ? { ok: true, session_id: childSessionId, existed: true }
      : { ok: false, code: 'proof_mismatch' };
  }
  const source = readForkSource(store, forkOfSessionId);
  if (!source.ok) return { ok: false, code: 'fork_source_unavailable' };
  // Permissions and deny rules were checked against the source's project when the proposal was made.
  if ((projectId ?? null) !== source.project_id) return { ok: false, code: 'fork_project_changed' };
  let summary;
  try {
    summary = await forkSessionWithArtifacts(store, forkOfSessionId, source.message_id, {
      title,
      branchSessionId: childSessionId,
      shadowStore: service.shadowStore,
      artifactService: service.artifactService,
      sessionFields: childFields(spec, provenance, source.lockdown,
        inheritedToolCategoryOverrides(store, provenance.parent_session_id)),
    });
  } catch {
    summary = null;
  }
  try {
    if (summary && store.flushSession(childSessionId) === true) {
      // As for an ordinary child: the parent's row opens so the new chat is visible under it.
      require('./backend-sessions').expandParentOf(store, provenance.parent_session_id);
      return { ok: true, session_id: childSessionId };
    }
  } catch {
    // A failed flush may leave only the just-created in-memory record.
  }
  if (summary) rollback(service, store, spec);
  return { ok: false, code: summary ? 'flush_failed' : 'fork_failed' };
}

module.exports = { createLinkedForkSession };
