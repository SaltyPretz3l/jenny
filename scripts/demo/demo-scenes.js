'use strict';

// Scene table for the demo clip recorder (scripts/demo/record-demo-clips.js).
//
// Each scene is one Electron launch on a throwaway profile (demo-profile.js),
// driven by the ordered `steps` below and captured with page.screencast. The
// driver is a small generic interpreter over STEP_TYPES; every promo-facing
// choice (prompts, palette order, pacing) lives here as data so a clip can be
// re-choreographed without touching the driver. Pure module: no I/O.
//
// Step vocabulary (the driver must implement exactly these):
//   record-start                       begin the screencast (exactly one per scene; steps before it are pre-roll)
//   goto-view {view}                   click #<view>TopRailTab, wait for activeView === view
//   send-prompt {text}                 window.__jennyAgent.sendPrompt(text)
//   wait-idle {timeoutMs}              window.__jennyAgent.waitForIdle({timeoutMs}) must resolve true
//   wait-selector {selector,timeoutMs} page.waitForSelector(selector, {state:'visible'})
//   wait-count {selector,count,timeoutMs}  until querySelectorAll(selector).length >= count
//   assert-absent {selector}           fail the scene if the selector is present
//   pause {ms}                         page.waitForTimeout(ms)
//   press {key}                        page.keyboard.press(key)
//   type {text, delayMs, seed}         type character by character with a seeded human cadence
//                                      (demo-presentation.js typingDelays)
//   move {selector, ms?}               glide the overlay cursor (and the real mouse) to the element's centre
//   click {selector}                   move there if needed, click pulse, real mouse click at the centre
//   caption {text}                     show the overlay caption chip ('' hides it)
//   scroll-to {selector, block?|top?}  element.scrollIntoView({block}); with `top`, set the nearest
//                                      scrollable container's scrollTop instead (pre-roll framing)
//   select-option {selector,value}     set <select>.value and dispatch `change` (works while its dialog is closed)
//
// Scene `presentation`: { crossfade: bool } -- palette switches ease instead of
// snapping. The overlay (cursor, captions, hidden replay-only chrome) is
// installed by record-start for every scene; see demo-presentation.js.

const path = require('node:path');

const { VIEW_TAB_ORDER } = require('../../capture-scenarios');
const { getPalettePresets } = require('../../renderer/shared/appearance-utils');

const REPLAY_SCRIPT_DIR = path.join(__dirname, 'demo-replay-scripts');

const STEP_TYPES = Object.freeze([
  'record-start',
  'goto-view',
  'send-prompt',
  'wait-idle',
  'wait-selector',
  'wait-count',
  'assert-absent',
  'pause',
  'press',
  'type',
  'move',
  'click',
  'caption',
  'scroll-to',
  'select-option',
]);

// Recording geometry shared by every scene so clips match in the README: the
// window opens maximized (the app's full-screen look) at device scale 2, so a
// 2560-wide display lays the app out at 1280 CSS px and the 1280-wide capture
// shows text at its native size (crisp, like a laptop window). Height follows
// the viewport's aspect ratio.
const RECORDING = Object.freeze({
  maximized: true,
  appZoomPercent: 100,
  deviceScaleFactor: 2,
  captureWidth: 1280,
  minViewportWidth: 1200,
  minViewportHeight: 640,
});

// Env pins every scene needs so the replay engine's call index is owned by the
// script, not by an unrelated planner call (the same pins the GUI tool-approval smoke uses).
const REPLAY_ENV_PINS = Object.freeze({
  JENNY_ENABLE_INTERACTIVE_POST_ROUTER_QUESTIONS: '0',
  JENNY_ENABLE_TOKEN_BUDGET: '0',
});

const SETTLE_TIMEOUT_MS = 60_000;
const UI_TIMEOUT_MS = 20_000;
const TAIL_HOLD_MS = 1500;
const PROMPT_TYPING_MS = 42;

