const test = require('node:test');
const assert = require('node:assert/strict');

const ToggleSwitch = require('../renderer/inventory/toggle-switch');
const Chip = require('../renderer/inventory/chip');
const Popover = require('../renderer/inventory/popover');
const {
  createComposerV2ToggleController,
  sessionToolOverrideEchoMatches,
} = require('../renderer/chat/renderer-composer-v2-toggle');

function createToggleController() {
  return createComposerV2ToggleController({ state: {} });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('setAvailableTools initializes categories', () => {
  const controller = createToggleController();
  controller.setAvailableTools(['web_search', 'Bash', 'Read', 'Write']);
  const states = controller.getToggleStates();
  assert.strictEqual(states.web_search, true);
  assert.strictEqual(states.Bash, true);
  assert.strictEqual(states.file_tools, true);
  assert.strictEqual(states.python_execute, undefined);
});

test('setToggle changes state', () => {
  const controller = createToggleController();
  controller.setAvailableTools(['web_search', 'Bash']);
  controller.setToggle('web_search', false);
  const states = controller.getToggleStates();
  assert.strictEqual(states.web_search, false);
  assert.strictEqual(states.Bash, true);
});

test('getToggleStates only includes available categories', () => {
  const controller = createToggleController();
  controller.setAvailableTools(['web_search']);
  const states = controller.getToggleStates();
  assert.ok('web_search' in states, 'web_search present');
  assert.ok(!('Bash' in states), 'Bash not present');
});

test('setAvailableTools keeps unavailable file tools visible but disabled', (t) => {
  const previousInventory = global.inventory;
  const controller = createToggleController();
  global.inventory = {
    toggleSwitch: ToggleSwitch.toggleSwitch,
    chip: Chip,
    popover: Popover,
  };
  t.after(() => {
    global.inventory = previousInventory;
  });
  controller.setAvailableTools([
    { name: 'read_file', available: false, reason: 'workspace requirement missing' },
    { name: 'grep_search', available: false, reason: 'workspace requirement missing' },
  ]);
  const states = controller.getToggleStates();
  assert.ok(!('file_tools' in states), 'blocked file tools are not sent as enabled preferences');
  const html = controller.renderToolToggles();
  assert.match(html, /tool-toggle-file_tools/);
  assert.match(html, /disabled/);
  assert.match(html, /workspace requirement missing/);
  assert.match(html, /aria-describedby="tool-toggle-file_tools-reason"/);
  assert.match(html, /id="tool-toggle-file_tools-reason"/);
});

test('fetch_url alone does not enable file tools', () => {
  const controller = createToggleController();
  controller.setAvailableTools(['fetch_url']);
  const states = controller.getToggleStates();
  assert.ok(!('file_tools' in states), 'network fetch is not filesystem availability');
});

test('list_dir enables file tools', () => {
  const controller = createToggleController();
  controller.setAvailableTools(['list_dir']);
  const states = controller.getToggleStates();
  assert.strictEqual(states.file_tools, true);
});

test('hydrateFromToolSettings seeds toggle state from persisted tools config', () => {
  const controller = createToggleController();
  controller.setAvailableTools(['web_search', 'Bash', 'Read', 'python_execute']);
  controller.hydrateFromToolSettings({
    web: false,
    bash: false,
    fileTools: true,
    pythonRuntime: true,
  });
  const states = controller.getToggleStates();
  assert.strictEqual(states.web_search, false, 'web hydrated off');
  assert.strictEqual(states.Bash, false, 'bash hydrated off');
  assert.strictEqual(states.file_tools, true, 'fileTools hydrated on');
  assert.strictEqual(states.python_execute, true, 'pythonRuntime hydrated on');
});

test('hydrateFromToolSettings ignores missing keys, non-booleans, and bad input', () => {
  const controller = createToggleController();
  controller.setAvailableTools(['web_search', 'Bash']);
  controller.setToggle('Bash', false);
  controller.hydrateFromToolSettings({ web: 'yes' });
  controller.hydrateFromToolSettings(null);
  controller.hydrateFromToolSettings([]);
  const states = controller.getToggleStates();
  assert.strictEqual(states.web_search, true, 'non-boolean web value ignored');
  assert.strictEqual(states.Bash, false, 'absent bash key keeps current state');
});

test('setToggle writes through to the captured current-session override key', async () => {
  const persisted = [];
  const controller = createComposerV2ToggleController({
    state: {},
    getCurrentSessionId: () => 'session-a',
    persistSessionToolPreference: (configKey, enabled, sessionId) => {
      persisted.push([configKey, enabled, sessionId]);
      return Promise.resolve();
    },
  });
  controller.setAvailableTools(['web_search', 'Bash', 'Read']);
  await Promise.all([
    controller.setToggle('web_search', false),
    controller.setToggle('Bash', true),
    controller.setToggle('file_tools', false),
  ]);
  assert.deepEqual(persisted, [
    ['web', false, 'session-a'],
    ['terminal', true, 'session-a'],
    ['files', false, 'session-a'],
  ]);
});

test('setToggle persist failure is reported and rolls back the optimistic session override', async () => {
  const errors = [];
  const controller = createComposerV2ToggleController({
    state: {},
    persistSessionToolPreference: () => Promise.reject(new Error('ipc down')),
    onPersistError: (error, categoryId) => errors.push([categoryId, error.message]),
  });
  controller.setAvailableTools(['web_search']);
  const persisted = await controller.setToggle('web_search', false);
  assert.equal(persisted, false);
  assert.deepEqual(errors, [['web_search', 'ipc down']]);
  assert.strictEqual(controller.getToggleStates().web_search, true, 'memory state rolled back');
});

test('session tool override acknowledgements require the target identity and every sibling', async () => {
  const requested = { web: true, terminal: false };
  assert.equal(sessionToolOverrideEchoMatches({
    id: 'session-a', tool_category_overrides: requested,
  }, 'session-a', requested), true);
  assert.equal(sessionToolOverrideEchoMatches({
    id: 'wrong', tool_category_overrides: requested,
  }, 'session-a', requested), false);
  assert.equal(sessionToolOverrideEchoMatches({
    id: 'session-a', tool_category_overrides: { web: true },
  }, 'session-a', requested), false);

  const errors = [];
  const controller = createComposerV2ToggleController({
    state: {},
    getCurrentSessionId: () => 'session-a',
    persistSessionToolPreference: async () => {
      if (!sessionToolOverrideEchoMatches({
        id: 'session-a', tool_category_overrides: { web: false },
      }, 'session-a', { web: false, terminal: false })) {
        throw new Error('mismatched acknowledgement');
      }
    },
    onPersistError: (error) => errors.push(error.message),
  });
  controller.setAvailableTools(['web_search']);
  const persisted = await controller.setToggle('web_search', false);
  assert.equal(persisted, false);
  assert.equal(controller.getToggleStates().web_search, true);
  assert.deepEqual(errors, ['mismatched acknowledgement']);
});

test('session override writes serialize so whole-map persistence cannot drop sibling changes', async () => {
  const firstWrite = deferred();
  const calls = [];
  const controller = createComposerV2ToggleController({
    state: {},
    getCurrentSessionId: () => 'session-a',
    persistSessionToolPreference: (configKey, enabled) => {
      calls.push([configKey, enabled]);
      return calls.length === 1 ? firstWrite.promise : Promise.resolve();
    },
  });
  controller.setAvailableTools(['web_search', 'Bash']);
  const webWrite = controller.setToggle('web_search', false);
  const terminalWrite = controller.setToggle('Bash', false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['web', false]], 'second write waits for the first acknowledgement');
  firstWrite.resolve();
  assert.equal(await webWrite, true);
  assert.equal(await terminalWrite, true);
  assert.deepEqual(calls, [['web', false], ['terminal', false]]);
});

