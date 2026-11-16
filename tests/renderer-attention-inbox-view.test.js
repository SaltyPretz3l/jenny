'use strict';

/**
 * tests/renderer-attention-inbox-view.test.js
 *
 * Runtime UX A3 (JEN-045) view gate -- what the "Needs you" section LOOKS like
 * and what one render pass costs. The behavioural contract (the approval-id
 * bridge, "Already resolved", dispose, the real boot) is
 * tests/renderer-attention-inbox.test.js; this file pins the restyle the owner
 * approved on 2026-09-16 (Direction A): the section is another native group of
 * the Chats panel -- the panel's own kicker, plain rows with no border, no
 * surface and no pill, one uniform muted line instead of facts coloured by
 * kind, text decisions, and a titlebar mark shaped like the health pill -- each
 * row's title opens its conversation, and the two pinned sections share the
 * panel with the chat list without ever clipping it. It also pins the cost:
 * render() rides the workspace-chrome pass, which during streaming is every
 * frame, so an unchanged source fingerprint must build no model at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createAttentionInboxController } = require('../renderer/shell/renderer-attention-inbox');
const inventoryActionButton = require('../renderer/inventory/action-button');

const ROOT = path.resolve(__dirname, '..');
const MARKUP = '<div class="titlebar-brand">'
  + '<div class="workbench-health-pill-slot" id="workbenchHealthPillSlot"></div>'
  + '</div>'
  + '<div class="sidebar-history-content" id="sidebarHistoryContent">'
  + '<div class="attention-inbox" id="attentionInbox" hidden></div>'
  + '<div class="conversation-groups" id="conversationGroups"></div>'
  + '</div>';
// The collapsed strip's own controls, as renderer-chats-strip.js builds them.
const STRIP_MARKUP = '<div class="chats-strip" id="chatsStrip">'
  + '<button id="chatsStripPanelToggle">Expand</button>'
  + '<button id="chatsStripNeedsYou" aria-expanded="false">mark</button>'
  + '</div>';

function harness(options = {}) {
  const dom = new JSDOM(MARKUP + (options.strip ? STRIP_MARKUP : ''), { url: 'https://jenny.local/' });
  const { window } = dom;
  const approveCalls = [];
  const denyCalls = [];
  const openCalls = [];
  const viewCalls = [];
  const collapseCalls = [];
  window.jennyShell = {
    tools: {
      approve: (...args) => { approveCalls.push(args); return Promise.resolve(true); },
      deny: (...args) => { denyCalls.push(args); return Promise.resolve(true); },
    },
  };
  const state = {
    currentSessionId: options.currentSessionId || '',
    sessions: options.sessions || [],
    pendingToolApprovals: options.pendingToolApprovals || new Map(),
    ui: { activeView: options.activeView || 'chat' },
  };
  const controller = createAttentionInboxController({
    windowRef: window,
    documentRef: window.document,
    state,
    host: window.document.getElementById('attentionInbox'),
    badgeAnchor: window.document.getElementById('workbenchHealthPillSlot'),
    actionButton: inventoryActionButton,
    facts: {
      getApprovalFacts: (_toolName, input) => (input?.path ? [{ kind: 'write', label: `Writes ${input.path}` }] : []),
      getApprovalCommandPreview: (_toolName, input) => String(input?.command || input?.path || ''),
    },
    callbacks: {
      openSession: (sessionId) => openCalls.push(sessionId),
      setActiveView: (viewId) => viewCalls.push(viewId),
      setSidebarCollapsed: (value) => collapseCalls.push(value),
    },
    getAttentionInbox: options.getAttentionInbox,
  });
  // Compared, never interpolated: a key may carry selector metacharacters.
  const rowFor = (key) => [...window.document.querySelectorAll('.attention-inbox__row')]
    .find((node) => node.dataset.attentionKey === key) || null;

  return {
    window, document: window.document, state, controller, approveCalls, denyCalls, openCalls, viewCalls, collapseCalls,
    host: window.document.getElementById('attentionInbox'),
    rowFor,
    title: (key) => {
      const row = rowFor(key);
      return row ? row.querySelector('.attention-inbox__open') : null;
    },
  };
}

const approval = (overrides = {}) => ({
  approvalId: 'appr-1', callId: 'call-1', toolName: 'Write', input: { path: 'notes.md' },
  streamId: 'stream-1', sessionId: 's1', summary: 'Write notes.md', oneOffOnly: false, ...overrides,
});
const session = (id, extra = {}) => ({ id, title: `Chat ${id}`, pending_question_batch: null, ...extra });
const map = (entries) => new Map(entries.map((entry) => [entry.approvalId, entry]));

test('the section is a bounded, self-scrolling neighbour of the chat list, never a flex:1 rival', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'attention-inbox.css'), 'utf8');
  const hostRule = css.match(/\.attention-inbox\s*\{([^}]*)\}/);
  assert.ok(hostRule, 'styles/attention-inbox.css must style the host');
  assert.equal(/flex\s*:\s*1/.test(hostRule[1]), false, 'the host must not compete with .conversation-groups for the panel height');
  // Two pinned sections and a chat list share one overflow: hidden column, so
  // the section grows to its rows and then yields BY ITS LIST: 0 1 auto with
  // min-block-size: 0, the heading rigid and the list the shrinkable child, so
  // a short window shortens the list and never clips the kicker.
  assert.match(hostRule[1], /flex\s*:\s*0\s+1\s+auto/, 'the host takes only the room its rows need, and yields it back');
  assert.match(hostRule[1], /min-block-size\s*:\s*0/, 'a flex item only shrinks below its content with a zero minimum');
  const headingRule = css.match(/\.attention-inbox__heading\s*\{([^}]*)\}/);
  assert.ok(headingRule, 'the heading must be styled');
  assert.match(headingRule[1], /flex\s*:\s*0\s+0\s+auto/, 'the kicker never shrinks: the section yields by its list');
  const listRule = css.match(/\.attention-inbox__list\s*\{([^}]*)\}/);
  assert.ok(listRule, 'the row list must be styled');
  assert.match(listRule[1], /flex\s*:\s*0\s+1\s+auto/);
  assert.match(listRule[1], /min-block-size\s*:\s*0/);
  assert.match(listRule[1], /max-block-size/, 'many rows scroll inside the section');
  assert.match(listRule[1], /overflow-y\s*:\s*auto/);
  assert.equal(/(^|[^-])(left|right)\s*:/.test(css), false, 'logical properties only');
  // The other half of the joint bound: the only item that CAN shrink keeps a
  // floor of three session rows, so the two pinned sections can never clip the
  // chat list to nothing.
  const panelCss = fs.readFileSync(path.join(ROOT, 'styles', 'chats-panel.css'), 'utf8');
  const groupsRule = panelCss.match(/\.conversation-groups\s*\{([^}]*)\}/);
  assert.ok(groupsRule, 'styles/chats-panel.css must style the chat list');
  // 176px in border-box terms: the list's own 16px end padding, the group
  // kicker (~30px) and three 42px session rows (40px + 2px margin).
  assert.match(groupsRule[1], /min-block-size\s*:\s*176px/, 'the chat list keeps a three-row floor');
  // The titlebar is the window's drag region (styles/foundation.css); every
  // control in it opts out, or a click moves the window instead of firing.
  const badgeRule = css.match(/\.attention-inbox-badge\s*\{([^}]*)\}/);
  assert.ok(badgeRule, 'the badge must be styled');
  assert.match(badgeRule[1], /-webkit-app-region\s*:\s*no-drag/, 'the badge opts out of the titlebar drag region');
});

test('the inbox is a native list group, not a card surface with a filled badge', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'attention-inbox.css'), 'utf8');
  const rowRule = css.match(/\.attention-inbox__row\s*\{([^}]*)\}/);
  assert.ok(rowRule, 'the row must be styled');
  const declarations = rowRule[1].split(';').map((line) => line.trim()).filter(Boolean);
  assert.equal(declarations.find((line) => /^border\s*:/.test(line)), 'border: 0',
    'a wait is a list item, not a bordered card');
  assert.equal(declarations.find((line) => /^background(?:-color)?\s*:/.test(line)), 'background: transparent',
    'the only surface a row gets is the panel hover');
  assert.match(css, /\.attention-inbox__row:(?:hover|is\([^)]*hover[^)]*\))[^{]*\{[^}]*background\s*:\s*var\(--rail-hover-bg\)/,
    'hover is the chats-panel rail hover, nothing bespoke');
  assert.equal(/--accent-amber/.test(css), false,
    'the approval colour comes from the sidebar state token the session rows already use');
  assert.equal(/data-fact-kind/.test(css), false, 'facts are uniform: no kind is painted louder than another');
  assert.equal(/\battention-inbox__count\b[^{]*\{[^}]*border-radius/.test(css), false, 'the count is plain text, never a pill');
  const toggleRule = css.match(/\.attention-inbox\s+\.attention-inbox__toggle\s*\{([^}]*)\}/);
  assert.ok(toggleRule, 'the kicker must be styled as chrome only');
  assert.equal(/font-size/.test(toggleRule[1]), false, '.group-label owns the kicker type, the colour and the hairline');
  const badgeRule = css.match(/\.attention-inbox-badge\s*\{([^}]*)\}/);
  assert.match(badgeRule[1], /background\s*:\s*transparent/, 'the titlebar mark is the health pill\'s shape, not a filled dot');
  assert.match(css, /\.attention-inbox-badge:hover[^{]*\{[^}]*var\(--toprail-item-hover-bg\)/,
    'and the health pill\'s own hover');
  assert.equal(/border-radius\s*:\s*(?:999px|var\(--radius-pill\))/.test(badgeRule[1]), false, 'the mark is not a pill');
  const staleRule = css.match(/\.attention-inbox__stale\s*\{([^}]*)\}/);
  assert.ok(staleRule, 'the stale line must be styled');
  assert.equal(/font-style\s*:\s*italic/.test(staleRule[1]), false, '"Already resolved" is a quiet line, not an aside');
  const headingRule = css.match(/\.attention-inbox__heading\s*\{([^}]*)\}/);
  assert.match(headingRule[1], /padding-inline\s*:\s*var\(--space-4\)/);
});

test('a question row answers with the answer modifier, and a plan row opens with the open one', () => {
  const h = harness({
    sessions: [
      session('s1', { pending_question_batch: { batch_id: 'b1', intro_text: 'Two quick questions.', questions: [{ id: 'q1' }, { id: 'q2' }] } }),
      session('s2'),
    ],
    pendingToolApprovals: map([approval({ approvalId: 'plan-1', callId: 'plan-1', toolName: 'exit_plan_mode', input: { plan: 'x' }, sessionId: 's2' })]),
  });
  h.controller.render();
  const answer = h.rowFor('question:s1:b1').querySelector('[data-attention-action="answer"]');
  assert.ok(answer, 'a question batch offers Answer');
  assert.equal(answer.classList.contains('attention-inbox__action--answer'), true, 'styled as the answer decision');
  const open = h.rowFor('plan_review:plan-1').querySelector('[data-attention-action="open"]');
  assert.ok(open, 'a plan review offers Open');
  assert.equal(open.classList.contains('attention-inbox__action--open'), true);
  h.controller.dispose();
  h.window.close();
});

test('a settings change offers only Deny here: it is approved on its card, where the rows are (row 88)', () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval({
    toolName: 'settings_change', input: { changes: [{ key: 'palette', value: 'paper' }] }, oneOffOnly: true,
    settingsChangeApproval: { schema_version: 1, state: 'refused', reason: 'unavailable', rows: [] },
  })]) });
  h.controller.render();
  const actions = [...h.rowFor('approval:call-1').querySelectorAll('[data-attention-action]')].map((node) => node.getAttribute('data-attention-action'));
  assert.equal(actions.includes('allow'), false);
  assert.equal(actions.includes('always'), false);
  assert.equal(actions.includes('deny'), true);
  h.controller.dispose();
  h.window.close();
});

test('a decision keeps keyboard focus in its row while the bridge answers, and across a rebuild', () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.window.jennyShell.tools.approve = () => new Promise(() => {}); // never settles: the in-flight state is under test
  h.controller.render();
  const allow = h.rowFor('approval:call-1').querySelector('[data-attention-action="allow"]');
  allow.focus();
  assert.equal(h.document.activeElement, allow, 'precondition');
  allow.click();
  assert.equal(allow.disabled, true, 'the decisions go dead while the bridge answers');
  const title = h.title('approval:call-1');
  assert.equal(h.document.activeElement, title, 'focus moves to the row title instead of falling to body');
  h.state.sessions = [session('s1', { title: 'Renamed' })];
  h.controller.render();
  assert.equal(h.document.activeElement, h.title('approval:call-1'), 'and the rebuilt title takes it back');
  h.controller.dispose();
  h.window.close();
});

test('the row title is the button that opens its conversation, and opening answers nothing', () => {
  // JEN-045's whole tradeoff is answering out of context, so every row owes a
  // one-click way to go and read that context.
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  const title = h.title('approval:call-1');
  assert.ok(title, 'the session title is a control, not inert text');
  assert.equal(title.tagName, 'BUTTON');
  assert.match(title.textContent, /Chat s1/);
  assert.ok(title.title, 'every control carries a tooltip');
  assert.ok(title.querySelector('.attention-inbox__dot'), 'the state dot rides on the title, as in the session list');
  title.click();
  assert.deepEqual(h.openCalls, ['s1']);
  assert.deepEqual(h.approveCalls, [], 'opening a conversation decides nothing');
  assert.deepEqual(h.denyCalls, []);
  h.controller.dispose();
  h.window.close();
});

test('one uniform policy line carries the scope, the consequence and the facts, and no fact is coloured by kind', () => {
  const h = harness({
    sessions: [session('s1')],
    pendingToolApprovals: map([approval({
      toolName: 'write_file',
      policyScope: 'Workspace files',
      policyConsequence: 'May change data in this scope.',
    })]),
  });
  h.controller.render();
  const row = h.rowFor('approval:call-1');
  assert.equal(row.querySelector('.attention-inbox__policy').textContent,
    'Workspace files · May change data in this scope. · Writes notes.md',
    'one muted line, in the backend\'s own words, then what the call touches');
  assert.equal(row.querySelector('.attention-inbox__facts'), null, 'no fact list, no chips');
  assert.equal(row.querySelector('[data-fact-kind]'), null,
    'the transcript card keeps facts uniform: none of them is styled as more alarming than another');
  const detail = row.querySelector('.attention-inbox__detail');
  assert.match(detail.textContent, /write_file/, 'the tool and its arguments share one line');
  assert.equal(detail.querySelector('.attention-inbox__preview').textContent, 'notes.md');
  assert.equal(detail.title, 'notes.md', 'the ellipsised line keeps its whole text in the tooltip');
  h.controller.dispose();
  h.window.close();
});

test('a chrome pass whose sources did not move rebuilds no model at all', () => {
  // render() runs on every workspace-chrome pass, which during streaming is
  // every frame: the model build (two source scans, the facts helper and a
  // sort) may not run unless a source actually moved.
  let builds = 0;
  const view = Object.freeze({
    hidden: false,
    counts: Object.freeze({ approvals: 1, planReviews: 0, questions: 0, answerable: 1 }),
    rows: Object.freeze([Object.freeze({
      key: 'approval:call-1', kind: 'approval', sessionId: 's1', sessionTitle: 'Chat s1',
      callId: 'call-1', approvalId: 'appr-1', toolName: 'Write', preview: 'notes.md',
      facts: Object.freeze([]), policyScope: '', consequence: '', canAlwaysAllow: true, order: 0,
    })]),
  });
  const h = harness({
    sessions: [session('s1')],
    pendingToolApprovals: map([approval()]),
    getAttentionInbox: () => { builds += 1; return view; },
  });
  h.controller.render();
  h.controller.render();
  h.controller.render();
  assert.equal(builds, 1, 'an unchanged source fingerprint short-circuits before the model is read');
  h.state.sessions = [session('s1', { title: 'Renamed' })];
  h.controller.render();
  assert.equal(builds, 2, 'a renamed conversation is a moved source, so the model is read again');
  // Rehydration (renderer-session-lifecycle-utils.js) deletes and re-sets the
  // SAME key in one synchronous block with the fields read off the persisted
  // record; the row's policy line and "Always allow" depend on them.
  h.state.pendingToolApprovals.set('appr-1', approval({ policyScope: 'Workspace files', oneOffOnly: true }));
  h.controller.render();
  assert.equal(builds, 3, 'the same approval id with different fields is read again');
  h.controller.render();
  assert.equal(builds, 3);
  // A question batch that gains a question, or whose intro is revised under
  // the same batch id, is a moved source too.
  h.state.sessions = [session('s1', { title: 'Renamed', pending_question_batch: { batch_id: 'b1', intro_text: 'One thing.', questions: [{ id: 'q1' }] } })];
  h.controller.render();
  assert.equal(builds, 4);
  h.state.sessions = [session('s1', { title: 'Renamed', pending_question_batch: { batch_id: 'b1', intro_text: 'One other thing.', questions: [{ id: 'q1' }] } })];
  h.controller.render();
  assert.equal(builds, 5, 'a revised intro under the same batch id is read again');
  h.controller.dispose();
  h.window.close();
});

test('a failed cross-chat delivery is a row whose title and Open both go to the sending chat', () => {
  const h = harness({ sessions: [session('sender', { failed_delivery_count: 1 }), session('s2')] });
  h.controller.render();
  const row = h.rowFor('delivery_failed:sender');
  assert.ok(row, 'the failed send is listed');
  assert.equal(row.classList.contains('attention-inbox__row--delivery_failed'), true);
  assert.equal(row.querySelector('.attention-inbox__note').textContent, "Couldn't deliver a message");
  const open = row.querySelector('[data-attention-action="open"]');
  assert.ok(open, 'the row offers Open');
  assert.equal(open.textContent.trim(), 'Open');
  assert.equal(open.classList.contains('attention-inbox__action--open'), true);
  assert.ok(open.title, 'every control carries a tooltip');
  open.click();
  h.title('delivery_failed:sender').click();
  assert.deepEqual(h.openCalls, ['sender', 'sender'], 'both open the chat where Retry and Cancel send live');
  assert.equal(h.document.querySelector('.attention-inbox-badge__count').textContent, '1');
  h.controller.dispose();
  h.window.close();
});

test('the failed-delivery count is a moved source: 0 -> 1 -> 2 -> 0 repaints each time', () => {
  const h = harness({ sessions: [session('sender', { failed_delivery_count: 0 })] });
  h.controller.render();
  assert.equal(h.host.hidden, true, 'nothing failed, nothing listed');
  h.state.sessions = [session('sender', { failed_delivery_count: 1 })];
  h.controller.render();
  assert.equal(h.host.hidden, false);
  assert.equal(h.rowFor('delivery_failed:sender').querySelector('.attention-inbox__note').textContent, "Couldn't deliver a message");
  h.state.sessions = [session('sender', { failed_delivery_count: 2 })];
  h.controller.render();
  assert.equal(h.rowFor('delivery_failed:sender').querySelector('.attention-inbox__note').textContent, "Couldn't deliver 2 messages",
    'the same key with a new count repaints, so the signature carries the count');
  h.state.sessions = [session('sender', { failed_delivery_count: 0 })];
  h.controller.render();
  assert.equal(h.rowFor('delivery_failed:sender'), null, 'a retried or cancelled send leaves the inbox');
  assert.equal(h.host.hidden, true);
  h.controller.dispose();
  h.window.close();
});

/* Row 158: the conversation on screen, the flyout, the snapshot. */
const tick = () => new Promise((resolve) => setImmediate(resolve));
const flyoutRow = (h, key) => [...h.document.querySelectorAll('#attentionInboxFlyout .attention-inbox__row')]
  .find((node) => node.dataset.attentionKey === key) || null;

