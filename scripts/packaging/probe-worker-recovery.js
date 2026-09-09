'use strict';
// Disposable packaging fixture only. The parent restarts both test containers
// between phases; this process deliberately exits with one durable admission.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { ExecutionBroker } = require('/app/services/host/execution-broker');
const { requestWorker } = require('/app/services/host/worker-transport');
const userDataPath = '/data/worker-recovery-proof';
const receiptPath = userDataPath + '/sandbox-admission.json';
async function main() {
  const mode = process.argv[2];
  assert.ok(['admit', 'recover'].includes(mode));
  const broker = new ExecutionBroker({ userDataPath });
  if (mode === 'admit') {
    await broker.prepare();
    void broker.execute({ command: 'sleep 90', timeoutSeconds: 120 }, { streamId: 'crash-proof' })
      .catch(() => {});
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await requestWorker('status');
      if (status.phase === 'running') {
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.pending.job_id, status.job_id);
        assert.equal(receipt.pending.incarnation, status.incarnation);
        process.stdout.write('Durable command admission recorded before simulated crash.\n');
        process.exit(0);
      }
      await delay(100);
    }
    throw new Error('worker admission timeout');
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.ok(receipt.pending);
  await broker.prepare();
  const status = await requestWorker('status');
  assert.notEqual(status.incarnation, receipt.pending.incarnation);
  assert.equal(status.previous_result.job_id, receipt.pending.job_id);
  assert.equal(status.previous_result.status, 'interrupted');
  assert.equal(status.previous_result.reason, 'namespace_restarted');
  assert.equal(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).pending, null);
  assert.equal(broker.status().available, true);
  await broker.close();
  fs.unlinkSync(receiptPath);
  fs.rmdirSync(userDataPath);
  process.stdout.write('Crash recovery confirmed namespace cleanup without replay or false success.\n');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
