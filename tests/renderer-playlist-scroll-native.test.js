// Playlist Scroll native contractVersion-3 suite (Background Effects v3 packet S7).
// The legacy rendering/helper coverage remains in renderer-playlist-scroll-utils.test.js.
//
// 2026-09-30 owner direction change: the activity channel is gone (the effect never
// reacts to the model), the auto-composer, lifecycle flares, band and per-note
// gradient/glow were removed, notes are flat accent fills that fade out, the
// playhead only shows while hovered, and the loop follows a frame budget
// (~30 fps idle/unfocused, full rate while the pointer or a ring is answering).

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
const ACCENT = 'rgba(10, 200, 30, 0.5)';
const ACCENT_SOLID = 'rgba(10,200,30,1)';
const NOTE_FILL = 'rgba(10,200,30,' + (0.5 * 1.2) + ')';
const GHOST_TOKEN = 'rgba(11, 22, 33, 0.3)';

function makeFakeWindow(devicePixelRatio = 1) {
  const listeners = new Map();
  return {
    devicePixelRatio,
    addEventListener(name, listener) {
      if (!listeners.has(name)) { listeners.set(name, new Set()); }
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) {
      if (listeners.has(name)) { listeners.get(name).delete(listener); }
    },
    listenerCount(name) { return listeners.has(name) ? listeners.get(name).size : 0; },
    fire(name) { Array.from(listeners.get(name) || []).forEach((listener) => listener({ type: name })); },
  };
}

// A recording 2d context: one frame per full-host clearRect, with every primitive
// logged together with the style in force at the call.
function createRecordingContext() {
  const frames = [];
  let frame = null;
  const state = { fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1, globalCompositeOperation: 'source-over' };
  let shadowBlurWrites = 0;
  const ctx = {
    frames,
    get shadowBlurWrites() { return shadowBlurWrites; },
    save() {}, restore() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    clearRect(x, y, w, h) {
      if (x === 0 && y === 0 && w === 300 && h === 280) {
        frame = { rects: [], notes: [], fills: [], arcs: [], images: 0 };
        frames.push(frame);
      }
    },
    fillRect(...args) {
      if (frame) { frame.rects.push({ args, fillStyle: state.fillStyle, globalAlpha: state.globalAlpha }); }
    },
    roundRect(...args) { if (frame) { frame.notes.push({ args }); } },
    fill() {
      if (!frame) { return; }
      const pending = frame.notes.filter((note) => note.fillStyle === undefined);
      pending.forEach((note) => { note.fillStyle = state.fillStyle; note.globalAlpha = state.globalAlpha; });
      frame.fills.push({ fillStyle: state.fillStyle, globalAlpha: state.globalAlpha, shapes: pending.length });
    },
    arc(...args) {
      if (frame) { frame.arcs.push({ args, globalAlpha: state.globalAlpha, strokeStyle: state.strokeStyle }); }
    },
    drawImage() { if (frame) { frame.images += 1; } },
    createLinearGradient() { return { addColorStop() {} }; },
  };
  ['fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'globalCompositeOperation'].forEach((name) => {
    Object.defineProperty(ctx, name, { get: () => state[name], set: (value) => { state[name] = value; } });
  });
  Object.defineProperty(ctx, 'shadowBlur', { get: () => 0, set: () => { shadowBlurWrites += 1; } });
  return ctx;
}

function recordCanvases(documentRef) {
  const contexts = [];
  const createElement = documentRef.createElement;
  documentRef.createElement = (tag) => {
    const element = createElement.call(documentRef, tag);
    if (tag === 'canvas') {
      const ctx = createRecordingContext();
      contexts.push(ctx);
      element.getContext = () => ctx;
    }
    return element;
  };
  return contexts;
}

