const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createThinkingViewportHarness,
  createViewportControllerHarness,
} = require('./helpers/renderer-viewport-utils-helpers.js');
const { deriveFollowLatestFromScroll } = require('../renderer/chat/chat-scroll-utils.js');
const {
  createViewportLiveFollowUtils,
} = require('../renderer/shell/renderer-viewport-live-follow-utils.js');

test('viewport controller uses the inclusive 48 px follow boundary', () => {
  const harness = createViewportControllerHarness({ deriveFollowLatestFromScroll });
  try {
    const cases = [
      [31, true], [32, true], [33, true], [47, true], [48, true], [49, false],
    ];
    for (const [bottomDistance, expected] of cases) {
      const snapshot = {
        scrollTop: 600 - bottomDistance,
        scrollHeight: 1000,
        clientHeight: 400,
        bottomDistance,
        nearBottom: expected,
        direction: 'none',
        userInitiated: true,
        timestamp: bottomDistance,
      };
      harness.controller.syncThreadScrollState(snapshot);
      assert.equal(harness.state.ui.followLatest, expected, `${bottomDistance}px bottom distance`);
    }
  } finally {
    harness.restore();
  }
});

test('layout-only tool growth preserves follow-latest intent between settled follow steps', () => {
  const harness = createViewportControllerHarness({ deriveFollowLatestFromScroll });
  try {
    harness.state.ui.followLatest = true;

    const nearBottom = harness.controller.syncThreadScrollState({
      scrollTop: 600,
      scrollHeight: 1240,
      clientHeight: 400,
      bottomDistance: 240,
      nearBottom: false,
      direction: 'none',
      userInitiated: false,
      timestamp: 1,
    });

    assert.equal(nearBottom, false);
    assert.equal(harness.state.ui.followLatest, true);
    assert.equal(harness.getThinkingHandleScrollCount(), 0);
    assert.deepEqual(harness.getThinkingResumeReasons(), ['reader_away']);
  } finally {
    harness.restore();
  }
});

test('reader input still detaches after tool growth while layout shrink can reattach', () => {
  const harness = createViewportControllerHarness({ deriveFollowLatestFromScroll });
  try {
    harness.state.ui.followLatest = true;
    harness.controller.syncThreadScrollState({
      scrollTop: 600,
      scrollHeight: 1240,
      clientHeight: 400,
      userInitiated: true,
    });
    assert.equal(harness.state.ui.followLatest, false);

    harness.controller.syncThreadScrollState({
      scrollTop: 600,
      scrollHeight: 1048,
      clientHeight: 400,
      userInitiated: false,
    });
    assert.equal(harness.state.ui.followLatest, true);
  } finally {
    harness.restore();
  }
});

test('explicit latest navigation clears only the reader-away thinking pause', () => {
  const harness = createViewportControllerHarness();
  try {
    harness.setScrollMetrics({ scrollTop: 200, scrollHeight: 1000, clientHeight: 400 });

    harness.controller.scrollThreadToBottom({ behavior: 'auto' });

    assert.equal(harness.chatThreadScroll.scrollTop, 600);
    assert.equal(harness.state.ui.followLatest, true);
    assert.deepEqual(harness.getThinkingResumeReasons(), ['reader_away']);
  } finally {
    harness.restore();
  }
});

test('sentinel bottom snap attributes the programmatic write before scrolling', () => {
  const calls = [];
  const sentinel = {
    scrollIntoView(options) {
      calls.push(['scrollIntoView', options]);
    },
  };
  const liveFollow = createViewportLiveFollowUtils({
    state: { ui: {} },
    chatThreadScroll: {
      querySelector() { return sentinel; },
    },
    noteProgrammaticWrite(reason) {
      calls.push(['noteProgrammaticWrite', reason]);
    },
  });

  liveFollow.snapThreadToBottom({ behavior: 'smooth' });

  assert.deepEqual(calls, [
    ['noteProgrammaticWrite', 'live_follow'],
    ['scrollIntoView', { behavior: 'smooth', block: 'end', inline: 'nearest' }],
  ]);
});

