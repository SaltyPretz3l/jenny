'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlashCommandRegistry } = require('../renderer/shell/renderer-slash-command-registry');
const { createSkillSlashCommands, createSendSlashDispatch } = require('../renderer/chat/renderer-skill-slash-commands');
const composerState = require('../renderer/chat/renderer-composer-v2-state');

function snapshot(entries) {
  return { scopes: [{ scope: 'bundled', enabled: true, entries }] };
}

test('skill commands register, diff, unregister, and log deterministic collisions', async () => {
  const logs = [];
  const listeners = [];
  let current = snapshot([
    { id: 'bundled/verify', name: 'Verifier', description: 'Check work', command: 'verify', enabled: true },
    { id: 'bundled/collision', name: 'Collision', description: 'Duplicate', command: 'verify', enabled: true },
    { id: 'bundled/help', name: 'Bad help', description: 'Reserved', command: 'help', enabled: true },
    { id: 'bundled/off', name: 'Off', description: 'Disabled', command: 'off', enabled: false },
  ]);
  const registry = createSlashCommandRegistry({ state: { currentSessionId: '' } });
  registry.register('/help', 'Help', () => {}, { requiresSession: false });
  const manager = createSkillSlashCommands({
    registry,
    getSkillsState: () => current,
    onChanged: (listener) => { listeners.push(listener); return () => listeners.splice(0); },
    log: (...args) => logs.push(args),
  });
  await manager.refresh();
  assert.deepEqual(registry.listCommands().map((row) => row.name), ['/help', '/verify']);
  assert.ok(logs.some((entry) => entry[1] === 'slash.skill_command_collision'
    && entry[2].firstId === 'bundled/verify' && entry[2].secondId === 'bundled/collision'));
  assert.ok(logs.some((entry) => entry[2].firstId === 'builtin/help'));

  current = snapshot([{ id: 'bundled/mermaid', name: 'Mermaid', description: 'Draw diagrams', command: 'mermaid', enabled: true }]);
  listeners[0](current);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(registry.listCommands().map((row) => row.name), ['/help', '/mermaid']);
  manager.dispose();
  assert.deepEqual(registry.listCommands().map((row) => row.name), ['/help']);
});

test('send slash dispatch attaches, strips the token, carries the full invocation, and clears only on acceptance', async () => {
  const state = { currentSessionId: 's1', ui: {}, composerSessionState: new Map([['s1', { generation: 1 }]]) };
  const chatInput = { value: '/verify check this', focusCalls: 0, focus() { this.focusCalls += 1; } };
  const registry = createSlashCommandRegistry({ state });
  const skill = { id: 'bundled/verify', name: 'Verifier', scope: 'bundled', command: 'verify' };
  registry.register('/verify', 'Check work', null, { action: 'attach', skill });
  let renders = 0;
  const dispatch = createSendSlashDispatch({
    state, registry, chatInput, renderComposerState: () => { renders += 1; },
  });
  const result = await dispatch.dispatch('/verify check this', {});
  assert.equal(result.handled, false);
  assert.equal(result.prompt, 'check this');
  assert.deepEqual(result.settings.skillInvocation, skill);
  assert.equal(chatInput.value, 'check this');
  assert.deepEqual(composerState.getPendingSkillInvocation(state), skill);
  assert.equal(dispatch.clearAccepted({ queued: true }, skill, {}), false);
  assert.deepEqual(composerState.getPendingSkillInvocation(state), skill);
  assert.equal(dispatch.clearAccepted({ streamId: 'stream-1' }, skill, {}), true);
  assert.equal(composerState.getPendingSkillInvocation(state), null);
  assert.ok(renders >= 2);
  dispatch.dispose();
});

