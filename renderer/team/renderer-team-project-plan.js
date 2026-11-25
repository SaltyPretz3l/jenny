/* Team tab: plan mode in a shared conversation (row 175 item 7, D14). The Plan chip beside Tools (`conversationPreferences` `plan_mode`);
 * the plan in Jenny's row as the local plan document, read-only, with Keep planning, Looks good, not yet and Build it for any writer
 * viewing (`conversationDecide` `plan_decision`), then the local receipt (an accepted plan keeps Build it while plan mode is on); in
 * Jenny's work a one-line receipt. The plan's approval is kept out of the generic cards (`visible`) and its plan_document message
 * blanked for the timeline (`blank`). `o` is the conversation's reads and calls (renderer-team-project-conversation.js): `root` and
 * `idPrefix` are its own, so the feedback field's id is the conversation's and no lookup leaves its root.
 *
 * Keep planning (H21.2) opens a small field with Send and Cancel; Escape in the field cancels too, back to the three decisions with the
 * focus on Keep planning. What was typed is kept by approval until the plan is decided: a refusal, a redraw and a Cancel keep it.
 * Plan mode switches with Shift+Tab or Alt+P from the message box, as the local composer's run mode does (renderer-plan-mode-shortcut.js):
 * not on a repeat, with Ctrl or Meta, and Shift+Tab with Alt is the browser's. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-project-column'), require('./renderer-team-turn-adapter'), require('../features/renderer-plan-document'));
    return;
  }
  root.rendererTeamProjectPlan = factory(root.rendererTeamProjectColumn, root.rendererTeamTurnAdapter, root.rendererPlanDocument);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (column, adapter, planDocs) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || ((k, d, p) => (p ? String(d).replace(/\{(\w+)\}/g, (m, n) => (Object.hasOwn(p, n) ? String(p[n]) : m)) : d));
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const chipOf = (o) => ((globalThis.inventory || {}).chip || require('../inventory/chip'))(o);
  const fieldOf = (o) => (globalThis.inventoryTextField || require('../inventory/text-field'))(o);

  const KINDS = new Set(['approved', 'accepted', 'rejected']);
  const DECISION = { 'plan-build': 'approved', 'plan-accept': 'accepted', 'plan-send': 'rejected' };
  const EDIT_HOOKS = ['data-plan-title', 'data-plan-step-text', 'data-plan-step-raw', 'role', 'tabindex', 'draggable', 'aria-label'];
  const FEEDBACK_MAX = 800;
  const ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 4h8M5 8h8M5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/></svg>';
  const isPlanApproval = (a) => Boolean(a) && a.tool_name === 'exit_plan_mode';
  const isPlanMessage = (m) => Boolean(m) && m.kind === 'plan_document';
  const who = (text) => '<p class="tool-approval-who" dir="auto">' + escapeHtml(text) + '</p>';

  function createPlan(o) {
    const answered = new Set(); // decided here, until a snapshot stops listing them
    const decisions = new Map(); // approval id -> { by, at, kind }
    const forms = new Set(); // approval ids with Keep planning's feedback field open
    const drafts = new Map(); // approval id -> the feedback typed so far
    const feedbackId = (o.idPrefix || '') + 'teamPlanFeedback';
    const feedbackIn = (scope) => (scope || o.root).querySelector('[id="' + feedbackId + '"]');
    const lost = new Map(); // approval id -> a refusal's sentence
    const busy = new Set();
    const memo = { src: null, out: null, plans: [] };
    const blanks = { src: null, out: null };
    let pairing = { rev: -1, held: null, list: [] };
    let overlay = null; // { base, on }: what the host accepted, until the next snapshot
    let rev = 0;
    const bump = () => { rev += 1; };
    const redraw = () => { bump(); o.redraw(); };

    function visible(snap) {
      if (!snap || !Array.isArray(snap.pending_approvals)) return snap;
      if (memo.src !== snap) {
        const plans = snap.pending_approvals.filter(isPlanApproval);
        for (const id of [...answered]) if (!plans.some((a) => a.approval_id === id)) answered.delete(id);
        for (const id of [...drafts.keys()]) if (!plans.some((a) => a.approval_id === id)) drafts.delete(id);
        Object.assign(memo, { src: snap, plans, out: plans.length ? { ...snap, pending_approvals: snap.pending_approvals.filter((a) => !isPlanApproval(a)) } : snap });
        bump();
      }
      return memo.out;
    }
    const waitingList = () => { visible(o.snapshot()); return memo.plans.filter((a) => !answered.has(a.approval_id)); };
    function blank(list) {
      if (blanks.src !== list) Object.assign(blanks, { src: list, out: Array.isArray(list) && list.some(isPlanMessage) ? list.map((m) => (isPlanMessage(m) ? { ...m, content: '' } : m)) : list });
      return blanks.out;
    }
    const docsOf = (list) => (Array.isArray(list) ? list.map((m) => adapter.planOf(m)).filter(Boolean) : []);
    // A waiting approval and its plan_document: by approval id, by call id, else the newest one pending (not certain).
    function pairs() {
      const waiting = waitingList();
      const held = blank(o.messages());
      if (pairing.rev === rev && pairing.held === held) return pairing.list;
      const all = docsOf(held);
      const list = waiting.map((a) => ({ a, doc: all.find((d) => d.plan.approval_id === a.approval_id) || all.find((d) => a.call_id && d.plan.tool_call_id === a.call_id)
        || all.findLast((d) => d.plan.state === 'pending') || null }));
      pairing = { rev, held, list };
      return list;
    }

    const mayDecide = () => o.role() !== 'reader';
    function on() {
      const base = o.snapshot();
      return overlay && overlay.base === base ? overlay.on : Boolean(base && base.session && base.session.plan_mode === true);
    }
    function gate() {
      if (!mayDecide()) return jt('team.plan.reader', 'Only writers and admins can change plan mode.');
      if (!o.mayDrive()) return jt('team.plan.driving', '{name} is driving. You can change plan mode when you drive.', { name: column.clean(o.nameOf(o.driver()), 64) });
      if (waitingList().length) return jt('team.plan.waits', 'A plan is waiting for a decision. Decide it first.');
      return o.running() ? jt('team.plan.running', 'Changes apply from the next turn.') : '';
    }
    function chipHtml() {
      const reason = gate();
      const isOn = on();
      const title = jt('team.plan.title', 'Plan mode: Jenny plans first and changes nothing until a plan is accepted. It applies to everyone in this conversation.')
        + ' ' + (reason || jt('team.plan.shortcutAlt', 'Shift+Tab or Alt+P switches it.'));
      const button = chipOf({ domId: (o.idPrefix || '') + 'teamConvPlanChip', label: jt('team.plan.chip', 'Plan'), iconHtml: ICON, pressed: isOn, title, className: 'composer-plan-chip' });
      return '<span class="team-conv-ctl team-conv-ctl--plan">' + button.replace(/^<(\w+)/, '<$1 data-plan-chip aria-keyshortcuts="Shift+Tab Alt+P"' + (reason ? ' aria-disabled="true"' : '')) + '</span>';
    }
    async function setPlan(next) {
      const answer = await o.change({ plan_mode: next });
      const base = o.snapshot();
      if (!answer || !answer.ok || !base) return false;
      overlay = { base, on: next };
      bump();
      return true;
    }
    async function toggle() {
      if (gate()) return;
      await setPlan(!on());
      redraw();
    }

    function parse(html) {
      const holder = o.doc.createElement('template');
      holder.innerHTML = html;
      return holder.content.firstElementChild;
    }
    function decisionsHtml(id) {
      const button = (action, label, variant) => column.button(action, label, { variant, disabled: busy.has(id), dataset: { 'approval-id': id } });
      const keep = jt('team.plan.keepPlanning', 'Keep planning');
      if (forms.has(id)) {
        return fieldOf({ id: feedbackId, label: jt('team.plan.feedbackLabel', 'What should change?'), placeholder: jt('team.plan.feedbackPlaceholder', 'Optional feedback'),
          multiline: true, rows: 2, maxLength: FEEDBACK_MAX, value: drafts.get(id) || '', disabled: busy.has(id), dataset: { 'plan-feedback': id } })
          + '<span class="plan-document__actions-group">' + button('plan-send', keep, 'primary') + button('plan-keep-cancel', jt('team.projects.cancel', 'Cancel'), 'ghost') + '</span>';
      }
      return '<span class="plan-document__actions-group">' + button('plan-keep', keep, 'ghost') + button('plan-accept', jt('team.plan.looksGoodNotYet', 'Looks good, not yet'), 'ghost')
        + '</span><span class="plan-document__actions-group">' + button('plan-build', jt('team.plan.buildIt', 'Build it'), 'primary') + '</span>';
    }
    function whoLine(prompter, reader) {
      const name = (prompter && column.clean(o.nameOf(prompter), 64)) || jt('team.plan.someone', 'Someone');
      return who(jt('team.plan.made', '{name}’s turn made this plan.', { name }) + ' ' + (reader ? jt('team.plan.readerDecides', 'A writer in this project decides it.')
        : jt('team.plan.anyWriter', 'Anyone who can write in this project and is viewing this conversation can decide it.')));
    }
    function pendingHtml(a, doc) {
      const reader = !mayDecide();
      const base = doc ? doc.plan : { title: column.plain(a.summary, 120), steps: [] };
      const section = parse(planDocs.fullDocumentMarkup({ ...base, state: 'pending', approval_id: a.approval_id, tool_call_id: a.call_id || '' }, { escapeHtml }));
      for (const el of section.querySelectorAll('[data-plan-title], [data-plan-step-text], [draggable]')) for (const name of EDIT_HOOKS) el.removeAttribute(name);
      const bar = section.querySelector('.plan-document__decision');
      const actions = section.querySelector('[data-plan-actions]');
      if (reader && bar) bar.remove(); else if (actions) actions.innerHTML = decisionsHtml(a.approval_id);
      const note = lost.get(a.approval_id);
      section.insertAdjacentHTML('beforeend', whoLine(a.prompter_member_id, reader) + (note ? '<p class="team-set-note" role="status">' + escapeHtml(note) + '</p>' : ''));
      return section.outerHTML;
    }
    function receiptHtml(plan, label) {
      const receipt = parse(planDocs.collapsedReceiptMarkup(plan, { escapeHtml }));
      const state = receipt.querySelector('.plan-document-receipt__state');
      if (state && label) state.textContent = label;
      for (const slot of receipt.querySelectorAll('[data-plan-build-accepted]')) slot.remove();
      return receipt.outerHTML;
    }
    function labelOf(state, rec) {
      if (!rec || !rec.at) return '';
      const p = { name: column.clean(o.nameOf(rec.by), 64), time: rec.at };
      if (state === 'accepted') return jt('team.plan.acceptedBy', 'Accepted by {name} · {time} · not built', p);
      return state === 'approved' ? jt('team.plan.approvedBy', 'Approved by {name} · {time}', p) : '';
    }
    const newest = () => docsOf(blank(o.messages())).pop() || null;
    // Build it: the newest accepted plan, while plan mode is on.
    function buildHtml(doc) {
      const last = newest();
      if (!mayDecide() || !last || last.id !== doc.id || !on()) return '';
      const build = jt('team.plan.buildIt', 'Build it');
      return '<div class="team-plan-act">' + column.button('plan-build-accepted', build, { variant: 'primary', disabled: o.running() || busy.has('build'),
        title: o.running() ? jt('team.plan.buildWait', 'Wait for the turn to end.') : build })
        + (o.driver() === o.me() ? '' : who(jt('team.plan.buildDrives', 'Build it starts a turn as you and makes you the driver.'))) + '</div>';
    }
    function decidedHtml(doc, build) {
      const p = doc.plan;
      const rec = decisions.get(p.approval_id) || (p.decided_by ? { by: p.decided_by, at: o.timeText(p.decided_at), kind: '' } : null);
      const state = p.state === 'pending' && rec && rec.kind ? rec.kind : p.state;
      return receiptHtml({ ...p, state }, labelOf(state, rec)) + (build && state === 'accepted' ? buildHtml(doc) : '');
    }
    function rowOf(doc, pop) {
      const pair = pairs().find((p) => p.doc && p.doc.id === doc.id);
      if (pair) return pop ? receiptHtml(doc.plan, jt('team.plan.popWaits', 'Waiting for a decision')) : pendingHtml(pair.a, doc);
      const rec = decisions.get(doc.plan.approval_id);
      return doc.plan.state !== 'pending' || (rec && rec.kind) ? decidedHtml(doc, !pop) : '';
    }
    const inItem = (item, pop) => (item && item.kind === 'turn' ? docsOf(item.messages).map((d) => rowOf(d, pop)).join('') : '');

    function record(id, by, kind) {
      decisions.set(id, { by, at: o.time(), kind: KINDS.has(kind) ? kind : '' });
    }
    // `scope` is the clicked plan's own element: the Team tab and the Board column may each show this conversation.
    async function decide(a, kind, scope) {
      const id = a.approval_id;
      if (!mayDecide() || busy.has(id)) return;
      const field = feedbackIn(scope);
      const text = String(field ? field.value : drafts.get(id) || '').trim().slice(0, FEEDBACK_MAX);
      busy.add(id);
      lost.delete(id);
      redraw();
      const answer = await o.decide({ stream_id: a.stream_id, approval_id: id, decision_revision: a.decision_revision, approved: true, plan_decision: kind,
        ...(kind === 'rejected' && text ? { feedback: text } : {}) }); // no feedback: the tool says so itself
      if (!answer) return;
      busy.delete(id);
      if (answer.ok) { answered.add(id); record(id, o.me(), kind); forms.delete(id); drafts.delete(id); } else lost.set(id, o.errorText(answer.error));
      redraw();
    }
    async function build() {
      if (!mayDecide() || o.running() || busy.has('build') || !newest()) return;
      busy.add('build');
      redraw();
      const driving = o.driver() === o.me() || (await o.takeover());
      if (driving && (await setPlan(false))) await o.send(jt('team.plan.buildPrompt', 'Build the accepted plan.'));
      busy.delete('build');
      redraw();
    }

    function act(action, id, scope) {
      const a = waitingList().find((p) => p.approval_id === id);
      if (action === 'plan-build-accepted') void build();
      else if (a && DECISION[action]) void decide(a, DECISION[action], scope);
      else if (a && action === 'plan-keep') {
        forms.add(id);
        redraw();
        const field = feedbackIn();
        if (field) field.focus({ preventScroll: true });
      } else if (a && action === 'plan-keep-cancel') cancel(id);
    }
    // Back to the three decisions, the focus on Keep planning; the typed words stay for the next time.
    function cancel(id) {
      if (!forms.delete(id)) return;
      redraw();
      const again = Array.from(o.root.querySelectorAll('[data-project-action="plan-keep"]')).find((b) => b.dataset.approvalId === id);
      if (again) again.focus({ preventScroll: true });
    }
    function input(event) {
      const id = event.target && event.target.dataset ? event.target.dataset.planFeedback : '';
      if (!id) return false;
      drafts.set(id, String(event.target.value || '').slice(0, FEEDBACK_MAX));
      return true;
    }
    function click(event) {
      const t = event.target && event.target.closest ? event.target : null;
      const chip = t && t.closest('[data-plan-chip]');
      if (chip) { if (!chip.hasAttribute('aria-disabled')) void toggle(); return true; }
      const b = t && t.closest('[data-project-action^="plan-"]');
      if (!b) return false;
      if (!b.disabled) act(b.dataset.projectAction, b.dataset.approvalId, b.closest('.plan-document'));
      return true;
    }
    // Escape in the feedback field cancels it; Shift+Tab or Alt+P in the message box switches plan mode (the local composer's keys).
    function key(event, field) {
      const feedback = event.target && event.target.dataset ? event.target.dataset.planFeedback : '';
      if (feedback && (event.key === 'Escape' || event.key === 'Esc')) { event.preventDefault(); event.stopPropagation(); cancel(feedback); return true; }
      if (event.target !== field || event.repeat || event.defaultPrevented || event.ctrlKey || event.metaKey) return false;
      const tab = event.key === 'Tab' && event.shiftKey && !event.altKey;
      if (!(tab || (event.altKey && String(event.key).toLowerCase() === 'p')) || gate()) return false;
      event.preventDefault();
      void toggle();
      return true;
    }
    function decided(event) {
      const id = event && event.approval_id;
      visible(o.snapshot());
      if (!id || !(decisions.has(id) || memo.plans.some((a) => a.approval_id === id))) return false;
      if (event.approved === true && !decisions.has(id)) record(id, event.approver_member_id || '', event.plan_decision);
      answered.add(id);
      redraw();
      return true;
    }

    return {
      visible, blank, on, click, key, input, decided,
      version: () => { visible(o.snapshot()); return rev; },
      footHtml: (item) => inItem(item, false),
      popHtml: (item) => inItem(item, true),
      cardsHtml: () => pairs().filter((p) => !p.doc).map((p) => pendingHtml(p.a, null)).join(''),
      join: (parts) => ({ ...parts, tools: parts.tools + chipHtml() }),
      box: () => ({ planOn: on(), planWaits: waitingList().length > 0 }),
    };
  }

  return { createPlan };
});
