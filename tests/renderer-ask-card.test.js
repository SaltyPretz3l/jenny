// Wave E — stacked "Jenny asks" card. buildInteractivePanelMarkup is pure, so
// the layout contract (every question rendered at once, kicker header, batch
// progress, per-question skip, footer gating) is pinned here without a DOM.
// The focus test fakes the panel element: the 'question' focus request must
// land on the next unresolved question's first option.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInteractivePanelMarkup,
  buildInertInteractiveBatchSummaryMarkup,
  createInteractivePanelRenderer,
} = require('../renderer/features/renderer-interactive-panel-utils');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const OTHER_OPTION_ID = '__other__';

function makeHelpers(overrides = {}) {
  return {
    disabled: false,
    escapeHtml,
    getInteractiveQuestionOptions: (question) => question.options || [],
    // Test-double semantics: answered = a non-Other selection, or a confirmed
    // Other (customMode false + text saved).
    isInteractiveQuestionAnswered: (question, draft) => {
      const selected = String(draft?.selections?.[question.id] || '');
      if (!selected) {
        return false;
      }
      if (selected !== OTHER_OPTION_ID) {
        return true;
      }
      return !draft?.customModeByQuestionId?.[question.id]
        && Boolean(String(draft?.customTextByQuestionId?.[question.id] || '').trim());
    },
    areInteractiveQuestionsAnswered: () => false,
    isInteractiveOtherTrigger: (question, optionId) => optionId === OTHER_OPTION_ID,
    ...overrides,
  };
}

