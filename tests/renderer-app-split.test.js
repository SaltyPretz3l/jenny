const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { SCRIPT_ORDER } = require('./helpers/renderer-shell-harness-support');

const ROOT = path.resolve(__dirname, '..');
const APP_OWNER_MODULES = [
  'renderer/app/renderer-app-comet-runtime.js',
  'renderer/app/renderer-app-controller-composition.js',
  'renderer/app/renderer-app-lifecycle-preferences.js',
  'renderer/app/renderer-app-open-loop-actions.js',
  'renderer/app/renderer-app-shell-bindings.js',
  'renderer/app/renderer-app-surface-effects.js',
];

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// Extract the keys of the ctx object literal renderer/app.js passes to
// createControllerComposition({...}) via a balanced-brace walk. Shared by the
// with(ctx) guard tests below. Returns a Set of shorthand/explicit key names,
// or null if the call site or its balanced braces can't be located.
function extractControllerCompositionCtxKeys(appSource) {
  const callIndex = appSource.indexOf('createControllerComposition({');
  if (callIndex === -1) return null;
  const openBrace = appSource.indexOf('{', callIndex);
  let depth = 0;
  let endBrace = -1;
  for (let i = openBrace; i < appSource.length; i += 1) {
    const ch = appSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { endBrace = i; break; } }
  }
  if (endBrace === -1) return null;
  const ctxKeys = new Set();
  for (const part of appSource.slice(openBrace + 1, endBrace).split(/[,\n]/)) {
    const key = part.trim().split(':')[0].trim();
    if (/^\w+$/.test(key)) ctxKeys.add(key);
  }
  return ctxKeys;
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

// Regression guard for the with(ctx) "missing ctx key" bug class: the controller
// composition runs inside `with (ctx)`, so a deferred wrapper `X: (...a) => X(...a)`
// resolves `X` from the ctx object that renderer/app.js passes to
// createControllerComposition({...}). app.js destructures the reasoning-phase
// expansion callbacks from their controller and the composition forwards them, so
// each one the composition references MUST be a key in that ctx object -- otherwise
// the wrapper throws ReferenceError the moment the UI invokes it. That is exactly
// how the reasoning-phase expand toggle (setReasoningPhaseExpandedPreference)
// silently broke when the AR2 app.js split dropped it from the ctx hand-off.
test('reasoning-phase expansion callbacks the composition forwards are present in the ctx hand-off', () => {
  const compositionSource = readRepoFile('renderer/app/renderer-app-controller-composition.js');
  const appSource = readRepoFile('renderer/app.js');

  const ctxKeys = extractControllerCompositionCtxKeys(appSource);
  assert.ok(ctxKeys, 'app.js should call createControllerComposition({...}) with a balanced ctx object');

  // The reasoning-phase callbacks app.js destructures from the controller (app.js)
  // and forwards via the composition's with(ctx) wrappers.
  const forwardedReasoningCallbacks = [
    'setReasoningPhaseExpandedPreference',
    'syncPersistedReasoningPhaseExpansionState',
  ];
  for (const name of forwardedReasoningCallbacks) {
    assert.ok(
      compositionSource.includes(name),
      `composition should still reference ${name} (update this guard if the wiring moved)`
    );
    assert.ok(
      ctxKeys.has(name),
      `${name} must be passed in the createControllerComposition ctx object; `
      + `without it the with(ctx) wrapper throws ReferenceError when the toggle is clicked`
    );
  }
});

