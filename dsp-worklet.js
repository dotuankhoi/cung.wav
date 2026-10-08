'use strict';
const FS = sampleRate;
const TAU = 6.283185307179586;
const BLK = 128;
function clamp(x,a,b){ return x<a?a:(x>b?b:x); }

/* ---------- fractional delay line, 4-point Hermite interpolation ---------- */
class FDelay{
  constructor(maxLen){
    let n=8; while(n<maxLen+8) n<<=1;
    this.b=new Float32Array(n); this.mask=n-1; this.w=0;
  }
  clear(){ this.b.fill(0); }
  write(x){ this.w=(this.w+1)&this.mask; this.b[this.w]=x; }
  read(d){                    /* d>=3 samples; call before write() each tick */
    const p=this.w+1-d;
    let i=Math.floor(p);
    const f=p-i;
    const b=this.b,m=this.mask;
    const xm1=b[(i-1)&m], x0=b[i&m], x1=b[(i+1)&m], x2=b[(i+2)&m];
    const c1=0.5*(x1-xm1);
    const c2=xm1-2.5*x0+2*x1-0.5*x2;
    const c3=0.5*(x2-xm1)+1.5*(x0-x1);
    return ((c3*f+c2)*f+c1)*f+x0;
  }
}

/* ---------- one-pole lowpass with analytic phase-delay ---------- */
class LP1{
  constructor(){ this.a=0.5; this.y=0; }
  set(fc){ this.a=1-Math.exp(-TAU*clamp(fc,20,FS*0.45)/FS); }
  pro(x){ return this.y+=this.a*(x-this.y); }
  pd(f){
    const w=TAU*f/FS, b=1-this.a;
    return Math.atan2(b*Math.sin(w),1-b*Math.cos(w))/w;
  }
  mag(f){
    const w=TAU*f/FS, b=1-this.a;
    return this.a/Math.sqrt(1-2*b*Math.cos(w)+b*b);
  }
}

/* ---------- first-order allpass (dispersion), numeric phase-delay ---------- */
class AP1{
  constructor(){ this.a=0; this.x1=0; this.y1=0; }
  pro(x){ const y=this.a*(x-this.y1)+this.x1; this.x1=x; this.y1=y; return y; }
  pd(f){
    const w=TAU*f/FS, a=this.a, cw=Math.cos(w), sw=Math.sin(w);
    const ph=Math.atan2(-sw,a+cw)-Math.atan2(-a*sw,1+a*cw);
    return -ph/w;
  }
}

/* ---------- decaying two-pole resonator (body mode) ---------- */
class Mode{
  constructor(f,t60,g,pan){
    const r=Math.exp(-6.9078/(t60*FS));
    this.a1=2*r*Math.cos(TAU*f/FS); this.a2=-r*r; this.n=(1-r);
    this.y1=0; this.y2=0; this.g=g;
    this.gl=g*Math.sqrt(0.5-0.5*pan); this.gr=g*Math.sqrt(0.5+0.5*pan);
  }
  pro(x){
    const y=this.a1*this.y1+this.a2*this.y2+x*this.n;
    this.y2=this.y1; this.y1=y; return y;
  }
}

class DCB{
  constructor(fc){ this.R=1-TAU*fc/FS; this.x1=0; this.y1=0; }
  pro(x){ const y=x-this.x1+this.R*this.y1; this.x1=x; this.y1=y; return y; }
}

/* biquad lowpass section (RBJ) — used for the steep amp-cabinet cliff */
class BQLP{
  constructor(fc,Q){
    const w=TAU*fc/FS, c=Math.cos(w), s=Math.sin(w), al=s/(2*Q), a0=1+al;
    this.b0=((1-c)/2)/a0; this.b1=(1-c)/a0; this.b2=this.b0;
    this.a1=(-2*c)/a0; this.a2=(1-al)/a0;
    this.x1=0; this.x2=0; this.y1=0; this.y2=0;
  }
  pro(x){
    const y=this.b0*x+this.b1*this.x1+this.b2*this.x2
           -this.a1*this.y1-this.a2*this.y2;
    this.x2=this.x1; this.x1=x; this.y2=this.y1; this.y1=y;
    return y;
  }
}

