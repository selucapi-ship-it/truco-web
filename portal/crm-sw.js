// Service worker del CRM instalable. Estrategia "red primero": cada vez que se abre
// la app con conexión se carga la versión más reciente (así se actualiza sola, sin
// tener que subir números de versión); la copia guardada solo sirve si no hay red.
// Nunca guarda datos en vivo (Supabase / funciones): solo el propio origen.
const CACHE = 'crm-shell';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/.netlify/functions/')) return;
  event.respondWith(
    fetch(req).then((resp) => {
      if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return resp;
    }).catch(() => caches.match(req))
  );
});
