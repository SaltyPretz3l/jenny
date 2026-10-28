'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createSlashCommandRegistry } = require('../renderer/shell/renderer-slash-command-registry');
const { createSendSlashDispatch } = require('../renderer/chat/renderer-skill-slash-commands');
const composer = require('../renderer/chat/renderer-composer-v2-state');
const { parsePromptArguments, createMcpPromptSlashCommands, getPendingPromptBlock,
  composePromptBlock } = require('../renderer/chat/renderer-mcp-prompt-slash-commands');

const single = { name: 'investigate_feature', description: 'Plan how to locate', arguments: [{ name: 'feature', required: true }] };
const pairs = { name: 'compare', arguments: [{ name: 'first', required: true }, { name: 'second', required: true }, { name: 'optional' }] };
const plain = { name: 'plain', description: 'No arguments', arguments: [] };
const mixed = { name: 'investigate', arguments: [{ name: 'feature', required: true }, { name: 'target_path' }, { name: 'document' }] };
const snapshot = (prompts = [single], overrides = {}) => ({ servers: [{ name: 'rea', enabled: true, trust: { status: 'approved' }, prompts, ...overrides }] });
const TYPED = { attachImageEditDraft: true };

test('prompt argument grammar covers rest of line, escaped pairs and no arguments', () => {
  assert.deepEqual(parsePromptArguments('  login workflow  ', single), { ok: true, values: { feature: 'login workflow' } });
  assert.deepEqual(parsePromptArguments('first="a \\"quote\\"" second="c\\\\d" optional="\\q"', pairs),
    { ok: true, values: { first: 'a "quote"', second: 'c\\d', optional: '\\q' } });
  assert.deepEqual(parsePromptArguments(' ', { arguments: [] }), { ok: true, values: {} });
  assert.deepEqual(parsePromptArguments('first="x"', { arguments: [{ name: 'first' }] }), { ok: true, values: { first: 'x' } });
  // The rea shape: one required argument among optional ones still takes the rest of the line.
  assert.deepEqual(parsePromptArguments('login flow', mixed), { ok: true, values: { feature: 'login flow' } });
  assert.deepEqual(parsePromptArguments('feature="login" document="spec.md"', mixed), { ok: true, values: { feature: 'login', document: 'spec.md' } });
  assert.deepEqual(parsePromptArguments('unknown="x"', mixed), { ok: true, values: { feature: 'unknown="x"' } });
  assert.deepEqual(parsePromptArguments('', mixed), { ok: false, code: 'argument_missing', argument: 'feature' });
});

test('invalid and missing prompt arguments name the offending or first missing argument', () => {
  for (const input of ['first="x" second="y" extra', 'first="x"second="y"', 'first="unterminated']) {
    assert.equal(parsePromptArguments(input, pairs).code, 'argument_invalid');
  }
  assert.deepEqual(parsePromptArguments('unknown="x"', pairs), { ok: false, code: 'argument_invalid', argument: 'unknown' });
  assert.deepEqual(parsePromptArguments('first="x" first="y"', pairs), { ok: false, code: 'argument_invalid', argument: 'first' });
  assert.deepEqual(parsePromptArguments('second="y"', pairs), { ok: false, code: 'argument_missing', argument: 'first' });
  assert.deepEqual(parsePromptArguments('first=" " second="y"', pairs), { ok: false, code: 'argument_missing', argument: 'first' });
  assert.deepEqual(parsePromptArguments('', single), { ok: false, code: 'argument_missing', argument: 'feature' });
  assert.deepEqual(parsePromptArguments('x'.repeat(4097), single), { ok: false, code: 'argument_invalid', argument: 'feature' });
  assert.equal(parsePromptArguments('first="' + 'x'.repeat(4097) + '"', pairs).code, 'argument_invalid');
  assert.equal(parsePromptArguments('extra', { arguments: [] }).code, 'argument_invalid');
});

