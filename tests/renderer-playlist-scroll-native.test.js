// FROZEN RED-FIRST: Playlist Scroll native contractVersion-3 suite
// (Background Effects v3 packet S7). The legacy rendering/helper coverage
// remains in renderer-playlist-scroll-utils.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const playlistScrollUtils = require('../renderer/shell/renderer-playlist-scroll-utils.js');
const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const {
  makeFixtureDocumentRef,
  makeStyledFixtureHost,
  createEffectMediaQueryList,
  createFakeResizeObserverClass,
  buildFixtureContext,
  withStubbedGlobals,
} = require('./helpers/surface-effect-conformance.js');
const { createRafHarness } = require('./helpers/surface-effect-router-harness.js');

const EFFECT_ID = 'playlist-scroll';
const POINTER_EVENTS = [
  'pointerenter', 'pointermove', 'pointerleave', 'pointerdown', 'pointerup',
  'pointercancel', 'mousemove', 'mousedown', 'mouseup', 'click',
];

function makeEnv({
  reducedMotion = false,
  rendererLaunchSeed = 4242,
  documentOptions = {},
  sceneRole,
} = {}) {
  const documentRef = makeFixtureDocumentRef(documentOptions);
  const reducedMotionQuery = createEffectMediaQueryList(reducedMotion);
  const reportCalls = [];
  const controller = playlistScrollUtils.createPlaylistScrollController({
    effectId: EFFECT_ID,
    documentRef,
    reducedMotionQuery,
    runtime,
    rendererLaunchSeed,
    sceneRole,
    report: (fault) => reportCalls.push(fault),
  });
  return { controller, documentRef, reducedMotionQuery, reportCalls };
}

function withPlaylist(envOptions, fn) {
  const raf = createRafHarness();
  const ResizeObserverRef = createFakeResizeObserverClass();
  withStubbedGlobals({ raf, ResizeObserverRef }, () => {
    fn(Object.assign({ raf, ResizeObserverRef }, makeEnv(envOptions)));
  });
}

function makeHostSpec(role = 'chat-left', overrides = {}) {
  const styleTokens = Object.assign({
    '--playlist-scroll-lane-height': '28',
    '--playlist-scroll-subdivisions': '4',
    '--playlist-scroll-bar-width': '120',
    '--playlist-scroll-speed': '0.4',
  }, overrides.styleTokens || {});
  return {
    role,
    element: makeStyledFixtureHost(
      overrides.rect || { left: 0, top: 0, width: 300, height: 280 },
      styleTokens,
    ),
  };
}

function bindHosts(controller, specs, contextOverrides = {}) {
  const hosts = specs.map((spec) => makeHostSpec(spec.role, spec));
  const rects = hosts.map(({ element }) => element.getBoundingClientRect());
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  controller.bind(buildFixtureContext(Object.assign({
    hosts,
    sceneRect: { left, top, width: right - left, height: bottom - top },
    hostRects: rects,
  }, contextOverrides)));
  return hosts;
}

function bindAndPrime(controller, raf, specs = [{ role: 'chat-left' }], contextOverrides) {
  const hosts = bindHosts(controller, specs, contextOverrides);
  raf.flush(16);
  return hosts;
}

function input(type, overrides = {}) {
  return Object.assign({
    type,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    buttons: type === 'press' ? 1 : 0,
    pressure: 0.5,
    timeStamp: 16,
    surfaceRole: 'chat-left',
    localX: 47,
    localY: 55,
    sceneX: 47,
    sceneY: 55,
    generation: 1,
  }, overrides);
}

function inspect(controller) {
  assert.equal(typeof (controller._internals && controller._internals.inspect), 'function');
  return controller._internals.inspect();
}

function entryFor(controller, role = 'chat-left') {
  const entry = inspect(controller).entries.find((candidate) => candidate.role === role);
  assert.ok(entry, 'inspection snapshot contains ' + role);
  return entry;
}

function setStreaming(controller, overrides = {}) {
  controller.setActivity(Object.assign({
    scopeEpoch: 1,
    phase: 'streaming',
    phaseRevision: 1,
    targetEnergy: 0.46,
    attentionScale: 1,
  }, overrides));
}

