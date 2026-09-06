const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const {
  SCRIPT_ORDER,
  extractRendererScriptOrder,
  isExcludedScriptSource,
} = require('./helpers/renderer-shell-harness-support');

const ROOT = path.resolve(__dirname, '..');
const productionScripts = SCRIPT_ORDER;

function extractScriptTagSources(html) {
  const uncommentedHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  const pattern = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  const sources = [];
  let match;
  while ((match = pattern.exec(uncommentedHtml)) !== null) {
    sources.push(match[2]);
  }
  return sources;
}

test('renderer shell harness SCRIPT_ORDER derives every production renderer script in document order', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const independentlyParsedScripts = extractScriptTagSources(html)
    .filter((src) => !isExcludedScriptSource(src));
  assert.deepEqual(
    SCRIPT_ORDER,
    independentlyParsedScripts,
    'derived SCRIPT_ORDER must preserve every production local script src in document order'
  );
});

test('renderer shell harness SCRIPT_ORDER resolves every derived renderer script to an existing file', () => {
  const missingFiles = SCRIPT_ORDER.filter((src) => !fs.existsSync(path.join(ROOT, src)));
  assert.deepEqual(
    missingFiles,
    [],
    `index.html references renderer scripts that do not exist: ${missingFiles.join(', ')}`
  );
});

test('renderer shell harness SCRIPT_ORDER has no duplicates and ignores commented script markup', () => {
  const seen = new Set();
  const duplicates = [];
  for (const src of SCRIPT_ORDER) {
    if (seen.has(src)) {
      duplicates.push(src);
    }
    seen.add(src);
  }
  assert.deepEqual(duplicates, [], `duplicate entries in SCRIPT_ORDER: ${duplicates.join(', ')}`);

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const htmlWithSrcTrap = html.replace(
    '<!-- Lazy <script> injector',
    '<!-- Lazy <script src="renderer/comment-only.js"></script> injector'
  );
  assert.notEqual(
    htmlWithSrcTrap,
    html,
    'expected the index.html:1343 script-injector comment trap; update this locator if the comment is renamed'
  );
  assert.deepEqual(
    extractRendererScriptOrder(htmlWithSrcTrap),
    SCRIPT_ORDER,
    'script-like markup inside the index.html:1343 comment must not enter SCRIPT_ORDER'
  );
});

test('stream-reveal callbacks load before the message renderer in production and the harness', () => {
  const dependency = 'renderer/chat/renderer-render-pipeline-stream-reveal-callbacks.js';
  const consumer = 'renderer/chat/renderer-render-pipeline-message-renderer.js';

  for (const scripts of [productionScripts, SCRIPT_ORDER]) {
    const dependencyIndex = scripts.indexOf(dependency);
    const consumerIndex = scripts.indexOf(consumer);
    assert.notEqual(dependencyIndex, -1, `${dependency} should be present`);
    assert.notEqual(consumerIndex, -1, `${consumer} should be present`);
    assert.ok(
      dependencyIndex < consumerIndex,
      `${dependency} must load before ${consumer}`
    );
  }
});

test('timeline scroll dependencies load before their consumers in production and the harness', () => {
  const orderedGroups = [
    [
      'renderer/chat/chat-scroll-utils.js',
      'renderer/chat/chat-thinking-utils.js',
      'renderer/chat/renderer-chat-scroll-coordinator.js',
      'renderer/app/renderer-app-lifecycle-composition.js',
    ],
    [
      'renderer/chat/renderer-chat-timeline-virtualizer-entry-store.js',
      'renderer/chat/renderer-chat-timeline-virtualizer.js',
      'renderer/app/renderer-app-controller-composition.js',
    ],
  ];
  for (const scripts of [productionScripts, SCRIPT_ORDER]) {
    for (const requiredOrder of orderedGroups) {
      const indexes = requiredOrder.map((source) => scripts.indexOf(source));
      assert.ok(indexes.every((index) => index >= 0), 'all timeline dependencies are registered');
      assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, 'timeline script order is stable');
    }
  }
});

test('subagent monitor dependencies load before transcript consumers and app composition', () => {
  const requiredOrder = [
    'renderer/chat/renderer-agent-step-utils.js',
    'renderer/chat/renderer-subagent-monitor-model.js',
    'renderer/chat/renderer-subagent-monitor-view.js',
    'renderer/chat/renderer-transcript-agent-progress.js',
    'renderer/chat/renderer-subagent-monitor-controller.js',
    'renderer/chat/renderer-chat-shell-controller.js',
    'renderer/app/renderer-app-controller-composition.js',
  ];
  for (const scripts of [productionScripts, SCRIPT_ORDER]) {
    const indexes = requiredOrder.map((source) => scripts.indexOf(source));
    assert.ok(indexes.every((index) => index >= 0), 'all monitor dependencies are registered');
    assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, 'monitor script order is stable');
  }
});

