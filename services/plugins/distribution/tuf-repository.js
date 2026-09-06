'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BaseFetcher, Updater } = require('tuf-js');
const { DownloadHTTPError } = require('tuf-js/dist/error');
const { LIMITS } = require('./distribution-limits');

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function contained(root, candidate) { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
async function exists(target) { try { await fs.promises.access(target); return true; } catch (_error) { return false; } }
async function snapshotDirectory(target, scratchRoot, name) {
  const present = await exists(target); const snapshot = path.join(scratchRoot, name);
  if (present) await fs.promises.cp(target, snapshot, { recursive: true, force: false });
  return { target, snapshot, present };
}
async function restoreDirectory(snapshot) {
  await fs.promises.rm(snapshot.target, { recursive: true, force: true });
  if (snapshot.present) await fs.promises.cp(snapshot.snapshot, snapshot.target, { recursive: true, force: false });
}

class BrokerFetcher extends BaseFetcher {
  constructor({ broker, operationId, consent, deadlineEpochMs, signal, maxTotalBytes = LIMITS.refreshBytes }) {
    super(); this.broker = broker; this.operationId = operationId; this.consent = consent;
    this.deadlineEpochMs = deadlineEpochMs; this.signal = signal; this.maxTotalBytes = maxTotalBytes; this.totalBytes = 0;
  }
  async fetch(url) {
    const remaining = this.maxTotalBytes - this.totalBytes;
    if (remaining <= 0) throw new Error('tuf_refresh_byte_limit');
    const result = await this.broker.request({
      purpose: 'catalog_refresh', request_id: `tuf_${this.totalBytes}`, operation_id: this.operationId,
      redaction_policy: 'strict', deadline_epoch_ms: this.deadlineEpochMs, url,
      consent: this.consent, signal: this.signal,
      limits: { max_response_bytes: Math.min(LIMITS.metadataDocumentBytes, remaining) },
    });
    if (!result.ok) throw new Error(`tuf_fetch_${result.reason || 'failed'}`);
    if (result.status_code !== 200) throw new DownloadHTTPError('tuf_http_status', result.status_code);
    if (!Buffer.isBuffer(result.body) || result.body.length > LIMITS.metadataDocumentBytes) throw new Error('tuf_metadata_document_limit');
    this.totalBytes += result.body.length;
    if (this.totalBytes > this.maxTotalBytes) throw new Error('tuf_refresh_byte_limit');
    return new Response(result.body).body;
  }
}

class ConfinedFileFetcher extends BaseFetcher {
  constructor({ realRoot, maxTotalBytes = LIMITS.refreshBytes }) { super(); this.realRoot = path.resolve(realRoot); this.maxTotalBytes = maxTotalBytes; this.totalBytes = 0; }
  async fetch(url) {
    const parsed = new URL(url); if (parsed.protocol !== 'file:') throw new Error('offline_network_fallback_blocked');
    const candidate = path.resolve(decodeURIComponent(parsed.pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1))));
    const real = await fs.promises.realpath(candidate);
    if (!contained(this.realRoot, real)) throw new Error('offline_path_escape');
    const bytes = await fs.promises.readFile(real); this.totalBytes += bytes.length;
    if (bytes.length > LIMITS.metadataDocumentBytes || this.totalBytes > this.maxTotalBytes) throw new Error('tuf_refresh_byte_limit');
    return new Response(bytes).body;
  }
}

