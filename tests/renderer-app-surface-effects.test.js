// spec-first: manager v3 test suite for renderer/app/renderer-app-surface-effects.js
// (Background Effects v3, packet S2 slice B3). A rAF harness + controllable
// clock drive everything deterministically. The shared harness (rAF/clock/log fakes,
// makeFakeController, makeManager) lives in
// tests/helpers/surface-effect-router-harness.js, shared with the S3
// pointer-input router suite (tests/renderer-app-surface-input.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const surfaceEffects = require('../renderer/app/renderer-app-surface-effects.js');
const {
  createRafHarness,
  makeFakeController,
  makeManager,
  findLog,
} = require('./helpers/surface-effect-router-harness.js');

function makeLayoutElement(rect, regionNodes = []) {
  return {
    rect: { ...rect },
    isConnected: true,
    getBoundingClientRect() { return { ...this.rect }; },
    querySelectorAll() { return regionNodes; },
  };
}

// ── 1. activation success ───────────────────────────────────────────────────

test('activation success', () => {
  let factoryCalls = 0;
  const controller = makeFakeController();
  const { manager, raf, logs } = makeManager({
    factories: { grid: () => { factoryCalls += 1; return controller; } },
  });

  manager.activateSurfaceEffect('grid');
  assert.equal(factoryCalls, 1, 'factory called synchronously once');
  assert.equal(raf.size, 1, 'bind is deferred to one rAF');
  assert.equal(manager.getStatus().activeEffectId, 'none', 'not active before flush');

  raf.flush();

  assert.equal(manager.getStatus().activeEffectId, 'grid');
  assert.equal(controller.calls.bind.length, 1);
  assert.equal(controller.calls.bind[0].length, 1, 'v3 path binds with a staged context');
  assert.equal(controller.calls.bind[0][0].staged, true);

  const activated = findLog(logs, (e) => e.event === 'surface_effect.activated');
  const ready = findLog(logs, (e) => e.event === 'surface_effect.ready');
  assert.equal(activated.level, 'INFO');
  assert.equal(activated.payload.effectId, 'grid');
  assert.equal(activated.payload.generation, 1);
  assert.equal(ready.level, 'INFO');
  assert.equal(ready.payload.effectId, 'grid');
  assert.equal(ready.payload.generation, 1);
});

// ── 2. factory failure / incumbent survival ─────────────────────────────────

test('factory failure keeps incumbent survival', () => {
  const controllerA = makeFakeController();
  const { manager, raf, logs } = makeManager({
    factories: {
      a: () => controllerA,
      b: () => { throw new Error('factory boom'); },
    },
  });

  manager.activateSurfaceEffect('a');
  raf.flush();
  assert.equal(manager.getStatus().activeEffectId, 'a');

  manager.activateSurfaceEffect('b');
  assert.equal(raf.size, 0, 'factory throws synchronously -- nothing gets scheduled');
  assert.equal(manager.getStatus().activeEffectId, 'a', 'incumbent survives');
  assert.equal(controllerA.calls.dispose.length, 0);

  const warn = findLog(logs, (e) => e.payload && e.payload.stage === 'factory' && e.payload.effectId === 'b');
  assert.equal(warn.level, 'WARN');
  assert.equal(warn.payload.message, 'factory boom');

  const status = manager.getStatus();
  assert.equal(status.runtimeStateByEffectId.b.bindFailures, 1);
});

// ── 3. bind failure / incumbent survival ────────────────────────────────────

test('bind failure disposes the candidate and incumbent survival holds', () => {
  const controllerA = makeFakeController();
  const controllerB = makeFakeController({ onBind: () => { throw new Error('bind boom'); } });
  const { manager, raf, logs } = makeManager({
    factories: { a: () => controllerA, b: () => controllerB },
  });

  manager.activateSurfaceEffect('a');
  raf.flush();
  manager.activateSurfaceEffect('b');
  raf.flush();

  assert.equal(manager.getStatus().activeEffectId, 'a', 'incumbent survives');
  assert.equal(controllerB.calls.bind.length, 1);
  assert.equal(controllerB.calls.dispose.length, 1, 'failed candidate is disposed');
  assert.equal(controllerA.calls.dispose.length, 0);

  const warn = findLog(logs, (e) => e.payload && e.payload.stage === 'bind' && e.payload.effectId === 'b');
  assert.equal(warn.payload.message, 'bind boom');
});

// ── 4. dormant commit ────────────────────────────────────────────────────────

