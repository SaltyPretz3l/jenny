/* renderer/app/renderer-app-shell-bindings-mcp.js
 * Controllers first bind against placeholder flags, reactivate after authoritative flags hydrate, and fail soft independently.
 */
(function (root) {
  'use strict';

  function bindSettingsSectionControllers(ctx) {
    const {
      state,
      windowRef,
      documentRef,
      callbacks,
      constants,
      registerCleanup,
      controllers: appControllers,
    } = ctx || {};
    const factories = [
      (windowRef.rendererMcpServers || {}).createMcpServersController,
      (windowRef.rendererKnowledgeFolders || {}).createKnowledgeFoldersController,
      (windowRef.rendererOllamaHealth || {}).createOllamaHealthController,
      (windowRef.rendererPluginsSettingsUtils || {}).createPluginsSettingsController,
    ];
    const controllers = [];
    const pluginViewController = windowRef.rendererPluginViewHost?.createPluginViewHostController?.({
      state,
      windowRef,
      documentRef,
      setActiveView: (...a) => callbacks?.setActiveView?.(...a),
      openSettingsSection: (...a) => callbacks?.openSettingsSection?.(...a),
      appendClientLog: (...a) => callbacks?.appendClientLog?.(...a),
    }) || null;
    pluginViewController?.bind?.();
    if (pluginViewController) {
      controllers.push(pluginViewController);
      registerCleanup?.(() => pluginViewController.dispose?.());
    }
    const pluginSessionController = windowRef.rendererPluginSessionController
      ?.createPluginSessionController?.({
        state,
        windowRef,
        documentRef,
        viewHost: pluginViewController,
        callbacks: {
          handleCreateSession: (...a) => callbacks?.handleCreateSessionWithWorkspace?.(...a),
          setActiveView: (...a) => callbacks?.setActiveView?.(...a),
          showToastMessage: (...a) => callbacks?.showToastMessage?.(...a),
          openSettingsSection: (...a) => callbacks?.openSettingsSection?.(...a),
          appendClientLog: (...a) => callbacks?.appendClientLog?.(...a),
        },
      }) || null;
    pluginSessionController?.bind?.();
    if (pluginSessionController) {
      controllers.push(pluginSessionController);
      registerCleanup?.(() => pluginSessionController.dispose?.());
    }
    for (const factory of factories) {
      if (typeof factory !== 'function') {
        continue;
      }
      // Superset of deps: MCP consumes showToastMessage/showSessionActionError/
      // constants; Knowledge/Ollama ignore the extras. One shape keeps this loop
      // uniform.
      const controller = factory({
        state,
        windowRef,
        documentRef,
        appendClientLog: (...a) => callbacks?.appendClientLog?.(...a),
        showToastMessage: (...a) => callbacks?.showToastMessage?.(...a),
        showSessionActionError: (...a) => callbacks?.showSessionActionError?.(...a),
        openSettingsSection: (...a) => callbacks?.openSettingsSection?.(...a),
        setActiveView: (...a) => callbacks?.setActiveView?.(...a),
        constants: { TOAST_SOURCE: constants?.TOAST_SOURCE },
        openPluginView: (...a) => pluginViewController?.open?.(...a),
        overlayManager: appControllers?.overlayManager || null,
      }) || null;
      if (!controller) {
        continue;
      }
      controller.bind?.();
      controller.render?.();
      controllers.push(controller);
      registerCleanup?.(() => controller.dispose?.());
    }
    return {
      // Re-run each controller's idempotent feature (re)activation after the
      // real feature flags hydrate. Per-controller isolation: one controller's
      // re-sync throwing must not block the others.
      reactivate() {
        for (const controller of controllers) {
          try {
            controller.syncFeatureState?.();
          } catch (_error) {
            /* fail-soft */
          }
        }
      },
    };
  }

  root.rendererAppShellBindingsMcp = {
    bindSettingsSectionControllers,
  };
})(window);
