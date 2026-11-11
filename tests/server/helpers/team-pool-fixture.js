'use strict';

// Shared pieces for the team pool tests (slices 4a-1 and 4a-2): an injected
// clock, deterministic random bytes, a logger spy, model fixtures and a real
// scheduler built through its facade.

const { createPoolScheduler } = require('../../../server/team/scheduler');
const { createClock } = require('./clock');

// Each call returns fresh, distinct bytes, so ids and tokens never collide.
function createRandomBytes() {
  let counter = 0;
  return (size) => {
    const out = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) {
      counter += 1;
      out[i] = (counter * 131 + i * 17 + Math.floor(counter / 251)) & 0xff;
    }
    out.writeUInt32BE(counter >>> 0, 0);
    return out;
  };
}

function createLoggerSpy() {
  const calls = [];
  const logger = (...args) => { calls.push(args); };
  logger.calls = calls;
  logger.text = () => JSON.stringify(calls);
  return logger;
}

function model(id, { contextLength = 32768, vision = false, thinking = false } = {}) {
  return { id, context_length: contextLength, vision, thinking };
}

function createScheduler({ clock = createClock(), limits, logger = createLoggerSpy() } = {}) {
  const scheduler = createPoolScheduler({ clock, randomBytes: createRandomBytes(), limits, logger });
  const changes = [];
  scheduler.onChange((change) => { changes.push(change); });
  return { scheduler, clock, logger, changes };
}

function registerNode(scheduler, { deviceId, memberId, slots = 1, models = [model('alpha')] }) {
  const result = scheduler.registerNode({ deviceId, memberId, slots, models });
  if (!result.ok) throw new Error(`registerNode refused: ${JSON.stringify(result)}`);
  return result.node_id;
}

function requestLease(scheduler, overrides = {}) {
  return scheduler.requestLease({
    conversationKey: 'conv:project_a:session_1', memberId: 'member_a', model: 'alpha', wantsVision: false,
    ...overrides,
  });
}

// An active lease with its route token taken.
function activeLease(scheduler, overrides = {}) {
  const result = requestLease(scheduler, overrides);
  if (!result.ok || result.lease.state !== 'active') throw new Error(`lease not active: ${JSON.stringify(result)}`);
  const taken = scheduler.takeRouteToken(result.lease.lease_id);
  if (!taken.ok) throw new Error('token not taken');
  return { lease: result.lease, token: taken.token };
}

const DONE_LINE = Buffer.from('data: [DONE]\n\n');

function sseData(text) {
  return Buffer.from(`data: ${text}\n\n`);
}

module.exports = {
  DONE_LINE, activeLease, createClock, createLoggerSpy, createRandomBytes, createScheduler, model,
  registerNode, requestLease, sseData,
};
