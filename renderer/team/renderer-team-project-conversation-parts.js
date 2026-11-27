/* Team tab: the small controllers a shared conversation's view is made of (row 169, taken out of
 * renderer-team-project-conversation.js so that file stays readable). Each keeps its own state, is handed what it needs
 * and nothing else, and never reaches the conversation's state:
 *
 * - channelShellHtml: the view's fixed markup, written once (the channel's scroller, the popover's host, the jump pill,
 *   the box; row 171).
 * - createLease: who drives, and the one re-read when a shown lease passes its expiry (the host renews a lease by
 *   heartbeat and publishes nothing, so the local clock never clears it).
 * - createHistory: the messages held (the newest page of each snapshot joined to them, at most `cap`) and the older
 *   page "Show earlier messages" reads with the host's cursor.
 * - createApprovals: the pending approval cards, what this member asked for, the receipts, the answers remembered and
 *   the line that says how a rule request of this member's was answered.
 * - createQuestions: a question card answered or skipped (`conversationAnswer` / `conversationDecline`), its lock while
 *   it is sent, and a refusal written into the card as it stands so what was picked and typed stays.
 * - createTitle: the conversation's title in the head, with its pen and the field that renames it.
 * - createCopy: a message's text to the clipboard, said on the button for a moment.
 * - createPainter: a stream event's paint (one per frame; the words and a reasoning-only change at most every 100 ms).
 * - headHtml: the head's markup (back and title, the project, who drives and views).
 * - createPop: the transcript popover's glue (open, step, close, paint; focus to the chip, or to the box on a self-close).
 *
 * Text from the host is escaped where it enters markup; a refusal is `errorText`'s sentence. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-project-timeline'));
    return;
  }
  root.rendererTeamProjectConversationParts = factory(root.rendererTeamProjectTimeline);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (tl) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const SVG = (paths) => '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths + '</svg>';
  const PEN = SVG('<path d="M10.6 3.2l2.2 2.2L6 12.2l-2.7.5.5-2.7z"/>');
  const DOWN = SVG('<path d="M8 3.5v9M4 8.5l4 4 4-4"/>');
  const CHECK = SVG('<path d="M3.5 8.5l3 3 6-7"/>');
  const LEASE_REREAD_MS = 30_000;
  const COPIED_MS = 1500;
  const REMEMBERED = 64;
  const RECEIPTS = 32;
  const OUTCOMES = 16;
  const RENAME_ID = 'teamConversationTitle';
  const BACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5L5 8l4.5 4.5"/></svg>';

  const inv = () => globalThis.inventory || {};
  const remember = (map, key, value, cap = REMEMBERED) => { map.delete(key); map.set(key, value); while (map.size > cap) map.delete(map.keys().next().value); };
  const capPush = (list, item, cap) => { list.push(item); while (list.length > cap) list.shift(); };
  const noteLine = (text) => (text ? '<p class="team-note-line" role="status">' + escapeHtml(text) + '</p>' : '');
  // The team's GPU list as the team store has read it, or null while it is unread.
  function poolNodes(stores, teamId) {
    const pools = stores && stores.getTeamStore ? stores.getTeamStore().snapshot().pools : null;
    const list = pools && Object.hasOwn(pools, teamId) ? pools[teamId] : null;
    return list && Array.isArray(list.nodes) ? list.nodes : null;
  }
  // The team's GPU list as one read ({ nodes, team_model, automatic_model }), or null while it is unread (row 172: the model picker).
  function poolRead(stores, teamId) {
    const pools = stores && stores.getTeamStore ? stores.getTeamStore().snapshot().pools : null;
    const pool = pools && Object.hasOwn(pools, teamId) ? pools[teamId] : null;
    return pool && Array.isArray(pool.nodes) ? { nodes: pool.nodes, team_model: pool.team_model, automatic_model: pool.automatic_model } : null;
  }
  // The model the team answers with (Settings > Team), or '' while the team store has not read it.
  function teamModel(stores, teamId) {
    const pools = stores && stores.getTeamStore ? stores.getTeamStore().snapshot().pools : null;
    const pool = pools && Object.hasOwn(pools, teamId) ? pools[teamId] : null;
    return pool && typeof pool.team_model === 'string' ? pool.team_model : '';
  }
  // The one model the shared GPUs offer, or '' when they offer none or several.
  function oneModel(nodes) {
    const offered = new Set();
    for (const node of nodes || []) for (const model of Array.isArray(node.models) ? node.models : []) if (model && typeof model.name === 'string') offered.add(model.name);
    return offered.size === 1 ? [...offered][0] : '';
  }

  // T2: why a failed turn's Send again does nothing now: the team is not online (`connection`: 'offline' or 'reconnecting'), else the
  // picked model's own line (`aboveHtml`: the controls' line above the box); the box's own words follow the first sentence.
  function sendAgainWhy(doc, connection, aboveHtml) {
    let why = '';
    if (connection) why = connection === 'offline' ? jt('team.composer.hintOffline', 'Sends when the host is back') : jt('team.composer.hintReconnecting', 'Sends when reconnected');
    else if (aboveHtml) { const el = doc.createElement('div'); el.innerHTML = aboveHtml; why = ((el.querySelector('span') || {}).textContent || '').trim(); }
    return jt('team.conv.sendAgainBlocked', 'Cannot send again yet.') + (why ? ' ' + why : '');
  }

  // ------------------------------------------------------------ the shell

  // The view's fixed markup (row 171, the channel): the log, the running turn's row and the queued rows are the #team
  // scroller's content; the transcript popover mounts in `pop`, inside the stage, so it ends above the box; `announce`
  // says a turn's state changes (not its clock); the box is the #team composer; `standing` is the readers' line (E68),
  // under the box here, and in the head on the Board's column, which has no room there.
  function channelShellHtml({ board, fieldHtml, standing }) {
    const jump = jt('team.conv.latest', 'Jump to the latest message');
    return '<div class="team-conv team-conv--channel" data-board="' + Boolean(board) + '"><div data-conv-region="head"></div><div class="team-conv__stage">'
      + '<div class="team-conv__scroll team-scroll" role="log"><div data-conv-region="log"></div><div data-conv-region="live"></div><div data-conv-region="queued"></div></div>'
      + '<div class="team-turn-pop-host" data-conv-region="pop"></div>'
      + inv().actionButton({ plain: true, className: 'chat-jump-latest', ariaLabel: jump, title: jump, dataset: { 'project-action': 'latest', visible: 'false' }, trustedHtml: DOWN })
      + '</div><div class="sr-only" aria-live="polite" data-conv-region="announce"></div>'
      + '<div class="team-conv__box" data-conv-region="box"><div data-conv-box="above"></div><div class="team-composer-root">'
      + '<div class="team-composer" data-conv-box="shell" data-send-lifecycle="idle" hidden>'
      + '<div class="team-conv__locked" data-conv-box="locked" role="status" hidden></div>'
      + '<div class="team-composer__field" data-conv-box="composer" hidden>' + fieldHtml + '</div>'
      + '<div class="team-composer__bar" data-conv-box="toolbar" hidden><div data-conv-box="left"></div><div data-conv-box="bar"></div></div>'
      + '</div></div><div data-conv-box="below"></div>'
      + (board ? '' : '<p class="team-conv__standing" data-standing="true" dir="auto">' + escapeHtml(standing) + '</p>') + '</div></div>';
  }

  // ------------------------------------------------------------ the lease

  // `reread()` reads the snapshot again and takes it (which sets the control); it answers nothing this needs.
  function createLease({ timers, clock, reread }) {
    let control = null;
    let timer = null;
    let reading = false;
    let readAt = -Infinity;
    let stopped = false;
    const driver = () => (control ? control.member_id : null);
    function clear() { if (timer !== null) { timers.clear(timer); timer = null; } }
    function arm() {
      clear();
      if (stopped || reading || !control || !control.expires_at) return;
      const at = Math.max(control.expires_at, readAt + LEASE_REREAD_MS);
      timer = timers.set(() => { timer = null; void check(); }, Math.max(0, at - clock()) + 50);
    }
    // The shown lease is past its expiry: the host may have renewed it silently, or the driver may be gone.
    async function check() {
      if (stopped || reading || !control) return;
      reading = true;
      readAt = clock();
      await reread();
      reading = false;
      arm();
    }
    return {
      driver,
      // True when the driver changed.
      set(next) {
        const before = driver();
        control = next && next.member_id ? { member_id: next.member_id, expires_at: Number(next.expires_at) || 0 } : null;
        arm();
        return driver() !== before;
      },
      armed: () => timer !== null,
      clear,
      stop() { stopped = true; clear(); },
    };
  }

  // ------------------------------------------------------------ the messages held

  // `read(cursor)`: conversationOpen before that message, null when the view is gone.
  function createHistory({ cap, read, errorText }) {
    const h = { messages: [], more: false, cursor: '', capped: false, note: '', busy: false };
    const oldest = () => (h.messages[0] && h.messages[0].id) || '';
    function hold(messages) {
      h.messages = messages;
    }
    return {
      messages: () => h.messages,
      more: () => h.more,
      // Older messages exist but this view cannot hold them (the cap): find says its count covers the newest only.
      hidden: () => h.capped,
      // What stands above the messages: the button that reads an older page, a read that failed, the cap reached.
      topHtml: () => tl.earlierHtml({ more: h.more, busy: h.busy }) + noteLine(h.note)
        + noteLine(h.capped ? jt('team.conv.earlierCap', 'This view holds {count} messages. The ones before them are not shown here.', { count: cap }) : ''),
      // A snapshot is the newest page. It joins what is held when they overlap; with a gap between them it replaces it.
      take(page) {
        const merged = tl.mergeMessages(h.messages, page.messages, cap);
        const pageOnly = merged.messages.length <= page.messages.length;
        // The cap cut the oldest held messages: the host still has them, one page before the oldest kept.
        const cut = merged.dropped && merged.messages.length === cap && (!pageOnly || page.messages.length > cap);
        hold(merged.messages);
        if (cut) { h.more = false; h.capped = true; h.cursor = oldest(); } else if (pageOnly) {
          h.capped = page.has_more === true && h.messages.length >= cap;
          h.more = page.has_more === true && !h.capped;
          h.cursor = page.next_before_message_id || oldest();
          h.note = '';
        }
      },
      // One older page, put before what is held. Null when there is none to read; else a promise of whether the view
      // still stands (the button says it is loading from this call on).
      earlier() {
        if (h.busy || !h.more || !h.cursor) return null;
        h.busy = true;
        h.note = '';
        const first = oldest();
        return read(h.cursor).then((answer) => {
          if (!answer) return false;
          h.busy = false;
          if (!answer.ok) { h.note = errorText(answer.error); return true; }
          if (oldest() !== first) return true; // a gap snapshot replaced what was held: this page no longer joins it
          const known = new Set(h.messages.map((m) => m.id));
          const older = answer.snapshot.messages.filter((m) => !known.has(m.id));
          const room = Math.max(0, cap - h.messages.length);
          h.capped = older.length > room;
          hold((room ? older.slice(-room) : []).concat(h.messages));
          h.more = !h.capped && answer.snapshot.has_more === true && older.length > 0;
          h.cursor = answer.snapshot.next_before_message_id || oldest();
          return true;
        });
      },
    };
  }

  // ------------------------------------------------------------ approvals

  // `snapshot()`: the conversation's; `send(payload)`: conversationDecide, null when the view is gone; `cardHtml(a,
  // { busy, note })`, `receiptHtml(r)` and `outcomeHtml(o)`: the box's builders; `youOr(id)` says "You" for this
  // member; `acted()` runs when this member answers; `redraw()` draws the conversation again; `rules()`: the project's
  // rule requests (projectRules), null when the view is gone; `sessionId` and `projectName()`: this conversation's;
  // `offersAllow(a)`: whether the card of an approval has Allow (the batch banner never allows one that has not).
  function createApprovals({ snapshot, send, me, mayAnswer, youOr, nameOf, errorText, timeText, cardHtml, receiptHtml, outcomeHtml, acted, redraw, rules, sessionId, projectName, offersAllow }) {
    const answered = new Map();
    const asked = new Map(); // approval id -> { always, tool, failed }: what this member asked for
    const lost = new Map(); // approval id -> { text, revision }: the sentence of an answer that did not land, and the decision it was for
    const busy = new Set();
    let batching = false;
    const receipts = [];
    const outcomes = [];
    const listed = () => { const now = snapshot(); return now ? now.pending_approvals : []; };
    const pending = () => listed().filter((a) => !answered.has(a.approval_id));

    // A decision from the host (anybody's): the card goes and its receipt is drawn.
    function decided(event) {
      if (!event.approval_id) return;
      const a = listed().find((p) => p.approval_id === event.approval_id);
      const mine = asked.get(event.approval_id) || null;
      remember(answered, event.approval_id, true);
      lost.delete(event.approval_id);
      // A runtime withdrawal carries neither `approved` nor an approver: it names nobody.
      const outcome = event.approved === true ? 'allowed' : event.approved === false ? 'declined' : 'withdrawn';
      const byMe = event.approver_member_id === me() && mine && outcome === 'allowed';
      // Whose turn is said only when another member answered it.
      const prompterId = event.prompter_member_id || (a && a.prompter_member_id) || '';
      capPush(receipts, { approval_id: event.approval_id, outcome, approver: event.approver_member_id ? youOr(event.approver_member_id) : jt('settings.team.activity.someone', 'Someone'),
        prompter: prompterId && prompterId !== event.approver_member_id ? nameOf(prompterId) : '', time: timeText(),
        asked: byMe && !mine.failed && mine.always === 'ask' ? mine.tool : '', rule: byMe && !mine.failed && mine.always === 'rule' ? mine.tool : '', failed: byMe ? mine.failed : '' }, RECEIPTS);
      redraw();
    }

    // A rule request answered: when it was this member's, asked from this conversation, one line says how.
    async function ruleAnswered(payload) {
      const answer = await rules();
      if (!answer || !answer.ok) return;
      const request = answer.requests.find((r) => r.request_seq === payload.request_seq);
      if (!request || request.asker_member_id !== me() || request.session_id !== sessionId) return;
      capPush(outcomes, { outcome: request.state, by: nameOf(request.answered_by), tool: request.outcome_tool || request.tool_name, folder: request.outcome_folder, reason: request.reason,
        project: projectName() }, OUTCOMES);
      redraw();
    }

    // The caret beside Allow (row 123 layout D1): the app's menu holds the always choice; picking it answers as the old always button did.
    // A second click on the caret closes its menu (`hide` answers nothing, and its onHide sets aria-expanded back).
    function openMore(caret) {
      const menu = (globalThis.inventory && globalThis.inventory.contextMenu) || globalThis.inventoryContextMenu, id = caret.dataset.approvalId;
      if (!menu || (caret.getAttribute('aria-expanded') === 'true' && !menu.hide()) || !mayAnswer() || !pending().some((p) => p.approval_id === id)) return null;
      caret.setAttribute('aria-expanded', 'true');
      menu.show({ anchorEl: caret, placement: 'below', ariaLabel: caret.getAttribute('aria-label'), restoreFocusTo: caret, onHide: () => caret.setAttribute('aria-expanded', 'false'),
        items: [{ label: caret.dataset.teamMoreLabel, description: caret.dataset.teamMoreNote, action: () => { void decide({ dataset: { approvalId: id, action: 'approve', teamAlways: caret.dataset.teamMore } }); } }] });
      return null;
    }

    // What this member asked for is noted before the call, so a `decision_changed` that arrives first builds the
    // whole receipt; an always that did not land shows its sentence in the receipt; the card goes once answered.
    // Answers true when the host took the decision, false when it refused, null when nothing was asked.
    async function decide(target) {
      if (target.dataset.action === 'more') return openMore(target);
      const a = pending().find((p) => p.approval_id === target.dataset.approvalId);
      if (!a || !mayAnswer() || busy.has(a.approval_id)) return null;
      const approved = target.dataset.action === 'approve';
      const always = approved && target.dataset.teamAlways ? target.dataset.teamAlways : '';
      remember(asked, a.approval_id, { always, tool: a.tool_name, failed: '' });
      lost.delete(a.approval_id);
      busy.add(a.approval_id);
      acted();
      redraw();
      const answer = await send({ stream_id: a.stream_id, approval_id: a.approval_id, decision_revision: a.decision_revision, approved, ...(always ? { always } : {}) });
      if (!answer) return null;
      busy.delete(a.approval_id);
      if (!answer.ok) lost.set(a.approval_id, { text: errorText(answer.error), revision: a.decision_revision });
      else {
        remember(answered, a.approval_id, true);
        const result = answer.always_result;
        if (always && result && result.ok === false) {
          const failed = errorText({ reason: result.reason });
          const mine = asked.get(a.approval_id);
          if (mine) mine.failed = failed;
          const receipt = receipts.find((r) => r.approval_id === a.approval_id);
          if (receipt) { receipt.asked = ''; receipt.rule = ''; receipt.failed = failed; }
        }
      }
      redraw();
      return answer.ok === true;
    }

    // Item 15, the approvals of one turn that wait together (a stream with two or more). The batch banner's "Allow all N" and
    // "Deny all" decide each of them through `decide`, in the order they wait, one call each; the first refusal stops the rest.
    function group() {
      const byStream = new Map();
      for (const a of pending()) byStream.set(a.stream_id, [...(byStream.get(a.stream_id) || []), a]);
      return [...byStream.values()].find((list) => list.length > 1) || [];
    }
    function batch() {
      const list = mayAnswer() ? group() : [];
      return list.length > 1 ? { count: list.length, allow: list.filter(offersAllow).length, busy: batching } : null;
    }
    // Answers null when every one was asked (or nothing could be), else the sentence of the refusal that stopped it.
    async function decideAll(approved) {
      if (batching || !mayAnswer()) return null;
      batching = true;
      redraw();
      let stopped = null;
      for (const a of group().filter((one) => !approved || offersAllow(one))) {
        if ((await decide({ dataset: { approvalId: a.approval_id, action: approved ? 'approve' : 'deny' } })) === false) { stopped = (lost.get(a.approval_id) || {}).text || ''; break; }
      }
      batching = false;
      redraw();
      return stopped;
    }

    return {
      pending, decided, decide, ruleAnswered, batch, decideAll,
      cardsHtml: () => pending().map((a) => cardHtml(a, { busy: busy.has(a.approval_id), note: (lost.get(a.approval_id) || {}).text || '' })).join(''),
      // `placed(approvalId)` (item 11): a decision the host's receipt already draws under its turn is left out here.
      receiptsHtml: (placed = () => false) => receipts.filter((r) => !placed(r.approval_id)).map(receiptHtml).join('') + outcomes.map(outcomeHtml).join(''),
      // A new snapshot: a lost answer stays while its approval is listed at the same decision revision; an answered approval the snapshot no longer lists is forgotten.
      taken(next) {
        const listed = next.pending_approvals;
        for (const [id, one] of [...lost]) if (!listed.some((a) => a.approval_id === id && a.decision_revision === one.revision)) lost.delete(id);
        for (const id of [...answered.keys()]) if (!listed.some((a) => a.approval_id === id)) answered.delete(id);
      },
      counts: () => ({ receipts: receipts.length, outcomes: outcomes.length, answered: answered.size }),
    };
  }

  // ------------------------------------------------------------ questions

  // `log`: the region the cards are drawn in; `asking()`: the pending questions shown; `send(method, payload)`: null
  // when the view is gone; `answered(ref)` runs when the host took an answer or a skip.
  function createQuestions({ log, asking, send, mayAnswer, errorText, answered }) {
    const busy = new Set();
    const cardOf = (target) => (target && target.closest ? target.closest('.team-conv__question .user-questions-block') : null);

    async function answer(wrap, decline) {
      const ref = wrap.dataset.questionRef;
      const p = asking().find((one) => one.question_ref === ref);
      if (!p || !mayAnswer() || busy.has(ref)) return;
      const card = wrap.querySelector('.user-questions-block');
      const payload = { stream_id: p.stream_id, question_ref: ref, ...(decline ? {} : { answers: tl.collectAnswers(card, p) }) };
      busy.add(ref);
      // The card shows in the channel and in the popover: answering in either locks both.
      for (const one of log.querySelectorAll('.team-conv__question')) if (one.dataset.questionRef === ref) tl.lockQuestion(one.querySelector('.user-questions-block'), true);
      const result = await send(decline ? 'conversationDecline' : 'conversationAnswer', payload);
      busy.delete(ref);
      if (!result) return;
      if (result.ok) { answered(ref); return; }
      // Refused: the log is not redrawn, so what was picked and typed stays for another try. A redraw while the
      // answer was out left a new card, locked: that one is opened again and gets the sentence.
      const shown = wrap.isConnected ? wrap : Array.from(log.querySelectorAll('.team-conv__question')).find((one) => one.dataset.questionRef === ref);
      if (!shown) return;
      // Every copy (the channel's and the popover's) opens again for another try.
      for (const one of log.querySelectorAll('.team-conv__question')) if (one.dataset.questionRef === ref) tl.lockQuestion(one.querySelector('.user-questions-block'), !mayAnswer());
      const note = shown.querySelector('[data-question-note]') || shown.appendChild(Object.assign(shown.ownerDocument.createElement('p'), { className: 'team-set-note' }));
      note.setAttribute('data-question-note', 'true');
      note.setAttribute('role', 'status');
      note.textContent = errorText(result.error);
    }

    return {
      // After the log was written: Submit follows what is answered; a reader's card, and one being sent, is locked.
      sync() {
        for (const wrap of log.querySelectorAll('.team-conv__question')) tl.lockQuestion(wrap.querySelector('.user-questions-block'), !mayAnswer() || busy.has(wrap.dataset.questionRef));
      },
      // Each answers true when the event was a card's.
      click(event) {
        const button = event.target && event.target.closest ? event.target.closest('.user-questions-submit-btn, .user-questions-decline-btn') : null;
        const wrap = button && !button.disabled ? button.closest('.team-conv__question') : null;
        if (!wrap || !log.contains(wrap)) return false;
        void answer(wrap, button.classList.contains('user-questions-decline-btn'));
        return true;
      },
      edit(event) {
        const card = cardOf(event.target);
        if (!card) return false;
        // Typing an answer of one's own picks it, as the local card does.
        const own = event.target.matches('[data-user-question-other-input]') && event.target.value ? event.target.closest('.user-questions-other-option') : null;
        const toggle = own ? own.querySelector('[data-user-question-other-toggle]') : null;
        if (toggle) toggle.checked = true;
        tl.syncQuestion(card);
        return true;
      },
      // Enter in a card submits it (Shift+Enter breaks the line).
      key(event) {
        const card = cardOf(event.target);
        if (!card) return false;
        const submit = event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target.tagName !== 'BUTTON' ? card.querySelector('.user-questions-submit-btn') : null;
        if (submit && !submit.disabled) { event.preventDefault(); submit.click(); }
        return true;
      },
    };
  }

  // ------------------------------------------------------------ the title

  // `head`: the region the head is drawn in; `named()`: the title as the host has it ('' when untitled); `shown()`: the
  // title to draw; `reason()`: why this member cannot rename now, or ''; `rename(title)`: conversationRename, null when
  // the view is gone; `renamed(title)` runs on success; `redraw()` draws the head again; `maxLength`: the title's;
  // `idPrefix`: the conversation's, so two conversations in one document keep their own field id.
  function createTitle({ head, named, shown, reason, rename, renamed, errorText, redraw, timers, maxLength, idPrefix = '' }) {
    let editing = null; // { value, busy, note }
    const fieldId = idPrefix + RENAME_ID;
    const field = () => head.querySelector('[id="' + fieldId + '"]');
    const focus = (el) => { if (el) el.focus({ preventScroll: true }); };
    function end() { editing = null; redraw(); focus(head.querySelector('[data-project-action="rename"]')); }
    // Enter or leaving the field saves a changed name. The field is not redrawn while the call is out: it keeps the
    // focus and what is typed.
    async function save() {
      const r = editing;
      if (!r || r.busy) return;
      const next = r.value.trim();
      if (!next || next === named()) { end(); return; }
      r.busy = true;
      const answer = await rename(next);
      if (!answer || editing !== r) return;
      if (!answer.ok) { editing = { value: r.value, busy: false, note: errorText(answer.error) }; redraw(); focus(field()); return; }
      renamed(next);
      end();
    }
    return {
      // The title with its pen (greyed with its reason), or the field in its place.
      html() {
        if (editing) {
          return '<div class="team-inline-name team-head__title">' + globalThis.inventoryTextField({ id: fieldId, value: editing.value, ariaLabel: jt('team.projects.convNameLabel', 'Conversation name'),
            maxLength }) + '</div>' + (editing.note ? '<span class="team-head__sub" role="status" dir="auto">' + escapeHtml(editing.note) + '</span>' : '');
        }
        const why = reason();
        const label = jt('team.conv.rename', 'Rename this conversation');
        return '<h2 class="team-head__name" dir="auto" title="' + escapeHtml(shown()) + '">' + escapeHtml(shown()) + '</h2>'
          + inv().actionButton({ plain: true, className: 'team-icon-btn team-head__rename', ariaLabel: label, title: why || label, disabled: Boolean(why), dataset: { 'project-action': 'rename' }, trustedHtml: PEN });
      },
      start() {
        if (editing) return;
        editing = { value: named(), busy: false, note: '' };
        redraw();
        const el = field();
        if (el) { focus(el); el.select(); }
      },
      close() { editing = null; },
      // The field's own events; true when the event was the field's. Escape puts the title back. Leaving the field
      // saves, decided a moment later: a redraw of the head takes the field away too (the browser reports that as
      // leaving it) and the focus is then put on the new one, which is not the person leaving.
      handle(event) {
        if (!editing || !event.target || event.target.id !== fieldId) return false;
        const r = editing;
        if (event.type === 'input') editing.value = event.target.value;
        else if (event.type === 'focusout') timers.set(() => { if (editing === r && !r.busy && head.ownerDocument.activeElement !== field()) void save(); }, 0);
        else if (event.type === 'keydown' && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void save(); }
        else if (event.type === 'keydown' && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); end(); }
        return true;
      },
    };
  }

  // ------------------------------------------------------------ copy

  // `say(text)`: where a failed copy is also said (the box's note), besides the button's own label.
  function createCopy({ timers, view, say }) {
    const shown = new Map(); // button -> { label, icon, timer }: what it was before it said anything (kept across quick clicks)
    let stopped = false;
    return {
      // Said on the button itself for a moment; a redraw of the log puts the plain button back.
      async copy(target, text) {
        if (typeof text !== 'string') return;
        const clipboard = view && view.jennyShell && view.jennyShell.clipboard;
        let ok = false;
        try { if (clipboard && typeof clipboard.writeText === 'function') { await clipboard.writeText(text); ok = true; } } catch (_error) { ok = false; }
        if (stopped || !target.isConnected) return;
        const was = shown.get(target) || { label: target.getAttribute('aria-label'), icon: target.innerHTML, timer: null };
        if (was.timer !== null) timers.clear(was.timer);
        const said = ok ? jt('team.conv.copied', 'Copied') : jt('team.message.copyFailed', 'The message could not be copied.');
        target.innerHTML = ok ? CHECK : was.icon;
        target.setAttribute('aria-label', said);
        if (!ok && typeof say === 'function') say(said);
        was.timer = timers.set(() => { shown.delete(target); if (target.isConnected) { target.innerHTML = was.icon; target.setAttribute('aria-label', was.label); } }, COPIED_MS);
        shown.set(target, was);
      },
      stop() { stopped = true; for (const one of shown.values()) timers.clear(one.timer); shown.clear(); },
    };
  }

  // ------------------------------------------------------------ the paint loop

  // A stream event paints on the next animation frame; several in one frame paint once. The running turn's words are
  // parsed again at most every `every` ms (`live` = { text, at }: what was parsed last and when), and so is a change of
  // reasoning alone, which only the open popover shows: a timer paints what arrived after the last paint.
  function createPainter({ s, live, timers, frames, clock, draw, every }) {
    let frame = null;
    let timer = null;
    let seen = [];
    let paintedAt = -Infinity;
    const later = (wait) => { if (timer === null) timer = timers.set(() => { timer = null; soon(); }, wait); };
    function paint() {
      const stream = s.stream;
      const now = clock();
      const wait = live.at + every - now;
      if (stream && stream.text && stream.text !== live.text && wait > 0) { later(wait); return; }
      // An event that changes nothing drawn (a reasoning delta while the popover is closed) paints nothing.
      const next = stream ? [stream.id, stream.text, stream.ended, stream.status, stream.tools, s.popTurn ? stream.reasoning : null] : [];
      if (next.length === seen.length && next.every((k, i) => k === seen[i])) return;
      if (next.length === seen.length && now < paintedAt + every && next.every((k, i) => i === next.length - 1 || k === seen[i])) { later(paintedAt + every - now); return; }
      seen = next;
      paintedAt = now;
      draw();
    }
    function soon() {
      if (frame !== null || s.disposed) return;
      frame = frames.request(() => { frame = null; if (!s.disposed) paint(); });
    }
    function stop() {
      if (timer !== null) timers.clear(timer);
      if (frame !== null) frames.cancel(frame);
      timer = null;
      frame = null;
    }
    return { soon, stop, pending: () => frame !== null || timer !== null };
  }

  // ------------------------------------------------------------ the head

  // Back and the title (the Team tab only), the project, who drives and who views; in the Board's column one line of
  // who drives and views, and the readers' line (E68: nothing dismisses it; the Team tab draws it under the box).
  // `find` (row 175 item 8): { open, html } from renderer-team-project-find.js: the magnifier, or the field's slot.
  // `files` (item 1): the Files button's markup from renderer-team-project-paths.js ('' on the Board), before the magnifier;
  // `acts` (F13, F18): Ask a teammate and Hand to… from renderer-team-project-actions.js ('' on the Board), before it.
  function headHtml({ board, driver, me, nameOf, viewers, projectName, titleHtml, standing, find = { open: false, html: '' }, files = '', acts = '' }) {
    const back = jt('team.chat.back', 'Back to the list');
    const driving = driver === me ? jt('team.conv.youDrive', 'You are driving') : driver ? jt('team.conv.someoneDrives', '{name} is driving', { name: nameOf(driver) }) : jt('team.conv.nobodyDrives', 'nobody is driving');
    const others = viewers.filter((id) => id !== me).map((id) => nameOf(id));
    const viewing = others.length ? jt('team.conv.viewing', '{names} and you viewing', { names: others.join(', ') }) : jt('team.conv.viewingYou', 'you viewing');
    const sub = board ? [driver ? driving : '', typeof board.viewers === 'function' ? String(board.viewers() || '') : ''].filter(Boolean).join(' · ')
      : [projectName, driving, viewing].filter(Boolean).join(' · ');
    const lead = board ? '' : inv().actionButton({ plain: true, className: 'team-icon-btn team-back', ariaLabel: back, title: back, dataset: { 'team-tab-action': 'back' }, trustedHtml: BACK }) + titleHtml();
    return '<header class="team-head"' + (find.open ? ' data-find-open' : '') + '>' + lead + (sub ? '<span class="team-head__sub" dir="auto">' + escapeHtml(sub) + '</span>' : '')
      + acts + files + (board ? '<span class="team-head__sub" data-standing="true" dir="auto">' + escapeHtml(standing) + '</span>' : find.html) + '</header>';
  }

  // ------------------------------------------------------------ the transcript popover

  // Which turn it shows (`s.popTurn`), its steps, and what it hands focus to when it goes: the chip that opened it when
  // the person closes it, the box when it closes itself (its turn left the held history, or the conversation closed).
  // `popper()` is the turn popover; `draw()` the conversation's; `earlier()` reads the page before the held ones.
  function createPop({ s, ch, popper, host, root, scroller, board, questions, asking, mayAnswer, draw, earlier, stop, focusBox, renders }) {
    let extra = null;
    const chipFor = (id) => Array.from(root.querySelectorAll('.team-turn-chip')).find((el) => el.dataset.turnId === id) || null;
    // `keepFocus`: a step from the popover's own button leaves the focus on that button (the chip's click moves it in).
    function open(id, keepFocus = false) {
      s.popTurn = id;
      draw();
      if (!keepFocus && popper().isOpen()) popper().focus();
    }
    function close() {
      const id = s.popTurn;
      s.popTurn = '';
      draw();
      const chip = chipFor(id);
      if (chip) chip.focus({ preventScroll: true });
    }
    // An earlier turn at the edge of what is held reads the page before it first.
    async function step(by) {
      const v = ch.view();
      const at = v.turns.findIndex((t) => t.id === s.popTurn);
      if (at < 0) return;
      const next = v.turns[at + by];
      if (next) { open(next.id, true); return; }
      if (by < 0 && (await earlier())) { const again = ch.view(); const now = again.turns.findIndex((t) => t.id === s.popTurn); if (now > 0) open(again.turns[now - 1].id, true); }
    }
    // The cards are synced when what they are drawn from changed (the popover keeps a card's node while its markup stays).
    function paint(v) {
      const model = s.popTurn ? ch.popModel(v) : null;
      if (model) {
        renders.pop = (renders.pop || 0) + 1;
        popper().render(model);
        const from = model.extraHtml + (mayAnswer() ? '' : '|reader');
        if (from !== extra) { extra = from; if (asking().length) questions.sync(); }
      } else {
        extra = null;
        s.popTurn = '';
        if (popper().isOpen()) { const held = host.contains(root.ownerDocument.activeElement); popper().close(); if (held) focusBox(); }
      }
      // The Board's column is narrow: the popover covers it, and what is behind it cannot be reached.
      if (board) scroller.inert = Boolean(model);
    }
    function action(kind) {
      if (kind === 'close') close();
      else if (kind === 'stop') stop();
      else void step(kind === 'prev' ? -1 : 1);
    }
    return { open, close, paint, action };
  }

  return { RENAME_ID, remember, noteLine, sendAgainWhy, poolNodes, poolRead, oneModel, teamModel, channelShellHtml, createLease, createHistory, createApprovals, createQuestions, createTitle, createCopy, createPainter, headHtml, createPop };
});
