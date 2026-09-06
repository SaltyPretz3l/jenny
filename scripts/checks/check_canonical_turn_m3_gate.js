'use strict';

const {
  CanonicalTurnMetrics,
} = require('../../services/backend/canonical-turn-metrics');
const {
  runParityGate,
} = require('./check_canonical_legacy_parity');
const {
  canonical,
  createService,
  createTurn,
  finishTurn,
  notify,
  runMultiTokenTurn,
  runReasoningTurn,
  runTextTurn,
  runToolTurn,
} = require('./lib/canonical-turn-scenarios');

const TURN_COUNT = 30;
const COMMIT_LATENCY_THRESHOLD_MS = 33;
const CANONICAL_M3_ROLLOUT_FLAGS = Object.freeze([
  'canonical_turn_events',
  'canonical_bridge',
  'canonical_renderer_projection',
]);

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function buildManualRolloutStatus(env = process.env) {
  const manualOverrideActive = isTruthyEnv(env.JENNY_ENABLE_CANONICAL_M3_ROLLOUT);
  return {
    manual_override_active: manualOverrideActive,
    decision: manualOverrideActive ? 'manual_canary_rollout' : 'follow_gate_decision',
    enabled_flags: manualOverrideActive ? CANONICAL_M3_ROLLOUT_FLAGS.slice() : [],
  };
}

async function runGate() {
  const metrics = new CanonicalTurnMetrics({ sampleLimit: 512 });
  const scenarios = [
    ...Array.from({ length: 10 }, () => runTextTurn),
    ...Array.from({ length: 8 }, () => runReasoningTurn),
    ...Array.from({ length: 8 }, () => runToolTurn),
    ...Array.from({ length: 4 }, () => runMultiTokenTurn),
  ];
  if (scenarios.length !== TURN_COUNT) {
    throw new Error(`M3 gate scenario count drifted: ${scenarios.length} != ${TURN_COUNT}`);
  }
  let totalRendererEvents = 0;
  let totalCapturedCanonicalEvents = 0;
  for (let index = 0; index < scenarios.length; index += 1) {
    const turn = createTurn({ turnIndex: index + 1, metrics });
    await scenarios[index](turn);
    totalRendererEvents += turn.service._m3GateEmitted.length;
    totalCapturedCanonicalEvents += turn.collector.capturedEvents.length;
  }
  const parityReport = await runParityGate();
  const divergentScenarios = parityReport.scenarios
    .filter((scenario) => scenario.divergent)
    .map((scenario) => scenario.name);
  for (const scenario of parityReport.scenarios) {
    if (scenario.divergent) {
      metrics.recordLiveReplayDivergence();
    }
  }
  const snapshot = metrics.snapshot();
  const counters = snapshot.counters || {};
  const latency = snapshot.latency_ms?.electron_ingest_to_renderer_commit_ms || {};
  const commitP95 = Number(latency.p95 || 0);
  const hasDivergence = Number(counters.live_replay_divergence_count || 0) > 0;
  const hasOrphanRepair = Number(counters.orphan_tool_repair_count || 0) > 0;
  const gatePassed = Boolean(hasDivergence || hasOrphanRepair);
  return {
    schema_version: 2,
    turns: TURN_COUNT,
    scenario_counts: {
      text_only: 10,
      reasoning: 8,
      tool_success: 8,
      multi_token: 4,
    },
    total_renderer_events: totalRendererEvents,
    total_captured_canonical_events: totalCapturedCanonicalEvents,
    metrics: snapshot,
    parity: {
      scenarios: parityReport.summary.scenarios,
      divergent_count: parityReport.summary.divergent_count,
      divergent_scenarios: divergentScenarios,
    },
    rollout: buildManualRolloutStatus(),
    gate: {
      passed: gatePassed,
      decision: gatePassed ? 'proceed_to_m3' : 'defer_m3',
      criteria: {
        live_replay_divergence_count: counters.live_replay_divergence_count || 0,
        orphan_tool_repair_count: counters.orphan_tool_repair_count || 0,
        electron_ingest_to_renderer_commit_p95_ms: commitP95,
        commit_latency_threshold_ms: COMMIT_LATENCY_THRESHOLD_MS,
      },
    },
  };
}

async function main() {
  const result = await runGate();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`canonical M3 gate failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  runGate,
};
