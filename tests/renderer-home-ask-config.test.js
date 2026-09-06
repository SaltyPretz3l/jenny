/* W10 - the Ask Jenny pill becomes a real mini-composer.
 *
 * What these tests pin, and why each one exists:
 *
 *  - The config chip labels the EFFECTIVE model and re-labels as the draft
 *    moves, because the chip is the only place the pill's config is visible.
 *  - Popover edits mutate the DRAFT ONLY. Nothing is persisted: no session
 *    write, no settings write, no shell call beyond the models catalog read.
 *  - Effort options gate on model capability, mirroring the composer.
 *  - The draft survives the manager's 30s chrome repaint - the same class of
 *    regression the ask pill's own value already guards against (C6).
 *  - Enter creates a session carrying the draft's model + effort, writes the
 *    session's tool overrides BEFORE the send, and fires the composer's REAL
 *    send control with the question in it.
 *  - Shift+Enter does all of that EXCEPT the send.
 *  - An empty Enter navigates and nothing else.
 *  - A rejected create leaves the user's text in the pill.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const askConfigModule = require('../renderer/features/renderer-dashboard-ask-config.js');
const daybookModule = require('../renderer/features/renderer-dashboard-daybook.js');
const widgetsCore = require('../renderer/features/renderer-dashboard-widgets-core.js');
const dashboardRegistryModule = require('../renderer/features/renderer-dashboard-registry.js');
const { createDashboardManager } = require('../renderer/features/renderer-dashboard-manager.js');
const composerV2Model = require('../renderer/chat/renderer-composer-v2-model.js');
const reasoningEffortProfiles = require('../reasoning-effort-profiles.js');
const lifecycleFormatUtils = require('../renderer/shell/renderer-lifecycle-format-utils.js');
const inventoryChip = require('../renderer/inventory/chip.js');
const inventoryPopover = require('../renderer/inventory/popover.js');
const inventorySelectField = require('../renderer/inventory/select-field.js');
const inventoryToggleSwitchModule = require('../renderer/inventory/toggle-switch.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

// Composed exactly the way renderer/inventory/index.js composes the live
// `inventory` global: the toggle-switch UMD returns an object, and its statics
// are hung off the render function so `inventory.toggleSwitch.toggle(...)`
// works the same in a harness as it does in production.
function buildInventory() {
  const toggleSwitch = inventoryToggleSwitchModule.toggleSwitch;
  toggleSwitch.toggle = inventoryToggleSwitchModule.toggle;
  toggleSwitch.setChecked = inventoryToggleSwitchModule.setChecked;
  toggleSwitch.initToggleHandlers = inventoryToggleSwitchModule.initToggleHandlers;
  return {
    chip: inventoryChip,
    popover: inventoryPopover,
    selectField: inventorySelectField,
    actionButton: inventoryActionButton,
    toggleSwitch,
  };
}

function createDom() {
  const dom = new JSDOM(''
    + '<main><div class="home-daybook" id="homeDaybook">'
    + '<div id="homeInfoStrip" hidden></div>'
    + '<section id="homeDashboardGrid"></section>'
    + '<div id="homeRailResizer" role="separator" tabindex="0"></div>'
    + '<div id="homeRailGrip" aria-hidden="true"></div>'
    + '<div id="homeDashboardRail"><textarea id="homeScratchpadInput" rows="6"></textarea></div>'
    + '</div>'
    + '<textarea id="chatInput"></textarea>'
    + '<button id="sendButton" type="button">Send</button></main>');
  const documentRef = dom.window.document;
  const byId = (id) => documentRef.getElementById(id);
  return {
    dom,
    window: dom.window,
    documentRef,
    daybook: byId('homeDaybook'),
    grid: byId('homeDashboardGrid'),
    rail: byId('homeDashboardRail'),
    resizer: byId('homeRailResizer'),
    grip: byId('homeRailGrip'),
    infoStrip: byId('homeInfoStrip'),
    chatInput: byId('chatInput'),
    sendButton: byId('sendButton'),
  };
}

const OLLAMA_MODELS = [
  { id: 'qwen3:8b', engine_type: 'ollama' },
  { id: 'gpt-5.5', engine_type: 'chatgpt' },
];

function buildHarness(t, options = {}) {
  const dom = createDom();
  globalThis.inventoryActionButton = inventoryActionButton;
  globalThis.inventoryTextField = inventoryTextField;
  t.after(() => {
    delete globalThis.inventoryActionButton;
    delete globalThis.inventoryTextField;
  });

  const calls = {
    created: [],
    setPreferences: [],
    views: [],
    sends: 0,
    logs: [],
  };
  dom.sendButton.addEventListener('click', () => { calls.sends += 1; });

  const state = {
    ui: { activeView: 'home' },
    currentSessionId: options.currentSessionId || '',
    homeConfig: { links: [], focusMode: false },
    features: { tools: options.toolSettings || {} },
  };

  const intervalCallbacks = [];
  const manager = createDashboardManager({
    state,
    documentRef: dom.documentRef,
    inventory: buildInventory(),
    shell: {
      models: {
        list: async () => {
          if (options.modelsFail === true) {
            return Promise.reject(new Error('catalog offline'));
          }
          // A catalog the test can hold open, so the resolve lands with the
          // panel already on screen (the exact F2 window).
          if (options.modelsPromise) {
            return options.modelsPromise;
          }
          return { data: options.models || OLLAMA_MODELS };
        },
      },
      sessions: {
        setPreferences: async (sessionId, patch) => {
          calls.setPreferences.push({ sessionId, patch, afterSends: calls.sends });
          return { id: sessionId, ...patch };
        },
      },
    },
    dom: {
      homeInfoStrip: dom.infoStrip,
      homeDashboardGrid: dom.grid,
      homeDaybook: dom.daybook,
      homeDashboardRail: dom.rail,
      homeRailResizer: dom.resizer,
      homeRailGrip: dom.grip,
    },
    modules: {
      dashboardRegistry: dashboardRegistryModule,
      dashboardWidgetsCore: widgetsCore,
      dashboardDaybook: daybookModule,
      dashboardAskConfig: askConfigModule,
      composerV2Model,
      reasoningEffortProfiles,
      lifecycleFormatUtils,
    },
    callbacks: {
      appendClientLog: (level, code, detail) => calls.logs.push({ level, code, detail }),
      setActiveView: (view) => calls.views.push(view),
      getRuntimePreferences: () => ({
        preferredModel: options.preferredModel || '',
        reasoningEffort: options.reasoningEffort || 'default',
      }),
      handleCreateSession: async (createOptions) => {
        calls.created.push(createOptions);
        if (options.createFails === true) {
          throw new Error('sessions.create rejected');
        }
        // `createSwitches: false` models a create that resolves without the
        // active session actually moving - the F8 window.
        if (options.createSwitches !== false) {
          state.currentSessionId = 'session-new';
        }
        return 'session-new';
      },
    },
    nowProvider: () => new Date(2026, 5, 11, 8, 5),
    setIntervalImpl: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length; },
    clearIntervalImpl: () => {},
  });
  t.after(() => manager.dispose());
  manager.bind();
  manager.render();

  return { dom, state, manager, calls, intervalCallbacks };
}

// The models catalog is read lazily; let its promise settle before asserting
// on anything the catalog feeds (chip label, model options, effort ladder).
async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function pressKey(dom, pill, key, init = {}) {
  const event = new dom.window.KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true, ...init,
  });
  pill.dispatchEvent(event);
  return event;
}

const chipOf = (dom) => dom.documentRef.getElementById('homeAskConfigChip');
const popoverOf = (dom) => dom.documentRef.getElementById('homeAskConfigPopover');
const chipLabel = (dom) => chipOf(dom).querySelector('.home-ask__model-label').textContent;

function openPopover(dom) {
  chipOf(dom).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return popoverOf(dom);
}

function setSelect(dom, field, value) {
  const select = popoverOf(dom).querySelector(`[data-ask-config="${field}"]`);
  select.value = value;
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  return select;
}

test('the chip labels the effective model and relabels as the draft moves', async (t) => {
  const { dom, calls } = buildHarness(t, { preferredModel: 'qwen3:8b' });
  await settle();

  const chip = chipOf(dom);
  assert.ok(chip, 'the chip lives inside the ask region');
  assert.equal(
    dom.infoStrip.querySelector('.home-info-strip__ask').contains(chip),
    true,
    'the chip is a sibling of the pill, NOT part of the repainted chrome'
  );
  assert.equal(chip.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(chip.getAttribute('aria-controls'), 'homeAskConfigPopover');
  assert.equal(chipLabel(dom), 'qwen3:8b');
  assert.match(chip.getAttribute('aria-label'), /Ask settings: qwen3:8b/);

  openPopover(dom);
  setSelect(dom, 'model', 'gpt-5.5');
  assert.equal(chipLabel(dom), 'gpt-5.5', 'the chip tracks the draft live');

  setSelect(dom, 'effort', 'high');
  assert.equal(chipLabel(dom), 'gpt-5.5 · High', 'a non-default effort joins the label');
  assert.match(chipOf(dom).getAttribute('aria-label'), /High reasoning effort/);

  assert.deepEqual(calls.setPreferences, [], 'editing the draft writes NOTHING');
  assert.deepEqual(calls.created, [], 'and creates no session');
});

test('with no preferred model the chip reads as the default and stays quiet', async (t) => {
  const { dom } = buildHarness(t);
  await settle();

  assert.equal(chipLabel(dom), 'Default model');
  assert.equal(chipOf(dom).getAttribute('aria-label'), 'Ask settings: Default model');
});

test('the effort picker gates on the model capability, exactly like the composer', async (t) => {
  const { dom } = buildHarness(t, { preferredModel: 'qwen3:8b' });
  await settle();

  const popover = openPopover(dom);
  // A plain local tag exposes no reasoning ladder: the control is absent, not
  // a picker with a single useless "Use default" entry.
  assert.equal(popover.querySelector('[data-ask-config="effort"]'), null);
  assert.equal(popover.querySelector('.home-ask-config__effort').hidden, true);

  setSelect(dom, 'model', 'gpt-5.5');
  const effort = popover.querySelector('[data-ask-config="effort"]');
  assert.ok(effort, 'a gpt-5 model brings the effort ladder with it');
  const values = [...effort.options].map((option) => option.value);
  assert.deepEqual(values, ['default', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(popover.querySelector('.home-ask-config__effort').hidden, false);

  // Swapping back to a model without a ladder retires the control AND drops
  // the carried-over effort, so an unsupported value cannot ride into a chat.
  setSelect(dom, 'effort', 'high');
  setSelect(dom, 'model', 'qwen3:8b');
  assert.equal(popover.querySelector('[data-ask-config="effort"]'), null);
  assert.equal(chipLabel(dom), 'qwen3:8b', 'the stale effort is gone from the label too');
});

test('tool toggles seed from the global defaults and mutate only the draft', async (t) => {
  const { dom, calls } = buildHarness(t, {
    preferredModel: 'qwen3:8b',
    toolSettings: { web: false, bash: true },
  });
  await settle();

  const popover = openPopover(dom);
  const trackFor = (categoryId) => popover.querySelector(`[data-inv-toggle="home-ask-tool-${categoryId}"]`);

  assert.equal(trackFor('web_search').getAttribute('aria-checked'), 'false', 'a false default seeds OFF');
  assert.equal(trackFor('Bash').getAttribute('aria-checked'), 'true');
  // An absent config key means ON, matching the composer's own seeding rule.
  assert.equal(trackFor('file_tools').getAttribute('aria-checked'), 'true');

  trackFor('file_tools').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(trackFor('file_tools').getAttribute('aria-checked'), 'false');
  assert.deepEqual(calls.setPreferences, [], 'flipping a toggle persists nothing');
});

test('C6 redux: the 30s clock update does not reset a touched draft', async (t) => {
  const { dom, intervalCallbacks } = buildHarness(t, { preferredModel: 'qwen3:8b' });
  await settle();

  openPopover(dom);
  setSelect(dom, 'model', 'gpt-5.5');
  setSelect(dom, 'effort', 'xhigh');
  assert.equal(chipLabel(dom), 'gpt-5.5 · Extra high');

  const chipBefore = chipOf(dom);
  assert.equal(intervalCallbacks.length, 1);
  intervalCallbacks[0]();
  await settle();

  assert.equal(chipOf(dom), chipBefore, 'the SAME chip node survives the clock update');
  assert.equal(chipLabel(dom), 'gpt-5.5 · Extra high', 'and so does the draft it renders');
});

test('the clock-only tick does not re-seed an untouched draft', async (t) => {
  const dom = createDom();
  globalThis.inventoryActionButton = inventoryActionButton;
  globalThis.inventoryTextField = inventoryTextField;
  t.after(() => {
    delete globalThis.inventoryActionButton;
    delete globalThis.inventoryTextField;
  });

  let livePair = { preferredModel: 'qwen3:8b', reasoningEffort: 'default' };
  const intervalCallbacks = [];
  const manager = createDashboardManager({
    state: { ui: { activeView: 'home' }, homeConfig: { links: [], focusMode: false }, features: { tools: {} } },
    documentRef: dom.documentRef,
    inventory: buildInventory(),
    shell: { models: { list: async () => ({ data: OLLAMA_MODELS }) } },
    dom: {
      homeInfoStrip: dom.infoStrip,
      homeDashboardGrid: dom.grid,
      homeDaybook: dom.daybook,
      homeDashboardRail: dom.rail,
      homeRailResizer: dom.resizer,
      homeRailGrip: dom.grip,
    },
    modules: {
      dashboardRegistry: dashboardRegistryModule,
      dashboardWidgetsCore: widgetsCore,
      dashboardDaybook: daybookModule,
      dashboardAskConfig: askConfigModule,
      composerV2Model,
      reasoningEffortProfiles,
      lifecycleFormatUtils,
    },
    callbacks: {
      appendClientLog: () => {},
      getRuntimePreferences: () => livePair,
    },
    nowProvider: () => new Date(2026, 5, 11, 8, 5),
    setIntervalImpl: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length; },
    clearIntervalImpl: () => {},
  });
  t.after(() => manager.dispose());
  manager.bind();
  manager.render();
  await settle();
  assert.equal(chipLabel(dom), 'qwen3:8b');

  // A runtime-pair change is not clock work; the clock tick must leave the
  // ask-config subtree untouched.
  livePair = { preferredModel: 'gpt-5.5', reasoningEffort: 'medium' };
  intervalCallbacks[0]();
  await settle();
  assert.equal(chipLabel(dom), 'qwen3:8b');
});

test('Enter starts a NEW chat carrying the draft, writes the tool overrides, and sends', async (t) => {
  const { dom, calls } = buildHarness(t, {
    preferredModel: 'qwen3:8b',
    toolSettings: { web: false },
  });
  await settle();

  openPopover(dom);
  setSelect(dom, 'model', 'gpt-5.5');
  setSelect(dom, 'effort', 'high');
  const filesTrack = popoverOf(dom).querySelector('[data-inv-toggle="home-ask-tool-file_tools"]');
  filesTrack.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

  const pill = dom.documentRef.getElementById('homeAskPill');
  pill.value = 'why is the build red?';
  const enter = pressKey(dom, pill, 'Enter');
  assert.equal(enter.defaultPrevented, true);
  await settle();

  assert.equal(calls.created.length, 1, 'exactly one session is created');
  assert.deepEqual(calls.created[0].preferences, {
    preferred_model: 'gpt-5.5',
    reasoning_effort: 'high',
  }, 'the draft is threaded into the create call');

  assert.equal(calls.setPreferences.length, 1);
  assert.equal(calls.setPreferences[0].sessionId, 'session-new');
  assert.deepEqual(calls.setPreferences[0].patch.tool_category_overrides, {
    web: false,
    terminal: true,
    python: true,
    files: false,
  }, 'the draft maps onto the session-shaped override keys');
  assert.equal(calls.setPreferences[0].afterSends, 0, 'overrides land BEFORE the send');

  assert.equal(dom.chatInput.value, 'why is the build red?');
  assert.deepEqual(calls.views, ['chat']);
  assert.equal(calls.sends, 1, 'the composer\'s own send control fires');
  assert.equal(pill.value, '', 'the pill clears once the ask is away');
});

test('Ctrl+Enter creates and prefills the same configured chat but never sends', async (t) => {
  const { dom, calls } = buildHarness(t, { preferredModel: 'gpt-5.5' });
  await settle();

  openPopover(dom);
  setSelect(dom, 'effort', 'low');

  const pill = dom.documentRef.getElementById('homeAskPill');
  pill.value = 'draft this one';
  // W13: Shift+Enter is a NEWLINE now (composer parity); the prefill-only
  // review path moved to Ctrl/Cmd+Enter.
  const drafted = pressKey(dom, pill, 'Enter', { ctrlKey: true });
  assert.equal(drafted.defaultPrevented, true);
  await settle();

  assert.equal(calls.created.length, 1, 'the review path still gets its own chat');
  assert.deepEqual(calls.created[0].preferences, {
    preferred_model: 'gpt-5.5',
    reasoning_effort: 'low',
  });
  assert.equal(calls.setPreferences.length, 1, 'and its own tool overrides');
  assert.equal(dom.chatInput.value, 'draft this one', 'the question is in the composer');
  assert.deepEqual(calls.views, ['chat']);
  assert.equal(calls.sends, 0, 'NOTHING is sent - this is the review/attach path');
  assert.equal(pill.value, '');
});

test('an empty Enter only navigates: no session, no overrides, no send', async (t) => {
  const { dom, calls } = buildHarness(t);
  await settle();

  const pill = dom.documentRef.getElementById('homeAskPill');
  pill.value = '   ';
  pressKey(dom, pill, 'Enter');
  await settle();

  assert.deepEqual(calls.created, []);
  assert.deepEqual(calls.setPreferences, []);
  assert.equal(calls.sends, 0);
  assert.equal(dom.chatInput.value, '', 'no composer write');
  assert.deepEqual(calls.views, ['chat']);
});

test('a rejected session create leaves the question in the pill', async (t) => {
  const { dom, calls } = buildHarness(t, { createFails: true });
  await settle();

  const pill = dom.documentRef.getElementById('homeAskPill');
  pill.value = 'do not lose me';
  pressKey(dom, pill, 'Enter');
  await settle();

  assert.equal(pill.value, 'do not lose me', 'the text is NOT dropped');
  assert.equal(dom.chatInput.value, '', 'and nothing half-landed in the composer');
  assert.equal(calls.sends, 0);
  assert.ok(
    calls.logs.some((entry) => entry.code === 'home.ask_session_create_failed'),
    'the failure is logged rather than swallowed'
  );
});

test('a missing send control aborts before anything is created', async (t) => {
  const { dom, calls } = buildHarness(t);
  await settle();

  dom.sendButton.remove();
  const pill = dom.documentRef.getElementById('homeAskPill');
  pill.value = 'nowhere to send this';
  pressKey(dom, pill, 'Enter');
  await settle();

  assert.deepEqual(calls.created, [], 'no orphan session is created');
  assert.equal(pill.value, 'nowhere to send this');
  assert.ok(calls.logs.some((entry) => entry.code === 'home.ask_send_unavailable'));
});

test('a models catalog failure still leaves a usable trigger', async (t) => {
  const { dom, calls } = buildHarness(t, { modelsFail: true, preferredModel: 'gpt-5.5' });
  await settle();

  assert.equal(chipLabel(dom), 'gpt-5.5', 'the chip falls back to the live pair');
  const popover = openPopover(dom);
  assert.ok(popover.querySelector('[data-ask-config="effort"]'), 'effort still gates off the model id');
  assert.ok(calls.logs.some((entry) => entry.code === 'home.ask_config_model_list_failed'));
});

/* The other half of the config threading: handleCreateSession normally reads
 * the LIVE runtime pair, and options.preferences is the additive override the
 * pill rides in on. Every existing caller passes nothing and must be
 * byte-identical to the live pair. */
