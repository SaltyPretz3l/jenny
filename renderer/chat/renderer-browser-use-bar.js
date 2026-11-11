/* renderer/chat/renderer-browser-use-bar.js - the browser panel's controls (row 117): back, forward, reload, the
 * address, and the More and site-info panels. Everything here is a person's own action, so none of it asks; the
 * main process still applies the hard refusals. Loaded lazily with the rest of the panel.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-browser-use-status'), require('../inventory/toggle-switch'));
    return;
  }
  root.rendererBrowserUseBar = factory(root.rendererBrowserUseStatus, root.inventoryToggleSwitch);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (statusModule, toggleModule) {
  'use strict';

  const jt = (...args) => (globalThis.jennyI18n?.t || globalThis.jennyI18nFallback || ((key, fallback, params) =>
    params ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) : fallback))(...args);

  const stroke = (body) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = Object.freeze({
    back: stroke('<path d="M9.5 3.5 5 8l4.5 4.5"/>'),
    forward: stroke('<path d="M6.5 3.5 11 8l-4.5 4.5"/>'),
    reload: stroke('<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/>'),
    stop: stroke('<path d="M4 4l8 8M12 4l-8 8"/>'),
    lock: stroke('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
    open: stroke('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1"/>'),
    more: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>',
  });

  function escapeText(value) {
    return String(value ?? '').replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
  }

  const adNote = (on) => (on
    ? jt('browserUse.more.blockAdsOnNote', 'Also presses Skip on video ads. If a site breaks, turn this off.')
    : jt('browserUse.more.blockAdsOffNote', 'Off for this chat. The page reloaded.'));

  function createBrowserUseBar({ windowRef, element }) {
    const inventory = () => windowRef.inventory;
    let bar = null;
    let moreButton = null;
    let editing = false;

    const iconButton = (action, label, icon, extra = '') => inventory().actionButton({
      plain: true, className: `artifact-panel-icon-btn ${extra}`.trim(), ariaLabel: label, title: label, trustedHtml: icon, dataset: { 'browser-use-action': action },
    });

    function mount(panelEl) {
      const actions = panelEl.querySelector('.artifact-panel-header-actions');
      if (!actions) return;
      if (!bar?.isConnected) {
        editing = false;
        bar = element(`<div class="bu-bar">${iconButton('nav-back', jt('browserUse.bar.back', 'Back'), ICONS.back)}${iconButton('nav-forward', jt('browserUse.bar.forward', 'Forward'), ICONS.forward)}${iconButton('nav-reload', jt('browserUse.bar.reload', 'Reload'), ICONS.reload)}<div class="bu-address">${inventory().actionButton({ plain: true, className: 'bu-lock', ariaLabel: jt('browserUse.bar.about', 'About this page'), title: jt('browserUse.bar.about', 'About this page'), trustedHtml: ICONS.lock, dataset: { 'browser-use-action': 'site-info' } })}<span class="bu-url" data-browser-use-action="edit-address"><b></b><span></span></span>${windowRef.inventoryUrlField({ ariaLabel: jt('browserUse.bar.address', 'Address'), placeholder: jt('browserUse.bar.addressHint', 'Type an address'), className: 'bu-address-field' })}</div></div>`);
        actions.parentElement.insertBefore(bar, actions); // beside the title slot, which the rail rewrites at will
      }
      if (!moreButton?.isConnected) {
        moreButton = element(iconButton('more', jt('browserUse.bar.more', 'More'), ICONS.more, 'bu-more'));
        actions.insertBefore(moreButton, actions.querySelector('#artifactReviewCollapseButton'));
      }
      setEditing(false);
    }

    function unmount() {
      bar?.remove();
      moreButton?.remove();
      bar = null;
      moreButton = null;
      editing = false;
    }

    const field = () => bar?.querySelector('input') || null;
    const fieldShell = () => bar?.querySelector('.bu-address-field') || null;

    function setEditing(next) {
      editing = next;
      bar?.querySelector('.bu-url')?.classList.toggle('hidden', next);
      bar?.querySelector('.bu-lock')?.classList.toggle('hidden', next);
      fieldShell()?.classList.toggle('hidden', !next);
    }

    function setButton(action, disabled, label, icon) {
      const button = bar?.querySelector(`[data-browser-use-action="${action}"]`);
      if (!button) return;
      button.disabled = disabled;
      if (!label) return;
      button.setAttribute('aria-label', label);
      button.title = label;
      if (button.dataset.icon !== icon) {
        button.innerHTML = ICONS[icon];
        button.dataset.icon = icon;
      }
    }

    function shownAddress(page, lastUrl) {
      if (page?.failed) return page.failed;
      if (page?.pending_url) return page.pending_url;
      if (page?.busy && page.action === 'navigate' && page.target) return `https://${page.target}/`;
      return page?.url || (page?.open ? '' : lastUrl || '');
    }

    function sync(page, lastUrl) {
      if (!bar) return;
      syncAdRow(page);
      const open = page?.open === true;
      const loading = open && page.loading === true;
      setButton('nav-back', !open || page.can_back !== true);
      setButton('nav-forward', !open || page.can_forward !== true);
      if (loading) setButton('nav-reload', false, jt('browserUse.bar.stop', 'Stop loading'), 'stop');
      else setButton('nav-reload', !open, jt('browserUse.bar.reload', 'Reload'), 'reload');
      if (editing) return;
      const parts = statusModule.addressParts(shownAddress(page, lastUrl));
      const lock = bar.querySelector('.bu-lock');
      const glyph = parts.secure ? 'lock' : 'open';
      if (lock.dataset.glyph !== glyph) {
        lock.innerHTML = ICONS[glyph];
        lock.dataset.glyph = glyph;
      }
      lock.dataset.insecure = String(!parts.secure);
      lock.hidden = !parts.host;
      const [host, rest] = bar.querySelectorAll('.bu-url > *');
      host.textContent = parts.host || jt('browserUse.bar.addressHint', 'Type an address');
      host.dataset.empty = String(!parts.host);
      rest.textContent = parts.rest;
      bar.querySelector('.bu-url').title = parts.full;
      if (parts.full) bar.dataset.address = parts.full; else delete bar.dataset.address;
    }

    // The More popover stays open, so its row follows the page in place (a re-render would drop focus).
    function syncAdRow(page) {
      const menu = bar.ownerDocument.querySelector('.bu-pop-more');
      const track = menu?.querySelector('.bu-menu-switch [role="switch"]');
      if (!track) return;
      const on = page?.ad_block !== false;
      toggleModule?.setChecked?.(track, on);
      const note = menu.querySelector('.bu-menu-note');
      if (note) note.textContent = adNote(on);
    }

    function startEditing() {
      if (!bar) return;
      setEditing(true);
      const input = field();
      if (!input) return;
      input.value = bar.dataset.address || '';
      input.focus();
      input.select();
    }

    const stopEditing = () => setEditing(false);
    const typedAddress = () => field()?.value || '';

    return { mount, unmount, sync, startEditing, stopEditing, typedAddress, field, isEditing: () => editing, moreButton: () => moreButton, lockButton: () => bar?.querySelector('.bu-lock') || null };
  }

  function moreHtml(page, button) {
    const zoom = Math.round((Number(page?.zoom) || 1) * 100);
    const renderSwitch = toggleModule?.toggleSwitch;
    const adsOn = page?.ad_block !== false;
    const ads = renderSwitch
      ? `<div class="bu-menu-switch" data-browser-use-action="toggle-ads"><span id="buAdLabel">${escapeText(jt('browserUse.more.blockAds', 'Block ads'))}</span>${renderSwitch({ bare: true, checked: adsOn, labelledBy: 'buAdLabel' })}</div><p class="bu-menu-note">${escapeText(adNote(adsOn))}</p>`
      : '';
    return `${button('open-find', `<span>${escapeText(jt('browserUse.more.find', 'Find in page'))}</span><kbd>${escapeText(jt('browserUse.more.findKey', 'Ctrl F'))}</kbd>`, 'bu-menu-item')}`
      + `<div class="bu-menu-zoom"><span>${escapeText(jt('browserUse.more.zoom', 'Zoom'))}</span><span class="bu-zoom-controls">${button('zoom-out', '−', 'bu-zoom-step', jt('browserUse.more.zoomOut', 'Zoom out'))}<span class="bu-zoom-value">${zoom}%</span>${button('zoom-in', '+', 'bu-zoom-step', jt('browserUse.more.zoomIn', 'Zoom in'))}</span></div>`
      + `${ads}<hr class="bu-menu-rule">${button('forget', `<span>${escapeText(jt('browserUse.closeForget', 'Close this page and forget it'))}</span>`, 'bu-menu-forget')}`;
  }

  function siteHtml({ page, sites, button }) {
    const parts = statusModule.addressParts(page?.url);
    const connection = parts.secure ? jt('browserUse.site.secure', 'The connection to this site is encrypted.') : jt('browserUse.site.insecure', 'The connection to this site is not encrypted.');
    const list = sites.length
      ? `<p class="bu-pop-head">${escapeText(jt('browserUse.site.allowed', 'Jenny can also use these in this chat'))}</p><ul class="bu-pop-sites">${sites.map((site) => `<li><span>${escapeText(site)}</span>${button('remove-site', escapeText(jt('browserUse.site.remove', 'Remove')), 'composer-chat-link', '', { site })}</li>`).join('')}</ul>`
      : '';
    return `<h4>${escapeText(parts.host)}</h4><p class="bu-pop-sub">${escapeText(connection)}</p>`
      + `<p>${escapeText(statusModule.privacyLine())}</p>`
      + `<p>${escapeText(jt('browserUse.site.rules', 'Jenny asks before going to a new site, or doing something that looks like buying, sending or deleting. Jenny never types passwords or card numbers.'))}</p>`
      + `${list}${button('forget', `<span>${escapeText(jt('browserUse.closeForget', 'Close this page and forget it'))}</span>`, 'bu-menu-forget')}`;
  }

  // What a person does in the panel: the buttons, the two popovers, the address and find fields.
  function createPanelActions({ windowRef, bar, actOnPage, getSession, getPage, getLastUrl, forgetLastUrl, getShell, button, refresh, showProblem, continueTurn }) {
    const FIND_DEBOUNCE_MS = 120;
    let findOpen = false;
    let findTimer = 0;
    let findSession = '';
    const popovers = () => windowRef.inventory.popover;
    const popoverEl = (name) => getShell()?.querySelector(`.bu-pop-${name}`) || null;

    function closePopovers() {
      for (const name of ['more', 'site']) {
        const el = popoverEl(name);
        if (el && !el.hidden) popovers().close(el);
      }
    }

    function openMore() {
      const el = popoverEl('more');
      if (!el) return;
      if (!el.hidden) {
        popovers().close(el);
        return;
      }
      closePopovers();
      el.innerHTML = moreHtml(getPage(), button);
      popovers().open(el, { trigger: bar.moreButton() });
    }

    async function openSiteInfo() {
      const el = popoverEl('site');
      if (!el) return;
      if (!el.hidden) {
        popovers().close(el);
        return;
      }
      closePopovers();
      const answer = await actOnPage('siteInfo');
      el.innerHTML = siteHtml({ page: getPage(), sites: answer?.sites || [], button });
      // Its only control ends the page, so the keyboard does not start there.
      popovers().open(el, { trigger: bar.lockButton(), focus: false });
    }

    function openFind() {
      if (!getShell()) return;
      closePopovers();
      findOpen = true;
      findSession = getSession();
      refresh();
      const input = getShell().querySelector('.bu-find input');
      input?.focus();
      input?.select();
    }

    function closeFind() {
      if (!findOpen) return;
      findOpen = false;
      windowRef.clearTimeout(findTimer);
      void actOnPage('stopFind');
      refresh();
    }

    function runFind(next, forward = true) {
      const text = getShell()?.querySelector('.bu-find input')?.value || '';
      void actOnPage('find', getSession(), { text, forward, next });
    }

    async function goToTyped() {
      const answer = await actOnPage('navigate', getSession(), { url: bar.typedAddress() });
      bar.stopEditing();
      if (answer && answer.ok !== true) showProblem(statusModule.problemText(answer.reason));
      refresh();
    }

    function retry() {
      const url = getPage()?.failed || getLastUrl();
      if (url) void actOnPage('navigate', getSession(), { url });
    }

    function onKeydown(event) {
      const inAddress = event.target === bar.field();
      const inFind = event.target?.closest?.('.bu-find');
      if (!inAddress && !inFind) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (inAddress) {
          bar.stopEditing();
          refresh();
        } else closeFind();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (inAddress) void goToTyped();
        else runFind(true, event.shiftKey !== true);
      }
    }

    function onInput(event) {
      if (!event.target?.closest?.('.bu-find')) return;
      windowRef.clearTimeout(findTimer);
      findTimer = windowRef.setTimeout(() => runFind(false), FIND_DEBOUNCE_MS);
    }

    function onFocusOut(event) {
      if (event.target !== bar.field() || !bar.isEditing()) return;
      bar.stopEditing();
      refresh();
    }

    function forget() {
      const sessionId = getSession();
      closePopovers();
      void actOnPage('close', sessionId).then(() => {
        forgetLastUrl(sessionId);
        refresh();
      });
    }

    function toggleAds() {
      void actOnPage('setAdBlock', getSession(), { enabled: getPage()?.ad_block === false });
    }

    function removeSite(site) {
      void actOnPage('removeSite', getSession(), { site }).then(() => {
        closePopovers();
        return openSiteInfo();
      });
    }

    const RUNS = {
      'take-over': () => void actOnPage('takeOver'),
      'hand-back': () => void actOnPage('handBack'),
      'show-download': () => void actOnPage('revealDownload'),
      'zoom-in': () => void actOnPage('zoom', getSession(), { change: 'in' }),
      'zoom-out': () => void actOnPage('zoom', getSession(), { change: 'out' }),
      'nav-back': () => void actOnPage('navigate', getSession(), { op: 'back' }),
      'nav-forward': () => void actOnPage('navigate', getSession(), { op: 'forward' }),
      'nav-reload': () => void actOnPage('navigate', getSession(), { op: getPage()?.loading ? 'stop' : 'reload' }),
      'edit-address': () => bar.startEditing(),
      'site-info': () => void openSiteInfo(),
      'toggle-ads': toggleAds,
      more: openMore,
      'open-find': openFind,
      'find-next': () => runFind(true),
      'find-done': closeFind,
      retry,
      forget,
      continue: continueTurn,
    };

    function run(action, element_) {
      if (action === 'remove-site') removeSite(element_.dataset.site);
      else RUNS[action]?.();
    }

    function dispose() {
      windowRef.clearTimeout(findTimer);
      if (findOpen) void actOnPage('stopFind', findSession); // the highlights would outlast the bar otherwise
      findOpen = false;
    }

    return { run, openFind, onKeydown, onInput, onFocusOut, dispose, isFindOpen: () => findOpen };
  }

  return { createBrowserUseBar, createPanelActions };
});
