const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const capabilityCache = new Map();

function parseSpecTypeValues(helpText) {
  if (typeof helpText !== 'string' || !helpText) {
    return [];
  }
  // Two help layouts exist: build 8846 prints a bracketed pipe list
  // (`--spec-type [none|ngram-cache|...]`); build 10749+ prints a bare
  // comma list (`--spec-type none,draft-simple,draft-mtp,...`). Accept both.
  // Anchored to the option's own line (`^[ \t]*--spec-type`), so a prose
  // cross-reference inside another option's description can never shadow the
  // real definition. Tolerates a future short alias (`--spec-type, -st`). The
  // bracketed list may wrap onto the next line; the bare list must START on
  // the flag line and be lowercase, and continues across a wrap only through a
  // trailing separator, and must be the last thing on its line — so neither
  // an uppercase placeholder (`--spec-type TYPE`) nor same-line description
  // text (`--spec-type draft-mtp requires ...`) can be read as values:
  // unparsed fails closed.
  const match = helpText.match(
    /^[ \t]*--spec-type\b(?:,[ \t]*-{1,2}[a-z][a-z-]*)*(?:\s*(\[[^\]]*\])|[ \t]+((?:[a-z0-9-]+[,|]\s*)*[a-z0-9-]+)(?=[ \t]*$))/m
  );
  if (!match) {
    return [];
  }

  const values = [];
  const list = (match[1] || match[2] || '').replace(/^\[|\]$/g, '');
  for (const rawValue of list.split(/[|,]/)) {
    const value = rawValue.trim();
    if (/^[a-z0-9-]{1,32}$/.test(value)) {
      values.push(value);
      if (values.length === 64) {
        break;
      }
    }
  }
  return values;
}

function parseServerBuild(versionText) {
  if (typeof versionText !== 'string' || !versionText) {
    return { build: 0, commit: '' };
  }
  // build 8846:   `version: 8846 (bcdcc1044)`
  // build 10749+: `version: 0.3.0-dev (build 10749, commit dfc29b64e)` — the
  // commit clause is optional so a banner without it still yields the build.
  const match = versionText.match(
    /^\s*version:\s*(?:(\d+)\s*\(([^)]*)\)|\S+\s*\(build\s+(\d+)(?:,\s*commit\s+([^)\s]*))?\s*\))/mi
  );
  if (!match) {
    return { build: 0, commit: '' };
  }

  const build = Number(match[1] || match[3]);
  const commitCandidate = String(match[2] || match[4] || '').trim().slice(0, 40);
  return {
    build: Number.isSafeInteger(build) ? build : 0,
    commit: /^[0-9a-f]+$/i.test(commitCandidate) ? commitCandidate : '',
  };
}

function failedResult(token) {
  return {
    ok: false,
    specTypes: [],
    supportsMtp: false,
    build: 0,
    commit: '',
    reason: `probe_failed:${token}`,
  };
}

function cacheResult(binaryPath, signature, result) {
  capabilityCache.delete(binaryPath);
  capabilityCache.set(binaryPath, { signature, result });
  if (capabilityCache.size > 4) {
    capabilityCache.delete(capabilityCache.keys().next().value);
  }
  return result;
}

function probeCapabilities(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const binaryPath = source.binaryPath;
  const execFileSyncImpl = source.execFileSyncImpl || execFileSync;
  const spawnSyncImpl = source.spawnSyncImpl || spawnSync;
  const fsImpl = source.fsImpl || fs;
  if (typeof binaryPath !== 'string' || !binaryPath.trim()) {
    return failedResult('no_binary');
  }

  let stat;
  try {
    stat = fsImpl.statSync(binaryPath);
  } catch (_error) {
    return failedResult('no_binary');
  }

  const signature = `${stat.mtimeMs}:${stat.size}`;
  const cached = capabilityCache.get(binaryPath);
  if (cached && cached.signature === signature) {
    return cached.result;
  }

  const execOptions = {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  };
  let helpText;
  try {
    helpText = execFileSyncImpl(binaryPath, ['--help'], execOptions);
  } catch (_error) {
    return cacheResult(binaryPath, signature, failedResult('exec_error'));
  }

  // llama-server prints the version banner to STDERR and exits 0, so
  // execFileSync (stdout-only on success) never sees it — spawnSync captures
  // both streams regardless of exit code. Verified against the real binary.
  let versionText = '';
  try {
    const versionRun = spawnSyncImpl(binaryPath, ['--version'], execOptions);
    versionText = String((versionRun && versionRun.stdout) || '')
      + String((versionRun && versionRun.stderr) || '');
  } catch (_error) {
    /* provenance is best-effort; the help parse is the authority */
  }

  const specTypes = parseSpecTypeValues(helpText);
  const { build, commit } = parseServerBuild(versionText);
  return cacheResult(binaryPath, signature, {
    ok: true,
    specTypes,
    supportsMtp: specTypes.includes('draft-mtp'),
    build,
    commit,
    reason: 'probed',
  });
}

module.exports = {
  parseSpecTypeValues,
  parseServerBuild,
  probeCapabilities,
};
