'use strict';

// Pure parts of the scroll-snap replay tool (row 131, S0a): the scenario
// builders and the snap classifier. The browser run is the command-line tool
// only (scripts/eval/scroll-snap-replay.js); nothing here opens a browser.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCENARIO_NAMES,
  buildScenario,
  countTurns,
} = require('../scripts/eval/scroll-snap-replay/scenarios');
const {
  classifySnaps,
  mergeSameFrameSamples,
  findScrollJumps,
  landingFrameCount,
  FOLLOW_BOTTOM_PX,
  LANDING_BOTTOM_PX,
  ANCHOR_DROP_PX,
} = require('../scripts/eval/scroll-snap-replay/classifier');
const { createRng, words, paragraph } = require('../scripts/eval/scroll-snap-replay/text');

const STEP_TYPES = new Set(['send', 'emit', 'wait', 'open']);

function sample(overrides = {}) {
  return {
    t: 0,
    scrollTop: 1000,
    scrollHeight: 2000,
    clientHeight: 800,
    bottomDistance: 200,
    tailCushionPx: 0,
    followLatched: false,
    anchorId: 'row-1',
    anchorKind: 'assistant_text',
    anchorPrevTop: 300,
    anchorTop: 300,
    readerInput: false,
    stepName: 'idle',
    sessionId: 's',
    rowCount: 10,
    ...overrides,
  };
}

test('text helpers are deterministic for a seed and differ across seeds', () => {
  const a = words(createRng(7), 12);
  const b = words(createRng(7), 12);
  const c = words(createRng(8), 12);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(paragraph(createRng(3), 4), paragraph(createRng(3), 4));
});

test('every scenario builder is deterministic for a seed', () => {
  for (const name of SCENARIO_NAMES) {
    const first = buildScenario(name, { seed: 11 });
    const second = buildScenario(name, { seed: 11 });
    assert.deepEqual(first, second, `${name} must be identical for the same seed`);
    const other = buildScenario(name, { seed: 12 });
    assert.notDeepEqual({ seeds: first.seedMessages, steps: first.steps }, { seeds: other.seedMessages, steps: other.steps }, `${name} must vary with the seed`);
  }
});

test('scenario shape: name, seed messages, turn events and typed steps', () => {
  assert.deepEqual(SCENARIO_NAMES, ['proposal_turn_end', 'tool_heavy_short_chat', 'switch_into_long_chat', 'tool_heavy_long_chat']);
  for (const name of SCENARIO_NAMES) {
    const scenario = buildScenario(name, { seed: 1 });
    assert.equal(scenario.name, name);
    assert.ok(scenario.seedMessages && typeof scenario.seedMessages === 'object');
    assert.ok(scenario.turnEvents && typeof scenario.turnEvents === 'object');
    assert.deepEqual(Object.keys(scenario.turnEvents).sort(), Object.keys(scenario.seedMessages).sort());
    assert.ok(scenario.steps.length > 0);
    for (const step of scenario.steps) {
      assert.ok(STEP_TYPES.has(step.type), `unknown step type ${step.type}`);
      assert.ok(typeof step.name === 'string' && step.name, 'every step carries a name');
    }
  }
});

test('proposal_turn_end: about six earlier turns, then one live turn ending in a terminal complete', () => {
  const scenario = buildScenario('proposal_turn_end', { seed: 1 });
  const turns = countTurns(scenario.seedMessages[scenario.initialSessionId]);
  assert.ok(turns >= 5 && turns <= 7, `expected about 6 earlier turns, got ${turns}`);
  const emits = scenario.steps.filter((step) => step.type === 'emit').map((step) => step.payload);
  const kinds = emits.map((payload) => payload.type);
  assert.equal(kinds[0], 'started');
  assert.equal(kinds[kinds.length - 1], 'complete');
  assert.ok(kinds.includes('tool_use') && kinds.includes('tool_result'));
  assert.ok(kinds.indexOf('tool_use') < kinds.indexOf('tool_result'));
  assert.ok(kinds.indexOf('tool_result') < kinds.lastIndexOf('complete'));
  const reasoningLines = emits.filter((payload) => payload.reasoning?.entriesDelta?.length).length;
  assert.ok(reasoningLines >= 14, `about 15 reasoning lines, got ${reasoningLines}`);
  assert.equal(scenario.steps.filter((step) => step.type === 'send').length, 1);
  assert.equal(buildScenario('proposal_turn_end', { seed: 1, answers: true }).view, 'answers');
  assert.equal(scenario.view, 'timeline');
});

