'use strict';

const DEFAULT_MINIMUM_VERSION = '0.30.10';

function parseVersionDetails(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 128) return null;
  const match = raw.match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i
  );
  if (!match) return null;
  const core = match.slice(1, 4).map((part) => Number(part));
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = String(match[4] || '');
  if (prerelease && prerelease.split('.').some(
    (part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))
  )) {
    return null;
  }
  return {
    core,
    prerelease,
  };
}

function comparePrerelease(left, right) {
  const a = left.split('.');
  const b = right.split('.');
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] === b[i]) continue;
    const aNumeric = /^\d+$/.test(a[i]);
    const bNumeric = /^\d+$/.test(b[i]);
    if (aNumeric && bNumeric) {
      if (a[i].length !== b[i].length) return a[i].length < b[i].length ? -1 : 1;
      return a[i] < b[i] ? -1 : 1;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function compareVersions(left, right) {
  const a = parseVersionDetails(left);
  const b = parseVersionDetails(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function evaluateOllamaVersion(
  version,
  minimumVersion = DEFAULT_MINIMUM_VERSION,
  { serving = false } = {}
) {
  const comparison = compareVersions(version, minimumVersion);
  if (comparison === null) {
    return Object.freeze({
      minimumVersion,
      versionSupported: serving === true,
      upgradeRequired: false,
      versionStatus: serving === true ? 'serving_unverified' : 'unverified',
    });
  }
  const supported = comparison >= 0;
  return Object.freeze({
    minimumVersion,
    versionSupported: supported,
    upgradeRequired: !supported,
    versionStatus: supported ? 'supported' : 'outdated',
  });
}

module.exports = {
  compareVersions,
  evaluateOllamaVersion,
};
