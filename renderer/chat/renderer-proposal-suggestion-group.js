(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererProposalSuggestionGroup = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  // The grouped suggestions tray (row 59 checkpoint 5a-2). A group is the set of unsolicited
  // propose_session rows that share a group_id; each member keeps its own tool row. The FIRST
  // member (oldest by created_at, then proposal_id: the sessionProposals.list order) carries the
  // header, "{n} suggested tasks" plus Start all, and the header is patched on any member
  // change. Pure helpers and markup: the store owns the member list, the actions file owns the
  // Start all gesture. Nothing here executes anything.
  const MAX_START_ALL = 10;

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function actionableNow(proposal, now) {
    if (!proposal || proposal.kind !== 'session' || proposal.decision_state !== 'pending') return false;
    const expires = Date.parse(String(proposal.expires_at || ''));
    return !Number.isFinite(expires) || expires > now;
  }

  function members(group) {
    return group && Array.isArray(group.members) ? group.members : [];
  }

  /** True when this proposal is the group's first row (the one that draws the header). */
  function isFirstMember(group, proposalId) {
    const list = members(group);
    return list.length > 0 && list[0].proposal_id === proposalId;
  }

  /** Actionable = still pending and unexpired; the header count and Start all read only these rows. */
  function actionableMembers(group, now) {
    const at = Number.isFinite(now) ? now : Date.now();
    return members(group).filter((member) => actionableNow(member, at));
  }

  /** The Start all snapshot, taken at click time: [{proposal_id, expected_revision}] of rows New session can still start. */
  function snapshotItems(group, now) {
    return actionableMembers(group, now)
      .filter((member) => asObject(member.actions) && asObject(member.actions.new_session) && member.actions.new_session.available === true)
      .slice(0, MAX_START_ALL)
      .map((member) => ({ proposal_id: member.proposal_id, expected_revision: member.revision }));
  }

  /** One stable string for the snapshot: the same rows at the same revisions reuse one group decision_id. */
  function snapshotSignature(items) {
    return items.map((item) => `${item.proposal_id}@${item.expected_revision}`).join(',');
  }

  function countLabel(count) {
    return count > 0
      ? jtn('chat.proposal.session.groupCount', count, { count }, '{count} suggested task', '{count} suggested tasks')
      : jt('chat.proposal.session.groupTitle', 'Suggested tasks');
  }

  /**
   * ctx: {sessionId, groupId, group (store lookupGroup), now}; deps: {escapeHtml, actionButton}.
   * Always the same element ([data-proposal-group]) so a patch can replace it in place.
   */
  function headerMarkup(deps, ctx) {
    const { escapeHtml } = deps;
    const group = ctx.group;
    const actionable = actionableMembers(group, ctx.now).length;
    const startable = snapshotItems(group, ctx.now).length;
    const busy = Boolean(group && group.busy);
    const startAll = actionable > 0
      ? deps.actionButton({
        variant: 'ghost', size: 'sm', className: 'proposal-start-all', label: jt('chat.proposal.session.startAll', 'Start all'),
        title: jt('chat.proposal.session.startAllTitle', 'Start every pending suggestion in its own new chat'),
        disabled: busy || startable === 0, dataset: { 'proposal-action': 'start-all' },
      })
      : '';
    const notice = group && group.notice && typeof group.notice.text === 'string' && group.notice.text
      ? `<p class="proposal-notice" role="status" aria-live="polite">${escapeHtml(group.notice.text)}</p>` : '';
    return `<div class="proposal-group-head" data-proposal-group="${escapeHtml(ctx.groupId)}" data-proposal-session="${escapeHtml(ctx.sessionId)}"`
      + `${busy ? ' aria-busy="true"' : ''} tabindex="-1">`
      + `<span class="proposal-group-count">${escapeHtml(countLabel(actionable))}</span>${startAll}${notice}</div>`;
  }

  return { MAX_START_ALL, actionableNow, isFirstMember, actionableMembers, snapshotItems, snapshotSignature, countLabel, headerMarkup };
});
