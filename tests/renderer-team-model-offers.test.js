'use strict';

// new-test-file: the Team tab's model offer card and the tab number's offers (row 123, slice 6-7) are a new surface;
// renderer-team-tab-gate.test.js (592) and renderer-team-notice.test.js would cross the line cap with them.
// Someone offers this member a model: the notice region's second kind (every member who can receive, the join card
// first), Review… setting the model store's review id and opening Settings › Models, Decline, Later, and the Team tab's
// number and its tooltip with offers alone and mixed. Real modules over the shared team harness; every bridge call is
// checked against main's real payload check at teardown.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, OTHER, flush, snapshot, memberTeam, hostState, device, ROSTER, harness, shell, layout } = require('./helpers/team-settings-harness');
const { badgeLabel } = require('../renderer/team/renderer-team-tab-gate');

const OFFER = 'offer_IN1aaaaaaaaaaaaaaaaaaa';
const OFFER2 = 'offer_IN2aaaaaaaaaaaaaaaaaaa';
const offer = (over = {}) => ({ offer_id: OFFER, sender_member_id: 'member_arjun', sender_name: 'Arjun', audience: 'member', display_name: 'Bonsai 12B',
  files: 2, total_bytes: 2_000_000_000, state: 'open', reason: null, offered_at: '2026-11-13T09:00:00.000Z', transfer: null, ...over });
const modelState = (incoming) => () => ({ ok: true, sharing: 'on', sharing_reason: null, online: true, rate_mb_per_second: 0, outgoing: [], incoming });
const SAM = { member_id: 'member_sam', display_name: 'Sam', role: 'member', state: 'pending',
  devices: [device('device_sam', 'Sam laptop', { member_id: 'member_sam', created_at: 10, fingerprint: '4f2a91c3aa' })] };

async function openMember(t, incoming, answers = {}) {
  const h = harness({ show: false, teams: [memberTeam()], models: true, answers: { modelState: modelState(incoming), ...answers } });
  t.after(h.restore);
  layout(h);
  h.showTab();
  await flush();
  return h;
}
const card = (h) => h.view.q('.team-notice .inv-toast');
const act = (h, name) => card(h).querySelector(`[data-team-notice="${name}"]`);
const plain = (el) => el.textContent.replace(/[\u2068\u2069]/g, '');
const models = () => globalThis.rendererTeamModelStore.peekModelStore();

test('a plain member sees the offer card: eyebrow, sender, model and size, the hint, Review…, Decline and Later', async (t) => {
  const h = await openMember(t, [offer()]);
  const toast = card(h);
  assert.ok(toast, 'the card is there for a member who does not host');
  assert.equal(toast.getAttribute('role'), 'status');
  assert.equal(toast.querySelector('.inv-toast__eyebrow').textContent, 'Offers you a model');
  assert.equal(plain(toast.querySelector('.inv-toast__message')), 'Arjun · Bonsai 12B · 1.9 GB');
  assert.equal(toast.querySelector('.team-notice__hint').textContent, 'Only accept models from people you trust. Review shows what is in it before anything downloads.');
  assert.equal(act(h, 'offer-review').textContent, 'Review…');
  assert.ok(act(h, 'offer-review').classList.contains('inv-toast__action--primary'));
  assert.equal(act(h, 'offer-review').getAttribute('title'), 'Open the offer in Settings, Models to see what is in it');
  assert.equal(act(h, 'offer-decline').textContent, 'Decline');
  assert.equal(plain({ textContent: act(h, 'offer-decline').getAttribute('title') }), 'Say no to Arjun');
  assert.equal(act(h, 'offer-later').getAttribute('aria-label'), 'Later');
  assert.equal(act(h, 'offer-later').getAttribute('title'), 'Later: the offer waits in Settings, Models');
  for (const button of toast.querySelectorAll('button')) assert.ok(button.getAttribute('title'), 'every button has a tooltip');
});

test('Review… sets the store\'s review id and opens Settings › Models; nothing is downloaded or answered', async (t) => {
  const h = await openMember(t, [offer()]);
  act(h, 'offer-review').click();
  await flush();
  assert.deepEqual(h.opened, ['models']);
  assert.deepEqual(models().peekReview(), { team_id: OTHER, offer_id: OFFER });
  assert.equal(h.sent('modelAccept').length + h.sent('modelDecline').length + h.sent('modelOfferRead').length, 0);
});

