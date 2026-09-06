'use strict';

// Terminal progress fencing and bounded retention for PluginOperationProgressV1
// (PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md: "`PluginOperationProgressV1` binds
// every event to operation id, expected/observed generation, `commit_epoch`,
// monotonic sequence, and lifecycle epoch; one terminal event fences all later
// progress, and bounded retention prevents an old event from resurrecting or
// overwriting a completed operation").
//
// This is an in-memory projection, not durable state: authority lives in
// active-pointer.js and idempotency lives in operation-receipts.js (PLUG-D01,
// PLUG-D15). A progress log that disagrees with a settled receipt is wrong by
// definition, so nothing here may ever be read back as an outcome -- callers
// take outcomes from the receipt and use this only to decide which events are
// admissible for display.
//
// The four rejection reasons below are the whole contract, and each one maps to
// a named acceptance-matrix row ("late/duplicate/out-of-order operation progress
// after terminal settlement"):
//
//   sequence_not_monotonic  a sequence <= the highest already accepted
//   fenced_after_terminal   ANY event after a terminal, including a higher
//                           sequence -- a terminal is a fence, not a high-water
//                           mark, so a late event cannot slip past by counting
//   generation_mismatch     observed generation disagrees with expected
//   operation_id_mismatch   an event addressed to a different operation

const { validate } = require('../contracts/generated-plugin-contracts');

const CONTRACT_NAME = 'PluginOperationProgressV1';
const DEFAULT_MAX_RETAINED = 128;

function bindingMatches(expected, observed) {
  if (expected.commit_epoch !== observed.commit_epoch) return false;
  if (expected.generation_id !== undefined && observed.generation_id !== undefined) {
    if (expected.generation_id !== observed.generation_id) return false;
  }
  if (expected.revision !== undefined && observed.revision !== undefined) {
    if (expected.revision !== observed.revision) return false;
  }
  return true;
}

function isTerminalEvent(event) {
  return Boolean(event) && event.kind === 'terminal';
}

// A bounded, fenced projection for exactly one operation_id. `maxRetained`
// caps memory; the terminal event is exempt from eviction because dropping it
// would un-fence the operation and let a late event resurrect it -- which is
// the precise failure the retention bound exists to prevent.
class OperationProgressLog {
  constructor(operationId, { maxRetained = DEFAULT_MAX_RETAINED } = {}) {
    this.operationId = operationId;
    this.maxRetained = maxRetained;
    this.events = [];
    this.highestSequence = -1;
    this.terminal = null;
  }

  get isSettled() {
    return this.terminal !== null;
  }

  // Returns {ok:true, event} or {ok:false, reason, detail}. Never throws for a
  // domain reason: a rejected event is an expected, bounded outcome.
  accept(rawEvent) {
    const validated = validate(CONTRACT_NAME, rawEvent);
    if (!validated.ok) {
      return { ok: false, reason: 'invalid_progress_event', detail: validated.error };
    }
    const event = validated.value;

    if (event.operation_id !== this.operationId) {
      return {
        ok: false,
        reason: 'operation_id_mismatch',
        detail: { expected: this.operationId, actual: event.operation_id },
      };
    }

    // The fence is checked BEFORE monotonicity on purpose. A late event with a
    // higher sequence than the terminal is still fenced: settlement ends the
    // operation, and "arrived with a bigger number" is not authority to reopen
    // it. Checking monotonicity first would let such an event through here and
    // rely on a downstream check to catch it.
    if (this.terminal) {
      return {
        ok: false,
        reason: 'fenced_after_terminal',
        detail: { terminalSequence: this.terminal.sequence, rejectedSequence: event.sequence },
      };
    }

    if (event.sequence <= this.highestSequence) {
      return {
        ok: false,
        reason: 'sequence_not_monotonic',
        detail: { highest: this.highestSequence, received: event.sequence },
      };
    }

    if (!bindingMatches(event.expected_generation, event.observed_generation)) {
      return {
        ok: false,
        reason: 'generation_mismatch',
        detail: { expected: event.expected_generation, observed: event.observed_generation },
      };
    }

    this.highestSequence = event.sequence;
    this.events.push(event);
    if (isTerminalEvent(event.event)) {
      this.terminal = event;
    }
    this._evict();
    return { ok: true, event };
  }

  // Ring-buffer eviction that always keeps the terminal event. Oldest
  // non-terminal events are dropped first.
  _evict() {
    if (this.maxRetained <= 0 || this.events.length <= this.maxRetained) return;
    const overflow = this.events.length - this.maxRetained;
    let dropped = 0;
    this.events = this.events.filter((entry) => {
      if (dropped >= overflow) return true;
      if (this.terminal && entry.sequence === this.terminal.sequence) return true;
      dropped += 1;
      return false;
    });
  }

  // The terminal event's own view of the outcome. Explicitly NOT an
  // authoritative result: callers settle from the durable receipt. Returned as
  // a plain snapshot so a caller cannot mutate the log through it.
  terminalSnapshot() {
    if (!this.terminal) return null;
    return {
      sequence: this.terminal.sequence,
      status: this.terminal.event.status,
      retryable: this.terminal.event.retryable,
      terminal_result_digest: this.terminal.event.terminal_result_digest || null,
    };
  }
}

// Pure helper for building a schema-valid event without hand-assembling the
// object at every call site (and drifting from the contract's field names).
function buildProgressEvent({
  operationId,
  sequence,
  lifecycleEpoch,
  expectedGeneration,
  observedGeneration,
  recordedAt,
  event,
}) {
  const candidate = {
    progress_schema_version: 1,
    operation_id: operationId,
    sequence,
    lifecycle_epoch: lifecycleEpoch,
    expected_generation: expectedGeneration,
    observed_generation: observedGeneration,
    recorded_at: recordedAt,
    event,
  };
  const validated = validate(CONTRACT_NAME, candidate);
  if (!validated.ok) {
    throw new Error(
      `progress-log: candidate event failed validation at ${validated.error.path}: ${validated.error.reason}`
    );
  }
  return validated.value;
}

function createProgressLog(operationId, options) {
  return new OperationProgressLog(operationId, options);
}

module.exports = {
  CONTRACT_NAME,
  DEFAULT_MAX_RETAINED,
  OperationProgressLog,
  createProgressLog,
  buildProgressEvent,
  isTerminalEvent,
};