test('plugin session controller loads after its view host and before app composition', () => {
  const requiredOrder = [
    'renderer/shell/renderer-plugin-view-host.js',
    'renderer/shell/renderer-plugin-session-controller.js',
    'renderer/app/renderer-app-shell-bindings-mcp.js',
  ];
  for (const scripts of [productionScripts, SCRIPT_ORDER]) {
    const indexes = requiredOrder.map((source) => scripts.indexOf(source));
    assert.ok(indexes.every((index) => index >= 0));
    assert.ok(indexes[0] < indexes[1] && indexes[1] < indexes[2]);
  }
});

test('turn-tree projector message utils load between normalization utils and the projector', () => {
  const dependency = 'renderer/chat/renderer-turn-normalization-utils.js';
  const messageUtils = 'renderer/chat/renderer-turn-tree-projector-message-utils.js';
  const consumer = 'renderer/chat/renderer-turn-tree-projector.js';

  for (const scripts of [productionScripts, SCRIPT_ORDER]) {
    const dependencyIndex = scripts.indexOf(dependency);
    const messageUtilsIndex = scripts.indexOf(messageUtils);
    const consumerIndex = scripts.indexOf(consumer);
    assert.notEqual(dependencyIndex, -1, `${dependency} should be present`);
    assert.notEqual(messageUtilsIndex, -1, `${messageUtils} should be present`);
    assert.notEqual(consumerIndex, -1, `${consumer} should be present`);
    assert.ok(
      dependencyIndex < messageUtilsIndex,
      `${dependency} should load before ${messageUtils}`
    );
    assert.ok(
      messageUtilsIndex < consumerIndex,
      `${messageUtils} should load before ${consumer}`
    );
  }
});

test('unsaved reply actions load after their browser-global inventory dependencies', () => {
  const consumer = 'renderer/chat/renderer-unsaved-reply-actions.js';
  const dependencies = [
    'renderer/inventory/badge.js',
    'renderer/inventory/action-button.js',
  ];

  for (const scripts of [productionScripts, SCRIPT_ORDER]) {
    const consumerIndex = scripts.indexOf(consumer);
    assert.notEqual(consumerIndex, -1, `${consumer} should be present`);
    for (const dependency of dependencies) {
      const dependencyIndex = scripts.indexOf(dependency);
      assert.notEqual(dependencyIndex, -1, `${dependency} should be present`);
      assert.ok(
        dependencyIndex < consumerIndex,
        `${dependency} should load before ${consumer}`
      );
    }
  }
});

test('File Map atlas factories load before the controller without CommonJS', () => {
  // atlas-view resolves atlas-layout at module load, and the controller
  // resolves everything below — order is load-bearing in both manifests.
  const dependencies = [
    'renderer/features/renderer-ide-map-atlas-layout.js',
    'renderer/features/renderer-ide-map-atlas-view.js',
    'renderer/features/renderer-ide-map-prefs.js',
    'renderer/features/renderer-ide-map-activity-bus.js',
    'renderer/features/renderer-ide-map-activity-rail.js',
  ];
  const controller = 'renderer/features/renderer-ide-map-controller.js';

  for (const dependency of dependencies) {
    assert.ok(productionScripts.indexOf(dependency) < productionScripts.indexOf(controller));
    assert.ok(SCRIPT_ORDER.indexOf(dependency) < SCRIPT_ORDER.indexOf(controller));
  }
  assert.ok(
    productionScripts.indexOf(dependencies[0]) < productionScripts.indexOf(dependencies[1]),
    'atlas-layout must precede atlas-view'
  );

  const browserContext = vm.createContext({});
  for (const src of [...dependencies, controller]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, src), 'utf8'), browserContext, { filename: src });
  }
  assert.equal(typeof browserContext.rendererIdeMapAtlasLayout?.layout, 'function');
  assert.equal(typeof browserContext.rendererIdeMapAtlasView?.createAtlasView, 'function');
  assert.equal(typeof browserContext.rendererIdeMapPrefs?.createMapPrefs, 'function');
  assert.equal(typeof browserContext.rendererIdeMapActivityBus?.createMapActivityBus, 'function');
  assert.equal(typeof browserContext.rendererIdeMapActivityRail?.createMapActivityPresenter, 'function');
  assert.equal(typeof browserContext.rendererIdeMapController?.createIdeMapController, 'function');
});

