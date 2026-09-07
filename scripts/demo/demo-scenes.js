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
//   click {selector, optional?}        move there if needed, click pulse, real mouse click at the centre;
//                                      with optional, a missing target is skipped instead of failing
//   dom-click {selector}               plain page click, no cursor choreography (pre-roll only, before the
//                                      overlay exists)
//   caption {text}                     show the overlay caption chip ('' hides it)
//   scroll-to {selector, block?|top?}  element.scrollIntoView({block}); with `top`, set the nearest
//                                      scrollable container's scrollTop instead (pre-roll framing)
//   select-option {selector,value}     set <select>.value and dispatch `change` (works while its dialog is closed)
//
// Text in `type`, `send-prompt`, and `caption` steps may carry the relative
// date tokens from demo-dates.js ({{weekday+2}}), resolved at record time
// against the same clock the profile's calendar was seeded with.
//
// Scene `presentation`: { crossfade: bool } -- palette switches ease instead of
// snapping. PRESENTATION_DEFAULTS (pinned telemetry, model label) apply to
// every scene; the overlay (cursor, captions, hidden engine pill) is installed
// by record-start. See demo-presentation.js.

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
  'dom-click',
  'caption',
  'scroll-to',
  'select-option',
]);

// Recording geometry shared by every scene so clips match in the README: the
// window opens maximized (the app's full-screen look) at device scale 1.75,
// so a 2560-wide display lays the app out at ~1460 CSS px (room for the
// timeline, the history sidebar, and the IDE's three panes) and the 1280-wide
// capture keeps text a touch under native size. Height follows the
// viewport's aspect ratio.
const RECORDING = Object.freeze({
  maximized: true,
  appZoomPercent: 100,
  deviceScaleFactor: 1.75,
  captureWidth: 1280,
  minViewportWidth: 1200,
  minViewportHeight: 640,
});

