'use strict';

// The sprite morph's tool-form hold: a tool form shows at once and holds 800 ms so
// a sub-frame tool still registers; urgent forms cut it short, suspend and reset end it.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createRig, activity, settledIn } = require('./helpers/sprite-morph-rig');

test('a tool form shows at once and holds 800 ms, so a 30 ms tool still registers', () => {
  for (const form of ['search', 'make', 'run', 'tool']) {
    const rig = createRig();
    settledIn(rig, 'think');
    rig.morph.setActivity(form);
    assert.equal(activity(rig), form, `${form} skips the think gate`);
    rig.clock.advance(30);
    rig.morph.setActivity('think');
    rig.clock.advance(700);
    assert.equal(activity(rig), form, `${form} holds past its tool`);
    rig.clock.advance(101);
    assert.equal(activity(rig), 'think', 'the deferred change applies when the hold ends');
    rig.close();
  }
});

test('changes during a hold wait it out and the latest wins; a hold that is not interrupted does nothing', () => {
  const rig = createRig();
  settledIn(rig, 'think');
  rig.morph.setActivity('make');
  rig.clock.advance(50);
  rig.morph.setActivity('think');
  rig.morph.setActivity('search');
  rig.morph.setActivity('run');
  rig.clock.advance(749);
  assert.equal(activity(rig), 'make');
  rig.clock.advance(2);
  assert.equal(activity(rig), 'run', 'the latest request wins at the end of the hold');
  rig.clock.advance(700);
  assert.equal(activity(rig), 'run', 'the new tool form starts its own hold');
  rig.morph.setActivity('make');
  rig.morph.setActivity('run');
  rig.clock.advance(200);
  assert.equal(activity(rig), 'run', 'asking for the current form again cancels a deferred change');
  rig.morph.setActivity('write');
  assert.equal(activity(rig), 'write', 'a hold that has ended defers nothing');
  rig.close();
});

test('approve, stop, error, wait, stuck, done and rest cut a hold short', () => {
  for (const name of ['approve', 'stopped', 'error', 'wait', 'stuck', 'done', 'rest']) {
    const rig = createRig();
    settledIn(rig, 'think');
    rig.morph.setActivity('run');
    rig.clock.advance(20);
    rig.morph.setActivity(name);
    assert.equal(activity(rig), name, `${name} is immediate during a hold`);
    rig.clock.advance(900);
    assert.equal(activity(rig), name, `${name} is not undone by the expired hold`);
    rig.close();
  }
});

test('suspend takes a change a hold deferred; reset drops the hold', () => {
  const rig = createRig();
  settledIn(rig, 'think');
  rig.morph.setActivity('make');
  rig.morph.setActivity('write');
  rig.morph.suspend();
  assert.equal(activity(rig), 'write', 'the deferred form is taken statically, not lost');
  rig.morph.resume();
  rig.morph.setActivity('run');
  rig.morph.reset();
  assert.equal(activity(rig), 'rest');
  rig.morph.setActivity('think');
  assert.equal(activity(rig), 'think', 'reset leaves no hold behind');
  rig.close();
});
