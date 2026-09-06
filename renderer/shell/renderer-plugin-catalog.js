(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('semver')); return; }
  root.rendererPluginCatalog = factory(null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (semver) {
  'use strict';

  function comparePrerelease(left, right) {
    var leftIds = left ? left.split('.') : [];
    var rightIds = right ? right.split('.') : [];
    if (!leftIds.length || !rightIds.length) return rightIds.length - leftIds.length;
    for (var index = 0; index < Math.max(leftIds.length, rightIds.length); index += 1) {
      if (leftIds[index] === undefined) return -1;
      if (rightIds[index] === undefined) return 1;
      if (leftIds[index] === rightIds[index]) continue;
      var leftNumeric = /^\d+$/.test(leftIds[index]);
      var rightNumeric = /^\d+$/.test(rightIds[index]);
      if (leftNumeric && rightNumeric) return Number(leftIds[index]) > Number(rightIds[index]) ? 1 : -1;
      if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
      return leftIds[index] > rightIds[index] ? 1 : -1;
    }
    return 0;
  }

  function fallbackCompare(candidate, current) {
    var pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
    var left = String(candidate || '').match(pattern);
    var right = String(current || '').match(pattern);
    if (!left || !right) return false;
    for (var index = 1; index <= 3; index += 1) {
      if (Number(left[index]) !== Number(right[index])) return Number(left[index]) > Number(right[index]);
    }
    return comparePrerelease(left[4], right[4]) > 0;
  }

  function isNewerVersion(candidate, current) {
    if (semver?.valid(candidate) && semver?.valid(current)) return semver.gt(candidate, current);
    return semver ? false : fallbackCompare(candidate, current);
  }

  function normalizeCatalogState(payload) {
    var source = payload && typeof payload === 'object' ? payload : {};
    return {
      ok: source.ok === true,
      revision: Number.isInteger(source.revision) ? source.revision : 0,
      configured: source.configured === true,
      emptyReason: String(source.empty_reason || ''),
      sources: Array.isArray(source.sources) ? source.sources.map(function (row) { return {
        sourceId: String(row.source_id || ''), kind: String(row.kind || ''),
        displayName: String(row.display_name || row.source_id || ''),
        rootFingerprint: String(row.root_fingerprint || ''), status: String(row.status || ''),
        reason: String(row.reason || ''),
      }; }) : [],
      entries: Array.isArray(source.entries) ? source.entries.map(function (row) { return {
        sourceId: String(row.source_id || ''), publisherId: String(row.publisher_id || ''),
        pluginId: String(row.plugin_id || ''), displayName: String(row.display_name || ''),
        version: String(row.version || ''), summary: String(row.summary || ''),
        sizeBytes: Number(row.package_size_bytes) || 0, digest: String(row.package_sha256 || ''),
      }; }) : [],
    };
  }

  function renderCatalog(model, installed, button, escapeHtml, busy) {
    if (!model) return '<div class="settings-note">Loading verified catalogs…</div>';
    if (!model.configured) {
      return '<div class="settings-note" data-plugin-catalog-empty><strong>No catalog configured.</strong> '
        + 'Jenny has no hosted catalog endpoint. Add a trusted offline mirror to browse verified packages.</div>';
    }
    var rows = model.entries.map(function (entry) {
      var current = installed.find(function (plugin) {
        return plugin.publisherId === entry.publisherId && plugin.pluginId === entry.pluginId;
      });
      var update = Boolean(current && isNewerVersion(entry.version, current.version));
      var installedAlready = Boolean(current && !update);
      var secondary = [entry.version, entry.publisherId, entry.summary].filter(Boolean).join(' · ');
      return '<div class="settings-field-row plugin-catalog-row" data-catalog-entry="' + escapeHtml(entry.digest) + '">'
        + '<span class="settings-field-row-text"><strong>' + escapeHtml(entry.displayName) + '</strong><small>'
        + escapeHtml(secondary) + '</small></span>'
        + button({ label: update ? 'Update' : (installedAlready ? 'Installed' : 'Install'), variant: 'ghost', size: 'sm',
          disabled: busy || installedAlready,
          dataset: { 'plugins-settings-action': update ? 'catalog-update' : 'catalog-install',
            'source-id': entry.sourceId, 'publisher-id': entry.publisherId,
            'plugin-id': entry.pluginId, version: entry.version, 'package-sha256': entry.digest } })
        + '</div>';
    });
    return rows.length ? rows.join('')
      : '<div class="settings-note">Configured catalogs contain no installable Jenny targets.</div>';
  }

  return Object.freeze({ normalizeCatalogState: normalizeCatalogState, renderCatalog: renderCatalog,
    isNewerVersion: isNewerVersion });
});
