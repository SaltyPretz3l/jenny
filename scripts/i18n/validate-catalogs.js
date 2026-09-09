#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Share of English base keys a shipped catalog must still cover when missing
// keys are only warnings (the default mode).
const COVERAGE_FLOOR = 0.9;

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArguments(argv) {
  const options = { localesDir: path.join(process.cwd(), 'locales'), only: null, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--locales-dir') {
      const value = argv[index += 1];
      if (!value) throw new Error('--locales-dir requires a path');
      options.localesDir = path.resolve(value);
    } else if (argument === '--only') options.only = argv[index += 1] || '';
    else if (argument === '--strict') options.strict = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.only !== null && !options.only) throw new Error('--only requires a tag');
  return options;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCatalog(localesDir, tag) {
  const filename = `${tag}.json`;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(localesDir, filename), 'utf8'));
  } catch (error) {
    throw new Error(`${filename}:<catalog>: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(parsed)) throw new Error(`${filename}:<catalog>: catalog must be a JSON object`);
  const wrapped = Object.prototype.hasOwnProperty.call(parsed, 'strings');
  const strings = wrapped ? parsed.strings : parsed;
  if (!isPlainObject(strings)) throw new Error(`${filename}:<catalog>: strings must be a JSON object`);
  if (wrapped && parsed.tag !== tag) {
    throw new Error(`${filename}:<catalog>: tag must match filename (${tag})`);
  }
  for (const [key, value] of Object.entries(strings)) {
    if (typeof value !== 'string') throw new Error(`${filename}:${key}: value must be a string`);
  }
  return strings;
}

function splitKey(key) {
  const marker = key.lastIndexOf('#');
  if (marker < 0) return { base: key, category: null };
  return { base: key.slice(0, marker), category: key.slice(marker + 1) };
}

function familiesFor(strings) {
  const families = new Map();
  for (const key of Object.keys(strings).sort(compareOrdinal)) {
    const { base, category } = splitKey(key);
    const family = families.get(base) || new Map();
    family.set(category, { key, value: strings[key] });
    families.set(base, family);
  }
  return families;
}

function placeholders(value) {
  const result = new Set();
  for (const match of String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)) result.add(match[1]);
  return [...result].sort(compareOrdinal);
}

function sameItems(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function englishEntryFor(family, category) {
  return family.get(category)
    || (category === 'one' ? family.get('one') : family.get('other'))
    || family.values().next().value;
}

function validateValue(filename, key, translated, english, failures, warnings, allowedTokens = null) {
  // A translation may keep the angle delimiters its English source carries
  // (literal notation such as <name> or "Settings > Remote Control") but can
  // never add one, so no catalog can introduce markup.
  // Every <…> token in the translation must be one the English string carries
  // verbatim (so `<name>` survives but `<img …>` cannot replace it), and bare
  // delimiters may not multiply.
  const angleTokens = (value) => (value.match(/<[^<>]*>/g) || []).sort(compareOrdinal);
  const bareAngles = (value) => (value.replace(/<[^<>]*>/g, '').match(/[<>]/g) || []).length;
  const englishTokens = angleTokens(english);
  const translatedTokens = angleTokens(translated);
  const tokensAllowed = translatedTokens.every((token) => {
    const index = englishTokens.indexOf(token);
    if (index === -1) return false;
    englishTokens.splice(index, 1);
    return true;
  });
  if (!tokensAllowed || bareAngles(translated) > bareAngles(english)) {
    failures.push(`${filename}:${key}: markup is not allowed`);
  }
  if (translated.includes('\r')) failures.push(`${filename}:${key}: carriage returns are not allowed`);
  const actualTokens = placeholders(translated);
  const expectedTokens = placeholders(english);
  // Plural variants may use any placeholder from the English family: CLDR
  // "one" covers 21, 31, ... in Russian, so it needs {count} even when the
  // English singular is the literal "1 result".
  const tokensAccepted = allowedTokens
    ? actualTokens.every((token) => allowedTokens.allowed.has(token))
      && [...allowedTokens.required].every((token) => actualTokens.includes(token))
    : sameItems(actualTokens, expectedTokens);
  if (!String(translated).trim()) failures.push(`${filename}:${key}: translation is empty`);
  if (!tokensAccepted) {
    failures.push(
      `${filename}:${key}: placeholder set {${actualTokens.join(', ')}} does not match English {${expectedTokens.join(', ')}}`
    );
  }
  if (translated.length > english.length * 3) {
    const reason = `length ${translated.length} exceeds 3x English length ${english.length}`;
    if (english.length < 8) warnings.push(`${filename}:${key}: ${reason}`);
    else failures.push(`${filename}:${key}: ${reason}`);
  }
}

function validateCatalog(tag, strings, englishStrings, { strict = false } = {}) {
  const filename = `${tag}.json`;
  const failures = [];
  const warnings = [];
  const englishFamilies = familiesFor(englishStrings);
  const translatedFamilies = familiesFor(strings);
  let pluralCategories;
  try {
    pluralCategories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
  } catch (error) {
    return { failures: [`${filename}:<catalog>: invalid locale tag: ${error.message}`], warnings };
  }

  // A key the catalog lacks falls back to the English default at runtime, so
  // new UI copy does not break every catalog; --strict (the translation gate)
  // makes the gap a failure. Wholesale loss is never tolerated: below the
  // coverage floor the default mode fails too.
  let missing = 0;
  for (const base of [...englishFamilies.keys()].sort(compareOrdinal)) {
    if (!translatedFamilies.has(base)) {
      missing += 1;
      (strict ? failures : warnings).push(`${filename}:${base}: missing English key`);
    }
  }
  if (!strict && englishFamilies.size > 0 && missing > englishFamilies.size * (1 - COVERAGE_FLOOR)) {
    const covered = englishFamilies.size - missing;
    failures.push(
      `${filename}:<catalog>: covers ${covered} of ${englishFamilies.size} English keys; the floor is ${Math.round(COVERAGE_FLOOR * 100)}%`
    );
  }
  for (const base of [...translatedFamilies.keys()].sort(compareOrdinal)) {
    if (!englishFamilies.has(base)) failures.push(`${filename}:${base}: unknown key`);
  }

  for (const [base, translatedFamily] of translatedFamilies) {
    const englishFamily = englishFamilies.get(base);
    if (!englishFamily) continue;
    const englishIsPlural = [...englishFamily.keys()].some((category) => category !== null);
    const translatedIsPlural = [...translatedFamily.keys()].some((category) => category !== null);
    if (!englishIsPlural && translatedIsPlural) {
      failures.push(`${filename}:${base}: plural variants are not allowed for a non-plural English key`);
      continue;
    }
    if (englishIsPlural) {
      const actualCategories = [...translatedFamily.keys()]
        .filter((category) => category !== null)
        .sort(compareOrdinal);
      const expectedCategories = [...pluralCategories].sort(compareOrdinal);
      if (translatedFamily.has(null) || !sameItems(actualCategories, expectedCategories)) {
        failures.push(
          `${filename}:${base}: plural categories ${actualCategories.join(', ') || '(none)'}; expected ${expectedCategories.join(', ')}`
        );
      }
      // allowed = any placeholder the English family uses; required = those
      // every English variant carries (a translation may not drop {destination}).
      const familyTokens = { allowed: new Set(), required: null };
      for (const entry of englishFamily.values()) {
        const tokens = placeholders(entry.value);
        tokens.forEach((token) => familyTokens.allowed.add(token));
        familyTokens.required = familyTokens.required === null
          ? new Set(tokens)
          : new Set([...familyTokens.required].filter((token) => tokens.includes(token)));
      }
      familyTokens.required = familyTokens.required || new Set();
      for (const [category, entry] of translatedFamily) {
        if (category === null) continue;
        const englishEntry = englishEntryFor(englishFamily, category);
        validateValue(filename, entry.key, entry.value, englishEntry.value, failures, warnings, familyTokens);
      }
      continue;
    }
    const translated = translatedFamily.get(null);
    const english = englishFamily.get(null);
    if (!translated) {
      failures.push(`${filename}:${base}: missing non-plural translation`);
      continue;
    }
    validateValue(filename, base, translated.value, english.value, failures, warnings);
  }
  return { failures, warnings };
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    const english = readCatalog(options.localesDir, 'en');
    const tags = options.only !== null
      ? [options.only]
      : fs.readdirSync(options.localesDir)
        .filter((name) => name.endsWith('.json') && name !== 'en.json')
        .map((name) => name.slice(0, -5))
        .sort(compareOrdinal);
    const failures = [];
    const warnings = [];
    for (const tag of tags) {
      if (tag === 'en') continue;
      const result = validateCatalog(tag, readCatalog(options.localesDir, tag), english, { strict: options.strict });
      failures.push(...result.failures);
      warnings.push(...result.warnings);
    }
    for (const warning of warnings) console.warn(`WARN: ${warning}`);
    if (failures.length) {
      for (const failure of failures) console.error(failure);
      return 1;
    }
    console.log(`PASS: ${tags.filter((tag) => tag !== 'en').length} i18n catalog(s) validated`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, validateCatalog };
