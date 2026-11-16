'use strict';

// Plan gate case "drop mid-stream": the node's process ends after
// two chunks. The lease fails `node_lost` once the host has had no contact for 30 s (an
// injected scheduler clock, no real wait), the turn ends incomplete, the conversation is
// excluded from that node for 10 minutes, a new send goes to another node, and nothing is
// replayed: the scheduler holds one job for the failed turn.

const assert = require('node:assert/strict');
const nodeTest = require('node:test');

const { SECOND, assertFailedAndRetriedElsewhere, sweep, twoChunks } = require('./helpers/team-node-gate');

const PROMPT = 'PROMPT_drop_midstream_5c1e';
const REPLY = 'REPLY_drop_midstream_7a90';

nodeTest('a node whose process ends mid-answer fails the turn node_lost and the next send goes elsewhere',
  { timeout: 90_000 }, async (t) => {
    const g = await twoChunks(t, { prompt: PROMPT, reply: REPLY });
    await g.h.agent.die();
    const scheduler = g.h.m.scheduler;
    g.clock.advance(30 * SECOND - 1);
    sweep(g);
    assert.equal(scheduler.listJobs()[0].state, 'streaming', 'under 30 s without contact the job still runs');
    g.clock.advance(1);
    sweep(g);
    assert.equal(scheduler.listNodes().find((node) => node.node_id === g.node).online, false, 'the node is lost');
    await assertFailedAndRetriedElsewhere(g, { reason: 'node_lost', prompt: PROMPT, reply: REPLY });
  });
