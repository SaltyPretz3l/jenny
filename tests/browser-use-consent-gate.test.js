'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUrlGuard } = require('../services/browser-use/url-guard');
const {
  cleanLabel, createConsentGate, evaluateClick, evaluateNavigate, evaluatePress, evaluateSelect,
  evaluateType, namedByUser, refusalMessage, siteKey,
} = require('../services/browser-use/consent-gate');

const OLLAMA = 11434;
const guard = createUrlGuard({
  resolveHost: async () => ({ endpoints: [{ address: '93.184.216.34' }] }),
  reservedPorts: () => [OLLAMA],
});
const verdictFor = url => guard.classify(url);

function facts(overrides = {}) {
  return {
    status: 'ready', ref: 'r1', tag: 'button', role: 'button', inputType: 'button', name: 'Open',
    isAnchor: false, href: '', isFileInput: false, isSecret: false, isEditable: false, disabled: false,
    form: { present: false, method: 'get', action: '', hasSecretField: false },
    ...overrides,
  };
}
const postForm = { present: true, method: 'post', action: 'https://start.example/save', hasSecretField: false };
const getForm = { present: true, method: 'get', action: 'https://start.example/find', hasSecretField: false };
const signInForm = { present: true, method: 'get', action: 'https://start.example/in', hasSecretField: true };

function harness({ url = 'https://start.example/', answer = true, waitMs = 0, userText = '', signal } = {}) {
  const state = { url, time: 1000, asks: [] };
  const consent = createConsentGate({ urlGuard: guard, getCurrentUrl: () => state.url, now: () => state.time });
  const authorize = async (params, askSignal) => {
    state.asks.push({ params, askSignal });
    state.time += waitMs;
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(params) : answer;
  };
  const gate = consent.forCall({
    authorize, callId: 'call-1', toolInput: { action: 'navigate' }, signal, userText,
  });
  return { consent, gate, state };
}

test('siteKey folds www, keeps sub-domains apart and keys loopback by port', () => {
  assert.equal(siteKey(verdictFor('https://www.example.com/a')), 'example.com');
  assert.equal(siteKey(verdictFor('https://example.com:8443/')), 'example.com');
  assert.equal(siteKey(verdictFor('https://docs.example.com/')), 'docs.example.com');
  assert.equal(siteKey(verdictFor('http://localhost:3000/')), 'localhost:3000');
  assert.equal(siteKey(verdictFor('http://[::1]:3000/')), '[::1]:3000');
  assert.equal(siteKey(verdictFor('file:///C:/x')), '');
  assert.equal(siteKey(verdictFor('https://www.com/')), 'www.com');
});

test('a host counts as named only when the user wrote exactly that host', () => {
  const named = verdict => text => namedByUser(verdict, text);
  const example = named(verdictFor('https://example.com/'));
  for (const text of [
    'open example.com please', 'see https://example.com/pricing', 'EXAMPLE.COM', 'www.example.com is down', '(example.com)', 'example.com.',
  ]) assert.equal(example(text), true, text);
  for (const text of [
    '', 'open docs.example.com', 'example.com.evil.net', 'myexample.com', 'my-example.com', 'write to me@example.com', 'example.community',
  ]) assert.equal(example(text), false, text);
  assert.equal(named(verdictFor('https://www.example.com/'))('example.com'), true);
  assert.equal(named(verdictFor('https://docs.example.com/'))('example.com'), false);
});

test('naming localhost needs the port, except on a default port', () => {
  const dev = verdictFor('http://localhost:3000/');
  assert.equal(namedByUser(dev, 'check localhost:3000'), true);
  assert.equal(namedByUser(dev, 'check http://localhost:3000/app'), true);
  assert.equal(namedByUser(dev, 'check localhost'), false);
  assert.equal(namedByUser(dev, 'check localhost:30001'), false);
  assert.equal(namedByUser(dev, 'check localhost:8080'), false);
  const plain = verdictFor('http://localhost/');
  assert.equal(namedByUser(plain, 'open localhost'), true);
  assert.equal(namedByUser(plain, 'open localhost:3000'), false);
  assert.equal(namedByUser(verdictFor('http://[::1]:3000/'), 'see [::1]:3000'), true);
  assert.equal(namedByUser(verdictFor('http://127.0.0.1:5173/'), 'see 127.0.0.1:5173'), true);
});

