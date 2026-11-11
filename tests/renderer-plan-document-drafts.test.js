'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const documentUi = require('../renderer/features/renderer-plan-document');
const { createPlanDocumentController } = require('../renderer/chat/renderer-plan-document-controller');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');

function mountPlan(plan, onApprove) {
  const dom = new JSDOM(`<!doctype html><body><main id="chatTimeline">${documentUi.fullDocumentMarkup(plan)}</main></body>`, { pretendToBeVisual: true });
  dom.window.jennyShell = { tools: { approve: async (...args) => { onApprove?.(args); return true; } } };
  const controller = createPlanDocumentController({ windowRef: dom.window, actionButton, textField });
  return { dom, controller, host: dom.window.document.querySelector('[data-plan-document]') };
}

async function rerender(dom, plan) {
  const timeline = dom.window.document.getElementById('chatTimeline');
  timeline.innerHTML = documentUi.fullDocumentMarkup(plan);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  return timeline.querySelector('[data-plan-document]');
}

function editFirstStep(dom, host, value) {
  host.querySelector('[data-plan-step-text]').click();
  const input = host.querySelector('[data-plan-step-index="0"] input');
  input.value = value;
  return input;
}

test('a re-render keeps committed plan edits, and the decision sends them', async () => {
  const decisions = [];
  const plan = { tool_call_id: 'draft', title: 'T', steps: ['A', 'B', 'C'], state: 'pending' };
  const { dom, controller, host } = mountPlan(plan, (args) => decisions.push(args));
  editFirstStep(dom, host, 'A edited').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  host.querySelector('[data-plan-step-index="2"] [data-plan-remove-step]').click();
  host.querySelector('[data-plan-title]').click();
  const title = host.querySelector('[data-plan-title] input');
  title.value = 'T edited';
  title.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const again = await rerender(dom, plan);
  assert.equal(again.querySelector('[data-plan-title]').textContent, 'T edited');
  assert.deepEqual([...again.querySelectorAll('[data-plan-step-text]')].map((step) => step.dataset.planStepRaw), ['A edited', 'B']);
  assert.equal(again.querySelector('[data-plan-edited]').hidden, false);
  assert.match(again.querySelector('.plan-document__meta').textContent, /^2 steps/);
  again.querySelector('[data-plan-decision="approved"]').click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.deepEqual(decisions[0][1].plan, { title: 'T edited', steps: ['A edited', 'B'] });
  controller.dispose();
  dom.window.close();
});

test('a re-render commits an edit still open in its input', async () => {
  const plan = { tool_call_id: 'open', title: 'T', steps: ['A'], state: 'pending' };
  const { dom, controller, host } = mountPlan(plan);
  editFirstStep(dom, host, 'still typing');
  const again = await rerender(dom, plan);
  assert.equal(again.querySelector('[data-plan-step-text]').dataset.planStepRaw, 'still typing');
  controller.dispose();
  dom.window.close();
});

test('a draft never lands on a different plan that reuses the tool call id', async () => {
  const { dom, controller, host } = mountPlan({ tool_call_id: 'call_0', title: 'T', steps: ['A'], state: 'pending' });
  editFirstStep(dom, host, 'A edited').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const other = await rerender(dom, { tool_call_id: 'call_0', title: 'Other', steps: ['X', 'Y'], state: 'pending' });
  assert.deepEqual([...other.querySelectorAll('[data-plan-step-text]')].map((step) => step.dataset.planStepRaw), ['X', 'Y']);
  assert.equal(other.querySelector('[data-plan-title]').textContent, 'Other');
  assert.equal(other.querySelector('[data-plan-edited]').hidden, true);
  controller.dispose();
  dom.window.close();
});

test('a settled decision clears the draft', async () => {
  const plan = { tool_call_id: 'done', title: 'T', steps: ['A'], state: 'pending' };
  const { dom, controller, host } = mountPlan(plan);
  editFirstStep(dom, host, 'A edited').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  host.querySelector('[data-plan-decision="approved"]').click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  const again = await rerender(dom, plan);
  assert.equal(again.querySelector('[data-plan-step-text]').dataset.planStepRaw, 'A');
  assert.equal(again.querySelector('[data-plan-edited]').hidden, true);
  controller.dispose();
  dom.window.close();
});