test('dormant commit', () => {
  const controller = makeFakeController({ getStatus: () => ({ state: 'dormant' }) });
  const { manager, raf, logs } = makeManager({
    registry: [{ id: 'native1', contractVersion: 3 }],
    factories: { native1: () => controller },
  });

  manager.activateSurfaceEffect('native1');
  raf.flush();

  assert.equal(manager.getStatus().activeEffectId, 'native1', 'still commits while dormant');
  assert.equal(controller.calls.bind.length, 1);
  const context = controller.calls.bind[0][0];
  assert.equal(context.staged, true);
  assert.equal(context.generation, 1);
  assert.equal(context.surface, 'chat');
  assert.deepEqual(context.hosts, [], 'no drawable hosts yet');
  assert.deepEqual(context.layout, {
    revision: 1,
    sceneRect: { left: 0, top: 0, width: 0, height: 0 },
    hostRects: [],
    interactionBlockRects: [],
    paintOcclusionRects: [],
    spawnAvoidanceRects: [],
  });

  const activated = findLog(logs, (e) => e.event === 'surface_effect.activated');
  assert.equal(activated.payload.state, 'dormant');
  const ready = findLog(logs, (e) => e.event === 'surface_effect.ready');
  assert.equal(ready, undefined, 'no ready event while dormant');
});

test('layout snapshots use the active shared scene and only revision on geometry change', () => {
  const blocker = makeLayoutElement({ left: 300, top: 40, width: 200, height: 500 });
  const chatView = makeLayoutElement({ left: 10, top: 20, width: 900, height: 700 }, [blocker]);
  const homeView = makeLayoutElement({ left: 1000, top: 20, width: 600, height: 700 });
  const chatScene = makeLayoutElement({ left: 30, top: 40, width: 840, height: 620 });
  const left = makeLayoutElement({ left: 30, top: 40, width: 260, height: 620 });
  const controller = makeFakeController();
  const { manager, raf } = makeManager({
    dom: {
      chatView, homeView, chatSurfaceEffects: chatScene,
      chatSurfaceEffectLeft: left,
    },
    factories: { grid: () => controller },
  });

  manager.activateSurfaceEffect('grid');
  raf.flush();

  const staged = controller.calls.bind[0][0];
  const committed = controller.calls.refresh[0][0];
  // Chat publishes exactly one full-bleed host (F1, 2026-08-21).
  assert.deepEqual(staged.hosts.map((host) => host.role), ['chat-left']);
  assert.deepEqual(staged.layout.sceneRect, chatScene.rect);
  assert.deepEqual(staged.layout.hostRects, [left.rect]);
  assert.equal(staged.layout.revision, committed.layout.revision,
    'candidate commit reuses the same immutable geometry revision');
  assert.ok(staged.layout.interactionBlockRects.length > 0);
  assert.ok(staged.layout.paintOcclusionRects.length > 0);
  assert.ok(staged.layout.spawnAvoidanceRects.length > 0);
  assert.ok(Object.isFrozen(staged.layout));
  assert.ok(Object.isFrozen(staged.layout.hostRects));
  assert.ok(Object.isFrozen(staged.layout.hostRects[0]));
  assert.ok(Object.isFrozen(staged.layout.interactionBlockRects));
  assert.ok(Object.isFrozen(staged.layout.interactionBlockRects[0]));

  manager.refreshActiveSurfaceEffect();
  raf.flush();
  const unchanged = controller.calls.refresh.at(-1)[0].layout;
  assert.equal(unchanged.revision, staged.layout.revision);
  assert.equal(unchanged, committed.layout, 'canonical-equivalent geometry reuses snapshot identity');

  left.rect.left += 20;
  left.rect.width -= 20;
  manager.refreshActiveSurfaceEffect();
  raf.flush();
  const changed = controller.calls.refresh.at(-1)[0].layout;
  assert.equal(changed.revision, staged.layout.revision + 1);
  assert.notEqual(changed, unchanged);
  assert.deepEqual(changed.hostRects[0], left.rect);

  manager.refreshActiveSurfaceEffect();
  raf.flush();
  const stableAgain = controller.calls.refresh.at(-1)[0].layout;
  assert.equal(stableAgain, changed);
  assert.equal(stableAgain.revision, changed.revision);
});

test('layout snapshots isolate malformed rectangles and preserve later valid regions', () => {
  const malformed = {
    getBoundingClientRect() {
      return { left: Number.NaN, top: Number.POSITIVE_INFINITY, width: -50, height: 'bad' };
    },
  };
  const valid = makeLayoutElement({ left: 40, top: 50, width: 60, height: 70 });
  const chatView = makeLayoutElement({ left: 0, top: 0, width: 800, height: 600 }, [malformed, valid]);
  const controller = makeFakeController();
  const { manager, raf } = makeManager({
    dom: {
      chatView,
      chatSurfaceEffects: makeLayoutElement({ left: 0, top: 0, width: 800, height: 600 }),
      chatSurfaceEffectLeft: makeLayoutElement({ left: 0, top: 0, width: 800, height: 600 }),
    },
    factories: { grid: () => controller },
  });
  manager.activateSurfaceEffect('grid');
  raf.flush();

  const layout = controller.calls.bind[0][0].layout;
  for (const rect of [layout.sceneRect, ...layout.hostRects,
    ...layout.interactionBlockRects, ...layout.paintOcclusionRects, ...layout.spawnAvoidanceRects]) {
    assert.ok(Object.values(rect).every(Number.isFinite), 'published rectangles are finite');
    assert.ok(rect.width >= 0 && rect.height >= 0, 'published dimensions are non-negative');
  }
  assert.ok(layout.interactionBlockRects.some((rect) => rect.left === 40 && rect.width === 60),
    'a malformed row cannot suppress a later valid region');
});