/* =====================================================================
   PString — bidirectional digital waveguide string.
   Four rail segments around a movable scattering junction (the touching
   finger on đàn bầu; a transparent point on đàn tranh):
       nut --rA--> [junction] --rB--> bridge
       nut <--lA-- [junction] <--lB-- bridge
   The junction damps as a transverse dashpot of resistance R against
   string impedance Z=1:  rho=-R/(R+2), tau=1+rho.
   Bridge reflection = -g * LP(x) followed by dispersion allpasses;
   loop delay is compensated with the filters' phase delay at f0 so the
   string tunes exactly, and pitch is driven by a *tension ratio*
   (f ∝ sqrt(T)) smoothed per-sample through the fractional delays.
===================================================================== */
class PString{
  constructor(){
    this.rA=new FDelay(2048); this.lA=new FDelay(2048);
    this.rB=new FDelay(2048); this.lB=new FDelay(2048);
    this.combP=new FDelay(4096); this.combH=new FDelay(4096);
    this.bLP=new LP1(); this.nLP=new LP1(); this.nLP.set(11000);
    this.ap1=new AP1(); this.ap2=new AP1();
    this.baseF=130.813; this.f0=130.813;
    this.cut0=5000; this.t60=8; this.gLoop=0.997;
    this.jpos=0.5;
    this.d=180; this.dTarget=180;
    this.kD=1-Math.exp(-1/(0.0035*FS));
    this.fingerR=0; this.fingerDecay=1;
    this.fingerFloor=0;   /* sustained touch pressure (ngón rời staccato) */
    this.nlLoss=false;    /* amplitude-dependent loop loss (đàn bầu) */
    this.excI=1; this.excN=0; this.excLife=0;
    this.excAmp=0; this.excAngle=0.3; this.excSkew=1;
    this.excLP=new LP1(); this.excLP.set(6000);
    this.excLP2=new LP1(); this.excLP2.set(FS*0.45);  /* 2nd pole: transparent unless voiced */
    this.normHarm=1;      /* which partial carries the note (đàn bầu touch) */
    this.pluckPos=0.28; this.combPD=50; this.combHD=0; this.harmN=1;
    this.puAbs=0.94; this.pickupOn=false; this.puOut=0;
    this.symIn=0; this.bridgeOut=0;
    this.energy=0; this.active=false; this.qb=0;
    this.pressCents=0; this.pressTarget=0; this.pv=0;
    this.centsExtra=0;
  }
  retune(){
    const cents=this.pressCents+this.centsExtra;
    const tr=Math.pow(2,cents/600);              /* tension ratio, f ∝ √T */
    const f=this.baseF*Math.sqrt(tr);
    this.f0=f;
    this.bLP.set(this.cut0*(0.70+0.30*tr));      /* tension→brightness coupling */
    /* normalize total loop loss at f0 so the fundamental decays at exactly
       t60; partials above f0 decay faster through the loss filters.
       Ceiling keeps DC loop gain (g*0.998) strictly below 1. */
    /* normalize at the SOUNDING partial (touched harmonic on đàn bầu),
       so measured T60 targets apply to the note the listener hears */
    const fN=Math.min(f*this.normHarm,FS*0.42);
    const target=Math.exp(-6.9078/(f*this.t60));
    const m=0.998*this.bLP.mag(fN)*this.nLP.mag(fN);
    this.gLoop=Math.min(target/m,1.0015);
    const P=FS/f;
    const comp=this.bLP.pd(f)+this.nLP.pd(f)+this.ap1.pd(f)+this.ap2.pd(f);
    this.dTarget=Math.max(10,(P-comp)*0.5);
  }
  pluck(vel,pos,stiff,angle,harmN,fingerP){
    vel=clamp(vel,0.03,1);
    this.pluckPos=clamp(pos,0.04,0.62);
    this.harmN=harmN;
    const wMs=0.35+2.3*(1-vel)+1.6*(1-clamp(stiff,0,1));
    /* contact ends when the returning wave lifts the string off the pick:
       cap the impulse width well inside one period */
    this.excN=Math.max(4,Math.round(Math.min(wMs*0.001*FS,1.3*this.d)));
    this.excI=0;
    this.excAmp=0.22+0.95*vel*vel;
    this.excAngle=clamp(angle,0,1);
    this.excSkew=0.65+0.6*(1-vel);
    this.excLP.set(900+(2200+8500*vel)*clamp(stiff,0.15,1));
    this.excLP.y=0;
    this.combP.clear(); this.combH.clear();
    this.combPD=clamp(2*this.d*this.pluckPos,4,4000);
    this.combHD=harmN>1?clamp(2*this.d/harmN,4,4000):0;
    this.excLife=this.excN+Math.ceil(this.combPD+this.combHD)+8;
    if(fingerP>0){
      this.fingerR=fingerP;
      this.fingerDecay=Math.exp(-1/((0.045+Math.random()*0.07)*FS));
    }
    this.active=true; this.qb=0;
  }
  damp(amount,ms){
    this.fingerR=Math.max(this.fingerR,amount);
    this.fingerDecay=Math.exp(-1/(ms*0.001*FS));
    this.active=true;
  }
  tick(){
    this.d+=this.kD*(this.dTarget-this.d);
    const dA=Math.max(3,this.d*this.jpos);
    const dB=Math.max(3,this.d*(1-this.jpos));

    /* excitation pipeline: shaped impulse -> pick LP -> pluck-position
       comb -> harmonic comb -> one-directional injection at junction */
    let e=0;
    if(this.excI<this.excLife){
      let e0=0;
      if(this.excI<this.excN){
        let ph=this.excI/this.excN;
        ph=Math.pow(ph,this.excSkew);
        const bump=0.5*(1-Math.cos(TAU*ph));
        const slope=Math.sin(TAU*ph);
        e0=this.excAmp*((1-0.6*this.excAngle)*bump+0.6*this.excAngle*slope);
      }
      e0=this.excLP2.pro(this.excLP.pro(e0));
      const dl=this.combP.read(this.combPD);
      this.combP.write(e0);
      e=e0-0.95*dl;
      if(this.harmN>1){
        const dh=this.combH.read(this.combHD);
        this.combH.write(e);
        e=0.5*(e+dh);
      }
      this.excI++;
    }

    const aJ=this.rA.read(dA);
    const bJ=this.lB.read(dB);
    let toB,toA;
    const R=this.fingerR;
    if(R>1e-4){
      const rho=-R/(R+2), tau=1+rho;
      toB=tau*aJ+rho*bJ;
      toA=tau*bJ+rho*aJ;
      this.fingerR=this.fingerFloor+(this.fingerR-this.fingerFloor)*this.fingerDecay;
    }else{
      toB=aJ; toA=bJ;
      if(this.fingerFloor>1e-4) this.fingerR=this.fingerFloor;
    }
    toB+=e;    /* one-directional: pick sits between touch point and bridge */

    const atB=this.rB.read(dB);
    let g=this.gLoop;
    /* Loud notes shed a little extra energy. Cap is set by measurement,
       not by estimate: 5e-4 cost 1.44 dB/s and pulled T60 5.6 -> 4.9 s.
       1e-4 keeps the effect audible-in-principle without moving T60 off
       the recordings' 5.5 s. */
    if(this.nlLoss) g*=1-Math.min(0.0001,this.energy*0.0008);
    /* sustained touch (ngón rời): the palm has width, so it absorbs
       broadband — even the partials with a node at the touch point.
       Loss scales with touch pressure. */
    if(this.fingerFloor>1e-4) g*=1-0.43*this.fingerFloor;
    let refl=-g*this.bLP.pro(atB);
    refl=this.ap2.pro(this.ap1.pro(refl));
    const atN=this.lA.read(dA);
    const nr=-0.998*this.nLP.pro(atN);

    this.rB.write(toB);
    this.lB.write(refl+this.symIn);
    this.rA.write(nr);
    this.lA.write(toA);

    this.bridgeOut=atB;
    if(this.pickupOn){
      const q=clamp((this.puAbs-this.jpos)/(1-this.jpos),0.05,0.95);
      this.puOut=this.rB.read(Math.max(3,dB*q))+this.lB.read(Math.max(3,dB*(1-q)));
    }
    this.energy=0.999*this.energy+0.001*atB*atB;
    return atB;
  }
}
/* ---------- small stereo room (Schroeder): the reference đàn bầu
   recordings are clearly reverberant (RT ~1.6 s) ---------- */
