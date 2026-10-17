'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRegion, markRegion, readEditReference } = require('../services/image-edit-reference');
const { makeViewerPng } = require('./helpers/image-viewer-fixture');

test('region rejects unsupported shapes, excessive points, nonfinite and outside coordinates', () => {
  for (const region of [{kind:'script',points:[[1,1],[8,8]]}, {kind:'box',points:[[0,0],[Infinity,8]]},
    {kind:'box',points:[[-1,0],[8,8]]}, {kind:'box',points:[[0,0],[17,8]]},
    {kind:'freehand',points:Array.from({length:129},()=>[1,1])}, {kind:'box',points:[[1,1],[2,2]]}]) {
    assert.throws(()=>validateRegion(region,16,16));
  }
  assert.deepEqual(validateRegion({kind:'ellipse',points:[[1,1],[14,14]]},16,16).kind,'ellipse');
});

test('reference reads by session and ID, rejects corrupt images, and retains original bytes without selection', async () => {
  const bytes=makeViewerPng(16,16);const calls=[];
  const artifactService={async readArtifact(...args){calls.push(args);return {artifact:{artifact_kind:'image'},asset_data_url:'data:image/png;base64,'+bytes.toString('base64')}}};
  const nativeImage={createFromBuffer:()=>({isEmpty:()=>false,getSize:()=>({width:16,height:16})})};
  const result=await readEditReference({artifactService,sessionId:'one',artifactId:'image-one',nativeImage});
  assert.deepEqual(calls,[['one','image-one']]);assert.deepEqual(result.buffer,bytes);
  await assert.rejects(readEditReference({artifactService,sessionId:'one',artifactId:'../escape',nativeImage}));
  await assert.rejects(readEditReference({artifactService:{readArtifact:async()=>({artifact:{artifact_kind:'image'},asset_data_url:'data:image/png;base64,YQ=='})},sessionId:'one',artifactId:'image-one',nativeImage}));
});

test('guide draws only in a copy, preserving untouched alpha and source bitmap', () => {
  const source=Buffer.alloc(32*32*4,17);let rendered;
  const image={getSize:()=>({width:32,height:32}),toBitmap:()=>Buffer.from(source)};
  const nativeImage={createFromBitmap:(bytes)=>{rendered=bytes;return {toPNG:()=>bytes}}};
  markRegion(image,{kind:'box',points:[[8,8],[24,24]]},nativeImage);
  assert.equal(rendered[0],17);assert.equal(rendered[3],17);
  assert.deepEqual([...rendered.subarray((8*32+8)*4,(8*32+8)*4+4)],[255,0,255,255]);
  assert.equal(source.every(x=>x===17),true);
});


test('tool path validates and draws a region guide without altering source bytes',async(t)=>{
  const {fixture,FAMILY}=require('./helpers/image-generate-fixture');
  const {createImageGenerateTool}=require('../services/tools/builtin/image-generate-tool');
  const bytes=makeViewerPng(1024,1024);let marked;
  const nativeImage={createFromBuffer:()=>({isEmpty:()=>false,getSize:()=>({width:1024,height:1024}),toBitmap:()=>Buffer.alloc(1024*1024*4,17)}),
    createFromBitmap:buffer=>{marked=buffer;return {toPNG:()=>bytes};}};
  const fx=fixture(t,{readReference:options=>readEditReference({...options,nativeImage})});
  fx.paths.vision_projector='vision.gguf';fx.context.artifactService.readArtifact=async()=>({artifact:{artifact_kind:'image'},asset_data_url:'data:image/png;base64,'+bytes.toString('base64')});
  fx.dependencies.loadFamilies=()=>({families:{test_family:{...FAMILY,vision_flag:'--llm_vision'}}});
  const region={kind:'box',points:[[20,20],[300,300]]};
  const result=await createImageGenerateTool(fx.dependencies).execute({...fx.input,source_artifact_id:'original',region},fx.context);
  assert.equal(result.isError,false);assert.deepEqual(result.metadata.provenance.image_edit_region,region);
  assert.deepEqual([...marked.subarray((20*1024+20)*4,(20*1024+20)*4+4)],[255,0,255,255]);assert.equal(marked[3],17);
  const argv=fx.calls.find(([name])=>name==='run')[1].argv;assert.match(argv[argv.indexOf('-p')+1],/outlined in magenta/);
});