test('layout observer coalesces geometry publication and is inert after manager disposal', () => {
  const observers = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
      this.disconnected = false;
      observers.push(this);
    }

    observe(element) { this.observed.add(element); }
    unobserve(element) { this.observed.delete(element); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
    trigger() { this.callback([]); }
  }
  const chatView = makeLayoutElement({ left: 0, top: 0, width: 800, height: 600 });
  const left = makeLayoutElement({ left: 0, top: 0, width: 800, height: 600 });
  const controller = makeFakeController();
  const { manager, raf } = makeManager({
    windowRef: { ResizeObserver: FakeResizeObserver },
    dom: {
      chatView, chatSurfaceEffects: chatView,
      chatSurfaceEffectLeft: left,
    },
    factories: { grid: () => controller },
  });
  manager.activateSurfaceEffect('grid');
  raf.flush();
  const initialRevision = controller.calls.refresh[0][0].layout.revision;
  assert.equal(observers.length, 1);
  const observer = observers[0];
  assert.ok(observer.observed.has(left));

  observer.trigger();
  observer.trigger();
  assert.equal(raf.size, 1, 'resize bursts coalesce to one publisher frame');
  raf.flush();
  assert.equal(controller.calls.refresh.length, 1, 'unchanged geometry does not publish');

  left.rect.left -= 10;
  observer.trigger();
  raf.flush();
  assert.equal(raf.size, 1, 'changed publication schedules one controller refresh');
  raf.flush();
  assert.equal(controller.calls.refresh.at(-1)[0].layout.revision, initialRevision + 1);

  const replacementRegions = [];
  chatView.querySelectorAll = () => replacementRegions;
  for (let index = 0; index < 100; index += 1) {
    const region = makeLayoutElement({ left: 100 + index, top: 20, width: 30, height: 40 });
    replacementRegions.splice(0, replacementRegions.length, region);
    manager.refreshActiveSurfaceEffect();
    raf.flush();
    assert.ok(observer.observed.has(region), 'the current region remains observed');
    assert.ok(observer.observed.size <= 4,
      'replaced region nodes do not accumulate in the observer');
  }

  manager.dispose();
  assert.equal(observer.disconnected, true);
  observer.trigger();
  assert.equal(raf.size, 0, 'post-dispose observer delivery cannot enqueue work');
});

// ── 5. unsupported rejection ─────────────────────────────────────────────────

test('unsupported rejection disposes the candidate without counting a bind failure', () => {
  const controllerA = makeFakeController();
  const unsupportedController = makeFakeController({ getStatus: () => ({ state: 'unsupported' }) });
  const { manager, raf } = makeManager({
    registry: [{ id: 'x', contractVersion: 3 }],
    factories: { a: () => controllerA, x: () => unsupportedController },
  });

  manager.activateSurfaceEffect('a');
  raf.flush();

  manager.activateSurfaceEffect('x');
  raf.flush();
  assert.equal(manager.getStatus().activeEffectId, 'a', 'incumbent survives');
  assert.equal(unsupportedController.calls.dispose.length, 1);
  let status = manager.getStatus();
  assert.equal(status.runtimeStateByEffectId.x.bindFailures, 0);
  assert.equal(status.runtimeStateByEffectId.x.effectDisabled, false);

  // Repeat -- an unsupported rejection is a legitimate answer, not a fault,
  // so it must never accumulate toward the disable policy.
  manager.activateSurfaceEffect('x');
  raf.flush();
  status = manager.getStatus();
  assert.equal(status.runtimeStateByEffectId.x.bindFailures, 0);
  assert.equal(status.runtimeStateByEffectId.x.effectDisabled, false);
  assert.equal(unsupportedController.calls.dispose.length, 2);
});

// ── 6. superseded-generation disposal ───────────────────────────────────────

test('superseded-generation disposal', () => {
  const controllerA = makeFakeController();
  const controllerB = makeFakeController();
  const { manager, raf } = makeManager({ factories: { a: () => controllerA, b: () => controllerB } });

  manager.activateSurfaceEffect('a');
  manager.activateSurfaceEffect('b'); // before 'a' ever flushes
  assert.equal(controllerA.calls.bind.length, 0, 'A never binds');
  assert.equal(controllerA.calls.dispose.length, 1, 'A is disposed as a pending candidate');

  raf.flush();
  assert.equal(manager.getStatus().activeEffectId, 'b');
  assert.equal(controllerB.calls.bind.length, 1);

  const status = manager.getStatus();
  assert.ok(status.counters.supersededCandidates >= 1);
});

