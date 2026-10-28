'use strict';
// SPEC (row 62): startup reconciles run one step per chat in time slices and
// yield to the event loop between slices, so a large chat history no longer
// blocks the main process during boot.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runStepsInSlices, scheduleSlicedStartupReconcile } = require('../services/time-sliced-steps');
const { ChatMessagingService } = require('../services/chat-messaging-service');
const { ChatProposalService } = require('../services/chat-proposal-service');

test('steps run in order and yield only once a slice has used its budget', async () => {
  let clock = 0;
  const ran = [];
  const yields = [];
  const steps = [5, 5, 1, 9, 2].map((cost, index) => () => { ran.push(index); clock += cost; });
  await runStepsInSlices(steps, {
    budgetMs: 8,
    now: () => clock,
    yieldImpl: async () => { yields.push(ran.length); },
  });
  assert.deepEqual(ran, [0, 1, 2, 3, 4]);
  // 5+5 crosses 8 after step 1; 1+9 crosses it after step 3; the last 2 never does.
  assert.deepEqual(yields, [2, 4]);
});

test('the scheduled reconcile lets queued timers run between slices', async () => {
  const order = [];
  const service = {
    startupReconcileSteps: () => [0, 1, 2].map((index) => () => {
      order.push(`step:${index}`);
      if (index === 0) setTimeout(() => order.push('ipc'), 0);
    }),
  };
  scheduleSlicedStartupReconcile(service, { budgetMs: 0 });
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.deepEqual(order, ['step:0', 'ipc', 'step:1', 'step:2']);
});

test('a service that cannot list its chats schedules nothing and does not throw', async () => {
  scheduleSlicedStartupReconcile({ startupReconcileSteps: () => { throw new Error('store gone'); } });
  await new Promise((resolve) => { setTimeout(resolve, 10); });
});

test('both startup reconcilers hand over one step per chat and none when listing fails', () => {
  const ids = ['a', 'b', 'c'];
  for (const Service of [ChatMessagingService, ChatProposalService]) {
    const steps = Service.prototype.startupReconcileSteps.call({ _listSessionIds: () => ids });
    assert.equal(steps.length, ids.length, Service.name);
    assert.ok(steps.every((step) => typeof step === 'function'), Service.name);
    const failing = Service.prototype.startupReconcileSteps.call({ _listSessionIds: () => { throw new Error('x'); } });
    assert.deepEqual(failing, [], Service.name);
  }
});
