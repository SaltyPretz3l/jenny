/* Settings > Team, the Network group (row 123, slice 5-6; the owner's picks in picks_5-6.md):
 * - the switch "Let people join over the internet", which asks first in both directions;
 * - while on, one status line and the path picture (This PC, the router or the relay, people elsewhere) from
 *   the host state's `reach` verdict, with only the fix for that verdict in the open and the other fields folded;
 * - one save bar for the address, relay and token fields (`hostInternet` with the whole record: the saved
 *   setting plus the edits; the token only when typed, absent means keep);
 * - the Reconnect code row (`hostReconnectCode`), and on a member's row "Enter reconnect code"
 *   (`teamReconnectCode`);
 * - row 201 (OD-5): "Pool context length", the owner's cap on how much text one request to the team's GPUs may hold
 *   (`hostPoolContext { context_cap }`; an empty field is Auto, the host state's `pool_context_cap` is the saved
 *   value). It is one of the owner's host settings that lives in this group because it needs no group of its own;
 *   it applies at the server's next start, and only an owner's page draws it.
 *   Layout D3: with a GPU pool the row is drawn in Team GPUs under Team model (renderer-settings-team-gpu.js calls `poolRowHtml`).
 * The page (renderer-settings-team-section.js) places the group and hands each call its context. The fold, the
 * field drafts and the shown code live here until the page is left (`reset`). The relay token is never read
 * back: the page knows only `has_token`. Markup through the page's builders; every value is escaped. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-team-strings'), require('./renderer-settings-team-view'));
    return;
  }
  root.rendererSettingsTeamNetwork = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, view) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const FIELDS = Object.freeze({ teamNetAddr: 'address', teamNetRelay: 'relay' });
  // Inputs whose text is a secret (the relay token, a pasted reconnect code): never kept in page state, read
  // from the field when used; the page carries their text across a redraw by this mark.
  const SECRET = Object.freeze({ 'team-secret': '1' });
  const TONES = Object.freeze({ ok: 'success', bad: 'danger', pending: 'pending' });
  const COPIED_MS = 1500;
  // The bounds of the pool's context length in whole tokens (services/team/host/host-layout.js POOL_CONTEXT_MIN / _AUTO).
  const POOL_MIN = 2048;
  const POOL_MAX = 1048576;

  let ui = fresh();
  let copyTimer = null;
  function fresh() { return { fold: null, address: undefined, relay: undefined, tokenTyped: false, code: '', codeFor: '', copied: false, pool: undefined, poolGroup: 'network', changes: false }; }
  function inv() { return globalThis.inventory || {}; }

  // ------------------------------------------------------------- the state

  function relayHost(url) { try { return new URL(url).host; } catch (_error) { return ''; } }

  // The other active members' names, "Dot and Maya", for the turn on confirm.
  function othersText(data, hosted) {
    const roster = (hosted && data.lists[hosted.team_id]?.roster) || [];
    const names = roster.filter((m) => m.state === 'active' && m.member_id !== hosted.member_id).map((m) => m.display_name);
    if (!names.length) return '';
    try { return new Intl.ListFormat(globalThis.jennyI18n?.tag?.() || undefined, { type: 'conjunction' }).format(names); } catch (_error) { return names.join(', '); }
  }

  // What the picture says: [state, words] per stop, the two links, the far stop, the note under it and the fix.
  function pathOf(host, saving) {
    const port = host.direct_port;
    const router = jt('settings.team.net.router', 'Your router');
    const relay = jt('settings.team.net.relay', 'Your relay');
    const relayName = relayHost(host.internet && host.internet.relay_url);
    const can = jt('settings.team.net.canJoin', 'Can join with an invite');
    const cannot = jt('settings.team.net.cannotReach', 'Cannot reach this PC');
    const notYet = jt('settings.team.net.notKnown', 'Not known yet');
    const blocked = jt('settings.team.net.blockedHead', 'People elsewhere cannot join yet.');
    const open = jt('settings.team.net.portOpen', 'Port {port} is open', { port });
    const running = jt('settings.team.net.pcRunning', 'Server running, port {port}', { port });
    const untested = jt('settings.team.net.untested', 'Jenny cannot test this from inside your network.');
    const P = (head, tone, l1, mid, l2, out, extra = {}) => ({ head, tone, pc: ['ok', running], l1, mid, l2, out, ...extra });
    if (saving || host.state === 'starting' || host.state === 'stopping') {
      return P(jt('settings.team.net.restarting', 'Restarting the server with the new setting…'), 'pending', 'pending',
        [router, jt('settings.team.net.waiting', 'Waiting for the server'), 'pending'], 'pending', [jt('settings.team.net.reconnectThemselves', 'Reconnect by themselves'), 'pending'],
        { pc: ['pending', jt('settings.team.net.pcRestarting', 'Restarting')] });
    }
    if (host.state !== 'running') {
      return P(jt('settings.team.net.stoppedHead', 'The server is stopped. Jenny checks again when you start it.'), 'default', 'off',
        [router, jt('settings.team.net.portClosed', 'Port closed'), 'off'], 'off', [jt('settings.team.net.untilRuns', 'Cannot join until it runs'), 'off'],
        { pc: ['off', jt('settings.team.net.pcStopped', 'Server stopped')] });
    }
    const reason = host.reach && host.reach.reason;
    const joinHead = jt('settings.team.net.canHead', 'People elsewhere can join.');
    switch (reason) {
      case 'mapped': return P(joinHead, 'success', 'ok', [router, open, 'ok'], 'ok', [can, 'ok'], { foot: untested });
      case 'public_interface': return P(joinHead, 'success', 'ok', [router, jt('settings.team.net.ownAddress', 'This PC has its own public address'), 'ok'], 'ok', [can, 'ok'], { foot: untested });
      case 'direct_seen': return P(jt('settings.team.net.seenHead', 'People elsewhere can join. Someone already has.'), 'success', 'ok', [router, open, 'ok'], 'ok', [jt('settings.team.net.someone', 'Someone has connected'), 'ok']);
      case 'public_entered': return P(jt('settings.team.net.enteredHead', 'People elsewhere should be able to join.'), 'default', 'unknown',
        [router, jt('settings.team.net.forwarded', 'Port forwarded by you, not checked'), 'unknown'], 'unknown',
        [jt('settings.team.net.comeIn', 'Come in at {address}', { address: (host.internet && host.internet.public_address) || '' }), 'unknown'],
        { foot: untested + ' ' + jt('settings.team.net.checkForward', 'If someone cannot join, check that UDP port {port} is forwarded to this PC.', { port }) });
      case 'mapping_unavailable': return P(blocked, 'danger', 'bad', [router, jt('settings.team.net.notOpened', 'Did not open the port'), 'bad'], 'off', [cannot, 'off'], { fix: 'forward' });
      case 'shared_address': return P(blocked, 'danger', 'ok', [router, jt('settings.team.net.shares', 'Shares its public address'), 'bad'], 'bad', [cannot, 'off'], { fix: 'relay' });
      case 'relay_connected': return P(jt('settings.team.net.relayHead', 'People elsewhere can join, through your relay.'), 'success', 'ok',
        [relay, jt('settings.team.net.relayConnected', '{host}, connected', { host: relayName }), 'ok'], 'ok', [can, 'ok']);
      case 'relay_connecting': return P(jt('settings.team.net.relayWaitHead', 'Connecting to your relay…'), 'pending', 'pending', [relay, relayName, 'pending'], 'pending', [notYet, 'pending']);
      case 'relay_denied': return P(blocked, 'danger', 'bad', [relay, jt('settings.team.net.refused', 'Refused this PC'), 'bad'], 'off', [cannot, 'off'], { fix: 'token' });
      case 'relay_unreachable': return P(blocked, 'danger', 'bad', [relay, jt('settings.team.net.notAnswering', 'Not answering'), 'bad'], 'off', [cannot, 'off'], { fix: 'relayAddr' });
      // The router did not answer within the check's own bound (reach.js `checking_unknown`).
      case 'checking_unknown': return P(jt('settings.team.net.unknownHead', 'Jenny could not tell whether people elsewhere can join.'), 'default', 'unknown',
        [router, jt('settings.team.net.noAnswer', 'Did not answer'), 'unknown'], 'unknown', [jt('settings.team.net.unknownJoin', 'Not known'), 'unknown'], { foot: untested });
      default: return P(jt('settings.team.net.checkingHead', 'Checking whether people elsewhere can join…'), 'pending', 'pending',
        [router, jt('settings.team.net.asking', 'Asking it to open the port'), 'pending'], 'pending', [notYet, 'pending']);
    }
  }

  // ------------------------------------------------------------- markup

  function stop(name, [state, fact]) {
    return '<div class="team-net-stop" data-s="' + state + '"><span class="team-net-stop__dot" aria-hidden="true"></span><b>' + escapeHtml(name)
      + '</b><span>' + escapeHtml(fact) + '</span></div>';
  }

  function picture(n) {
    const out = jt('settings.team.net.elsewhere', 'People elsewhere');
    const pc = jt('settings.team.net.thisPc', 'This PC');
    const label = jt('settings.team.net.pathLabel', '{pc}, then {mid} ({midFact}), then {out} ({outFact})', { pc, mid: n.mid[0], midFact: n.mid[1], out, outFact: n.out[0] });
    return '<div class="team-net-state">' + inv().statusRow({ tone: n.tone, message: n.head, compact: true, spinner: n.tone === 'pending' }) + '</div>'
      + '<div class="team-net-path" role="img" aria-label="' + escapeHtml(label) + '">' + stop(pc, n.pc) + '<span class="team-net-link" data-s="' + n.l1 + '"></span>'
      + stop(n.mid[0], [n.mid[2], n.mid[1]]) + '<span class="team-net-link" data-s="' + n.l2 + '"></span>' + stop(out, [n.out[1], n.out[0]]) + '</div>'
      + (n.foot ? '<p class="team-net-note">' + escapeHtml(n.foot) + '</p>' : '');
  }

  function saved(host) { const i = host.internet || {}; return { address: i.public_address || '', relay: i.relay_url || '', hasToken: i.has_token === true }; }
  // A restored team's values fill the form (`internet_draft`) until a save names its own: the owner turns joining on
  // as always, then saves them with the save bar.
  function shown(host) {
    const s = saved(host);
    const d = host.internet_draft || {};
    return { address: ui.address ?? (s.address || d.public_address || ''), relay: ui.relay ?? (s.relay || d.relay_url || '') };
  }
  function dirty(host) {
    const s = saved(host);
    const now = shown(host);
    return now.address.trim() !== s.address || now.relay.trim() !== s.relay || ui.tokenTyped;
  }

  function input(opts) { return (globalThis.inventoryTextField || inv().textField)(opts); }

  function fields(vm, host, busy) {
    const now = shown(host);
    const field = (id, label, help, control) => view.fieldRow(id + 'Row', label, help, control, id);
    const addressLabel = jt('settings.team.net.address', 'Public address or name');
    const relayLabel = jt('settings.team.net.relayAddress', 'Relay address');
    const tokenLabel = jt('settings.team.net.token', 'Relay access token');
    const addr = field('teamNetAddr', addressLabel, jt('settings.team.net.addressHelp', 'A name from a dynamic-DNS service keeps working when your address changes.'),
      input({ id: 'teamNetAddr', value: now.address, ariaLabel: addressLabel, placeholder: jt('settings.team.net.addressPlaceholder', 'home.example.net or 203.0.113.7'), maxLength: 255, disabled: busy }));
    const relay = field('teamNetRelay', relayLabel, jt('settings.team.net.relayHelp', 'A relay you run yourself. Jenny comes with none.'),
      input({ id: 'teamNetRelay', value: now.relay, ariaLabel: relayLabel, placeholder: jt('settings.team.net.relayPlaceholder', 'https://relay.example.net'), maxLength: 100, disabled: busy }));
    const clear = saved(host).hasToken
      ? view.button(vm, 'net-clear-token', jt('settings.team.net.clearToken', 'Clear token'), { busyKey: 'net-save', disabled: dirty(host),
        title: dirty(host) ? jt('settings.team.net.clearTokenFirst', 'Save or discard your changes first.') : jt('settings.team.net.clearTokenTip', 'Removes the saved relay token and restarts the server.') })
      : '';
    const token = field('teamNetToken', tokenLabel, jt('settings.team.net.tokenHelp', 'Optional. Lets your relay turn strangers away. Carried in this team’s invites.'),
      '<div class="team-set-inline">' + input({ id: 'teamNetToken', value: '', type: 'password', maxLength: 48, disabled: busy, ariaLabel: tokenLabel, dataset: SECRET,
        placeholder: saved(host).hasToken ? jt('settings.team.net.tokenSaved', 'A token is saved. Type to replace it') : '' }) + clear + '</div>');
    const relayNote = '<p class="team-net-note">' + escapeHtml(jt('settings.team.net.relaySees', 'The relay sees encrypted traffic and the addresses of this PC and of each member, never what is said.')) + '</p>';
    return { addr, relay, token, relayNote };
  }

  function onBody(vm, host, busy) {
    const n = pathOf(host, busy);
    const f = fields(vm, host, busy);
    const p = (text) => '<p class="team-net-note">' + escapeHtml(text) + '</p>';
    let fix = '';
    let rest = f.addr + f.relay + f.token + f.relayNote;
    if (n.fix === 'forward') {
      fix = '<ol class="team-net-fix"><li>' + escapeHtml(jt('settings.team.net.fixForward', 'In your router’s settings, forward UDP port {port} to this PC.', { port: host.direct_port }))
        + '</li><li>' + escapeHtml(jt('settings.team.net.fixEnter', 'Then enter this network’s public address or name here.')) + '</li></ol>' + f.addr;
      rest = f.relay + f.token + f.relayNote;
    } else if (n.fix === 'relay') {
      fix = p(jt('settings.team.net.fixShared', 'Your internet provider shares one public address between customers, so no port can be opened to this PC. A relay you run on a machine with its own public address can carry the connection.')) + f.relay + f.token + f.relayNote;
      rest = f.addr;
    } else if (n.fix === 'token') {
      fix = p(jt('settings.team.net.fixToken', 'Check the access token. It must match the one your relay expects.')) + f.token;
      rest = f.relay + f.addr;
    } else if (n.fix === 'relayAddr') {
      fix = p(jt('settings.team.net.fixRelay', 'Check the relay’s address and that the relay is running.')) + f.relay;
      rest = f.token + f.addr;
    }
    const s = saved(host);
    const open = ui.fold ?? (!fix && Boolean(s.address || s.relay));
    let html = picture(n) + fix + '<details class="team-net-fold"' + (open ? ' open' : '') + '><summary data-team-net-fold>'
      + escapeHtml(fix ? jt('settings.team.net.otherSettings', 'Other settings…') : jt('settings.team.net.setYourself', 'Set an address or a relay yourself…')) + '</summary>' + rest + '</details>';
    if (busy || dirty(host)) {
      html += '<div class="team-net-save">' + view.button(vm, 'net-save', busy ? jt('settings.team.net.saving', 'Saving…') : jt('settings.team.net.save', 'Save and restart server'), { variant: 'primary' })
        + view.button(vm, 'net-discard', jt('settings.team.net.discard', 'Discard changes'), { busyKey: 'net-save' })
        + '<span>' + escapeHtml(jt('settings.team.net.saveNote', 'Everyone is disconnected for a moment and reconnects by themselves.')) + '</span></div>';
    }
    return html;
  }

  function turnOnConfirm(vm, data, host, hosted) {
    const team = host.team_name || '';
    const others = othersText(data, hosted);
    const items = [jt('settings.team.net.onPort', 'Jenny asks your router to open one port (UDP {port}) for this team, and closes it when you turn this off.', { port: host.direct_port }),
      jt('settings.team.net.onAnyone', 'Anyone on the internet can then try to connect. Only people you invited get in.'),
      jt('settings.team.net.onLearn', 'Members and anyone holding an invite learn this network’s public address.'),
      others ? jt('settings.team.net.onRestartNames', 'The server restarts now. It disconnects {names} for a moment; they reconnect by themselves.', { names: others })
        : jt('settings.team.net.onRestart', 'The server restarts now.'),
      jt('settings.team.net.onOldInvites', 'Invites you made before now work on this network only. Make new ones for people elsewhere.'),
      jt('settings.team.net.onVersion', 'Members need this version of Jenny or later to join over the internet.')];
    const label = jt('settings.team.net.turnOn', 'Turn on');
    const line = (text) => '<p class="team-net-confirm-line">' + escapeHtml(text) + '</p>';
    // Layout D6: two sentences, the six facts behind "What this changes" (closed until pressed; reset when the confirm closes).
    const facts = '<details class="team-net-fold team-net-changes"' + (ui.changes ? ' open' : '') + '><summary id="teamNetChanges" data-team-net-changes aria-expanded="' + ui.changes + '">'
      + escapeHtml(jt('settings.team.net.onChanges', 'What this changes')) + '</summary>' + (ui.changes ? '<ul>' + items.map((t) => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul>' : '') + '</details>';
    return '<div class="team-set-confirm" role="group" aria-label="' + escapeHtml(label) + '"><p>' + escapeHtml(jt('settings.team.net.onAsk', 'Let people join {team} over the internet?', { team }))
      + '</p>' + line(jt('settings.team.net.onSummaryPort', 'Jenny asks your router to open one port for this team, and the server restarts now.'))
      + line(jt('settings.team.net.onSummaryWho', 'Only people you invited get in. They, and anyone holding an invite, learn this network’s public address.')) + facts + '<div class="team-set-inline">'
      + view.button(vm, 'net-on', label, { variant: 'primary', busyKey: 'net-save' }) + view.button(vm, 'confirm-cancel', jt('settings.team.cancel', 'Cancel')) + '</div></div>';
  }

  function codeKey(host) { const i = host.internet; return JSON.stringify([host.direct_port, i ? [i.public_address, i.relay_url] : null]); }

  function codeRow(vm, host) {
    const stopped = host.state !== 'running';
    const help = jt('settings.team.net.codeHelp', 'Helps a member’s Jenny find this PC again after its address changes. It holds no secret.')
      + (stopped ? ' ' + jt('settings.team.net.codeWhileRuns', 'Available while the server runs.') : '');
    if (ui.code && ui.codeFor !== codeKey(host)) ui.code = ''; // the code was made for other addresses
    const code = ui.code && !stopped ? ui.code : '';
    let html = view.fieldRow('teamNetCodeRow', jt('settings.team.net.code', 'Reconnect code'), help,
      code ? '' : view.button(vm, 'net-code', jt('settings.team.net.showCode', 'Show code'), { disabled: stopped }));
    if (code) {
      html += '<div class="team-set-code"><code>' + escapeHtml(code) + '</code>'
        + view.button(vm, 'net-code-copy', ui.copied ? jt('common.copied', 'Copied') : jt('settings.team.code.copy', 'Copy'), { variant: 'primary' })
        + '<p class="team-set-code__note">' + escapeHtml(jt('settings.team.net.codeNote', 'Send it to a member whose Jenny cannot find this PC. They enter it in Settings, Team, on the team’s row.')) + '</p></div>';
    }
    return html;
  }

  // ---------------------------------------------- the pool context length (row 201, OD-5)

  function poolSaved(host) { return Number.isSafeInteger(host.pool_context_cap) ? String(host.pool_context_cap) : ''; }
  function poolShown(host) { return ui.pool ?? poolSaved(host); }
  // The cap the field says: { ok: true, cap } with null for Auto (an empty field), or { ok: false }.
  function poolParse(text) {
    const trimmed = String(text).trim();
    if (trimmed === '') return { ok: true, cap: null };
    const cap = /^\d{1,7}$/.test(trimmed) ? Number(trimmed) : NaN;
    return cap >= POOL_MIN && cap <= POOL_MAX ? { ok: true, cap } : { ok: false };
  }

  // Layout D3: the row with its note group: 'gpus' when Team GPUs draws it, else 'network' (no GPU pool, or the server stopped).
  function poolRowHtml(vm, data, where) {
    const host = data.host;
    if (!host || !host.deployed || host.key !== 'ok' || !host.direct_port || host.pool_context_cap === undefined) return '';
    ui.poolGroup = where;
    return poolRow(vm, host, vm.isBusy('pool-save'));
  }
  function poolInGpus(vm, data, hosted) { return Boolean(vm.hosted && vm.hosted.owner && hosted && data.pools && data.pools[hosted.team_id]); }

  function poolRow(vm, host, busy) {
    const label = jt('settings.team.pool.label', 'Pool context length');
    const dirty = poolShown(host).trim() !== poolSaved(host);
    const field = input({ id: 'teamPoolCap', value: poolShown(host), type: 'number', min: POOL_MIN, max: POOL_MAX, step: 1, disabled: busy, ariaLabel: label,
      describedBy: 'teamPoolContextHelp', placeholder: jt('settings.team.pool.auto', 'Auto') });
    const save = view.button(vm, 'pool-save', jt('settings.team.pool.save', 'Save'), { variant: 'primary', disabled: !dirty,
      title: jt('settings.team.pool.saveTip', 'Saves the length. It applies the next time the server starts.') });
    return inv().settingsField({ id: 'teamPoolContextRow', variant: 'row', titleId: 'teamPoolContextTitle', helpId: 'teamPoolContextHelp', labelFor: 'teamPoolCap', label,
      help: jt('settings.team.pool.help', 'How much text one request to the team’s GPUs may hold. Leave it empty for Auto: it follows the model that answers, up to {max} tokens. Or type a lower limit, from {min}. It applies the next time the server starts.',
        { max: POOL_MAX.toLocaleString(globalThis.jennyI18n?.tag?.() || 'en-US'), min: POOL_MIN.toLocaleString(globalThis.jennyI18n?.tag?.() || 'en-US') }),
      controlHtml: '<div class="team-set-inline">' + field + save + '</div>' });
  }

  /** The owner's Network group, or '' when this PC hosts no team it can start. */
  function networkGroup(vm, data, hosted) {
    const host = data.host;
    if (!host || !host.deployed || host.key !== 'ok' || !host.direct_port) return '';
    const on = Boolean(host.internet);
    const busy = vm.isBusy('net-save');
    const asking = vm.confirm === 'net-on' || vm.confirm === 'net-off';
    if (vm.confirm !== 'net-on') ui.changes = false;
    const toggle = inv().toggleSwitch({ id: 'teamNet', domId: 'teamNet', bare: true, labelledBy: 'teamNetTitle', describedBy: 'teamNetHelp',
      checked: asking ? vm.confirm === 'net-on' : on, disabled: busy || vm.forceLocal === true, ...(vm.forceLocal === true ? { tooltip: words.forceLocalText() } : {}) });
    let html = inv().settingsField({ id: 'teamNetRow', variant: 'row', titleId: 'teamNetTitle', helpId: 'teamNetHelp', controlHtml: toggle,
      label: jt('settings.team.net.switch', 'Let people join over the internet'),
      help: on ? jt('settings.team.net.onHelp', 'Only people you invited get in. Members and anyone holding an invite learn this network’s public address.')
        : jt('settings.team.net.offHelp', 'Only people on this network can join.') });
    if (vm.confirm === 'net-on' && !on) html += turnOnConfirm(vm, data, host, hosted);
    if (vm.confirm === 'net-off' && on) {
      html += view.confirmBlock(vm, jt('settings.team.net.offAsk', 'Turn off internet joining? Members outside this network are cut off and cannot reconnect until you turn it on again. Jenny closes the router port. The server restarts now, so everyone is disconnected for a moment.'),
        'net-off', jt('settings.team.net.turnOff', 'Turn off'), { variant: 'secondary', busyKey: 'net-save' });
    }
    if (on) html += onBody(vm, host, busy);
    html += codeRow(vm, host);
    if (!poolInGpus(vm, data, hosted)) html += poolRowHtml(vm, data, 'network');
    return view.group('network', jt('settings.team.net.heading', 'Network'), { body: html + view.note(vm.errors.network) });
  }

  /** The sentence added under Invite someone, or ''. */
  function inviteLine(host) {
    if (!host || host.state !== 'running') return '';
    if (!host.internet) return jt('settings.team.net.inviteOff', 'Invites work on this network only. To invite someone elsewhere, turn on internet joining under Network.');
    const result = host.reach && host.reach.result;
    const reason = host.reach && host.reach.reason;
    if (!result || reason === 'checking' || reason === 'checking_unknown' || reason === 'relay_connecting') return '';
    return result === 'not_reachable' ? jt('settings.team.net.inviteBlocked', 'People outside this network cannot join yet: see Network below.')
      : jt('settings.team.net.inviteOn', 'New invites work from other networks too.');
  }

  // A member's row (Teams you have joined): the fact after the role, the hint, and whether the code is offered.
  function memberRow(team) {
    const reason = team.reason;
    if (team.state === 'deleted') {
      let date;
      try { date = new Intl.DateTimeFormat(globalThis.jennyI18n?.tag?.() || undefined, { dateStyle: 'medium' }).format(new Date(team.deleted_at)); } catch (_error) { date = ''; }
      return { hint: jt('settings.team.member.deleted', '{owner} deleted this team on {date}. Its channels and shared projects are gone. Your own chats on this PC were not touched.',
        { owner: team.deleted_by || jt('settings.team.activity.someone', 'Someone'), date }) };
    }
    if (team.state === 'online' && team.path === 'relay') return { fact: jt('settings.team.member.viaRelay', 'connected through the owner’s relay') };
    if (team.state === 'offline' && (reason === 'host_unreachable' || reason === 'closed')) {
      return { hint: jt('settings.team.member.notAnswering', 'The owner’s PC is not answering. It may be off. If its address changed, ask the owner for a reconnect code.'), code: true };
    }
    if (team.state === 'offline' && reason === 'host_name_unresolved') {
      return { hint: jt('settings.team.member.nameLost', 'Jenny cannot find the owner’s address name. It may come back by itself. If it does not, ask the owner for a reconnect code.'), code: true };
    }
    if (reason === 'relay_denied') return { hint: jt('settings.team.member.relayDenied', 'The owner’s relay turned this PC away. Ask the owner to check the relay’s access token, then restart Jenny. Jenny still tries to connect directly.') };
    if (reason === 'relay_unreachable') return { hint: jt('settings.team.member.relayDown', 'Jenny cannot reach the owner’s relay and keeps trying. The owner’s PC or the relay may be off.') };
    return {};
  }

  function codeEntry(vm, team) {
    const ids = { teamId: team.team_id };
    return '<div class="team-set-confirm" role="group" aria-label="' + escapeHtml(jt('settings.team.member.enterCode', 'Enter reconnect code')) + '"><p>'
      + escapeHtml(jt('settings.team.member.paste', 'Paste the reconnect code the owner sent you.')) + '</p><div class="team-set-inline">'
      + input({ id: 'teamReconnectInput', value: '', ariaLabel: jt('settings.team.net.code', 'Reconnect code'), maxLength: 512, dataset: SECRET })
      + view.button(vm, 'reconnect', jt('settings.team.member.reconnect', 'Reconnect'), { variant: 'primary', ids, busyKey: 'reconnect:' + team.team_id })
      + view.button(vm, 'confirm-cancel', jt('settings.team.cancel', 'Cancel')) + '</div>' + view.note(vm.errors['reconnect:' + team.team_id]) + '</div>';
  }

  // ------------------------------------------------------------- actions

  function payload(ctx, host) {
    const now = shown(host);
    const out = { enabled: true };
    if (now.address.trim()) out.public_address = now.address.trim();
    if (now.relay.trim()) out.relay_url = now.relay.trim();
    const token = ctx.secret('teamNetToken').trim();
    if (token) out.token = token;
    return out;
  }

  // Clear token: the saved address and relay again, `token: null` (main removes the stored token; absent would keep it).
  function clearBody(host) {
    const s = saved(host);
    return { enabled: true, ...(s.address ? { public_address: s.address } : {}), ...(s.relay ? { relay_url: s.relay } : {}), token: null };
  }

  async function save(ctx, body) {
    const answer = await ctx.run('net-save', 'network', () => ctx.call('hostInternet', body));
    if (answer) {
      Object.assign(ui, { address: undefined, relay: undefined, tokenTyped: false, fold: null });
      ctx.clearSecret('teamNetToken');
      ctx.setConfirm('');
      if (answer.host) ctx.seed({ host: answer.host });
    }
    ui.code = ''; // every internet save drops the shown Reconnect code
    // A failure answer may still have saved the token or the setting (`changed`): the host state is read again.
    await ctx.refreshAll();
  }

  // Saves the cap the field says (empty is Auto); one outside the bounds is refused here, with the host's own sentence.
  async function savePool(ctx, host) {
    const parsed = poolParse(poolShown(host));
    if (!parsed.ok) { ctx.setNote(ui.poolGroup, words.errorText({ reason: 'team_pool_context_invalid' })); ctx.render(); return; }
    const answer = await ctx.run('pool-save', ui.poolGroup, () => ctx.call('hostPoolContext', { context_cap: parsed.cap }));
    if (!answer) return;
    ui.pool = undefined;
    if (answer.host) ctx.seed({ host: answer.host });
    ctx.render(true);
  }

  async function showCode(ctx) {
    const answer = await ctx.run('net-code', 'network', () => ctx.call('hostReconnectCode'));
    if (answer && typeof answer.code === 'string') { ui.code = answer.code; ui.codeFor = codeKey(ctx.data().host || {}); ui.copied = false; ctx.render(); }
  }

  function copy(ctx) {
    const code = ui.code;
    const write = (typeof window !== 'undefined' && window.jennyShell?.clipboard?.writeText) || null;
    if (!code || typeof write !== 'function') return;
    Promise.resolve(write(code)).then(() => {
      if (ui.code !== code) return;
      ui.copied = true;
      ctx.render();
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyTimer = null; ui.copied = false; ctx.render(); }, COPIED_MS);
    }, () => {});
  }

  async function reconnect(ctx, teamId) {
    const code = ctx.secret('teamReconnectInput').trim();
    const group = 'reconnect:' + teamId;
    if (!code) return;
    let other = false;
    let asked = null; // the page state that asked: the note goes there, never to a page left and opened again (R13-F03)
    const answer = await ctx.run(group, group, async (s) => {
      asked = s;
      const a = await ctx.call('teamReconnectCode', { team_id: teamId, code });
      other = Boolean(a && a.error && a.error.reason === 'team_reconnect_code_other_team');
      return a;
    });
    if (other && asked) {
      const team = ctx.data().teams.find((t) => t.team_id === teamId);
      asked.errors[group] = jt('settings.team.member.otherTeam', 'That code is for a different team. Ask the owner of {team} for theirs.', { team: words.teamName(team) });
      ctx.render();
    }
    if (!answer) return;
    ctx.setConfirm('');
    await ctx.refreshAll();
  }

  function onClick(event, ctx) {
    const target = event.target;
    if (target.closest && target.closest('[data-team-net-fold]')) {
      event.preventDefault();
      const details = target.closest('details');
      ui.fold = !(details && details.open);
      ctx.render(true);
      return true;
    }
    if (target.closest && target.closest('[data-team-net-changes]')) {
      event.preventDefault();
      ui.changes = !ui.changes;
      ctx.render(true);
      return true;
    }
    const sw = target.closest && target.closest('#teamNet');
    const host = ctx.data().host;
    if (sw && host) {
      if (!sw.disabled) { ctx.setConfirm(ctx.confirm().startsWith('net-') ? '' : (host.internet ? 'net-off' : 'net-on')); ctx.render(true); }
      return true;
    }
    const button = target.closest && target.closest('[data-team-action]');
    if (!button || button.disabled || !host) return false;
    const { teamAction: action, teamId } = button.dataset;
    switch (action) {
      case 'net-on': void save(ctx, { enabled: true }); return true;
      case 'net-off': void save(ctx, { enabled: false }); return true;
      case 'net-save': void save(ctx, payload(ctx, host)); return true;
      case 'net-clear-token': ctx.clearSecret('teamNetToken'); void save(ctx, clearBody(host)); return true;
      case 'net-discard': Object.assign(ui, { address: undefined, relay: undefined, tokenTyped: false }); ctx.clearSecret('teamNetToken'); ctx.render(true); return true;
      case 'pool-save': void savePool(ctx, host); return true;
      case 'net-code': void showCode(ctx); return true;
      case 'net-code-copy': copy(ctx); return true;
      case 'enter-code': ctx.setConfirm('code:' + teamId); ctx.render(); return true;
      case 'reconnect': void reconnect(ctx, teamId); return true;
      default: return false;
    }
  }

  // Field text kept across redraws; the save bar appears and goes as the fields differ from what is saved.
  function onInput(event, ctx) {
    const id = event.target && event.target.id;
    if (id === 'teamPoolCap') {
      const host = ctx.data().host;
      const before = host ? poolShown(host).trim() !== poolSaved(host) : false;
      ui.pool = String(event.target.value || '');
      if (host && (poolShown(host).trim() !== poolSaved(host)) !== before) ctx.render();
      return true;
    }
    const key = FIELDS[id];
    if (!key && id !== 'teamNetToken') return id === 'teamReconnectInput';
    const host = ctx.data().host;
    const before = host ? dirty(host) : false;
    if (key) ui[key] = String(event.target.value || '');
    else ui.tokenTyped = String(event.target.value || '') !== '';
    if (host && dirty(host) !== before) ctx.render();
    return true;
  }

  function reset() {
    clearTimeout(copyTimer);
    copyTimer = null;
    ui = fresh();
  }

  return { networkGroup, poolRowHtml, inviteLine, memberRow, codeEntry, onClick, onInput, reset, _pathOf: pathOf };
});
