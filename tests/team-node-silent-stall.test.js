'use strict';

// Plan gate case "silent stall": the node claims, sends two chunks
// and goes quiet while it stays in contact. `stall_timeout` fails the job at 60 s on an
// injected scheduler clock (no real wait), with the outcome of the drop case: the turn ends
// incomplete, the conversation is excluded from that node for 10 minutes, a new send goes
// to another node, nothing is replayed.
//
// The node's contact while it is quiet is `touchNode`: it stands for the empty chunk the
// agent sends after `heartbeat_ms` (10 s of real time) of silence. That an empty chunk is
// contact and not data, so it never resets the stall timer, is pinned at the scheduler by
// tests/server/team-scheduler-states.test.js, "stall: a streaming job with only empty
// heartbeat chunks for 60 s fails with stall_timeout; each is contact".

const assert = require('node:assert/strict');
const nodeTest = require('node:test');

const { SECOND, assertFailedAndRetriedElsewhere, sweep, twoChunks } = require('./helpers/team-node-gate');

const PROMPT = 'PROMPT_silent_stall_31d8';
const REPLY = 'REPLY_silent_stall_b6f2';

nodeTest('a node that goes quiet after two chunks fails the turn stall_timeout at 60 s and the next send goes elsewhere',
  { timeout: 90_000 }, async (t) => {
    const g = await twoChunks(t, { prompt: PROMPT, reply: REPLY });
    const scheduler = g.h.m.scheduler;
    for (const step of [25 * SECOND, 25 * SECOND, 10 * SECOND - 1]) {
      g.clock.advance(step);
      scheduler.touchNode(g.node);
      sweep(g);
      assert.equal(scheduler.listJobs()[0].state, 'streaming', 'under 60 s of silence the job still runs');
    }
    g.clock.advance(1);
    scheduler.touchNode(g.node);
    sweep(g);
    assert.equal(scheduler.listNodes().find((node) => node.node_id === g.node).online, true, 'the node itself was never lost');
    await assertFailedAndRetriedElsewhere(g, { reason: 'stall_timeout', prompt: PROMPT, reply: REPLY });
  });