/* F2. handleChipClick rendered the panel body, THEN kicked ensureModels(); when
 * the fetch resolved (~100ms later, panel open) the old code called
 * renderPopoverBody() again - wiping every control and the user's focus with
 * it. The comment on handleChipClick had said a rebuild while open must never
 * happen; the catalog path did it on every single open. */
test('a model list resolving while the panel is open updates options in place', async (t) => {
  let releaseCatalog;
  const catalog = new Promise((resolve) => { releaseCatalog = resolve; });
  const { dom } = buildHarness(t, {
    preferredModel: 'qwen3:8b',
    modelsPromise: catalog,
  });

  const popover = openPopover(dom);
  const bodyBefore = popover.innerHTML;
  const modelSelectBefore = popover.querySelector('[data-ask-config="model"]');
  const toggleBefore = popover.querySelector('.home-ask-config__toggle');
  assert.ok(modelSelectBefore && toggleBefore, 'the panel opened with its controls');

  // Reach for a control, exactly as a user would while the fetch is in flight.
  modelSelectBefore.focus();
  assert.equal(dom.documentRef.activeElement, modelSelectBefore);

  releaseCatalog({ data: OLLAMA_MODELS });
  await settle();

  assert.notEqual(popover.innerHTML, bodyBefore, 'the option list DID refresh');
  assert.equal(popover.querySelector('[data-ask-config="model"]'), modelSelectBefore,
    'but the select itself is the SAME node - the panel was not rebuilt');
  assert.equal(popover.querySelector('.home-ask-config__toggle'), toggleBefore,
    'and neither were the tool toggles');
  assert.equal(dom.documentRef.activeElement, modelSelectBefore,
    'so the focus the user placed survives');
  assert.deepEqual(
    [...modelSelectBefore.querySelectorAll('option')].map((option) => option.value),
    ['', 'qwen3:8b', 'gpt-5.5'],
    'the freshly listed models are there'
  );
  assert.equal(modelSelectBefore.value, 'qwen3:8b', 'and the selection is restored');
});

