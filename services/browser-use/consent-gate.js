'use strict';

/**
 * The Ask tier for model-driven browsing (roadmap row 114).
 *
 * url-guard.js says what may never be reached. This module says what needs the
 * user's word first: a site they have not named or granted, and an action that
 * looks consequential. Full auto answers on their behalf inside the approval
 * path, so nothing here needs to know about it.
 *
 * The word list is a speed bump, not a boundary. It is English only and a page
 * can label a button anything. The boundaries are the Refuse tier and having
 * no saved sign-ins.
 *
 * One gate lives per chat and holds its grants in memory; forCall() binds it to
 * one tool call's approver and abort signal.
 */

const APPROVAL_SCHEMA_VERSION = 1;
const MAX_LABEL_CHARS = 200;
const MAX_CARD_URL_CHARS = 512;
const MAX_GRANTED_SITES = 256;
// Long enough for a slow site to start the navigation the click caused, and to
// redirect within itself before the new address commits.
const LINK_ALLOWANCE_TTL_MS = 10_000;
// A real action label is short. A long link name is usually an article title
// that merely contains a word from the list.
const MAX_WORDS_IN_RISKY_LINK = 4;
const DEFAULT_PORTS = new Set([80, 443]);
const KEYS_ALLOWED_ON_SECRET_FIELDS = new Set(['Tab', 'Escape']);

const RISKY_ACTION_PATTERN = new RegExp(`\\b(?:${[
  'buy', 'purchase', 'check[ -]?out', 'pay', 'place (?:\\w+ )?order', 'order now',
  'subscribe', 'unsubscribe', 'cancel (?:\\w+ )?(?:subscription|order|membership|account|plan|booking)',
  'delete', 'remove', 'erase', 'destroy',
  'send', 'post', 'publish', 'share', 'submit', 'transfer', 'withdraw',
  'sign[ -]?in', 'log[ -]?in', 'sign[ -]?up', 'register', 'authori[sz]e',
].join('|')})\\b`, 'i');

const PRIVATE_NETWORK_REFUSAL = 'Refused: that address is on a private network.';
const UNRESOLVED_REFUSAL = 'Refused: that host name could not be resolved.';
const REFUSALS = Object.freeze({
  invalid_url: 'Refused: that is not a valid URL.',
  unsupported_scheme: 'Refused: only http and https pages can be opened. Send a full address such as https://example.com.',
  credentialed_url: 'Refused: URLs with an embedded username or password are not allowed.',
  missing_host: 'Refused: that URL has no host.',
  private_address: PRIVATE_NETWORK_REFUSAL,
  resolves_to_private_address: PRIVATE_NETWORK_REFUSAL,
  internal_name: 'Refused: that name looks like a host on an internal network.',
  reserved_port: 'Refused: that local port belongs to Jenny or a model engine.',
  resolver_unavailable: UNRESOLVED_REFUSAL,
  unresolved_host: UNRESOLVED_REFUSAL,
  file_input: 'Refused: file upload fields cannot be used.',
  secret_field: 'Refused: password and payment fields are for the user. Ask them to take over the browser and fill it in.',
});
const DEFAULT_REFUSAL = 'Refused: that target is not allowed.';

function refusalMessage(reason) {
  return Object.hasOwn(REFUSALS, reason) ? REFUSALS[reason] : DEFAULT_REFUSAL;
}

function cleanLabel(text) {
  return String(text ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS);
}

function decision(tier, reason, fields = {}) {
  return { tier, reason, kind: '', host: '', label: '', ...fields };
}

function bareHost(host) {
  const withoutWww = host.startsWith('www.') ? host.slice(4) : host;
  return withoutWww.includes('.') ? withoutWww : host;
}

