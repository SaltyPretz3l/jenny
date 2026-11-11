/* renderer/chat/renderer-render-pipeline-chrome-hero.js
 * The empty-chat hero (title, subtitle, setup resume action, model-state
 * actions) of the chrome pipeline. Split out of
 * renderer-render-pipeline-chrome.js, which composes it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-hero-model-state'));
    return;
  }
  root.rendererRenderPipelineChromeHero = factory(root.rendererHeroModelState);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (heroModelState) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const { resolveDefaultTitle } = globalRef.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : {});
  function createHeroChrome(deps) {
    const {
      state,
      dom = {},
      getPaneSessionId,
      getVisibleSessionMessages,
      setDatasetIfChanged,
    } = deps;
    const {
      heroAvatar = null,
      heroTitle = null,
      heroSubtitle = null,
      heroRuntimeHint = null,
    } = dom;

    let resumeSetupButton = null;
    let setupFootnote = null;
    let heroActions = null;
    let heroActionsHtml = '';
    const setHeroText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
    function handleResumeSetup() {
      if (typeof globalRef.jennySetupResume === 'function') globalRef.jennySetupResume();
    }

    function syncHeroSetupAction(show, footnote) {
      const canResume = show && typeof globalRef.jennySetupResume === 'function';
      const actionButton = globalRef.inventoryActionButton;
      const ownerDocument = heroSubtitle?.ownerDocument;
      if (canResume && !resumeSetupButton && ownerDocument && typeof actionButton === 'function') {
        const template = ownerDocument.createElement('template');
        template.innerHTML = actionButton({
          id: 'chat-resume-setup', variant: 'primary', className: 'hero-resume-setup',
          label: jt('chat.pipelineChrome.resumeSetup', 'Resume setup'),
        });
        resumeSetupButton = template.content.firstElementChild;
        resumeSetupButton.addEventListener('click', handleResumeSetup);
        heroSubtitle.after(resumeSetupButton);
      }
      if (show && !setupFootnote && ownerDocument) {
        setupFootnote = ownerDocument.createElement('p');
        setupFootnote.className = 'hero-setup-footnote';
        (resumeSetupButton || heroSubtitle).after(setupFootnote);
      }
      resumeSetupButton?.classList.toggle('hidden', !canResume);
      setHeroText(setupFootnote, footnote);
      setupFootnote?.classList.toggle('hidden', !show || !footnote);
    }

    function setupHeroSubtitle(snapshot) {
      const steps = snapshot.steps;
      if (!steps || typeof steps.workspaceRoot !== 'string'
        || (typeof steps.localModel !== 'string' && typeof steps.endpoint !== 'string')) {
        return jt('chat.pipelineChrome.setupModelAndFolder', 'Choose a model route and a workspace folder to finish.');
      }
      const modelMissing = steps.localModel !== 'done' && steps.endpoint !== 'done';
      const folderMissing = steps.workspaceRoot !== 'done';
      if (modelMissing && folderMissing) {
        return jt('chat.pipelineChrome.setupModelAndFolder', 'Choose a model route and a workspace folder to finish.');
      }
      if (modelMissing) return jt('chat.pipelineChrome.setupModel', 'Choose a model route to finish.');
      if (folderMissing) return jt('chat.pipelineChrome.setupFolder', 'Choose a workspace folder so file tools can work.');
      return jt('chat.pipelineChrome.setupOptionalSteps', 'A few optional steps are left.');
    }

    function renderHero() {
      const paneSessionId = getPaneSessionId();
      const activeSession = state.sessions.find((session) => session.id === paneSessionId);
      const sessionMessages = activeSession ? getVisibleSessionMessages(activeSession.id) : [];
      const hasMessages = sessionMessages.length > 0;
      const heroStage = heroTitle ? heroTitle.closest('.hero-stage') : null;
      const pluginSession = activeSession?.session_type === 'plugin';
      const setupSnapshot = state.setup || {};
      const setupIncomplete = setupSnapshot.loaded === true && setupSnapshot.setupComplete === false;
      const showSetup = !pluginSession && !hasMessages && setupIncomplete;
      heroStage?.classList.toggle('hero-setup-incomplete', showSetup);
      const view = !pluginSession && !hasMessages ? heroModelState.deriveHeroView(state) : null;
      syncHeroSetupAction(showSetup, showSetup ? heroModelState.setupFootnote(view) : '');
      const copy = view && !showSetup ? heroModelState.heroCopy(view) : null;
      if (copy?.actionsHtml && !heroActions && heroSubtitle) {
        heroActions = heroSubtitle.ownerDocument.createElement('div');
        heroActions.className = 'hero-actions';
        heroSubtitle.after(heroActions);
      }
      const actionsHtml = copy?.actionsHtml || '';
      if (heroActions && heroActionsHtml !== actionsHtml) {
        heroActions.innerHTML = actionsHtml;
        heroActionsHtml = actionsHtml;
      }
      heroActions?.classList.toggle('hidden', !actionsHtml);
      if (heroStage && copy) setDatasetIfChanged(heroStage, 'modelState', view.kind);
      else if (heroStage?.hasAttribute('data-model-state')) heroStage.removeAttribute('data-model-state');
      if (heroStage) heroStage.classList.toggle('hero-plugin-session', pluginSession);
      if (pluginSession) {
        if (heroStage) heroStage.classList.toggle('hidden', false);
        setHeroText(heroAvatar, 'J');
        heroAvatar.classList.toggle('hidden', !hasMessages);
        setHeroText(heroTitle, activeSession?.title || jt('chat.chrome.pluginSession', 'Plugin session'));
        setHeroText(heroSubtitle, hasMessages
          ? jt('chat.pipelineChrome.pluginTranscriptReadOnly', 'This saved plugin transcript is read-only in Jenny.')
          : jt('chat.pipelineChrome.openProviderWorkspace', 'Open the provider workspace to begin.'));
        if (heroRuntimeHint) {
          setHeroText(heroRuntimeHint, '');
          heroRuntimeHint.classList.toggle('hidden', true);
        }
        return;
      }
      if (heroStage) heroStage.classList.toggle('hidden', false);
      setHeroText(heroAvatar, 'J');
      heroAvatar.classList.toggle('hidden', !hasMessages);
      if (hasMessages) {
        setHeroText(heroTitle, resolveDefaultTitle(activeSession?.title));
        setHeroText(heroSubtitle, jt('chat.pipelineChrome.continueOrBranch', 'Continue the active conversation or begin a fresh branch.'));
      } else if (setupIncomplete) {
        setHeroText(heroTitle, jt('chat.pipelineChrome.finishSetup', "Let's finish setting up Jenny"));
        setHeroText(heroSubtitle, setupHeroSubtitle(setupSnapshot));
      } else {
        setHeroText(heroTitle, copy.title);
        setHeroText(heroSubtitle, copy.subtitle);
      }
      if (heroRuntimeHint) {
        setHeroText(heroRuntimeHint, copy?.hint || '');
        heroRuntimeHint.classList.toggle('hidden', !copy?.hint);
      }
    }

    function dispose() {
      resumeSetupButton?.removeEventListener('click', handleResumeSetup);
      resumeSetupButton?.remove();
      setupFootnote?.remove();
      heroActions?.remove();
    }

    return { renderHero, dispose };
  }

  return { createHeroChrome };
});
