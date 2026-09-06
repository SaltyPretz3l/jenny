'use strict';

// The structural activation fence for the active plugin-platform stage.
//
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md's stage-gate table gives Stage 3
// the exit proof "crash-safe disabled-only install/remove, forward guards, safe
// mode, audit, cleanup reconciliation" and lists what stays forbidden even
// AFTER Stage 3 exits: "any contribution execution, plugin network, plugin
// view, or MCP connection".
//
// The load-bearing property of the Stage-3 control plane is therefore: no code
// path may produce an `active` (or `preparing`) plugin state. This module makes
// that structural rather than conventional. Three complementary guards:
//
//   1. assertStagePermitsState  -- THROWS. Every other domain failure in this
//      subtree is returned as {ok:false, reason} (house style), and this one is
//      deliberately not. A lifecycle path that forgets to check a returned
//      result would silently activate a plugin; a lifecycle path that forgets
//      to call a throwing guard still cannot activate one, because the guard is
//      called on the single funnel every commit passes through. It also means a
//      future Stage-4 author who wants `active` must consciously edit THIS file
//      rather than add a branch somewhere else.
//   2. assertNoContributionExecution -- returns a bounded result (matching
//      operation-result.js's assertCleanupOrthogonality) because a package that
//      declares execution is ordinary fail-closed input, not a programmer bug.
//   3. filterToDisabledOnly -- normalizes rather than rejects, and REPORTS what
//      it downgraded, so an operation result can say "you asked for active, you
//      got installed_disabled" honestly instead of silently.
//
// `STATES` is imported from state-machine.js rather than re-listed, so this
// file cannot drift from the normative 9-state machine.

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { STATES, isState } = require('./state-machine');

// The program stage this control plane implements. This constant and
// scripts/checks/check_plugin_stage_boundary.py's `STAGE` move together, in the
// same owner-approved commit that opens the next stage's surfaces -- one of
// them advancing alone means either the fence or the boundary check is lying.
const CONTROL_PLANE_STAGE = 8;

// Which of state-machine.js's STATES a given stage is allowed to COMMIT.
// Stage 3 permits exactly the disabled-only vocabulary: a plugin may be absent,
// staged on the way in, installed-but-disabled, blocked, quarantined, or on the
// way out. `preparing`, `active`, and `disabling` are all activation-adjacent
// and are not reachable here -- `disabling` in particular is only meaningful as
// an exit from `active`, which Stage 3 can never enter.
const STAGE_PERMITTED_STATES = Object.freeze({
  3: Object.freeze([
    'absent',
    'staged',
    'installed_disabled',
    'blocked',
    'quarantined',
    'uninstalling',
  ]),
  // Prepared in advance while CONTROL_PLANE_STAGE remains 3. Stage 4A only
  // persists its two stable states; preparing/disabling remain transient.
  4: Object.freeze(['installed_disabled', 'active']),
  // Stage 5 adds distribution and remote HTTP MCP, but does not add another
  // durable lifecycle state. Native/stdio, restricted code, views, hooks, and
  // process-backed adapters remain fenced by the stage-boundary policy.
  5: Object.freeze(['installed_disabled', 'active', 'blocked', 'quarantined']),
  // Stage 6 adds Jenny-owned restricted component execution behind the same
  // durable lifecycle vocabulary. Full-host adapters, hooks, native/stdio
  // MCP, and custom views remain outside the permitted surface.
  6: Object.freeze(['installed_disabled', 'active', 'blocked', 'quarantined']),
  // Stage 7 adds sandboxed plugin views and the official declarative provider
  // adapter without adding a durable lifecycle state.
  7: Object.freeze(['installed_disabled', 'active', 'blocked', 'quarantined']),
  // Stage 8 adds default-off privileged adapters without changing durable
  // lifecycle vocabulary; authority remains generation- and epoch-bound.
  8: Object.freeze(['installed_disabled', 'active', 'blocked', 'quarantined']),
});