/* The clock-only tick must never rebuild an open ask-config panel. */
test('the clock-only tick does not rebuild the open panel', async (t) => {
  const { dom, intervalCallbacks } = buildHarness(t, { preferredModel: 'qwen3:8b' });
  await settle();

  const popover = openPopover(dom);
  const modelSelect = popover.querySelector('[data-ask-config="model"]');
  modelSelect.focus();

  assert.equal(intervalCallbacks.length, 1);
  intervalCallbacks[0]();
  await settle();

  assert.equal(popover.hidden, false, 'the panel is still open');
  assert.equal(popover.querySelector('[data-ask-config="model"]'), modelSelect,
    'and the same select node survived the clock tick');
  assert.equal(dom.documentRef.activeElement, modelSelect, 'focus with it');
});

/* F8. applyDraftToSession awaited handleCreateSession and then read
 * getCurrentSessionId(). If create resolved WITHOUT switching the active
 * session, the tool overrides landed on whatever chat the user was last in -
 * silently reconfiguring it. The only guard was `if (!sessionId) return`. */
test('tool overrides are not written when the session id did not change', async (t) => {
  const { dom, calls } = buildHarness(t, {
    currentSessionId: 'session-existing',
    // Resolves, but never switches the active session.
    createSwitches: false,
  });
  await settle();

  const pill = dom.documentRef.getElementById('homeAskPill');
  pill.value = 'which session does this configure?';
  pressKey(dom, pill, 'Enter');
  await settle();

  assert.equal(calls.created.length, 1, 'the create still ran');
  assert.deepEqual(calls.setPreferences, [],
    'but nothing was written against the session that did not change');
  assert.ok(
    calls.logs.some((entry) => entry.code === 'home.ask_session_unchanged' && entry.level === 'WARN'),
    'and the refusal is recorded rather than silent'
  );
  // The question is still delivered: a wrong tool set is recoverable from the
  // composer, so this must never cost the user their text.
  assert.equal(dom.chatInput.value, 'which session does this configure?');
  assert.equal(calls.sends, 1);
});

