// ひかりを編む — 編集エンジン
// プレビューも書き出しも同じ多段描画（グレード→ブルーム→仕上げ）を通す（色一致の要）
import { Muxer, ArrayBufferTarget } from 'https://esm.sh/mp4-muxer@5';

const $ = id => document.getElementById(id);
const logEl = $('log');
const logErr = t => { logEl.textContent += t + '\n'; };
window.addEventListener('error', e => logErr('エラー: ' + e.message));
window.addEventListener('unhandledrejection', e => logErr('エラー: ' + (e.reason?.message || e.reason)));
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function whenQueueBelow(getSize, target, max) {
  return new Promise(res => {
    if (getSize() <= max) return res();
    let iv;
    const h = () => { if (getSize() <= max) { clearInterval(iv); target.removeEventListener?.('dequeue', h); res(); } };
    target.addEventListener?.('dequeue', h);
    iv = setInterval(h, 15);
  });
}
// fast=true はスクラブ用（近いキーフレームへ飛ぶので速い）。書き出し前の位置合わせは正確なシークを使う
function seekTo(video, t, fast) {
  return new Promise(res => {
    if (Math.abs(video.currentTime - t) < 0.02) return res();
    let done = false;
    const h = () => { if (done) return; done = true; video.removeEventListener('seeked', h); res(); };
    video.addEventListener('seeked', h);
    if (fast && video.fastSeek) { try { video.fastSeek(t); } catch (e) { video.currentTime = t; } }
    else video.currentTime = t;
    setTimeout(h, 2500);
  });
}

// ===== 状態 =====
const project = {
  aspect: '16:9',
  fit: 'contain',      // 'contain'=切れないように収める / 'cover'=画面いっぱい
  clips: [],           // {id, kind:'video'|'photo', file, url, video|img, name, dur, w, h, start, end, thumb, bright, temp, autoBright, autoTemp, muted}
  lut: 'hikari',       // 'mine' | 'airu' | 'hikari' | 'none' | 'file'
  mineLutData: null,
  airuLutData: null,
  lutFileData: null,
  adjust: { exposure: 0, contrast: 0, saturation: 0, fade: 0, grain: 0.12 / 4, grainSize: 1, letterbox: true, strength: 0.85, effect: 0 },
  music: null,         // {name, arrayBuffer?|audioBuffer?, volume}
  muteAll: false,      // 元の音を消して音楽だけにする
  autoAlign: true,     // 自動そろえ
  impLen: 3,           // 取り込み長さ（秒。0=全部）
  preset: null,
};
let selId = null;
let clipSeq = 0;

const ASPECTS = {
  '16:9': { css: '16/9', prev: [960, 540], out1080: [1920, 1080], out2160: [3840, 2160] },
  '9:16': { css: '9/16', prev: [540, 960], out1080: [1080, 1920], out2160: [2160, 3840] },
  '4:5':  { css: '4/5',  prev: [540, 675], out1080: [1080, 1350], out2160: [2160, 2700] },
};

// 質感モード（アイルMVの実測に基づく。主役はブルーム＝ハイライトの滲み）
// gAmt/gSize はチップ選択時にスライダーへ流し込む既定値（オート）。その後は手動調整可
const FX = {
  0: { bloom: 0,    thresh: 1.0,  weave: 0,      flicker: 0,     vignette: 0,    dust: 0, cadence: 0,  gAmt: 12, gSize: 100 },
  1: { bloom: 0.55, thresh: 0.60, weave: 0.0012, flicker: 0.007, vignette: 0.05, dust: 0, cadence: 0,  gAmt: 14, gSize: 120 },  // アイル
  2: { bloom: 0.25, thresh: 0.72, weave: 0.0035, flicker: 0.035, vignette: 0.30, dust: 1, cadence: 12, gAmt: 24, gSize: 250 }, // 8mm強め
};

// プリセット（2軸）: 日記＝毎日をさっと / MV＝作品としてSNSへ
const PRESETS = {
  diary: { aspect: '9:16', fit: 'contain', lut: 'mine', effect: 0, muteAll: false, impLen: 3, letterbox: false, autoAlign: true },
  mv:    { aspect: '16:9', fit: 'contain', lut: 'airu', effect: 1, muteAll: true,  impLen: 2, letterbox: true,  autoAlign: true },
};

const PHOTO_MAX = 30;   // 写真クリップの最大長（秒）
const PHOTO_FPS = 30;

// ===== LUT =====
const LUT_HIKARI_N = 17;
function makeHikariLut() {
  const n = LUT_HIKARI_N, d = new Uint8Array(n * n * n * 3);
  const cl = v => Math.max(0, Math.min(1, v));
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const r = x / (n - 1), g = y / (n - 1), b = z / (n - 1);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let nr = 0.05 + r * 0.90, ng = 0.05 + g * 0.92, nb = 0.07 + b * 0.90;
    const sh = 1 - lum;
    nb += sh * 0.05; ng += sh * 0.015; nr += lum * 0.04;
    const l2 = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
    nr = l2 + (nr - l2) * 0.88; ng = l2 + (ng - l2) * 0.88; nb = l2 + (nb - l2) * 0.88;
    d[i++] = cl(nr) * 255; d[i++] = cl(ng) * 255; d[i++] = cl(nb) * 255;
  }
  return { data: d, n };
}
function makeIdentityLut() {
  const n = 2, d = new Uint8Array(n * n * n * 3);
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    d[i++] = x * 255; d[i++] = y * 255; d[i++] = z * 255;
  }
  return { data: d, n };
}

function parseCube(text) {
  let n = 0; const vals = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('TITLE') || t.startsWith('DOMAIN')) continue;
    if (t.startsWith('LUT_3D_SIZE')) { n = parseInt(t.split(/\s+/)[1]); continue; }
    if (t.startsWith('LUT_1D_SIZE')) throw new Error('1D LUTは未対応です（3D LUTの.cubeを選んでください）');
    const p = t.split(/\s+/).map(Number);
    if (p.length === 3 && p.every(v => !isNaN(v))) vals.push(...p);
  }
  if (!n || vals.length !== n * n * n * 3) throw new Error('.cubeの形式を読めませんでした');
  const d = new Uint8Array(vals.length);
  for (let i = 0; i < vals.length; i++) d[i] = Math.max(0, Math.min(255, Math.round(vals[i] * 255)));
  return { data: d, n };
}

// ===== WebGL 多段パイプライン =====
const VS = `#version 300 es
out vec2 uv;
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
uv = p; gl_Position = vec4(p.x*2.-1., 1.-p.y*2., 0., 1.); }`;

const NOISE = `
float h1(float n){ return fract(sin(n)*43758.5453); }
float vn(float t){ float i=floor(t), f=fract(t); return mix(h1(i), h1(i+1.), f*f*(3.-2.*f)); }`;

const FS_GRADE = `#version 300 es
precision mediump float; precision mediump sampler3D;
uniform sampler2D uFrame; uniform sampler3D uLut;
uniform float uStrength,uExposure,uContrast,uSaturation,uFade,uTemp,uLutN,uTime,uWeave;
uniform int uRot; uniform vec2 uVis;
in vec2 uv; out vec4 o;
${NOISE}
void main(){
  vec2 e = 0.5 + (uv - 0.5) * uVis;
  e += vec2((vn(uTime*0.045)-0.5)*2.*uWeave, (vn(uTime*0.045+37.7)-0.5)*1.6*uWeave);
  vec2 s = uRot==0 ? e : uRot==90 ? vec2(e.y, 1.0-e.x) : uRot==180 ? 1.0-e : vec2(1.0-e.y, e.x);
  if (s.x < 0. || s.x > 1. || s.y < 0. || s.y > 1.) { o = vec4(0.,0.,0.,1.); return; }
  vec3 c = texture(uFrame, s).rgb;
  c *= exp2(uExposure);
  c.r *= 1.0 + uTemp*0.14;
  c.b *= 1.0 - uTemp*0.14;
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(lum), c, 1.0 + uSaturation);
  c = mix(c, c * 0.82 + 0.13, uFade);
  vec3 g = texture(uLut, clamp(c,0.,1.) * ((uLutN-1.0)/uLutN) + (0.5/uLutN)).rgb;
  c = mix(c, g, uStrength);
  o = vec4(clamp(c, 0., 1.), 1.0);
}`;

const FS_BLUR = `#version 300 es
precision mediump float;
uniform sampler2D uTex; uniform vec2 uDir; uniform float uThresh; uniform int uFirst;
in vec2 uv; out vec4 o;
void main(){
  float w[5]; w[0]=0.227; w[1]=0.194; w[2]=0.121; w[3]=0.054; w[4]=0.016;
  vec3 acc = vec3(0.);
  for (int i = -4; i <= 4; i++) {
    vec3 v = texture(uTex, uv + uDir * float(i)).rgb;
    if (uFirst == 1) v = max(v - uThresh, 0.) / max(1. - uThresh, 0.001);
    acc += v * w[i < 0 ? -i : i];
  }
  o = vec4(acc, 1.0);
}`;

