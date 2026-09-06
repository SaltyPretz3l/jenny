const { clipText, normalizeString } = require('./backend/path-utils');

function isActionObject(action) {
  return action && typeof action === 'object' && !Array.isArray(action);
}

function actionList(actions) {
  return Array.isArray(actions) ? actions.filter(isActionObject) : [];
}

function firstActionOfType(actions, type) {
  return actionList(actions).find((action) => normalizeString(action.type) === type) || null;
}

function firstUsableAction(actions) {
  return actionList(actions).find((action) =>
    normalizeString(action.type) && normalizeString(action.label)
  ) || null;
}

function withoutAction(actions, actionToRemove) {
  const actionId = normalizeString(actionToRemove?.id);
  return actionList(actions)
    .filter((action) => normalizeString(action.id) !== actionId)
    .slice(0, 3);
}

function buildLoopFocus(loop) {
  const actions = actionList(loop?.actions);
  const primaryAction =
    firstActionOfType(actions, 'continue_session')
    || firstActionOfType(actions, 'resolve_follow_up')
    || firstUsableAction(actions);
  const metaParts = [
    normalizeString(loop?.contextLine),
    normalizeString(loop?.timingLabel),
  ].filter(Boolean);
  return {
    id: `focus:open_loop:${normalizeString(loop?.followUpId) || normalizeString(loop?.id) || 'active'}`,
    kind: 'open_loop',
    label: loop?.isDue ? 'Due now' : 'Active loop',
    title: normalizeString(loop?.title) || 'Untitled open loop',
    meta: metaParts.join(' | ')
      || normalizeString(loop?.body)
      || 'Keep this thread visible from Home until you are ready to resume it.',
    state: loop?.isDue ? 'due' : 'loop',
    primaryAction,
    secondaryActions: withoutAction(actions, primaryAction),
  };
}

function firstActionableCardItem(card) {
  return Array.isArray(card?.items)
    ? card.items.find((entry) => normalizeString(entry?.label) && isActionObject(entry?.action)) || null
    : null;
}

function buildResumeFocus(card) {
  const item = firstActionableCardItem(card);
  if (!item) {
    return null;
  }
  return {
    id: `focus:resume:${normalizeString(item.action?.sessionId) || normalizeString(item.label) || 'item'}`,
    kind: 'resume',
    label: 'Ready to resume',
    title: normalizeString(item.label) || 'Resume interrupted work',
    meta: normalizeString(item.detail) || 'A recent session has resumable work waiting.',
    state: 'resume',
    primaryAction: item.action || null,
    secondaryActions: [],
  };
}

function buildReminderFocus(reminder) {
  return {
    id: `focus:reminder:${normalizeString(reminder?.id) || 'item'}`,
    kind: 'reminder',
    label: 'Reminder',
    title: normalizeString(reminder?.label) || 'Reminder',
    meta: normalizeString(reminder?.prompt)
      || 'Promote this reminder to keep it visible on Home.',
    state: 'reminder',
    primaryAction: reminder?.action || null,
    secondaryActions: [],
  };
}

function buildSuggestedFocus(action) {
  return {
    id: `focus:suggested:${normalizeString(action?.id) || 'action'}`,
    kind: 'suggested',
    label: 'Suggested start',
    title: normalizeString(action?.label) || 'Companion suggestion',
    meta: clipText(
      normalizeString(action?.prompt) || 'Jenny has a suggested next move ready based on your current mode.',
      180
    ),
    state: 'suggested',
    primaryAction: action || null,
    secondaryActions: [],
  };
}

function buildClearFocus() {
  return {
    id: 'focus:clear',
    kind: 'clear',
    label: 'Clear runway',
    title: 'Nothing urgent is waiting.',
    meta: 'Pick a mode, start a fresh session, or add an open loop to keep something visible.',
    state: 'clear',
    primaryAction: null,
    secondaryActions: [],
  };
}

function buildHomeFocus({
  openLoopsBoard,
  todayCards,
  reminders,
  suggestedActions,
} = {}) {
  const activeLoops = Array.isArray(openLoopsBoard?.active) ? openLoopsBoard.active : [];
  const dueLoop = activeLoops.find((loop) => loop?.isDue);
  const primaryLoop = dueLoop || activeLoops[0] || null;
  if (primaryLoop) {
    return buildLoopFocus(primaryLoop);
  }

  const readyToResumeCard = Array.isArray(todayCards)
    ? todayCards.find((card) => normalizeString(card?.id) === 'ready-to-resume')
    : null;
  const resumeFocus = buildResumeFocus(readyToResumeCard);
  if (resumeFocus) {
    return resumeFocus;
  }

  // Reminders never fire on their own (no scheduler exists — UIUX-017), so
  // every reminder with a promote action is a candidate.
  const reminder = (Array.isArray(reminders) ? reminders : [])
    .find((entry) => entry && isActionObject(entry.action));
  if (reminder) {
    return buildReminderFocus(reminder);
  }

  const firstAction = Array.isArray(suggestedActions) ? suggestedActions[0] : null;
  if (firstAction) {
    return buildSuggestedFocus(firstAction);
  }

  return buildClearFocus();
}

module.exports = {
  buildHomeFocus,
};
