'use strict';

// The jump control's copy of the rail sprite: the pipeline keeps it live when the rail cannot
// show the turn, and the mirror keeps it in phase and asleep while the control is hidden.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createHarness } = require('./helpers/thinking-pipeline-harness');
const { createSpritePillMirror } = require('../renderer/chat/renderer-sprite-activity');

const SESSION = 'session-1';

function liveMessages() {
  return [
    { id: 'u1', role: 'user', status: 'complete', content: 'Hello', turn_id: 'turn-1' },
    { id: 'a1', role: 'assistant', status: 'streaming', content: 'Working' },
  ];
}

function startTurn(harness) {
  harness.setLifecycle(SESSION, 'streaming');
  harness.multiStream.streams.set(SESSION, 'stream-1');
}

function finishTurn(harness) {
  harness.setLifecycle(SESSION, '');
  harness.multiStream.streams.delete(SESSION);
  harness.multiStream.finalized.add('stream-1');
  harness.multiStream.settled.add('stream-1');
  harness.messages[1].status = 'complete';
}

function pass(harness) {
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const pillActivity = (harness) => harness.jumpButton.querySelector('.chat-sprite-dot').getAttribute('data-activity');
const railActivity = (harness) => harness.sprite.querySelector('.chat-sprite-dot').getAttribute('data-activity');

function close(harness) {
  harness.pipeline.dispose();
  harness.dom.window.close();
}

async function showingHarness() {
  const harness = createHarness({ messages: liveMessages(), jumpControl: true });
  harness.jumpButton.dataset.visible = 'true';
  await settle();
  startTurn(harness);
  return harness;
}

test('the control takes the same form as the rail in the same pass', async () => {
  const harness = await showingHarness();
  pass(harness);
  assert.equal(railActivity(harness), 'think');
  assert.equal(pillActivity(harness), 'think');
  close(harness);
});

test('with the rail display-hidden the control still shows the turn and plays done', async () => {
  const harness = await showingHarness();
  harness.setLayerDisplay('none');
  pass(harness);
  assert.equal(harness.layer.dataset.suppressionReason, 'responsive_hidden');
  assert.equal(pillActivity(harness), 'think', 'split view, IDE dock and phone widths keep the sprite');
  finishTurn(harness);
  pass(harness);
  assert.equal(pillActivity(harness), 'done');
  close(harness);
});

test('with an unmounted anchor row the control still shows the turn', async () => {
  const harness = await showingHarness();
  pass(harness);
  harness.dom.window.document.getElementById('timeline').replaceChildren();
  pass(harness);
  assert.equal(harness.layer.dataset.suppressionReason, 'missing_target');
  assert.equal(pillActivity(harness), 'think');
  close(harness);
});

test('a control that appears mid-turn over a hidden rail picks the turn up on its next frame', async () => {
  const harness = createHarness({ messages: liveMessages(), jumpControl: true });
  startTurn(harness);
  harness.setLayerDisplay('none');
  pass(harness);
  assert.equal(pillActivity(harness), 'rest', 'nothing is derived for a hidden control');
  harness.jumpButton.dataset.visible = 'true';
  await settle();
  harness.scheduler.flushNext();
  assert.equal(pillActivity(harness), 'think');
  close(harness);
});

test('a turn seen by neither the rail nor the control plays no late done', async () => {
  const harness = createHarness({ messages: liveMessages(), jumpControl: true });
  startTurn(harness);
  harness.setLayerDisplay('none');
  pass(harness);
  finishTurn(harness);
  pass(harness);
  assert.equal(pillActivity(harness), 'rest');
  harness.setLayerDisplay('block');
  pass(harness);
  assert.equal(railActivity(harness), 'rest');
  close(harness);
});

test('the open IDE dock counts as a live chat surface; another view resets the control', async () => {
  const live = require('../renderer/chat/renderer-chat-surface-live-utils');
  globalThis.rendererChatSurfaceLiveUtils = live;
  try {
    const harness = await showingHarness();
    harness.state.ui.activeView = 'ide';
    harness.state.ui.ideChatDockOpen = true;
    harness.state.features.featureFlags.ide_chat_dock = true;
    harness.setLayerDisplay('none');
    pass(harness);
    assert.equal(pillActivity(harness), 'think');
    harness.state.ui.ideChatDockOpen = false;
    pass(harness);
    assert.equal(harness.layer.dataset.suppressionReason, 'inactive_view');
    assert.equal(pillActivity(harness), 'rest');
    close(harness);
  } finally {
    delete globalThis.rendererChatSurfaceLiveUtils;
  }
});

test('a session change resets the control', async () => {
  const harness = await showingHarness();
  pass(harness);
  assert.equal(pillActivity(harness), 'think');
  harness.state.currentSessionId = 'session-2';
  pass(harness);
  assert.equal(pillActivity(harness), 'rest');
  close(harness);
});

test('dispose removes the control\'s dot and stops observing it', async () => {
  const harness = await showingHarness();
  pass(harness);
  harness.pipeline.dispose();
  assert.equal(harness.jumpButton.querySelector('.chat-sprite-dot'), null);
  harness.jumpButton.dataset.visible = 'false';
  await settle();
  harness.dom.window.close();
});

// ---- The mirror on its own: phase and suspension. ----

function loop(name, target, startTime, playState = 'running') {
  return { animationName: name, effect: { target }, startTime, playState, ready: Promise.resolve() };
}

function mirrorRig({ visible = 'true', onShow = undefined } = {}) {
  const { window } = new JSDOM('<!doctype html><body><div id="rail"><div class="chat-sprite-dot"><i class="q"></i></div></div><button id="pill" data-visible="false"></button></body>');
  const doc = window.document;
  const rail = doc.getElementById('rail');
  const button = doc.getElementById('pill');
  const calls = [];
  let release = null;
  const mirror = createSpritePillMirror({
    button,
    railHost: rail,
    MutationObserverRef: window.MutationObserver,
    onShow,
    createMorph(host, options) {
      release = options.onLoopsReleased;
      const dot = doc.createElement('div');
      dot.className = 'chat-sprite-dot';
      dot.innerHTML = '<i class="q"></i>';
      host.insertBefore(dot, host.firstChild);
      return {
        suspend: () => calls.push('suspend'),
        resume: () => calls.push('resume'),
        setActivity: (next) => calls.push(`set:${next}`),
        reset: () => calls.push('reset'),
        dispose: () => calls.push('dispose'),
      };
    },
  });
  button.dataset.visible = visible;
  const railDot = rail.querySelector('.chat-sprite-dot');
  const pillDot = button.querySelector('.chat-sprite-dot');
  return { window, rail, button, mirror, calls, railDot, pillDot, release: () => release() };
}

test('a mirror copies the rail\'s loop start times so the two dots are one animation', async () => {
  const rig = mirrorRig();
  await settle();
  const railLoop = loop('sprite-gaze', rig.railDot.querySelector('.q'), 5000);
  const pillLoop = loop('sprite-gaze', rig.pillDot.querySelector('.q'), 5120);
  rig.railDot.getAnimations = () => [railLoop];
  rig.pillDot.getAnimations = () => [pillLoop];
  rig.release();
  await settle();
  assert.equal(pillLoop.startTime, 5000);
  rig.window.close();
});

test('a paused rail or pill loop keeps its own phase', async () => {
  const rig = mirrorRig();
  await settle();
  const railLoop = loop('sprite-gaze', rig.railDot.querySelector('.q'), null, 'paused');
  const pillLoop = loop('sprite-gaze', rig.pillDot.querySelector('.q'), 5120);
  rig.railDot.getAnimations = () => [railLoop];
  rig.pillDot.getAnimations = () => [pillLoop];
  rig.release();
  await settle();
  assert.equal(pillLoop.startTime, 5120);
  rig.window.close();
});

test('a mirror sleeps while the control is hidden and takes the rail\'s form when it shows', async () => {
  const rig = mirrorRig({ visible: 'false' });
  await settle();
  assert.deepEqual(rig.calls, ['suspend']);
  rig.railDot.setAttribute('data-activity', 'search');
  rig.button.dataset.visible = 'true';
  await settle();
  assert.deepEqual(rig.calls.slice(1), ['resume', 'set:search']);
  rig.mirror.dispose();
  assert.equal(rig.calls.at(-1), 'dispose');
  rig.window.close();
});

test('with a suspended rail a mirror replays nothing and asks the pipeline for the current form', async () => {
  let shows = 0;
  const rig = mirrorRig({ visible: 'false', onShow: () => { shows += 1; } });
  await settle();
  rig.railDot.setAttribute('data-suspended', '');
  rig.mirror.setActivity('done');
  rig.button.dataset.visible = 'true';
  await settle();
  assert.equal(shows, 1);
  assert.deepEqual(rig.calls, ['suspend', 'set:done', 'resume'], 'a done from before the control hid is not drawn again');
  rig.window.close();
});

test('a repeated write of the same visibility does nothing', async () => {
  const rig = mirrorRig({ visible: 'false' });
  await settle();
  rig.button.dataset.visible = 'false';
  await settle();
  assert.deepEqual(rig.calls, ['suspend']);
  rig.window.close();
});

test('a hidden mirror does no phase work', async () => {
  const rig = mirrorRig({ visible: 'false' });
  await settle();
  let reads = 0;
  rig.pillDot.getAnimations = () => { reads += 1; return []; };
  rig.release();
  await settle();
  assert.equal(reads, 0);
  rig.window.close();
});

test('no button means no mirror', () => {
  assert.equal(createSpritePillMirror({ button: null, createMorph: () => ({}) }), null);
});