const FS_FINAL = `#version 300 es
precision mediump float;
uniform sampler2D uBase, uBloom;
uniform float uBloomAmt,uLetterbox,uVignette,uFlicker,uDust,uGrain,uGrainScale,uTime;
in vec2 uv; out vec4 o;
${NOISE}
void main(){
  if (uv.y < uLetterbox || uv.y > 1.0 - uLetterbox) { o = vec4(0.,0.,0.,1.); return; }
  vec2 suv = vec2(uv.x, 1.0 - uv.y);
  vec3 c = texture(uBase, suv).rgb;
  vec3 bl = texture(uBloom, suv).rgb;
  c = 1.0 - (1.0 - c) * (1.0 - bl * uBloomAmt);
  c *= 1.0 - uVignette * smoothstep(0.45, 0.92, distance(uv, vec2(0.5)));
  c *= 1.0 + (vn(uTime*0.6+51.0)-0.5)*2.0*uFlicker;
  if (uDust > 0.5) {
    float d = fract(sin(dot(floor(uv*vec2(26.,15.)) + floor(uTime*0.35), vec2(41.3,289.1)))*33758.5);
    if (d > 0.997) c += 0.22;
  }
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float n = fract(sin(dot(floor(gl_FragCoord.xy/uGrainScale) + vec2(uTime, uTime*1.7), vec2(12.9898,78.233))) * 43758.5453);
  c += (n - 0.5) * uGrain * mix(0.12, 1.0, pow(1.0 - l, 1.6));
  o = vec4(clamp(c, 0., 1.), 1.0);
}`;

// クリップに効く補正（手動＋自動そろえ）
function clipBrightOf(c) { return c ? (c.bright || 0) + (project.autoAlign ? (c.autoBright || 0) : 0) : 0; }
function clipTempOf(c) { return c ? (c.temp || 0) + (project.autoAlign ? (c.autoTemp || 0) : 0) : 0; }

class GLPipe {
  constructor(canvas) {
    this.cv = canvas;
    const gl = this.gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2が使えない端末です');
    const mk = (t, src) => {
      const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('シェーダ: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = (fs, names) => {
      const p = gl.createProgram();
      gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('リンク: ' + gl.getProgramInfoLog(p));
      const u = {};
      for (const n of names) u[n] = gl.getUniformLocation(p, n);
      return { prog: p, u };
    };
    this.grade = prog(FS_GRADE, ['uFrame','uLut','uStrength','uExposure','uContrast','uSaturation','uFade','uTemp','uLutN','uTime','uWeave','uRot','uVis']);
    this.blur = prog(FS_BLUR, ['uTex','uDir','uThresh','uFirst']);
    this.final = prog(FS_FINAL, ['uBase','uBloom','uBloomAmt','uLetterbox','uVignette','uFlicker','uDust','uGrain','uGrainScale','uTime']);
    gl.useProgram(this.grade.prog);
    gl.uniform1i(this.grade.u.uFrame, 0);
    gl.uniform1i(this.grade.u.uLut, 1);
    gl.useProgram(this.blur.prog);
    gl.uniform1i(this.blur.u.uTex, 2);
    gl.useProgram(this.final.prog);
    gl.uniform1i(this.final.u.uBase, 2);
    gl.uniform1i(this.final.u.uBloom, 3);

    const tex2 = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
        gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    };
    gl.activeTexture(gl.TEXTURE0);
    this.frameTex = tex2();
    this.texA = tex2(); this.texB = tex2(); this.texC = tex2();
    this.fboA = gl.createFramebuffer(); this.fboB = gl.createFramebuffer(); this.fboC = gl.createFramebuffer();
    this.lutTex = gl.createTexture();
    this.uploadMode = 'direct';
    this.w = 0; this.h = 0;
    this.setLut(makeHikariLut());
  }
  _alloc(w, h) {
    const gl = this.gl;
    this.w = w; this.h = h;
    this.bw = Math.max(2, w >> 3); this.bh = Math.max(2, h >> 3);
    const bind = (tex, fbo, tw, th) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    };
    gl.activeTexture(gl.TEXTURE7);
    bind(this.texA, this.fboA, w, h);
    bind(this.texB, this.fboB, this.bw, this.bh);
    bind(this.texC, this.fboC, this.bw, this.bh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }
  setLut({ data, n }) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, n, n, n, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.useProgram(this.grade.prog);
    gl.uniform1f(this.grade.u.uLutN, n);
    gl.activeTexture(gl.TEXTURE0);
  }
  async draw(source, srcW, srcH, rot, time, clip) {
    const gl = this.gl, a = project.adjust, fx = FX[a.effect];
    const ow = this.cv.width, oh = this.cv.height;
    if (ow !== this.w || oh !== this.h) this._alloc(ow, oh);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    if (this.uploadMode === 'direct') {
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); }
      catch (e) { this.uploadMode = 'bitmap'; }
    }
    if (this.uploadMode === 'bitmap') {
      const bmp = await createImageBitmap(source);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      bmp.close();
    }

    // パス1: グレード（露出・色温度・LUT・微揺れ）→ fboA
    const rw = rot % 180 === 0 ? srcW : srcH, rh = rot % 180 === 0 ? srcH : srcW;
    const arOut = ow / oh, arSrc = rw / rh;
    const vis = project.fit === 'cover'
      ? (arSrc > arOut ? [arOut / arSrc, 1] : [1, arSrc / arOut])
      : (arSrc > arOut ? [1, arSrc / arOut] : [arOut / arSrc, 1]);
    gl.useProgram(this.grade.prog);
    const u = this.grade.u;
    gl.uniform2f(u.uVis, vis[0], vis[1]);
    gl.uniform1i(u.uRot, rot);
    gl.uniform1f(u.uStrength, project.lut === 'none' ? 0 : a.strength);
    gl.uniform1f(u.uExposure, a.exposure + clipBrightOf(clip));
    gl.uniform1f(u.uTemp, clipTempOf(clip));
    gl.uniform1f(u.uContrast, a.contrast);
    gl.uniform1f(u.uSaturation, a.saturation);
    gl.uniform1f(u.uFade, a.fade);
    gl.uniform1f(u.uTime, time % 100000);
    gl.uniform1f(u.uWeave, fx.weave);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
    gl.viewport(0, 0, ow, oh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // パス2・3: ブルーム（明部を抽出して縦横ぼかし）
    if (fx.bloom > 0) {
      gl.useProgram(this.blur.prog);
      const b = this.blur.u;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.texA);
      gl.uniform1i(b.uFirst, 1);
      gl.uniform1f(b.uThresh, fx.thresh);
      gl.uniform2f(b.uDir, 1 / this.bw, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
      gl.viewport(0, 0, this.bw, this.bh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, this.texB);
      gl.uniform1i(b.uFirst, 0);
      gl.uniform2f(b.uDir, 0, 1 / this.bh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboC);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 仕上げ: ブルーム合成・周辺減光・明滅・ダスト・粒子・レターボックス → 画面
    gl.useProgram(this.final.prog);
    const f = this.final.u;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, fx.bloom > 0 ? this.texC : this.texA);
    gl.uniform1f(f.uBloomAmt, fx.bloom);
    gl.uniform1f(f.uLetterbox, a.letterbox ? 0.11 : 0);
    gl.uniform1f(f.uVignette, fx.vignette);
    gl.uniform1f(f.uFlicker, fx.flicker);
    gl.uniform1f(f.uDust, fx.dust);
    gl.uniform1f(f.uGrain, a.grain);
    gl.uniform1f(f.uGrainScale, Math.max(0.5, a.grainSize));
    gl.uniform1f(f.uTime, time % 100000);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, ow, oh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}

const preview = new GLPipe($('previewCanvas'));

function applyLutSelection(pipe) {
  if (project.lut === 'mine' && project.mineLutData) pipe.setLut(project.mineLutData);
  else if (project.lut === 'airu' && project.airuLutData) pipe.setLut(project.airuLutData);
  else if (project.lut === 'file' && project.lutFileData) pipe.setLut(project.lutFileData);
  else if (project.lut === 'none') pipe.setLut(makeIdentityLut());
  else pipe.setLut(makeHikariLut());
}

async function loadBuiltinLut(url, key, lutName) {
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    project[key] = parseCube(await r.text());
    document.querySelector(`#lutChips .chip[data-lut=${lutName}]`).style.display = '';
  } catch (e) { }
}