test('factory exposes native manager API and reconciles immutable contexts with staged reveal', () => {
  withPlaylist({}, ({ controller, raf }) => {
    ['bind', 'refresh', 'dispose', 'handleInput', 'setActivity', 'handleActivityImpulse', 'getStatus']
      .forEach((method) => assert.equal(typeof controller[method], 'function', method + ' is present'));
    const [host] = bindHosts(controller, [{ role: 'chat-left' }], { generation: 7, staged: true });
    assert.deepEqual(controller.getStatus(), {
      state: 'ready', hostCount: 1, drawableHostCount: 1, reason: '',
    });
    raf.flush(16);
    assert.equal(entryFor(controller).readyShown, false, 'staged canvas stays hidden');
    controller.refresh(buildFixtureContext({
      generation: 7,
      staged: false,
      hosts: [{ element: host.element, role: host.role }],
    }));
    assert.equal(entryFor(controller).readyShown, false, 'reveal is deferred one frame');
    raf.flush(16);
    assert.equal(entryFor(controller).readyShown, true);
    assert.equal(inspect(controller).generation, 7);
    controller.refresh(buildFixtureContext({ generation: 8, hosts: [] }));
    assert.equal(host.element.children.length, 0, 'stale canvas is removed on context reconcile');
    controller.dispose();
  });
});

test('hover preview snaps to subdivision and lane without committing; leave clears it without layout reads', () => {
  withPlaylist({}, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf);
    let rectReads = 0;
    const originalRect = host.element.getBoundingClientRect;
    host.element.getBoundingClientRect = () => { rectReads += 1; return originalRect(); };
    controller.handleInput(input('move'));
    let entry = entryFor(controller);
    assert.deepEqual(entry.preview, { screenX: 30, lane: 1, width: 30 });
    assert.equal(entry.noteCount, 0, 'preview does not mutate committed notes');
    assert.equal(rectReads, 0, 'manager-local coordinates are consumed without host remeasurement');
    controller.handleInput(input('leave'));
    entry = entryFor(controller);
    assert.equal(entry.preview, null);
    const before = inspect(controller);
    controller.handleInput(input('move', { surfaceRole: 'chat-right' }));
    assert.deepEqual(inspect(controller), before, 'unknown role is inert');
    controller.dispose();
  });
});

test('an ordinary click commits exactly one snapped note and one bounded ripple', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    controller.handleInput(input('click'));
    const entry = entryFor(controller);
    assert.equal(entry.noteCount, 1);
    assert.equal(entry.rippleCount, 1);
    assert.deepEqual(entry.noteSample[0].position, { screenX: 30, lane: 1, width: 30 });
    controller.dispose();
  });
});

test('shared-scene regions block spawns, project paint occlusion, and never pause scene time', () => {
  withPlaylist({}, ({ controller, raf }) => {
    const hosts = bindAndPrime(controller, raf, [
      { role: 'chat-left', rect: { left: 0, top: 0, width: 300, height: 280 } },
      { role: 'chat-right', rect: { left: 300, top: 0, width: 300, height: 280 } },
    ], {
      spawnAvoidanceRects: [{ left: 0, top: 0, width: 100, height: 280 }],
      paintOcclusionRects: [
        { left: 0, top: 0, width: 300, height: 280 },
        { left: 320, top: 20, width: 40, height: 60 },
      ],
    });
    controller.handleInput(input('click', { sceneX: 47, sceneY: 55 }));
    assert.equal(inspect(controller).scene.noteCount, 0, 'avoidance region rejects the note and ripple spawn');
    controller.handleInput(input('click', { sceneX: 147, sceneY: 55 }));
    assert.equal(inspect(controller).scene.noteCount, 1);
    assert.equal(entryFor(controller, 'chat-left').paintOcclusionCount, 1);
    assert.equal(entryFor(controller, 'chat-right').paintOcclusionCount, 1);
    hosts.forEach(({ element }) => {
      element.getBoundingClientRect = () => { throw new Error('frame loop must use the layout snapshot'); };
    });
    const before = inspect(controller).scene.totalScroll;
    raf.flush(16);
    raf.flush(16);
    assert.ok(inspect(controller).scene.totalScroll > before,
      'simulation advances even when the left viewport is fully paint-occluded');
    controller.dispose();
  });
});