function hostForDisplay(host) {
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * The identity a grant attaches to, or '' for a refused target. Loopback keeps
 * its port because every port there is a different application.
 */
function siteKey(verdict) {
  if (!verdict?.allowed || !verdict.host) return '';
  return verdict.isLoopback ? `${hostForDisplay(verdict.host)}:${verdict.port}` : bareHost(verdict.host);
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hostMentionPattern({ host, port, isLoopback }) {
  const notInsideAName = '(?<![a-z0-9.@-])';
  const hostEnds = '(?![a-z0-9-]|\\.[a-z0-9])';
  if (!isLoopback) return `${notInsideAName}(?:www\\.)?${escapeForRegExp(bareHost(host))}${hostEnds}`;
  const shown = escapeForRegExp(hostForDisplay(host));
  const withPort = `${shown}:${port}(?![0-9])`;
  if (!DEFAULT_PORTS.has(port)) return `${notInsideAName}${withPort}`;
  return `${notInsideAName}(?:${withPort}|${shown}${hostEnds}(?!:[0-9]))`;
}

/** Whether the user's own message spells out exactly this host. */
function namedByUser(verdict, userText) {
  const text = String(userText || '');
  if (!text || !verdict?.allowed || !verdict.host) return false;
  return new RegExp(hostMentionPattern(verdict), 'i').test(text);
}

function looksRisky(label, isAnchor) {
  if (!RISKY_ACTION_PATTERN.test(label)) return false;
  return !isAnchor || label.split(' ').length <= MAX_WORDS_IN_RISKY_LINK;
}

function isSubmitControl(facts) {
  const tag = String(facts?.tag || '').toLowerCase();
  const type = String(facts?.inputType || '').toLowerCase();
  if (tag === 'button') return type === '' || type === 'submit';
  return tag === 'input' && (type === 'submit' || type === 'image');
}

function sendsFormData(facts) {
  const form = facts?.form;
  return Boolean(form?.present) && (form.method === 'post' || form.hasSecretField === true);
}

function evaluateNavigate(verdict, { currentKey = '', grants = new Set(), userText = '' } = {}) {
  if (!verdict?.allowed) return decision('refuse', verdict?.reason || 'invalid_url');
  const key = siteKey(verdict);
  if (key === currentKey) return decision('pass', 'same_site');
  if (grants.has(key)) return decision('pass', 'granted');
  if (namedByUser(verdict, userText)) return decision('pass', 'named_by_user');
  return decision('ask', 'new_site', { kind: 'navigate', host: key, label: key });
}

function evaluateClick(facts, { currentKey = '', linkVerdict = null, formKey = '' } = {}) {
  if (facts?.isFileInput) return decision('refuse', 'file_input');
  if (linkVerdict && !linkVerdict.allowed) return decision('refuse', linkVerdict.reason);
  const label = cleanLabel(facts?.name);
  const card = { kind: 'click', host: currentKey, label };
  if (looksRisky(label, facts?.isAnchor === true)) return decision('ask', 'risky_words', card);
  // The card names where the form goes, which can be another site than the page it is on.
  if (isSubmitControl(facts) && sendsFormData(facts)) return decision('ask', 'form_post', { ...card, host: formKey || currentKey });
  return decision('pass', linkVerdict ? 'link' : 'plain_click');
}

function evaluateType(facts, { submit = false, currentKey = '', formKey = '' } = {}) {
  if (facts?.isFileInput) return decision('refuse', 'file_input');
  if (facts?.isSecret) return decision('refuse', 'secret_field');
  if (!submit) return decision('pass', 'typing');
  const label = cleanLabel(facts?.name);
  const card = { kind: 'submit', host: formKey || currentKey, label };
  if (looksRisky(label, false)) return decision('ask', 'risky_words', card);
  // The label here is one field's name, which says nothing about the form as a whole.
  if (sendsFormData(facts)) return decision('ask', 'form_post', { ...card, label: '' });
  return decision('pass', 'plain_submit');
}

function evaluateSelect(facts) {
  if (facts?.isFileInput) return decision('refuse', 'file_input');
  if (facts?.isSecret) return decision('refuse', 'secret_field');
  return decision('pass', 'selection');
}

function evaluatePress(key, facts, options = {}) {
  if (!facts) return decision('pass', 'nothing_focused');
  if (facts.isSecret && !KEYS_ALLOWED_ON_SECRET_FIELDS.has(key)) return decision('refuse', 'secret_field');
  if (key !== 'Enter' && key !== 'Space') return decision('pass', 'plain_key');
  if (!facts.isEditable) return evaluateClick(facts, options);
  return key === 'Enter' ? evaluateType(facts, { ...options, submit: true }) : decision('pass', 'plain_key');
}

function cardUrl(facts, fallback = '') {
  return String(facts?.href || facts?.form?.action || fallback).slice(0, MAX_CARD_URL_CHARS);
}

function declineMessage(choice) {
  if (choice.kind === 'navigate') return `The user did not allow opening ${choice.host}. Do not try again unless they ask.`;
  return `The user did not allow "${choice.label || 'that action'}". Do not try again unless they ask.`;
}

async function askForConsent(choice, { authorize, callId, toolInput, signal }, now) {
  if (typeof authorize !== 'function') return { allowed: false, unanswerable: true, waitedMs: 0 };
  const startedAt = now();
  let answer;
  try {
    answer = await authorize({
      tool_name: 'browser', tool_call_id: callId, tool_input: toolInput,
      // A grant here lasts the chat at most, so the card must never offer a saved rule.
      one_off_only: true,
      messageFields: { browser_approval: {
        schema_version: APPROVAL_SCHEMA_VERSION,
        kind: choice.kind, reason: choice.reason, host: choice.host, label: choice.label, url: choice.url,
      } },
    }, signal);
  } catch (_error) {
    answer = null;
  }
  return { allowed: answer === true || answer?.approved === true, waitedMs: Math.max(0, now() - startedAt) };
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./url-guard').createUrlGuard>} deps.urlGuard
 * @param {() => string} deps.getCurrentUrl The committed URL of this chat's page.
 * @param {() => number} [deps.now]
 */
function createConsentGate({ urlGuard, getCurrentUrl, now = Date.now }) {
  const grants = new Set();
  let linkAllowance = null;
  let blockedNavigation = null;
  let withheld = null;
  let latestUserText = '';

  const currentKey = () => siteKey(urlGuard.classify(String(getCurrentUrl() || '')));

  function grantSite(key) {
    grants.delete(key);
    grants.add(key);
    while (grants.size > MAX_GRANTED_SITES) grants.delete(grants.values().next().value);
  }

  // Every site Jenny may use in this chat except the one showing, which stays allowed however it got there.
  function otherGrantedSites() {
    const here = currentKey();
    return [...grants].filter((key) => key !== here);
  }

  function removeGrant(key) {
    return grants.delete(String(key ?? ''));
  }

  const hasBlockedNavigation = () => blockedNavigation !== null;

  function takeBlockedNavigation() {
    const blocked = blockedNavigation;
    blockedNavigation = null;
    return blocked;
  }

  function takeWithheld() {
    const found = withheld;
    withheld = null;
    return found;
  }

  function noteWithheld(reason) {
    withheld = { reason };
  }

  function noteBlockedDownload(host) {
    blockedNavigation = { host: String(host || ''), reason: 'download' };
  }

  function holdsLinkAllowance(key) {
    return Boolean(linkAllowance) && linkAllowance.key === key && linkAllowance.expires > now();
  }

  function isExpectedDestination(verdict) {
    const key = siteKey(verdict);
    return key === currentKey() || grants.has(key) || holdsLinkAllowance(key) || namedByUser(verdict, latestUserText);
  }

  /**
   * For navigations the page starts itself. Synchronous, because `will-navigate`
   * must be prevented before it returns. An allowance survives the first hit so
   * a redirect within the clicked site, before its address commits, still lands.
   */
  function reviewPageNavigation(url) {
    const verdict = urlGuard.classify(url, { kind: 'navigation' });
    if (verdict.allowed && isExpectedDestination(verdict)) return { allow: true, host: verdict.host, reason: '' };
    blockedNavigation = { host: verdict.host || '', reason: verdict.allowed ? 'new_site' : verdict.reason };
    return { allow: false, ...blockedNavigation };
  }

  function forCall({ authorize, callId, toolInput, signal, userText = '' } = {}) {
    latestUserText = String(userText || '');
    const call = { authorize, callId, toolInput, signal };

    async function settle(choice, url) {
      if (choice.tier === 'pass') return { proceed: true };
      if (choice.tier === 'refuse') return { proceed: false, status: 'refused', message: refusalMessage(choice.reason) };
      const { allowed, unanswerable, waitedMs } = await askForConsent({ ...choice, url }, call, now);
      if (unanswerable) {
        return { proceed: false, status: 'needs_user', message: 'This needs the user\'s approval and no one can answer here, so it was not done.' };
      }
      if (signal?.aborted) return { proceed: false, status: 'cancelled', message: 'The user stopped this.', humanWaitMs: waitedMs };
      if (!allowed) return { proceed: false, status: 'declined', message: declineMessage(choice), humanWaitMs: waitedMs };
      return { proceed: true, humanWaitMs: waitedMs };
    }

    async function linkVerdictFor(facts) {
      return facts?.isAnchor && facts.href ? urlGuard.check(facts.href, { kind: 'navigation' }) : null;
    }

    function noteLinkAllowance(linkVerdict, answer) {
      if (answer.proceed && linkVerdict?.allowed) {
        linkAllowance = { key: siteKey(linkVerdict), expires: now() + LINK_ALLOWANCE_TTL_MS };
      }
    }

    function formVerdictFor(facts) {
      return facts?.form?.present && facts.form.action ? urlGuard.check(facts.form.action, { kind: 'navigation' }) : null;
    }

    // The user approved sending this form, so the page it posts to may load.
    function noteFormAllowance(choice, formVerdict, answer) {
      if (choice.tier === 'ask') noteLinkAllowance(formVerdict, answer);
    }

    return {
      async beforeNavigate(url) {
        const verdict = await urlGuard.check(url, { kind: 'navigation' });
        const choice = evaluateNavigate(verdict, { currentKey: currentKey(), grants, userText: latestUserText });
        const answer = await settle(choice, String(url).slice(0, MAX_CARD_URL_CHARS));
        if (answer.proceed && choice.tier === 'ask') grantSite(choice.host);
        return answer;
      },
      async beforeClick(facts) {
        const linkVerdict = await linkVerdictFor(facts);
        const formVerdict = isSubmitControl(facts) ? await formVerdictFor(facts) : null;
        const choice = evaluateClick(facts, { currentKey: currentKey(), linkVerdict, formKey: siteKey(formVerdict) });
        const answer = await settle(choice, cardUrl(facts));
        noteLinkAllowance(linkVerdict, answer);
        noteFormAllowance(choice, formVerdict, answer);
        return answer;
      },
      async beforeType(facts, { submit = false } = {}) {
        const formVerdict = submit ? await formVerdictFor(facts) : null;
        const choice = evaluateType(facts, { submit, currentKey: currentKey(), formKey: siteKey(formVerdict) });
        const answer = await settle(choice, cardUrl(facts));
        noteFormAllowance(choice, formVerdict, answer);
        return answer;
      },
      async beforeSelect(facts) {
        return settle(evaluateSelect(facts), '');
      },
      async beforePress(key, facts) {
        const activates = key === 'Enter' || key === 'Space';
        const linkVerdict = activates ? await linkVerdictFor(facts) : null;
        const formVerdict = activates ? await formVerdictFor(facts) : null;
        const choice = evaluatePress(key, facts, { currentKey: currentKey(), linkVerdict, formKey: siteKey(formVerdict) });
        const answer = await settle(choice, cardUrl(facts));
        noteLinkAllowance(linkVerdict, answer);
        noteFormAllowance(choice, formVerdict, answer);
        return answer;
      },
      takeBlockedNavigation,
      hasBlockedNavigation,
      takeWithheld,
    };
  }

  return { forCall, noteBlockedDownload, noteWithheld, otherGrantedSites, removeGrant, reviewPageNavigation, takeBlockedNavigation, takeWithheld };
}

module.exports = {
  cleanLabel,
  createConsentGate,
  evaluateClick,
  evaluateNavigate,
  evaluatePress,
  evaluateSelect,
  evaluateType,
  namedByUser,
  refusalMessage,
  siteKey,
};
