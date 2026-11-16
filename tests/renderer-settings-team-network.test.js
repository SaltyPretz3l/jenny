'use strict';

// Settings > Team, the Network group and the member rows (row 123, slice 5-6; picks_5-6.md acceptance 1 to 5, 7
// and 8): the switch that asks first, the path picture for each reach reason with only its fix in the open, one
// save bar, the Reconnect code, the line under Invite someone, the 512-character join field, a member's hints and
// "Enter reconnect code". Secrets (the relay token, a pasted code) never enter the page's state or a log. Through
// the real page, store and inventory modules over a stubbed bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { OTHER, flush, snapshot, memberTeam, hostState, harness, heldAnswers } = require('./helpers/team-settings-harness');

const TOKEN = 'relaytoken_' + 'q'.repeat(32);
const CODE = 'jteamaddr1_' + 'R'.repeat(60);
const PORT = 51820;
const on = (reason, over = {}) => hostState({ key: 'ok', direct_port: PORT, internet: { public_address: null, relay_url: null, has_token: false },
  reach: { result: reason === 'mapped' ? 'probably_reachable' : 'not_reachable', reason }, ...over });
const off = (over = {}) => hostState({ key: 'ok', direct_port: PORT, internet: null, reach: { result: 'not_reachable', reason: 'internet_off' }, ...over });
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

function owner(t, host, answers = {}) {
  const h = harness({ host, teams: [snapshot()], answers });
  t.after(h.restore);
  return h;
}
const group = (h) => h.q('[data-team-group="network"]');
const stops = (h) => [...group(h).querySelectorAll('.team-net-stop')].map((s) => [s.dataset.s, text(s.querySelector('b')), text(s.querySelector('span:last-child'))]);
// Fields outside the fold.
const openFields = (h) => [...group(h).querySelectorAll('input')].filter((el) => !el.closest('details') && el.id !== 'teamNet').map((el) => el.id);
async function pushHost(h, host) { h.listeners.host(host); await flush(); }

test('off: one switch row and the Reconnect code row; Invite someone says invites work on this network only', async (t) => {
  const h = owner(t, off());
  await flush();
  const heads = h.headings();
  assert.deepEqual(heads.slice(heads.indexOf('Your devices'), heads.indexOf('Your devices') + 3), ['Your devices', 'Network', 'Share this PC’s GPU']);
  assert.equal(text(h.q('#teamNetTitle')), 'Let people join over the internet');
  assert.equal(text(h.q('#teamNetHelp')), 'Only people on this network can join.');
  assert.equal(h.q('#teamNet').getAttribute('aria-checked'), 'false');
  assert.equal(group(h).querySelector('.team-net-path'), null, 'no picture while off');
  assert.match(text(group(h)), /Reconnect code.*Helps a member’s Jenny find this PC again after its address changes\. It holds no secret\..*Show code/);
  assert.match(text(h.q('[data-team-group="invite"] .settings-group-copy')), /Invites work on this network only\. To invite someone elsewhere, turn on internet joining under Network\./);
});

test('the switch asks first: nothing is sent until Turn on or Turn off; Cancel leaves the setting as it was', async (t) => {
  const h = owner(t, off(), { hostInternet: (p) => ({ ok: true, host: p.enabled ? on('checking') : off(), restarted: true }) });
  await flush();
  h.click('#teamNet');
  await flush();
  assert.equal(h.sent('hostInternet').length, 0);
  const ask = text(h.q('[data-team-group="network"] .team-set-confirm'));
  assert.match(ask, /^Let people join Studio over the internet\?/);
  assert.match(ask, /Jenny asks your router to open one port \(UDP 51820\) for this team, and closes it when you turn this off\./);
  assert.match(ask, /The server restarts now\. Dot are disconnected for a moment and reconnect by themselves\./);
  assert.match(ask, /Members need this version of Jenny or later to join over the internet\./);
  h.click('[data-team-group="network"] [data-team-action="confirm-cancel"]');
  await flush();
  assert.equal(h.q('[data-team-group="network"] .team-set-confirm'), null);
  assert.equal(h.q('#teamNet').getAttribute('aria-checked'), 'false', 'still off');
  h.click('#teamNet');
  await flush();
  h.click('[data-team-action="net-on"]');
  await flush();
  assert.deepEqual(h.sent('hostInternet').map((c) => c.payload), [{ enabled: true }]);
  await pushHost(h, on('mapped'));
  h.click('#teamNet');
  await flush();
  assert.match(text(h.q('[data-team-group="network"] .team-set-confirm')), /^Turn off internet joining\? Members outside this network are cut off/);
  assert.equal(h.sent('hostInternet').length, 1);
  h.click('[data-team-action="net-off"]');
  await flush();
  assert.deepEqual(h.sent('hostInternet').map((c) => c.payload), [{ enabled: true }, { enabled: false }]);
});