test('viewport controller toggles recap expansion in renderer state without mutating recap payload', async () => {
  const harness = createViewportControllerHarness();

  try {
    const recapMessage = {
      id: 'recap-1',
      role: 'assistant',
      kind: 'interactive_round_recap',
      content: 'Asked 1 question',
      interactive_round_recap: {
        round_index: 1,
        answer_count: 1,
        items: [
          { question_id: 'q1', prompt: 'What kind of pace feels right?', answer_label: 'Steady' },
        ],
        collapsed: false,
      },
    };
    harness.setCurrentMessages([recapMessage]);

    await harness.controller.toggleInteractiveRoundRecap('recap-1');

    assert.equal(harness.getRenderedCount(), 1);
    assert.equal(harness.getCurrentMessages()[0].interactive_round_recap.collapsed, false);
    assert.equal(
      harness.controller.isInteractiveRoundRecapExpanded('interactive-recap:recap-1', 'session-1'),
      true
    );

    await harness.controller.toggleInteractiveRoundRecap('recap-1');

    assert.equal(harness.getRenderedCount(), 2);
    assert.equal(harness.getCurrentMessages()[0].interactive_round_recap.collapsed, false);
    assert.equal(
      harness.controller.isInteractiveRoundRecapExpanded('interactive-recap:recap-1', 'session-1'),
      false
    );
  } finally {
    harness.restore();
  }
});
test('viewport controller keeps recap expansion scoped per session and prunes stale ids', async () => {
  const harness = createViewportControllerHarness();

  try {
    harness.setCurrentMessages([
      {
        id: 'recap-1',
        role: 'assistant',
        kind: 'interactive_round_recap',
        content: 'Asked 1 question',
        interactive_round_recap: {
          round_index: 1,
          answer_count: 1,
          items: [{ question_id: 'q1', prompt: 'One', answer_label: 'A' }],
        },
      },
      {
        id: 'recap-2',
        role: 'assistant',
        kind: 'interactive_round_recap',
        content: 'Asked 2 questions',
        interactive_round_recap: {
          round_index: 2,
          answer_count: 2,
          items: [{ question_id: 'q2', prompt: 'Two', answer_label: 'B' }],
        },
      },
    ]);

    await harness.controller.toggleInteractiveRoundRecap('recap-1');
    assert.equal(
      harness.controller.isInteractiveRoundRecapExpanded('interactive-recap:recap-1', 'session-1'),
      true
    );

    harness.state.currentSessionId = 'session-2';
    assert.equal(
      harness.controller.isInteractiveRoundRecapExpanded('interactive-recap:recap-1', 'session-2'),
      false
    );

    await harness.controller.toggleInteractiveRoundRecap('recap-2');
    assert.equal(
      harness.controller.isInteractiveRoundRecapExpanded('interactive-recap:recap-2', 'session-2'),
      true
    );
    assert.equal(
      harness.controller.isInteractiveRoundRecapExpanded('interactive-recap:recap-1', 'session-1'),
      true
    );

    harness.controller.pruneInteractiveRoundRecapExpansionState('session-1', [harness.getCurrentMessages()[1]]);
    assert.equal(
      harness.controller.isInteractiveRoundRecapExpanded('interactive-recap:recap-1', 'session-1'),
      false
    );
  } finally {
    harness.restore();
  }
});