// ===== 保存と復元（IndexedDB。素材と編集状態を端末内に保持） =====
let dbP = null, ready = false, saveTimer = 0;
function db() {
  dbP ||= new Promise((res, rej) => {
    const r = indexedDB.open('hikari', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('files'); r.result.createObjectStore('state'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbP;
}
async function idbPut(store, key, val) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite');
    t.objectStore(store).put(val, key);
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}
async function idbGet(store, key) {
  const d = await db();
  return new Promise((res, rej) => {
    const q = d.transaction(store).objectStore(store).get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function idbDel(store, key) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}
async function idbClear(store) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite');
    t.objectStore(store).clear();
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}
function scheduleSave() {
  if (!ready) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);
}
function saveState() {
  const st = {
    aspect: project.aspect, fit: project.fit, lut: project.lut,
    adjust: { ...project.adjust },
    muteAll: project.muteAll, autoAlign: project.autoAlign, impLen: project.impLen, preset: project.preset,
    lutFileText: project.lutFileText || null, lutFileName: project.lutFileName || null,
    clips: project.clips.map(c => ({
      id: c.id, kind: c.kind, name: c.name, start: c.start, end: c.end, dur: c.dur,
      bright: c.bright, temp: c.temp, autoBright: c.autoBright, autoTemp: c.autoTemp,
      muted: c.muted, thumb: c.thumb,
    })),
    music: project.music ? { name: project.music.name, volume: project.music.volume, stored: !project.music.audioBuffer } : null,
    clipSeq,
  };
  idbPut('state', 'project', st).catch(() => { });
}

// ===== クリップ =====
function clipSource(c) { return c.kind === 'photo' ? c.img : c.video; }
function clipLen(c) { return c.end - c.start; }
function clipReady(c) { return c.kind === 'photo' ? c.img.complete : c.video.readyState >= 2; }

// meta は「復元・複製のための既存データ」専用。新規取り込みの種別は kindHint で渡す
// （meta に種別ヒントを兼ねさせると復元扱いになり、取り込み長さや自動そろえが効かなくなる）
async function createClip(fileBlob, meta, analyze, kindHint) {
  const url = URL.createObjectURL(fileBlob);
  const kind = meta?.kind || kindHint || (fileBlob.type.startsWith('image/') ? 'photo' : 'video');
  const name = meta?.name || fileBlob.name || (kind === 'photo' ? '写真' : 'クリップ');
  const clip = {
    id: meta?.id || 'c' + (++clipSeq), kind, file: fileBlob, url, name,
    thumb: meta?.thumb || '',
    bright: meta?.bright || 0, temp: meta?.temp || 0,
    autoBright: meta?.autoBright || 0, autoTemp: meta?.autoTemp || 0,
    muted: meta?.muted || false,
  };

  if (kind === 'photo') {
    const img = clip.img = new Image();
    img.src = url;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('この写真は読み込めませんでした: ' + name));
      setTimeout(() => rej(new Error('読み込みタイムアウト: ' + name)), 15000);
    });
    clip.dur = PHOTO_MAX;
    clip.w = img.naturalWidth; clip.h = img.naturalHeight;
    clip.start = 0;
    clip.end = meta ? clamp(meta.end ?? 3, 0.3, PHOTO_MAX) : (project.impLen > 0 ? project.impLen : 3);
  } else {
    const video = clip.video = document.createElement('video');
    video.src = url; video.playsInline = true; video.preload = 'auto'; video.muted = true;
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('この動画は読み込めませんでした: ' + name));
      setTimeout(() => rej(new Error('読み込みタイムアウト: ' + name)), 15000);
    });
    clip.dur = video.duration;
    clip.w = video.videoWidth; clip.h = video.videoHeight;
    if (meta) {
      clip.start = clamp(meta.start ?? 0, 0, Math.max(0, clip.dur - 0.2));
      clip.end = clamp(meta.end ?? clip.dur, clip.start + 0.2, clip.dur);
    } else {
      clip.start = 0;
      clip.end = project.impLen > 0 ? Math.min(project.impLen, clip.dur) : clip.dur;
    }
    video.addEventListener('seeked', () => { if (!playing && lastDrawn === clip) drawStill(clip); });
    const advance = () => { if (playing && project.clips[playIdx] === clip) { checkAdvance(); syncPlayhead(); } };
    video.addEventListener('timeupdate', advance);
    video.addEventListener('ended', advance);
    video.addEventListener('pause', () => {
      if (playing && project.clips[playIdx] === clip && !video.ended && video.currentTime < clip.end - 0.05)
        setTimeout(() => { if (playing && project.clips[playIdx] === clip) video.play().catch(() => { }); }, 250);
    });
  }
  if (!clip.thumb) await makeThumb(clip);
  if (analyze) await analyzeClip(clip);
  return clip;
}

async function makeThumb(clip) {
  if (clip.kind === 'video') await seekTo(clip.video, Math.min(clip.start + 0.1, Math.max(0, clip.dur - 0.05)));
  const src = clipSource(clip);
  const sw = clip.w || 16, sh = clip.h || 9;
  const c = document.createElement('canvas');
  c.width = 120; c.height = 72;
  const x = c.getContext('2d');
  const ar = sw / sh, arT = 120 / 72;
  let cw = sw, ch = sh, sx = 0, sy = 0;
  if (ar > arT) { cw = sh * arT; sx = (sw - cw) / 2; }
  else { ch = sw / arT; sy = (sh - ch) / 2; }
  try { x.drawImage(src, sx, sy, cw, ch, 0, 0, 120, 72); } catch (e) { }
  clip.thumb = c.toDataURL('image/jpeg', 0.6);
}

// 取り込み時に明るさ・色かぶりを測って、自動そろえ用のオフセットを決める
async function analyzeClip(clip) {
  try {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    const x = c.getContext('2d', { willReadFrequently: true });
    const pts = clip.kind === 'photo' ? [null]
      : [0.2, 0.5, 0.8].map(p => clamp(clip.start + clipLen(clip) * p, 0, Math.max(0, clip.dur - 0.05)));
    let lum = 0, rb = 0, n = 0;
    for (const t of pts) {
      if (t != null) await seekTo(clip.video, t);
      try { x.drawImage(clipSource(clip), 0, 0, 64, 36); } catch (e) { continue; }
      const d = x.getImageData(0, 0, 64, 36).data;
      for (let i = 0; i < d.length; i += 4) {
        lum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        rb += (d[i] - d[i + 2]) / 255;
        n++;
      }
    }
    if (!n) return;
    const meanLum = lum / n, meanRb = rb / n;
    clip.meanLum = meanLum; clip.meanRb = meanRb;
    // 明るさ: 目標0.42へ寄せる（70%だけ効かせ、±0.7EVで頭打ち）
    clip.autoBright = meanLum > 0.02 ? clamp(Math.log2(0.42 / meanLum) * 0.7, -0.7, 0.7) : 0;
    // 色: グレーワールド仮定でR-Bの偏りを半分だけ中和
    clip.autoTemp = clamp(-meanRb * 1.5, -0.4, 0.4);
    if (clip.kind === 'video') await seekTo(clip.video, clip.start);
  } catch (e) { }
}

async function addFiles(files, kind) {
  const before = project.clips.length;
  for (const file of files) {
    try {
      const clip = await createClip(file, null, true, kind);
      project.clips.push(clip);
      idbPut('files', clip.id, file).catch(e => logErr('保存に失敗: ' + e.message));
      selId = clip.id;
    } catch (e) { logErr(e.message); }
  }
  renderTimeline(); renderClipEdit();
  $('emptyHint').style.display = project.clips.length ? 'none' : 'flex';
  if (project.clips.length > before) seekTimeline(sumBefore(project.clips.length - 1));
}

// ===== タイムライン =====
let pxPerSec = 46;
let timelinePos = 0;        // 現在の再生位置（秒）
let seekPending = null, seekBusy = false, seekSeq = 0;

function timelineDur() { return project.clips.reduce((s, c) => s + clipLen(c), 0); }
function sumBefore(i) { return project.clips.slice(0, i).reduce((s, c) => s + clipLen(c), 0); }
function halfView() { return $('timelineScroll').clientWidth / 2; }

function renderTimeline() {
  const layer = $('clipLayer');
  layer.innerHTML = '';
  const half = halfView();
  let t = 0;
  project.clips.forEach(c => {
    const len = clipLen(c);
    const d = document.createElement('div');
    d.className = 'clipBlock' + (c.id === selId ? ' sel' : '');
    d.dataset.id = c.id;
    d.style.left = (half + t * pxPerSec) + 'px';
    d.style.width = Math.max(20, len * pxPerSec) + 'px';
    if (c.thumb) d.style.backgroundImage = `url(${c.thumb})`;
    const mark = c.kind === 'photo' ? '🖼' : ((c.muted || project.muteAll) ? '🔇' : '');
    d.innerHTML = `<span class="mk">${mark}</span><span class="lbl">${len.toFixed(1)}s</span>`;
    if (c.id === selId) d.insertAdjacentHTML('beforeend', '<div class="trimHandle left"></div><div class="trimHandle right"></div>');
    layer.appendChild(d);
    t += len;
  });
  const w = half * 2 + t * pxPerSec;
  $('timelineTrack').style.width = w + 'px';
  layer.style.width = w + 'px';
  renderRuler(t, half, w);
  renderMusicTrack(t, half, w);
  updateTimeLabel();
  scheduleSave();
}

// 時間目盛（ピンチ倍率に応じて刻みを選ぶ）
function renderRuler(total, half, w) {
  const el = $('ruler');
  el.style.width = w + 'px';
  const steps = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find(s => s * pxPerSec >= 46) || steps[steps.length - 1];
  let html = '';
  for (let t = 0; t <= total + 1e-6; t += step) {
    const label = step < 1 ? `${t.toFixed(1)}s` : total >= 60 ? fmt(t) : `${Math.round(t)}s`;
    html += `<span class="tick" style="left:${half + t * pxPerSec}px">${label}</span>`;
  }
  el.innerHTML = html;
}

// 音楽トラック（タップで音楽タブを開く）
function renderMusicTrack(total, half, w) {
  const el = $('musicLayer');
  el.style.width = w + 'px';
  const width = Math.max(60, total * pxPerSec);
  if (project.music) {
    const dur = musicAudioBuf ? musicAudioBuf.duration : total;
    const shown = Math.max(60, Math.min(dur, total) * pxPerSec);
    el.innerHTML = `<div class="musicBar" style="left:${half}px;width:${shown}px">♪ ${project.music.name}${project.muteAll ? '（元の音はオフ）' : ''}</div>`;
  } else {
    el.innerHTML = `<div class="musicBar empty" style="left:${half}px;width:${width}px">♪ 音楽を追加（いまは${project.muteAll ? '無音' : '元の音のまま'}）</div>`;
  }
  // スクラブのために横へ動かしたときは、音楽タブを開かない
  const bar = el.querySelector('.musicBar');
  let downX = null;
  bar.addEventListener('pointerdown', ev => { downX = ev.clientX; });
  bar.onclick = ev => {
    if (downX != null && Math.abs(ev.clientX - downX) > 8) return;
    switchTab('music', true);
  };
}

