const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dumpTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');
const { dumpFailedTurnDiagnostic } = require('../services/backend/managed-sidecar-chat-turn-seams');
const { waitForDiagnosticDump } = require('./helpers/managed-sidecar-chat-lifecycle-helpers');

for (const failed of [false, true]) {
  for (const providerDiagnostics of [{ provider_call_count: 7 }, null]) {
    test(`${failed ? 'failed' : 'regular'} dump uses supplied ${providerDiagnostics ? 'snapshot' : 'null'} without fetching`, async (t) => {
      const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diagnostic-snapshot-'));
      t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
      let requests = 0;
      const serviceLogs = [];
      const service = {
        options: { userDataPath },
        serviceLogs,
        _emitServiceLog: (level, event, details) => serviceLogs.push({ level, event, details }),
        sidecarClient: {
          async harnessTurnDiagnostic() {
            requests += 1;
            return { provider_diagnostics: { provider_call_count: 99 } };
          },
        },
      };
      const params = { service, streamId: 'snapshot_turn', providerDiagnostics };
      if (failed) {
        dumpFailedTurnDiagnostic({
          ...params,
          terminal: { status: 'runtime_error' },
          turnDiagnosticState: {},
          runtime: { getDiagnosticToolEvents: () => [] },
          normalizedErrorPayload: { message: 'Provider failed' },
        });
      } else {
        await dumpTurnDiagnostic(params);
      }
      const filePath = await waitForDiagnosticDump(service, params.streamId);
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.equal(requests, 0);
      assert.deepEqual(payload.provider_diagnostics, providerDiagnostics);
    });
  }
}
