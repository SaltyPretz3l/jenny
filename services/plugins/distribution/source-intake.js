'use strict';

const crypto = require('node:crypto');

function digest(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }

// Only local packages are acquired now; signed_catalog and offline_mirror
// identities stay valid frozen contract kinds but never match a new candidate.
function sourceTrustMatches(identity, trustSource) {
  if (!identity || !trustSource || identity.kind !== trustSource.kind) return false;
  if (identity.kind === 'local_package') return identity.package_path_digest === trustSource.package_path_digest;
  return false;
}

module.exports = { digest, sourceTrustMatches };
