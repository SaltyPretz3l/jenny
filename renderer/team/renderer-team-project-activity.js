/* Team tab: a project page's Activity section, for the project's admins (row 123, slice 3-10; picks_3-10.md
 * "Project page" 4, E31). The project audit only (`projectAudit`): approvals answered and expired, files uploaded,
 * downloaded and copied in, and the always-allow rules. It holds counts and ids, never a file or folder name and
 * no membership change, so each kind gets one sentence from what an entry carries.
 *
 * The host reads the audit backwards (`before_seq`: the newest page below it, oldest first, at most 100 a page; its
 * `next_cursor` is the page's oldest seq, the next `before_seq`, or null at the start). So the newest 100 are one call
 * (a `before_seq` no entry reaches), and "Show earlier activity" reads the 100 before the oldest held, and so on, each
 * sequence number once. Shown: 20 at first, then everything read. Cap: 500 entries held; past that the oldest go and
 * the button stops. Each entry's sentence is built once, when it is read. The page reads it again on the project's
 * rules, requests or a finished transfer.
 *
 * `createActivity({ teamId, projectId, call, nameOf(id), conversationTitle(id), timeText(ms), errorText, onChange() })`
 * -> { html(), onClick(target), refresh(), dispose() }. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-project-column'));
    return;
  }
  root.rendererTeamProjectActivity = factory(root.rendererTeamProjectColumn);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (column) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const PAGE = 100;
  const FIRST_SHOWN = 20;
  const MAX_HELD = 500;
  const NEWEST = Number.MAX_SAFE_INTEGER; // a before_seq no entry reaches: the tail

  function inv() { return globalThis.inventory || {}; }
  const tag = () => globalThis.jennyI18n?.tag?.() || undefined;
  const number = (n) => Number(n || 0).toLocaleString(tag());
  // "118 MB", "4.2 KB": the size in the page's own words.
  function sizeText(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024 * 1024) return jt('team.projects.sizeGb', '{n} GB', { n: (n / 1024 ** 3).toLocaleString(tag(), { maximumFractionDigits: 1 }) });
    if (n >= 1024 * 1024) return jt('team.projects.sizeMb', '{n} MB', { n: Math.round(n / 1024 ** 2).toLocaleString(tag()) });
    if (n >= 1024) return jt('team.projects.sizeKb', '{n} KB', { n: Math.round(n / 1024).toLocaleString(tag()) });
    return jt('team.projects.sizeB', '{n} bytes', { n: number(n) });
  }

  // One sentence per audit kind. `who(id)`: a member's name; `where(id)`: a conversation's title or ''.
  function sentence(entry, who, where) {
    const actor = who(entry.actor_member_id);
    const prompter = who(entry.prompter_member_id);
    const tool = entry.tool_name || '';
    const title = column.clean(where(entry.session_id));
    const d = entry.detail || {};
    const params = { actor, prompter, tool, conversation: title };
    switch (entry.kind) {
      case 'approval_decided':
        if (entry.decision === 'denied') {
          return title ? jt('team.activity.denied', '{actor} denied {prompter}’s turn the use of {tool} in “{conversation}”', params)
            : jt('team.activity.deniedHere', '{actor} denied {prompter}’s turn the use of {tool}', params);
        }
        return title ? jt('team.activity.allowed', '{actor} allowed {prompter}’s turn to use {tool} in “{conversation}”', params)
          : jt('team.activity.allowedHere', '{actor} allowed {prompter}’s turn to use {tool}', params);
      case 'approval_not_applied':
        return title ? jt('team.activity.notApplied', '{actor}’s answer to {prompter}’s turn in “{conversation}” came too late and changed nothing', params)
          : jt('team.activity.notAppliedHere', '{actor}’s answer to {prompter}’s turn came too late and changed nothing', params);
      case 'approval_expired':
        return title ? jt('team.activity.expired', 'An approval in “{conversation}” expired with nobody to answer', params)
          : jt('team.activity.expiredHere', 'An approval expired with nobody to answer');
      case 'files_uploaded':
        return jtn('team.activity.uploaded', d.files || 0, { actor, size: sizeText(d.bytes), n: number(d.files) }, '{actor} uploaded {n} file ({size})', '{actor} uploaded {n} files ({size})');
      case 'files_downloaded':
        return jtn('team.activity.downloaded', d.files || 0, { actor, size: sizeText(d.bytes), n: number(d.files) }, '{actor} downloaded a copy: {n} file ({size})', '{actor} downloaded a copy: {n} files ({size})');
      case 'files_copied_in':
        return jtn('team.activity.copiedIn', d.files || 0, { size: sizeText(d.bytes), n: number(d.files) }, 'The host’s owner copied in {n} file ({size}) on the host', 'The host’s owner copied in {n} files ({size}) on the host');
      case 'rule_added': return jt('team.activity.ruleAdded', '{actor} always allowed {tool} in this project', { actor, tool });
      case 'rule_requested':
        return title ? jt('team.activity.ruleRequested', '{actor} asked the admins to always allow {tool}, from “{conversation}”', params)
          : jt('team.activity.ruleRequestedHere', '{actor} asked the admins to always allow {tool}', params);
      case 'rule_request_allowed': return jt('team.activity.ruleAllowed', '{actor} agreed to always allow {tool}', { actor, tool });
      case 'rule_request_changed': return jt('team.activity.ruleChanged', '{actor} agreed to always allow {tool}, narrowed', { actor, tool });
      case 'rule_request_declined': return jt('team.activity.ruleDeclined', '{actor} said no to always allowing {tool}', { actor, tool });
      case 'rule_removed': return jt('team.activity.ruleRemoved', '{actor} stopped always allowing {tool}', { actor, tool });
      case 'board_deleted': return jt('team.activity.boardDeleted', '{actor} deleted a board', { actor });
      case 'board_restored': return jt('team.activity.boardRestored', '{actor} restored a board', { actor });
      case 'board_batch_reverted': return jt('team.activity.boardReverted', '{actor} took back a change on a board', { actor });
      case 'board_bulk_removed': return jtn('team.activity.boardBulkRemoved', d.items || 0, { actor, n: number(d.items) }, '{actor} removed {n} item from a board', '{actor} removed {n} items from a board');
      case 'board_proposal_accepted':
        return d.change === 0 ? jtn('team.activity.boardAccepted', d.count || 0, { actor, prompter, n: number(d.count) }, '{actor} accepted {n} board change that {prompter} asked Jenny for', '{actor} accepted {n} board changes that {prompter} asked Jenny for')
          : jt('team.activity.boardAcceptedOne', '{actor} accepted a board change that {prompter} asked Jenny for', { actor, prompter });
      case 'board_proposal_rejected':
        return d.change === 0 ? jtn('team.activity.boardRejected', d.count || 0, { actor, prompter, n: number(d.count) }, '{actor} rejected {n} board change that {prompter} asked Jenny for', '{actor} rejected {n} board changes that {prompter} asked Jenny for')
          : jt('team.activity.boardRejectedOne', '{actor} rejected a board change that {prompter} asked Jenny for', { actor, prompter });
      default: return jt('team.activity.other', 'Something changed in this project');
    }
  }

  function createActivity({ teamId, projectId, call, nameOf, conversationTitle, timeText, errorText, onChange }) {
    const ids = { team_id: teamId, project_id: projectId };
    let entries = []; // newest first: { entry, text }
    let olderFrom = 0; // the before_seq that reads the page before the oldest held; 0: none left
    let all = false;
    let reading = false;
    let loaded = false; // a refresh keeps what was shown until its answer
    let error = '';
    let disposed = false;
    let epoch = 0;

    const page = (beforeSeq) => call('projectAudit', { ...ids, before_seq: beforeSeq, limit: PAGE });
    const said = (list) => list.map((entry) => ({ entry, text: sentence(entry, nameOf, conversationTitle) }));
    const keep = (list) => { entries = list.slice(0, MAX_HELD); if (list.length > MAX_HELD) olderFrom = 0; };

    async function load() {
      const run = ++epoch;
      reading = true;
      error = '';
      onChange();
      const newest = await page(NEWEST);
      if (disposed || run !== epoch) return;
      reading = false;
      loaded = true;
      if (!newest.ok) error = errorText(newest.error);
      else {
        keep(said(newest.entries.slice().reverse()));
        olderFrom = newest.next_cursor || 0;
      }
      onChange();
    }

    async function older() {
      if (!olderFrom || reading) return;
      const run = epoch;
      reading = true;
      onChange();
      const answer = await page(olderFrom);
      if (disposed || run !== epoch) return;
      reading = false;
      if (!answer.ok) { error = errorText(answer.error); onChange(); return; }
      // Each sequence number once, whatever overlap the host sends: not one already held, nor twice in the page.
      const seen = new Set(entries.map((item) => item.entry.seq));
      const before = answer.entries.filter((entry) => entry.seq < olderFrom && !seen.has(entry.seq) && seen.add(entry.seq)).reverse();
      olderFrom = before.length ? answer.next_cursor || 0 : 0;
      keep(entries.concat(said(before)));
      onChange();
    }

    function html() {
      const shown = all ? entries : entries.slice(0, FIRST_SHOWN);
      const lines = shown.map((item) => '<li><time>' + escapeHtml(timeText(item.entry.at)) + '</time><span dir="auto">' + escapeHtml(item.text) + '</span></li>').join('');
      const more = !all && entries.length > FIRST_SHOWN ? 'show' : (all && olderFrom ? 'older' : '');
      const label = more === 'older' ? jt('team.activity.earlier', 'Show earlier activity') : jt('team.activity.showAll', 'Show all activity');
      const after = more ? '<div class="team-set-after">' + inv().actionButton({ label, variant: 'ghost', size: 'sm', title: label, disabled: reading, dataset: { 'project-action': 'activity-more' } }) + '</div>' : '';
      const empty = !entries.length && loaded && !error ? '<p class="team-page__fact">' + escapeHtml(jt('team.activity.none', 'Nothing has happened in this project yet.')) + '</p>' : '';
      return '<section data-team-project-section="activity"><h3>' + escapeHtml(jt('team.activity.heading', 'Activity')) + '</h3>' + empty
        + (lines ? '<ul class="team-set-log">' + lines + '</ul>' : '') + after + (error ? '<p class="team-set-note" role="status">' + escapeHtml(error) + '</p>' : '') + '</section>';
    }

    function onClick(target) {
      if (target.dataset.projectAction !== 'activity-more') return false;
      if (!all) { all = true; onChange(); } else void older();
      return true;
    }

    // The first read starts after the page holds this section (its first redraw would otherwise make another).
    void Promise.resolve().then(() => { if (!disposed) void load(); });
    return { html, latest: () => (loaded && !error ? (entries.length ? entries[0].entry.at : 0) : null), onClick, refresh: load, dispose() { disposed = true; entries = []; } };
  }

  return { createActivity, sizeText };
});