test('the conversation on screen keeps a one-line row with no decisions; elsewhere it keeps them', () => {
  const sessions = [session('s1'), session('s2')];
  const pendingToolApprovals = map([approval(), approval({ approvalId: 'appr-2', callId: 'call-2', sessionId: 's2' })]);
  const h = harness({ sessions, pendingToolApprovals, currentSessionId: 's1', activeView: 'chat' });
  h.controller.render();
  const here = h.rowFor('approval:call-1');
  assert.equal(here.classList.contains('attention-inbox__row--here'), true);
  assert.equal(here.querySelector('.attention-inbox__note').textContent, 'Waiting in the chat on screen');
  assert.ok(h.title('approval:call-1'), 'the title still opens the conversation');
  assert.equal(here.querySelector('.attention-inbox__action'), null, 'no decisions beside its own transcript card');
  assert.equal(here.querySelector('.attention-inbox__detail'), null);
  assert.equal(here.querySelector('.attention-inbox__policy'), null);
  assert.ok(h.rowFor('approval:call-2').querySelector('[data-attention-action="allow"]'), 'another chat keeps its decisions');
  assert.equal(h.document.querySelector('.attention-inbox__count').textContent, '2', 'an on-screen wait still counts');

  h.state.ui.activeView = 'home';
  h.controller.render();
  assert.ok(h.rowFor('approval:call-1').querySelector('[data-attention-action="allow"]'),
    'another view means nothing is on screen: the full row returns');
  h.controller.dispose();
  h.window.close();
});