test('press/move paints with a snapped spacing gate and suppresses the trailing click', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    controller.handleInput(input('press', { localX: 20, sceneX: 20 }));
    assert.equal(entryFor(controller).noteCount, 1, 'press paints the first note');
    assert.equal(entryFor(controller).painting, true);
    controller.handleInput(input('move', { buttons: 1, localX: 28, sceneX: 28, timeStamp: 20 }));
    assert.equal(entryFor(controller).noteCount, 1, 'movement inside the same snapped cell is gated');
    controller.handleInput(input('move', {
      pointerId: 2, buttons: 1, localX: 180, sceneX: 180, timeStamp: 22,
    }));
    assert.equal(entryFor(controller).noteCount, 1, 'a second pointer cannot paint the active pointer drag');
    controller.handleInput(input('release', { pointerId: 2, timeStamp: 23 }));
    assert.equal(entryFor(controller).painting, true, 'a second pointer cannot release the active pointer drag');
    controller.handleInput(input('move', { buttons: 1, localX: 78, sceneX: 78, timeStamp: 24 }));
    assert.equal(entryFor(controller).noteCount, 2, 'crossing the spacing gate paints once');
    controller.handleInput(input('release', { localX: 78, sceneX: 78, timeStamp: 28 }));
    assert.equal(entryFor(controller).painting, false);
    controller.handleInput(input('click', { localX: 78, sceneX: 78, timeStamp: 30 }));
    assert.equal(entryFor(controller).noteCount, 2, 'router trailing click does not double-commit');
    controller.dispose();
  });
});

test('captured drag stays owned by its origin across gutter rerouting and click suppression is pointer/time bounded', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [
      { role: 'chat-left', rect: { left: 0, top: 0, width: 300, height: 280 } },
      { role: 'chat-right', rect: { left: 300, top: 0, width: 300, height: 280 } },
    ]);
    controller.handleInput(input('press', {
      pointerId: 7, surfaceRole: 'chat-right', localX: 220, sceneX: 520, timeStamp: 10,
    }));
    controller.handleInput(input('move', {
      pointerId: 7, surfaceRole: 'chat-left', buttons: 1,
      localX: 50, sceneX: 50, localY: 83, sceneY: 83, timeStamp: 20,
    }));
    assert.equal(entryFor(controller, 'chat-right').noteCount, 2, 'rerouted move paints the shared scene');
    assert.equal(entryFor(controller, 'chat-left').noteCount, 2, 'both gutters inspect the same scene note pool');
    controller.handleInput(input('release', {
      pointerId: 7, surfaceRole: 'chat-left', localX: 50, sceneX: 50, timeStamp: 22,
    }));
    assert.equal(entryFor(controller, 'chat-right').painting, false, 'rerouted release terminates origin drag');
    controller.handleInput(input('click', {
      pointerId: 7, surfaceRole: 'chat-left', localX: 50, sceneX: 50, timeStamp: 23,
    }));
    assert.equal(entryFor(controller, 'chat-left').noteCount, 2, 'same-pointer trailing click is suppressed across roles');
    controller.handleInput(input('click', {
      pointerId: 7, surfaceRole: 'chat-left', localX: 50, sceneX: 50, timeStamp: 500,
    }));
    assert.equal(entryFor(controller, 'chat-left').noteCount, 3, 'expired guard cannot poison a later ordinary click');
    controller.dispose();
  });
});

test('cancel and release always clear drag state; cancel also clears preview', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    controller.handleInput(input('press'));
    controller.handleInput(input('cancel'));
    let entry = entryFor(controller);
    assert.equal(entry.painting, false);
    assert.equal(entry.preview, null);
    const count = entry.noteCount;
    controller.handleInput(input('move', { buttons: 1, localX: 150, sceneX: 150 }));
    assert.equal(entryFor(controller).noteCount, count, 'post-cancel movement cannot keep painting');
    controller.handleInput(input('click', { timeStamp: 17 }));
    assert.equal(entryFor(controller).noteCount, count + 1, 'cancel does not suppress the next ordinary click');
    controller.handleInput(input('press', { localX: 180, sceneX: 180, timeStamp: 30 }));
    controller.handleInput(input('leave', { localX: 180, sceneX: 180, timeStamp: 31 }));
    assert.equal(entryFor(controller).painting, false, 'leave terminates an active drag');
    const afterLeave = entryFor(controller).noteCount;
    controller.handleInput(input('click', { localX: 180, sceneX: 180, timeStamp: 32 }));
    assert.equal(entryFor(controller).noteCount, afterLeave + 1, 'leave does not poison the next ordinary click');
    controller.dispose();
  });
});