const TABLE = [
  ['checking', 'Checking whether people elsewhere can join…', ['pending', 'Your router', 'Asking it to open the port'], ['pending', 'People elsewhere', 'Not known yet'], []],
  ['mapped', 'People elsewhere can join.', ['ok', 'Your router', 'Port 51820 is open'], ['ok', 'People elsewhere', 'Can join with an invite'], []],
  ['public_interface', 'People elsewhere can join.', ['ok', 'Your router', 'This PC has its own public address'], ['ok', 'People elsewhere', 'Can join with an invite'], []],
  ['direct_seen', 'People elsewhere can join. Someone already has.', ['ok', 'Your router', 'Port 51820 is open'], ['ok', 'People elsewhere', 'Someone has connected'], []],
  ['mapping_unavailable', 'People elsewhere cannot join yet.', ['bad', 'Your router', 'Did not open the port'], ['off', 'People elsewhere', 'Cannot reach this PC'], ['teamNetAddr']],
  ['shared_address', 'People elsewhere cannot join yet.', ['bad', 'Your router', 'Shares its public address'], ['off', 'People elsewhere', 'Cannot reach this PC'], ['teamNetRelay', 'teamNetToken']],
  ['relay_connecting', 'Connecting to your relay…', ['pending', 'Your relay', 'relay.example.net'], ['pending', 'People elsewhere', 'Not known yet'], []],
  ['relay_connected', 'People elsewhere can join, through your relay.', ['ok', 'Your relay', 'relay.example.net, connected'], ['ok', 'People elsewhere', 'Can join with an invite'], []],
  ['relay_denied', 'People elsewhere cannot join yet.', ['bad', 'Your relay', 'Refused this PC'], ['off', 'People elsewhere', 'Cannot reach this PC'], ['teamNetToken']],
  ['relay_unreachable', 'People elsewhere cannot join yet.', ['bad', 'Your relay', 'Not answering'], ['off', 'People elsewhere', 'Cannot reach this PC'], ['teamNetRelay']],
];

test('each reach reason: the status line, the middle and far stops, and only its fix outside the fold', async (t) => {
  const relay = { public_address: null, relay_url: 'https://relay.example.net', has_token: true };
  const h = owner(t, on('checking'));
  await flush();
  for (const [reason, head, mid, far, fix] of TABLE) {
    await pushHost(h, on(reason, reason.startsWith('relay') ? { internet: relay } : {}));
    assert.equal(text(group(h).querySelector('.team-net-state')), head, reason);
    const [pc, middle, outside] = stops(h);
    assert.deepEqual(pc, ['ok', 'This PC', 'Server running, port 51820'], reason);
    assert.deepEqual(middle, mid, reason);
    assert.deepEqual(outside, far, reason);
    assert.deepEqual(openFields(h), fix, reason + ': only the fix is in the open');
    assert.equal(text(group(h).querySelector('summary')), fix.length ? 'Other settings…' : 'Set an address or a relay yourself…', reason);
  }
  await pushHost(h, on('public_entered', { internet: { public_address: 'home.example.net', relay_url: null, has_token: false } }));
  assert.deepEqual(stops(h)[2], ['unknown', 'People elsewhere', 'Come in at home.example.net']);
  assert.match(text(group(h).querySelector('.team-net-note')), /Jenny cannot test this from inside your network\. If someone cannot join, check that UDP port 51820 is forwarded to this PC\./);
  await pushHost(h, on('mapped', { state: 'stopped' }));
  assert.equal(text(group(h).querySelector('.team-net-state')), 'The server is stopped. Jenny checks again when you start it.');
  assert.deepEqual(stops(h)[0], ['off', 'This PC', 'Server stopped']);
  assert.equal(h.q('[data-team-action="net-code"]').disabled, true, 'the code waits for the server');
});

