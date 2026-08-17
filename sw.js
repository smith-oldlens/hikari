// ひかりを編む — オフライン用の受け皿（Service Worker）
//
// ねらいは「一度ひらけば、電波が無くても同じように使える」こと。旅先や電車の中で
// 素材を並べたいときに、書体が出ない・書き出せない、が起きないようにする。
//
// 二段構えにしてある：
//   ・変わらない大物（書体・LUT・vendor）＝ キャッシュ優先。名前が変わらない限り中身も変わらない
//   ・本体（index.html / app.js）＝ ネット優先、だめならキャッシュ
// 本体をネット優先にしているのは、**開発中に古いJSを掴ませないため**。
// 版ずれは実機検証の生命線なので、ここだけは新しさを取る（2026-08-15の教訓）。

const CACHE = 'hikari-v1';

const 不変か = url =>
  /\/fonts\/|\/vendor\/|\.cube$/.test(url.pathname);

// ここでは何も溜めない。
// 【2026-08-17】install の中で書体やLUTを先に取る書き方にしたら、キャッシュが空のまま
// active になった（個別に握りつぶしていたので原因も見えない）。**溜めるのはページ側の
// 素直な fetch に一本化した**。下の キャッシュ優先 の経路が、そのまま受け皿になる。
self.addEventListener('install', e => { self.skipWaiting(); });

// ページから「これを手元に置いて」と頼まれたら、自分で取って溜める。
// ページ側の fetch だけに頼ると、**初回に開いた回は溜まらない**（その回のページはまだ
// この受け皿に制御されていないため）。開いてすぐ電波の無い所へ出ても困らないように、
// 制御の有無に関係なく効くこの道を用意した。
self.addEventListener('message', e => {
  const urls = e.data && e.data.手元に置く;
  if (!Array.isArray(urls)) return;
  const 返す = msg => { try { e.ports[0] && e.ports[0].postMessage(msg); } catch (_) {} };
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    let ok = 0; const 落ちた = [];
    for (const u of urls) {
      try {
        if (await c.match(u)) { ok++; continue; }
        const res = await fetch(u, { cache: 'reload' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await c.put(u, res.clone());
        ok++;
      } catch (err) { 落ちた.push(u.split('/').pop() + ':' + (err && err.message || err)); }
    }
    返す({ ok, 全体: urls.length, 落ちた });
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 外のものには触らない

  if (不変か(url)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // 本体はネット優先。落ちていたら（＝電波が無ければ）取っておいた方を返す。
  // 保存の名札からは ?v=版 や ?dev=1 を落とす。付けたままだと版を上げるたびに
  // 別物として溜まり、しかも「新しいHTML＋その版のJSは未保存」でオフラインに出られてしまう。
  const key = new Request(url.origin + url.pathname);
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(key, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(key) || await caches.match(self.registration.scope);
      if (hit) return hit;
      throw err;
    }
  })());
});
