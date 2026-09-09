'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createCommandSandboxController } = require('../renderer/shell/renderer-settings-command-sandbox.js');
const { formatToolResultMeta } = require('../renderer/chat/tool-call-utils.js');

function inventoryFixture() {
  return {
    toggleSwitch(options = {}) {
      return `<label class="inv-toggle"><button type="button" role="switch" data-inv-toggle="${options.id || ''}" aria-checked="${options.checked ? 'true' : 'false'}"${options.disabled ? ' disabled' : ''}>toggle</button><span>${options.label || ''}</span></label>`;
    },
    statusRow(options = {}) {
      return `<div class="inv-status-row" data-status-tone="${options.tone || ''}" role="status">${options.label || ''} ${options.message || ''}</div>`;
    },
    actionButton(options = {}) {
      return `<button type="button" data-action="${options.id || ''}"${options.disabled ? ' disabled' : ''}>${options.label || ''}</button>`;
    },
  };
}

function harness(bridge, options = {}) {
  const dom = new JSDOM('<!doctype html><div id="toolsCommandSandboxHost"></div>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const host = dom.window.document.getElementById('toolsCommandSandboxHost');
  const controller = createCommandSandboxController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    host,
    bridge,
    inventory: inventoryFixture(),
    ...options,
  });
  return { dom, host, controller };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('renders every command sandbox state and keeps non-Windows platforms unqualified', async () => {
  const statuses = ['disabled', 'unavailable', 'preparing', 'ready', 'busy', 'recovery-required'];
  for (const state of statuses) {
    const bridge = {
      async getState() {
        return { enabled: state !== 'disabled', state, platform: 'windows', qualified: true };
      },
    };
    const { dom, host, controller } = harness(bridge);
    controller.bind();
    await settle();
    assert.equal(host.dataset.commandSandboxState, state);
    assert.match(host.textContent, new RegExp(state === 'recovery-required' ? 'Recovery required' : state, 'i'));
    if (state === 'unavailable' || state === 'recovery-required') {
      assert.ok(host.querySelector('[data-action="commandSandboxRetry"]'));
    } else {
      assert.equal(host.querySelector('[data-action="commandSandboxRetry"]'), null);
    }
    controller.dispose();
    dom.window.close();
  }

  const bridge = {
    async getState() {
      return { enabled: true, state: 'ready', platform: 'linux', qualified: true };
    },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  assert.equal(host.dataset.commandSandboxQualified, 'false');
  assert.match(host.textContent, /Linux\/macOS support is unverified/i);
  controller.dispose();
  dom.window.close();
});

test('surfaces IPC load failures and keeps retry actionable', async () => {
  const bridge = {
    async getState() {
      throw new Error('Docker daemon is unavailable');
    },
    async retry() {
      return { enabled: true, state: 'ready', platform: 'windows', qualified: true };
    },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  assert.equal(host.dataset.commandSandboxState, 'unavailable');
  assert.match(host.textContent, /Docker daemon is unavailable/);
  const retry = host.querySelector('[data-action="commandSandboxRetry"]');
  assert.ok(retry);
  retry.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(host.dataset.commandSandboxState, 'ready');
  controller.dispose();
  dom.window.close();
});

test('toggle shows a pending preparation state and sends the closed IPC shape', async () => {
  let resolveSetEnabled;
  const calls = [];
  const bridge = {
    async getState() {
      return { enabled: false, state: 'disabled', platform: 'windows', qualified: true };
    },
    setEnabled(payload) {
      calls.push(payload);
      return new Promise((resolve) => { resolveSetEnabled = resolve; });
    },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  const track = host.querySelector('[data-inv-toggle="commandSandboxEnabled"]');
  track.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
    bubbles: true,
    detail: { id: 'commandSandboxEnabled', checked: true },
  }));
  await settle();
  assert.deepEqual(calls, [{ enabled: true }]);
  assert.equal(host.dataset.commandSandboxState, 'preparing');
  assert.equal(host.querySelector('[data-inv-toggle="commandSandboxEnabled"]').disabled, true);
  resolveSetEnabled({ enabled: true, state: 'ready', platform: 'windows', qualified: true });
  await settle();
  assert.equal(host.dataset.commandSandboxState, 'ready');
  assert.equal(host.querySelector('[data-inv-toggle="commandSandboxEnabled"]').disabled, false);
  controller.dispose();
  dom.window.close();
});

test('surfaces a toggle IPC error and leaves retry available', async () => {
  const bridge = {
    async getState() {
      return { enabled: false, state: 'disabled', platform: 'windows', qualified: true };
    },
    async setEnabled() {
      throw new Error('profile write failed');
    },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  host.querySelector('[data-inv-toggle="commandSandboxEnabled"]').dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
    bubbles: true,
    detail: { id: 'commandSandboxEnabled', checked: true },
  }));
  await settle();
  assert.equal(host.dataset.commandSandboxState, 'unavailable');
  assert.match(host.textContent, /profile write failed/);
  assert.ok(host.querySelector('[data-action="commandSandboxRetry"]'));
  controller.dispose();
  dom.window.close();
});

test('dispose unsubscribes and fences late bridge state updates', async () => {
  let listener;
  let resolveState;
  let unsubscribeCalls = 0;
  const bridge = {
    getState() {
      return new Promise((resolve) => { resolveState = resolve; });
    },
    onChanged(callback) {
      listener = callback;
      return () => { unsubscribeCalls += 1; };
    },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  controller.dispose();
  resolveState({ enabled: true, state: 'ready', platform: 'windows', qualified: true });
  listener({ enabled: true, state: 'ready', platform: 'windows', qualified: true });
  await settle();
  assert.equal(unsubscribeCalls, 1);
  assert.equal(host.dataset.commandSandboxState, 'disabled');
  assert.doesNotMatch(host.textContent, /Docker sandbox is ready/);
  dom.window.close();
});

test('formats persisted Docker execution metadata only for run_command', () => {
  const metadata = {
    execution: {
      backend: 'docker',
      job_id: 'job-123',
      status: 'completed',
      exit_code: 0,
      output_truncated: true,
      cleanup_confirmed: true,
      workspace: 'disposable_copy',
    },
  };
  assert.equal(
    formatToolResultMeta('run_command', metadata),
    'Docker sandbox · Completed · exit 0 · output truncated',
  );
  assert.equal(formatToolResultMeta('write_file', metadata), '');
  // Rehydration can call the formatter more than once; metadata remains a
  // read-only presentation input and keeps the same result.
  assert.equal(formatToolResultMeta('run_command', metadata), 'Docker sandbox · Completed · exit 0 · output truncated');
});