test('one save bar: a save keeps every saved value, sends the token only when typed, and waits past the restart', async (t) => {
  const saved = { public_address: null, relay_url: 'https://relay.example.net', has_token: true };
  let release;
  let current = on('relay_connected', { internet: saved });
  const delays = [];
  const h = owner(t, current, {
    hostInternet: () => new Promise((resolve) => { release = (answer) => { current = answer.host; resolve(answer); }; }),
    hostStatus: () => ({ ok: true, host: current }),
  });
  await flush();
  assert.equal(h.q('.team-net-save'), null, 'no save bar until a field differs');
  assert.equal(h.q('#teamNetToken').value, '', 'a saved token is never shown');
  assert.equal(h.q('#teamNetToken').getAttribute('placeholder'), 'A token is saved. Type to replace it');
  h.type('#teamNetAddr', 'home.example.net');
  await flush();
  assert.match(text(h.q('.team-net-save')), /Save and restart server.*Discard changes.*Everyone is disconnected for a moment and reconnects by themselves\./);
  const set = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return set(fn, ms, ...rest); };
  t.after(() => { globalThis.setTimeout = set; });
  h.click('[data-team-action="net-save"]');
  await flush();
  globalThis.setTimeout = set;
  assert.deepEqual(h.sent('hostInternet').map((c) => c.payload), [{ enabled: true, public_address: 'home.example.net', relay_url: 'https://relay.example.net' }],
    'the saved relay is kept and the token is not sent (absent means keep)');
  assert.ok(delays.some((ms) => ms >= 120_000), `the store waits past the 120 s restart: ${delays}`);
  assert.equal(text(group(h).querySelector('.team-net-state')), 'Restarting the server with the new setting…');
  assert.equal(text(h.q('[data-team-action="net-save"]')), 'Saving…');
  assert.equal(h.q('[data-team-group="network"] .team-set-note'), null, 'no error while it runs');
  release({ ok: true, host: on('relay_connected', { internet: { ...saved, public_address: 'home.example.net' } }), restarted: true });
  await flush();
  assert.equal(h.q('.team-net-save'), null);
  h.type('#teamNetToken', TOKEN);
  await flush();
  h.click('[data-team-action="net-save"]');
  await flush();
  assert.equal(h.sent('hostInternet')[1].payload.token, TOKEN, 'a typed token is sent once');
  const kept = JSON.stringify([h.section._live, h.store.snapshot(), h.logged, h.stored]);
  assert.equal(kept.includes(TOKEN), false, 'the token is in no page state, store, log or storage');
  release({ ok: true, host: on('relay_connected', { internet: { ...saved, public_address: 'home.example.net' } }) });
  await flush();
  // Leaving and returning: the saved address and relay, never a token.
  h.section.leaveTeamSection();
  h.section.showTeamSection({ container: h.container });
  await flush();
  h.click('[data-team-net-fold]');
  await flush();
  assert.equal(h.q('#teamNetAddr').value, 'home.example.net');
  assert.equal(h.q('#teamNetRelay').value, 'https://relay.example.net');
  assert.equal(h.q('#teamNetToken').value, '');
});

test('a store push keeps the open fold and a half-typed field; a typed token survives the redraw only in its field', async (t) => {
  const h = owner(t, on('mapped'));
  await flush();
  h.click('[data-team-net-fold]');
  await flush();
  assert.equal(group(h).querySelector('details').open, true);
  h.type('#teamNetAddr', 'home.exa');
  h.type('#teamNetToken', 'half');
  await pushHost(h, on('direct_seen'));
  assert.equal(group(h).querySelector('details').open, true, 'the fold stays open');
  assert.equal(h.q('#teamNetAddr').value, 'home.exa');
  assert.equal(h.q('#teamNetToken').value, 'half');
  assert.equal(JSON.stringify(h.section._live).includes('half'), false);
});

