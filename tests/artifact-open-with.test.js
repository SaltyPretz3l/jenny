'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createArtifactOpenWith, systemPowerShellPath, fixedHelperPath } = require('../services/artifact-open-with');
const { createArtifactFileActions } = require('../services/artifact-file-actions');
const { ArtifactWorkspaceService } = require('../services/artifact-workspace-service');
const { ARTIFACT_ERROR_CODES } = require('../services/artifact-workspace-errors');
const { linkDirectory, windowsOnly } = require('./helpers/platform-skips');

test('packaged chooser uses the explicitly unpacked fixed helper', () => {
  assert.match(fixedHelperPath('C:\\Jenny\\resources\\app.asar\\services'), /app\.asar\.unpacked[\\/]services[\\/]artifact-open-with-win32\.ps1$/);
  const config = require('js-yaml').load(fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf8'));
  assert.ok(config.asarUnpack.includes('services/artifact-open-with-win32.ps1'));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}


function adapterFixture(options={}) {
  const child=fakeChild();const calls=[];
  const adapter=createArtifactOpenWith({platform:'win32',fsImpl:{existsSync:()=>true},
    spawnImpl:(...args)=>{calls.push(args);queueMicrotask(()=>child.stdout.write('{"event":"ready"}\n'));return child;},...options});
  return {child,calls,adapter};
}

test('persistent STA helper passes paths and parent HWND as data, serializes dialogs and disposes',async(t)=>{
  const f=adapterFixture();t.after(()=>f.adapter.dispose());let input='';f.child.stdin.on('data',x=>input+=x);
  assert.deepEqual(await f.adapter.capabilities(),{openWith:true});
  const request=f.adapter.openWith("C:\\images\\$(whoami); & ' sample.png",'1234');
  assert.deepEqual(await f.adapter.openWith('C:\\other.png'),{ok:false,reason:'open_with_busy'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(JSON.parse(input),{path:"C:\\images\\$(whoami); & ' sample.png",parent:'1234'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][2].shell,false);assert.ok(f.calls[0][1].includes('-STA'));
  assert.equal(f.calls[0][1].some(x=>x.includes('whoami')),false);
  f.child.stdout.write('{"ok":false,"canceled":true}\n');assert.deepEqual(await request,{ok:false,canceled:true});
  const again=f.adapter.openWith('C:\\image.png');await new Promise(resolve=>setImmediate(resolve));
  f.child.stdout.write('{"ok":true}\n');assert.deepEqual(await again,{ok:true});assert.equal(f.calls.length,1);
  const pending=f.adapter.openWith('C:\\image.png');await new Promise(resolve=>setImmediate(resolve));f.adapter.dispose();
  assert.equal((await pending).ok,false);assert.equal(f.child.killed,true);
});

test('helper spawns with ExecutionPolicy Bypass so stock Restricted/AllSigned policy cannot block it',async(t)=>{
  const f=adapterFixture();t.after(()=>f.adapter.dispose());
  assert.deepEqual(await f.adapter.capabilities(),{openWith:true});
  const args=f.calls[0][1];
  assert.deepEqual(args,['-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',fixedHelperPath()]);
});

test('capabilities fail closed for missing helper, policy/startup failure, disposal and other platforms',async()=>{
  for(const options of [{platform:'linux'},{platform:'darwin'},{fsImpl:{existsSync:()=>false}},{spawnImpl:()=>{throw new Error('policy');}}]){
    const f=adapterFixture(options);assert.deepEqual(await f.adapter.capabilities(),{openWith:false});f.adapter.dispose();
  }
  const child=fakeChild();const adapter=createArtifactOpenWith({platform:'win32',fsImpl:{existsSync:()=>true},spawnImpl:()=>child,startupTimeoutMs:10});
  const result=await Promise.all([adapter.capabilities(),new Promise(resolve=>setTimeout(resolve,20))]);
  assert.equal(result[0].openWith,false);assert.equal(child.killed,true);adapter.dispose();
  assert.throws(()=>systemPowerShellPath('relative'),/invalid_system_root/);
});

test('interaction timeout kills the helper and never exposes native path diagnostics',async(t)=>{
  const f=adapterFixture({interactionTimeoutMs:10});t.after(()=>f.adapter.dispose());
  const result=await Promise.all([f.adapter.openWith('C:\\image.png'),new Promise(resolve=>setTimeout(resolve,30))]);
  assert.deepEqual(result[0],{ok:false,reason:'open_with_timeout'});assert.equal(f.child.killed,true);
});

test('real Windows helper compiles and reports readiness without displaying a chooser', { skip: windowsOnly('compiles the C# open-with helper via PowerShell') },async(t)=>{
  const adapter=createArtifactOpenWith();t.after(()=>adapter.dispose());
  assert.deepEqual(await adapter.capabilities(),{openWith:true});
});

test('helper has parented one-off execution and constrained-language refusal',()=>{
  const helper=fs.readFileSync(path.join(__dirname,'../services/artifact-open-with-win32.ps1'),'utf8');
  assert.match(helper,/SHOpenWithDialog\(\$parent/);assert.match(helper,/\$info\.Flags = 4/);
  assert.match(helper,/FullLanguage/);assert.match(helper,/ReadLine/);assert.doesNotMatch(helper,/Invoke-Expression|Start-Process|OAIF_REGISTER_EXT/);
});

test('Open with preserves real service session authority and junction containment before native launch', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jenny-openwith-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const metadata = new Map();
  const service = new ArtifactWorkspaceService({ configService: { getState: () => ({ toolsWorkspaceRoot: root }) },
    sessionMessageReader: (id) => [{ tool_result: { generated_artifacts: metadata.has(id) ? [metadata.get(id)] : [] } }] });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=', 'base64');
  for (const id of ['session-a', 'session-b']) {
    const created = await service.createBinaryArtifact(id, { artifact_kind: 'image', mime_type: 'image/png', file_name: 'image.png', content: png });
    metadata.set(id, created.metadata);
  }
  let opened = 0;
  const actions = createArtifactFileActions({ artifactService: service,
    openWithAdapter: { capabilities: () => ({ openWith: true }), openWith: async () => { opened += 1; return { ok: true }; } } });
  assert.deepEqual(await actions.openWith('session-a', metadata.get('session-a').artifact_id), { ok: true });
  await assert.rejects(actions.openWith('session-b', metadata.get('session-a').artifact_id), { code: ARTIFACT_ERROR_CODES.NOT_FOUND });
  const scratchA = await service.getSessionScratchDir('session-a');
  const scratchB = await service.getSessionScratchDir('session-b');
  await fs.promises.rm(scratchA, { recursive: true });
  linkDirectory(scratchB, scratchA);
  await assert.rejects(actions.openWith('session-a', metadata.get('session-a').artifact_id), { code: ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES });
  assert.equal(opened, 1);
});


test('native chooser receives the live Jenny HWND and raster actions reject executable-like image metadata',async()=>{
  const handle=Buffer.alloc(8);handle.writeBigUInt64LE(123456n);let parent;
  const actions=createArtifactFileActions({artifactService:{resolveArtifact:async()=>({status:'available',artifact_kind:'image',mime_type:'image/png',absolute_path:'C:/image.png'})},
    getMainWindow:()=>({isDestroyed:()=>false,getNativeWindowHandle:()=>handle}),openWithAdapter:{capabilities:()=>({openWith:true}),openWith:async(_,hwnd)=>{parent=hwnd;return {ok:true};}}});
  assert.equal((await actions.openWith('s','a')).ok,true);assert.equal(parent,'123456');
  const service=new ArtifactWorkspaceService({});
  for(const ext of ['pif','py','msc','html','svg']) assert.throws(()=>service._assertArtifactCanExternalAction({status:'available',artifact_kind:'image',file_name:'image.'+ext,absolute_path:'C:/image.'+ext,mime_type:'image/png'},'opened'));
});


test('external open and reveal enforce raster metadata through the real session service', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jenny-raster-actions-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  let metadata; const opened = []; const revealed = [];
  const service = new ArtifactWorkspaceService({
    configService: { getState: () => ({ toolsWorkspaceRoot: root }) },
    sessionMessageReader: () => [{ tool_result: { generated_artifacts: [metadata] } }],
    openPathImpl: async value => { opened.push(value); return ''; },
    showItemInFolderImpl: value => { revealed.push(value); },
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=', 'base64');
  metadata = (await service.createBinaryArtifact('session-safe', {
    artifact_kind: 'image', mime_type: 'image/png', file_name: 'image.png', content: png,
  })).metadata;
  await service.openArtifactExternal('session-safe', metadata.artifact_id);
  await service.revealArtifact('session-safe', metadata.artifact_id);
  assert.deepEqual(opened, [metadata.absolute_path]);
  assert.deepEqual(revealed, [metadata.absolute_path]);
  const original = metadata;
  for (const extension of ['pif', 'py', 'msc', 'html', 'svg']) {
    const filename = 'image.' + extension;
    const target = path.join(path.dirname(original.absolute_path), filename);
    await fs.promises.writeFile(target, png);
    metadata = { ...original, file_name: filename, absolute_path: target,
      display_path: original.display_path.replace(/image\.png$/, filename) };
    await assert.rejects(service.openArtifactExternal('session-safe', metadata.artifact_id));
    await service.revealArtifact('session-safe', metadata.artifact_id); // reveal runs nothing
  }
  assert.equal(opened.length, 1); assert.equal(revealed.length, 6);
});