function harness(t, options = {}) {
  const dom = new JSDOM('<div id="attachmentTray"><div id="composerSkillChip"></div></div><textarea id="chatInput"></textarea>');
  t.after(() => dom.window.close());
  const state = { currentSessionId: 's1', ui: {}, composerSessionState: new Map() };
  const toasts = [], calls = [], logs = [];
  const registry = createSlashCommandRegistry({ state, showToastMessage: text => toasts.push(text) });
  let current = snapshot(), renders = 0;
  const chatInput = dom.window.document.getElementById('chatInput');
  const manager = createMcpPromptSlashCommands({ state, registry, chatInput,
    getMcpState: () => current, getPrompt: async payload => { calls.push(payload); return { ok: true, text: 'Locate the login', chars: 16 }; },
    showToastMessage: text => toasts.push(text), renderComposerState: () => { renders += 1; }, log: (...args) => logs.push(args), ...options });
  t.after(() => manager.dispose());
  return { dom, state, registry, manager, chatInput, toasts, calls, logs, setState: next => { current = next; }, renders: () => renders };
}

test('approved enabled catalogs reconcile, retain on rejected reads, and dispose only owned entries', async t => {
  const h = harness(t);
  await h.manager.refresh();
  const row = h.registry.listCommands()[0];
  assert.equal(row.name, '/rea-investigate_feature');
  assert.equal(row.description, 'Plan how to locate · feature');
  assert.equal(row.tag, 'rea');
  assert.equal(row.action, 'insert'); // the palette fills the composer: the argument is still to type
  assert.equal(row.requiresSession, true);
  assert.equal(row.clearPolicy, 'on_success');
  h.setState(snapshot([pairs, plain])); await h.manager.refresh();
  assert.deepEqual(h.registry.listCommands().map(entry => [entry.name, entry.action]), [['/rea-compare', 'insert'], ['/rea-plain', 'run']]);
  h.setState(snapshot([single], { enabled: false })); await h.manager.refresh();
  assert.equal(h.registry.listCommands().length, 0);
  h.setState(snapshot([single], { trust: { status: 'pending' } })); await h.manager.refresh();
  assert.equal(h.registry.listCommands().length, 0);
  h.registry.register('/rea-investigate_feature', 'Existing', () => true);
  h.setState(snapshot()); await h.manager.refresh(); await h.manager.refresh();
  const skipped = h.logs.filter(log => log[1] === 'slash.prompt_registration_skipped' && log[2].command === '/rea-investigate_feature');
  assert.equal(skipped.length, 1); // a lasting collision warns once, not on every refresh
  h.manager.dispose(); assert.equal(h.registry.listCommands().length, 1);
  const absent = harness(t, { getMcpState: undefined, getPrompt: undefined });
  await absent.manager.refresh(); assert.equal(absent.registry.listCommands().length, 0);
  let fails = false;
  const retry = harness(t, { getMcpState: () => { if (fails) throw Error('offline'); return snapshot(); } });
  await retry.manager.refresh(); fails = true; await retry.manager.refresh();
  assert.equal(retry.registry.listCommands().length, 1);
});

