/* Settings > Team, the GPU groups (row 123, slice 4e; the owner's picks in picks_4e.md):
 * - "Share this PC's GPU" for every member and the owner: the switch, the team picker when this
 *   PC is in two or more teams, the sharer's notice the first time, the state line with its
 *   buttons, what this PC offers and the question when it is switched off mid-request;
 * - the owner's "Team GPUs" (the team model) and "GPU use" (totals for 7 days, every request
 *   behind a fold);
 * - row 201 (OD-4): under the share state, "Models to share from Ollama": the models installed in Ollama as a
 *   checkable list (read once a visit with `models.listOllamaTags`; the saved set with `shareOllamaModels { team_id }`).
 *   Nothing checked is the default (the model the owner's chat uses now). Save sends `shareOllamaModels { team_id, names }`
 *   (null for none checked). Not Ollama: the list is disabled with its reason, never hidden.
 * The page (renderer-settings-team-section.js) places the groups and hands each call a context:
 * `{ data, call, run, render, confirm, setConfirm, hostedTeam }`. The sharing state and the GPU
 * lists come from the team state push (renderer-team-store.js `sharing`, `pools`), already rebuilt
 * by main; the GPU use page is read here, once per visit. Markup only through the inventory
 * primitives and the page's builders; every value is escaped. Buttons and the switch:
 *   switch on -> shareSet { on: true } (the first time: the notice, then confirmed: true);
 *   switch off while idle -> shareSet { on: false } (the agent's stop());
 *   switch off mid-request -> the question: "Stop after it" shareSet { on: false } (pause, then
 *   stop() once it ended), "Stop now" shareStop (stop()); Pause / Resume -> sharePause { on };
 *   "Stop now" beside Pause -> sharePause { on: true, stop_running: true } (the spec's "Stop
 *   sharing now": the request ends, the PC stays shared and paused). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-team-strings'), require('./renderer-settings-team-view'));
    return;
  }
  root.rendererSettingsTeamGpu = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, view) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const LOCKED_OUT = new Set(['revoked', 'pending', 'needs_repair']);
  const ENGINE_NAMES = Object.freeze({ 'llama-server': 'llama-server', NInfer: 'NInfer', Ollama: 'Ollama' });
  const USE_PAGE = 20;
  const OFFERING = new Set(['idle', 'serving', 'busy_own', 'paused']); // the states with an Offers line
  const TICK_MS = 1000;
  const SLOT = '\u0001'; // stands for the model list inside a sentence; never in a PC name (clean text)
  // The share set's own rule (services/team/node/sharing-file.js): at most 64 distinct printable names of at most 128 characters.
  const SHARE_NAME = /^[!-~][ -~]{0,127}$/u;
  const SHARE_MAX = 64;

  let picked = ''; // the team the switch is for, once the person picked one
  let usage = freshUsage();
  let wantUse = '';
  let ticker = null;
  let ollama = freshOllama(); // the Ollama share set of the team the switch is for
  let wantOllama = '';

  function freshOllama(teamId = '') { return { teamId, loaded: false, available: false, readable: true, installed: [], saved: null, draft: null }; }
  function freshUsage(teamId = '') { return { teamId, loaded: false, failed: false, totals: [], rows: [], next: null, open: false }; }
  function inv() { return globalThis.inventory || {}; }
  function tag() { try { return globalThis.jennyI18n?.tag?.() || undefined; } catch (_error) { return undefined; } }

  // The Intl formatters, built once per page language.
  const formatters = { tag: null, number: null, compact: null, list: null };
  function formatter(kind) {
    const current = tag() || '';
    if (formatters.tag !== current) Object.assign(formatters, { tag: current, number: null, compact: null, list: null });
    if (!formatters[kind]) {
      const locale = current || undefined;
      formatters[kind] = kind === 'list' ? new Intl.ListFormat(locale, { type: 'conjunction' })
        : new Intl.NumberFormat(locale, kind === 'compact' ? { notation: 'compact', compactDisplay: 'long', maximumFractionDigits: 1 } : {});
    }
    return formatters[kind];
  }

  // ------------------------------------------------------------- words

  function duration(ms) {
    const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (seconds < 60) return jt('settings.team.gpu.seconds', '{n} s', { n: seconds });
    return jt('settings.team.gpu.minutes', '{m} min {s} s', { m: Math.floor(seconds / 60), s: seconds % 60 });
  }

  // 880,000 or, from a million up in the totals, "1.9 million".
  function numberText(n, compact = false) {
    try { return formatter(compact && n >= 1e6 ? 'compact' : 'number').format(n); } catch (_error) { return String(n); }
  }

  // "a and b", "a, b and c" in the page's language, each model in <code>. Returns HTML.
  function modelList(models) {
    let parts;
    try { parts = formatter('list').formatToParts(models); } catch (_error) {
      parts = models.flatMap((name, i) => (i ? [{ type: 'literal', value: ', ' }, { type: 'element', value: name }] : [{ type: 'element', value: name }]));
    }
    return parts.map((part) => (part.type === 'element' ? '<code>' + escapeHtml(part.value) + '</code>' : escapeHtml(part.value))).join('');
  }

  function tokensText(n, compact = false) {
    return jtn('settings.team.gpu.tokens', n, { count: numberText(n, compact) }, '{count} token', '{count} tokens');
  }

  // ------------------------------------------------------------- the share group

  function servingText(sharing) {
    const since = Number(sharing.serving_since);
    const elapsed = duration(Number.isFinite(since) && since > 0 ? Date.now() - since : 0);
    return jt('settings.team.gpu.serving', 'Answering a request from the team · {elapsed}', { elapsed });
  }

  function shareable(teams) { return (teams || []).filter((team) => team && !LOCKED_OUT.has(team.state)); }

  function pickTeam(data) {
    const teams = shareable(data.teams);
    return teams.find((team) => team.team_id === picked) || teams.find((team) => team.team_id === data.sharing?.team_id) || teams[0] || null;
  }

  function sharingOf(data, team) { return data.sharing && team && data.sharing.team_id === team.team_id ? data.sharing : null; }

  function act(id, action, label, teamId, variant = 'secondary', vm = null) {
    return inv().actionButton({ label, variant, size: 'sm', domId: id, dataset: { 'team-action': action, 'team-id': teamId },
      disabled: Boolean(vm && vm.isBusy('share')) });
  }

  // The line under the switch: [tone, words, buttons], or null for a state the page does not know.
  function stateLine(vm, team, sharing) {
    const id = team.team_id;
    const pause = act('teamSharePause', 'share-pause', jt('settings.team.gpu.pause', 'Pause'), id, 'secondary', vm);
    switch (sharing.state) {
      case 'idle': return ['success', jt('settings.team.gpu.idle', 'Sharing. Nobody’s request is running.'), pause];
      case 'serving': {
        return ['success', servingText(sharing),
          vm.confirm === 'share-off' ? '' : pause + act('teamShareStopNow', 'share-stop-running', jt('settings.team.gpu.stopNow', 'Stop now'), id, 'secondary', vm)];
      }
      case 'busy_own': return ['warning', jt('settings.team.gpu.busyOwn', 'Waiting while you use the model. The team’s requests go to other hardware or wait.'), ''];
      case 'paused': return ['warning', jt('settings.team.gpu.paused', 'Paused. The team sees this PC as paused.'),
        act('teamShareResume', 'share-resume', jt('settings.team.gpu.resume', 'Resume'), id, 'primary', vm)];
      case 'no_model': return ['danger', jt('settings.team.gpu.noModel', 'Offering nothing: no model is running on this PC. Start one in Models.'),
        inv().actionButton({ label: jt('settings.team.gpu.openModels', 'Open Models'), plain: true, domId: 'teamShareModels', dataset: { 'team-action': 'open-models' } })];
      // Not in the picks: the page's own words (the server's "Starting…", the team row's connection word).
      case 'starting': return ['default', jt('settings.team.status.starting', 'Starting…'), ''];
      case 'host_not_ready': return ['warning', jt('settings.team.gpu.hostNotReady', 'This team’s host is not set up to use shared GPUs yet.'), ''];
      case 'team_offline': return ['warning', words.connectionText(sharing.connection), ''];
      default: return null;
    }
  }

  function offersLine(team, sharing) {
    const models = Array.isArray(sharing.models) ? sharing.models.filter((name) => typeof name === 'string' && name) : [];
    if (!models.length || !sharing.engine) return '';
    const engine = ENGINE_NAMES[sharing.engine] || jt('settings.team.gpu.engineLocal', 'your local server');
    const pc = team.label || jt('settings.team.devices.here', 'this PC');
    const text = jt('settings.team.gpu.offers', 'Offers {models}, the models running in {engine} on {pc}.', { models: SLOT, engine, pc });
    const at = text.indexOf(SLOT);
    const html = at < 0 ? escapeHtml(text) : escapeHtml(text.slice(0, at)) + modelList(models) + escapeHtml(text.slice(at + SLOT.length));
    return '<p class="team-share-offers">' + html + '</p>';
  }

  // ------------------------------------------------- the Ollama share set (row 201, OD-4)

  // The names of an installed-models answer that the share set would accept, each once.
  function installedNames(rows) {
    const names = [];
    for (const row of rows) {
      const name = typeof row === 'string' ? row : row && (row.id || row.name || row.model);
      if (typeof name === 'string' && SHARE_NAME.test(name) && !names.includes(name)) names.push(name);
    }
    return names;
  }

  // What the list shows: a saved name Ollama no longer has (so it can be unchecked), then the installed models.
  function ollamaListing() { return [...(ollama.saved || []).filter((name) => !ollama.installed.includes(name)), ...ollama.installed]; }
  function ollamaChecked() { return ollama.draft || ollama.saved || []; }
  function ollamaDirty() {
    if (!ollama.draft) return false;
    const was = ollama.saved || [];
    return ollama.draft.length !== was.length || ollama.draft.some((name) => !was.includes(name));
  }

  function ollamaTags() {
    const shell = globalThis.jennyShell || (globalThis.window && globalThis.window.jennyShell);
    const models = shell && shell.models;
    if (!models || typeof models.listOllamaTags !== 'function') return Promise.resolve(null);
    return Promise.resolve().then(() => models.listOllamaTags()).catch(() => null);
  }

  // The installed models, then (only with Ollama there) the saved set; read once a visit for the team.
  async function loadOllama(ctx, teamId) {
    const state = ollama;
    const tags = await ollamaTags();
    const rows = tags && tags.available !== false && Array.isArray(tags.data) ? tags.data : null;
    let saved = null;
    let readable = true;
    if (rows) {
      let answer = null;
      try { answer = await ctx.call('shareOllamaModels', { team_id: teamId }); } catch (_error) { /* read as unreadable below */ }
      if (answer && answer.ok === true) saved = Array.isArray(answer.ollama_models) ? answer.ollama_models : null;
      else readable = false;
    }
    if (ollama !== state) return;
    Object.assign(state, { loaded: true, available: rows !== null, readable, installed: rows ? installedNames(rows) : [], saved });
    ctx.render();
  }

  function ollamaChecks(vm, locked) {
    const checkbox = inv().checkbox;
    if (typeof checkbox !== 'function') return '';
    const checked = ollamaChecked();
    const full = checked.length >= SHARE_MAX;
    return '<ul class="team-set-list" data-team-ollama role="group" aria-labelledby="teamOllamaTitle">' + ollamaListing().map((name, i) => {
      const on = checked.includes(name);
      return '<li class="team-set-person"><div class="team-set-person__who">' + checkbox({ id: 'teamOllama' + i, label: name, checked: on,
        disabled: locked || vm.isBusy('ollama') || (full && !on), dataset: { 'ollama-name': name } }) + '</div></li>';
    }).join('') + '</ul>';
  }

  // Under the share state, for a member who may share: the row; its words say why a list is not live.
  function ollamaRow(vm, team, sharing) {
    wantOllama = team.team_id;
    const state = ollama.teamId === team.team_id && ollama.loaded ? ollama : null;
    const engine = sharing && sharing.engine;
    const applies = !engine || engine === 'Ollama';
    let help = jt('settings.team.ollama.reading', 'Reading the models on this PC…');
    let list = '';
    let save = '';
    if (state && !state.available) {
      help = jt('settings.team.ollama.off', 'Ollama is not running on this PC, so there is nothing to choose.');
    } else if (state && !state.readable) {
      help = jt('settings.team.ollama.unreadable', 'Jenny could not read the models this PC shares. Try again later.');
    } else if (state && ollamaListing().length === 0) {
      help = jt('settings.team.ollama.none', 'Ollama has no models installed on this PC.');
    } else if (state) {
      help = applies ? jt('settings.team.ollama.help', 'Only the models you check are offered to the team. With none checked, Jenny offers the model you are using now.')
        : jt('settings.team.ollama.notOllama', 'This list applies when this PC shares through Ollama. It shares through {engine} now.', { engine: ENGINE_NAMES[engine] || engine });
      list = ollamaChecks(vm, !applies);
      save = view.button(vm, 'ollama-save', jt('settings.team.ollama.save', 'Save'), { variant: 'primary', ids: { teamId: team.team_id }, busyKey: 'ollama',
        disabled: !applies || !ollamaDirty(), title: jt('settings.team.ollama.saveTip', 'Saves which Ollama models this PC offers to the team.') });
    }
    return inv().settingsField({ id: 'teamOllamaRow', variant: 'row', titleId: 'teamOllamaTitle', helpId: 'teamOllamaHelp', label: jt('settings.team.ollama.label', 'Models to share from Ollama'),
      help, controlHtml: save }) + list;
  }

  function toggleOllama(name, on) {
    const keep = new Set(ollamaChecked());
    if (on) keep.add(name); else keep.delete(name);
    ollama.draft = ollamaListing().filter((model) => keep.has(model));
  }

  // Nothing checked saves null: back to the default share set.
  async function saveOllama(ctx, teamId) {
    const names = ollamaChecked();
    const answer = await ctx.run('ollama', 'ollama', () => ctx.call('shareOllamaModels', { team_id: teamId, names: names.length ? names : null }));
    if (!answer) return;
    if (ollama.teamId === teamId) {
      ollama.saved = Array.isArray(answer.ollama_models) ? answer.ollama_models : names.length ? names : null;
      ollama.draft = null;
    }
    ctx.render();
  }

  function confirmHtml(label, sentence, buttons) {
    return '<div class="team-set-confirm" role="group" aria-label="' + escapeHtml(label) + '"><p>' + escapeHtml(sentence) + '</p>'
      + '<div class="team-set-inline">' + buttons.join('') + '</div></div>';
  }

  function shareGroup(vm, data) {
    const teams = shareable(data.teams);
    const team = pickTeam(data);
    if (!team) return '';
    const sharing = sharingOf(data, team);
    const readOnly = team.role === 'read_only';
    const id = team.team_id;
    const toggle = inv().toggleSwitch({ id: 'teamShareGpu', domId: 'teamShareGpu', bare: true, labelledBy: 'teamShareTitle', describedBy: 'teamShareHelp',
      checked: !readOnly && (Boolean(sharing) || vm.confirm === 'share-on'), disabled: readOnly || vm.isBusy('share') || vm.forceLocal === true,
      ...(vm.forceLocal === true ? { tooltip: words.forceLocalText() } : {}) });
    const picker = teams.length > 1 ? inv().selectField({ id: 'teamShareTeam', ariaLabel: jt('settings.team.gpu.pickTeam', 'Team to share with'), value: id,
      options: teams.map((t) => ({ value: t.team_id, label: words.teamName(t) })) }) : '';
    const help = vm.forceLocal === true ? words.forceLocalText() : readOnly ? jt('settings.team.gpu.readOnly', 'Read-only members cannot share a GPU. The owner can change your role.')
      : jt('settings.team.gpu.help', 'When you are not using it, this PC’s model answers requests from people in the team. Your own chats always go first.');
    let body = inv().settingsField({ id: 'teamShareRow', variant: 'row', titleId: 'teamShareTitle', helpId: 'teamShareHelp', help, controlHtml: picker + toggle,
      label: jt('settings.team.gpu.shareWith', 'Share with {team}', { team: words.teamName(team) }) });
    if (!readOnly && vm.confirm === 'share-on') {
      body += confirmHtml(jt('settings.team.gpu.start', 'Start sharing'),
        jt('settings.team.gpu.notice', 'While you share, this PC sees the prompts and replies of the requests it answers, in plain text, and so does the team’s host. Jenny keeps none of them on this PC.'),
        [view.button(vm, 'share-start', jt('settings.team.gpu.start', 'Start sharing'), { variant: 'primary', ids: { teamId: id }, busyKey: 'share' }),
          view.button(vm, 'share-cancel', jt('settings.team.cancel', 'Cancel'), { busyKey: 'share' })]);
    }
    const line = sharing && !readOnly ? stateLine(vm, team, sharing) : null;
    if (line) {
      body += '<div class="team-share-state"' + (sharing.state === 'serving' ? ' data-serving' : '') + '>'
        + inv().statusRow({ tone: line[0], message: line[1], compact: true })
        + '<div class="team-share-state__acts">' + line[2] + '</div></div>';
      if (OFFERING.has(sharing.state)) body += offersLine(team, sharing);
    }
    if (!readOnly) body += ollamaRow(vm, team, sharing);
    if (sharing && !readOnly && vm.confirm === 'share-off') {
      body += confirmHtml(jt('settings.team.gpu.stopSharing', 'Stop sharing'),
        jt('settings.team.gpu.offQuestion', 'A request from the team is running on this PC. Stop sharing when it finishes, or stop it now? If you stop it now, that reply ends early and its sender can try other hardware.'),
        [view.button(vm, 'share-after', jt('settings.team.gpu.stopAfter', 'Stop after it'), { variant: 'primary', ids: { teamId: id }, busyKey: 'share' }),
          view.button(vm, 'share-stop', jt('settings.team.gpu.stopNow', 'Stop now'), { variant: 'danger', ids: { teamId: id }, busyKey: 'share' }),
          view.button(vm, 'share-cancel', jt('settings.team.cancel', 'Cancel'), { busyKey: 'share' })]);
    }
    return view.group('share', jt('settings.team.gpu.heading', 'Share this PC’s GPU'), { body: body + view.note(vm.errors.share) + view.note(vm.errors.ollama) });
  }

  // ------------------------------------------------------------- the owner's groups

  function onlineModels(list) {
    const names = new Set();
    for (const node of (list && list.nodes) || []) {
      if (node.online && !node.paused) for (const model of node.models || []) names.add(model.name);
    }
    return [...names].sort();
  }

  function requestLine(row, nameOf) {
    const tokens = row.tokens === null ? jt('settings.team.gpu.noCount', 'no count sent') : tokensText(row.tokens);
    const params = { model: row.model, tokens, duration: duration(row.duration_ms) };
    const text = row.node_label
      ? jt('settings.team.gpu.useLine', '{model} · on {hardware} · {tokens} · {duration}', { ...params,
        hardware: jt('settings.team.gpu.hardwareName', '{owner}’s {pc}', { owner: nameOf(row.node_member_id), pc: row.node_label }) })
      : jt('settings.team.gpu.useLineBare', '{model} · {tokens} · {duration}', params);
    return '<li><time>' + escapeHtml(words.formatTime(row.at)) + '</time><span class="team-use-who">' + escapeHtml(nameOf(row.member_id)) + '</span>'
      + '<span>' + escapeHtml(text) + '</span></li>';
  }

  function useBody(vm, hosted) {
    if (usage.teamId !== hosted.team.team_id || !(usage.loaded || usage.failed)) return '';
    if (usage.failed) return inv().emptyNote({ text: jt('settings.team.status.unknown', 'Unavailable') });
    const someone = jt('settings.team.activity.someone', 'Someone');
    const nameOf = (id) => (id && (hosted.roster || []).find((member) => member.member_id === id)?.display_name) || someone;
    if (!usage.totals.length) return inv().emptyNote({ text: jt('settings.team.activity.empty', 'Nothing has happened yet.') });
    let body = '<ul class="team-set-list" data-team-use>' + usage.totals.map((total) => view.row(nameOf(total.member_id),
      jt('settings.team.gpu.useTotal', '{requests} · {tokens}', {
        requests: jtn('settings.team.gpu.requests', total.requests, { count: numberText(total.requests) }, '{count} request', '{count} requests'),
        tokens: tokensText(total.tokens, true) }), '')).join('') + '</ul>';
    if (usage.open) body += '<ul class="team-set-log team-set-log--use" data-team-use-requests>' + usage.rows.map((row) => requestLine(row, nameOf)).join('') + '</ul>';
    const more = usage.open && usage.next !== null ? view.button(vm, 'use-more', jt('settings.team.activity.more', 'Show more'), { variant: 'ghost', busyKey: 'use' }) : '';
    return body + '<div class="team-set-after">' + more + view.button(vm, 'use-toggle', usage.open ? jt('settings.team.gpu.hideRequests', 'Hide the requests')
      : jt('settings.team.gpu.showRequests', 'Show every request'), { variant: 'ghost', busyKey: 'use' }) + '</div>' + view.note(vm.errors.use);
  }

  function ownerGroups(vm, data, hosted) {
    wantUse = hosted.team.team_id;
    const list = (data.pools || {})[hosted.team.team_id] || null;
    const models = onlineModels(list);
    let html = '';
    // Hidden while no hardware is online: Automatic would name nothing and the select would offer nothing.
    if (list && list.automatic_model && models.length) {
      const value = list.team_model && models.includes(list.team_model) ? list.team_model : 'auto';
      const select = inv().selectField({ id: 'teamModel', ariaLabel: jt('settings.team.gpu.teamModel', 'Team model'), value, describedBy: 'teamModelHelp',
        disabled: vm.isBusy('team-model'), options: [{ value: 'auto', label: jt('settings.team.gpu.automatic', 'Automatic') }, ...models.map((name) => ({ value: name, label: name }))] });
      html += view.group('gpus', jt('settings.team.gpu.teamGpus', 'Team GPUs'), {
        body: inv().settingsField({ id: 'teamModelRow', variant: 'row', label: jt('settings.team.gpu.teamModel', 'Team model'), labelFor: 'teamModel', helpId: 'teamModelHelp',
          help: jt('settings.team.gpu.teamModelHelp', 'New conversations start on it. Anyone can pick another model in their own conversation. Automatic picks the model offered by the most connected hardware (now {model}).', { model: list.automatic_model }),
          controlHtml: select }) + view.note(vm.errors.gpus) });
    }
    return html + view.group('use', jt('settings.team.gpu.use', 'GPU use'), { extra: jt('settings.team.gpu.lastWeek', 'last 7 days'),
      copy: jt('settings.team.gpu.useCopy', 'Requests people sent from their own chats through the team. Jenny records who, when, the model, the hardware and the token count, never the words.'),
      body: useBody(vm, hosted) });
  }

  // ------------------------------------------------------------- actions

  function focusSwitch() {
    const track = globalThis.document?.getElementById?.('teamShareGpu');
    if (track && typeof track.focus === 'function') track.focus({ preventScroll: true });
  }

  async function setShare(ctx, teamId, on, confirmed = false) {
    const payload = on ? { team_id: teamId, on, confirmed } : { team_id: teamId, on };
    let ask = false;
    const answer = await ctx.run('share', 'share', async () => {
      const result = await ctx.call('shareSet', payload);
      ask = Boolean(result && result.ok === false && result.error && result.error.reason === 'team_share_confirm_needed');
      return ask ? { ok: true } : result;
    });
    if (!answer) return;
    ctx.setConfirm(ask ? 'share-on' : '');
    ctx.render();
    focusSwitch();
  }

  async function share(ctx, method, payload, { refocus = false } = {}) {
    const answer = await ctx.run('share', 'share', () => ctx.call(method, payload));
    if (!answer) return;
    ctx.setConfirm('');
    ctx.render();
    if (refocus) focusSwitch();
  }

  function switchClicked(ctx) {
    const data = ctx.data();
    const team = pickTeam(data);
    if (!team || team.role === 'read_only') return;
    const sharing = sharingOf(data, team);
    const asking = ctx.confirm();
    if (asking === 'share-on' || asking === 'share-off') { ctx.setConfirm(''); return; }
    if (!sharing) { void setShare(ctx, team.team_id, true); return; }
    if (sharing.state === 'serving') { ctx.setConfirm('share-off'); return; }
    void setShare(ctx, team.team_id, false);
  }

  async function loadUsage(ctx, more) {
    const state = usage;
    if (!state.teamId) return;
    const payload = { team_id: state.teamId, limit: USE_PAGE };
    if (more) payload.cursor = state.next;
    // The first page shows "Unavailable" in place of the list when it fails; "Show more" shows its sentence.
    const answer = more ? await ctx.run('use', 'use', () => ctx.call('gpuUse', payload)) : await ctx.call('gpuUse', payload);
    if (usage !== state) return;
    if (!answer || answer.ok !== true || !Array.isArray(answer.rows) || !Array.isArray(answer.totals)) {
      if (!more) { state.failed = true; ctx.render(); }
      return;
    }
    state.loaded = true;
    if (!more) state.totals = answer.totals;
    state.rows = more ? state.rows.concat(answer.rows) : answer.rows;
    state.next = answer.next_cursor ?? null;
    ctx.render();
  }

  function openModels() {
    const item = globalThis.document?.querySelector?.('.settings-nav-item[data-settings-section="models"]');
    if (item && typeof item.click === 'function') item.click();
  }

  // A click on the page. True when it was one of these groups'.
  function onClick(event, ctx) {
    const target = event.target;
    const track = target && target.closest && target.closest('[data-inv-toggle="teamShareGpu"]');
    if (track) {
      if (!track.disabled) switchClicked(ctx);
      ctx.render(true); // the shared toggle handler flips the switch it was given; the page draws the state
      return true;
    }
    const button = target && target.closest && target.closest('[data-team-action]');
    if (!button || button.disabled) return false;
    const teamId = button.dataset.teamId || '';
    switch (button.dataset.teamAction) {
      case 'share-start': void setShare(ctx, teamId, true, true); return true;
      case 'share-cancel': ctx.setConfirm(''); ctx.render(); focusSwitch(); return true;
      case 'share-after': void share(ctx, 'shareSet', { team_id: teamId, on: false }, { refocus: true }); return true;
      case 'share-stop': void share(ctx, 'shareStop', { team_id: teamId }, { refocus: true }); return true;
      case 'share-pause': void share(ctx, 'sharePause', { team_id: teamId, on: true }); return true;
      case 'share-resume': void share(ctx, 'sharePause', { team_id: teamId, on: false }); return true;
      case 'share-stop-running': void share(ctx, 'sharePause', { team_id: teamId, on: true, stop_running: true }); return true;
      case 'ollama-save': void saveOllama(ctx, teamId); return true;
      case 'open-models': openModels(); return true;
      case 'use-toggle': usage.open = !usage.open; ctx.render(); return true;
      case 'use-more': if (usage.next !== null) void loadUsage(ctx, true); return true;
      default: return false;
    }
  }

  function onChange(event, ctx) {
    const target = event.target;
    if (!target) return false;
    if (target.dataset && target.dataset.ollamaName !== undefined && target.type === 'checkbox') {
      toggleOllama(target.dataset.ollamaName, target.checked);
      ctx.render();
      return true;
    }
    if (target.id === 'teamShareTeam') { picked = String(target.value || ''); ctx.setConfirm(''); ctx.render(); return true; }
    if (target.id === 'teamModel') {
      const hosted = ctx.hostedTeam();
      const model = target.value === 'auto' ? null : String(target.value || '');
      if (hosted && model !== '') void ctx.run('team-model', 'gpus', () => ctx.call('teamModelSet', { team_id: hosted.team_id, model }));
      return true;
    }
    return false;
  }

  // The elapsed time of the request being served, in its own text: the page is not rebuilt (an open
  // control keeps its state).
  function tick(ctx) {
    const sharing = ctx.data().sharing;
    const message = globalThis.document?.querySelector?.('.team-share-state[data-serving] .inv-status-row-message');
    if (!message || sharing?.state !== 'serving') return;
    message.textContent = servingText(sharing);
  }

  // After every render: the elapsed time ticks while a request runs, and the owner's GPU use is read once a visit.
  function after(ctx) {
    const serving = ctx.data().sharing?.state === 'serving';
    if (serving && ticker === null) ticker = setInterval(() => tick(ctx), TICK_MS);
    if (!serving && ticker !== null) { clearInterval(ticker); ticker = null; }
    const wantSet = wantOllama;
    wantOllama = '';
    if (wantSet && ollama.teamId !== wantSet) { ollama = freshOllama(wantSet); void loadOllama(ctx, wantSet); }
    const want = wantUse;
    wantUse = '';
    if (want && usage.teamId !== want) { usage = freshUsage(want); void loadUsage(ctx, false); }
  }

  // Leaving the page drops the pick, the GPU use page and the timer.
  function reset() {
    picked = '';
    usage = freshUsage();
    wantUse = '';
    ollama = freshOllama();
    wantOllama = '';
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  }

  return { shareGroup, ownerGroups, onClick, onChange, after, reset, get _ticking() { return ticker !== null; } };
});