test('superseded-generation disposal: a stale rAF firing after full clear is a no-op', () => {
  // This exercises bindPendingCandidate's `if (!candidate) return;` guard --
  // the sibling of the `candidate.generation !== activationGeneration` guard
  // on the same defensive line. A real browser's cancelAnimationFrame can
  // race a callback that has already been handed off to the event loop; we
  // simulate that race by suppressing exactly one cancellation so the old
  // rAF entry survives the harness's callback map.
  //
  // NOTE (documented finding, not a bug): the sibling
  // `candidate.generation !== activationGeneration` branch a few lines above
  // this one is provably unreachable through the public contract in a
  // single-threaded harness. `pendingCandidate` is a single shared variable
  // that activateSurfaceEffect() always disposes-and-reassigns atomically
  // with every activationGeneration bump (disposePendingCandidate() +
  // cancelAnimationFrame() run before a new candidate/rAF is created), so
  // whichever candidate object is live in `pendingCandidate` at flush time
  // necessarily has `candidate.generation === activationGeneration`. The
  // mismatch guard only protects against a scenario this manager's own
  // call graph cannot produce (it would require a second, independently
  // tracked pending candidate, which the singleton variable rules out).
  const controllerA = makeFakeController();
  const controllerB = makeFakeController();
  const innerRaf = createRafHarness();
  let suppressNextCancel = false;
  const leakyRaf = {
    requestAnimationFrame: innerRaf.requestAnimationFrame,
    cancelAnimationFrame(id) {
      if (suppressNextCancel) {
        suppressNextCancel = false;
        return;
      }
      innerRaf.cancelAnimationFrame(id);
    },
  };
  const { manager, logs } = makeManager({
    windowRef: leakyRaf,
    factories: { a: () => controllerA, b: () => controllerB },
  });

  manager.activateSurfaceEffect('a');
  suppressNextCancel = true;
  manager.activateSurfaceEffect('b'); // 'a's rAF cancellation is leaked (stays queued)
  assert.equal(innerRaf.size, 2, 'both the leaked stale entry and the fresh one are queued');

  innerRaf.flush();

  assert.equal(manager.getStatus().activeEffectId, 'b', 'B still commits cleanly');
  assert.equal(controllerB.calls.dispose.length, 0);
  const failWarn = findLog(logs, (e) => e.level === 'WARN' && e.event !== 'surface_effect.activated');
  assert.equal(failWarn, undefined, 'the stale callback is a silent no-op, not a failure');
});

// ── 6b. same-id activation is a refresh, not a rebuild ──────────────────────

test('same-id activation refreshes the active controller instead of rebuilding it', () => {
  // Theme-bundle apply and appearance reset re-invoke activateSurfaceEffect
  // with a possibly-unchanged id (renderer-settings-event-utils.js:844,895;
  // renderer-settings-shell-controller.js:886). The pre-v3 manager reused the
  // existing controller and re-bound it; rebuilding instead would reshuffle
  // the visual field on every theme-bundle apply.
  let factoryCalls = 0;
  const controller = makeFakeController();
  const { manager, raf } = makeManager({
    factories: { a: () => { factoryCalls += 1; return controller; } },
  });

  manager.activateSurfaceEffect('a');
  raf.flush();
  assert.equal(factoryCalls, 1);
  assert.equal(controller.calls.bind.length, 1);

  manager.activateSurfaceEffect('a');
  raf.flush();

  assert.equal(factoryCalls, 1, 'factory NOT called again for the active id');
  assert.equal(controller.calls.dispose.length, 0, 'active controller is not torn down');
  assert.equal(controller.calls.bind.length, 1, 'bind is not reused as refresh');
  assert.equal(controller.calls.refresh.length, 2, 'commit plus same-id activation refresh the v3 context');
  assert.equal(manager.getStatus().activeEffectId, 'a');
});

// ── 7. desired-vs-active divergence ─────────────────────────────────────────

test('desired-vs-active divergence', () => {
  const controllerA = makeFakeController();
  const controllerB = makeFakeController({ onBind: () => { throw new Error('bind boom'); } });
  const { manager, raf } = makeManager({ factories: { a: () => controllerA, b: () => controllerB } });

  manager.activateSurfaceEffect('a');
  raf.flush();
  manager.activateSurfaceEffect('b');
  raf.flush();

  const status = manager.getStatus();
  assert.equal(status.desiredEffectId, 'b');
  assert.equal(status.activeEffectId, 'a');
});

// ── 8. refresh failure isolation ────────────────────────────────────────────

test('refresh failure isolation', () => {
  let refreshCalls = 0;
  const controller = makeFakeController({
    onRefresh: () => {
      refreshCalls += 1;
      if (refreshCalls > 1) throw new Error('refresh boom');
    },
  });
  const { manager, raf, logs } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  raf.flush();
  assert.equal(manager.getStatus().activeEffectId, 'a');

  manager.refreshActiveSurfaceEffect();
  assert.equal(raf.size, 1);
  raf.flush();

  assert.equal(manager.getStatus().activeEffectId, 'a', 'stays active on refresh failure');
  assert.equal(refreshCalls, 2);

  const warn = findLog(logs, (e) => e.payload && e.payload.stage === 'refresh');
  assert.equal(warn.payload.message, 'refresh boom');

  const status = manager.getStatus();
  assert.equal(status.runtimeStateByEffectId.a.frameFailures, 1, 'recorded as frame-class');
});

