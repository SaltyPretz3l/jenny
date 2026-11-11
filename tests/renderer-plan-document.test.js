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

const PLAN_UI_PATH = require.resolve('../renderer/features/renderer-plan-document');
const PLAN_CONTROLLER_PATH = require.resolve('../renderer/chat/renderer-plan-document-controller');

test.afterEach(() => {
  delete globalThis.jennyI18n;
  delete require.cache[PLAN_UI_PATH];
  delete require.cache[PLAN_CONTROLLER_PATH];
});

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
  assert.equal(markup.includes('<details class="plan-document-receipt"'), false);
  assert.match(markup, /<details class="plan-document__section" data-plan-section="notes" open>/);
});

test('model-written plan text takes its own direction inside an RTL interface', () => {
  const markup = documentUi.fullDocumentMarkup({
    plan_id: 'p', tool_call_id: 'call', title: 'Add mul3', summary: 'Summary.',
    steps: ['Insert mul3.', 'Export it.'], notes: 'Note.', verification: 'Run tests.',
    files_read: [], state: 'pending',
  }, { renderMarkdown: (text) => `<p>${text}</p>` });
  const doc = new JSDOM(`<body dir="rtl">${markup}</body>`).window.document;
  const texts = doc.querySelectorAll('.plan-document__title, .plan-document__summary, [data-plan-step-text], .plan-document__notes, .plan-document__check');
  assert.equal(texts.length, 6);
  for (const node of texts) assert.equal(node.getAttribute('dir'), 'auto', node.className || node.tagName);
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
  assert.match(approved, /edited &middot; Approved/);
  assert.equal(approved.includes('data-plan-build-accepted'), false);
  const accepted = documentUi.fullDocumentMarkup({
    plan_id: 'plan_a', title: 'Held', steps: ['A'], state: 'accepted',
  });
  assert.match(accepted, /^<details[^>]*data-plan-state="accepted"/);
  assert.match(accepted, /Accepted · not built/);
  assert.match(accepted, /data-plan-build-accepted data-plan-id="plan_a"/);
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
  assert.equal(host.querySelectorAll('[data-plan-decision]').length, 4);
  // Review actions left, build actions right, with the primary Build it last.
  const groups = [...host.querySelectorAll('.plan-document__actions-group')]
    .map((group) => [...group.querySelectorAll('[data-plan-decision]')].map((node) => node.dataset.planDecision));
  assert.deepEqual(groups, [['feedback', 'accepted'], ['approved_auto', 'approved']]);
  assert.equal(host.querySelector('[data-plan-decision="accepted"]').textContent.trim(), 'Looks good, not yet');
  assert.equal(host.querySelector('[data-plan-decision="approved"]').textContent.trim(), 'Build it');
  assert.equal(host.querySelector('[data-plan-decision="approved_auto"]').textContent.trim(), 'Build it, auto mode');
  assert.equal(require('../locales/en.json')['chat.planDocument.buildWithoutAsking'], 'Build it, auto mode');
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

test('localized plan meta keeps exactly one structured step count after mount', () => {
  const i18n = require('../renderer/shared/i18n-utils').createI18n();
  i18n.load({ tag: 'qps-ploc', strings: {
    'artifacts.plan.stepCount': '{count} étapes',
    'artifacts.plan.filesRead': '{count} fichiers lus',
    'chat.planDocument.stepCount': '{count} étapes{suffix}',
  } });
  globalThis.jennyI18n = i18n;
  delete require.cache[PLAN_UI_PATH];
  delete require.cache[PLAN_CONTROLLER_PATH];
  const localizedUi = require(PLAN_UI_PATH);
  const { createPlanDocumentController: createLocalizedController } = require(PLAN_CONTROLLER_PATH);
  const dom = new JSDOM(`<!doctype html><body><main id="chatTimeline">${localizedUi.fullDocumentMarkup({
    tool_call_id: 'call-localized', title: 'Plan', steps: ['Inspect', 'Build'],
    files_read: ['src/a.js'], state: 'pending',
  })}</main></body>`);
  dom.window.jennyShell = { tools: { approve: async () => true } };

  const controller = createLocalizedController({ windowRef: dom.window, actionButton, textField });
  const meta = dom.window.document.querySelector('.plan-document__meta').textContent;

  assert.equal((meta.match(/2 étapes/g) || []).length, 1);
  assert.equal(meta, '2 étapes · 1 fichiers lus');
  controller.dispose();
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
    decision: 'approved', feedback: '',
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
    decision: 'approved', feedback: '',
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

test('Looks good, not yet settles as accepted with no placeholder feedback', async () => {
  const dom = new JSDOM(`<!doctype html><body><main id="chatTimeline">${documentUi.fullDocumentMarkup({
    tool_call_id: 'call-hold', title: 'Hold', steps: ['Inspect'], state: 'pending',
  })}</main></body>`, { pretendToBeVisual: true });
  const decisions = [];
  dom.window.jennyShell = { tools: { approve: async (...args) => { decisions.push(args); return true; } } };
  const controller = createPlanDocumentController({ windowRef: dom.window, actionButton, textField });
  dom.window.document.querySelector('[data-plan-decision="accepted"]').click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.deepEqual(decisions, [['call-hold', { decision: 'accepted', feedback: '' }]]);
  controller.dispose();
  dom.window.close();
});

test('only the latest accepted receipt offers Build it', async () => {
  const receipt = (planId, state) => documentUi.fullDocumentMarkup({
    plan_id: planId, title: planId, steps: ['A'], state,
  });
  const dom = new JSDOM(`<!doctype html><body><main id="chatTimeline">${receipt('plan_old', 'accepted')}`
    + `${receipt('plan_new', 'accepted')}</main></body>`, { pretendToBeVisual: true });
  const controller = createPlanDocumentController({ windowRef: dom.window, actionButton, textField });
  const buttons = () => [...dom.window.document.querySelectorAll('[data-action="plan-build-accepted"]')]
    .map((node) => node.dataset.planId);
  assert.deepEqual(buttons(), ['plan_new']);

  const newer = dom.window.document.createElement('div');
  newer.innerHTML = receipt('plan_newest', 'approved');
  dom.window.document.getElementById('chatTimeline').append(newer.firstElementChild);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.deepEqual(buttons(), [], 'a newer plan retires the older receipt action');
  controller.dispose();
  dom.window.close();
});

test('an accepted transition coalesces and replays as a collapsed accepted receipt', () => {
  const events = ['pending', 'accepted'].map((transition, index) => ({
    event_id: `t:plan:${index}`, turn_id: 't', kind: 'plan_document',
    primary_message_id: 'plan_document_p', source_message_ids: ['plan_document_p'],
    sort_key: [index, 0, 29], status: transition,
    payload: { plan_id: 'p', title: 'Plan', steps: ['A'], transition },
  }));
  const rows = projectTurnRows(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.transition, 'accepted');
  assert.equal(documentUi.normalizePlanDocument(rows[0].payload).state, 'accepted');
  assert.match(documentUi.fullDocumentMarkup(rows[0].payload), /^<details[^>]*data-plan-state="accepted"/);
});

// --- Readable plan presentation: display-only split of a step into lead and detail. ---

const plainEscape = require('../renderer/shared/string-utils').escapeHtml;
const LONG_FLOW = 'Wrap the download stream call in the retry helper so that a cancel aborts the backoff wait cleanly';

test('splitPlanStep applies the five rules in order', () => {
  const { splitPlanStep } = documentUi;
  assert.deepEqual(splitPlanStep('**Add retry**: backoff to 30 s'),
    { lead: 'Add retry', detail: 'Backoff to 30 s', flow: false });
  assert.deepEqual(splitPlanStep('**Add retry** - backoff to 30 s'),
    { lead: 'Add retry', detail: 'Backoff to 30 s', flow: false });
  assert.deepEqual(splitPlanStep('Add the helper: backoff from 2 s to 30 s'),
    { lead: 'Add the helper', detail: 'Backoff from 2 s to 30 s', flow: false });
  assert.deepEqual(splitPlanStep('Resume partial files. Store the ETag beside it.'),
    { lead: 'Resume partial files', detail: 'Store the ETag beside it.', flow: false });
  assert.deepEqual(splitPlanStep('Wire the status line — translate the keys'),
    { lead: 'Wire the status line', detail: 'Translate the keys', flow: false });
  assert.deepEqual(splitPlanStep('Wire the status line – translate the keys'),
    { lead: 'Wire the status line', detail: 'Translate the keys', flow: false });
  assert.deepEqual(splitPlanStep('Wire the status line - translate the keys'),
    { lead: 'Wire the status line', detail: 'Translate the keys', flow: false });
  assert.deepEqual(splitPlanStep('Update the models manifest'),
    { lead: 'Update the models manifest', detail: '', flow: false });
  assert.ok(LONG_FLOW.length > 90);
  assert.deepEqual(splitPlanStep(LONG_FLOW), {
    lead: 'Wrap the download stream call in the retry helper',
    detail: ' so that a cancel aborts the backoff wait cleanly',
    flow: true,
  });
  const unbroken = 'x'.repeat(120);
  assert.deepEqual(splitPlanStep(unbroken), { lead: '', detail: unbroken, flow: false });
});

test('plan grids can shrink and long tokens wrap, so a step never widens the chat column', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles', 'chat-plan-document.css'), 'utf8');
  const rule = css.match(/:is\(([^)]*)\)\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*overflow-wrap:\s*anywhere;[^}]*\}/);
  assert.ok(rule, 'the shrink and wrap rule exists');
  for (const selector of ['.plan-document', '.plan-document__steps', '.plan-document__step-text', '.plan-document-receipt__body']) {
    assert.ok(rule[1].split(',').map((part) => part.trim()).includes(selector), selector);
  }
});