test('synthetic chat-left cancel clears right-gutter transients and its active drag', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [
      { role: 'chat-left', rect: { left: 0, top: 0, width: 300, height: 280 } },
      { role: 'chat-right', rect: { left: 300, top: 0, width: 300, height: 280 } },
    ]);
    controller.handleInput(input('move', { surfaceRole: 'chat-right' }));
    controller.handleInput(input('click', { surfaceRole: 'chat-right' }));
    assert.equal(entryFor(controller, 'chat-right').previewCount, 1);
    assert.equal(entryFor(controller, 'chat-right').rippleCount, 1);
    controller.handleInput(input('cancel', {
      pointerId: 1, surfaceRole: 'chat-left', localX: 0, localY: 0, sceneX: 0, sceneY: 0, reason: 'blur',
    }));
    assert.equal(entryFor(controller, 'chat-right').previewCount, 0);
    assert.equal(entryFor(controller, 'chat-right').rippleCount, 0);
    controller.handleInput(input('press', {
      pointerId: 9, surfaceRole: 'chat-right', localX: 220, sceneX: 520, timeStamp: 20,
    }));
    assert.equal(entryFor(controller, 'chat-right').painting, true);
    controller.handleInput(input('cancel', {
      pointerId: 9, surfaceRole: 'chat-left', localX: 0, localY: 0,
      sceneX: 0, sceneY: 0, timeStamp: 21, reason: 'blur',
    }));
    const afterCancel = entryFor(controller, 'chat-right');
    assert.equal(afterCancel.painting, false, 'synthetic role still terminates the origin-owned drag');
    assert.equal(afterCancel.previewCount, 0);
    const count = afterCancel.noteCount;
    controller.handleInput(input('click', {
      pointerId: 9, surfaceRole: 'chat-right', localX: 220, sceneX: 520, timeStamp: 22,
    }));
    assert.equal(entryFor(controller, 'chat-right').noteCount, count + 1, 'cancel leaves no click poison');
    controller.dispose();
  });
});

test('note variation is deterministic per launch seed and scene role', () => {
  function capture(rendererLaunchSeed, role) {
    let result;
    withPlaylist({ rendererLaunchSeed }, ({ controller, raf }) => {
      bindAndPrime(controller, raf, [{ role }]);
      controller.handleInput(input('click', { surfaceRole: role }));
      const entry = entryFor(controller, role);
      result = { seed: entry.seed, variation: entry.noteSample[0].variation };
      controller.dispose();
    });
    return result;
  }
  const first = capture(777, 'chat-left');
  assert.deepEqual(capture(777, 'chat-left'), first);
  assert.equal(capture(777, 'chat-right').seed, first.seed, 'chat gutters share a scene seed');
  assert.notEqual(capture(778, 'chat-left').seed, first.seed);
  assert.notEqual(capture(777, 'home').seed, first.seed);
});

test('fixed playhead stays near 35% and note crossings create at most six short flares', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{
      role: 'chat-left',
      styleTokens: { '--playlist-scroll-speed': '4' },
    }]);
    let entry = entryFor(controller);
    assert.ok(Math.abs(entry.playheadX - 105) <= 1, '300px host playhead is fixed near x=35%');
    controller.handleInput(input('click', { localX: 135, sceneX: 135 }));
    for (let i = 0; i < 12; i += 1) { raf.flush(16); }
    entry = entryFor(controller);
    assert.ok(entry.crossingFlareCount >= 1, 'the painted note crossing the playhead creates a flare');
    assert.ok(entry.crossingFlareCount <= 6, 'crossing flares remain bounded');
    controller.dispose();
  });
});

