'use strict';

const { isDeepStrictEqual } = require('node:util');

const {
  createTurn,
} = require('./lib/canonical-turn-scenarios');
const {
  PARITY_SCENARIOS,
} = require('./lib/canonical-turn-parity-scenarios');

const LANE_LOCAL_TURN_EVENT_FIELDS = new Set([
  'event_id',
  'event_seq',
  'started_at',
  'completed_at',
  'turn_id',
  'message_id',
  'primary_message_id',
  'part_id',
]);
const CANONICAL_CONTROL_METHODS = new Set([
  'turn.event',
  'chat.done',
  'chat.error',
  'chat.stream_reset',
]);
const GENERATED_REASONING_ID_RE = /^reasoning_\d+_\d+_[0-9a-f]{6}$/;
const GENERATED_PAYLOAD_ID_PLACEHOLDER = '<generated-reasoning-id>';

function stripLaneLocalFields(value) {
  if (Array.isArray(value)) {
    return value.map(stripLaneLocalFields);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const stripped = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!LANE_LOCAL_TURN_EVENT_FIELDS.has(key)) {
      stripped[key] = stripLaneLocalFields(nested);
    }
  }
  return stripped;
}

function printableDiffValue(value) {
  return value === undefined ? null : value;
}

function normalizeMatchingGeneratedPayloadIds(laneA, laneB) {
  function normalizePair(valueA, valueB, inPayload) {
    if (
      inPayload
      && typeof valueA === 'string'
      && typeof valueB === 'string'
      && GENERATED_REASONING_ID_RE.test(valueA)
      && GENERATED_REASONING_ID_RE.test(valueB)
    ) {
      return [GENERATED_PAYLOAD_ID_PLACEHOLDER, GENERATED_PAYLOAD_ID_PLACEHOLDER];
    }
    if (Array.isArray(valueA) && Array.isArray(valueB)) {
      const length = Math.min(valueA.length, valueB.length);
      for (let index = 0; index < length; index += 1) {
        [valueA[index], valueB[index]] = normalizePair(valueA[index], valueB[index], inPayload);
      }
      return [valueA, valueB];
    }
    const valueAObject = valueA && typeof valueA === 'object' && !Array.isArray(valueA);
    const valueBObject = valueB && typeof valueB === 'object' && !Array.isArray(valueB);
    if (valueAObject && valueBObject) {
      for (const key of Object.keys(valueA)) {
        if (!Object.hasOwn(valueB, key)) {
          continue;
        }
        [valueA[key], valueB[key]] = normalizePair(
          valueA[key],
          valueB[key],
          inPayload || key === 'payload'
        );
      }
    }
    return [valueA, valueB];
  }

  return normalizePair(laneA, laneB, false);
}

function findValueDiff(laneA, laneB, field = '') {
  if (isDeepStrictEqual(laneA, laneB)) {
    return null;
  }
  if (Array.isArray(laneA) && Array.isArray(laneB)) {
    const length = Math.max(laneA.length, laneB.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= laneA.length || index >= laneB.length) {
        return {
          field: `${field}[${index}]`,
          lane_a: printableDiffValue(laneA[index]),
          lane_b: printableDiffValue(laneB[index]),
        };
      }
      const nested = findValueDiff(laneA[index], laneB[index], `${field}[${index}]`);
      if (nested) {
        return nested;
      }
    }
  }
  const laneAObject = laneA && typeof laneA === 'object' && !Array.isArray(laneA);
  const laneBObject = laneB && typeof laneB === 'object' && !Array.isArray(laneB);
  if (laneAObject && laneBObject) {
    const keys = [...new Set([...Object.keys(laneA), ...Object.keys(laneB)])].sort();
    for (const key of keys) {
      const nestedField = field ? `${field}.${key}` : key;
      if (!Object.hasOwn(laneA, key) || !Object.hasOwn(laneB, key)) {
        return {
          field: nestedField,
          lane_a: printableDiffValue(laneA[key]),
          lane_b: printableDiffValue(laneB[key]),
        };
      }
      const nested = findValueDiff(laneA[key], laneB[key], nestedField);
      if (nested) {
        return nested;
      }
    }
  }
  return {
    field: field || '$',
    lane_a: printableDiffValue(laneA),
    lane_b: printableDiffValue(laneB),
  };
}

function findFirstEventDiff(laneA, laneB) {
  const length = Math.max(laneA.length, laneB.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= laneA.length || index >= laneB.length) {
      return {
        index,
        field: '$event',
        lane_a: printableDiffValue(laneA[index]),
        lane_b: printableDiffValue(laneB[index]),
      };
    }
    const difference = findValueDiff(laneA[index], laneB[index]);
    if (difference) {
      return { index, ...difference };
    }
  }
  return null;
}

function finalizedEventsFor(turn) {
  const messages = turn.service.sessionStore.getSessionMessages(turn.sessionId);
  const finalized = turn.collector.buildFinalizedTurnEvents(turn.streamId, messages);
  return stripLaneLocalFields(Array.isArray(finalized) ? finalized : []);
}

async function runScenario(scenario, turnIndex) {
  const laneA = createTurn({
    turnIndex,
    canonicalPrimary: true,
    canonicalTurnEvents: true,
    canonicalBridge: true,
    notificationFilter: (method) => CANONICAL_CONTROL_METHODS.has(method),
  });
  const laneB = createTurn({
    turnIndex,
    canonicalPrimary: false,
    canonicalTurnEvents: false,
    canonicalBridge: false,
    notificationFilter: (method) => method !== 'turn.event',
  });
  const scenarioOptions = { content: scenario.content };
  await scenario.run(laneA, scenarioOptions);
  await scenario.run(laneB, scenarioOptions);
  const [normalizedLaneA, normalizedLaneB] = normalizeMatchingGeneratedPayloadIds(
    finalizedEventsFor(laneA),
    finalizedEventsFor(laneB)
  );
  return { laneA: normalizedLaneA, laneB: normalizedLaneB };
}

async function runParityGate({ verbose = false, scenarios = PARITY_SCENARIOS } = {}) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error('Canonical/legacy parity corpus is empty.');
  }
  const results = [];
  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    if (!scenario || typeof scenario.name !== 'string' || typeof scenario.run !== 'function') {
      throw new Error(`Invalid canonical/legacy parity scenario at index ${index}.`);
    }
    const { laneA, laneB } = await runScenario(scenario, index + 1);
    const firstDiff = findFirstEventDiff(laneA, laneB);
    results.push({
      name: scenario.name,
      divergent: firstDiff !== null,
      first_diff: firstDiff,
      a_count: laneA.length,
      b_count: laneB.length,
      ...(verbose ? { lane_a_events: laneA, lane_b_events: laneB } : {}),
    });
  }
  return {
    scenarios: results,
    summary: {
      scenarios: results.length,
      divergent_count: results.filter((entry) => entry.divergent).length,
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const unsupported = argv.filter((arg) => arg !== '--verbose');
  if (unsupported.length > 0) {
    throw new Error(`Unsupported argument: ${unsupported[0]}`);
  }
  const report = await runParityGate({ verbose: argv.includes('--verbose') });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`canonical/legacy parity gate failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  LANE_LOCAL_TURN_EVENT_FIELDS,
  findFirstEventDiff,
  normalizeMatchingGeneratedPayloadIds,
  runParityGate,
  stripLaneLocalFields,
};
