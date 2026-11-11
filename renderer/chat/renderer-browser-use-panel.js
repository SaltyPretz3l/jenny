/* renderer/chat/renderer-browser-use-panel.js - the `browser` mode of the artifact review panel (row 114).
 *
 * Loads the first time a chat turns the Browser row on. It owns the composer's Browser chip, the status line, the
 * Take over and Hand back controls and the choice of when the panel opens; the shared rail owns the column, the
 * resizer and the Close button, renderer-browser-use-bar.js the browser controls, renderer-browser-use-status.js the
 * wording, and renderer-browser-use-placement.js keeps the native view in place.
 *
 * Page text never comes here: the main process sends the address, the title and what the current step is doing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-browser-use-placement'), require('./renderer-browser-use-status'), require('./renderer-browser-use-bar'));
    return;
  }
  root.rendererBrowserUsePanel = factory(root.rendererBrowserUsePlacement, root.rendererBrowserUseStatus, root.rendererBrowserUseBar);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (placementModule, statusModule, barModule) {
  'use strict';

  const jt = (...args) => (globalThis.jennyI18n?.t || globalThis.jennyI18nFallback || ((key, fallback, params) =>
    params ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) : fallback))(...args);

  const MODE = 'browser';
  const OPEN_SETTLE_FRAMES = 24; // the column glides for a few hundred milliseconds when it opens
  const MAX_REMEMBERED_CHATS = 64;
  const CHIP_ID = 'composerBrowserChip';
  const GLOBE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M1.8 8h12.4M8 1.8c2 2 2.6 4 2.6 6.2s-.6 4.2-2.6 6.2c-2-2-2.6-4-2.6-6.2S6 3.8 8 1.8Z"/></svg>';

  const { addressParts, pageMessage, problemText, statusFor, stepText } = statusModule;
  const STEP_HOLD_RECHECK_MS = 700; // the turn's end has no event here, so held step text looks again
  const PROBLEM_MS = 6000;
  const CONTINUE_MESSAGE = () => jt('browserUse.continueMessage', "I'm done with the page. Please continue.");

  const LINE_ENDS = Object.freeze({ take: 'take-over', back: 'hand-back', continue: 'continue', show: 'show-download' });

  const showsPage = (page) => page?.open === true && !page.failed && !page.crashed;

  // Writing the same words into a live region can read them out again.
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function toHexColor(value) {
    const text = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/iu.test(text)) return text;
    const parts = /^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[,/ ]+1(?:\.0+)?)?\)$/iu.exec(text);
    if (!parts) return '';
    return `#${parts.slice(1, 4).map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0')).join('')}`;
  }

  // Newest last, so the oldest chat falls off first.
  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_REMEMBERED_CHATS) map.delete(map.keys().next().value);
  }

  function createBrowserUsePanel(deps) {
    const d = deps || {};
    const {
      state, windowRef, openArtifactRail, renderArtifactReviewPanel, toggleArtifactReview, getPanelSessionId, appendClientLog = () => {},
      isSessionStreaming = () => false, sendPrompt = () => {},
    } = d;
    const panelEl = d.dom?.artifactReviewPanel || null;
    const doc = windowRef.document;
    const pages = new Map(); // chat id -> the main process's latest state for its page
    const enabled = new Map(); // chat id -> whether its Browser row is on
    const closedByUser = new Map(); // chat id -> true: no automatic opening until the chip is used
    const reopenOnReturn = new Map(); // chat id -> true: the panel was up when the user left this chat
    const lastUrls = new Map(); // chat id -> the page's last address, for Try again and Open it again
    const lastSteps = new Map(); // chat id -> the running turn's last step, shown while the model thinks
    const usedByTurn = new Map(); // chat id -> true: the latest turn did something on the page
    const wasStreaming = new Map(); // chat id -> whether a turn was running at the last look
    const restoreArtifacts = new Set(); // chat ids whose Artifacts list the Browser panel took the column from
    const refreshing = new Set(); // chat ids with a state request on its way
    const listenerToken = `browser-use-panel-${Math.random().toString(36).slice(2)}`;
    let shell = null;
    let chip = null;
    let chatWait = null;
    let actions = null;
    let backButton = null;
    let restorePending = false;
    let holdTimer = 0;
    let problem = '';
    let problemTimer = 0;
    let configured = '';
    let panelObserver = null;
    let unsubscribe = null;
    let shownFor = '';
    let disposed = false;

    const bridge = () => windowRef.jennyShell?.browserUse || null;
    const inventoryButton = () => windowRef.inventory?.actionButton;
    const focusedSession = () => String(state.currentSessionId || '').trim();
    const panelSession = () => String(getPanelSessionId() || '').trim();
    const inMode = () => panelEl?.dataset?.artifactReviewMode === MODE;
    const isShowing = () => inMode() && panelEl.classList?.contains('hidden') === false;
    const isOpen = () => isShowing() && panelSession() === focusedSession();

    function element(html) {
      const template = doc.createElement('template');
      template.innerHTML = html;
      return template.content.firstElementChild;
    }

    const placement = placementModule.createBrowserUsePlacement({
      windowRef,
      appendClientLog,
      getApi: bridge,
      getStage: () => (shell?.isConnected ? shell.querySelector('.bu-stage') : null),
      getFrozenImage: () => shell?.querySelector('.bu-frozen') || null,
      getTarget: () => {
        if (disposed || !isShowing()) return null;
        const sessionId = panelSession();
        return showsPage(pages.get(sessionId)) ? { sessionId } : null;
      },
    });

    const bar = barModule.createBrowserUseBar({ windowRef, element });

    function actOnPage(method, sessionId = panelSession(), fields = {}) {
      const api = bridge();
      if (!sessionId || typeof api?.[method] !== 'function') return Promise.resolve(null);
      return Promise.resolve().then(() => api[method]({ session_id: sessionId, ...fields })).catch((error) => {
        appendClientLog('WARN', 'browser_use.panel_call_failed', { method, message: String(error?.message || error || '').slice(0, 200) });
        return null;
      });
    }

    // ── what the panel shows ──
    function mountShell(host) {
      shell = [...host.children].find((node) => node.classList.contains('bu-shell')) || null;
      if (shell) return;
      const lineButton = (action, label, shown = false) => inventoryButton()({
        plain: true, className: `composer-chat-link bu-line-action${shown ? '' : ' hidden'}`, label, dataset: { 'browser-use-action': action },
      });
      const findField = windowRef.inventoryTextField({ ariaLabel: jt('browserUse.find.label', 'Find in page'), placeholder: jt('browserUse.find.label', 'Find in page'), className: 'bu-find-field' });
      host.innerHTML = '<div class="bu-shell"><div class="bu-status" data-quiet="true"><div class="bu-line"><span class="bu-dot" aria-hidden="true"></span>'
        + `<span class="bu-status-text" role="status"></span><span class="bu-line-end">${lineButton('take-over', jt('browserUse.takeOver', 'Take over'))}${lineButton('hand-back', jt('browserUse.handBack', 'Hand back to Jenny'))}${lineButton('continue', jt('browserUse.continue', 'Tell Jenny to continue'))}${lineButton('show-download', jt('browserUse.showDownload', 'Show'))}</span></div>`
        + `<div class="bu-line bu-find hidden">${findField}<span class="bu-line-end"><span class="bu-find-count"></span>${lineButton('find-next', jt('browserUse.find.next', 'Next'), true)}${lineButton('find-done', jt('browserUse.find.done', 'Done'), true)}</span></div></div>`
        + '<span class="bu-load hidden" aria-hidden="true"></span><div class="bu-stage"><div class="bu-message hidden"><strong></strong><span></span>' + inventoryButton()({ plain: true, className: 'composer-chat-link hidden', label: jt('browserUse.action.retry', 'Try again'), dataset: { 'browser-use-action': 'retry' } }) + '</div><img class="bu-frozen hidden" alt=""></div>'
        + `${windowRef.inventory.popover({ className: 'bu-pop bu-pop-more', ariaLabel: jt('browserUse.bar.more', 'More') })}${windowRef.inventory.popover({ className: 'bu-pop bu-pop-site', ariaLabel: jt('browserUse.bar.about', 'About this page') })}</div>`;
      shell = host.firstElementChild;
    }

    // While a step waits on the user, the chat says so too: the panel may be closed or easy to miss.
    function syncChatWait() {
      const waiting = pages.get(focusedSession())?.waiting === true;
      const wrap = waiting ? chip?.closest?.('.composer-wrap') : null;
      if (!wrap || !inventoryButton()) {
        chatWait?.remove();
        chatWait = null;
        return;
      }
      if (chatWait?.isConnected) return;
      chatWait = element(`<div class="bu-chat-wait" role="status"><span class="bu-dot" aria-hidden="true"></span><span class="bu-status-text">${jt('browserUse.status.waiting', 'You have the page. Jenny is waiting.')}</span>${inventoryButton()({
        plain: true, className: 'composer-chat-link bu-hand-back', label: jt('browserUse.handBack', 'Hand back to Jenny'),
      })}</div>`);
      chatWait.addEventListener('click', (event) => {
        if (event.target?.closest?.('.bu-hand-back')) void actOnPage('handBack', focusedSession());
      });
      wrap.insertBefore(chatWait, wrap.querySelector('.composer-status-notice'));
    }

    function headerButton(action, label, extraClass) {
      return element(inventoryButton()({
        plain: true, className: `artifact-panel-text-btn ${extraClass} hidden`, label, dataset: { 'browser-use-action': action },
      }));
    }

    function mountHeaderControls() {
      bar.mount(panelEl);
      const actions = panelEl.querySelector('.artifact-panel-header-actions');
      if (!actions || backButton?.isConnected) return;
      backButton = headerButton('back', jt('browserUse.backToChat', 'Back to chat'), 'bu-back-to-chat');
      actions.insertBefore(backButton, actions.querySelector('#artifactReviewCollapseButton'));
    }

    function unmount() {
      backButton?.remove();
      backButton = null;
      bar.unmount();
      shell?.remove();
      shell = null;
      actions.dispose();
    }

    function swapFocus(from, to) {
      if (from && to && doc.activeElement === from) to.focus({ preventScroll: true });
    }

    function panelTitle() {
      const page = pages.get(panelSession());
      return addressParts(page?.url).host || jt('composer.toolFamily.browser.label', 'Browser');
    }

    // Only the renderer can see whether a turn is running, so only it can tell thinking from finished.
    function viewFor(sessionId, page) {
      const streaming = isSessionStreaming(sessionId) === true;
      if (streaming && wasStreaming.get(sessionId) !== true) {
        usedByTurn.delete(sessionId);
        lastSteps.delete(sessionId);
      }
      remember(wasStreaming, sessionId, streaming);
      if (page?.busy === true) {
        remember(usedByTurn, sessionId, true);
        remember(lastSteps, sessionId, stepText(page.action, page.target));
      }
      if (!streaming) lastSteps.delete(sessionId);
      return {
        streaming, problem, lastStep: lastSteps.get(sessionId) || '',
        // Only when the model may be waiting: a finished task has nothing to continue, and being told to made it invent one.
        doneOffer: !streaming && page?.user_touched === true && usedByTurn.get(sessionId) === true && (page.stopped_short === true || page.signed_in === true),
      };
    }

    function showProblem(text) {
      problem = text;
      windowRef.clearTimeout(problemTimer);
      problemTimer = windowRef.setTimeout(() => { problem = ''; applyState(); }, PROBLEM_MS);
      applyState();
    }

    function syncLine(page, status) {
      const line = shell.querySelector('.bu-status');
      line.dataset.tone = status.tone || '';
      line.dataset.quiet = String(status.quiet === true);
      setText(shell.querySelector('.bu-status-text'), status.text);
      const lineAction = (name) => shell.querySelector(`.bu-line-action[data-browser-use-action="${name}"]`);
      const take = lineAction('take-over');
      const back = lineAction('hand-back');
      // Before the hide, so a keyboard user is not dropped on the page body.
      if (status.end === 'back') swapFocus(take, back);
      if (status.end === 'take') swapFocus(back, take);
      for (const [end, action] of Object.entries(LINE_ENDS)) lineAction(action).classList.toggle('hidden', status.end !== end);
      shell.querySelector('.bu-line:not(.bu-find)').classList.toggle('hidden', actions.isFindOpen());
      shell.querySelector('.bu-find').classList.toggle('hidden', !actions.isFindOpen());
      const zoomValue = shell.querySelector('.bu-zoom-value');
      if (zoomValue) setText(zoomValue, `${Math.round((Number(page?.zoom) || 1) * 100)}%`);
      const found = page?.find;
      setText(shell.querySelector('.bu-find-count'), found ? jt('browserUse.find.count', '{ordinal} of {total}', { ordinal: found.ordinal, total: found.total }) : '');
    }

    function syncMessage(page) {
      const message = pageMessage(page);
      const box = shell.querySelector('.bu-message');
      box.classList.toggle('hidden', !message);
      if (!message) return;
      const [title, body, action] = box.children;
      title.textContent = message.title;
      body.textContent = message.body;
      action.textContent = message.actionLabel;
      action.classList.toggle('hidden', !message.action || !(page?.failed || lastUrls.has(panelSession())));
    }

    function applyState() {
      if (!shell || !isShowing()) return;
      const sessionId = panelSession();
      const page = pages.get(sessionId);
      const view = viewFor(sessionId, page);
      syncLine(page, statusFor(page, view));
      syncMessage(page);
      shell.querySelector('.bu-load').classList.toggle('hidden', !(showsPage(page) && page.loading === true));
      bar.sync(page, lastUrls.get(sessionId));
      backButton?.classList.remove('hidden');
      windowRef.clearTimeout(holdTimer);
      holdTimer = view.lastStep && page?.busy !== true ? windowRef.setTimeout(applyState, STEP_HOLD_RECHECK_MS) : 0;
    }

    function configure(sessionId) {
      const color = toHexColor(windowRef.getComputedStyle?.(panelEl)?.backgroundColor);
      if (!color || color === configured) return;
      configured = color;
      void actOnPage('configure', sessionId, { background: color, labels: {
        back: jt('browserUse.bar.back', 'Back'), reload: jt('browserUse.bar.reload', 'Reload'), cut: jt('browserUse.menu.cut', 'Cut'), copy: jt('browserUse.menu.copy', 'Copy'),
        paste: jt('browserUse.menu.paste', 'Paste'), selectAll: jt('browserUse.menu.selectAll', 'Select all'), copyLink: jt('browserUse.menu.copyLink', 'Copy link address'), copyImage: jt('browserUse.menu.copyImage', 'Copy image'),
      } });
    }

    actions = barModule.createPanelActions({
      windowRef, bar, actOnPage, getShell: () => shell, refresh: applyState, showProblem,
      getSession: panelSession,
      getPage: () => pages.get(panelSession()),
      getLastUrl: () => lastUrls.get(panelSession()),
      forgetLastUrl: (sessionId) => lastUrls.delete(sessionId),
      button: (action, html, className, ariaLabel, dataset = {}) => inventoryButton()({ plain: true, className, ariaLabel, trustedHtml: html, dataset: { 'browser-use-action': action, ...dataset } }),
      continueTurn: () => {
        const sessionId = panelSession();
        usedByTurn.delete(sessionId);
        applyState();
        void sendPrompt(CONTINUE_MESSAGE(), sessionId);
      },
    });

    function prepareSurface(surface) {
      surface.detailEmpty?.classList?.add('hidden');
      surface.detailPanel?.classList?.remove('hidden');
      surface.metaPane?.classList?.add('hidden');
      for (const button of [surface.saveButton, surface.revertButton, surface.revealButton,
        surface.openExternalButton, surface.deleteButton, surface.jumpButton]) button?.classList?.add('hidden');
      surface.editorShell?.classList?.add('hidden');
      surface.dirtyBadge?.classList?.add('hidden');
      if (surface.detailNote) surface.detailNote.textContent = '';
      surface.previewContent?.classList?.remove('hidden');
    }

    // The pull from the panel's render pass.
    function renderRailContent(surface) {
      if (disposed || !surface?.previewContent || !inventoryButton()) return false;
      prepareSurface(surface);
      mountShell(surface.previewContent);
      mountHeaderControls();
      applyState();
      shownFor = panelSession();
      configure(shownFor);
      if (!pages.has(shownFor)) void refresh(shownFor);
      placement.request();
      return true;
    }

    // ── opening and closing ──
    function open(options) {
      if (disposed) return false;
      openArtifactRail(MODE, options);
      renderArtifactReviewPanel();
      placement.request(OPEN_SETTLE_FRAMES);
      syncChipPressed();
      return true;
    }

    function close() {
      if (isOpen()) toggleArtifactReview();
    }

    function toggle() {
      const sessionId = focusedSession();
      if (!sessionId) return;
      if (isOpen()) {
        remember(closedByUser, sessionId, true);
        restorePending = true;
        close();
      } else {
        closedByUser.delete(sessionId);
        open();
      }
      syncChipPressed();
    }

    // Opens beside the chat without taking the keyboard. It takes the column from the
    // Artifacts list, which is often just left open, but never from a panel opened for something else.
    function openQuietly(sessionId) {
      if (sessionId !== focusedSession() || closedByUser.has(sessionId)) return;
      const showing = panelEl.classList?.contains('hidden') === false;
      if (showing && panelEl.dataset.artifactReviewMode !== 'artifact') return;
      if (showing) restoreArtifacts.add(sessionId);
      open({ focus: false });
    }

    function maybeReopen(sessionId) {
      if (!reopenOnReturn.has(sessionId) || pages.get(sessionId)?.open !== true) return;
      reopenOnReturn.delete(sessionId);
      openQuietly(sessionId);
    }

    function noteState(sessionId, page) {
      const { command: _command, ...state_ } = page;
      remember(pages, sessionId, state_);
      if (/^https?:/iu.test(String(state_.url || ''))) remember(lastUrls, sessionId, state_.url);
    }

    async function refresh(sessionId) {
      if (refreshing.has(sessionId)) return;
      refreshing.add(sessionId);
      const answer = await actOnPage('getState', sessionId);
      refreshing.delete(sessionId);
      if (disposed) return;
      // A chat with no answer counts as having no page, or every composer render would ask again.
      noteState(sessionId, answer?.ok === true ? answer : { open: false });
      maybeReopen(sessionId);
      applyState();
      syncChatWait();
      placement.request();
    }

    function handleChanged(payload) {
      const sessionId = String(payload?.session_id || '');
      if (disposed || !sessionId) return;
      const before = pages.get(sessionId);
      noteState(sessionId, payload);
      if (payload.command && sessionId === panelSession() && isShowing()) {
        if (payload.command === 'open_find') actions.openFind();
        else bar.startEditing();
      }
      if (payload.open !== true) {
        placement.forget(sessionId);
        reopenOnReturn.delete(sessionId);
      } else if (before?.open !== true) {
        openQuietly(sessionId);
      }
      if (sessionId === panelSession()) applyState();
      syncChatWait();
      if (showsPage(before) !== showsPage(payload)) placement.request();
    }

    // ── the chip and the Tools row ──
    function syncChipPressed() {
      if (chip) windowRef.inventory?.chip?.setPressed?.(chip, isOpen());
    }

    function syncChip(chipHost, on) {
      chip = chipHost?.querySelector?.(`#${CHIP_ID}`) || chip;
      if (on && !chip && chipHost && windowRef.inventory?.chip) {
        const label = jt('composer.toolFamily.browser.label', 'Browser');
        chip = element(windowRef.inventory.chip({ id: 'composer-browser', domId: CHIP_ID, iconHtml: GLOBE_ICON, label, ariaLabel: label, title: label, pressed: false, className: 'composer-browser-chip' }));
        chip.addEventListener('click', toggle);
        chipHost.appendChild(chip);
      }
      if (chip && chip.hidden !== !on) chip.hidden = !on;
      syncChipPressed();
    }

    // Every composer render passes through here; a chat that is off and was never on costs one lookup.
    function sync({ sessionId, enabled: on, chipHost } = {}) {
      if (disposed) return;
      const id = String(sessionId || '').trim();
      syncChip(chipHost, on === true);
      syncChatWait();
      if (!id) return;
      const was = enabled.get(id);
      if (was !== (on === true)) remember(enabled, id, on === true);
      if (was === true && on !== true) {
        if (isOpen()) close();
        void actOnPage('close', id);
        return;
      }
      if (on !== true) return;
      if (!pages.has(id)) void refresh(id);
      else maybeReopen(id);
    }

    // ── panel changes made by the rail ──
    function handlePanelChanged() {
      if (disposed) return;
      syncChipPressed();
      if (inMode()) {
        if (!isShowing()) {
          const returning = restorePending && shownFor === focusedSession() && restoreArtifacts.delete(shownFor);
          restorePending = false;
          shownFor = ''; // closed by hand, so leaving this chat has nothing to bring back
          if (returning) {
            openArtifactRail('artifact', { focus: false });
            renderArtifactReviewPanel();
            return;
          }
        }
        placement.request(OPEN_SETTLE_FRAMES);
        return;
      }
      // Another chat or another panel took the column; the page stays alive and off screen.
      if (shownFor && shownFor !== panelSession() && pages.get(shownFor)?.open === true) remember(reopenOnReturn, shownFor, true);
      shownFor = '';
      placement.request();
      unmount();
    }

    function handlePanelClick(event) {
      if (disposed || !inMode()) return;
      if (event.target?.closest?.('#artifactReviewCollapseButton')) {
        remember(closedByUser, panelSession(), true);
        restorePending = true;
        return;
      }
      const button = event.target?.closest?.('[data-browser-use-action]');
      const action = button?.dataset?.browserUseAction;
      if (action === 'back') {
        remember(closedByUser, panelSession(), true);
        restorePending = true;
        toggleArtifactReview();
      } else if (action) {
        actions.run(action, button);
      }
    }

    function bind() {
      if (disposed || !panelEl?.addEventListener || panelEl.dataset.browserUseBound) return;
      panelEl.dataset.browserUseBound = listenerToken;
      panelEl.addEventListener('click', handlePanelClick, true);
      panelEl.addEventListener('keydown', actions.onKeydown, true);
      panelEl.addEventListener('input', actions.onInput, true);
      panelEl.addEventListener('focusout', actions.onFocusOut, true);
      if (typeof windowRef.MutationObserver === 'function') {
        panelObserver = new windowRef.MutationObserver(handlePanelChanged);
        panelObserver.observe(panelEl, { attributes: true, attributeFilter: ['data-artifact-review-mode', 'class'] });
      }
      const subscribe = bridge()?.onChanged;
      if (typeof subscribe === 'function') {
        const off = subscribe.call(bridge(), handleChanged);
        unsubscribe = typeof off === 'function' ? off : null;
      }
    }

    function dispose() {
      if (disposed) return;
      placement.dispose();
      disposed = true;
      windowRef.clearTimeout(holdTimer);
      windowRef.clearTimeout(problemTimer);
      unsubscribe?.();
      unsubscribe = null;
      panelObserver?.disconnect();
      panelObserver = null;
      chip?.removeEventListener('click', toggle);
      chip?.remove();
      chip = null;
      chatWait?.remove();
      chatWait = null;
      unmount();
      if (panelEl?.dataset?.browserUseBound === listenerToken) {
        panelEl.removeEventListener('click', handlePanelClick, true);
        panelEl.removeEventListener('keydown', actions.onKeydown, true);
        panelEl.removeEventListener('input', actions.onInput, true);
        panelEl.removeEventListener('focusout', actions.onFocusOut, true);
        delete panelEl.dataset.browserUseBound;
      }
    }

    return { bind, dispose, sync, open, close, toggle, isOpen, renderRailContent, panelTitle };
  }

  // The shell's side of the wiring lives here so that it costs nothing at startup.
  function connectBrowserUsePanel(rails) {
    const { windowRef, sidePanel, ensureArtifactSurface, registerCleanup } = rails;
    const controller = createBrowserUsePanel({
      state: rails.state,
      windowRef,
      dom: { artifactReviewPanel: rails.resolveArtifactReviewPanelEl() },
      openArtifactRail: (mode, options) => ensureArtifactSurface()?.openArtifactRail?.(mode, options),
      renderArtifactReviewPanel: () => ensureArtifactSurface()?.renderArtifactReviewPanel?.(),
      toggleArtifactReview: () => ensureArtifactSurface()?.toggleArtifactReview?.(),
      getPanelSessionId: () => sidePanel.getSessionId(),
      appendClientLog: rails.appendClientLog,
      isSessionStreaming: (id) => windowRef.rendererMultiStreamController?.isSessionStreaming?.(id) === true,
      sendPrompt: (text, id) => windowRef.rendererSendChatPrompt?.(text, id),
    });
    controller.bind();
    const host = { panelTitle: controller.panelTitle, glyphHtml: GLOBE_ICON };
    windowRef.rendererBrowserUseHost = host;
    registerCleanup(() => {
      controller.dispose();
      if (windowRef.rendererBrowserUseHost === host) delete windowRef.rendererBrowserUseHost;
    });
    return controller;
  }

  return { MODE, connectBrowserUsePanel, createBrowserUsePanel, statusFor, stepText };
});