test('streaming activity brightens accents and playhead without changing note or scroll scales', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    const idle = inspect(controller);
    setStreaming(controller);
    for (let i = 0; i < 4; i += 1) { raf.flush(50); }
    const streaming = inspect(controller);
    assert.equal(streaming.phase, 'streaming');
    assert.ok(streaming.accentBoost > idle.accentBoost);
    assert.ok(streaming.playheadBoost > idle.playheadBoost);
    assert.equal(streaming.noteActivityScale, 1, 'activity never brightens committed notes');
    assert.equal(streaming.scrollSpeedScale, 1, 'activity never speeds the ambient scroll');
    controller.dispose();
  });
});

test('streaming auto-composes soft notes and the settling envelope terminates without a complete impulse', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    setStreaming(controller);
    for (let i = 0; i < 80; i += 1) { raf.flush(50); }
    let snapshot = inspect(controller);
    assert.ok(snapshot.scene.autoNoteCount >= 1, 'streaming composes at least one note over 4s');
    assert.equal(snapshot.scene.userNoteCount, 0, 'composition never fabricates user notes');
    assert.equal(snapshot.composeEnvelope, 1);
    controller.setActivity({
      scopeEpoch: 1, phase: 'settling', phaseRevision: 2, targetEnergy: 0.18, attentionScale: 1,
    });
    for (let i = 0; i < 40; i += 1) { raf.flush(50); }
    snapshot = inspect(controller);
    assert.equal(snapshot.composeEnvelope, 0,
      'settling terminates composition by phase alone (a complete impulse may be arbiter-suppressed)');
    const settled = snapshot.scene.autoNoteCount;
    for (let i = 0; i < 20; i += 1) { raf.flush(50); }
    assert.ok(inspect(controller).scene.autoNoteCount <= settled, 'no new auto notes after the envelope closes');
    controller.dispose();
  });
});

test('activity impulses choreograph a flare cascade, a tool accent, and a resolving chord', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    setStreaming(controller);
    controller.handleActivityImpulse({ scopeEpoch: 1, sequence: 1, kind: 'first-token', timeStamp: 100 });
    let snapshot = inspect(controller);
    assert.ok(snapshot.scene.crossingFlareCount >= 1, 'first-token spawns a flare cascade');
    assert.ok(snapshot.scene.crossingFlareCount <= 6, 'the cascade respects the shared flare bound');
    controller.handleActivityImpulse({ scopeEpoch: 1, sequence: 2, kind: 'tool-start', timeStamp: 200 });
    snapshot = inspect(controller);
    assert.equal(snapshot.scene.lifecycleNoteCount, 1, 'tool-start commits one accent note');
    assert.ok(entryFor(controller).noteSample[0].variation.velocity >= 0.85, 'the accent is full-velocity');
    controller.handleActivityImpulse({ scopeEpoch: 1, sequence: 2, kind: 'tool-start', timeStamp: 210 });
    assert.equal(inspect(controller).scene.lifecycleNoteCount, 1, 'a replayed sequence is deduped');
    controller.handleActivityImpulse({ scopeEpoch: 1, kind: 'tool-start', timeStamp: 220 });
    assert.equal(inspect(controller).scene.lifecycleNoteCount, 1,
      'a non-finite sequence is rejected for non-cancel kinds');
    controller.handleActivityImpulse({
      scopeEpoch: 1, sequence: Number.MAX_VALUE, kind: 'tool-start', timeStamp: 230,
    });
    controller.handleActivityImpulse({ scopeEpoch: 1, sequence: 3, kind: 'tool-start', timeStamp: 240 });
    assert.equal(inspect(controller).scene.lifecycleNoteCount, 2,
      'a rejected malformed sequence never poisons the dedup watermark');
    controller.handleActivityImpulse({ scopeEpoch: 1, sequence: 4, kind: 'complete', timeStamp: 300 });
    snapshot = inspect(controller);
    assert.equal(snapshot.scene.lifecycleNoteCount, 5, 'complete lands a three-voice chord');
    assert.equal(snapshot.composeEnvelope, 0, 'the chord closes any residual composition envelope');
    controller.dispose();
  });
});

test('reduced motion suppresses composition and choreography while user commits still work', () => {
  withPlaylist({ reducedMotion: true }, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    setStreaming(controller);
    controller.handleActivityImpulse({ scopeEpoch: 1, sequence: 1, kind: 'first-token', timeStamp: 50 });
    controller.handleActivityImpulse({ scopeEpoch: 1, sequence: 2, kind: 'complete', timeStamp: 60 });
    const snapshot = inspect(controller);
    assert.equal(snapshot.scene.crossingFlareCount, 0);
    assert.equal(snapshot.scene.lifecycleNoteCount, 0);
    assert.equal(snapshot.scene.autoNoteCount, 0);
    controller.handleInput(input('click'));
    assert.equal(inspect(controller).scene.userNoteCount, 1, 'user commits still work statically');
    controller.dispose();
  });
});

