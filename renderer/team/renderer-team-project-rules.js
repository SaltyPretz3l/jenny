/* Team tab: "Always allowed" on a project page (row 123, slice 3-10; the owner's design in picks_3-10.md fork 3,
 * on the host's rules from slice 3-12, TEAM_PROJECTS_SPEC "3-12 as built").
 *
 * One section per open project page: the count of rules, the sentence (non-admins add how to ask), an admin's
 * waiting requests ("{Name} asks" with Allow, Change… and Decline…), the rules in force ("{tool}", where, set by,
 * Remove for admins) and an admin's "Add a rule" (the same tool and where form, no request). The list is read with
 * `projectRules` when the page opens and again on the project's `rules_changed` and `rule_requests` pushes; nothing
 * is kept after the page closes. One answer wins (the host's rule); a losing answer shows its reason's sentence.
 *
 * Paused (file tools on a team host, row 123): while the last good answer says `paused: 'file_tools'` the host's owner has
 * turned project files on, every change asks a person whatever these rules say. The section then says so, keeps the list
 * (dimmed, `aria-disabled`) and draws every button disabled with the reason as its title; a click does nothing and no
 * form stays open. Without `paused` the markup is what it was.
 *
 * Bounds (the host's): 32 rules, 16 open requests. The forms check the folder and the decline reason as main does
 * (column.checkFolder, column.checkReason: `..`, a hidden or absolute folder, a backslash, a trailing slash, more than
 * 8 segments, bidi and zero-width characters; a reason of 1 to 200 visible characters), so a payload main would refuse
 * is never sent and the person reads team_rule_folder_invalid's or team_rule_reason_invalid's sentence. The form's
 * typed fields are kept across redraws by the page (column.writeKeeping).
 *
 * `createRules({ teamId, projectId, call, isAdmin(), nameOf(id), conversationTitle(id), timeText(ms), errorText(error),
 * onChange() })` -> { html(), onClick(target), onInput(target), onSelect(target), refresh(), dispose() }.
 *
 * `createPausedWatch({ read(), clock(), live(), redraw() })` -> { paused(), check() }: the conversation's own read of the same
 * state, for its approval cards (OD-2: while paused a card offers no "Always allow" and no "Allow once, ask for always", since
 * no rule would ever fire). `check()` reads `projectRules` when an approval waits (at most every 30 s, and again after 5 s
 * when a read failed); `paused()` is true until a read said it is not (fail closed), and `redraw()` runs when it changes. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-project-column'));
    return;
  }
  root.rendererTeamProjectRules = factory(root.rendererTeamProjectColumn);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (column) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const TOOLS = Object.freeze(['edit_file', 'write_file']);
  const FOLDER_MAX = 255;
  const REASON_MAX = 200;
  const RECHECK_MS = 30_000;
  const RETRY_MS = 5000;

  function inv() { return globalThis.inventory || {}; }
  const button = column.button;
  function select(id, label, value, options, action) {
    return inv().selectField({ id, ariaLabel: label, tooltip: label, value, options, dataset: { 'project-input': action } });
  }
  function textInput(id, label, value, max, action) {
    return globalThis.inventoryTextField({ id, value, ariaLabel: label, placeholder: label, maxLength: max, dataset: { 'project-input': action } });
  }
  function row(name, fact, actions, extra = '') {
    return '<li class="team-set-person"><div class="team-set-person__who"><span class="team-set-person__name" dir="auto">' + escapeHtml(name) + '</span>'
      + (fact ? '<span class="team-set-person__fact" dir="auto">' + escapeHtml(fact) + '</span>' : '') + '</div><div class="team-set-person__acts">' + actions + '</div>' + extra + '</li>';
  }

  // "anywhere in this project" or "in {folder} only".
  function whereText(folder) {
    return folder ? jt('team.rules.inFolder', 'in {folder} only', { folder: column.clean(folder, FOLDER_MAX) }) : jt('team.rules.anywhere', 'anywhere in this project');
  }

  // The form's tool and place as main checks them: { ok, tool, folder } or { ok: false, reason }.
  function checkedWhere(form) {
    const tool = TOOLS.includes(form.tool) ? form.tool : TOOLS[0];
    if (form.where !== 'folder') return { ok: true, tool, folder: null };
    const checked = column.checkFolder(form.folder);
    return checked.ok ? { ok: true, tool, folder: checked.folder } : checked;
  }

  function createRules({ teamId, projectId, call, isAdmin, nameOf, conversationTitle, timeText, errorText, onChange }) {
    let data = null; // the last good answer
    let error = '';
    let note = '';
    let reading = null;
    let again = false;
    let form = null; // { kind: 'add' | 'change' | 'decline', request_seq?, tool, where, folder, reason }
    const busy = new Set();
    let disposed = false;
    const ids = { team_id: teamId, project_id: projectId };
    const paused = () => Boolean(data && data.paused === 'file_tools');
    // A section button: while paused it is disabled with the reason as its title.
    const pausable = (action, label, opts = {}) => button(action, label, paused() ? { ...opts, disabled: true, title: jt('team.rules.pausedTitle', 'Paused while project files are on') } : opts);

    function read() {
      if (disposed) return null;
      if (reading) { again = true; return reading; }
      reading = call('projectRules', ids).then((answer) => {
        reading = null;
        if (disposed) return;
        if (answer.ok) { data = answer; error = ''; if (paused()) form = null; } else error = errorText(answer.error);
        if (again) { again = false; void read(); }
        onChange();
      });
      return reading;
    }

    async function run(key, method, payload, after) {
      if (busy.has(key) || disposed) return null;
      busy.add(key);
      note = '';
      onChange();
      const answer = await call(method, { ...ids, ...payload });
      if (disposed) return answer;
      busy.delete(key);
      if (answer.ok) { if (after) after(answer); void read(); } else note = errorText(answer.error);
      onChange();
      return answer;
    }

    function formHtml(heading, confirmAction, confirmLabel, { decline = false } = {}) {
      const fields = decline
        ? textInput('teamRuleReason', jt('team.rules.reason', 'Reason'), form.reason, REASON_MAX, 'reason')
        : select('teamRuleTool', jt('team.rules.tool', 'Tool'), form.tool, TOOLS.map((tool) => ({ value: tool, label: tool })), 'tool')
          + select('teamRuleWhere', jt('team.rules.where', 'Where'), form.where, [{ value: 'any', label: jt('team.rules.whereAny', 'Anywhere in this project') },
            { value: 'folder', label: jt('team.rules.whereFolder', 'Only in a folder') }], 'where')
          + (form.where === 'folder' ? textInput('teamRuleFolder', jt('team.rules.folder', 'Folder'), form.folder, FOLDER_MAX, 'folder') : '');
      const key = form.kind + ':' + (form.request_seq || 0);
      return column.confirmBlock(heading, heading, fields + button(confirmAction, confirmLabel, { variant: decline ? 'danger' : 'primary', disabled: busy.has(key) })
        + button('rule-form-cancel', jt('team.projects.cancel', 'Cancel')));
    }

    function requestRow(request) {
      const asker = nameOf(request.asker_member_id);
      const seq = String(request.request_seq);
      const from = conversationTitle(request.session_id);
      const fact = from
        ? jt('team.rules.requestFact', 'always allow {tool} · from “{conversation}” · {time}', { tool: request.tool_name, conversation: column.clean(from), time: timeText(request.asked_at) })
        : jt('team.rules.requestFactNoTitle', 'always allow {tool} · {time}', { tool: request.tool_name, time: timeText(request.asked_at) });
      const open = form && form.request_seq === request.request_seq ? form.kind : '';
      const acts = pausable('rule-allow', jt('team.rules.allow', 'Allow'), { variant: 'primary', title: jt('team.rules.allowTitle', 'Always allow {tool} anywhere in this project, as {name} asked', { tool: request.tool_name, name: asker }),
        disabled: busy.has('allow:' + seq), dataset: { 'request-seq': seq } })
        + pausable('rule-change', jt('team.rules.change', 'Change…'), { title: jt('team.rules.changeTitle', 'Allow it narrower: another tool, or one folder'), dataset: { 'request-seq': seq } })
        + pausable('rule-decline', jt('team.rules.decline', 'Decline…'), { title: jt('team.rules.declineTitle', 'Say no, with a reason {name} sees', { name: asker }), dataset: { 'request-seq': seq } });
      let extra = '';
      if (open === 'change') extra = formHtml(jt('team.rules.changeHeading', 'Allow {name}’s request as:', { name: asker }), 'rule-change-go', jt('team.rules.allow', 'Allow'));
      if (open === 'decline') extra = formHtml(jt('team.rules.declineHeading', 'Tell {name} why. They see this in the conversation where they asked.', { name: asker }), 'rule-decline-go', jt('team.rules.declineGo', 'Decline'), { decline: true });
      return row(jt('team.rules.asks', '{name} asks', { name: asker }), fact, acts, extra);
    }

    function ruleRow(rule, admin) {
      const fact = jt('team.rules.ruleFact', '{where} · set by {name}', { where: whereText(rule.folder), name: nameOf(rule.set_by) });
      const remove = admin ? pausable('rule-remove', jt('team.rules.remove', 'Remove'), { title: jt('team.rules.removeTitle', 'Stop always allowing {tool} {where}', { tool: rule.tool_name, where: whereText(rule.folder) }),
        disabled: busy.has('remove:' + rule.rule_seq), dataset: { 'rule-seq': String(rule.rule_seq) } }) : '';
      return row(rule.tool_name, fact, remove);
    }

    function html() {
      const admin = isAdmin();
      const rules = data ? data.rules : [];
      const count = jtn('team.rules.count', rules.length, {}, '{count} rule', '{count} rules');
      const copy = jt('team.rules.copy', 'Changes Jenny may make in this project without asking, for everyone’s turns.')
        + (admin ? '' : ' ' + jt('team.rules.copyAsk', 'Project admins set these; you can ask for one from an approval.'));
      const requests = admin && data ? data.requests.filter((request) => request.state === 'open') : [];
      const rows = requests.map(requestRow).join('') + rules.map((rule) => ruleRow(rule, admin)).join('');
      const add = admin ? (form && form.kind === 'add' ? formHtml(jt('team.rules.addHeading', 'Always allow in this project:'), 'rule-add-go', jt('team.rules.addGo', 'Add rule'))
        : '<div class="team-page__acts">' + pausable('rule-add', jt('team.rules.add', 'Add a rule'), { title: jt('team.rules.addTitle', 'Always allow a file tool in this project, for everyone’s turns'), disabled: rules.length >= 32 }) + '</div>') : '';
      const notes = [error, note].filter(Boolean).map((text) => '<p class="team-set-note" role="status">' + escapeHtml(text) + '</p>').join('');
      return '<section data-team-project-section="rules"><h3>' + escapeHtml(jt('team.rules.heading', 'Always allowed')) + ' <span class="team-set-count">' + escapeHtml(data ? count : '') + '</span></h3>'
        + '<p class="team-page__fact">' + escapeHtml(copy) + '</p>'
        + (paused() ? '<p class="team-page__fact">' + escapeHtml(jt('team.rules.paused', 'Paused while project files are on: every change Jenny makes asks a person, whatever these rules say. The host’s owner turns project files on and off in Settings, Team.')) + '</p>' : '')
        + (rows ? '<ul class="team-set-list' + (paused() ? ' team-set-list--paused" aria-disabled="true' : '') + '">' + rows + '</ul>' : '') + add + notes + '</section>';
    }

    function openForm(kind, seq) {
      const request = data && seq ? data.requests.find((r) => r.request_seq === seq) : null;
      form = { kind, request_seq: seq || 0, tool: request ? request.tool_name : TOOLS[0], where: 'any', folder: '', reason: '' };
      note = '';
      onChange();
    }

    function onClick(target) {
      const action = target.dataset.projectAction;
      const seq = Number(target.dataset.requestSeq) || 0;
      if (paused() && action && action.startsWith('rule-')) return true; // paused: the buttons are disabled, and nothing runs
      switch (action) {
        case 'rule-allow': void run('allow:' + seq, 'projectRuleAnswer', { request_seq: seq, outcome: 'allow' }); return true;
        case 'rule-change': openForm('change', seq); return true;
        case 'rule-decline': openForm('decline', seq); return true;
        case 'rule-add': openForm('add', 0); return true;
        case 'rule-form-cancel': form = null; note = ''; onChange(); return true;
        case 'rule-remove': void run('remove:' + target.dataset.ruleSeq, 'projectRuleRemove', { rule_seq: Number(target.dataset.ruleSeq) }); return true;
        case 'rule-change-go':
        case 'rule-add-go': {
          const where = checkedWhere(form);
          if (!where.ok) { note = errorText({ reason: where.reason }); onChange(); return true; }
          const done = () => { form = null; };
          if (action === 'rule-add-go') void run('add:0', 'projectRuleAdd', { tool_name: where.tool, folder: where.folder }, done);
          else void run('change:' + form.request_seq, 'projectRuleAnswer', { request_seq: form.request_seq, outcome: 'change', tool_name: where.tool, ...(where.folder ? { folder: where.folder } : {}) }, done);
          return true;
        }
        case 'rule-decline-go': {
          const reason = column.checkReason(form.reason);
          if (!reason.ok) { note = errorText({ reason: reason.reason }); onChange(); return true; }
          void run('decline:' + form.request_seq, 'projectRuleAnswer', { request_seq: form.request_seq, outcome: 'decline', reason: reason.reason }, () => { form = null; });
          return true;
        }
        default: return false;
      }
    }

    // Typing is kept without a redraw; a select's change redraws (the folder field comes and goes).
    function onInput(target) {
      const key = target.dataset.projectInput;
      if (!form || !['folder', 'reason'].includes(key)) return false;
      form[key] = target.value;
      return true;
    }
    function onSelect(target) {
      const key = target.dataset.projectInput;
      if (!form || !['tool', 'where'].includes(key)) return false;
      form[key] = target.value;
      onChange();
      return true;
    }

    void read();
    return { html, onClick, onInput, onSelect, refresh: read, dispose() { disposed = true; form = null; busy.clear(); } };
  }

  function createPausedWatch({ read, clock, live, redraw }) {
    let state = null; // true: paused; false: not; null: not read yet, or the last read failed
    let at = -Infinity;
    let reading = false;
    function check() {
      if (reading || !live() || clock() - at < (state === null ? RETRY_MS : RECHECK_MS)) return;
      reading = true;
      at = clock();
      const done = (next) => {
        reading = false;
        if (!live()) return;
        const changed = (state !== false) !== (next !== false);
        state = next;
        if (changed) redraw();
      };
      Promise.resolve().then(read).then((answer) => done(answer && answer.ok ? Boolean(answer.paused) : null), () => done(null));
    }
    return { paused: () => state !== false, check };
  }

  return { createRules, createPausedWatch };
});