// ── 9. activity failure isolation / per-capability disable ─────────────────

test('activity failure isolation triggers a per-capability disable, not an effect disable', () => {
  let activityShouldFail = false;
  const controller = makeFakeController({
    onSetActivity: () => {
      if (activityShouldFail) throw new Error('activity boom');
    },
  });
  const { manager, raf, logs } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  raf.flush(); // initial commit snapshot succeeds

  activityShouldFail = true;
  manager.publishActivityPhase('preflight');
  manager.publishActivityPhase('streaming');
  manager.publishActivityPhase('settling'); // 3rd failure -> threshold

  const status = manager.getStatus();
  assert.equal(status.runtimeStateByEffectId.a.activityDisabled, true);
  assert.equal(status.runtimeStateByEffectId.a.activityFailures, 3);
  assert.equal(manager.getStatus().activeEffectId, 'a', 'effect stays active');

  const warn = findLog(logs, (e) => e.payload && e.payload.capability === 'activity');
  assert.equal(warn.level, 'WARN');
  assert.equal(warn.payload.effectId, 'a');

  const callsBeforeMore = controller.calls.setActivity.length;
  manager.publishActivityPhase('idle');
  assert.equal(controller.calls.setActivity.length, callsBeforeMore, 'snapshots stop being delivered once disabled');

});

// ── 10. effect disable threshold ────────────────────────────────────────────

test('effect disable threshold refuses further activation', () => {
  let factoryCalls = 0;
  const { manager, raf, logs } = makeManager({
    factories: {
      a: () => {
        factoryCalls += 1;
        return makeFakeController({
          onBind: () => { throw new Error('bind fail'); },
        });
      },
    },
  });

  manager.activateSurfaceEffect('a');
  raf.flush(); // failure 1
  manager.activateSurfaceEffect('a');
  raf.flush(); // failure 2 -> effectDisabled

  const status = manager.getStatus();
  assert.equal(status.runtimeStateByEffectId.a.effectDisabled, true);
  assert.equal(factoryCalls, 2);

  manager.activateSurfaceEffect('a'); // refused
  assert.equal(factoryCalls, 2, 'factory NOT called while disabled');
  const activateWarn = findLog(logs, (e) => e.payload && e.payload.stage === 'activate' && e.payload.effectId === 'a');
  assert.ok(activateWarn, 'refusal is logged at the activate stage');
});

// ── 11. reportFault ──────────────────────────────────────────────────────────

test('reportFault: recoverable faults within the window hit the disable threshold', () => {
  const controller = makeFakeController();
  const { manager, raf, clock } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  raf.flush();

  for (let i = 0; i < 5; i += 1) {
    manager.reportFault({
      effectId: 'a', stage: surfaceEffects.SURFACE_EFFECT_STAGES.FRAME, recoverable: true, error: new Error('fault ' + i),
    });
    clock.value += 100;
  }

  const status = manager.getStatus();
  assert.equal(status.runtimeStateByEffectId.a.effectDisabled, true);
  assert.equal(manager.getStatus().activeEffectId, 'none');
  assert.equal(controller.calls.dispose.length, 1);
});

test('reportFault: recoverable:false disables immediately', () => {
  const controller = makeFakeController();
  const { manager, raf } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  raf.flush();

  manager.reportFault({
    effectId: 'a', stage: surfaceEffects.SURFACE_EFFECT_STAGES.FRAME, recoverable: false, error: new Error('fatal'),
  });

  const status = manager.getStatus();
  assert.equal(status.runtimeStateByEffectId.a.effectDisabled, true);
  assert.equal(status.runtimeStateByEffectId.a.frameFailures, 0, 'unrecoverable path skips the frame counter entirely');
  assert.equal(manager.getStatus().activeEffectId, 'none');
});

test('reportFault: faults spread wider than the window do not disable', () => {
  const controller = makeFakeController();
  const { manager, raf, clock } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  raf.flush();

  for (let i = 0; i < 5; i += 1) {
    manager.reportFault({
      effectId: 'a', stage: surfaceEffects.SURFACE_EFFECT_STAGES.FRAME, recoverable: true, error: new Error('fault ' + i),
    });
    clock.value += 3000; // 5 faults spread across 12000ms > the 10000ms window
  }

  const status = manager.getStatus();
  assert.equal(status.runtimeStateByEffectId.a.effectDisabled, false);
  assert.equal(manager.getStatus().activeEffectId, 'a');
});

// ── 12. scope-epoch impulse filtering ───────────────────────────────────────

