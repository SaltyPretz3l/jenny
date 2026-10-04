'use strict';

// renderer/app.js resolves its dependencies through
// rendererBootstrapUtils.resolveShellModules(window). It replaced the two
// silent fallback registries (renderer-fallback-registry.js and
// renderer-fallback-workspace-registry.js, deleted 2026-09-25): a module that
// fails to load must now stop the boot with its name, never run on stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveShellModules } = require('../renderer/shell/renderer-bootstrap-utils');
const { SCRIPT_ORDER } = require('./helpers/renderer-shell-harness-support');
const { loadRendererApp } = require('./helpers/renderer-shell-harness');

test('every shell dependency resolves from a real module that index.html loads', async (t) => {
  assert.equal(SCRIPT_ORDER.some((src) => src.includes('renderer-fallback')), false, 'fallback registries stay deleted');
  const app = await loadRendererApp();
  t.after(() => app.dispose());
  const { window } = app;
  const resolved = resolveShellModules(window);
  const undefinedKeys = Object.keys(resolved).filter((key) => resolved[key] === undefined);
  assert.deepEqual(undefinedKeys, []);
  // Spot-check identity: the shell gets the module's own functions, not copies.
  assert.equal(resolved.normalizeChatMessage, window.chatMessageUtils.normalizeChatMessage);
  assert.equal(resolved.isChatNearBottom, window.chatScrollUtils.isNearBottom);
  assert.equal(resolved.workspaceStateUtils, window.rendererWorkspaceStateUtils);
  assert.equal(resolved.createSlashCommandRegistry, window.rendererSlashCommandRegistryUtils.createSlashCommandRegistry);
  assert.deepEqual({ ...resolved.MESSAGE_STATUS }, { STREAMING: 'streaming', COMPLETE: 'complete', ERROR: 'error' });
  // The interactive constants the fallback registry alone used to supply.
  assert.equal(resolved.MAX_INTERACTIVE_QUESTIONS, 5);
  assert.equal(resolved.MAX_INTERACTIVE_ROUNDS, 3);
  assert.equal(resolved.INTERACTIVE_SEQUENCE_IDLE, 'idle');
  assert.equal(resolved.INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE, 'structured_active');
  assert.equal(resolved.INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED, 'fallback_requested');
  assert.match(resolved.INTERACTIVE_GUARDRAIL_PROMPT, /^Using the information already collected/);
});

test('a missing module fails loudly with the window global it expected', async (t) => {
  const app = await loadRendererApp();
  t.after(() => app.dispose());
  const { window } = app;
  const partial = Object.create(window);
  Object.defineProperty(partial, 'chatbarUtils', { value: undefined });
  assert.throws(() => resolveShellModules(partial), /required module window\.chatbarUtils is not loaded/);
  const noMember = Object.create(window);
  Object.defineProperty(noMember, 'activityDomUtils', { value: { applyActivityAttributes() {} } });
  assert.throws(() => resolveShellModules(noMember), /required member window\.activityDomUtils\.isBusy is missing/);
});
