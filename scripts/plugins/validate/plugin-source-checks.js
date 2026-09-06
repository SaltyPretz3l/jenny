'use strict';

const crypto = require('node:crypto');

const budgets = require('../../../config/plugins/budgets.json');
const { validate } = require('../../../services/plugins/contracts/generated-plugin-contracts');
const { validateDeclarativeContent,
  MAX_ITEM_CONTEXT_BYTES } = require('../../../services/plugins/data/declarative-content-validator');
const { validateRestrictedContent } = require(
  '../../../services/plugins/restricted-host/contribution-compiler'
);
const { contractForManifest,
  verifyDistributionPackage } = require('../../../services/plugins/package/distribution-package-intake');
const {
  MANIFEST_PATH,
  SIGNATURE_BUNDLE_PATH,
  OPTIONAL_PACKAGE_PATHS,
  MAX_DECLARATIVE_JSON_BYTES,
  MAX_OPTIONAL_METADATA_BYTES,
  MAX_PLUGIN_CONTEXT_BYTES,
  contextBytesFor,
  parseJsonBytes,
  parseSignatureBundle,
  validateManifestDisplayNames,
} = require('../../../services/plugins/package/local-package-intake');
const { validateDisplayString } = require('../../../services/plugins/identity/display-strings');
const { STAGE7_LIMITS } = require('../../../services/plugins/view/stage7-budgets');
const { HINTS } = require('./plugin-source-report');

// Kind sets mirror the (unexported) ones in both package intakes; keep them in lockstep.
const VIEW_KINDS = new Set(['setup_scene', 'panel', 'artifact_renderer']);
const PRIVILEGED_KINDS = new Set(['native_mcp', 'session_provider', 'engine_adapter', 'hook']);
const RESTRICTED_KINDS = new Set([
  'restricted_transform', 'restricted_formatter', 'restricted_renderer', 'restricted_compute',
]);

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function result(id, status, target, details = {}) {
  return {
    id, status, target,
    problem: details.problem ?? null,
    hint: details.hint ?? null,
    code: details.code ?? null,
    path: details.path ?? null,
  };
}

function passed(id, target) {
  return result(id, 'pass', target);
}

function skipped(id, target, reason) {
  return result(id, 'skip', target, { problem: reason });
}

function failed(id, target, problem, hint, error = {}) {
  return result(id, 'fail', target, {
    problem, hint, code: error.code ?? null, path: error.path ?? null,
  });
}

function contractProblem(error) {
  const location = error.path || '<root>';
  return `[${error.code}] ${location}: ${error.reason || 'contract validation failed'}`;
}

