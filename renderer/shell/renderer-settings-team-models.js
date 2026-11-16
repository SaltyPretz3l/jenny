/* Settings > Team, the "Model sharing" groups (row 123, slice 6-7; TEAM_MODEL_SHARING_SPEC "6-7 as built", the
 * owner's picks fork 4 A):
 * - the host's group, on the owner's page after "GPU use" and before "Activity": the switch "Let members send each
 *   other models" (off = `hostModelRelay { flowing: 0 }`, on = the "At the same time" number), the question when
 *   models are passing through, the line that says how many pass now (`host.model_relay.passing`, which the host
 *   reports as a count only), "At the same time" (1 to 4), the owner's own "Sending and receiving models" fact and
 *   "Limit my sending speed";
 * - a member's group, after "Share this PC's GPU": "Sending and receiving models" as a fact (On or Off and why) and
 *   "Limit my sending speed" (`modelSetRate`), one pair per team when this PC is in more than one.
 * The kill switch (JENNY_ENABLE_TEAM_MODEL_SHARING=0, the model store's `killed`) is this PC's sending and receiving
 * only (decision 1): the fact row says it and the speed is greyed, for the owner and a member alike; the host's switch
 * and "At the same time" run on the host and are never greyed or redrawn by it. Force local greys both of those with
 * its reason. The page (renderer-settings-team-section.js) places the groups and hands each call its context
 * `{ data, call, run, render, confirm, setConfirm }`; the model store (renderer-team-model-store.js) is held while
 * the page shows. The host's name comes from `modelReceivers` once per team and visit; it and the team's name are
 * hostile text, cleaned and cut to one bound. Shared sentences come from the team strings' `modelWords`. Markup through
 * the inventory primitives and the page's builders only; every value is escaped. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-team-strings'), require('./renderer-settings-team-view'), require('../team/renderer-team-model-store'));
    return;
  }
  root.rendererSettingsTeamModels = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView, root.rendererTeamModelStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, view, storeModule) {
  'use strict';

  const W = words.modelWords;

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const RATES = Object.freeze([0, 1, 5, 10, 25]);
  const MAX_FLOWING = 4;
  const DEFAULT_FLOWING = 2;

  let lastOn = DEFAULT_FLOWING; // the number the switch turns back on with (the last one seen above 0)
  let held = null; // [release, unsubscribe] while the page shows
  const hosts = new Map(); // team id -> the host's display name, or '' while asked / not known
  const pending = new Map(); // team id -> the speed asked for, until main answers

  function inv() { return globalThis.inventory || {}; }
  function modelStore() { const m = globalThis.rendererTeamModelStore; return m && typeof m.getModelStore === 'function' ? m.getModelStore() : null; }
  function killed(store) { return Boolean(store && store.teams().some((state) => state.killed)); }
  const hostWord = (teamId) => hosts.get(teamId) || '';
  const nameOf = (team) => W.name(words.teamName(team));
  const KILL_SHORT = () => jt('settings.team.models.killShort', 'Model sharing is turned off.');
  const SPEED_OFF = () => jt('settings.team.models.speedOff', 'Model sharing is off, so nothing is sent.');

  // ------------------------------------------------------------- shared rows

  function speedRow(vm, team, state, many, reason) {
    const id = 'teamModelRate-' + team.team_id;
    const value = pending.has(team.team_id) ? pending.get(team.team_id) : (state ? state.rate : 0);
    const rates = RATES.includes(value) ? RATES : RATES.concat(value).sort((a, b) => a - b);
    const select = inv().selectField({ id, ariaLabel: jt('settings.team.models.speed', 'Limit my sending speed'), value: String(value), describedBy: id + '-help',
      disabled: Boolean(reason) || vm.isBusy('model-rate:' + team.team_id), options: rates.map((n) => ({ value: String(n),
        label: n === 0 ? jt('settings.team.models.noLimit', 'No limit') : jt('settings.team.models.rate', '{n} MB a second', { n }) })) });
    return inv().settingsField({ id: id + '-row', variant: 'row', labelFor: id, helpId: id + '-help', controlHtml: select,
      label: many ? jt('settings.team.models.speedIn', 'Limit my sending speed in {team}', { team: nameOf(team) }) : jt('settings.team.models.speed', 'Limit my sending speed'),
      help: reason || jt('settings.team.models.speedHelp', 'Slows the models you send from this PC, so your connection stays free for other things.') });
  }

  // "Sending and receiving models": On or Off, with why in its help.
  function factRow(team, fact, why, many) {
    const id = 'teamModelFact-' + team.team_id;
    return inv().settingsField({ id, variant: 'row', helpId: id + '-help', help: why,
      label: many ? jt('settings.team.models.factIn', 'Sending and receiving models in {team}', { team: nameOf(team) }) : jt('settings.team.models.fact', 'Sending and receiving models'),
      controlHtml: '<span data-team-models-fact="' + escapeHtml(team.team_id) + '">' + escapeHtml(fact) + '</span>' });
  }

  // ------------------------------------------------------------- the host's group

  function relayLine(relay) {
    const text = relay.passing > 0
      ? jtn('settings.team.models.passing', relay.passing, {}, '{count} model is passing through this PC right now.', '{count} models are passing through this PC right now.')
      : jt('settings.team.models.nothing', 'Nothing is passing through right now.');
    return '<div class="team-relay-state">' + inv().statusRow({ tone: 'default', message: text, compact: true }) + '</div>';
  }

  function hostGroup(vm, data, hosted) {
    const relay = data.host && data.host.model_relay;
    if (!relay || !hosted || !hosted.team) return '';
    const store = modelStore();
    const off = killed(store); // this PC's own sending and receiving only
    const on = relay.flowing > 0;
    if (on) lastOn = relay.flowing;
    const busy = vm.isBusy('model-relay');
    const held = vm.forceLocal === true;
    const toggle = inv().toggleSwitch({ id: 'teamModelRelay', domId: 'teamModelRelay', bare: true, labelledBy: 'teamModelRelayTitle', describedBy: 'teamModelRelayHelp',
      checked: on, disabled: busy || held, ...(held ? { tooltip: words.forceLocalText() } : {}) });
    let body = inv().settingsField({ id: 'teamModelRelayRow', variant: 'row', titleId: 'teamModelRelayTitle', helpId: 'teamModelRelayHelp', controlHtml: toggle,
      label: jt('settings.team.models.relay', 'Let members send each other models'),
      help: jt('settings.team.models.relayHelp', 'Model files members send each other pass through this PC and use its network connection. Jenny keeps none of them.') });
    if (on && vm.confirm === 'model-relay-off') {
      body += view.confirmBlock(vm, jtn('settings.team.models.offQuestion', relay.passing, {},
        'Turn off model sharing? {count} model is passing through this PC right now, and it stops. Its offer ends, so the sender has to offer it again after you turn this back on.',
        'Turn off model sharing? {count} models are passing through this PC right now, and they stop. Their offers end, so the senders have to offer them again after you turn this back on.'),
      'model-relay-confirm-off', jt('settings.team.models.turnOff', 'Turn off'), { variant: 'danger', busyKey: 'model-relay' });
    }
    if (on && relay.live) body += relayLine(relay);
    const flowing = inv().selectField({ id: 'teamModelRelayFlowing', ariaLabel: jt('settings.team.models.atOnce', 'At the same time'), value: String(on ? relay.flowing : lastOn),
      describedBy: 'teamModelRelayFlowingHelp', disabled: !on || busy || held,
      options: Array.from({ length: MAX_FLOWING }, (_v, i) => ({ value: String(i + 1), label: String(i + 1) })) });
    body += inv().settingsField({ id: 'teamModelRelayFlowingRow', variant: 'row', labelFor: 'teamModelRelayFlowing', helpId: 'teamModelRelayFlowingHelp', controlHtml: flowing,
      label: jt('settings.team.models.atOnce', 'At the same time'),
      help: held ? words.forceLocalText() : on ? jt('settings.team.models.atOnceHelp', 'How many models pass through this PC at once. Others wait their turn.')
        : jt('settings.team.models.atOnceOff', 'Turn on model sharing to change this.') });
    const state = store ? store.team(hosted.team.team_id) : null;
    body += off ? factRow(hosted.team, jt('settings.team.models.off', 'Off'), W.killed(), false)
      : factRow(hosted.team, on ? jt('settings.team.models.on', 'On') : jt('settings.team.models.off', 'Off'), on ? onFor(hosted.team) : SPEED_OFF(), false);
    body += speedRow(vm, hosted.team, state, false, off ? KILL_SHORT() : !on ? SPEED_OFF() : '');
    return view.group('models', jt('settings.team.models.heading', 'Model sharing'), {
      copy: jt('settings.team.models.hostCopy', 'You and full members can send and receive. Read-only members cannot. You send a model from Settings, Models: ⋯ on the model.'),
      body: body + view.note(vm.errors.models) });
  }

  // ------------------------------------------------------------- a member's group

  // The teams model sharing follows (the model store's rule) that this PC does not host as their owner.
  function memberTeams(data) {
    const hostedHere = data.host && data.host.state === 'running' ? data.host.team_id : null;
    return storeModule.eligibleTeams(data.teams).filter((team) => !(team.team_id === hostedHere && team.role === 'owner'));
  }
  const onFor = (team) => jt('settings.team.models.onFor', 'On for {team}. You send a model from Settings, Models: ⋯ on the model.', { team: nameOf(team) });

  // [fact, why, speed reason] for one team.
  function memberFacts(team, state, off) {
    const host = hostWord(team.team_id);
    const no = jt('settings.team.models.off', 'Off');
    if (off) return [no, W.killed(), KILL_SHORT()];
    if (team.role === 'read_only') return [no, W.readOnly(), jt('settings.team.models.readOnlySpeed', 'Read-only members cannot send models.')];
    if (!state || !state.loaded || state.sharing === 'unknown') {
      const offline = W.notConnected(nameOf(team));
      return [jt('settings.team.models.unknown', 'Not known'), offline, offline];
    }
    if (state.sharing === 'off') return [no, W.hostOff(host), SPEED_OFF()];
    return [jt('settings.team.models.on', 'On'), onFor(team), ''];
  }

  function memberGroup(vm, data) {
    const teams = memberTeams(data);
    if (!teams.length) return '';
    const store = modelStore();
    const off = killed(store);
    const many = teams.length > 1;
    let body = '';
    for (const team of teams) {
      const state = store ? store.team(team.team_id) : null;
      const [fact, why, reason] = memberFacts(team, state, off);
      body += factRow(team, fact, why, many) + speedRow(vm, team, state, many, reason);
    }
    const host = !many ? hostWord(teams[0].team_id) : '';
    return view.group('models-member', jt('settings.team.models.heading', 'Model sharing'), {
      copy: host ? jt('settings.team.models.memberCopy', 'A model you send or receive goes through {host}’s computer, which can read it on the way and keeps none of it.', { host })
        : jt('settings.team.models.memberCopyAnon', 'A model you send or receive goes through the host’s computer, which can read it on the way and keeps none of it.'),
      body: body + view.note(vm.errors.models) });
  }

  // ------------------------------------------------------------- actions

  // The answer closes only the relay's own question, and only on the page that asked (a run on a page left and
  // opened again, or refused, has no answer): a confirmation opened while the call was out stays (R13-F03).
  function setRelay(ctx, flowing) {
    void ctx.run('model-relay', 'models', () => ctx.call('hostModelRelay', { flowing })).then((answer) => {
      if (!answer) return;
      if (ctx.confirm() === 'model-relay-off') ctx.setConfirm('');
      ctx.render(true);
    });
  }

  function switchClicked(ctx) {
    const relay = ctx.data().host && ctx.data().host.model_relay;
    if (!relay) return;
    if (ctx.confirm() === 'model-relay-off') { ctx.setConfirm(''); return; }
    if (relay.flowing === 0) { setRelay(ctx, lastOn); return; }
    if (relay.live && relay.passing > 0) { ctx.setConfirm('model-relay-off'); return; }
    setRelay(ctx, 0);
  }

  // A click on the page. True when it was one of these groups'.
  function onClick(event, ctx) {
    const target = event.target;
    const track = target && target.closest && target.closest('[data-inv-toggle="teamModelRelay"]');
    if (track) {
      if (!track.disabled) switchClicked(ctx);
      ctx.render(true); // the shared toggle handler flips the switch it was given; the page draws the state
      return true;
    }
    const button = target && target.closest && target.closest('[data-team-action="model-relay-confirm-off"]');
    if (!button || button.disabled) return false;
    setRelay(ctx, 0);
    return true;
  }

  function onChange(event, ctx) {
    const target = event.target;
    if (!target || typeof target.id !== 'string') return false;
    if (target.id === 'teamModelRelayFlowing') {
      const flowing = Number(target.value);
      if (Number.isSafeInteger(flowing) && flowing >= 1 && flowing <= MAX_FLOWING) setRelay(ctx, flowing);
      return true;
    }
    if (!target.id.startsWith('teamModelRate-')) return false;
    const teamId = target.id.slice('teamModelRate-'.length);
    const mb = Number(target.value);
    const store = modelStore();
    if (!store || !Number.isSafeInteger(mb) || mb < 0) return true;
    pending.set(teamId, mb);
    void ctx.run('model-rate:' + teamId, 'models', () => store.call('modelSetRate', { team_id: teamId, mb_per_second: mb })).then(() => { pending.delete(teamId); ctx.render(true); });
    return true;
  }

  // After every render: the model store held while the page shows (its state redraws the page), and each member
  // team's host name asked once per visit.
  function after(ctx) {
    const store = modelStore();
    if (!store) return;
    if (!held) held = [store.use(), store.subscribe((change) => { if (change && (change.type === 'state' || change.type === 'gone')) ctx.render(); })];
    for (const team of memberTeams(ctx.data())) {
      if (hosts.has(team.team_id) || team.state !== 'online') continue;
      hosts.set(team.team_id, '');
      void store.call('modelReceivers', { team_id: team.team_id }).then((answer) => {
        if (!held || !hosts.has(team.team_id)) return;
        const owner = answer && answer.ok && Array.isArray(answer.members) ? answer.members.find((m) => m && m.role === 'owner') : null;
        if (owner && owner.display_name) { hosts.set(team.team_id, W.name(owner.display_name)); ctx.render(); }
      });
    }
  }

  // Leaving the page lets go of the model store and forgets the names and the speeds asked for.
  function reset() {
    if (held) held.forEach((fn) => { try { fn(); } catch (_error) { /* best effort */ } });
    held = null;
    hosts.clear();
    pending.clear();
  }

  return { hostGroup, memberGroup, onClick, onChange, after, reset };
});
