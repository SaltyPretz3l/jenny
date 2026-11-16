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
  const ctx={clearRect(){},beginPath(){},rect(){},stroke(){},fillRect(){},save(){},restore(){},fill(){},arc(){},globalCompositeOperation:'source-over'};
  const canvas={get width(){return w;},set width(x){allocations++;w=x;},get height(){return h;},set height(x){allocations++;h=x;},getContext:()=>ctx};
  draw(canvas,null,4096,4096);assert.equal(allocations,0);
  const region={kind:'box',points:[[0,0],[100,100]]};draw(canvas,region,4096,4096);assert.equal(allocations,2);
  for(let i=0;i<100;i++)draw(canvas,region,4096,4096,1+i/10);assert.equal(allocations,2);
  draw(canvas,null,4096,4096);assert.equal(w*h,0);
});

test('a region dims the picture, cuts the region out and strokes a dark halo then white, with ringed handles',()=>{
  const {draw}=require('../renderer/features/renderer-image-selection');const log=[];let style='';let composite='source-over';
  const ctx={clearRect(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},rect(){log.push(['rect']);},save(){log.push(['save']);},restore(){log.push(['restore']);},
    fill(){log.push(['fill',composite]);},arc(...a){log.push(['arc',a[2]]);},fillRect(...a){log.push(['fillRect',style,a.join()]);},
    stroke(){log.push(['stroke',style,this.lineWidth]);},set fillStyle(v){style=v;},get fillStyle(){return style;},set strokeStyle(v){style=v;},get strokeStyle(){return style;},
    set globalCompositeOperation(v){composite=v;log.push(['composite',v]);},get globalCompositeOperation(){return composite;}};
  const canvas={width:0,height:0,getContext:()=>ctx};
  draw(canvas,{kind:'box',points:[[10,10],[60,50]]},100,80,2);
  assert.deepEqual(log[0],['fillRect','rgba(8, 10, 14, 0.55)','0,0,100,80'],'the dim comes first');
  assert.ok(log.some(e=>e[0]==='fill'&&e[1]==='destination-out'),'the region is cut out');
  const strokes=log.filter(e=>e[0]==='stroke');
  assert.deepEqual(strokes.slice(0,2),[['stroke','rgba(0, 0, 0, 0.55)',2],['stroke','#ffffff',0.75]],'halo first, white last');
  assert.deepEqual(log.filter(e=>e[0]==='arc').map(e=>e[1]),[3,3],'a white handle circle of 6 / zoom at each corner');
  assert.equal(strokes.length,4,'two handle rings after the outline');
  log.length=0;draw(canvas,{kind:'freehand',points:[[1,1],[20,5],[9,30]]},100,80,1);
  assert.equal(log.some(e=>e[0]==='arc'),false,'freehand has no handles');
});