test('scope-epoch impulse filtering', () => {
  const controller = makeFakeController();
  const { manager, raf } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  raf.flush();
  manager.setVisibleActivityScope({ sessionId: 's1' });

  const beforeCalls = controller.calls.handleActivityImpulse.length;
  const droppedResult = manager.publishStreamImpulse({ sessionId: 's2', streamId: '', kind: 'tool-start' });
  assert.equal(droppedResult, false);
  assert.equal(controller.calls.handleActivityImpulse.length, beforeCalls, 'wrong-scope impulse not delivered');

  const deliveredResult = manager.publishStreamImpulse({ sessionId: 's1', streamId: '', kind: 'tool-start' });
  assert.equal(deliveredResult, true);
  assert.equal(controller.calls.handleActivityImpulse.length, beforeCalls + 1);

  const delivered = controller.calls.handleActivityImpulse[controller.calls.handleActivityImpulse.length - 1][0];
  const status = manager.getStatus();
  assert.equal(delivered.scopeEpoch, status.activity.scopeEpoch);
});

// ── 13. impulse sequence ────────────────────────────────────────────────────

test('impulse sequence: repeated tool-starts spaced beyond the window are both distinct', () => {
  const controller = makeFakeController();
  const { manager, raf, clock } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  raf.flush();
  manager.setVisibleActivityScope({ sessionId: 's1' });

  const r1 = manager.publishStreamImpulse({ sessionId: 's1', kind: 'tool-start' });
  clock.value += 300; // > IMPULSE_MERGE_WINDOW_MS (240)
  const r2 = manager.publishStreamImpulse({ sessionId: 's1', kind: 'tool-start' });

  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(controller.calls.handleActivityImpulse.length, 2);

  const seq1 = controller.calls.handleActivityImpulse[0][0].sequence;
  const seq2 = controller.calls.handleActivityImpulse[1][0].sequence;
  assert.equal(seq2, seq1 + 1);
});

// ── 14. arbiter ──────────────────────────────────────────────────────────────

test('arbiter', async (t) => {
  function setupScoped() {
    const controller = makeFakeController();
    const { manager, raf, clock } = makeManager({ factories: { a: () => controller } });
    manager.activateSurfaceEffect('a');
    raf.flush();
    manager.setVisibleActivityScope({ sessionId: 's1' });
    return { controller, manager, clock };
  }

  await t.test('tool-start then complete within the window: both delivered (higher priority wins through)', () => {
    const { controller, manager, clock } = setupScoped();
    const r1 = manager.publishStreamImpulse({ sessionId: 's1', kind: 'tool-start' });
    clock.value += 50;
    const r2 = manager.publishStreamImpulse({ sessionId: 's1', kind: 'complete' });
    assert.equal(r1, true);
    assert.equal(r2, true);
    assert.equal(controller.calls.handleActivityImpulse.length, 2);
  });

  await t.test('complete then tool-start within the window: tool-start suppressed', () => {
    const { controller, manager, clock } = setupScoped();
    manager.publishStreamImpulse({ sessionId: 's1', kind: 'complete' });
    clock.value += 50;
    const r2 = manager.publishStreamImpulse({ sessionId: 's1', kind: 'tool-start' });
    assert.equal(r2, false);
    assert.equal(controller.calls.handleActivityImpulse.length, 1);
  });

  await t.test('cancel-suppresses-complete', () => {
    const { controller, manager, clock } = setupScoped();
    manager.publishStreamImpulse({ sessionId: 's1', kind: 'cancel' });
    clock.value += 50;
    const r2 = manager.publishStreamImpulse({ sessionId: 's1', kind: 'complete' });
    assert.equal(r2, false);
    assert.equal(controller.calls.handleActivityImpulse.length, 1);
  });

  await t.test('same-kind impulses within the window: second suppressed', () => {
    const { controller, manager, clock } = setupScoped();
    manager.publishStreamImpulse({ sessionId: 's1', kind: 'tool-start' });
    clock.value += 50;
    const r2 = manager.publishStreamImpulse({ sessionId: 's1', kind: 'tool-start' });
    assert.equal(r2, false);
    assert.equal(controller.calls.handleActivityImpulse.length, 1);
  });

  await t.test('a scope change resets the arbiter window', () => {
    const { controller, manager, clock } = setupScoped();
    manager.publishStreamImpulse({ sessionId: 's1', kind: 'complete' });
    clock.value += 50;
    manager.setVisibleActivityScope({ sessionId: 's2' });
    const r2 = manager.publishStreamImpulse({ sessionId: 's2', kind: 'tool-start' });
    assert.equal(r2, true, 'lower priority now goes through -- the window was reset');
    assert.equal(controller.calls.handleActivityImpulse.length, 2);
  });
});

// ── 15. snapshot replay excludes impulses ───────────────────────────────────

test('snapshot replay excludes impulses', () => {
  const controller = makeFakeController();
  const { manager, raf } = makeManager({ factories: { a: () => controller } });

  manager.setVisibleActivityScope({ sessionId: 's1' });
  manager.publishActivityPhase('streaming');
  const impulseResult = manager.publishStreamImpulse({ sessionId: 's1', kind: 'tool-start' }); // no controller yet
  assert.equal(impulseResult, true, 'accepted even with no active controller');

  manager.activateSurfaceEffect('a');
  raf.flush();

  assert.equal(controller.calls.setActivity.length, 1, 'exactly one snapshot replay on commit');
  const snapshot = controller.calls.setActivity[0][0];
  assert.equal(snapshot.phase, 'streaming');
  assert.equal(snapshot.targetEnergy, surfaceEffects.PHASE_TARGET_ENERGY.streaming);
  assert.equal(controller.calls.handleActivityImpulse.length, 0, 'impulses are never replayed');
});