// States the current stage must never commit, derived (not re-typed) from the table above
// so the two can never disagree.
const STAGE_FORBIDDEN_STATES = Object.freeze(
  STATES.filter((state) => !STAGE_PERMITTED_STATES[CONTROL_PLANE_STAGE].includes(state))
);

const PERMITTED_SETS = new Map(
  Object.entries(STAGE_PERMITTED_STATES).map(([stage, states]) => [Number(stage), new Set(states)])
);

// The state every Stage-3 commit normalizes to.
const DISABLED_ONLY_STATE = 'installed_disabled';

// Bound on the downgrade report so a hostile or buggy 64-entry generation
// cannot produce an unbounded structure on a result surface.
const MAX_REPORTED_DOWNGRADES = 32;

// Contribution kinds PluginManifestV1 admits today. They remain inert signed
// declarative records at Stage 3; admitting their descriptors does not open an
// apply or execution seam. Any
// other kind -- known-executing or simply unrecognized -- is refused, so the
// gate fails CLOSED against a contribution kind added by a future manifest
// revision that this file has not been taught about.
const NON_EXECUTING_CONTRIBUTION_KINDS = Object.freeze([
  'skill',
  'prompt',
  'theme',
  'settings_schema',
  'command',
  'workflow',
  'mcp_descriptor',
  // Stage 7 declarative surfaces. The view bytes execute only inside the
  // Jenny-owned sandbox host; provider descriptors are interpreted by the
  // closed-vocabulary runtime and remain official-signature gated.
  'setup_scene',
  'panel',
  'artifact_renderer',
  'provider_descriptor',
]);
const NON_EXECUTING_KIND_SET = new Set(NON_EXECUTING_CONTRIBUTION_KINDS);
const STAGE8_PRIVILEGED_CONTRIBUTION_KINDS = Object.freeze([
  'native_mcp', 'session_provider', 'engine_adapter', 'hook',
]);
const STAGE8_KIND_SET = new Set([
  ...NON_EXECUTING_CONTRIBUTION_KINDS,
  ...STAGE8_PRIVILEGED_CONTRIBUTION_KINDS,
]);

function stagePermittedStates(stage) {
  return PERMITTED_SETS.get(stage) || null;
}

function gateError(reason, message, detail) {
  const error = new Error(message);
  error.name = 'StageGateError';
  error.code = PLUGIN_ERROR_CODES.POLICY_BLOCKED;
  error.reason = reason;
  error.detail = detail === undefined ? null : detail;
  return error;
}

// THROWS by design (see header). Called on every state a lifecycle operation is
// about to commit, immediately before runCommitSequence.
function assertStagePermitsState(state, { stage = CONTROL_PLANE_STAGE } = {}) {
  const permitted = stagePermittedStates(stage);
  if (!permitted) {
    // An unknown stage number cannot be proven safe, so it permits nothing.
    throw gateError('unknown_stage', `stage-gate: no permitted-state table for stage ${String(stage)}`, {
      stage: String(stage),
    });
  }
  if (!isState(state)) {
    throw gateError('unknown_state', `stage-gate: ${String(state)} is not a lifecycle state`, {
      state: String(state),
    });
  }
  if (!permitted.has(state)) {
    throw gateError(
      'stage_forbids_state',
      `stage-gate: stage ${stage} may not commit state ${state}`,
      { stage, state, permitted: [...permitted] }
    );
  }
  return { ok: true, stage, state };
}