test('opening the slash menu from the + menu refreshes the prompt catalog', async t => {
  const h = harness(t);
  assert.equal(h.registry.listCommands().length, 0);
  h.chatInput.dispatchEvent(new h.dom.window.CustomEvent('jenny:open-slash-menu', { detail: { kind: 'commands' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.registry.listCommands().map(entry => entry.name), ['/rea-investigate_feature']);
});

test('missing argument keeps command draft, toasts its name, and never calls bridge', async t => {
  const h = harness(t); await h.manager.refresh();
  const dispatch = createSendSlashDispatch({ state: h.state, registry: h.registry, chatInput: h.chatInput });
  t.after(() => dispatch.dispose());
  h.chatInput.value = '/rea-investigate_feature';
  const result = await dispatch.dispatch(h.chatInput.value, {});
  assert.equal(result.handled, true);
  assert.equal(h.chatInput.value, '/rea-investigate_feature');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.toasts, ['/rea-investigate_feature needs feature: write it after the command.']);
  h.setState(snapshot([pairs])); await h.manager.refresh();
  await h.registry.execute('/rea-compare first="a"').completion;
  assert.equal(h.toasts[1], '/rea-compare needs second too. Write it as second="…".');
});

test('bridge failures each toast once, including unsupported content and rejection', async t => {
  for (const code of ['sidecar_unavailable', 'server_not_found', 'server_disabled', 'not_approved', 'prompt_unknown', 'argument_invalid', 'argument_missing', 'prompt_unavailable', 'unsupported', 'reject']) {
    const h = harness(t, { getPrompt: async () => {
      if (code === 'reject') throw Error('sensitive');
      return { ok: false, error: { code: code === 'unsupported' ? 'prompt_unavailable' : code, argument: 'feature', reason: code === 'unsupported' ? 'prompt_content_unsupported' : 'request_failed' } };
    } });
    await h.manager.refresh();
    assert.equal((await h.registry.execute('/rea-investigate_feature login').completion).ok, false);
    assert.equal(h.toasts.length, 1, code);
    if (code === 'unsupported') assert.match(h.toasts[0], /only text/);
    if (code === 'not_approved') assert.match(h.toasts[0], /Approve the rea/);
    if (code === 'server_disabled') assert.match(h.toasts[0], /Turn the rea/);
    assert.equal(getPendingPromptBlock(h.state), null);
  }
});

test('success attaches frozen labelled text and removable inventory chip', async t => {
  const h = harness(t); await h.manager.refresh();
  const result = await h.registry.execute('/rea-investigate_feature login').completion;
  assert.equal(result.code, 'prompt_attached');
  const block = getPendingPromptBlock(h.state);
  assert.ok(Object.isFrozen(block));
  assert.deepEqual(h.calls, [{ name: 'rea', prompt: 'investigate_feature', arguments: { feature: 'login' } }]);
  assert.equal(composePromptBlock(block, 'hello'), '[rea prompt: investigate_feature]\nLocate the login\n\nhello');
  assert.equal(composePromptBlock(block, ''), '[rea prompt: investigate_feature]\nLocate the login');
  const chip = h.dom.window.document.querySelector('[data-inv-chip="prompt_pending"]');
  assert.ok(chip.classList.contains('composer-skill-chip'));
  assert.equal(chip.getAttribute('aria-label'), 'Prompt attached: investigate_feature. Remove');
  assert.match(chip.textContent, /rea · investigate_feature/);
  chip.click(); assert.equal(getPendingPromptBlock(h.state), null);
  assert.ok(h.renders() >= 2);
});

test('a fetch that resolves after a session switch attaches nothing and shows no success toast', async t => {
  let resolve;
  const h = harness(t, { getPrompt: () => new Promise(next => { resolve = next; }) });
  await h.manager.refresh();
  const completion = h.registry.execute('/rea-investigate_feature three').completion;
  while (!resolve) await new Promise(next => setImmediate(next));
  h.state.currentSessionId = 's2';
  resolve({ ok: true, text: 'Three', chars: 5 });
  assert.equal((await completion).code, 'session_changed');
  assert.deepEqual(h.toasts, []);
  h.state.currentSessionId = 's1';
  assert.equal(getPendingPromptBlock(h.state), null);
});

test('pending block belongs to its session and replacement has distinct identity', () => {
  const state = { currentSessionId: 's1', ui: {} };
  const first = composer.setPendingPromptBlock(state, { server: 'rea', prompt: 'p', text: 'text', chars: 4 });
  assert.equal(getPendingPromptBlock(state), first);
  const next = composer.setPendingPromptBlock(state, first);
  assert.notEqual(next, first);
  state.currentSessionId = 's2'; assert.equal(getPendingPromptBlock(state), null);
});

test('repainting an attachment tray does not duplicate the prompt chip', async t => {
  const h = harness(t); await h.manager.refresh();
  await h.registry.execute('/rea-investigate_feature login').completion;
  const chip = h.dom.window.document.querySelector('[data-inv-chip="prompt_pending"]');
  chip.parentElement.replaceWith(chip);
  h.manager.paintChip();
  assert.equal(h.dom.window.document.querySelectorAll('[data-inv-chip="prompt_pending"]').length, 1);
});

test('the browser build resolves composer state that loads after the module', () => {
  // index.html loads renderer-composer-v2-state.js after this module; the require branch hides that.
  const context = vm.createContext({ console });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat', 'renderer-mcp-prompt-slash-commands.js'), 'utf8'), context);
  const browser = context.rendererMcpPromptSlashCommands;
  const state = { currentSessionId: 's1', ui: {} };
  assert.equal(browser.getPendingPromptBlock(state), null);
  context.rendererComposerV2State = composer;
  const block = composer.setPendingPromptBlock(state, { server: 'rea', prompt: 'p', text: 'text' });
  assert.equal(browser.getPendingPromptBlock(state), block);
  const manager = browser.createMcpPromptSlashCommands({ state });
  assert.equal(manager.consume(block), true);
  assert.equal(browser.getPendingPromptBlock(state), null);
});

function sendHarness(t, options = {}) {
  const { createSendController } = require('../renderer/chat/renderer-send-utils');
  const { createControllerHarness } = require('./helpers/send-controller-harness');
  const dom = new JSDOM('<div id="attachmentTray"></div><textarea id="chatInput"></textarea>');
  const chatInput = dom.window.document.getElementById('chatInput');
  const base = createControllerHarness([], { ...options, chatInput });
  const { state, calls } = base;
  const registry = createSlashCommandRegistry({ state });
  const manager = createMcpPromptSlashCommands({ state, registry, chatInput,
    getMcpState: () => snapshot(), getPrompt: async () => ({ ok: true, text: 'Locate the login', chars: 16 }),
    renderComposerState: () => manager.paintChip(),
  });
  const noop = () => {};
  const controller = createSendController({ state, dom: { chatInput }, promptCommands: manager,
    slashCommandRegistry: registry, multiStreamController: base.multiStreamController,
    constants: { INTERACTIVE_SEQUENCE_IDLE: 'idle', TOAST_SOURCE: { attachments: 'attachments' } },
    callbacks: {
      getActiveSession: () => state.sessions[0], getPendingQuestionBatch: () => null,
      normalizePendingQuestionBatch: () => null, shouldForceInteractiveGuardrail: () => false,
      getInteractiveSequenceState: () => 'idle', clearInteractiveDraft: noop, patchSessionSummary: noop,
      getCurrentRuntimePreferences: () => ({ runMode: 'ask', contextPreferences: {} }),
      getCurrentVisibleMessages: () => [], getCurrentSessionMessages: () => [],
      getSessionMessages: id => state.messagesBySession.get(id) || [],
      setSessionMessages: (id, messages) => state.messagesBySession.set(id, messages),
      createNormalizedMessage: (role, content, extra) => ({ role, content, ...extra }),
      resolveSessionId: id => id, buildAttachmentBudget: entries => ({ accepted: entries, skipped: [] }),
      resetAttachmentQueue: noop, showToastMessage: noop, setComposerStatusNotice: noop,
      clearComposerStatusNotice: noop, showComposerActionError: error => calls.errors.push(error),
      renderComposerState: () => manager.paintChip(), syncComposerInputHeight: noop, syncComposerVisualState: noop,
      setFollowLatest: noop, appendClientLog: noop, refreshSessionSummaries: async () => ({}),
      thinkingController: { resumeAutoScroll: noop }, optimisticAppend: noop,
      flushBufferedStreamEvents: async () => ({}), dropBufferedStreamEvents: noop, isSendBusy: () => false,
      isSessionStreaming: () => false, hasPendingToolApprovalForSession: () => false,
    },
  });
  t.after(() => { controller.dispose(); base.controller.dispose(); manager.dispose(); base.restore(); dom.window.close(); });
  return { state, calls, controller, manager, chatInput, dom, base };
}

test('real send entry attaches the command then carries the block in the model-facing prompt only', async t => {
  const h = sendHarness(t);
  await h.manager.refresh();
  h.chatInput.value = '/rea-investigate_feature login';
  assert.equal(await h.controller.startPromptSend(h.chatInput.value, TYPED), null);
  assert.equal(h.calls.startStream.length, 0);
  assert.equal(h.chatInput.value, '');
  assert.ok(getPendingPromptBlock(h.state));
  h.chatInput.value = 'Now investigate';
  const result = await h.controller.startPromptSend(h.chatInput.value, TYPED);
  assert.equal(result.streamId, 'stream-regen');
  assert.equal(h.calls.startStream[0].prompt, '[rea prompt: investigate_feature]\nLocate the login\n\nNow investigate');
  assert.equal(h.calls.startStream[0].visiblePrompt, 'Now investigate');
  assert.equal(getPendingPromptBlock(h.state), null);
  assert.equal(h.dom.window.document.querySelector('[data-inv-chip="prompt_pending"]'), null);
});

test('a rejected typed send restores the user text alone and consumes its block', async t => {
  const h = sendHarness(t, { startStream: async () => { throw Error('offline'); } });
  const block = composer.setPendingPromptBlock(h.state, { server: 'rea', prompt: 'p', text: 'Instructions', chars: 12 });
  h.manager.paintChip(); h.chatInput.value = 'hello';
  assert.equal(await h.controller.startPromptSend('hello', TYPED), null);
  assert.equal(h.chatInput.value, 'hello'); // a second Send cannot carry the block twice
  assert.equal(getPendingPromptBlock(h.state), null);
  assert.equal(h.dom.window.document.querySelector('[data-inv-chip="prompt_pending"]'), null);
  assert.equal(h.manager.consume(block), false);
});

test('sends the user did not type leave the block pending and carry no block', async t => {
  const h = sendHarness(t);
  const block = composer.setPendingPromptBlock(h.state, { server: 'rea', prompt: 'p', text: 'Instructions', chars: 12 });
  h.manager.paintChip();
  const edited = await h.controller.startPromptSend('edited', { editedMessageId: 'user-1' });
  assert.equal(edited.streamId, 'stream-regen');
  assert.equal(h.calls.editAndRegenerate[0].prompt, 'edited');
  assert.equal(getPendingPromptBlock(h.state), block);
  assert.ok(h.dom.window.document.querySelector('[data-inv-chip="prompt_pending"]'));
  const other = sendHarness(t); // a fresh session: the edit above left the first one streaming
  const pending = composer.setPendingPromptBlock(other.state, { server: 'rea', prompt: 'p', text: 'Instructions', chars: 12 });
  assert.equal((await other.controller.startPromptSend('elaborate on that')).streamId, 'stream-regen'); // Elaborate, interactive answers, startup sends
  assert.equal(other.calls.startStream[0].prompt, 'elaborate on that');
  assert.equal(getPendingPromptBlock(other.state), pending);
});

test('a typed send queued behind a live turn consumes the block and stores it on the entry', async t => {
  const h = sendHarness(t);
  h.base.multiStreamController.registerStream('session-1', 'stream-active');
  const block = composer.setPendingPromptBlock(h.state, { server: 'rea', prompt: 'p', text: 'Instructions', chars: 12 });
  h.manager.paintChip(); h.chatInput.value = 'later';
  assert.deepEqual(await h.controller.startPromptSend('later', TYPED), { queued: true, sessionId: 'session-1' });
  const queued = h.state.queuedSendBySession.get('session-1');
  assert.equal(queued.prompt, 'later');
  assert.deepEqual(queued.meta.promptBlock, block); // the stash stores a structural copy
  assert.equal(getPendingPromptBlock(h.state), null);
  assert.equal(h.chatInput.value, '');
  // The outbox dispatch replays the entry's own copy, so a replacement block is not picked up.
  const replacement = composer.setPendingPromptBlock(h.state, { server: 'rea', prompt: 'q', text: 'Other' });
  h.base.multiStreamController.clearStream('stream-active');
  const drained = await h.controller.startPromptSend('later', { outboxDispatch: true, promptBlock: block, sessionIdOverride: 'session-1', preserveComposerDraft: true });
  assert.equal(drained.streamId, 'stream-regen');
  assert.equal(h.calls.startStream[0].prompt, '[rea prompt: p]\nInstructions\n\nlater');
  assert.equal(getPendingPromptBlock(h.state), replacement);
});

test('a pending prompt alone does not start a send through the real entry', async t => {
  const h = sendHarness(t);
  const block = composer.setPendingPromptBlock(h.state, { server: 'rea', prompt: 'p', text: 'Instructions' });
  assert.equal(await h.controller.startPromptSend('', TYPED), null);
  assert.equal(h.calls.startStream.length, 0);
  assert.equal(getPendingPromptBlock(h.state), block);
});

test('consume clears by block identity, preserving a replacement made since', async t => {
  const h = harness(t);
  const first = composer.setPendingPromptBlock(h.state, { server: 'rea', prompt: 'p', text: 'first' });
  assert.equal(h.manager.consume(null), false);
  const next = composer.setPendingPromptBlock(h.state, { ...first, text: 'next' });
  assert.equal(h.manager.consume(first), false);
  assert.equal(getPendingPromptBlock(h.state), next);
  h.state.currentSessionId = 's2';
  assert.equal(h.manager.consume(next), true);
  assert.equal(composer.ensureComposerV2State(h.state).pendingPromptBlock, null);
});