// Chrome the scripted engine cannot drive itself, pinned by the presentation
// layer for every scene: titlebar telemetry as it reads with a local model
// busy on the GPU, and the composer pill naming the model the clips stand in
// for (with its reasoning effort). Disclosed in docs/media/README.md.
const PRESENTATION_DEFAULTS = Object.freeze({
  telemetry: Object.freeze({ cpu: 31, gpu: 88, vramUsedGb: 7.6, vramTotalGb: 12, seed: 5, intervalMs: 1500 }),
  modelLabel: 'ornith15 · 9b · Med',
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
const TARGET_SECONDS_MIN = 8;
const TARGET_SECONDS_MAX = 28;

const APPROVE_ONCE_BUTTON = '#chatTimeline .tool-approval-block .tool-approve-btn[data-approval-scope="once"]';
// Playwright selector syntax (:nth-match, >>): the edit turn's second tool row
// is the Edit row; its structured diff card renders inside the row body once
// the row is expanded, and the card's hunks open on their own toggle.
const EDIT_ROW_COMPLETED = ':nth-match(#chatTimeline .tool-call-row[data-tool-status="completed"], 2)';
const EDIT_ROW_TOGGLE = ':nth-match(#chatTimeline .tool-call-row, 2) >> [data-tool-row-toggle]';
const EXPANDED_ROW = '#chatTimeline .tool-call-row[data-expanded="true"]';

// The seeded profile boots into its most recent chat, so every scene starts a
// fresh one first (pre-roll): the timeline is empty and the replay engine's
// call index starts at the script's first call.
const FRESH_CHAT_PREROLL = Object.freeze([
  { type: 'goto-view', view: 'chat' },
  { type: 'dom-click', selector: '#newChatButton' },
  { type: 'pause', ms: 600 },
]);

// The typed prompt, click on the composer, and Enter that open every chat scene.
function composerPromptSteps(text, seed) {
  return [
    { type: 'pause', ms: 500 },
    { type: 'move', selector: '#chatInput', ms: 750 },
    { type: 'click', selector: '#chatInput' },
    { type: 'pause', ms: 300 },
    { type: 'type', text, delayMs: PROMPT_TYPING_MS, seed },
    { type: 'pause', ms: 450 },
    { type: 'press', key: 'Enter' },
  ];
}

const DEMO_SCENES = Object.freeze([
  Object.freeze({
    id: 'streaming-tools',
    title: 'Streaming with real tool calls',
    outputBasename: 'demo-streaming-tools',
    view: 'chat',
    replayScript: 'streaming-tools.json',
    replayDelayMs: 36,
    targetSeconds: [10, 20],
    leadInMs: 200,
    tailHoldMs: TAIL_HOLD_MS,
    env: REPLAY_ENV_PINS,
    presentation: Object.freeze({ crossfade: false }),
    // The prompt is typed into the composer by the visible cursor and sent
    // with Enter, exactly as a person would; the turn then streams for real.
    steps: Object.freeze([
      ...FRESH_CHAT_PREROLL,
      { type: 'record-start' },
      ...composerPromptSteps('What does this project do? Check the README and the entry point.', 11),
      { type: 'wait-count', selector: '#chatTimeline .tool-call-row', count: 1, timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'assert-absent', selector: '#chatTimeline .tool-approval-block' },
      { type: 'wait-count', selector: '#chatTimeline .tool-call-row', count: 2, timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'wait-idle', timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'pause', ms: 1800 },
    ]),
  }),

  Object.freeze({
    id: 'assistant-edit',
    title: 'A code change with approval and a diff',
    outputBasename: 'demo-assistant-edit',
    view: 'chat',
    replayScript: 'assistant-edit.json',
    replayDelayMs: 34,
    targetSeconds: [12, 26],
    leadInMs: 200,
    tailHoldMs: TAIL_HOLD_MS,
    env: REPLAY_ENV_PINS,
    presentation: Object.freeze({ crossfade: false }),
    // read_file runs on its own; edit_file stops at the approval block until
    // the cursor allows it once. After the reply settles, the Edit row is
    // expanded and the diff card inside it opened, so the change itself is
    // the last thing on screen.
    steps: Object.freeze([
      ...FRESH_CHAT_PREROLL,
      { type: 'record-start' },
      ...composerPromptSteps('parseAmount should accept a leading $ sign. Make the change and show me the diff.', 17),
      { type: 'wait-count', selector: '#chatTimeline .tool-call-row', count: 1, timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'wait-selector', selector: '#chatTimeline .tool-approval-block', timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'pause', ms: 500 },
      { type: 'caption', text: 'Changes wait for your approval' },
      { type: 'pause', ms: 900 },
      { type: 'move', selector: APPROVE_ONCE_BUTTON, ms: 800 },
      { type: 'pause', ms: 250 },
      { type: 'click', selector: APPROVE_ONCE_BUTTON },
      { type: 'caption', text: '' },
      { type: 'wait-selector', selector: EDIT_ROW_COMPLETED, timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'wait-idle', timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'pause', ms: 700 },
      { type: 'caption', text: 'Every change shows its diff' },
      { type: 'click', selector: EDIT_ROW_TOGGLE },
      // The row must be open (a collapsed body still has boxes for Playwright's
      // visibility check), and the diff card may already be open inside it.
      { type: 'wait-selector', selector: `${EXPANDED_ROW} [data-file-diff-toggle]`, timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 500 },
      { type: 'click', selector: `${EXPANDED_ROW} [data-file-diff-toggle][aria-expanded="false"]`, optional: true },
      { type: 'wait-selector', selector: `${EXPANDED_ROW} .file-diff-body[data-file-diff-materialized]`, timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 2400 },
      { type: 'caption', text: '' },
      { type: 'pause', ms: 300 },
    ]),
  }),

  Object.freeze({
    id: 'calendar-week',
    title: 'Calendar and reminders from chat',
    outputBasename: 'demo-calendar-week',
    view: 'chat',
    replayScript: 'calendar-week.json',
    replayDelayMs: 34,
    targetSeconds: [14, 28],
    leadInMs: 200,
    tailHoldMs: TAIL_HOLD_MS,
    env: REPLAY_ENV_PINS,
    presentation: Object.freeze({ crossfade: false }),
    // The Home tool writes the event and the reminder, reads the week back,
    // and the reply summarizes it; the clip ends on the Home agenda where the
    // new entries sit next to the seeded week.
    steps: Object.freeze([
      ...FRESH_CHAT_PREROLL,
      { type: 'record-start' },
      ...composerPromptSteps(
        'Add a budget review on {{weekday+2}} at 3pm, remind me to send the variance report {{weekday+1}} morning, and tell me what else is on this week.',
        23
      ),
      { type: 'wait-count', selector: '#chatTimeline .tool-call-row', count: 1, timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'caption', text: 'Home tools · calendar and reminders' },
      { type: 'wait-count', selector: '#chatTimeline .tool-call-row', count: 3, timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'wait-idle', timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'caption', text: '' },
      { type: 'pause', ms: 2000 },
      { type: 'caption', text: 'Home · this week' },
      { type: 'move', selector: '#homeTopRailTab', ms: 700 },
      { type: 'click', selector: '#homeTopRailTab' },
      { type: 'wait-selector', selector: '.cal-agenda__item', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 2600 },
      { type: 'caption', text: '' },
      { type: 'pause', ms: 300 },
    ]),
  }),

  Object.freeze({
    id: 'ide-tour',
    title: 'The built-in IDE',
    outputBasename: 'demo-ide-tour',
    view: 'chat',
    replayScript: 'ide-tour.json',
    replayDelayMs: 34,
    targetSeconds: [16, 28],
    leadInMs: 200,
    tailHoldMs: TAIL_HOLD_MS,
    env: REPLAY_ENV_PINS,
    presentation: Object.freeze({ crossfade: false }),
    // Explorer and the git gutter, the terminal running the fixture's tests
    // for real, then the chat dock opened beside the editor and a question
    // about the open file answered in place.
    steps: Object.freeze([
      ...FRESH_CHAT_PREROLL,
      { type: 'record-start' },
      { type: 'pause', ms: 500 },
      { type: 'move', selector: '#ideTopRailTab', ms: 700 },
      { type: 'click', selector: '#ideTopRailTab' },
      { type: 'wait-selector', selector: '[data-ide-tree-path="src"]', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 600 },
      { type: 'click', selector: '[data-ide-tree-path="src"]' },
      // The fixture's uncommitted edit must show as git state on the row and in the gutter.
      { type: 'wait-selector', selector: '.ide-tree-row--git-modified[data-ide-tree-path="src/parser.js"]', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 400 },
      { type: 'click', selector: '[data-ide-tree-path="src/parser.js"]' },
      { type: 'wait-selector', selector: '.ide-tab--active [data-ide-tab-path="src/parser.js"]', timeoutMs: UI_TIMEOUT_MS },
      { type: 'wait-selector', selector: '.ide-gutter-change--modified', timeoutMs: UI_TIMEOUT_MS },
      { type: 'caption', text: 'Git gutter · uncommitted change' },
      { type: 'pause', ms: 1500 },
      { type: 'caption', text: 'Terminal' },
      { type: 'click', selector: '[data-ide-bottom-handle]' },
      { type: 'wait-selector', selector: '#ideBottomPanel:not(.hidden)', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 500 },
      { type: 'click', selector: '[data-ide-terminal-action="start"]' },
      { type: 'wait-selector', selector: '.ide-terminal-status--running', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 1100 },
      { type: 'click', selector: '[data-ide-pty-mount]' },
      { type: 'pause', ms: 250 },
      { type: 'type', text: 'npm test', delayMs: 85, seed: 5 },
      { type: 'pause', ms: 300 },
      { type: 'press', key: 'Enter' },
      { type: 'pause', ms: 2600 },
      { type: 'caption', text: 'Ask Jenny from the workspace' },
      { type: 'click', selector: '[data-ide-rail-chatdock]' },
      { type: 'wait-selector', selector: '#ideChatDock:not(.hidden) #chatInput', timeoutMs: UI_TIMEOUT_MS },
      { type: 'pause', ms: 500 },
      { type: 'click', selector: '#chatInput' },
      { type: 'pause', ms: 300 },
      { type: 'type', text: 'Why does parseAmount round through cents?', delayMs: PROMPT_TYPING_MS, seed: 29 },
      { type: 'pause', ms: 400 },
      { type: 'press', key: 'Enter' },
      { type: 'wait-idle', timeoutMs: SETTLE_TIMEOUT_MS },
      { type: 'caption', text: '' },
      { type: 'pause', ms: 1800 },
    ]),
  }),

  Object.freeze({
    id: 'palette-reel',
    title: 'Palette switching',
    outputBasename: 'demo-palette-reel',
    view: 'chat',
    replayScript: 'palette-reel.json',
    replayDelayMs: 10,
    targetSeconds: [10, 20],
    leadInMs: 200,
    tailHoldMs: TAIL_HOLD_MS,
    env: REPLAY_ENV_PINS,
    presentation: Object.freeze({ crossfade: true }),
    // The diagram turn is typed and sent in the pre-roll (the composer path,
    // which waits for the fresh session; the agent hook's send-button click
    // is dropped while it settles). Palettes are driven through the
    // Appearance section's palette select (static DOM, bound at startup, so
    // no dialog ever covers the chat) with a caption naming each one; Reactive
    // Grid comes on early and Circuit Trace takes over midway so both effects
    // are seen across several palettes, dark and light.
    steps: Object.freeze([
      ...FRESH_CHAT_PREROLL,
      { type: 'dom-click', selector: '#chatInput' },
      { type: 'type', text: 'How does a command flow through ledger-cli? A quick diagram would help.', delayMs: 4, seed: 41 },
      { type: 'pause', ms: 300 },
      { type: 'press', key: 'Enter' },
      { type: 'wait-count', selector: '#chatTimeline .tool-call-row', count: 1, timeoutMs: SETTLE_TIMEOUT_MS },
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
]);

function replayScriptPath(scene) {
  return scene.replayScript ? path.join(REPLAY_SCRIPT_DIR, scene.replayScript) : null;
}

function outputFileName(scene, extension) {
  return `${String(scene.outputBasename)}.${String(extension).replace(/^\./, '')}`;
}

function assertPresentationDefaultsValid(defaults = PRESENTATION_DEFAULTS) {
  const telemetry = defaults && defaults.telemetry;
  for (const key of ['cpu', 'gpu', 'vramUsedGb', 'vramTotalGb', 'seed', 'intervalMs']) {
    if (!(Number.isFinite(telemetry?.[key]) && telemetry[key] > 0)) {
      throw new Error(`presentation defaults: telemetry.${key} must be a positive number`);
    }
  }
  if (!(telemetry.cpu <= 100 && telemetry.gpu <= 100 && telemetry.vramUsedGb < telemetry.vramTotalGb)) {
    throw new Error('presentation defaults: telemetry percentages must be <= 100 and VRAM used below total');
  }
  if (typeof defaults.modelLabel !== 'string' || !defaults.modelLabel.trim()) {
    throw new Error('presentation defaults: modelLabel must be a non-empty string');
  }
  return true;
}

// Throws on the first structural violation; returns true for a well-formed
// table. Strict on purpose: a bad edit should fail before a window opens.
function assertScenesValid(scenes = DEMO_SCENES) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('demo scenes must be a non-empty array');
  }
  assertPresentationDefaultsValid();
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
      || !(targetSeconds[0] >= TARGET_SECONDS_MIN && targetSeconds[1] <= TARGET_SECONDS_MAX
        && targetSeconds[0] < targetSeconds[1])) {
      throw new Error(`scene ${id}: targetSeconds must be [min, max] within ${TARGET_SECONDS_MIN}..${TARGET_SECONDS_MAX}`);
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
      if (step.type === 'click' && step.optional !== undefined && typeof step.optional !== 'boolean') {
        throw new Error(`scene ${id}: click.optional must be a boolean when present`);
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
  PRESENTATION_DEFAULTS,
  REPLAY_ENV_PINS,
  REPLAY_SCRIPT_DIR,
  TARGET_SECONDS_MIN,
  TARGET_SECONDS_MAX,
  replayScriptPath,
  outputFileName,
  assertScenesValid,
  assertPresentationDefaultsValid,
};