function refusal(reason, detail) {
  return { ok: false, reason, detail: detail === undefined ? null : detail, code: PLUGIN_ERROR_CODES.POLICY_BLOCKED };
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// Reads either spelling of a descriptor field. Callers upstream of this gate
// are not all the same shape (a manifest-derived descriptor is snake_case, a
// hand-built one tends to be camelCase), and a gate that silently misses a
// declaration because of a key-spelling mismatch is worse than useless.
function pick(descriptor, ...names) {
  for (const name of names) {
    if (descriptor[name] !== undefined && descriptor[name] !== null) return descriptor[name];
  }
  return null;
}

// The four things the Stage-3 gate table still forbids after exit. Each check
// below is one row of that list, in the table's own order.
function assertNoContributionExecution(descriptor, { stage = CONTROL_PLANE_STAGE } = {}) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return refusal('descriptor_not_an_object', { type: typeof descriptor });
  }

  // (1) "any contribution execution".
  const contributions = asArray(pick(descriptor, 'contributions'));
  for (const contribution of contributions) {
    if (!contribution || typeof contribution !== 'object') {
      return refusal('contribution_not_an_object', null);
    }
    const kind = String(contribution.kind === undefined ? '' : contribution.kind);
    if (contribution.executes === true || contribution.execution || contribution.entrypoint) {
      return refusal('contribution_declares_execution', { kind });
    }
    const permittedKinds = stage >= 8 ? STAGE8_KIND_SET : NON_EXECUTING_KIND_SET;
    if (!permittedKinds.has(kind)) {
      // Fail closed: an unrecognized kind may execute for all this gate knows.
      return refusal('contribution_kind_not_permitted', { kind, permitted: [...permittedKinds] });
    }
  }

  // (2) "plugin network".
  const network = pick(descriptor, 'network', 'network_declarations', 'networkDeclarations');
  if (network !== null && asArray(network).length > 0) {
    return refusal('plugin_network_declared', { count: asArray(network).length });
  }

  // (3) "plugin view".
  const views = pick(descriptor, 'views', 'view_declarations', 'viewDeclarations');
  if (views !== null && asArray(views).length > 0) {
    return refusal('plugin_view_declared', { count: asArray(views).length });
  }

  // (4) "MCP connection".
  const mcp = pick(descriptor, 'mcp_servers', 'mcpServers', 'mcp');
  if (mcp !== null && asArray(mcp).length > 0) {
    return refusal('mcp_server_declared', { count: asArray(mcp).length });
  }

  return { ok: true, contributionCount: contributions.length };
}

// Normalizes a plugin list so every entry's COMMITTED (effective) state is
// `installed_disabled`, whatever desired state the caller asked for, and
// returns a bounded report of what was downgraded.
//
// `desired_state` is deliberately preserved, not rewritten: state-machine.js
// keeps desired and effective independent, and Stage 4 needs a durable record
// of what the user actually wanted. Only the effective
// state -- the one that decides what the committed generation may serve -- is
// forced.
function filterToDisabledOnly(plugins) {
  const entries = Array.isArray(plugins) ? plugins : [];
  const normalized = [];
  const downgraded = [];
  let downgradeCount = 0;
  for (const entry of entries) {
    // A non-object is not a plugin entry; it is dropped rather than normalized,
    // and it does not inflate the downgrade count either.
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const from = entry.effective_state;
    if (from !== DISABLED_ONLY_STATE) {
      downgradeCount += 1;
      // The COUNT is unbounded and honest; the reported LIST is bounded, so a
      // 64-entry generation cannot produce an unbounded result surface.
      if (downgraded.length < MAX_REPORTED_DOWNGRADES) {
        downgraded.push({
          publisher_id: entry.publisher_id,
          plugin_id: entry.plugin_id,
          requested_state: from === undefined ? null : from,
          committed_state: DISABLED_ONLY_STATE,
        });
      }
    }
    normalized.push({ ...entry, effective_state: DISABLED_ONLY_STATE });
  }
  return { plugins: normalized, downgraded, downgradeCount };
}

module.exports = {
  CONTROL_PLANE_STAGE,
  STAGE_PERMITTED_STATES,
  STAGE_FORBIDDEN_STATES,
  DISABLED_ONLY_STATE,
  NON_EXECUTING_CONTRIBUTION_KINDS,
  STAGE8_PRIVILEGED_CONTRIBUTION_KINDS,
  MAX_REPORTED_DOWNGRADES,
  stagePermittedStates,
  assertStagePermitsState,
  assertNoContributionExecution,
  filterToDisabledOnly,
};