// ドラッグ中は要素を作り直さず位置だけ更新する（ポインタ捕捉を失わないため）
function layoutBlocks() {
  const half = halfView();
  const els = [...$('clipLayer').children];
  let t = 0;
  els.forEach((el, i) => {
    const c = project.clips[i];
    if (!c) return;
    const len = clipLen(c);
    if (!el.classList.contains('dragging')) el.style.left = (half + t * pxPerSec) + 'px';
    el.style.width = Math.max(20, len * pxPerSec) + 'px';
    const lbl = el.querySelector('.lbl');
    if (lbl) lbl.textContent = len.toFixed(1) + 's';
    t += len;
  });
  const w = half * 2 + t * pxPerSec;
  $('timelineTrack').style.width = w + 'px';
  $('clipLayer').style.width = w + 'px';
  updateTimeLabel();
}

function clipAt(t) {
  let acc = 0;
  for (let i = 0; i < project.clips.length; i++) {
    const len = clipLen(project.clips[i]);
    if (t < acc + len || i === project.clips.length - 1) return { i, local: clamp(t - acc, 0, len) };
    acc += len;
  }
  return null;
}

// タイムライン位置へ移動してプレビューを合わせる
function seekTimeline(t, fromScroll) {
  const total = timelineDur();
  timelinePos = clamp(t, 0, Math.max(0, total));
  const at = clipAt(timelinePos);
  if (!at) { updateTimeLabel(); return; }
  playIdx = at.i;
  const c = project.clips[at.i];
  photoElapsed = c.kind === 'photo' ? at.local : 0;
  if (!fromScroll) syncPlayheadScroll();
  updateTimeLabel();
  if (c.kind === 'photo') { lastDrawn = c; drawStill(c); }
  else requestSeek(c, c.start + at.local);
}

// 連続スクラブ時にシークが詰まらないよう1件ずつ処理する。
// 追い越された古い要求は描画しない（前のクリップの絵が後から出るのを防ぐ）
function requestSeek(clip, time) {
  seekPending = { clip, time, seq: ++seekSeq };
  if (seekBusy) return;
  seekBusy = true;
  (async () => {
    while (seekPending) {
      const job = seekPending;
      seekPending = null;
      await seekTo(job.clip.video, clamp(job.time, 0, Math.max(0, job.clip.dur - 0.03)), true);
      if (job.seq !== seekSeq) continue;
      drawStill(job.clip);
    }
    seekBusy = false;
  })();
}

function syncPlayheadScroll() {
  $('timelineScroll').scrollLeft = timelinePos * pxPerSec;
}

function syncPlayhead() {
  const c = project.clips[playIdx];
  if (!c) return;
  timelinePos = sumBefore(playIdx) + currentLocal(c);
  syncPlayheadScroll();
  updateTimeLabel();
}

// 自分で動かした分（プレイヘッド同期）は無視する。位置の一致で判定するので取りこぼしがない
$('timelineScroll').addEventListener('scroll', () => {
  if (playing) return;
  const sc = $('timelineScroll');
  if (Math.abs(sc.scrollLeft - timelinePos * pxPerSec) < 2) return;
  seekTimeline(sc.scrollLeft / pxPerSec, true);
});
window.addEventListener('resize', () => { renderTimeline(); syncPlayheadScroll(); });

// クリップのタップ選択・トリム・並び替え
let drag = null;
$('timelineTrack').addEventListener('pointerdown', e => {
  const block = e.target.closest('.clipBlock');
  if (!block) return;
  const id = block.dataset.id;
  const idx = project.clips.findIndex(c => c.id === id);
  if (idx < 0) return;
  const clip = project.clips[idx];
  const handle = e.target.closest('.trimHandle');

  if (handle) {
    e.preventDefault();
    block.setPointerCapture(e.pointerId);
    drag = { mode: handle.classList.contains('left') ? 'trimL' : 'trimR', clip, idx, block, x0: e.clientX, start0: clip.start, end0: clip.end };
    stopPlayback();
    return;
  }
  // タップ＝選択、その場で長押し＝並び替え。
  // ここではポインタを捕捉しない（捕捉するとタイムラインの横スクロール＝スクラブを邪魔するため）。
  // 少しでも動いたら並び替えには入らない（ドラッグは常にスクラブとして扱う）
  drag = {
    mode: 'tap', clip, idx, block, x0: e.clientX, y0: e.clientY, pointerId: e.pointerId,
    left0: parseFloat(block.style.left), moved: false,
    timer: setTimeout(() => {
      if (!drag || drag.mode !== 'tap' || drag.moved) return;
      drag.mode = 'move';
      block.classList.add('dragging');
      try { block.setPointerCapture(drag.pointerId); } catch (err) { }
      stopPlayback();
    }, 500),
  };
});
$('timelineTrack').addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  if (drag.mode === 'tap') {
    if (Math.abs(dx) > 4 || Math.abs(e.clientY - drag.y0) > 12) drag.moved = true;
    // 横に動かしたらスクラブに譲る（並び替えには入らない）
    if (Math.abs(dx) > 8) { clearTimeout(drag.timer); drag = null; return; }
  }
  if (drag.mode === 'trimL') {
    const c = drag.clip;
    c.start = clamp(drag.start0 + dx / pxPerSec, 0, c.end - 0.3);
    if (c.kind === 'photo') c.start = 0;
    layoutBlocks();
    requestSeek2(c, c.start);
  } else if (drag.mode === 'trimR') {
    const c = drag.clip;
    const max = c.kind === 'photo' ? PHOTO_MAX : c.dur;
    c.end = clamp(drag.end0 + dx / pxPerSec, c.start + 0.3, max);
    layoutBlocks();
    requestSeek2(c, c.end - 0.05);
  } else if (drag.mode === 'move') {
    drag.block.style.left = (drag.left0 + dx) + 'px';
  }
});
function requestSeek2(c, t) {
  lastDrawn = c;
  if (c.kind === 'photo') drawStill(c);
  else requestSeek(c, t);
}
function endDrag(e) {
  if (!drag) return;
  clearTimeout(drag.timer);
  const d = drag; drag = null;
  if (d.mode === 'tap') {
    selId = d.clip.id;
    renderTimeline(); renderClipEdit();
    seekTimeline(sumBefore(project.clips.indexOf(d.clip)));
    switchTab('clips', true);
    return;
  }
  if (d.mode === 'move') {
    d.block.classList.remove('dragging');
    // 中心位置から新しい並び順を決める
    const center = parseFloat(d.block.style.left) + d.block.offsetWidth / 2 - halfView();
    let acc = 0, target = project.clips.length - 1;
    for (let i = 0; i < project.clips.length; i++) {
      const len = clipLen(project.clips[i]) * pxPerSec;
      if (center < acc + len / 2) { target = i; break; }
      acc += len;
    }
    const cur = project.clips.indexOf(d.clip);
    if (cur !== target) {
      project.clips.splice(cur, 1);
      project.clips.splice(target, 0, d.clip);
    }
    selId = d.clip.id;
    renderTimeline(); renderClipEdit();
    // 並び替え後も再生位置は動かさない（別のクリップへ飛ばない）
    seekTimeline(timelinePos);
    return;
  }
  // トリム終了。編集した側の端に再生位置を残す
  renderTimeline(); renderClipEdit();
  const i = project.clips.indexOf(d.clip);
  seekTimeline(sumBefore(i) + (d.mode === 'trimR' ? Math.max(0, clipLen(d.clip) - 0.05) : 0));
}
// スクロール（スクラブ）が始まるとブラウザは pointercancel を送る。
// これをタップとして扱うと勝手に選択・ジャンプしてしまうので、タップ／並び替えは中止する
function cancelDrag(e) {
  if (!drag) return;
  if (drag.mode === 'trimL' || drag.mode === 'trimR') return endDrag(e);
  clearTimeout(drag.timer);
  drag.block?.classList.remove('dragging');
  const wasMove = drag.mode === 'move';
  drag = null;
  if (wasMove) renderTimeline();
}
$('timelineTrack').addEventListener('pointerup', endDrag);
$('timelineTrack').addEventListener('pointercancel', cancelDrag);

// 2本指ピンチで時間スケールを拡大・縮小（全体表示⇔細かい調整）
const tlPts = new Map();
let pinch = null;
function setZoom(px, anchorT) {
  const next = clamp(px, 4, 260);
  if (Math.abs(next - pxPerSec) < 0.01) return;
  pxPerSec = next;
  renderTimeline();
  if (anchorT != null) timelinePos = anchorT;
  syncPlayheadScroll();
}
function cancelDragForPinch() {
  if (!drag) return;
  clearTimeout(drag.timer);
  drag.block?.classList.remove('dragging');
  drag = null;
  renderTimeline();
}
const tlScroll = $('timelineScroll');
tlScroll.addEventListener('pointerdown', e => {
  tlPts.set(e.pointerId, e.clientX);
  if (tlPts.size === 2) {
    cancelDragForPinch();
    const xs = [...tlPts.values()];
    pinch = { dist: Math.max(1, Math.abs(xs[0] - xs[1])), px0: pxPerSec, t0: timelinePos };
  }
}, true);
tlScroll.addEventListener('pointermove', e => {
  if (!tlPts.has(e.pointerId)) return;
  tlPts.set(e.pointerId, e.clientX);
  if (!pinch || tlPts.size < 2) return;
  e.preventDefault();
  const xs = [...tlPts.values()];
  setZoom(pinch.px0 * (Math.max(1, Math.abs(xs[0] - xs[1])) / pinch.dist), pinch.t0);
}, true);
const endPinchPt = e => { tlPts.delete(e.pointerId); if (tlPts.size < 2) pinch = null; };
tlScroll.addEventListener('pointerup', endPinchPt, true);
tlScroll.addEventListener('pointercancel', endPinchPt, true);
// Mac/トラックパッドのピンチは ctrl+wheel として届く
tlScroll.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(pxPerSec * Math.exp(-e.deltaY * 0.01), timelinePos);
}, { passive: false });