function makeBatch() {
  return {
    batch_id: 'qb_stacked',
    intro_text: 'Two quick choices before I start.',
    questions: [
      {
        id: 'q1',
        prompt: 'Which auth flow?',
        options: [
          { id: 'oauth', label: 'OAuth' },
          { id: 'magic', label: 'Magic link' },
          { id: OTHER_OPTION_ID, label: 'Other' },
        ],
      },
      {
        id: 'q2',
        prompt: 'Target browsers?',
        options: [
          { id: 'evergreen', label: 'Evergreen' },
          { id: 'legacy', label: 'Include IE11' },
        ],
      },
      {
        id: 'q3',
        prompt: 'Ship behind a flag?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
    ],
  };
}

function makeDraft(overrides = {}) {
  return {
    selections: {},
    customTextByQuestionId: {},
    customModeByQuestionId: {},
    skippedByQuestionId: {},
    activeQuestionIndex: 0,
    ...overrides,
  };
}

test('ask card renders every question stacked with no tab strip', () => {
  const markup = buildInteractivePanelMarkup(makeBatch(), makeDraft(), makeHelpers());

  assert.match(markup, /class="ask-card"/);
  assert.match(markup, /Which auth flow\?/);
  assert.match(markup, /Target browsers\?/);
  assert.match(markup, /Ship behind a flag\?/);
  assert.equal((markup.match(/class="ask-card-question"/g) || []).length, 3);
  // Every question's options are live at once (answer in any order).
  for (const optionId of ['oauth', 'magic', 'evergreen', 'legacy', 'yes', 'no']) {
    assert.match(markup, new RegExp(`data-option-id="${optionId}"`));
  }
  assert.doesNotMatch(markup, /data-interactive-tab/);
  assert.doesNotMatch(markup, /role="tablist"/);
  assert.doesNotMatch(markup, /Question 1 of/);
});

test('ask card header carries the family kicker and batch progress', () => {
  const draft = makeDraft({ selections: { q1: 'oauth' } });
  const markup = buildInteractivePanelMarkup(makeBatch(), draft, makeHelpers());

  assert.match(markup, /class="ask-card-kicker"/);
  assert.match(markup, /Jenny asks/);
  assert.match(markup, /class="ask-card-kicker-dot" aria-hidden="true"/);
  assert.match(markup, /class="ask-card-progress"/);
  assert.match(markup, /1 of 3 answered/);
});

test('ask card hides the progress counter for single-question batches', () => {
  const batch = { batch_id: 'qb_one', questions: [makeBatch().questions[0]] };
  const markup = buildInteractivePanelMarkup(batch, makeDraft(), makeHelpers());

  assert.doesNotMatch(markup, /ask-card-progress/);
  assert.match(markup, /Jenny asks/);
});

test('ask card renders per-question skip for unresolved questions only', () => {
  const draft = makeDraft({
    selections: { q1: 'oauth' },
    skippedByQuestionId: { q2: true },
  });
  const markup = buildInteractivePanelMarkup(makeBatch(), draft, makeHelpers());

  // q3 is the only unresolved question -> exactly one skip button.
  assert.equal((markup.match(/data-interactive-skip-question="true"/g) || []).length, 1);
  assert.match(markup, /title="Skip this question"/);
  assert.match(markup, /data-interactive-skip-question="true"[^>]*\n[^>]*data-question-id="q3"/);
  assert.match(markup, /data-question-state="answered"/);
  assert.match(markup, /data-question-state="skipped"/);
  assert.match(markup, /interactive-question-skipped-note/);
});

test('ask card renders the Other input only inside its own question', () => {
  const draft = makeDraft({
    selections: { q1: OTHER_OPTION_ID },
    customModeByQuestionId: { q1: true },
    customTextByQuestionId: { q1: '' },
  });
  const markup = buildInteractivePanelMarkup(makeBatch(), draft, makeHelpers());

  assert.equal((markup.match(/data-interactive-other-input="true"/g) || []).length, 1);
  assert.match(markup, /data-interactive-other-input="true"[^>]*\n[^>]*data-batch-id="qb_stacked"\n[^>]*data-question-id="q1"/);
  // Empty text -> confirm stays disabled, submit stays disabled.
  assert.match(markup, /data-interactive-other-confirm="true"[^>]*\n\s*disabled/);
  assert.match(markup, /data-interactive-submit="true"\n[^>]*data-batch-id="qb_stacked"\n\s*disabled/);
});

test('ask card footer gates submit on full resolution and offers skip-all only when 2+ remain', () => {
  const batch = makeBatch();
  const helpers = makeHelpers();

  const fresh = buildInteractivePanelMarkup(batch, makeDraft(), helpers);
  assert.match(fresh, /data-interactive-submit="true"\n[^>]*data-batch-id="qb_stacked"\n\s*disabled/);
  assert.match(fresh, /Skip all \(3\)/);
  assert.match(fresh, /3 questions remaining\./);

  const resolved = buildInteractivePanelMarkup(
    batch,
    makeDraft({ selections: { q1: 'oauth', q2: 'evergreen' }, skippedByQuestionId: { q3: true } }),
    helpers
  );
  assert.doesNotMatch(resolved, /data-interactive-submit="true"\n[^>]*data-batch-id="qb_stacked"\n\s*disabled/);
  assert.doesNotMatch(resolved, /data-interactive-skip-all/);
  assert.match(resolved, /Review answers - some were skipped\./);
});

test('ask card disables every affordance behind the send-busy gate', () => {
  const markup = buildInteractivePanelMarkup(
    makeBatch(),
    makeDraft({ selections: { q1: OTHER_OPTION_ID }, customModeByQuestionId: { q1: true } }),
    makeHelpers({ disabled: true })
  );

  const enabledControls = (markup.match(/<(button|input)\b[^>]*>/g) || [])
    .filter((tag) => !/\bdisabled\b/.test(tag));
  assert.deepEqual(enabledControls, []);
});

test('inert summary keeps the family identity with zero affordances', () => {
  const markup = buildInertInteractiveBatchSummaryMarkup(makeBatch(), escapeHtml);

  assert.match(markup, /class="ask-card ask-card-inert"/);
  assert.match(markup, /data-interactive-inert="true"/);
  assert.match(markup, /Jenny asked/);
  assert.match(markup, /Which auth flow\?/);
  assert.doesNotMatch(markup, /data-interactive-option/);
  assert.doesNotMatch(markup, /data-interactive-submit/);
  assert.doesNotMatch(markup, /data-interactive-skip/);
});

test('focus flush routes a question request to that question\'s first option', (t) => {
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { callback(); return 0; };
  t.after(() => {
    if (previousRaf === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = previousRaf;
    }
  });

  const focused = [];
  const fakeOptionByQuestion = {
    q2: { focus: () => focused.push('q2-option') },
  };
  const panelEl = {
    querySelector(selector) {
      const match = /\[data-interactive-option\]\[data-question-id="([^"]+)"\]/.exec(selector);
      if (match) {
        return fakeOptionByQuestion[match[1]] || null;
      }
      return null;
    },
    classList: { remove() {}, add() {} },
  };
  const renderer = createInteractivePanelRenderer({
    state: { ui: {} },
    dom: {
      composer: null,
      chatInput: null,
      chatTimeline: { querySelector: () => panelEl },
    },
    callbacks: {
      getPendingQuestionBatch: () => null,
      hasStalePendingQuestionBatch: () => false,
      getInteractiveDraft: () => null,
      getInteractiveQuestionOptions: () => [],
      isInteractiveQuestionAnswered: () => false,
      areInteractiveQuestionsAnswered: () => false,
      isInteractiveOtherTrigger: () => false,
      isSendBusy: () => false,
      escapeHtml,
      escapeSelectorValue: (value) => String(value),
    },
  });

  renderer.queueInteractiveComposerFocus({ type: 'question', questionId: 'q2' });
  renderer.flushInteractiveComposerFocus();
  assert.deepEqual(focused, ['q2-option']);

  renderer.clearStalledTimer();
});
