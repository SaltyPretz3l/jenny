'use strict';
function normalizeCommandSandbox(value) {
  // Missing field is the v52 migration; malformed present values never disable protection.
  if (value === undefined) return { enabled: false };
  return { enabled: value?.enabled !== false };
}
module.exports = { normalizeCommandSandbox };