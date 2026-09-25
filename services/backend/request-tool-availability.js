'use strict';

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
      } else if (state.readOnly && descriptor.side_effecting) reason = 'read-only mode blocks side-effecting tools';
      if (state.toolPreferences?.disabled_tools?.includes(name)) reason = 'disabled for this request';
    }
    tools[name] = { ...entry, available: !reason && (entry.available === true
      || (descriptor?.plan_mode_only && state.mode === 'plan')), reason };
  }
  return { tools_status: tools, tools_status_scope: 'request',
    project_id: state.authority.project_id, workspace_configured: Boolean(state.authority.root_path),
    plan_mode: state.mode === 'plan', read_only: state.readOnly };
}

module.exports = { scopedToolAvailability };