function makeEnv({
  reducedMotion = false,
  rendererLaunchSeed = 4242,
  documentOptions = {},
  sceneRole,
  windowRef = makeFakeWindow(),
  record = true,
} = {}) {
  const documentRef = makeFixtureDocumentRef(documentOptions);
  const contexts = record ? recordCanvases(documentRef) : [];
  const reducedMotionQuery = createEffectMediaQueryList(reducedMotion);
  const reportCalls = [];
  const controller = playlistScrollUtils.createPlaylistScrollController({
    effectId: EFFECT_ID,
    documentRef,
    windowRef,
    reducedMotionQuery,
    runtime,
    rendererLaunchSeed,
    sceneRole,
    report: (fault) => reportCalls.push(fault),
  });
  return { controller, documentRef, reducedMotionQuery, reportCalls, windowRef, contexts };
}

function withPlaylist(envOptions, fn) {
  const raf = createRafHarness();
  const ResizeObserverRef = createFakeResizeObserverClass();
  // One clock for rAF, event time and the controller's performance.now() static
  // paints: otherwise a note's 12 s life would race real process uptime.
  const realNow = performance.now;
  performance.now = () => raf.now;
  try {
    withStubbedGlobals({ raf, ResizeObserverRef }, () => {
      fn(Object.assign({ raf, ResizeObserverRef }, makeEnv(envOptions)));
    });
  } finally {
    performance.now = realNow;
  }
}

