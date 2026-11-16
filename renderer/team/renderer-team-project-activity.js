/* Team tab: a project page's Activity section, for the project's admins (row 123, slice 3-10; picks_3-10.md
 * "Project page" 4, E31). The project audit only (`projectAudit`): approvals answered and expired, files uploaded,
 * downloaded and copied in, and the always-allow rules. It holds counts and ids, never a file or folder name and
 * no membership change, so each kind gets one sentence from what an entry carries.
 *
 * The host reads the audit oldest first (`after_seq`, at most 100 a page, `next_cursor`). Newest first is found so:
 * the first page; if more follow, probes of one entry find the last sequence number (doubling, then halving: at most
 * 40 probes, none after the page closes), then the newest 100 are read, and "Show all activity" reads the log again
 * and the 100 before them, and so on. Shown: 20 at first, then everything read. Cap: 500 entries held; past that the
 * oldest go and the button stops. Each entry's sentence is built once, when it is read. The page reads it again on
 * the project's rules, requests or a finished transfer.
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
  const MAX_PROBES = 40;

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
    let olderFrom = 0; // the after_seq that reads the page before the oldest held; 0: none left
    let all = false;
    let reading = false;
    let loaded = false; // a refresh keeps what was shown until its answer
    let error = '';
    let disposed = false;
    let epoch = 0;

    const page = (afterSeq, limit = PAGE) => call('projectAudit', { ...ids, after_seq: afterSeq, limit });
    const said = (list) => list.map((entry) => ({ entry, text: sentence(entry, nameOf, conversationTitle) }));
    const keep = (list) => { entries = list.slice(0, MAX_HELD); if (list.length > MAX_HELD) olderFrom = 0; };

    // The last sequence number: the smallest after_seq that answers nothing. `known` answers something. A probe that
    // answers entry e proves e - 1 answers something too.
    async function lastSeq(known) {
      let low = known;
      let high = 0;
      let step = PAGE;
      let probes = 0;
      const probe = async (afterSeq) => {
        probes += 1;
        if (disposed) return { error: null };
        const answer = await page(afterSeq, 1);
        if (disposed) return { error: null };
        if (!answer.ok) return { error: answer.error };
        return { seq: answer.entries.length ? answer.entries[0].seq : 0 };
      };
      while (!high && probes < MAX_PROBES) {
        const got = await probe(low + step);
        if ('error' in got) return got;
        if (got.seq) { low = Math.max(low + step, got.seq - 1); step *= 2; } else high = low + step;
      }
      while (high - low > 1 && probes < MAX_PROBES) {
        const mid = Math.floor((low + high) / 2);
        const got = await probe(mid);
        if ('error' in got) return got;
        if (got.seq) low = Math.max(mid, got.seq - 1); else high = mid;
      }
      return { seq: high && high - low <= 1 ? high : low + 1 };
    }

    async function load() {
      const run = ++epoch;
      reading = true;
      error = '';
      onChange();
      const first = await page(0);
      if (disposed || run !== epoch) return;
      if (!first.ok) { reading = false; loaded = true; error = errorText(first.error); onChange(); return; }
      if (first.next_cursor === null || first.entries.length < PAGE) {
        keep(said(first.entries.slice().reverse()));
        olderFrom = 0;
      } else {
        const last = await lastSeq(first.next_cursor);
        if (disposed || run !== epoch) return;
        if ('error' in last) { reading = false; error = errorText(last.error); onChange(); return; }
        const start = Math.max(first.next_cursor, last.seq - PAGE);
        const newest = await page(start);
        if (disposed || run !== epoch) return;
        if (!newest.ok) { reading = false; error = errorText(newest.error); onChange(); return; }
        // What lies between the first page and the newest (none when they meet) is read by "Show all activity".
        const tail = said(newest.entries.slice().reverse());
        keep(start <= first.next_cursor ? tail.concat(said(first.entries.slice().reverse())) : tail);
        olderFrom = start > first.next_cursor ? start : 0;
      }
      reading = false;
      loaded = true;
      onChange();
    }

    async function older() {
      if (!olderFrom || reading) return;
      const run = epoch;
      reading = true;
      onChange();
      const start = Math.max(0, olderFrom - PAGE);
      const answer = await page(start, olderFrom - start);
      if (disposed || run !== epoch) return;
      reading = false;
      if (!answer.ok) { error = errorText(answer.error); onChange(); return; }
      const before = answer.entries.filter((entry) => entry.seq <= olderFrom).reverse();
      olderFrom = start > 0 && before.length ? start : 0;
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
      if (!all) { all = true; void load(); } else void older();
      return true;
    }

    // The first read starts after the page holds this section (its first redraw would otherwise make another).
    void Promise.resolve().then(() => { if (!disposed) void load(); });
    return { html, onClick, refresh: load, dispose() { disposed = true; entries = []; } };
  }

  return { createActivity, sizeText };
});
