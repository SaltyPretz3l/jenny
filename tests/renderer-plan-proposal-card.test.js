const test = require('node:test');
const assert = require('node:assert/strict');

const planProposalCard = require('../renderer/features/renderer-plan-proposal-card');

const {
  normalizePendingPlanProposal,
  buildInertPlanProposalSummaryMarkup,
  createPlanProposalRowBuilder,
} = planProposalCard;

function validProposal() {
  return {
    proposal_id: 'pp_7',
    title: 'Tidy the photo library',
    intro_text: 'Three passes, all reversible.',
    steps: [
      { id: 's1', label: 'Scan for duplicates', detail: 'Hash-compare the originals' },
      { id: 's2', label: 'Group keepers by month' },
    ],
  };
}

function liveState(proposal) {
  return {
    currentSessionId: 'sess_1',
    sessions: [{ id: 'sess_1', pending_plan_proposal: proposal }],
    backend: { phase: 'ready' },
    auth: { authenticated: true },
  };
}

// ---- normalization ----

test('normalizePendingPlanProposal canonicalizes a full payload and defaults step ids', () => {
  const raw = validProposal();
  delete raw.steps[1].id;
  const normalized = normalizePendingPlanProposal(raw);
  assert.deepEqual(normalized, {
    proposal_id: 'pp_7',
    title: 'Tidy the photo library',
    intro_text: 'Three passes, all reversible.',
    steps: [
      { id: 's1', label: 'Scan for duplicates', detail: 'Hash-compare the originals' },
      { id: 's2', label: 'Group keepers by month' },
    ],
  });
});

test('normalizePendingPlanProposal rejects payloads the card cannot render', () => {
  assert.equal(normalizePendingPlanProposal(null), null);
  assert.equal(normalizePendingPlanProposal('plan'), null);
  assert.equal(normalizePendingPlanProposal({ ...validProposal(), title: '  ' }), null);
  assert.equal(normalizePendingPlanProposal({ ...validProposal(), proposal_id: '' }), null);
  assert.equal(normalizePendingPlanProposal({ ...validProposal(), steps: [] }), null);
  // a step without a label is dropped; all-unlabeled steps reject the payload
  assert.equal(
    normalizePendingPlanProposal({ ...validProposal(), steps: [{ id: 's1', label: '' }] }),
    null
  );
});

// ---- transcript (persisted message content; shared with the Electron backend) ----

test('buildPlanProposalTranscript renders the title, intro, and indented step details', () => {
  const text = planProposalCard.buildPlanProposalTranscript(validProposal());
  assert.equal(
    text,
    [
      'Jenny proposed a plan: Tidy the photo library',
      'Three passes, all reversible.',
      '',
      '1. Scan for duplicates',
      '   Hash-compare the originals',
      '2. Group keepers by month',
    ].join('\n')
  );
});

test('buildPlanProposalTranscript omits the intro line when absent and rejects unrenderable payloads', () => {
  const raw = validProposal();
  delete raw.intro_text;
  const text = planProposalCard.buildPlanProposalTranscript(raw);
  assert.match(text, /^Jenny proposed a plan: Tidy the photo library\n\n1\. /);
  assert.equal(planProposalCard.buildPlanProposalTranscript({ title: 'No steps', steps: [] }), '');
});

// ---- inert summary ----

test('inert summary renders past-tense kicker, labels only, and no affordances', () => {
  const markup = buildInertPlanProposalSummaryMarkup(validProposal());
  assert.match(markup, /class="ask-card ask-card-inert ask-card-proposal"/);
  assert.match(markup, /data-plan-proposal-inert="true"/);
  assert.match(markup, />Jenny proposed</);
  assert.match(markup, /plan-proposal-steps-inert/);
  assert.match(markup, /plan-proposal-step-label">Scan for duplicates</);
  assert.ok(!/plan-proposal-step-detail/.test(markup), 'details omitted in the inert summary');
  assert.ok(!/<button/.test(markup), 'no buttons');
  assert.ok(!/data-plan-proposal-approve/.test(markup), 'no approve affordance');
});

// ---- row builder ----

test('row builder renders every historical proposal inert', () => {
  const build = createPlanProposalRowBuilder({ state: liveState(validProposal()) });
  const markup = build({ payload: { plan_proposal: validProposal() } });
  assert.match(markup, /ask-card-inert/);
  assert.ok(!/chat-row-plan-proposal-mount/.test(markup));
  assert.ok(!/<button/.test(markup));
  assert.ok(!/data-plan-proposal-approve/.test(markup));
});

test('row builder returns empty markup without a renderable row proposal', () => {
  const build = createPlanProposalRowBuilder({ state: liveState(validProposal()) });
  assert.equal(build({ payload: {} }), '');
  assert.equal(build(null), '');
});
