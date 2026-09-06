const test = require('node:test');
const assert = require('node:assert/strict');

const { createCompanionActionUtils } = require('../renderer/features/renderer-companion-action-utils.js');

test('companion action utils derive unique resolvable Home actions', () => {
  const utils = createCompanionActionUtils();
  const focusAction = { id: 'focus:primary', type: 'prefill_chat', label: 'Focus', prompt: 'Focus' };
  const duplicateFocusAction = { id: 'focus:primary', type: 'prefill_chat', label: 'Duplicate', prompt: 'Nope' };
  const suggestedAction = { id: 'suggested:start', type: 'new_session', label: 'Start fresh' };
  const todayAction = { id: 'today:resume', type: 'continue_session', label: 'Resume', sessionId: 's1' };
  const reminderAction = { id: 'reminder:promote', type: 'promote_reminder', label: 'Promote', reminderId: 'r1' };
  const loopAction = { id: 'loop:done', type: 'resolve_follow_up', label: 'Done', followUpId: 'f1' };
  const companionState = {
    homeFocus: {
      primaryAction: focusAction,
      secondaryActions: [duplicateFocusAction],
    },
    suggestedActions: [suggestedAction, focusAction],
    todayCards: [{ items: [{ action: todayAction }] }],
    reminders: [{ action: reminderAction }],
    openLoopsBoard: {
      active: [{ actions: [loopAction] }],
      deferred: [],
      recentResolved: [],
      archived: [],
    },
  };

  assert.deepEqual(
    utils.getResolvableActions(companionState).map((action) => action.id),
    ['focus:primary', 'suggested:start', 'today:resume', 'reminder:promote', 'loop:done']
  );
});

test('companion action utils format handoff origin labels for chat actions', () => {
  const utils = createCompanionActionUtils();

  assert.equal(utils.formatCompanionOriginLabel({ label: 'Start Fresh Session' }), 'Home / New session');
  assert.equal(utils.formatCompanionOriginLabel({ label: 'Resume Current Session' }), 'Home / Resume');
  assert.equal(utils.formatCompanionOriginLabel({ label: 'Open Memories' }), 'Home / Open Memories');
});