test('navigate passes for the current site, a granted site or a named site', () => {
  const verdict = verdictFor('https://example.com/a');
  assert.equal(evaluateNavigate(verdict, { currentKey: 'example.com' }).reason, 'same_site');
  assert.equal(evaluateNavigate(verdict, { grants: new Set(['example.com']) }).reason, 'granted');
  assert.equal(evaluateNavigate(verdict, { userText: 'go to example.com' }).reason, 'named_by_user');
});

test('navigate asks for any other site, including localhost', () => {
  const site = evaluateNavigate(verdictFor('https://example.com/a'), {});
  assert.deepEqual([site.tier, site.reason, site.kind, site.host], ['ask', 'new_site', 'navigate', 'example.com']);
  assert.equal(evaluateNavigate(verdictFor('http://localhost:3000/'), {}).tier, 'ask');
});

test('navigate carries a Refuse-tier verdict through whatever the user said', () => {
  const lan = evaluateNavigate(verdictFor('http://192.168.1.1/'), { userText: 'open 192.168.1.1' });
  assert.deepEqual([lan.tier, lan.reason], ['refuse', 'private_address']);
  const engine = evaluateNavigate(verdictFor(`http://localhost:${OLLAMA}/`), { userText: `localhost:${OLLAMA}` });
  assert.deepEqual([engine.tier, engine.reason], ['refuse', 'reserved_port']);
  assert.equal(evaluateNavigate(null, {}).tier, 'refuse');
});

test('a click on a file input is refused', () => {
  assert.equal(evaluateClick(facts({ isFileInput: true, name: 'Upload' })).reason, 'file_input');
});

test('a link to a refused address is refused even when its label looks risky', () => {
  const choice = evaluateClick(facts({ tag: 'a', isAnchor: true, name: 'Delete' }), {
    linkVerdict: verdictFor('http://192.168.1.1/'),
  });
  assert.deepEqual([choice.tier, choice.reason], ['refuse', 'private_address']);
});

for (const name of [
  'Buy now', 'Purchase', 'Checkout', 'Check out', 'Pay', 'Pay now', 'Place order', 'Place your order', 'Order now',
  'Subscribe', 'Unsubscribe', 'Cancel subscription', 'Cancel my order', 'Delete', 'Delete account', 'Remove', 'Erase',
  'Destroy', 'Send', 'Send message', 'Post', 'Publish', 'Share', 'Submit', 'Transfer', 'Withdraw', 'Sign in', 'Sign-in',
  'Signin', 'Log in', 'Login', 'Sign up', 'Signup', 'Register', 'Authorize', 'Authorise', 'DELETE',
]) {
  test(`a button labelled "${name}" asks`, () => {
    const choice = evaluateClick(facts({ name }), { currentKey: 'start.example' });
    assert.deepEqual([choice.tier, choice.reason, choice.kind], ['ask', 'risky_words', 'click']);
    assert.equal(choice.host, 'start.example');
    assert.equal(choice.label, name);
  });
}

for (const name of ['Cancel', 'Search', 'Add to cart', 'Next', 'Posts', 'Repost', 'Sender', 'Payment methods', 'Accept cookies', '']) {
  test(`a button labelled "${name}" passes`, () => {
    assert.equal(evaluateClick(facts({ name })).tier, 'pass');
  });
}

test('a long link title is content, a short link label is an action', () => {
  const link = name => evaluateClick(facts({ tag: 'a', isAnchor: true, name }));
  assert.equal(link('Delete my account').tier, 'ask');
  assert.equal(link('How to send email from a Python script').tier, 'pass');
  assert.equal(evaluateClick(facts({ name: 'Yes, delete my account and all of my data' })).tier, 'ask');
});

