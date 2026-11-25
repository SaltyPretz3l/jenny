const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const { SCRIPT_ORDER } = require('./helpers/renderer-shell-harness-support');

const ROOT = path.resolve(__dirname, '..');
const APP_OWNER_MODULES = [
  'renderer/app/renderer-app-controller-composition.js',
  'renderer/app/renderer-app-lifecycle-preferences.js',
  'renderer/app/renderer-app-open-loop-actions.js',
  'renderer/app/renderer-app-shell-bindings.js',
  'renderer/app/renderer-app-surface-effects.js',
];

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// The app compositions read their dependencies as `ctx.NAME`. renderer/app.js hands
// the two roots an object literal, and each root hands its sections
// `{ __proto__: ctx, ...locals }`. A name that is read but never handed over is
// undefined only when the UI invokes it (a click), never at load: that is how the
// reasoning expand toggle and the chat Copy button broke. compositionContract()
// parses the sources and returns, per factory, the names it reads from ctx and
// the keys its one caller provides (the caller's own keys plus its parent's).
const COMPOSITION_FILES = [
  'renderer/app/renderer-app-boot-preferences-composition.js',
  'renderer/app/renderer-app-chat-shell-composition.js',
  'renderer/app/renderer-app-controller-composition.js',
  'renderer/app/renderer-app-lifecycle-composition.js',
  'renderer/app/renderer-app-navigation-composition.js',
  'renderer/app/renderer-app-notices-composition.js',
  'renderer/app/renderer-app-settings-composition.js',
  'renderer/app/renderer-app-shell-services-composition.js',
];

function walkAst(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  ancestors.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walkAst(child, visit, ancestors));
    else if (value && typeof value.type === 'string') walkAst(value, visit, ancestors);
  }
  ancestors.pop();
}

const isCtxFactory = (node) => node.type === 'FunctionDeclaration' && node.params[0]?.name === 'ctx';
// A nested `const ctx` or `(ctx) =>` would silently redirect every `ctx.NAME` under it.
const shadowsCtx = (node) => (node.type === 'VariableDeclarator' && node.id.name === 'ctx')
  || (/Function/.test(node.type) && !isCtxFactory(node) && node.params.some((param) => param.name === 'ctx'));

let cachedCompositionContract = null;
function compositionContract() {
  cachedCompositionContract ??= parseCompositionContract();
  return cachedCompositionContract;
}

function parseCompositionContract() {
  const asts = ['renderer/app.js', ...COMPOSITION_FILES].map((file) => [
    file, acorn.parse(readRepoFile(file), { ecmaVersion: 'latest', sourceType: 'script' }),
  ]);
  const factories = new Map(); // factory name -> { file, reads, callSites }
  for (const [file, ast] of asts) {
    walkAst(ast, (node) => {
      if (isCtxFactory(node)) factories.set(node.id.name, { file, reads: new Set(), callSites: [] });
    });
  }
  for (const [file, ast] of asts) {
    walkAst(ast, (node, ancestors) => {
      const owner = ancestors.findLast(isCtxFactory)?.id.name || null;
      assert.ok(!owner || !shadowsCtx(node), `${file}: ${owner} must not redeclare ctx in a nested scope`);
      if (node.type === 'MemberExpression' && !node.computed && node.object.name === 'ctx' && owner) {
        factories.get(owner).reads.add(node.property.name);
      }
      if (node.type !== 'CallExpression' || node.arguments[0]?.type !== 'ObjectExpression') return;
      const callee = node.callee.type === 'MemberExpression' ? node.callee.property.name : node.callee.name;
      // The settings factory forwards to a utils function of the same name: not one of its callers.
      if (!factories.has(callee) || callee === owner) return;
      const site = { file, ownKeys: [], parent: null };
      for (const property of node.arguments[0].properties) {
        assert.ok(property.type === 'Property' && !property.computed,
          `${file}: the ctx handed to ${callee} must be a plain literal (no spread, no computed key)`);
        const key = property.key.name ?? String(property.key.value);
        if (key === '__proto__' && property.kind === 'init' && !property.shorthand) {
          assert.equal(property.value.name, 'ctx', `${file}: ${callee} must inherit from its caller's ctx`);
          site.parent = owner;
        } else {
          site.ownKeys.push(key);
        }
      }
      factories.get(callee).callSites.push(site);
    });
  }
  const keysFor = (name) => {
    const { callSites } = factories.get(name);
    assert.equal(callSites.length, 1, `${name} should have exactly one call site handing it a ctx literal`);
    const keys = new Set(callSites[0].ownKeys);
    if (callSites[0].parent) keysFor(callSites[0].parent).forEach((key) => keys.add(key));
    return keys;
  };
  return { factories, keysFor };
}