class Reverb{
  constructor(){
    this.cL=[29.7,37.1,41.1,43.7].map(ms=>this._c(ms));
    this.cR=[30.9,38.3,42.6,45.3].map(ms=>this._c(ms));
    this.aL=[this._a(5.0),this._a(1.7)];
    this.aR=[this._a(5.6),this._a(2.1)];
    this.wl=0; this.wr=0;
  }
  _c(ms){
    const n=Math.max(4,Math.round(ms*0.001*FS));
    return {b:new Float32Array(n),i:0,n:n,lp:0,g:Math.pow(10,(-3*ms*0.001)/1.6)};
  }
  _a(ms){
    const n=Math.max(2,Math.round(ms*0.001*FS));
    return {b:new Float32Array(n),i:0,n:n};
  }
  _combs(cs,x){
    let s=0;
    for(let k=0;k<4;k++){
      const c=cs[k], y=c.b[c.i];
      c.lp+=0.38*(y-c.lp);            /* HF damping inside the loop */
      c.b[c.i]=x+c.lp*c.g;
      if(++c.i>=c.n) c.i=0;
      s+=y;
    }
    return s*0.25;
  }
  _aps(as,x){
    for(let k=0;k<2;k++){
      const a=as[k], y=a.b[a.i];
      const o=y-0.6*x;
      a.b[a.i]=x+0.6*o;
      if(++a.i>=a.n) a.i=0;
      x=o;
    }
    return x;
  }
  pro(x){
    this.wl=this._aps(this.aL,this._combs(this.cL,x));
    this.wr=this._aps(this.aR,this._combs(this.cR,x));
  }
}