test('a submit control asks only when the form sends data', () => {
  const submit = (extra) => evaluateClick(facts({ name: 'Go', ...extra }));
  assert.equal(submit({ inputType: 'submit', form: postForm }).reason, 'form_post');
  assert.equal(submit({ inputType: '', form: postForm }).reason, 'form_post');
  assert.equal(submit({ tag: 'input', inputType: 'image', form: postForm }).reason, 'form_post');
  assert.equal(submit({ inputType: 'submit', form: signInForm }).reason, 'form_post');
  assert.equal(submit({ inputType: 'submit', form: getForm }).tier, 'pass');
  assert.equal(submit({ inputType: 'button', form: postForm }).tier, 'pass');
  assert.equal(submit({ tag: 'input', inputType: 'checkbox', form: postForm }).tier, 'pass');
});

test('type refuses secret and file fields and lets plain typing through', () => {
  assert.equal(evaluateType(facts({ isSecret: true }), { submit: false }).reason, 'secret_field');
  assert.equal(evaluateType(facts({ isFileInput: true }), { submit: false }).reason, 'file_input');
  assert.equal(evaluateType(facts({ isEditable: true, form: postForm }), { submit: false }).tier, 'pass');
});

test('type with submit is held to the same standard as clicking submit', () => {
  const field = extra => facts({ isEditable: true, tag: 'input', inputType: 'text', name: 'Query', ...extra });
  assert.equal(evaluateType(field({ form: getForm }), { submit: true }).tier, 'pass');
  const post = evaluateType(field({ form: postForm }), { submit: true, currentKey: 'start.example' });
  assert.deepEqual([post.tier, post.reason, post.kind, post.host, post.label], ['ask', 'form_post', 'submit', 'start.example', '']);
  assert.equal(evaluateType(field({ form: signInForm }), { submit: true }).reason, 'form_post');
  assert.equal(evaluateType(field({ name: 'Send a message' }), { submit: true }).reason, 'risky_words');
});

test('press judges Enter and Space by what is focused', () => {
  assert.equal(evaluatePress('Enter', null).tier, 'pass');
  assert.equal(evaluatePress('Enter', facts({ isEditable: true, form: postForm })).reason, 'form_post');
  assert.equal(evaluatePress('Enter', facts({ isEditable: true, form: getForm })).tier, 'pass');
  assert.equal(evaluatePress('Enter', facts({ name: 'Delete' })).reason, 'risky_words');
  assert.equal(evaluatePress('Space', facts({ name: 'Delete' })).reason, 'risky_words');
  assert.equal(evaluatePress('Space', facts({ isEditable: true, form: postForm })).tier, 'pass');
  assert.equal(evaluatePress('ArrowDown', facts({ name: 'Delete' })).tier, 'pass');
  assert.equal(evaluatePress('Enter', facts({ isFileInput: true })).reason, 'file_input');
});

test('press on a secret field allows only moving away', () => {
  for (const key of ['Enter', 'Space', 'ArrowLeft']) {
    assert.equal(evaluatePress(key, facts({ isSecret: true, isEditable: true })).reason, 'secret_field', key);
  }
  for (const key of ['Tab', 'Escape']) {
    assert.equal(evaluatePress(key, facts({ isSecret: true, isEditable: true })).tier, 'pass', key);
  }
});

test('press on a focused link to a refused address is refused', () => {
  const choice = evaluatePress('Enter', facts({ tag: 'a', isAnchor: true }), { linkVerdict: verdictFor('file:///C:/x') });
  assert.equal(choice.tier, 'refuse');
});

test('select refuses secret and file fields and passes the rest', () => {
  assert.equal(evaluateSelect(facts({ isSecret: true })).reason, 'secret_field');
  assert.equal(evaluateSelect(facts({ isFileInput: true })).reason, 'file_input');
  assert.equal(evaluateSelect(facts({ tag: 'select', form: postForm })).tier, 'pass');
});

