'use strict';

// Decide whether restoring a retained plugin-data generation is permitted
// (invariant 13 / PLUG-D10): "Incompatible post-update data writes erect a
// durable rollback barrier unless a declared and validated downgrade path
// preserves them ... A health-window rollback may never silently restore an
// older snapshot over newer user data; blocked rollback offers bounded
// export/manual-recovery guidance."
//
// This module makes no filesystem/network calls and holds no state: it is a
// pure decision function over the durable facts a caller already has on hand
// (the barrier record from PluginDataStateV1, the current durable mutation
// watermark, the watermark recorded at the retained generation's snapshot,
// and an optional declared/validated downgrade proof). The load-bearing
// property is "no silent data loss": every branch below either proves no
// writes are at risk, proves a validated downgrade carries every write
// forward, or refuses with bounded recovery guidance. There is no branch that
// simply proceeds "probably fine".

const BLOCK_REASONS = Object.freeze([
  'watermark_regression',
  'rollback_barrier_active',
  'unvalidated_writes_since_snapshot',
]);

// A small, fixed, closed vocabulary of manual-recovery guidance codes -- never
// free text -- so a blocked result stays bounded and machine-checkable. All
// three are always offered together: exporting current data is always
// possible (it does not depend on rollback), and the other two describe how a
// user or publisher can unblock rollback itself.
const GUIDANCE_CODES = Object.freeze([
  'export_current_data',
  'contact_publisher_for_downgrade_path',
  'manual_merge_required',
]);

function isFiniteNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isValidWatermark(watermark) {
  return (
    watermark
    && typeof watermark === 'object'
    && isFiniteNonNegativeInteger(watermark.sequence)
    && typeof watermark.recordedAt === 'string'
    && watermark.recordedAt.length > 0
  );
}

function permitted(detail) {
  return { permitted: true, reason: null, detail };
}

function blocked(reason, detail) {
  return { permitted: false, reason, detail: { ...detail, guidance: GUIDANCE_CODES } };
}

/**
 * @param {object} args
 * @param {{kind:'none'}|{kind:'erected',[key:string]:*}} args.barrier - the
 *   rollback_barrier field of a PluginDataStateV1 record.
 * @param {{sequence:number,recordedAt:string}} args.mutationWatermark - the
 *   CURRENT durable mutation watermark for the data domain.
 * @param {{sequence:number,recordedAt:string}} args.targetWatermark - the
 *   mutation watermark that was durably recorded as of the retained
 *   generation being rolled back to.
 * @param {{declared:boolean,validated:boolean,preservesWritesThroughSequence:number}} [args.downgrade]
 *   - a declared+validated downgrade path proof, if one exists.
 * @returns {{permitted:boolean,reason:string|null,detail:object}}
 */
function evaluateRollback({ barrier, mutationWatermark, targetWatermark, downgrade = null }) {
  if (!isValidWatermark(mutationWatermark) || !isValidWatermark(targetWatermark)) {
    return blocked('watermark_regression', { writesAtRisk: null, barrier: barrier || { kind: 'none' } });
  }

  const aheadBy = mutationWatermark.sequence - targetWatermark.sequence;
  if (aheadBy < 0) {
    // The "current" watermark is behind the retained generation's own
    // snapshot watermark -- an internally inconsistent input. Fail closed
    // rather than guess which side is stale.
    return blocked('watermark_regression', { writesAtRisk: aheadBy, barrier: barrier || { kind: 'none' } });
  }
  if (aheadBy === 0) {
    // No writes have landed since the retained generation's snapshot: there
    // is nothing a rollback could discard.
    return permitted({ writesPreserved: 0, viaValidatedDowngrade: false });
  }

  const hasValidatedDowngrade = Boolean(
    downgrade
    && downgrade.declared === true
    && downgrade.validated === true
    && isFiniteNonNegativeInteger(downgrade.preservesWritesThroughSequence)
    && downgrade.preservesWritesThroughSequence >= mutationWatermark.sequence,
  );
  if (hasValidatedDowngrade) {
    return permitted({ writesPreserved: aheadBy, viaValidatedDowngrade: true });
  }

  const barrierErected = Boolean(barrier && barrier.kind === 'erected');
  return blocked(barrierErected ? 'rollback_barrier_active' : 'unvalidated_writes_since_snapshot', {
    writesAtRisk: aheadBy,
    barrier: barrier || { kind: 'none' },
  });
}

module.exports = {
  BLOCK_REASONS,
  GUIDANCE_CODES,
  evaluateRollback,
};
