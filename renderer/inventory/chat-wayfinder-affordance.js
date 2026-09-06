/* renderer/inventory/chat-wayfinder-affordance.js
 * Transcript Wayfinder affordance shared by unread, pinned prompt, and latest cues.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../shared/string-utils'));
    return;
  }
  root.inventoryChatWayfinderAffordance = factory(root, root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (_root, stringUtils) {
  'use strict';

  var escapeHtml = stringUtils && stringUtils.escapeHtml;
  var sanitizeToken = stringUtils && stringUtils.sanitizeToken;
  if (typeof escapeHtml !== 'function' || typeof sanitizeToken !== 'function') {
    throw new Error('inventoryChatWayfinderAffordance: renderer/shared/string-utils.js must load before this module');
  }

  function buildMarkup(ids) {
    return ''
      + '<div class="chat-wayfinder-affordance" role="status" aria-live="polite" data-chat-wayfinder-state="hidden">'
      + '<button'
      + ' type="button"'
      + ' class="chat-wayfinder-button"'
      + ' id="' + escapeHtml(ids.button) + '"'
      + ' data-chat-wayfinder-action="activate"'
      + ' data-chat-wayfinder-state="hidden"'
      + ' aria-label="Conversation wayfinder"'
      + ' title="Conversation wayfinder"'
      + '>'
      + '<svg class="chat-wayfinder-icon" viewBox="0 0 16 16" aria-hidden="true">'
      + '<path d="M3 12.75h10"></path>'
      + '<path d="M8 3.25v8"></path>'
      + '<path d="M4.75 8 8 11.25 11.25 8"></path>'
      + '</svg>'
      + '<span class="chat-wayfinder-copy">'
      + '<span class="chat-wayfinder-label">Conversation wayfinder</span>'
      + '<span class="chat-wayfinder-detail" hidden></span>'
      + '</span>'
      + '</button>'
      + '</div>';
  }

  function createChatWayfinderAffordance(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var hostId = sanitizeToken(options.hostId, 'chat-wayfinder');
    var buttonId = hostId + '-button';
    var listeners = Object.create(null);
    var rootEl = null;
    var buttonEl = null;
    var labelEl = null;
    var detailEl = null;
    var mountedHost = null;
    var disposed = false;

    function emit(eventName) {
      var subs = listeners[eventName];
      if (!subs || !subs.length) return;
      for (var index = 0; index < subs.length; index += 1) {
        try { subs[index](); } catch (_error) { /* isolate listener failure */ }
      }
    }

    function on(eventName, callback) {
      if (typeof callback !== 'function') return function noopOff() {};
      if (!listeners[eventName]) listeners[eventName] = [];
      listeners[eventName].push(callback);
      return function off() {
        var subs = listeners[eventName];
        if (!subs) return;
        var index = subs.indexOf(callback);
        if (index >= 0) subs.splice(index, 1);
      };
    }

    function handleClick(event) {
      var target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-chat-wayfinder-action="activate"]')
        : null;
      if (!target || !rootEl || !rootEl.contains(target)) return;
      event.preventDefault();
      emit('activate');
    }

    function ensureBuilt() {
      if (disposed || rootEl || !doc) return rootEl;
      var wrapper = doc.createElement('div');
      wrapper.innerHTML = buildMarkup({ button: buttonId });
      rootEl = wrapper.firstElementChild;
      buttonEl = rootEl ? rootEl.querySelector('[data-chat-wayfinder-action="activate"]') : null;
      labelEl = rootEl ? rootEl.querySelector('.chat-wayfinder-label') : null;
      detailEl = rootEl ? rootEl.querySelector('.chat-wayfinder-detail') : null;
      if (rootEl) {
        rootEl.addEventListener('click', handleClick);
      }
      return rootEl;
    }

    function mount(host) {
      if (disposed) return null;
      var targetHost = host || mountedHost;
      var root = ensureBuilt();
      if (!targetHost || !root) return null;
      if (root.parentElement !== targetHost) {
        targetHost.appendChild(root);
      }
      mountedHost = targetHost;
      mountedHost.hidden = false;
      return root;
    }

    function unmount() {
      if (rootEl && rootEl.parentElement) {
        rootEl.parentElement.removeChild(rootEl);
      }
      if (mountedHost) {
        mountedHost.hidden = true;
      }
    }

    function setState(nextState) {
      var model = nextState || {};
      var root = ensureBuilt();
      if (!root || !buttonEl) return;
      var visible = model.visible === true;
      var stateName = String(model.state || (visible ? 'latest' : 'hidden')).trim() || 'hidden';
      var label = String(model.label || 'Conversation wayfinder').trim() || 'Conversation wayfinder';
      var detail = String(model.detail || '').trim();
      root.dataset.chatWayfinderState = stateName;
      buttonEl.dataset.chatWayfinderState = stateName;
      root.classList.toggle('is-visible', visible);
      buttonEl.disabled = !visible;
      buttonEl.setAttribute('aria-label', label);
      buttonEl.setAttribute('title', detail ? label + ': ' + detail : label);
      if (labelEl) {
        labelEl.textContent = label;
      }
      if (detailEl) {
        detailEl.textContent = detail;
        detailEl.hidden = !detail;
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (rootEl) {
        rootEl.removeEventListener('click', handleClick);
      }
      unmount();
      Object.keys(listeners).forEach(function clearListeners(eventName) {
        listeners[eventName] = [];
      });
      rootEl = null;
      buttonEl = null;
      labelEl = null;
      detailEl = null;
      mountedHost = null;
    }

    return {
      dispose: dispose,
      getRootElement: function getRootElement() { return rootEl; },
      mount: mount,
      on: on,
      setState: setState,
      unmount: unmount,
    };
  }

  return { createChatWayfinderAffordance: createChatWayfinderAffordance };
});