test('labels shown on the card are single-line, bounded and free of invisible characters', () => {
  assert.equal(cleanLabel('  Pay\n\t now\u200b\u202e  '), 'Pay now');
  assert.equal(cleanLabel('x'.repeat(500)).length, 200);
  assert.equal(cleanLabel(undefined), '');
});

test('a refusal message never leaks the internal reason and always explains itself', () => {
  for (const reason of [
    'invalid_url', 'unsupported_scheme', 'credentialed_url', 'missing_host', 'private_address', 'internal_name', 'reserved_port',
    'resolver_unavailable', 'unresolved_host', 'resolves_to_private_address', 'file_input', 'secret_field',
  ]) {
    const message = refusalMessage(reason);
    assert.ok(message.length > 10, reason);
    assert.equal(message.includes(reason), false, reason);
    assert.notEqual(message, refusalMessage('not_a_reason'), reason);
  }
});

test('the ask carries the card fields, one-off only, and goes to the approval path', async () => {
  const controller = new AbortController();
  const { gate, state } = harness({ signal: controller.signal });
  await gate.beforeNavigate('https://example.com/a?b=1');
  assert.equal(state.asks.length, 1);
  const { params, askSignal } = state.asks[0];
  assert.equal(askSignal, controller.signal);
  assert.equal(params.tool_name, 'browser');
  assert.equal(params.tool_call_id, 'call-1');
  assert.deepEqual(params.tool_input, { action: 'navigate' });
  assert.equal(params.one_off_only, true);
  assert.deepEqual(params.messageFields.browser_approval, {
    schema_version: 1, kind: 'navigate', reason: 'new_site', host: 'example.com', label: 'example.com',
    url: 'https://example.com/a?b=1',
  });
});

test('a long URL is clipped on the card', async () => {
  const { gate, state } = harness();
  await gate.beforeNavigate(`https://example.com/${'x'.repeat(2000)}`);
  assert.equal(state.asks[0].params.messageFields.browser_approval.url.length, 512);
});

for (const answer of [true, { approved: true, decision: 'approved' }]) {
  test(`an answer of ${JSON.stringify(answer)} lets the action proceed`, async () => {
    const { gate } = harness({ answer, waitMs: 750 });
    assert.deepEqual(await gate.beforeNavigate('https://example.com/'), { proceed: true, humanWaitMs: 750 });
  });
}

for (const answer of [false, null, undefined, 1, 'yes', { approved: 'true' }, { approved: false }, {}]) {
  test(`an answer of ${JSON.stringify(answer)} is a decline`, async () => {
    const { gate } = harness({ answer: () => answer, waitMs: 40 });
    const result = await gate.beforeNavigate('https://example.com/');
    assert.equal(result.proceed, false);
    assert.equal(result.status, 'declined');
    assert.equal(result.humanWaitMs, 40);
    assert.match(result.message, /example\.com/);
  });
}

test('a throwing approval path is a decline, not a crash', async () => {
  const { gate } = harness({ answer: new Error('settlement failed') });
  assert.equal((await gate.beforeNavigate('https://example.com/')).status, 'declined');
});

test('without an approver the action is denied at once and never hangs', async () => {
  const consent = createConsentGate({ urlGuard: guard, getCurrentUrl: () => 'https://start.example/' });
  const result = await consent.forCall({ callId: 'c' }).beforeNavigate('https://example.com/');
  assert.deepEqual([result.proceed, result.status], [false, 'needs_user']);
});

test('a Stop during the wait cancels even if an approval lands', async () => {
  const controller = new AbortController();
  const { gate } = harness({
    signal: controller.signal,
    answer: () => { controller.abort(); return true; },
  });
  assert.equal((await gate.beforeNavigate('https://example.com/')).status, 'cancelled');
});