test('tool_heavy_short_chat: a new chat with 8 tool calls, each after 2 to 4 reasoning lines and 1.6 s of silence', () => {
  const scenario = buildScenario('tool_heavy_short_chat', { seed: 1 });
  assert.equal(countTurns(scenario.seedMessages[scenario.initialSessionId] || []), 0);
  const emits = scenario.steps.filter((step) => step.type === 'emit');
  const toolUses = emits.filter((step) => step.payload.type === 'tool_use');
  const toolResults = emits.filter((step) => step.payload.type === 'tool_result');
  const resets = emits.filter((step) => step.payload.type === 'stream_reset');
  assert.equal(toolUses.length, 8);
  assert.equal(toolResults.length, 8);
  assert.equal(resets.length, 8);
  assert.ok(resets.every((step) => step.payload.reason === 'tool_continuation'));
  assert.equal(emits[emits.length - 1].payload.type, 'complete');
  // Reasoning lines between the previous continuation (or start) and each tool call.
  let lines = 0;
  let toolsSeen = 0;
  for (const step of emits) {
    if (step.payload.reasoning?.entriesDelta?.length) lines += step.payload.reasoning.entriesDelta.length;
    if (step.payload.type === 'tool_use') {
      assert.ok(lines >= 2 && lines <= 4, `tool ${toolsSeen} preceded by ${lines} reasoning lines`);
      lines = 0;
      toolsSeen += 1;
    }
  }
  const silences = scenario.steps.filter((step) => step.type === 'wait' && step.ms === 1600);
  assert.equal(silences.length, 8, 'one 1.6 s silence per tool call');
});

test('switch_into_long_chat: A has 3 turns, B has more than 80, nothing streams', () => {
  const scenario = buildScenario('switch_into_long_chat', { seed: 1 });
  const ids = Object.keys(scenario.seedMessages);
  assert.equal(ids.length, 2);
  const [a, b] = [scenario.sessions[0].id, scenario.sessions[1].id];
  assert.equal(scenario.initialSessionId, a);
  assert.equal(countTurns(scenario.seedMessages[a]), 3);
  assert.ok(countTurns(scenario.seedMessages[b]) > 80, 'the DOM-window virtualizer needs over 80 turns');
  assert.equal(scenario.steps.filter((step) => step.type === 'emit' || step.type === 'send').length, 0);
  const opens = scenario.steps.filter((step) => step.type === 'open');
  assert.equal(opens.length, 1);
  assert.equal(opens[0].sessionId, b);
  assert.deepEqual(scenario.landing, { sessionId: b });
  // The persisted event log carries the turns so the renderer hydrates the real way.
  assert.ok(scenario.turnEvents[b].length > 200);
});

test('classifier flags a 4 px anchor drop and ignores a 3 px one', () => {
  assert.equal(ANCHOR_DROP_PX, 4);
  const drop = classifySnaps([
    sample({ t: 0 }),
    sample({ t: 16, anchorPrevTop: 300, anchorTop: 304, scrollTop: 996, stepName: 'complete', anchorKind: 'tool_call' }),
  ]);
  assert.equal(drop.length, 1);
  assert.equal(drop[0].kind, 'anchor_drop');
  assert.equal(drop[0].px, 4);
  assert.equal(drop[0].t, 16);
  assert.equal(drop[0].scrollTopFrom, 1000);
  assert.equal(drop[0].scrollTopTo, 996);
  assert.equal(drop[0].anchorRowKind, 'tool_call');
  assert.equal(drop[0].lastStepName, 'complete');
  const small = classifySnaps([sample({ t: 0 }), sample({ t: 16, anchorPrevTop: 300, anchorTop: 303 })]);
  assert.deepEqual(small, []);
  const up = classifySnaps([sample({ t: 0 }), sample({ t: 16, anchorPrevTop: 300, anchorTop: 250 })]);
  assert.deepEqual(up, [], 'content moving up is the reader following, not a drop');
});