test('the badge with no visible strip mark expands the panel and focuses the first title, never Allow', () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]), currentSessionId: 'other' });
  h.controller.render();
  h.document.getElementById('attentionInboxBadge').click();
  assert.deepEqual(h.viewCalls, ['chat']);
  assert.deepEqual(h.collapseCalls, [false]);
  assert.equal(h.document.activeElement, h.title('approval:call-1'));
  assert.equal(h.controller.isFlyoutOpen(), false);

  // A mark that exists but sits under a hidden strip is no mark at all.
  const hiddenStrip = harness({ strip: true, sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  hiddenStrip.document.getElementById('chatsStrip').hidden = true;
  hiddenStrip.controller.render();
  hiddenStrip.document.getElementById('attentionInboxBadge').click();
  assert.equal(hiddenStrip.controller.isFlyoutOpen(), false);
  assert.deepEqual(hiddenStrip.collapseCalls, [false]);
  hiddenStrip.controller.dispose();
  hiddenStrip.window.close();
  h.controller.dispose();
  h.window.close();
});

test('the badge with a visible strip mark opens the flyout beside it and lands on the first title', () => {
  const h = harness({ strip: true, sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  const mark = h.document.getElementById('chatsStripNeedsYou');
  h.document.getElementById('attentionInboxBadge').click();
  assert.deepEqual(h.viewCalls, ['chat']);
  assert.deepEqual(h.collapseCalls, [], 'the collapsed choice is not undone');
  assert.equal(h.controller.isFlyoutOpen(), true);
  assert.equal(mark.getAttribute('aria-expanded'), 'true');
  const title = flyoutRow(h, 'approval:call-1').querySelector('.attention-inbox__open');
  assert.equal(h.document.activeElement, title, 'focus lands on the title, so a stray Space cannot approve');
  assert.equal(h.document.querySelector('#attentionInboxFlyout .attention-inbox__heading-static .attention-inbox__count').textContent, '1');
  assert.equal(h.document.querySelector('#attentionInboxFlyout .attention-inbox__toggle'), null, 'the flyout heading is static');
  assert.equal(h.document.getElementById('attention-inbox-flyout-list').hidden, false);

  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.controller.isFlyoutOpen(), false);
  assert.equal(h.document.activeElement, h.document.getElementById('attentionInboxBadge'), 'Escape returns to the badge that opened it');
  assert.equal(h.document.querySelector('#attentionInboxFlyout .attention-inbox__row'), null, 'a closed flyout holds no rows');
  h.controller.dispose();
  h.window.close();
});

test('the panel and the flyout never repeat a DOM id, and the flyout list shows whatever the collapsed preference', () => {
  const h = harness({
    strip: true,
    sessions: [session('s1'), session('s2', { pending_question_batch: { batch_id: 'b1', intro_text: 'Pick', questions: [{ id: 'q1' }] } })],
    pendingToolApprovals: map([approval()]),
  });
  h.window.localStorage.setItem('jenny.attentionInbox.collapsed', 'true');
  h.controller.render();
  assert.equal(h.document.getElementById('attention-inbox-list').hidden, true, 'precondition: the panel section is collapsed');
  h.controller.openFlyout(h.document.getElementById('chatsStripNeedsYou'), {});
  const ids = [...h.document.querySelectorAll('[id]')].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, `ids repeat: ${ids.filter((id, index) => ids.indexOf(id) !== index)}`);
  assert.ok(h.document.getElementById('attention-inbox-allow-approval-call-1'), 'panel ids stay as they were');
  assert.ok(h.document.getElementById('attention-inbox-flyout-allow-approval-call-1'));
  assert.equal(h.document.getElementById('attention-inbox-flyout-list').hidden, false);
  h.controller.dispose();
  h.window.close();
});