test('a Refuse verdict never reaches the approval path', async () => {
  const { gate, state } = harness({ userText: 'open 192.168.1.1' });
  const result = await gate.beforeNavigate('http://192.168.1.1/');
  assert.deepEqual([result.proceed, result.status], [false, 'refused']);
  assert.equal(state.asks.length, 0);
  await gate.beforeClick(facts({ isFileInput: true }));
  await gate.beforeType(facts({ isSecret: true }), { submit: false });
  await gate.beforeSelect(facts({ isSecret: true }));
  await gate.beforePress('Enter', facts({ isSecret: true }));
  assert.equal(state.asks.length, 0);
});

test('approving a site lasts the chat and covers exactly that site', async () => {
  const { gate, state } = harness();
  await gate.beforeNavigate('https://example.com/');
  await gate.beforeNavigate('https://example.com/other');
  await gate.beforeNavigate('https://www.example.com/');
  assert.equal(state.asks.length, 1);
  await gate.beforeNavigate('https://docs.example.com/');
  assert.equal(state.asks.length, 2);
});

test('a site grant survives into later calls of the same chat only', async () => {
  const { consent, gate, state } = harness();
  await gate.beforeNavigate('https://example.com/');
  await consent.forCall({ authorize: async () => assert.fail('asked again'), callId: 'c2' }).beforeNavigate('https://example.com/');
  assert.equal(state.asks.length, 1);
  const other = harness();
  await other.gate.beforeNavigate('https://example.com/');
  assert.equal(other.state.asks.length, 1);
});

test('a declined site is asked about again rather than remembered', async () => {
  const { gate, state } = harness({ answer: false });
  await gate.beforeNavigate('https://example.com/');
  await gate.beforeNavigate('https://example.com/');
  assert.equal(state.asks.length, 2);
});

test('a risky action is approved once and asks again next time', async () => {
  const { gate, state } = harness();
  assert.equal((await gate.beforeClick(facts({ name: 'Delete' }))).proceed, true);
  assert.equal((await gate.beforeClick(facts({ name: 'Delete' }))).proceed, true);
  assert.equal(state.asks.length, 2);
});

test('the card for a risky link names its destination and for a form its action', async () => {
  const { gate, state } = harness();
  await gate.beforeClick(facts({ tag: 'a', isAnchor: true, name: 'Delete', href: 'https://start.example/del/3' }));
  await gate.beforeClick(facts({ name: 'Go', inputType: 'submit', form: postForm }));
  const cards = state.asks.map(ask => ask.params.messageFields.browser_approval);
  assert.equal(cards[0].url, 'https://start.example/del/3');
  assert.equal(cards[1].url, postForm.action);
});

test('grants are bounded and evict the oldest', async () => {
  const { gate, state } = harness();
  for (let index = 0; index < 257; index += 1) await gate.beforeNavigate(`https://h${index}.example/`);
  state.asks.length = 0;
  await gate.beforeNavigate('https://h256.example/');
  assert.equal(state.asks.length, 0, 'the newest grant is kept');
  await gate.beforeNavigate('https://h0.example/');
  assert.equal(state.asks.length, 1, 'the oldest grant was evicted');
});

test('a page may move around its own site', () => {
  const { consent } = harness();
  assert.equal(consent.reviewPageNavigation('https://start.example/next').allow, true);
  assert.equal(consent.reviewPageNavigation('https://www.start.example/').allow, true);
  assert.equal(consent.takeBlockedNavigation(), null);
});

test('a page sending itself to a new site is blocked and reported once', () => {
  const { consent } = harness();
  assert.deepEqual(consent.reviewPageNavigation('https://evil.example/x'), { allow: false, host: 'evil.example', reason: 'new_site' });
  assert.deepEqual(consent.takeBlockedNavigation(), { host: 'evil.example', reason: 'new_site' });
  assert.equal(consent.takeBlockedNavigation(), null);
});

test('only the newest blocked navigation is kept', () => {
  const { consent } = harness();
  consent.reviewPageNavigation('https://one.example/');
  consent.reviewPageNavigation('https://two.example/');
  assert.equal(consent.takeBlockedNavigation().host, 'two.example');
});