test('Decline answers the offer once and the card goes; a refusal shows its sentence and keeps the card', async (t) => {
  let refuse = true;
  const h = await openMember(t, [offer()], { modelDecline: () => (refuse ? { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_model_offer_taken' } } : { ok: true }) });
  act(h, 'offer-decline').click();
  await flush();
  assert.deepEqual(h.sent('modelDecline').map((c) => c.payload), [{ team_id: OTHER, offer_id: OFFER }]);
  assert.ok(card(h), 'still there after a refusal');
  assert.ok(card(h).querySelector('.team-notice__error').textContent.length > 0, 'the refusal in words');
  assert.equal(act(h, 'offer-decline').disabled, false, 'the control is given back');
  refuse = false;
  act(h, 'offer-decline').click();
  await flush();
  assert.equal(h.sent('modelDecline').length, 2);
  assert.equal(card(h), null, 'the card goes at once; the row ends with main\'s push');
});

test('Later hides the card for this run; the number still counts the offer and the next offer shows', async (t) => {
  const h = await openMember(t, [offer(), offer({ offer_id: OFFER2, sender_name: 'Priya', display_name: 'Qwen 4B', offered_at: '2026-11-13T10:00:00.000Z' })]);
  assert.match(plain(card(h).querySelector('.inv-toast__message')), /^Arjun/, 'the oldest first');
  act(h, 'offer-later').click();
  await flush();
  assert.match(plain(card(h).querySelector('.inv-toast__message')), /^Priya/);
  act(h, 'offer-later').click();
  await flush();
  assert.equal(card(h), null);
  assert.equal(models().offerCount(), 2, 'set aside, still waiting for an answer');
  assert.equal(h.sent('modelDecline').length, 0);
});

test('an offer in another team names the team; the shown team\'s offer comes first', async (t) => {
  const h = harness({ show: false, teams: [memberTeam(), memberTeam({ team_id: TEAM, team_name: 'Studio' })], models: true, answers: {
    modelState: (p) => modelState(p.team_id === TEAM ? [offer({ offer_id: OFFER2, sender_name: 'Priya', offered_at: '2026-11-13T08:00:00.000Z' })] : [offer()])() } });
  t.after(h.restore);
  layout(h);
  h.showTab();
  await flush();
  // The tab shows the team hosted here, else the first one (Dot lab): its offer first, though Studio's is older.
  assert.equal(plain(card(h).querySelector('.inv-toast__message')), 'Arjun · Bonsai 12B · 1.9 GB');
  act(h, 'offer-later').click();
  await flush();
  assert.equal(plain(card(h).querySelector('.inv-toast__message')), 'Priya · Bonsai 12B · 1.9 GB · Studio', 'the other team named');
});

// Row 201 H24: a join request never hides an offer; each has its own card, the join card first.
test('the join card keeps its place in front and the offer shows beside it; setting the person aside leaves the offer', async (t) => {
  const active = ROSTER.filter((member) => member.state === 'active');
  const h = harness({ show: false, host: hostState(), teams: [snapshot()], models: true, answers: {
    members: () => ({ ok: true, members: active.concat(SAM) }), modelState: modelState([offer()]) } });
  t.after(h.restore);
  layout(h);
  h.showTab();
  await flush();
  const eyebrows = () => h.view.qa('.team-notice .inv-toast .inv-toast__eyebrow').map((el) => el.textContent);
  assert.deepEqual(eyebrows(), ['Wants to join', 'Offers you a model']);
  card(h).querySelector('[data-team-notice="later"]').click();
  await flush();
  assert.deepEqual(eyebrows(), ['Offers you a model']);
  act(h, 'offer-later').click();
  await flush();
  assert.deepEqual(eyebrows(), [], 'Later on the offer clears its own card');
});

test('hostile names are cleaned, cut and escaped on the card', async (t) => {
  const h = await openMember(t, [offer({ sender_name: 'Ar\u202ejun\u200b<img src=x onerror=alert(1)>', display_name: 'B'.repeat(400) })]);
  const message = card(h).querySelector('.inv-toast__message');
  assert.equal(message.querySelector('img'), null);
  assert.doesNotMatch(message.textContent, /[\u202e\u200b]/);
  assert.ok(plain(message).length < 300, 'cut to a bound');
  assert.match(plain(message), /Ar jun <img src=x onerror=alert\(1\)>/);
});

test('the number counts offers and its tooltip names them, alone and mixed; the older labels keep their words', () => {
  assert.equal(badgeLabel(0, 0, 0, 0, 1), 'Team: 1 model offered to you');
  assert.equal(badgeLabel(0, 0, 0, 0, 3), 'Team: 3 models offered to you');
  assert.equal(badgeLabel(2, 1, 0, 0, 1), 'Team: 2 channels mention you, 1 model offered to you, 1 person wants to join');
  assert.equal(badgeLabel(0, 0, 1, 1, 2), 'Team: 1 unread conversation, 1 always-allow request waits for you, 2 models offered to you');
  assert.equal(badgeLabel(2, 1), 'Team: 2 channels mention you, 1 person wants to join');
  assert.equal(badgeLabel(0, 1, 0, 0), 'Team: 1 person wants to join');
});

test('through the gate: an offer moves the Team tab number with its label, and a Later keeps counting it', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()], models: true, answers: { modelState: modelState([offer()]) } });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  await flush();
  assert.equal(s.count(), '1');
  assert.equal(s.teamTab().getAttribute('aria-label'), 'Team: 1 model offered to you');
  models().setLater(OFFER);
  await flush();
  assert.equal(s.count(), '1', 'set aside is still waiting');
  h.listeners.model({ team_id: OTHER, kind: 'state', sharing: 'on', sharing_reason: null, online: true, rate_mb_per_second: 0, outgoing: [],
    incoming: [offer({ state: 'ended', reason: 'declined' })] });
  await flush();
  assert.equal(s.count(), '');
});
