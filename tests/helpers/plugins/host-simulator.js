'use strict';

// Scriptable in-memory PluginStreamFrameV1 host for tests. Produces plain data
// -- never opens a real socket/process -- so tests can drive
// services/plugins/protocol/frame-settlement.js against a concrete misbehavior
// matrix without any timers or real I/O. Every "misbehavior" method below returns frames (and,
// where relevant, a `nowMs` to feed the reducer) rather than performing an
// action, keeping the whole helper synchronous and deterministic.

function deterministicHex(seed) {
  const hex = '0123456789abcdef';
  let x = (seed >>> 0) || 1;
  let out = '';
  for (let i = 0; i < 64; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += hex[x % 16];
  }
  return out;
}

/**
 * @param {{invocationId:string, commitEpoch:number, lifecycleEpoch:number}} config
 */
function createHostSimulator(config) {
  const { invocationId, commitEpoch, lifecycleEpoch } = config;
  let sequence = 0;

  function baseFrame(overrides) {
    const opts = overrides || {};
    const seq = typeof opts.sequence === 'number' ? opts.sequence : sequence;
    if (typeof opts.sequence !== 'number') sequence += 1;
    return {
      frame_schema_version: 1,
      invocation_id: invocationId,
      commit_epoch: typeof opts.commit_epoch === 'number' ? opts.commit_epoch : commitEpoch,
      lifecycle_epoch: typeof opts.lifecycle_epoch === 'number' ? opts.lifecycle_epoch : lifecycleEpoch,
      sequence: seq,
      frame: opts.frame,
    };
  }

  const wellBehaved = {
    progress(payload) {
      return baseFrame({ frame: { kind: 'progress', payload } });
    },
    data(payload) {
      return baseFrame({ frame: { kind: 'data', payload } });
    },
    backpressure(queueDepth, pauseMs) {
      return baseFrame({ frame: { kind: 'backpressure', queue_depth: queueDepth, pause_ms: pauseMs } });
    },
    terminal(status, opts) {
      const options = opts || {};
      return baseFrame({
        frame: {
          kind: 'terminal',
          status,
          retryable: Boolean(options.retryable),
          ...(options.resultDigest ? { result_digest: options.resultDigest } : {}),
          ...(options.reasonCode ? { reason_code: options.reasonCode } : {}),
        },
      });
    },
  };

  // The named misbehavior matrix the W5 lane contract calls out explicitly:
  // out-of-order, duplicate terminal, over-budget payload, stale epoch,
  // queue flood, and stall-past-deadline.
  const misbehavior = {
    outOfOrderPair() {
      const first = baseFrame({ sequence: 0, frame: { kind: 'data', payload: 'first' } });
      const second = baseFrame({ sequence: 2, frame: { kind: 'data', payload: 'second' } });
      return [first, second];
    },
    duplicateTerminal() {
      const first = baseFrame({ frame: { kind: 'terminal', status: 'succeeded', retryable: false } });
      const dup = baseFrame({ sequence: first.sequence, frame: { kind: 'terminal', status: 'failed', retryable: false } });
      return [first, dup];
    },
    overBudgetPayload(byteLength) {
      return baseFrame({ frame: { kind: 'data', payload: 'x'.repeat(byteLength) } });
    },
    staleEpoch() {
      const staleCommitEpoch = commitEpoch > 0 ? commitEpoch - 1 : commitEpoch + 1;
      return baseFrame({ commit_epoch: staleCommitEpoch, frame: { kind: 'data', payload: 'stale-epoch' } });
    },
    floodQueue(count) {
      const frames = [];
      for (let i = 0; i < count; i += 1) {
        frames.push(baseFrame({ frame: { kind: 'data', payload: `flood-${i}` } }));
      }
      return frames;
    },
    stallPastDeadline(deadlineEpochMs, overshootMs) {
      return {
        frame: baseFrame({ frame: { kind: 'data', payload: 'stalled' } }),
        arrivalNowMs: deadlineEpochMs + Math.max(1, overshootMs || 1),
      };
    },
  };

  return { ...wellBehaved, misbehavior, deterministicHex };
}

module.exports = { createHostSimulator, deterministicHex };
