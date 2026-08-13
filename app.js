// ひかりを編む — 編集エンジン
// プレビューも書き出しも同じ多段描画（グレード→ブルーム→仕上げ）を通す（色一致の要）
import { Muxer, ArrayBufferTarget } from 'https://esm.sh/mp4-muxer@5';

const $ = id => document.getElementById(id);
const logEl = $('log');
const logErr = t => { logEl.textContent += t + '\n'; };
window.addEventListener('error', e => logErr('エラー: ' + e.message));
window.addEventListener('unhandledrejection', e => logErr('エラー: ' + (e.reason?.message || e.reason)));
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function whenQueueBelow(getSize, target, max) {
  return new Promise(res => {
    if (getSize() <= max) return res();
    let iv;
    const h = () => { if (getSize() <= max) { clearInterval(iv); target.removeEventListener?.('dequeue', h); res(); } };
    target.addEventListener?.('dequeue', h);
    iv = setInterval(h, 15);
  });
}

// ===== 状態 =====
const project = {
  aspect: '16:9',
  fit: 'contain',      // 'contain'=切れないように収める / 'cover'=画面いっぱい（切り抜き）
  clips: [],           // {id, file, url, video, name, dur, w, h, start, end, thumb, bright, temp}
  lut: 'hikari',       // 'mine' | 'airu' | 'hikari' | 'none' | 'file'
  mineLutData: null,
  airuLutData: null,
  lutFileData: null,
  adjust: { exposure: 0, contrast: 0, saturation: 0, fade: 0, grain: 0.12 / 4, grainSize: 1, letterbox: true, strength: 0.85, effect: 0 },
  music: null,         // {name, arrayBuffer?|audioBuffer?, volume}
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
    gl.uniform1f(u.uExposure, a.exposure + (clip?.bright || 0));
    gl.uniform1f(u.uTemp, clip?.temp || 0);
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

// 内蔵LUT（自分の色・アイル）をアプリと同じ場所から読み込む
async function loadBuiltinLut(url, key, lutName, makeDefault) {
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    project[key] = parseCube(await r.text());
    const chip = document.querySelector(`#lutChips .chip[data-lut=${lutName}]`);
    chip.style.display = '';
    if (makeDefault) {
      project.lut = lutName;
      document.querySelectorAll('#lutChips .chip').forEach(c => c.classList.toggle('on', c === chip));
      applyLutSelection(preview);
      redraw();
    }
  } catch (e) { }
}
loadBuiltinLut('./jibun-no-iro.cube', 'mineLutData', 'mine', true);
loadBuiltinLut('./airu.cube', 'airuLutData', 'airu', false);

// ===== クリップ取り込み =====
async function addFiles(files) {
  for (const file of files) {
    try {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.src = url; video.muted = true; video.playsInline = true; video.preload = 'auto';
      await new Promise((res, rej) => {
        video.onloadedmetadata = res;
        video.onerror = () => rej(new Error('この動画は読み込めませんでした: ' + file.name));
        setTimeout(() => rej(new Error('読み込みタイムアウト: ' + file.name)), 15000);
      });
      const dur = video.duration;
      const preset = parseFloat($('presetSel').value);
      const clip = {
        id: 'c' + (++clipSeq), file, url, video, name: file.name,
        dur, w: video.videoWidth, h: video.videoHeight,
        start: 0, end: preset > 0 ? Math.min(preset, dur) : dur, thumb: '',
        bright: 0, temp: 0,
      };
      project.clips.push(clip);
      video.addEventListener('seeked', () => { if (!playing && lastSrc?.clip === clip) drawStill(clip); });
      const advance = () => { if (playing && project.clips[playIdx]?.video === video) { checkAdvance(); updateTimeLabel(); } };
      video.addEventListener('timeupdate', advance);
      video.addEventListener('ended', advance);
      video.addEventListener('pause', () => {
        if (playing && project.clips[playIdx]?.video === video && !video.ended && video.currentTime < clip.end - 0.05)
          setTimeout(() => { if (playing && project.clips[playIdx]?.video === video) video.play().catch(() => { }); }, 250);
      });
      await makeThumb(clip);
      selId = clip.id;
      renderStrip(); renderClipEdit();
      showFrame(clip);
    } catch (e) { logErr(e.message); }
  }
  $('emptyHint').style.display = project.clips.length ? 'none' : 'flex';
}

