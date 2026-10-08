'use strict';
const $=id=>document.getElementById(id);
const TAU=Math.PI*2;
const clamp=(x,a,b)=>x<a?a:(x>b?b:x);
const lerp=(a,b,t)=>a+(b-a)*t;

/* ------------------------------------------------------------------ */
/* đàn tranh string set: pentatonic (Do Re Mi Sol La), top string C6.
   Length / diameter / tension per string feed a physical inharmonicity
   coefficient B = pi^3 E d^4 / (64 T L^2); wound basses use a thin
   effective core diameter. */
function tranhSpecs(count){
  const steps=[0,2,4,7,9], midis=[];
  for(let oct=1;oct<=7;oct++) for(const s of steps) midis.push(12*oct+12+s);
  const top=midis.indexOf(84);
  const sel=midis.slice(top-count+1,top+1);
  return sel.map((m,i)=>{
    const f=440*Math.pow(2,(m-69)/12);
    const x=i/(count-1);
    const L=1.02-0.72*x;
    const dia=0.00080-0.00035*x;
    const rho=7850, mu=rho*Math.PI*dia*dia/4;
    const T=Math.pow(2*L*f,2)*mu;
    const dEff=f<180?dia*0.42:dia;
    const B=Math.pow(Math.PI,3)*2.0e11*Math.pow(dEff,4)/(64*T*L*L);
    const t60=clamp(9*Math.pow(150/f,0.55),1.8,10);
    return {f,B,t60,L,dia,T,midi:m};
  });
}
const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const noteName=m=>NOTE_NAMES[m%12]+(Math.floor(m/12)-1);

const TRANH_CODES=['KeyZ','KeyX','KeyC','KeyV','KeyB','KeyN','KeyM','Comma','Period','Slash',
  'KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL','Semicolon','Quote'];
const TRANH_LABELS=['Z','X','C','V','B','N','M',',','.','/','A','S','D','F','G','H','J','K','L',';','\''];

/* đàn bầu nodes actually used by players: ½ ⅓ ¼ ⅕ ⅙ ⅛ (1/7 is avoided);
   keys 7 and 0 play the open string */
const NODE_KEYS={Digit1:2,Digit2:3,Digit3:4,Digit4:5,Digit5:6,Digit6:8,Digit7:1,Digit0:1};
const NODE_NOTE={1:'C3',2:'C4',3:'G4',4:'C5',5:'E5',6:'G5',8:'C6'};

const state={
  inst:'bau',
  running:false,
  bau:{node:4,rodU:0,rodVis:0,rodVisV:0,grip:true,xCtl:0.57,strength:0.7,pos:0.13,
       rung:false,nhan:false,trem:false,bMod:false,roi:false,held:new Set(),resetSerial:0,
       fingerT:0,fingerFrac:0.75,mx:0.5,my:0.5},
  tranh:{count:16,specs:tranhSpecs(16),pluckPos:0.30,stiff:0.5,
         pressI:-1,pressCents:0,pressStartY:0,lastPluck:-1}
};

/* ------------------------------------------------------------------ */
let actx=null,node=null;
function send(m){ if(node) node.port.postMessage(m); }

