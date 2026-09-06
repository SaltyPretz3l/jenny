'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { classifyIpAddress, validateScopeConsent } = require('./destination-policy');

const MAX_DNS_ANSWERS = 16;

function normalizeAnswers(answers) {
  const normalized = [];
  for (const answer of answers || []) {
    const address = typeof answer === 'string' ? answer : answer?.address;
    const family = typeof answer === 'object' && answer ? answer.family : net.isIP(address);
    if (!address || ![4, 6].includes(Number(family)) || net.isIP(address) !== Number(family)) {
      return { ok: false, reason: 'dns_answer_invalid' };
    }
    if (!normalized.some((item) => item.address === address)) {
      normalized.push({ address, family: Number(family) });
    }
  }
  if (!normalized.length) return { ok: false, reason: 'dns_no_answers' };
  if (normalized.length > MAX_DNS_ANSWERS) return { ok: false, reason: 'dns_answer_limit_exceeded' };
  normalized.sort((a, b) => a.family - b.family || a.address.localeCompare(b.address));
  return { ok: true, answers: normalized };
}

async function resolveAndPin(hostname, {
  consent,
  expectedScope = null,
  resolve = (host) => dns.lookup(host, { all: true, verbatim: true }),
} = {}) {
  let rawAnswers;
  try {
    rawAnswers = await resolve(hostname);
  } catch (_error) {
    return { ok: false, reason: 'dns_resolution_failed', retryable: true };
  }
  const normalized = normalizeAnswers(rawAnswers);
  if (!normalized.ok) return normalized;
  const classified = [];
  for (const answer of normalized.answers) {
    const classification = classifyIpAddress(answer.address);
    if (!classification.ok) return classification;
    const allowed = validateScopeConsent(consent, classification.scope);
    if (!allowed.ok) return allowed;
    classified.push({ ...answer, scope: classification.scope });
  }
  const scopes = new Set(classified.map((item) => item.scope));
  if (scopes.size !== 1) return { ok: false, reason: 'dns_mixed_scope_blocked' };
  const scope = classified[0].scope;
  if (expectedScope && scope !== expectedScope) {
    return { ok: false, reason: 'dns_scope_changed', previous_scope: expectedScope, scope };
  }
  return { ok: true, hostname, scope, selected: classified[0], answers: classified };
}

async function pinDestination(destination, options = {}) {
  if (destination.literal_address) {
    const classification = classifyIpAddress(destination.literal_address);
    if (!classification.ok) return classification;
    const allowed = validateScopeConsent(options.consent, classification.scope);
    if (!allowed.ok) return allowed;
    if (options.expectedScope && options.expectedScope !== classification.scope) {
      return { ok: false, reason: 'dns_scope_changed' };
    }
    const family = net.isIP(destination.literal_address);
    const selected = { address: destination.literal_address, family, scope: classification.scope };
    return { ok: true, hostname: destination.hostname, scope: classification.scope, selected, answers: [selected] };
  }
  return resolveAndPin(destination.hostname, options);
}

module.exports = {
  MAX_DNS_ANSWERS,
  normalizeAnswers,
  resolveAndPin,
  pinDestination,
};