test('viewport controller writes app height and safe offset from the thread stage gap', () => {
  const harness = createViewportControllerHarness();

  try {
    harness.controller.initializeComposerLayoutObserver();

    assert.equal(harness.rootStyle.getPropertyValue('--app-window-height'), '777px');
    assert.equal(harness.chatView.style.getPropertyValue('--composer-safe-offset'), '38px');
    assert.equal(harness.chatView.style.getPropertyValue('--empty-hero-stage-bottom'), '38px');
    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-left-width'), '44px');
    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-right-width'), '100px');
    assert.equal(harness.controller.getComposerSafeOffset(), 38);
    assert.deepEqual(
      harness.instances[0].observeCalls,
      [
        harness.chatView,
        harness.chatThreadStage,
        harness.chatSurfaceEffects,
        harness.chatThreadColumn,
        harness.composerWrap,
      ]
    );

    harness.setComposerTop(620);
    harness.instances[0].callback();

    assert.equal(harness.chatView.style.getPropertyValue('--composer-safe-offset'), '48px');
    assert.equal(harness.chatView.style.getPropertyValue('--empty-hero-stage-bottom'), '48px');
    assert.equal(harness.controller.getComposerSafeOffset(), 48);
  } finally {
    harness.restore();
  }
});

test('viewport controller measures chat gutter widths from the live thread column footprint', () => {
  const harness = createViewportControllerHarness();

  try {
    harness.controller.initializeComposerLayoutObserver();

    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-left-width'), '44px');
    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-right-width'), '100px');

    harness.setThreadColumnRect({ left: 92, width: 540 });
    harness.instances[0].callback();

    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-left-width'), '92px');
    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-right-width'), '116px');

    harness.setSurfaceLayerRect({ left: 12, width: 620 });
    harness.setThreadColumnRect({ left: 24, width: 596 });
    harness.instances[0].callback();

    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-left-width'), '12px');
    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-right-width'), '12px');
  } finally {
    harness.restore();
  }
});