async function makeThumb(clip) {
  const v = clip.video;
  await new Promise(res => {
    const h = () => { v.removeEventListener('seeked', h); res(); };
    v.addEventListener('seeked', h);
    v.currentTime = Math.min(clip.start + 0.1, Math.max(0, clip.dur - 0.05));
    setTimeout(res, 3000);
  });
  const c = document.createElement('canvas');
  c.width = 120; c.height = 72;
  const x = c.getContext('2d');
  const ar = v.videoWidth / v.videoHeight, arT = 120 / 72;
  let sw = v.videoWidth, sh = v.videoHeight, sx = 0, sy = 0;
  if (ar > arT) { sw = v.videoHeight * arT; sx = (v.videoWidth - sw) / 2; }
  else { sh = v.videoWidth / arT; sy = (v.videoHeight - sh) / 2; }
  x.drawImage(v, sx, sy, sw, sh, 0, 0, 120, 72);
  clip.thumb = c.toDataURL('image/jpeg', 0.6);
}

// ===== クリップ帯 UI =====
function selClip() { return project.clips.find(c => c.id === selId) || null; }

function renderStrip() {
  const strip = $('clipStrip');
  strip.querySelectorAll('.clipCard').forEach(e => e.remove());
  const add = $('addCard');
  project.clips.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'clipCard' + (c.id === selId ? ' sel' : '');
    d.innerHTML = `<img src="${c.thumb}"><span class="n">${i + 1}</span><div class="d">${(c.end - c.start).toFixed(1)}秒</div>`;
    d.onclick = () => {
      selId = c.id;
      renderStrip(); renderClipEdit();
      switchTab('clips');
      showFrame(c);
    };
    strip.insertBefore(d, add);
  });
  updateTimeLabel();
}

function renderClipEdit() {
  const c = selClip();
  $('clipEdit').style.display = c ? 'block' : 'none';
  $('clipHint').style.display = c ? 'none' : 'block';
  if (!c) return;
  const ts = $('trimStart'), te = $('trimEnd');
  ts.max = te.max = c.dur.toFixed(1);
  ts.value = c.start; te.value = c.end;
  $('trimStartOut').textContent = c.start.toFixed(1);
  $('trimEndOut').textContent = c.end.toFixed(1);
  $('clipBright').value = Math.round(c.bright * 100);
  $('clipBright').parentElement.querySelector('output').textContent = Math.round(c.bright * 100);
  $('clipTemp').value = Math.round(c.temp * 100);
  $('clipTemp').parentElement.querySelector('output').textContent = Math.round(c.temp * 100);
}

function showFrame(clip) {
  if (playing) return;
  lastSrc = { clip };
  const v = clip.video;
  const t = Math.min(Math.max(v.currentTime, clip.start), Math.max(clip.start, clip.end - 0.05));
  if (Math.abs(v.currentTime - t) > 0.05) v.currentTime = t;
  else drawStill(clip);
}

let lastSrc = null;
function drawStill(clip) {
  if (clip.video.readyState >= 2)
    preview.draw(clip.video, clip.video.videoWidth, clip.video.videoHeight, 0, performance.now() * 0.03, clip);
}
function redraw() {
  if (playing) return;
  if (lastSrc?.clip) drawStill(lastSrc.clip);
}

// ===== 再生 =====
let playing = false, playIdx = 0, rafId = 0, lastPrevDraw = 0;
let audioCtx = null, musicSrc = null, musicGain = null, musicAudioBuf = null;

function timelineDur() { return project.clips.reduce((s, c) => s + (c.end - c.start), 0); }
function sumBefore(i) { return project.clips.slice(0, i).reduce((s, c) => s + (c.end - c.start), 0); }

