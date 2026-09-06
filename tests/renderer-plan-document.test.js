'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const documentUi = require('../renderer/features/renderer-plan-document');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { handlePlanModeShortcut } = require('../renderer/chat/renderer-plan-mode-shortcut');
const { createPlanDocumentController } = require('../renderer/chat/renderer-plan-document-controller');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');

test('pending plan renders as an expanded first-class document with safe markup', () => {
  const markup = documentUi.fullDocumentMarkup({
    plan_id: 'p', tool_call_id: 'call', title: '<Plan>', summary: 'Summary',
    steps: ['Inspect', '<script>alert(1)</script>'], notes: '**Note**', verification: 'Run tests',
    files_read: ['src/a.js'], state: 'pending',
  }, { renderMarkdown: (text) => `<em>${text}</em>` });
  assert.match(markup, /class="plan-document"/);
  assert.match(markup, /&lt;Plan&gt;/);
  assert.match(markup, /2 steps · 1 files read/);
  assert.match(markup, /data-plan-actions/);
  assert.match(markup, /data-plan-title/);
  assert.match(markup, /data-plan-step-controls/);
  assert.match(markup, /data-plan-add-step/);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(markup.includes('<script>'), false);
  assert.equal(markup.includes('<details'), false);
});

test('terminal and legacy plans render as collapsed inert receipts', () => {
  const approved = documentUi.fullDocumentMarkup({
    title: 'Done', steps: ['A'], state: 'approved', plan_edited: true,
  });
  const legacy = documentUi.legacyPlanObjectMarkup({ title: 'Legacy', steps: ['A'] });
  const proposal = documentUi.legacyPlanProposalMarkup({
    plan_proposal: { proposal_id: 'old', title: 'Earlier plan', steps: [{ label: 'A' }] },
  });
  assert.match(approved, /^<details/);
  assert.match(legacy, /^<details/);
  assert.match(proposal, /^<details/);
  assert.equal(legacy.includes('data-plan-actions'), false);
  assert.equal(proposal.includes('data-plan-actions'), false);
  assert.equal(approved.includes('data-plan-title'), false);
  assert.equal(approved.includes('data-plan-step-controls'), false);
  assert.equal(approved.includes('data-plan-add-step'), false);
  assert.match(approved, /edited &middot; approved/);
});

test('transition normalization is bounded and stable', () => {
  const normalized = documentUi.normalizePlanDocument({
    title: 'x'.repeat(200), steps: Array.from({ length: 25 }, (_, index) => `Step ${index}`),
    transition: 'rejected', feedback: 'Try again',
  });
  assert.equal(normalized.title.length, 120);
  assert.equal(normalized.steps.length, 20);
});

test('append-only plan transitions coalesce into one latest-state row', () => {
  const events = ['pending', 'rejected', 'superseded'].map((transition, index) => ({
    event_id: `t:plan:${index}`, turn_id: 't', kind: 'plan_document',
    primary_message_id: 'plan_document_p', source_message_ids: ['plan_document_p'],
    sort_key: [index, 0, 29], status: transition,
    payload: { plan_id: 'p', title: 'Plan', steps: ['A'], transition },
  }));
  assert.deepEqual(documentUi.coalesceTransitions(events).transitions, ['pending', 'rejected', 'superseded']);
  const rows = projectTurnRows(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'plan_document');
  assert.equal(rows[0].payload.transition, 'superseded');
  assert.deepEqual(rows[0].payload.transitions, ['pending', 'rejected', 'superseded']);
});

test('Alt+P routes through the run-mode control and ignores modified repeats', () => {
  let toggles = 0;
  let prevented = 0;
  const previousControl = globalThis.rendererRunModeControl;
  globalThis.rendererRunModeControl = { togglePlanMode: () => { toggles += 1; } };
  const event = {
    key: 'P', altKey: true, ctrlKey: false, metaKey: false, repeat: false, defaultPrevented: false,
    preventDefault: () => { prevented += 1; },
  };
  assert.equal(handlePlanModeShortcut(event, null), true);
  assert.equal(toggles, 1);
  assert.equal(prevented, 1);
  assert.equal(handlePlanModeShortcut({ ...event, repeat: true }, null), false);
  globalThis.rendererRunModeControl = previousControl;
});

