const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

for (const sampleRate of [48000, 96000]) {
  let Processor;
  const math = Object.create(Math);
  math.random = () => 0.5;
  const dsp = vm.createContext({sampleRate, Math: math,
    AudioWorkletProcessor: class { constructor() { this.port = {}; } },
    registerProcessor: (_, p) => { Processor = p; }});
  vm.runInContext(fs.readFileSync(path.join(root, 'dsp-worklet.js'), 'utf8'), dsp);
  const engine = new Processor();
  const blocks = n => {
    let peak = 0;
    for (let j = 0; j < n; j++) {
      const out = [new Float32Array(128), new Float32Array(128)];
      engine.process([], [out]);
      for (const channel of out) for (const x of channel) {
        assert(Number.isFinite(x)); peak = Math.max(peak, Math.abs(x));
      }
    }
    return peak;
  };
  engine.onMsg({t:'bauPluck',node:4,vel:0.8,pos:0.13});
  engine.onMsg({t:'bauRod',v:0.8});
  engine.onMsg({t:'bauG',g:'rung',on:true});
  engine.onMsg({t:'bauG',g:'nhan',on:true});
  blocks(Math.round(sampleRate * 0.3 / 128));
  engine.onMsg({t:'bauTrem',on:true});
  engine.onMsg({t:'bauGiat'});
  engine.onMsg({t:'bauGrip',on:false});
  const string = engine.bau.s;
  string.fingerFloor = 0.35;
  const rail = string.rA.b.slice();
  const tranh = engine.tranh;
  engine.onMsg({t:'bauCenter'});
  const b = engine.bau;
  assert.deepEqual(string.rA.b, rail, 'reset must not clear the string');
  assert.equal(engine.tranh, tranh);
  assert.equal(b.grip, true);
  for (const field of ['tremOn']) assert.equal(b[field], false);
  assert.equal(b.giT, -1);
  assert.equal(b.gest.rungOn, false); assert.equal(b.gest.nhanOn, false);
  assert.equal(string.fingerFloor, 0); assert.equal(string.fingerR, 0);
  assert(blocks(Math.round(sampleRate * 0.35 / 128)) > 0.001, 'note must keep ringing');
  assert(Math.abs(string.centsExtra) < 0.01, 'pitch must settle to neutral');
  engine.onMsg({t:'bauCenter'});
  assert(blocks(10) > 0, 'repeated resets must not mute');
  console.log(`Audio reset passes at ${sampleRate} Hz: neutral pitch, intact rails, audible tail.`);
}

// Execute the real input handlers with a minimal DOM, not duplicate mappings.
const elements = new Map(), handlers = new Map(), pending = [], messages = [];
const element = id => {
  if (!elements.has(id)) elements.set(id, {style:{},classList:{toggle(){}},
    addEventListener(){},getContext(){return {};}});
  return elements.get(id);
};
const ui = vm.createContext({document:{getElementById:element},
  window:{addEventListener:(name, fn)=>handlers.set(name, fn)},
  setTimeout:fn=>pending.push(fn), Math,
  buildBG(){},visBauPluck(){},visTranhPluck(){}});
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
vm.runInContext(app.slice(0, app.indexOf('/* ---------------- boot ---------------- */')), ui);
ui.capture = m => messages.push(m);
vm.runInContext('node={port:{postMessage:capture}}; state.running=true;', ui);
const key = code => handlers.get('keydown')({code,repeat:false,preventDefault(){}});
const resetCheck = () => {
  assert.equal(vm.runInContext('state.bau.rodU', ui), 0);
  assert.equal(vm.runInContext('state.bau.held.size', ui), 0);
  assert.equal(vm.runInContext('[state.bau.rung,state.bau.nhan,state.bau.trem,state.bau.roi,state.bau.bMod].some(Boolean)', ui), false);
  assert.equal(messages.at(-1).t, 'bauCenter');
};
key('Space'); key('ShiftLeft'); key('KeyT'); key('KeyZ'); key('KeyX');
key('Digit3'); // delayed staccato pluck racing with reset
vm.runInContext('state.bau.rodU=0.8; rodDirty=true;', ui);
key('Escape'); resetCheck();
for (const fn of pending) fn();
assert.equal(messages.at(-1).hold, false, 'pending pluck cannot restore staccato');
element('centerRod').onclick(); resetCheck();
vm.runInContext("setInst('tranh')", ui);
assert.equal(element('centerRod').hidden, true);
const count = messages.length;
key('Escape'); assert.equal(messages.length, count, 'Esc must not alter tranh');
vm.runInContext("setInst('bau')", ui);
assert.equal(element('centerRod').hidden, false);
console.log('Real keyboard/button handlers pass: reset, pending-pluck race, and tranh isolation.');