const DEMO_SCENES = Object.freeze([
  Object.freeze({
    id: 'palette-reel',
    title: 'Palette switching',
    outputBasename: 'demo-palette-reel',
    view: 'chat',
    replayScript: 'palette-reel.json',
    replayDelayMs: 10,
    targetSeconds: [10, 18],
    leadInMs: 200,
    tailHoldMs: TAIL_HOLD_MS,
    env: REPLAY_ENV_PINS,
    presentation: Object.freeze({ crossfade: true }),
    // Fresh profiles start on `slate`. Palettes are driven through the
    // Appearance section's palette select (static DOM, bound at startup, so
    // no dialog ever covers the chat) with a caption naming each one; Reactive
    // Grid comes on early and Circuit Trace takes over midway so both effects
    // are seen across several palettes, dark and light.
    steps: Object.freeze([
      { type: 'goto-view', view: 'chat' },
      { type: 'send-prompt', text: 'How does a command flow through ledger-cli? A quick diagram would help.' },
      { type: 'wait-idle', timeoutMs: SETTLE_TIMEOUT_MS },
      // The settled turn is taller than the viewport at this layout and the
      // timeline virtualizer detaches rows scrolled out of view, so bring the
      // top of the turn back before gating on the tool row.
      { type: 'scroll-to', selector: '#chatTimeline', top: 0 },
      { type: 'wait-selector', selector: '#chatTimeline .tool-call-row[data-tool-status="completed"]', timeoutMs: UI_TIMEOUT_MS },
      // The diagram must actually render (in-page SVG), not fall back to source.
      { type: 'wait-selector', selector: '#chatTimeline .markdown-mermaid-block[data-mermaid-rendered="true"] svg', timeoutMs: UI_TIMEOUT_MS },
      { type: 'assert-absent', selector: '#chatTimeline .markdown-mermaid-preview-note' },
      // Frame the turn from the Mermaid tool row down: diagram, title, and the
      // start of the answer all in view at every recording height.
      { type: 'scroll-to', selector: '#chatTimeline .tool-call-row', block: 'start' },
      { type: 'pause', ms: 600 },
      { type: 'record-start' },
      { type: 'pause', ms: 400 },
      { type: 'caption', text: 'Palette · Slate' },
      { type: 'pause', ms: 1300 },
      { type: 'caption', text: 'Palette · Midnight' },
      { type: 'select-option', selector: '#appearancePaletteSelect', value: 'midnight' },
      { type: 'pause', ms: 1500 },
      { type: 'caption', text: 'Background effect · Reactive Grid' },
      { type: 'select-option', selector: '#appearanceSurfaceEffectSelect', value: 'reactive-grid' },
      { type: 'pause', ms: 1900 },
      { type: 'caption', text: 'Palette · Signal' },
      { type: 'select-option', selector: '#appearancePaletteSelect', value: 'signal' },
      { type: 'pause', ms: 1600 },
      { type: 'caption', text: 'Background effect · Circuit Trace' },
      { type: 'select-option', selector: '#appearanceSurfaceEffectSelect', value: 'circuit-trace' },
      { type: 'pause', ms: 1900 },
      { type: 'caption', text: 'Palette · Paper' },
      { type: 'select-option', selector: '#appearancePaletteSelect', value: 'paper' },
      { type: 'pause', ms: 1600 },
      { type: 'caption', text: 'Palette · Jenny Day' },
      { type: 'select-option', selector: '#appearancePaletteSelect', value: 'jenny-day' },
      { type: 'pause', ms: 1600 },
      { type: 'caption', text: 'Palette · Jenny Night' },
      { type: 'select-option', selector: '#appearancePaletteSelect', value: 'jenny-night' },
      { type: 'pause', ms: 1900 },
      { type: 'caption', text: '' },
      { type: 'pause', ms: 400 },
    ]),
  }),

  Object.freeze({
    id: 'streaming-tools',
    title: 'Streaming with real tool calls',
    outputBasename: 'demo-streaming-tools',
    view: 'chat',
    replayScript: 'streaming-tools.json',
    replayDelayMs: 36,
    targetSeconds: [10, 18],
    leadInMs: 200,
    tailHoldMs: TAIL_HOLD_MS,
    env: REPLAY_ENV_PINS,
    presentation: Object.freeze({ crossfade: false }),
    // The prompt is typed into the composer by the visible cursor and sent
    // with Enter, exactly as a person would; the turn then streams for real.
    steps: Object.freeze([
      { type: 'goto-view', view: 'chat' },
      { type: 'record-start' },
      { type: 'pause', ms: 500 },
      { type: 'move', selector: '#chatInput', ms: 750 },
      { type: 'click', selector: '#chatInput' },
      { type: 'pause', ms: 300 },
      { type: 'type', text: 'What does this project do? Check the README and the entry point.', delayMs: PROMPT_TYPING_MS, seed: 11 },
      { type: 'pause', ms: 450 },
      { type: 'press', key: 'Enter' },
      { type: 'wait-count', selector: '#chatTimeline .tool-call-row', count: 1, timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'assert-absent', selector: '#chatTimeline .tool-approval-block' },
      { type: 'wait-count', selector: '#chatTimeline .tool-call-row', count: 2, timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'wait-idle', timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'pause', ms: 1800 },
    ]),
  }),

  Object.freeze({
    id: 'ide-tour',
    title: 'The built-in IDE',
    outputBasename: 'demo-ide-tour',
    view: 'chat',
    replayScript: null,
    replayDelayMs: 40,
    targetSeconds: [10, 18],
    leadInMs: 200,
    tailHoldMs: TAIL_HOLD_MS,
    env: REPLAY_ENV_PINS,
    presentation: Object.freeze({ crossfade: false }),
    steps: Object.freeze([
      { type: 'goto-view', view: 'chat' },
      { type: 'record-start' },
      { type: 'pause', ms: 500 },
      { type: 'move', selector: '#ideTopRailTab', ms: 700 },
      { type: 'click', selector: '#ideTopRailTab' },
      { type: 'wait-selector', selector: '[data-ide-tree-path="src"]', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 700 },
      { type: 'click', selector: '[data-ide-tree-path="src"]' },
      // The fixture's uncommitted edit must show as git state on the row and in the gutter.
      { type: 'wait-selector', selector: '.ide-tree-row--git-modified[data-ide-tree-path="src/parser.js"]', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 450 },
      { type: 'click', selector: '[data-ide-tree-path="src/parser.js"]' },
      { type: 'wait-selector', selector: '.ide-tab--active [data-ide-tab-path="src/parser.js"]', timeoutMs: UI_TIMEOUT_MS },
      { type: 'wait-selector', selector: '.ide-gutter-change--modified', timeoutMs: UI_TIMEOUT_MS },
      { type: 'caption', text: 'Git gutter · uncommitted change' },
      { type: 'pause', ms: 1700 },
      { type: 'caption', text: 'Quick Open · Ctrl+P' },
      { type: 'press', key: 'Control+p' },
      { type: 'wait-selector', selector: '[data-ide-quick-open-input]', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 350 },
      { type: 'type', text: 'index', delayMs: 95, seed: 3 },
      { type: 'wait-selector', selector: '.ide-quick-open-row', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 650 },
      { type: 'press', key: 'Enter' },
      { type: 'wait-selector', selector: '.ide-tab--active [data-ide-tab-path="src/index.js"]', timeoutMs: UI_TIMEOUT_MS },
      { type: 'caption', text: '' },
      { type: 'pause', ms: 1200 },
      { type: 'click', selector: '#ideTabStrip [data-ide-tab-path="src/parser.js"]' },
      { type: 'wait-selector', selector: '.ide-tab--active [data-ide-tab-path="src/parser.js"]', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 1000 },
      { type: 'caption', text: 'Terminal' },
      { type: 'click', selector: '[data-ide-bottom-handle]' },
      { type: 'wait-selector', selector: '#ideBottomPanel:not(.hidden)', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 1500 },
      { type: 'caption', text: '' },
      { type: 'pause', ms: 300 },
    ]),
  }),
]);

