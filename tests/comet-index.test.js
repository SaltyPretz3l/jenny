const test = require('node:test');
const assert = require('node:assert/strict');

function withCometGlobals(callback) {
  const keys = [
    'rendererCometUtils',
    'cometDomUtils',
    'cometBehaviorRegistryUtils',
    'rendererCometPersonalityUtils',
    'cometBehaviorIdleDrift',
    'cometBehaviorSettle',
    'cometBehaviorFollowCursor',
    'cometBehaviorAlert',
    'cometBehaviorExcited',
    'cometBehaviorAnchoredOrbit',
  ];
  const previous = new Map(keys.map((key) => [key, globalThis[key]]));
  let disposeCount = 0;
  const captured = {
    cometOptions: [],
    personalityDeps: [],
  };

  globalThis.rendererCometUtils = {
    createComet(_container, options) {
      captured.cometOptions.push({ ...(options || {}) });
      return {
        registerPalette() {},
        start() {},
        dispose() {
          disposeCount += 1;
        },
      };
    },
  };
  globalThis.cometDomUtils = {
    createCometDomLayer() {
      return {
        getElement() {
          return {
            getBoundingClientRect() {
              return { width: 800, height: 600 };
            },
          };
        },
        show() {},
        hide() {},
        dispose() {},
      };
    },
  };
  globalThis.cometBehaviorRegistryUtils = {
    createBehaviorEngine() {
      return {
        register() {},
        dispose() {},
      };
    },
  };
  globalThis.rendererCometPersonalityUtils = {
    PERSONALITY_PALETTES: { idle: {} },
    createCometPersonality(deps) {
      captured.personalityDeps.push({ ...(deps || {}) });
      return {
        bind() {},
        dispose() {},
        onStreamEvent() {},
        onSentiment() {},
        onUserAction() {},
        getState() {
          return 'idle';
        },
        setState() {},
      };
    },
  };

  try {
    return callback(() => disposeCount, captured);
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete globalThis[key];
      } else {
        globalThis[key] = value;
      }
    }
  }
}

function loadCometModuleFresh() {
  const modulePath = require.resolve('../comet/index.js');
  delete require.cache[modulePath];
  return require(modulePath);
}

function createEnabledDeps() {
  return {
    state: {
      features: {
        featureFlags: {
          comet_personality: true,
        },
      },
    },
    reducedMotionQuery: { matches: true },
    dom: { workspace: {} },
    callbacks: {},
  };
}

test('disposeComet tears down the current instance without blocking same-page rebootstrap', () => {
  withCometGlobals((getDisposeCount) => {
    const cometModule = loadCometModuleFresh();

    const first = cometModule.bootstrapComet(createEnabledDeps());
    assert.ok(first, 'expected first comet instance');

    cometModule.disposeComet();
    assert.equal(getDisposeCount(), 1);

    const second = cometModule.bootstrapComet(createEnabledDeps());
    assert.ok(second, 'expected a fresh comet instance after disposal');
    assert.notEqual(second, first);

    cometModule.disposeComet();
    assert.equal(getDisposeCount(), 2);
  });
});

test('bootstrapComet uses a single manual personality clock', () => {
  withCometGlobals((_getDisposeCount, captured) => {
    const cometModule = loadCometModuleFresh();

    const instance = cometModule.bootstrapComet(createEnabledDeps());

    assert.ok(instance);
    assert.equal(captured.cometOptions[0].manualClock, true);
    assert.equal(captured.personalityDeps[0].manualClock, true);
    cometModule.disposeComet();
  });
});