function safeArchivePath(entryPath) {
  if (typeof entryPath !== 'string' || entryPath.length === 0 || entryPath.includes('\\')
    || entryPath.startsWith('/') || /^[A-Za-z]:/.test(entryPath)) return false;
  const parts = entryPath.split('/');
  return !parts.includes('') && !parts.includes('.') && !parts.includes('..');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Manifest contracts also reject spoofed display strings and unsafe content paths.
// Substitute only those later-check-owned fields so display-strings and traversal
// failures do not become generic manifest-schema failures that short-circuit checks 3-7.
function manifestSchemaCandidate(source) {
  const candidate = structuredClone(source.manifest);
  if (typeof candidate.name === 'string' && !validateDisplayString(candidate.name).ok) {
    candidate.name = 'Plugin display name';
  }
  if (!Array.isArray(candidate.contributions)) return candidate;
  candidate.contributions.forEach((contribution, index) => {
    if (!isPlainObject(contribution)) return;
    if (typeof contribution.name === 'string' && !validateDisplayString(contribution.name).ok) {
      contribution.name = 'Contribution display name';
    }
    if (source.kind === 'folder'
      && source.contributions[index]?.parseError?.reason === 'content_path_unsafe') {
      contribution.content_path = `content/unsafe-${index}.json`;
    }
  });
  return candidate;
}

function permittedArchivePaths(source) {
  const permitted = new Set([
    MANIFEST_PATH, SIGNATURE_BUNDLE_PATH, ...OPTIONAL_PACKAGE_PATHS,
  ]);
  const manifestContributions = Array.isArray(source.manifest?.contributions)
    ? source.manifest.contributions : [];
  for (const contribution of manifestContributions) {
    if (!isPlainObject(contribution)) continue;
    for (const key of ['content_path', 'component_path', 'executable_path']) {
      if (typeof contribution[key] === 'string') permitted.add(contribution[key]);
    }
  }
  for (const contribution of source.contributions) {
    const assets = Array.isArray(contribution.json?.assets) ? contribution.json.assets : [];
    for (const asset of assets) {
      if (typeof asset?.path === 'string') permitted.add(asset.path);
    }
  }
  return permitted;
}

function archiveStructure(source) {
  const id = 'archive-structure';
  if (source.kind === 'folder') return [skipped(id, source.rootPath, 'folders are not archives')];
  if (source.archive.failure) {
    return [failed(id, source.rootPath, source.archive.failure.reason,
      HINTS.archive_invalid, source.archive.failure)];
  }
  const paths = source.archive.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    return [failed(id, source.rootPath, 'duplicate archive entry', HINTS.archive_invalid)];
  }
  const unsafe = paths.find((entryPath) => !safeArchivePath(entryPath));
  if (unsafe) {
    return [failed(id, unsafe, 'archive path traversal or non-canonical path', HINTS.archive_invalid,
      { path: unsafe })];
  }
  if (!paths.includes(MANIFEST_PATH) || !paths.includes(SIGNATURE_BUNDLE_PATH)) {
    return [failed(id, source.rootPath, 'required package entry missing', HINTS.archive_invalid)];
  }
  for (const metadataPath of ['META-JENNY/sbom.json', 'META-JENNY/provenance.json']) {
    const entry = source.archive.entries.find((item) => item.path === metadataPath);
    if (!entry) continue;
    if (entry.uncompressedSize > MAX_OPTIONAL_METADATA_BYTES) {
      return [failed(id, metadataPath, 'optional_metadata_too_large',
        HINTS.archive_invalid, { path: metadataPath })];
    }
    const parsed = parseJsonBytes(source.archive.bytesByPath.get(metadataPath), metadataPath);
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      return [failed(id, metadataPath, 'optional_metadata_invalid',
        HINTS.archive_invalid, { path: metadataPath })];
    }
  }
  const permitted = permittedArchivePaths(source);
  const unexpected = paths.find((entryPath) => !permitted.has(entryPath));
  if (unexpected) {
    return [failed(id, unexpected, 'unsupported package entry', HINTS.archive_invalid,
      { path: unexpected })];
  }
  return [passed(id, source.rootPath)];
}

function manifestSchema(source, ctx) {
  const id = 'manifest-schema';
  if (source.manifestParseError || !source.manifest) {
    ctx.manifestValid = false;
    const error = source.manifestParseError || { reason: 'manifest unavailable' };
    return [failed(id, MANIFEST_PATH, error.reason, HINTS.manifest_invalid, error)];
  }
  const contract = contractForManifest(source.manifest.manifest_schema_version);
  if (!contract) {
    ctx.manifestValid = false;
    return [failed(id, MANIFEST_PATH,
      `unsupported manifest_schema_version: ${String(source.manifest.manifest_schema_version)}`,
      HINTS.manifest_contract_unsupported, { path: 'manifest_schema_version' })];
  }
  const checked = validate(contract, manifestSchemaCandidate(source));
  ctx.manifestValid = checked.ok;
  return checked.ok ? [passed(id, MANIFEST_PATH)]
    : [failed(id, MANIFEST_PATH, contractProblem(checked.error),
      HINTS.manifest_invalid, checked.error)];
}

function displayStrings(source, ctx) {
  const id = 'display-strings';
  if (!ctx.manifestValid) return [skipped(id, MANIFEST_PATH, 'manifest invalid')];
  const checked = validateManifestDisplayNames(source.manifest);
  if (checked.ok) return [passed(id, MANIFEST_PATH)];
  const detail = checked.detail || {};
  const location = detail.field || detail.contribution_id || 'name';
  return [failed(id, MANIFEST_PATH, `${checked.reason}: ${detail.reason || 'invalid display string'}`,
    HINTS.display_string_invalid, { code: checked.code, path: location })];
}