test('plan document controller mounts decisions, focuses Build it, and submits bounded rejection feedback', async () => {
  const dom = new JSDOM(`<!doctype html><body><main id="chatTimeline">${documentUi.fullDocumentMarkup({
    tool_call_id: 'call-1', title: 'Ship it', steps: ['Build'], state: 'pending',
  })}</main></body>`, { pretendToBeVisual: true });
  const decisions = [];
  dom.window.jennyShell = {
    tools: { approve: async (...args) => { decisions.push(args); return true; } },
  };
  const controller = createPlanDocumentController({
    windowRef: dom.window,
    actionButton,
    textField,
  });
  const host = dom.window.document.querySelector('[data-plan-document]');
  assert.equal(host.querySelectorAll('[data-plan-decision]').length, 3);
  assert.equal(dom.window.document.activeElement.dataset.planDecision, 'approved');
  assert.equal(host.querySelector('[data-plan-drag-handle]').title, 'Drag to reorder step');
  assert.equal(host.querySelector('[data-plan-remove-step]').title, 'Remove this step');

  host.querySelector('[data-plan-decision="feedback"]').click();
  const feedback = host.querySelector('[data-plan-feedback]');
  feedback.value = 'Please add rollback coverage.';
  host.querySelector('[data-plan-decision="rejected"]').click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.deepEqual(decisions, [['call-1', {
    decision: 'rejected', feedback: 'Please add rollback coverage.',
  }]]);

  controller.dispose();
  const detached = dom.window.document.createElement('section');
  detached.dataset.planDocument = 'true';
  detached.dataset.planState = 'pending';
  detached.innerHTML = '<div data-plan-actions></div>';
  dom.window.document.body.append(detached);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(detached.querySelectorAll('button').length, 0);
  dom.window.close();
});

test('plan document controller observes only the chat timeline', () => {
  const dom = new JSDOM('<!doctype html><body><main id="chatTimeline"></main><aside id="outside"></aside></body>');
  const observations = [];
  class RecordingMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe(root, options) {
      observations.push({ root, options });
    }

    disconnect() {}
  }
  dom.window.MutationObserver = RecordingMutationObserver;

  const controller = createPlanDocumentController({
    windowRef: dom.window,
    actionButton,
    textField,
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].root, dom.window.document.getElementById('chatTimeline'));
  assert.deepEqual(observations[0].options, { childList: true, subtree: true });

  controller.dispose();
  dom.window.close();
});

test('edited title is included in approval while an unedited plan omits the plan field', async () => {
  const dom = new JSDOM(`<!doctype html><body><main id="chatTimeline">${documentUi.fullDocumentMarkup({
    tool_call_id: 'call-edit', title: 'Original', steps: ['Inspect'], state: 'pending',
  })}</main></body>`, { pretendToBeVisual: true });
  const decisions = [];
  dom.window.jennyShell = { tools: { approve: async (...args) => { decisions.push(args); return true; } } };
  const controller = createPlanDocumentController({ windowRef: dom.window, actionButton, textField });
  const host = dom.window.document.querySelector('[data-plan-document]');

  host.querySelector('[data-plan-title]').click();
  const titleInput = host.querySelector('[data-plan-title] input');
  titleInput.value = '<Edited title>';
  titleInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(host.querySelector('[data-plan-edited]').hidden, false);
  assert.equal(host.querySelector('[data-plan-title]').innerHTML, '&lt;Edited title&gt;');
  host.querySelector('[data-plan-decision="approved"]').click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.deepEqual(decisions[0], ['call-edit', {
    decision: 'approved', feedback: '<no feedback given>',
    plan: { title: '<Edited title>', steps: ['Inspect'] },
  }]);

  controller.dispose();
  dom.window.close();

  const cleanDom = new JSDOM(`<!doctype html><body><main id="chatTimeline">${documentUi.fullDocumentMarkup({
    tool_call_id: 'call-clean', title: 'Original', steps: ['Inspect'], state: 'pending',
  })}</main></body>`, { pretendToBeVisual: true });
  const cleanDecisions = [];
  cleanDom.window.jennyShell = {
    tools: { approve: async (...args) => { cleanDecisions.push(args); return true; } },
  };
  const cleanController = createPlanDocumentController({
    windowRef: cleanDom.window, actionButton, textField,
  });
  cleanDom.window.document.querySelector('[data-plan-decision="approved"]').click();
  await new Promise((resolve) => cleanDom.window.setTimeout(resolve, 0));
  assert.deepEqual(cleanDecisions[0], ['call-clean', {
    decision: 'approved', feedback: '<no feedback given>',
  }]);
  cleanController.dispose();
  cleanDom.window.close();
});

test('step editing refuses last-step removal and add-step appends an editable row', () => {
  const dom = new JSDOM(`<!doctype html><body><main id="chatTimeline">${documentUi.fullDocumentMarkup({
    tool_call_id: 'call-steps', title: 'Steps', steps: ['Only step'], state: 'pending',
  })}</main></body>`, { pretendToBeVisual: true });
  dom.window.jennyShell = { tools: { approve: async () => true } };
  const controller = createPlanDocumentController({ windowRef: dom.window, actionButton, textField });
  const host = dom.window.document.querySelector('[data-plan-document]');

  host.querySelector('[data-plan-remove-step]').click();
  assert.equal(host.querySelectorAll('[data-plan-step-index]').length, 1);
  host.querySelector('[data-plan-add-step-button]').click();
  assert.equal(host.querySelectorAll('[data-plan-step-index]').length, 2);
  const input = host.querySelector('[data-plan-step-index="1"] input');
  assert.ok(input);
  input.value = 'Verify';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual([...host.querySelectorAll('[data-plan-step-text]')].map((step) => step.textContent),
    ['Only step', 'Verify']);

  controller.dispose();
  dom.window.close();
});
