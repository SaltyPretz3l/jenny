'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const crypto = require('node:crypto');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { verifyDistributionPackage } = require('../../../services/plugins/package/distribution-package-intake');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { putContent } = require('../../../services/plugins/store/content-store');
const { writePackageRecord } = require('../../../services/plugins/store/package-record-store');
const { compileCurrentRuntimeSnapshot } = require('../../../services/plugins/runtime/declarative-compiler');
function stable(value){if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function digest(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
test('V6 ZIP sizing detects aggregate oversize without allocating an archive', async () => {
  const { MAX_V6_ARCHIVE_BYTES, projectStoredV6ZipBytes } = await import(
    '../../../scripts/plugins/jenny-plugin-zip-v6.mjs'
  );
  const projected = projectStoredV6ZipBytes([
    { path: 'a.bin', bytes: { length: 180 * 1024 * 1024 } },
    { path: 'b.bin', bytes: { length: 121 * 1024 * 1024 } },
  ]);
  assert.ok(projected > MAX_V6_ARCHIVE_BYTES);
});
function rootsFor(publicKey,keyId){const { validateTrustedPublisherRoots }=require('../../../services/plugins/package/trusted-publisher-roots');return validateTrustedPublisherRoots({trust_roots_schema_version:1,updated_at:'2026-08-09T00:00:00Z',publishers:[{publisher_id:'jenny-official',current_key_id:keyId,established_at:'2026-08-09T00:00:00Z',keys:[{key_id:keyId,fingerprint:`SHA256:${Buffer.from(keyId,'hex').toString('base64')}`,algorithm:'ed25519',public_key_spki_der_base64:publicKey.export({format:'der',type:'spki'}).toString('base64'),status:'active',added_at:'2026-08-09T00:00:00Z'}]}]});}
test('V6 conformance packager creates four unique full-host contributions and verifies signature', async (t) => {
  const { createStage8UnsignedFixture, finalizeStage8Package } = await import('../../../scripts/plugins/jenny-plugin-v6-packager.mjs');
  const provenanceBytes=Buffer.from('{"source_commit":"committed"}\n','utf8');
  const fixture = createStage8UnsignedFixture({ binaryBytes: Buffer.from('synthetic-executable'),
    platform: 'win32',provenanceBytes });
  assert.deepEqual(fixture.manifest.contributions.map((item) => item.kind), ['native_mcp','session_provider','engine_adapter','hook']);
  assert.equal(new Set(fixture.manifest.contributions.map((item) => item.executable_path)).size, 4);
  assert.equal(fixture.signedEntries.some((entry)=>entry.path==='META-JENNY/provenance.json'),true);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = crypto.createHash('sha256').update(publicKey.export({format:'der',type:'spki'})).digest('hex');
  const result = finalizeStage8Package({ fixture, keyId, publicKey,
    signature: crypto.sign(null, fixture.canonicalBytes, privateKey) });
  assert.ok(result.bytes.length > fixture.canonicalBytes.length); assert.match(result.sha256, /^[0-9a-f]{64}$/);
  const { verifyLocalPackage } = require('../../../services/plugins/package/local-package-intake');
  const roots = rootsFor(publicKey,keyId);
  assert.equal(roots.ok,true,roots.reason);
  const admitted = await verifyLocalPackage({bytes:result.bytes,sourcePathDigest:'a'.repeat(64),trustRoots:roots,now:'2026-08-09T00:00:00Z'});
  assert.equal(admitted.ok,true,admitted.reason); assert.equal(admitted.full_host_contents.length,4);
  assert.equal(admitted.full_host_contents[0].build_provenance_digest,digest(provenanceBytes));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stage8-production-intake-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packagePath = path.join(directory, 'stage8-conformance.jenny-plugin');
  fs.writeFileSync(packagePath, result.bytes);
  const { verifyStage8ConformancePackage } = await import(
    '../../../scripts/plugins/verify-stage8-conformance-package.mjs'
  );
  assert.deepEqual(await verifyStage8ConformancePackage({ packagePath, trustRoots: roots,
    now: '2026-08-09T00:00:00Z' }), { sha256: result.sha256, contributionCount: 4 });
});

test('local image finalization rejects stored entry bytes changed after signing', async (t) => {
  const { createV6UnsignedPackage } = await import(
    '../../../scripts/plugins/jenny-plugin-v6-packager.mjs'
  );
  const { finalizeLocalImageGeneration } = await import(
    '../../../scripts/plugins/finalize-local-image-generation-package.mjs'
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-local-image-finalize-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = createV6UnsignedPackage({
    manifest: { manifest_schema_version: 6, publisher_id: 'jenny-official',
      plugin_id: 'local-image-generation', name: 'Local Image Generation', version: '1.0.0',
      contributions: [], dependencies: [], requested_permissions: [] },
    entries: [{ path: 'payload.bin', bytes: Buffer.from('signed-entry', 'utf8') }],
  });
  const stored = { manifest: fixture.manifest, signed_payload: fixture.signedPayload,
    entries: fixture.signedEntries.map((entry) => ({ path: entry.path,
      bytes_base64: entry.bytes.toString('base64') })) };
  stored.entries.find((entry) => entry.path === 'payload.bin').bytes_base64 =
    Buffer.from('mutated-entry', 'utf8').toString('base64');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = digest(publicKey.export({ format: 'der', type: 'spki' }));
  fs.writeFileSync(path.join(directory, 'unsigned-fixture.json'), JSON.stringify(stored));
  fs.writeFileSync(path.join(directory, 'signing-request.json'), JSON.stringify({
    publisher_id: 'jenny-official', plugin_id: 'local-image-generation',
    canonical_payload_base64: fixture.canonicalBytes.toString('base64'),
    canonical_payload_sha256: digest(fixture.canonicalBytes),
  }));
  const signaturePath = path.join(directory, 'signature.json');
  fs.writeFileSync(signaturePath, JSON.stringify({ key_id: keyId,
    public_key_spki_der_base64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    signature_base64: crypto.sign(null, fixture.canonicalBytes, privateKey).toString('base64') }));
  const rootsPath = path.join(directory, 'trusted-publishers.json');
  fs.writeFileSync(rootsPath, JSON.stringify(rootsFor(publicKey, keyId).value));
  const output = path.join(directory, 'local-image-generation.jenny-plugin');

  assert.throws(() => finalizeLocalImageGeneration({
    kit: directory, signaturePath, output, rootsPath,
  }), /local_image_stored_entries_mismatch/);
  assert.equal(fs.existsSync(output), false);
});

test('Stage 8 finalization rejects stored entry bytes changed after request signing', async (t) => {
  const { createStage8UnsignedFixture } = await import(
    '../../../scripts/plugins/jenny-plugin-v6-packager.mjs'
  );
  const finalizer = await import(
    '../../../scripts/plugins/finalize-stage8-signed-conformance-package.mjs'
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stage8-finalize-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = createStage8UnsignedFixture({
    binaryBytes: Buffer.from('signed-stage8-executable', 'utf8'), platform: 'win32',
  });
  const stored = { manifest: fixture.manifest, signed_payload: fixture.signedPayload,
    entries: fixture.signedEntries.map((entry) => ({ path: entry.path,
      bytes_base64: entry.bytes.toString('base64') })) };
  stored.entries.find((entry) => entry.path.startsWith('host/')).bytes_base64 =
    Buffer.from('mutated-stage8-executable', 'utf8').toString('base64');
  fs.writeFileSync(path.join(directory, 'unsigned-fixture.json'), JSON.stringify(stored));
  fs.writeFileSync(path.join(directory, 'signing-request.json'), JSON.stringify({
    canonical_payload_base64: fixture.canonicalBytes.toString('base64'),
    canonical_payload_sha256: digest(fixture.canonicalBytes),
  }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = digest(publicBytes);
  const signaturePath = path.join(directory, 'signature.json');
  fs.writeFileSync(signaturePath, JSON.stringify({ key_id: keyId,
    public_key_spki_der_base64: publicBytes.toString('base64'),
    signature_base64: crypto.sign(null, fixture.canonicalBytes, privateKey).toString('base64') }));
  const trustedRootsPath = path.resolve(
    __dirname, '../../../config/plugins/trusted-publishers.json'
  );
  const trustedRoots = JSON.stringify(rootsFor(publicKey, keyId).value);
  const output = path.join(directory, 'stage8-conformance.jenny-plugin');
  const originalReadFileSync = fs.readFileSync;
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalStderrWrite = process.stderr.write;
  fs.readFileSync = (filePath, options) => path.resolve(filePath) === trustedRootsPath
    ? trustedRoots : originalReadFileSync(filePath, options);
  process.argv = [process.execPath, 'finalize-stage8-signed-conformance-package.mjs',
    '--kit', directory, '--signature', signaturePath, '--output', output];
  process.exitCode = undefined;
  process.stderr.write = () => true;
  try {
    finalizer.main();
    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.readFileSync = originalReadFileSync;
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.stderr.write = originalStderrWrite;
  }
});

test('V6 admits a mixed privileged and legacy declarative package on both intake paths',async()=>{
  const { createStage8UnsignedFixture,finalizeStage8Package }=await import('../../../scripts/plugins/jenny-plugin-v6-packager.mjs');
  const base=createStage8UnsignedFixture({binaryBytes:Buffer.from('synthetic-executable'),platform:'win32'});
  const content={content_schema_version:1,publisher_id:'jenny-official',plugin_id:'stage8-conformance',
    contribution_id:'legacy_skill',payload:{kind:'skill',instructions:'Use the verified V6 skill.'}};
  const contentBytes=Buffer.from(`${JSON.stringify(content)}\n`,'utf8');
  const panelAssetBytes=Buffer.from('<!doctype html><title>Mixed V6 panel</title>','utf8');
  const panelContent={content_schema_version:5,view_kind:'panel',entry_path:'views/panel.html',
    entry_sha256:digest(panelAssetBytes),assets:[{path:'views/panel.html',
      sha256:digest(panelAssetBytes),media_type:'text/html',bytes:panelAssetBytes.length}],
    allowed_bridge_operations:[],allowed_event_topics:[],artifact_kinds:[],provider_ref:''};
  const panelContentBytes=Buffer.from(`${JSON.stringify(panelContent)}\n`,'utf8');
  const manifest={...base.manifest,contributions:[...base.manifest.contributions,{kind:'skill',
    contribution_id:'legacy_skill',name:'Legacy skill',content_path:'content/legacy_skill.json',
    content_sha256:digest(contentBytes)},{kind:'panel',contribution_id:'mixed_panel',
    name:'Mixed panel',content_path:'content/mixed_panel.json',
    content_sha256:digest(panelContentBytes)}]};
  const signedEntries=[{path:'plugin.json',bytes:Buffer.from(`${JSON.stringify(manifest)}\n`,'utf8')},
    ...base.signedEntries.slice(1),{path:'content/legacy_skill.json',bytes:contentBytes},
    {path:'content/mixed_panel.json',bytes:panelContentBytes},
    {path:'views/panel.html',bytes:panelAssetBytes}];
  const signedPayload={...base.signedPayload,entries:signedEntries.map((entry)=>({path:entry.path,
    sha256:digest(entry.bytes)})).sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)))};
  const fixture={manifest,signedEntries,signedPayload,canonicalBytes:Buffer.from(stable(signedPayload),'utf8')};
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
  const keyId=digest(publicKey.export({format:'der',type:'spki'})); const roots=rootsFor(publicKey,keyId);
  const packaged=finalizeStage8Package({fixture,keyId,publicKey,
    signature:crypto.sign(null,fixture.canonicalBytes,privateKey)});
  const {verifyLocalPackage}=require('../../../services/plugins/package/local-package-intake');
  const local=await verifyLocalPackage({bytes:packaged.bytes,sourcePathDigest:'a'.repeat(64),
    trustRoots:roots,now:'2026-08-09T00:00:00Z'});
  assert.equal(local.ok,true,JSON.stringify(local)); assert.equal(local.declarative_contents.length,6);
  assert.equal(local.full_host_contents.length,4);
  assert.equal(local.view_asset_bytes.some((item)=>item.path==='views/panel.html'),true);
  const distributed=await verifyDistributionPackage({bytes:packaged.bytes,
    sourceIdentity:{kind:'local_package',package_path_digest:'a'.repeat(64)},trustRoots:roots,
    verificationCacheKey:'b'.repeat(64),now:'2026-08-09T00:00:00Z'});
  assert.equal(distributed.ok,true,JSON.stringify(distributed));
  assert.equal(distributed.declarative_contents.some((item)=>item.payload?.kind==='skill'),true);
  assert.equal(distributed.full_host_contents.length,4);
  assert.equal(distributed.view_asset_bytes.some((item)=>item.path==='views/panel.html'),true);
  const facade=createMemoryFsFacade(); const stored=await putContent(facade,'store',packaged.bytes);
  assert.equal((await writePackageRecord(facade,'store',{digest:stored.digest,
    record:distributed.package_record})).ok,true);
  const graph='c'.repeat(64); const compiled=await compileCurrentRuntimeSnapshot({facade,
    baseDir:'store',generation:{generation_schema_version:6,generation_id:'mixed-v6',graph_hash:graph,
      created_at:'2026-08-09T00:00:00Z',lock_digest:'d'.repeat(64),
      distribution_state_digest:'e'.repeat(64),policy_grant_ref:{policy_revision:1,
        policy_snapshot_digest:'1'.repeat(64),grant_set_digest:'2'.repeat(64),
        network_consent_digest:'3'.repeat(64),restricted_runtime_policy_digest:'4'.repeat(64),
        view_policy_digest:'5'.repeat(64),provider_policy_digest:'6'.repeat(64),
        privileged_runtime_policy_digest:'7'.repeat(64),secret_delivery_policy_digest:'8'.repeat(64),
        hook_policy_digest:'9'.repeat(64)},plugins:[{publisher_id:distributed.publisher_id,
        plugin_id:distributed.plugin_id,display_name:distributed.display_name,
        resolved_version:distributed.version,publisher_key_id:distributed.publisher_key_id,
        artifact_digest:stored.digest,desired_state:'active',effective_state:'active',depends_on:[]}]},
    pointer:{revision:1,commit_epoch:1,generation_id:'mixed-v6',generation_digest:graph},
    verifyPackage:async()=>distributed,now:'2026-08-09T00:00:00Z',
    compilePrivileged:async()=>({ok:true})});
  assert.equal(compiled.ok,true,JSON.stringify(compiled));
  assert.equal(compiled.snapshot.runtime_schema_version,6);
  assert.equal(compiled.snapshot.declarative_content.length,1);
  assert.equal(compiled.snapshot.view_contributions.length,1);
});

test('external finalization binds the returned signing key to Jenny trusted roots', async () => {
  const { validateReturnedSignature } = await import(
    '../../../scripts/plugins/finalize-stage8-signed-conformance-package.mjs'
  );
  const roots = { publishers: [{ publisher_id: 'jenny-official', current_key_id: 'trusted',
    keys: [{ key_id: 'trusted', status: 'active', public_key_spki_der_base64: 'trusted-spki' }] }] };
  assert.deepEqual(validateReturnedSignature({
    key_id: 'trusted', public_key_spki_der_base64: 'trusted-spki',
    signature_base64: 'signature',
  }, roots), roots.publishers[0].keys[0]);
  assert.throws(() => validateReturnedSignature({
    key_id: 'attacker', public_key_spki_der_base64: 'attacker-spki', signature_base64: 'signature',
  }, roots), /stage8_signing_root_mismatch/);
  assert.throws(() => validateReturnedSignature({
    key_id: 'trusted', public_key_spki_der_base64: 'trusted-spki', signature_base64: 'signature',
    unexpected: true,
  }, roots), /stage8_signature_response_shape_invalid/);
});

test('standalone Stage 8 signer emits the exact public response without exposing key material', async (t) => {
  const signer = await import('../../../scripts/plugins/sign-stage8-conformance-request.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stage8-offline-signing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const signerBytes = fs.readFileSync(path.resolve(
    __dirname, '../../../scripts/plugins/sign-stage8-conformance-request.mjs'
  ));
  const canonicalBytes = Buffer.from('{"stage8":"conformance"}', 'utf8');
  const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(directory, 'signing-request.json'), `${JSON.stringify({
    signing_request_schema_version: 1, source_commit: 'a'.repeat(40),
    publisher_id: 'jenny-official', plugin_id: 'stage8-conformance',
    offline_signer_sha256: sha256(signerBytes),
    canonical_payload_base64: canonicalBytes.toString('base64'),
    canonical_payload_sha256: sha256(canonicalBytes),
  }, null, 2)}\n`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = sha256(publicBytes);
  fs.writeFileSync(path.join(directory, 'OWNER-KEY.pem'), privateKey.export({
    format: 'pem', type: 'pkcs8',
  }));
  const output = { text: '', write(value) { this.text += value; } };
  const response = await signer.runOfflineSigning({
    signingDirectory: directory, privateKeyName: 'OWNER-KEY.pem', signerBytes,
    expectedKeyId: keyId, expectedPublicKeySpkiDerBase64: publicBytes.toString('base64'),
    stdout: output,
  });
  assert.deepEqual(Object.keys(response), [
    'key_id', 'public_key_spki_der_base64', 'signature_base64',
  ]);
  assert.equal(crypto.verify(null, canonicalBytes, publicKey,
    Buffer.from(response.signature_base64, 'base64')), true);
  assert.equal(output.text, 'Stage 8 signature response: returned-stage8-signature.json\n');
  const persisted = fs.readFileSync(path.join(directory, 'returned-stage8-signature.json'), 'utf8');
  assert.equal(persisted.includes('PRIVATE KEY'), false);
  assert.equal(persisted.includes('stage8-conformance'), false);
  await assert.rejects(signer.runOfflineSigning({
    signingDirectory: directory, privateKeyName: 'OWNER-KEY.pem', signerBytes,
    expectedKeyId: keyId, expectedPublicKeySpkiDerBase64: publicBytes.toString('base64'),
    stdout: output,
  }), { code: 'output_exists' });
  const wrongKey = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => signer.signStage8Request({ request: JSON.parse(fs.readFileSync(
    path.join(directory, 'signing-request.json'), 'utf8'
  )), privateKey: wrongKey, signerBytes, expectedKeyId: keyId,
  expectedPublicKeySpkiDerBase64: publicBytes.toString('base64') }), { code: 'current_key_mismatch' });
});
