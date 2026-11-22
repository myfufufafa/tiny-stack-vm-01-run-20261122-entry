// Tiny stack VM for make.fun tiny-stack-vm-01 (ISA v1, see kit ISA.md).
// Reads /input/<id>/{program,input}.bin, writes /output/<id>/{stdout.bin,exit.txt}.
// Values are signed 32-bit (wrap), data stack 256, call stack 64, memory 256 words,
// step limit 1,000,000, output limit 65,536 bytes. Traps end the program at once
// and keep the output written so far; the trapping instruction writes nothing.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// [opcode, immediate bytes, pops, pushes] for every opcode of the ISA.
const SPEC = [
  [0, 0, 0, 0], [1, 1, 0, 1], [2, 4, 0, 1], [3, 0, 1, 0], [4, 0, 1, 2],
  [5, 0, 2, 2], [6, 0, 2, 3], [7, 0, 3, 3], [16, 0, 2, 1], [17, 0, 2, 1],
  [18, 0, 2, 1], [19, 0, 2, 1], [20, 0, 2, 1], [21, 0, 2, 1], [22, 0, 2, 1],
  [23, 0, 1, 1], [24, 0, 2, 1], [25, 0, 2, 1], [26, 0, 2, 1], [27, 0, 1, 1],
  [28, 0, 2, 1], [29, 0, 2, 1], [30, 0, 2, 1], [32, 0, 2, 1], [33, 0, 2, 1],
  [34, 0, 2, 1], [48, 2, 0, 0], [49, 2, 1, 0], [50, 2, 1, 0], [51, 2, 0, 0],
  [52, 0, 0, 0], [64, 0, 1, 1], [65, 0, 2, 0], [80, 0, 1, 0], [81, 0, 1, 0],
  [82, 0, 0, 1], [83, 0, 1, 0],
];
const immLen = new Int8Array(256).fill(-1);
const needPop = new Int8Array(256);
const needPush = new Int8Array(256);
for (const [op, im, po, pu] of SPEC) { immLen[op] = im; needPop[op] = po; needPush[op] = pu; }

// Runs one program on its input bytes. Returns [output bytes, exit code 0..255].
function run(prog, inp) {
  const n = prog.length;
  const stk = new Int32Array(256);
  const ret = new Int32Array(64);
  const mem = new Int32Array(256);
  const out = new Uint8Array(65536);
  let sp = 0, rp = 0, pc = 0, steps = 0, olen = 0, ipos = 0;
  const done = (code) => [out.slice(0, olen), code];
  for (;;) {
    if (steps === 1000000) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const op = prog[pc];
    const il = immLen[op];
    if (il < 0) return done(5);
    if (pc + il >= n) return done(9);
    steps++;
    if (sp < needPop[op]) return done(2);
    if (sp - needPop[op] + needPush[op] > 256) return done(3);
    const nx = pc + 1 + il;
    pc = nx;
    switch (op) {
      case 0: return done(0);
      case 1: { const v = prog[nx - 1]; stk[sp++] = v > 127 ? v - 256 : v; break; }
      case 2: stk[sp++] = prog[nx - 4] | (prog[nx - 3] << 8) | (prog[nx - 2] << 16) | (prog[nx - 1] << 24); break;
      case 3: sp--; break;
      case 4: stk[sp] = stk[sp - 1]; sp++; break;
      case 5: { const t = stk[sp - 1]; stk[sp - 1] = stk[sp - 2]; stk[sp - 2] = t; break; }
      case 6: stk[sp] = stk[sp - 2]; sp++; break;
      case 7: { const a = stk[sp - 3]; stk[sp - 3] = stk[sp - 2]; stk[sp - 2] = stk[sp - 1]; stk[sp - 1] = a; break; }
      case 23: stk[sp - 1] = (-stk[sp - 1]) | 0; break;
      case 27: stk[sp - 1] = ~stk[sp - 1]; break;
      case 16: case 17: case 18: case 19: case 20: case 21: case 22:
      case 24: case 25: case 26: case 28: case 29: case 30:
      case 32: case 33: case 34: {
        const b = stk[sp - 1];
        const a = stk[sp - 2];
        let r = 0;
        if (op === 16) r = (a + b) | 0;
        else if (op === 17) r = (a - b) | 0;
        else if (op === 18) r = Math.imul(a, b);
        else if (op === 19) {
          if (b === 0) return done(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 20) {
          if (b === 0) return done(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 21) {
          if (b === 0) return done(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 22) {
          if (b === 0) return done(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 24) r = a & b;
        else if (op === 25) r = a | b;
        else if (op === 26) r = a ^ b;
        else if (op === 28) r = a << (b & 31);
        else if (op === 29) r = a >> (b & 31);
        else if (op === 30) r = (a >>> (b & 31)) | 0;
        else if (op === 32) r = a === b ? 1 : 0;
        else if (op === 33) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        sp -= 2;
        stk[sp++] = r;
        break;
      }
      case 48: case 49: case 50: {
        const rel = ((prog[nx - 2] | (prog[nx - 1] << 8)) << 16) >> 16;
        if (op === 48) pc = nx + rel;
        else { const v = stk[--sp]; if (op === 49 ? v === 0 : v !== 0) pc = nx + rel; }
        break;
      }
      case 51:
        if (rp === 64) return done(7);
        ret[rp++] = nx;
        pc = prog[nx - 2] | (prog[nx - 1] << 8);
        break;
      case 52:
        if (rp === 0) return done(8);
        pc = ret[--rp];
        break;
      case 64: {
        const ad = stk[sp - 1];
        if (ad < 0 || ad > 255) return done(6);
        stk[sp - 1] = mem[ad];
        break;
      }
      case 65: {
        const ad = stk[sp - 1];
        if (ad < 0 || ad > 255) return done(6);
        mem[ad] = stk[sp - 2];
        sp -= 2;
        break;
      }
      case 80: {
        const s = String(stk[sp - 1]);
        if (olen + s.length > 65536) return done(11);
        for (let i = 0; i < s.length; i++) out[olen++] = s.charCodeAt(i);
        sp--;
        break;
      }
      case 81:
        if (olen + 1 > 65536) return done(11);
        out[olen++] = stk[--sp] & 255;
        break;
      case 82: stk[sp++] = ipos < inp.length ? inp[ipos++] : -1; break;
      case 83: return done(stk[--sp] & 255);
    }
  }
}

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(IN_DIR).sort()) {
  // Only instance directories hold a program; a stray file in /input must not
  // gain a bogus answer directory of its own.
  try { if (!statSync(join(IN_DIR, id)).isDirectory()) continue; } catch { continue; }
  let prog, inp;
  try { prog = readFileSync(join(IN_DIR, id, 'program.bin')); } catch { prog = Buffer.alloc(0); }
  try { inp = readFileSync(join(IN_DIR, id, 'input.bin')); } catch { inp = Buffer.alloc(0); }
  let res;
  try { res = run(prog, inp); } catch (e) { console.error(id, e); res = [new Uint8Array(0), 9]; }
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'stdout.bin'), res[0]);
  writeFileSync(join(OUT_DIR, id, 'exit.txt'), String(res[1]) + '\n');
}