async function startAudio(sr){
  if(actx){ try{ await actx.close(); }catch(e){} actx=null; node=null; }
  actx=new AudioContext({latencyHint:0,sampleRate:sr});
  await actx.audioWorklet.addModule('dsp-worklet.js?v=7');
  node=new AudioWorkletNode(actx,'vn-engine',
    {numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
  node.connect(actx.destination);
  await actx.resume();
  sendTranhCfg();
  $('lat').textContent='fs '+(actx.sampleRate/1000)+' kHz · latency ~'+
    Math.round((actx.baseLatency||0)*1000)+' ms';
}
function sendTranhCfg(){
  const sp=state.tranh.specs;
  send({t:'tranhCfg',count:sp.length,
    freqs:sp.map(s=>s.f), B:sp.map(s=>s.B), t60:sp.map(s=>s.t60)});
}

/* ------------------------------------------------------------------ */
function bauPluck(hold){
  const b=state.bau;
  const serial=b.resetSerial;
  const vel=clamp(b.strength*(0.9+Math.random()*0.2),0.05,1);
  setTimeout(function(){                 /* ±10 ms human timing scatter */
    send({t:'bauPluck',node:b.node,vel,pos:b.pos,hold:!!hold&&serial===b.resetSerial});
    b.fingerT=1;
    b.fingerFrac=b.node>1?1-1/b.node:0.30;
    const nn=Math.max(1,b.node);
    visBauPluck(1-Math.min(0.5,(0.28/nn)*(b.pos/0.13)),vel);
  },Math.random()*10);
}
function tranhPluck(i){
  const t=state.tranh;
  if(i<0||i>=t.count) return;
  const vel=clamp(0.72*(0.85+Math.random()*0.3),0.05,1);
  const stiff=t.stiff, angle=0.3;
  send({t:'tranhPluck',i,vel,pos:t.pluckPos,stiff,angle});
  t.lastPluck=i;
  visTranhPluck(i,t.pluckPos,vel);
}

/* ------------------------------------------------------------------ */
const cv=$('cv'); const ctx=cv.getContext('2d');
let W=0,H=0,DPR=1;
function resize(){
  DPR=Math.min(window.devicePixelRatio||1,2);
  W=window.innerWidth; H=window.innerHeight-52;
  cv.width=Math.round(W*DPR); cv.height=Math.round(H*DPR);
  cv.style.width=W+'px'; cv.style.height=H+'px';
  ctx.setTransform(DPR,0,0,DPR,0,0);
  buildLayouts(); buildBG();
}
window.addEventListener('resize',resize);

/* ---------------- input: keyboard ---------------- */
function centerRod(){
  if(state.inst!=='bau') return;
  const b=state.bau;
  b.resetSerial++;
  b.rodU=0; b.rodVisV=0; b.my=0.5; b.grip=true;
  b.rung=false; b.nhan=false; b.trem=false; b.bMod=false; b.roi=false;
  b.held.clear(); b.fingerT=0;
  rodDirty=false;
  send({t:'bauCenter'});
}
window.addEventListener('keydown',e=>{
  if(e.code==='Escape'&&state.inst==='bau'){
    e.preventDefault();
    if(!e.repeat) centerRod();
    return;
  }
  if(!state.running) return;
  if(e.code==='Space'){ e.preventDefault(); }
  if(state.inst==='bau'){
    const b=state.bau;
    if(NODE_KEYS[e.code]!==undefined){
      if(!e.repeat){
        const n=NODE_KEYS[e.code];
        b.node=n;
        if(b.bMod){                       /* ngón bội âm 2: silent retouch */
          send({t:'bauRetouch',node:n});
          b.fingerT=1; b.fingerFrac=n>1?1-1/n:0.30;
        }else{
          /* normal technique: the touch is released immediately after the
             pluck so the string rings. Only X (ngón rời) keeps contact. */
          if(b.roi) b.held.add(e.code);
          bauPluck(b.roi);
        }
      }
    }else if(e.code==='KeyB'){ b.bMod=true; }
    else if(e.code==='KeyX'){ b.roi=true; }
    else if(e.code==='KeyT'&&!e.repeat){ b.trem=true; send({t:'bauTrem',on:true}); }
    else if(e.code==='KeyG'&&!e.repeat){ send({t:'bauGiat'}); }
    else if(e.code==='KeyZ'&&!e.repeat){ b.grip=false; send({t:'bauGrip',on:false}); }
    else if(e.code==='Space'&&!e.repeat){
      b.rung=true; send({t:'bauG',g:'rung',on:true});
    }else if((e.code==='ShiftLeft'||e.code==='ShiftRight')&&!e.repeat){
      b.nhan=true; send({t:'bauG',g:'nhan',on:true});
    }else if(e.code==='KeyV'&&!e.repeat){
      send({t:'bauVo'}); visBauPluck(0.5,0.25); b.fingerT=1;
    }
  }else{
    const idx=TRANH_CODES.indexOf(e.code);
    if(idx>=0&&idx<state.tranh.count&&!e.repeat){ tranhPluck(idx); }
    else if(e.code==='ShiftLeft'||e.code==='ShiftRight'){ state.tranh.stiff=0.95; }
  }
});
window.addEventListener('keyup',e=>{
  if(state.inst==='bau'){
    const b=state.bau;
    if(NODE_KEYS[e.code]!==undefined){
      b.held.delete(e.code);
      if(b.held.size===0) send({t:'bauLift'});
    }else if(e.code==='KeyB'){ b.bMod=false; }
    else if(e.code==='KeyX'){
      b.roi=false;
      if(b.held.size){ b.held.clear(); send({t:'bauLift'}); }
    }
    else if(e.code==='KeyT'){ b.trem=false; send({t:'bauTrem',on:false}); }
    else if(e.code==='KeyZ'){ b.grip=true; send({t:'bauGrip',on:true}); }
    else if(e.code==='Space'){ b.rung=false; send({t:'bauG',g:'rung',on:false}); }
    else if(e.code==='ShiftLeft'||e.code==='ShiftRight'){
      b.nhan=false; send({t:'bauG',g:'nhan',on:false});
    }
  }else if(e.code==='ShiftLeft'||e.code==='ShiftRight'){ state.tranh.stiff=0.5; }
});
window.addEventListener('blur',()=>{
  const b=state.bau;
  if(b.rung){ b.rung=false; send({t:'bauG',g:'rung',on:false}); }
  if(b.nhan){ b.nhan=false; send({t:'bauG',g:'nhan',on:false}); }
  if(b.trem){ b.trem=false; send({t:'bauTrem',on:false}); }
  if(!b.grip){ b.grip=true; send({t:'bauGrip',on:true}); }
  if(b.held.size){ b.held.clear(); send({t:'bauLift'}); }
  b.bMod=false; b.roi=false;
  state.tranh.stiff=0.5;
  releaseTranhPress();
});

/* ---------------- input: mouse ---------------- */
let rodDirty=false;
cv.addEventListener('mousemove',e=>{
  const r=cv.getBoundingClientRect();
  const xN=clamp((e.clientX-r.left)/W,0,1), yN=clamp((e.clientY-r.top)/H,0,1);
  if(state.inst==='bau'){
    const b=state.bau;
    b.mx=xN; b.my=yN;
    /* mouse is the rod hand only; pluck strength/position live on the wheel */
    b.rodU=clamp((0.5-yN)*2.4,-1,1);
    rodDirty=true;
  }else{
    const t=state.tranh;
    if(t.pressI>=0){
      const dy=(e.clientY-r.top)-t.pressStartY;
      t.pressCents=clamp(dy*2.0,0,340);
      send({t:'tranhPress',i:t.pressI,cents:t.pressCents});
    }
  }
});
cv.addEventListener('mouseleave',()=>{
  /* hand off the rod: ease back to neutral so a parked cursor can't
     leave everything silently detuned */
  if(state.inst==='bau'){ state.bau.rodU=0; rodDirty=true; }
});
cv.addEventListener('mousedown',e=>{
  if(!state.running) return;
  const r=cv.getBoundingClientRect();
  const y=e.clientY-r.top;
  if(state.inst==='bau'){ bauPluck(); }
  else{
    const i=nearestTranhString(y);
    if(i>=0){
      const t=state.tranh;
      t.pressI=i; t.pressStartY=y; t.pressCents=0;
      t.lastPluck=i;
    }
  }
});
window.addEventListener('mouseup',()=>{ releaseTranhPress(); });
function releaseTranhPress(){
  const t=state.tranh;
  if(t.pressI>=0){
    send({t:'tranhPress',i:t.pressI,cents:0});
    t.pressI=-1; t.pressCents=0;
  }
}
cv.addEventListener('dblclick',e=>{
  if(state.inst==='tranh'){
    const r=cv.getBoundingClientRect();
    const i=nearestTranhString(e.clientY-r.top);
    if(i>=0) send({t:'tranhVo',i});
  }
});
cv.addEventListener('wheel',e=>{
  e.preventDefault();
  if(state.inst==='bau'){
    /* scroll up = harder pluck, closer to the bridge (louder + brighter) */
    const b=state.bau;
    b.xCtl=clamp(b.xCtl-e.deltaY*0.0006,0,1);
    b.strength=0.30+0.70*b.xCtl;
    b.pos=0.20-0.14*b.xCtl;
  }else{
    const t=state.tranh;
    t.pluckPos=clamp(t.pluckPos+e.deltaY*0.0004,0.08,0.5);
  }
},{passive:false});
cv.addEventListener('contextmenu',e=>e.preventDefault());

/* ---------------- UI chrome ---------------- */
function setInst(which){
  state.inst=which;
  $('tabBau').classList.toggle('on',which==='bau');
  $('tabTranh').classList.toggle('on',which==='tranh');
  $('selCount').style.visibility=which==='tranh'?'visible':'hidden';
  $('centerRod').hidden=which!=='bau';
  releaseTranhPress();
  buildBG(); updateHelp();
}
$('tabBau').onclick=()=>setInst('bau');
$('tabTranh').onclick=()=>setInst('tranh');
$('centerRod').onclick=centerRod;
$('selCount').onchange=()=>{
  const c=parseInt($('selCount').value,10);
  state.tranh.count=c;
  state.tranh.specs=tranhSpecs(c);
  sendTranhCfg();
  buildLayouts(); buildBG(); buildTranhVis();
};
$('selSR').onchange=async()=>{
  if(!state.running) return;
  try{ await startAudio(parseInt($('selSR').value,10)); }
  catch(err){ $('lat').textContent='SR switch failed: '+err.message; }
};
function updateHelp(){
  const h=$('help');
  if(state.inst==='bau'){
    h.innerHTML='<h3>Đàn Bầu</h3>'+
      '<kbd>1</kbd>–<kbd>6</kbd> bồi âm C4 G4 C5 E5 G5 C6 &nbsp;·&nbsp; '+
      '<kbd>7</kbd>/<kbd>0</kbd> dây buông C3 &nbsp;·&nbsp; <kbd>click</kbd> gảy lại<br>'+
      '<kbd>X</kbd>+phím = ngón rời (staccato) &nbsp;·&nbsp; <kbd>B</kbd>+phím = bội âm 2 (retouch)<br>'+
      '<kbd>T</kbd> ngón vé (tremolo) &nbsp;·&nbsp; <kbd>G</kbd> giật &nbsp;·&nbsp; '+
      '<kbd>Z</kbd> thả cần (release rod)<br>'+
      'chuột <b>dọc</b>: cần đàn &nbsp;·&nbsp; <b>lăn chuột</b>: lực &amp; vị trí gảy<br>'+
      '<kbd>Space</kbd> rung &nbsp;·&nbsp; <kbd>Shift</kbd> nhấn &nbsp;·&nbsp; <kbd>V</kbd> vỗ<br>'+
      '<kbd>Esc</kbd> Center rod — về cao độ gốc, dừng kỹ thuật';
  }else{
    h.innerHTML='<h3>Đàn Tranh</h3>'+
      'phím <kbd>Z</kbd>…<kbd>/</kbd> rồi <kbd>A</kbd>…<kbd>\'</kbd> gảy dây (thấp → cao)<br>'+
      '<b>kéo chuột xuống</b> trên dây: nhấn/vuốt sau nhạn (bend, microtonal)<br>'+
      '<b>lăn chuột</b>: vị trí gảy &nbsp;·&nbsp; <kbd>Shift</kbd> móng cứng &nbsp;·&nbsp; '+
      '<b>double-click</b> vỗ chặn dây';
  }
}

/* ---------------- boot ---------------- */
$('overlay').addEventListener('click',async()=>{
  if(state.running) return;
  try{
    await startAudio(parseInt($('selSR').value,10));
    state.running=true;
    $('overlay').style.display='none';
    setInst('bau');
  }catch(err){
    $('err').textContent='Không khởi động được audio engine:\n'+err.message+
      '\n(Hãy thử Chrome/Edge mới nhất.)';
  }
});
/* ==================================================================
   VISUAL PHYSICS — finite-difference string (traveling waves,
   reflections, decay), separate from the audio waveguide.
================================================================== */
class VString{
  constructor(n){
    this.n=n;
    this.y=new Float32Array(n); this.yp=new Float32Array(n);
    this.tmp=new Float32Array(n);
    this.c2=0.46; this.damp=0.0007;
    this.env=0; this.fingerAt=-1; this.fingerAmt=0;
  }
  pluck(frac,amp){
    const n=this.n, c=clamp(Math.round(frac*(n-1)),2,n-3);
    const w=Math.max(2.2,n*0.045);
    for(let i=1;i<n-1;i++){
      const d=(i-c)/w, add=amp*Math.exp(-d*d);
      this.y[i]+=add; this.yp[i]+=add;
    }
    this.env=Math.max(this.env,amp*0.35);
  }
  step(){
    const y=this.y,yp=this.yp,t=this.tmp,n=this.n,c2=this.c2;
    let e=0;
    const fA=this.fingerAt,fM=this.fingerAmt;
    for(let i=1;i<n-1;i++){
      const lap=y[i-1]-2*y[i]+y[i+1];
      let d=this.damp;
      if(fM>0.001 && i>fA-3 && i<fA+3) d+=fM;
      const v=(y[i]-yp[i])*(1-d);
      t[i]=y[i]+v+c2*lap;
      e+=v*v;
    }
    t[0]=0; t[n-1]=0;
    const o=this.yp; this.yp=this.y; this.y=this.tmp; this.tmp=o;
    this.env=0.96*this.env+0.04*Math.sqrt(e/n)*10;
    if(fM>0.001) this.fingerAmt*=0.975;
  }
}
const bauV=new VString(120);
let tranhV=[];
function buildTranhVis(){
  tranhV=[]; for(let i=0;i<state.tranh.count;i++) tranhV.push(new VString(72));
}
buildTranhVis();
function visBauPluck(frac,vel){
  bauV.pluck(frac,vel*1.1);
  bauV.fingerAt=Math.round(state.bau.fingerFrac*(bauV.n-1));
  bauV.fingerAmt=0.06;
}
function visTranhPluck(i,pos,vel){ if(tranhV[i]) tranhV[i].pluck(1-pos,vel*1.1); }

/* ---------------- layouts ---------------- */
let bauL=null, tranhL=null;
function buildLayouts(){
  bauL={
    bodyX0:W*0.13, bodyX1:W*0.955, bodyTop:H*0.50, bodyBot:H*0.74,
    sy:H*0.40, rodX:W*0.155, rodTopY:H*0.13, bridgeX:W*0.925
  };
  const c=state.tranh.count, ys=[], bx=[];
  const x0=W*0.09, x1=W*0.93, yT=H*0.17, yB=H*0.88;
  for(let i=0;i<c;i++){
    const t=c>1?i/(c-1):0;
    ys.push(lerp(yT,yB,t));
    bx.push(x0+(x1-x0)*(0.18+0.36*t));
  }
  tranhL={x0,x1,yT,yB,ys,bx,pinX:x1-46,nutX:x0+16};
}
function nearestTranhString(y){
  const L=tranhL; if(!L) return -1;
  const sp=(L.yB-L.yT)/Math.max(1,state.tranh.count-1);
  let best=-1,bd=1e9;
  for(let i=0;i<L.ys.length;i++){
    const d=Math.abs(y-L.ys[i]);
    if(d<bd){ bd=d; best=i; }
  }
  return bd<Math.max(10,sp*0.55)?best:-1;
}

/* ---------------- backgrounds: wood, lacquer, brass ---------------- */
function woodFill(g,x,y,w,h,c1,c2,grainRGBA,nGrain,rnd){
  const gr=g.createLinearGradient(x,y,x,y+h);
  gr.addColorStop(0,c1); gr.addColorStop(0.5,c2); gr.addColorStop(1,c1);
  g.fillStyle=gr; g.fillRect(x,y,w,h);
  g.save(); g.beginPath(); g.rect(x,y,w,h); g.clip();
  for(let k=0;k<nGrain;k++){
    const yy=y+rnd()*h;
    g.beginPath();
    let px=x, py=yy;
    g.moveTo(px,py);
    const seg=10+rnd()*14;
    while(px<x+w){
      px+=seg*(0.7+rnd()*0.6);
      py+=(rnd()-0.5)*3.2;
      g.lineTo(px,py);
    }
    g.strokeStyle=grainRGBA;
    g.lineWidth=0.5+rnd()*1.5;
    g.globalAlpha=0.35+rnd()*0.5;
    g.stroke();
  }
  g.globalAlpha=1;
  for(let k=0;k<Math.floor(nGrain/28);k++){
    const kx=x+rnd()*w, ky=y+rnd()*h, kr=3+rnd()*7;
    const kg=g.createRadialGradient(kx,ky,0.5,kx,ky,kr);
    kg.addColorStop(0,'rgba(30,16,6,0.5)');
    kg.addColorStop(1,'rgba(30,16,6,0)');
    g.fillStyle=kg; g.beginPath(); g.arc(kx,ky,kr,0,TAU); g.fill();
  }
  const sh=g.createLinearGradient(x,y,x+w*0.7,y+h);
  sh.addColorStop(0,'rgba(255,240,200,0.10)');
  sh.addColorStop(0.4,'rgba(255,240,200,0.02)');
  sh.addColorStop(1,'rgba(0,0,0,0.14)');
  g.fillStyle=sh; g.fillRect(x,y,w,h);
  g.restore();
}
function mulberry(seed){
  let a=seed>>>0;
  return function(){
    a|=0; a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  };
}
function roomBG(g){
  const rg=g.createRadialGradient(W*0.5,H*0.35,H*0.1,W*0.5,H*0.5,H*1.1);
  rg.addColorStop(0,'#2a2216'); rg.addColorStop(1,'#0d0b08');
  g.fillStyle=rg; g.fillRect(0,0,W,H);
}
let bgBau=null,bgTranh=null;
function buildBG(){
  if(!W||!H) return;
  /* --- đàn bầu: long black-lacquered box, gold trim --- */
  bgBau=document.createElement('canvas');
  bgBau.width=Math.round(W*DPR); bgBau.height=Math.round(H*DPR);
  let g=bgBau.getContext('2d'); g.setTransform(DPR,0,0,DPR,0,0);
  roomBG(g);
  const B=bauL, rnd=mulberry(1234);
  g.fillStyle='rgba(0,0,0,0.5)';
  g.beginPath(); g.ellipse((B.bodyX0+B.bodyX1)/2,B.bodyBot+18,(B.bodyX1-B.bodyX0)*0.52,14,0,0,TAU); g.fill();
  woodFill(g,B.bodyX0,B.bodyTop,B.bodyX1-B.bodyX0,B.bodyBot-B.bodyTop,
    '#2a160d','#170c07','rgba(60,30,14,0.5)',90,rnd);
  const lac=g.createLinearGradient(0,B.bodyTop,0,B.bodyBot);
  lac.addColorStop(0,'rgba(255,220,160,0.13)');
  lac.addColorStop(0.25,'rgba(255,220,160,0.03)');
  lac.addColorStop(1,'rgba(0,0,0,0.30)');
  g.fillStyle=lac; g.fillRect(B.bodyX0,B.bodyTop,B.bodyX1-B.bodyX0,B.bodyBot-B.bodyTop);
  g.strokeStyle='rgba(212,168,88,0.55)'; g.lineWidth=1.4;
  g.strokeRect(B.bodyX0+7,B.bodyTop+6,B.bodyX1-B.bodyX0-14,B.bodyBot-B.bodyTop-12);
  g.strokeStyle='rgba(212,168,88,0.25)';
  g.strokeRect(B.bodyX0+12,B.bodyTop+11,B.bodyX1-B.bodyX0-24,B.bodyBot-B.bodyTop-22);
  for(let k=0;k<7;k++){                       /* mother-of-pearl inlay */
    const ix=lerp(B.bodyX0+60,B.bodyX1-60,k/6), iy=(B.bodyTop+B.bodyBot)/2+14;
    const ig=g.createRadialGradient(ix,iy,0.5,ix,iy,6);
    ig.addColorStop(0,'rgba(190,215,225,0.8)');
    ig.addColorStop(0.6,'rgba(150,140,190,0.45)');
    ig.addColorStop(1,'rgba(150,140,190,0)');
    g.fillStyle=ig; g.beginPath(); g.arc(ix,iy,6,0,TAU); g.fill();
  }
  /* peg block + bridge at right */
  woodFill(g,B.bodyX1-34,B.bodyTop-14,30,20,'#4a2c14','#33200f','rgba(20,10,4,0.6)',8,rnd);
  g.fillStyle='#c9b27a';
  g.fillRect(B.bridgeX-2,B.sy-4,4,B.bodyTop-B.sy+8);

  /* --- đàn tranh: paulownia soundboard, rosewood frame --- */
  bgTranh=document.createElement('canvas');
  bgTranh.width=Math.round(W*DPR); bgTranh.height=Math.round(H*DPR);
  g=bgTranh.getContext('2d'); g.setTransform(DPR,0,0,DPR,0,0);
  roomBG(g);
  const T=tranhL, rnd2=mulberry(777);
  const bx0=T.x0-30,bx1=T.x1+40,by0=T.yT-40,by1=T.yB+40;
  g.fillStyle='rgba(0,0,0,0.5)';
  g.beginPath(); g.ellipse((bx0+bx1)/2,by1+16,(bx1-bx0)*0.52,16,0,0,TAU); g.fill();
  woodFill(g,bx0,by0,bx1-bx0,by1-by0,'#5c3317','#472507','rgba(28,12,2,0.6)',60,rnd2);
  woodFill(g,bx0+14,by0+14,bx1-bx0-28,by1-by0-28,
    '#b98c4f','#96692f','rgba(90,55,18,0.5)',150,rnd2);
  const sheen=g.createLinearGradient(bx0,by0,bx1,by1);
  sheen.addColorStop(0,'rgba(255,235,190,0.10)');
  sheen.addColorStop(0.5,'rgba(255,235,190,0.02)');
  sheen.addColorStop(1,'rgba(0,0,0,0.16)');
  g.fillStyle=sheen; g.fillRect(bx0+14,by0+14,bx1-bx0-28,by1-by0-28);
  woodFill(g,T.x0-4,by0+14,24,by1-by0-28,'#3c2008','#2b1605','rgba(15,7,1,0.7)',20,rnd2);
  woodFill(g,T.pinX-6,by0+14,T.x1-T.pinX+40,by1-by0-28,'#432408','#301804','rgba(15,7,1,0.7)',24,rnd2);
  g.strokeStyle='rgba(220,180,110,0.35)'; g.lineWidth=1.2;
  g.strokeRect(bx0+10,by0+10,bx1-bx0-20,by1-by0-20);
  for(let i=0;i<T.ys.length;i++){
    const py=T.ys[i], px=T.pinX+22;
    const pg=g.createRadialGradient(px-1.5,py-1.5,0.5,px,py,5.5);
    pg.addColorStop(0,'#ffe9ae'); pg.addColorStop(0.5,'#b98b3a'); pg.addColorStop(1,'#4c3410');
    g.fillStyle=pg; g.beginPath(); g.arc(px,py,5,0,TAU); g.fill();
    /* nhạn — movable bridge, inverted V with bone saddle */
    const bx=T.bx[i];
    g.fillStyle='rgba(0,0,0,0.35)';
    g.beginPath(); g.ellipse(bx,py+13,11,3.4,0,0,TAU); g.fill();
    const wg=g.createLinearGradient(bx-9,py,bx+9,py);
    wg.addColorStop(0,'#7a4a1e'); wg.addColorStop(0.5,'#a87c3e'); wg.addColorStop(1,'#5e3312');
    g.fillStyle=wg;
    g.beginPath();
    g.moveTo(bx-9,py+13); g.lineTo(bx-1.6,py-9); g.lineTo(bx+1.6,py-9); g.lineTo(bx+9,py+13);
    g.lineTo(bx+4.5,py+13); g.lineTo(bx,py-2.5); g.lineTo(bx-4.5,py+13);
    g.closePath(); g.fill();
    g.fillStyle='#efe6d2';
    g.beginPath(); g.arc(bx,py-8.4,2.6,0,TAU); g.fill();
    g.fillStyle='#c8b06a';
    g.font='11px "Palatino Linotype","Segoe UI",serif';
    g.textAlign='left';
    g.fillText(TRANH_LABELS[i],T.x1+18,py+4);
  }
}

/* ---------------- dynamic drawing ---------------- */
function drawStringPath(pts,glow,coreCol,shadowCol,coreW){
  if(glow>0.02){
    ctx.strokeStyle='rgba(255,214,140,'+Math.min(0.4,glow)+')';
    ctx.lineWidth=coreW+4.5;
    ctx.beginPath(); pathPts(pts); ctx.stroke();
  }
  ctx.strokeStyle=shadowCol; ctx.lineWidth=coreW+1.4;
  ctx.beginPath(); pathPtsOff(pts,1.4); ctx.stroke();
  ctx.strokeStyle=coreCol; ctx.lineWidth=coreW;
  ctx.beginPath(); pathPts(pts); ctx.stroke();
}
function pathPts(p){
  ctx.moveTo(p[0],p[1]);
  for(let i=2;i<p.length;i+=2) ctx.lineTo(p[i],p[i+1]);
}
function pathPtsOff(p,dy){
  ctx.moveTo(p[0],p[1]+dy);
  for(let i=2;i<p.length;i+=2) ctx.lineTo(p[i],p[i+1]+dy);
}
const bauPts=new Float32Array(240);
function drawBau(){
  ctx.drawImage(bgBau,0,0,W,H);
  const B=bauL, b=state.bau;
  const u=b.rodVis;
  const tipDx=-u*70;
  const rodBaseY=B.bodyTop+14;
  const rodSpan=rodBaseY-B.rodTopY;
  const bendAt=y=>tipDx*Math.pow((rodBaseY-y)/rodSpan,1.7);
  const ax=B.rodX+bendAt(B.sy)+6;

  /* rod (cần đàn) — buffalo-horn taper, bends with tension */
  ctx.lineCap='round';
  ctx.beginPath();
  ctx.moveTo(B.rodX,rodBaseY);
  ctx.quadraticCurveTo(B.rodX+tipDx*0.25,lerp(rodBaseY,B.rodTopY,0.55),
                       B.rodX+tipDx,B.rodTopY);
  ctx.strokeStyle='#1d120a'; ctx.lineWidth=7; ctx.stroke();
  ctx.strokeStyle='#6b4423'; ctx.lineWidth=4.4; ctx.stroke();
  ctx.strokeStyle='rgba(230,190,120,0.35)'; ctx.lineWidth=1.3; ctx.stroke();

  /* gourd (bầu) threaded on the rod at string height */
  const gy=B.sy-2;
  const gg=ctx.createRadialGradient(ax-5,gy-8,2,ax,gy,24);
  gg.addColorStop(0,'#e8c37f'); gg.addColorStop(0.55,'#b07f38'); gg.addColorStop(1,'#5d3d14');
  ctx.fillStyle=gg;
  ctx.beginPath(); ctx.ellipse(ax,gy,15,21,0,0,TAU); ctx.fill();
  ctx.strokeStyle='rgba(40,22,6,0.8)'; ctx.lineWidth=1.2; ctx.stroke();
  ctx.fillStyle='#241305';
  ctx.beginPath(); ctx.ellipse(ax+9,gy,4.5,7,0,0,TAU); ctx.fill();

  /* string from gourd to bridge, FDTD shape + bend distortion */
  const n=bauV.n, x1=B.bridgeX;
  const sag=u*-3;
  for(let i=0;i<n;i++){
    const t=i/(n-1);
    bauPts[i*2]=lerp(ax+10,x1,t);
    bauPts[i*2+1]=B.sy+bauV.y[i]*26+sag*Math.sin(Math.PI*t);
  }
  drawStringPath(bauPts.subarray(0,n*2),bauV.env*3,'#d8dde2','rgba(10,10,12,0.8)',1.5);

  /* harmonic node markers: keys 1–6 = nodes ½ ⅓ ¼ ⅕ ⅙ ⅛ (1/7 skipped) */
  ctx.textAlign='center'; ctx.font='12px "Palatino Linotype","Segoe UI",serif';
  const NODES=[[2,'1'],[3,'2'],[4,'3'],[5,'4'],[6,'5'],[8,'6']];
  for(let k=0;k<NODES.length;k++){
    const h=NODES[k][0], fx=1-1/h, x=lerp(ax+10,x1,fx);
    const active=b.node===h;
    ctx.fillStyle=active?'#ffd98a':'rgba(200,170,110,0.45)';
    ctx.beginPath();
    ctx.moveTo(x,B.sy+9); ctx.lineTo(x+3.4,B.sy+14); ctx.lineTo(x,B.sy+19); ctx.lineTo(x-3.4,B.sy+14);
    ctx.closePath(); ctx.fill();
    ctx.fillText(NODES[k][1],x,B.sy+33);
  }
  if(b.node===1){                        /* open-string indicator */
    ctx.fillStyle='#ffd98a';
    ctx.fillText('dây buông',ax+52,B.sy+33);
  }
  if(!b.grip){                           /* released rod tag */
    ctx.fillStyle='rgba(255,217,138,0.8)';
    ctx.fillText('thả cần',B.rodX+tipDx,B.rodTopY-10);
  }
  /* touching finger */
  if(b.fingerT>0.01){
    const fx=lerp(ax+10,x1,b.fingerFrac);
    ctx.fillStyle='rgba(224,172,124,'+(0.85*b.fingerT)+')';
    ctx.beginPath(); ctx.arc(fx,B.sy-1,6.5,0,TAU); ctx.fill();
    ctx.fillStyle='rgba(140,90,50,'+(0.5*b.fingerT)+')';
    ctx.beginPath(); ctx.arc(fx,B.sy-1,6.5,0,Math.PI); ctx.fill();
  }
  /* pluck position indicator */
  const px=lerp(ax+10,x1,1-b.pos);
  ctx.strokeStyle='rgba(255,200,120,0.35)';
  ctx.setLineDash([3,4]);
  ctx.beginPath(); ctx.moveTo(px,B.sy-26); ctx.lineTo(px,B.sy-8); ctx.stroke();
  ctx.setLineDash([]);
}
const tranhPts=new Float32Array(160);
function drawTranh(){
  ctx.drawImage(bgTranh,0,0,W,H);
  const T=tranhL, st=state.tranh, sp=st.specs;
  /* pluck-position band (measured from the fixed right bridge) */
  const avgBx=T.bx[Math.floor(T.bx.length/2)];
  const bandX=T.pinX-(T.pinX-avgBx)*st.pluckPos;
  ctx.fillStyle='rgba(255,210,130,0.06)';
  ctx.fillRect(bandX-4,T.yT-14,8,T.yB-T.yT+28);

  for(let i=0;i<st.count;i++){
    const y=T.ys[i], bx=T.bx[i], v=tranhV[i];
    const wound=sp[i].f<180;
    const core=wound?'#d8a86a':'#d5dbe2';
    const shad=wound?'rgba(60,30,8,0.8)':'rgba(12,12,16,0.8)';
    const cw=wound?2.1:1.4;
    /* left of bridge: press side */
    const pressed=st.pressI===i;
    const dip=pressed?Math.min(26,st.pressCents*0.075):0;
    ctx.strokeStyle=shad; ctx.lineWidth=cw+1.2;
    ctx.beginPath(); ctx.moveTo(T.nutX,y+1.2);
    ctx.quadraticCurveTo((T.nutX+bx)/2,y+dip+1.2,bx,y-7); ctx.stroke();
    ctx.strokeStyle=core; ctx.lineWidth=cw;
    ctx.beginPath(); ctx.moveTo(T.nutX,y);
    ctx.quadraticCurveTo((T.nutX+bx)/2,y+dip,bx,y-8); ctx.stroke();
    if(pressed){
      const hx=(T.nutX+bx)/2;
      ctx.fillStyle='rgba(224,172,124,0.9)';
      ctx.beginPath(); ctx.arc(hx,y+dip-2,7,0,TAU); ctx.fill();
      ctx.fillStyle='#ffd98a'; ctx.font='11px "Palatino Linotype","Segoe UI",serif'; ctx.textAlign='center';
      ctx.fillText('+'+Math.round(st.pressCents)+'¢',hx,y+dip-14);
    }
    /* right of bridge: speaking length, FDTD shape */
    const n=v.n;
    for(let j=0;j<n;j++){
      const t=j/(n-1);
      tranhPts[j*2]=lerp(bx,T.pinX,t);
      tranhPts[j*2+1]=y-8*(1-t)+v.y[j]*20;
    }
    drawStringPath(tranhPts.subarray(0,n*2),v.env*3,core,shad,cw);
  }
}

/* ---------------- HUD ---------------- */
let hudTick=0;
function updateHUD(){
  const h=$('hud');
  if(state.inst==='bau'){
    const b=state.bau,u=b.rodVis;
    const bend=u>=0?480*Math.tanh(1.50*u)/0.9051:520*Math.tanh(1.65*u)/0.9289;
    const f=130.813*Math.pow(2,bend/1200)*Math.max(1,b.node);
    h.innerHTML='<b>Đàn Bầu</b><br>'+
      'nốt: <b>'+(b.node>1?NODE_NOTE[b.node]+' ('+b.node+'×f₀)':'dây buông C3')+
      '</b> ≈ '+f.toFixed(1)+' Hz<br>'+
      'cần đàn: <b>'+(bend>=0?'+':'')+bend.toFixed(0)+' cents</b>'+
      (b.grip?'':' · <b>thả cần</b>')+'<br>'+
      'gảy: lực '+(b.strength*100|0)+'% · vị trí '+(b.pos*100|0)+'%<br>'+
      (b.rung?'<b>rung</b> ':'')+(b.nhan?'<b>nhấn</b> ':'')+
      (b.trem?'<b>ngón vé</b> ':'')+(b.held.size?'<b>ngón rời</b>':'');
  }else{
    const t=state.tranh;
    let s='<b>Đàn Tranh</b> — '+t.count+' dây<br>'+
      'vị trí gảy: '+(t.pluckPos*100|0)+'% · móng: '+(t.stiff>0.7?'cứng':'mềm')+'<br>';
    if(t.pressI>=0)
      s+='nhấn dây '+TRANH_LABELS[t.pressI]+': <b>+'+Math.round(t.pressCents)+' cents</b><br>';
    else if(t.lastPluck>=0)
      s+='dây vừa gảy: '+TRANH_LABELS[t.lastPluck]+' ('+noteName(t.specs[t.lastPluck].midi)+')<br>';
    h.innerHTML=s;
  }
}

/* ---------------- main loop ---------------- */
let last=performance.now(), acc=0;
const STEP=1/240;
function frame(now){
  let dt=(now-last)/1000; last=now;
  if(dt>0.05) dt=0.05;
  acc+=dt;
  let n=0;
  while(acc>STEP&&n<10){
    if(state.inst==='bau') bauV.step();
    else for(let i=0;i<tranhV.length;i++) tranhV[i].step();
    acc-=STEP; n++;
  }
  const b=state.bau;
  if(b.grip){
    b.rodVis+=0.16*(b.rodU-b.rodVis);
    b.rodVisV=0;
  }else{
    const w=TAU*3.8, z=0.18, sdt=1/60;
    b.rodVisV+=(-w*w*b.rodVis-2*z*w*b.rodVisV)*sdt;
    b.rodVis+=b.rodVisV*sdt;
  }
  if(b.held.size>0) b.fingerT=1;
  else if(b.fingerT>0) b.fingerT*=0.97;
  if(rodDirty&&state.running){ send({t:'bauRod',v:b.rodU}); rodDirty=false; }
  if(W>0){
    if(state.inst==='bau') drawBau(); else drawTranh();
  }
  if(++hudTick>=6){ hudTick=0; updateHUD(); }
  requestAnimationFrame(frame);
}
resize();
setInst('bau');
updateHUD();
requestAnimationFrame(frame);
