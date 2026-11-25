/* renderer/features/board/board-team-history.js - the History of a team board and the project's deleted boards (UMD, global rendererBoardTeamHistory).
 *
 * Row 151 slice T9 (D31, D32). Loaded with board-team.js only while the `team` flag is on. Two views of what the host keeps:
 *  - History: a clock button in the conversation column's head opens a second aside in `ctx.chatHost` (the conversation's own stays mounted,
 *    hidden): the last 200 changes to the open board, newest first, a day heading each, one sentence a row. Every member can open it; only a
 *    project admin gets "Take back" on a row, with the inline confirm (`.team-set-confirm`) as the next row. A change is read again when History
 *    opens, when the board shown changes, after a take back, on Try again, and once 600 ms after the last change event of the board shown.
 *  - Deleted boards: for a project admin only, one quiet line under the boards list that opens what the host still keeps for 7 days, each with
 *    Restore. Read when an admin's team project is first shown, 300 ms after the last board list event, and after a Restore.
 * The sentence of a row is built here from the kind, the actor and the counts by operation: the host sends no board text. Every host call goes
 * through the team source (`history`, `revert`, `trash`, `restore`); `whyNot` decides what an admin sees. Names are text, isolated in a sentence.
 * No node, listener or timer of this part survives a close, a project that is not a team project, a collapsed column or dispose().
 *
 * createTeamHistory({ ctx, windowRef, jt, data }) -> { sync(), open(), close(), isOpen(), dispose() }. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardTeamHistory = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const READ_MS = 600; // one history read after the last change event of the board shown
  const TRASH_MS = 300; // one deleted-boards read after the last board list event
  const KEPT_DAYS = 7; // server/team/boards/board-host-sweep.js TRASH_MS: a deleted board is removed for good after this many days
  const DAY_MS = 86400000;
  const svg = (path) => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  const CLOCK = svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>');
  const RIGHT = svg('<path d="m6 4 4 4-4 4"/>');
  const DOWN = svg('<path d="m4 6 4 4 4-4"/>');

  function createTeamHistory({ ctx, windowRef, jt, data }) {
    const doc = ctx.document;
    const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
    const inv = () => globalThis.inventory || windowRef.inventory || {};
    let disposed = false;
    let source = null; // the team source the History aside is built for
    let watched = null; // the team source this part listens to, and how to stop
    let offWatch = null;

    // The phrases of a row, in the order they are said: [operation name, the phrase for a count].
    const PHRASES = [
      ['card.remove', (n) => jtn('board.team.history.cardRemoved', n, {}, 'removed a card', 'removed {count} cards')],
      ['card.add', (n) => jtn('board.team.history.cardAdded', n, {}, 'added a card', 'added {count} cards')],
      ['card.edit', (n) => jtn('board.team.history.cardEdited', n, {}, 'edited a card', 'edited {count} cards')],
      ['card.place', (n) => jtn('board.team.history.cardMoved', n, {}, 'moved a card', 'moved {count} cards')],
      ['connector.remove', (n) => jtn('board.team.history.connRemoved', n, {}, 'removed a connection', 'removed {count} connections')],
      ['connector.add', (n) => jtn('board.team.history.connAdded', n, {}, 'added a connection', 'added {count} connections')],
      ['connector.edit', (n) => jtn('board.team.history.connChanged', n, {}, 'changed a connection', 'changed {count} connections')],
      ['group.remove', (n) => jtn('board.team.history.groupRemoved', n, {}, 'removed a group', 'removed {count} groups')],
      ['group.add', (n) => jtn('board.team.history.groupAdded', n, {}, 'added a group', 'added {count} groups')],
      ['group.edit', (n) => jtn('board.team.history.groupChanged', n, {}, 'changed a group', 'changed {count} groups')],
      ['group.place', (n) => jtn('board.team.history.groupMoved', n, {}, 'moved a group', 'moved {count} groups')],
      ['group.assign', (n) => jtn('board.team.history.groupAssigned', n, {}, 'moved a card between groups', 'moved {count} cards between groups')],
      ['board.rename', () => jt('board.team.history.renamed', 'renamed the board')],
    ];

    const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
    const who = (id) => (data.isSelf(id) ? data.nameOrFormer(id) : data.iso(data.nameOrFormer(id)));
    // Where the focus goes when what had it is gone: the New board button, or the project button.
    const rescue = () => {
      const target = ctx.rootEl && (ctx.rootEl.querySelector('[data-board-action="new"]:not(:disabled)') || ctx.rootEl.querySelector('[data-board-action="project"]'));
      if (target) target.focus({ preventScroll: true });
    };
    const teamOf = () => { const project = ctx.getProject(); return project && project.team ? ctx.getTeamSource() : null; };

    function watch(team) {
      if (team === watched) return;
      if (typeof offWatch === 'function') offWatch();
      offWatch = null;
      watched = team;
      if (team) offWatch = team.onChanged(onEvent);
    }

    function onEvent(event) {
      if (disposed || !event) return;
      if (event.kind === 'applied' && aside && event.boardId === boardId) { windowRef.clearTimeout(readTimer); readTimer = windowRef.setTimeout(() => { readTimer = 0; read(); }, READ_MS); }
      if (event.kind === 'list' && delKey) { windowRef.clearTimeout(trashTimer); trashTimer = windowRef.setTimeout(() => { trashTimer = 0; void readTrash(); }, TRASH_MS); }
    }

    /* ============================================================ History */

    let aside = null;
    let subEl = null;
    let msgBox = null;
    let msgEl = null;
    let retryEl = null;
    let listEl = null;
    let shown = false; // History is asked for: the aside exists whenever the page can hold it
    let key = ''; // team|project the aside is built for
    let boardId = '';
    let changes = [];
    let status = 'reading'; // 'reading' | 'ok' | 'failed'
    let failMsg = '';
    let drawnSig = '';
    let confirmRev = null;
    let busy = false; // a take back is on its way
    let reading = false;
    let again = false;
    let token = 0;
    let readTimer = 0;
    let wantFocus = false;

    const canHold = () => Boolean(shown && teamOf() && ctx.chat.isOpen() && ctx.chatHost);

    function build(team) {
      source = team;
      key = `${team.scope.teamId}|${team.scope.projectId}`;
      aside = doc.createElement('aside');
      aside.className = 'ide-chat-dock board-team-conv board-team-history';
      aside.setAttribute('data-board-team-history', '');
      aside.setAttribute('aria-label', jt('board.team.history.label', 'Board history'));
      aside.insertAdjacentHTML('beforeend', '<header class="ide-chat-dock-header board-team-conv__head"><span class="ide-chat-dock-label board-team-history__title"></span><div class="ide-chat-dock-header-actions">'
        + inv().actionButton({ variant: 'ghost', size: 'sm', label: jt('board.team.history.back', 'Back to the conversation'), dataset: { 'board-team-history': 'back' } })
        + '</div></header><p class="board-team-history__sub"></p><div class="board-team-history__empty"><p></p></div><ul class="team-set-log board-team-history__log"></ul>');
      aside.querySelector('.board-team-history__title').textContent = jt('board.team.history.title', 'History');
      subEl = aside.querySelector('.board-team-history__sub');
      msgBox = aside.querySelector('.board-team-history__empty');
      msgEl = msgBox.firstChild;
      listEl = aside.querySelector('.board-team-history__log');
      aside.addEventListener('click', onClick);
      aside.addEventListener('keydown', onKeyDown);
      ctx.chatHost.appendChild(aside);
      boardId = '';
      resetRead();
    }

    function teardown() {
      windowRef.clearTimeout(readTimer);
      readTimer = 0;
      token += 1;
      again = false;
      if (aside) { aside.removeEventListener('click', onClick); aside.removeEventListener('keydown', onKeyDown); aside.remove(); }
      aside = subEl = msgBox = msgEl = retryEl = listEl = source = null;
      key = '';
      boardId = '';
      changes = [];
      drawnSig = '';
      confirmRev = null;
      busy = false;
    }

    // History is closed: for good, with the aside gone. A focus the aside held goes to a control that is left.
    function leave(moveFocus = true) {
      const held = Boolean(aside && aside.contains(doc.activeElement));
      shown = false;
      teardown();
      if (held && moveFocus) rescue();
    }

    function close({ focus = false } = {}) {
      if (!shown && !aside) return;
      const had = Boolean(aside);
      leave(false);
      if (had) data.resync();
      if (focus) { const button = ctx.chatHost && ctx.chatHost.querySelector('[data-board-team-conv="history"]'); if (button) button.focus(); }
    }

    function resetRead() {
      token += 1;
      changes = [];
      status = 'reading';
      failMsg = '';
      confirmRev = null;
      drawnSig = '';
      windowRef.clearTimeout(readTimer);
      readTimer = 0;
    }

    function read() {
      if (!aside || !boardId || !source) return;
      if (reading) { again = true; return; }
      reading = true;
      again = false;
      const mine = token;
      Promise.resolve(source.history({ boardId })).catch(() => ({ ok: false })).then((answer) => {
        reading = false;
        if (disposed) return;
        if (mine !== token || again) { read(); return; }
        if (answer && answer.ok === true) { status = 'ok'; changes = Array.isArray(answer.changes) ? answer.changes : []; failMsg = ''; } else { status = 'failed'; changes = []; failMsg = (answer && answer.message) || ''; }
        draw();
      });
    }

    /* ---------------------------------------------------------------- the sentence of a row */

    const joined = (texts) => (texts.length === 1 ? texts[0] : texts.length === 2 ? jt('board.team.history.and', '{a} and {b}', { a: texts[0], b: texts[1] })
      : jt('board.team.history.list', '{a}, {b} and {c}', { a: texts[0], b: texts[1], c: texts[2] }));

    // What the counts say, as "added 2 cards and removed a group", or '' when they say nothing. Past two phrases the rest is one tail.
    function said(ops) {
      const own = (name) => (ops && Object.hasOwn(ops, name) ? ops[name] : 0);
      const known = PHRASES.map(([name, make]) => ({ n: own(name), make })).filter((phrase) => phrase.n > 0);
      let rest = (ops ? Object.keys(ops).reduce((sum, name) => sum + ops[name], 0) : 0) - known.reduce((sum, phrase) => sum + phrase.n, 0);
      const texts = known.slice(0, 2).map((phrase) => phrase.make(phrase.n));
      rest += known.slice(2).reduce((sum, phrase) => sum + phrase.n, 0);
      if (rest > 0) texts.push(jtn('board.team.history.other', rest, {}, 'made another change', 'made {count} other changes'));
      return texts.length ? joined(texts) : '';
    }

    function sentenceOf(change, byRev) {
      const name = who(change.actor);
      if (change.kind === 'revert') {
        const first = byRev.get(change.ofRev);
        if (!first || first.actor === change.actor) return jt('board.team.history.revert', '{who} took back a change', { who: name });
        if (data.isSelf(first.actor)) return jt('board.team.history.revertYours', '{who} took back a change of yours', { who: name });
        return jt('board.team.history.revertBy', '{who} took back a change by {other}', { who: name, other: who(first.actor) });
      }
      const phrases = said(change.ops);
      if (change.kind === 'proposal') {
        return phrases ? jt('board.team.history.proposal', '{who} accepted Jenny’s proposal: {phrases}', { who: name, phrases })
          : jt('board.team.history.proposalNone', '{who} accepted a proposal from Jenny', { who: name });
      }
      return phrases ? jt('board.team.history.sentence', '{who} {phrases}', { who: name, phrases }) : jt('board.team.history.changedBoard', '{who} changed the board', { who: name });
    }

    // The rows to draw, as plain data: day headings and changes (and the confirm after the row asked about). Equal data draws the same nodes.
    function describe(admin) {
      const byRev = new Map(changes.map((change) => [change.rev, change]));
      const nowMs = windowRef.Date.now();
      const dayOf = (ms) => { const d = new Date(ms); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
      const midnight = new Date(nowMs);
      const today = dayOf(nowMs);
      const yesterday = dayOf(new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - 1).getTime());
      const tag = globalThis.jennyI18n && typeof globalThis.jennyI18n.tag === 'function' ? globalThis.jennyI18n.tag() : undefined;
      const clock = new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit' });
      const date = new Intl.DateTimeFormat(tag, { dateStyle: 'medium' });
      const out = [];
      let day = null;
      for (const change of changes) {
        const ms = Date.parse(change.at);
        const valid = Number.isFinite(ms);
        if (valid && dayOf(ms) !== day) {
          day = dayOf(ms);
          out.push({ day: day === today ? jt('board.team.history.today', 'Today') : day === yesterday ? jt('board.team.history.yesterday', 'Yesterday') : date.format(new Date(ms)) });
        }
        const text = sentenceOf(change, byRev);
        const offers = admin && change.takeable && !change.reverted && change.kind !== 'revert';
        out.push({ rev: change.rev, at: valid ? change.at : '', time: valid ? clock.format(new Date(ms)) : '', text, end: change.reverted ? 'taken' : offers ? 'take' : '', open: offers && confirmRev === change.rev });
        if (offers && confirmRev === change.rev) {
          out.push({ confirm: change.rev, text: data.isSelf(change.actor)
            ? jt('board.team.history.confirmOwn', 'Take back your change? Its cards, connections and groups go back to how they were before it. Anything changed since then is left as it is.')
            : jt('board.team.history.confirmOther', 'Take back {name}’s change? Its cards, connections and groups go back to how they were before it. Anything changed since then is left as it is.', { name: who(change.actor) }) });
        }
      }
      return out;
    }

    /* ---------------------------------------------------------------- drawing */

    function rowNode(item) {
      const li = doc.createElement('li');
      if (item.day !== undefined) { li.className = 'board-team-history__day'; li.textContent = item.day; return li; }
      if (item.confirm !== undefined) {
        li.className = 'board-team-history__confirm';
        li.setAttribute('data-board-history-confirm', String(item.confirm));
        li.insertAdjacentHTML('beforeend', '<div class="team-set-confirm" role="group"><p dir="auto"></p><div class="team-set-inline">'
          + inv().actionButton({ variant: 'primary', size: 'sm', label: jt('board.team.history.take', 'Take back'), disabled: busy, dataset: { 'board-team-history': 'confirm' } })
          + inv().actionButton({ size: 'sm', label: jt('board.team.history.cancel', 'Cancel'), disabled: busy, dataset: { 'board-team-history': 'cancel' } }) + '</div></div>');
        li.querySelector('[role="group"]').setAttribute('aria-label', jt('board.team.history.take', 'Take back'));
        li.querySelector('p').textContent = item.text;
        return li;
      }
      li.setAttribute('data-board-history-rev', String(item.rev));
      if (item.open) li.className = 'board-team-history__open';
      const time = doc.createElement('time');
      if (item.at) time.setAttribute('datetime', item.at);
      time.textContent = item.time;
      const span = doc.createElement('span');
      span.setAttribute('dir', 'auto');
      span.textContent = item.text;
      li.append(time, span);
      if (item.end === 'taken') {
        const end = doc.createElement('span');
        end.className = 'board-team-history__taken';
        end.textContent = jt('board.team.history.takenBack', 'Taken back');
        li.appendChild(end);
      } else if (item.end === 'take') {
        const named = jt('board.team.history.takeLabel', 'Take back: {sentence}', { sentence: item.text });
        li.insertAdjacentHTML('beforeend', inv().actionButton({ variant: 'ghost', size: 'sm', className: 'board-team-history__take', label: jt('board.team.history.take', 'Take back'),
          ariaLabel: named, title: named, dataset: { 'board-team-history': 'take' } }));
      }
      return li;
    }

    function focusOf() {
      const el = doc.activeElement;
      if (!el || !listEl || !listEl.contains(el) || !el.closest) return null;
      const li = el.closest('li');
      return { rev: li && (li.getAttribute('data-board-history-rev') || li.getAttribute('data-board-history-confirm')), what: el.getAttribute('data-board-team-history') };
    }
    function refocus(held) {
      if (!held || !listEl) return;
      const target = listEl.querySelector(held.what === 'take' ? `[data-board-history-rev="${held.rev}"] [data-board-team-history="take"]` : `[data-board-history-confirm="${held.rev}"] [data-board-team-history="${held.what}"]`);
      if (target) target.focus({ preventScroll: true });
    }

    function draw() {
      if (!aside || !source) return;
      const admin = source.whyNot('revert') === '';
      setText(subEl, admin ? jt('board.team.history.subAdmin', 'The last 200 changes to this board. As a project admin you can take one back; that is recorded in the project’s Activity.')
        : jt('board.team.history.subOther', 'The last 200 changes to this board. A project admin can take one back.'));
      let message = '';
      let retry = false;
      if (!boardId) message = jt('board.team.history.none', 'Open a board to see its history.');
      else if (status === 'reading') message = jt('board.team.history.reading', 'Reading the history…');
      else if (status === 'failed') { message = failMsg || jt('board.team.history.failed', 'The history could not be read.'); retry = true; }
      else if (!changes.length) message = jt('board.team.history.empty', 'No changes on this board yet.');
      const list = !message;
      msgBox.hidden = list;
      listEl.hidden = !list;
      setText(msgEl, message);
      if (retry && !retryEl) { msgBox.insertAdjacentHTML('beforeend', inv().actionButton({ size: 'sm', label: jt('board.team.history.retry', 'Try again'), dataset: { 'board-team-history': 'retry' } })); retryEl = msgBox.lastElementChild; }
      if (!retry && retryEl) { retryEl.remove(); retryEl = null; }
      if (!list) { confirmRev = null; if (drawnSig) { listEl.textContent = ''; drawnSig = ''; } return; }
      const asked = changes.find((change) => change.rev === confirmRev);
      if (confirmRev !== null && !(asked && admin && asked.takeable && !asked.reverted && asked.kind !== 'revert')) confirmRev = null;
      const items = describe(admin);
      const sig = JSON.stringify(items);
      if (sig === drawnSig) return;
      drawnSig = sig;
      const held = focusOf();
      const top = listEl.scrollTop;
      const fragment = doc.createDocumentFragment();
      items.forEach((item) => fragment.appendChild(rowNode(item)));
      listEl.textContent = '';
      listEl.appendChild(fragment);
      listEl.scrollTop = top;
      refocus(held);
    }

    /* ---------------------------------------------------------------- take back */

    function openConfirm(rev) {
      if (busy || confirmRev === rev) return;
      confirmRev = rev;
      draw();
      const go = listEl.querySelector('[data-board-history-confirm] [data-board-team-history="confirm"]');
      if (go) go.focus({ preventScroll: true });
    }

    function closeConfirm() {
      if (busy || confirmRev === null) return;
      const rev = confirmRev;
      confirmRev = null;
      draw();
      const row = listEl.querySelector(`[data-board-history-rev="${rev}"] [data-board-team-history="take"]`);
      if (row) row.focus({ preventScroll: true });
    }

    async function revert() {
      if (busy || confirmRev === null || !source) return;
      const rev = confirmRev;
      const team = source;
      const id = boardId;
      const mine = token;
      busy = true;
      listEl.querySelectorAll('[data-board-history-confirm] button').forEach((button) => { button.disabled = true; });
      let answer;
      try { answer = await team.revert({ boardId: id, rev }); } catch (_error) { answer = null; }
      busy = false;
      if (disposed) return;
      const here = Boolean(aside && source === team && boardId === id && mine === token);
      if (here && confirmRev === rev) {
        const held = aside.contains(doc.activeElement) && listEl.contains(doc.activeElement);
        confirmRev = null;
        draw();
        if (held || doc.activeElement === doc.body) { const back = aside.querySelector('[data-board-team-history="back"]'); if (back) back.focus({ preventScroll: true }); }
      }
      if (!answer || answer.ok !== true) ctx.notify(answer && answer.message ? answer.message : jt('board.team.history.revertFailed', 'That change could not be taken back.'), { tone: 'warning' });
      else if (answer.reverted > 0 && answer.skipped > 0) ctx.notify(jt('board.team.history.revertPartial', 'Part of that change could not be taken back: the board has changed since.'));
      else if (!(answer.reverted > 0)) ctx.notify(jt('board.team.history.revertNothing', 'Nothing of that change was left to take back.'));
      if (here) read();
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-board-team-history]') : null;
      if (!target || target === aside || target.disabled) return;
      switch (target.getAttribute('data-board-team-history')) {
        case 'back': close({ focus: true }); break;
        case 'retry': status = 'reading'; draw(); read(); break;
        case 'take': openConfirm(Number(target.closest('li').getAttribute('data-board-history-rev'))); break;
        case 'confirm': void revert(); break;
        case 'cancel': closeConfirm(); break;
        default:
      }
    }

    function onKeyDown(event) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (confirmRev !== null) closeConfirm(); else close({ focus: true });
    }

    function syncHistory() {
      const team = teamOf();
      const here = team ? `${team.scope.teamId}|${team.scope.projectId}` : '';
      if (!canHold() || (key && key !== here)) { if (shown || aside) leave(); return; }
      if (!aside) build(team);
      const id = String(ctx.getOpenBoardId() || '');
      if (id !== boardId) { boardId = id; resetRead(); if (id) read(); }
      draw();
      if (wantFocus) { wantFocus = false; aside.querySelector('[data-board-team-history="back"]').focus({ preventScroll: true }); }
    }

    function open() {
      if (disposed || !teamOf() || !ctx.chat.isOpen() || !ctx.chatHost) return false;
      shown = true;
      wantFocus = true;
      data.resync();
      wantFocus = false;
      return Boolean(aside);
    }

    /* ============================================================ Deleted boards */

    let delKey = ''; // team|project the deleted boards are read for ('' unless an admin has the project shown)
    let delSource = null;
    let rows = []; let expanded = false; let restoring = '';
    let block = null; let delSig = '';
    let trashErr = ''; // why the last read of the deleted boards failed ('' when it did not): the section stays, with this and Try again
    let trashRun = null; let trashAgain = false; let trashTimer = 0;

    async function readTrash() {
      if (!delKey) return;
      if (trashRun) { trashAgain = true; return trashRun; }
      trashRun = (async () => {
        do {
          trashAgain = false;
          const mine = delKey;
          const team = delSource;
          let answer;
          try { answer = await team.trash(); } catch (_error) { answer = null; }
          if (disposed) return;
          if (mine === delKey && team === delSource) { const good = Boolean(answer && answer.ok === true && Array.isArray(answer.boards)); if (good) rows = answer.boards; trashErr = good ? '' : (answer && answer.message) || jt('board.team.deleted.failed', 'Deleted boards could not be read.'); drawDeleted(); } // a failed read keeps the rows that were known
        } while (trashAgain && delKey);
      })();
      try { await trashRun; } finally { trashRun = null; }
    }

    // How long a deleted board is still kept, from when it was deleted.
    function leftOf(deletedAt) {
      const ms = Date.parse(deletedAt);
      if (!Number.isFinite(ms)) return '';
      const days = Math.floor((ms + KEPT_DAYS * DAY_MS - windowRef.Date.now()) / DAY_MS);
      return days < 1 ? jt('board.team.deleted.lessThanDay', 'less than a day left') : jtn('board.team.deleted.daysLeft', days, {}, '{count} day left', '{count} days left');
    }

    function removeDeleted() {
      if (block) block.remove();
      block = null;
      delSig = '';
    }

    function placeDeleted() {
      const foot = ctx.listEl.querySelector('[data-board-team-foot]');
      if (foot ? block.nextElementSibling !== foot || block.parentNode !== ctx.listEl : ctx.listEl.lastElementChild !== block) ctx.listEl.insertBefore(block, foot || null);
    }

    function deletedFocus() {
      const el = doc.activeElement;
      if (!block || !el || !block.contains(el)) return null;
      const li = el.closest('li');
      return li ? li.getAttribute('data-board-deleted-id') : 'toggle';
    }

    function drawDeleted() {
      if (disposed || !delKey || (!rows.length && !trashErr)) { removeDeleted(); return; }
      const view = expanded ? rows.map((row) => ({ id: row.id, name: row.name, who: who(row.deletedBy), left: leftOf(row.deletedAt), busy: restoring === row.id })) : [];
      const sig = JSON.stringify([expanded, rows.length, view, trashErr]);
      if (!block) {
        block = doc.createElement('div');
        block.className = 'board-team-deleted';
        block.setAttribute('data-board-team-deleted', '');
        block.addEventListener('click', onDeletedClick);
      }
      if (sig !== delSig) {
        delSig = sig;
        const held = deletedFocus();
        block.textContent = '';
        if (rows.length) { block.insertAdjacentHTML('beforeend', inv().actionButton({ variant: 'ghost', size: 'sm', className: 'board-team-deleted__toggle', ariaExpanded: expanded,
          label: jtn('board.team.deleted.count', rows.length, {}, '{count} deleted board', '{count} deleted boards'), dataset: { 'board-team-deleted': 'toggle' } }));
        block.firstElementChild.insertAdjacentHTML('afterbegin', expanded ? DOWN : RIGHT); }
        if (trashErr) { block.insertAdjacentHTML('beforeend', '<p class="board-team-deleted__error" role="alert"></p>' + inv().actionButton({ variant: 'ghost', size: 'sm',
          label: jt('board.team.history.retry', 'Try again'), title: jt('board.team.history.retry', 'Try again'), dataset: { 'board-team-deleted': 'retry' } })); block.querySelector('.board-team-deleted__error').textContent = trashErr; }
        if (expanded) {
          const list = doc.createElement('ul');
          list.className = 'board-team-deleted__list';
          view.forEach((row) => list.appendChild(deletedRow(row)));
          const note = doc.createElement('p');
          note.className = 'board-team-deleted__note';
          note.textContent = jt('board.team.deleted.note', 'Who deleted it, and how long it is kept. After {days} days a deleted board is removed for good.', { days: KEPT_DAYS });
          block.append(list, note);
        }
        if (held) focusDeleted(held);
      }
      placeDeleted();
    }

    function deletedRow(row) {
      const li = doc.createElement('li');
      li.setAttribute('data-board-deleted-id', row.id);
      const name = doc.createElement('span');
      name.className = 'board-team-deleted__name';
      name.textContent = row.name;
      name.setAttribute('title', row.name);
      const meta = doc.createElement('span');
      meta.className = 'board-team-deleted__meta';
      meta.textContent = row.left ? jt('board.team.deleted.meta', '{who} · {left}', { who: row.who, left: row.left }) : row.who;
      li.append(name, meta);
      const named = jt('board.team.deleted.restoreLabel', 'Restore {name}', { name: data.iso(row.name) });
      li.insertAdjacentHTML('beforeend', inv().actionButton({ variant: 'ghost', size: 'sm', label: jt('board.team.deleted.restore', 'Restore'), disabled: row.busy,
        ariaLabel: named, title: named, dataset: { 'board-team-deleted': 'restore' } }));
      return li;
    }

    const deletedLi = (id) => Array.from(block.querySelectorAll('[data-board-deleted-id]')).find((li) => li.getAttribute('data-board-deleted-id') === id) || null;
    function focusDeleted(id) {
      const target = id === 'toggle' ? block.querySelector('[data-board-team-deleted="toggle"]') || block.querySelector('[data-board-team-deleted="retry"]') : (deletedLi(id) || block).querySelector('[data-board-team-deleted="restore"]');
      if (target && !target.disabled) target.focus({ preventScroll: true });
    }

    async function restore(id) {
      const team = delSource;
      const row = rows.find((candidate) => candidate.id === id);
      if (!team || !row || restoring) return;
      const at = rows.indexOf(row);
      const next = rows[at + 1] ? rows[at + 1].id : '';
      restoring = id;
      drawDeleted();
      let answer;
      try { answer = await team.restore({ boardId: id }); } catch (_error) { answer = null; }
      restoring = '';
      if (disposed) return;
      if (answer && answer.ok === true) ctx.notify(jt('board.team.deleted.restored', 'Restored {name}.', { name: data.iso(row.name) }));
      else ctx.notify(answer && answer.message ? answer.message : jt('board.team.deleted.restoreFailed', 'That board could not be restored.'), { tone: 'warning' });
      const held = !doc.activeElement || doc.activeElement === doc.body || Boolean(block && block.contains(doc.activeElement));
      if (team === delSource) await readTrash();
      if (disposed || !held) return;
      if (block && next && deletedLi(next)) focusDeleted(next);
      else if (block) focusDeleted('toggle');
      else rescue();
    }

    function onDeletedClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-board-team-deleted]') : null;
      if (!target || target === block || target.disabled) return;
      if (target.getAttribute('data-board-team-deleted') === 'toggle') { expanded = !expanded; drawDeleted(); focusDeleted('toggle'); return; }
      if (target.getAttribute('data-board-team-deleted') === 'retry') { trashErr = jt('board.team.deleted.retrying', 'Trying again…'); drawDeleted(); void readTrash(); return; }
      void restore(target.closest('li').getAttribute('data-board-deleted-id'));
    }

    function syncDeleted() {
      const team = teamOf();
      const now = team && team.whyNot('trash') === '' ? `${team.scope.teamId}|${team.scope.projectId}` : '';
      if (now !== delKey) {
        delKey = now;
        delSource = now ? team : null;
        rows = []; trashErr = '';
        expanded = false;
        restoring = '';
        windowRef.clearTimeout(trashTimer);
        trashTimer = 0;
        removeDeleted();
        if (now) void readTrash();
      }
      drawDeleted();
    }

    return {
      /** Brings the History aside and the deleted boards in line with the project, the column and the board shown. */
      sync() {
        if (disposed) return;
        syncHistory();
        syncDeleted();
        watch(aside || delKey ? teamOf() : null);
      },
      open,
      close,
      isOpen: () => Boolean(aside),
      dispose() {
        if (disposed) return;
        leave(false);
        windowRef.clearTimeout(trashTimer);
        trashTimer = 0;
        delKey = '';
        delSource = null;
        if (block) block.removeEventListener('click', onDeletedClick);
        removeDeleted();
        watch(null);
        disposed = true;
      },
    };
  }

  return { createTeamHistory };
});