test('shared string utils load before renderer helpers that consume them', () => {
  const requiredOrder = [
    'renderer/shared/string-utils.js',
    'renderer/chat/chat-bubble-action-utils.js',
    'renderer/shared/toast-utils.js',
    'renderer/shared/log-view-utils.js',
    'renderer/chat/renderer-stream-handler-reasoning-merge.js',
    'renderer/chat/renderer-stream-handler.js',
  ];

  for (const src of requiredOrder) {
    assert.notEqual(
      productionScripts.indexOf(src),
      -1,
      `index.html should load ${src}`
    );
    assert.notEqual(
      SCRIPT_ORDER.indexOf(src),
      -1,
      `renderer harness should load ${src}`
    );
  }

  for (const consumer of requiredOrder.slice(1)) {
    assert.ok(
      productionScripts.indexOf('renderer/shared/string-utils.js') < productionScripts.indexOf(consumer),
      `index.html should load renderer/shared/string-utils.js before ${consumer}`
    );
    assert.ok(
      SCRIPT_ORDER.indexOf('renderer/shared/string-utils.js') < SCRIPT_ORDER.indexOf(consumer),
      `renderer harness should load renderer/shared/string-utils.js before ${consumer}`
    );
  }
});

test('code review renderer helpers load before synchronous consumers', () => {
  const requiredEdges = [
    ['renderer/chat/renderer-code-review-affordance.js', 'renderer/chat/renderer-tool-shell-utils.js'],
    ['renderer/chat/renderer-code-review-affordance.js', 'renderer/chat/renderer-transcript-tool-calls.js'],
    ['renderer/chat/renderer-diff-hunks-render.js', 'renderer/chat/renderer-transcript-tool-calls.js'],
    ['renderer/chat/renderer-jenny-change-ledger.js', 'renderer/chat/renderer-transcript-tool-calls.js'],
    ['renderer/chat/renderer-session-diff-review-model.js', 'renderer/shell/renderer-shell-artifact-bridge.js'],
    ['renderer/features/renderer-code-review-render.js', 'renderer/shell/renderer-shell-artifact-bridge.js'],
    ['renderer/features/renderer-code-review-rail.js', 'renderer/shell/renderer-shell-artifact-bridge.js'],
  ];

  for (const [dependency, consumer] of requiredEdges) {
    assert.notEqual(
      productionScripts.indexOf(dependency),
      -1,
      `index.html should load ${dependency}`
    );
    assert.notEqual(
      productionScripts.indexOf(consumer),
      -1,
      `index.html should load ${consumer}`
    );
    assert.ok(
      productionScripts.indexOf(dependency) < productionScripts.indexOf(consumer),
      `index.html should load ${dependency} before ${consumer}`
    );
    assert.notEqual(
      SCRIPT_ORDER.indexOf(dependency),
      -1,
      `renderer harness should load ${dependency}`
    );
    assert.notEqual(
      SCRIPT_ORDER.indexOf(consumer),
      -1,
      `renderer harness should load ${consumer}`
    );
    assert.ok(
      SCRIPT_ORDER.indexOf(dependency) < SCRIPT_ORDER.indexOf(consumer),
      `renderer harness should load ${dependency} before ${consumer}`
    );
  }
});

// UIUX-002 (W0-A): five renderer modules were absent from BOTH index.html and
// SCRIPT_ORDER, so the set-equality tests above passed on the same
// incomplete set and never caught the gap. In the sandboxed production
// BrowserWindow (contextIsolation, no CommonJS `require`) the modules'
// UMD headers fall back to reading `root.<global>`, which stays undefined
// forever if the dependency script never ran — resolveViewModelFactory()
// in renderer-turn-row-projector.js caches that `null` permanently, so
// projectTurn() silently returns viewModel: null, and the settings overlay
// / v2-surface renderers silently no-op. These tests load the real
// dependency chain in a bare vm.createContext({}) (no require, no module)
// to prove the modules resolve their peers purely from index.html/
// SCRIPT_ORDER load order, the same constraint production faces.