// ===== プレビュー描画 =====
let lastDrawn = null;
function drawStill(clip) {
  lastDrawn = clip;
  // まだ読み込み中なら、準備できてから描き直す（復元直後にプレビューが黒いままになるのを防ぐ）
  if (!clipReady(clip)) {
    const src = clipSource(clip);
    const ev = clip.kind === 'photo' ? 'load' : 'loadeddata';
    src.addEventListener(ev, () => { if (lastDrawn === clip && !playing) drawStill(clip); }, { once: true });
    return;
  }
  preview.draw(clipSource(clip), clip.w, clip.h, 0, performance.now() * 0.03, clip);
}
function redraw() {
  scheduleSave();
  if (playing) return;
  const c = lastDrawn || project.clips[playIdx] || project.clips[0];
  if (c) drawStill(c);
}

// ===== 再生 =====
let playing = false, playIdx = 0, rafId = 0, lastPrevDraw = 0;
let photoT0 = 0, photoElapsed = 0, advancing = false, playTimer = 0;
let audioCtx = null, musicSrc = null, musicGain = null, musicAudioBuf = null;

function currentLocal(c) {
  if (!c) return 0;
  if (c.kind === 'photo') return clamp(playing ? photoElapsed + (performance.now() - photoT0) / 1000 : photoElapsed, 0, clipLen(c));
  return clamp(c.video.currentTime - c.start, 0, clipLen(c));
}

function ensureAudioCtx() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
async function ensureMusicBuffer() {
  if (!project.music || musicAudioBuf) return;
  ensureAudioCtx();
  if (project.music.audioBuffer) { musicAudioBuf = project.music.audioBuffer; return; }
  musicAudioBuf = await audioCtx.decodeAudioData(project.music.arrayBuffer.slice(0));
}
function startMusic(fromT) {
  if (!musicAudioBuf) return;
  const total = timelineDur();
  musicSrc = audioCtx.createBufferSource();
  musicSrc.buffer = musicAudioBuf;
  musicGain = audioCtx.createGain();
  musicSrc.connect(musicGain).connect(audioCtx.destination);
  const vol = project.music.volume, now = audioCtx.currentTime;
  const g = musicGain.gain;
  g.setValueAtTime(0, now);
  const fadeInEnd = Math.max(0, 1 - fromT);
  g.linearRampToValueAtTime(vol, now + Math.max(0.02, fadeInEnd));
  const outStart = total - 1.5 - fromT, outEnd = total - fromT;
  if (outStart > 0) { g.setValueAtTime(vol, now + outStart); g.linearRampToValueAtTime(0, now + Math.max(outStart + 0.02, outEnd)); }
  if (fromT < musicAudioBuf.duration) musicSrc.start(now, fromT, Math.max(0.1, outEnd));
}
function stopMusic() {
  try { musicSrc?.stop(); } catch (e) { }
  musicSrc = null;
}

// 切替は非同期（シーク待ち）なので、その間は進行判定を止める（一気に飛ぶのを防ぐ）
async function startClipPlayback(i, local) {
  const c = project.clips[i];
  if (!c) return;
  advancing = true;
  try {
    if (c.kind === 'photo') {
      photoElapsed = local || 0;
      photoT0 = performance.now();
    } else {
      c.video.muted = project.muteAll || c.muted;
      await seekTo(c.video, clamp(c.start + (local || 0), 0, Math.max(0, c.dur - 0.05)));
      if (!playing) return;
      await c.video.play().catch(() => {
        const retry = () => { if (playing) c.video.play().catch(err => logErr('再生: ' + err.name)); };
        document.addEventListener('visibilitychange', retry, { once: true });
        setTimeout(retry, 400);
      });
    }
  } finally { advancing = false; }
}

async function play() {
  if (!project.clips.length || playing) return;
  const total = timelineDur();
  if (timelinePos >= total - 0.05) { timelinePos = 0; }
  const at = clipAt(timelinePos) || { i: 0, local: 0 };
  playing = true;
  playIdx = at.i;
  $('playBtn').textContent = '❚❚';
  await ensureMusicBuffer().catch(e => logErr('音楽: ' + e.message));
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
  if (musicAudioBuf) startMusic(timelinePos);
  await startClipPlayback(at.i, at.local);
  // 写真クリップはrAFだけだと画面非表示時に進まないのでタイマーでも進行させる
  clearInterval(playTimer);
  playTimer = setInterval(() => { if (playing) { syncPlayhead(); checkAdvance(); } }, 100);
  loop();
}
function checkAdvance() {
  if (advancing) return;
  const c = project.clips[playIdx];
  if (!c) { stopPlayback(); return; }
  const done = c.kind === 'photo'
    ? currentLocal(c) >= clipLen(c) - 0.01
    : (c.video.currentTime >= c.end || c.video.ended);
  if (!done) return;
  if (c.kind === 'video') c.video.pause();
  if (playIdx < project.clips.length - 1) {
    playIdx++;
    startClipPlayback(playIdx, 0);
  } else stopPlayback(true);
}
function loop() {
  if (!playing) return;
  const c = project.clips[playIdx];
  if (c) {
    const now = performance.now();
    const cad = FX[project.adjust.effect].cadence;
    if (cad === 0 || now - lastPrevDraw > 1000 / cad) {
      if (clipReady(c)) preview.draw(clipSource(c), c.w, c.h, 0, now * 0.03, c);
      lastDrawn = c;
      lastPrevDraw = now;
    }
    syncPlayhead();
    checkAdvance();
  }
  rafId = requestAnimationFrame(loop);
}
function stopPlayback(atEnd) {
  if (!playing) return;
  playing = false;
  cancelAnimationFrame(rafId);
  clearInterval(playTimer);
  const c = project.clips[playIdx];
  if (c?.kind === 'video') c.video.pause();
  if (c?.kind === 'photo') photoElapsed = currentLocal(c);
  stopMusic();
  $('playBtn').textContent = '▶';
  if (atEnd) { timelinePos = timelineDur(); syncPlayheadScroll(); }
  updateTimeLabel();
}
function updateTimeLabel() {
  $('timeLabel').textContent = `${fmt(clamp(timelinePos, 0, timelineDur()))} / ${fmt(timelineDur())}`;
}
$('playBtn').onclick = () => playing ? stopPlayback() : play();

// ===== mp4box =====
function getDescription(mp4, trackId) {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(s);
      return new Uint8Array(s.buffer, 8);
    }
  }
  return null;
}
async function demux(blob) {
  const buf = await blob.arrayBuffer();
  buf.fileStart = 0;
  const mp4 = MP4Box.createFile();
  const info = await new Promise((res, rej) => {
    mp4.onReady = res;
    mp4.onError = e => rej(new Error('mp4解析失敗: ' + e));
    mp4.appendBuffer(buf);
    mp4.flush();
  });
  const track = info.videoTracks[0];
  if (!track) throw new Error('動画トラックが見つからない');
  let rot = 0;
  try {
    const m = mp4.getTrackById(track.id).tkhd.matrix;
    rot = (Math.round(Math.atan2(m[1] / 65536, m[0] / 65536) * 180 / Math.PI) + 360) % 360;
  } catch (e) { }
  const desc = getDescription(mp4, track.id);
  mp4.setExtractionOptions(track.id, null, { nbSamples: 1000000 });
  const samples = [];
  mp4.onSamples = (id, u, s) => samples.push(...s);
  mp4.start();
  const want = track.nb_samples, t0 = performance.now();
  while (samples.length < want && performance.now() - t0 < 30000) await new Promise(r => setTimeout(r, 50));
  mp4.stop();
  if (!samples.length) throw new Error('サンプル抽出に失敗');
  return { track, samples, desc, rot };
}

// ===== 書き出し =====
// クリップ本来の音を取り出す（動画ファイルの音声トラックをデコード）
async function getClipAudio(clip) {
  if (clip.kind !== 'video') return null;
  if (clip.audioBuf !== undefined) return clip.audioBuf;
  try {
    const ab = await clip.file.arrayBuffer();
    clip.audioBuf = await ensureAudioCtx().decodeAudioData(ab.slice(0));
  } catch (e) { clip.audioBuf = null; }
  return clip.audioBuf;
}