test('two samples of one frame merge into the later one, measured from the earlier', () => {
  const merged = mergeSameFrameSamples([
    sample({ t: 0 }),
    sample({ t: 16, anchorPrevTop: 300, anchorTop: 362, readerInput: true }),
    sample({ t: 17, anchorPrevTop: 362, anchorTop: 300 }),
    sample({ t: 33 }),
  ]);
  assert.deepEqual(merged.map((entry) => entry.t), [0, 17, 33]);
  assert.equal(merged[1].anchorPrevTop, 300, 'the pair nets out to no move');
  assert.equal(merged[1].readerInput, true);
  assert.deepEqual(classifySnaps(merged), []);

  const swapped = mergeSameFrameSamples([
    sample({ t: 16, anchorId: 'row-1' }),
    sample({ t: 17, anchorId: 'row-2' }),
  ]);
  assert.equal(swapped.length, 1);
  assert.equal(swapped[0].anchorPrevTop, null, 'a replaced anchor row is not compared');
});

test('classifier ignores a move that follows a reader-input marker', () => {
  const result = classifySnaps([
    sample({ t: 0 }),
    sample({ t: 16, anchorPrevTop: 300, anchorTop: 340, readerInput: true }),
  ]);
  assert.deepEqual(result, []);
});

test('classifier does not compare an anchor across a replaced row', () => {
  const result = classifySnaps([
    sample({ t: 0 }),
    sample({ t: 16, anchorId: null, anchorPrevTop: null, anchorTop: null }),
  ]);
  assert.deepEqual(result, []);
});

test('classifier flags falling behind a latched follow only after more than 2 frames', () => {
  assert.equal(FOLLOW_BOTTOM_PX, 48);
  const behind = (t, extra = {}) => sample({ t, followLatched: true, bottomDistance: 120, anchorPrevTop: null, anchorTop: null, anchorId: null, ...extra });
  const two = classifySnaps([behind(0), behind(16)]);
  assert.deepEqual(two, [], 'two frames behind is not yet a snap');
  const three = classifySnaps([behind(0), behind(16), behind(32)]);
  assert.equal(three.length, 1);
  assert.equal(three[0].kind, 'fell_behind');
  assert.equal(three[0].t, 32);
  assert.equal(three[0].px, 120);
  const many = classifySnaps([behind(0), behind(16), behind(32), behind(48), behind(64)]);
  assert.equal(many.length, 1, 'one snap per stretch, not one per frame');
  const recovered = classifySnaps([
    behind(0), behind(16), behind(32, { bottomDistance: 10 }), behind(48), behind(64),
  ]);
  assert.deepEqual(recovered, [], 'a frame back at the bottom restarts the count');
  const unlatched = classifySnaps([behind(0, { followLatched: false }), behind(16, { followLatched: false }), behind(32, { followLatched: false })]);
  assert.deepEqual(unlatched, []);
  const reader = classifySnaps([behind(0), behind(16), behind(32, { readerInput: true })]);
  assert.deepEqual(reader, []);
});

test('classifier landing rule: the first move after the opened chat paints is the landing, later moves are snaps', () => {
  const landing = { sessionId: 'b', openT: 100 };
  const frame = (t, scrollTop, extra = {}) => sample({
    t, scrollTop, sessionId: 'b', rowCount: 12, anchorPrevTop: null, anchorTop: null, anchorId: null, ...extra,
  });
  const clean = classifySnaps([
    frame(80, 0, { sessionId: 'a' }),
    frame(116, 0),
    frame(132, 29000),
    frame(148, 29000),
  ], { landing });
  assert.deepEqual(clean, [], 'a single landing move is not a snap');
  const stepped = classifySnaps([
    frame(116, 0),
    frame(132, 6000),
    frame(148, 22000),
    frame(164, 26500),
    frame(180, 26500),
  ], { landing });
  assert.equal(stepped.length, 2);
  assert.ok(stepped.every((snap) => snap.kind === 'landing_step'));
  assert.equal(stepped[0].px, 16000);
  assert.equal(stepped[0].scrollTopFrom, 6000);
  assert.equal(stepped[0].scrollTopTo, 22000);
  assert.equal(landingFrameCount([frame(116, 0), frame(132, 6000), frame(148, 22000), frame(164, 26500), frame(180, 26500)], landing), 4);
  const reader = classifySnaps([frame(116, 0), frame(132, 6000), frame(148, 22000, { readerInput: true })], { landing });
  assert.deepEqual(reader, []);
});

