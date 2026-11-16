/**
 * Model Library › engine blocks (UMD).
 *
 * The optional engine blocks that each follow a kill switch: the image engines
 * (`tools_image_generate_enabled`) and the managed NInfer runtime (`ninfer`,
 * row 54). The section controller owns the grid; this helper owns the block
 * controllers (creation behind their flags, a rebind on every parent render,
 * teardown) so the section stays under its line ceiling and the blocks follow
 * one lifecycle. It also registers the llama-server, NInfer, stable-diffusion.cpp
 * and ComfyUI rows on the "Engines and providers" table (model-library-services.js);
 * their controls render into the shared Manage drawer, not the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.modelLibraryEngineBlocks = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var IMAGE_ENGINE_HOST_ID = 'modelLibraryImageEngineHost';
  var NINFER_HOST_ID = 'modelLibraryNinferHost';
  var FOLDERS_HOST_ID = 'modelLibraryFoldersHost';
  var LLAMA_ID = 'llama-server';
  var NINFER_ID = 'ninfer';
  var SDCPP_ID = 'sdcpp';
  var COMFY_ID = 'comfyui';
  var SERVICES_READY_EVENT = 'model-library-services-ready';

  function resolveImageEngineModule() {
    return (root && root.modelLibraryImageEngine)
      || (typeof require === 'function' ? require('./model-library-image-engine') : null);
  }

  function resolveNinferModule() {
    return (root && root.modelLibraryNinfer)
      || (typeof require === 'function' ? require('./model-library-ninfer') : null);
  }

  var escapeHtml = function (value) {
    return ((root && root.stringUtils) || require('../../shared/string-utils')).escapeHtml(value);
  };

  // deps: { windowRef, documentRef, imageEngineEnabled(), ninferEnabled(), ninfer: { onState, onUse },
  //   llamaServerEnabled(), llamaServer() -> { running, port, fileCount, unavailable },
  //   folders() -> the GGUF folders controller or null, services() -> the services instance or null }
  function createModelLibraryEngineBlocks(deps) {
    var d = deps || {};
    var disposed = false;
    var llamaServerEnabled = typeof d.llamaServerEnabled === 'function' ? d.llamaServerEnabled : function () { return false; };
    var ninferPrimed = false;
    var ninferUnsubscribe = null;
    var servicesRef = null;
    var listening = false;
    var imageEngineEnabled = typeof d.imageEngineEnabled === 'function' ? d.imageEngineEnabled : function () { return false; };
    var ninferEnabled = typeof d.ninferEnabled === 'function' ? d.ninferEnabled : function () { return false; };
    var blocks = {
      imageEngine: { controller: null, enabled: imageEngineEnabled, hostId: IMAGE_ENGINE_HOST_ID, create: createImageEngine },
      ninfer: { controller: null, enabled: ninferEnabled, hostId: NINFER_HOST_ID, create: createNinfer },
    };

    function createImageEngine() {
      var module = resolveImageEngineModule();
      if (!module || typeof module.createModelLibraryImageEngineController !== 'function') return null;
      return module.createModelLibraryImageEngineController({
        windowRef: d.windowRef, documentRef: d.documentRef, isEnabled: imageEngineEnabled, hostId: IMAGE_ENGINE_HOST_ID,
        onChange: syncImageRows,
      });
    }

    function createNinfer() {
      var module = resolveNinferModule();
      if (!module || typeof module.createModelLibraryNinferController !== 'function') return null;
      var ninferDeps = d.ninfer || {};
      return module.createModelLibraryNinferController({
        windowRef: d.windowRef, documentRef: d.documentRef, isEnabled: ninferEnabled, hostId: NINFER_HOST_ID, externalWatch: true, // watchNinfer owns onChanged
        onState: function () {
          try { if (typeof ninferDeps.onState === 'function') ninferDeps.onState(); } finally { syncNinferRow(); }
        },
        onUse: ninferDeps.onUse,
      });
    }

    function services() {
      if (typeof d.services === 'function') return d.services() || null;
      var module = (d.windowRef && d.windowRef.modelLibraryServices) || root.modelLibraryServices;
      return module && typeof module.shared === 'function' ? module.shared({ documentRef: d.documentRef, windowRef: d.windowRef }) : null;
    }

    function llamaStatus() {
      var info = typeof d.llamaServer === 'function' ? d.llamaServer() : null;
      if (!info || info.unavailable) return { text: jt('settings.models.services.llama.unavailable', 'Not available'), tone: 'off', set: true };
      if (info.running) return { text: jt('settings.models.services.llama.serving', 'Serving on :{port}', { port: info.port }), tone: 'ready', set: true };
      var count = Number(info.fileCount) || 0;
      return { text: jtn('settings.models.services.llama.idle', count, { count: count }, 'Idle · {count} file', 'Idle · {count} files'), tone: 'ready', set: true };
    }

    var llamaEntry = {
      id: LLAMA_ID, kind: 'chat', order: 20, name: 'llama-server',
      what: jt('settings.models.services.llama.what', 'Runs GGUF files, with MTP where a model has a drafter'),
      getStatus: llamaStatus,
      renderDrawer: function (body) {
        body.innerHTML = '<p class="mp-quiet">' + escapeHtml(jt('settings.models.services.llama.description', 'Runs GGUF files directly. A GGUF folder holds one folder per model, with its drafter and projector beside it.'))
          + '</p><div id="' + FOLDERS_HOST_ID + '"></div>';
        var folders = typeof d.folders === 'function' ? d.folders() : null;
        if (folders) { folders.bind(); folders.render(); }
      },
    };

    var ninferEntry = {
      id: NINFER_ID, kind: 'chat', order: 30, name: 'NInfer',
      what: jt('settings.models.services.ninfer.what', 'Fast engine built for the RTX 5090'),
      getStatus: function () {
        var controller = blocks.ninfer.controller;
        return controller ? controller.summary() : null; // the registry words a missing status
      },
      renderDrawer: function (body) {
        body.innerHTML = '<div id="' + NINFER_HOST_ID + '"></div>';
        var controller = controllerFor(blocks.ninfer);
        if (controller) { controller.bind(); controller.render(); }
      },
    };

    function imageEntry(id, order, name, what, actionLabel, help) {
      var part = id === SDCPP_ID ? 'sdcpp' : 'comfyui';
      return {
        id: id, kind: 'image', order: order, name: name, what: what, actionLabel: actionLabel,
        getStatus: function () {
          var controller = blocks.imageEngine.controller;
          return controller ? controller.summary(part) : null;
        },
        renderDrawer: function (body) {
          body.innerHTML = '<p class="mp-quiet">' + escapeHtml(help) + '</p>';
          var host = body.ownerDocument.createElement('div');
          host.id = IMAGE_ENGINE_HOST_ID;
          host.setAttribute('data-image-engine-part', part);
          body.appendChild(host);
          var controller = controllerFor(blocks.imageEngine);
          if (controller) { controller.bind(); controller.render(); }
        },
      };
    }

    var sdcppEntry = imageEntry(SDCPP_ID, 10, 'stable-diffusion.cpp', jt('settings.models.services.sdcpp.what', 'Draws images in chat'),
      jt('settings.models.services.sdcpp.install', 'Install…'),
      jt('settings.models.services.sdcpp.description', 'Lets Jenny draw images in chat from models you already have. The models and their licences are yours.'));
    var comfyEntry = imageEntry(COMFY_ID, 20, 'ComfyUI', jt('settings.models.services.comfy.what', 'Draws images with your own ComfyUI install'),
      jt('settings.models.services.setUp', 'Set up…'),
      jt('settings.models.services.comfy.description', 'Choose the ComfyUI_windows_portable folder you already use. Jenny reads its models folder and never changes it. For each image she starts ComfyUI in the background, then closes it.'));

    // Registration is idempotent: a known row only re-reads its status.
    function syncRow(entry, wanted) {
      var svc = servicesRef = services() || servicesRef;
      if (!svc) return;
      if (disposed || !wanted) { svc.unregister(entry.id); return; }
      if (svc.has(entry.id)) svc.refresh(entry.id);
      else svc.register(entry);
    }

    // A row exists only once the engine state is known; ComfyUI also follows its own kill switch.
    function syncImageRows() {
      var controller = blocks.imageEngine.controller;
      var on = Boolean(controller) && imageEngineEnabled();
      syncRow(sdcppEntry, on && controller.summary('sdcpp') !== null);
      syncRow(comfyEntry, on && controller.summary('comfyui') !== null);
    }

    function syncNinferRow() {
      var controller = blocks.ninfer.controller;
      syncRow(ninferEntry, Boolean(controller) && ninferEnabled() && controller.summary() !== null);
    }

    // The NInfer state also changes while its drawer is closed (a set-up in
    // progress): the row listens for itself and lets the controller re-read.
    function watchNinfer(controller) {
      var shell = d.windowRef && d.windowRef.jennyShell;
      var api = shell && shell.ninfer;
      if (!api || typeof api.onChanged !== 'function') return;
      try {
        var stop = api.onChanged(function () { void controller.refresh(); });
        if (typeof stop === 'function') ninferUnsubscribe = stop;
      } catch (_error) { /* the row then updates with the next section render */ }
    }

    function unwatchNinfer() {
      ninferPrimed = false;
      if (typeof ninferUnsubscribe === 'function') {
        try { ninferUnsubscribe(); } catch (_error) { /* best effort */ }
      }
      ninferUnsubscribe = null;
    }


    function controllerFor(block) {
      if (disposed || !block.enabled()) return null;
      if (!block.controller) {
        block.controller = block.create();
        // The image rows read the engine state while no drawer is open.
        if (block === blocks.imageEngine && block.controller) { block.controller.watch(); void block.controller.refresh(); }
      }
      return block.controller;
    }

    function renderImageEngine() {
      var block = blocks.imageEngine;
      var controller = controllerFor(block);
      if (!controller) {
        // The flag went off: drop the controller and its bridge subscription.
        if (block.controller) block.controller.dispose();
        block.controller = null;
      } else if (d.documentRef && d.documentRef.getElementById && d.documentRef.getElementById(IMAGE_ENGINE_HOST_ID)) {
        controller.bind();
        controller.render();
      }
      syncImageRows();
    }

    function renderNinfer() {
      var controller = controllerFor(blocks.ninfer);
      if (!controller) {
        if (blocks.ninfer.controller) blocks.ninfer.controller.dispose();
        blocks.ninfer.controller = null;
        unwatchNinfer();
        syncNinferRow();
        return;
      }
      if (!ninferPrimed) {
        ninferPrimed = true;
        watchNinfer(controller);
        void controller.refresh();
      }
      var hostNode = d.documentRef && d.documentRef.getElementById ? d.documentRef.getElementById(NINFER_HOST_ID) : null;
      if (hostNode) { controller.bind(); controller.render(); }
      syncNinferRow();
    }

    // The services module loads with the Settings page, after the first render.
    function onServicesReady() { if (!disposed) render(); }

    function render() {
      if (!listening && d.documentRef && typeof d.documentRef.addEventListener === 'function') {
        listening = true;
        d.documentRef.addEventListener(SERVICES_READY_EVENT, onServicesReady);
      }
      renderNinfer();
      renderImageEngine();
      syncRow(llamaEntry, llamaServerEnabled());
    }

    function ninfer() {
      return controllerFor(blocks.ninfer);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (listening) d.documentRef.removeEventListener(SERVICES_READY_EVENT, onServicesReady);
      listening = false;
      unwatchNinfer();
      var svc = servicesRef;
      if (svc) { [LLAMA_ID, NINFER_ID, SDCPP_ID, COMFY_ID].forEach(function (id) { svc.unregister(id); }); }
      Object.keys(blocks).forEach(function (key) {
        if (blocks[key].controller) blocks[key].controller.dispose();
        blocks[key].controller = null;
      });
    }

    return { render: render, ninfer: ninfer, dispose: dispose };
  }

  return { createModelLibraryEngineBlocks: createModelLibraryEngineBlocks, NINFER_HOST_ID: NINFER_HOST_ID, IMAGE_ENGINE_HOST_ID: IMAGE_ENGINE_HOST_ID };
});