test('viewport controller can preserve chat gutter widths during zoom-safe offset refreshes', () => {
  const harness = createViewportControllerHarness();

  try {
    harness.controller.initializeComposerLayoutObserver();

    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-left-width'), '44px');
    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-right-width'), '100px');

    harness.setComposerTop(620);
    harness.setThreadColumnRect({ left: 92, width: 540 });
    harness.controller.updateComposerSafeOffset({
      force: true,
      syncViewport: true,
      preserveSurfaceEffectWidths: true,
    });

    assert.equal(harness.chatView.style.getPropertyValue('--composer-safe-offset'), '48px');
    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-left-width'), '44px');
    assert.equal(harness.chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-right-width'), '100px');
  } finally {
    harness.restore();
  }
});

test('viewport controller reveals collapsed thread ancestors before message jumps', () => {
  const harness = createViewportControllerHarness();

  try {
    harness.state.ui.threadBranchesCollapsedBySession = new Map([
      ['session-1', new Set(['assistant_stream_tools'])],
    ]);
    harness.setCurrentMessages([
      { id: 'user_tools', role: 'user', content: 'Use tools', status: 'complete' },
      {
        id: 'assistant_stream_tools',
        role: 'assistant',
        streamId: 'stream-tools',
        content: 'Working...',
        status: 'complete',
      },
      {
        id: 'tool_use_call_read_1',
        role: 'assistant',
        kind: 'tool_use',
        status: 'completed',
        tool_call: {
          call_id: 'call_read_1',
          tool_name: 'Read',
          parent_stream_id: 'stream-tools',
        },
      },
      {
        id: 'assistant_stream_tools_seg1',
        role: 'assistant',
        streamId: 'stream-tools',
        content: 'Done.',
        status: 'complete',
      },
    ]);

    const changed = harness.controller.revealMessageAnchor('tool_use_call_read_1');

    assert.equal(changed, true);
    assert.equal(
      harness.state.ui.threadBranchesCollapsedBySession.has('session-1'),
      false,
      'revealing the target should clear the collapsed ancestor state for the session'
    );
    assert.equal(harness.getRenderedCount(), 1);
  } finally {
    harness.restore();
  }
});

test('viewport controller still reveals collapsed thread ancestors when row-model rollout metadata exists', () => {
  const harness = createViewportControllerHarness();

  try {
    harness.state.ui.threadBranchesCollapsedBySession = new Map([
      ['session-1', new Set(['assistant_stream_tools'])],
    ]);
    harness.state.ui.chatTimelineRowModelMetaBySession = new Map([
      ['session-1', {
        sticky_rollback: true,
        rollback_reason: 'artifact_anchor_miss',
      }],
    ]);
    harness.setCurrentMessages([
      { id: 'user_tools', role: 'user', content: 'Use tools', status: 'complete' },
      {
        id: 'assistant_stream_tools',
        role: 'assistant',
        streamId: 'stream-tools',
        content: 'Working...',
        status: 'complete',
      },
      {
        id: 'tool_use_call_read_1',
        role: 'assistant',
        kind: 'tool_use',
        status: 'completed',
        tool_call: {
          call_id: 'call_read_1',
          tool_name: 'Read',
          parent_stream_id: 'stream-tools',
        },
      },
    ]);

    const changed = harness.controller.revealMessageAnchor('tool_use_call_read_1');

    assert.equal(changed, true);
    assert.equal(harness.state.ui.threadBranchesCollapsedBySession.has('session-1'), false);
    assert.equal(harness.getRenderedCount(), 1);
  } finally {
    harness.restore();
  }
});

test('viewport controller reveal helper tolerates missing ui collapse state', () => {
  const harness = createViewportControllerHarness();

  try {
    harness.state.ui = undefined;

    const changed = harness.controller.revealMessageAnchor('tool_use_call_read_1');

    assert.equal(changed, false);
    assert.deepEqual(harness.state.ui.threadBranchesCollapsedBySession instanceof Map, true);
    assert.equal(harness.getRenderedCount(), 0);
  } finally {
    harness.restore();
  }
});

test('viewport controller discards malformed per-session collapse entries', () => {
  const harness = createViewportControllerHarness();
  try {
    harness.state.ui.threadBranchesCollapsedBySession = new Map([
      ['session-1', ['not-a-set']],
    ]);

    assert.equal(harness.controller.revealMessageAnchor('missing-message'), false);
    assert.equal(harness.state.ui.threadBranchesCollapsedBySession.has('session-1'), false);
    assert.equal(harness.getRenderedCount(), 0);
  } finally {
    harness.restore();
  }
});

test('viewport controller coalesces repeated viewport sync requests so the latest request wins', () => {
  const harness = createViewportControllerHarness({ deferAnimationFrame: true });

  try {
    harness.state.ui.followLatest = false;
    harness.setThinkingAutoScroll(true);
    harness.chatThreadStage.scrollHeight = 1000;
    harness.chatThreadStage.clientHeight = 400;

    const firstMessages = [{ id: 'assistant-1' }];
    const latestMessages = [{ id: 'assistant-2' }];

    harness.controller.scheduleMessageViewportSync(firstMessages, { forceBottom: true });
    harness.controller.scheduleMessageViewportSync(latestMessages, { preserveFollowLatest: true });

    assert.equal(harness.getSpriteUpdateCount(), 0);
    harness.flushAnimationFrame();

    assert.equal(harness.getSpriteUpdateCount(), 1);
    assert.deepEqual(harness.getLastSpriteMessages(), latestMessages);
    assert.equal(harness.getSyncThreadScrollStateCount(), 0);
    assert.equal(harness.getThinkingHandleScrollCount(), 0, 'programmatic patches do not masquerade as reader scroll');
  } finally {
    harness.restore();
  }
});

test('generic message jumps synchronously mount and re-resolve a virtualized target', () => {
  let ensureMountedCalls = 0;
  const harness = createViewportControllerHarness({
    timelineVirtualizer: {
      ensureMounted(entry) {
        ensureMountedCalls += 1;
        entry.removeAttribute('data-virtualized');
        return true;
      },
    },
  });
  try {
    const attributes = new Map([
      ['data-message-id', 'assistant-virtualized'],
      ['data-virtualized', 'true'],
    ]);
    let scrollCalls = 0;
    const target = {
      classList: { contains() { return false; } },
      contains() { return false; },
      getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
      removeAttribute(name) { attributes.delete(name); },
      closest(selector) {
        if (selector === '.chat-entry[data-message-id]') return this;
        return null;
      },
      scrollIntoView() { scrollCalls += 1; },
    };
    harness.chatTimeline._querySelectorAllImpl = (selector) => (
      String(selector).includes('data-message-id="assistant-virtualized"') ? [target] : []
    );

    assert.equal(harness.controller.scrollMessageIntoView('assistant-virtualized'), true);
    assert.equal(ensureMountedCalls, 1);
    assert.equal(scrollCalls, 1);
    assert.equal(target.getAttribute('data-virtualized'), null);
  } finally {
    harness.restore();
  }
});

test('text-only scoped stream sync performs no broad shell-geometry rectangle reads', () => {
  const harness = createViewportControllerHarness({ deferAnimationFrame: true });
  try {
    let shellGeometryReads = 0;
    for (const target of [
      harness.chatView,
      harness.chatSurfaceEffects,
      harness.chatThreadStage,
      harness.chatThreadColumn,
      harness.composerWrap,
    ]) {
      const readRect = target.getBoundingClientRect.bind(target);
      target.getBoundingClientRect = () => {
        shellGeometryReads += 1;
        return readRect();
      };
    }
    const patchedRoot = {
      querySelectorAll() { return []; },
      matches() { return false; },
    };

    harness.controller.scheduleMessageViewportSync(
      [{ id: 'assistant-stream' }],
      { patchedRoot, preserveFollowLatest: true }
    );
    harness.flushAnimationFrame();

    assert.equal(shellGeometryReads, 0);
  } finally {
    harness.restore();
  }
});

test('viewport controller subtly follows streaming growth instead of jumping to the bottom', () => {
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();

    assert.ok(harness.chatThreadScroll.scrollTop > 0, 'streaming follow should begin moving immediately');
    assert.ok(
      harness.chatThreadScroll.scrollTop < 600,
      'streaming follow should ease toward the max bottom instead of jumping there'
    );
  } finally {
    harness.restore();
  }
});