async function ensureMusicBuffer() {
  if (!project.music || musicAudioBuf) return;
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
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

async function play() {
  if (!project.clips.length || playing) return;
  playing = true;
  $('playBtn').textContent = '❚❚';
  const c0 = project.clips[playIdx] || project.clips[0];
  playIdx = project.clips.indexOf(c0);
  const v = c0.video;
  if (v.currentTime < c0.start || v.currentTime >= c0.end - 0.05) v.currentTime = c0.start;
  await ensureMusicBuffer().catch(e => logErr('音楽: ' + e.message));
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
  if (musicAudioBuf) startMusic(sumBefore(playIdx) + (v.currentTime - c0.start));
  await v.play();
  loop();
}
function checkAdvance() {
  const c = project.clips[playIdx];
  if (!c) { stopPlayback(); return; }
  const v = c.video;
  if (v.currentTime >= c.end || v.ended) {
    v.pause();
    if (playIdx < project.clips.length - 1) {
      playIdx++;
      const n = project.clips[playIdx];
      n.video.currentTime = n.start;
      n.video.play().catch(() => {
        const retry = () => { if (playing) n.video.play().catch(e => logErr('遷移play: ' + e.name)); };
        document.addEventListener('visibilitychange', retry, { once: true });
        setTimeout(retry, 400);
      });
    } else stopPlayback(true);
  }
}
function loop() {
  if (!playing) return;
  const c = project.clips[playIdx];
  if (c) {
    const now = performance.now();
    // 8mm強めはコマ落とし（12fps）をプレビューでも再現
    if (FX[project.adjust.effect].cadence === 0 || now - lastPrevDraw > 1000 / FX[project.adjust.effect].cadence) {
      const v = c.video;
      preview.draw(v, v.videoWidth, v.videoHeight, 0, now * 0.03, c);
      lastPrevDraw = now;
    }
    updateTimeLabel();
    checkAdvance();
  }
  rafId = requestAnimationFrame(loop);
}
function stopPlayback(atEnd) {
  playing = false;
  cancelAnimationFrame(rafId);
  project.clips[playIdx]?.video.pause();
  stopMusic();
  $('playBtn').textContent = '▶';
  if (atEnd) playIdx = 0;
  updateTimeLabel();
}
function updateTimeLabel() {
  const c = project.clips[playIdx];
  const t = c ? sumBefore(playIdx) + Math.max(0, c.video.currentTime - c.start) : 0;
  $('timeLabel').textContent = `${fmt(Math.min(t, timelineDur()))} / ${fmt(timelineDur())}`;
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
    const withMusic = !!project.music;
    if (withMusic) await ensureMusicBuffer();

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: outW, height: outH },
      ...(withMusic ? { audio: { codec: 'aac', sampleRate: 44100, numberOfChannels: 2 } } : {}),
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
    for (let ci = 0; ci < project.clips.length; ci++) {
      const clip = project.clips[ci];
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
            const out = new VideoFrame(exCanvas, { timestamp: outTs, duration: cadUs ? Math.round(cadUs) : (frame.duration ?? undefined) });
            frame.close();
            await whenQueueBelow(() => encoder.encodeQueueSize, encoder, 4);
            const key = outTs - lastKeyUs >= 2e6;
            if (key) lastKeyUs = outTs;
            encoder.encode(out, { keyFrame: key });
            out.close();
            frameCount++;
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
      offsetUs += Math.round((clip.end - clip.start) * 1e6);
    }
    await encoder.flush(); encoder.close();

    if (withMusic && musicAudioBuf) {
      prog('音楽を合成中…', 0.92);
      const sr = 44100, len = Math.ceil(total * sr);
      const off = new OfflineAudioContext(2, len, sr);
      const src = off.createBufferSource();
      src.buffer = musicAudioBuf;
      const g = off.createGain();
      src.connect(g).connect(off.destination);
      const vol = project.music.volume;
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(vol, Math.min(1, total));
      if (total > 1.5) { g.gain.setValueAtTime(vol, total - 1.5); g.gain.linearRampToValueAtTime(0, total); }
      src.start(0);
      const rendered = await off.startRendering();
      const aEnc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => logErr('AAC: ' + e.message) });
      aEnc.configure({ codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: 2, bitrate: 160000 });
      const L = rendered.getChannelData(0), R = rendered.getChannelData(1);
      const CH = 4410;
      for (let i = 0; i < len; i += CH) {
        const n = Math.min(CH, len - i);
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

// ===== UI 配線 =====
function switchTab(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'panel-' + name));
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