// Broad regression guard for the ENTIRE with(ctx) "missing ctx key" bug class.
// The controller composition runs inside `with (ctx)`, so any deferred self-wrapper
// `NAME: (...a) => NAME(...a)` resolves the bare NAME against the ctx object that
// renderer/app.js passes to createControllerComposition({...}), then lexical scope.
// If NAME is neither a ctx key nor a local declaration inside the composition, the
// wrapper throws ReferenceError the instant the UI invokes it (a click) -- never at
// load. That is exactly how the chat Copy button broke: getCurrentMessageById and
// showCopyFeedback were dropped from the ctx hand-off. The hardcoded guard above
// missed them; this one checks every self-wrapper generically.
test('every controller-composition with(ctx) self-wrapper resolves to a ctx key or a local declaration', () => {
  const compositionSource = readRepoFile('renderer/app/renderer-app-controller-composition.js');
  const appSource = readRepoFile('renderer/app.js');

  // 1) ctx keys app.js hands to createControllerComposition({...}) (balanced braces).
  const ctxKeys = extractControllerCompositionCtxKeys(appSource);
  assert.ok(ctxKeys, 'app.js should call createControllerComposition({...}) with a balanced ctx object');

  // 2) self-wrappers `NAME: (...a) => NAME(...a)` the composition forwards.
  const selfWrappers = new Set();
  const wrapperPattern = /(\w+)\s*:\s*\(\.\.\.a\)\s*=>\s*(\w+)\(\.\.\.a\)/g;
  let wrapperMatch;
  while ((wrapperMatch = wrapperPattern.exec(compositionSource)) !== null) {
    if (wrapperMatch[1] === wrapperMatch[2]) selfWrappers.add(wrapperMatch[1]);
  }
  assert.ok(selfWrappers.size > 50, `should detect the composition self-wrappers, got ${selfWrappers.size}`);

  // 3) names declared locally inside the composition: const/let/function plus every
  //    destructure binding target (so a wrapper backed by a destructured controller
  //    method is correctly treated as in-scope, e.g. renderAll/closeComposerPopover).
  const localNames = new Set();
  let declMatch;
  const constLetPattern = /\b(?:const|let)\s+(\w+)\s*=/g;
  while ((declMatch = constLetPattern.exec(compositionSource)) !== null) localNames.add(declMatch[1]);
  const functionPattern = /\bfunction\s+(\w+)\s*\(/g;
  while ((declMatch = functionPattern.exec(compositionSource)) !== null) localNames.add(declMatch[1]);
  // destructuring blocks: a `{ ... }` whose matching `}` is immediately followed by `=`.
  for (let i = 0; i < compositionSource.length; i += 1) {
    if (compositionSource[i] !== '{') continue;
    let blockDepth = 0;
    let close = -1;
    for (let j = i; j < compositionSource.length; j += 1) {
      const ch = compositionSource[j];
      if (ch === '{') blockDepth += 1;
      else if (ch === '}') { blockDepth -= 1; if (blockDepth === 0) { close = j; break; } }
    }
    if (close === -1) continue;
    if (!/^\s*=/.test(compositionSource.slice(close + 1))) continue;
    const inner = compositionSource.slice(i + 1, close);
    let partDepth = 0;
    let current = '';
    const parts = [];
    for (const ch of inner) {
      if (ch === '{' || ch === '[' || ch === '(') partDepth += 1;
      else if (ch === '}' || ch === ']' || ch === ')') partDepth -= 1;
      if (ch === ',' && partDepth === 0) { parts.push(current); current = ''; } else current += ch;
    }
    if (current.trim()) parts.push(current);
    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (!part) continue;
      const binding = part.includes(':')
        ? part.split(':')[1].trim().split('=')[0].trim()
        : part.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(binding)) localNames.add(binding);
    }
    i = close;
  }

  // 4) every self-wrapper must be resolvable inside with(ctx).
  const unresolved = [...selfWrappers]
    .filter((name) => !ctxKeys.has(name) && !localNames.has(name))
    .sort();
  assert.deepEqual(
    unresolved,
    [],
    'these with(ctx) self-wrappers are neither a createControllerComposition ctx key '
    + 'nor a local declaration, so they throw ReferenceError when the UI invokes them: '
    + unresolved.join(', ')
  );
});

// escapeSelectorValue is a shared util each composition forwards to its sub-runtimes
// through a with(ctx) wrapper (`escapeSelectorValue: (...a) => escapeSelectorValue(...a)`),
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
      `${file} forwards escapeSelectorValue via a with(ctx) wrapper but provides no `
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
    ['renderer/app/renderer-app-controller-composition.js', 'createScratchpadActions?.({', 2, 2],
    ['renderer/app/renderer-app-shell-bindings-controllers.js', 'createScratchpadActions?.({', 1, 1],
    ['renderer/features/renderer-dashboard-manager.js', 'createScratchpadActions({', 1, 2],
  ];
  for (const [file, callToken, expectedCount, snapshotCount] of cases) {
    const source = readRepoFile(file);
    assert.equal(source.split(callToken).length - 1, expectedCount, `${file} factory count drifted`);
    assert.equal(
      source.split('getHomeConfig: () => state.homeConfig').length - 1,
      snapshotCount,
      `${file} must validate every live Scratchpad write against the full Home snapshot`
    );
  }
});