test('the Reconnect code is shown with Copy; the line under Invite someone follows the verdict', async (t) => {
  const h = owner(t, on('mapped'), { hostReconnectCode: { ok: true, code: CODE } });
  await flush();
  assert.match(text(h.q('[data-team-group="invite"] .settings-group-copy')), /New invites work from other networks too\./);
  h.click('[data-team-action="net-code"]');
  await flush();
  assert.equal(text(group(h).querySelector('.team-set-code code')), CODE);
  assert.match(text(group(h).querySelector('.team-set-code__note')), /^Send it to a member whose Jenny cannot find this PC\./);
  h.click('[data-team-action="net-code-copy"]');
  await flush();
  assert.deepEqual(h.copied, [CODE]);
  await pushHost(h, on('mapping_unavailable'));
  assert.match(text(h.q('[data-team-group="invite"] .settings-group-copy')), /People outside this network cannot join yet: see Network below\./);
  await pushHost(h, on('checking'));
  assert.doesNotMatch(text(h.q('[data-team-group="invite"] .settings-group-copy')), /network/i, 'nothing while checking');
});

test('the join field takes a 489-character invite; an invite from a newer Jenny gets its sentence', async (t) => {
  const invite = 'jteam2_' + 'A'.repeat(482);
  const h = harness({ teams: [], answers: { join: { ok: false, error: { code: 'CMP-TEAM-0002', reason: 'team_invite_too_new' } } } });
  t.after(h.restore);
  await flush();
  h.type('#teamYourName', 'Dot');
  h.type('#teamPcName', 'Tower');
  const field = h.q('#teamInviteCode');
  assert.equal(field.getAttribute('maxlength'), '512');
  assert.equal(field.getAttribute('placeholder'), 'jteam2_…');
  h.type('#teamInviteCode', invite);
  h.click('[data-team-action="join"]');
  await flush();
  assert.equal(h.sent('join')[0].payload.invite, invite);
  assert.match(text(h.q('[data-team-group="join"]')), /This invite was made by a newer Jenny\. Update Jenny, then paste it again\./);
});

test('a member row: the approved hint per reason, the relay path word, and Enter reconnect code where it helps', async (t) => {
  const cases = [
    [{ state: 'offline', reason: 'host_unreachable' }, 'The owner’s PC is not answering. It may be off. If its address changed, ask the owner for a reconnect code.', true],
    [{ state: 'offline', reason: 'host_name_unresolved' }, 'Jenny cannot find the owner’s address name. It may come back by itself. If it does not, ask the owner for a reconnect code.', true],
    [{ state: 'offline', reason: 'relay_denied' }, 'The owner’s relay turned this PC away. Ask the owner to check the relay’s access token, then restart Jenny. Jenny still tries to connect directly.', false],
    [{ state: 'reconnecting', reason: 'relay_unreachable' }, 'Jenny cannot reach the owner’s relay and keeps trying. The owner’s PC or the relay may be off.', false],
  ];
  for (const [over, hint, code] of cases) {
    const h = harness({ teams: [memberTeam(over)] });
    await flush();
    const row = h.q('[data-team-joined] .team-set-person');
    assert.equal(text(row.querySelector('.team-set-person__hint')), hint, over.reason);
    assert.equal(Boolean(row.querySelector('[data-team-action="enter-code"]')), code, over.reason);
    h.restore();
  }
  const h = harness({ teams: [memberTeam({ path: 'relay' })] });
  t.after(h.restore);
  await flush();
  assert.equal(text(h.q('[data-team-joined] .team-set-person__fact')), 'Member · connected through the owner’s relay');
});

test('Enter reconnect code: a code for another team is refused with its sentence and changes nothing; the code is in no state', async (t) => {
  const h = harness({ teams: [memberTeam({ state: 'offline', reason: 'host_unreachable' })],
    answers: { teamReconnectCode: { ok: false, error: { code: 'invalid_request', reason: 'team_reconnect_code_other_team' } } } });
  t.after(h.restore);
  await flush();
  h.click('[data-team-action="enter-code"]');
  await flush();
  assert.match(text(h.q('[data-team-joined] .team-set-confirm')), /Paste the reconnect code the owner sent you\./);
  h.type('#teamReconnectInput', CODE);
  h.click('[data-team-action="reconnect"]');
  await flush();
  assert.deepEqual(h.sent('teamReconnectCode').map((c) => c.payload), [{ team_id: OTHER, code: CODE }]);
  assert.match(text(h.q('[data-team-joined]')), /That code is for a different team\. Ask the owner of Dot lab for theirs\./);
  assert.equal(h.q('#teamReconnectInput').value, CODE, 'still in its field to correct');
  assert.equal(JSON.stringify([h.section._live, h.store.snapshot(), h.logged]).includes(CODE), false);
  assert.equal(h.sent('status').length >= 1, true);
  assert.equal(h.store.snapshot().teams[0].team_id, OTHER, 'the team is unchanged');
});