test('an active drag pauses the auto-composer and release resumes it', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    setStreaming(controller);
    controller.handleInput(input('press', { localX: 230, sceneX: 230 }));
    for (let i = 0; i < 80; i += 1) { raf.flush(50); }
    let snapshot = inspect(controller);
    assert.equal(snapshot.scene.autoNoteCount, 0, 'painting pauses the composer');
    assert.equal(snapshot.scene.userNoteCount, 1);
    controller.handleInput(input('release', { timeStamp: 5000 }));
    for (let i = 0; i < 80; i += 1) { raf.flush(50); }
    assert.ok(inspect(controller).scene.autoNoteCount >= 1, 'release resumes the composer');
    controller.dispose();
  });
});

test('a dormant complete still closes the envelope and a long gap resets accrued credit', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    setStreaming(controller);
    for (let i = 0; i < 10; i += 1) { raf.flush(50); }
    assert.equal(inspect(controller).composeEnvelope, 1);
    raf.flush(1000);
    assert.equal(inspect(controller).scene.autoCredit, 0, 'a long gap discards accrued credit');
    controller.refresh(buildFixtureContext({ hosts: [] }));
    assert.equal(controller.getStatus().state, 'dormant');
    controller.handleActivityImpulse({ scopeEpoch: 1, sequence: 9, kind: 'complete', timeStamp: 5000 });
    assert.equal(inspect(controller).composeEnvelope, 0,
      'envelope closure does not depend on choreography being renderable');
    controller.dispose();
  });
});

test('cancel impulses and scope-epoch changes fully reset composer state', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    setStreaming(controller);
    for (let i = 0; i < 10; i += 1) { raf.flush(50); }
    assert.equal(inspect(controller).composeEnvelope, 1);
    controller.handleActivityImpulse({ scopeEpoch: 1, sequence: 1, kind: 'cancel' });
    let snapshot = inspect(controller);
    assert.equal(snapshot.composeEnvelope, 0);
    assert.equal(snapshot.scene.autoCredit, 0);
    for (let i = 0; i < 10; i += 1) { raf.flush(50); }
    setStreaming(controller, { scopeEpoch: 2 });
    snapshot = inspect(controller);
    assert.equal(snapshot.composeEnvelope, 0, 'an epoch change clears the envelope until the next frame');
    assert.equal(snapshot.scene.autoCredit, 0, 'an epoch change clears accrued credit');
    controller.dispose();
  });
});

test('current-epoch cancel clears transient interaction state while stale impulses are ignored', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    setStreaming(controller, { scopeEpoch: 8 });
    controller.handleInput(input('press'));
    const before = entryFor(controller);
    controller.handleActivityImpulse({ scopeEpoch: 7, sequence: 1, kind: 'cancel' });
    assert.deepEqual(entryFor(controller), before, 'stale epoch cannot cancel current interaction');
    controller.handleActivityImpulse({ scopeEpoch: 8, sequence: 2, kind: 'cancel' });
    const after = entryFor(controller);
    assert.equal(after.painting, false);
    assert.equal(after.preview, null);
    assert.equal(after.rippleCount, 0);
    controller.dispose();
  });
});

test('committed notes cap at 96 and ripples/flares share a six-entry bound', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    for (let i = 0; i < 120; i += 1) {
      controller.handleInput(input('click', {
        localX: (i % 10) * 30 + 1,
        localY: (i % 8) * 28 + 1,
        timeStamp: 20 + i,
      }));
    }
    const entry = entryFor(controller);
    assert.equal(entry.noteCount, 96);
    assert.ok(entry.rippleCount <= 6);
    assert.ok(entry.crossingFlareCount <= 6);
    controller.dispose();
  });
});

