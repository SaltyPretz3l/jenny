'use strict';
const COMMAND_SANDBOX_MODES = Object.freeze(['copy', 'synced']);
function normalizeCommandSandbox(value) {
  // Missing field is the v52 migration; malformed present values never disable protection.
  if (value === undefined) return { enabled: false, mode: 'synced' };
  const enabled = value?.enabled !== false;
  // Row 106 (additive, no CONFIG_VERSION bump): a profile that enabled the sandbox before modes
  // existed keeps the isolated copy; turning it on fresh starts in the synced workspace.
  const mode = COMMAND_SANDBOX_MODES.includes(value?.mode) ? value.mode : (enabled ? 'copy' : 'synced');
  return { enabled, mode };
}
module.exports = { normalizeCommandSandbox, COMMAND_SANDBOX_MODES };