test('empty attach remainder focuses without sending and pending chips do not decorate edits', async () => {
  const state = { currentSessionId: 's1', ui: {}, composerSessionState: new Map() };
  const chatInput = { value: '/verify', focusCalls: 0, focus() { this.focusCalls += 1; } };
  const registry = createSlashCommandRegistry({ state });
  const skill = { id: 'bundled/verify', name: 'Verifier', scope: 'bundled', command: 'verify' };
  registry.register('/verify', 'Check work', null, { action: 'attach', skill });
  const dispatch = createSendSlashDispatch({ state, registry, chatInput });
  const attached = await dispatch.dispatch('/verify', {});
  assert.equal(attached.handled, true);
  assert.equal(chatInput.value, '');
  assert.equal(chatInput.focusCalls, 1);
  const later = await dispatch.dispatch('hello', {});
  assert.deepEqual(later.settings.skillInvocation, skill);
  const edit = await dispatch.dispatch('edited text', { editedMessageId: 'user-1' });
  assert.equal(edit.settings.skillInvocation, undefined);
  dispatch.dispose();
});

const { JSDOM } = require('jsdom');
const { attachSkillInvocation, renderSkillChip } = require('../renderer/chat/renderer-skill-slash-commands');

function chipHarness() {
  const dom = new JSDOM('<!doctype html><html><body><div id="composerSkillChip" class="hidden"></div><textarea id="chatInput"></textarea></body></html>');
  const doc = dom.window.document;
  const state = { currentSessionId: 's1', ui: {}, composerSessionState: new Map([['s1', { generation: 1 }]]) };
  const registry = createSlashCommandRegistry({ state });
  const skill = { id: 'bundled/verify', name: 'Verifier', scope: 'bundled', command: 'verify' };
  registry.register('/verify', 'Check evidence', null, { action: 'attach', skill });
  return { dom, doc, state, registry, skill, chatInput: doc.getElementById('chatInput'), host: doc.getElementById('composerSkillChip') };
}

test('attaching renders a removable composer chip and removing it clears the pending skill', async () => {
  const h = chipHarness();
  const slash = createSendSlashDispatch({ state: h.state, registry: h.registry, chatInput: h.chatInput });
  h.chatInput.value = '/verify';
  const result = await slash.dispatch('/verify', {});
  assert.equal(result.handled, true);
  assert.equal(h.host.classList.contains('hidden'), false);
  const chip = h.host.querySelector('[data-inv-chip="skill_pending"]');
  assert.ok(chip, 'chip button rendered');
  assert.equal(chip.getAttribute('aria-label'), 'Skill attached: Verifier. Remove');
  assert.match(chip.textContent, /Verifier/);
  chip.click();
  assert.equal(composerState.getPendingSkillInvocation(h.state), null);
  assert.equal(h.host.classList.contains('hidden'), true);
  assert.equal(h.host.innerHTML, '');
  slash.dispose();
});

test('palette attach sets the chip without touching the composer draft', () => {
  const h = chipHarness();
  h.chatInput.value = 'please review the auth refactor';
  const attached = attachSkillInvocation({ state: h.state, skill: h.skill, document: h.doc });
  assert.deepEqual(attached, h.skill);
  assert.equal(h.chatInput.value, 'please review the auth refactor');
  assert.equal(h.host.classList.contains('hidden'), false);
});

test('a pending skill belongs to the session that attached it and the chip follows a switch', () => {
  const h = chipHarness();
  attachSkillInvocation({ state: h.state, skill: h.skill, document: h.doc });
  h.state.currentSessionId = 's2';
  assert.equal(composerState.getPendingSkillInvocation(h.state), null);
  assert.equal(renderSkillChip({ state: h.state, document: h.doc }), null);
  assert.equal(h.host.classList.contains('hidden'), true);
});

test('an outbox replay keeps the skill captured at queue time instead of the one pending now', async () => {
  const h = chipHarness();
  const slash = createSendSlashDispatch({ state: h.state, registry: h.registry, chatInput: h.chatInput });
  attachSkillInvocation({ state: h.state, skill: { ...h.skill, id: 'bundled/mermaid', name: 'Mermaid', command: 'mermaid' }, document: h.doc });
  const replay = await slash.dispatch('do X', { outboxDispatch: true });
  assert.equal(replay.settings.skillInvocation, undefined);
  const live = await slash.dispatch('do Y', {});
  assert.equal(live.settings.skillInvocation.id, 'bundled/mermaid');
  slash.dispose();
});
