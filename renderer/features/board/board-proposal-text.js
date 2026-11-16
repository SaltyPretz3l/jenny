/* renderer/features/board/board-proposal-text.js - the words of a board proposal (UMD, global rendererBoardProposalText).
 *
 * Pure: no DOM, no clock. The review list, the bar and the ghosts of board-proposals-view.js say what a change is, why a line was
 * not used and what a decision answered through these functions. Every `change` here is the page's public proposal shape
 * ({ n, line, type, class, state, reason, summary }); its strings are model output, so they are only ever joined into a
 * sentence that the caller sets with textContent. Row 150, slice C3. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardProposalText = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const SHORT_MAX = 80;
  // Codes the file check (services/boards/board-files.js) shares with other refusals: on a `file` line they mean the file.
  const FILE_ONLY_BY_TYPE = ['invalid', 'io', 'read_only'];

  const str = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
  function firstLine(value, max) {
    const line = str(value).split(/\r\n|\r|\n/)[0].trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  const linesText = (n) => (n === 1 ? jt('board.changes.oneLine', '1 line') : jt('board.changes.lines', '{count} lines', { count: Number.isFinite(n) ? n : 0 }));

  /** The one line a change reads as in the list (an edit's before and after are shown apart by the view). */
  function changeText(change) {
    const s = (change && change.summary) || {};
    const group = firstLine(s.group, SHORT_MAX);
    switch (change && change.type) {
      case 'note': {
        const text = firstLine(s.text, SHORT_MAX);
        return group ? jt('board.changes.noteIn', 'New note: "{text}" in {group}', { text, group }) : jt('board.changes.note', 'New note: "{text}"', { text });
      }
      case 'link': {
        const title = firstLine(s.title, SHORT_MAX) || firstLine(s.url, SHORT_MAX);
        return group ? jt('board.changes.linkIn', 'New link: {title} in {group}', { title, group }) : jt('board.changes.link', 'New link: {title}', { title });
      }
      case 'file': {
        const path = firstLine(s.path, SHORT_MAX);
        return group ? jt('board.changes.fileIn', 'New file card: {path} in {group}', { path, group }) : jt('board.changes.file', 'New file card: {path}', { path });
      }
      case 'group': return jt('board.changes.group', 'New group: {title}', { title: firstLine(s.title, SHORT_MAX) });
      case 'diagram': return jt('board.changes.diagram', 'New diagram: {title} ({lines})', { title: firstLine(s.title, SHORT_MAX), lines: linesText(s.lines) });
      case 'connect': {
        const from = firstLine(s.from, SHORT_MAX);
        const to = firstLine(s.to, SHORT_MAX);
        const label = firstLine(s.label, SHORT_MAX);
        return label ? jt('board.changes.connectLabel', 'New connection: {from} to {to} ({label})', { from, to, label }) : jt('board.changes.connect', 'New connection: {from} to {to}', { from, to });
      }
      case 'append': return jt('board.changes.append', 'Add to {target}: "{text}"', { target: firstLine(s.target, SHORT_MAX), text: firstLine(s.text, SHORT_MAX) });
      case 'move': return jt('board.changes.move', 'Move {target} into {group}', { target: firstLine(s.target, SHORT_MAX), group });
      case 'tidy': return group ? jt('board.changes.tidy', 'Tidy {group}', { group }) : jt('board.changes.tidyAll', 'Tidy the whole board');
      case 'redraw': return jt('board.changes.redraw', 'Redraw {title} ({lines})', { title: firstLine(s.title, SHORT_MAX), lines: linesText(s.lines) });
      case 'remove': return jt('board.changes.remove', 'Remove {kind} {target}: "{label}"', { kind: firstLine(s.kind, SHORT_MAX), target: firstLine(s.target, SHORT_MAX), label: firstLine(s.label, SHORT_MAX) });
      default: return jt('board.changes.other', 'Change {n}', { n: change && Number.isFinite(change.n) ? change.n : 0 });
    }
  }

  /** The short text inside a ghost (a card) or its title (a group). */
  function shortText(change) {
    const s = (change && change.summary) || {};
    switch (change && change.type) {
      case 'note': return firstLine(str(s.text).replace(/\*\*/g, ''), SHORT_MAX); // a step's bold name, without its marks
      case 'link': return firstLine(s.title, SHORT_MAX) || firstLine(s.url, SHORT_MAX);
      case 'file': return firstLine(s.path, SHORT_MAX);
      case 'group': case 'diagram': return firstLine(s.title, SHORT_MAX);
      default: return '';
    }
  }

  /** Why a line was not used or a change was skipped (`type` is the change's). Total: any other reason gets the plain fallback. */
  function reasonText(reason, type) {
    const code = typeof reason === 'string' ? reason : '';
    if (type === 'file' && FILE_ONLY_BY_TYPE.indexOf(code) >= 0) return jt('board.changes.reason.file', "The file is not in this project's folder.");
    if (code.startsWith('limit_')) return jt('board.changes.reason.limit', 'The board is full.');
    switch (code) {
      case 'unknown': return jt('board.changes.reason.unknown', 'This line is not a board change.');
      case 'bad_url': return jt('board.changes.reason.badUrl', 'The link is not an http or https address.');
      case 'missing_text': case 'missing_path': case 'missing_name': return jt('board.changes.reason.missing', 'The line is missing its text.');
      case 'unsupported': return jt('board.changes.reason.unsupported', 'Jenny cannot add pictures or chat cards.');
      case 'unknown_name': return jt('board.changes.reason.unknownName', 'It names a card that is not on this board.');
      case 'unknown_group': return jt('board.changes.reason.unknownGroup', 'It names a group that is not on this board.');
      case 'not_a_card': return jt('board.changes.reason.notACard', 'A connection needs a card at both ends.');
      case 'not_a_note': return jt('board.changes.reason.notANote', "Only a note's text can be changed this way.");
      case 'not_sent_whole': return jt('board.changes.reason.notSentWhole', 'Jenny had not seen this whole card, so she cannot rewrite it. Select the card and ask again.');
      case 'exists': return jt('board.changes.reason.exists', 'That card already exists. To change it Jenny has to say edit.');
      case 'no_drawing': return jt('board.changes.reason.noDrawing', 'No drawing came with this line.');
      case 'gone': return jt('board.changes.reason.gone', 'It is no longer on the board.');
      case 'changed': return jt('board.changes.reason.changed', 'It was changed after Jenny read the board.');
      case 'too_many': return jt('board.changes.reason.tooMany', 'That is too much to arrange at once.');
      case 'outside_root': case 'not_found': case 'no_root': case 'unavailable': return jt('board.changes.reason.file', "The file is not in this project's folder.");
      case 'invalid': return jt('board.changes.reason.invalid', 'The board did not accept this change.');
      default: return jt('board.changes.reason.fallback', 'This change could not be used.');
    }
  }

  /** What stands in place of the buttons once a change is decided. */
  function outcomeText(change) {
    switch (change && change.state) {
      case 'applied':
        if (change.class === 'removal') return jt('board.changes.outcome.removed', 'Removed');
        return change.class === 'edit' ? jt('board.changes.outcome.changed', 'Changed') : jt('board.changes.outcome.added', 'Added');
      case 'rejected': return jt('board.changes.outcome.rejected', 'Rejected');
      case 'skipped': case 'refused': return reasonText(change.reason, change.type);
      default: return '';
    }
  }

  const plural = (n, one, many) => (n === 1 ? one : many);

  /** The bar over the canvas for the newest open proposal: { kind, text }. kind: additions | review | unusable. */
  function barState(proposal) {
    const counts = (proposal && proposal.counts) || {};
    const pending = counts.pending || 0;
    if (pending > 0 && (counts.additions || 0) > 0) {
      return { kind: 'additions', text: plural(pending, jt('board.proposal.bar.one', 'Jenny proposes 1 change'), jt('board.proposal.bar.many', 'Jenny proposes {count} changes', { count: pending })) };
    }
    if (pending > 0) {
      return { kind: 'review', text: plural(pending, jt('board.proposal.bar.reviewOne', 'Jenny proposes 1 change that needs your review'), jt('board.proposal.bar.reviewMany', 'Jenny proposes {count} changes that need your review', { count: pending })) };
    }
    const refused = counts.refused || 0;
    return { kind: 'unusable', text: plural(refused, jt('board.proposal.bar.unusableOne', 'Jenny proposed 1 change that could not be used'), jt('board.proposal.bar.unusableMany', 'Jenny proposed {count} changes that could not be used', { count: refused })) };
  }

  /** Full auto (slice C4): what Jenny already did, and what is left for a person after it. */
  function madeText(count) {
    return count === 1 ? jt('board.proposal.bar.madeOne', 'Jenny made 1 change.') : jt('board.proposal.bar.madeMany', 'Jenny made {count} changes.', { count });
  }
  function moreText(count) {
    return count === 1 ? jt('board.proposal.bar.moreOne', '1 more needs your review.') : jt('board.proposal.bar.moreMany', '{count} more need your review.', { count });
  }

  /** The one sentence a refused decision says. */
  function refusalText(reason) {
    if (reason === 'closed') return jt('board.proposal.refused.closed', 'That proposal is no longer open.');
    if (reason === 'read_only') return jt('board.proposal.refused.readOnly', 'This board cannot be changed.');
    if (reason === 'additions_first') return jt('board.proposal.refused.additionsFirst', 'Accept the additions first: the group is one of them.');
    return jt('board.proposal.refused.failed', 'Could not apply the changes. Try again.');
  }

  function skippedText(count) {
    return count === 1 ? jt('board.proposal.skipped.one', '1 change was skipped. Review shows why.') : jt('board.proposal.skipped.many', '{count} changes were skipped. Review shows why.', { count });
  }

  function overflowText(count) {
    return jt('board.changes.overflow', '{count} more lines were not read: a proposal holds at most 40.', { count });
  }

  /** A team board (row 151 T7): who asked Jenny for a proposal. `asker` is { name, self } (this member: self). */
  function askedByText(asker) {
    return asker.self ? jt('board.team.askedByYou', 'asked by you') : jt('board.team.askedBy', 'asked by {name}', { name: asker.name });
  }

  /** The Review list's first line on a team board: who asked, and who may answer. */
  function askedLine(asker) {
    return asker.self ? jt('board.team.askedLineYou', 'You asked. Anyone who can write in this project and is viewing this board can answer.')
      : jt('board.team.askedLine', '{name} asked. Anyone who can write in this project and is viewing this board can answer.', { name: asker.name });
  }

  return { changeText, shortText, reasonText, outcomeText, barState, madeText, moreText, refusalText, skippedText, overflowText, firstLine, askedByText, askedLine };
});
