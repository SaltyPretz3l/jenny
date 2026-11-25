/* renderer/chat/renderer-live-run-panel.js - the `live` mode of the artifact review panel (row 197, S3).
 *
 * The chat's Live tab: it starts, stops and restarts the project's own program and shows that program's window as live
 * video. The shared rail owns the column and the tab; renderer-live-run-form.js owns the command form, its exact-text
 * confirm and the notices; renderer-live-run-capture.js owns the picture. Main owns the run (services/run-view/): this
 * panel asks through window.jennyShell.runView and shows what it answers and pushes, as text, never as markup. It sends
 * nothing to the program: a click on the picture only brings the real window forward. Loaded lazily on the tab's first open.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-live-run-form'), require('./renderer-live-run-capture'), require('../inventory/toggle-switch'));
    return;
  }
  root.rendererLiveRunPanel = factory(root.rendererLiveRunForm, root.rendererLiveRunCapture, root.inventoryToggleSwitch);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (formModule, captureModule, toggleModule) {
  'use strict';

  const jt = (...args) => (globalThis.jennyI18n?.t || globalThis.jennyI18nFallback || ((key, fallback, params) =>
    params ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) : fallback))(...args);

  const MODE = 'live';
  const GENERAL_PROJECT = 'project_general';
  const WIDE_MIN_PX = 480;
  const SWITCH_ID = 'lvRestartAfter';
  const stroke = (body) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const wide24 = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = Object.freeze({
    run: wide24('<path d="M7 4v16l13 -8z"></path>'),
    stop: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1"/></svg>',
    restart: stroke('<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/>'),
    show: wide24('<path d="M14 4h6v6"></path><path d="M20 4 11 13"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path>'),
    wide: stroke('<path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/>'),
    narrow: stroke('<path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3"/>'),
    more: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>',
  });

  // Which states let each bar button act (the spec's table).
  const RESTING = new Set(['idle', 'closed', 'ended_early', 'build_failed']);
  const STOPPABLE = new Set(['building', 'starting', 'no_window', 'running', 'minimized']);
  const RESTARTABLE = new Set(['starting', 'no_window', 'running', 'minimized']);
  const SHOWABLE = new Set(['running', 'minimized', 'close_refused']);

  function relativeAge(ms) {
    if (ms < 60_000) return jt('chat.liveView.when.now', 'just now');
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return jt('chat.liveView.when.minutes', '{count} min ago', { count: minutes });
    return jt('chat.liveView.when.hours', '{count} h ago', { count: Math.floor(minutes / 60) });
  }

  function unavailableText(reason) {
    if (reason === 'unsupported_platform') return jt('chat.liveView.unavailable.platform', 'The live view needs Windows for now.');
    if (reason === 'sandbox_only') return jt('chat.liveView.unavailable.sandbox', 'Commands are set to run only in the sandbox, so the live view is off.');
    if (reason === 'no_project') return jt('chat.liveView.unavailable.noProject', 'Open a chat in a project to run its program.');
    return jt('chat.liveView.unavailable.other', 'The live view is not available right now.');
  }

  function createLiveRunPanel(deps) {
    const d = deps || {};
    const { state, windowRef, openArtifactRail, renderArtifactReviewPanel, toggleArtifactReview, appendClientLog = () => {} } = d;
    const panelEl = d.dom?.artifactReviewPanel || null;
    const doc = windowRef.document;
    const now = d.now || Date.now;
    const listenerToken = `live-run-panel-${Math.random().toString(36).slice(2)}`;
    const view = {
      projectId: '', loaded: false, unavailable: '', command: { status: 'none' }, run: null, screen: '', values: null, parsed: null,
      errors: {}, seq: 0, restartAfter: true, flash: '', gpuWarning: null, still: { projectId: '', url: '', seq: 0 }, output: { key: '', lines: [] },
    };
    const marks = new Map(); // markKey(run, kind) -> when the panel first saw it
    let shell = null;
    let body = null;
    let bar = null;
    let moreButton = null;
    let bodyKey = '';
    let timer = 0;
    let flashTimer = 0;
    let wideBefore = null;
    let refreshingFor = '';
    let refreshSeq = 0;
    let panelObserver = null;
    let unsubscribe = [];
    let disposed = false;

    const bridge = () => windowRef.jennyShell?.runView || null;
    const inventoryButton = () => windowRef.inventory?.actionButton;
    const focusedChat = () => String(state.currentSessionId || '').trim();
    const inMode = () => panelEl?.dataset?.artifactReviewMode === MODE;
    const isShowing = () => inMode() && panelEl.classList?.contains('hidden') === false;
    const sizeApi = () => d.getLayoutHost?.()?.size || null;
    const sessions = () => (Array.isArray(state.sessions) ? state.sessions : []);
    const sessionOf = (id) => sessions().find((entry) => String(entry?.id || '').trim() === id);
    const projectOf = () => (focusedChat() ? String(sessionOf(focusedChat())?.project_id || '').trim() || GENERAL_PROJECT : '');
    const markKey = (run, kind) => `${run.projectId}|${kind}|${run.generation}`; // a generation counts per project
    const currentRun = () => view.run || { projectId: view.projectId, state: 'idle', generation: 0, exitCode: null, buildTail: '', sourceId: null };

    async function call(method, payload) {
      const fn = bridge()?.[method];
      if (typeof fn !== 'function') return { ok: false, reason: 'internal_error' };
      try { return (await fn.call(bridge(), payload)) || { ok: false, reason: 'internal_error' }; } catch (_error) { return { ok: false, reason: 'internal_error' }; }
    }

    const el = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = [].concat(className).join(' ');
      if (text != null) node.textContent = text;
      return node;
    };
    const fromHtml = (html) => {
      const template = doc.createElement('template');
      template.innerHTML = html;
      return template.content.firstElementChild;
    };
    const textButton = (action, label, variant = 'secondary') => fromHtml(inventoryButton()({ size: 'sm', variant, label, dataset: { 'live-action': action } }));
    const iconButton = (action, label, icon, extra = '') => inventoryButton()({
      plain: true, className: `artifact-panel-icon-btn ${extra}`.trim(), ariaLabel: label, title: label, trustedHtml: icon, dataset: { 'live-action': action },
    });

    const capture = captureModule.createLiveRunCapture({
      windowRef, createCanvas: d.createCanvas, now, arm: (projectId) => call('armCapture', { projectId }), onChange: () => update(),
    });

    // The last frame, dimmed or lighter, under the states that keep it; nothing when there is none.
    const stillUrl = () => (view.still.projectId === view.projectId ? view.still.url : '');
    const stillStage = (look) => (stillUrl() ? captureModule.stageNodes(doc, { look, picture: capture.stillPicture(stillUrl()) }) : []);
    const form = formModule.createLiveRunForm({
      windowRef, view, el, textButton, call, update: () => update(), flash: (text) => flash(text), applyGet: (reply) => applyGet(reply),
      body: () => body, stillStage, isResting: () => RESTING.has(currentRun().state), insert: (payload) => d.insertIntoComposer?.(payload),
    });

    // ── the run ──
    function setRun(snapshot) {
      view.run = snapshot;
      if (view.gpuWarning && (snapshot.state !== view.gpuWarning.state || snapshot.generation !== view.gpuWarning.generation)) view.gpuWarning = null;
      const kind = snapshot.state === 'building' || snapshot.state === 'running' ? snapshot.state : '';
      if (kind && !marks.has(markKey(snapshot, kind))) marks.set(markKey(snapshot, kind), now());
      while (marks.size > 8) marks.delete(marks.keys().next().value);
      if (snapshot.state !== 'ended_early' && snapshot.state !== 'no_window') return;
      const key = `${snapshot.projectId}|${snapshot.generation}|${snapshot.state}`;
      if (view.output.key === key) return;
      view.output = { key, lines: [] };
      void call('output', { projectId: snapshot.projectId }).then((reply) => {
        if (disposed || view.output.key !== key || reply.ok !== true) return;
        view.output.lines = Array.isArray(reply.lines) ? reply.lines.map(String) : [];
        update();
      });
    }

    function applyGet(reply) {
      Object.assign(view, { loaded: true, screen: '', values: null, errors: {}, gpuWarning: null, seq: view.seq + 1, unavailable: reply.ok === true ? '' : reply.reason || 'internal_error' });
      if (reply.ok === true) {
        view.command = reply.command || { status: 'none' };
        view.run = null;
        view.restartAfter = typeof reply.restartAfterChanges === 'boolean' ? reply.restartAfterChanges : true; // main owns the switch
        if (reply.run) setRun(reply.run);
      } else if (view.unavailable === 'disabled' && isShowing()) toggleArtifactReview?.();
      update();
    }

    async function refresh() {
      const projectId = projectOf();
      if (refreshingFor === projectId && view.projectId === projectId) return;
      if (view.projectId !== projectId) {
        Object.assign(view, { projectId, loaded: false, unavailable: '', command: { status: 'none' }, run: null, screen: '', values: null, errors: {}, restartAfter: true, flash: '', gpuWarning: null });
      }
      if (!projectId) { applyGet({ ok: false, reason: 'no_project' }); return; }
      refreshingFor = projectId;
      const mine = ++refreshSeq;
      const reply = await call('get', { projectId });
      if (mine === refreshSeq) refreshingFor = ''; // an older request must not end a newer one's guard
      if (!disposed && mine === refreshSeq && view.projectId === projectId) applyGet(reply);
    }

    function handleState(snapshot) {
      if (disposed || !snapshot || snapshot.projectId !== view.projectId) return;
      if (view.run && snapshot.generation < view.run.generation) return;
      setRun(snapshot);
      update();
    }

    function handleKeepLastFrame(event) {
      if (disposed || event?.projectId !== view.projectId || event.generation !== view.run?.generation) return;
      const url = capture.still();
      if (!url) return;
      view.still = { projectId: event.projectId, url, seq: view.still.seq + 1 }; // the key reads seq, not the frame
      update();
    }

    // ── what the panel shows ──
    function screenName() {
      if (view.unavailable) return 'notice';
      if (view.screen) return view.screen;
      return view.command.status === 'confirmed' ? 'run' : 'form';
    }

    function buildingStage(run) {
      const overlay = el('div', 'lv-overlay');
      overlay.append(el('strong', 'lv-build-time'));
      const last = formModule.lastLines(run.buildTail, 1)[0];
      if (last) overlay.append(el('code', 'lv-mono', last));
      return captureModule.stageNodes(doc, { look: 'dim', picture: stillUrl() ? capture.stillPicture(stillUrl()) : null, overlay, load: true });
    }

    // Run was refused because less graphics memory is free than the program used last time: say so, and let the person decide.
    function gpuWarningNodes() {
      const gb = (mb) => (mb / 1024).toFixed(1);
      return [form.notice({
        title: jt('liveRun.gpuWarning.title', 'Not much graphics memory is free'),
        text: jt('liveRun.gpuWarning.body', 'Last time this program used about {need} GB of graphics memory, and {free} GB is free now. Starting it may slow down or stop the model.',
          { need: gb(view.gpuWarning.needMb), free: gb(view.gpuWarning.freeMb) }),
        buttons: [textButton('start-anyway', jt('liveRun.gpuWarning.startAnyway', 'Start anyway')), textButton('cancel-gpu', jt('liveRun.gpuWarning.cancel', 'Cancel'))],
      })];
    }

    function runNodes() {
      const run = currentRun();
      if (view.gpuWarning) return gpuWarningNodes();
      if (run.state === 'building') return buildingStage(run);
      if (run.state === 'starting') return captureModule.stageNodes(doc, { load: true, text: jt('chat.liveView.starting', 'Starting… waiting for its window') });
      if (run.state === 'idle') return captureModule.stageNodes(doc, {});
      if (run.state !== 'running') return form.stoppedNodes(run);
      const text = capture.hasFailed() ? jt('chat.liveView.captureFailed', 'The picture could not start. Use Show window to see the program.') : '';
      return captureModule.stageNodes(doc, { picture: capture.livePicture(jt('chat.liveView.picture.bring', 'Bring the window forward')), text });
    }

    function bodyNodes() {
      const screen = screenName();
      if (screen === 'notice') return [form.notice({ title: unavailableText(view.unavailable) })];
      if (screen === 'form') return form.formNodes();
      return screen === 'confirm' ? form.confirmNodes() : runNodes();
    }

    // What decides whether the body must be built again; a tick or a repeated push does not.
    function bodyKeyNow() {
      const run = currentRun();
      return JSON.stringify([screenName(), view.seq, view.unavailable, view.command.status, run.state, run.generation, run.exitCode, run.buildTail,
        run.sourceId, view.output.lines, view.gpuWarning && [view.gpuWarning.needMb, view.gpuWarning.freeMb], view.still.seq, capture.hasFailed(), capture.hasVideo()]);
    }

    function renderBody() {
      if (!body) return;
      const key = bodyKeyNow();
      if (key !== bodyKey) {
        bodyKey = key;
        body.replaceChildren(...bodyNodes());
        if (screenName() === 'form') formModule.showErrors(body, view.errors);
      }
      updateDynamic();
    }

    function runningLine(run) {
      const other = run.chatId && run.chatId !== focusedChat() ? sessionOf(run.chatId) : null;
      if (other?.title) return jt('chat.liveView.line.runningIn', 'Running · started in “{chat}”', { chat: String(other.title) });
      return jt('chat.liveView.line.running', 'Running · started {when}', { when: relativeAge(now() - (marks.get(markKey(run, 'running')) ?? now())) });
    }

    function stateLineText() {
      const run = currentRun();
      switch (run.state) {
        case 'building': return jt('chat.liveView.line.building', 'Building');
        case 'starting': return jt('chat.liveView.line.starting', 'Starting');
        case 'no_window': return jt('chat.liveView.line.noWindow', 'Running · no window');
        case 'minimized': return jt('chat.liveView.line.minimized', 'Minimised');
        case 'stopping': return jt('chat.liveView.line.stopping', 'Stopping');
        case 'running': return runningLine(run);
        default: return '';
      }
    }

    // The words that change with the clock, set in place so nothing the person is using is rebuilt.
    function updateDynamic() {
      if (!shell) return;
      const run = currentRun();
      const time = shell.querySelector('.lv-build-time');
      if (time) {
        const seconds = Math.max(0, Math.floor((now() - (marks.get(markKey(run, 'building')) ?? now())) / 1000));
        time.textContent = jt('chat.liveView.building', 'Building… {time}', { time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` });
      }
      const text = screenName() === 'run' ? stateLineText() : '';
      const line = shell.querySelector('.lv-line');
      line.classList.toggle('hidden', !text);
      const label = line.querySelector('.bu-status-text');
      if (label.textContent !== text) label.textContent = text;
      line.querySelector('.bu-line-end').classList.toggle('hidden', run.state !== 'running' || !text);
      toggleModule.setChecked(line.querySelector('[role="switch"]'), view.restartAfter);
    }

    // ── the bar ──
    function barModel() {
      const s = currentRun().state;
      const off = Boolean(view.unavailable);
      const live = screenName() === 'run';
      const resting = RESTING.has(s);
      const label = resting || off ? (s === 'ended_early' || s === 'build_failed' ? jt('chat.liveView.runAgain', 'Run again') : jt('chat.liveView.run', 'Run')) : jt('chat.liveView.stop', 'Stop');
      return {
        primary: { hidden: !off && !live, action: resting || off ? 'run' : 'stop', label, enabled: !off && live && (resting ? view.command.status === 'confirmed' : STOPPABLE.has(s)) },
        restart: !off && live && RESTARTABLE.has(s),
        show: !off && live && SHOWABLE.has(s),
        wide: !off && sizeApi() !== null && (s === 'running' || wideBefore !== null),
        more: !off,
      };
    }

    function setIcon(button, icon) {
      if (button.dataset.icon === icon) return;
      button.innerHTML = ICONS[icon];
      button.dataset.icon = icon;
    }

    function syncBar() {
      if (!bar) return;
      const model = barModel();
      const primary = bar.querySelector('.lv-primary');
      primary.classList.toggle('hidden', model.primary.hidden);
      primary.disabled = !model.primary.enabled;
      primary.dataset.liveAction = model.primary.action;
      primary.title = model.primary.label;
      primary.setAttribute('aria-label', model.primary.label);
      setIcon(primary, model.primary.action);
      for (const [selector, on] of [['.lv-restart', model.restart], ['.lv-show', model.show], ['.lv-wide-btn', model.wide]]) bar.querySelector(selector).disabled = !on;
      moreButton.disabled = !model.more;
      const wideButton = bar.querySelector('.lv-wide-btn');
      const label = wideBefore === null ? jt('chat.liveView.wide', 'Wide') : jt('chat.liveView.narrow', 'Narrow');
      wideButton.setAttribute('aria-label', label);
      wideButton.title = label;
      wideButton.setAttribute('aria-pressed', String(wideBefore !== null));
      setIcon(wideButton, wideBefore === null ? 'wide' : 'narrow');
      shell?.querySelectorAll('.lv-pop [data-live-action="behind"]').forEach((item) => { item.disabled = !model.show; });
    }

    function syncFlash() {
      const node = shell?.querySelector('.lv-flash');
      if (!node) return;
      node.textContent = view.flash;
      node.classList.toggle('hidden', !view.flash);
    }

    function flash(text) {
      view.flash = text;
      windowRef.clearTimeout(flashTimer);
      flashTimer = windowRef.setTimeout(() => { view.flash = ''; syncFlash(); }, 5000);
      syncFlash();
    }

    // ── effects that follow what is on screen ──
    function wantCapture() {
      const run = view.run;
      if (!isShowing() || doc.visibilityState === 'hidden' || view.unavailable || run?.state !== 'running' || !run.sourceId) return null;
      return { projectId: run.projectId, sourceId: run.sourceId, generation: run.generation };
    }

    function schedule() {
      windowRef.clearTimeout(timer);
      timer = 0;
      const s = currentRun().state;
      if (disposed || !isShowing() || doc.visibilityState === 'hidden' || (s !== 'building' && s !== 'running')) return;
      timer = windowRef.setTimeout(() => { timer = 0; updateDynamic(); schedule(); }, s === 'building' ? 1000 : 60_000);
    }

    function restoreWidth() {
      if (wideBefore === null) return;
      const before = wideBefore;
      wideBefore = null;
      sizeApi()?.set?.(before);
    }

    function update() {
      if (disposed) return;
      if (shell?.isConnected) { syncBar(); renderBody(); syncFlash(); }
      capture.setCrop(view.run?.crop); // the client area only, when the snapshot says how much is frame
      capture.sync(wantCapture());
      schedule();
      if (!isShowing()) restoreWidth();
    }

    // Wide: half the window, at least 480px, through the layout's own size path; Narrow puts the earlier width back.
    function toggleWide() {
      const size = sizeApi();
      if (!size) return;
      if (wideBefore !== null) { restoreWidth(); syncBar(); return; }
      const { width, room, max } = size.get();
      wideBefore = width;
      const target = Math.max(Math.round(room * 0.5), WIDE_MIN_PX);
      size.set(Number.isFinite(max) ? Math.min(target, max) : target);
      syncBar();
    }

    // ── actions ──
    async function answerRun(method, payload) {
      const reply = await call(method, payload);
      if (reply.ok === true && reply.run) { setRun(reply.run); update(); return; }
      if (method === 'start' && reply.reason === 'low_gpu_memory' && Number.isFinite(reply.needMb) && Number.isFinite(reply.freeMb) && payload.projectId === view.projectId) {
        view.gpuWarning = { needMb: reply.needMb, freeMb: reply.freeMb, state: currentRun().state, generation: currentRun().generation };
        update();
        return;
      }
      if (reply.reason === 'needs_confirmation') void refresh();
      else if (reply.ok !== true) flash(jt('chat.liveView.error.action', 'That did not work. Try again.'));
    }

    const closeMenu = () => {
      const menu = shell?.querySelector('.lv-pop');
      if (menu && !menu.hidden) windowRef.inventory.popover.close(menu);
    };
    const menuItem = (action, label) => fromHtml(inventoryButton()({ plain: true, className: 'bu-menu-item', label, dataset: { 'live-action': action } }));

    function openMenu() {
      const menu = shell?.querySelector('.lv-pop');
      if (!menu) return;
      if (!menu.hidden) { closeMenu(); return; }
      menu.replaceChildren(menuItem('behind', jt('chat.liveView.menu.behind', 'Send behind Jenny')), menuItem('edit', jt('chat.liveView.menu.edit', 'Edit run command')));
      syncBar();
      windowRef.inventory.popover.open(menu, { trigger: moreButton });
    }

    const ids = () => ({ projectId: view.projectId, chatId: focusedChat() });
    const ACTIONS = {
      run: () => answerRun('start', ids()),
      restart: () => answerRun('restart', ids()),
      'start-anyway': () => { view.gpuWarning = null; update(); return answerRun('start', { ...ids(), anyway: true }); },
      'cancel-gpu': () => { view.gpuWarning = null; update(); },
      stop: () => answerRun('stop', { projectId: view.projectId, mode: 'ask' }),
      force: () => answerRun('stop', { projectId: view.projectId, mode: 'force' }),
      show: () => call('showWindow', { projectId: view.projectId, place: 'front' }),
      behind: () => { closeMenu(); return call('showWindow', { projectId: view.projectId, place: 'behind' }); },
      edit: () => { closeMenu(); form.edit(); },
      amend: () => form.go('form'),
      review: () => form.review(),
      confirm: () => form.save(),
      'send-error': () => form.sendError(currentRun()),
      wide: toggleWide,
      more: openMenu,
    };

    function handlePanelClick(event) {
      if (disposed || !inMode()) return;
      if (event.target?.closest?.('.lv-picture[role="button"]')) { void ACTIONS.show(); return; }
      const button = event.target?.closest?.('[data-live-action]');
      if (button && !button.disabled) void ACTIONS[button.dataset.liveAction]?.();
    }

    function handlePanelKeydown(event) {
      if (disposed || !inMode()) return;
      const target = event.target;
      if (target?.closest?.('.lv-picture[role="button"]') && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        void ACTIONS.show();
      } else if (event.key === 'Enter' && target?.tagName === 'INPUT' && target.dataset?.lvField) {
        event.preventDefault();
        form.review();
      }
    }

    function handleSwitch(event) {
      if (event.detail?.id !== SWITCH_ID || typeof bridge()?.setRestartAfterChanges !== 'function') return;
      const on = event.detail.checked === true;
      const projectId = view.projectId;
      view.restartAfter = on;
      void call('setRestartAfterChanges', { projectId, on }).then((reply) => {
        if (reply.ok === false && view.projectId === projectId) { view.restartAfter = !on; toggleModule.setChecked(event.target, !on); }
      });
    }

    // ── mounting ──
    function prepareSurface(surface) {
      surface.detailEmpty?.classList?.add('hidden');
      surface.detailPanel?.classList?.remove('hidden');
      surface.metaPane?.classList?.add('hidden');
      for (const node of [surface.saveButton, surface.revertButton, surface.revealButton, surface.openExternalButton, surface.deleteButton, surface.jumpButton,
        surface.editorShell, surface.dirtyBadge]) node?.classList?.add('hidden');
      if (surface.detailNote) surface.detailNote.textContent = '';
      surface.previewContent?.classList?.remove('hidden');
    }

    function mountShell(host) {
      shell = [...host.children].find((node) => node.classList.contains('lv-shell')) || null;
      if (shell) { body = shell.querySelector('.lv-body'); return; }
      const pending = typeof bridge()?.setRestartAfterChanges !== 'function';
      const switchHtml = toggleModule.toggleSwitch({
        id: SWITCH_ID, label: jt('chat.liveView.restartSwitch', "Restart after Jenny's changes"), checked: true, disabled: pending, className: 'lv-restart-switch',
        tooltip: pending ? jt('chat.liveView.restartSwitchPending', 'Restart after changes is not available yet.') : jt('chat.liveView.restartSwitchHelp', 'Ends the game in progress when Jenny changes the code.'),
      });
      host.innerHTML = '<div class="bu-shell lv-shell"><div class="lv-body"></div><div class="bu-status lv-line hidden" data-quiet="false"><div class="bu-line"><span class="bu-dot" aria-hidden="true"></span>'
        + `<span class="bu-status-text" role="status"></span><span class="bu-line-end hidden">${switchHtml}</span></div></div><p class="lv-note lv-flash hidden" role="status"></p>`
        + `${windowRef.inventory.popover({ className: 'bu-pop bu-pop-more lv-pop', ariaLabel: jt('chat.liveView.menu.label', 'More') })}</div>`;
      shell = host.firstElementChild;
      body = shell.querySelector('.lv-body');
      bodyKey = '';
    }

    function mountBar() {
      const actions = panelEl.querySelector('.artifact-panel-header-actions');
      if (!actions) return;
      if (!bar?.isConnected) {
        bar = fromHtml(`<div class="bu-bar lv-bar">${iconButton('run', jt('chat.liveView.run', 'Run'), ICONS.run, 'lv-primary')}${iconButton('restart', jt('chat.liveView.restart', 'Restart'), ICONS.restart, 'lv-restart')}${iconButton('show', jt('chat.liveView.showWindow', 'Show window'), ICONS.show, 'lv-show')}<span class="lv-spacer"></span>${iconButton('wide', jt('chat.liveView.wide', 'Wide'), ICONS.wide, 'lv-wide-btn')}</div>`);
        actions.parentElement.insertBefore(bar, actions);
      }
      if (!moreButton?.isConnected) {
        moreButton = fromHtml(iconButton('more', jt('chat.liveView.menu.label', 'More'), ICONS.more, 'lv-more'));
        actions.insertBefore(moreButton, actions.querySelector('#artifactReviewCollapseButton'));
      }
    }

    function unmount() {
      for (const node of [bar, moreButton, shell]) node?.remove();
      bar = moreButton = shell = body = null;
      bodyKey = '';
    }

    // The pull from the panel's render pass.
    function renderRailContent(surface) {
      if (disposed || !surface?.previewContent || !inventoryButton()) return false;
      prepareSurface(surface);
      mountShell(surface.previewContent);
      mountBar();
      if (!view.loaded || view.projectId !== projectOf()) void refresh();
      update();
      return true;
    }

    function handlePanelChanged() {
      if (disposed) return;
      if (!inMode()) unmount();
      update();
    }

    // ── opening, closing and the wiring ──
    function open(options) {
      if (disposed) return false;
      openArtifactRail(MODE, options);
      renderArtifactReviewPanel();
      return true;
    }

    const close = () => { if (isShowing()) toggleArtifactReview(); };
    const onVisibility = () => { if (!disposed) update(); };

    function bind() {
      if (disposed || !panelEl?.addEventListener || panelEl.dataset.liveRunBound) return;
      panelEl.dataset.liveRunBound = listenerToken;
      panelEl.addEventListener('click', handlePanelClick, true);
      panelEl.addEventListener('keydown', handlePanelKeydown, true);
      panelEl.addEventListener('inv-toggle-change', handleSwitch);
      doc.addEventListener('visibilitychange', onVisibility);
      if (typeof windowRef.MutationObserver === 'function') {
        panelObserver = new windowRef.MutationObserver(handlePanelChanged);
        panelObserver.observe(panelEl, { attributes: true, attributeFilter: ['data-artifact-review-mode', 'class'] });
      }
      const api = bridge();
      unsubscribe = [api?.onState?.call(api, handleState), api?.onKeepLastFrame?.call(api, handleKeepLastFrame)].filter((off) => typeof off === 'function');
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      windowRef.clearTimeout(timer);
      windowRef.clearTimeout(flashTimer);
      capture.dispose();
      restoreWidth();
      unsubscribe.forEach((off) => off());
      panelObserver?.disconnect();
      doc.removeEventListener('visibilitychange', onVisibility);
      unmount();
      if (panelEl?.dataset?.liveRunBound !== listenerToken) return;
      panelEl.removeEventListener('click', handlePanelClick, true);
      panelEl.removeEventListener('keydown', handlePanelKeydown, true);
      panelEl.removeEventListener('inv-toggle-change', handleSwitch);
      delete panelEl.dataset.liveRunBound;
      appendClientLog('INFO', 'live_run.panel_disposed', {});
    }

    return { bind, dispose, open, close, toggle: () => (isShowing() ? close() : open()), isOpen: isShowing, renderRailContent, refresh, panelTitle: () => jt('chat.workbench.view.liveView', 'Live') };
  }

  // The shell's side of the wiring lives here so that it costs nothing at startup.
  function connectLiveRunPanel(rails) {
    const { windowRef, ensureArtifactSurface, registerCleanup } = rails;
    const controller = createLiveRunPanel({
      state: rails.state,
      windowRef,
      dom: { artifactReviewPanel: rails.resolveArtifactReviewPanelEl() },
      openArtifactRail: (mode, options) => ensureArtifactSurface()?.openArtifactRail?.(mode, options),
      renderArtifactReviewPanel: () => ensureArtifactSurface()?.renderArtifactReviewPanel?.(),
      toggleArtifactReview: () => ensureArtifactSurface()?.toggleArtifactReview?.(),
      getLayoutHost: () => rails.callbacks?.getChatLayoutHost?.() || null,
      insertIntoComposer: (payload) => windowRef.rendererComposerInsert?.insertIntoComposer?.(payload) === true,
      appendClientLog: rails.appendClientLog,
    });
    controller.bind();
    registerCleanup(() => controller.dispose());
    return controller;
  }

  return { MODE, connectLiveRunPanel, createLiveRunPanel };
});