// Team review R13-F03: the "different team" note goes to the page that asked, never to one opened again meanwhile.
test('Enter reconnect code: an answer that lands after the page was left and opened again writes no note there', async (t) => {
  const gate = heldAnswers();
  const h = harness({ teams: [memberTeam({ state: 'offline', reason: 'host_unreachable' })], answers: { teamReconnectCode: gate.answer } });
  t.after(h.restore);
  await flush();
  h.click('[data-team-action="enter-code"]');
  await flush();
  h.type('#teamReconnectInput', CODE);
  h.click('[data-team-action="reconnect"]');
  await flush();
  h.section.leaveTeamSection();
  h.section.showTeamSection({ container: h.container });
  await flush();
  gate.release({ ok: false, error: { code: 'invalid_request', reason: 'team_reconnect_code_other_team' } });
  await flush();
  assert.equal(gate.calls.length, 1);
  h.click('[data-team-action="enter-code"]');
  await flush();
  assert.match(text(h.q('[data-team-joined] .team-set-confirm')), /Paste the reconnect code the owner sent you\./, 'the reopened page\'s own question');
  assert.doesNotMatch(text(h.q('[data-team-joined]')), /That code is for a different team/);
});

// ------------------------------------------------------------------ review of 5-6 (fix list items 7, 22, 24)

test('the reason sentences elsewhere use the approved words: relay token, reconnect code, the owner of {team}', () => {
  const words = require('../renderer/shell/renderer-settings-team-strings');
  assert.equal(words.errorText({ reason: 'relay_denied' }), 'The owner’s relay turned this PC away. Ask the owner to check the relay’s access token, then restart Jenny. Jenny still tries to connect directly.');
  assert.equal(words.errorText({ reason: 'host_name_unresolved' }), 'Jenny cannot find the owner’s address name. It may come back by itself. If it does not, ask the owner for a reconnect code.');
  assert.equal(words.errorText({ reason: 'team_reconnect_code_other_team', team: { team_id: OTHER, team_name: 'Dot lab' } }), 'That code is for a different team. Ask the owner of Dot lab for theirs.');
  assert.equal(words.errorText({ reason: 'team_export_links', count: 2 }), '2 items in the team’s files point somewhere else on this PC, so nothing was exported. Remove those links, then export again.');
  assert.equal(words.errorText({ reason: 'team_export_unreadable_files', count: 1 }), '1 file of the team could not be read, so nothing was exported. Close any program using the team’s files, then export again.');
});

test('a router that never answers: after the check\'s bound the page says Jenny could not tell, not checking for ever', async (t) => {
  const h = owner(t, on('checking_unknown'));
  await flush();
  assert.match(text(group(h)), /Jenny could not tell whether people elsewhere can join\./);
  assert.equal(/Checking whether people elsewhere can join/.test(text(group(h))), false);
  assert.deepEqual(stops(h).slice(1), [['unknown', 'Your router', 'Did not answer'], ['unknown', 'People elsewhere', 'Not known']]);
  assert.equal(h.q('[data-team-invite-line]')?.textContent || '', '', 'no line under Invite someone while it cannot tell');
});

test('a restored team comes back with joining off; once the owner turns it on, the backup\'s values fill the form to save', async (t) => {
  const draft = { public_address: 'home.example.net', relay_url: 'https://relay.example.org' };
  const h = owner(t, off({ internet_draft: draft }), { hostInternet: { ok: true, host: on('mapped', { internet_draft: draft }) } });
  await flush();
  h.click('#teamNet');
  await flush();
  h.click('[data-team-action="net-on"]');
  await flush();
  assert.deepEqual(h.sent('hostInternet').map((c) => c.payload), [{ enabled: true }], 'the confirmation turns it on with nothing else');
  await pushHost(h, on('mapped', { internet_draft: draft }));
  assert.equal(h.q('#teamNetAddr').value, 'home.example.net');
  assert.equal(h.q('#teamNetRelay').value, 'https://relay.example.org');
});
