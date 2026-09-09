'use strict';

const crypto = require('node:crypto');

const PROPER_NOUNS = new Set([
  'Jenny', 'Ollama', 'vLLM', 'MCP', 'GGUF', 'Monaco', 'Mermaid', 'KaTeX',
  'GitHub', 'Codex', 'ChatGPT', 'llama-server', 'Python', 'PowerShell',
]);
const DOMAIN_ORDER = [
  'index.html',
  'renderer/shell',
  'renderer/chat',
  'renderer/features/setup-scenes',
  'renderer/features',
  'renderer/shared',
  'renderer/inventory',
  'renderer/app',
  'services',
];

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function presentationText(value) {
  const normalized = normalizeText(value);
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function domainFor(file) {
  if (!file.startsWith('renderer/') && !file.startsWith('services/') && file !== 'main.js') {
    return 'index.html';
  }
  if (file === 'main.js' || file.startsWith('services/')) return 'services';
  if (file.startsWith('renderer/features/setup-scenes/')) return 'renderer/features/setup-scenes';
  for (const name of ['shell', 'chat', 'features', 'shared', 'inventory']) {
    if (file.startsWith(`renderer/${name}/`)) return `renderer/${name}`;
  }
  return 'renderer/app';
}

function isSecurityPolicy(text) {
  return /^\s*(?:default-src|script-src|style-src)\s|;\s*(?:base-uri|form-action)\s/.test(text);
}

function finalDisposition(raw, text) {
  if (raw.disposition?.startsWith('excluded:')) return raw.disposition;
  if (raw.disposition === 'migrated') return 'migrated';
  if (/^CMP-[A-Z]+-\d{4}$/.test(text)) return 'excluded:code';
  if (isSecurityPolicy(text)) return 'excluded:code';
  if (PROPER_NOUNS.has(text)) return 'excluded:proper_noun';
  if (!/[A-Za-z]{2}/.test(text)) return 'excluded:no_letters';
  return raw.disposition || 'pending';
}

function compareSourceOrder(left, right) {
  return compareOrdinal(left.file, right.file)
    || (left.start ?? 0) - (right.start ?? 0)
    || (left.sequence ?? 0) - (right.sequence ?? 0)
    || compareOrdinal(left.kind, right.kind);
}

function applyRemainders(occurrences, remainders, errors) {
  const matchCounts = remainders.map(() => 0);
  for (const item of occurrences) {
    const matches = [];
    remainders.forEach((entry, index) => {
      if (item.disposition === 'pending' && entry.file === item.file && entry.text === item.text) {
        matches.push(index);
      }
    });
    if (!matches.length) continue;
    if (matches.length > 1) {
      errors.push(`multiple named remainders match ${item.file}: ${JSON.stringify(item.text)}`);
      continue;
    }
    const index = matches[0];
    matchCounts[index] += 1;
    item.disposition = `remainder:${remainders[index].name}`;
  }
  remainders.forEach((entry, index) => {
    if (!matchCounts[index]) {
      errors.push(
        `stale named remainder "${entry.name}": ${entry.file} ${JSON.stringify(entry.text)} matches nothing`
      );
    }
  });
  const summaries = new Map();
  remainders.forEach((entry, index) => {
    const current = summaries.get(entry.name);
    if (current && current.reason !== entry.reason) {
      errors.push(`named remainder "${entry.name}" must use one consistent reason`);
      return;
    }
    const summary = current || { name: entry.name, count: 0, reason: entry.reason };
    summary.count += matchCounts[index];
    summaries.set(entry.name, summary);
  });
  return [...summaries.values()].sort((left, right) => compareOrdinal(left.name, right.name));
}

function finalizeOccurrences(rawOccurrences, remainders = [], errors = []) {
  const ordinals = new Map();
  const result = [];
  for (const raw of [...rawOccurrences].sort(compareSourceOrder)) {
    const text = normalizeText(raw.text);
    if (!text) continue;
    const triple = `${raw.file}\0${raw.kind}\0${text}`;
    const ordinal = (ordinals.get(triple) || 0) + 1;
    ordinals.set(triple, ordinal);
    const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
    result.push({
      id: `${raw.file}|${raw.kind}|${hash}|${ordinal}`,
      file: raw.file,
      kind: raw.kind,
      via: raw.via || 'literal',
      text,
      disposition: finalDisposition(raw, text),
      _line: raw.line || 1,
    });
  }
  const sorted = result.sort((left, right) => compareOrdinal(left.id, right.id));
  const remainderSummaries = applyRemainders(sorted, remainders, errors);
  return { occurrences: sorted, remainderSummaries };
}

function blankBreakdown() {
  return { pending: 0, migrated: 0, excluded: 0 };
}

function dispositionBucket(disposition) {
  if (disposition === 'pending') return 'pending';
  if (disposition === 'migrated') return 'migrated';
  return 'excluded';
}

function buildTotals(occurrences) {
  const totals = { pending: 0, migrated: 0, excluded: 0, by_kind: {}, by_domain: {} };
  for (const domain of DOMAIN_ORDER) totals.by_domain[domain] = blankBreakdown();
  for (const item of occurrences) {
    const bucket = dispositionBucket(item.disposition);
    totals[bucket] += 1;
    totals.by_kind[item.kind] ||= blankBreakdown();
    totals.by_kind[item.kind][bucket] += 1;
    const domain = domainFor(item.file);
    totals.by_domain[domain] ||= blankBreakdown();
    totals.by_domain[domain][bucket] += 1;
  }
  totals.by_kind = Object.fromEntries(Object.entries(totals.by_kind).sort(([a], [b]) => compareOrdinal(a, b)));
  totals.by_domain = Object.fromEntries([
    ...DOMAIN_ORDER.filter((key) => totals.by_domain[key]).map((key) => [key, totals.by_domain[key]]),
    ...Object.entries(totals.by_domain)
      .filter(([key]) => !DOMAIN_ORDER.includes(key))
      .sort(([a], [b]) => compareOrdinal(a, b)),
  ]);
  return totals;
}

function publicOccurrence(item) {
  return {
    id: item.id,
    file: item.file,
    kind: item.kind,
    via: item.via,
    text: item.text,
    disposition: item.disposition,
  };
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function escapeTable(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function breakdownRows(entries) {
  return entries.map(([name, counts]) => {
    const total = counts.pending + counts.migrated + counts.excluded;
    return `| ${escapeTable(name)} | ${counts.pending} | ${counts.migrated} | ${counts.excluded} | ${total} |`;
  });
}

function renderLedgerMarkdown(ledger, remainderSummaries = []) {
  const lines = [
    '# Jenny i18n string ledger',
    '',
    'Generated by `node scripts/i18n/ledger.js scan`. Do not edit by hand.',
    '',
    '## By domain',
    '',
    '| Domain | Pending | Migrated | Excluded | Total |',
    '|---|---:|---:|---:|---:|',
    ...breakdownRows(Object.entries(ledger.totals.by_domain)),
    '',
    '## By kind',
    '',
    '| Kind | Pending | Migrated | Excluded | Total |',
    '|---|---:|---:|---:|---:|',
    ...breakdownRows(Object.entries(ledger.totals.by_kind)),
    '',
    '## Parse errors',
    '',
    ...(ledger.errors.length ? ledger.errors.map((error) => `- ${error}`) : ['- None.']),
    '',
    '## Named remainders',
    '',
    ...(remainderSummaries.length ? [
      '| Name | Count | Reason |',
      '|---|---:|---|',
      ...remainderSummaries.map((item) => (
        `| ${escapeTable(item.name)} | ${item.count} | ${escapeTable(item.reason)} |`
      )),
    ] : ['- None.']),
    '',
  ];
  return lines.join('\n');
}

function pseudolocalize(value) {
  const accents = { a: 'à', e: 'é', i: 'ï', o: 'ö', u: 'ü', c: 'ç', n: 'ñ' };
  // Placeholders and literal angle tokens (`<name>` in URL notation) pass
  // through untouched so the validator's verbatim-token rule holds.
  const chunks = String(value).split(/(\{[^{}]+\}|<[^<>]*>)/g);
  const transformed = chunks.map((chunk) => {
    if (/^(?:\{[^{}]+\}|<[^<>]*>)$/.test(chunk)) return chunk;
    return [...chunk].map((character) => accents[character.toLowerCase()] || character).join('');
  }).join('');
  const padding = '~'.repeat(Math.max(3, Math.ceil(String(value).length * 0.3)));
  return `[${transformed} ${padding}]`;
}

function sortedCatalog(catalog) {
  return Object.fromEntries([...catalog.entries()].sort(([a], [b]) => compareOrdinal(a, b)).map(([key, entry]) => [key, entry.value]));
}

function buildArtifacts(rawOccurrences, rawCatalog, errors, { remainders = [] } = {}) {
  const { occurrences, remainderSummaries } = finalizeOccurrences(rawOccurrences, remainders, errors);
  const catalog = sortedCatalog(rawCatalog);
  const ledger = {
    schema: 1,
    totals: buildTotals(occurrences),
    errors: [...errors].sort(compareOrdinal),
    occurrences: occurrences.map(publicOccurrence),
  };
  const pseudo = Object.fromEntries(Object.entries(catalog).map(([key, value]) => [key, pseudolocalize(value)]));
  return {
    occurrences,
    ledger,
    files: {
      'docs/i18n/STRING_LEDGER.json': jsonBytes(ledger),
      'docs/i18n/STRING_LEDGER.md': renderLedgerMarkdown(ledger, remainderSummaries),
      'locales/en.json': jsonBytes(catalog),
      'locales/qps-ploc.json': jsonBytes(pseudo),
    },
  };
}

function createRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function choose(items, count, random) {
  const pool = [...items].sort((left, right) => compareOrdinal(left.id, right.id));
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, count).sort((left, right) => compareOrdinal(left.id, right.id));
}

function renderSamplingAudit(occurrences, seed, perStratum) {
  const strata = new Map();
  for (const item of occurrences) {
    const group = item.disposition === 'pending'
      ? 'pending'
      : item.disposition.startsWith('excluded:') ? 'excluded' : null;
    if (!group) continue;
    const key = `${domainFor(item.file)}|${item.kind}`;
    const stratum = strata.get(key) || { pending: [], excluded: [] };
    stratum[group].push(item);
    strata.set(key, stratum);
  }
  const random = createRandom(seed);
  const sections = [];
  let sampled = 0;
  for (const key of [...strata.keys()].sort(compareOrdinal)) {
    const stratum = strata.get(key);
    const selected = [
      ...choose(stratum.pending, perStratum, random),
      ...choose(stratum.excluded, perStratum, random),
    ];
    if (!selected.length) continue;
    sampled += selected.length;
    sections.push(
      `## ${key.replace('|', ' × ')}`,
      '',
      '| id | text | scanner disposition | reviewer verdict | note |',
      '|---|---|---|---|---|',
      ...selected.map((item) => `| ${escapeTable(item.id)} | ${escapeTable(presentationText(item.text))} | ${item.disposition} |  | line ${item._line} |`),
      ''
    );
  }
  return [
    '# Jenny i18n sampling audit',
    '',
    `Sampled: ${sampled}; misses: TBD; false positives: TBD.`,
    'Estimated miss rate by sampled stratum: reviewer pending.',
    '',
    `Deterministic sample: seed ${seed}, up to ${perStratum} pending and ${perStratum} excluded occurrences per domain × kind stratum.`,
    '',
    ...sections,
  ].join('\n');
}

module.exports = {
  buildArtifacts,
  compareOrdinal,
  domainFor,
  isSecurityPolicy,
  jsonBytes,
  renderSamplingAudit,
};