test('a page may reach a site that was granted or named, but never a refused target', async () => {
  const { consent, gate } = harness({ userText: 'look at named.example' });
  await gate.beforeNavigate('https://granted.example/');
  assert.equal(consent.reviewPageNavigation('https://granted.example/').allow, true);
  assert.equal(consent.reviewPageNavigation('https://named.example/').allow, true);
  const refused = consent.reviewPageNavigation('http://169.254.169.254/latest');
  assert.deepEqual([refused.allow, refused.reason], [false, 'private_address']);
  assert.equal(consent.reviewPageNavigation('file:///C:/x').allow, false);
  assert.equal(consent.reviewPageNavigation(`http://localhost:${OLLAMA}/`).reason, 'reserved_port');
});

test('a click on a link opens that site without asking, redirects within it included', async () => {
  const { consent, gate, state } = harness();
  const link = facts({ tag: 'a', isAnchor: true, name: 'Docs', href: 'https://docs.example/start' });
  assert.equal((await gate.beforeClick(link)).proceed, true);
  assert.equal(state.asks.length, 0);
  assert.equal(consent.reviewPageNavigation('https://docs.example/start').allow, true);
  assert.equal(consent.reviewPageNavigation('https://www.docs.example/landing').allow, true);
});

test('a click on a link does not open any other site', async () => {
  const { consent, gate } = harness();
  await gate.beforeClick(facts({ tag: 'a', isAnchor: true, name: 'Docs', href: 'https://docs.example/' }));
  assert.equal(consent.reviewPageNavigation('https://elsewhere.example/').allow, false);
});

test('the link allowance runs out and the next click replaces it', async () => {
  const { consent, gate, state } = harness();
  await gate.beforeClick(facts({ tag: 'a', isAnchor: true, name: 'Docs', href: 'https://docs.example/' }));
  state.time += 10_001;
  assert.equal(consent.reviewPageNavigation('https://docs.example/').allow, false);
  await gate.beforeClick(facts({ tag: 'a', isAnchor: true, name: 'A', href: 'https://a.example/' }));
  await gate.beforeClick(facts({ tag: 'a', isAnchor: true, name: 'B', href: 'https://b.example/' }));
  assert.equal(consent.reviewPageNavigation('https://a.example/').allow, false);
  assert.equal(consent.reviewPageNavigation('https://b.example/').allow, true);
});

test('a declined risky link grants no navigation', async () => {
  const { consent, gate } = harness({ answer: false });
  await gate.beforeClick(facts({ tag: 'a', isAnchor: true, name: 'Delete', href: 'https://docs.example/' }));
  assert.equal(consent.reviewPageNavigation('https://docs.example/').allow, false);
});

test('Enter on a focused link earns the same allowance as a click', async () => {
  const { consent, gate } = harness();
  await gate.beforePress('Enter', facts({ tag: 'a', isAnchor: true, name: 'Docs', href: 'https://docs.example/' }));
  assert.equal(consent.reviewPageNavigation('https://docs.example/').allow, true);
});

test('Tab on a focused link earns nothing', async () => {
  const { consent, gate } = harness();
  await gate.beforePress('Tab', facts({ tag: 'a', isAnchor: true, name: 'Docs', href: 'https://docs.example/' }));
  assert.equal(consent.reviewPageNavigation('https://docs.example/').allow, false);
});

test('a link to a host whose DNS answers privately is refused at click time', async () => {
  const rebinding = createUrlGuard({ resolveHost: async () => ({ endpoints: [{ address: '10.0.0.1' }] }) });
  const consent = createConsentGate({ urlGuard: rebinding, getCurrentUrl: () => 'https://start.example/' });
  const result = await consent.forCall({ callId: 'c' }).beforeClick(
    facts({ tag: 'a', isAnchor: true, name: 'Docs', href: 'https://docs.example/' }),
  );
  assert.deepEqual([result.proceed, result.status], [false, 'refused']);
});

test('a withheld page is reported once', () => {
  const { consent, gate } = harness();
  consent.noteWithheld('landed_on_private_address');
  assert.deepEqual(gate.takeWithheld(), { reason: 'landed_on_private_address' });
  assert.equal(gate.takeWithheld(), null);
});

