/* Owns composer Tools hydration and the focus-preserving chat panel. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-composer-v2-model'), require('../shared/string-utils'));
    return;
  }
  root.rendererComposerToolsSlot = factory(root.rendererComposerV2Model, root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, strings) {
  'use strict';
  const jt = (...args) => (globalThis.jennyI18n?.t || globalThis.jennyI18nFallback || ((key, fallback, params) =>
    params ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) : fallback))(...args);
  const { escapeHtml } = strings;
  const svg = (path, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const sliders = svg('<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>', 14);
  const plug = svg('<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0zm6 9v4"/>');
  const puzzle = svg('<path d="M4 4h6a3 3 0 1 1 6 0h4v6a3 3 0 1 0 0 6v4h-6a3 3 0 1 0-6 0H4v-6a3 3 0 1 1 0-6z"/>');
  function extractToolEntries(list) {
    return (Array.isArray(list) ? list : []).map(model.normalizeToolEntry).filter((entry) => entry.name);
  }

  function createComposerToolsSlot(deps = {}) {
    const { state = {}, windowRef = globalThis, slot = null, controller = null,
      appendClientLog = () => {} } = deps;
    let hydrated = null;
    let signature = null;
    let focusedId = null;
    let serial = 0;
    const mounted = new Map();
    const sections = new Map();
    const panel = slot?.querySelector('#composerChatPanel');
    const chipHost = slot?.querySelector('#composerChatChipHost');
    const chips = slot?.querySelector('#composerChatPanelChips');
    const list = slot?.querySelector('#composerChatPanelList');
    const filter = panel?.querySelector('[data-chat-panel-filter]');
    const rowsFor = (vm) => [...vm.sections.flatMap((section) => section.families), ...vm.connections];
    const iconFor = (row) => row.icon || (row.kind === 'mcp' ? plug : puzzle);
    // Read the run-mode chip's projected mode, as the compact settings summary does.
    const runMode = () => {
      const chip = slot?.ownerDocument.getElementById('composerRunModeChip');
      return chip?.classList.contains('composer-run-mode-plan') ? 'plan'
        : chip?.classList.contains('composer-run-mode-auto') ? 'auto' : 'ask';
    };
    function hydrate(force = false) {
      const id = String(state.currentSessionId || '').trim();
      const active = state.sessions?.find((session) => String(session?.id || '').trim() === id);
      const categories = active?.tool_category_overrides;
      const connections = active?.tool_connection_overrides;
      if (force || !hydrated || hydrated.id !== id || hydrated.categories !== categories || hydrated.connections !== connections) {
        // The panel describes one chat; a session switch closes it on the main view.
        if (hydrated && hydrated.id !== id && panel && !panel.hidden) {
          windowRef.inventory?.popover?.close(panel, { restoreFocus: false });
          view('main', false);
        }
        controller?.hydrateForSession(id, categories, connections);
        hydrated = { id, categories, connections };
      }
      return id;
    }
    function description(row) {
      const base = row.kind === 'mcp' ? jt('composer.chatPanel.mcp', 'MCP · {total} tools', { total: row.total })
        : row.kind ? jt('composer.chatPanel.plugin', 'Plugin · {total} tools', { total: row.total }) : row.description || '';
      return base + (row.approval === 'some' && runMode() === 'ask' ? ' · ' + jt('composer.chatPanel.approval', 'Some actions ask first') : '');
    }
    function reasonFor(row, vm) {
      const reason = row.reason || row.members?.find((member) => !member.usable)?.reason || '';
      if (vm.lockdown && row.state === 'blocked') return { text: jt('composer.chatPanel.offlineReason', 'Offline for this chat') };
      // Exact sidecar reason constants (sidecar/ai/tools/assembly.py); any other reason shows as sent.
      if (reason === 'config disabled') return { text: jt('composer.chatPanel.offSettings', 'Off in Settings'), fix: 'settings', label: jt('composer.chatPanel.turnOn', 'Turn on') };
      if (reason === 'workspace requirement missing') return { text: jt('composer.chatPanel.needsProject', 'Needs a project'), fix: 'project', label: jt('composer.chatPanel.chooseProject', 'Choose project') };
      return { text: reason };
    }
    function element(html) {
      const template = slot.ownerDocument.createElement('template');
      template.innerHTML = html;
      return template.content.firstElementChild;
    }
    function button(label, dataset) {
      return windowRef.inventory.actionButton({ label, plain: true, className: 'composer-chat-link', dataset });
    }
    function mountRow(row, section) {
      const inv = windowRef.inventory;
      const key = 'composer-chat-tool-' + (++serial);
      const chip = element(inv.chip({ pressed: row.state === 'on', label: row.label, iconHtml: iconFor(row), className: 'composer-family-chip' }));
      chip.dataset.toolTarget = row.id;
      const hiddenReason = slot.ownerDocument.createElement('span');
      hiddenReason.className = 'sr-only';
      hiddenReason.id = key + '-blocked';
      chip.appendChild(hiddenReason);
      chips.appendChild(chip);
      const node = element('<div class="composer-tool-row">'
        + '<span class="composer-tools-row-icon" aria-hidden="true">' + iconFor(row) + '</span>'
        + inv.toggleSwitch({ id: 'tool-target:' + row.id, label: row.label, description: description(row) || ' ',
          descriptionId: key + '-description', checked: row.on && row.state !== 'blocked', disabled: row.state === 'blocked' })
        + '<span class="composer-tool-reason"><span></span> ' + button('', { 'tool-fix': 'settings' }) + '</span>'
        + '<span class="composer-tool-partial"></span>'
        + button(jt('composer.chatPanel.showTools', 'Show tools'), { 'chat-panel-expand': row.id })
        + '<ul class="composer-tool-members" id="' + key + '-members" hidden></ul></div>');
      node.dataset.toolTarget = row.id;
      const expand = node.querySelector('[data-chat-panel-expand]');
      expand.setAttribute('aria-expanded', 'false');
      expand.setAttribute('aria-controls', key + '-members');
      section.appendChild(node);
      const entry = { chip, node, hiddenReason, memberSignature: null };
      mounted.set(row.id, entry);
      return entry;
    }
    function patchRow(row, vm, entry) {
      const { chip, node, hiddenReason } = entry;
      const blocked = row.state === 'blocked';
      windowRef.inventory.chip.setPressed(chip, row.state === 'on');
      chip.classList.toggle('composer-family-chip--blocked', blocked);
      const reason = reasonFor(row, vm);
      hiddenReason.textContent = blocked ? reason.text : '';
      if (blocked) {
        chip.removeAttribute('aria-pressed');
        chip.setAttribute('aria-describedby', hiddenReason.id);
      } else chip.removeAttribute('aria-describedby');
      chip.title = blocked ? reason.text : '';
      chip.querySelector('.inv-chip-label').textContent = row.label;
      const track = node.querySelector('[data-inv-toggle]');
      windowRef.inventory.toggleSwitch.setChecked?.(track, row.on && !blocked);
      track.setAttribute('aria-checked', String(row.on && !blocked));
      track.disabled = blocked;
      const wrapper = track.closest('.inv-toggle');
      wrapper.classList.toggle('inv-toggle--on', row.on && !blocked);
      wrapper.classList.toggle('inv-toggle--disabled', blocked);
      for (const target of [wrapper, track]) {
        if (blocked) target.setAttribute('aria-disabled', 'true');
        else target.removeAttribute('aria-disabled');
      }
      node.querySelector('.inv-toggle-label').textContent = row.label;
      node.querySelector('.inv-toggle-description').textContent = description(row);
      const partial = row.usable > 0 && row.usable < row.total;
      const reasonLine = node.querySelector('.composer-tool-reason');
      reasonLine.hidden = !(blocked || partial) || !reason.text;
      reasonLine.firstElementChild.textContent = reason.text;
      const fix = reasonLine.querySelector('[data-tool-fix]');
      fix.hidden = !reason.fix;
      fix.dataset.toolFix = reason.fix || '';
      fix.textContent = reason.fix ? '· ' + reason.label : '';
      const partialLine = node.querySelector('.composer-tool-partial');
      partialLine.hidden = !partial;
      partialLine.textContent = partial ? jt('composer.chatPanel.partial', '{usable} of {total} available', row) : '';
      const expand = node.querySelector('[data-chat-panel-expand]');
      expand.hidden = !row.members?.length;
      const members = node.querySelector('.composer-tool-members');
      const nextMembers = JSON.stringify(row.members || []);
      if (entry.memberSignature !== nextMembers && !members.contains(slot.ownerDocument.activeElement)) {
        members.innerHTML = (row.members || []).map((member) => '<li>' + escapeHtml(member.name)
          + (member.asksFirst ? ' · ' + escapeHtml(jt('composer.chatPanel.asksFirst', 'asks first')) : '') + '</li>').join('');
        entry.memberSignature = nextMembers;
      }
      const query = (filter?.value || '').toLowerCase().trim();
      node.hidden = !!query && ![row.label, ...(row.members || []).map((member) => member.name)].some((text) => text.toLowerCase().includes(query));
    }
    function rove(id = focusedId) {
      const available = [...chips.querySelectorAll('.composer-family-chip')];
      const target = available.find((chip) => chip.dataset.toolTarget === id) || available[0];
      available.forEach((chip) => { chip.tabIndex = chip === target ? 0 : -1; });
      focusedId = target?.dataset.toolTarget || null;
      return target;
    }
    function render() {
      const id = hydrate();
      if (!panel || !controller || !windowRef.inventory?.actionButton) return;
      const vm = controller.getViewModel();
      const next = JSON.stringify({ id, vm, runMode: runMode(), lockdown: vm.lockdown, filter: filter?.value || '' });
      if (signature === next) return;
      const rows = rowsFor(vm);
      let chip = chipHost.querySelector('#composerToolsChip');
      if (!chip && rows.length) {
        chip = element(windowRef.inventory.chip({ id: 'composer-tools', domId: 'composerToolsChip', iconHtml: sliders,
          label: ' ', hasPopup: true, ariaControls: 'composerChatPanel', className: 'composer-tools-chip' }));
        chipHost.appendChild(chip);
      }
      if (chip) {
        const count = controller.getToolsChipCount().on;
        chip.querySelector('.inv-chip-label').textContent = vm.lockdown ? jt('composer.chatPanel.offline', 'Offline') : jt('composer.chatPanel.toolsCount', '{count} tools', { count });
        chip.setAttribute('aria-label', jt('composer.chatPanel.chipLabel', 'Tools for this chat: {count} on', { count }));
      }
      const groups = [...vm.sections.map((section) => ({ id: section.id, rows: section.families })), { id: 'connections', rows: vm.connections }];
      const labels = { project: jt('composer.chatPanel.inProject', 'In this project'), create: jt('composer.chatPanel.create', 'Create'), reach: jt('composer.chatPanel.reach', 'Reach'), connections: jt('composer.chatPanel.connections', 'Connections') };
      let deferred = false;
      for (const group of groups) {
        let section = sections.get(group.id);
        if (!section && group.rows.length) {
          section = element('<section><div class="composer-chat-section-label">' + escapeHtml(labels[group.id]) + '</div></section>');
          sections.set(group.id, section);
          list.appendChild(section);
        }
        for (const [index, row] of group.rows.entries()) {
          const entry = mounted.get(row.id) || mountRow(row, section);
          patchRow(row, vm, entry);
          if (section.children[index + 1] !== entry.node) {
            if (entry.node.contains(slot.ownerDocument.activeElement)) deferred = true;
            else section.insertBefore(entry.node, section.children[index + 1] || null);
          }
        }
      }
      const ids = new Set(rows.map((row) => row.id));
      for (const [id, entry] of mounted) {
        if (ids.has(id)) continue;
        if ([entry.chip, entry.node].some((node) => node.contains(slot.ownerDocument.activeElement))) { deferred = true; continue; }
        entry.chip.remove(); entry.node.remove(); mounted.delete(id);
      }
      // Insert only out-of-order nodes, preserving existing focused controls.
      rows.forEach((row, index) => {
        const chip = mounted.get(row.id).chip;
        const current = chips.children[index];
        if (current !== chip) {
          if (chip.contains(slot.ownerDocument.activeElement)) deferred = true;
          else chips.insertBefore(chip, current || null);
        }
      });
      groups.filter((group) => sections.has(group.id)).forEach((group, index) => {
        const section = sections.get(group.id);
        if (list.children[index] !== section) {
          if (section.contains(slot.ownerDocument.activeElement)) deferred = true;
          else list.insertBefore(section, list.children[index] || null);
        }
      });
      for (const section of sections.values()) section.hidden = ![...section.querySelectorAll('.composer-tool-row')].some((node) => !node.hidden);
      if (filter) filter.hidden = rows.length <= 12;
      panel.querySelector('[data-chat-panel-action="reset"]').hidden = !vm.hasOverrides;
      rove();
      signature = deferred ? null : next;
    }
    function view(name, focus = true) {
      panel.querySelectorAll('[data-chat-panel-view]').forEach((node) => { node.hidden = node.dataset.chatPanelView !== name; });
      if (focus) panel.querySelector(name === 'all' ? '[data-chat-panel-action="back"]' : '[data-chat-panel-action="all-tools"]')?.focus();
    }
    function settle(persistence) {
      render();
      Promise.resolve(persistence).then(render, (error) => appendClientLog('WARN', 'composer.tool_toggle_failed', { message: error.message || String(error) }));
      return persistence;
    }
    function handleToggleChange(event) {
      hydrate();
      const id = String(event?.detail?.id || '');
      if (!id.startsWith('tool-target:') || !controller) return;
      return settle(controller.setToggle(id.slice(12), event.detail.checked === true));
    }
    function clickFamily(id) {
      hydrate();
      const row = rowsFor(controller.getViewModel()).find((row) => row.id === id);
      if (!row) return;
      if (row.state === 'blocked') {
        if (filter) filter.value = '';
        render(); view('all');
        mounted.get(id)?.node.scrollIntoView?.({ block: 'nearest' });
        return;
      }
      return settle(controller.setToggle(id, !row.on));
    }
    if (panel) panel.__jennyChatPanel = {
      view, clickFamily, render,
      reset: () => {
        hydrate();
        const done = settle(controller.resetToDefaults());
        // Reset hides its own button, so focus moves to the family chips instead of the body.
        rove()?.focus();
        return done;
      },
      focusChips: () => { view('main', false); rove()?.focus(); },
      rove: (event) => {
        const chip = event.target.closest('.composer-family-chip');
        if (!chip) return;
        const items = [...chips.querySelectorAll('.composer-family-chip')];
        const index = items.indexOf(chip);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + items.length) % items.length;
        event.preventDefault(); rove(items[next].dataset.toolTarget)?.focus();
      },
      remember: (chip) => rove(chip.dataset.toolTarget),
    };
    async function refresh() {
      if (!controller || !windowRef.jennyShell?.tools?.list) return;
      try {
        const list = await windowRef.jennyShell.tools.list();
        controller.setAvailableTools(extractToolEntries(list));
        controller.hydrateFromToolSettings(state.features?.tools);
        hydrate(true); render();
      } catch (error) {
        appendClientLog('WARN', 'composer.tool_toggles_refresh_failed', { message: error.message || String(error) });
      }
    }
    function getToolPreferences() {
      hydrate();
      return controller?.getToggleStates() || { families: {}, connections: {} };
    }
    return { render, refresh, handleToggleChange, getToolPreferences, extractToolEntries };
  }
  return { createComposerToolsSlot, extractToolEntries };
});
