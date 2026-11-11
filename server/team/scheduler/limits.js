'use strict';

// Team pool limits and fixed reasons (row 123, slice 4a-1). Values come from the
// node protocol spec's "Limits and timeouts" table. A caller may lower a limit,
// never raise one, except the first-byte limit, which may go up to 600 s once the
// SSE-comment measurement passes (spec Finding 3).

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const KIB = 1024;
const MIB = 1024 * KIB;

const DEFAULT_LIMITS = Object.freeze({
  // Table bounds.
  maxQueued: 32,
  maxSlots: 4,
  maxModelsPerNode: 64,
  maxMembers: 8,
  maxNodesPerMember: 2,
  maxNodes: 16, // maxMembers x maxNodesPerMember; an offline node is removed after terminalKeepMs.
  maxTerminalLeases: 256, // terminal leases kept for display; oldest dropped first.
  maxTerminalJobs: 256, // terminal jobs kept for claim replay and display; oldest dropped first.
  maxClaimsPerNode: 16, // remembered claim_seq answers per node (4 slots x 4 in flight).
  maxListeners: 8,
  maxWatchersPerJob: 2,
  affinityMax: 1024,
  exclusionMax: 1024,
  maxModelIdLength: 128,
  maxConversationKeyLength: 256,
  // Timers, all evaluated only inside sweep(now).
  queueWaitMs: 10 * MINUTE,
  nodeContactMs: 30 * SECOND,
  leaseIdleMs: 30 * MINUTE,
  firstByteMs: 120 * SECOND,
  stallMs: 60 * SECOND,
  jobTotalMs: 30 * MINUTE,
  jobWaitMs: 120 * SECOND,
  requeueMs: 10 * SECOND,
  terminalKeepMs: 10 * MINUTE,
  affinityIdleMs: 30 * MINUTE,
  exclusionMs: 10 * MINUTE,
  // Byte bounds. maxRequestBytes is also the gateway's body cap.
  maxChunkBytes: 64 * KIB,
  maxLineBytes: 1 * MIB,
  maxJobBytes: 32 * MIB,
  maxRequestBytes: 8 * MIB,
});

const RAISABLE = Object.freeze({ firstByteMs: 600 * SECOND });

function resolveLimits(overrides) {
  if (overrides === undefined || overrides === null) return DEFAULT_LIMITS;
  if (typeof overrides !== 'object') throw new TypeError('Pool limits must be an object.');
  const out = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new RangeError(`Unknown pool limit ${key}.`);
    const ceiling = RAISABLE[key] || DEFAULT_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new RangeError(`Pool limit ${key} must be an integer from 1 to ${ceiling}.`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

// Reasons a node may send in `fail` (spec "Failure reasons").
const NODE_FAIL_REASONS = Object.freeze(new Set([
  'engine_unreachable', 'engine_error', 'engine_timeout', 'model_not_loaded', 'user_stopped_sharing',
]));

// How the host ends a lease on purpose. Each is a lease trigger and a reason.
const CANCEL_REASONS = Object.freeze(['cancelled', 'conversation_deleted']);

// Lease end reasons that are not a node fault, so they exclude no node for the conversation.
const NON_EXCLUDING_REASONS = Object.freeze(new Set([...CANCEL_REASONS, 'settled', 'idle_timeout']));

module.exports = { CANCEL_REASONS, DEFAULT_LIMITS, NODE_FAIL_REASONS, NON_EXCLUDING_REASONS, resolveLimits };