function replayScriptPath(scene) {
  return scene.replayScript ? path.join(REPLAY_SCRIPT_DIR, scene.replayScript) : null;
}

function outputFileName(scene, extension) {
  return `${String(scene.outputBasename)}.${String(extension).replace(/^\./, '')}`;
}

// Throws on the first structural violation; returns true for a well-formed
// table. Strict on purpose: a bad edit should fail before a window opens.
function assertScenesValid(scenes = DEMO_SCENES) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('demo scenes must be a non-empty array');
  }
  const paletteIds = new Set(getPalettePresets().map((preset) => preset.id));
  const ids = new Set();
  const basenames = new Set();
  for (const scene of scenes) {
    if (!scene || typeof scene !== 'object') {
      throw new Error('each demo scene must be an object');
    }
    const { id, outputBasename, view, targetSeconds, steps } = scene;
    if (!id || typeof id !== 'string') {
      throw new Error('each demo scene needs a non-empty id');
    }
    if (ids.has(id)) {
      throw new Error(`duplicate demo scene id "${id}"`);
    }
    if (!outputBasename || typeof outputBasename !== 'string' || basenames.has(outputBasename)) {
      throw new Error(`scene ${id}: outputBasename must be a unique non-empty string`);
    }
    if (!VIEW_TAB_ORDER.includes(view)) {
      throw new Error(`scene ${id}: view "${view}" is not a current toprail view`);
    }
    if (!Array.isArray(targetSeconds) || targetSeconds.length !== 2
      || !(targetSeconds[0] >= 8 && targetSeconds[1] <= 18 && targetSeconds[0] < targetSeconds[1])) {
      throw new Error(`scene ${id}: targetSeconds must be [min, max] within 8..18`);
    }
    if (!scene.presentation || typeof scene.presentation.crossfade !== 'boolean') {
      throw new Error(`scene ${id}: presentation.crossfade must be a boolean`);
    }
    if (scene.replayScript !== null && (typeof scene.replayScript !== 'string' || !scene.replayScript.endsWith('.json'))) {
      throw new Error(`scene ${id}: replayScript must be null or a .json basename`);
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(`scene ${id}: steps must be a non-empty array`);
    }
    const recordStarts = steps.filter((step) => step && step.type === 'record-start').length;
    if (recordStarts !== 1) {
      throw new Error(`scene ${id}: exactly one record-start step is required (found ${recordStarts})`);
    }
    for (const step of steps) {
      if (!step || !STEP_TYPES.includes(step.type)) {
        throw new Error(`scene ${id}: unknown step type "${step && step.type}"`);
      }
      if (step.type === 'select-option' && !paletteIds.has(step.value) && step.selector === '#appearancePaletteSelect') {
        throw new Error(`scene ${id}: select-option targets unknown palette "${step.value}"`);
      }
      if (step.type === 'type' && !(Number.isInteger(step.seed) && step.seed > 0)) {
        throw new Error(`scene ${id}: type steps need a positive integer seed for a reproducible cadence`);
      }
    }
    ids.add(id);
    basenames.add(outputBasename);
  }
  return true;
}

module.exports = {
  DEMO_SCENES,
  STEP_TYPES,
  RECORDING,
  REPLAY_ENV_PINS,
  REPLAY_SCRIPT_DIR,
  replayScriptPath,
  outputFileName,
  assertScenesValid,
};