// ── 16. scope change republishes ────────────────────────────────────────────

test('scope change republishes the current snapshot and applies the resolved phase', () => {
  const controller = makeFakeController();
  let nextPhase = 'idle';
  let resolvedWith = null;
  const { manager, raf } = makeManager({
    factories: { a: () => controller },
    callbacks: { resolveActivityPhase: (sessionId) => { resolvedWith = sessionId; return nextPhase; } },
  });

  manager.activateSurfaceEffect('a');
  raf.flush();

  // Same phase before/after ('idle' -> 'idle'): the epoch bump alone forces
  // a republish even though the phase held.
  const callsBefore = controller.calls.setActivity.length;
  const revisionBefore = manager.getStatus().activity.phaseRevision;
  manager.setVisibleActivityScope({ sessionId: 'sess-a' });

  assert.equal(resolvedWith, 'sess-a');
  assert.equal(controller.calls.setActivity.length, callsBefore + 1);
  assert.equal(controller.calls.setActivity[controller.calls.setActivity.length - 1][0].phase, 'idle');
  assert.equal(manager.getStatus().activity.phaseRevision, revisionBefore, 'no phaseRevision bump when phase held');
  assert.equal(manager.getStatus().activity.scopeEpoch, 1);

  // Second scope change resolves to a genuinely different phase.
  nextPhase = 'settling';
  manager.setVisibleActivityScope({ sessionId: 'sess-b' });

  assert.equal(resolvedWith, 'sess-b');
  const snapshot = controller.calls.setActivity[controller.calls.setActivity.length - 1][0];
  assert.equal(snapshot.phase, 'settling');
  assert.equal(manager.getStatus().activity.phaseRevision, revisionBefore + 1, 'phase change bumps phaseRevision');
  assert.equal(manager.getStatus().activity.scopeEpoch, 2);
});

// ── 17. dispose with pending rAF ────────────────────────────────────────────

test('dispose with pending rAF', () => {
  const controller = makeFakeController();
  const { manager, raf } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  assert.equal(raf.size, 1);

  manager.dispose();
  assert.equal(controller.calls.dispose.length, 1, 'the pending candidate is disposed');
  assert.equal(raf.size, 0, 'the rAF is cancelled');

  raf.flush();
  assert.equal(controller.calls.bind.length, 0, 'bind never runs');
});

// ── 18. idempotent dispose ──────────────────────────────────────────────────

test('idempotent dispose', () => {
  const controller = makeFakeController();
  const { manager, raf } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  raf.flush();

  manager.dispose();
  manager.dispose(); // must not throw and must not double-dispose
  assert.equal(controller.calls.dispose.length, 1);
});

// ── 19. missing factory ─────────────────────────────────────────────────────

test('missing factory', () => {
  const controllerA = makeFakeController();
  const { manager, raf, logs } = makeManager({ factories: { a: () => controllerA } });

  manager.activateSurfaceEffect('a');
  raf.flush();

  manager.activateSurfaceEffect('does-not-exist');
  assert.equal(manager.getStatus().activeEffectId, 'a', 'incumbent survives');

  const warn = findLog(logs, (e) => e.payload && e.payload.message === 'unknown surface effect id');
  assert.equal(warn.payload.effectId, 'does-not-exist');
  assert.equal(warn.payload.stage, 'factory');
});

// ── 20. failure-log dedupe ──────────────────────────────────────────────────

test('failure-log dedupe', () => {
  const controller = makeFakeController({ onBind: () => { throw new Error('same failure'); } });
  const { manager, raf, logs } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  raf.flush();
  manager.activateSurfaceEffect('a');
  raf.flush();

  const matching = logs.entries.filter((e) => e.event === 'surface_effect.failed' && e.payload.message === 'same failure');
  assert.equal(matching.length, 1, 'only the first occurrence logs');

  const status = manager.getStatus();
  assert.equal(status.counters.dedupedFailureLogs, 1);
});

// ── 21. phase energy mapping ─────────────────────────────────────────────────

test('phase energy mapping', () => {
  const controller = makeFakeController();
  const { manager, raf } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  raf.flush();

  surfaceEffects.ACTIVITY_PHASES.forEach((phase) => {
    manager.publishActivityPhase(phase);
    const snapshot = manager.getStatus().activity;
    assert.equal(snapshot.phase, phase);
    assert.equal(snapshot.targetEnergy, surfaceEffects.PHASE_TARGET_ENERGY[phase]);
  });

});