async function buildAudioTrack(total) {
  const sr = 44100;
  const len = Math.ceil(total * sr);
  if (len <= 0) return null;
  let any = false;
  const off = new OfflineAudioContext(2, len, sr);
  let t = 0;
  for (const c of project.clips) {
    const l = clipLen(c);
    if (!project.muteAll && !c.muted) {
      const buf = await getClipAudio(c);
      if (buf && buf.duration > c.start + 0.02) {
        const s = off.createBufferSource();
        s.buffer = buf;
        s.connect(off.destination);
        s.start(t, c.start, Math.min(l, buf.duration - c.start));
        any = true;
      }
    }
    t += l;
  }
  if (musicAudioBuf) {
    const s = off.createBufferSource();
    s.buffer = musicAudioBuf;
    const g = off.createGain();
    s.connect(g).connect(off.destination);
    const vol = project.music.volume;
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(vol, Math.min(1, total));
    if (total > 1.5) { g.gain.setValueAtTime(vol, total - 1.5); g.gain.linearRampToValueAtTime(0, total); }
    s.start(0, 0, Math.min(total, musicAudioBuf.duration));
    any = true;
  }
  if (!any) return null;
  return await off.startRendering();
}

let exporting = false;
async function exportVideo() {
  if (exporting || !project.clips.length) return;
  exporting = true;
  stopPlayback();
  const btn = $('runExport');
  btn.disabled = true;
  $('outVideo').style.display = 'none';
  $('saveRow').style.display = 'none';
  const prog = (t, r) => { $('exportProg').textContent = t; if (r != null) $('progFill').style.width = (r * 100).toFixed(0) + '%'; };
  try {
    const res = $('resSel').value;
    const [outW, outH] = ASPECTS[project.aspect]['out' + (res === '2160' ? '2160' : '1080')];
    let encCfg = {
      codec: Math.max(outW, outH) > 2000 ? 'avc1.640033' : 'avc1.640028',
      width: outW, height: outH,
      bitrate: Math.max(outW, outH) > 2000 ? 40e6 : 14e6,
      framerate: 30,
    };
    if (!(await VideoEncoder.isConfigSupported(encCfg)).supported) throw new Error('この解像度のエンコードに未対応の端末です');

    const total = timelineDur();
    if (project.music) await ensureMusicBuffer();
    prog('音を準備中…', 0.02);
    const audioBuf = await buildAudioTrack(total);

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: outW, height: outH },
      ...(audioBuf ? { audio: { codec: 'aac', sampleRate: 44100, numberOfChannels: 2 } } : {}),
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    const encoder = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => logErr('エンコード: ' + e.message) });
    encoder.configure(encCfg);

    const exCanvas = document.createElement('canvas');
    exCanvas.width = outW; exCanvas.height = outH;
    const pipe = new GLPipe(exCanvas);
    applyLutSelection(pipe);

    const cadUs = FX[project.adjust.effect].cadence ? 1e6 / FX[project.adjust.effect].cadence : 0;
    let offsetUs = 0, lastKeyUs = -1e9, frameCount = 0, lastCadIdx = -1;
    const pushFrame = async (ts, durUs) => {
      const out = new VideoFrame(exCanvas, { timestamp: ts, duration: durUs });
      await whenQueueBelow(() => encoder.encodeQueueSize, encoder, 4);
      const key = ts - lastKeyUs >= 2e6;
      if (key) lastKeyUs = ts;
      encoder.encode(out, { keyFrame: key });
      out.close();
      frameCount++;
    };

    for (let ci = 0; ci < project.clips.length; ci++) {
      const clip = project.clips[ci];
      const len = clipLen(clip);

      if (clip.kind === 'photo') {
        prog(`${ci + 1}/${project.clips.length}枚目の写真を書き出し中…`, sumBefore(ci) / total);
        const n = Math.max(1, Math.round(len * PHOTO_FPS));
        for (let i = 0; i < n; i++) {
          const ts = Math.round(offsetUs + i * 1e6 / PHOTO_FPS);
          if (cadUs) {
            const idx = Math.floor(ts / cadUs);
            if (idx === lastCadIdx) continue;
            lastCadIdx = idx;
          }
          await pipe.draw(clip.img, clip.w, clip.h, 0, frameCount, clip);
          await pushFrame(ts, Math.round(1e6 / PHOTO_FPS));
        }
        offsetUs += Math.round(len * 1e6);
        continue;
      }

      prog(`${ci + 1}/${project.clips.length}本目を解析中…`, sumBefore(ci) / total);
      const { track, samples, desc, rot } = await demux(clip.file);
      const baseCts = Math.min(...samples.map(s => s.cts));
      const startUs = clip.start * 1e6, endUs = clip.end * 1e6;
      const decCfg = { codec: track.codec, codedWidth: track.video?.width || clip.w, codedHeight: track.video?.height || clip.h };
      if (desc) decCfg.description = desc;
      if (!(await VideoDecoder.isConfigSupported(decCfg)).supported) throw new Error('デコード不可: ' + track.codec);

      let chain = Promise.resolve();
      const decoder = new VideoDecoder({
        output: frame => {
          chain = chain.then(async () => {
            const rel = frame.timestamp - Math.round(baseCts * 1e6 / samples[0].timescale);
            if (rel < startUs - 1 || rel >= endUs) { frame.close(); return; }
            const outTs = Math.round(offsetUs + (rel - startUs));
            if (cadUs) {
              const idx = Math.floor(outTs / cadUs);
              if (idx === lastCadIdx) { frame.close(); return; }
              lastCadIdx = idx;
            }
            await pipe.draw(frame, frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight, rot, frameCount, clip);
            frame.close();
            await pushFrame(outTs, frame.duration ?? undefined);
            if (frameCount % 15 === 0)
              prog(`${ci + 1}/${project.clips.length}本目を変換中…`, Math.min(0.9, (sumBefore(ci) + Math.min(rel - startUs, endUs - startUs) / 1e6) / total));
          });
        },
        error: e => logErr('デコード: ' + e.message),
      });
      decoder.configure(decCfg);
      for (const s of samples) {
        await whenQueueBelow(() => decoder.decodeQueueSize, decoder, 8);
        decoder.decode(new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round(s.cts * 1e6 / s.timescale),
          duration: Math.round(s.duration * 1e6 / s.timescale),
          data: s.data,
        }));
      }
      await decoder.flush(); decoder.close();
      await chain;
      offsetUs += Math.round(len * 1e6);
    }
    await encoder.flush(); encoder.close();

    if (audioBuf) {
      prog('音を書き込み中…', 0.94);
      const sr = 44100, alen = audioBuf.length;
      const aEnc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => logErr('AAC: ' + e.message) });
      aEnc.configure({ codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: 2, bitrate: 160000 });
      const L = audioBuf.getChannelData(0), R = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : audioBuf.getChannelData(0);
      const CH = 4410;
      for (let i = 0; i < alen; i += CH) {
        const n = Math.min(CH, alen - i);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(i, i + n), 0);
        data.set(R.subarray(i, i + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / sr * 1e6), data });
        await whenQueueBelow(() => aEnc.encodeQueueSize, aEnc, 8);
        aEnc.encode(ad); ad.close();
      }
      await aEnc.flush(); aEnc.close();
    }

    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const ov = $('outVideo');
    ov.src = url; ov.style.display = 'block';
    $('dlLink').href = url;
    $('saveRow').style.display = 'flex';
    $('shareBtn').onclick = async () => {
      try {
        const f = new File([blob], 'ひかりを編む.mp4', { type: 'video/mp4' });
        if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f] });
        else alert('この端末では共有が使えません。「保存」を使ってください');
      } catch (e) { }
    };
    prog(`完了！ ${fmt(total)}・${outW}×${outH}（${(blob.size / 1e6).toFixed(1)}MB）`, 1);
  } catch (e) {
    prog('失敗: ' + e.message, 0);
    logErr('書き出し: ' + e.message);
  }
  btn.disabled = false;
  exporting = false;
}
$('runExport').onclick = exportVideo;
$('goExportBtn').onclick = () => switchTab('export');

// ===== プリセット =====
function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  project.preset = name;
  project.aspect = p.aspect;
  project.fit = p.fit;
  project.effectPreset = p.effect;
  project.adjust.effect = p.effect;
  project.adjust.letterbox = p.letterbox;
  project.adjust.grain = FX[p.effect].gAmt / 400;
  project.adjust.grainSize = FX[p.effect].gSize / 100;
  project.muteAll = p.muteAll;
  project.autoAlign = p.autoAlign;
  project.impLen = p.impLen;
  const wantLut = p.lut;
  const has = wantLut === 'mine' ? project.mineLutData : wantLut === 'airu' ? project.airuLutData : true;
  project.lut = has ? wantLut : 'hikari';
  syncUIFromProject();
  redraw();
  scheduleSave();
}
$('presetDiary').onclick = () => { applyPreset('diary'); closePresetSheet(); };
$('presetMv').onclick = () => { applyPreset('mv'); closePresetSheet(); };
$('presetContinue').onclick = () => closePresetSheet();
$('openPresetBtn').onclick = () => $('presetSheet').classList.add('on');
function closePresetSheet() { $('presetSheet').classList.remove('on'); }
$('presetSheet').addEventListener('click', e => { if (e.target.id === 'presetSheet') closePresetSheet(); });

// ===== UI 配線 =====
// 同じタブをもう一度押すと閉じる（プレビューを広く使えるように）
function switchTab(name, forceOpen) {
  const cur = document.querySelector('.panel.on')?.id.replace('panel-', '');
  const close = !forceOpen && cur === name;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', !close && b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', !close && p.id === 'panel-' + name));
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

