'use strict';

const { isNonEmptyPlainObject } = require('../tools/tool-policy-actions');

// A mixed tool (manifest `actions`) keeps its declared read actions in a
// read-only request, like the executor gate (dogfood HB-002 follow-up).
function hasReadAction(descriptor) {
  return isNonEmptyPlainObject(descriptor.actions)
    && Object.values(descriptor.actions).some(spec => isNonEmptyPlainObject(spec) && spec.side_effecting === false);
}

// Diagnostic projection only. Execution remains with the authority/policy owners.
function scopedToolAvailability(status, state, descriptorFor) {
  const tools = {};
  for (const [name, entry] of Object.entries(status || {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const descriptor = descriptorFor(name);
    let reason = entry.reason || null;
    if (descriptor) {
      if (descriptor.workspace_required && !state.authority.root_path) reason = 'workspace requirement missing';
      else if (descriptor.plan_mode_only) {
        if (state.mode !== 'plan') reason = 'tool is available only in plan mode';
        else if (reason === 'tool is available only in plan mode') reason = null;
      } else if (descriptor.propose_mode_only) {
        // Plan Plus: the captured request state says whether this is a Propose run.
        if (state.proposeMode !== true) reason = 'tool is available only in propose mode';
        else if (reason === 'tool is available only in propose mode') reason = null;
      } else if (state.readOnly && descriptor.side_effecting && !hasReadAction(descriptor)) reason = 'read-only mode blocks side-effecting tools';
      if (state.toolPreferences?.disabled_tools?.includes(name)
        || state.liveDisabledTools?.has(name)) reason = 'disabled for this request';
    }
    tools[name] = { ...entry, available: !reason && (entry.available === true
      || (descriptor?.plan_mode_only && state.mode === 'plan')
      || (descriptor?.propose_mode_only && state.proposeMode === true)), reason };
  }
  return { tools_status: tools, tools_status_scope: 'request',
    project_id: state.authority.project_id, workspace_configured: Boolean(state.authority.root_path),
    plan_mode: state.mode === 'plan', read_only: state.readOnly };
}

module.exports = { scopedToolAvailability };