test('chat turn view-model factories load before the row projector without CommonJS', () => {
  const dependencies = [
    'renderer/chat/renderer-turn-view-model-sections.js',
    'renderer/chat/renderer-turn-view-model.js',
  ];
  const rowProjector = 'renderer/chat/renderer-turn-row-projector.js';

  for (const dependency of dependencies) {
    assert.notEqual(productionScripts.indexOf(dependency), -1, `index.html should load ${dependency}`);
    assert.notEqual(SCRIPT_ORDER.indexOf(dependency), -1, `renderer harness should load ${dependency}`);
    assert.ok(
      productionScripts.indexOf(dependency) < productionScripts.indexOf(rowProjector),
      `index.html should load ${dependency} before ${rowProjector}`
    );
    assert.ok(
      SCRIPT_ORDER.indexOf(dependency) < SCRIPT_ORDER.indexOf(rowProjector),
      `renderer harness should load ${dependency} before ${rowProjector}`
    );
  }
  // sections must precede view-model specifically: renderer-turn-view-model.js
  // reads root.rendererTurnViewModelSections at parse time (factory arg).
  assert.ok(productionScripts.indexOf(dependencies[0]) < productionScripts.indexOf(dependencies[1]));
  assert.ok(SCRIPT_ORDER.indexOf(dependencies[0]) < SCRIPT_ORDER.indexOf(dependencies[1]));

  // Load the real dependency chain (plus the row projector's own peer
  // modules) in a bare VM context with no `require`/`module`, matching the
  // sandboxed production BrowserWindow, and prove the whole chain resolves
  // via globals alone -- including that the row projector's view-model
  // resolution (resolveViewModelFactory) actually finds a live builder
  // instead of caching null forever.
  const chain = [
    'renderer/chat/renderer-turn-normalization-utils.js',
    'renderer/chat/renderer-row-identity-utils.js',
    'renderer/chat/renderer-turn-row-projector-utils.js',
    'renderer/chat/renderer-turn-row-projector-tools.js',
    ...dependencies,
    rowProjector,
  ];
  const browserContext = vm.createContext({});
  for (const src of chain) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, src), 'utf8'), browserContext, { filename: src });
  }
  assert.equal(typeof browserContext.rendererTurnViewModelSections?.buildToolCallSections, 'function');
  assert.equal(typeof browserContext.rendererTurnViewModel?.buildTurnViewModel, 'function');
  assert.equal(typeof browserContext.rendererTurnRowProjector?.projectTurn, 'function');

  const turn = {
    turn_id: 'vm-check-turn',
    events: [
      { kind: 'user_prompt', event_id: 'e1', primary_message_id: 'u1', payload: { content: 'hi' } },
    ],
    primary_user_message_id: 'u1',
    primary_assistant_message_id: 'a1',
  };
  const projected = browserContext.rendererTurnRowProjector.projectTurn(turn, {});
  assert.notEqual(
    projected.viewModel,
    null,
    'projectTurn should resolve a non-null view model from globals alone (no require available)'
  );
  assert.equal(projected.viewModel.turnId, 'vm-check-turn');
});

test('stream rehydrate loads after the turn reducer + normalization utils without CommonJS', () => {
  const dependencies = [
    'renderer/chat/chat-terminal-status-vocabulary.js',
    'renderer/chat/renderer-stream-terminal-state.js',
    'renderer/chat/renderer-turn-reducer.js',
    'renderer/chat/renderer-turn-normalization-utils.js',
    // The canonical fold hard-requires the plan-document normalizer for its
    // plan_document branch, so index.html ordering is load-bearing.
    'renderer/features/renderer-plan-document.js',
  ];
  const consumer = 'renderer/chat/renderer-stream-rehydrate.js';

  for (const dependency of dependencies) {
    assert.notEqual(productionScripts.indexOf(dependency), -1, `index.html should load ${dependency}`);
    assert.notEqual(SCRIPT_ORDER.indexOf(dependency), -1, `renderer harness should load ${dependency}`);
    assert.ok(
      productionScripts.indexOf(dependency) < productionScripts.indexOf(consumer),
      `index.html should load ${dependency} before ${consumer}`
    );
    assert.ok(
      SCRIPT_ORDER.indexOf(dependency) < SCRIPT_ORDER.indexOf(consumer),
      `renderer harness should load ${dependency} before ${consumer}`
    );
  }

  const chain = [
    'renderer/chat/chat-terminal-status-vocabulary.js',
    'renderer/chat/renderer-stream-terminal-state.js',
    'renderer/chat/renderer-turn-normalization-utils.js',
    'renderer/chat/renderer-reasoning-entry-merge-utils.js',
    'renderer/chat/renderer-turn-reducer-stream-event-utils.js',
    'renderer/chat/renderer-turn-reducer-approval-gap.js',
    'renderer/chat/renderer-row-identity-utils.js',
    'renderer/chat/renderer-turn-reducer-tool-rows.js',
    'renderer/features/renderer-plan-document.js',
    'renderer/chat/renderer-turn-reducer-canonical-rows.js',
    'renderer/chat/renderer-turn-reducer.js',
    consumer,
  ];
  const browserContext = vm.createContext({});
  for (const src of chain) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, src), 'utf8'), browserContext, { filename: src });
  }
  const exportedFns = [
    'rehydrateSessionLiveState',
    'projectPersistedEventsWithReducer',
    'shapePersistedEventForReducer',
    'replayPersistedEvents',
    'resolveInFlightTurnId',
    'withActiveTurnForwarded',
  ];
  for (const fnName of exportedFns) {
    assert.equal(
      typeof browserContext.rendererStreamRehydrate?.[fnName],
      'function',
      `rendererStreamRehydrate.${fnName} should be a function`
    );
  }
  assert.ok(
    browserContext.rendererStreamRehydrate?.REPLAYABLE_KINDS
    && typeof browserContext.rendererStreamRehydrate.REPLAYABLE_KINDS.has === 'function',
    'rendererStreamRehydrate.REPLAYABLE_KINDS should be a Set-like collection'
  );
});