/* =====================================================================
   ĐÀN BẦU — one string, harmonic-node touch, flexible pitch rod,
   magnetic pickup, lacquered-box body modes.
   Voicing calibrated against DSP analysis of three solo recordings
   (Vân-Ánh Võ, Thanh Tùng — 398 notes): H2 ≈ H1, H3 ≈ −14 dB, steep
   cliff above; T60 ≈ 5.5 s at the sounding pitch; rung 5.5 Hz ±28 c;
   negligible inharmonicity.
===================================================================== */
class BauEngine{
  constructor(){
    const s=new PString();
    s.baseF=130.813;                       /* open string C3 */
    s.cut0=12000; s.t60=5.5;               /* measured: T60 4.2–5.9 s, and
                                              upper partials ring as long as
                                              H1 -> near-transparent bridge LP */
    s.ap1.a=-0.03; s.ap2.a=-0.03;          /* measured B ≈ 0 */
    s.pickupOn=true; s.puAbs=0.985;        /* under-bridge pickup: strong k-tilt */
    s.jpos=0.5;
    s.nlLoss=true;                         /* louder notes shed energy faster */
    s.retune();
    this.s=s;
    this.node=4;
    this.rodU=0; this.rodSm=0;
    this.grip=true; this.rodV=0;           /* rod held vs released (springs free) */
    this.tremOn=false; this.tremT=0; this.tremStroke=false; this.lastPos=0.13;
    this.giT=-1;                           /* giật (bend-jerk) envelope clock */
    this.scoop=0;
    this.gest={rungOn:false,rungAmp:0,ph:0,rate:5.5,jit:0,nhanOn:false,nx:0,nv:0};
    this.rev=new Reverb();
    this.revEnv=0; this.strActive=false;
    this.kA=1-Math.exp(-BLK/(0.13*FS));
    this.kR=1-Math.exp(-BLK/(0.22*FS));
    this.dc=new DCB(32);
    /* fixed pickup+amp voicing measured from the recordings' LTAS:
       ~300 Hz 2nd-order low cut (low notes heard by their overtones),
       cliff above ~1.2 kHz (small-speaker rolloff) */
    this.hp1=new DCB(310); this.hp2=new DCB(310);
    /* 8th-order Butterworth LP at 1.3 kHz: the ~42 dB/oct cliff the
       recordings' LTAS shows above the passband */
    this.amp=[new BQLP(1300,0.50980),new BQLP(1300,0.60134),
              new BQLP(1300,0.89998),new BQLP(1300,2.56292)];
    this.puLP=new LP1(); this.puLP.set(8200);
    this.pres=new Mode(2850,0.004,0.55,0);
    this.compEnv=0;
    this.body=[
      new Mode(112,0.30,0.85,-0.30),
      new Mode(198,0.24,0.65, 0.25),
      new Mode(288,0.18,0.45,-0.10),
      new Mode(475,0.14,0.40, 0.30),
      new Mode(720,0.10,0.30,-0.20),
      new Mode(1240,0.06,0.22, 0.10)
    ];
    this.ampMod=1;
    this.oL=0; this.oR=0;
    this.blockActive=false;
  }
  voice(nn){
    /* excitation voicing around the SOUNDING note (calibrated against the
       recordings): contact just under half the sounding period puts the
       Hann pulse's spectral null near the 4th partial; two poles at 4.5x
       note plus the fixed amp EQ do the rest */
    const s=this.s;
    s.normHarm=nn;
    const noteF=s.baseF*nn;
    s.excN=Math.max(4,Math.round(FS/(noteF*3.2)));
    s.excLife=s.excN+Math.ceil(s.combPD+s.combHD)+8;
    s.excLP.set(clamp(4.5*noteF,600,16000));
    s.excLP2.set(clamp(4.5*noteF,600,16000));
    s.excLP2.y=0;
  }
  pluck(node,vel,pos,hold){
    const s=this.s, n=node, nn=n>1?n:1;
    this.node=n; this.lastPos=pos;
    /* touch node measured from the bridge; slight touch-placement variance */
    s.jpos = n>1 ? clamp(1-1/n+(Math.random()-0.5)*0.008,0.1,0.9) : 0.30;
    /* pick lands between touch point and bridge; scaling with the node
       puts the position-comb notch just above the note's 3rd partial */
    const p=clamp((0.28/nn)*(pos/0.13)*(0.94+Math.random()*0.12),0.02,0.5);
    s.pluck(vel,p,0.6,0.35,n, n>1?0.9+0.9*vel:0.35);
    /* ngón rời: while the key is held the touch stays on the string and
       chokes the note; releasing lifts the finger and lets it ring */
    s.fingerFloor = hold ? 0.35 : 0;
    this.voice(nn);
    this.scoop=-(3+Math.random()*8);
  }
  lift(){ this.s.fingerFloor=0; }
  retouch(node){
    /* ngón bội âm 2: silent retouch of a node on the ringing string —
       partials without a node there are absorbed, the rest survive */
    const s=this.s, n=node, nn=n>1?n:1;
    this.node=n;
    s.jpos = n>1 ? clamp(1-1/n+(Math.random()-0.5)*0.008,0.1,0.9) : 0.30;
    s.fingerR=Math.max(s.fingerR,1.3);
    s.fingerDecay=Math.exp(-1/((0.06+Math.random()*0.04)*FS));
    s.fingerFloor=0;
    s.normHarm=nn;
    s.active=true; s.qb=0;
  }
  giat(){ this.giT=0; }
  center(){
    /* Leave the delay rails, body modes and room tail intact. The rod
       eases home via its existing smoothing and fractional delays. */
    this.rodU=0; this.rodV=0; this.grip=true;
    this.tremOn=false; this.tremT=0; this.giT=-1; this.scoop=0;
    const G=this.gest;
    G.rungOn=false; G.rungAmp=0; G.nhanOn=false; G.nx=0; G.nv=0;
    this.ampMod=1;
    this.s.fingerFloor=0; this.s.fingerR=0;
  }
  vo(){
    this.s.damp(2.6,55);
    this.s.pluck(0.28,0.5,0.3,0.8,this.node,2.6);
  }
  control(){
    const s=this.s;
    if(s.active && s.excI>=s.excLife && s.energy<1e-12){
      if(++s.qb>40) s.active=false;
    }else s.qb=0;

    if(this.grip){
      this.rodSm+=0.10*(this.rodU-this.rodSm);
      this.rodV=0;
    }else{
      /* released rod: springs back to neutral, underdamped — a decaying
         pitch warble as the horn oscillates */
      const dt=BLK/FS, w=TAU*3.8, z=0.18;
      this.rodV+=(-w*w*this.rodSm-2*z*w*this.rodV)*dt;
      this.rodSm+=this.rodV*dt;
    }
    const u=this.rodSm;
    /* rod stiffness rises toward the extremes: tanh-compressed travel,
       ±4–5 semitone range, pull slightly deeper than push */
    const bend = u>=0 ? 480*Math.tanh(1.50*u)/0.9051
                      : 520*Math.tanh(1.65*u)/0.9289;
    /* a held rod hand also damps the string slightly */
    this.s.t60 = this.grip ? 5.5 : 6.4;
    const G=this.gest;
    G.rungAmp += G.rungOn ? this.kA*(1-G.rungAmp) : -this.kR*G.rungAmp;
    let g=0;
    this.ampMod=1;
    if(G.rungAmp>1e-3){
      G.jit+=0.05*((Math.random()*2-1)*0.10-G.jit);   /* wrist-rate drift */
      G.ph+=TAU*G.rate*(1+G.jit)*BLK/FS;
      if(G.ph>TAU) G.ph-=TAU;
      g+=G.rungAmp*28*(Math.sin(G.ph)+0.15*Math.sin(2*G.ph+0.8));  /* measured ±28 c */
      this.ampMod=1+G.rungAmp*0.06*Math.sin(G.ph-0.6);
    }
    const dt=BLK/FS, w0=TAU*4.3, zz=0.72;         /* nhấn: underdamped arm */
    const tgt=G.nhanOn?170:0;
    G.nv+=(w0*w0*(tgt-G.nx)-2*zz*w0*G.nv)*dt;
    G.nx+=G.nv*dt;
    g+=G.nx;
    /* giật: fast forceful bend-and-release jerk */
    if(this.giT>=0){
      const t=this.giT;
      g+=170*(t<0.05 ? t/0.05 : Math.exp(-(t-0.05)/0.09));
      this.giT+=dt;
      if(this.giT>0.6) this.giT=-1;
    }
    /* ngón vé: rapid re-plucking with the touch kept on the node */
    if(this.tremOn){
      this.tremT-=BLK;
      if(this.tremT<=0){
        this.tremT=FS/(9.5+Math.random()*3);
        this.tremStroke=!this.tremStroke;
        const n=this.node, nn=n>1?n:1;
        const p=clamp((0.28/nn)*(this.lastPos/0.13),0.02,0.5);
        this.s.pluck(clamp(0.3+Math.random()*0.18,0,1),p,0.7,
                     this.tremStroke?0.2:0.6,n,0.6);
        this.s.fingerFloor=0.15;   /* light ngón vé touch: notes bleed */
        this.voice(nn);
      }
    }
    this.scoop*=0.84;
    s.centsExtra=bend+g+this.scoop;
    s.retune();
    this.strActive = s.active || G.rungAmp>1e-3 || Math.abs(G.nx)>0.5;
    this.blockActive = this.strActive || this.revEnv>1e-6;
  }
  tick(){
    if(!this.blockActive){ this.oL=0; this.oR=0; return; }
    if(!this.strActive){                 /* string silent: reverb tail only */
      this.rev.pro(0);
      const wl=this.rev.wl, wr=this.rev.wr;
      this.revEnv=0.9995*this.revEnv+0.0005*(Math.abs(wl)+Math.abs(wr));
      this.oL=wl*0.32; this.oR=wr*0.32;
      return;
    }
    const s=this.s;
    s.symIn=0;
    const br=s.tick();
    /* pickup: DC rolloff -> soft magnetic compression -> mild asymmetric
       saturation -> presence resonance -> top rolloff */
    let pu=this.hp2.pro(this.hp1.pro(this.dc.pro(s.puOut)));
    const a=Math.abs(pu);
    this.compEnv += (a>this.compEnv?0.004:0.0004)*(a-this.compEnv);
    pu*=1/(1+1.6*this.compEnv);
    const x=pu*1.5;
    pu=Math.tanh(x+0.07*x*x)/1.5;
    pu=pu+0.6*this.pres.pro(pu);
    pu=this.amp[3].pro(this.amp[2].pro(this.amp[1].pro(this.amp[0].pro(pu))));
    pu=this.puLP.pro(pu);
    let bl=0,brr=0;
    const B=this.body;
    for(let k=0;k<6;k++){
      const md=B[k], v=md.pro(br);
      bl+=v*md.gl; brr+=v*md.gr;
    }
    const m=this.ampMod;
    const dl=(pu*14+bl*1.2)*m, dr=(pu*14+brr*1.2)*m;
    this.rev.pro((dl+dr)*0.5);
    const wl=this.rev.wl, wr=this.rev.wr;
    this.revEnv=0.9995*this.revEnv+0.0005*(Math.abs(wl)+Math.abs(wr));
    this.oL=dl+wl*0.32;
    this.oR=dr+wr*0.32;
  }
}