test('mergeRequestedRuntimePreferences overrides only the keys a caller supplies', () => {
  const { mergeRequestedRuntimePreferences } = lifecycleFormatUtils;
  const live = {
    preferredModel: 'qwen3:8b',
    reasoningEffort: 'default',
    planMode: true,
    contextPreferences: { historyScope: 'session' },
  };

  assert.equal(mergeRequestedRuntimePreferences(live, undefined), live, 'no override = the live object itself');
  assert.equal(mergeRequestedRuntimePreferences(live, null), live);
  assert.equal(mergeRequestedRuntimePreferences(live, 'nonsense'), live);

  const both = mergeRequestedRuntimePreferences(
    live,
    { preferred_model: 'gpt-5.5', reasoning_effort: 'HIGH' },
    reasoningEffortProfiles.normalizeReasoningEffort
  );
  assert.equal(both.preferredModel, 'gpt-5.5');
  assert.equal(both.reasoningEffort, 'high', 'the effort is normalized, not trusted');
  assert.equal(both.planMode, true, 'unrelated preferences ride through untouched');
  assert.deepEqual(both.contextPreferences, { historyScope: 'session' });

  const modelOnly = mergeRequestedRuntimePreferences(live, { preferred_model: 'gpt-5.5' });
  assert.equal(modelOnly.reasoningEffort, 'default', 'an absent key keeps the live value');
});

