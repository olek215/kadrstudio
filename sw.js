// Service worker KadrStudio.
// Aplikacja zapisuje swoje pliki w telefonie, więc otwiera się i działa nawet przy wyłączonym laptopie
// (montaż i eksport dzieją się w telefonie). Gdy laptop jest dostępny – zawsze bierze najnowszą wersję.
const CACHE = 'kadrstudio-v5';
const CORE = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'vendor/lucide.min.js', 'vendor/mp4-muxer.min.js', 'vendor/mp4box.all.min.js',
  'js/app.js', 'js/util.js', 'js/db.js', 'js/store.js', 'js/model.js', 'js/catalog.js', 'js/media.js',
  'js/renderer.js', 'js/player.js', 'js/stage.js', 'js/timeline.js', 'js/inspector.js', 'js/library.js',
  'js/exporter.js', 'js/automontage.js', 'js/retakes.js', 'js/captions.js', 'js/ui.js', 'js/audio.js', 'js/decoder.js',
  'js/asr.js', 'js/speechfx.js', 'vendor/transformers/transformers.min.js', 'vendor/transformers/ort-wasm-simd-threaded.jsep.mjs',
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
  e.respondWith((async () => {
    try {
      const res = await fromNetwork(req, 4000);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }
      const hit = await caches.match(req, { ignoreSearch: true });
      return hit || res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match('./')) || (await caches.match('index.html')) || Response.error();
      return Response.error();
    }
  })());
});