/* =====================================================================
   ĐÀN TRANH — up to 21 independent strings, movable bridges,
   sympathetic coupling through a shared bridge/soundboard bus.
===================================================================== */
class TranhEngine{
  constructor(){
    this.S=[];
    this.panL=new Float32Array(21); this.panR=new Float32Array(21);
    this.rad=new Float32Array(21);   /* soundboard radiation efficiency tilt */
    for(let i=0;i<21;i++){
      const s=new PString();
      s.jpos=0.34; s.pickupOn=false;
      this.S.push(s);
    }
    this.count=16; this.invN=1/16;
    this.busLP=new LP1(); this.busLP.set(1700);
    this.busState=0; this.busEnv=0;
    /* rank-1 bridge coupling: every string receives the same filtered
       mean bridge wave, own term included, sign opposite the reflection.
       Only the common mode is shifted (subtractively) -> passive/stable. */
    this.symG=0.05;
    this.body=[
      new Mode(186,0.26,0.70,-0.35),
      new Mode(262,0.22,0.60, 0.30),
      new Mode(334,0.18,0.50,-0.15),
      new Mode(408,0.15,0.45, 0.20),
      new Mode(524,0.12,0.38,-0.25),
      new Mode(702,0.09,0.32, 0.15),
      new Mode(942,0.07,0.26,-0.10),
      new Mode(1310,0.05,0.20, 0.05),
      new Mode(1780,0.045,0.30, 0.18),
      new Mode(2560,0.035,0.26,-0.14),
      new Mode(3620,0.028,0.20, 0.08),
      new Mode(5100,0.022,0.14,-0.05)
    ];
    this.oL=0; this.oR=0;
    this.blockActive=false;
  }
  config(freqs,Bs,t60s,count){
    this.count=count; this.invN=1/count;
    for(let i=0;i<count;i++){
      const s=this.S[i];
      s.baseF=freqs[i]; s.t60=t60s[i];
      s.cut0=clamp(14*freqs[i]+1500,3500,21000);
      const aDisp=-clamp(14*Math.sqrt(Bs[i])*Math.sqrt(freqs[i]/100),0.02,0.5);
      s.ap1.a=aDisp; s.ap2.a=aDisp;
      s.pressCents=0; s.pressTarget=0; s.pv=0; s.centsExtra=0;
      s.rA.clear(); s.lA.clear(); s.rB.clear(); s.lB.clear();
      s.energy=0; s.active=false; s.excI=1; s.excLife=0; s.fingerR=0;
      s.retune(); s.d=s.dTarget;
      const p=-0.55+1.1*i/Math.max(1,count-1);
      this.panL[i]=Math.sqrt(0.5-0.5*p*0.7);
      this.panR[i]=Math.sqrt(0.5+0.5*p*0.7);
      this.rad[i]=Math.pow(freqs[i]/131,0.45);
    }
    this.busState=0; this.busEnv=0;
  }
  pluck(i,vel,pos,stiff,angle){
    if(i<0||i>=this.count) return;
    this.S[i].pluck(vel,pos*(0.96+Math.random()*0.08),stiff,angle,1,0);
  }
  press(i,cents){
    if(i<0||i>=this.count) return;
    this.S[i].pressTarget=clamp(cents,0,380);
    this.S[i].active=true;
  }
  vo(i){ if(i>=0&&i<this.count) this.S[i].damp(2.2,60); }
  control(){
    const dt=BLK/FS, w0=TAU*6.0, zz=0.85;   /* left-hand press dynamics */
    let any=false;
    for(let i=0;i<this.count;i++){
      const s=this.S[i];
      if(s.active && s.excI>=s.excLife && s.energy<1e-12 &&
         Math.abs(s.pressCents)<0.5 && Math.abs(s.pressTarget)<0.5){
        if(++s.qb>40) s.active=false;
      }else s.qb=0;
      s.pv+=(w0*w0*(s.pressTarget-s.pressCents)-2*zz*w0*s.pv)*dt;
      s.pressCents+=s.pv*dt;
      if(s.active) s.retune();
      if(s.active) any=true;
    }
    this.blockActive = any || this.busEnv>1e-7;
  }
  tick(){
    if(!this.blockActive){ this.oL=0; this.oR=0; return; }
    const sy=this.busState*this.symG;
    let nb=0, l=0, r=0;
    const N=this.count, S=this.S;
    const busLive=this.busEnv>1e-7;
    for(let i=0;i<N;i++){
      const s=S[i];
      if(!s.active && !busLive) continue;
      s.symIn=sy;
      const br=s.tick();
      nb+=br;
      const dg=0.08*this.rad[i];
      l+=br*dg*this.panL[i];
      r+=br*dg*this.panR[i];
    }
    this.busEnv=0.999*this.busEnv+0.001*Math.abs(nb);
    this.busState=this.busLP.pro(nb*this.invN);
    const B=this.body;
    for(let k=0;k<12;k++){
      const md=B[k], v=md.pro(nb);
      l+=v*md.gl*0.6; r+=v*md.gr*0.6;
    }
    this.oL=l; this.oR=r;
  }
}

