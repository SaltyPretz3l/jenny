/* renderer/features/renderer-suggested-changes-model.js
 * Pure view model for suggested changes (row 35 Plan Plus W2; UI spec §3.3-3.4).
 *
 * Input is the `suggestedChanges.list` view Electron returns (entries with
 * status, revision, comments and expected_hash). Output is what the Changes
 * view's suggested state and the decision bar render: the current batch, the
 * status-dot rows, the header progress, the footer and the bar for one change.
 * No DOM, no bridge, no timers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSuggestedChangesModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const TERMINAL = new Set(['applied', 'rejected']);
  // The statuses a person still has to look at, in the order "next" walks them.
  const NEEDS_DECISION = new Set(['to_review', 'out_of_date', 'needs_attention']);
  const ACCEPTABLE = new Set(['to_review', 'later', 'needs_attention']);
  const REJECTABLE = new Set(['to_review', 'later', 'out_of_date', 'needs_attention', 'accepted', 'revising']);
  const LATER_FROM = new Set(['to_review', 'out_of_date', 'needs_attention', 'accepted']);
  const COMMENT_PREVIEW_CHARS = 80;

  function entriesOf(list) {
    return list && Array.isArray(list.entries) ? list.entries.filter((entry) => entry && entry.id) : [];
  }

  function isLive(entry) {
    return !TERMINAL.has(entry.status);
  }

  function byCreated(a, b) {
    const left = String(a.created_at || '');
    const right = String(b.created_at || '');
    if (left !== right) return left < right ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
  }

  /**
   * The batch on screen. A batch starts after the last point where every
   * earlier suggestion had been decided before the next one arrived, so
   * deciding the first changes keeps them in the batch (progress, finish
   * totals). Later counts as waiting. No live suggestion, no batch: the view
   * shows History, or the finish summary the controller kept.
   */
  function currentBatch(list) {
    const entries = entriesOf(list).slice().sort(byCreated);
    if (!entries.some(isLive)) return [];
    let start = 0;
    let decidedAt = '';
    for (let index = 0; index < entries.length - 1; index += 1) {
      if (isLive(entries[index])) break;
      const at = String(entries[index].updated_at || entries[index].created_at || '');
      if (at > decidedAt) decidedAt = at;
      if (decidedAt <= String(entries[index + 1].created_at || '')) start = index + 1;
    }
    return groupTogether(entries.slice(start));
  }

  // The members of a group sit together, at the place of the first one.
  function groupTogether(entries) {
    const out = [];
    const placed = new Set();
    for (const entry of entries) {
      if (placed.has(entry.id)) continue;
      const members = entry.group_id ? entries.filter((item) => item.group_id === entry.group_id) : [entry];
      for (const member of members) {
        placed.add(member.id);
        out.push(member);
      }
    }
    return out;
  }

  /* ── Groups and dependencies (W3; UI spec §3.3-3.4, §4.2) ── */

  // How the bar and rows name another change: its number in the batch, else its title.
  function changeRef(batch, entries, id) {
    const index = batch.findIndex((item) => item.id === id);
    if (index >= 0) return String(index + 1);
    const entry = entries.find((item) => item.id === id);
    return entry ? `“${clip(titleOf(entry), 40)}”` : '?';
  }

  function dependencies(entries, entry) {
    const ids = Array.isArray(entry.depends_on) ? entry.depends_on : [];
    return ids.map((id) => entries.find((item) => item.id === id)).filter(Boolean);
  }

  // Dependencies still to apply first (a same-group one applies with this change).
  function pendingDependencies(entries, entry) {
    return dependencies(entries, entry).filter((dep) => isLive(dep) && !(entry.group_id && dep.group_id === entry.group_id));
  }

  function rejectedDependency(entries, entry) {
    return dependencies(entries, entry).find((dep) => dep.status === 'rejected') || null;
  }

  function liveGroupSize(entries, entry) {
    if (!entry.group_id) return 0;
    const members = entries.filter((item) => item.group_id === entry.group_id && isLive(item));
    return members.length >= 2 ? members.length : 0;
  }

  const stripModule = (path) => String(path || '').replace(/\.[^./]+$/, '').replace(/\/(?:index|__init__)$/, '');

  // Derived facts and Jenny's declared assumptions (working spec decision 4).
  function relationFacts(batch, entries, entry) {
    const facts = [];
    // Proved by the sidecar when the change was made; a later suggested file answers a missing import.
    for (const fact of Array.isArray(entry.facts) ? entry.facts : []) {
      if (fact.kind === 'import_removed') {
        facts.push({ kind: 'import_removed', text: jt('changes.bar.factImportRemoved', 'Removes the import of {name}.', { name: fact.name }) });
      } else if (fact.kind === 'import_missing' && !entries.some((item) => item.kind === 'create' && item.status !== 'rejected'
        && stripModule(item.path) === stripModule(fact.target))) {
        facts.push({ kind: 'import_missing', text: jt('changes.bar.factImportMissing', 'Imports {name}, which isn’t in the project and no suggestion creates it.', { name: fact.name }), warn: true });
      }
    }
    for (const relation of Array.isArray(entry.relations) ? entry.relations : []) {
      const dep = entries.find((item) => item.id === relation.id);
      if (!dep || dep.status === 'applied') continue;
      const n = changeRef(batch, entries, dep.id);
      if (relation.kind === 'import') {
        facts.push({ kind: 'import', text: jt('changes.bar.factImport', 'Imports {name}, which change {n} creates.', { name: relation.name, n }) });
      } else if (relation.kind === 'defines') {
        facts.push({ kind: 'defines', text: jt('changes.bar.factDefines', 'Uses {name}, which change {n} adds.', { name: relation.name, n }) });
      } else {
        facts.push({ kind: 'declared', text: jt('changes.bar.factDeclared', 'Jenny says this needs change {n}.', { n }), assumption: true });
      }
    }
    return facts;
  }

  function fileName(path) {
    const parts = String(path || '').split('/');
    return parts[parts.length - 1] || String(path || '');
  }

  function unsentComments(entry) {
    return (Array.isArray(entry.comments) ? entry.comments : []).filter((comment) => comment && !comment.sent_at);
  }

  function clip(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function titleOf(entry) {
    return String(entry.title || '').trim() || jt('changes.suggested.untitled', 'Change to {file}', { file: fileName(entry.path) });
  }

  function secondLine(entry, batch = [], entries = []) {
    const pendingComment = unsentComments(entry).slice(-1)[0];
    if (entry.status === 'revising') {
      return { text: jt('changes.suggested.revising', 'Jenny is revising this one'), tone: 'active' };
    }
    if (entry.status === 'rejected') return { text: jt('changes.suggested.rejected', 'Rejected'), tone: 'muted' };
    if (entry.status === 'later') return { text: jt('changes.suggested.later', 'Later'), tone: 'muted' };
    if (entry.status === 'out_of_date') {
      return { text: jt('changes.suggested.outOfDate', 'Out of date: the file changed'), tone: 'warn' };
    }
    if (entry.status === 'needs_attention') {
      const rejected = rejectedDependency(entries, entry);
      return rejected
        ? { text: jt('changes.suggested.needsAttentionDep', 'Needs attention: depends on rejected change {n}', { n: changeRef(batch, entries, rejected.id) }), tone: 'warn' }
        : { text: jt('changes.suggested.needsAttention', 'Needs attention'), tone: 'warn' };
    }
    if (entry.status === 'accepted' && liveGroupSize(entries, entry)) {
      return { text: jt('changes.suggested.acceptedGroup', 'Accepted, waits for the rest of the group'), tone: 'muted' };
    }
    const revisingDep = dependencies(entries, entry).find((dep) => dep.status === 'revising');
    if (revisingDep && isLive(entry)) {
      return { text: jt('changes.suggested.waitsForRevision', 'Waits for the revision of change {n}', { n: changeRef(batch, entries, revisingDep.id) }), tone: 'muted' };
    }
    if (pendingComment) {
      return {
        text: jt('changes.suggested.yourComment', 'Your comment: “{text}”', { text: clip(pendingComment.text, COMMENT_PREVIEW_CHARS) }),
        tone: 'muted',
      };
    }
    return null;
  }

  function rowState(entry, currentId) {
    if (entry.status === 'applied' || entry.status === 'accepted') return 'done';
    if (entry.status === 'rejected') return 'rejected';
    if (entry.status === 'revising') return 'working';
    if (entry.id === currentId) return 'current';
    if (entry.status === 'later') return 'later';
    return 'review';
  }

  /** The id to show when nothing is chosen (or the choice left the batch). */
  function defaultCurrentId(batch, preferredId) {
    if (preferredId && batch.some((entry) => entry.id === preferredId)) return preferredId;
    const next = batch.find((entry) => NEEDS_DECISION.has(entry.status))
      || batch.find((entry) => isLive(entry))
      || batch[0];
    return next ? next.id : '';
  }

  /** After a decision: the next change still to review, after `fromId`, wrapping. */
  function nextToReview(batch, fromId) {
    const index = batch.findIndex((entry) => entry.id === fromId);
    const ordered = index < 0 ? batch : batch.slice(index + 1).concat(batch.slice(0, index));
    const next = ordered.find((entry) => NEEDS_DECISION.has(entry.status));
    return next ? next.id : '';
  }

  /** Previous or next change in list order (Alt+[ / Alt+]); '' at either end. */
  function stepFrom(batch, fromId, delta) {
    const index = batch.findIndex((entry) => entry.id === fromId);
    const target = batch[index + delta];
    return index >= 0 && target ? target.id : '';
  }

  function progress(batch) {
    const done = batch.filter((entry) => TERMINAL.has(entry.status)).length;
    return { done, total: batch.length };
  }

  /**
   * The suggested state of the Changes view, or null when there is no batch.
   * `activity`: {generating, startedAt, now} for the footer's activity row.
   */
  function buildSuggestedView(list, { currentId = '', activity = null } = {}) {
    const batch = currentBatch(list);
    if (!batch.length) return null;
    const current = defaultCurrentId(batch, currentId);
    const entries = entriesOf(list);
    const rows = batch.map((entry) => ({
      id: entry.id,
      title: titleOf(entry),
      file: fileName(entry.path),
      path: entry.path,
      state: rowState(entry, current),
      secondLine: secondLine(entry, batch, entries),
      selected: entry.id === current,
      explain: Boolean(entry.what || entry.why),
      group: liveGroupSize(entries, entry) ? entry.group_id : '',
      menu: {
        later: LATER_FROM.has(entry.status),
        restore: entry.status === 'later' || entry.status === 'rejected',
        ungroup: Boolean(entry.group_id) && isLive(entry) && liveGroupSize(entries, entry) > 0,
      },
    }));
    const counts = progress(batch);
    const revising = batch.filter((entry) => entry.status === 'revising').length;
    const comments = Number(list && list.unsent_comment_count) || 0;
    let footerActivity = null;
    if (activity && activity.generating) {
      footerActivity = {
        label: revising
          ? jtn('changes.suggested.revisingCount', revising, { count: revising }, 'Revising {count} change', 'Revising {count} changes')
          : jt('changes.suggested.suggestingMore', 'Jenny is suggesting more changes'),
        startedAt: activity.startedAt || 0,
        elapsedMs: Math.max(0, (Number(activity.now) || 0) - (Number(activity.startedAt) || 0)),
      };
    }
    return {
      currentId: current,
      rows,
      header: {
        title: jt('changes.suggested.title', 'Suggested changes'),
        subtitle: jt('changes.suggested.subtitle', 'Nothing in your files changes until you accept.'),
        done: counts.done,
        total: counts.total,
        progressText: jt('changes.suggested.progress', '{done} of {total} done', counts),
      },
      footer: { activity: footerActivity, comments, historyLink: !footerActivity && !comments },
    };
  }

  /** The finish summary for a batch whose last suggestion was just decided. */
  function buildFinishSummary(batch) {
    const applied = batch.filter((entry) => entry.status === 'applied');
    return {
      applied: applied.length,
      rejected: batch.filter((entry) => entry.status === 'rejected').length,
      later: batch.filter((entry) => entry.status === 'later').length,
      files: new Set(applied.map((entry) => entry.path)).size,
    };
  }

  function explanation(entry) {
    const items = [];
    if (entry.what) items.push({ kind: 'what', label: jt('changes.bar.what', 'What changes:'), text: entry.what });
    if (entry.why) items.push({ kind: 'why', label: jt('changes.bar.why', 'Why:'), text: entry.why });
    if (entry.watch_for) items.push({ kind: 'watch', label: jt('changes.bar.watchFor', 'Watch for:'), text: entry.watch_for });
    return items;
  }

  /**
   * The decision bar for one suggestion, as shown at `revision` (the one its
   * host displays). Accept waits, with its tooltip saying why, while that
   * revision is stale, a reply is running, the file has unsaved edits or the
   * editor could not build the preview; reading, rejecting and commenting stay
   * available.
   */
  function buildBarModel(list, entryId, {
    generating = false, replying = generating, busy = false, revision = null, unsaved = false, previewMissing = false,
  } = {}) {
    const batch = currentBatch(list);
    const entries = entriesOf(list);
    const entry = entries.find((item) => item.id === entryId) || null;
    if (!entry) return null;
    const index = batch.findIndex((item) => item.id === entry.id);
    const total = batch.length;
    const file = fileName(entry.path);
    const stale = revision !== null && revision !== undefined && Number(revision) !== (Number(entry.revision) || 1);
    const waitingOn = pendingDependencies(entries, entry)[0] || null;
    let acceptReason = '';
    if (stale) acceptReason = jt('changes.bar.revisionLoading', 'Jenny updated this change. The new version is loading.');
    else if (generating) acceptReason = jt('changes.bar.acceptWaitGenerating', 'Jenny is still suggesting changes. You can accept when Jenny finishes.');
    else if (replying) acceptReason = jt('changes.bar.acceptWaitReply', 'You can accept when Jenny finishes replying.');
    else if (entry.status === 'revising') acceptReason = jt('changes.bar.acceptWaitRevising', 'Jenny is revising this change.');
    else if (waitingOn) acceptReason = jt('changes.bar.acceptDependencyFirst', 'Accept change {n} first.', { n: changeRef(batch, entries, waitingOn.id) });
    else if (unsaved) acceptReason = jt('changes.accept.unsaved', 'Save or discard your unsaved edits to {file} before accepting this change.', { file });
    else if (previewMissing) acceptReason = jt('changes.bar.noPreview', 'This change can’t be shown against the file as it is now, so it can’t be accepted.');
    let statusNote;
    if (entry.status === 'applied') statusNote = jt('changes.bar.applied', 'Accepted and applied to your file.');
    else if (entry.status === 'rejected') statusNote = jt('changes.bar.rejectedNote', 'You rejected this change.');
    else if (entry.status === 'out_of_date') statusNote = jt('changes.bar.outOfDate', 'This change no longer matches the file. Comment to ask Jenny for a new version, or reject it.');
    else if (entry.status === 'revising') statusNote = jt('changes.suggested.revising', 'Jenny is revising this one');
    else statusNote = relationNote(batch, entries, entry);
    // Whatever its status (Later, restored), a change whose dependency is rejected asks first.
    const rejected = ACCEPTABLE.has(entry.status) ? rejectedDependency(entries, entry) : null;
    const rejectedRef = rejected ? changeRef(batch, entries, rejected.id) : '';
    return {
      id: entry.id,
      revision: Number(revision) || Number(entry.revision) || 1,
      status: entry.status,
      path: entry.path,
      kind: entry.kind,
      caption: index >= 0 && total > 0
        ? jt('changes.bar.caption', 'Change {index} of {total} · {file}', { index: index + 1, total, file })
        : file,
      title: titleOf(entry),
      explanation: explanation(entry),
      noExplanation: !entry.what && !entry.why
        ? jt('changes.bar.noExplanation', 'Jenny didn’t explain this change.')
        : '',
      statusNote,
      facts: relationFacts(batch, entries, entry),
      canAccept: ACCEPTABLE.has(entry.status) && !acceptReason && !busy,
      acceptReason,
      // Needs attention: Accept reads "Apply anyway…" and asks first.
      confirmApply: rejected
        ? {
          title: jt('changes.bar.applyAnywayTitle', 'Apply this change anyway?'),
          message: rejectedRef
            ? jt('changes.bar.applyAnywayMessage', 'It depends on change {n}, which you rejected. On its own it may leave your code broken.', { n: rejectedRef })
            : jt('changes.bar.applyAnywayMessageAny', 'It depends on a change you rejected. On its own it may leave your code broken.'),
          confirmLabel: jt('changes.bar.applyAnyway', 'Apply anyway'),
        }
        : null,
      canReject: REJECTABLE.has(entry.status) && !busy,
      canComment: !TERMINAL.has(entry.status) && !busy,
      canRestore: (entry.status === 'rejected' || entry.status === 'later') && !busy,
      busy,
    };
  }

  // Group and dependency state in plain words, under the bar's title.
  function relationNote(batch, entries, entry) {
    const groupSize = liveGroupSize(entries, entry);
    if (entry.status === 'needs_attention') {
      const rejected = rejectedDependency(entries, entry);
      return rejected
        ? jt('changes.bar.needsAttention', 'This depends on change {n}, which you rejected. It is skipped unless you apply it anyway.', { n: changeRef(batch, entries, rejected.id) })
        : '';
    }
    if (entry.status === 'accepted' && groupSize) {
      const waiting = entries.filter((item) => item.group_id === entry.group_id && isLive(item) && item.status !== 'accepted').length;
      return jtn('changes.bar.groupWaiting', waiting, { count: waiting }, 'Accepted. Waiting for the other change in this group.', 'Accepted. Waiting for the other {count} changes in this group.');
    }
    if (entry.reanchored === true && entry.status === 'to_review') {
      return jt('changes.bar.reanchored', 'Your file changed since Jenny suggested this, so it now applies to the file as it is. Check it again before accepting.');
    }
    if (groupSize) {
      const others = groupSize - 1;
      return jtn('changes.bar.grouped', others, { count: others }, 'Grouped: applies together with {count} other change once all are accepted.', 'Grouped: applies together with {count} other changes once all are accepted.');
    }
    return '';
  }

  /** The side panel's page for one suggestion: its diff and revision come from one entry. */
  function buildSuggestionDetail(list, view, id) {
    const rows = view ? view.rows : [];
    const entry = entriesOf(list).find((item) => item.id === id) || null;
    return {
      suggestionId: id,
      revision: entry ? Number(entry.revision) || 1 : 1,
      change: entry && entry.diff ? { ...entry.diff, path: entry.path } : null,
      path: entry ? entry.path : '',
      index: rows.findIndex((row) => row.id === id) + 1,
      total: rows.length,
    };
  }

  /**
   * History blocks for accepted suggestions: one per apply (a journal change
   * set, so a group is one block and one undo unit). Each file line opens like
   * one of Jenny's edits: the file now against its copy from before the apply.
   * @returns {{ turns: Array, changes: Array }} turns newest first
   */
  function buildAppliedHistory(list, { workspaceId = '' } = {}) {
    const blocks = new Map();
    const changes = [];
    const applied = entriesOf(list)
      .filter((entry) => entry.status === 'applied' && entry.applied && entry.applied.change_set_id)
      .sort((a, b) => String(a.applied.at).localeCompare(String(b.applied.at)));
    for (const entry of applied) {
      const changeSetId = String(entry.applied.change_set_id).toLowerCase();
      const turnId = `suggested:${changeSetId}`;
      let block = blocks.get(turnId);
      if (!block) {
        const time = Date.parse(entry.applied.at);
        block = { turnId, title: '', titles: [], timeMs: Number.isFinite(time) ? time : null, files: [], notices: [], omittedCount: 0, changeSetIds: [changeSetId] };
        blocks.set(turnId, block);
      }
      block.titles.push(titleOf(entry));
      const created = entry.kind === 'create';
      let file = block.files.find((item) => item.path === entry.path);
      if (!file) {
        file = { path: entry.path, fileKey: entry.path, created, sensitive: false, failedAfter: false, writers: ['edit'], toolCallIds: [], changeIds: [], afterHash: null, hashKind: '', lastToolName: 'propose_change', restorePoint: null };
        block.files.push(file);
        changes.push({
          changeId: `suggested:${entry.id}`,
          turnId,
          fileKey: entry.path,
          path: entry.path,
          status: created ? 'created' : 'modified',
          beforeHash: created ? null : entry.applied.before_hash || null,
          hunks: entry.applied.diff && Array.isArray(entry.applied.diff.hunks) ? entry.applied.diff.hunks : [],
          workspaceId,
        });
      }
      file.changeIds.push(`suggested:${entry.id}`);
      file.afterHash = entry.applied.after_hash || file.afterHash;
    }
    const turns = [...blocks.values()].reverse().map((block) => ({
      ...block,
      title: block.titles.length === 1
        ? jt('changes.history.acceptedOne', 'Accepted: {title}', { title: block.titles[0] })
        : jtn('changes.history.acceptedMany', block.titles.length, { count: block.titles.length }, 'Accepted {count} suggested change', 'Accepted {count} suggested changes'),
    }));
    return { turns, changes };
  }

  /** Suggested-state count for the Chat | Changes tab: changes waiting for a decision. */
  function waitingCount(list) {
    return Number(list && list.pending_count) || 0;
  }

  return {
    buildAppliedHistory,
    buildBarModel,
    buildFinishSummary,
    buildSuggestedView,
    buildSuggestionDetail,
    currentBatch,
    defaultCurrentId,
    fileName,
    nextToReview,
    stepFrom,
    waitingCount,
  };
});