function contentSchema(source, ctx) {
  const id = 'content-schema';
  if (!ctx.manifestValid) return [skipped(id, source.rootPath, 'manifest invalid')];
  ctx.contentSchemaValid = new Map();
  ctx.contentKinds = new Map();
  return source.contributions.map((contribution) => {
    if (contribution.parseError) {
      ctx.contentSchemaValid.set(contribution, false);
      const unsafe = contribution.parseError.reason === 'content_path_unsafe';
      return failed(id, contribution.content_path, contribution.parseError.reason,
        unsafe ? HINTS.content_path_unsafe : HINTS.content_invalid, contribution.parseError);
    }
    const manifestContribution = source.manifest.contributions.find(
      (item) => isPlainObject(item) && item.contribution_id === contribution.contribution_id
    );
    const manifestVersion = source.manifest.manifest_schema_version;
    let kind = 'declarative';
    let checked;
    if (manifestVersion === 6 && PRIVILEGED_KINDS.has(contribution.kind)) {
      kind = 'privileged';
      checked = validate('PluginFullHostContentV6', contribution.json);
    } else if (VIEW_KINDS.has(contribution.kind)) {
      kind = 'view';
      checked = validate('PluginViewContentV5', contribution.json);
    } else if (contribution.kind === 'provider_descriptor') {
      kind = 'provider';
      checked = validate('PluginProviderDescriptorV5', contribution.json);
    } else if (RESTRICTED_KINDS.has(contribution.kind)) {
      kind = 'restricted';
      checked = validateRestrictedContent(contribution.json, {
        manifest: source.manifest, contribution: manifestContribution,
      });
    } else {
      checked = validate(`PluginDeclarativeContentV${contribution.json?.content_schema_version}`,
        contribution.json);
    }
    ctx.contentKinds.set(contribution, kind);
    ctx.contentSchemaValid.set(contribution, checked.ok);
    const error = checked.error || checked;
    return checked.ok ? passed(id, contribution.content_path)
      : failed(id, contribution.content_path,
        error.code ? contractProblem(error) : (error.reason || 'content validation failed'),
        HINTS.content_invalid, error);
  });
}

function contentSemantics(source, ctx) {
  const id = 'content-semantics';
  if (!ctx.manifestValid) return [skipped(id, source.rootPath, 'manifest invalid')];
  return source.contributions.map((contribution) => {
    if (!ctx.contentSchemaValid.get(contribution)) {
      return skipped(id, contribution.content_path, 'content invalid');
    }
    if (ctx.contentKinds.get(contribution) !== 'declarative') {
      return skipped(id, contribution.content_path, 'not declarative content');
    }
    const checked = validateDeclarativeContent(contribution.json, {
      expectedAuthority: {
        publisher_id: source.manifest.publisher_id,
        plugin_id: source.manifest.plugin_id,
        contribution_id: contribution.contribution_id,
      },
      expectedKind: contribution.kind,
    });
    return checked.ok ? passed(id, contribution.content_path)
      : failed(id, contribution.content_path, checked.reason,
        HINTS.content_invalid, { path: checked.path });
  });
}

function contentDigests(source, ctx) {
  const id = 'content-digests';
  if (!ctx.manifestValid) return [skipped(id, source.rootPath, 'manifest invalid')];
  return source.contributions.map((contribution) => {
    if (!Buffer.isBuffer(contribution.bytes)) {
      return skipped(id, contribution.content_path, 'content unavailable');
    }
    const actual = digest(contribution.bytes);
    return actual === contribution.declaredDigest ? passed(id, contribution.content_path)
      : failed(id, contribution.content_path,
        `content_sha256 mismatch; true digest is ${actual}`,
        `set content_sha256 to ${actual} or use --write-digests`,
        { code: 'digest_mismatch', path: 'content_sha256' });
  });
}

function budgetFailure(source) {
  let pluginContextBytes = 0;
  let pluginViewBytes = 0;
  for (const contribution of source.contributions) {
    const itemBytes = contribution.byteLength;
    if (Number.isSafeInteger(itemBytes) && itemBytes > MAX_DECLARATIVE_JSON_BYTES) {
      return { target: contribution.content_path, problem: 'declarative JSON byte budget exceeded' };
    }
    const payload = contribution.json?.payload;
    if (payload && (payload.kind === 'skill' || payload.kind === 'prompt')) {
      const contextBytes = contextBytesFor(contribution.json);
      if (contextBytes > MAX_ITEM_CONTEXT_BYTES) {
        return { target: contribution.content_path, problem: 'declarative item context budget exceeded' };
      }
      pluginContextBytes += contextBytes;
    }
    if (VIEW_KINDS.has(contribution.kind) && Array.isArray(contribution.json?.assets)) {
      const assets = contribution.json.assets;
      if (assets.length > STAGE7_LIMITS.assets_per_view) {
        return { target: contribution.content_path, problem: 'view asset-count budget exceeded' };
      }
      let viewBytes = 0;
      for (const asset of assets) {
        if (Number.isFinite(asset?.bytes) && asset.bytes > STAGE7_LIMITS.asset_bytes) {
          return { target: contribution.content_path, problem: 'view asset byte budget exceeded' };
        }
        if (Number.isFinite(asset?.bytes) && asset.bytes > 0) viewBytes += asset.bytes;
      }
      if (viewBytes > STAGE7_LIMITS.view_bytes) {
        return { target: contribution.content_path, problem: 'per-view byte budget exceeded' };
      }
      pluginViewBytes += viewBytes;
    }
  }
  if (pluginContextBytes > MAX_PLUGIN_CONTEXT_BYTES) {
    return { target: source.rootPath, problem: 'plugin context budget exceeded' };
  }
  if (pluginViewBytes > STAGE7_LIMITS.plugin_view_bytes) {
    return { target: source.rootPath, problem: 'plugin view byte budget exceeded' };
  }
  return null;
}