test('splitPlanStep only treats a whole-word abbreviation as no sentence end', () => {
  assert.deepEqual(documentUi.splitPlanStep('Update the envs. Then redeploy the service'),
    { lead: 'Update the envs', detail: 'Then redeploy the service', flow: false });
});

test('splitPlanStep ignores breaks inside backticks and abbreviations', () => {
  const { splitPlanStep } = documentUi;
  assert.deepEqual(splitPlanStep('Call `fn: x` then stop'),
    { lead: 'Call `fn: x` then stop', detail: '', flow: false });
  const eg = splitPlanStep('Cover the edge cases, e.g. empty input. Then ship it');
  assert.equal(eg.lead, 'Cover the edge cases, e.g. empty input');
  assert.equal(eg.detail, 'Then ship it');
});

test('flow keeps the whole sentence and every markup shape is exact', () => {
  assert.equal(documentUi.planStepInnerMarkup(LONG_FLOW, plainEscape),
    '<span class="plan-document__step-flow"><strong>Wrap the download stream call in the retry helper</strong> so that a cancel aborts the backoff wait cleanly</span>');
  assert.equal(documentUi.planStepInnerMarkup('Plain step', plainEscape),
    '<span class="plan-document__step-lead">Plain step</span>');
  assert.equal(documentUi.planStepInnerMarkup('Add it: do it', plainEscape),
    '<span class="plan-document__step-lead">Add it</span><span class="plan-document__step-detail">Do it</span>');
  assert.equal(documentUi.planStepInnerMarkup('y'.repeat(120), plainEscape),
    `<span class="plan-document__step-plain">${'y'.repeat(120)}</span>`);
});