test('viewport controller retargets the live follow animation as streaming content grows', () => {
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();
    const firstScrollTop = harness.chatThreadScroll.scrollTop;

    harness.setScrollMetrics({ scrollHeight: 1400 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();

    assert.ok(harness.chatThreadScroll.scrollTop > firstScrollTop, 'retargeted follow should keep moving down');
    assert.ok(
      harness.chatThreadScroll.scrollTop < 1000,
      'retargeted follow should still ease toward the new bottom instead of snapping'
    );
  } finally {
    harness.restore();
  }
});

test('viewport controller cancels live streaming follow when follow-latest is disabled', () => {
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();
    const scrollTopAfterFirstStep = harness.chatThreadScroll.scrollTop;

    harness.controller.setFollowLatest(false);
    harness.flushAnimationFrame();

    assert.equal(harness.chatThreadScroll.scrollTop, scrollTopAfterFirstStep);
    assert.equal(harness.state.ui.followLatest, false);
  } finally {
    harness.restore();
  }
});

test('viewport controller keeps forced and reduced-motion streaming follow as direct bottom snaps', () => {
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { forceBottom: true });
    harness.flushAnimationFrame();

    assert.equal(harness.chatThreadScroll.scrollTop, 600);

    harness.setScrollMetrics({ scrollTop: 0 });
    harness.setReducedMotion(true);
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();

    assert.equal(harness.chatThreadScroll.scrollTop, 600);
  } finally {
    harness.restore();
  }
});

test('viewport controller does not live-follow while a pending approval gap is visible', () => {
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setPendingApprovalVisible(true);
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();

    assert.equal(harness.chatThreadScroll.scrollTop, 0);
  } finally {
    harness.restore();
  }
});