test('model heartbeat aggregates streaming cadence at 10Hz, low-passes, clamps, and is flag-reversible', () => {
  const enabledState = {
    ui: { activeView: 'chat', appearance: { surfaceEffectId: 'none' } },
    features: { featureFlags: { surface_effect_heartbeat: true } },
  };
  const controller = makeFakeController();
  const { manager, raf, clock } = makeManager({
    state: enabledState,
    factories: { a: () => controller },
  });
  manager.activateSurfaceEffect('a');
  raf.flush();

  manager.publishActivityPhase('streaming');
  let status = manager.getStatus();
  assert.equal(status.activity.targetEnergy,
    surfaceEffects.PHASE_TARGET_ENERGY.streaming + surfaceEffects.MODEL_HEARTBEAT.streamingFloor);
  const callsAfterFloor = controller.calls.setActivity.length;

  for (let i = 0; i < 8; i += 1) {
    clock.value += 10;
    manager.publishActivityPhase('streaming');
  }
  assert.equal(controller.calls.setActivity.length, callsAfterFloor,
    'events inside the 100ms aggregation window do not publish per chunk');

  clock.value += 20;
  manager.publishActivityPhase('streaming');
  status = manager.getStatus();
  assert.ok(status.heartbeat.boost > surfaceEffects.MODEL_HEARTBEAT.streamingFloor);
  assert.ok(status.heartbeat.boost <= surfaceEffects.MODEL_HEARTBEAT.maxBoost);
  assert.equal(controller.calls.setActivity.length, callsAfterFloor + 1);

  clock.value += surfaceEffects.MODEL_HEARTBEAT.longGapMs + 1;
  manager.publishActivityPhase('streaming');
  status = manager.getStatus();
  assert.equal(status.heartbeat.boost, surfaceEffects.MODEL_HEARTBEAT.streamingFloor,
    'a long renderer gap discards stale chunk cadence');

  manager.publishActivityPhase('awaiting-user');
  status = manager.getStatus();
  assert.equal(status.heartbeat.boost, 0, 'awaiting-user hush clears streamed cadence energy');
  assert.equal(status.activity.targetEnergy, surfaceEffects.PHASE_TARGET_ENERGY['awaiting-user']);

  enabledState.features.featureFlags.surface_effect_heartbeat = false;
  manager.publishActivityPhase('streaming');
  status = manager.getStatus();
  assert.equal(status.heartbeat.enabled, false);
  assert.equal(status.activity.targetEnergy, surfaceEffects.PHASE_TARGET_ENERGY.streaming,
    'env-reversible flag restores the base streaming energy');
});

test('approval hush feeds the active card into interaction, spawn, and paint regions', () => {
  const approval = makeLayoutElement({ left: 320, top: 80, width: 180, height: 96 });
  const ordinaryRegions = Array.from({ length: 128 }, (_, index) => makeLayoutElement({
    left: index * 2, top: 10, width: 1, height: 1,
  }));
  const chatView = makeLayoutElement({ left: 0, top: 0, width: 800, height: 600 });
  let approvalActive = false;
  chatView.querySelectorAll = (selector) => {
    if (selector.includes('approval-gap-row')) {
      return approvalActive ? [approval] : [];
    }
    return ordinaryRegions;
  };
  const controller = makeFakeController();
  const { manager, raf } = makeManager({
    dom: {
      chatView,
      chatSurfaceEffects: makeLayoutElement({ left: 0, top: 0, width: 800, height: 600 }),
      chatSurfaceEffectLeft: makeLayoutElement({ left: 0, top: 0, width: 800, height: 600 }),
    },
    factories: { a: () => controller },
  });
  manager.activateSurfaceEffect('a');
  raf.flush();
  assert.equal(controller.calls.bind[0][0].layout.spawnAvoidanceRects.some(
    (rect) => rect.left === 320 && rect.top === 80,
  ), false);

  approvalActive = true;
  manager.publishActivityPhase('awaiting-user');
  raf.flush();

  const layout = controller.calls.refresh.at(-1)[0].layout;
  assert.equal(layout.spawnAvoidanceRects.length, 128, 'region cap remains enforced');
  for (const regions of [
    layout.interactionBlockRects,
    layout.spawnAvoidanceRects,
    layout.paintOcclusionRects,
  ]) {
    assert.ok(regions.some((rect) => rect.left === 320 && rect.top === 80
      && rect.width === 180 && rect.height === 96));
  }
  assert.ok(Object.isFrozen(layout));
  assert.ok(Object.isFrozen(layout.spawnAvoidanceRects));
  assert.ok(Object.isFrozen(layout.paintOcclusionRects));
});

// ── 22. none activation ─────────────────────────────────────────────────────

test('none activation', () => {
  const controller = makeFakeController();
  const { manager, raf } = makeManager({ factories: { a: () => controller } });

  manager.activateSurfaceEffect('a');
  raf.flush();
  assert.equal(manager.getStatus().activeEffectId, 'a');

  manager.activateSurfaceEffect('none');
  assert.equal(controller.calls.dispose.length, 1, 'disposed synchronously, no rAF needed');
  assert.equal(manager.getStatus().activeEffectId, 'none');
  assert.equal(raf.size, 0);
});
