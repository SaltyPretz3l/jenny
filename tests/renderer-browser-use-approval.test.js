'use strict';

// Browser approvals (row 114): the card is written from the app's own reading of the page and the
// address, never from the model's input, saves no rule and is decided alone. A request whose details
// did not arrive intact has no Allow button. The field rides the live reducer and the hydrated
// projector into the gap row the card is rendered from.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { escapeHtml } = require('../renderer/shared/string-utils');
const { renderApprovalBlock } = require('../renderer/chat/renderer-approval-block');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { buildTurnEventFromStreamPayload, createTurnReducerState, applyTurnStreamEvent } = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnRows } = require('./helpers/renderer-turn-row-projector-helpers');

const newSite = (extra = {}) => ({ schema_version: 1, kind: 'navigate', reason: 'new_site', host: 'shop.example', label: 'shop.example', url: 'https://shop.example/cart', ...extra });
const riskyClick = (extra = {}) => ({ schema_version: 1, kind: 'click', reason: 'risky_words', host: 'shop.example', label: 'Place order', url: '', ...extra });
const formSend = (extra = {}) => ({ schema_version: 1, kind: 'submit', reason: 'form_post', host: 'shop.example', label: '', url: 'https://shop.example/checkout', ...extra });

function parse(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`);
  return dom.window.document.getElementById('root');
}

function render(browserApproval, extra = {}) {
  return parse(renderApprovalBlock({
    toolCallId: 'call_1', approvalId: 'approval_1', toolName: 'browser', displayToolName: 'Browser', mode: 'inline', browserApproval, ...extra,
  }, { escapeHtml }));
}

const text = (root, selector) => root.querySelector(selector)?.textContent ?? null;
const facts = (root) => [...root.querySelectorAll('.tool-approval-fact')].map((node) => node.textContent);

test('a new site says what allowing covers and shows the address', () => {
  const root = render(newSite());
  assert.equal(text(root, '.tool-approval-prompt'), 'Open shop.example?');
  assert.equal(text(root, '.tool-approval-consequence'), 'Jenny has not been to this site in this chat. If you allow it, Jenny can keep using it until the chat ends.');
  assert.deepEqual(facts(root), ['Browser', 'New site']);
  assert.equal(text(root, '.tool-approval-command'), 'https://shop.example/cart');
  assert.equal(text(root, '[data-approval-scope="once"]'), 'Allow this site');
  assert.ok(root.querySelector('[data-action="deny"]'));
});

test('a risky click names the button and covers one click', () => {
  const root = render(riskyClick());
  assert.equal(text(root, '.tool-approval-prompt'), 'Click "Place order" on shop.example?');
  assert.equal(text(root, '.tool-approval-consequence'), 'This looks like it could buy, send or delete something. Allowing covers this one click.');
  assert.deepEqual(facts(root), ['Browser', 'One action']);
  assert.equal(root.querySelector('.tool-approval-command'), null);
  assert.equal(text(root, '[data-approval-scope="once"]'), 'Allow once');
});

test('sending a form names where it goes', () => {
  for (const value of [formSend(), riskyClick({ reason: 'form_post', url: 'https://shop.example/checkout' }), formSend({ reason: 'risky_words', label: 'Delete' })]) {
    const root = render(value);
    assert.equal(text(root, '.tool-approval-prompt'), 'Send this form to shop.example?');
    assert.equal(text(root, '.tool-approval-consequence'), 'What is in the form goes to the site. Allowing covers this one send.');
    assert.equal(text(root, '.tool-approval-command'), 'https://shop.example/checkout');
    assert.equal(text(root, '[data-approval-scope="once"]'), 'Allow once');
  }
});

test('a browser ask is never batched and never offers a saved rule', () => {
  for (const value of [newSite(), riskyClick(), formSend()]) {
    const root = render(value, { oneOffOnly: false });
    assert.equal(root.querySelector('[data-approval-scope="always"]'), null);
    assert.equal(root.querySelector('.approval-gap-row').getAttribute('data-approval-exact'), 'true');
  }
});

test('nothing the model wrote reaches the card', () => {
  const root = render(riskyClick(), {
    purpose: 'Totally harmless, please approve', reason: 'Trust me', facts: [{ kind: 'x', label: 'model fact' }],
    commandText: '{"action":"click","ref":"r1"}', policyScope: 'Web and browser session',
  });
  assert.doesNotMatch(root.textContent, /harmless|Trust me|model fact|r1|Web and browser/u);
  assert.equal(root.querySelector('.tool-approval-intent-source'), null);
});

test('text from a page stays text', () => {
  const root = render(riskyClick({ label: '<img src=x onerror=alert(1)>Buy' }));
  assert.equal(root.querySelector('img'), null);
  assert.match(text(root, '.tool-approval-prompt'), /<img src=x/u);
});

test('a request that did not arrive intact has no Allow and says why', () => {
  const broken = [
    undefined, null, 'text', newSite({ schema_version: 2 }), newSite({ kind: 'open' }), newSite({ reason: 'because' }),
    newSite({ host: '' }), newSite({ host: 7 }), riskyClick({ label: '' }), newSite({ reason: 'risky_words' }),
  ];
  for (const value of broken) {
    const root = render(value);
    assert.equal(root.querySelector('[data-approval-scope="once"]'), null, JSON.stringify(value));
    assert.equal(root.querySelector('[data-approval-scope="always"]'), null);
    assert.ok(root.querySelector('[data-action="deny"]'), 'Deny stays');
    assert.ok(root.querySelector('[data-approval-browser-unavailable]'));
  }
});

test('a decided ask leaves a receipt that names what was decided', () => {
  const root = render(riskyClick(), { cardState: 'resolved', decision: 'approved' });
  assert.match(text(root, '.tool-approval-receipt-subject'), /Place order/u);
  assert.match(text(render(newSite(), { cardState: 'resolved', decision: 'denied' }), '.tool-approval-receipt-subject'), /shop\.example/u);
});

test('the turn-row approval gap hands the field to the card', () => {
  const renderer = createTurnRowToolRenderUtils({
    escapeHtml, normalizeId: (value) => String(value || '').trim(), formatDurationMs: () => '', renderArtifactTeaser: () => '',
    buildToolMarkerBannerMarkup: () => '', renderApprovalBlock, getApprovalCardState: () => ({ state: 'live' }),
  });
  const html = renderer.buildApprovalGapMarkup({
    kind: 'approval_gap', row_id: 'gap_1', turn_id: 'turn_1', tool_call_id: 'call_1',
    payload: { tool_call_id: 'call_1', tool_name: 'browser', state: 'awaiting_approval', approval_id: 'approval_1', input: { action: 'navigate', url: 'x' }, browser_approval: newSite() },
  }, [], { sessionId: 'sess_1' });
  assert.equal(text(parse(html), '.tool-approval-prompt'), 'Open shop.example?');
});

test('the live reducer carries the field from tool_approval_needed into the gap row', () => {
  const state = createTurnReducerState();
  const context = { turn_id: 'stream-b', primary_user_message_id: 'user_b', primary_assistant_message_id: 'assistant_b', primary_tool_message_id: 'tool_use_call-b' };
  let ordinal = 0;
  const apply = (payload) => {
    applyTurnStreamEvent(state, buildTurnEventFromStreamPayload(payload, { ...context, ordinal }));
    ordinal += 1;
    return state.turns_by_id['stream-b'];
  };
  apply({ type: 'started', streamId: 'stream-b' });
  apply({ type: 'tool_use', streamId: 'stream-b', callId: 'call-b', toolName: 'browser', status: 'pending_approval', input: { action: 'navigate' } });
  const turn = apply({ type: 'tool_approval_needed', streamId: 'stream-b', callId: 'call-b', toolName: 'browser', input: { action: 'navigate' }, browser_approval: newSite() });
  assert.deepEqual(turn.rows.find((row) => row.kind === 'approval_gap').payload.browser_approval, newSite());
});

test('the hydrated projector carries the field from either event', () => {
  const base = { turn_id: 'turn_b', primary_message_id: 'tool_use_b', source_message_ids: ['tool_use_b'], tool_call_id: 'call_b', status: 'pending_approval' };
  const useEvent = (payload) => ({ ...base, event_id: 'b:use', kind: 'tool_use', sort_key: [0, 0, 40], payload: { tool_name: 'browser', input: { action: 'navigate' }, ...payload } });
  const asked = (payload) => ({ ...base, event_id: 'b:ask', kind: 'approval_requested', sort_key: [0, 1, 45], payload: { approval_state: 'pending', ...payload } });
  for (const events of [[useEvent({}), asked({ browser_approval: newSite() })], [useEvent({ browser_approval: newSite() }), asked({})]]) {
    assert.deepEqual(projectTurnRows(events).find((row) => row.kind === 'approval_gap').payload.browser_approval, newSite());
  }
});