$('addCard').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };

$('aspectSel').onchange = () => {
  project.aspect = $('aspectSel').value;
  const a = ASPECTS[project.aspect];
  $('previewBox').style.aspectRatio = a.css;
  $('previewCanvas').width = a.prev[0];
  $('previewCanvas').height = a.prev[1];
  redraw();
};
$('previewBox').style.aspectRatio = ASPECTS['16:9'].css;
$('fitSel').onchange = () => { project.fit = $('fitSel').value; redraw(); };

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
    project.lutFileData = parseCube(await f.text());
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
    // 粒子の量・大きさをモードの推奨値に自動設定（その後の手動調整は自由）
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
  project.music = { name: f.name, arrayBuffer: await f.arrayBuffer(), volume: parseFloat($('musicVol').value) / 100 };
  musicAudioBuf = null;
  $('musicName').textContent = f.name;
  e.target.value = '';
};
$('musicVol').oninput = () => {
  $('musicVol').parentElement.querySelector('output').textContent = $('musicVol').value;
  if (project.music) project.music.volume = parseFloat($('musicVol').value) / 100;
};

$('moveL').onclick = () => moveClip(-1);
$('moveR').onclick = () => moveClip(1);
function moveClip(d) {
  const i = project.clips.findIndex(c => c.id === selId);
  if (i < 0 || i + d < 0 || i + d >= project.clips.length) return;
  const [c] = project.clips.splice(i, 1);
  project.clips.splice(i + d, 0, c);
  renderStrip();
}
$('delClip').onclick = () => {
  const i = project.clips.findIndex(c => c.id === selId);
  if (i < 0) return;
  URL.revokeObjectURL(project.clips[i].url);
  project.clips.splice(i, 1);
  selId = project.clips[Math.min(i, project.clips.length - 1)]?.id || null;
  renderStrip(); renderClipEdit();
  $('emptyHint').style.display = project.clips.length ? 'none' : 'flex';
  const c = selClip();
  if (c) showFrame(c);
};
$('trimStart').oninput = () => {
  const c = selClip(); if (!c) return;
  c.start = Math.min(parseFloat($('trimStart').value), c.end - 0.2);
  $('trimStart').value = c.start;
  $('trimStartOut').textContent = c.start.toFixed(1);
  c.video.currentTime = c.start;
  renderStripDurations();
};
$('trimEnd').oninput = () => {
  const c = selClip(); if (!c) return;
  c.end = Math.max(parseFloat($('trimEnd').value), c.start + 0.2);
  $('trimEnd').value = c.end;
  $('trimEndOut').textContent = c.end.toFixed(1);
  c.video.currentTime = Math.max(c.start, c.end - 0.05);
  renderStripDurations();
};
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
function renderStripDurations() {
  document.querySelectorAll('.clipCard').forEach((d, i) => {
    const c = project.clips[i];
    if (c) d.querySelector('.d').textContent = (c.end - c.start).toFixed(1) + '秒';
  });
  updateTimeLabel();
}

// ===== 開発モード（?dev=1）=====
if (new URLSearchParams(location.search).has('dev')) {
  $('devbar').style.display = 'flex';
  $('devClip').onclick = async () => {
    const hue = 180 + Math.random() * 120 | 0;
    const w = 1280, h = 720, fps = 24, totalF = 60;
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
    addFiles([file]);
  };
  $('devMusic').onclick = () => {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
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
  };
  window._dbg = () => ({
    playing, playIdx,
    clips: project.clips.map(c => ({ t: c.video.currentTime, paused: c.video.paused, ended: c.video.ended, rs: c.video.readyState, start: c.start, end: c.end })),
  });
  window._play = async i => {
    try { await project.clips[i].video.play(); return 'ok'; }
    catch (e) { return e.name + ': ' + e.message; }
  };
}