function extractScriptSources(html) {
  const pattern = /<script\s+[^>]*src="([^"]+)"[^>]*><\/script>/gi;
  const sources = [];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    sources.push(match[1]);
  }
  return sources;
}

test('renderer app root delegates shell ownership to focused renderer/app modules', () => {
  const appSource = readRepoFile('renderer/app.js');
  const appLines = appSource.split(/\r?\n/).length;

  assert.ok(appLines <= 1015, `renderer/app.js should be under 1015, got ${appLines}`);

  for (const modulePath of APP_OWNER_MODULES) {
    assert.ok(
      fs.existsSync(path.join(ROOT, modulePath)),
      `${modulePath} should exist as a focused renderer app owner`
    );
  }
});

test('renderer app owner modules load before the app bootstrap in production and harness', () => {
  const html = readRepoFile('index.html');
  const productionScripts = extractScriptSources(html);
  const appIndex = productionScripts.indexOf('renderer/app.js');

  assert.notEqual(appIndex, -1, 'index.html should load renderer/app.js');

  for (const modulePath of APP_OWNER_MODULES) {
    const productionIndex = productionScripts.indexOf(modulePath);
    assert.notEqual(productionIndex, -1, `index.html should load ${modulePath}`);
    assert.ok(productionIndex < appIndex, `index.html should load ${modulePath} before renderer/app.js`);

    const harnessIndex = SCRIPT_ORDER.indexOf(modulePath);
    assert.notEqual(harnessIndex, -1, `renderer shell harness should load ${modulePath}`);
  }
});

test('surface-effect dependency chains match in production and the renderer harness', () => {
  const productionScripts = extractScriptSources(readRepoFile('index.html'));
  const chains = [
    [
      'renderer/shell/renderer-surface-effect-runtime.js',
      'renderer/shell/renderer-reactive-grid-core.js',
      'renderer/shell/renderer-reactive-grid-utils.js',
    ],
    [
      'renderer/shell/renderer-surface-effect-runtime.js',
      'renderer/shell/renderer-atomic-burst-core.js',
      'renderer/shell/renderer-atomic-burst-utils.js',
    ],
    [
      'renderer/shell/renderer-surface-effect-runtime.js',
      'renderer/shell/renderer-circuit-trace-core.js',
      'renderer/shell/renderer-circuit-trace-board.js',
      'renderer/shell/renderer-circuit-trace-gestures.js',
      'renderer/shell/renderer-circuit-trace-utils.js',
    ],
    [
      'renderer/shell/renderer-surface-effect-runtime.js',
      'renderer/shell/renderer-context-weave-core.js',
      'renderer/shell/renderer-context-weave-utils.js',
    ],
  ];

  for (const scripts of [productionScripts, SCRIPT_ORDER]) {
    for (const chain of chains) {
      const positions = chain.map((modulePath) => scripts.indexOf(modulePath));
      positions.forEach((position, index) => {
        assert.notEqual(position, -1, `${chain[index]} should be present in the surface-effect script chain`);
      });
      for (let index = 1; index < positions.length; index += 1) {
        assert.ok(
          positions[index - 1] < positions[index],
          `${chain[index - 1]} should load before ${chain[index]}`,
        );
      }
    }
  }
});

// Split view W0-1: the lifecycle composition reads window.rendererChatPaneSurfaceControllers
// at factory time. A boot with the tag missing or ordered after the composition still
// SUCCEEDS (the cluster resolves to {} and the chat surface silently dies), so nothing
// downstream fails loudly; the order is pinned here instead, in production and the harness.
test('the chat pane surface cluster loads before the lifecycle composition', () => {
  const productionScripts = extractScriptSources(readRepoFile('index.html'));
  const chain = [
    'renderer/chat/renderer-chat-pane-surface-controllers.js',
    'renderer/app/renderer-app-lifecycle-composition.js',
  ];
  for (const scripts of [productionScripts, SCRIPT_ORDER]) {
    const positions = chain.map((modulePath) => scripts.indexOf(modulePath));
    positions.forEach((position, index) => {
      assert.notEqual(position, -1, `${chain[index]} should be present in the script order`);
    });
    assert.ok(positions[0] < positions[1], `${chain[0]} should load before ${chain[1]}`);
  }
});