async function inspectAcceptedMetadata(metadataDir, referenceTime) {
  const names = (await fs.promises.readdir(metadataDir)).filter((name) => name.endsWith('.json')).sort();
  let targets = 0; let delegated = 0; const roles = {};
  for (const name of names) {
    const bytes = await fs.promises.readFile(path.join(metadataDir, name));
    if (bytes.length > LIMITS.metadataDocumentBytes) throw new Error('tuf_metadata_document_limit');
    const value = JSON.parse(bytes.toString('utf8')); const signed = value.signed || {};
    if (Date.parse(signed.expires) <= referenceTime) throw new Error('tuf_metadata_expired_at_trusted_time');
    targets += Object.keys(signed.targets || {}).length;
    if (!['root.json', 'timestamp.json', 'snapshot.json', 'targets.json'].includes(name)) delegated += 1;
    const role = name.replace(/^(?:\d+)\./, '').replace(/\.json$/, '');
    if (['root', 'timestamp', 'snapshot', 'targets'].includes(role)) roles[role] = { version: signed.version, digest: digest(bytes) };
  }
  if (delegated > LIMITS.delegatedRoles) throw new Error('tuf_delegated_role_limit');
  if (targets > LIMITS.targets) throw new Error('tuf_target_limit');
  return { roles, delegated_roles: delegated, targets };
}

async function refreshTufRepository({ metadataDir, targetDir, metadataBaseUrl, targetBaseUrl, initialRootBytes,
  fetcher, trustedHighWater, now = () => Date.now() }) {
  if (!Buffer.isBuffer(initialRootBytes) || !initialRootBytes.length) return { ok: false, reason: 'tuf_initial_root_required' };
  const started = now(); const highWater = Date.parse(trustedHighWater || new Date(started).toISOString());
  if (!Number.isFinite(started) || !Number.isFinite(highWater)) return { ok: false, reason: 'trusted_clock_invalid' };
  if (highWater - started > 5 * 60 * 1000) return { ok: false, reason: 'trusted_clock_regression' };
  const scratchParent = path.dirname(metadataDir); await fs.promises.mkdir(scratchParent, { recursive: true });
  const scratchRoot = await fs.promises.mkdtemp(path.join(scratchParent, '.jenny-tuf-refresh-'));
  const metadataSnapshot = await snapshotDirectory(metadataDir, scratchRoot, 'metadata');
  const targetSnapshot = await snapshotDirectory(targetDir, scratchRoot, 'targets');
  let timer; let updater;
  try {
    await fs.promises.mkdir(metadataDir, { recursive: true }); await fs.promises.mkdir(targetDir, { recursive: true });
    const rootPath = path.join(metadataDir, 'root.json');
    try { await fs.promises.access(rootPath); } catch (_error) { await fs.promises.writeFile(rootPath, initialRootBytes, { flag: 'wx' }); }
    updater = new Updater({ metadataDir, metadataBaseUrl, targetDir, targetBaseUrl, fetcher, config: {
      maxRootRotations: LIMITS.rootRotations, maxDelegations: LIMITS.delegatedRoles,
      rootMaxLength: LIMITS.metadataDocumentBytes, timestampMaxLength: LIMITS.metadataDocumentBytes,
      snapshotMaxLength: LIMITS.metadataDocumentBytes, targetsMaxLength: LIMITS.metadataDocumentBytes,
      fetchTimeout: LIMITS.refreshMs, fetchRetries: 0,
    } });
    await Promise.race([updater.refresh(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('tuf_refresh_timeout')), LIMITS.refreshMs); timer.unref?.(); })]);
    const referenceTime = Math.max(started, highWater); const accepted = await inspectAcceptedMetadata(metadataDir, referenceTime);
    return { ok: true, updater, accepted, update_started_at: new Date(started).toISOString(), trusted_high_water: new Date(referenceTime).toISOString() };
  } catch (error) {
    try { await restoreDirectory(metadataSnapshot); await restoreDirectory(targetSnapshot); }
    catch (_restoreError) { return { ok: false, reason: 'tuf_refresh_restore_failed' }; }
    const message = String(error?.message || '');
    return { ok: false, reason: /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : 'tuf_refresh_failed' };
  }
  finally {
    clearTimeout(timer);
    try { await fs.promises.rm(scratchRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (_error) { /* best-effort scratch cleanup */ }
  }
}

module.exports = { BrokerFetcher, ConfinedFileFetcher, contained, refreshTufRepository };