test('Allow in the flyout answers through the bridge with the approval id; the last row leaving closes it', async () => {
  const h = harness({ strip: true, sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  const mark = h.document.getElementById('chatsStripNeedsYou');
  h.controller.toggleFlyout(mark);
  assert.equal(h.controller.isFlyoutOpen(), true);
  h.document.getElementById('attention-inbox-flyout-allow-approval-call-1').click();
  await tick();
  assert.deepEqual(h.approveCalls, [['appr-1', { alwaysAllow: false }]]);
  assert.equal(h.controller.isFlyoutOpen(), false, 'nothing left to answer: the flyout goes');
  assert.equal(h.document.getElementById('attentionInboxFlyout').hidden, true);
  assert.equal(mark.getAttribute('aria-expanded'), 'false');
  assert.equal(h.document.activeElement, h.document.getElementById('chatsStripPanelToggle'),
    'focus that was inside the flyout does not fall to the body');
  h.controller.dispose();
  h.window.close();
});

test('answering one of two rows in the flyout lands focus on the remaining title, not the body', async () => {
  const h = harness({
    strip: true,
    sessions: [session('s1'), session('s2')],
    pendingToolApprovals: map([approval(), approval({ approvalId: 'appr-2', callId: 'call-2', sessionId: 's2' })]),
  });
  h.controller.render();
  h.controller.toggleFlyout(h.document.getElementById('chatsStripNeedsYou'));
  const allow = h.document.getElementById('attention-inbox-flyout-allow-approval-call-1');
  allow.focus();
  allow.click();
  await tick();
  assert.equal(h.controller.isFlyoutOpen(), true, 'one row is still waiting');
  assert.equal(h.document.activeElement, h.document.getElementById('attention-inbox-flyout-session-approval-call-2'));
  h.controller.dispose();
  h.window.close();
});

test('both targets repaint together and are left alone when nothing moved; busy shows in each', () => {
  const h = harness({ strip: true, sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.window.jennyShell.tools.approve = () => new Promise(() => {});
  h.controller.render();
  h.controller.toggleFlyout(h.document.getElementById('chatsStripNeedsYou'));
  const panelRow = h.rowFor('approval:call-1');
  const inFlyout = flyoutRow(h, 'approval:call-1');
  h.controller.render();
  h.controller.render();
  assert.equal(h.rowFor('approval:call-1'), panelRow, 'the panel row is not rebuilt');
  assert.equal(flyoutRow(h, 'approval:call-1'), inFlyout, 'nor the flyout row');
  inFlyout.querySelector('[data-attention-action="allow"]').click();
  assert.equal(panelRow.querySelector('[data-attention-action="allow"]').disabled, true, 'the same wait is busy in the panel too');
  assert.equal(inFlyout.querySelector('[data-attention-action="deny"]').disabled, true);
  h.state.sessions = [session('s1', { title: 'Renamed' })];
  h.controller.render();
  assert.match(flyoutRow(h, 'approval:call-1').textContent, /Renamed/);
  assert.match(h.rowFor('approval:call-1').textContent, /Renamed/);
  h.controller.dispose();
  h.window.close();
});

test('the snapshot reads the last render: answerable, chats in row order, how each waits, and a key that moves', () => {
  const h = harness({
    sessions: [session('s1'), session('s2', { pending_question_batch: { batch_id: 'b1', intro_text: 'Pick', questions: [{ id: 'q1' }] } }),
      session('s3', { failed_delivery_count: 1 })],
    pendingToolApprovals: map([approval({ approvalId: 'p1', callId: 'plan-1', toolName: 'exit_plan_mode', sessionId: 's1' })]),
  });
  const empty = h.controller.getSnapshot();
  assert.deepEqual({ ...empty, states: [...empty.states] }, { answerable: 0, waitingSessionIds: [], states: [], key: '' });
  h.controller.render();
  const first = h.controller.getSnapshot();
  assert.equal(first.answerable, 3);
  assert.deepEqual([...first.waitingSessionIds], ['s1', 's2', 's3']);
  assert.deepEqual([...first.states], [['s1', 'plan_review'], ['s2', 'input_needed'], ['s3', 'input_needed']]);
  assert.equal(Object.isFrozen(first), true);

  h.controller.render();
  assert.equal(h.controller.getSnapshot(), first, 'an unmoved pass keeps the same snapshot');
  h.state.pendingToolApprovals = map([approval({ approvalId: 'a1', callId: 'call-1', sessionId: 's1' })]);
  h.controller.render();
  const second = h.controller.getSnapshot();
  assert.equal(second.states.get('s1'), 'approval');
  assert.notEqual(second.key, first.key, 'a state moved, so the key moved');
  h.state.sessions = [session('s3', { failed_delivery_count: 1 }), session('s1'), session('s2')];
  h.state.pendingToolApprovals = new Map();
  h.controller.render();
  const third = h.controller.getSnapshot();
  assert.deepEqual([...third.waitingSessionIds], ['s3'], 'only chats that still wait');
  assert.equal(third.answerable, 1);
  assert.notEqual(third.key, second.key);
  h.controller.dispose();
  h.window.close();
});

test('dispose removes the flyout element and a disposed controller opens nothing', () => {
  const h = harness({ strip: true, sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  h.controller.toggleFlyout(h.document.getElementById('chatsStripNeedsYou'));
  assert.ok(h.document.getElementById('attentionInboxFlyout'));
  h.controller.dispose();
  assert.equal(h.document.getElementById('attentionInboxFlyout'), null);
  assert.equal(h.controller.isFlyoutOpen(), false);
  assert.equal(h.controller.openFlyout(h.document.getElementById('chatsStripNeedsYou'), {}), false);
  assert.equal(h.document.getElementById('attentionInboxFlyout'), null);
  h.controller.dispose();
  h.window.close();
});

test('with no wait to show, the flyout does not open', () => {
  const h = harness({ strip: true, sessions: [session('s1')] });
  h.controller.render();
  assert.equal(h.controller.openFlyout(h.document.getElementById('chatsStripNeedsYou'), {}), false);
  assert.equal(h.document.getElementById('attentionInboxFlyout'), null, 'nothing was built for it');
  h.controller.dispose();
  h.window.close();
});

test('opening a conversation from the flyout closes it and opens the chat', () => {
  const h = harness({ strip: true, sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  h.controller.toggleFlyout(h.document.getElementById('chatsStripNeedsYou'));
  flyoutRow(h, 'approval:call-1').querySelector('.attention-inbox__open').click();
  assert.deepEqual(h.openCalls, ['s1']);
  assert.equal(h.controller.isFlyoutOpen(), false, 'the chat is open now, so the flyout is done');
  assert.deepEqual(h.approveCalls, [], 'opening answers nothing');
  h.controller.dispose();
  h.window.close();
});