test('planInlineMarkup escapes first and keeps code spans literal', () => {
  const html = documentUi.planInlineMarkup('<img src=x onerror=alert(1)> **bold** `**x**` and `<b>`', plainEscape);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>\*\*x\*\*<\/code>/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
  assert.equal(documentUi.planInlineMarkup('[a](http://x) ![i](y)', plainEscape), '[a](http://x) ![i](y)');
});

test('hostile plan text renders escaped in summary, steps and verification', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const markup = documentUi.fullDocumentMarkup({
    tool_call_id: 'c', title: 'T', summary: hostile, steps: [`Do ${hostile}: now`],
    verification: hostile, state: 'pending',
  });
  assert.equal(markup.includes('<img'), false);
  assert.equal((markup.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length >= 4, true);
  const receipt = documentUi.collapsedReceiptMarkup({
    title: 'T', summary: hostile, steps: [hostile], verification: hostile, state: 'approved',
  });
  assert.equal(receipt.includes('<img'), false);
});

test('a 1200 character summary and verification render in full', () => {
  const summary = `${'s'.repeat(1199)}!`;
  const verification = `${'v'.repeat(1199)}?`;
  const markup = documentUi.fullDocumentMarkup({
    tool_call_id: 'c', title: 'T', summary, steps: ['A'], verification, state: 'pending',
  });
  assert.equal(markup.includes(summary), true);
  assert.equal(markup.includes(verification), true);
  const normalized = documentUi.normalizePlanDocument({ summary: 's'.repeat(2000), verification: 'v'.repeat(2000) });
  assert.equal(normalized.summary.length, 1200);
  assert.equal(normalized.verification.length, 1200);
});

test('the step span carries an escaped raw attribute and formatted contents', () => {
  const raw = 'Add `a: b` & "quote": <done>';
  const markup = documentUi.fullDocumentMarkup({ tool_call_id: 'c', title: 'T', steps: [raw], state: 'pending' });
  const span = new JSDOM(markup).window.document.querySelector('[data-plan-step-text]');
  assert.equal(span.dataset.planStepRaw, raw);
  assert.equal(span.getAttribute('role'), 'button');
  assert.equal(span.getAttribute('dir'), 'auto');
  assert.ok(span.querySelector('code'));
  assert.equal(span.textContent.includes('`'), false);
});

test('notes open at 700 characters and close at 701; check always opens', () => {
  const build = (length) => new JSDOM(documentUi.fullDocumentMarkup({
    tool_call_id: 'c', title: 'T', steps: ['A'], notes: 'n'.repeat(length), verification: 'Run it', state: 'pending',
  })).window.document;
  const open = build(700);
  assert.equal(open.querySelector('details[data-plan-section="notes"]').open, true);
  assert.equal(open.querySelector('details[data-plan-section="check"]').open, true);
  assert.equal(build(701).querySelector('details[data-plan-section="notes"]').open, false);
  const labels = [...open.querySelectorAll('details[data-plan-section] > summary')].map((n) => n.textContent);
  assert.deepEqual(labels, ['Notes', 'How it gets checked']);
  assert.equal(open.querySelector('.plan-document__check').getAttribute('dir'), 'auto');
});

