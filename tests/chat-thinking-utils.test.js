const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ThinkingPanelController,
  getThinkingSummary,
  getRenderableReasoningPhaseGroups,
  groupReasoningByPhase,
  groupReasoningPhaseMetadata,
  joinReasoningEntriesMarkdown,
  shouldShowThinkingToggle,
} = require('../renderer/chat/chat-thinking-utils');
const { prettifyReasoningMarkdown } = require('../renderer/chat/reasoning-prettify-utils');

function fullPrettifiedJoin(entries) {
  return entries
    .map((entry) => String(entry?.text || '').trim())
    .filter(Boolean)
    .map((text) => prettifyReasoningMarkdown(text))
    .join('\n\n')
    .trim();
}

function chunkFixture(text, seed) {
  let state = seed;
  const chunks = [];
  for (let offset = 0; offset < text.length;) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const size = 1 + (state % 97);
    chunks.push(text.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

test('thinking controller toggles expanded state and pauses auto-scroll on expand', () => {
  // 2026-08-29: this legacy message-only path represents historical/non-tail expansion.
  const controller = new ThinkingPanelController();

  assert.equal(controller.toggleExpanded('assistant_1'), true);
  assert.equal(controller.isExpanded('assistant_1'), true);
  assert.equal(controller.shouldAutoScroll(), false);

  assert.equal(controller.toggleExpanded('assistant_1'), false);
  assert.equal(controller.isExpanded('assistant_1'), false);
});

test('returning to bottom clears reader-away pause without erasing an expanded-reasoning pause', () => {
  // 2026-08-29: this pin covers the historical/non-tail reasoning pause.
  const controller = new ThinkingPanelController();

  controller.toggleExpanded('assistant_1');
  assert.equal(controller.handleScroll({ scrollTop: 0, scrollHeight: 800, clientHeight: 300 }), false);
  assert.equal(controller.shouldAutoScroll(), false);

  assert.equal(controller.handleScroll({ scrollTop: 500, scrollHeight: 800, clientHeight: 300 }), true);
  assert.equal(controller.shouldAutoScroll(), false, 'expanded reasoning remains an explicit pause reason');

  controller.toggleExpanded('assistant_1');
  assert.equal(controller.shouldAutoScroll(), true, 'collapsing reasoning releases the remaining pause');
});

test('an explicit new-turn reset follows despite historical expansion until the next disclosure interaction', () => {
  // 2026-08-29: this pin deliberately exercises a historical/non-tail phase.
  const controller = new ThinkingPanelController();
  controller.togglePhaseExpanded('assistant_old', 'think_old');
  assert.equal(controller.shouldAutoScroll(), false);

  controller.resumeAutoScroll();
  controller.prune(['assistant_old', 'assistant_new']);
  assert.equal(controller.isPhaseExpanded('assistant_old', 'think_old'), true);
  assert.equal(controller.shouldAutoScroll(), true, 'historical expansion cannot cancel the send reset');

  controller.togglePhaseExpanded('assistant_old', 'think_old');
  controller.togglePhaseExpanded('assistant_old', 'think_old');
  assert.equal(controller.shouldAutoScroll(), false, 'a new explicit expansion restores the pause');
});

test('expanding the live streaming tail does not pause auto-scroll (2026-08-29)', () => {
  const controller = new ThinkingPanelController();

  controller.togglePhaseExpanded(
    'assistant_1',
    'think_live',
    false,
    { liveStreamingTail: true }
  );
  assert.equal(controller.shouldAutoScroll(), true);

  controller.prune(['assistant_1']);
  assert.equal(controller.shouldAutoScroll(), true);

  controller.togglePhaseExpanded('assistant_1', 'think_live');
  assert.equal(controller.shouldAutoScroll(), true);
  assert.equal(controller.followExemptPhaseKeys.has('assistant_1::think_live'), false);

  controller.togglePhaseExpanded('assistant_1', 'think_hist');
  assert.equal(controller.shouldAutoScroll(), false);
});

test('bulk expansion clears the live-tail follow exemption (2026-08-29)', () => {
  const controller = new ThinkingPanelController();

  controller.togglePhaseExpanded(
    'assistant_1',
    'think_live',
    false,
    { liveStreamingTail: true }
  );
  assert.equal(controller.shouldAutoScroll(), true);

  // Expand All writes phaseExpansionState directly, then clears exemptions
  // and re-syncs — a deliberate reasoning interaction restores the pause.
  controller.phaseExpansionState.set('assistant_1::think_live', true);
  controller.clearFollowExemptions();
  controller.syncReasoningExpansionPause({ userInitiated: true });

  assert.equal(controller.shouldAutoScroll(), false);
});

test('a live streaming tail does not override a historical expansion pause', () => {
  const controller = new ThinkingPanelController();

  controller.togglePhaseExpanded('assistant_1', 'think_hist');
  controller.togglePhaseExpanded(
    'assistant_1',
    'think_live',
    false,
    { liveStreamingTail: true }
  );

  assert.equal(controller.shouldAutoScroll(), false);
});

test('thinking controller uses the inclusive 48 px follow boundary', () => {
  const cases = [
    [31, true], [32, true], [33, true], [47, true], [48, true], [49, false],
  ];
  for (const [bottomDistance, expected] of cases) {
    const controller = new ThinkingPanelController();
    const nearBottom = controller.handleScroll({
      scrollTop: 600 - bottomDistance,
      scrollHeight: 1000,
      clientHeight: 400,
    });
    assert.equal(nearBottom, expected, `${bottomDistance}px bottom distance`);
    assert.equal(controller.shouldAutoScroll(), expected, `${bottomDistance}px pause state`);
  }
});

test('thinking controller exposes button accessibility state and prunes stale expansions', () => {
  const controller = new ThinkingPanelController();
  controller.togglePhaseExpanded('assistant_1', 'think_a');

  const a11y = controller.getPhaseToggleA11y(
    'assistant_1',
    'think_a',
    controller.isPhaseExpanded('assistant_1', 'think_a')
  );
  assert.equal(a11y.ariaExpanded, 'true');
  assert.equal(a11y.ariaControls, 'reasoning-panel-assistant_1-think_a');

  controller.prune(['assistant_2']);
  assert.equal(controller.isPhaseExpanded('assistant_1', 'think_a'), false);
});

test('thinking controller clears expanded phase state when the outer disclosure collapses', () => {
  const controller = new ThinkingPanelController();

  controller.toggleExpanded('assistant_1');
  controller.togglePhaseExpanded('assistant_1', 'think_a');

  assert.equal(controller.isExpanded('assistant_1'), true);
  assert.equal(controller.toggleExpanded('assistant_1'), false);
  assert.equal(controller.isExpanded('assistant_1'), false);
  assert.equal(controller.isPhaseExpanded('assistant_1', 'think_a'), false);
});

test('groupReasoningByPhase keeps sequential thinkingId runs stable and preserves legacy blanks', () => {
  assert.deepEqual(
    groupReasoningByPhase([
      { id: 'r1', text: 'alpha', thinkingId: 'think_1' },
      { id: 'r2', text: 'beta', thinkingId: 'think_1' },
      { id: 'r3', text: 'gamma', thinkingId: 'think_2' },
      { id: 'r4', text: 'legacy' },
      { id: 'r5', text: 'legacy-more' },
    ]),
    [
      {
        thinkingId: 'think_1',
        entries: [
          { id: 'r1', text: 'alpha', thinkingId: 'think_1' },
          { id: 'r2', text: 'beta', thinkingId: 'think_1' },
        ],
      },
      {
        thinkingId: 'think_2',
        entries: [
          { id: 'r3', text: 'gamma', thinkingId: 'think_2' },
        ],
      },
      {
        thinkingId: '',
        entries: [
          { id: 'r4', text: 'legacy' },
          { id: 'r5', text: 'legacy-more' },
        ],
      },
    ]
  );
});

test('thinking utilities derive summaries and toggle visibility rules from message state', () => {
  const message = {
    id: 'assistant_1',
    role: 'assistant',
    status: 'complete',
    reasoning: {
      source: 'provider',
      entries: [{ id: 'reason_1', text: 'Forming a concise answer.', timestamp: '2026-03-12T15:20:00.000Z' }],
    },
  };

  assert.equal(getThinkingSummary(message), 'Forming a concise answer.');
  assert.equal(shouldShowThinkingToggle(message, { latestAssistantMessageId: 'assistant_1' }), true);
  assert.equal(
    shouldShowThinkingToggle(
      { id: 'assistant_2', role: 'assistant', status: 'streaming', reasoning: { entries: [] } },
      { latestAssistantMessageId: 'assistant_2' }
    ),
    false
  );
  assert.equal(
    shouldShowThinkingToggle(
      {
        id: 'assistant_3',
        role: 'assistant',
        status: 'complete',
        reasoning: {
          source: 'none',
          entries: [{ id: 'reason_2', text: 'Placeholder', timestamp: '2026-03-12T15:21:00.000Z' }],
        },
      },
      { latestAssistantMessageId: 'assistant_3' }
    ),
    false
  );
  const phaseOnlyMessage = {
    id: 'assistant_4',
    role: 'assistant',
    status: 'streaming',
    reasoning: { source: 'none', entries: [] },
    reasoning_phases: [
      {
        phaseKind: 'reasoning',
        phaseId: 'phase_1',
        thinkingId: 'think_1',
        summary: 'Reading context',
      },
    ],
  };
  assert.equal(shouldShowThinkingToggle(phaseOnlyMessage), true);
  assert.deepEqual(
    getRenderableReasoningPhaseGroups(phaseOnlyMessage),
    [{ phaseId: 'phase_1', phaseKey: 'think_1', thinkingId: 'think_1', entries: [] }]
  );
});

test('renderable phase groups keep duplicated thinking ids distinct by phase id', () => {
  const message = {
    id: 'assistant_5',
    role: 'assistant',
    status: 'streaming',
    reasoning: { source: 'none', entries: [] },
    reasoning_phases: [
      { phaseKind: 'reasoning', phaseId: 'phase_1', thinkingId: 'dup_tid', summary: 'Reading context' },
      { phaseKind: 'reasoning', phaseId: 'phase_2', thinkingId: 'dup_tid', summary: 'Checking tools' },
    ],
  };

  assert.deepEqual(
    getRenderableReasoningPhaseGroups(message),
    [
      { phaseId: 'phase_1', phaseKey: 'phase_1', thinkingId: 'dup_tid', entries: [] },
      { phaseId: 'phase_2', phaseKey: 'phase_2', thinkingId: 'dup_tid', entries: [] },
    ]
  );
});

test('reasoning phase metadata prefers a colliding live phase over a completed phase', () => {
  const completedPhase = {
    phaseKind: 'reasoning',
    phaseId: 'phase_1',
    thinkingId: 'think_1',
    completed: true,
  };
  const livePhase = {
    phase_kind: 'reasoning',
    phase_id: 'phase_1',
    thinking_id: 'think_1',
    completed: false,
  };

  const metadata = groupReasoningPhaseMetadata({
    reasoning_phases: [completedPhase, livePhase],
  });

  assert.equal(metadata.get('phase_1'), livePhase);
  assert.equal(metadata.get('think_1'), livePhase);
});

test('reasoning phase metadata keeps the first of two completed collisions', () => {
  const firstPhase = {
    phaseKind: 'reasoning',
    phaseId: 'phase_1',
    thinkingId: 'think_1',
    completed: true,
  };
  const secondPhase = {
    phaseKind: 'reasoning',
    phaseId: 'phase_1',
    thinkingId: 'think_1',
    completed: true,
  };

  const metadata = groupReasoningPhaseMetadata({
    reasoning_phases: [firstPhase, secondPhase],
  });

  assert.equal(metadata.get('phase_1'), firstPhase);
  assert.equal(metadata.get('think_1'), firstPhase);
});

test('markdownToPlainReasoningLabel unwraps GPT-style bold title lines', () => {
  const { markdownToPlainReasoningLabel } = require('../renderer/chat/chat-thinking-utils');
  assert.equal(
    markdownToPlainReasoningLabel('**Testing local file URL access**'),
    'Testing local file URL access'
  );
  assert.equal(markdownToPlainReasoningLabel('### **Checking config**'), 'Checking config');
  assert.equal(markdownToPlainReasoningLabel('__Whole label__'), 'Whole label');
  assert.equal(markdownToPlainReasoningLabel('reviewing `git status` output'), 'reviewing git status output');
});

test('markdownToPlainReasoningLabel never mangles identifiers or unpaired markers', () => {
  const { markdownToPlainReasoningLabel } = require('../renderer/chat/chat-thinking-utils');
  assert.equal(
    markdownToPlainReasoningLabel('Verify snake_case and *partial'),
    'Verify snake_case and *partial'
  );
  assert.equal(
    markdownToPlainReasoningLabel('Checking __init__.py imports'),
    'Checking __init__.py imports'
  );
  assert.equal(markdownToPlainReasoningLabel('inspect **kwargs handling'), 'inspect **kwargs handling');
  assert.equal(markdownToPlainReasoningLabel(''), '');
  assert.equal(markdownToPlainReasoningLabel(null), '');
});

test('incremental reasoning prettify stays byte-equal across 50 random chunkings', () => {
  const sparsePrefix = `Sparse reasoning end.Next thought ${'keeps growing without a newline '.repeat(32)}`;
  const denseTail = Array.from({ length: 18 }, (_, index) => `dense line ${index}`).join('\n');
  const fixture = [
    sparsePrefix,
    '',
    denseTail,
    '',
    '```js',
    'const result = run();',
    'verify(result);',
    '```',
    '',
    'Final paragraph end.Next conclusion.',
  ].join('\n');

  for (let seed = 1; seed <= 50; seed += 1) {
    let growingText = '';
    const settledEntry = {
      id: `settled_${seed}`,
      text: 'Settled entry end.Next remains unchanged.\n\nIts cached output is stable.',
    };
    for (const chunk of chunkFixture(fixture, seed)) {
      growingText += chunk;
      const entries = [
        settledEntry,
        { id: `growing_${seed}`, text: growingText },
      ];
      assert.equal(
        joinReasoningEntriesMarkdown(entries),
        fullPrettifiedJoin(entries),
        `seed ${seed}, prefix length ${growingText.length}`,
      );
    }
  }
});
