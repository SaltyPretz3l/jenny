'use strict';

const { PLUGIN_ERROR_CODES } = require('../backend/error-codes');
const { verifyDistributionPackage } = require('../plugins/package/distribution-package-intake');
const { readPackageAtPath } = require('./plugin-local-package-source');

function createDeveloperProfileSeams({
  enabled,
  trustRootsProvider,
  log = () => {},
} = {}) {
  async function inspectLocalPackage(selected) {
    const trustRoots = await trustRootsProvider();
    if (!trustRoots.ok) return trustRoots;
    const common = {
      bytes: selected.bytes,
      trustRoots,
      verificationCacheKey: '0'.repeat(64),
      now: new Date().toISOString(),
    };
    const sourceIdentity = {
      kind: 'local_package', package_path_digest: selected.sourcePathDigest,
    };
    const signed = await verifyDistributionPackage({ ...common, sourceIdentity });
    if (signed.ok || signed.code !== PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED || enabled !== true) {
      return signed;
    }
    const developer = await verifyDistributionPackage({ ...common,
      sourceIdentity, developerProfile: true });
    if (developer.ok) log('INFO', 'plugins.developer_profile.accepted', {
      publisher_id: developer.publisher_id, plugin_id: developer.plugin_id,
      link_digest: developer.archive_digest,
    });
    return developer;
  }

  return Object.freeze({ inspectLocalPackage,
    readPackageAtPath: (packagePath) => readPackageAtPath(packagePath) });
}

module.exports = { createDeveloperProfileSeams };