$('addClipBtn').onclick = () => $('addMenu').classList.toggle('on');
$('addVideoBtn').onclick = () => { $('addMenu').classList.remove('on'); $('fileInput').click(); };
$('addPhotoBtn').onclick = () => { $('addMenu').classList.remove('on'); $('photoFileInput').click(); };
document.addEventListener('click', e => {
  if (!e.target.closest('#addClipWrap')) $('addMenu').classList.remove('on');
});
$('fileInput').onchange = e => { addFiles([...e.target.files], 'video'); e.target.value = ''; };
$('photoFileInput').onchange = e => { addFiles([...e.target.files], 'photo'); e.target.value = ''; };

$('aspectSel').onchange = () => {
  project.aspect = $('aspectSel').value;
  applyAspectToCanvas();
  redraw();
};
function applyAspectToCanvas() {
  const a = ASPECTS[project.aspect];
  $('previewCanvas').width = a.prev[0];
  $('previewCanvas').height = a.prev[1];
}
$('fitSel').onchange = () => { project.fit = $('fitSel').value; redraw(); };

$('presetSel').onchange = () => { project.impLen = parseFloat($('presetSel').value); scheduleSave(); };
$('applyLenBtn').onclick = () => {
  const len = project.impLen;
  project.clips.forEach(c => {
    const max = c.kind === 'photo' ? PHOTO_MAX : c.dur;
    c.end = len > 0 ? clamp(c.start + len, c.start + 0.3, max) : max;
  });
  renderTimeline(); renderClipEdit();
  seekTimeline(Math.min(timelinePos, timelineDur()));
};

const sliderMap = {
  uStrength: v => project.adjust.strength = v / 100,
  uExposure: v => project.adjust.exposure = v / 100,
  uContrast: v => project.adjust.contrast = v / 200,
  uSaturation: v => project.adjust.saturation = v / 100,
  uFade: v => project.adjust.fade = v / 200,
  uGrain: v => project.adjust.grain = v / 400,
  uGrainSize: v => project.adjust.grainSize = v / 100,
};
for (const [id, fn] of Object.entries(sliderMap)) {
  const el = $(id);
  el.oninput = () => {
    fn(parseFloat(el.value));
    el.parentElement.querySelector('output').textContent = el.value;
    redraw();
  };
}
$('uLetterbox').onchange = () => { project.adjust.letterbox = $('uLetterbox').checked; redraw(); };
$('autoAlignChk').onchange = () => { project.autoAlign = $('autoAlignChk').checked; renderClipEdit(); redraw(); };
$('muteAllChk').onchange = () => {
  project.muteAll = $('muteAllChk').checked;
  project.clips.forEach(c => { if (c.kind === 'video') c.video.muted = project.muteAll || c.muted; });
  renderTimeline(); renderClipEdit(); scheduleSave();
};

document.querySelectorAll('#lutChips .chip').forEach(chip => {
  chip.onclick = () => {
    if (chip.dataset.lut === 'file' && !project.lutFileData) { $('lutFileInput').click(); return; }
    if (chip.dataset.lut === 'mine' && !project.mineLutData) return;
    if (chip.dataset.lut === 'airu' && !project.airuLutData) return;
    project.lut = chip.dataset.lut;
    document.querySelectorAll('#lutChips .chip').forEach(c => c.classList.toggle('on', c === chip));
    applyLutSelection(preview);
    redraw();
  };
});
$('lutFileInput').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    project.lutFileData = parseCube(text);
    project.lutFileText = text;
    project.lutFileName = f.name;
    project.lut = 'file';
    const chip = document.querySelector('#lutChips .chip[data-lut=file]');
    chip.textContent = f.name.replace(/\.cube$/i, '');
    document.querySelectorAll('#lutChips .chip').forEach(c => c.classList.toggle('on', c === chip));
    applyLutSelection(preview);
    redraw();
  } catch (err) { alert(err.message); }
  e.target.value = '';
};

document.querySelectorAll('#fxChips .chip').forEach(chip => {
  chip.onclick = () => {
    project.adjust.effect = parseInt(chip.dataset.fx);
    document.querySelectorAll('#fxChips .chip').forEach(c => c.classList.toggle('on', c === chip));
    const fx = FX[project.adjust.effect];
    $('uGrain').value = fx.gAmt;
    project.adjust.grain = fx.gAmt / 400;
    $('uGrain').parentElement.querySelector('output').textContent = fx.gAmt;
    $('uGrainSize').value = fx.gSize;
    project.adjust.grainSize = fx.gSize / 100;
    $('uGrainSize').parentElement.querySelector('output').textContent = fx.gSize;
    redraw();
  };
});

$('musicBtn').onclick = () => $('musicFileInput').click();
$('musicFileInput').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  const ab = await f.arrayBuffer();
  project.music = { name: f.name, arrayBuffer: ab, volume: parseFloat($('musicVol').value) / 100 };
  musicAudioBuf = null;
  $('musicName').textContent = f.name;
  idbPut('files', 'music', new Blob([ab])).catch(() => { });
  await ensureMusicBuffer().catch(() => { });
  renderTimeline();
  scheduleSave();
  e.target.value = '';
};
$('musicVol').oninput = () => {
  $('musicVol').parentElement.querySelector('output').textContent = $('musicVol').value;
  if (project.music) project.music.volume = parseFloat($('musicVol').value) / 100;
  scheduleSave();
};

// クリップ個別の操作
function selClip() { return project.clips.find(c => c.id === selId) || null; }
function renderClipEdit() {
  const c = selClip();
  $('clipEdit').style.display = c ? 'block' : 'none';
  $('clipHint').style.display = c ? 'none' : 'block';
  if (!c) return;
  const i = project.clips.indexOf(c);
  $('clipTitleLabel').textContent = `${c.kind === 'photo' ? '写真' : 'クリップ'} ${i + 1}（${clipLen(c).toFixed(1)}秒）`;
  $('clipBright').value = Math.round(c.bright * 100);
  $('clipBright').parentElement.querySelector('output').textContent = Math.round(c.bright * 100);
  $('clipTemp').value = Math.round(c.temp * 100);
  $('clipTemp').parentElement.querySelector('output').textContent = Math.round(c.temp * 100);
  const ab = c.autoBright || 0, at = c.autoTemp || 0;
  $('autoReadout').textContent = project.autoAlign && (ab || at)
    ? `自動そろえ: 明るさ ${ab >= 0 ? '+' : ''}${(ab).toFixed(2)}EV / 色 ${at >= 0 ? '+' : ''}${(at * 100).toFixed(0)}`
    : '';
  const mb = $('muteClipBtn');
  mb.style.display = c.kind === 'video' ? '' : 'none';
  mb.textContent = c.muted ? '🔈 ミュートを解除' : '🔇 このクリップをミュート';
  mb.classList.toggle('on', !!c.muted);
}
$('clipBright').oninput = () => {
  const c = selClip(); if (!c) return;
  c.bright = parseFloat($('clipBright').value) / 100;
  $('clipBright').parentElement.querySelector('output').textContent = $('clipBright').value;
  redraw();
};
$('clipTemp').oninput = () => {
  const c = selClip(); if (!c) return;
  c.temp = parseFloat($('clipTemp').value) / 100;
  $('clipTemp').parentElement.querySelector('output').textContent = $('clipTemp').value;
  redraw();
};
function moveClip(d) {
  const i = project.clips.findIndex(c => c.id === selId);
  if (i < 0 || i + d < 0 || i + d >= project.clips.length) return;
  const [c] = project.clips.splice(i, 1);
  project.clips.splice(i + d, 0, c);
  renderTimeline(); renderClipEdit();
  seekTimeline(timelinePos);
}
$('moveL').onclick = () => moveClip(-1);
$('moveR').onclick = () => moveClip(1);
$('muteClipBtn').onclick = () => {
  const c = selClip(); if (!c || c.kind !== 'video') return;
  c.muted = !c.muted;
  c.video.muted = project.muteAll || c.muted;
  renderTimeline(); renderClipEdit(); scheduleSave();
};
$('dupClip').onclick = async () => {
  const c = selClip(); if (!c) return;
  const i = project.clips.indexOf(c);
  try {
    const copy = await createClip(c.file, {
      kind: c.kind, name: c.name, start: c.start, end: c.end, thumb: c.thumb,
      bright: c.bright, temp: c.temp, autoBright: c.autoBright, autoTemp: c.autoTemp, muted: c.muted,
    });
    project.clips.splice(i + 1, 0, copy);
    idbPut('files', copy.id, copy.file).catch(() => { });
    selId = copy.id;
    renderTimeline(); renderClipEdit();
    seekTimeline(sumBefore(i + 1));
  } catch (e) { logErr(e.message); }
};
$('delClip').onclick = () => {
  const i = project.clips.findIndex(c => c.id === selId);
  if (i < 0) return;
  URL.revokeObjectURL(project.clips[i].url);
  idbDel('files', project.clips[i].id).catch(() => { });
  project.clips.splice(i, 1);
  selId = project.clips[Math.min(i, project.clips.length - 1)]?.id || null;
  if (playIdx >= project.clips.length) playIdx = Math.max(0, project.clips.length - 1);
  renderTimeline(); renderClipEdit();
  $('emptyHint').style.display = project.clips.length ? 'none' : 'flex';
  if (project.clips.length) seekTimeline(Math.min(timelinePos, timelineDur()));
  else clearPreview();
};

function clearPreview() {
  const gl = preview.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  lastDrawn = null;
  timelinePos = 0;
  updateTimeLabel();
}