function checkBudgets(source, ctx) {
  const id = 'budgets';
  if (!ctx.manifestValid) return [skipped(id, source.rootPath, 'manifest invalid')];
  const failure = budgetFailure(source);
  return failure ? [failed(id, failure.target, failure.problem, HINTS.budget_exceeded,
    { code: 'budget_exceeded' })] : [passed(id, source.rootPath)];
}

function signatureBundleShape(source) {
  const id = 'signature-bundle-shape';
  if (source.signatureBundleError) {
    return [failed(id, SIGNATURE_BUNDLE_PATH, source.signatureBundleError.reason,
      HINTS.signature_bundle_invalid, source.signatureBundleError)];
  }
  if (!Buffer.isBuffer(source.signatureBundleBytes)) {
    return [skipped(id, SIGNATURE_BUNDLE_PATH, 'signature bundle absent')];
  }
  const checked = parseSignatureBundle(source.signatureBundleBytes);
  return checked.ok ? [passed(id, SIGNATURE_BUNDLE_PATH)]
    : [failed(id, SIGNATURE_BUNDLE_PATH, checked.reason,
      HINTS.signature_bundle_invalid, { code: checked.code, path: checked.detail?.entry })];
}

async function developerProfileIntake(source) {
  const id = 'developer-profile-intake';
  if (source.kind === 'folder') return [skipped(id, source.rootPath, 'folders are not archives')];
  const now = new Date().toISOString();
  const trustRoots = Object.freeze({
    ok: true,
    value: Object.freeze({ trust_roots_schema_version: 1, updated_at: now, publishers: [] }),
    publishers: new Map(),
  });
  const checked = await verifyDistributionPackage({
    bytes: source.archiveBytes,
    sourceIdentity: { kind: 'local_package', package_path_digest: digest(Buffer.from(source.rootPath, 'utf8')) },
    trustRoots,
    verificationCacheKey: digest(source.archiveBytes),
    now,
    developerProfile: true,
  });
  return checked.ok ? [passed(id, source.rootPath)]
    : [failed(id, source.rootPath, checked.reason || 'developer-profile intake rejected the archive',
      HINTS.developer_intake_failed,
      { code: checked.code, path: checked.detail?.path || checked.detail?.entry })];
}

const CHECKS = Object.freeze([
  { id: 'archive-structure', appliesTo: 'archive', run: archiveStructure },
  { id: 'manifest-schema', appliesTo: 'both', run: manifestSchema },
  { id: 'display-strings', appliesTo: 'both', run: displayStrings },
  { id: 'content-schema', appliesTo: 'both', run: contentSchema },
  { id: 'content-semantics', appliesTo: 'both', run: contentSemantics },
  { id: 'content-digests', appliesTo: 'both', run: contentDigests },
  { id: 'budgets', appliesTo: 'both', run: checkBudgets },
  { id: 'signature-bundle-shape', appliesTo: 'both', run: signatureBundleShape },
  { id: 'developer-profile-intake', appliesTo: 'archive', run: developerProfileIntake },
]);

async function runChecks(source) {
  const ctx = { manifestValid: false, contentSchemaValid: new Map(), contentKinds: new Map() };
  const checks = [];
  for (const check of CHECKS) checks.push(...await check.run(source, ctx));
  return { ok: checks.every((check) => check.status !== 'fail'), checks };
}

module.exports = { CHECKS, permittedArchivePaths, runChecks };
