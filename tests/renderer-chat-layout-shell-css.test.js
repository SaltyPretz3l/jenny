const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// CSS-contract coverage extracted from renderer-chat-layout-shell.test.js to
// keep that file under the repo line ceiling. Focused file reads plus isolated
// CSS cascade probes; no renderer-app harness.

function readCssRuleBlock(css, selector) {
  const escapedSelector = String(selector).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  assert.ok(match, `expected ${selector} CSS rule`);
  return match[1];
}

function readImportedCssSurface(rootDir, importPrefix) {
  const stylesCss = fs.readFileSync(path.join(rootDir, 'styles.css'), 'utf8');
  return stylesCss
    .split(/\r?\n/)
    .map((line) => line.match(/url\("([^"]+)"\)/)?.[1])
    .filter((importPath) => importPath && importPath.startsWith(importPrefix))
    .map((importPath) => fs.readFileSync(path.join(rootDir, importPath.slice(2)), 'utf8'))
    .join('\n');
}


test('surface-effect styles keep splash layering stable and composer-accessible', () => {
  const rootDir = path.resolve(__dirname, '..');
  const foundationCss = fs.readFileSync(
    path.join(rootDir, 'styles', 'foundation.css'),
    'utf8'
  );
  const viewsHomeArtifactsCss = readImportedCssSurface(rootDir, './styles/views-');
  const chatThreadCss = readImportedCssSurface(rootDir, './styles/chat-thread');
  const chatComposerCss = fs.readFileSync(
    path.join(rootDir, 'styles', 'chat-composer.css'),
    'utf8'
  );
  const viewportLayoutUtilsSource = fs.readFileSync(
    path.join(rootDir, 'renderer/shell/renderer-viewport-layout-utils.js'),
    'utf8'
  );
  const contextPanelCss = fs.readFileSync(
    path.join(rootDir, 'styles', 'context-panel.css'),
    'utf8'
  );
  const timelineOrientationCss = fs.readFileSync(
    path.join(rootDir, 'styles', 'chat-timeline-orientation-v2.css'),
    'utf8'
  );
  const chatToolsCss = fs.readFileSync(
    path.join(rootDir, 'styles', 'chat-tools.css'),
    'utf8'
  );
  // Quiet-timeline overhaul: reasoning-row styling lives in the unified
  // machinery grammar file.
  const reasoningV2Css = fs.readFileSync(
    path.join(rootDir, 'styles', 'chat-machinery.css'),
    'utf8'
  );
  const paletteWoollyCss = fs.readFileSync(
    path.join(rootDir, 'styles', 'palette-woolly.css'),
    'utf8'
  );
  const chatMediaQueriesCss = fs.readFileSync(
    path.join(rootDir, 'styles', 'chat-media-queries.css'),
    'utf8'
  );
  const chatSpriteV2Css = fs.readFileSync(
    path.join(rootDir, 'styles', 'chat-sprite-v2.css'),
    'utf8'
  );
  const chatThreadPresetsCss = fs.readFileSync(
    path.join(rootDir, 'styles', 'chat-thread-presets.css'),
    'utf8'
  );
  const settingsResponsiveCss = fs.readFileSync(
    path.join(rootDir, 'styles', 'settings-responsive.css'),
    'utf8'
  );
  const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const surfaceEffectsRule = readCssRuleBlock(chatThreadCss, '.chat-surface-effects');
  const gutterRule = readCssRuleBlock(chatThreadCss, '.chat-surface-effect-gutter');
  const threadColumnRule = readCssRuleBlock(chatThreadCss, '.chat-thread-column');

  assert.match(
    foundationCss,
    /--chat-user-bubble-max-width:\s*clamp\(410px,\s*34vw,\s*560px\);/,
    'foundation should define the shared chat user bubble width token'
  );

  assert.match(
    viewsHomeArtifactsCss,
    /\[data-widget-modifier~="reactive-grid"\]\s*>\s*:not\(\.widget-reactive-grid-canvas\),[\s\S]*?\{[\s\S]*?z-index:\s*1;/,
    'reactive-grid should keep non-canvas children above its effect canvas'
  );
  assert.match(
    viewsHomeArtifactsCss,
    /\[data-widget-modifier~="playlist-scroll"\]\s*>\s*:not\(\.widget-playlist-scroll-canvas\),[\s\S]*?\{[\s\S]*?z-index:\s*1;/,
    'playlist-scroll should keep non-canvas children above its effect canvas'
  );
  assert.match(
    chatComposerCss,
    /\.composer-wrap\s*\{[\s\S]*?z-index:\s*var\(--z-raised\);/,
    'surface effects should preserve composer-wrap layering'
  );
  assert.match(
    surfaceEffectsRule,
    /grid-column:\s*1;[\s\S]*?grid-row:\s*1\s*\/\s*-1;[\s\S]*?position:\s*relative;[\s\S]*?z-index:\s*0;/,
    'chat surface-effects layer should remain a full-bleed grid item behind the thread'
  );
  assert.match(
    surfaceEffectsRule,
    /overflow:\s*hidden;[\s\S]*?pointer-events:\s*none;[\s\S]*?isolation:\s*isolate;/,
    'chat surface-effects layer should stay clipped, pass-through, and isolated'
  );
  assert.doesNotMatch(
    surfaceEffectsRule,
    /mask-image:\s*radial-gradient\(/,
    'chat surface-effects layer should not stack a legacy radial mask over manager-owned paint occlusions'
  );
  assert.match(
    gutterRule,
    /position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?overflow:\s*hidden;[\s\S]*?pointer-events:\s*none;/,
    'chat gutter host should span the full-bleed effect surface without intercepting input'
  );
  assert.match(
    threadColumnRule,
    /isolation:\s*isolate;/,
    'the thread column should isolate its non-interactive scrim below transcript content'
  );
  // F1 (2026-08-21): the right gutter was `display: none` yet still published
  // as a host, so every effect painted a second invisible canvas each frame.
  // Both per-side modifier classes went with it -- one full-bleed host remains.
  assert.doesNotMatch(
    chatThreadCss,
    /\.chat-surface-effect-gutter-(left|right)/,
    'neither per-side gutter modifier should survive the full-bleed single-host contract'
  );
  assert.doesNotMatch(
    indexHtml,
    /chat-surface-effect-gutter-(left|right)|id="chatSurfaceEffectRight"/,
    'index.html should publish exactly one unqualified chat effect gutter'
  );
  assert.equal(
    (indexHtml.match(/class="chat-surface-effect-gutter"/g) || []).length,
    1,
    'index.html should carry exactly one chat effect gutter element'
  );
  assert.match(
    viewportLayoutUtilsSource,
    /chatSurfaceEffects\.getBoundingClientRect\(\)[\s\S]*?chatThreadColumn\.getBoundingClientRect\(\)[\s\S]*?setStyleProperty\(chatSurfaceEffects,\s*'--chat-surface-effect-left-width',[\s\S]*?setStyleProperty\(chatSurfaceEffects,\s*'--chat-surface-effect-right-width',/,
    'chat gutter widths should be measured from live layout and written back as runtime-owned CSS variables'
  );
  assert.doesNotMatch(
    viewportLayoutUtilsSource,
    /layerRect\.right\s*-\s*threadRect\.right\s*-\s*scrollbarClearance/,
    'viewport measurement should not subtract scrollbar clearance after the parent layer is already cleared'
  );
  assert.match(
    chatThreadCss,
    /\.chat-thread-stage\s*\{[\s\S]*?position:\s*relative;[\s\S]*?z-index:\s*var\(--z-content\);/,
    'surface effects should preserve chat-thread-stage layering'
  );
  assert.match(
    chatThreadCss,
    /\.chat-bubble\s*\{[\s\S]*?font-size:\s*var\(--tl-font-prose\);/,
    'chat bubble body text should use the timeline prose token (zoom-scaled)'
  );
  assert.match(
    reasoningV2Css,
    /\.reasoning-row-panel-body\s*\{[\s\S]*?font-size:\s*var\(--tl-font-detail\);/,
    'reasoning transcript text should use the timeline detail token (zoom-scaled)'
  );
  assert.match(
    chatToolsCss,
    /\.interactive-recap-label\s*\{[\s\S]*?font-size:\s*calc\(13px\s*\*\s*var\(--chat-zoom-factor,\s*1\)\);/,
    'tool and recap transcript text should scale with chat zoom'
  );
  assert.match(
    chatThreadCss,
    /\.hero-stage\s*\{[\s\S]*?position:\s*relative;[\s\S]*?z-index:\s*calc\(var\(--z-content\)\s*\+\s*2\);/,
    'hero-stage should establish its own stacking context above the thread stage'
  );
  assert.match(
    viewsHomeArtifactsCss,
    /\.chat-surface-effect-gutter\[data-widget-modifier~="reactive-grid"\]\s*\{[\s\S]*?--reactive-grid-cell-size:\s*26px;/,
    'chat gutter hosts should keep the scoped reactive-grid tuning used by the side effects'
  );
  assert.match(
    viewsHomeArtifactsCss,
    /\.chat-surface-effect-gutter\[data-widget-modifier~="reactive-grid"\],[\s\S]*?\{[\s\S]*?position:\s*absolute;/,
    'reactive-grid gutter hosts should preserve absolute positioning instead of falling back to shared relative widget layout'
  );
  assert.match(
    viewsHomeArtifactsCss,
    /\.chat-surface-effect-gutter\[data-widget-modifier~="playlist-scroll"\],[\s\S]*?\{[\s\S]*?position:\s*absolute;/,
    'playlist-scroll gutter hosts should preserve absolute positioning instead of falling back to shared relative widget layout'
  );
  assert.match(
    viewsHomeArtifactsCss,
    /\.chat-surface-effect-gutter\[data-widget-modifier~="context-weave"\]\s*\{[\s\S]*?position:\s*absolute;/,
    'context-weave gutter hosts should preserve absolute positioning instead of falling back to shared relative widget layout'
  );
  assert.doesNotMatch(
    viewsHomeArtifactsCss,
    /doodle-field/,
    'the retired doodle-field effect should leave no CSS behind'
  );
  assert.match(
    chatThreadCss,
    /\.chat-view\.chat-empty\s+\.hero-stage\s*\{[\s\S]*?pointer-events:\s*none;/,
    'empty-chat hero-stage should stay pass-through so it cannot block composer input'
  );
  assert.match(
    chatComposerCss,
    /\.chat-view\.chat-empty\s+\.hero-stack\s*\{[\s\S]*?pointer-events:\s*none;/,
    'empty-chat hero-stack should stay pass-through so it cannot block composer input'
  );
  assert.match(
    chatComposerCss,
    /\.chat-view\.chat-empty\s+\.composer-wrap\s*\{[\s\S]*?transform:\s*none;/,
    'empty-chat composer-wrap should default to a stable resting position'
  );
  assert.match(
    chatComposerCss,
    /\.chat-view\.chat-empty\[data-send-lifecycle="idle"\]\s+\.composer-wrap\s*\{[\s\S]*?translateY\(calc\(-1 \* var\(--empty-composer-lift\)\)\);/,
    'empty-chat composer lift should only apply while the chat surface is idle'
  );
  assert.match(
    chatComposerCss,
    /\.composer\[data-send-lifecycle="preflight"\],\s*[\s\S]*?\.composer\[data-send-lifecycle="streaming"\],\s*[\s\S]*?\.composer\[data-send-lifecycle="settling"\]\s*\{[\s\S]*?box-shadow:/,
    'composer should define calmer chrome for non-idle send lifecycle states'
  );
  assert.match(
    chatComposerCss,
    /\.composer-holo\s*\{[\s\S]*?overflow:\s*clip;/,
    'composer holo canvas should clip overflow to stay within element bounds'
  );
  assert.match(
    chatComposerCss,
    /\.composer-holo\s*\{[\s\S]*?overflow-clip-margin:\s*content-box;/,
    'composer holo canvas should preserve the content-box clip margin'
  );
  assert.doesNotMatch(
    chatComposerCss,
    /\.composer-holo\s*\{[\s\S]*?overflow:\s*visible;/,
    'composer holo canvas should not restore visible overflow'
  );
  assert.match(
    chatComposerCss,
    /\.composer\s*\{[\s\S]*?--composer-secondary-control-size:\s*calc\(32px \* var\(--chat-zoom-factor,\s*1\)\);[\s\S]*?--composer-secondary-control-bg:/,
    'composer should expose shared secondary-control tokens for decluttered chrome'
  );
  assert.match(
    chatComposerCss,
    /\.composer-icon-button,\s*[\s\S]*?\.composer-gear,\s*[\s\S]*?\.composer-jump-button\s*\{[\s\S]*?width:\s*var\(--composer-secondary-control-size\);[\s\S]*?height:\s*var\(--composer-secondary-control-size\);/,
    'secondary composer controls should share one sizing and chrome contract'
  );
  assert.match(
    reasoningV2Css,
    /\.tool-call-main\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*baseline;/,
    'tool headers should keep the tool name, summary, and status in one compact wrapping row'
  );
  assert.match(
    chatToolsCss,
    /\.tool-approval-block\s*\{[\s\S]*?--tool-approval-button-min-height:\s*calc\(36px\s*\*\s*var\(--chat-zoom-factor,\s*1\)\);[\s\S]*?--tool-approval-button-transition:/,
    'tool approval blocks should centralize shared approve/deny button sizing and motion'
  );
  assert.match(
    chatToolsCss,
    /\.tool-approve-btn,\s*[\s\S]*?\.tool-deny-btn\s*\{[\s\S]*?min-height:\s*var\(--tool-approval-button-min-height\);[\s\S]*?border:\s*1px solid var\(--tool-approval-button-border\);[\s\S]*?transition:\s*var\(--tool-approval-button-transition\);/,
    'tool approve and deny buttons should share one pill button contract while preserving semantic colors'
  );
  assert.match(
    contextPanelCss,
    /\.context-section-disclosure\s*\{[\s\S]*?min-height:\s*28px;/,
    'context logs should expose a proper disclosure control'
  );
  assert.match(
    chatComposerCss,
    /\.chat-view\.chat-empty\s+\.prompt-grid\s*\{[\s\S]*?display:\s*flex;[\s\S]*?pointer-events:\s*auto;/,
    'empty-chat prompt grid should be visible and interactive above the composer'
  );
  assert.match(
    chatComposerCss,
    /\.chat-view\.chat-active\s+\.prompt-grid\s*\{[\s\S]*?display:\s*none;/,
    'active-thread prompt grid should hide once chat enters thread mode'
  );
  assert.match(
    chatComposerCss,
    /\.chat-view\s+\.hero-stage\s*\{[\s\S]*?grid-row:\s*1;/,
    'hero-stage should begin in row 1 of the two-row chat grid'
  );
  assert.match(
    chatComposerCss,
    /\.chat-view\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto;/,
    'chat view should reserve rows only for content and composer'
  );
  assert.match(
    chatComposerCss,
    /\.composer-wrap\s*\{[\s\S]*?grid-column:\s*1;[\s\S]*?grid-row:\s*2;/,
    'composer should occupy row 2 of the two-row chat grid'
  );
  assert.match(
    contextPanelCss,
    /\.chat-context-panel\s*\{[\s\S]*?grid-row:\s*1\s*\/\s*-1;/,
    'context panel should align to the top edge and span both chat rows'
  );
  assert.match(
    contextPanelCss,
    /\.artifact-review-resizer\s*\{[\s\S]*?grid-row:\s*1\s*\/\s*-1;/,
    'artifact resizer should align to the top edge and span both chat rows'
  );
  assert.match(
    contextPanelCss,
    /\.artifact-review-panel\s*\{[\s\S]*?grid-row:\s*1\s*\/\s*-1;/,
    'artifact panel should align to the top edge and span both chat rows'
  );
  assert.match(
    timelineOrientationCss,
    /\.chat-timeline-utility-cluster\s*\{[\s\S]*?grid-row:\s*1;[\s\S]*?align-self:\s*start;[\s\S]*?justify-self:\s*end;/,
    'timeline utilities should overlay the upper-right content gutter without creating a row'
  );
  const timelineUtilityButtonRule = readCssRuleBlock(
    timelineOrientationCss,
    '.chat-timeline-utility-button'
  );
  assert.match(
    timelineUtilityButtonRule,
    /width:\s*28px;[\s\S]*?height:\s*28px;[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*var\(--toprail-item-radius\);[\s\S]*?background:\s*transparent;[\s\S]*?color:\s*var\(--toprail-item-color\);[\s\S]*?box-shadow:\s*none;/,
    'collapse/expand should use the flat 28px top-rail utility contract'
  );
  assert.doesNotMatch(
    timelineUtilityButtonRule,
    /transform:/,
    'collapse/expand should not carry raised motion at rest'
  );
  assert.match(
    readCssRuleBlock(timelineOrientationCss, '.chat-timeline-utility-button[hidden]'),
    /display:\s*none;/,
    'chat-only utility buttons should honor renderer visibility state after leaving the top rail'
  );
  assert.match(
    readCssRuleBlock(timelineOrientationCss, '.chat-timeline-utility-button[aria-pressed="true"]'),
    /color:\s*var\(--toprail-item-active-color\);/,
    'artifact utility should retain the top-rail pressed-state cue'
  );
  assert.match(
    readCssRuleBlock(timelineOrientationCss, '.chat-timeline-utility-button:hover'),
    /color:\s*var\(--toprail-item-hover-color\);[\s\S]*?background:\s*var\(--toprail-item-hover-bg\);[\s\S]*?box-shadow:\s*none;[\s\S]*?transform:\s*none;/,
    'collapse/expand hover should match the flat top-rail hover state'
  );
  assert.match(
    readCssRuleBlock(timelineOrientationCss, '.chat-timeline-utility-button:focus-visible'),
    /outline:\s*2px solid var\(--focus-outline\);[\s\S]*?outline-offset:\s*2px;/,
    'collapse/expand should retain a visible keyboard focus ring'
  );
  assert.match(
    readCssRuleBlock(timelineOrientationCss, '.chat-timeline-utility-button svg'),
    /width:\s*16px;[\s\S]*?height:\s*16px;[\s\S]*?stroke:\s*currentColor;[\s\S]*?stroke-width:\s*1\.4;/,
    'collapse/expand should use the same 16px, 1.4px-stroke icon contract as top-rail controls'
  );
  const wayfinderButtonSelector = '.chat-timeline-utility-cluster .chat-timeline-wayfinder-host .chat-wayfinder-button';
  assert.match(
    readCssRuleBlock(timelineOrientationCss, wayfinderButtonSelector),
    /width:\s*28px;[\s\S]*?height:\s*28px;[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*var\(--toprail-item-radius\);[\s\S]*?background:\s*transparent;[\s\S]*?color:\s*var\(--toprail-item-color\);[\s\S]*?box-shadow:\s*none;/,
    'wayfinder should share the flat 28px top-rail utility contract'
  );
  assert.match(
    readCssRuleBlock(timelineOrientationCss, `${wayfinderButtonSelector}:hover:not(:disabled)`),
    /border:\s*0;[\s\S]*?background:\s*var\(--toprail-item-hover-bg\);[\s\S]*?color:\s*var\(--toprail-item-hover-color\);[\s\S]*?box-shadow:\s*none;[\s\S]*?transform:\s*none;/,
    'wayfinder hover should remain flat and neutral'
  );
  assert.match(
    readCssRuleBlock(timelineOrientationCss, `${wayfinderButtonSelector}:focus-visible`),
    /outline:\s*2px solid var\(--focus-outline\);[\s\S]*?outline-offset:\s*2px;/,
    'wayfinder should retain a visible keyboard focus ring'
  );
  assert.match(
    readCssRuleBlock(
      timelineOrientationCss,
      '.chat-timeline-utility-cluster .chat-timeline-wayfinder-host .chat-wayfinder-icon'
    ),
    /width:\s*16px;[\s\S]*?height:\s*16px;[\s\S]*?background:\s*transparent;[\s\S]*?stroke:\s*currentColor;[\s\S]*?stroke-width:\s*1\.4;/,
    'wayfinder should use a neutral 16px line icon without a circular badge'
  );
  assert.match(
    readCssRuleBlock(
      timelineOrientationCss,
      '.chat-timeline-utility-cluster .chat-wayfinder-button[data-chat-wayfinder-state="prompt"] .chat-wayfinder-icon'
    ),
    /transform:\s*rotate\(180deg\);/,
    'prompt state should rotate the shared jump arrow upward'
  );
  assert.match(
    timelineOrientationCss,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.chat-timeline-utility-button,[\s\S]*?\.chat-timeline-utility-cluster \.chat-timeline-wayfinder-host \.chat-wayfinder-button\s*\{[\s\S]*?transition:\s*none;/,
    'timeline utilities should suppress their color transitions under reduced motion'
  );
  assert.match(
    timelineOrientationCss,
    /@media \(max-width:\s*719px\)\s*\{[\s\S]*?\.chat-timeline-utility-cluster #timelineCollapseExpandToggle\s*\{[\s\S]*?display:\s*none;/,
    'narrow layouts should continue suppressing the lower-value collapse/expand control'
  );
  assert.match(
    timelineOrientationCss,
    /\.chat-view\.chat-empty #timelineCollapseExpandToggle,[\s\S]*?\.chat-view\.chat-empty \.chat-timeline-wayfinder-host\s*\{[\s\S]*?display:\s*none;/,
    'empty chats should hide transcript-only utilities without hiding the artifact viewer toggle'
  );
  assert.doesNotMatch(
    timelineOrientationCss,
    /\.chat-view\.chat-empty \.chat-timeline-utility-cluster\s*\{[\s\S]*?display:\s*none;/,
    'artifact viewer toggle should remain reachable in an empty Chat view'
  );
  assert.match(
    chatComposerCss,
    /\.chat-view\.artifact-review-open\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--artifact-review-resizer-width,\s*10px\)\s+auto;/,
    'split artifact review should expand the chat grid with a resizer column and right rail'
  );
  assert.match(
    chatThreadCss,
    /\.chat-thread-stage\s*\{[\s\S]*?position:\s*relative;[\s\S]*?z-index:\s*var\(--z-content\);/,
    'chat-thread-stage should remain below the splash hero'
  );
  assert.match(
    chatThreadCss,
    /\.chat-thread-column\s*\{[\s\S]*?padding:\s*var\(--chat-thread-offset\)\s+0\s+var\(--composer-safe-offset\)\s+var\(--chat-sprite-rail-offset\);/,
    'chat-thread-column should reserve a dedicated sprite gutter'
  );
  assert.match(
    chatThreadCss,
    /\.chat-sprite-layer\s*\{[\s\S]*?width:\s*var\(--chat-sprite-rail-offset\);/,
    'sprite layer should use a real gutter width instead of a zero-width overflow hack'
  );
  assert.match(
    chatThreadCss,
    /\.chat-thread-node-row\s*\{[\s\S]*?grid-template-columns:\s*var\(--thread-dot-hit-size\)\s+minmax\(0,\s*1fr\);[\s\S]*?align-items:\s*center;/,
    'thread rows should dedicate the first grid column to an accessible dot rail hit area'
  );
  assert.match(
    chatThreadCss,
    /\.chat-thread-toggle,\s*[\s\S]*?\.chat-thread-toggle-spacer\s*\{[\s\S]*?width:\s*var\(--thread-dot-hit-size\);[\s\S]*?height:\s*var\(--thread-dot-hit-size\);/,
    'thread dots should preserve a larger click target than the visible dot size'
  );
  assert.match(
    chatThreadCss,
    /\.chat-thread-toggle\[aria-expanded="true"\]::before\s*\{[\s\S]*?box-shadow:/,
    'interactive expanded dots should remain visually distinct from spacer dots'
  );
  assert.match(
    chatThreadCss,
    /\.chat-thread-children::before\s*\{[\s\S]*?left:\s*calc\(var\(--thread-dot-hit-size\)\s*\+\s*var\(--space-5\)\s*\+\s*\(var\(--thread-dot-hit-size\)\s*\/\s*2\)\);/,
    'thread rails should align with the center of the nested dot lane'
  );
  assert.doesNotMatch(
    chatThreadCss,
    /\.chat-thread-node-nested\s*>\s*\.chat-thread-node-row::before\s*\{/,
    'nested thread elbows should be removed once the rail terminates at dots'
  );
  // scroll-W4a retired the pin overlay DOM (renderless observer only), so the
  // .chat-pin-bubble rules are gone from chat-thread.css and no longer pinned.
  assert.doesNotMatch(
    chatThreadCss,
    /\.chat-pin-(overlay|bubble)/,
    'the retired pin overlay must not leave rules behind in chat-thread.css'
  );
  assert.match(
    chatThreadCss,
    /\.chat-entry\.user\s*\{[\s\S]*?max-width:\s*min\(100%,\s*var\(--chat-user-bubble-max-width\)\);/,
    'user entries should use the shared user bubble width token'
  );
  // scroll-W4a removed PIN_FADE_TRIGGER_SELECTOR (the overlay fade machinery),
  // so data-pin-fade-trigger has no consumer. The markup paths still emit it as
  // deliberate residue (outside the W4a fence), but it is no longer pinned here
  // — a future markup sweep may drop the attribute freely.
  assert.match(
    chatThreadCss,
    /\.chat-entry\.assistant\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);[\s\S]*?gap:\s*0;/,
    'assistant entries should collapse to a single content column on the main timeline'
  );
  // scroll-W4c (owner-approved) removed the legacy per-message avatar outright —
  // emission and every hiding rule are gone; the sprite layer owns assistant identity.
  assert.doesNotMatch(
    chatThreadCss,
    /\.chat-avatar/,
    'the removed per-message avatar must not leave rules behind in chat-thread.css'
  );
  assert.doesNotMatch(
    chatMediaQueriesCss,
    /\.chat-avatar/,
    'the removed per-message avatar must not leave rules behind in chat-media-queries.css'
  );
  assert.match(
    chatMediaQueriesCss,
    /@media \(max-width:\s*700px\)\s*\{[\s\S]*?--chat-sprite-rail-offset:\s*clamp\(24px,\s*7vw,\s*32px\);[\s\S]*?--chat-user-bubble-max-width:\s*100%;[\s\S]*?\.chat-view \.chat-entry\.assistant\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);[\s\S]*?gap:\s*0;[\s\S]*?\.chat-view \.chat-thread-children\s*\{[\s\S]*?padding-left:\s*calc\(var\(--thread-dot-hit-size\)\s*\+\s*var\(--space-4\)\);[\s\S]*?\.chat-view > \.chat-context-panel\s*\{[\s\S]*?display:\s*none;/,
    '700px breakpoint should keep the sprite gutter proportional, preserve the larger dot hit area, and hide the context panel'
  );
  assert.match(
    chatMediaQueriesCss,
    /@media \(max-width:\s*480px\)\s*\{[\s\S]*?--chat-sprite-rail-offset:\s*0px;[\s\S]*?\.chat-sprite-layer\s*\{[\s\S]*?display:\s*none;/,
    'phone layouts should hide the sprite and reclaim the rail together'
  );
  assert.doesNotMatch(
    settingsResponsiveCss,
    /@media \(max-width:\s*1180px\)[\s\S]*?\.chat-sprite-layer\s*\{[\s\S]*?display:\s*none;/,
    'settings responsiveness must not hide the timeline sprite on laptop widths'
  );
  assert.doesNotMatch(
    readCssRuleBlock(chatThreadCss, '.chat-assistant-sprite'),
    /will-change:/,
    'the passive sprite must not retain compositor promotion'
  );
  assert.match(
    readCssRuleBlock(chatThreadCss, '.chat-assistant-sprite.is-streaming'),
    /will-change:\s*transform;/,
    'only the live sprite should promote its transform'
  );
  assert.doesNotMatch(
    readCssRuleBlock(chatThreadCss, '.chat-assistant-sprite.is-streaming'),
    /transition:/,
    'the live state should inherit the base transform transition instead of replacing it'
  );
  assert.match(
    chatSpriteV2Css,
    /\[data-sprite-state="complete"\][\s\S]*?\[data-sprite-state="error"\][\s\S]*?var\(--state-danger\)[\s\S]*?\[data-sprite-state="cancelled"\][\s\S]*?var\(--state-warning\)/,
    'complete, error, and cancelled sprite states should have restrained token-based treatments'
  );
  assert.doesNotMatch(
    chatThreadPresetsCss,
    /data-sprite-holo="on"\]\s+\.chat-assistant-sprite::(?:before|after)/,
    'the enabled holo preset must not suppress passive semantic sprite chrome'
  );
  assert.match(
    chatThreadPresetsCss,
    /data-sprite-holo="on"\]\s+\.chat-assistant-sprite\.is-streaming::before[\s\S]*?\.chat-assistant-sprite\.is-streaming::after[\s\S]*?display:\s*none;/,
    'the canvas should replace CSS rings only while the sprite is live'
  );
  assert.match(
    chatSpriteV2Css,
    /data-sprite-holo="off"\][\s\S]*?\.chat-assistant-sprite\.is-streaming::after[\s\S]*?will-change:\s*auto;[\s\S]*?data-sprite-holo="off"\][\s\S]*?\.chat-assistant-sprite\.is-streaming::after[\s\S]*?animation:\s*none;/,
    'holo-off live sprites should own neither invisible CSS animation nor compositor promotion'
  );
  assert.match(
    chatMediaQueriesCss,
    /\.chat-view > \.artifact-review-resizer\s*\{[\s\S]*?display:\s*none;/,
    '700px breakpoint should hide the artifact review resizer (no third grid column to resize)'
  );
  // UIUX-004: the opened artifact review must stay reachable at narrow
  // widths — it becomes a right-edge fixed overlay (its own Collapse /
  // Full View header controls are the route back) instead of display: none.
  assert.match(
    chatMediaQueriesCss,
    /@media \(max-width:\s*700px\)\s*\{[\s\S]*?\.chat-view > \.artifact-review-panel\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*var\(--z-dock\);/,
    '700px breakpoint should present the opened artifact review as a fixed overlay, not hide it'
  );
  assert.ok(
    !/@media \(max-width:\s*700px\)\s*\{[\s\S]{0,6000}?\.chat-view > \.artifact-review-panel[^{]*\{[^}]*display:\s*none;/.test(chatMediaQueriesCss),
    '700px breakpoint must not display:none the artifact review panel (UIUX-004 route to hidden panels)'
  );
  // Ultra-wide widens the COMPOSER only: 8df910a0 deliberately dropped
  // --content-column-width from this block so the reading measure stays at its
  // 760px foundation value, and paired that with an explicit guard in
  // tests/markdown-css-contract.test.js ('the content column stays at 760px').
  // Do not reinstate the 920px content column here without retiring that guard.
  assert.match(
    chatMediaQueriesCss,
    /@media \(min-width:\s*2000px\)\s*\{[\s\S]*?--composer-width:\s*min\(920px,[\s\S]*?--context-panel-width:\s*360px;[\s\S]*?\.chat-view \.tool-call-block\s*\{[\s\S]*?width:\s*100%;/,
    '2000px breakpoint should widen the composer and supporting blocks moderately'
  );
  assert.match(
    reasoningV2Css,
    /\.reasoning-row-stack\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;/,
    'reasoning row stack should fill the assistant content lane instead of using a standalone capped width'
  );
  assert.match(
    reasoningV2Css,
    /\.reasoning-row-block\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;/,
    'reasoning row block should render as an inset assistant aside filling the content lane'
  );
  // Quiet-timeline overhaul: the always-on accent pseudo-rail was retired —
  // machinery rows rest transparent; the leading status dot carries state and
  // the expanded panel carries a hairline rule instead.
  assert.match(
    reasoningV2Css,
    /\.reasoning-row-block::before\s*\{\s*content:\s*none;/,
    'the legacy reasoning accent pseudo-rail should stay retired'
  );
  // Quiet-timeline contract: CSS is the sole metric owner so zoom cannot be
  // shadowed by stale inline appearance values.
  assert.match(
    chatThreadCss,
    /--thread-rail-opacity:\s*0\.35;/,
    'default thread rails follow the quiet contract opacity'
  );
  assert.match(
    chatThreadCss,
    /--thread-dot-size:\s*calc\(5px \* var\(--chat-zoom-factor, 1\)\);/,
    'default thread dots follow the quiet contract size'
  );
  assert.match(
    chatThreadCss,
    /:root\[data-thread-style="subtle"\][\s\S]*?--thread-dot-hit-size:\s*max\(24px,\s*calc\(24px \* var\(--chat-zoom-factor, 1\)\)\);/,
    'subtle thread hit targets should never shrink below 24px'
  );
  assert.match(
    chatThreadCss,
    /:root\[data-thread-style="bold-graph"\][\s\S]*?--thread-dot-hit-size:\s*max\(28px,\s*calc\(28px \* var\(--chat-zoom-factor, 1\)\)\);[\s\S]*?--thread-rail-opacity:\s*0\.74;/,
    'bold graph should preserve its larger accessible target and intended rail contrast'
  );
  assert.match(
    chatThreadCss,
    /\.chat-thread-node-nested \.chat-thread-node-article \.chat-row \.chat-row-node-dot\s*\{[\s\S]*?opacity:\s*0\.9;/,
    'row dots should be strong enough to read against the warm timeline background'
  );
  assert.match(
    reasoningV2Css,
    /\.reasoning-row-header,[\s\S]*?\{[\s\S]*?width:\s*100%;/,
    'reasoning row headers should fill available width as one-liner rows'
  );
  assert.match(
    reasoningV2Css,
    /\.tool-call-summary[\s\S]*?\{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/,
    'tool summaries should truncate on the one-liner row'
  );
});

test('expanded tool details use flat indentation, bounded clamps, and no nested panel chrome', () => {
  const rootDir = path.resolve(__dirname, '..');
  const tokens = fs.readFileSync(path.join(rootDir, 'styles', 'chat-timeline-tokens.css'), 'utf8');
  const detailCss = fs.readFileSync(path.join(rootDir, 'styles', 'chat-tool-block-v2.css'), 'utf8');
  const toolsCss = fs.readFileSync(path.join(rootDir, 'styles', 'chat-tools.css'), 'utf8');
  const machineryCss = fs.readFileSync(path.join(rootDir, 'styles', 'chat-machinery.css'), 'utf8');

  assert.match(tokens, /--tl-detail-indent:\s*22px/);
  assert.match(tokens, /--tl-detail-clamp-lines:\s*14/);
  assert.match(tokens, /#ideChatDock[\s\S]*--tl-detail-indent:\s*18px[\s\S]*--tl-detail-clamp-lines:\s*10/);
  assert.match(readCssRuleBlock(detailCss, '.tool-detail-body'), /margin-left:\s*var\(--tl-detail-indent\)/);
  const clampedRule = readCssRuleBlock(
    detailCss,
    '.tool-call-section [data-detail-clamped="true"]'
  );
  assert.match(clampedRule, /max-height:\s*calc\(var\(--tl-detail-clamp-lines\)/);
  assert.match(clampedRule, /overflow:\s*hidden/);
  assert.match(
    readCssRuleBlock(detailCss, '.tool-call-section [data-detail-clamped="false"]'),
    /max-height:\s*none[\s\S]*overflow:\s*visible/
  );
  assert.doesNotMatch(`${detailCss}\n${toolsCss}\n${machineryCss}`, /\.tool-io-panel\b/);
  const inputRule = readCssRuleBlock(machineryCss, '.tool-call-input,\n.tool-call-output');
  assert.match(inputRule, /background:\s*none/);
  assert.match(inputRule, /border:\s*none/);
  assert.match(inputRule, /overflow:\s*visible/);
  assert.doesNotMatch(inputRule, /overflow-y:\s*auto/);

  const dom = new JSDOM(
    `<style>${toolsCss}\n${detailCss}\n${machineryCss}</style>`
      + '<div class="tool-call-section"><pre class="tool-call-output" data-detail-clamped="true">output</pre></div>'
  );
  const output = dom.window.document.querySelector('.tool-call-output');
  assert.equal(dom.window.getComputedStyle(output).overflow, 'hidden');
  output.setAttribute('data-detail-clamped', 'false');
  assert.equal(dom.window.getComputedStyle(output).overflow, 'visible');
  dom.window.close();
});

// Chat width (Appearance > Chat layout). Wide is an explicit, opt-in user
// setting -- distinct from the AUTOMATIC ultra-wide widening that 8df910a0
// deliberately reverted, whose guard lives further up this file and in
// tests/markdown-css-contract.test.js. Both must keep passing.
test('chat width tokens expose a Default/Wide reading measure without breaking the mobile or dock scopes', () => {
  const rootDir = path.resolve(__dirname, '..');
  const foundationCss = fs.readFileSync(path.join(rootDir, 'styles', 'foundation.css'), 'utf8');
  const mediaCss = fs.readFileSync(path.join(rootDir, 'styles', 'chat-media-queries.css'), 'utf8');

  // The base measure is still 760px, expressed through the swappable cap.
  assert.match(foundationCss, /--chat-measure-max:\s*760px;/);
  assert.match(foundationCss, /--content-column-width:\s*min\(var\(--chat-measure-max\),\s*var\(--chat-measure-fit\)\);/);
  assert.match(foundationCss, /--composer-width:\s*min\(var\(--chat-measure-max\),\s*var\(--chat-measure-fit\)\);/);

  const wideRule = readCssRuleBlock(foundationCss, ':root[data-chat-width="wide"]');
  assert.match(wideRule, /--chat-measure-max:\s*1100px;/);
  assert.match(wideRule, /--chat-card-max-width:\s*1100px;/);
  // The transcript and the composer widen together (owner decision).
  assert.match(wideRule, /--content-column-width:\s*min\(var\(--chat-measure-max\),\s*var\(--chat-measure-fit\)\);/);
  assert.match(wideRule, /--composer-width:\s*min\(var\(--chat-measure-max\),\s*var\(--chat-measure-fit\)\);/);
  // User bubbles keep their proportion of the wider measure.
  assert.match(wideRule, /--chat-user-bubble-max-width:\s*clamp\(410px,\s*49vw,\s*810px\);/);

  // The width tokens are re-declared inside the wide block ON PURPOSE: at
  // (0,2,0) that outranks the bare `:root` overrides in settings-responsive.css
  // (<=1280px) and chat-media-queries.css (>=2000px), so Wide wins at every
  // viewport. Inheriting from --chat-measure-max alone would silently lose.
  assert.match(
    fs.readFileSync(path.join(rootDir, 'styles', 'settings-responsive.css'), 'utf8'),
    /@media \(max-width:\s*1280px\)[\s\S]*?:root\s*\{[\s\S]*?--content-column-width:/,
    'the <=1280px :root override the wide block must outrank still exists'
  );

  // Wide must NOT be scoped to .chat-view -- (0,2,1) would beat the mobile
  // breakpoints, which set these tokens on .chat-view to neutralize wide mode.
  // Comments are stripped first: the foundation.css block documents this very
  // anti-pattern in prose, and a raw scan would match its own warning.
  const foundationRules = foundationCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(foundationRules, /:root\[data-chat-width="wide"\]\s+\.chat-view/);
  assert.match(mediaCss, /@media \(max-width:\s*700px\)\s*\{\s*\.chat-view\s*\{[\s\S]*?--content-column-width:/);
  assert.match(mediaCss, /@media \(max-width:\s*480px\)\s*\{\s*\.chat-view\s*\{[\s\S]*?--content-column-width:\s*100%;/);
});

test('card caps route through --chat-card-max-width and always keep their min(100%) clamp', () => {
  const rootDir = path.resolve(__dirname, '..');
  const files = {
    'chat-interactive.css': '.slash-command-output',
    'chat-thread.css': '.proactive-suggestion-block',
    'chat-tools.css': '.interactive-recap-block',
  };
  for (const [file, selector] of Object.entries(files)) {
    const css = fs.readFileSync(path.join(rootDir, 'styles', file), 'utf8');
    const rule = readCssRuleBlock(css, selector);
    // The min(100%, ...) wrapper is load-bearing: the IDE chat dock re-scopes
    // --content-column-width but NOT --chat-card-max-width, so a bare var()
    // would let cards overflow the dock in wide mode.
    assert.match(
      rule,
      /(?:max-)?width:\s*min\(100%,\s*var\(--chat-card-max-width\)\);/,
      `${selector} must clamp to min(100%, var(--chat-card-max-width))`
    );
    assert.doesNotMatch(rule, /760px/, `${selector} should no longer hardcode the measure`);
  }

  const mediaCss = fs.readFileSync(path.join(rootDir, 'styles', 'chat-media-queries.css'), 'utf8');
  // Ultra-wide retunes the token for DEFAULT mode only; at (0,1,0) it loses to
  // the wide block, so Wide keeps 1100px rather than snapping back to 820px.
  assert.match(mediaCss, /@media \(min-width:\s*2000px\)[\s\S]*?--chat-card-max-width:\s*820px;/);
  // .interactive-card has no base width rule anywhere, so the >=2000px rule
  // stays its only cap and must not be deleted.
  assert.match(mediaCss, /\.chat-view \.interactive-card \{\s*max-width:\s*min\(100%,\s*var\(--chat-card-max-width\)\);/);
});

test('reasoning panel measure comes from the content column, never its own max-width', () => {
  const rootDir = path.resolve(__dirname, '..');
  const files = ['chat-machinery.css', 'chat-media-queries.css', 'markdown.css'];
  let matchedRules = 0;

  for (const file of files) {
    const css = fs.readFileSync(path.join(rootDir, 'styles', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\.reasoning-row-panel(?:-body)?(?![\w-])/.test(match[1])) continue;
      matchedRules += 1;
      assert.doesNotMatch(
        match[2],
        /(?:^|;)\s*max-(?:width|inline-size)\s*:/i,
        `${file}: reasoning panel width must track the Chat width appearance setting via the content column`
      );
    }
  }

  assert.ok(matchedRules > 0, 'expected reasoning panel CSS rules to enforce the content-column width contract');
});