$('resetProject').onclick = async () => {
  if (!confirm('いま並べている作品をすべて消して、新しく始めますか？')) return;
  stopPlayback();
  project.clips.forEach(c => URL.revokeObjectURL(c.url));
  project.clips = [];
  project.music = null;
  musicAudioBuf = null;
  selId = null;
  playIdx = 0;
  $('musicName').textContent = '未選択';
  await idbClear('files').catch(() => { });
  await idbClear('state').catch(() => { });
  renderTimeline(); renderClipEdit();
  $('emptyHint').style.display = 'flex';
  clearPreview();
  $('presetSheet').classList.add('on');
};

// ===== 開発モード（?dev=1）=====
if (new URLSearchParams(location.search).has('dev')) {
  $('devbar').style.display = 'flex';
  $('devClip').onclick = async () => {
    // 取り込み長さの検証ができるよう、サンプルは6秒（既定の3秒より長く）作る
    const hue = 180 + Math.random() * 120 | 0;
    const w = 1280, h = 720, fps = 24, totalF = 144;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const x = cv.getContext('2d');
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: w, height: h }, audio: { codec: 'aac', sampleRate: 44100, numberOfChannels: 2 }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
    const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => logErr(e.message) });
    enc.configure({ codec: 'avc1.640028', width: w, height: h, bitrate: 6e6, framerate: fps });
    const aEnc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => logErr(e.message) });
    aEnc.configure({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, bitrate: 96000 });
    const silentLen = Math.round(totalF / fps * 44100);
    for (let i = 0; i < silentLen; i += 4410) {
      const nfr = Math.min(4410, silentLen - i);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 44100, numberOfFrames: nfr, numberOfChannels: 2, timestamp: Math.round(i / 44100 * 1e6), data: new Float32Array(nfr * 2) });
      aEnc.encode(ad); ad.close();
    }
    await aEnc.flush(); aEnc.close();
    for (let i = 0; i < totalF; i++) {
      const t = i / totalF;
      x.fillStyle = `hsl(${hue}, 30%, ${65 - t * 12}%)`; x.fillRect(0, 0, w, h * 0.6);
      x.fillStyle = `hsl(${hue + 40}, 25%, ${35 - t * 6}%)`; x.fillRect(0, h * 0.6, w, h * 0.4);
      x.fillStyle = 'hsl(45, 85%, 84%)';
      x.beginPath(); x.arc(w * (0.2 + t * 0.6), h * (0.32 - Math.sin(t * Math.PI) * 0.12), 42, 0, Math.PI * 2); x.fill();
      x.fillStyle = 'rgba(255,255,255,.9)'; x.font = 'bold 52px sans-serif'; x.fillText(String(i + 1), 36, h - 36);
      const f = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      await whenQueueBelow(() => enc.encodeQueueSize, enc, 4);
      enc.encode(f, { keyFrame: i % 24 === 0 }); f.close();
      if (i % 12 === 0) $('exportProg').textContent = `サンプル動画を生成中… ${i}/${totalF}`;
    }
    await enc.flush(); enc.close(); muxer.finalize();
    $('exportProg').textContent = '';
    const file = new File([new Blob([muxer.target.buffer], { type: 'video/mp4' })], `サンプル${hue}.mp4`, { type: 'video/mp4' });
    addFiles([file], 'video');
  };
  $('devPhoto').onclick = async () => {
    const hue = Math.random() * 360 | 0;
    const cv = document.createElement('canvas');
    cv.width = 1200; cv.height = 900;
    const x = cv.getContext('2d');
    x.fillStyle = `hsl(${hue}, 35%, 72%)`; x.fillRect(0, 0, 1200, 900);
    x.fillStyle = `hsl(${hue + 30}, 30%, 42%)`; x.fillRect(0, 560, 1200, 340);
    x.fillStyle = 'hsl(48, 90%, 88%)';
    x.beginPath(); x.arc(340, 260, 90, 0, Math.PI * 2); x.fill();
    x.fillStyle = 'rgba(255,255,255,.9)'; x.font = 'bold 64px sans-serif'; x.fillText('PHOTO', 60, 840);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
    addFiles([new File([blob], `写真${hue}.jpg`, { type: 'image/jpeg' })], 'photo');
  };
  $('devMusic').onclick = () => {
    ensureAudioCtx();
    const sr = 44100, dur = 12, buf = audioCtx.createBuffer(2, sr * dur, sr);
    const notes = [261.6, 329.6, 392.0, 523.3, 392.0, 329.6];
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr, note = notes[Math.floor(t * 1.5) % notes.length];
        d[i] = Math.sin(t * 2 * Math.PI * note) * 0.22 * (0.6 + 0.4 * Math.sin(t * 3));
      }
    }
    project.music = { name: 'サンプル音楽', audioBuffer: buf, volume: 0.7 };
    musicAudioBuf = buf;
    $('musicName').textContent = 'サンプル音楽';
    renderTimeline();
  };
  window._dbg = () => ({
    playing, playIdx, timelinePos: +timelinePos.toFixed(2), total: +timelineDur().toFixed(2),
    lut: project.lut, fx: project.adjust.effect, muteAll: project.muteAll, autoAlign: project.autoAlign,
    blocks: document.querySelectorAll('.clipBlock').length,
    clips: project.clips.map(c => ({
      kind: c.kind, start: +c.start.toFixed(2), end: +c.end.toFixed(2), muted: !!c.muted,
      autoBright: +(c.autoBright || 0).toFixed(2), autoTemp: +(c.autoTemp || 0).toFixed(2),
    })),
  });
}

// ===== 起動 =====
function syncUIFromProject() {
  $('aspectSel').value = project.aspect;
  applyAspectToCanvas();
  $('fitSel').value = project.fit;
  $('presetSel').value = String(project.impLen);
  $('autoAlignChk').checked = project.autoAlign;
  $('muteAllChk').checked = project.muteAll;
  const ad = project.adjust;
  const setS = (id, v) => { const el = $(id); el.value = Math.round(v); el.parentElement.querySelector('output').textContent = Math.round(v); };
  setS('uStrength', ad.strength * 100);
  setS('uExposure', ad.exposure * 100);
  setS('uContrast', ad.contrast * 200);
  setS('uSaturation', ad.saturation * 100);
  setS('uFade', ad.fade * 200);
  setS('uGrain', ad.grain * 400);
  setS('uGrainSize', ad.grainSize * 100);
  $('uLetterbox').checked = ad.letterbox;
  document.querySelectorAll('#lutChips .chip').forEach(c => c.classList.toggle('on', c.dataset.lut === project.lut));
  if (project.lutFileName) document.querySelector('#lutChips .chip[data-lut=file]').textContent = project.lutFileName.replace(/\.cube$/i, '');
  document.querySelectorAll('#fxChips .chip').forEach(c => c.classList.toggle('on', parseInt(c.dataset.fx) === ad.effect));
  if (project.music) $('musicName').textContent = project.music.name;
  project.clips.forEach(c => { if (c.kind === 'video') c.video.muted = project.muteAll || c.muted; });
  applyLutSelection(preview);
  renderTimeline(); renderClipEdit();
  $('emptyHint').style.display = project.clips.length ? 'none' : 'flex';
}

(async function init() {
  try { navigator.storage?.persist?.(); } catch (e) { }
  let st = null;
  try { st = await idbGet('state', 'project'); } catch (e) { }
  await Promise.all([
    loadBuiltinLut('./jibun-no-iro.cube', 'mineLutData', 'mine'),
    loadBuiltinLut('./airu.cube', 'airuLutData', 'airu'),
  ]);
  if (st) {
    try {
      project.aspect = st.aspect || '16:9';
      project.fit = st.fit || 'contain';
      Object.assign(project.adjust, st.adjust || {});
      project.muteAll = !!st.muteAll;
      project.autoAlign = st.autoAlign !== false;
      project.impLen = st.impLen ?? 3;
      project.preset = st.preset || null;
      clipSeq = st.clipSeq || 0;
      if (st.lutFileText) {
        try { project.lutFileData = parseCube(st.lutFileText); project.lutFileText = st.lutFileText; project.lutFileName = st.lutFileName; } catch (e) { }
      }
      project.lut = st.lut || 'hikari';
      for (const m of st.clips || []) {
        const blob = await idbGet('files', m.id).catch(() => null);
        if (!blob) continue;
        try { project.clips.push(await createClip(blob, m)); }
        catch (e) { logErr('復元できない素材: ' + m.name); }
      }
      if (st.music?.stored) {
        const mb = await idbGet('files', 'music').catch(() => null);
        if (mb) project.music = { name: st.music.name, arrayBuffer: await mb.arrayBuffer(), volume: st.music.volume };
      }
      selId = project.clips[0]?.id || null;
    } catch (e) { logErr('復元エラー: ' + e.message); }
  }
  if (project.lut === 'mine' && !project.mineLutData) project.lut = 'hikari';
  if (project.lut === 'airu' && !project.airuLutData) project.lut = 'hikari';
  if (project.lut === 'file' && !project.lutFileData) project.lut = 'hikari';
  if (!st && project.mineLutData) project.lut = 'mine';
  if (project.music) await ensureMusicBuffer().catch(() => { });
  syncUIFromProject();
  if (project.clips.length) seekTimeline(0);
  if (!st || !project.clips.length) $('presetSheet').classList.add('on');
  ready = true;
})();