test('a later failed override restores the last acknowledged value and source', async (t) => {
  withChipInventory(t);
  let writeCount = 0;
  const controller = createComposerV2ToggleController({
    state: {},
    getCurrentSessionId: () => 'session-a',
    persistSessionToolPreference: () => {
      writeCount += 1;
      return writeCount === 1 ? Promise.resolve() : Promise.reject(new Error('second write failed'));
    },
  });
  controller.setAvailableTools(['web_search']);
  controller.hydrateFromToolSettings({ web: true });
  assert.equal(await controller.setToggle('web_search', false), true);
  assert.equal(await controller.setToggle('web_search', true), false);
  assert.equal(controller.getToggleStates().web_search, false);
  assert.match(controller.renderToolToggles(), /Current chat override/);
});

test('setToggle for an unmapped category does not call the persistence bridge', () => {
  const persisted = [];
  const controller = createComposerV2ToggleController({
    state: {},
    persistSessionToolPreference: (configKey, enabled) => {
      persisted.push([configKey, enabled]);
      return Promise.resolve();
    },
  });
  controller.setToggle('made_up_category', true);
  assert.deepEqual(persisted, []);
});

function withChipInventory(t) {
  const previousInventory = global.inventory;
  const chip = require('../renderer/inventory/chip');
  global.inventory = {
    toggleSwitch: ToggleSwitch.toggleSwitch,
    chip,
    popover: (opts) => `<div id="${opts.domId || ''}" hidden>${opts.trustedHtml || ''}</div>`,
  };
  t.after(() => {
    global.inventory = previousInventory;
  });
}

test('tool popover labels effective values as settings defaults or current-chat overrides', async (t) => {
  withChipInventory(t);
  const controller = createComposerV2ToggleController({
    state: {},
    persistSessionToolPreference: () => Promise.resolve(),
  });
  controller.setAvailableTools(['web_search']);
  controller.hydrateFromToolSettings({ web: true });
  assert.match(controller.renderToolToggles(), /Settings default/);
  controller.setToggle('web_search', false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(controller.renderToolToggles(), /Current chat override/);
  assert.match(controller.renderToolToggles(), /Overrides apply to this chat/);
});

test('send-path coherence: getToggleStates reflects hydrated persisted state', () => {
  const controller = createToggleController();
  controller.setAvailableTools(['web_search', 'Bash', 'Read']);
  controller.hydrateFromToolSettings({ web: false, bash: true, fileTools: true });
  assert.deepEqual(controller.getToggleStates(), {
    web_search: false,
    Bash: true,
    file_tools: true,
  });
});
