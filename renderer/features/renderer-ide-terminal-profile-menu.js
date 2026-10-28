/* renderer/features/renderer-ide-terminal-profile-menu.js - the Workspace terminal's
 * shell-profile menus (row 82 slice T2, plan docs/plans/IDE_VSCODE_PARITY_2026-10-26.md
 * section 7.5): the New Terminal split-button's launch menu (one row per shell that
 * workspacePty.listProfiles detected, the effective default marked, then "Select Default
 * Profile...") and the default picker that writes the terminalDefaultProfile preference.
 *
 * The renderer only ever names a profile id; main maps the id to an executable. A pick
 * starts a terminal because the user clicked it (the consent posture is unchanged: nothing
 * spawns on open). Without the listProfiles bridge (hosted mode) isAvailable() is false
 * and every opener returns false. Menus go through the inventory context-menu. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTerminalProfileMenu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // The ids workspace-pty-profiles.js emits (the shared pref rule).
  const PROFILE_ID_RE = /^[a-z0-9-]{1,32}$/;
  const LABEL_MAX = 64;
  const PROFILES_MAX = 16;

  function noop() {}

  function resolveContextMenu(injected) {
    if (injected && typeof injected.show === 'function') return injected;
    if (globalThis.inventoryContextMenu) return globalThis.inventoryContextMenu;
    if (typeof require === 'function') {
      try { return require('../inventory/context-menu'); } catch (_error) { /* unavailable */ }
    }
    return null;
  }

  // A listProfiles reply -> { profiles: [{ id, label }], defaultId }; anything malformed drops.
  function normalizeProfiles(result) {
    const list = result && result.ok !== false && Array.isArray(result.profiles) ? result.profiles : [];
    const seen = new Set();
    const profiles = [];
    for (const raw of list.slice(0, PROFILES_MAX)) {
      const id = String(raw && raw.id || '');
      if (!PROFILE_ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      const label = String(raw.label || id).slice(0, LABEL_MAX);
      profiles.push({ id, label });
    }
    const defaultId = String(result && result.defaultId || '');
    return { profiles, defaultId: seen.has(defaultId) ? defaultId : '' };
  }

  /**
   * @param {object} deps
   * @param {() => object|null} deps.getApi workspacePty bridge (listProfiles)
   * @param {() => object} deps.getIde reads terminalDefaultProfile
   * @param {(key: string, value: string) => Promise|any} [deps.commitPreference]
   * @param {(opts: object) => string|null} deps.newTerminal the terminal set's newTerminal
   * @param {() => Element|null} [deps.getRootEl] the menu's owner document root
   * @param {(el: Element) => Element|null} [deps.reanchor] the live anchor for a detached one
   * @param {object} [deps.contextMenu] inventory context-menu (injectable for tests)
   */
  function createIdeTerminalProfileMenu(deps) {
    const d = deps || {};
    const getApi = typeof d.getApi === 'function' ? d.getApi : () => null;
    const getIde = typeof d.getIde === 'function' ? d.getIde : () => ({});
    const newTerminal = typeof d.newTerminal === 'function' ? d.newTerminal : () => null;
    const getRootEl = typeof d.getRootEl === 'function' ? d.getRootEl : () => null;
    const logError = typeof d.logError === 'function' ? d.logError : noop;
    const reanchor = typeof d.reanchor === 'function' ? (el) => d.reanchor(el) || el : (el) => el;
    const contextMenu = resolveContextMenu(d.contextMenu);

    function isAvailable() {
      const api = getApi();
      return Boolean(contextMenu) && typeof api?.listProfiles === 'function';
    }

    async function loadProfiles() {
      try {
        return normalizeProfiles(await getApi().listProfiles());
      } catch (error) {
        logError('WARN', 'ide.terminal_profiles_failed', { message: String(error?.message || error) });
        return normalizeProfiles(null);
      }
    }

    function storedDefault() {
      const id = String(getIde()?.terminalDefaultProfile || '');
      return PROFILE_ID_RE.test(id) ? id : '';
    }

    // The shell a plain New Terminal starts: the stored pick when it is detected, else main's default.
    function effectiveDefault(listing) {
      const stored = storedDefault();
      return stored && listing.profiles.some((p) => p.id === stored) ? stored : listing.defaultId;
    }

    function show(anchorEl, items, ariaLabel, extra) {
      contextMenu.show(Object.assign({ rootEl: getRootEl() || undefined, anchorEl, items, ariaLabel }, extra || {}));
      return true;
    }

    function emptyRow() {
      return { label: jt('ide.terminal.noProfiles', 'No shells were found on this computer'), disabled: true, action: noop };
    }

    async function openLaunchMenu(anchorEl, near) {
      if (!anchorEl || !isAvailable()) return false;
      const listing = await loadProfiles();
      const def = effectiveDefault(listing);
      const rows = listing.profiles.map((profile) => ({
        label: profile.label,
        description: profile.id === def ? jt('ide.terminal.profileDefault', 'Default') : '',
        value: profile.id,
        action: () => { newTerminal({ start: true, profileId: profile.id, near: near || '' }); },
      }));
      const items = rows.length ? rows : [emptyRow()];
      if (rows.length && typeof d.commitPreference === 'function') {
        items.push({ separator: true }, {
          label: jt('ide.terminal.selectDefaultProfile', 'Select Default Profile...'),
          // A re-render may have replaced the header button meanwhile: anchor on the live one.
          action: () => { openDefaultMenu(reanchor(anchorEl), listing).catch(noop); },
        });
      }
      return show(anchorEl, items, jt('ide.terminal.launchProfile', 'Launch Profile'));
    }

    // Radio rows over the detected shells; "Automatic" clears the stored pick.
    async function openDefaultMenu(anchorEl, known) {
      if (!anchorEl || !isAvailable() || typeof d.commitPreference !== 'function') return false;
      const listing = known || await loadProfiles();
      const stored = storedDefault();
      const auto = listing.profiles.find((p) => p.id === listing.defaultId);
      const commit = (id) => {
        Promise.resolve(d.commitPreference('terminalDefaultProfile', id)).catch((error) => logError('WARN', 'ide.terminal_default_profile_failed', { message: String(error?.message || error) }));
      };
      const items = [{
        label: auto ? jt('ide.terminal.profileAutomaticNamed', 'Automatic ({name})', { name: auto.label }) : jt('ide.terminal.profileAutomatic', 'Automatic'),
        checked: stored === '' || !listing.profiles.some((p) => p.id === stored),
        action: () => commit(''),
      }].concat(listing.profiles.map((profile) => ({
        label: profile.label,
        checked: profile.id === stored,
        value: profile.id,
        action: () => commit(profile.id),
      })));
      return show(anchorEl, items, jt('ide.terminal.selectDefaultProfileLabel', 'Default terminal profile'), {
        heading: jt('ide.terminal.selectDefaultProfileHeading', 'New terminals start with'),
        focusChecked: true,
      });
    }

    return { isAvailable, openLaunchMenu, openDefaultMenu };
  }

  return { createIdeTerminalProfileMenu, normalizeProfiles };
});
