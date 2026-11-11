(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererAppSound = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (globalRoot) {
  'use strict';

  const ON = '<path d="M3.5 7.75v4.5h2.75L10 15.5v-11L6.25 7.75z"/><path d="M13 7.5a3.6 3.6 0 0 1 0 5"/><path d="M15.2 5.3a6.7 6.7 0 0 1 0 9.4"/>';
  const OFF = '<path d="M3.5 7.75v4.5h2.75L10 15.5v-11L6.25 7.75z"/><path d="M13.25 8l4 4M17.25 8l-4 4"/>';

  function create(env) {
    const root = env || globalRoot;
    const jt = (root.jennyI18n && root.jennyI18n.t) || root.jennyI18nFallback || ((_key, text) => text);
    const actionButton = root.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
    const icon = (paths, cls = '') => `<svg class="${cls}" viewBox="0 0 20 20" aria-hidden="true">${paths}</svg>`;

    let muted = false;
    let audible = false;
    let chats = new Map();
    let last = '[false,false,{}]';
    let version = 0;
    let listener = null;
    let button = null;

    const chatSound = (id) => chats.get(String(id)) || '';

    function rowMarkup(session) {
      const sound = chatSound(session?.id);
      if (!sound || !actionButton) return '';
      const label = muted ? jt('sidebar.chats.soundAppMuted', 'Jenny is muted')
        : sound === 'muted' ? jt('sidebar.chats.soundUnmute', 'Unmute this chat')
        : jt('sidebar.chats.soundMute', 'Mute this chat');
      return actionButton({
        plain: true,
        className: 'session-row__sound',
        title: label,
        ariaLabel: label,
        disabled: muted,
        dataset: { 'session-sound': session.id },
        trustedHtml: icon(sound === 'muted' ? OFF : ON),
      });
    }

    const guarded = async (call) => {
      try { return await call(); } catch { return undefined; }
    };

    function paint() {
      if (!button) return;
      const label = muted ? jt('titlebar.sound.unmute', 'Unmute Jenny') : jt('titlebar.sound.mute', 'Mute Jenny');
      button.classList.toggle('hidden', !(audible || muted));
      button.dataset.muted = String(muted);
      button.title = label;
      button.setAttribute('aria-label', label);
      button.querySelector('svg').innerHTML = muted ? OFF : ON;
    }

    function apply(next) {
      const key = JSON.stringify([next.muted, next.audible, next.chats]);
      version += 1;
      if (key === last) return;
      last = key;
      muted = next.muted;
      audible = next.audible;
      chats = new Map(Object.entries(next.chats));
      paint();
      if (listener) listener();
    }

    function mountButton(doc, bridge) {
      const pill = doc.getElementById('titlebarPalettePill');
      if (!actionButton || !pill) return;
      pill.insertAdjacentHTML('beforebegin', actionButton({
        plain: true,
        className: 'titlebar-icon-button',
        domId: 'titlebarSoundButton',
        title: jt('titlebar.sound.mute', 'Mute Jenny'),
        trustedHtml: icon(ON, 'titlebar-icon'),
      }));
      button = doc.getElementById('titlebarSoundButton');
      paint();
      button.addEventListener('click', () => void guarded(() => bridge.setMuted({ muted: !muted })));
    }

    function init() {
      const bridge = root.jennyShell && root.jennyShell.appSound;
      const doc = root.document;
      if (!bridge || !doc) return;
      mountButton(doc, bridge);
      bridge.onChanged(apply);
      const seen = version;
      void guarded(() => bridge.getState()).then((reply) => {
        if (version === seen && reply && reply.ok === true) apply(reply);
      });
      doc.addEventListener('click', (event) => {
        const target = event.target.closest?.('[data-session-sound]');
        if (target && !target.disabled) void guarded(() => root.jennyShell.browserUse.toggleSound({ session_id: target.dataset.sessionSound }));
      });
    }

    init();
    return { chatSound, rowMarkup, onChatsChanged: (fn) => { listener = fn; } };
  }

  const instance = create(globalRoot);
  instance.create = create;
  return instance;
});