class Engine extends AudioWorkletProcessor{
  constructor(){
    super();
    this.bau=new BauEngine();
    this.tranh=new TranhEngine();
    this.port.onmessage=(ev)=>{ this.onMsg(ev.data); };
  }
  onMsg(m){
    const b=this.bau, t=this.tranh;
    switch(m.t){
      case 'bauPluck': b.pluck(m.node,m.vel,m.pos,!!m.hold); break;
      case 'bauLift':  b.lift(); break;
      case 'bauCenter': b.center(); break;
      case 'bauRetouch': b.retouch(m.node); break;
      case 'bauTrem':  b.tremOn=!!m.on; if(!m.on) b.s.fingerFloor=0; break;
      case 'bauGiat':  b.giat(); break;
      case 'bauGrip':
        b.grip=!!m.on;
        if(b.grip) b.rodV=0;
        break;
      case 'bauRod':   b.rodU=clamp(m.v,-1,1); break;
      case 'bauG':
        if(m.g==='rung') b.gest.rungOn=!!m.on;
        else if(m.g==='nhan') b.gest.nhanOn=!!m.on;
        break;
      case 'bauVo':    b.vo(); break;
      case 'tranhCfg': t.config(m.freqs,m.B,m.t60,m.count); break;
      case 'tranhPluck': t.pluck(m.i,m.vel,m.pos,m.stiff,m.angle); break;
      case 'tranhPress': t.press(m.i,m.cents); break;
      case 'tranhVo':  t.vo(m.i); break;
    }
  }
  process(inputs,outputs){
    const out=outputs[0];
    const L=out[0], R=out.length>1?out[1]:out[0];
    const n=L.length;
    const b=this.bau, t=this.tranh;
    b.control(); t.control();
    if(!b.blockActive && !t.blockActive){
      for(let i=0;i<n;i++){ L[i]=0; R[i]=0; }
      return true;
    }
    for(let i=0;i<n;i++){
      b.tick(); t.tick();
      const l=b.oL+t.oL, r=b.oR+t.oR;
      L[i]=Math.tanh(l*0.85);
      R[i]=Math.tanh(r*0.85);
    }
    return true;
  }
}
registerProcessor('vn-engine',Engine);