test('an expanded receipt carries summary, steps, notes, check and real feedback only', () => {
  const base = {
    title: 'Done', summary: 'The **why**', steps: ['Add it: now'], notes: 'Some note', verification: 'Run `npm test`',
    state: 'rejected',
  };
  const html = documentUi.collapsedReceiptMarkup({ ...base, feedback: 'Cover rollback' },
    { renderMarkdown: (text) => `<p>${text}</p>` });
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelector('.plan-document__summary strong').textContent, 'why');
  assert.equal(doc.querySelectorAll('.plan-document__steps > li').length, 1);
  assert.equal(doc.querySelector('.plan-document__steps [data-plan-step-controls]'), null);
  assert.equal(doc.querySelector('.plan-document__steps [data-plan-step-raw]'), null);
  assert.equal(doc.querySelector('[data-plan-section="notes"] .plan-document__notes').textContent, 'Some note');
  assert.equal(doc.querySelector('[data-plan-section="check"] code').textContent, 'npm test');
  assert.match(doc.querySelector('.plan-document-receipt__body').textContent, /Cover rollback/);
  const hidden = documentUi.collapsedReceiptMarkup({ ...base, feedback: '<no feedback given>' });
  assert.equal(hidden.includes('no feedback given'), false);
  assert.equal(hidden.includes('Feedback:'), false);
});

function mountPlan(plan, onApprove) {
  const dom = new JSDOM(`<!doctype html><body><main id="chatTimeline">${documentUi.fullDocumentMarkup(plan)}</main></body>`, { pretendToBeVisual: true });
  dom.window.jennyShell = { tools: { approve: async (...args) => { onApprove?.(args); return true; } } };
  const controller = createPlanDocumentController({ windowRef: dom.window, actionButton, textField });
  return { dom, controller, host: dom.window.document.querySelector('[data-plan-document]') };
}

test('approving an unedited formatted plan reports not edited and omits the plan', async () => {
  const decisions = [];
  const raw = 'Add the `retry: helper`: backoff to **30 s**';
  const { dom, controller, host } = mountPlan({ tool_call_id: 'fmt', title: 'T', steps: [raw], state: 'pending' },
    (args) => decisions.push(args));
  assert.equal(host.querySelector('[data-plan-edited]').hidden, true);
  host.querySelector('[data-plan-decision="approved"]').click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.deepEqual(decisions, [['fmt', { decision: 'approved', feedback: '' }]]);
  controller.dispose();
  dom.window.close();
});

test('editing a formatted step by clicking nested code shows and sends the raw string', async () => {
  const decisions = [];
  const raw = 'Add the `retry: helper`: backoff to **30 s**';
  const { dom, controller, host } = mountPlan({ tool_call_id: 'edit', title: 'T', steps: [raw], state: 'pending' },
    (args) => decisions.push(args));
  assert.ok(host.querySelector('[data-plan-step-text] code'));
  host.querySelector('[data-plan-step-text] code').click();
  const input = host.querySelector('[data-plan-step-index="0"] input');
  assert.ok(input);
  assert.equal(input.value, raw);
  input.value = `${raw} again`;
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(host.querySelector('[data-plan-edited]').hidden, false);
  assert.equal(host.querySelector('[data-plan-step-text]').dataset.planStepRaw, `${raw} again`);
  assert.ok(host.querySelector('[data-plan-step-text] code'));
  host.querySelector('[data-plan-decision="approved"]').click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.deepEqual(decisions[0][1].plan, { title: 'T', steps: [`${raw} again`] });
  controller.dispose();
  dom.window.close();
});

test('re-rendered plan restores the fold state of its sections', async () => {
  const plan = { tool_call_id: 'fold', title: 'T', steps: ['A'], notes: 'short', verification: 'Run it', state: 'pending' };
  const { dom, controller, host } = mountPlan(plan);
  const notes = host.querySelector('[data-plan-section="notes"]');
  const check = host.querySelector('[data-plan-section="check"]');
  assert.equal(notes.open, true);
  notes.open = false;
  notes.dispatchEvent(new dom.window.Event('toggle'));
  check.open = false;
  check.dispatchEvent(new dom.window.Event('toggle'));
  const timeline = dom.window.document.getElementById('chatTimeline');
  timeline.innerHTML = documentUi.fullDocumentMarkup(plan);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  const again = timeline.querySelector('[data-plan-document]');
  assert.equal(again.querySelector('[data-plan-section="notes"]').open, false);
  assert.equal(again.querySelector('[data-plan-section="check"]').open, false);
  controller.dispose();
  dom.window.close();
});