test('a blocked download is reported once, as a download', () => {
  const { consent, gate } = harness();
  consent.noteBlockedDownload('files.example');
  assert.deepEqual(gate.takeBlockedNavigation(), { host: 'files.example', reason: 'download' });
  assert.equal(gate.takeBlockedNavigation(), null);
});

test('the call gate drains the same blocked navigation as the chat', () => {
  const { consent, gate } = harness();
  consent.reviewPageNavigation('https://evil.example/');
  assert.equal(gate.takeBlockedNavigation().host, 'evil.example');
  assert.equal(consent.takeBlockedNavigation(), null);
});

test('from a blank page nothing counts as the current site', async () => {
  const { gate, state } = harness({ url: 'about:blank' });
  await gate.beforeNavigate('https://example.com/');
  assert.equal(state.asks.length, 1);
});

test('from a blank page a refused target cannot pass as the current site', () => {
  const { consent } = harness({ url: 'about:blank' });
  const verdict = consent.reviewPageNavigation('file:///C:/secret');
  assert.deepEqual([verdict.allow, verdict.reason], [false, 'unsupported_scheme']);
});

test('only a real link earns a navigation allowance', async () => {
  const { consent, gate } = harness();
  await gate.beforeClick(facts({ tag: 'div', isAnchor: false, name: 'Docs', href: 'https://docs.example/' }));
  assert.equal(consent.reviewPageNavigation('https://docs.example/').allow, false);
});

const crossSiteForm = { present: true, method: 'post', action: 'https://other.example/save', hasSecretField: false };

test('a form card names where the form goes, and approving lets that page load', async () => {
  const h = harness();
  const answer = await h.gate.beforeClick(facts({ inputType: 'submit', name: 'Go', form: crossSiteForm }));
  assert.equal(answer.proceed, true);
  const card = h.state.asks[0].params.messageFields.browser_approval;
  assert.deepEqual([card.kind, card.reason, card.host, card.url], ['click', 'form_post', 'other.example', crossSiteForm.action]);
  assert.equal(h.consent.reviewPageNavigation(crossSiteForm.action).allow, true);
});

test('a typed Enter names the destination too, and a refusal leaves no allowance', async () => {
  const field = facts({ tag: 'input', isEditable: true, name: 'Email', form: crossSiteForm });
  const approved = harness();
  await approved.gate.beforeType(field, { submit: true });
  const card = approved.state.asks[0].params.messageFields.browser_approval;
  assert.deepEqual([card.kind, card.host], ['submit', 'other.example']);
  assert.equal(approved.consent.reviewPageNavigation(crossSiteForm.action).allow, true);
  const declined = harness({ answer: false });
  await declined.gate.beforeType(field, { submit: true });
  assert.equal(declined.consent.reviewPageNavigation(crossSiteForm.action).allow, false);
});

test('a form that posts to its own site or an unusable address names the page it is on', async () => {
  const same = harness();
  await same.gate.beforeClick(facts({ inputType: 'submit', name: 'Go', form: postForm }));
  assert.equal(same.state.asks[0].params.messageFields.browser_approval.host, 'start.example');
  const refused = harness();
  await refused.gate.beforeClick(facts({ inputType: 'submit', name: 'Go', form: { ...postForm, action: 'http://192.168.1.5/save' } }));
  assert.equal(refused.state.asks[0].params.messageFields.browser_approval.host, 'start.example');
  assert.equal(refused.consent.reviewPageNavigation('http://192.168.1.5/save').allow, false);
});

test('a form that needs no ask earns no allowance', async () => {
  const h = harness();
  const form = { present: true, method: 'get', action: 'https://other.example/find', hasSecretField: false };
  await h.gate.beforeClick(facts({ inputType: 'submit', name: 'Go', form }));
  assert.equal(h.state.asks.length, 0);
  assert.equal(h.consent.reviewPageNavigation(form.action).allow, false);
});