test('reduced motion keeps static preview/commit but suppresses loop and ripples', () => {
  withPlaylist({ reducedMotion: true }, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    assert.equal(raf.size, 0);
    controller.handleInput(input('move'));
    assert.deepEqual(entryFor(controller).preview, { screenX: 30, lane: 1, width: 30 });
    controller.handleInput(input('click'));
    const entry = entryFor(controller);
    assert.equal(entry.noteCount, 1);
    assert.equal(entry.rippleCount, 0);
    assert.equal(raf.size, 0);
    controller.dispose();
  });
});

test('visibility pause and long-gap resume do not jump the scroll clock', () => {
  withPlaylist({}, ({ controller, raf, documentRef }) => {
    bindAndPrime(controller, raf);
    raf.flush(16);
    const beforeGap = entryFor(controller).totalScroll;
    raf.flush(1000);
    assert.equal(entryFor(controller).totalScroll, beforeGap, 'a visible long gap resets instead of advancing');
    const beforeHide = entryFor(controller).totalScroll;
    documentRef.hidden = true;
    documentRef.fire('visibilitychange');
    assert.equal(raf.size, 0);
    documentRef.hidden = false;
    documentRef.fire('visibilitychange');
    raf.flush(1000);
    assert.equal(entryFor(controller).totalScroll, beforeHide, 'resume frame is a clock reset, not a jump');
    controller.dispose();
  });
});

test('null canvas contexts and detached hosts degrade to dormant without throwing', () => {
  withPlaylist({ documentOptions: { nullContext: true } }, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf);
    assert.equal(host.element.children.length, 0);
    assert.deepEqual(controller.getStatus(), {
      state: 'dormant', hostCount: 1, drawableHostCount: 0, reason: 'no drawable host',
    });
    controller.dispose();
  });
  withPlaylist({}, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf);
    host.element.isConnected = false;
    assert.doesNotThrow(() => raf.flush(16));
    assert.deepEqual(controller.getStatus(), {
      state: 'dormant', hostCount: 1, drawableHostCount: 0, reason: 'no drawable host',
    });
    controller.dispose();
  });
});

test('frame faults are contained and reported through the shared fault contract', () => {
  withPlaylist({ documentOptions: { throwOnDraw: true } }, ({ controller, raf, reportCalls }) => {
    bindHosts(controller, [{ role: 'chat-left' }]);
    assert.doesNotThrow(() => raf.flush(16));
    assert.ok(reportCalls.length >= 1);
    reportCalls.forEach((fault) => {
      assert.equal(fault.effectId, EFFECT_ID);
      assert.equal(fault.stage, 'frame');
      assert.equal(fault.recoverable, true);
    });
    controller.dispose();
  });
});

test('manager owns pointer and geometry observation and dispose fully tears down with terminal inertness', () => {
  withPlaylist({}, ({
    controller, raf, documentRef, reducedMotionQuery, ResizeObserverRef,
  }) => {
    const hosts = bindAndPrime(controller, raf, [{ role: 'chat-left' }, { role: 'chat-right' }]);
    hosts.forEach(({ element }) => POINTER_EVENTS.forEach((eventName) => {
      assert.equal(element.listenerCount(eventName), 0, 'effect owns no ' + eventName + ' listener');
    }));
    assert.equal(documentRef.listenerCount('visibilitychange'), 1);
    assert.equal(reducedMotionQuery.listenerCount(), 1);
    assert.equal(ResizeObserverRef.getActiveCount(), 0,
      'the effect does not create a competing geometry observer');
    controller.handleInput(input('press'));
    controller.dispose();
    assert.equal(raf.size, 0);
    assert.equal(documentRef.listenerCount('visibilitychange'), 0);
    assert.equal(reducedMotionQuery.listenerCount(), 0);
    assert.equal(ResizeObserverRef.getActiveCount(), 0);
    hosts.forEach(({ element }) => assert.equal(element.children.length, 0));
    assert.doesNotThrow(() => controller.dispose());
    const before = inspect(controller);
    controller.handleInput(input('move'));
    setStreaming(controller, { scopeEpoch: 2 });
    controller.handleActivityImpulse({ scopeEpoch: 2, sequence: 1, kind: 'complete' });
    controller.refresh(buildFixtureContext({ hosts: [] }));
    assert.deepEqual(inspect(controller), before, 'every public mutation is inert after dispose');
    assert.equal(before.disposed, true);
  });
});
