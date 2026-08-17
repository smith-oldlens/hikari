// ひかりを編む — 編集エンジン
// プレビューも書き出しも同じ多段描画（グレード→ブルーム→仕上げ）を通す（色一致の要）
// 同梱版（vendor/）から読む。外の配信が落ちても、電波が無くても書き出せるようにするため
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';

const $ = id => document.getElementById(id);
const logEl = $('log');
// 画面上端に出るので、読み終えたら消せるようにする（触ると即消え、10秒で自動的に消える）
let logTimer = 0;
const logErr = t => {
  logEl.textContent += t + '\n';
  clearTimeout(logTimer);
  logTimer = setTimeout(() => { logEl.textContent = ''; }, 10000);
};
logEl.addEventListener('pointerdown', () => { clearTimeout(logTimer); logEl.textContent = ''; });
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
// ?dev=1 のときだけ記録する診断リングバッファ（最新50件）。
// 描画・保存・書き出しには一切影響しない。実機で「効かない」現象の経路を特定するために使う。
const DEV_TRACE = new URLSearchParams(location.search).has('dev');
const traceBuf = [];
// dataは関数で渡す。?dev=1でないときは中身を一切評価しない（本番の負荷ゼロ）。
function trace(tag, data) {
  if (!DEV_TRACE) return;
  traceBuf.push({ ms: Math.round(performance.now()), tag, ...data() });
  if (traceBuf.length > 80) traceBuf.shift();
}
// ?dev=1 の有無に関係なく必ず残す最小限の診断（入力と詰まりだけ）。
// trace() をdev限定にしていたせいで、実機で「押せない」が起きても手元に何も残らなかった（2026-08-15）。
// 実機の不具合は実機でしか出ない。その1回を取りこぼさないための記録。
function diag(tag, data) {
  traceBuf.push({ ms: Math.round(performance.now()), tag, ...data() });
  if (traceBuf.length > 80) traceBuf.shift();
}
// fast=true はスクラブ用（近いキーフレームへ飛ぶので速い）。書き出し前の位置合わせは正確なシークを使う
function seekTo(video, t, fast) {
  return new Promise(res => {
    if (Math.abs(video.currentTime - t) < 0.02) return res();
    let done = false;
    const finish = viaTimeout => {
      if (done) return;
      done = true; video.removeEventListener('seeked', onSeeked);
      if (viaTimeout) trace('seekTo.timeout', () => ({ to: +t.toFixed(3), cur: +video.currentTime.toFixed(3) }));
      res();
    };
    const onSeeked = () => finish(false);
    video.addEventListener('seeked', onSeeked);
    if (fast && video.fastSeek) { try { video.fastSeek(t); } catch (e) { video.currentTime = t; } }
    else video.currentTime = t;
    setTimeout(() => finish(true), 2500);
  });
}

// ===== 状態 =====
// 実機検証の生命線。画面の版数と一致しないJSが動いていたら、それはキャッシュ・生き残ったタブの仕業。
// 「押せない」系の報告が来たら、直す前にまずこの表示を確認してもらう（2026-08-15の教訓）
const APP_VERSION = '2026-08-22d';
// 作品の保存の形。**1 の時代に無かったもの**＝文字・つなぎの手動指定・おわり・音楽の位置とループ。
// 形そのものは 1 のまま読めるが、**意味が変わった項目**（周辺減光）があるので、
// どちらの時代に保存されたのかを見分けられるようにした。
// 版を上げるのは「読み方を変えないと正しく開けなくなったとき」だけ。項目を足しただけなら上げない
// （足した項目は既定値で埋まるので、古い作品もそのまま開ける）。
const PROJECT_FORMAT = 2;
{
  const el = () => document.getElementById('appVer');
  const loadedVer = (document.querySelector('script[src*="app.js"]')?.getAttribute('src')?.match(/v=([\w.-]+)/) || [])[1];
  const show = () => { if (el()) el().textContent = '版 ' + APP_VERSION + (loadedVer && loadedVer !== APP_VERSION ? '（混在！）' : ''); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', show) : show();
  // サーバに新しい版が出ていないかを、開いたとき・画面に戻ったときに確かめる。
  // Androidはタブを何日も生かすので、開き直したつもりでも古いJSのまま動き続ける
  let lastCheck = 0;
  const checkStale = async () => {
    if (Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    try {
      const html = await (await fetch('./', { cache: 'no-store' })).text();
      const server = (html.match(/app\.js\?v=([\w.-]+)/) || [])[1];
      if (server && server !== APP_VERSION && el()) {
        el().textContent = '新しい版があります。タブを閉じて開き直してください';
        el().classList.add('stale');
      }
    } catch (_) { /* オフラインでも編集は止めない */ }
  };
  setTimeout(checkStale, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkStale(); });
}

// 実機の「押しても遅い」を記録する。200ms超の長タスクと、pointerdownが処理されるまでの遅れ。
// dev ▾ → ログ で読める（Fold7からログを持ち出す既存の仕組みに乗せる）
try {
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) if (e.duration >= 200) diag('詰まり', () => ({ 長さ: Math.round(e.duration) + 'ms' }));
  }).observe({ entryTypes: ['longtask'] });
} catch (_) { }
// 押した瞬間から処理が始まるまでの遅れ
document.addEventListener('pointerdown', e => {
  const lag = performance.now() - e.timeStamp;
  if (lag > 150) diag('反応の遅れ', () => ({ 遅れ: Math.round(lag) + 'ms' }));
}, true);
// 押したときに実際どのイベントが届いたかを残す。
// 「押しても何も起きない」の原因は、指を離した合図(離)や押下確定(押)が来ていないことが多い。
// このログを見れば、来ていないのがどれかが一目で分かる
{
  const label = el => el.dataset.tab || el.dataset.tool || el.dataset.ttool || el.dataset.act
    || el.dataset.slider || el.id || (el.textContent || '').trim().slice(0, 8) || 'ボタン';
  const jp = { pointerdown: '触れた', pointerup: '離した', pointercancel: '取消', click: '押された' };
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) {
    document.addEventListener(type, e => {
      // labelを押すとブラウザが中のcheckboxにもclickを送る。そのぶんは数えない
      // （数えていたせいで、スイッチが毎回「押された」2回に見えていた）
      if (e.target.matches?.('input[type=checkbox]') && e.target.closest?.('label.sw')) return;
      const el = e.target.closest?.('button, .chip, .tool, .card, label.sw');
      if (el) diag(jp[type], () => ({ 対象: label(el) }));
    }, true);
  }
}

const DEFAULT_ADJUST = Object.freeze({
  exposure: 0, contrast: 0, saturation: 0, fade: 0,
  grain: 0.12 / 4, grainSize: 1, glow: 1, halation: 0,
  letterbox: true, strength: 0.85, effect: 0, damage: 0,
  handheld: 0,          // 手ブレ（v5-4）。0=OFF。全エフェクトは既定0で、回帰18本を不変に保つ
  leak: 0,              // 感光＝光漏れ（v5-5）。0=OFF
  trans: 0,             // つなぎ＝白ディゾルブ＋ロールエンドバーン（v5-8）。0=OFF
  vig: 4,               // 周辺減光の倍率（v8-6）。フェーダー0=1.0倍が下限、既定はフェーダー300＝4.0倍。
                        // 上限はフェーダー500＝6.0倍。0=切
  endDur: 1.5,          // おわり（v8-20）。最後のクリップのあとに足す余韻の秒数。0=無し
  endDark: 0,           // おわりの色。0=白 / 1=黒
  judder: 0,            // コマ落ち（v5-9）。0=素材のまま / 1=実効19fps相当
});

// 完成イメージ（プリセット）を選んだときに入る「動き」の推奨値。すべてMV/8mmの実測由来。
// アプリの理念は「読み込んだ段階でプリセットがあたり、強弱だけ調整して書き出せる」こと。
// 動き系を既定OFFにしていた当初の理由（回帰検査が壊れる）は、
// 回帰測定側で動き系を0に固定するようにした時点で消えている（2026-08-15）。
const MOTION_RECOMMEND = {
  diary: { handheld: 0.35, leak: 0.25, trans: 0.40, judder: 0.45 },
  mv:    { handheld: 0.55, leak: 0.35, trans: 0.60, judder: 1.00 },  // アイル実測一式
  film8: { handheld: 0.85, leak: 0.55, trans: 0.50, judder: 0 },     // Super8は18fps常時なのでコマ落ちは0
};
const MOTION_KEYS = ['handheld', 'leak', 'trans', 'judder'];

// テキストは書き出し解像度で一度だけ描き、あとは板ポリとして貼る。
// プレビューと書き出しで別解像度で描くと、縁のにじみ方が一致しなくなる。
const textRasterCache = new Map();
function textRasterKey(t, outW) {
  return [t.text, t.font, t.size, t.color, t.stroke, t.shadow, t.plate, outW].join('');
}
function rasterizeText(t, outW, outH) {
  const key = textRasterKey(t, outW);
  const hit = textRasterCache.get(key);
  if (hit) return hit;
  const px = Math.max(8, Math.round(t.size * outH));
  const pad = Math.ceil(px * 0.5);
  const font = (TEXT_FONTS[t.font]?.css || TEXT_FONTS.sans.css).replace("1em", px + "px");
  const m = document.createElement('canvas').getContext('2d');
  m.font = font;
  const lines = String(t.text).split('\n').slice(0, 6);
  const lh = Math.round(px * 1.35);
  const wMax = Math.max(1, ...lines.map(l => m.measureText(l).width));
  const cv = document.createElement('canvas');
  cv.width = Math.min(outW, Math.ceil(wMax) + pad * 2);
  cv.height = Math.ceil(lh * lines.length) + pad * 2;
  const g = cv.getContext('2d');
  g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  const cx = cv.width / 2;
  if (t.plate) {
    g.fillStyle = 'rgba(0,0,0,0.42)';
    g.fillRect(pad * 0.3, pad * 0.3, cv.width - pad * 0.6, cv.height - pad * 0.6);
  }
  if (t.shadow) { g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = px * 0.14; g.shadowOffsetY = px * 0.04; }
  if (t.stroke) {
    g.lineWidth = Math.max(1, px * 0.09); g.strokeStyle = 'rgba(0,0,0,0.75)'; g.lineJoin = 'round';
    lines.forEach((l, i) => g.strokeText(l, cx, pad + lh * (i + 0.5)));
  }
  g.shadowBlur = t.shadow ? px * 0.14 : 0;
  g.fillStyle = t.color || '#fff';
  lines.forEach((l, i) => g.fillText(l, cx, pad + lh * (i + 0.5)));
  const out = { canvas: cv, w: cv.width, h: cv.height };
  if (textRasterCache.size > 24) textRasterCache.clear();
  textRasterCache.set(key, out);
  return out;
}
function clearTextRaster() { textRasterCache.clear(); }
// 作品時刻Tで見えているテキストと、その時点の不透明度・開示率を返す（wall clockは使わない）
function textsAt(T, filmFps) {
  const list = project.texts;
  if (!Array.isArray(list) || !list.length) return [];
  const starts = project.clips.map((_, i) => sumBefore(i));
  const out = [];
  for (const t of list) {
    // いま打っている文字は、プレビューに重ねた入力欄のほうで見えている。ここで描くと二重になる
    if (editingTextId && t.id === editingTextId) continue;
    const span = textSpan(t, starts);
    if (!span || T < span[0] || T > span[1]) continue;
    const local = T - span[0], len = Math.max(0.2, span[1] - span[0]);
    const inT = Math.min(t.animIn ?? 0.4, len / 2), outT = Math.min(t.animOut ?? 0.4, len / 2);
    let alpha = (t.opacity ?? 1) * 0.9;   // 焼き込みは滲みが乗るので少し抑える
    let reveal = 1;
    if (t.anim === 'fade') {
      if (inT > 0) alpha *= clamp(local / inT, 0, 1);
      if (outT > 0) alpha *= clamp((len - local) / outT, 0, 1);
    } else if (t.anim === 'type') {
      const step = filmFps > 0 ? Math.floor(local * filmFps) / filmFps : local;  // 8mmはコマ単位で出す
      reveal = clamp(inT > 0 ? step / inT : 1, 0, 1);
    }
    if (alpha <= 0.002) continue;
    out.push({ t, alpha, reveal });
  }
  return out;
}

// ===== HSL・トーンカーブ（B3）=====
// 8色相の並びはシェーダの HUE_C と必ず同じ順にする
const HSL_KEYS = ['r', 'o', 'y', 'g', 'a', 'b', 'p', 'm'];
const HSL_LABELS = { r: '赤', o: 'オレンジ', y: '黄', g: '緑', a: '水色', b: '青', p: '紫', m: 'ピンク' };
const HSL_COLORS = { r: '#d84f4f', o: '#d8894f', y: '#d8c44f', g: '#6fbf5f', a: '#4fbfb0', b: '#4f7fd8', p: '#8f5fd8', m: '#d85fa8' };
// 入れ子の既定値は必ずここから作る。使い回すと全作品で同じ実体を共有してしまう
function defaultHsl() { return Object.fromEntries(HSL_KEYS.map(k => [k, { h: 0, s: 0, l: 0 }])); }
function defaultCurve() { return [[0, 0], [1, 1]]; }
function isIdentityHsl(v) {
  if (!v) return true;
  return HSL_KEYS.every(k => !v[k] || (!v[k].h && !v[k].s && !v[k].l));
}
function isIdentityCurve(v) {
  if (!Array.isArray(v) || v.length !== 2) return !Array.isArray(v) || v.length < 2;
  return v[0][0] === 0 && v[0][1] === 0 && v[1][0] === 1 && v[1][1] === 1;
}
function hslOf(o) { return o?.hsl || defaultHsl(); }
function curveOf(o) { return Array.isArray(o?.curve) && o.curve.length >= 2 ? o.curve : defaultCurve(); }
// 補正が全部ゼロならシェーダの分岐ごと飛ばす（v3と1bitも変わらない経路にする）
function hasCorrection(clip, adjust = project.adjust) {
  return !isIdentityHsl(adjust?.hsl) || !isIdentityCurve(adjust?.curve)
    || (!!clip && (!isIdentityHsl(clip.hsl) || !isIdentityCurve(clip.curve)));
}
function hslToArray(v) {
  const out = new Float32Array(24);
  const src = v || {};
  HSL_KEYS.forEach((k, i) => {
    const e = src[k] || {};
    out[i * 3] = (e.h || 0) / 100; out[i * 3 + 1] = (e.s || 0) / 100; out[i * 3 + 2] = (e.l || 0) / 100;
  });
  return out;
}
// テキストは後から足したので「無ければ空」。壊れた1件は捨て、作品ごと開けなくはしない
function normalizeTexts(v, clips) {
  if (!Array.isArray(v)) return [];
  const ids = new Set((clips || []).map(c => c?.id));
  const out = [];
  for (const t of v.slice(0, MAX_TEXTS)) {
    if (!isRecord(t) || typeof t.text !== 'string') continue;
    const a = isRecord(t.anchor) ? t.anchor : {};
    const anchor = a.type === 'clip' && ids.has(a.clipId)
      ? { type: 'clip', clipId: a.clipId, offset: clamp(Number(a.offset) || 0, 0, 3600), dur: clamp(Number(a.dur) || 2, 0.2, 3600) }
      : { type: 'global', start: clamp(Number(a.start) || 0, 0, 3600), end: clamp(Number(a.end) || 2, 0.2, 3600) };
    out.push({
      id: nonEmptyText(t.id) ? t.id : newId(), text: t.text.slice(0, 120), anchor,
      font: TEXT_FONTS[t.font] ? t.font : (TEXT_FONT_ALIAS[t.font] || 'sans'),
      size: clamp(Number(t.size) || 0.08, 0.035, 0.25),
      color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#fdf6e8',
      x: clamp(Number(t.x) ?? 0.5, 0, 1), y: clamp(Number(t.y) ?? 0.22, 0, 1),
      rot: clamp(Number(t.rot) || 0, -180, 180),   // 傾き（度）。後から足したので既定は0
      stroke: t.stroke ? 1 : 0, shadow: t.shadow ? 1 : 0, plate: t.plate ? 1 : 0,
      opacity: clamp(Number(t.opacity) ?? 1, 0, 1),
      burnIn: t.burnIn === undefined ? true : !!t.burnIn,   // 0/false のどちらでもOFFにする
      anim: TEXT_ANIMS[t.anim] ? t.anim : 'fade',
      animIn: clamp(Number(t.animIn) ?? 0.4, 0, 5), animOut: clamp(Number(t.animOut) ?? 0.4, 0, 5),
    });
  }
  return out;
}
// 保存から読むときの正規化。持っていない古い作品は既定値（＝補正なし）として読む
function normalizeHsl(v) {
  const out = defaultHsl();
  if (!isRecord(v)) return out;
  for (const k of HSL_KEYS) {
    const e = v[k];
    if (!isRecord(e)) continue;
    for (const axis of ['h', 's', 'l']) {
      const n = Number(e[axis]);
      out[k][axis] = Number.isFinite(n) ? clamp(Math.round(n), -100, 100) : 0;
    }
  }
  return out;
}
function normalizeCurve(v) {
  if (!Array.isArray(v) || v.length < 2 || v.length > 6) return defaultCurve();
  const pts = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2) return defaultCurve();
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return defaultCurve();
    pts.push([clamp(x, 0, 1), clamp(y, 0, 1)]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  // x が並ばない・重なるものは信用せず既定へ戻す（シェーダ側で0除算になるため）
  for (let i = 1; i < pts.length; i++) if (pts[i][0] - pts[i - 1][0] < 1e-4) return defaultCurve();
  return pts;
}
function curveToArray(v) {
  const pts = Array.isArray(v) && v.length >= 2 ? v.slice(0, 6) : defaultCurve();
  const out = new Float32Array(12);
  pts.forEach((p, i) => { out[i * 2] = p[0]; out[i * 2 + 1] = p[1]; });
  return { data: out, n: pts.length };
}

// 作品ごとに一度だけ作る質感の種。新規作品は必ず暗号学的乱数で始め、
// 旧作品だけは端末間で同じ結果になるFNV-1a補完を使う。
const DEFAULT_TEXTURE_SEED = 0x9e3779b9;
const FILM_PROFILE_KEYS = Object.freeze(['home8', 'super8_reversal', 'super8_negative']);
function makeTextureSeed() {
  const word = new Uint32Array(1);
  if (!globalThis.crypto?.getRandomValues) throw new Error('この端末では作品の質感seedを作れません');
  globalThis.crypto.getRandomValues(word);
  return word[0] >>> 0;
}
function fnv1a32Utf8(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
const RUNTIME_CANONICAL_KEYS = new Set(['file', 'url', 'video', 'img', 'audioBuffer', 'arrayBuffer', 'audioBuf', 'meanLum', 'meanRb']);
function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') return 'null';
  return `{${Object.keys(value).sort().filter(key => !RUNTIME_CANONICAL_KEYS.has(key) && value[key] !== undefined && typeof value[key] !== 'function')
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function normalizeTextureSeed(value, fallbackState) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) return value >>> 0;
  const legacyId = fallbackState?.id;
  const input = typeof legacyId === 'string' && legacyId.trim() ? legacyId : canonicalJson(fallbackState || {});
  const hash = fnv1a32Utf8(input);
  return hash === 0 ? DEFAULT_TEXTURE_SEED : hash;
}
const project = {
  id: null,
  name: '',
  createdAt: null,
  updatedAt: null,
  assetBytes: 0,
  aspect: '16:9',
  fit: 'contain',      // 'contain'=切れないように収める / 'cover'=画面いっぱい
  clips: [],           // {id, kind:'video'|'photo', file, url, video|img, name, dur, w, h, start, end, thumb, bright, temp, autoBright, autoTemp, muted}
  lut: 'hikari',       // 'mine' | 'airu' | 'hikari' | 'none' | 'file'
  mineLutData: null,
  airuLutData: null,
  lutFileData: null,
  adjust: { ...DEFAULT_ADJUST, hsl: defaultHsl(), curve: defaultCurve() },
  texts: [],
  transOverrides: [],   // 境目ごとの手動指定 {leftClipId, kind:'flash'|'burn'|'none'}
  music: null,         // {name, arrayBuffer?|audioBuffer?, volume}
  muteAll: false,      // 元の音を消して音楽だけにする
  autoAlign: true,     // 自動そろえ
  impLen: 3,           // 取り込み長さ（秒。0=全部）
  preset: null,
  textureSeed: null,
  filmProfile: 'home8',
};
let selId = null;
let clipSeq = 0;

const ASPECTS = {
  '16:9': { css: '16/9', prev: [960, 540], out1080: [1920, 1080], out2160: [3840, 2160] },
  '9:16': { css: '9/16', prev: [540, 960], out1080: [1080, 1920], out2160: [2160, 3840] },
  '4:5':  { css: '4/5',  prev: [540, 675], out1080: [1080, 1350], out2160: [2160, 2700] },
  '4:3':  { css: '4/3',  prev: [720, 540], out1080: [1440, 1080], out2160: [2880, 2160] },
};

// ===== テキスト（B4）=====
// 「映像の上に貼る字幕」ではなく「フィルムに写っている文字」。既定では粒子・滲み・揺れを一緒に浴びる。
const MAX_TEXTS = 10;
// すべてSIL OFL（商用可）。familyはdocument.fonts.loadに渡す名前
const TEXT_FONTS = {
  sans: { label: 'ゴシック', family: 'Noto Sans JP', css: '500 1em "Noto Sans JP","Hiragino Sans",sans-serif' },
  serif: { label: '明朝', family: 'Shippori Mincho', css: '500 1em "Shippori Mincho","Hiragino Mincho ProN",serif' },
  pen: { label: '万年筆', family: 'Klee One', css: '600 1em "Klee One",cursive' },
  pencil: { label: 'えんぴつ', family: 'Zen Kurenaido', css: '400 1em "Zen Kurenaido",cursive' },
  round: { label: 'まるい手書き', family: 'Yomogi', css: '400 1em "Yomogi",cursive' },
  marker: { label: 'マーカー', family: 'Yusei Magic', css: '400 1em "Yusei Magic",cursive' },
};
const TEXT_FONT_ALIAS = { hand: 'pen' };   // 旧データの手書きは万年筆へ
// 書体はGoogle Fontsから読む（CDN依存）。読めていないと端末の既定書体で焼かれるので、
// **読めたかどうかを必ず確かめて記録する**。
// 【2026-08-16】従来は load() の失敗を握り潰していたため、ネットにつながっていない環境で
// 「明朝を選んだのにゴシックで焼かれる」ことが黙って起きていた。
// document.fonts.load() は失敗してもresolveすることがあるので、check() で実使用可否を見る。
const textFontFailed = new Set();
async function ensureTextFonts(all = false) {
  const fams = all
    ? new Set(Object.values(TEXT_FONTS).map(f => f.family))
    : new Set((project.texts || []).map(t => TEXT_FONTS[t.font]?.family).filter(Boolean));
  if (!fams.size) return textFontFailed;
  await Promise.all([...fams].map(async f => {
    try { await document.fonts.load(`1em "${f}"`, 'あア亜0'); } catch { /* 下のcheckで判定する */ }
    if (document.fonts.check(`1em "${f}"`)) textFontFailed.delete(f);
    else textFontFailed.add(f);
  }));
  if (textFontFailed.size) diag('書体が読めない', () => ({ 書体: [...textFontFailed].join(',') }));
  clearTextRaster();
  return textFontFailed;
}
// いま作品で使っている書体のうち、読めていないものの表示名
function missingTextFontLabels() {
  const used = new Set((project.texts || []).map(t => t.font));
  return Object.entries(TEXT_FONTS)
    .filter(([k, v]) => used.has(k) && textFontFailed.has(v.family))
    .map(([, v]) => v.label);
}
const TEXT_ANIMS = { none: 'なし', fade: 'フェード', type: 'タイプ' };
function defaultText(clipId) {
  return {
    id: newId(), text: 'ここに文字',
    anchor: clipId ? { type: 'clip', clipId, offset: 0, dur: 2 } : { type: 'global', start: 0, end: 2 },
    font: 'sans', size: 0.08, color: '#fdf6e8', x: 0.5, y: 0.22, rot: 0,
    stroke: 0, shadow: 1, plate: 0, opacity: 1, burnIn: true, anim: 'fade', animIn: 0.4, animOut: 0.4,
  };
}
// 作品時刻での表示区間を求める。クリップ紐づけはトリム・並べ替えに自動で追従する
function textSpan(t, clipStarts) {
  if (t.anchor?.type === 'clip') {
    const i = project.clips.findIndex(c => c.id === t.anchor.clipId);
    if (i < 0) return null;
    const base = clipStarts[i], len = clipLen(project.clips[i]);
    const start = base + clamp(t.anchor.offset || 0, 0, Math.max(0, len - 0.2));
    return [start, Math.min(base + len, start + Math.max(0.2, t.anchor.dur || 2))];
  }
  const total = timelineDur();
  const s = clamp(t.anchor?.start || 0, 0, total);
  return [s, clamp(Math.max(s + 0.2, t.anchor?.end ?? s + 2), 0, total)];
}
const MAX_PROJECT_SECONDS = 30;
const PRESET_LABELS = { diary: '自分の色', mv: '青い記憶', film8: '8mmホームムービー' };

// 質感モード。数値は実測から決めている:
//  ・アイルMV（全編解析）… 主役はブルーム＝ハイライトの滲み
//  ・実物の8mmホームムービー（archive.org・16fps）… 揺れ 画面幅の0.023%、明滅 0.10%、
//    粒子の空間相関 0.64(1px隣)、ハレーション 明部周囲でR-B +8.7/255
// gAmt/gSize はチップ選択時にスライダーへ流し込む既定値（オート）。その後は手動調整可
const FX = {
  // curve: 粒子の輝度カーブ（0=中間調で最大＝アイル実測／1=シャドウで最大＝8mm実測）
  // halo: ハレーションの色（8mmは赤橙、アイルは実測どおり青寄り）／soften: 粒子前の甘さ／hz: 粒子を更新するコマ速度
  0: { bloom: 0,    thresh: 1.0,  wide: 0,    weave: 0,      flicker: 0,     vignette: 0,    dust: 0, scratch: 0,    cadence: 0,  curve: 0, soften: 0,    hz: 24, halo: [1.0, 0.40, 0.14], gAmt: 10, gSize: 100, gGlow: 100, gHal: 0 },
  // 【2026-08-16 bloom削減】実エッジで暗側への滲みを測ると参照アイルの約2.5倍だった
  // （-6px: アプリ0.124 / 参照0.047）。Codex分析の「Bloomは薄く広く・強く狭いGlowにしない」
  // が実測と一致した唯一の実質的指摘。0.42/0.38→0.26/0.30 で滲みは0.081へ（まだ1.7倍だが、
  // これ以下に絞ると「光が空気へ溶ける」質感ごと痩せる）。光（凍結中）への影響は無いことを
  // A/B実測で確認済み（bloomを戻しても同じ境界で221/143/35と不変＝光はヴェール項が支配）。
  1: { bloom: 0.26, thresh: 0.58, wide: 0.30, weave: 0.0005, flicker: 0.003, vignette: 0.28, vigA: 2.0, dust: 0, scratch: 0, cadence: 0, curve: 0, soften: 0.15, hz: 24, halo: [0.55, 0.75, 1.0], gAmt: 12, gSize: 90,  gGlow: 100, gHal: 8 },  // アイル
  2: { bloom: 0.28, thresh: 0.62, wide: 0.45, weave: 0.0009, jump: 0.00042, flicker: 0.006, vignette: 0.126, dust: 1, scratch: 0.55, cadence: 16, curve: 1, soften: 0.45, chroma: 0.18, veil: 0.035, hz: 16, halo: [1.0, 0.40, 0.14], gAmt: 34, gSize: 150, gGlow: 100, gHal: 26 }, // 8mm
};

// effect 2の中だけに閉じた下位設定。effect 1（青い記憶）の色・粒子・時間値はここで変更しない。
const FILM_PROFILES = Object.freeze({
  home8: Object.freeze({
    label: '8mmホームムービー', fps: 16, bloom: 0.28, wide: 0.45, weave: 0.0009, jump: 0.00042, flicker: 0.006, vignette: 0.126,
    halo: [1.0, 0.40, 0.14], halation: 0.26, veil: 0.035, soften: 0.45, chroma: 0.18,
    grainCurve: 1, grain: 34, grainSize: 150, glow: 100, damage: 0.08, highlightCarry: 0.18,
    stockContrast: 0.05, stockSaturation: 0.02, blackLift: 0.025, shoulder: 0.12,
    shadowTint: [-0.018, 0.010, 0.018], highlightTint: [0.018, 0.006, -0.010],
  }),
  // ユーザー指定の基準リファレンス ref-20260815-01（youtu.be/9sl-2Fuo9c0）の実測へ合わせた主プロファイル。
  // 実測: 18fps(2,2,1保持)・明滅2.25%・周辺減光43%・黒は沈む・明部が暖色(B-G -25)・彩度控えめ
  super8_reversal: Object.freeze({
    label: 'Super8 リバーサル', fps: 18, bloom: 0.20, wide: 0.26, weave: 0.00052, jump: 0.00022,
    flicker: 0.145,             // 実測2.25%へ実描画で合わせ込み（0.085→1.32%だったので線形換算で引き上げ）
    vignette: 0.41,             // 四隅は素の41%落ち＝0.59倍（旧カーブ0.72から新カーブへ換算）
    halo: [1.0, 0.48, 0.22], halation: 0.17, veil: 0.018, soften: 0.29, chroma: 0.12,
    grainCurve: 1, grain: 25, grainSize: 115, glow: 86, damage: 0.03, highlightCarry: 0.08,
    stockContrast: 0.18, stockSaturation: 0.16, blackLift: 0.004, shoulder: 0.035,
    shadowTint: [-0.004, 0.002, 0.006], highlightTint: [0.010, 0.004, -0.004],
  }),
  super8_negative: Object.freeze({
    label: 'Super8 モダンネガ', fps: 18, bloom: 0.34, wide: 0.52, weave: 0.00040, jump: 0.00016, flicker: 0.003, vignette: 0.126,
    halo: [1.0, 0.34, 0.16], halation: 0.08, veil: 0.055, soften: 0.22, chroma: 0.10,
    grainCurve: 1, grain: 18, grainSize: 92, glow: 112, damage: 0, highlightCarry: 0.30,
    stockContrast: -0.08, stockSaturation: -0.03, blackLift: 0.012, shoulder: 0.30,
    shadowTint: [-0.006, 0.004, 0.008], highlightTint: [0.006, 0.002, -0.002],
  }),
});
// key を渡すとその種類を、渡さなければ現在の作品の種類を返す（サムネイルの試し描き用）
function currentFilmProfile(key) {
  return FILM_PROFILES[key || project.filmProfile] || FILM_PROFILES.home8;
}
function textureFx(effect = project.adjust.effect, profileKey) {
  if (effect !== 2) return FX[effect] || FX[0];
  const profile = currentFilmProfile(profileKey);
  return {
    ...FX[2], cadence: profile.fps, hz: profile.fps, bloom: profile.bloom, wide: profile.wide,
    weave: profile.weave, jump: profile.jump, flicker: profile.flicker, halo: profile.halo,
    vignette: profile.vignette ?? 0.126,
    curve: profile.grainCurve, soften: profile.soften, chroma: profile.chroma, veil: profile.veil,
  };
}
function applyFilmProfileRecommendations(key) {
  const profile = FILM_PROFILES[key] || FILM_PROFILES.home8;
  project.filmProfile = FILM_PROFILES[key] ? key : 'home8';
  project.adjust.grain = profile.grain / 400;
  project.adjust.grainSize = profile.grainSize / 100;
  project.adjust.glow = profile.glow / 100;
  project.adjust.halation = profile.halation;
  project.adjust.damage = profile.damage;
}

// プリセット（2軸）: 日記＝毎日をさっと / MV＝作品としてSNSへ
// プリセットは「見た目（色・質感・音）」だけを決める。縦横のフレームは素材と作品が決めるものなので持たせない。
// 例外は8mmで、4:3であること自体がその質感の一部なので固定する（2026-08-14 ユーザー決定）。
// newAspect は新規作品を作るときの初期値だけに使い、既存の作品には触れない。
const PRESETS = {
  diary: { key: 'diary', newAspect: '9:16', lut: 'mine', effect: 0, muteAll: false, impLen: 3, letterbox: false, autoAlign: true },
  mv:    { key: 'mv', newAspect: '16:9', lut: 'airu', effect: 1, muteAll: true,  impLen: 5, letterbox: true,  autoAlign: true },
  film8: { key: 'film8', aspect: '4:3', newAspect: '4:3', lut: 'film8', effect: 2, muteAll: true, impLen: 3, letterbox: false, autoAlign: true, filmProfile: 'super8_reversal' },
};
// スイッチONで入れる値も同じ表から引く（表を2か所に持たない）
function motionRecommend(k) {
  return (MOTION_RECOMMEND[project.preset] || MOTION_RECOMMEND.mv)[k];
}

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
float vn(float t){ float i=floor(t), f=fract(t); return mix(h1(i), h1(i+1.), f*f*(3.-2.*f)); }
// 手持ちの揺れ。アイルMV全編の位相相関実測（2026-08-15・3,895フレーム）に合わせている:
//  ・主成分は0.3〜0.6Hzの遅い揺らぎで、スペクトルは1/f²型に減衰（0.3Hz:0.75 → 1.2Hz:0.28 → 3Hz:0.03）
//  ・表情として効くショットの振幅は RMS 1〜2.3%（画面幅比）。中央値ショットは0.4%
//  ・動きはコマ送り（実効約19fps）と同期した階段状で、1コマ 0.2〜0.6% の「ガタッ」が乗る
// gate weave（毎コマ跳ねる高周波）とは別物なので、加算する場所は同じでも式は分ける。
// xy=並進（ソース座標）、z=呼吸ズーム倍率。amt=0 のとき厳密に (0,0,1) を返す＝回帰不変。
vec3 handheld(float t, float amt, float hz){
  if (amt <= 0.0) return vec3(0.0, 0.0, 1.0);
  // 実効フレームに量子化する＝滑らかに流れず「ガタッ」と動く（実測の階段状に一致）
  float q = floor(t * hz) / hz;
  // 3オクターブ。scale 0.080はMV実測合わせだったが、8mm基準リファレンス（静場面RMS1.73%）と
  // ユーザー体感「100でも弱い」を受けて0.18へ（2026-08-15）。amt=1でRMS約1.5%・ズーム12%
  vec2 o = vec2((vn(q*0.45)-0.5)*0.35 + (vn(q*0.95+11.3)-0.5)*0.90 + (vn(q*2.1+31.7)-0.5)*0.45,
                (vn(q*0.41+5.1)-0.5)*0.35 + (vn(q*0.91+23.9)-0.5)*0.90 + (vn(q*2.3+47.3)-0.5)*0.45)
           * 0.18 * amt;
  // 呼吸（ごく遅いズームのゆらぎ）±0.8%
  float breath = (vn(q*0.33+41.0)-0.5)*0.016*amt;
  // 並進ぶん内側を写す。生の振れは稀に6%まで届くが、そこまで余白を取ると寄りすぎるので
  // 7.5%ズームに留め、余白を超える並進は切り詰める（構図を戻す人の手の代わり）
  float z = 1.0 - 0.12*amt + breath;
  float margin = max((1.0 - z) * 0.5, 0.0);
  o = clamp(o, -margin, margin);
  return vec3(o, z);
}`;

// テキスト用の板ポリ。uRectは出力uv基準（yは下向き＝0が上）。
// fboAへはgradeと同じ規約で書く（FS_FINALが 1-uv.y で読み戻すので、ここで反転してはいけない）。
// 揺れは映像と同じ式をここでも計算する。JS側で真似ると位相がずれるので必ずシェーダで作る。
const VS_TEXT = `#version 300 es
uniform vec4 uRect; uniform float uTime, uSeedPhase, uWeave, uJump, uHandheld, uHandheldHz, uSpliceY;
uniform float uTextRot, uTextAspect; uniform vec2 uVis;
out vec2 tuv;
${NOISE}
void main(){
  vec2 p = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  tuv = p;
  float ft = floor((uTime + uSeedPhase) * 1000.0) / 1000.0;
  vec2 ofs = vec2((vn(ft*1.4)-0.5)*2.0*uWeave, (vn(ft*9.0+37.7)-0.5)*2.0*uJump);
  vec3 hh = handheld(ft, uHandheld, uHandheldHz);
  // 映像はサンプリング座標をずらすので、画面上は逆向きに 1/uVis 倍で動く。
  // ズームぶんは画面中心まわりに 1/z 倍（映像が寄れば文字も同じだけ寄る＝貼りついて見える）
  // 文字の傾きは、まず uv を見た目の比率へ直してから回す。直さずに回すと、
  // よこ長の画面では斜めの文字がつぶれて見える
  vec2 d = (p - 0.5) * uRect.zw;
  d.x *= uTextAspect;
  float sr = sin(uTextRot), cr = cos(uTextRot);
  d = vec2(d.x * cr - d.y * sr, d.x * sr + d.y * cr);
  d.x /= uTextAspect;
  vec2 o = uRect.xy + uRect.zw * 0.5 + d;
  o = 0.5 + (o - 0.5) / hh.z - (ofs + hh.xy) / (max(uVis, vec2(0.001)) * hh.z);
  o.y -= uSpliceY / (max(uVis.y, 0.001) * hh.z);
  gl_Position = vec4(o.x * 2. - 1., 1. - o.y * 2., 0., 1.);
}`;
// 焼き込み先が8mmのときはlinear、それ以外はencodedなので、色だけ合わせて混ぜる
const FS_TEXT = `#version 300 es
precision highp float;
uniform sampler2D uTex; uniform float uAlpha, uToLinear, uReveal;
in vec2 tuv; out vec4 o;
vec3 toLin(vec3 c){ return mix(c / 4.5, pow(max((c + 0.099) / 1.099, 0.0), vec3(1.0 / 0.45)), step(vec3(0.081), c)); }
void main(){
  if (tuv.x > uReveal) discard;              // 1文字ずつ出す（タイプ）
  vec4 t = texture(uTex, tuv);               // premultiplied
  if (t.a < 0.001) discard;
  vec3 col = t.rgb / max(t.a, 0.001);
  if (uToLinear > 0.5) col = toLin(clamp(col, 0.0, 1.0));
  float a = t.a * uAlpha;
  o = vec4(col * a, a);
}`;

const FS_GRADE = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler2D uFrame; uniform sampler3D uLut;
uniform float uStrength,uExposure,uContrast,uSaturation,uFade,uTemp,uLutN,uTime,uWeave,uJump,uSeedPhase,uLinearOptics,uHighlightCarry,uHandheld,uHandheldHz,uSpliceY;
uniform float uStockContrast,uStockSaturation,uStockBlackLift,uStockShoulder;
uniform vec3 uStockShadowTint,uStockHighlightTint;
uniform int uRot; uniform vec2 uVis;
// HSL・トーンカーブ補正。uCorrOn=0 のときは分岐ごと通らないので、補正ゼロならv3と同じ経路になる。
// A=クリップ / B=作品全体。clip→projectの順に通す。
uniform float uCorrOn, uCurveAN, uCurveBN;
uniform vec3 uHslA[8], uHslB[8];      // (色相ずらし, 彩度倍率, 明るさ) 各 -1..1
uniform vec2 uCurveA[6], uCurveB[6];  // 0..1 のx昇順ポイント
in vec2 uv; out vec4 o;
${NOISE}
vec3 toLinear(vec3 c){ return mix(c / 4.5, pow(max((c + 0.099) / 1.099, 0.0), vec3(1.0 / 0.45)), step(vec3(0.081), c)); }
// Lightroom準拠の8色相。窓は重なり合わせ、合計で割って正規化するので
// 全チャンネルを同じだけ動かすと素直に全体の色相回転になる。
const float HUE_C[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 220.0, 275.0, 315.0);
vec3 rgb2hsl(vec3 c){
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5, d = mx - mn, h = 0.0, s = 0.0;
  if (d > 1e-5) {
    s = l > 0.5 ? d / max(2.0 - mx - mn, 1e-5) : d / max(mx + mn, 1e-5);
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
  }
  return vec3(h, s, l);
}
float hue2rgb(float p, float q, float t){
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 hsl){
  float h = hsl.x / 360.0, s = hsl.y, l = hsl.z;
  if (s < 1e-5) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(hue2rgb(p, q, h + 1.0 / 3.0), hue2rgb(p, q, h), hue2rgb(p, q, h - 1.0 / 3.0));
}
vec3 applyHsl(vec3 col, vec3 adj[8]){
  vec3 hsl = rgb2hsl(col);
  float wsum = 0.0; vec3 acc = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float dist = abs(mod(hsl.x - HUE_C[i] + 540.0, 360.0) - 180.0);
    float w = 1.0 - smoothstep(0.0, 60.0, dist);
    wsum += w; acc += w * adj[i];
  }
  if (wsum < 1e-4) return col;
  // グレー近傍は色相が定まらない。減衰させないとノイズと色被りを増幅する
  acc = acc / wsum * smoothstep(0.0, 0.15, hsl.y);
  hsl.x = mod(hsl.x + acc.x * 30.0, 360.0);
  hsl.y = clamp(hsl.y * (1.0 + acc.y), 0.0, 1.0);
  hsl.z = clamp(hsl.z + acc.z * 1.2 * hsl.z * (1.0 - hsl.z), 0.0, 1.0);
  return hsl2rgb(hsl);
}
float curveEval(vec2 p[6], int n, float x){
  if (n < 2) return x;
  x = clamp(x, 0.0, 1.0);
  if (x <= p[0].x) return p[0].y;
  if (x >= p[n - 1].x) return p[n - 1].y;
  for (int i = 0; i < 5; i++) {
    if (i >= n - 1) break;
    if (x <= p[i + 1].x) {
      float t = (x - p[i].x) / max(p[i + 1].x - p[i].x, 1e-5);
      float y0 = i > 0 ? p[i - 1].y : p[i].y;
      float y3 = (i + 2) < n ? p[i + 2].y : p[i + 1].y;
      float m0 = (p[i + 1].y - y0) * 0.5, m1 = (y3 - p[i].y) * 0.5;
      float t2 = t * t, t3 = t2 * t;
      return (2.0 * t3 - 3.0 * t2 + 1.0) * p[i].y + (t3 - 2.0 * t2 + t) * m0
           + (-2.0 * t3 + 3.0 * t2) * p[i + 1].y + (t3 - t2) * m1;
    }
  }
  return x;
}
// 明るさだけ動かし、色の比率は保つ
vec3 applyCurve(vec3 col, vec2 p[6], float n){
  if (int(n) < 2) return col;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (l < 1e-4) return col;
  return clamp(col * (curveEval(p, int(n), l) / l), 0.0, 1.0);
}
void main(){
  float ft = floor((uTime + uSeedPhase) * 1000.0) / 1000.0;
  vec3 hh = handheld(ft, uHandheld, uHandheldHz);
  vec2 e = 0.5 + (uv - 0.5) * uVis * hh.z + hh.xy;
  // スプライス通過の縦ジャンプ。範囲外に出た分は黒が見える＝実物でもコマ端が覗く
  e.y += uSpliceY;
  // 横はゆっくり漂い(weave)、縦は細かく跳ねる(jump)。実際のフィルムはこの2つで性質が違う
  e += vec2((vn(ft*1.4)-0.5)*2.0*uWeave, (vn(ft*9.0+37.7)-0.5)*2.0*uJump);
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
  // 補正前を退避しておく。8mmの明部持ち越し(overLinear)は1.0を超える余地から作るので、
  // clampの要る補正のあとの値を使うと持ち越しが死ぬ。
  vec3 preCorr = c;
  if (uCorrOn > 0.5) {
    c = clamp(c, 0.0, 1.0);
    c = applyHsl(c, uHslA);
    c = applyCurve(c, uCurveA, uCurveAN);
    c = applyHsl(c, uHslB);
    c = applyCurve(c, uCurveB, uCurveBN);
  }
  vec3 encodedBeforeLut = c;
  vec3 encodedClamped = clamp(encodedBeforeLut, 0., 1.);
  vec3 g = texture(uLut, encodedClamped * ((uLutN-1.0)/uLutN) + (0.5/uLutN)).rgb;
  // LUT座標だけをclampし、mix元は従来どおりclamp前のencoded値を保つ。
  c = mix(encodedBeforeLut, g, uStrength);
  // LUTは従来どおりencoded値で読む。8mm光学系だけ、その後をlinearへ移して
  // LUT入力で失われる1.0超の明部を別経路で持ち直す。
  if (uLinearOptics > 0.5) {
    // stock差はeffect 2の中だけでencoded階調へ適用する。RGBA8 fallbackでも残る。
    float stockLum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = (c - vec3(0.5)) * (1.0 + uStockContrast) + vec3(0.5 + uStockBlackLift);
    c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.0 + uStockSaturation);
    c += uStockShadowTint * (1.0 - smoothstep(0.12, 0.58, stockLum));
    c += uStockHighlightTint * smoothstep(0.48, 0.92, stockLum);
    c = c / (vec3(1.0) + max(c - vec3(0.55), vec3(0.0)) * uStockShoulder);
    vec3 overLinear = clamp(max(toLinear(max(preCorr, vec3(0.0))) - vec3(1.0), vec3(0.0)), vec3(0.0), vec3(2.0));
    c = toLinear(clamp(c, 0.0, 1.0)) + overLinear * uHighlightCarry;
  } else c = clamp(c, 0.0, 1.0);
  o = vec4(c, 1.0);
}`;

const FS_BLUR = `#version 300 es
precision highp float;
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
precision highp float;
uniform sampler2D uBase, uBloom, uBloomWide, uGrainTex;
uniform float uBloomAmt,uWideAmt,uHalation,uVeil,uLetterbox,uVignette,uFlicker,uDust,uScratch,uGrain,uGrainScale,uTime,uGrainCurve,uSoften,uChroma,uDamage,uSeedPhase,uLeak,uTransAmt,uTransPhase;
uniform int uTransKind;
uniform float uTransGrad, uTransSeed, uTransTint;
uniform vec2 uTransDir;
uniform float uLinearOptics;
uniform float uVigA;
uniform float uEndAmt, uEndDark;   // おわり（v8-20）: 1へ近づくほど白または黒へ沈む
uniform vec2 uGrainOfs, uTexel, uVisF;
uniform vec3 uHaloColor;
in vec2 uv; out vec4 o;
// 白点Wで頭打ちにするショルダー。
// 【2026-08-16 コマ送り実測で修正】前版は拡張Reinhard x*(1+x/W²)/(1+x) を使っていたが、
// これは入力が1.0を超えるHDR前提の式で、1.0以下の**通常の画まで大きく暗くする**
// （W=1.9 のとき x=0.5→0.38 / x=0.9→0.58）。つなぎが薄くかかっている間じゅう画面全体が沈み、
// 実測でコマ-2が平均150→105、残光中も111まで落ちていた＝ユーザー評「光は暗く滲む」の正体。
// ニー（knee）より下は完全に素通しし、上だけを漸近的にWへ寄せる形に置き換える。
vec3 shoulderTone(vec3 x, float W) {
  const float knee = 0.75;
  vec3 e = max(x - knee, vec3(0.0));
  return min(x, vec3(knee)) + e / (1.0 + e / max(W - knee, 1e-3));
}

${NOISE}
vec3 toEncoded(vec3 c){ return mix(c * 4.5, 1.099 * pow(max(c, vec3(0.0)), vec3(0.45)) - 0.099, step(vec3(0.018), c)); }
// 粒子の輝度依存は素材で違う（どちらも実測）:
//  uCurve=0 … アイルMV型。中間調(0.56)で最大、シャドウとハイライトで減る
//  uCurve=1 … 実物8mm型。輝度0.19付近で最大、真っ黒では出ない
float grainWeight(float l, float uCurve){
  float mid = 0.25 + 0.75 * exp(-((l - 0.55) * (l - 0.55)) / (2.0 * 0.20 * 0.20));
  float sh = smoothstep(0.0, 0.15, l) * (mix(1.0, 0.63, smoothstep(0.19, 0.60, l)) + 0.06 * smoothstep(0.62, 0.95, l));
  return mix(mid, sh, uCurve);
}
void main(){
  if (uv.y < uLetterbox || uv.y > 1.0 - uLetterbox) { o = vec4(0.,0.,0.,1.); return; }
  // 映像の外（アスペクト差の黒帯）はフィルムが存在しない場所。滲みも粒子もハレーションも出さない
  vec2 visLim = 0.5 / max(uVisF, vec2(0.001));
  if (abs(uv.x - 0.5) > visLim.x || abs(uv.y - 0.5) > visLim.y) { o = vec4(0.,0.,0.,1.); return; }
  vec2 suv = vec2(uv.x, 1.0 - uv.y);
  vec3 c = texture(uBase, suv).rgb;
  // 8mmの実効解像度は低いので、粒子を乗せる前に少しだけ甘くする（デジタルの硬さを取る）
  if (uSoften > 0.0) {
    vec3 s = texture(uBase, suv + vec2(uTexel.x, 0.0)).rgb + texture(uBase, suv - vec2(uTexel.x, 0.0)).rgb
           + texture(uBase, suv + vec2(0.0, uTexel.y)).rgb + texture(uBase, suv - vec2(0.0, uTexel.y)).rgb;
    c = mix(c, (c * 2.0 + s) / 6.0, uSoften);
  }
  if (uChroma > 0.0) {
    c.r = mix(c.r, texture(uBase, suv + vec2(uTexel.x * 0.75, 0.0)).r, uChroma);
    c.b = mix(c.b, texture(uBase, suv - vec2(uTexel.x * 0.75, 0.0)).b, uChroma);
  }
  vec3 bl = texture(uBloom, suv).rgb;
  vec3 wide = texture(uBloomWide, suv).rgb;
  vec3 opticsBase = c;
  // 滲み: 芯の狭いブルーム＋広くやわらかいブルームの二段
  vec3 glow = bl * uBloomAmt + wide * uWideAmt;
  vec3 screened = 1.0 - (1.0 - opticsBase) * (1.0 - glow);
  // ハレーション: 明部のまわりに色がにじむ。8mmは赤橙（フィルム特有）、アイルは青寄り（実測）
  screened = 1.0 - (1.0 - screened) * (1.0 - wide * uHaloColor * uHalation);
  // float headroomを含むbaseをscreen演算で減らさない。RGBA8でも単調性を保つ。
  c = max(opticsBase, screened);
  // veiling glareは局所ハローではなく、広い散乱で黒をほんの少し持ち上げる。
  c += wide * uVeil;
  // 【2026-08-16 実測対応】周辺減光の落ち始め・落ち切りを世界観ごとに変えられるようにした。
  // 参照アイル（3899コマを各コマ正規化して中央値）は中央0.993→四隅0.835＝16.5%落ちるのに対し、
  // 従来の固定カーブ(0.45,0.92)＋強さ0.05では四隅0.971＝2.9%しか落ちていなかった。
  // 8mm側は実物の測定が安定しなかった（左端に黒帯が残る）ため、既定値のまま触らない。
  // 座標はキャンバスではなく**画の内側**で取る。レターボックスを含めた uv で測ると、
  // 16:9を4:3に収めたときなど画の上下端がいきなり強く落ちる（実測: 上端で0.808まで落ちた）。
  // 【2026-08-16 修正】smoothstep だと終端より外がすべて同じ値になり、そこに**帯の境目**が
  // 見えていた（ユーザー評「100にすると境界がわかってしまう」）。四隅を1.0に正規化した半径の
  // べき乗にして、頭打ちを無くす。中心付近はほぼ効かず、外へ行くほど滑らかに落ちる＝
  // レンズの周辺減光（cos^4則）に近い形。uVigA は落ち方の鋭さ（2.0＝標準）。
  vec2 vigUv = (uv - 0.5) * uVisF;
  float vigMax = max(length(0.5 * uVisF), 1e-4);
  float vr = clamp(length(vigUv) / vigMax, 0.0, 1.0);
  c *= 1.0 - uVignette * pow(vr, uVigA);
  c *= 1.0 + (vn((uTime + uSeedPhase)*17.0+51.0)-0.5)*2.0*uFlicker;
  // ゴミ: 1コマだけ出て次のコマで消える（フィルムのゴミの定義的な性質）。
  // 粒子テクスチャから拾うので四角ではなく有機的な形になる
  if (uDust > 0.0 && uDamage > 0.0) {
    float ds = floor((uTime + uSeedPhase)*16.0);
    float d = texture(uGrainTex, uv*2.7 + vec2(h1(ds*3.1 + uSeedPhase), h1(ds*7.7 + uSeedPhase))).g;
    // 数秒スケールで濃い区間と何も出ない区間を作る（均等にばら撒くと嘘っぽくなる）
    float density = smoothstep(0.45, 0.85, vn((uTime + uSeedPhase)*0.35));
    c += smoothstep(0.945, 1.0, d) * 0.30 * density * uDust * uDamage;
  }
  // 縦の傷: 数コマ持続し、たまにしか出ない（シーンの動きとは無関係に居座る）
  if (uScratch > 0.0 && uDamage > 0.0) {
    float seed = floor((uTime + uSeedPhase)*1.2);
    float on = step(mix(0.96, 0.68, uDamage), h1(seed*7.7 + uSeedPhase));
    float sx = h1(seed*3.1 + uSeedPhase);
    c += on * uScratch * uDamage * (1.0 - smoothstep(0.0, 0.0018, abs(uv.x - sx))) * (0.05 + 0.07*h1(seed*11.3 + uSeedPhase));
  }
  // 感光（光漏れ）。実物の8mmホームムービー（archive.org・13分）の光漏れ14件の実測（2026-08-15）:
  //  ・色は琥珀(1,0.78,0.14)・赤・白っぽい暖色の3系。マゼンタは観測されなかった
  //  ・時間方向は滑らかな山ではなく、コマごとに明滅する0.2〜1.6秒のパルスが数秒の群れで来る
  //  ・辺は左に偏る（14件中9件＝フィルム送り側）。届く深さは縁だけ(2%)〜深い(37%)まで二極
  //  ・頻度は素材全体で約57秒に1回と稀（頻度は強さスライダーで増減）
  // uLeakが非0のときは、8mm内蔵のlight leak（下）を止めて二重発火させない。
  if (uLeak > 0.0) {
    // 群れ（クラスタ）: 7〜13秒にひとつの枠。強さで「出ない枠」の率が変わる
    float span = 7.0 + 6.0 * h1(floor((uTime + uSeedPhase) * 0.017) * 3.7 + uSeedPhase);
    float ev = floor((uTime + uSeedPhase) / span);
    float ph = fract((uTime + uSeedPhase) / span);
    float on = step(1.0 - mix(0.30, 0.90, uLeak), h1(ev * 19.7 + uSeedPhase));
    // 群れの中のパルス列（0.2〜1.6秒でついたり消えたり）
    float tt = uTime + uSeedPhase;
    float pulse = smoothstep(0.52, 0.72, vn(tt * 1.9 + ev * 7.7));
    // ゲートに入る光は1コマごとに揺れる（16fpsの明滅。実測の包絡はここが本体）
    float flick = 0.55 + 0.45 * h1(floor(tt * 16.0) * 3.3 + ev * 13.1);
    // 群れ全体の入りと抜け
    float env = smoothstep(0.02, 0.14, ph) * (1.0 - smoothstep(0.55, 0.85, ph));
    // 辺: 左55% / 右15% / 上下15%ずつ（実測の左偏重）
    float side = h1(ev * 5.3 + uSeedPhase);
    float edge = side < 0.55 ? uv.x : side < 0.70 ? 1.0 - uv.x : side < 0.85 ? uv.y : 1.0 - uv.y;
    // 深さ: 縁の細い帯か、深く洗うかの二極（実測 2%〜37%）
    float deep = h1(ev * 11.9 + uSeedPhase);
    float reach = mix(0.05, 0.40, deep * deep);
    float mura = smoothstep(0.10, 0.90, texture(uGrainTex, vec2(uv.y, uv.x) * 0.6 + vec2(ev * 0.37, 0.0)).b);
    float shape = (1.0 - smoothstep(0.0, reach, edge)) * mix(0.60, 1.0, mura);
    // 色: 琥珀 / 赤 / 白っぽい暖色（実測の正規化色そのまま）。
    // 独立ハッシュだと同じ色が4.1回続いた。色は入射光の状況で変わるものなので、
    // 巡回（ev % 3）にseedのオフセットと軽い揺らぎを足して、続かないようにする。
    // ※辺は触らない：実物はカートリッジの隙間という固定の物理原因があり、左偏重・繰り返しが正しい
    float ci = mod(ev + floor(uSeedPhase * 3.0) + step(0.85, h1(ev * 7.1 + uSeedPhase)), 3.0);
    vec3 tint = ci < 1.0 ? vec3(1.0, 0.78, 0.14)
              : ci < 2.0 ? vec3(1.0, 0.25, 0.08)
                         : vec3(1.0, 0.94, 0.90);
    c += tint * on * env * pulse * flick * shape * uLeak * 0.85;
  }
  // light leakはdamageが高い時だけ、長めのfilm frame群で端から稀に入る。
  // dust/scratchと独立したseed式なので、同じ瞬間に常時重なることがない。
  if (uDamage > 0.0 && uLeak <= 0.0) {
    float leakFrame = floor((uTime + uSeedPhase) * 0.31);
    float leakOn = step(mix(0.995, 0.80, uDamage), h1(leakFrame * 19.7 + uSeedPhase));
    float fromLeft = step(0.5, h1(leakFrame * 5.3 + uSeedPhase));
    float edge = mix(1.0 - uv.x, uv.x, fromLeft);
    float leakShape = (1.0 - smoothstep(0.0, 0.42, edge)) * smoothstep(0.15, 0.95, h1(leakFrame * 13.1 + uv.y * 4.7 + uSeedPhase));
    c += vec3(1.0, 0.20, 0.035) * leakOn * leakShape * uDamage * 0.22;
  }
  // ===== つなぎ（v7）=====
  // 大原則:
  //  - 画は弱め、光は足す（参照14イベントの回帰: ゲイン0.32・加算0.78。乗算露出ではない）
  //  - 幾何形状（帯・矩形）は使わない。空間の形はすべて grainTex の低周波から作る
  //  - 光は一様に点かない。**一部から始まって全体へ広がる**（下記）
  if (uTransKind > 0) {
    float k = uTransAmt;
    float p = uTransPhase;
    // 【2026-08-16 復活・全面書き換え】前版は勾配をほぼ撤去していた（比1.15）。
    // 撤去の根拠にした「勾配比1.04〜1.17」は **9分割の絶対値**を比べた誤りで、
    // 正しくは**素からの増分**で見る。参照14イベントを測り直すと:
    //   頂上での増分比 中央値3.68（範囲1.9〜18.7）＝設計書の「2〜6倍」がほぼ正しかった
    //   立ち上がり中の増分比 中央値**37**（範囲3.5〜1103）＝光は一部から始まる
    // ＝ユーザー目視①「画面全体ではなく右下から全体に広がったり」。起点は毎回違う（黄金角）。
    // R = そのコマの「最強／最弱」比。立ち上がりで大きく、頂上で uTransGrad(2〜7) に落ち着く。
    float kk0 = clamp(k, 0.0, 1.0);
    // gDir = その場所の光の届き具合(0〜1)。立ち上がりは起点だけ(最弱は1/40)、頂上に向けて
    // 全面へ広がり、頂上では uTransGrad(2〜7倍) の残差だけが残る。t=kk^2.5 で「最初は起点だけ・
    // あとから一気に全面」という参照の見え方になる（t=kk だと早く均一化して勾配が消える）。
    float t = pow(kk0, 2.5);
    float s = smoothstep(0.0, 1.0, clamp(dot(uv - 0.5, uTransDir) * 1.4 + 0.5, 0.0, 1.0));
    // uTransGrad=1.0 は「頂点では全面が均一に光る」の意味（作品の終わりで使う）。
    // 下限を1.2にしていると弱い側に必ず影が残り、片側だけ光って終わる（ユーザー報告）。
    float fl = mix(1.0 / 40.0, 1.0 / max(uTransGrad, 1.0), t);
    float gDir = fl + (1.0 - fl) * s;
    gDir *= mix(0.82, 1.18, texture(uGrainTex, uv * 0.10 + vec2(uTransSeed * 3.7, uTransSeed * 1.9)).g);
    gDir = clamp(gDir, 0.0, 1.0);
    // g は8mm語彙(2/3)が使う穏やかな有機ムラ。こちらは1前後のままにする（露出量に直接効くため）
    float g = mix(0.90, 1.10, texture(uGrainTex, uv * 0.10 + vec2(uTransSeed * 1.3, uTransSeed * 4.1)).g);
    // 有機マスク（暖色系が広がる形）
    // ムラは大きな塊で。細かいと粒ノイズに見える
    float m = mix(0.55, 1.0, texture(uGrainTex, uv * 0.12 + vec2(uTransSeed * 7.3, uTransSeed * 3.1)).r);

    if (uTransKind == 1) {
      // 【2026-08-16 実装ミスの修正】前版は「画を自分のボケと置き換える」ため wide/bl を主役にしたが、
      // このシェーダの wide/bl は **明部だけを抜き出した滲み**（閾値処理済み）であって全画面のボケではない。
      // 置き換えると画が暗く沈む（実測: k=0.6 で平均158→120）＝ユーザー評「暗く滲む」。
      // よって「画は残したまま、光を足す」加算ヴェールへ戻し、滲みは*足して*柔らかさだけ担わせる。
      // 実物の要件は2つ:「明るさが上がる」と「コントラストが崩れる」。加算は両方を同時に満たす
      // （暗部が大きく持ち上がり、明部は頭打ちになるので階調が上端に圧縮される）。
      // 【2026-08-16 実写での照合で再訂正】露出を上げる形（exp2(2.2k)）は、実写に当てると
      // k=0.6で画が消えた純白の板になった（平均255・5%点255・std4）。参照の頂上は 平均250・
      // 5%点238・**std13＝まだ絵が残っている**。＝ユーザー評「白飛びしすぎて視線が持っていかれる」。
      // 参照8イベントの回帰でも「ゲイン0.32（1未満）＋加算0.78」＝**画を弱めて光を足す**形だった。
      // 設計書の大原則「露出は乗算」は黒帯込みの誤測定（5%点0）に立脚しており、実物は逆。
      float kk = clamp(k, 0.0, 1.0);
      vec3 wsum = wide + bl + vec3(1e-4);
      vec3 veilCol = wsum / max(max(wsum.r, wsum.g), wsum.b);
      // 借用は0.20まで下げる。0.55だと窓の青を拾って寒色に転び、参照の暖かい光と別物になる。
      // 基準色(1.0,0.985,0.965)は参照8イベントの加算成分の中央値(1.000/0.984/0.965)と一致。
      veilCol = mix(vec3(1.0, 0.985, 0.965), veilCol, 0.20);
      veilCol *= uTransTint > 0.0 ? vec3(1.03, 1.00, 0.98) : vec3(0.98, 1.00, 1.02);
      // 減衰と加算は**同じ kg** で動かす。別々にすると、光の届いていない側で画だけが弱まり
      // 「暗く滲む」が再発する（実測: 分離すると弱い側の増分が負になり比が135〜553に暴れた）。
      float kg = kk * gDir;
      c = c * (1.0 - 0.68 * kg)                  // 画は弱まる（回帰のゲイン0.32）
        + veilCol * (1.20 * kg)                  // 光を足す（回帰の加算0.78・勾配ぶんを見込んで1.20）
        + (wide * 0.9 + bl * 0.5) * (0.55 * kg); // 滲みは柔らかさ担当
      // 回復側の色被り（ユーザー目視②）。符号で系統、絶対値で強さ。実測 R-B ±0.14 / R-G ±0.10。
      // 白の最中は rec≈0 なので効かず、抜けぎわの数コマにだけ色が出る。
      float rec = abs(uTransTint);
      vec3 castCol = uTransTint > 0.0 ? vec3(1.10, 1.00, 0.86)    // 琥珀寄り（R-G+22 / R-B+46）
                                      : vec3(0.90, 1.02, 1.04);   // 青緑寄り（R-G-26 / R-B-36）
      c *= mix(vec3(1.0), castCol, rec);
      c = shoulderTone(c, 1.9);
    } else if (uTransKind == 7) {                // 暖色ウォッシュ（アイル③④）
      // 辺からの距離。uTransDirの向きの辺から差し込む
      float e = 0.5 - dot(uv - 0.5, uTransDir);
      float reach = 0.6 + 0.2 * fract(uTransSeed * 11.0);
      float w = (1.0 - smoothstep(0.0, reach, e)) * m;
      c *= exp2(1.2 * k * w);
      c *= mix(vec3(1.0), vec3(1.00, 0.62, 0.35), 0.6 * k * w);
      c = shoulderTone(c, 1.5);
    } else if (uTransKind == 2) {                // 白抜けポップ（8mm・1〜2コマ）
      c *= exp2(4.5 * k * (p < 0.5 ? 1.0 : 0.55) * g);
      c = shoulderTone(c, 1.35);
    } else if (uTransKind == 3) {                // 露出ランプイン（8mm・5コマで戻る）
      c *= exp2(2.0 * k * g);
      c = shoulderTone(c, 1.5);
    } else if (uTransKind == 4) {                // 8mmの焼け＝暖色ブリーチ（白へ抜ける）
      // 【2026-08-16 独立分析で全面改訂】リバーサルフィルムは光が当たるほど染料が薄くなり
      // ベース（＝白）へ抜ける。黒くなるのはネガの挙動で、映写された像には起こらない。
      // 実測: 明るさは単調増加・コントラストは単調減少・一度も暗くならない・白は純白でなくクリーム。
      // 色は「赤い光を足した結果」チャンネルが順に飽和して 赤→サーモン→橙→黄白 と回る（補間ではない）
      // 【2026-08-16 追加】前版は全画面一様で、境目ごとに変わるのは長さとムラの位置だけだった。
      // 青い記憶側でも自動配分に入れた結果「どの境目でも同じオレンジ」に見えたため、
      // ①光と同じ gDir（起点から広がる）を掛けて、方向と広がり方を境目ごとに変える。
      float q = clamp(p, 0.0, 1.0);
      float A = exp2(mix(-7.0, 5.4, q)) - exp2(-7.0);          // 迷光量（ストップで振る）
      vec3 sens = vec3(1.0, 0.10, 0.02);                        // 赤層が先に飽和する
      float kg4 = k * mix(0.45, 1.0, gDir);                     // 起点側が濃く、反対側は薄く残る
      c = c * (1.0 + 0.6 * A * sens * kg4) + A * sens * m * kg4;
      c = vec3(1.0) - exp(-c);                                  // ソフトショルダー（ハードクリップ禁止）
      // 抜けきる手前はクリーム（純白にしない）
      c = mix(c, vec3(0.983, 0.955, 0.870), smoothstep(0.72, 1.0, q) * kg4 * 0.85);
    } else if (uTransKind == 5) {                // 黒コマ→浮き上がり（8mm）
      float fr = p;                              // コマ番号
      c *= fr < 0.5 ? mix(0.08, 0.15, fract(uTransSeed * 5.0))
                    : 1.0 - 0.9 * pow(0.55, fr - 1.0) * k;
    } else if (uTransKind == 8) {                // 暗転して終わる（作品の最後だけ）
      // 単純な黒へのmixではなく、露出を落としながら黒へ寄せる。
      // フィルムの絞りが閉じるように、明部が先に沈んで最後に全体が黒くなる。
      float kk8 = clamp(k, 0.0, 1.0);
      c = c * exp2(-4.0 * kk8);
      c = mix(c, vec3(0.0), kk8 * kk8);
    } else if (uTransKind == 6) {                // 暖色フレア（旧「ネガ焼け」）— 作品に1回の切り札
      // 【2026-08-16 ユーザー決定で全面作り直し】
      // これまで参照のロールエンド（黒→橙の穴が広がる→白）に忠実に作ってきたが、実機評価で
      //   「爆発のように見えて主張が強く、まったくエモくない。イメージは感光のよう」
      //   「別のクリップ間に適用しても同じに見えて、エフェクト感が強い」
      // となった。後者は構造的な問題で、穴型はコマごとの色が固定・変わるのは起点だけだった。
      // よって**①光とまったく同じ式**にし、ヴェールの色だけを橙・黄・茶へ振って差を作る。
      // これで頂上長1〜15コマ・方向・多重パルス・勾配・強弱がすべて境界ごとに変わる（光と同じ）。
      float kk = clamp(k, 0.0, 1.0);
      vec3 wsum6 = wide + bl + vec3(1e-4);
      vec3 veil6 = wsum6 / max(max(wsum6.r, wsum6.g), wsum6.b);
      // 光が強く当たる側は黄、弱い側は茶。感光の「奥から燃える」色域をgDirで作る
      vec3 warm = mix(vec3(0.50, 0.14, 0.03), vec3(1.00, 0.58, 0.18), gDir);
      veil6 = mix(warm, veil6, 0.08);                 // 借用は光(0.20)より低い＝暖色を保つ
      veil6 *= uTransTint > 0.0 ? vec3(1.04, 0.99, 0.92) : vec3(0.97, 1.00, 0.98);
      float kg6 = kk * gDir;
      c = c * (1.0 - 0.80 * kg6)                      // 画は光より少し強めに弱める
        + veil6 * (1.15 * kg6)                        // 暖色は輝度が低いぶん量を増やす
        + (wide * 0.8 + bl * 0.45) * (0.45 * kg6);
      // 回復側は琥珀へ寄せる（光の青緑側は使わない＝暖色の語彙を保つ）
      float rec6 = abs(uTransTint);
      c *= mix(vec3(1.0), vec3(1.12, 0.98, 0.80), rec6);
      c = shoulderTone(c, 1.9);
    }
  }
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // 粒子: 空間的につながったテクスチャをコマごとにずらして重ねる。
  // 加算ではなく乗算的に効かせる（フィルムと同じで、真っ黒には粒が乗らない）
  vec2 guv = gl_FragCoord.xy / (uGrainScale * 512.0) + uGrainOfs;
  vec3 n1 = texture(uGrainTex, guv).rgb;
  vec3 n2 = texture(uGrainTex, mat2(0.82,-0.57,0.57,0.82) * guv * 1.618 + uGrainOfs.yx).rgb;
  if (uGrain > 0.0) {
    // 加算ノイズではなく、log濃度の揺らぎとして露光密度を近似する。
    // RGB共通の濃度を主成分にし、弱いresidualだけで完全モノクロを避ける。
    vec3 grainRgb = mix(n1, n2, 0.42) - 0.5;
    float commonDensity = dot(grainRgb, vec3(0.299, 0.587, 0.114));
    vec3 residual = clamp(grainRgb - vec3(commonDensity), vec3(-0.18), vec3(0.18));
    vec3 logC = log(max(c, vec3(0.001)));
    logC += (vec3(commonDensity) + residual * 0.28) * uGrain * 2.2 * grainWeight(l, uGrainCurve);
    c = exp(logC) - vec3(0.001);
  }
  // 8mmだけlinear作業値からRec.709相当のencoded値へ戻す。既存の0/1番効果は
  // 従来のencoded値経路のままにして、青い記憶の色と粒子の数値を上書きしない。
  // おわり（v8-20）。境目のエフェクトが何であっても、最後は必ず白か黒へ着地させる。
  // 粒子・周辺減光の後に置くので、沈み切ったあとに質感が残らない
  if (uEndAmt > 0.0) {
    vec3 endCol = uEndDark > 0.5 ? vec3(0.0) : vec3(1.0);
    c = mix(c, uLinearOptics > 0.5 ? (uEndDark > 0.5 ? vec3(0.0) : vec3(1.0)) : endCol, uEndAmt);
  }
  o = vec4(clamp(uLinearOptics > 0.5 ? toEncoded(c) : c, 0., 1.), 1.0);
}`;

const FS_PROBE = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
void main(){ o = vec4(uv, 0.0, 1.0); }`;

// 空間相関のある大判RGB粒子atlas。共通luma cloudに色残差を重ねるので、
// 相関は高いが完全なモノクロにはならない。通常の乱数APIは使わない。
function makeGrainTexture(size, seed = project.textureSeed) {
  const n = size * size, ch = 3, src = new Float32Array(n), cloudX = new Float32Array(n), cloud = new Float32Array(n), out = new Uint8Array(n * ch);
  let state = (seed >>> 0) || DEFAULT_TEXTURE_SEED;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
  for (let i = 0; i < n; i++) src[i] = random() - 0.5;
  const at = (a, x, y) => a[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) cloudX[y * size + x] = (at(src, x - 1, y) + 2 * at(src, x, y) + at(src, x + 1, y)) * 0.25;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) cloud[y * size + x] = (at(cloudX, x, y - 1) + 2 * at(cloudX, x, y) + at(cloudX, x, y + 1)) * 0.25;
  // 粗いcloudを追加して単一[1,2,1]スケールの規則感を消す。
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, coarse = (at(cloud, x - 3, y) + at(cloud, x + 3, y) + at(cloud, x, y - 3) + at(cloud, x, y + 3) + 4 * cloud[i]) / 8;
    const luma = cloud[i] * 0.72 + coarse * 0.28;
    for (let c = 0; c < ch; c++) out[i * ch + c] = clamp(Math.round(128 + (luma * 0.88 + (random() - 0.5) * 0.12) * 220), 0, 255);
  }
  return { data: out, size, seed: seed >>> 0 };
}

// クリップに効く補正（手動＋自動そろえ）
function clipBrightOf(c) { return c ? (c.bright || 0) + (project.autoAlign ? (c.autoBright || 0) : 0) : 0; }
function clipTempOf(c) { return c ? (c.temp || 0) + (project.autoAlign ? (c.autoTemp || 0) : 0) : 0; }
// 質感は作品全体で1本のフィルムとして共通。クリップごとに変えられるのは「どれだけ乗せるか」だけ。
// 粒子の性格・コマ送り・色は動かさないので、カットが混ざってもフィルムの一貫性は保たれる。
function clipFxScaleOf(c) { const v = c?.fxScale; return v == null ? 1 : clamp(v, 0, 1); }
// ハイキー（v5-4）。アイルMVの「1カット丸ごと白飛ばし」を1本のスライダーにまとめたもの。
// 露出+1.2EV・彩度-0.15・ソフト+0.3 を同時に動かす＝新シェーダ不要
function clipHighKeyOf(c) { const v = c?.highKey; return v == null ? 0 : clamp(v, 0, 1); }

function textureSeedUnit(seed, frame, salt = 0) {
  let x = (seed ^ Math.imul((frame | 0) + 1, 0x9e3779b1) ^ salt) >>> 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return (x >>> 0) / 0x100000000;
}

class GLPipe {
  constructor(canvas, { forceRgba8 = false } = {}) {
    this.cv = canvas;
    const gl = this.gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2が使えない端末です');
    this.forceRgba8 = forceRgba8;
    this.contextLost = false;
    this._disposed = false;
    this._programs = [];
    this._shaders = [];
    const mk = (t, src) => {
      const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('シェーダ: ' + gl.getShaderInfoLog(s));
      this._shaders.push(s);
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
      const result = { prog: p, u };
      this._programs.push(result);
      return result;
    };
    this.grade = prog(FS_GRADE, ['uFrame','uLut','uStrength','uExposure','uContrast','uSaturation','uFade','uTemp','uLutN','uTime','uWeave','uJump','uHandheld','uHandheldHz','uSpliceY','uSeedPhase','uLinearOptics','uHighlightCarry','uStockContrast','uStockSaturation','uStockBlackLift','uStockShoulder','uStockShadowTint','uStockHighlightTint','uRot','uVis',
      'uCorrOn','uCurveAN','uCurveBN','uHslA[0]','uHslB[0]','uCurveA[0]','uCurveB[0]']);
    this.blur = prog(FS_BLUR, ['uTex','uDir','uThresh','uFirst']);
    this.final = prog(FS_FINAL, ['uBase','uBloom','uBloomWide','uGrainTex','uBloomAmt','uWideAmt','uHalation','uVeil','uLetterbox','uVignette','uVigA','uEndAmt','uEndDark','uFlicker','uDust','uScratch','uGrain','uGrainScale','uTime','uGrainOfs','uGrainCurve','uSoften','uChroma','uDamage','uSeedPhase','uLeak','uTransKind','uTransAmt','uTransPhase','uTransGrad','uTransSeed','uTransTint','uTransDir','uLinearOptics','uTexel','uHaloColor','uVisF']);
    this.probe = prog(FS_PROBE, []);
    // テキストだけ頂点シェーダが違う（板ポリを任意の位置へ置くため）
    {
      const p = gl.createProgram();
      gl.attachShader(p, mk(gl.VERTEX_SHADER, VS_TEXT));
      gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FS_TEXT));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('リンク: ' + gl.getProgramInfoLog(p));
      const u = {};
      for (const n of ['uTex', 'uRect', 'uAlpha', 'uToLinear', 'uReveal', 'uTime', 'uSeedPhase', 'uWeave', 'uJump', 'uHandheld', 'uHandheldHz', 'uSpliceY', 'uVis', 'uTextRot', 'uTextAspect'])
        u[n] = gl.getUniformLocation(p, n);
      this.text = { prog: p, u };
      this._programs.push(this.text);
      gl.useProgram(p); gl.uniform1i(u.uTex, 6);
    }
    gl.useProgram(this.grade.prog);
    gl.uniform1i(this.grade.u.uFrame, 0);
    gl.uniform1i(this.grade.u.uLut, 1);
    gl.useProgram(this.blur.prog);
    gl.uniform1i(this.blur.u.uTex, 2);
    gl.useProgram(this.final.prog);
    gl.uniform1i(this.final.u.uBase, 2);
    gl.uniform1i(this.final.u.uBloom, 3);
    gl.uniform1i(this.final.u.uBloomWide, 5);
    gl.uniform1i(this.final.u.uGrainTex, 4);

    gl.activeTexture(gl.TEXTURE0);
    this.frameTex = this._newTex2();
    this.lutTex = gl.createTexture();
    this._intermediate = null;
    this.qualityPath = 'unallocated';
    this.w = 0; this.h = 0;

    this.grainTex = this._newTex2(true);
    this.grainSeed = null;
    this._uploadGrain(normalizeTextureSeed(project.textureSeed, project));
    this.uploadMode = 'direct';
    this.setLut(makeHikariLut());
    this._onContextLost = e => {
      e.preventDefault();
      this.contextLost = true;
      logErr('WebGL描画が一時停止しました。復帰後にプレビューを描き直します。');
    };
    this._onContextRestored = () => {
      this.contextLost = false;
      this.cv.dispatchEvent(new CustomEvent('hikari-gl-restored'));
    };
    canvas.addEventListener('webglcontextlost', this._onContextLost);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored);
  }
  _newTex2(repeat = false) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    return t;
  }
  _clearGlErrors() {
    const gl = this.gl;
    while (gl.getError() !== gl.NO_ERROR) { /* 前段の古いエラーを今回のFBO判定へ混ぜない */ }
  }
  _deleteIntermediates() {
    const gl = this.gl, r = this._intermediate;
    if (!r) return;
    r.textures.forEach(t => gl.deleteTexture(t));
    r.fbos.forEach(f => gl.deleteFramebuffer(f));
    this._intermediate = null;
    this.w = 0; this.h = 0;
    this.qualityPath = 'unallocated';
  }
  _probeFramebuffers() {
    const gl = this.gl, r = this._intermediate;
    if (!r) throw new Error('FBOが未確保です');
    this._clearGlErrors();
    gl.useProgram(this.probe.prog);
    for (let i = 0; i < r.fbos.length; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbos[i]);
      gl.viewport(0, 0, r.sizes[i][0], r.sizes[i][1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`FBO ${i + 1}が不完全です`);
      // clearだけでは型・シェーダの組み合わせを検出できないため、各FBOへ実際に1 drawする。
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const err = gl.getError();
      if (err !== gl.NO_ERROR) throw new Error(`FBO ${i + 1}の描画検査に失敗しました (${err})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  _allocateIntermediates(w, h, kind) {
    const gl = this.gl;
    if (kind === 'rgba16f' && !gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_floatが使えません');
    this._deleteIntermediates();
    const bw = Math.max(2, w >> 3), bh = Math.max(2, h >> 3);
    const sizes = [[w, h], [bw, bh], [bw, bh], [bw, bh]];
    const internal = kind === 'rgba16f' ? gl.RGBA16F : gl.RGBA8;
    const type = kind === 'rgba16f' ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    const textures = [], fbos = [];
    try {
      for (const [tw, th] of sizes) {
        const tex = this._newTex2();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, tw, th, 0, gl.RGBA, type, null);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        // incomplete時もcatchで必ずdeleteできるよう、作成直後に所有配列へ入れる。
        textures.push(tex); fbos.push(fbo);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`FBO ${textures.length}が不完全です`);
      }
      this._intermediate = { textures, fbos, sizes, bw, bh, kind };
      this.w = w; this.h = h;
      this._probeFramebuffers();
      this.qualityPath = kind;
    } catch (e) {
      textures.forEach(t => gl.deleteTexture(t));
      fbos.forEach(f => gl.deleteFramebuffer(f));
      this._intermediate = null;
      this.w = 0; this.h = 0;
      throw e;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0);
    }
  }
  _ensureIntermediates(w, h) {
    if (this._intermediate && this.w === w && this.h === h) return;
    this._deleteIntermediates();
    if (!this.forceRgba8) {
      try {
        this._allocateIntermediates(w, h, 'rgba16f');
        return;
      } catch (e) {
        // float資源を一度も残さず全deleteしてから、同じFBO構成をRGBA8で一回だけ組み直す。
        this._deleteIntermediates();
        logErr(`RGBA16Fを使えないためRGBA8で描画します: ${e.message}`);
      }
    }
    this._allocateIntermediates(w, h, 'rgba8');
  }
  _uploadGrain(seed) {
    if (this.grainSeed === seed) return;
    const gl = this.gl;
    const grain = GRAIN?.seed === seed ? GRAIN : (GRAIN = makeGrainTexture(512, seed));
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.grainTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, grain.size, grain.size, 0, gl.RGB, gl.UNSIGNED_BYTE, grain.data);
    gl.activeTexture(gl.TEXTURE0);
    this.grainSeed = seed;
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
  async _uploadFrame(source) {
    const gl = this.gl;
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
  }
  // 焼き込みテキストをfboAへ混ぜる。texturesはbounding box単位の小さなものだけ持つ
  _drawTexts(items, ow, oh, o) {
    const gl = this.gl;
    if (!this.textTex) {
      this.textTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, this.textTex);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
        gl.texParameteri(gl.TEXTURE_2D, k, v);
    }
    gl.useProgram(this.text.prog);
    const u = this.text.u;
    gl.uniform1f(u.uTime, o.time); gl.uniform1f(u.uSeedPhase, o.seedPhase);
    gl.uniform1f(u.uWeave, o.weave); gl.uniform1f(u.uJump, o.jump);
    gl.uniform1f(u.uHandheld, o.handheld || 0);
    gl.uniform1f(u.uHandheldHz, Math.min(o.handheldHz || 24, 19));
    gl.uniform1f(u.uSpliceY, o.spliceY || 0);
    gl.uniform2f(u.uVis, o.vis[0], o.vis[1]);
    gl.uniform1f(u.uToLinear, o.toLinear);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.textTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    for (const it of items) {
      const ras = rasterizeText(it.t, ow, oh);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ras.canvas);
      const w = ras.w / ow, h = ras.h / oh;
      gl.uniform4f(u.uRect, clamp(it.t.x, 0, 1) - w / 2, clamp(it.t.y, 0, 1) - h / 2, w, h);
      gl.uniform1f(u.uTextRot, ((it.t.rot || 0) * Math.PI) / 180);
      gl.uniform1f(u.uTextAspect, ow / Math.max(1, oh));
      gl.uniform1f(u.uAlpha, it.alpha);
      gl.uniform1f(u.uReveal, it.reveal);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.disable(gl.BLEND);
  }
  _render(srcW, srcH, rot, effectTime, clip, renderOptions = {}) {
    const gl = this.gl;
    // 長押し中は「調整前」。色・質感・クリップ補正を全部外し、画づくりだけ（レターボックス）は保つ
    if (renderOptions.bypassLook) {
      renderOptions = { ...renderOptions, bypassClip: true, lut: 'none', filmProfile: project.filmProfile,
        adjust: { exposure: 0, contrast: 0, saturation: 0, fade: 0, grain: 0, grainSize: 1, glow: 0,
          halation: 0, damage: 0, strength: 0, effect: 0, handheld: 0, leak: 0, trans: 0, judder: 0, letterbox: project.adjust.letterbox } };
    }
    const a = renderOptions.adjust || project.adjust;
    // サムネイルの試し描きでは、作品の状態を書き換えずにここだけ差し替える
    const profileKey = renderOptions.filmProfile, lutName = renderOptions.lut ?? project.lut;
    const fx = textureFx(a.effect, profileKey);
    const profile = currentFilmProfile(profileKey);
    const r = this._intermediate;
    if (!r) throw new Error('描画用FBOが未確保です');
    const [texA, texB, texC, texD] = r.textures;
    const [fboA, fboB, fboC, fboD] = r.fbos;
    const ow = this.cv.width, oh = this.cv.height;
    const seed = normalizeTextureSeed(project.textureSeed, project);
    const time = Number.isFinite(effectTime) ? effectTime : 0;
    const isFilm = a.effect === 2;
    const seedPhase = textureSeedUnit(seed, 0, 0x51ed270b);
    this._uploadGrain(seed);
    this._clearGlErrors();

    // パス1: グレード（露出・色温度・LUT・微揺れ）→ fboA
    // FBO検査・resize・float fallbackがactive textureを変えても、入力frameを必ず再bindする。
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    const rw = rot % 180 === 0 ? srcW : srcH, rh = rot % 180 === 0 ? srcH : srcW;
    const arOut = ow / oh, arSrc = rw / rh;
    // 収め方は「このクリップだけの指定 → 作品ぜんぶの指定」の順に見る。
    // 横の作品にたての1本が混ざったとき、そこだけ画面いっぱいにして帯を消せるようにするため。
    // renderOptions.fit はプリセットのお試し表示が使うので、いちばん強い
    const vis = (renderOptions.fit || (clip && clip.fit) || project.fit) === 'cover'
      ? (arSrc > arOut ? [arOut / arSrc, 1] : [1, arSrc / arOut])
      : (arSrc > arOut ? [1, arSrc / arOut] : [arOut / arSrc, 1]);
    gl.useProgram(this.grade.prog);
    const u = this.grade.u;
    gl.uniform2f(u.uVis, vis[0], vis[1]);
    gl.uniform1i(u.uRot, rot);
    gl.uniform1f(u.uStrength, lutName === 'none' ? 0 : a.strength);
    // clipBrightOf は clip と project を直に読むので、bypass はここで打ち消す
    const noClip = !!renderOptions.bypassClip;
    // 質感をどれだけ乗せるか。テキストの揺れにも同じ係数を掛けるのでここで決めておく
    const fs = noClip ? 1 : clipFxScaleOf(clip);
    // ハイキー（クリップ単位）。露出・彩度・ソフトを一度に動かすので、ここで係数を作っておく
    const hk = noClip ? 0 : clipHighKeyOf(clip);
    gl.uniform1f(u.uExposure, a.exposure + (noClip ? 0 : clipBrightOf(clip)) + hk * 1.2);
    gl.uniform1f(u.uTemp, noClip ? 0 : clipTempOf(clip));
    // HSL・カーブ。クリップ側→作品側の順に通す。全部ゼロなら分岐ごと飛ばす
    const corrAdjust = renderOptions.adjust || project.adjust;
    const corrClip = noClip ? null : clip;
    const corrOn = !noClip && hasCorrection(corrClip, corrAdjust) ? 1 : 0;
    gl.uniform1f(u.uCorrOn, corrOn);
    if (corrOn) {
      const ca = curveToArray(curveOf(corrClip)), cb = curveToArray(corrAdjust.curve);
      gl.uniform3fv(u['uHslA[0]'], hslToArray(hslOf(corrClip)));
      gl.uniform3fv(u['uHslB[0]'], hslToArray(corrAdjust.hsl));
      gl.uniform2fv(u['uCurveA[0]'], ca.data);
      gl.uniform2fv(u['uCurveB[0]'], cb.data);
      gl.uniform1f(u.uCurveAN, ca.n);
      gl.uniform1f(u.uCurveBN, cb.n);
    }
    gl.uniform1f(u.uContrast, a.contrast);
    // ハイキーの彩度: MV実測でハイキーカットの彩度は通常の2〜83%（明るいほど落ちる）。-0.35で中庸に合わせる
    gl.uniform1f(u.uSaturation, a.saturation - hk * 0.35);
    gl.uniform1f(u.uFade, a.fade);
    gl.uniform1f(u.uTime, time % 100000);
    gl.uniform1f(u.uWeave, (fx.weave || 0) * (noClip ? 1 : clipFxScaleOf(clip)));
    gl.uniform1f(u.uJump, (fx.jump || 0) * (noClip ? 1 : clipFxScaleOf(clip)));
    // 手ブレは作品ぜんたいの値。質感と同じくクリップの「質感の強さ」に従う
    const handheld = (a.handheld || 0) * fs;
    gl.uniform1f(u.uHandheld, handheld);
    // MVの実効フレームレートは約19fps（複製フレーム21.7%）。8mmは16fpsのまま
    gl.uniform1f(u.uHandheldHz, Math.min(fx.hz || 24, 19));
    if (DEV_TRACE && renderOptions.spliceY) trace('splice.render', () => ({ y: +renderOptions.spliceY.toFixed(4) }));
    gl.uniform1f(u.uSpliceY, renderOptions.bypassLook ? 0 : (renderOptions.spliceY || 0));
    gl.uniform1f(u.uSeedPhase, seedPhase);
    gl.uniform1f(u.uLinearOptics, isFilm ? 1 : 0);
    gl.uniform1f(u.uStockContrast, isFilm ? profile.stockContrast : 0);
    gl.uniform1f(u.uStockSaturation, isFilm ? profile.stockSaturation : 0);
    gl.uniform1f(u.uStockBlackLift, isFilm ? profile.blackLift : 0);
    gl.uniform1f(u.uStockShoulder, isFilm ? profile.shoulder : 0);
    gl.uniform3fv(u.uStockShadowTint, isFilm ? profile.shadowTint : [0, 0, 0]);
    gl.uniform3fv(u.uStockHighlightTint, isFilm ? profile.highlightTint : [0, 0, 0]);
    // RGBA8 fallbackはlinear演算を保つが、明部のfloat headroomを持ち越さない。
    gl.uniform1f(u.uHighlightCarry, isFilm && r.kind === 'rgba16f' ? profile.highlightCarry : 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
    gl.viewport(0, 0, ow, oh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 焼き込みテキスト: ここで混ぜると、このあとの滲み・粒子・明滅・傷を映像と一緒に浴びる
    const burnTexts = renderOptions.bypassLook ? [] : (renderOptions.texts || []).filter(x => x.t.burnIn);
    if (burnTexts.length) {
      this._drawTexts(burnTexts, ow, oh, {
        toLinear: isFilm ? 1 : 0,
        time: time % 100000, seedPhase, weave: (fx.weave || 0) * fs, jump: (fx.jump || 0) * fs, handheld, handheldHz: fx.hz || 24, spliceY: renderOptions.bypassLook ? 0 : (renderOptions.spliceY || 0), vis,
      });
    }

    // パス2〜5: ブルーム。狭い滲み（texC）と、それをさらにぼかした広い滲み（texD）の二段
    const useGlow = (fx.bloom > 0 || fx.wide > 0) && (a.glow > 0 || a.halation > 0);
    if (useGlow) {
      gl.useProgram(this.blur.prog);
      const b = this.blur.u;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(b.uFirst, 1);
      gl.uniform1f(b.uThresh, fx.thresh);
      gl.uniform2f(b.uDir, 1 / r.bw, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
      gl.viewport(0, 0, r.bw, r.bh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.uniform1i(b.uFirst, 0);
      gl.uniform2f(b.uDir, 0, 1 / r.bh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboC);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // さらに3倍の間隔でぼかして、広くやわらかい滲み（ハレーションもここから作る）
      gl.bindTexture(gl.TEXTURE_2D, texC);
      gl.uniform2f(b.uDir, 3 / r.bw, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.uniform2f(b.uDir, 0, 3 / r.bh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboD);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 仕上げ: ブルーム合成・周辺減光・明滅・ダスト・粒子・レターボックス → 画面
    gl.useProgram(this.final.prog);
    const f = this.final.u;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texA);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, useGlow ? texC : texA);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, useGlow ? texD : texA);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.grainTex);
    // 露出爆発のときは滲みも増える（アイルらしさの本体。合成係数を持ち上げるだけ）
    const tr0 = renderOptions.bypassLook ? null : renderOptions.trans;
    // 抜け際（phase>0.5）ほど滲みを強くする。白から次の画が柔らかく現れる見え方は、
    // 露出ではなく「滲みの量」で決まる（実測のコマ送りで確認）
    const trBoost = (tr0 && tr0.kind === 1)
      ? (1 + tr0.amt * (1.2 + 3.0 * Math.max(0, (tr0.phase - 0.45) / 0.55))) : 1;
    // fs = このクリップに質感をどれだけ乗せるか（0〜1）。粒子の性格・コマ送り・色・レターボックスは変えない
    gl.uniform1f(f.uBloomAmt, fx.bloom * a.glow * fs * trBoost);
    gl.uniform1f(f.uWideAmt, fx.wide * a.glow * fs * trBoost);
    gl.uniform1f(f.uHalation, useGlow ? a.halation * fs : 0);
    gl.uniform1f(f.uVeil, (fx.veil || 0) * fs);
    gl.uniform1f(f.uLetterbox, a.letterbox ? 0.11 : 0);
    gl.uniform1f(f.uVignette, (fx.vignette || 0) * fs * (a.vig ?? 1));
    // 落ち方の鋭さ。2.0が標準（外へ行くほど加速して落ちる）
    gl.uniform1f(f.uVigA, fx.vigA ?? 2.0);
    // おわり。境目のエフェクトとは別の層で、必ず白または黒へ着地させる
    gl.uniform1f(f.uEndAmt, renderOptions.endAmt ?? 0);
    gl.uniform1f(f.uEndDark, (a.endDark ? 1 : 0));
    gl.uniform1f(f.uFlicker, (fx.flicker || 0) * fs);
    gl.uniform1f(f.uDust, (fx.dust || 0) * fs);
    gl.uniform1f(f.uScratch, (fx.scratch || 0) * fs);
    gl.uniform1f(f.uGrain, a.grain * fs);
    // 物理pxを出力高さへ比例させ、540p previewと1080p exportの相対粒径を揃える。
    gl.uniform1f(f.uGrainScale, Math.max(0.5, a.grainSize) * (oh / 1080));
    gl.uniform1f(f.uGrainCurve, fx.curve || 0);
    gl.uniform1f(f.uSoften, (fx.soften || 0) * fs + hk * 0.3);
    gl.uniform1f(f.uChroma, (fx.chroma || 0) * fs);
    gl.uniform1f(f.uDamage, isFilm ? a.damage * fs : 0);
    // 感光は8mm以外（自分の色・青い記憶）でも使える。アイルMVにも感光カットがある
    gl.uniform1f(f.uLeak, (a.leak || 0) * fs);
    // つなぎは境界の現象なので、クリップの質感の強さでは薄めない（カット2つにまたがるため）
    const tr = renderOptions.bypassLook ? null : renderOptions.trans;
    gl.uniform1i(f.uTransKind, tr ? tr.kind : 0);
    gl.uniform1f(f.uTransAmt, tr ? tr.amt : 0);
    gl.uniform1f(f.uTransPhase, tr ? tr.phase : 0);
    gl.uniform1f(f.uTransGrad, tr?.face ? tr.face.grad : 0);
    gl.uniform1f(f.uTransSeed, tr?.face ? tr.face.seed : 0);
    // uTransTint は「符号＝色の系統（+琥珀 / −青緑）」「絶対値＝回復側の色被りの強さ」を兼ねる。
    // 0にすると符号が消えるので下限を置く（uniformを増やさないための約束）。
    gl.uniform1f(f.uTransTint, tr?.face
      ? tr.face.tint * Math.max(0.001, tr.recover || 0)
      : 1);
    gl.uniform2f(f.uTransDir, tr?.face ? tr.face.dir[0] : 0, tr?.face ? tr.face.dir[1] : 0);
    gl.uniform1f(f.uSeedPhase, seedPhase);
    gl.uniform1f(f.uLinearOptics, isFilm ? 1 : 0);
    gl.uniform2f(f.uTexel, 1.4 / ow, 1.4 / oh);
    gl.uniform2f(f.uVisF, vis[0], vis[1]);
    gl.uniform3f(f.uHaloColor, fx.halo[0], fx.halo[1], fx.halo[2]);
    // 粒子はフィルムに焼き付いているので、コマごとに1回だけ更新する
    // （表示のたびに変えるとデジタルノイズの見え方になる）
    const gseed = Math.floor(time * Math.max(1, fx.hz || 1));
    gl.uniform2f(f.uGrainOfs, textureSeedUnit(seed, gseed, 0x68bc21eb), textureSeedUnit(seed, gseed, 0x02e5be93));
    gl.uniform1f(f.uTime, time % 100000);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, ow, oh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 焼き込まない文字はここ（質感のあと）で重ねる。粒子も滲みも乗らない素の文字になる
    const cleanTexts = renderOptions.bypassLook ? [] : (renderOptions.texts || []).filter(x => !x.t.burnIn);
    if (cleanTexts.length) {
      this._drawTexts(cleanTexts, ow, oh, { toLinear: 0, time, seedPhase, weave: 0, jump: 0, handheld: 0, vis: [1, 1] });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, ow, oh);
    }
    gl.activeTexture(gl.TEXTURE0);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) throw new Error(`WebGL描画に失敗しました (${err})`);
  }
  async draw(source, srcW, srcH, rot, effectTime, clip, renderOptions = {}) {
    if (this._disposed) throw new Error('破棄済みの描画器です');
    if (this.contextLost) throw new Error('WebGL描画の復帰待ちです');
    const ow = this.cv.width, oh = this.cv.height;
    await this._uploadFrame(source);
    this._ensureIntermediates(ow, oh);
    try {
      this._render(srcW, srcH, rot, effectTime, clip, renderOptions);
    } catch (e) {
      if (this.qualityPath !== 'rgba16f') throw e;
      // float実描画で失敗した場合も、全float資源を消してRGBA8を一度だけ確保・同じdrawを再試行する。
      this._deleteIntermediates();
      logErr(`RGBA16Fの実描画に失敗したためRGBA8で再試行します: ${e.message}`);
      this._allocateIntermediates(ow, oh, 'rgba8');
      this._render(srcW, srcH, rot, effectTime, clip, renderOptions);
    }
  }
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const gl = this.gl;
    this.cv.removeEventListener('webglcontextlost', this._onContextLost);
    this.cv.removeEventListener('webglcontextrestored', this._onContextRestored);
    this._deleteIntermediates();
    [this.frameTex, this.lutTex, this.grainTex].forEach(t => { if (t) gl.deleteTexture(t); });
    this._programs.forEach(p => gl.deleteProgram(p.prog));
    this._shaders.forEach(s => gl.deleteShader(s));
  }
}

let GRAIN = null;
let preview = new GLPipe($('previewCanvas'));
$('previewCanvas').addEventListener('hikari-gl-restored', () => {
  const old = preview;
  try {
    preview = new GLPipe($('previewCanvas'));
    applyLutSelection(preview);
    redraw();
  } finally { old.dispose(); }
});

function applyLutSelection(pipe) {
  if (project.lut === 'mine' && project.mineLutData) pipe.setLut(project.mineLutData);
  else if (project.lut === 'airu' && project.airuLutData) pipe.setLut(project.airuLutData);
  else if (project.lut === 'film8' && project.film8LutData) pipe.setLut(project.film8LutData);
  else if (project.lut === 'file' && project.lutFileData) pipe.setLut(project.lutFileData);
  else if (project.lut === 'none') pipe.setLut(makeIdentityLut());
  else pipe.setLut(makeHikariLut());
}

// ===== 完成イメージのライブサムネイル（B2）=====
// 現在の再生ヘッド位置のフレームへ、各プリセットを実際に当てて64pxで描く。
// 書き出しと同じGLパイプを通すので、カードに映るのは本当に出る絵。
// 専用pipeを1つだけ持ち回す（毎回作ると _probeFramebuffers の再確保で重い）。
let thumbPipe = null, thumbTimer = 0, thumbBusy = false;
const THUMB_PX = 64;
function lutDataFor(name) {
  if (name === 'mine') return project.mineLutData;
  if (name === 'airu') return project.airuLutData;
  if (name === 'film8') return project.film8LutData;
  if (name === 'file') return project.lutFileData;
  if (name === 'none') return makeIdentityLut();
  return makeHikariLut();
}
// プリセットを当てたときの adjust を、作品を書き換えずに組み立てる（applyPreset と同じ規則）
function presetAdjust(p) {
  const a = { ...project.adjust, effect: p.effect, letterbox: p.letterbox };
  // 完成イメージを選んだら「動き」もその作品らしい値で入る（理念: 選べば完成形）。
  // 既存作品を開いたときには通らない経路なので、勝手に揺れ始めることはない
  const m = MOTION_RECOMMEND[p.key];
  if (m) for (const k of MOTION_KEYS) a[k] = m[k];
  if (p.effect === 2) {
    const prof = FILM_PROFILES[p.filmProfile || 'home8'];
    a.grain = prof.grain / 400; a.grainSize = prof.grainSize / 100;
    a.glow = prof.glow / 100; a.halation = prof.halation; a.damage = prof.damage;
  } else {
    a.grain = FX[p.effect].gAmt / 400; a.grainSize = FX[p.effect].gSize / 100;
    a.glow = FX[p.effect].gGlow / 100; a.halation = FX[p.effect].gHal / 100; a.damage = 0;
  }
  return a;
}
// 再生ヘッドが止まってから150msでまとめて更新する（スクラブ中に毎フレーム描かない）
function scheduleThumbs() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => { void renderPresetThumbs(); }, 150);
}
async function renderPresetThumbs() {
  // 再生中・書き出し中・素材なしでは描かない（プレビューの邪魔をしない）
  if (thumbBusy || playing || exporting || !project.clips.length) return;
  const timing = getTimelineRenderTiming(timelinePos);
  if (!timing || !clipReady(timing.clip)) return;
  thumbBusy = true;
  const t0 = performance.now();
  try {
    if (!thumbPipe) {
      const cv = document.createElement('canvas');
      cv.width = THUMB_PX; cv.height = THUMB_PX;
      thumbPipe = new GLPipe(cv);
    }
    const source = clipSource(timing.clip);
    for (const card of document.querySelectorAll('#lookPresets .card')) {
      const p = PRESETS[card.dataset.preset];
      const lut = lutDataFor(p.lut);
      if (!lut) continue;
      thumbPipe.setLut(lut);
      await thumbPipe.draw(source, timing.clip.w, timing.clip.h, 0, timing.effectTime, timing.clip,
        // 64pxの正方形なので、帯を出さず絵で埋める（見比べる面積を優先）
        { adjust: { ...presetAdjust(p), letterbox: false }, lut: p.lut, fit: 'cover',
          filmProfile: p.filmProfile || 'home8' });
      let out = card.querySelector('canvas.th');
      if (!out) {
        out = document.createElement('canvas');
        out.className = 'th'; out.width = THUMB_PX; out.height = THUMB_PX;
        card.querySelector('.th').replaceWith(out);
      }
      // toDataURL は同期の読み戻しで重い。canvas 同士の drawImage で転写する
      out.getContext('2d').drawImage(thumbPipe.cv, 0, 0, THUMB_PX, THUMB_PX);
    }
    trace('thumbs', () => ({ ms: Math.round(performance.now() - t0), T: +timelinePos.toFixed(2) }));
  } catch (e) { /* サムネイルの失敗で編集を止めない */ }
  finally { thumbBusy = false; }
}

const warnedLutFallbacks = new Set();
async function loadBuiltinLut(url, key, lutName) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    project[key] = parseCube(text);
    project[`${key}Text`] = text;
    document.querySelector(`#lutChips .chip[data-lut=${lutName}]`).style.display = '';
  } catch (e) {
    logErr(`${lutName} LUTの読み込みに失敗: ${e?.message || e}`);
  }
}

// ===== 保存と復元（IndexedDB。素材と編集状態を端末内に保持） =====
const DB_VERSION = 2;
const WORKSPACE_KEY = 'workspace';
let dbP = null, ready = false, saveTimer = 0;
let saveGeneration = 0, savedGeneration = 0, saveStatus = 'saved';
let failNextSaveForTest = false;
let failNextTransactionForTest = false;
const pendingFileWrites = new Map();
const historyByProject = new Map();
const saveChains = new Map();
let operationBusy = false, backupUrl = null, storageEstimateMode = 'normal';
let creatingNewProject = false, migrationBlocked = false, incompleteProject = false;
const newId = () => crypto.randomUUID?.() || `hikari-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
function db() {
  dbP ||= new Promise((res, rej) => {
    const r = indexedDB.open('hikari', DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      if (!d.objectStoreNames.contains('state')) d.createObjectStore('state');
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects');
      if (!d.objectStoreNames.contains('projectMeta')) d.createObjectStore('projectMeta');
    };
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
function updateSaveUI() {
  const labels = {
    dirty: '未保存', saving: '保存中…', saved: '保存済み',
    error: '保存できません。空き容量を確認して再試行',
  };
  const el = $('saveStatus');
  el.textContent = labels[saveStatus] || labels.saved;
  el.classList.toggle('error', saveStatus === 'error');
  $('retrySaveBtn').classList.toggle('on', saveStatus === 'error');
  // 保存に失敗したら、クリップ選択中でも再試行へたどり着けるようにする
  if (saveStatus === 'error') $('projectRow').hidden = false;
  updateExportSummary();
}
function setSaveStatus(next) { saveStatus = next; updateSaveUI(); }
function markDirty() {
  if (!ready) return;
  saveGeneration++;
  setSaveStatus('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveState(); }, 400);
}
async function beginExplicitProjectSave() {
  clearTimeout(saveTimer); saveTimer = 0;
  await (saveChains.get(project.id) || Promise.resolve());
  clearTimeout(saveTimer); saveTimer = 0;
  saveGeneration++; setSaveStatus('dirty');
}
// 既存のイベントから呼ばれている名前を残す。保存世代を進めるのはこの入口だけにする。
const scheduleSave = markDirty;
function serializeProject() {
  if (project.music?.audioBuffer && project.music.assetId && !pendingFileWrites.has(project.music.assetId)) pendingFileWrites.set(project.music.assetId, audioBufferToWav(project.music.audioBuffer));
  const st = {
    formatVersion: PROJECT_FORMAT,
    id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, assetBytes: recalculateAssetBytes(),
    aspect: project.aspect, fit: project.fit, lut: project.lut,
    adjust: { ...project.adjust, hsl: project.adjust.hsl, curve: project.adjust.curve },
    muteAll: project.muteAll, autoAlign: project.autoAlign, impLen: project.impLen, preset: project.preset,
    textureSeed: project.textureSeed >>> 0, filmProfile: project.filmProfile,
    lutFileText: project.lutFileText || null, lutFileName: project.lutFileName || null,
    clips: project.clips.map(c => ({
      id: c.id, assetId: c.assetId, kind: c.kind, name: c.name, start: c.start, end: c.end, dur: c.dur,
      bright: c.bright, temp: c.temp, fxScale: c.fxScale, highKey: c.highKey, hsl: c.hsl, curve: c.curve,
      fit: c.fit,                   // このクリップだけの収め方（無ければ作品ぜんぶの設定に従う）
      autoBright: c.autoBright, autoTemp: c.autoTemp,
      muted: c.muted, thumb: c.thumb,
    })),
    texts: (project.texts || []).map(t => JSON.parse(JSON.stringify(t))),
    transOverrides: (project.transOverrides || []).map(x => ({ ...x })),
    music: project.music ? { name: project.music.name, assetId: project.music.assetId, volume: project.music.volume, loop: project.music.loop !== false, offset: project.music.offset || 0, stored: !!project.music.assetId } : null,
    clipSeq,
  };
  return st;
}
function recalculateAssetBytes() {
  const seen = new Set(); let total = 0;
  for (const c of project.clips) {
    if (!c.assetId || seen.has(c.assetId)) continue;
    seen.add(c.assetId); total += (pendingFileWrites.get(c.assetId) || c.file)?.size || 0;
  }
  if (project.music?.assetId && !seen.has(project.music.assetId)) {
    const b = pendingFileWrites.get(project.music.assetId);
    total += b?.size ?? project.music.arrayBuffer?.byteLength ?? 0;
  }
  project.assetBytes = total;
  return total;
}
function audioBufferToWav(buffer) {
  const channels = Math.min(2, buffer.numberOfChannels), frames = buffer.length, out = new ArrayBuffer(44 + frames * channels * 2), v = new DataView(out), u8 = new Uint8Array(out);
  u8.set(new TextEncoder().encode('RIFF'), 0); v.setUint32(4, out.byteLength - 8, true); u8.set(new TextEncoder().encode('WAVEfmt '), 8); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, buffer.sampleRate, true); v.setUint32(28, buffer.sampleRate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true); u8.set(new TextEncoder().encode('data'), 36); v.setUint32(40, frames * channels * 2, true);
  for (let i = 0, o = 44; i < frames; i++) for (let ch = 0; ch < channels; ch++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i])) * 0x7fff, true);
  return new Blob([out], { type: 'audio/wav' });
}
function projectAssetIds(st = serializeProject()) {
  return new Set([...(st.clips || []).map(c => c.assetId).filter(Boolean), st.music?.assetId].filter(Boolean));
}
function makeProjectMeta(st = serializeProject()) {
  const now = new Date().toISOString();
  return { id: st.id, name: st.name || '無題の作品', preset: st.preset || null, aspect: st.aspect,
    duration: (st.clips || []).reduce((n, c) => n + Math.max(0, (c.end || 0) - (c.start || 0)), 0),
    assetBytes: st.assetBytes || [...projectAssetIds(st)].reduce((n, id) => n + (pendingFileWrites.get(id)?.size || 0), 0),
    createdAt: st.createdAt || now, updatedAt: now };
}
function saveState() {
  if (!ready || !project.id || migrationBlocked || incompleteProject) return Promise.resolve(false);
  const requestedGeneration = saveGeneration;
  const st = serializeProject();
  const targetProjectId = st.id;
  const fileWrites = [...pendingFileWrites.entries()];
  setSaveStatus('saving');
  if (failNextSaveForTest) {
    failNextSaveForTest = false;
    logErr('保存に失敗: 開発用の保存障害テスト');
    setSaveStatus('error');
    return Promise.resolve(false);
  }
  const previous = saveChains.get(targetProjectId) || Promise.resolve();
  const work = previous.then(() => db().then(d => new Promise((res, rej) => {
    const t = d.transaction(['files', 'projects', 'projectMeta'], 'readwrite');
    const files = t.objectStore('files');
    for (const [key, blob] of fileWrites) files.put(blob, key);
    st.updatedAt = new Date().toISOString();
    t.objectStore('projects').put(st, targetProjectId);
    t.objectStore('projectMeta').put(makeProjectMeta(st), targetProjectId);
    if (failNextTransactionForTest) { failNextTransactionForTest = false; t.abort(); }
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error || new Error('端末への保存に失敗しました'));
    t.onabort = () => rej(t.error || new Error('端末への保存が中断されました'));
  })));
  saveChains.set(targetProjectId, work.catch(() => {}));
  return work.then(() => {
    for (const [key, blob] of fileWrites) if (pendingFileWrites.get(key) === blob) pendingFileWrites.delete(key);
    savedGeneration = Math.max(savedGeneration, requestedGeneration);
    // 保存元が既に非アクティブなら、現在の作品の表示・再予約には触れない。
    if (project.id !== targetProjectId) return true;
    if (requestedGeneration === saveGeneration) setSaveStatus('saved');
    else { setSaveStatus('dirty'); clearTimeout(saveTimer); saveTimer = setTimeout(() => saveState(), 0); }
    return true;
  }).catch(e => {
    logErr('保存に失敗: ' + (e?.message || e));
    if (project.id === targetProjectId) setSaveStatus('error');
    return false;
  });
}

// ===== クリップ =====
function clipSource(c) { return c.kind === 'photo' ? c.img : c.video; }
function clipLen(c) { return c.end - c.start; }
function clipReady(c) { return c.kind === 'photo' ? c.img.complete : c.video.readyState >= 2; }

// meta は「復元・複製のための既存データ」専用。新規取り込みの種別は kindHint で渡す
// （meta に種別ヒントを兼ねさせると復元扱いになり、取り込み長さや自動そろえが効かなくなる）
async function createClip(fileBlob, meta, analyze, kindHint) {
  const url = URL.createObjectURL(fileBlob);
  try {
  const kind = meta?.kind || kindHint || (fileBlob.type.startsWith('image/') ? 'photo' : 'video');
  const name = meta?.name || fileBlob.name || (kind === 'photo' ? '写真' : 'クリップ');
  const clip = {
    id: meta?.id || 'c' + (++clipSeq), assetId: meta?.assetId || newId(), kind, file: fileBlob, url, name,
    thumb: meta?.thumb || '',
    bright: meta?.bright || 0, temp: meta?.temp || 0, fxScale: meta?.fxScale ?? 1, highKey: meta?.highKey || 0,
    hsl: meta?.hsl ? JSON.parse(JSON.stringify(meta.hsl)) : defaultHsl(),
    curve: Array.isArray(meta?.curve) ? meta.curve.map(pt => [pt[0], pt[1]]) : defaultCurve(),
    autoBright: meta?.autoBright || 0, autoTemp: meta?.autoTemp || 0,
    muted: meta?.muted || false,
  };
  // このクリップだけの収め方。持っていないのが普通（＝作品ぜんぶの設定に従う）なので、
  // 既定値では入れず、指定があるときだけ生やす
  if (meta?.fit === 'cover' || meta?.fit === 'contain') clip.fit = meta.fit;

  if (kind === 'photo') {
    const img = clip.img = new Image();
    img.src = url;
    await new Promise((res, rej) => {
      const to = setTimeout(() => { URL.revokeObjectURL(url); rej(new Error('読み込みタイムアウト: ' + name)); }, 15000);
      img.onload = () => { clearTimeout(to); res(); };
      img.onerror = () => { clearTimeout(to); URL.revokeObjectURL(url); rej(new Error('この写真は読み込めませんでした: ' + name)); };
    });
    clip.dur = PHOTO_MAX;
    clip.w = img.naturalWidth; clip.h = img.naturalHeight;
    clip.start = 0;
    clip.end = meta ? clamp(meta.end ?? 3, 0.3, PHOTO_MAX) : (project.impLen > 0 ? project.impLen : 3);
  } else {
    const video = clip.video = document.createElement('video');
    video.src = url; video.playsInline = true; video.preload = 'auto'; video.muted = true;
    await new Promise((res, rej) => {
      const to = setTimeout(() => { URL.revokeObjectURL(url); rej(new Error('読み込みタイムアウト: ' + name)); }, 15000);
      video.onloadedmetadata = () => { clearTimeout(to); res(); };
      video.onerror = () => { clearTimeout(to); URL.revokeObjectURL(url); rej(new Error('この動画は読み込めませんでした: ' + name)); };
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
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
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
  if (!files.length) return;
  const requestedBytes = files.reduce((n, f) => n + (f.size || 0), 0);
  if (!(await confirmStorageForAdditional(requestedBytes))) return;
  const historyBefore = beginHistory();
  let predicted = 0;
  const accepted = [];
  for (const file of files) {
    if (kind === 'photo' || project.impLen > 0) {
      predicted += kind === 'photo' ? project.impLen || 3 : project.impLen;
      accepted.push(file);
      continue;
    }
    try {
      const duration = await new Promise((res, rej) => {
        const v = document.createElement('video');
        const url = URL.createObjectURL(file);
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          v.onloadedmetadata = null;
          v.onerror = null;
          URL.revokeObjectURL(url);
          if (error) rej(error); else res(value);
        };
        const timeoutId = setTimeout(() => finish(new Error('動画情報の取得がタイムアウトしました')), 15000);
        v.preload = 'metadata';
        v.onloadedmetadata = () => Number.isFinite(v.duration)
          ? finish(null, v.duration)
          : finish(new Error('動画の長さを取得できません'));
        v.onerror = () => finish(new Error('動画情報を取得できません'));
        v.src = url;
      });
      predicted += duration;
      accepted.push(file);
    } catch (e) { logErr(`${file.name}: ${e.message}`); }
  }
  if (!accepted.length) return;
  const after = timelineDur() + predicted;
  if (after > MAX_PROJECT_SECONDS + 1e-6 && !confirm(`全部追加すると約${after.toFixed(1)}秒です。追加後に短くしてください。続けますか？`)) return;
  const before = project.clips.length;
  for (const file of accepted) {
    try {
      const clip = await createClip(file, null, true, kind);
      project.clips.push(clip);
      pendingFileWrites.set(clip.assetId, file);
      selId = clip.id;
    } catch (e) { logErr(e.message); }
  }
  if (before === 0 && project.clips.length) フレームを素材に合わせる(project.clips[0]);
  renderTimeline(); renderClipEdit();
  $('emptyHint').style.display = project.clips.length ? 'none' : 'flex';
  if (project.clips.length > before) {
    recalculateAssetBytes();
    markDirty();
    seekTimeline(sumBefore(project.clips.length - 1));
    // ファイル選択で複数素材を入れても、履歴は1手だけ。
    commitHistory(historyBefore);
  }
}

// ===== タイムライン =====
let pxPerSec = 46;
let timelinePos = 0;        // 現在の再生位置（秒）
let seekPending = null, seekBusy = false, seekSeq = 0;

// 【2026-08-16】総尺は「クリップの合計＋おわり」。おわりは最後のクリップの後ろに足す余韻で、
// ここで最後の境目のエフェクトが起き、白または黒に留まって終わる。
// クリップだけの長さが要る場所（境目の位置・クリップの割り当て）は clipsDur() を使う。
function clipsDur() { return project.clips.reduce((s, c) => s + clipLen(c), 0); }
function endingDur(adjust) { const a = adjust || project.adjust; return project.clips.length ? clamp(a.endDur ?? 0, 0, 5) : 0; }
// おわりの沈み具合（0〜1）。クリップが終わった瞬間から始まり、総尺で1になる
// おわりの沈み具合（0〜1）。
// 【2026-08-17 修正】クリップが終わった瞬間から沈み始めていたため、境目のエフェクト（焼けなど）が
// 白に飲まれて見えなかった（ユーザー報告）。**前半はエフェクトを見せ、後半で沈む**形にする。
// これで「フィルムの終わりを予期させてから、ホワイト／ブラックアウト」の流れになる。
const END_HOLD = 0.38;   // おわりのうち、沈み始めるまでの割合
function endingAmt(T, adjust) {
  const ed = endingDur(adjust); if (ed <= 0) return 0;
  const cd = clipsDur();
  if (T <= cd) return 0;
  const u = Math.min(1, (T - cd) / ed);
  if (u <= END_HOLD) return 0;
  return smooth01((u - END_HOLD) / (1 - END_HOLD));
}
function timelineDur() { return clipsDur() + endingDur(); }
function getDurationState() {
  const duration = timelineDur();
  const overBy = Math.max(0, duration - MAX_PROJECT_SECONDS);
  return { duration, max: MAX_PROJECT_SECONDS, overBy, isValid: duration <= MAX_PROJECT_SECONDS + 1e-6 };
}
function durationErrorText() {
  const d = getDurationState();
  return `合計${d.duration.toFixed(1)}秒です。${d.overBy.toFixed(1)}秒短くしてください。`;
}
function currentLookLabel() {
  if (project.adjust.effect === 2) {
    const profile = currentFilmProfile().label;
    return project.lut === 'file' ? `${profile}（LUT: ${project.lutFileName || '自分のLUT'}）` : profile;
  }
  const match = Object.entries(PRESETS).find(([, p]) => p.lut === project.lut && p.effect === project.adjust.effect);
  if (match) return PRESET_LABELS[match[0]];
  const lutLabels = { mine: '自分の色', airu: '青い記憶', film8: '8mm', hikari: 'ひかり', none: 'なし', file: project.lutFileName || '自分のLUT' };
  const fxLabels = { 0: '質感なし', 1: '青い記憶', 2: '8mm' };
  return `カスタム（${lutLabels[project.lut] || project.lut}／${fxLabels[project.adjust.effect] || '質感なし'}）`;
}
function getExportSummary() {
  const d = getDurationState();
  const aspect = project.aspect;
  const sound = project.music ? (project.muteAll ? '音楽のみ' : '音楽＋原音') : (project.muteAll ? '無音' : '原音');
  return { duration: d, aspect, look: currentLookLabel(), sound, saveStatus };
}
function updateDurationUI() {
  const d = getDurationState();
  const el = $('durationBudget');
  el.textContent = d.isValid ? `${d.duration.toFixed(1)} / ${MAX_PROJECT_SECONDS}秒` : `超過 ${d.duration.toFixed(1)} / ${MAX_PROJECT_SECONDS}秒`;
  el.classList.toggle('over', !d.isValid);
  $('runExport').disabled = !d.isValid || exporting;
  updateExportSummary();
}
function updateExportSummary() {
  const el = $('exportSummary');
  if (!el) return;
  const s = getExportSummary();
  el.textContent = `1080p・SDR向け\n長さ: ${s.duration.duration.toFixed(1)} / ${MAX_PROJECT_SECONDS}秒\n画面: ${s.aspect}\n見た目: ${s.look}\n音: ${s.sound}\n保存: ${saveStatus === 'saved' ? '保存済み' : saveStatus === 'saving' ? '保存中…' : saveStatus === 'error' ? '保存失敗' : '未保存'}`;
  const warnings = [];
  if (!s.duration.isValid) warnings.push(durationErrorText());
  warnings.push('SDRで撮影した素材を推奨');
  if (saveStatus !== 'saved') warnings.push('この作品は端末へ保存できていません。書き出しはできますが、再読み込みすると編集内容を失うおそれがあります。');
  $('exportWarnings').textContent = warnings.join('\n');
}
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
  renderTransMarks(layer, half);
  // おわりのぶんも幅を持たせる。持たせないとタイムラインで最後まで送れない
  t += endingDur();
  const w = half * 2 + t * pxPerSec;
  $('timelineTrack').style.width = w + 'px';
  layer.style.width = w + 'px';
  renderRuler(t, half, w);
  renderMusicTrack(t, half, w);
  updateTimeLabel();
  updateDurationUI();
}

// カットの境目に「そこで何が起きるか」の印を出す。
// 再生する前に分かることが大事（アイルのように自動で当たるが、任せきりにはしない）
// 印は語彙ごとに変える。再生する前に「そこで何が起きるか」が見えることが大事
// 4(8mmの焼け)と6(暖色フレア)は青い記憶で両方出るので、記号を分ける
const TRANS_MARK = { 1: '✦', 2: '✧', 3: '↗', 4: '▲', 5: '●', 6: '❖', 7: '◍', 8: '◐' };
// 6は元「ネガ焼け」。実装が感光型の暖色ディゾルブになったので2026-08-16に改名。
// 保存データの kind 文字列は 'burn' のまま（.hikari の後方互換のため変えない）。
const TRANS_NAME = { 0: 'そのまま', 1: '光', 2: '白抜け', 3: '露出', 4: '焼け', 5: '黒', 6: '暖色フレア', 7: '暖色', 8: '暗転' };
function renderTransMarks(layer, half) {
  const amt = project.adjust.trans || 0;
  // 【2026-08-16】境目はクリップ間だけでなく**作品の最後**にもある（i = clips.length）。
  // 最後のカットが素で終わると余韻が切れるため（ユーザー要望）。
  if (amt <= 0 || project.clips.length < 1) return;
  const seed = normalizeTextureSeed(project.textureSeed, project);
  const film = project.adjust.effect === 2;
  for (let i = 1; i <= project.clips.length; i++) {
    const kind = transKindAt(i, amt, seed, film);
    const b = document.createElement('button');
    b.className = 'transMark' + (kind ? ' on' : '');
    b.dataset.bi = i;
    b.textContent = TRANS_MARK[kind] || '·';
    b.style.left = (half + sumBefore(i) * pxPerSec) + 'px';
    b.title = TRANS_NAME[kind] || 'そのまま';
    layer.appendChild(b);
  }
}
// 印をタップすると、その境目だけ手で決められる（既定は自動＝毎回違う）
let transPickerOpenedAt = 0;   // 開いた直後の誤タップを弾くための時刻
function openTransPicker(i) {
  const left = project.clips[i - 1];
  if (!left) return;
  transPickerOpenedAt = performance.now();
  const ov = (project.transOverrides || []).find(x => x.leftClipId === left.id);
  const cur = ov?.kind || 'auto';
  const sheet = $('transPicker');
  const film = project.adjust.effect === 2;
  // 語彙は世界観（完成イメージ）で決まるので、選択肢もそれに合わせる
  const isLast = i >= project.clips.length;   // 作品の最後の境目
  sheet.querySelectorAll('[data-kind]').forEach(b => {
    const only = b.dataset.only;
    b.hidden = only === 'film' ? !film : only === 'mv' ? film : only === 'last' ? !isLast : false;
    b.classList.toggle('on', b.dataset.kind === cur);
    if (b.dataset.kind === 'flash') b.textContent = film ? '✧ 白抜け' : '✦ 光';
    if (b.dataset.kind === 'burn') b.textContent = film ? '▲ 焼け' : '❖ 暖色フレア';
  });
  const amp = $('transAmp');
  amp.value = String(Math.round((ov?.amp ?? 1) * 100));
  amp.parentElement.querySelector('output').textContent = amp.value;
  sheet.dataset.bi = i;
  sheet.classList.add('on');
}
// 境界ごとの強さ（0.3〜1.6）。実物でも光の強さはイベントごとに違うので嘘にならない
$('transAmp').oninput = () => {
  const i = parseInt($('transPicker').dataset.bi, 10);
  const left = project.clips[i - 1]; if (!left) return;
  const v = parseFloat($('transAmp').value) / 100;
  $('transAmp').parentElement.querySelector('output').textContent = $('transAmp').value;
  const list = (project.transOverrides || []).filter(x => x.leftClipId !== left.id);
  const prev = (project.transOverrides || []).find(x => x.leftClipId === left.id);
  list.push({ leftClipId: left.id, kind: prev?.kind || 'auto', amp: v });
  project.transOverrides = list;
  redraw(); markDirty();
};
// おわりの色。白＝いまの終わり方（光って白に包まれる）と地続き。黒＝作品として締める
function setEndDark(dark) {
  const before = beginHistory();
  project.adjust.endDark = dark ? 1 : 0;
  commitHistory(before); syncMotionUI(); renderTimeline(); markDirty(); redraw(); scheduleSave();
}
$('endWhite').onclick = () => setEndDark(false);
$('endBlack').onclick = () => setEndDark(true);
function syncEndUI() {
  // スライダーの値は共通の syncMotionUI が入れる。ここは色の選択だけ見る
  const dark = !!project.adjust.endDark;
  $('endWhite').classList.toggle('on', !dark);
  $('endBlack').classList.toggle('on', dark);
}
// この境目だけ引き直す。kind と強さは残し、顔（方向・長さ・単発か2回か・勾配・回復色）だけ変える
$('transRoll').onclick = () => {
  const i = parseInt($('transPicker').dataset.bi, 10);
  const left = project.clips[i - 1]; if (!left) return;
  const before = beginHistory();
  const prev = (project.transOverrides || []).find(x => x.leftClipId === left.id);
  const list = (project.transOverrides || []).filter(x => x.leftClipId !== left.id);
  list.push({ leftClipId: left.id, kind: prev?.kind || 'auto', amp: prev?.amp ?? 1,
    roll: ((prev?.roll || 0) + 1) % 100000 });
  project.transOverrides = list;
  transPlanCache = null;
  commitHistory(before);
  renderTimeline(); markDirty(); redraw(); scheduleSave();
  logErr('この境目の出方を引き直しました（↶で戻せます）');
};
$('transPicker').addEventListener('click', e => {
  // 開いた直後のクリックは受け付けない。指を離してから開くようにしたので通常は起きないが、
  // 合成clickの遅延やスタイラスなど、経路によっては同じ操作の続きが届きうる（実機ログで発生）。
  if (performance.now() - (transPickerOpenedAt || 0) < 320) { e.stopPropagation(); return; }
  if (e.target.id === 'transPicker') { $('transPicker').classList.remove('on'); return; }
  const b = e.target.closest('[data-kind]'); if (!b) return;
  const i = parseInt($('transPicker').dataset.bi, 10);
  const left = project.clips[i - 1]; if (!left) return;
  const before = beginHistory();
  const prev = (project.transOverrides || []).find(x => x.leftClipId === left.id);
  const list = (project.transOverrides || []).filter(x => x.leftClipId !== left.id);
  const amp = prev?.amp ?? 1;
  // 強さだけ変えている場合もあるので、kind=autoでも記録を残す
  if (b.dataset.kind !== 'auto' || amp !== 1) list.push({ leftClipId: left.id, kind: b.dataset.kind, amp });
  project.transOverrides = list;
  $('transPicker').classList.remove('on');
  commitHistory(before);
  renderTimeline(); markDirty(); redraw();
});

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
  el.textContent = '';
  const bar = document.createElement('div');
  bar.className = 'musicBar';
  if (project.music) {
    const dur = musicAudioBuf ? musicAudioBuf.duration : total;
    const shown = Math.max(60, Math.min(dur, total) * pxPerSec);
    bar.textContent = `♪ ${project.music.name}${project.muteAll ? '（元の音はオフ）' : ''}`;
    bar.style.left = `${half}px`; bar.style.width = `${shown}px`;
  } else {
    bar.classList.add('empty'); bar.textContent = `♪ 音楽を追加（いまは${project.muteAll ? '無音' : '元の音のまま'}）`;
    bar.style.left = `${half}px`; bar.style.width = `${width}px`;
  }
  el.appendChild(bar);
  // スクラブのために横へ動かしたときは、音楽タブを開かない
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
  t += endingDur();
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

// 描画時刻の唯一の入口。作品時間Tでclipを選び、sourceだけをclip-localの
// 16/18fpsにquantizeする。質感のfilmFrame/effectTimeはclip境界で絶対に戻さない。
function getTimelineRenderTiming(T) {
  const total = timelineDur();
  const timelineTime = clamp(Number.isFinite(T) ? T : 0, 0, total);
  const at = clipAt(timelineTime);
  if (!at) return null;
  const clip = project.clips[at.i];
  const isFilm = project.adjust.effect === 2;
  const profile = currentFilmProfile();
  const seed = normalizeTextureSeed(project.textureSeed, project);
  // コマ落ち（v5-9）: 8mmのcadence機構を「青い記憶」「自分の色」でも使えるようにしたもの。
  // アイルMV実測は複製フレーム21.7%＝実効約19fps。judder=1でそこへ寄せる。
  // judder=0 のときは cadence=0 で従来と完全に同じ経路（回帰18本が不変であること）。
  // 音は間引かない（映像だけ）。時間契約そのものは変えず、コマの格子を足すだけ。
  const judder = clamp(project.adjust.judder || 0, 0, 1);
  const cadence = isFilm ? profile.fps : (judder > 0 ? 30 - 11 * judder : 0);
  // frame境界の位相だけ作品seedから定める。0 <= phase < 1 frame。
  const filmSeedPhase = cadence > 0 ? textureSeedUnit(seed, 0, 0x3df0ac19) / cadence : 0;
  const clipStartTimeline = sumBefore(at.i);
  const filmFrame = cadence > 0 ? Math.floor((timelineTime + filmSeedPhase) * cadence) : null;
  const filmFrameStartT = cadence > 0 ? filmFrame / cadence - filmSeedPhase : timelineTime;
  // raw Tでclipを選ぶ。同じfilmFrame内はframe開始時刻からsourceを決めるが、
  // clip境界で新clipが選ばれた瞬間だけlocal 0へ戻す。
  const sourceSampleLocal = cadence > 0 ? Math.max(0, filmFrameStartT - clipStartTimeline) : at.local;
  const sourceLocal = Math.min(sourceSampleLocal, Math.max(0, clipLen(clip) - 1e-6));
  return {
    timelineTime, clip, clipIndex: at.i, clipStartTimeline, clipLocalTime: at.local,
    sourceSampleLocal: sourceLocal, localSourceTime: clip.start + sourceLocal,
    filmFrame, filmFrameStartT, effectTime: cadence > 0 ? filmFrame / cadence : timelineTime,
    cadence, seed, profile,
  };
}

// ===== つなぎ（白ディゾルブ / ロールエンドバーン）=====
// アイルMV実測（2026-08-15）:
//  ・白ディゾルブはカット境界に40箇所。包絡は立ち上がり0.31秒・立ち下がり0.33秒の「ほぼ対称」
//  ・ピーク輝度は162〜191/255（純白235には達しない）。ピーク時の画面平均色は(184,183,181)＝ほぼ中立
//  ・ロールエンドバーンは162秒で1回だけ。黒→オレンジの横帯→赤/マゼンタの縁焼け→白へ抜ける
// どの境界がどうなるかは境界番号のseedで決まる。作品時刻Tの純関数なので、
// プレビューと書き出しで必ず同じ位置・同じ形になる。
// 白ディゾルブの片側の長さ。実測の立ち上がり0.31秒(20→80%)に実描画で合わせ込んだ値。
// 出力は白へ寄せるほど圧縮がかかるので、線形の包絡でも幅0.5秒では0.26秒にしかならなかった
const TRANS_HALF = 0.61;
const BURN_LEN = 0.70;       // 旧: ロールエンドの長さ。v7-7でコマ単位へ移行し未使用（参照は黒1+橙1+暗3+白抜け2+持続14〜19コマ）
// adjustは呼び出し側から受け取る。project.adjustを直接読むと、
// サムネイルや検証の「設定を差し替えた描画」で本体の値が使われて食い違う（実際に食い違った）
// 境界がどうなるか（自動＝seed任せ / 手で指定）。
// 上書きは「左のクリップid」に紐づける。境界の番号で持つと、並べ替えや挿入でずれる
// ===== つなぎの語彙（v7）=====
// kind: 0=素のカット / 1=露出爆発ディゾルブ / 2=白抜けポップ / 3=露出ランプイン
//       4=橙焼け / 5=黒コマ / 6=ネガバーン / 7=暖色ウォッシュ
// 語彙は adjust.effect で自動的に切り替わる（UIは増やさない＝選ぶのは世界観であってカタログではない）
// FADEOUT は作品の最後の境目だけで使う「暗転して終わる」
const TK = { NONE: 0, FLASH: 1, POP: 2, RAMP: 3, SCORCH: 4, BLACK: 5, BURN: 6, WASH: 7, FADEOUT: 8 };
// 手動上書きの文字列 → kind（effect文脈で解釈する）
function overrideKind(word, film) {
  if (word === 'none') return TK.NONE;
  if (word === 'flash') return film ? TK.POP : TK.FLASH;
  // 'burn' は世界観ごとに別の語彙を指す歴史的な値。既存の .hikari を読めるよう変えない
  if (word === 'burn') return film ? TK.SCORCH : TK.BURN;
  // 'scorch' は2026-08-16追加。青い記憶でも8mmの焼けを選べるようにするための値で、
  // どちらの世界観でも同じ語彙（暖色ブリーチ）を指す
  if (word === 'scorch') return TK.SCORCH;
  if (word === 'fadeout') return TK.FADEOUT;
  if (word === 'black') return TK.BLACK;
  return null;
}
// 種類の層化配分。独立ハッシュだと同種が隣り合う作品が165/200になり「作り物感」が出る（実測）。
// 比率どおりの枚数を配ってから並べ替え、同種が隣接したら後ろと入れ替える → 24/200まで下がる。
let transPlanCache = null;
function transPlan(amt, seed, film, n) {
  const key = `${amt.toFixed(3)}|${seed}|${film}|${n}`;
  if (transPlanCache && transPlanCache.key === key) return transPlanCache.plan;
  const slots = [];
  // 【2026-08-16 修正】本数を Math.round で決めていたため、期待値が0.5未満の語彙が
  // **1本も入らなかった**。8mmは POP/RAMP/BLACK が各5%で、9境界・つなぎ60なら
  // 9×0.05×0.6=0.27 → 0本。実測で「8mmではつなぎを上げても何も起きない」状態だった。
  // 端数はseedで確率的に切り上げる（期待値は実測比率どおりのまま、少ない境界数でも出る）。
  let cntSalt = 0;
  const count = (x) => {
    const f = Math.floor(x);
    return f + (textureSeedUnit(seed, 700 + (cntSalt++), 0x1f3a5c7e) < (x - f) ? 1 : 0);
  };
  const push = (k, cnt) => { for (let j = 0; j < cnt; j++) slots.push(k); };
  if (film) {
    push(TK.POP, count(n * 0.05 * amt));
    push(TK.RAMP, count(n * 0.05 * amt));
    push(TK.SCORCH, count(n * 0.06 * amt));
    push(TK.BLACK, count(n * 0.05 * amt));
  } else {
    push(TK.FLASH, count(n * 0.30 * amt));
    push(TK.WASH, count(n * 0.10 * amt));
    // 【2026-08-16 ユーザー決定】8mmの焼け（暖色ブリーチ）を青い記憶側にも自動で混ぜる。
    // 比率は暖色ウォッシュと同じ0.10。9境界・スライダー60なら平均1回出る
    push(TK.SCORCH, count(n * 0.10 * amt));
    // ネガバーンは作品に1回まで（アイル実測162秒に1回）
    if (textureSeedUnit(seed, 0, 0x5ee0b17a) < 0.20 * amt) push(TK.BURN, 1);
  }
  while (slots.length < n) slots.push(TK.NONE);
  slots.length = n;
  // seed由来のFisher-Yatesで並べる（作品ごとに違う並び）
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(textureSeedUnit(seed, i, 0x777a13b5) * (i + 1));
    const t = slots[i]; slots[i] = slots[j]; slots[j] = t;
  }
  // 同種が隣接したら、条件を満たす後ろの席と入れ替える（素のカット同士の連続は問題ない）
  for (let i = 1; i < n; i++) {
    if (slots[i] !== slots[i - 1] || slots[i] === TK.NONE) continue;
    for (let j = i + 1; j < n; j++) {
      if (slots[j] !== slots[i] && (j + 1 >= n || slots[j + 1] !== slots[i])) {
        const t = slots[i]; slots[i] = slots[j]; slots[j] = t; break;
      }
    }
  }
  transPlanCache = { key, plan: slots };
  return slots;
}
function transKindAt(i, amt, seed, film) {
  const left = project.clips[i - 1];
  const ov = (project.transOverrides || []).find(x => x.leftClipId === left?.id);
  if (ov && ov.kind && ov.kind !== 'auto') {
    const k = overrideKind(ov.kind, film);
    if (k !== null) return k;
  }
  // 枠は「クリップ間 n-1 個 ＋ 作品の最後 1 個」＝ clips.length 個
  return transPlan(amt, seed, film, project.clips.length)[i - 1] ?? TK.NONE;
}
// 境界ごとの「顔」。同じ種類でも方向・勾配・多重・長さ・回復色がすべて違う。
// 方向は黄金角で回す：独立ハッシュだと隣接境界が似た向きになる作品が50/50だったが、
// 黄金角なら最小138度離れる（実測）。作品ごとの初期角はseed由来なので「作品が変われば違う」も保つ
// 【2026-08-16 全面改訂】以前の実測はレターボックス（上下23.5%の黒帯）を映像に含めて計算しており、
// 包絡が急峻に・光が部分的に見えていた。有効領域だけで測り直した実測値:
//   ・立ち上がり20→80% = 0.96秒 / 立ち下がり0.92秒（旧実装は0.28秒＝3.4倍速く「切れ目」が見えていた）
//   ・裾は境界の1.0秒前から動き出す（唐突に始まらない＝切れ目が分からない理由）
//   ・ピークは映像部分の平均240〜250・5%点200超・白飛び60〜98%＝**全体が真っ白に包まれる**
//     （旧実装は勾配で一部だけ飛ばしていた＝「一部のみ光る」「視線が持っていかれる」の原因）
//   ・多重パルスの間隔は1.17〜2.96秒（中央値1.88秒。旧実装は0.20〜0.50秒＝規則的な明滅に見えた）
// roll は「この境目だけ引き直す」の回数。0なら従来どおり。
// 境界番号を roll ぶんずらすことで、方向・長さ・出方・勾配・回復色がまとめて変わる。
function transFace(i, seed, roll = 0) {
  const fi = i + (roll | 0) * 4096;          // 引き直すたびに別の境目として引き当てる
  const a0 = textureSeedUnit(seed, 0, 0x51a2b3c4) * 360;
  const ang = ((a0 + fi * 137.507) % 360) * Math.PI / 180;
  const multi = textureSeedUnit(seed, fi, 0x2f8a771d) < 0.30;   // 3割が多重パルス
  return {
    dir: [Math.cos(ang), Math.sin(ang)],
    // 【2026-08-16 再訂正】「重心0.50＝方向なし」は誤り。重心は明るさの絶対値で見ていたため、
    // 全体が明るくなると差が埋もれる。素からの**増分**で見ると頂上でも 中央値3.68倍の勾配がある。
    // grad は「頂上での最強／最弱の比」。実測 1.9〜18.7（中央値3.7）・設計書の目標2〜6と整合。
    grad: 2.0 + 5.0 * textureSeedUnit(seed, fi, 0x9c31ae05),
    multi,
    peaks: multi ? 2 + Math.floor(textureSeedUnit(seed, fi, 0x40b17c93) * 4) : 1,
    // 実測の包絡は「速い立ち上がり→保持→やや遅い減衰」。ガウスの対称形ではない。
    //   立ち上がり 1〜3コマ(0.04〜0.13秒) / 保持 3〜10コマ / 減衰 3〜8コマ ＝ 全体0.3〜0.9秒
    // 旧実装はガウスσ1.2秒＝立ち上がり0.92秒で、実測の7〜20倍遅かった。
    // 2秒以上光っていると「エフェクトが動いている」と見え、切れ目も強さも意識される
    // 【2026-08-16 参照14イベントの実測に合わせ直し】立ち上がりは中央値4コマ(0.17秒)。
    // 設計書の0.31秒は45箇所を平均して鈍った値、前版の0.05〜0.14秒は逆に速すぎた。
    atk: 0.08 + 0.16 * textureSeedUnit(seed, fi, 0x1b56c4e9),
    // 【2026-08-16 再訂正】前版は「平坦＝機械的」と判断して頂上を1〜3コマに固定したが、
    // 実測では **頂上そのものはほぼ完全に平坦**（頂上内のコマ間std 1.7）で、
    // 規則性の正体は平坦さではなく**頂上の長さが毎回同じこと**だった。
    // 実測の頂上長は 1,1,2,2,2,3,4,4,4,5,7,9,10,15コマ＝中央値4・最大15と大きくばらつく。
    // u^2.2 でこの分布（下に密・上に長い裾）を作る。u=0→1コマ / 0.5→4コマ / 1→15コマ。
    hold: 0.042 + 0.60 * Math.pow(textureSeedUnit(seed, fi, 0x2ab4f019), 2.2),
    dec: 0.20 + 0.26 * textureSeedUnit(seed, fi, 0x7de3c105),
    tail: 0.33 + 0.30 * textureSeedUnit(seed, fi, 0x11f0a7c3),   // 残光 8〜15コマ
    tint: (i + (textureSeedUnit(seed, 0, 0x77c1e0a3) > 0.5 ? 1 : 0)) % 2 === 0 ? 1 : -1,
    seed: textureSeedUnit(seed, fi, 0x6a09e667),
    vary: 0.85 + 0.15 * textureSeedUnit(seed, fi, 0x3c6ef372),
  };
}
// 多重パルスの包絡。1つの山は「ほぼ直線で上がり頂上で少し留まる」（実測の20→80%が0.31秒）。
// 単発は7割・多重は3割で、多重は山2〜7個を0.20〜0.50秒の不規則な間隔で並べる（実測の0.5〜2.5秒に収まる）
// 山ひとつ＝「速く立ち上がり・保持し・やや遅く落ちる」（実測の形）。
// 立ち上がりと減衰の両端は smoothstep なので微分が飛ばず、切れ目が見えない。
// 光は境界の少し前から始まり、境界をまたいで保持される（前後のカットが白の中で入れ替わる）
function transPulse(x, f) {
  if (x < -f.atk) return 0;
  if (x < 0) return smooth01((x + f.atk) / f.atk);          // 立ち上がり
  if (x < f.hold) return 1;                                  // 保持
  // 減衰。実物の光量は指数的に落ちる＝最初の2〜3コマで大きく減り、あとは長く尾を引く。
  // 前版の smoothstep は S字で「頂上付近が平ら」なため、保持が実質さらに数コマ延びていた。
  // 【2026-08-16 コマ送り実測で修正】減衰の終端を0にして残光を0.18から始めていたため、
  // 継ぎ目で +0.18 の段差ができていた（実測: 光の寄与がコマ9で+1→コマ11で+28に跳ね返る）。
  // ＝ユーザー評「エフェクトの切れ目がはっきりわかって違和感がある」。
  // 減衰は TAIL0 まで落ち、そこから残光が引き継ぐ形にして微分ごと繋ぐ。
  const TAIL0 = 0.18;
  if (x < f.hold + f.dec) { const u = (x - f.hold) / f.dec; return TAIL0 + (1 - TAIL0) * (1 - u) * (1 - u) * (1 - u); }
  // 残光の尾。実測では白が抜けたあとも8〜15コマ、明るい所だけに柔らかい光が残って縮む。
  // これが無いと「白→そのまま次のクリップ」と切り替わって見える（ユーザー指摘）
  const t2 = x - (f.hold + f.dec);
  if (t2 < f.tail) return TAIL0 * (1 - smooth01(t2 / f.tail));
  return 0;
}
function smooth01(t) { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); }
// 回復側の色被り（ユーザー目視②「白のあと複数の色が光る」／設計書§2・これまで未実装）。
// 参照14イベントの実測: 光が抜けた直後の数コマに、イベント単位で決まった系統の色が乗る。
//   琥珀寄り: R-G +22 / R-B +46   青緑寄り: R-G -26 / R-B -36   （R-B側の振れが大きい）
// 白の最中は出ず、抜けはじめてから1〜3コマで最大になり、残光と一緒に消える。
function recoverAt(dt, f) {
  const t0 = f.hold + f.dec * 0.45;           // 白が抜けはじめる位置
  if (dt < t0) return 0;
  const len = 0.10 + 0.06 * fractSeed(f.seed * 61);   // 2〜4コマで最大
  // 色被りは残光と同時に消える（光が無いのに色だけ残るのは嘘）。
  // 残光の終わり = hold + dec + tail なので、そこで0になる長さを逆算する。
  const fade = Math.max(0.04, f.dec * 0.55 + f.tail - len);
  const u = (dt - t0) / len;
  return u < 1 ? smooth01(u) : Math.max(0, 1 - smooth01((dt - t0 - len) / Math.max(fade, 1e-3)));
}
function transEnvelope(dt, f) {
  if (!f.multi) return transPulse(dt, f);
  // 【2026-08-16 修正】山の間隔は実測すると**二峰性**だった（32ピーク・3秒以内に続く18組）:
  //   短い群れ 0.17〜0.75秒（＝ユーザー目視①「2回明滅する」はこちら）
  //   長い群れ 1.42〜2.62秒
  // 前版は長い方(1.2〜3.0秒)しか出さず、目視で見えた短い明滅が一度も出なかった。
  // 設計書の0.2〜0.5秒は短い方だけを見ていた。両方を境界seedで4:6に振り分ける。
  const gaps = [];
  const quick = fractSeed(f.seed * 313) < 0.40;
  for (let k = 0; k < f.peaks - 1; k++) {
    const u = fractSeed(f.seed * 97 + k * 0.37);
    gaps.push(quick ? 0.17 + 0.58 * u : 1.42 + 1.20 * u);
  }
  let at = -gaps.reduce((s2, v) => s2 + v, 0) / 2;
  let best = 0;
  for (let k = 0; k < f.peaks; k++) {
    const h = 0.60 + 0.40 * fractSeed(f.seed * 53 + k * 0.91);
    best = Math.max(best, h * transPulse(dt - at, f));
    if (k < gaps.length) at += gaps[k];
  }
  return best;
}
function fractSeed(x) { const v = Math.sin(x * 12.9898) * 43758.5453; return v - Math.floor(v); }
// 群れ全体の長さ（時間窓の判定に使う）
function transSpan(f) {
  const one = f.atk + f.hold + f.dec + f.tail;
  if (!f.multi) return one;
  let total = 0;
  for (let k = 0; k < f.peaks - 1; k++) total += 1.20 + 1.80 * fractSeed(f.seed * 97 + k * 0.37);
  return total / 2 + one;
}
// スプライスの縦ジャンプ。基準リファレンス実測（ref-20260815-01）:
// カット直後1〜3コマで縦に跳ぶ。中央値は画面高の1.5%・90%点6.0%。
// 8mm（effect 2）のときは常に出る＝フィルムの物理なので、つなぎエフェクトのON/OFFとは独立。
function spliceAt(timing, adjust) {
  const a = adjust || project.adjust;
  if (a.effect !== 2 || project.clips.length < 2) return 0;
  const cad = timing.cadence || 18;
  const seed = timing.seed;
  const T = timing.timelineTime;
  for (let i = 1; i < project.clips.length; i++) {
    const dt = T - sumBefore(i);
    if (dt < 0 || dt > 4 / cad) continue;
    const fr = Math.floor(dt * cad);           // 境界から数えたコマ番号
    if (fr > 2) continue;
    const h = textureSeedUnit(seed, i, 0x3aa1c983);
    // 振幅: 中央値0.015・90%点0.06（h^2.6でその分布に寄せる）
    const amp = 0.008 + 0.075 * Math.pow(h, 2.6);
    // 向きは境界ごとに独立な物理現象。独立ハッシュだと同じ向きが4回続く作品が200/200だったので、
    // 偶奇で交互を基本にし、25%だけ乱数でひっくり返す（規則的すぎるのも嘘）
    const flip = textureSeedUnit(seed, i, 0x77f0aa11) < 0.25;
    const sign = ((i % 2 === 0) !== flip) ? 1 : -1;
    const decay = [1, 0.45, 0.15][fr];         // 1コマ目が最大、3コマで収まる
    return sign * amp * decay;
  }
  return 0;
}
function transitionAt(timing, adjust) {
  const a = adjust || project.adjust;
  const amt = a.trans || 0;
  if (amt <= 0 || project.clips.length < 1) return null;
  const film = a.effect === 2;
  const seed = normalizeTextureSeed(project.textureSeed, project);
  const T = timing.timelineTime, cad = timing.cadence || 18;
  let best = null;
  const take = o => { if (!best || o.amt > best.amt) best = o; };
  const lastB = sumBefore(project.clips.length);
  for (let i = 1; i <= project.clips.length; i++) {
    const isLast = i >= project.clips.length;
    const bAt = sumBefore(i);
    if (T - bAt < -6 || T - bAt > 6) continue;      // 多重パルスは群れで数秒に及ぶ
    let kind = transKindAt(i, amt, seed, film);
    if (kind === TK.NONE) continue;
    // 最後の境目には「境界より後」でしか効かない語彙（白抜け・露出・焼け・黒コマ）を
    // 当てても、後ろに映像が無いので一度も見えない。終わりを作れる語彙へ寄せる。
    // 【2026-08-17 修正】以前は最後の境目で「境界より後でしか効かない語彙」を光へ差し替えていた。
    // 後ろに映像が無かったからだが、**おわりを足した今は後ろに時間がある**ので差し替えない。
    // 差し替えたままだと「▲焼けを選んだのに白が出る」ことになる（ユーザー報告）。
    if (isLast && endingDur(a) <= 0
      && (kind === TK.POP || kind === TK.RAMP || kind === TK.SCORCH || kind === TK.BLACK)) {
      kind = TK.FLASH;
    }
    const ovFace = (project.transOverrides || []).find(x => x.leftClipId === project.clips[i - 1]?.id);
    const f = transFace(i, seed, ovFace?.roll || 0);
    const prevB = i > 1 ? sumBefore(i - 1) : 0;
    // 【2026-08-16 修正】最後の境目は総尺ちょうどにあるので、境界に合わせて置くと
    // **立ち上がりだけで作品が終わり、頂上も減衰も残光も一度も再生されない**
    // （ユーザー報告「クリップ終わりのエフェクトが適応されない」）。実測でも総尺直前が頂点だった。
    // 包絡が総尺までに収まるよう、実効の境界時刻を前へずらす。前の境目は越えない。
    // 【2026-08-16 再修正】前版は包絡ぜんぶが収まるよう前へずらしたが、そうすると
    // **光ったあとに元のクリップが戻ってきて終わる**（ユーザー評）。作品の終わりは
    // 「そのまま光って終わる」か「暗転して終わる」であるべきなので、
    // 立ち上がりだけを終わりの手前に置き、頂点に達したらそのまま保持して終わる。
    const at = isLast
      ? Math.max(prevB + 0.15, bAt - (f.atk + 0.30))
      : bAt;
    const raw = T - at;
    // ひとつの境目の光が**隣のカットの境目を越えない**ようにする。越えると take() が
    // 最大値を拾い、離れた境目まで同じ顔（同じ向き・同じ色）の光に塗られる（ユーザー報告）。
    // 最後の境目は「おわり」の終わりまで効かせる（おわりの間ずっと光ったまま沈む）
    const nextB = isLast ? lastB + endingDur(a)
      : i + 1 < project.clips.length ? sumBefore(i + 1) : lastB;
    if (raw < -(at - prevB) * 0.92 || raw > Math.max(nextB - at, 0.05)) continue;
    // 暖色フレアの出方は境目ごとに振る。3箇所入れたら3箇所とも「強い1回→薄い2回目」に
    // なっていた（ユーザー報告）ので、半分は単発、半分は2回だけの群れにする。
    // 3つ以上の群れは数秒に及び隣のカットまで届くので作らない。
    if (kind === TK.BURN) {
      const twin = fractSeed(f.seed * 211) < 0.5;
      f.multi = twin;
      if (twin) f.peaks = 2;
    }
    // 境界ごとの手動強度（既定1.0）。実物でも光の強さはイベントごとに違うので嘘にならない
    const ov = (project.transOverrides || []).find(x => x.leftClipId === project.clips[i - 1]?.id);
    const gain = f.vary * clamp(ov?.amp ?? 1, 0.3, 1.6);
    // 8mmの語彙はコマ単位で動く（コマの途中で光が変わると嘘になる）
    const fr = Math.floor(raw * cad);
    // 【2026-08-16 ユーザー決定】暖色フレアは光とまったく同じ時間の作り方にし、
    // 色（橙・黄・茶）だけで差を出す。理由は下記2つで、どちらもユーザーの実機評価:
    //  (1) 面積が広がる「穴」型は爆発に見えて主張が強く、狙いの「感光のよう」にならなかった
    //  (2) 穴型はコマごとの色が固定で、変わるのは起点だけ。どの境目でも同じに見えていた
    // 光の機構に乗せると、頂上長1〜15コマ・方向・多重パルス・勾配・強弱がすべて境界ごとに変わる。
    // 作品の終わりは「白く包まれて終わる」。頂点で勾配を残すと片側に映像が残ったまま終わる。
    // 立ち上がりの向きは残したいので、勾配そのものではなく**頂点での残差**だけを消す。
    if (isLast && (kind === TK.FLASH || kind === TK.BURN)) f.grad = 1.0;
    if (kind === TK.FADEOUT) {
      // 暗転して終わる。最後の境目だけの語彙。立ち上がりの倍の時間をかけて黒へ落とす
      const len = f.atk * 2.0 + 0.35;
      if (raw < -len) continue;
      take({ kind, phase: 1, amt: clamp((raw + len) / len, 0, 1) * gain, face: f });
    } else if (kind === TK.FLASH || kind === TK.BURN) {
      const span = transSpan(f);
      // 最後の境目は、おわりが白（黒）へ沈み終わるまで効かせる。
      // 【2026-08-17 修正】ここを span で打ち切っていたため、**光が先に時間切れになり、
      // おわりがまだ白くなりきる前に素の画が戻ってきて谷ができていた**
      // （実測: 27.9s 明251 → 28.3s 明199 → 28.6s 明252）。
      const 終わりまで = isLast && endingDur(a) > 0 ? Math.max(span, timelineDur() - at) : span;
      if (raw < -span || raw > 終わりまで) continue;
      // 最後の境目は「終わりを作る」ので、頂点に達したら減衰させずそのまま保持する
      const env = isLast
        ? (raw < 0 ? smooth01((raw + f.atk) / Math.max(f.atk, 1e-3)) : 1)
        : transEnvelope(raw, f);
      // phaseは0=立ち上がり中 / 0.5=保持 / 1=抜けきる直前。減衰側でだけ滲みを強めて
      // 「次の画が白の中から柔らかく現れる」実測の見え方を作る
      const ph = raw < 0 ? 0.25 * (1 + raw / Math.max(f.atk, 1e-3))
        : raw < f.hold ? 0.5
          : 0.5 + 0.5 * Math.min(1, (raw - f.hold) / Math.max(f.dec + f.tail, 1e-3));
      // 【2026-08-16 撤去】前版はコマごとに±12%の揺らぎを掛けていたが、参照14イベントの
      // 実測では頂上内のコマ間std は 1.7（=±0.7%）で、±12%は17倍の過剰＝実測に反する嘘だった。
      // ばらつかせるべきは1コマごとの明るさではなく、境界ごとの頂上の長さ（transFace.hold）。
      if (env > 0) take({ kind, phase: ph, amt: env * gain, face: f, recover: recoverAt(raw, f) });
    } else if (kind === TK.WASH) {
      // 暖色ウォッシュ: 一瞬型(0.7s)とゆっくり型(2〜4s)の2変種
      const quick = fractSeed(f.seed * 31) < 0.5;
      const len = quick ? 0.7 : 2.0 + 2.2 * fractSeed(f.seed * 17);
      if (raw < -0.15 || raw > len) continue;
      const x = (raw + 0.15) / (len + 0.15);
      const env = Math.min(1, Math.max(0, Math.min(x / 0.18, (1 - x) / 0.45)));
      if (env > 0) take({ kind, phase: x, amt: env * gain, face: f });
    } else if (kind === TK.POP) {
      if (fr < 0 || fr > 1) continue;                       // 1〜2コマだけ
      take({ kind, phase: fr, amt: gain, face: f });
    } else if (kind === TK.RAMP) {
      if (fr < 0 || fr > 5) continue;                       // 5コマで戻る
      take({ kind, phase: fr / 5, amt: (1 - fr / 6) * gain, face: f });
    } else if (kind === TK.SCORCH) {
      // 長さは3〜10コマへ広げる（3〜6だと全部同じ速さに見える）。
      // 立ち上がりも境目ごとにずらし、境界の0〜2コマ前から始まる個体を作る
      const lead = Math.floor(fractSeed(f.seed * 137) * 3);   // 0〜2コマ早く始まる
      let n = 3 + Math.floor(fractSeed(f.seed * 71) * 8);
      // 【2026-08-17】作品の最後では、焼けきったクリーム色のまま「おわり」の沈み込みへ渡す。
      // 元の長さのままだと数コマで焼けが終わって画が戻り、そのあと唐突に白くなる（ユーザー報告）。
      if (isLast && endingDur(a) > 0) n = Math.max(n, Math.round(0.38 * endingDur(a) * cad));
      if (fr < -lead) continue;
      if (fr > n && !(isLast && endingDur(a) > 0)) continue;
      take({ kind, phase: Math.min(1, (fr + lead) / (n + lead)), amt: gain, face: f });
    } else if (kind === TK.BLACK) {
      const n = 4 + Math.floor(fractSeed(f.seed * 43) * 3);  // 4〜6コマで浮く
      if (fr < 0 || fr > n) continue;
      take({ kind, phase: fr, amt: gain, face: f });
    }
  }
  return best;
}

async function renderAtTimelineTime(T, sourceProvider, options = {}) {
  const timing = getTimelineRenderTiming(T);
  if (!timing) return null;
  const provided = await sourceProvider(timing);
  if (!provided?.source) return null;
  const pipe = options.pipe || preview;
  // テキストは作品時刻Tで決まる。プレビューも書き出しも同じここを通る
  const ro = options.renderOptions || {};
  await pipe.draw(
    provided.source,
    provided.width || timing.clip.w,
    provided.height || timing.clip.h,
    provided.rot || 0,
    timing.effectTime,
    timing.clip,
    ro.bypassLook ? ro : { ...ro, texts: ro.texts || textsAt(timing.timelineTime, timing.cadence), trans: transitionAt(timing, ro.adjust), spliceY: spliceAt(timing, ro.adjust), endAmt: endingAmt(timing.timelineTime, ro.adjust) },
  );
  return timing;
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
      scheduleThumbs();
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
  // 再生中は自動追従が動かしているので触らない。スクラブは停止させてから入るのでここを通る
  if (playing) return;
  const sc = $('timelineScroll');
  if (Math.abs(sc.scrollLeft - timelinePos * pxPerSec) < 2) return;
  seekTimeline(sc.scrollLeft / pxPerSec, true);
});
// 再生中にタイムラインへ触れたら、いったん止めて指へ追従させ、離した位置から再生を続ける。
// 「再生したまま裏で走らせる」より、止めて再開するほうが音楽の頭出し・写真の経過・コマ送りが全部そろう。
//
// 【2026-08-16 修正】前版は `pointercancel` を「指を離した」と見なして即再開していた。
// 実機ではブラウザが横スクロールを始めた瞬間に pointercancel が飛ぶので、
// **ドラッグの途中で勝手に再生が戻り、巻き戻し・早送りができなかった**（ユーザー報告）。
// ポインタ関連の不具合はこれで4件目。いずれも「pointercancel は終了ではない」が原因。
// 指が離れていて、かつ**スクロールが落ち着いてから**再開する（慣性スクロール中は待つ）。
{
  const sc = $('timelineScroll');
  let scrubDown = false, scrubTimer = 0;
  const resumeSoon = () => {
    if (!scrubbing || scrubDown) return;
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => {
      if (!scrubbing || scrubDown) return;
      scrubbing = false;
      seekTimeline(timelinePos);
      // 末尾までスクラブしたときは再開しない。play() は終端だと先頭へ巻き戻す仕様なので、
      // そのまま呼ぶと「早送りしたのに頭から再生される」ことになる（実測で確認）
      if (timelinePos >= timelineDur() - 0.05) return;
      void play();        // 音楽・写真の起点・クリップ再生を正しく組み直す
    }, 200);
  };
  sc.addEventListener('pointerdown', () => {
    scrubDown = true;
    clearTimeout(scrubTimer);
    if (!playing || scrubbing) return;
    scrubbing = true;     // 離したときに再生を続けるための目印
    stopPlayback();       // 以降は停止中と同じ経路でプレビューが指へ追従する
  });
  // 慣性スクロールが続くあいだは再開を先送りする（止まった位置から再生したい）
  sc.addEventListener('scroll', () => { if (scrubbing) resumeSoon(); });
  // 指を離した合図は window で拾う。捕捉が別要素へ移っていても取りこぼさない
  for (const type of ['pointerup', 'pointercancel']) {
    window.addEventListener(type, () => { scrubDown = false; resumeSoon(); }, true);
  }
}
window.addEventListener('resize', () => { renderTimeline(); syncPlayheadScroll(); });

// クリップのタップ選択・トリム・並び替え
let drag = null;
$('timelineTrack').addEventListener('pointerdown', e => {
  // 掴んだ状態の印が万一残ると、以後スクロールできなくなる。新しい操作の頭で必ず落とす
  if (!drag) $('timelineScroll').classList.remove('dragging');
  const mark = e.target.closest('.transMark');
  // 【2026-08-16 修正】pointerdown で開くと、同じタップの click が
  // 直後に指の下へ現れたシートのボタンに届き、その場で選択して閉じてしまう
  // （実機ログ: 触れた▲ → 90ms後に離した → その2ms後に「▲ ネガ焼け」が押された）。
  // 長押しだと click が出ないので開けたように見えていた。指を離してから開く。
  if (mark) {
    e.stopPropagation();
    const bi = parseInt(mark.dataset.bi, 10);
    const x0 = e.clientX, y0 = e.clientY, tr = $('timelineTrack');
    const done = open => ev => {
      tr.removeEventListener('pointerup', up);
      tr.removeEventListener('pointercancel', cancel);
      // 少しでも滑っていればスクラブなので開かない
      if (open && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 18) openTransPicker(bi);
    };
    const up = done(true), cancel = done(false);
    tr.addEventListener('pointerup', up);
    tr.addEventListener('pointercancel', cancel);
    return;
  }
  const block = e.target.closest('.clipBlock');
  // 空きエリアのタップは選択解除。ただし少しでも動いたらスクラブなので解除しない
  if (!block) {
    if (!selId) return;
    const x0 = e.clientX, y0 = e.clientY;
    const up = ev => {
      $('timelineTrack').removeEventListener('pointerup', up);
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) deselectClip();
    };
    $('timelineTrack').addEventListener('pointerup', up, { once: true });
    return;
  }
  const id = block.dataset.id;
  const idx = project.clips.findIndex(c => c.id === id);
  if (idx < 0) return;
  const clip = project.clips[idx];
  const handle = e.target.closest('.trimHandle');

  if (handle) {
    e.preventDefault();
    // 指が既に離れている等で捕捉できないことがある。捕捉できなくてもトリム自体は続けられる
    try { block.setPointerCapture(e.pointerId); } catch (err) { }
    drag = { mode: handle.classList.contains('left') ? 'trimL' : 'trimR', clip, idx, block, x0: e.clientX, start0: clip.start, end0: clip.end, historyBefore: beginHistory() };
    stopPlayback();
    return;
  }
  // タップ＝選択、その場で長押し＝並び替え。
  // ここではポインタを捕捉しない（捕捉するとタイムラインの横スクロール＝スクラブを邪魔するため）。
  // 少しでも動いたら並び替えには入らない（ドラッグは常にスクラブとして扱う）
  drag = {
    mode: 'tap', clip, idx, block, x0: e.clientX, y0: e.clientY, pointerId: e.pointerId,
    left0: parseFloat(block.style.left), moved: false, historyBefore: beginHistory(),
    timer: setTimeout(() => {
      if (!drag || drag.mode !== 'tap' || drag.moved) return;
      drag.mode = 'move';
      block.classList.add('dragging');
      $('timelineScroll').classList.add('dragging');
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
    $('timelineScroll').classList.remove('dragging');
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
      markDirty();
      commitHistory(d.historyBefore);
    }
    selId = d.clip.id;
    renderTimeline(); renderClipEdit();
    // 並び替え後も再生位置は動かさない（別のクリップへ飛ばない）
    seekTimeline(timelinePos);
    return;
  }
  // トリム終了。編集した側の端に再生位置を残す
  renderTimeline(); renderClipEdit();
  markDirty();
  commitHistory(d.historyBefore);
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
  $('timelineScroll').classList.remove('dragging');
  const wasMove = drag.mode === 'move';
  drag = null;
  if (wasMove) renderTimeline();
}
// touch-action は指が触れた瞬間に評価されるので、あとからclassを足しても進行中のスクロールは止まらない。
// 掴んでいる間の touchmove を明示的に打ち消して、横スクロールへ指を奪われないようにする。
$('timelineScroll').addEventListener('touchmove', e => {
  if (drag && (drag.mode === 'move' || drag.mode === 'trimL' || drag.mode === 'trimR')) e.preventDefault();
}, { passive: false });
$('timelineTrack').addEventListener('pointerup', endDrag);
$('timelineTrack').addEventListener('pointercancel', cancelDrag);
// 指を離した場所がタイムラインの外だったり、並び替え中に要素が作り直されて捕捉が外れると、
// タイムライン上のpointerupが来ないことがある。取りこぼすとdragが握られたままになるので窓側でも受ける。
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', cancelDrag);

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
  $('timelineScroll').classList.remove('dragging');
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
// 取りこぼすと古い指が残り続け、次からの長押しが毎回「2本指」と誤判定されて並び替えができなくなる。
// 実際にそうなった（2026-08-14）。指の離しは必ず窓側でも拾う。
window.addEventListener('pointerup', endPinchPt, true);
window.addEventListener('pointercancel', endPinchPt, true);
// Mac/トラックパッドのピンチは ctrl+wheel として届く
tlScroll.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(pxPerSec * Math.exp(-e.deltaY * 0.01), timelinePos);
}, { passive: false });

// ===== プレビュー描画 =====
let lastDrawn = null;
let previewDrawSeq = 0;
function drawStill(clip) {
  lastDrawn = clip;
  const seq = ++previewDrawSeq;
  trace('drawStill', () => ({ clip: project.clips.indexOf(clip), seq, ready: clipReady(clip), T: +timelinePos.toFixed(3) }));
  // まだ読み込み中なら、準備できてから描き直す（復元直後にプレビューが黒いままになるのを防ぐ）
  if (!clipReady(clip)) {
    const src = clipSource(clip);
    const ev = clip.kind === 'photo' ? 'load' : 'loadeddata';
    src.addEventListener(ev, () => { if (lastDrawn === clip && !playing) drawStill(clip); }, { once: true });
    return;
  }
  // 停止中はHTML videoも、Tから算出したclip-local source時刻へ正確にseekしてから描く。
  void renderAtTimelineTime(timelinePos, async timing => {
    if (timing.clip !== clip || seq !== previewDrawSeq || playing) {
      trace('drawStill.skip', () => ({ want: project.clips.indexOf(clip), got: project.clips.indexOf(timing.clip),
        seq, cur: previewDrawSeq, playing }));
      return null;
    }
    if (timing.clip.kind === 'video' && Math.abs(timing.clip.video.currentTime - timing.localSourceTime) > 0.001)
      await seekTo(timing.clip.video, timing.localSourceTime);
    if (seq !== previewDrawSeq || playing) { trace('drawStill.skip2', () => ({ seq, cur: previewDrawSeq, playing })); return null; }
    trace('drawStill.draw', () => ({ clip: project.clips.indexOf(clip),
      exposure: +(project.adjust.exposure + clipBrightOf(clip)).toFixed(3),
      temp: +clipTempOf(clip).toFixed(3), autoAlign: project.autoAlign }));
    return { source: clipSource(timing.clip), width: timing.clip.w, height: timing.clip.h };
  }, bypassLook ? { renderOptions: { bypassLook: true } } : {})
    .then(() => syncTextFrame())    // 画が変わったら、選んでいる文字の枠も合わせ直す
    .catch(e => { if (!playing) logErr('プレビュー: ' + e.message); });
}
function redraw() {
  scheduleThumbs();
  if (playing) { trace('redraw.skip', () => ({ reason: 'playing' })); return; }
  const c = lastDrawn || project.clips[playIdx] || project.clips[0];
  trace('redraw', () => ({ lastDrawn: project.clips.indexOf(lastDrawn), picked: project.clips.indexOf(c), playIdx }));
  if (c) drawStill(c);
}

// ===== 吸着（スナップ）=====
// 【2026-08-17 ユーザー要望】「中央などにカチッと吸着する動作」。
// 指で置くと必ず数px ずれる。中央に置いたつもりが 0.497 のような半端な値になり、
// 書き出してから気づく。よく使う位置の近くへ来たら、そこへ吸わせる。
const SNAP_X = [0.5, 0.08, 0.92, 1 / 3, 2 / 3];      // 中央・左右の余白・三分割
const SNAP_Y = [0.5, 0.12, 0.88, 1 / 3, 2 / 3];      // 中央・上下の余白・三分割
const SNAP_ANGLES = [0, 90, -90, 180, -180, 15, -15, 30, -30, 45, -45];
const SNAP_PX = 12;                                   // この画面距離まで近づいたら吸う
function 位置スナップ(x, y, r) {
  const 当たり = { x: null, y: null };
  let sx = x, sy = y;
  for (const v of SNAP_X) if (Math.abs(x - v) * r.width <= SNAP_PX) { sx = v; 当たり.x = v; break; }
  for (const v of SNAP_Y) if (Math.abs(y - v) * r.height <= SNAP_PX) { sy = v; 当たり.y = v; break; }
  return { x: sx, y: sy, 当たり };
}
// 傾きも同じ考え方で、まっすぐ・直角・よく使う斜めへ吸わせる
function 角度スナップ(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  for (const v of SNAP_ANGLES) if (Math.abs(d - v) <= 4) return v;
  return Math.round(d * 10) / 10;
}
// 吸った線を見せる。見えないと「なぜ動かないのか」が分からない
function showSnapGuides(当たり, r) {
  const gx = $('snapGuideX'), gy = $('snapGuideY');
  if (!gx || !gy) return;
  if (!当たり || !r) { gx.classList.remove('on'); gy.classList.remove('on'); return; }
  const br = $('previewBox').getBoundingClientRect();
  if (当たり.x != null) {
    gx.style.left = Math.round((r.left - br.left) + 当たり.x * r.width) + 'px';
    gx.style.top = Math.round(r.top - br.top) + 'px';
    gx.style.height = Math.round(r.height) + 'px';
    gx.classList.add('on');
  } else gx.classList.remove('on');
  if (当たり.y != null) {
    gy.style.top = Math.round((r.top - br.top) + 当たり.y * r.height) + 'px';
    gy.style.left = Math.round(r.left - br.left) + 'px';
    gy.style.width = Math.round(r.width) + 'px';
    gy.classList.add('on');
  } else gy.classList.remove('on');
}

// 枠に付けたつまみで文字を回す。
// 【2026-08-17 ユーザー評価】2本指の回転は動かす操作と間違えやすかったので、つまみ方式へ。
// 文字の中心とつまみを結ぶ線の角度で決める（掴んだ瞬間との差を足す＝つまみが指に付いてくる）。
{
  const knob = $('textRotKnob');
  if (knob) knob.addEventListener('pointerdown', e => {
    const t = selText(); if (!t) return;
    e.preventDefault(); e.stopPropagation();     // 文字を動かす側へ渡さない
    const cv = $('previewCanvas'), r = cv.getBoundingClientRect();
    if (!r.width) return;
    const cx = r.left + t.x * r.width, cy = r.top + t.y * r.height;
    const 角 = ev => Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
    const 元角 = 角(e), 元rot = t.rot || 0;
    const before = beginHistory();
    let 回した = false;
    try { knob.setPointerCapture(e.pointerId); } catch (_) { }
    const mv = ev => {
      if (ev.pointerId !== e.pointerId) return;
      回した = true;
      t.rot = 角度スナップ(元rot + (角(ev) - 元角));
      clearTextRaster(); syncTextPanel(); redraw();
    };
    const up = ev => {
      if (ev.pointerId !== e.pointerId) return;
      try { knob.releasePointerCapture(e.pointerId); } catch (_) { }
      knob.removeEventListener('pointermove', mv);
      knob.removeEventListener('pointerup', up);
      knob.removeEventListener('pointercancel', up);
      if (回した) { commitHistory(before); markDirty(); }
    };
    knob.addEventListener('pointermove', mv);
    knob.addEventListener('pointerup', up);
    knob.addEventListener('pointercancel', up);
  });
}

// プレビュー上の座標に文字があるか調べる（キャンバスの表示領域を0..1へ直して当たり判定）
function textAtPoint(e) {
  const cv = $('previewCanvas'), r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const ux = (e.clientX - r.left) / r.width, uy = (e.clientY - r.top) / r.height;
  if (ux < 0 || ux > 1 || uy < 0 || uy > 1) return null;
  // フェードで透明な瞬間でも掴めるように、当たり判定は表示区間だけで決める（textsAtはalpha=0を除外してしまう）
  const starts = project.clips.map((_, i) => sumBefore(i));
  const shown = (project.texts || []).filter(t => {
    const sp = textSpan(t, starts);
    return sp && timelinePos >= sp[0] - 0.05 && timelinePos <= sp[1] + 0.05;
  });
  let best = null, bestD = Infinity;
  for (const t of shown) {
    let hw = 0.25, hh = 0.06;
    try { const ras = rasterizeText(t, cv.width, cv.height); hw = ras.w / cv.width / 2; hh = ras.h / cv.height / 2; }
    catch (err) { }
    // 指は太いので、文字の枠より少し広く取る
    const dx = Math.abs(ux - t.x) - (hw + 0.02), dy = Math.abs(uy - t.y) - (hh + 0.03);
    if (dx > 0 || dy > 0) continue;
    const d = Math.hypot(ux - t.x, uy - t.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// ===== プレビュー長押し＝調整前を見る =====
// タイムライン側の長押しは並べ替えに使っているので、こちらはプレビューに置く（Lightroomと同じ作法）。
{
  const box = $('previewBox');
  let holdTimer = 0, holding = false;
  const start = e => {
    if (playing || exporting || !project.clips.length) return;
    const x0 = e.clientX, y0 = e.clientY;
    // 文字の上から始まったら、指で直接つかんで動かす（写真文字入れアプリと同じ触り方）
    // 文字の上をきっちり押せなくても動かせるようにする。
    // 【2026-08-17 ユーザー要望】実機では指が太く、小さな文字は狙って掴めない。
    // 文字タブを開いていて、選んでいる文字がいま見えているなら、**画面のどこを触っても**その文字が動く
    // （写真文字入れアプリと同じ触り方）。文字タブを開いていないときは今までどおり長押し＝調整前。
    const 文字タブ = $('panel-text').classList.contains('on');
    const 選択中 = 文字タブ ? selText() : null;
    const 見えている = 選択中 && (() => {
      const sp = textSpan(選択中, project.clips.map((_, i) => sumBefore(i)));
      return sp && timelinePos >= sp[0] - 0.05 && timelinePos <= sp[1] + 0.05;
    })();
    const grabbed = textAtPoint(e) || (見えている ? 選択中 : null);
    if (grabbed) {
      selTextId = grabbed.id;
      if (!$('panel-text').classList.contains('on')) { switchTab('text', true); buildTextPanel(); }
      syncTextPanel();
      const cv = $('previewCanvas'), r = cv.getBoundingClientRect();
      const before = beginHistory();
      const ox = grabbed.x, oy = grabbed.y;
      // マウスはタッチと違い暗黙のポインタ捕捉がない。捕捉しないと、枠の外で
      // ボタンを離したときにupが来ず、リスナーが残って文字が指に貼りつき続ける
      try { box.setPointerCapture(e.pointerId); } catch (_) { }
      // 文字が画面からはみ出さない範囲。x,y は文字の**中心**なので、端まで動かすと半分消える
      // （実測: y=0.00 まで動かしたら文字の上半分が画面外に出た）。文字の大きさの分だけ内側で止める。
      let はみ出し防止 = { hw: 0, hh: 0 };
      try {
        const ras = rasterizeText(grabbed, cv.width, cv.height);
        はみ出し防止 = { hw: Math.min(0.45, ras.w / cv.width / 2), hh: Math.min(0.45, ras.h / cv.height / 2) };
      } catch (err) { }
      let moved = false;
      // 【2026-08-17 ユーザー評価】2本指の回転は、動かす操作と間違えやすかったのでやめた。
      // 回すのは枠に付けたつまみ（#textRotKnob）だけ。ここは「動かす」に専念する。
      const mv = ev => {
        if (ev.pointerId !== e.pointerId) return;
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) moved = true;
        if (!moved) return;
        const { hw, hh } = はみ出し防止;
        const 素x = clamp(ox + (ev.clientX - x0) / r.width, hw, 1 - hw);
        const 素y = clamp(oy + (ev.clientY - y0) / r.height, hh, 1 - hh);
        const s = 位置スナップ(素x, 素y, r);
        grabbed.x = s.x; grabbed.y = s.y;
        showSnapGuides(s.当たり, r);
        clearTextRaster(); syncTextPanel(); redraw();
      };
      const up = ev => {
        if (ev.pointerId !== e.pointerId) return;
        try { box.releasePointerCapture(e.pointerId); } catch (_) { }
        box.removeEventListener('pointermove', mv);
        box.removeEventListener('pointerup', up);
        box.removeEventListener('pointercancel', up);
        showSnapGuides(null);
        // 動かさずに離した＝タップ。その文字を書きかえる（プレビューを直に触って直せるように）
        if (!moved && ev.type === 'pointerup') { openTextInput(); return; }
        if (moved) { commitHistory(before); markDirty(); }
      };
      box.addEventListener('pointermove', mv);
      box.addEventListener('pointerup', up);
      box.addEventListener('pointercancel', up);
      return;                       // 長押し「調整前」とは競合させない
    }
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holding = true; bypassLook = true;
      $('beforeBadge').hidden = false;
      redraw();
    }, 500);
    const move = ev => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) end(); };
    const end = () => {
      clearTimeout(holdTimer);
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', end);
      box.removeEventListener('pointercancel', end);
      box.removeEventListener('pointerleave', end);
      if (!holding) return;
      holding = false; bypassLook = false;
      $('beforeBadge').hidden = true;
      redraw();
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    box.addEventListener('pointerleave', end);
  };
  box.addEventListener('pointerdown', start);
}

// ===== 再生 =====
let playing = false, playIdx = 0, rafId = 0, lastPreviewRenderKey = null;
let photoT0 = 0, photoElapsed = 0, advancing = false, playTimer = 0;
// 再生したままタイムラインを触っている間（プレビューは指に追従し、離した位置から再生を続ける）
let scrubbing = false;
// プレビュー長押し中は補正前の絵を出す
let bypassLook = false;
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
  const outStart = total - musicFadeOut() - fromT, outEnd = total - fromT;
  if (outStart > 0) { g.setValueAtTime(vol, now + outStart); g.linearRampToValueAtTime(0, now + Math.max(outStart + 0.02, outEnd)); }
  // 書き出しと同じ条件でくり返す。ここを揃えないとプレビューと書き出しで音が変わる
  const mDur = musicAudioBuf.duration;
  // 【2026-08-16】曲のどこから鳴らすかを選べるようにした（イントロを飛ばす／サビから始める）。
  // offset より前は使わないので、くり返しも offset 〜 曲尻 を回す。
  const off0 = musicOffset();
  const usable = Math.max(0.1, mDur - off0);
  if (project.music.loop !== false && usable < total - 0.05) {
    musicSrc.loop = true; musicSrc.loopStart = off0; musicSrc.loopEnd = mDur;
    musicSrc.start(now, off0 + (fromT % usable), Math.max(0.1, outEnd));
  } else if (fromT < usable) {
    musicSrc.start(now, off0 + fromT, Math.max(0.1, outEnd));
  }
}
// ===== 音楽の波形（v8-17）=====
// 曲全体を1画面に収める。横スクロールしないので、シート高(42dvh)を圧迫しないし、
// スクロールとドラッグの取り合いも起きない。CapCut等は専用画面を持てるがここは持てない。
const WAVE_BARS = 320;                      // 画面幅ぶんの本数。曲の長さに関係なく一定＝長い曲でも重くならない
let wavePeaks = null, wavePeaksKey = null;  // ピークは曲ごとに1回だけ計算して使い回す
function musicPeaks() {
  const key = project.music?.assetId || project.music?.name || null;
  if (!musicAudioBuf || !key) return null;
  if (wavePeaksKey === key && wavePeaks) return wavePeaks;
  const ch = musicAudioBuf.getChannelData(0), n = ch.length;
  const per = Math.max(1, Math.floor(n / WAVE_BARS));
  const out = new Float32Array(WAVE_BARS);
  let mx = 1e-6;
  for (let b = 0; b < WAVE_BARS; b++) {
    let p = 0;
    const s0 = b * per, s1 = Math.min(n, s0 + per);
    // 全サンプルは見ない（長い曲で重くなる）。等間隔に間引いても山の形は保たれる
    const step = Math.max(1, Math.floor((s1 - s0) / 400));
    for (let i = s0; i < s1; i += step) { const a = Math.abs(ch[i]); if (a > p) p = a; }
    out[b] = p; if (p > mx) mx = p;
  }
  for (let b = 0; b < WAVE_BARS; b++) out[b] /= mx;   // 一番大きい山を1.0に正規化
  wavePeaks = out; wavePeaksKey = key;
  return out;
}
function drawMusicWave() {
  const cv = $('musicWave'); if (!cv || !musicAudioBuf) return;
  const peaks = musicPeaks(); if (!peaks) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(120, Math.round(cv.clientWidth)), H = 56;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const dur = musicAudioBuf.duration;
  const off = musicOffset();
  const usable = Math.max(0.1, dur - off);
  const total = timelineDur();
  const bw = W / WAVE_BARS;
  // 【表示の決め】明るい＝1周目に使う ／ 中くらい＝くり返しで使う ／ 暗い＝開始位置より前で使わない。
  // 最初は「使う範囲」だけを明るくしたが、曲が短いと全域が明るくなって範囲が分からなかった。
  const firstEnd = off + Math.min(usable, total);      // 1周目で鳴り終わる位置
  for (let b = 0; b < WAVE_BARS; b++) {
    const t = (b + 0.5) / WAVE_BARS * dur;
    g.fillStyle = t < off ? '#33332f' : (t <= firstEnd ? '#e8e2d4' : '#6b6a62');
    const h = Math.max(1.5, peaks[b] * (H - 14));
    g.fillRect(b * bw, (H - h) / 2, Math.max(1, bw - 0.6), h);
  }
  // 使わない前半を沈める（つまみの左）
  const x = (off / dur) * W;
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, x, H);
  // くり返す回数を右下に出す。何周するのかが数字で分かる
  if (project.music?.loop !== false && usable < total - 0.05) {
    const times = Math.ceil(total / usable);
    g.fillStyle = '#8a8a85'; g.font = '10px sans-serif'; g.textAlign = 'right';
    g.fillText('×' + times + ' くり返し', W - 5, H - 5);
  }
  // 目盛（0:00 と 曲の終わり）。位置の見当がつくようにする
  if (off <= 0.05) { g.fillStyle = '#6b6a62'; g.font = '9px sans-serif'; g.textAlign = 'left'; g.fillText('0:00', 4, H - 5); }
  // つまみ（開始位置）
  g.strokeStyle = '#f4f3ef'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  g.fillStyle = '#f4f3ef';
  // つまみは小さく。大きいと波形そのものを隠す（当たり判定は22pxで別に取ってあるので見た目は小さくてよい）
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 5, 6); g.lineTo(x - 5, 6); g.closePath(); g.fill();
  // 現在位置の秒数はつまみの反対側へ小さく出す（波形に重ねない）
  if (off > 0.05) {
    g.font = '9px sans-serif'; g.textAlign = x > W - 40 ? 'right' : 'left';
    g.fillStyle = '#c9c4b8';
    g.fillText(fmt(off), x > W - 40 ? x - 4 : x + 4, 9);
  }
}
// 音楽のフェードアウトの長さ。おわりを付けたらそれに合わせ、無ければ従来どおり1.5秒。
// 映像が沈むのと音が消えるのが揃っていないと、片方だけ先に終わって不自然になる
function musicFadeOut() { return Math.max(1.5, endingDur()); }
// 曲の開始位置。曲より後ろは指せないよう必ず丸める（曲を差し替えても壊れない）
function musicOffset() {
  if (!project.music || !musicAudioBuf) return 0;
  const d = musicAudioBuf.duration;
  return clamp(project.music.offset || 0, 0, Math.max(0, d - 0.5));
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
  // おわりの間は syncPlayhead を止める。あれはクリップの経過から位置を決めるので、
  // クリップの外（おわり）では毎回クリップ末尾へ引き戻してしまう（実測で位置が27.17に固定された）。
  // かわりに、このタイマーでおわりを進める。rAFは画面が隠れると止まるので、
  // rAFだけに任せると「おわりで固まったまま終わらない」ことがある（実測）
  playTimer = setInterval(() => {
    if (!playing) return;
    if (endingRun) { advanceEnding(); return; }
    syncPlayhead(); checkAdvance();
  }, 100);
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
  } else if (endingDur() > 0 && !endingRun) {
    // 【2026-08-16】おわりはクリップの外にあるので、クリップが終わったら再生も終わっていた
    // ＝プレビューでは一度も見えなかった（書き出しにだけ入っていた）。
    // 最後のクリップが終わったら、そのまま「おわり」を時計で進めて総尺まで再生する。
    endingRun = { t0: performance.now(), from: clipsDur() };
  } else if (!endingRun) stopPlayback(true);
}
let endingRun = null;   // おわりを再生中かどうか（時計で進める）
function advanceEnding() {
  if (!endingRun) return false;
  const total = timelineDur();
  timelinePos = Math.min(total, endingRun.from + (performance.now() - endingRun.t0) / 1000);
  syncPlayheadScroll(); updateTimeLabel();
  if (timelinePos >= total - 1e-3) { endingRun = null; stopPlayback(true); return false; }
  return true;
}
function loop() {
  if (!playing) return;
  const c = project.clips[playIdx];
  if (endingRun) {
    // おわりの間はクリップが進まないので、時計で位置を進めて最後のコマを描き続ける
    if (advanceEnding()) {
      const timing = getTimelineRenderTiming(timelinePos);   // 進めるのはタイマーと共通の関数
      if (timing && clipReady(timing.clip)) {
        const key = `end:${Math.floor(timing.timelineTime * 30)}`;
        if (key !== lastPreviewRenderKey) {
          lastPreviewRenderKey = key;
          void renderAtTimelineTime(timing.timelineTime, async t => ({
            source: clipSource(t.clip), width: t.clip.w, height: t.clip.h,
          })).catch(e => logErr('プレビュー: ' + e.message));
        }
      }
      rafId = requestAnimationFrame(loop);
    }
    return;
  }
  if (c) {
    // wall clockはcurrentLocalの再生進行にだけ使い、描画は常に作品時間から決める。
    syncPlayhead();
    const timing = getTimelineRenderTiming(timelinePos);
    if (timing && clipReady(timing.clip)) {
      // 8mmは同一film frameを再描画しない。通常効果も30fps作品tickで間引くだけで、
      // shaderのtimeへ壁時計を渡さない。
      const key = timing.filmFrame == null
        ? `${timing.clip.id}:tick:${Math.floor(timing.timelineTime * 30)}`
        : `${timing.clip.id}:film:${timing.filmFrame}`;
      if (key !== lastPreviewRenderKey) {
        lastPreviewRenderKey = key;
        lastDrawn = timing.clip;
        void renderAtTimelineTime(timing.timelineTime, async t => ({
          source: clipSource(t.clip), width: t.clip.w, height: t.clip.h,
        })).catch(e => logErr('プレビュー: ' + e.message));
      }
    }
    checkAdvance();
  }
  rafId = requestAnimationFrame(loop);
}
function stopPlayback(atEnd) {
  if (!playing) return;
  playing = false;
  endingRun = null;
  cancelAnimationFrame(rafId);
  clearInterval(playTimer);
  const c = project.clips[playIdx];
  if (c?.kind === 'video') c.video.pause();
  if (c?.kind === 'photo') photoElapsed = currentLocal(c);
  stopMusic();
  lastPreviewRenderKey = null;
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
  mp4.onSamples = (id, u, batch) => { for (const sample of batch) samples.push(sample); };
  mp4.start();
  const want = track.nb_samples, t0 = performance.now();
  while (samples.length < want && performance.now() - t0 < 30000) await new Promise(r => setTimeout(r, 50));
  mp4.stop();
  if (!samples.length) throw new Error('サンプル抽出に失敗');
  return { track, samples, desc, rot };
}

function warnHdrTrackIfDetected(track) {
  // mp4boxが読める色metadataだけを使う。読めない素材をHDRと断定せず、既存のSDR推奨表示を残す。
  const color = track?.color || track?.video?.color || track?.video?.colorSpace || {};
  let text = ''; try { text = JSON.stringify(color).toLowerCase(); } catch (e) { text = String(color).toLowerCase(); }
  if (!/(bt[ ._-]?2020|pq|hlg|smpte[ ._-]?2084|arib)/.test(text)) return;
  const message = 'HDR/PQ/HLG/BT.2020の可能性がある素材です。自動補正ではなくSDR変換後の確認をおすすめします。';
  logErr(message);
  $('exportWarnings').textContent = message;
}

let lastVideoDecoderStats = null;
// VFR/B-frameを含むsource cursor。現用frameとpresentation timestamp昇順の
// future queue（最大16枚）だけを所有し、target以下で最大のframeを選ぶ。
async function createVideoFrameCursor(clip) {
  const { track, samples, desc, rot } = await demux(clip.file);
  warnHdrTrackIfDetected(track);
  let baseCts = Infinity;
  for (const sample of samples) if (sample.cts < baseCts) baseCts = sample.cts;
  const timescale = samples[0]?.timescale || track.timescale;
  const baseUs = Math.round(baseCts * 1e6 / timescale);
  const decCfg = {
    codec: track.codec,
    codedWidth: track.video?.width || clip.w,
    codedHeight: track.video?.height || clip.h,
    optimizeForLatency: true,
  };
  if (desc) decCfg.description = desc;
  if (!(await VideoDecoder.isConfigSupported(decCfg)).supported) throw new Error('デコード不可: ' + track.codec);

  const MAX_FUTURE_FRAMES = 16;
  const PREFETCH_FUTURE_FRAMES = 8;
  let decoderError = null, sampleIndex = 0, current = null, lastRequestedUs = -Infinity, eosFlushed = false;
  let activeTargetUs = -Infinity, lastOutputSourceUs = -Infinity;
  let progressVersion = 0, maxDepth = 0, decodedFrames = 0, duplicateFrames = 0, staleFrames = 0;
  const future = [];
  const progressWaiters = new Set();
  const signalProgress = () => {
    progressVersion++;
    progressWaiters.forEach(resolve => resolve());
    progressWaiters.clear();
  };
  const closeSlot = slot => { if (slot?.frame) slot.frame.close(); };
  const closeOwnedFrames = () => {
    closeSlot(current); current = null;
    while (future.length) closeSlot(future.pop());
  };
  // 失敗の確定時、所有frame（current/future）はここで閉じない。
  // fillForTarget終了後に遅延出力からも呼ばれ得るため、描画に使用中の
  // currentを閉じるとuse-after-closeになる。解放は必ず通るshutdown()に任せる。
  const failQueue = (message, incoming) => {
    incoming?.close();
    decoderError ||= new Error(message);
    signalProgress();
  };
  const decoder = new VideoDecoder({
    output: frame => {
      decodedFrames++;
      if (decoderError) { frame.close(); signalProgress(); return; }
      const sourceUs = frame.timestamp - baseUs;
      // decoderはpresentation順に出力する契約。後戻りは黙って誤選択せず明示失敗にし、
      // 同一timestampの重複callbackだけを先着正本としてcloseする。
      if (sourceUs < lastOutputSourceUs) {
        failQueue('復号frameのpresentation timestampが後戻りしました', frame);
        return;
      }
      if (sourceUs === lastOutputSourceUs) {
        frame.close(); duplicateFrames++;
        signalProgress();
        return;
      }
      lastOutputSourceUs = sourceUs;
      // active target以下のframeはfuture queueへ積まず、その場で現用へ畳む。
      // （clip.startが深い素材で、先頭からの不要frameが上限16枚を食い潰すのを防ぐ。
      //   monotonic出力なので、queue内のより古いframeもここで不要になる）
      if (sourceUs <= activeTargetUs) {
        while (future.length && future[0].sourceUs < sourceUs) closeSlot(future.shift());
        closeSlot(current);
        current = { frame, sourceUs };
        signalProgress();
        return;
      }
      if (future.length >= MAX_FUTURE_FRAMES) {
        failQueue(`復号frame queueが上限${MAX_FUTURE_FRAMES}枚を超えました`, frame);
        return;
      }
      const slot = { frame, sourceUs };
      let lo = 0, hi = future.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (future[mid].sourceUs < sourceUs) lo = mid + 1; else hi = mid; }
      future.splice(lo, 0, slot);
      maxDepth = Math.max(maxDepth, future.length);
      signalProgress();
    },
    error: e => { decoderError ||= new Error('デコード: ' + (e?.message || e)); signalProgress(); },
  });
  try { decoder.configure(decCfg); }
  catch (e) { try { decoder.close(); } catch (closeError) { } throw e; }
  decoder.addEventListener('dequeue', signalProgress);

  const shutdown = () => {
    closeOwnedFrames();
    progressWaiters.forEach(resolve => resolve());
    progressWaiters.clear();
    try { if (decoder.state !== 'closed') decoder.close(); } catch (e) { }
    lastVideoDecoderStats = { maxDepth, decodedFrames, duplicateFrames, staleFrames, queueLimit: MAX_FUTURE_FRAMES, error: decoderError?.message || null };
  };
  const waitForProgress = version => {
    if (decoderError || progressVersion !== version) return Promise.resolve();
    return new Promise(resolve => progressWaiters.add(resolve));
  };
  // targetを覆う将来frameが得られるまでsampleを順にfeedし、EOSだけflushする。
  // callbackのburstはtimestamp順future queueへ保持する。
  const fillForTarget = async targetUs => {
    while ((future.length < PREFETCH_FUTURE_FRAMES || future[future.length - 1].sourceUs <= targetUs) && !decoderError) {
      if (sampleIndex < samples.length) {
        if (decoder.decodeQueueSize > 0) {
          const version = progressVersion;
          await waitForProgress(version);
          continue;
        }
        const s = samples[sampleIndex++];
        const version = progressVersion;
        decoder.decode(new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round(s.cts * 1e6 / s.timescale),
          duration: Math.round(s.duration * 1e6 / s.timescale),
          data: s.data,
        }));
        await waitForProgress(version);
        continue;
      }
      if (!eosFlushed) {
        eosFlushed = true;
        await decoder.flush();
        if (decoderError) throw decoderError;
      }
      break;
    }
    if (decoderError) throw decoderError;
  };

  return {
    rot,
    async frameAt(localSourceTime) {
      try {
        const targetUs = Math.round(localSourceTime * 1e6);
        if (targetUs + 1 < lastRequestedUs) throw new Error('動画source時刻が逆順です');
        lastRequestedUs = targetUs;
        activeTargetUs = targetUs;
        await fillForTarget(targetUs);
        while (future.length && future[0].sourceUs <= targetUs) {
          const slot = future.shift();
          // 出力中の畳み込みでcurrentが先へ進んでいる場合、より古いslotで戻さない
          if (!current || slot.sourceUs > current.sourceUs) { closeSlot(current); current = slot; }
          else closeSlot(slot);
        }
        // source先頭にCTS gapがある場合だけ最初のframeをholdする。
        if (!current && future.length) current = future.shift();
        if (!current) throw new Error('動画frameを復号できませんでした');
        return current.frame;
      } catch (e) {
        shutdown();
        throw e;
      }
    },
    stats: () => ({ maxDepth, depth: future.length, decodedFrames, duplicateFrames, staleFrames, queueLimit: MAX_FUTURE_FRAMES, error: decoderError?.message || null }),
    dispose: shutdown,
  };
}

// muxer出力をもう一度MP4として読み、video/audioの終端を同じ単位(µs)で検査する。
async function inspectMuxEnds(blob) {
  const buf = await blob.arrayBuffer();
  buf.fileStart = 0;
  const mp4 = MP4Box.createFile();
  const info = await new Promise((res, rej) => {
    mp4.onReady = res;
    mp4.onError = e => rej(new Error('書き出しMP4解析失敗: ' + e));
    mp4.appendBuffer(buf); mp4.flush();
  });
  const tracks = [...info.videoTracks.slice(0, 1), ...info.audioTracks.slice(0, 1)];
  const buckets = new Map(tracks.map(t => [t.id, []]));
  tracks.forEach(t => mp4.setExtractionOptions(t.id, null, { nbSamples: 1000000 }));
  mp4.onSamples = (id, u, batch) => {
    const bucket = buckets.get(id);
    if (bucket) for (const sample of batch) bucket.push(sample);
  };
  mp4.start();
  const started = performance.now();
  while (tracks.some(t => buckets.get(t.id).length < t.nb_samples) && performance.now() - started < 30000)
    await new Promise(res => setTimeout(res, 25));
  mp4.stop();
  if (tracks.some(t => buckets.get(t.id).length < t.nb_samples)) throw new Error('書き出しMP4のsample再読込がタイムアウトしました');
  const endUs = track => {
    const ss = buckets.get(track.id);
    if (!ss?.length) return null;
    let last = -Infinity;
    for (const s of ss) last = Math.max(last, s.cts + s.duration);
    return Math.round(last * 1e6 / (ss[0].timescale || track.timescale));
  };
  return { videoEndUs: info.videoTracks[0] ? endUs(info.videoTracks[0]) : null, audioEndUs: info.audioTracks[0] ? endUs(info.audioTracks[0]) : null };
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
  // 声・音楽はcadenceに触れず作品全体の連続PCMとして作る。丸めはvideo totalUsと
  // 同じ境界へ寄せ、最終AAC packetだけで長さが余らないようにする。
  const len = Math.round(total * sr);
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
    const vol = project.music.volume;
    const g = off.createGain();
    g.connect(off.destination);
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(vol, Math.min(1, total));
    // 【2026-08-16】フェードアウトの長さを「おわり」に合わせる。映像が白／黒へ沈むのと
    // 音が消えるのを揃える（従来は1.5秒固定で、おわりを長くしても音だけ先に消えていた）
    const fo = musicFadeOut();
    if (total > fo) { g.gain.setValueAtTime(vol, total - fo); g.gain.linearRampToValueAtTime(0, total); }
    // 【2026-08-16】曲が作品より短いと、以前は残りが**完全な無音**になっていた
    // （実測: 12秒の曲・27秒の作品で13秒以上が無音。警告も無し）。
    // 足りないぶんはくり返す。繋ぎ目は0.35秒のクロスフェードで、ぶつ切りにしない。
    // 曲のどこから鳴らすか。offset より前は使わない（再生側と必ず同じ計算にする）
    const off0 = musicOffset();
    const dur = Math.max(0.1, musicAudioBuf.duration - off0), XF = Math.min(0.35, dur / 4);
    const loop = project.music.loop !== false && dur < total - 0.05;
    if (!loop) {
      const s = off.createBufferSource();
      s.buffer = musicAudioBuf; s.connect(g);
      s.start(0, off0, Math.min(total, dur));
    } else {
      for (let at = 0; at < total; at += dur - XF) {
        const s = off.createBufferSource();
        s.buffer = musicAudioBuf;
        const fg = off.createGain(); s.connect(fg).connect(g);
        const len = Math.min(dur, total - at);
        fg.gain.setValueAtTime(at > 0 ? 0 : 1, at);
        if (at > 0) fg.gain.linearRampToValueAtTime(1, at + XF);          // 入りをなじませる
        if (at + len < total) {                                            // 出口は次の頭と重ねる
          fg.gain.setValueAtTime(1, Math.max(at + XF, at + len - XF));
          fg.gain.linearRampToValueAtTime(0, at + len);
        }
        s.start(at, off0, len);
      }
    }
    any = true;
  }
  if (!any) return null;
  return await off.startRendering();
}

let exporting = false, outVideoUrl = null;
async function exportVideo() {
  if (exporting || !project.clips.length) return;
  if (!getDurationState().isValid) { $('exportWarnings').textContent = durationErrorText(); return; }
  exporting = true;
  await ensureTextFonts();   // 読み込み前の字形で焼き込まないように
  // 読めていない書体があると、選んだ書体ではなく端末の既定書体で焼かれる。黙って進めない。
  const miss = missingTextFontLabels();
  if (miss.length) logErr('書体「' + miss.join('・') + '」を読み込めませんでした。ネットにつながっていないと、この書体では焼けません（端末の既定書体になります）');
  stopPlayback();
  const btn = $('runExport');
  btn.disabled = true;
  $('outVideo').style.display = 'none';
  $('saveRow').style.display = 'none';
  const prog = (t, r) => { $('exportProg').textContent = t; if (r != null) $('progFill').style.width = (r * 100).toFixed(0) + '%'; };
  let pipe = null, encoder = null, audioEncoder = null, cursor = null;
  try {
    const [outW, outH] = ASPECTS[project.aspect].out1080;
    const total = timelineDur();
    const totalUs = Math.round(total * 1e6);
    let ticks = Math.ceil(totalUs * 30 / 1e6);
    // 丸め境界（例: totalUs=66667でticks=3、最終outTs=66667）ではduration 0の
    // tickが生まれるため、最終tickのoutTsがtotalUs未満になるまでticksを減らす。
    while (ticks > 1 && Math.round((ticks - 1) * 1e6 / 30) >= totalUs) ticks--;
    if (!ticks || totalUs <= 0) throw new Error('書き出す時間がありません');
    const rec709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
    // 手ブレは全画面が動き続けるので、粒子と同じく圧縮が効きにくい
    const grainy = (project.adjust.effect > 0 && project.adjust.grain > 0.02) || (project.adjust.handheld || 0) > 0;
    const encCfg = {
      codec: Math.max(outW, outH) > 2000 ? 'avc1.640033' : 'avc1.640028',
      width: outW, height: outH,
      bitrate: Math.round((Math.max(outW, outH) > 2000 ? 40e6 : 14e6) * (grainy ? 1.7 : 1)),
      framerate: 30,
      colorSpace: rec709,
    };
    if (!(await VideoEncoder.isConfigSupported(encCfg)).supported) throw new Error('この解像度のエンコードに未対応の端末です');

    if (project.music) await ensureMusicBuffer();
    prog('音を準備中…', 0.02);
    const audioBuf = await buildAudioTrack(total);
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      // mp4-muxer側のtagは実装差があるため、まずWebCodecsへRec.709を明示して渡す。
      video: { codec: 'avc', width: outW, height: outH },
      ...(audioBuf ? { audio: { codec: 'aac', sampleRate: 44100, numberOfChannels: 2 } } : {}),
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    let encoderError = null, audioError = null;
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { encoderError ||= new Error('エンコード: ' + (e?.message || e)); },
    });
    encoder.configure(encCfg);

    const exCanvas = document.createElement('canvas');
    exCanvas.width = outW; exCanvas.height = outH;
    pipe = new GLPipe(exCanvas);
    applyLutSelection(pipe);

    let lastKeyUs = -1e9, activeClipIndex = -1;
    const pushFrame = async (timestamp, duration) => {
      if (duration <= 0) throw new Error('30fps output tickのdurationが不正です');
      if (encoderError) throw encoderError;
      const out = new VideoFrame(exCanvas, { timestamp, duration, colorSpace: rec709 });
      try {
        await whenQueueBelow(() => encoder.encodeQueueSize, encoder, 4);
        if (encoderError) throw encoderError;
        const key = timestamp - lastKeyUs >= 2e6;
        if (key) lastKeyUs = timestamp;
        encoder.encode(out, { keyFrame: key });
      } finally { out.close(); }
    };

    // N個すべてを30fps output tickとして渡す。16/18fpsはここでframeを捨てず、
    // renderAtTimelineTime内のclip-local sourceSampleLocalをholdするだけにする。
    for (let n = 0; n < ticks; n++) {
      const outTs = Math.round(n * 1e6 / 30);
      const nextTs = n + 1 < ticks ? Math.round((n + 1) * 1e6 / 30) : totalUs;
      const duration = nextTs - outTs;
      if (duration <= 0) throw new Error('output tickのtimestampが単調増加していません');
      const T = outTs / 1e6;
      const timing = getTimelineRenderTiming(T);
      if (!timing) throw new Error('output tickのclipを選べません');
      if (timing.clipIndex !== activeClipIndex) {
        cursor?.dispose();
        cursor = null;
        activeClipIndex = timing.clipIndex;
        if (timing.clip.kind === 'video') {
          prog((timing.clipIndex + 1) + '/' + project.clips.length + '本目を解析中…', 0.04 + 0.82 * (n / ticks));
          cursor = await createVideoFrameCursor(timing.clip);
        }
      }
      await renderAtTimelineTime(T, async t => {
        if (t.clip.kind === 'photo')
          return { source: t.clip.img, width: t.clip.w, height: t.clip.h };
        if (!cursor) throw new Error('動画frame cursorがありません');
        const frame = await cursor.frameAt(t.localSourceTime);
        return {
          source: frame,
          width: frame.displayWidth || frame.codedWidth || t.clip.w,
          height: frame.displayHeight || frame.codedHeight || t.clip.h,
          rot: cursor.rot,
        };
      }, { pipe });
      await pushFrame(outTs, duration);
      if (n % 15 === 0 || n === ticks - 1)
        prog((timing.clipIndex + 1) + '/' + project.clips.length + '本目を変換中…', Math.min(0.88, 0.04 + 0.84 * ((n + 1) / ticks)));
    }
    cursor?.dispose();
    cursor = null;
    await encoder.flush();
    if (encoderError) throw encoderError;
    encoder.close();

    if (audioBuf) {
      prog('音を書き込み中…', 0.90);
      const sr = 44100, alen = audioBuf.length;
      audioEncoder = new AudioEncoder({
        // AACエンコーダはpriming/padding分を入力末尾を超えたtimestampで排出する
        // （実測+93ms）。作品totalUs以降に始まるchunkは無音の詰め物なので書かず、
        // 音声終端を映像終端の1frame以内に保つ。
        output: (chunk, meta) => { if (chunk.timestamp < totalUs) muxer.addAudioChunk(chunk, meta); },
        error: e => { audioError ||= new Error('AAC: ' + (e?.message || e)); },
      });
      audioEncoder.configure({ codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: 2, bitrate: 160000 });
      const L = audioBuf.getChannelData(0);
      const R = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : L;
      const chunkFrames = 4410;
      for (let i = 0; i < alen; i += chunkFrames) {
        const count = Math.min(chunkFrames, alen - i);
        const data = new Float32Array(count * 2);
        data.set(L.subarray(i, i + count), 0);
        data.set(R.subarray(i, i + count), count);
        const audio = new AudioData({
          format: 'f32-planar', sampleRate: sr, numberOfFrames: count, numberOfChannels: 2,
          timestamp: Math.round(i * 1e6 / sr), data,
        });
        try {
          await whenQueueBelow(() => audioEncoder.encodeQueueSize, audioEncoder, 8);
          if (audioError) throw audioError;
          audioEncoder.encode(audio);
        } finally { audio.close(); }
      }
      await audioEncoder.flush();
      if (audioError) throw audioError;
      audioEncoder.close();
    }

    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    prog('終端を検査中…', 0.96);
    const ends = await inspectMuxEnds(blob);
    if (audioBuf) {
      if (ends.videoEndUs == null || ends.audioEndUs == null) throw new Error('書き出し後のvideo/audio終端を読めません');
      if (Math.abs(ends.videoEndUs - ends.audioEndUs) > 33334)
        throw new Error(`書き出し後の音声終端が映像からずれています (video=${ends.videoEndUs}us, audio=${ends.audioEndUs}us)`);
    }
    logErr('出力終端検査: video=' + ends.videoEndUs + 'us, audio=' + (ends.audioEndUs == null ? 'なし' : ends.audioEndUs + 'us'));
    logErr('色メタデータ: VideoEncoderへRec.709を指定（MP4 tagの実測は実ブラウザ検証待ち）');

    if (outVideoUrl) URL.revokeObjectURL(outVideoUrl);
    const url = outVideoUrl = URL.createObjectURL(blob);
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
    prog('完了！ ' + fmt(total) + '・' + outW + '×' + outH + '（' + (blob.size / 1e6).toFixed(1) + 'MB）', 1);
  } catch (e) {
    prog('失敗: ' + e.message, 0);
    logErr('書き出し: ' + e.message);
  } finally {
    cursor?.dispose();
    try { if (audioEncoder?.state !== 'closed') audioEncoder?.close(); } catch (e) { }
    try { if (encoder?.state !== 'closed') encoder?.close(); } catch (e) { }
    pipe?.dispose();
    btn.disabled = false;
    exporting = false;
  }
}
$('runExport').onclick = exportVideo;
$('goExportBtn').onclick = () => switchTab('export');
$('retrySaveBtn').onclick = () => { if (ready) saveState(); };

// ===== プリセット =====
function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  const historyBefore = project.id ? beginHistory() : null;
  const changesFrame = p.aspect && p.aspect !== project.aspect;
  const what = changesFrame ? '比率・見た目・音の設定' : '見た目・音の設定';
  if (project.clips.length && !confirm(`素材と並びは残ります。${what}を「${PRESET_LABELS[name]}」に変更しますか？`)) return false;
  // 収め方（contain/cover）は素材の向きに合わせて使うものなので、プリセットでは戻さない
  if (p.aspect) project.aspect = p.aspect;
  project.effectPreset = p.effect;
  project.adjust.effect = p.effect;
  project.adjust.letterbox = p.letterbox;
  if (p.effect === 2) applyFilmProfileRecommendations(p.filmProfile || 'home8');
  else {
    project.adjust.grain = FX[p.effect].gAmt / 400;
    project.adjust.grainSize = FX[p.effect].gSize / 100;
    project.adjust.glow = FX[p.effect].gGlow / 100;
    project.adjust.halation = FX[p.effect].gHal / 100;
    project.adjust.damage = 0;
  }
  // 「動き」もその作品らしい値で入る。理念＝完成イメージを選べば、あとは強弱だけで書き出せる。
  // 既存作品を開く経路（hydrateProject）は通らないので、勝手に揺れ始めることはない
  const motion = MOTION_RECOMMEND[name];
  if (motion) for (const k of MOTION_KEYS) project.adjust[k] = motion[k];
  // 完成イメージを選び直したら、境目の手動指定は白紙に戻す（前の世界観の指定が残ると混ざる）。
  // 語彙はeffectで切り替わるので、8mm用の「黒コマ」が青い記憶に残っていると解釈できない
  project.transOverrides = [];
  transPlanCache = null;
  project.muteAll = p.muteAll;
  project.autoAlign = p.autoAlign;
  project.impLen = p.impLen;
  const wantLut = p.lut;
  const has = wantLut === 'mine' ? project.mineLutData : wantLut === 'airu' ? project.airuLutData : wantLut === 'film8' ? project.film8LutData : true;
  project.lut = has ? wantLut : 'hikari';
  project.preset = has ? name : null;
  if (!has && !warnedLutFallbacks.has(name)) {
    warnedLutFallbacks.add(name);
    logErr(`${PRESET_LABELS[name]}の色設定を読み込めなかったため、ひかりの色で続けます`);
  }
  syncUIFromProject();
  redraw();
  scheduleSave();
  if (historyBefore) commitHistory(historyBefore);
  return true;
}
$('presetDiary').onclick = async () => { const made = creatingNewProject || !project.id ? await newProjectFromPreset('diary') : applyPreset('diary'); if (made !== false) { creatingNewProject = false; closePresetSheet(); } };
$('presetMv').onclick = async () => { const made = creatingNewProject || !project.id ? await newProjectFromPreset('mv') : applyPreset('mv'); if (made !== false) { creatingNewProject = false; closePresetSheet(); } };
$('presetFilm8').onclick = async () => { const made = creatingNewProject || !project.id ? await newProjectFromPreset('film8') : applyPreset('film8'); if (made !== false) { creatingNewProject = false; closePresetSheet(); } };
$('lookPresets').querySelectorAll('[data-preset]').forEach(btn => btn.onclick = () => {
  // 選んだらたたむ。次に変えたくなるまで場所を取らない
  if (applyPreset(btn.dataset.preset) !== false) { $('lookPresets').hidden = true; $('presetToggle').setAttribute('aria-expanded', 'false'); }
  syncPresetToggle();
});
$('presetContinue').onclick = () => { creatingNewProject = false; closePresetSheet(); };
$('openPresetBtn').onclick = () => { creatingNewProject = false; $('presetContinue').style.display = ''; $('presetSheet').classList.add('on'); };
function closePresetSheet() { creatingNewProject = false; $('presetSheet').classList.remove('on'); }
$('presetSheet').addEventListener('click', e => { if (e.target.id === 'presetSheet') closePresetSheet(); });

// ===== UI 配線 =====
// 同じタブをもう一度押すと閉じる（プレビューを広く使えるように）
function switchTab(name, forceOpen) {
  const cur = document.querySelector('.panel.on')?.id.replace('panel-', '');
  const close = !forceOpen && cur === name;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', !close && b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', !close && p.id === 'panel-' + name));
  if (!close && name === 'export') { updateDurationUI(); updateExportSummary(); }
  if (!close && name === 'text') {
    buildTextPanel(); syncTextPanel();
    // 文字タブを開いたときは**全書体**を確かめる。選ぶ前に「使えない書体」が分かるようにする
    void ensureTextFonts(true).then(() => { syncFontCards(); syncTextPanel(); redraw(); });
  }
  // 適用先（クリップ⇄作品全体）が変わっているかもしれないので、開くたびに描き直す
  if (!close && name === 'color') {
    if (activeTool === 'hsl') { buildHslChannels(); syncHslUI(); }
    if (activeTool === 'curve') renderCurve();
  }
}
// ナビとクリップ道具は委譲で受ける。中身が入れ替わるため、要素へ直接onclickを付けない。
document.addEventListener('click', e => {
  const b = e.target.closest('nav button, #clipTools button');
  if (!b) return;
  if (b.dataset.tab) { switchTab(b.dataset.tab); return; }
  const act = b.dataset.act;
  if (act === 'clipColor') { switchTab('clips', true); showClipSection('color'); }
  // HSL・カーブは選択状態でクリップに効く。見た目タブへ回らず、ここから直接開けるようにする
  else if (act === 'clipHsl') { switchTab('color', true); openTool('hsl'); }
  else if (act === 'clipCurve') { switchTab('color', true); openTool('curve'); }
  else if (act === 'clipOrder') { switchTab('clips', true); showClipSection('order'); }
  else if (act === 'clipMute') $('muteClipBtn').click();
  else if (act === 'clipDup') $('dupClip').click();
  else if (act === 'clipDel') $('delClip').click();
  else if (act === 'clipBack') deselectClip();
});
// クリップの道具はクリップのパネルの中に置く。
// 下部ナビを差し替える作りにしていたら、クリップを選んだ瞬間に文字・音楽が消えて
// 「タップできなくなった」と報告された。下部ナビはアプリの帰る場所なので、絶対に消さない。
function showClipSection(name) {
  $('clipColorSec').hidden = name !== 'color';
  $('clipOrderSec').hidden = name !== 'order';
  $('clipTools').querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', b.dataset.act === (name === 'color' ? 'clipColor' : 'clipOrder')));
}
function syncContextNav() {
  const on = !!selClip();
  // クリップを選んでいる間は、作品全体の設定を出さない（そのクリップの道具だけにする）。
  // ただし保存に失敗しているときは、再試行へたどり着けるよう残す
  $('importSettings').hidden = on;
  $('projectRow').hidden = on && !$('retrySaveBtn').classList.contains('on');
  if (on && $('clipColorSec').hidden && $('clipOrderSec').hidden) showClipSection('color');
}
// 取り込みの設定は最初の取り込みでだけ使うので、たたんでおく
$('importToggle').onclick = () => {
  const rows = $('importRows'), open = rows.hidden;
  rows.hidden = !open;
  $('importToggle').setAttribute('aria-expanded', String(open));
  $('importToggle').firstChild.textContent = open ? '取り込みの設定 ▴' : '取り込みの設定 ▾';
  syncImportBadge();
};
function syncImportBadge() {
  const len = { 0: '全部', 2: '2秒', 3: '3秒', 5: '5秒' }[project.impLen] ?? `${project.impLen}秒`;
  const fit = project.fit === 'cover' ? '画面いっぱい' : '切れないように';
  $('importToggle').querySelector('b').textContent = $('importRows').hidden ? `${len}・${fit}` : '';
}
function deselectClip() {
  if (!selId) return;
  selId = null;
  renderTimeline(); renderClipEdit(); syncContextNav();
  // HSL・カーブは「選択中クリップ or 作品全体」を毎回見る。適用先が変わったのに
  // 画面が古いままだと、次のひと触りが作品全体へ化けて値も飛ぶ
  if ($('panel-color').classList.contains('on')) {
    if (activeTool === 'hsl') { buildHslChannels(); syncHslUI(); }
    if (activeTool === 'curve') renderCurve();
  }
}

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
  scheduleSave();
};
function applyAspectToCanvas() {
  const a = ASPECTS[project.aspect];
  $('previewCanvas').width = a.prev[0];
  $('previewCanvas').height = a.prev[1];
}
// 【2026-08-17】いちばん最初に入れた素材で、作品の縦横を決める。
// 縦横は「プリセット」ではなく「その作品に入れる素材」が決めるもの（2026-08-14の決定）。
// たての動画を入れたのに16:9のままで帯になる、を毎回手で直していたのをやめる。
//
// **1本目のときだけ**にしてある。あとから足すたびに向きが変わると、帯を消すために手で選んだ
// 設定が壊れるため。気に入らなければ、いつもの選択メニューで変えられる。
function フレームを素材に合わせる(clip) {
  // 8mmは4:3であること自体が質感の一部（ユーザー決定）なので、素材に合わせない
  if (project.preset === 'film8') return;
  const w = clip && clip.w, h = clip && clip.h;
  if (!(w > 0 && h > 0)) return;
  const 素材 = w / h;
  let 近い = project.aspect, 差 = Infinity;
  for (const [key, a] of Object.entries(ASPECTS)) {
    const d = Math.abs(Math.log(a.prev[0] / a.prev[1] / 素材));   // 比は対数で比べる（縦横を対等に扱うため）
    if (d < 差) { 差 = d; 近い = key; }
  }
  if (近い === project.aspect) return;
  const 前 = project.aspect;
  project.aspect = 近い;
  $('aspectSel').value = 近い;
  applyAspectToCanvas();
  setProjectStatus(`素材に合わせて画面を ${近い} にしました（前は ${前}）`);
  diag('フレームを素材に合わせた', () => ({ 素材: w + '×' + h, 前, 後: 近い }));
}
$('fitSel').onchange = () => { project.fit = $('fitSel').value; syncImportBadge(); redraw(); scheduleSave(); };

$('presetSel').onchange = () => { project.impLen = parseFloat($('presetSel').value); syncImportBadge(); scheduleSave(); };
$('applyLenBtn').onclick = () => {
  const len = project.impLen;
  project.clips.forEach(c => {
    const max = c.kind === 'photo' ? PHOTO_MAX : c.dur;
    c.end = len > 0 ? clamp(c.start + len, c.start + 0.3, max) : max;
  });
  renderTimeline(); renderClipEdit();
  markDirty();
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
  uGlow: v => project.adjust.glow = v / 100,
  uHal: v => project.adjust.halation = v / 100,
  uDamage: v => project.adjust.damage = v / 100,
  uHandheld: v => project.adjust.handheld = v / 100,
  uLeak: v => project.adjust.leak = v / 100,
  uTrans: v => project.adjust.trans = v / 100,
  uJudder: v => project.adjust.judder = v / 100,
  uVig: v => project.adjust.vig = 1 + v / 100,   // 0でも1.0倍は残る（下限＝旧100の効き）
  uEndDur: v => project.adjust.endDur = v / 10,  // おわりの秒数（0〜5.0秒）
};
// 動きタブのカードに対応するフェーダー。ここに入れ忘れると、動かしてもカードの
// 入切・値バッジが更新されない（周辺減光とおわりが漏れていた）
const MOTION_SLIDERS = ['uHandheld', 'uLeak', 'uTrans', 'uJudder', 'uVig', 'uEndDur'];
// フェーダーの数字の見せ方。目盛の生値では意味が分からないものだけ書き換える
// （おわりは秒。ここを1か所にまとめないと、共通処理と個別処理で表示がずれる）
const SLIDER_FMT = {
  uEndDur: v => (v > 0 ? (v / 10).toFixed(1) + '秒' : 'なし'),
};
function sliderText(id, raw) { return SLIDER_FMT[id] ? SLIDER_FMT[id](parseFloat(raw)) : String(raw); }
for (const [id, fn] of Object.entries(sliderMap)) {
  const el = $(id);
  el.oninput = () => {
    fn(parseFloat(el.value));
    el.parentElement.querySelector('output').textContent = sliderText(id, el.value);
    // 0まで下げれば消える・上げれば点く。カードのトグルと値バッジをその場で合わせる
    if (MOTION_SLIDERS.includes(id)) syncMotionUI();
    syncChipBadges();
    redraw();
    scheduleSave();
  };
}
$('uLetterbox').onchange = () => { project.adjust.letterbox = $('uLetterbox').checked; redraw(); scheduleSave(); };
// 手ブレのON/OFF。ONにしたら、いま選んでいる完成イメージのおすすめ強さを入れる
// MV実測: 表情として効くショットは揺れRMS1〜2.3%。amt=1でRMS約2.2%になるスケールなので、
// 青い記憶は0.55（≒1.2%＝75〜90%点ショット相当）、8mmはさらに上、日常は控えめ

// 感光は出過ぎると嘘になる。8mmは実物の光漏れが強いので高め、日常は控えめ

// つなぎ: MV実測では境界の約25%に白ディゾルブ、焼けは162秒に1回。
// 強さ1で「境界の45%が白・10%が焼け」なので、0.6前後が実測に近い

// コマ落ち: MV実測は実効19fps＝judder 1.0。8mmはもともと16fpsなので効かない（表示も出さない）

// ===== 動きの作業面（v6）=====
// カードをタップするだけでON/OFF。ONなら実測由来の推奨値が入り、強さスライダーが下に出る。
// スイッチ＋チップの2段構成をやめ、1機能1UIにした（スイッチ4本で高さが飽和したため）
const MOTION_CARDS = [
  { key: 'handheld', slider: 'uHandheld' },
  { key: 'leak', slider: 'uLeak' },
  { key: 'trans', slider: 'uTrans' },
  { key: 'vig', slider: 'uVig' },
  { key: 'endDur', slider: 'uEndDur' },
  { key: 'judder', slider: 'uJudder' },
];
$('motionCards').addEventListener('click', e => {
  const card = e.target.closest('[data-motion]');
  if (!card || card.classList.contains('dis')) return;
  const c = MOTION_CARDS.find(x => x.key === card.dataset.motion);
  if (!c) return;
  // カード本体＝1タップで調整バーを出す。入切はトグルの担当。
  // 本体タップで入切もしていたら、既にONのものを触ると必ず一度消えてしまった（ユーザー指摘 2026-08-15）
  if (!e.target.closest('.tg')) {
    showSlider(c.slider);
    syncMotionUI();
    return;
  }
  const before = beginHistory();
  const on = !(project.adjust[c.key] > 0);
  // 周辺減光だけは「既定=1（世界観どおり）」で、他の動き系のような推奨値を持たない
  project.adjust[c.key] = on ? (c.key === 'vig' ? 4 : c.key === 'endDur' ? 1.5 : motionRecommend(c.key)) : 0;
  showSlider(c.slider);                    // 入れても切っても、そのエフェクトのバーを出したままにする
  syncMotionUI();
  commitHistory(before);
  redraw(); scheduleSave();
});
// つなぎの一括操作。自動配分は実測どおり境界の45%ほどにしか入らないので、
// 「全部に入れたい」に応える明示的な入口を置く（探して見つからない＝無いのと同じ）
$('transAll').onclick = () => {
  if (project.clips.length < 1) return;
  const before = beginHistory();
  const film = project.adjust.effect === 2;
  const seed = normalizeTextureSeed(project.textureSeed, project);
  // つなぎ自体がOFFなら入れる（ボタン1つで完結させる）
  if (!(project.adjust.trans > 0)) project.adjust.trans = motionRecommend('trans');
  // 埋める語彙は「巡回＋seedオフセット」で配る。独立ハッシュだと光が3連続するなど
  // 作り物感が出る（実測で確認）。全部に入れるときこそ、隣が同じにならないことが効く
  const pool = film ? ['flash', 'burn', 'black'] : ['flash', 'burn', 'scorch'];
  const off = Math.floor(textureSeedUnit(seed, 0, 0x2c1b3d5f) * pool.length);
  const list = [];
  let fillIdx = 0;
  for (let i = 1; i <= project.clips.length; i++) {   // 作品の最後の境目も含める
    const left = project.clips[i - 1];
    const prev = (project.transOverrides || []).find(x => x.leftClipId === left.id);
    const auto = transKindAt(i, project.adjust.trans, seed, film);
    let kind = prev && prev.kind !== 'none' ? (prev.kind || 'auto') : 'auto';
    if (auto === TK.NONE || (prev && prev.kind === 'none')) {
      // 巡回だけだと「白抜け→焼け→黒」の完全な周期になり、これはこれで作り物に見える。
      // seedで時々1つ飛ばして規則性を崩す（隣が同じにならない範囲で）
      if (textureSeedUnit(seed, i, 0x58a7c2e1) < 0.35) fillIdx++;
      kind = pool[(fillIdx + off) % pool.length];
      fillIdx++;
    }
    list.push({ leftClipId: left.id, kind, amp: prev?.amp ?? 1 });
  }
  // 隣り合う境界が同じ語彙になったら、次の候補へずらす。
  // 比較の前に必ず「数値のkind」へ揃える。文字列('flash')と数値(1)を混ぜて比べると
  // 一致が検出できず、光が2連続で残る（実際に残った）
  const resolve = (entry, bi) => entry.kind === 'auto'
    ? transKindAt(bi, project.adjust.trans, seed, film)
    : overrideKind(entry.kind, film);
  for (let i = 1; i < list.length; i++) {
    const prevKind = resolve(list[i - 1], i);
    let curKind = resolve(list[i], i + 1);
    if (prevKind !== curKind) continue;
    for (const cand of pool) {
      if (overrideKind(cand, film) !== prevKind) { list[i].kind = cand; curKind = overrideKind(cand, film); break; }
    }
  }
  project.transOverrides = list;
  transPlanCache = null;
  commitHistory(before);
  syncMotionUI(); renderTimeline(); markDirty(); redraw();
  logErr('すべての境目につなぎを入れました（↶で戻せます）');
};
// 【2026-08-16 追加】乱数の種を引き直す。境目ごとの方向（黄金角の初期角）・頂上の長さ・
// 単発か2回か・勾配・回復色・語彙の配分が、すべてこの種から決まっているので一度に変わる。
// 手で決めた境目（transOverrides）は残す＝「ここは光」と決めた指定を壊さない。
$('reseed').onclick = () => {
  const before = beginHistory();
  let next = (Math.random() * 0xffffffff) >>> 0;
  const cur = normalizeTextureSeed(project.textureSeed, project);
  if (next === cur || next === 0) next = (cur ^ 0x9e3779b1) >>> 0;
  project.textureSeed = next;
  transPlanCache = null;
  commitHistory(before);
  renderTimeline(); markDirty(); redraw(); scheduleSave();
  logErr('出方を引き直しました（↶で戻せます）');
};
$('transNone').onclick = () => {
  if (project.clips.length < 1) return;
  const before = beginHistory();
  // 作品の最後の境目は最後のクリップのidに紐づくので、slice せず全部を対象にする
  project.transOverrides = project.clips.map(c => ({ leftClipId: c.id, kind: 'none', amp: 1 }));
  transPlanCache = null;
  commitHistory(before);
  syncMotionUI(); renderTimeline(); markDirty(); redraw();
  logErr('すべての境目のつなぎを外しました（↶で戻せます）');
};
// カードの見た目（ON/OFF・値バッジ・8mmでの無効表示）をまとめる
function syncMotionUI() {
  const film = project.adjust.effect === 2;
  for (const c of MOTION_CARDS) {
    const card = $('motionCards').querySelector(`[data-motion="${c.key}"]`);
    if (!card) continue;
    const v = project.adjust[c.key] || 0;
    // 8mmは16fpsのcadenceが常時かかるのでコマ落ちは効かない。
    // 隠すと「消えた」と混乱するので、出したまま無効にして理由を書く（v5-16の「隠す」から変更）
    const dis = film && c.key === 'judder';
    card.classList.toggle('dis', dis);
    card.querySelectorAll('button').forEach(b => { b.disabled = dis; });
    card.querySelector('.ds').textContent = dis ? '8mmは元から16fps'
      : { handheld: '手持ちのゆれ', leak: '端からの光漏れ', trans: 'カットの光・焼け', judder: 'フィルムのカクつき', vig: '四すみの落ち', endDur: '最後の余韻' }[c.key];
    if (dis && v) { project.adjust[c.key] = 0; }
    const val = project.adjust[c.key] || 0;
    // 周辺減光だけは内部が倍率なので、フェーダーの目盛（0=1.0倍）に直して表示する
    const shown = c.key === 'vig' ? Math.max(0, Math.round((val - 1) * 100))
      : c.key === 'endDur' ? Math.round(val * 10)
        : Math.round(val * 100);
    card.classList.toggle('on', val > 0);
    card.classList.toggle('sel', activeSliderId === c.slider);
    card.querySelector('.nm').dataset.v = c.key === 'endDur' ? (val > 0 ? val.toFixed(1) + '秒' : '0') : shown;
    const el = $(c.slider);
    el.value = String(shown);
    el.parentElement.querySelector('output').textContent = sliderText(c.slider, el.value);
  }
  // 一括ボタンはつなぎがONのときだけ出す（OFFのときに押しても意味がない）
  // 【2026-08-16 整理】道具は「いま選んでいる項目」のものだけ出す。
  // 以前は一括ボタンも引き直しもおわりの色も常に並んでいて、画面からはみ出していた。
  const sel = MOTION_CARDS.find(c => c.slider === activeSliderId)?.key;
  $('transBulk').hidden = sel !== 'trans' || !((project.adjust.trans || 0) > 0) || project.clips.length < 1;
  $('endColorRow').hidden = sel !== 'endDur' || endingDur() <= 0;
  syncEndUI();
  syncChipBadges();
}

// ===== 見た目シート: チップ列＋スライダー1本（v4統合案）=====
// スライダーは <input type=range> のまま隠して持ち、選ばれた1本だけを見せる。
// こうすると既存の sliderMap・syncUIFromProject・汎用の履歴フックがそのまま効く。
const CHIP_LABELS = { mine: '自分の色', airu: '青い記憶', film8: '8mm', hikari: 'ひかり', none: 'なし', file: '自分のLUT' };
const FX_LABELS = ['なし', '滲み', '8mm'];
let activeSliderId = 'uStrength';
queueMicrotask(() => { openTool('lut'); syncPresetToggle(); });   // 起動時は「色」の作業面から始める

function showSlider(id) {
  activeSliderId = id;
  const target = $(id)?.closest('.row');
  $('sliderHost').querySelectorAll('.row').forEach(r => r.classList.toggle('on', r === target));
  document.querySelectorAll('#panel-color .chip[data-slider]')
    .forEach(c => c.classList.toggle('on', c.dataset.slider === id));
}
// 完成イメージは一度選べばしばらく触らないので、たたんでおく（プレビューの高さを優先）
$('presetToggle').onclick = () => {
  const row = $('lookPresets'), open = row.hidden;
  row.hidden = !open;
  $('presetToggle').setAttribute('aria-expanded', String(open));
  syncPresetToggle();
};
function syncPresetToggle() {
  const open = !$('lookPresets').hidden;
  $('presetToggle').firstChild.textContent = open ? '完成イメージ ▴' : '完成イメージ ▾';
  $('presetToggle').querySelector('b').textContent = open ? '' : (PRESET_LABELS[project.preset] || '手動');
}

// 道具を選ぶと作業面が入れ替わる（ドリルイン＋戻るは廃止＝1タップ減る）
const TOOL_SLIDER = { lut: 'uStrength', fx: null, motion: null, adjust: null, hsl: null, curve: null, align: null };
let activeTool = 'lut';
function openTool(name) {
  activeTool = TOOL_SLIDER.hasOwnProperty(name) ? name : 'lut';
  for (const k of Object.keys(TOOL_SLIDER)) $('work-' + k).hidden = k !== activeTool;
  // カーブ・HSLは精密に触る道具なので、完成イメージの行はしまって面積を譲る
  const editor = activeTool === 'curve' || activeTool === 'hsl';
  $('presetToggle').hidden = editor;
  if (editor) $('lookPresets').hidden = true;
  document.querySelectorAll('#colorTools .tool').forEach(b => b.classList.toggle('on', b.dataset.tool === activeTool));
  // スライダーはlut(=強さ)・fx・adjustの3つの作業面でだけ使う
  if (activeTool === 'lut') showSlider('uStrength');
  else if (activeTool === 'fx' || activeTool === 'adjust' || activeTool === 'motion') showSlider(sliderInWork(activeTool));
  else $('sliderHost').querySelectorAll('.row').forEach(r => r.classList.remove('on'));
  if (activeTool === 'hsl') { buildHslChannels(); syncHslUI(); }
  if (activeTool === 'curve') renderCurve();
  if (activeTool === 'fx' || activeTool === 'motion') syncMotionUI();
  if (activeTool === 'align') syncAlignReadout();
  syncChipBadges();
}
// 直前に選んでいたスライダーがその作業面に無ければ、先頭のチップへ戻す
function sliderInWork(name) {
  // 動きの作業面はチップではなくカード。ONのエフェクトのスライダーを出す（無ければ手ブレ）
  if (name === 'motion') {
    const on = MOTION_CARDS.find(c => (project.adjust[c.key] || 0) > 0);
    return on ? on.slider : 'uHandheld';
  }
  const scope = name === 'fx' ? '#fxParams' : '#adjustChips';
  const chips = [...document.querySelectorAll(`${scope} .chip[data-slider]`)]
    .filter(c => !c.closest('#filmDetail')?.hidden && !c.closest('#motionDetail')?.hidden
      && !c.closest('#leakDetail')?.hidden && !c.closest('#transDetail')?.hidden
      && !c.closest('#judderDetail')?.hidden);
  if (chips.some(c => c.dataset.slider === activeSliderId)) return activeSliderId;
  return chips[0]?.dataset.slider || 'uGlow';
}
// 自動そろえの内訳を出す。何がどれだけ効いているかが見えないと「効いていない」と誤解される
function syncAlignReadout() {
  const c = selClip() || lastDrawn;
  const ab = c?.autoBright || 0, at = c?.autoTemp || 0;
  const man = c ? (c.bright || 0) : 0;
  $('alignReadout').textContent = !c ? ''
    : !project.autoAlign ? '自動そろえはOFF。手動の値だけが効いています'
      : Math.abs(ab) < 0.03 && Math.abs(at) < 0.03 ? 'このクリップはほぼ補正不要でした'
        : `明るさ 手動 ${man >= 0 ? '+' : ''}${man.toFixed(2)} ＋ 自動 ${ab >= 0 ? '+' : ''}${ab.toFixed(2)} = ${(man + ab).toFixed(2)}EV`
          + ` ／ 色 自動 ${at >= 0 ? '+' : ''}${(at * 100).toFixed(0)}`;
}
// チップに現在値を出す。道具にはバッジを出さない（騒がしくなるため）
function syncChipBadges() {
  const set = (sel, text) => {
    const b = document.querySelector(sel)?.querySelector('b'); if (b) b.textContent = text ?? '';
  };
  document.querySelectorAll('#panel-color .chip[data-slider]').forEach(chip => {
    const el = $(chip.dataset.slider);
    if (!el || el.tagName !== 'INPUT') return;
    const b = chip.querySelector('b');
    if (b) b.textContent = Math.round(parseFloat(el.value));
  });
  const prof = document.querySelector('#fxParams [data-slider=filmProfileSel] b');
  if (prof) prof.textContent = { home8: 'ホーム', super8_reversal: 'リバーサル', super8_negative: 'ネガ' }[project.filmProfile] || '';
  if (activeTool === 'align') syncAlignReadout();
  if ($('panel-text').classList.contains('on')) syncTextPanel();
}
// ===== HSL・トーンカーブのUI（B3）=====
// 適用先はセグメントで選ばせず、選択状態で決める（状態を二重に持たない）
function corrTarget() { return selClip() || project.adjust; }
function corrTargetName() { return selClip() ? 'このクリップ' : '作品全体'; }
// 色を1つ選ぶと、その色の色相・彩度・明るさが同時に出る（軸を選び直す手数をなくす）
let hslCh = 'r';
const HSL_SLIDERS = { h: 'hslH', s: 'hslS', l: 'hslL' };

function buildHslChannels() {
  const box = $('hslChannels');
  if (box.children.length) return;
  for (const k of HSL_KEYS) {
    const b = document.createElement('button');
    b.dataset.ch = k; b.style.background = HSL_COLORS[k];
    b.setAttribute('aria-label', HSL_LABELS[k]);
    box.appendChild(b);
  }
  box.addEventListener('click', e => {
    const b = e.target.closest('button[data-ch]');
    if (b) { hslCh = b.dataset.ch; syncHslUI(); }
  });
  for (const [axis, id] of Object.entries(HSL_SLIDERS)) {
    $(id).oninput = () => {
      const t = corrTarget(), el = $(id), cur = hslOf(t);
      t.hsl = normalizeHsl({ ...cur, [hslCh]: { ...cur[hslCh], [axis]: parseInt(el.value, 10) } });
      el.parentElement.querySelector('output').textContent = el.value;
      syncHslUI(); markDirty(); redraw();
    };
  }
  $('hslResetCh').onclick = () => {
    const t = corrTarget(), before = beginHistory();
    t.hsl = normalizeHsl({ ...hslOf(t), [hslCh]: { h: 0, s: 0, l: 0 } });
    commitHistory(before); syncHslUI(); markDirty(); redraw();
  };
}
function syncHslUI() {
  const t = corrTarget(), v = hslOf(t), cur = v[hslCh] || {};
  $('hslTargetLabel').textContent = `HSL（${corrTargetName()}）`;
  $('hslLabelH').textContent = `${HSL_LABELS[hslCh]} の色相`;
  $('hslChannels').querySelectorAll('button').forEach(b => {
    const e = v[b.dataset.ch] || {};
    b.classList.toggle('on', b.dataset.ch === hslCh);
    b.classList.toggle('adj', !!(e.h || e.s || e.l));
  });
  for (const [axis, id] of Object.entries(HSL_SLIDERS)) {
    const el = $(id);
    el.value = String(cur[axis] || 0);
    el.parentElement.querySelector('output').textContent = el.value;
  }
  $('hslResetCh').disabled = !(cur.h || cur.s || cur.l);
}

// カーブ編集。SVG上の座標は 0..1（yは上が1）
// viewBox 300×230。置ける幅いっぱいに伸ばすので、実機では1目盛りが従来の倍以上になる
const CV = { padX: 16, padY: 16, w: 268, h: 198 };
let curveDrag = null;
function curveToSvg(p) { return [CV.padX + p[0] * CV.w, CV.padY + (1 - p[1]) * CV.h]; }
function svgToCurve(x, y) { return [clamp((x - CV.padX) / CV.w, 0, 1), clamp(1 - (y - CV.padY) / CV.h, 0, 1)]; }
function renderCurve() {
  const t = corrTarget(), pts = curveOf(t), svg = $('curveSvg');
  $('curveTargetLabel').textContent = `カーブ（${corrTargetName()}）`;
  const d = pts.map((p, i) => { const [x, y] = curveToSvg(p); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join(' ');
  const dots = pts.map((p, i) => { const [x, y] = curveToSvg(p);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="#fff" stroke="${i === 0 || i === pts.length - 1 ? '#fff' : 'var(--acc)'}" stroke-width="2" data-i="${i}"/>`; }).join('');
  const grid = [0.25, 0.5, 0.75].map(f =>
    `<line x1="${CV.padX + f * CV.w}" y1="${CV.padY}" x2="${CV.padX + f * CV.w}" y2="${CV.padY + CV.h}" stroke="#34343d"/>` +
    `<line x1="${CV.padX}" y1="${CV.padY + f * CV.h}" x2="${CV.padX + CV.w}" y2="${CV.padY + f * CV.h}" stroke="#34343d"/>`).join('');
  const guide = pts.length <= 2
    ? `<text x="${CV.padX + CV.w / 2}" y="${CV.padY + CV.h - 8}" fill="#5a5a63" font-size="11" text-anchor="middle">`
      + `タップで点を追加・枠の外へ出すと削除</text>` : '';
  svg.innerHTML = grid + guide +
    `<line x1="${CV.padX}" y1="${CV.padY + CV.h}" x2="${CV.padX + CV.w}" y2="${CV.padY}" stroke="#3a3a42" stroke-dasharray="3 3"/>` +
    `<path d="${d}" fill="none" stroke="var(--acc)" stroke-width="2.5" stroke-linejoin="round"/>` + dots + curveReadoutSvg();
}
function curvePointerPos(e) {
  const svg = $('curveSvg'), r = svg.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * 300, (e.clientY - r.top) / r.height * 230];
}
// 値はSVGの中に出す。パネルの外の文字を差し替えると行数が変わって画面全体が動く
function curveReadoutSvg() {
  if (curveDrag == null) return '';
  const p = curveOf(corrTarget())[curveDrag.idx];
  if (!p) return '';
  return `<text x="${CV.padX + 4}" y="${CV.padY + 14}" fill="var(--acc)" font-size="12">`
    + `入力 ${Math.round(p[0] * 100)}％ → 出力 ${Math.round(p[1] * 100)}％</text>`;
}
// ドラッグ中は毎回プレビューを描き直すと重くて画がばたつく。1フレームに1回へまとめる
let curveRedrawPending = false;
function curveRedraw() {
  if (curveRedrawPending) return;
  curveRedrawPending = true;
  requestAnimationFrame(() => { curveRedrawPending = false; redraw(); });
}
$('curveSvg').addEventListener('pointerdown', e => {
  const t = corrTarget(), pts = curveOf(t).map(p => [p[0], p[1]]);
  const [sx, sy] = curvePointerPos(e);
  let idx = pts.findIndex(p => { const [x, y] = curveToSvg(p); return Math.hypot(x - sx, y - sy) < 14; });
  const before = beginHistory();
  if (idx < 0) {
    if (pts.length >= 6) return;
    const np = svgToCurve(sx, sy);
    if (np[0] <= pts[0][0] || np[0] >= pts[pts.length - 1][0]) return;  // 端点の外には足さない
    pts.push(np); pts.sort((a, b) => a[0] - b[0]);
    idx = pts.findIndex(p => p === np);
  }
  t.curve = pts;
  // 指の動きより点をゆっくり動かす。画面の大きさには限りがあるので、感度側で細かくする
  curveDrag = { idx, before, edge: idx === 0 || idx === pts.length - 1,
    sx, sy, ox: pts[idx][0], oy: pts[idx][1] };
  try { $('curveSvg').setPointerCapture(e.pointerId); } catch (err) { }
  renderCurve(); markDirty(); curveRedraw();
});
const CURVE_GAIN = 0.45;
$('curveSvg').addEventListener('pointermove', e => {
  if (!curveDrag) return;
  const t = corrTarget(), pts = curveOf(t).map(p => [p[0], p[1]]);
  const [sx, sy] = curvePointerPos(e);
  const i = curveDrag.idx;
  const nx = curveDrag.ox + (sx - curveDrag.sx) / CV.w * CURVE_GAIN;
  const ny = curveDrag.oy - (sy - curveDrag.sy) / CV.h * CURVE_GAIN;
  // 端点はxを動かさない（0と1に固定）。中の点は隣を追い越さない
  pts[i] = curveDrag.edge
    ? [pts[i][0], clamp(ny, 0, 1)]
    : [clamp(nx, pts[i - 1][0] + 0.02, pts[i + 1][0] - 0.02), clamp(ny, 0, 1)];
  t.curve = pts;
  renderCurve(); markDirty(); curveRedraw();
});
const endCurveDrag = e => {
  if (!curveDrag) return;
  const t = corrTarget(), pts = curveOf(t).map(p => [p[0], p[1]]);
  // 枠の外で離したら、その点を消す（端点は消さない）
  if (!curveDrag.edge && e) {
    const [sx, sy] = curvePointerPos(e);
    if (sx < CV.padX - 12 || sx > CV.padX + CV.w + 12 || sy < CV.padY - 12 || sy > CV.padY + CV.h + 12) {
      pts.splice(curveDrag.idx, 1);
      t.curve = pts;
    }
  }
  commitHistory(curveDrag.before);
  curveDrag = null;
  renderCurve(); markDirty(); redraw();
};
$('curveSvg').addEventListener('pointerup', endCurveDrag);
$('curveSvg').addEventListener('pointercancel', endCurveDrag);
$('curveReset').onclick = () => {
  const t = corrTarget(), before = beginHistory();
  t.curve = defaultCurve();
  commitHistory(before); renderCurve(); markDirty(); redraw();
};

// ===== 横スクロールする行のタップを取りこぼさない =====
// 中身がはみ出している行では、指が数px動いただけでブラウザがスクロールと判断し、clickを出さないことがある。
// 動かずに離したのにclickが来なければ自分で出す。ただし出すのは「本当に来なかった」と確かめてから。
//
// 【この仕組みで2度事故を起こしている。触るときは必ず実機のログで確かめること】
//  1回目: clickはpointerupの「後」に来るのに、pointerupの先頭で状態を捨てていたため二重発火ガードが死んでいた
//  2回目: 待ち時間0で判定していたため、ネイティブclickが届く前に合成clickを出していた。
//         Macではclickが先に来るので気づかず、Fold7の実測ログで「押された」が毎回2回出ていて発覚（2026-08-15）。
//         二重発火はタブでは「開いて即閉じる＝無反応」に化け、overlayでは「閉じた下のボタンが押される」に化ける。
// 端末によってclickの遅れは数ms〜数十ms。CLICK_GRACE はその上限を見込んだ待ち時間。
const CLICK_GRACE = 350;
// タップとみなす指のブレ幅。10pxだと実機で「押したのに取消」が残った（2026-08-15のFold7ログ）。
// 端末のスクロール判定は8px前後で始まるので、それより少し広く取って救う
const TAP_SLOP = 18;
{
  // 指ごとに持つ。素早く2回押したときに1回目の判定が2回目に壊されるのを防ぐ
  const pending = new Map();
  const TARGETS = '.panel button, nav button, #devbar button, #presetSheetCard button, #projectSheetCard button, #textInputSheet button, #traceSheet button, label.sw';
  const nameOf = el => el.dataset.tab || el.id || el.querySelector?.('input')?.id || (el.textContent || '').trim().slice(0, 8);
  // スイッチはlabelなので、clickではなく中のcheckboxを切り替える
  const fire = el => {
    const box = el.matches('label.sw') ? el.querySelector('input[type=checkbox]') : null;
    if (box) { box.checked = !box.checked; box.dispatchEvent(new Event('change', { bubbles: true })); }
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest(TARGETS);
    if (el) pending.set(e.pointerId, { el, x: e.clientX, y: e.clientY, moved: 0, done: false });
  }, true);
  // 本物のclick / changeが来たら「もう効いた」印を付ける（合成しない合図）
  for (const type of ['click', 'change']) {
    document.addEventListener(type, e => {
      for (const t of pending.values()) if (t.el.contains(e.target)) t.done = true;
    }, true);
  }
  document.addEventListener('pointermove', e => {
    const t = pending.get(e.pointerId);
    if (t) t.moved = Math.max(t.moved, Math.hypot(e.clientX - t.x, e.clientY - t.y));
  }, true);
  // 指がほぼ動いていないのに取り消されたら、それはスクロールではなくタップ。
  // 実機ログに「触れた→取消」だけが残り、スイッチもチップも無反応になっていた（2026-08-15）
  const finish = (e, viaCancel) => {
    const t = pending.get(e.pointerId);
    if (!t) return;
    // 【2026-08-16 修正】pointercancel は clientX/clientY が **0 で来る**ことがある。
    // その座標で距離を測ると、画面右側を押しただけで「742px動いた」ことになり、
    // スクロールと誤判定してタップを捨てていた（実機ログ: 8mmチップとハレーションのバーが
    // 触れた→取消 動いたpx742/744 拾う0 で無反応）。押した位置は画面幅ぶんの誤差になる。
    // 取消のときは pointermove で積んだ実際の移動量だけを使う（本物のスクロールなら十分溜まる）。
    const evMoved = (!viaCancel && Number.isFinite(e.clientX))
      ? Math.hypot(e.clientX - t.x, e.clientY - t.y) : 0;
    const moved = Math.max(t.moved, evMoved);
    if (viaCancel) diag('取消の内訳', () => ({ 対象: nameOf(t.el), 動いたpx: Math.round(moved), 拾う: moved <= TAP_SLOP ? 1 : 0 }));
    if (t.el.disabled || moved > TAP_SLOP) { pending.delete(e.pointerId); return; }
    setTimeout(() => {
      pending.delete(e.pointerId);
      if (t.done || !t.el.isConnected) return;
      diag('補完', () => ({ 対象: nameOf(t.el), 取消から: viaCancel ? 1 : 0 }));
      fire(t.el);
    }, viaCancel ? 0 : CLICK_GRACE);
  };
  document.addEventListener('pointerup', e => finish(e, false), true);
  document.addEventListener('pointercancel', e => finish(e, true), true);
}

// ===== 文字パネル（B4）=====
const TEXT_COLORS = ['#fdf6e8', '#111111', '#d84f4f', '#d8894f', '#d8c44f', '#6fbf5f', '#4f7fd8', '#8f5fd8'];
let selTextId = null, activeTextSlider = 'txSize';
function selText() { return (project.texts || []).find(t => t.id === selTextId) || null; }
function textDurBounds(t) {
  if (t.anchor?.type !== 'clip') return [0.2, Math.max(0.2, timelineDur())];
  const c = project.clips.find(x => x.id === t.anchor.clipId);
  return [0.2, c ? clipLen(c) : 2];
}
function buildTextPanel() {
  if ($('textFonts').children.length) return;
  for (const [k, v] of Object.entries(TEXT_FONTS)) {
    const b = document.createElement('button');
    b.className = 'card'; b.dataset.font = k;
    b.innerHTML = `<span class="th" style="display:flex;align-items:center;justify-content:center;background:var(--card);font-size:20px">あА</span>`
      + `<span class="nm">${v.label}</span>`;
    b.querySelector('.th').style.font = v.css.replace('1em', '20px');
    b.dataset.family = v.family;
    $('textFonts').appendChild(b);
  }
  for (const c of TEXT_COLORS) {
    const b = document.createElement('button');
    b.dataset.color = c; b.style.background = c;
    b.style.border = c === '#111111' ? '2px solid #444' : '2px solid transparent';
    $('textColors').appendChild(b);
  }
  $('textFonts').addEventListener('click', e => {
    const b = e.target.closest('[data-font]'); if (!b) return;
    editText(t => { t.font = b.dataset.font; });
    // 初回はまだ書体が届いていないので、届いてから描き直す
    void ensureTextFonts().then(() => { syncTextPanel(); redraw(); });
  });
  $('textColors').addEventListener('click', e => {
    const b = e.target.closest('[data-color]'); if (!b) return;
    editText(t => { t.color = b.dataset.color; });
  });
}
// テキストの変更は必ずここを通す（1手として履歴・ラスタ破棄・再描画をまとめる）
function editText(fn) {
  const t = selText(); if (!t) return;
  const before = beginHistory();
  fn(t);
  project.texts = normalizeTexts(project.texts, project.clips);
  selTextId = project.texts.some(x => x.id === selTextId) ? selTextId : (project.texts[0]?.id || null);
  commitHistory(before);
  clearTextRaster(); syncTextPanel(); markDirty(); redraw();
}
function showTextSlider(id) {
  activeTextSlider = id;
  const target = $(id)?.closest('.row');
  $('textSliderHost').querySelectorAll('.row').forEach(r => r.classList.toggle('on', r === target));
  // 位置・時間は2本あるので、切り替えボタンを行の中に出す
  const pair = { txX: 'txY', txY: 'txX', txStart: 'txDur', txDur: 'txStart' }[id];
  const btn = $('swapSliderBtn');
  btn.hidden = !pair;
  if (pair) btn.dataset.to = pair;
}
// 読めていない書体のカードに印を出す。選ぶ前に分かるようにする（選んでから焼けないのは遅い）
function syncFontCards() {
  for (const b of $('textFonts').children) {
    const bad = textFontFailed.has(b.dataset.family);
    b.classList.toggle('dis', bad);
    const nm = b.querySelector('.nm');
    const base = nm.textContent.replace(/（使えません）$/, '');
    nm.textContent = bad ? base + '（使えません）' : base;
    b.title = bad ? 'この書体を読み込めませんでした（ネットにつながっていないと使えません）' : '';
  }
}
// 選んでいる文字の枠をプレビューの上に出す。
// 【2026-08-17 ユーザー要望】「触っても動かせない・どこにあるか分からない」。
// 掴める場所が見えないと、当たっているのか外しているのか区別がつかない。
// canvas には描かない（描くと書き出しに入ってしまう）ので、上に重ねたただの枠。
function syncTextFrame() {
  const el = $('textFrame'); if (!el) return;
  const t = selText(), cv = $('previewCanvas'), box = $('previewBox');
  const 文字タブ = $('panel-text')?.classList.contains('on');
  if (!t || !文字タブ || !project.clips.length) { el.classList.remove('on'); return; }
  // その文字が今の時刻に出ていなければ枠も出さない（見えないものの枠は迷わせるだけ）
  const span = textSpan(t, project.clips.map((_, i) => sumBefore(i)));
  if (!span || timelinePos < span[0] - 0.05 || timelinePos > span[1] + 0.05) { el.classList.remove('on'); return; }
  const r = cv.getBoundingClientRect(), br = box.getBoundingClientRect();
  if (!r.width || !r.height) { el.classList.remove('on'); return; }
  let hw = 0.25, hh = 0.06;
  try { const ras = rasterizeText(t, cv.width, cv.height); hw = ras.w / cv.width / 2; hh = ras.h / cv.height / 2; }
  catch (err) { }
  const left = (r.left - br.left) + (clamp(t.x, 0, 1) - hw) * r.width;
  const top = (r.top - br.top) + (clamp(t.y, 0, 1) - hh) * r.height;
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
  el.style.width = Math.round(hw * 2 * r.width) + 'px';
  el.style.height = Math.round(hh * 2 * r.height) + 'px';
  // 枠も文字と一緒に傾ける。傾いた文字にまっすぐな枠が付いていると、
  // 何を掴んでいるのか分からない（ユーザー報告 2026-08-17）
  el.style.transform = t.rot ? `rotate(${t.rot}deg)` : '';
  el.classList.add('on');
}
// 選んだ文字が見えるところへプレビューを送る。
// 選んでも画面に出ていないと「触れない」ので、まず見える状態を作る。
// フェードの途中だと薄いので、少しだけ中へ入った時刻にする。
function seekToText(t) {
  if (!t || !project.clips.length) return;
  const span = textSpan(t, project.clips.map((_, i) => sumBefore(i)));
  if (!span) return;
  // 「区間の中にいる」だけでは足りない。**入りのフェードの途中は透明で、文字が見えない**。
  // 追加した直後（時刻0・animIn 0.4秒）がまさにそれで、出したのに何も見えなかった。
  const 長さ = span[1] - span[0];
  const 見やすい = span[0] + Math.min(長さ * 0.35, Math.max(t.animIn ?? 0.4, 0.2));
  const 消えぎわ = span[1] - Math.min(長さ * 0.2, t.animOut ?? 0.4);
  if (timelinePos >= 見やすい - 0.02 && timelinePos <= 消えぎわ) return;   // もうはっきり見えている
  seekTimeline(clamp(見やすい, 0, Math.max(0, timelineDur() - 0.01)));
}
function syncTextPanel() {
  const list = project.texts || [], t = selText();
  // 一覧は実際の書体・色で描く。同じ見た目のチップだとどれがどれだか分からない
  $('textList').innerHTML = '';
  $('textListLabel').hidden = !list.length || !!selText();   // 編集中は見出しを畳んで道具に場所を譲る
  for (const x of list) {
    const b = document.createElement('button');
    b.className = 'tcard'; b.dataset.tid = x.id;
    b.textContent = (x.text || '').replace(/\n/g, ' ').slice(0, 8) || '（空）';
    b.style.font = (TEXT_FONTS[x.font]?.css || TEXT_FONTS.sans.css).replace('1em', '13px');
    b.style.color = x.color;
    b.classList.toggle('on', x.id === selTextId);
    $('textList').appendChild(b);
  }
  $('addTextBtn').disabled = list.length >= MAX_TEXTS;
  $('dateStampBtn').disabled = list.length >= MAX_TEXTS;
  $('textEdit').hidden = !t;
  // 下のヒントは文字を選ぶ前だけ。選んだあとは道具に場所を譲る
  $('textHint').hidden = !!t;
  $('textHint').textContent = !list.length
    ? 'クリップを選んでから追加すると、そのクリップに貼りつきます。' : '押して編集・長押しで削除。プレビューの文字は指で動かせます。';
  if (!t) return;
  $('textAnchorHint').textContent = t.anchor.type === 'clip'
    ? 'このクリップに貼りついています（トリムや並べ替えに付いていきます）' : '作品全体の時刻で出ます';
  $('textPreviewLine').textContent = (t.text || '').replace(/\n/g, ' ').slice(0, 24) || '（空）';
  $('textFonts').querySelectorAll('[data-font]').forEach(b => b.classList.toggle('on', b.dataset.font === t.font));
  $('textColors').querySelectorAll('[data-color]').forEach(b => b.classList.toggle('on', b.dataset.color === t.color));
  $('txBurnIn').checked = !!t.burnIn; $('txStroke').checked = !!t.stroke; $('txPlate').checked = !!t.plate;
  const [, maxDur] = textDurBounds(t);
  const vals = { txSize: Math.round(t.size * 1000), txX: Math.round(t.x * 100), txY: Math.round(t.y * 100),
    txStart: Math.round((t.anchor.type === 'clip' ? t.anchor.offset : t.anchor.start) * 10),
    txDur: Math.round((t.anchor.type === 'clip' ? t.anchor.dur : t.anchor.end - t.anchor.start) * 10) };
  $('txStart').max = String(Math.round(maxDur * 10));
  $('txDur').max = String(Math.round(maxDur * 10));
  for (const [id, v] of Object.entries(vals)) {
    const el = $(id); el.value = String(v);
    el.parentElement.querySelector('output').textContent =
      id === 'txSize' ? (v / 10).toFixed(1) + '%' : id === 'txStart' || id === 'txDur' ? (v / 10).toFixed(1) + '秒' : String(v);
  }
  syncTextFrame();
}
// 文字も見た目タブと同じ「道具＋作業面」。道具ごとに使うスライダーを決めておく
const TEXT_TOOL_SLIDER = { content: null, font: null, color: null, size: 'txSize', pos: 'txX', time: 'txStart', deco: null, del: null };
let activeTextTool = 'content';
function openTextTool(name) {
  activeTextTool = TEXT_TOOL_SLIDER.hasOwnProperty(name) ? name : 'content';
  for (const k of Object.keys(TEXT_TOOL_SLIDER)) $('twork-' + k).hidden = k !== activeTextTool;
  document.querySelectorAll('#textTools .tool').forEach(b => b.classList.toggle('on', b.dataset.ttool === activeTextTool));
  const sl = TEXT_TOOL_SLIDER[activeTextTool];
  if (sl) showTextSlider(activeTextSlider && sliderBelongsTo(activeTextSlider, activeTextTool) ? activeTextSlider : sl);
  else { $('textSliderHost').querySelectorAll('.row').forEach(r => r.classList.remove('on'));
    $('swapSliderBtn').hidden = true; }
  syncTextPanel();
}
// 位置はX/Y、時間ははじまり/長さの2本ずつ。道具の中で切り替えられるようにする
function sliderBelongsTo(id, tool) {
  return (tool === 'size' && id === 'txSize') || (tool === 'pos' && (id === 'txX' || id === 'txY'))
    || (tool === 'time' && (id === 'txStart' || id === 'txDur'));
}
$('panel-text').addEventListener('click', e => {
  const card = e.target.closest('#textList [data-tid]');
  if (card) { selTextId = card.dataset.tid; seekToText(selText()); syncTextPanel(); return; }
  const tool = e.target.closest('#textTools .tool');
  if (tool) { openTextTool(tool.dataset.ttool); return; }
  const row = e.target.closest('#textSliderHost .row label');
  if (row) return;
});
$('swapSliderBtn').onclick = () => { const to = $('swapSliderBtn').dataset.to; if (to) showTextSlider(to); };
// 一覧カードの長押しでその文字を消す（道具へ回らずに片付けられる）
{
  let holdT = 0, holdId = null, holdX = 0, holdY = 0, lastDelAt = 0;
  $('textList').addEventListener('pointerdown', e => {
    const c = e.target.closest('[data-tid]'); if (!c) return;
    // 消すと一覧が詰まり、指の下に次のカードが滑り込む。押しっぱなしのまま
    // 次々消えるのを防ぐため、削除直後は長押しを受け付けない（実機ログで連鎖の兆候が出た）
    if (performance.now() - lastDelAt < 700) return;
    holdId = c.dataset.tid;
    holdX = e.clientX; holdY = e.clientY;
    clearTimeout(holdT);
    holdT = setTimeout(() => {
      if (!holdId) return;
      const before = beginHistory();
      project.texts = (project.texts || []).filter(x => x.id !== holdId);
      if (selTextId === holdId) selTextId = project.texts[0]?.id || null;
      holdId = null;
      lastDelAt = performance.now();
      commitHistory(before); clearTextRaster(); syncTextPanel(); markDirty(); redraw();
      diag('文字を削除', () => ({ 残り: (project.texts || []).length }));
      logErr('文字を1つ消しました（↶で戻せます）');
    }, 550);
  });
  const cancel = () => { clearTimeout(holdT); holdId = null; };
  $('textList').addEventListener('pointerup', cancel);
  $('textList').addEventListener('pointercancel', cancel);
  // 実機の指は静止していても±1〜2pxのpointermoveが出続ける。moveで即キャンセルすると
  // タッチでは長押しがほぼ成立しない（検証で確認）。8pxを超えて動いたときだけやめる
  $('textList').addEventListener('pointermove', e => {
    if (holdId && Math.hypot(e.clientX - holdX, e.clientY - holdY) > 8) cancel();
  });
}
$('editTextBtn').onclick = () => openTextInput();
$('delTextBtn').onclick = () => {
  const before = beginHistory();
  project.texts = (project.texts || []).filter(x => x.id !== selTextId);
  selTextId = project.texts[0]?.id || null;
  commitHistory(before); clearTextRaster(); syncTextPanel(); markDirty(); redraw();
};
for (const [id, key] of [['txBurnIn', 'burnIn'], ['txStroke', 'stroke'], ['txPlate', 'plate']]) {
  $(id).onchange = () => { const t = selText(); if (!t) return; t[key] = $(id).checked ? 1 : 0;
    project.texts = normalizeTexts(project.texts, project.clips); clearTextRaster(); markDirty(); redraw(); };
}
for (const id of ['txSize', 'txX', 'txY', 'txStart', 'txDur']) {
  $(id).oninput = () => {
    const t = selText(); if (!t) return;
    const v = parseFloat($(id).value);
    if (id === 'txSize') t.size = v / 1000;
    else if (id === 'txX') t.x = v / 100;
    else if (id === 'txY') t.y = v / 100;
    else if (id === 'txStart') { if (t.anchor.type === 'clip') t.anchor.offset = v / 10; else { const d = t.anchor.end - t.anchor.start; t.anchor.start = v / 10; t.anchor.end = v / 10 + d; } }
    else if (id === 'txDur') { if (t.anchor.type === 'clip') t.anchor.dur = v / 10; else t.anchor.end = t.anchor.start + v / 10; }
    project.texts = normalizeTexts(project.texts, project.clips);
    clearTextRaster(); syncTextPanel(); markDirty(); redraw();
  };
}
$('addTextBtn').onclick = () => {
  if ((project.texts ||= []).length >= MAX_TEXTS) return;
  const before = beginHistory();
  const t = defaultText(selClip()?.id);
  if (t.anchor.type === 'clip') t.anchor.dur = Math.min(3, clipLen(selClip()) || 2);
  project.texts.push(t); selTextId = t.id;
  commitHistory(before); clearTextRaster(); seekToText(t); syncTextPanel(); markDirty(); redraw();
  openTextInput();
};
$('dateStampBtn').onclick = () => {
  if ((project.texts ||= []).length >= MAX_TEXTS) return;
  const before = beginHistory();
  const d = new Date();   // 押した瞬間の日付。描画へは渡さない
  // 実物のデートバック（フィルムカメラの日付写し込み）に寄せる:
  //  ・書式は「'YY MM DD」。年は2桁でアポストロフィ付き（京セラ/富士のクォーツデートの定番）
  //  ・色は露光で焼いたオレンジ。縁取りや影は付けない（光で焼くので影は出ない）
  //  ・大きさは画面の高さの約1/30。実測でだいたいこの比率
  //  ・位置は隅から一定の余白。縦位置はカメラを右へ倒して撮る前提なので左下が自然
  const two = n => String(n).padStart(2, '0');
  const portrait = ['9:16', '4:5'].includes(project.aspect);
  const t = {
    ...defaultText(selClip()?.id),
    text: `'${String(d.getFullYear()).slice(2)} ${two(d.getMonth() + 1)} ${two(d.getDate())}`,
    font: 'marker', size: 0.033, color: '#ff8c2a', x: portrait ? 0.24 : 0.76, y: 0.9,
    anim: 'none', shadow: 0, stroke: 0, plate: 0, opacity: 0.92, burnIn: true,
  };
  if (t.anchor.type === 'clip') t.anchor.dur = Math.min(3, clipLen(selClip()) || 2);
  project.texts.push(t); selTextId = t.id;
  commitHistory(before); clearTextRaster(); seekToText(t); syncTextPanel(); markDirty(); redraw();
};
// ===== プレビューに直に打つ =====
// 【2026-08-17 ユーザー要望】「文字を入力のバーで入力、書き直すなどを押す必要があるためUXが悪い。
// 直接プレビュー画面に文字が入るようにして入力バーを削除、入れてある文字をタップして再編集」
//
// 打っている間、その文字は canvas 側では描かない（入力欄と二重に見えるため）。
// 入力欄の見た目は文字に合わせてあるので、打った字がそのまま作品の見た目になる。
let editingTextId = null;
let 編集前スナップ = null;
function openTextInput() {
  const t = selText(); if (!t) return;
  const el = $('textInline');
  編集前スナップ = beginHistory();
  editingTextId = t.id;
  el.value = t.text || '';
  syncTextInline();
  el.classList.add('on');
  clearTextRaster(); redraw();
  requestAnimationFrame(() => { el.focus(); el.select(); });
}
// 入力欄を、いまの文字の位置・大きさ・書体・傾きに合わせる
function syncTextInline() {
  const el = $('textInline'), t = selText(), cv = $('previewCanvas'), box = $('previewBox');
  if (!el || !t || editingTextId !== t.id) return;
  const r = cv.getBoundingClientRect(), br = box.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const px = Math.max(8, t.size * r.height);
  el.style.font = (TEXT_FONTS[t.font]?.css || TEXT_FONTS.sans.css).replace('1em', px.toFixed(1) + 'px');
  el.style.lineHeight = (px * 1.35).toFixed(1) + 'px';    // 焼き込み側と同じ行送り
  el.style.color = t.color || '#fff';
  const 行 = String(el.value || '').split('\n').slice(0, 6);
  const 高 = Math.max(px * 1.35, 行.length * px * 1.35);
  const 幅 = Math.min(r.width, Math.max(px * 2, 測る幅(行, el.style.font) + px * 0.8));
  el.style.width = Math.round(幅) + 'px';
  el.style.height = Math.round(高) + 'px';
  el.style.left = Math.round((r.left - br.left) + t.x * r.width - 幅 / 2) + 'px';
  el.style.top = Math.round((r.top - br.top) + t.y * r.height - 高 / 2) + 'px';
  el.style.transform = t.rot ? `rotate(${t.rot}deg)` : '';
}
const 測り台 = document.createElement('canvas').getContext('2d');
function 測る幅(行, font) {
  測り台.font = font;
  return Math.max(1, ...行.map(l => 測り台.measureText(l).width));
}
function closeTextInput(捨てる) {
  const el = $('textInline');
  el.classList.remove('on');   // 状態より先に見た目を落とす（途中で抜けても入力欄が残らない）
  if (!editingTextId) return;
  const t = (project.texts || []).find(x => x.id === editingTextId);
  editingTextId = null;
  el.classList.remove('on'); el.blur();
  if (t && !捨てる) t.text = el.value;
  // 中身が空のまま閉じたら、その文字は消す（空の文字が残っても触れないだけ）
  if (t && !String(t.text || '').trim()) {
    project.texts = (project.texts || []).filter(x => x.id !== t.id);
    if (selTextId === t.id) selTextId = project.texts[0]?.id || null;
  }
  clearTextRaster(); syncTextPanel(); redraw();
  if (編集前スナップ != null) { commitHistory(編集前スナップ); 編集前スナップ = null; }
  markDirty();
}
$('textInline').addEventListener('input', () => {
  const t = selText(); if (!t || editingTextId !== t.id) return;
  t.text = $('textInline').value;
  syncTextInline(); clearTextRaster(); redraw();
});
$('textInline').addEventListener('blur', () => closeTextInput(false));
// 打っている最中に他の場所を触ったら確定する（「決定」を押させない）
document.addEventListener('pointerdown', e => {
  if (!editingTextId) return;
  // e.target は document になることがある（closest を持たない）ので、あるときだけ使う
  const el = e.target;
  if (el && typeof el.closest === 'function' && el.closest('#textInline')) return;
  closeTextInput(false);
}, true);

// スイッチはラベルを押して切り替わるので、汎用フックのfocusinが来ないことがある。
// 押した瞬間のスナップショットを自分で取り、changeで1手として積む。
{
  const pending = new WeakMap();
  document.addEventListener('pointerdown', e => {
    const sw = e.target.closest('.sw'); if (!sw) return;
    const box = sw.querySelector('input[type=checkbox]');
    if (box) pending.set(box, beginHistory());
  }, true);
  document.addEventListener('change', e => {
    const before = pending.get(e.target);
    if (before == null) return;
    pending.delete(e.target);
    setTimeout(() => commitHistory(before), 0);
  }, true);
}

// チップの二度押しで既定値へ戻す（1手として履歴に積む）
const CHIP_DEFAULTS = { uStrength: 85, uExposure: 0, uContrast: 0, uSaturation: 0, uFade: 0 };
let lastChipTap = { id: null, at: 0 };
$('panel-color').addEventListener('click', e => {
  const tool = e.target.closest('.tool[data-tool]');
  if (tool) { openTool(tool.dataset.tool); return; }
  const chip = e.target.closest('.chip[data-slider]');
  if (!chip || !$('panel-color').contains(chip)) return;
  const id = chip.dataset.slider, now = performance.now();
  const isDouble = lastChipTap.id === id && now - lastChipTap.at < 320 && id in CHIP_DEFAULTS;
  trace('chip.tap', () => ({ id, isDouble, dt: Math.round(now - lastChipTap.at), prev: lastChipTap.id }));
  lastChipTap = { id, at: now };
  showSlider(id);
  if (isDouble) {
    const el = $(id), before = beginHistory();
    el.value = String(CHIP_DEFAULTS[id]);
    el.dispatchEvent(new Event('input'));
    commitHistory(before);
    syncChipBadges();
  }
});
// タップがハンドラまで届いているかを実機で切り分けるための記録（?dev=1のときだけ動く）
$('autoAlignChk').closest('.sw').addEventListener('pointerdown', e => {
  trace('autoAlign.tap', () => ({ target: e.target.id || e.target.tagName, checked: $('autoAlignChk').checked }));
});
$('autoAlignChk').addEventListener('click', () => {
  trace('autoAlign.click', () => ({ checked: $('autoAlignChk').checked }));
});
$('autoAlignChk').onchange = () => {
  project.autoAlign = $('autoAlignChk').checked;
  syncAlignReadout();
  trace('autoAlign.change', () => {
    const c = selClip() || lastDrawn;
    return { checked: $('autoAlignChk').checked, autoAlign: project.autoAlign,
      autoBright: c ? +(c.autoBright || 0).toFixed(3) : null, bright: c ? +(c.bright || 0).toFixed(3) : null,
      effBright: c ? +clipBrightOf(c).toFixed(3) : null };
  });
  renderClipEdit(); redraw(); scheduleSave();
};
// ===== 波形の操作（v8-17）=====
// この2日で踏んだポインタの不具合3件を全部踏まえる:
//  ・touch-action:none（指が数px動くとスクロール扱いでタップが消える）
//  ・setPointerCapture（枠外で離してもリスナーが残らない）
//  ・移動量は pointermove の積算だけを見る（pointercancel の座標は0で来ることがある）
let waveDrag = null, wavePreviewSrc = null;
const WAVE_GAIN = 0.6;          // 指の動きより遅く動かす。長い曲でも秒単位で合わせられる
function setMusicOffset(sec, { save = false } = {}) {
  if (!project.music || !musicAudioBuf) return;
  project.music.offset = clamp(sec, 0, Math.max(0, musicAudioBuf.duration - 0.5));
  syncMusicHint(); drawMusicWave(); markDirty();
  if (save) scheduleSave();
}
// ドラッグ中はその位置から鳴らして確かめる（波形だけでは合っているか分からない）
function waveAudition(from) {
  stopWaveAudition();
  if (!musicAudioBuf) return;
  try {
    const ac = ensureAudioCtx();
    if (ac.state === 'suspended') ac.resume();
    const s = ac.createBufferSource(); s.buffer = musicAudioBuf;
    const g = ac.createGain(); s.connect(g).connect(ac.destination);
    const v = project.music?.volume ?? 0.7, now = ac.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(v, now + 0.03);       // 頭のプツッを消す
    g.gain.setValueAtTime(v, now + 1.2);
    g.gain.linearRampToValueAtTime(0, now + 1.5);
    s.start(now, clamp(from, 0, musicAudioBuf.duration - 0.05), 1.5);
    wavePreviewSrc = s;
  } catch (e) { /* 試聴はおまけなので、鳴らせなくても操作は続けられる */ }
}
function stopWaveAudition() { try { wavePreviewSrc?.stop(); } catch (e) { } wavePreviewSrc = null; }
$('musicWave').addEventListener('pointerdown', e => {
  if (!musicAudioBuf) return;
  const cv = $('musicWave'), r = cv.getBoundingClientRect(), dur = musicAudioBuf.duration;
  const handleX = (musicOffset() / dur) * r.width;
  const hit = Math.abs(e.clientX - r.left - handleX) <= 22;   // つまみは指で掴める幅を持たせる
  // つまみの外をタップ＝そこへ飛ぶ。つまみを掴んだ＝そこから相対で動かす
  if (!hit) setMusicOffset((e.clientX - r.left) / r.width * dur);
  waveDrag = { sx: e.clientX, base: musicOffset(), dur, w: r.width, moved: 0 };
  try { cv.setPointerCapture(e.pointerId); } catch (err) { }
  // 【2026-08-16 修正】前版は再生中に触ると stopPlayback() で止めていたが、
  // 実機では「再生しながら位置を直す」ほうが自然で、止まると探し直しになる（ユーザー報告）。
  // 再生中は試聴を鳴らさず、**鳴っている音楽そのものを新しい位置で鳴らし直す**。
  if (playing) { stopMusic(); startMusic(timelinePos); }
  else waveAudition(musicOffset());
});
$('musicWave').addEventListener('pointermove', e => {
  if (!waveDrag) return;
  const dx = e.clientX - waveDrag.sx;
  waveDrag.moved = Math.max(waveDrag.moved, Math.abs(dx));
  setMusicOffset(waveDrag.base + dx / waveDrag.w * waveDrag.dur * WAVE_GAIN);
  // 再生中は動かしたぶんだけ鳴らし直す。毎フレームやると音が途切れ続けるので120msに1回
  if (playing) {
    const now = performance.now();
    if (now - (waveDrag.lastPlay || 0) > 120) { waveDrag.lastPlay = now; stopMusic(); startMusic(timelinePos); }
  }
});
for (const type of ['pointerup', 'pointercancel']) {
  $('musicWave').addEventListener(type, () => {
    if (!waveDrag) return;
    const moved = waveDrag.moved;
    waveDrag = null;
    // 再生中は鳴っている音楽を最終位置で鳴らし直す。止まっているときだけ試聴する
    if (playing) { stopMusic(); startMusic(timelinePos); }
    else if (moved > 2) waveAudition(musicOffset());
    scheduleSave();
  });
}
// 曲のどこから鳴らすか。目盛は0.1秒刻みで、曲の長さに合わせて上限を変える
$('musicOffset').oninput = () => {
  if (!project.music || !musicAudioBuf) return;
  project.music.offset = parseInt($('musicOffset').value, 10) / 10;
  $('musicOffset').parentElement.querySelector('output').textContent = fmt(musicOffset());
  syncMusicHint(); drawMusicWave(); markDirty();
};
$('musicOffset').onchange = () => { stopMusic(); if (playing) startMusic(timelinePos); else waveAudition(musicOffset()); scheduleSave(); };
// 曲が短いときにくり返すか。既定は「くり返す」（無音のまま気づかず書き出すのを防ぐ）
$('musicLoopChk').onchange = () => {
  const before = beginHistory();
  project.music && (project.music.loop = $('musicLoopChk').checked);
  commitHistory(before); syncMusicHint(); markDirty(); scheduleSave();
};
// 曲と作品の長さを見せる。短ければその場で分かるようにする
function syncMusicHint() {
  const el = $('musicLenHint'); if (!el) return;
  const total = timelineDur();
  const row = $('musicOffsetRow');
  row.hidden = !project.music || !musicAudioBuf;
  $('musicWaveWrap').hidden = row.hidden;
  if (!row.hidden) drawMusicWave();
  if (!project.music || !musicAudioBuf) { el.textContent = '曲は自動でフェードイン・アウトします。'; return; }
  // 開始位置の上限は「曲の長さ − 0.5秒」。曲を差し替えても目盛が壊れないよう毎回入れ直す
  const sl = $('musicOffset');
  sl.max = String(Math.max(0, Math.round((musicAudioBuf.duration - 0.5) * 10)));
  sl.value = String(Math.round(musicOffset() * 10));
  sl.parentElement.querySelector('output').textContent = fmt(musicOffset());
  // 使えるのは開始位置から曲尻まで
  const d = Math.max(0.1, musicAudioBuf.duration - musicOffset());
  const fmtS = x => (x >= 60 ? Math.floor(x / 60) + '分' + Math.round(x % 60) + '秒' : x.toFixed(1) + '秒');
  const from = musicOffset() > 0.05 ? '（' + fmt(musicOffset()) + 'から）' : '';
  if (d >= total - 0.05) { el.textContent = '使える曲 ' + fmtS(d) + from + '／作品 ' + fmtS(total) + '。足ります。'; return; }
  el.textContent = project.music.loop !== false
    ? '使える曲 ' + fmtS(d) + from + '／作品 ' + fmtS(total) + '。足りないぶんはくり返します。'
    : '使える曲 ' + fmtS(d) + from + '／作品 ' + fmtS(total) + '。⚠ 残り ' + fmtS(total - d) + ' が無音になります。';
}
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
    if (chip.dataset.lut === 'film8' && !project.film8LutData) return;
    project.lut = chip.dataset.lut;
    document.querySelectorAll('#lutChips .chip').forEach(c => c.classList.toggle('on', c === chip));
    applyLutSelection(preview);
    redraw();
    scheduleSave();
  };
});
$('lutFileInput').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  const historyBefore = beginHistory();
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
    scheduleSave();
    commitHistory(historyBefore);
  } catch (err) { alert(err.message); }
  e.target.value = '';
};

document.querySelectorAll('#fxChips .chip').forEach(chip => {
  chip.onclick = () => {
    project.adjust.effect = parseInt(chip.dataset.fx);
    document.querySelectorAll('#fxChips .chip').forEach(c => c.classList.toggle('on', c === chip));
    // 質感を選ぶと、粒子・滲み・ハレーションがそのモードの推奨値に自動設定される（あとから手動調整可）
    if (project.adjust.effect === 2) applyFilmProfileRecommendations(project.filmProfile);
    const fx = textureFx();
    for (const [id, val, apply] of [
      ['uGrain', project.adjust.effect === 2 ? currentFilmProfile().grain : fx.gAmt, v => project.adjust.grain = v / 400],
      ['uGrainSize', project.adjust.effect === 2 ? currentFilmProfile().grainSize : fx.gSize, v => project.adjust.grainSize = v / 100],
      ['uGlow', project.adjust.effect === 2 ? currentFilmProfile().glow : fx.gGlow, v => project.adjust.glow = v / 100],
      ['uHal', project.adjust.effect === 2 ? Math.round(currentFilmProfile().halation * 100) : fx.gHal, v => project.adjust.halation = v / 100],
      ['uDamage', Math.round((project.adjust.effect === 2 ? currentFilmProfile().damage : 0) * 100), v => project.adjust.damage = v / 100],
    ]) {
      $(id).value = val;
      apply(val);
      $(id).parentElement.querySelector('output').textContent = val;
    }
    updateFilmDetailUI();
    redraw();
    scheduleSave();
  };
});

function updateFilmDetailUI() {
  const visible = project.adjust.effect === 2;
  $('filmDetail').hidden = !visible;
  // 8mm専用チップが消えたのに、そのスライダーが出たままにならないようにする
  if (!visible && (activeSliderId === 'uDamage' || activeSliderId === 'filmProfileSel') && activeTool === 'fx')
    showSlider('uGlow');
  syncChipBadges();
  if (visible) {
    $('filmProfileSel').value = project.filmProfile;
    $('filmProfileHint').textContent = `${currentFilmProfile().label}の推奨値です。粒子・滲み・ハレーションはこのあと手動で変えられます。`;
  }
}
$('filmProfileSel').onchange = () => {
  // profile変更は1手としてUndo/Redoへ積む（設計書§4）
  const before = beginHistory();
  applyFilmProfileRecommendations($('filmProfileSel').value);
  syncUIFromProject();
  redraw();
  scheduleSave();
  commitHistory(before);
};

// damage sliderは1 gesture（押してから離すまで／キー1回）を1手として履歴へ積む
{
  const damageEl = $('uDamage');
  let damageBefore = null;
  const captureDamage = () => { damageBefore ??= beginHistory(); };
  damageEl.addEventListener('pointerdown', captureDamage);
  damageEl.addEventListener('keydown', captureDamage);
  damageEl.addEventListener('change', () => {
    if (damageBefore != null) { commitHistory(damageBefore); damageBefore = null; }
  });
}

$('musicBtn').onclick = () => $('musicFileInput').click();
$('musicFileInput').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  const ab = await f.arrayBuffer();
  const before = beginHistory();
  project.music = { name: f.name, assetId: newId(), arrayBuffer: ab, volume: parseFloat($('musicVol').value) / 100 };
  musicAudioBuf = null;
  $('musicName').textContent = f.name;
  pendingFileWrites.set(project.music.assetId, new Blob([ab], { type: f.type || 'audio/*' }));
  recalculateAssetBytes();
  await ensureMusicBuffer().catch(() => { });
  renderTimeline();
  scheduleSave();
  commitHistory(before);
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
  syncContextNav();
  if (!c) return;
  const i = project.clips.indexOf(c);
  $('clipTitleLabel').textContent = `${c.kind === 'photo' ? '写真' : 'クリップ'} ${i + 1}（${clipLen(c).toFixed(1)}秒）`;
  $('clipBright').value = Math.round(c.bright * 100);
  $('clipBright').parentElement.querySelector('output').textContent = Math.round(c.bright * 100);
  $('clipTemp').value = Math.round(c.temp * 100);
  $('clipTemp').parentElement.querySelector('output').textContent = Math.round(c.temp * 100);
  $('clipFxScale').value = Math.round(clipFxScaleOf(c) * 100);
  $('clipFxScale').parentElement.querySelector('output').textContent = Math.round(clipFxScaleOf(c) * 100);
  $('clipHighKey').value = String(Math.round(clipHighKeyOf(c) * 100));
  $('clipHighKey').parentElement.querySelector('output').textContent = Math.round(clipHighKeyOf(c) * 100);
  syncClipChips();
  showClipSlider(activeClipSliderId);
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
  markDirty();
};
$('clipTemp').oninput = () => {
  const c = selClip(); if (!c) return;
  c.temp = parseFloat($('clipTemp').value) / 100;
  $('clipTemp').parentElement.querySelector('output').textContent = $('clipTemp').value;
  redraw();
  markDirty();
};
$('clipHighKey').oninput = () => {
  const c = selClip(); if (!c) return;
  c.highKey = parseFloat($('clipHighKey').value) / 100;
  $('clipHighKey').parentElement.querySelector('output').textContent = $('clipHighKey').value;
  syncClipChips();
  redraw();
  markDirty();
};
$('clipFxScale').oninput = () => {
  const c = selClip(); if (!c) return;
  c.fxScale = parseFloat($('clipFxScale').value) / 100;
  $('clipFxScale').parentElement.querySelector('output').textContent = $('clipFxScale').value;
  syncClipChips();
  redraw();
  markDirty();
};
// クリップシートも見た目シートと同じ「チップ列＋スライダー1本」で操作する
let activeClipSliderId = 'clipBright';
function showClipSlider(id) {
  activeClipSliderId = id;
  const target = $(id)?.closest('.row');
  $('clipSliderHost').querySelectorAll('.row').forEach(r => r.classList.toggle('on', r === target));
  document.querySelectorAll('#clipChips .chip').forEach(c => c.classList.toggle('on', c.dataset.slider === id));
}
function syncClipChips() {
  const c = selClip(); if (!c) return;
  const set = (id, v) => { const b = document.querySelector(`#clipChips [data-slider=${id}] b`); if (b) b.textContent = v; };
  set('clipBright', String(Math.round((c.bright || 0) * 100)));
  set('clipTemp', String(Math.round((c.temp || 0) * 100)));
  set('clipFxScale', `${Math.round(clipFxScaleOf(c) * 100)}%`);
  set('clipHighKey', `${Math.round(clipHighKeyOf(c) * 100)}%`);
  set('clipFit', c.fit === 'cover' ? 'いっぱい' : c.fit === 'contain' ? '切れない' : '作品と同じ');
  document.querySelectorAll('#clipFit .btn').forEach(b => b.classList.toggle('on', (b.dataset.fit || '') === (c.fit || '')));
}
// このクリップだけの収め方。空＝作品ぜんぶの設定に従う
$('clipFit').addEventListener('click', e => {
  const b = e.target.closest('.btn'); if (!b) return;
  const c = selClip(); if (!c) return;
  const before = beginHistory();
  const v = b.dataset.fit || '';
  if (v) c.fit = v; else delete c.fit;
  // タイムラインの小さなサムネは常に中央切り出しなので、ここでは作り直さない
  syncClipChips(); redraw();
  commitHistory(before); markDirty();
});
$('clipChips').addEventListener('click', e => {
  const chip = e.target.closest('.chip[data-slider]');
  if (chip) showClipSlider(chip.dataset.slider);
});
function moveClip(d) {
  const i = project.clips.findIndex(c => c.id === selId);
  if (i < 0 || i + d < 0 || i + d >= project.clips.length) return;
  const [c] = project.clips.splice(i, 1);
  project.clips.splice(i + d, 0, c);
  renderTimeline(); renderClipEdit();
  markDirty();
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
  const before = beginHistory();
  const i = project.clips.indexOf(c);
  try {
    const copy = await createClip(c.file, {
      kind: c.kind, name: c.name, start: c.start, end: c.end, thumb: c.thumb,
      bright: c.bright, temp: c.temp, fxScale: c.fxScale, highKey: c.highKey, hsl: c.hsl, curve: c.curve,
      fit: c.fit, autoBright: c.autoBright, autoTemp: c.autoTemp, muted: c.muted,
    });
    project.clips.splice(i + 1, 0, copy);
    // 複製は素材を共有し、clipIdだけを新規発行する。
    copy.assetId = c.assetId;
    selId = copy.id;
    renderTimeline(); renderClipEdit();
    markDirty();
    seekTimeline(sumBefore(i + 1));
    commitHistory(before);
  } catch (e) { logErr(e.message); }
};
$('delClip').onclick = () => {
  const i = project.clips.findIndex(c => c.id === selId);
  if (i < 0) return;
  const removed = project.clips[i];
  URL.revokeObjectURL(removed.url);
  // files.delete は参照走査後だけ。Undo/他プロジェクトの素材を先に消さない。
  project.clips.splice(i, 1);
  recalculateAssetBytes();
  selId = project.clips[Math.min(i, project.clips.length - 1)]?.id || null;
  if (playIdx >= project.clips.length) playIdx = Math.max(0, project.clips.length - 1);
  renderTimeline(); renderClipEdit();
  markDirty();
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

// 「新しく始める」は作品を消さず、作品シートから「内容を空にする」を選ぶ。

// ===== 開発モード（?dev=1）=====
if (new URLSearchParams(location.search).has('dev')) {
  $('devToggle').classList.add('shown');
  $('devToggle').onclick = () => {
    const open = $('devbar').classList.toggle('on');
    $('devToggle').textContent = open ? 'dev ▴' : 'dev ▾';
  };
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
    project.music = { name: 'サンプル音楽', assetId: newId(), audioBuffer: buf, volume: 0.7 };
    musicAudioBuf = buf;
    $('musicName').textContent = 'サンプル音楽';
    renderTimeline();
    markDirty();
  };
  const textureDebug = (pipe = preview, t = timelinePos) => {
    const timing = getTimelineRenderTiming(t);
    return {
      seed: normalizeTextureSeed(project.textureSeed, project),
      filmProfile: project.filmProfile,
      qualityPath: pipe.qualityPath,
      floatExtension: !!pipe.gl.getExtension('EXT_color_buffer_float'),
      fboFormat: pipe._intermediate?.kind || pipe.qualityPath,
      filmFrame: timing?.filmFrame ?? null,
      effectTime: timing?.effectTime ?? null,
      decoderStats: lastVideoDecoderStats,
    };
  };
  const makeTextureFixture = (kind = 'chart', width = 720, height = 540) => {
    const cv = document.createElement('canvas');
    cv.width = Math.max(64, Math.round(Number.isFinite(width) ? width : 720));
    cv.height = Math.max(64, Math.round(Number.isFinite(height) ? height : 540));
    const x = cv.getContext('2d'), w = cv.width, h = cv.height;
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    if (kind === 'black') return cv;
    if (kind === 'point') {
      x.fillStyle = '#fff'; x.fillRect(Math.floor(w / 2) - 2, Math.floor(h / 2) - 2, 5, 5);
      return cv;
    }
    if (kind === 'damage') {
      const g = x.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#050505'); g.addColorStop(0.5, '#777'); g.addColorStop(1, '#f4f4f4');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      return cv;
    }
    const colors = ['#000', '#242424', '#777', '#fff', '#f33', '#3f3', '#36f', '#ff3', '#3ff', '#f3f'];
    const cellW = w / 5, cellH = h / 2;
    colors.forEach((color, i) => { x.fillStyle = color; x.fillRect((i % 5) * cellW, Math.floor(i / 5) * cellH, cellW + 1, cellH + 1); });
    x.fillStyle = '#f2b38e'; x.fillRect(w * 0.40, h * 0.25, w * 0.20, h * 0.50);
    return cv;
  };
  window._dbg = () => ({
    playing, playIdx, timelinePos: +timelinePos.toFixed(2), total: +timelineDur().toFixed(2),
    endingRun: !!endingRun, endingDur: endingDur(), advancing,
    lut: project.lut, fx: project.adjust.effect, muteAll: project.muteAll, autoAlign: project.autoAlign,
    hsl: project.adjust.hsl, curve: project.adjust.curve,
    decoderStats: lastVideoDecoderStats,
    blocks: document.querySelectorAll('.clipBlock').length,
    clips: project.clips.map(c => ({
      kind: c.kind, start: +c.start.toFixed(2), end: +c.end.toFixed(2), muted: !!c.muted,
      fxScale: +clipFxScaleOf(c).toFixed(2), highKey: +clipHighKeyOf(c).toFixed(2), hsl: c.hsl, curve: c.curve,
      autoBright: +(c.autoBright || 0).toFixed(2), autoTemp: +(c.autoTemp || 0).toFixed(2),
    })),
  });
  Object.defineProperty(window._dbg, 'texture', { configurable: true, get: () => textureDebug() });
  // 診断リングバッファの読み出し。引数なしで全件、tagを渡すと絞り込み。clear()で消す。
  // 補正の検証用。作品全体／クリップのHSL・カーブを直接書き換える
  window._dbg.setCorr = (target, patch) => {
    const t = target === 'clip' ? selClip() : project.adjust;
    if (!t) throw new Error('クリップが選ばれていません');
    if (patch.hsl) { t.hsl = normalizeHsl({ ...(t.hsl || defaultHsl()), ...patch.hsl }); }
    if (patch.curve) t.curve = normalizeCurve(patch.curve);
    if (patch.reset) { t.hsl = defaultHsl(); t.curve = defaultCurve(); }
    markDirty(); redraw();
    return { hsl: t.hsl, curve: t.curve, corrOn: hasCorrection(selClip()) };
  };
  // テキストの検証用。選択中クリップに1つ足して、値を直接いじる
  window._dbg.addText = patch => {
    if ((project.texts ||= []).length >= MAX_TEXTS) throw new Error('テキストは10個までです');
    const t = { ...defaultText(selClip()?.id), ...(patch || {}) };
    project.texts.push(t);
    clearTextRaster(); markDirty(); redraw();
    return t;
  };
  window._dbg.setText = (i, patch) => {
    const t = project.texts?.[i]; if (!t) throw new Error('そのテキストはありません');
    Object.assign(t, patch);
    project.texts = normalizeTexts(project.texts, project.clips);
    clearTextRaster(); markDirty(); redraw();
    return project.texts[i];
  };
  window._dbg.texts = (T = timelinePos) => ({ list: project.texts, at: textsAt(T, getTimelineRenderTiming(T)?.cadence || 0).map(x => ({ text: x.t.text, alpha: +x.alpha.toFixed(3), reveal: +x.reveal.toFixed(3) })) });
  // スプライスの検証口: その時刻の縦ジャンプ量（実装と同じ関数を通す）
  window._dbg.spliceAt = T => { const t = getTimelineRenderTiming(T); return t ? spliceAt(t) : null; };
  // 保存ファイルの検証口: 実際に開かずに、版の判定と引き上げの結果だけを見る
  window._dbg.readPackage = async file => {
    const parsed = await parseHikariPackage(file);
    return { 版: parsed.manifest.version, 作品の版: parsed.manifest.project.formatVersion, state: parsed.state };
  };
  window._dbg.trace = tag => tag ? traceBuf.filter(e => e.tag.startsWith(tag)) : traceBuf.slice();
  window._dbg.trace.clear = () => { traceBuf.length = 0; return 'cleared'; };
  // 実機（スマホ）でログを読む・持ち出すための画面。アドレスバーの javascript: は Chrome が塞いでいるため。
  const traceText = () => traceBuf.map(e => {
    const { ms, tag, ...rest } = e;
    return `${String(ms).padStart(6)} ${tag} ${JSON.stringify(rest)}`;
  }).join('\n') || '（ログはまだありません）';
  $('devTrace').onclick = () => { $('traceText').value = traceText(); $('traceSheet').classList.add('on'); };
  $('traceClose').onclick = () => $('traceSheet').classList.remove('on');
  $('traceClear').onclick = () => { traceBuf.length = 0; $('traceText').value = traceText(); };
  $('traceCopy').onclick = async () => {
    const el = $('traceText');
    try { await navigator.clipboard.writeText(el.value); $('traceCopy').textContent = 'コピー済'; }
    catch (e) { el.focus(); el.select(); $('traceCopy').textContent = '手で選んで'; }
    setTimeout(() => { $('traceCopy').textContent = 'コピー'; }, 1600);
  };
  window._dbg.createTextureFixture = (kind = 'chart', options = {}) => makeTextureFixture(kind, options.width, options.height);
  window._dbg.renderTextureFixture = async (kind = 'chart', t = timelinePos, options = {}) => {
    const source = makeTextureFixture(kind, options.sourceWidth || 720, options.sourceHeight || 540);
    const cv = document.createElement('canvas');
    cv.width = options.width || preview.cv.width; cv.height = options.height || preview.cv.height;
    const pipe = new GLPipe(cv, { forceRgba8: !!options.forceRgba8 });
    try {
      applyLutSelection(pipe);
      const seed = normalizeTextureSeed(project.textureSeed, project), profile = currentFilmProfile();
      const phase = project.adjust.effect === 2 ? textureSeedUnit(seed, 0, 0x3df0ac19) / profile.fps : 0;
      const filmFrame = project.adjust.effect === 2 ? Math.floor((t + phase) * profile.fps) : null;
      const effectTime = filmFrame == null ? t : filmFrame / profile.fps;
      const adjust = { ...project.adjust, ...(options.adjustOverrides || {}) };
      await pipe.draw(source, source.width, source.height, 0, effectTime,
        { bright: 0, temp: 0, autoBright: 0, autoTemp: 0 }, { adjust, trans: options.trans || null });
      const pixels = new Uint8Array(cv.width * cv.height * 4);
      pipe.gl.readPixels(0, 0, cv.width, cv.height, pipe.gl.RGBA, pipe.gl.UNSIGNED_BYTE, pixels);
      let hash = 0x811c9dc5;
      for (let i = 0; i < pixels.length; i++) { hash ^= pixels[i]; hash = Math.imul(hash, 0x01000193) >>> 0; }
      return { kind, source, canvas: cv, pixels, filmFrame, effectTime, qualityPath: pipe.qualityPath,
        pixelHash: ('00000000' + hash.toString(16)).slice(-8), dispose: () => pipe.dispose() };
    } catch (e) { pipe.dispose(); throw e; }
  };
  // v4回帰ベースライン: 3プリセット×3時刻×{RGBA16F,RGBA8}の18ハッシュ。
  // 描画経路には一切触れず、見た目設定と履歴は測定後に元へ戻す（素材と並びは触らない）。
  window._dbg.regressionBaseline = async () => {
    const SEED = 0x9e3779b9, W = 640, H = 480;
    const presets = ['diary', 'mv', 'film8'], times = [0, 0.7, 1.3];
    const snap = JSON.parse(JSON.stringify({
      aspect: project.aspect, fit: project.fit, lut: project.lut, preset: project.preset,
      effectPreset: project.effectPreset, filmProfile: project.filmProfile,
      adjust: project.adjust, muteAll: project.muteAll, autoAlign: project.autoAlign,
      impLen: project.impLen, textureSeed: project.textureSeed,
    }));
    const h = project.id ? historyFor() : null;
    const undoCopy = h ? h.undo.slice() : null, redoCopy = h ? h.redo.slice() : null;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    const rows = [];
    try {
      project.textureSeed = SEED >>> 0;
      for (const preset of presets) {
        applyPreset(preset);
        // 回帰は「エフェクトを足していない状態」の基準。applyPresetが動き一式を入れるので、
        // 必ずその「あと」で0に戻す（前に置くと上書きされて18本すべて変わる）
        for (const k of MOTION_KEYS) project.adjust[k] = 0;
        // 周辺減光の倍率は既定値の変更でハッシュが動かないよう、検査中は常に1.0倍に固定する
        // （0にすると周辺減光そのものが検査対象から外れるので、中立の1.0にする）
        project.adjust.vig = 1;
        for (const t of times) {
          for (const forceRgba8 of [false, true]) {
            const r = await window._dbg.renderTextureFixture('chart', t, { width: W, height: H, forceRgba8 });
            rows.push({ preset, t, quality: r.qualityPath, forced: forceRgba8,
              filmFrame: r.filmFrame, effectTime: +Number(r.effectTime).toFixed(6), hash: r.pixelHash });
            r.dispose();
          }
        }
      }
    } finally {
      window.confirm = realConfirm;
      Object.assign(project, snap, { adjust: { ...snap.adjust } });
      if (h) { h.undo = undoCopy; h.redo = redoCopy; h.current = snapshotProject(); updateHistoryUI(); }
      syncUIFromProject(); redraw(); scheduleSave();
    }
    return rows;
  };
  // つなぎの判定をそのまま覗く。印（タイムライン）と実際の描画が食い違ったときの切り分け用
  window._dbg.transAt = (t, amt) => {
    const a = amt === undefined ? project.adjust : { ...project.adjust, trans: amt };
    const timing = getTimelineRenderTiming(t);
    if (!timing) return null;
    const tr = transitionAt(timing, a);
    const seed = normalizeTextureSeed(project.textureSeed, project);
    const film = a.effect === 2;
    return {
      T: t, 効いている語彙: tr ? tr.kind : 0, 強さ: tr ? +tr.amt.toFixed(3) : 0,
      境界ごとの語彙: project.clips.map((c, k) => transKindAt(k + 1, a.trans || 0, seed, film)),
    };
  };
  window._dbg.renderTextureFrame = async (t = timelinePos, options = {}) => {
    const timing = getTimelineRenderTiming(t);
    if (!timing || !clipReady(timing.clip)) throw new Error('描画できるクリップがありません');
    let pipe = preview, ownPipe = false;
    if (options.forceRgba8) {
      const cv = document.createElement('canvas');
      cv.width = preview.cv.width; cv.height = preview.cv.height;
      pipe = new GLPipe(cv, { forceRgba8: true });
      applyLutSelection(pipe);
      ownPipe = true;
    }
    try {
      const rendered = await renderAtTimelineTime(t, async info => {
        if (info.clip.kind === 'video' && Math.abs(info.clip.video.currentTime - info.localSourceTime) > 0.001)
          await seekTo(info.clip.video, info.localSourceTime);
        return { source: clipSource(info.clip), width: info.clip.w, height: info.clip.h };
      }, { pipe, renderOptions: options.adjustOverrides ? { adjust: { ...project.adjust, ...options.adjustOverrides } } : undefined });
      const pixels = new Uint8Array(pipe.cv.width * pipe.cv.height * 4);
      pipe.gl.readPixels(0, 0, pipe.cv.width, pipe.cv.height, pipe.gl.RGBA, pipe.gl.UNSIGNED_BYTE, pixels);
      let hash = 0x811c9dc5;
      for (let i = 0; i < pixels.length; i++) { hash ^= pixels[i]; hash = Math.imul(hash, 0x01000193) >>> 0; }
      return {
        ...textureDebug(pipe, t), timing: rendered, canvas: pipe.cv, gl: pipe.gl, pixels,
        pixelHash: ('00000000' + hash.toString(16)).slice(-8),
        dispose: ownPipe ? () => pipe.dispose() : () => {},
      };
    } catch (e) {
      if (ownPipe) pipe.dispose();
      throw e;
    }
  };
  window._dbg.measureTexture = async (t = timelinePos, options = {}) => {
    let result = null, grainOff = null, halationOff = null, damageOff = null;
    try {
      // 固定chartを専用offscreen pipeへ描き、再生中previewとGL stateを共有しない。
      const fixtureOptions = { ...options, width: options.width || 720, height: options.height || 540 };
      result = await window._dbg.renderTextureFixture('chart', t, fixtureOptions);
      grainOff = await window._dbg.renderTextureFixture('chart', t,
        { ...fixtureOptions, adjustOverrides: { ...(options.adjustOverrides || {}), grain: 0 } });
      halationOff = await window._dbg.renderTextureFixture('chart', t,
        { ...fixtureOptions, adjustOverrides: { ...(options.adjustOverrides || {}), halation: 0 } });
      damageOff = await window._dbg.renderTextureFixture('chart', t,
        { ...fixtureOptions, adjustOverrides: { ...(options.adjustOverrides || {}), damage: 0 } });
      const px = result.pixels, w = result.canvas.width, h = result.canvas.height;
      const corr = (a, b) => {
        if (!a.length || a.length !== b.length) return 0;
        const ma = a.reduce((s, v) => s + v, 0) / a.length;
        const mb = b.reduce((s, v) => s + v, 0) / b.length;
        let xy = 0, xx = 0, yy = 0;
        for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; xy += x * y; xx += x * x; yy += y * y; }
        return xx && yy ? xy / Math.sqrt(xx * yy) : 0;
      };
      const diff = (on, off) => {
        let abs = 0, luma = 0, changed = 0, redDelta = 0, blueDelta = 0;
        const pixels = on.length / 4;
        for (let i = 0; i < on.length; i += 4) {
          const dr = on[i] - off[i], dg = on[i + 1] - off[i + 1], db = on[i + 2] - off[i + 2];
          abs += Math.abs(dr) + Math.abs(dg) + Math.abs(db);
          luma += 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
          redDelta += dr; blueDelta += db;
          if (dr || dg || db) changed++;
        }
        return { meanAbsRgb: +(abs / (pixels * 3)).toFixed(4), meanLumaDelta: +(luma / pixels).toFixed(4),
          changedPixels: changed, changedRatio: +(changed / pixels).toFixed(6),
          redMinusBlue: +((redDelta - blueDelta) / pixels).toFixed(4) };
      };
      const grainDifference = diff(result.pixels, grainOff.pixels);
      const halationDifference = diff(result.pixels, halationOff.pixels);
      const damageDifference = diff(result.pixels, damageOff.pixels);
      const residualR = [], residualG = [], residualB = [], residualLuma = [], spatialA = [], spatialB = [];
      let lumaSum = 0, lumaCount = 0;
      for (let y = 2; y < h - 2; y += 3) {
        let previousResidual = null;
        for (let x = 2; x < w - 2; x += 3) {
          const i = (y * w + x) * 4;
          const dr = px[i] - grainOff.pixels[i], dg = px[i + 1] - grainOff.pixels[i + 1], db = px[i + 2] - grainOff.pixels[i + 2];
          const dl = 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
          residualR.push(dr); residualG.push(dg); residualB.push(db); residualLuma.push(dl);
          // 各行の中だけ隣接pairを作り、行末→次行先頭の疑似相関を除外する。
          if (previousResidual !== null) { spatialA.push(previousResidual); spatialB.push(dl); }
          previousResidual = dl;
          lumaSum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; lumaCount++;
        }
      }
      const residualMean = residualLuma.reduce((s, v) => s + v, 0) / residualLuma.length;
      const residualVariance = residualLuma.reduce((s, v) => s + (v - residualMean) ** 2, 0) / residualLuma.length;
      const residualRms = Math.sqrt(residualLuma.reduce((s, v) => s + v * v, 0) / residualLuma.length);
      return {
        seed: normalizeTextureSeed(project.textureSeed, project), filmProfile: project.filmProfile,
        qualityPath: result.qualityPath, filmFrame: result.filmFrame, effectTime: result.effectTime,
        pixelHash: result.pixelHash,
        meanLuma: +(lumaSum / lumaCount).toFixed(3),
        grainResidual: {
          rgbCorrelation: { rg: +corr(residualR, residualG).toFixed(4), rb: +corr(residualR, residualB).toFixed(4), gb: +corr(residualG, residualB).toFixed(4) },
          spatialCorrelation: +corr(spatialA, spatialB).toFixed(4),
          mean: +residualMean.toFixed(4), rms: +residualRms.toFixed(4), variance: +residualVariance.toFixed(4),
        },
        grainZeroDifference: grainDifference,
        halationDifference: { ...halationDifference, direction: halationDifference.redMinusBlue > 0 ? 'warm' : halationDifference.redMinusBlue < 0 ? 'cool' : 'neutral' },
        damageDifference: { ...damageDifference, present: damageDifference.changedPixels > 0 },
      };
    } finally {
      result?.dispose(); grainOff?.dispose(); halationOff?.dispose(); damageOff?.dispose();
    }
  };
  window._dbg.failNextSave = () => { failNextSaveForTest = true; };
  window._dbg.failNextTransaction = () => { failNextTransactionForTest = true; };
  window._dbg.inspectStorage = async () => ({
    activeProjectId: project.id,
    projectMeta: await readAll('projectMeta'),
    history: Object.fromEntries([...historyByProject].map(([id, h]) => [id, { undo: h.undo.length, redo: h.redo.length }])),
    files: (await readAll('files')).length,
    referencedAssetIds: [...projectAssetIds()],
  });
  window._dbg.createHikari = createHikariPackage;
  window._dbg.importHikari = importHikariPackage;
  window._dbg.setStorageEstimateMode = async mode => { storageEstimateMode = mode; await updateStorageInfo(); return storageEstimateMode; };
  $('devFailSave').onclick = () => { failNextSaveForTest = true; };
  // 旧probeは非同期入口へ寄せる。await後だけreadPixelsするため、描画途中の値を返さない。
  window._probe = async (fxMode, clipIdx, rowFrac) => {
    const c = project.clips[clipIdx ?? project.clips.length - 1];
    if (!c || !clipReady(c)) return null;
    const savedEffect = project.adjust.effect;
    const t = sumBefore(project.clips.indexOf(c)) + Math.min(clipLen(c) - 1e-6, 0.5);
    let result = null;
    try {
      project.adjust.effect = fxMode;
      result = await window._dbg.renderTextureFrame(t);
      const y = Math.round(result.canvas.height * (rowFrac ?? 0.33));
      const out = [];
      for (let x = 0; x < result.canvas.width; x += 8) {
        const i = (y * result.canvas.width + x) * 4, p = result.pixels;
        out.push([x, Math.round(0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]), p[i] - p[i + 2]]);
      }
      return out;
    } finally { result?.dispose(); project.adjust.effect = savedEffect; }
  };
  window._probeGrain = async (fxMode, clipIdx) => {
    const c = project.clips[clipIdx ?? project.clips.length - 1];
    if (!c || !clipReady(c)) return null;
    const savedEffect = project.adjust.effect;
    try {
      project.adjust.effect = fxMode;
      return await window._dbg.measureTexture(sumBefore(project.clips.indexOf(c)) + 0.5);
    } finally { project.adjust.effect = savedEffect; }
  };
}

// ===== 第2バッチ: 作品・履歴・バックアップ =====
function snapshotProject() { return JSON.stringify(serializeProject()); }
function historyFor(id = project.id) {
  if (!historyByProject.has(id)) historyByProject.set(id, { undo: [], redo: [], current: snapshotProject() });
  return historyByProject.get(id);
}
function beginHistory() { return snapshotProject(); }
function commitHistory(before) {
  if (!project.id || before === snapshotProject()) return;
  const h = historyFor();
  h.undo.push(before); if (h.undo.length > 50) h.undo.shift(); h.redo.length = 0; h.current = snapshotProject();
  updateHistoryUI();
}
function updateHistoryUI() {
  const h = project.id ? historyFor() : { undo: [], redo: [] };
  $('undoBtn').disabled = !h.undo.length || operationBusy;
  $('redoBtn').disabled = !h.redo.length || operationBusy;
  $('undoBtn').setAttribute('aria-label', h.undo.length ? '戻す' : '戻す（次の操作はありません）');
  $('redoBtn').setAttribute('aria-label', h.redo.length ? 'やり直す' : 'やり直す（次の操作はありません）');
}
async function restoreSnapshot(text, direction) {
  if (operationBusy) return;
  const h = historyFor(); const source = direction === 'undo' ? h.undo : h.redo;
  if (!source.length) return;
  operationBusy = true; updateHistoryUI(); stopPlayback();
  try {
    const current = snapshotProject(), st = JSON.parse(source.pop());
    (direction === 'undo' ? h.redo : h.undo).push(current);
    // 1手戻すたびに選択が外れると編集が続けられないので、同じクリップが残っていれば選び直す
    const keepSel = selId;
    await hydrateProject(normalizeRestoredState(st));
    if (keepSel && project.clips.some(c => c.id === keepSel)) { selId = keepSel; renderTimeline(); renderClipEdit(); }
    h.current = snapshotProject();
    markDirty(); await saveState();
  } catch (e) { logErr('履歴の復元に失敗: ' + e.message); }
  operationBusy = false; updateHistoryUI();
}
function resetProjectObject(st) {
  Object.assign(project, { id: st.id, name: st.name || '無題の作品', createdAt: st.createdAt || new Date().toISOString(), updatedAt: st.updatedAt || null, assetBytes: st.assetBytes || 0,
    aspect: st.aspect || '16:9', fit: st.fit || 'contain', clips: [], lut: st.lut || 'hikari',
    lutFileText: st.lutFileText || null, lutFileName: st.lutFileName || null,
    adjust: { ...DEFAULT_ADJUST, hsl: defaultHsl(), curve: defaultCurve(), ...(st.adjust || {}) },
    texts: Array.isArray(st.texts) ? st.texts : [],
    transOverrides: Array.isArray(st.transOverrides) ? st.transOverrides
      .filter(x => x && typeof x.leftClipId === 'string' && ['auto', 'flash', 'burn', 'scorch', 'black', 'fadeout', 'none'].includes(x.kind))
      .map(x => ({ leftClipId: x.leftClipId, kind: x.kind, amp: Number.isFinite(x.amp) ? clamp(x.amp, 0.3, 1.6) : 1,
        roll: Number.isInteger(x.roll) && x.roll >= 0 && x.roll < 100000 ? x.roll : 0 })) : [],
    music: null, muteAll: !!st.muteAll, autoAlign: st.autoAlign !== false, impLen: st.impLen ?? 3, preset: st.preset || null,
    textureSeed: normalizeTextureSeed(st.textureSeed, st), filmProfile: FILM_PROFILES[st.filmProfile] ? st.filmProfile : 'home8' });
  clipSeq = st.clipSeq || 0; selId = null; playIdx = 0; musicAudioBuf = null;
}
function revokeRuntimeAssets() { project.clips.forEach(c => { try { URL.revokeObjectURL(c.url); } catch (e) {} }); }
function clearOutputVideo() {
  if (outVideoUrl) URL.revokeObjectURL(outVideoUrl);
  outVideoUrl = null;
  const ov = $('outVideo'); ov.pause?.(); ov.removeAttribute('src'); ov.load?.(); ov.style.display = 'none';
  $('dlLink').removeAttribute('href'); $('saveRow').style.display = 'none';
}
async function hydrateProject(st) {
  // 先に全assetを検査する。欠損作品を部分復元して次の保存で欠損参照を消さない。
  const assets = new Map(), missing = [];
  for (const m of st.clips || []) {
    const blob = pendingFileWrites.get(m.assetId) || await idbGet('files', m.assetId).catch(() => null);
    if (!blob) missing.push(m.name || '素材'); else assets.set(m.assetId, blob);
  }
  if (st.music?.assetId) {
    const blob = pendingFileWrites.get(st.music.assetId) || await idbGet('files', st.music.assetId).catch(() => null);
    if (!blob) missing.push(st.music.name || '音楽'); else assets.set(st.music.assetId, blob);
  }
  if (missing.length) { const e = new Error(missing.join('、')); e.code = 'INCOMPLETE_PROJECT'; throw e; }
  revokeRuntimeAssets(); resetProjectObject(st);
  clearOutputVideo();
  if (st.lutFileText) { try { project.lutFileData = parseCube(st.lutFileText); } catch (e) { project.lut = 'hikari'; } }
  let assetBytes = 0; const countedAssets = new Set();
  try {
    for (const m of st.clips || []) {
      const blob = assets.get(m.assetId);
      project.clips.push(await createClip(blob, m)); if (!countedAssets.has(m.assetId)) { countedAssets.add(m.assetId); assetBytes += blob.size; }
    }
    if (st.music?.assetId) {
      const mb = assets.get(st.music.assetId);
      project.music = { name: st.music.name, assetId: st.music.assetId, arrayBuffer: await mb.arrayBuffer(), volume: st.music.volume, loop: st.music.loop !== false, offset: Number(st.music.offset) || 0 }; if (!countedAssets.has(st.music.assetId)) assetBytes += mb.size;
    }
  } catch (e) { revokeRuntimeAssets(); throw e; }
  // v4: 開いた直後は未選択＝作品モード。クリップの道具はタップで選んでから出す
  project.assetBytes = assetBytes; selId = null;
  if (project.music) await ensureMusicBuffer().catch(() => {});
  syncUIFromProject(); if (project.clips.length) seekTimeline(0); else clearPreview();
}
async function migrateV1IfNeeded() {
  const d = await db();
  const old = await idbGet('state', 'project').catch(() => null);
  const workspace = await idbGet('state', WORKSPACE_KEY).catch(() => null);
  if (!old || workspace?.activeProjectId) return workspace;
  // field補完やclip整形より前のraw v1 stateをseedの唯一の入力にする。
  const legacyTextureSeed = normalizeTextureSeed(old.textureSeed, old);
  const legacy = { ...old, clips: (old.clips || []).map(c => ({
    id: c?.id, name: c?.name || 'クリップ', start: Number.isFinite(c?.start) ? c.start : 0,
    end: Number.isFinite(c?.end) ? c.end : 0.2, kind: c?.kind || 'video', dur: Math.max(Number.isFinite(c?.end) ? c.end : 0.2, 0.2),
    bright: Number.isFinite(c?.bright) ? c.bright : 0, temp: Number.isFinite(c?.temp) ? c.temp : 0,
    fxScale: 1, highKey: 0, hsl: defaultHsl(), curve: defaultCurve(), autoBright: 0, autoTemp: 0, muted: false, thumb: typeof c?.thumb === 'string' ? c.thumb : '',
  })), music: old.music ? { name: old.music.name || '音楽', volume: Number.isFinite(old.music.volume) ? old.music.volume : 0.7, stored: !!old.music.stored } : null,
    textureSeed: legacyTextureSeed };
  const st = normalizeRestoredState(legacy, true), id = newId(), now = new Date().toISOString();
  st.id = id; st.name = `作品 ${now.slice(0, 10)}`; st.createdAt = now; st.updatedAt = now;
  // 旧stateが参照する素材を全件そろえてからだけ移行transactionを始める。
  // 欠損した旧DBを「一部だけ新形式」にして旧キーを消すことはしない。
  const legacyAssets = [];
  for (const c of st.clips || []) {
    const blob = await idbGet('files', c.id).catch(() => null);
    if (!blob) { const e = new Error(`v1素材が見つかりません: ${c.name || c.id}`); e.code = 'V1_INCOMPLETE'; throw e; }
    legacyAssets.push([c.id, blob]);
  }
  let legacyMusic = null;
  if (st.music?.stored) {
    legacyMusic = await idbGet('files', 'music').catch(() => null);
    if (!legacyMusic) { const e = new Error(`v1音楽が見つかりません: ${st.music.name || 'music'}`); e.code = 'V1_INCOMPLETE'; throw e; }
  }
  const oldEntries = [];
  for (const c of st.clips || []) {
    const oldKey = c.id, blob = legacyAssets.find(([key]) => key === oldKey)[1];
    c.assetId = newId();
    oldEntries.push([oldKey, c.assetId, blob]);
  }
  if (st.music?.stored) { st.music.assetId = newId(); oldEntries.push(['music', st.music.assetId, legacyMusic]); }
  st.assetBytes = oldEntries.reduce((n, [, , blob]) => n + blob.size, 0);
  await new Promise((res, rej) => {
    const t = d.transaction(['files', 'projects', 'projectMeta', 'state'], 'readwrite'), files = t.objectStore('files');
    oldEntries.forEach(([oldKey, assetId, blob]) => files.put(blob, assetId));
    t.objectStore('projects').put(st, id); t.objectStore('projectMeta').put(makeProjectMeta(st), id);
    t.objectStore('state').put({ schemaVersion: 2, activeProjectId: id }, WORKSPACE_KEY);
    // 旧データは同一transactionの最後にだけ消す。abortなら全て残る。
    t.objectStore('state').delete('project'); oldEntries.forEach(([oldKey]) => files.delete(oldKey));
    if (failNextTransactionForTest) { failNextTransactionForTest = false; t.abort(); }
    t.oncomplete = res; t.onerror = () => rej(t.error || new Error('v1移行に失敗しました')); t.onabort = () => rej(t.error || new Error('v1移行が中断されました'));
  });
  return { schemaVersion: 2, activeProjectId: id };
}
async function readAll(store) {
  const d = await db();
  return new Promise((res, rej) => { const q = d.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
}
const prettyBytes = n => n < 1024 * 1024 ? `${Math.round(n / 1024)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`;
async function updateProjectSheet() {
  const metas = (await readAll('projectMeta')).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  $('projectList').innerHTML = '';
  metas.forEach(meta => {
    const b = document.createElement('button'); b.className = `projectItem${meta.id === project.id ? ' current' : ''}`;
    const title = document.createElement('strong'); title.textContent = meta.name; b.appendChild(title);
    if (meta.id === project.id) { const current = document.createElement('span'); current.textContent = ' 現在の作品'; b.appendChild(current); }
    const detail = document.createElement('small'); detail.textContent = `${new Date(meta.updatedAt).toLocaleString()}・${Number(meta.duration || 0).toFixed(1)}秒・${prettyBytes(meta.assetBytes || 0)}`; b.appendChild(detail);
    b.disabled = operationBusy; b.onclick = () => switchProject(meta.id); $('projectList').appendChild(b);
  });
  await updateStorageInfo();
}
async function updateStorageInfo() {
  const own = recalculateAssetBytes();
  try {
    if (storageEstimateMode === 'unsupported') throw new Error('unsupported');
    if (storageEstimateMode === 'error') throw new Error('error');
    const e = storageEstimateMode === 'quota-none' ? {} : await navigator.storage?.estimate?.();
    $('projectStorageInfo').textContent = e?.quota ? `この作品 ${prettyBytes(own)}・端末の空き目安 ${prettyBytes(Math.max(0, e.quota - (e.usage || 0)))}（概算）` : `この作品 ${prettyBytes(own)}・端末の空きは取得できません`;
  } catch (e) { $('projectStorageInfo').textContent = `この作品 ${prettyBytes(own)}・端末の空きは取得できません`; }
}
async function confirmStorageForAdditional(bytes) {
  try {
    const e = storageEstimateMode === 'quota-none' ? {} : await navigator.storage?.estimate?.();
    if (!e?.quota) return true;
    const free = Math.max(0, e.quota - (e.usage || 0));
    if (free < bytes) { setProjectStatus('端末の空き目安が不足しているため、素材を追加しませんでした'); return false; }
    if (free < bytes * 1.2 && !confirm(`追加後の端末空きが少なくなります。素材 ${prettyBytes(bytes)} を追加しますか？`)) return false;
  } catch (e) { /* 容量推定に未対応でも、素材容量表示は継続する */ }
  return true;
}
function setProjectStatus(text) { $('projectActionStatus').textContent = text; }
function updateProjectControls() {
  document.querySelectorAll('#projectSheet button, #projectSheet input').forEach(el => { el.disabled = operationBusy; });
  document.querySelectorAll('#projectList button').forEach(el => { el.disabled = operationBusy; });
  updateHistoryUI();
}
async function withProjectOperation(label, work) {
  if (operationBusy) return false;
  operationBusy = true; setProjectStatus(label); updateProjectControls();
  try { await work(); return true; }
  catch (e) { setProjectStatus(`${label.replace(/…$/, '')}に失敗: ${e.message}`); return false; }
  finally { operationBusy = false; updateProjectControls(); }
}
async function switchProject(id) {
  if (operationBusy || id === project.id) return;
  operationBusy = true; updateProjectControls(); setProjectStatus('保存して切り替えています…');
  try {
    if (!(await saveState())) { setProjectStatus('保存できないため、作品を切り替えませんでした'); return; }
    const st = normalizeRestoredState(await idbGet('projects', id)); if (!st) throw new Error('作品が見つかりません');
    const old = JSON.parse(snapshotProject()), oldId = project.id;
    const d = await db(); await new Promise((res, rej) => { const t = d.transaction('state', 'readwrite'); t.objectStore('state').put({ schemaVersion: 2, activeProjectId: id }, WORKSPACE_KEY); t.oncomplete = res; t.onerror = () => rej(t.error); });
    try { stopPlayback(); await hydrateProject(st); }
    catch (hydrateError) {
      await new Promise((res, rej) => { const t = d.transaction('state', 'readwrite'); t.objectStore('state').put({ schemaVersion: 2, activeProjectId: oldId }, WORKSPACE_KEY); t.oncomplete = res; t.onerror = () => rej(t.error); });
      await hydrateProject(normalizeRestoredState(old)); throw hydrateError;
    }
    historyFor(project.id); await updateProjectSheet(); setProjectStatus('切り替えました');
  } catch (e) { setProjectStatus('切替に失敗: ' + e.message); }
  finally { operationBusy = false; updateProjectControls(); }
}
async function newProjectFromPreset(name) {
  const p = PRESETS[name]; if (!p) return;
  return withProjectOperation('新しい作品を作成中…', async () => {
    if (project.id && !(await saveState())) throw new Error('保存できないため、新しい作品を作りませんでした');
    const old = project.id ? JSON.parse(snapshotProject()) : null;
    const now = new Date().toISOString(), base = `${PRESET_LABELS[name]} ${now.slice(0, 10)}`;
    const metas = await readAll('projectMeta'); let title = base, n = 2; while (metas.some(m => m.name === title)) title = `${base} ${n++}`;
    const st = makeEmptyProject(newId(), title, now, p);
    await persistProjectAndActivate(st);
    try { await hydrateProject(st); } catch (e) { await rollbackActivatedProject(st.id, old); throw e; }
    ready = true;
    historyByProject.set(st.id, { undo: [], redo: [], current: snapshotProject() }); await updateProjectSheet(); setProjectStatus('新しい作品を作成しました');
  });
}
async function persistProjectAndActivate(st) {
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction(['projects', 'projectMeta', 'state'], 'readwrite');
    t.objectStore('projects').put(st, st.id); t.objectStore('projectMeta').put(makeProjectMeta(st), st.id);
    t.objectStore('state').put({ schemaVersion: 2, activeProjectId: st.id }, WORKSPACE_KEY);
    if (failNextTransactionForTest) { failNextTransactionForTest = false; t.abort(); }
    t.oncomplete = res; t.onerror = () => rej(t.error || new Error('作品の保存に失敗しました')); t.onabort = () => rej(t.error || new Error('作品の保存が中断されました'));
  });
}
async function restoreWorkspaceAndProject(old) {
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction('state', 'readwrite');
    if (old?.id) t.objectStore('state').put({ schemaVersion: 2, activeProjectId: old.id }, WORKSPACE_KEY);
    else t.objectStore('state').delete(WORKSPACE_KEY);
    t.oncomplete = res; t.onerror = () => rej(t.error || new Error('workspaceの復帰に失敗しました'));
  });
  if (old) await hydrateProject(normalizeRestoredState(old));
}
async function rollbackActivatedProject(createdId, old, assetIds = []) {
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction(['files', 'projects', 'projectMeta', 'state'], 'readwrite');
    t.objectStore('projects').delete(createdId); t.objectStore('projectMeta').delete(createdId);
    [...new Set(assetIds)].forEach(id => t.objectStore('files').delete(id));
    if (old?.id) t.objectStore('state').put({ schemaVersion: 2, activeProjectId: old.id }, WORKSPACE_KEY);
    else t.objectStore('state').delete(WORKSPACE_KEY);
    t.oncomplete = res; t.onerror = () => rej(t.error || new Error('作品作成の取消に失敗しました')); t.onabort = () => rej(t.error || new Error('作品作成の取消が中断されました'));
  });
  if (old) await hydrateProject(normalizeRestoredState(old));
  else { revokeRuntimeAssets(); resetProjectObject(makeEmptyProject(null, '無題の作品')); clearOutputVideo(); syncUIFromProject(); }
}
function makeEmptyProject(id, name, now = new Date().toISOString(), preset = null) {
  const p = preset || { aspect: '16:9', fit: 'contain', lut: 'hikari', effect: 0, muteAll: false, impLen: 3, letterbox: true, autoAlign: true };
  const filmProfile = FILM_PROFILES[p.filmProfile] ? p.filmProfile : 'home8';
  const profile = FILM_PROFILES[filmProfile];
  // 新規作品の初期フレームだけプリセットの得意な向きを使う（あとは上のアスペクト選択で変えられる）
  return { id, name, createdAt: now, updatedAt: now, assetBytes: 0, aspect: p.newAspect || p.aspect || '16:9', fit: p.fit || 'contain', clips: [], texts: [], lut: p.lut,
    adjust: { ...DEFAULT_ADJUST, hsl: defaultHsl(), curve: defaultCurve(), effect: p.effect, letterbox: p.letterbox,
      grain: (p.effect === 2 ? profile.grain : FX[p.effect].gAmt) / 400,
      grainSize: (p.effect === 2 ? profile.grainSize : FX[p.effect].gSize) / 100,
      glow: (p.effect === 2 ? profile.glow : FX[p.effect].gGlow) / 100,
      halation: (p.effect === 2 ? profile.halation * 100 : FX[p.effect].gHal) / 100,
      damage: p.effect === 2 ? profile.damage : 0 },
    muteAll: p.muteAll, autoAlign: p.autoAlign, impLen: p.impLen,
    preset: preset ? Object.entries(PRESETS).find(([, value]) => value === preset)?.[0] || null : null,
    textureSeed: makeTextureSeed(), filmProfile, music: null, clipSeq: 0 };
}
async function duplicateProject() {
  if (operationBusy) return false; if (!(await saveState())) { setProjectStatus('保存できないため、複製しませんでした'); return false; } const st = JSON.parse(snapshotProject()), now = new Date().toISOString();
  const old = JSON.parse(snapshotProject());
  st.id = newId(); st.name = `${project.name} のコピー`; st.createdAt = st.updatedAt = now; st.clips = st.clips.map(c => ({ ...c, id: newId() }));
  operationBusy = true; updateProjectControls();
  try {
    await persistProjectAndActivate(st);
    try { await hydrateProject(st); } catch (e) { await rollbackActivatedProject(st.id, old); throw e; }
    ready = true;
    historyByProject.set(st.id, { undo: [], redo: [], current: snapshotProject() }); await updateProjectSheet(); return true;
  } catch (e) { setProjectStatus('複製に失敗: ' + e.message); return false; }
  finally { operationBusy = false; updateProjectControls(); }
}
async function garbageCollect() {
  const refs = new Set(); projectAssetIds().forEach(id => refs.add(id)); (await readAll('projects')).forEach(st => projectAssetIds(st).forEach(id => refs.add(id)));
  historyByProject.forEach(h => [...h.undo, ...h.redo].forEach(text => { try { projectAssetIds(JSON.parse(text)).forEach(id => refs.add(id)); } catch (e) {} }));
  pendingFileWrites.forEach((_, id) => refs.add(id));
  const d = await db(), keys = await new Promise((res, rej) => { const q = d.transaction('files').objectStore('files').getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const unused = keys.filter(id => !refs.has(id)); if (!unused.length) return;
  await new Promise((res, rej) => { const t = d.transaction('files', 'readwrite'); unused.forEach(id => t.objectStore('files').delete(id)); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
const PACKAGE_MAGIC = 'HIKARI_PROJECT_1';
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
async function crc32(blob) { let c = 0xffffffff; for (let o = 0; o < blob.size; o += 1024 * 1024) { const d = new Uint8Array(await blob.slice(o, o + 1024 * 1024).arrayBuffer()); for (const b of d) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); } return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0'); }
function cubeTextFromData(data, size) {
  if (!data || !size) return null;
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let i = 0; i < data.length; i += 3) lines.push(`${(data[i] / 255).toFixed(6)} ${(data[i + 1] / 255).toFixed(6)} ${(data[i + 2] / 255).toFixed(6)}`);
  return lines.join('\n') + '\n';
}
function packageLut() {
  const key = project.lut === 'mine' ? 'mineLutDataText' : project.lut === 'airu' ? 'airuLutDataText' : project.lut === 'film8' ? 'film8LutDataText' : null;
  const generated = project.lut === 'hikari' ? makeHikariLut() : null;
  const text = project.lut === 'file' ? project.lutFileText : key ? project[key] : generated ? cubeTextFromData(generated.data, generated.n) : null;
  return { kind: project.lut === 'file' ? 'custom' : project.lut === 'hikari' ? 'generated' : project.lut === 'none' ? 'none' : 'builtin', name: project.lutFileName || project.lut, text };
}
async function createHikariPackage() {
  const st = serializeProject(), assets = [], blobs = [], seen = new Set(), refs = [...st.clips.map(c => ({ assetId: c.assetId, role: 'clip', name: c.name })), ...(st.music ? [{ assetId: st.music.assetId, role: 'music', name: st.music.name }] : [])]; let offset = 0;
  for (const ref of refs) { if (seen.has(ref.assetId)) continue; seen.add(ref.assetId); const blob = pendingFileWrites.get(ref.assetId) || await idbGet('files', ref.assetId); if (!blob) throw new Error(`素材が見つかりません: ${ref.name}`); assets.push({ ...ref, type: blob.type || 'application/octet-stream', size: blob.size, offset, crc32: await crc32(blob) }); blobs.push(blob); offset += blob.size; }
  const manifest = new TextEncoder().encode(JSON.stringify({ format: 'hikari-project', version: PROJECT_FORMAT, createdAt: new Date().toISOString(), project: st, assets, lut: packageLut() }));
  if (manifest.byteLength < 1 || manifest.byteLength > 2 * 1024 * 1024) throw new Error('バックアップ情報が大きすぎます');
  const header = new Uint8Array(20), magic = new TextEncoder().encode(PACKAGE_MAGIC); header.set(magic); new DataView(header.buffer).setUint32(16, manifest.byteLength, true);
  return new Blob([header, manifest, ...blobs], { type: 'application/octet-stream' });
}
function isRecord(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
// 補正フィールドは後から足したので「無いか、型と範囲が正しい」を条件にする
function validCorrField(hsl, curve) {
  if (hsl !== undefined) {
    if (!isRecord(hsl)) return false;
    for (const k of Object.keys(hsl)) {
      if (!HSL_KEYS.includes(k) || !isRecord(hsl[k])) return false;
      for (const axis of ['h', 's', 'l']) {
        const n = hsl[k][axis];
        if (n !== undefined && (!finiteNumber(n) || n < -100 || n > 100)) return false;
      }
    }
  }
  if (curve !== undefined) {
    if (!Array.isArray(curve) || curve.length < 2 || curve.length > 6) return false;
    for (const p of curve) {
      if (!Array.isArray(p) || p.length !== 2) return false;
      if (!finiteNumber(p[0]) || !finiteNumber(p[1]) || p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1) return false;
    }
  }
  return true;
}
function nonEmptyText(v) { return typeof v === 'string' && v.trim().length > 0; }
function finiteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function validatePackageManifest(m) {
  if (!isRecord(m) || m.format !== 'hikari-project' || !Array.isArray(m.assets) || m.assets.length > 200 || !isRecord(m.project)) throw new Error('対応していないバックアップです');
  // 【2026-08-17】版の扱いを分けた。古いものは読める（足りない項目は既定値で埋まる）。
  // 新しすぎるものは黙って一部を落として開くより、はっきり断ったほうが親切。
  if (!Number.isInteger(m.version) || m.version < 1) throw new Error('対応していないバックアップです');
  if (m.version > PROJECT_FORMAT) throw new Error('新しい版の「ひかりを編む」で保存された作品です。アプリを新しくしてから開いてください');
  // 保存に版が入っていない時代のものは、パッケージ側の版を作品情報にも移しておく
  if (m.project.formatVersion === undefined) m.project.formatVersion = m.version;
  const st = m.project;
  // textureSeed導入前のpackageだけは欠損IDを許し、ID差替え前canonical JSON seed補完へ到達させる。
  // seedを持つ新形式は従来どおりproject/clip IDを必須にする。
  const legacyPackage = st.textureSeed === undefined;
  const missingLegacyProjectId = legacyPackage && !nonEmptyText(st.id);
  if ((!missingLegacyProjectId && !nonEmptyText(st.id)) || typeof st.name !== 'string' || !ASPECTS[st.aspect] || !['contain', 'cover'].includes(st.fit) || !['mine', 'airu', 'film8', 'hikari', 'none', 'file'].includes(st.lut) || !isRecord(st.adjust) || !Array.isArray(st.clips) || st.clips.length > 200 || ![0, 2, 3, 5].includes(st.impLen) || typeof st.muteAll !== 'boolean' || typeof st.autoAlign !== 'boolean' || (st.assetBytes !== undefined && (!finiteNumber(st.assetBytes) || st.assetBytes < 0))) throw new Error('作品情報が不正です');
  const adjustRanges = { exposure: [-1, 1], contrast: [-0.5, 0.5], saturation: [-1, 1], fade: [0, 0.5], grain: [0, 0.25], grainSize: [0.5, 4], glow: [0, 2], halation: [0, 0.6], strength: [0, 1] };
  // 動き系（v5-4〜）。未指定は旧パッケージなので許す
  if (st.adjust.handheld !== undefined && (!finiteNumber(st.adjust.handheld) || st.adjust.handheld < 0 || st.adjust.handheld > 1)) throw new Error('補正情報が不正です');
  if (st.adjust.leak !== undefined && (!finiteNumber(st.adjust.leak) || st.adjust.leak < 0 || st.adjust.leak > 1)) throw new Error('補正情報が不正です');
  if (st.adjust.trans !== undefined && (!finiteNumber(st.adjust.trans) || st.adjust.trans < 0 || st.adjust.trans > 1)) throw new Error('補正情報が不正です');
  if (st.adjust.judder !== undefined && (!finiteNumber(st.adjust.judder) || st.adjust.judder < 0 || st.adjust.judder > 1)) throw new Error('補正情報が不正です');
  // 境目の手動指定（v6）。未指定は旧パッケージなので許す
  if (st.transOverrides !== undefined && (!Array.isArray(st.transOverrides)
    || st.transOverrides.some(x => !isRecord(x) || !nonEmptyText(x.leftClipId) || !['auto', 'flash', 'burn', 'scorch', 'black', 'fadeout', 'none'].includes(x.kind)
      || (x.amp !== undefined && (!finiteNumber(x.amp) || x.amp < 0.3 || x.amp > 1.6))
      || (x.roll !== undefined && (!Number.isInteger(x.roll) || x.roll < 0 || x.roll >= 100000)))))
    throw new Error('つなぎ目の情報が不正です');
  const hasDamage = Object.prototype.hasOwnProperty.call(st.adjust, 'damage');
  if (!Number.isInteger(st.adjust.effect) || ![0, 1, 2].includes(st.adjust.effect) || Object.entries(adjustRanges).some(([k, [lo, hi]]) => !finiteNumber(st.adjust[k]) || st.adjust[k] < lo || st.adjust[k] > hi) || typeof st.adjust.letterbox !== 'boolean' || (hasDamage && (!finiteNumber(st.adjust.damage) || st.adjust.damage < 0 || st.adjust.damage > 1)) || (st.textureSeed !== undefined && (!Number.isInteger(st.textureSeed) || st.textureSeed < 0 || st.textureSeed > 0xffffffff)) || (st.filmProfile !== undefined && !FILM_PROFILE_KEYS.includes(st.filmProfile)) || (st.clipSeq !== undefined && (!Number.isSafeInteger(st.clipSeq) || st.clipSeq < 0 || st.clipSeq > 1000000))) throw new Error('補正情報が不正です');
  const clipIds = new Set(), referenced = new Map();
  for (const c of st.clips) {
    const missingLegacyClipId = legacyPackage && !nonEmptyText(c?.id);
    if (!isRecord(c) || (!missingLegacyClipId && (!nonEmptyText(c.id) || clipIds.has(c.id))) || !nonEmptyText(c.assetId) || !['video', 'photo'].includes(c.kind) || typeof c.name !== 'string' || !finiteNumber(c.start) || !finiteNumber(c.end) || !finiteNumber(c.dur) || c.start < 0 || c.end <= c.start || c.dur < c.end || c.dur > 24 * 60 * 60 || c.end > 24 * 60 * 60 || !finiteNumber(c.bright) || c.bright < -1 || c.bright > 1 || !finiteNumber(c.temp) || c.temp < -1 || c.temp > 1 || !finiteNumber(c.autoBright) || c.autoBright < -0.7 || c.autoBright > 0.7 || !finiteNumber(c.autoTemp) || c.autoTemp < -0.4 || c.autoTemp > 0.4 || typeof c.muted !== 'boolean' || (c.thumb != null && typeof c.thumb !== 'string')
      || (c.fxScale !== undefined && (!finiteNumber(c.fxScale) || c.fxScale < 0 || c.fxScale > 1))
      || (c.highKey !== undefined && (!finiteNumber(c.highKey) || c.highKey < 0 || c.highKey > 1))
      || !validCorrField(c.hsl, c.curve)) throw new Error('クリップ情報が不正です');
    if (!missingLegacyClipId) clipIds.add(c.id);
    referenced.set(c.assetId, 'clip');
  }
  if (st.music !== null && st.music !== undefined) {
    if (!isRecord(st.music) || !nonEmptyText(st.music.assetId) || !nonEmptyText(st.music.name) || !finiteNumber(st.music.volume) || st.music.volume < 0 || st.music.volume > 1) throw new Error('音楽情報が不正です');
    if (referenced.has(st.music.assetId)) throw new Error('音楽とクリップが同じ素材を参照しています');
    referenced.set(st.music.assetId, 'music');
  }
  const assets = new Map();
  for (const a of m.assets) {
    if (!isRecord(a) || !nonEmptyText(a.assetId) || assets.has(a.assetId) || !['clip', 'music'].includes(a.role) || typeof a.name !== 'string' || typeof a.type !== 'string' || !Number.isSafeInteger(a.size) || !Number.isSafeInteger(a.offset) || !/^[0-9a-f]{8}$/i.test(a.crc32) || a.size < 0 || a.offset < 0) throw new Error('素材情報が不正です');
    assets.set(a.assetId, a);
  }
  if (assets.size !== referenced.size) throw new Error('素材参照が一致しません');
  for (const [assetId, role] of referenced) if (!assets.has(assetId) || assets.get(assetId).role !== role) throw new Error('素材の役割または参照が一致しません');
  const lut = m.lut;
  if (!isRecord(lut) || !['custom', 'generated', 'builtin', 'none'].includes(lut.kind) || typeof lut.name !== 'string' || (lut.text != null && typeof lut.text !== 'string') || (lut.kind !== 'none' && !nonEmptyText(lut.text))) throw new Error('LUT情報が不正です');
}
async function parseHikariPackage(file) {
  if (file.size < 21) throw new Error('バックアップが短すぎます'); const h = new Uint8Array(await file.slice(0, 20).arrayBuffer()); if (new TextDecoder().decode(h.slice(0, 16)) !== PACKAGE_MAGIC) throw new Error('バックアップ形式が違います'); const len = new DataView(h.buffer).getUint32(16, true); if (len < 1 || len > 2 * 1024 * 1024 || 20 + len > file.size) throw new Error('バックアップ情報の長さが不正です');
  let m; try { m = JSON.parse(new TextDecoder().decode(await file.slice(20, 20 + len).arrayBuffer())); } catch (e) { throw new Error('バックアップ情報を読めません'); }
  validatePackageManifest(m);
  const ranges = []; for (const a of m.assets) { if (!a || typeof a.assetId !== 'string' || typeof a.name !== 'string' || typeof a.type !== 'string' || !Number.isSafeInteger(a.size) || !Number.isSafeInteger(a.offset) || !/^[0-9a-f]{8}$/i.test(a.crc32) || a.size < 0 || a.offset < 0 || 20 + len + a.offset + a.size > file.size) throw new Error('素材情報が不正です'); ranges.push([a.offset, a.offset + a.size]); }
  ranges.sort((a, b) => a[0] - b[0]); if (ranges.some((r, i) => i && r[0] < ranges[i - 1][1])) throw new Error('素材領域が重なっています');
  const blobs = new Map(); for (const a of m.assets) { const blob = file.slice(20 + len + a.offset, 20 + len + a.offset + a.size, a.type); if ((await crc32(blob)).toLowerCase() !== a.crc32.toLowerCase()) throw new Error(`素材が壊れています: ${a.name}`); blobs.set(a.assetId, blob); }
  const st = normalizeRestoredState(m.project); if (st.clips.some(c => !blobs.has(c.assetId)) || (st.music && !blobs.has(st.music.assetId))) throw new Error('作品情報が不正です'); if (m.lut?.text) parseCube(m.lut.text);
  return { manifest: m, blobs, state: st };
}
async function importHikariPackage(file) {
  // packageのmagic/CRC/stateを先に読み切り、失敗ならDBにも現在作品にも触れない。
  const parsed = await parseHikariPackage(file);
  const old = project.id ? JSON.parse(snapshotProject()) : null, oldId = project.id;
  // 検証済みpackageの後にだけ、現在の作品を確実に保存する。
  if (project.id && !(await saveState())) throw new Error('現在の作品を保存できないため、読み込みませんでした');
  const importBytes = [...parsed.blobs.values()].reduce((n, blob) => n + blob.size, 0);
  try { const e = await navigator.storage?.estimate?.(); if (e?.quota && e.quota - (e.usage || 0) < importBytes) throw new Error('端末の空き目安が不足しています。空き容量を確保してから再試行してください'); if (e?.quota && e.quota - (e.usage || 0) < importBytes * 1.2) logErr('容量警告: 読込み後の空きが少なく、保存に失敗するおそれがあります'); } catch (e) { if (e.message?.includes('不足')) throw e; }
  const st = parsed.state, id = newId(), map = new Map(); parsed.blobs.forEach((_, old) => map.set(old, newId())); st.id = id; st.name = `${st.name || '読み込んだ作品'} ${new Date().toISOString().slice(0, 10)}`; st.createdAt = st.updatedAt = new Date().toISOString(); st.assetBytes = importBytes; const clipIdMap = new Map(); st.clips = st.clips.map(c => { const nid = newId(); clipIdMap.set(c.id, nid); return { ...c, id: nid, assetId: map.get(c.assetId) }; });
  // 読み込みでクリップidを振り直すので、つなぎ目の手動指定も新しいidへ付け替える
  // （テキストのクリップ紐づけと同じ理由。付け替えないと指定が丸ごと消える＝実際に消えた）
  if (Array.isArray(st.transOverrides)) st.transOverrides = st.transOverrides
    .map(x => ({ ...x, leftClipId: clipIdMap.get(x.leftClipId) })).filter(x => x.leftClipId);
  // 文字のクリップ紐づけも同じ理由で付け替える（付け替えないと作品全体の文字に化ける）
  if (Array.isArray(st.texts)) st.texts = st.texts.map(t => (t?.anchor?.type === 'clip' && clipIdMap.has(t.anchor.clipId))
    ? { ...t, anchor: { ...t.anchor, clipId: clipIdMap.get(t.anchor.clipId) } } : t); if (st.music) st.music.assetId = map.get(st.music.assetId); if (parsed.manifest.lut?.text) { const lut = parsed.manifest.lut; const builtinText = lut.name === 'mine' ? project.mineLutDataText : lut.name === 'airu' ? project.airuLutDataText : lut.name === 'film8' ? project.film8LutDataText : null; if (lut.kind === 'builtin' && builtinText === lut.text) st.lut = lut.name; else { st.lut = 'file'; st.lutFileName = lut.name || 'バックアップLUT.cube'; st.lutFileText = lut.text; } }
  const d = await db(); await new Promise((res, rej) => { const t = d.transaction(['files', 'projects', 'projectMeta', 'state'], 'readwrite'); parsed.blobs.forEach((blob, oldAssetId) => t.objectStore('files').put(blob, map.get(oldAssetId))); t.objectStore('projects').put(st, id); t.objectStore('projectMeta').put(makeProjectMeta(st), id); t.objectStore('state').put({ schemaVersion: 2, activeProjectId: id }, WORKSPACE_KEY); if (failNextTransactionForTest) { failNextTransactionForTest = false; t.abort(); } t.oncomplete = res; t.onerror = () => rej(t.error || new Error('読込み保存に失敗しました')); t.onabort = () => rej(t.error || new Error('読込み保存が中断されました')); });
  try { await hydrateProject(st); }
  catch (e) { await rollbackActivatedProject(id, old, [...map.values()]); if (!oldId) ready = false; throw e; }
  historyFor(id); await updateProjectSheet();
}

// ===== 起動 =====
function syncUIFromProject() {
  $('projectNameLabel').textContent = project.name || 'ひかりを編む';
  $('projectMenuBtn').title = project.name || '作品一覧を開く';
  $('aspectSel').value = project.aspect;
  applyAspectToCanvas();
  $('fitSel').value = project.fit;
  $('presetSel').value = String(project.impLen);
  syncImportBadge();
  trace('syncUI.autoAlign', () => ({ was: $('autoAlignChk').checked, to: project.autoAlign }));
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
  setS('uGlow', (ad.glow ?? 1) * 100);
  setS('uHandheld', (ad.handheld || 0) * 100);
  setS('uLeak', (ad.leak || 0) * 100);
  setS('uTrans', (ad.trans || 0) * 100);
  setS('uJudder', (ad.judder || 0) * 100);
  setS('uHal', (ad.halation ?? 0) * 100);
  setS('uDamage', (ad.damage ?? 0) * 100);
  $('uLetterbox').checked = ad.letterbox;
  $('filmProfileSel').value = project.filmProfile;
  updateFilmDetailUI();
  document.querySelectorAll('#lutChips .chip').forEach(c => c.classList.toggle('on', c.dataset.lut === project.lut));
  if (project.lutFileName) document.querySelector('#lutChips .chip[data-lut=file]').textContent = project.lutFileName.replace(/\.cube$/i, '');
  document.querySelectorAll('#fxChips .chip').forEach(c => c.classList.toggle('on', parseInt(c.dataset.fx) === ad.effect));
  document.querySelectorAll('#lookPresets [data-preset]').forEach(c => c.classList.toggle('on', c.dataset.preset === project.preset));
  syncPresetToggle();
  syncMotionUI();
  syncChipBadges();
  if (project.music) $('musicName').textContent = project.music.name;
  $('musicLoopChk').checked = !project.music || project.music.loop !== false;
  syncMusicHint();
  project.clips.forEach(c => { if (c.kind === 'video') c.video.muted = project.muteAll || c.muted; });
  applyLutSelection(preview);
  renderTimeline(); renderClipEdit();
  $('emptyHint').style.display = project.clips.length ? 'none' : 'flex';
}

function normalizeRestoredState(st, allowLegacy = false) {
  if (!st || typeof st !== 'object' || Array.isArray(st)) throw new Error('作品情報が不正です');
  // どの時代に保存されたか。**版が無いものは 1**（版を持たせる前に保存された作品）。
  const 保存された版 = Number.isInteger(st.formatVersion) ? st.formatVersion : 1;
  const sourceAdjust = st?.adjust && typeof st.adjust === 'object' ? st.adjust : {};
  const hasExplicitDamage = Object.prototype.hasOwnProperty.call(sourceAdjust, 'damage');
  const safe = { ...st, adjust: { ...DEFAULT_ADJUST, hsl: defaultHsl(), curve: defaultCurve(), ...sourceAdjust } };
  if (!ASPECTS[safe.aspect]) safe.aspect = '16:9';
  if (!['mine', 'airu', 'film8', 'hikari', 'none', 'file'].includes(safe.lut)) safe.lut = 'hikari';
  safe.fit = safe.fit === 'cover' ? 'cover' : 'contain';
  safe.impLen = [0, 2, 3, 5].includes(safe.impLen) ? safe.impLen : 3;
  safe.adjust.effect = [0, 1, 2].includes(safe.adjust.effect) ? safe.adjust.effect : 0;
  // ── 版1で保存された作品の引き上げ（版2以降には当てない）────────────────
  // 周辺減光は 2026-08-16 に意味が変わった（1.0倍が既定 → 1.0倍が下限・3.0倍が既定）。
  // 版1のまま保存された作品は弱いままになるので引き上げる。
  // **版2以降を除く理由**: 版2で「あえて 3.0倍を選んだ」人の設定まで書き換えてしまうため。
  // 版で分ける前は値だけで判断していたので、それが起きていた。
  if (保存された版 < 2 && (safe.adjust.vig === 1 || safe.adjust.vig === 3)) {
    safe.adjust.vig = 4;
    diag('古い作品を引き上げた', () => ({ 版: 保存された版, 項目: '周辺減光', 値: '3.0倍→4.0倍' }));
  }
  safe.formatVersion = PROJECT_FORMAT;
  safe.textureSeed = normalizeTextureSeed(st.textureSeed, st);
  safe.filmProfile = FILM_PROFILES[safe.filmProfile] ? safe.filmProfile : 'home8';
  // 旧stateは既存のadjustを先に埋め、その後にprofile、最後にdamageを足す。
  // 明示した0は壊れではなく「経年の跡なし」なので上書きしない。
  if (!hasExplicitDamage) safe.adjust.damage = safe.adjust.effect === 2 ? FILM_PROFILES.home8.damage : 0;
  else safe.adjust.damage = clamp(Number(safe.adjust.damage), 0, 1);
  safe.adjust.handheld = Number.isFinite(safe.adjust.handheld) ? clamp(safe.adjust.handheld, 0, 1) : 0;
  safe.adjust.leak = Number.isFinite(safe.adjust.leak) ? clamp(safe.adjust.leak, 0, 1) : 0;
  safe.adjust.trans = Number.isFinite(safe.adjust.trans) ? clamp(safe.adjust.trans, 0, 1) : 0;
  safe.adjust.judder = Number.isFinite(safe.adjust.judder) ? clamp(safe.adjust.judder, 0, 1) : 0;
  safe.texts = normalizeTexts(safe.texts, safe.clips);
  safe.adjust.hsl = normalizeHsl(safe.adjust.hsl);
  safe.adjust.curve = normalizeCurve(safe.adjust.curve);
  if (!Array.isArray(safe.clips) || safe.clips.length > 200) throw new Error('クリップ情報が不正です');
  safe.clips.forEach(c => {
    if (!c || !['video', 'photo'].includes(c.kind) || (!allowLegacy && typeof c.assetId !== 'string') || !Number.isFinite(c.start) || !Number.isFinite(c.end) || !Number.isFinite(c.dur) || c.start < 0 || c.end <= c.start || c.dur < c.end) throw new Error('クリップ情報が不正です');
    // 質感の強さは後から足したfield。持っていない古い作品は「全部乗せる」＝1として読む
    c.fxScale = Number.isFinite(c.fxScale) ? clamp(c.fxScale, 0, 1) : 1;
    c.highKey = Number.isFinite(c.highKey) ? clamp(c.highKey, 0, 1) : 0;
    c.hsl = normalizeHsl(c.hsl);
    c.curve = normalizeCurve(c.curve);
    // 収め方は後から足したfield。この2つ以外（未指定を含む）は「作品ぜんぶの設定に従う」
    if (c.fit !== 'cover' && c.fit !== 'contain') delete c.fit;
  });
  if (safe.music && ((!allowLegacy && typeof safe.music.assetId !== 'string') || !Number.isFinite(safe.music.volume) || safe.music.volume < 0 || safe.music.volume > 1)) throw new Error('音楽情報が不正です');
  return safe;
}

(async function init() {
  try { navigator.storage?.persist?.(); } catch (e) { }
  let workspace = null, st = null;
  try { workspace = await migrateV1IfNeeded(); }
  catch (e) {
    logErr('v1移行エラー: ' + e.message);
    migrationBlocked = true;
  }
  try { workspace ||= await idbGet('state', WORKSPACE_KEY); if (workspace?.activeProjectId) st = await idbGet('projects', workspace.activeProjectId); } catch (e) { }
  await Promise.all([
    loadBuiltinLut('./jibun-no-iro.cube', 'mineLutData', 'mine'),
    loadBuiltinLut('./airu.cube', 'airuLutData', 'airu'),
    loadBuiltinLut('./film8mm.cube', 'film8LutData', 'film8'),
  ]);
  if (migrationBlocked) {
    // 旧データは不変のまま。readyを立てず、新規作品の保存へ進ませない。
    setSaveStatus('error');
    $('projectActionStatus').textContent = '移行できないため保護停止しました。';
    return;
  }
  if (st) {
    try { await hydrateProject(normalizeRestoredState(st)); }
    catch (e) {
      logErr('復元エラー: ' + e.message);
      if (e?.code === 'INCOMPLETE_PROJECT') {
        incompleteProject = true; setSaveStatus('error');
        $('projectActionStatus').textContent = `不完全な作品のため保護停止しました: ${e.message}`;
        return;
      }
    }
  }
  if (project.lut === 'mine' && !project.mineLutData) project.lut = 'hikari';
  if (project.lut === 'airu' && !project.airuLutData) project.lut = 'hikari';
  if (project.lut === 'film8' && !project.film8LutData) project.lut = 'hikari';
  if (project.lut === 'file' && !project.lutFileData) project.lut = 'hikari';
  if (!st && project.mineLutData) project.lut = 'mine';
  ready = true;
  if (!st) {
    // 選択前はIDBへ作品を作らない。プリセット選択で初めて新規作品になる。
    project.id = null; project.name = '';
    syncUIFromProject(); creatingNewProject = true; $('presetContinue').style.display = 'none'; $('presetSheet').classList.add('on');
  } else { historyFor(project.id); updateHistoryUI(); }
  setSaveStatus('saved');
  await updateProjectSheet().catch(() => {});
})();

// 作品シートの配線。作品選択は現在の保存が成功した場合だけ反映する。
$('projectMenuBtn').onclick = async () => { $('projectSheet').classList.add('on'); await updateProjectSheet(); };
function closeRenameRow() { $('renameRow').hidden = true; $('renameInput').value = ''; }
function openRenameRow() {
  if (!project.id || operationBusy) return;
  const input = $('renameInput'); input.value = project.name; $('renameRow').hidden = false;
  requestAnimationFrame(() => { input.focus(); input.select(); });
}
async function saveRenameRow() {
  if (!project.id || operationBusy) return false;
  const input = $('renameInput'), name = input.value.trim();
  if (!name) { input.focus(); input.select(); return false; }
  const saved = await withProjectOperation('名前を保存中…', async () => {
    const oldId = project.id; await beginExplicitProjectSave(); const before = beginHistory(), oldHistory = structuredClone(historyFor());
    project.name = name; commitHistory(before);
    if (!(await saveState())) {
      clearTimeout(saveTimer); await hydrateProject(normalizeRestoredState(JSON.parse(before))); historyByProject.set(oldId, oldHistory);
      throw new Error('作品名を保存できませんでした');
    }
    await updateProjectSheet();
  });
  if (saved) closeRenameRow();
  else { input.value = project.name; $('renameRow').hidden = false; requestAnimationFrame(() => { input.focus(); input.select(); }); }
  return saved;
}
function closeProjectSheet() {
  closeRenameRow();
  $('projectSheet').classList.remove('on');
  if (backupUrl) { URL.revokeObjectURL(backupUrl); backupUrl = null; }
  $('backupLink').removeAttribute('href'); $('backupLink').hidden = true;
}
$('closeProjectSheet').onclick = closeProjectSheet;
$('projectSheet').addEventListener('click', e => { if (e.target === $('projectSheet')) closeProjectSheet(); });
$('newProjectBtn').onclick = () => { if (operationBusy) return; creatingNewProject = true; closeProjectSheet(); $('presetContinue').style.display = ''; $('presetSheet').classList.add('on'); };
$('renameProjectBtn').onclick = openRenameRow;
$('saveRenameBtn').onclick = saveRenameRow;
$('cancelRenameBtn').onclick = closeRenameRow;
$('renameInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); saveRenameRow(); } else if (e.key === 'Escape') { e.preventDefault(); closeRenameRow(); } };
$('duplicateProjectBtn').onclick = duplicateProject;
$('clearProjectBtn').onclick = async () => { if (!project.id || operationBusy || !confirm('この作品の内容を空にします。作品名は残ります。')) return; await withProjectOperation('作品を空にしています…', async () => { const oldId = project.id; await beginExplicitProjectSave(); const before = beginHistory(), oldHistory = structuredClone(historyFor()); stopPlayback(); revokeRuntimeAssets(); clearOutputVideo(); project.clips = []; project.music = null; project.assetBytes = 0; selId = null; musicAudioBuf = null; syncUIFromProject(); clearPreview(); commitHistory(before); if (!(await saveState())) { clearTimeout(saveTimer); await hydrateProject(normalizeRestoredState(JSON.parse(before))); historyByProject.set(oldId, oldHistory); throw new Error('空の作品を保存できませんでした'); } await garbageCollect(); await updateProjectSheet(); }); };
$('deleteProjectBtn').onclick = async () => {
  if (!project.id || operationBusy || !confirm(`「${project.name}」を削除します。素材は他の作品が使っている場合は残ります。`)) return;
  await withProjectOperation('作品を削除中…', async () => {
    const d = await db(), deleting = project.id, old = JSON.parse(snapshotProject()), oldMeta = await idbGet('projectMeta', project.id);
    const remain = (await readAll('projects')).filter(st => st.id !== deleting);
    const next = remain[0] || makeEmptyProject(newId(), '無題の作品');
    await new Promise((res, rej) => {
      const t = d.transaction(['projects', 'projectMeta', 'state'], 'readwrite');
      t.objectStore('projects').delete(deleting); t.objectStore('projectMeta').delete(deleting);
      if (!remain.length) { t.objectStore('projects').put(next, next.id); t.objectStore('projectMeta').put(makeProjectMeta(next), next.id); }
      t.objectStore('state').put({ schemaVersion: 2, activeProjectId: next.id }, WORKSPACE_KEY);
      t.oncomplete = res; t.onerror = () => rej(t.error || new Error('削除に失敗しました')); t.onabort = () => rej(t.error || new Error('削除が中断されました'));
    });
    try { stopPlayback(); await hydrateProject(normalizeRestoredState(next)); }
    catch (e) {
      await new Promise((res, rej) => {
        const t = d.transaction(['projects', 'projectMeta', 'state'], 'readwrite');
        t.objectStore('projects').put(old, deleting); t.objectStore('projectMeta').put(oldMeta || makeProjectMeta(old), deleting);
        if (!remain.length) { t.objectStore('projects').delete(next.id); t.objectStore('projectMeta').delete(next.id); }
        t.objectStore('state').put({ schemaVersion: 2, activeProjectId: deleting }, WORKSPACE_KEY);
        t.oncomplete = res; t.onerror = () => rej(t.error || new Error('削除の取消に失敗しました')); t.onabort = () => rej(t.error || new Error('削除の取消が中断されました'));
      });
      await hydrateProject(normalizeRestoredState(old)); throw e;
    }
    historyByProject.delete(deleting); historyByProject.set(next.id, { undo: [], redo: [], current: snapshotProject() });
    await garbageCollect(); await updateProjectSheet(); setProjectStatus('作品を削除しました');
  });
};
$('exportProjectBtn').onclick = async () => { if (operationBusy) return; await withProjectOperation('バックアップを作成中…', async () => { const estimate = recalculateAssetBytes(); if (estimate >= 512 * 1024 * 1024 && !confirm(`約${prettyBytes(estimate)}の非圧縮バックアップを作ります。元素材と同程度の大きさになります。続けますか？`)) { setProjectStatus('バックアップを取り消しました'); return; } const blob = await createHikariPackage(); if (backupUrl) URL.revokeObjectURL(backupUrl); backupUrl = URL.createObjectURL(blob); const link = $('backupLink'); link.href = backupUrl; link.download = `${(project.name || 'ひかり').replace(/[\\/:*?"<>|]/g, '_')}.hikari`; link.hidden = false; link.click(); setProjectStatus(`バックアップを作成しました（${prettyBytes(blob.size)}）`); }); };
$('importProjectBtn').onclick = () => { if (!operationBusy) $('projectFileInput').click(); };
$('projectFileInput').onchange = async e => { const f = e.target.files[0]; if (!f) return; await withProjectOperation('読込みを検証中…', async () => { await importHikariPackage(f); setProjectStatus('新しい作品として読み込みました'); }); e.target.value = ''; };

$('undoBtn').onclick = () => restoreSnapshot(null, 'undo');
$('redoBtn').onclick = () => restoreSnapshot(null, 'redo');
$('resetProject').onclick = () => { $('projectSheet').classList.add('on'); updateProjectSheet(); };
window.addEventListener('keydown', e => { if (e.target.matches('input,textarea,[contenteditable=true]')) return; const mod = e.metaKey || e.ctrlKey; if (!mod) return; if (e.key.toLowerCase() === 'z') { e.preventDefault(); restoreSnapshot(null, e.shiftKey ? 'redo' : 'undo'); } else if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); restoreSnapshot(null, 'redo'); } });

// 明示的な一手境界。rangeの連続inputやトリム中のmoveでは履歴を増やさない。
const historyGesture = new WeakMap();
document.addEventListener('focusin', e => { if (e.target.matches('input[type=range],select,input[type=checkbox]')) historyGesture.set(e.target, beginHistory()); }, true);
// スイッチ（.sw）の履歴は専用フック（「スイッチはラベルを押して切り替わるので…」ブロック）が担う。
// ここで重ねて積むと1タップ2手になる（実際になった）
document.addEventListener('pointerdown', e => { if (e.target.matches('input[type=range]')) historyGesture.set(e.target, beginHistory()); }, true);
document.addEventListener('pointerup', e => { const before = historyGesture.get(e.target); if (before) { historyGesture.delete(e.target); commitHistory(before); } }, true);
document.addEventListener('pointercancel', e => { const before = historyGesture.get(e.target); if (before) { historyGesture.delete(e.target); commitHistory(before); } }, true);
document.addEventListener('change', e => { if (e.target.matches('select,input[type=checkbox],input[type=range]')) { const before = historyGesture.get(e.target); if (before) { historyGesture.delete(e.target); setTimeout(() => commitHistory(before), 0); } } }, true);
document.addEventListener('blur', e => { const before = historyGesture.get(e.target); if (before) { historyGesture.delete(e.target); commitHistory(before); } }, true);
document.addEventListener('click', e => { if (!e.target.closest('#delClip,#moveL,#moveR,#muteClipBtn,#applyLenBtn,#lutChips .chip,#fxChips .chip')) return; const before = snapshotProject(); setTimeout(() => commitHistory(before), 0); }, true);

// ===== 実機診断: 版の文字をタップすると診断ログが開く（?dev=1 なしで使える）=====
// 実機で「押せない・遅い」が起きたとき、スクショ1枚で原因を判別できるようにするための入口。
// dev ▾ の中だけに置いていたせいで、ふだんの画面からは辿り着けなかった（2026-08-15）。
{
  const fmt = () => traceBuf.map(e => {
    const { ms, tag, ...rest } = e;
    return `${String(ms).padStart(6)} ${tag} ${JSON.stringify(rest, null, 0)}`;
  }).join('\n') || '（ログはまだありません。何度かボタンを押してから開いてください）';
  const open = () => { $('traceText').value = fmt(); $('traceSheet').classList.add('on'); };
  $('appVer').addEventListener('click', open);
  $('traceClose').onclick = () => $('traceSheet').classList.remove('on');
  $('traceClear').onclick = () => { traceBuf.length = 0; $('traceText').value = fmt(); };
  $('traceCopy').onclick = async () => {
    const el = $('traceText');
    try { await navigator.clipboard.writeText(el.value); $('traceCopy').textContent = 'コピー済'; }
    catch (e) { el.focus(); el.select(); $('traceCopy').textContent = '手で選んで'; }
    setTimeout(() => { $('traceCopy').textContent = 'コピー'; }, 1600);
  };
}

// ── オフラインの受け皿を登録する ─────────────────────────────────
// 一度ひらけば、電波が無くても同じように使えるようにする（書体・LUT・書き出しの部品まで手元に置く）。
// file:// で開いたときは Service Worker が使えないので、黙って何もしない。
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    // updateViaCache:'none' が要る。既定だとブラウザは sw.js 自体を自分のキャッシュから読み、
    // 直したはずの受け皿がいつまでも古いまま動く（2026-08-17に実際に踏んだ）。
    // ?v= も付けて、版を上げたら必ず新しい受け皿が入るようにする。
    navigator.serviceWorker.register('./sw.js?v=' + APP_VERSION, { updateViaCache: 'none' })
      .then(reg => {
        diag('オフライン準備', () => ({ 状態: reg.active ? '有効' : '登録した' }));
        // 起動が落ち着いてから、まだ手元に無いものを1本ずつ静かに取っておく。
        // 順番は「無いと困る順」。書体6本で8MB強あるので、まとめてではなく小分けにする。
        // 受け皿は sw.js の キャッシュ優先 の経路（ここで fetch すればそのまま溜まる）。
        const 手元に置くもの = [
          // 本体2つ。初回に開いた回は受け皿より先に読まれてしまうので、ここで取り直す
          './', './app.js',
          './fonts/sans.woff2', './fonts/serif.woff2',
          './vendor/mp4box.all.min.js', './vendor/mp4-muxer.mjs',
          './jibun-no-iro.cube', './airu.cube', './film8mm.cube',
          './fonts/pen.woff2', './fonts/pencil.woff2', './fonts/round.woff2', './fonts/marker.woff2',
        ];
        const 温める = async () => {
          const sw = (await navigator.serviceWorker.ready).active;
          if (!sw) return;
          const ch = new MessageChannel();
          ch.port1.onmessage = ev => diag('手元に置いた', () => ({
            本数: ev.data.ok + '/' + ev.data.全体,
            ...(ev.data.落ちた.length ? { 落ちた: ev.data.落ちた.join(' ') } : {}),
          }));
          sw.postMessage({ 手元に置く: 手元に置くもの }, [ch.port2]);
        };
        const idle = window.requestIdleCallback || (f => setTimeout(f, 4000));
        idle(温める, { timeout: 10000 });
      })
      .catch(e => diag('オフライン準備できず', () => ({ 理由: String(e && e.message || e) })));
  });
}
