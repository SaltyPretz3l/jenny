/* Settings > Models > Model roles (row 194): which model does which job. Loaded on first use. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.rendererSettingsModelRoles = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback
    || ((key, fallback, params) => (params ? String(fallback).replace(/\{(\w+)\}/g, (m, n) => (Object.hasOwn(params, n) ? String(params[n]) : m)) : fallback));
  const tryRequire = (path) => { try { return typeof require === 'function' ? require(path) : null; } catch (_error) { return null; } };
  const MARK = '\u0001';
  const HELP = 'Help'; // id suffix, not copy
  const PROVIDERS = ['chatgpt', 'codex-cli', 'api-provider'];
  const providerLabel = (id) => (id === 'chatgpt' ? jt('settings.subagents.chatgpt', 'ChatGPT')
    : id === 'codex-cli' ? jt('settings.subagents.codexCli', 'Codex CLI') : jt('settings.subagents.apiProvider', 'API providers'));

  function createModelRolesBlock(options = {}) {
    const state = options.state || {};
    const win = options.windowRef || globalThis;
    const doc = options.documentRef || win.document;
    const inv = win.inventory || {};
    const utils = win.rendererComposerModelPickerUtils || tryRequire('../chat/renderer-composer-model-picker-utils');
    const settingsField = inv.settingsField || tryRequire('../inventory/settings-field');
    const selectField = inv.selectField || tryRequire('../inventory/select-field');
    const actionButton = inv.actionButton || tryRequire('../inventory/action-button');
    const escapeHtml = (win.stringUtils || tryRequire('../shared/string-utils') || {}).escapeHtml || String;
    const canon = (win.rendererModelLibraryFormatUtils || tryRequire('./renderer-model-library-format-utils') || {}).canonicalOllamaTag
      || ((value) => String(value || '').trim().toLowerCase());
    if (!doc || !utils || typeof settingsField !== 'function' || typeof selectField !== 'function' || typeof actionButton !== 'function') return null;
    let list = null;
    let store = null;
    let off = null;
    let structure = '';
    let disposed = false;

    const name = (id) => utils.displayModelId(id);
    const features = () => state.features || {};
    const toolsOff = () => features().tools?.subagents === false || features().availability?.tools?.subagents?.enabled === false;
    const strong = (html, value) => html.replace(MARK, `<strong>${escapeHtml(value)}</strong>`);
    const line = (text, value) => ({ html: strong(escapeHtml(text), value) });
    const link = (section, label) => actionButton({ plain: true, className: 'settings-row-link', label, dataset: { 'open-settings-section': section } });

    function group(label, items) { return items.length ? [{ label, options: items }] : []; }

    function compute() {
      const data = Array.isArray(state.modelList?.data) ? state.modelList.data : [];
      const entries = data.map((raw) => {
        const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
        const engineType = raw?.engine_type || raw?.engineType || '';
        return id ? { id, engineType, parameterSize: raw.parameter_size || raw.parameterSize || '', cloud: Boolean(utils.resolveCloudProvider(id, engineType, data)), team: utils.isTeamModel(raw) } : null;
      }).filter(Boolean);
      // Row 201 C1 / OD-1: a team model runs on a teammate's GPU: no role here offers one.
      const isTeam = (id) => utils.isTeamModel(id);
      const listed = entries.filter((entry) => !entry.team);
      const isCloud = (id) => Boolean(id) && (entries.find((entry) => entry.id === id)?.cloud ?? Boolean(utils.resolveCloudProvider(id, '', data)));
      const snap = store?.getSnapshot?.() || {};
      const ready = snap.status === 'ready';
      const unavailable = { html: escapeHtml(jt('settings.chat.models.unavailable', 'Available when the Jenny chat is on.')) };
      const own = String((state.sessions || []).find((session) => session?.id === snap.session_id)?.preferred_model || '').trim();
      const fallbackId = String(utils.resolveDefaultChatModel(state).model || '').trim();
      const fallback = isTeam(fallbackId) ? '' : fallbackId;
      const preferred = isTeam(state.offline?.preferredLocalModel) ? '' : String(state.offline?.preferredLocalModel || '').trim(); // a saved team default reads as unset
      const loadedId = String(state.status?.model || state.modelList?.active_model || '').trim();
      const loaded = isTeam(loadedId) ? '' : loadedId;
      const checkId = [snap.check_model, snap.model, own].find((id) => id && !isTeam(id)) || fallback; // a team pin is never a check model
      // A saved value the list does not offer stays visible, so a row never shows the wrong value; a saved team id shows disabled.
      const withCurrent = (items, current) => (current && !listed.some((entry) => entry.id === current)
        ? items.concat([{ value: current, label: name(current), ...(isTeam(current) ? { disabled: true } : {}) }]) : items);
      const choices = (first, current, small) => {
        const item = (entry) => {
          const tooSmall = small && !utils.classifyCheckModel({ model: entry.id, engineType: entry.engineType, parameterSize: entry.parameterSize }).fit;
          return { value: entry.id, label: tooSmall ? jt('settings.chat.models.check.tooSmall', '{model} · under 7B, too small for checks', { model: name(entry.id) }) : name(entry.id), disabled: tooSmall };
        };
        const local = listed.filter((entry) => !entry.cloud).map(item);
        const cloud = listed.filter((entry) => entry.cloud).map(item);
        return withCurrent([{ value: '', label: first }, ...group(jt('settings.roles.group.local', 'On this PC'), local), ...group(jt('settings.roles.group.cloud', 'Cloud · leaves this PC'), cloud)], current);
      };
      const value = preferred || (isCloud(loaded) ? '' : loaded); // the default is never a cloud model
      const defaultItems = withCurrent(listed.filter((entry) => !entry.cloud).map((entry) => ({ value: entry.id, label: name(entry.id) })), value);
      const rows = [{
        id: 'modelRoleDefault', key: 'default', label: jt('settings.roles.default.label', 'New chats'),
        help: jt('settings.roles.default.help', 'The model a chat set to Default runs on. Always a model on this PC.'),
        options: value ? defaultItems : [{ value: '', label: jt('settings.roles.default.none', 'No model chosen'), disabled: true }, ...defaultItems], value,
        line: !value ? { html: '' } : canon(loaded) === canon(value) ? line(jt('settings.roles.default.loaded', '{model} is loaded now.', { model: MARK }), name(value))
          : line(jt('settings.roles.default.later', 'Jenny loads {model} with the next message in a Default chat.', { model: MARK }), name(value)),
      }, {
        id: 'modelRoleJenny', key: 'jenny', label: jt('settings.roles.jenny.label', "Jenny's own chat"),
        help: jt('settings.roles.jenny.help', 'The model the Jenny chat always uses, whatever other chats use.'),
        options: choices(jt('settings.chat.models.jenny.first', "Follow the chat's picker"), snap.model), value: String(snap.model || ''), unavailable: !ready,
        line: !ready ? unavailable : snap.model ? line(jt('settings.roles.jenny.pinned', 'Every Jenny chat turn runs on {model}.', { model: MARK }), name(snap.model))
          : !own && fallback ? line(jt('settings.roles.jenny.follows', 'Now: {model}, your default.', { model: MARK }), name(fallback)) : { html: '' },
      }, {
        id: 'modelRoleCheck', key: 'check', label: jt('settings.roles.check.label', 'Scheduled checks'),
        help: jt('settings.roles.check.help', "A check that comes due loads this model and runs on it. Models under 7B can't run checks."),
        options: choices(jt('settings.chat.models.check.first', "Same as Jenny's model"), snap.check_model, true), value: String(snap.check_model || ''), unavailable: !ready,
        line: !ready ? unavailable : !checkId ? { html: '' }
          : utils.classifyCheckModel({ model: checkId, engineType: entries.find((entry) => entry.id === checkId)?.engineType, parameterSize: entries.find((entry) => entry.id === checkId)?.parameterSize }).fit
            ? line(jt('settings.chat.models.check.runsOn', 'Checks run on {model}.', { model: MARK }), name(checkId))
            : { ...line(jt('settings.chat.models.check.willWait', 'Checks will wait: {model}. Pick a bigger model here or above.', { model: MARK }), jt('settings.chat.models.check.underFloor', '{model} is under 7B', { model: name(checkId) })), warn: true },
      }];
      const helpers = PROVIDERS.filter((id) => features().subagentModelCatalogs?.[id]?.models?.length || features().subagentRouting?.[id]?.defaultModel);
      helpers.forEach((id) => {
        const models = (features().subagentModelCatalogs?.[id]?.models || []).slice(0, 128);
        const current = String(features().subagentRouting?.[id]?.defaultModel || '');
        const items = models.map((model) => ({ value: model.id, label: model.label || model.id, disabled: model.available === false }));
        rows.push({
          id: `modelRoleHelper-${id}`, key: `helper:${id}`, label: jt('settings.roles.helper.label', 'Helpers under {provider} chats', { provider: providerLabel(id) }),
          help: jt('settings.roles.helper.help', 'The model a {provider} chat hands side work to.', { provider: providerLabel(id) }),
          options: [{ value: '', label: jt('settings.roles.helper.first', 'Same model as the chat') }, ...(current && !models.some((model) => model.id === current) ? [{ value: current, label: current }] : []), ...items],
          value: current, unavailable: toolsOff(),
          line: toolsOff() ? { html: escapeHtml(jt('settings.roles.helper.off', 'Subagents are off in Tools, so helpers do not run.')) }
            : { html: `${escapeHtml(jt('settings.roles.helper.limits', 'Effort limits and allowed models stay in'))} ${link('tools', jt('settings.roles.helper.limitsLink', 'Tools › Subagents'))}.` },
        });
      });
      const cloudRoles = [];
      if (isCloud(snap.model)) cloudRoles.push(rows[1].label);
      if (isCloud(checkId)) cloudRoles.push(rows[2].label);
      helpers.forEach((id, index) => cloudRoles.push(rows[3 + index].label));
      const summary = !cloudRoles.length ? jt('settings.roles.summary.none', 'Every model Jenny may load or call on her own. None of these uses a cloud model.')
        : cloudRoles.length === 1 ? jt('settings.roles.summary.one', 'Every model Jenny may load or call on her own. {n} of these uses a cloud model: {roles}.', { n: 1, roles: cloudRoles[0] })
          : jt('settings.roles.summary.many', 'Every model Jenny may load or call on her own. {n} of these use a cloud model: {roles}.', { n: cloudRoles.length, roles: cloudRoles.join(', ') });
      // A team model saved before this rule stays named, so the line above does not claim nothing leaves this PC.
      const teamRoles = [];
      if (isTeam(snap.model)) teamRoles.push(rows[1].label);
      if (isTeam(snap.check_model)) teamRoles.push(rows[2].label);
      const teamNote = teamRoles.length ? ' ' + jt('settings.roles.summary.team', '{roles} runs on a team model, on a teammate’s GPU.', { roles: teamRoles.join(', ') }) : '';
      return { rows, summary: summary + teamNote };
    }

    // The group goes in before "Engines and providers", built here so the page markup needs no host.
    function ensureList() {
      if (list && list.isConnected) return list;
      let rolesGroup = doc.getElementById('modelRolesGroup');
      if (!rolesGroup) {
        const anchor = doc.getElementById('modelServicesHeading')?.closest('.settings-group');
        const card = doc.querySelector('.settings-card[data-settings-section="models"]');
        if (!anchor && !card) return null;
        rolesGroup = doc.createElement('div');
        rolesGroup.className = 'settings-group settings-group--wide';
        rolesGroup.id = 'modelRolesGroup';
        rolesGroup.setAttribute('role', 'group');
        rolesGroup.setAttribute('aria-labelledby', 'modelRolesHeading');
        rolesGroup.innerHTML = `<h4 class="settings-group-heading" id="modelRolesHeading" tabindex="-1">${escapeHtml(jt('settings.roles.heading', 'Model roles'))}</h4>`
          + '<p class="settings-note model-roles-summary" id="modelRolesSummary"></p><div class="settings-toggle-list" id="modelRolesList"></div>';
        if (anchor) anchor.before(rolesGroup); else card.append(rolesGroup);
        rolesGroup.addEventListener('change', onChange);
        rolesGroup.addEventListener('click', onClick);
      }
      list = rolesGroup.querySelector('#modelRolesList');
      return list;
    }

    function render() {
      if (disposed || !ensureList()) return;
      const nextStore = options.store !== undefined ? options.store : (win.rendererPrimaryChatStore?.peekDefaultPrimaryChatStore?.() || null);
      if (nextStore !== store) { off?.(); store = nextStore; off = store?.subscribe?.(render) || null; }
      const { rows, summary } = compute();
      doc.getElementById('modelRolesSummary').textContent = summary;
      const signature = JSON.stringify(rows.map((row) => [row.id, row.label, row.help]));
      if (signature !== structure) {
        structure = signature;
        list.innerHTML = rows.map((row) => settingsField({ id: `${row.id}Row`, variant: 'row', label: row.label, help: row.help, helpId: row.id + HELP,
          controlHtml: selectField({ id: `${row.id}Select`, ariaLabel: row.label, describedBy: row.id + HELP, dataset: { 'model-role': row.key }, options: [] }) })).join('');
        rows.forEach((row) => {
          const effective = doc.createElement('p');
          effective.className = 'settings-field-effective';
          effective.id = `${row.id}Effective`;
          list.querySelector(`[data-settings-field="${row.id}Row"] .settings-field-text`)?.append(effective);
        });
      }
      rows.forEach((row) => {
        const select = list.querySelector(`#${row.id}Select`);
        const field = list.querySelector(`[data-settings-field="${row.id}Row"]`);
        const effective = list.querySelector(`#${row.id}Effective`);
        if (!select || !field || !effective) return;
        const optionSignature = JSON.stringify([row.options, row.value]);
        if (select.dataset.signature !== optionSignature) {
          select.innerHTML = selectField.optionsMarkup(row.options, row.value);
          select.value = row.value;
          select.dataset.signature = optionSignature;
          select.dataset.previous = row.value;
        }
        select.disabled = row.unavailable === true;
        field.classList.toggle('settings-field--unavailable', row.unavailable === true);
        if (effective.dataset.html !== row.line.html) { effective.innerHTML = row.line.html; effective.dataset.html = row.line.html; }
        effective.classList.toggle('settings-field-effective--warn', row.line.warn === true);
      });
    }

    async function persist(key, value) {
      try {
        if (key === 'default') {
          const payload = await win.jennyShell?.offline?.updateSettings?.({ preferredLocalModel: value });
          if (canon(payload?.preferredLocalModel) !== canon(value)) return false;
          state.offline = Object.assign({}, state.offline || {}, payload);
          options.onDefaultChange?.();
          return true;
        }
        if (key === 'jenny' || key === 'check') return (await store?.setModels?.({ [key === 'jenny' ? 'model' : 'check_model']: value }))?.ok === true;
        const provider = key.slice('helper:'.length);
        const payload = await win.jennyShell?.features?.updateSettings?.({ subagentRouting: { [provider]: { defaultModel: value } } });
        if (payload?.subagentRouting?.[provider]?.defaultModel !== value) return false;
        state.features = { ...features(), subagentRouting: payload.subagentRouting, subagentModelCatalogs: payload.subagentModelCatalogs || features().subagentModelCatalogs };
        return true;
      } catch (_error) { return false; }
    }

    async function onChange(event) {
      const select = event.target;
      const key = select?.dataset?.modelRole;
      if (!key) return;
      const saved = await persist(key, select.value);
      if (disposed) return;
      if (saved) select.dataset.previous = select.value; else select.value = select.dataset.previous || '';
      settingsField.setFieldError(select.closest('.settings-field'), saved ? '' : jt('settings.chat.models.saveFailed', 'Could not save this choice. Try again.'));
      render();
    }

    function onClick(event) {
      const target = event.target?.closest?.('[data-open-settings-section]');
      if (target) doc.getElementById(`settingsNav-${target.getAttribute('data-open-settings-section')}`)?.click();
    }

    function dispose() {
      disposed = true;
      off?.();
      off = null;
    }

    return { render, dispose };
  }

  return { createModelRolesBlock };
});
