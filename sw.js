// Service worker KadrStudio.
// Aplikacja zapisuje swoje pliki w telefonie, więc otwiera się i działa nawet przy wyłączonym laptopie
// (montaż i eksport dzieją się w telefonie). Gdy laptop jest dostępny – zawsze bierze najnowszą wersję.
const CACHE = 'kadrstudio-v8';
const CORE = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'vendor/lucide.min.js', 'vendor/mp4-muxer.min.js', 'vendor/mp4box.all.min.js',
  'js/app.js', 'js/util.js', 'js/db.js', 'js/store.js', 'js/model.js', 'js/catalog.js', 'js/media.js',
  'js/renderer.js', 'js/player.js', 'js/stage.js', 'js/timeline.js', 'js/inspector.js', 'js/library.js',
  'js/exporter.js', 'js/automontage.js', 'js/retakes.js', 'js/captions.js', 'js/ui.js', 'js/audio.js', 'js/decoder.js',
  'js/asr.js', 'js/speechfx.js', 'vendor/transformers/transformers.min.js', 'vendor/transformers/ort-wasm-simd-threaded.jsep.mjs', 'vendor/transformers/probe-worker.js',
];
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Montserrat:ital,wght@0,500;0,700;0,900;1,900&family=Poppins:wght@500;700;900&family=Bebas+Neue&family=Anton&family=Bangers&family=Righteous&family=Pacifico&family=Lobster&family=Permanent+Marker&family=Caveat:wght@700&family=Oswald:wght@500;700&family=Playfair+Display:ital,wght@0,700;1,700&family=Press+Start+2P&family=Rubik+Mono+One&display=swap';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled([
      ...CORE.map((u) => c.add(new Request(u, { cache: 'reload' }))),
      c.add(new Request(FONTS_CSS, { mode: 'no-cors' })),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Nagłówki „izolacji” strony – dzięki nim rozpoznawanie mowy może liczyć na wielu rdzeniach telefonu
// (GitHub Pages nie pozwala ustawić ich na serwerze, więc dokłada je service worker).
function isolate(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function fromNetwork(req, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    fetch(req).then((r) => { clearTimeout(t); res(r); }, (err) => { clearTimeout(t); rej(err); });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  if (same && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/samples/'))) return;
  if (!same && !url.hostname.endsWith('googleapis.com') && !url.hostname.endsWith('gstatic.com')) return; // np. model mowy z Hugging Face – trzyma go sama biblioteka
  // czcionki Google: najpierw pamięć (nie zmieniają się)
  if (!same) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    })));
    return;
  }
  // strona i jej wątki (workery rozpoznawania mowy) muszą mieć te same nagłówki izolacji
  const nav = req.mode === 'navigate';
  const iso = nav || req.destination === 'worker' || req.destination === 'sharedworker';
  e.respondWith((async () => {
    let out;
    try {
      const res = await fromNetwork(req, 4000);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        out = res;
      } else {
        out = (await caches.match(req, { ignoreSearch: true })) || res;
      }
    } catch {
      out = await caches.match(req, { ignoreSearch: true });
      if (!out && nav) out = (await caches.match('./')) || (await caches.match('index.html'));
      if (!out) return Response.error();
    }
    return iso ? isolate(out) : out;
  })());
});