/* The controller unit, away from the manager: the draft is the ONLY thing an
 * edit touches, and dispose leaves no listener behind. */
test('the controller exposes the draft and disposes cleanly', async (t) => {
  const dom = createDom();
  const region = dom.documentRef.createElement('div');
  region.className = 'home-info-strip__ask';
  dom.infoStrip.append(region);

  const controller = askConfigModule.createAskConfigController({
    documentRef: dom.documentRef,
    shell: { models: { list: async () => ({ data: OLLAMA_MODELS }) } },
    getState: () => ({ features: { tools: { web: false } } }),
    getRuntimePreferences: () => ({ preferredModel: 'gpt-5.5', reasoningEffort: 'medium' }),
    inventory: buildInventory(),
    modules: { composerV2Model, reasoningEffortProfiles, lifecycleFormatUtils },
  });
  t.after(() => controller.dispose());
  controller.ensure(region);
  await settle();

  assert.deepEqual(controller.getDraft(), {
    preferredModel: 'gpt-5.5',
    reasoningEffort: 'medium',
    toolOverrides: {
      web_search: false, Bash: true, python_execute: true, file_tools: true,
    },
  });
  assert.deepEqual(controller.getSessionToolOverrides(), {
    web: false, terminal: true, python: true, files: true,
  });
  assert.equal(controller.isTouched(), false);

  openPopover(dom);
  setSelect(dom, 'effort', 'high');
  assert.equal(controller.isTouched(), true);
  assert.equal(controller.getDraft().reasoningEffort, 'high');

  controller.dispose();
  // After dispose the chip is inert: a click cannot reopen the popover.
  popoverOf(dom).hidden = true;
  chipOf(dom).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(popoverOf(dom).hidden, true, 'dispose unbinds the chip');
});
