'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStage5ControlPlane } = require('../../services/plugins/stage5-control-plane');

test('deferred package picker cannot continue into inspection or mutation after disposal', async () => {
  let releasePicker;
  let inspections = 0;
  let mutations = 0;
  const service = createStage5ControlPlane({
    distributionController: {
      startDistributionOperation() {
        mutations += 1;
        return { ok: true };
      },
    },
    selectLocalPackage: () => new Promise((resolve) => {
      releasePicker = resolve;
    }),
    inspectLocalPackage: async () => {
      inspections += 1;
      return { ok: true };
    },
  });

  const pending = service.startDistributionOperation({ client_request_id: 'deferred_picker' });
  await service.dispose();
  releasePicker({ ok: true, bytes: Buffer.from('signed-package') });
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'service_disposed');
  assert.equal(inspections, 0);
  assert.equal(mutations, 0);
});
