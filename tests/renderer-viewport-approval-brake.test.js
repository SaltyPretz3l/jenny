'use strict';

// Approval-gap scroll brake (renderer-viewport-scheduling-utils.js): a pending
// approval prompt holds live-follow only once its actions are on screen above
// the floating composer, and resolving it holds position for exactly one sync.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createViewportControllerHarness } = require('./helpers/renderer-viewport-utils-helpers.js');

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

test('viewport controller keeps following a pending approval that is hidden under the composer', () => {
  // Owner report, 2026-09-30: a new approval prompt landed underneath the
  // composer and the reader had to scroll down to reach Allow/Deny. The scroll
  // container runs behind the floating composer, so a prompt peeking in at its
  // bottom counted as "visible" and the brake froze follow before it was revealed.
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setComposerTop(480);
    harness.setPendingApprovalVisible(true);
    harness.setPendingApprovalRect({ top: 470, bottom: 560 });
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();

    assert.ok(harness.chatThreadScroll.scrollTop > 0, 'follow must reveal a prompt covered by the composer');
  } finally {
    harness.restore();
  }
});

test('viewport controller brakes once the approval actions clear the composer', () => {
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setComposerTop(480);
    harness.setPendingApprovalVisible(true);
    harness.setPendingApprovalRect({ top: 380, bottom: 470 });
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();

    assert.equal(harness.chatThreadScroll.scrollTop, 0, 'a fully revealed prompt holds the reader in place');
  } finally {
    harness.restore();
  }
});

// A pending plan proposal as the timeline renders it: a 1px approval marker row
// at the card's top edge and the actions host (Build it / Keep planning) at its
// bottom. The harness has no selector engine, so each node answers for the
// selector parts that would match it.
function mountPendingPlanCard(harness, { actions, submitting = false }) {
  const node = (top, bottom) => ({
    getBoundingClientRect() { return { top, bottom, width: 600, height: bottom - top }; },
  });
  harness.chatThreadScroll._querySelectorAllImpl = (selector) => {
    const text = String(selector || '');
    const found = [];
    if (text.includes('.approval-gap-row') && !text.includes(':not([data-approval-variant="plan"])')) {
      found.push(node(300, 301));
    }
    if (text.includes('[data-plan-actions]') && !submitting) {
      found.push(node(actions.top, actions.bottom));
    }
    return found;
  };
}

test('viewport controller keeps following while a pending plan card has its actions under the composer', () => {
  // Owner report, 2026-09-30 (dogfood HB-030): a new plan proposal stopped
  // scrolling as soon as its first pixel showed, leaving Build it / Keep
  // planning below the composer.
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setComposerTop(480);
    mountPendingPlanCard(harness, { actions: { top: 900, bottom: 940 } });
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1600, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();

    assert.ok(harness.chatThreadScroll.scrollTop > 0, 'follow must reveal the plan actions, not stop at the card top');
  } finally {
    harness.restore();
  }
});

test('viewport controller brakes once the plan actions clear the composer', () => {
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setComposerTop(480);
    mountPendingPlanCard(harness, { actions: { top: 420, bottom: 460 } });
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1600, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();

    assert.equal(harness.chatThreadScroll.scrollTop, 0, 'revealed plan actions hold the reader in place');
  } finally {
    harness.restore();
  }
});

test('viewport controller holds position for one sync when a plan card is submitted', () => {
  const harness = createViewportControllerHarness({ deferAnimationFrame: true, autoScrollThread: true });

  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setComposerTop(480);
    mountPendingPlanCard(harness, { actions: { top: 420, bottom: 460 } });
    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1600, clientHeight: 400 });

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();
    assert.equal(harness.chatThreadScroll.scrollTop, 0, 'follow is held while the plan actions are visible');

    // Build it: the card is submitting, so it no longer counts as a pending decision.
    mountPendingPlanCard(harness, { actions: { top: 420, bottom: 460 }, submitting: true });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();
    assert.equal(harness.chatThreadScroll.scrollTop, 0, 'approving the plan must not yank the reader to the bottom');

    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }], { preserveFollowLatest: true });
    harness.flushAnimationFrame();
    assert.ok(harness.chatThreadScroll.scrollTop > 0, 'the build stream resumes follow on the next sync');
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
