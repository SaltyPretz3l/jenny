'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { imagePoint, createSelection } = require('../renderer/features/renderer-image-selection');

test('image-space coordinates invert all quarter rotations, pan and zoom', () => {
  const width=1024,height=768,zoom=1.7,panX=34,panY=-71,rect={left:17,top:43,width:900,height:600};
  for(const rotation of [0,90,180,270]) for(const point of [[80,90],[512,384],[940,680]]) {
    const a=rotation*Math.PI/180,dx=point[0]-width/2,dy=point[1]-height/2;
    const x=rect.left+rect.width/2+panX+zoom*(dx*Math.cos(a)-dy*Math.sin(a));
    const y=rect.top+rect.height/2+panY+zoom*(dx*Math.sin(a)+dy*Math.cos(a));
    assert.deepEqual(imagePoint(x,y,{width,height,zoom,rotation,panX,panY,rect}),point);
  }
});
test('corners resize, keyboard changes geometry, and freehand data stays bounded', () => {
  const selection=createSelection();selection.choose('box',1000,1000);
  selection.start([750,750],1);selection.move([900,800]);selection.end();
  assert.deepEqual(selection.snapshot().points,[[250,250],[900,800]]);
  selection.nudge(-4,0,false,1000,1000);
  assert.deepEqual(selection.snapshot().points,[[246,250],[896,800]]);
  selection.choose('freehand',1000,1000);selection.start([0,0],1);
  for(let i=0;i<1000;i++)selection.move([i,100+i%200]);
  assert.ok(selection.snapshot().points.length<=128);
  selection.clear();assert.equal(selection.snapshot(),null);
});


test('switching shape retains bounds, reselect is inert, and Clear keeps the tool',()=>{
  const s=createSelection();s.choose('box',1000,1000);s.start([30,40],1);s.move([90,120]);s.end();
  const points=s.snapshot().points;s.choose('box',1000,1000);assert.deepEqual(s.snapshot().points,points);
  s.choose('ellipse',1000,1000);assert.deepEqual(s.snapshot().points,points);
  s.clear();assert.equal(s.mode(),'ellipse');assert.equal(s.snapshot(),null);
});

test('canvas allocation only changes with dimensions and no-region draws allocate no bitmap',()=>{
  const {draw}=require('../renderer/features/renderer-image-selection');let allocations=0;let w=0,h=0;
  const ctx={clearRect(){},beginPath(){},rect(){},stroke(){},fillRect(){}};
  const canvas={get width(){return w;},set width(x){allocations++;w=x;},get height(){return h;},set height(x){allocations++;h=x;},getContext:()=>ctx};
  draw(canvas,null,4096,4096);assert.equal(allocations,0);
  const region={kind:'box',points:[[0,0],[100,100]]};draw(canvas,region,4096,4096);assert.equal(allocations,2);
  for(let i=0;i<100;i++)draw(canvas,region,4096,4096,1+i/10);assert.equal(allocations,2);
  draw(canvas,null,4096,4096);assert.equal(w*h,0);
});