function makeHostSpec(role = 'chat-left', overrides = {}) {
  const styleTokens = Object.assign({
    '--playlist-scroll-lane-height': '28',
    '--playlist-scroll-subdivisions': '4',
    '--playlist-scroll-bar-width': '120',
    '--playlist-scroll-speed': '0.4',
    '--playlist-scroll-accent-color': ACCENT,
    '--playlist-scroll-ghost-color': GHOST_TOKEN,
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

function flushTicks(raf, count, ms = 16) {
  for (let i = 0; i < count; i += 1) { raf.flush(ms); }
}
function paintCount(contexts) { return contexts[0].frames.length; }
function lastFrame(contexts) { return contexts[0].frames.at(-1); }
function ghostRects(frame) {
  return frame.rects.filter((rect) => rect.fillStyle.indexOf('rgba(11,22,33,') === 0).map((rect) => rect.args);
}
function playheadRect(frame) {
  return frame.rects.find((rect) => rect.fillStyle === ACCENT_SOLID && rect.args[2] === 2
    && rect.args[3] === 280 && rect.args[0] === 104);
}
function previewRect(frame) {
  return frame.rects.find((rect) => rect.fillStyle === ACCENT_SOLID && rect.args[3] === 26);
}

test('factory exposes only the background-effect manager API: no activity channel', () => {
  withPlaylist({}, ({ controller, raf }) => {
    assert.deepEqual(Object.keys(controller).sort(), [
      '_internals', 'bind', 'dispose', 'getStatus', 'handleInput', 'refresh',
    ]);
    assert.equal(controller.setActivity, undefined);
    assert.equal(controller.handleActivityImpulse, undefined);
    const snapshot = inspect(controller);
    ['scopeEpoch', 'phase', 'phaseRevision', 'currentEnergy', 'targetEnergy', 'attentionScale', 'accentBoost',
      'playheadBoost', 'composeEnvelope'].forEach((field) => {
      assert.equal(field in snapshot, false, field + ' is gone from the inspection snapshot');
    });
    ['autoNoteSequence', 'autoCredit', 'autoNoteCount', 'lifecycleNoteCount', 'userNoteCount'].forEach((field) => {
      assert.equal(field in snapshot.scene, false, field + ' is gone from the scene snapshot');
    });
    bindAndPrime(controller, raf);
    controller.dispose();
  });
});

test('factory reconciles immutable contexts with staged reveal', () => {
  withPlaylist({}, ({ controller, raf }) => {
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

test('the hover preview re-snaps every paint while the grid scrolls under a parked pointer', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left', styleTokens: { '--playlist-scroll-speed': '4' } }]);
    controller.handleInput(input('move'));
    assert.equal(entryFor(controller).preview.screenX, 30);
    flushTicks(raf, 10);
    const entry = entryFor(controller);
    assert.ok(entry.totalScroll > 30, 'the grid scrolled past a full cell');
    const expected = Math.floor((47 + entry.totalScroll) / 30) * 30 - entry.totalScroll;
    assert.ok(Math.abs(entry.preview.screenX - expected) < 0.01,
      'preview follows the live scroll (got ' + entry.preview.screenX + ', want ' + expected + ')');
    assert.notEqual(entry.preview.screenX, 30, 'the stale first snap is gone');
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

test('a cell holds at most one note: a repeat click or re-drag over it adds nothing', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    controller.handleInput(input('click', { timeStamp: 20 }));
    controller.handleInput(input('click', { timeStamp: 600 }));
    controller.handleInput(input('click', { timeStamp: 1200, sceneX: 59, localX: 59 }));
    assert.equal(entryFor(controller).noteCount, 1, 'the same cell never doubles');
    assert.equal(entryFor(controller).rippleCount, 1, 'no ripple for a refused repeat');
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

test('a spawn-avoidance-only refresh keeps the ghosts identical (no wipe, no re-roll)', () => {
  const tokens = { '--playlist-scroll-speed': '0' };
  [false, true].forEach((reducedMotion) => {
    withPlaylist({ reducedMotion }, ({ controller, raf, contexts }) => {
      const hosts = bindAndPrime(controller, raf, [{ role: 'chat-left', styleTokens: tokens }]);
      if (!reducedMotion) { flushTicks(raf, 4); }
      const before = ghostRects(lastFrame(contexts));
      assert.ok(before.length > 0, 'ghost notes are drawn');
      const ghostCount = entryFor(controller).ghostCount;
      controller.refresh(buildFixtureContext({
        hosts: [{ element: hosts[0].element, role: 'chat-left' }],
        sceneRect: { left: 0, top: 0, width: 300, height: 280 },
        hostRects: [{ left: 0, top: 0, width: 300, height: 280 }],
        spawnAvoidanceRects: [{ left: 0, top: 0, width: 200, height: 280 }],
      }));
      if (!reducedMotion) { flushTicks(raf, 4); }
      assert.equal(entryFor(controller).ghostCount, ghostCount, 'the ghost pool is untouched');
      assert.deepEqual(ghostRects(lastFrame(contexts)), before, 'the same ghosts draw in the same places');
      controller.dispose();
    });
  });
});

test('press/move paints every cell the stroke crosses and suppresses the trailing click', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    controller.handleInput(input('press', { localX: 20, sceneX: 20 }));
    assert.equal(entryFor(controller).noteCount, 1, 'press paints the first note');
    assert.equal(entryFor(controller).painting, true);
    controller.handleInput(input('move', { buttons: 1, localX: 28, sceneX: 28, timeStamp: 20 }));
    assert.equal(entryFor(controller).noteCount, 1, 'movement inside the same cell adds nothing');
    controller.handleInput(input('move', {
      pointerId: 2, buttons: 1, localX: 180, sceneX: 180, timeStamp: 22,
    }));
    assert.equal(entryFor(controller).noteCount, 1, 'a second pointer cannot paint the active pointer drag');
    controller.handleInput(input('release', { pointerId: 2, timeStamp: 23 }));
    assert.equal(entryFor(controller).painting, true, 'a second pointer cannot release the active pointer drag');
    controller.handleInput(input('move', { buttons: 1, localX: 78, sceneX: 78, timeStamp: 24 }));
    assert.equal(entryFor(controller).noteCount, 3, 'a jump of two cells fills the skipped cell too');
    assert.deepEqual(
      inspect(controller).entries[0].noteSample.map((note) => note.position.screenX),
      [0, 30, 60],
      'the stroke is contiguous on the cell grid',
    );
    controller.handleInput(input('release', { localX: 78, sceneX: 78, timeStamp: 28 }));
    assert.equal(entryFor(controller).painting, false);
    controller.handleInput(input('click', { localX: 78, sceneX: 78, timeStamp: 30 }));
    assert.equal(entryFor(controller).noteCount, 3, 'router trailing click does not double-commit');
    controller.dispose();
  });
});

test('a fast diagonal drag interpolates across lanes without skipping cells', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    controller.handleInput(input('press', { localX: 10, sceneX: 10, localY: 10, sceneY: 10 }));
    controller.handleInput(input('move', { buttons: 1, localX: 190, sceneX: 190, localY: 130, sceneY: 130, timeStamp: 20 }));
    const notes = entryFor(controller).noteSample;
    assert.equal(entryFor(controller).noteCount, 7, 'the press cell plus one note per step of the longer axis');
    const lanes = notes.map((note) => note.position.lane);
    assert.deepEqual(lanes, [0, 1, 1, 2, 3, 3], 'lane steps are interpolated on the cell grid');
    for (let i = 1; i < notes.length; i += 1) {
      assert.ok(notes[i].position.screenX - notes[i - 1].position.screenX === 30, 'adjacent columns');
      assert.ok(Math.abs(notes[i].position.lane - notes[i - 1].position.lane) <= 1, 'lanes step by at most one');
    }
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
    const painted = entryFor(controller, 'chat-right').noteCount;
    assert.equal(painted, 17, 'the rerouted move paints the whole stroke, cell by cell, into the shared scene');
    assert.equal(entryFor(controller, 'chat-left').noteCount, painted, 'both gutters inspect the same scene note pool');
    controller.handleInput(input('release', {
      pointerId: 7, surfaceRole: 'chat-left', localX: 50, sceneX: 50, timeStamp: 22,
    }));
    assert.equal(entryFor(controller, 'chat-right').painting, false, 'rerouted release terminates origin drag');
    controller.handleInput(input('click', {
      pointerId: 7, surfaceRole: 'chat-left', localX: 50, sceneX: 50, timeStamp: 23,
    }));
    assert.equal(entryFor(controller, 'chat-left').noteCount, painted, 'same-pointer trailing click is suppressed across roles');
    controller.handleInput(input('click', {
      pointerId: 7, surfaceRole: 'chat-left', localX: 50, sceneX: 50, timeStamp: 500,
    }));
    assert.equal(entryFor(controller, 'chat-left').noteCount, painted + 1, 'expired guard cannot poison a later ordinary click');
    controller.dispose();
  });
});

test('cancel clears pointer state only: the drag and hover end, notes and ripples stay', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    controller.handleInput(input('press'));
    assert.equal(entryFor(controller).noteCount, 1);
    assert.equal(entryFor(controller).rippleCount, 1);
    controller.handleInput(input('cancel'));
    let entry = entryFor(controller);
    assert.equal(entry.painting, false);
    assert.equal(entry.preview, null);
    assert.equal(entry.noteCount, 1, 'cancel keeps the painted note');
    assert.equal(entry.rippleCount, 1, 'cancel lets the live ripple finish on its own');
    const count = entry.noteCount;
    controller.handleInput(input('move', { buttons: 1, localX: 150, sceneX: 150 }));
    assert.equal(entryFor(controller).noteCount, count, 'post-cancel movement cannot keep painting');
    controller.handleInput(input('click', { timeStamp: 17, localX: 150, sceneX: 150 }));
    assert.equal(entryFor(controller).noteCount, count + 1, 'cancel does not suppress the next ordinary click');
    controller.handleInput(input('press', { localX: 180, sceneX: 180, timeStamp: 30 }));
    controller.handleInput(input('leave', { localX: 180, sceneX: 180, timeStamp: 31 }));
    assert.equal(entryFor(controller).painting, false, 'leave terminates an active drag');
    const afterLeave = entryFor(controller).noteCount;
    controller.handleInput(input('click', { localX: 240, sceneX: 240, timeStamp: 32 }));
    assert.equal(entryFor(controller).noteCount, afterLeave + 1, 'leave does not poison the next ordinary click');
    controller.dispose();
  });
});