test('settings overlay and v2-surface builders load before settings-utils without CommonJS', () => {
  const sharedDependencies = [
    'renderer/features/setup-scenes/scene-utils.js',
  ];
  const newModules = [
    'renderer/shell/renderer-settings-overlays.js',
    'renderer/shell/renderer-settings-v2-surfaces.js',
  ];
  const consumer = 'renderer/shell/renderer-settings-utils.js';

  for (const dependency of [...sharedDependencies, ...newModules]) {
    assert.notEqual(productionScripts.indexOf(dependency), -1, `index.html should load ${dependency}`);
    assert.notEqual(SCRIPT_ORDER.indexOf(dependency), -1, `renderer harness should load ${dependency}`);
    assert.ok(
      productionScripts.indexOf(dependency) < productionScripts.indexOf(consumer),
      `index.html should load ${dependency} before ${consumer}`
    );
    assert.ok(
      SCRIPT_ORDER.indexOf(dependency) < SCRIPT_ORDER.indexOf(consumer),
      `renderer harness should load ${dependency} before ${consumer}`
    );
  }
  // renderer-settings-v2-surfaces.js reads root.rendererSetupSceneUtils at parse time.
  for (const dependency of sharedDependencies) {
    assert.ok(
      productionScripts.indexOf(dependency) < productionScripts.indexOf('renderer/shell/renderer-settings-v2-surfaces.js')
    );
    assert.ok(
      SCRIPT_ORDER.indexOf(dependency) < SCRIPT_ORDER.indexOf('renderer/shell/renderer-settings-v2-surfaces.js')
    );
  }

  const chain = [
    'renderer/shared/string-utils.js',
    'renderer/shared/log-contract-utils.js',
    'renderer/shared/log-view-utils.js',
    ...sharedDependencies,
    ...newModules,
  ];
  const browserContext = vm.createContext({});
  for (const src of chain) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, src), 'utf8'), browserContext, { filename: src });
  }
  assert.equal(typeof browserContext.rendererSettingsOverlays?.createSettingsOverlayRenderer, 'function');
  assert.equal(typeof browserContext.rendererSettingsV2Surfaces?.renderSettingsV2Surfaces, 'function');
});

test('Playlist Scroll core loads before its controller in production and the shell harness', () => {
  const core = 'renderer/shell/renderer-playlist-scroll-core.js';
  const controller = 'renderer/shell/renderer-playlist-scroll-utils.js';
  assert.ok(productionScripts.indexOf(core) < productionScripts.indexOf(controller));
  assert.ok(SCRIPT_ORDER.indexOf(core) < SCRIPT_ORDER.indexOf(controller));
});

test('plugin settings commands bind to the production chat send controller', async () => {
  let pluginOptions = null;
  const windowRef = {
    rendererPluginsSettingsUtils: {
      createPluginsSettingsController(options) {
        pluginOptions = options;
        return { bind() {}, render() {}, dispose() {} };
      },
    },
  };
  const browserContext = vm.createContext({ window: windowRef });
  const source = 'renderer/app/renderer-app-shell-bindings-mcp.js';
  vm.runInContext(fs.readFileSync(path.join(ROOT, source), 'utf8'), browserContext, { filename: source });

  windowRef.rendererAppShellBindingsMcp.bindSettingsSectionControllers({
    state: { currentSessionId: 'session-1', features: { featureFlags: { plugins: false } } },
    windowRef,
    documentRef: {},
    callbacks: {},
    constants: {},
    registerCleanup() {},
    controllers: {},
  });

  assert.ok(pluginOptions, 'plugin settings controller receives its production dependencies');
});
