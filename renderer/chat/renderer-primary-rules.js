(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-chat-messages-copy'));
    return;
  }
  root.rendererPrimaryRules = factory(root.rendererChatMessagesCopy);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (copy) {
  'use strict';

  // The Jenny chat's standing rules in the Activity dialog (row 87, owner pick A1 2026-11-02, mockup
  // po-mockups/action-rules/): one "Your rules" list of plain sentences that folds in row 76's launch
  // permissions, then one sentence-builder form ([Always allow | Always ask before | Never] [action] [which
  // chats]). The action and target lists follow the first choice (plan Q1). Rule records come from
  // window.jennyShell.primaryChat.permissions(); project and chat names reach the DOM only through escapeHtml.

  const { jt, jtn, escapeHtml } = copy;
  const RULE_ID = /^ar_[0-9a-f]{32}$/u;
  const ACTION_ORDER = ['message', 'launch', 'stop', 'schedule', 'setting'];
  // Which actions each rule kind offers (the launch allow is a row 76 permission).
  const EFFECT_ACTIONS = Object.freeze({
    allow: ['message', 'launch'], ask: ['message'], deny: ['message', 'launch', 'stop', 'schedule', 'setting'],
  });
  // With a flag off, its choices drop out: rules (primary_action_rules) or the launch allow (launch_permission).
  function effectActions(flags) {
    const f = copy.isObject(flags) ? flags : {};
    const out = {};
    for (const [effect, actions] of Object.entries(EFFECT_ACTIONS)) {
      const offered = actions.filter((action) => (effect === 'allow' && action === 'launch' ? f.launch_permission === true : f.action_rules !== false));
      if (offered.length) out[effect] = offered;
    }
    return out;
  }
  const RULE_ENTRY_KINDS = new Set(['rule_added', 'rule_revoked', 'rule_denied']);
  const FOCUS_ATTRS = ['data-primary-rule-effect', 'data-primary-rule-action', 'data-primary-rule-target', 'data-primary-rule-auto', 'data-primary-rule-submit'];
  const DEFAULT_FORM = Object.freeze({ effect: 'allow', action: 'message', target: 'linked', auto: false });

  const effectLabel = (effect) => (effect === 'allow' ? jt('chat.primary.rules.effect.allow', 'Always allow')
    : effect === 'ask' ? jt('chat.primary.rules.effect.ask', 'Always ask before') : jt('chat.primary.rules.effect.deny', 'Never'));

  function actionLabel(action) {
    switch (action) {
      case 'message': return jt('chat.primary.rules.action.message', 'messaging');
      case 'launch': return jt('chat.primary.rules.action.launch', 'starting chats');
      case 'stop': return jt('chat.primary.rules.action.stop', 'stopping chats');
      case 'schedule': return jt('chat.primary.rules.action.schedule', 'changing scheduled checks');
      default: return jt('chat.primary.rules.action.setting', 'changing settings');
    }
  }

  // Chats Jenny started (the primary's linked children), by title; the most recently updated LINKED_CHAT_OPTIONS
  // only, since "chats Jenny started" covers them all.
  const LINKED_CHAT_OPTIONS = 50;
  function linkedChats(sessions, primaryId) {
    return (Array.isArray(sessions) ? sessions : [])
      .filter((row) => copy.isObject(row) && typeof row.id === 'string' && row.id && row.spawned_from && row.spawned_from.parent_session_id === primaryId && !row.archived && !row.archived_at)
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, LINKED_CHAT_OPTIONS)
      .map((row) => ({ id: row.id, title: copy.chatTitle(row.title, true) }));
  }

  // Project and chat names for one paint (a model is built per paint); a chat title is formatted only when asked for.
  const namesByModel = new WeakMap();
  function names(model) {
    if (namesByModel.has(model)) return namesByModel.get(model);
    let rows = null;
    const projects = new Map((model.projects || []).map((project) => [project.id, project.name]));
    const chat = (id) => {
      if (!rows) rows = new Map((Array.isArray(model.sessions) ? model.sessions : []).filter((row) => copy.isObject(row) && typeof row.id === 'string').map((row) => [row.id, row]));
      return rows.has(id) ? copy.chatTitle(rows.get(id).title, true) : jt('chat.primary.rules.unknownChat', 'a chat that no longer exists');
    };
    const out = { project: (id) => projects.get(id) || jt('chat.primary.unknownProject', 'A project that no longer exists'), chat };
    namesByModel.set(model, out);
    return out;
  }

  /** A rule (or a launch permission projected as `launch/allow`) as one plain sentence. */
  function ruleSentence(rule, n) {
    const target = rule.target || {};
    const chats = target.kind === 'linked_children' ? jt('chat.primary.rules.target.linked', 'chats Jenny started')
      : target.kind === 'project' ? jt('chat.primary.rules.target.inProject', 'chats in {project}', { project: n.project(target.id) })
        : target.kind === 'chat' ? n.chat(target.id) : jt('chat.primary.rules.target.any', 'any chat');
    const where = target.kind === 'project' ? jt('chat.primary.rules.where.project', 'in {project}', { project: n.project(target.id) })
      : jt('chat.primary.rules.where.any', 'in every project');
    switch (`${rule.action}/${rule.effect}`) {
      case 'message/allow': return jt('chat.primary.rules.sentence.messageAllow', 'Message {chats} without asking', { chats });
      case 'message/ask': return jt('chat.primary.rules.sentence.messageAsk', 'Always ask before messaging {chats}', { chats });
      case 'message/deny': return jt('chat.primary.rules.sentence.messageDeny', 'Never message {chats}', { chats });
      case 'launch/allow': return jt('chat.primary.rules.sentence.launchAllow', 'Start chats {where} without asking', { where });
      case 'launch/deny': return jt('chat.primary.rules.sentence.launchDeny', 'Never start chats {where}', { where });
      case 'stop/deny': return jt('chat.primary.rules.sentence.stopDeny', 'Never stop {chats}', { chats });
      case 'schedule/deny': return jt('chat.primary.rules.sentence.scheduleDeny', 'Never change scheduled checks');
      default: return jt('chat.primary.rules.sentence.settingDeny', 'Never change settings');
    }
  }

  // Live rules and live launch permissions, one list: by action, then newest first.
  function liveRules(perms) {
    const launch = (Array.isArray(perms.launch) ? perms.launch : []).filter((row) => copy.isObject(row) && !row.revoked_at && typeof row.permission_id === 'string')
      .map((row) => ({
        id: row.permission_id, kind: 'launch', action: 'launch', effect: 'allow', run_modes: row.run_modes, created_at: row.created_at,
        max: Number.isSafeInteger(row.max_children_per_turn) ? row.max_children_per_turn : 1,
        target: row.project_id === '*' ? { kind: 'any' } : { kind: 'project', id: row.project_id },
      }));
    const rules = (Array.isArray(perms.rules) ? perms.rules : []).filter((row) => copy.isObject(row) && !row.revoked_at && RULE_ID.test(row.rule_id))
      .map((row) => ({ ...row, id: row.rule_id, kind: 'rule' }));
    return [...launch, ...rules].sort((a, b) => (ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action))
      || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }

  // The target choices for an action: chats (message, stop), projects (launch) or none (schedule, setting).
  function targetOptions(action, model) {
    const projects = model.projects || [];
    if (action === 'launch') {
      return projects.map((project) => ({ value: `p:${project.id}`, label: jt('chat.primary.rules.where.project', 'in {project}', { project: project.name }) }))
        .concat([{ value: 'any', label: jt('chat.primary.rules.where.any', 'in every project') }]);
    }
    if (action !== 'message' && action !== 'stop') return [];
    return [{ value: 'linked', label: jt('chat.primary.rules.target.linked', 'chats Jenny started') }, { value: 'any', label: jt('chat.primary.rules.target.any', 'any chat') }]
      .concat(projects.map((project) => ({ value: `p:${project.id}`, label: jt('chat.primary.rules.target.inProject', 'chats in {project}', { project: project.name }) })))
      .concat(linkedChats(model.sessions, model.primaryId).map((chat) => ({ value: `c:${chat.id}`, label: chat.title })));
  }

  /** The form as it can be submitted: unknown or stale choices fall back to the first offered one. */
  function settleForm(form, model) {
    const source = { ...DEFAULT_FORM, ...(copy.isObject(form) ? form : {}) };
    const offered = effectActions(model.state && model.state.flags);
    const effects = Object.keys(offered);
    if (!effects.length) return null;
    const effect = effects.includes(source.effect) ? source.effect : effects[0];
    const action = offered[effect].includes(source.action) ? source.action : offered[effect][0];
    const targets = targetOptions(action, model);
    const target = targets.some((option) => option.value === source.target) ? source.target : (targets[0] ? targets[0].value : '');
    return { effect, action, target, auto: source.auto === true, offered, targets };
  }

  function targetOf(value) {
    if (value === 'linked') return { kind: 'linked_children' };
    if (typeof value === 'string' && value.startsWith('p:')) return { kind: 'project', id: value.slice(2) };
    if (typeof value === 'string' && value.startsWith('c:')) return { kind: 'chat', id: value.slice(2) };
    return { kind: 'any' };
  }

  /** `{method, request}` for the bridge: a launch allow is row 76's grantLaunch, everything else addRule. */
  function submission(form) {
    const runModes = form.auto ? ['auto'] : null;
    const target = targetOf(form.target);
    if (form.action === 'launch' && form.effect === 'allow') {
      return { method: 'grantLaunch', request: { schema_version: 1, project_id: target.kind === 'project' ? target.id : '*', run_modes: runModes } };
    }
    return { method: 'addRule', request: { schema_version: 1, action: form.action, target, effect: form.effect, run_modes: runModes } };
  }

  /** Reads the form's current choices from the painted pane into `form` (kept across repaints). */
  function captureForm(host, form) {
    const value = (attr) => { const node = host && host.querySelector(`[${attr}]`); return node ? node.value : undefined; };
    for (const [key, attr] of [['effect', 'data-primary-rule-effect'], ['action', 'data-primary-rule-action'], ['target', 'data-primary-rule-target']]) {
      const current = value(attr);
      if (current !== undefined) form[key] = current;
    }
    const auto = host && host.querySelector('[data-primary-rule-auto]');
    if (auto) form.auto = auto.checked;
    return form;
  }

  function formMarkup(model, ui, n) {
    const form = settleForm(model.form, model);
    if (!form) return '';
    const select = (attr, label, value, options) => ui.selectField({ id: attr, ariaLabel: label, value, options, dataset: { [attr.replace(/^data-/, '')]: '1' } });
    const preview = ruleSentence({ action: form.action, effect: form.effect, target: targetOf(form.target) }, n);
    return '<div class="primary-activity__form">'
      + select('data-primary-rule-effect', jt('chat.primary.rules.effectLabel', 'Rule'), form.effect,
        Object.keys(form.offered).map((value) => ({ value, label: effectLabel(value) })))
      + select('data-primary-rule-action', jt('chat.primary.rules.actionLabel', 'Action'), form.action,
        form.offered[form.effect].map((value) => ({ value, label: actionLabel(value) })))
      + (form.targets.length ? select('data-primary-rule-target', jt('chat.primary.rules.targetLabel', 'Which chats'), form.target, form.targets) : '')
      + ui.checkbox({ id: 'primary-rule-auto', label: jt('chat.primary.permissions.autoOnly', 'only while Jenny is in Auto'), checked: form.auto, dataset: { 'primary-rule-auto': '1' } })
      + ui.actionButton({ variant: 'secondary', size: 'sm', label: jt('chat.primary.rules.add', 'Add rule'), dataset: { 'primary-rule-submit': '1' } })
      + '</div>'
      + `<p class="chat-review__note">${escapeHtml(jt('chat.primary.rules.adds', 'Adds: {rule}', { rule: preview }))}</p>`;
  }

  /** The "Your rules" section of the Permissions pane. `helpers`: { permRow, modesText, whenText, note }. */
  function sectionMarkup(model, ui, helpers) {
    const n = names(model);
    const rows = liveRules(model.perms || {}).map((rule) => {
      const extra = rule.kind === 'launch' ? jtn('chat.primary.perm.children', rule.max, { count: rule.max }, '1 chat per request', '{count} chats per request')
        // 60: PRIMARY_CHAT_LIMITS.rule_message_sends_per_day (services/shell-config-primary-chat.js).
        : rule.action === 'message' && rule.effect === 'allow' ? jt('chat.primary.rules.dailyCap', 'up to 60 a day') : '';
      const meta = [helpers.modesText(rule.run_modes), extra, jt('chat.primary.rules.added', 'added {when}', { when: helpers.whenText(rule.created_at) })].filter(Boolean).join(' · ');
      return helpers.permRow(ruleSentence(rule, n), meta, rule.kind === 'launch' ? 'primary-permission-revoke' : 'primary-rule-revoke', rule.id, rule.id, ui.actionButton,
        jt('chat.primary.rules.remove', 'Remove'));
    }).join('');
    return `<div class="primary-activity__kicker">${escapeHtml(jt('chat.primary.rules.kicker', 'Your rules'))}</div>`
      + (rows || helpers.note(jt('chat.primary.rules.none', 'None. Jenny asks you before it messages, starts or stops other chats.')))
      + formMarkup(model, ui, n)
      + helpers.note(jt('chat.primary.rules.wakeNote', 'A message from another chat, a scheduled check or a digest never uses an "allow" rule; Jenny asks you instead.'));
  }

  const isRuleEntry = (entry) => copy.isObject(entry) && RULE_ENTRY_KINDS.has(entry.kind);

  function entryKindLabel(kind) {
    return kind === 'rule_added' ? jt('chat.primary.kind.rule_added', 'Rule added')
      : kind === 'rule_revoked' ? jt('chat.primary.kind.rule_revoked', 'Rule removed') : jt('chat.primary.kind.rule_denied', 'Rule blocked');
  }

  /** An Activity entry for a rule added, removed, or one that refused an action. */
  function activityEntryMarkup(entry, model, whenText) {
    const title = copy.isObject(entry.rule) ? ruleSentence(entry.rule, names(model)) : jt('chat.primary.rules.goneRule', 'A rule that was removed');
    const status = entry.kind === 'rule_denied'
      ? '<div class="chat-review__status" data-tone="error"><span class="status-dot status-dot--error" aria-hidden="true"></span>'
        + `<span class="chat-review__state">${escapeHtml(jt('chat.primary.rules.refused', 'Refused by your rule'))}</span></div>` : '';
    return `<li class="chat-review__item" data-activity-kind="${escapeHtml(entry.kind)}">`
      + `<div class="chat-review__head"><span class="chat-review__chip primary-activity__kind">${escapeHtml(entryKindLabel(entry.kind))}</span>`
      + ` <strong>${escapeHtml(title)}</strong><span class="chat-review__meta"> · ${escapeHtml(whenText(entry.at))}</span></div>${status}</li>`;
  }

  return {
    DEFAULT_FORM, FOCUS_ATTRS, activityEntryMarkup, captureForm, isRuleEntry, liveRules, ruleSentence, sectionMarkup, settleForm, submission,
  };
});