test('a non-primary pointer never drives hover, paint or cancel, and its cancel keeps the primary hover', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    controller.handleInput(input('move'));
    assert.ok(entryFor(controller).preview, 'primary hover is live');
    controller.handleInput(input('cancel', { isPrimary: false, pointerId: 5 }));
    assert.ok(entryFor(controller).preview, 'a second contact\'s cancel leaves the primary hover alone');
    controller.handleInput(input('move', { isPrimary: false, pointerId: 5, sceneX: 200, localX: 200 }));
    assert.equal(entryFor(controller).preview.screenX, 30, 'a second contact cannot move the hover');
    controller.handleInput(input('click', { isPrimary: false, pointerId: 5, sceneX: 200, localX: 200 }));
    controller.handleInput(input('press', { isPrimary: false, pointerId: 5 }));
    assert.equal(entryFor(controller).noteCount, 0);
    assert.equal(entryFor(controller).painting, false);
    controller.handleInput(input('leave', { isPrimary: false, pointerId: 5 }));
    assert.ok(entryFor(controller).preview, 'a second contact\'s leave is ignored too');
    controller.handleInput(input('cancel'));
    assert.equal(entryFor(controller).preview, null, 'the primary cancel clears the hover');
    controller.dispose();
  });
});

test('synthetic chat-left cancel ends the right-gutter hover and its active drag but keeps ripples', () => {
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
    assert.equal(entryFor(controller, 'chat-right').rippleCount, 1, 'the ripple settles on its own');
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
      pointerId: 9, surfaceRole: 'chat-right', localX: 100, sceneX: 400, timeStamp: 22,
    }));
    assert.equal(entryFor(controller, 'chat-right').noteCount, count + 1, 'cancel leaves no click poison');
    controller.dispose();
  });
});