test('every name an app composition reads from ctx is a key its caller hands it', () => {
  const { factories, keysFor } = compositionContract();
  assert.equal(factories.size, COMPOSITION_FILES.length, 'one ctx factory per composition file');
  for (const [name, { file, reads }] of factories) {
    assert.ok(reads.size > 0, `${file}: ${name} should read its dependencies from ctx`);
    const keys = keysFor(name);
    const missing = [...reads].filter((read) => !keys.has(read)).sort();
    assert.deepEqual(missing, [],
      `${file}: ${name} reads these from ctx but its caller never hands them over, `
      + `so they are undefined when the UI invokes them: ${missing.join(', ')}`);
  }
});

// escapeSelectorValue is a shared util each composition forwards to its sub-runtimes
// through a wrapper (`escapeSelectorValue: (...a) => escapeSelectorValue(...a)`),
// but it is created late by the controller composition and is not in every
// composition's ctx. A composition that references the wrapper MUST therefore default
// it in-file (`escapeSelectorValue = (v) => ...`), or the wrapper throws ReferenceError
// the moment it runs -- which is exactly how syncThinkingBlockNode crashed when the
// lifecycle composition referenced it without a default.
test('composition self-wrappers for escapeSelectorValue have an in-file default binding', () => {
  const compositionFiles = [
    'renderer/app/renderer-app-controller-composition.js',
    'renderer/app/renderer-app-lifecycle-composition.js',
  ];
  const wrapperRe = /escapeSelectorValue\s*:\s*\(\s*\.\.\.\s*\w+\s*\)\s*=>\s*escapeSelectorValue\s*\(/;
  const inFileDefaultRe = /\bescapeSelectorValue\s*=\s*\(/;

  let checkedAtLeastOne = false;
  for (const file of compositionFiles) {
    const src = readRepoFile(file);
    if (!wrapperRe.test(src)) continue;
    checkedAtLeastOne = true;
    assert.ok(
      inFileDefaultRe.test(src),
      `${file} forwards escapeSelectorValue via a wrapper but provides no `
      + `in-file default binding (escapeSelectorValue = (...) => ...); the wrapper will `
      + `throw ReferenceError when invoked (e.g. from syncThinkingBlockNode)`
    );
  }
  assert.ok(checkedAtLeastOne, 'expected at least one composition to forward escapeSelectorValue');
});

test('every production Scratchpad action factory receives the full Home snapshot', () => {
  // snapshotCount can exceed the factory count: the Daybook controller in the
  // manager also persists live Home-config writes (rail width / rows) and must
  // read the same full snapshot, so it is a second legitimate consumer there.
  const cases = [
    ['renderer/app/renderer-app-controller-composition.js', 'createScratchpadActions?.({', 2, 2, 'getHomeConfig: () => ctx.state.homeConfig'],
    ['renderer/app/renderer-app-shell-bindings-controllers.js', 'createScratchpadActions?.({', 1, 1],
    ['renderer/features/renderer-dashboard-manager.js', 'createScratchpadActions({', 1, 2],
  ];
  for (const [file, callToken, expectedCount, snapshotCount, snapshotToken = 'getHomeConfig: () => state.homeConfig'] of cases) {
    const source = readRepoFile(file);
    assert.equal(source.split(callToken).length - 1, expectedCount, `${file} factory count drifted`);
    assert.equal(
      source.split(snapshotToken).length - 1,
      snapshotCount,
      `${file} must validate every live Scratchpad write against the full Home snapshot`
    );
  }
});

// Split view W0-2/W0-3: two load-order edges that fail SILENTLY if broken, the
// same way the W0-1 cluster above does. The boot seed reads
// window.rendererPaneModel at factory time (a missing module leaves the state
// with no pane layout at all), and the per-pane visibility predicate composes
// window.rendererChatSurfaceLiveUtils, with the stream handler resolving
// window.rendererPaneVisibilityUtils when it builds isVisibleChatSession. Each
// of those reads has a fallback, so a mis-ordered tag boots green and quietly
// runs on the pre-split-view answer; the order is pinned here instead.
test('the pane model loads before the boot seed and the pane visibility predicate before its consumers', () => {
  const productionScripts = extractScriptSources(readRepoFile('index.html'));
  const chains = [
    [
      'renderer/shell/renderer-pane-model.js',
      'renderer/shell/renderer-bootstrap-utils.js',
    ],
    [
      'renderer/chat/renderer-chat-surface-live-utils.js',
      'renderer/chat/renderer-pane-visibility-utils.js',
      'renderer/chat/renderer-stream-handler.js',
    ],
    // The projection cache resolves window.rendererPaneModel at FACTORY time
    // (no lazy retry, no browser require), so a pane-model tag ordered after
    // it would silently collapse the retained set to the current session.
    [
      'renderer/shell/renderer-pane-model.js',
      'renderer/chat/renderer-render-pipeline-projection-cache.js',
    ],
  ];
  for (const scripts of [productionScripts, SCRIPT_ORDER]) {
    for (const chain of chains) {
      const positions = chain.map((modulePath) => scripts.indexOf(modulePath));
      positions.forEach((position, index) => {
        assert.notEqual(position, -1, `${chain[index]} should be present in the script order`);
      });
      for (let index = 1; index < positions.length; index += 1) {
        assert.ok(
          positions[index - 1] < positions[index],
          `${chain[index - 1]} should load before ${chain[index]}`
        );
      }
    }
  }
});

// Split view W0-6: renderer/app.js mints pane 0's render runtime and the shared
// session-cache store by calling window.rendererPaneRuntime at factory time --
// unguarded, the way it calls its other runtime factories. A tag ordered after
// renderer/app.js (or missing) is therefore a HARD boot failure rather than a
// silent degrade, but the edge is pinned here anyway so the ordering is stated
// where the other split-view edges are.
//
// The harness half is presence, not position: renderer/app.js is deliberately
// EXCLUDED from SCRIPT_ORDER (renderer-shell-harness-support.js) because the
// harness runs it separately, after every ordered script. Being in SCRIPT_ORDER
// at all is therefore exactly the guarantee "loads before app.js" -- and the
// exclusion itself is asserted, so if app.js is ever added back this case is
// forced to become positional rather than silently weakening.
test('the pane runtime loads before the app bootstrap that mints pane 0', () => {
  const productionScripts = extractScriptSources(readRepoFile('index.html'));
  const paneRuntimeScript = 'renderer/chat/renderer-pane-runtime.js';

  const paneRuntimeIndex = productionScripts.indexOf(paneRuntimeScript);
  const appIndex = productionScripts.indexOf('renderer/app.js');
  assert.notEqual(paneRuntimeIndex, -1, `index.html should load ${paneRuntimeScript}`);
  assert.notEqual(appIndex, -1, 'index.html should load renderer/app.js');
  assert.ok(paneRuntimeIndex < appIndex, `index.html should load ${paneRuntimeScript} before renderer/app.js`);

  assert.notEqual(
    SCRIPT_ORDER.indexOf(paneRuntimeScript),
    -1,
    `the renderer shell harness should load ${paneRuntimeScript}, or a real boot has no window.rendererPaneRuntime`
  );
  assert.equal(
    SCRIPT_ORDER.indexOf('renderer/app.js'),
    -1,
    'renderer/app.js is excluded from SCRIPT_ORDER and run last by the harness; '
    + 'if that changed, pin the pane runtime BEFORE it positionally here'
  );
});

// The compaction coordinator reads its callbacks lazily as `ctx.NAME?.()`, so a
// name missing from the ctx it is built with is a silent no-op, not a throw:
// that is how a settled /compact left the composer disabled (renderComposerState
// is built inside the composition, never passed in app.js's ctx). Each name it
// reads must be an app.js ctx key or a key of the composition's overlay.
test('every ctx callback the app compaction coordinator reads is wired', () => {
  const coordinatorSource = readRepoFile('renderer/shell/renderer-settings-compaction-section.js');
  const compositionSource = readRepoFile('renderer/app/renderer-app-controller-composition.js');
  const ctxKeys = compositionContract().keysFor('createControllerComposition');

  const body = coordinatorSource.slice(
    coordinatorSource.indexOf('function createAppCompactionCoordinator'),
    coordinatorSource.indexOf('const PROMPT_ADAPTER_ID'),
  );
  const readNames = new Set([...body.matchAll(/\bctx\.(\w+)/g)].map((match) => match[1]));
  assert.ok(readNames.has('renderComposerState') && readNames.has('refreshSessionSummaries'));

  const overlayStart = compositionSource.indexOf('createAppCompactionCoordinator?.(Object.assign(Object.create(ctx), {');
  const overlay = overlayStart >= 0 ? compositionSource.slice(overlayStart, compositionSource.indexOf('}))', overlayStart)) : '';
  const overlayKeys = new Set([...overlay.matchAll(/^\s*(\w+)\s*:/gm)].map((match) => match[1]));

  for (const name of readNames) {
    assert.ok(ctxKeys.has(name) || overlayKeys.has(name),
      `ctx.${name} is read by createAppCompactionCoordinator but is neither an app.js ctx key nor in the composition overlay`);
  }
});