test('classifier landing rule: a pinned bottom may keep moving scrollTop, an off-bottom move or a shifted anchor is a step', () => {
  const landing = { sessionId: 'b', openT: 100 };
  const frame = (t, scrollTop, extra = {}) => sample({
    t, scrollTop, sessionId: 'b', rowCount: 12, bottomDistance: 0, anchorPrevTop: null, anchorTop: null, anchorId: null, ...extra,
  });
  const pinned = classifySnaps([
    frame(116, 0),
    frame(132, 29000),
    frame(148, 29400),
    frame(164, 31000, { bottomDistance: LANDING_BOTTOM_PX }),
    frame(180, 31000),
  ], { landing });
  assert.deepEqual(pinned, [], 'moves that end at the bottom are the hold re-pinning, not steps');

  const offBottom = classifySnaps([
    frame(116, 0),
    frame(132, 29000),
    frame(148, 29400, { bottomDistance: LANDING_BOTTOM_PX + 1 }),
  ], { landing });
  assert.equal(offBottom.length, 1);
  assert.equal(offBottom[0].kind, 'landing_step');
  assert.equal(offBottom[0].px, 400);

  const anchored = (prevTop, top) => classifySnaps([
    frame(116, 0),
    frame(132, 29000),
    frame(148, 29000, { anchorId: 'row-1', anchorPrevTop: prevTop, anchorTop: top }),
  ], { landing }).filter((snap) => snap.kind === 'landing_step');
  assert.equal(anchored(300, 296).length, 1, 'an anchor that moved up by the threshold is a step');
  assert.equal(anchored(300, 304).length, 1, 'an anchor that moved down by the threshold is a step');
  assert.equal(anchored(300, 303).length, 0, 'under the threshold is not');
  assert.equal(anchored(300, 296)[0].px, 4);

  const firstMoveIsExempt = classifySnaps([
    frame(116, 0),
    frame(132, 29000, { bottomDistance: 900, anchorId: 'row-1', anchorPrevTop: 300, anchorTop: 100 }),
  ], { landing });
  assert.deepEqual(firstMoveIsExempt, [], 'the landing move itself is exempt');
});

test('scroll jumps list single-frame moves of 200 px or more that have no reader input', () => {
  const frame = (t, scrollTop, extra = {}) => sample({ t, scrollTop, ...extra });
  const jumps = findScrollJumps([
    frame(0, 4845), frame(16, 4352, { stepName: 'text_s0_1' }), frame(32, 4917), frame(48, 4920), frame(64, 5300, { readerInput: true }),
  ]);
  assert.equal(jumps.length, 2);
  assert.deepEqual(jumps.map((jump) => jump.px), [-493, 565]);
  assert.equal(jumps[0].lastStepName, 'text_s0_1');
  assert.equal(jumps[0].kind, 'scroll_jump');
});

test('a live turn persists its own plan: prompt, streamed text and tool pair match the stream steps', () => {
  const scenario = buildScenario('proposal_turn_end', { seed: 1 });
  const persisted = scenario.livePersisted;
  assert.equal(persisted.sessionId, scenario.initialSessionId);
  const prompt = scenario.steps.find((step) => step.type === 'send').prompt;
  const users = persisted.data.filter((message) => message.role === 'user');
  assert.equal(users[users.length - 1].content, prompt);
  assert.equal(users.length, countTurns(scenario.seedMessages[scenario.initialSessionId]) + 1);
  const streamed = scenario.steps.filter((step) => step.type === 'emit' && step.payload.type === 'delta' && step.payload.content)
    .map((step) => step.payload.content).join('').trim();
  const assistant = persisted.data.filter((message) => message.role === 'assistant' && !message.kind);
  assert.equal(assistant[assistant.length - 1].content, streamed);
  assert.ok(persisted.data.some((message) => message.kind === 'tool_result'
    && message.tool_result.call_id === 'call-propose'));
  assert.ok(persisted.turn_events.length > scenario.turnEvents[scenario.initialSessionId].length);
  assert.equal(buildScenario('switch_into_long_chat', { seed: 1 }).livePersisted, null);
});