test('viewport controller holds the reader position on the sync that resolves an approval', () => {
  // Owner report, 2026-08-26: approving a tool call yanked the transcript to the
  // bottom. The approval gap is also a scroll brake - hasPendingApprovalGapInViewport
  // cancels live-follow on every sync while the prompt is on screen. Resolving it
  // removes the row, so the very next sync was the first one allowed to scroll and
  // it went straight for scrollHeight - clientHeight, throwing away wherever the
  // reader was sitting while they read what they were approving.
  //
  // The release is now deferred by exactly one sync: the structural
  // approval-resolution render holds position, and the next genuine streaming
  // sync resumes normal follow.
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setPendingApprovalVisible(true);
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();
    assert.equal(harness.chatThreadScroll.scrollTop, 0, 'follow is held while the approval is visible');

    // The user approves: the row is removed and the turn keeps rendering.
    harness.setPendingApprovalVisible(false);
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();
    assert.equal(
      harness.chatThreadScroll.scrollTop,
      0,
      'approving must not yank the reader to the bottom'
    );

    // Streaming continues; follow resumes on its own without a second approval.
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();
    assert.ok(
      harness.chatThreadScroll.scrollTop > 0,
      'the next streaming sync must resume follow rather than stranding the reader'
    );
  } finally {
    harness.restore();
  }
});

test('viewport controller still honours forceBottom on the sync that resolves an approval', () => {
  // The one-sync hold must not swallow an explicit jump-to-bottom - sending a new
  // message immediately after approving still has to land at the bottom.
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setPendingApprovalVisible(true);
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();

    harness.setPendingApprovalVisible(false);
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { forceBottom: true });
    harness.flushAnimationFrame();

    assert.equal(harness.chatThreadScroll.scrollTop, 600, 'forceBottom outranks the approval hold');
  } finally {
    harness.restore();
  }
});

