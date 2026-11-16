'use strict';

// new-test-file: Settings › Team's "Model sharing" groups (row 123, slice 6-7) are a new module with its own surface;
// renderer-settings-team-section.test.js (577) and renderer-settings-team-sharing.test.js would cross the line cap.
// The host's group (switch, the question while models pass, the passing line, "At the same time", the owner's speed),
// a member's group (the fact and why, the speed, one pair per team), the kill switch, and that a member's page never
// offers or calls the host's setting. Real modules over the shared team harness; every bridge call is checked against
// main's real payload check at teardown.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, OTHER, flush, snapshot, memberTeam, hostState, harness, heldAnswers } = require('./helpers/team-settings-harness');
const { HOST_METHODS, HOST_OPERATIONS, METHODS, validatePayload } = require('../services/team/ipc-methods');

const state = (over = {}) => () => ({ ok: true, sharing: 'on', sharing_reason: null, online: true, rate_mb_per_second: 0, outgoing: [], incoming: [], ...over });
const KILLED = () => ({ ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_model_sharing_off' } });
const RECEIVERS = { ok: true, members: [{ member_id: 'member_olive', display_name: 'Olive', role: 'owner', can_receive: true }] };
const KILL = 'Turned off when Jenny started (JENNY_ENABLE_TEAM_MODEL_SHARING=0). Remove that setting and restart Jenny to use model sharing.';
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

async function ownerPage(t, relay, answers = {}) {
  const h = harness({ host: hostState({ model_relay: relay }), teams: [snapshot()], models: true, answers: { modelState: state(), ...answers } });
  t.after(h.restore);
  await flush();
  await flush();
  return h;
}
async function memberPage(t, teams, answers = {}) {
  const h = harness({ teams, models: true, answers: { modelState: state(), modelReceivers: RECEIVERS, ...answers } });
  t.after(h.restore);
  await flush();
  await flush();
  return h;
}
const group = (h, id) => h.q(`[data-team-group="${id}"]`);
const help = (h, id) => text(h.q('#' + id));

test('host: the group sits after GPU use and before Activity, with the copy, the switch on, the passing line and its rows', async (t) => {
  const h = await ownerPage(t, { flowing: 2, passing: 0, live: true });
  const headings = h.headings();
  assert.equal(headings.indexOf('Model sharing'), headings.indexOf('GPU use') + 1);
  assert.equal(headings.indexOf('Activity'), headings.indexOf('Model sharing') + 1);
  const g = group(h, 'models');
  assert.equal(text(g.querySelector('.settings-group-copy')), 'You and full members can send and receive. Read-only members cannot. You send a model from Settings, Models: ⋯ on the model.');
  assert.equal(text(h.q('#teamModelRelayTitle')), 'Let members send each other models');
  assert.equal(help(h, 'teamModelRelayHelp'), 'Model files members send each other pass through this PC and use its network connection. Jenny keeps none of them.');
  assert.equal(h.q('#teamModelRelay').getAttribute('aria-checked'), 'true');
  assert.equal(text(g.querySelector('.team-relay-state')), 'Nothing is passing through right now.');
  assert.equal(h.q('#teamModelRelayFlowing').value, '2');
  assert.deepEqual([...h.q('#teamModelRelayFlowing').options].map((o) => o.value), ['1', '2', '3', '4']);
  assert.equal(help(h, 'teamModelRelayFlowingHelp'), 'How many models pass through this PC at once. Others wait their turn.');
  const speed = h.q(`#teamModelRate-${TEAM}`);
  assert.deepEqual([...speed.options].map((o) => o.textContent), ['No limit', '1 MB a second', '5 MB a second', '10 MB a second', '25 MB a second']);
  assert.equal(speed.disabled, false);
  assert.equal(h.sent('hostModelRelay').length, 0, 'nothing is set by drawing');
});

test('host: switching off while nothing passes sets 0 at once; "At the same time" sets its number', async (t) => {
  const h = await ownerPage(t, { flowing: 2, passing: 0, live: true });
  h.q('[data-inv-toggle="teamModelRelay"]').click();
  await flush();
  h.choose('#teamModelRelayFlowing', '3');
  await flush();
  assert.deepEqual(h.sent('hostModelRelay').map((c) => c.payload), [{ flowing: 0 }, { flowing: 3 }]);
});

test('host: switching off while models pass asks first; Cancel keeps it, Turn off sets 0', async (t) => {
  const h = await ownerPage(t, { flowing: 2, passing: 3, live: true });
  assert.equal(text(group(h, 'models').querySelector('.team-relay-state')), '3 models are passing through this PC right now.');
  h.q('[data-inv-toggle="teamModelRelay"]').click();
  await flush();
  const ask = group(h, 'models').querySelector('.team-set-confirm');
  assert.equal(text(ask.querySelector('p')), 'Turn off model sharing? 3 models are passing through this PC right now, and they stop. Their offers end, so the senders have to offer them again after you turn this back on.');
  assert.equal(h.sent('hostModelRelay').length, 0, 'asked, not done');
  h.q('[data-team-action="confirm-cancel"]').click();
  await flush();
  assert.equal(group(h, 'models').querySelector('.team-set-confirm'), null);
  assert.equal(h.sent('hostModelRelay').length, 0);
  h.q('[data-inv-toggle="teamModelRelay"]').click();
  await flush();
  h.q('[data-team-action="model-relay-confirm-off"]').click();
  await flush();
  assert.deepEqual(h.sent('hostModelRelay').map((c) => c.payload), [{ flowing: 0 }]);
});

// Team review R13-F03: the relay's answer closes only its own question, and only when it has one.
test('host: an answer to the relay setting leaves the delete confirmation opened while it was out', async (t) => {
  const gate = heldAnswers();
  const h = await ownerPage(t, { flowing: 2, passing: 0, live: true }, { hostModelRelay: gate.answer });
  h.choose('#teamModelRelayFlowing', '3');
  await flush();
  h.click('[data-team-action="del-open"]');
  await flush();
  h.type('#teamDeleteName', 'Stu');
  assert.ok(h.q('.team-del'), 'the delete confirmation is open');
  gate.release({ ok: true });
  await flush();
  assert.ok(h.q('.team-del'), 'still open after an accepted answer');
  assert.equal(h.q('#teamDeleteName').value, 'Stu', 'the typed name stays');
  h.q('[data-inv-toggle="teamModelRelay"]').click();
  await flush();
  assert.ok(h.q('.team-del'), 'the switch sends at once while nothing passes');
  gate.release({ ok: false, error: { reason: 'not_allowed' } });
  await flush();
  assert.ok(h.q('.team-del'), 'still open after a refused answer');
  assert.deepEqual(gate.calls, [{ flowing: 3 }, { flowing: 0 }]);
});

test('host: an accepted Turn off closes its own question', async (t) => {
  const gate = heldAnswers();
  const h = await ownerPage(t, { flowing: 2, passing: 3, live: true }, { hostModelRelay: gate.answer });
  h.q('[data-inv-toggle="teamModelRelay"]').click();
  await flush();
  h.q('[data-team-action="model-relay-confirm-off"]').click();
  await flush();
  assert.ok(group(h, 'models').querySelector('.team-set-confirm'), 'asked and waiting');
  gate.release({ ok: true });
  await flush();
  assert.equal(group(h, 'models').querySelector('.team-set-confirm'), null);
});

test('host: while off the rows are greyed with their reasons and the switch turns back on with 2', async (t) => {
  const h = await ownerPage(t, { flowing: 0, passing: 0, live: true });
  assert.equal(h.q('#teamModelRelay').getAttribute('aria-checked'), 'false');
  assert.equal(group(h, 'models').querySelector('.team-relay-state'), null, 'no passing line while off');
  assert.equal(h.q('#teamModelRelayFlowing').disabled, true);
  assert.equal(help(h, 'teamModelRelayFlowingHelp'), 'Turn on model sharing to change this.');
  assert.equal(h.q(`#teamModelRate-${TEAM}`).disabled, true);
  assert.equal(help(h, `teamModelRate-${TEAM}-help`), 'Model sharing is off, so nothing is sent.');
  h.q('[data-inv-toggle="teamModelRelay"]').click();
  await flush();
  assert.deepEqual(h.sent('hostModelRelay').map((c) => c.payload), [{ flowing: 2 }]);
});

// Fix list M2, decision 1: the kill switch is this PC's own sending and receiving. The host's switch and its limit run
// on the host: never greyed, redrawn or re-worded by it; the owner's fact row says it, as a member's does.
test('host: the kill switch leaves the host\'s switch and limit alone; the owner\'s fact row says it and the speed is greyed', async (t) => {
  const h = await ownerPage(t, { flowing: 2, passing: 0, live: true }, { modelState: KILLED });
  const toggle = h.q('#teamModelRelay');
  assert.equal(toggle.disabled || toggle.getAttribute('aria-disabled') === 'true', false);
  assert.equal(toggle.getAttribute('aria-checked'), 'true', 'drawn as the relay is: on');
  assert.equal(help(h, 'teamModelRelayHelp'), 'Model files members send each other pass through this PC and use its network connection. Jenny keeps none of them.');
  assert.equal(h.q('#teamModelRelayFlowing').disabled, false);
  assert.equal(help(h, 'teamModelRelayFlowingHelp'), 'How many models pass through this PC at once. Others wait their turn.');
  assert.equal(text(h.q(`[data-team-models-fact="${TEAM}"]`)), 'Off');
  assert.equal(help(h, `teamModelFact-${TEAM}-help`), KILL);
  assert.equal(h.q(`#teamModelRate-${TEAM}`).disabled, true);
  assert.equal(help(h, `teamModelRate-${TEAM}-help`), 'Model sharing is turned off.');
  h.q('[data-inv-toggle="teamModelRelay"]').click();
  await flush();
  assert.deepEqual(h.sent('hostModelRelay').map((c) => c.payload), [{ flowing: 0 }], 'the owner can still turn the relay off');
});

test('host: the owner\'s fact row says On while the relay runs, and the speed goes through modelSetRate', async (t) => {
  const h = await ownerPage(t, { flowing: 2, passing: 0, live: true });
  assert.equal(text(h.q(`[data-team-models-fact="${TEAM}"]`)), 'On');
  assert.equal(help(h, `teamModelFact-${TEAM}-help`), 'On for Studio. You send a model from Settings, Models: ⋯ on the model.');
  h.choose(`#teamModelRate-${TEAM}`, '10');
  await flush();
  assert.deepEqual(h.sent('modelSetRate').map((c) => c.payload), [{ team_id: TEAM, mb_per_second: 10 }]);
});

// Fix list S1: Force local refuses the setting in main; the page greys "At the same time" with its reason, like the switch.
test('host: Force local greys the switch and "At the same time" and says why', async (t) => {
  const h = harness({ host: hostState({ model_relay: { flowing: 2, passing: 0, live: true }, force_local: true }), teams: [snapshot()], models: true, answers: { modelState: state() } });
  t.after(h.restore);
  await flush();
  await flush();
  const toggle = h.q('#teamModelRelay');
  assert.equal(toggle.disabled || toggle.getAttribute('aria-disabled') === 'true', true);
  assert.equal(h.q('#teamModelRelayFlowing').disabled, true);
  assert.equal(text(h.q('#teamModelRelayFlowingHelp')), require('../renderer/shell/renderer-settings-team-strings').forceLocalText());
});

test('member: the fact On with its sentence, the host named in the copy, the speed set through modelSetRate', async (t) => {
  const h = await memberPage(t, [memberTeam()]);
  const g = group(h, 'models-member');
  const headings = h.headings();
  assert.equal(headings.indexOf('Model sharing'), headings.indexOf('Share this PC’s GPU') + 1);
  assert.equal(text(g.querySelector('.settings-group-copy')), 'A model you send or receive goes through Olive’s computer, which can read it on the way and keeps none of it.');
  assert.equal(text(g.querySelector(`[data-team-models-fact="${OTHER}"]`)), 'On');
  assert.equal(help(h, `teamModelFact-${OTHER}-help`), 'On for Dot lab. You send a model from Settings, Models: ⋯ on the model.');
  assert.deepEqual(h.sent('modelReceivers').map((c) => c.payload), [{ team_id: OTHER }], 'the host\'s name, asked once');
  h.choose(`#teamModelRate-${OTHER}`, '5');
  await flush();
  assert.deepEqual(h.sent('modelSetRate').map((c) => c.payload), [{ team_id: OTHER, mb_per_second: 5 }]);
  assert.equal(h.q('#teamModelRelay'), null, 'a member is never offered the host\'s setting');
  assert.equal(h.sent('hostModelRelay').length, 0);
});

test('member: the host turned sharing off, a read-only member, and the kill switch each say Off and why', async (t) => {
  await t.test('host off', async (tt) => {
    const h = await memberPage(tt, [memberTeam()], { modelState: state({ sharing: 'off' }) });
    assert.equal(text(h.q(`[data-team-models-fact="${OTHER}"]`)), 'Off');
    assert.equal(help(h, `teamModelFact-${OTHER}-help`), 'Olive has turned model sharing off for this team.');
    assert.equal(h.q(`#teamModelRate-${OTHER}`).disabled, true);
    assert.equal(help(h, `teamModelRate-${OTHER}-help`), 'Model sharing is off, so nothing is sent.');
  });
  await t.test('read-only', async (tt) => {
    const h = await memberPage(tt, [memberTeam({ role: 'read_only' })]);
    assert.equal(text(h.q(`[data-team-models-fact="${OTHER}"]`)), 'Off');
    assert.equal(help(h, `teamModelFact-${OTHER}-help`), 'Read-only members cannot send or receive models. The owner can change your role.');
    assert.equal(help(h, `teamModelRate-${OTHER}-help`), 'Read-only members cannot send models.');
    assert.equal(h.q(`#teamModelRate-${OTHER}`).disabled, true);
  });
  await t.test('kill switch', async (tt) => {
    const h = await memberPage(tt, [memberTeam()], { modelState: KILLED });
    assert.equal(text(h.q(`[data-team-models-fact="${OTHER}"]`)), 'Off');
    assert.equal(help(h, `teamModelFact-${OTHER}-help`), KILL);
    assert.equal(h.q(`#teamModelRate-${OTHER}`).disabled, true);
  });
});

test('member of two teams: one fact and one speed per team, each named', async (t) => {
  const h = await memberPage(t, [memberTeam(), memberTeam({ team_id: TEAM, team_name: 'Studio' })]);
  const titles = [...group(h, 'models-member').querySelectorAll('.settings-field-title')].map(text);
  assert.deepEqual(titles, ['Sending and receiving models in Dot lab', 'Limit my sending speed in Dot lab', 'Sending and receiving models in Studio', 'Limit my sending speed in Studio']);
  assert.equal(text(group(h, 'models-member').querySelector('.settings-group-copy')), 'A model you send or receive goes through the host’s computer, which can read it on the way and keeps none of it.');
});

test('a hostile host name is cleaned and escaped in the copy', async (t) => {
  const h = await memberPage(t, [memberTeam()], { modelReceivers: { ok: true, members: [{ member_id: 'member_o', display_name: 'Ol\u202eive\u200b<b>x</b>', role: 'owner', can_receive: true }] } });
  const copy = group(h, 'models-member').querySelector('.settings-group-copy');
  assert.equal(copy.querySelector('b'), null);
  assert.doesNotMatch(copy.textContent, /[\u202e\u200b]/);
  assert.match(copy.textContent, /Ol ive <b>x<\/b>’s computer/);
});

test('the host\'s setting is the owner\'s own main call: never a host operation a member\'s client can send', () => {
  assert.equal(HOST_METHODS.includes('hostModelRelay'), true);
  assert.equal(Object.hasOwn(METHODS, 'hostModelRelay'), true);
  assert.equal(validatePayload('hostModelRelay', { flowing: 5 }).ok, false, 'at most 4 at once');
  assert.equal(Object.hasOwn(HOST_OPERATIONS, 'hostModelRelay'), false);
});

// Fix list T3: the team's name is hostile text like the host's: cleaned of bidi and zero-width characters, cut to the
// one bound for names, escaped.
test('a hostile team name is cleaned, cut to the name bound and escaped in the labels and the fact', async (t) => {
  const name = 'Dot\u202e lab\u200b<i>x</i>' + 'y'.repeat(100);
  const h = await memberPage(t, [memberTeam({ team_name: name }), memberTeam({ team_id: TEAM, team_name: 'Studio' })]);
  const g = group(h, 'models-member');
  assert.equal(g.querySelector('i'), null);
  const label = text(g.querySelector('.settings-field-title'));
  assert.doesNotMatch(label + help(h, `teamModelFact-${OTHER}-help`), /[\u202e\u200b]/);
  const want = ('Dot lab <i>x</i>' + 'y'.repeat(100)).slice(0, 64) + '…';
  assert.equal(label, 'Sending and receiving models in ' + want, 'hidden characters out, cut to 64 like a person name');
  assert.equal(help(h, `teamModelFact-${OTHER}-help`), `On for ${want}. You send a model from Settings, Models: ⋯ on the model.`);
});
