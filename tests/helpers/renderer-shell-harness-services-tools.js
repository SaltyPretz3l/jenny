'use strict';

/* tests/helpers/renderer-shell-harness-services-tools.js
 * The window.jennyShell.tools.* service stub, carved out of
 * renderer-shell-harness-services.js (at the 1015-line cap). Tests override
 * individual methods via harness `options.tools`; each override receives the
 * shared `{ state }` bag as its trailing argument.
 */

function createToolsServiceStub({ options, state }) {
  return {
    async list() {
      if (typeof options.tools?.list === 'function') {
        return options.tools.list({ state });
      }
      return [];
    },
    async approve(callId, payload) {
      if (typeof options.tools?.approve === 'function') {
        return options.tools.approve(callId, payload, { state });
      }
      return { ok: true };
    },
    async deny(callId) {
      if (typeof options.tools?.deny === 'function') {
        return options.tools.deny(callId, { state });
      }
      return { ok: true };
    },
    async getPermissions() {
      if (typeof options.tools?.getPermissions === 'function') {
        return options.tools.getPermissions({ state });
      }
      return { policies: {} };
    },
    async setPermission() { return { ok: true }; },
  };
}

module.exports = { createToolsServiceStub };