test('viewport controller keeps following streamed growth across post-render syncs (no preserveFollowLatest)', () => {
  // Regression: the post-render streaming sync runs scheduleMessageViewportSync
  // WITHOUT preserveFollowLatest, so syncThreadScrollState() re-derives follow
  // from the scroll position. The eased animator only steps part-way toward the
  // grown bottom, so a naive position derive reads "not near bottom" and disables
  // follow - stranding streamed reasoning/response content below the fold until a
      // terminal forced snap reveals it all at once. Follow must survive the lag.
  const harness = createViewportControllerHarness({
    deferAnimationFrame: true,
    autoScrollThread: true,
    deriveFollowLatestFromScroll(metrics) {
      const gap = (Number(metrics.scrollHeight) || 0)
        - ((Number(metrics.scrollTop) || 0) + (Number(metrics.clientHeight) || 0));
      return gap <= 48;
    },
  });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    // User sits at the bottom (600 = 1000 - 400) when streaming begins.
    harness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    // New tokens grow the transcript; the bottom is now 1000 but the viewport
    // still sits at 600 - the eased animator must catch up.
    harness.setScrollMetrics({ scrollHeight: 1400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame(); // run the coalesced viewport sync frame

    const scrollTopAfterFirstStep = harness.chatThreadScroll.scrollTop;
    assert.ok(scrollTopAfterFirstStep > 600, 'follow should begin advancing toward the grown bottom');
    assert.equal(
      harness.state.ui.followLatest,
      true,
      'mid-animation lag must not be misread as a user scroll-away'
    );

    harness.flushAnimationFrame(); // run the next animator frame
    assert.ok(
      harness.chatThreadScroll.scrollTop > scrollTopAfterFirstStep,
      'the follow animator must keep running instead of being cancelled by the position re-derive'
    );
  } finally {
    harness.restore();
  }
});

test('viewport controller releases follow when the user scrolls up past the animated position', () => {
  const harness = createViewportControllerHarness({
    deferAnimationFrame: true,
    autoScrollThread: true,
    deriveFollowLatestFromScroll(metrics) {
      const gap = (Number(metrics.scrollHeight) || 0)
        - ((Number(metrics.scrollTop) || 0) + (Number(metrics.clientHeight) || 0));
      return gap <= 48;
    },
  });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    harness.setScrollMetrics({ scrollHeight: 1400 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.state.ui.followLatest, true, 'follow active after first sync');

    // Simulate a deliberate user scroll far above where the animator left the viewport.
    harness.setScrollMetrics({ scrollTop: 100 });
    harness.controller.syncThreadScrollState();
    assert.equal(
      harness.state.ui.followLatest,
      false,
      'a real upward scroll past the animated position releases follow'
    );
  } finally {
    harness.restore();
  }
});

test('viewport controller does not re-latch follow when a streaming sync re-anchors after the user scrolls away', () => {
  // Regression: scheduleMessageViewportSync's primary (non-preserveFollowLatest)
  // path calls startLiveStreamingFollow() BEFORE syncThreadScrollState(). If
  // startLiveStreamingFollow unconditionally re-anchors lastProgrammaticScrollTop
  // to the CURRENT scrollTop while already active, it captures the user's
  // scrolled-up position as the new "programmatic" baseline. The tolerance check
  // in syncThreadScrollState then compares actualScrollTop against that just-
  // re-anchored baseline, finds them equal, and re-affirms followLatest = true -
  // defeating the scroll-away release and dragging the user back toward the
  // bottom on every subsequent streaming chunk (the reported "tugging").
  const harness = createViewportControllerHarness({
    deferAnimationFrame: true,
    autoScrollThread: true,
    deriveFollowLatestFromScroll(metrics) {
      const gap = (Number(metrics.scrollHeight) || 0)
        - ((Number(metrics.scrollTop) || 0) + (Number(metrics.clientHeight) || 0));
      return gap <= 48;
    },
  });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    // Establish an active live-follow with the animator's last position near
    // the bottom (mirrors the ":492" release test's setup).
    harness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    harness.setScrollMetrics({ scrollHeight: 1400 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.state.ui.followLatest, true, 'follow active after first sync');
    const followedScrollTopBeforeUserScroll = harness.chatThreadScroll.scrollTop;

    // The user deliberately scrolls up, well past the 24px override tolerance,
    // to read earlier content while the reply keeps streaming.
    const userScrollTop = followedScrollTopBeforeUserScroll - 200;
    harness.setScrollMetrics({ scrollTop: userScrollTop });
    harness.controller.noteScrollInputIntent();

    // The next streamed chunk arrives and drives the PRIMARY streaming sync path
    // (no preserveFollowLatest) - exactly what scheduleMessageViewportSync's
    // real caller uses mid-stream.
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();

    assert.equal(
      harness.state.ui.followLatest,
      false,
      'a real upward scroll past the animated position must release follow even when a streaming sync fires first'
    );
    assert.ok(
      harness.chatThreadScroll.scrollTop <= userScrollTop,
      'scrollTop must not be pulled back down toward the bottom after the user scrolled away'
    );
  } finally {
    harness.restore();
  }
});

test('viewport controller keeps the last valid safe offset during transient zero-size measurements', () => {
  const harness = createViewportControllerHarness();

  try {
    harness.controller.initializeComposerLayoutObserver();
    assert.equal(harness.controller.getComposerSafeOffset(), 38);
    assert.equal(harness.chatView.style.getPropertyValue('--empty-hero-stage-bottom'), '38px');

    harness.setComposerHeight(0);
    harness.setComposerTop(0);
    harness.controller.updateComposerSafeOffset({ force: true });

    assert.equal(harness.chatView.style.getPropertyValue('--composer-safe-offset'), '38px');
    assert.equal(harness.chatView.style.getPropertyValue('--empty-hero-stage-bottom'), '38px');
    assert.equal(harness.controller.getComposerSafeOffset(), 38);
  } finally {
    harness.restore();
  }
});

test('viewport controller keeps only the latest delayed thinking viewport refresh after rapid toggles', () => {
  const harness = createThinkingViewportHarness();

  try {
    harness.setExpanded(true);
    harness.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    harness.flushAnimationFrames();

    assert.equal(harness.getSpriteUpdateCount(), 1);
    // One post-layout viewport timer plus one current reasoning settle timer;
    // re-arming cancels the superseded settle work.
    assert.equal(harness.getPendingTimeoutCount(), 2);

    harness.setExpanded(false);
    harness.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    harness.flushAnimationFrames();

    assert.equal(harness.getSpriteUpdateCount(), 2);
    assert.equal(
      harness.getPendingTimeoutCount(),
      2,
      'collapse keeps only its hide cleanup and the latest delayed viewport refresh'
    );

    harness.flushTimeouts();
    harness.flushAnimationFrames();

    assert.equal(harness.getSpriteUpdateCount(), 3);
    assert.equal(harness.getThinkingHandleScrollCount(), 0, 'deferred layout work is not reader input');
  } finally {
    harness.restore();
  }
});

test('viewport controller keeps an empty requested-open thinking panel hidden and reports it collapsed', () => {
  const harness = createThinkingViewportHarness();

  try {
    const toggle = global.document.querySelector('[data-reasoning-toggle][data-phase-key="phase_1"]');
    const panel = global.document.getElementById(toggle.getAttribute('aria-controls'));
    panel.classList.add('empty');
    harness.setExpanded(true);

    harness.controller.syncThinkingBlockNode('assistant_1', 'phase_1');

    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(panel.hidden, true);
    assert.equal(panel.classList.contains('expanded'), false);
  } finally {
    harness.restore();
  }
});

test('viewport controller still opens a body-bearing requested-open thinking panel', () => {
  const harness = createThinkingViewportHarness();

  try {
    const toggle = global.document.querySelector('[data-reasoning-toggle][data-phase-key="phase_1"]');
    const panel = global.document.getElementById(toggle.getAttribute('aria-controls'));
    harness.setExpanded(true);

    harness.controller.syncThinkingBlockNode('assistant_1', 'phase_1');

    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(panel.hidden, false);
    assert.equal(panel.classList.contains('expanded'), true);
  } finally {
    harness.restore();
  }
});

test('viewport controller clears pending delayed thinking viewport refreshes on dispose', () => {
  const harness = createThinkingViewportHarness();

  try {
    harness.setExpanded(true);
    harness.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    harness.flushAnimationFrames();

    assert.equal(harness.getSpriteUpdateCount(), 1);
    // One post-layout sync timer plus the current settle timer.
    assert.equal(harness.getPendingTimeoutCount(), 2);

    harness.controller.disposeViewportController();
    harness.flushTimeouts();
    harness.flushAnimationFrames();

    assert.equal(harness.getSpriteUpdateCount(), 1);
  } finally {
    harness.restore();
  }
});

test('viewport controller skips thinking-panel rAF bodies scheduled before dispose', () => {
  // Regression for the ifViewportLive disposal guard: when the controller is
  // disposed BEFORE the thinking-panel toggle's deferred rAF bodies fire, those
  // bodies must no-op (they would otherwise re-run a viewport sync against a
  // detached panel - AGENTS.md §5). The existing dispose test flushes the frames
  // before disposing, so it only covers the timer-cancel path, not this guard.
  const harness = createThinkingViewportHarness();

  try {
    harness.setExpanded(true);
    harness.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    // Dispose with the expand/post-layout rAFs still pending (un-flushed).
    harness.controller.disposeViewportController();
    harness.flushAnimationFrames();
    harness.flushTimeouts();

    assert.equal(
      harness.getSpriteUpdateCount(),
      0,
      'a rAF body scheduled before dispose must not run a viewport sync afterward'
    );
  } finally {
    harness.restore();
  }
});