test('ghost variation is deterministic per launch seed and scene role', () => {
  function capture(rendererLaunchSeed, role) {
    let result;
    withPlaylist({ rendererLaunchSeed }, ({ controller, raf, contexts }) => {
      bindAndPrime(controller, raf, [{ role, styleTokens: { '--playlist-scroll-speed': '0' } }]);
      raf.flush(16);
      result = { seed: entryFor(controller, role).seed, ghosts: ghostRects(lastFrame(contexts)) };
      controller.dispose();
    });
    return result;
  }
  const first = capture(777, 'chat-left');
  assert.ok(first.ghosts.length > 0);
  assert.deepEqual(capture(777, 'chat-left'), first);
  assert.equal(capture(777, 'chat-right').seed, first.seed, 'chat gutters share a scene seed');
  assert.notEqual(capture(778, 'chat-left').seed, first.seed);
  assert.notEqual(capture(777, 'home').seed, first.seed);
  assert.notDeepEqual(capture(778, 'chat-left').ghosts, first.ghosts);
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

test('a painted note draws flat in the accent token colour and never writes a shadow', () => {
  withPlaylist({}, ({ controller, raf, contexts }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left', styleTokens: { '--playlist-scroll-speed': '0' } }]);
    controller.handleInput(input('click', { timeStamp: raf.now }));
    flushTicks(raf, 3);
    const frame = lastFrame(contexts);
    const fill = frame.fills.find((candidate) => candidate.shapes > 0);
    assert.ok(fill, 'the note is filled as a path');
    assert.equal(fill.fillStyle, NOTE_FILL, 'fill is the accent colour at min(1, alpha x 1.2)');
    assert.equal(frame.notes.length, 1);
    assert.equal(contexts[0].shadowBlurWrites, 0, 'no shadowBlur glow anywhere');
    controller.dispose();
  });
});

test('notes live 12 s, fade linearly over the final 2 s, and are then removed', () => {
  withPlaylist({}, ({ controller, raf, contexts }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left', styleTokens: { '--playlist-scroll-speed': '0' } }]);
    const placedAt = raf.now;
    controller.handleInput(input('click', { timeStamp: placedAt }));
    const noteAlpha = () => {
      const fill = lastFrame(contexts).fills.find((candidate) => candidate.shapes > 0);
      return fill ? fill.globalAlpha : null;
    };
    flushTicks(raf, 10, 1000);
    assert.equal(raf.now - placedAt, 10000);
    assert.equal(noteAlpha(), 1, 'full strength until the last 2 s');
    flushTicks(raf, 1, 1000);
    assert.ok(Math.abs(noteAlpha() - 0.5) < 1e-9, 'half alpha one second into the fade');
    assert.equal(entryFor(controller).noteCount, 1);
    flushTicks(raf, 1, 1000);
    assert.equal(entryFor(controller).noteCount, 0, 'removed at 12 s');
    assert.equal(noteAlpha(), null);
    controller.dispose();
  });
});

test('the playhead is invisible at idle, rises while hovered, and fades out after leave', () => {
  withPlaylist({}, ({ controller, raf, contexts }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left', styleTokens: { '--playlist-scroll-speed': '0' } }]);
    flushTicks(raf, 4);
    assert.equal(playheadRect(lastFrame(contexts)), undefined, 'alpha 0 at idle: nothing is drawn');
    controller.handleInput(input('move'));
    flushTicks(raf, 2);
    const early = playheadRect(lastFrame(contexts));
    flushTicks(raf, 200);
    const settled = playheadRect(lastFrame(contexts));
    assert.ok(settled, 'the playhead shows while hovered');
    assert.ok(!early || early.globalAlpha < settled.globalAlpha, 'it rises toward its peak');
    assert.ok(Math.abs(settled.globalAlpha - 0.36 * 0.5) < 1e-6, 'peak is 0.36 x line alpha x contrast');
    assert.ok(Math.abs(entryFor(controller).pointerFade - 1) < 1e-6);
    controller.handleInput(input('leave'));
    flushTicks(raf, 120);
    assert.equal(playheadRect(lastFrame(contexts)), undefined, 'gone again after leave');
    controller.dispose();
  });
});

test('reduced motion draws a new note settled, keeps the hover binary, and clears it on leave', () => {
  withPlaylist({ reducedMotion: true }, ({ controller, raf, contexts }) => {
    bindAndPrime(controller, raf);
    assert.equal(raf.size, 0);
    controller.handleInput(input('move'));
    assert.deepEqual(entryFor(controller).preview, { screenX: 30, lane: 1, width: 30 });
    assert.equal(entryFor(controller).pointerFade, 1, 'the highlight is on at once');
    const hover = previewRect(lastFrame(contexts));
    assert.ok(hover, 'the static frame draws the hover cell');
    assert.ok(Math.abs(hover.globalAlpha - 0.3) < 1e-9, 'accent colour at 0.3 x pointer fade');
    assert.ok(playheadRect(lastFrame(contexts)), 'the playhead is on while hovered');
    controller.handleInput(input('click'));
    const entry = entryFor(controller);
    assert.equal(entry.noteCount, 1);
    assert.equal(entry.rippleCount, 0, 'no rings in reduced motion');
    const frame = lastFrame(contexts);
    assert.equal(frame.notes[0].args[2], 30, 'the new note is drawn already settled (no 1.15x pop)');
    assert.equal(frame.fills.find((candidate) => candidate.shapes > 0).globalAlpha, 1);
    controller.handleInput(input('leave'));
    assert.equal(entryFor(controller).preview, null);
    assert.equal(entryFor(controller).pointerFade, 0, 'off immediately, not faded');
    assert.equal(previewRect(lastFrame(contexts)), undefined, 'the hover clears on leave');
    assert.equal(playheadRect(lastFrame(contexts)), undefined);
    controller.handleInput(input('move'));
    controller.handleInput(input('cancel'));
    assert.equal(previewRect(lastFrame(contexts)), undefined, 'and on cancel');
    assert.equal(raf.size, 0);
    controller.dispose();
  });
});

test('switching to reduced motion drops live rings and settles the hover; notes stay', () => {
  withPlaylist({}, ({ controller, raf, reducedMotionQuery }) => {
    bindAndPrime(controller, raf);
    controller.handleInput(input('click'));
    assert.equal(entryFor(controller).rippleCount, 1);
    reducedMotionQuery.simulateChange(true);
    assert.equal(entryFor(controller).rippleCount, 0);
    assert.equal(entryFor(controller).noteCount, 1);
    assert.equal(entryFor(controller).pointerFade, 1, 'a hovered pointer snaps to the binary highlight');
    assert.equal(raf.size, 0, 'the loop stops');
    controller.dispose();
  });
});

test('frame budget: ~30fps at idle, every tick while the pointer is active, capped again when unfocused', () => {
  withPlaylist({}, ({ controller, raf, contexts, windowRef }) => {
    bindAndPrime(controller, raf);
    assert.equal(windowRef.listenerCount('focus'), 1, 'window focus is bound through the runtime');
    assert.equal(windowRef.listenerCount('blur'), 1);
    let before = paintCount(contexts);
    flushTicks(raf, 20);
    const idlePaints = paintCount(contexts) - before;
    assert.ok(idlePaints >= 9 && idlePaints <= 11, 'idle paints roughly every other 16ms tick (got ' + idlePaints + ')');
    assert.equal(raf.size, 1, 'the ambient loop stays alive between budgeted paints');

    controller.handleInput(input('move'));
    before = paintCount(contexts);
    flushTicks(raf, 20);
    assert.equal(paintCount(contexts) - before, 20, 'an active pointer paints every tick');

    windowRef.fire('blur');
    before = paintCount(contexts);
    flushTicks(raf, 20);
    const blurredPaints = paintCount(contexts) - before;
    assert.ok(blurredPaints >= 9 && blurredPaints <= 11, 'an unfocused window caps even with an active pointer (got ' + blurredPaints + ')');

    windowRef.fire('focus');
    before = paintCount(contexts);
    flushTicks(raf, 10);
    assert.equal(paintCount(contexts) - before, 10, 'refocus restores full rate');
    controller.dispose();
    assert.equal(windowRef.listenerCount('focus'), 0, 'dispose removes the focus listener');
    assert.equal(windowRef.listenerCount('blur'), 0, 'dispose removes the blur listener');
  });
});

test('frame budget: a ripple and the fading hover hold full rate, then the loop drops back to idle', () => {
  withPlaylist({}, ({ controller, raf, contexts }) => {
    bindAndPrime(controller, raf);
    controller.handleInput(input('click', { timeStamp: raf.now }));
    controller.handleInput(input('leave', { timeStamp: raf.now }));
    let before = paintCount(contexts);
    flushTicks(raf, 10);
    assert.equal(paintCount(contexts) - before, 10, 'a live ripple paints every tick');
    flushTicks(raf, 160);
    assert.equal(entryFor(controller).rippleCount, 0);
    assert.equal(entryFor(controller).pointerFade, 0);
    before = paintCount(contexts);
    flushTicks(raf, 20);
    assert.ok(paintCount(contexts) - before <= 11, 'the settled scene is back on the idle budget');
    controller.dispose();
  });
});

test('a DPR-only change re-backs the canvas on the next painted frame', () => {
  const windowRef = makeFakeWindow(1);
  withPlaylist({ windowRef }, ({ controller, raf, contexts }) => {
    const [host] = bindAndPrime(controller, raf);
    const canvas = host.element.children[0];
    assert.equal(canvas.width, 300);
    assert.equal(canvas.height, 280);
    windowRef.devicePixelRatio = 1.5;
    assert.equal(canvas.width, 300, 'nothing re-backs synchronously');
    const before = paintCount(contexts);
    flushTicks(raf, 3);
    assert.ok(paintCount(contexts) > before, 'a frame was painted');
    assert.equal(canvas.width, 450, 'the backing follows the new device pixel ratio');
    assert.equal(canvas.height, 420);
    assert.equal(entryFor(controller).dpr, 1.5);
    controller.dispose();
  });
});

test('reduced-motion static paints also re-back the canvas after a DPR-only change', () => {
  const windowRef = makeFakeWindow(1);
  withPlaylist({ windowRef, reducedMotion: true }, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf);
    const canvas = host.element.children[0];
    assert.equal(canvas.width, 300);
    windowRef.devicePixelRatio = 1.5;
    controller.handleInput(input('move'));
    assert.equal(canvas.width, 450, 'the static repaint follows the new device pixel ratio');
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

test('contrast scales the grid, accent and ghost alphas; band and pad tokens are never read', () => {
  withPlaylist({}, ({ controller, raf, contexts }) => {
    const tokens = { '--playlist-scroll-speed': '0', '--playlist-scroll-contrast': '1.5' };
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left', styleTokens: tokens }]);
    const requested = [];
    const originalRead = host.element.style.getPropertyValue;
    host.element.style.getPropertyValue = (name) => { requested.push(name); return originalRead(name); };
    controller.refresh(buildFixtureContext({
      hosts: [{ element: host.element, role: 'chat-left' }],
      sceneRect: { left: 0, top: 0, width: 300, height: 280 },
      hostRects: [{ left: 0, top: 0, width: 300, height: 280 }],
    }));
    flushTicks(raf, 4);
    assert.ok(requested.indexOf('--playlist-scroll-contrast') !== -1, 'the contrast token is read');
    assert.deepEqual(requested.filter((name) => /band|pad-color/.test(name)), [],
      'the retired band and pad tokens are not read');
    const frame = lastFrame(contexts);
    const ghost = frame.rects.find((rect) => rect.fillStyle.indexOf('rgba(11,22,33,') === 0);
    assert.equal(ghost.fillStyle, 'rgba(11,22,33,' + (0.3 * 1.35 * 1.5) + ')',
      'ghost alpha is the ghost colour alpha x 1.35 x contrast');
    const accent = frame.rects.find((rect) => rect.fillStyle === ACCENT_SOLID && rect.args[2] === 2 && rect.args[3] === 280);
    assert.ok(Math.abs(accent.globalAlpha - 0.18 * 1.4 * 1.5) < 1e-9, 'accent line alpha scales with contrast');
    controller.dispose();
  });
});

test('committed notes cap at 96 and ripples/flares share a six-entry bound', () => {
  withPlaylist({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    for (let i = 0; i < 100; i += 1) {
      controller.handleInput(input('click', {
        localX: (i % 10) * 30 + 1,
        sceneX: (i % 10) * 30 + 1,
        localY: Math.floor(i / 10) * 28 + 1,
        sceneY: Math.floor(i / 10) * 28 + 1,
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

test('null canvas contexts and detached hosts degrade to dormant without throwing', () => {
  withPlaylist({ record: false, documentOptions: { nullContext: true } }, ({ controller, raf }) => {
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
  withPlaylist({ record: false, documentOptions: { throwOnDraw: true } }, ({ controller, raf, reportCalls }) => {
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
    controller.refresh(buildFixtureContext({ hosts: [] }));
    assert.deepEqual(inspect(controller), before, 'every public mutation is inert after dispose');
    assert.equal(before.disposed, true);
  });
});
